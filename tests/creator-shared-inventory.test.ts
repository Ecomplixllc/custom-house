import test from "node:test";
import assert from "node:assert/strict";
import {
  convertCreatorVariantToSharedInventory,
  dryRunCreatorSharedInventory,
  evaluateCreatorSharedInventoryRelationship,
} from "../app/services/creator-shared-inventory.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

const parentId = "gid://shopify/ProductVariant/6001";
const baseId = "gid://shopify/ProductVariant/2001";
const parentProductId = "gid://shopify/Product/5001";
const baseProductId = "gid://shopify/Product/1001";

const product = {
  id: "cmcreatorproduct00000001",
  status: "PUBLISHED",
  shopifyProductId: baseProductId,
  publishedShopifyProductId: parentProductId,
  baseVariantMappingJson: JSON.stringify({ [parentId]: baseId }),
};

function variant(input: {
  id: string;
  productId: string;
  price?: string;
  tracked?: boolean;
  inventoryPolicy?: string;
  components?: Array<{ id: string; quantity: number }>;
  requiresComponents?: boolean;
  productParents?: string[];
  selectedOptions?: Array<{ name: string; value: string }>;
}) {
  return {
    id: input.id,
    price: input.price || "599.00",
    inventoryPolicy: input.inventoryPolicy || "DENY",
    requiresComponents: input.requiresComponents || false,
    selectedOptions: input.selectedOptions || [
      { name: "Color", value: "Green" },
      { name: "Size", value: "M" },
    ],
    inventoryItem: { tracked: input.tracked ?? true },
    product: {
      id: input.productId,
      status: "ACTIVE",
      isGiftCard: false,
      combinedListingRole: null,
      requiresSellingPlan: false,
    },
    productParents: {
      nodes: (input.productParents || []).map((id) => ({ id })),
    },
    productVariantComponents: {
      nodes: (input.components || []).map((component, index) => ({
        id: `gid://shopify/ProductVariantComponent/${index + 1}`,
        quantity: component.quantity,
        productVariant: { id: component.id },
      })),
    },
  };
}

function evaluate(overrides: {
  product?: typeof product;
  parent?: ReturnType<typeof variant> | null;
  base?: ReturnType<typeof variant> | null;
  eligibleForBundles?: boolean;
} = {}) {
  return evaluateCreatorSharedInventoryRelationship({
    product: overrides.product || product,
    creatorVariantId: parentId,
    baseVariantId: baseId,
    eligibleForBundles: overrides.eligibleForBundles ?? true,
    parent: overrides.parent === undefined
      ? variant({ id: parentId, productId: parentProductId })
      : overrides.parent,
    base: overrides.base === undefined
      ? variant({ id: baseId, productId: baseProductId, price: "299.00" })
      : overrides.base,
  });
}

test("eligible Creator relationship validates as READY without changing identity or price", () => {
  const inspected = evaluate();
  assert.equal(inspected.status, "READY");
  assert.equal(inspected.creatorProductId, product.id);
  assert.equal(inspected.creatorVariantId, parentId);
  assert.equal(inspected.baseVariantId, baseId);
  assert.equal(inspected.parentPrice, "599.00");
});

test("existing exact component relationship is idempotently ALREADY_CORRECT", () => {
  const inspected = evaluate({
    parent: variant({
      id: parentId,
      productId: parentProductId,
      requiresComponents: true,
      components: [{ id: baseId, quantity: 1 }],
    }),
  });
  assert.equal(inspected.status, "ALREADY_CORRECT");
});

test("unexpected existing component relationship fails closed", () => {
  const inspected = evaluate({
    parent: variant({
      id: parentId,
      productId: parentProductId,
      requiresComponents: true,
      components: [{ id: "gid://shopify/ProductVariant/9999", quantity: 1 }],
    }),
  });
  assert.equal(inspected.status, "BLOCKED_UNEXPECTED_RELATIONSHIP");
});

test("untracked and continue-selling Base variants are blocked", () => {
  assert.equal(
    evaluate({
      base: variant({ id: baseId, productId: baseProductId, tracked: false }),
    }).status,
    "BLOCKED_BASE_INVENTORY_UNTRACKED",
  );
  assert.equal(
    evaluate({
      base: variant({
        id: baseId,
        productId: baseProductId,
        inventoryPolicy: "CONTINUE",
      }),
    }).status,
    "BLOCKED_BASE_INVENTORY_POLICY",
  );
});

test("mapping and option mismatches are blocked", () => {
  assert.equal(
    evaluate({
      product: {
        ...product,
        baseVariantMappingJson: JSON.stringify({
          [parentId]: "gid://shopify/ProductVariant/9999",
        }),
      },
    }).status,
    "BLOCKED_MAPPING_MISMATCH",
  );
  assert.equal(
    evaluate({
      base: variant({
        id: baseId,
        productId: baseProductId,
        selectedOptions: [
          { name: "Color", value: "Green" },
          { name: "Size", value: "L" },
        ],
      }),
    }).status,
    "BLOCKED_OPTIONS_MISMATCH",
  );
});

test("conversion fixes current parent price and retry does not mutate again", async () => {
  let converted = false;
  let mutationCalls = 0;
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      if (query.includes("CreatorSharedInventoryEligibility")) {
        return { shop: { features: { bundles: { eligibleForBundles: true } } } } as T;
      }
      if (query.includes("CreatorSharedInventoryVariants")) {
        return {
          nodes: [
            variant({
              id: parentId,
              productId: parentProductId,
              price: "599.00",
              requiresComponents: converted,
              components: converted ? [{ id: baseId, quantity: 1 }] : [],
            }),
            variant({ id: baseId, productId: baseProductId, price: "299.00" }),
          ],
        } as T;
      }
      if (query.includes("ConvertCreatorVariantToSharedInventory")) {
        mutationCalls += 1;
        const input = variables?.input as Array<Record<string, unknown>>;
        assert.equal(input[0]?.parentProductVariantId, parentId);
        assert.deepEqual(input[0]?.priceInput, {
          calculation: "FIXED",
          price: "599.00",
        });
        converted = true;
        return {
          productVariantRelationshipBulkUpdate: {
            parentProductVariants: [{ id: parentId }],
            userErrors: [],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };
  const database = {
    creatorProduct: {
      async findFirst() { return product; },
      async findMany() { return [product]; },
    },
  };

  const first = await convertCreatorVariantToSharedInventory({
    shop: "shop.test",
    creatorProductId: product.id,
    creatorVariantId: parentId,
    client,
    database,
  });
  const retry = await convertCreatorVariantToSharedInventory({
    shop: "shop.test",
    creatorProductId: product.id,
    creatorVariantId: parentId,
    client,
    database,
  });
  assert.equal(first.status, "CONVERTED");
  assert.equal(first.parentPrice, "599.00");
  assert.equal(retry.status, "ALREADY_CORRECT");
  assert.equal(retry.parentPrice, "599.00");
  assert.equal(mutationCalls, 1);
});

test("dry run includes eligible mappings and skips legacy rows without mutation", async () => {
  let mutationCalls = 0;
  const legacy = {
    ...product,
    id: "cmlegacycreatorproduct001",
    publishedShopifyProductId: null,
    baseVariantMappingJson: "{}",
  };
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("CreatorSharedInventoryEligibility")) {
        return { shop: { features: { bundles: { eligibleForBundles: true } } } } as T;
      }
      if (query.includes("CreatorSharedInventoryVariants")) {
        return {
          nodes: [
            variant({ id: parentId, productId: parentProductId }),
            variant({ id: baseId, productId: baseProductId, price: "299.00" }),
          ],
        } as T;
      }
      mutationCalls += 1;
      throw new Error("Dry run attempted a mutation");
    },
  };
  const database = {
    creatorProduct: {
      async findMany() { return [product, legacy]; },
      async findFirst() { return null; },
    },
  };

  const results = await dryRunCreatorSharedInventory(
    "shop.test",
    client,
    database,
  );
  assert.deepEqual(results.map((item) => item.status), [
    "READY",
    "LEGACY_NO_PUBLISHED_PARENT",
  ]);
  assert.equal(mutationCalls, 0);
});

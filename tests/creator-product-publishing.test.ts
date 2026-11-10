import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  publishCreatorProductToShopify,
  synchronizeBakedCreatorProductPricing,
  type CreatorProductForPublish,
} from "../app/services/creator-product-publishing.server.ts";
import { ensureCreatorProductSharedInventoryRelationships } from "../app/services/creator-shared-inventory.server.ts";
import { parseSurchargeInput } from "../app/services/production-method-pricing.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

const baseProductId = "gid://shopify/Product/10";
const publishedProductId = "gid://shopify/Product/50";

const product: CreatorProductForPublish = {
  id: "creator-product-new-1",
  shop: "customhouse.test",
  creatorId: "creator-1",
  shopifyProductId: baseProductId,
  baseProductTitle: "T-shirt",
  pitchprintProjectId: "pp-project",
  pitchprintDesignId: "pp-design",
  title: "Creator T-shirt",
  description: null,
  previewUrl: "https://cdn.test/front.png",
  previewUrls: "[]",
  designVariantSelectionsJson: "{}",
  status: "PENDING",
  publishedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  creator: { id: "creator-1", displayName: "Creator", status: "APPROVED" },
};

const setup = {
  schema: "creator_design_setup_v1" as const,
  flowMode: "CREATOR_DESIGN" as const,
  productOrigin: "global" as const,
  designMode: "creator_design" as const,
  isCreatorProduct: true as const,
  fixedColor: "Green",
  selectedColors: ["Green"],
  productionMethod: "EMBROIDERY" as const,
  embroiderySubtype: "TEXT_ONLY" as const,
  placementCount: 1,
  placements: ["Front"],
  copyrightAccepted: true,
  nonReturnAcknowledged: true,
  savedAt: "2026-10-01T00:00:00.000Z",
};

const pricing = {
  embroiderySurcharge: parseSurchargeInput("99"),
  embroideryTextSurcharge: parseSurchargeInput("100"),
  embroideryImageSurcharge: parseSurchargeInput("250"),
  dtfSurcharge: parseSurchargeInput("75"),
  dtgSurcharge: parseSurchargeInput("50"),
  embroideryFeeVariantId: null,
  embroideryTextFeeVariantId: null,
  embroideryImageFeeVariantId: null,
  dtfFeeVariantId: null,
  dtgFeeVariantId: null,
};

function publishingClient() {
  const products = new Map([
    [
      baseProductId,
      [
        {
          id: "gid://shopify/ProductVariant/101",
          price: "200.00",
          selectedOptions: [
            { name: "Color", value: "Green" },
            { name: "Size", value: "S" },
          ],
        },
        {
          id: "gid://shopify/ProductVariant/102",
          price: "220.00",
          selectedOptions: [
            { name: "Color", value: "Green" },
            { name: "Size", value: "M" },
          ],
        },
      ],
    ],
    [
      publishedProductId,
      [
        {
          id: "gid://shopify/ProductVariant/501",
          price: "200.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Green" },
          ],
        },
        {
          id: "gid://shopify/ProductVariant/502",
          price: "220.00",
          selectedOptions: [
            { name: "Size", value: "M" },
            { name: "Color", value: "Green" },
          ],
        },
      ],
    ],
  ]);
  let pricingMode = "";
  let validation: unknown = null;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      calls.push({ query, variables: variables || {} });
      if (query.includes("NativeCreatorProductVariants")) {
        const id = String(variables?.id || "");
        return {
          product: {
            variants: {
              nodes: products.get(id) || [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T;
      }
      if (query.includes("BakeNativeCreatorVariantPrices")) {
        const updates = (variables?.variants || []) as Array<{ id: string; price: string }>;
        const published = products.get(publishedProductId) || [];
        for (const update of updates) {
          const variant = published.find((item) => item.id === update.id);
          if (variant) variant.price = update.price;
        }
        return { productVariantsBulkUpdate: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductPricingMetafields")) {
        const metafields = (variables?.metafields || []) as Array<{
          key: string;
          value: string;
        }>;
        pricingMode = metafields.find((item) => item.key === "creator_pricing_mode")?.value || "";
        validation = JSON.parse(
          metafields.find((item) => item.key === "creator_cart_validation")?.value || "null",
        );
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("VerifyNativeCreatorProductPricing")) {
        return {
          product: {
            pricingMode: { value: pricingMode },
            validation: { jsonValue: validation },
          },
        } as T;
      }
      throw new Error("Unexpected GraphQL operation in publishing test");
    },
  };
  return { client, products, calls };
}

test("publishing synchronizes per-size baked prices and no-fee metadata", async () => {
  const state = publishingClient();
  const result = await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {
      id: "collection-1",
      shop: "customhouse.test",
      creatorId: "creator-1",
      publicId: "public-1",
      publicHandle: "creator",
      displayName: "Creator Designs",
      bannerImageUrl: null,
      bannerTitle: null,
      bannerSubtitle: null,
      status: "ACTIVE",
      shopifyCollectionId: "gid://shopify/Collection/1",
      shopifyCollectionHandle: "creator-designs",
      shopifyCollectionUrl: "/collections/creator-designs",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    setup,
    pricing,
  });

  assert.deepEqual(
    state.products.get(publishedProductId)?.map((variant) => variant.price),
    ["300.00", "320.00"],
  );
  assert.equal(result.pricingPlan.pricingMode, "BAKED_IN_V1");
  assert.deepEqual(result.cartValidationContract, {
    version: 1,
    creatorProductId: product.id,
    feeRequired: false,
    feeVariantId: null,
    placementCount: 1,
  });
  const priceMutation = state.calls.find((call) =>
    call.query.includes("BakeNativeCreatorVariantPrices"),
  );
  assert.deepEqual(priceMutation?.variables.variants, [
    { id: "gid://shopify/ProductVariant/501", price: "300.00" },
    { id: "gid://shopify/ProductVariant/502", price: "320.00" },
  ]);
});

test("republishing an already baked product does not compound prices", async () => {
  const state = publishingClient();
  await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {} as never,
    setup,
    pricing,
  });
  await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {} as never,
    setup,
    pricing,
  });
  assert.deepEqual(
    state.products.get(publishedProductId)?.map((variant) => variant.price),
    ["300.00", "320.00"],
  );
});

test("publishing verifies shared inventory before database publication and storefront exposure", () => {
  const source = readFileSync(
    new URL("../app/services/creator-product-publishing.server.ts", import.meta.url),
    "utf8",
  );
  const publishFlow = source.slice(source.indexOf("export async function publishCreatorProductToShopify"));
  const activate = publishFlow.indexOf("await activateProduct");
  const inventory = publishFlow.indexOf("await ensureCreatorProductSharedInventoryRelationships");
  const databasePublish = publishFlow.indexOf("database.creatorProduct.update");
  const storefrontPublish = publishFlow.indexOf("await publishResource");
  assert.ok(activate >= 0);
  assert.ok(inventory > activate);
  assert.ok(databasePublish > inventory);
  assert.ok(storefrontPublish > databasePublish);
  assert.match(publishFlow, /CREATOR_SHARED_INVENTORY_SETUP_FAILED/);
});

test("new Creator publish automatically creates and verifies native shared inventory", async () => {
  const qaBaseProductId = "gid://shopify/Product/9000";
  const qaBaseVariantId = "gid://shopify/ProductVariant/9001";
  const qaCreatorProductId = "creator-product-future-smoke-1";
  const qaPublishedProductId = "gid://shopify/Product/9900";
  const qaCreatorVariantId = "gid://shopify/ProductVariant/9901";
  const collectionId = "gid://shopify/Collection/7000";
  const publicationId = "gid://shopify/Publication/1";
  const selectedOptions = [
    { name: "Color", value: "Green" },
    { name: "Size", value: "M" },
  ];
  const draft: CreatorProductForPublish = {
    ...product,
    id: qaCreatorProductId,
    shopifyProductId: qaBaseProductId,
    title: "QA Future Shared Inventory",
    designVariantSelectionsJson: JSON.stringify(setup),
  };
  let saved = { ...draft };
  const collection = {
    id: "collection-qa-1",
    shop: draft.shop,
    creatorId: draft.creatorId,
    publicId: "public-qa-1",
    publicHandle: "qa-creator",
    displayName: "QA Creator Designs",
    status: "ACTIVE",
    shopifyCollectionId: collectionId,
    shopifyCollectionHandle: "qa-creator",
    shopifyCollectionUrl: "/collections/qa-creator",
    shopifyPublishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const pricingRecord = {
    id: "pricing-qa-1",
    shopKey: draft.shop,
    shopifyProductId: qaBaseProductId,
    currency: "SEK",
    methodConfigurations: null,
    ...pricing,
  };
  const database = {
    creator: {
      async findFirst() {
        return {
          id: draft.creatorId,
          shop: draft.shop,
          displayName: "QA Creator",
          handle: "qa-creator",
          status: "APPROVED",
        };
      },
      async updateMany() { return { count: 1 }; },
    },
    creatorCollection: {
      async findUnique() { return collection; },
      async findFirst() { return null; },
      async create() { return collection; },
      async update(args: { data: Record<string, unknown> }) {
        Object.assign(collection, args.data);
        return collection;
      },
    },
    creatorProduct: {
      async findFirst() { return saved; },
      async update(args: { data: Partial<CreatorProductForPublish> }) {
        saved = { ...saved, ...args.data };
        return saved;
      },
    },
    shopConfig: {
      async findUnique() { return { onlineStorePublicationId: publicationId }; },
    },
    productionMethodSetting: {
      async findMany() { return []; },
    },
    publicProductProductionPricing: {
      async findUnique() { return pricingRecord; },
    },
    auditLog: {
      async create() { return {}; },
    },
  };

  let creatorPrice = "200.00";
  let pricingMode = "";
  let validation: unknown = null;
  let relationship: { id: string; quantity: number } | null = null;
  let relationshipMutations = 0;
  const calls: string[] = [];
  const variantNode = (id: string) => ({
    id,
    price: id === qaCreatorVariantId ? creatorPrice : "100.00",
    inventoryPolicy: "DENY",
    requiresComponents: id === qaCreatorVariantId && Boolean(relationship),
    selectedOptions,
    inventoryItem: { tracked: true },
    product: {
      id: id === qaCreatorVariantId ? qaPublishedProductId : qaBaseProductId,
      status: "ACTIVE",
      isGiftCard: false,
      combinedListingRole: null,
      requiresSellingPlan: false,
    },
    productParents: { nodes: [] },
    productVariantComponents: {
      nodes: id === qaCreatorVariantId && relationship
        ? [{
            id: "gid://shopify/ProductVariantComponent/1",
            quantity: relationship.quantity,
            productVariant: { id: relationship.id },
          }]
        : [],
    },
  });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      calls.push(query);
      if (query.includes("NativeCreatorCollection($id")) {
        return { collection: {
          id: collectionId,
          handle: "qa-creator",
          title: "QA Creator Designs",
          creatorId: { value: draft.creatorId },
          creatorCollectionId: { value: collection.id },
          collectionType: { value: "creator" },
        } } as T;
      }
      if (query.includes("NativeCreatorCollectionMetafields")) {
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorPublication")) {
        return { publishablePublish: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductByMetafield")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("NativeCreatorProductDuplicate")) {
        return { productDuplicate: {
          newProduct: { id: qaPublishedProductId, handle: "qa-future-shared-inventory" },
          userErrors: [],
        } } as T;
      }
      if (query.includes("NativeCreatorProductUpdate")) {
        return { productUpdate: {
          product: { id: qaPublishedProductId, handle: "qa-future-shared-inventory" },
          userErrors: [],
        } } as T;
      }
      if (query.includes("NativeCreatorProductCustomizationCleanup")) {
        return { metafieldsDelete: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductMetafields")) {
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductVariants")) {
        const id = String(variables?.id || "");
        return { product: { variants: {
          nodes: id === qaBaseProductId
            ? [{ id: qaBaseVariantId, price: "100.00", selectedOptions }]
            : [{ id: qaCreatorVariantId, price: creatorPrice, selectedOptions }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } as T;
      }
      if (query.includes("BakeNativeCreatorVariantPrices")) {
        const updates = variables?.variants as Array<{ id: string; price: string }>;
        creatorPrice = updates[0]!.price;
        return { productVariantsBulkUpdate: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductPricingMetafields")) {
        const metafields = variables?.metafields as Array<{ key: string; value: string }>;
        pricingMode = metafields.find((item) => item.key === "creator_pricing_mode")?.value || "";
        validation = JSON.parse(
          metafields.find((item) => item.key === "creator_cart_validation")?.value || "null",
        );
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("VerifyNativeCreatorProductPricing")) {
        return { product: {
          pricingMode: { value: pricingMode },
          validation: { jsonValue: validation },
        } } as T;
      }
      if (query.includes("NativeCreatorCollectionHasProduct")) {
        return { collection: { hasProduct: false } } as T;
      }
      if (query.includes("NativeCreatorCollectionMembership")) {
        return { collectionAddProductsV2: { job: { id: "job-1" }, userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductActivate")) {
        return { productUpdate: { userErrors: [] } } as T;
      }
      if (query.includes("CreatorSharedInventoryEligibility")) {
        return { shop: { features: { bundles: { eligibleForBundles: true } } } } as T;
      }
      if (query.includes("CreatorSharedInventoryVariants")) {
        const ids = variables?.ids as string[];
        return { nodes: ids.map(variantNode) } as T;
      }
      if (query.includes("ConvertCreatorVariantToSharedInventory")) {
        relationshipMutations += 1;
        const [input] = variables?.input as Array<{
          parentProductVariantId: string;
          productVariantRelationshipsToCreate: Array<{ id: string; quantity: number }>;
          priceInput: { calculation: string; price: string };
        }>;
        assert.equal(input.parentProductVariantId, qaCreatorVariantId);
        assert.deepEqual(input.productVariantRelationshipsToCreate, [
          { id: qaBaseVariantId, quantity: 1 },
        ]);
        assert.deepEqual(input.priceInput, {
          calculation: "FIXED",
          price: creatorPrice,
        });
        relationship = input.productVariantRelationshipsToCreate[0]!;
        return { productVariantRelationshipBulkUpdate: {
          parentProductVariants: [{ id: qaCreatorVariantId }],
          userErrors: [],
        } } as T;
      }
      if (query.includes("NativeCreatorProductPublish")) {
        return { publishablePublish: { userErrors: [] } } as T;
      }
      throw new Error(`Unexpected GraphQL operation: ${query.slice(0, 80)}`);
    },
  };

  const published = await publishCreatorProductToShopify(
    draft.shop,
    draft.id,
    client,
    database as never,
  );
  const priceAfterPublish = creatorPrice;
  const retry = await ensureCreatorProductSharedInventoryRelationships({
    product: {
      id: published.id,
      status: published.status,
      shopifyProductId: published.shopifyProductId,
      publishedShopifyProductId: published.publishedShopifyProductId || null,
      baseVariantMappingJson: published.baseVariantMappingJson || "{}",
    },
    client,
  });

  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.publishedShopifyProductId, qaPublishedProductId);
  assert.deepEqual(JSON.parse(published.baseVariantMappingJson || "{}"), {
    [qaCreatorVariantId]: qaBaseVariantId,
  });
  assert.deepEqual(relationship, { id: qaBaseVariantId, quantity: 1 });
  assert.equal(creatorPrice, priceAfterPublish);
  assert.equal(priceAfterPublish, "200.00");
  assert.equal(retry[0]?.status, "ALREADY_CORRECT");
  assert.equal(retry[0]?.parentPrice, "200.00");
  assert.equal(relationshipMutations, 1);
  assert.ok(calls.find((query) => query.includes("CreatorSharedInventoryVariants")));
  assert.ok(calls.find((query) => query.includes("NativeCreatorProductPublish")));
});

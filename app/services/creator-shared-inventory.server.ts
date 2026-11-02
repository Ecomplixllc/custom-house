import db from "../db.server.ts";
import { canonicalVariantIdentity } from "./creator-product-pricing.server.ts";
import { DomainError } from "./domain.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";

type SelectedOption = { name: string; value: string };

export type CreatorProductRelationshipRecord = {
  id: string;
  status: string;
  shopifyProductId: string;
  publishedShopifyProductId: string | null;
  baseVariantMappingJson: string;
};

type VariantNode = {
  id: string;
  price: string;
  inventoryPolicy: string;
  requiresComponents: boolean;
  selectedOptions: SelectedOption[];
  inventoryItem: { tracked: boolean };
  product: {
    id: string;
    status: string;
    isGiftCard: boolean;
    combinedListingRole: string | null;
    requiresSellingPlan: boolean;
  };
  productParents: { nodes: Array<{ id: string }> };
  productVariantComponents: {
    nodes: Array<{
      id: string;
      quantity: number;
      productVariant: { id: string };
    }>;
  };
};

type RelationshipDb = {
  creatorProduct: {
    findMany(args: unknown): Promise<CreatorProductRelationshipRecord[]>;
    findFirst(args: unknown): Promise<CreatorProductRelationshipRecord | null>;
  };
};

export type CreatorSharedInventoryStatus =
  | "READY"
  | "ALREADY_CORRECT"
  | "CONVERTED"
  | "LEGACY_NO_PUBLISHED_PARENT"
  | "BLOCKED_BUNDLES_INELIGIBLE"
  | "BLOCKED_CREATOR_PRODUCT_NOT_PUBLISHED"
  | "BLOCKED_CREATOR_PARENT_MISSING"
  | "BLOCKED_BASE_VARIANT_MISSING"
  | "BLOCKED_MAPPING_INVALID"
  | "BLOCKED_MAPPING_MISMATCH"
  | "BLOCKED_OPTIONS_MISMATCH"
  | "BLOCKED_BASE_INVENTORY_UNTRACKED"
  | "BLOCKED_BASE_INVENTORY_POLICY"
  | "BLOCKED_PARENT_INCOMPATIBLE"
  | "BLOCKED_BASE_IS_BUNDLE"
  | "BLOCKED_PARENT_IS_COMPONENT"
  | "BLOCKED_UNEXPECTED_RELATIONSHIP"
  | "BLOCKED_POST_MUTATION_ASSERTION";

export type CreatorSharedInventoryResult = {
  creatorProductId: string;
  creatorVariantId: string | null;
  baseVariantId: string | null;
  status: CreatorSharedInventoryStatus;
  reason: string;
  parentPrice: string | null;
};

function parsedMapping(value: string) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.some(([parent, base]) =>
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(parent) ||
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(String(base || "")))) {
      return null;
    }
    return Object.fromEntries(entries.map(([parent, base]) => [parent, String(base)]));
  } catch {
    return null;
  }
}

async function bundlesEligible(client: ShopifyGraphqlClient) {
  const result = await client.request<{
    shop: { features: { bundles: { eligibleForBundles: boolean } } };
  }>(
    `#graphql query CreatorSharedInventoryEligibility {
      shop { features { bundles { eligibleForBundles } } }
    }`,
  );
  return result.shop.features.bundles.eligibleForBundles;
}

async function relationshipVariants(
  client: ShopifyGraphqlClient,
  creatorVariantId: string,
  baseVariantId: string,
) {
  const result = await client.request<{ nodes: Array<VariantNode | null> }>(
    `#graphql query CreatorSharedInventoryVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          inventoryPolicy
          requiresComponents
          selectedOptions { name value }
          inventoryItem { tracked }
          product {
            id
            status
            isGiftCard
            combinedListingRole
            requiresSellingPlan
          }
          productParents(first: 2) { nodes { id } }
          productVariantComponents(first: 30) {
            nodes { id quantity productVariant { id } }
          }
        }
      }
    }`,
    { ids: [creatorVariantId, baseVariantId] },
  );
  const byId = new Map(
    result.nodes.filter((node): node is VariantNode => Boolean(node))
      .map((node) => [node.id, node]),
  );
  return {
    parent: byId.get(creatorVariantId) || null,
    base: byId.get(baseVariantId) || null,
  };
}

function result(
  product: CreatorProductRelationshipRecord,
  creatorVariantId: string | null,
  baseVariantId: string | null,
  status: CreatorSharedInventoryStatus,
  reason: string,
  parentPrice: string | null = null,
): CreatorSharedInventoryResult {
  return {
    creatorProductId: product.id,
    creatorVariantId,
    baseVariantId,
    status,
    reason,
    parentPrice,
  };
}

export function evaluateCreatorSharedInventoryRelationship(input: {
  product: CreatorProductRelationshipRecord;
  creatorVariantId: string;
  baseVariantId: string;
  eligibleForBundles: boolean;
  parent: VariantNode | null;
  base: VariantNode | null;
}): CreatorSharedInventoryResult {
  const { product, creatorVariantId, baseVariantId, parent, base } = input;
  if (!input.eligibleForBundles) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_BUNDLES_INELIGIBLE", "Shop is not eligible for Shopify bundles.");
  }
  if (product.status !== "PUBLISHED" || !product.publishedShopifyProductId) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_CREATOR_PRODUCT_NOT_PUBLISHED", "Creator product is not a native published product.");
  }
  const mapping = parsedMapping(product.baseVariantMappingJson);
  if (!mapping) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_MAPPING_INVALID", "Creator variant mapping is invalid.");
  }
  const matchingParents = Object.entries(mapping)
    .filter(([parentId, mappedBaseId]) =>
      parentId === creatorVariantId && mappedBaseId === baseVariantId);
  const reverseMatches = Object.values(mapping)
    .filter((mappedBaseId) => mappedBaseId === baseVariantId);
  if (matchingParents.length !== 1 || reverseMatches.length !== 1) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_MAPPING_MISMATCH", "Creator and Base variant mapping is not unique and canonical.");
  }
  if (!parent || parent.product.id !== product.publishedShopifyProductId) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_CREATOR_PARENT_MISSING", "Creator parent variant is missing or belongs to another product.");
  }
  if (!base || base.product.id !== product.shopifyProductId) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_BASE_VARIANT_MISSING", "Mapped Base variant is missing or belongs to another product.", parent.price);
  }
  try {
    if (canonicalVariantIdentity(parent.selectedOptions) !==
      canonicalVariantIdentity(base.selectedOptions)) {
      return result(product, creatorVariantId, baseVariantId,
        "BLOCKED_OPTIONS_MISMATCH", "Creator and Base selected options no longer match.", parent.price);
    }
  } catch {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_OPTIONS_MISMATCH", "Creator or Base selected options are invalid.", parent.price);
  }
  if (!base.inventoryItem.tracked) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_BASE_INVENTORY_UNTRACKED", "Mapped Base inventory is not tracked.", parent.price);
  }
  if (base.inventoryPolicy !== "DENY") {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_BASE_INVENTORY_POLICY", "Mapped Base variant does not deny overselling.", parent.price);
  }
  if (
    parent.product.isGiftCard ||
    parent.product.combinedListingRole ||
    parent.product.requiresSellingPlan ||
    parent.product.status !== "ACTIVE"
  ) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_PARENT_INCOMPATIBLE", "Creator parent has an incompatible Shopify product configuration.", parent.price);
  }
  if (base.requiresComponents || base.productVariantComponents.nodes.length) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_BASE_IS_BUNDLE", "Mapped Base variant is itself a bundle parent.", parent.price);
  }
  if (parent.productParents.nodes.length) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_PARENT_IS_COMPONENT", "Creator parent is already a component of another bundle.", parent.price);
  }
  const components = parent.productVariantComponents.nodes;
  if (components.length) {
    const expected = components.length === 1 &&
      components[0]!.productVariant.id === baseVariantId &&
      components[0]!.quantity === 1 &&
      parent.requiresComponents;
    return result(
      product,
      creatorVariantId,
      baseVariantId,
      expected ? "ALREADY_CORRECT" : "BLOCKED_UNEXPECTED_RELATIONSHIP",
      expected
        ? "Creator variant already has the expected Base component at quantity one."
        : "Creator variant already has an unexpected bundle relationship.",
      parent.price,
    );
  }
  if (parent.requiresComponents) {
    return result(product, creatorVariantId, baseVariantId,
      "BLOCKED_UNEXPECTED_RELATIONSHIP", "Creator variant requires components but none are visible.", parent.price);
  }
  return result(product, creatorVariantId, baseVariantId,
    "READY", "Relationship is eligible for conversion.", parent.price);
}

async function inspectRelationship(input: {
  product: CreatorProductRelationshipRecord;
  creatorVariantId: string;
  baseVariantId: string;
  eligibleForBundles: boolean;
  client: ShopifyGraphqlClient;
}) {
  const variants = await relationshipVariants(
    input.client,
    input.creatorVariantId,
    input.baseVariantId,
  );
  return evaluateCreatorSharedInventoryRelationship({
    ...input,
    ...variants,
  });
}

export async function dryRunCreatorSharedInventory(
  shop: string,
  client: ShopifyGraphqlClient,
  database: RelationshipDb = db as unknown as RelationshipDb,
) {
  const [eligibleForBundles, products] = await Promise.all([
    bundlesEligible(client),
    database.creatorProduct.findMany({
      where: { shop, status: "PUBLISHED" },
      select: {
        id: true,
        status: true,
        shopifyProductId: true,
        publishedShopifyProductId: true,
        baseVariantMappingJson: true,
      },
      orderBy: { id: "asc" },
    }),
  ]);
  const results: CreatorSharedInventoryResult[] = [];
  for (const product of products) {
    if (!product.publishedShopifyProductId) {
      results.push(result(product, null, null, "LEGACY_NO_PUBLISHED_PARENT",
        "Published CreatorProduct has no native published Shopify parent."));
      continue;
    }
    const mapping = parsedMapping(product.baseVariantMappingJson);
    if (!mapping || !Object.keys(mapping).length) {
      results.push(result(product, null, null, "BLOCKED_MAPPING_INVALID",
        "Published CreatorProduct has no valid variant mapping."));
      continue;
    }
    for (const [creatorVariantId, baseVariantId] of Object.entries(mapping)) {
      results.push(await inspectRelationship({
        product,
        creatorVariantId,
        baseVariantId,
        eligibleForBundles,
        client,
      }));
    }
  }
  return results;
}

export async function convertCreatorVariantToSharedInventory(input: {
  shop: string;
  creatorProductId: string;
  creatorVariantId: string;
  client: ShopifyGraphqlClient;
  database?: RelationshipDb;
}) {
  const database = input.database || db as unknown as RelationshipDb;
  const product = await database.creatorProduct.findFirst({
    where: { shop: input.shop, id: input.creatorProductId },
    select: {
      id: true,
      status: true,
      shopifyProductId: true,
      publishedShopifyProductId: true,
      baseVariantMappingJson: true,
    },
  });
  if (!product) {
    throw new DomainError("CREATOR_PRODUCT_NOT_FOUND", "Creator Product not found.", 404);
  }
  return convertKnownCreatorVariantToSharedInventory({
    product,
    creatorVariantId: input.creatorVariantId,
    client: input.client,
  });
}

async function convertKnownCreatorVariantToSharedInventory(input: {
  product: CreatorProductRelationshipRecord;
  creatorVariantId: string;
  client: ShopifyGraphqlClient;
  eligibleForBundles?: boolean;
}) {
  const product = input.product;
  const mapping = parsedMapping(product.baseVariantMappingJson);
  const baseVariantId = mapping?.[input.creatorVariantId] || null;
  if (!baseVariantId) {
    return result(product, input.creatorVariantId, null,
      "BLOCKED_MAPPING_MISMATCH", "Creator variant has no canonical Base mapping.");
  }
  const eligibleForBundles = input.eligibleForBundles ??
    await bundlesEligible(input.client);
  const before = await inspectRelationship({
    product,
    creatorVariantId: input.creatorVariantId,
    baseVariantId,
    eligibleForBundles,
    client: input.client,
  });
  if (before.status === "ALREADY_CORRECT") return before;
  if (before.status !== "READY" || !before.parentPrice) return before;

  const mutation = await input.client.request<{
    productVariantRelationshipBulkUpdate: {
      parentProductVariants: Array<{ id: string }>;
      userErrors: Array<{ code: string; message: string }>;
    };
  }>(
    `#graphql mutation ConvertCreatorVariantToSharedInventory(
      $input: [ProductVariantRelationshipUpdateInput!]!
    ) {
      productVariantRelationshipBulkUpdate(input: $input) {
        parentProductVariants { id }
        userErrors { code message }
      }
    }`,
    {
      input: [{
        parentProductVariantId: input.creatorVariantId,
        productVariantRelationshipsToCreate: [{ id: baseVariantId, quantity: 1 }],
        priceInput: { calculation: "FIXED", price: before.parentPrice },
      }],
    },
  );
  if (mutation.productVariantRelationshipBulkUpdate.userErrors.length) {
    throw new DomainError(
      "CREATOR_SHARED_INVENTORY_MUTATION_FAILED",
      "Shopify rejected the Creator shared-inventory relationship.",
      409,
    );
  }
  const after = await inspectRelationship({
    product,
    creatorVariantId: input.creatorVariantId,
    baseVariantId,
    eligibleForBundles,
    client: input.client,
  });
  if (after.status !== "ALREADY_CORRECT" || after.parentPrice !== before.parentPrice) {
    return result(product, input.creatorVariantId, baseVariantId,
      "BLOCKED_POST_MUTATION_ASSERTION", "Post-mutation bundle or price assertion failed.", after.parentPrice);
  }
  return result(product, input.creatorVariantId, baseVariantId,
    "CONVERTED", "Creator variant now uses the expected Base component at quantity one.", after.parentPrice);
}

export async function ensureCreatorProductSharedInventoryRelationships(input: {
  product: CreatorProductRelationshipRecord;
  client: ShopifyGraphqlClient;
}) {
  const mapping = parsedMapping(input.product.baseVariantMappingJson);
  if (!mapping || !Object.keys(mapping).length) {
    return [result(
      input.product,
      null,
      null,
      "BLOCKED_MAPPING_INVALID",
      "Published CreatorProduct has no valid variant mapping.",
    )];
  }
  const eligibleForBundles = await bundlesEligible(input.client);
  const results: CreatorSharedInventoryResult[] = [];
  for (const creatorVariantId of Object.keys(mapping)) {
    results.push(await convertKnownCreatorVariantToSharedInventory({
      product: input.product,
      creatorVariantId,
      eligibleForBundles,
      client: input.client,
    }));
  }
  return results;
}

import { Prisma } from "@prisma/client";
import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import {
  ensureShopifyCreatorCollection,
  type CreatorCollectionRecord,
} from "./creator-collections.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";
import {
  creatorProductSetupFromRecord,
  type CreatorProductSetup,
} from "./creator-products.server.ts";
import {
  cleanEmbroiderySubtype,
  cleanProductionMethod,
  getProductionPricing,
  resolveProductionPricing,
  type PublicProductProductionPricingRecord,
} from "./production-method-pricing.server.ts";
import {
  buildCreatorPublishedPricingPlan,
  CREATOR_PRICING_MODE_BAKED_IN_V1,
  type CreatorPublishedPricingPlan,
} from "./creator-product-pricing.server.ts";
import {
  ensureCreatorProductSharedInventoryRelationships,
  type CreatorProductRelationshipRecord,
} from "./creator-shared-inventory.server.ts";

type Errors = Array<{ message: string }>;

type ShopifyProductVariant = {
  id: string;
  price?: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

type PublishDb = {
  creator?: {
    findFirst(args: unknown): Promise<unknown>;
  };
  creatorCollection?: {
    findUnique(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  creatorProduct: {
    findFirst(args: unknown): Promise<CreatorProductForPublish | null>;
    update(args: unknown): Promise<CreatorProductForPublish>;
  };
  creatorSale?: {
    count(args?: unknown): Promise<number>;
  };
  shopConfig?: {
    findUnique(args: unknown): Promise<{
      onlineStorePublicationId: string | null;
    } | null>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
  publicProductProductionPricing?: {
    findUnique(args: unknown): Promise<PublicProductProductionPricingRecord | null>;
  };
};

export type CreatorProductForPublish = {
  id: string;
  shop: string;
  creatorId: string;
  shopifyProductId: string;
  baseProductTitle: string;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  title: string;
  description: string | null;
  previewUrl: string | null;
  previewUrls: string;
  designVariantSelectionsJson: string;
  status: string;
  publishedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  publishedShopifyProductId?: string | null;
  publishedShopifyProductHandle?: string | null;
  publishedShopifyProductUrl?: string | null;
  shopifyPublishedAt?: Date | null;
  baseVariantMappingJson?: string;
  creatorPricingMode?: string | null;
  creator?: {
    id: string;
    displayName: string;
    status: string;
  };
};

function productUrl(handle: string) {
  return `/products/${encodeURIComponent(handle)}`;
}

function previewUrl(product: CreatorProductForPublish) {
  if (product.previewUrl?.startsWith("https://")) return product.previewUrl;
  try {
    const urls = JSON.parse(product.previewUrls || "[]");
    return Array.isArray(urls)
      ? urls.find((item) => typeof item === "string" && item.startsWith("https://")) ||
          null
      : null;
  } catch {
    return null;
  }
}

export type CreatorCartValidationContract = {
  version: 1;
  creatorProductId: string;
  feeRequired: boolean;
  feeVariantId: string | null;
  placementCount: number;
};

type CreatorPricingForContract = Pick<
  PublicProductProductionPricingRecord,
  | "embroiderySurcharge"
  | "embroideryTextSurcharge"
  | "embroideryImageSurcharge"
  | "dtfSurcharge"
  | "dtgSurcharge"
  | "embroideryFeeVariantId"
  | "embroideryTextFeeVariantId"
  | "embroideryImageFeeVariantId"
  | "dtfFeeVariantId"
  | "dtgFeeVariantId"
>;

export function creatorCartValidationContract(
  creatorProductId: string,
  setup: CreatorProductSetup,
  _pricing: CreatorPricingForContract,
): CreatorCartValidationContract {
  void _pricing;
  if (!Number.isInteger(setup.placementCount) || setup.placementCount < 1) {
    throw new DomainError(
      "CREATOR_PLACEMENT_COUNT_INVALID",
      "Creator Product placement count must be configured before publishing.",
      409,
    );
  }
  const method = cleanProductionMethod(setup.productionMethod);
  if (method === "EMBROIDERY" && !setup.embroiderySubtype) {
    throw new DomainError(
      "EMBROIDERY_SUBTYPE_REQUIRED",
      "Embroidery artwork type must be resolved before publishing.",
      409,
    );
  }
  if (method === "EMBROIDERY") cleanEmbroiderySubtype(setup.embroiderySubtype);
  return {
    version: 1,
    creatorProductId,
    feeRequired: false,
    feeVariantId: null,
    placementCount: setup.placementCount,
  };
}

export function nativeCreatorProductMetafields(input: {
  product: Pick<
    CreatorProductForPublish,
    | "id"
    | "creatorId"
    | "shopifyProductId"
    | "pitchprintProjectId"
    | "pitchprintDesignId"
    | "creator"
  >;
  productId: string;
  collection: Pick<
    CreatorCollectionRecord,
    "id" | "publicHandle" | "displayName" | "shopifyCollectionId"
  >;
  setup: CreatorProductSetup;
  pricingMode: typeof CREATOR_PRICING_MODE_BAKED_IN_V1;
  cartValidationContract: CreatorCartValidationContract;
}) {
  const metafields = [
    ["creator_id", input.product.creatorId],
    ["creator_display_name", input.product.creator?.displayName || input.collection.displayName],
    ["creator_handle", input.collection.publicHandle],
    ["creator_product_id", input.product.id],
    ["creator_collection_id", input.collection.id],
    ["creator_shopify_collection_id", input.collection.shopifyCollectionId || ""],
    ["base_product_id", input.product.shopifyProductId],
    ["pitchprint_master_project_id", input.product.pitchprintProjectId || ""],
    ["pitchprint_design_id", input.product.pitchprintDesignId || ""],
    ["product_origin", "creator"],
    ["design_mode", "buy_only"],
    ["design_status", "published"],
    ["creator_publishing_enabled", "true"],
    ["product_type", "creator_fixed"],
    ["design_locked", "true"],
    ["fixed_color", input.setup.fixedColor],
    ["production_method", input.setup.productionMethod],
    ["designed_placement_count", String(input.setup.placementCount)],
    ["creator_pricing_mode", input.pricingMode],
    ...(input.setup.embroiderySubtype
      ? [["embroidery_artwork_type", input.setup.embroiderySubtype]]
      : []),
  ].map(([key, value]) => ({
    ownerId: input.productId,
    namespace: "customhouse",
    key,
    type: key === "design_locked" || key === "creator_publishing_enabled"
      ? "boolean"
      : "single_line_text_field",
    value,
  }));
  metafields.push({
    ownerId: input.productId,
    namespace: "customhouse",
    key: "creator_cart_validation",
    type: "json",
    value: safeJson(input.cartValidationContract),
  });
  metafields.push({
    ownerId: input.productId,
    namespace: "customhouse",
    key: "creator_design_metadata",
    type: "json",
    value: safeJson({
      version: 1,
      pitchprintProjectId: input.product.pitchprintProjectId || null,
      pitchprintDesignId: input.product.pitchprintDesignId || null,
      fixedColor: input.setup.fixedColor,
      productionMethod: input.setup.productionMethod,
      embroiderySubtype: input.setup.embroiderySubtype || null,
      placementCount: input.setup.placementCount,
      placements: input.setup.placements,
      previewSurfaces: input.setup.previewSurfaces || [],
    }),
  });
  return metafields;
}

async function shopPublication(shop: string, database: PublishDb) {
  const config = await database.shopConfig?.findUnique({
    where: { shop },
    select: { onlineStorePublicationId: true },
  });
  if (!config?.onlineStorePublicationId) {
    throw new DomainError(
      "ONLINE_STORE_PUBLICATION_REQUIRED",
      "Configure the Online Store publication before publishing creator products.",
      409,
    );
  }
  return config.onlineStorePublicationId;
}

async function publishResource(
  client: ShopifyGraphqlClient,
  id: string,
  publicationId: string,
) {
  const result = await client.request<{
    publishablePublish: { userErrors: Errors };
  }>(
    `#graphql mutation NativeCreatorProductPublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`,
    { id, input: [{ publicationId }] },
  );
  throwUserErrors(result.publishablePublish.userErrors, "Native creator product publication");
}

async function activeProduct(
  client: ShopifyGraphqlClient,
  productId: string | null | undefined,
) {
  if (!productId) return null;
  const result = await client.request<{
    product: { id: string; handle: string; status: string } | null;
  }>(
    `#graphql query NativeCreatorPublishedProduct($id: ID!) {
      product(id: $id) { id handle status }
    }`,
    { id: productId },
  );
  return result.product;
}

async function productByCreatorProductMetafield(
  client: ShopifyGraphqlClient,
  creatorProductId: string,
) {
  const result = await client.request<{
    products: {
      nodes: Array<{
        id: string;
        handle: string;
        status: string;
        creatorProductId: { value: string } | null;
      }>;
    };
  }>(
    `#graphql query NativeCreatorProductByMetafield($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          handle
          status
          creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") {
            value
          }
        }
      }
    }`,
    { query: `metafields.customhouse.creator_product_id:${creatorProductId}` },
  );
  return (
    result.products.nodes.find(
      (product) => product.creatorProductId?.value === creatorProductId,
    ) || null
  );
}

async function duplicateProduct(
  client: ShopifyGraphqlClient,
  baseProductId: string,
  title: string,
) {
  const result = await client.request<{
    productDuplicate: {
      newProduct: { id: string; handle: string } | null;
      userErrors: Errors;
    };
  }>(
    `#graphql mutation NativeCreatorProductDuplicate($productId: ID!, $title: String!) {
      productDuplicate(
        productId: $productId,
        newTitle: $title,
        newStatus: DRAFT,
        includeImages: false,
        synchronous: true
      ) {
        newProduct { id handle }
        userErrors { message }
      }
    }`,
    { productId: baseProductId, title },
  );
  throwUserErrors(result.productDuplicate.userErrors, "Native creator product duplication");
  if (!result.productDuplicate.newProduct) {
    throw new DomainError(
      "SHOPIFY_PRODUCT_DUPLICATE_FAILED",
      "Creator Shopify product could not be created.",
      502,
    );
  }
  return result.productDuplicate.newProduct;
}

function normalizedOptionValue(value: string) {
  return value.trim().toLocaleLowerCase("en");
}

function variantColor(variant: ShopifyProductVariant) {
  return variant.selectedOptions.find((option) =>
    /^(color|colour|farg|färg)$/i.test(option.name.trim()),
  )?.value;
}

export function nonFixedColorVariantIds(
  variants: ShopifyProductVariant[],
  fixedColor: string,
) {
  const normalizedFixedColor = normalizedOptionValue(fixedColor);
  const matching = variants.filter((variant) => {
    const color = variantColor(variant);
    return color && normalizedOptionValue(color) === normalizedFixedColor;
  });
  if (!matching.length) {
    throw new DomainError(
      "CREATOR_FIXED_COLOR_VARIANTS_MISSING",
      "The Creator Product does not contain variants for its fixed color.",
      409,
    );
  }
  return variants
    .filter((variant) => !matching.some((item) => item.id === variant.id))
    .map((variant) => variant.id);
}

async function creatorProductVariants(
  client: ShopifyGraphqlClient,
  productId: string,
) {
  const variants: ShopifyProductVariant[] = [];
  let cursor: string | null = null;
  do {
    const result: {
      product: {
        variants: {
          nodes: ShopifyProductVariant[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await client.request(
      `#graphql query NativeCreatorProductVariants($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 250, after: $after) {
            nodes { id price selectedOptions { name value } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productId, after: cursor },
    );
    if (!result.product) {
      throw new DomainError(
        "SHOPIFY_PRODUCT_NOT_FOUND",
        "Creator Shopify product could not be loaded.",
        404,
      );
    }
    variants.push(...result.product.variants.nodes);
    cursor = result.product.variants.pageInfo.hasNextPage
      ? result.product.variants.pageInfo.endCursor
      : null;
  } while (cursor);
  return variants;
}

async function restrictCreatorProductToFixedColor(
  client: ShopifyGraphqlClient,
  productId: string,
  fixedColor: string,
) {
  const variants = await creatorProductVariants(client, productId);
  const variantsIds = nonFixedColorVariantIds(variants, fixedColor);
  if (!variantsIds.length) return;
  const result = await client.request<{
    productVariantsBulkDelete: { userErrors: Errors };
  }>(
    `#graphql mutation TrimNativeCreatorProductVariants(
      $productId: ID!,
      $variantsIds: [ID!]!
    ) {
      productVariantsBulkDelete(
        productId: $productId,
        variantsIds: $variantsIds
      ) { userErrors { message } }
    }`,
    { productId, variantsIds },
  );
  throwUserErrors(
    result.productVariantsBulkDelete.userErrors,
    "Native Creator Product fixed color",
  );
}

async function configureProduct(
  client: ShopifyGraphqlClient,
  input: {
    product: CreatorProductForPublish;
    productId: string;
    collection: CreatorCollectionRecord;
    previewUrl: string;
    setup: CreatorProductSetup;
    pricingMode: typeof CREATOR_PRICING_MODE_BAKED_IN_V1;
    cartValidationContract: CreatorCartValidationContract;
  },
) {
  const tags = ["creator-fixed", "customhouse-creator-product"];
  const updated = await client.request<{
    productUpdate: {
      product: { id: string; handle: string } | null;
      userErrors: Errors;
    };
  }>(
    `#graphql mutation NativeCreatorProductUpdate($product: ProductUpdateInput!, $media: [CreateMediaInput!]!) {
      productUpdate(product: $product, media: $media) {
        product { id handle }
        userErrors { message }
      }
    }`,
    {
      product: {
        id: input.productId,
        title: input.product.title,
        descriptionHtml: input.product.description || "",
        status: "DRAFT",
        tags,
      },
      media: [
        {
          originalSource: input.previewUrl,
          mediaContentType: "IMAGE",
          alt: `Creator product ${input.product.id}`,
        },
      ],
    },
  );
  throwUserErrors(updated.productUpdate.userErrors, "Native creator product update");
  const handle = updated.productUpdate.product?.handle;
  if (!handle) {
    throw new DomainError(
      "SHOPIFY_PRODUCT_UPDATE_FAILED",
      "Creator Shopify product could not be configured.",
      502,
    );
  }

  const removed = await client.request<{
    metafieldsDelete: { userErrors: Errors };
  }>(
    `#graphql mutation NativeCreatorProductCustomizationCleanup($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        { ownerId: input.productId, namespace: "customhouse", key: "pitchprint_design_id" },
        { ownerId: input.productId, namespace: "customhouse", key: "pitchprint_enabled" },
        { ownerId: input.productId, namespace: "customhouse", key: "inkybay_enabled" },
        { ownerId: input.productId, namespace: "customhouse", key: "customizer_enabled" },
        { ownerId: input.productId, namespace: "customhouse", key: "customization_enabled" },
        { ownerId: input.productId, namespace: "customhouse", key: "design_id" },
        { ownerId: input.productId, namespace: "pitchprint", key: "design_id" },
        { ownerId: input.productId, namespace: "pitchprint", key: "enabled" },
        { ownerId: input.productId, namespace: "inkybay", key: "enabled" },
        { ownerId: input.productId, namespace: "inkybay", key: "design_id" },
      ],
    },
  );
  throwUserErrors(removed.metafieldsDelete.userErrors, "Native creator customization cleanup");

  const metafields = nativeCreatorProductMetafields(input).filter(
    (metafield) =>
      !["creator_pricing_mode", "creator_cart_validation"].includes(
        metafield.key,
      ),
  );
  const metafieldResult = await client.request<{
    metafieldsSet: { userErrors: Errors };
  }>(
    `#graphql mutation NativeCreatorProductMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    { metafields },
  );
  throwUserErrors(metafieldResult.metafieldsSet.userErrors, "Native creator product metafields");
  return handle;
}

async function creatorPublishedPricingPlan(
  client: ShopifyGraphqlClient,
  input: {
    product: CreatorProductForPublish;
    publishedProductId: string;
    setup: CreatorProductSetup;
    pricing: CreatorPricingForContract;
    resolvedSurcharge?: Prisma.Decimal;
  },
) {
  const [baseVariants, publishedVariants] = await Promise.all([
    creatorProductVariants(client, input.product.shopifyProductId),
    creatorProductVariants(client, input.publishedProductId),
  ]);
  return buildCreatorPublishedPricingPlan({
    creatorProductId: input.product.id,
    baseProductId: input.product.shopifyProductId,
    publishedProductId: input.publishedProductId,
    productionMethod: input.setup.productionMethod,
    embroiderySubtype: input.setup.embroiderySubtype,
    placementCount: input.setup.placementCount,
    pricing: input.pricing,
    resolvedSurcharge: input.resolvedSurcharge,
    baseVariants: baseVariants.map((variant) => ({
      id: variant.id,
      price: variant.price || "",
      selectedOptions: variant.selectedOptions,
    })),
    publishedVariants: publishedVariants.map((variant) => ({
      id: variant.id,
      price: variant.price || "",
      selectedOptions: variant.selectedOptions,
    })),
  });
}

async function applyCreatorPublishedPricingPlan(
  client: ShopifyGraphqlClient,
  plan: CreatorPublishedPricingPlan,
) {
  const result = await client.request<{
    productVariantsBulkUpdate: { userErrors: Errors };
  }>(
    `#graphql mutation BakeNativeCreatorVariantPrices(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { message }
      }
    }`,
    {
      productId: plan.publishedProductId,
      variants: plan.variants.map((variant) => ({
        id: variant.publishedVariantId,
        price: variant.finalPrice,
      })),
    },
  );
  throwUserErrors(
    result.productVariantsBulkUpdate.userErrors,
    "Native Creator Product pricing",
  );
  const verified = await creatorProductVariants(client, plan.publishedProductId);
  const byId = new Map(verified.map((variant) => [variant.id, variant.price]));
  const mismatch = plan.variants.find((variant) => {
    const actual = byId.get(variant.publishedVariantId);
    try {
      return !actual || !new Prisma.Decimal(actual).equals(variant.finalPrice);
    } catch {
      return true;
    }
  });
  if (mismatch) {
    throw new DomainError(
      "CREATOR_PRICE_VERIFICATION_FAILED",
      "Creator Product prices could not be verified after synchronization.",
      502,
    );
  }
}

async function setAndVerifyCreatorPricingMetafields(
  client: ShopifyGraphqlClient,
  input: Parameters<typeof nativeCreatorProductMetafields>[0],
) {
  const metafields = nativeCreatorProductMetafields(input).filter((metafield) =>
    ["creator_pricing_mode", "creator_cart_validation"].includes(metafield.key),
  );
  const result = await client.request<{
    metafieldsSet: { userErrors: Errors };
  }>(
    `#graphql mutation NativeCreatorProductPricingMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    { metafields },
  );
  throwUserErrors(
    result.metafieldsSet.userErrors,
    "Native Creator Product pricing metadata",
  );
  const verified = await client.request<{
    product: {
      pricingMode: { value: string } | null;
      validation: { jsonValue: unknown } | null;
    } | null;
  }>(
    `#graphql query VerifyNativeCreatorProductPricing($id: ID!) {
      product(id: $id) {
        pricingMode: metafield(namespace: "customhouse", key: "creator_pricing_mode") { value }
        validation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
      }
    }`,
    { id: input.productId },
  );
  if (
    verified.product?.pricingMode?.value !== CREATOR_PRICING_MODE_BAKED_IN_V1 ||
    safeJson(verified.product.validation?.jsonValue) !==
      safeJson(input.cartValidationContract)
  ) {
    throw new DomainError(
      "CREATOR_PRICING_METADATA_VERIFICATION_FAILED",
      "Creator Product pricing metadata could not be verified after synchronization.",
      502,
    );
  }
}

export async function synchronizeBakedCreatorProductPricing(
  client: ShopifyGraphqlClient,
  input: {
    product: CreatorProductForPublish;
    publishedProductId: string;
    collection: CreatorCollectionRecord;
    setup: CreatorProductSetup;
    pricing: CreatorPricingForContract;
    resolvedSurcharge?: Prisma.Decimal;
  },
) {
  const cartValidationContract = creatorCartValidationContract(
    input.product.id,
    input.setup,
    input.pricing,
  );
  const pricingPlan = await creatorPublishedPricingPlan(client, input);
  await applyCreatorPublishedPricingPlan(client, pricingPlan);
  await setAndVerifyCreatorPricingMetafields(client, {
    product: input.product,
    productId: input.publishedProductId,
    collection: input.collection,
    setup: input.setup,
    pricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
    cartValidationContract,
  });
  return { pricingPlan, cartValidationContract };
}

async function addToCollection(
  client: ShopifyGraphqlClient,
  collectionId: string,
  productId: string,
) {
  const before = await client.request<{
    collection: { hasProduct: boolean } | null;
  }>(
    `#graphql query NativeCreatorCollectionHasProduct($collectionId: ID!, $productId: ID!) {
      collection(id: $collectionId) { hasProduct(id: $productId) }
    }`,
    { collectionId, productId },
  );
  if (before.collection?.hasProduct) return;
  const result = await client.request<{
    collectionAddProductsV2: {
      job: { id: string } | null;
      userErrors: Errors;
    };
  }>(
    `#graphql mutation NativeCreatorCollectionMembership($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        job { id }
        userErrors { message }
      }
    }`,
    { id: collectionId, productIds: [productId] },
  );
  throwUserErrors(
    result.collectionAddProductsV2.userErrors,
    "Native creator collection membership",
  );
}

async function activateProduct(client: ShopifyGraphqlClient, productId: string) {
  try {
    const result = await client.request<{
      productUpdate: { userErrors: Errors };
    }>(
      `#graphql mutation NativeCreatorProductActivate($product: ProductUpdateInput!) {
        productUpdate(product: $product) { userErrors { message } }
      }`,
      { product: { id: productId, status: "ACTIVE" } },
    );
    throwUserErrors(result.productUpdate.userErrors, "Native creator product activation");
    return;
  } catch {
    const fallback = await client.request<{
      productChangeStatus: { userErrors: Errors };
    }>(
      `#graphql mutation NativeCreatorProductActivateFallback($productId: ID!, $status: ProductStatus!) {
        productChangeStatus(productId: $productId, status: $status) {
          userErrors { message }
        }
      }`,
      { productId, status: "ACTIVE" },
    );
    throwUserErrors(
      fallback.productChangeStatus.userErrors,
      "Native creator product activation",
    );
  }
}

export async function publishCreatorProductToShopify(
  shop: string,
  creatorProductId: string,
  client: ShopifyGraphqlClient,
  database: PublishDb = db,
) {
  const product = await database.creatorProduct.findFirst({
    where: { id: creatorProductId, shop },
    include: { creator: true },
  } as unknown);
  if (!product) {
    throw new DomainError("CREATOR_PRODUCT_NOT_FOUND", "Creator Product not found.", 404);
  }
  if (product.status !== "PENDING" && product.status !== "PUBLISHED") {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_PUBLISHABLE",
      "Only pending Creator Products can be published.",
      409,
    );
  }
  if (product.creator?.status !== "APPROVED") {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can publish Creator Products.",
      403,
    );
  }
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "This Creator Product is missing its PitchPrint master project.",
      409,
    );
  }
  const image = previewUrl(product);
  if (!image) {
    throw new DomainError(
      "CREATOR_PRODUCT_PREVIEW_REQUIRED",
      "Creator product preview is missing.",
      409,
    );
  }
  const publicationId = await shopPublication(shop, database);
  const collection = await ensureShopifyCreatorCollection(
    shop,
    product.creatorId,
    client,
    database as Parameters<typeof ensureShopifyCreatorCollection>[3],
  );
  if (!collection?.shopifyCollectionId) {
    throw new DomainError(
      "SHOPIFY_COLLECTION_REQUIRED",
      "Creator Shopify collection is required before product publication.",
      409,
    );
  }

  const setup = creatorProductSetupFromRecord(
    product as unknown as Parameters<typeof creatorProductSetupFromRecord>[0],
  );
  if (!setup?.fixedColor) {
    throw new DomainError(
      "CREATOR_FIXED_COLOR_REQUIRED",
      "Creator Product fixed color is required before publishing.",
      409,
    );
  }
  if (!database.publicProductProductionPricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Production pricing is not configured for Creator Products.",
      409,
    );
  }
  const pricing = await getProductionPricing(
    shop,
    product.shopifyProductId,
    database as unknown as Parameters<typeof getProductionPricing>[2],
  );
  if (!pricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Production pricing is not configured for Creator Products.",
      409,
    );
  }
  const resolvedPricing = await resolveProductionPricing({
    shop,
    productId: product.shopifyProductId,
    method: setup.productionMethod,
    artworkType: setup.embroiderySubtype,
    database: database as unknown as Parameters<typeof resolveProductionPricing>[0]["database"],
  });
  const cartValidationContract = creatorCartValidationContract(product.id, setup, pricing);

  const existing =
    (await activeProduct(client, product.publishedShopifyProductId)) ||
    (await productByCreatorProductMetafield(client, product.id));
  const shopifyProduct = existing || await duplicateProduct(
    client,
    product.shopifyProductId,
    product.title,
  );
  const handle = await configureProduct(client, {
    product,
    productId: shopifyProduct.id,
    collection,
    previewUrl: image,
    setup,
    pricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
    cartValidationContract,
  });
  await restrictCreatorProductToFixedColor(
    client,
    shopifyProduct.id,
    setup.fixedColor,
  );
  const synchronized = await synchronizeBakedCreatorProductPricing(client, {
    product,
    publishedProductId: shopifyProduct.id,
    collection,
    setup,
    pricing,
    resolvedSurcharge: resolvedPricing.surcharge,
  });
  const { pricingPlan } = synchronized;
  await addToCollection(client, collection.shopifyCollectionId, shopifyProduct.id);
  const variantMap = Object.fromEntries(
    pricingPlan.variants.map((variant) => [
      variant.publishedVariantId,
      variant.baseVariantId,
    ]),
  );
  await activateProduct(client, shopifyProduct.id);
  const inventoryRelationships =
    await ensureCreatorProductSharedInventoryRelationships({
      product: {
        id: product.id,
        status: "PUBLISHED",
        shopifyProductId: product.shopifyProductId,
        publishedShopifyProductId: shopifyProduct.id,
        baseVariantMappingJson: safeJson(variantMap),
      } satisfies CreatorProductRelationshipRecord,
      client,
    });
  const inventoryFailure = inventoryRelationships.find(
    (relationship) =>
      relationship.status !== "CONVERTED" &&
      relationship.status !== "ALREADY_CORRECT",
  );
  if (inventoryFailure) {
    throw new DomainError(
      "CREATOR_SHARED_INVENTORY_SETUP_FAILED",
      `Creator shared inventory setup is incomplete: ${inventoryFailure.status}.`,
      409,
    );
  }
  const now = new Date();
  const updated = await database.creatorProduct.update({
    where: { id: product.id },
    data: {
      status: "PUBLISHED",
      publishedAt: product.status === "PUBLISHED" ? product.publishedAt : now,
      rejectedAt: null,
      rejectionReason: null,
      publishedShopifyProductId: shopifyProduct.id,
      publishedShopifyProductHandle: handle,
      publishedShopifyProductUrl: productUrl(handle),
      shopifyPublishedAt: now,
      baseVariantMappingJson: safeJson(variantMap),
      creatorPricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
    },
  } as unknown);
  await publishResource(client, shopifyProduct.id, publicationId);
  await publishResource(client, collection.shopifyCollectionId, publicationId);
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "SYSTEM",
      action: "creator_product.shopify_published",
      entityType: "CreatorProduct",
      entityId: product.id,
      afterJson: safeJson({
        creatorId: product.creatorId,
        shopifyProductId: shopifyProduct.id,
        shopifyCollectionId: collection.shopifyCollectionId,
        creatorPricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
        productionMethod: pricingPlan.productionMethod,
        embroiderySubtype: pricingPlan.embroiderySubtype,
        placementCount: pricingPlan.placementCount,
        surchargeMinor: pricingPlan.surchargeMinor,
        variantPrices: pricingPlan.variants.map((variant) => ({
          baseVariantId: variant.baseVariantId,
          publishedVariantId: variant.publishedVariantId,
          basePrice: variant.basePrice,
          finalPrice: variant.finalPrice,
        })),
        sharedInventoryRelationships: inventoryRelationships.map((relationship) => ({
          creatorVariantId: relationship.creatorVariantId,
          baseVariantId: relationship.baseVariantId,
          status: relationship.status,
        })),
      }),
    },
  });
  console.info("creator_product_shopify_published", {
    shop,
    creatorId: product.creatorId,
    creatorProductId: product.id,
    shopifyPublishedProductId: shopifyProduct.id,
    shopifyCollectionId: collection.shopifyCollectionId,
    result: "published",
  });
  return updated;
}

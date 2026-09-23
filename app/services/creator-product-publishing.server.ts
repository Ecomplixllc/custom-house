import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import {
  ensureShopifyCreatorCollection,
  type CreatorCollectionRecord,
} from "./creator-collections.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";
import { creatorProductSetupFromRecord } from "./creator-products.server.ts";

type Errors = Array<{ message: string }>;

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
};

export type CreatorProductForPublish = {
  id: string;
  shop: string;
  creatorId: string;
  shopifyProductId: string;
  baseProductTitle: string;
  pitchprintProjectId: string | null;
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

function optionKey(options: Array<{ name: string; value: string }>) {
  return options
    .map((option) => `${option.name.trim().toLowerCase()}:${option.value.trim().toLowerCase()}`)
    .sort()
    .join("|");
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
        includeImages: false
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

async function configureProduct(
  client: ShopifyGraphqlClient,
  input: {
    product: CreatorProductForPublish;
    productId: string;
    collection: CreatorCollectionRecord;
    previewUrl: string;
  },
) {
  const tags = ["creator-fixed", "customhouse-creator-product"];
  const setup = creatorProductSetupFromRecord(
    input.product as unknown as Parameters<typeof creatorProductSetupFromRecord>[0],
  );
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

  const metafields = [
    ["creator_id", input.product.creatorId],
    ["creator_display_name", input.product.creator?.displayName || input.collection.displayName],
    ["creator_handle", input.collection.publicHandle],
    ["creator_product_id", input.product.id],
    ["creator_collection_id", input.collection.id],
    ["creator_shopify_collection_id", input.collection.shopifyCollectionId || ""],
    ["base_product_id", input.product.shopifyProductId],
    ["pitchprint_master_project_id", input.product.pitchprintProjectId || ""],
    ["product_origin", "creator"],
    ["design_mode", "buy_only"],
    ["design_status", "published"],
    ["creator_publishing_enabled", "true"],
    ["product_type", "creator_fixed"],
    ["design_locked", "true"],
    ["fixed_color", setup?.fixedColor || ""],
    ["production_method", setup?.productionMethod || ""],
    ["designed_placement_count", String(setup?.placementCount || 1)],
  ].map(([key, value]) => ({
    ownerId: input.productId,
    namespace: "customhouse",
    key,
    type: key === "design_locked" || key === "creator_publishing_enabled"
      ? "boolean"
      : "single_line_text_field",
    value,
  }));
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

async function productVariantMap(
  client: ShopifyGraphqlClient,
  baseProductId: string,
  publishedProductId: string,
) {
  const result = await client.request<{
    base: {
      variants: {
        nodes: Array<{ id: string; selectedOptions: Array<{ name: string; value: string }> }>;
      };
    } | null;
    published: {
      variants: {
        nodes: Array<{ id: string; selectedOptions: Array<{ name: string; value: string }> }>;
      };
    } | null;
  }>(
    `#graphql query NativeCreatorVariantMap($baseId: ID!, $publishedId: ID!) {
      base: product(id: $baseId) {
        variants(first: 100) { nodes { id selectedOptions { name value } } }
      }
      published: product(id: $publishedId) {
        variants(first: 100) { nodes { id selectedOptions { name value } } }
      }
    }`,
    { baseId: baseProductId, publishedId: publishedProductId },
  );
  const baseByOptions = new Map(
    (result.base?.variants.nodes || []).map((variant) => [
      optionKey(variant.selectedOptions),
      variant.id,
    ]),
  );
  return Object.fromEntries(
    (result.published?.variants.nodes || []).flatMap((variant) => {
      const baseVariantId = baseByOptions.get(optionKey(variant.selectedOptions));
      return baseVariantId ? [[variant.id, baseVariantId]] : [];
    }),
  );
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
  });
  await addToCollection(client, collection.shopifyCollectionId, shopifyProduct.id);
  await publishResource(client, shopifyProduct.id, publicationId);
  await publishResource(client, collection.shopifyCollectionId, publicationId);
  await activateProduct(client, shopifyProduct.id);
  const variantMap = await productVariantMap(
    client,
    product.shopifyProductId,
    shopifyProduct.id,
  );
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
    },
  } as unknown);
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

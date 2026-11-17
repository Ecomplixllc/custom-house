import { randomUUID } from "node:crypto";
import db from "../db.server";
import { ensureCreatorCollection } from "./creator.server";
import { DomainError, safeJson } from "./domain";
import {
  canCreatorPublish,
  duplicateVariantsToDelete,
  fixedProductTags,
  type VariantShape,
} from "./designer-publishing";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";
import { verifyInkyBayGlobalProduct } from "./inkybay/inkybay-product.server";
import {
  canRunPreviewMutation,
  isPreviewOwnedRecord,
  isPreviewRuntime,
} from "./environment-safety.server";

type Errors = Array<{ message: string }>;

async function setProductStatus(
  client: ShopifyGraphqlClient,
  productId: string,
  status: "ACTIVE" | "DRAFT",
) {
  const result = await client.request<{
    productUpdate: { userErrors: Errors };
  }>(
    `#graphql mutation DesignerProductStatus($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { message } }
    }`,
    { product: { id: productId, status } },
  );
  throwUserErrors(result.productUpdate.userErrors, "Designer product status");
}

async function setPublication(
  client: ShopifyGraphqlClient,
  id: string,
  publicationId: string,
  publish: boolean,
) {
  const field = publish ? "publishablePublish" : "publishableUnpublish";
  const result = await client.request<Record<string, { userErrors: Errors }>>(
    `#graphql mutation DesignerPublication($id: ID!, $input: [PublicationInput!]!) {
      ${field}(id: $id, input: $input) { userErrors { message } }
    }`,
    { id, input: [{ publicationId }] },
  );
  throwUserErrors(result[field].userErrors, "Designer publication");
}

async function createOrReuseProduct(
  client: ShopifyGraphqlClient,
  input: {
    currentProductId: string | null;
    sourceProductId: string;
    title: string;
  },
) {
  if (input.currentProductId) {
    await setProductStatus(client, input.currentProductId, "DRAFT");
    return input.currentProductId;
  }
  const result = await client.request<{
    productDuplicate: {
      newProduct: { id: string } | null;
      userErrors: Errors;
    };
  }>(
    `#graphql mutation DuplicateDesignerProduct(
      $productId: ID!,
      $title: String!
    ) {
      productDuplicate(
        productId: $productId,
        newTitle: $title,
        newStatus: DRAFT,
        includeImages: false
      ) {
        newProduct { id }
        userErrors { message }
      }
    }`,
    { productId: input.sourceProductId, title: input.title },
  );
  throwUserErrors(result.productDuplicate.userErrors, "Designer product duplication");
  const productId = result.productDuplicate.newProduct?.id;
  if (!productId) {
    throw new Error("Designer product duplication failed.");
  }
  return productId;
}

async function waitForDesignerMedia(
  client: ShopifyGraphqlClient,
  productId: string,
  alt: string,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await client.request<{
      product: {
        media: { nodes: Array<{ alt: string | null; status: string }> };
      } | null;
    }>(
      `#graphql query DesignerMediaStatus($id: ID!) {
        product(id: $id) {
          media(first: 50) { nodes { alt status } }
        }
      }`,
      { id: productId },
    );
    const media = result.product?.media.nodes.find((item) => item.alt === alt);
    if (media?.status === "READY") return;
    if (media?.status === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new DomainError(
    "DESIGN_MEDIA_PROCESSING",
    "The product preview is still processing. Retry publishing shortly.",
    503,
  );
}

async function configureFixedProduct(
  client: ShopifyGraphqlClient,
  input: {
    productId: string;
    title: string;
    sourceTags: string[];
    sourceVariants: VariantShape[];
    allowedVariantIds: readonly string[];
    previewUrl: string;
    creatorId: string;
    designId: string;
    baseProductId: string;
    collectionId: string;
    publicationId?: string | null;
    inkybayTid?: string | null;
    designVersion?: number;
  },
) {
  const updated = await client.request<{
    productUpdate: { userErrors: Errors };
  }>(
    `#graphql mutation ConfigureDesignerProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { message } }
    }`,
    {
      product: {
        id: input.productId,
        title: input.title,
        status: "DRAFT",
        tags: fixedProductTags(input.sourceTags),
      },
    },
  );
  throwUserErrors(updated.productUpdate.userErrors, "Designer product configuration");

  const metafields = [
    ["product_origin", "single_line_text_field", "creator"],
    ["design_mode", "single_line_text_field", "buy_only"],
    ["product_type", "single_line_text_field", "creator_fixed"],
    ["creator_id", "single_line_text_field", input.creatorId],
    ["creator_design_id", "single_line_text_field", input.designId],
    ["base_product_id", "single_line_text_field", input.baseProductId],
    ["design_locked", "boolean", "true"],
    ["design_version", "number_integer", String(input.designVersion ?? 1)],
    ...(isPreviewRuntime()
      ? [
          ["preview_owner_app", "single_line_text_field", "customhouse-dev-800679"],
          ["preview_poc", "boolean", "true"],
        ]
      : []),
    ...(input.inkybayTid
      ? [
          [
            "inkybay_saved_design_tid",
            "single_line_text_field",
            input.inkybayTid,
          ],
        ]
      : []),
  ].map(([key, type, value]) => ({
    ownerId: input.productId,
    namespace: "customhouse",
    key,
    type,
    value,
  }));
  const metafieldResult = await client.request<{
    metafieldsSet: { userErrors: Errors };
  }>(
    `#graphql mutation DesignerProductMetafields(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    { metafields },
  );
  throwUserErrors(
    metafieldResult.metafieldsSet.userErrors,
    "Designer product metafields",
  );

  const duplicate = await client.request<{
    product: {
      media: { nodes: Array<{ alt: string | null; status: string }> };
      variants: { nodes: VariantShape[] };
    } | null;
  }>(
    `#graphql query DesignerDuplicateState($id: ID!) {
      product(id: $id) {
        media(first: 50) { nodes { alt status } }
        variants(first: 100) {
          nodes { id selectedOptions { name value } }
        }
      }
    }`,
    { id: input.productId },
  );
  if (!duplicate.product) throw new Error("Designer product is unavailable.");
  const mediaAlt = `Custom House design ${input.designId}`;
  if (!duplicate.product.media.nodes.some((item) => item.alt === mediaAlt)) {
    const media = await client.request<{
      productUpdate: { userErrors: Errors };
    }>(
      `#graphql mutation DesignerProductMedia(
        $product: ProductUpdateInput!,
        $media: [CreateMediaInput!]!
      ) {
        productUpdate(product: $product, media: $media) {
          userErrors { message }
        }
      }`,
      {
        product: { id: input.productId },
        media: [
          {
            originalSource: input.previewUrl,
            mediaContentType: "IMAGE",
            alt: mediaAlt,
          },
        ],
      },
    );
    throwUserErrors(media.productUpdate.userErrors, "Designer preview image");
  }
  await waitForDesignerMedia(client, input.productId, mediaAlt);

  const deleteIds = duplicateVariantsToDelete(
    input.sourceVariants,
    input.allowedVariantIds,
    duplicate.product.variants.nodes,
  );
  if (deleteIds.length) {
    const deleted = await client.request<{
      productVariantsBulkDelete: { userErrors: Errors };
    }>(
      `#graphql mutation TrimDesignerVariants(
        $productId: ID!,
        $variantsIds: [ID!]!
      ) {
        productVariantsBulkDelete(
          productId: $productId,
          variantsIds: $variantsIds
        ) { userErrors { message } }
      }`,
      { productId: input.productId, variantsIds: deleteIds },
    );
    throwUserErrors(
      deleted.productVariantsBulkDelete.userErrors,
      "Designer variant selection",
    );
  }

  const membership = await client.request<{
    collectionAddProducts: { userErrors: Errors };
  }>(
    `#graphql mutation AddDesignerToCollection(
      $id: ID!,
      $products: [ID!]!
    ) {
      collectionAddProducts(id: $id, productIds: $products) {
        userErrors { message }
      }
    }`,
    { id: input.collectionId, products: [input.productId] },
  );
  throwUserErrors(
    membership.collectionAddProducts.userErrors,
    "Designer collection membership",
  );
  if (input.publicationId && !isPreviewRuntime()) {
    await setPublication(client, input.productId, input.publicationId, true);
    await setPublication(client, input.collectionId, input.publicationId, true);
  }
  if (!isPreviewRuntime()) {
    await setProductStatus(client, input.productId, "ACTIVE");
  }
}

export async function synchronizeCreatorDesign(
  shop: string,
  designId: string,
  client: ShopifyGraphqlClient,
) {
  const design = await db.creatorDesign.findFirst({
    where: { id: designId, shop },
    include: { creator: true, designSession: true },
  });
  if (!design) {
    throw new DomainError("DESIGN_MISSING", "The creator design was not found.", 404);
  }
  if (
    isPreviewRuntime() &&
    (!isPreviewOwnedRecord(design) ||
      !canRunPreviewMutation({
        shop,
        resourceType: "product",
        resourceId: design.globalShopifyProductId,
      }))
  ) {
    throw new DomainError(
      "PREVIEW_PRODUCT_MUTATION_DENIED",
      "This design is not owned by the Preview POC or its source product is not allowlisted.",
      403,
    );
  }
  if (
    !canCreatorPublish(
      design.creator.status,
      design.creator.suspendedAt,
    )
  ) {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can add designs to a collection.",
      403,
    );
  }
  if (design.provider !== "INKYBAY") {
    throw new DomainError(
      "DESIGN_PROVIDER_UNSUPPORTED",
      "Only PitchPrint creator designs can be published by this release.",
      409,
    );
  }
  const source = await verifyInkyBayGlobalProduct(
    client,
    design.globalShopifyProductId,
    design.designSession.shopifyVariantId,
  );
  let selected: unknown = [];
  try {
    selected = JSON.parse(design.compatibleVariantIdsJson);
  } catch {
    selected = [];
  }
  const available = new Set(
    source.variants
      .filter((variant) => variant.availableForSale !== false)
      .map((variant) => variant.id),
  );
  const allowedVariantIds: readonly string[] = Array.isArray(selected)
    ? selected.filter(
        (variant): variant is string =>
          typeof variant === "string" && available.has(variant),
      )
    : [];
  if (!allowedVariantIds.length) {
    throw new DomainError(
      "INKYBAY_VARIANTS_INVALID",
      "No compatible product variants remain available.",
      409,
    );
  }
  let productId = design.shopifyCreatorProductId;
  try {
    const collectionId = await ensureCreatorCollection(
      shop,
      design.creatorId,
      client,
    );
    if (!collectionId) {
      throw new DomainError(
        "COLLECTION_REQUIRED",
        "A creator collection is required before publishing.",
        409,
      );
    }
    productId = await createOrReuseProduct(client, {
      currentProductId: productId,
      sourceProductId: source.id,
      title: design.title,
    });
    if (productId !== design.shopifyCreatorProductId) {
      await db.creatorDesign.update({
        where: { id: design.id },
        data: { shopifyCreatorProductId: productId },
      });
    }
    const shopConfig = await db.shopConfig.findUnique({ where: { shop } });
    await configureFixedProduct(client, {
      productId,
      title: design.title,
      sourceTags: source.tags,
      sourceVariants: source.variants,
      allowedVariantIds,
      previewUrl: design.previewUrl,
      creatorId: design.creatorId,
      designId: design.id,
      baseProductId: design.globalShopifyProductId,
      collectionId,
      publicationId: shopConfig?.onlineStorePublicationId,
      inkybayTid: design.inkybayTid,
      designVersion: design.designVersion,
    });
    const now = new Date();
    return db.$transaction(async (tx) => {
      const updated = await tx.creatorDesign.update({
        where: { id: design.id },
        data: {
          shopifyCreatorProductId: productId,
          shopifyCollectionId: collectionId,
          status: isPreviewRuntime() ? "DRAFT" : "ACTIVE",
          syncStatus: "SYNCED",
          publishError: null,
          lastErrorCode: null,
          lastErrorReference: null,
          publishedAt: isPreviewRuntime() ? null : now,
        },
      });
      await tx.designSession.update({
        where: { id: design.designSessionId },
        data: { status: "PUBLISHED" },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: "CREATOR",
          actorId: design.creator.customerId,
          action: "inkybay_design.published",
          entityType: "CreatorDesign",
          entityId: design.id,
          afterJson: safeJson({ productId, collectionId }),
        },
      });
      return updated;
    });
  } catch {
    const referenceId = randomUUID();
    if (productId) {
      try {
        await setProductStatus(client, productId, "DRAFT");
      } catch {
        // The stored product ID makes the next retry idempotent.
      }
    }
    await db.creatorDesign.update({
      where: { id: design.id },
      data: {
        shopifyCreatorProductId: productId,
        status: "FAILED",
        syncStatus: "FAILED",
        publishError: "Shopify synchronization failed. Retry is available.",
        lastErrorCode: "SHOPIFY_DESIGN_SYNC_FAILED",
        lastErrorReference: referenceId,
      },
    });
    throw new DomainError(
      "DESIGN_PUBLISH_FAILED",
      "We could not publish this design. Please try again.",
      502,
    );
  }
}

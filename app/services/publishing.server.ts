import db from "../db.server";
import { DomainError, collectionTitle, safeJson, slugify } from "./domain";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";

type Errors = Array<{ message: string }>;

async function setProductStatus(client: ShopifyGraphqlClient, productId: string, status: "ACTIVE" | "DRAFT") {
  const result = await client.request<{ productUpdate: { userErrors: Errors } }>(
    `#graphql mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`,
    { product: { id: productId, status } },
  );
  throwUserErrors(result.productUpdate.userErrors, `Product ${status.toLowerCase()}`);
}

async function ensureCollection(
  shop: string,
  creator: { id: string; displayName: string; handle: string; collectionId: string | null },
  client: ShopifyGraphqlClient,
) {
  if (creator.collectionId) return creator.collectionId;
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config?.automaticCollectionCreationEnabled) {
    throw new DomainError("COLLECTION_REQUIRED", "Enable automatic creator collections before publishing.", 409);
  }
  const result = await client.request<{ collectionCreate: { collection: { id: string } | null; userErrors: Errors } }>(
    `#graphql mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`,
    { input: { title: collectionTitle(config.collectionTitleTemplate, creator.displayName), handle: `${slugify(creator.handle)}-${slugify(config.collectionHandleSuffix)}` } },
  );
  throwUserErrors(result.collectionCreate.userErrors, "Collection creation");
  const id = result.collectionCreate.collection?.id;
  if (!id) throw new Error("Collection creation returned no collection.");
  await db.creator.update({ where: { id: creator.id }, data: { collectionId: id } });
  return id;
}

export async function publishSubmission(shop: string, submissionId: string, client: ShopifyGraphqlClient) {
  const submission = await db.designSubmission.findFirst({ where: { id: submissionId, shop }, include: { creator: true } });
  if (!submission) throw new DomainError("NOT_FOUND", "Submission not found.", 404);
  if (!(["PENDING", "FAILED", "APPROVED"] as string[]).includes(submission.status)) throw new DomainError("NOT_PUBLISHABLE", "Submission is not publishable.", 409);
  if (submission.creator.status !== "APPROVED") throw new DomainError("CREATOR_NOT_APPROVED", "Creator is no longer approved.", 409);

  const base = await client.request<{ product: { origin: { value: string } | null; mode: { value: string } | null } | null }>(
    `#graphql query($id: ID!) { product(id: $id) { origin: metafield(namespace: "customhouse", key: "product_origin") { value } mode: metafield(namespace: "customhouse", key: "design_mode") { value } } }`,
    { id: submission.baseProductId },
  );
  if (!base.product || base.product.origin?.value !== "global" || base.product.mode?.value !== "customizable") {
    throw new DomainError("INVALID_BASE_PRODUCT", "Base product is not a customizable Global Product.", 422);
  }

  const claim = await db.designSubmission.updateMany({
    where: { id: submission.id, shop, status: { in: ["PENDING", "FAILED", "APPROVED"] } },
    data: { status: "PUBLISHING", publishError: null, reviewedAt: new Date() },
  });
  if (claim.count !== 1) throw new DomainError("ALREADY_PUBLISHING", "This submission is already being published.", 409);

  let productId = submission.createdProductId;
  try {
    const collectionId = await ensureCollection(shop, submission.creator, client);
    if (!productId) {
      const duplicate = await client.request<{ productDuplicate: { newProduct: { id: string } | null; userErrors: Errors } }>(
        `#graphql mutation($productId: ID!, $title: String!) { productDuplicate(productId: $productId, newTitle: $title, newStatus: DRAFT, includeImages: false) { newProduct { id } userErrors { message } } }`,
        { productId: submission.baseProductId, title: `${submission.designName} by ${submission.creator.displayName}`.slice(0, 255) },
      );
      throwUserErrors(duplicate.productDuplicate.userErrors, "Product duplication");
      productId = duplicate.productDuplicate.newProduct?.id ?? null;
      if (!productId) throw new Error("Product duplication returned no product.");
      await db.designSubmission.update({ where: { id: submission.id }, data: { createdProductId: productId } });
    } else {
      await setProductStatus(client, productId, "DRAFT");
    }

    const metafields = [
      { ownerId: productId, namespace: "customhouse", key: "product_origin", type: "single_line_text_field", value: "creator" },
      { ownerId: productId, namespace: "customhouse", key: "design_mode", type: "single_line_text_field", value: "buy_only" },
      { ownerId: productId, namespace: "customhouse", key: "design_status", type: "single_line_text_field", value: "published" },
    ];
    if (submission.creator.creatorProfileMetaobjectId) {
      metafields.push({ ownerId: productId, namespace: "customhouse", key: "creator_profile", type: "metaobject_reference", value: submission.creator.creatorProfileMetaobjectId });
    }
    const metafieldResult = await client.request<{ metafieldsSet: { userErrors: Errors } }>(
      `#graphql mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
      { metafields },
    );
    throwUserErrors(metafieldResult.metafieldsSet.userErrors, "Metafield assignment");

    const membership = await client.request<{ collectionAddProducts: { userErrors: Errors } }>(
      `#graphql mutation($id: ID!, $products: [ID!]!) { collectionAddProducts(id: $id, productIds: $products) { userErrors { message } } }`,
      { id: collectionId, products: [productId] },
    );
    throwUserErrors(membership.collectionAddProducts.userErrors, "Collection membership");

    const config = await db.shopConfig.findUnique({ where: { shop } });
    if (config?.onlineStorePublicationId) {
      for (const id of [productId, collectionId]) {
        const publication = await client.request<{ publishablePublish: { userErrors: Errors } }>(
          `#graphql mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
          { id, input: [{ publicationId: config.onlineStorePublicationId }] },
        );
        throwUserErrors(publication.publishablePublish.userErrors, "Online Store publication");
      }
    }

    // Activation is deliberately last: an incompletely configured product stays DRAFT.
    await setProductStatus(client, productId, "ACTIVE");
    await db.$transaction([
      db.designSubmission.update({ where: { id: submission.id }, data: { status: "PUBLISHED", publishedAt: new Date(), publishError: null } }),
      db.auditLog.create({ data: { shop, actorType: "ADMIN", action: "submission.published", entityType: "DesignSubmission", entityId: submission.id, afterJson: safeJson({ productId, collectionId }) } }),
    ]);
    return productId;
  } catch (error) {
    if (productId) {
      try { await setProductStatus(client, productId, "DRAFT"); } catch { /* Retain the original safe error; retry will attempt DRAFT again. */ }
    }
    const summary = error instanceof Error ? error.message.slice(0, 500) : "Publishing failed.";
    await db.designSubmission.update({ where: { id: submission.id }, data: { status: "FAILED", publishError: summary, createdProductId: productId } });
    throw new DomainError("PUBLISH_FAILED", summary, 502);
  }
}

import type { CreatorStatus } from "@prisma/client";
import db from "../db.server";
import {
  collectionTitle,
  CREATOR_TAGS,
  DomainError,
  safeJson,
  slugify,
  statusTags,
} from "./domain";
import { normalizeCustomerGid } from "./helium-sync.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";
import {
  validateCreatorApplication,
  type CreatorApplicationInput,
} from "./creator-application";
import {
  ensureShopifyCreatorCollection,
  syncCreatorCollectionStatus,
  unpublishShopifyCreatorCollection,
} from "./creator-collections.server";
import { referralFieldsForCode } from "./creator-referral.server";

async function syncCustomerCreatorStatusMetafield(
  customerId: string,
  status: CreatorStatus,
  client: ShopifyGraphqlClient,
) {
  const result = await client.request<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation CustomerCreatorStatus($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        {
          ownerId: customerId,
          namespace: "customhouse",
          key: "creator_status",
          type: "single_line_text_field",
          value: status,
        },
      ],
    },
  );
  throwUserErrors(
    result.metafieldsSet.userErrors,
    "Customer creator status sync",
  );
}

export async function createApplication(
  shop: string,
  customerId: string,
  input: CreatorApplicationInput,
  client: ShopifyGraphqlClient,
) {
  customerId = normalizeCustomerGid(customerId);
  const value = validateCreatorApplication(input);
  const config = await db.shopConfig.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  if (!config.creatorApplicationsEnabled) throw new DomainError("APPLICATIONS_DISABLED", "Creator applications are currently unavailable.", 503);
  const existing = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  if (existing?.status === "PENDING")
    throw new DomainError(
      "DUPLICATE_APPLICATION",
      "An active creator application already exists.",
      409,
    );
  if (existing?.status === "APPROVED" || existing?.status === "SUSPENDED")
    throw new DomainError(
      "APPLICATION_NOT_ALLOWED",
      "This creator account cannot submit another application.",
      409,
    );
  if (
    existing?.status === "REJECTED" &&
    !config.allowReapplicationAfterRejection
  )
    throw new DomainError(
      "REAPPLICATION_DISABLED",
      "Reapplication is not currently enabled.",
      409,
    );
  const customer = await client.request<{
    customer: { tags: string[] } | null;
  }>(
    `#graphql query ApplicationCustomer($id: ID!) { customer(id: $id) { tags } }`,
    { id: customerId },
  );
  if (!customer.customer)
    throw new DomainError(
      "CUSTOMER_NOT_FOUND",
      "The Shopify customer account could not be verified.",
      409,
    );
  const tagResult = await client.request<{
    customerUpdate: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation ApplicationTags($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { message } } }`,
    {
      input: {
        id: customerId,
        tags: statusTags(customer.customer.tags, "PENDING"),
      },
    },
  );
  throwUserErrors(
    tagResult.customerUpdate.userErrors,
    "Customer application tag sync",
  );
  await syncCustomerCreatorStatusMetafield(customerId, "PENDING", client);
  let handle = slugify(value.displayName),
    suffix = 2;
  while (
    await db.creator.findFirst({ where: { shop, handle, NOT: { customerId } } })
  )
    handle = `${slugify(value.displayName)}-${suffix++}`;
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${shop}:${customerId}`}))`;
    const pending = await tx.creator.findUnique({
      where: { shop_customerId: { shop, customerId } },
      select: { id: true, status: true },
    });
    if (pending?.status === "PENDING") throw new DomainError("DUPLICATE_APPLICATION", "An active creator application already exists.", 409);
    const common = {
      displayName: value.displayName,
      handle,
      bio: value.bio,
      portfolioUrl: value.portfolioUrl,
      socialLinksJson: safeJson(value.socialLinks),
      profileImageUrl: value.profileImageUrl,
      legalName: value.legalName,
      country: value.country,
      city: value.city,
      emailSnapshot: value.emailSnapshot,
      primaryPlatform: value.primaryPlatform,
      primaryProfileUrl: value.primaryProfileUrl,
      audienceRange: value.audienceRange,
      categoriesJson: safeJson(value.categories || []),
      aboutWork: value.aboutWork,
      termsAcceptedAt: value.termsAcceptedAt,
      submittedAt: new Date(),
      reviewedAt: null,
      applicationSource: "CUSTOM_APP" as const,
      statusAuthority: "CUSTOM_APP" as const,
      status: "PENDING" as const,
      rejectionReason: null,
    };
    const creator = await tx.creator.upsert({
      where: { shop_customerId: { shop, customerId } },
      update: common,
      create: { shop, customerId, ...referralFieldsForCode(handle), ...common },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "CUSTOMER",
        actorId: customerId,
        action: "creator.application.submitted",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ source: "CUSTOM_APP", status: "PENDING" }),
      },
    });
    return { creator, application: null };
  });
  return updated;
}

export async function changeCreatorStatus(
  shop: string,
  creatorId: string,
  next: CreatorStatus,
  client: ShopifyGraphqlClient,
  reason?: string,
) {
  const creator = await db.creator.findFirst({
    where: { id: creatorId, shop },
  });
  if (!creator) throw new DomainError("NOT_FOUND", "Creator not found.", 404);
  const customer = await client.request<{
    customer: { id: string; tags: string[] } | null;
  }>(`#graphql query($id: ID!) { customer(id: $id) { id tags } }`, {
    id: creator.customerId,
  });
  if (!customer.customer)
    throw new DomainError(
      "CUSTOMER_NOT_FOUND",
      "The Shopify customer no longer exists.",
      409,
    );
  const desiredTags = statusTags(customer.customer.tags, next);
  const creatorTagSet = new Set(Object.values(CREATOR_TAGS));
  const remove = customer.customer.tags.filter((tag) => creatorTagSet.has(tag as typeof CREATOR_TAGS.applicant) && !desiredTags.includes(tag));
  const add = desiredTags.filter((tag) => !customer.customer!.tags.includes(tag));
  if (remove.length) { const result = await client.request<{ tagsRemove: { userErrors: Array<{ message: string }> } }>(`#graphql mutation RemoveCreatorTags($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: creator.customerId, tags: remove }); throwUserErrors(result.tagsRemove.userErrors, "Customer tag removal"); }
  if (add.length) { const result = await client.request<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(`#graphql mutation AddCreatorTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: creator.customerId, tags: add }); throwUserErrors(result.tagsAdd.userErrors, "Customer tag addition"); }
  await syncCustomerCreatorStatusMetafield(creator.customerId, next, client);
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const updated = await tx.creator.update({
      where: { id: creator.id },
      data: {
        status: next,
        statusAuthority: "CUSTOM_APP",
        externalSyncConflict: false,
        approvedAt: next === "APPROVED" ? now : creator.approvedAt,
        rejectedAt: next === "REJECTED" ? now : null,
        suspendedAt: next === "SUSPENDED" ? now : null,
        rejectionReason: next === "REJECTED" ? reason : null,
        suspensionReason: next === "SUSPENDED" ? reason : null,
      },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "ADMIN",
        action: `creator.${next.toLowerCase()}`,
        entityType: "Creator",
        entityId: creatorId,
        beforeJson: safeJson({ status: creator.status }),
        afterJson: safeJson({ status: next, reason }),
      },
    });
    return updated;
  });
  if (next === "APPROVED") {
    await ensureShopifyCreatorCollection(shop, creator.id, client);
    try { await syncCreatorProfileMetaobject(shop, creator.id, client); }
    catch { await db.auditLog.create({ data: { shop, actorType: "SYSTEM", action: "creator.metaobject_sync_warning", entityType: "Creator", entityId: creator.id, afterJson: safeJson({ recoverable: true }) } }); }
  }
  if (next === "SUSPENDED") {
    await syncCreatorCollectionStatus(shop, creator.id);
    await unpublishShopifyCreatorCollection(shop, creator.id, client);
  }
  if (next === "REJECTED") {
    await syncCreatorCollectionStatus(shop, creator.id);
  }
  return updated;
}

export async function reactivateCreator(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
) {
  const creator = await db.creator.findFirst({
    where: { id: creatorId, shop },
    include: {
      marketplaceCollection: {
        select: { id: true, publicHandle: true },
      },
    },
  });
  if (!creator) throw new DomainError("NOT_FOUND", "Creator not found.", 404);
  if (creator.status !== "SUSPENDED") {
    throw new DomainError(
      "INVALID_STATUS",
      "Only suspended creators can be reactivated.",
      409,
    );
  }
  const collectionBefore = creator.marketplaceCollection;
  const updated = await changeCreatorStatus(shop, creator.id, "APPROVED", client);
  if (collectionBefore) {
    const collectionAfter = await db.creatorCollection.findUnique({
      where: { creatorId: creator.id },
      select: { id: true, publicHandle: true },
    });
    if (
      collectionAfter &&
      (collectionAfter.id !== collectionBefore.id ||
        collectionAfter.publicHandle !== collectionBefore.publicHandle)
    ) {
      throw new DomainError(
        "COLLECTION_IDENTITY_CHANGED",
        "Creator collection identity changed during reactivation.",
        500,
      );
    }
  }
  await db.auditLog.create({
    data: {
      shop,
      actorType: "ADMIN",
      action: "creator.reactivated",
      entityType: "Creator",
      entityId: creator.id,
      beforeJson: safeJson({ status: "SUSPENDED" }),
      afterJson: safeJson({ status: "APPROVED" }),
    },
  });
  return updated;
}

export async function syncCreatorProfileMetaobject(shop: string, creatorId: string, client: ShopifyGraphqlClient) {
  const [creator, config] = await Promise.all([db.creator.findFirst({ where: { id: creatorId, shop } }), db.shopConfig.findUnique({ where: { shop } })]);
  if (!creator || !config?.creatorProfileMetaobjectType || !config.creatorProfileFieldMapJson) return null;
  let mapping: Record<string, string>;
  try { mapping = JSON.parse(config.creatorProfileFieldMapJson) as Record<string, string>; } catch { throw new DomainError("INVALID_METAOBJECT_MAPPING", "Creator Profile mapping is invalid.", 422); }
  const collectionUrl = creator.collectionId ? `/collections/${creator.handle}-${slugify(config.collectionHandleSuffix)}` : "";
  const values: Record<string, string | null> = { displayName: creator.displayName, biography: creator.bio, profileImage: creator.profileImageUrl, portfolioUrl: creator.portfolioUrl, socialLinks: creator.socialLinksJson, creatorHandle: creator.handle, collectionUrl, creatorStatus: creator.status };
  const fields = Object.entries(mapping).filter(([source, key]) => values[source] && /^[a-z][a-z0-9_]*$/.test(key)).map(([source, key]) => ({ key, value: values[source]! }));
  if (!fields.length) return null;
  const result = await client.request<{ metaobjectUpsert: { metaobject: { id: string } | null; userErrors: Array<{ message: string }> } }>(
    `#graphql mutation CreatorProfileUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) { metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id } userErrors { message } } }`,
    { handle: { type: config.creatorProfileMetaobjectType, handle: creator.handle }, metaobject: { fields } },
  );
  throwUserErrors(result.metaobjectUpsert.userErrors, "Creator Profile synchronization");
  const id = result.metaobjectUpsert.metaobject?.id; if (id) await db.creator.update({ where: { id: creator.id }, data: { creatorProfileMetaobjectId: id } });
  return id ?? null;
}

export async function ensureCreatorCollection(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
) {
  const [creator, config] = await Promise.all([
    db.creator.findFirst({ where: { id: creatorId, shop } }),
    db.shopConfig.findUnique({ where: { shop } }),
  ]);
  if (!creator) return null;
  let collectionId = creator.collectionId;
  if (!collectionId && config?.automaticCollectionCreationEnabled === false) return null;
  const title = collectionTitle(
    config?.collectionTitleTemplate ?? "{creatorName} Designs",
    creator.displayName,
  );
  const handle = `${creator.handle}-${slugify(config?.collectionHandleSuffix ?? "designs")}`;
  if (!collectionId) {
  const result = await client.request<{
    collectionCreate: {
      collection: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation CreatorCollection($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`,
    { input: { title, handle } },
  );
  throwUserErrors(
    result.collectionCreate.userErrors,
    "Creator collection creation",
  );
  if (!result.collectionCreate.collection)
    throw new DomainError(
      "COLLECTION_CREATE_FAILED",
      "Creator collection could not be created.",
      502,
    );
  collectionId = result.collectionCreate.collection.id;
  await db.creator.update({
    where: { id: creator.id },
    data: { collectionId },
  });
  }
  if (config?.onlineStorePublicationId && collectionId) {
    const publication = await client.request<{ publishablePublish: { userErrors: Array<{ message: string }> } }>(
      `#graphql mutation PublishCreatorCollection($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
      { id: collectionId, input: [{ publicationId: config.onlineStorePublicationId }] },
    );
    throwUserErrors(publication.publishablePublish.userErrors, "Creator collection publication");
  }
  return collectionId;
}

export const defaultCreatorTags = Object.values(CREATOR_TAGS);

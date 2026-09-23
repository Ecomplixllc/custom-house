import { createHash, randomUUID } from "node:crypto";
import db from "../db.server.ts";
import { DomainError, slugify } from "./domain.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";

type CollectionStatus = "ACTIVE" | "HIDDEN" | "SUSPENDED";

type CreatorCollectionDb = {
  creator: {
    findFirst(args: unknown): Promise<{
      id: string;
      shop: string;
      displayName: string;
      handle: string;
      status: string;
    } | null>;
    findMany?(args: unknown): Promise<
      Array<{
        id: string;
        shop: string;
        displayName: string;
        handle: string;
        status: string;
      }>
    >;
    updateMany?(args: unknown): Promise<unknown>;
  };
  creatorCollection: {
    findUnique(args: unknown): Promise<CreatorCollectionRecord | null>;
    findFirst(args: unknown): Promise<CreatorCollectionRecord | null>;
    findMany?(args: unknown): Promise<CreatorCollectionRecord[]>;
    create(args: unknown): Promise<CreatorCollectionRecord>;
    update(args: unknown): Promise<CreatorCollectionRecord>;
    upsert?(args: unknown): Promise<CreatorCollectionRecord>;
    count?(args: unknown): Promise<number>;
  };
  shopConfig?: {
    findUnique(args: unknown): Promise<{
      onlineStorePublicationId: string | null;
    } | null>;
  };
};

export type CreatorCollectionRecord = {
  id: string;
  shop: string;
  creatorId: string;
  publicId: string;
  publicHandle: string;
  displayName: string;
  status: CollectionStatus;
  bannerImageUrl?: string | null;
  bannerTitle?: string | null;
  bannerSubtitle?: string | null;
  bannerUpdatedAt?: Date | null;
  shopifyCollectionId?: string | null;
  shopifyCollectionHandle?: string | null;
  shopifyCollectionUrl?: string | null;
  shopifyPublishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function shortPublicSuffix(publicId: string) {
  return createHash("sha256")
    .update(publicId)
    .digest("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 5)
    .toLowerCase();
}

function publicHandle(displayName: string, publicId: string, attempt = 0) {
  const slug = slugify(displayName).slice(0, 48);
  const base = !slug || slug === "creator" ? "creator" : slug;
  const suffix = shortPublicSuffix(`${publicId}:${attempt}`);
  return `${base}-${suffix}`;
}

function publicDisplayName(creator: { displayName: string }) {
  return `${creator.displayName || "Creator"} Designs`.slice(0, 140);
}

function collectionStatusForCreator(status: string): CollectionStatus {
  if (status === "APPROVED") return "ACTIVE";
  if (status === "SUSPENDED") return "SUSPENDED";
  return "HIDDEN";
}

async function uniquePublicHandle(
  displayName: string,
  publicId: string,
  database: CreatorCollectionDb,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const handle = publicHandle(displayName, publicId, attempt);
    const existing = await database.creatorCollection.findFirst({
      where: { publicHandle: handle },
      select: { id: true },
    });
    if (!existing) return handle;
  }
  throw new DomainError(
    "COLLECTION_HANDLE_UNAVAILABLE",
    "A unique creator collection URL could not be generated.",
    409,
  );
}

export async function ensureCreatorCollectionRecord(
  shop: string,
  creatorId: string,
  database: CreatorCollectionDb = db,
) {
  const creator = await database.creator.findFirst({
    where: { id: creatorId, shop },
    select: {
      id: true,
      shop: true,
      displayName: true,
      handle: true,
      status: true,
    },
  });
  if (!creator) {
    throw new DomainError("CREATOR_NOT_FOUND", "Creator not found.", 404);
  }
  const existing = await database.creatorCollection.findUnique({
    where: { creatorId: creator.id },
  });
  if (existing) {
    const status = collectionStatusForCreator(creator.status);
    if (
      existing.status !== status ||
      existing.displayName !== publicDisplayName(creator)
    ) {
      return database.creatorCollection.update({
        where: { id: existing.id },
        data: {
          status,
          displayName: publicDisplayName(creator),
        },
      });
    }
    return existing;
  }
  if (creator.status !== "APPROVED") {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators receive public collections.",
      409,
    );
  }
  const publicId = randomUUID();
  const handle = await uniquePublicHandle(
    creator.displayName || creator.handle,
    publicId,
    database,
  );
  try {
    return await database.creatorCollection.create({
      data: {
        shop,
        creatorId: creator.id,
        publicId,
        publicHandle: handle,
        displayName: publicDisplayName(creator),
        status: "ACTIVE",
      },
    });
  } catch {
    const duplicate = await database.creatorCollection.findUnique({
      where: { creatorId: creator.id },
    });
    if (duplicate) return duplicate;
    throw new DomainError(
      "COLLECTION_CREATE_FAILED",
      "Creator collection could not be created.",
      500,
    );
  }
}

function nativeCollectionUrl(handle: string) {
  return `/collections/${encodeURIComponent(handle)}`;
}

async function publishablePublication(
  shop: string,
  database: CreatorCollectionDb,
) {
  const config = await database.shopConfig?.findUnique({
    where: { shop },
    select: { onlineStorePublicationId: true },
  });
  if (!config?.onlineStorePublicationId) {
    throw new DomainError(
      "ONLINE_STORE_PUBLICATION_REQUIRED",
      "Configure the Online Store publication before publishing creator collections.",
      409,
    );
  }
  return config.onlineStorePublicationId;
}

async function publishResource(
  client: ShopifyGraphqlClient,
  id: string,
  publicationId: string,
  publish: boolean,
) {
  const field = publish ? "publishablePublish" : "publishableUnpublish";
  const result = await client.request<Record<string, { userErrors: Array<{ message: string }> }>>(
    `#graphql mutation NativeCreatorPublication($id: ID!, $input: [PublicationInput!]!) {
      ${field}(id: $id, input: $input) { userErrors { message } }
    }`,
    { id, input: [{ publicationId }] },
  );
  throwUserErrors(result[field].userErrors, "Native creator publication");
}

async function verifyShopifyCollection(
  client: ShopifyGraphqlClient,
  collectionId: string | null | undefined,
) {
  if (!collectionId) return null;
  const result = await client.request<{
    collection: {
      id: string;
      handle: string;
      title: string;
      creatorId: { value: string } | null;
      creatorCollectionId: { value: string } | null;
      collectionType: { value: string } | null;
    } | null;
  }>(
    `#graphql query NativeCreatorCollection($id: ID!) {
      collection(id: $id) {
        id
        handle
        title
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        collectionType: metafield(namespace: "customhouse", key: "collection_type") { value }
      }
    }`,
    { id: collectionId },
  );
  return result.collection;
}

function assertCanonicalCollectionMetafields(
  shopifyCollection: Awaited<ReturnType<typeof verifyShopifyCollection>>,
  collection: CreatorCollectionRecord,
) {
  if (!shopifyCollection) return;
  if (
    shopifyCollection.creatorId?.value &&
    shopifyCollection.creatorId.value !== collection.creatorId
  ) {
    throw new DomainError(
      "CREATOR_COLLECTION_IDENTITY_CONFLICT",
      "Mapped Shopify collection belongs to a different creator.",
      409,
    );
  }
  if (
    shopifyCollection.creatorCollectionId?.value &&
    shopifyCollection.creatorCollectionId.value !== collection.id
  ) {
    throw new DomainError(
      "CREATOR_COLLECTION_IDENTITY_CONFLICT",
      "Mapped Shopify collection belongs to a different creator collection.",
      409,
    );
  }
}

async function setCanonicalCollectionMetafields(
  client: ShopifyGraphqlClient,
  collectionId: string,
  collection: CreatorCollectionRecord,
) {
  const result = await client.request<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation NativeCreatorCollectionMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        {
          ownerId: collectionId,
          namespace: "customhouse",
          key: "creator_id",
          type: "single_line_text_field",
          value: collection.creatorId,
        },
        {
          ownerId: collectionId,
          namespace: "customhouse",
          key: "creator_collection_id",
          type: "single_line_text_field",
          value: collection.id,
        },
        {
          ownerId: collectionId,
          namespace: "customhouse",
          key: "collection_type",
          type: "single_line_text_field",
          value: "creator",
        },
      ],
    },
  );
  throwUserErrors(
    result.metafieldsSet.userErrors,
    "Native creator collection metafields",
  );
}

async function findShopifyCollectionsByCanonicalMetafields(
  client: ShopifyGraphqlClient,
  collection: CreatorCollectionRecord,
) {
  const result = await client.request<{
    byCollection: {
      nodes: Array<{ id: string; handle: string; title: string; creatorId: { value: string } | null; creatorCollectionId: { value: string } | null }>;
    };
    byCreator: {
      nodes: Array<{ id: string; handle: string; title: string; creatorId: { value: string } | null; creatorCollectionId: { value: string } | null }>;
    };
  }>(
    `#graphql query NativeCreatorCollectionRecovery($collectionQuery: String!, $creatorQuery: String!) {
      byCollection: collections(first: 10, query: $collectionQuery) {
        nodes {
          id
          handle
          title
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
      byCreator: collections(first: 10, query: $creatorQuery) {
        nodes {
          id
          handle
          title
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
    }`,
    {
      collectionQuery: `metafields.customhouse.creator_collection_id:${collection.id}`,
      creatorQuery: `metafields.customhouse.creator_id:${collection.creatorId}`,
    },
  );
  const byId = new Map<string, { id: string; handle: string; title: string }>();
  for (const item of [...result.byCollection.nodes, ...result.byCreator.nodes]) {
    if (
      item.creatorCollectionId?.value === collection.id ||
      (item.creatorId?.value === collection.creatorId && !item.creatorCollectionId?.value)
    ) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

export async function getCanonicalShopifyCreatorCollection(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
  database: CreatorCollectionDb = db,
) {
  const collection = await database.creatorCollection.findUnique({
    where: { creatorId },
  });
  if (!collection || collection.shop !== shop || !collection.shopifyCollectionId) {
    throw new DomainError(
      "CANONICAL_COLLECTION_REQUIRED",
      "Creator canonical Shopify collection is not mapped.",
      409,
    );
  }
  const shopifyCollection = await verifyShopifyCollection(
    client,
    collection.shopifyCollectionId,
  );
  if (!shopifyCollection) {
    throw new DomainError(
      "CANONICAL_COLLECTION_MISSING",
      "Mapped Shopify creator collection no longer exists.",
      409,
    );
  }
  assertCanonicalCollectionMetafields(shopifyCollection, collection);
  if (
    shopifyCollection.creatorId?.value !== collection.creatorId ||
    shopifyCollection.creatorCollectionId?.value !== collection.id ||
    shopifyCollection.collectionType?.value !== "creator"
  ) {
    await setCanonicalCollectionMetafields(
      client,
      shopifyCollection.id,
      collection,
    );
  }
  if (shopifyCollection.handle !== collection.shopifyCollectionHandle) {
    return database.creatorCollection.update({
      where: { id: collection.id },
      data: {
        shopifyCollectionHandle: shopifyCollection.handle,
        shopifyCollectionUrl: nativeCollectionUrl(shopifyCollection.handle),
      },
    });
  }
  return collection;
}

export async function ensureShopifyCreatorCollection(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
  database: CreatorCollectionDb = db,
) {
  const collection = await ensureCreatorCollectionRecord(shop, creatorId, database);
  const publicationId = await publishablePublication(shop, database);
  const existing = await verifyShopifyCollection(
    client,
    collection.shopifyCollectionId,
  );
  if (existing) {
    assertCanonicalCollectionMetafields(existing, collection);
    await setCanonicalCollectionMetafields(client, existing.id, collection);
    await publishResource(client, existing.id, publicationId, true);
    const updated = await database.creatorCollection.update({
      where: { id: collection.id },
      data: {
        shopifyCollectionId: existing.id,
        shopifyCollectionHandle: existing.handle,
        shopifyCollectionUrl: nativeCollectionUrl(existing.handle),
        shopifyPublishedAt: new Date(),
      },
    });
    await (database.creator.updateMany || db.creator.updateMany)({
      where: { id: creatorId, shop },
      data: { collectionId: existing.id },
    });
    return updated;
  }

  if (!collection.shopifyCollectionId) {
    const recovered = await findShopifyCollectionsByCanonicalMetafields(
      client,
      collection,
    );
    if (recovered.length > 1) {
      throw new DomainError(
        "CREATOR_COLLECTION_RECOVERY_CONFLICT",
        "Multiple Shopify collections have canonical creator metafields.",
        409,
      );
    }
    if (recovered.length === 1) {
      const match = recovered[0]!;
      await setCanonicalCollectionMetafields(client, match.id, collection);
      await publishResource(client, match.id, publicationId, true);
      const updated = await database.creatorCollection.update({
        where: { id: collection.id },
        data: {
          shopifyCollectionId: match.id,
          shopifyCollectionHandle: match.handle,
          shopifyCollectionUrl: nativeCollectionUrl(match.handle),
          shopifyPublishedAt: new Date(),
        },
      });
      await (database.creator.updateMany || db.creator.updateMany)({
        where: { id: creatorId, shop },
        data: { collectionId: match.id },
      });
      return updated;
    }
  }

  const created = await client.request<{
    collectionCreate: {
      collection: { id: string; handle: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation NativeCreatorCollectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { message }
      }
    }`,
    {
      input: {
        title: collection.displayName,
        handle: collection.publicHandle,
      },
    },
  );
  throwUserErrors(
    created.collectionCreate.userErrors,
    "Native creator collection creation",
  );
  const shopifyCollection = created.collectionCreate.collection;
  if (!shopifyCollection) {
    throw new DomainError(
      "SHOPIFY_COLLECTION_CREATE_FAILED",
      "Creator Shopify collection could not be created.",
      502,
    );
  }

  await setCanonicalCollectionMetafields(client, shopifyCollection.id, collection);
  await publishResource(client, shopifyCollection.id, publicationId, true);
  const updated = await database.creatorCollection.update({
    where: { id: collection.id },
    data: {
      shopifyCollectionId: shopifyCollection.id,
      shopifyCollectionHandle: shopifyCollection.handle,
      shopifyCollectionUrl: nativeCollectionUrl(shopifyCollection.handle),
      shopifyPublishedAt: new Date(),
    },
  });
  await (database.creator.updateMany || db.creator.updateMany)({
    where: { id: creatorId, shop },
    data: { collectionId: shopifyCollection.id },
  });
  return updated;
}

export async function unpublishShopifyCreatorCollection(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
  database: CreatorCollectionDb = db,
) {
  const collection = await database.creatorCollection.findUnique({
    where: { creatorId },
  });
  if (!collection?.shopifyCollectionId) return collection;
  const publicationId = await publishablePublication(shop, database);
  await publishResource(client, collection.shopifyCollectionId, publicationId, false);
  return database.creatorCollection.update({
    where: { id: collection.id },
    data: { shopifyPublishedAt: null },
  });
}

export async function syncCreatorCollectionStatus(
  shop: string,
  creatorId: string,
  database: CreatorCollectionDb = db,
) {
  const existing = await database.creatorCollection.findUnique({
    where: { creatorId },
  });
  if (existing) {
    return ensureCreatorCollectionRecord(shop, creatorId, database);
  }
  const creator = await database.creator.findFirst({
    where: { id: creatorId, shop },
    select: { status: true },
  });
  if (creator?.status === "APPROVED") {
    return ensureCreatorCollectionRecord(shop, creatorId, database);
  }
  return null;
}

export async function getPublicCreatorCollection(
  shop: string,
  publicHandle: string,
  database: CreatorCollectionDb = db,
) {
  const handle = String(publicHandle || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,100}$/.test(handle)) {
    throw new DomainError("COLLECTION_NOT_FOUND", "Creator collection not found.", 404);
  }
  const collection = (await database.creatorCollection.findFirst({
    where: {
      shop,
      publicHandle: handle,
      status: "ACTIVE",
      creator: { status: "APPROVED" },
    },
    select: {
      id: true,
      shop: true,
      creatorId: true,
      publicId: true,
      publicHandle: true,
      displayName: true,
      status: true,
      bannerImageUrl: true,
      bannerTitle: true,
      bannerSubtitle: true,
      bannerUpdatedAt: true,
      shopifyCollectionId: true,
      shopifyCollectionHandle: true,
      shopifyCollectionUrl: true,
      shopifyPublishedAt: true,
      createdAt: true,
      updatedAt: true,
      creator: {
        select: {
          id: true,
          handle: true,
          displayName: true,
          status: true,
          profileImageUrl: true,
          bio: true,
          portfolioUrl: true,
          socialLinksJson: true,
          primaryPlatform: true,
          primaryProfileUrl: true,
        },
      },
    },
  })) as
    | (CreatorCollectionRecord & {
        creator: {
          id: string;
          handle: string;
          displayName: string;
          status: string;
          profileImageUrl: string | null;
          bio: string | null;
          portfolioUrl: string | null;
          socialLinksJson: string | null;
          primaryPlatform: string | null;
          primaryProfileUrl: string | null;
        };
      })
    | null;
  if (!collection) {
    throw new DomainError("COLLECTION_NOT_FOUND", "Creator collection not found.", 404);
  }
  return collection;
}

export async function getCreatorCollectionByCreatorId(
  shop: string,
  creatorId: string,
  database: CreatorCollectionDb = db,
) {
  return database.creatorCollection.findFirst({
    where: { shop, creatorId },
  });
}

export async function backfillApprovedCreatorCollections(
  shop: string,
  database: CreatorCollectionDb = db,
) {
  const creators = await database.creator.findMany?.({
    where: { shop, status: "APPROVED" },
    select: {
      id: true,
      shop: true,
      displayName: true,
      handle: true,
      status: true,
    },
  });
  const approved = creators || [];
  let existing = 0;
  let created = 0;
  for (const creator of approved) {
    const before = await database.creatorCollection.findUnique({
      where: { creatorId: creator.id },
    });
    await ensureCreatorCollectionRecord(shop, creator.id, database);
    if (before) existing += 1;
    else created += 1;
  }
  const total = database.creatorCollection.count
    ? await database.creatorCollection.count({
        where: { shop },
      })
    : existing + created;
  return {
    approvedCreatorsFound: approved.length,
    collectionsExisting: existing,
    collectionsCreated: created,
    totalCollections: total,
    duplicatesPrevented: approved.length - existing - created,
  };
}

import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { validateImageUpload } from "./designer-validation.ts";
import { normalizeCustomerGid } from "./helium-sync.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";

type UserError = { message: string };
type BannerImageMedia = {
  id: string;
  fileStatus: string;
  image?: { url: string } | null;
};

type BannerCollection = {
  id: string;
  shop: string;
  creatorId: string;
  publicHandle: string;
  bannerImageUrl: string | null;
  bannerTitle: string | null;
  bannerSubtitle: string | null;
  bannerUpdatedAt: Date | null;
};

type BannerDb = {
  creator: {
    findUnique(args: unknown): Promise<{
      id: string;
      shop: string;
      customerId: string;
      status: string;
    } | null>;
  };
  creatorCollection: {
    findFirst(args: unknown): Promise<BannerCollection | null>;
    update(args: unknown): Promise<BannerCollection>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
};

export function validateCollectionBannerImage(
  bytes: Uint8Array,
  mimeType: string,
  size: number,
  fileName: string,
) {
  return validateImageUpload(bytes, fileName, mimeType, {
    maximumBytes: 8 * 1024 * 1024,
    minimumWidth: 600,
    minimumHeight: 188,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  });
}

function bannerDiagnostic(
  outcome: "started" | "succeeded" | "failed",
  details: Record<string, unknown>,
) {
  console.info("customhouse_collection_banner", {
    outcome,
    ...details,
  });
}

async function bannerImageUrl(mediaId: string, client: ShopifyGraphqlClient) {
  const result = await client.request<{
    bannerImage: BannerImageMedia | null;
  }>(
    `#graphql query CreatorCollectionBannerImage($id: ID!) {
      bannerImage: node(id: $id) {
        ... on MediaImage {
          id
          fileStatus
          image { url }
        }
      }
    }`,
    { id: mediaId },
  );
  return result.bannerImage?.image?.url || null;
}

async function waitForBannerImageUrl(
  mediaId: string,
  client: ShopifyGraphqlClient,
) {
  const delays = [350, 500, 750, 1000, 1250, 1500, 2000, 2500];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const imageUrl = await bannerImageUrl(mediaId, client);
    if (imageUrl?.startsWith("https://")) {
      bannerDiagnostic("succeeded", {
        stage: "shopify_file_ready",
        mediaId,
        attempt: attempt + 1,
      });
      return imageUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
  return null;
}

export async function uploadCollectionBannerImage(
  file: File,
  client: ShopifyGraphqlClient,
  alt = "Creator collection banner",
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = validateCollectionBannerImage(bytes, file.type, file.size, file.name);
  bannerDiagnostic("started", {
    stage: "shopify_staged_upload",
    filename: file.name.slice(0, 120),
    mimeType: file.type,
    size: file.size,
    width: info.width,
    height: info.height,
  });
  let staged: {
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: UserError[];
    };
  };
  try {
    staged = await client.request(
      `#graphql mutation CreatorCollectionBannerTarget($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { message }
        }
      }`,
      {
        input: [
          {
            resource: "IMAGE",
            filename: file.name.slice(0, 120),
            mimeType: file.type,
            fileSize: String(file.size),
            httpMethod: "POST",
          },
        ],
      },
    );
    throwUserErrors(
      staged.stagedUploadsCreate.userErrors,
      "Collection banner upload preparation",
    );
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "shopify_staged_upload",
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new DomainError(
      "STAGED_UPLOAD_FAILED",
      "Banner image upload could not be prepared.",
      502,
    );
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    bannerDiagnostic("failed", { stage: "shopify_staged_upload", reason: "no_target" });
    throw new DomainError(
      "STAGED_UPLOAD_FAILED",
      "Collection banner upload could not be prepared.",
      502,
    );
  }
  bannerDiagnostic("succeeded", {
    stage: "shopify_staged_upload",
    parameterCount: target.parameters.length,
  });
  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", new Blob([bytes], { type: file.type }), file.name);
  bannerDiagnostic("started", { stage: "binary_upload", size: file.size });
  let upload: Response;
  try {
    upload = await fetch(target.url, { method: "POST", body: form });
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "binary_upload",
      reason: error instanceof Error ? error.message : "network_error",
    });
    throw new DomainError(
      "STAGED_BINARY_UPLOAD_FAILED",
      "Banner image upload failed.",
      502,
    );
  }
  if (!upload.ok) {
    bannerDiagnostic("failed", {
      stage: "binary_upload",
      status: upload.status,
      statusText: upload.statusText,
    });
    throw new DomainError(
      "STAGED_BINARY_UPLOAD_FAILED",
      "Collection banner upload failed.",
      502,
    );
  }
  bannerDiagnostic("succeeded", { stage: "binary_upload", status: upload.status });
  bannerDiagnostic("started", { stage: "shopify_file_create" });
  let created: {
    fileCreate: { files: BannerImageMedia[]; userErrors: UserError[] };
  };
  try {
    created = await client.request(
      `#graphql mutation CreatorCollectionBannerCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            ... on MediaImage {
              id
              fileStatus
              image { url }
            }
          }
          userErrors { message }
        }
      }`,
      {
        files: [
          {
            originalSource: target.resourceUrl,
            contentType: "IMAGE",
            alt: cleanBannerText(alt, 120) || "Creator collection banner",
          },
        ],
      },
    );
    throwUserErrors(created.fileCreate.userErrors, "Collection banner creation");
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "shopify_file_create",
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new DomainError(
      "SHOPIFY_FILE_CREATE_FAILED",
      "Banner image could not be created in Shopify.",
      502,
    );
  }
  const media = created.fileCreate.files[0];
  if (!media) {
    bannerDiagnostic("failed", { stage: "shopify_file_create", reason: "no_media" });
    throw new DomainError(
      "SHOPIFY_FILE_CREATE_FAILED",
      "Shopify did not create the collection banner image.",
      502,
    );
  }
  bannerDiagnostic("succeeded", {
    stage: "shopify_file_create",
    mediaId: media.id,
    fileStatus: media.fileStatus,
    hasImmediateUrl: Boolean(media.image?.url),
  });
  const bannerImageUrl =
    media.image?.url || (await waitForBannerImageUrl(media.id, client));
  if (!bannerImageUrl?.startsWith("https://")) {
    bannerDiagnostic("failed", {
      stage: "shopify_file_ready",
      mediaId: media.id,
      fileStatus: media.fileStatus,
    });
    throw new DomainError(
      "SHOPIFY_FILE_NOT_READY",
      "Banner image is still processing. Please try again in a moment.",
      502,
    );
  }
  return {
    bannerImageId: media.id,
    bannerImageUrl,
    status: media.fileStatus,
  };
}

function cleanBannerText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const withoutControlCharacters = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const normalized = withoutControlCharacters.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function approvedCreatorCollection(
  input: {
    shop: string;
    customerId: string;
    database?: BannerDb;
  },
) {
  const database = input.database || db;
  const customerId = normalizeCustomerGid(input.customerId);
  const creator = await database.creator.findUnique({
    where: {
      shop_customerId: {
        shop: input.shop,
        customerId,
      },
    },
  });
  if (!creator) {
    throw new DomainError(
      "CREATOR_NOT_FOUND",
      "Creator profile not found.",
      404,
    );
  }
  if (creator.status !== "APPROVED") {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can manage a collection banner.",
      403,
    );
  }
  const collection = await database.creatorCollection.findFirst({
    where: {
      shop: input.shop,
      creatorId: creator.id,
    },
  });
  if (!collection) {
    throw new DomainError(
      "CREATOR_COLLECTION_NOT_FOUND",
      "Creator collection not found.",
      404,
    );
  }
  return { database, customerId, creator, collection };
}

export async function creatorCollectionBannerForCustomer(input: {
  shop: string;
  customerId: string;
  database?: BannerDb;
}) {
  const { collection } = await approvedCreatorCollection(input);
  return collection;
}

export async function updateCreatorCollectionBanner(input: {
  shop: string;
  customerId: string;
  title?: unknown;
  subtitle?: unknown;
  bannerImageUrl?: unknown;
  database?: BannerDb;
}) {
  const { database, customerId, creator, collection } =
    await approvedCreatorCollection(input);
  const nextImageUrl = cleanHttpsUrl(input.bannerImageUrl);
  let updated: BannerCollection;
  try {
    updated = await database.creatorCollection.update({
      where: { id: collection.id },
      data: {
        ...(nextImageUrl !== undefined ? { bannerImageUrl: nextImageUrl } : {}),
        bannerTitle: cleanBannerText(input.title, 120),
        bannerSubtitle: cleanBannerText(input.subtitle, 500),
        bannerUpdatedAt: new Date(),
      },
    });
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "database_update",
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new DomainError(
      "DATABASE_UPDATE_FAILED",
      "Collection banner could not be saved.",
      500,
    );
  }
  try {
    await database.auditLog?.create({
      data: {
        shop: input.shop,
        actorType: "CUSTOMER",
        actorId: customerId,
        action: "creator_collection.banner.updated",
        entityType: "CreatorCollection",
        entityId: collection.id,
        beforeJson: safeJson({
          hasBanner: Boolean(collection.bannerImageUrl),
          titlePresent: Boolean(collection.bannerTitle),
          subtitlePresent: Boolean(collection.bannerSubtitle),
        }),
        afterJson: safeJson({
          creatorId: creator.id,
          hasBanner: Boolean(updated.bannerImageUrl),
          titlePresent: Boolean(updated.bannerTitle),
          subtitlePresent: Boolean(updated.bannerSubtitle),
        }),
      },
    });
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "audit_log",
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return updated;
}

export async function removeCreatorCollectionBanner(input: {
  shop: string;
  customerId: string;
  database?: BannerDb;
}) {
  const { database, customerId, collection } =
    await approvedCreatorCollection(input);
  let updated: BannerCollection;
  try {
    updated = await database.creatorCollection.update({
      where: { id: collection.id },
      data: {
        bannerImageUrl: null,
        bannerTitle: null,
        bannerSubtitle: null,
        bannerUpdatedAt: null,
      },
    });
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "database_update",
      action: "remove",
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new DomainError(
      "DATABASE_UPDATE_FAILED",
      "Collection banner could not be removed.",
      500,
    );
  }
  try {
    await database.auditLog?.create({
      data: {
        shop: input.shop,
        actorType: "CUSTOMER",
        actorId: customerId,
        action: "creator_collection.banner.removed",
        entityType: "CreatorCollection",
        entityId: collection.id,
        beforeJson: safeJson({
          hasBanner: Boolean(collection.bannerImageUrl),
          titlePresent: Boolean(collection.bannerTitle),
          subtitlePresent: Boolean(collection.bannerSubtitle),
        }),
      },
    });
  } catch (error) {
    bannerDiagnostic("failed", {
      stage: "audit_log",
      action: "remove",
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
  return updated;
}

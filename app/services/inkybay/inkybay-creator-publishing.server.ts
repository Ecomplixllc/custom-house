import { createHash, randomUUID } from "node:crypto";
import db from "../../db.server";
import { DomainError, parseJsonList, safeJson, slugify } from "../domain";
import { validateImageUpload } from "../designer-validation";
import { designerPublishKey } from "../designer-publishing";
import { storeDesignerImage } from "../designer-storage.server";
import { normalizeCustomerGid } from "../helium-sync.server";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server";
import type { TrustedStorefrontActor } from "../storefront-actor.server";
import { synchronizeCreatorDesign } from "../designer-publishing.server";
import {
  getInkyBayFeatureFlags,
  getInkyBayLimits,
} from "./inkybay-config.server";
import { verifyInkyBayGlobalProduct } from "./inkybay-product.server";
import {
  signInkyBaySessionToken,
  verifyInkyBaySessionToken,
} from "./inkybay-session-token.server";
import {
  parseCompatibleVariantIds,
  parseInkyBaySavedDesign,
  validateProductionArtwork,
} from "./inkybay-validation";
import { storePrivateProductionArtwork } from "./private-storage.server";
import {
  canRunPreviewMutation,
  isPreviewRuntime,
} from "../environment-safety.server";

const ACTIVE_SESSION_STATUSES = [
  "CREATED",
  "DESIGNING",
  "WAITING_FOR_SAVED_DESIGN",
  "WAITING_FOR_ASSETS",
  "READY_TO_PUBLISH",
  "PUBLISHING",
] as const;

function requireManualBridge() {
  const flags = getInkyBayFeatureFlags();
  if (!flags.creatorPublishing || !flags.manualBridge) {
    throw new DomainError(
      "INKYBAY_CREATOR_PUBLISHING_DISABLED",
      "Creator publishing is not currently available.",
      404,
    );
  }
  return flags;
}

function validateIdempotencyKey(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_INVALID",
      "Start the creator publishing flow again.",
      422,
    );
  }
  return key;
}

function sessionKey(input: {
  shop: string;
  creatorId: string;
  productId: string;
  variantId: string;
  key: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.shop,
        input.creatorId,
        input.productId,
        input.variantId,
        validateIdempotencyKey(input.key),
      ].join("\n"),
    )
    .digest("hex");
}

function safeHosts(shop: string, configured: string) {
  const customDomain = process.env.SHOP_CUSTOM_DOMAIN?.trim().toLowerCase();
  return [
    ...parseJsonList(configured),
    shop.toLowerCase(),
    ...(customDomain ? [customDomain] : []),
    "pitchprint.com",
  ].filter((host) => /^[a-z0-9.-]+$/.test(host));
}

function workspaceUrl(sessionId: string, token: string) {
  return `/apps/customhouse/creator-design/session/${encodeURIComponent(
    sessionId,
  )}?session_token=${encodeURIComponent(token)}`;
}

export async function startInkyBayCreatorSession(input: {
  actor: TrustedStorefrontActor;
  client: ShopifyGraphqlClient;
  productId: string;
  variantId: string;
  idempotencyKey: string;
}) {
  requireManualBridge();
  if (
    !input.actor.customerId ||
    !input.actor.creatorId ||
    !input.actor.isApprovedCreator ||
    input.actor.isSuspendedCreator
  ) {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can create collection designs.",
      403,
    );
  }
  const customerId = normalizeCustomerGid(input.actor.customerId);
  const product = await verifyInkyBayGlobalProduct(
    input.client,
    input.productId,
    input.variantId,
  );
  const key = sessionKey({
    shop: input.actor.shop,
    creatorId: input.actor.creatorId,
    productId: product.id,
    variantId: input.variantId,
    key: input.idempotencyKey,
  });
  const limits = getInkyBayLimits();
  const expiresAt = new Date(Date.now() + limits.sessionTtlSeconds * 1_000);
  let session = await db.designSession.findUnique({
    where: {
      shop_idempotencyKey: {
        shop: input.actor.shop,
        idempotencyKey: key,
      },
    },
  });
  if (session) {
    if (
      session.customerId !== customerId ||
      session.creatorId !== input.actor.creatorId ||
      session.provider !== "INKYBAY"
    ) {
      throw new DomainError(
        "CREATOR_DESIGN_SESSION_CONFLICT",
        "A conflicting creator design session already exists.",
        409,
      );
    }
  } else {
    try {
      session = await db.$transaction(async (tx) => {
        const created = await tx.designSession.create({
          data: {
            shop: input.actor.shop,
            customerId,
            creatorId: input.actor.creatorId,
            clientKey: key,
            idempotencyKey: key,
            shopifyProductId: product.id,
            shopifyVariantId: input.variantId,
            mode: "CREATOR_PUBLISH",
            provider: "INKYBAY",
            publishMode: "MANUAL_BRIDGE",
            designJson: safeJson({
              provider: "INKYBAY",
              mode: "MANUAL_BRIDGE",
            }),
            status: "CREATED",
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            shop: input.actor.shop,
            actorType: "CREATOR",
            actorId: customerId,
            action: "inkybay_session.created",
            entityType: "DesignSession",
            entityId: created.id,
            afterJson: safeJson({
              productId: product.id,
              variantId: input.variantId,
            }),
          },
        });
        return created;
      });
    } catch (error) {
      if (!(
        error instanceof Error && error.message.includes("Unique constraint")
      )) {
        throw error;
      }
      session = await db.designSession.findUnique({
        where: {
          shop_idempotencyKey: {
            shop: input.actor.shop,
            idempotencyKey: key,
          },
        },
      });
      if (!session) throw error;
    }
  }
  const token = signInkyBaySessionToken(
    {
      sessionId: session.id,
      shop: input.actor.shop,
      customerId,
      creatorId: input.actor.creatorId,
    },
    limits.sessionTtlSeconds,
  );
  return {
    sessionId: session.id,
    sessionToken: token,
    workspaceUrl: workspaceUrl(session.id, token),
    status: session.status,
  };
}

export function sessionTokenFromRequest(request: Request) {
  return (
    request.headers.get("x-customhouse-session-token") ||
    new URL(request.url).searchParams.get("session_token") ||
    ""
  );
}

export async function requireOwnedInkyBaySession(input: {
  actor: TrustedStorefrontActor;
  sessionId: string;
  token: string;
}) {
  const payload = verifyInkyBaySessionToken(input.token);
  const customerId = input.actor.customerId
    ? normalizeCustomerGid(input.actor.customerId)
    : "";
  if (
    payload.sessionId !== input.sessionId ||
    payload.shop !== input.actor.shop ||
    payload.customerId !== customerId ||
    payload.creatorId !== input.actor.creatorId
  ) {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_FORBIDDEN",
      "This creator design session is not available to this account.",
      403,
    );
  }
  if (!input.actor.isApprovedCreator || input.actor.isSuspendedCreator) {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can use this publishing session.",
      403,
    );
  }
  const session = await db.designSession.findFirst({
    where: {
      id: input.sessionId,
      shop: input.actor.shop,
      customerId,
      creatorId: input.actor.creatorId,
      provider: "INKYBAY",
      mode: "CREATOR_PUBLISH",
    },
    include: { creatorDesign: true },
  });
  if (!session) {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_NOT_FOUND",
      "The creator design session was not found.",
      404,
    );
  }
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
    if (
      ACTIVE_SESSION_STATUSES.includes(
        session.status as (typeof ACTIVE_SESSION_STATUSES)[number],
      )
    ) {
      await db.designSession.update({
        where: { id: session.id },
        data: { status: "EXPIRED" },
      });
    }
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_EXPIRED",
      "The creator design session has expired. Start a new session.",
      410,
    );
  }
  return session;
}

export async function inkyBaySessionView(input: {
  actor: TrustedStorefrontActor;
  client: ShopifyGraphqlClient;
  sessionId: string;
  token: string;
}) {
  const session = await requireOwnedInkyBaySession(input);
  const [product, creator, shopConfig] = await Promise.all([
    verifyInkyBayGlobalProduct(
      input.client,
      session.shopifyProductId,
      session.shopifyVariantId,
    ),
    db.creator.findUniqueOrThrow({ where: { id: session.creatorId! } }),
    db.shopConfig.findUnique({ where: { shop: session.shop } }),
  ]);
  return {
    id: session.id,
    status: session.status,
    publishMode: session.publishMode,
    expiresAt: session.expiresAt,
    savedDesignUrl: session.inkybaySavedDesignUrl,
    tid: session.inkybayTid,
    title: session.title,
    description: session.description,
    previewUrl: session.previewUrl,
    productionArtworkReady: Boolean(session.productionArtworkKey),
    compatibleVariantIds: (() => {
      try {
        const value = JSON.parse(session.selectedAttributesJson || "[]");
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
      } catch {
        return [];
      }
    })(),
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      imageUrl: product.imageUrl,
      selectedVariantId: session.shopifyVariantId,
      variants: product.variants,
      inkyBayProductUrl: `/products/${encodeURIComponent(product.handle)}`,
    },
    creator: {
      displayName: creator.displayName,
      collectionUrl: creator.collectionId
        ? `/collections/${encodeURIComponent(creator.handle)}-${encodeURIComponent(
            slugify(shopConfig?.collectionHandleSuffix || "designs"),
          )}`
        : null,
    },
  };
}

export async function saveInkyBaySessionDetails(input: {
  actor: TrustedStorefrontActor;
  client: ShopifyGraphqlClient;
  sessionId: string;
  token: string;
  savedDesignUrl: string;
  tid?: string | null;
  title: string;
  description?: string | null;
  compatibleVariantIds: unknown;
}) {
  requireManualBridge();
  const session = await requireOwnedInkyBaySession(input);
  const [config, product] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop: session.shop } }),
    verifyInkyBayGlobalProduct(
      input.client,
      session.shopifyProductId,
      session.shopifyVariantId,
    ),
  ]);
  const saved = parseInkyBaySavedDesign({
    savedDesignUrl: input.savedDesignUrl,
    tid: input.tid,
    allowedHosts: safeHosts(
      session.shop,
      config?.inkybayAllowedHostsJson || "[]",
    ),
  });
  const title = input.title.trim();
  if (title.length < 2 || title.length > 120) {
    throw new DomainError(
      "DESIGN_TITLE_INVALID",
      "Enter a design title between 2 and 120 characters.",
      422,
    );
  }
  const description = input.description?.trim() || null;
  if (description && description.length > 2_000) {
    throw new DomainError(
      "DESIGN_DESCRIPTION_INVALID",
      "Keep the design description under 2,000 characters.",
      422,
    );
  }
  const compatibleVariantIds = parseCompatibleVariantIds(
    input.compatibleVariantIds,
    product.variants
      .filter((variant) => variant.availableForSale)
      .map((variant) => variant.id),
  );
  const status =
    session.previewUrl && session.productionArtworkKey
      ? "READY_TO_PUBLISH"
      : "WAITING_FOR_ASSETS";
  return db.designSession.update({
    where: { id: session.id },
    data: {
      inkybaySavedDesignUrl: saved.savedDesignUrl,
      inkybayTid: saved.tid,
      title,
      description,
      selectedAttributesJson: JSON.stringify(compatibleVariantIds),
      status,
      lastErrorCode: null,
      lastErrorReference: null,
    },
  });
}

export async function uploadInkyBaySessionAssets(input: {
  actor: TrustedStorefrontActor;
  client: ShopifyGraphqlClient;
  sessionId: string;
  token: string;
  preview: File;
  productionArtwork: File;
}) {
  requireManualBridge();
  const session = await requireOwnedInkyBaySession(input);
  const limits = getInkyBayLimits();
  const previewBytes = new Uint8Array(await input.preview.arrayBuffer());
  const previewInfo = validateImageUpload(
    previewBytes,
    input.preview.name,
    input.preview.type,
    {
      maximumBytes: 10 * 1024 * 1024,
      minimumWidth: 600,
      minimumHeight: 600,
      allowedTypes: ["image/png", "image/jpeg", "image/webp"],
    },
  );
  const artworkBytes = new Uint8Array(
    await input.productionArtwork.arrayBuffer(),
  );
  const artworkInfo = validateProductionArtwork(
    artworkBytes,
    input.productionArtwork.name,
    input.productionArtwork.type,
    {
      maximumBytes: limits.productionMaximumBytes,
      minimumWidth: limits.productionMinimumWidth,
      minimumHeight: limits.productionMinimumHeight,
    },
  );
  const [storedPreview, storedArtwork] = await Promise.all([
    storeDesignerImage(input.client, {
      bytes: previewBytes,
      fileName: `creator-preview-${session.id}.${previewInfo.mimeType.split("/")[1]}`,
      mimeType: previewInfo.mimeType,
      alt: "Creator design public preview",
    }),
    storePrivateProductionArtwork({
      shop: session.shop,
      creatorId: session.creatorId!,
      sessionId: session.id,
      bytes: artworkBytes,
      mimeType: artworkInfo.mimeType,
      extension: artworkInfo.extension,
    }),
  ]);
  const status =
    session.inkybaySavedDesignUrl &&
    session.inkybayTid &&
    session.title &&
    Boolean(session.selectedAttributesJson) &&
    session.selectedAttributesJson !== "[]"
      ? "READY_TO_PUBLISH"
      : "WAITING_FOR_SAVED_DESIGN";
  return db.designSession.update({
    where: { id: session.id },
    data: {
      previewUrl: storedPreview.url,
      artworkUrl: "private://stored",
      productionArtworkKey: storedArtwork.key,
      status,
      lastErrorCode: null,
      lastErrorReference: null,
    },
  });
}

export async function publishInkyBayCreatorDesign(input: {
  actor: TrustedStorefrontActor;
  client: ShopifyGraphqlClient;
  sessionId: string;
  token: string;
}) {
  requireManualBridge();
  const session = await requireOwnedInkyBaySession(input);
  if (
    isPreviewRuntime() &&
    !canRunPreviewMutation({
      shop: session.shop,
      resourceType: "product",
      resourceId: session.shopifyProductId,
    })
  ) {
    throw new DomainError(
      "PREVIEW_PRODUCT_MUTATION_DENIED",
      "Creator product publishing is not enabled for this Preview product.",
      403,
    );
  }
  if (
    !session.inkybaySavedDesignUrl ||
    !session.inkybayTid ||
    !session.title ||
    !session.previewUrl ||
    !session.productionArtworkKey ||
    !session.selectedAttributesJson ||
    session.selectedAttributesJson === "[]"
  ) {
    throw new DomainError(
      "CREATOR_DESIGN_NOT_READY",
      "Add the saved design, public preview, production artwork and product options before publishing.",
      409,
    );
  }
  if (session.status === "PUBLISHING") {
    throw new DomainError(
      "DESIGN_PUBLISH_IN_PROGRESS",
      "This design is already being published.",
      409,
    );
  }
  if (
    session.creatorDesign &&
    session.creatorDesign.status === "ACTIVE" &&
    session.creatorDesign.syncStatus === "SYNCED"
  ) {
    return session.creatorDesign;
  }
  const claim = await db.designSession.updateMany({
    where: {
      id: session.id,
      status: { in: ["READY_TO_PUBLISH", "FAILED"] },
    },
    data: {
      status: "PUBLISHING",
      lastErrorCode: null,
      lastErrorReference: null,
    },
  });
  if (claim.count !== 1) {
    throw new DomainError(
      "CREATOR_DESIGN_NOT_READY",
      "This design is not ready to publish.",
      409,
    );
  }
  let design = session.creatorDesign;
  const idempotencyKey = designerPublishKey(
    session.shop,
    session.creatorId!,
    session.id,
  );
  try {
    if (design) {
      design = await db.creatorDesign.update({
        where: { id: design.id },
        data: {
          title: session.title!,
          description: session.description,
          previewUrl: session.previewUrl!,
          artworkUrl: "private://stored",
          productionArtworkKey: session.productionArtworkKey,
          inkybaySavedDesignUrl: session.inkybaySavedDesignUrl,
          inkybayTid: session.inkybayTid,
          compatibleVariantIdsJson: session.selectedAttributesJson || "[]",
          status: "PROCESSING",
          syncStatus: "SYNCING",
          publishError: null,
          lastErrorCode: null,
          lastErrorReference: null,
          ...(isPreviewRuntime()
            ? {
                previewPoc: true,
                previewOwnerApp: "customhouse-dev-800679",
              }
            : {}),
        },
      });
    } else {
      design = await db.creatorDesign.create({
        data: {
          shop: session.shop,
          creatorId: session.creatorId!,
          designSessionId: session.id,
          provider: "INKYBAY",
          globalShopifyProductId: session.shopifyProductId,
          inkybaySavedDesignUrl: session.inkybaySavedDesignUrl,
          inkybayTid: session.inkybayTid,
          title: session.title!,
          slug: `${slugify(session.title!)}-${session.inkybayTid!.slice(-8).toLowerCase()}`,
          description: session.description,
          previewUrl: session.previewUrl!,
          artworkUrl: "private://stored",
          productionArtworkKey: session.productionArtworkKey,
          designJson: safeJson({
            provider: "INKYBAY",
            publishMode: session.publishMode,
            tid: session.inkybayTid,
          }),
          compatibleVariantIdsJson: session.selectedAttributesJson || "[]",
          selectedAttributesJson: session.selectedAttributesJson || "[]",
          status: "PROCESSING",
          syncStatus: "SYNCING",
          idempotencyKey,
          ...(isPreviewRuntime()
            ? {
                previewPoc: true,
                previewOwnerApp: "customhouse-dev-800679",
              }
            : {}),
        },
      });
    }
    return await synchronizeCreatorDesign(
      session.shop,
      design.id,
      input.client,
    );
  } catch (error) {
    const referenceId = randomUUID();
    await db.designSession.update({
      where: { id: session.id },
      data: {
        status: "FAILED",
        lastErrorCode: "INKYBAY_CREATOR_PUBLISH_FAILED",
        lastErrorReference: referenceId,
      },
    });
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "INKYBAY_CREATOR_PUBLISH_FAILED",
      "Your design was saved, but we could not publish the product. You can retry from your dashboard.",
      502,
    );
  }
}

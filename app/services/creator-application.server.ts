import { Prisma, type Creator, type CreatorStatus } from "@prisma/client";
import db from "../db.server";
import {
  DomainError,
  safeJson,
  slugify,
  statusTags,
} from "./domain";
import {
  CREATOR_CATEGORIES,
  CREATOR_PLATFORMS,
  validateCreatorApplication,
  type CreatorApplicationInput,
} from "./creator-application";
import { normalizeCustomerGid } from "./helium-sync.server";
import { ensureShopifyCreatorCollection } from "./creator-collections.server";
import {
  normalizeReferralCodeForLookup,
  referralFieldsForCode,
  resolveReferralCode,
} from "./creator-referral.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";
import { sendCreatorWelcomeEmail } from "./creator-welcome-email.server";

export type CreatorApplicationState =
  | { state: "LOGGED_OUT"; loggedIn: false }
  | { state: "NOT_APPLIED"; loggedIn: true; customer: CustomerSnapshot; options: FormOptions; referral: ApplicationReferralView }
  | { state: "PENDING"; loggedIn: true; application: CreatorApplicationView }
  | { state: "REJECTED"; loggedIn: true; application: CreatorApplicationView; options: FormOptions; referral: ApplicationReferralView }
  | { state: "APPROVED"; loggedIn: true; creator: CreatorView }
  | { state: "SUSPENDED"; loggedIn: true; creator: CreatorView };

type CustomerSnapshot = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

type FormOptions = {
  platforms: readonly string[];
  audienceRanges: readonly string[];
  categories: readonly string[];
};

type ApplicationReferralView = {
  source: "ATTRIBUTION" | "CREATOR_RELATION" | null;
  code: string | null;
  referrerName: string | null;
  locked: boolean;
};

type CreatorApplicationView = {
  id: string;
  displayName: string | null;
  emailSnapshot: string | null;
  bio: string | null;
  country: string | null;
  primaryPlatform: string | null;
  primaryProfileUrl: string | null;
  audienceRange: string | null;
  categories: string[];
  portfolioUrl: string | null;
  aboutWork: string | null;
  status: CreatorStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
};

type CreatorView = {
  id: string;
  displayName: string;
  handle: string;
  status: string;
};

type ReferralAttributionRecord = {
  id: string;
  status: "CAPTURED" | "CONVERTED" | "VOID";
  referrerCreatorId: string;
  referralCodeSnapshot: string;
  referrerCreator: {
    id: string;
    displayName: string;
    referralCode: string;
    customerId: string;
  } | null;
} | null;

type CreatorReferralRecord = Creator & {
  referredByCreator?: {
    id: string;
    displayName: string;
    referralCode: string;
  } | null;
};

type ApplicationReferralDatabase = {
  creator: {
    findFirst(args: unknown): Promise<{
      id: string;
      referralCode: string;
      status: CreatorStatus;
      displayName: string;
      customerId?: string;
    } | null>;
  };
  referralAttribution: {
    findUnique(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
};

const FORM_OPTIONS: FormOptions = {
  platforms: CREATOR_PLATFORMS,
  audienceRanges: [
    "Under 1K",
    "1K-10K",
    "10K-50K",
    "50K-100K",
    "100K-500K",
    "500K+",
  ],
  categories: CREATOR_CATEGORIES,
};

function submitStage(stage: string, details: Record<string, unknown> = {}) {
  console.info("creator_application_submit_stage", {
    stage,
    ...details,
  });
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    const maybeMeta = (error as { meta?: unknown }).meta;
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, 500),
      prismaCode: typeof maybeCode === "string" ? maybeCode : null,
      metaKeys:
        maybeMeta && typeof maybeMeta === "object"
          ? Object.keys(maybeMeta as Record<string, unknown>).slice(0, 20)
          : [],
    };
  }
  return {
    errorName: typeof error,
    errorMessage: "Non-Error exception",
    prismaCode: null,
    metaKeys: [],
  };
}

function parseJsonList(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function creatorApplicationView(creator: Creator): CreatorApplicationView {
  return {
    id: creator.id,
    displayName: creator.displayName,
    emailSnapshot: creator.emailSnapshot,
    bio: creator.bio,
    country: creator.country,
    primaryPlatform: creator.primaryPlatform,
    primaryProfileUrl: creator.primaryProfileUrl,
    audienceRange: creator.audienceRange,
    categories: parseJsonList(creator.categoriesJson),
    portfolioUrl: creator.portfolioUrl,
    aboutWork: creator.aboutWork,
    status: creator.status,
    submittedAt: creator.submittedAt?.toISOString() || null,
    reviewedAt: creator.reviewedAt?.toISOString() || null,
    rejectionReason: creator.rejectionReason,
  };
}

function creatorView(creator: Creator): CreatorView {
  return {
    id: creator.id,
    displayName: creator.displayName,
    handle: creator.handle,
    status: creator.status,
  };
}

function emptyReferralView(): ApplicationReferralView {
  return {
    source: null,
    code: null,
    referrerName: null,
    locked: false,
  };
}

function referralView(
  creator: CreatorReferralRecord | null,
  attribution: ReferralAttributionRecord,
): ApplicationReferralView {
  if (creator?.referredByCreatorId) {
    const code =
      attribution?.referrerCreatorId === creator.referredByCreatorId
        ? attribution.referralCodeSnapshot
        : creator.referredByCreator?.referralCode;
    return {
      source: "CREATOR_RELATION",
      code: code || null,
      referrerName: creator.referredByCreator?.displayName || null,
      locked: true,
    };
  }
  if (attribution?.status === "CAPTURED") {
    return {
      source: "ATTRIBUTION",
      code: attribution.referralCodeSnapshot,
      referrerName: attribution.referrerCreator?.displayName || null,
      locked: true,
    };
  }
  return emptyReferralView();
}

function referralValidationError() {
  return new DomainError(
    "INVALID_REFERRAL_CODE",
    "Enter a valid creator referral code or leave it blank.",
    422,
  );
}

function selfReferralError() {
  return new DomainError(
    "SELF_REFERRAL_NOT_ALLOWED",
    "You cannot use your own creator referral code.",
    422,
  );
}

async function fetchCustomerSnapshot(
  client: ShopifyGraphqlClient,
  customerId: string,
) {
  const result = await client.request<{
    customer: CustomerSnapshot | null;
  }>(
    `#graphql query NativeCreatorApplicationCustomer($id: ID!) {
      customer(id: $id) { id email firstName lastName }
    }`,
    { id: customerId },
  );
  if (!result.customer) {
    throw new DomainError(
      "CUSTOMER_NOT_FOUND",
      "The Shopify customer account could not be verified.",
      409,
    );
  }
  return result.customer;
}

export async function getCreatorApplicationState(
  shop: string,
  customerId: string | null,
  client: ShopifyGraphqlClient,
): Promise<CreatorApplicationState> {
  if (!customerId) return { state: "LOGGED_OUT", loggedIn: false };
  const shopifyCustomerId = normalizeCustomerGid(customerId);
  const [customer, creator] = await Promise.all([
    fetchCustomerSnapshot(client, shopifyCustomerId),
    db.creator.findUnique({
      where: { shop_customerId: { shop, customerId: shopifyCustomerId } },
      include: {
        referredByCreator: {
          select: { id: true, displayName: true, referralCode: true },
        },
      },
    }),
  ]);
  const attribution = await db.referralAttribution.findUnique({
    where: {
      shop_shopifyCustomerId: { shop, shopifyCustomerId },
    },
    include: {
      referrerCreator: {
        select: {
          id: true,
          displayName: true,
          referralCode: true,
          customerId: true,
        },
      },
    },
  });
  const referral = referralView(creator, attribution);

  if (!creator) {
    return {
      state: "NOT_APPLIED",
      loggedIn: true,
      customer,
      options: FORM_OPTIONS,
      referral,
    };
  }
  if (creator.status === "APPROVED") {
    return { state: "APPROVED", loggedIn: true, creator: creatorView(creator) };
  }
  if (creator.status === "SUSPENDED") {
    return { state: "SUSPENDED", loggedIn: true, creator: creatorView(creator) };
  }
  if (creator.status === "REJECTED") {
    return {
      state: "REJECTED",
      loggedIn: true,
      application: creatorApplicationView(creator),
      options: FORM_OPTIONS,
      referral,
    };
  }
  return { state: "PENDING", loggedIn: true, application: creatorApplicationView(creator) };
}

function requireNativeFields(input: CreatorApplicationInput) {
  if (!input.categories?.length) {
    throw new DomainError("CATEGORIES_REQUIRED", "Choose at least one creator category.");
  }
  if (!input.accuracyConfirmed) {
    throw new DomainError("ACCURACY_REQUIRED", "Confirm the application details are accurate.");
  }
}

async function syncCustomerStatus(
  customerId: string,
  status: "PENDING" | "APPROVED" | "REJECTED",
  client: ShopifyGraphqlClient,
) {
  const customer = await client.request<{
    customer: { tags: string[] } | null;
  }>(
    `#graphql query NativeCreatorApplicationTags($id: ID!) { customer(id: $id) { tags } }`,
    { id: customerId },
  );
  if (!customer.customer) {
    throw new DomainError("CUSTOMER_NOT_FOUND", "The Shopify customer account could not be verified.", 409);
  }
  const update = await client.request<{
    customerUpdate: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation NativeCreatorApplicationTagSync($input: CustomerInput!) {
      customerUpdate(input: $input) { userErrors { message } }
    }`,
    { input: { id: customerId, tags: statusTags(customer.customer.tags, status) } },
  );
  throwUserErrors(update.customerUpdate.userErrors, "Creator application tag sync");

  const mirror = await client.request<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation NativeCreatorApplicationStatus($metafields: [MetafieldsSetInput!]!) {
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
  throwUserErrors(mirror.metafieldsSet.userErrors, "Creator status mirror");
}

async function uniqueCreatorHandle(shop: string, displayName: string, customerId: string) {
  const base = slugify(displayName);
  let handle = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const existing = await db.creator.findFirst({
      where: { shop, handle, NOT: { customerId } },
      select: { id: true },
    });
    if (!existing) return handle;
    handle = `${base}-${suffix}`;
  }
  throw new DomainError("CREATOR_HANDLE_UNAVAILABLE", "A unique creator handle could not be generated.", 409);
}

async function findApplicationAttribution(
  tx: ApplicationReferralDatabase,
  shop: string,
  shopifyCustomerId: string,
) {
  return (await tx.referralAttribution.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
    include: {
      referrerCreator: {
        select: {
          id: true,
          displayName: true,
          referralCode: true,
          customerId: true,
        },
      },
    },
  })) as ReferralAttributionRecord;
}

async function resolveFirstApplicationReferral(
  tx: ApplicationReferralDatabase,
  input: {
    shop: string;
    shopifyCustomerId: string;
    manualReferralCode?: string;
    now: Date;
  },
) {
  const attribution = await findApplicationAttribution(
    tx,
    input.shop,
    input.shopifyCustomerId,
  );
  if (attribution) {
    if (!attribution.referrerCreator) throw referralValidationError();
    if (attribution.referrerCreator.customerId === input.shopifyCustomerId) {
      throw selfReferralError();
    }
    return {
      referrerCreatorId: attribution.referrerCreatorId,
      referralCodeSnapshot: attribution.referralCodeSnapshot,
      attributionId: attribution.id,
      source: "ATTRIBUTION" as const,
    };
  }

  const manualCode = String(input.manualReferralCode || "").trim();
  if (!manualCode) return null;
  if (!normalizeReferralCodeForLookup(manualCode)) throw referralValidationError();

  const referrer = await resolveReferralCode(
    { shop: input.shop, code: manualCode },
    { creator: tx.creator },
  );
  if (!referrer || referrer.creatorStatus !== "APPROVED") {
    throw referralValidationError();
  }
  const referrerRecord = (await tx.creator.findFirst({
    where: { id: referrer.creatorId, shop: input.shop },
    select: { id: true, customerId: true },
  })) as { id: string; customerId: string } | null;
  if (!referrerRecord) throw referralValidationError();
  if (referrerRecord.customerId === input.shopifyCustomerId) {
    throw selfReferralError();
  }

  try {
    const created = (await tx.referralAttribution.create({
      data: {
        shop: input.shop,
        shopifyCustomerId: input.shopifyCustomerId,
        referrerCreatorId: referrer.creatorId,
        referralCodeSnapshot: referrer.referralCode,
        status: "CONVERTED",
        capturedAt: input.now,
        convertedAt: input.now,
      },
      select: { id: true },
    })) as { id: string };
    return {
      referrerCreatorId: referrer.creatorId,
      referralCodeSnapshot: referrer.referralCode,
      attributionId: created.id,
      source: "MANUAL" as const,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await findApplicationAttribution(
        tx,
        input.shop,
        input.shopifyCustomerId,
      );
      if (!raced?.referrerCreator) throw referralValidationError();
      return {
        referrerCreatorId: raced.referrerCreatorId,
        referralCodeSnapshot: raced.referralCodeSnapshot,
        attributionId: raced.id,
        source: "ATTRIBUTION" as const,
      };
    }
    throw error;
  }
}

export async function submitCreatorApplication(
  shop: string,
  customerId: string,
  input: CreatorApplicationInput,
  client: ShopifyGraphqlClient,
) {
  submitStage("CUSTOMER_IDENTITY", {
    shop,
    loggedInCustomerPresent: Boolean(customerId),
  });
  requireNativeFields(input);
  submitStage("VALIDATE_NATIVE_FIELDS", {
    hasPlatform: Boolean(input.primaryPlatform),
    hasProfileUrl: Boolean(input.primaryProfileUrl),
    categoryCount: input.categories?.length || 0,
    termsAccepted: input.termsAccepted === true,
    accuracyConfirmed: input.accuracyConfirmed === true,
  });
  const shopifyCustomerId = normalizeCustomerGid(customerId);
  submitStage("LOAD_CUSTOMER", { hasCustomerIdentity: Boolean(shopifyCustomerId) });
  const customer = await fetchCustomerSnapshot(client, shopifyCustomerId);
  const value = validateCreatorApplication({
    ...input,
    emailSnapshot: customer.email || input.emailSnapshot,
  });
  submitStage("VALIDATE_INPUT", {
    hasDisplayName: Boolean(value.displayName),
    hasBio: Boolean(value.bio),
    hasProfileUrl: Boolean(value.primaryProfileUrl),
    hasCategories: Boolean(value.categories.length),
    categoryCount: value.categories.length,
  });
  const now = new Date();

  const creator = await db.$transaction(async (tx) => {
    submitStage("LOAD_EXISTING_CREATOR", { source: "CREATOR" });
    const existing = await tx.creator.findUnique({
      where: { shop_customerId: { shop, customerId: shopifyCustomerId } },
    });
    if (existing?.status === "APPROVED") {
      throw new DomainError("ALREADY_APPROVED", "Your creator account is already approved.", 409);
    }
    if (existing?.status === "SUSPENDED") {
      throw new DomainError("CREATOR_SUSPENDED", "Your creator account is suspended.", 409);
    }
    if (existing?.status === "PENDING") {
      return existing;
    }
    const applicationReferral = existing
      ? null
      : await resolveFirstApplicationReferral(tx, {
          shop,
          shopifyCustomerId,
          manualReferralCode: input.referralCode,
          now,
        });

    const data = {
      displayName: value.displayName,
      emailSnapshot: value.emailSnapshot || customer.email,
      legalName: value.legalName || [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
      country: value.country,
      city: value.city,
      bio: value.bio,
      primaryPlatform: value.primaryPlatform,
      primaryProfileUrl: value.primaryProfileUrl,
      audienceRange: value.audienceRange,
      categoriesJson: safeJson(value.categories),
      portfolioUrl: value.portfolioUrl,
      aboutWork: value.aboutWork,
      socialLinksJson: safeJson(value.socialLinks),
      profileImageUrl: value.profileImageUrl,
      termsAcceptedAt: value.termsAcceptedAt,
      applicationSource: "CUSTOM_APP" as const,
      statusAuthority: "CUSTOM_APP" as const,
      externalSyncConflict: false,
      status: "PENDING" as const,
      submittedAt: now,
      reviewedAt: null,
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      suspendedAt: null,
      suspensionReason: null,
      ...(applicationReferral
        ? { referredByCreatorId: applicationReferral.referrerCreatorId }
        : {}),
    };
    submitStage("CREATE_OR_UPDATE_CREATOR", {
      mode: existing ? "update" : "create",
      status: data.status,
      keys: Object.keys(data).sort(),
      hasCustomerIdentity: Boolean(shopifyCustomerId),
      hasDisplayName: Boolean(data.displayName),
      hasBio: Boolean(data.bio),
      hasProfileUrl: Boolean(data.primaryProfileUrl),
      hasCategories: Boolean(value.categories.length),
      categoryCount: value.categories.length,
      termsAccepted: Boolean(data.termsAcceptedAt),
    });

    const handle = existing
      ? existing.handle
      : await uniqueCreatorHandle(shop, value.displayName, shopifyCustomerId);
    const saved = existing
      ? await tx.creator.update({
          where: { id: existing.id },
          data: {
            ...data,
            referredByCreatorId: existing.referredByCreatorId,
            ...(existing.referralCode ? {} : referralFieldsForCode(handle)),
          },
        })
      : await tx.creator.create({
          data: {
            shop,
            customerId: shopifyCustomerId,
            handle,
            ...referralFieldsForCode(handle),
            ...data,
          },
        });
    if (applicationReferral?.source === "ATTRIBUTION") {
      await tx.referralAttribution.update({
        where: { id: applicationReferral.attributionId },
        data: {
          status: "CONVERTED",
          convertedAt: now,
        },
        select: { id: true },
      });
    }
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "CUSTOMER",
        actorId: shopifyCustomerId,
        action: existing ? "creator.application.resubmitted" : "creator.application.submitted",
        entityType: "Creator",
        entityId: saved.id,
        afterJson: safeJson({ status: "PENDING", source: "CUSTOM_APP" }),
      },
    });
    await tx.adminNotification.create({
      data: {
        shop,
        type: existing ? "CREATOR_RESUBMITTED" : "CREATOR_SUBMITTED",
        title: existing ? "Creator application resubmitted" : "New creator application",
        message: `${saved.displayName} ${existing ? "resubmitted" : "submitted"} a creator application.`,
        entityType: "Creator",
        entityId: saved.id,
        actionUrl: `/app/creators?creator=${encodeURIComponent(saved.id)}`,
        metadataJson: safeJson({ creatorId: saved.id }),
      },
    });
    submitStage("SET_PENDING", { status: saved.status });
    return saved;
  });

  try {
    await syncCustomerStatus(shopifyCustomerId, "PENDING", client);
  } catch (error) {
    console.warn("creator_application_status_mirror_failed", {
      shop,
      operation: "submit",
      ...errorDetails(error),
    });
  }
  submitStage("RESPONSE", { ok: true, status: creator.status });
  return creatorApplicationView(creator);
}

export async function rejectCreatorApplication(
  shop: string,
  creatorId: string,
  reason: string,
  client?: ShopifyGraphqlClient,
) {
  const rejectionReason = String(reason || "").replace(/\s+/g, " ").trim();
  if (rejectionReason.length < 3 || rejectionReason.length > 1000) {
    throw new DomainError("REJECTION_REASON_REQUIRED", "Enter a rejection reason.", 422);
  }
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const creator = await tx.creator.findFirst({ where: { id: creatorId, shop } });
    if (!creator) throw new DomainError("CREATOR_NOT_FOUND", "Creator not found.", 404);
    if (creator.status !== "PENDING") {
      throw new DomainError("INVALID_STATUS", "Only pending creators can be rejected.", 409);
    }
    const updated = await tx.creator.update({
      where: { id: creator.id },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        rejectedAt: now,
        approvedAt: null,
        rejectionReason,
        statusAuthority: "CUSTOM_APP",
      },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "ADMIN",
        action: "creator.application.rejected",
        entityType: "Creator",
        entityId: creator.id,
        beforeJson: safeJson({ status: creator.status }),
        afterJson: safeJson({ status: "REJECTED", reasonPresent: true }),
      },
    });
    return updated;
  });
  if (updated.customerId && client) {
    await syncCustomerStatus(updated.customerId, "REJECTED", client);
  }
  return updated;
}

export async function approveCreatorApplication(
  shop: string,
  creatorId: string,
  client: ShopifyGraphqlClient,
) {
  const now = new Date();
  let approvedTransition = false;
  const creator = await db.$transaction(async (tx) => {
    const existing = await tx.creator.findFirst({ where: { id: creatorId, shop } });
    if (!existing) throw new DomainError("CREATOR_NOT_FOUND", "Creator not found.", 404);
    if (existing.status === "APPROVED") return existing;
    if (existing.status !== "PENDING") {
      throw new DomainError("INVALID_STATUS", "Only pending creators can be approved.", 409);
    }
    approvedTransition = true;
    const updated = await tx.creator.update({
      where: { id: existing.id },
      data: {
        status: "APPROVED",
        statusAuthority: "CUSTOM_APP",
        externalSyncConflict: false,
        approvedAt: now,
        reviewedAt: now,
        rejectedAt: null,
        rejectionReason: null,
        suspendedAt: null,
        suspensionReason: null,
      },
    });
    await tx.auditLog.create({
      data: {
        shop,
        actorType: "ADMIN",
        action: "creator.approved",
        entityType: "Creator",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "APPROVED", creatorId: existing.id }),
      },
    });
    return updated;
  });

  if (creator.customerId) {
    await syncCustomerStatus(creator.customerId, "APPROVED", client);
  }
  await ensureShopifyCreatorCollection(shop, creator.id, client);
  if (approvedTransition) {
    try {
      await sendCreatorWelcomeEmail(shop, creator.id);
    } catch {
      await db.auditLog.create({
        data: {
          shop,
          actorType: "SYSTEM",
          action: "creator.welcome_email.delivery_failed",
          entityType: "Creator",
          entityId: creator.id,
          afterJson: safeJson({ retryable: true }),
        },
      });
    }
  }
  return { creator };
}

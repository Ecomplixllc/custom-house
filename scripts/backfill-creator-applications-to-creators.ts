import type { ApplicationStatus, CreatorApplication, CreatorStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import db from "../app/db.server.ts";
import { referralFieldsForCode } from "../app/services/creator-referral.server.ts";

type BackfillStats = {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  collectionsEnsured: number;
};

function creatorStatus(status: ApplicationStatus) {
  if (status === "APPROVED") return "APPROVED" as const;
  if (status === "REJECTED") return "REJECTED" as const;
  return "PENDING" as const;
}

function safeJson(value: unknown) {
  return JSON.stringify(value);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "creator";
}

function normalizeCustomerGid(value: string) {
  const raw = String(value || "").trim();
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const id = raw.match(/\d+/)?.[0];
  return id ? `gid://shopify/Customer/${id}` : raw;
}

function nonBlank(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

async function ensureLocalCreatorCollection(shop: string, creatorId: string) {
  const creator = await db.creator.findFirst({
    where: { id: creatorId, shop },
    select: { id: true, displayName: true, handle: true, status: true },
  });
  if (!creator || creator.status !== "APPROVED") return null;
  const existing = await db.creatorCollection.findUnique({
    where: { creatorId: creator.id },
  });
  const displayName = `${creator.displayName || creator.handle} Designs`;
  if (existing) {
    if (existing.status !== "ACTIVE" || existing.displayName !== displayName) {
      return db.creatorCollection.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", displayName },
      });
    }
    return existing;
  }
  const publicId = randomUUID();
  const baseHandle = slugify(displayName);
  let publicHandle = baseHandle;
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const duplicate = await db.creatorCollection.findUnique({
      where: { publicHandle },
      select: { id: true },
    });
    if (!duplicate) break;
    publicHandle = `${baseHandle}-${suffix}`;
  }
  return db.creatorCollection.create({
    data: {
      shop,
      creatorId: creator.id,
      publicId,
      publicHandle,
      displayName,
      status: "ACTIVE",
    },
  });
}

async function uniqueHandle(shop: string, displayName: string, customerId: string) {
  const base = slugify(displayName || customerId.split("/").pop() || "creator");
  let handle = base;
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const existing = await db.creator.findFirst({
      where: { shop, handle, NOT: { customerId } },
      select: { id: true },
    });
    if (!existing) return handle;
    handle = `${base}-${suffix}`;
  }
  return `${base}-${Date.now()}`;
}

function mergedData(
  creator: {
    status: CreatorStatus;
    displayName: string | null;
    legalName: string | null;
    emailSnapshot: string | null;
    country: string | null;
    city: string | null;
    bio: string | null;
    primaryPlatform: string | null;
    primaryProfileUrl: string | null;
    audienceRange: string | null;
    categoriesJson: string;
    portfolioUrl: string | null;
    aboutWork: string | null;
    socialLinksJson: string;
    profileImageUrl: string | null;
    termsAcceptedAt: Date | null;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
  },
  application: CreatorApplication,
) {
  const nextStatus = creatorStatus(application.status);
  const keepStrongStatus = creator.status === "APPROVED" || creator.status === "SUSPENDED";
  return {
    displayName: nonBlank(creator.displayName) || nonBlank(application.displayName) || "Creator",
    legalName: nonBlank(creator.legalName) || nonBlank(application.legalName),
    emailSnapshot: nonBlank(creator.emailSnapshot) || nonBlank(application.emailSnapshot),
    country: nonBlank(creator.country) || nonBlank(application.country),
    city: nonBlank(creator.city) || nonBlank(application.city),
    bio: nonBlank(creator.bio) || nonBlank(application.bio),
    primaryPlatform: nonBlank(creator.primaryPlatform) || nonBlank(application.primaryPlatform),
    primaryProfileUrl: nonBlank(creator.primaryProfileUrl) || nonBlank(application.primaryProfileUrl),
    audienceRange: nonBlank(creator.audienceRange) || nonBlank(application.audienceRange),
    categoriesJson:
      creator.categoriesJson && creator.categoriesJson !== "[]"
        ? creator.categoriesJson
        : application.categoriesJson || "[]",
    portfolioUrl: nonBlank(creator.portfolioUrl) || nonBlank(application.portfolioUrl),
    aboutWork: nonBlank(creator.aboutWork) || nonBlank(application.aboutWork) || nonBlank(application.message),
    socialLinksJson:
      creator.socialLinksJson && creator.socialLinksJson !== "[]"
        ? creator.socialLinksJson
        : application.socialLinksJson || "[]",
    profileImageUrl: nonBlank(creator.profileImageUrl) || nonBlank(application.profileImageUrl),
    termsAcceptedAt: creator.termsAcceptedAt || application.termsAcceptedAt,
    submittedAt: creator.submittedAt || application.submittedAt || application.createdAt,
    reviewedAt: creator.reviewedAt || application.reviewedAt,
    approvedAt: creator.approvedAt || application.approvedAt,
    rejectedAt: creator.rejectedAt || application.rejectedAt,
    rejectionReason: creator.rejectionReason || application.rejectionReason || application.reviewerNote,
    applicationSource: "CUSTOM_APP" as const,
    statusAuthority: "CUSTOM_APP" as const,
    status: keepStrongStatus ? creator.status : nextStatus,
  };
}

async function run() {
  const stats: BackfillStats = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    collectionsEnsured: 0,
  };
  const applications = await db.creatorApplication.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const application of applications) {
    stats.scanned += 1;
    const customerId = application.shopifyCustomerId
      ? normalizeCustomerGid(application.shopifyCustomerId)
      : null;
    let creator = application.creatorId
      ? await db.creator.findFirst({
          where: { id: application.creatorId, shop: application.shop },
        })
      : null;
    if (!creator && customerId) {
      creator = await db.creator.findUnique({
        where: { shop_customerId: { shop: application.shop, customerId } },
      });
    }
    if (!creator && !customerId) {
      stats.skipped += 1;
      continue;
    }

    if (!creator) {
      const displayName =
        nonBlank(application.displayName) ||
        nonBlank(application.legalName) ||
        "Creator";
      const handle = await uniqueHandle(application.shop, displayName, customerId!);
      const created = await db.creator.create({
        data: {
          shop: application.shop,
          customerId: customerId!,
          handle,
          ...referralFieldsForCode(handle),
          displayName,
          legalName: nonBlank(application.legalName),
          emailSnapshot: nonBlank(application.emailSnapshot),
          country: nonBlank(application.country),
          city: nonBlank(application.city),
          bio: nonBlank(application.bio),
          primaryPlatform: nonBlank(application.primaryPlatform),
          primaryProfileUrl: nonBlank(application.primaryProfileUrl),
          audienceRange: nonBlank(application.audienceRange),
          categoriesJson: application.categoriesJson || "[]",
          portfolioUrl: nonBlank(application.portfolioUrl),
          aboutWork: nonBlank(application.aboutWork) || nonBlank(application.message),
          socialLinksJson: application.socialLinksJson || "[]",
          profileImageUrl: nonBlank(application.profileImageUrl),
          termsAcceptedAt: application.termsAcceptedAt,
          submittedAt: application.submittedAt || application.createdAt,
          reviewedAt: application.reviewedAt,
          approvedAt: application.approvedAt,
          rejectedAt: application.rejectedAt,
          rejectionReason: application.rejectionReason || application.reviewerNote,
          applicationSource: "CUSTOM_APP",
          statusAuthority: "CUSTOM_APP",
          status: creatorStatus(application.status),
        },
      });
      creator = created;
      stats.created += 1;
    } else {
      const updated = await db.creator.update({
        where: { id: creator.id },
        data: mergedData(creator, application),
      });
      creator = updated;
      stats.updated += 1;
    }

    if (creator.status === "APPROVED") {
      try {
        await ensureLocalCreatorCollection(application.shop, creator.id);
        stats.collectionsEnsured += 1;
      } catch (error) {
        console.warn("creator_collection_backfill_skipped", {
          creatorId: creator.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await db.auditLog.create({
      data: {
        shop: application.shop,
        actorType: "SYSTEM",
        action: "creator.application.backfilled",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({
          applicationId: application.id,
          status: creator.status,
        }),
      },
    });
  }

  console.info("creator_application_backfill_complete", stats);
}

run()
  .catch((error) => {
    console.error("creator_application_backfill_failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

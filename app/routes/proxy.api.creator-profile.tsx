import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { DomainError, safeJson } from "../services/domain";
import {
  CREATOR_AUDIENCE_RANGES,
  CREATOR_CATEGORIES,
  CREATOR_PLATFORMS,
} from "../services/creator-application";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import {
  apiData,
  apiError,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { changeCreatorStatus } from "../services/creator.server";

function cleanText(value: unknown, limit: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : undefined;
}

function cleanHttpsUrl(value: unknown) {
  const text = cleanText(value, 500);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function accepted(value: unknown) {
  return /^(true|yes|1|on|accepted)$/i.test(String(value || "").trim());
}

function cleanChoice(value: unknown, options: readonly string[]) {
  const text = cleanText(value, 80);
  return text && options.includes(text) ? text : undefined;
}

function cleanStringList(value: unknown, options?: readonly string[]) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .map((item) => cleanText(item, 80))
    .filter((item): item is string => Boolean(item))
    .filter((item) => !options || options.includes(item))
    .slice(0, 10);
}

function parseStringList(value: string | null) {
  try {
    return cleanStringList(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const context = await proxyContext(request);
    const { shop, customerId } = context;
    enforceRateLimit(`${shop}:${customerId}:profile-update`, 20, 60 * 60 * 1000);
    const body = await jsonBody(request);
    const customerGid = normalizeCustomerGid(customerId!);
    const creator = await db.creator.findUnique({
      where: { shop_customerId: { shop, customerId: customerGid } },
    });
    if (!creator)
      throw new DomainError("CREATOR_NOT_FOUND", "Creator profile not found.", 404);

    if (request.method.toUpperCase() === "DELETE") {
      if (creator.status !== "APPROVED") {
        throw new DomainError("INVALID_STATUS", "Only an active Creator account can be deactivated.", 409);
      }
      await changeCreatorStatus(
        shop,
        creator.id,
        "SUSPENDED",
        context.client,
        "Deactivated by Creator",
      );
      await db.auditLog.create({
        data: {
          shop,
          actorType: "CUSTOMER",
          actorId: customerGid,
          action: "creator.account.deactivated",
          entityType: "Creator",
          entityId: creator.id,
          afterJson: safeJson({ status: "SUSPENDED", shopifyCustomerPreserved: true }),
        },
      });
      return apiData({ deactivated: true, shopifyCustomerPreserved: true });
    }

    const displayName = cleanText(body.displayName, 80);
    const legalName = cleanText(body.legalName, 120);
    const country = cleanText(body.country, 80);
    const city = cleanText(body.city, 100);
    const bio = cleanText(body.bio, 1000);
    const portfolioUrl = cleanHttpsUrl(body.portfolioUrl);
    const primaryPlatform = cleanChoice(body.primaryPlatform, CREATOR_PLATFORMS);
    const primaryProfileUrl = cleanHttpsUrl(body.primaryProfileUrl);
    const audienceRange = cleanChoice(body.audienceRange, CREATOR_AUDIENCE_RANGES);
    const categories = cleanStringList(body.categories, CREATOR_CATEGORIES);
    const aboutWork = cleanText(body.aboutWork, 1000);
    const termsAccepted = accepted(body.termsAccepted);
    const socialLinks = cleanStringList(body.socialLinks)
      .map((url) => cleanHttpsUrl(url))
      .filter((url): url is string => Boolean(url));
    const socialLinksJson =
      socialLinks.length || portfolioUrl
        ? JSON.stringify(Array.from(new Set([...(portfolioUrl ? [portfolioUrl] : []), ...socialLinks])))
        : undefined;
    const termsAcceptedAt = termsAccepted ? new Date() : undefined;
    const resubmitting = creator.status === "REJECTED";
    const removeProfileImage = accepted(body.removeProfileImage);

    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.creator.update({
        where: { id: creator.id },
        data: {
          displayName,
          legalName,
          country,
          city,
          bio,
          portfolioUrl,
          socialLinksJson: socialLinksJson ?? "[]",
          termsAcceptedAt,
          primaryPlatform: primaryPlatform ?? null,
          primaryProfileUrl: primaryProfileUrl ?? null,
          audienceRange,
          categoriesJson: categories.length ? safeJson(categories) : undefined,
          aboutWork,
          profileImageUrl: removeProfileImage ? null : undefined,
          ...(resubmitting
            ? {
                status: "PENDING",
                submittedAt: new Date(),
                reviewedAt: null,
                rejectedAt: null,
                rejectionReason: null,
                statusAuthority: "CUSTOM_APP",
                externalSyncConflict: false,
              }
            : {}),
        },
      });
      if (creator.status === "APPROVED" && displayName && displayName !== creator.displayName) {
        await tx.creatorCollection.updateMany({
          where: { shop, creatorId: creator.id },
          data: { displayName: `${displayName} Designs` },
        });
      }

      await tx.auditLog.create({
        data: {
          shop,
          actorType: "CUSTOMER",
          actorId: customerGid,
          action: "creator.profile.updated",
          entityType: "Creator",
          entityId: creator.id,
          afterJson: safeJson({
            displayName: Boolean(displayName),
            legalName: Boolean(legalName),
            country: Boolean(country),
            city: Boolean(city),
            bio: Boolean(bio),
            portfolioUrl: Boolean(portfolioUrl),
            primaryPlatform: Boolean(primaryPlatform),
            primaryProfileUrl: Boolean(primaryProfileUrl),
            audienceRange: Boolean(audienceRange),
            categories: categories.length,
            aboutWork: Boolean(aboutWork),
            termsAccepted,
            profileImageRemoved: removeProfileImage,
            resubmitted: resubmitting,
          }),
        },
      });
      if (resubmitting) {
        await tx.auditLog.create({
          data: {
            shop,
            actorType: "CUSTOMER",
            actorId: customerGid,
            action: "creator.application.resubmitted",
            entityType: "Creator",
            entityId: creator.id,
            afterJson: safeJson({ status: "PENDING", source: "CUSTOM_APP" }),
          },
        });
        await tx.adminNotification.create({
          data: {
            shop,
            type: "CREATOR_RESUBMITTED",
            title: "Creator application resubmitted",
            message: `${saved.displayName} resubmitted a creator application.`,
            entityType: "Creator",
            entityId: saved.id,
            actionUrl: `/app/creators?creator=${encodeURIComponent(saved.id)}`,
            metadataJson: safeJson({ creatorId: saved.id }),
          },
        });
      }
      return saved;
    });

    return apiData({
      saved: true,
      creator: {
        id: updated.id,
        status: updated.status,
        displayName: updated.displayName,
        legalName: updated.legalName,
        country: updated.country,
        city: updated.city,
        bio: updated.bio,
        portfolioUrl: updated.portfolioUrl,
        primaryPlatform: updated.primaryPlatform,
        primaryProfileUrl: updated.primaryProfileUrl,
        audienceRange: updated.audienceRange,
        categories: parseStringList(updated.categoriesJson),
        aboutWork: updated.aboutWork,
        profileImageUrl: updated.profileImageUrl,
        socialLinksJson: updated.socialLinksJson,
        termsAccepted: Boolean(updated.termsAcceptedAt),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

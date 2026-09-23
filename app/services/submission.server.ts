import db from "../db.server";
import { DomainError, parseJsonList } from "./domain";
import { submissionKey } from "./idempotency.server";
import {
  ManualPitchPrintProvider,
  type ManualDesignInput,
} from "./design-provider.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { normalizeCustomerGid } from "./helium-sync.server";
import {
  creatorSalesOverview,
  reconcileRecentPaidCreatorSales,
} from "./creator-sales.server";
import { referralEarningsForAuthenticatedCreator } from "./creator-referral-earnings.server";
import { getCreatorCollectionStorefrontUrl } from "./creator-storefront-urls";
import { payoutDashboardForCreator } from "./payouts.server";

export async function createSubmission(
  shop: string,
  customerId: string,
  input: ManualDesignInput,
  client: ShopifyGraphqlClient,
) {
  customerId = normalizeCustomerGid(customerId);
  const creator = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  if (!creator || creator.status !== "APPROVED")
    throw new DomainError(
      "NOT_APPROVED",
      "Only approved creators can submit designs.",
      403,
    );
  const config = await db.shopConfig.findUnique({ where: { shop } });
  const normalized = new ManualPitchPrintProvider().normalize(
    input,
    [
      ...parseJsonList(config?.inkybayAllowedHostsJson ?? "[]"),
      "pitchprint.com",
    ],
  );
  const result = await client.request<{
    product: {
      origin: { value: string } | null;
      mode: { value: string } | null;
    } | null;
  }>(
    `#graphql query($id: ID!) { product(id: $id) { origin: metafield(namespace: "customhouse", key: "product_origin") { value } mode: metafield(namespace: "customhouse", key: "design_mode") { value } } }`,
    { id: normalized.baseProductId },
  );
  if (!result.product)
    throw new DomainError("PRODUCT_NOT_FOUND", "Base product not found.", 404);
  if (result.product.origin?.value !== "global")
    throw new DomainError(
      "NOT_GLOBAL",
      "Designs must start from a Global Product.",
      422,
    );
  if (result.product.mode?.value !== "customizable")
    throw new DomainError(
      "NOT_CUSTOMIZABLE",
      "This product is not customizable.",
      422,
    );
  const idempotencyKey = submissionKey(
    shop,
    creator.id,
    normalized.baseProductId,
    normalized.savedDesignUrl,
  );
  try {
    return await db.$transaction(async (tx) => {
      const submission = await tx.designSubmission.create({
        data: { shop, creatorId: creator.id, ...normalized, idempotencyKey },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: "CUSTOMER",
          actorId: customerId,
          action: "submission.created",
          entityType: "DesignSubmission",
          entityId: submission.id,
        },
      });
      return submission;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint"))
      throw new DomainError(
        "DUPLICATE_SUBMISSION",
        "This saved design was already submitted.",
        409,
      );
    throw error;
  }
}

export async function creatorDashboard(
  shop: string,
  customerId: string,
  _client?: ShopifyGraphqlClient,
) {
  customerId = normalizeCustomerGid(customerId);
  const creator = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
    include: {
      submissions: { orderBy: { createdAt: "desc" }, take: 20 },
      marketplaceCollection: {
        select: {
          id: true,
          publicHandle: true,
          status: true,
          bannerImageUrl: true,
          bannerTitle: true,
          bannerSubtitle: true,
          bannerUpdatedAt: true,
        },
      },
    },
  });

  if (!creator) {
    return { state: "NOT_APPLIED" as const, creatorFound: false };
  }

  const collectionUrl = getCreatorCollectionStorefrontUrl(
    creator.marketplaceCollection,
  );
  const displayName =
    creator.displayName || creator.legalName || "Creator";
  const legalName = creator.legalName;
  const bio = creator.bio;
  const portfolioUrl = creator.portfolioUrl || creator.primaryProfileUrl;
  const profileImageUrl = creator.profileImageUrl;
  const socialLinksJson = creator.socialLinksJson;
  const city = creator.city;
  const country = creator.country;
  const primaryPlatform = creator.primaryPlatform;
  const primaryProfileUrl = creator.primaryProfileUrl;
  const audienceRange = creator.audienceRange;
  const categoriesJson = creator.categoriesJson;
  const aboutWork = creator.aboutWork;
  if (_client) {
    try {
      await reconcileRecentPaidCreatorSales({
        shop,
        creatorId: creator.id,
        client: _client,
      });
    } catch {
      // Dashboard sales still render from stored webhook data if live reconciliation fails.
    }
  }

  const [sales, referrals, payouts] = await Promise.all([
    creatorSalesOverview(creator.id),
    referralEarningsForAuthenticatedCreator({
      shop,
      authenticatedCreatorId: creator.id,
      page: 1,
      pageSize: 25,
    }),
    payoutDashboardForCreator({ shop, creatorId: creator.id }),
  ]);

  return {
    state: creator.externalSyncConflict ? "SYNC_CONFLICT" as const : creator.status,
    creatorFound: true,
    displayName,
    legalName,
    city,
    country,
    bio,
    portfolioUrl,
    profileImageUrl,
    socialLinksJson,
    primaryPlatform,
    primaryProfileUrl,
    audienceRange,
    categoriesJson,
    aboutWork,
    termsAccepted: Boolean(creator.termsAcceptedAt),
    handle: creator.handle,
    referralCode: creator.referralCode,
    status: creator.status,
    collectionUrl,
    storefrontCollectionUrl: collectionUrl,
    collection: creator.marketplaceCollection
      ? {
          id: creator.marketplaceCollection.id,
          publicHandle: creator.marketplaceCollection.publicHandle,
          publicUrl: collectionUrl,
          bannerImageUrl: creator.marketplaceCollection.bannerImageUrl,
          bannerTitle: creator.marketplaceCollection.bannerTitle,
          bannerSubtitle: creator.marketplaceCollection.bannerSubtitle,
          bannerUpdatedAt: creator.marketplaceCollection.bannerUpdatedAt,
        }
      : null,
    rejectionReason: creator.rejectionReason,
    suspensionReason: creator.suspensionReason,
    applicationStatus: creator.submittedAt ? creator.status : null,
    overview: {
      totalSales: sales.totalSales,
      totalEarnings: sales.totalEarnings,
      productEarnings: sales.productEarnings,
      referralEarnings: sales.referralEarnings,
      unifiedEarnings: sales.unifiedEarnings,
      ordersCount: sales.ordersCount,
      itemsSoldCount: sales.itemsSoldCount,
      commissionRatePercent: sales.commissionRatePercent,
      collectionsCount: creator.marketplaceCollection ? 1 : 0,
      publishedProductsCount: sales.publishedProductsCount,
    },
    topSellingProducts: sales.topSellingProducts,
    referrals,
    payouts,
    submissions: creator.submissions.map(
      ({
        id,
        designName,
        status,
        previewUrl,
        createdAt,
        createdProductId,
      }) => ({
        id,
        designName,
        status,
        previewUrl,
        createdAt,
        createdProductId,
      }),
    ),
  };
}

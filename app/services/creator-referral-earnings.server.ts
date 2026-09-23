import { Prisma } from "@prisma/client";
import db from "../db.server";
import {
  calculateReferralEarning,
  creatorEarningMinorFromSalesAmount,
  CREATOR_REFERRAL_RATE_BPS,
} from "./creator-referral-earnings";
import { formatMinorMoney } from "./money";

export {
  calculateReferralEarning,
  creatorEarningMinorFromSalesAmount,
  CREATOR_REFERRAL_RATE_BPS,
  decimalMoneyToMinorUnits,
} from "./creator-referral-earnings";
export { formatMinorMoney } from "./money";

type ReferralDiagnosticPayload = Record<
  string,
  string | number | boolean | null | undefined
>;

type ReferralEarningResult =
  | { status: "CREATED"; referralEarningId: string; amountMinor: bigint }
  | { status: "DUPLICATE"; referralEarningId: string | null }
  | { status: "SKIPPED"; reason: string };

type ReferralAdjustmentResult =
  | { status: "CREATED"; referralAdjustmentId: string; amountMinor: bigint }
  | { status: "DUPLICATE"; referralAdjustmentId: string | null }
  | { status: "SKIPPED"; reason: string };

export const REFERRAL_EARNINGS_PAGE_SIZE = 25;

type ReferralEarningReadRow = Awaited<
  ReturnType<typeof db.referralEarning.findMany>
>[number] & {
  referrerCreator?: { id: string; displayName: string; status: string } | null;
  referredCreator?: { id: string; displayName: string; status: string; createdAt: Date } | null;
  creatorSale?: {
    id: string;
    creatorId: string;
    shopifyOrderId: string;
    shopifyLineItemId: string;
    currencyCode: string;
  } | null;
  adjustments: Array<{
    id: string;
    adjustmentKey: string;
    baseAdjustmentMinor: bigint;
    referralAdjustmentMinor: bigint;
    reason: string;
    createdAt: Date;
    creatorSaleAdjustment?: {
      id: string;
      adjustmentKey: string;
      shopifyOrderId: string;
      shopifyLineItemId: string;
    } | null;
  }>;
};

function diagnostic(event: string, payload: ReferralDiagnosticPayload) {
  console.info(event, payload);
}

function consistencyError(payload: ReferralDiagnosticPayload) {
  console.warn("creator_referral_earning_consistency_error", payload);
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function eligibleSaleMoment(sale: { paidAt: Date | null; createdAt: Date }) {
  return sale.paidAt || sale.createdAt;
}

function pageParams(input?: { page?: number; pageSize?: number }) {
  const page = Number.isSafeInteger(input?.page) && Number(input?.page) > 0
    ? Number(input?.page)
    : 1;
  const pageSize =
    Number.isSafeInteger(input?.pageSize) &&
    Number(input?.pageSize) > 0 &&
    Number(input?.pageSize) <= 100
      ? Number(input?.pageSize)
      : REFERRAL_EARNINGS_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function finalAmountMinor(row: { amountMinor: bigint; adjustments: Array<{ referralAdjustmentMinor: bigint }> }) {
  return row.adjustments.reduce(
    (total, adjustment) => total + adjustment.referralAdjustmentMinor,
    row.amountMinor,
  );
}

function addCurrencyTotal(
  totals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>,
  currencyCode: string,
  originalMinor: bigint,
  adjustmentMinor: bigint,
) {
  const current =
    totals.get(currencyCode) || {
      originalMinor: 0n,
      adjustmentMinor: 0n,
      finalMinor: 0n,
    };
  current.originalMinor += originalMinor;
  current.adjustmentMinor += adjustmentMinor;
  current.finalMinor += originalMinor + adjustmentMinor;
  totals.set(currencyCode, current);
}

function formatRate(rateBps: number) {
  return `${rateBps / 100}%`;
}

function formatCurrencyTotals(
  totals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>,
) {
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, total]) => ({
      currencyCode,
      originalMinor: total.originalMinor.toString(),
      adjustmentMinor: total.adjustmentMinor.toString(),
      finalMinor: total.finalMinor.toString(),
      original: formatMinorMoney(total.originalMinor, currencyCode),
      adjustments: formatMinorMoney(total.adjustmentMinor, currencyCode),
      final: formatMinorMoney(total.finalMinor, currencyCode),
    }));
}

function consistencyWarningsForRow(row: ReferralEarningReadRow) {
  const warnings: string[] = [];
  if (!row.referrerCreator) warnings.push("Missing referrer creator");
  if (!row.referredCreator) warnings.push("Missing referred creator");
  if (!row.creatorSale) warnings.push("Missing creator sale");
  if (row.referrerCreatorId === row.referredCreatorId) warnings.push("Self referral financial record");
  if (row.creatorSale && row.creatorSale.creatorId !== row.referredCreatorId) {
    warnings.push("CreatorSale creator mismatch");
  }
  if (row.creatorSale && row.creatorSale.currencyCode !== row.currencyCode) {
    warnings.push("Currency mismatch");
  }
  const finalMinor = finalAmountMinor(row);
  if (finalMinor < 0n) warnings.push("Negative final entitlement");
  if (warnings.length) {
    console.warn("creator_referral_financial_consistency_warning", {
      shop: row.shop,
      referralEarningId: row.id,
      creatorSaleId: row.creatorSaleId,
      warningCount: warnings.length,
    });
  }
  return warnings;
}

function serializeReferralEarning(row: ReferralEarningReadRow) {
  const adjustmentMinor = row.adjustments.reduce(
    (total, adjustment) => total + adjustment.referralAdjustmentMinor,
    0n,
  );
  const finalMinor = row.amountMinor + adjustmentMinor;
  const warnings = consistencyWarningsForRow(row);
  return {
    id: row.id,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    status: row.status,
    currencyCode: row.currencyCode,
    rateBps: row.rateBps,
    ratePercent: formatRate(row.rateBps),
    baseCreatorEarningMinor: row.baseCreatorEarningMinor.toString(),
    baseCreatorEarning: formatMinorMoney(row.baseCreatorEarningMinor, row.currencyCode),
    amountMinor: row.amountMinor.toString(),
    originalReferral: formatMinorMoney(row.amountMinor, row.currencyCode),
    adjustmentMinor: adjustmentMinor.toString(),
    adjustmentsTotal: formatMinorMoney(adjustmentMinor, row.currencyCode),
    finalAmountMinor: finalMinor.toString(),
    finalEntitlement: formatMinorMoney(finalMinor, row.currencyCode),
    referrerCreator: row.referrerCreator
      ? {
          id: row.referrerCreator.id,
          displayName: row.referrerCreator.displayName,
          status: row.referrerCreator.status,
        }
      : null,
    referredCreator: row.referredCreator
      ? {
          id: row.referredCreator.id,
          displayName: row.referredCreator.displayName,
          status: row.referredCreator.status,
          joinedAt: row.referredCreator.createdAt,
        }
      : null,
    creatorSale: row.creatorSale
      ? {
          id: row.creatorSale.id,
          shopifyOrderId: row.creatorSale.shopifyOrderId,
          shopifyLineItemId: row.creatorSale.shopifyLineItemId,
          currencyCode: row.creatorSale.currencyCode,
        }
      : null,
    shopifyOrderId: row.shopifyOrderId,
    shopifyLineItemId: row.shopifyLineItemId,
    adjustments: row.adjustments.map((adjustment) => ({
      id: adjustment.id,
      adjustmentKey: adjustment.adjustmentKey,
      reason: adjustment.reason,
      createdAt: adjustment.createdAt,
      baseAdjustmentMinor: adjustment.baseAdjustmentMinor.toString(),
      baseAdjustment: formatMinorMoney(adjustment.baseAdjustmentMinor, row.currencyCode),
      referralAdjustmentMinor: adjustment.referralAdjustmentMinor.toString(),
      referralAdjustment: formatMinorMoney(adjustment.referralAdjustmentMinor, row.currencyCode),
      creatorSaleAdjustmentId: adjustment.creatorSaleAdjustment?.id || null,
    })),
    warnings,
  };
}

function earningInclude() {
  return {
    referrerCreator: {
      select: { id: true, displayName: true, status: true },
    },
    referredCreator: {
      select: { id: true, displayName: true, status: true, createdAt: true },
    },
    creatorSale: {
      select: {
        id: true,
        creatorId: true,
        shopifyOrderId: true,
        shopifyLineItemId: true,
        currencyCode: true,
      },
    },
    adjustments: {
      orderBy: { createdAt: "asc" as const },
      include: {
        creatorSaleAdjustment: {
          select: {
            id: true,
            adjustmentKey: true,
            shopifyOrderId: true,
            shopifyLineItemId: true,
          },
        },
      },
    },
  };
}

function summarizeRows(rows: ReferralEarningReadRow[]) {
  const totals = new Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>();
  const statusCounts = new Map<string, number>();
  const byReferrer = new Map<string, {
    creatorId: string;
    displayName: string;
    status: string;
    totals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>;
  }>();
  const byReferredCreator = new Map<string, {
    creatorId: string;
    displayName: string;
    status: string;
    totals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>;
  }>();

  for (const row of rows) {
    const adjustmentMinor = row.adjustments.reduce(
      (total, adjustment) => total + adjustment.referralAdjustmentMinor,
      0n,
    );
    addCurrencyTotal(totals, row.currencyCode, row.amountMinor, adjustmentMinor);
    statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
    const referrerKey = row.referrerCreator?.id || row.referrerCreatorId;
    const referrer =
      byReferrer.get(referrerKey) || {
        creatorId: referrerKey,
        displayName: row.referrerCreator?.displayName || "Unknown creator",
        status: row.referrerCreator?.status || "UNKNOWN",
        totals: new Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>(),
      };
    addCurrencyTotal(referrer.totals, row.currencyCode, row.amountMinor, adjustmentMinor);
    byReferrer.set(referrerKey, referrer);

    const referredKey = row.referredCreator?.id || row.referredCreatorId;
    const referred =
      byReferredCreator.get(referredKey) || {
        creatorId: referredKey,
        displayName: row.referredCreator?.displayName || "Unknown creator",
        status: row.referredCreator?.status || "UNKNOWN",
        totals: new Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>(),
      };
    addCurrencyTotal(referred.totals, row.currencyCode, row.amountMinor, adjustmentMinor);
    byReferredCreator.set(referredKey, referred);
  }

  return {
    totals: formatCurrencyTotals(totals),
    statusCounts: Object.fromEntries(statusCounts),
    byReferrer: [...byReferrer.values()].map((item) => ({
      creatorId: item.creatorId,
      displayName: item.displayName,
      status: item.status,
      totals: formatCurrencyTotals(item.totals),
    })),
    byReferredCreator: [...byReferredCreator.values()].map((item) => ({
      creatorId: item.creatorId,
      displayName: item.displayName,
      status: item.status,
      totals: formatCurrencyTotals(item.totals),
    })),
  };
}

async function referralEarningsLaunchAt(shop: string) {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { referralEarningsLaunchAt: true },
  });
  return config?.referralEarningsLaunchAt || null;
}

async function refreshReferralEarningStatus(referralEarningId: string) {
  const earning = await db.referralEarning.findUnique({
    where: { id: referralEarningId },
    select: {
      id: true,
      amountMinor: true,
      adjustments: { select: { referralAdjustmentMinor: true } },
    },
  });
  if (!earning) return;
  const finalAmount = earning.adjustments.reduce(
    (total, adjustment) => total + adjustment.referralAdjustmentMinor,
    earning.amountMinor,
  );
  const reversed = finalAmount <= 0n;
  await db.referralEarning.update({
    where: { id: earning.id },
    data: {
      status: reversed ? "REVERSED" : "AVAILABLE",
      reversedAt: reversed ? new Date() : null,
    },
  });
}

export async function syncReferralEarningForCreatorSale(input: {
  shop: string;
  creatorSaleId: string;
}): Promise<ReferralEarningResult> {
  const launchAt = await referralEarningsLaunchAt(input.shop);
  if (!launchAt) {
    diagnostic("creator_referral_earning_skipped", {
      shop: input.shop,
      creatorSaleId: input.creatorSaleId,
      reason: "REFERRAL_EARNINGS_LAUNCH_NOT_CONFIGURED",
    });
    return { status: "SKIPPED", reason: "REFERRAL_EARNINGS_LAUNCH_NOT_CONFIGURED" };
  }

  const sale = await db.creatorSale.findFirst({
    where: { id: input.creatorSaleId, shop: input.shop },
    include: {
      creator: {
        select: {
          id: true,
          referredByCreatorId: true,
          referredByCreator: {
            select: { id: true, status: true },
          },
        },
      },
    },
  });
  if (!sale) {
    consistencyError({
      shop: input.shop,
      creatorSaleId: input.creatorSaleId,
      reason: "CREATOR_SALE_NOT_FOUND",
    });
    return { status: "SKIPPED", reason: "CREATOR_SALE_NOT_FOUND" };
  }
  if (eligibleSaleMoment(sale) < launchAt) {
    diagnostic("creator_referral_earning_skipped", {
      shop: input.shop,
      creatorSaleId: sale.id,
      reason: "BEFORE_REFERRAL_EARNINGS_LAUNCH",
    });
    return { status: "SKIPPED", reason: "BEFORE_REFERRAL_EARNINGS_LAUNCH" };
  }

  const referrerCreatorId = sale.creator.referredByCreatorId;
  if (!referrerCreatorId) {
    diagnostic("creator_referral_earning_ineligible", {
      shop: input.shop,
      creatorSaleId: sale.id,
      reason: "CREATOR_NOT_REFERRED",
    });
    return { status: "SKIPPED", reason: "CREATOR_NOT_REFERRED" };
  }
  if (referrerCreatorId === sale.creatorId) {
    consistencyError({
      shop: input.shop,
      creatorSaleId: sale.id,
      creatorId: sale.creatorId,
      reason: "SELF_REFERRAL_RELATIONSHIP",
    });
    return { status: "SKIPPED", reason: "SELF_REFERRAL_RELATIONSHIP" };
  }
  if (!sale.creator.referredByCreator) {
    consistencyError({
      shop: input.shop,
      creatorSaleId: sale.id,
      referrerCreatorId,
      reason: "REFERRER_CREATOR_MISSING",
    });
    return { status: "SKIPPED", reason: "REFERRER_CREATOR_MISSING" };
  }
  if (sale.creator.referredByCreator.status !== "APPROVED") {
    diagnostic("creator_referral_earning_ineligible", {
      shop: input.shop,
      creatorSaleId: sale.id,
      referrerCreatorId,
      referrerStatus: sale.creator.referredByCreator.status,
      reason: "REFERRER_NOT_APPROVED",
    });
    return { status: "SKIPPED", reason: "REFERRER_NOT_APPROVED" };
  }

  const baseCreatorEarningMinor = creatorEarningMinorFromSalesAmount(
    sale.grossSalesAmount,
    sale.commissionRateBps,
  );
  const amountMinor = calculateReferralEarning({
    creatorEarningMinor: baseCreatorEarningMinor,
    rateBps: CREATOR_REFERRAL_RATE_BPS,
  });
  if (amountMinor <= 0n) {
    diagnostic("creator_referral_earning_ineligible", {
      shop: input.shop,
      creatorSaleId: sale.id,
      reason: "NON_POSITIVE_CREATOR_EARNING",
    });
    return { status: "SKIPPED", reason: "NON_POSITIVE_CREATOR_EARNING" };
  }

  try {
    const earning = await db.referralEarning.create({
      data: {
        shop: input.shop,
        referrerCreatorId,
        referredCreatorId: sale.creatorId,
        creatorSaleId: sale.id,
        shopifyOrderId: sale.shopifyOrderId,
        shopifyLineItemId: sale.shopifyLineItemId,
        currencyCode: sale.currencyCode,
        baseCreatorEarningMinor,
        rateBps: CREATOR_REFERRAL_RATE_BPS,
        amountMinor,
        status: "AVAILABLE",
        confirmedAt: new Date(),
      },
    });
    diagnostic("creator_referral_earning_created", {
      shop: input.shop,
      creatorSaleId: sale.id,
      referralEarningId: earning.id,
      amountMinor: amountMinor.toString(),
    });
    return {
      status: "CREATED",
      referralEarningId: earning.id,
      amountMinor,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const earning = await db.referralEarning.findUnique({
        where: {
          shop_creatorSaleId: {
            shop: input.shop,
            creatorSaleId: sale.id,
          },
        },
        select: { id: true },
      });
      diagnostic("creator_referral_earning_duplicate", {
        shop: input.shop,
        creatorSaleId: sale.id,
        referralEarningId: earning?.id || null,
      });
      return { status: "DUPLICATE", referralEarningId: earning?.id || null };
    }
    throw error;
  }
}

export async function syncReferralAdjustmentForCreatorSaleAdjustment(input: {
  shop: string;
  creatorSaleAdjustmentId: string;
}): Promise<ReferralAdjustmentResult> {
  const adjustment = await db.creatorSaleAdjustment.findFirst({
    where: { id: input.creatorSaleAdjustmentId, shop: input.shop },
    include: {
      creatorSale: {
        select: {
          id: true,
          shop: true,
          commissionRateBps: true,
          currencyCode: true,
          paidAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!adjustment?.creatorSale) {
    diagnostic("creator_referral_earning_adjusted", {
      shop: input.shop,
      creatorSaleAdjustmentId: input.creatorSaleAdjustmentId,
      reason: "CREATOR_SALE_NOT_LINKED",
    });
    return { status: "SKIPPED", reason: "CREATOR_SALE_NOT_LINKED" };
  }

  const earningResult = await syncReferralEarningForCreatorSale({
    shop: input.shop,
    creatorSaleId: adjustment.creatorSale.id,
  });
  if (earningResult.status === "SKIPPED") return earningResult;

  const earning = await db.referralEarning.findUnique({
    where: {
      shop_creatorSaleId: {
        shop: input.shop,
        creatorSaleId: adjustment.creatorSale.id,
      },
    },
    select: { id: true, currencyCode: true },
  });
  if (!earning) {
    consistencyError({
      shop: input.shop,
      creatorSaleAdjustmentId: adjustment.id,
      reason: "REFERRAL_EARNING_NOT_FOUND",
    });
    return { status: "SKIPPED", reason: "REFERRAL_EARNING_NOT_FOUND" };
  }
  if (earning.currencyCode !== adjustment.creatorSale.currencyCode) {
    consistencyError({
      shop: input.shop,
      referralEarningId: earning.id,
      creatorSaleAdjustmentId: adjustment.id,
      reason: "CURRENCY_MISMATCH",
    });
    return { status: "SKIPPED", reason: "CURRENCY_MISMATCH" };
  }

  const baseAdjustmentMinor = creatorEarningMinorFromSalesAmount(
    adjustment.salesAmount,
    adjustment.creatorSale.commissionRateBps,
  );
  const referralAdjustmentMinor =
    -calculateReferralEarning({
      creatorEarningMinor: baseAdjustmentMinor,
      rateBps: CREATOR_REFERRAL_RATE_BPS,
    });
  if (referralAdjustmentMinor === 0n) {
    return { status: "SKIPPED", reason: "ZERO_REFERRAL_ADJUSTMENT" };
  }

  try {
    const referralAdjustment = await db.referralEarningAdjustment.create({
      data: {
        shop: input.shop,
        referralEarningId: earning.id,
        creatorSaleAdjustmentId: adjustment.id,
        adjustmentKey: adjustment.adjustmentKey,
        baseAdjustmentMinor,
        referralAdjustmentMinor,
        reason: "REFUND",
      },
    });
    await refreshReferralEarningStatus(earning.id);
    diagnostic("creator_referral_earning_adjusted", {
      shop: input.shop,
      referralEarningId: earning.id,
      creatorSaleAdjustmentId: adjustment.id,
      amountMinor: referralAdjustmentMinor.toString(),
    });
    if (referralAdjustmentMinor < 0n) {
      diagnostic("creator_referral_earning_reversed", {
        shop: input.shop,
        referralEarningId: earning.id,
        creatorSaleAdjustmentId: adjustment.id,
      });
    }
    return {
      status: "CREATED",
      referralAdjustmentId: referralAdjustment.id,
      amountMinor: referralAdjustmentMinor,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await db.referralEarningAdjustment.findFirst({
        where: {
          shop: input.shop,
          creatorSaleAdjustmentId: adjustment.id,
        },
        select: { id: true },
      });
      diagnostic("creator_referral_earning_duplicate", {
        shop: input.shop,
        creatorSaleAdjustmentId: adjustment.id,
        referralAdjustmentId: existing?.id || null,
      });
      return {
        status: "DUPLICATE",
        referralAdjustmentId: existing?.id || null,
      };
    }
    throw error;
  }
}

export async function syncReferralAdjustmentsForCreatorSale(input: {
  shop: string;
  creatorSaleId: string;
}) {
  const adjustments = await db.creatorSaleAdjustment.findMany({
    where: {
      shop: input.shop,
      creatorSaleId: input.creatorSaleId,
    },
    select: { id: true },
  });
  for (const adjustment of adjustments) {
    await syncReferralAdjustmentForCreatorSaleAdjustment({
      shop: input.shop,
      creatorSaleAdjustmentId: adjustment.id,
    });
  }
  return { scanned: adjustments.length };
}

function paginate(total: number, page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

function groupRowsByReferredCreator(rows: ReferralEarningReadRow[]) {
  const grouped = new Map<
    string,
    {
      creatorId: string;
      displayName: string;
      status: string;
      joinedAt: Date | null;
      saleCount: number;
      totals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>;
      baseTotals: Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>;
    }
  >();

  for (const row of rows) {
    const key = row.referredCreator?.id || row.referredCreatorId;
    const adjustmentMinor = row.adjustments.reduce(
      (total, adjustment) => total + adjustment.referralAdjustmentMinor,
      0n,
    );
    const baseAdjustmentMinor = row.adjustments.reduce(
      (total, adjustment) => total + adjustment.baseAdjustmentMinor,
      0n,
    );
    const item =
      grouped.get(key) || {
        creatorId: key,
        displayName: row.referredCreator?.displayName || "Unknown creator",
        status: row.referredCreator?.status || "UNKNOWN",
        joinedAt: row.referredCreator?.createdAt || null,
        saleCount: 0,
        totals: new Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>(),
        baseTotals: new Map<string, { originalMinor: bigint; adjustmentMinor: bigint; finalMinor: bigint }>(),
      };
    item.saleCount += 1;
    addCurrencyTotal(item.totals, row.currencyCode, row.amountMinor, adjustmentMinor);
    addCurrencyTotal(item.baseTotals, row.currencyCode, row.baseCreatorEarningMinor, baseAdjustmentMinor);
    grouped.set(key, item);
  }

  return [...grouped.values()].map((item) => ({
    creatorId: item.creatorId,
    displayName: item.displayName,
    status: item.status,
    joinedAt: item.joinedAt,
    saleCount: item.saleCount,
    totals: formatCurrencyTotals(item.totals),
    baseCreatorEarnings: formatCurrencyTotals(item.baseTotals),
  }));
}

async function launchState(shop: string) {
  const launchAt = await referralEarningsLaunchAt(shop);
  return {
    active: Boolean(launchAt),
    referralEarningsLaunchAt: launchAt,
    label: launchAt ? "Activated" : "Not Activated",
  };
}

export async function adminReferralEarningsSummary(
  shop: string,
  input?: { page?: number; pageSize?: number },
) {
  const { page, pageSize, skip } = pageParams(input);
  const where = { shop };
  const [launch, allRows, rows, total] = await Promise.all([
    launchState(shop),
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
    }),
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    db.referralEarning.count({ where }),
  ]);
  const serializedRows = rows.map((row) => serializeReferralEarning(row));
  return {
    launch,
    summary: summarizeRows(allRows),
    rows: serializedRows,
    pagination: paginate(total, page, pageSize),
    warningsCount: serializedRows.reduce((totalWarnings, row) => totalWarnings + row.warnings.length, 0),
  };
}

export async function referralEarningsForAuthenticatedCreator(input: {
  shop: string;
  authenticatedCreatorId: string;
  page?: number;
  pageSize?: number;
}) {
  const { page, pageSize, skip } = pageParams(input);
  const where = {
    shop: input.shop,
    referrerCreatorId: input.authenticatedCreatorId,
  };
  const [allRows, rows, total, totalReferrals, statusGroups] = await Promise.all([
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
    }),
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    db.referralEarning.count({ where }),
    db.creator.count({
      where: {
        shop: input.shop,
        referredByCreatorId: input.authenticatedCreatorId,
      },
    }),
    db.creator.groupBy({
      by: ["status"],
      where: {
        shop: input.shop,
        referredByCreatorId: input.authenticatedCreatorId,
      },
      _count: { _all: true },
    }),
  ]);
  const summary = summarizeRows(allRows);
  return {
    summary: {
      ...summary,
      totalReferrals,
      referralStatusCounts: Object.fromEntries(
        statusGroups.map((item) => [item.status, item._count._all]),
      ),
    },
    referredCreators: groupRowsByReferredCreator(allRows),
    rows: rows.map((row) => serializeReferralEarning(row)),
    pagination: paginate(total, page, pageSize),
  };
}

export async function referralFinancialsForCreatorAdmin(input: {
  shop: string;
  creatorId: string;
  page?: number;
  pageSize?: number;
}) {
  return referralEarningsForAuthenticatedCreator({
    shop: input.shop,
    authenticatedCreatorId: input.creatorId,
    page: input.page,
    pageSize: input.pageSize,
  });
}

export async function referralEarningsGeneratedByCreator(input: {
  shop: string;
  creatorId: string;
  page?: number;
  pageSize?: number;
}) {
  const { page, pageSize, skip } = pageParams(input);
  const where = {
    shop: input.shop,
    referredCreatorId: input.creatorId,
  };
  const [allRows, rows, total] = await Promise.all([
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
    }),
    db.referralEarning.findMany({
      where,
      include: earningInclude(),
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    db.referralEarning.count({ where }),
  ]);
  return {
    summary: summarizeRows(allRows),
    rows: rows.map((row) => serializeReferralEarning(row)),
    pagination: paginate(total, page, pageSize),
  };
}

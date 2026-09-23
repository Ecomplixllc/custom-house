import {
  CreatorStatus,
  PayoutAllocationSourceType,
  PayoutMethodStatus,
  PayoutMethodType,
  PayoutStatus,
  Prisma,
} from "@prisma/client";
import db from "../db.server";
import { creatorEarning } from "./creator-sales";
import { DomainError, safeJson } from "./domain";
import { decimalMoneyToMinorUnits, formatMinorMoney } from "./money";
import {
  cleanPayoutString,
  decryptPayoutDetails,
  encryptPayoutDetails,
  maskPayoutDetails,
  parsePayoutAmountMinor,
  type PayoutDetails,
} from "./payouts";

const RESERVING_STATUSES: PayoutStatus[] = [
  PayoutStatus.REQUESTED,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
];
const CONSUMING_STATUSES: PayoutStatus[] = [PayoutStatus.PAID];
const ACTIVE_ALLOCATION_STATUSES = [...RESERVING_STATUSES, ...CONSUMING_STATUSES];

type DbClient = typeof db | Prisma.TransactionClient;

type PayoutSource = {
  sourceType: PayoutAllocationSourceType;
  sourceId: string;
  currency: string;
  amountMinor: bigint;
  createdAt: Date;
};

function normalizeCurrency(value: unknown) {
  const currency = cleanPayoutString(value, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError("INVALID_CURRENCY", "Choose a valid payout currency.");
  }
  return currency;
}

function validatePayPalDetails(input: Record<string, unknown>): PayoutDetails {
  const paypalEmail = cleanPayoutString(input.paypalEmail).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) {
    throw new DomainError("INVALID_PAYPAL_EMAIL", "Enter a valid PayPal email.");
  }
  return {
    paypalEmail,
    accountHolderName: cleanPayoutString(input.accountHolderName),
  };
}

function validateBankDetails(input: Record<string, unknown>): PayoutDetails {
  const details = {
    accountHolderName: cleanPayoutString(input.accountHolderName),
    bankName: cleanPayoutString(input.bankName),
    country: cleanPayoutString(input.country, 80),
    iban: cleanPayoutString(input.iban, 80),
    swiftBic: cleanPayoutString(input.swiftBic, 40),
    accountNumber: cleanPayoutString(input.accountNumber, 80),
    routingNumber: cleanPayoutString(input.routingNumber, 80),
  };
  if (!details.accountHolderName || !details.bankName || !details.country) {
    throw new DomainError(
      "BANK_DETAILS_INCOMPLETE",
      "Account holder, bank name, and country are required.",
    );
  }
  if (!details.iban && !(details.accountNumber && details.routingNumber)) {
    throw new DomainError(
      "BANK_DESTINATION_REQUIRED",
      "Provide IBAN or local account and routing details.",
    );
  }
  return details;
}

function validateMethodDetails(type: PayoutMethodType, input: Record<string, unknown>) {
  return type === PayoutMethodType.PAYPAL
    ? validatePayPalDetails(input)
    : validateBankDetails(input);
}

function netSaleAmount(sale: {
  grossSalesAmount: Prisma.Decimal;
  refundedSalesAmount: Prisma.Decimal;
}) {
  const net = sale.grossSalesAmount.minus(sale.refundedSalesAmount);
  return net.isNegative() ? new Prisma.Decimal(0) : net;
}

async function earningSources(shop: string, creatorId: string, tx: DbClient = db) {
  const [sales, referrals] = await Promise.all([
    tx.creatorSale.findMany({
      where: { shop, creatorId },
      select: {
        id: true,
        currencyCode: true,
        grossSalesAmount: true,
        refundedSalesAmount: true,
        commissionRateBps: true,
        paidAt: true,
        createdAt: true,
      },
    }),
    tx.referralEarning.findMany({
      where: { shop, referrerCreatorId: creatorId },
      select: {
        id: true,
        currencyCode: true,
        amountMinor: true,
        createdAt: true,
        adjustments: { select: { referralAdjustmentMinor: true } },
      },
    }),
  ]);
  const productSources: PayoutSource[] = sales.map((sale) => ({
    sourceType: PayoutAllocationSourceType.PRODUCT_EARNING,
    sourceId: sale.id,
    currency: sale.currencyCode,
    amountMinor: decimalMoneyToMinorUnits(
      creatorEarning(netSaleAmount(sale), sale.commissionRateBps),
    ),
    createdAt: sale.paidAt || sale.createdAt,
  }));
  const referralSources: PayoutSource[] = referrals.map((row) => ({
    sourceType: PayoutAllocationSourceType.REFERRAL_EARNING,
    sourceId: row.id,
    currency: row.currencyCode,
    amountMinor: row.adjustments.reduce(
      (total, adjustment) => total + adjustment.referralAdjustmentMinor,
      row.amountMinor,
    ),
    createdAt: row.createdAt,
  }));
  return [...productSources, ...referralSources];
}

async function allocatedBySource(shop: string, creatorId: string, tx: DbClient = db) {
  const allocations = await tx.payoutAllocation.findMany({
    where: {
      shop,
      payout: {
        creatorId,
        status: { in: ACTIVE_ALLOCATION_STATUSES },
      },
    },
    select: { sourceType: true, sourceId: true, amountMinor: true },
  });
  const totals = new Map<string, bigint>();
  for (const allocation of allocations) {
    const key = `${allocation.sourceType}:${allocation.sourceId}`;
    totals.set(key, (totals.get(key) || 0n) + allocation.amountMinor);
  }
  return totals;
}

async function payoutTotals(shop: string, creatorId: string, tx: DbClient = db) {
  const rows = await tx.payout.findMany({
    where: { shop, creatorId },
    select: { currency: true, requestedAmountMinor: true, status: true },
  });
  const totals = new Map<
    string,
    { paidMinor: bigint; reservedMinor: bigint }
  >();
  for (const row of rows) {
    const entry = totals.get(row.currency) || { paidMinor: 0n, reservedMinor: 0n };
    if (row.status === PayoutStatus.PAID) entry.paidMinor += row.requestedAmountMinor;
    if (RESERVING_STATUSES.includes(row.status)) {
      entry.reservedMinor += row.requestedAmountMinor;
    }
    totals.set(row.currency, entry);
  }
  return totals;
}

function serializeBalanceCurrency(input: {
  currency: string;
  productEarningsMinor: bigint;
  referralEarningsMinor: bigint;
  paidMinor: bigint;
  reservedMinor: bigint;
  minimumPayoutMinor: bigint;
}) {
  const totalEarnedMinor = input.productEarningsMinor + input.referralEarningsMinor;
  const availableMinor = totalEarnedMinor - input.paidMinor - input.reservedMinor;
  return {
    currency: input.currency,
    productEarningsMinor: input.productEarningsMinor.toString(),
    referralEarningsMinor: input.referralEarningsMinor.toString(),
    totalEarnedMinor: totalEarnedMinor.toString(),
    paidMinor: input.paidMinor.toString(),
    reservedMinor: input.reservedMinor.toString(),
    availableMinor: availableMinor.toString(),
    minimumPayoutMinor: input.minimumPayoutMinor.toString(),
    productEarnings: formatMinorMoney(input.productEarningsMinor, input.currency),
    referralEarnings: formatMinorMoney(input.referralEarningsMinor, input.currency),
    totalEarned: formatMinorMoney(totalEarnedMinor, input.currency),
    paid: formatMinorMoney(input.paidMinor, input.currency),
    reserved: formatMinorMoney(input.reservedMinor, input.currency),
    available: formatMinorMoney(availableMinor, input.currency),
    minimumPayout: formatMinorMoney(input.minimumPayoutMinor, input.currency),
    canWithdraw: availableMinor > 0n && availableMinor >= input.minimumPayoutMinor,
  };
}

export async function getCreatorPayoutBalance(input: {
  shop: string;
  creatorId: string;
  currency?: string;
}, tx: DbClient = db) {
  const [config, sources, payouts] = await Promise.all([
    tx.shopConfig.findUnique({
      where: { shop: input.shop },
      select: { minimumPayoutMinor: true },
    }),
    earningSources(input.shop, input.creatorId, tx),
    payoutTotals(input.shop, input.creatorId, tx),
  ]);
  const productTotals = new Map<string, bigint>();
  const referralTotals = new Map<string, bigint>();
  for (const source of sources) {
    const target =
      source.sourceType === PayoutAllocationSourceType.PRODUCT_EARNING
        ? productTotals
        : referralTotals;
    target.set(source.currency, (target.get(source.currency) || 0n) + source.amountMinor);
  }
  const currencies = [
    ...new Set([
      ...productTotals.keys(),
      ...referralTotals.keys(),
      ...payouts.keys(),
    ]),
  ].filter((currency) => !input.currency || currency === input.currency)
    .sort((a, b) => a.localeCompare(b));
  const balances = currencies.map((currency) => {
    const payout = payouts.get(currency) || { paidMinor: 0n, reservedMinor: 0n };
    return serializeBalanceCurrency({
      currency,
      productEarningsMinor: productTotals.get(currency) || 0n,
      referralEarningsMinor: referralTotals.get(currency) || 0n,
      paidMinor: payout.paidMinor,
      reservedMinor: payout.reservedMinor,
      minimumPayoutMinor: config?.minimumPayoutMinor || 0n,
    });
  });
  return {
    creatorId: input.creatorId,
    currencies: balances,
    selected: input.currency ? balances[0] || null : balances[0] || null,
  };
}

async function allocatePayout(input: {
  shop: string;
  creatorId: string;
  currency: string;
  amountMinor: bigint;
}, tx: Prisma.TransactionClient) {
  const [sources, allocated] = await Promise.all([
    earningSources(input.shop, input.creatorId, tx),
    allocatedBySource(input.shop, input.creatorId, tx),
  ]);
  let remaining = input.amountMinor;
  const allocations: Array<{
    shop: string;
    sourceType: PayoutAllocationSourceType;
    sourceId: string;
    currency: string;
    amountMinor: bigint;
  }> = [];
  const eligible = sources
    .filter((source) => source.currency === input.currency)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const source of eligible) {
    if (remaining <= 0n) break;
    const key = `${source.sourceType}:${source.sourceId}`;
    const available = source.amountMinor - (allocated.get(key) || 0n);
    if (available <= 0n) continue;
    const amountMinor = available > remaining ? remaining : available;
    allocations.push({
      shop: input.shop,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      currency: input.currency,
      amountMinor,
    });
    remaining -= amountMinor;
  }
  if (remaining > 0n) {
    throw new DomainError("PAYOUT_ALLOCATION_INSUFFICIENT", "Available earnings changed. Try a smaller amount.", 409);
  }
  return allocations;
}

export async function createPayoutMethod(input: {
  shop: string;
  creatorId: string;
  type: PayoutMethodType;
  details: Record<string, unknown>;
  isDefault?: boolean;
}) {
  const details = validateMethodDetails(input.type, input.details);
  const displayLabel = maskPayoutDetails(input.type, details);
  return db.$transaction(async (tx) => {
    const existingDefault = await tx.payoutMethod.findFirst({
      where: {
        shop: input.shop,
        creatorId: input.creatorId,
        status: PayoutMethodStatus.VERIFIED,
        isDefault: true,
      },
      select: { id: true },
    });
    const shouldBeDefault = Boolean(input.isDefault) || !existingDefault;
    if (shouldBeDefault) {
      await tx.payoutMethod.updateMany({
        where: { shop: input.shop, creatorId: input.creatorId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const method = await tx.payoutMethod.create({
      data: {
        shop: input.shop,
        creatorId: input.creatorId,
        type: input.type,
        status: PayoutMethodStatus.VERIFIED,
        isDefault: shouldBeDefault,
        displayLabel,
        encryptedDetails: encryptPayoutDetails(details),
      },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "CUSTOMER",
        actorId: input.creatorId,
        action: "payout_method.created",
        entityType: "PayoutMethod",
        entityId: method.id,
      },
    });
    return method;
  });
}

export async function updatePayoutMethod(input: {
  shop: string;
  creatorId: string;
  payoutMethodId: string;
  details: Record<string, unknown>;
  isDefault?: boolean;
}) {
  const existing = await db.payoutMethod.findFirst({
    where: { id: input.payoutMethodId, shop: input.shop, creatorId: input.creatorId },
  });
  if (!existing) {
    throw new DomainError("PAYOUT_METHOD_NOT_FOUND", "Payout method not found.", 404);
  }
  const details = validateMethodDetails(existing.type, input.details);
  const displayLabel = maskPayoutDetails(existing.type, details);
  return db.$transaction(async (tx) => {
    const shouldBeDefault = input.isDefault ?? existing.isDefault;
    if (shouldBeDefault) {
      await tx.payoutMethod.updateMany({
        where: { shop: input.shop, creatorId: input.creatorId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const method = await tx.payoutMethod.update({
      where: { id: existing.id },
      data: {
        displayLabel,
        encryptedDetails: encryptPayoutDetails(details),
        status: PayoutMethodStatus.VERIFIED,
        isDefault: shouldBeDefault,
      },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "CUSTOMER",
        actorId: input.creatorId,
        action: "payout_method.updated",
        entityType: "PayoutMethod",
        entityId: method.id,
      },
    });
    return method;
  });
}

export async function listCreatorPayoutMethods(input: {
  shop: string;
  creatorId: string;
}) {
  return db.payoutMethod.findMany({
    where: { shop: input.shop, creatorId: input.creatorId },
    orderBy: [{ isDefault: "desc" }, { status: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      type: true,
      status: true,
      isDefault: true,
      displayLabel: true,
      encryptedDetails: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function requestCreatorPayout(input: {
  shop: string;
  creatorId: string;
  payoutMethodId: string;
  currency: unknown;
  amount: unknown;
  creatorNote?: string;
}) {
  const currency = normalizeCurrency(input.currency);
  const amountMinor = parsePayoutAmountMinor(input.amount);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.shop}:${input.creatorId}:${currency}`}))`;
      const creator = await tx.creator.findFirst({
        where: { id: input.creatorId, shop: input.shop },
        select: { id: true, status: true },
      });
      if (!creator || creator.status !== CreatorStatus.APPROVED) {
        throw new DomainError("CREATOR_NOT_ELIGIBLE", "Only approved creators can request payouts.", 403);
      }
      const method = await tx.payoutMethod.findFirst({
        where: {
          id: input.payoutMethodId,
          shop: input.shop,
          creatorId: input.creatorId,
          status: PayoutMethodStatus.VERIFIED,
        },
      });
      if (!method) {
        throw new DomainError("PAYOUT_METHOD_UNAVAILABLE", "Add a payout method before requesting a withdrawal.", 422);
      }
      const balance = await getCreatorPayoutBalance({
        shop: input.shop,
        creatorId: input.creatorId,
        currency,
      }, tx);
      const selected = balance.selected;
      if (!selected) {
        throw new DomainError("PAYOUT_CURRENCY_UNAVAILABLE", "No earnings exist for this currency.", 422);
      }
      const availableMinor = BigInt(selected.availableMinor);
      const minimumPayoutMinor = BigInt(selected.minimumPayoutMinor);
      if (amountMinor > availableMinor) {
        throw new DomainError("PAYOUT_AMOUNT_EXCEEDS_AVAILABLE", "Amount exceeds available balance.", 422);
      }
      if (minimumPayoutMinor > 0n && amountMinor < minimumPayoutMinor) {
        throw new DomainError("PAYOUT_BELOW_MINIMUM", "Amount is below the configured minimum payout.", 422);
      }
      const allocations = await allocatePayout({
        shop: input.shop,
        creatorId: input.creatorId,
        currency,
        amountMinor,
      }, tx);
      const payout = await tx.payout.create({
        data: {
          shop: input.shop,
          creatorId: input.creatorId,
          payoutMethodId: method.id,
          methodTypeSnapshot: method.type,
          methodDisplaySnapshot: method.displayLabel,
          encryptedMethodSnapshot: method.encryptedDetails,
          currency,
          requestedAmountMinor: amountMinor,
          feeMinor: 0n,
          netAmountMinor: amountMinor,
          creatorNote: cleanPayoutString(input.creatorNote, 1000) || null,
          allocations: { create: allocations },
        },
        include: { allocations: true },
      });
      await tx.auditLog.create({
        data: {
          shop: input.shop,
          actorType: "CUSTOMER",
          actorId: input.creatorId,
          action: "payout.requested",
          entityType: "Payout",
          entityId: payout.id,
        },
      });
      return payout;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function cancelCreatorPayout(input: {
  shop: string;
  creatorId: string;
  payoutId: string;
}) {
  return db.$transaction(async (tx) => {
    const payout = await tx.payout.findFirst({
      where: { id: input.payoutId, shop: input.shop, creatorId: input.creatorId },
    });
    if (!payout) throw new DomainError("PAYOUT_NOT_FOUND", "Payout not found.", 404);
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new DomainError("PAYOUT_CANNOT_CANCEL", "Only requested payouts can be cancelled.", 409);
    }
    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: { status: PayoutStatus.CANCELLED, cancelledAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "CUSTOMER",
        actorId: input.creatorId,
        action: "payout.cancelled",
        entityType: "Payout",
        entityId: payout.id,
        beforeJson: safeJson({ status: payout.status }),
        afterJson: safeJson({ status: updated.status }),
      },
    });
    return updated;
  });
}

export async function listCreatorPayouts(input: {
  shop: string;
  creatorId: string;
}) {
  return db.payout.findMany({
    where: { shop: input.shop, creatorId: input.creatorId },
    orderBy: { requestedAt: "desc" },
    include: { allocations: true },
    take: 50,
  });
}

export function serializePayout(payout: {
  id: string;
  currency: string;
  requestedAmountMinor: bigint;
  feeMinor: bigint;
  netAmountMinor: bigint;
  status: PayoutStatus;
  methodDisplaySnapshot: string;
  methodTypeSnapshot: PayoutMethodType;
  requestedAt: Date;
  approvedAt: Date | null;
  paidAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  transactionReference: string | null;
  creatorNote: string | null;
  adminNote: string | null;
  rejectionReason: string | null;
  allocations?: Array<{ sourceType: PayoutAllocationSourceType; amountMinor: bigint }>;
}) {
  const productMinor = payout.allocations
    ?.filter((allocation) => allocation.sourceType === PayoutAllocationSourceType.PRODUCT_EARNING)
    .reduce((total, allocation) => total + allocation.amountMinor, 0n) || 0n;
  const referralMinor = payout.allocations
    ?.filter((allocation) => allocation.sourceType === PayoutAllocationSourceType.REFERRAL_EARNING)
    .reduce((total, allocation) => total + allocation.amountMinor, 0n) || 0n;
  return {
    id: payout.id,
    currency: payout.currency,
    amount: formatMinorMoney(payout.requestedAmountMinor, payout.currency),
    requestedAmount: formatMinorMoney(payout.requestedAmountMinor, payout.currency),
    fee: formatMinorMoney(payout.feeMinor, payout.currency),
    netAmount: formatMinorMoney(payout.netAmountMinor, payout.currency),
    productAllocation: formatMinorMoney(productMinor, payout.currency),
    referralAllocation: formatMinorMoney(referralMinor, payout.currency),
    status: payout.status,
    method: payout.methodDisplaySnapshot,
    methodType: payout.methodTypeSnapshot,
    requestedAt: payout.requestedAt,
    approvedAt: payout.approvedAt,
    paidAt: payout.paidAt,
    rejectedAt: payout.rejectedAt,
    cancelledAt: payout.cancelledAt,
    transactionReference: payout.transactionReference,
    creatorNote: payout.creatorNote,
    adminNote: payout.adminNote,
    rejectionReason: payout.rejectionReason,
  };
}

function serializePayoutMethod(method: {
  id: string;
  type: PayoutMethodType;
  status: PayoutMethodStatus;
  isDefault: boolean;
  displayLabel: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: method.id,
    type: method.type,
    status: method.status,
    isDefault: method.isDefault,
    displayLabel: method.displayLabel,
    createdAt: method.createdAt,
    updatedAt: method.updatedAt,
  };
}

function editablePayoutMethodDetails(method: {
  type: PayoutMethodType;
  encryptedDetails?: string | null;
}) {
  if (!method.encryptedDetails) return null;
  try {
    const details = decryptPayoutDetails(method.encryptedDetails);
    if (method.type === PayoutMethodType.PAYPAL) {
      return {
        paypalEmail: cleanPayoutString(details.paypalEmail).toLowerCase(),
        accountHolderName: cleanPayoutString(details.accountHolderName),
      };
    }
    return {
      accountHolderName: cleanPayoutString(details.accountHolderName),
      bankName: cleanPayoutString(details.bankName),
      country: cleanPayoutString(details.country),
      iban: cleanPayoutString(details.iban),
      swiftBic: cleanPayoutString(details.swiftBic),
      accountNumber: cleanPayoutString(details.accountNumber),
      routingNumber: cleanPayoutString(details.routingNumber),
    };
  } catch {
    return null;
  }
}

function serializeCreatorPayoutMethod(method: Parameters<typeof serializePayoutMethod>[0] & {
  encryptedDetails?: string | null;
}) {
  return {
    ...serializePayoutMethod(method),
    editDetails: editablePayoutMethodDetails(method),
  };
}

export async function payoutDashboardForCreator(input: {
  shop: string;
  creatorId: string;
}) {
  const [balance, methods, payouts] = await Promise.all([
    getCreatorPayoutBalance(input),
    listCreatorPayoutMethods(input),
    listCreatorPayouts(input),
  ]);
  return {
    balance,
    methods: methods.map(serializeCreatorPayoutMethod),
    payouts: payouts.map(serializePayout),
  };
}

export async function adminPayoutMethodsSummary(shop: string, filters: {
  status?: string | null;
  page?: number;
  pageSize?: number;
} = {}) {
  const where: Prisma.PayoutMethodWhereInput = {
    shop,
    ...(filters.status && filters.status in PayoutMethodStatus
      ? { status: filters.status as PayoutMethodStatus }
      : {}),
  };
  const page = Math.max(filters.page || 1, 1);
  const pageSize = Math.min(Math.max(filters.pageSize || 25, 1), 100);
  const [rows, total, statusCounts] = await Promise.all([
    db.payoutMethod.findMany({
      where,
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        creator: { select: { id: true, displayName: true, emailSnapshot: true, status: true } },
      },
    }),
    db.payoutMethod.count({ where }),
    db.payoutMethod.groupBy({
      by: ["status"],
      where: { shop },
      _count: { _all: true },
    }),
  ]);
  return {
    rows: rows.map((row) => ({
      ...serializePayoutMethod(row),
      creator: row.creator,
    })),
    total,
    page,
    pageSize,
    statusCounts: Object.fromEntries(
      statusCounts.map((item) => [item.status, item._count._all]),
    ),
  };
}

export async function adminPayoutsSummary(shop: string, filters: {
  status?: string | null;
  currency?: string | null;
  page?: number;
  pageSize?: number;
} = {}) {
  const where: Prisma.PayoutWhereInput = {
    shop,
    ...(filters.status && filters.status in PayoutStatus
      ? { status: filters.status as PayoutStatus }
      : {}),
    ...(filters.currency ? { currency: filters.currency.toUpperCase() } : {}),
  };
  const page = Math.max(filters.page || 1, 1);
  const pageSize = Math.min(Math.max(filters.pageSize || 25, 1), 100);
  const [rows, total, statusCounts] = await Promise.all([
    db.payout.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        creator: { select: { id: true, displayName: true, emailSnapshot: true, status: true } },
        allocations: true,
      },
    }),
    db.payout.count({ where }),
    db.payout.groupBy({
      by: ["status"],
      where: { shop },
      _count: { _all: true },
    }),
  ]);
  return {
    rows: rows.map((row) => ({
      ...serializePayout(row),
      creator: row.creator,
    })),
    total,
    page,
    pageSize,
    statusCounts: Object.fromEntries(
      statusCounts.map((item) => [item.status, item._count._all]),
    ),
  };
}

export async function adminPayoutDetail(shop: string, payoutId: string) {
  const payout = await db.payout.findFirst({
    where: { shop, id: payoutId },
    include: {
      creator: { select: { id: true, displayName: true, emailSnapshot: true, status: true } },
      allocations: true,
    },
  });
  if (!payout) throw new DomainError("PAYOUT_NOT_FOUND", "Payout not found.", 404);
  let methodDetails: PayoutDetails = {};
  let methodDetailsError: string | null = null;
  try {
    methodDetails = decryptPayoutDetails(payout.encryptedMethodSnapshot);
  } catch {
    methodDetailsError = "The saved payout destination snapshot could not be decrypted. Check payout encryption configuration before sending payment.";
  }
  return {
    ...serializePayout(payout),
    creator: payout.creator,
    methodDetails,
    methodDetailsError,
  };
}

export async function verifyPayoutMethod(input: {
  shop: string;
  payoutMethodId: string;
}) {
  return db.$transaction(async (tx) => {
    const method = await tx.payoutMethod.findFirst({
      where: { shop: input.shop, id: input.payoutMethodId },
    });
    if (!method) throw new DomainError("PAYOUT_METHOD_NOT_FOUND", "Payout method not found.", 404);
    const verifiedDefault = await tx.payoutMethod.findFirst({
      where: {
        shop: input.shop,
        creatorId: method.creatorId,
        status: PayoutMethodStatus.VERIFIED,
        isDefault: true,
      },
      select: { id: true },
    });
    if (method.isDefault) {
      await tx.payoutMethod.updateMany({
        where: {
          shop: input.shop,
          creatorId: method.creatorId,
          id: { not: method.id },
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }
    const updated = await tx.payoutMethod.update({
      where: { id: method.id },
      data: {
        status: PayoutMethodStatus.VERIFIED,
        isDefault: method.isDefault || !verifiedDefault,
      },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "ADMIN",
        action: "payout_method.verified",
        entityType: "PayoutMethod",
        entityId: method.id,
        beforeJson: safeJson({ status: method.status }),
        afterJson: safeJson({ status: updated.status }),
      },
    });
    return updated;
  });
}

export async function disablePayoutMethod(input: {
  shop: string;
  payoutMethodId: string;
}) {
  return db.$transaction(async (tx) => {
    const method = await tx.payoutMethod.findFirst({
      where: { shop: input.shop, id: input.payoutMethodId },
    });
    if (!method) throw new DomainError("PAYOUT_METHOD_NOT_FOUND", "Payout method not found.", 404);
    const updated = await tx.payoutMethod.update({
      where: { id: method.id },
      data: { status: PayoutMethodStatus.DISABLED, isDefault: false },
    });
    const replacement = method.isDefault
      ? await tx.payoutMethod.findFirst({
          where: {
            shop: input.shop,
            creatorId: method.creatorId,
            status: PayoutMethodStatus.VERIFIED,
            isDefault: false,
          },
          orderBy: { updatedAt: "desc" },
        })
      : null;
    if (replacement) {
      await tx.payoutMethod.update({
        where: { id: replacement.id },
        data: { isDefault: true },
      });
    }
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "ADMIN",
        action: "payout_method.disabled",
        entityType: "PayoutMethod",
        entityId: method.id,
        beforeJson: safeJson({ status: method.status, isDefault: method.isDefault }),
        afterJson: safeJson({ status: updated.status, isDefault: false }),
      },
    });
    return updated;
  });
}

export async function approvePayout(input: {
  shop: string;
  payoutId: string;
  adminNote?: string;
}) {
  return db.$transaction(
    async (tx) => {
      const payout = await tx.payout.findFirst({
        where: { shop: input.shop, id: input.payoutId },
      });
      if (!payout) throw new DomainError("PAYOUT_NOT_FOUND", "Payout not found.", 404);
      if (payout.status !== PayoutStatus.REQUESTED) {
        throw new DomainError("PAYOUT_INVALID_STATUS", "Only requested payouts can be approved.", 409);
      }
      const balance = await getCreatorPayoutBalance({
        shop: input.shop,
        creatorId: payout.creatorId,
        currency: payout.currency,
      }, tx);
      const selected = balance.selected;
      if (!selected) throw new DomainError("PAYOUT_BALANCE_CHANGED", "Payout balance changed.", 409);
      const availableWithOwnReservation =
        BigInt(selected.availableMinor) + payout.requestedAmountMinor;
      if (availableWithOwnReservation < payout.requestedAmountMinor) {
        throw new DomainError("PAYOUT_BALANCE_CHANGED", "Payout balance changed. Reject and request a new amount.", 409);
      }
      const updated = await tx.payout.update({
        where: { id: payout.id },
        data: {
          status: PayoutStatus.APPROVED,
          approvedAt: new Date(),
          adminNote: cleanPayoutString(input.adminNote, 1000) || payout.adminNote,
        },
      });
      await tx.auditLog.create({
        data: {
          shop: input.shop,
          actorType: "ADMIN",
          action: "payout.approved",
          entityType: "Payout",
          entityId: payout.id,
          beforeJson: safeJson({ status: payout.status }),
          afterJson: safeJson({ status: updated.status }),
        },
      });
      return updated;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function rejectPayout(input: {
  shop: string;
  payoutId: string;
  rejectionReason: string;
  adminNote?: string;
}) {
  const reason = cleanPayoutString(input.rejectionReason, 1000);
  if (!reason) throw new DomainError("REJECTION_REASON_REQUIRED", "Enter a rejection reason.");
  return db.$transaction(async (tx) => {
    const payout = await tx.payout.findFirst({ where: { shop: input.shop, id: input.payoutId } });
    if (!payout) throw new DomainError("PAYOUT_NOT_FOUND", "Payout not found.", 404);
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new DomainError("PAYOUT_INVALID_STATUS", "Only requested payouts can be rejected.", 409);
    }
    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: reason,
        adminNote: cleanPayoutString(input.adminNote, 1000) || payout.adminNote,
      },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "ADMIN",
        action: "payout.rejected",
        entityType: "Payout",
        entityId: payout.id,
        beforeJson: safeJson({ status: payout.status }),
        afterJson: safeJson({ status: updated.status, reasonPresent: true }),
      },
    });
    return updated;
  });
}

export async function markPayoutPaid(input: {
  shop: string;
  payoutId: string;
  transactionReference: string;
  adminNote?: string;
}) {
  const transactionReference = cleanPayoutString(input.transactionReference, 255);
  if (!transactionReference) {
    throw new DomainError("TRANSACTION_REFERENCE_REQUIRED", "Enter the manual payment reference.");
  }
  return db.$transaction(async (tx) => {
    const payout = await tx.payout.findFirst({ where: { shop: input.shop, id: input.payoutId } });
    if (!payout) throw new DomainError("PAYOUT_NOT_FOUND", "Payout not found.", 404);
    if (payout.status !== PayoutStatus.APPROVED) {
      throw new DomainError("PAYOUT_INVALID_STATUS", "Only approved payouts can be marked paid.", 409);
    }
    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: {
        status: PayoutStatus.PAID,
        paidAt: new Date(),
        transactionReference,
        adminNote: cleanPayoutString(input.adminNote, 1000) || payout.adminNote,
      },
    });
    await tx.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "ADMIN",
        action: "payout.marked_paid",
        entityType: "Payout",
        entityId: payout.id,
        beforeJson: safeJson({ status: payout.status }),
        afterJson: safeJson({ status: updated.status, transactionReferencePresent: true }),
      },
    });
    return updated;
  });
}

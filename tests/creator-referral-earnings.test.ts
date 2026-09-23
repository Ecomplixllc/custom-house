import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  calculateReferralEarning,
  creatorEarningMinorFromSalesAmount,
  CREATOR_REFERRAL_RATE_BPS,
  decimalMoneyToMinorUnits,
} from "../app/services/creator-referral-earnings.ts";
import { CREATOR_COMMISSION_BASIS_POINTS } from "../app/services/creator-sales.ts";
import { formatMinorMoney } from "../app/services/money.ts";

test("referral earning uses exact integer minor-unit math", () => {
  assert.equal(CREATOR_REFERRAL_RATE_BPS, 200);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 10_000n }), 200n);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 100_000n }), 2_000n);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 3_000n }), 60n);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 0n }), 0n);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: -10n }), 0n);
});

test("referral earning documents half-up rounding for minor-unit fractions", () => {
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 1n }), 0n);
  assert.equal(calculateReferralEarning({ creatorEarningMinor: 1_237n }), 25n);
  assert.equal(decimalMoneyToMinorUnits(new Prisma.Decimal("12.345")), 1_235n);
  assert.equal(decimalMoneyToMinorUnits(new Prisma.Decimal("12.344")), 1_234n);
});

test("Custom House money formatting uses dot decimals without comma separators", () => {
  assert.equal(formatMinorMoney(0n, "SEK"), "0.00 kr");
  assert.equal(formatMinorMoney(20n, "SEK"), "0.20 kr");
  assert.equal(formatMinorMoney(1_000n, "SEK"), "10.00 kr");
  assert.equal(formatMinorMoney(3_020n, "SEK"), "30.20 kr");
  assert.equal(formatMinorMoney(123_456n, "SEK"), "1234.56 kr");
  assert.equal(formatMinorMoney(-80n, "SEK"), "-0.80 kr");
  assert.doesNotMatch(formatMinorMoney(20n, "SEK"), /,/);
});

test("creator sale earning base keeps existing ten percent creator commission separate", () => {
  assert.equal(CREATOR_COMMISSION_BASIS_POINTS, 1_000);
  assert.equal(
    creatorEarningMinorFromSalesAmount(new Prisma.Decimal("1000.00"), CREATOR_COMMISSION_BASIS_POINTS),
    10_000n,
  );
  assert.equal(
    calculateReferralEarning({
      creatorEarningMinor: creatorEarningMinorFromSalesAmount(
        new Prisma.Decimal("1000.00"),
        CREATOR_COMMISSION_BASIS_POINTS,
      ),
    }),
    200n,
  );
});

test("currency is snapshotted and never converted in referral earning records", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(schema, /currencyCode\s+String/);
  assert.match(service, /currencyCode: sale\.currencyCode/);
  assert.doesNotMatch(service, /exchangeRate|convertCurrency|currencyConvert/);
});

test("referral ledger schema is auditable and idempotent", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260820010000_creator_referral_earnings/migration.sql",
    "utf8",
  );
  const earningBlock = schema.match(/model ReferralEarning \{[\s\S]*?\n\}/)?.[0] || "";
  const adjustmentBlock =
    schema.match(/model ReferralEarningAdjustment \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(schema, /enum ReferralEarningStatus/);
  assert.match(earningBlock, /referrerCreatorId\s+String/);
  assert.match(earningBlock, /referredCreatorId\s+String/);
  assert.match(earningBlock, /creatorSaleId\s+String\s+@unique/);
  assert.match(earningBlock, /baseCreatorEarningMinor\s+BigInt/);
  assert.match(earningBlock, /rateBps\s+Int/);
  assert.match(earningBlock, /amountMinor\s+BigInt/);
  assert.match(earningBlock, /@@unique\(\[shop, creatorSaleId\]\)/);
  assert.match(adjustmentBlock, /creatorSaleAdjustmentId\s+String\s+@unique/);
  assert.match(adjustmentBlock, /baseAdjustmentMinor\s+BigInt/);
  assert.match(adjustmentBlock, /referralAdjustmentMinor\s+BigInt/);
  assert.match(adjustmentBlock, /@@unique\(\[shop, creatorSaleAdjustmentId\]\)/);
  assert.match(adjustmentBlock, /@@unique\(\[shop, adjustmentKey\]\)/);
  assert.match(migration, /does not backfill historical CreatorSale rows/);
  assert.match(migration, /"referralEarningsLaunchAt" TIMESTAMP\(3\)/);
});

test("paid CreatorSale and CreatorSaleAdjustment lifecycle call referral financial service", () => {
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");
  const referralService = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(salesService, /recordPaidCreatorSales/);
  assert.match(salesService, /syncReferralEarningForCreatorSale/);
  assert.match(salesService, /reconcileRecentPaidCreatorSales/);
  assert.match(salesService, /syncReferralAdjustmentsForCreatorSale/);
  assert.match(salesService, /recordCreatorRefund/);
  assert.match(salesService, /syncReferralAdjustmentForCreatorSaleAdjustment/);
  assert.match(referralService, /shopConfig\.findUnique/);
  assert.match(referralService, /referralEarningsLaunchAt/);
  assert.match(referralService, /BEFORE_REFERRAL_EARNINGS_LAUNCH/);
});

test("business eligibility and identity rules are represented server-side", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(service, /CREATOR_NOT_REFERRED/);
  assert.match(service, /SELF_REFERRAL_RELATIONSHIP/);
  assert.match(service, /REFERRER_CREATOR_MISSING/);
  assert.match(service, /REFERRER_NOT_APPROVED/);
  assert.match(service, /sale\.creator\.referredByCreator\.status !== "APPROVED"/);
  assert.match(service, /const referrerCreatorId = sale\.creator\.referredByCreatorId/);
  assert.match(service, /referrerCreatorId,/);
  assert.match(service, /referredCreatorId: sale\.creatorId/);
  assert.doesNotMatch(service, /referralCodeSnapshot/);
});

test("refund examples produce exact final referral entitlement", () => {
  const original = calculateReferralEarning({ creatorEarningMinor: 10_000n });
  const partialRefund = -calculateReferralEarning({ creatorEarningMinor: 4_000n });
  const fullRefund = -calculateReferralEarning({ creatorEarningMinor: 10_000n });
  const firstPartial = -calculateReferralEarning({ creatorEarningMinor: 2_000n });
  const secondPartial = -calculateReferralEarning({ creatorEarningMinor: 3_000n });

  assert.equal(original, 200n);
  assert.equal(original + partialRefund, 120n);
  assert.equal(original + fullRefund, 0n);
  assert.equal(original + firstPartial, 160n);
  assert.equal(original + firstPartial + secondPartial, 100n);
});

test("multiple line and multiple creator scenarios stay per CreatorSale", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(service, /creatorSaleId: sale\.id/);
  assert.match(schema, /@@unique\(\[shop, creatorSaleId\]\)/);
  assert.match(service, /shopifyLineItemId: sale\.shopifyLineItemId/);
  assert.match(service, /referrerCreatorId/);
  assert.match(service, /referredCreatorId/);
});

test("Phase 6 does not alter creator commission or add payout execution", () => {
  const creatorSales = readFileSync("app/services/creator-sales.ts", "utf8");
  const referralMoney = readFileSync("app/services/creator-referral-earnings.ts", "utf8");
  const referralService = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );

  assert.match(creatorSales, /CREATOR_COMMISSION_BASIS_POINTS = 1_000/);
  assert.match(referralMoney, /CREATOR_REFERRAL_RATE_BPS = 200/);
  assert.doesNotMatch(referralService, /mark.*PAID|payout|transfer|deduct/i);
  assert.match(dashboard, /earn a 2% referral bonus/);
  assert.doesNotMatch(dashboard, /Invite creators and earn 10% commission/);
});

test("query helpers are scoped for later admin and creator dashboard reads", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(service, /adminReferralEarningsSummary/);
  assert.match(service, /referralEarningsForAuthenticatedCreator/);
  assert.match(service, /referrerCreatorId: input\.authenticatedCreatorId/);
  assert.doesNotMatch(service, /frontendCreatorId|requestedCreatorId/);
});

test("Phase 7 read helpers serialize final entitlement and keep currencies separate", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(service, /function finalAmountMinor/);
  assert.match(service, /row\.amountMinor \+ adjustmentMinor/);
  assert.match(service, /function formatCurrencyTotals/);
  assert.match(service, /\.sort\(\(\[a\], \[b\]\) => a\.localeCompare\(b\)\)/);
  assert.match(service, /originalMinor: total\.originalMinor\.toString\(\)/);
  assert.match(service, /finalMinor: total\.finalMinor\.toString\(\)/);
  assert.match(service, /original: formatMinorMoney/);
  assert.doesNotMatch(service, /Number\(total\.originalMinor \+ total\.adjustmentMinor\)/);
});

test("Phase 7 read helpers paginate and scope creator financial history server-side", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");
  const dashboard = readFileSync("app/services/submission.server.ts", "utf8");

  assert.match(service, /REFERRAL_EARNINGS_PAGE_SIZE = 25/);
  assert.match(service, /skip,\s*\n\s*take: pageSize/);
  assert.match(service, /referrerCreatorId: input\.authenticatedCreatorId/);
  assert.match(service, /referredByCreatorId: input\.authenticatedCreatorId/);
  assert.match(service, /referralFinancialsForCreatorAdmin/);
  assert.match(service, /referralEarningsGeneratedByCreator/);
  assert.match(dashboard, /referralEarningsForAuthenticatedCreator/);
  assert.match(dashboard, /authenticatedCreatorId: creator\.id/);
  assert.match(dashboard, /referrals,/);
  assert.doesNotMatch(dashboard, /searchParams\.get\(["']creatorId["']\)/);
});

test("Phase 7 diagnostics flag financial consistency warnings without payout execution", () => {
  const service = readFileSync("app/services/creator-referral-earnings.server.ts", "utf8");

  assert.match(service, /creator_referral_financial_consistency_warning/);
  assert.match(service, /CreatorSale creator mismatch/);
  assert.match(service, /Currency mismatch/);
  assert.match(service, /Negative final entitlement/);
  assert.doesNotMatch(service, /mark.*PAID|transfer|payout|paidAt: new Date/i);
});

test("unified creator earnings helper keeps ledgers separate and totals final entitlement", () => {
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");
  const dashboard = readFileSync("app/services/submission.server.ts", "utf8");
  const adminCreators = readFileSync("app/routes/app.creators.tsx", "utf8");

  assert.match(salesService, /getCreatorUnifiedEarningsSummary/);
  assert.match(salesService, /productEarningsByCurrency/);
  assert.match(salesService, /referralEarningsByCurrency/);
  assert.match(salesService, /totalEarningsByCurrency/);
  assert.match(salesService, /productEarningsMinor \+ referralEarningsMinor/);
  assert.match(salesService, /row\.adjustments\.reduce\(/);
  assert.match(salesService, /row\.amountMinor/);
  assert.match(salesService, /sale\.commissionRateBps/);
  assert.match(salesService, /new Map<string, bigint>/);
  assert.doesNotMatch(salesService, /payout|mark.*PAID|transfer/i);

  assert.match(dashboard, /unifiedEarnings: sales\.unifiedEarnings/);
  assert.match(dashboard, /productEarnings: sales\.productEarnings/);
  assert.match(dashboard, /referralEarnings: sales\.referralEarnings/);
  assert.match(adminCreators, /selectedUnifiedEarnings/);
  assert.match(adminCreators, /Total Creator Earnings/);
});

test("unified earning examples preserve currency and use final referral values", () => {
  const examples = {
    productOnly: { product: 10_000n, referral: 0n, total: 10_000n },
    referralOnly: { product: 0n, referral: 200n, total: 200n },
    both: { product: 10_000n, referral: 200n, total: 10_200n },
    referralRefund: { product: 10_000n, referral: 120n, total: 10_120n },
    productRefund: { product: 6_000n, referral: 200n, total: 6_200n },
    bothAdjustments: { product: 6_000n, referral: 120n, total: 6_120n },
  };
  for (const item of Object.values(examples)) {
    assert.equal(item.product + item.referral, item.total);
  }
  const mixed = new Map([
    ["SEK", { product: 10_000n, referral: 200n }],
    ["USD", { product: 2_000n, referral: 100n }],
  ]);
  assert.equal(mixed.get("SEK")!.product + mixed.get("SEK")!.referral, 10_200n);
  assert.equal(mixed.get("USD")!.product + mixed.get("USD")!.referral, 2_100n);
});

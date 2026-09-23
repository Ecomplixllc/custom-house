-- Phase 6: creator referral financial ledger.
-- This migration is forward-only and does not backfill historical CreatorSale rows.

CREATE TYPE "ReferralEarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID', 'REVERSED');

ALTER TABLE "ShopConfig"
ADD COLUMN "referralEarningsLaunchAt" TIMESTAMP(3);

CREATE TABLE "ReferralEarning" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "referrerCreatorId" TEXT NOT NULL,
    "referredCreatorId" TEXT NOT NULL,
    "creatorSaleId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "baseCreatorEarningMinor" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "ReferralEarningStatus" NOT NULL DEFAULT 'AVAILABLE',
    "confirmedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralEarning_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralEarningAdjustment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "referralEarningId" TEXT NOT NULL,
    "creatorSaleAdjustmentId" TEXT NOT NULL,
    "adjustmentKey" TEXT NOT NULL,
    "baseAdjustmentMinor" BIGINT NOT NULL,
    "referralAdjustmentMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REFUND',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEarningAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralEarning_creatorSaleId_key" ON "ReferralEarning"("creatorSaleId");
CREATE UNIQUE INDEX "ReferralEarning_shop_creatorSaleId_key" ON "ReferralEarning"("shop", "creatorSaleId");
CREATE INDEX "ReferralEarning_shop_referrerCreatorId_status_idx" ON "ReferralEarning"("shop", "referrerCreatorId", "status");
CREATE INDEX "ReferralEarning_shop_referredCreatorId_idx" ON "ReferralEarning"("shop", "referredCreatorId");
CREATE INDEX "ReferralEarning_shop_currencyCode_status_idx" ON "ReferralEarning"("shop", "currencyCode", "status");

CREATE UNIQUE INDEX "ReferralEarningAdjustment_creatorSaleAdjustmentId_key" ON "ReferralEarningAdjustment"("creatorSaleAdjustmentId");
CREATE UNIQUE INDEX "ReferralEarningAdjustment_shop_creatorSaleAdjustmentId_key" ON "ReferralEarningAdjustment"("shop", "creatorSaleAdjustmentId");
CREATE UNIQUE INDEX "ReferralEarningAdjustment_shop_adjustmentKey_key" ON "ReferralEarningAdjustment"("shop", "adjustmentKey");
CREATE INDEX "ReferralEarningAdjustment_shop_referralEarningId_idx" ON "ReferralEarningAdjustment"("shop", "referralEarningId");

ALTER TABLE "ReferralEarning"
ADD CONSTRAINT "ReferralEarning_referrerCreatorId_fkey"
FOREIGN KEY ("referrerCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralEarning"
ADD CONSTRAINT "ReferralEarning_referredCreatorId_fkey"
FOREIGN KEY ("referredCreatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralEarning"
ADD CONSTRAINT "ReferralEarning_creatorSaleId_fkey"
FOREIGN KEY ("creatorSaleId") REFERENCES "CreatorSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralEarningAdjustment"
ADD CONSTRAINT "ReferralEarningAdjustment_referralEarningId_fkey"
FOREIGN KEY ("referralEarningId") REFERENCES "ReferralEarning"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralEarningAdjustment"
ADD CONSTRAINT "ReferralEarningAdjustment_creatorSaleAdjustmentId_fkey"
FOREIGN KEY ("creatorSaleAdjustmentId") REFERENCES "CreatorSaleAdjustment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manual creator payout system. Forward-only, no historical payout backfill.

CREATE TYPE "PayoutMethodType" AS ENUM ('PAYPAL', 'BANK_TRANSFER');
CREATE TYPE "PayoutMethodStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'DISABLED');
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED', 'FAILED');
CREATE TYPE "PayoutAllocationSourceType" AS ENUM ('PRODUCT_EARNING', 'REFERRAL_EARNING');
CREATE TYPE "PayoutExecutionMode" AS ENUM ('MANUAL');

ALTER TABLE "ShopConfig"
ADD COLUMN "minimumPayoutMinor" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "PayoutMethod" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "type" "PayoutMethodType" NOT NULL,
  "status" "PayoutMethodStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "displayLabel" TEXT NOT NULL,
  "encryptedDetails" TEXT NOT NULL,
  "externalRecipientId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payout" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "payoutMethodId" TEXT,
  "methodTypeSnapshot" "PayoutMethodType" NOT NULL,
  "methodDisplaySnapshot" TEXT NOT NULL,
  "encryptedMethodSnapshot" TEXT NOT NULL,
  "executionMode" "PayoutExecutionMode" NOT NULL DEFAULT 'MANUAL',
  "currency" TEXT NOT NULL,
  "requestedAmountMinor" BIGINT NOT NULL,
  "feeMinor" BIGINT NOT NULL DEFAULT 0,
  "netAmountMinor" BIGINT NOT NULL,
  "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" TIMESTAMP(3),
  "processingAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "transactionReference" TEXT,
  "creatorNote" TEXT,
  "adminNote" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutAllocation" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "sourceType" "PayoutAllocationSourceType" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayoutMethod_shop_creatorId_status_idx" ON "PayoutMethod"("shop", "creatorId", "status");
CREATE INDEX "PayoutMethod_shop_creatorId_isDefault_idx" ON "PayoutMethod"("shop", "creatorId", "isDefault");
CREATE INDEX "Payout_shop_creatorId_status_idx" ON "Payout"("shop", "creatorId", "status");
CREATE INDEX "Payout_shop_status_requestedAt_idx" ON "Payout"("shop", "status", "requestedAt");
CREATE INDEX "Payout_shop_currency_status_idx" ON "Payout"("shop", "currency", "status");
CREATE INDEX "PayoutAllocation_shop_sourceType_sourceId_idx" ON "PayoutAllocation"("shop", "sourceType", "sourceId");
CREATE INDEX "PayoutAllocation_shop_payoutId_idx" ON "PayoutAllocation"("shop", "payoutId");

ALTER TABLE "PayoutMethod"
ADD CONSTRAINT "PayoutMethod_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payout"
ADD CONSTRAINT "Payout_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payout"
ADD CONSTRAINT "Payout_payoutMethodId_fkey"
FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayoutAllocation"
ADD CONSTRAINT "PayoutAllocation_payoutId_fkey"
FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

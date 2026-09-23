-- Creator referral foundation.
-- Existing live referral URLs use ?ref=<Creator.handle>, so preserve each
-- current handle exactly as the initial stored referral code.

CREATE TYPE "ReferralAttributionStatus" AS ENUM ('CAPTURED', 'CONVERTED');

ALTER TABLE "Creator"
  ADD COLUMN "referralCode" TEXT,
  ADD COLUMN "referralCodeNormalized" TEXT,
  ADD COLUMN "referredByCreatorId" TEXT;

UPDATE "Creator"
SET
  "referralCode" = "handle",
  "referralCodeNormalized" = lower("handle")
WHERE "referralCode" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Creator"
    WHERE "shop" IS NULL
       OR btrim("shop") = ''
       OR "customerId" IS NULL
       OR btrim("customerId") = ''
       OR "handle" IS NULL
       OR btrim("handle") = ''
       OR "referralCode" IS NULL
       OR btrim("referralCode") = ''
       OR "referralCode" ~ '[[:cntrl:]]'
       OR length("referralCode") > 100
  ) THEN
    RAISE EXCEPTION 'Unsafe Creator referral backfill: blank, control-character, or oversized referral code found.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Creator"
    GROUP BY "shop", lower("referralCode")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Unsafe Creator referral backfill: case-insensitive referral code collision found.';
  END IF;
END $$;

ALTER TABLE "Creator"
  ALTER COLUMN "referralCode" SET NOT NULL,
  ALTER COLUMN "referralCodeNormalized" SET NOT NULL;

CREATE UNIQUE INDEX "Creator_shop_referralCodeNormalized_key"
  ON "Creator"("shop", "referralCodeNormalized");

CREATE INDEX "Creator_referredByCreatorId_idx"
  ON "Creator"("referredByCreatorId");

ALTER TABLE "Creator"
  ADD CONSTRAINT "Creator_referredByCreatorId_fkey"
  FOREIGN KEY ("referredByCreatorId") REFERENCES "Creator"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReferralAttribution" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "shopifyCustomerId" TEXT NOT NULL,
  "referrerCreatorId" TEXT NOT NULL,
  "referralCodeSnapshot" TEXT NOT NULL,
  "status" "ReferralAttributionStatus" NOT NULL DEFAULT 'CAPTURED',
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "convertedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralAttribution_shop_shopifyCustomerId_key"
  ON "ReferralAttribution"("shop", "shopifyCustomerId");

CREATE INDEX "ReferralAttribution_shop_status_idx"
  ON "ReferralAttribution"("shop", "status");

CREATE INDEX "ReferralAttribution_referrerCreatorId_idx"
  ON "ReferralAttribution"("referrerCreatorId");

ALTER TABLE "ReferralAttribution"
  ADD CONSTRAINT "ReferralAttribution_referrerCreatorId_fkey"
  FOREIGN KEY ("referrerCreatorId") REFERENCES "Creator"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

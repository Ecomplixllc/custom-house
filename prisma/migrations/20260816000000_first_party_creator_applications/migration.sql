ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'DRAFT';

ALTER TABLE "CreatorApplication"
  ADD COLUMN "shopifyCustomerId" TEXT,
  ADD COLUMN "emailSnapshot" TEXT,
  ADD COLUMN "primaryPlatform" TEXT,
  ADD COLUMN "primaryProfileUrl" TEXT,
  ADD COLUMN "audienceRange" TEXT,
  ADD COLUMN "categoriesJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "aboutWork" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;

UPDATE "CreatorApplication" AS application
SET "shopifyCustomerId" = creator."customerId"
FROM "Creator" AS creator
WHERE application."creatorId" = creator."id"
  AND application."shopifyCustomerId" IS NULL;

UPDATE "CreatorApplication"
SET
  "submittedAt" = COALESCE("submittedAt", "createdAt"),
  "approvedAt" = CASE WHEN "status" = 'APPROVED' THEN COALESCE("approvedAt", "reviewedAt") ELSE "approvedAt" END,
  "rejectedAt" = CASE WHEN "status" = 'REJECTED' THEN COALESCE("rejectedAt", "reviewedAt") ELSE "rejectedAt" END,
  "rejectionReason" = CASE WHEN "status" = 'REJECTED' THEN COALESCE("rejectionReason", "reviewerNote") ELSE "rejectionReason" END;

ALTER TABLE "CreatorApplication" ALTER COLUMN "creatorId" DROP NOT NULL;

CREATE UNIQUE INDEX "CreatorApplication_custom_current_customer_key"
  ON "CreatorApplication"("shop", "shopifyCustomerId")
  WHERE "source" = 'CUSTOM_APP' AND "shopifyCustomerId" IS NOT NULL;

CREATE INDEX "CreatorApplication_shop_shopifyCustomerId_idx"
  ON "CreatorApplication"("shop", "shopifyCustomerId");

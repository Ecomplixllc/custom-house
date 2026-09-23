ALTER TABLE "CreatorProduct"
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;

CREATE INDEX "CreatorProduct_shop_status_submittedAt_idx"
  ON "CreatorProduct"("shop", "status", "submittedAt");

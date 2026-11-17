-- Existing Creator products intentionally remain NULL and retain legacy cart pricing.
ALTER TABLE "CreatorProduct" ADD COLUMN "creatorPricingMode" TEXT;
ALTER TABLE "CreatorProduct" ADD COLUMN "creatorPricingPreviewJson" TEXT NOT NULL DEFAULT '{}';

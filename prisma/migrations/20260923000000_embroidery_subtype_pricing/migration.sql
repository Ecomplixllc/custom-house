ALTER TABLE "PublicProductProductionPricing"
  ADD COLUMN "embroideryTextSurcharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "embroideryImageSurcharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "embroideryTextFeeVariantId" TEXT,
  ADD COLUMN "embroideryImageFeeVariantId" TEXT;

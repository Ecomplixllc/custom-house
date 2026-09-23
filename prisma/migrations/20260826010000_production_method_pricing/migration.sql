DO $$ BEGIN
  CREATE TYPE "ProductionMethod" AS ENUM ('EMBROIDERY', 'DTF', 'DTG');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ProductionMethodSetting" (
  "id" TEXT NOT NULL,
  "shopKey" TEXT NOT NULL,
  "method" "ProductionMethod" NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductionMethodSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PublicProductProductionPricing" (
  "id" TEXT NOT NULL,
  "shopKey" TEXT NOT NULL,
  "shopifyProductId" TEXT NOT NULL,
  "embroiderySurcharge" DECIMAL(10,2) NOT NULL,
  "dtfSurcharge" DECIMAL(10,2) NOT NULL,
  "dtgSurcharge" DECIMAL(10,2) NOT NULL,
  "embroideryFeeVariantId" TEXT,
  "dtfFeeVariantId" TEXT,
  "dtgFeeVariantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PublicProductProductionPricing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductionMethodSetting_shopKey_method_key"
ON "ProductionMethodSetting"("shopKey", "method");

CREATE INDEX IF NOT EXISTS "ProductionMethodSetting_shopKey_enabled_idx"
ON "ProductionMethodSetting"("shopKey", "enabled");

CREATE UNIQUE INDEX IF NOT EXISTS "PublicProductProductionPricing_shopKey_shopifyProductId_key"
ON "PublicProductProductionPricing"("shopKey", "shopifyProductId");

CREATE INDEX IF NOT EXISTS "PublicProductProductionPricing_shopKey_idx"
ON "PublicProductProductionPricing"("shopKey");

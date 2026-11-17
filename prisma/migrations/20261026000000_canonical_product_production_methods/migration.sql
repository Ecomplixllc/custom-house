-- Generalize the existing production-method registry without introducing a
-- parallel pricing table. Existing values are retained as stable text codes.
ALTER TABLE "ProductionMethodSetting"
  ALTER COLUMN "method" TYPE TEXT USING "method"::text,
  ADD COLUMN "pricingBehavior" TEXT NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN "configurationJson" JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE "ProductionMethodSetting"
SET
  "pricingBehavior" = CASE
    WHEN "method" = 'EMBROIDERY' THEN 'TIERED'
    ELSE 'SINGLE'
  END,
  "configurationJson" = CASE
    WHEN "method" = 'EMBROIDERY' THEN '{"maxWidthCm":8,"maxHeightCm":8,"tiers":["TEXT_ONLY","IMAGE_OR_LOGO"]}'::jsonb
    WHEN "method" IN ('DTF', 'DTG') THEN '{"maxWidthCm":35,"maxHeightCm":40}'::jsonb
    ELSE '{}'::jsonb
  END;

DROP TYPE IF EXISTS "ProductionMethod";

-- Keep the existing per-product row as the one production-cost authority.
ALTER TABLE "PublicProductProductionPricing"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'SEK',
  ADD COLUMN "methodConfigurations" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Current public behavior exposed all three legacy methods for every configured
-- product, independently of price. Preserve that enablement explicitly; zero
-- remains a valid enabled price rather than an implicit disabled state.
UPDATE "PublicProductProductionPricing"
SET "methodConfigurations" = jsonb_build_object(
  'version', 2,
  'methods', jsonb_build_object(
    'EMBROIDERY', jsonb_build_object(
      'enabled', true,
      'tiers', jsonb_build_object(
        'TEXT_ONLY', jsonb_build_object(
          'enabled', true,
          'surcharge', to_jsonb("embroideryTextSurcharge"),
          'feeVariantId', to_jsonb("embroideryTextFeeVariantId")
        ),
        'IMAGE_OR_LOGO', jsonb_build_object(
          'enabled', true,
          'surcharge', to_jsonb("embroideryImageSurcharge"),
          'feeVariantId', to_jsonb("embroideryImageFeeVariantId")
        )
      )
    ),
    'DTF', jsonb_build_object(
      'enabled', true,
      'surcharge', to_jsonb("dtfSurcharge"),
      'feeVariantId', to_jsonb("dtfFeeVariantId")
    ),
    'DTG', jsonb_build_object(
      'enabled', true,
      'surcharge', to_jsonb("dtgSurcharge"),
      'feeVariantId', to_jsonb("dtgFeeVariantId")
    )
  )
)
WHERE "methodConfigurations" = '{}'::jsonb;

-- Seed registry-backed future methods for every existing shop. They remain
-- unavailable on a product until that product configuration enables them.
INSERT INTO "ProductionMethodSetting" (
  "id", "shopKey", "method", "label", "description", "enabled",
  "pricingBehavior", "configurationJson", "createdAt", "updatedAt"
)
SELECT
  md5(source."shopKey" || ':' || method.code),
  source."shopKey",
  method.code,
  method.label,
  '',
  true,
  'SINGLE',
  '{}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "shopKey" FROM "ProductionMethodSetting"
  UNION
  SELECT DISTINCT "shopKey" FROM "PublicProductProductionPricing"
) AS source
CROSS JOIN (
  VALUES
    ('SUBLIMATION', 'Sublimation'),
    ('STICKER_PRINTING', 'Sticker Printing')
) AS method(code, label)
ON CONFLICT ("shopKey", "method") DO NOTHING;

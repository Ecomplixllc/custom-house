ALTER TABLE "CreatorProduct"
  ADD COLUMN "baseProductVariantsJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "designVariantSelectionsJson" TEXT NOT NULL DEFAULT '[]';

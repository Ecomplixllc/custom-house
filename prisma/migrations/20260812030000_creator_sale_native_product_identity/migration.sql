-- Additive native marketplace sale identity mapping.
ALTER TABLE "CreatorSale" ADD COLUMN "creatorProductId" TEXT;

CREATE INDEX "CreatorSale_creatorProductId_idx" ON "CreatorSale"("creatorProductId");

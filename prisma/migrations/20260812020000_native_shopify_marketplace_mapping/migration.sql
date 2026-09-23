ALTER TABLE "CreatorCollection"
  ADD COLUMN "shopifyCollectionId" TEXT,
  ADD COLUMN "shopifyCollectionHandle" TEXT,
  ADD COLUMN "shopifyCollectionUrl" TEXT,
  ADD COLUMN "shopifyPublishedAt" TIMESTAMP(3);

ALTER TABLE "CreatorProduct"
  ADD COLUMN "publishedShopifyProductId" TEXT,
  ADD COLUMN "publishedShopifyProductHandle" TEXT,
  ADD COLUMN "publishedShopifyProductUrl" TEXT,
  ADD COLUMN "shopifyPublishedAt" TIMESTAMP(3),
  ADD COLUMN "baseVariantMappingJson" TEXT NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX "CreatorCollection_shopifyCollectionId_key"
  ON "CreatorCollection"("shopifyCollectionId");

CREATE UNIQUE INDEX "CreatorCollection_shopifyCollectionHandle_key"
  ON "CreatorCollection"("shopifyCollectionHandle");

CREATE UNIQUE INDEX "CreatorProduct_publishedShopifyProductId_key"
  ON "CreatorProduct"("publishedShopifyProductId");

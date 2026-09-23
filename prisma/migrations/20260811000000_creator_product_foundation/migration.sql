CREATE TYPE "CreatorProductStatus" AS ENUM ('DRAFT', 'PENDING', 'PUBLISHED', 'REJECTED', 'ARCHIVED');

CREATE TABLE "CreatorProduct" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "shopifyProductId" TEXT NOT NULL,
  "shopifyProductHandle" TEXT,
  "baseProductTitle" TEXT NOT NULL,
  "pitchprintProjectId" TEXT,
  "pitchprintDesignId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "previewUrl" TEXT,
  "previewUrls" TEXT NOT NULL DEFAULT '[]',
  "status" "CreatorProductStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorProduct_shop_pitchprintProjectId_key"
  ON "CreatorProduct"("shop", "pitchprintProjectId");

CREATE INDEX "CreatorProduct_creatorId_idx"
  ON "CreatorProduct"("creatorId");

CREATE INDEX "CreatorProduct_creatorId_status_idx"
  ON "CreatorProduct"("creatorId", "status");

CREATE INDEX "CreatorProduct_shop_shopifyProductId_idx"
  ON "CreatorProduct"("shop", "shopifyProductId");

CREATE INDEX "CreatorProduct_shop_status_idx"
  ON "CreatorProduct"("shop", "status");

ALTER TABLE "CreatorProduct"
  ADD CONSTRAINT "CreatorProduct_creatorId_fkey"
  FOREIGN KEY ("creatorId")
  REFERENCES "Creator"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

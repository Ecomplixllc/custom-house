CREATE TYPE "DesignerMode" AS ENUM ('CUSTOMER_CUSTOMIZE', 'CREATOR_PUBLISH');
CREATE TYPE "DesignSessionStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED', 'CARTED', 'FAILED');
CREATE TYPE "CreatorDesignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'FAILED');
CREATE TYPE "CreatorDesignSyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'HIDDEN');

CREATE TABLE "DesignSession" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "creatorId" TEXT,
    "clientKey" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "mode" "DesignerMode" NOT NULL,
    "designJson" TEXT NOT NULL,
    "previewUrl" TEXT,
    "artworkUrl" TEXT,
    "status" "DesignSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorDesign" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "designSessionId" TEXT NOT NULL,
    "globalShopifyProductId" TEXT NOT NULL,
    "shopifyCreatorProductId" TEXT,
    "shopifyCollectionId" TEXT,
    "title" TEXT NOT NULL,
    "previewUrl" TEXT NOT NULL,
    "artworkUrl" TEXT NOT NULL,
    "designJson" TEXT NOT NULL,
    "status" "CreatorDesignStatus" NOT NULL DEFAULT 'DRAFT',
    "syncStatus" "CreatorDesignSyncStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "publishError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "CreatorDesign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesignSession_shop_customerId_clientKey_key"
ON "DesignSession"("shop", "customerId", "clientKey");

CREATE INDEX "DesignSession_shop_customerId_updatedAt_idx"
ON "DesignSession"("shop", "customerId", "updatedAt");

CREATE INDEX "DesignSession_creatorId_status_idx"
ON "DesignSession"("creatorId", "status");

CREATE UNIQUE INDEX "CreatorDesign_designSessionId_key"
ON "CreatorDesign"("designSessionId");

CREATE UNIQUE INDEX "CreatorDesign_shop_idempotencyKey_key"
ON "CreatorDesign"("shop", "idempotencyKey");

CREATE INDEX "CreatorDesign_creatorId_status_idx"
ON "CreatorDesign"("creatorId", "status");

CREATE INDEX "CreatorDesign_shop_shopifyCreatorProductId_idx"
ON "CreatorDesign"("shop", "shopifyCreatorProductId");

CREATE INDEX "CreatorDesign_shop_syncStatus_idx"
ON "CreatorDesign"("shop", "syncStatus");

ALTER TABLE "DesignSession"
ADD CONSTRAINT "DesignSession_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorDesign"
ADD CONSTRAINT "CreatorDesign_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorDesign"
ADD CONSTRAINT "CreatorDesign_designSessionId_fkey"
FOREIGN KEY ("designSessionId") REFERENCES "DesignSession"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additive, production-safe Zakeke marketplace proof-of-concept schema.
-- Existing creator, submission, session, InkyBay, and Fabric data is preserved.

ALTER TYPE "DesignerMode" ADD VALUE 'CUSTOMER_BUY';
ALTER TYPE "DesignerMode" ADD VALUE 'CREATOR_BUY';

ALTER TYPE "CreatorDesignStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "CreatorDesignStatus" ADD VALUE 'HIDDEN';
ALTER TYPE "CreatorDesignStatus" ADD VALUE 'ARCHIVED';

CREATE TYPE "DesignProvider" AS ENUM ('FABRIC', 'ZAKEKE');
CREATE TYPE "GlobalProductMappingStatus" AS ENUM ('DRAFT', 'TESTING', 'ACTIVE', 'DISABLED', 'ERROR');
CREATE TYPE "DesignPurchaseStatus" AS ENUM ('CREATING', 'READY', 'CARTED', 'ORDERED', 'FAILED', 'EXPIRED');
CREATE TYPE "PrintFilesStatus" AS ENUM ('PENDING', 'PROCESSING', 'AVAILABLE', 'ERROR', 'CANCELLED', 'REFUNDED');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "ZakekeOrderJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'REGISTERED', 'FAILED', 'CANCELLED', 'REFUNDED');

ALTER TABLE "DesignSession"
  ADD COLUMN "provider" "DesignProvider" NOT NULL DEFAULT 'FABRIC',
  ADD COLUMN "visitorCode" TEXT,
  ADD COLUMN "nonceHash" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "zakekeDesignId" TEXT,
  ADD COLUMN "selectedAttributesJson" TEXT,
  ADD COLUMN "globalProductMappingId" TEXT;

ALTER TABLE "CreatorDesign"
  ADD COLUMN "provider" "DesignProvider" NOT NULL DEFAULT 'FABRIC',
  ADD COLUMN "globalProductMappingId" TEXT,
  ADD COLUMN "sourceZakekeDesignId" TEXT,
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "compatibleVariantIdsJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "selectedAttributesJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "designVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "hiddenReason" TEXT,
  ADD COLUMN "wasPublishedBeforeSuspension" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorReference" TEXT;

CREATE TABLE "GlobalProductMapping" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "shopifyProductId" TEXT NOT NULL,
  "shopifyProductHandle" TEXT,
  "zakekeProductCode" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "status" "GlobalProductMappingStatus" NOT NULL DEFAULT 'DRAFT',
  "variantMappingJson" TEXT NOT NULL DEFAULT '{}',
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GlobalProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DesignPurchase" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "creatorDesignId" TEXT,
  "sourceZakekeDesignId" TEXT NOT NULL,
  "purchaseZakekeDesignId" TEXT,
  "shopifyProductId" TEXT NOT NULL,
  "shopifyVariantId" TEXT NOT NULL,
  "customerId" TEXT,
  "visitorCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "signedTokenHash" TEXT,
  "status" "DesignPurchaseStatus" NOT NULL DEFAULT 'CREATING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DesignPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderDesignSnapshot" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "shopifyLineItemId" TEXT NOT NULL,
  "creatorId" TEXT,
  "creatorDesignId" TEXT,
  "sourceShopifyProductId" TEXT NOT NULL,
  "shopifyCreatorProductId" TEXT,
  "shopifyVariantId" TEXT NOT NULL,
  "sourceZakekeDesignId" TEXT NOT NULL,
  "orderZakekeDesignId" TEXT NOT NULL,
  "designVersion" INTEGER NOT NULL,
  "previewUrl" TEXT,
  "printFilesStatus" "PrintFilesStatus" NOT NULL DEFAULT 'PENDING',
  "printFilesReference" TEXT,
  "designTitle" TEXT NOT NULL,
  "creatorName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderDesignSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PROCESSING',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "lastErrorCode" TEXT,
  "lastReference" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ZakekeOrderJob" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "shopifyOrderCode" TEXT NOT NULL,
  "customerId" TEXT,
  "visitorCode" TEXT,
  "payloadJson" TEXT NOT NULL,
  "status" "ZakekeOrderJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorReference" TEXT,
  "registeredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ZakekeOrderJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GlobalProductMapping_shop_shopifyProductId_key"
  ON "GlobalProductMapping"("shop", "shopifyProductId");
CREATE UNIQUE INDEX "GlobalProductMapping_shop_zakekeProductCode_key"
  ON "GlobalProductMapping"("shop", "zakekeProductCode");
CREATE INDEX "GlobalProductMapping_shop_enabled_status_idx"
  ON "GlobalProductMapping"("shop", "enabled", "status");

CREATE UNIQUE INDEX "CreatorDesign_shop_slug_key"
  ON "CreatorDesign"("shop", "slug");
CREATE INDEX "CreatorDesign_globalProductMappingId_idx"
  ON "CreatorDesign"("globalProductMappingId");
CREATE INDEX "DesignSession_shop_provider_expiresAt_idx"
  ON "DesignSession"("shop", "provider", "expiresAt");
CREATE INDEX "DesignSession_globalProductMappingId_idx"
  ON "DesignSession"("globalProductMappingId");

CREATE UNIQUE INDEX "DesignPurchase_shop_idempotencyKey_key"
  ON "DesignPurchase"("shop", "idempotencyKey");
CREATE INDEX "DesignPurchase_creatorDesignId_status_idx"
  ON "DesignPurchase"("creatorDesignId", "status");
CREATE INDEX "DesignPurchase_shop_shopifyProductId_shopifyVariantId_idx"
  ON "DesignPurchase"("shop", "shopifyProductId", "shopifyVariantId");
CREATE INDEX "DesignPurchase_shop_status_expiresAt_idx"
  ON "DesignPurchase"("shop", "status", "expiresAt");

CREATE UNIQUE INDEX "OrderDesignSnapshot_shop_shopifyLineItemId_key"
  ON "OrderDesignSnapshot"("shop", "shopifyLineItemId");
CREATE INDEX "OrderDesignSnapshot_shop_shopifyOrderId_idx"
  ON "OrderDesignSnapshot"("shop", "shopifyOrderId");
CREATE INDEX "OrderDesignSnapshot_creatorDesignId_idx"
  ON "OrderDesignSnapshot"("creatorDesignId");
CREATE INDEX "OrderDesignSnapshot_shop_printFilesStatus_idx"
  ON "OrderDesignSnapshot"("shop", "printFilesStatus");

CREATE UNIQUE INDEX "WebhookDelivery_shop_webhookId_key"
  ON "WebhookDelivery"("shop", "webhookId");
CREATE INDEX "WebhookDelivery_shop_topic_status_idx"
  ON "WebhookDelivery"("shop", "topic", "status");

CREATE UNIQUE INDEX "ZakekeOrderJob_shop_shopifyOrderId_key"
  ON "ZakekeOrderJob"("shop", "shopifyOrderId");
CREATE INDEX "ZakekeOrderJob_shop_status_nextAttemptAt_idx"
  ON "ZakekeOrderJob"("shop", "status", "nextAttemptAt");

ALTER TABLE "DesignSession"
  ADD CONSTRAINT "DesignSession_globalProductMappingId_fkey"
  FOREIGN KEY ("globalProductMappingId")
  REFERENCES "GlobalProductMapping"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CreatorDesign"
  ADD CONSTRAINT "CreatorDesign_globalProductMappingId_fkey"
  FOREIGN KEY ("globalProductMappingId")
  REFERENCES "GlobalProductMapping"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DesignPurchase"
  ADD CONSTRAINT "DesignPurchase_creatorDesignId_fkey"
  FOREIGN KEY ("creatorDesignId")
  REFERENCES "CreatorDesign"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

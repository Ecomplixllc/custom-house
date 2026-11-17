-- CreateEnum
CREATE TYPE "CreatorOrderProductionStatus" AS ENUM ('NEW', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "CreatorOrderItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT,
    "shopifyLineItemId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorProductId" TEXT NOT NULL,
    "creatorSaleId" TEXT,
    "creatorCollectionId" TEXT,
    "baseShopifyProductId" TEXT NOT NULL,
    "baseShopifyVariantId" TEXT,
    "pitchprintProjectId" TEXT,
    "creatorProductTitleSnapshot" TEXT NOT NULL,
    "creatorNameSnapshot" TEXT NOT NULL,
    "customerDisplayNameSnapshot" TEXT,
    "variantTitleSnapshot" TEXT,
    "selectedOptionsJson" TEXT NOT NULL DEFAULT '[]',
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(20,4) NOT NULL,
    "lineSubtotal" DECIMAL(20,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "creatorPreviewUrl" TEXT,
    "productionStatus" "CreatorOrderProductionStatus" NOT NULL DEFAULT 'NEW',
    "productionNotes" TEXT,
    "readyAt" TIMESTAMP(3),
    "productionStartedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorOrderItem_creatorSaleId_key" ON "CreatorOrderItem"("creatorSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorOrderItem_shop_shopifyOrderId_shopifyLineItemId_creatorProductId_key" ON "CreatorOrderItem"("shop", "shopifyOrderId", "shopifyLineItemId", "creatorProductId");

-- CreateIndex
CREATE INDEX "CreatorOrderItem_shop_productionStatus_createdAt_idx" ON "CreatorOrderItem"("shop", "productionStatus", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorOrderItem_shop_shopifyOrderId_idx" ON "CreatorOrderItem"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "CreatorOrderItem_shop_shopifyLineItemId_idx" ON "CreatorOrderItem"("shop", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "CreatorOrderItem_creatorId_productionStatus_createdAt_idx" ON "CreatorOrderItem"("creatorId", "productionStatus", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorOrderItem_creatorProductId_idx" ON "CreatorOrderItem"("creatorProductId");

-- AddForeignKey
ALTER TABLE "CreatorOrderItem" ADD CONSTRAINT "CreatorOrderItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorOrderItem" ADD CONSTRAINT "CreatorOrderItem_creatorProductId_fkey" FOREIGN KEY ("creatorProductId") REFERENCES "CreatorProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorOrderItem" ADD CONSTRAINT "CreatorOrderItem_creatorSaleId_fkey" FOREIGN KEY ("creatorSaleId") REFERENCES "CreatorSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

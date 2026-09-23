-- Creator earnings are calculated from paid, creator-attributed line-item
-- subtotals after line discounts. No customer contact or address data is stored.
CREATE TABLE "CreatorSale" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "productTitle" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "refundedQuantity" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "grossSalesAmount" DECIMAL(20,4) NOT NULL,
    "refundedSalesAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "commissionRateBps" INTEGER NOT NULL DEFAULT 1000,
    "sourceWebhookId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSale_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorSaleAdjustment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "adjustmentKey" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "creatorSaleId" TEXT,
    "quantity" INTEGER NOT NULL,
    "salesAmount" DECIMAL(20,4) NOT NULL,
    "sourceWebhookId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorSaleAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorSale_shop_shopifyLineItemId_key"
    ON "CreatorSale"("shop", "shopifyLineItemId");
CREATE INDEX "CreatorSale_creatorId_currencyCode_createdAt_idx"
    ON "CreatorSale"("creatorId", "currencyCode", "createdAt");
CREATE INDEX "CreatorSale_shop_shopifyOrderId_idx"
    ON "CreatorSale"("shop", "shopifyOrderId");
CREATE INDEX "CreatorSale_shop_shopifyProductId_idx"
    ON "CreatorSale"("shop", "shopifyProductId");

CREATE UNIQUE INDEX "CreatorSaleAdjustment_shop_adjustmentKey_key"
    ON "CreatorSaleAdjustment"("shop", "adjustmentKey");
CREATE INDEX "CreatorSaleAdjustment_shop_shopifyLineItemId_idx"
    ON "CreatorSaleAdjustment"("shop", "shopifyLineItemId");
CREATE INDEX "CreatorSaleAdjustment_creatorSaleId_idx"
    ON "CreatorSaleAdjustment"("creatorSaleId");

ALTER TABLE "CreatorSale"
    ADD CONSTRAINT "CreatorSale_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorSaleAdjustment"
    ADD CONSTRAINT "CreatorSaleAdjustment_creatorSaleId_fkey"
    FOREIGN KEY ("creatorSaleId") REFERENCES "CreatorSale"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

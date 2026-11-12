-- CreateTable
CREATE TABLE "FeaturedCreator" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeaturedCreator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedCreator_shop_creatorId_key" ON "FeaturedCreator"("shop", "creatorId");

-- CreateIndex
CREATE INDEX "FeaturedCreator_shop_position_idx" ON "FeaturedCreator"("shop", "position");

-- CreateIndex
CREATE INDEX "FeaturedCreator_creatorId_idx" ON "FeaturedCreator"("creatorId");

-- AddForeignKey
ALTER TABLE "FeaturedCreator" ADD CONSTRAINT "FeaturedCreator_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

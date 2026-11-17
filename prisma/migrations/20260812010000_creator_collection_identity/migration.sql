CREATE TYPE "CreatorCollectionStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'SUSPENDED');

CREATE TABLE "CreatorCollection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "publicHandle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "CreatorCollectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorCollection_creatorId_key" ON "CreatorCollection"("creatorId");
CREATE UNIQUE INDEX "CreatorCollection_publicId_key" ON "CreatorCollection"("publicId");
CREATE UNIQUE INDEX "CreatorCollection_publicHandle_key" ON "CreatorCollection"("publicHandle");
CREATE INDEX "CreatorCollection_shop_status_idx" ON "CreatorCollection"("shop", "status");
CREATE INDEX "CreatorCollection_shop_publicHandle_idx" ON "CreatorCollection"("shop", "publicHandle");

ALTER TABLE "CreatorCollection"
  ADD CONSTRAINT "CreatorCollection_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

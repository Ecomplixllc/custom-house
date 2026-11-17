-- Additive hybrid InkyBay creator-publishing workflow.
-- Existing Fabric, Zakeke, creator, order and session data is preserved.

ALTER TYPE "DesignProvider" ADD VALUE IF NOT EXISTS 'INKYBAY';

CREATE TYPE "InkyBayPublishMode" AS ENUM (
  'MANUAL_BRIDGE',
  'INKYBAY_CALLBACK'
);

ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'CREATED';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'DESIGNING';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_SAVED_DESIGN';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_ASSETS';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'READY_TO_PUBLISH';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'PUBLISHING';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "DesignSessionStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "DesignSession"
  ADD COLUMN "publishMode" "InkyBayPublishMode",
  ADD COLUMN "productionArtworkKey" TEXT,
  ADD COLUMN "inkybaySavedDesignUrl" TEXT,
  ADD COLUMN "inkybayTid" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorReference" TEXT;

ALTER TABLE "CreatorDesign"
  ADD COLUMN "inkybaySavedDesignUrl" TEXT,
  ADD COLUMN "inkybayTid" TEXT,
  ADD COLUMN "productionArtworkKey" TEXT;

ALTER TABLE "OrderDesignSnapshot"
  ADD COLUMN "provider" "DesignProvider" NOT NULL DEFAULT 'ZAKEKE',
  ADD COLUMN "productionArtworkKey" TEXT,
  ALTER COLUMN "sourceZakekeDesignId" DROP NOT NULL,
  ALTER COLUMN "orderZakekeDesignId" DROP NOT NULL;

CREATE UNIQUE INDEX "DesignSession_shop_idempotencyKey_key"
  ON "DesignSession"("shop", "idempotencyKey");

CREATE INDEX "DesignSession_shop_provider_status_updatedAt_idx"
  ON "DesignSession"("shop", "provider", "status", "updatedAt");

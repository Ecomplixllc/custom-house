CREATE TYPE "StatusAuthority" AS ENUM ('HELIUM_IMPORT', 'CUSTOM_APP');

ALTER TABLE "Creator"
  ADD COLUMN "statusAuthority" "StatusAuthority" NOT NULL DEFAULT 'HELIUM_IMPORT',
  ADD COLUMN "lastExternalSyncAt" TIMESTAMP(3),
  ADD COLUMN "externalSnapshotHash" TEXT,
  ADD COLUMN "externalSyncConflict" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Creator" SET "statusAuthority" = 'CUSTOM_APP'
WHERE "applicationSource" = 'CUSTOM_APP'
   OR "id" IN (SELECT DISTINCT "entityId" FROM "AuditLog" WHERE "actorType" = 'ADMIN' AND "action" LIKE 'creator.%');

CREATE INDEX "Creator_shop_statusAuthority_idx" ON "Creator"("shop", "statusAuthority");

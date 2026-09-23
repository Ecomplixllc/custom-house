CREATE TYPE "ApplicationSource" AS ENUM ('CUSTOM_APP', 'HELIUM_IMPORT');

ALTER TABLE "ShopConfig"
  ADD COLUMN "allowReapplicationAfterRejection" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "heliumMigrationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "heliumDecommissionedAt" TIMESTAMP(3);

ALTER TABLE "Creator"
  ADD COLUMN "socialLinksJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "applicationSource" "ApplicationSource" NOT NULL DEFAULT 'CUSTOM_APP';

ALTER TABLE "CreatorApplication"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "bio" TEXT,
  ADD COLUMN "portfolioUrl" TEXT,
  ADD COLUMN "socialLinksJson" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "profileImageUrl" TEXT,
  ADD COLUMN "message" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "source" "ApplicationSource" NOT NULL DEFAULT 'CUSTOM_APP';

UPDATE "Creator" SET "applicationSource" = 'HELIUM_IMPORT'
WHERE "id" IN (SELECT DISTINCT "entityId" FROM "AuditLog" WHERE "entityType" = 'Creator' AND "action" LIKE 'helium.%');

UPDATE "CreatorApplication" SET "source" = 'HELIUM_IMPORT'
WHERE "creatorId" IN (SELECT DISTINCT "entityId" FROM "AuditLog" WHERE "entityType" = 'Creator' AND "action" LIKE 'helium.%');

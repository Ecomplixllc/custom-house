-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CreatorStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorApplicationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "automaticCollectionCreationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requireAdminApproval" BOOLEAN NOT NULL DEFAULT true,
    "collectionTitleTemplate" TEXT NOT NULL DEFAULT '{creatorName} Designs',
    "collectionHandleSuffix" TEXT NOT NULL DEFAULT 'designs',
    "creatorTagsJson" TEXT NOT NULL DEFAULT '{}',
    "onlineStorePublicationId" TEXT,
    "creatorProfileMetaobjectType" TEXT,
    "creatorProfileFieldMapJson" TEXT,
    "creatorStatusMetafieldNamespace" TEXT,
    "creatorStatusMetafieldKey" TEXT,
    "inkybayAllowedHostsJson" TEXT NOT NULL DEFAULT '[]',
    "inkybayBuyOnlyHiddenSelectorsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "bio" TEXT,
    "portfolioUrl" TEXT,
    "profileImageUrl" TEXT,
    "status" "CreatorStatus" NOT NULL DEFAULT 'PENDING',
    "collectionId" TEXT,
    "creatorProfileMetaobjectId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "suspensionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorApplication" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "answersJson" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignSubmission" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "baseProductId" TEXT NOT NULL,
    "baseVariantId" TEXT,
    "designName" TEXT NOT NULL,
    "inkybayDesignId" TEXT,
    "savedDesignUrl" TEXT NOT NULL,
    "previewUrl" TEXT,
    "creatorMessage" TEXT,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "createdProductId" TEXT,
    "publishError" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopConfig_shop_key" ON "ShopConfig"("shop");

-- CreateIndex
CREATE INDEX "Creator_shop_status_idx" ON "Creator"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_shop_customerId_key" ON "Creator"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_shop_handle_key" ON "Creator"("shop", "handle");

-- CreateIndex
CREATE INDEX "CreatorApplication_shop_status_idx" ON "CreatorApplication"("shop", "status");

-- CreateIndex
CREATE INDEX "CreatorApplication_creatorId_createdAt_idx" ON "CreatorApplication"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "DesignSubmission_shop_status_idx" ON "DesignSubmission"("shop", "status");

-- CreateIndex
CREATE INDEX "DesignSubmission_creatorId_createdAt_idx" ON "DesignSubmission"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "DesignSubmission_shop_createdProductId_idx" ON "DesignSubmission"("shop", "createdProductId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignSubmission_shop_idempotencyKey_key" ON "DesignSubmission"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_shop_createdAt_idx" ON "AuditLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "CreatorApplication" ADD CONSTRAINT "CreatorApplication_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignSubmission" ADD CONSTRAINT "DesignSubmission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

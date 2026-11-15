-- Creator preference, searchable discovery tags, and an independent admin moderation override.
-- Existing archived or structurally incomplete records stay opted out; the default is changed
-- to true only after the focused eligible-record backfill.
ALTER TABLE "CreatorProduct"
  ADD COLUMN "creatorContentOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "creatorContentTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "creatorContentHiddenByAdmin" BOOLEAN NOT NULL DEFAULT false;

UPDATE "CreatorProduct"
SET "creatorContentOptIn" = true
WHERE "status" <> 'ARCHIVED'
  AND length(trim("shop")) > 0
  AND length(trim("creatorId")) > 0
  AND length(trim("shopifyProductId")) > 0
  AND ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

ALTER TABLE "CreatorProduct"
  ALTER COLUMN "creatorContentOptIn" SET DEFAULT true;

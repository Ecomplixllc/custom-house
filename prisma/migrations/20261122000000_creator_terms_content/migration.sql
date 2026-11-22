ALTER TABLE "ShopConfig"
  ADD COLUMN IF NOT EXISTS "creatorTermsTitle" TEXT NOT NULL DEFAULT 'Creator Terms & Conditions',
  ADD COLUMN IF NOT EXISTS "creatorTermsBody" TEXT NOT NULL DEFAULT 'Please replace this placeholder with the approved Creator Terms & Conditions in Creator Marketplace Settings before accepting applications.';

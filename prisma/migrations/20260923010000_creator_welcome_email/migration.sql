ALTER TABLE "ShopConfig"
  ADD COLUMN "creatorWelcomeEmailSubject" TEXT NOT NULL DEFAULT 'Welcome to CustomHouse Creator',
  ADD COLUMN "creatorWelcomeEmailBody" TEXT NOT NULL DEFAULT E'Welcome to CustomHouse Creator, {{creator_name}}!\n\nNext steps:\n1. Open your Creator Dashboard: {{dashboard_url}}\n2. Complete your profile and collection banner.\n3. Create your first product by choosing one color and one printing method.\n\nTips & tricks: use a clear product title, preview every placement, and submit only artwork you have the rights to use.';

ALTER TABLE "Creator"
  ADD COLUMN "welcomeEmailSentAt" TIMESTAMP(3);

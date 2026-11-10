-- New CreatorSale records use the 20% standard Creator commission.
-- Existing rows retain their snapshotted commissionRateBps and earnings history.
ALTER TABLE "CreatorSale"
  ALTER COLUMN "commissionRateBps" SET DEFAULT 2000;

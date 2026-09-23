-- Additive server-side ownership marker for isolated Preview POC resources.
ALTER TABLE "CreatorDesign"
  ADD COLUMN "previewPoc" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "previewOwnerApp" TEXT;

CREATE INDEX "CreatorDesign_shop_previewPoc_idx"
  ON "CreatorDesign"("shop", "previewPoc");

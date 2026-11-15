import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../app/services/domain.ts";
import { creatorProductPublishingRecoveryMessage } from "../app/services/creator-product-publishing.server.ts";

test("admin approval explains how to recover an untracked base product", () => {
  const message = creatorProductPublishingRecoveryMessage(
    new DomainError(
      "CREATOR_SHARED_INVENTORY_SETUP_FAILED",
      "Creator shared inventory setup is incomplete: BLOCKED_BASE_INVENTORY_UNTRACKED.",
      409,
    ),
  );

  assert.match(message || "", /enable Track quantity/);
  assert.match(message || "", /enter the available inventory/);
  assert.match(message || "", /click Approve again/);
  assert.equal(
    creatorProductPublishingRecoveryMessage(new Error("Shopify token failed")),
    null,
  );
});

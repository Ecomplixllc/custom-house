import assert from "node:assert/strict";
import test from "node:test";
import { creatorRowPresentation } from "../app/components/creator-directory-presentation.ts";

test("pending creator rows use a dedicated decision panel instead of inline actions", () => {
  assert.deepEqual(creatorRowPresentation("PENDING"), {
    rowClassName: "creator-row--pending",
    actionGroupClassName: "creator-action-group creator-action-group--pending-summary",
    primaryActionLabel: "Review application",
    showPendingReviewPanel: true,
    showInlineActions: false,
  });
});

test("non-pending creator rows retain the standard directory layout", () => {
  assert.deepEqual(creatorRowPresentation("APPROVED"), {
    rowClassName: undefined,
    actionGroupClassName: "creator-action-group",
    primaryActionLabel: "View",
    showPendingReviewPanel: false,
    showInlineActions: true,
  });
});

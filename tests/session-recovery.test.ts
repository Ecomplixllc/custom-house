import assert from "node:assert/strict";
import test from "node:test";
import {
  isRecoverableSessionStorageError,
  withSessionStorageRecovery,
} from "../app/services/session-recovery.server.ts";

test("recognizes the Shopify Prisma cached readiness error", () => {
  const error = new Error("Prisma session table does not exist.");
  error.name = "MissingSessionTableError";
  assert.equal(isRecoverableSessionStorageError(error), true);
  assert.equal(isRecoverableSessionStorageError(new Error("Other error")), false);
});

test("rebuilds session storage and retries once after Neon recovers", async () => {
  let attempts = 0;
  let confirmations = 0;
  let resets = 0;

  const result = await withSessionStorageRecovery(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Prisma session table does not exist.");
        error.name = "MissingSessionTableError";
        throw error;
      }
      return "authenticated";
    },
    async () => {
      confirmations += 1;
    },
    () => {
      resets += 1;
    },
  );

  assert.equal(result, "authenticated");
  assert.equal(attempts, 2);
  assert.equal(confirmations, 1);
  assert.equal(resets, 1);
});

test("does not retry unrelated authentication failures", async () => {
  let resets = 0;
  await assert.rejects(
    withSessionStorageRecovery(
      async () => {
        throw new Error("Unauthorized");
      },
      async () => undefined,
      () => {
        resets += 1;
      },
    ),
    /Unauthorized/,
  );
  assert.equal(resets, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimPendingReferral,
  createPendingReferral,
  ensureCreatorReferralCode,
  referralFieldsForCode,
  resolveReferralCode,
  signPendingReferralToken,
  verifyPendingReferralToken,
} from "../app/services/creator-referral.server.ts";

const shop = "customhouse.test";

type FakeCreator = {
  id: string;
  shop: string;
  handle: string;
  displayName: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
  customerId?: string;
  referralCode: string | null;
  referralCodeNormalized: string | null;
  referredByCreatorId?: string | null;
};

function fakeDb(initialCreators: FakeCreator[]) {
  const creators = initialCreators.map((creator) => ({ ...creator }));
  const attributions: Array<{
    id: string;
    shop: string;
    shopifyCustomerId: string;
    referrerCreatorId: string;
    referralCodeSnapshot: string;
    status: "CAPTURED";
    capturedAt: Date;
  }> = [];
  const updates: Array<{
    where: { id: string };
    data: { referralCode: string; referralCodeNormalized: string };
  }> = [];
  return {
    creators,
    attributions,
    updates,
    creator: {
      async findFirst(args: {
        where: { shop: string; referralCodeNormalized?: string };
      }) {
        const creator = creators.find(
          (item) =>
            item.shop === args.where.shop &&
            item.referralCodeNormalized === args.where.referralCodeNormalized,
        );
        return creator
          ? {
              id: creator.id,
              referralCode: creator.referralCode!,
              status: creator.status,
              displayName: creator.displayName,
            }
          : null;
      },
      async findUnique(args: {
        where:
          | { id: string }
          | { shop_customerId: { shop: string; customerId: string } };
      }) {
        const where = args.where;
        if ("id" in where) {
          const found = creators.find((item) => item.id === where.id);
          return found
            ? {
                id: found.id,
                shop: found.shop,
                customerId: found.customerId,
                status: found.status,
                referralCode: found.referralCode!,
              }
            : null;
        }
        const found = creators.find(
          (item) =>
            item.shop === where.shop_customerId.shop &&
            item.customerId === where.shop_customerId.customerId,
        );
        return found ? { id: found.id } : null;
      },
      async update(args: {
        where: { id: string };
        data: { referralCode: string; referralCodeNormalized: string };
      }) {
        const creator = creators.find((item) => item.id === args.where.id);
        assert.ok(creator);
        Object.assign(creator, args.data);
        updates.push(args);
        return {
          id: creator.id,
          referralCode: creator.referralCode!,
          referralCodeNormalized: creator.referralCodeNormalized!,
        };
      },
    },
    referralAttribution: {
      async findUnique(args: {
        where: {
          shop_shopifyCustomerId: { shop: string; shopifyCustomerId: string };
        };
      }) {
        const found = attributions.find(
          (item) =>
            item.shop === args.where.shop_shopifyCustomerId.shop &&
            item.shopifyCustomerId === args.where.shop_shopifyCustomerId.shopifyCustomerId,
        );
        return found ? { id: found.id } : null;
      },
      async create(args: {
        data: {
          shop: string;
          shopifyCustomerId: string;
          referrerCreatorId: string;
          referralCodeSnapshot: string;
          status: "CAPTURED";
          capturedAt: Date;
        };
      }) {
        if (
          attributions.some(
            (item) =>
              item.shop === args.data.shop &&
              item.shopifyCustomerId === args.data.shopifyCustomerId,
          )
        ) {
          throw new Error("Unique constraint failed");
        }
        const row = { id: `attr-${attributions.length + 1}`, ...args.data };
        attributions.push(row);
        return { id: row.id };
      },
    },
  };
}

function creator(
  id: string,
  referralCode: string,
  options: Partial<FakeCreator> = {},
): FakeCreator {
  return {
    id,
    shop,
    handle: referralCode,
    displayName: `Creator ${id}`,
    status: "APPROVED",
    referredByCreatorId: null,
    ...referralFieldsForCode(referralCode),
    ...options,
  };
}

test("existing handle-based referral resolves to canonical Creator.id", async () => {
  const db = fakeDb([creator("creator-a", "jp-choyon-khan")]);
  const resolved = await resolveReferralCode(
    { shop, code: "jp-choyon-khan" },
    db,
  );

  assert.equal(resolved?.creatorId, "creator-a");
  assert.equal(resolved?.referralCode, "jp-choyon-khan");
});

test("numeric-style legacy referral code resolves without parsing the id", async () => {
  const db = fakeDb([creator("canonical-id", "creator-25337427558745")]);
  const resolved = await resolveReferralCode(
    { shop, code: "creator-25337427558745" },
    db,
  );

  assert.equal(resolved?.creatorId, "canonical-id");
});

test("underscore referral code remains distinct from compact code", async () => {
  const db = fakeDb([
    creator("underscore", "creator_abc123"),
    creator("compact", "creatorabc123"),
  ]);

  assert.equal(
    (await resolveReferralCode({ shop, code: "creator_abc123" }, db))?.creatorId,
    "underscore",
  );
  assert.equal(
    (await resolveReferralCode({ shop, code: "creatorabc123" }, db))?.creatorId,
    "compact",
  );
});

test("hyphen referral code remains distinct from compact code", async () => {
  const db = fakeDb([creator("hyphen", "abc-def"), creator("compact", "abcdef")]);

  assert.equal(
    (await resolveReferralCode({ shop, code: "abc-def" }, db))?.creatorId,
    "hyphen",
  );
  assert.equal(
    (await resolveReferralCode({ shop, code: "abcdef" }, db))?.creatorId,
    "compact",
  );
});

test("name-style and random referral codes are valid", async () => {
  const db = fakeDb([creator("name-code", "choyon-khan"), creator("random", "RHM82K")]);

  assert.equal(
    (await resolveReferralCode({ shop, code: "choyon-khan" }, db))?.creatorId,
    "name-code",
  );
  assert.equal(
    (await resolveReferralCode({ shop, code: "RHM82K" }, db))?.creatorId,
    "random",
  );
});

test("case-insensitive lookup preserves the stored referral code", async () => {
  const db = fakeDb([creator("random", "RHM82K")]);
  const resolved = await resolveReferralCode({ shop, code: "rhm82k" }, db);

  assert.equal(resolved?.creatorId, "random");
  assert.equal(resolved?.referralCode, "RHM82K");
});

test("invalid or missing referral code returns not found safely", async () => {
  const db = fakeDb([creator("creator-a", "jp-choyon-khan")]);

  assert.equal(await resolveReferralCode({ shop, code: "" }, db), null);
  assert.equal(await resolveReferralCode({ shop, code: "x".repeat(101) }, db), null);
  assert.equal(await resolveReferralCode({ shop, code: "abc%0Adef" }, db), null);
  assert.equal(await resolveReferralCode({ shop, code: "missing" }, db), null);
});

test("another shop referral code does not resolve under the wrong shop", async () => {
  const db = fakeDb([
    creator("creator-a", "jp-choyon-khan", { shop }),
    creator("creator-b", "jp-choyon-khan", { shop: "other-shop.test" }),
  ]);

  assert.equal(
    (await resolveReferralCode({ shop: "other-shop.test", code: "jp-choyon-khan" }, db))
      ?.creatorId,
    "creator-b",
  );
  assert.equal(
    await resolveReferralCode({ shop: "missing-shop.test", code: "jp-choyon-khan" }, db),
    null,
  );
});

test("creator name and handle changes do not regenerate existing referralCode", async () => {
  const db = fakeDb([
    creator("creator-a", "jp-choyon-khan", {
      handle: "new-public-handle",
      displayName: "New Name",
    }),
  ]);

  const fields = await ensureCreatorReferralCode(db.creators[0], db);

  assert.equal(fields.referralCode, "jp-choyon-khan");
  assert.equal(db.updates.length, 0);
});

test("missing referralCode is initialized from current handle only once", async () => {
  const db = fakeDb([
    creator("creator-a", "old-code", {
      handle: "current-handle",
      referralCode: null,
      referralCodeNormalized: null,
    }),
  ]);

  const fields = await ensureCreatorReferralCode(db.creators[0], db);

  assert.equal(fields.referralCode, "current-handle");
  assert.equal(fields.referralCodeNormalized, "current-handle");
  assert.equal(db.updates.length, 1);
});

test("referral schema supports canonical creator relationship and attribution uniqueness", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const creatorBlock = schema.match(/model Creator \{[\s\S]*?\n\}/)?.[0] || "";
  const attributionBlock =
    schema.match(/model ReferralAttribution \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(creatorBlock, /referralCode\s+String/);
  assert.match(creatorBlock, /referralCodeNormalized\s+String/);
  assert.match(creatorBlock, /referredByCreatorId\s+String\?/);
  assert.match(creatorBlock, /@@unique\(\[shop, referralCodeNormalized\]\)/);
  assert.match(creatorBlock, /@relation\("CreatorReferralTree", fields: \[referredByCreatorId\], references: \[id\]/);
  assert.match(attributionBlock, /shopifyCustomerId\s+String/);
  assert.match(attributionBlock, /referrerCreatorId\s+String/);
  assert.match(attributionBlock, /referralCodeSnapshot\s+String/);
  assert.match(attributionBlock, /status\s+ReferralAttributionStatus\s+@default\(CAPTURED\)/);
  assert.match(attributionBlock, /@@unique\(\[shop, shopifyCustomerId\]\)/);
  assert.match(attributionBlock, /@@index\(\[referrerCreatorId\]\)/);
});

test("migration backfills exact handle codes and assigns no historical referrers", () => {
  const migration = readFileSync(
    "prisma/migrations/20260820000000_creator_referral_foundation/migration.sql",
    "utf8",
  );

  assert.match(migration, /"referralCode" = "handle"/);
  assert.match(migration, /"referralCodeNormalized" = lower\("handle"\)/);
  assert.match(migration, /GROUP BY "shop", lower\("referralCode"\)/);
  assert.match(migration, /"referredByCreatorId" TEXT/);
  assert.doesNotMatch(migration, /SET\s+"referredByCreatorId"/i);
  assert.match(migration, /"ReferralAttribution"/);
});

test("pending referral token resolves only for approved creators", async () => {
  const db = fakeDb([
    creator("approved", "RHM82K"),
    creator("pending", "WAITING", { status: "PENDING" }),
  ]);

  const resolved = await createPendingReferral(
    { shop, code: "rhm82k", now: 1_000 },
    db,
  );
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.referralCode, "RHM82K");
  assert.equal(resolved.maxAgeSeconds, 30 * 24 * 60 * 60);

  const ineligible = await createPendingReferral({ shop, code: "WAITING" }, db);
  assert.equal(ineligible.status, "INELIGIBLE");
});

test("first valid pending referral token wins in the browser", async () => {
  const db = fakeDb([
    creator("creator-a", "FIRST"),
    creator("creator-b", "SECOND"),
  ]);
  const first = await createPendingReferral(
    { shop, code: "FIRST", now: 2_000 },
    db,
  );
  assert.equal(first.status, "RESOLVED");

  const second = await createPendingReferral(
    { shop, code: "SECOND", existingToken: first.token, now: 3_000 },
    db,
  );
  assert.deepEqual(second, { status: "PENDING_EXISTS" });
});

test("expired pending referral tokens are rejected safely", () => {
  const token = signPendingReferralToken({
    version: 1,
    shop,
    referrerCreatorId: "creator-a",
    referralCodeSnapshot: "FIRST",
    issuedAt: 1_000,
    expiresAt: 2_000,
    nonce: "nonce",
  });

  assert.deepEqual(verifyPendingReferralToken(token, 2_001), {
    ok: false,
    reason: "TOKEN_EXPIRED",
  });
  assert.deepEqual(verifyPendingReferralToken(`${token}x`, 1_500), {
    ok: false,
    reason: "TOKEN_INVALID",
  });
});

test("claiming pending referral creates attribution only", async () => {
  const db = fakeDb([
    creator("referrer", "RHM82K", {
      customerId: "gid://shopify/Customer/111",
    }),
  ]);
  const pending = await createPendingReferral(
    { shop, code: "RHM82K", now: 1_000 },
    db,
  );
  assert.equal(pending.status, "RESOLVED");

  const claimed = await claimPendingReferral(
    { shop, customerId: "222", token: pending.token, now: 1_500 },
    db,
  );

  assert.equal(claimed.status, "CLAIMED");
  assert.equal(db.creators.length, 1);
  assert.equal(db.attributions.length, 1);
  assert.equal(db.attributions[0]?.shopifyCustomerId, "gid://shopify/Customer/222");
  assert.equal(db.attributions[0]?.referrerCreatorId, "referrer");
  assert.equal(db.attributions[0]?.referralCodeSnapshot, "RHM82K");
});

test("claiming is idempotent and rejects self or existing creators", async () => {
  const db = fakeDb([
    creator("referrer", "RHM82K", {
      customerId: "gid://shopify/Customer/111",
    }),
    creator("other-creator", "OTHER", {
      customerId: "gid://shopify/Customer/333",
    }),
  ]);
  const pending = await createPendingReferral(
    { shop, code: "RHM82K", now: 1_000 },
    db,
  );
  assert.equal(pending.status, "RESOLVED");

  assert.equal(
    (await claimPendingReferral({
      shop,
      customerId: "111",
      token: pending.token,
      now: 1_500,
    }, db)).status,
    "SELF_REFERRAL",
  );
  assert.equal(
    (await claimPendingReferral({
      shop,
      customerId: "333",
      token: pending.token,
      now: 1_500,
    }, db)).status,
    "EXISTING_CREATOR",
  );
  assert.equal(
    (await claimPendingReferral({
      shop,
      customerId: "444",
      token: pending.token,
      now: 1_500,
    }, db)).status,
    "CLAIMED",
  );
  assert.equal(
    (await claimPendingReferral({
      shop,
      customerId: "444",
      token: pending.token,
      now: 1_500,
    }, db)).status,
    "ALREADY_ATTRIBUTED",
  );
});

test("Phase 3 referral storefront wiring uses signed pending tokens", () => {
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");
  const dashboardScript = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const header = readFileSync("theme-export/sections/header.liquid", "utf8");
  const resolveRoute = readFileSync(
    "app/routes/proxy.api.referral.resolve.tsx",
    "utf8",
  );
  const claimRoute = readFileSync(
    "app/routes/proxy.api.referral.claim.tsx",
    "utf8",
  );

  assert.match(dashboardService, /referralCode: creator\.referralCode/);
  assert.match(dashboardScript, /function referralFor\(referralCode\)/);
  assert.match(dashboardScript, /view\.data\.referralCode \|\| view\.data\.handle/);
  assert.doesNotMatch(dashboardScript, /safeHandle\.replace\(/);
  assert.match(dashboardScript, /customhouse_referral_pending/);
  assert.match(dashboardScript, /claimPendingReferralCookie/);
  assert.match(header, /api\/referral\/resolve\?ref=/);
  assert.match(header, /customer_authentication\/login\?return_to=/);
  assert.match(header, /SameSite=Lax/);
  assert.match(resolveRoute, /createPendingReferral/);
  assert.match(resolveRoute, /proxyContext\(request, false\)/);
  assert.match(claimRoute, /claimPendingReferral/);
  assert.match(claimRoute, /customerId/);
  assert.doesNotMatch(claimRoute, /body\.customerId/);
});

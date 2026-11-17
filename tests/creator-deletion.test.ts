import assert from "node:assert/strict";
import test from "node:test";
let creatorService: Record<string, unknown> = {};
try {
  creatorService = await import("../app/services/creator-deletion.ts");
} catch {
  // The RED run starts before the focused deletion service exists.
}

type Counts = {
  creatorProducts: number;
  submissions: number;
  designSessions: number;
  creatorDesigns: number;
  sales: number;
  orderItems: number;
  referredCreators: number;
  referralAttributions: number;
  referralEarningsEarned: number;
  referralEarningsGenerated: number;
  payoutMethods: number;
  payouts: number;
};

const emptyCounts: Counts = {
  creatorProducts: 0,
  submissions: 0,
  designSessions: 0,
  creatorDesigns: 0,
  sales: 0,
  orderItems: 0,
  referredCreators: 0,
  referralAttributions: 0,
  referralEarningsEarned: 0,
  referralEarningsGenerated: 0,
  payoutMethods: 0,
  payouts: 0,
};

function deletionApi() {
  const value = creatorService as {
    getCreatorDeletionEligibility?: (
      shop: string,
      creatorId: string,
      database: unknown,
    ) => Promise<{ eligible: boolean; blockers: string[] }>;
    deleteCreatorPermanently?: (
      shop: string,
      creatorId: string,
      confirmation: unknown,
      database: unknown,
    ) => Promise<{ id: string; displayName: string; handle: string }>;
  };
  assert.equal(
    typeof value.getCreatorDeletionEligibility,
    "function",
    "getCreatorDeletionEligibility must be exported",
  );
  assert.equal(
    typeof value.deleteCreatorPermanently,
    "function",
    "deleteCreatorPermanently must be exported",
  );
  return value as Required<typeof value>;
}

function fakeDatabase(input?: {
  counts?: Partial<Counts>;
  referredByCreatorId?: string | null;
  collectionId?: string | null;
  creatorProfileMetaobjectId?: string | null;
  marketplaceCollection?: { id: string } | null;
}) {
  const auditEvents: Array<Record<string, unknown>> = [];
  let creator: Record<string, unknown> | null = {
    id: "creator_test",
    shop: "customhouse.myshopify.com",
    customerId: "gid://shopify/Customer/999",
    displayName: "Demo Creator",
    handle: "demo-creator",
    referredByCreatorId: input?.referredByCreatorId ?? null,
    collectionId: input?.collectionId ?? null,
    creatorProfileMetaobjectId: input?.creatorProfileMetaobjectId ?? null,
    marketplaceCollection: input?.marketplaceCollection ?? null,
    _count: { ...emptyCounts, ...input?.counts },
  };
  let applicationsDeleted = 0;
  let customerDeleteCalls = 0;
  const database = {
    creator: {
      findFirst: async ({ where }: { where: { id: string; shop: string } }) =>
        creator && creator.id === where.id && creator.shop === where.shop
          ? creator
          : null,
      delete: async () => {
        const deleted = creator;
        creator = null;
        return deleted;
      },
    },
    creatorApplication: {
      deleteMany: async () => {
        applicationsDeleted += 1;
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
    $queryRaw: async () => (creator ? [{ id: creator.id }] : []),
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) =>
      callback(database),
    shopifyCustomer: {
      delete: async () => {
        customerDeleteCalls += 1;
      },
    },
  };
  return {
    database,
    getCreator: () => creator,
    getAuditEvents: () => auditEvents,
    getApplicationsDeleted: () => applicationsDeleted,
    getCustomerDeleteCalls: () => customerDeleteCalls,
  };
}

test("dependency-free test Creator can be permanently deleted", async () => {
  const api = deletionApi();
  const fake = fakeDatabase();

  const deleted = await api.deleteCreatorPermanently(
    "customhouse.myshopify.com",
    "creator_test",
    "DELETE",
    fake.database,
  );

  assert.deepEqual(deleted, {
    id: "creator_test",
    displayName: "Demo Creator",
    handle: "demo-creator",
  });
  assert.equal(fake.getCreator(), null);
  assert.equal(fake.getApplicationsDeleted(), 1);
});

for (const [label, counts] of [
  ["CreatorProduct", { creatorProducts: 1 }],
  ["CreatorOrderItem", { orderItems: 1 }],
  ["CreatorSale", { sales: 1 }],
  ["payout method", { payoutMethods: 1 }],
  ["payout and allocation history", { payouts: 1 }],
  ["referral attribution", { referralAttributions: 1 }],
  ["referral earning as referrer", { referralEarningsEarned: 1 }],
  ["referral earning as referred Creator", { referralEarningsGenerated: 1 }],
  ["referred Creator", { referredCreators: 1 }],
  ["design submission", { submissions: 1 }],
  ["design session", { designSessions: 1 }],
  ["Creator design", { creatorDesigns: 1 }],
] as const) {
  test(`Creator with ${label} dependency cannot be deleted`, async () => {
    const api = deletionApi();
    const fake = fakeDatabase({ counts });

    await assert.rejects(
      api.deleteCreatorPermanently(
        "customhouse.myshopify.com",
        "creator_test",
        "DELETE",
        fake.database,
      ),
      /historical or financial records.*Deactivate the Creator instead/i,
    );

    assert.notEqual(fake.getCreator(), null);
    assert.equal(fake.getApplicationsDeleted(), 0);
  });
}

test("Creator referral-parent relation blocks permanent deletion", async () => {
  const api = deletionApi();
  const fake = fakeDatabase({ referredByCreatorId: "creator_referrer" });
  const eligibility = await api.getCreatorDeletionEligibility(
    "customhouse.myshopify.com",
    "creator_test",
    fake.database,
  );
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.blockers.includes("referral relationship"));
});

for (const [label, input] of [
  ["Creator collection", { marketplaceCollection: { id: "collection_1" } }],
  ["legacy collection mapping", { collectionId: "gid://shopify/Collection/1" }],
  ["Creator profile metaobject", { creatorProfileMetaobjectId: "gid://shopify/Metaobject/1" }],
] as const) {
  test(`${label} blocks permanent deletion`, async () => {
    const api = deletionApi();
    const fake = fakeDatabase(input);
    const eligibility = await api.getCreatorDeletionEligibility(
      "customhouse.myshopify.com",
      "creator_test",
      fake.database,
    );
    assert.equal(eligibility.eligible, false);
  });
}

test("permanent deletion requires the exact DELETE confirmation", async () => {
  const api = deletionApi();
  const fake = fakeDatabase();
  await assert.rejects(
    api.deleteCreatorPermanently(
      "customhouse.myshopify.com",
      "creator_test",
      "delete",
      fake.database,
    ),
    /Type DELETE/i,
  );
  assert.notEqual(fake.getCreator(), null);
});

test("safe deletion creates an independent Admin audit event", async () => {
  const api = deletionApi();
  const fake = fakeDatabase();
  await api.deleteCreatorPermanently(
    "customhouse.myshopify.com",
    "creator_test",
    "DELETE",
    fake.database,
  );
  const [event] = fake.getAuditEvents();
  assert.equal(event.action, "creator.deleted_permanently");
  assert.equal(event.entityType, "Creator");
  assert.equal(event.entityId, "creator_test");
  assert.match(String(event.beforeJson), /Demo Creator/);
  assert.match(String(event.afterJson), /shopifyCustomerPreserved/);
});

test("permanent Creator deletion never deletes the Shopify customer account", async () => {
  const api = deletionApi();
  const fake = fakeDatabase();
  await api.deleteCreatorPermanently(
    "customhouse.myshopify.com",
    "creator_test",
    "DELETE",
    fake.database,
  );
  assert.equal(fake.getCustomerDeleteCalls(), 0);
});

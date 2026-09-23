import assert from "node:assert/strict";
import test from "node:test";
import type { Creator } from "@prisma/client";
import {
  creatorStatusFromTags,
  defaultHeliumMetafieldMap,
  DEFAULT_HELIUM_CREATOR_FORM_ID,
  hasConflictingCreatorTags,
  isHeliumCreatorFormSubmission,
  isHeliumProfileUpdateFormSubmission,
  loadWithLazySync,
  normalizeCustomerGid,
  parseHeliumFormIds,
  planHeliumSync,
  serializeHeliumMetafieldMap,
  withHeliumCreatorFormTags,
} from "../app/services/helium-sync.ts";

test("Helium form IDs accept all observed storage formats", () => {
  assert.deepEqual(parseHeliumFormIds('["lXteLY","other"]'), [
    "lXteLY",
    "other",
  ]);
  assert.deepEqual(parseHeliumFormIds('"lXteLY"'), ["lXteLY"]);
  assert.deepEqual(parseHeliumFormIds("lXteLY"), ["lXteLY"]);
  assert.deepEqual(parseHeliumFormIds("lXteLY, other"), ["lXteLY", "other"]);
});

test("confirmed Helium form submission receives pending creator tags", () => {
  const input = withHeliumCreatorFormTags(
    { customerId: "1", tags: [], formIds: ["lXteLY"] },
    "lXteLY",
  );
  assert.equal(creatorStatusFromTags(input.tags), "PENDING");
  assert.deepEqual(input.tags.sort(), [
    "creator-applicant",
    "creator-pending",
  ]);
});

test("default Helium creator form is used when admin setting is blank", () => {
  assert.equal(DEFAULT_HELIUM_CREATOR_FORM_ID, "lXteLY");
  assert.equal(isHeliumCreatorFormSubmission(["lXteLY"], null), true);
  assert.equal(isHeliumCreatorFormSubmission(["dGtXke"], null), false);
  const input = withHeliumCreatorFormTags(
    { customerId: "1", tags: [], formIds: ["lXteLY"] },
    null,
  );
  assert.equal(creatorStatusFromTags(input.tags), "PENDING");
});

test("profile update form never becomes a new creator application", () => {
  const input = withHeliumCreatorFormTags(
    { customerId: "1", tags: [], formIds: ["dGtXke"] },
    null,
  );
  assert.equal(creatorStatusFromTags(input.tags), null);
});

test("manual Helium mapping defaults to the live Helium update keys", () => {
  const form = new FormData();
  for (const field of Object.keys(defaultHeliumMetafieldMap())) {
    form.set(`helium.${field}.enabled`, "on");
  }

  const map = JSON.parse(serializeHeliumMetafieldMap(form));
  assert.equal(map.legalName.namespace, "customer_fields");
  assert.equal(map.legalName.key, "legal_name");
  assert.equal(map.creatorDisplayName.key, "creator_display_name_1");
  assert.equal(map.creatorProfilePhoto.key, "creator_profile_photo_1");
  assert.equal(map.portfolioUrl.key, "socialportfolio_url");
  assert.equal(map.socialProfiles.key, "socialportfolio_url");
  assert.equal(map.termsAccepted.key, "terms_agreement");
  assert.equal(map.applicationMessage.key, "application_message");
});

test("unrelated Helium form does not become a creator", () => {
  const input = withHeliumCreatorFormTags(
    { customerId: "1", tags: [], formIds: ["other-form"] },
    "lXteLY",
  );
  assert.equal(creatorStatusFromTags(input.tags), null);
});

test("profile update form is recognized separately from the application form", () => {
  assert.equal(isHeliumProfileUpdateFormSubmission(["dGtXke"]), true);
  assert.equal(isHeliumProfileUpdateFormSubmission(["lXteLY"]), false);
});

function creator(overrides: Partial<Creator> = {}): Creator {
  return {
    id: "creator-1",
    shop: "test.myshopify.com",
    customerId: normalizeCustomerGid("1"),
    displayName: "Creator 1",
    handle: "creator-1",
    referralCode: "creator-1",
    referralCodeNormalized: "creator-1",
    referredByCreatorId: null,
    bio: null,
    portfolioUrl: null,
    profileImageUrl: null,
    socialLinksJson: "[]",
    emailSnapshot: null,
    legalName: null,
    country: null,
    city: null,
    primaryPlatform: null,
    primaryProfileUrl: null,
    audienceRange: null,
    categoriesJson: "[]",
    aboutWork: null,
    termsAcceptedAt: null,
    submittedAt: null,
    reviewedAt: null,
    applicationSource: "HELIUM_IMPORT",
    statusAuthority: "HELIUM_IMPORT",
    lastExternalSyncAt: null,
    externalSnapshotHash: null,
    externalSyncConflict: false,
    status: "PENDING",
    collectionId: null,
    creatorProfileMetaobjectId: null,
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
    welcomeEmailSentAt: null,
    rejectionReason: null,
    suspensionReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("imports a Helium pending applicant", () => {
  const plan = planHeliumSync(null, {
    customerId: "1",
    tags: ["creator-applicant", "creator-pending"],
    fields: { creatorDisplayName: "Ada" },
  });
  assert.equal(plan.action, "CREATE");
  assert.equal(plan.status, "PENDING");
  assert.equal(plan.data.displayName, "Ada");
});

test("imports an approved creator", () => {
  const plan = planHeliumSync(null, {
    customerId: "2",
    tags: ["creator-approved"],
  });
  assert.equal(plan.action, "CREATE");
  assert.equal(plan.status, "APPROVED");
});

test("duplicate webhook delivery becomes a skip", () => {
  assert.equal(
    planHeliumSync(creator(), { customerId: "1", tags: ["creator-pending"] })
      .action,
    "SKIP",
  );
});

test("conflicting tags choose the most restrictive status", () => {
  assert.equal(
    hasConflictingCreatorTags(["creator-approved", "creator-suspended"]),
    true,
  );
  assert.equal(
    creatorStatusFromTags(["creator-approved", "creator-suspended"]),
    "SUSPENDED",
  );
  assert.equal(
    creatorStatusFromTags(["creator-pending", "creator-rejected"]),
    "REJECTED",
  );
});

test("external status updates Helium authority but not CUSTOM_APP authority", () => {
  assert.equal(
    planHeliumSync(creator(), { customerId: "1", tags: ["creator-approved"] })
      .data.status,
    "APPROVED",
  );
  assert.equal(
    planHeliumSync(creator({ status: "APPROVED", statusAuthority: "CUSTOM_APP", approvedAt: new Date() }), {
      customerId: "1",
      tags: ["creator-rejected"],
    }).result,
    "CONFLICT",
  );
});

test("profile updates continue for CUSTOM_APP authority", () => {
  const plan = planHeliumSync(creator({ status: "APPROVED", statusAuthority: "CUSTOM_APP" }), { customerId: "1", tags: ["creator-pending"], fields: { shortCreatorBio: "Updated external biography" } });
  assert.equal(plan.result, "CONFLICT"); assert.equal(plan.data.status, undefined); assert.equal(plan.data.bio, "Updated external biography");
});

test("profile update form preserves existing approved creator status", () => {
  const plan = planHeliumSync(
    creator({
      status: "APPROVED",
      statusAuthority: "CUSTOM_APP",
      approvedAt: new Date(),
    }),
    {
      customerId: "1",
      tags: ["creator-pending"],
      formIds: ["dGtXke"],
      fields: { creatorDisplayName: "Updated Creator" },
    },
  );

  assert.equal(plan.action, "UPDATE");
  assert.equal(plan.result, "UPDATED");
  assert.equal(plan.status, "APPROVED");
  assert.equal(plan.data.status, undefined);
  assert.equal(plan.data.displayName, "Updated Creator");
});

test("profile update social link is stored as dashboard JSON", () => {
  const plan = planHeliumSync(
    creator({ status: "APPROVED", statusAuthority: "CUSTOM_APP" }),
    {
      customerId: "1",
      formIds: ["dGtXke"],
      tags: [],
      fields: { socialProfiles: "https://instagram.com/customhouse" },
    },
  );

  assert.equal(
    plan.data.socialLinksJson,
    '["https://instagram.com/customhouse"]',
  );
});

test("profile refresh repairs missing fields even when snapshot is unchanged", () => {
  const plan = planHeliumSync(
    creator({
      status: "APPROVED",
      statusAuthority: "CUSTOM_APP",
      externalSnapshotHash: "same-snapshot",
      bio: null,
      portfolioUrl: null,
      socialLinksJson: "[]",
    }),
    {
      customerId: "1",
      snapshotHash: "same-snapshot",
      formIds: ["dGtXke"],
      tags: [],
      fields: {
        shortCreatorBio: "Restored Helium bio",
        portfolioUrl: "https://example.com/restored",
      },
    },
  );

  assert.equal(plan.action, "UPDATE");
  assert.equal(plan.data.bio, "Restored Helium bio");
  assert.equal(plan.data.portfolioUrl, "https://example.com/restored");
  assert.equal(plan.data.socialLinksJson, '["https://example.com/restored"]');
});

test("existing creator profile refresh does not require Helium tags or form IDs", () => {
  const plan = planHeliumSync(
    creator({ status: "APPROVED", statusAuthority: "CUSTOM_APP" }),
    {
      customerId: "1",
      formIds: [],
      tags: [],
      fields: {
        legalName: "Updated Legal",
        creatorDisplayName: "Updated Display",
        shortCreatorBio: "Updated bio from Helium",
        portfolioUrl: "https://example.com/profile",
      },
    },
    { useExistingStatus: true },
  );

  assert.equal(plan.action, "UPDATE");
  assert.equal(plan.status, "APPROVED");
  assert.equal(plan.data.legalName, "Updated Legal");
  assert.equal(plan.data.displayName, "Updated Display");
  assert.equal(plan.data.bio, "Updated bio from Helium");
  assert.equal(plan.data.portfolioUrl, "https://example.com/profile");
});

test("normalizes all supported customer ID forms and rejects invalid IDs", () => {
  assert.equal(normalizeCustomerGid(123), "gid://shopify/Customer/123");
  assert.equal(normalizeCustomerGid("123"), "gid://shopify/Customer/123");
  assert.equal(normalizeCustomerGid("000123"), "gid://shopify/Customer/123");
  assert.equal(normalizeCustomerGid("gid://shopify/Customer/123"), "gid://shopify/Customer/123");
  assert.throws(() => normalizeCustomerGid("customer-123"), /invalid/i);
  assert.throws(() => normalizeCustomerGid("0"), /invalid/i);
  assert.throws(() => normalizeCustomerGid(Number.MAX_SAFE_INTEGER + 1), /invalid/i);
});

test("dashboard performs one lazy synchronization then reloads", async () => {
  let found = false;
  let syncs = 0;
  const result = await loadWithLazySync(
    async () => ({ creatorFound: found, state: found ? "PENDING" : "MISSING" }),
    async () => {
      syncs++;
      found = true;
    },
  );
  assert.equal(syncs, 1);
  assert.equal(result.creatorFound, true);
  assert.equal(result.state, "PENDING");
});

test("dashboard does not lazy sync an existing creator", async () => {
  let syncs = 0;
  await loadWithLazySync(
    async () => ({ creatorFound: true }),
    async () => {
      syncs++;
    },
  );
  assert.equal(syncs, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyLegacyCreatorProductRepair,
  classifyLegacyCompatibility,
  compatibilityReady,
  legacySetupDraft,
  validateLegacyManualMapping,
  type LegacyProductRecord,
  type LegacyShopifyProductEvidence,
} from "../app/services/creator-product-legacy-remediation.server.ts";

const shop = "customhouse.test";
const productId = "creator-product-1";
const baseProductId = "gid://shopify/Product/100";
const publishedProductId = "gid://shopify/Product/200";

function variants() {
  return [
    {
      id: "gid://shopify/ProductVariant/101",
      title: "Black / S",
      availableForSale: true,
      selectedOptions: [
        { name: "Color", value: "Black" },
        { name: "Size", value: "S" },
      ],
    },
    {
      id: "gid://shopify/ProductVariant/102",
      title: "White / S",
      availableForSale: true,
      selectedOptions: [
        { name: "Color", value: "White" },
        { name: "Size", value: "S" },
      ],
    },
  ];
}

function record(overrides: Partial<LegacyProductRecord> = {}): LegacyProductRecord {
  return {
    id: productId,
    shop,
    creatorId: "creator-1",
    shopifyProductId: baseProductId,
    baseProductTitle: "Base shirt",
    pitchprintProjectId: "saved-project-1",
    pitchprintDesignId: "saved-design-1",
    title: "Creator shirt",
    status: "PUBLISHED",
    publishedShopifyProductId: publishedProductId,
    designVariantSelectionsJson: JSON.stringify({
      schema: "creator_design_setup_v1",
      flowMode: "CREATOR_DESIGN",
      interactionMode: "CREATOR_DESIGN",
      designMode: "creator_design",
      isCreatorProduct: true,
      copyrightAccepted: true,
    }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    creator: {
      id: "creator-1",
      displayName: "Creator One",
      handle: "creator-one",
      status: "APPROVED",
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<LegacyShopifyProductEvidence> = {}) {
  return {
    id: publishedProductId,
    title: "Creator shirt",
    handle: "creator-shirt",
    status: "ACTIVE",
    productOrigin: "creator",
    designMode: "buy_only",
    designStatus: "published",
    productType: "creator_fixed",
    creatorId: "creator-1",
    creatorProductId: productId,
    fixedColor: null,
    productionMethod: null,
    designedPlacementCount: null,
    creatorCartValidation: null,
    variants: variants(),
    ...overrides,
  } satisfies LegacyShopifyProductEvidence;
}

test("invalid color is rejected", () => {
  assert.throws(
    () => legacySetupDraft(record(), { fixedColor: "Blue", productionMethod: "DTF", placementCount: 1 }, variants(), ["DTF"]),
    /base product/i,
  );
});

test("invalid production method is rejected", () => {
  assert.throws(
    () => legacySetupDraft(record(), { fixedColor: "Black", productionMethod: "Screen print", placementCount: 1 }, variants(), ["DTF"]),
    /printing method/i,
  );
});

test("zero placement count is rejected", () => {
  assert.throws(
    () => legacySetupDraft(record(), { fixedColor: "Black", productionMethod: "DTF", placementCount: 0 }, variants(), ["DTF"]),
    /placement count/i,
  );
});

test("global or base Shopify product cannot be selected as a mapping", () => {
  assert.throws(
    () => validateLegacyManualMapping(record(), candidate({ id: baseProductId }), null, true),
    /base product/i,
  );
  assert.throws(
    () => validateLegacyManualMapping(record(), candidate({ productOrigin: "global" }), null, true),
    /canonical Creator buy-only product/i,
  );
});

test("product already mapped to another CreatorProduct is rejected", () => {
  assert.throws(
    () => validateLegacyManualMapping(record(), candidate(), "creator-product-2", true),
    /another CreatorProduct/i,
  );
});

test("ambiguous mapping requires explicit confirmation", () => {
  assert.throws(
    () => validateLegacyManualMapping(record(), candidate(), null, false),
    /Confirm Shopify product mapping/i,
  );
});

test("mapping identity must remain in the correct Creator context", () => {
  assert.throws(
    () => validateLegacyManualMapping(record(), candidate({ creatorId: "creator-2" }), null, true),
    /Creator context/i,
  );
});

function repairHarness(overrides: { mapped?: boolean; republish?: boolean } = {}) {
  const current = record({
    publishedShopifyProductId: overrides.mapped === false ? null : publishedProductId,
  });
  const updates: unknown[] = [];
  const auditWrites: Array<{ data: { action: string; afterJson?: string } }> = [];
  const publisherCalls: string[] = [];
  const forbiddenFinancialWrites: string[] = [];
  const database = {
    creatorProduct: {
      async findFirst(args: { where?: { publishedShopifyProductId?: string } }) {
        if (args.where?.publishedShopifyProductId) return null;
        return current;
      },
      async update(args: { data: Record<string, unknown> }) {
        updates.push(args.data);
        Object.assign(current, args.data);
        return current;
      },
    },
    productionMethodSetting: {
      async findMany() {
        return [{ method: "DTF", enabled: true }];
      },
    },
    auditLog: {
      async create(args: { data: { action: string; afterJson?: string } }) {
        auditWrites.push(args);
        return args;
      },
    },
    creatorOrderItem: { async update() { forbiddenFinancialWrites.push("order"); } },
    creatorSale: { async update() { forbiddenFinancialWrites.push("sale"); } },
    payout: { async update() { forbiddenFinancialWrites.push("payout"); } },
  };
  const dependencies = {
    database,
    async loadProductEvidence(id: string) {
      if (id === baseProductId) return candidate({ id: baseProductId, productOrigin: "global" });
      return candidate({ id });
    },
    async findCanonicalCandidates() {
      return overrides.republish ? [] : [candidate()];
    },
    async publish(_shop: string, id: string) {
      publisherCalls.push(id);
      current.publishedShopifyProductId ||= "gid://shopify/Product/300";
      return current;
    },
  };
  return { current, updates, auditWrites, publisherCalls, forbiddenFinancialWrites, dependencies };
}

test("valid repair persists canonical setup and uses the canonical publisher", async () => {
  const harness = repairHarness();
  await applyLegacyCreatorProductRepair(
    shop,
    "admin-1",
    { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 2, confirmApply: true },
    {} as never,
    harness.dependencies as never,
  );
  const setup = JSON.parse(String((harness.updates[0] as { designVariantSelectionsJson: string }).designVariantSelectionsJson));
  assert.equal(setup.fixedColor, "Black");
  assert.equal(setup.productionMethod, "DTF");
  assert.equal(setup.placementCount, 2);
  assert.deepEqual(harness.publisherCalls, [productId]);
});

test("an unchanged existing mapping does not require mapping confirmation", async () => {
  const harness = repairHarness();
  await applyLegacyCreatorProductRepair(
    shop,
    "admin-1",
    {
      creatorProductId: productId,
      fixedColor: "Black",
      productionMethod: "DTF",
      placementCount: 1,
      mappingProductId: publishedProductId,
      confirmApply: true,
    },
    {} as never,
    harness.dependencies as never,
  );
  assert.deepEqual(harness.publisherCalls, [productId]);
});

test("a stored mapping to the global base product is blocked", async () => {
  const harness = repairHarness();
  harness.current.publishedShopifyProductId = baseProductId;
  await assert.rejects(
    applyLegacyCreatorProductRepair(
      shop,
      "admin-1",
      {
        creatorProductId: productId,
        fixedColor: "Black",
        productionMethod: "DTF",
        placementCount: 1,
        confirmApply: true,
      },
      {} as never,
      harness.dependencies as never,
    ),
    /global\/base product/i,
  );
  assert.deepEqual(harness.publisherCalls, []);
});

test("financial history is preserved during repair", async () => {
  const harness = repairHarness();
  await applyLegacyCreatorProductRepair(shop, "admin-1", { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 1, confirmApply: true }, {} as never, harness.dependencies as never);
  assert.deepEqual(harness.forbiddenFinancialWrites, []);
});

test("historical orders are unchanged during repair", async () => {
  const harness = repairHarness();
  await applyLegacyCreatorProductRepair(shop, "admin-1", { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 1, confirmApply: true }, {} as never, harness.dependencies as never);
  assert.equal(harness.updates.length, 1);
  assert.ok("designVariantSelectionsJson" in (harness.updates[0] as object));
});

test("manual mapping restoration succeeds and is audited", async () => {
  const harness = repairHarness({ mapped: false });
  await applyLegacyCreatorProductRepair(shop, "admin-1", { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 1, mappingProductId: publishedProductId, confirmMapping: true, confirmApply: true }, {} as never, harness.dependencies as never);
  assert.equal(harness.current.publishedShopifyProductId, publishedProductId);
  assert.ok(harness.auditWrites.some((entry) => entry.data.action === "creator_product.mapping_restored"));
});

test("republish delegates to the canonical publishing service", async () => {
  const harness = repairHarness({ mapped: false, republish: true });
  await applyLegacyCreatorProductRepair(shop, "admin-1", { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 1, republish: true, confirmApply: true }, {} as never, harness.dependencies as never);
  assert.deepEqual(harness.publisherCalls, [productId]);
  assert.ok(harness.auditWrites.some((entry) => entry.data.action === "creator_product.republished"));
});

test("valid repair creates a legacy repair audit log without secrets", async () => {
  const harness = repairHarness();
  await applyLegacyCreatorProductRepair(shop, "admin-1", { creatorProductId: productId, fixedColor: "Black", productionMethod: "DTF", placementCount: 1, confirmApply: true }, {} as never, harness.dependencies as never);
  const audit = harness.auditWrites.find((entry) => entry.data.action === "creator_product.legacy_repaired");
  assert.ok(audit);
  assert.doesNotMatch(audit?.data.afterJson || "", /token|secret|password/i);
});

test("a fully synchronized repaired record becomes compatible", () => {
  const result = classifyLegacyCompatibility(record({ designVariantSelectionsJson: JSON.stringify({ schema: "creator_design_setup_v1", flowMode: "CREATOR_DESIGN", designMode: "creator_design", isCreatorProduct: true, copyrightAccepted: true, fixedColor: "Black", productionMethod: "DTF", placementCount: 1 }) }), candidate({ fixedColor: "Black", productionMethod: "DTF", designedPlacementCount: "1", creatorCartValidation: { version: 1, creatorProductId: productId, feeRequired: false, feeVariantId: null, placementCount: 1 }, variants: [variants()[0]!] }));
  assert.equal(result.status, "COMPATIBLE");
});

test("global audit readiness requires both incompatible counts to be zero", () => {
  assert.equal(compatibilityReady({ needsRepair: 0, missingMapping: 0 }), true);
  assert.equal(compatibilityReady({ needsRepair: 1, missingMapping: 0 }), false);
  assert.equal(compatibilityReady({ needsRepair: 0, missingMapping: 1 }), false);
});

test("the remediation route exposes review, export, cleanup, and canonical publish wiring", () => {
  const source = readFileSync(new URL("../app/routes/app.creator-products_.compatibility.tsx", import.meta.url), "utf8");
  assert.match(source, /Run compatibility audit/);
  assert.match(source, /Export compatibility report/);
  assert.match(source, /cleanupCreatorProductAsAdmin/);
  assert.match(source, /applyLegacyCreatorProductRepair/);
  assert.match(source, /Historical orders and financial records will not be changed/);
});

test("the canonical publisher still owns contract and fixed-color variant synchronization", () => {
  const source = readFileSync(new URL("../app/services/creator-product-publishing.server.ts", import.meta.url), "utf8");
  assert.match(source, /creatorCartValidationContract\s*\(/);
  assert.match(source, /restrictCreatorProductToFixedColor\s*\(/);
  assert.match(source, /customhouse.*creator_cart_validation/s);
});

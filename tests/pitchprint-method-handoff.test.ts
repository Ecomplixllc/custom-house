import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProductionPricingBridgePayload, parseSurchargeInput,
  type PublicProductProductionPricingRecord, type ProductionMethodDefinition,
} from "../app/services/production-method-pricing.server.ts";
import { publicPitchPrintMethodConfig } from "../app/services/pitchprint-method-config.server.ts";
import { creatorPitchPrintConfig } from "../extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js";

const productId = "gid://shopify/Product/16472592548185";
const definitions: ProductionMethodDefinition[] = ["EMBROIDERY", "DTF", "DTG", "STICKER_PRINTING", "SUBLIMATION", "SCREEN_PRINTING"].map(id => ({
  id, label: id === "STICKER_PRINTING" ? "Sticker Printing" : id,
  description: "Registry description", enabled: true,
  pricingBehavior: id === "EMBROIDERY" ? "TIERED" : "SINGLE",
  tiers: id === "EMBROIDERY" ? ["TEXT_ONLY", "IMAGE_OR_LOGO"] : [],
  maxWidthCm: 35, maxHeightCm: 40,
}));
function fixture(enabled: string[]): PublicProductProductionPricingRecord {
  return {
    id: "pricing", shopKey: "shop.test", shopifyProductId: productId, currency: "SEK",
    methodConfigurations: { version: 2, methods: Object.fromEntries(definitions.map(({ id }) => [id,
      id === "EMBROIDERY" ? { enabled: enabled.includes(id), tiers: {
        TEXT_ONLY: { enabled: true, surcharge: "10.00", feeVariantId: "gid://shopify/ProductVariant/901" },
        IMAGE_OR_LOGO: { enabled: false, surcharge: "30.00", feeVariantId: null },
      } } : { enabled: enabled.includes(id), surcharge: "10.00", feeVariantId: "gid://shopify/ProductVariant/902" },
    ])) },
    embroiderySurcharge: parseSurchargeInput("0"), embroideryTextSurcharge: parseSurchargeInput("10"),
    embroideryImageSurcharge: parseSurchargeInput("30"), dtfSurcharge: parseSurchargeInput("20"), dtgSurcharge: parseSurchargeInput("30"),
    embroideryFeeVariantId: null, embroideryTextFeeVariantId: null, embroideryImageFeeVariantId: null,
    dtfFeeVariantId: null, dtgFeeVariantId: null,
  };
}
for (const codes of [["STICKER_PRINTING"], ["DTF", "STICKER_PRINTING"], [], ["SCREEN_PRINTING"]]) {
  test(`canonical handoff serializes exactly enabled product methods: ${codes.join(",") || "none"}`, () => {
    const config = canonicalProductionPricingBridgePayload(fixture(codes), definitions);
    assert.deepEqual(config.productionMethods.map(method => method.code), codes);
    assert.ok(Array.isArray(JSON.parse(JSON.stringify(config)).productionMethods));
    for (const method of config.productionMethods) {
      assert.equal(method.enabled, true);
      assert.equal(method.surchargeMinor, 1000);
      assert.equal(method.currency, "SEK");
      assert.equal(method.description, "Registry description");
      assert.equal(method.maxWidthCm, 35);
      assert.equal(method.feeVariantGid, "gid://shopify/ProductVariant/902");
    }
  });
}
test("retired sublimation is never serialized into a new PitchPrint handoff", () => {
  const config = canonicalProductionPricingBridgePayload(fixture(["SUBLIMATION"]), definitions);
  assert.deepEqual(config.productionMethods, []);
  assert.equal(config.productionMethodPricing.SUBLIMATION, undefined);
});
test("explicit empty version-two configuration never restores legacy methods", () => {
  const row = fixture([]);
  row.methodConfigurations = { version: 2, methods: {} };
  assert.deepEqual(canonicalProductionPricingBridgePayload(row, definitions).productionMethods, []);
});
test("embroidery includes tier states and rates without enabling a disabled tier", () => {
  const [method] = canonicalProductionPricingBridgePayload(fixture(["EMBROIDERY"]), definitions).productionMethods;
  assert.equal(method.embroiderySubtypes?.TEXT_ONLY.enabled, true);
  assert.equal(method.embroiderySubtypes?.TEXT_ONLY.surchargeMinor, 1000);
  assert.equal(method.tiers?.IMAGE_OR_LOGO.enabled, false);
  assert.equal(method.tiers?.IMAGE_OR_LOGO.surchargeMinor, 3000);
});
test("Public and Creator receive the same canonical base-product methods", async () => {
  const row = fixture(["STICKER_PRINTING"]);
  const database = {
    publicProductProductionPricing: { async findUnique() { return row; } },
    productionMethodSetting: { async findMany() { return definitions.map(method => ({
      method: method.id, ...method, configurationJson: { tiers: method.tiers, maxWidthCm: 35, maxHeightCm: 40 },
    })); } },
  };
  const client = { async request() { return { shop: { currencyCode: "SEK" }, product: {
    id: productId, status: "ACTIVE", handle: "t-shirt", tags: ["pitchprint"],
    productType: null, legacyOrigin: null, legacyMode: null, pitchprintEnabled: { value: "true" },
  } }; } };
  const config = await publicPitchPrintMethodConfig("shop.test", productId, client as never, database as never);
  const globalObject = globalThis as unknown as { window?: Record<string, unknown> };
  const previousWindow = globalObject.window;
  globalObject.window = {};
  try {
    const creator = creatorPitchPrintConfig({ __customHouseDashboardState: { baseProducts: [{
      id: productId, productionMethodPricing: config, variants: [],
    }] } }, { id: "creator-1", shopifyProductId: productId }, {});
    assert.deepEqual(creator.productionMethods, config.productionMethods);
    assert.equal(creator.baseProductId, productId);
    assert.equal(creator.flowMode, "CREATOR_DESIGN");
    assert.equal(creator.currency, "SEK");
  } finally { globalObject.window = previousWindow; }
});
test("public config rejects malformed IDs and non-customizable products", async () => {
  const client = { async request() { return { shop: { currencyCode: "SEK" }, product: null }; } };
  await assert.rejects(publicPitchPrintMethodConfig("shop.test", "wrong", client as never), { code: "INVALID_PRODUCT" });
  await assert.rejects(publicPitchPrintMethodConfig("shop.test", productId, client as never), { code: "PRODUCT_NOT_AVAILABLE" });
});

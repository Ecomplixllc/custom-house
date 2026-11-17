import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreatorPublishedPricingPlan,
  creatorProductionPricingPreview,
  CREATOR_PRICING_MODE_BAKED_IN_V1,
} from "../app/services/creator-product-pricing.server.ts";
import { DomainError } from "../app/services/domain.ts";
import { parseSurchargeInput } from "../app/services/production-method-pricing.server.ts";

const pricing = {
  embroiderySurcharge: parseSurchargeInput("99.00"),
  embroideryTextSurcharge: parseSurchargeInput("100.00"),
  embroideryImageSurcharge: parseSurchargeInput("250.00"),
  dtfSurcharge: parseSurchargeInput("75.00"),
  dtgSurcharge: parseSurchargeInput("50.00"),
};

const baseVariants = [
  {
    id: "gid://shopify/ProductVariant/101",
    price: "200.00",
    selectedOptions: [
      { name: "Color", value: "Green" },
      { name: "Size", value: "S" },
    ],
  },
  {
    id: "gid://shopify/ProductVariant/102",
    price: "220.00",
    selectedOptions: [
      { name: "Color", value: "Green" },
      { name: "Size", value: "M" },
    ],
  },
  {
    id: "gid://shopify/ProductVariant/103",
    price: "230.00",
    selectedOptions: [
      { name: "Color", value: "Navy" },
      { name: "Size", value: "S" },
    ],
  },
];

const publishedVariants = [
  {
    id: "gid://shopify/ProductVariant/502",
    price: "220.00",
    selectedOptions: [
      { name: "Size", value: "M" },
      { name: "Color", value: "Green" },
    ],
  },
  {
    id: "gid://shopify/ProductVariant/501",
    price: "200.00",
    selectedOptions: [
      { name: "Size", value: "S" },
      { name: "Color", value: "Green" },
    ],
  },
];

function plan(overrides: Record<string, unknown> = {}) {
  return buildCreatorPublishedPricingPlan({
    creatorProductId: "creator-1",
    baseProductId: "gid://shopify/Product/10",
    publishedProductId: "gid://shopify/Product/50",
    productionMethod: "EMBROIDERY",
    embroiderySubtype: "TEXT_ONLY",
    placementCount: 1,
    pricing,
    baseVariants,
    publishedVariants,
    ...overrides,
  });
}

test("baked pricing uses Embroidery Text and Image/Logo surcharges", () => {
  const text = plan();
  assert.equal(text.pricingMode, CREATOR_PRICING_MODE_BAKED_IN_V1);
  assert.equal(text.surchargeMinor, "10000");
  assert.deepEqual(
    text.variants.map((variant) => [variant.basePrice, variant.finalPrice]),
    [
      ["220.00", "320.00"],
      ["200.00", "300.00"],
    ],
  );

  const image = plan({ embroiderySubtype: "IMAGE_OR_LOGO" });
  assert.equal(image.surchargeMinor, "25000");
  assert.deepEqual(
    image.variants.map((variant) => variant.finalPrice),
    ["470.00", "450.00"],
  );
});

test("DTF and DTG use configured method surcharges and count placements", () => {
  const dtf = plan({
    productionMethod: "DTF",
    embroiderySubtype: null,
    placementCount: 2,
  });
  assert.equal(dtf.productionCostMinor, "15000");
  assert.deepEqual(
    dtf.variants.map((variant) => variant.finalPrice),
    ["370.00", "350.00"],
  );

  const dtg = plan({
    productionMethod: "DTG",
    embroiderySubtype: null,
    placementCount: 1,
  });
  assert.equal(dtg.productionCostMinor, "5000");
});

test("variant mapping uses complete normalized option identity, not order", () => {
  const result = plan();
  assert.deepEqual(
    result.variants.map((variant) => [
      variant.publishedVariantId,
      variant.baseVariantId,
    ]),
    [
      ["gid://shopify/ProductVariant/502", "gid://shopify/ProductVariant/102"],
      ["gid://shopify/ProductVariant/501", "gid://shopify/ProductVariant/101"],
    ],
  );
});

test("variant mapping fails closed for missing or ambiguous identities", () => {
  assert.throws(
    () =>
      plan({
        publishedVariants: [
          {
            id: "gid://shopify/ProductVariant/999",
            price: "1.00",
            selectedOptions: [
              { name: "Color", value: "Green" },
              { name: "Size", value: "XL" },
            ],
          },
        ],
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "CREATOR_VARIANT_MAPPING_REQUIRED",
  );

  assert.throws(
    () => plan({ baseVariants: [...baseVariants, { ...baseVariants[0], id: "gid://shopify/ProductVariant/104" }] }),
    (error) =>
      error instanceof DomainError &&
      error.code === "CREATOR_VARIANT_MAPPING_AMBIGUOUS",
  );
});

test("republishing recalculates from base prices and never compounds", () => {
  const first = plan();
  const republished = plan({
    publishedVariants: publishedVariants.map((variant, index) => ({
      ...variant,
      price: first.variants[index].finalPrice,
    })),
  });
  assert.deepEqual(
    republished.variants.map((variant) => variant.finalPrice),
    first.variants.map((variant) => variant.finalPrice),
  );
});

test("save preview uses authoritative pricing and accepts an enabled zero surcharge", () => {
  const preview = creatorProductionPricingPreview({
    productionMethod: "EMBROIDERY",
    embroiderySubtype: "TEXT_ONLY",
    placementCount: 2,
    pricing,
    baseVariants: baseVariants.slice(0, 2),
  });
  assert.equal(preview.productionCostMinor, "20000");
  assert.deepEqual(
    preview.variants.map((variant) => variant.finalPrice),
    ["400.00", "420.00"],
  );

  const zeroCost = creatorProductionPricingPreview({
    productionMethod: "DTF",
    embroiderySubtype: null,
    placementCount: 1,
    pricing: { ...pricing, dtfSurcharge: parseSurchargeInput("0") },
    baseVariants: baseVariants.slice(0, 1),
  });
  assert.equal(zeroCost.productionCostMinor, "0");
  assert.equal(zeroCost.variants[0].finalPrice, baseVariants[0].price);
});

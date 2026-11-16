import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type PublicContractApi = {
  buildCartSelectionContract(input: {
    value?: Record<string, unknown>;
    source?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | null;
    config?: Record<string, unknown>;
  }): {
    selections: Array<Record<string, unknown>>;
    selectionCount: number;
    totalQuantity: number;
  };
  buildVariantMatrix(input: {
    variants: Array<Record<string, unknown>>;
    optionNames: string[];
    colorPosition?: number;
    sizePosition?: number;
    currency: string;
  }): Array<Record<string, unknown>>;
  buildProductionMethodPricing(
    methods: Array<Record<string, unknown>>,
  ): Record<string, Record<string, unknown>>;
  integrationSettings(revision: string): Record<string, unknown>;
  chooseCanonicalConfig(
    current: Record<string, unknown> | null,
    candidate: Record<string, unknown>,
  ): Record<string, unknown>;
  normalizeProductionMethods(pricing: Record<string, unknown>): Array<Record<string, unknown>>;
  revisionFor(value: unknown): string;
};

function loadContract(): PublicContractApi {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(
    readFileSync(
      "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
      "utf8",
    ),
    sandbox,
  );
  return sandbox.CustomHousePublicPitchPrintContract as PublicContractApi;
}

test("partial method config cannot erase the authoritative list; explicit empty can", () => {
  const api = loadContract();
  const complete = { productId: "1", productionMethodsResolved: true, productionMethods: [{ code: "STICKER_PRINTING" }], variants: [], revision: "full" };
  const partial = { productId: "1", productionMethodPricing: {}, variants: [], revision: "partial" };
  assert.equal(api.chooseCanonicalConfig(complete, partial), complete);
  const empty = { ...complete, productionMethods: [], revision: "empty" };
  assert.deepEqual(api.chooseCanonicalConfig(complete, empty).productionMethods, []);
});

const variants = [
  {
    id: 101,
    title: "Green / S",
    available: true,
    price: 20000,
    options: ["Green", "S"],
  },
  {
    id: 102,
    title: "Green / M",
    available: false,
    price: 21000,
    options: ["Green", "M"],
  },
  {
    id: 103,
    title: "Black / S",
    available: true,
    price: 22000,
    options: ["Black", "S"],
  },
];

test("public config variant matrix preserves every Shopify variant and semantic option", () => {
  const api = loadContract();
  const matrix = api.buildVariantMatrix({
    variants,
    optionNames: ["Colour", "Size"],
    colorPosition: 1,
    sizePosition: 2,
    currency: "SEK",
  });

  assert.equal(matrix.length, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(matrix)),
    [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        id: "101",
        gid: "gid://shopify/ProductVariant/101",
        title: "Green / S",
        options: { Color: "Green", Size: "S" },
        optionValues: { Colour: "Green", Size: "S" },
        color: "Green",
        size: "S",
        available: true,
        priceMinor: 20000,
        currency: "SEK",
      },
      {
        variantId: "102",
        variantGid: "gid://shopify/ProductVariant/102",
        id: "102",
        gid: "gid://shopify/ProductVariant/102",
        title: "Green / M",
        options: { Color: "Green", Size: "M" },
        optionValues: { Colour: "Green", Size: "M" },
        color: "Green",
        size: "M",
        available: false,
        priceMinor: 21000,
        currency: "SEK",
      },
      {
        variantId: "103",
        variantGid: "gid://shopify/ProductVariant/103",
        id: "103",
        gid: "gid://shopify/ProductVariant/103",
        title: "Black / S",
        options: { Color: "Black", Size: "S" },
        optionValues: { Colour: "Black", Size: "S" },
        color: "Black",
        size: "S",
        available: true,
        priceMinor: 22000,
        currency: "SEK",
      },
    ],
  );
});

test("public cart selections do not double count mirrored source payloads", () => {
  const api = loadContract();
  const config = {
    variants: api.buildVariantMatrix({
      variants,
      optionNames: ["Colour", "Size"],
      colorPosition: 1,
      sizePosition: 2,
      currency: "SEK",
    }),
  };

  const contract = api.buildCartSelectionContract({
    config,
    value: {
      variantSelections: [{ variantId: "102", color: "Green", size: "M", quantity: 1 }],
      source: {
        variantSelections: [{ variantId: "102", color: "Green", size: "M", quantity: 1 }],
      },
    },
    source: {
      variantSelections: [{ variantId: "102", color: "Green", size: "M", quantity: 1 }],
    },
  });

  assert.equal(contract.selectionCount, 1);
  assert.equal(contract.totalQuantity, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.selections.map(({ variantId, color, size, quantity }) => ({
      variantId,
      color,
      size,
      quantity,
    })))),
    [{ variantId: "102", color: "Green", size: "M", quantity: 1 }],
  );
});

test("URL selection and preview color cannot filter the complete public matrix", () => {
  const api = loadContract();
  const matrix = api.buildVariantMatrix({
    variants,
    optionNames: ["Color", "Size"],
    colorPosition: 1,
    sizePosition: 2,
    currency: "SEK",
  });

  assert.deepEqual(matrix.map((variant) => variant.variantId), ["101", "102", "103"]);
  assert.deepEqual(
    Array.from(new Set(matrix.map((variant) => variant.color))),
    ["Green", "Black"],
  );
  assert.deepEqual(
    Array.from(new Set(matrix.map((variant) => variant.size))),
    ["S", "M"],
  );
});

test("public integration settings are explicit and versioned", () => {
  const api = loadContract();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.integrationSettings("PUBLIC_CUSTOMIZE_V2-test"))),
    {
      mode: "PUBLIC_CUSTOMIZE",
      contractVersion: "PUBLIC_CUSTOMIZE_V2",
      configRevision: "PUBLIC_CUSTOMIZE_V2-test",
      variantSelectionMode: "COLOR_SIZE_MATRIX",
      supportsMultipleVariantSelections: true,
      configRequestMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST",
      configResponseMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA",
      configAcknowledgementMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_ACK",
      cartReadyMessageType: "CUSTOMHOUSE_PP_CART_READY",
      cartAcknowledgementMessageType: "CUSTOMHOUSE_PP_CART_READY_ACK",
    },
  );
});

test("public pricing map preserves canonical uppercase method codes and embroidery subtype prices", () => {
  const api = loadContract();
  const pricing = api.buildProductionMethodPricing([
    {
      id: "embroidery",
      label: "Embroidery",
      surchargeMinor: 0,
      embroiderySubtypes: {
        TEXT_ONLY: { label: "Embroidery — Text only", surchargeMinor: 1000 },
        IMAGE_OR_LOGO: { label: "Embroidery — Image / Logo", surchargeMinor: 30000 },
      },
    },
    { id: "dtf", label: "DTF printing", surchargeMinor: 2000 },
    { id: "dtg", label: "DTG printing", surchargeMinor: 3000 },
    { id: "sublimation", label: "Sublimation", surchargeMinor: 0 },
    { id: "sticker_printing", label: "Sticker Printing", surchargeMinor: 1500 },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(pricing)), {
    EMBROIDERY: {
      label: "Embroidery",
      surchargeMinor: 0,
      embroiderySubtypes: {
        TEXT_ONLY: { label: "Embroidery — Text only", surchargeMinor: 1000 },
        IMAGE_OR_LOGO: { label: "Embroidery — Image / Logo", surchargeMinor: 30000 },
      },
    },
    DTF: { label: "DTF printing", surchargeMinor: 2000 },
    DTG: { label: "DTG printing", surchargeMinor: 3000 },
    SUBLIMATION: { label: "Sublimation", surchargeMinor: 0 },
    STICKER_PRINTING: { label: "Sticker Printing", surchargeMinor: 1500 },
  });
  assert.equal(pricing.embroidery, undefined);
  assert.equal(pricing.dtf, undefined);
  assert.equal(pricing.dtg, undefined);
});

test("repeated public config delivery is idempotent and partial config cannot overwrite complete config", () => {
  const api = loadContract();
  const complete = {
    productId: "gid://shopify/Product/1",
    revision: api.revisionFor({ productId: "1", variants }),
    variants: [{ variantId: "101" }, { variantId: "102" }, { variantId: "103" }],
    integrationSettings: { mode: "PUBLIC_CUSTOMIZE" },
  };
  const same = { ...complete, variants: [...complete.variants] };
  const partial = {
    ...complete,
    revision: api.revisionFor({ productId: "1", variants: [variants[0]] }),
    variants: [{ variantId: "101" }],
  };

  assert.equal(api.chooseCanonicalConfig(complete, same), complete);
  assert.equal(api.chooseCanonicalConfig(complete, partial), complete);
});

test("later config with the same variants cannot erase complete subtype pricing", () => {
  const api = loadContract();
  const complete = {
    productId: "gid://shopify/Product/1",
    revision: "complete-pricing",
    variants: [{ variantId: "101" }, { variantId: "102" }],
    embroideryPricing: {
      TEXT_ONLY: { surchargeMinor: 1000 },
      IMAGE_OR_LOGO: { surchargeMinor: 30000 },
    },
    productionMethodPricing: {
      DTF: { surchargeMinor: 2000 },
      DTG: { surchargeMinor: 3000 },
    },
  };
  const missingPrices = {
    ...complete,
    revision: "missing-pricing",
    embroideryPricing: {
      TEXT_ONLY: {},
      IMAGE_OR_LOGO: {},
    },
    productionMethodPricing: {
      DTF: {},
      DTG: {},
    },
  };

  assert.equal(api.chooseCanonicalConfig(complete, missingPrices), complete);
});

test("public handoff carries subtype prices, integration settings, acknowledgements, and rich selections", () => {
  const source = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );
  const contract = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
    "utf8",
  );
  const productDetails = readFileSync(
    "theme-live-cart/blocks/_product-details.liquid",
    "utf8",
  );

  assert.match(productDetails, /data-product-option-names/);
  assert.match(source, /integrationSettings/);
  assert.match(source, /CUSTOMHOUSE_PP_ORDER_CONFIG_ACK/);
  assert.match(source, /PUBLIC_CONFIG_REVISION/);
  assert.match(source, /PUBLIC_CONFIG_VARIANT_COUNT/);
  assert.match(source, /PUBLIC_CONFIG_PRODUCT_ID/);
  assert.match(source, /PUBLIC_CONFIG_COLORS/);
  assert.match(source, /PUBLIC_CONFIG_SIZES/);
  assert.match(source, /PUBLIC_CONFIG_CURRENCY/);
  assert.match(source, /PUBLIC_CONFIG_EMBROIDERY_TEXT_PRICE/);
  assert.match(source, /PUBLIC_CONFIG_EMBROIDERY_IMAGE_PRICE/);
  assert.match(source, /PUBLIC_CONFIG_DTF_PRICE/);
  assert.match(source, /PUBLIC_CONFIG_DTG_PRICE/);
  assert.match(source, /PUBLIC_CONFIG_HAS_VARIANT_PRICES/);
  assert.match(source, /PUBLIC_CONFIG_SENT/);
  assert.match(source, /PUBLIC_CONFIG_SENT_VARIANTS/);
  assert.match(source, /PUBLIC_CONFIG_SENT_TEXT_PRICE/);
  assert.match(source, /PUBLIC_CONFIG_ACKNOWLEDGED/);
  assert.match(source, /PUBLIC_CONFIG_ACK_VARIANTS/);
  assert.match(source, /PUBLIC_CONFIG_ACK_TEXT_PRICE/);
  assert.match(source, /TEXT_ONLY/);
  assert.match(source, /IMAGE_OR_LOGO/);
  assert.match(source, /variantSelections/);
  assert.match(source, /buildCartSelectionContract/);
  assert.match(contract, /variantGid/);
  assert.match(contract, /color/);
  assert.match(contract, /size/);
  assert.doesNotMatch(source, /productionMethods\.some/);
  assert.doesNotMatch(source, /CustomHouseCreatorPitchPrintConfig/);
});

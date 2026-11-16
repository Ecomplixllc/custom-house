import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProductionPricingBatchForm,
  productionPricingMatrixColumns,
  productionPricingMatrixRows,
} from "../app/services/production-pricing-admin.ts";
import type {
  ProductProductionConfiguration,
  ProductionMethodDefinition,
} from "../app/services/production-method-pricing.server.ts";
import { DomainError } from "../app/services/domain.ts";

const definitions: ProductionMethodDefinition[] = [
  {
    id: "EMBROIDERY",
    label: "Embroidery",
    description: "",
    enabled: true,
    pricingBehavior: "TIERED",
    tiers: ["TEXT_ONLY", "IMAGE_OR_LOGO"],
  },
  ...([
    ["DTF", "DTF"],
    ["DTG", "DTG"],
    ["SUBLIMATION", "Sublimation"],
    ["STICKER_PRINTING", "Sticker Printing"],
    ["SCREEN_PRINTING", "Screen Printing"],
  ] as const).map(
    ([id, label]) => ({
      id,
      label,
      description: "",
      enabled: true,
      pricingBehavior: "SINGLE" as const,
      tiers: [],
    }),
  ),
];

test("matrix columns expose registry methods and separate embroidery tiers", () => {
  assert.deepEqual(
    productionPricingMatrixColumns(definitions).map((column) => ({
      key: column.key,
      group: column.groupLabel,
      label: column.label,
    })),
    [
      { key: "EMBROIDERY.TEXT_ONLY", group: "Embroidery", label: "Text" },
      { key: "EMBROIDERY.IMAGE_OR_LOGO", group: "Embroidery", label: "Image / Logo" },
      { key: "DTF", group: "DTF", label: "Enabled" },
      { key: "DTG", group: "DTG", label: "Enabled" },
      { key: "SUBLIMATION", group: "Sublimation", label: "Enabled" },
      { key: "STICKER_PRINTING", group: "Sticker Printing", label: "Enabled" },
      { key: "SCREEN_PRINTING", group: "Screen Printing", label: "Enabled" },
    ],
  );
});

test("matrix rows use saved values and custom methods start disabled", () => {
  const tShirt: ProductProductionConfiguration = {
    version: 2,
    methods: {
      EMBROIDERY: {
        enabled: true,
        tiers: {
          TEXT_ONLY: { enabled: true, surcharge: "50.00", feeVariantId: null },
          IMAGE_OR_LOGO: { enabled: true, surcharge: "300.00", feeVariantId: null },
        },
      },
      DTF: { enabled: true, surcharge: "20.00", feeVariantId: null },
      DTG: { enabled: true, surcharge: "30.00", feeVariantId: null },
      SUBLIMATION: { enabled: false, surcharge: "45.00", feeVariantId: null },
    },
  };
  const rows = productionPricingMatrixRows(
    [{ id: "product-1", title: "T-shirt", currency: "SEK" }],
    { "product-1": tShirt },
    productionPricingMatrixColumns(definitions),
  );

  assert.deepEqual(
    rows[0].cells.map((cell) => [cell.key, cell.enabled, cell.surcharge]),
    [
      ["EMBROIDERY.TEXT_ONLY", true, "50.00"],
      ["EMBROIDERY.IMAGE_OR_LOGO", true, "300.00"],
      ["DTF", true, "20.00"],
      ["DTG", true, "30.00"],
      ["SUBLIMATION", false, "45.00"],
      ["STICKER_PRINTING", false, "0.00"],
      ["SCREEN_PRINTING", false, "0.00"],
    ],
  );
});

test("batch form keeps a disabled method price and isolates products", () => {
  const form = new FormData();
  form.set("productCount", "2");
  form.set("products.0.id", "gid://shopify/Product/100");
  form.set("products.0.currency", "SEK");
  form.set("products.0.method.DTF.surcharge", "20.00");
  form.set("products.0.method.DTG.enabled", "on");
  form.set("products.0.method.DTG.surcharge", "30.00");
  form.set("products.1.id", "gid://shopify/Product/101");
  form.set("products.1.currency", "SEK");
  form.set("products.1.method.DTF.enabled", "on");
  form.set("products.1.method.DTF.surcharge", "5.00");
  form.set("products.1.method.DTG.surcharge", "7.00");

  const inputs = parseProductionPricingBatchForm(form, definitions);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0].methods.DTF, { enabled: false, surcharge: "20.00" });
  assert.deepEqual(inputs[0].methods.DTG, { enabled: true, surcharge: "30.00" });
  assert.deepEqual(inputs[1].methods.DTF, { enabled: true, surcharge: "5.00" });
  assert.deepEqual(inputs[1].methods.DTG, { enabled: false, surcharge: "7.00" });
});

test("batch form omits globally inactive methods instead of overwriting hidden values", () => {
  const form = new FormData();
  form.set("productCount", "1");
  form.set("products.0.id", "gid://shopify/Product/100");
  form.set("products.0.currency", "SEK");
  form.set("products.0.method.DTF.enabled", "on");
  form.set("products.0.method.DTF.surcharge", "20.00");
  const inactiveDefinitions = definitions.map((definition) =>
    definition.id === "SCREEN_PRINTING"
      ? { ...definition, enabled: false }
      : definition,
  );

  const [input] = parseProductionPricingBatchForm(form, inactiveDefinitions);

  assert.equal(Object.hasOwn(input.methods, "SCREEN_PRINTING"), false);
  assert.deepEqual(input.methods.DTF, { enabled: true, surcharge: "20.00" });
});

test("batch form validates every product price before returning any writes", () => {
  const form = new FormData();
  form.set("productCount", "2");
  for (const index of [0, 1]) {
    form.set(`products.${index}.id`, `gid://shopify/Product/${100 + index}`);
    form.set(`products.${index}.currency`, "SEK");
    form.set(`products.${index}.method.DTF.enabled`, "on");
    form.set(`products.${index}.method.DTF.surcharge`, index === 0 ? "20.00" : "-1");
  }

  assert.throws(
    () => parseProductionPricingBatchForm(form, definitions),
    (error) =>
      error instanceof DomainError && error.code === "INVALID_SURCHARGE",
  );
});

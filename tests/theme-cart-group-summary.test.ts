import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type CartSummaryApi = {
  groupCartItems(cart: unknown): unknown;
  groupRemovalUpdates(cart: unknown, feeKey: string): unknown;
};

function loadCartSummaryApi(): CartSummaryApi {
  const assetPath = "theme-live-cart/assets/customhouse-cart-group-summary.js";
  assert.ok(
    existsSync(assetPath),
    "the grouped cart summary runtime must exist",
  );

  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync(assetPath, "utf8"), sandbox);
  return sandbox.CustomHouseCartSummary as CartSummaryApi;
}

const sharedProperties = {
  _customhouse_public_customize: "true",
  _customhouse_fee_key: "public-design-1",
  _production_method: "EMBROIDERY",
  _embroidery_subtype: "IMAGE_OR_LOGO",
  _designed_placement_count: "1",
  "Printing method": "Embroidery",
};

const baseLine = (
  key: string,
  color: string,
  size: string,
  quantity: number,
  finalLinePrice: number,
) => ({
  key,
  quantity,
  final_line_price: finalLinePrice,
  product_title: "Custom hoodie",
  properties: sharedProperties,
  options_with_values: [
    { name: "Color", value: color },
    { name: "Size", value: size },
  ],
});

test("public customization cart groups color and size quantities with one authoritative total", () => {
  const api = loadCartSummaryApi();

  const result = api.groupCartItems({
    items: [
      baseLine("green-m", "Green", "M", 1, 20_000),
      baseLine("black-s", "Black", "S", 1, 20_000),
      baseLine("white-m", "White", "M", 2, 40_000),
      baseLine("white-l", "White", "L", 1, 20_000),
      {
        key: "fee",
        quantity: 5,
        final_line_price: 150_000,
        properties: {
          _customhouse_production_fee: "true",
          _customhouse_fee_key: "public-design-1",
        },
      },
      {
        key: "ordinary-product",
        quantity: 1,
        final_line_price: 10_000,
        properties: {},
      },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    {
      feeKey: "public-design-1",
      leadLineKey: "green-m",
      lineKeys: ["green-m", "black-s", "white-m", "white-l", "fee"],
      productionMethod: "Embroidery",
      artworkType: "Image / Logo",
      printingChargeMinor: 30_000,
      placementCount: 1,
      totalQuantity: 5,
      totalMinor: 250_000,
      sizes: ["S", "M", "L", "XL"],
      colors: [
        { color: "Green", quantities: { S: 0, M: 1, L: 0, XL: 0 } },
        { color: "Black", quantities: { S: 1, M: 0, L: 0, XL: 0 } },
        { color: "White", quantities: { S: 0, M: 2, L: 1, XL: 0 } },
      ],
    },
  ]);
});

test("removing a grouped customization clears every base and fee line", () => {
  const api = loadCartSummaryApi();
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        api.groupRemovalUpdates(
          {
            items: [
              baseLine("green-m", "Green", "M", 1, 20_000),
              baseLine("white-m", "White", "M", 2, 40_000),
              {
                key: "fee",
                quantity: 3,
                properties: {
                  _customhouse_production_fee: "true",
                  _customhouse_fee_key: "public-design-1",
                },
              },
              { key: "ordinary-product", quantity: 1, properties: {} },
            ],
          },
          "public-design-1",
        ),
      ),
    ),
    { "green-m": 0, "white-m": 0, fee: 0 },
  );
});

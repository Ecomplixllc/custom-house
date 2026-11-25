import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("product page uses the approved Swedish action labels", () => {
  const productTemplate = readFileSync("theme-live-cart/templates/product.json", "utf8");
  const productSection = readFileSync(
    "theme-live-cart/sections/product-information.liquid",
    "utf8",
  );
  const productDetails = readFileSync(
    "theme-live-cart/blocks/_product-details.liquid",
    "utf8",
  );

  assert.match(productTemplate, /"customize_button_label": "Designa nu"/);
  assert.match(
    productSection,
    /"id": "customize_button_label",[\s\S]*?"default": "Designa nu"/,
  );
  assert.match(
    productDetails,
    /\{%- if selected_variant\.available or force_allow_purchase -%\}[\s\S]*?Lägg i varukorg/,
  );
  assert.match(
    productDetails,
    /addButtonLabel\.textContent = canAttemptPurchase \? 'Lägg i varukorg' : 'Slutsåld';/,
  );
});

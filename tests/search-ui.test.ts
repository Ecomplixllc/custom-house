import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("search modal and results page share the scoped CustomHouse visual system", () => {
  const header = readFileSync("theme-live-cart/sections/search-header.liquid", "utf8");
  const modal = readFileSync("theme-live-cart/snippets/search-modal.liquid", "utf8");
  const styles = readFileSync("theme-live-cart/assets/customhouse-search.css", "utf8");

  assert.match(header, /customhouse-search\.css/);
  assert.match(modal, /customhouse-search\.css/);
  assert.match(styles, /\.search-page__header/);
  assert.match(styles, /\.search-modal__content/);
  assert.match(styles, /\.predictive-search-results__card/);
  assert.match(styles, /\.product-grid__item/);
  assert.match(styles, /#baff00/i);
  assert.match(styles, /#842bff/i);
  assert.match(styles, /@media screen and \(max-width: 749px\)/);
  assert.doesNotMatch(styles, /display:\s*none\s*!important/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicStorefrontNavigationHtml } from "../app/services/storefront-proxy.server.ts";
import { PUBLIC_STOREFRONT_NAV_ITEMS } from "../app/services/storefront-navigation.ts";

const EXPECTED_NAVIGATION = [
  ["T-SHIRTS", "/collections/t-shirts"],
  ["HOODIES", "/collections/hoodies"],
  ["DESIGN SELV", "/pages/design-selv"],
  ["INSPIRATION", "/blogs/news"],
  ["DESIGN YOUR OWN", "/pages/collections"],
  ["CREATOR CONTENT", "/apps/customhouse/creator-content"],
] as const;

test("public storefront navigation has the authoritative labels, links, and order", () => {
  assert.deepEqual(
    PUBLIC_STOREFRONT_NAV_ITEMS.map((item) => [item.label, item.href]),
    EXPECTED_NAVIGATION,
  );
});

test("desktop and mobile app headers render the same complete primary navigation", () => {
  const desktop = publicStorefrontNavigationHtml("desktop", "creator-content");
  const mobile = publicStorefrontNavigationHtml("mobile", "creator-content");

  for (const [label, href] of EXPECTED_NAVIGATION) {
    assert.equal(desktop.split(label).length - 1, 1);
    assert.equal(mobile.split(label).length - 1, 1);
    assert.match(desktop, new RegExp(`href="${href}"`));
    assert.match(mobile, new RegExp(`href="${href}"`));
  }

  assert.match(
    desktop,
    /href="\/apps\/customhouse\/creator-content" aria-current="page"/,
  );
  assert.match(
    mobile,
    /href="\/apps\/customhouse\/creator-content" aria-current="page"/,
  );
  assert.equal(
    desktop.indexOf("T-SHIRTS") < desktop.indexOf("DESIGN YOUR OWN"),
    true,
  );
  assert.equal(
    mobile.indexOf("DESIGN YOUR OWN") < mobile.indexOf("CREATOR CONTENT"),
    true,
  );
});

test("theme desktop and mobile renderers share one primary navigation source", () => {
  const header = readFileSync("theme-live-cart/sections/header.liquid", "utf8");
  const navigation = readFileSync(
    "theme-live-cart/snippets/customhouse-primary-navigation.liquid",
    "utf8",
  );

  assert.match(
    header,
    /render 'customhouse-primary-navigation', variant: 'desktop', request_path: request\.path/,
  );
  assert.match(
    header,
    /render 'customhouse-primary-navigation', variant: 'mobile', request_path: request\.path/,
  );
  assert.match(
    navigation,
    /T-SHIRTS\|HOODIES\|DESIGN SELV\|INSPIRATION\|DESIGN YOUR OWN\|CREATOR CONTENT/,
  );
  assert.match(
    navigation,
    /\/pages\/collections\|\/apps\/customhouse\/creator-content/,
  );
});

test("all app-powered creator pages keep Creator Content active", () => {
  const source = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );
  assert.equal(
    source.match(/siteHeader\(input\.headerAccount, "creator-content"\)/g)
      ?.length,
    3,
  );
});

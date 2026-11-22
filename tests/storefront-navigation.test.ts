import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("published theme owns storefront header navigation and footer", () => {
  const layout = readFileSync("theme-live-cart/layout/theme.liquid", "utf8");
  const header = readFileSync("theme-live-cart/sections/header.liquid", "utf8");
  const footer = readFileSync("theme-live-cart/sections/footer.liquid", "utf8");
  const navigation = readFileSync(
    "theme-live-cart/snippets/customhouse-primary-navigation.liquid",
    "utf8",
  );

  assert.match(layout, /{% sections 'header-group' %}/);
  assert.match(layout, /{{ content_for_layout }}/);
  assert.match(layout, /{% sections 'footer-group' %}/);
  assert.match(header, /"id": "customhouse_primary_menu"/);
  assert.match(header, /"default": "main-menu"/);
  assert.match(navigation, /for link in navigation_links/);
  assert.match(navigation, /link\.title/);
  assert.match(navigation, /link\.url/);
  assert.match(footer, /section\.blocks/);
});

test("app proxy storefront pages request the real Shopify theme layout", () => {
  const proxy = readFileSync("app/services/storefront-proxy.server.ts", "utf8");
  const authentication = readFileSync(
    "app/services/storefront-proxy-auth.server.ts",
    "utf8",
  );

  assert.match(authentication, /liquid: context\.liquid/);
  assert.match(proxy, /return context\.liquid\(content, \{/);
  assert.match(proxy, /layout: true/);
  assert.match(proxy, /case "creatorTerms"[\s\S]*storefrontThemeResponse/);
  assert.match(proxy, /case "creatorContent"[\s\S]*storefrontThemeResponse/);
  assert.match(proxy, /case "creator"[\s\S]*storefrontThemeResponse/);
  assert.match(proxy, /case "creatorProduct"[\s\S]*storefrontThemeResponse/);
  assert.doesNotMatch(proxy, /headerAccount: await siteHeaderAccount/);
  assert.doesNotMatch(proxy, /\$\{siteHeader\(input\./);
  assert.doesNotMatch(proxy, /\$\{siteFooter\(\)\}/);
});

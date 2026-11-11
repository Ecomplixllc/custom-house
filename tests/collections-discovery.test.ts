import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listPublicCreatorDirectory } from "../app/services/creator-discovery.server.ts";

const unchangedCollectionFiles = new Map([
  ["theme-live-cart/templates/collection.json", "470bad3e5fd7af821bc143e46a378fd9164affb655d015b8ccd75f2f4c396fb7"],
  ["theme-live-cart/templates/collection.custom-house-colelction.json", "ecfd2f3f54f211fb547ac3795955f83eae275d8f43eba92bfdb35dafcffc03e4"],
  ["theme-live-cart/sections/main-collection.liquid", "9e9182f3b4cd4eb9774db5fd833cd68e6f353f0c91d7b3799250156bd597d02f"],
  ["theme-live-cart/sections/customhouse-collection-grid.liquid", "8bd6bacdd03252323b3b44db18a82283ab9dbaf3335f0af8b1d5307e7160ffe2"],
  ["theme-live-cart/assets/customhouse-collection-grid.css", "25711f445e3218b33ec04b8e4e26841c610be8eee48d5bfe238525050d617d02"],
  ["theme-live-cart/assets/customhouse-collection-grid.js", "61919b7d7021431803cb8464668d71a782f424702bd5bcaae973ddab246c4f7e"],
]);

test("existing Shopify collection implementations remain byte-for-byte unchanged", () => {
  for (const [file, expected] of unchangedCollectionFiles) {
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(actual, expected, file);
  }
});

test("new Collections discovery page uses a dedicated page template and isolated assets", () => {
  const template = readFileSync("theme-live-cart/templates/page.collections.json", "utf8");
  const section = readFileSync("theme-live-cart/sections/customhouse-collections-discovery.liquid", "utf8");
  const css = readFileSync("theme-live-cart/assets/customhouse-collections-discovery.css", "utf8");
  const script = readFileSync("theme-live-cart/assets/customhouse-collections-discovery.js", "utf8");

  assert.match(template, /"type": "customhouse-collections-discovery"/);
  assert.match(section, /class="customhouse-collections-discovery"/);
  assert.match(section, /product\.metafields\.customhouse\.product_type/);
  assert.match(section, /product\.metafields\.customhouse\.product_origin/);
  assert.match(section, /product\.metafields\.customhouse\.pitchprint_enabled/);
  assert.match(section, /open_customizer=1/);
  assert.match(section, /\/apps\/customhouse\/creators\?format=json/);
  assert.match(script, /data-chd-filter/);
  assert.match(script, /data-chd-active-filters/);
  assert.match(script, /URLSearchParams/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.doesNotMatch(section, /rating|reviews?|followers?/i);
  assert.doesNotMatch(css, /^\s*\.(?:collection|product-grid|card)(?:\s|\{|\*)/m);
  assert.match(css, /\.customhouse-collections-discovery/);
  assert.match(css, /@media \(max-width: 1279px\)/);
  assert.match(css, /@media \(max-width: 767px\)/);
});

test("global header adds one duplicate-safe Collections discovery link without replacing menu links", () => {
  const desktop = readFileSync("theme-live-cart/blocks/_header-menu.liquid", "utf8");
  const drawer = readFileSync("theme-live-cart/snippets/header-drawer.liquid", "utf8");
  const fallback = readFileSync("theme-live-cart/snippets/customhouse-collections-menu-fallback.liquid", "utf8");
  assert.match(fallback, /where: 'url', '\/pages\/collections'/);
  assert.match(fallback, /href="\/pages\/collections"/);
  assert.match(fallback, /COLLECTIONS/);
  assert.match(desktop, /render 'customhouse-collections-menu-fallback'/);
  assert.match(drawer, /render 'customhouse-collections-menu-fallback'/);
  assert.match(desktop, /for link in block_settings\.menu\.links/);
  assert.match(drawer, /for link in linklist\.links/);
});

test("public creator directory exposes only approved active creators and published products", async () => {
  let query: Record<string, unknown> | undefined;
  const database = {
    creatorCollection: {
      async findMany(args: Record<string, unknown>) {
        query = args;
        return [{
          publicHandle: "maya-studio-abc12",
          displayName: "Maya Studio Designs",
          bannerImageUrl: "https://cdn.example/banner.jpg",
          updatedAt: new Date("2026-11-01T00:00:00Z"),
          creator: {
            displayName: "Maya Studio",
            handle: "maya-studio",
            profileImageUrl: "https://cdn.example/avatar.jpg",
            categoriesJson: '["Streetwear","Art & Design","Streetwear",7]',
            creatorProducts: [{
              id: "product-1",
              title: "Night Lines",
              description: "Published design",
              previewUrl: "https://cdn.example/design.jpg",
              previewUrls: "[]",
              publishedAt: new Date("2026-10-30T00:00:00Z"),
            }],
          },
        }];
      },
    },
  };

  const result = await listPublicCreatorDirectory("example.myshopify.com", database);
  assert.deepEqual((query?.where as Record<string, unknown>), {
    shop: "example.myshopify.com",
    status: "ACTIVE",
    creator: { status: "APPROVED" },
  });
  assert.deepEqual(result.categories, ["Art & Design", "Streetwear"]);
  assert.equal(result.creators[0]?.collectionUrl, "/apps/customhouse/creators/maya-studio-abc12");
  assert.equal(result.creators[0]?.products[0]?.viewUrl, "/apps/customhouse/creators/maya-studio-abc12/products/product-1");
  assert.equal("customerId" in result.creators[0]!, false);
});

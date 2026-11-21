import assert from "node:assert/strict";
import test from "node:test";
import { creatorProductSeo } from "../app/services/creator-product-seo.ts";

test("creator product SEO is unique, branded, and based on creator content", () => {
  assert.deepEqual(
    creatorProductSeo({
      title: "Midnight Mountain",
      description: "A hand-drawn mountain graphic for everyday wear.",
      creatorName: "Maya Studio",
      baseProductTitle: "Organic T-shirt",
    }),
    {
      title: "Midnight Mountain by Maya Studio | Custom House",
      description:
        "A hand-drawn mountain graphic for everyday wear. Designed by Maya Studio for Custom House.",
    },
  );
});

test("creator product SEO supplies a useful fallback and respects search limits", () => {
  const seo = creatorProductSeo({
    title: "A very long creator product title ".repeat(5),
    description: "",
    creatorName: "An exceptionally long creator studio name",
    baseProductTitle: "Premium heavyweight organic cotton sweatshirt",
  });

  assert.ok(seo.title.length <= 70);
  assert.ok(seo.description.length <= 160);
  assert.match(seo.title, /Custom House$/);
  assert.match(seo.description, /custom/i);
  assert.doesNotMatch(seo.description, /<[^>]+>/);
});

test("creator product SEO removes markup and normalizes whitespace", () => {
  const seo = creatorProductSeo({
    title: "  Graphic   Hoodie  ",
    description: "<p>Soft &amp; warm</p>\nfor winter.",
    creatorName: "  North   Studio  ",
    baseProductTitle: "Hoodie",
  });

  assert.equal(seo.title, "Graphic Hoodie by North Studio | Custom House");
  assert.equal(
    seo.description,
    "Soft & warm for winter. Designed by North Studio for Custom House.",
  );
});

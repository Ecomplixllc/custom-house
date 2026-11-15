import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATOR_CONTENT_MAX_TAG_LENGTH,
  CREATOR_CONTENT_MAX_TAGS,
  normalizeCreatorContentTags,
} from "../app/services/creator-content-metadata.ts";
import {
  moderateCreatorContentAsAdmin,
  saveCreatorContentMetadataForCustomer,
} from "../app/services/creator-products.server.ts";

function creatorProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "creatorproducta123456",
    shop: "shop.myshopify.com",
    creatorId: "creator-a",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyProductHandle: "base-product",
    baseProductTitle: "T-shirt",
    pitchprintProjectId: "project-a",
    pitchprintDesignId: "design-a",
    title: "Creator product",
    description: null,
    previewUrl: "https://cdn.example.com/product.png",
    previewUrls: "[]",
    baseProductVariantsJson: "[]",
    designVariantSelectionsJson: "{}",
    status: "DRAFT",
    submittedAt: null,
    publishedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    creatorContentOptIn: true,
    creatorContentTags: [],
    creatorContentHiddenByAdmin: false,
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    updatedAt: new Date("2026-11-15T00:00:00.000Z"),
    ...overrides,
  };
}

function metadataDb(product = creatorProduct()) {
  let current = product;
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    creator: {
      async findUnique() {
        return {
          id: "creator-a",
          handle: "creator-a",
          status: "APPROVED",
          marketplaceCollection: null,
        };
      },
    },
    creatorProduct: {
      async findFirst(args: Record<string, unknown>) {
        const where = args.where as { id?: string; shop?: string; creatorId?: string };
        if (where.id !== current.id || where.shop !== current.shop) return null;
        if (where.creatorId && where.creatorId !== current.creatorId) return null;
        return current;
      },
      async update(args: Record<string, unknown>) {
        const data = args.data as Record<string, unknown>;
        updates.push(data);
        current = { ...current, ...data, updatedAt: new Date() };
        return current;
      },
    },
    auditLog: {
      async create(args: Record<string, unknown>) {
        audits.push(args);
        return args;
      },
    },
  };
  return { db, updates, audits, current: () => current };
}

test("Creator Content metadata schema defaults new products on and safely backfills eligible records", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20261115000000_creator_content_product_metadata/migration.sql",
    "utf8",
  );

  assert.match(schema, /creatorContentOptIn\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /creatorContentTags\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(schema, /creatorContentHiddenByAdmin\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /UPDATE "CreatorProduct"/);
  assert.match(migration, /"status" <> 'ARCHIVED'/);
  assert.match(migration, /SET DEFAULT true/);
});

test("Creator Content tags normalize international text and deduplicate case-insensitively", () => {
  assert.equal(CREATOR_CONTENT_MAX_TAGS, 5);
  assert.equal(CREATOR_CONTENT_MAX_TAG_LENGTH, 30);
  assert.deepEqual(
    normalizeCreatorContentTags(["  Streetwear  ", "streetwear", "Mötör   sport", "東京 Art"]),
    ["Streetwear", "Mötör sport", "東京 Art"],
  );
  assert.deepEqual(normalizeCreatorContentTags([]), []);
});

test("Creator Content tags reject blank unsafe overlong and sixth values", () => {
  assert.throws(() => normalizeCreatorContentTags([""]), /blank/i);
  assert.throws(() => normalizeCreatorContentTags(["<script>alert(1)</script>"]), /unsafe/i);
  assert.throws(() => normalizeCreatorContentTags(["x".repeat(31)]), /30 characters/i);
  assert.throws(
    () => normalizeCreatorContentTags(["one", "two", "three", "four", "five", "six"]),
    /5 tags/i,
  );
});

test("Creator metadata draft save enforces ownership and preserves DRAFT status", async () => {
  const state = metadataDb();
  const updated = await saveCreatorContentMetadataForCustomer(
    "shop.myshopify.com",
    "123",
    "creatorproducta123456",
    { creatorContentOptIn: false, creatorContentTags: [" Retro ", "retro"] },
    state.db as never,
  );

  assert.equal(updated.creatorContentOptIn, false);
  assert.deepEqual(updated.creatorContentTags, ["Retro"]);
  assert.equal(updated.status, "DRAFT");
  assert.deepEqual(state.updates[0], {
    creatorContentOptIn: false,
    creatorContentTags: ["Retro"],
  });
  const restored = await saveCreatorContentMetadataForCustomer(
    "shop.myshopify.com",
    "123",
    "creatorproducta123456",
    { creatorContentOptIn: true, creatorContentTags: [] },
    state.db as never,
  );
  assert.equal(restored.creatorContentOptIn, true);
  assert.deepEqual(restored.creatorContentTags, []);

  const otherCreator = metadataDb(creatorProduct({ creatorId: "creator-b" }));
  await assert.rejects(
    () => saveCreatorContentMetadataForCustomer(
      "shop.myshopify.com",
      "123",
      "creatorproducta123456",
      { creatorContentOptIn: true, creatorContentTags: [] },
      otherCreator.db as never,
    ),
    /not found/i,
  );
});

test("Admin Creator Content moderation changes only discovery metadata", async () => {
  const state = metadataDb(creatorProduct({ status: "PUBLISHED" }));
  const updated = await moderateCreatorContentAsAdmin(
    "shop.myshopify.com",
    "admin-a",
    {
      creatorProductId: "creatorproducta123456",
      creatorContentTags: ["Gaming", " gaming "],
      creatorContentHiddenByAdmin: true,
    },
    state.db as never,
  );

  assert.deepEqual(state.updates[0], {
    creatorContentTags: ["Gaming"],
    creatorContentHiddenByAdmin: true,
  });
  assert.equal(updated.status, "PUBLISHED");
  assert.equal(updated.creatorContentHiddenByAdmin, true);
});

test("Creator final review UI persists metadata and submits the latest values", () => {
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const actionCore = readFileSync(
    "app/services/creator-product-action-core.server.ts",
    "utf8",
  );

  assert.match(block, /data-dashboard-creator-content-opt-in/);
  assert.match(block, /data-dashboard-creator-content-tag-input/);
  assert.match(block, /0 \/ 5 tags/);
  assert.match(dashboard, /action: "update-creator-content"/);
  assert.match(dashboard, /creatorContentReviewMetadata\(root\)/);
  assert.match(dashboard, /creatorContentOptIn: saved\.creatorContentOptIn !== false/);
  assert.match(actionCore, /submitCreatorProductForReview\([\s\S]*creatorProductId,[\s\S]*body/);
});

test("Admin review exposes tags and an independent discovery-only hide control", () => {
  const route = readFileSync("app/routes/app.creator-products.tsx", "utf8");
  assert.match(route, /Creator Content:/);
  assert.match(route, /creatorContentTags\.join/);
  assert.match(route, /Hide from Creator Content only/);
  assert.match(route, /UPDATE_CREATOR_CONTENT/);
  assert.match(route, /moderateCreatorContentAsAdmin/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  listFeaturedCreatorAdminState,
  saveFeaturedCreatorOrder,
} from "../app/services/creator-content.server.ts";

type CreatorRow = {
  id: string;
  shop: string;
  displayName: string;
  handle: string;
  status: string;
  categoriesJson: string;
  profileImageUrl: string | null;
  marketplaceCollection: {
    status: string;
    publicHandle: string;
    displayName: string;
  } | null;
  creatorProducts: Array<{ status: string }>;
};

function fakeFeaturedDb() {
  const creators: CreatorRow[] = [
    {
      id: "creator-a",
      shop: "shop.myshopify.com",
      displayName: "Alpha Creator",
      handle: "alpha-internal",
      status: "APPROVED",
      categoriesJson: '["Streetwear","Art & Design"]',
      profileImageUrl: "https://cdn.example.com/alpha.jpg",
      marketplaceCollection: {
        status: "ACTIVE",
        publicHandle: "alpha-a1b2c",
        displayName: "Alpha Designs",
      },
      creatorProducts: [{ status: "PUBLISHED" }],
    },
    {
      id: "creator-b",
      shop: "shop.myshopify.com",
      displayName: "Beta Creator",
      handle: "beta-internal",
      status: "APPROVED",
      categoriesJson: '["Music"]',
      profileImageUrl: null,
      marketplaceCollection: {
        status: "ACTIVE",
        publicHandle: "beta-b1c2d",
        displayName: "Beta Designs",
      },
      creatorProducts: [{ status: "PUBLISHED" }],
    },
    {
      id: "creator-suspended",
      shop: "shop.myshopify.com",
      displayName: "Suspended Creator",
      handle: "suspended",
      status: "SUSPENDED",
      categoriesJson: "[]",
      profileImageUrl: null,
      marketplaceCollection: {
        status: "SUSPENDED",
        publicHandle: "suspended-a1b2c",
        displayName: "Suspended Designs",
      },
      creatorProducts: [{ status: "PUBLISHED" }],
    },
    {
      id: "creator-other-shop",
      shop: "other.myshopify.com",
      displayName: "Other Shop Creator",
      handle: "other",
      status: "APPROVED",
      categoriesJson: "[]",
      profileImageUrl: null,
      marketplaceCollection: {
        status: "ACTIVE",
        publicHandle: "other-a1b2c",
        displayName: "Other Designs",
      },
      creatorProducts: [{ status: "PUBLISHED" }],
    },
  ];
  const featured: Array<{
    id: string;
    shop: string;
    creatorId: string;
    position: number;
  }> = [];

  const eligible = (creator: CreatorRow, shop: string) =>
    creator.shop === shop &&
    creator.status === "APPROVED" &&
    creator.marketplaceCollection?.status === "ACTIVE" &&
    creator.creatorProducts.some((product) => product.status === "PUBLISHED");

  const db = {
    creators,
    featured,
    creator: {
      async findMany(args: Record<string, any>) {
        const shop = String(args.where?.shop || "");
        const ids = args.where?.id?.in as string[] | undefined;
        const query = String(args.where?.OR?.[0]?.displayName?.contains || "").toLowerCase();
        return creators
          .filter((creator) => eligible(creator, shop))
          .filter((creator) => !ids || ids.includes(creator.id))
          .filter((creator) => !query || `${creator.displayName} ${creator.handle}`.toLowerCase().includes(query))
          .map((creator) => ({
            id: creator.id,
            displayName: creator.displayName,
            handle: creator.handle,
            categoriesJson: creator.categoriesJson,
            profileImageUrl: creator.profileImageUrl,
            marketplaceCollection: creator.marketplaceCollection,
            _count: { creatorProducts: creator.creatorProducts.filter((product) => product.status === "PUBLISHED").length },
          }));
      },
    },
    featuredCreator: {
      async findMany(args: Record<string, any>) {
        return featured
          .filter((item) => item.shop === args.where.shop)
          .sort((left, right) => left.position - right.position)
          .map((item) => ({
            ...item,
            creator: creators.find((creator) => creator.id === item.creatorId),
          }));
      },
      async deleteMany(args: Record<string, any>) {
        for (let index = featured.length - 1; index >= 0; index -= 1) {
          if (featured[index]?.shop === args.where.shop) featured.splice(index, 1);
        }
      },
      async createMany(args: Record<string, any>) {
        featured.push(...args.data.map((item: any, index: number) => ({ id: `featured-${index}`, ...item })));
      },
    },
    async $transaction(callback: (transaction: any) => Promise<unknown>) {
      return callback(db);
    },
  };
  return db;
}

test("FeaturedCreator schema stores only shop-scoped ordered curation", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20261112000000_featured_creators/migration.sql",
    "utf8",
  );

  assert.match(schema, /model FeaturedCreator \{/);
  assert.match(schema, /creatorId\s+String/);
  assert.match(schema, /position\s+Int/);
  assert.match(schema, /@@unique\(\[shop, creatorId\]\)/);
  assert.match(migration, /CREATE TABLE "FeaturedCreator"/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test("admin state exposes only approved Creators with active public published work", async () => {
  const db = fakeFeaturedDb();
  const result = await listFeaturedCreatorAdminState(
    "shop.myshopify.com",
    "creator",
    db as any,
  );

  assert.deepEqual(result.candidates.map((creator) => creator.id), ["creator-a", "creator-b"]);
  assert.deepEqual(result.selected, []);
  assert.equal(result.candidates[0]?.publicHandle, "alpha-a1b2c");
});

test("admin save persists exact featured ordering and supports removal", async () => {
  const db = fakeFeaturedDb();

  await saveFeaturedCreatorOrder(
    "shop.myshopify.com",
    ["creator-b", "creator-a"],
    db as any,
  );
  assert.deepEqual(
    db.featured.map((item) => [item.creatorId, item.position]),
    [["creator-b", 0], ["creator-a", 1]],
  );

  await saveFeaturedCreatorOrder(
    "shop.myshopify.com",
    ["creator-a"],
    db as any,
  );
  assert.deepEqual(
    db.featured.map((item) => [item.creatorId, item.position]),
    [["creator-a", 0]],
  );
});

test("admin save rejects duplicates, suspended Creators, and cross-shop IDs before writing", async () => {
  const db = fakeFeaturedDb();
  await saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a"], db as any);

  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a", "creator-a"], db as any),
    /only once/i,
  );
  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-suspended"], db as any),
    /approved Creator/i,
  );
  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-other-shop"], db as any),
    /approved Creator/i,
  );
  assert.deepEqual(db.featured.map((item) => item.creatorId), ["creator-a"]);
});

test("stale featured records are suppressed when a Creator becomes suspended", async () => {
  const db = fakeFeaturedDb();
  await saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a"], db as any);
  db.creators[0]!.status = "SUSPENDED";
  db.creators[0]!.marketplaceCollection!.status = "SUSPENDED";

  const state = await listFeaturedCreatorAdminState(
    "shop.myshopify.com",
    "",
    db as any,
  );
  assert.deepEqual(state.selected, []);
});

test("Creator Content Admin route is authenticated and manages ordered Featured Creators", () => {
  const route = readFileSync("app/routes/app.creator-content.tsx", "utf8");
  const navigation = readFileSync("app/routes/app.tsx", "utf8");

  assert.match(route, /authenticate\.admin\(request\)/);
  assert.match(route, /listFeaturedCreatorAdminState/);
  assert.match(route, /saveFeaturedCreatorOrder/);
  assert.match(route, /name="creatorIds"/);
  assert.match(route, /Move up/);
  assert.match(route, /Move down/);
  assert.match(route, /Remove/);
  assert.match(route, /Search approved Creators/);
  assert.match(navigation, /href="\/app\/creator-content"/);
  assert.match(navigation, />Creator Content</);
});

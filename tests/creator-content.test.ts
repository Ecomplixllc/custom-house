import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  listFeaturedCreatorAdminState,
  loadPublicCreatorContent,
  saveFeaturedCreatorOrder,
} from "../app/services/creator-content.server.ts";
import {
  creatorContentHtml,
  parseProxyRoute,
} from "../app/services/storefront-proxy.server.ts";

type AdminContentDb = Parameters<typeof listFeaturedCreatorAdminState>[2];
type PublicContentClient = Parameters<typeof loadPublicCreatorContent>[1];
type PublicContentDb = Parameters<typeof loadPublicCreatorContent>[2];

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
      async findMany(args: Record<string, unknown>) {
        const where = (args.where || {}) as {
          shop?: string;
          id?: { in?: string[] };
          OR?: Array<{ displayName?: { contains?: string } }>;
        };
        const shop = String(where.shop || "");
        const ids = where.id?.in;
        const query = String(where.OR?.[0]?.displayName?.contains || "").toLowerCase();
        const results = creators
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
        return typeof args.take === "number" ? results.slice(0, args.take) : results;
      },
    },
    featuredCreator: {
      async findMany(args: Record<string, unknown>) {
        const where = (args.where || {}) as { shop?: string };
        return featured
          .filter((item) => item.shop === where.shop)
          .sort((left, right) => left.position - right.position)
          .map((item) => ({
            ...item,
            creator: creators.find((creator) => creator.id === item.creatorId),
          }));
      },
      async deleteMany(args: Record<string, unknown>) {
        const where = (args.where || {}) as { shop?: string };
        for (let index = featured.length - 1; index >= 0; index -= 1) {
          if (featured[index]?.shop === where.shop) featured.splice(index, 1);
        }
      },
      async createMany(args: Record<string, unknown>) {
        const data = args.data as Array<{ shop: string; creatorId: string; position: number }>;
        featured.push(...data.map((item, index) => ({ id: `featured-${index}`, ...item })));
      },
    },
    async $transaction(callback: (transaction: unknown) => Promise<unknown>) {
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
    db as unknown as AdminContentDb,
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
    db as unknown as AdminContentDb,
  );
  assert.deepEqual(
    db.featured.map((item) => [item.creatorId, item.position]),
    [["creator-b", 0], ["creator-a", 1]],
  );

  await saveFeaturedCreatorOrder(
    "shop.myshopify.com",
    ["creator-a"],
    db as unknown as AdminContentDb,
  );
  assert.deepEqual(
    db.featured.map((item) => [item.creatorId, item.position]),
    [["creator-a", 0]],
  );
});

test("admin save rejects duplicates, suspended Creators, and cross-shop IDs before writing", async () => {
  const db = fakeFeaturedDb();
  await saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a"], db as unknown as AdminContentDb);

  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a", "creator-a"], db as unknown as AdminContentDb),
    /only once/i,
  );
  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-suspended"], db as unknown as AdminContentDb),
    /approved Creator/i,
  );
  await assert.rejects(
    () => saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-other-shop"], db as unknown as AdminContentDb),
    /approved Creator/i,
  );
  assert.deepEqual(db.featured.map((item) => item.creatorId), ["creator-a"]);
});

test("stale featured records are suppressed when a Creator becomes suspended", async () => {
  const db = fakeFeaturedDb();
  await saveFeaturedCreatorOrder("shop.myshopify.com", ["creator-a"], db as unknown as AdminContentDb);
  db.creators[0]!.status = "SUSPENDED";
  db.creators[0]!.marketplaceCollection!.status = "SUSPENDED";

  const state = await listFeaturedCreatorAdminState(
    "shop.myshopify.com",
    "",
    db as unknown as AdminContentDb,
  );
  assert.deepEqual(state.selected, []);
});

test("featured ordering remains visible when an eligible Creator is outside the candidate page", async () => {
  const db = fakeFeaturedDb();
  for (let index = 0; index < 105; index += 1) {
    db.creators.push({
      id: `creator-extra-${String(index).padStart(3, "0")}`,
      shop: "shop.myshopify.com",
      displayName: `Extra Creator ${String(index).padStart(3, "0")}`,
      handle: `extra-${index}`,
      status: "APPROVED",
      categoriesJson: "[]",
      profileImageUrl: null,
      marketplaceCollection: {
        status: "ACTIVE",
        publicHandle: `extra-${index}-public`,
        displayName: `Extra ${index}`,
      },
      creatorProducts: [{ status: "PUBLISHED" }],
    });
  }
  const selectedId = "creator-extra-104";
  await saveFeaturedCreatorOrder(
    "shop.myshopify.com",
    [selectedId],
    db as unknown as AdminContentDb,
  );

  const state = await listFeaturedCreatorAdminState(
    "shop.myshopify.com",
    "",
    db as unknown as AdminContentDb,
  );

  assert.equal(state.candidates.length, 100);
  assert.deepEqual(state.selected.map((creator) => creator.id), [selectedId]);
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
  assert.match(route, /Build the Featured Creators lineup/);
  assert.match(route, /featured-creator-order/);
  assert.match(route, /Save featured lineup/);
  assert.match(navigation, /href="\/app\/creator-content"/);
  assert.match(navigation, />Creator Content</);
});

function fakePublicDiscovery(options: {
  invalidateBeta?: boolean;
  legacyBeta?: boolean;
  legacyGlobalOnly?: boolean;
  disableDtf?: boolean;
  prolificAlpha?: boolean;
  appProxyOnly?: boolean;
} = {}) {
  const adminDb = fakeFeaturedDb();
  adminDb.featured.push(
    { id: "featured-1", shop: "shop.myshopify.com", creatorId: "creator-b", position: 0 },
    { id: "featured-2", shop: "shop.myshopify.com", creatorId: "creator-a", position: 1 },
  );
  const products = [
    {
      id: "creator-product-a",
      shop: "shop.myshopify.com",
      creatorId: "creator-a",
      title: "Alpha Art Tee",
      description: "A fixed Alpha design",
      baseProductTitle: "T-shirt",
      previewUrl: "https://cdn.example.com/alpha-product.png",
      previewUrls: "[]",
      status: "PUBLISHED",
      publishedAt: new Date("2026-11-11T00:00:00.000Z"),
      updatedAt: new Date("2026-11-11T00:00:00.000Z"),
      shopifyProductId: "gid://shopify/Product/100",
      publishedShopifyProductId: "gid://shopify/Product/900",
      creatorPricingMode: "BAKED_IN_V1",
      designVariantSelectionsJson: JSON.stringify({ fixedColor: "Black" }),
      creator: adminDb.creators[0],
    },
    {
      id: "creator-product-b",
      shop: "shop.myshopify.com",
      creatorId: "creator-b",
      title: "Beta Sound Hoodie",
      description: "A fixed Beta design",
      baseProductTitle: "Hoodie",
      previewUrl: "https://cdn.example.com/beta-product.png",
      previewUrls: "[]",
      status: "PUBLISHED",
      publishedAt: new Date("2026-11-12T00:00:00.000Z"),
      updatedAt: new Date("2026-11-12T00:00:00.000Z"),
      shopifyProductId: "gid://shopify/Product/200",
      publishedShopifyProductId: "gid://shopify/Product/901",
      creatorPricingMode: options.legacyBeta ? null : "BAKED_IN_V1",
      designVariantSelectionsJson: JSON.stringify(options.legacyBeta
        ? { fixedColor: "White", productionMethod: "DTF", placementCount: 2 }
        : { fixedColor: "White" }),
      creator: adminDb.creators[1],
    },
    {
      id: "creator-product-invalid",
      shop: "shop.myshopify.com",
      creatorId: "creator-a",
      title: "Invalid Product",
      description: null,
      baseProductTitle: "T-shirt",
      previewUrl: null,
      previewUrls: "[]",
      status: "PUBLISHED",
      publishedAt: new Date("2026-11-10T00:00:00.000Z"),
      updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      shopifyProductId: "gid://shopify/Product/300",
      publishedShopifyProductId: "gid://shopify/Product/902",
      creatorPricingMode: "BAKED_IN_V1",
      designVariantSelectionsJson: JSON.stringify({ fixedColor: "Black" }),
      creator: adminDb.creators[0],
    },
  ];
  if (options.prolificAlpha) {
    const extras = Array.from({ length: 100 }, (_, index) => ({
      ...products[0]!,
      id: `creator-product-alpha-${index}`,
      title: `Alpha Drop ${index}`,
      publishedAt: new Date(`2026-12-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
      updatedAt: new Date(`2026-12-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
      publishedShopifyProductId: `gid://shopify/Product/${1000 + index}`,
    }));
    products.unshift(...extras);
  }
  const db = {
    ...adminDb,
    creatorProduct: {
      async findMany(args: Record<string, unknown>) {
        const where = args.where as { creatorId?: string } | undefined;
        const skip = typeof args.skip === "number" ? args.skip : 0;
        const take = typeof args.take === "number" ? args.take : products.length;
        const matches = where?.creatorId
          ? products.filter((product) => product.creatorId === where.creatorId)
          : products;
        return matches.slice(skip, skip + take);
      },
    },
    publicProductProductionPricing: {
      async findUnique(args: Record<string, unknown>) {
        if (!options.legacyBeta) return null;
        const where = args.where as { shopKey_shopifyProductId?: { shopifyProductId?: string } };
        return !options.legacyGlobalOnly && where.shopKey_shopifyProductId?.shopifyProductId === "gid://shopify/Product/200"
          ? this.findMany().then((rows) => rows[0] || null)
          : null;
      },
      async findMany() {
        if (!options.legacyBeta) return [];
        const decimal = (value: string) => ({ toFixed: () => value });
        return [{
          id: "pricing-beta",
          shopKey: "shop.myshopify.com",
          shopifyProductId: options.legacyGlobalOnly
            ? "customhouse:creator-products"
            : "gid://shopify/Product/200",
          currency: "SEK",
          methodConfigurations: {
            version: 2,
            methods: { DTF: { enabled: true, surcharge: "25.00", feeVariantId: null } },
          },
          embroiderySurcharge: decimal("0.00"),
          embroideryTextSurcharge: decimal("0.00"),
          embroideryImageSurcharge: decimal("0.00"),
          dtfSurcharge: decimal("25.00"),
          dtgSurcharge: decimal("0.00"),
          embroideryFeeVariantId: null,
          embroideryTextFeeVariantId: null,
          embroideryImageFeeVariantId: null,
          dtfFeeVariantId: null,
          dtgFeeVariantId: null,
        }];
      },
    },
    productionMethodSetting: {
      async findMany() {
        return options.disableDtf
          ? [{ method: "DTF", label: "DTF printing", enabled: false }]
          : [];
      },
    },
  };
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const shopify = {
    async request<T>(query: string, variables: Record<string, unknown>) {
      requests.push({ query, variables });
      const nodes = [
          {
            id: "gid://shopify/Product/900",
            title: "Alpha Art Tee",
            handle: "alpha-art-tee",
            status: "ACTIVE",
            onlineStoreUrl: options.appProxyOnly
              ? null
              : "https://shop.example.com/products/alpha-art-tee",
            origin: { value: "creator" },
            mode: { value: "buy_only" },
            designStatus: { value: "published" },
            creatorProductId: { value: "creator-product-a" },
            priceRangeV2: {
              minVariantPrice: { amount: "249.00", currencyCode: "SEK" },
              maxVariantPrice: { amount: "999.00", currencyCode: "SEK" },
            },
            variants: {
              nodes: [
                { id: "gid://shopify/ProductVariant/1", availableForSale: true, price: "249.00", selectedOptions: [{ name: "Size", value: "S" }, { name: "Color", value: "Black" }] },
                { id: "gid://shopify/ProductVariant/2", availableForSale: false, price: "249.00", selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Black" }] },
                { id: "gid://shopify/ProductVariant/4", availableForSale: true, price: "999.00", selectedOptions: [{ name: "Size", value: "S" }, { name: "Color", value: "Blue" }] },
              ],
            },
          },
          {
            id: options.legacyBeta ? "gid://shopify/Product/200" : "gid://shopify/Product/901",
            title: "Beta Sound Hoodie",
            handle: "beta-sound-hoodie",
            status: options.invalidateBeta ? "DRAFT" : "ACTIVE",
            onlineStoreUrl: options.invalidateBeta || options.appProxyOnly
              ? null
              : "https://shop.example.com/products/beta-sound-hoodie",
            origin: { value: "creator" },
            mode: { value: "buy_only" },
            designStatus: { value: "published" },
            creatorProductId: { value: "creator-product-b" },
            priceRangeV2: {
              minVariantPrice: { amount: "499.00", currencyCode: "SEK" },
              maxVariantPrice: { amount: "499.00", currencyCode: "SEK" },
            },
            variants: {
              nodes: [
                { id: "gid://shopify/ProductVariant/3", availableForSale: true, price: "499.00", selectedOptions: [{ name: "Size", value: "L" }, { name: "Color", value: "White" }] },
              ],
            },
          },
          {
            id: "gid://shopify/Product/902",
            title: "Invalid Product",
            handle: "invalid-product",
            status: "DRAFT",
            onlineStoreUrl: null,
            origin: { value: "creator" },
            mode: { value: "customizable" },
            designStatus: { value: "draft" },
            creatorProductId: { value: "creator-product-invalid" },
            priceRangeV2: {
              minVariantPrice: { amount: "100.00", currencyCode: "SEK" },
              maxVariantPrice: { amount: "100.00", currencyCode: "SEK" },
            },
            variants: { nodes: [] },
          },
        ];
      const requestedIds = Array.isArray(variables.ids) ? variables.ids : [];
      const knownIds = new Set(nodes.map((node) => node.id));
      const generatedNodes = requestedIds
        .filter((id): id is string => typeof id === "string" && !knownIds.has(id))
        .flatMap((id) => {
          const record = products.find((product) =>
            (product.creatorPricingMode === "BAKED_IN_V1" && product.publishedShopifyProductId
              ? product.publishedShopifyProductId
              : product.shopifyProductId) === id,
          );
          return record
            ? [{
                id,
                title: record.title,
                handle: record.id,
                status: "ACTIVE",
                productType: record.baseProductTitle,
                onlineStoreUrl: options.appProxyOnly
                  ? null
                  : `https://shop.example.com/products/${record.id}`,
                origin: { value: "creator" },
                mode: { value: "buy_only" },
                designStatus: { value: "published" },
                creatorProductId: { value: record.id },
                priceRangeV2: {
                  minVariantPrice: { amount: "249.00", currencyCode: "SEK" },
                  maxVariantPrice: { amount: "249.00", currencyCode: "SEK" },
                },
                variants: { nodes: [{
                  id: `${id}/variant`,
                  availableForSale: true,
                  price: "249.00",
                  selectedOptions: [{ name: "Color", value: "Black" }],
                }] },
              }]
            : [];
        });
      return {
        nodes: [
          ...nodes.filter((node) => requestedIds.includes(node.id)),
          ...generatedNodes,
        ],
      } as T;
    },
  };
  return { db, shopify, requests };
}

test("public Creator Content uses one batched Shopify query and canonical routes", async () => {
  const { db, shopify, requests } = fakePublicDiscovery();
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );

  assert.equal(requests.length, 2);
  const productRequest = requests.find((request) => request.query.includes("CreatorContentProducts"))!;
  assert.match(productRequest.query, /nodes\(ids: \$ids\)/);
  assert.deepEqual(productRequest.variables.ids, [
    "gid://shopify/Product/900",
    "gid://shopify/Product/901",
    "gid://shopify/Product/902",
  ]);
  assert.deepEqual(result.featuredCreators.map((creator) => creator.id), ["creator-b", "creator-a"]);
  assert.deepEqual(result.products.map((product) => product.id), ["creator-product-b", "creator-product-a"]);
  assert.equal(result.products[0]!.creatorUrl, "/apps/customhouse/creators/beta-b1c2d");
  assert.equal(result.products[0]!.viewUrl, "/apps/customhouse/creators/beta-b1c2d/products/creator-product-b");
});

test("public Creator Content includes active buy-only products routed through the app proxy", async () => {
  const { db, shopify } = fakePublicDiscovery({ appProxyOnly: true });
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );

  assert.deepEqual(result.featuredCreators.map((creator) => creator.id), ["creator-b", "creator-a"]);
  assert.deepEqual(result.products.map((product) => product.id), ["creator-product-b", "creator-product-a"]);
  assert.equal(result.products.every((product) => product.viewUrl.startsWith("/apps/customhouse/creators/")), true);
});

test("public Creator Content paginates DB rows and exposes a continuation offset", async () => {
  const { db, shopify, requests } = fakePublicDiscovery();
  const first = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
    { offset: 0, limit: 1 },
  );
  const second = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
    { offset: first.nextOffset || 0, limit: 1 },
  );

  assert.deepEqual(first.products.map((product) => product.id), ["creator-product-a"]);
  assert.deepEqual(first.featuredCreators.map((creator) => creator.id), ["creator-b", "creator-a"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(second.products.map((product) => product.id), ["creator-product-b"]);
  assert.equal(requests.length, 4);
  const productRequests = requests.filter((request) => request.query.includes("CreatorContentProducts"));
  assert.equal((productRequests[0]!.variables.ids as string[]).includes("gid://shopify/Product/900"), true);
  assert.equal((productRequests[1]!.variables.ids as string[]).includes("gid://shopify/Product/901"), true);
});

test("public Creator Content exposes real price and variant facets only", async () => {
  const { db, shopify } = fakePublicDiscovery();
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );
  const alpha = result.products.find((product) => product.id === "creator-product-a")!;

  assert.deepEqual(alpha.price, { min: 249, max: 249, currencyCode: "SEK" });
  assert.deepEqual(alpha.sizes, ["S", "M"]);
  assert.deepEqual(alpha.colors, ["Black"]);
  assert.equal(alpha.available, true);
  assert.deepEqual(result.filters.productTypes, ["Hoodie", "T-shirt"]);
  assert.deepEqual(result.filters.colors, ["Black", "White"]);
  assert.deepEqual(result.filters.sizes, ["S", "M", "L"]);
  assert.deepEqual(result.categories, ["Art & Design", "Music", "Streetwear"]);
});

test("legacy Creator Content prices include the configured production surcharge", async () => {
  const { db, shopify, requests } = fakePublicDiscovery({ legacyBeta: true });
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );
  const beta = result.products.find((product) => product.id === "creator-product-b")!;

  assert.deepEqual(beta.price, { min: 549, max: 549, currencyCode: "SEK" });
  assert.equal((requests[0]!.variables.ids as string[]).includes("gid://shopify/Product/200"), true);
  assert.equal((requests[0]!.variables.ids as string[]).includes("gid://shopify/Product/901"), false);
});

test("legacy Creator Content requires product-specific enabled production pricing", async () => {
  for (const options of [
    { legacyBeta: true, legacyGlobalOnly: true },
    { legacyBeta: true, disableDtf: true },
  ]) {
    const { db, shopify } = fakePublicDiscovery(options);
    const result = await loadPublicCreatorContent(
      "shop.myshopify.com",
      shopify as unknown as PublicContentClient,
      db as unknown as PublicContentDb,
    );

    assert.equal(result.products.some((product) => product.id === "creator-product-b"), false);
    assert.equal(result.featuredCreators.some((creator) => creator.id === "creator-b"), false);
  }
});

test("Featured Creator eligibility is fair when another Creator has over 96 newer products", async () => {
  const { db, shopify } = fakePublicDiscovery({ prolificAlpha: true });
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );

  assert.deepEqual(result.featuredCreators.map((creator) => creator.id), ["creator-b", "creator-a"]);
});

test("public Creator Content suppresses missing, inactive, or non-buy-only Shopify products", async () => {
  const { db, shopify } = fakePublicDiscovery();
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );

  assert.equal(result.products.some((product) => product.id === "creator-product-invalid"), false);
  assert.equal(result.products.every((product) => product.available), true);
});

test("public facets and Featured Creators require at least one Shopify-valid product", async () => {
  const { db, shopify } = fakePublicDiscovery({ invalidateBeta: true });
  const result = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );

  assert.deepEqual(result.products.map((product) => product.creatorId), ["creator-a"]);
  assert.deepEqual(result.featuredCreators.map((creator) => creator.id), ["creator-a"]);
  assert.deepEqual(result.filters.creators.map((creator) => creator.id), ["creator-a"]);
  assert.deepEqual(result.categories, ["Art & Design", "Streetwear"]);
});

test("Creator Content app-proxy route is deterministic", () => {
  assert.deepEqual(parseProxyRoute("creator-content"), { kind: "creatorContent" });
});

test("Creator Content is added to theme navigation without duplicating merchant links", () => {
  const fallback = readFileSync(
    "theme-live-cart/snippets/customhouse-creator-content-menu-fallback.liquid",
    "utf8",
  );
  const desktopHeader = readFileSync(
    "theme-live-cart/blocks/_header-menu.liquid",
    "utf8",
  );
  const drawer = readFileSync(
    "theme-live-cart/snippets/header-drawer.liquid",
    "utf8",
  );

  assert.match(fallback, /where:\s*'url',\s*'\/apps\/customhouse\/creator-content'/);
  assert.match(fallback, /creator_content_absolute/);
  assert.match(fallback, /'\/apps\/customhouse\/creator-content\/'/);
  assert.match(fallback, /CREATOR CONTENT/);
  assert.match(desktopHeader, /customhouse-creator-content-menu-fallback[\s\S]*variant:\s*'mobile_bar'/);
  assert.match(desktopHeader, /customhouse-creator-content-menu-fallback[\s\S]*variant:\s*'desktop'/);
  assert.match(drawer, /customhouse-creator-content-menu-fallback[\s\S]*variant:\s*'drawer'/);
});

test("Creator Content renderer provides responsive real-data discovery without customization controls", async () => {
  const { db, shopify } = fakePublicDiscovery();
  const data = await loadPublicCreatorContent(
    "shop.myshopify.com",
    shopify as unknown as PublicContentClient,
    db as unknown as PublicContentDb,
  );
  const response = creatorContentHtml({
    ...data,
    headerAccount: { loggedIn: false },
  });
  const markup = await response.text();
  const pageMarkup = markup.match(/<main class="customhouse-creator-content-page"[\s\S]*?<\/main>/)?.[0] || "";

  assert.equal(response.status, 200);
  assert.match(markup, /class="customhouse-creator-content-page"/);
  assert.match(markup, /html,body\{min-height:100%;margin:0;background:#060708\}/);
  assert.match(markup, /HOME[\s\S]*CREATOR CONTENT/);
  assert.match(markup, /Discover unique designs from CustomHouse creators/);
  assert.match(markup, /data-creator-content-search/);
  assert.match(markup, /aria-label="Search creators, collections, designs, or tags"/);
  assert.match(markup, /data-creator-content-category="Streetwear"/);
  assert.match(markup, /Featured Creators/);
  assert.match(markup, /href="\/apps\/customhouse\/creators\/beta-b1c2d"/);
  assert.match(markup, /href="\/apps\/customhouse\/creators\/beta-b1c2d\/products\/creator-product-b"/);
  assert.match(markup, />BUY PRODUCT</);
  assert.match(markup, /data-creator-content-filter-drawer/);
  assert.match(markup, /data-creator-content-filter-drawer[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(markup, /data-creator-content-filter-open[^>]*aria-expanded="false"/);
  assert.match(markup, /data-creator-content-sort/);
  assert.match(markup, /data-next-offset=/);
  assert.match(markup, /new DOMParser\(\)/);
  assert.match(markup, /fetch\(pageUrl\.toString\(\)/);
  assert.match(markup, /Price: low to high/);
  assert.match(markup, /@media\(max-width:1279px\)/);
  assert.match(markup, /@media\(max-width:767px\)/);
  assert.match(markup, /customhouse-creator-content__hero h1\{font-size:clamp\(44px,15vw,72px\)\}/);
  assert.match(markup, /setTimeout\(async \(\) =>/);
  assert.match(markup, /ensureCompleteCatalog/);
  assert.match(markup, /sourcePriceGroup/);
  assert.match(markup, /minValue \? Number\(minValue\) : Number\.NaN/);
  assert.match(markup, /maxValue \? Number\(maxValue\) : Number\.NaN/);
  assert.match(markup, /matchMedia\("\(max-width:900px\)"\)/);
  assert.match(markup, /drawer\.inert = !open/);
  assert.match(markup, /event\.key === "Tab"/);
  assert.match(markup, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(markup, /window\.history\.replaceState/);
  assert.match(markup, /window\.addEventListener\("popstate", \(\) => \{ void restoreCompleteUrlState\(\); \}\)/);
  assert.match(markup, /class="customhouse-header__nav"[\s\S]*CREATOR CONTENT/);
  assert.match(markup, /class="customhouse-mobile-drawer__nav"[\s\S]*CREATOR CONTENT/);
  assert.match(markup, /href="\/apps\/customhouse\/creator-content"[^>]*aria-current="page"/);
  assert.match(markup, /@media screen and \(min-width:901px\) and \(max-width:1500px\)/);
  for (const [, source] of markup.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(source));
  }
  assert.doesNotMatch(pageMarkup, />\s*Customize\s*</i);
  assert.doesNotMatch(pageMarkup, /PitchPrint|Follow Creator|Wishlist|favorite/i);
});

test("Creator Content storefront handler loads the public service and reuses existing product routes", () => {
  const source = readFileSync("app/services/storefront-proxy.server.ts", "utf8");

  assert.match(source, /case "creatorContent":/);
  assert.match(source, /loadPublicCreatorContent\([\s\S]*?context\.shop,[\s\S]*?context\.client,[\s\S]*?undefined,[\s\S]*?\{ offset, includeFeatured: offset === 0 \},[\s\S]*?\)/);
  assert.match(source, /creatorContentHtml\(\{/);
  assert.match(source, /getCreatorProductStorefrontUrl/);
  assert.doesNotMatch(source, /creatorContent.*showApp\(/i);
});

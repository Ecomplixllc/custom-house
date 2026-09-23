import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  creatorCollectionBannerForCustomer,
  removeCreatorCollectionBanner,
  updateCreatorCollectionBanner,
  uploadCollectionBannerImage,
  validateCollectionBannerImage,
} from "../app/services/creator-collection-banner.server.ts";
import { DomainError } from "../app/services/domain.ts";
import {
  collectionHtml,
  publicCreatorSocialLinks,
} from "../app/services/storefront-proxy.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

function pngBytes(width = 1920, height = 600) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function bannerDb() {
  const auditActions: string[] = [];
  const collection = {
    id: "collection-a",
    shop: "customhouse.test",
    creatorId: "creator-a",
    publicHandle: "ari-designs",
    bannerImageUrl: null as string | null,
    bannerTitle: null as string | null,
    bannerSubtitle: null as string | null,
    bannerUpdatedAt: null as Date | null,
  };
  return {
    collection,
    auditActions,
    creator: {
      async findUnique(args: {
        where: { shop_customerId: { shop: string; customerId: string } };
      }) {
        assert.deepEqual(args.where.shop_customerId, {
          shop: "customhouse.test",
          customerId: "gid://shopify/Customer/111",
        });
        return {
          id: "creator-a",
          shop: "customhouse.test",
          customerId: "gid://shopify/Customer/111",
          status: "APPROVED",
        };
      },
    },
    creatorCollection: {
      async findFirst(args: {
        where: { shop: string; creatorId: string };
      }) {
        assert.deepEqual(args.where, {
          shop: "customhouse.test",
          creatorId: "creator-a",
        });
        return collection;
      },
      async update(args: {
        where: { id: string };
        data: {
          bannerImageUrl?: string | null;
          bannerTitle?: string | null;
          bannerSubtitle?: string | null;
          bannerUpdatedAt?: Date | null;
        };
      }) {
        assert.equal(args.where.id, "collection-a");
        Object.assign(collection, args.data);
        return collection;
      },
    },
    auditLog: {
      async create(args: { data: { action: string; actorId: string } }) {
        assert.equal(args.data.actorId, "gid://shopify/Customer/111");
        auditActions.push(args.data.action);
        return {};
      },
    },
  };
}

function publicCollectionInput(overrides: {
  collection?: Record<string, unknown>;
  creator?: Record<string, unknown>;
  products?: Array<Record<string, unknown>>;
} = {}) {
  return {
    collection: {
      publicHandle: "ari-designs",
      displayName: "Ari Designs",
      bannerImageUrl: null,
      bannerTitle: null,
      bannerSubtitle: null,
      ...overrides.collection,
    },
    creator: {
      displayName: "Ari",
      handle: "ari",
      portfolioUrl: null,
      socialLinksJson: "[]",
      primaryPlatform: null,
      primaryProfileUrl: null,
      ...overrides.creator,
    },
    products: overrides.products?.map((product) => ({
      id: "creator-product-a",
      title: "Creator Tee",
      description: null,
      baseProductTitle: "T-Shirt",
      previewUrl: null,
      previewUrls: "[]",
      ...product,
    })) || [],
  };
}

async function publicCollectionMarkup(
  overrides: Parameters<typeof publicCollectionInput>[0] = {},
) {
  return collectionHtml(publicCollectionInput(overrides)).text();
}

test("collection banner validation accepts wide PNG banners and rejects mismatched files", () => {
  assert.deepEqual(
    validateCollectionBannerImage(
      pngBytes(),
      "image/png",
      24,
      "banner.png",
    ),
    { mimeType: "image/png", width: 1920, height: 600 },
  );
  assert.throws(
    () =>
      validateCollectionBannerImage(
        pngBytes(),
        "image/jpeg",
        24,
        "banner.jpg",
      ),
    /image type does not match/i,
  );
});

test("collection banner upload stores Shopify media and returns a display URL", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      requests.push(query);
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/banner",
                resourceUrl: "https://cdn.shopify.test/staged/banner.png",
                parameters: [{ name: "key", value: "banner.png" }],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("fileCreate")) {
        return {
          fileCreate: {
            files: [
              {
                id: "gid://shopify/MediaImage/999",
                fileStatus: "READY",
                image: { url: "https://cdn.shopify.test/banner.png" },
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    const uploaded = await uploadCollectionBannerImage(
      new File([pngBytes()], "banner.png", { type: "image/png" }),
      client,
      "Ari collection banner",
    );

    assert.equal(uploaded.bannerImageUrl, "https://cdn.shopify.test/banner.png");
    assert.equal(uploaded.bannerImageId, "gid://shopify/MediaImage/999");
    assert.equal(uploaded.status, "READY");
    assert.equal(requests.some((query) => query.includes("stagedUploadsCreate")), true);
    assert.equal(requests.some((query) => query.includes("fileCreate")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collection banner upload waits for Shopify media readiness before saving URL", async () => {
  const originalFetch = globalThis.fetch;
  let imagePolls = 0;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/banner",
                resourceUrl: "https://cdn.shopify.test/staged/banner.png",
                parameters: [{ name: "key", value: "banner.png" }],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("fileCreate")) {
        return {
          fileCreate: {
            files: [
              {
                id: "gid://shopify/MediaImage/999",
                fileStatus: "PROCESSING",
                image: null,
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("CreatorCollectionBannerImage")) {
        imagePolls += 1;
        return {
          bannerImage: {
            id: "gid://shopify/MediaImage/999",
            fileStatus: imagePolls > 1 ? "READY" : "PROCESSING",
            image: imagePolls > 1 ? { url: "https://cdn.shopify.test/banner-ready.png" } : null,
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    const uploaded = await uploadCollectionBannerImage(
      new File([pngBytes()], "banner.png", { type: "image/png" }),
      client,
    );

    assert.equal(uploaded.bannerImageUrl, "https://cdn.shopify.test/banner-ready.png");
    assert.equal(imagePolls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collection banner upload surfaces staged and binary upload failures safely", async () => {
  const stagedFailureClient: ShopifyGraphqlClient = {
    async request<T>() {
      return {
        stagedUploadsCreate: {
          stagedTargets: [],
          userErrors: [{ message: "Denied by Shopify" }],
        },
      } as T;
    },
  };

  await assert.rejects(
    uploadCollectionBannerImage(
      new File([pngBytes()], "banner.png", { type: "image/png" }),
      stagedFailureClient,
    ),
    (error) => error instanceof DomainError && error.code === "STAGED_UPLOAD_FAILED",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  const binaryFailureClient: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/banner",
                resourceUrl: "https://cdn.shopify.test/staged/banner.png",
                parameters: [],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    await assert.rejects(
      uploadCollectionBannerImage(
        new File([pngBytes()], "banner.png", { type: "image/png" }),
        binaryFailureClient,
      ),
      (error) => error instanceof DomainError && error.code === "STAGED_BINARY_UPLOAD_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collection banner upload surfaces Shopify file creation failures safely", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/banner",
                resourceUrl: "https://cdn.shopify.test/staged/banner.png",
                parameters: [],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("fileCreate")) {
        return {
          fileCreate: {
            files: [],
            userErrors: [{ message: "Bad source" }],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    await assert.rejects(
      uploadCollectionBannerImage(
        new File([pngBytes()], "banner.png", { type: "image/png" }),
        client,
      ),
      (error) => error instanceof DomainError && error.code === "SHOPIFY_FILE_CREATE_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated creator can update only their own collection banner", async () => {
  const database = bannerDb();
  const updated = await updateCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    title: "Summer drop",
    subtitle: "Limited pieces from Ari",
    bannerImageUrl: "https://cdn.shopify.test/banner.png",
    database,
  });

  assert.equal(updated.bannerImageUrl, "https://cdn.shopify.test/banner.png");
  assert.equal(updated.bannerTitle, "Summer drop");
  assert.equal(updated.bannerSubtitle, "Limited pieces from Ari");
  assert.ok(updated.bannerUpdatedAt instanceof Date);
  assert.deepEqual(database.auditActions, ["creator_collection.banner.updated"]);
});

test("text-only banner save preserves an existing banner image", async () => {
  const database = bannerDb();
  database.collection.bannerImageUrl = "https://cdn.shopify.test/original.png";

  const updated = await updateCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    title: "Renamed drop",
    subtitle: "Fresh copy, same image",
    database,
  });

  assert.equal(updated.bannerImageUrl, "https://cdn.shopify.test/original.png");
  assert.equal(updated.bannerTitle, "Renamed drop");
  assert.equal(updated.bannerSubtitle, "Fresh copy, same image");
});

test("banner image replacement updates the authenticated creator collection only", async () => {
  const database = bannerDb();
  database.collection.bannerImageUrl = "https://cdn.shopify.test/original.png";

  await updateCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    title: "First banner",
    bannerImageUrl: "https://cdn.shopify.test/first.png",
    database,
  });
  const updated = await updateCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    title: "Replacement banner",
    bannerImageUrl: "https://cdn.shopify.test/replacement.png",
    database,
  });

  assert.equal(updated.creatorId, "creator-a");
  assert.equal(updated.bannerImageUrl, "https://cdn.shopify.test/replacement.png");
  assert.equal(updated.bannerTitle, "Replacement banner");
});

test("banner lookup is scoped to the authenticated customer collection", async () => {
  const database = bannerDb();
  database.collection.bannerImageUrl = "https://cdn.shopify.test/banner.png";

  const collection = await creatorCollectionBannerForCustomer({
    shop: "customhouse.test",
    customerId: "111",
    database,
  });

  assert.equal(collection.id, "collection-a");
  assert.equal(collection.creatorId, "creator-a");
  assert.equal(collection.bannerImageUrl, "https://cdn.shopify.test/banner.png");
});

test("database save failures return a safe domain error", async () => {
  const database = bannerDb();
  database.creatorCollection.update = async () => {
    throw new Error("database exploded");
  };

  await assert.rejects(
    updateCreatorCollectionBanner({
      shop: "customhouse.test",
      customerId: "111",
      title: "Summer drop",
      database,
    }),
    (error) => error instanceof DomainError && error.code === "DATABASE_UPDATE_FAILED",
  );
});

test("remove banner clears the complete banner configuration for the authenticated creator", async () => {
  const database = bannerDb();
  database.collection.bannerImageUrl = "https://cdn.shopify.test/banner.png";
  database.collection.bannerTitle = "Summer drop";
  database.collection.bannerSubtitle = "Limited pieces from Ari";
  database.collection.bannerUpdatedAt = new Date();

  const updated = await removeCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    database,
  });

  assert.equal(updated.bannerImageUrl, null);
  assert.equal(updated.bannerTitle, null);
  assert.equal(updated.bannerSubtitle, null);
  assert.equal(updated.bannerUpdatedAt, null);
  assert.deepEqual(database.auditActions, ["creator_collection.banner.removed"]);
});

test("creator banner proxy route uses app proxy auth and never accepts browser creatorId", () => {
  const route = readFileSync(
    "app/routes/proxy.api.creator-collection-banner.tsx",
    "utf8",
  );

  assert.match(route, /proxyContext\(request\)/);
  assert.match(route, /creatorCollectionBannerForCustomer/);
  assert.match(route, /updateCreatorCollectionBanner/);
  assert.match(route, /removeCreatorCollectionBanner/);
  assert.match(route, /bannerImage/);
  assert.match(route, /REQUEST_PARSE_FAILED/);
  assert.match(route, /error:\s*\{/);
  assert.match(route, /code,/);
  assert.doesNotMatch(route, /creatorId/);
  assert.doesNotMatch(route, /searchParams\.get\(["']creatorId["']\)/);
  assert.doesNotMatch(route, /form\.get\(["']creatorId["']\)/);
});

test("creator dashboard response exposes collection banner fields", () => {
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");

  assert.match(dashboardService, /bannerImageUrl: true/);
  assert.match(dashboardService, /bannerTitle: true/);
  assert.match(dashboardService, /bannerSubtitle: true/);
  assert.match(dashboardService, /bannerUpdatedAt: true/);
  assert.match(dashboardService, /bannerUpdatedAt: creator\.marketplaceCollection\.bannerUpdatedAt/);
});

test("creator dashboard renders compact collection banner management UI", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /customhouse-collection-banner-manager/);
  assert.match(block, /data-dashboard-banner-form/);
  assert.match(block, /data-dashboard-banner-preview/);
  assert.match(block, /name="bannerImage"/);
  assert.match(block, /name="bannerTitle"/);
  assert.match(block, /name="bannerSubtitle"/);
  assert.match(block, /No collection banner yet/);
  assert.match(block, /Recommended 1920 x 600 px/);
  assert.match(block, /data-dashboard-banner-selected/);
  assert.match(block, /data-dashboard-banner-updated/);
  assert.match(block, /data-dashboard-banner-remove/);
  assert.match(block, /data-dashboard-action-modal/);

  assert.match(script, /COLLECTION_BANNER_ENDPOINT/);
  assert.match(script, /function hydrateCollectionBannerManager/);
  assert.match(script, /function bindCollectionBannerManager/);
  assert.match(script, /saveCollectionBanner/);
  assert.match(script, /removeCollectionBanner/);
  assert.match(script, /data-dashboard-banner-preview-image/);
  assert.match(script, /formatBannerUpdatedAt/);
  assert.match(script, /setBannerMessage/);
  assert.match(script, /openDashboardActionModal/);
  assert.match(script, /Collection banner removed/);
  assert.doesNotMatch(script, /alert\(/);

  assert.match(styles, /\.customhouse-collection-banner-manager/);
  assert.match(styles, /grid-template-columns: minmax\(220px, \.42fr\) minmax\(0, \.58fr\)/);
  assert.match(styles, /\.customhouse-banner-preview\s*\{[^}]*aspect-ratio: 3\.2 \/ 1/s);
  assert.match(styles, /\.customhouse-banner-preview img\s*\{[^}]*object-fit: cover/s);
  assert.match(styles, /\.customhouse-banner-upload input\s*\{[^}]*opacity: 0/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-banner-actions/s);
});

test("public creator collection loads banner and existing social profile fields", () => {
  const collectionsService = readFileSync(
    "app/services/creator-collections.server.ts",
    "utf8",
  );
  const storefront = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(collectionsService, /bannerImageUrl: true/);
  assert.match(collectionsService, /bannerTitle: true/);
  assert.match(collectionsService, /bannerSubtitle: true/);
  assert.match(collectionsService, /bannerUpdatedAt: true/);
  assert.match(collectionsService, /portfolioUrl: true/);
  assert.match(collectionsService, /socialLinksJson: true/);
  assert.match(collectionsService, /primaryPlatform: true/);
  assert.match(collectionsService, /primaryProfileUrl: true/);
  assert.doesNotMatch(storefront, /function collectionBannerHtml/);
  assert.doesNotMatch(storefront, /customhouse-public-banner/);
  assert.match(storefront, /customhouse-public-hero--with-banner/);
  assert.match(storefront, /background-size:cover/);
  assert.match(storefront, /background-position:center/);
  assert.match(storefront, /bannerTitle/);
  assert.match(storefront, /socialLinks: publicSocialLinksRecord\(creator\)/);
});

test("public creator collection JSON exposes banner fields only from the loaded collection", () => {
  const storefront = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(storefront, /bannerImageUrl: collection\.bannerImageUrl/);
  assert.match(storefront, /bannerTitle: collection\.bannerTitle/);
  assert.match(storefront, /bannerSubtitle: collection\.bannerSubtitle/);
  assert.match(storefront, /bannerUpdatedAt: collection\.bannerUpdatedAt/);
  assert.match(storefront, /socialLinks: publicSocialLinksRecord\(creator\)/);
});

test("public hero keeps default branded background when no banner is configured", async () => {
  const markup = await publicCollectionMarkup();

  assert.match(markup, /<header class="customhouse-public-hero">/);
  assert.match(markup, /radial-gradient\(circle at 78% 20%,rgba\(138,44,255,.16\),transparent 28%\),linear-gradient\(100deg,#09090a/);
  assert.doesNotMatch(markup, /<header class="[^"]*customhouse-public-hero--with-banner/);
  assert.doesNotMatch(markup, /<section class="customhouse-public-banner"/);
});

test("public hero uses configured banner as the existing hero background", async () => {
  const markup = await publicCollectionMarkup({
    collection: {
      bannerImageUrl: "https://cdn.shopify.com/banner.png",
    },
  });

  assert.match(markup, /customhouse-public-hero customhouse-public-hero--with-banner/);
  assert.match(markup, /background-image: linear-gradient\(90deg, rgba\(0,0,0,.82\)/);
  assert.match(markup, /url\(&quot;https:\/\/cdn\.shopify\.com\/banner\.png&quot;\)/);
  assert.doesNotMatch(markup, /<section class="customhouse-public-banner"/);
  assert.doesNotMatch(markup, /alt="Ari collection banner"/);
});

test("public hero banner fills the top and bottom layout without page gaps", () => {
  const storefront = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(storefront, /\.customhouse-public-page,.customhouse-product-page\{[^}]*padding:0 0 2\.5rem/);
  assert.match(storefront, /\.customhouse-public-hero--with-banner\{[^}]*background-size:cover[^}]*background-origin:border-box[^}]*background-clip:border-box/s);
  assert.match(storefront, /\.customhouse-public-services\{[^}]*margin:0 0 1\.5rem/);
});

test("public hero title uses banner title and falls back to collection title", async () => {
  const withTitle = await publicCollectionMarkup({
    collection: { bannerTitle: "Ari Summer Drop" },
  });
  const withoutTitle = await publicCollectionMarkup({
    collection: { bannerTitle: "   " },
  });

  assert.match(withTitle, /<h1>Ari Summer Drop<\/h1>/);
  assert.match(withoutTitle, /<h1>Ari Designs<\/h1>/);
});

test("public hero subtitle uses banner subtitle and falls back to existing tagline", async () => {
  const withSubtitle = await publicCollectionMarkup({
    collection: { bannerSubtitle: "Explore my latest custom designs." },
  });
  const withoutSubtitle = await publicCollectionMarkup({
    collection: { bannerSubtitle: "" },
  });

  assert.match(withSubtitle, /<p>Explore my latest custom designs\.<\/p>/);
  assert.match(withoutSubtitle, /<p>Explore every piece from Ari\. Unique creator designs, ready to purchase\.<\/p>/);
});

test("public social links render safe supported URLs and hide missing values", async () => {
  const markup = await publicCollectionMarkup({
    creator: {
      socialLinksJson: JSON.stringify(["https://instagram.com/ari"]),
    },
  });

  assert.match(markup, /customhouse-public-socials/);
  assert.match(markup, /data-social-platform="instagram"/);
  assert.match(markup, /href="https:\/\/instagram\.com\/ari"/);
  assert.doesNotMatch(markup, /data-social-platform="facebook"/);
});

test("public social links reject unsafe URL schemes", async () => {
  const markup = await publicCollectionMarkup({
    creator: {
      socialLinksJson: JSON.stringify([
        "javascript:alert(1)",
        "data:text/html,nope",
        "https://tiktok.com/@ari",
      ]),
    },
  });

  assert.doesNotMatch(markup, /javascript:/);
  assert.doesNotMatch(markup, /data:text/);
  assert.match(markup, /data-social-platform="tiktok"/);
});

test("public social links support multiple platforms without duplicates", async () => {
  const links = publicCreatorSocialLinks({
    primaryPlatform: "YouTube",
    primaryProfileUrl: "https://youtube.com/@ari",
    socialLinksJson: JSON.stringify([
      "https://instagram.com/ari",
      "https://facebook.com/ari",
      "https://tiktok.com/@ari",
      "https://x.com/ari",
      "https://instagram.com/ari",
    ]),
    portfolioUrl: "http://example.com/ari",
  });

  assert.deepEqual(
    links.map((link) => link.platform),
    ["youtube", "instagram", "facebook", "tiktok", "x", "website"],
  );
});

test("public social links are scoped to the rendered creator only", async () => {
  const creatorA = await publicCollectionMarkup({
    creator: {
      socialLinksJson: JSON.stringify(["https://instagram.com/creator-a"]),
    },
  });
  const creatorB = await publicCollectionMarkup({
    creator: {
      socialLinksJson: JSON.stringify(["https://youtube.com/@creator-b"]),
    },
  });

  assert.match(creatorA, /instagram\.com\/creator-a/);
  assert.doesNotMatch(creatorA, /youtube\.com\/@creator-b/);
  assert.match(creatorB, /youtube\.com\/@creator-b/);
  assert.doesNotMatch(creatorB, /instagram\.com\/creator-a/);
});

test("public creator collection products still render with hero changes", async () => {
  const markup = await publicCollectionMarkup({
    products: [
      {
        id: "product-one",
        title: "Creator Hoodie",
        baseProductTitle: "Premium Hoodie",
        previewUrl: "https://cdn.shopify.com/product.png",
      },
    ],
  });

  assert.match(markup, /customhouse-public-grid/);
  assert.match(markup, /Creator Hoodie/);
  assert.match(markup, /Premium Hoodie/);
  assert.match(markup, /View Product/);
});

test("admin creator list and detail expose read-only collection banner status", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(route, /marketplaceCollection:\s*\{\s*select:\s*\{/);
  assert.match(route, /bannerImageUrl: true/);
  assert.match(route, /bannerTitle: true/);
  assert.match(route, /bannerSubtitle: true/);
  assert.match(route, /bannerUpdatedAt: true/);
  assert.match(route, /Collection Banner/);
  assert.match(route, /creator-banner-preview/);
  assert.match(route, /Banner configured/);
  assert.match(route, /No banner/);
  assert.doesNotMatch(route, /name="bannerImage"/);
  assert.match(styles, /\.creator-banner-preview/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  type CreatorProductRecord,
  assertPitchPrintProjectOwner,
  attachPitchPrintProjectToCreatorProduct,
  creatorProductSetupFromRecord,
  cleanupCreatorProductAsAdmin,
  createCreatorProductDraft as createCreatorProductDraftService,
  getCreatorProductForCustomer,
  getPublishedCreatorProductForHandle,
  getPublishedCreatorProduct,
  listEligibleCreatorBaseProducts,
  listPublishedCreatorProductsForHandle,
  listCreatorProductsForCustomer,
  moderateCreatorProductAsAdmin,
  prepareCreatorProductCart as prepareCreatorProductCartService,
  prepareNativeCreatorProductCart,
  productionMethodsForCreatorProduct,
  publicCreatorProductDetail,
  archiveCreatorProductForCustomer,
  deleteCreatorProductForCustomer,
  restoreCreatorProductToDraftForCustomer,
  savePitchPrintDraftSessionForCustomer,
  submitCreatorProductForReview,
  updateCreatorProductDetailsForCustomer,
  withdrawCreatorProductForCustomer,
} from "../app/services/creator-products.server.ts";
import * as creatorPublishing from "../app/services/creator-product-publishing.server.ts";
import * as creatorProductRoute from "../app/services/creator-product-action-core.server.ts";
import { clonePitchPrintProject } from "../app/services/pitchprint-clone.server.ts";
import {
  ensureCreatorCollectionRecord,
  getPublicCreatorCollection,
  syncCreatorCollectionStatus,
} from "../app/services/creator-collections.server.ts";
import { DomainError } from "../app/services/domain.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";
import {
  CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
  parseSurchargeInput,
} from "../app/services/production-method-pricing.server.ts";
import { completeCreatorFinalSubmission } from "../extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js";

const shop = "customhouse.test";
const { nonFixedColorVariantIds } = creatorPublishing;

test("PitchPrint project ownership accepts metadata or serialized authors and rejects conflicts", () => {
  assert.doesNotThrow(() =>
    assertPitchPrintProjectOwner(shop, "creator-a", {
      _author: `customhouse:${shop}:creator:creator-a`,
    }),
  );
  assert.doesNotThrow(() =>
    assertPitchPrintProjectOwner(shop, "creator-a", {
      author: `customhouse:${shop}:creator:creator-a`,
    }),
  );
  assert.doesNotThrow(() =>
    assertPitchPrintProjectOwner(shop, "creator-a", {
      _author: `customhouse:${shop}:creator:creator-a`,
      author: `customhouse:${shop}:creator:creator-a`,
    }),
  );
  for (const source of [
    { _author: `customhouse:${shop}:creator:creator-b` },
    { author: `customhouse:${shop}:creator:creator-b` },
    {
      _author: `customhouse:${shop}:creator:creator-a`,
      author: `customhouse:${shop}:creator:creator-b`,
    },
    {},
  ]) {
    assert.throws(
      () => assertPitchPrintProjectOwner(shop, "creator-a", source),
      (error) =>
        error instanceof DomainError &&
        error.code === "PITCHPRINT_PROJECT_OWNER_MISMATCH" &&
        error.status === 403,
    );
  }
});

function creatorCartContractApi() {
  const value = creatorPublishing as unknown as {
    creatorCartValidationContract?: (
      creatorProductId: string,
      setup: ReturnType<typeof JSON.parse>,
      pricing: Record<string, unknown>,
    ) => {
      version: number;
      creatorProductId: string;
      feeRequired: boolean;
      feeVariantId: string | null;
      placementCount: number;
    };
    nativeCreatorProductMetafields?: (input: Record<string, unknown>) => Array<{
      namespace: string;
      key: string;
      type: string;
      value: string;
    }>;
  };
  assert.equal(typeof value.creatorCartValidationContract, "function");
  assert.equal(typeof value.nativeCreatorProductMetafields, "function");
  return value as Required<typeof value>;
}

function createCreatorProductDraft(
  ...args: Parameters<typeof createCreatorProductDraftService>
) {
  const [shopKey, customerId, input, client, database] = args;
  return createCreatorProductDraftService(
    shopKey,
    customerId,
    {
      selectedProductionMethod: "DTF",
      ...input,
    },
    client,
    database,
  );
}

function prepareCreatorProductCart(
  ...args: Parameters<typeof prepareCreatorProductCartService>
) {
  const [shopKey, input, client, cloner, database] = args;
  return prepareCreatorProductCartService(
    shopKey,
    {
      nonReturnAcknowledged: true,
      termsAccepted: true,
      ...input,
    },
    client,
    cloner,
    database,
  );
}
const baseProduct = {
  id: "gid://shopify/Product/1001",
  title: "Global Hoodie",
  handle: "global-hoodie",
  origin: { value: "global" },
  mode: { value: "customizable" },
  pitchprintDesignId: { value: "pp_design_global_hoodie" },
  legacyPitchprintDesignId: null,
  featuredImage: {
    url: "https://cdn.shopify.test/hoodie.png",
  },
  variants: {
    nodes: [
      {
        id: "gid://shopify/ProductVariant/2001",
        legacyResourceId: "2001",
        title: "S / White",
        availableForSale: true,
        price: "299.00",
        selectedOptions: [
          { name: "Size", value: "S" },
          { name: "Color", value: "White" },
        ],
      },
      {
        id: "gid://shopify/ProductVariant/2002",
        legacyResourceId: "2002",
        title: "M / White",
        availableForSale: true,
        price: "349.00",
        selectedOptions: [
          { name: "Size", value: "M" },
          { name: "Color", value: "White" },
        ],
      },
    ],
  },
};

type FakeCreator = {
  id: string;
  shop: string;
  customerId: string;
  status: string;
  handle: string;
  displayName: string;
};

type FakeCollection = {
  id: string;
  shop: string;
  creatorId: string;
  publicId: string;
  publicHandle: string;
  displayName: string;
  status: "ACTIVE" | "HIDDEN" | "SUSPENDED";
  createdAt: Date;
  updatedAt: Date;
};

type FakeFindUniqueArgs = {
  where: {
    shop_customerId: {
      shop: string;
      customerId: string;
    };
  };
};

type FakeCreatorProductCreateArgs = {
  data: Partial<CreatorProductRecord> &
    Pick<
      CreatorProductRecord,
      "shop" | "creatorId" | "shopifyProductId" | "baseProductTitle" | "title"
    >;
};

type FakeCreatorProductWhereArgs = {
  where: {
    id?: string;
    shop: string;
    creatorId?: string;
    status?: string;
    publishedShopifyProductId?: string;
    pitchprintProjectId?: string;
  };
};

function fakeClient(product: Record<string, unknown> | null = baseProduct): ShopifyGraphqlClient {
  return {
    async request<T>() {
      return { shop: { currencyCode: "SEK" }, product } as T;
    },
  };
}

function pitchPrintPayload(input: {
  projectId: string;
  previewUrl?: string;
  previews?: string[];
  designId?: string;
  source?: unknown;
  numPages?: number;
  meta?: Record<string, unknown>;
}) {
  return {
    ...input,
    source:
      input.source ??
      {
        pages: [
          {
            name: "Front",
            objects: [{ type: "Textbox", text: "TEST" }],
          },
        ],
      },
    creatorSetup: {
      flowMode: "CREATOR_DESIGN",
      interactionMode: "CREATOR_DESIGN",
      productOrigin: "global",
      baseProductOrigin: "global",
      designMode: "creator_design",
      creatorContext: true,
      launchContext: "creator_dashboard",
      isCreatorProduct: true,
      selectedColor: "White",
      selectedColors: ["White"],
      fixedColor: "White",
      selectedProductionMethod: null,
      productionMethod: null,
      fixedProductionMethod: null,
      designedPlacementCount: 1,
      placements: [{ id: "front", label: "Front", hasArtwork: true }],
      copyrightAccepted: true,
      nonReturnAcknowledged: true,
    },
  };
}

function creatorSetupJson(
  color = "White",
  method = "EMBROIDERY",
  placementCount = 1,
  embroiderySubtype = method === "EMBROIDERY" ? "TEXT_ONLY" : undefined,
) {
  return JSON.stringify({
    schema: "creator_design_setup_v1",
    flowMode: "CREATOR_DESIGN",
    productOrigin: "global",
    baseProductOrigin: "global",
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    fixedColor: color,
    selectedColors: [color],
    productionMethod: method,
    ...(embroiderySubtype ? { embroiderySubtype } : {}),
    placementCount,
    placements: Array.from(
      { length: placementCount },
      (_, index) => `Placement ${index + 1}`,
    ),
    copyrightAccepted: true,
    nonReturnAcknowledged: true,
    savedAt: "2026-08-11T00:01:00.000Z",
  });
}

function fakePublicProductClient(productId = baseProduct.id): ShopifyGraphqlClient {
  return {
    async request<T>() {
      return {
        product: {
          id: productId,
          title: "Global Hoodie",
          handle: "global-hoodie",
          onlineStoreUrl: "https://customhouse.se/products/global-hoodie",
          options: [
            { name: "Size", values: ["S", "M"] },
            { name: "Color", values: ["White", "Navy"] },
          ],
          priceRangeV2: {
            minVariantPrice: { amount: "299.00", currencyCode: "SEK" },
            maxVariantPrice: { amount: "349.00", currencyCode: "SEK" },
          },
          variants: {
            nodes: [
              {
                id: "gid://shopify/ProductVariant/2001",
                legacyResourceId: "2001",
                title: "S / White",
                availableForSale: true,
                price: "299.00",
                selectedOptions: [
                  { name: "Size", value: "S" },
                  { name: "Color", value: "White" },
                ],
              },
              {
                id: "gid://shopify/ProductVariant/9999",
                legacyResourceId: "9999",
                title: "M / Navy",
                availableForSale: false,
                price: "349.00",
                selectedOptions: [
                  { name: "Size", value: "M" },
                  { name: "Color", value: "Navy" },
                ],
              },
            ],
          },
        },
      } as T;
    },
  };
}

function fakeDb() {
  const creators: FakeCreator[] = [
    {
      id: "creator-a",
      shop,
      customerId: "gid://shopify/Customer/1",
      status: "APPROVED",
      handle: "creator-a",
      displayName: "Creator A",
    },
    {
      id: "creator-b",
      shop,
      customerId: "gid://shopify/Customer/2",
      status: "APPROVED",
      handle: "creator-b",
      displayName: "Creator B",
    },
  ];
  const products: CreatorProductRecord[] = [];
  const collections: FakeCollection[] = creators.map((creator) => ({
    id: `collection-${creator.id}`,
    shop: creator.shop,
    creatorId: creator.id,
    publicId: `public-${creator.id}`,
    publicHandle: creator.handle,
    displayName: `${creator.displayName} Designs`,
    status: "ACTIVE",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
  }));
  return {
    creators,
    products,
    collections,
    creator: {
      async findUnique(args: FakeFindUniqueArgs) {
        const where = args.where.shop_customerId;
        const creator = creators.find(
          (creator) =>
            creator.shop === where.shop && creator.customerId === where.customerId,
        ) || null;
        if (!creator) return null;
        return {
          ...creator,
          marketplaceCollection:
            collections.find((collection) => collection.creatorId === creator.id) ||
            null,
        };
      },
      async findFirst(args: {
        where: { id?: string; shop: string; handle?: string; status?: string };
      }) {
        return creators.find(
          (creator) =>
            creator.shop === args.where.shop &&
            (!args.where.id || creator.id === args.where.id) &&
            (!args.where.handle || creator.handle === args.where.handle) &&
            (!args.where.status || creator.status === args.where.status),
        ) || null;
      },
    },
    creatorProduct: {
      async create(args: FakeCreatorProductCreateArgs) {
        const record: CreatorProductRecord = {
          id: `cmcreatorproduct${String(products.length + 1).padStart(10, "0")}`,
          shop: args.data.shop,
          creatorId: args.data.creatorId,
          shopifyProductId: args.data.shopifyProductId,
          shopifyProductHandle: args.data.shopifyProductHandle ?? null,
          baseProductTitle: args.data.baseProductTitle,
          pitchprintProjectId: args.data.pitchprintProjectId ?? null,
          pitchprintDesignId: args.data.pitchprintDesignId ?? null,
          title: args.data.title,
          description: args.data.description ?? null,
          previewUrl: args.data.previewUrl ?? null,
          previewUrls: args.data.previewUrls ?? "[]",
          baseProductVariantsJson: args.data.baseProductVariantsJson ?? "[]",
          designVariantSelectionsJson: args.data.designVariantSelectionsJson ?? "[]",
          status: args.data.status ?? "DRAFT",
          submittedAt: null,
          publishedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          creatorPricingMode: args.data.creatorPricingMode ?? null,
          creatorPricingPreviewJson: args.data.creatorPricingPreviewJson ?? "{}",
          createdAt: new Date("2026-08-11T00:00:00.000Z"),
          updatedAt: new Date("2026-08-11T00:00:00.000Z"),
        };
        products.push(record);
        return record;
      },
      async delete(args: { where: { id: string } }) {
        const index = products.findIndex((product) => product.id === args.where.id);
        assert.notEqual(index, -1);
        const [deleted] = products.splice(index, 1);
        return deleted;
      },
      async findMany(args: FakeCreatorProductWhereArgs) {
        return products.filter(
          (product) =>
            product.shop === args.where.shop &&
            (!args.where.creatorId || product.creatorId === args.where.creatorId) &&
            (!("status" in args.where) || product.status === args.where.status),
        );
      },
      async findFirst(args: FakeCreatorProductWhereArgs) {
        return products.find(
          (product) =>
            (!args.where.id || product.id === args.where.id) &&
            product.shop === args.where.shop &&
            (!args.where.creatorId || product.creatorId === args.where.creatorId) &&
            (!("status" in args.where) || product.status === args.where.status) &&
            (!args.where.pitchprintProjectId ||
              product.pitchprintProjectId === args.where.pitchprintProjectId) &&
            (!args.where.publishedShopifyProductId ||
              product.publishedShopifyProductId === args.where.publishedShopifyProductId),
        ) || null;
      },
      async update(args: { where: { id: string }; data: Partial<CreatorProductRecord> }) {
        const index = products.findIndex((product) => product.id === args.where.id);
        assert.notEqual(index, -1);
        products[index] = {
          ...products[index],
          ...args.data,
          updatedAt: new Date("2026-08-11T00:01:00.000Z"),
        };
        return products[index];
      },
    },
    creatorCollection: {
      async findUnique(args: { where: { creatorId?: string; id?: string } }) {
        return collections.find(
          (collection) =>
            (args.where.creatorId && collection.creatorId === args.where.creatorId) ||
            (args.where.id && collection.id === args.where.id),
        ) || null;
      },
      async findFirst(args: {
        where: {
          shop?: string;
          creatorId?: string;
          publicHandle?: string;
          status?: string;
          creator?: { status?: string };
        };
      }) {
        const collection = collections.find((collection) => {
          const creator = creators.find((item) => item.id === collection.creatorId);
          return (
            (!args.where.shop || collection.shop === args.where.shop) &&
            (!args.where.creatorId || collection.creatorId === args.where.creatorId) &&
            (!args.where.publicHandle ||
              collection.publicHandle === args.where.publicHandle) &&
            (!args.where.status || collection.status === args.where.status) &&
            (!args.where.creator?.status ||
              creator?.status === args.where.creator.status)
          );
        });
        if (!collection) return null;
        return {
          ...collection,
          creator: creators.find((creator) => creator.id === collection.creatorId)!,
        };
      },
      async create(args: { data: Partial<FakeCollection> & Pick<FakeCollection, "shop" | "creatorId" | "publicId" | "publicHandle" | "displayName" | "status"> }) {
        const record: FakeCollection = {
          id: `collection-${collections.length + 1}`,
          createdAt: new Date("2026-08-11T00:00:00.000Z"),
          updatedAt: new Date("2026-08-11T00:00:00.000Z"),
          ...args.data,
        };
        collections.push(record);
        return record;
      },
      async update(args: { where: { id: string }; data: Partial<FakeCollection> }) {
        const index = collections.findIndex(
          (collection) => collection.id === args.where.id,
        );
        assert.notEqual(index, -1);
        collections[index] = {
          ...collections[index],
          ...args.data,
          updatedAt: new Date("2026-08-11T00:02:00.000Z"),
        };
        return collections[index];
      },
    },
    auditLog: {
      async create() {
        return {};
      },
    },
    creatorSale: {
      async count(args?: { where?: { creatorProductId?: string } }) {
        return products.some(
          (product) =>
            product.id === args?.where?.creatorProductId &&
            (product as CreatorProductRecord & { __saleHistory?: boolean }).__saleHistory,
        )
          ? 1
          : 0;
      },
    },
    creatorOrderItem: {
      async count(args?: { where?: { creatorProductId?: string } }) {
        return products.some(
          (product) =>
            product.id === args?.where?.creatorProductId &&
            (product as CreatorProductRecord & { __orderHistory?: boolean }).__orderHistory,
        )
          ? 1
          : 0;
      },
    },
    productionMethodSetting: {
      async findMany() {
        return [
          { method: "EMBROIDERY", enabled: true },
          { method: "DTF", enabled: true },
          { method: "DTG", enabled: true },
        ];
      },
    },
    publicProductProductionPricing: {
      async findUnique(args?: unknown) {
        void args;
        return {
          id: "pricing-1",
          shopKey: shop,
          shopifyProductId: baseProduct.id,
          embroiderySurcharge: parseSurchargeInput("50.00"),
          embroideryTextSurcharge: parseSurchargeInput("50.00"),
          embroideryImageSurcharge: parseSurchargeInput("70.00"),
          dtfSurcharge: parseSurchargeInput("30.00"),
          dtgSurcharge: parseSurchargeInput("20.00"),
          embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
          embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
          embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
          dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
          dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
        };
      },
    },
  };
}

test("authenticated Creator A can create a DRAFT Creator Product", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Ari Hoodie" },
    fakeClient(),
    db,
  );

  assert.equal(product.status, "DRAFT");
  assert.equal(product.title, "Ari Hoodie");
  assert.equal(product.shopifyProductId, baseProduct.id);
  assert.equal(JSON.parse(product.designVariantSelectionsJson).fixedColor, "");
  assert.deepEqual(JSON.parse(product.designVariantSelectionsJson).selectedColors, []);
  assert.equal(JSON.parse(product.designVariantSelectionsJson).productionMethod, "DTF");
});

test("Creator Product draft creation uses the stable Shopify featuredImage field", async () => {
  const queries: string[] = [];
  const db = fakeDb();
  await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    {
      async request<T>(query: string) {
        queries.push(query);
        return { product: baseProduct } as T;
      },
    },
    db,
  );

  assert.match(queries[0] || "", /featuredImage\s*\{\s*url\s*\}/);
  assert.doesNotMatch(queries[0] || "", /featuredMedia\s*\{/);
});

test("creator owner comes from server-side customer authentication", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    {
      shopifyProductId: baseProduct.id,
      creatorId: "creator-b",
    } as { shopifyProductId: string; creatorId: string },
    fakeClient(),
    db,
  );

  assert.equal(product.creatorId, "creator-a");
});

test("Creator A can list their own products", async () => {
  const db = fakeDb();
  await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "One" },
    fakeClient(),
    db,
  );
  await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/2",
    { shopifyProductId: baseProduct.id, title: "Two" },
    fakeClient(),
    db,
  );

  const products = await listCreatorProductsForCustomer(
    shop,
    "gid://shopify/Customer/1",
    db,
  );

  assert.equal(products.length, 1);
  assert.equal(products[0].creatorId, "creator-a");
});

test("eligible Creator base products exclude app-managed production fee products", async () => {
  const db = fakeDb();
  const client: ShopifyGraphqlClient = {
    async request<T>() {
      return {
        products: {
          nodes: [
            {
              ...baseProduct,
              status: "ACTIVE",
              tags: ["pitchprint"],
              productType: { value: "global_customizable" },
              inkybayEnabled: null,
              pitchprintEnabled: { value: "true" },
              creatorPublishingEnabled: { value: "true" },
              legacyOrigin: null,
              legacyMode: null,
              productionMethodPricing: null,
            },
            {
              ...baseProduct,
              id: "gid://shopify/Product/9001",
              title: "Custom House Production Fee - 16472592548185",
              handle: "custom-house-production-fee-16472592548185",
              status: "ACTIVE",
              tags: ["customhouse-production-fee", "pitchprint"],
              productType: { value: "production_fee" },
              inkybayEnabled: null,
              pitchprintEnabled: null,
              creatorPublishingEnabled: null,
              legacyOrigin: null,
              legacyMode: null,
              pitchprintDesignId: null,
              legacyPitchprintDesignId: null,
              productionMethodPricing: null,
            },
          ],
        },
      } as T;
    },
  };

  const products = await listEligibleCreatorBaseProducts(
    shop,
    "gid://shopify/Customer/1",
    client,
    db,
  );

  assert.deepEqual(
    products.map((product) => product.title),
    ["Global Hoodie"],
  );
});

test("eligible Creator base products expose the configured PitchPrint launch template ID", async () => {
  const db = fakeDb();
  const products = await listEligibleCreatorBaseProducts(
    shop,
    "gid://shopify/Customer/1",
    {
      async request<T>() {
        return {
          products: {
            nodes: [
              {
                ...baseProduct,
                status: "ACTIVE",
                tags: ["pitchprint"],
                productType: { value: "global_customizable" },
                inkybayEnabled: null,
                pitchprintEnabled: { value: "true" },
                creatorPublishingEnabled: { value: "true" },
                legacyOrigin: null,
                legacyMode: null,
                productionMethodPricing: null,
              },
            ],
          },
        } as T;
      },
    },
    db,
  );

  assert.equal(products.length, 1);
  assert.equal(products[0].id, "gid://shopify/Product/1001");
  assert.equal(products[0].pitchprintDesignId, "pp_design_global_hoodie");
  assert.deepEqual(products[0].productionMethods, [
    { id: "EMBROIDERY", label: "Embroidery", maxWidthCm: 8, maxHeightCm: 8 },
    { id: "DTF", label: "DTF printing", maxWidthCm: 35, maxHeightCm: 40 },
    { id: "DTG", label: "DTG printing", maxWidthCm: 35, maxHeightCm: 40 },
  ]);
  const canonicalPricing = JSON.parse(products[0].productionMethodPricing || "null");
  assert.equal(canonicalPricing.version, 2);
  assert.deepEqual(
    canonicalPricing.productionMethods.map((method: { id: string }) => method.id),
    ["EMBROIDERY", "DTF", "DTG"],
  );
});

test("Creator Add Product fails closed when canonical product pricing is unavailable", async () => {
  const db = fakeDb();
  const { publicProductProductionPricing: _canonicalPricing, ...legacyOnlyDb } = db;
  void _canonicalPricing;
  const client: ShopifyGraphqlClient = {
    async request<T>() {
      return {
        products: {
          nodes: [
            {
              ...baseProduct,
              status: "ACTIVE",
              tags: ["pitchprint"],
              productType: { value: "global_customizable" },
              inkybayEnabled: null,
              pitchprintEnabled: { value: "true" },
              creatorPublishingEnabled: { value: "true" },
              legacyOrigin: null,
              legacyMode: null,
              productionMethodPricing: {
                value: JSON.stringify({
                  productionMethods: [{ id: "DTF", label: "DTF printing" }],
                }),
              },
            },
          ],
        },
      } as T;
    },
  };

  await assert.rejects(
    () =>
      listEligibleCreatorBaseProducts(
        shop,
        "gid://shopify/Customer/1",
        client,
        legacyOnlyDb as never,
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "PRODUCTION_PRICING_REQUIRED",
  );
});

test("new Creator drafts never accept the legacy shared method fallback", async () => {
  const db = fakeDb();
  const { publicProductProductionPricing: _canonicalPricing, ...legacyOnlyDb } = db;
  void _canonicalPricing;

  await assert.rejects(
    () =>
      createCreatorProductDraft(
        shop,
        "gid://shopify/Customer/1",
        {
          shopifyProductId: baseProduct.id,
          selectedProductionMethod: "DTF",
        },
        fakeClient({
          ...baseProduct,
          productionMethodPricing: {
            value: JSON.stringify({
              productionMethods: [{ id: "DTF", label: "DTF printing" }],
            }),
          },
        }),
        legacyOnlyDb as never,
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "PRODUCTION_PRICING_REQUIRED",
  );
  assert.equal(db.products.length, 0);
});

test("Creator base product method options fall back to canonical active settings when the legacy metafield is missing", () => {
  const enabled = [
    { id: "EMBROIDERY" as const, label: "Embroidery" },
    { id: "DTF" as const, label: "DTF printing" },
    { id: "DTG" as const, label: "DTG printing" },
  ];

  assert.deepEqual(productionMethodsForCreatorProduct(enabled, null), enabled);
  assert.deepEqual(
    productionMethodsForCreatorProduct(enabled, "{not-json"),
    enabled,
  );
});

test("Creator base product method options respect a valid product-specific subset without duplicates", () => {
  const enabled = [
    { id: "EMBROIDERY" as const, label: "Embroidery" },
    { id: "DTF" as const, label: "DTF printing" },
    { id: "DTG" as const, label: "DTG printing" },
  ];
  const pricing = JSON.stringify({
    productionMethods: [
      { id: "DTF", label: "Ignored browser label" },
      { method: "DTF" },
      { id: "UNKNOWN" },
    ],
  });

  assert.deepEqual(productionMethodsForCreatorProduct(enabled, pricing), [
    { id: "DTF", label: "DTF printing" },
  ]);
});

test("Creator draft creation rejects a method outside the product-specific active options", async () => {
  const db = fakeDb();
  const findPricing = db.publicProductProductionPricing.findUnique.bind(
    db.publicProductProductionPricing,
  );
  db.publicProductProductionPricing.findUnique = async (args: unknown) => ({
    ...(await findPricing(args)),
    methodConfigurations: {
      version: 2,
      methods: {
        DTF: { enabled: true, surcharge: "30.00", feeVariantId: null },
      },
    },
  });
  await assert.rejects(
    () =>
      createCreatorProductDraft(
        shop,
        "gid://shopify/Customer/1",
        {
          shopifyProductId: baseProduct.id,
          selectedProductionMethod: "EMBROIDERY",
        },
        fakeClient({
          ...baseProduct,
          productionMethodPricing: {
            value: JSON.stringify({
              productionMethods: [{ id: "DTF", label: "DTF printing" }],
            }),
          },
        }),
        db,
      ),
    /available printing method/i,
  );
  assert.equal(db.products.length, 0);
});

test("Creator B cannot retrieve Creator A's private product by changing the ID", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      getCreatorProductForCustomer(
        shop,
        "gid://shopify/Customer/2",
        product.id,
        db,
      ),
    /Creator Product not found/,
  );
});

test("invalid Shopify base product cannot silently create a broken Creator Product", async () => {
  const db = fakeDb();
  await assert.rejects(
    () =>
      createCreatorProductDraft(
        shop,
        "gid://shopify/Customer/1",
        { shopifyProductId: baseProduct.id },
        fakeClient(null),
        db,
      ),
    /Base product not found/,
  );
  assert.equal(db.products.length, 0);
});

test("conflicting creator-base products are rejected as base products", async () => {
  const db = fakeDb();
  await assert.rejects(
    () =>
      createCreatorProductDraft(
        shop,
        "gid://shopify/Customer/1",
        { shopifyProductId: baseProduct.id },
        fakeClient({
          ...baseProduct,
          origin: { value: "creator_base" },
        }),
        db,
      ),
    /Global Product/,
  );
  assert.equal(db.products.length, 0);
});

test("new Creator Product can exist before PitchPrint saves a project", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  assert.equal(product.pitchprintProjectId, null);
  assert.equal(product.pitchprintDesignId, "pp_design_global_hoodie");
});

test("Creator draft persists each selected printing method before PitchPrint launch", async () => {
  for (const productionMethod of ["EMBROIDERY", "DTF", "DTG"]) {
    const db = fakeDb();
    const product = await createCreatorProductDraft(
      shop,
      "gid://shopify/Customer/1",
      {
        shopifyProductId: baseProduct.id,
        selectedProductionMethod: productionMethod,
      },
      fakeClient(),
      db,
    );

    const setup = JSON.parse(product.designVariantSelectionsJson);
    assert.equal(setup.productionMethod, productionMethod);
    assert.equal(setup.fixedProductionMethod, productionMethod);
    assert.equal(product.pitchprintProjectId, null);
  }
});

test("Creator save accepts a canonical custom method code longer than forty characters", async () => {
  const customMethod = "ULTRA_LONG_CUSTOM_PRODUCTION_METHOD_FOR_CREATOR_FLOW";
  assert.ok(customMethod.length > 40);
  const db = fakeDb();
  db.productionMethodSetting.findMany = async () => [
    { method: "EMBROIDERY", enabled: true },
    { method: "DTF", enabled: true },
    { method: "DTG", enabled: true },
    {
      method: customMethod,
      label: "Long custom method",
      description: "",
      enabled: true,
      pricingBehavior: "SINGLE",
      configurationJson: {},
    },
  ];
  const findPricing = db.publicProductProductionPricing.findUnique.bind(
    db.publicProductProductionPricing,
  );
  db.publicProductProductionPricing.findUnique = async (args?: unknown) => ({
    ...(await findPricing(args)),
    methodConfigurations: {
      version: 2,
      methods: {
        [customMethod]: {
          enabled: true,
          surcharge: "25.00",
          feeVariantId: "gid://shopify/ProductVariant/9090",
        },
      },
    },
  });
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    {
      shopifyProductId: baseProduct.id,
      selectedProductionMethod: customMethod,
    },
    fakeClient(),
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({
      projectId: "pp_long_custom_method",
      previewUrl: "https://cdn.pitchprint.test/long-custom-method.png",
    }),
    db,
  );

  assert.equal(
    JSON.parse(updated.designVariantSelectionsJson).productionMethod,
    customMethod,
  );
});

test("base product without PitchPrint design ID cannot create a broken Creator Product", async () => {
  const db = fakeDb();
  await assert.rejects(
    () =>
      createCreatorProductDraft(
        shop,
        "gid://shopify/Customer/1",
        { shopifyProductId: baseProduct.id },
        fakeClient({
          ...baseProduct,
          pitchprintDesignId: null,
          legacyPitchprintDesignId: null,
        }),
        db,
      ),
    /missing a PitchPrint design ID/,
  );
  assert.equal(db.products.length, 0);
});

test("authenticated Creator A can attach a PitchPrint project to their own Draft", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({
      projectId: "pp_project_123",
      previews: ["https://cdn.pitchprint.test/preview-1.png"],
    }),
    db,
  );

  assert.equal(updated.pitchprintProjectId, "pp_project_123");
  assert.equal(updated.pitchprintDesignId, "pp_design_global_hoodie");
  assert.equal(updated.previewUrl, "https://cdn.pitchprint.test/preview-1.png");
  assert.equal(updated.status, "DRAFT");
  const savedSetup = JSON.parse(updated.designVariantSelectionsJson);
  const pricingPreview = JSON.parse(updated.creatorPricingPreviewJson || "{}");
  assert.equal(pricingPreview.pricingMode, "BAKED_IN_V1");
  assert.equal(pricingPreview.productionCostMinor, "3000");
  assert.deepEqual(
    pricingPreview.variants.map(
      (variant: { size: string; basePrice: string; finalPrice: string }) => ({
        size: variant.size,
        basePrice: variant.basePrice,
        finalPrice: variant.finalPrice,
      }),
    ),
    [
      { size: "S", basePrice: "299.00", finalPrice: "329.00" },
      { size: "M", basePrice: "349.00", finalPrice: "379.00" },
    ],
  );
  assert.deepEqual(savedSetup, {
    schema: "creator_design_setup_v1",
    flowMode: "CREATOR_DESIGN",
    interactionMode: "CREATOR_DESIGN",
    productOrigin: "global",
    baseProductOrigin: "global",
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    fixedColor: "White",
    selectedColors: ["White"],
    productionMethod: "DTF",
    placementCount: 1,
    placements: ["Front"],
    previewSurfaces: [
      {
        side: "Front",
        url: "https://cdn.pitchprint.test/preview-1.png",
        hasArtwork: true,
      },
    ],
    artworkObjectCounts: { text: 1, image: 0 },
    copyrightAccepted: true,
    nonReturnAcknowledged: true,
    savedAt: savedSetup.savedAt,
  });
});

test("authenticated creator can persist an owned PitchPrint draft session without completing submission data", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  const originalSetup = draft.designVariantSelectionsJson;

  const updated = await savePitchPrintDraftSessionForCustomer(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      projectId: "pp_draft_session_123",
      designId: "pp_design_global_hoodie",
    },
    database,
    async (projectId) => {
      assert.equal(projectId, "pp_draft_session_123");
      return {
        _id: "pp_draft_session_123",
        _author: `customhouse:${shop}:creator:creator-a`,
        designId: "pp_design_global_hoodie",
        pages: [{ id: "front", items: [] }],
      };
    },
  );

  assert.equal(updated.pitchprintProjectId, "pp_draft_session_123");
  assert.equal(updated.pitchprintDesignId, "pp_design_global_hoodie");
  assert.equal(updated.status, "DRAFT");
  assert.equal(updated.previewUrl, draft.previewUrl);
  assert.equal(updated.designVariantSelectionsJson, originalSetup);
});

test("PitchPrint draft-session persistence revalidates repeated saves for the current project ID", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  database.products[0].pitchprintProjectId = "pp_existing_draft";
  let fetchCalls = 0;
  let updateCalls = 0;
  const originalUpdate = database.creatorProduct.update;
  database.creatorProduct.update = async (args) => {
    updateCalls += 1;
    return originalUpdate(args);
  };

  const updated = await savePitchPrintDraftSessionForCustomer(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    { projectId: "pp_existing_draft" },
    database,
    async () => {
      fetchCalls += 1;
      return {
        _id: "pp_existing_draft",
        _author: `customhouse:${shop}:creator:creator-a`,
        designId: "pp_design_global_hoodie",
        pages: [
          { id: "front", items: [{ type: "text" }, { type: "image" }] },
        ],
      };
    },
  );

  assert.equal(updated.pitchprintProjectId, "pp_existing_draft");
  assert.equal(fetchCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(updated.status, "DRAFT");
});

test("PitchPrint draft sessions keep projects isolated between Creator drafts", async () => {
  const database = fakeDb();
  const firstDraft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  const secondDraft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  database.products[0].pitchprintProjectId = "pp_first_draft";

  await assert.rejects(
    () =>
      savePitchPrintDraftSessionForCustomer(
        shop,
        "gid://shopify/Customer/1",
        secondDraft.id,
        { projectId: "pp_first_draft" },
        database,
        async () => ({
          _author: `customhouse:${shop}:creator:creator-a`,
          designId: "pp_design_global_hoodie",
          pages: [{ id: "front" }],
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "PITCHPRINT_PROJECT_ALREADY_ATTACHED" &&
      error.status === 409,
  );
  assert.equal(firstDraft.pitchprintProjectId, "pp_first_draft");
  assert.equal(secondDraft.pitchprintProjectId, null);
});

test("PitchPrint draft sessions reject another creator's project and mismatched designs", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );

  await assert.rejects(
    () =>
      savePitchPrintDraftSessionForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { projectId: "pp_other_creator" },
        database,
        async () => ({
          _author: `customhouse:${shop}:creator:creator-b`,
          designId: "pp_design_global_hoodie",
          pages: [{ id: "front" }],
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "PITCHPRINT_PROJECT_OWNER_MISMATCH" &&
      error.status === 403,
  );

  await assert.rejects(
    () =>
      savePitchPrintDraftSessionForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { projectId: "pp_wrong_design" },
        database,
        async () => ({
          _author: `customhouse:${shop}:creator:creator-a`,
          designId: "different_design",
          pages: [{ id: "front" }],
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "PITCHPRINT_DESIGN_MISMATCH" &&
      error.status === 409,
  );
  assert.equal(database.products[0].pitchprintProjectId, null);
});

test("PitchPrint draft sessions reject non-editable Creator Product lifecycles", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  database.products[0].status = "PENDING";
  let fetchCalls = 0;

  await assert.rejects(
    () =>
      savePitchPrintDraftSessionForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { projectId: "pp_pending_product" },
        database,
        async () => {
          fetchCalls += 1;
          return {};
        },
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "CREATOR_PRODUCT_NOT_EDITABLE" &&
      error.status === 409,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(database.products[0].pitchprintProjectId, null);
  assert.equal(database.products[0].status, "PENDING");
});

test("creator product action routes draft-session saves separately from completed design saves", async () => {
  const routeAction = creatorProductRoute.creatorProductActionCore;
  let draftSessionCalls = 0;
  let completedSaveCalls = 0;
  const response = await routeAction(
    {
      params: { id: "creator-product-1" },
      request: new Request(`https://${shop}/apps/customhouse/api/creator-products/creator-product-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-draft-session",
          projectId: "pp_draft_session_456",
          designId: "pp_design_global_hoodie",
        }),
      }),
    },
    {
      ...creatorProductRoute.creatorProductActionServices,
      proxyContext: async () => ({
        shop,
        customerId: "gid://shopify/Customer/1",
        client: fakeClient(),
      }),
      enforceRateLimit: () => undefined,
      jsonBody: (request: Request) => request.json(),
      apiData: (data: unknown) => Response.json({ ok: true, data }),
      apiError: (error: unknown) => Response.json({ ok: false, error }, { status: 500 }),
      savePitchPrintDraftSessionForCustomer: async (_shop, _customerId, creatorProductId, input) => {
        draftSessionCalls += 1;
        assert.equal(creatorProductId, "creator-product-1");
        assert.equal(input.projectId, "pp_draft_session_456");
        return { id: creatorProductId } as CreatorProductRecord;
      },
      attachPitchPrintProjectToCreatorProduct: async () => {
        completedSaveCalls += 1;
        throw new Error("completed save should not run");
      },
      logCreatorSave: () => undefined,
    },
  );

  assert.equal(response.status, 200);
  assert.equal(draftSessionCalls, 1);
  assert.equal(completedSaveCalls, 0);
});

test("creator product route saves nested Navy when empty legacy outer aliases are present", async () => {
  const database = fakeDb();
  const navyBaseProduct = {
    ...baseProduct,
    variants: {
      nodes: [
        ...baseProduct.variants.nodes,
        {
          id: "gid://shopify/ProductVariant/2003",
          legacyResourceId: "2003",
          title: "S / Navy",
          availableForSale: true,
          price: "309.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Navy" },
          ],
        },
      ],
    },
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    {
      shopifyProductId: baseProduct.id,
      selectedProductionMethod: "EMBROIDERY",
    },
    fakeClient(navyBaseProduct),
    database,
  );
  const liveBody = {
    ...pitchPrintPayload({
      projectId: "pp-live-navy-route",
      previews: ["https://cdn.pitchprint.test/live-navy-front.png"],
      source: {
        pages: [
          {
            name: "Front",
            objects: [{ type: "Textbox", text: "Live QA Navy" }],
          },
        ],
      },
    }),
    selectedColor: "",
    selectedColors: [],
    fixedColor: "",
    creatorSetup: {
      flowMode: "CREATOR_DESIGN",
      interactionMode: "CREATOR_DESIGN",
      productOrigin: "global",
      baseProductOrigin: "global",
      designMode: "creator_design",
      creatorContext: true,
      launchContext: "creator_dashboard",
      isCreatorProduct: true,
      creatorProductId: draft.id,
      selectedColor: "Navy",
      selectedColors: ["Navy"],
      colorValues: ["White", "Navy"],
      productColors: ["White", "Navy"],
      fixedColor: "Navy",
      previewColor: "Navy",
      productionMethod: "EMBROIDERY",
      fixedProductionMethod: "EMBROIDERY",
      selectedProductionMethod: "EMBROIDERY",
      artworkObjects: [{ type: "Textbox", text: "Live QA Navy" }],
      designedPlacementCount: 1,
      placements: [{ id: "front", label: "Front", hasArtwork: true }],
      copyrightAccepted: true,
      nonReturnAcknowledged: true,
    },
  };
  const routeAction = (
    creatorProductRoute as unknown as {
      creatorProductActionCore?: (
        args: { params: { id: string }; request: Request },
        dependencies: Record<string, unknown>,
      ) => Promise<Response>;
    }
  ).creatorProductActionCore;
  assert.equal(typeof routeAction, "function");
  if (typeof routeAction !== "function") return;

  const diagnostics: Array<Record<string, unknown>> = [];
  const response = await routeAction(
    {
      params: { id: draft.id },
      request: new Request(`https://${shop}/apps/customhouse/api/creator-products/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(liveBody),
      }),
    },
    {
      ...creatorProductRoute.creatorProductActionServices,
      proxyContext: async () => ({
        shop,
        customerId: "gid://shopify/Customer/1",
        client: fakeClient(navyBaseProduct),
      }),
      enforceRateLimit: () => undefined,
      jsonBody: (request: Request) => request.json(),
      apiData: (data: unknown) => Response.json({ ok: true, data }),
      apiError: (error: unknown) =>
        Response.json(
          {
            ok: false,
            error: {
              code:
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "UNKNOWN",
            },
          },
          {
            status:
              error && typeof error === "object" && "status" in error
                ? Number(error.status)
                : 500,
          },
        ),
      attachPitchPrintProjectToCreatorProduct: (
        shopKey: string,
        customerId: string,
        creatorProductId: string,
        input: Parameters<typeof attachPitchPrintProjectToCreatorProduct>[3],
      ) =>
        attachPitchPrintProjectToCreatorProduct(
          shopKey,
          customerId,
          creatorProductId,
          input,
          database,
        ),
      logCreatorSave: (entry: Record<string, unknown>) => diagnostics.push(entry),
    },
  );

  const responseBody = await response.json();
  assert.equal(response.status, 200, JSON.stringify(responseBody));
  const savedSetup = JSON.parse(responseBody.data.product.designVariantSelectionsJson);
  assert.equal(savedSetup.fixedColor, "Navy");
  assert.deepEqual(savedSetup.selectedColors, ["Navy"]);
  assert.equal(savedSetup.productionMethod, "EMBROIDERY");
  assert.equal(savedSetup.embroiderySubtype, "TEXT_ONLY");
  const submitted = await submitCreatorProductForReview(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    database,
  );
  assert.equal(submitted.status, "PENDING");
  const publishSetup = creatorProductSetupFromRecord(submitted);
  assert.equal(publishSetup?.fixedColor, "Navy");
  assert.deepEqual(publishSetup?.selectedColors, ["Navy"]);
  assert.equal(database.products.length, 1);
  assert.deepEqual(diagnostics, [
    {
      event: "creator_product_save_color_resolution",
      stage: "request",
      creatorProductId: draft.id,
      outerColorCount: 0,
      nestedColorCount: 1,
      hasProjectId: true,
      hasPreview: true,
    },
    {
      event: "creator_product_save_color_resolution",
      stage: "success",
      creatorProductId: draft.id,
      outerColorCount: 0,
      nestedColorCount: 1,
      hasProjectId: true,
      hasPreview: true,
    },
  ]);
});

test("Creator Product stores current Shopify size variants from the base product", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  const variants = JSON.parse(draft.baseProductVariantsJson);

  assert.deepEqual(
    variants.map((variant: { variantId: string; size: string }) => ({
      variantId: variant.variantId,
      size: variant.size,
    })),
    [
      { variantId: "2001", size: "S" },
      { variantId: "2002", size: "M" },
    ],
  );
});

test("PitchPrint Creator save preserves the fixed color and production method", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_creator_setup",
        previewUrl: "https://cdn.pitchprint.test/setup.png",
      }),
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.flowMode, "CREATOR_DESIGN");
  assert.equal(setup.interactionMode, "CREATOR_DESIGN");
  assert.equal(setup.productOrigin, "global");
  assert.equal(setup.baseProductOrigin, "global");
  assert.equal(setup.creatorContext, true);
  assert.equal(setup.launchContext, "creator_dashboard");
  assert.equal(setup.fixedColor, "White");
  assert.deepEqual(setup.selectedColors, ["White"]);
  assert.equal(setup.productionMethod, "DTF");
  assert.equal(setup.placementCount, 1);
});

test("a legacy draft without a persisted method cannot accept one from the PitchPrint handoff", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "DTF" },
    fakeClient(),
    db,
  );
  draft.designVariantSelectionsJson = JSON.stringify({
    schema: "creator_design_setup_v1",
    fixedColor: "",
  });

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({ projectId: "pp_legacy_missing_method" }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_legacy_missing_method" })
              .creatorSetup,
            productionMethod: "DTF",
            fixedProductionMethod: "DTF",
          },
        },
        db,
      ),
    /Printing method is missing\. Please return to Add Product and start a new design\./,
  );
});

test("editing a Creator design persists the customizer's updated valid color while keeping its method fixed", async () => {
  const db = fakeDb();
  const productWithGreen = {
    ...baseProduct,
    variants: {
      nodes: [
        ...baseProduct.variants.nodes,
        {
          id: "gid://shopify/ProductVariant/2003",
          legacyResourceId: "2003",
          title: "S / Green",
          availableForSale: true,
          price: "309.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Green" },
          ],
        },
      ],
    },
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(productWithGreen),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_project_white",
        previewUrl: "https://cdn.pitchprint.test/white-front.png",
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_project_white" }).creatorSetup,
        selectedColor: "White",
        selectedColors: ["White"],
        fixedColor: "White",
      },
    },
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_project_green",
        previewUrl: "https://cdn.pitchprint.test/green-front.png",
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_project_green" }).creatorSetup,
        selectedColor: "Green",
        selectedColors: ["Green"],
        fixedColor: "Green",
      },
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(updated.pitchprintProjectId, "pp_project_green");
  assert.equal(updated.previewUrl, "https://cdn.pitchprint.test/green-front.png");
  assert.equal(setup.fixedColor, "Green");
  assert.deepEqual(setup.selectedColors, ["Green"]);
  assert.equal(setup.productionMethod, "EMBROIDERY");
});

test("Creator save rejects a rendered preview color that differs from the active PitchPrint color", async () => {
  const db = fakeDb();
  const productWithGreen = {
    ...baseProduct,
    variants: {
      nodes: [
        ...baseProduct.variants.nodes,
        {
          id: "gid://shopify/ProductVariant/2003",
          legacyResourceId: "2003",
          title: "S / Green",
          availableForSale: true,
          price: "309.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Green" },
          ],
        },
      ],
    },
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(productWithGreen),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_color_mismatch",
            previews: ["https://cdn.pitchprint.test/navy-front.png"],
          }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_color_mismatch" }).creatorSetup,
            activeColor: "Green",
            selectedColor: "Green",
            selectedColors: ["Green"],
            fixedColor: "Green",
            previewColor: "Navy",
          },
        },
        db,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "DomainError" &&
      /preview color does not match/i.test(error.message),
  );
  assert.equal(draft.pitchprintProjectId, null);
});

test("Creator save persists one matching active and preview color", async () => {
  const db = fakeDb();
  const productWithGreen = {
    ...baseProduct,
    variants: {
      nodes: [
        ...baseProduct.variants.nodes,
        {
          id: "gid://shopify/ProductVariant/2003",
          legacyResourceId: "2003",
          title: "S / Green",
          availableForSale: true,
          price: "309.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Green" },
          ],
        },
      ],
    },
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(productWithGreen),
    db,
  );
  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_color_green",
        previews: ["https://cdn.pitchprint.test/green-front.png"],
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_color_green" }).creatorSetup,
        activeColor: "Green",
        selectedColor: "Green",
        selectedColors: ["Green"],
        fixedColor: "Green",
        previewColor: "Green",
      },
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.fixedColor, "Green");
  assert.equal(setup.previewColor, "Green");
  assert.equal(setup.previewSurfaces[0].color, "Green");
});

test("Creator save canonicalizes duplicate PitchPrint color aliases after the handoff", async () => {
  const db = fakeDb();
  const productWithNavy = {
    ...baseProduct,
    variants: {
      nodes: [
        ...baseProduct.variants.nodes,
        {
          id: "gid://shopify/ProductVariant/2003",
          legacyResourceId: "2003",
          title: "S / Navy",
          availableForSale: true,
          price: "309.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Navy" },
          ],
        },
      ],
    },
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(productWithNavy),
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_color_navy",
        previews: ["https://cdn.pitchprint.test/navy-front.png"],
      }),
      selectedColor: "Navy",
      selectedColorDetail: { name: "Navy", value: "Navy", key: "navy" },
      selectedColors: ["Navy", "navy", "NAVY"],
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_color_navy" }).creatorSetup,
        selectedColor: "Gray",
        selectedColors: ["Gray"],
        fixedColor: "Gray",
        previewColor: "Navy",
      },
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.fixedColor, "Navy");
  assert.deepEqual(setup.selectedColors, ["Navy"]);
  assert.equal(setup.previewColor, "Navy");
});

test("Embroidery text-only source overrides a claimed image subtype", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_text_only",
        previews: ["https://cdn.pitchprint.test/text-front.png"],
        source: {
          pages: [
            {
              name: "Front",
              objects: [{ type: "Textbox", text: "HELLO", printable: true }],
            },
          ],
        },
        numPages: 1,
        meta: { pageNames: ["Front"] },
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_text_only" }).creatorSetup,
        embroiderySubtype: "IMAGE_OR_LOGO",
      },
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.embroiderySubtype, "TEXT_ONLY");
  assert.deepEqual(setup.artworkObjectCounts, { text: 1, image: 0 });
  assert.equal(setup.placementCount, 1);
  assert.deepEqual(setup.placements, ["Front"]);
});

test("Embroidery image and mixed sources cannot claim the cheaper text subtype", async () => {
  for (const [projectId, objects] of [
    [
      "pp_image_only",
      [
        { type: "Rect" },
        { type: "Image", src: "https://assets.pitchprint.test/logo.png" },
      ],
    ],
    [
      "pp_text_image",
      [
        { type: "Textbox", text: "HELLO" },
        { type: "SVGImage", src: "https://assets.pitchprint.test/logo.svg" },
      ],
    ],
  ] as const) {
    const db = fakeDb();
    const draft = await createCreatorProductDraft(
      shop,
      "gid://shopify/Customer/1",
      { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
      fakeClient(),
      db,
    );
    const updated = await attachPitchPrintProjectToCreatorProduct(
      shop,
      "gid://shopify/Customer/1",
      draft.id,
      {
        ...pitchPrintPayload({
          projectId,
          previews: [`https://cdn.pitchprint.test/${projectId}.png`],
          source: { pages: [{ name: "Front", objects }] },
          numPages: 1,
        }),
        creatorSetup: {
          ...pitchPrintPayload({ projectId }).creatorSetup,
          embroiderySubtype: "TEXT_ONLY",
        },
      },
      db,
    );

    const setup = JSON.parse(updated.designVariantSelectionsJson);
    assert.equal(setup.embroiderySubtype, "IMAGE_OR_LOGO");
    assert.equal(setup.artworkObjectCounts.image, 1);
  }
});

test("PitchPrint serialized pages ignore canvas primitives and retain uploaded artwork", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );
  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_serialized_image",
        previews: ["https://cdn.pitchprint.test/front.png"],
        source: {
          pages: [
            {
              pageData: { title: "Front" },
              items: [
                { type: "Rect", selectable: false, evented: false },
                {
                  type: "Image",
                  src: "https://assets.pitchprint.test/upload.png",
                  selectable: true,
                  evented: true,
                },
              ],
            },
          ],
        },
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_serialized_image" }).creatorSetup,
        embroiderySubtype: "IMAGE_OR_LOGO",
      },
    },
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.embroiderySubtype, "IMAGE_OR_LOGO");
  assert.deepEqual(setup.artworkObjectCounts, { text: 0, image: 1 });
  assert.deepEqual(setup.placements, ["Front"]);
});

test("fixed PitchPrint contract saves canonical subtype and side previews without legacy source", async () => {
  for (const [incomingSubtype, expectedSubtype] of [
    ["TEXT_ONLY", "TEXT_ONLY"],
    ["IMAGE_OR_LOGO", "IMAGE_OR_LOGO"],
    ["IMAGE_LOGO", "IMAGE_OR_LOGO"],
  ] as const) {
    const db = fakeDb();
    const draft = await createCreatorProductDraft(
      shop,
      "gid://shopify/Customer/1",
      { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
      fakeClient(),
      db,
    );
    const updated = await attachPitchPrintProjectToCreatorProduct(
      shop,
      "gid://shopify/Customer/1",
      draft.id,
      {
        projectId: `pp_canonical_${expectedSubtype.toLowerCase()}`,
        creatorProductId: draft.id,
        previews: [
          "https://cdn.pitchprint.test/front.png",
          "https://cdn.pitchprint.test/back.png",
        ],
        sidePreviews: [
          { side: "Front", url: "https://cdn.pitchprint.test/front.png", hasArtwork: true },
          { side: "Back", url: "https://cdn.pitchprint.test/back.png", hasArtwork: true },
        ],
        creatorSetup: {
          flowMode: "CREATOR_DESIGN",
          creatorProductId: draft.id,
          selectedColor: "White",
          selectedProductionMethod: "EMBROIDERY",
          artworkType: incomingSubtype,
          embroiderySubtype: incomingSubtype,
          placementCount: 2,
          placements: ["Front", "Back"],
          artworkSummary:
            expectedSubtype === "TEXT_ONLY"
              ? { text: 1, image: 0 }
              : { text: 0, image: 1 },
          copyrightAccepted: true,
        },
      },
      db,
    );

    const setup = JSON.parse(updated.designVariantSelectionsJson);
    assert.equal(setup.embroiderySubtype, expectedSubtype);
    assert.equal(setup.placementCount, 2);
    assert.deepEqual(setup.placements, ["Front", "Back"]);
    assert.deepEqual(setup.previewSurfaces, [
      {
        side: "Front",
        url: "https://cdn.pitchprint.test/front.png",
        hasArtwork: true,
      },
      {
        side: "Back",
        url: "https://cdn.pitchprint.test/back.png",
        hasArtwork: true,
      },
    ]);
  }
});

test("fixed PitchPrint contract rejects a different CreatorProduct identity", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_wrong_creator_product",
            previews: ["https://cdn.pitchprint.test/front.png"],
          }),
          creatorProductId: "another-creator-product",
        },
        db,
      ),
    /different Creator Product/i,
  );
  assert.equal(draft.pitchprintProjectId, null);
});

test("saved source derives distinct Front and Back placement previews", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );
  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({
      projectId: "pp_front_back_source",
      previews: [
        "https://cdn.pitchprint.test/front-render.png",
        "https://cdn.pitchprint.test/back-render.png",
      ],
      source: {
        pages: [
          { name: "Front", objects: [{ type: "Textbox", text: "FRONT" }] },
          { name: "Back", objects: [{ type: "Textbox", text: "BACK" }] },
        ],
      },
      numPages: 2,
      meta: { pageNames: ["Front", "Back"] },
    }),
    db,
  );

  const setup = JSON.parse(updated.designVariantSelectionsJson);
  assert.equal(setup.placementCount, 2);
  assert.deepEqual(setup.placements, ["Front", "Back"]);
  assert.deepEqual(setup.previewSurfaces, [
    {
      side: "Front",
      url: "https://cdn.pitchprint.test/front-render.png",
      hasArtwork: true,
    },
    {
      side: "Back",
      url: "https://cdn.pitchprint.test/back-render.png",
      hasArtwork: true,
    },
  ]);
});

test("Embroidery save rejects missing or unsupported saved object metadata", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        pitchPrintPayload({
          projectId: "pp_unknown_objects",
          previews: ["https://cdn.pitchprint.test/unknown.png"],
          source: { pages: [{ name: "Front", objects: [{ type: "MysteryObject" }] }] },
        }),
        db,
      ),
    /artwork type.*could not be determined/i,
  );
});

test("PitchPrint save requires exactly one selected Creator color", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_multi_color",
            previewUrl: "https://cdn.pitchprint.test/empty.png",
          }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_multi_color" }).creatorSetup,
            selectedColors: ["White", "Navy"],
          },
        },
        db,
      ),
    /exactly one product color/i,
  );
});

test("PitchPrint re-save rejects a missing handoff color instead of keeping the stale fixed color", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    db,
  );
  draft.designVariantSelectionsJson = creatorSetupJson("White", "EMBROIDERY");

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          projectId: "pp_missing_color",
          previews: ["https://cdn.pitchprint.test/missing-color.png"],
          source: {
            pages: [
              {
                name: "Front",
                objects: [{ type: "Textbox", text: "TEST" }],
              },
            ],
          },
          creatorSetup: {
            flowMode: "CREATOR_DESIGN",
            copyrightAccepted: true,
          },
        },
        db,
      ),
    /exactly one product color/i,
  );
});

test("PitchPrint save rejects colors outside the base product", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_bad_color",
            previewUrl: "https://cdn.pitchprint.test/bad.png",
          }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_bad_color" }).creatorSetup,
            selectedColor: "Navy",
            selectedColors: ["Navy"],
            fixedColor: "Navy",
          },
        },
        db,
      ),
    /color that exists on the base product/i,
  );
});

test("PitchPrint save rejects customer order quantities in Creator design setup", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_order_quantity",
            previewUrl: "https://cdn.pitchprint.test/order-quantity.png",
          }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_order_quantity" }).creatorSetup,
            variantSelections: [{ variantId: "2001", size: "S", quantity: 2 }],
          },
        },
        db,
      ),
    /size and quantity only when a customer buys/,
  );
});

test("PitchPrint save counts only designed Creator placements", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  const frontOnly = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_front_only",
        previewUrl: "https://cdn.pitchprint.test/front-only.png",
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_front_only" }).creatorSetup,
        placements: [
          { id: "front", label: "Front", hasArtwork: true },
          { id: "back", label: "Back", hasArtwork: false },
        ],
      },
    },
    db,
  );

  assert.equal(JSON.parse(frontOnly.designVariantSelectionsJson).placementCount, 1);

  const frontAndBack = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_front_back",
        previewUrl: "https://cdn.pitchprint.test/front-back.png",
        source: {
          pages: [
            {
              name: "Front",
              objects: [{ type: "Textbox", text: "FRONT" }],
            },
            {
              name: "Back",
              objects: [{ type: "Textbox", text: "BACK" }],
            },
          ],
        },
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_front_back" }).creatorSetup,
        placements: [
          { id: "front", label: "Front", hasArtwork: true },
          { id: "back", label: "Back", hasArtwork: true },
        ],
      },
    },
    db,
  );

  const setup = JSON.parse(frontAndBack.designVariantSelectionsJson);
  assert.equal(setup.placementCount, 2);
  assert.deepEqual(setup.placements, ["Front", "Back"]);
});

test("PitchPrint save does not treat preview files as artwork placement evidence", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  const creatorSetup: Record<string, unknown> = {
    ...pitchPrintPayload({ projectId: "pp_preview_only" }).creatorSetup,
  };
  delete creatorSetup.designedPlacementCount;
  delete creatorSetup.placements;

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          projectId: "pp_preview_only",
          previews: [{ url: "https://cdn.pitchprint.test/front-render.png" }],
          creatorSetup,
        },
        db,
      ),
    /saved artwork type could not be determined/i,
  );
});

test("PitchPrint save still rejects without placement or saved preview evidence", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  const creatorSetup: Record<string, unknown> = {
    ...pitchPrintPayload({ projectId: "pp_no_artwork_evidence" }).creatorSetup,
  };
  delete creatorSetup.designedPlacementCount;
  delete creatorSetup.placements;

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          projectId: "pp_no_artwork_evidence",
          creatorSetup,
        },
        db,
      ),
    /saved artwork type could not be determined/i,
  );
});

test("PitchPrint save requires Creator copyright confirmation", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        {
          ...pitchPrintPayload({
            projectId: "pp_no_rights",
            previewUrl: "https://cdn.pitchprint.test/no-rights.png",
          }),
          creatorSetup: {
            ...pitchPrintPayload({ projectId: "pp_no_rights" }).creatorSetup,
            copyrightAccepted: false,
            copyrightConfirmed: false,
            rightsConfirmed: false,
            creatorCopyrightAccepted: false,
          },
        },
        db,
      ),
    /rights to use this design/,
  );
});

test("Creator B cannot attach PitchPrint project data to Creator A's Draft", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/2",
        draft.id,
        pitchPrintPayload({ projectId: "pp_project_456" }),
        db,
      ),
    /Creator Product not found/,
  );
  assert.equal(draft.pitchprintProjectId, null);
});

test("second PitchPrint save updates the same CreatorProduct", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_project_123", previewUrl: "https://cdn.pitchprint.test/a.png" }),
    db,
  );
  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_project_123", previewUrl: "https://cdn.pitchprint.test/b.png" }),
    db,
  );

  assert.equal(db.products.length, 1);
  assert.equal(updated.id, draft.id);
  assert.equal(updated.previewUrl, "https://cdn.pitchprint.test/b.png");
});

test("two different CreatorProducts can each store independent PitchPrint projects", async () => {
  const db = fakeDb();
  const first = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "First" },
    fakeClient(),
    db,
  );
  const second = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Second" },
    fakeClient(),
    db,
  );

  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    first.id,
    pitchPrintPayload({ projectId: "pp_first", previewUrl: "https://cdn.pitchprint.test/first.png" }),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    second.id,
    pitchPrintPayload({ projectId: "pp_second", previewUrl: "https://cdn.pitchprint.test/second.png" }),
    db,
  );

  assert.equal(db.products.length, 2);
  assert.equal(db.products[0].pitchprintProjectId, "pp_first");
  assert.equal(db.products[1].pitchprintProjectId, "pp_second");
});

test("creator can submit own complete DRAFT and it becomes PENDING", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_submit", previewUrl: "https://cdn.pitchprint.test/submit.png" }),
    db,
  );

  const submitted = await submitCreatorProductForReview(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    db,
  );

  assert.equal(submitted.status, "PENDING");
  assert.ok(submitted.submittedAt);
});

test("dashboard final submit calls the authenticated action, updates DB, and reloads My Products as PENDING", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    database,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({
      projectId: "pp_submit_action",
      previewUrl: "https://cdn.pitchprint.test/submit-action.png",
    }),
    database,
  );

  const result = await completeCreatorFinalSubmission({
    creatorProductId: draft.id,
    savePayload: { projectId: "pp_submit_action" },
    saveProject: async (creatorProductId, savePayload) => {
      assert.equal(creatorProductId, draft.id);
      assert.equal(savePayload.projectId, "pp_submit_action");
      return database.products[0];
    },
    submitProduct: async (creatorProductId) => {
      const response = await creatorProductRoute.creatorProductActionCore(
        {
          params: { id: creatorProductId },
          request: new Request(
            `https://${shop}/apps/customhouse/api/creator-products/${creatorProductId}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ intent: "submit" }),
            },
          ),
        },
        {
          ...creatorProductRoute.creatorProductActionServices,
          proxyContext: async () => ({
            shop,
            customerId: "gid://shopify/Customer/1",
            client: fakeClient(),
          }),
          enforceRateLimit: () => undefined,
          jsonBody: (request: Request) => request.json(),
          apiData: (data: unknown) => Response.json({ ok: true, data }),
          apiError: (error: unknown) =>
            Response.json({ ok: false, error }, { status: 500 }),
          submitCreatorProductForReview: (
            actionShop,
            customerId,
            submittedProductId,
          ) => submitCreatorProductForReview(
            actionShop,
            customerId,
            submittedProductId,
            database,
          ),
          logCreatorSave: () => undefined,
        },
      );
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        ok: boolean;
        data: { product: CreatorProductRecord };
      };
      assert.equal(payload.ok, true);
      return payload.data.product;
    },
    reloadProduct: async (creatorProductId) => {
      const product = await getCreatorProductForCustomer(
        shop,
        "gid://shopify/Customer/1",
        creatorProductId,
        database,
      );
      return { product, products: [product] };
    },
  });

  assert.equal(result.saved.pitchprintProjectId, "pp_submit_action");
  assert.equal(result.submitted.status, "PENDING");
  assert.equal(result.product.status, "PENDING");
  assert.equal(result.products[0].status, "PENDING");
  assert.equal(result.refreshConfirmed, true);
  assert.equal(database.products[0].status, "PENDING");
});

test("creator cannot submit another creator's DRAFT", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await assert.rejects(
    () =>
      submitCreatorProductForReview(
        shop,
        "gid://shopify/Customer/2",
        draft.id,
        db,
      ),
    /Creator Product not found/,
  );
});

test("draft without PitchPrint project cannot submit", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await assert.rejects(
    () =>
      submitCreatorProductForReview(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        db,
      ),
    /Save your PitchPrint design/,
  );
});

test("saved design without a rendered preview is rejected recoverably", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient({
      ...baseProduct,
      featuredImage: null,
    }),
    db,
  );
  await assert.rejects(
    () =>
      attachPitchPrintProjectToCreatorProduct(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        pitchPrintPayload({ projectId: "pp_no_preview" }),
        db,
      ),
    /return to the editor and save the design again/i,
  );
  assert.equal(draft.pitchprintProjectId, null);
});

test("creator cannot directly publish through owner update paths", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, status: "PUBLISHED" } as {
      shopifyProductId: string;
      status: string;
    },
    fakeClient(),
    db,
  );

  assert.equal(draft.status, "DRAFT");
});

test("creator cannot approve own CreatorProduct through admin service", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await assert.rejects(
    () =>
      moderateCreatorProductAsAdmin(
        shop,
        "gid://shopify/Customer/1",
        { creatorProductId: draft.id, decision: "PUBLISHED" },
        db,
      ),
    /Only pending Creator Products/,
  );
});

test("admin can approve PENDING product and populate publishedAt", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_approve", previewUrl: "https://cdn.pitchprint.test/approve.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  const saleCountBefore = await db.creatorSale.count();

  const approved = await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "PUBLISHED" },
    db,
  );

  assert.equal(approved.status, "PUBLISHED");
  assert.ok(approved.publishedAt);
  assert.equal(db.products.length, 1);
  assert.equal(await db.creatorSale.count(), saleCountBefore);
});

test("admin can reject PENDING product only with stored reason", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_reject", previewUrl: "https://cdn.pitchprint.test/reject.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await assert.rejects(
    () =>
      moderateCreatorProductAsAdmin(
        shop,
        "admin",
        { creatorProductId: draft.id, decision: "REJECTED" },
        db,
      ),
    /rejection reason/,
  );

  const rejected = await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    {
      creatorProductId: draft.id,
      decision: "REJECTED",
      rejectionReason: "Test rejection - please update design",
    },
    db,
  );

  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.id, draft.id);
  assert.equal(rejected.rejectionReason, "Test rejection - please update design");
  assert.ok(rejected.rejectedAt);
});

test("owner can edit and resubmit same rejected CreatorProduct", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_rejected", previewUrl: "https://cdn.pitchprint.test/rejected.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "REJECTED", rejectionReason: "Update it" },
    db,
  );
  const edited = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_rejected", previewUrl: "https://cdn.pitchprint.test/edited.png" }),
    db,
  );
  const resubmitted = await submitCreatorProductForReview(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    db,
  );

  assert.equal(edited.id, draft.id);
  assert.equal(resubmitted.id, draft.id);
  assert.equal(resubmitted.status, "PENDING");
  assert.equal(resubmitted.rejectionReason, null);
  assert.equal(db.products.length, 1);
});

test("creator can update own draft details with trimmed title and description", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Original" },
    fakeClient(),
    db,
  );

  const updated = await updateCreatorProductDetailsForCustomer(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    { title: "  Weekend Skiing  ", description: "  Premium hoodie design.  " },
    db,
  );

  assert.equal(updated.title, "Weekend Skiing");
  assert.equal(updated.description, "Premium hoodie design.");
  assert.equal(updated.status, "DRAFT");
});

test("creator product detail validation rejects blank or excessive metadata", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      updateCreatorProductDetailsForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { title: "   ", description: "" },
        db,
      ),
    /Enter a design title/,
  );
  await assert.rejects(
    () =>
      updateCreatorProductDetailsForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { title: "x".repeat(121), description: "" },
        db,
      ),
    /120 characters/,
  );
  await assert.rejects(
    () =>
      updateCreatorProductDetailsForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { title: "Valid", description: "x".repeat(1001) },
        db,
      ),
    /1000 characters/,
  );
});

test("creator cannot update another creator product or pending details", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Owner A" },
    fakeClient(),
    db,
  );

  await assert.rejects(
    () =>
      updateCreatorProductDetailsForCustomer(
        shop,
        "gid://shopify/Customer/2",
        draft.id,
        { title: "Hijack", description: "" },
        db,
      ),
    /Creator Product not found/,
  );

  draft.status = "PENDING";
  await assert.rejects(
    () =>
      updateCreatorProductDetailsForCustomer(
        shop,
        "gid://shopify/Customer/1",
        draft.id,
        { title: "Locked", description: "" },
        db,
      ),
    /locked while this design is under review/,
  );
});

test("published metadata edit preserves status artwork project and public detail", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Old Title" },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000011";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_project_keep";
  draft.pitchprintDesignId = "pp_design_keep";

  const updated = await updateCreatorProductDetailsForCustomer(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    { title: "New Public Title", description: "New public description." },
    db,
  );
  const publicProduct = await publicCreatorProductDetail(
    shop,
    "creator-a",
    draft.id,
    fakePublicProductClient(),
    db,
  );

  assert.equal(updated.status, "PUBLISHED");
  assert.equal(updated.pitchprintProjectId, "pp_project_keep");
  assert.equal(updated.pitchprintDesignId, "pp_design_keep");
  assert.equal(publicProduct.title, "New Public Title");
  assert.equal(publicProduct.description, "New public description.");
});

test("published material PitchPrint edit returns CreatorProduct to review before public exposure", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Published Design" },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000019";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_project_live";
  draft.pitchprintDesignId = "pp_design_live";
  draft.designVariantSelectionsJson = creatorSetupJson();
  draft.publishedAt = new Date("2026-08-12T00:00:00.000Z");

  const updated = await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    {
      ...pitchPrintPayload({
        projectId: "pp_project_material_edit",
        previewUrl: "https://cdn.pitchprint.test/material-edit.png",
      }),
      creatorSetup: {
        ...pitchPrintPayload({ projectId: "pp_project_material_edit" }).creatorSetup,
        selectedProductionMethod: "EMBROIDERY",
        productionMethod: "EMBROIDERY",
        fixedProductionMethod: "EMBROIDERY",
      },
    },
    db,
  );

  assert.equal(updated.status, "PENDING");
  assert.equal(updated.pitchprintProjectId, "pp_project_material_edit");
  assert.equal(JSON.parse(updated.designVariantSelectionsJson).productionMethod, "EMBROIDERY");
  assert.ok(updated.submittedAt);
  await assert.rejects(
    () =>
      publicCreatorProductDetail(
        shop,
        "creator-a",
        draft.id,
        fakePublicProductClient(),
        db,
      ),
    /Creator Product not found/,
  );
});

test("draft rejected and archived products without history can be deleted by owner only", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Delete me" },
    fakeClient(),
    db,
  );
  const rejected = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Reject delete" },
    fakeClient(),
    db,
  );
  rejected.status = "REJECTED";
  const archived = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Archived delete" },
    fakeClient(),
    db,
  );
  archived.status = "ARCHIVED";

  await assert.rejects(
    () => deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/2", draft.id, db),
    /Creator Product not found/,
  );
  await deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", draft.id, db);
  await deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", rejected.id, db);
  await deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", archived.id, db);

  assert.equal(db.products.some((product) => product.id === draft.id), false);
  assert.equal(db.products.some((product) => product.id === rejected.id), false);
  assert.equal(db.products.some((product) => product.id === archived.id), false);
});

test("published and history-linked products cannot be hard deleted", async () => {
  const db = fakeDb();
  const published = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Published" },
    fakeClient(),
    db,
  );
  published.status = "PUBLISHED";
  const historical = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "History" },
    fakeClient(),
    db,
  ) as CreatorProductRecord & { __saleHistory?: boolean; __orderHistory?: boolean };
  historical.__saleHistory = true;
  historical.__orderHistory = true;

  await assert.rejects(
    () => deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", published.id, db),
    /archived instead of deleted/,
  );
  await assert.rejects(
    () => deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", historical.id, db),
    /cannot be permanently deleted/,
  );
  assert.equal(db.products.includes(published), true);
  assert.equal(db.products.includes(historical), true);
});

test("pending product withdraws to draft before deletion", async () => {
  const db = fakeDb();
  const pending = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Pending" },
    fakeClient(),
    db,
  );
  pending.status = "PENDING";

  await assert.rejects(
    () => deleteCreatorProductForCustomer(shop, "gid://shopify/Customer/1", pending.id, db),
    /Withdraw this design/,
  );
  const withdrawn = await withdrawCreatorProductForCustomer(
    shop,
    "gid://shopify/Customer/1",
    pending.id,
    db,
  );
  assert.equal(withdrawn.status, "DRAFT");
});

test("admin cleanup archives safely and blocks hard deletion when history exists", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Admin cleanup" },
    fakeClient(),
    db,
  ) as CreatorProductRecord & { __saleHistory?: boolean; __orderHistory?: boolean };
  product.__saleHistory = true;
  product.__orderHistory = true;

  const archived = await cleanupCreatorProductAsAdmin(shop, "admin-1", product.id, "ARCHIVE", db);
  assert.equal(archived.product.status, "ARCHIVED");
  assert.equal(archived.hardDeleted, false);
  assert.equal(archived.hasHistory, true);
  await assert.rejects(
    () => cleanupCreatorProductAsAdmin(shop, "admin-1", product.id, "DELETE", db),
    /must be archived instead of deleted/,
  );
});

test("admin cleanup archives and deletes only the exact canonical Creator Shopify product", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Canonical cleanup" },
    fakeClient(),
    db,
  );
  product.status = "PUBLISHED";
  product.publishedShopifyProductId = "gid://shopify/Product/909";
  const mutations: string[] = [];
  const client = {
    async request(query: string) {
      if (query.includes("CreatorProductCleanupTarget")) {
        return {
          product: {
            id: product.publishedShopifyProductId,
            status: "ACTIVE",
            productOrigin: { value: "creator" },
            productType: { value: "creator_fixed" },
            creatorProductId: { value: product.id },
          },
        };
      }
      if (query.includes("ArchiveCreatorProductCleanup")) {
        assert.doesNotMatch(query, /userErrors\s*\{\s*code/);
        assert.match(query, /userErrors\s*\{\s*field\s+message\s*\}/);
        mutations.push("archive");
        return {
          productUpdate: {
            product: { id: product.publishedShopifyProductId, status: "ARCHIVED" },
            userErrors: [],
          },
        };
      }
      if (query.includes("DeleteCreatorProductCleanup")) {
        assert.doesNotMatch(query, /userErrors\s*\{\s*code/);
        assert.match(query, /userErrors\s*\{\s*field\s+message\s*\}/);
        mutations.push("delete");
        return {
          productDelete: {
            deletedProductId: product.publishedShopifyProductId,
            userErrors: [],
          },
        };
      }
      throw new Error("Unexpected cleanup operation");
    },
  };

  const archived = await cleanupCreatorProductAsAdmin(
    shop,
    "admin-1",
    product.id,
    "ARCHIVE",
    client as never,
    db,
  );
  assert.equal(archived.product.status, "ARCHIVED");
  const deleted = await cleanupCreatorProductAsAdmin(
    shop,
    "admin-1",
    product.id,
    "DELETE",
    client as never,
    db,
  );
  assert.equal(deleted.hardDeleted, true);
  assert.deepEqual(mutations, ["archive", "delete"]);
  assert.equal(db.products.includes(product), false);
});

test("admin cleanup never mutates a global base Shopify product", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Global protection" },
    fakeClient(),
    db,
  );
  product.status = "PUBLISHED";
  product.publishedShopifyProductId = product.shopifyProductId;
  let requests = 0;
  const client = {
    async request() {
      requests += 1;
      return {};
    },
  };
  await assert.rejects(
    cleanupCreatorProductAsAdmin(
      shop,
      "admin-1",
      product.id,
      "ARCHIVE",
      client as never,
      db,
    ),
    /global\/base product/i,
  );
  assert.equal(requests, 0);
  assert.equal(product.status, "PUBLISHED");
});

test("archive removes published product from public collection detail and cart while preserving rows", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Archive me" },
    fakeClient(),
    db,
  ) as CreatorProductRecord & { __saleHistory?: boolean; __orderHistory?: boolean };
  product.id = "cmcreatorproduct00000012";
  product.status = "PUBLISHED";
  product.pitchprintProjectId = "pp_project_archive";
  product.__saleHistory = true;
  product.__orderHistory = true;

  const archived = await archiveCreatorProductForCustomer(
    shop,
    "gid://shopify/Customer/1",
    product.id,
    db,
  );
  const collection = await listPublishedCreatorProductsForHandle(shop, "creator-a", db);

  assert.equal(archived.status, "ARCHIVED");
  assert.equal(collection.products.some((item) => item.id === product.id), false);
  await assert.rejects(
    () => publicCreatorProductDetail(shop, "creator-a", product.id, fakePublicProductClient(), db),
    /Creator Product not found/,
  );
  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: product.id,
          selectedVariantId: "gid://shopify/ProductVariant/2001",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    /Creator Product not found/,
  );
  assert.equal(db.products.some((item) => item.id === product.id), true);
  assert.equal(await db.creatorSale.count({ where: { creatorProductId: product.id } }), 1);
  assert.equal(await db.creatorOrderItem.count({ where: { creatorProductId: product.id } }), 1);
});

test("archived product restores to draft without republishing", async () => {
  const db = fakeDb();
  const product = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "Restore me" },
    fakeClient(),
    db,
  );
  product.status = "ARCHIVED";

  const restored = await restoreCreatorProductToDraftForCustomer(
    shop,
    "gid://shopify/Customer/1",
    product.id,
    db,
  );

  assert.equal(restored.status, "DRAFT");
  assert.equal(restored.publishedAt, null);
});

test("public collection returns PUBLISHED only for target creator", async () => {
  const db = fakeDb();
  const statuses = ["DRAFT", "PENDING", "REJECTED", "ARCHIVED", "PUBLISHED"];
  for (const status of statuses) {
    const product = await createCreatorProductDraft(
      shop,
      "gid://shopify/Customer/1",
      { shopifyProductId: baseProduct.id, title: status },
      fakeClient(),
      db,
    );
    product.status = status;
  }
  const creatorB = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/2",
    { shopifyProductId: baseProduct.id, title: "Creator B Published" },
    fakeClient(),
    db,
  );
  creatorB.status = "PUBLISHED";

  const result = await listPublishedCreatorProductsForHandle(
    shop,
    "creator-a",
    db,
  );

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].title, "PUBLISHED");
  assert.equal(result.products[0].creatorId, "creator-a");
});

test("same-name creators receive separate public collections and products never mix", async () => {
  const db = fakeDb();
  db.creators.push(
    {
      id: "creator-same-a",
      shop,
      customerId: "gid://shopify/Customer/10",
      status: "APPROVED",
      handle: "test-same-name-a",
      displayName: "Test Same Name",
    },
    {
      id: "creator-same-b",
      shop,
      customerId: "gid://shopify/Customer/11",
      status: "APPROVED",
      handle: "test-same-name-b",
      displayName: "Test Same Name",
    },
  );

  const before = db.collections.length;
  const collectionA = await ensureCreatorCollectionRecord(
    shop,
    "creator-same-a",
    db,
  );
  const collectionB = await ensureCreatorCollectionRecord(
    shop,
    "creator-same-b",
    db,
  );
  const retryA = await ensureCreatorCollectionRecord(
    shop,
    "creator-same-a",
    db,
  );

  assert.equal(db.collections.length, before + 2);
  assert.equal(collectionA.creatorId, "creator-same-a");
  assert.equal(collectionB.creatorId, "creator-same-b");
  assert.equal(collectionA.displayName, "Test Same Name Designs");
  assert.equal(collectionB.displayName, "Test Same Name Designs");
  assert.match(collectionA.publicHandle, /^test-same-name-[a-z0-9]{5}$/);
  assert.match(collectionB.publicHandle, /^test-same-name-[a-z0-9]{5}$/);
  assert.notEqual(collectionA.id, collectionB.id);
  assert.notEqual(collectionA.publicHandle, collectionB.publicHandle);
  assert.equal(retryA.id, collectionA.id);

  const productA = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/10",
    { shopifyProductId: baseProduct.id, title: "A Product" },
    fakeClient(),
    db,
  );
  const productB = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/11",
    { shopifyProductId: baseProduct.id, title: "B Product" },
    fakeClient(),
    db,
  );
  productA.id = "cmcreatorproduct00000010";
  productB.id = "cmcreatorproduct00000011";
  productA.status = "PUBLISHED";
  productB.status = "PUBLISHED";

  const publicA = await listPublishedCreatorProductsForHandle(
    shop,
    collectionA.publicHandle,
    db,
  );
  const publicB = await listPublishedCreatorProductsForHandle(
    shop,
    collectionB.publicHandle,
    db,
  );

  assert.deepEqual(publicA.products.map((product) => product.id), [productA.id]);
  assert.deepEqual(publicB.products.map((product) => product.id), [productB.id]);
  await assert.rejects(
    () =>
      getPublishedCreatorProductForHandle(
        shop,
        collectionA.publicHandle,
        productB.id,
        undefined,
        db,
      ),
    /Creator Product not found/,
  );
});

test("public creator handles use display-name slug plus stable unique suffix", async () => {
  const db = fakeDb();
  db.creators.push(
    {
      id: "creator-handle-name-a",
      shop,
      customerId: "gid://shopify/Customer/20",
      status: "APPROVED",
      handle: "internal-a",
      displayName: "José García",
    },
    {
      id: "creator-handle-name-b",
      shop,
      customerId: "gid://shopify/Customer/21",
      status: "APPROVED",
      handle: "internal-b",
      displayName: "বাংলা name",
    },
    {
      id: "creator-handle-name-c",
      shop,
      customerId: "gid://shopify/Customer/22",
      status: "APPROVED",
      handle: "internal-c",
      displayName: "বাংলা",
    },
  );

  const named = await ensureCreatorCollectionRecord(
    shop,
    "creator-handle-name-a",
    db,
  );
  const fallback = await ensureCreatorCollectionRecord(
    shop,
    "creator-handle-name-b",
    db,
  );
  const namedRetry = await ensureCreatorCollectionRecord(
    shop,
    "creator-handle-name-a",
    db,
  );
  const nonLatinFallback = await ensureCreatorCollectionRecord(
    shop,
    "creator-handle-name-c",
    db,
  );

  assert.equal(named.displayName, "José García Designs");
  assert.match(named.publicHandle, /^jose-garcia-[a-z0-9]{5}$/);
  assert.equal(namedRetry.publicHandle, named.publicHandle);
  assert.equal(fallback.displayName, "বাংলা name Designs");
  assert.match(fallback.publicHandle, /^name-[a-z0-9]{5}$/);
  assert.equal(nonLatinFallback.displayName, "বাংলা Designs");
  assert.match(nonLatinFallback.publicHandle, /^creator-[a-z0-9]{5}$/);
});

test("name change keeps publicHandle stable and updates display name only", async () => {
  const db = fakeDb();
  db.creators.push({
    id: "creator-name-change",
    shop,
    customerId: "gid://shopify/Customer/12",
    status: "APPROVED",
    handle: "alice-smith",
    displayName: "Alice Smith",
  });
  const collection = await ensureCreatorCollectionRecord(
    shop,
    "creator-name-change",
    db,
  );
  const handle = collection.publicHandle;

  db.creators.find((creator) => creator.id === "creator-name-change")!.displayName =
    "Alice Johnson";
  const updated = await ensureCreatorCollectionRecord(
    shop,
    "creator-name-change",
    db,
  );

  assert.equal(updated.id, collection.id);
  assert.equal(updated.publicHandle, handle);
  assert.equal(updated.displayName, "Alice Johnson Designs");
});

test("suspended creator collection becomes non-public and reapproval reuses it", async () => {
  const db = fakeDb();
  const creator = db.creators.find((item) => item.id === "creator-a")!;
  const collection = await ensureCreatorCollectionRecord(shop, creator.id, db);
  creator.status = "SUSPENDED";
  const suspended = await syncCreatorCollectionStatus(shop, creator.id, db);

  assert.equal(suspended?.id, collection.id);
  assert.equal(suspended?.status, "SUSPENDED");
  await assert.rejects(
    () => getPublicCreatorCollection(shop, collection.publicHandle, db),
    /Creator collection not found/,
  );

  creator.status = "APPROVED";
  const reapproved = await syncCreatorCollectionStatus(shop, creator.id, db);
  assert.equal(reapproved?.id, collection.id);
  assert.equal(reapproved?.status, "ACTIVE");
});

test("public detail never returns unpublished CreatorProducts", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  await assert.rejects(
    () => getPublishedCreatorProduct(shop, draft.id, db),
    /Creator Product not found/,
  );
  draft.status = "PUBLISHED";
  assert.equal((await getPublishedCreatorProduct(shop, draft.id, db)).id, draft.id);
});

test("two Creator Products can reference the same Shopify base product", async () => {
  const db = fakeDb();
  const first = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, title: "First" },
    fakeClient(),
    db,
  );
  const second = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/2",
    { shopifyProductId: baseProduct.id, title: "Second" },
    fakeClient(),
    db,
  );

  assert.equal(first.shopifyProductId, second.shopifyProductId);
  assert.equal(db.products.length, 2);
});

test("creator product foundation does not move commission data into CreatorProduct", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const creatorProductBlock = schema.match(/model CreatorProduct \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(schema, /model CreatorSale \{/);
  assert.match(schema, /model CreatorSaleAdjustment \{/);
  assert.doesNotMatch(creatorProductBlock, /commission|earning|payout/i);
});

test("admin creator products list avoids PitchPrint variant selection columns", () => {
  const route = readFileSync("app/routes/app.creator-products.tsx", "utf8");
  const service = readFileSync("app/services/creator-products.server.ts", "utf8");
  const adminList =
    service.match(/export async function listCreatorProductsForAdmin[\s\S]*?export async function moderateCreatorProductAsAdmin/)?.[0] || "";

  assert.match(adminList, /select: \{/);
  assert.doesNotMatch(adminList, /baseProductVariantsJson/);
  assert.doesNotMatch(adminList, /designVariantSelectionsJson/);
  assert.doesNotMatch(route, /Sizes \/ Amount/);
  assert.doesNotMatch(route, /variantSelections/);
});

test("PitchPrint clone credentials stay in server-only code", () => {
  const cloneService = readFileSync(
    "app/services/pitchprint-clone.server.ts",
    "utf8",
  );
  const dashboardJs = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const dashboardBlock = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );

  assert.match(cloneService, /PITCHPRINT_SECRET_KEY|PITCHPRINT_API_SECRET/);
  assert.doesNotMatch(dashboardJs, /PITCHPRINT_SECRET_KEY|PITCHPRINT_API_SECRET/);
  assert.doesNotMatch(dashboardBlock, /PITCHPRINT_SECRET_KEY|PITCHPRINT_API_SECRET/);
});

test("PitchPrint clone service requires server-only configuration", async () => {
  const previousEndpoint = process.env.PITCHPRINT_CLONE_ENDPOINT;
  const previousApiKey = process.env.PITCHPRINT_API_KEY;
  const previousSecret = process.env.PITCHPRINT_SECRET_KEY;
  delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  delete process.env.PITCHPRINT_API_KEY;
  delete process.env.PITCHPRINT_SECRET_KEY;
  await assert.rejects(
    () => clonePitchPrintProject("pp_master"),
    /clone credentials configured server-side/,
  );
  if (previousEndpoint === undefined) delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  else process.env.PITCHPRINT_CLONE_ENDPOINT = previousEndpoint;
  if (previousApiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
  else process.env.PITCHPRINT_API_KEY = previousApiKey;
  if (previousSecret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
  else process.env.PITCHPRINT_SECRET_KEY = previousSecret;
});

test("PitchPrint clone service returns an order-specific project", async () => {
  const previousEndpoint = process.env.PITCHPRINT_CLONE_ENDPOINT;
  const previousApiKey = process.env.PITCHPRINT_API_KEY;
  const previousSecret = process.env.PITCHPRINT_SECRET_KEY;
  process.env.PITCHPRINT_CLONE_ENDPOINT = "https://pitchprint.test/clone";
  process.env.PITCHPRINT_API_KEY = "domain-api-key";
  process.env.PITCHPRINT_SECRET_KEY = "server-secret";
  const cloned = await clonePitchPrintProject("pp_master", async (_url, init) => {
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.apiKey, "domain-api-key");
    assert.equal(body.projectId, "pp_master");
    assert.match(body.signature, /^[a-f0-9]{32}$/);
    assert.equal(typeof body.timestamp, "number");
    assert.equal(JSON.stringify(body).includes("server-secret"), false);
    return Response.json({ newId: "pp_order_1" });
  });
  assert.equal(cloned, "pp_order_1");
  assert.notEqual(cloned, "pp_master");
  if (previousEndpoint === undefined) delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  else process.env.PITCHPRINT_CLONE_ENDPOINT = previousEndpoint;
  if (previousApiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
  else process.env.PITCHPRINT_API_KEY = previousApiKey;
  if (previousSecret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
  else process.env.PITCHPRINT_SECRET_KEY = previousSecret;
});

test("PitchPrint clone service wraps fetch failures without exposing raw network errors", async () => {
  const previousEndpoint = process.env.PITCHPRINT_CLONE_ENDPOINT;
  const previousApiKey = process.env.PITCHPRINT_API_KEY;
  const previousSecret = process.env.PITCHPRINT_SECRET_KEY;
  process.env.PITCHPRINT_CLONE_ENDPOINT = "https://pitchprint.test/clone";
  process.env.PITCHPRINT_API_KEY = "domain-api-key";
  process.env.PITCHPRINT_SECRET_KEY = "server-secret";

  await assert.rejects(
    () =>
      clonePitchPrintProject("pp_master", async (_url, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        throw new TypeError("fetch failed");
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "PITCHPRINT_CLONE_FAILED" &&
      error.status === 502,
  );

  if (previousEndpoint === undefined) delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  else process.env.PITCHPRINT_CLONE_ENDPOINT = previousEndpoint;
  if (previousApiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
  else process.env.PITCHPRINT_API_KEY = previousApiKey;
  if (previousSecret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
  else process.env.PITCHPRINT_SECRET_KEY = previousSecret;
});
test("PitchPrint clone service uses the official runtime endpoint by default", async () => {
  const previousEndpoint = process.env.PITCHPRINT_CLONE_ENDPOINT;
  const previousApiKey = process.env.PITCHPRINT_API_KEY;
  const previousSecret = process.env.PITCHPRINT_SECRET_KEY;
  delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  process.env.PITCHPRINT_API_KEY = "domain-api-key";
  process.env.PITCHPRINT_SECRET_KEY = "server-secret";
  await clonePitchPrintProject("pp_master", async (url) => {
    assert.equal(
      String(url),
      "https://api.pitchprint.io/runtime/clone-project",
    );
    return Response.json({ newId: "pp_order_2" });
  });
  if (previousEndpoint === undefined) delete process.env.PITCHPRINT_CLONE_ENDPOINT;
  else process.env.PITCHPRINT_CLONE_ENDPOINT = previousEndpoint;
  if (previousApiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
  else process.env.PITCHPRINT_API_KEY = previousApiKey;
  if (previousSecret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
  else process.env.PITCHPRINT_SECRET_KEY = previousSecret;
});

test("published CreatorProduct public detail includes Shopify variants", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000001";
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_master", previewUrl: "https://cdn.pitchprint.test/master.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "PUBLISHED" },
    db,
  );

  const product = await publicCreatorProductDetail(
    shop,
    "creator-a",
    draft.id,
    fakePublicProductClient(),
    db,
  );

  assert.equal(product.id, draft.id);
  assert.equal(product.baseProduct?.variants[0]?.id, "gid://shopify/ProductVariant/2001");
  assert.equal(product.baseProduct?.variants[0]?.graphqlId, "gid://shopify/ProductVariant/2001");
  assert.equal(product.baseProduct?.variants[0]?.cartId, "2001");
  assert.equal(product.baseProduct?.variants[0]?.numericId, "2001");
});

test("baked Creator product detail reads final prices from the published Shopify product", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
    fakeClient(),
    database,
  );
  draft.id = "cmcreatorproduct00000032";
  draft.status = "PUBLISHED";
  draft.creatorPricingMode = "BAKED_IN_V1";
  draft.publishedShopifyProductId = "gid://shopify/Product/5003";
  draft.baseVariantMappingJson = JSON.stringify({
    "gid://shopify/ProductVariant/6003": "gid://shopify/ProductVariant/2001",
  });

  const requestedProductIds: string[] = [];
  const client: ShopifyGraphqlClient = {
    async request<T>(_query: string, variables?: Record<string, unknown>) {
      requestedProductIds.push(String(variables?.id || ""));
      return {
        product: {
          id: "gid://shopify/Product/5003",
          title: "Creator Hoodie",
          handle: "creator-hoodie",
          onlineStoreUrl: "https://customhouse.se/products/creator-hoodie",
          options: [
            { name: "Size", values: ["S"] },
            { name: "Color", values: ["White"] },
          ],
          priceRangeV2: {
            minVariantPrice: { amount: "599.00", currencyCode: "SEK" },
            maxVariantPrice: { amount: "599.00", currencyCode: "SEK" },
          },
          variants: {
            nodes: [
              {
                id: "gid://shopify/ProductVariant/6003",
                legacyResourceId: "6003",
                title: "S / White",
                availableForSale: true,
                price: "599.00",
                selectedOptions: [
                  { name: "Size", value: "S" },
                  { name: "Color", value: "White" },
                ],
              },
            ],
          },
        },
      } as T;
    },
  };

  const product = await publicCreatorProductDetail(
    shop,
    "creator-a",
    draft.id,
    client,
    database,
  );

  assert.deepEqual(requestedProductIds, ["gid://shopify/Product/5003"]);
  assert.equal(product.baseProduct?.id, "gid://shopify/Product/5003");
  assert.equal(product.baseProduct?.variants[0]?.graphqlId, "gid://shopify/ProductVariant/6003");
  assert.equal(product.baseProduct?.variants[0]?.price.amount, "599.00");
});

test("native Creator publishing removes every variant outside the saved fixed color", () => {
  const variants = [
    {
      id: "gid://shopify/ProductVariant/black-s",
      selectedOptions: [
        { name: "Size", value: "S" },
        { name: "Color", value: "Black" },
      ],
    },
    {
      id: "gid://shopify/ProductVariant/black-m",
      selectedOptions: [
        { name: "Size", value: "M" },
        { name: "Colour", value: "BLACK" },
      ],
    },
    {
      id: "gid://shopify/ProductVariant/white-s",
      selectedOptions: [
        { name: "Size", value: "S" },
        { name: "Color", value: "White" },
      ],
    },
  ];

  assert.deepEqual(nonFixedColorVariantIds(variants, "black"), [
    "gid://shopify/ProductVariant/white-s",
  ]);
  assert.throws(
    () => nonFixedColorVariantIds(variants, "Navy"),
    (error) =>
      error instanceof DomainError &&
      error.code === "CREATOR_FIXED_COLOR_VARIANTS_MISSING",
  );
});

test("native Creator publishing emits a versioned immutable cart validation contract", () => {
  const api = creatorCartContractApi();
  const setup = JSON.parse(creatorSetupJson("White", "DTF", 2));
  const pricing = {
    embroiderySurcharge: parseSurchargeInput("10.00"),
    embroideryTextSurcharge: parseSurchargeInput("11.00"),
    embroideryImageSurcharge: parseSurchargeInput("12.00"),
    dtfSurcharge: parseSurchargeInput("30.00"),
    dtgSurcharge: parseSurchargeInput("20.00"),
    embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
    embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
    embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
    dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
    dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
  };

  const contract = api.creatorCartValidationContract(
    "creator-product-1",
    setup,
    pricing,
  );
  assert.deepEqual(contract, {
    version: 1,
    creatorProductId: "creator-product-1",
    feeRequired: false,
    feeVariantId: null,
    placementCount: 2,
  });

  const metafields = api.nativeCreatorProductMetafields({
    productId: "gid://shopify/Product/500",
    product: {
      id: "creator-product-1",
      creatorId: "creator-1",
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "existing-project",
      creator: { displayName: "Demo Creator" },
    },
    collection: {
      id: "collection-1",
      publicHandle: "demo-creator",
      displayName: "Demo Creator Designs",
      shopifyCollectionId: "gid://shopify/Collection/10",
    },
    setup,
    pricingMode: "BAKED_IN_V1",
    cartValidationContract: contract,
  });
  const metafield = metafields.find((item) => item.key === "creator_cart_validation");
  assert.equal(metafield?.namespace, "customhouse");
  assert.equal(metafield?.type, "json");
  assert.deepEqual(JSON.parse(metafield?.value || "null"), contract);
  assert.equal(
    metafields.find((item) => item.key === "creator_pricing_mode")?.value,
    "BAKED_IN_V1",
  );
});

test("zero-surcharge Creator cart contract does not require fee merchandise", () => {
  const api = creatorCartContractApi();
  const setup = JSON.parse(creatorSetupJson("White", "DTG", 1));
  const pricing = {
    embroiderySurcharge: parseSurchargeInput("0"),
    embroideryTextSurcharge: parseSurchargeInput("0"),
    embroideryImageSurcharge: parseSurchargeInput("0"),
    dtfSurcharge: parseSurchargeInput("0"),
    dtgSurcharge: parseSurchargeInput("0"),
    embroideryFeeVariantId: null,
    embroideryTextFeeVariantId: null,
    embroideryImageFeeVariantId: null,
    dtfFeeVariantId: null,
    dtgFeeVariantId: null,
  };
  assert.deepEqual(
    api.creatorCartValidationContract("creator-zero", setup, pricing),
    {
      version: 1,
      creatorProductId: "creator-zero",
      feeRequired: false,
      feeVariantId: null,
      placementCount: 1,
    },
  );
});

test("positive Creator surcharge does not require fee merchandise for baked pricing", () => {
  const api = creatorCartContractApi();
  const setup = JSON.parse(creatorSetupJson("White", "EMBROIDERY", 1));
  const pricing = {
    embroiderySurcharge: parseSurchargeInput("10"),
    embroideryTextSurcharge: parseSurchargeInput("11"),
    embroideryImageSurcharge: parseSurchargeInput("12"),
    dtfSurcharge: parseSurchargeInput("20"),
    dtgSurcharge: parseSurchargeInput("30"),
    embroideryFeeVariantId: null,
    embroideryTextFeeVariantId: null,
    embroideryImageFeeVariantId: null,
    dtfFeeVariantId: null,
    dtgFeeVariantId: null,
  };
  assert.deepEqual(
    api.creatorCartValidationContract("creator-missing-fee", setup, pricing),
    {
      version: 1,
      creatorProductId: "creator-missing-fee",
      feeRequired: false,
      feeVariantId: null,
      placementCount: 1,
    },
  );
});

test("Creator publishing validates Embroidery subtype without selecting fee merchandise", () => {
  const api = creatorCartContractApi();
  const pricing = {
    embroiderySurcharge: parseSurchargeInput("50"),
    embroideryTextSurcharge: parseSurchargeInput("11"),
    embroideryImageSurcharge: parseSurchargeInput("29"),
    dtfSurcharge: parseSurchargeInput("30"),
    dtgSurcharge: parseSurchargeInput("20"),
    embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
    embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
    embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
    dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
    dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
  };
  const textSetup = JSON.parse(
    creatorSetupJson("Green", "EMBROIDERY", 2, "TEXT_ONLY"),
  );
  const imageSetup = JSON.parse(
    creatorSetupJson("Green", "EMBROIDERY", 2, "IMAGE_OR_LOGO"),
  );

  assert.equal(api.creatorCartValidationContract("creator-text", textSetup, pricing).feeRequired, false);
  assert.equal(api.creatorCartValidationContract("creator-image", imageSetup, pricing).feeRequired, false);
  assert.equal(
    api.creatorCartValidationContract(
      "creator-dtf",
      JSON.parse(creatorSetupJson("Green", "DTF", 2)),
      pricing,
    ).feeRequired,
    false,
  );
  const unresolved = { ...textSetup };
  delete unresolved.embroiderySubtype;
  assert.throws(
    () => api.creatorCartValidationContract("creator-unresolved", unresolved, pricing),
    (error) =>
      error instanceof DomainError &&
      error.code === "EMBROIDERY_SUBTYPE_REQUIRED",
  );
});

test("published Creator metadata fixes project design color method subtype placements and surfaces", () => {
  const api = creatorCartContractApi();
  const setup = {
    ...JSON.parse(creatorSetupJson("Green", "EMBROIDERY", 2, "IMAGE_OR_LOGO")),
    placements: ["Front", "Back"],
    previewSurfaces: [
      { side: "Front", url: "https://cdn.pitchprint.test/front.png", hasArtwork: true },
      { side: "Back", url: "https://cdn.pitchprint.test/back.png", hasArtwork: true },
    ],
  };
  const pricing = {
    embroiderySurcharge: parseSurchargeInput("50"),
    embroideryTextSurcharge: parseSurchargeInput("11"),
    embroideryImageSurcharge: parseSurchargeInput("29"),
    dtfSurcharge: parseSurchargeInput("30"),
    dtgSurcharge: parseSurchargeInput("20"),
    embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
    embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
    embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
    dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
    dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
  };
  const contract = api.creatorCartValidationContract("creator-product-2", setup, pricing);
  const metafields = api.nativeCreatorProductMetafields({
    productId: "gid://shopify/Product/500",
    product: {
      id: "creator-product-2",
      creatorId: "creator-1",
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_master",
      pitchprintDesignId: "pp_design",
      creator: { displayName: "Demo Creator" },
    },
    collection: {
      id: "collection-1",
      publicHandle: "demo-creator",
      displayName: "Demo Creator Designs",
      shopifyCollectionId: "gid://shopify/Collection/10",
    },
    setup,
    pricingMode: "BAKED_IN_V1",
    cartValidationContract: contract,
  });
  const byKey = new Map(metafields.map((item) => [item.key, item]));

  assert.equal(byKey.get("pitchprint_design_id")?.value, "pp_design");
  assert.equal(byKey.get("embroidery_artwork_type")?.value, "IMAGE_OR_LOGO");
  assert.deepEqual(
    JSON.parse(byKey.get("creator_design_metadata")?.value || "null"),
    {
      version: 1,
      pitchprintProjectId: "pp_master",
      pitchprintDesignId: "pp_design",
      fixedColor: "Green",
      productionMethod: "EMBROIDERY",
      embroiderySubtype: "IMAGE_OR_LOGO",
      placementCount: 2,
      placements: ["Front", "Back"],
      previewSurfaces: setup.previewSurfaces,
    },
  );
});

test("baked native Creator purchase adds the published variant without a fee line", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "DTF" },
    fakeClient(),
    database,
  );
  draft.id = "cmcreatorproduct00000030";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_native_master";
  draft.designVariantSelectionsJson = creatorSetupJson("White", "DTF", 2);
  draft.publishedShopifyProductId = "gid://shopify/Product/5001";
  draft.creatorPricingMode = "BAKED_IN_V1";
  draft.baseVariantMappingJson = JSON.stringify({
    "gid://shopify/ProductVariant/6001": "gid://shopify/ProductVariant/2001",
  });

  const publicClient = fakePublicProductClient();
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("NativeCreatorCartVariant")) {
        return {
          productVariant: {
            id: "gid://shopify/ProductVariant/6001",
            availableForSale: true,
            product: { id: "gid://shopify/Product/5001" },
          },
        } as T;
      }
      return publicClient.request<T>(query);
    },
  };

  const cart = await prepareNativeCreatorProductCart(
    shop,
    {
      shopifyProductId: "gid://shopify/Product/5001",
      selectedVariantId: "gid://shopify/ProductVariant/6001",
      quantity: 3,
      nonReturnAcknowledged: true,
      termsAccepted: true,
      selectedProductionMethod: "EMBROIDERY",
    } as unknown as Parameters<typeof prepareNativeCreatorProductCart>[1],
    client,
    async (projectId) => {
      assert.equal(projectId, "pp_native_master");
      return "pp_native_order";
    },
    database,
  );

  assert.equal(cart.items[0].id, "6001");
  assert.equal(cart.items[0].quantity, 3);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.production.method, "DTF");
  assert.equal(cart.production.placementCount, 2);
  assert.equal(cart.production.feeQuantity, 0);
  assert.equal(cart.production.feeVariantId, null);
  assert.equal(cart.production.pricingMode, "BAKED_IN_V1");
  assert.equal("Printing method" in cart.properties, false);
  assert.equal(cart.properties._base_variant_id, "gid://shopify/ProductVariant/2001");
  assert.equal(cart.properties._creator_product_id, draft.id);
  assert.equal(cart.properties._pitchprint, "pp_native_order");
  assert.equal(cart.nativeProduct?.selectedVariantId, "gid://shopify/ProductVariant/6001");
});

test("baked app-proxy Creator purchase resolves the published variant without a fee line", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "DTF" },
    fakeClient(),
    database,
  );
  draft.id = "cmcreatorproduct00000031";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_proxy_master";
  draft.designVariantSelectionsJson = creatorSetupJson("White", "DTF", 2);
  draft.publishedShopifyProductId = "gid://shopify/Product/5002";
  draft.creatorPricingMode = "BAKED_IN_V1";
  draft.baseVariantMappingJson = JSON.stringify({
    "gid://shopify/ProductVariant/6002": "gid://shopify/ProductVariant/2001",
  });

  const publicClient = fakePublicProductClient();
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("NativeCreatorCartVariant")) {
        return {
          productVariant: {
            id: "gid://shopify/ProductVariant/6002",
            availableForSale: true,
            product: { id: "gid://shopify/Product/5002" },
          },
        } as T;
      }
      return publicClient.request<T>(query);
    },
  };

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      quantity: 2,
      nonReturnAcknowledged: true,
      termsAccepted: true,
    },
    client,
    async (projectId) => {
      assert.equal(projectId, "pp_proxy_master");
      return "pp_proxy_order";
    },
    database,
  );

  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].id, "6002");
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.production.feeVariantId, null);
  assert.equal(cart.production.feeQuantity, 0);
  assert.equal(cart.production.pricingMode, "BAKED_IN_V1");
  assert.equal(cart.properties._base_variant_id, "gid://shopify/ProductVariant/2001");
  assert.equal(cart.properties._pitchprint, "pp_proxy_order");
});

test("baked app-proxy Creator purchase recovers missing non-first size mapping by variant identity", async () => {
  const database = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id, selectedProductionMethod: "DTF" },
    fakeClient(),
    database,
  );
  draft.id = "cmcreatorproduct00000033";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_proxy_master_m";
  draft.designVariantSelectionsJson = creatorSetupJson("White", "DTF", 1);
  draft.publishedShopifyProductId = "gid://shopify/Product/5004";
  draft.creatorPricingMode = "BAKED_IN_V1";
  draft.baseVariantMappingJson = JSON.stringify({
    "gid://shopify/ProductVariant/6003": "gid://shopify/ProductVariant/2001",
  });

  const client: ShopifyGraphqlClient = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      if (query.includes("NativeCreatorCartVariant")) {
        return {
          productVariant: {
            id: variables?.id,
            availableForSale: true,
            selectedOptions: [
              { name: "Size", value: "M" },
              { name: "Color", value: "White" },
            ],
            product: { id: "gid://shopify/Product/5004" },
          },
        } as T;
      }
      return {
        product: {
          id: "gid://shopify/Product/5004",
          title: "Creator Hoodie",
          handle: "creator-hoodie",
          onlineStoreUrl: "https://customhouse.se/products/creator-hoodie",
          options: [
            { name: "Size", values: ["S", "M"] },
            { name: "Color", values: ["White"] },
          ],
          priceRangeV2: {
            minVariantPrice: { amount: "599.00", currencyCode: "SEK" },
            maxVariantPrice: { amount: "649.00", currencyCode: "SEK" },
          },
          variants: {
            nodes: [
              {
                id: "gid://shopify/ProductVariant/6003",
                legacyResourceId: "6003",
                title: "S / White",
                availableForSale: true,
                price: "599.00",
                selectedOptions: [
                  { name: "Size", value: "S" },
                  { name: "Color", value: "White" },
                ],
              },
              {
                id: "gid://shopify/ProductVariant/6004",
                legacyResourceId: "6004",
                title: "M / White",
                availableForSale: true,
                price: "649.00",
                selectedOptions: [
                  { name: "Size", value: "M" },
                  { name: "Color", value: "White" },
                ],
              },
            ],
          },
        },
      } as T;
    },
  };

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "6004",
      quantity: 1,
      nonReturnAcknowledged: true,
      termsAccepted: true,
    },
    client,
    async (projectId) => {
      assert.equal(projectId, "pp_proxy_master_m");
      return "pp_proxy_order_m";
    },
    database,
  );

  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].id, "6004");
  assert.equal(cart.production.pricingMode, "BAKED_IN_V1");
  assert.equal(cart.properties._base_variant_id, "gid://shopify/ProductVariant/2002");
  assert.equal(cart.nativeProduct?.selectedVariantId, "gid://shopify/ProductVariant/6004");
});

test("native Creator product form prepares authoritative lines before Shopify cart add", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/buy-only-product-form.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-native-creator-cart.js",
    "utf8",
  );

  assert.match(block, /action="\/apps\/customhouse\/api\/native-creator-product-cart"/);
  assert.match(block, /data-customhouse-native-creator-cart/);
  assert.doesNotMatch(block, /action="\{\{ routes\.cart_add_url \}\}"/);
  assert.match(script, /PREPARE_ENDPOINT = "\/apps\/customhouse\/api\/native-creator-product-cart"/);
  assert.match(script, /JSON\.stringify\(\{ items: cart\.items \}\)/);
  assert.doesNotMatch(script, /surchargeMinor\s*[*+\-/]/);
});

test("cart prep validates variant ownership and locks creator artwork", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000002";
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_master", previewUrl: "https://cdn.pitchprint.test/master.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "PUBLISHED" },
    db,
  );

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: 2001,
      quantity: 2,
      creatorId: "creator-b",
      pitchprintProjectId: "browser_override",
      productionMethod: "DTF",
      _creator_preview_url: "https://browser.example/override.png",
    } as unknown as Parameters<typeof prepareCreatorProductCart>[1],
    fakePublicProductClient(),
    async (masterProjectId) => {
      assert.equal(masterProjectId, "pp_master");
      return "pp_order_clone";
    },
    db,
  );

  assert.equal(cart.variant.graphqlId, "gid://shopify/ProductVariant/2001");
  assert.equal(cart.variant.cartId, "2001");
  assert.equal(cart.variantId, "2001");
  assert.equal(cart.cartVariantId, "2001");
  assert.notEqual(cart.variantId, "gid://shopify/ProductVariant/2001");
  assert.equal(cart.quantity, 2);
  assert.equal(cart.properties._pitchprint, "pp_order_clone");
  assert.equal(cart.properties._creator_product_id, draft.id);
  assert.equal(cart.properties._creator_id, "creator-a");
  assert.equal(cart.properties._base_product_id, baseProduct.id);
  assert.equal(cart.properties._base_variant_id, "gid://shopify/ProductVariant/2001");
  assert.equal(cart.properties._creator_preview_url, "https://cdn.pitchprint.test/master.png");
  assert.equal(cart.properties._creator_public_handle, "creator-a");
  assert.equal(cart.properties._production_method, "DTF");
  assert.equal("Color" in cart.properties, false);
  assert.equal("Printing method" in cart.properties, false);
  assert.equal(cart.production.method, "DTF");
  assert.equal(cart.production.fixedColor, "White");
  assert.equal(cart.production.placementCount, 1);
  assert.equal(cart.production.surchargeMinor, "3000");
  assert.equal(cart.production.feeVariantId, "9002");
  assert.equal(cart.production.feeQuantity, 2);
  assert.equal(cart.items.length, 2);
  const feeProperties = cart.items[1].properties as Record<string, string>;
  assert.equal(cart.items[0].id, "2001");
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.items[1].id, "9002");
  assert.equal(cart.items[1].quantity, 2);
  assert.equal(feeProperties._customhouse_production_fee, "true");
  assert.equal(feeProperties._pitchprint, "pp_order_clone");
  assert.equal(feeProperties._customhouse_fee_key, cart.properties._customhouse_fee_key);
  assert.equal(feeProperties._creator_product_id, draft.id);
  assert.equal(typeof cart.properties._customhouse_attribution, "string");
  assert.equal(cart.properties._creator_design_title, draft.title);
  assert.equal(cart.properties._customhouse_non_return_acknowledgement, "Accepted");
  assert.equal(cart.properties._customhouse_terms_acknowledgement, "Accepted");
  assert.equal("Creator Design" in cart.properties, false);
  assert.equal("Designed placements" in cart.properties, false);
  assert.equal("Customized product acknowledgement" in cart.properties, false);
  assert.equal("Terms & Conditions" in cart.properties, false);
  assert.equal("Creator" in cart.properties, false);
  assert.equal("Embroidery artwork" in cart.properties, false);
  assert.equal(db.products.find((product) => product.id === draft.id)?.pitchprintProjectId, "pp_master");
  assert.equal(await db.creatorSale.count(), 0);
});

test("legacy creator detail and cart prefer canonical base-product production pricing", async () => {
  const db = fakeDb();
  const lookedUpKeys: string[] = [];
  db.publicProductProductionPricing.findUnique = async (args: unknown) => {
    const key = (args as {
      where: { shopKey_shopifyProductId: { shopifyProductId: string } };
    }).where.shopKey_shopifyProductId.shopifyProductId;
    lookedUpKeys.push(key);
    return {
      id: "creator-pricing-1",
      shopKey: shop,
      shopifyProductId: key,
      embroiderySurcharge: parseSurchargeInput("10.00"),
      embroideryTextSurcharge: parseSurchargeInput("11.00"),
      embroideryImageSurcharge: parseSurchargeInput("12.00"),
      dtfSurcharge: parseSurchargeInput("30.00"),
      dtgSurcharge: parseSurchargeInput("20.00"),
      embroideryFeeVariantId: "gid://shopify/ProductVariant/9101",
      embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9104",
      embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9105",
      dtfFeeVariantId: "gid://shopify/ProductVariant/9102",
      dtgFeeVariantId: "gid://shopify/ProductVariant/9103",
    };
  };
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000022";
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_master", previewUrl: "https://cdn.pitchprint.test/master.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "PUBLISHED" },
    db,
  );

  const product = await publicCreatorProductDetail(
    shop,
    "creator-a",
    draft.id,
    fakePublicProductClient(),
    db,
  );
  assert.equal(product.productionPricing?.methods.length, 1);
  assert.equal(product.productionPricing?.methods[0]?.method, "DTF");
  assert.equal(product.productionPricing?.methods[0]?.surchargeMinor, "3000");

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      productionMethod: "DTF",
    },
    fakePublicProductClient(),
    async () => "pp_order_creator_pricing",
    db,
  );

  assert.deepEqual([...new Set(lookedUpKeys)], [
    baseProduct.id,
  ]);
  assert.equal(cart.production.method, "DTF");
  assert.equal(cart.production.surchargeMinor, "3000");
  assert.equal(cart.production.feeVariantId, "9102");
  assert.equal("Printing method" in cart.properties, false);
});

test("creator cart prep resyncs stale shared creator fee variants", async () => {
  const db = fakeDb();
  let pricing = {
    id: "creator-pricing-stale",
    shopKey: shop,
    shopifyProductId: CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
    embroiderySurcharge: parseSurchargeInput("10.00"),
    embroideryTextSurcharge: parseSurchargeInput("11.00"),
    embroideryImageSurcharge: parseSurchargeInput("12.00"),
    dtfSurcharge: parseSurchargeInput("30.00"),
    dtgSurcharge: parseSurchargeInput("20.00"),
    embroideryFeeVariantId: "gid://shopify/ProductVariant/9101",
    embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9104",
    embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9105",
    dtfFeeVariantId: "gid://shopify/ProductVariant/9102",
    dtgFeeVariantId: "gid://shopify/ProductVariant/9103",
  };
  db.publicProductProductionPricing.findUnique = async () => pricing;
  (
    db.publicProductProductionPricing as typeof db.publicProductProductionPricing & {
      update(args: { data: Partial<typeof pricing> }): Promise<typeof pricing>;
    }
  ).update = async (args) => {
    pricing = { ...pricing, ...args.data };
    return pricing;
  };

  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000023";
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_master", previewUrl: "https://cdn.pitchprint.test/master.png" }),
    db,
  );
  await submitCreatorProductForReview(shop, "gid://shopify/Customer/1", draft.id, db);
  await moderateCreatorProductAsAdmin(
    shop,
    "admin",
    { creatorProductId: draft.id, decision: "PUBLISHED" },
    db,
  );

  let feeSyncCount = 0;
  const baseClient = fakePublicProductClient();
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      if (query.includes("CustomHouseProductionFeeVariant")) {
        return {
          node: {
            id: "gid://shopify/ProductVariant/9102",
            availableForSale: false,
            product: { status: "ACTIVE" },
          },
        } as T;
      }
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("productSet")) {
        feeSyncCount += 1;
        return {
          productSet: {
            product: {
              id: "gid://shopify/Product/creator-fee",
              title: "Creator Fee",
              parentProductId: { value: CREATOR_PRODUCTION_PRICING_PRODUCT_ID },
              variants: {
                nodes: [
                  { id: "gid://shopify/ProductVariant/9201", title: "Embroidery Production Fee" },
                  { id: "gid://shopify/ProductVariant/9204", title: "Embroidery Text Production Fee" },
                  { id: "gid://shopify/ProductVariant/9205", title: "Embroidery Image or Logo Production Fee" },
                  { id: "gid://shopify/ProductVariant/9202", title: "DTF Production Fee" },
                  { id: "gid://shopify/ProductVariant/9203", title: "DTG Production Fee" },
                ],
              },
            },
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("CustomHouseOnlineStorePublication")) {
        return {
          product: { resourcePublications: { nodes: [] } },
          publications: {
            nodes: [{ id: "gid://shopify/Publication/online-store", name: "Online Store" }],
          },
        } as T;
      }
      if (query.includes("publishablePublish")) {
        return { publishablePublish: { userErrors: [] } } as T;
      }
      return baseClient.request<T>(query);
    },
  };

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      productionMethod: "DTF",
    },
    client,
    async () => "pp_order_resynced_fee",
    db,
  );

  assert.equal(feeSyncCount, 1);
  assert.equal(cart.production.method, "DTF");
  assert.equal(cart.production.feeVariantId, "9202");
  assert.equal(cart.items[1].id, "9202");
});
test("cart prep rejects manually submitted variants outside the saved fixed color", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000021";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_black_only";
  draft.designVariantSelectionsJson = creatorSetupJson("Black", "EMBROIDERY", 1);
  draft.baseProductVariantsJson = JSON.stringify([
    {
      id: "gid://shopify/ProductVariant/3001",
      graphqlId: "gid://shopify/ProductVariant/3001",
      variantId: "3001",
      title: "S / Black",
      size: "S",
      availableForSale: true,
      selectedOptions: [
        { name: "Size", value: "S" },
        { name: "Color", value: "Black" },
      ],
    },
    {
      id: "gid://shopify/ProductVariant/3002",
      graphqlId: "gid://shopify/ProductVariant/3002",
      variantId: "3002",
      title: "M / White",
      size: "M",
      availableForSale: true,
      selectedOptions: [
        { name: "Size", value: "M" },
        { name: "Color", value: "White" },
      ],
    },
  ]);
  const blackWhiteClient: ShopifyGraphqlClient = {
    async request<T>() {
      return {
        product: {
          id: baseProduct.id,
          title: "Global Hoodie",
          handle: "global-hoodie",
          onlineStoreUrl: "https://customhouse.se/products/global-hoodie",
          options: [
            { name: "Size", values: ["S", "M"] },
            { name: "Color", values: ["Black", "White"] },
          ],
          priceRangeV2: {
            minVariantPrice: { amount: "299.00", currencyCode: "SEK" },
            maxVariantPrice: { amount: "299.00", currencyCode: "SEK" },
          },
          variants: {
            nodes: [
              {
                id: "gid://shopify/ProductVariant/3001",
                legacyResourceId: "3001",
                title: "S / Black",
                availableForSale: true,
                price: "299.00",
                selectedOptions: [
                  { name: "Size", value: "S" },
                  { name: "Color", value: "Black" },
                ],
              },
              {
                id: "gid://shopify/ProductVariant/3002",
                legacyResourceId: "3002",
                title: "M / White",
                availableForSale: true,
                price: "299.00",
                selectedOptions: [
                  { name: "Size", value: "M" },
                  { name: "Color", value: "White" },
                ],
              },
            ],
          },
        },
      } as T;
    },
  };

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/3001",
      productionMethod: "EMBROIDERY",
    } as unknown as Parameters<typeof prepareCreatorProductCart>[1],
    blackWhiteClient,
    async () => "pp_black_order",
    db,
  );

  assert.equal(cart.properties._fixed_color, "Black");
  assert.equal("Color" in cart.properties, false);
  assert.equal(cart.properties._production_method, "EMBROIDERY");
  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/3002",
          productionMethod: "EMBROIDERY",
        },
        blackWhiteClient,
        async () => "pp_white_order",
        db,
      ),
    (error) => error instanceof DomainError && error.code === "INVALID_CREATOR_COLOR",
  );
});

test("creator buy-only production fee quantity uses saved designed placement count", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000020";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_master_placements";
  draft.designVariantSelectionsJson = creatorSetupJson("White", "DTF", 3);

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      quantity: 4,
    },
    fakePublicProductClient(),
    async () => "pp_order_placements",
    db,
  );

  assert.equal(cart.production.placementCount, 3);
  assert.equal(cart.production.surchargeMinor, "3000");
  assert.equal(cart.production.feeVariantId, "9002");
  assert.equal(cart.production.feeQuantity, 12);
  const feeProperties = cart.items[1].properties as Record<string, string>;
  assert.equal(cart.items[1].id, "9002");
  assert.equal(cart.items[1].quantity, 12);
  assert.equal(feeProperties._designed_placement_count, "3");
  assert.equal("Designed placements" in feeProperties, false);
});

test("Embroidery cart uses the saved subtype price and retains canonical production metadata", async () => {
  for (const [subtype, feeVariantId, surchargeMinor] of [
    ["TEXT_ONLY", "9004", "5000"],
    ["IMAGE_OR_LOGO", "9005", "7000"],
  ] as const) {
    const db = fakeDb();
    const draft = await createCreatorProductDraft(
      shop,
      "gid://shopify/Customer/1",
      { shopifyProductId: baseProduct.id, selectedProductionMethod: "EMBROIDERY" },
      fakeClient(),
      db,
    );
    draft.id = `cmcreatorproduct${subtype === "TEXT_ONLY" ? "00000041" : "00000042"}`;
    draft.status = "PUBLISHED";
    draft.pitchprintProjectId = `pp_master_${subtype.toLowerCase()}`;
    draft.pitchprintDesignId = "pp_design_green_shirt";
    draft.previewUrl = "https://cdn.pitchprint.test/front.png";
    draft.previewUrls = JSON.stringify([
      "https://cdn.pitchprint.test/front.png",
      "https://cdn.pitchprint.test/back.png",
    ]);
    draft.designVariantSelectionsJson = JSON.stringify({
      ...JSON.parse(creatorSetupJson("White", "EMBROIDERY", 2, subtype)),
      placements: ["Front", "Back"],
      previewSurfaces: [
        { side: "Front", url: "https://cdn.pitchprint.test/front.png", hasArtwork: true },
        { side: "Back", url: "https://cdn.pitchprint.test/back.png", hasArtwork: true },
      ],
    });

    const cart = await prepareCreatorProductCart(
      shop,
      {
        creatorHandle: "creator-a",
        creatorProductId: draft.id,
        selectedVariantId: "gid://shopify/ProductVariant/2001",
        quantity: 2,
        embroiderySubtype: subtype === "TEXT_ONLY" ? "IMAGE_OR_LOGO" : "TEXT_ONLY",
      } as unknown as Parameters<typeof prepareCreatorProductCart>[1],
      fakePublicProductClient(),
      async () => `pp_order_${subtype.toLowerCase()}`,
      db,
    );

    assert.equal(cart.production.embroiderySubtype, subtype);
    assert.equal(cart.production.surchargeMinor, surchargeMinor);
    assert.equal(cart.production.feeVariantId, feeVariantId);
    assert.equal(cart.production.feeQuantity, 4);
    assert.equal(cart.items[1].id, feeVariantId);
    assert.equal(cart.items[1].quantity, 4);
    assert.equal(cart.properties._pitchprint_design_id, "pp_design_green_shirt");
    assert.equal(cart.properties._creator_master_project_id, draft.pitchprintProjectId);
    assert.equal(cart.properties._fixed_color, "White");
    assert.equal(cart.properties._production_method, "EMBROIDERY");
    assert.equal(cart.properties._embroidery_subtype, subtype);
    assert.equal(cart.properties._designed_placement_count, "2");
  }
});

test("cart prep uses stored preview URL list and omits invalid preview without blocking", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000017";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_master";
  draft.designVariantSelectionsJson = creatorSetupJson();
  draft.previewUrl = "http://cdn.pitchprint.test/insecure.png";
  draft.previewUrls = JSON.stringify([
    "ftp://cdn.pitchprint.test/ignored.png",
    "https://cdn.pitchprint.test/fallback.png",
  ]);

  const cartWithFallback = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      previewUrl: "https://browser.example/override.png",
    } as unknown as Parameters<typeof prepareCreatorProductCart>[1],
    fakePublicProductClient(),
    async () => "pp_order_clone",
    db,
  );

  assert.equal(cartWithFallback.properties._creator_preview_url, "https://cdn.pitchprint.test/fallback.png");

  draft.previewUrl = null;
  draft.previewUrls = "[]";
  const cartWithoutPreview = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
    },
    fakePublicProductClient(),
    async () => "pp_order_clone_2",
    db,
  );

  assert.equal("_creator_preview_url" in cartWithoutPreview.properties, false);
  assert.equal(cartWithoutPreview.properties._creator_product_id, draft.id);
  assert.equal(cartWithoutPreview.properties._creator_design_title, draft.title);
  assert.equal("Creator Design" in cartWithoutPreview.properties, false);
});

test("cart prep falls back to master PitchPrint project when clone config is optional", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000016";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_master";
  draft.designVariantSelectionsJson = creatorSetupJson();

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
    },
    fakePublicProductClient(),
    async () => {
      throw new DomainError(
        "PITCHPRINT_NOT_CONFIGURED",
        "Missing clone credentials.",
        503,
      );
    },
    db,
  );

  assert.equal(cart.properties._pitchprint, "pp_master");
});

test("cart prep falls back to master PitchPrint project when clone service fails", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000018";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_master";
  draft.designVariantSelectionsJson = creatorSetupJson();

  const cart = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "creator-a",
      creatorProductId: draft.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
      selectedProductionMethod: "EMBROIDERY",
    },
    fakePublicProductClient(),
    async () => {
      throw new DomainError(
        "PITCHPRINT_CLONE_FAILED",
        "PitchPrint did not return an order-specific design.",
        502,
      );
    },
    db,
  );

  assert.equal(cart.properties._pitchprint, "pp_master");
  assert.equal(cart.creatorProduct.masterPitchPrintProjectId, "pp_master");
  assert.equal(cart.items[0].properties._pitchprint, "pp_master");
});
test("cart prep rejects unpublished products and unavailable variants", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000003";
  await attachPitchPrintProjectToCreatorProduct(
    shop,
    "gid://shopify/Customer/1",
    draft.id,
    pitchPrintPayload({ projectId: "pp_master", previewUrl: "https://cdn.pitchprint.test/master.png" }),
    db,
  );

  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/2001",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    /Creator Product not found/,
  );

  db.products.find((product) => product.id === draft.id)!.status = "PUBLISHED";
  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/9999",
          productionMethod: "DTF",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    (error) => error instanceof DomainError && error.code === "VARIANT_UNAVAILABLE",
  );
});

test("cart prep denies suspended creators and inactive collections", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000013";
  draft.status = "PUBLISHED";
  draft.pitchprintProjectId = "pp_master";
  draft.designVariantSelectionsJson = creatorSetupJson();
  db.creators.find((creator) => creator.id === "creator-a")!.status = "SUSPENDED";

  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/2001",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    /Creator collection not found/,
  );

  db.creators.find((creator) => creator.id === "creator-a")!.status = "APPROVED";
  db.collections.find((collection) => collection.creatorId === "creator-a")!.status =
    "HIDDEN";
  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/2001",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    /Creator collection not found/,
  );
});

test("same-name creators keep separate cart attribution", async () => {
  const db = fakeDb();
  db.creators[0].displayName = "Alex Smith";
  db.creators[1].displayName = "Alex Smith";
  db.collections[0].publicHandle = "alex-smith-a1b2c";
  db.collections[1].publicHandle = "alex-smith-d3e4f";
  const productA = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  const productB = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/2",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  productA.id = "cmcreatorproduct00000014";
  productB.id = "cmcreatorproduct00000015";
  productA.status = "PUBLISHED";
  productB.status = "PUBLISHED";
  productA.pitchprintProjectId = "pp_master_a";
  productB.pitchprintProjectId = "pp_master_b";
  productA.designVariantSelectionsJson = creatorSetupJson();
  productB.designVariantSelectionsJson = creatorSetupJson();

  const cartA = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "alex-smith-a1b2c",
      creatorProductId: productA.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
    },
    fakePublicProductClient(),
    async () => "pp_order_a",
    db,
  );
  const cartB = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: "alex-smith-d3e4f",
      creatorProductId: productB.id,
      selectedVariantId: "gid://shopify/ProductVariant/2001",
    },
    fakePublicProductClient(),
    async () => "pp_order_b",
    db,
  );

  assert.equal(cartA.properties._creator_id, "creator-a");
  assert.equal(cartB.properties._creator_id, "creator-b");
  assert.notEqual(cartA.properties._creator_collection_id, cartB.properties._creator_collection_id);
  assert.equal(cartA.properties._pitchprint, "pp_order_a");
  assert.equal(cartB.properties._pitchprint, "pp_order_b");
});

test("cart prep cannot run without a master PitchPrint project", async () => {
  const db = fakeDb();
  const draft = await createCreatorProductDraft(
    shop,
    "gid://shopify/Customer/1",
    { shopifyProductId: baseProduct.id },
    fakeClient(),
    db,
  );
  draft.id = "cmcreatorproduct00000004";
  draft.status = "PUBLISHED";

  await assert.rejects(
    () =>
      prepareCreatorProductCart(
        shop,
        {
          creatorHandle: "creator-a",
          creatorProductId: draft.id,
          selectedVariantId: "gid://shopify/ProductVariant/2001",
        },
        fakePublicProductClient(),
        async () => "pp_order_clone",
        db,
      ),
    /not ready for purchase/,
  );
});

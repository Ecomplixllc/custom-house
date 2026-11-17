import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AdminGraphqlClient,
  throwUserErrors,
} from "../app/services/shopify-graphql.server.ts";
import {
  CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
  canonicalProductionMethodCode,
  createProductionMethodDefinition,
  feeVariantIdForEmbroiderySubtype,
  getEnabledProductionMethodsForProduct,
  getProductionPricingBridgeForProduct,
  listEnabledProductionMethods,
  listProductionMethodDefinitions,
  parseSurchargeInput,
  pricingForEmbroiderySubtype,
  productionPricingBridgePayload,
  pricingConfigToMetafieldValue,
  resolveProductionPricing,
  saveCreatorProductionPricing,
  saveProductionPricing,
  syncProductionFeeMerchandise,
  type ProductionPricingBridgePayload,
  type PublicProductProductionPricingRecord,
} from "../app/services/production-method-pricing.server.ts";
import { DomainError } from "../app/services/domain.ts";

import {
  calculateTrustedProductionTotal,
  jsonSafePublicProductionCart,
  preparePublicProductionCart,
} from "../app/services/production-method-cart.server.ts";

test("custom registry method uses a stable code and starts disabled for products", async () => {
  const rows: Array<Record<string, unknown>> = [];
  let productPricingWrites = 0;
  const database = {
    productionMethodSetting: {
      async findMany() {
        return rows;
      },
      async findUnique({ where }: { where: { shopKey_method: { shopKey: string; method: string } } }) {
        return rows.find((row) =>
          row.shopKey === where.shopKey_method.shopKey &&
          row.method === where.shopKey_method.method,
        ) || null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: "method-1", ...data };
        rows.push(row);
        return row;
      },
    },
    publicProductProductionPricing: {
      async findUnique() { return null; },
      async findMany() { return []; },
      async upsert() { productPricingWrites += 1; throw new Error("unexpected pricing write"); },
      async update() { productPricingWrites += 1; throw new Error("unexpected pricing write"); },
    },
  };

  assert.equal(canonicalProductionMethodCode("Screen Printing"), "SCREEN_PRINTING");
  const created = await createProductionMethodDefinition(
    "shop.test",
    {
      label: "Screen Printing",
      code: "",
      pricingBehavior: "SINGLE",
      maxWidthCm: "35",
      maxHeightCm: "40",
    },
    database as never,
  );
  assert.deepEqual(
    {
      id: created.id,
      label: created.label,
      pricingBehavior: created.pricingBehavior,
      maxWidthCm: created.maxWidthCm,
      maxHeightCm: created.maxHeightCm,
    },
    {
      id: "SCREEN_PRINTING",
      label: "Screen Printing",
      pricingBehavior: "SINGLE",
      maxWidthCm: 35,
      maxHeightCm: 40,
    },
  );
  const definitions = await listProductionMethodDefinitions("shop.test", database as never);
  assert.equal(definitions.at(-1)?.id, "SCREEN_PRINTING");
  assert.equal(productPricingWrites, 0);
});

test("custom registry method rejects reserved duplicate and invalid configuration", async () => {
  const rows = [{
    id: "method-1",
    shopKey: "shop.test",
    method: "SCREEN_PRINTING",
    label: "Screen Printing",
    description: "",
    enabled: true,
    pricingBehavior: "SINGLE",
    configurationJson: {},
  }];
  const database = {
    productionMethodSetting: {
      async findMany() { return rows; },
      async findUnique({ where }: { where: { shopKey_method: { method: string } } }) {
        return rows.find((row) => row.method === where.shopKey_method.method) || null;
      },
      async create() { throw new Error("must not create invalid method"); },
    },
    publicProductProductionPricing: {
      async findUnique() { return null; },
      async findMany() { return []; },
      async upsert() { throw new Error("unexpected"); },
      async update() { throw new Error("unexpected"); },
    },
  };

  for (const [input, code] of [
    [{ label: "DTF", code: "DTF", pricingBehavior: "SINGLE" }, "PRODUCTION_METHOD_RESERVED"],
    [{ label: "Screen Printing", code: "SCREEN_PRINTING", pricingBehavior: "SINGLE" }, "PRODUCTION_METHOD_DUPLICATE"],
    [{ label: "Laser Engraving", code: "LASER_ENGRAVING", pricingBehavior: "SINGLE", maxWidthCm: "0" }, "PRODUCTION_METHOD_DIMENSION_INVALID"],
  ] as const) {
    await assert.rejects(
      () => createProductionMethodDefinition("shop.test", input, database as never),
      (error) => error instanceof DomainError && error.code === code,
    );
  }
});

test("enabled production methods preserve explicit disabled settings and canonical labels", async () => {
  let findManyArgs: unknown;
  const methods = await listEnabledProductionMethods(
    "customhouse.test",
    {
      productionMethodSetting: {
        async findMany(args: unknown) {
          findManyArgs = args;
          return [
            {
              method: "EMBROIDERY",
              label: "Embroidery",
              description: "",
              enabled: true,
            },
            {
              method: "DTF",
              label: "DTF",
              description: "",
              enabled: false,
            },
            {
              method: "DTG",
              label: "",
              description: "",
              enabled: true,
            },
          ];
        },
      },
    } as never,
  );

  assert.deepEqual(findManyArgs, {
    where: { shopKey: "customhouse.test" },
    orderBy: { method: "asc" },
  });
  assert.deepEqual(methods, [
    { id: "EMBROIDERY", label: "Embroidery" },
    { id: "DTG", label: "DTG printing" },
    { id: "SUBLIMATION", label: "Sublimation" },
    { id: "STICKER_PRINTING", label: "Sticker Printing" },
  ]);
});

type PricingRow = PublicProductProductionPricingRecord;

type PricingCreateData = Pick<
  PricingRow,
  | "shopKey"
  | "shopifyProductId"
  | "embroiderySurcharge"
  | "embroideryTextSurcharge"
  | "embroideryImageSurcharge"
  | "dtfSurcharge"
  | "dtgSurcharge"
> &
  Partial<
    Pick<
      PricingRow,
      | "id"
      | "embroideryFeeVariantId"
      | "embroideryTextFeeVariantId"
      | "embroideryImageFeeVariantId"
      | "dtfFeeVariantId"
      | "dtgFeeVariantId"
    >
  >;

type PricingDbArgs = {
  where: {
    shopKey_shopifyProductId?: { shopifyProductId: string };
    id?: string;
  };
  create: PricingCreateData;
  update: Partial<PricingRow>;
  data: Partial<PricingRow>;
};

type ShopifyPricingVariables = {
  query?: string;
  metafields?: Array<{ value: string }>;
  input?: {
    metafields?: Array<{ value: string }>;
    variants?: Array<{ price: string }>;
  };
};

function pricingArgs(args: unknown) {
  return args as PricingDbArgs;
}

function pricingProductKey(args: PricingDbArgs) {
  const key = args.where.shopKey_shopifyProductId?.shopifyProductId;
  assert.ok(key);
  return key;
}

function updatePricingRow(rows: Map<string, PricingRow>, args: unknown) {
  const parsedArgs = pricingArgs(args);
  const row = [...rows.values()].find((item) => item.id === parsedArgs.where.id);
  assert.ok(row);
  const updated = { ...row, ...parsedArgs.data } as PricingRow;
  rows.set(updated.shopifyProductId, updated);
  return updated;
}

function shopifyPricingVariables(variables: Record<string, unknown> | undefined) {
  return variables as ShopifyPricingVariables | undefined;
}

function productSetInputFromVariables(variables: Record<string, unknown> | undefined) {
  const input = variables?.input;
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  return input as ProductionFeeProductSetInput;
}

test("production method pricing schema matches existing production DB objects", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /model ProductionMethodSetting\s*\{/);
  assert.match(schema, /method\s+String/);
  assert.match(schema, /description\s+String\s+@default\(""\)/);
  assert.match(schema, /pricingBehavior\s+String/);
  assert.match(schema, /configurationJson\s+Json/);
  assert.match(schema, /@@unique\(\[shopKey, method\]\)/);
  assert.match(schema, /model PublicProductProductionPricing\s*\{/);
  assert.match(schema, /currency\s+String/);
  assert.match(schema, /methodConfigurations\s+Json/);
  assert.match(
    schema,
    /embroiderySurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/,
  );
  assert.match(schema, /dtfSurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /dtgSurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /@@unique\(\[shopKey, shopifyProductId\]\)/);
});

test("canonical resolver supports product enablement, zero price, and dynamic methods", async () => {
  const database = {
    productionMethodSetting: {
      async findMany() {
        return [
          { method: "EMBROIDERY", label: "Embroidery", description: "", enabled: true, pricingBehavior: "TIERED", configurationJson: { maxWidthCm: 8, maxHeightCm: 8 } },
          { method: "DTF", label: "DTF printing", description: "", enabled: true, pricingBehavior: "SINGLE", configurationJson: { maxWidthCm: 35, maxHeightCm: 40 } },
          { method: "SUBLIMATION", label: "Sublimation", description: "", enabled: true, pricingBehavior: "SINGLE", configurationJson: {} },
          { method: "STICKER_PRINTING", label: "Sticker Printing", description: "", enabled: true, pricingBehavior: "SINGLE", configurationJson: {} },
          { method: "LASER_ENGRAVING", label: "Laser Engraving", description: "", enabled: true, pricingBehavior: "TIERED", configurationJson: { tiers: ["SMALL", "LARGE"] } },
        ];
      },
    },
    publicProductProductionPricing: {
      async findUnique() {
        return {
          id: "pricing-sticker",
          shopKey: "shop.test",
          shopifyProductId: "gid://shopify/Product/500",
          currency: "SEK",
          methodConfigurations: {
            version: 2,
            methods: {
              EMBROIDERY: {
                enabled: false,
                tiers: {
                  TEXT_ONLY: { enabled: false, surcharge: "50.00", feeVariantId: "gid://shopify/ProductVariant/501" },
                  IMAGE_OR_LOGO: { enabled: false, surcharge: "300.00", feeVariantId: "gid://shopify/ProductVariant/502" },
                },
              },
              DTF: { enabled: false, surcharge: "20.00", feeVariantId: "gid://shopify/ProductVariant/503" },
              SUBLIMATION: { enabled: true, surcharge: "0.00", feeVariantId: null },
              STICKER_PRINTING: { enabled: true, surcharge: "15.00", feeVariantId: "gid://shopify/ProductVariant/505" },
              LASER_ENGRAVING: {
                enabled: true,
                tiers: {
                  SMALL: { enabled: false, surcharge: "5.00", feeVariantId: null },
                  LARGE: { enabled: true, surcharge: "25.00", feeVariantId: "gid://shopify/ProductVariant/506" },
                },
              },
            },
          },
          embroiderySurcharge: parseSurchargeInput("0"),
          embroideryTextSurcharge: parseSurchargeInput("50"),
          embroideryImageSurcharge: parseSurchargeInput("300"),
          dtfSurcharge: parseSurchargeInput("20"),
          dtgSurcharge: parseSurchargeInput("30"),
          embroideryFeeVariantId: null,
          embroideryTextFeeVariantId: null,
          embroideryImageFeeVariantId: null,
          dtfFeeVariantId: null,
          dtgFeeVariantId: null,
        };
      },
    },
  };

  assert.deepEqual(
    (await getEnabledProductionMethodsForProduct("shop.test", "gid://shopify/Product/500", database as never)).map((method) => method.id),
    ["SUBLIMATION", "STICKER_PRINTING", "LASER_ENGRAVING"],
  );
  const sticker = await resolveProductionPricing({
    shop: "shop.test",
    productId: "gid://shopify/Product/500",
    method: "STICKER_PRINTING",
    database: database as never,
  });
  assert.equal(sticker.surchargeMinor, 1500n);
  assert.equal(sticker.feeVariantId, "gid://shopify/ProductVariant/505");
  const zeroCost = await resolveProductionPricing({
    shop: "shop.test",
    productId: "gid://shopify/Product/500",
    method: "SUBLIMATION",
    database: database as never,
  });
  assert.equal(zeroCost.surchargeMinor, 0n);
  assert.equal(zeroCost.feeRequired, false);
  const tieredFutureMethod = await resolveProductionPricing({
    shop: "shop.test",
    productId: "gid://shopify/Product/500",
    method: "LASER_ENGRAVING",
    pricingTier: "LARGE",
    database: database as never,
  });
  assert.equal(tieredFutureMethod.surchargeMinor, 2500n);
  assert.equal(tieredFutureMethod.artworkType, "LARGE");
  const bridge = await getProductionPricingBridgeForProduct(
    "shop.test",
    "gid://shopify/Product/500",
    database as never,
  );
  assert.deepEqual(
    bridge?.productionMethods.map((method) => method.id),
    ["SUBLIMATION", "STICKER_PRINTING", "LASER_ENGRAVING"],
  );
  assert.equal(bridge?.productionMethodPricing.STICKER_PRINTING.surchargeMinor, 1500);
  assert.equal(
    bridge?.productionMethodPricing.LASER_ENGRAVING.pricingTiers?.LARGE.surchargeMinor,
    2500,
  );
  assert.equal(bridge?.productionMethodPricing.DTF, undefined);
  await assert.rejects(
    () => resolveProductionPricing({
      shop: "shop.test",
      productId: "gid://shopify/Product/500",
      method: "DTF",
      database: database as never,
    }),
    /not enabled/i,
  );
});

test("production method surcharge validation accepts zero and two decimals", () => {
  assert.equal(parseSurchargeInput("0").toFixed(2), "0.00");
  assert.equal(parseSurchargeInput("50.25").toFixed(2), "50.25");
});

test("production method surcharge validation rejects negative and too many decimals", () => {
  assert.throws(() => parseSurchargeInput("-1"), /negative/i);
  assert.throws(() => parseSurchargeInput("1.234"), /two decimals/i);
});

test("canonical migration backfills pricing without touching financial history", () => {
  const migration = readFileSync(
    "prisma/migrations/20261026000000_canonical_product_production_methods/migration.sql",
    "utf8",
  );
  assert.match(migration, /UPDATE "PublicProductProductionPricing"/);
  assert.match(migration, /"TEXT_ONLY"/);
  assert.match(migration, /"IMAGE_OR_LOGO"/);
  assert.match(migration, /'SUBLIMATION'/);
  assert.match(migration, /'STICKER_PRINTING'/);
  assert.doesNotMatch(
    migration,
    /(?:UPDATE|DELETE|TRUNCATE)\s+"(?:CreatorSale|CreatorOrderItem|ReferralEarning|Payout|PayoutAllocation|OrderDesignSnapshot)"/i,
  );
});

test("embroidery subtype pricing uses configured Text and Image or Logo rates", () => {
  const pricing = {
    embroideryTextSurcharge: parseSurchargeInput("99.00"),
    embroideryImageSurcharge: parseSurchargeInput("300.00"),
    embroideryTextFeeVariantId: "gid://shopify/ProductVariant/991",
    embroideryImageFeeVariantId: "gid://shopify/ProductVariant/992",
  };
  assert.equal(pricingForEmbroiderySubtype(pricing, "TEXT_ONLY").toFixed(2), "99.00");
  assert.equal(pricingForEmbroiderySubtype(pricing, "IMAGE_OR_LOGO").toFixed(2), "300.00");
  assert.equal(feeVariantIdForEmbroiderySubtype(pricing, "TEXT_ONLY"), "gid://shopify/ProductVariant/991");
  assert.equal(feeVariantIdForEmbroiderySubtype(pricing, "IMAGE_OR_LOGO"), "gid://shopify/ProductVariant/992");
  assert.throws(() => pricingForEmbroiderySubtype(pricing, undefined), /validated embroidery artwork subtype/);
});

test("production method display config serializes minor units", () => {
  const value = JSON.parse(
    pricingConfigToMetafieldValue({
      currency: "SEK",
      methods: [
        {
          method: "EMBROIDERY",
          label: "Embroidery",
          surcharge: parseSurchargeInput("50.00"),
        },
        {
          method: "DTF",
          label: "DTF printing",
          surcharge: parseSurchargeInput("30.00"),
        },
        {
          method: "DTG",
          label: "DTG printing",
          surcharge: parseSurchargeInput("20.00"),
        },
      ],
      pricing: {
        embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
        embroideryTextSurcharge: parseSurchargeInput("55.00"),
        embroideryImageSurcharge: parseSurchargeInput("60.00"),
        embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
        embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
        dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
        dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
      },
    }),
  );

  assert.equal(value.version, 1);
  assert.equal(value.currency, "SEK");
  assert.equal(value.productionMethodPricing.EMBROIDERY.surchargeMinor, 0);
  assert.equal(value.productionMethodPricing.EMBROIDERY.feeVariantId, undefined);
  assert.equal(value.productionMethodPricing.EMBROIDERY.feeVariantGid, undefined);
  assert.equal(value.embroideryPricing.TEXT_ONLY.surchargeMinor, 5500);
  assert.equal(value.embroideryPricing.TEXT_ONLY.feeVariantId, "9004");
  assert.equal(value.embroideryPricing.IMAGE_OR_LOGO.surchargeMinor, 6000);
  assert.equal(value.embroideryPricing.IMAGE_OR_LOGO.feeVariantId, "9005");
  assert.equal(value.productionMethodPricing.DTF.surchargeMinor, 3000);
  assert.equal(value.productionMethodPricing.DTF.feeVariantId, "9002");
  assert.equal(value.productionMethodPricing.DTG.surchargeMinor, 2000);
  assert.equal(value.productionMethodPricing.DTG.feeVariantId, "9003");
  assert.equal(value.productionMethods[1].label, "DTF printing");
});

test("admin products page exposes pricing only for public customizable products", () => {
  const source = readFileSync("app/routes/app.products.tsx", "utf8");
  const matrix = readFileSync("app/components/production-pricing-matrix.tsx", "utf8");
  const appShell = readFileSync("app/routes/app.tsx", "utf8");

  assert.match(source, /save-production-pricing-batch/);
  assert.match(source, /add-production-method/);
  assert.doesNotMatch(source, /save-creator-production-pricing/);
  assert.doesNotMatch(source, /Creator Product Printing Methods/);
  assert.match(source, /ProductionPricingMatrix/);
  assert.match(matrix, /<table/);
  assert.match(matrix, /<thead>/);
  assert.match(matrix, /<tbody>/);
  assert.match(matrix, /type="checkbox"/);
  assert.match(matrix, /type="number"/);
  assert.match(matrix, /navigation\.state !== "idle"/);
  assert.match(matrix, /disabled=\{frozen\}/);
  assert.match(matrix, /disabled=\{frozen \|\| !enabled\}/);
  assert.match(matrix, /Save Changes/);
  assert.equal(matrix.match(/Save Changes/g)?.length, 1);
  assert.match(matrix, /Add Method \+/);
  assert.match(matrix, /role="dialog"/);
  assert.match(matrix, /name="methodName"/);
  assert.match(matrix, /name="methodCode"/);
  assert.match(matrix, /name="maxWidthCm"/);
  assert.match(matrix, /name="maxHeightCm"/);
  assert.match(source, /product_type/);
  assert.match(source, /product_origin/);
  assert.match(source, /design_mode/);
  assert.match(source, /tags/);
  assert.match(source, /global_customizable/);
  assert.match(source, /pitchprint-options/);
  assert.match(source, /isLegacyGlobalCustomizable/);
  assert.match(source, /Production Pricing/);
  assert.match(source, /listProductionMethodDefinitions/);
  assert.match(source, /productProductionConfiguration/);
  assert.match(source, /saveProductProductionConfiguration/);
  assert.match(appShell, /href="\/app\/products"[\s\S]*Products/);
});

test("admin products regression keeps pricing controls visible without an existing row", () => {
  const source = readFileSync("app/components/production-pricing-matrix.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(source, /productionPricingMatrixRows/);
  assert.match(source, /productionPricingMatrixColumns/);
  assert.match(source, /useState\(cell\.enabled\)/);
  assert.match(source, /useState\(cell\.surcharge\)/);
  assert.match(source, /type="hidden"[\s\S]*?value=\{price/);
  assert.match(styles, /\.production-pricing-matrix-scroll\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(styles, /\.production-pricing-product-cell\s*\{[\s\S]*?position:\s*sticky/);
});

test("admin product eligibility excludes creator buy-only products", () => {
  const source = readFileSync("app/routes/app.products.tsx", "utf8");

  assert.match(source, /product\.origin\?\.value === "creator"/);
  assert.match(source, /product\.mode\?\.value === "buy_only"/);
  assert.match(source, /!isCreatorFixed/);
});

test("admin keeps excluded internal products in a collapsed diagnostic", () => {
  const source = readFileSync("app/routes/app.products.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(
    source,
    /<details className="settings-card production-pricing-diagnostics">/,
  );
  assert.match(source, /Excluded products \(\{excludedProducts\.length\}\)/);
  assert.match(source, /<summary className="production-pricing-diagnostics-summary">/);
  assert.match(styles, /\.production-pricing-diagnostics-summary\s*\{/);
});

test("admin save flow surfaces Shopify sync failures", () => {
  const service = readFileSync(
    "app/services/production-method-pricing.server.ts",
    "utf8",
  );

  assert.match(service, /metafieldsSet/);
  assert.match(service, /partial/i);
  assert.match(service, /production_method_pricing/);
  assert.match(service, /Production fee sync failed:/);
  assert.doesNotMatch(service, /requiresShipping/);
});

test("saving production pricing is isolated per public product", async () => {
  const rows = new Map<string, PricingRow>();
  const database = {
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
    publicProductProductionPricing: {
      async findUnique(args: unknown) {
        const key = pricingProductKey(pricingArgs(args));
        return rows.get(key) || null;
      },
      async upsert(args: unknown) {
        const parsedArgs = pricingArgs(args);
        const key = pricingProductKey(parsedArgs);
        const existing = rows.get(key);
        const data = (
          existing ? { ...existing, ...parsedArgs.update } : {
            ...parsedArgs.create,
            id: parsedArgs.create.id ?? `pricing-${rows.size + 1}`,
            embroideryFeeVariantId: parsedArgs.create.embroideryFeeVariantId ?? null,
            dtfFeeVariantId: parsedArgs.create.dtfFeeVariantId ?? null,
            dtgFeeVariantId: parsedArgs.create.dtgFeeVariantId ?? null,
          }
        ) as PricingRow;
        rows.set(key, data);
        return data;
      },
      async update(args: unknown) {
        return updatePricingRow(rows, args);
      },
      async findMany() {
        return [...rows.values()];
      },
    },
  };
  const client = {
    async request<T>(_query: string, variables?: Record<string, unknown>) {
      const parsedVariables = shopifyPricingVariables(variables);
      if (parsedVariables?.metafields) return { metafieldsSet: { userErrors: [] } } as T;
      if (parsedVariables?.query) return { products: { nodes: [] } } as T;
      return {
        productSet: {
          product: {
            id: "gid://shopify/Product/fee",
            title: "Fee",
            parentProductId: { value: parsedVariables?.input?.metafields?.[0]?.value },
            variants: {
              nodes: [
                { id: "gid://shopify/ProductVariant/9001", title: "Embroidery Production Fee" },
                { id: "gid://shopify/ProductVariant/9004", title: "Embroidery Text Production Fee" },
                { id: "gid://shopify/ProductVariant/9005", title: "Embroidery Image or Logo Production Fee" },
                { id: "gid://shopify/ProductVariant/9002", title: "DTF Production Fee" },
                { id: "gid://shopify/ProductVariant/9003", title: "DTG Production Fee" },
              ],
            },
          },
          userErrors: [],
        },
      } as T;
    },
  };

  await saveProductionPricing(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      currency: "SEK",
      embroideryText: "50.00",
      embroideryImage: "60.00",
      dtf: "30.00",
      dtg: "20.00",
    },
    client,
    database,
  );
  await saveProductionPricing(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/101",
      currency: "SEK",
      embroideryText: "5.00",
      embroideryImage: "6.00",
      dtf: "3.00",
      dtg: "2.00",
    },
    client,
    database,
  );
  const legacyRow = rows.get("gid://shopify/Product/100");
  assert.ok(legacyRow);
  rows.set("gid://shopify/Product/100", {
    ...legacyRow,
    embroiderySurcharge: parseSurchargeInput("77.00"),
  });
  await saveProductionPricing(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      currency: "SEK",
      embroideryText: "70.00",
      embroideryImage: "80.00",
      dtf: "30.00",
      dtg: "20.00",
    },
    client,
    database,
  );

  const firstRow = rows.get("gid://shopify/Product/100");
  const secondRow = rows.get("gid://shopify/Product/101");
  assert.ok(firstRow);
  assert.ok(secondRow);
  assert.equal(firstRow.embroiderySurcharge.toFixed(2), "77.00");
  assert.equal(secondRow.embroiderySurcharge.toFixed(2), "0.00");
  assert.equal(firstRow.embroideryTextSurcharge.toFixed(2), "70.00");
  assert.equal(firstRow.embroideryImageSurcharge.toFixed(2), "80.00");
  assert.equal(secondRow.embroideryTextSurcharge.toFixed(2), "5.00");
  assert.equal(secondRow.embroideryImageSurcharge.toFixed(2), "6.00");
});

test("saving creator production pricing uses one shared creator key without product metafield sync", async () => {
  const rows = new Map<string, PricingRow>();
  let parentProductValue = "";
  let metafieldWrites = 0;
  const database = {
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
    publicProductProductionPricing: {
      async findUnique(args: unknown) {
        return rows.get(pricingProductKey(pricingArgs(args))) || null;
      },
      async findMany() {
        return [...rows.values()];
      },
      async upsert(args: unknown) {
        const parsedArgs = pricingArgs(args);
        const key = pricingProductKey(parsedArgs);
        const row = {
          ...(rows.get(key) || parsedArgs.create),
          id: rows.get(key)?.id ?? "creator-pricing",
          shopifyProductId: key,
          embroideryFeeVariantId: rows.get(key)?.embroideryFeeVariantId ?? null,
          dtfFeeVariantId: rows.get(key)?.dtfFeeVariantId ?? null,
          dtgFeeVariantId: rows.get(key)?.dtgFeeVariantId ?? null,
          ...parsedArgs.update,
        } as PricingRow;
        rows.set(key, row);
        return row;
      },
      async update(args: unknown) {
        return updatePricingRow(rows, args);
      },
    },
  };
  const client = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      if (query.includes("metafieldsSet")) {
        metafieldWrites += 1;
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("productSet")) {
        const input = productSetInputFromVariables(variables);
        parentProductValue = input.metafields?.[0]?.value || "";
        return {
          productSet: {
            product: {
              id: "gid://shopify/Product/creator-fee",
              title: "Creator Fee",
              parentProductId: { value: parentProductValue },
              variants: {
                nodes: [
                  { id: "gid://shopify/ProductVariant/9001", title: "Embroidery Production Fee" },
                  { id: "gid://shopify/ProductVariant/9004", title: "Embroidery Text Production Fee" },
                  { id: "gid://shopify/ProductVariant/9005", title: "Embroidery Image or Logo Production Fee" },
                  { id: "gid://shopify/ProductVariant/9002", title: "DTF Production Fee" },
                  { id: "gid://shopify/ProductVariant/9003", title: "DTG Production Fee" },
                ],
              },
            },
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("query CustomHouseOnlineStorePublication")) {
        return {
          product: { resourcePublications: { nodes: [] } },
          publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] },
        } as T;
      }
      if (query.includes("publishablePublish")) {
        return { publishablePublish: { userErrors: [] } } as T;
      }
      throw new Error("Unexpected Shopify call");
    },
  };

  const result = await saveCreatorProductionPricing(
    "shop.test",
    {
      currency: "SEK",
      embroidery: "10.00",
      dtf: "30.00",
      dtg: "0.00",
    },
    client,
    database,
  );

  assert.equal(result.status, "saved");
  assert.equal(parentProductValue, CREATOR_PRODUCTION_PRICING_PRODUCT_ID);
  assert.ok(rows.has(CREATOR_PRODUCTION_PRICING_PRODUCT_ID));
  assert.equal(rows.get(CREATOR_PRODUCTION_PRICING_PRODUCT_ID)?.dtfSurcharge.toFixed(2), "30.00");
  assert.equal(result.pricing.dtfFeeVariantId, "gid://shopify/ProductVariant/9002");
  assert.equal(metafieldWrites, 0);
});
test("admin save writes storefront pricing metafield after fee IDs are persisted", async () => {
  const rows = new Map<string, PricingRow>();
  let metafieldPayload: ProductionPricingBridgePayload | undefined;
  const database = {
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
    publicProductProductionPricing: {
      async findUnique(args: unknown) {
        return rows.get(pricingProductKey(pricingArgs(args))) || null;
      },
      async findMany() {
        return [...rows.values()];
      },
      async upsert(args: unknown) {
        const parsedArgs = pricingArgs(args);
        const key = pricingProductKey(parsedArgs);
        const row = {
          ...(rows.get(key) || parsedArgs.create),
          id: rows.get(key)?.id ?? parsedArgs.create.id ?? "pricing-a",
          shopifyProductId: key,
          embroideryFeeVariantId: rows.get(key)?.embroideryFeeVariantId ?? parsedArgs.create.embroideryFeeVariantId ?? null,
          dtfFeeVariantId: rows.get(key)?.dtfFeeVariantId ?? parsedArgs.create.dtfFeeVariantId ?? null,
          dtgFeeVariantId: rows.get(key)?.dtgFeeVariantId ?? parsedArgs.create.dtgFeeVariantId ?? null,
          ...parsedArgs.update,
        } as PricingRow;
        rows.set(key, row);
        return row;
      },
      async update(args: unknown) {
        return updatePricingRow(rows, args);
      },
    },
  };
  const client = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      const parsedVariables = shopifyPricingVariables(variables);
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("productSet")) {
        return {
          productSet: {
            product: {
              id: "gid://shopify/Product/fee",
              title: "Fee",
              parentProductId: { value: parsedVariables?.input?.metafields?.[0]?.value },
              variants: {
                nodes: [
                  { id: "gid://shopify/ProductVariant/9001", title: "Embroidery Production Fee" },
                  { id: "gid://shopify/ProductVariant/9004", title: "Embroidery Text Production Fee" },
                  { id: "gid://shopify/ProductVariant/9005", title: "Embroidery Image or Logo Production Fee" },
                  { id: "gid://shopify/ProductVariant/9002", title: "DTF Production Fee" },
                  { id: "gid://shopify/ProductVariant/9003", title: "DTG Production Fee" },
                ],
              },
            },
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("query CustomHouseOnlineStorePublication")) {
        return {
          product: {
            resourcePublications: {
              nodes: [
                {
                  isPublished: true,
                  publication: { id: "gid://shopify/Publication/online-store", name: "Online Store" },
                },
              ],
            },
          },
          publications: {
            nodes: [{ id: "gid://shopify/Publication/online-store", name: "Online Store" }],
          },
        } as T;
      }
      if (query.includes("metafieldsSet")) {
        const value = parsedVariables?.metafields?.[0]?.value;
        assert.ok(value);
        metafieldPayload = JSON.parse(value) as ProductionPricingBridgePayload;
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      throw new Error("Unexpected Shopify operation");
    },
  };

  const result = await saveProductionPricing(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      currency: "SEK",
      embroideryText: "10.00",
      embroideryImage: "15.00",
      dtf: "20.00",
      dtg: "30.00",
    },
    client,
    database,
  );

  const row = rows.get("gid://shopify/Product/100");
  assert.ok(row);
  assert.ok(metafieldPayload);
  assert.equal(result.status, "saved");
  assert.equal(row.embroideryFeeVariantId, null);
  assert.equal(row.embroideryTextFeeVariantId, "gid://shopify/ProductVariant/9004");
  assert.equal(row.embroideryImageFeeVariantId, "gid://shopify/ProductVariant/9005");
  assert.equal(row.dtfFeeVariantId, "gid://shopify/ProductVariant/9002");
  assert.equal(row.dtgFeeVariantId, "gid://shopify/ProductVariant/9003");
  assert.equal(metafieldPayload.productionMethods[0].surchargeMinor, 0);
  assert.equal(metafieldPayload.productionMethods[0].feeVariantId, undefined);
  assert.equal(metafieldPayload.productionMethods[0].feeVariantGid, undefined);
  assert.equal(metafieldPayload.embroideryPricing.TEXT_ONLY!.surchargeMinor, 1000);
  assert.equal(metafieldPayload.embroideryPricing.IMAGE_OR_LOGO!.surchargeMinor, 1500);
  assert.equal(metafieldPayload.productionMethods[1].feeVariantId, "9002");
  assert.equal(metafieldPayload.productionMethods[2].feeVariantId, "9003");
});

test("production fee sync uses supported productSet variant input and maps prices", async () => {
  const pricing = {
    id: "pricing-a",
    shopKey: "shop.test",
    shopifyProductId: "gid://shopify/Product/100",
    embroiderySurcharge: parseSurchargeInput("10.00"),
    embroideryTextSurcharge: parseSurchargeInput("11.00"),
    embroideryImageSurcharge: parseSurchargeInput("12.00"),
    dtfSurcharge: parseSurchargeInput("20.00"),
    dtgSurcharge: parseSurchargeInput("30.00"),
    embroideryFeeVariantId: null,
    embroideryTextFeeVariantId: null,
    embroideryImageFeeVariantId: null,
    dtfFeeVariantId: null,
    dtgFeeVariantId: null,
  };
  let productSetInput: ProductionFeeProductSetInput | undefined;
  const database = {
    publicProductProductionPricing: {
      async findUnique() {
        return pricing;
      },
      async findMany() {
        return [pricing];
      },
      async upsert() {
        return pricing;
      },
      async update(args: unknown) {
        return { ...pricing, ...pricingArgs(args).data };
      },
    },
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
  };
  const client = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("query CustomHouseOnlineStorePublication")) {
        return {
          product: {
            resourcePublications: {
              nodes: [
                {
                  isPublished: true,
                  publication: { id: "gid://shopify/Publication/online-store", name: "Online Store" },
                },
              ],
            },
          },
          publications: {
            nodes: [{ id: "gid://shopify/Publication/online-store", name: "Online Store" }],
          },
        } as T;
      }
      productSetInput = productSetInputFromVariables(variables);
      return {
        productSet: {
          product: {
            id: "gid://shopify/Product/fee",
            title: "Fee",
            parentProductId: { value: pricing.shopifyProductId },
            variants: {
              nodes: [
                { id: "gid://shopify/ProductVariant/9004", title: "Embroidery Text Production Fee" },
                { id: "gid://shopify/ProductVariant/9005", title: "Embroidery Image or Logo Production Fee" },
                { id: "gid://shopify/ProductVariant/9002", title: "DTF Production Fee" },
                { id: "gid://shopify/ProductVariant/9003", title: "DTG Production Fee" },
              ],
            },
          },
          userErrors: [],
        },
      } as T;
    },
  };

  const result = await syncProductionFeeMerchandise(
    "shop.test",
    pricing,
    client,
    database,
    { includeLegacyGenericEmbroidery: false },
  );

  assert.equal(result.synced, true);
  assert.ok(productSetInput);
  assert.deepEqual(
    productSetInput.variants.map((variant) => variant.price),
    ["11.00", "12.00", "20.00", "30.00"],
  );
  assert.equal(productSetInput.variants.some((variant) => "requiresShipping" in variant), false);
  assert.deepEqual(productSetInput.variants.map((variant) => variant.inventoryPolicy), [
    "CONTINUE",
    "CONTINUE",
    "CONTINUE",
    "CONTINUE",
  ]);
  assert.deepEqual(productSetInput.variants.map((variant) => variant.inventoryItem?.tracked), [
    false,
    false,
    false,
    false,
  ]);
  assert.equal(result.pricing.embroideryFeeVariantId, null);
  assert.equal(result.pricing.embroideryTextFeeVariantId, "gid://shopify/ProductVariant/9004");
  assert.equal(result.pricing.embroideryImageFeeVariantId, "gid://shopify/ProductVariant/9005");
  assert.equal(result.pricing.dtfFeeVariantId, "gid://shopify/ProductVariant/9002");
  assert.equal(result.pricing.dtgFeeVariantId, "gid://shopify/ProductVariant/9003");
});

type ProductionFeeProductSetInput = {
  status?: string;
  metafields: Array<{
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>;
  variants: Array<{ price: string; inventoryPolicy?: string; inventoryItem?: { tracked?: boolean } }>;
};

type PublishablePublishVariables = {
  id: string;
  input: Array<{ publicationId: string }>;
};

type ProductionFeeProductSetVariables = {
  input: ProductionFeeProductSetInput;
};

type ProductionFeeMockVariables =
  | ProductionFeeProductSetVariables
  | PublishablePublishVariables
  | { id: string };

function isProductSetVariables(
  variables: ProductionFeeMockVariables | undefined,
): variables is ProductionFeeProductSetVariables {
  return Boolean(variables && "input" in variables && !Array.isArray(variables.input));
}

function isPublishablePublishVariables(
  variables: ProductionFeeMockVariables | undefined,
): variables is PublishablePublishVariables {
  return Boolean(variables && "input" in variables && Array.isArray(variables.input));
}


test("production fee sync keeps fee product active and published to Online Store", async () => {
  const pricing = {
    id: "pricing-a",
    shopKey: "shop.test",
    shopifyProductId: "gid://shopify/Product/100",
    embroiderySurcharge: parseSurchargeInput("50.00"),
    embroideryTextSurcharge: parseSurchargeInput("50.00"),
    embroideryImageSurcharge: parseSurchargeInput("50.00"),
    dtfSurcharge: parseSurchargeInput("20.00"),
    dtgSurcharge: parseSurchargeInput("30.00"),
    embroideryFeeVariantId: null,
    embroideryTextFeeVariantId: null,
    embroideryImageFeeVariantId: null,
    dtfFeeVariantId: null,
    dtgFeeVariantId: null,
  };
  let productSetInput: ProductionFeeProductSetInput | undefined;
  let publishedInput: PublishablePublishVariables | undefined;
  const database = {
    publicProductProductionPricing: {
      async findUnique() {
        return pricing;
      },
      async findMany() {
        return [pricing];
      },
      async upsert() {
        return pricing;
      },
      async update(args: { data: Record<string, unknown> }) {
        return { ...pricing, ...args.data };
      },
    },
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
  };
  const client = {
    async request<T>(query: string, variables?: ProductionFeeMockVariables) {
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      if (query.includes("productSet")) {
        if (!isProductSetVariables(variables)) {
          throw new Error("Missing productSet variables");
        }
        productSetInput = variables.input;
        return {
          productSet: {
            product: {
              id: "gid://shopify/Product/fee",
              title: "Fee",
              parentProductId: { value: pricing.shopifyProductId },
              variants: {
                nodes: [
                  { id: "gid://shopify/ProductVariant/9004", title: "Embroidery Text Production Fee" },
                  { id: "gid://shopify/ProductVariant/9005", title: "Embroidery Image or Logo Production Fee" },
                  { id: "gid://shopify/ProductVariant/9002", title: "DTF Production Fee" },
                  { id: "gid://shopify/ProductVariant/9003", title: "DTG Production Fee" },
                ],
              },
            },
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("query CustomHouseOnlineStorePublication")) {
        return {
          product: { resourcePublications: { nodes: [] } },
          publications: {
            nodes: [{ id: "gid://shopify/Publication/online-store", name: "Online Store" }],
          },
        } as T;
      }
      if (query.includes("publishablePublish")) {
        if (!isPublishablePublishVariables(variables)) {
          throw new Error("Missing publish variables");
        }
        publishedInput = variables;
        return { publishablePublish: { userErrors: [] } } as T;
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };

  await syncProductionFeeMerchandise(
    "shop.test",
    pricing,
    client,
    database,
    { includeLegacyGenericEmbroidery: false },
  );

  assert.ok(productSetInput);
  assert.equal(productSetInput.status, "ACTIVE");
  assert.deepEqual(
    productSetInput.metafields.find(
      (metafield) => metafield.namespace === "seo" && metafield.key === "hidden",
    ),
    {
      namespace: "seo",
      key: "hidden",
      type: "number_integer",
      value: "1",
    },
  );
  assert.ok(publishedInput);
  assert.deepEqual(publishedInput, {
    id: "gid://shopify/Product/fee",
    input: [{ publicationId: "gid://shopify/Publication/online-store" }],
  });
});

test("Shopify GraphQL and user errors are surfaced clearly", async () => {
  const admin = {
    async graphql() {
      return new Response(
        JSON.stringify({
          errors: [
            {
              message:
                "Variable $input of type ProductSetInput! was provided invalid value for variants.0.requiresShipping (Field is not defined on ProductVariantSetInput)",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
  const client = new AdminGraphqlClient(admin);

  await assert.rejects(
    () =>
      client.request(
        "mutation CustomHouseProductionFeeProductSet($input: ProductSetInput!) { productSet(input: $input) { userErrors { message } } }",
        { input: {} },
      ),
    /requiresShipping.*ProductVariantSetInput/,
  );
  assert.throws(
    () =>
      throwUserErrors(
        [{ message: "Variant price is invalid." }],
        "Production fee merchandise",
      ),
    /Production fee merchandise failed: Variant price is invalid/,
  );
});

test("partial production fee failure keeps saved DB values", async () => {
  const rows = new Map<string, PricingRow>();
  const database = {
    productionMethodSetting: {
      async findMany() {
        return [];
      },
    },
    publicProductProductionPricing: {
      async findUnique(args: unknown) {
        return rows.get(pricingProductKey(pricingArgs(args))) || null;
      },
      async findMany() {
        return [...rows.values()];
      },
      async upsert(args: unknown) {
        const parsedArgs = pricingArgs(args);
        const key = pricingProductKey(parsedArgs);
        const row = {
          ...(rows.get(key) || parsedArgs.create),
          id: rows.get(key)?.id ?? parsedArgs.create.id ?? "pricing-a",
          shopifyProductId: key,
          embroideryFeeVariantId: rows.get(key)?.embroideryFeeVariantId ?? parsedArgs.create.embroideryFeeVariantId ?? null,
          dtfFeeVariantId: rows.get(key)?.dtfFeeVariantId ?? parsedArgs.create.dtfFeeVariantId ?? null,
          dtgFeeVariantId: rows.get(key)?.dtgFeeVariantId ?? parsedArgs.create.dtgFeeVariantId ?? null,
          ...parsedArgs.update,
        } as PricingRow;
        rows.set(key, row);
        return row;
      },
      async update() {
        throw new Error("Should not update mapping after fee failure");
      },
    },
  };
  const client = {
    async request<T>(query: string) {
      if (query.includes("metafieldsSet")) {
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("query CustomHouseProductionFeeProduct")) {
        return { products: { nodes: [] } } as T;
      }
      throw new Error("Variable $input invalid: requiresShipping is not defined.");
    },
  };

  const result = await saveProductionPricing(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      currency: "SEK",
      embroideryText: "10.00",
      embroideryImage: "15.00",
      dtf: "20.00",
      dtg: "30.00",
    },
    client,
    database,
  );

  const row = rows.get("gid://shopify/Product/100");
  assert.ok(row);
  assert.equal(result.status, "partial");
  assert.equal(result.shopifySynced, false);
  assert.equal(result.productionFeeSynced, false);
  assert.match(result.errors.join(" "), /Production fee sync failed: Variable \$input invalid/);
  assert.match(result.errors.join(" "), /Production fee variant IDs missing/);
  assert.equal(row.embroiderySurcharge.toFixed(2), "0.00");
  assert.equal(row.embroideryTextSurcharge.toFixed(2), "10.00");
  assert.equal(row.embroideryImageSurcharge.toFixed(2), "15.00");
  assert.equal(row.dtfSurcharge.toFixed(2), "20.00");
  assert.equal(row.dtgSurcharge.toFixed(2), "30.00");
});

const fakePricingDb = {
  publicProductProductionPricing: {
    async findUnique() {
      return {
        id: "pricing-a",
        shopKey: "shop.test",
        shopifyProductId: "gid://shopify/Product/100",
        embroiderySurcharge: parseSurchargeInput("50.00"),
        embroideryTextSurcharge: parseSurchargeInput("55.00"),
        embroideryImageSurcharge: parseSurchargeInput("60.00"),
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

const creatorLockedProductClient = {
  async request<T>() {
    return {
      product: {
        id: "gid://shopify/Product/200",
        productType: { value: "creator_fixed" },
        pitchprintEnabled: { value: "true" },
        origin: { value: "creator" },
        mode: { value: "buy_only" },
        variants: { nodes: [] },
      },
    } as T;
  },
};

const fakeProductClient = {
  async request<T>() {
    return {
      product: {
        id: "gid://shopify/Product/100",
        productType: { value: "global_customizable" },
        pitchprintEnabled: { value: "true" },
        origin: { value: "global" },
        mode: { value: "customizable" },
        variants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              legacyResourceId: "1",
              price: "100.00",
              availableForSale: true,
              selectedOptions: [
                { name: "Color", value: "Green" },
                { name: "Size", value: "S" },
              ],
            },
            {
              id: "gid://shopify/ProductVariant/2",
              legacyResourceId: "2",
              price: "110.00",
              availableForSale: true,
              selectedOptions: [
                { name: "Color", value: "White" },
                { name: "Size", value: "M" },
              ],
            },
          ],
        },
      },
    } as T;
  },
};

const canonicalPublicProductClient = {
  async request<T>() {
    return {
      product: {
        id: "gid://shopify/Product/100",
        productType: null,
        pitchprintEnabled: { value: "true" },
        origin: { value: "global" },
        mode: { value: "customizable" },
        variants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              legacyResourceId: "1",
              price: "100.00",
              availableForSale: true,
              selectedOptions: [
                { name: "Color", value: "Green" },
                { name: "Size", value: "S" },
              ],
            },
          ],
        },
      },
    } as T;
  },
};

const textArtworkSource = {
  pages: [
    {
      name: "Front",
      objects: [{ type: "Textbox", text: "hello" }],
    },
  ],
};

const imageArtworkSource = {
  pages: [
    {
      name: "Front",
      objects: [
        {
          type: "image",
          src: "https://cdn.example.com/logo.png",
          isUserArtwork: true,
        },
      ],
    },
  ],
};

function publicCartInput(overrides: Record<string, unknown>) {
  return {
    rightsAccepted: true,
    termsAccepted: true,
    artworkSource: textArtworkSource,
    artworkType: "TEXT_ONLY",
    placementCount: 1,
    ...overrides,
  };
}

test("trusted total uses actual variant prices plus method surcharge", () => {
  const result = calculateTrustedProductionTotal({
    surchargeMinor: 5000n,
    selections: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        priceMinor: 10000n,
        quantity: 1,
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        priceMinor: 11000n,
        quantity: 2,
      },
    ],
  });

  assert.equal(result.productSubtotalMinor, 32000n);
  assert.equal(result.productionSurchargeMinor, 15000n);
  assert.equal(result.totalQuantity, 3);
  assert.equal(result.totalMinor, 47000n);
});

test("trusted cart prep ignores browser price tampering", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "EMBROIDERY",
      browserSurchargeMinor: 1,
      browserTotalMinor: 2,
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      ],
    }),
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.totals.productSubtotalMinor, 10000n);
  assert.equal(cart.totals.productionSurchargeMinor, 5500n);
  assert.equal(cart.totals.totalMinor, 15500n);
  assert.equal(cart.items[0]?.id, "1");
  assert.equal(cart.items[1]?.id, "9004");
  assert.equal(cart.items[1]?.quantity, 1);
});

test("public production cart response payload is JSON serializable", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "EMBROIDERY",
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      ],
    }),
    fakeProductClient,
    fakePricingDb,
  );
  const payload = {
    items: cart.items,
    cart: jsonSafePublicProductionCart(cart),
  };

  assert.doesNotThrow(() => JSON.stringify(payload));
  assert.equal(payload.cart.totals.productSubtotalMinor, 10000);
  assert.equal(payload.cart.totals.productionSurchargeMinor, 5500);
  assert.equal(payload.cart.totals.totalMinor, 15500);
});

test("trusted cart prep accepts canonical global customizable PitchPrint products", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "DTF",
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      ],
    }),
    canonicalPublicProductClient,
    fakePricingDb,
  );

  assert.equal(cart.productionMethod, "DTF");
  assert.equal(cart.items[0]?.id, "1");
  assert.equal(cart.items[1]?.id, "9002");
});

test("production pricing bridge payload contains only trusted minor-unit values", () => {
  const payload = productionPricingBridgePayload({
    currency: "sek",
    methods: [
      {
        method: "EMBROIDERY",
        label: "Browser label ignored",
        surcharge: parseSurchargeInput("50.00"),
      },
      {
        method: "DTF",
        label: "Browser label ignored",
        surcharge: parseSurchargeInput("30.00"),
      },
      {
        method: "DTG",
        label: "Browser label ignored",
        surcharge: parseSurchargeInput("20.00"),
      },
    ],
  });

  assert.equal(payload.currency, "SEK");
  assert.equal(payload.productionMethods[0]?.id, "EMBROIDERY");
  assert.equal(payload.productionMethods[0]?.surchargeMinor, 0);
  assert.equal(payload.embroideryPricing.TEXT_ONLY!.surchargeMinor, 0);
  assert.equal(payload.embroideryPricing.IMAGE_OR_LOGO!.surchargeMinor, 0);
  assert.deepEqual(payload.productionMethods.slice(1), [
    { id: "DTF", label: "DTF printing", surchargeMinor: 3000 },
    { id: "DTG", label: "DTG printing", surchargeMinor: 2000 },
  ]);
  assert.equal(payload.productionMethodPricing.EMBROIDERY.surchargeMinor, 0);
});

test("creator buy-only products are excluded from production pricing cart prep", async () => {
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        publicCartInput({
          shopifyProductId: "gid://shopify/Product/200",
          pitchprintProjectId: "pp_123",
          productionMethod: "EMBROIDERY",
          selections: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
          ],
        }),
        creatorLockedProductClient,
        fakePricingDb,
      ),
    /public customizable products/i,
  );
});

test("trusted cart prep supports multi-size fee quantity", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "EMBROIDERY",
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
        { variantId: "gid://shopify/ProductVariant/2", quantity: 2 },
      ],
    }),
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.totals.totalMinor, 48500n);
  assert.equal(cart.items[0]?.quantity, 1);
  assert.equal(cart.items[1]?.quantity, 2);
  assert.equal(cart.items[2]?.quantity, 3);
});

test("trusted cart prep accepts the canonical public variantSelections contract", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    {
      ...publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "pp_variant_contract",
        productionMethod: "EMBROIDERY",
      }),
      selections: undefined,
      variantSelections: [
        {
          variantId: "gid://shopify/ProductVariant/1",
          variantGid: "gid://shopify/ProductVariant/1",
          color: "Green",
          size: "S",
          quantity: 1,
        },
        {
          variantId: "gid://shopify/ProductVariant/2",
          variantGid: "gid://shopify/ProductVariant/2",
          color: "White",
          size: "M",
          quantity: 2,
        },
      ],
    },
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.items[0]?.quantity, 1);
  assert.equal(cart.items[1]?.quantity, 2);
  assert.equal(cart.items[2]?.quantity, 3);
});

test("public embroidery text uses the authoritative Text fee mapping", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_text",
      pitchprintDesignId: "design_text",
      productionMethod: "EMBROIDERY",
      artworkType: "TEXT_ONLY",
      selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    }),
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.embroiderySubtype, "TEXT_ONLY");
  assert.equal(cart.feeVariantId, "gid://shopify/ProductVariant/9004");
  assert.equal(cart.totals.productionSurchargeMinor, 5500n);
  assert.equal(cart.items[1]?.id, "9004");
  assert.equal(cart.items[1]?.quantity, 1);
  const baseProperties = cart.items[0]?.properties as Record<string, string>;
  assert.equal(baseProperties._design_id, "design_text");
  assert.equal(baseProperties._customhouse_public_customize, "true");
  assert.match(baseProperties._customhouse_public_cart_validation, /"feeRequired":true/);
});

test("public embroidery image uses the authoritative Image or Logo fee mapping", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_image",
      productionMethod: "EMBROIDERY",
      artworkType: "IMAGE_LOGO",
      embroiderySubtype: "IMAGE_LOGO",
      artworkSource: imageArtworkSource,
      selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    }),
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.embroiderySubtype, "IMAGE_OR_LOGO");
  assert.equal(cart.feeVariantId, "gid://shopify/ProductVariant/9005");
  assert.equal(cart.totals.productionSurchargeMinor, 6000n);
  assert.equal(cart.items[1]?.id, "9005");
});

test("public artwork classification prevents an image from receiving the Text fee", async () => {
  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "pp_tampered",
        productionMethod: "EMBROIDERY",
        embroiderySubtype: "TEXT_ONLY",
        artworkSource: imageArtworkSource,
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      fakeProductClient,
      fakePricingDb,
    ),
    /artwork type does not match/i,
  );
});

test("public front and back artwork multiplies aggregate quantity exactly once", async () => {
  const frontAndBack = {
    pages: [
      { name: "Front", objects: [{ type: "Textbox", text: "front" }] },
      { name: "Back", objects: [{ type: "Textbox", text: "back" }] },
    ],
  };
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_front_back",
      productionMethod: "EMBROIDERY",
      artworkSource: frontAndBack,
      placementCount: 2,
      totalQuantity: 2,
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
        { variantId: "gid://shopify/ProductVariant/2", quantity: 1 },
      ],
    }),
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.placementCount, 2);
  assert.equal(cart.totals.totalQuantity, 2);
  assert.equal(cart.totals.productionFeeQuantity, 4);
  assert.equal(cart.items[2]?.quantity, 4);
});

test("public DTF and DTG use their authoritative fee mappings", async () => {
  for (const [method, feeVariantId, surchargeMinor] of [
    ["DTF", "gid://shopify/ProductVariant/9002", 3000n],
    ["DTG", "gid://shopify/ProductVariant/9003", 2000n],
  ] as const) {
    const cart = await preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: `pp_${method.toLowerCase()}`,
        productionMethod: method,
        artworkType: null,
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      fakeProductClient,
      fakePricingDb,
    );
    assert.equal(cart.feeVariantId, feeVariantId);
    assert.equal(cart.totals.productionSurchargeMinor, surchargeMinor);
  }
});

test("Sticker Printing uses the generic public cart path and canonical fee mapping", async () => {
  const stickerPricingDb = {
    productionMethodSetting: {
      async findMany() {
        return [
          { method: "EMBROIDERY", label: "Embroidery", description: "", enabled: true, pricingBehavior: "TIERED" },
          { method: "DTF", label: "DTF printing", description: "", enabled: true, pricingBehavior: "SINGLE" },
          { method: "DTG", label: "DTG printing", description: "", enabled: true, pricingBehavior: "SINGLE" },
          { method: "SUBLIMATION", label: "Sublimation", description: "", enabled: true, pricingBehavior: "SINGLE" },
          { method: "STICKER_PRINTING", label: "Sticker Printing", description: "", enabled: true, pricingBehavior: "SINGLE" },
        ];
      },
    },
    publicProductProductionPricing: {
      async findUnique() {
        return {
          id: "pricing-sticker",
          shopKey: "shop.test",
          shopifyProductId: "gid://shopify/Product/100",
          currency: "SEK",
          methodConfigurations: {
            version: 2,
            methods: {
              EMBROIDERY: {
                enabled: false,
                tiers: {
                  TEXT_ONLY: { enabled: false, surcharge: "50.00", feeVariantId: null },
                  IMAGE_OR_LOGO: { enabled: false, surcharge: "300.00", feeVariantId: null },
                },
              },
              DTF: { enabled: false, surcharge: "20.00", feeVariantId: null },
              DTG: { enabled: false, surcharge: "30.00", feeVariantId: null },
              SUBLIMATION: { enabled: false, surcharge: "0.00", feeVariantId: null },
              STICKER_PRINTING: {
                enabled: true,
                surcharge: "15.00",
                feeVariantId: "gid://shopify/ProductVariant/9505",
              },
            },
          },
          embroiderySurcharge: parseSurchargeInput("0"),
          embroideryTextSurcharge: parseSurchargeInput("50"),
          embroideryImageSurcharge: parseSurchargeInput("300"),
          dtfSurcharge: parseSurchargeInput("20"),
          dtgSurcharge: parseSurchargeInput("30"),
          embroideryFeeVariantId: null,
          embroideryTextFeeVariantId: null,
          embroideryImageFeeVariantId: null,
          dtfFeeVariantId: null,
          dtgFeeVariantId: null,
        };
      },
    },
  };
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_sticker",
      productionMethod: "STICKER_PRINTING",
      artworkType: null,
      selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }],
    }),
    fakeProductClient,
    stickerPricingDb as never,
  );

  assert.equal(cart.productionMethod, "STICKER_PRINTING");
  assert.equal(cart.totals.productionSurchargeMinor, 3000n);
  assert.equal(cart.items[1]?.id, "9505");
  assert.equal(cart.items[1]?.quantity, 2);
  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "pp_sticker_tampered",
        productionMethod: "DTF",
        artworkType: null,
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      fakeProductClient,
      stickerPricingDb as never,
    ),
    /not enabled/i,
  );
});

test("public multi-color variant selections aggregate one production fee", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_colors",
      productionMethod: "EMBROIDERY",
      selectedColors: ["Navy", "White"],
      totalQuantity: 3,
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 2 },
        { variantId: "gid://shopify/ProductVariant/2", quantity: 1 },
      ],
    }),
    fakeProductClient,
    fakePricingDb,
  );
  assert.equal(cart.items.length, 3);
  assert.equal(cart.items[2]?.id, "9004");
  assert.equal(cart.items[2]?.quantity, 3);
});

test("enabled zero-cost public subtype succeeds without fee merchandise", async () => {
  const missingPricingDb = {
    publicProductProductionPricing: {
      async findUnique() {
        const pricing = await fakePricingDb.publicProductProductionPricing.findUnique();
        return {
          ...pricing,
          embroideryImageSurcharge: parseSurchargeInput("0.00"),
          embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
        };
      },
    },
  };
  const cart = await preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "pp_missing_image_pricing",
        productionMethod: "EMBROIDERY",
        artworkSource: imageArtworkSource,
        artworkType: "IMAGE_OR_LOGO",
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      fakeProductClient,
      missingPricingDb,
  );
  assert.equal(cart.totals.productionSurchargeMinor, 0n);
  assert.equal(cart.feeRequired, false);
  assert.equal(cart.feeVariantId, null);
  const baseProperties = cart.items[0]?.properties as Record<string, string>;
  const contract = JSON.parse(
    baseProperties._customhouse_public_cart_validation || "{}",
  );
  assert.equal(contract.feeVariantId, null);
  assert.equal(cart.items.length, 1);
});

test("public legal confirmations are required and preserved", async () => {
  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      {
        ...publicCartInput({
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_legal",
          productionMethod: "DTF",
          selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
        }),
        rightsAccepted: false,
      },
      fakeProductClient,
      fakePricingDb,
    ),
    /rights to use this design/i,
  );

  const cart = await preparePublicProductionCart(
    "shop.test",
    publicCartInput({
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_legal_ok",
      productionMethod: "DTF",
      selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    }),
    fakeProductClient,
    fakePricingDb,
  );
  const properties = cart.items[0]?.properties as Record<string, string>;
  assert.equal(properties._customhouse_non_return_acknowledgement, "Accepted");
  assert.equal(properties._customhouse_terms_acknowledgement, "Accepted");
});

test("trusted cart prep rejects invalid method quantity and wrong product variants", async () => {
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        publicCartInput({
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "SCREENPRINT",
          selections: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
          ],
        }),
        fakeProductClient,
        fakePricingDb,
      ),
    /valid printing method/i,
  );
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        publicCartInput({
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "EMBROIDERY",
          selections: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 0 },
          ],
        }),
        fakeProductClient,
        fakePricingDb,
      ),
    /valid quantity/i,
  );
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        publicCartInput({
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "EMBROIDERY",
          selections: [
            { variantId: "gid://shopify/ProductVariant/999", quantity: 1 },
          ],
        }),
        fakeProductClient,
        fakePricingDb,
      ),
    /valid variant/i,
  );
});

test("trusted cart prep rejects missing PitchPrint project identity", async () => {
  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "",
        productionMethod: "EMBROIDERY",
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      fakeProductClient,
      fakePricingDb,
    ),
    /save your PitchPrint design/i,
  );
});

test("trusted cart prep rejects manipulated color and size claims", async () => {
  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      {
        ...publicCartInput({
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_manipulated_options",
          productionMethod: "EMBROIDERY",
        }),
        variantSelections: [
          {
            variantId: "gid://shopify/ProductVariant/1",
            color: "White",
            size: "XL",
            quantity: 1,
          },
        ],
      },
      fakeProductClient,
      fakePricingDb,
    ),
    /variant options do not match/i,
  );
});

test("trusted cart prep rejects an unavailable selected variant", async () => {
  const unavailableVariantClient = {
    async request<T>() {
      return {
        product: {
          id: "gid://shopify/Product/100",
          productType: { value: "global_customizable" },
          pitchprintEnabled: { value: "true" },
          origin: { value: "global" },
          mode: { value: "customizable" },
          variants: {
            nodes: [
              {
                id: "gid://shopify/ProductVariant/1",
                legacyResourceId: "1",
                price: "100.00",
                availableForSale: false,
                selectedOptions: [
                  { name: "Color", value: "Green" },
                  { name: "Size", value: "S" },
                ],
              },
            ],
          },
        },
      } as T;
    },
  };

  await assert.rejects(
    () => preparePublicProductionCart(
      "shop.test",
      publicCartInput({
        shopifyProductId: "gid://shopify/Product/100",
        pitchprintProjectId: "pp_unavailable",
        productionMethod: "EMBROIDERY",
        selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      }),
      unavailableVariantClient,
      fakePricingDb,
    ),
    /available variant/i,
  );
});

test("hidden fee merchandise sync is app managed per public product", () => {
  const service = readFileSync(
    "app/services/production-method-pricing.server.ts",
    "utf8",
  );

  assert.match(service, /syncProductionFeeMerchandise/);
  assert.match(service, /customhouse-production-fee/);
  assert.match(service, /production_fee_parent_product_id/);
  assert.match(service, /productSet/);
  assert.match(service, /Embroidery Production Fee/);
  assert.match(service, /DTF Production Fee/);
  assert.match(service, /DTG Production Fee/);
  assert.match(service, /embroideryFeeVariantId/);
  assert.match(service, /dtfFeeVariantId/);
  assert.match(service, /dtgFeeVariantId/);
});

test("storefront PitchPrint bridge exposes trusted product pricing config", () => {
  const proxyRoute = readFileSync(
    "app/routes/proxy.api.public-production-cart.tsx",
    "utf8",
  );
  const productDetails = readFileSync("theme-live-cart/blocks/_product-details.liquid", "utf8");
  const handoff = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );

  assert.match(proxyRoute, /proxyContext\(request,\s*false\)/);
  assert.match(proxyRoute, /preparePublicProductionCart/);
  assert.match(proxyRoute, /apiData/);
  assert.match(productDetails, /product\.metafields\.customhouse\.production_method_pricing\.value/);
  assert.match(productDetails, /data-customhouse-production-pricing-json/);
  assert.match(productDetails, /data-product-variants/);
  assert.match(productDetails, /data-product-handle/);
  assert.match(productDetails, /data-selected-color/);
  assert.match(productDetails, /data-selected-size/);
  assert.match(productDetails, /data-initial-variant-id/);
  assert.match(productDetails, /is_pitchprint_required_product and production_method_pricing != blank/);
  assert.match(handoff, /window\.CustomHousePublicPitchPrintConfig = config/);
  assert.match(handoff, /CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST/);
  assert.match(handoff, /CUSTOMHOUSE_PP_ORDER_CONFIG_DATA/);
  assert.match(handoff, /CUSTOMHOUSE_PP_CART_READY/);
  assert.match(handoff, /customhouse:pitchprint-order-config-request/);
  assert.match(handoff, /surchargeMinor/);
  assert.match(handoff, /feeVariantId/);
  assert.match(handoff, /feeVariantGid/);
  assert.match(handoff, /embroiderySubtypes/);
  assert.match(handoff, /TEXT_ONLY/);
  assert.match(handoff, /IMAGE_OR_LOGO/);
  assert.match(handoff, /PUBLIC_EMBROIDERY_TEXT_PRICE/);
  assert.match(handoff, /PUBLIC_EMBROIDERY_IMAGE_PRICE/);
  assert.match(handoff, /PUBLIC_DTF_PRICE/);
  assert.match(handoff, /PUBLIC_DTG_PRICE/);
  assert.match(handoff, /PUBLIC_GENERIC_EMBROIDERY_PRICE_USED: false/);
  assert.match(handoff, /normalizeProductionMethods = publicContract.normalizeProductionMethods/);
  assert.match(handoff, /CUSTOMHOUSE_PP_FULL_PRODUCT_CONFIG/);
  assert.doesNotMatch(handoff, /CUSTOMHOUSE_PP_PRODUCTION_METHODS/);
  assert.doesNotMatch(handoff, /browserSurchargeMinor/);
  assert.doesNotMatch(handoff, /browserTotalMinor/);
});

test("storefront PitchPrint handoff sends saved designs through trusted public cart prep", () => {
  const handoff = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );

  assert.match(handoff, /\/apps\/customhouse\/api\/public-production-cart/);
  assert.match(handoff, /productionMethod/);
  assert.match(handoff, /embroiderySubtype/);
  assert.match(handoff, /placementCount/);
  assert.match(handoff, /legalConfirmations/);
  assert.match(handoff, /artworkSource/);
  assert.match(handoff, /selections/);
  assert.match(handoff, /Printing method/);
  assert.match(handoff, /Printing charge \/ item/);
  assert.match(handoff, /preparedData\.items/);
  assert.match(handoff, /prepared\?\.data\s*\|\|\s*prepared/);
  assert.match(handoff, /_customhouse_fee_key/);
  assert.doesNotMatch(handoff, /pitchprint-creator-setup-ready/);
  assert.doesNotMatch(handoff, /items:\s*\[\s*\{\s*id:\s*variantId,\s*quantity,\s*properties,\s*\}\s*,?\s*\]/);
});

test("public product page keeps printing method inside PitchPrint handoff", () => {
  const productDetails = readFileSync("theme-live-cart/blocks/_product-details.liquid", "utf8");
  const handoff = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );
  const contract = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
    "utf8",
  );

  assert.doesNotMatch(productDetails, /marked-product-actions__block--production-method/);
  assert.doesNotMatch(productDetails, /name="customhouse_production_method"/);
  assert.match(productDetails, /data-customhouse-production-pricing-json/);
  assert.match(handoff, /findProductionMethodDeep/);
  assert.match(handoff, /buildCartSelectionContract/);
  assert.match(handoff, /supportsMultipleSelections/);
  assert.match(handoff, /optionGroups/);
  assert.match(contract, /collectCartSelections/);
  assert.doesNotMatch(handoff, /checkedProductionMethod/);
});

test("theme cart keeps production fee lines paired with customized base lines", () => {
  const cartItems = readFileSync(
    "theme-live-cart/assets/component-cart-items.js",
    "utf8",
  );
  const customCart = readFileSync(
    "theme-live-cart/sections/main-cart.liquid",
    "utf8",
  );
  const drawerCart = readFileSync(
    "theme-live-cart/snippets/cart-products.liquid",
    "utf8",
  );

  assert.match(cartItems, /reconcileCustomHouseProductionFees/);
  assert.match(cartItems, /_customhouse_production_fee/);
  assert.match(cartItems, /_customhouse_fee_key/);
  assert.match(cartItems, /cart_update_url/);
  assert.match(customCart, /Printing method/);
  assert.match(customCart, /Printing charge/);
  assert.match(customCart, /customhouse_visible_item_count/);
  assert.match(customCart, /unless is_customhouse_production_fee/);
  assert.doesNotMatch(customCart, /customhouse-cart__item--production-fee/);
  assert.match(drawerCart, /Printing method/);
  assert.match(drawerCart, /Printing charge/);
  assert.match(drawerCart, /cart-items__table-row--production-fee/);
});

test("storefront bridge maps saved 10 20 30 values to PitchPrint minor-unit payload", () => {
  const payload = productionPricingBridgePayload({
    currency: "SEK",
    methods: [
      { method: "EMBROIDERY", label: "Embroidery", surcharge: parseSurchargeInput("10") },
      { method: "DTF", label: "DTF printing", surcharge: parseSurchargeInput("20") },
      { method: "DTG", label: "DTG printing", surcharge: parseSurchargeInput("30") },
    ],
    pricing: {
      embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
      embroideryTextSurcharge: parseSurchargeInput("40"),
      embroideryImageSurcharge: parseSurchargeInput("50"),
      embroideryTextFeeVariantId: "gid://shopify/ProductVariant/9004",
      embroideryImageFeeVariantId: "gid://shopify/ProductVariant/9005",
      dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
      dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
    },
  });

  const productionMethods = payload.productionMethods.map((method) => ({
    id: method.id.toLowerCase(),
    label: method.label,
    surchargeMinor: method.surchargeMinor,
    feeVariantId: method.feeVariantId,
    feeVariantGid: method.feeVariantGid,
  }));

  assert.deepEqual(productionMethods, [
    {
      id: "embroidery",
      label: "Embroidery",
      surchargeMinor: 0,
      feeVariantId: undefined,
      feeVariantGid: undefined,
    },
    {
      id: "dtf",
      label: "DTF printing",
      surchargeMinor: 2000,
      feeVariantId: "9002",
      feeVariantGid: "gid://shopify/ProductVariant/9002",
    },
    {
      id: "dtg",
      label: "DTG printing",
      surchargeMinor: 3000,
      feeVariantId: "9003",
      feeVariantGid: "gid://shopify/ProductVariant/9003",
    },
  ]);
});

test("theme cart sync is scoped to production fee line properties", () => {
  const cartItems = readFileSync(
    "theme-live-cart/assets/component-cart-items.js",
    "utf8",
  );

  assert.doesNotMatch(cartItems, /_creator_product_id/);
  assert.doesNotMatch(cartItems, /product_origin/);
  assert.doesNotMatch(cartItems, /creator/);
});

test("global collection grid excludes Creator buy-only products by canonical metafields", () => {
  const collectionGrid = readFileSync(
    "theme-live-cart/sections/customhouse-collection-grid.liquid",
    "utf8",
  );

  assert.match(collectionGrid, /product\.metafields\.customhouse\.product_origin/);
  assert.match(collectionGrid, /product_origin == 'creator'/);
  assert.match(collectionGrid, /product\.metafields\.customhouse\.design_mode/);
  assert.match(collectionGrid, /design_mode == 'buy_only'/);
  assert.match(collectionGrid, /product\.metafields\.customhouse\.product_type/);
  assert.match(collectionGrid, /product_type == 'creator_fixed'/);
  assert.match(collectionGrid, /unless is_creator_catalog_product/);
  assert.doesNotMatch(collectionGrid, /unless section\.settings\.exclude_creator_products_from_global and is_creator_catalog_product/);
  assert.doesNotMatch(collectionGrid, /title contains|handle contains|CreatorProduct/i);
});

import { Prisma, type ProductionMethod } from "@prisma/client";
import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";

export const PRODUCTION_METHODS = ["EMBROIDERY", "DTF", "DTG"] as const;
export const CREATOR_PRODUCTION_PRICING_PRODUCT_ID = "customhouse:creator-products";

export type ProductionMethodCode = (typeof PRODUCTION_METHODS)[number];
export const EMBROIDERY_SUBTYPES = ["TEXT_ONLY", "IMAGE_OR_LOGO"] as const;
export type EmbroiderySubtype = (typeof EMBROIDERY_SUBTYPES)[number];

type ProductionPricingDb = {
  publicProductProductionPricing: {
    findUnique(args: unknown): Promise<PublicProductProductionPricingRecord | null>;
    findMany(args: unknown): Promise<PublicProductProductionPricingRecord[]>;
    upsert(args: unknown): Promise<PublicProductProductionPricingRecord>;
    update(args: unknown): Promise<PublicProductProductionPricingRecord>;
  };
  productionMethodSetting: {
    findMany(args: unknown): Promise<ProductionMethodSettingRecord[]>;
  };
};

export type PublicProductProductionPricingRecord = {
  id: string;
  shopKey: string;
  shopifyProductId: string;
  embroiderySurcharge: Prisma.Decimal;
  embroideryTextSurcharge: Prisma.Decimal;
  embroideryImageSurcharge: Prisma.Decimal;
  dtfSurcharge: Prisma.Decimal;
  dtgSurcharge: Prisma.Decimal;
  embroideryFeeVariantId: string | null;
  embroideryTextFeeVariantId: string | null;
  embroideryImageFeeVariantId: string | null;
  dtfFeeVariantId: string | null;
  dtgFeeVariantId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type ProductionMethodSettingRecord = {
  method: ProductionMethod | ProductionMethodCode;
  label: string;
  description: string;
  enabled: boolean;
};

export type SaveProductionPricingInput = {
  shopifyProductId: string;
  currency: string;
  embroidery: unknown;
  embroideryText?: unknown;
  embroideryImage?: unknown;
  dtf: unknown;
  dtg: unknown;
};

export type SaveCreatorProductionPricingInput = Omit<SaveProductionPricingInput, "shopifyProductId">;

export type ProductionPricingSyncState = {
  saved: boolean;
  shopifySynced: boolean;
  productionFeeSynced: boolean;
  status: "saved" | "partial";
  message: string;
  errors: string[];
  pricing: PublicProductProductionPricingRecord;
};

type PricingConfigMethod = {
  method: ProductionMethodCode;
  label: string;
  surcharge: Prisma.Decimal;
};

export type ProductionPricingBridgeMethod = {
  id: ProductionMethodCode;
  label: string;
  surchargeMinor: number;
  feeVariantId?: string;
  feeVariantGid?: string;
};

export type ProductionPricingBridgePayload = {
  version: 1;
  currency: string;
  productionMethods: ProductionPricingBridgeMethod[];
  productionMethodPricing: Record<
    ProductionMethodCode,
    {
      label: string;
      surchargeMinor: number;
      feeVariantId?: string;
      feeVariantGid?: string;
    }
  >;
};

export const FEE_PRODUCT_TAG = "customhouse-production-fee";
export const FEE_PRODUCT_TITLE_PREFIX = "Custom House Production Fee";
export const FEE_PRODUCT_TYPE = "production_fee";
const FEE_PRODUCT_OPTION_NAME = "Production Method";
const FEE_PRODUCT_METAFIELD_KEY = "production_fee_parent_product_id";
const METHOD_LABELS: Record<ProductionMethodCode, string> = {
  EMBROIDERY: "Embroidery",
  DTF: "DTF printing",
  DTG: "DTG printing",
};

type ProductionFeeVariantNode = {
  id: string;
  title: string;
};

type ProductionFeeProductNode = {
  id: string;
  title: string;
  variants: { nodes: ProductionFeeVariantNode[] };
  parentProductId: { value: string } | null;
};

type PublicationNode = {
  id: string;
  name: string;
};

function methodKey(method: string) {
  return method.trim().toUpperCase();
}

function numericShopifyId(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text.match(/(\d+)$/)?.[1] || "";
}

export function cleanProductionMethod(method: unknown): ProductionMethodCode {
  const normalized = typeof method === "string" ? methodKey(method) : "";
  if (PRODUCTION_METHODS.includes(normalized as ProductionMethodCode)) {
    return normalized as ProductionMethodCode;
  }
  throw new DomainError(
    "INVALID_PRODUCTION_METHOD",
    "Choose a valid printing method.",
    422,
  );
}

export function parseSurchargeInput(value: unknown): Prisma.Decimal {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new DomainError(
      "INVALID_SURCHARGE",
      "Production pricing must be a non-negative amount with maximum two decimals.",
      422,
    );
  }
  const decimal = new Prisma.Decimal(text);
  if (decimal.isNegative()) {
    throw new DomainError(
      "INVALID_SURCHARGE",
      "Production pricing cannot be negative.",
      422,
    );
  }
  return decimal.toDecimalPlaces(2);
}

export function decimalToMinor(amount: Prisma.Decimal): bigint {
  return decimalMoneyToMinorUnits(amount);
}

export function pricingForMethod(
  pricing: Pick<
    PublicProductProductionPricingRecord,
    "embroiderySurcharge" | "dtfSurcharge" | "dtgSurcharge"
  >,
  method: unknown,
): Prisma.Decimal {
  switch (cleanProductionMethod(method)) {
    case "EMBROIDERY":
      return pricing.embroiderySurcharge;
    case "DTF":
      return pricing.dtfSurcharge;
    case "DTG":
      return pricing.dtgSurcharge;
  }
}

export function cleanEmbroiderySubtype(value: unknown): EmbroiderySubtype {
  const normalized = String(value || "").trim().toUpperCase();
  if (EMBROIDERY_SUBTYPES.includes(normalized as EmbroiderySubtype)) {
    return normalized as EmbroiderySubtype;
  }
  throw new DomainError(
    "INVALID_EMBROIDERY_SUBTYPE",
    "A validated embroidery artwork subtype is required.",
    422,
  );
}

export function pricingForEmbroiderySubtype(
  pricing: Pick<PublicProductProductionPricingRecord, "embroideryTextSurcharge" | "embroideryImageSurcharge">,
  subtype: unknown,
) {
  return cleanEmbroiderySubtype(subtype) === "TEXT_ONLY"
    ? pricing.embroideryTextSurcharge
    : pricing.embroideryImageSurcharge;
}

export function feeVariantIdForEmbroiderySubtype(
  pricing: Pick<PublicProductProductionPricingRecord, "embroideryTextFeeVariantId" | "embroideryImageFeeVariantId">,
  subtype: unknown,
) {
  return cleanEmbroiderySubtype(subtype) === "TEXT_ONLY"
    ? pricing.embroideryTextFeeVariantId
    : pricing.embroideryImageFeeVariantId;
}

export function feeVariantIdForMethod(
  pricing: Pick<
    PublicProductProductionPricingRecord,
    "embroideryFeeVariantId" | "dtfFeeVariantId" | "dtgFeeVariantId"
  >,
  method: unknown,
) {
  switch (cleanProductionMethod(method)) {
    case "EMBROIDERY":
      return pricing.embroideryFeeVariantId;
    case "DTF":
      return pricing.dtfFeeVariantId;
    case "DTG":
      return pricing.dtgFeeVariantId;
  }
}

export function pricingConfigToMetafieldValue(input: {
  currency: string;
  methods: PricingConfigMethod[];
  pricing?: Pick<
    PublicProductProductionPricingRecord,
    "embroideryFeeVariantId" | "dtfFeeVariantId" | "dtgFeeVariantId"
  >;
}) {
  return safeJson(productionPricingBridgePayload(input));
}

export function productionPricingBridgePayload(input: {
  currency: string;
  methods: PricingConfigMethod[];
  pricing?: Pick<
    PublicProductProductionPricingRecord,
    "embroideryFeeVariantId" | "dtfFeeVariantId" | "dtgFeeVariantId"
  >;
}): ProductionPricingBridgePayload {
  const currency = input.currency.trim().toUpperCase() || "SEK";
  const byMethod = new Map(
    input.methods.map((method) => [cleanProductionMethod(method.method), method]),
  );
  const productionMethods = PRODUCTION_METHODS.map((method) => {
    const config = byMethod.get(method);
    const label = METHOD_LABELS[method];
    const feeVariantGid = feeVariantIdForMethod(input.pricing ?? {
      embroideryFeeVariantId: null,
      dtfFeeVariantId: null,
      dtgFeeVariantId: null,
    }, method) ?? "";
    const feeVariantId = numericShopifyId(feeVariantGid);
    const payload: ProductionPricingBridgeMethod = {
      id: method,
      label,
      surchargeMinor: Number(decimalToMinor(config?.surcharge ?? new Prisma.Decimal(0))),
    };
    if (feeVariantId) payload.feeVariantId = feeVariantId;
    if (feeVariantGid) payload.feeVariantGid = feeVariantGid;
    return payload;
  });
  return {
    version: 1,
    currency,
    productionMethods,
    productionMethodPricing: Object.fromEntries(
      productionMethods.map((method) => [
        method.id,
        {
          label: method.label,
          surchargeMinor: method.surchargeMinor,
          ...(method.feeVariantId ? { feeVariantId: method.feeVariantId } : {}),
          ...(method.feeVariantGid ? { feeVariantGid: method.feeVariantGid } : {}),
        },
      ]),
    ) as ProductionPricingBridgePayload["productionMethodPricing"],
  };
}

function missingRequiredFeeVariantMethods(payload: ProductionPricingBridgePayload) {
  return payload.productionMethods
    .filter((method) => method.surchargeMinor > 0 && !method.feeVariantId)
    .map((method) => method.label);
}

async function methodSettings(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  const rows = await database.productionMethodSetting.findMany({
    where: { shopKey: shop, enabled: true },
    orderBy: { method: "asc" },
  });
  const fallback: Record<ProductionMethodCode, ProductionMethodSettingRecord> = {
    EMBROIDERY: {
      method: "EMBROIDERY",
      label: "Embroidery",
      description: "",
      enabled: true,
    },
    DTF: { method: "DTF", label: METHOD_LABELS.DTF, description: "", enabled: true },
    DTG: { method: "DTG", label: METHOD_LABELS.DTG, description: "", enabled: true },
  };
  for (const row of rows) {
    fallback[cleanProductionMethod(row.method)] = row;
  }
  return PRODUCTION_METHODS.map((method) => fallback[method]);
}

export async function listEnabledProductionMethodCodes(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  const settings = await methodSettings(shop, database);
  return settings
    .filter((setting) => setting.enabled !== false)
    .map((setting) => cleanProductionMethod(setting.method));
}

export async function getProductionPricing(
  shop: string,
  productId: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  return database.publicProductProductionPricing.findUnique({
    where: {
      shopKey_shopifyProductId: {
        shopKey: shop,
        shopifyProductId: productId,
      },
    },
  });
}

export async function getCreatorProductionPricing(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  return getProductionPricing(
    shop,
    CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
    database,
  );
}

export async function syncProductionFeeMerchandise(
  shop: string,
  pricing: PublicProductProductionPricingRecord,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  const existing = await client.request<{
    products: { nodes: ProductionFeeProductNode[] };
  }>(
    `#graphql query CustomHouseProductionFeeProduct($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          variants(first: 10) {
            nodes { id title }
          }
          parentProductId: metafield(namespace: "customhouse", key: "production_fee_parent_product_id") {
            value
          }
        }
      }
    }`,
    {
      query: `tag:${FEE_PRODUCT_TAG}`,
    },
  );
  const existingProduct = existing.products.nodes.find(
    (product) => product.parentProductId?.value === pricing.shopifyProductId,
  );
  const numericParentId =
    pricing.shopifyProductId.match(/(\d+)$/)?.[1] || pricing.shopifyProductId;
  const result = await client.request<{
    productSet: {
      product: ProductionFeeProductNode | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation CustomHouseProductionFeeProductSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product {
          id
          title
          variants(first: 10) {
            nodes { id title }
          }
          parentProductId: metafield(namespace: "customhouse", key: "production_fee_parent_product_id") {
            value
          }
        }
        userErrors { message }
      }
    }`,
    {
      input: {
        ...(existingProduct ? { id: existingProduct.id } : {}),
        title: `${FEE_PRODUCT_TITLE_PREFIX} - ${numericParentId}`,
        vendor: "Custom House",
        status: "ACTIVE",
        tags: [FEE_PRODUCT_TAG, "customhouse-hidden-fee"],
        productOptions: [
          {
            name: FEE_PRODUCT_OPTION_NAME,
            values: [
              { name: "Embroidery Production Fee" },
              { name: "Embroidery Text Production Fee" },
              { name: "Embroidery Image or Logo Production Fee" },
              { name: "DTF Production Fee" },
              { name: "DTG Production Fee" },
            ],
          },
        ],
        variants: [
          {
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: "Embroidery Text Production Fee" },
            ],
            price: (pricing.embroideryTextSurcharge ?? pricing.embroiderySurcharge).toFixed(2),
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
          {
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: "Embroidery Image or Logo Production Fee" },
            ],
            price: (pricing.embroideryImageSurcharge ?? pricing.embroiderySurcharge).toFixed(2),
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
          {
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: "Embroidery Production Fee" },
            ],
            price: pricing.embroiderySurcharge.toFixed(2),
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
          {
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: "DTF Production Fee" },
            ],
            price: pricing.dtfSurcharge.toFixed(2),
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
          {
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: "DTG Production Fee" },
            ],
            price: pricing.dtgSurcharge.toFixed(2),
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          },
        ],
        metafields: [
          {
            namespace: "customhouse",
            key: FEE_PRODUCT_METAFIELD_KEY,
            type: "single_line_text_field",
            value: pricing.shopifyProductId,
          },
          {
            namespace: "customhouse",
            key: "product_type",
            type: "single_line_text_field",
            value: FEE_PRODUCT_TYPE,
          },
          {
            namespace: "customhouse",
            key: "fee_shop_key",
            type: "single_line_text_field",
            value: shop,
          },
          {
            namespace: "seo",
            key: "hidden",
            type: "number_integer",
            value: "1",
          },
        ],
      },
    },
  );
  throwUserErrors(result.productSet.userErrors, "Production fee merchandise");
  const feeProduct = result.productSet.product;
  if (!feeProduct) {
    throw new DomainError(
      "PRODUCTION_FEE_SYNC_FAILED",
      "Production fee merchandise could not be synced.",
      502,
    );
  }
  const variantByTitle = new Map(
    feeProduct.variants.nodes.map((variant) => [variant.title, variant.id]),
  );
  const embroideryFeeVariantId = variantByTitle.get("Embroidery Production Fee");
  const embroideryTextFeeVariantId = variantByTitle.get("Embroidery Text Production Fee");
  const embroideryImageFeeVariantId = variantByTitle.get("Embroidery Image or Logo Production Fee");
  const dtfFeeVariantId = variantByTitle.get("DTF Production Fee");
  const dtgFeeVariantId = variantByTitle.get("DTG Production Fee");
  if (!embroideryFeeVariantId || !embroideryTextFeeVariantId || !embroideryImageFeeVariantId || !dtfFeeVariantId || !dtgFeeVariantId) {
    throw new DomainError(
      "PRODUCTION_FEE_VARIANTS_MISSING",
      "Production fee variants could not be synced.",
      502,
    );
  }
  await syncProductionFeePublication(client, feeProduct.id);
  const updated = await database.publicProductProductionPricing.update({
    where: { id: pricing.id },
    data: {
      embroideryFeeVariantId,
      embroideryTextFeeVariantId,
      embroideryImageFeeVariantId,
      dtfFeeVariantId,
      dtgFeeVariantId,
    },
  });
  return {
    synced: true,
    pricing: updated,
  };
}

async function syncProductionFeePublication(
  client: ShopifyGraphqlClient,
  feeProductId: string,
) {
  const publicationState = await client.request<{
    product: {
      resourcePublications: {
        nodes: Array<{
          isPublished: boolean;
          publication: PublicationNode;
        }>;
      };
    } | null;
    publications: { nodes: PublicationNode[] };
  }>(
    `#graphql query CustomHouseOnlineStorePublication($id: ID!) {
      product(id: $id) {
        resourcePublications(first: 20) {
          nodes {
            isPublished
            publication { id name }
          }
        }
      }
      publications(first: 30) {
        nodes { id name }
      }
    }`,
    { id: feeProductId },
  );
  const onlineStorePublication = publicationState.publications.nodes.find(
    (publication) => publication.name === "Online Store",
  );
  if (!onlineStorePublication) {
    throw new DomainError(
      "ONLINE_STORE_PUBLICATION_MISSING",
      "Online Store publication could not be found for production fee merchandise.",
      502,
    );
  }
  const alreadyPublished =
    publicationState.product?.resourcePublications.nodes.some(
      (node) =>
        node.isPublished &&
        node.publication.id === onlineStorePublication.id,
    ) ?? false;
  if (alreadyPublished) return;

  const result = await client.request<{
    publishablePublish: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation CustomHousePublishProductionFee($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { message }
      }
    }`,
    {
      id: feeProductId,
      input: [{ publicationId: onlineStorePublication.id }],
    },
  );
  throwUserErrors(
    result.publishablePublish.userErrors,
    "Production fee Online Store publication",
  );
}

export async function syncProductionPricingMetafield(
  client: ShopifyGraphqlClient,
  productId: string,
  value: string,
) {
  const result = await client.request<{
    metafieldsSet: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation ProductionMethodPricingMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: "customhouse",
          key: "production_method_pricing",
          type: "json",
          value,
        },
      ],
    },
  );
  throwUserErrors(
    result.metafieldsSet.userErrors,
    "Production method pricing metafield",
  );
}

export async function saveProductionPricing(
  shop: string,
  input: SaveProductionPricingInput,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionPricingSyncState> {
  const embroidery = parseSurchargeInput(input.embroidery);
  const embroideryText = parseSurchargeInput(input.embroideryText ?? input.embroidery);
  const embroideryImage = parseSurchargeInput(input.embroideryImage ?? input.embroidery);
  const dtf = parseSurchargeInput(input.dtf);
  const dtg = parseSurchargeInput(input.dtg);
  const settings = await methodSettings(shop, database);
  const methods = settings.map((setting) => ({
    method: cleanProductionMethod(setting.method),
    label: setting.label,
    surcharge:
      setting.method === "EMBROIDERY"
        ? embroidery
        : setting.method === "DTF"
          ? dtf
          : dtg,
  }));
  let pricing = await database.publicProductProductionPricing.upsert({
    where: {
      shopKey_shopifyProductId: {
        shopKey: shop,
        shopifyProductId: input.shopifyProductId,
      },
    },
    create: {
      shopKey: shop,
      shopifyProductId: input.shopifyProductId,
      embroiderySurcharge: embroidery,
      embroideryTextSurcharge: embroideryText,
      embroideryImageSurcharge: embroideryImage,
      dtfSurcharge: dtf,
      dtgSurcharge: dtg,
    },
    update: {
      embroiderySurcharge: embroidery,
      embroideryTextSurcharge: embroideryText,
      embroideryImageSurcharge: embroideryImage,
      dtfSurcharge: dtf,
      dtgSurcharge: dtg,
    },
  });

  const errors: string[] = [];
  let shopifySynced = false;
  let productionFeeSynced = false;
  try {
    const feeSync = await syncProductionFeeMerchandise(shop, pricing, client, database);
    pricing = feeSync.pricing;
    productionFeeSynced = feeSync.synced;
  } catch (error) {
    errors.push(
      `Production fee sync failed: ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
    );
  }

  const metafieldValue = pricingConfigToMetafieldValue({
    currency: input.currency,
    methods,
    pricing,
  });
  const missingFeeMethods = missingRequiredFeeVariantMethods(
    JSON.parse(metafieldValue) as ProductionPricingBridgePayload,
  );

  if (missingFeeMethods.length > 0) {
    errors.push(
      `Shopify config sync failed: Production fee variant IDs missing for ${missingFeeMethods.join(", ")}.`,
    );
  } else {
    try {
      await syncProductionPricingMetafield(client, input.shopifyProductId, metafieldValue);
      shopifySynced = true;
    } catch (error) {
      errors.push(
        `Shopify config sync failed: ${
          error instanceof Error ? error.message : "Unknown error."
        }`,
      );
    }
  }

  return {
    saved: true,
    shopifySynced,
    productionFeeSynced,
    status: shopifySynced && productionFeeSynced ? "saved" : "partial",
    message:
      shopifySynced && productionFeeSynced
        ? "Saved. Shopify config synced. Production fee synced."
        : "Saved with a partial sync error.",
    errors,
    pricing,
  };
}

export async function saveCreatorProductionPricing(
  shop: string,
  input: SaveCreatorProductionPricingInput,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionPricingSyncState> {
  const embroidery = parseSurchargeInput(input.embroidery);
  const embroideryText = parseSurchargeInput(input.embroideryText ?? input.embroidery);
  const embroideryImage = parseSurchargeInput(input.embroideryImage ?? input.embroidery);
  const dtf = parseSurchargeInput(input.dtf);
  const dtg = parseSurchargeInput(input.dtg);
  let pricing = await database.publicProductProductionPricing.upsert({
    where: {
      shopKey_shopifyProductId: {
        shopKey: shop,
        shopifyProductId: CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
      },
    },
    create: {
      shopKey: shop,
      shopifyProductId: CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
      embroiderySurcharge: embroidery,
      embroideryTextSurcharge: embroideryText,
      embroideryImageSurcharge: embroideryImage,
      dtfSurcharge: dtf,
      dtgSurcharge: dtg,
    },
    update: {
      embroiderySurcharge: embroidery,
      embroideryTextSurcharge: embroideryText,
      embroideryImageSurcharge: embroideryImage,
      dtfSurcharge: dtf,
      dtgSurcharge: dtg,
    },
  });

  const errors: string[] = [];
  let productionFeeSynced = false;
  try {
    const feeSync = await syncProductionFeeMerchandise(shop, pricing, client, database);
    pricing = feeSync.pricing;
    productionFeeSynced = feeSync.synced;
  } catch (error) {
    errors.push(
      `Production fee sync failed: ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
    );
  }

  return {
    saved: true,
    shopifySynced: true,
    productionFeeSynced,
    status: productionFeeSynced ? "saved" : "partial",
    message: productionFeeSynced
      ? "Saved. Creator production fee synced."
      : "Saved with a partial sync error.",
    errors,
    pricing,
  };
}

export async function listProductionPricingRows(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  return database.publicProductProductionPricing.findMany({
    where: { shopKey: shop },
  });
}

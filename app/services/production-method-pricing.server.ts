import { Prisma } from "@prisma/client";
import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";

export const PRODUCTION_METHODS = [
  "EMBROIDERY",
  "DTF",
  "DTG",
  "SUBLIMATION",
  "STICKER_PRINTING",
] as const;
export const CREATOR_PRODUCTION_PRICING_PRODUCT_ID = "customhouse:creator-products";

export type ProductionMethodCode = string;
export const EMBROIDERY_SUBTYPES = ["TEXT_ONLY", "IMAGE_OR_LOGO"] as const;
export type EmbroiderySubtype = (typeof EMBROIDERY_SUBTYPES)[number];
export type ProductionPricingBehavior = "SINGLE" | "TIERED";

type ProductionPricingDb = {
  publicProductProductionPricing: {
    findUnique(args: unknown): Promise<PublicProductProductionPricingRecord | null>;
    findMany(args: unknown): Promise<PublicProductProductionPricingRecord[]>;
    upsert(args: unknown): Promise<PublicProductProductionPricingRecord>;
    update(args: unknown): Promise<PublicProductProductionPricingRecord>;
  };
  productionMethodSetting?: {
    findMany(args: unknown): Promise<ProductionMethodSettingRecord[]>;
    findUnique?(args: unknown): Promise<ProductionMethodSettingRecord | null>;
    create?(args: unknown): Promise<ProductionMethodSettingRecord>;
  };
};

export type PublicProductProductionPricingRecord = {
  id: string;
  shopKey: string;
  shopifyProductId: string;
  currency?: string;
  methodConfigurations?: Prisma.JsonValue;
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
  method: string;
  label?: string;
  description?: string;
  enabled: boolean;
  pricingBehavior?: string;
  configurationJson?: Prisma.JsonValue;
};

export type EnabledProductionMethod = {
  id: ProductionMethodCode;
  label: string;
  pricingBehavior?: ProductionPricingBehavior;
  maxWidthCm?: number;
  maxHeightCm?: number;
};

export type ProductionMethodDefinition = EnabledProductionMethod & {
  description: string;
  enabled: boolean;
  pricingBehavior: ProductionPricingBehavior;
  tiers: string[];
};

export type CreateProductionMethodDefinitionInput = {
  label: unknown;
  code?: unknown;
  pricingBehavior?: unknown;
  maxWidthCm?: unknown;
  maxHeightCm?: unknown;
};

export type ProductProductionRateConfiguration = {
  enabled: boolean;
  surcharge: string;
  feeVariantId: string | null;
};

export type ProductProductionMethodConfiguration =
  | ProductProductionRateConfiguration
  | {
      enabled: boolean;
      tiers: Record<string, ProductProductionRateConfiguration>;
    };

export type ProductProductionConfiguration = {
  version: 2;
  methods: Record<string, ProductProductionMethodConfiguration>;
};

export type SaveProductionPricingInput = {
  shopifyProductId: string;
  currency: string;
  embroideryText: unknown;
  embroideryImage: unknown;
  dtf: unknown;
  dtg: unknown;
};

export type SaveCreatorProductionPricingInput = Omit<
  SaveProductionPricingInput,
  "shopifyProductId" | "embroideryText" | "embroideryImage"
> & {
  embroidery: unknown;
  embroideryText?: unknown;
  embroideryImage?: unknown;
};

export type SaveProductProductionConfigurationInput = {
  shopifyProductId: string;
  currency: string;
  methods: Record<
    string,
    {
      enabled: unknown;
      surcharge?: unknown;
      tiers?: Record<string, { enabled: unknown; surcharge: unknown }>;
    }
  >;
};

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
  enabled?: boolean;
  pricingBehavior?: ProductionPricingBehavior;
  maxWidthCm?: number;
  maxHeightCm?: number;
};

export type ProductionPricingBridgeMethod = {
  id: ProductionMethodCode;
  code?: ProductionMethodCode;
  currency?: string;
  description?: string;
  pricingBehavior?: ProductionPricingBehavior;
  label: string;
  enabled?: boolean;
  surchargeMinor: number;
  feeVariantId?: string;
  feeVariantGid?: string;
  maxWidthCm?: number;
  maxHeightCm?: number;
  embroiderySubtypes?: Record<EmbroiderySubtype, ProductionPricingBridgeRate>;
  pricingTiers?: Record<string, ProductionPricingBridgeRate>;
  tiers?: Record<string, ProductionPricingBridgeRate>;
};

export type ProductionPricingBridgeRate = {
  enabled?: boolean;
  label: string;
  surchargeMinor: number;
  feeVariantId?: string;
  feeVariantGid?: string;
};

export type ProductionPricingBridgePayload = {
  version: 1 | 2;
  currency: string;
  productionMethods: ProductionPricingBridgeMethod[];
  embroideryPricing: Partial<Record<EmbroiderySubtype, ProductionPricingBridgeRate>>;
  productionMethodPricing: Record<
    string,
    ProductionPricingBridgeRate & {
      embroiderySubtypes?: Record<EmbroiderySubtype, ProductionPricingBridgeRate>;
      pricingTiers?: Record<string, ProductionPricingBridgeRate>;
      maxWidthCm?: number;
      maxHeightCm?: number;
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
  SUBLIMATION: "Sublimation",
  STICKER_PRINTING: "Sticker Printing",
};

const DEFAULT_METHOD_DEFINITIONS: ProductionMethodDefinition[] = [
  {
    id: "EMBROIDERY",
    label: METHOD_LABELS.EMBROIDERY,
    description: "",
    enabled: true,
    pricingBehavior: "TIERED",
    tiers: [...EMBROIDERY_SUBTYPES],
    maxWidthCm: 8,
    maxHeightCm: 8,
  },
  ...(["DTF", "DTG"] as const).map((id) => ({
    id,
    label: METHOD_LABELS[id],
    description: "",
    enabled: true,
    pricingBehavior: "SINGLE" as const,
    tiers: [],
    maxWidthCm: 35,
    maxHeightCm: 40,
  })),
  ...(["SUBLIMATION", "STICKER_PRINTING"] as const).map((id) => ({
    id,
    label: METHOD_LABELS[id],
    description: "",
    enabled: true,
    pricingBehavior: "SINGLE" as const,
    tiers: [],
  })),
];

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
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(normalized)) {
    return normalized;
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
    default:
      throw new DomainError(
        "LEGACY_PRODUCTION_PRICING_UNAVAILABLE",
        "Production pricing is not configured for this method.",
        409,
      );
  }
}

export function cleanEmbroiderySubtype(value: unknown): EmbroiderySubtype {
  const raw = String(value || "").trim().toUpperCase();
  const normalized = raw === "IMAGE_LOGO" ? "IMAGE_OR_LOGO" : raw;
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
    default:
      return null;
  }
}

export function pricingConfigToMetafieldValue(input: {
  currency: string;
  methods: PricingConfigMethod[];
  pricing?: Pick<
    PublicProductProductionPricingRecord,
    "embroideryFeeVariantId" | "dtfFeeVariantId" | "dtgFeeVariantId"
  > &
    Partial<
      Pick<
        PublicProductProductionPricingRecord,
        | "embroideryTextSurcharge"
        | "embroideryImageSurcharge"
        | "embroideryTextFeeVariantId"
        | "embroideryImageFeeVariantId"
      >
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
  > &
    Partial<
      Pick<
        PublicProductProductionPricingRecord,
        | "embroideryTextSurcharge"
        | "embroideryImageSurcharge"
        | "embroideryTextFeeVariantId"
        | "embroideryImageFeeVariantId"
      >
    >;
}): ProductionPricingBridgePayload {
  const currency = input.currency.trim().toUpperCase() || "SEK";
  const byMethod = new Map(
    input.methods.map((method) => [cleanProductionMethod(method.method), method]),
  );
  const pricing: NonNullable<typeof input.pricing> = input.pricing ?? {
    embroideryFeeVariantId: null,
    dtfFeeVariantId: null,
    dtgFeeVariantId: null,
  };
  const bridgeRate = (
    label: string,
    surcharge: Prisma.Decimal,
    feeVariantGidValue: string | null | undefined,
  ): ProductionPricingBridgeRate => {
    const feeVariantGid = feeVariantGidValue ?? "";
    const feeVariantId = numericShopifyId(feeVariantGid);
    return {
      label,
      surchargeMinor: Number(decimalToMinor(surcharge)),
      ...(feeVariantId ? { feeVariantId } : {}),
      ...(feeVariantGid ? { feeVariantGid } : {}),
    };
  };
  const embroideryPricing: Record<EmbroiderySubtype, ProductionPricingBridgeRate> = {
    TEXT_ONLY: bridgeRate(
      "Embroidery — Text only",
      pricing.embroideryTextSurcharge ?? new Prisma.Decimal(0),
      pricing.embroideryTextFeeVariantId,
    ),
    IMAGE_OR_LOGO: bridgeRate(
      "Embroidery — Image / Logo",
      pricing.embroideryImageSurcharge ?? new Prisma.Decimal(0),
      pricing.embroideryImageFeeVariantId,
    ),
  };
  const productionMethods = input.methods
    .filter((method) => method.enabled !== false)
    .map((methodConfig) => {
    const method = cleanProductionMethod(methodConfig.method);
    const config = byMethod.get(method);
    const label = METHOD_LABELS[method] || methodConfig.label || method;
    const feeVariantGid =
      method === "EMBROIDERY"
        ? ""
        : feeVariantIdForMethod(pricing, method) ?? "";
    const feeVariantId = numericShopifyId(feeVariantGid);
    const payload: ProductionPricingBridgeMethod = {
      id: method,
      label,
      surchargeMinor:
        method === "EMBROIDERY"
          ? 0
          : Number(decimalToMinor(config?.surcharge ?? new Prisma.Decimal(0))),
      ...(method === "EMBROIDERY" ? { embroiderySubtypes: embroideryPricing } : {}),
    };
    if (feeVariantId) payload.feeVariantId = feeVariantId;
    if (feeVariantGid) payload.feeVariantGid = feeVariantGid;
    return payload;
  });
  return {
    version: 1,
    currency,
    productionMethods,
    embroideryPricing,
    productionMethodPricing: Object.fromEntries(
      productionMethods.map((method) => [
        method.id,
        {
          label: method.label,
          surchargeMinor: method.surchargeMinor,
          ...(method.feeVariantId ? { feeVariantId: method.feeVariantId } : {}),
          ...(method.feeVariantGid ? { feeVariantGid: method.feeVariantGid } : {}),
          ...(method.embroiderySubtypes
            ? { embroiderySubtypes: method.embroiderySubtypes }
            : {}),
        },
      ]),
    ) as ProductionPricingBridgePayload["productionMethodPricing"],
  };
}

function missingRequiredFeeVariantMethods(payload: ProductionPricingBridgePayload) {
  return payload.productionMethods.flatMap((method) => {
    const tierRates = method.pricingTiers || method.embroiderySubtypes;
    if (tierRates) {
      return Object.values(tierRates)
        .filter((rate) => rate.surchargeMinor > 0 && !rate.feeVariantId)
        .map((rate) => rate.label);
    }
    return method.surchargeMinor > 0 && !method.feeVariantId
      ? [method.label]
      : [];
  });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanProductionTier(value: unknown) {
  const tier = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(tier)) {
    throw new DomainError(
      "INVALID_PRODUCTION_PRICING_TIER",
      "Choose a valid production pricing tier.",
      422,
    );
  }
  return tier;
}

function productionTierLabel(tier: string) {
  if (tier === "TEXT_ONLY") return "Text only";
  if (tier === "IMAGE_OR_LOGO") return "Image / Logo";
  return tier
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function cleanCurrency(value: unknown) {
  const currency = String(value || "SEK").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError(
      "INVALID_PRODUCTION_CURRENCY",
      "Choose a valid three-letter production pricing currency.",
      422,
    );
  }
  return currency;
}

function cleanBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function optionalDimension(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function canonicalProductionMethodCode(value: unknown) {
  const code = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleanProductionMethod(code);
}

function customMethodDimension(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1000) {
    throw new DomainError(
      "PRODUCTION_METHOD_DIMENSION_INVALID",
      "Artwork dimensions must be positive numbers no greater than 1000 cm.",
      422,
    );
  }
  return number;
}

export async function createProductionMethodDefinition(
  shop: string,
  input: CreateProductionMethodDefinitionInput,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionMethodDefinition> {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 2 || label.length > 80) {
    throw new DomainError(
      "PRODUCTION_METHOD_LABEL_INVALID",
      "Method name must be between 2 and 80 characters.",
      422,
    );
  }
  const code = canonicalProductionMethodCode(
    typeof input.code === "string" && input.code.trim() ? input.code : label,
  );
  if (PRODUCTION_METHODS.includes(code as (typeof PRODUCTION_METHODS)[number])) {
    throw new DomainError(
      "PRODUCTION_METHOD_RESERVED",
      "Built-in production method codes cannot be overwritten.",
      409,
    );
  }
  if (input.pricingBehavior && input.pricingBehavior !== "SINGLE") {
    throw new DomainError(
      "PRODUCTION_METHOD_PRICING_BEHAVIOR_INVALID",
      "New production methods currently support single-price behavior.",
      422,
    );
  }
  const delegate = database.productionMethodSetting;
  if (!delegate?.findUnique || !delegate.create) {
    throw new DomainError(
      "PRODUCTION_METHOD_REGISTRY_UNAVAILABLE",
      "Production method management is temporarily unavailable.",
      503,
    );
  }
  const existing = await delegate.findUnique({
    where: { shopKey_method: { shopKey: shop, method: code } },
  });
  if (existing) {
    throw new DomainError(
      "PRODUCTION_METHOD_DUPLICATE",
      "A production method with this stable code already exists.",
      409,
    );
  }
  const maxWidthCm = customMethodDimension(input.maxWidthCm);
  const maxHeightCm = customMethodDimension(input.maxHeightCm);
  await delegate.create({
    data: {
      shopKey: shop,
      method: code,
      label,
      description: "",
      enabled: true,
      pricingBehavior: "SINGLE",
      configurationJson: {
        ...(maxWidthCm ? { maxWidthCm } : {}),
        ...(maxHeightCm ? { maxHeightCm } : {}),
      } as Prisma.InputJsonValue,
    },
  });
  return {
    id: code,
    label,
    description: "",
    enabled: true,
    pricingBehavior: "SINGLE",
    tiers: [],
    ...(maxWidthCm ? { maxWidthCm } : {}),
    ...(maxHeightCm ? { maxHeightCm } : {}),
  };
}

function legacyProductConfiguration(
  pricing: PublicProductProductionPricingRecord,
): ProductProductionConfiguration {
  return {
    version: 2,
    methods: {
      EMBROIDERY: {
        enabled: true,
        tiers: {
          TEXT_ONLY: {
            enabled: true,
            surcharge: pricing.embroideryTextSurcharge.toFixed(2),
            feeVariantId: pricing.embroideryTextFeeVariantId,
          },
          IMAGE_OR_LOGO: {
            enabled: true,
            surcharge: pricing.embroideryImageSurcharge.toFixed(2),
            feeVariantId: pricing.embroideryImageFeeVariantId,
          },
        },
      },
      DTF: {
        enabled: true,
        surcharge: pricing.dtfSurcharge.toFixed(2),
        feeVariantId: pricing.dtfFeeVariantId,
      },
      DTG: {
        enabled: true,
        surcharge: pricing.dtgSurcharge.toFixed(2),
        feeVariantId: pricing.dtgFeeVariantId,
      },
    },
  };
}

export function productProductionConfiguration(
  pricing: PublicProductProductionPricingRecord,
): ProductProductionConfiguration {
  const root = recordValue(pricing.methodConfigurations);
  const methods = recordValue(root?.methods);
  if (!methods) {
    return legacyProductConfiguration(pricing);
  }
  const parsed: ProductProductionConfiguration = { version: 2, methods: {} };
  for (const [rawCode, rawMethod] of Object.entries(methods)) {
    const code = cleanProductionMethod(rawCode);
    const method = recordValue(rawMethod);
    if (!method) continue;
    const rawTiers = recordValue(method.tiers);
    if (rawTiers) {
      const tiers: Record<string, ProductProductionRateConfiguration> = {};
      for (const [rawTier, rawTierRate] of Object.entries(rawTiers)) {
        const tier = code === "EMBROIDERY" && rawTier === "IMAGE_LOGO"
          ? "IMAGE_OR_LOGO"
          : cleanProductionTier(rawTier);
        const rawRate = recordValue(rawTierRate);
        tiers[tier] = {
          enabled: cleanBoolean(rawRate?.enabled, false),
          surcharge: parseSurchargeInput(rawRate?.surcharge ?? "0").toFixed(2),
          feeVariantId:
            typeof rawRate?.feeVariantId === "string" && rawRate.feeVariantId.trim()
              ? rawRate.feeVariantId.trim()
              : null,
        };
      }
      parsed.methods[code] = {
        enabled: cleanBoolean(method.enabled, Object.values(tiers).some((tier) => tier.enabled)),
        tiers,
      };
      continue;
    }
    parsed.methods[code] = {
      enabled: cleanBoolean(method.enabled, false),
      surcharge: parseSurchargeInput(method.surcharge ?? "0").toFixed(2),
      feeVariantId:
        typeof method.feeVariantId === "string" && method.feeVariantId.trim()
          ? method.feeVariantId.trim()
          : null,
    };
  }
  return parsed;
}

async function methodSettings(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionMethodDefinition[]> {
  const rows = database.productionMethodSetting
    ? await database.productionMethodSetting.findMany({
        where: { shopKey: shop },
        orderBy: { method: "asc" },
      })
    : [];
  const fallback = new Map(
    DEFAULT_METHOD_DEFINITIONS.map((definition) => [definition.id, definition]),
  );
  for (const row of rows) {
    const method = cleanProductionMethod(row.method);
    const configuration = recordValue(row.configurationJson) || {};
    const existing = fallback.get(method);
    const pricingBehavior: ProductionPricingBehavior =
      row.pricingBehavior === "TIERED" || method === "EMBROIDERY"
        ? "TIERED"
        : "SINGLE";
    const configuredTiers = Array.isArray(configuration.tiers)
      ? configuration.tiers.flatMap((tier) => {
          try {
            return [cleanProductionTier(tier)];
          } catch {
            return [];
          }
        })
      : [];
    fallback.set(method, {
      id: method,
      label: row.label?.trim() || existing?.label || METHOD_LABELS[method] || method,
      description: row.description || "",
      enabled: row.enabled !== false,
      pricingBehavior,
      tiers: pricingBehavior === "TIERED"
        ? configuredTiers.length
          ? [...new Set(configuredTiers)]
          : existing?.tiers.length
            ? [...existing.tiers]
            : method === "EMBROIDERY"
              ? [...EMBROIDERY_SUBTYPES]
              : []
        : [],
      maxWidthCm: optionalDimension(configuration.maxWidthCm) ?? existing?.maxWidthCm,
      maxHeightCm: optionalDimension(configuration.maxHeightCm) ?? existing?.maxHeightCm,
    });
  }
  return [...fallback.values()].sort((left, right) => {
    const leftIndex = PRODUCTION_METHODS.indexOf(left.id as (typeof PRODUCTION_METHODS)[number]);
    const rightIndex = PRODUCTION_METHODS.indexOf(right.id as (typeof PRODUCTION_METHODS)[number]);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER) -
        (rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER);
    }
    return left.id.localeCompare(right.id);
  });
}

export async function listEnabledProductionMethods(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<EnabledProductionMethod[]> {
  const settings = await methodSettings(shop, database);
  return settings
    .filter((setting) => setting.enabled !== false)
    .map((setting) => {
      const id = cleanProductionMethod(setting.id);
      return {
        id,
        label: setting.label.trim() || METHOD_LABELS[id] || id,
      };
    });
}

export async function listProductionMethodDefinitions(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  return methodSettings(shop, database);
}

export async function listEnabledProductionMethodCodes(
  shop: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
) {
  return (await listEnabledProductionMethods(shop, database)).map(
    (setting) => setting.id,
  );
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

export async function getEnabledProductionMethodsForProduct(
  shop: string,
  productId: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<EnabledProductionMethod[]> {
  const [definitions, pricing] = await Promise.all([
    methodSettings(shop, database),
    getProductionPricing(shop, productId, database),
  ]);
  if (!pricing) return [];
  const configuration = productProductionConfiguration(pricing);
  return definitions
    .filter((definition) => {
      if (!definition.enabled) return false;
      const method = configuration.methods[definition.id];
      if (!method || !method.enabled) return false;
      if ("tiers" in method) {
        return Object.values(method.tiers).some((tier) => tier.enabled);
      }
      return true;
    })
    .map(({ id, label, pricingBehavior, maxWidthCm, maxHeightCm }) => ({
      id,
      label,
      pricingBehavior,
      ...(maxWidthCm ? { maxWidthCm } : {}),
      ...(maxHeightCm ? { maxHeightCm } : {}),
    }));
}

export async function getProductionPricingBridgeForProduct(
  shop: string,
  productId: string,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionPricingBridgePayload | null> {
  const [definitions, pricing] = await Promise.all([
    methodSettings(shop, database),
    getProductionPricing(shop, productId, database),
  ]);
  return pricing
    ? canonicalProductionPricingBridgePayload(pricing, definitions)
    : null;
}

export async function resolveProductionPricing(input: {
  shop: string;
  productId: string;
  method: unknown;
  artworkType?: unknown;
  pricingTier?: unknown;
  database?: ProductionPricingDb;
}) {
  const database = input.database ?? (db as unknown as ProductionPricingDb);
  const method = cleanProductionMethod(input.method);
  const [definitions, pricing] = await Promise.all([
    methodSettings(input.shop, database),
    getProductionPricing(input.shop, input.productId, database),
  ]);
  const definition = definitions.find((candidate) => candidate.id === method);
  if (!definition?.enabled || !pricing) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose a valid printing method; it is not enabled for the selected product.",
      422,
    );
  }
  const configured = productProductionConfiguration(pricing).methods[method];
  if (!configured?.enabled) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose a valid printing method; it is not enabled for the selected product.",
      422,
    );
  }
  let artworkType: string | null = null;
  let rate: ProductProductionRateConfiguration;
  if ("tiers" in configured) {
    artworkType = method === "EMBROIDERY"
      ? cleanEmbroiderySubtype(input.artworkType ?? input.pricingTier)
      : cleanProductionTier(input.pricingTier ?? input.artworkType);
    if (!definition.tiers.includes(artworkType)) {
      throw new DomainError(
        "PRODUCTION_METHOD_DISABLED",
        "Choose a valid printing method tier that is enabled for the selected product.",
        422,
      );
    }
    rate = configured.tiers[artworkType];
    if (!rate?.enabled) {
      throw new DomainError(
        "PRODUCTION_METHOD_DISABLED",
        "Choose a valid printing method tier that is enabled for the selected product.",
        422,
      );
    }
  } else {
    rate = configured;
  }
  const surcharge = parseSurchargeInput(rate.surcharge);
  const surchargeMinor = decimalToMinor(surcharge);
  return {
    productId: input.productId,
    method,
    label: definition.label,
    enabled: true as const,
    artworkType,
    surcharge,
    surchargeMinor,
    currency: cleanCurrency(pricing.currency),
    feeVariantId: rate.feeVariantId,
    feeRequired: surchargeMinor > 0n,
    maxWidthCm: definition.maxWidthCm,
    maxHeightCm: definition.maxHeightCm,
  };
}

export function canonicalProductionPricingBridgePayload(
  pricing: PublicProductProductionPricingRecord,
  definitions: ProductionMethodDefinition[],
): ProductionPricingBridgePayload {
  const configuration = productProductionConfiguration(pricing);
  const methods: ProductionPricingBridgeMethod[] = [];
  const embroideryPricing: Partial<
    Record<EmbroiderySubtype, ProductionPricingBridgeRate>
  > = {};
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const bridgeRate = (
    label: string,
    rate: ProductProductionRateConfiguration,
  ): ProductionPricingBridgeRate => {
    const feeVariantGid = rate.feeVariantId || "";
    const feeVariantId = numericShopifyId(feeVariantGid);
    return {
      label,
      enabled: rate.enabled,
      surchargeMinor: Number(decimalToMinor(parseSurchargeInput(rate.surcharge))),
      ...(feeVariantId ? { feeVariantId } : {}),
      ...(feeVariantGid ? { feeVariantGid } : {}),
    };
  };
  for (const [method, configured] of Object.entries(configuration.methods)) {
    const definition = definitionById.get(method);
    if (!definition?.enabled || !configured.enabled) continue;
    if ("tiers" in configured) {
      const enabledTiers = Object.fromEntries(
        definition.tiers.flatMap((tier) => {
          const rate = configured.tiers[tier];
          if (!rate?.enabled) return [];
          const label = `${definition.label} — ${productionTierLabel(tier)}`;
          const bridged = bridgeRate(label, rate);
          if (
            method === "EMBROIDERY" &&
            EMBROIDERY_SUBTYPES.includes(tier as EmbroiderySubtype)
          ) {
            embroideryPricing[tier as EmbroiderySubtype] = bridged;
          }
          return [[tier, bridged]];
        }),
      ) as Record<string, ProductionPricingBridgeRate>;
      if (Object.keys(enabledTiers).length) {
        methods.push({
          id: method,
          code: method,
          currency: cleanCurrency(pricing.currency),
          description: definition.description,
          pricingBehavior: definition.pricingBehavior,
          label: definition.label,
          enabled: true,
          surchargeMinor: 0,
          pricingTiers: enabledTiers,
          tiers: Object.fromEntries(Object.entries(configured.tiers).map(([tier, rate]) => [
            tier, bridgeRate(`${definition.label} — ${productionTierLabel(tier)}`, rate),
          ])),
          ...(method === "EMBROIDERY"
            ? { embroiderySubtypes: enabledTiers as Record<EmbroiderySubtype, ProductionPricingBridgeRate> }
            : {}),
          ...(definition.maxWidthCm ? { maxWidthCm: definition.maxWidthCm } : {}),
          ...(definition.maxHeightCm ? { maxHeightCm: definition.maxHeightCm } : {}),
        });
      }
      continue;
    }
    const rate = bridgeRate(definition.label, configured);
    methods.push({
      id: method,
      code: method,
      currency: cleanCurrency(pricing.currency),
      description: definition.description,
      pricingBehavior: definition.pricingBehavior,
      enabled: true,
      ...rate,
      ...(definition.maxWidthCm ? { maxWidthCm: definition.maxWidthCm } : {}),
      ...(definition.maxHeightCm ? { maxHeightCm: definition.maxHeightCm } : {}),
    });
  }
  return {
    version: 2,
    currency: cleanCurrency(pricing.currency),
    productionMethods: methods,
    embroideryPricing,
    productionMethodPricing: Object.fromEntries(
      methods.map((method) => [method.id, {
        label: method.label,
        surchargeMinor: method.surchargeMinor,
        ...(method.feeVariantId ? { feeVariantId: method.feeVariantId } : {}),
        ...(method.feeVariantGid ? { feeVariantGid: method.feeVariantGid } : {}),
        ...(method.embroiderySubtypes
          ? { embroiderySubtypes: method.embroiderySubtypes }
          : {}),
        ...(method.pricingTiers ? { pricingTiers: method.pricingTiers } : {}),
        ...(method.maxWidthCm ? { maxWidthCm: method.maxWidthCm } : {}),
        ...(method.maxHeightCm ? { maxHeightCm: method.maxHeightCm } : {}),
      }]),
    ),
  };
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

export async function productionFeeVariantNeedsSync(
  feeVariantId: string,
  client: ShopifyGraphqlClient,
) {
  try {
    const result = await client.request<{
      node:
        | {
            id: string;
            availableForSale?: boolean | null;
            product?: { status?: string | null } | null;
          }
        | null;
    }>(
      `#graphql query CustomHouseProductionFeeVariant($id: ID!) {
        node(id: $id) {
          ... on ProductVariant {
            id
            availableForSale
            product { status }
          }
        }
      }`,
      { id: feeVariantId },
    );
    if (!Object.prototype.hasOwnProperty.call(result, "node")) {
      return false;
    }
    return (
      !result.node ||
      result.node.availableForSale === false ||
      result.node.product?.status === "ARCHIVED" ||
      result.node.product?.status === "DRAFT"
    );
  } catch {
    return false;
  }
}

export async function syncProductionFeeMerchandise(
  shop: string,
  pricing: PublicProductProductionPricingRecord,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
  options: { includeLegacyGenericEmbroidery?: boolean } = {},
) {
  const includeLegacyGenericEmbroidery =
    options.includeLegacyGenericEmbroidery !== false;
  const configuration = productProductionConfiguration(pricing);
  const feeEntries: Array<{
    method: string;
    artworkType: string | null;
    title: string;
    surcharge: string;
  }> = [];
  for (const [method, configured] of Object.entries(configuration.methods)) {
    if ("tiers" in configured) {
      for (const [artworkType, rate] of Object.entries(configured.tiers)) {
        feeEntries.push({
          method,
          artworkType,
          title: method === "EMBROIDERY"
            ? artworkType === "TEXT_ONLY"
              ? "Embroidery Text Production Fee"
              : "Embroidery Image or Logo Production Fee"
            : `${method} ${artworkType} Production Fee`,
          surcharge: rate.surcharge,
        });
      }
    } else {
      feeEntries.push({
        method,
        artworkType: null,
        title: `${method} Production Fee`,
        surcharge: configured.surcharge,
      });
    }
  }
  const existing = await client.request<{
    products: { nodes: ProductionFeeProductNode[] };
  }>(
    `#graphql query CustomHouseProductionFeeProduct($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          variants(first: 100) {
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
          variants(first: 100) {
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
              ...(includeLegacyGenericEmbroidery
                ? [{ name: "Embroidery Production Fee" }]
                : []),
              ...feeEntries.map((entry) => ({ name: entry.title })),
            ],
          },
        ],
        variants: [
          ...feeEntries.map((entry) => ({
            optionValues: [
              { optionName: FEE_PRODUCT_OPTION_NAME, name: entry.title },
            ],
            price: entry.surcharge,
            taxable: true,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: false },
          })),
          ...(includeLegacyGenericEmbroidery
            ? [
                {
                  optionValues: [
                    {
                      optionName: FEE_PRODUCT_OPTION_NAME,
                      name: "Embroidery Production Fee",
                    },
                  ],
                  price: pricing.embroiderySurcharge.toFixed(2),
                  taxable: true,
                  inventoryPolicy: "CONTINUE",
                  inventoryItem: { tracked: false },
                },
              ]
            : []),
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
  for (const entry of feeEntries) {
    const feeVariantId = variantByTitle.get(entry.title);
    if (!feeVariantId) {
      throw new DomainError(
        "PRODUCTION_FEE_VARIANTS_MISSING",
        "Production fee variants could not be synced.",
        502,
      );
    }
    const configured = configuration.methods[entry.method];
    if (!configured) continue;
    if ("tiers" in configured && entry.artworkType) {
      configured.tiers[entry.artworkType].feeVariantId = feeVariantId;
    } else if (!("tiers" in configured)) {
      configured.feeVariantId = feeVariantId;
    }
  }
  if (
    (includeLegacyGenericEmbroidery && !embroideryFeeVariantId) ||
    (configuration.methods.EMBROIDERY &&
      (!embroideryTextFeeVariantId || !embroideryImageFeeVariantId)) ||
    (configuration.methods.DTF && !dtfFeeVariantId) ||
    (configuration.methods.DTG && !dtgFeeVariantId)
  ) {
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
      ...(includeLegacyGenericEmbroidery ? { embroideryFeeVariantId } : {}),
      ...(embroideryTextFeeVariantId ? { embroideryTextFeeVariantId } : {}),
      ...(embroideryImageFeeVariantId ? { embroideryImageFeeVariantId } : {}),
      ...(dtfFeeVariantId ? { dtfFeeVariantId } : {}),
      ...(dtgFeeVariantId ? { dtgFeeVariantId } : {}),
      methodConfigurations: configuration as unknown as Prisma.InputJsonValue,
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

export async function saveProductProductionConfiguration(
  shop: string,
  input: SaveProductProductionConfigurationInput,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionPricingSyncState> {
  const currency = cleanCurrency(input.currency);
  const definitions = await methodSettings(shop, database);
  const existing = await getProductionPricing(shop, input.shopifyProductId, database);
  const previous = existing
    ? productProductionConfiguration(existing)
    : { version: 2 as const, methods: {} };
  const methods: ProductProductionConfiguration["methods"] = {
    ...previous.methods,
  };
  for (const definition of definitions) {
    const submitted = input.methods[definition.id];
    if (!submitted) continue;
    if (definition.pricingBehavior === "TIERED") {
      const previousMethod = methods[definition.id];
      const previousTiers = previousMethod && "tiers" in previousMethod
        ? previousMethod.tiers
        : null;
      const tiers: Record<string, ProductProductionRateConfiguration> = {};
      for (const tier of definition.tiers) {
        const submittedTier = submitted.tiers?.[tier];
        const previousTier = previousTiers?.[tier];
        tiers[tier] = submittedTier
          ? {
              enabled: cleanBoolean(submittedTier.enabled),
              surcharge: parseSurchargeInput(submittedTier.surcharge).toFixed(2),
              feeVariantId: previousTier?.feeVariantId || null,
            }
          : previousTier || { enabled: false, surcharge: "0.00", feeVariantId: null };
      }
      methods[definition.id] = {
        enabled: Object.values(tiers).some((tier) => tier.enabled),
        tiers,
      };
      continue;
    }
    const previousMethod = methods[definition.id];
    methods[definition.id] = {
      enabled: cleanBoolean(submitted.enabled),
      surcharge: parseSurchargeInput(submitted.surcharge ?? "0").toFixed(2),
      feeVariantId:
        previousMethod && !("tiers" in previousMethod)
          ? previousMethod.feeVariantId
          : null,
    };
  }
  const configuration: ProductProductionConfiguration = { version: 2, methods };
  const embroidery = methods.EMBROIDERY && "tiers" in methods.EMBROIDERY
    ? methods.EMBROIDERY
    : null;
  const dtf = methods.DTF && !("tiers" in methods.DTF) ? methods.DTF : null;
  const dtg = methods.DTG && !("tiers" in methods.DTG) ? methods.DTG : null;
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
      currency,
      methodConfigurations: configuration as unknown as Prisma.InputJsonValue,
      embroiderySurcharge: new Prisma.Decimal(0),
      embroideryTextSurcharge: parseSurchargeInput(
        embroidery?.tiers.TEXT_ONLY.surcharge ?? "0",
      ),
      embroideryImageSurcharge: parseSurchargeInput(
        embroidery?.tiers.IMAGE_OR_LOGO.surcharge ?? "0",
      ),
      dtfSurcharge: parseSurchargeInput(dtf?.surcharge ?? "0"),
      dtgSurcharge: parseSurchargeInput(dtg?.surcharge ?? "0"),
    },
    update: {
      currency,
      methodConfigurations: configuration as unknown as Prisma.InputJsonValue,
      embroideryTextSurcharge: parseSurchargeInput(
        embroidery?.tiers.TEXT_ONLY.surcharge ?? "0",
      ),
      embroideryImageSurcharge: parseSurchargeInput(
        embroidery?.tiers.IMAGE_OR_LOGO.surcharge ?? "0",
      ),
      dtfSurcharge: parseSurchargeInput(dtf?.surcharge ?? "0"),
      dtgSurcharge: parseSurchargeInput(dtg?.surcharge ?? "0"),
    },
  });

  const errors: string[] = [];
  let productionFeeSynced = false;
  let shopifySynced = false;
  try {
    const feeSync = await syncProductionFeeMerchandise(
      shop,
      pricing,
      client,
      database,
      { includeLegacyGenericEmbroidery: false },
    );
    pricing = feeSync.pricing;
    productionFeeSynced = feeSync.synced;
  } catch {
    errors.push("Production fee merchandise could not be synchronized.");
  }
  const metafieldValue = safeJson(
    canonicalProductionPricingBridgePayload(pricing, definitions),
  );
  const missingFeeMethods = missingRequiredFeeVariantMethods(
    JSON.parse(metafieldValue) as ProductionPricingBridgePayload,
  );
  if (missingFeeMethods.length) {
    errors.push("Production fee merchandise is missing for an enabled paid method.");
  } else {
    try {
      await syncProductionPricingMetafield(client, input.shopifyProductId, metafieldValue);
      shopifySynced = true;
    } catch {
      errors.push("The Shopify production configuration could not be synchronized.");
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

export async function saveProductionPricing(
  shop: string,
  input: SaveProductionPricingInput,
  client: ShopifyGraphqlClient,
  database: ProductionPricingDb = db as unknown as ProductionPricingDb,
): Promise<ProductionPricingSyncState> {
  const embroideryText = parseSurchargeInput(input.embroideryText);
  const embroideryImage = parseSurchargeInput(input.embroideryImage);
  const dtf = parseSurchargeInput(input.dtf);
  const dtg = parseSurchargeInput(input.dtg);
  const settings = await methodSettings(shop, database);
  const existing = await getProductionPricing(shop, input.shopifyProductId, database);
  const existingConfiguration = existing
    ? productProductionConfiguration(existing)
    : { version: 2 as const, methods: {} };
  const methodConfigurations: ProductProductionConfiguration = {
    version: 2,
    methods: {
      ...existingConfiguration.methods,
      EMBROIDERY: {
        enabled: true,
        tiers: {
          TEXT_ONLY: {
            enabled: true,
            surcharge: embroideryText.toFixed(2),
            feeVariantId: existing?.embroideryTextFeeVariantId || null,
          },
          IMAGE_OR_LOGO: {
            enabled: true,
            surcharge: embroideryImage.toFixed(2),
            feeVariantId: existing?.embroideryImageFeeVariantId || null,
          },
        },
      },
      DTF: {
        enabled: true,
        surcharge: dtf.toFixed(2),
        feeVariantId: existing?.dtfFeeVariantId || null,
      },
      DTG: {
        enabled: true,
        surcharge: dtg.toFixed(2),
        feeVariantId: existing?.dtgFeeVariantId || null,
      },
    },
  };
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
      currency: cleanCurrency(input.currency),
      methodConfigurations: methodConfigurations as unknown as Prisma.InputJsonValue,
      embroiderySurcharge: new Prisma.Decimal(0),
      embroideryTextSurcharge: embroideryText,
      embroideryImageSurcharge: embroideryImage,
      dtfSurcharge: dtf,
      dtgSurcharge: dtg,
    },
    update: {
      currency: cleanCurrency(input.currency),
      methodConfigurations: methodConfigurations as unknown as Prisma.InputJsonValue,
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
    const feeSync = await syncProductionFeeMerchandise(
      shop,
      pricing,
      client,
      database,
      { includeLegacyGenericEmbroidery: false },
    );
    pricing = feeSync.pricing;
    productionFeeSynced = feeSync.synced;
  } catch (error) {
    errors.push(
      `Production fee sync failed: ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
    );
  }

  const metafieldValue = safeJson(
    canonicalProductionPricingBridgePayload(pricing, settings),
  );
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

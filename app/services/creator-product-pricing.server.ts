import { Prisma } from "@prisma/client";
import { DomainError } from "./domain.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import {
  cleanEmbroiderySubtype,
  cleanProductionMethod,
  pricingForEmbroiderySubtype,
  pricingForMethod,
  type EmbroiderySubtype,
  type ProductionMethodCode,
  type PublicProductProductionPricingRecord,
} from "./production-method-pricing.server.ts";

export const CREATOR_PRICING_MODE_BAKED_IN_V1 = "BAKED_IN_V1" as const;

type PricingConfig = Pick<
  PublicProductProductionPricingRecord,
  | "embroiderySurcharge"
  | "embroideryTextSurcharge"
  | "embroideryImageSurcharge"
  | "dtfSurcharge"
  | "dtgSurcharge"
>;

export type CreatorPricingVariant = {
  id: string;
  price: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type CreatorPricingPreview = {
  pricingMode: typeof CREATOR_PRICING_MODE_BAKED_IN_V1;
  productionMethod: ProductionMethodCode;
  embroiderySubtype: EmbroiderySubtype | null;
  placementCount: number;
  surchargeMinor: string;
  productionCostMinor: string;
  variants: Array<{
    baseVariantId: string;
    optionIdentity: string;
    basePrice: string;
    productionCost: string;
    finalPrice: string;
  }>;
};

export type CreatorPublishedPricingPlan = Omit<CreatorPricingPreview, "variants"> & {
  creatorProductId: string;
  baseProductId: string;
  publishedProductId: string;
  variants: Array<{
    baseVariantId: string;
    publishedVariantId: string;
    optionIdentity: string;
    basePrice: string;
    currentPublishedPrice: string;
    productionCost: string;
    finalPrice: string;
  }>;
};

function normalizedOptionPart(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function canonicalVariantIdentity(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  if (!Array.isArray(selectedOptions) || !selectedOptions.length) {
    throw new DomainError(
      "CREATOR_VARIANT_IDENTITY_INVALID",
      "A Creator Product variant is missing its canonical option identity.",
      409,
    );
  }
  const pairs = selectedOptions.map((option) => ({
    name: normalizedOptionPart(String(option.name || "")),
    value: normalizedOptionPart(String(option.value || "")),
  }));
  if (pairs.some((pair) => !pair.name || !pair.value)) {
    throw new DomainError(
      "CREATOR_VARIANT_IDENTITY_INVALID",
      "A Creator Product variant contains an invalid option identity.",
      409,
    );
  }
  const names = pairs.map((pair) => pair.name);
  if (new Set(names).size !== names.length) {
    throw new DomainError(
      "CREATOR_VARIANT_IDENTITY_INVALID",
      "A Creator Product variant contains duplicate option names.",
      409,
    );
  }
  pairs.sort((left, right) =>
    left.name.localeCompare(right.name) || left.value.localeCompare(right.value),
  );
  return JSON.stringify(pairs);
}

function cleanVariantId(value: string, kind: "base" | "published") {
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value)) {
    throw new DomainError(
      "CREATOR_VARIANT_IDENTITY_INVALID",
      `A ${kind} Creator Product variant has an invalid Shopify identity.`,
      409,
    );
  }
  return value;
}

function priceMinor(value: string) {
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(value);
  } catch {
    throw new DomainError(
      "CREATOR_BASE_PRICE_INVALID",
      "A Creator Product base variant has an invalid price.",
      409,
    );
  }
  if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2) {
    throw new DomainError(
      "CREATOR_BASE_PRICE_INVALID",
      "A Creator Product base variant has an invalid price.",
      409,
    );
  }
  return decimalMoneyToMinorUnits(amount);
}

function decimalPrice(amountMinor: bigint) {
  const major = amountMinor / 100n;
  const minor = amountMinor % 100n;
  return `${major}.${minor.toString().padStart(2, "0")}`;
}

function productionSelection(input: {
  productionMethod: unknown;
  embroiderySubtype?: unknown;
  placementCount: number;
  pricing: PricingConfig;
  resolvedSurcharge?: Prisma.Decimal;
}) {
  if (!Number.isInteger(input.placementCount) || input.placementCount < 1) {
    throw new DomainError(
      "CREATOR_PLACEMENT_COUNT_INVALID",
      "Creator Product placement count must be configured before pricing.",
      409,
    );
  }
  const productionMethod = cleanProductionMethod(input.productionMethod);
  const embroiderySubtype = productionMethod === "EMBROIDERY"
    ? cleanEmbroiderySubtype(input.embroiderySubtype)
    : null;
  const surcharge = input.resolvedSurcharge ?? (embroiderySubtype
    ? pricingForEmbroiderySubtype(input.pricing, embroiderySubtype)
    : pricingForMethod(input.pricing, productionMethod));
  const surchargeMinor = decimalMoneyToMinorUnits(surcharge);
  if (surchargeMinor < 0n) {
    throw new DomainError(
      "INVALID_PRODUCTION_PRICING",
      "Production pricing cannot be negative.",
      409,
    );
  }
  return {
    productionMethod,
    embroiderySubtype,
    surchargeMinor,
    productionCostMinor: surchargeMinor * BigInt(input.placementCount),
  };
}

function uniqueVariantsByIdentity(
  variants: CreatorPricingVariant[],
  kind: "base" | "published",
) {
  const byIdentity = new Map<string, CreatorPricingVariant>();
  for (const variant of variants) {
    cleanVariantId(variant.id, kind);
    const identity = canonicalVariantIdentity(variant.selectedOptions);
    if (byIdentity.has(identity)) {
      throw new DomainError(
        "CREATOR_VARIANT_MAPPING_AMBIGUOUS",
        "Creator Product variants cannot be mapped uniquely to the base product.",
        409,
      );
    }
    byIdentity.set(identity, variant);
  }
  return byIdentity;
}

export function creatorProductionPricingPreview(input: {
  productionMethod: unknown;
  embroiderySubtype?: unknown;
  placementCount: number;
  pricing: PricingConfig;
  resolvedSurcharge?: Prisma.Decimal;
  baseVariants: CreatorPricingVariant[];
}): CreatorPricingPreview {
  const selection = productionSelection(input);
  if (!input.baseVariants.length) {
    throw new DomainError(
      "CREATOR_BASE_VARIANTS_REQUIRED",
      "Creator Product base variants are required before pricing.",
      409,
    );
  }
  uniqueVariantsByIdentity(input.baseVariants, "base");
  return {
    pricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
    productionMethod: selection.productionMethod,
    embroiderySubtype: selection.embroiderySubtype,
    placementCount: input.placementCount,
    surchargeMinor: selection.surchargeMinor.toString(),
    productionCostMinor: selection.productionCostMinor.toString(),
    variants: input.baseVariants.map((variant) => {
      const baseMinor = priceMinor(variant.price);
      return {
        baseVariantId: variant.id,
        optionIdentity: canonicalVariantIdentity(variant.selectedOptions),
        basePrice: decimalPrice(baseMinor),
        productionCost: decimalPrice(selection.productionCostMinor),
        finalPrice: decimalPrice(baseMinor + selection.productionCostMinor),
      };
    }),
  };
}

export function buildCreatorPublishedPricingPlan(input: {
  creatorProductId: string;
  baseProductId: string;
  publishedProductId: string;
  productionMethod: unknown;
  embroiderySubtype?: unknown;
  placementCount: number;
  pricing: PricingConfig;
  resolvedSurcharge?: Prisma.Decimal;
  baseVariants: CreatorPricingVariant[];
  publishedVariants: CreatorPricingVariant[];
}): CreatorPublishedPricingPlan {
  if (!input.creatorProductId.trim()) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product identity is required before pricing.",
      409,
    );
  }
  if (!input.publishedVariants.length) {
    throw new DomainError(
      "CREATOR_PUBLISHED_VARIANTS_REQUIRED",
      "Published Creator Product variants are required before pricing.",
      409,
    );
  }
  const preview = creatorProductionPricingPreview(input);
  const baseByIdentity = uniqueVariantsByIdentity(input.baseVariants, "base");
  uniqueVariantsByIdentity(input.publishedVariants, "published");
  const variants = input.publishedVariants.map((publishedVariant) => {
    const optionIdentity = canonicalVariantIdentity(publishedVariant.selectedOptions);
    const baseVariant = baseByIdentity.get(optionIdentity);
    if (!baseVariant) {
      throw new DomainError(
        "CREATOR_VARIANT_MAPPING_REQUIRED",
        "A published Creator Product variant could not be mapped safely to its base variant.",
        409,
      );
    }
    const baseMinor = priceMinor(baseVariant.price);
    const currentPublishedMinor = priceMinor(publishedVariant.price);
    const productionCostMinor = BigInt(preview.productionCostMinor);
    return {
      baseVariantId: baseVariant.id,
      publishedVariantId: publishedVariant.id,
      optionIdentity,
      basePrice: decimalPrice(baseMinor),
      currentPublishedPrice: decimalPrice(currentPublishedMinor),
      productionCost: decimalPrice(productionCostMinor),
      finalPrice: decimalPrice(baseMinor + productionCostMinor),
    };
  });
  return {
    ...preview,
    creatorProductId: input.creatorProductId,
    baseProductId: input.baseProductId,
    publishedProductId: input.publishedProductId,
    variants,
  };
}

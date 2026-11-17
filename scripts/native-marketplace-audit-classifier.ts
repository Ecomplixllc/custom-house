export type PublishedCreatorProductAuditCategory =
  | "OK"
  | "NEEDS_REPUBLISH"
  | "NEEDS_REPAIR"
  | "MISSING_MAPPING";

type AuditedVariant = {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type PublishedCreatorProductAuditInput = {
  creatorProductId: string;
  shopifyProductId: string | null;
  fixedColor: string | null;
  fixedProductionMethod: string | null;
  placementCount: number | null;
  shopifyProduct: {
    variants: AuditedVariant[];
    productOrigin: string | null;
    designMode: string | null;
    designStatus: string | null;
    productType: string | null;
    creatorProductId: string | null;
    fixedColor: string | null;
    productionMethod: string | null;
    designedPlacementCount: string | null;
    creatorCartValidation: unknown | null;
  } | null;
};

export type PublishedCreatorProductAuditResult = {
  category: PublishedCreatorProductAuditCategory;
  issues: string[];
  variantCount: number;
  allVariantsMatchFixedColor: boolean;
  canonicalMetafieldsPresent: boolean;
  validationContractPresent: boolean;
};

export type NativeProductCandidate = {
  id: string;
  title: string;
  handle: string;
  productOrigin: string | null;
  designMode: string | null;
  designStatus: string | null;
  productType: string | null;
  creatorId: string | null;
  creatorProductId: string | null;
};

export type MissingMappingReconciliationCategory =
  | "EXISTING_NATIVE_PRODUCT_FOUND"
  | "PUBLISHED_BUT_NATIVE_PRODUCT_MISSING"
  | "STALE_OR_TEST_RECORD"
  | "MANUAL_REVIEW_REQUIRED";

export type MissingMappingReconciliationInput = {
  creatorProductId: string;
  status: string;
  creatorId: string;
  creatorStatus: string;
  baseShopifyProductId: string | null;
  fixedColor: string | null;
  fixedProductionMethod: string | null;
  placementCount: number | null;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  previewPresent: boolean;
  candidates: NativeProductCandidate[];
};

export type MissingMappingReconciliationResult = {
  category: MissingMappingReconciliationCategory;
  proposedShopifyProductId: string | null;
  reason: string;
};

export function auditProductIdFromArgs(args: string[]) {
  const value = args.find((arg) => arg.startsWith("--product="))?.slice(10).trim();
  return value || null;
}

const COLOR_OPTION_NAMES = new Set([
  "color",
  "colour",
  "farg",
  "farbe",
  "couleur",
  "colore",
  "kleur",
  "kolor",
  "cor",
]);

function normalizedText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("en");
}

function variantColor(variant: AuditedVariant) {
  return variant.selectedOptions.find((option) =>
    COLOR_OPTION_NAMES.has(normalizedText(option.name)),
  )?.value;
}

function parsedContract(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parsedContract(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validValidationContract(
  value: unknown,
  creatorProductId: string,
  placementCount: number | null,
) {
  const contract = parsedContract(value);
  if (
    !contract ||
    contract.version !== 1 ||
    contract.creatorProductId !== creatorProductId ||
    typeof contract.feeRequired !== "boolean" ||
    !Number.isInteger(contract.placementCount) ||
    (contract.placementCount as number) < 1
  ) {
    return false;
  }
  if (placementCount && contract.placementCount !== placementCount) return false;
  return contract.feeRequired
    ? typeof contract.feeVariantId === "string" &&
        contract.feeVariantId.length > 0
    : contract.feeVariantId === null;
}

function exactCanonicalCandidate(
  input: MissingMappingReconciliationInput,
  candidate: NativeProductCandidate,
) {
  return (
    candidate.creatorProductId === input.creatorProductId &&
    candidate.creatorId === input.creatorId &&
    candidate.productOrigin === "creator" &&
    candidate.designMode === "buy_only" &&
    candidate.designStatus === "published" &&
    candidate.productType === "creator_fixed"
  );
}

export function classifyMissingMappingRecord(
  input: MissingMappingReconciliationInput,
): MissingMappingReconciliationResult {
  if (input.status !== "PUBLISHED" || input.creatorStatus !== "APPROVED") {
    return {
      category: "STALE_OR_TEST_RECORD",
      proposedShopifyProductId: null,
      reason: `explicit non-live lifecycle: product=${input.status}, creator=${input.creatorStatus}`,
    };
  }

  const exactCandidates = input.candidates.filter((candidate) =>
    exactCanonicalCandidate(input, candidate),
  );
  if (exactCandidates.length === 1) {
    return {
      category: "EXISTING_NATIVE_PRODUCT_FOUND",
      proposedShopifyProductId: exactCandidates[0]!.id,
      reason:
        "one Shopify product matches the CreatorProduct, Creator, and all canonical native-product identity metafields",
    };
  }
  if (exactCandidates.length > 1) {
    return {
      category: "MANUAL_REVIEW_REQUIRED",
      proposedShopifyProductId: null,
      reason: "multiple Shopify products carry the same canonical CreatorProduct identity",
    };
  }
  if (input.candidates.length > 0) {
    return {
      category: "MANUAL_REVIEW_REQUIRED",
      proposedShopifyProductId: null,
      reason:
        "Shopify product candidates exist, but none proves the complete canonical identity; title or handle evidence is insufficient",
    };
  }

  const missing = [
    !input.baseShopifyProductId ? "baseShopifyProductId" : null,
    !input.fixedColor?.trim() ? "fixedColor" : null,
    !input.fixedProductionMethod?.trim() ? "fixedProductionMethod" : null,
    !Number.isInteger(input.placementCount) || Number(input.placementCount) < 1
      ? "placementCount"
      : null,
    !input.pitchprintProjectId && !input.pitchprintDesignId
      ? "savedDesignIdentity"
      : null,
    !input.previewPresent ? "preview" : null,
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    return {
      category: "MANUAL_REVIEW_REQUIRED",
      proposedShopifyProductId: null,
      reason: `required canonical republish data is missing: ${missing.join(", ")}`,
    };
  }

  return {
    category: "PUBLISHED_BUT_NATIVE_PRODUCT_MISSING",
    proposedShopifyProductId: null,
    reason:
      "record is published, Creator is approved, canonical setup is complete, and no Shopify product candidate exists",
  };
}

export function classifyPublishedCreatorProduct(
  input: PublishedCreatorProductAuditInput,
): PublishedCreatorProductAuditResult {
  if (!input.shopifyProductId) {
    return {
      category: "MISSING_MAPPING",
      issues: ["missing published Shopify product mapping"],
      variantCount: 0,
      allVariantsMatchFixedColor: false,
      canonicalMetafieldsPresent: false,
      validationContractPresent: false,
    };
  }

  if (!input.shopifyProduct) {
    return {
      category: "NEEDS_REPAIR",
      issues: ["mapped Shopify product was not found"],
      variantCount: 0,
      allVariantsMatchFixedColor: false,
      canonicalMetafieldsPresent: false,
      validationContractPresent: false,
    };
  }

  const product = input.shopifyProduct;
  const repairIssues: string[] = [];
  const republishIssues: string[] = [];
  const canonicalChecks = [
    ["customhouse.product_origin", product.productOrigin, "creator"],
    ["customhouse.design_mode", product.designMode, "buy_only"],
    ["customhouse.design_status", product.designStatus, "published"],
    ["customhouse.product_type", product.productType, "creator_fixed"],
    [
      "customhouse.creator_product_id",
      product.creatorProductId,
      input.creatorProductId,
    ],
  ] as const;
  const missingCanonical = canonicalChecks
    .filter(([, actual, expected]) => actual !== expected)
    .map(([name]) => name);
  const canonicalMetafieldsPresent = missingCanonical.length === 0;
  if (!canonicalMetafieldsPresent) {
    repairIssues.push(
      `missing or incorrect canonical metafields: ${missingCanonical.join(", ")}`,
    );
  }

  if (!input.fixedColor?.trim()) {
    repairIssues.push("saved fixed color is missing");
  }
  if (!input.fixedProductionMethod?.trim()) {
    repairIssues.push("saved fixed production method is missing");
  }
  if (!Number.isInteger(input.placementCount) || Number(input.placementCount) < 1) {
    repairIssues.push("saved placement count is missing or invalid");
  }
  if (
    input.fixedColor?.trim() &&
    normalizedText(product.fixedColor || "") !== normalizedText(input.fixedColor)
  ) {
    repairIssues.push("Shopify fixed color metadata does not match the saved setup");
  }
  if (
    input.fixedProductionMethod?.trim() &&
    normalizedText(product.productionMethod || "") !==
      normalizedText(input.fixedProductionMethod)
  ) {
    repairIssues.push("Shopify production method metadata does not match the saved setup");
  }
  if (
    input.placementCount &&
    Number(product.designedPlacementCount) !== input.placementCount
  ) {
    repairIssues.push("Shopify placement count metadata does not match the saved setup");
  }

  const normalizedFixedColor = input.fixedColor
    ? normalizedText(input.fixedColor)
    : "";
  const allVariantsMatchFixedColor =
    normalizedFixedColor.length > 0 &&
    product.variants.length > 0 &&
    product.variants.every((variant) => {
      const color = variantColor(variant);
      return Boolean(color && normalizedText(color) === normalizedFixedColor);
    });
  if (!allVariantsMatchFixedColor) {
    repairIssues.push("Shopify variants do not all match the saved fixed color");
  }

  const validationContractPresent = validValidationContract(
    product.creatorCartValidation,
    input.creatorProductId,
    input.placementCount,
  );
  if (!validationContractPresent) {
    republishIssues.push(
      "Creator validation contract customhouse.creator_cart_validation is missing or invalid; republish this Creator product",
    );
  }

  const category: PublishedCreatorProductAuditCategory = repairIssues.length
    ? "NEEDS_REPAIR"
    : republishIssues.length
      ? "NEEDS_REPUBLISH"
      : "OK";

  return {
    category,
    issues: [...repairIssues, ...republishIssues],
    variantCount: product.variants.length,
    allVariantsMatchFixedColor,
    canonicalMetafieldsPresent,
    validationContractPresent,
  };
}

import { Prisma } from "@prisma/client";
import db from "../db.server.ts";
import { DomainError } from "./domain.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import {
  cleanEmbroiderySubtype,
  cleanProductionMethod,
  resolveProductionPricing,
  type EmbroiderySubtype,
  type PublicProductProductionPricingRecord,
} from "./production-method-pricing.server.ts";
import { classifyPitchPrintProjectSource } from "./pitchprint-project-metadata.ts";

type ProductionCartDb = {
  publicProductProductionPricing: {
    findUnique(args: unknown): Promise<PublicProductProductionPricingRecord | null>;
  };
  productionMethodSetting?: {
    findMany(args: unknown): Promise<Array<{
      method: string;
      label: string;
      description: string;
      enabled: boolean;
      pricingBehavior?: string;
      configurationJson?: Prisma.JsonValue;
    }>>;
  };
};

export type PublicProductionCartInput = {
  shopifyProductId?: unknown;
  pitchprintProjectId?: unknown;
  pitchprintDesignId?: unknown;
  productionMethod?: unknown;
  selectedProductionMethod?: unknown;
  artworkType?: unknown;
  embroiderySubtype?: unknown;
  placementCount?: unknown;
  placements?: unknown;
  totalQuantity?: unknown;
  selectedColors?: unknown;
  artworkSource?: unknown;
  source?: unknown;
  projectData?: unknown;
  legalConfirmations?: unknown;
  rightsAccepted?: unknown;
  termsAccepted?: unknown;
  selections?: unknown;
  variantSelections?: unknown;
  previewUrl?: unknown;
  browserSurchargeMinor?: unknown;
  browserTotalMinor?: unknown;
};

type VariantForPricing = {
  id: string;
  legacyResourceId: string;
  price: string;
  availableForSale: boolean;
  selectedOptions?: Array<{
    name: string;
    value: string;
  }>;
};

type TrustedSelection = {
  variantId: string;
  priceMinor: bigint;
  quantity: number;
};

function numericId(value: string) {
  const match = value.match(/(\d+)$/);
  if (!match) {
    throw new DomainError(
      "INVALID_CART_VARIANT",
      "This product option cannot be added to cart.",
      409,
    );
  }
  return match[1];
}

function cleanProductId(value: unknown) {
  const productId = typeof value === "string" ? value.trim() : "";
  if (
    !/^gid:\/\/shopify\/Product\/\d+$/.test(productId) &&
    !/^\d+$/.test(productId)
  ) {
    throw new DomainError(
      "INVALID_PRODUCT",
      "Choose a valid customizable product.",
      422,
    );
  }
  return productId.startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;
}

function cleanPitchPrintProjectId(value: unknown) {
  const projectId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,200}$/.test(projectId)) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "Save your PitchPrint design before adding to cart.",
      422,
    );
  }
  return projectId;
}

function cleanPreviewUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function cleanOptionalPitchPrintId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,200}$/.test(id) ? id : "";
}

function confirmed(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "Accepted";
}

function publicLegalConfirmations(input: PublicProductionCartInput) {
  const legal =
    input.legalConfirmations &&
    typeof input.legalConfirmations === "object" &&
    !Array.isArray(input.legalConfirmations)
      ? (input.legalConfirmations as Record<string, unknown>)
      : {};
  const rightsAccepted = confirmed(
    input.rightsAccepted ??
      legal.rightsAccepted ??
      legal.copyrightAccepted ??
      legal.copyrightConfirmed,
  );
  const termsAccepted = confirmed(
    input.termsAccepted ?? legal.termsAccepted ?? legal.termsConfirmed,
  );
  if (!rightsAccepted) {
    throw new DomainError(
      "COPYRIGHT_CONFIRMATION_REQUIRED",
      "Confirm that you have the rights to use this design before adding it to cart.",
      422,
    );
  }
  if (!termsAccepted) {
    throw new DomainError(
      "TERMS_ACCEPTANCE_REQUIRED",
      "Accept the Terms and Conditions before adding this customized product to cart.",
      422,
    );
  }
  return { rightsAccepted, termsAccepted };
}

function publicArtworkFacts(input: PublicProductionCartInput) {
  const candidates = [input.artworkSource, input.projectData, input.source];
  let lastError: unknown;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    try {
      return classifyPitchPrintProjectSource(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof DomainError) throw lastError;
  throw new DomainError(
    "PITCHPRINT_ARTWORK_TYPE_UNRESOLVED",
    "The saved artwork type could not be verified. Please return to the editor and save the design again.",
    422,
  );
}

function cleanTextList(value: unknown, maximum = 20) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => String(entry || "").trim().slice(0, 120))
        .filter(Boolean),
    ),
  ).slice(0, maximum);
}

function cleanSelections(value: unknown) {
  if (!Array.isArray(value)) {
    throw new DomainError(
      "PRODUCTION_SELECTION_REQUIRED",
      "Select at least one product option.",
      422,
    );
  }
  const selections = value.map((item) => {
    const record =
      item && typeof item === "object"
        ? (item as {
            variantId?: unknown;
            quantity?: unknown;
            color?: unknown;
            size?: unknown;
          })
        : {};
    const variantId = typeof record.variantId === "string" ? record.variantId.trim() : "";
    const quantity = Number(record.quantity);
    if (
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId) &&
      !/^\d+$/.test(variantId)
    ) {
      throw new DomainError(
        "INVALID_VARIANT",
        "Choose a valid variant for this product.",
        422,
      );
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new DomainError(
        "INVALID_QUANTITY",
        "Choose a valid quantity.",
        422,
      );
    }
    return {
      variantId: variantId.startsWith("gid://")
        ? variantId
        : `gid://shopify/ProductVariant/${variantId}`,
      quantity,
      color: typeof record.color === "string" ? record.color.trim().slice(0, 120) : "",
      size: typeof record.size === "string" ? record.size.trim().slice(0, 120) : "",
    };
  });
  if (!selections.length) {
    throw new DomainError(
      "PRODUCTION_SELECTION_REQUIRED",
      "Select at least one product option.",
      422,
    );
  }
  return selections;
}

function priceToMinor(value: string) {
  return decimalMoneyToMinorUnits(new Prisma.Decimal(value));
}

function normalizedText(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function calculateTrustedProductionTotal(input: {
  surchargeMinor: bigint;
  selections: TrustedSelection[];
  placementCount?: number;
}) {
  let productSubtotalMinor = 0n;
  let totalQuantity = 0;
  for (const selection of input.selections) {
    productSubtotalMinor += selection.priceMinor * BigInt(selection.quantity);
    totalQuantity += selection.quantity;
  }
  const placementCount = input.placementCount ?? 1;
  const productionFeeQuantity = totalQuantity * placementCount;
  const productionSurchargeMinor = input.surchargeMinor * BigInt(productionFeeQuantity);
  return {
    productSubtotalMinor,
    productionSurchargeMinor,
    totalQuantity,
    placementCount,
    productionFeeQuantity,
    totalMinor: productSubtotalMinor + productionSurchargeMinor,
  };
}

async function publicCustomizableProduct(
  client: ShopifyGraphqlClient,
  productId: string,
) {
  const result = await client.request<{
    product: {
      id: string;
      tags: string[];
      productType: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      origin: { value: string } | null;
      mode: { value: string } | null;
      variants: { nodes: VariantForPricing[] };
    } | null;
  }>(
    `#graphql query PublicProductionPricingProduct($id: ID!) {
      product(id: $id) {
        id tags
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
        variants(first: 250) {
          nodes {
            id
            legacyResourceId
            price
            availableForSale
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  const tags = new Set((product?.tags || []).map((tag) => normalizedText(tag)));
  const productType = normalizedText(product?.productType?.value);
  const origin = normalizedText(product?.origin?.value);
  const mode = normalizedText(product?.mode?.value);
  const isCreatorLocked =
    productType === "creator_fixed" ||
    tags.has("creator-fixed") ||
    origin === "creator" ||
    mode === "buy_only";
  const isPublicCustomizable =
    (origin === "global" && mode === "customizable") ||
    productType === "global_customizable";
  const hasPitchPrintSignal =
    product?.pitchprintEnabled?.value === "true" ||
    tags.has("pitchprint") ||
    tags.has("pitchprint-enabled") ||
    tags.has("pitchprint-designlab") ||
    tags.has("pitchprint-options");
  if (
    !product ||
    isCreatorLocked ||
    !isPublicCustomizable ||
    !hasPitchPrintSignal
  ) {
    throw new DomainError(
      "INVALID_PUBLIC_PRODUCT",
      "Production pricing is only available for public customizable products.",
      422,
    );
  }
  return product;
}

export async function preparePublicProductionCart(
  shop: string,
  input: PublicProductionCartInput,
  client: ShopifyGraphqlClient,
  database: ProductionCartDb = db as unknown as ProductionCartDb,
) {
  const productId = cleanProductId(input.shopifyProductId);
  const pitchprintProjectId = cleanPitchPrintProjectId(input.pitchprintProjectId);
  const pitchprintDesignId = cleanOptionalPitchPrintId(input.pitchprintDesignId);
  const productionMethod = cleanProductionMethod(
    input.selectedProductionMethod ?? input.productionMethod,
  );
  const selections = cleanSelections(input.variantSelections ?? input.selections);
  const product = await publicCustomizableProduct(client, productId);
  publicLegalConfirmations(input);
  const artworkFacts = publicArtworkFacts(input);
  const placementCount = artworkFacts.placementCount;
  const claimedPlacementCount = Number(input.placementCount || 0);
  if (
    claimedPlacementCount &&
    (!Number.isSafeInteger(claimedPlacementCount) || claimedPlacementCount !== placementCount)
  ) {
    throw new DomainError(
      "PLACEMENT_COUNT_MISMATCH",
      "The saved design placement count could not be verified. Please save the design again.",
      422,
    );
  }
  const embroiderySubtype: EmbroiderySubtype | null =
    productionMethod === "EMBROIDERY" ? artworkFacts.embroiderySubtype : null;
  if (productionMethod === "EMBROIDERY") {
    const claimedSubtype = input.embroiderySubtype ?? input.artworkType;
    if (
      claimedSubtype !== undefined &&
      claimedSubtype !== null &&
      cleanEmbroiderySubtype(claimedSubtype) !== embroiderySubtype
    ) {
      throw new DomainError(
        "EMBROIDERY_ARTWORK_MISMATCH",
        "The saved embroidery artwork type does not match the design. Please save the design again.",
        422,
      );
    }
  }
  const selectedColors = cleanTextList(input.selectedColors);
  const resolvedPricing = await resolveProductionPricing({
    shop,
    productId,
    method: productionMethod,
    artworkType: embroiderySubtype,
    database: database as Parameters<typeof resolveProductionPricing>[0]["database"],
  });
  const surchargeMinor = resolvedPricing.surchargeMinor;
  const feeVariantId = resolvedPricing.feeRequired
    ? resolvedPricing.feeVariantId
    : null;
  if (resolvedPricing.feeRequired && !feeVariantId) {
    throw new DomainError(
      "PRODUCTION_FEE_SYNC_REQUIRED",
      "Production fee merchandise is not synced for this product.",
      409,
    );
  }
  const variantsById = new Map(
    product.variants.nodes.map((variant) => [variant.id, variant]),
  );
  const trustedSelections = selections.map((selection) => {
    const variant = variantsById.get(selection.variantId);
    if (!variant) {
      throw new DomainError(
        "INVALID_VARIANT",
        "Choose a valid variant for this product.",
        422,
      );
    }
    if (!variant.availableForSale) {
      throw new DomainError(
        "VARIANT_UNAVAILABLE",
        "Choose an available variant.",
        409,
      );
    }
    const selectedOptionValues = new Set(
      (variant.selectedOptions || []).map((option) => normalizedText(option.value)),
    );
    if (
      (selection.color && !selectedOptionValues.has(normalizedText(selection.color))) ||
      (selection.size && !selectedOptionValues.has(normalizedText(selection.size)))
    ) {
      throw new DomainError(
        "VARIANT_OPTION_MISMATCH",
        "The selected variant options do not match this product.",
        422,
      );
    }
    return {
      ...selection,
      cartId: variant.legacyResourceId || numericId(variant.id),
      priceMinor: priceToMinor(variant.price),
    };
  });
  const totals = calculateTrustedProductionTotal({
    surchargeMinor,
    selections: trustedSelections,
    placementCount,
  });
  const claimedTotalQuantity = Number(input.totalQuantity || 0);
  if (
    claimedTotalQuantity &&
    (!Number.isSafeInteger(claimedTotalQuantity) ||
      claimedTotalQuantity !== totals.totalQuantity)
  ) {
    throw new DomainError(
      "TOTAL_QUANTITY_MISMATCH",
      "The selected product quantity could not be verified.",
      422,
    );
  }
  const feeKey = [
    "ch-production",
    numericId(productId),
    pitchprintProjectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    productionMethod.toLowerCase(),
    ...(embroiderySubtype ? [embroiderySubtype.toLowerCase()] : []),
  ].join("-");
  const previewUrl = cleanPreviewUrl(input.previewUrl);
  const baseProperties = {
    _pitchprint: pitchprintProjectId,
    _design_id: pitchprintDesignId,
    _pitchprint_design_id: pitchprintDesignId,
    _customhouse_public_customize: "true",
    _production_method: productionMethod,
    _designed_placement_count: String(placementCount),
    _designed_placements: JSON.stringify(artworkFacts.placements),
    ...(selectedColors.length
      ? { _selected_colors: JSON.stringify(selectedColors) }
      : {}),
    ...(embroiderySubtype ? { _embroidery_subtype: embroiderySubtype } : {}),
    _customhouse_fee_key: feeKey,
    _customhouse_parent_product_id: productId,
    _customhouse_non_return_acknowledgement: "Accepted",
    _customhouse_terms_acknowledgement: "Accepted",
    _customhouse_public_cart_validation: JSON.stringify({
      version: 1,
      feeRequired: resolvedPricing.feeRequired,
      feeVariantId,
      productionMethod,
      embroiderySubtype,
      placementCount,
    }),
    "Printing method": productionMethod,
    ...(embroiderySubtype ? { "Artwork type": embroiderySubtype } : {}),
    "Designed placements": String(placementCount),
    "Customized product acknowledgement": "Accepted",
    "Terms & Conditions": "Accepted",
    ...(previewUrl ? { _pitchprint_preview: previewUrl } : {}),
  };
  const items = [
    ...trustedSelections.map((selection) => ({
      id: selection.cartId,
      quantity: selection.quantity,
      properties: baseProperties,
    })),
    ...(resolvedPricing.feeRequired && feeVariantId
      ? [{
          id: numericId(feeVariantId),
          quantity: totals.productionFeeQuantity,
          properties: {
            _customhouse_production_fee: "true",
            _customhouse_parent_product_id: productId,
            _customhouse_parent_project_id: pitchprintProjectId,
            _customhouse_fee_key: feeKey,
            _pitchprint: pitchprintProjectId,
            _production_method: productionMethod,
            _designed_placement_count: String(placementCount),
            ...(embroiderySubtype ? { _embroidery_subtype: embroiderySubtype } : {}),
          },
        }]
      : []),
  ];
  return {
    items,
    productionMethod,
    embroiderySubtype,
    artworkType: embroiderySubtype,
    placements: artworkFacts.placements,
    placementCount,
    feeVariantId,
    feeRequired: resolvedPricing.feeRequired,
    feeKey,
    totals,
  };
}

export function jsonSafePublicProductionCart(
  cart: Awaited<ReturnType<typeof preparePublicProductionCart>>,
) {
  return {
    ...cart,
    totals: {
      ...cart.totals,
      productSubtotalMinor: Number(cart.totals.productSubtotalMinor),
      productionSurchargeMinor: Number(cart.totals.productionSurchargeMinor),
      totalMinor: Number(cart.totals.totalMinor),
    },
  };
}

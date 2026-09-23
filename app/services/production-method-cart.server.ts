import { Prisma } from "@prisma/client";
import db from "../db.server.ts";
import { DomainError } from "./domain.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import {
  cleanProductionMethod,
  feeVariantIdForMethod,
  pricingForMethod,
  type PublicProductProductionPricingRecord,
} from "./production-method-pricing.server.ts";

type ProductionCartDb = {
  publicProductProductionPricing: {
    findUnique(args: unknown): Promise<PublicProductProductionPricingRecord | null>;
  };
};

export type PublicProductionCartInput = {
  shopifyProductId?: unknown;
  pitchprintProjectId?: unknown;
  pitchprintDesignId?: unknown;
  productionMethod?: unknown;
  selections?: unknown;
  previewUrl?: unknown;
  browserSurchargeMinor?: unknown;
  browserTotalMinor?: unknown;
};

type VariantForPricing = {
  id: string;
  legacyResourceId: string;
  price: string;
  availableForSale: boolean;
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
        ? (item as { variantId?: unknown; quantity?: unknown })
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
}) {
  let productSubtotalMinor = 0n;
  let totalQuantity = 0;
  for (const selection of input.selections) {
    productSubtotalMinor += selection.priceMinor * BigInt(selection.quantity);
    totalQuantity += selection.quantity;
  }
  const productionSurchargeMinor = input.surchargeMinor * BigInt(totalQuantity);
  return {
    productSubtotalMinor,
    productionSurchargeMinor,
    totalQuantity,
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
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            price
            availableForSale
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
  const productionMethod = cleanProductionMethod(input.productionMethod);
  const selections = cleanSelections(input.selections);
  const product = await publicCustomizableProduct(client, productId);
  const pricing = await database.publicProductProductionPricing.findUnique({
    where: {
      shopKey_shopifyProductId: {
        shopKey: shop,
        shopifyProductId: productId,
      },
    },
  });
  if (!pricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Production pricing is not configured for this product.",
      409,
    );
  }
  const surcharge = pricingForMethod(pricing, productionMethod);
  const surchargeMinor = decimalMoneyToMinorUnits(surcharge);
  const feeVariantId = feeVariantIdForMethod(pricing, productionMethod);
  if (!feeVariantId) {
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
    return {
      ...selection,
      cartId: variant.legacyResourceId || numericId(variant.id),
      priceMinor: priceToMinor(variant.price),
    };
  });
  const totals = calculateTrustedProductionTotal({
    surchargeMinor,
    selections: trustedSelections,
  });
  const feeKey = [
    "ch-production",
    numericId(productId),
    pitchprintProjectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    productionMethod.toLowerCase(),
  ].join("-");
  const previewUrl = cleanPreviewUrl(input.previewUrl);
  const baseProperties = {
    _pitchprint: pitchprintProjectId,
    _production_method: productionMethod,
    _customhouse_fee_key: feeKey,
    _customhouse_parent_product_id: productId,
    ...(previewUrl ? { _pitchprint_preview: previewUrl } : {}),
  };
  const items = [
    ...trustedSelections.map((selection) => ({
      id: selection.cartId,
      quantity: selection.quantity,
      properties: baseProperties,
    })),
    {
      id: numericId(feeVariantId),
      quantity: totals.totalQuantity,
      properties: {
        _customhouse_production_fee: "true",
        _customhouse_parent_product_id: productId,
        _customhouse_parent_project_id: pitchprintProjectId,
        _customhouse_fee_key: feeKey,
        _pitchprint: pitchprintProjectId,
        _production_method: productionMethod,
      },
    },
  ];
  return {
    items,
    productionMethod,
    feeKey,
    totals,
  };
}

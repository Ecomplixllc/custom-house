import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { inkyBayProductContract } from "./inkybay/inkybay-product.server.ts";
import { normalizeCustomerGid } from "./helium-sync.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import {
  clonePitchPrintProject,
  type PitchPrintProjectCloner,
} from "./pitchprint-clone.server.ts";
import { signCreatorAttribution } from "./creator-attribution.server.ts";
import {
  getCreatorCollectionByCreatorId,
  getPublicCreatorCollection,
} from "./creator-collections.server.ts";
import { createAdminNotification } from "./admin-notifications.server.ts";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls.ts";
import { decimalMoneyToMinorUnits } from "./money.ts";
import {
  FEE_PRODUCT_TAG,
  FEE_PRODUCT_TITLE_PREFIX,
  FEE_PRODUCT_TYPE,
  CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
  PRODUCTION_METHODS,
  cleanEmbroiderySubtype,
  cleanProductionMethod,
  feeVariantIdForEmbroiderySubtype,
  feeVariantIdForMethod,
  getCreatorProductionPricing,
  getEnabledProductionMethodsForProduct,
  getProductionPricingBridgeForProduct,
  getProductionPricing,
  productionFeeVariantNeedsSync,
  pricingForEmbroiderySubtype,
  pricingForMethod,
  resolveProductionPricing,
  type EnabledProductionMethod,
  syncProductionFeeMerchandise,
  type ProductionMethodCode,
  type EmbroiderySubtype,
} from "./production-method-pricing.server.ts";
import { classifyPitchPrintProjectSource } from "./pitchprint-project-metadata.ts";
import { fetchPitchPrintProjectSource } from "./pitchprint-project-fetch.server.ts";
import {
  canonicalVariantIdentity,
  creatorProductionPricingPreview,
  CREATOR_PRICING_MODE_BAKED_IN_V1,
} from "./creator-product-pricing.server.ts";

export type CreatorProductRecord = {
  id: string;
  shop: string;
  creatorId: string;
  shopifyProductId: string;
  shopifyProductHandle: string | null;
  baseProductTitle: string;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  title: string;
  description: string | null;
  previewUrl: string | null;
  previewUrls: string;
  baseProductVariantsJson: string;
  designVariantSelectionsJson: string;
  status: string;
  submittedAt: Date | null;
  publishedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  publishedShopifyProductId?: string | null;
  publishedShopifyProductHandle?: string | null;
  publishedShopifyProductUrl?: string | null;
  shopifyPublishedAt?: Date | null;
  baseVariantMappingJson?: string;
  creatorPricingMode?: string | null;
  creatorPricingPreviewJson?: string;
  createdAt: Date;
  updatedAt: Date;
};

type CreatorProductDb = {
  creator: {
    findUnique(args: unknown): Promise<{
      id: string;
      handle?: string;
      status: string;
      marketplaceCollection?: {
        publicHandle: string;
        status: string;
        shopifyCollectionUrl?: string | null;
      } | null;
    } | null>;
    findFirst?(args: unknown): Promise<{
      id: string;
      handle: string;
      displayName: string;
      customerId?: string;
      status: string;
    } | null>;
  };
  creatorCollection?: {
    findFirst(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
  };
  creatorProduct: {
    create(args: unknown): Promise<CreatorProductRecord>;
    delete?(args: unknown): Promise<CreatorProductRecord>;
    findMany(args: unknown): Promise<CreatorProductRecord[]>;
    findFirst(args: unknown): Promise<CreatorProductRecord | null>;
    update(args: unknown): Promise<CreatorProductRecord>;
  };
  productionMethodSetting?: {
    findMany(args: unknown): Promise<
      Array<{
        method: string;
        label?: string;
        description?: string;
        enabled: boolean;
      }>
    >;
  };
  publicProductProductionPricing?: {
    findUnique(args: unknown): Promise<unknown>;
  };
  creatorSale?: {
    count(args?: unknown): Promise<number>;
  };
  creatorOrderItem?: {
    count(args?: unknown): Promise<number>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
};

export type CreateCreatorProductInput = {
  shopifyProductId: unknown;
  title?: unknown;
  description?: unknown;
  pitchprintDesignId?: unknown;
  fixedColor?: unknown;
  selectedColors?: unknown;
  selectedProductionMethod?: unknown;
  fixedProductionMethod?: unknown;
};

export type AttachPitchPrintProjectInput = {
  projectId?: unknown;
  creatorProjectId?: unknown;
  creatorProductId?: unknown;
  previews?: unknown;
  sidePreviews?: unknown;
  previewUrl?: unknown;
  designId?: unknown;
  source?: unknown;
  numPages?: unknown;
  meta?: unknown;
  variantSelections?: unknown;
  creatorSetup?: unknown;
  selectedColor?: unknown;
  selectedColorDetail?: unknown;
  selectedColors?: unknown;
  fixedColor?: unknown;
  activeColor?: unknown;
  color?: unknown;
  colorValues?: unknown;
  productColors?: unknown;
  variantColor?: unknown;
  selectedProductionMethod?: unknown;
  productionMethod?: unknown;
  fixedProductionMethod?: unknown;
  placementCount?: unknown;
  designedPlacementCount?: unknown;
  placements?: unknown;
  designedPlacements?: unknown;
  artworkType?: unknown;
  embroiderySubtype?: unknown;
  artworkSummary?: unknown;
  copyrightAccepted?: unknown;
  copyrightConfirmed?: unknown;
  rightsConfirmed?: unknown;
  nonReturnAcknowledged?: unknown;
};

export type SavePitchPrintDraftSessionInput = {
  projectId?: unknown;
  designId?: unknown;
};

export type PitchPrintProjectFetcher = (
  projectId: unknown,
) => Promise<Record<string, unknown>>;

export type UpdateCreatorProductDetailsInput = {
  title?: unknown;
  description?: unknown;
};

export type EligibleCreatorBaseProduct = {
  id: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  pitchprintDesignId: string | null;
  productionMethodPricing: string | null;
  productionMethods: EnabledProductionMethod[];
  classification: "configured" | "legacy" | "compatible_fallback";
  variants: CreatorProductBaseVariant[];
};

export type CreatorProductBaseVariant = {
  id: string;
  graphqlId: string;
  variantId: string;
  title: string;
  size: string;
  availableForSale: boolean;
  price: string;
  currencyCode?: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type DesignVariantSelection = {
  variantId: string;
  size: string;
  quantity: number;
};

export type CreatorProductSetup = {
  schema: "creator_design_setup_v1";
  flowMode: "CREATOR_DESIGN";
  productOrigin: "global" | "creator";
  baseProductOrigin?: "global";
  interactionMode?: "CREATOR_DESIGN";
  designMode: "creator_design";
  creatorContext?: true;
  launchContext?: "creator_dashboard";
  isCreatorProduct: true;
  fixedColor: string;
  previewColor?: string;
  selectedColors: string[];
  productionMethod: ProductionMethodCode;
  embroiderySubtype?: EmbroiderySubtype;
  placementCount: number;
  placements: string[];
  previewSurfaces?: Array<{
    side: string;
    url: string;
    hasArtwork: boolean;
    color?: string;
  }>;
  artworkObjectCounts?: { text: number; image: number };
  pricingPreview?: {
    pricingMode: "BAKED_IN_V1";
    productionMethod: ProductionMethodCode;
    embroiderySubtype: EmbroiderySubtype | null;
    placementCount: number;
    surchargeMinor: string;
    productionCostMinor: string;
    currencyCode: string;
    variants: Array<{
      baseVariantId: string;
      size: string;
      basePrice: string;
      finalPrice: string;
    }>;
    calculatedAt: string;
  };
  copyrightAccepted: boolean;
  nonReturnAcknowledged: boolean;
  savedAt: string;
};

export type AdminCreatorProductDecisionInput = {
  creatorProductId: unknown;
  decision: unknown;
  rejectionReason?: unknown;
};

export type PublicCreatorProductVariant = {
  id: string;
  graphqlId: string;
  cartId: string;
  numericId: string;
  title: string;
  availableForSale: boolean;
  price: {
    amount: string;
    currencyCode: string;
  };
  selectedOptions: Array<{ name: string; value: string }>;
};

export type PublicCreatorProductBase = {
  id: string;
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  options: Array<{ name: string; values: string[] }>;
  variants: PublicCreatorProductVariant[];
  priceRange: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
};

export type PublicCreatorProduct = CreatorProductRecord & {
  creator: {
    id: string;
    displayName: string;
    handle: string;
    customerId?: string;
  };
  collection: {
    id: string;
    publicHandle: string;
    displayName: string;
    creatorId: string;
  };
  baseProduct?: PublicCreatorProductBase;
  creatorSetup?: CreatorProductSetup | null;
  productionPricing?: {
    method: ProductionMethodCode | null;
    fixedColor: string;
    placementCount: number;
    methods: Array<{
      method: ProductionMethodCode;
      surchargeMinor: string;
      feeVariantId: string | null;
    }>;
  } | null;
};

export type PrepareCreatorProductCartInput = {
  creatorHandle?: unknown;
  publicHandle?: unknown;
  creatorProductId: unknown;
  selectedVariantId: unknown;
  selectedProductionMethod?: unknown;
  productionMethod?: unknown;
  quantity?: unknown;
  nonReturnAcknowledged?: unknown;
  termsAccepted?: unknown;
};

export type PrepareNativeCreatorProductCartInput = {
  shopifyProductId: unknown;
  selectedVariantId: unknown;
  quantity?: unknown;
  nonReturnAcknowledged?: unknown;
  termsAccepted?: unknown;
};

export type PreparedCreatorProductCart = {
  variant: { graphqlId: string; cartId: string };
  variantId: string;
  cartVariantId: string;
  shopifyVariantId: string;
  quantity: number;
  properties: Record<string, string>;
  production: {
    method: ProductionMethodCode;
    embroiderySubtype: EmbroiderySubtype | null;
    fixedColor: string;
    placementCount: number;
    surchargeMinor: string;
    feeVariantId: string | null;
    feeQuantity: number;
    pricingMode: typeof CREATOR_PRICING_MODE_BAKED_IN_V1 | null;
  };
  items: Array<{
    id: string;
    quantity: number;
    properties: Record<string, string>;
  }>;
  creatorProduct: {
    id: string;
    title: string;
    creatorId: string;
    masterPitchPrintProjectId: string;
  };
  nativeProduct?: {
    shopifyProductId: string;
    selectedVariantId: string;
  };
};

function cleanOptionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function cleanCreatorProductTitle(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "TITLE_REQUIRED",
      "Enter a design title.",
      422,
    );
  }
  const title = value.trim();
  if (!title) {
    throw new DomainError(
      "TITLE_REQUIRED",
      "Enter a design title.",
      422,
    );
  }
  if (title.length < 2) {
    throw new DomainError(
      "TITLE_TOO_SHORT",
      "Design title must be at least 2 characters.",
      422,
    );
  }
  if (title.length > 120) {
    throw new DomainError(
      "TITLE_TOO_LONG",
      "Design title must be 120 characters or less.",
      422,
    );
  }
  return title;
}

function cleanCreatorProductDescription(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new DomainError(
      "DESCRIPTION_INVALID",
      "Description must be plain text.",
      422,
    );
  }
  const description = value.trim();
  if (description.length > 1000) {
    throw new DomainError(
      "DESCRIPTION_TOO_LONG",
      "Description must be 1000 characters or less.",
      422,
    );
  }
  return description || null;
}

function normalizeShopifyProductGid(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "INVALID_PRODUCT",
      "Select a valid Shopify base product.",
      422,
    );
  }
  const trimmed = value.trim();
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(trimmed)) {
    throw new DomainError(
      "INVALID_PRODUCT",
      "Use the Shopify product GID for the base product.",
      422,
    );
  }
  return trimmed;
}

async function approvedCreatorForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb,
) {
  const creator = await database.creator.findUnique({
    where: {
      shop_customerId: {
        shop,
        customerId: normalizeCustomerGid(customerId),
      },
    },
    select: {
      id: true,
      handle: true,
      status: true,
      marketplaceCollection: {
        select: {
          publicHandle: true,
          status: true,
          shopifyCollectionUrl: true,
        },
      },
    },
  });
  if (!creator || creator.status !== "APPROVED") {
    throw new DomainError(
      "NOT_APPROVED",
      "Only approved creators can manage creator products.",
      403,
    );
  }
  return creator;
}

async function validateBaseProduct(
  client: ShopifyGraphqlClient,
  shopifyProductId: string,
) {
  const result = await client.request<{
    shop?: { currencyCode: string };
    product: {
      id: string;
      title: string;
      handle: string;
      origin: { value: string } | null;
      mode: { value: string } | null;
      featuredImage: { url: string } | null;
      pitchprintDesignId: { value: string } | null;
      legacyPitchprintDesignId: { value: string } | null;
      productionMethodPricing: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          title: string;
          availableForSale: boolean;
          price: string;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query CreatorProductBaseProduct($id: ID!) {
      shop { currencyCode }
      product(id: $id) {
        id
        title
        handle
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        productionMethodPricing: metafield(namespace: "customhouse", key: "production_method_pricing") { value }
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
            price
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: shopifyProductId },
  );
  const product = result.product;
  if (!product) {
    throw new DomainError(
      "PRODUCT_NOT_FOUND",
      "Base product not found.",
      404,
    );
  }
  if (product.origin?.value && product.origin.value !== "global") {
    throw new DomainError(
      "NOT_GLOBAL",
      "Creator Products must start from a Global Product.",
      422,
    );
  }
  if (product.mode?.value && product.mode.value !== "customizable") {
    throw new DomainError(
      "NOT_CUSTOMIZABLE",
      "This base product is not customizable.",
      422,
    );
  }
  return {
    ...product,
    currencyCode: result.shop?.currencyCode || "",
  };
}

function configuredProductionMethodCodes(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { productionMethods?: unknown };
    if (!Array.isArray(parsed.productionMethods)) return [];
    return [
      ...new Set(
        parsed.productionMethods
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const method = item as { id?: unknown; method?: unknown };
            return String(method.id ?? method.method ?? "").trim().toUpperCase();
          })
          .filter((method): method is ProductionMethodCode =>
            /^[A-Z][A-Z0-9_]{1,63}$/.test(method),
          ),
      ),
    ];
  } catch {
    return [];
  }
}

export function productionMethodsForCreatorProduct(
  enabledMethods: EnabledProductionMethod[],
  productionMethodPricing: string | null | undefined,
) {
  const configuredMethods = configuredProductionMethodCodes(
    productionMethodPricing,
  );
  if (!configuredMethods.length) return enabledMethods;
  const configured = new Set(configuredMethods);
  return enabledMethods.filter((method) => configured.has(method.id));
}

function cleanProjectId(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "PitchPrint project ID is required.",
      422,
    );
  }
  const projectId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(projectId)) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_INVALID",
      "PitchPrint project ID is invalid.",
      422,
    );
  }
  return projectId;
}

function previewUrlCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(previewUrlCandidates);
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nestedFile =
    record.file && typeof record.file === "object"
      ? (record.file as Record<string, unknown>)
      : null;
  return [
    record.url,
    record.previewUrl,
    record.preview,
    record.src,
    record.href,
    record.downloadUrl,
    record.resourceUrl,
    record.secureUrl,
    record.secure_url,
    record.originalSrc,
    record.thumbnailUrl,
    record.thumbnail,
    record.thumb,
    nestedFile?.url,
  ];
}

function cleanPreviewUrls(input: AttachPitchPrintProjectInput) {
  const values = [
    ...previewUrlCandidates(input.previews),
    ...previewUrlCandidates(input.previewUrl),
    ...previewUrlCandidates(input.sidePreviews),
  ];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => {
          try {
            const url = new URL(item);
            return url.protocol === "https:";
          } catch {
            return false;
          }
        })
        .slice(0, 10),
    ),
  ];
}

function canonicalArtworkSubtype(value: unknown): EmbroiderySubtype | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "IMAGE_LOGO") return "IMAGE_OR_LOGO";
  if (normalized === "TEXT_ONLY" || normalized === "IMAGE_OR_LOGO") {
    return normalized;
  }
  return null;
}

function canonicalPlacementName(value: unknown, index: number) {
  if (typeof value === "string") return cleanOptionalText(value, 80);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.hasArtwork === false) return null;
  return cleanOptionalText(
    record.side || record.name || record.label || record.id,
    80,
  ) || `Saved view ${index + 1}`;
}

function canonicalPitchPrintArtworkFacts(setup: Record<string, unknown>) {
  const subtypeValues = [setup.embroiderySubtype, setup.artworkType]
    .map(canonicalArtworkSubtype)
    .filter((value): value is EmbroiderySubtype => Boolean(value));
  if (new Set(subtypeValues).size > 1) {
    throw new DomainError(
      "PITCHPRINT_ARTWORK_TYPE_CONFLICT",
      "PitchPrint returned conflicting embroidery artwork types. Please save the design again.",
      422,
    );
  }
  const embroiderySubtype = subtypeValues[0];
  if (!embroiderySubtype) {
    throw new DomainError(
      "PITCHPRINT_ARTWORK_TYPE_UNRESOLVED",
      "The saved artwork type could not be determined. Please return to the editor and save the design again.",
      422,
    );
  }
  const rawPlacements = Array.isArray(setup.placements)
    ? setup.placements
    : Array.isArray(setup.designedPlacements)
      ? setup.designedPlacements
      : [];
  const placements = rawPlacements
    .map(canonicalPlacementName)
    .filter((value): value is string => Boolean(value));
  const placementCount = directPositiveInteger(
    setup.placementCount,
    setup.designedPlacementCount,
  );
  if (!placementCount || !placements.length || placementCount !== placements.length) {
    throw new DomainError(
      "CREATOR_PLACEMENT_REQUIRED",
      "At least one designed placement is required, and its placement count must match.",
      422,
    );
  }
  const summary =
    setup.artworkSummary && typeof setup.artworkSummary === "object" && !Array.isArray(setup.artworkSummary)
      ? (setup.artworkSummary as Record<string, unknown>)
      : setup.artworkObjectCounts && typeof setup.artworkObjectCounts === "object" && !Array.isArray(setup.artworkObjectCounts)
        ? (setup.artworkObjectCounts as Record<string, unknown>)
        : null;
  const text = Number(summary?.text || 0);
  const image = Number(summary?.image || 0);
  if (
    !summary ||
    !Number.isSafeInteger(text) ||
    !Number.isSafeInteger(image) ||
    text < 0 ||
    image < 0 ||
    (embroiderySubtype === "TEXT_ONLY" && (text < 1 || image !== 0)) ||
    (embroiderySubtype === "IMAGE_OR_LOGO" && image < 1)
  ) {
    throw new DomainError(
      "PITCHPRINT_ARTWORK_TYPE_UNRESOLVED",
      "The saved artwork summary does not verify its embroidery artwork type. Please save the design again.",
      422,
    );
  }
  return {
    embroiderySubtype,
    placements,
    placementCount,
    objectCounts: { text, image },
    surfaces: placements.map((side) => ({ side, hasArtwork: true })),
  };
}

function canonicalSidePreviews(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const url = cleanOptionalText(
        record.url || record.previewUrl || record.src,
        2_048,
      );
      if (!url) return null;
      try {
        if (new URL(url).protocol !== "https:") return null;
      } catch {
        return null;
      }
      return {
        side: cleanOptionalText(record.side || record.name || record.label, 80) || `Saved view ${index + 1}`,
        url,
        hasArtwork: record.hasArtwork !== false,
      };
    })
    .filter((item): item is { side: string; url: string; hasArtwork: boolean } => Boolean(item))
    .slice(0, 10);
}

function cleanPitchPrintDesignId(value: unknown) {
  if (typeof value !== "string") return null;
  const designId = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(designId)
    ? designId
    : null;
}

function sizeValueFromOptions(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  const size = selectedOptions.find((option) =>
    /^(size|storlek|storrelse|storlek)$/i.test(option.name.trim()),
  );
  return cleanOptionalText(size?.value, 80) || null;
}

function creatorProductBaseVariants(product: {
  variants?: {
    nodes?: Array<{
      id: string;
      legacyResourceId?: string | number | null;
      title?: string | null;
      availableForSale?: boolean | null;
      price?: string | null;
      selectedOptions?: Array<{ name: string; value: string }> | null;
    }>;
  } | null;
}, currencyCode: string) {
  const variants = product.variants?.nodes || [];
  return variants
    .map((variant): CreatorProductBaseVariant | null => {
      if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id)) return null;
      const selectedOptions = Array.isArray(variant.selectedOptions)
        ? variant.selectedOptions
            .map((option) => ({
              name: cleanOptionalText(option.name, 80) || "",
              value: cleanOptionalText(option.value, 120) || "",
            }))
            .filter((option) => option.name && option.value)
        : [];
      const variantId = cleanOptionalText(variant.legacyResourceId, 80) ||
        numericVariantId(variant.id);
      const title = cleanOptionalText(variant.title, 160) ||
        selectedOptions.map((option) => option.value).join(" / ") ||
        variantId;
      const price = cleanOptionalText(variant.price, 40);
      if (!price) return null;
      return {
        id: variant.id,
        graphqlId: variant.id,
        variantId,
        title,
        size: sizeValueFromOptions(selectedOptions) || title,
        availableForSale: variant.availableForSale !== false,
        price,
        currencyCode,
        selectedOptions,
      };
    })
    .filter((variant): variant is CreatorProductBaseVariant =>
      Boolean(variant && variant.availableForSale),
    );
}

function productBaseVariants(product: CreatorProductRecord) {
  try {
    const parsed = JSON.parse(product.baseProductVariantsJson || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((variant): variant is CreatorProductBaseVariant => {
          const record = variant as Record<string, unknown>;
          return Boolean(
            record &&
            typeof record === "object" &&
            typeof record.variantId === "string" &&
            typeof record.size === "string",
          );
        })
      : [];
  } catch {
    return [];
  }
}

function normalizedOptionText(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function colorValueFromOptions(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  const color = selectedOptions.find((option) =>
    /^(color|colour|farg|färg)$/i.test(option.name.trim()),
  );
  return cleanOptionalText(color?.value, 80) || null;
}

function baseProductColorValues(variants: CreatorProductBaseVariant[]) {
  return [
    ...new Set(
      variants
        .map((variant) => colorValueFromOptions(variant.selectedOptions || []))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function rawCreatorSetup(input: AttachPitchPrintProjectInput) {
  const nested =
    input.creatorSetup && typeof input.creatorSetup === "object"
      ? (input.creatorSetup as Record<string, unknown>)
      : {};
  const outer = { ...input } as Record<string, unknown>;
  delete outer.creatorSetup;
  const setup = {
    ...nested,
    ...outer,
  } as Record<string, unknown>;
  const outerColor = resolveCanonicalCreatorFixedColor({ creatorSetup: outer });
  const colorSource = outerColor.count ? outer : nested;
  for (const key of [
    "activeColor",
    "selectedColor",
    "selectedColorDetail",
    "productColor",
    "selectedProductColor",
    "colorName",
    "color",
    "variantColor",
    "selectedColors",
    "colorValues",
    "productColors",
    "fixedColor",
  ]) {
    delete setup[key];
    if (key in colorSource) setup[key] = colorSource[key];
  }
  return setup;
}

function creatorColorArray(value: unknown) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function creatorColorValue(value: unknown): string | null {
  if (typeof value === "string") return cleanOptionalText(value, 120);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return creatorColorValue(
    record.value ||
      record.optionValue ||
      record.colorName ||
      record.name ||
      record.label ||
      record.color,
  );
}

function uniqueCreatorColorValues(values: unknown[]) {
  const colors: string[] = [];
  const normalized = new Set<string>();
  for (const value of values) {
    const color = creatorColorValue(value);
    if (!color) continue;
    const key = normalizedOptionText(color);
    if (normalized.has(key)) continue;
    normalized.add(key);
    colors.push(color);
  }
  return colors;
}

function normalizedCreatorColorValues(setup: Record<string, unknown>) {
  const currentColor = uniqueCreatorColorValues([
    setup.activeColor,
    setup.selectedColor,
    setup.selectedColorDetail,
    setup.productColor,
    setup.selectedProductColor,
    setup.colorName,
    setup.color,
    setup.variantColor,
  ])[0];
  const arrayColors = uniqueCreatorColorValues([
    ...creatorColorArray(setup.selectedColors),
  ]);
  if (currentColor) {
    return uniqueCreatorColorValues([currentColor, ...arrayColors]);
  }
  if (arrayColors.length) return arrayColors;
  return uniqueCreatorColorValues([setup.fixedColor]);
}

export function resolveCanonicalCreatorFixedColor(input: {
  creatorSetup: Record<string, unknown>;
  availableBaseColors?: string[];
}) {
  const logicalColors = normalizedCreatorColorValues(input.creatorSetup);
  if (logicalColors.length !== 1) {
    return { color: null, count: logicalColors.length };
  }
  const requestedColor = logicalColors[0]!;
  if (!input.availableBaseColors?.length) {
    return { color: requestedColor, count: 1 };
  }
  const canonicalBaseColor = input.availableBaseColors.find(
    (color) => normalizedOptionText(color) === normalizedOptionText(requestedColor),
  );
  return { color: canonicalBaseColor || null, count: 1 };
}

export function creatorProductColorInputDiagnostics(
  input: AttachPitchPrintProjectInput,
) {
  const nested =
    input.creatorSetup &&
    typeof input.creatorSetup === "object" &&
    !Array.isArray(input.creatorSetup)
      ? (input.creatorSetup as Record<string, unknown>)
      : {};
  const outer = { ...input } as Record<string, unknown>;
  delete outer.creatorSetup;
  return {
    outerColorCount: resolveCanonicalCreatorFixedColor({ creatorSetup: outer }).count,
    nestedColorCount: resolveCanonicalCreatorFixedColor({ creatorSetup: nested }).count,
    hasProjectId: Boolean(
      cleanOptionalText(
        input.projectId || input.creatorProjectId || nested.projectId || nested.creatorProjectId,
        200,
      ),
    ),
    hasPreview: Boolean(
      cleanOptionalText(input.previewUrl, 2_000) ||
        (Array.isArray(input.previews) && input.previews.length) ||
        (Array.isArray(input.sidePreviews) && input.sidePreviews.length),
    ),
  };
}

function booleanTrue(...values: unknown[]) {
  return values.some(
    (value) =>
      value === true ||
      value === "true" ||
      value === "1" ||
      value === 1,
  );
}

function directPositiveInteger(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0 && number <= 20) {
      return number;
    }
  }
  return 0;
}

function hasCustomerOrderQuantity(setup: Record<string, unknown>) {
  if (
    directPositiveInteger(
      setup.quantity,
      setup.qty,
      setup.orderQuantity,
      setup.customerQuantity,
      setup.customerOrderQuantity,
    )
  ) {
    return true;
  }
  const selectionGroups = [
    setup.variantSelections,
    setup.selectedVariants,
    setup.sizeSelections,
    setup.sizeQuantities,
    setup.quantities,
  ];
  return selectionGroups.some((group) => {
    if (!Array.isArray(group)) return false;
    return group.some((item) => {
      if (!item || typeof item !== "object") return Boolean(item);
      const record = item as Record<string, unknown>;
      return Boolean(
        directPositiveInteger(
          record.quantity,
          record.qty,
          record.amount,
          record.orderQuantity,
        ),
      );
    });
  });
}

export function creatorProductSetupFromRecord(product: CreatorProductRecord) {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(product.designVariantSelectionsJson || "[]");
  } catch {
    parsed = [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const setup = parsed as Partial<CreatorProductSetup>;
  const fixedColor = resolveCanonicalCreatorFixedColor({
    creatorSetup: setup as Record<string, unknown>,
  });
  if (
    setup.schema !== "creator_design_setup_v1" ||
    setup.flowMode !== "CREATOR_DESIGN" ||
    setup.designMode !== "creator_design" ||
    setup.isCreatorProduct !== true ||
    fixedColor.count !== 1 ||
    !fixedColor.color ||
    !setup.productionMethod ||
    !setup.placementCount ||
    !setup.copyrightAccepted
  ) {
    return null;
  }
  return {
    ...setup,
    fixedColor: fixedColor.color,
    selectedColors: [fixedColor.color],
  } as CreatorProductSetup;
}

async function cleanCreatorProductSetup(
  shop: string,
  shopifyProductId: string,
  input: AttachPitchPrintProjectInput,
  variants: CreatorProductBaseVariant[],
  database: CreatorProductDb,
): Promise<CreatorProductSetup> {
  const setup = rawCreatorSetup(input);
  const colors = baseProductColorValues(variants);
  if (!colors.length) {
    throw new DomainError(
      "CREATOR_COLOR_UNAVAILABLE",
      "This base product does not expose a color option.",
      422,
    );
  }
  const fixedColorResolution = resolveCanonicalCreatorFixedColor({
    creatorSetup: setup,
    availableBaseColors: colors,
  });
  if (fixedColorResolution.count !== 1) {
    throw new DomainError(
      "CREATOR_COLOR_REQUIRED",
      "Choose exactly one product color for this Creator Product.",
      422,
    );
  }
  const fixedColor = fixedColorResolution.color;
  if (!fixedColor) {
    throw new DomainError(
      "CREATOR_COLOR_INVALID",
      "Choose a color that exists on the base product.",
      422,
    );
  }
  const previewColor = cleanOptionalText(
    setup.previewColor || setup.renderedPreviewColor,
    120,
  );
  if (
    previewColor &&
    normalizedOptionText(previewColor) !== normalizedOptionText(fixedColor)
  ) {
    throw new DomainError(
      "CREATOR_COLOR_PREVIEW_MISMATCH",
      "The rendered preview color does not match the selected Creator color. Reselect the garment color and save again.",
      422,
    );
  }
  const rawProductionMethod =
    setup.fixedProductionMethod ||
    setup.productionMethod ||
    setup.selectedProductionMethod;
  if (typeof rawProductionMethod !== "string" || !rawProductionMethod.trim()) {
    throw new DomainError(
      "PRODUCTION_METHOD_REQUIRED",
      "Choose exactly one printing method for this Creator Product.",
      422,
    );
  }
  const productionMethod = cleanProductionMethod(rawProductionMethod);
  const enabledMethods = database.publicProductProductionPricing
    ? (await getEnabledProductionMethodsForProduct(
        shop,
        shopifyProductId,
        database as unknown as Parameters<typeof getEnabledProductionMethodsForProduct>[2],
      )).map((method) => method.id)
    : [...PRODUCTION_METHODS];
  if (!enabledMethods.includes(productionMethod)) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose an enabled printing method.",
      422,
    );
  }
  const artworkFacts = input.source === undefined || input.source === null
    ? canonicalPitchPrintArtworkFacts(setup)
    : classifyPitchPrintProjectSource(input.source);
  const embroiderySubtype =
    productionMethod === "EMBROIDERY"
      ? artworkFacts.embroiderySubtype
      : undefined;
  const placements = artworkFacts.placements;
  const placementCount = artworkFacts.placementCount;
  const previewUrls = cleanPreviewUrls(input);
  const meta =
    input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
      ? (input.meta as Record<string, unknown>)
      : {};
  const metaPageNames = Array.isArray(meta.pageNames) ? meta.pageNames : [];
  const suppliedSidePreviews = canonicalSidePreviews(
    input.sidePreviews || setup.sidePreviews,
  );
  const previewSurfaces = previewUrls.map((url, index) => {
    const suppliedSurface = suppliedSidePreviews.find((surface) => surface.url === url);
    const sourceSurface = artworkFacts.surfaces[index];
    const metaSide = cleanOptionalText(metaPageNames[index], 80);
    return {
      side: suppliedSurface?.side || sourceSurface?.side || metaSide || `Saved view ${index + 1}`,
      url,
      hasArtwork: suppliedSurface?.hasArtwork ?? sourceSurface?.hasArtwork === true,
      ...(previewColor ? { color: previewColor } : {}),
    };
  });
  if (
    !booleanTrue(
      setup.copyrightAccepted,
      setup.copyrightConfirmed,
      setup.rightsConfirmed,
      setup.creatorCopyrightAccepted,
    )
  ) {
    throw new DomainError(
      "COPYRIGHT_CONFIRMATION_REQUIRED",
      "Confirm that you have the rights to use this design before submitting.",
      422,
    );
  }
  if (hasCustomerOrderQuantity(setup)) {
    throw new DomainError(
      "CREATOR_ORDER_QUANTITY_NOT_ALLOWED",
      "Choose product size and quantity only when a customer buys the published Creator Product.",
      422,
    );
  }
  let pricingPreview: CreatorProductSetup["pricingPreview"];
  if (database.publicProductProductionPricing) {
    const pricing = await getProductionPricing(
      shop,
      shopifyProductId,
      database as unknown as Parameters<typeof getProductionPricing>[2],
    );
    if (!pricing) {
      throw new DomainError(
        "PRODUCTION_PRICING_REQUIRED",
        "Production pricing is not configured for Creator Products.",
        409,
      );
    }
    const fixedColorVariants = variants.filter((variant) =>
      normalizedOptionText(colorValueFromOptions(variant.selectedOptions || [])) ===
        normalizedOptionText(fixedColor),
    );
    const resolvedPricing = await resolveProductionPricing({
      shop,
      productId: shopifyProductId,
      method: productionMethod,
      artworkType: embroiderySubtype,
      database: database as unknown as Parameters<typeof resolveProductionPricing>[0]["database"],
    });
    const preview = creatorProductionPricingPreview({
      productionMethod,
      embroiderySubtype,
      placementCount,
      pricing,
      resolvedSurcharge: resolvedPricing.surcharge,
      baseVariants: fixedColorVariants.map((variant) => ({
        id: variant.graphqlId,
        price: variant.price,
        selectedOptions: variant.selectedOptions,
      })),
    });
    pricingPreview = {
      pricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
      productionMethod: preview.productionMethod,
      embroiderySubtype: preview.embroiderySubtype,
      placementCount: preview.placementCount,
      surchargeMinor: preview.surchargeMinor,
      productionCostMinor: preview.productionCostMinor,
      currencyCode:
        fixedColorVariants.find((variant) => variant.currencyCode)?.currencyCode || "",
      variants: preview.variants.map((variant) => ({
        baseVariantId: variant.baseVariantId,
        size:
          fixedColorVariants.find(
            (candidate) => candidate.graphqlId === variant.baseVariantId,
          )?.size || "",
        basePrice: variant.basePrice,
        finalPrice: variant.finalPrice,
      })),
      calculatedAt: new Date().toISOString(),
    };
  }
  return {
    schema: "creator_design_setup_v1",
    flowMode: "CREATOR_DESIGN",
    interactionMode: "CREATOR_DESIGN",
    productOrigin: "global",
    baseProductOrigin: "global",
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    fixedColor,
    ...(previewColor ? { previewColor } : {}),
    selectedColors: [fixedColor],
    productionMethod,
    ...(embroiderySubtype ? { embroiderySubtype } : {}),
    placementCount,
    placements,
    previewSurfaces,
    artworkObjectCounts: artworkFacts.objectCounts,
    ...(pricingPreview ? { pricingPreview } : {}),
    copyrightAccepted: true,
    nonReturnAcknowledged: booleanTrue(setup.nonReturnAcknowledged),
    savedAt: new Date().toISOString(),
  };
}

function requireCreatorProductSetup(product: CreatorProductRecord) {
  const setup = creatorProductSetupFromRecord(product);
  if (!setup) {
    throw new DomainError(
      "CREATOR_SETUP_REQUIRED",
      "Choose one color and confirm copyright before submitting.",
      422,
    );
  }
  return setup;
}

function previewUrlsForProduct(product: CreatorProductRecord) {
  try {
    const parsed = JSON.parse(product.previewUrls || "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.startsWith("https://"),
        )
      : [];
  } catch {
    return [];
  }
}

function creatorCartPreviewUrl(product: CreatorProductRecord) {
  if (product.previewUrl?.startsWith("https://")) return product.previewUrl;
  return previewUrlsForProduct(product)[0] || null;
}

function creatorPricingSurchargeMinor(product: CreatorProductRecord) {
  try {
    const parsed = JSON.parse(product.creatorPricingPreviewJson || "{}");
    return typeof parsed?.surchargeMinor === "string" && /^\d+$/.test(parsed.surchargeMinor)
      ? parsed.surchargeMinor
      : "0";
  } catch {
    return "0";
  }
}

function validateCompletableCreatorProduct(product: CreatorProductRecord) {
  if (!cleanOptionalText(product.title, 140)) {
    throw new DomainError(
      "CREATOR_PRODUCT_TITLE_REQUIRED",
      "Add a title before submitting.",
      422,
    );
  }
  if (!cleanPitchPrintDesignId(product.pitchprintDesignId)) {
    throw new DomainError(
      "PITCHPRINT_DESIGN_REQUIRED",
      "This Creator Product is missing a PitchPrint design ID.",
      422,
    );
  }
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "Save your PitchPrint design before submitting.",
      422,
    );
  }
  const previews = previewUrlsForProduct(product);
  if (!product.previewUrl?.startsWith("https://") && previews.length === 0) {
    throw new DomainError(
      "CREATOR_PRODUCT_PREVIEW_REQUIRED",
      "Product preview is missing.",
      422,
    );
  }
  requireCreatorProductSetup(product);
}

function cleanRejectionReason(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function cleanCreatorProductId(value: unknown) {
  if (typeof value !== "string") {
    throw new DomainError(
      "CREATOR_PRODUCT_INVALID",
      "Choose a valid creator product.",
      422,
    );
  }
  const id = value.trim();
  if (!/^[a-z0-9]{20,40}$/i.test(id)) {
    throw new DomainError(
      "CREATOR_PRODUCT_INVALID",
      "Choose a valid creator product.",
      422,
    );
  }
  return id;
}

function cleanQuantity(value: unknown) {
  const quantity = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
    throw new DomainError(
      "QUANTITY_INVALID",
      "Choose a valid quantity.",
      422,
    );
  }
  return quantity;
}

function cleanProductGidOrNumeric(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(raw)) return raw;
  throw new DomainError(
    "INVALID_PRODUCT",
    "Select a valid Shopify product.",
    422,
  );
}

function cleanVariantGidOrNumeric(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) return raw;
  throw new DomainError(
    "VARIANT_INVALID",
    "Choose a valid product option.",
    422,
  );
}

function cleanVariantSelection(value: unknown) {
  const raw = typeof value === "number" ? String(value) : String(value || "").trim();
  if (/^\d+$/.test(raw) || /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) {
    return raw;
  }
  throw new DomainError(
    "VARIANT_INVALID",
    "Choose a valid product option.",
    422,
  );
}

function numericVariantId(variantGid: string) {
  return variantGid.split("/").pop() || "";
}
async function preparePitchPrintOrderProject(
  masterProjectId: string,
  cloner: PitchPrintProjectCloner,
) {
  try {
    return await cloner(masterProjectId);
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["PITCHPRINT_NOT_CONFIGURED", "PITCHPRINT_CLONE_FAILED"].includes(
        error.code,
      )
    ) {
      console.warn("pitchprint_clone_fallback_using_master_project", {
        projectPresent: Boolean(masterProjectId),
        reason: error.code,
      });
      return masterProjectId;
    }
    throw error;
  }
}

async function verifyNativeVariant(
  client: ShopifyGraphqlClient,
  productId: string,
  variantId: string,
) {
  const result = await client.request<{
    productVariant: {
      id: string;
      availableForSale: boolean;
      product: { id: string } | null;
    } | null;
  }>(
    `#graphql query NativeCreatorCartVariant($id: ID!) {
      productVariant(id: $id) {
        id
        availableForSale
        selectedOptions { name value }
        product { id }
      }
    }`,
    { id: variantId },
  );
  const variant = result.productVariant;
  if (!variant || variant.product?.id !== productId || !variant.availableForSale) {
    throw new DomainError(
      "VARIANT_NOT_AVAILABLE",
      "Choose an available option for this product.",
      409,
    );
  }
  return variant;
}

function baseVariantForPublishedVariant(
  product: CreatorProductRecord,
  publishedVariantId: string,
) {
  try {
    const parsed = JSON.parse(product.baseVariantMappingJson || "{}");
    return parsed && typeof parsed === "object"
      ? String(parsed[publishedVariantId] || "")
      : "";
  } catch {
    return "";
  }
}

function safeCanonicalVariantIdentity(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  try {
    return canonicalVariantIdentity(selectedOptions);
  } catch {
    return "";
  }
}

function nonColorSelectedOptions(
  selectedOptions: Array<{ name: string; value: string }>,
) {
  return selectedOptions.filter((option) =>
    !/^(color|colour|farg|färg)$/i.test(String(option.name || "").trim()),
  );
}

function uniqueGraphqlVariantId(variants: CreatorProductBaseVariant[]) {
  const ids = [
    ...new Set(
      variants
        .map((variant) => variant.graphqlId || variant.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  return ids.length === 1 ? ids[0] : "";
}

function inferredBaseVariantForPublishedVariant(
  product: CreatorProductRecord,
  publishedVariant: {
    id?: string | null;
    graphqlId?: string | null;
    selectedOptions?: Array<{ name: string; value: string }> | null;
  },
) {
  const publishedVariantId = publishedVariant.graphqlId || publishedVariant.id || "";
  const mapped = baseVariantForPublishedVariant(product, publishedVariantId);
  if (mapped) return mapped;
  const selectedOptions = Array.isArray(publishedVariant.selectedOptions)
    ? publishedVariant.selectedOptions
    : [];
  if (!selectedOptions.length) return "";
  const setup = creatorProductSetupFromRecord(product);
  const fixedColor = setup?.fixedColor || "";
  const baseVariants = productBaseVariants(product).filter((variant) => {
    const color = colorValueFromOptions(variant.selectedOptions || []);
    return !fixedColor || !color ||
      normalizedOptionText(color) === normalizedOptionText(fixedColor);
  });
  if (!baseVariants.length) return "";
  const exactIdentity = safeCanonicalVariantIdentity(selectedOptions);
  if (exactIdentity) {
    const exactMatches = baseVariants.filter(
      (variant) =>
        safeCanonicalVariantIdentity(variant.selectedOptions || []) === exactIdentity,
    );
    const exactId = uniqueGraphqlVariantId(exactMatches);
    if (exactId) return exactId;
  }
  const sizeOnlyOptions = nonColorSelectedOptions(selectedOptions);
  const sizeOnlyIdentity = safeCanonicalVariantIdentity(sizeOnlyOptions);
  if (!sizeOnlyIdentity || sizeOnlyIdentity === exactIdentity) return "";
  return uniqueGraphqlVariantId(
    baseVariants.filter(
      (variant) =>
        safeCanonicalVariantIdentity(
          nonColorSelectedOptions(variant.selectedOptions || []),
        ) === sizeOnlyIdentity,
    ),
  );
}

function publishedVariantForBaseVariant(
  product: CreatorProductRecord,
  baseVariantId: string,
) {
  try {
    const parsed = JSON.parse(product.baseVariantMappingJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const matches = Object.entries(parsed).filter(
      ([publishedVariantId, mappedBaseVariantId]) =>
        Boolean(publishedVariantId) && String(mappedBaseVariantId || "") === baseVariantId,
    );
    return matches.length === 1 ? matches[0][0] : "";
  } catch {
    return "";
  }
}

async function publicBaseProduct(
  productId: string,
  client: ShopifyGraphqlClient,
): Promise<PublicCreatorProductBase> {
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      onlineStoreUrl: string | null;
      options: Array<{ name: string; values: string[] }>;
      priceRangeV2: {
        minVariantPrice: { amount: string; currencyCode: string };
        maxVariantPrice: { amount: string; currencyCode: string };
      };
      variants: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          title: string;
          availableForSale: boolean;
          price: string;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query PublicCreatorProductBase($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        onlineStoreUrl
        options { name values }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
            price
            selectedOptions { name value }
          }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  if (!product) {
    throw new DomainError(
      "BASE_PRODUCT_NOT_FOUND",
      "This product is not available.",
      404,
    );
  }
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    onlineStoreUrl: product.onlineStoreUrl,
    options: product.options,
    priceRange: product.priceRangeV2,
    variants: product.variants.nodes.map((variant) => ({
      id: variant.id,
      graphqlId: variant.id,
      cartId: variant.legacyResourceId,
      numericId: variant.legacyResourceId,
      title: variant.title,
      availableForSale: variant.availableForSale,
      price: {
        amount: variant.price,
        currencyCode: product.priceRangeV2.minVariantPrice.currencyCode,
      },
      selectedOptions: variant.selectedOptions,
    })),
  };
}

function eligibleClassification(product: {
  title: string;
  handle: string;
  status: string;
  tags: string[];
  productType: { value: string } | null;
  inkybayEnabled: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  creatorPublishingEnabled: { value: string } | null;
  legacyOrigin: { value: string } | null;
  legacyMode: { value: string } | null;
}) {
  if (product.status !== "ACTIVE") return null;
  if (isProductionFeeProduct(product)) return null;
  const legacyGlobal = Boolean(
    product.legacyOrigin?.value === "global" &&
      product.legacyMode?.value === "customizable",
  );
  const contract = inkyBayProductContract({
    productType: legacyGlobal
      ? "global_customizable"
      : product.productType?.value || null,
    inkyBayEnabled: legacyGlobal || product.inkybayEnabled?.value === "true",
    pitchPrintEnabled:
      legacyGlobal || product.pitchprintEnabled?.value === "true",
    creatorPublishingEnabled:
      product.creatorPublishingEnabled?.value === "true",
    tags: product.tags,
  });
  if (contract.isCreatorFixed) return null;
  if (contract.isGlobalCustomizable) {
    return legacyGlobal ? "legacy" : "configured";
  }
  if (product.legacyOrigin?.value && product.legacyOrigin.value !== "global") {
    return null;
  }
  if (product.legacyMode?.value && product.legacyMode.value !== "customizable") {
    return null;
  }
  return "compatible_fallback";
}

function isProductionFeeProduct(product: {
  title: string;
  handle: string;
  tags: string[];
  productType: { value: string } | null;
}) {
  const tags = new Set(product.tags.map((tag) => tag.trim().toLowerCase()));
  const type = String(product.productType?.value || "").trim().toLowerCase();
  const title = product.title.trim().toLowerCase();
  const handle = product.handle.trim().toLowerCase();
  const feeProductTitlePrefix = FEE_PRODUCT_TITLE_PREFIX.toLowerCase();
  const feeProductHandlePrefix = feeProductTitlePrefix.replace(/[^a-z0-9]+/g, "-");
  return (
    type === FEE_PRODUCT_TYPE ||
    tags.has(FEE_PRODUCT_TAG) ||
    title.startsWith(feeProductTitlePrefix) ||
    handle.startsWith(feeProductHandlePrefix)
  );
}

export async function createCreatorProductDraft(
  shop: string,
  customerId: string,
  input: CreateCreatorProductInput,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const shopifyProductId = normalizeShopifyProductGid(input.shopifyProductId);
  const product = await validateBaseProduct(client, shopifyProductId);
  const pitchprintDesignId =
    cleanPitchPrintDesignId(input.pitchprintDesignId) ||
    cleanPitchPrintDesignId(product.pitchprintDesignId?.value) ||
    cleanPitchPrintDesignId(product.legacyPitchprintDesignId?.value);
  if (!pitchprintDesignId) {
    throw new DomainError(
      "PITCHPRINT_DESIGN_REQUIRED",
      "This base product is missing a PitchPrint design ID.",
      422,
    );
  }
  const previewUrl = product.featuredImage?.url || null;
  const title =
    cleanOptionalText(input.title, 140) || cleanOptionalText(product.title, 140);
  if (!title) {
    throw new DomainError(
      "INVALID_TITLE",
      "Creator Product title is required.",
      422,
    );
  }
  const baseProductVariants = creatorProductBaseVariants(
    product,
    product.currencyCode,
  );
  const productionMethod = cleanProductionMethod(
    input.fixedProductionMethod ?? input.selectedProductionMethod,
  );
  if (!database.publicProductProductionPricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Product-specific production pricing is required for new Creator Products.",
      409,
    );
  }
  const availableMethods = await getEnabledProductionMethodsForProduct(
    shop,
    product.id,
    database as unknown as Parameters<typeof getEnabledProductionMethodsForProduct>[2],
  );
  if (!availableMethods.some((method) => method.id === productionMethod)) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose an available printing method.",
      422,
    );
  }
  const initialSetup = {
    schema: "creator_design_setup_v1",
    flowMode: "CREATOR_DESIGN",
    interactionMode: "CREATOR_DESIGN",
    productOrigin: "global",
    baseProductOrigin: "global",
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    fixedColor: "",
    selectedColors: [],
    productionMethod,
    fixedProductionMethod: productionMethod,
    placementCount: 0,
    placements: [],
    copyrightAccepted: false,
    nonReturnAcknowledged: false,
    savedAt: new Date().toISOString(),
  };

  const creatorProduct = await database.creatorProduct.create({
    data: {
      shop,
      creatorId: creator.id,
      shopifyProductId: product.id,
      shopifyProductHandle: product.handle,
      baseProductTitle: product.title,
      title,
      description: cleanOptionalText(input.description, 1000),
      pitchprintDesignId,
      previewUrl,
      previewUrls: safeJson(previewUrl ? [previewUrl] : []),
      baseProductVariantsJson: safeJson(baseProductVariants),
      designVariantSelectionsJson: safeJson(initialSetup),
      status: "DRAFT",
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.created",
      entityType: "CreatorProduct",
      entityId: creatorProduct.id,
      afterJson: safeJson({
        creatorId: creator.id,
        shopifyProductId: product.id,
        status: "DRAFT",
        productionMethod,
      }),
    },
  });
  return creatorProduct;
}

export async function listEligibleCreatorBaseProducts(
  shop: string,
  customerId: string,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  await approvedCreatorForCustomer(shop, customerId, database);
  if (!database.publicProductProductionPricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Product-specific production pricing is required for new Creator Products.",
      409,
    );
  }
  const result = await client.request<{
    shop?: { currencyCode: string };
    products: {
      nodes: Array<{
        id: string;
        title: string;
        handle: string;
        status: string;
        tags: string[];
        featuredImage: { url: string } | null;
        productType: { value: string } | null;
        inkybayEnabled: { value: string } | null;
        pitchprintEnabled: { value: string } | null;
        creatorPublishingEnabled: { value: string } | null;
        legacyOrigin: { value: string } | null;
        legacyMode: { value: string } | null;
        pitchprintDesignId: { value: string } | null;
        legacyPitchprintDesignId: { value: string } | null;
        productionMethodPricing: { value: string } | null;
        variants: {
          nodes: Array<{
            id: string;
            legacyResourceId: string;
            title: string;
            availableForSale: boolean;
            price: string;
            selectedOptions: Array<{ name: string; value: string }>;
          }>;
        };
      }>;
    };
  }>(
    `#graphql query CreatorBaseProducts {
      shop { currencyCode }
      products(first: 50, query: "status:active") {
        nodes {
          id title handle status tags
          featuredImage { url }
          productType: metafield(namespace: "customhouse", key: "product_type") { value }
          inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
          pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
          creatorPublishingEnabled: metafield(namespace: "customhouse", key: "creator_publishing_enabled") { value }
          legacyOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
          legacyMode: metafield(namespace: "customhouse", key: "design_mode") { value }
          pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
          legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
          productionMethodPricing: metafield(namespace: "customhouse", key: "production_method_pricing") { value }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              title
              availableForSale
              price
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
  );
  const products = await Promise.all(result.products.nodes
    .map(async (product) => {
      const classification = eligibleClassification(product);
      if (!classification) return null;
      const canonicalPricing = await getProductionPricingBridgeForProduct(
        shop,
        product.id,
        database as unknown as Parameters<typeof getProductionPricingBridgeForProduct>[2],
      );
      const productionMethods = canonicalPricing
        ? canonicalPricing.productionMethods.map(({ id, label, maxWidthCm, maxHeightCm }) => ({
            id,
            label,
            ...(maxWidthCm ? { maxWidthCm } : {}),
            ...(maxHeightCm ? { maxHeightCm } : {}),
          }))
        : [];
      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        imageUrl: product.featuredImage?.url || null,
        pitchprintDesignId:
          product.pitchprintDesignId?.value ||
          product.legacyPitchprintDesignId?.value ||
          null,
        productionMethodPricing: canonicalPricing
          ? safeJson(canonicalPricing)
          : null,
        productionMethods,
        classification,
        variants: creatorProductBaseVariants(product, result.shop?.currencyCode || ""),
      } satisfies EligibleCreatorBaseProduct;
    }));
  return products.filter((product): product is EligibleCreatorBaseProduct =>
      Boolean(product),
    );
}

export async function creatorPitchPrintIdentityForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  return {
    userId: creatorPitchPrintUserId(shop, creator.id),
  };
}

function creatorPitchPrintUserId(shop: string, creatorId: string) {
  return `customhouse:${shop}:creator:${creatorId}`;
}

export function assertPitchPrintProjectOwner(
  shop: string,
  creatorId: string,
  source: Record<string, unknown>,
) {
  const expectedAuthor = creatorPitchPrintUserId(shop, creatorId);
  const metadataAuthor = cleanOptionalText(source._author, 300);
  const serializedAuthor = cleanOptionalText(source.author, 300);
  const sourceAuthor = metadataAuthor || serializedAuthor;
  if (
    (metadataAuthor && serializedAuthor && metadataAuthor !== serializedAuthor) ||
    sourceAuthor !== expectedAuthor
  ) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_OWNER_MISMATCH",
      "This saved design does not belong to the authenticated creator.",
      403,
    );
  }
}

export async function savePitchPrintDraftSessionForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  input: SavePitchPrintDraftSessionInput,
  database: CreatorProductDb = db,
  fetchProject: PitchPrintProjectFetcher = fetchPitchPrintProjectSource,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!["DRAFT", "REJECTED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_EDITABLE",
      "Only draft or rejected Creator Products can save a design session.",
      409,
    );
  }

  const projectId = cleanProjectId(input.projectId);
  if (projectId === existing.pitchprintProjectId) {
    return existing;
  }
  const source = await fetchProject(projectId);
  assertPitchPrintProjectOwner(shop, creator.id, source);

  const sourceDesignId = cleanPitchPrintDesignId(source.designId);
  const requestedDesignId = cleanPitchPrintDesignId(input.designId);
  if (
    !sourceDesignId ||
    (existing.pitchprintDesignId && sourceDesignId !== existing.pitchprintDesignId) ||
    (requestedDesignId && requestedDesignId !== sourceDesignId)
  ) {
    throw new DomainError(
      "PITCHPRINT_DESIGN_MISMATCH",
      "The saved design does not match this Creator Product.",
      409,
    );
  }

  const attachedProduct = await database.creatorProduct.findFirst({
    where: { shop, pitchprintProjectId: projectId },
  });
  if (attachedProduct && attachedProduct.id !== existing.id) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_ALREADY_ATTACHED",
      "This saved design is already attached to another Creator Product.",
      409,
    );
  }

  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      pitchprintProjectId: projectId,
      pitchprintDesignId: sourceDesignId,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.pitchprint_draft_session_saved",
      entityType: "CreatorProduct",
      entityId: existing.id,
      afterJson: safeJson({
        creatorId: creator.id,
        projectId,
        designId: sourceDesignId,
        status: existing.status,
      }),
    },
  });
  return updated;
}

export async function attachPitchPrintProjectToCreatorProduct(
  shop: string,
  customerId: string,
  creatorProductId: string,
  input: AttachPitchPrintProjectInput,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!["DRAFT", "REJECTED", "PUBLISHED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_EDITABLE",
      "Only draft, rejected, or published Creator Products can be updated from PitchPrint.",
      409,
    );
  }
  let lockedSetup: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing.designVariantSelectionsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      lockedSetup = parsed as Record<string, unknown>;
    }
  } catch {
    lockedSetup = {};
  }
  const nestedRequestedSetup =
    input.creatorSetup && typeof input.creatorSetup === "object" && !Array.isArray(input.creatorSetup)
      ? (input.creatorSetup as Record<string, unknown>)
      : {};
  const requestedSetup = rawCreatorSetup(input);
  const requestedCreatorProductIds = [
    cleanOptionalText(input.creatorProductId, 200),
    cleanOptionalText(nestedRequestedSetup.creatorProductId, 200),
  ].filter((value): value is string => Boolean(value));
  if (requestedCreatorProductIds.some((value) => value !== existing.id)) {
    throw new DomainError(
      "CREATOR_PRODUCT_CONTEXT_MISMATCH",
      "PitchPrint returned a design for a different Creator Product.",
      422,
    );
  }
  const projectIds = [
    input.projectId,
    input.creatorProjectId,
    nestedRequestedSetup.projectId,
    nestedRequestedSetup.creatorProjectId,
  ]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map(cleanProjectId);
  if (!projectIds.length) cleanProjectId(undefined);
  if (new Set(projectIds).size > 1) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_CONFLICT",
      "PitchPrint returned conflicting saved project IDs. Please save the design again.",
      422,
    );
  }
  const projectId = projectIds[0]!;
  const previewUrls = cleanPreviewUrls({
    ...input,
    sidePreviews: input.sidePreviews || requestedSetup.sidePreviews,
  });
  const previewUrl = previewUrls[0] || null;
  const effectiveColors = normalizedCreatorColorValues(requestedSetup);
  const effectiveColor = effectiveColors.length === 1 ? effectiveColors[0] : null;
  const lockedMethodValue =
    lockedSetup.productionMethod ||
    lockedSetup.fixedProductionMethod ||
    lockedSetup.selectedProductionMethod;
  const lockedMethod =
    typeof lockedMethodValue === "string" ? lockedMethodValue.trim() : "";
  if (!lockedMethod) {
    throw new DomainError(
      "PRODUCTION_METHOD_REQUIRED",
      "Printing method is missing. Please return to Add Product and start a new design.",
      422,
    );
  }
  const persistedProductionMethod = cleanProductionMethod(lockedMethod);
  const requestedMethods = [
    input.fixedProductionMethod,
    input.productionMethod,
    input.selectedProductionMethod,
    nestedRequestedSetup.fixedProductionMethod,
    nestedRequestedSetup.productionMethod,
    nestedRequestedSetup.selectedProductionMethod,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    )
    .map((value) => value.trim())
    .map(cleanProductionMethod);
  if (requestedMethods.some((method) => method !== persistedProductionMethod)) {
    throw new DomainError("PRODUCTION_METHOD_LOCKED", "The printing method is fixed for this Creator Product.", 422);
  }
  const lockedInput = {
    ...input,
    fixedColor: effectiveColor || input.fixedColor,
    selectedColors: effectiveColors,
    fixedProductionMethod: persistedProductionMethod,
    productionMethod: persistedProductionMethod,
    selectedProductionMethod: persistedProductionMethod,
    creatorSetup: {
      ...(input.creatorSetup && typeof input.creatorSetup === "object"
        ? (input.creatorSetup as Record<string, unknown>)
        : {}),
      fixedColor: effectiveColor || requestedSetup.fixedColor,
      selectedColor: effectiveColor || requestedSetup.selectedColor,
      selectedColors: effectiveColors,
      fixedProductionMethod: persistedProductionMethod,
      productionMethod: persistedProductionMethod,
      selectedProductionMethod: persistedProductionMethod,
    },
  };
  const setup = await cleanCreatorProductSetup(
    shop,
    existing.shopifyProductId,
    lockedInput,
    productBaseVariants(existing),
    database,
  );
  const { pricingPreview, ...persistedSetup } = setup;
  if (!previewUrl) {
    throw new DomainError(
      "CREATOR_DESIGN_PREVIEW_REQUIRED",
      "We couldn't load your saved design. Please return to the editor and save the design again.",
      422,
    );
  }
  const nextStatus = existing.status === "PUBLISHED" ? "PENDING" : existing.status;
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      pitchprintProjectId: projectId,
      pitchprintDesignId:
        cleanPitchPrintDesignId(input.designId) ||
        existing.pitchprintDesignId,
      previewUrl,
      previewUrls: safeJson(previewUrls),
      designVariantSelectionsJson: safeJson(persistedSetup),
      creatorPricingPreviewJson: safeJson(pricingPreview || {}),
      status: nextStatus,
      submittedAt: nextStatus === "PENDING" ? new Date() : existing.submittedAt,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.pitchprint_saved",
      entityType: "CreatorProduct",
      entityId: existing.id,
      afterJson: safeJson({
        creatorId: creator.id,
        projectId,
        previewCount: previewUrls.length,
        fixedColor: setup.fixedColor,
        productionMethod: setup.productionMethod,
        placementCount: setup.placementCount,
        status: nextStatus,
      }),
    },
  });
  if (database === db) {
    await createAdminNotification({
      shop,
      type: "CREATOR_PRODUCT_SUBMITTED",
      title: "Creator product submitted",
      message: `${creator.handle || "A creator"} submitted "${updated.title}" for review.`,
      entityType: "CreatorProduct",
      entityId: updated.id,
      actionUrl: "/app/creator-products",
      metadata: { creatorId: creator.id, creatorProductId: updated.id },
    });
  }
  return updated;
}

export async function submitCreatorProductForReview(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!["DRAFT", "REJECTED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_SUBMITTABLE",
      "Only draft or rejected Creator Products can be submitted.",
      409,
    );
  }
  validateCompletableCreatorProduct(existing);
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "PENDING",
      submittedAt: new Date(),
      rejectedAt: null,
      rejectionReason: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.submitted",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ creatorId: creator.id, status: "PENDING" }),
    },
  });
  return updated;
}

async function creatorProductHistoryCount(
  shop: string,
  creatorProductId: string,
  database: CreatorProductDb,
) {
  const [sales, orderItems] = await Promise.all([
    database.creatorSale?.count({
      where: {
        shop,
        creatorProductId,
      },
    }) ?? 0,
    database.creatorOrderItem?.count({
      where: {
        shop,
        creatorProductId,
      },
    }) ?? 0,
  ]);
  return sales + orderItems;
}

export async function updateCreatorProductDetailsForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  input: UpdateCreatorProductDetailsInput,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status === "PENDING") {
    throw new DomainError(
      "PRODUCT_UNDER_REVIEW",
      "Details are locked while this design is under review.",
      409,
    );
  }
  const title = cleanCreatorProductTitle(input.title);
  const description = cleanCreatorProductDescription(input.description);
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      title,
      description,
      status: existing.status,
      pitchprintProjectId: existing.pitchprintProjectId,
      pitchprintDesignId: existing.pitchprintDesignId,
      shopifyProductId: existing.shopifyProductId,
      creatorId: existing.creatorId,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.details_updated",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({
        title: existing.title,
        description: existing.description,
        status: existing.status,
      }),
      afterJson: safeJson({
        title: updated.title,
        description: updated.description,
        status: updated.status,
      }),
    },
  });
  return updated;
}

export async function deleteCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status === "PUBLISHED") {
    throw new DomainError(
      "PUBLISHED_REQUIRES_ARCHIVE",
      "Published designs must be archived instead of deleted.",
      409,
    );
  }
  if (existing.status === "PENDING") {
    throw new DomainError(
      "PRODUCT_UNDER_REVIEW",
      "Withdraw this design from review before deleting it.",
      409,
    );
  }
  const hasHistory = (await creatorProductHistoryCount(shop, existing.id, database)) > 0;
  if (hasHistory) {
    throw new DomainError(
      "PRODUCT_HAS_ORDER_HISTORY",
      "Designs with order or sales history cannot be permanently deleted.",
      409,
    );
  }
  if (!["DRAFT", "REJECTED", "ARCHIVED"].includes(existing.status)) {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "This design cannot be deleted.",
      409,
    );
  }
  if (typeof database.creatorProduct.delete !== "function") {
    throw new DomainError(
      "DELETE_UNAVAILABLE",
      "Design delete is temporarily unavailable.",
      500,
    );
  }
  const deleted = await database.creatorProduct.delete({
    where: { id: existing.id },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.deleted",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({
        creatorId: creator.id,
        status: existing.status,
        hasHistory: false,
      }),
    },
  });
  return deleted;
}

export async function cleanupCreatorProductAsAdmin(
  shop: string,
  adminId: string | null,
  creatorProductId: string,
  action: "ARCHIVE" | "DELETE",
  clientOrDatabase: ShopifyGraphqlClient | CreatorProductDb = db,
  databaseOverride?: CreatorProductDb,
) {
  const hasShopifyClient =
    typeof (clientOrDatabase as ShopifyGraphqlClient).request === "function";
  const client = hasShopifyClient
    ? (clientOrDatabase as ShopifyGraphqlClient)
    : null;
  const database = hasShopifyClient
    ? databaseOverride || (db as unknown as CreatorProductDb)
    : (clientOrDatabase as CreatorProductDb);
  const existing = await database.creatorProduct.findFirst({
    where: { id: cleanCreatorProductId(creatorProductId), shop },
  });
  if (!existing) throw new DomainError("CREATOR_PRODUCT_NOT_FOUND", "Creator Product not found.", 404);
  const [orderItems, sales] = await Promise.all([
    database.creatorOrderItem?.count({ where: { creatorProductId: existing.id } }) ?? 0,
    database.creatorSale?.count({ where: { creatorProductId: existing.id } }) ?? 0,
  ]);
  const hasHistory = Number(orderItems) > 0 || Number(sales) > 0;
  if (action === "ARCHIVE") {
    if (client) {
      await cleanUpPublishedCreatorShopifyProduct(existing, "ARCHIVE", client);
    }
    const archived = await database.creatorProduct.update({
      where: { id: existing.id },
      data: { status: "ARCHIVED" },
    });
    await database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.archived_by_admin",
        entityType: "CreatorProduct",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "ARCHIVED", preservedHistory: hasHistory }),
      },
    });
    return { product: archived, hardDeleted: false, hasHistory };
  }
  if (hasHistory) {
    throw new DomainError(
      "CREATOR_PRODUCT_HISTORY_REQUIRES_ARCHIVE",
      "This product has order or financial history and must be archived instead of deleted.",
      409,
    );
  }
  if (!["DRAFT", "REJECTED", "ARCHIVED"].includes(existing.status)) {
    throw new DomainError(
      "CREATOR_PRODUCT_REQUIRES_ARCHIVE",
      "Only draft, rejected, or archived products can be permanently deleted.",
      409,
    );
  }
  if (typeof database.creatorProduct.delete !== "function") {
    throw new DomainError("DELETE_UNAVAILABLE", "Product delete is temporarily unavailable.", 503);
  }
  if (client) {
    await cleanUpPublishedCreatorShopifyProduct(existing, "DELETE", client);
  }
  await database.creatorProduct.delete({ where: { id: existing.id } });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "ADMIN",
      actorId: adminId,
      action: "creator_product.deleted_by_admin",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status, hasHistory: false }),
    },
  });
  return { product: existing, hardDeleted: true, hasHistory: false };
}

type CleanupShopifyProduct = {
  id: string;
  status: string;
  productOrigin: { value: string } | null;
  productType: { value: string } | null;
  creatorProductId: { value: string } | null;
};

async function cleanUpPublishedCreatorShopifyProduct(
  product: CreatorProductRecord,
  action: "ARCHIVE" | "DELETE",
  client: ShopifyGraphqlClient,
) {
  const publishedId = product.publishedShopifyProductId;
  if (!publishedId) return { changed: false, reason: "NO_MAPPING" as const };
  if (publishedId === product.shopifyProductId) {
    throw new DomainError(
      "GLOBAL_PRODUCT_CLEANUP_FORBIDDEN",
      "The mapped Shopify product is the global/base product and cannot be cleaned up.",
      409,
    );
  }
  const lookup = await client.request<{ product: CleanupShopifyProduct | null }>(
    `#graphql query CreatorProductCleanupTarget($id: ID!) {
      product(id: $id) {
        id
        status
        productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
      }
    }`,
    { id: publishedId },
  );
  if (!lookup.product) {
    return { changed: false, reason: "ALREADY_MISSING" as const };
  }
  if (
    lookup.product.productOrigin?.value !== "creator" ||
    lookup.product.productType?.value !== "creator_fixed" ||
    lookup.product.creatorProductId?.value !== product.id
  ) {
    throw new DomainError(
      "CREATOR_PRODUCT_CLEANUP_IDENTITY_MISMATCH",
      "The mapped Shopify product does not have the exact canonical Creator identity. It was not changed.",
      409,
    );
  }
  if (action === "ARCHIVE") {
    const result = await client.request<{
      productUpdate: {
        product: { id: string; status: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      `#graphql mutation ArchiveCreatorProductCleanup($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product { id status }
          userErrors { field message }
        }
      }`,
      { product: { id: publishedId, status: "ARCHIVED" } },
    );
    if (result.productUpdate.userErrors.length || !result.productUpdate.product) {
      throw new DomainError(
        "CREATOR_SHOPIFY_ARCHIVE_FAILED",
        "The Creator Shopify product could not be archived safely.",
        502,
      );
    }
    return { changed: true, reason: "ARCHIVED" as const };
  }
  const result = await client.request<{
    productDelete: {
      deletedProductId: string | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(
    `#graphql mutation DeleteCreatorProductCleanup($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }`,
    { input: { id: publishedId } },
  );
  if (
    result.productDelete.userErrors.length ||
    result.productDelete.deletedProductId !== publishedId
  ) {
    throw new DomainError(
      "CREATOR_SHOPIFY_DELETE_FAILED",
      "The dependency-free Creator Shopify product could not be deleted safely.",
      502,
    );
  }
  return { changed: true, reason: "DELETED" as const };
}

export async function archiveCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  clientOrDatabase: ShopifyGraphqlClient | CreatorProductDb = db,
  databaseOverride?: CreatorProductDb,
) {
  const hasShopifyClient =
    typeof (clientOrDatabase as ShopifyGraphqlClient).request === "function";
  const client = hasShopifyClient
    ? (clientOrDatabase as ShopifyGraphqlClient)
    : null;
  const database = hasShopifyClient
    ? databaseOverride || (db as unknown as CreatorProductDb)
    : (clientOrDatabase as CreatorProductDb);
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PUBLISHED") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only published designs can be archived.",
      409,
    );
  }
  if (client) {
    await cleanUpPublishedCreatorShopifyProduct(existing, "ARCHIVE", client);
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "ARCHIVED",
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.archived",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "ARCHIVED" }),
    },
  });
  return updated;
}

export async function withdrawCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PENDING") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only pending designs can be withdrawn.",
      409,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "DRAFT",
      submittedAt: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.withdrawn",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "DRAFT" }),
    },
  });
  return updated;
}

export async function restoreCreatorProductToDraftForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: creator.id,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "ARCHIVED") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only archived designs can be restored.",
      409,
    );
  }
  const updated = await database.creatorProduct.update({
    where: { id: existing.id },
    data: {
      status: "DRAFT",
      publishedAt: null,
      shopifyPublishedAt: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop,
      actorType: "CUSTOMER",
      actorId: normalizeCustomerGid(customerId),
      action: "creator_product.restored_to_draft",
      entityType: "CreatorProduct",
      entityId: existing.id,
      beforeJson: safeJson({ status: existing.status }),
      afterJson: safeJson({ status: "DRAFT" }),
    },
  });
  return updated;
}

export async function listCreatorProductsForAdmin(
  shop: string,
  status: string | null,
  database: CreatorProductDb = db,
): Promise<
  Array<
    CreatorProductRecord & {
      creator: {
        id: string;
        displayName: string;
        handle: string;
        customerId: string;
      };
    }
  >
> {
  const allowed = ["PENDING", "PUBLISHED", "REJECTED", "DRAFT", "ARCHIVED"];
  const normalized = status && allowed.includes(status) ? status : null;
  return database.creatorProduct.findMany({
    where: {
      shop,
      ...(normalized ? { status: normalized } : {}),
    },
    select: {
      id: true,
      shop: true,
      creatorId: true,
      shopifyProductId: true,
      shopifyProductHandle: true,
      baseProductTitle: true,
      pitchprintProjectId: true,
      pitchprintDesignId: true,
      title: true,
      description: true,
      previewUrl: true,
      previewUrls: true,
      status: true,
      publishedShopifyProductId: true,
      publishedShopifyProductHandle: true,
      publishedShopifyProductUrl: true,
      shopifyPublishedAt: true,
      baseVariantMappingJson: true,
      creatorPricingMode: true,
      creatorPricingPreviewJson: true,
      submittedAt: true,
      publishedAt: true,
      rejectedAt: true,
      rejectionReason: true,
      createdAt: true,
      updatedAt: true,
      creator: {
        select: {
          id: true,
          displayName: true,
          handle: true,
          customerId: true,
        },
      },
    },
    orderBy: [{ submittedAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  } as unknown) as Promise<
    Array<
      CreatorProductRecord & {
        creator: {
          id: string;
          displayName: string;
          handle: string;
          customerId: string;
        };
      }
    >
  >;
}

export async function moderateCreatorProductAsAdmin(
  shop: string,
  adminId: string | null,
  input: AdminCreatorProductDecisionInput,
  clientOrDatabase: ShopifyGraphqlClient | CreatorProductDb = db,
  maybeDatabase?: CreatorProductDb,
) {
  const hasClient =
    typeof (clientOrDatabase as ShopifyGraphqlClient).request === "function";
  const database =
    ((hasClient ? maybeDatabase : clientOrDatabase) as CreatorProductDb | undefined) ||
    db;
  const creatorProductId =
    typeof input.creatorProductId === "string" ? input.creatorProductId : "";
  const decision =
    typeof input.decision === "string" ? input.decision.toUpperCase() : "";
  const existing = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
    },
  });
  if (!existing) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (existing.status !== "PENDING") {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_PENDING",
      "Only pending Creator Products can be reviewed.",
      409,
    );
  }
  validateCompletableCreatorProduct(existing);
  if (decision === "PUBLISHED") {
    const updated = await database.creatorProduct.update({
      where: { id: existing.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
      },
    });
    await database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.approved",
        entityType: "CreatorProduct",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "PUBLISHED" }),
      },
    });
    return updated;
  }
  if (decision === "REJECTED") {
    const rejectionReason = cleanRejectionReason(input.rejectionReason);
    if (!rejectionReason) {
      throw new DomainError(
        "REJECTION_REASON_REQUIRED",
        "Enter a rejection reason.",
        422,
      );
    }
    const updated = await database.creatorProduct.update({
      where: { id: existing.id },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectionReason,
      },
    });
    await database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.rejected",
        entityType: "CreatorProduct",
        entityId: existing.id,
        beforeJson: safeJson({ status: existing.status }),
        afterJson: safeJson({ status: "REJECTED", reasonPresent: true }),
      },
    });
    return updated;
  }
  throw new DomainError(
    "INVALID_DECISION",
    "Choose approve or reject.",
    400,
  );
}

export async function listPublishedCreatorProductsForHandle(
  shop: string,
  creatorHandle: string,
  database: CreatorProductDb = db,
) {
  const collection = await getPublicCreatorCollection(
    shop,
    creatorHandle,
    database as unknown as Parameters<typeof getPublicCreatorCollection>[2],
  );
  const creator = collection.creator;
  const products = await database.creatorProduct.findMany({
    where: {
      shop,
      creatorId: collection.creatorId,
      status: "PUBLISHED",
    },
    orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  } as unknown);
  return { collection, creator, products };
}

export async function getPublishedCreatorProduct(
  shop: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const product = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      status: "PUBLISHED",
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  return product;
}

export async function getPublishedCreatorProductForHandle(
  shop: string,
  creatorHandle: string,
  creatorProductId: string,
  client?: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
): Promise<PublicCreatorProduct> {
  const collection = await getPublicCreatorCollection(
    shop,
    creatorHandle,
    database as unknown as Parameters<typeof getPublicCreatorCollection>[2],
  );
  const creator = collection.creator;
  const product = await database.creatorProduct.findFirst({
    where: {
      id: cleanCreatorProductId(creatorProductId),
      shop,
      creatorId: collection.creatorId,
      status: "PUBLISHED",
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  const storefrontProductId =
    product.creatorPricingMode === CREATOR_PRICING_MODE_BAKED_IN_V1 &&
    product.publishedShopifyProductId
      ? product.publishedShopifyProductId
      : product.shopifyProductId;
  const baseProduct = client
    ? await publicBaseProduct(storefrontProductId, client)
    : undefined;
  const creatorSetup = creatorProductSetupFromRecord(product);
  let productionPricing: PublicCreatorProduct["productionPricing"] = null;
  if (creatorSetup && database.publicProductProductionPricing) {
    try {
      const resolved = await resolveProductionPricing({
        shop,
        productId: product.shopifyProductId,
        method: creatorSetup.productionMethod,
        artworkType: creatorSetup.embroiderySubtype,
        database: database as unknown as Parameters<typeof resolveProductionPricing>[0]["database"],
      });
      productionPricing = {
        method: creatorSetup.productionMethod,
        fixedColor: creatorSetup.fixedColor,
        placementCount: creatorSetup.placementCount,
        methods: [{
          method: resolved.method,
          surchargeMinor: resolved.surchargeMinor.toString(),
          feeVariantId: resolved.feeVariantId,
        }],
      };
    } catch {
      productionPricing = null;
    }
  }
  return {
    ...product,
    creator,
    collection,
    ...(baseProduct ? { baseProduct } : {}),
    creatorSetup,
    productionPricing,
  };
}

export async function publicCreatorProductDetail(
  shop: string,
  creatorHandle: string,
  creatorProductId: string,
  client: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  return getPublishedCreatorProductForHandle(
    shop,
    creatorHandle,
    creatorProductId,
    client,
    database,
  );
}

export async function publicCreatorCollection(
  shop: string,
  creatorHandle: string,
  client?: ShopifyGraphqlClient,
  database: CreatorProductDb = db,
) {
  const result = await listPublishedCreatorProductsForHandle(
    shop,
    creatorHandle,
    database,
  );
  if (!client) return result;
  const bases = new Map<string, PublicCreatorProductBase>();
  for (const product of result.products) {
    const priceProductId =
      product.creatorPricingMode === CREATOR_PRICING_MODE_BAKED_IN_V1 &&
      product.publishedShopifyProductId
        ? product.publishedShopifyProductId
        : product.shopifyProductId;
    if (!bases.has(priceProductId)) {
      bases.set(
        priceProductId,
        await publicBaseProduct(priceProductId, client),
      );
    }
  }
  return {
    collection: result.collection,
    creator: result.creator,
    products: result.products.map((product) => {
      const priceProductId =
        product.creatorPricingMode === CREATOR_PRICING_MODE_BAKED_IN_V1 &&
        product.publishedShopifyProductId
          ? product.publishedShopifyProductId
          : product.shopifyProductId;
      return {
        ...product,
        baseProduct: bases.get(priceProductId),
      };
    }),
  };
}

export async function prepareCreatorProductCart(
  shop: string,
  input: PrepareCreatorProductCartInput,
  client: ShopifyGraphqlClient,
  cloner: PitchPrintProjectCloner = clonePitchPrintProject,
  database: CreatorProductDb = db,
): Promise<PreparedCreatorProductCart> {
  const creatorHandle =
    typeof input.publicHandle === "string"
      ? input.publicHandle.trim()
      : typeof input.creatorHandle === "string"
        ? input.creatorHandle.trim()
        : "";
  if (!creatorHandle) {
    throw new DomainError(
      "CREATOR_HANDLE_REQUIRED",
      "Creator product URL is invalid.",
      400,
    );
  }
  const creatorProductId = cleanCreatorProductId(input.creatorProductId);
  const selectedVariantKey = cleanVariantSelection(input.selectedVariantId);
  const quantity = cleanQuantity(input.quantity);
  const product = await getPublishedCreatorProductForHandle(
    shop,
    creatorHandle,
    creatorProductId,
    client,
    database,
  );
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_MISSING",
      "This creator design is not ready for purchase.",
      409,
    );
  }
  const setup = requireCreatorProductSetup(product);
  const productionMethod = cleanProductionMethod(setup.productionMethod);
  const clientProductionMethod =
    input.selectedProductionMethod ?? input.productionMethod;
  if (
    typeof clientProductionMethod === "string" &&
    clientProductionMethod.trim() &&
    cleanProductionMethod(clientProductionMethod) !== productionMethod
  ) {
    throw new DomainError(
      "PRODUCTION_METHOD_LOCKED",
      "The printing method is fixed for this Creator Product.",
      422,
    );
  }
  if (!booleanTrue(input.nonReturnAcknowledged)) {
    throw new DomainError(
      "NON_RETURN_ACKNOWLEDGEMENT_REQUIRED",
      "Confirm that this customized made-to-order product cannot be returned.",
      422,
    );
  }
  if (!booleanTrue(input.termsAccepted)) {
    throw new DomainError(
      "TERMS_ACCEPTANCE_REQUIRED",
      "Accept the Terms and Conditions before adding this customized product to cart.",
      422,
    );
  }
  const variant = product.baseProduct?.variants.find(
    (item) =>
      item.graphqlId === selectedVariantKey ||
      item.id === selectedVariantKey ||
      item.numericId === selectedVariantKey ||
      String(item.cartId) === selectedVariantKey,
  );
  if (!variant) {
    throw new DomainError(
      "INVALID_VARIANT",
      "Choose a valid option for this product.",
      422,
    );
  }
  if (!variant.availableForSale) {
    throw new DomainError(
      "VARIANT_UNAVAILABLE",
      "Choose an available option for this product.",
      409,
    );
  }
  if (!/^\d+$/.test(variant.cartId)) {
    throw new DomainError(
      "INVALID_VARIANT",
      "Choose an available option for this product.",
      409,
    );
  }
  const variantColor = colorValueFromOptions(variant.selectedOptions || []);
  if (
    variantColor &&
    normalizedOptionText(variantColor) !== normalizedOptionText(setup.fixedColor)
  ) {
    throw new DomainError(
      "INVALID_CREATOR_COLOR",
      "Choose a size for this design's fixed product color.",
      422,
    );
  }
  if (product.creatorPricingMode === CREATOR_PRICING_MODE_BAKED_IN_V1) {
    if (!product.publishedShopifyProductId) {
      throw new DomainError(
        "PUBLISHED_PRODUCT_REQUIRED",
        "This Creator Product is not ready for purchase.",
        409,
      );
    }
    const selectedVariantIsPublished =
      Boolean(product.publishedShopifyProductId) &&
      product.baseProduct?.id === product.publishedShopifyProductId;
    const inferredBaseVariantId = selectedVariantIsPublished
      ? inferredBaseVariantForPublishedVariant(product, variant)
      : "";
    const publishedVariantId = inferredBaseVariantId
      ? variant.graphqlId
      : publishedVariantForBaseVariant(product, variant.graphqlId);
    if (!publishedVariantId) {
      throw new DomainError(
        "PUBLISHED_VARIANT_MAPPING_REQUIRED",
        "This Creator Product variant is not mapped to its published product.",
        409,
      );
    }
    return prepareNativeCreatorProductCart(
      shop,
      {
        shopifyProductId: product.publishedShopifyProductId,
        selectedVariantId: publishedVariantId,
        quantity,
        nonReturnAcknowledged: input.nonReturnAcknowledged,
        termsAccepted: input.termsAccepted,
      },
      client,
      cloner,
      database,
    );
  }
  let pricing = await getProductionPricing(
    shop,
    product.shopifyProductId,
    database as unknown as Parameters<typeof getProductionPricing>[2],
  );
  if (!pricing && product.creatorPricingMode !== CREATOR_PRICING_MODE_BAKED_IN_V1) {
    pricing = await getCreatorProductionPricing(
      shop,
      database as unknown as Parameters<typeof getCreatorProductionPricing>[1],
    );
  }
  if (!pricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Production pricing is not configured for this product.",
      409,
    );
  }
  if (productionMethod === "EMBROIDERY" && !setup.embroiderySubtype) {
    throw new DomainError(
      "EMBROIDERY_SUBTYPE_REQUIRED",
      "Embroidery artwork type must be resolved before purchase.",
      409,
    );
  }
  const embroiderySubtype = productionMethod === "EMBROIDERY"
    ? cleanEmbroiderySubtype(setup.embroiderySubtype)
    : null;
  const usingLegacySharedPricing =
    pricing.shopifyProductId === CREATOR_PRODUCTION_PRICING_PRODUCT_ID;
  const resolved = usingLegacySharedPricing
    ? null
    : await resolveProductionPricing({
        shop,
        productId: product.shopifyProductId,
        method: productionMethod,
        artworkType: embroiderySubtype,
        database: database as unknown as Parameters<typeof resolveProductionPricing>[0]["database"],
      });
  const surchargeMinor = resolved?.surchargeMinor ?? decimalMoneyToMinorUnits(
    embroiderySubtype
      ? pricingForEmbroiderySubtype(pricing, embroiderySubtype)
      : pricingForMethod(pricing, productionMethod),
  );
  let feeVariantId = resolved?.feeVariantId ?? (embroiderySubtype
    ? feeVariantIdForEmbroiderySubtype(pricing, embroiderySubtype)
    : feeVariantIdForMethod(pricing, productionMethod));
  if (
    surchargeMinor > 0n &&
    (!feeVariantId || (await productionFeeVariantNeedsSync(feeVariantId, client)))
  ) {
    try {
      const feeSync = await syncProductionFeeMerchandise(
        shop,
        pricing,
        client,
        database as unknown as Parameters<typeof syncProductionFeeMerchandise>[3],
      );
      pricing = feeSync.pricing;
      if (usingLegacySharedPricing) {
        feeVariantId = embroiderySubtype
          ? feeVariantIdForEmbroiderySubtype(pricing, embroiderySubtype)
          : feeVariantIdForMethod(pricing, productionMethod);
      } else {
        feeVariantId = (await resolveProductionPricing({
          shop,
          productId: product.shopifyProductId,
          method: productionMethod,
          artworkType: embroiderySubtype,
          database: database as unknown as Parameters<typeof resolveProductionPricing>[0]["database"],
        })).feeVariantId;
      }
    } catch {
      feeVariantId = null;
    }
  }
  if (surchargeMinor > 0n && !feeVariantId) {
    throw new DomainError(
      "PRODUCTION_FEE_SYNC_REQUIRED",
      "Production fee merchandise is not synced for this product.",
      409,
    );
  }
  const orderProjectId = await preparePitchPrintOrderProject(
    product.pitchprintProjectId,
    cloner,
  );
  const previewUrl = creatorCartPreviewUrl(product);
  let attribution: string;
  try {
    attribution = signCreatorAttribution({
      creatorProductId: product.id,
      creatorId: product.creatorId,
      creatorCollectionId: product.collection.id,
      baseProductId: product.shopifyProductId,
      baseVariantId: variant.graphqlId,
      pitchprintProjectId: orderProjectId,
    });
  } catch {
    throw new DomainError(
      "ATTRIBUTION_SIGNING_FAILED",
      "This creator design is temporarily unavailable.",
      500,
    );
  }
  const feeKey = [
    "ch-creator-production",
    product.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    orderProjectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    productionMethod.toLowerCase(),
  ].join("-");
  const properties = {
    _pitchprint: orderProjectId,
    _pitchprint_design_id: product.pitchprintDesignId || "",
    _creator_master_project_id: product.pitchprintProjectId,
    _creator_product_id: product.id,
    _creator_id: product.creatorId,
    _creator_collection_id: product.collection.id,
    _base_product_id: product.shopifyProductId,
    _base_variant_id: variant.graphqlId,
    _creator_public_handle: product.collection.publicHandle,
    _customhouse_creator_handle: product.collection.publicHandle,
    _production_method: productionMethod,
    _fixed_color: setup.fixedColor,
    _designed_placement_count: String(setup.placementCount),
    ...(embroiderySubtype ? { _embroidery_subtype: embroiderySubtype } : {}),
    _customhouse_fee_key: feeKey,
    ...(previewUrl ? { _creator_preview_url: previewUrl } : {}),
    _customhouse_attribution: attribution,
    _creator_design_title: product.title,
    _creator_name: product.creator.displayName,
    _customhouse_non_return_acknowledgement: "Accepted",
    _customhouse_terms_acknowledgement: "Accepted",
  };
  const feeQuantity = quantity * setup.placementCount;
  const feeItem =
    surchargeMinor > 0n && feeVariantId
      ? {
          id: numericVariantId(feeVariantId),
          quantity: feeQuantity,
          properties: {
            _customhouse_production_fee: "true",
            _creator_product_id: product.id,
            _customhouse_parent_product_id: product.shopifyProductId,
            _customhouse_parent_project_id: orderProjectId,
            _customhouse_fee_key: feeKey,
            _pitchprint: orderProjectId,
            _production_method: productionMethod,
            _fixed_color: setup.fixedColor,
            _designed_placement_count: String(setup.placementCount),
            ...(embroiderySubtype ? { _embroidery_subtype: embroiderySubtype } : {}),
            _customhouse_creator_product_fee: "true",
          },
        }
      : null;
  return {
    variant: {
      graphqlId: variant.graphqlId,
      cartId: variant.cartId,
    },
    variantId: variant.cartId,
    cartVariantId: variant.cartId,
    shopifyVariantId: variant.graphqlId,
    quantity,
    properties,
    production: {
      method: productionMethod,
      embroiderySubtype,
      fixedColor: setup.fixedColor,
      placementCount: setup.placementCount,
      surchargeMinor: surchargeMinor.toString(),
      feeVariantId: feeVariantId ? numericVariantId(feeVariantId) : null,
      feeQuantity,
      pricingMode: null,
    },
    items: [
      {
        id: variant.cartId,
        quantity,
        properties,
      },
      ...(feeItem ? [feeItem] : []),
    ],
    creatorProduct: {
      id: product.id,
      title: product.title,
      creatorId: product.creatorId,
      masterPitchPrintProjectId: product.pitchprintProjectId,
    },
  };
}

export async function prepareNativeCreatorProductCart(
  shop: string,
  input: PrepareNativeCreatorProductCartInput,
  client: ShopifyGraphqlClient,
  cloner: PitchPrintProjectCloner = clonePitchPrintProject,
  database: CreatorProductDb = db,
): Promise<PreparedCreatorProductCart> {
  const shopifyProductId = cleanProductGidOrNumeric(input.shopifyProductId);
  const selectedVariantId = cleanVariantGidOrNumeric(input.selectedVariantId);
  const quantity = cleanQuantity(input.quantity);
  const product = await database.creatorProduct.findFirst({
    where: {
      shop,
      publishedShopifyProductId: shopifyProductId,
      status: "PUBLISHED",
      creator: { status: "APPROVED" },
    },
    include: { creator: true },
  } as unknown);
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  if (!product.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_REQUIRED",
      "This creator design is not ready for purchase.",
      409,
    );
  }
  const nativeVariant = await verifyNativeVariant(client, shopifyProductId, selectedVariantId);
  const collection = await getCreatorCollectionByCreatorId(
    shop,
    product.creatorId,
    database as unknown as Parameters<typeof getCreatorCollectionByCreatorId>[2],
  );
  if (!collection || collection.status !== "ACTIVE") {
    throw new DomainError(
      "COLLECTION_NOT_FOUND",
      "Creator collection not found.",
      404,
    );
  }
  const baseVariantId = inferredBaseVariantForPublishedVariant(product, nativeVariant);
  if (!baseVariantId) {
    throw new DomainError(
      "BASE_VARIANT_MAPPING_REQUIRED",
      "This Creator Product variant is not mapped to its base product.",
      409,
    );
  }
  if (product.creatorPricingMode === CREATOR_PRICING_MODE_BAKED_IN_V1) {
    if (!booleanTrue(input.nonReturnAcknowledged)) {
      throw new DomainError(
        "NON_RETURN_ACKNOWLEDGEMENT_REQUIRED",
        "Confirm that this customized made-to-order product cannot be returned.",
        422,
      );
    }
    if (!booleanTrue(input.termsAccepted)) {
      throw new DomainError(
        "TERMS_ACCEPTANCE_REQUIRED",
        "Accept the Terms and Conditions before adding this customized product to cart.",
        422,
      );
    }
    const setup = requireCreatorProductSetup(product);
    const productionMethod = cleanProductionMethod(setup.productionMethod);
    const embroiderySubtype = productionMethod === "EMBROIDERY"
      ? cleanEmbroiderySubtype(setup.embroiderySubtype)
      : null;
    const orderProjectId = await preparePitchPrintOrderProject(
      product.pitchprintProjectId,
      cloner,
    );
    const feeKey = [
      "ch-creator-baked",
      product.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
      orderProjectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80),
    ].join("-");
    let attribution: string;
    try {
      attribution = signCreatorAttribution({
        creatorProductId: product.id,
        creatorId: product.creatorId,
        creatorCollectionId: collection.id,
        baseProductId: product.shopifyProductId,
        baseVariantId,
        pitchprintProjectId: orderProjectId,
      });
    } catch {
      throw new DomainError(
        "ATTRIBUTION_SIGNING_FAILED",
        "This creator design is temporarily unavailable.",
        500,
      );
    }
    const previewUrl = creatorCartPreviewUrl(product);
    const creatorName = (
      product as CreatorProductRecord & { creator?: { displayName?: string } }
    ).creator?.displayName || collection.displayName;
    const properties = {
      _pitchprint: orderProjectId,
      _design_id: product.pitchprintDesignId || "",
      _pitchprint_design_id: product.pitchprintDesignId || "",
      _creator_master_project_id: product.pitchprintProjectId,
      _creator_product_id: product.id,
      _creator_id: product.creatorId,
      _creator_collection_id: collection.id,
      _base_product_id: product.shopifyProductId,
      _base_variant_id: baseVariantId,
      _creator_public_handle: collection.publicHandle,
      _customhouse_creator_handle: collection.publicHandle,
      _production_method: productionMethod,
      _fixed_color: setup.fixedColor,
      _designed_placement_count: String(setup.placementCount),
      _creator_pricing_mode: CREATOR_PRICING_MODE_BAKED_IN_V1,
      ...(embroiderySubtype ? { _embroidery_subtype: embroiderySubtype } : {}),
      _customhouse_fee_key: feeKey,
      ...(previewUrl ? { _creator_preview_url: previewUrl } : {}),
      _customhouse_attribution: attribution,
      _creator_design_title: product.title,
      _creator_name: creatorName,
      _customhouse_non_return_acknowledgement: "Accepted",
      _customhouse_terms_acknowledgement: "Accepted",
    };
    const cartVariantId = numericVariantId(selectedVariantId);
    return {
      variant: { graphqlId: selectedVariantId, cartId: cartVariantId },
      variantId: cartVariantId,
      cartVariantId,
      shopifyVariantId: selectedVariantId,
      quantity,
      properties,
      production: {
        method: productionMethod,
        embroiderySubtype,
        fixedColor: setup.fixedColor,
        placementCount: setup.placementCount,
        surchargeMinor: creatorPricingSurchargeMinor(product),
        feeVariantId: null,
        feeQuantity: 0,
        pricingMode: CREATOR_PRICING_MODE_BAKED_IN_V1,
      },
      items: [{ id: cartVariantId, quantity, properties }],
      creatorProduct: {
        id: product.id,
        title: product.title,
        creatorId: product.creatorId,
        masterPitchPrintProjectId: product.pitchprintProjectId,
      },
      nativeProduct: { shopifyProductId, selectedVariantId },
    };
  }
  const prepared = await prepareCreatorProductCart(
    shop,
    {
      creatorHandle: collection.publicHandle,
      creatorProductId: product.id,
      selectedVariantId: baseVariantId,
      quantity,
      nonReturnAcknowledged: input.nonReturnAcknowledged,
      termsAccepted: input.termsAccepted,
    },
    client,
    cloner,
    database,
  );
  return {
    ...prepared,
    nativeProduct: {
      shopifyProductId,
      selectedVariantId,
    },
  };
}

export async function listCreatorProductsForCustomer(
  shop: string,
  customerId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const collection =
    "marketplaceCollection" in creator && creator.marketplaceCollection
      ? creator.marketplaceCollection
      : await getCreatorCollectionByCreatorId(
          shop,
          creator.id,
          database as unknown as Parameters<typeof getCreatorCollectionByCreatorId>[2],
        );
  const products = await database.creatorProduct.findMany({
    where: {
      shop,
      creatorId: creator.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });
  return products.map((product) => ({
    ...product,
    creatorHandle: collection?.publicHandle || null,
    collectionUrl: getCreatorCollectionStorefrontUrl(collection),
    storefrontCollectionUrl: getCreatorCollectionStorefrontUrl(collection),
    publicProductUrl:
      getCreatorProductStorefrontUrl(collection, product) ||
      `/apps/customhouse/design/${encodeURIComponent(product.id)}`,
    storefrontProductUrl: getCreatorProductStorefrontUrl(collection, product),
  }));
}

export async function getCreatorProductForCustomer(
  shop: string,
  customerId: string,
  creatorProductId: string,
  database: CreatorProductDb = db,
) {
  const creator = await approvedCreatorForCustomer(shop, customerId, database);
  const product = await database.creatorProduct.findFirst({
    where: {
      id: creatorProductId,
      shop,
      creatorId: creator.id,
    },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "Creator Product not found.",
      404,
    );
  }
  return product;
}

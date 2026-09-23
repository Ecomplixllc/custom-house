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
  PRODUCTION_METHODS,
  cleanProductionMethod,
  feeVariantIdForMethod,
  getCreatorProductionPricing,
  getProductionPricing,
  listEnabledProductionMethodCodes,
  pricingForMethod,
  syncProductionFeeMerchandise,
  type ProductionMethodCode,
} from "./production-method-pricing.server.ts";

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
    findMany(args: unknown): Promise<Array<{ method: string; enabled: boolean }>>;
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
  projectId: unknown;
  previews?: unknown;
  previewUrl?: unknown;
  designId?: unknown;
  variantSelections?: unknown;
  creatorSetup?: unknown;
  selectedColor?: unknown;
  selectedColors?: unknown;
  fixedColor?: unknown;
  selectedProductionMethod?: unknown;
  productionMethod?: unknown;
  fixedProductionMethod?: unknown;
  placementCount?: unknown;
  designedPlacementCount?: unknown;
  placements?: unknown;
  designedPlacements?: unknown;
  copyrightAccepted?: unknown;
  copyrightConfirmed?: unknown;
  rightsConfirmed?: unknown;
  nonReturnAcknowledged?: unknown;
};

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
  selectedColors: string[];
  productionMethod: ProductionMethodCode;
  placementCount: number;
  placements: string[];
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
    product: {
      id: string;
      title: string;
      handle: string;
      origin: { value: string } | null;
      mode: { value: string } | null;
      featuredImage: { url: string } | null;
      pitchprintDesignId: { value: string } | null;
      legacyPitchprintDesignId: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          legacyResourceId: string;
          title: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query CreatorProductBaseProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            title
            availableForSale
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
  return product;
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

function pitchPrintPreviewPlacementCount(input: AttachPitchPrintProjectInput) {
  return cleanPreviewUrls(input).length;
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
      selectedOptions?: Array<{ name: string; value: string }> | null;
    }>;
  } | null;
}) {
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
      return {
        id: variant.id,
        graphqlId: variant.id,
        variantId,
        title,
        size: sizeValueFromOptions(selectedOptions) || title,
        availableForSale: variant.availableForSale !== false,
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
  return {
    ...input,
    ...nested,
  } as Record<string, unknown>;
}

function stringArray(value: unknown) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => cleanOptionalText(item, 120))
    .filter((item): item is string => Boolean(item));
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

function placementLabel(value: unknown) {
  if (typeof value === "string") return cleanOptionalText(value, 80);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return (
    cleanOptionalText(record.label, 80) ||
    cleanOptionalText(record.name, 80) ||
    cleanOptionalText(record.side, 80) ||
    cleanOptionalText(record.placement, 80) ||
    cleanOptionalText(record.id, 80)
  );
}

function placementHasArtwork(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.hasArtwork === false ||
    record.hasDesign === false ||
    record.isBlank === true ||
    record.blank === true ||
    record.empty === true
  ) {
    return false;
  }
  return Boolean(
    record.hasArtwork === true ||
      record.hasDesign === true ||
      record.artwork === true ||
      record.printed === true ||
      record.used === true ||
      placementLabel(record),
  );
}

function collectPlacementRecords(setup: Record<string, unknown>) {
  const candidates = [
    setup.placements,
    setup.designedPlacements,
    setup.printPlacements,
    setup.printedPlacements,
    (setup.productionSurchargeMetadata as Record<string, unknown> | undefined)
      ?.placements,
    (setup.dimensionData as Record<string, unknown> | undefined)?.placements,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const placements = candidate
      .filter(placementHasArtwork)
      .map(placementLabel)
      .filter((item): item is string => Boolean(item));
    if (placements.length) return [...new Set(placements)].slice(0, 20);
  }
  return [];
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
  if (
    setup.schema !== "creator_design_setup_v1" ||
    setup.flowMode !== "CREATOR_DESIGN" ||
    setup.designMode !== "creator_design" ||
    setup.isCreatorProduct !== true ||
    !setup.fixedColor ||
    !setup.productionMethod ||
    !setup.placementCount ||
    !setup.copyrightAccepted
  ) {
    return null;
  }
  return setup as CreatorProductSetup;
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
  const selectedColors = [
    ...new Set([
      ...stringArray(setup.selectedColors),
      ...stringArray(setup.selectedColor),
      ...stringArray(setup.fixedColor),
    ]),
  ];
  if (selectedColors.length !== 1) {
    throw new DomainError(
      "CREATOR_COLOR_REQUIRED",
      "Choose exactly one product color for this Creator Product.",
      422,
    );
  }
  const fixedColor = selectedColors[0]!;
  if (
    colors.length &&
    !colors.some((color) => normalizedOptionText(color) === normalizedOptionText(fixedColor))
  ) {
    throw new DomainError(
      "CREATOR_COLOR_INVALID",
      "Choose a color that exists on the base product.",
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
  const enabledMethods =
    database.productionMethodSetting &&
    database.publicProductProductionPricing
      ? await listEnabledProductionMethodCodes(
          shop,
          database as unknown as Parameters<typeof listEnabledProductionMethodCodes>[1],
        )
      : [];
  if (enabledMethods.length && !enabledMethods.includes(productionMethod)) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose an enabled printing method.",
      422,
    );
  }
  const placements = collectPlacementRecords(setup);
  const explicitPlacementCount = directPositiveInteger(
    setup.placementCount,
    setup.designedPlacementCount,
    (setup.productionSurchargeMetadata as Record<string, unknown> | undefined)
      ?.placementCount,
  );
  const previewPlacementCount = pitchPrintPreviewPlacementCount(input);
  const placementCount =
    placements.length ||
    explicitPlacementCount ||
    previewPlacementCount;
  if (!placementCount) {
    throw new DomainError(
      "DESIGNED_PLACEMENT_REQUIRED",
      "Add artwork to at least one printable area before saving.",
      422,
    );
  }
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
  if (database.publicProductProductionPricing) {
    const pricing = await getProductionPricing(
      shop,
      shopifyProductId,
      database as unknown as Parameters<typeof getProductionPricing>[2],
    );
    if (!pricing) {
      throw new DomainError(
        "PRODUCTION_PRICING_REQUIRED",
        "Production pricing is not configured for this product.",
        409,
      );
    }
    pricingForMethod(pricing, productionMethod);
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
    selectedColors: [fixedColor],
    productionMethod,
    placementCount,
    placements: placements.length
      ? placements
      : Array.from(
          { length: placementCount },
          (_, index) =>
            `${previewPlacementCount && !explicitPlacementCount ? "Artwork area" : "Placement"} ${index + 1}`,
        ),
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
async function productionFeeVariantNeedsSync(
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
  const baseProductVariants = creatorProductBaseVariants(product);
  const selectedColors = [
    ...new Set([
      ...stringArray(input.selectedColors),
      ...stringArray(input.fixedColor),
    ]),
  ];
  if (selectedColors.length !== 1) {
    throw new DomainError(
      "CREATOR_COLOR_REQUIRED",
      "Choose exactly one product color for this Creator Product.",
      422,
    );
  }
  const fixedColor = selectedColors[0]!;
  const colors = baseProductColorValues(baseProductVariants);
  if (!colors.some((color) => normalizedOptionText(color) === normalizedOptionText(fixedColor))) {
    throw new DomainError(
      "CREATOR_COLOR_INVALID",
      "Choose a color that exists on the base product.",
      422,
    );
  }
  const productionMethod = cleanProductionMethod(
    input.fixedProductionMethod ?? input.selectedProductionMethod,
  );
  const enabledMethods = database.productionMethodSetting
    ? await listEnabledProductionMethodCodes(
        shop,
        database as unknown as Parameters<typeof listEnabledProductionMethodCodes>[1],
      )
    : [];
  if (enabledMethods.length && !enabledMethods.includes(productionMethod)) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose an enabled printing method.",
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
    fixedColor,
    selectedColors: [fixedColor],
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
        fixedColor,
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
  const result = await client.request<{
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
            selectedOptions: Array<{ name: string; value: string }>;
          }>;
        };
      }>;
    };
  }>(
    `#graphql query CreatorBaseProducts {
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
              selectedOptions { name value }
            }
          }
        }
      }
    }`,
  );
  return result.products.nodes
    .map((product) => {
      const classification = eligibleClassification(product);
      if (!classification) return null;
      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        imageUrl: product.featuredImage?.url || null,
        pitchprintDesignId:
          product.pitchprintDesignId?.value ||
          product.legacyPitchprintDesignId?.value ||
          null,
        productionMethodPricing: product.productionMethodPricing?.value || null,
        classification,
        variants: creatorProductBaseVariants(product),
      } satisfies EligibleCreatorBaseProduct;
    })
    .filter((product): product is EligibleCreatorBaseProduct =>
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
    userId: `customhouse:${shop}:creator:${creator.id}`,
  };
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
  const projectId = cleanProjectId(input.projectId);
  const previewUrls = cleanPreviewUrls(input);
  const previewUrl = previewUrls[0] || existing.previewUrl || null;
  let lockedSetup: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing.designVariantSelectionsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      lockedSetup = parsed as Record<string, unknown>;
    }
  } catch {
    lockedSetup = {};
  }
  const requestedSetup = rawCreatorSetup(input);
  const requestedColors = [
    ...new Set([
      ...stringArray(requestedSetup.selectedColors),
      ...stringArray(requestedSetup.selectedColor),
      ...stringArray(requestedSetup.fixedColor),
    ]),
  ];
  const lockedColor = cleanOptionalText(lockedSetup.fixedColor, 120);
  if (
    lockedColor &&
    requestedColors.some((color) => normalizedOptionText(color) !== normalizedOptionText(lockedColor))
  ) {
    throw new DomainError("CREATOR_COLOR_LOCKED", "The product color is fixed for this Creator Product.", 422);
  }
  const lockedMethod = cleanOptionalText(lockedSetup.productionMethod, 40);
  const requestedMethod = cleanOptionalText(
    requestedSetup.fixedProductionMethod || requestedSetup.productionMethod || requestedSetup.selectedProductionMethod,
    40,
  );
  if (lockedMethod && requestedMethod && cleanProductionMethod(requestedMethod) !== cleanProductionMethod(lockedMethod)) {
    throw new DomainError("PRODUCTION_METHOD_LOCKED", "The printing method is fixed for this Creator Product.", 422);
  }
  const lockedInput = {
    ...input,
    fixedColor: lockedColor || input.fixedColor,
    selectedColors: lockedColor ? [lockedColor] : input.selectedColors,
    fixedProductionMethod: lockedMethod || input.fixedProductionMethod,
    productionMethod: lockedMethod || input.productionMethod,
    selectedProductionMethod: lockedMethod || input.selectedProductionMethod,
    creatorSetup: {
      ...(input.creatorSetup && typeof input.creatorSetup === "object"
        ? (input.creatorSetup as Record<string, unknown>)
        : {}),
      fixedColor: lockedColor || requestedSetup.fixedColor,
      selectedColor: lockedColor || requestedSetup.selectedColor,
      selectedColors: lockedColor ? [lockedColor] : requestedSetup.selectedColors,
      fixedProductionMethod:
        lockedMethod || requestedSetup.fixedProductionMethod,
      productionMethod: lockedMethod || requestedSetup.productionMethod,
      selectedProductionMethod:
        lockedMethod || requestedSetup.selectedProductionMethod,
    },
  };
  const setup = await cleanCreatorProductSetup(
    shop,
    existing.shopifyProductId,
    lockedInput,
    productBaseVariants(existing),
    database,
  );
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
      designVariantSelectionsJson: safeJson(setup),
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
  database: CreatorProductDb = db,
) {
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

export async function archiveCreatorProductForCustomer(
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
  if (existing.status !== "PUBLISHED") {
    throw new DomainError(
      "INVALID_STATUS_TRANSITION",
      "Only published designs can be archived.",
      409,
    );
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
  const baseProduct = client ? await publicBaseProduct(product.shopifyProductId, client) : undefined;
  const creatorSetup = creatorProductSetupFromRecord(product);
  let productionPricing: PublicCreatorProduct["productionPricing"] = null;
  if (creatorSetup && database.publicProductProductionPricing) {
    const pricing = await getCreatorProductionPricing(
      shop,
      database as unknown as Parameters<typeof getCreatorProductionPricing>[1],
    );
    if (pricing) {
      const enabledMethods = database.productionMethodSetting
        ? await listEnabledProductionMethodCodes(
            shop,
            database as unknown as Parameters<typeof listEnabledProductionMethodCodes>[1],
          )
        : [];
      const methods = (enabledMethods.length ? enabledMethods : PRODUCTION_METHODS).map((method) => ({
        method,
        surchargeMinor: decimalMoneyToMinorUnits(
          pricingForMethod(pricing, method),
        ).toString(),
        feeVariantId: feeVariantIdForMethod(pricing, method) || null,
      }));
      productionPricing = {
        method: creatorSetup.productionMethod,
        fixedColor: creatorSetup.fixedColor,
        placementCount: creatorSetup.placementCount,
        methods,
      };
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
    if (!bases.has(product.shopifyProductId)) {
      bases.set(
        product.shopifyProductId,
        await publicBaseProduct(product.shopifyProductId, client),
      );
    }
  }
  return {
    collection: result.collection,
    creator: result.creator,
    products: result.products.map((product) => ({
      ...product,
      baseProduct: bases.get(product.shopifyProductId),
    })),
  };
}

export async function prepareCreatorProductCart(
  shop: string,
  input: PrepareCreatorProductCartInput,
  client: ShopifyGraphqlClient,
  cloner: PitchPrintProjectCloner = clonePitchPrintProject,
  database: CreatorProductDb = db,
) {
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
  const enabledMethods = database.productionMethodSetting
    ? await listEnabledProductionMethodCodes(
        shop,
        database as unknown as Parameters<typeof listEnabledProductionMethodCodes>[1],
      )
    : [];
  if (enabledMethods.length && !enabledMethods.includes(productionMethod)) {
    throw new DomainError(
      "PRODUCTION_METHOD_DISABLED",
      "Choose an enabled printing method.",
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
  let pricing = await getCreatorProductionPricing(
    shop,
    database as unknown as Parameters<typeof getCreatorProductionPricing>[1],
  );
  if (!pricing) {
    throw new DomainError(
      "PRODUCTION_PRICING_REQUIRED",
      "Production pricing is not configured for this product.",
      409,
    );
  }
  const surchargeMinor = decimalMoneyToMinorUnits(
    pricingForMethod(pricing, productionMethod),
  );
  let feeVariantId = feeVariantIdForMethod(pricing, productionMethod);
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
      feeVariantId = feeVariantIdForMethod(pricing, productionMethod);
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
    _creator_product_id: product.id,
    _creator_id: product.creatorId,
    _creator_collection_id: product.collection.id,
    _base_product_id: product.shopifyProductId,
    _base_variant_id: variant.graphqlId,
    _creator_public_handle: product.collection.publicHandle,
    _customhouse_creator_handle: product.collection.publicHandle,
    _production_method: productionMethod,
    _customhouse_fee_key: feeKey,
    ...(previewUrl ? { _creator_preview_url: previewUrl } : {}),
    _customhouse_attribution: attribution,
    "Creator Design": product.title,
    "Creator": product.creator.displayName,
    "Color": setup.fixedColor,
    "Printing method": productionMethod,
    "Customized product acknowledgement": "Accepted",
    "Terms & Conditions": "Accepted",
  };
  const feeQuantity = quantity * setup.placementCount;
  const feeItem =
    surchargeMinor > 0n && feeVariantId
      ? {
          id: numericVariantId(feeVariantId),
          quantity: feeQuantity,
          properties: {
            _customhouse_production_fee: "true",
            _customhouse_parent_product_id: product.shopifyProductId,
            _customhouse_parent_project_id: orderProjectId,
            _customhouse_fee_key: feeKey,
            _pitchprint: orderProjectId,
            _production_method: productionMethod,
            _customhouse_creator_product_fee: "true",
            "Printing method": productionMethod,
            "Designed placements": String(setup.placementCount),
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
      fixedColor: setup.fixedColor,
      placementCount: setup.placementCount,
      surchargeMinor: surchargeMinor.toString(),
      feeVariantId: feeVariantId ? numericVariantId(feeVariantId) : null,
      feeQuantity,
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
) {
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
  await verifyNativeVariant(client, shopifyProductId, selectedVariantId);
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
  const orderProjectId = await cloner(product.pitchprintProjectId);
  const baseVariantId = baseVariantForPublishedVariant(product, selectedVariantId);
  return {
    variantId: numericVariantId(selectedVariantId),
    shopifyVariantId: selectedVariantId,
    quantity,
    properties: {
      _pitchprint: orderProjectId,
      _creator_product_id: product.id,
      _creator_id: product.creatorId,
      _creator_collection_id: collection.id,
      _customhouse_creator_handle: collection.publicHandle,
      _base_product_id: product.shopifyProductId,
      ...(baseVariantId ? { _base_variant_id: baseVariantId } : {}),
    },
    creatorProduct: {
      id: product.id,
      title: product.title,
      creatorId: product.creatorId,
      masterPitchPrintProjectId: product.pitchprintProjectId,
      nativeShopifyProductId: shopifyProductId,
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

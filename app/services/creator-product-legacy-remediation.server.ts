import db from "../db.server.ts";
import { classifyPublishedCreatorProduct } from "../../scripts/native-marketplace-audit-classifier.ts";
import { DomainError, safeJson } from "./domain.ts";
import {
  publishCreatorProductToShopify,
} from "./creator-product-publishing.server.ts";
import {
  PRODUCTION_METHODS,
  cleanProductionMethod,
  getEnabledProductionMethodsForProduct,
  listEnabledProductionMethodCodes,
  type ProductionMethodCode,
} from "./production-method-pricing.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";

export type LegacyVariantEvidence = {
  id: string;
  title: string;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type LegacyShopifyProductEvidence = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productOrigin: string | null;
  designMode: string | null;
  designStatus: string | null;
  productType: string | null;
  creatorId: string | null;
  creatorProductId: string | null;
  fixedColor: string | null;
  productionMethod: string | null;
  designedPlacementCount: string | null;
  creatorCartValidation: unknown | null;
  variants: LegacyVariantEvidence[];
};

export type LegacyProductRecord = {
  id: string;
  shop: string;
  creatorId: string;
  shopifyProductId: string;
  baseProductTitle: string;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  title: string;
  status: string;
  publishedShopifyProductId: string | null;
  designVariantSelectionsJson: string;
  createdAt: Date;
  updatedAt: Date;
  creator: {
    id: string;
    displayName: string;
    handle: string;
    status: string;
  };
  [key: string]: unknown;
};

export type LegacyRepairInput = {
  creatorProductId: unknown;
  fixedColor: unknown;
  productionMethod: unknown;
  placementCount: unknown;
  mappingProductId?: unknown;
  confirmMapping?: unknown;
  confirmApply?: unknown;
  republish?: unknown;
};

type LegacyRemediationDb = {
  creatorProduct: {
    findMany?(args: unknown): Promise<LegacyProductRecord[]>;
    findFirst(args: unknown): Promise<LegacyProductRecord | null>;
    update(args: unknown): Promise<LegacyProductRecord>;
  };
  productionMethodSetting?: {
    findMany(args: unknown): Promise<Array<{ method: string; enabled: boolean }>>;
  };
  creatorOrderItem?: {
    count(args: unknown): Promise<number>;
  };
  creatorSale?: {
    count?(args: unknown): Promise<number>;
    findMany?(args: unknown): Promise<Array<{ id?: string; creatorProductId?: string | null }>>;
  };
  referralEarning?: {
    count(args: unknown): Promise<number>;
  };
  payoutAllocation?: {
    count(args: unknown): Promise<number>;
    findMany?(args: unknown): Promise<Array<{ payoutId: string }>>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
  [key: string]: unknown;
};

type RepairDependencies = {
  database: LegacyRemediationDb;
  loadProductEvidence(
    productId: string,
    client: ShopifyGraphqlClient,
  ): Promise<LegacyShopifyProductEvidence | null>;
  findCanonicalCandidates(
    product: LegacyProductRecord,
    client: ShopifyGraphqlClient,
  ): Promise<LegacyShopifyProductEvidence[]>;
  publish(
    shop: string,
    creatorProductId: string,
    client: ShopifyGraphqlClient,
    database: LegacyRemediationDb,
  ): Promise<LegacyProductRecord>;
};

type LegacySetup = Record<string, unknown> & {
  fixedColor?: string;
  productionMethod?: string;
  fixedProductionMethod?: string;
  placementCount?: number;
};

function parseSetup(value: string): LegacySetup {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LegacySetup)
      : {};
  } catch {
    return {};
  }
}

function normalized(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("en");
}

function variantColor(variant: LegacyVariantEvidence) {
  return variant.selectedOptions.find((option) =>
    /^(color|colour|farg|färg|farbe|couleur|colore|kleur|kolor|cor)$/i.test(
      option.name.trim(),
    ),
  )?.value;
}

export function legacyProductColors(variants: LegacyVariantEvidence[]) {
  return [
    ...new Set(
      variants
        .map(variantColor)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function positivePlacementCount(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 20) {
    throw new DomainError(
      "LEGACY_PLACEMENT_COUNT_INVALID",
      "Placement count must be a positive integer between 1 and 20.",
      422,
    );
  }
  return number;
}

export function legacySetupDraft(
  product: LegacyProductRecord,
  input: Pick<LegacyRepairInput, "fixedColor" | "productionMethod" | "placementCount">,
  baseVariants: LegacyVariantEvidence[],
  enabledMethods: string[],
) {
  const requestedColor = String(input.fixedColor || "").trim();
  const colors = legacyProductColors(baseVariants);
  const fixedColor = colors.find(
    (color) => normalized(color) === normalized(requestedColor),
  );
  if (!fixedColor) {
    throw new DomainError(
      "LEGACY_FIXED_COLOR_INVALID",
      "Choose a color that exists on the current base product.",
      422,
    );
  }
  let productionMethod: ProductionMethodCode;
  try {
    productionMethod = cleanProductionMethod(input.productionMethod);
  } catch {
    throw new DomainError(
      "LEGACY_PRODUCTION_METHOD_INVALID",
      "Choose a valid printing method: Embroidery, DTF, or DTG.",
      422,
    );
  }
  const enabled = enabledMethods.map((method) => cleanProductionMethod(method));
  if (enabled.length && !enabled.includes(productionMethod)) {
    throw new DomainError(
      "LEGACY_PRODUCTION_METHOD_DISABLED",
      "Choose an enabled printing method.",
      422,
    );
  }
  const placementCount = positivePlacementCount(input.placementCount);
  const existing = parseSetup(product.designVariantSelectionsJson);
  return {
    ...existing,
    schema: "creator_design_setup_v1",
    flowMode: "CREATOR_DESIGN",
    interactionMode: "CREATOR_DESIGN",
    designMode: "creator_design",
    creatorContext: true,
    launchContext: "creator_dashboard",
    isCreatorProduct: true,
    fixedColor,
    selectedColors: [fixedColor],
    productionMethod,
    fixedProductionMethod: productionMethod,
    placementCount,
    legacyRemediatedAt: new Date().toISOString(),
  };
}

export function validateLegacyManualMapping(
  product: LegacyProductRecord,
  candidate: LegacyShopifyProductEvidence,
  mappedOwnerId: string | null,
  confirmed: boolean,
) {
  if (!confirmed) {
    throw new DomainError(
      "LEGACY_MAPPING_CONFIRMATION_REQUIRED",
      "Confirm Shopify product mapping before saving.",
      422,
    );
  }
  if (candidate.id === product.shopifyProductId) {
    throw new DomainError(
      "LEGACY_MAPPING_BASE_PRODUCT_FORBIDDEN",
      "The global/base product cannot be selected as a Creator mapping.",
      422,
    );
  }
  if (mappedOwnerId && mappedOwnerId !== product.id) {
    throw new DomainError(
      "LEGACY_MAPPING_ALREADY_USED",
      "This Shopify product is already mapped to another CreatorProduct.",
      409,
    );
  }
  if (
    candidate.productOrigin !== "creator" ||
    candidate.designMode !== "buy_only" ||
    candidate.productType !== "creator_fixed"
  ) {
    throw new DomainError(
      "LEGACY_MAPPING_NOT_CREATOR_PRODUCT",
      "The selected Shopify product is not a canonical Creator buy-only product.",
      422,
    );
  }
  if (
    (candidate.creatorId && candidate.creatorId !== product.creatorId) ||
    (candidate.creatorProductId && candidate.creatorProductId !== product.id) ||
    (!candidate.creatorId && candidate.creatorProductId !== product.id)
  ) {
    throw new DomainError(
      "LEGACY_MAPPING_CREATOR_MISMATCH",
      "The selected Shopify product does not belong to the correct Creator context.",
      422,
    );
  }
  return candidate.id;
}

function currentSetup(product: LegacyProductRecord) {
  const setup = parseSetup(product.designVariantSelectionsJson);
  return {
    fixedColor:
      typeof setup.fixedColor === "string" && setup.fixedColor.trim()
        ? setup.fixedColor
        : null,
    productionMethod:
      typeof setup.productionMethod === "string" && setup.productionMethod.trim()
        ? setup.productionMethod
        : typeof setup.fixedProductionMethod === "string" &&
            setup.fixedProductionMethod.trim()
          ? setup.fixedProductionMethod
          : null,
    placementCount:
      Number.isSafeInteger(Number(setup.placementCount)) &&
      Number(setup.placementCount) > 0
        ? Number(setup.placementCount)
        : null,
    copyrightAccepted: setup.copyrightAccepted === true,
  };
}

export function classifyLegacyCompatibility(
  product: LegacyProductRecord,
  evidence: LegacyShopifyProductEvidence | null,
) {
  const setup = currentSetup(product);
  if (!product.publishedShopifyProductId) {
    const missingFields = [
      !setup.fixedColor ? "fixedColor" : null,
      !setup.productionMethod ? "fixedProductionMethod" : null,
      !setup.placementCount ? "placementCount" : null,
    ].filter((value): value is string => Boolean(value));
    return {
      status: "MISSING_MAPPING" as const,
      missingFields: ["publishedShopifyProductId", ...missingFields],
      reason: "Published CreatorProduct has no mapped Shopify product.",
    };
  }
  const classification = classifyPublishedCreatorProduct({
    creatorProductId: product.id,
    shopifyProductId: product.publishedShopifyProductId,
    fixedColor: setup.fixedColor,
    fixedProductionMethod: setup.productionMethod,
    placementCount: setup.placementCount,
    shopifyProduct: evidence
      ? {
          variants: evidence.variants.map((variant) => ({
            id: variant.id,
            selectedOptions: variant.selectedOptions,
          })),
          productOrigin: evidence.productOrigin,
          designMode: evidence.designMode,
          designStatus: evidence.designStatus,
          productType: evidence.productType,
          creatorProductId: evidence.creatorProductId,
          fixedColor: evidence.fixedColor,
          productionMethod: evidence.productionMethod,
          designedPlacementCount: evidence.designedPlacementCount,
          creatorCartValidation: evidence.creatorCartValidation,
        }
      : null,
  });
  return {
    status:
      classification.category === "OK"
        ? ("COMPATIBLE" as const)
        : ("NEEDS_REPAIR" as const),
    missingFields: classification.issues,
    reason:
      classification.issues.join("; ") ||
      "Creator product is compatible with checkout validation.",
  };
}

export function compatibilityReady(input: {
  needsRepair: number;
  missingMapping: number;
}) {
  return input.needsRepair === 0 && input.missingMapping === 0;
}

function evidenceFields() {
  return `
    id title handle status
    productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
    designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
    designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
    productType: metafield(namespace: "customhouse", key: "product_type") { value }
    creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
    creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
    fixedColor: metafield(namespace: "customhouse", key: "fixed_color") { value }
    productionMethod: metafield(namespace: "customhouse", key: "production_method") { value }
    designedPlacementCount: metafield(namespace: "customhouse", key: "designed_placement_count") { value }
    creatorCartValidation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
    variants(first: 250) {
      nodes { id title availableForSale selectedOptions { name value } }
    }
  `;
}

type RawEvidence = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productOrigin: { value: string } | null;
  designMode: { value: string } | null;
  designStatus: { value: string } | null;
  productType: { value: string } | null;
  creatorId: { value: string } | null;
  creatorProductId: { value: string } | null;
  fixedColor: { value: string } | null;
  productionMethod: { value: string } | null;
  designedPlacementCount: { value: string } | null;
  creatorCartValidation: { jsonValue: unknown } | null;
  variants: { nodes: LegacyVariantEvidence[] };
};

function normalizedEvidence(product: RawEvidence): LegacyShopifyProductEvidence {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    productOrigin: product.productOrigin?.value || null,
    designMode: product.designMode?.value || null,
    designStatus: product.designStatus?.value || null,
    productType: product.productType?.value || null,
    creatorId: product.creatorId?.value || null,
    creatorProductId: product.creatorProductId?.value || null,
    fixedColor: product.fixedColor?.value || null,
    productionMethod: product.productionMethod?.value || null,
    designedPlacementCount: product.designedPlacementCount?.value || null,
    creatorCartValidation: product.creatorCartValidation?.jsonValue ?? null,
    variants: product.variants.nodes,
  };
}

async function loadProductEvidence(
  productId: string,
  client: ShopifyGraphqlClient,
) {
  const result = await client.request<{ product: RawEvidence | null }>(
    `#graphql query LegacyCreatorProductEvidence($id: ID!) {
      product(id: $id) { ${evidenceFields()} }
    }`,
    { id: productId },
  );
  return result.product ? normalizedEvidence(result.product) : null;
}

async function findCanonicalCandidates(
  product: LegacyProductRecord,
  client: ShopifyGraphqlClient,
) {
  const result = await client.request<{ products: { nodes: RawEvidence[] } }>(
    `#graphql query LegacyCreatorProductCandidates($query: String!) {
      products(first: 20, query: $query) { nodes { ${evidenceFields()} } }
    }`,
    { query: `metafields.customhouse.creator_product_id:${product.id}` },
  );
  return result.products.nodes.map(normalizedEvidence);
}

const defaultDependencies: RepairDependencies = {
  database: db as unknown as LegacyRemediationDb,
  loadProductEvidence,
  findCanonicalCandidates,
  publish: (shop, creatorProductId, client, database) =>
    publishCreatorProductToShopify(
      shop,
      creatorProductId,
      client,
      database as never,
    ) as unknown as Promise<LegacyProductRecord>,
};

function checked(value: unknown) {
  return value === true || value === "true" || value === "1" || value === "on";
}

export async function applyLegacyCreatorProductRepair(
  shop: string,
  adminId: string | null,
  input: LegacyRepairInput,
  client: ShopifyGraphqlClient,
  dependencies: RepairDependencies = defaultDependencies,
) {
  if (!checked(input.confirmApply)) {
    throw new DomainError(
      "LEGACY_REPAIR_CONFIRMATION_REQUIRED",
      "Confirm Apply repair before changing this CreatorProduct.",
      422,
    );
  }
  const creatorProductId = String(input.creatorProductId || "").trim();
  const product = await dependencies.database.creatorProduct.findFirst({
    where: { id: creatorProductId, shop },
    include: { creator: true },
  });
  if (!product) {
    throw new DomainError(
      "CREATOR_PRODUCT_NOT_FOUND",
      "CreatorProduct was not found.",
      404,
    );
  }
  if (product.status !== "PUBLISHED" || product.creator.status !== "APPROVED") {
    throw new DomainError(
      "LEGACY_PRODUCT_NOT_LIVE",
      "Only published products for approved Creators can be repaired.",
      409,
    );
  }
  const base = await dependencies.loadProductEvidence(
    product.shopifyProductId,
    client,
  );
  if (!base) {
    throw new DomainError(
      "BASE_PRODUCT_NOT_FOUND",
      "The associated base product no longer exists.",
      409,
    );
  }
  const enabledMethods = dependencies.database.publicProductProductionPricing
    ? (await getEnabledProductionMethodsForProduct(
        shop,
        product.shopifyProductId,
        dependencies.database as never,
      )).map((method) => method.id)
    : dependencies.database.productionMethodSetting
      ? await listEnabledProductionMethodCodes(shop, dependencies.database as never)
    : [...PRODUCTION_METHODS];
  const setup = legacySetupDraft(product, input, base.variants, enabledMethods);
  const oldMapping = product.publishedShopifyProductId;
  const republish = checked(input.republish);
  if (oldMapping === product.shopifyProductId) {
    throw new DomainError(
      "LEGACY_MAPPING_BASE_PRODUCT_FORBIDDEN",
      "The current mapping points to the global/base product and cannot be repaired automatically. Select the correct Creator-specific product.",
      409,
    );
  }
  const requestedMapping = String(input.mappingProductId || "").trim() || null;
  if (requestedMapping && republish) {
    throw new DomainError(
      "LEGACY_MAPPING_REPUBLISH_CONFLICT",
      "Choose either an existing Shopify product mapping or Republish product, not both.",
      422,
    );
  }
  let mapping = oldMapping;
  let mappingEvidence: LegacyShopifyProductEvidence | null = null;
  if (requestedMapping && requestedMapping !== oldMapping) {
    mappingEvidence = await dependencies.loadProductEvidence(
      requestedMapping,
      client,
    );
    if (!mappingEvidence) {
      throw new DomainError(
        "LEGACY_MAPPING_NOT_FOUND",
        "The selected Shopify product was not found.",
        404,
      );
    }
    const mappedElsewhere = await dependencies.database.creatorProduct.findFirst({
      where: {
        shop,
        publishedShopifyProductId: requestedMapping,
        NOT: { id: product.id },
      },
      select: { id: true },
    });
    mapping = validateLegacyManualMapping(
      product,
      mappingEvidence,
      mappedElsewhere?.id || null,
      checked(input.confirmMapping),
    );
  }
  if (mapping && !mappingEvidence) {
    mappingEvidence = await dependencies.loadProductEvidence(mapping, client);
  }
  if (mappingEvidence?.productOrigin === "global") {
    throw new DomainError(
      "LEGACY_MAPPING_GLOBAL_PRODUCT_FORBIDDEN",
      "A global Shopify product cannot be synchronized as a Creator product.",
      409,
    );
  }
  if (republish && !requestedMapping && oldMapping) {
    if (mappingEvidence) {
      throw new DomainError(
        "LEGACY_EXISTING_PRODUCT_REQUIRES_MAPPING",
        "The currently mapped Shopify product still exists. Repair that product instead of creating a duplicate.",
        409,
      );
    }
    mapping = null;
  }
  if (mapping && !mappingEvidence) {
    throw new DomainError(
      "LEGACY_MAPPING_NOT_FOUND",
      "The mapped Shopify product was not found. Review the mapping or explicitly choose Republish product.",
      409,
    );
  }
  if (!mapping && !republish) {
    throw new DomainError(
      "LEGACY_MAPPING_OR_REPUBLISH_REQUIRED",
      "Select an existing Creator Shopify product or choose Republish product.",
      422,
    );
  }
  if (!mapping && republish) {
    if (!product.pitchprintProjectId) {
      throw new DomainError(
        "LEGACY_SAVED_DESIGN_IDENTITY_REQUIRED",
        "Republishing through the canonical service requires the existing saved project identity.",
        409,
      );
    }
    const candidates = await dependencies.findCanonicalCandidates(product, client);
    if (candidates.some((candidate) => candidate.id !== product.shopifyProductId)) {
      throw new DomainError(
        "LEGACY_EXISTING_PRODUCT_REQUIRES_MAPPING",
        "An existing canonical Creator product was found. Confirm that mapping instead of creating a duplicate.",
        409,
      );
    }
  }
  const updated = await dependencies.database.creatorProduct.update({
    where: { id: product.id },
    data: {
      designVariantSelectionsJson: safeJson(setup),
      ...(mapping ? { publishedShopifyProductId: mapping } : {}),
    },
  });
  const published = await dependencies.publish(
    shop,
    product.id,
    client,
    dependencies.database,
  );
  const finalMapping = published.publishedShopifyProductId || mapping;
  if (mapping && mapping !== oldMapping) {
    await dependencies.database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.mapping_restored",
        entityType: "CreatorProduct",
        entityId: product.id,
        beforeJson: safeJson({ publishedShopifyProductId: oldMapping }),
        afterJson: safeJson({ publishedShopifyProductId: finalMapping }),
      },
    });
  }
  if (republish) {
    await dependencies.database.auditLog?.create({
      data: {
        shop,
        actorType: "ADMIN",
        actorId: adminId,
        action: "creator_product.republished",
        entityType: "CreatorProduct",
        entityId: product.id,
        beforeJson: safeJson({ publishedShopifyProductId: null }),
        afterJson: safeJson({ publishedShopifyProductId: finalMapping }),
      },
    });
  }
  await dependencies.database.auditLog?.create({
    data: {
      shop,
      actorType: "ADMIN",
      actorId: adminId,
      action: "creator_product.legacy_repaired",
      entityType: "CreatorProduct",
      entityId: product.id,
      beforeJson: safeJson({
        publishedShopifyProductId: oldMapping,
        setup: currentSetup(product),
      }),
      afterJson: safeJson({
        publishedShopifyProductId: finalMapping,
        fixedColor: setup.fixedColor,
        productionMethod: setup.productionMethod,
        placementCount: setup.placementCount,
      }),
    },
  });
  const finalEvidence = finalMapping
    ? await dependencies.loadProductEvidence(finalMapping, client)
    : null;
  const finalProduct = {
    ...updated,
    ...published,
    publishedShopifyProductId: finalMapping,
  } as LegacyProductRecord;
  return {
    product: finalProduct,
    compatibility: classifyLegacyCompatibility(finalProduct, finalEvidence),
  };
}

async function loadMappedEvidence(
  productIds: string[],
  client: ShopifyGraphqlClient,
) {
  const evidence = new Map<string, LegacyShopifyProductEvidence>();
  for (let index = 0; index < productIds.length; index += 25) {
    const ids = productIds.slice(index, index + 25);
    const result = await client.request<{ nodes: Array<RawEvidence | null> }>(
      `#graphql query LegacyCreatorMappedProducts($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Product { ${evidenceFields()} } }
      }`,
      { ids },
    );
    for (const product of result.nodes) {
      if (product) evidence.set(product.id, normalizedEvidence(product));
    }
  }
  return evidence;
}

export async function listLegacyCompatibilityRecords(
  shop: string,
  client: ShopifyGraphqlClient,
  database: LegacyRemediationDb = db as unknown as LegacyRemediationDb,
) {
  if (!database.creatorProduct.findMany) return { records: [], summary: { compatible: 0, needsRepair: 0, missingMapping: 0, manualReview: 0, ready: true } };
  const products = await database.creatorProduct.findMany({
    where: { shop, status: "PUBLISHED" },
    include: { creator: true, _count: { select: { orderItems: true } } },
    orderBy: [{ createdAt: "asc" }],
  });
  const mappedIds = products
    .map((product) => product.publishedShopifyProductId)
    .filter((value): value is string => Boolean(value));
  const mappedEvidence = await loadMappedEvidence(mappedIds, client);
  const saleRows = database.creatorSale?.findMany
    ? await database.creatorSale.findMany({
        where: { shop, creatorProductId: { in: products.map((product) => product.id) } },
        select: { creatorProductId: true },
      })
    : [];
  const salesByProduct = new Map<string, number>();
  for (const sale of saleRows) {
    if (!sale.creatorProductId) continue;
    salesByProduct.set(
      sale.creatorProductId,
      (salesByProduct.get(sale.creatorProductId) || 0) + 1,
    );
  }
  const records = products.map((product) => {
    const compatibility = classifyLegacyCompatibility(
      product,
      product.publishedShopifyProductId
        ? mappedEvidence.get(product.publishedShopifyProductId) || null
        : null,
    );
    const setup = currentSetup(product);
    const orderCount = Number(
      (product as LegacyProductRecord & { _count?: { orderItems?: number } })._count
        ?.orderItems || 0,
    );
    const saleCount = salesByProduct.get(product.id) || 0;
    return {
      id: product.id,
      creator: product.creator,
      title: product.title,
      status: product.status,
      baseProductId: product.shopifyProductId,
      baseProductTitle: product.baseProductTitle,
      publishedShopifyProductId: product.publishedShopifyProductId,
      setup,
      orderCount,
      saleCount,
      hasFinancialHistory: orderCount > 0 || saleCount > 0,
      compatibility,
      createdAt: product.createdAt,
    };
  });
  const summary = {
    compatible: records.filter((record) => record.compatibility.status === "COMPATIBLE").length,
    needsRepair: records.filter((record) => record.compatibility.status === "NEEDS_REPAIR").length,
    missingMapping: records.filter((record) => record.compatibility.status === "MISSING_MAPPING").length,
    manualReview: records.filter((record) => record.compatibility.status === "MISSING_MAPPING").length,
    ready: false,
  };
  summary.ready = compatibilityReady(summary);
  return { records, summary };
}

export async function getLegacyRepairDetail(
  shop: string,
  creatorProductId: string,
  client: ShopifyGraphqlClient,
  database: LegacyRemediationDb = db as unknown as LegacyRemediationDb,
) {
  const product = await database.creatorProduct.findFirst({
    where: { id: creatorProductId, shop },
    include: { creator: true },
  });
  if (!product) {
    throw new DomainError("CREATOR_PRODUCT_NOT_FOUND", "CreatorProduct was not found.", 404);
  }
  const [baseProduct, publishedProduct, candidates, orderCount, sales] = await Promise.all([
    loadProductEvidence(product.shopifyProductId, client),
    product.publishedShopifyProductId
      ? loadProductEvidence(product.publishedShopifyProductId, client)
      : Promise.resolve(null),
    findCanonicalCandidates(product, client),
    database.creatorOrderItem?.count({ where: { shop, creatorProductId: product.id } }) || 0,
    database.creatorSale?.findMany
      ? database.creatorSale.findMany({
          where: { shop, creatorProductId: product.id },
          select: { id: true },
        })
      : [],
  ]);
  const saleIds = sales.map((sale) => sale.id).filter((id): id is string => Boolean(id));
  const [earningCount, payoutAllocations] = await Promise.all([
    saleIds.length && database.referralEarning
      ? database.referralEarning.count({ where: { shop, creatorSaleId: { in: saleIds } } })
      : 0,
    saleIds.length && database.payoutAllocation?.findMany
      ? database.payoutAllocation.findMany({
          where: { shop, sourceType: "PRODUCT_EARNING", sourceId: { in: saleIds } },
          select: { payoutId: true },
        })
      : [],
  ]);
  const payoutCount = new Set(payoutAllocations.map((allocation) => allocation.payoutId)).size;
  return {
    product,
    currentSetup: currentSetup(product),
    compatibility: classifyLegacyCompatibility(product, publishedProduct),
    baseProduct,
    publishedProduct,
    candidates,
    availableColors: baseProduct ? legacyProductColors(baseProduct.variants) : [],
    enabledMethods: database.publicProductProductionPricing
      ? (await getEnabledProductionMethodsForProduct(
          shop,
          product.shopifyProductId,
          database as never,
        )).map((method) => method.id)
      : database.productionMethodSetting
        ? await listEnabledProductionMethodCodes(shop, database as never)
        : [...PRODUCTION_METHODS],
    dependencies: {
      orders: Number(orderCount),
      creatorOrderItems: Number(orderCount),
      sales: sales.length,
      earnings: sales.length + Number(earningCount),
      payouts: payoutCount,
      payoutAllocations: payoutAllocations.length,
      hasFinancialHistory:
        Number(orderCount) > 0 ||
        sales.length > 0 ||
        Number(earningCount) > 0 ||
        payoutAllocations.length > 0,
    },
  };
}

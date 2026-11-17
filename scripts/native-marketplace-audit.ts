import db from "../app/db.server";
import { readFileSync } from "node:fs";
import { unauthenticated } from "../app/shopify.server";
import { AdminGraphqlClient } from "../app/services/shopify-graphql.server";
import {
  auditProductIdFromArgs,
  classifyMissingMappingRecord,
  classifyPublishedCreatorProduct,
  type NativeProductCandidate,
  type PublishedCreatorProductAuditCategory,
} from "./native-marketplace-audit-classifier.ts";

type CandidateCollection = {
  id: string;
  handle: string;
  title: string;
  creatorId: { value: string } | null;
  creatorCollectionId: { value: string } | null;
  productsCount: { count: number };
};

type ProductCustomizationState = {
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
  creatorHandle: { value: string } | null;
  fixedColor: { value: string } | null;
  productionMethod: { value: string } | null;
  designedPlacementCount: { value: string } | null;
  baseProductId: { value: string } | null;
  creatorCartValidation: { jsonValue: unknown } | null;
  pitchprintDesignId: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  inkybayEnabled: { value: string } | null;
  legacyPitchprintDesignId: { value: string } | null;
  legacyPitchprintEnabled: { value: string } | null;
  legacyInkybayEnabled: { value: string } | null;
  variants: Array<{
    id: string;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

type NativeShopifyProductCandidateState = Omit<
  ProductCustomizationState,
  | "variants"
  | "pitchprintDesignId"
  | "pitchprintEnabled"
  | "inkybayEnabled"
  | "legacyPitchprintDesignId"
  | "legacyPitchprintEnabled"
  | "legacyInkybayEnabled"
> & {
  publishedOnPublication: boolean;
};

type ProductCustomizationStatePage = Omit<ProductCustomizationState, "variants"> & {
  variants: {
    nodes: ProductCustomizationState["variants"];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type CreatorProductAuditReport = {
  creatorProductId: string;
  shopifyProductId: string | null;
  category: PublishedCreatorProductAuditCategory;
  missingMappingClassification: ReturnType<
    typeof classifyMissingMappingRecord
  > | null;
  [key: string]: unknown;
};

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1]!.trim()]) {
        process.env[match[1]!.trim()] = match[2]!;
      }
    }
  } catch {
    // Runtime environments can provide env vars directly.
  }
}

function collectionUrl(handle: string | null | undefined) {
  return handle ? `/collections/${encodeURIComponent(handle)}` : null;
}

async function collectionDetails(
  client: AdminGraphqlClient,
  collectionId: string | null | undefined,
  productIds: string[],
) {
  if (!collectionId) return null;
  const result = await client.request<{
    collection: (CandidateCollection & {
      publishedOnPublication: boolean;
      products: {
        nodes: NativeShopifyProductCandidateState[];
        pageInfo: { hasNextPage: boolean };
      };
    }) | null;
  }>(
    `#graphql query NativeMarketplaceCollectionDetails(
      $id: ID!,
      $publicationId: ID!
    ) {
      collection(id: $id) {
        id
        handle
        title
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        productsCount { count }
        publishedOnPublication(publicationId: $publicationId)
        products(first: 250) {
          nodes {
            id title handle status
            publishedOnPublication(publicationId: $publicationId)
            productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
            designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
            designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
            productType: metafield(namespace: "customhouse", key: "product_type") { value }
            creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
            creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
            creatorHandle: metafield(namespace: "customhouse", key: "creator_handle") { value }
            fixedColor: metafield(namespace: "customhouse", key: "fixed_color") { value }
            productionMethod: metafield(namespace: "customhouse", key: "production_method") { value }
            designedPlacementCount: metafield(namespace: "customhouse", key: "designed_placement_count") { value }
            baseProductId: metafield(namespace: "customhouse", key: "base_product_id") { value }
            creatorCartValidation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
          }
          pageInfo { hasNextPage }
        }
      }
    }`,
    {
      id: collectionId,
      publicationId: process.env.ONLINE_STORE_PUBLICATION_ID || "",
    },
  );
  const productSet = new Set(result.collection?.products.nodes.map((item) => item.id));
  return result.collection
    ? {
        ...result.collection,
        candidateDiscoveryComplete: !result.collection.products.pageInfo.hasNextPage,
        expectedProductsPresent: productIds.filter((id) => productSet.has(id)),
        expectedProductsMissing: productIds.filter((id) => !productSet.has(id)),
      }
    : null;
}

async function searchedProductCandidates(
  client: AdminGraphqlClient,
  creatorProductId: string,
  storedHandle: string | null,
) {
  const searches = [
    `metafields.customhouse.creator_product_id:${creatorProductId}`,
    storedHandle ? `handle:${storedHandle}` : null,
  ].filter((value): value is string => Boolean(value));
  const candidates = new Map<string, NativeShopifyProductCandidateState>();
  const warnings: string[] = [];
  for (const query of searches) {
    try {
      const result = await client.request<{
        products: { nodes: NativeShopifyProductCandidateState[] };
      }>(
        `#graphql query NativeMarketplaceProductCandidates(
          $query: String!,
          $publicationId: ID!
        ) {
          products(first: 50, query: $query) {
            nodes {
              id title handle status
              publishedOnPublication(publicationId: $publicationId)
              productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
              designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
              designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
              productType: metafield(namespace: "customhouse", key: "product_type") { value }
              creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
              creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
              creatorHandle: metafield(namespace: "customhouse", key: "creator_handle") { value }
              fixedColor: metafield(namespace: "customhouse", key: "fixed_color") { value }
              productionMethod: metafield(namespace: "customhouse", key: "production_method") { value }
              designedPlacementCount: metafield(namespace: "customhouse", key: "designed_placement_count") { value }
              baseProductId: metafield(namespace: "customhouse", key: "base_product_id") { value }
              creatorCartValidation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
            }
          }
        }`,
        {
          query,
          publicationId: process.env.ONLINE_STORE_PUBLICATION_ID || "",
        },
      );
      for (const item of result.products.nodes) candidates.set(item.id, item);
    } catch {
      warnings.push(
        query.startsWith("handle:")
          ? "stored-handle candidate search was unavailable"
          : "canonical creator_product_id candidate search was unavailable",
      );
    }
  }
  return { candidates: [...candidates.values()], warnings };
}

function normalizedCandidate(
  candidate: NativeShopifyProductCandidateState,
): NativeProductCandidate & Record<string, unknown> {
  return {
    id: candidate.id,
    title: candidate.title,
    handle: candidate.handle,
    status: candidate.status,
    publishedOnPublication: candidate.publishedOnPublication,
    productOrigin: candidate.productOrigin?.value || null,
    designMode: candidate.designMode?.value || null,
    designStatus: candidate.designStatus?.value || null,
    productType: candidate.productType?.value || null,
    creatorId: candidate.creatorId?.value || null,
    creatorProductId: candidate.creatorProductId?.value || null,
    creatorHandle: candidate.creatorHandle?.value || null,
    fixedColor: candidate.fixedColor?.value || null,
    productionMethod: candidate.productionMethod?.value || null,
    designedPlacementCount: candidate.designedPlacementCount?.value || null,
    baseProductId: candidate.baseProductId?.value || null,
    creatorCartValidation: candidate.creatorCartValidation?.jsonValue ?? null,
  };
}

async function canonicalCandidates(
  client: AdminGraphqlClient,
  creatorId: string,
  creatorCollectionId: string,
) {
  const result = await client.request<{
    byCollection: { nodes: CandidateCollection[] };
    byCreator: { nodes: CandidateCollection[] };
  }>(
    `#graphql query NativeMarketplaceCanonicalCandidates($collectionQuery: String!, $creatorQuery: String!) {
      byCollection: collections(first: 10, query: $collectionQuery) {
        nodes {
          id handle title productsCount { count }
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
      byCreator: collections(first: 10, query: $creatorQuery) {
        nodes {
          id handle title productsCount { count }
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
    }`,
    {
      collectionQuery: `metafields.customhouse.creator_collection_id:${creatorCollectionId}`,
      creatorQuery: `metafields.customhouse.creator_id:${creatorId}`,
    },
  );
  const byId = new Map<string, CandidateCollection>();
  for (const item of [...result.byCollection.nodes, ...result.byCreator.nodes]) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function titleCandidates(client: AdminGraphqlClient, name: string) {
  const terms = [
    name,
    `${name} Designs`,
    `Designs by ${name}`,
  ];
  const found = new Map<string, CandidateCollection>();
  for (const term of terms) {
    const result = await client.request<{
      collections: { nodes: CandidateCollection[] };
    }>(
      `#graphql query NativeMarketplaceTitleCandidates($query: String!) {
        collections(first: 20, query: $query) {
          nodes {
            id handle title productsCount { count }
            creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
            creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
          }
        }
      }`,
      { query: `title:*${term}*` },
    );
    for (const item of result.collections.nodes) found.set(item.id, item);
  }
  return [...found.values()];
}

async function productCustomizationState(
  client: AdminGraphqlClient,
  productId: string,
) {
  const variants: ProductCustomizationState["variants"] = [];
  let cursor: string | null = null;
  let productState: Omit<ProductCustomizationState, "variants"> | null = null;
  do {
    const result: { product: ProductCustomizationStatePage | null } =
      await client.request(
    `#graphql query NativeMarketplaceProductCustomizationState($id: ID!, $cursor: String) {
      product(id: $id) {
        id
        title
        handle
        status
        productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
        creatorHandle: metafield(namespace: "customhouse", key: "creator_handle") { value }
        fixedColor: metafield(namespace: "customhouse", key: "fixed_color") { value }
        productionMethod: metafield(namespace: "customhouse", key: "production_method") { value }
        designedPlacementCount: metafield(namespace: "customhouse", key: "designed_placement_count") { value }
        baseProductId: metafield(namespace: "customhouse", key: "base_product_id") { value }
        creatorCartValidation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        legacyPitchprintEnabled: metafield(namespace: "pitchprint", key: "enabled") { value }
        legacyInkybayEnabled: metafield(namespace: "inkybay", key: "enabled") { value }
        variants(first: 250, after: $cursor) {
          nodes { id selectedOptions { name value } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { id: productId, cursor },
      );
    if (!result.product) return null;
    const { variants: variantPage, ...state } = result.product;
    productState = state;
    variants.push(...variantPage.nodes);
    cursor = variantPage.pageInfo.hasNextPage
      ? variantPage.pageInfo.endCursor
      : null;
  } while (cursor);
  return productState ? { ...productState, variants } : null;
}

function creatorSetup(value: string) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        fixedColor: null,
        fixedProductionMethod: null,
        placementCount: null,
      };
    }
    const setup = parsed as Record<string, unknown>;
    return {
      fixedColor:
        typeof setup.fixedColor === "string" ? setup.fixedColor : null,
      fixedProductionMethod:
        typeof setup.productionMethod === "string"
          ? setup.productionMethod
          : typeof setup.fixedProductionMethod === "string"
            ? setup.fixedProductionMethod
            : null,
      placementCount:
        Number.isInteger(setup.placementCount) && Number(setup.placementCount) > 0
          ? Number(setup.placementCount)
          : Number.isInteger(setup.designedPlacementCount) &&
              Number(setup.designedPlacementCount) > 0
            ? Number(setup.designedPlacementCount)
            : null,
    };
  } catch {
    return {
      fixedColor: null,
      fixedProductionMethod: null,
      placementCount: null,
    };
  }
}

function previewPresent(previewUrl: string | null, previewUrls: string) {
  if (previewUrl?.startsWith("https://")) return true;
  try {
    const parsed = JSON.parse(previewUrls || "[]");
    return (
      Array.isArray(parsed) &&
      parsed.some(
        (value) => typeof value === "string" && value.startsWith("https://"),
      )
    );
  } catch {
    return false;
  }
}

async function main() {
  loadEnvFile();
  if (!process.env.SHOPIFY_APP_URL?.startsWith("https://")) {
    process.env.SHOPIFY_APP_URL = "https://custom-house.vercel.app";
  }
  const shop =
    process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7) ||
    process.env.SHOP;
  if (!shop) throw new Error("Pass --shop=<myshopify-domain>.");
  const onlyCreator = process.argv.find((arg) => arg.startsWith("--creator="))?.slice(10);
  const onlyProduct = auditProductIdFromArgs(process.argv);
  const titleSearch = process.argv.find((arg) => arg.startsWith("--title-search="))?.slice(15);
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { onlineStorePublicationId: true },
  });
  if (config?.onlineStorePublicationId) {
    process.env.ONLINE_STORE_PUBLICATION_ID = config.onlineStorePublicationId;
  }
  const { admin } = await unauthenticated.admin(shop);
  const client = new AdminGraphqlClient(admin);
  const creators = await db.creator.findMany({
    where: {
      shop,
      status: "APPROVED",
      ...(onlyCreator
        ? {
            OR: [
              { id: onlyCreator },
              { handle: onlyCreator },
              { displayName: { contains: onlyCreator, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(onlyProduct
        ? { creatorProducts: { some: { id: onlyProduct, status: "PUBLISHED" } } }
        : {}),
    },
    select: {
      id: true,
      displayName: true,
      handle: true,
      status: true,
      collectionId: true,
      marketplaceCollection: true,
      creatorProducts: {
        where: {
          status: "PUBLISHED",
          ...(onlyProduct ? { id: onlyProduct } : {}),
        },
        select: {
          id: true,
          title: true,
          status: true,
          shopifyProductId: true,
          publishedShopifyProductId: true,
          publishedShopifyProductHandle: true,
          publishedShopifyProductUrl: true,
          pitchprintProjectId: true,
          pitchprintDesignId: true,
          previewUrl: true,
          previewUrls: true,
          designVariantSelectionsJson: true,
          createdAt: true,
          updatedAt: true,
          publishedAt: true,
          _count: { select: { orderItems: true } },
        },
      },
    },
    orderBy: { displayName: "asc" },
  });
  const auditedProductIds = creators.flatMap((creator) =>
    creator.creatorProducts.map((product) => product.id),
  );
  const saleRows = auditedProductIds.length
    ? await db.creatorSale.findMany({
        where: {
          shop,
          creatorProductId: { in: auditedProductIds },
        },
        select: { creatorProductId: true },
      })
    : [];
  const saleCounts = new Map<string, number>();
  for (const sale of saleRows) {
    if (!sale.creatorProductId) continue;
    saleCounts.set(
      sale.creatorProductId,
      (saleCounts.get(sale.creatorProductId) || 0) + 1,
    );
  }
  let inconsistent = 0;
  const creatorReports = [];
  const creatorProductReports: CreatorProductAuditReport[] = [];
  const productCategoryCounts: Record<PublishedCreatorProductAuditCategory, number> = {
    OK: 0,
    NEEDS_REPUBLISH: 0,
    NEEDS_REPAIR: 0,
    MISSING_MAPPING: 0,
  };
  for (const creator of creators) {
    const collection = creator.marketplaceCollection;
    const productIds = creator.creatorProducts
      .map((product) => product.publishedShopifyProductId)
      .filter((id): id is string => Boolean(id));
    const details = await collectionDetails(
      client,
      collection?.shopifyCollectionId,
      productIds,
    );
    const candidates = collection
      ? await canonicalCandidates(client, creator.id, collection.id)
      : [];
    const duplicateCanonicalCandidates = candidates.filter(
      (item) =>
        item.creatorId?.value === creator.id ||
        item.creatorCollectionId?.value === collection?.id,
    );
    const canonicalCandidateIds = duplicateCanonicalCandidates.map((item) => item.id);
    const issues = [
      !collection ? "missing CreatorCollection row" : null,
      collection && !collection.shopifyCollectionId
        ? "missing canonical Shopify collection mapping"
        : null,
      details && details.creatorId?.value !== creator.id
        ? "canonical Shopify collection creator_id mismatch"
        : null,
      details && details.creatorCollectionId?.value !== collection?.id
        ? "canonical Shopify collection creator_collection_id mismatch"
        : null,
      details?.expectedProductsMissing.length
        ? "published native products missing from canonical collection"
        : null,
      canonicalCandidateIds.length > 1
        ? "multiple canonical-metafield collection candidates"
        : null,
    ].filter(Boolean);
    if (issues.length) inconsistent += 1;
    for (const product of creator.creatorProducts) {
      const setup = creatorSetup(product.designVariantSelectionsJson);
      const state = product.publishedShopifyProductId
        ? await productCustomizationState(client, product.publishedShopifyProductId)
        : null;
      const searchedCandidates = product.publishedShopifyProductId
        ? { candidates: [], warnings: [] }
        : await searchedProductCandidates(
            client,
            product.id,
            product.publishedShopifyProductHandle,
          );
      const candidateById = new Map<string, NativeShopifyProductCandidateState>();
      for (const candidate of [
        ...(details?.products.nodes || []),
        ...searchedCandidates.candidates,
      ]) {
        candidateById.set(candidate.id, candidate);
      }
      const productTitle = product.title.trim().toLocaleLowerCase("en");
      const relevantCandidates = [...candidateById.values()].filter(
        (candidate) =>
          candidate.creatorProductId?.value === product.id ||
          (Boolean(product.publishedShopifyProductHandle) &&
            candidate.handle === product.publishedShopifyProductHandle) ||
          (candidate.creatorId?.value === creator.id &&
            candidate.title.trim().toLocaleLowerCase("en") === productTitle),
      );
      const nativeShopifyProductCandidates = relevantCandidates.map(
        normalizedCandidate,
      );
      const classification = classifyPublishedCreatorProduct({
        creatorProductId: product.id,
        shopifyProductId: product.publishedShopifyProductId,
        fixedColor: setup.fixedColor,
        fixedProductionMethod: setup.fixedProductionMethod,
        placementCount: setup.placementCount,
        shopifyProduct: state
          ? {
              variants: state.variants,
              productOrigin: state.productOrigin?.value || null,
              designMode: state.designMode?.value || null,
              designStatus: state.designStatus?.value || null,
              productType: state.productType?.value || null,
              creatorProductId: state.creatorProductId?.value || null,
              fixedColor: state.fixedColor?.value || null,
              productionMethod: state.productionMethod?.value || null,
              designedPlacementCount:
                state.designedPlacementCount?.value || null,
              creatorCartValidation:
                state.creatorCartValidation?.jsonValue ?? null,
            }
          : null,
      });
      productCategoryCounts[classification.category] += 1;
      const missingMappingClassification =
        classification.category === "MISSING_MAPPING"
          ? classifyMissingMappingRecord({
              creatorProductId: product.id,
              status: product.status,
              creatorId: creator.id,
              creatorStatus: creator.status,
              baseShopifyProductId: product.shopifyProductId,
              fixedColor: setup.fixedColor,
              fixedProductionMethod: setup.fixedProductionMethod,
              placementCount: setup.placementCount,
              pitchprintProjectId: product.pitchprintProjectId,
              pitchprintDesignId: product.pitchprintDesignId,
              previewPresent: previewPresent(
                product.previewUrl,
                product.previewUrls,
              ),
              candidates: nativeShopifyProductCandidates,
            })
          : null;
      const triggerValues = state
        ? [
            state.pitchprintDesignId?.value,
            state.pitchprintEnabled?.value,
            state.inkybayEnabled?.value,
            state.legacyPitchprintDesignId?.value,
            state.legacyPitchprintEnabled?.value,
            state.legacyInkybayEnabled?.value,
          ].filter(Boolean)
        : [];
      creatorProductReports.push({
        creatorProductId: product.id,
        status: product.status,
        creatorId: creator.id,
        creatorStatus: creator.status,
        creatorPublicHandle:
          creator.marketplaceCollection?.publicHandle || creator.handle,
        baseShopifyProductId: product.shopifyProductId,
        shopifyProductId: product.publishedShopifyProductId,
        fixedColor: setup.fixedColor,
        fixedProductionMethod: setup.fixedProductionMethod,
        placementCount: setup.placementCount,
        pitchprintProjectId: product.pitchprintProjectId,
        pitchprintDesignId: product.pitchprintDesignId,
        previewPresent: previewPresent(product.previewUrl, product.previewUrls),
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        publishedAt: product.publishedAt,
        orderItemCount: product._count.orderItems,
        saleCount: saleCounts.get(product.id) || 0,
        shopifyVariantCount: classification.variantCount,
        variantCount: classification.variantCount,
        allVariantsMatchFixedColor:
          classification.allVariantsMatchFixedColor,
        canonicalMetafieldsPresent:
          classification.canonicalMetafieldsPresent,
        validationContractPresent:
          classification.validationContractPresent,
        category: classification.category,
        issues: classification.issues,
        exactClassificationReason: classification.issues.join("; "),
        missingMappingClassification,
        nativeShopifyProductCandidates,
        candidateDiscoveryWarnings: [
          ...(details && !details.candidateDiscoveryComplete
            ? ["canonical collection contains more than 250 products"]
            : []),
          ...searchedCandidates.warnings,
        ],
        productHandle: state?.handle || product.publishedShopifyProductHandle || null,
        canonicalMetafields: state
          ? {
              product_origin: state.productOrigin?.value || null,
              design_mode: state.designMode?.value || null,
              design_status: state.designStatus?.value || null,
              product_type: state.productType?.value || null,
              creator_id: state.creatorId?.value || null,
              creator_product_id: state.creatorProductId?.value || null,
              creator_handle: state.creatorHandle?.value || null,
              fixed_color: state.fixedColor?.value || null,
              production_method: state.productionMethod?.value || null,
              designed_placement_count:
                state.designedPlacementCount?.value || null,
              base_product_id: state.baseProductId?.value || null,
            }
          : null,
        creatorCartValidation:
          state?.creatorCartValidation?.jsonValue ?? null,
        product_origin: state?.productOrigin?.value || null,
        design_mode: state?.designMode?.value || null,
        design_status: state?.designStatus?.value || null,
        product_type: state?.productType?.value || null,
        creator_id: state?.creatorId?.value || null,
        creator_product_id: state?.creatorProductId?.value || null,
        pitchprintDesignIdPresent: Boolean(
          state?.pitchprintDesignId?.value || state?.legacyPitchprintDesignId?.value,
        ),
        customizationTriggerPresent: triggerValues.length > 0,
        customizeExpected:
          state?.productOrigin?.value === "creator" &&
          state?.designMode?.value === "buy_only" &&
          state?.designStatus?.value === "published"
            ? "NO"
            : "UNKNOWN",
      });
    }
    creatorReports.push({
      creatorId: creator.id,
      displayName: creator.displayName,
      legacyCreatorCollectionId: creator.collectionId,
      creatorCollectionId: collection?.id || null,
      creatorCollectionDisplayName: collection?.displayName || null,
      canonicalShopifyCollectionId: collection?.shopifyCollectionId || null,
      canonicalShopifyCollectionHandle:
        details?.handle || collection?.shopifyCollectionHandle || null,
      canonicalCollectionUrl:
        collectionUrl(details?.handle || collection?.shopifyCollectionHandle),
      publishedCreatorProductCount: creator.creatorProducts.length,
      mappedNativeShopifyProductCount: productIds.length,
      nativeProductsMissingFromCanonicalCollection:
        details?.expectedProductsMissing || [],
      duplicateCanonicalCandidates,
      issues,
    });
  }
  const titleCandidateReport = titleSearch
    ? await titleCandidates(client, titleSearch)
    : [];
  const idsByMissingMappingCategory = (category: string) =>
    creatorProductReports
      .filter(
        (item) => item.missingMappingClassification?.category === category,
      )
      .map((item) => item.creatorProductId);
  const autoMappingRepairable = idsByMissingMappingCategory(
    "EXISTING_NATIVE_PRODUCT_FOUND",
  );
  const autoRepublishable = idsByMissingMappingCategory(
    "PUBLISHED_BUT_NATIVE_PRODUCT_MISSING",
  );
  const staleOrTest = idsByMissingMappingCategory("STALE_OR_TEST_RECORD");
  const manualReviewRequired = idsByMissingMappingCategory(
    "MANUAL_REVIEW_REQUIRED",
  );
  const needsNativeProductRepair = creatorProductReports
    .filter((item) => item.category === "NEEDS_REPAIR")
    .map((item) => item.creatorProductId);
  const automaticActions = creatorProductReports
    .filter((item) =>
      [
        "EXISTING_NATIVE_PRODUCT_FOUND",
        "PUBLISHED_BUT_NATIVE_PRODUCT_MISSING",
      ].includes(item.missingMappingClassification?.category || ""),
    )
    .map((item) => ({
      creatorProductId: item.creatorProductId,
      action:
        item.missingMappingClassification?.category ===
        "EXISTING_NATIVE_PRODUCT_FOUND"
          ? "RESTORE_MAPPING"
          : "REPUBLISH_CANONICALLY",
      oldDbMapping: item.shopifyProductId,
      proposedShopifyProduct:
        item.missingMappingClassification?.proposedShopifyProductId || null,
      reason: item.missingMappingClassification?.reason || "",
    }));
  const report = {
    shop,
    creatorsChecked: creatorReports.length,
    consistentCreators: creatorReports.length - inconsistent,
    inconsistentCreators: inconsistent,
    creatorProductCategoryCounts: productCategoryCounts,
    creators: creatorReports,
    creatorProducts: creatorProductReports,
    dryRunRepairPlan: {
      AUTO_MAPPING_REPAIRABLE: autoMappingRepairable.length,
      AUTO_REPUBLISHABLE: autoRepublishable.length,
      NEEDS_NATIVE_PRODUCT_REPAIR: needsNativeProductRepair.length,
      STALE_OR_TEST: staleOrTest.length,
      MANUAL_REVIEW_REQUIRED: manualReviewRequired.length,
      ids: {
        AUTO_MAPPING_REPAIRABLE: autoMappingRepairable,
        AUTO_REPUBLISHABLE: autoRepublishable,
        NEEDS_NATIVE_PRODUCT_REPAIR: needsNativeProductRepair,
        STALE_OR_TEST: staleOrTest,
        MANUAL_REVIEW_REQUIRED: manualReviewRequired,
      },
      automaticActions,
    },
    titleCandidates: titleCandidateReport,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    inconsistent > 0 ||
    productCategoryCounts.NEEDS_REPUBLISH > 0 ||
    productCategoryCounts.NEEDS_REPAIR > 0 ||
    productCategoryCounts.MISSING_MAPPING > 0
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

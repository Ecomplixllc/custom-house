import db from "../db.server.ts";
import { DomainError } from "./domain.ts";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls.ts";
import {
  CREATOR_PRODUCTION_PRICING_PRODUCT_ID,
  cleanEmbroiderySubtype,
  cleanProductionMethod,
  productProductionConfiguration,
  type PublicProductProductionPricingRecord,
} from "./production-method-pricing.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";

const MAX_FEATURED_CREATORS = 24;
const DEFAULT_DISCOVERY_PAGE_SIZE = 12;
const MAX_DISCOVERY_PAGE_SIZE = 24;

type EligibleCreator = {
  id: string;
  displayName: string;
  handle: string;
  profileImageUrl: string | null;
  categoriesJson: string;
  marketplaceCollection: {
    publicHandle: string;
    displayName: string;
    status: string;
  } | null;
  _count?: { creatorProducts: number };
  creatorProducts?: Array<{ status: string }>;
};

type FeaturedCreatorRow = {
  id: string;
  shop: string;
  creatorId: string;
  position: number;
  creator?: EligibleCreator | null;
};

type CreatorContentDb = {
  creator: {
    findMany(args: Record<string, unknown>): Promise<EligibleCreator[]>;
  };
  featuredCreator: {
    findMany(args: Record<string, unknown>): Promise<FeaturedCreatorRow[]>;
    deleteMany(args: Record<string, unknown>): Promise<unknown>;
    createMany(args: Record<string, unknown>): Promise<unknown>;
  };
  $transaction<T>(callback: (transaction: CreatorContentDb) => Promise<T>): Promise<T>;
};

type PublicCreatorContentRecord = {
  id: string;
  shop: string;
  creatorId: string;
  title: string;
  description: string | null;
  baseProductTitle: string;
  previewUrl: string | null;
  previewUrls: string;
  status: string;
  publishedAt: Date | null;
  updatedAt: Date;
  shopifyProductId: string;
  publishedShopifyProductId: string | null;
  creatorPricingMode: string | null;
  designVariantSelectionsJson: string;
  creator: EligibleCreator;
};

type PublicCreatorContentDb = CreatorContentDb & {
  creatorProduct: {
    findMany(args: Record<string, unknown>): Promise<PublicCreatorContentRecord[]>;
  };
  publicProductProductionPricing?: {
    findMany(args: Record<string, unknown>): Promise<PublicProductProductionPricingRecord[]>;
  };
};

type ShopifyDiscoveryProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType?: string | null;
  onlineStoreUrl: string | null;
  origin: { value: string } | null;
  mode: { value: string } | null;
  designStatus: { value: string } | null;
  creatorProductId: { value: string } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
  variants: {
    nodes: Array<{
      id: string;
      availableForSale: boolean;
      price: string;
      selectedOptions: Array<{ name: string; value: string }>;
    }>;
  };
};

export type FeaturedCreatorSummary = {
  id: string;
  displayName: string;
  handle: string;
  profileImageUrl: string | null;
  categories: string[];
  collectionName: string;
  publicHandle: string;
  publishedProductCount: number;
};

export type PublicCreatorContentProduct = {
  id: string;
  creatorId: string;
  creatorDisplayName: string;
  creatorHandle: string;
  creatorPublicHandle: string;
  creatorAvatarUrl: string | null;
  creatorCategories: string[];
  collectionName: string;
  title: string;
  description: string | null;
  productType: string;
  imageUrl: string | null;
  price: { min: number; max: number; currencyCode: string };
  sizes: string[];
  colors: string[];
  available: boolean;
  publishedAt: string | null;
  creatorUrl: string;
  viewUrl: string;
};

function categoriesFromJson(value: string) {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean),
    )].slice(0, 12);
  } catch {
    return [];
  }
}

function publicSummary(creator: EligibleCreator): FeaturedCreatorSummary | null {
  const collection = creator.marketplaceCollection;
  if (!collection || collection.status !== "ACTIVE") return null;
  const publishedProductCount =
    creator._count?.creatorProducts ??
    creator.creatorProducts?.filter((product) => product.status === "PUBLISHED").length ??
    0;
  if (publishedProductCount < 1) return null;
  return {
    id: creator.id,
    displayName: creator.displayName,
    handle: creator.handle,
    profileImageUrl: creator.profileImageUrl,
    categories: categoriesFromJson(creator.categoriesJson),
    collectionName: collection.displayName,
    publicHandle: collection.publicHandle,
    publishedProductCount,
  };
}

function eligibleCreatorWhere(shop: string) {
  return {
    shop,
    status: "APPROVED",
    marketplaceCollection: { is: { status: "ACTIVE" } },
    creatorProducts: { some: { shop, status: "PUBLISHED" } },
  };
}

const eligibleCreatorSelect = {
  id: true,
  displayName: true,
  handle: true,
  profileImageUrl: true,
  categoriesJson: true,
  marketplaceCollection: {
    select: {
      publicHandle: true,
      displayName: true,
      status: true,
    },
  },
  _count: {
    select: {
      creatorProducts: { where: { status: "PUBLISHED" } },
    },
  },
};

export async function listFeaturedCreatorAdminState(
  shop: string,
  query = "",
  database: CreatorContentDb = db as unknown as CreatorContentDb,
) {
  const normalizedQuery = query.trim().slice(0, 80);
  const candidateWhere = {
    ...eligibleCreatorWhere(shop),
    ...(normalizedQuery
      ? {
          OR: [
            { displayName: { contains: normalizedQuery, mode: "insensitive" } },
            { handle: { contains: normalizedQuery, mode: "insensitive" } },
            { categoriesJson: { contains: normalizedQuery, mode: "insensitive" } },
            {
              marketplaceCollection: {
                is: {
                  OR: [
                    { publicHandle: { contains: normalizedQuery, mode: "insensitive" } },
                    { displayName: { contains: normalizedQuery, mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };
  const [eligibleCreators, featuredRows] = await Promise.all([
    database.creator.findMany({
      where: candidateWhere,
      select: eligibleCreatorSelect,
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: 100,
    }),
    database.featuredCreator.findMany({
      where: { shop },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { creator: true },
    }),
  ]);
  const summaries = eligibleCreators
    .map(publicSummary)
    .filter((creator): creator is FeaturedCreatorSummary => Boolean(creator));
  const selectedIds = featuredRows.map((row) => row.creatorId);
  const selectedCreators = selectedIds.length
    ? await database.creator.findMany({
        where: {
          ...eligibleCreatorWhere(shop),
          id: { in: selectedIds },
        },
        select: eligibleCreatorSelect,
      })
    : [];
  const eligibleById = new Map(
    selectedCreators
      .map(publicSummary)
      .filter((creator): creator is FeaturedCreatorSummary => Boolean(creator))
      .map((creator) => [creator.id, creator]),
  );
  const selected = featuredRows
    .map((row) => eligibleById.get(row.creatorId) || null)
    .filter((creator): creator is FeaturedCreatorSummary => Boolean(creator));
  return { candidates: summaries, selected };
}

export async function saveFeaturedCreatorOrder(
  shop: string,
  creatorIds: string[],
  database: CreatorContentDb = db as unknown as CreatorContentDb,
) {
  const normalizedIds = creatorIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (normalizedIds.length > MAX_FEATURED_CREATORS) {
    throw new DomainError(
      "FEATURED_CREATOR_LIMIT",
      `Choose no more than ${MAX_FEATURED_CREATORS} Featured Creators.`,
      422,
    );
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new DomainError(
      "FEATURED_CREATOR_DUPLICATE",
      "Each Featured Creator may be selected only once.",
      422,
    );
  }
  const eligible = normalizedIds.length
    ? await database.creator.findMany({
        where: {
          ...eligibleCreatorWhere(shop),
          id: { in: normalizedIds },
        },
        select: { id: true },
      })
    : [];
  const eligibleIds = new Set(eligible.map((creator) => creator.id));
  if (normalizedIds.some((id) => !eligibleIds.has(id))) {
    throw new DomainError(
      "FEATURED_CREATOR_INELIGIBLE",
      "Choose an approved Creator with an active public collection and a published product.",
      422,
    );
  }
  await database.$transaction(async (transaction) => {
    await transaction.featuredCreator.deleteMany({ where: { shop } });
    if (normalizedIds.length) {
      await transaction.featuredCreator.createMany({
        data: normalizedIds.map((creatorId, position) => ({
          shop,
          creatorId,
          position,
        })),
      });
    }
  });
  return { creatorIds: normalizedIds };
}

function productPreview(record: PublicCreatorContentRecord) {
  if (record.previewUrl?.startsWith("https://")) return record.previewUrl;
  try {
    const values: unknown = JSON.parse(record.previewUrls || "[]");
    if (!Array.isArray(values)) return null;
    const match = values.find(
      (value): value is string => typeof value === "string" && value.startsWith("https://"),
    );
    return match || null;
  } catch {
    return null;
  }
}

function fixedColor(record: PublicCreatorContentRecord) {
  try {
    const setup: unknown = JSON.parse(record.designVariantSelectionsJson || "{}");
    if (!setup || typeof setup !== "object" || Array.isArray(setup)) return "";
    const value = (setup as Record<string, unknown>).fixedColor;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function discoveryShopifyProductId(record: PublicCreatorContentRecord) {
  return record.creatorPricingMode === "BAKED_IN_V1" && record.publishedShopifyProductId
    ? record.publishedShopifyProductId
    : record.shopifyProductId;
}

function legacyProductionSurcharge(
  record: PublicCreatorContentRecord,
  pricingByProductId: Map<string, PublicProductProductionPricingRecord>,
  currencyCode: string,
) {
  if (record.creatorPricingMode === "BAKED_IN_V1") return 0;
  try {
    const setup: unknown = JSON.parse(record.designVariantSelectionsJson || "{}");
    if (!setup || typeof setup !== "object" || Array.isArray(setup)) return null;
    const values = setup as Record<string, unknown>;
    const placementCount = Number(values.placementCount);
    if (!Number.isInteger(placementCount) || placementCount < 1) return null;
    const method = cleanProductionMethod(values.productionMethod);
    const pricing = pricingByProductId.get(record.shopifyProductId) ||
      pricingByProductId.get(CREATOR_PRODUCTION_PRICING_PRODUCT_ID);
    if (!pricing || (pricing.currency && pricing.currency !== currencyCode)) return null;
    const configured = productProductionConfiguration(pricing).methods[method];
    if (!configured || !configured.enabled) return null;
    const rate = "tiers" in configured
      ? configured.tiers[cleanEmbroiderySubtype(values.embroiderySubtype)]
      : configured;
    if (!rate?.enabled) return null;
    const surcharge = Number(rate.surcharge);
    return Number.isFinite(surcharge) && surcharge >= 0
      ? surcharge * placementCount
      : null;
  } catch {
    return null;
  }
}

function optionValues(
  variants: ShopifyDiscoveryProduct["variants"]["nodes"],
  matcher: RegExp,
  sort = true,
) {
  const values = [...new Set(
    variants
      .flatMap((variant) => variant.selectedOptions)
      .filter((option) => matcher.test(option.name.trim()))
      .map((option) => option.value.trim())
      .filter(Boolean),
  )];
  return sort ? values.sort((left, right) => left.localeCompare(right)) : values;
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "5XL"];

function sortSizes(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => {
    const leftIndex = SIZE_ORDER.indexOf(left.toUpperCase());
    const rightIndex = SIZE_ORDER.indexOf(right.toUpperCase());
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER) -
        (rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
}

function canonicalBuyOnlyProduct(
  record: PublicCreatorContentRecord,
  product: ShopifyDiscoveryProduct,
) {
  if (
    product.status !== "ACTIVE" ||
    !product.onlineStoreUrl ||
    !product.variants.nodes.length
  ) {
    return false;
  }
  if (record.creatorPricingMode !== "BAKED_IN_V1") {
    // Legacy records remain safe because every card links to the existing
    // app-proxy buy-only page instead of the Shopify product/customizer.
    return true;
  }
  return Boolean(record.publishedShopifyProductId) && (
    product.origin?.value === "creator" &&
    product.mode?.value === "buy_only" &&
    product.designStatus?.value === "published" &&
    product.creatorProductId?.value === record.id
  );
}

export async function loadPublicCreatorContent(
  shop: string,
  client: ShopifyGraphqlClient,
  database: PublicCreatorContentDb = db as unknown as PublicCreatorContentDb,
  options: { offset?: number; limit?: number } = {},
) {
  const offset = Number.isInteger(options.offset) && Number(options.offset) >= 0
    ? Math.min(Number(options.offset), 10_000)
    : 0;
  const limit = Number.isInteger(options.limit) && Number(options.limit) > 0
    ? Math.min(Number(options.limit), MAX_DISCOVERY_PAGE_SIZE)
    : DEFAULT_DISCOVERY_PAGE_SIZE;
  const [adminState, records] = await Promise.all([
    listFeaturedCreatorAdminState(shop, "", database),
    database.creatorProduct.findMany({
      where: {
        shop,
        status: "PUBLISHED",
        creator: {
          status: "APPROVED",
          marketplaceCollection: { is: { status: "ACTIVE" } },
        },
      },
      include: {
        creator: { include: { marketplaceCollection: true } },
      },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      skip: offset,
      take: limit + 1,
    }),
  ]);
  const hasMore = records.length > limit;
  const pageRecords = records.slice(0, limit);
  const featuredCreatorIds = adminState.selected.map((creator) => creator.id);
  const featuredRecords = featuredCreatorIds.length
    ? await database.creatorProduct.findMany({
        where: {
          shop,
          status: "PUBLISHED",
          creatorId: { in: featuredCreatorIds },
          creator: {
            status: "APPROVED",
            marketplaceCollection: { is: { status: "ACTIVE" } },
          },
        },
        include: {
          creator: { include: { marketplaceCollection: true } },
        },
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        take: MAX_FEATURED_CREATORS * 4,
      })
    : [];
  const discoveryRecords = [...new Map(
    [...pageRecords, ...featuredRecords].map((record) => [record.id, record]),
  ).values()];
  const productIds = [...new Set(discoveryRecords.map(discoveryShopifyProductId))];
  const legacyPricingProductIds = [...new Set(discoveryRecords
    .filter((record) => record.creatorPricingMode !== "BAKED_IN_V1")
    .flatMap((record) => [record.shopifyProductId, CREATOR_PRODUCTION_PRICING_PRODUCT_ID]))];
  const [response, productionPricingRows] = await Promise.all([
    productIds.length
      ? client.request<{ nodes: Array<ShopifyDiscoveryProduct | null> }>(
        `#graphql query CreatorContentProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              handle
              status
              productType
              onlineStoreUrl
              origin: metafield(namespace: "customhouse", key: "product_origin") { value }
              mode: metafield(namespace: "customhouse", key: "design_mode") { value }
              designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
              creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
              priceRangeV2 {
                minVariantPrice { amount currencyCode }
                maxVariantPrice { amount currencyCode }
              }
              variants(first: 100) {
                nodes {
                  id
                  availableForSale
                  price
                  selectedOptions { name value }
                }
              }
            }
          }
        }`,
        { ids: productIds },
        )
      : Promise.resolve({ nodes: [] }),
    legacyPricingProductIds.length && database.publicProductProductionPricing
      ? database.publicProductProductionPricing.findMany({
          where: {
            shopKey: shop,
            shopifyProductId: { in: legacyPricingProductIds },
          },
        })
      : Promise.resolve([]),
  ]);
  const pricingByProductId = new Map(
    productionPricingRows.map((pricing) => [pricing.shopifyProductId, pricing]),
  );
  const shopifyById = new Map(
    response.nodes
      .filter((product): product is ShopifyDiscoveryProduct => Boolean(product?.id))
      .map((product) => [product.id, product]),
  );
  const validatedProducts = discoveryRecords
    .map((record): PublicCreatorContentProduct | null => {
      const collection = record.creator.marketplaceCollection;
      if (!collection || collection.status !== "ACTIVE") return null;
      const shopifyId = discoveryShopifyProductId(record);
      const product = shopifyById.get(shopifyId);
      if (!product || !canonicalBuyOnlyProduct(record, product)) return null;
      const selectedColor = fixedColor(record);
      const variants = selectedColor
        ? product.variants.nodes.filter((variant) => {
            const color = variant.selectedOptions.find((option) =>
              /^(color|colour|farg|färg)$/i.test(option.name.trim()),
            )?.value;
            return !color || color.toLocaleLowerCase() === selectedColor.toLocaleLowerCase();
          })
        : product.variants.nodes;
      if (!variants.length) return null;
      const variantPrices = variants
        .map((variant) => Number(variant.price))
        .filter((price) => Number.isFinite(price) && price >= 0);
      if (variantPrices.length !== variants.length) return null;
      const min = Math.min(...variantPrices);
      const max = Math.max(...variantPrices);
      const currencyCode = product.priceRangeV2.minVariantPrice.currencyCode;
      const surcharge = legacyProductionSurcharge(record, pricingByProductId, currencyCode);
      if (surcharge === null) return null;
      const creatorUrl = getCreatorCollectionStorefrontUrl(collection);
      const viewUrl = getCreatorProductStorefrontUrl(collection, record);
      if (!creatorUrl || !viewUrl) return null;
      return {
        id: record.id,
        creatorId: record.creatorId,
        creatorDisplayName: record.creator.displayName,
        creatorHandle: record.creator.handle,
        creatorPublicHandle: collection.publicHandle,
        creatorAvatarUrl: record.creator.profileImageUrl,
        creatorCategories: categoriesFromJson(record.creator.categoriesJson),
        collectionName: collection.displayName,
        title: record.title,
        description: record.description,
        productType: product.productType?.trim() || record.baseProductTitle,
        imageUrl: productPreview(record),
        price: {
          min: min + surcharge,
          max: max + surcharge,
          currencyCode,
        },
        sizes: optionValues(variants, /^(size|storlek|storrelse|størrelse)$/i, false),
        colors: optionValues(variants, /^(color|colour|farg|färg)$/i),
        available: variants.some((variant) => variant.availableForSale),
        publishedAt: record.publishedAt?.toISOString() || null,
        creatorUrl,
        viewUrl,
      };
    })
    .filter((product): product is PublicCreatorContentProduct => Boolean(product))
    .sort((left, right) =>
      String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")),
    );
  const pageRecordIds = new Set(pageRecords.map((record) => record.id));
  const products = validatedProducts.filter((product) => pageRecordIds.has(product.id));
  const uniqueSorted = (values: string[]) =>
    [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const publicCreatorIds = new Set(validatedProducts.map((product) => product.creatorId));
  const productCreators = new Map(
    products.map((product) => [
      product.creatorId,
      {
        id: product.creatorId,
        displayName: product.creatorDisplayName,
        publicHandle: product.creatorPublicHandle,
      },
    ]),
  );
  return {
    featuredCreators: adminState.selected
      .filter((creator) => publicCreatorIds.has(creator.id))
      .map((creator) => ({
      ...creator,
      viewUrl: getCreatorCollectionStorefrontUrl({ publicHandle: creator.publicHandle })!,
    })),
    categories: uniqueSorted(products.flatMap((product) => product.creatorCategories)),
    products,
    filters: {
      creators: [...productCreators.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
      productTypes: uniqueSorted(products.map((product) => product.productType)),
      sizes: sortSizes(products.flatMap((product) => product.sizes)),
      colors: uniqueSorted(products.flatMap((product) => product.colors)),
      availability: products.some((product) => !product.available),
      price: products.length
        ? {
            min: Math.min(...products.map((product) => product.price.min)),
            max: Math.max(...products.map((product) => product.price.max)),
            currencyCode: products[0]!.price.currencyCode,
          }
        : null,
    },
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

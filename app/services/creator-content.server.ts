import db from "../db.server.ts";
import { DomainError } from "./domain.ts";

const MAX_FEATURED_CREATORS = 24;

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
  const [eligibleCreators, featuredRows] = await Promise.all([
    database.creator.findMany({
      where: eligibleCreatorWhere(shop),
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
  const eligibleById = new Map(summaries.map((creator) => [creator.id, creator]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = summaries.filter((creator) => {
    if (!normalizedQuery) return true;
    return [
      creator.displayName,
      creator.handle,
      creator.publicHandle,
      creator.collectionName,
      ...creator.categories,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const selected = featuredRows
    .map((row) => eligibleById.get(row.creatorId) || null)
    .filter((creator): creator is FeaturedCreatorSummary => Boolean(creator));
  return { candidates, selected };
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

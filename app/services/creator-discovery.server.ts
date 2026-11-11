import db from "../db.server.ts";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls.ts";

type DirectoryProduct = {
  id: string;
  title: string;
  description: string | null;
  previewUrl: string | null;
  previewUrls: string;
  publishedAt: Date | null;
};

type DirectoryCollection = {
  publicHandle: string;
  displayName: string;
  bannerImageUrl: string | null;
  updatedAt: Date;
  creator: {
    displayName: string;
    handle: string;
    profileImageUrl: string | null;
    categoriesJson: string;
    creatorProducts: DirectoryProduct[];
  };
};

type CreatorDirectoryDb = {
  creatorCollection: {
    findMany(args: Record<string, unknown>): Promise<DirectoryCollection[]>;
  };
};

function publicCategories(value: string): string[] {
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

export async function listPublicCreatorDirectory(
  shop: string,
  database: CreatorDirectoryDb = db as unknown as CreatorDirectoryDb,
) {
  const collections = await database.creatorCollection.findMany({
    where: {
      shop,
      status: "ACTIVE",
      creator: { status: "APPROVED" },
    },
    select: {
      publicHandle: true,
      displayName: true,
      bannerImageUrl: true,
      updatedAt: true,
      creator: {
        select: {
          displayName: true,
          handle: true,
          profileImageUrl: true,
          categoriesJson: true,
          creatorProducts: {
            where: { shop, status: "PUBLISHED" },
            orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
            take: 24,
            select: {
              id: true,
              title: true,
              description: true,
              previewUrl: true,
              previewUrls: true,
              publishedAt: true,
            },
          },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 60,
  });

  const categories = new Set<string>();
  const creators = collections.map((collection) => {
    const creatorCategories = publicCategories(collection.creator.categoriesJson);
    creatorCategories.forEach((category) => categories.add(category));
    return {
      displayName: collection.creator.displayName,
      handle: collection.creator.handle,
      profileImageUrl: collection.creator.profileImageUrl,
      categories: creatorCategories,
      collectionName: collection.displayName,
      collectionHandle: collection.publicHandle,
      collectionImageUrl: collection.bannerImageUrl,
      collectionUrl: getCreatorCollectionStorefrontUrl(collection),
      updatedAt: collection.updatedAt,
      products: collection.creator.creatorProducts.map((product) => ({
        id: product.id,
        title: product.title,
        description: product.description,
        previewUrl: product.previewUrl,
        previewUrls: product.previewUrls,
        publishedAt: product.publishedAt,
        viewUrl: getCreatorProductStorefrontUrl(collection, product),
      })),
    };
  });

  return {
    creators,
    categories: [...categories].sort((left, right) => left.localeCompare(right)),
  };
}

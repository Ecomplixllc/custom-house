const CREATOR_MARKETPLACE_BASE = "/apps/customhouse/creators";

export type CreatorCollectionUrlSource = {
  publicHandle: string | null;
};

export type CreatorProductUrlSource = {
  id: string;
};

export function getCreatorCollectionStorefrontUrl(
  collection: CreatorCollectionUrlSource | null | undefined,
) {
  return collection?.publicHandle
    ? `${CREATOR_MARKETPLACE_BASE}/${encodeURIComponent(collection.publicHandle)}`
    : null;
}

export function getCreatorProductStorefrontUrl(
  collection: CreatorCollectionUrlSource | null | undefined,
  product: CreatorProductUrlSource,
) {
  const collectionUrl = getCreatorCollectionStorefrontUrl(collection);
  return collectionUrl
    ? `${collectionUrl}/products/${encodeURIComponent(product.id)}`
    : null;
}

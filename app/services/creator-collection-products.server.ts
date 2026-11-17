import type { ShopifyGraphqlClient } from "./shopify-graphql.server";

const PAGE_SIZE = 250;
const MAX_PAGES = 40;

type CollectionProductsPage = {
  collection: {
    products: {
      nodes: Array<{ status: string }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  } | null;
};

/**
 * Counts products that are currently publishable in a creator's Shopify
 * collection. Shopify is authoritative here so products added to the
 * collection manually are included even when they have no local submission.
 */
export async function countActiveCollectionProducts(
  client: ShopifyGraphqlClient,
  collectionId: string,
): Promise<number> {
  let after: string | null = null;
  let activeProducts = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: CollectionProductsPage =
      await client.request<CollectionProductsPage>(
        `#graphql query CreatorCollectionProducts($id: ID!, $after: String) {
          collection(id: $id) {
            products(first: ${PAGE_SIZE}, after: $after) {
              nodes { status }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: collectionId, after },
      );

    if (!result.collection) return 0;

    const { nodes, pageInfo } = result.collection.products;
    activeProducts += nodes.filter(
      (product) => product.status === "ACTIVE",
    ).length;

    if (!pageInfo.hasNextPage) return activeProducts;
    if (!pageInfo.endCursor) {
      throw new Error("Shopify collection pagination cursor is missing.");
    }
    after = pageInfo.endCursor;
  }

  throw new Error("Shopify collection product count exceeded the safe limit.");
}

import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const gid = `gid://shopify/Collection/${String((payload as { id?: number | string }).id ?? "")}`;
  await Promise.all([
    db.creator.updateMany({
      where: { shop, collectionId: gid },
      data: { collectionId: null },
    }),
    db.creatorCollection.updateMany({
      where: { shop, shopifyCollectionId: gid },
      data: {
        shopifyCollectionId: null,
        shopifyCollectionHandle: null,
        shopifyCollectionUrl: null,
        shopifyPublishedAt: null,
      },
    }),
  ]);
  return new Response();
}

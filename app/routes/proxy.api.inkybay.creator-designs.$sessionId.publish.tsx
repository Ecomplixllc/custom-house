import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { designerApiError, designerApiSuccess } from "../services/designer-api.server";
import {
  publishInkyBayCreatorDesign,
  sessionTokenFromRequest,
} from "../services/inkybay/inkybay-creator-publishing.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    enforceRateLimit(
      `${actor.shop}:${actor.customerId || "guest"}:inkybay-publish`,
      5,
      60 * 60 * 1_000,
    );
    const design = await publishInkyBayCreatorDesign({
      actor,
      client: actor.client,
      sessionId: params.sessionId || "",
      token: sessionTokenFromRequest(request),
    });
    const [product, collection] = await Promise.all([
      design.shopifyCreatorProductId
        ? actor.client.request<{ product: { handle: string } | null }>(
            `#graphql query InkyBayPublishedProduct($id: ID!) { product(id: $id) { handle } }`,
            { id: design.shopifyCreatorProductId },
          )
        : Promise.resolve({ product: null }),
      design.shopifyCollectionId
        ? actor.client.request<{ collection: { handle: string } | null }>(
            `#graphql query InkyBayPublishedCollection($id: ID!) { collection(id: $id) { handle } }`,
            { id: design.shopifyCollectionId },
          )
        : Promise.resolve({ collection: null }),
    ]);
    await db.auditLog.create({
      data: {
        shop: actor.shop,
        actorType: "CREATOR",
        actorId: actor.customerId,
        action: "inkybay_publish.completed",
        entityType: "CreatorDesign",
        entityId: design.id,
      },
    });
    return designerApiSuccess({
      id: design.id,
      status: design.status,
      syncStatus: design.syncStatus,
      productUrl: product.product?.handle
        ? `/products/${encodeURIComponent(product.product.handle)}`
        : null,
      collectionUrl: collection.collection?.handle
        ? `/collections/${encodeURIComponent(collection.collection.handle)}`
        : null,
    });
  } catch (error) {
    return designerApiError(error, "inkybay.publish");
  }
}

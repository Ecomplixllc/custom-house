import type { ActionFunctionArgs } from "react-router";
import { designerApiError, designerApiSuccess } from "../services/designer-api.server";
import { startInkyBayCreatorSession } from "../services/inkybay/inkybay-creator-publishing.server";
import { jsonBody } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    enforceRateLimit(
      `${actor.shop}:${actor.customerId || "guest"}:inkybay-session-start`,
      8,
      60 * 60 * 1_000,
    );
    const body = await jsonBody(request);
    const session = await startInkyBayCreatorSession({
      actor,
      client: actor.client,
      productId: String(body.productId || ""),
      variantId: String(body.variantId || ""),
      idempotencyKey: String(body.idempotencyKey || ""),
    });
    return designerApiSuccess(session, 201);
  } catch (error) {
    return designerApiError(error, "inkybay.session_start");
  }
}

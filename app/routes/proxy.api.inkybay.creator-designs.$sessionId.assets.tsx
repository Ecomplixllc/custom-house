import type { ActionFunctionArgs } from "react-router";
import {
  designerApiError,
  designerApiSuccess,
  requireFormFile,
} from "../services/designer-api.server";
import {
  sessionTokenFromRequest,
  uploadInkyBaySessionAssets,
} from "../services/inkybay/inkybay-creator-publishing.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    enforceRateLimit(
      `${actor.shop}:${actor.customerId || "guest"}:inkybay-asset-upload`,
      12,
      60 * 60 * 1_000,
    );
    const form = await request.formData();
    const session = await uploadInkyBaySessionAssets({
      actor,
      client: actor.client,
      sessionId: params.sessionId || "",
      token: sessionTokenFromRequest(request),
      preview: requireFormFile(form, "preview"),
      productionArtwork: requireFormFile(form, "productionArtwork"),
    });
    return designerApiSuccess(
      { id: session.id, status: session.status },
      201,
    );
  } catch (error) {
    return designerApiError(error, "inkybay.asset_upload");
  }
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { designerApiError, designerApiSuccess } from "../services/designer-api.server";
import {
  inkyBaySessionView,
  saveInkyBaySessionDetails,
  sessionTokenFromRequest,
} from "../services/inkybay/inkybay-creator-publishing.server";
import { jsonBody } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    return designerApiSuccess(
      await inkyBaySessionView({
        actor,
        client: actor.client,
        sessionId: params.sessionId || "",
        token: sessionTokenFromRequest(request),
      }),
    );
  } catch (error) {
    return designerApiError(error, "inkybay.session_view");
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    enforceRateLimit(
      `${actor.shop}:${actor.customerId || "guest"}:inkybay-session-save`,
      30,
      60 * 60 * 1_000,
    );
    const body = await jsonBody(request);
    const session = await saveInkyBaySessionDetails({
      actor,
      client: actor.client,
      sessionId: params.sessionId || "",
      token: sessionTokenFromRequest(request),
      savedDesignUrl: String(body.savedDesignUrl || ""),
      tid: body.tid ? String(body.tid) : null,
      title: String(body.title || ""),
      description: body.description ? String(body.description) : null,
      compatibleVariantIds: body.compatibleVariantIds,
    });
    return designerApiSuccess({ id: session.id, status: session.status });
  } catch (error) {
    return designerApiError(error, "inkybay.session_save");
  }
}

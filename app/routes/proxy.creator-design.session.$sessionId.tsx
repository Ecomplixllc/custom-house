import type { LoaderFunctionArgs } from "react-router";
import { DomainError } from "../services/domain";
import {
  inkyBaySessionView,
  sessionTokenFromRequest,
} from "../services/inkybay/inkybay-creator-publishing.server";
import {
  inkyBayWorkspaceErrorHtml,
  inkyBayWorkspaceHtml,
} from "../services/inkybay/inkybay-workspace.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com; form-action 'self'",
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    const token = sessionTokenFromRequest(request);
    const data = await inkyBaySessionView({
      actor,
      client: actor.client,
      sessionId: params.sessionId || "",
      token,
    });
    return new Response(inkyBayWorkspaceHtml({ sessionToken: token, data }), {
      headers: HEADERS,
    });
  } catch (error) {
    const known = error instanceof DomainError;
    return new Response(
      inkyBayWorkspaceErrorHtml(
        known
          ? error.message
          : "The creator publishing workspace could not be loaded.",
      ),
      { status: known ? error.status : 500, headers: HEADERS },
    );
  }
}

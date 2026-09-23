import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createPendingReferral,
  PENDING_REFERRAL_COOKIE,
  PENDING_REFERRAL_TTL_SECONDS,
} from "../services/creator-referral.server";
import {
  apiData,
  apiError,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  const prefix = `${name}=`;
  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length) || null
  );
}

async function resolveReferral(request: Request, body?: Record<string, unknown>) {
  const { shop } = await proxyContext(request, false);
  const url = new URL(request.url);
  const code = String(body?.ref ?? body?.code ?? url.searchParams.get("ref") ?? "");
  const existingToken =
    String(body?.existingToken ?? url.searchParams.get("existing") ?? "") ||
    cookieValue(request, PENDING_REFERRAL_COOKIE);
  const result = await createPendingReferral({
    shop,
    code,
    existingToken,
  });
  return apiData({
    ...result,
    maxAgeSeconds:
      result.status === "RESOLVED"
        ? result.maxAgeSeconds
        : PENDING_REFERRAL_TTL_SECONDS,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    return await resolveReferral(request);
  } catch (error) {
    return apiError(error);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    return await resolveReferral(request, await jsonBody(request));
  } catch (error) {
    return apiError(error);
  }
}

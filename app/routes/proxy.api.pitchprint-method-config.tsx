import type { LoaderFunctionArgs } from "react-router";
import { publicPitchPrintMethodConfig } from "../services/pitchprint-method-config.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request, false);
    enforceRateLimit(`${context.shop}:pitchprint-method-config`, 240);
    const productId = new URL(request.url).searchParams.get("productId") || "";
    return apiData(await publicPitchPrintMethodConfig(context.shop, productId, context.client));
  } catch (error) {
    return apiError(error);
  }
}

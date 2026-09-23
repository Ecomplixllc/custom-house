import type { LoaderFunctionArgs } from "react-router";
import { creatorPitchPrintIdentityForCustomer } from "../services/creator-products.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-pitchprint-identity`);
    return apiData(
      await creatorPitchPrintIdentityForCustomer(
        context.shop,
        context.customerId!,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}

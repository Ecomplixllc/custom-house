import type { LoaderFunctionArgs } from "react-router";
import { listEligibleCreatorBaseProducts } from "../services/creator-products.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-base-products`);
    return apiData({
      products: await listEligibleCreatorBaseProducts(
        context.shop,
        context.customerId!,
        context.client,
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}

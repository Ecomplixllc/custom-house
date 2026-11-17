import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  getCreatorProductForCustomer,
} from "../services/creator-products.server";
import { creatorProductAction } from "../services/creator-product-action.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-products:read`);
    return apiData({
      product: await getCreatorProductForCustomer(
        context.shop,
        context.customerId!,
        String(params.id || ""),
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function action({ params, request }: ActionFunctionArgs) {
  return creatorProductAction({ params, request } as ActionFunctionArgs);
}

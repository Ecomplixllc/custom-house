import type { ActionFunctionArgs } from "react-router";
import {
  preparePublicProductionCart,
  type PublicProductionCartInput,
} from "../services/production-method-cart.server";
import {
  apiData,
  apiError,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const context = await proxyContext(request, false);
    enforceRateLimit(`${context.shop}:public-production-cart`);
    const cart = await preparePublicProductionCart(
      context.shop,
      (await jsonBody(request)) as PublicProductionCartInput,
      context.client,
    );
    return apiData({
      items: cart.items,
      cart,
    });
  } catch (error) {
    return apiError(error);
  }
}

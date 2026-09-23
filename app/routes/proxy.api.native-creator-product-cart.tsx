import type { ActionFunctionArgs } from "react-router";
import {
  prepareNativeCreatorProductCart,
  type PrepareNativeCreatorProductCartInput,
} from "../services/creator-products.server";
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
    enforceRateLimit(`${context.shop}:native-creator-product-cart`);
    const cart = await prepareNativeCreatorProductCart(
      context.shop,
      (await jsonBody(request)) as PrepareNativeCreatorProductCartInput,
      context.client,
    );
    return apiData({ cart });
  } catch (error) {
    return apiError(error);
  }
}

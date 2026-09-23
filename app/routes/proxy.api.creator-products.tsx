import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  createCreatorProductDraft,
  listCreatorProductsForCustomer,
  type CreateCreatorProductInput,
} from "../services/creator-products.server";
import {
  apiData,
  apiError,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-products:list`);
    return apiData({
      products: await listCreatorProductsForCustomer(
        context.shop,
        context.customerId!,
      ),
    });
  } catch (error) {
    console.error("creator_products_proxy_error", {
      route: "/proxy/api/creator-products",
      method: request.method,
      operation: "list",
      code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    });
    return apiError(error);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-products:create`);
    const product = await createCreatorProductDraft(
      context.shop,
      context.customerId!,
      (await jsonBody(request)) as CreateCreatorProductInput,
      context.client,
    );
    return apiData({ product }, 201);
  } catch (error) {
    console.error("creator_products_proxy_error", {
      route: "/proxy/api/creator-products",
      method: request.method,
      operation: "create",
      code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    });
    return apiError(error);
  }
}

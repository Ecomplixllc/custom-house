import { proxyContext } from "./proxy.server";
import type { VerifiedProxyContext } from "./storefront-proxy.server";

export async function authenticateStorefrontProxy(
  request: Request,
): Promise<VerifiedProxyContext> {
  const context = await proxyContext(request, false);
  return {
    shop: context.shop,
    customerId: context.customerId,
    client: context.client,
  };
}

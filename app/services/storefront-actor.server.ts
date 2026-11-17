import db from "../db.server";
import { normalizeCustomerGid } from "./helium-sync.server";
import { proxyContext } from "./proxy.server";
import {
  normalizeStorefrontActor,
  type StorefrontActor,
} from "./storefront-actor";

export type TrustedStorefrontActor = StorefrontActor & {
  shop: string;
};

export async function resolveStorefrontActor(
  shop: string,
  rawCustomerId: string | null,
): Promise<TrustedStorefrontActor> {
  const customerId = rawCustomerId
    ? normalizeCustomerGid(rawCustomerId)
    : null;
  const creator = customerId
    ? await db.creator.findUnique({
        where: { shop_customerId: { shop, customerId } },
        select: {
          id: true,
          status: true,
          suspendedAt: true,
        },
      })
    : null;
  return {
    shop,
    ...normalizeStorefrontActor({ customerId, creator }),
  };
}

export async function getStorefrontActor(request: Request) {
  const context = await proxyContext(request, false);
  return {
    ...(await resolveStorefrontActor(
      context.shop,
      context.customerId,
    )),
    client: context.client,
  };
}

import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { DomainError } from "../services/domain";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import {
  cancelCreatorPayout,
  requestCreatorPayout,
  serializePayout,
} from "../services/payouts.server";
import { apiData, apiError, jsonBody, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:payouts`, 10, 60 * 1000);
    const creator = await db.creator.findUnique({
      where: {
        shop_customerId: {
          shop,
          customerId: normalizeCustomerGid(customerId!),
        },
      },
      select: { id: true },
    });
    if (!creator) throw new DomainError("CREATOR_NOT_FOUND", "Creator not found.", 404);
    const body = await jsonBody(request);
    const actionName = typeof body.action === "string" ? body.action : "request";
    if (actionName === "cancel") {
      const payoutId = typeof body.payoutId === "string" ? body.payoutId : "";
      const payout = await cancelCreatorPayout({ shop, creatorId: creator.id, payoutId });
      return apiData({ payout: serializePayout(payout) });
    }
    const payout = await requestCreatorPayout({
      shop,
      creatorId: creator.id,
      payoutMethodId: typeof body.payoutMethodId === "string" ? body.payoutMethodId : "",
      currency: body.currency,
      amount: body.amount,
      creatorNote: typeof body.creatorNote === "string" ? body.creatorNote : "",
    });
    return apiData({ payout: serializePayout(payout) }, 201);
  } catch (error) {
    return apiError(error);
  }
}

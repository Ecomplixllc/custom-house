import { PayoutMethodType } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import { createPayoutMethod, updatePayoutMethod } from "../services/payouts.server";
import { apiData, apiError, jsonBody, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { DomainError } from "../services/domain";

function methodType(value: unknown) {
  if (value === PayoutMethodType.PAYPAL) return PayoutMethodType.PAYPAL;
  if (value === PayoutMethodType.BANK_TRANSFER) return PayoutMethodType.BANK_TRANSFER;
  throw new DomainError("INVALID_PAYOUT_METHOD_TYPE", "Choose PayPal or bank transfer.");
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:payout-methods`, 10, 60 * 1000);
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
    const details =
      body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? (body.details as Record<string, unknown>)
        : body;
    const methodId = typeof body.payoutMethodId === "string" ? body.payoutMethodId : "";
    const method = methodId
      ? await updatePayoutMethod({
          shop,
          creatorId: creator.id,
          payoutMethodId: methodId,
          details,
          isDefault: body.isDefault === true,
        })
      : await createPayoutMethod({
          shop,
          creatorId: creator.id,
          type: methodType(body.type),
          details,
          isDefault: body.isDefault === true,
        });
    return apiData({
      id: method.id,
      type: method.type,
      status: method.status,
      displayLabel: method.displayLabel,
      isDefault: method.isDefault,
    });
  } catch (error) {
    return apiError(error);
  }
}

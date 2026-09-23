import type { ActionFunctionArgs } from "react-router";
import { claimPendingReferral } from "../services/creator-referral.server";
import {
  apiData,
  apiError,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId } = await proxyContext(request, false);
    const body = await jsonBody(request);
    const token = String(body.token || "");
    const result = await claimPendingReferral({ shop, customerId, token });
    return apiData(result);
  } catch (error) {
    return apiError(error);
  }
}

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { synchronizeCustomerWebhook, type CustomerWebhookPayload } from "../services/helium-webhook.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  try {
    await synchronizeCustomerWebhook(shop, payload as CustomerWebhookPayload);
    return new Response();
  } catch {
    console.error("legacy_customer_sync_failed", { shop });
    return new Response("Customer synchronization failed", { status: 500 });
  }
}

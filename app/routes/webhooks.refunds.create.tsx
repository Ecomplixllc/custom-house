import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordCreatorRefund } from "../services/creator-sales.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  await recordCreatorRefund({ shop, payload, webhookId });
  return new Response();
}

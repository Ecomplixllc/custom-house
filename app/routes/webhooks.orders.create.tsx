import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordPaidCreatorSales } from "../services/creator-sales.server";
import { snapshotCreatorFixedOrder } from "../services/order-design-snapshot.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload, webhookId, admin } =
    await authenticate.webhook(request);
  await snapshotCreatorFixedOrder(shop, payload);
  await recordPaidCreatorSales({
    shop,
    payload,
    webhookId,
    client: admin ? new AdminGraphqlClient(admin) : undefined,
  });
  return new Response();
}

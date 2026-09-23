import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const customerId = normalizeCustomerGid(
    (payload as { customer?: { id?: number | string } }).customer?.id ?? "",
  );
  const creator = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
    select: { id: true },
  });
  await db.auditLog.create({
    data: {
      shop,
      actorType: "WEBHOOK",
      action: "privacy.data_request",
      entityType: "Customer",
      entityId: customerId,
      afterJson: JSON.stringify({ creatorRecordFound: Boolean(creator) }),
    },
  });
  return new Response(null, { status: 200 });
}

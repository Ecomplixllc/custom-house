import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await authenticate.webhook(request);
  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.creatorSaleAdjustment.deleteMany({ where: { shop } }),
    db.creatorOrderItem.deleteMany({ where: { shop } }),
    db.creatorSale.deleteMany({ where: { shop } }),
    db.creatorApplication.deleteMany({ where: { shop } }),
    db.designSubmission.deleteMany({ where: { shop } }),
    db.creator.deleteMany({ where: { shop } }),
    db.shopConfig.deleteMany({ where: { shop } }),
    db.auditLog.deleteMany({ where: { shop } }),
  ]);
  return new Response();
}

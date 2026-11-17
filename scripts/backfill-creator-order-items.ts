import db from "../app/db.server.ts";
import { backfillCreatorOrderItemsFromSales } from "../app/services/creator-orders.server.ts";

async function main() {
  const shop = process.env.SHOPIFY_SHOP || process.env.SHOP || "";
  if (!shop) {
    throw new Error("Set SHOPIFY_SHOP or SHOP before running this backfill.");
  }
  const beforeSales = await db.creatorSale.count({ where: { shop } });
  const beforeItems = await db.creatorOrderItem.count({ where: { shop } });
  const result = await backfillCreatorOrderItemsFromSales(shop);
  const afterSales = await db.creatorSale.count({ where: { shop } });
  const afterItems = await db.creatorOrderItem.count({ where: { shop } });
  console.log(
    JSON.stringify({
      shop,
      before: { creatorSaleCount: beforeSales, creatorOrderItemCount: beforeItems },
      result,
      after: { creatorSaleCount: afterSales, creatorOrderItemCount: afterItems },
    }),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

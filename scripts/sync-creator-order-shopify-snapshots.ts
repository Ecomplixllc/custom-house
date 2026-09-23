import { readFileSync } from "node:fs";
import db from "../app/db.server.ts";
import { unauthenticated } from "../app/shopify.server.ts";
import { AdminGraphqlClient } from "../app/services/shopify-graphql.server.ts";
import {
  auditCreatorSalesOrderItemCoverage,
  syncCreatorOrderShopifySnapshots,
} from "../app/services/creator-orders.server.ts";

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1]!.trim()]) {
        process.env[match[1]!.trim()] = match[2]!;
      }
    }
  } catch {
    // Production environments provide env vars directly.
  }
}

async function main() {
  loadEnvFile();
  if (!process.env.SHOPIFY_APP_URL?.startsWith("https://")) {
    process.env.SHOPIFY_APP_URL = "https://custom-house.vercel.app";
  }
  const shop =
    process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7) ||
    process.env.SHOPIFY_SHOP ||
    process.env.SHOP ||
    "";
  if (!shop) throw new Error("Pass --shop=<myshopify-domain>.");
  const dryRun = !process.argv.includes("--apply");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8);
  const limit = limitArg ? Number(limitArg) : undefined;
  const { admin } = await unauthenticated.admin(shop);
  const client = new AdminGraphqlClient(admin);
  const snapshotSync = await syncCreatorOrderShopifySnapshots({
    shop,
    client,
    dryRun,
    limit,
  });
  const coverage = await auditCreatorSalesOrderItemCoverage(shop);
  console.log(
    JSON.stringify(
      {
        shop,
        mode: dryRun ? "dry-run" : "apply",
        snapshotSync,
        creatorSaleCoverage: coverage,
      },
      null,
      2,
    ),
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

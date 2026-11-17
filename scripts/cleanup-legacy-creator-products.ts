import { readFileSync } from "node:fs";
import db from "../app/db.server.ts";
import { unauthenticated } from "../app/shopify.server.ts";
import { cleanupCreatorProductAsAdmin } from "../app/services/creator-products.server.ts";
import { DomainError } from "../app/services/domain.ts";
import { listLegacyCompatibilityRecords } from "../app/services/creator-product-legacy-remediation.server.ts";
import { AdminGraphqlClient } from "../app/services/shopify-graphql.server.ts";

const EXECUTE_CONFIRMATION = "CONFIRM_LEGACY_TEST_CLEANUP";

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1]!.trim()]) {
        process.env[match[1]!.trim()] = match[2]!;
      }
    }
  } catch {
    // Deployed or managed environments provide variables directly.
  }
}

function argument(name: string) {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();
}

function safeFailure(error: unknown) {
  return error instanceof DomainError
    ? { code: error.code, message: error.message }
    : {
        code: "UNEXPECTED_CLEANUP_FAILURE",
        message: "The record could not be cleaned up safely.",
      };
}

async function dependencies(shop: string, creatorProductId: string) {
  const [orderItems, sales, auditEvents] = await Promise.all([
    db.creatorOrderItem.count({ where: { shop, creatorProductId } }),
    db.creatorSale.findMany({
      where: { shop, creatorProductId },
      select: { id: true },
    }),
    db.auditLog.count({
      where: { shop, entityType: "CreatorProduct", entityId: creatorProductId },
    }),
  ]);
  const saleIds = sales.map((sale) => sale.id);
  const referralEarnings = saleIds.length
    ? await db.referralEarning.findMany({
        where: { shop, creatorSaleId: { in: saleIds } },
        select: { id: true },
      })
    : [];
  const earningIds = referralEarnings.map((earning) => earning.id);
  const payoutAllocations =
    saleIds.length || earningIds.length
      ? await db.payoutAllocation.findMany({
          where: {
            shop,
            OR: [
              ...(saleIds.length
                ? [{ sourceType: "PRODUCT_EARNING" as const, sourceId: { in: saleIds } }]
                : []),
              ...(earningIds.length
                ? [{ sourceType: "REFERRAL_EARNING" as const, sourceId: { in: earningIds } }]
                : []),
            ],
          },
          select: { payoutId: true },
        })
      : [];
  return {
    orderItems,
    sales: sales.length,
    earnings: sales.length + referralEarnings.length,
    referralEarnings: referralEarnings.length,
    payoutAllocations: payoutAllocations.length,
    payouts: new Set(payoutAllocations.map((allocation) => allocation.payoutId)).size,
    auditEvents,
    hasHistory:
      orderItems > 0 ||
      sales.length > 0 ||
      referralEarnings.length > 0 ||
      payoutAllocations.length > 0,
  };
}

async function main() {
  loadEnvFile();
  const shop = argument("shop") || process.env.SHOPIFY_SHOP || process.env.SHOP || "";
  if (!shop) throw new Error("Pass --shop=<myshopify-domain>.");
  const execute = argument("execute") === EXECUTE_CONFIRMATION;
  const expectedCount = Number(argument("expected-count") || "");
  const keepIds = new Set(
    (argument("keep") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const { admin } = await unauthenticated.admin(shop);
  const client = new AdminGraphqlClient(admin);
  const before = await listLegacyCompatibilityRecords(shop, client);
  const targets = before.records.filter(
    (record) =>
      !keepIds.has(record.id) &&
      ["NEEDS_REPAIR", "MISSING_MAPPING"].includes(record.compatibility.status),
  );
  const classified = [];
  for (const record of targets) {
    const history = await dependencies(shop, record.id);
    classified.push({
      id: record.id,
      title: record.title,
      creator: record.creator.displayName,
      publishedShopifyProductId: record.publishedShopifyProductId,
      compatibility: record.compatibility.status,
      classification: history.hasHistory ? "TEST_HAS_HISTORY" : "TEST_NO_HISTORY",
      plannedAction: history.hasHistory ? "ARCHIVE" : "ARCHIVE_THEN_DELETE",
      dependencies: history,
    });
  }
  const plan = {
    shop,
    mode: execute ? "EXECUTE" : "DRY_RUN",
    activeBefore: before.summary,
    targetCount: classified.length,
    testNoHistory: classified.filter((item) => !item.dependencies.hasHistory).length,
    testHasHistory: classified.filter((item) => item.dependencies.hasHistory).length,
    realProductsKept: before.records.filter((record) => keepIds.has(record.id)).map((record) => record.id),
    records: classified,
  };
  if (!execute) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount !== classified.length) {
    throw new Error(
      `Cleanup stopped: --expected-count must exactly match the current ${classified.length} classified records.`,
    );
  }
  const results = [];
  for (const item of classified) {
    try {
      const archived = await cleanupCreatorProductAsAdmin(
        shop,
        null,
        item.id,
        "ARCHIVE",
        client,
      );
      if (item.dependencies.hasHistory) {
        results.push({ id: item.id, outcome: "ARCHIVED", preservedHistory: archived.hasHistory });
        continue;
      }
      const deleted = await cleanupCreatorProductAsAdmin(
        shop,
        null,
        item.id,
        "DELETE",
        client,
      );
      results.push({ id: item.id, outcome: "DELETED", preservedHistory: false, hardDeleted: deleted.hardDeleted });
    } catch (error) {
      results.push({ id: item.id, outcome: "FAILED_SAFE", error: safeFailure(error) });
    }
  }
  const after = await listLegacyCompatibilityRecords(shop, client);
  const report = {
    ...plan,
    results,
    deleted: results.filter((item) => item.outcome === "DELETED").length,
    archived: results.filter((item) => item.outcome === "ARCHIVED").length,
    failedSafe: results.filter((item) => item.outcome === "FAILED_SAFE").length,
    activeAfter: after.summary,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.failedSafe > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Legacy cleanup failed safely.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

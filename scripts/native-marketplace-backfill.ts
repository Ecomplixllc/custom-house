import db from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { ensureShopifyCreatorCollection } from "../app/services/creator-collections.server";
import { publishCreatorProductToShopify } from "../app/services/creator-product-publishing.server";
import { AdminGraphqlClient } from "../app/services/shopify-graphql.server";

function loadEnvFile() {
  return import("node:fs").then(({ readFileSync }) => {
    try {
      for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match && !process.env[match[1]!.trim()]) {
          process.env[match[1]!.trim()] = match[2]!;
        }
      }
    } catch {
      // Vercel/runtime environments provide env vars directly.
    }
  });
}

async function main() {
  await loadEnvFile();
  const requestedShop = process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7);
  const shops = requestedShop
    ? [{ shop: requestedShop }]
    : await db.creator.findMany({
        where: { status: "APPROVED" },
        select: { shop: true },
        distinct: ["shop"],
      });
  const results = [];
  for (const { shop } of shops) {
    const { admin } = await unauthenticated.admin(shop);
    const client = new AdminGraphqlClient(admin);
    const creators = await db.creator.findMany({
      where: { shop, status: "APPROVED" },
      select: { id: true },
    });
    const creatorResults = [];
    for (const creator of creators) {
      const collection = await ensureShopifyCreatorCollection(shop, creator.id, client);
      creatorResults.push({
        creatorId: creator.id,
        shopifyCollectionId: collection?.shopifyCollectionId || null,
        collectionUrl: collection?.shopifyCollectionUrl || null,
      });
    }
    const products = await db.creatorProduct.findMany({
      where: { shop, status: "PUBLISHED", publishedShopifyProductId: null },
      select: { id: true },
    });
    const productResults = [];
    for (const product of products) {
      const published = await publishCreatorProductToShopify(shop, product.id, client);
      productResults.push({
        creatorProductId: product.id,
        shopifyProductId: published.publishedShopifyProductId,
        productUrl: published.publishedShopifyProductUrl,
      });
    }
    results.push({
      shop,
      collectionsBackfilled: creatorResults.length,
      productsBackfilled: productResults.length,
      creatorResults,
      productResults,
    });
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

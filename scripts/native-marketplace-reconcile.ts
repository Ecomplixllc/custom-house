import { readFileSync } from "node:fs";
import db from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { ensureShopifyCreatorCollection } from "../app/services/creator-collections.server";
import {
  AdminGraphqlClient,
  throwUserErrors,
} from "../app/services/shopify-graphql.server";

type Errors = Array<{ message: string }>;

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1]!.trim()]) {
        process.env[match[1]!.trim()] = match[2]!;
      }
    }
  } catch {
    // Runtime environments can provide env vars directly.
  }
}

async function productState(client: AdminGraphqlClient, productId: string) {
  const result = await client.request<{
    product: {
      id: string;
      creatorId: { value: string } | null;
      creatorProductId: { value: string } | null;
      creatorCollectionId: { value: string } | null;
      baseProductId: { value: string } | null;
      productOrigin: { value: string } | null;
      designMode: { value: string } | null;
      designStatus: { value: string } | null;
      productType: { value: string } | null;
      pitchprintDesignId: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      inkybayEnabled: { value: string } | null;
      customizerEnabled: { value: string } | null;
      legacyPitchprintDesignId: { value: string } | null;
      legacyPitchprintEnabled: { value: string } | null;
      legacyInkybayEnabled: { value: string } | null;
      collections: {
        nodes: Array<{
          id: string;
          handle: string;
          title: string;
          creatorId: { value: string } | null;
          creatorCollectionId: { value: string } | null;
        }>;
      };
    } | null;
  }>(
    `#graphql query NativeMarketplaceProductState($id: ID!) {
      product(id: $id) {
        id
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
        creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        baseProductId: metafield(namespace: "customhouse", key: "base_product_id") { value }
        productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
        customizerEnabled: metafield(namespace: "customhouse", key: "customizer_enabled") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        legacyPitchprintEnabled: metafield(namespace: "pitchprint", key: "enabled") { value }
        legacyInkybayEnabled: metafield(namespace: "inkybay", key: "enabled") { value }
        collections(first: 250) {
          nodes {
            id
            handle
            title
            creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
            creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
          }
        }
      }
    }`,
    { id: productId },
  );
  return result.product;
}

async function setProductMetafields(
  client: AdminGraphqlClient,
  input: {
    productId: string;
    creatorId: string;
    creatorProductId: string;
    creatorCollectionId: string;
    baseProductId: string;
  },
) {
  const result = await client.request<{ metafieldsSet: { userErrors: Errors } }>(
    `#graphql mutation NativeMarketplaceProductMetafieldRepair($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        ["creator_id", input.creatorId],
        ["creator_product_id", input.creatorProductId],
        ["creator_collection_id", input.creatorCollectionId],
        ["base_product_id", input.baseProductId],
        ["product_origin", "creator"],
        ["design_mode", "buy_only"],
        ["design_status", "published"],
        ["creator_publishing_enabled", "true"],
        ["product_type", "creator_fixed"],
        ["design_locked", "true"],
      ].map(([key, value]) => ({
        ownerId: input.productId,
        namespace: "customhouse",
        key,
        type: key === "design_locked" || key === "creator_publishing_enabled" ? "boolean" : "single_line_text_field",
        value,
      })),
    },
  );
  throwUserErrors(result.metafieldsSet.userErrors, "Native marketplace product metafields");
}

async function deleteCustomizationTriggers(client: AdminGraphqlClient, productId: string) {
  const result = await client.request<{ metafieldsDelete: { userErrors: Errors } }>(
    `#graphql mutation NativeMarketplaceCustomizationTriggerCleanup($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { userErrors { message } }
    }`,
    {
      metafields: [
        { ownerId: productId, namespace: "customhouse", key: "pitchprint_design_id" },
        { ownerId: productId, namespace: "customhouse", key: "pitchprint_enabled" },
        { ownerId: productId, namespace: "customhouse", key: "inkybay_enabled" },
        { ownerId: productId, namespace: "customhouse", key: "customizer_enabled" },
        { ownerId: productId, namespace: "customhouse", key: "customization_enabled" },
        { ownerId: productId, namespace: "customhouse", key: "design_id" },
        { ownerId: productId, namespace: "pitchprint", key: "design_id" },
        { ownerId: productId, namespace: "pitchprint", key: "enabled" },
        { ownerId: productId, namespace: "inkybay", key: "enabled" },
        { ownerId: productId, namespace: "inkybay", key: "design_id" },
      ],
    },
  );
  throwUserErrors(result.metafieldsDelete.userErrors, "Native marketplace customization cleanup");
}

async function addToCollection(
  client: AdminGraphqlClient,
  collectionId: string,
  productId: string,
) {
  const result = await client.request<{ collectionAddProductsV2: { userErrors: Errors } }>(
    `#graphql mutation NativeMarketplaceAddProduct($id: ID!, $productIds: [ID!]!) {
      collectionAddProductsV2(id: $id, productIds: $productIds) {
        userErrors { message }
      }
    }`,
    { id: collectionId, productIds: [productId] },
  );
  throwUserErrors(result.collectionAddProductsV2.userErrors, "Native marketplace collection add");
}

async function removeFromCollection(
  client: AdminGraphqlClient,
  collectionId: string,
  productId: string,
) {
  const result = await client.request<{ collectionRemoveProducts: { userErrors: Errors } }>(
    `#graphql mutation NativeMarketplaceRemoveProduct($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        userErrors { message }
      }
    }`,
    { id: collectionId, productIds: [productId] },
  );
  throwUserErrors(
    result.collectionRemoveProducts.userErrors,
    "Native marketplace collection remove",
  );
}

async function main() {
  loadEnvFile();
  if (!process.env.SHOPIFY_APP_URL?.startsWith("https://")) {
    process.env.SHOPIFY_APP_URL = "https://custom-house.vercel.app";
  }
  const shop =
    process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7) ||
    process.env.SHOP;
  if (!shop) throw new Error("Pass --shop=<myshopify-domain>.");
  const apply = process.argv.includes("--apply");
  const { admin } = await unauthenticated.admin(shop);
  const client = new AdminGraphqlClient(admin);
  const creators = await db.creator.findMany({
    where: { shop, status: "APPROVED" },
    select: {
      id: true,
      marketplaceCollection: true,
      creatorProducts: {
        where: { status: "PUBLISHED", publishedShopifyProductId: { not: null } },
        select: {
          id: true,
          creatorId: true,
          shopifyProductId: true,
          publishedShopifyProductId: true,
        },
      },
    },
  });
  const actions = [];
  for (const creator of creators) {
    const collection = apply
      ? await ensureShopifyCreatorCollection(shop, creator.id, client)
      : creator.marketplaceCollection;
    if (!collection?.shopifyCollectionId) {
      actions.push({ creatorId: creator.id, action: "blocked", reason: "missing canonical collection" });
      continue;
    }
    for (const product of creator.creatorProducts) {
      const productId = product.publishedShopifyProductId!;
      const state = await productState(client, productId);
      if (!state) {
        actions.push({ creatorId: creator.id, creatorProductId: product.id, action: "blocked", reason: "native product missing" });
        continue;
      }
      const metafieldMismatch =
        state.creatorId?.value !== creator.id ||
        state.creatorProductId?.value !== product.id ||
        state.creatorCollectionId?.value !== collection.id ||
        state.baseProductId?.value !== product.shopifyProductId ||
        state.productOrigin?.value !== "creator" ||
        state.designMode?.value !== "buy_only" ||
        state.designStatus?.value !== "published" ||
        state.productType?.value !== "creator_fixed";
      if (metafieldMismatch) {
        actions.push({ creatorId: creator.id, creatorProductId: product.id, action: "repair-product-metafields", apply });
        if (apply) {
          await setProductMetafields(client, {
            productId,
            creatorId: creator.id,
            creatorProductId: product.id,
            creatorCollectionId: collection.id,
            baseProductId: product.shopifyProductId,
          });
        }
      }
      const customizationTriggers = [
        state.pitchprintDesignId?.value,
        state.pitchprintEnabled?.value,
        state.inkybayEnabled?.value,
        state.customizerEnabled?.value,
        state.legacyPitchprintDesignId?.value,
        state.legacyPitchprintEnabled?.value,
        state.legacyInkybayEnabled?.value,
      ].filter(Boolean);
      if (customizationTriggers.length) {
        actions.push({
          creatorId: creator.id,
          creatorProductId: product.id,
          action: "remove-customization-trigger-metafields",
          apply,
        });
        if (apply) await deleteCustomizationTriggers(client, productId);
      }
      const inCanonical = state.collections.nodes.some(
        (item) => item.id === collection.shopifyCollectionId,
      );
      if (!inCanonical) {
        actions.push({ creatorId: creator.id, creatorProductId: product.id, action: "add-to-canonical-collection", collectionId: collection.shopifyCollectionId, apply });
        if (apply) await addToCollection(client, collection.shopifyCollectionId, productId);
      }
      const removableWrongCollections = state.collections.nodes.filter(
        (item) =>
          item.id !== collection.shopifyCollectionId &&
          item.creatorId?.value === creator.id &&
          item.creatorCollectionId?.value === collection.id,
      );
      for (const wrong of removableWrongCollections) {
        actions.push({ creatorId: creator.id, creatorProductId: product.id, action: "remove-from-duplicate-canonical-collection", collectionId: wrong.id, title: wrong.title, apply });
        if (apply) await removeFromCollection(client, wrong.id, productId);
      }
    }
  }
  console.log(JSON.stringify({ ok: true, mode: apply ? "apply" : "dry-run", actions }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });

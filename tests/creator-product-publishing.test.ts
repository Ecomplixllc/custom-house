import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  synchronizeBakedCreatorProductPricing,
  type CreatorProductForPublish,
} from "../app/services/creator-product-publishing.server.ts";
import { parseSurchargeInput } from "../app/services/production-method-pricing.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

const baseProductId = "gid://shopify/Product/10";
const publishedProductId = "gid://shopify/Product/50";

const product: CreatorProductForPublish = {
  id: "creator-product-new-1",
  shop: "customhouse.test",
  creatorId: "creator-1",
  shopifyProductId: baseProductId,
  baseProductTitle: "T-shirt",
  pitchprintProjectId: "pp-project",
  pitchprintDesignId: "pp-design",
  title: "Creator T-shirt",
  description: null,
  previewUrl: "https://cdn.test/front.png",
  previewUrls: "[]",
  designVariantSelectionsJson: "{}",
  status: "PENDING",
  publishedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  creator: { id: "creator-1", displayName: "Creator", status: "APPROVED" },
};

const setup = {
  schema: "creator_design_setup_v1" as const,
  flowMode: "CREATOR_DESIGN" as const,
  productOrigin: "global" as const,
  designMode: "creator_design" as const,
  isCreatorProduct: true as const,
  fixedColor: "Green",
  selectedColors: ["Green"],
  productionMethod: "EMBROIDERY" as const,
  embroiderySubtype: "TEXT_ONLY" as const,
  placementCount: 1,
  placements: ["Front"],
  copyrightAccepted: true,
  nonReturnAcknowledged: true,
  savedAt: "2026-10-01T00:00:00.000Z",
};

const pricing = {
  embroiderySurcharge: parseSurchargeInput("99"),
  embroideryTextSurcharge: parseSurchargeInput("100"),
  embroideryImageSurcharge: parseSurchargeInput("250"),
  dtfSurcharge: parseSurchargeInput("75"),
  dtgSurcharge: parseSurchargeInput("50"),
  embroideryFeeVariantId: null,
  embroideryTextFeeVariantId: null,
  embroideryImageFeeVariantId: null,
  dtfFeeVariantId: null,
  dtgFeeVariantId: null,
};

function publishingClient() {
  const products = new Map([
    [
      baseProductId,
      [
        {
          id: "gid://shopify/ProductVariant/101",
          price: "200.00",
          selectedOptions: [
            { name: "Color", value: "Green" },
            { name: "Size", value: "S" },
          ],
        },
        {
          id: "gid://shopify/ProductVariant/102",
          price: "220.00",
          selectedOptions: [
            { name: "Color", value: "Green" },
            { name: "Size", value: "M" },
          ],
        },
      ],
    ],
    [
      publishedProductId,
      [
        {
          id: "gid://shopify/ProductVariant/501",
          price: "200.00",
          selectedOptions: [
            { name: "Size", value: "S" },
            { name: "Color", value: "Green" },
          ],
        },
        {
          id: "gid://shopify/ProductVariant/502",
          price: "220.00",
          selectedOptions: [
            { name: "Size", value: "M" },
            { name: "Color", value: "Green" },
          ],
        },
      ],
    ],
  ]);
  let pricingMode = "";
  let validation: unknown = null;
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      calls.push({ query, variables: variables || {} });
      if (query.includes("NativeCreatorProductVariants")) {
        const id = String(variables?.id || "");
        return {
          product: {
            variants: {
              nodes: products.get(id) || [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T;
      }
      if (query.includes("BakeNativeCreatorVariantPrices")) {
        const updates = (variables?.variants || []) as Array<{ id: string; price: string }>;
        const published = products.get(publishedProductId) || [];
        for (const update of updates) {
          const variant = published.find((item) => item.id === update.id);
          if (variant) variant.price = update.price;
        }
        return { productVariantsBulkUpdate: { userErrors: [] } } as T;
      }
      if (query.includes("NativeCreatorProductPricingMetafields")) {
        const metafields = (variables?.metafields || []) as Array<{
          key: string;
          value: string;
        }>;
        pricingMode = metafields.find((item) => item.key === "creator_pricing_mode")?.value || "";
        validation = JSON.parse(
          metafields.find((item) => item.key === "creator_cart_validation")?.value || "null",
        );
        return { metafieldsSet: { userErrors: [] } } as T;
      }
      if (query.includes("VerifyNativeCreatorProductPricing")) {
        return {
          product: {
            pricingMode: { value: pricingMode },
            validation: { jsonValue: validation },
          },
        } as T;
      }
      throw new Error("Unexpected GraphQL operation in publishing test");
    },
  };
  return { client, products, calls };
}

test("publishing synchronizes per-size baked prices and no-fee metadata", async () => {
  const state = publishingClient();
  const result = await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {
      id: "collection-1",
      shop: "customhouse.test",
      creatorId: "creator-1",
      publicId: "public-1",
      publicHandle: "creator",
      displayName: "Creator Designs",
      bannerImageUrl: null,
      bannerTitle: null,
      bannerSubtitle: null,
      status: "ACTIVE",
      shopifyCollectionId: "gid://shopify/Collection/1",
      shopifyCollectionHandle: "creator-designs",
      shopifyCollectionUrl: "/collections/creator-designs",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    setup,
    pricing,
  });

  assert.deepEqual(
    state.products.get(publishedProductId)?.map((variant) => variant.price),
    ["300.00", "320.00"],
  );
  assert.equal(result.pricingPlan.pricingMode, "BAKED_IN_V1");
  assert.deepEqual(result.cartValidationContract, {
    version: 1,
    creatorProductId: product.id,
    feeRequired: false,
    feeVariantId: null,
    placementCount: 1,
  });
  const priceMutation = state.calls.find((call) =>
    call.query.includes("BakeNativeCreatorVariantPrices"),
  );
  assert.deepEqual(priceMutation?.variables.variants, [
    { id: "gid://shopify/ProductVariant/501", price: "300.00" },
    { id: "gid://shopify/ProductVariant/502", price: "320.00" },
  ]);
});

test("republishing an already baked product does not compound prices", async () => {
  const state = publishingClient();
  await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {} as never,
    setup,
    pricing,
  });
  await synchronizeBakedCreatorProductPricing(state.client, {
    product,
    publishedProductId,
    collection: {} as never,
    setup,
    pricing,
  });
  assert.deepEqual(
    state.products.get(publishedProductId)?.map((variant) => variant.price),
    ["300.00", "320.00"],
  );
});

test("publishing verifies shared inventory before database publication and storefront exposure", () => {
  const source = readFileSync(
    new URL("../app/services/creator-product-publishing.server.ts", import.meta.url),
    "utf8",
  );
  const publishFlow = source.slice(source.indexOf("export async function publishCreatorProductToShopify"));
  const activate = publishFlow.indexOf("await activateProduct");
  const inventory = publishFlow.indexOf("await ensureCreatorProductSharedInventoryRelationships");
  const databasePublish = publishFlow.indexOf("database.creatorProduct.update");
  const storefrontPublish = publishFlow.indexOf("await publishResource");
  assert.ok(activate >= 0);
  assert.ok(inventory > activate);
  assert.ok(databasePublish > inventory);
  assert.ok(storefrontPublish > databasePublish);
  assert.match(publishFlow, /CREATOR_SHARED_INVENTORY_SETUP_FAILED/);
});

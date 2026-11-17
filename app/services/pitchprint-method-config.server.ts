import { DomainError } from "./domain.ts";
import { inkyBayProductContract } from "./inkybay/inkybay-product.server.ts";
import { getProductionPricingBridgeForProduct } from "./production-method-pricing.server.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";

export async function publicPitchPrintMethodConfig(
  shop: string,
  productId: string,
  client: ShopifyGraphqlClient,
  database?: Parameters<typeof getProductionPricingBridgeForProduct>[2],
) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new DomainError("INVALID_PRODUCT", "Choose a valid product.", 422);
  }
  const { product, shop: shopData } = await client.request<{
    shop: { currencyCode: string };
    product: null | {
      id: string; handle: string; status: string; tags: string[];
      productType: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      legacyOrigin: { value: string } | null;
      legacyMode: { value: string } | null;
    };
  }>(`#graphql query PublicPitchPrintMethodConfig($id: ID!) {
    shop { currencyCode }
    product(id: $id) {
      id handle status tags
      productType: metafield(namespace: "customhouse", key: "product_type") { value }
      pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
      legacyOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
      legacyMode: metafield(namespace: "customhouse", key: "design_mode") { value }
    }
  }`, { id: productId });
  const legacyGlobal = product?.legacyOrigin?.value === "global" &&
    product.legacyMode?.value === "customizable";
  const contract = product && inkyBayProductContract({
    productType: legacyGlobal ? "global_customizable" : product.productType?.value || null,
    pitchPrintEnabled: legacyGlobal || product.pitchprintEnabled?.value === "true",
    inkyBayEnabled: false,
    creatorPublishingEnabled: false,
    tags: product.tags,
  });
  if (!product || product.status !== "ACTIVE" || !contract?.isGlobalCustomizable) {
    throw new DomainError("PRODUCT_NOT_AVAILABLE", "This product cannot be customized.", 404);
  }
  const pricing = await getProductionPricingBridgeForProduct(shop, productId, database);
  return {
    ...pricing,
    productId,
    baseProductId: productId,
    productHandle: product.handle,
    currency: pricing?.currency || shopData.currencyCode,
    productionMethods: pricing?.productionMethods || [],
    productionMethodsResolved: true,
  };
}

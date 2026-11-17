import { DomainError } from "../domain.ts";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server.ts";

export type VerifiedInkyBayProduct = {
  id: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  tags: string[];
  variants: Array<{
    id: string;
    title: string;
    availableForSale: boolean;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

export function inkyBayProductContract(input: {
  productType: string | null;
  inkyBayEnabled: boolean;
  pitchPrintEnabled?: boolean;
  creatorPublishingEnabled: boolean;
  tags: string[];
}) {
  const tags = new Set(input.tags.map((tag) => tag.trim().toLowerCase()));
  const isCreatorFixed =
    input.productType === "creator_fixed" || tags.has("creator-fixed");
  const hasLegacyInkyBayTag =
    tags.has("inkybay-designlab") || tags.has("inkybay-options");
  const hasPitchPrintTag =
    tags.has("pitchprint") ||
    tags.has("pitchprint-enabled") ||
    tags.has("pitchprint-designlab") ||
    tags.has("pitchprint-options");
  const isGlobalCustomizable = Boolean(
    !isCreatorFixed &&
    ((input.productType === "global_customizable" &&
      (input.inkyBayEnabled || input.pitchPrintEnabled)) ||
      Boolean(input.pitchPrintEnabled) ||
      hasLegacyInkyBayTag ||
      hasPitchPrintTag),
  );
  return {
    isCreatorFixed,
    isGlobalCustomizable,
    creatorPublishingEnabled: Boolean(
      isGlobalCustomizable && input.creatorPublishingEnabled,
    ),
  };
}

export async function verifyInkyBayGlobalProduct(
  client: ShopifyGraphqlClient,
  productId: string,
  variantId?: string | null,
) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new DomainError(
      "SOURCE_PRODUCT_INVALID",
      "Choose a valid source product.",
      422,
    );
  }
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      handle: string;
      status: string;
      tags: string[];
      featuredImage: { url: string } | null;
      productType: { value: string } | null;
      inkybayEnabled: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      creatorPublishingEnabled: { value: string } | null;
      legacyOrigin: { value: string } | null;
      legacyMode: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          title: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query InkyBayCreatorSource($id: ID!) {
      product(id: $id) {
        id title handle status tags
        featuredImage { url }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        creatorPublishingEnabled: metafield(namespace: "customhouse", key: "creator_publishing_enabled") { value }
        legacyOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        legacyMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        variants(first: 100) {
          nodes { id title availableForSale selectedOptions { name value } }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  const legacyGlobal = Boolean(
    product?.legacyOrigin?.value === "global" &&
    product.legacyMode?.value === "customizable",
  );
  const contract = product
    ? inkyBayProductContract({
        productType: legacyGlobal
          ? "global_customizable"
          : product.productType?.value || null,
        inkyBayEnabled:
          legacyGlobal || product.inkybayEnabled?.value === "true",
        pitchPrintEnabled:
          legacyGlobal || product.pitchprintEnabled?.value === "true",
        creatorPublishingEnabled:
          product.creatorPublishingEnabled?.value === "true",
        tags: product.tags,
      })
    : null;
  if (
    !product ||
    product.status !== "ACTIVE" ||
    !contract?.isGlobalCustomizable ||
    !contract.creatorPublishingEnabled
  ) {
    throw new DomainError(
      "SOURCE_PRODUCT_NOT_ELIGIBLE",
      "This product is not enabled for creator publishing.",
      409,
    );
  }
  if (variantId) {
    const variant = product.variants.nodes.find(
      (item) => item.id === variantId,
    );
    if (!variant?.availableForSale) {
      throw new DomainError(
        "SOURCE_VARIANT_UNAVAILABLE",
        "The selected product option is unavailable.",
        409,
      );
    }
  }
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: product.featuredImage?.url || null,
    tags: product.tags,
    variants: product.variants.nodes,
  } satisfies VerifiedInkyBayProduct;
}

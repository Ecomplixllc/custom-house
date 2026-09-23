import db from "../db.server";

type ShopifyOrderWebhook = {
  id?: string | number;
  name?: string;
  line_items?: Array<{
    id?: string | number;
    product_id?: string | number;
    variant_id?: string | number;
    title?: string;
  }>;
};

function gid(type: "Order" | "Product" | "ProductVariant", value: unknown) {
  const id = String(value || "").trim();
  return /^\d+$/.test(id) ? `gid://shopify/${type}/${id}` : "";
}

export async function snapshotCreatorFixedOrder(
  shop: string,
  payload: unknown,
) {
  const order = payload as ShopifyOrderWebhook;
  const orderId = gid("Order", order.id);
  const lines = Array.isArray(order.line_items) ? order.line_items : [];
  if (!orderId || !lines.length) return { created: 0 };
  const productIds = [
    ...new Set(
      lines.map((line) => gid("Product", line.product_id)).filter(Boolean),
    ),
  ];
  if (!productIds.length) return { created: 0 };
  const designs = await db.creatorDesign.findMany({
    where: {
      shop,
      shopifyCreatorProductId: { in: productIds },
      productionArtworkKey: { not: null },
    },
    include: { creator: { select: { displayName: true } } },
  });
  const byProduct = new Map(
    designs.map((design) => [design.shopifyCreatorProductId, design]),
  );
  let created = 0;
  for (const line of lines) {
    const productId = gid("Product", line.product_id);
    const variantId = gid("ProductVariant", line.variant_id);
    const lineId = String(line.id || "").trim();
    const design = byProduct.get(productId);
    if (!design || !variantId || !lineId) continue;
    const result = await db.orderDesignSnapshot.createMany({
      data: [
        {
          shop,
          shopifyOrderId: orderId,
          shopifyLineItemId: lineId,
          provider: design.provider,
          creatorId: design.creatorId,
          creatorDesignId: design.id,
          sourceShopifyProductId: design.globalShopifyProductId,
          shopifyCreatorProductId: productId,
          shopifyVariantId: variantId,
          designVersion: design.designVersion,
          previewUrl: design.previewUrl,
          productionArtworkKey: design.productionArtworkKey,
          printFilesStatus: "AVAILABLE",
          designTitle: design.title,
          creatorName: design.creator.displayName,
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
  }
  return { created };
}

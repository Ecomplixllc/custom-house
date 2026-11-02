import { Prisma } from "@prisma/client";

export const CREATOR_COMMISSION_BASIS_POINTS = 1_000;

type MoneyInput = string | number | null | undefined;

type PaidOrderPayload = {
  id?: string | number;
  admin_graphql_api_id?: string;
  name?: string;
  order_number?: string | number;
  currency?: string;
  financial_status?: string;
  processed_at?: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
  };
  email?: string;
  line_items?: Array<{
    id?: string | number;
    product_id?: string | number;
    variant_id?: string | number;
    title?: string;
    variant_title?: string;
    variant_options?: string[];
    quantity?: number;
    price?: MoneyInput;
    discount_allocations?: Array<{ amount?: MoneyInput }>;
    properties?: Array<{ name?: string; value?: string }>;
  }>;
};

type RefundPayload = {
  id?: string | number;
  order_id?: string | number;
  refund_line_items?: Array<{
    id?: string | number;
    line_item_id?: string | number;
    quantity?: number;
    subtotal?: MoneyInput;
  }>;
};

function gid(
  type: "Order" | "Product" | "ProductVariant",
  value: unknown,
) {
  const id = String(value || "").trim();
  if (id.startsWith(`gid://shopify/${type}/`)) return id;
  return /^\d+$/.test(id) ? `gid://shopify/${type}/${id}` : "";
}

function decimal(value: MoneyInput) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) return null;
  return new Prisma.Decimal(normalized);
}

function safeQuantity(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : 0;
}

export type CreatorPaidLine = {
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  shopifyLineItemId: string;
  shopifyProductId: string;
  shopifyVariantId: string | null;
  creatorProductId: string | null;
  creatorCollectionId: string | null;
  pitchprintProjectId: string | null;
  creatorPreviewUrl: string | null;
  creatorDesignTitle: string | null;
  creatorName: string | null;
  attributionToken: string | null;
  productTitle: string;
  customerDisplayName: string | null;
  variantTitle: string | null;
  selectedOptionsJson: string;
  quantity: number;
  currencyCode: string;
  unitPrice: Prisma.Decimal;
  grossSalesAmount: Prisma.Decimal;
  paidAt: Date | null;
  bundleGroupId: string | null;
  bundleParentProductId: string | null;
  bundleParentVariantId: string | null;
  bundleParentQuantity: number | null;
};

export type CreatorBundleLineContext = {
  shopifyLineItemId: string;
  componentProductId: string;
  componentVariantId: string;
  bundleGroupId: string;
  parentProductId: string;
  parentVariantId: string;
  parentQuantity: number;
  allocatedTotal: string;
  currencyCode: string;
  customAttributes: Array<{ key: string; value: string }>;
};

export function bundleLineMatchesCreatorProduct(
  line: Pick<
    CreatorPaidLine,
    | "bundleGroupId"
    | "bundleParentProductId"
    | "bundleParentVariantId"
    | "bundleParentQuantity"
    | "shopifyProductId"
    | "shopifyVariantId"
    | "quantity"
  >,
  product: {
    shopifyProductId: string;
    publishedShopifyProductId: string | null;
    baseVariantMappingJson: string;
  },
) {
  if (!line.bundleGroupId) return true;
  if (
    !line.bundleParentProductId ||
    !line.bundleParentVariantId ||
    !line.shopifyVariantId ||
    line.bundleParentProductId !== product.publishedShopifyProductId ||
    line.shopifyProductId !== product.shopifyProductId ||
    line.bundleParentQuantity !== line.quantity
  ) {
    return false;
  }
  try {
    const mapping = JSON.parse(product.baseVariantMappingJson || "{}");
    return Boolean(
      mapping &&
      typeof mapping === "object" &&
      !Array.isArray(mapping) &&
      mapping[line.bundleParentVariantId] === line.shopifyVariantId,
    );
  } catch {
    return false;
  }
}

export function creatorProductForBundleLine<
  T extends {
    shopifyProductId: string;
    publishedShopifyProductId: string | null;
    baseVariantMappingJson: string;
  },
>(
  line: Pick<
    CreatorPaidLine,
    | "bundleGroupId"
    | "bundleParentProductId"
    | "bundleParentVariantId"
    | "bundleParentQuantity"
    | "shopifyProductId"
    | "shopifyVariantId"
    | "quantity"
  >,
  products: T[],
) {
  if (!line.bundleGroupId || !line.bundleParentProductId) return null;
  const matches = products.filter(
    (product) =>
      product.publishedShopifyProductId === line.bundleParentProductId &&
      bundleLineMatchesCreatorProduct(line, product),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function lineProperty(
  properties: Array<{ name?: string; value?: string }> | undefined,
  key: string,
) {
  const match = Array.isArray(properties)
    ? properties.find((property) => property.name === key)
    : null;
  const value = String(match?.value || "").trim();
  return /^[a-z0-9]{20,40}$/i.test(value) ? value : null;
}

function lineStringProperty(
  properties: Array<{ name?: string; value?: string }> | undefined,
  key: string,
) {
  const match = Array.isArray(properties)
    ? properties.find((property) => property.name === key)
    : null;
  const value = String(match?.value || "").trim();
  return value.length > 0 && value.length <= 3000 ? value : null;
}

function publicLineStringProperty(
  properties: Array<{ name?: string; value?: string }> | undefined,
  key: string,
) {
  const value = lineStringProperty(properties, key);
  return value ? value.slice(0, 255) : null;
}

function lineHttpsProperty(
  properties: Array<{ name?: string; value?: string }> | undefined,
  key: string,
) {
  const value = lineStringProperty(properties, key);
  return value?.startsWith("https://") ? value : null;
}

function orderName(order: PaidOrderPayload) {
  const name = String(order.name || "").trim();
  if (name) return name.slice(0, 80);
  const orderNumber = String(order.order_number || "").trim();
  return orderNumber ? `#${orderNumber}`.slice(0, 80) : null;
}

function customerDisplayName(order: PaidOrderPayload) {
  const customer = order.customer;
  const name = [customer?.first_name, customer?.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const email = String(customer?.email || order.email || "").trim();
  return (name || email || null)?.slice(0, 255) || null;
}

export function parsePaidOrder(
  payload: unknown,
  bundleContexts: CreatorBundleLineContext[] = [],
): CreatorPaidLine[] {
  const order = (payload || {}) as PaidOrderPayload;
  const shopifyOrderId = gid(
    "Order",
    order.admin_graphql_api_id || order.id,
  );
  const currencyCode = String(order.currency || "")
    .trim()
    .toUpperCase();
  const paidAt = order.processed_at ? new Date(order.processed_at) : null;
  if (
    !shopifyOrderId ||
    !/^[A-Z]{3}$/.test(currencyCode) ||
    (order.financial_status && order.financial_status !== "paid") ||
    (paidAt && Number.isNaN(paidAt.getTime()))
  ) {
    return [];
  }

  const bundleByLineItemId = new Map(
    bundleContexts.map((context) => [context.shopifyLineItemId, context]),
  );

  return (Array.isArray(order.line_items) ? order.line_items : []).flatMap(
    (line): CreatorPaidLine[] => {
      const shopifyLineItemId = String(line.id || "").trim();
      const shopifyProductId = gid("Product", line.product_id);
      const shopifyVariantId = gid("ProductVariant", line.variant_id) || null;
      const quantity = safeQuantity(line.quantity);
      const bundle = bundleByLineItemId.get(shopifyLineItemId);
      const bundleParentProductId = bundle
        ? gid("Product", bundle.parentProductId)
        : "";
      const bundleParentVariantId = bundle
        ? gid("ProductVariant", bundle.parentVariantId)
        : "";
      const bundleParentQuantity = bundle
        ? safeQuantity(bundle.parentQuantity)
        : 0;
      const bundleProperties = bundle?.customAttributes.map((attribute) => ({
        name: attribute.key,
        value: attribute.value,
      }));
      const properties = bundle ? bundleProperties : line.properties;
      const allocatedTotal = bundle ? decimal(bundle.allocatedTotal) : null;
      const unitPrice = bundle && allocatedTotal && quantity
        ? allocatedTotal.div(quantity)
        : decimal(line.price);
      if (
        !shopifyLineItemId ||
        !shopifyProductId ||
        !quantity ||
        !unitPrice ||
        (bundle && (
          bundle.componentProductId !== shopifyProductId ||
          bundle.componentVariantId !== shopifyVariantId ||
          !bundle.bundleGroupId ||
          !bundleParentProductId ||
          !bundleParentVariantId ||
          !bundleParentQuantity ||
          bundleParentQuantity !== quantity ||
          bundle.currencyCode.toUpperCase() !== currencyCode ||
          !allocatedTotal
        ))
      ) {
        return [];
      }
      const lineTotal = Prisma.Decimal.max(
        bundle && allocatedTotal ? allocatedTotal : unitPrice.mul(quantity),
        0,
      );
      return [
        {
          shopifyOrderId,
          shopifyOrderName: orderName(order),
          shopifyLineItemId,
          shopifyProductId,
          shopifyVariantId,
          creatorProductId: lineProperty(
            properties,
            "_creator_product_id",
          ),
          creatorCollectionId: lineProperty(
            properties,
            "_creator_collection_id",
          ),
          pitchprintProjectId: lineStringProperty(
            properties,
            "_pitchprint",
          ),
          creatorPreviewUrl: lineHttpsProperty(
            properties,
            "_creator_preview_url",
          ),
          creatorDesignTitle: publicLineStringProperty(
            properties,
            "_creator_design_title",
          ) || publicLineStringProperty(properties, "Creator Design"),
          creatorName:
            publicLineStringProperty(properties, "_creator_name") ||
            publicLineStringProperty(properties, "Creator"),
          attributionToken: lineStringProperty(
            properties,
            "_customhouse_attribution",
          ),
          productTitle: String(line.title || "Creator product")
            .trim()
            .slice(0, 255),
          customerDisplayName: customerDisplayName(order),
          variantTitle: String(line.variant_title || "")
            .trim()
            .slice(0, 255) || null,
          selectedOptionsJson: JSON.stringify(
            Array.isArray(line.variant_options)
              ? line.variant_options.map((value) => String(value).slice(0, 100))
              : [],
          ),
          quantity,
          currencyCode,
          unitPrice,
          grossSalesAmount: lineTotal,
          paidAt,
          bundleGroupId: bundle?.bundleGroupId || null,
          bundleParentProductId: bundleParentProductId || null,
          bundleParentVariantId: bundleParentVariantId || null,
          bundleParentQuantity: bundleParentQuantity || null,
        },
      ];
    },
  );
}

export type CreatorRefundLine = {
  adjustmentKey: string;
  shopifyOrderId: string;
  shopifyLineItemId: string;
  quantity: number;
  salesAmount: Prisma.Decimal;
};

export function parseRefund(payload: unknown): CreatorRefundLine[] {
  const refund = (payload || {}) as RefundPayload;
  const shopifyOrderId = gid("Order", refund.order_id);
  if (!shopifyOrderId) return [];
  return (Array.isArray(refund.refund_line_items)
    ? refund.refund_line_items
    : []
  ).flatMap((line): CreatorRefundLine[] => {
    const shopifyLineItemId = String(line.line_item_id || "").trim();
    const refundLineItemId = String(line.id || "").trim();
    const quantity = safeQuantity(line.quantity);
    const amount = decimal(line.subtotal)?.abs();
    if (!shopifyLineItemId || !refundLineItemId || !quantity || !amount) {
      return [];
    }
    return [
      {
        adjustmentKey: `refund-line:${refundLineItemId}`,
        shopifyOrderId,
        shopifyLineItemId,
        quantity,
        salesAmount: amount,
      },
    ];
  });
}

export function creatorEarning(
  salesAmount: Prisma.Decimal,
  commissionRateBps = CREATOR_COMMISSION_BASIS_POINTS,
) {
  return salesAmount.mul(commissionRateBps).div(10_000);
}

import { CreatorOrderProductionStatus, Prisma } from "@prisma/client";
import db from "../db.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { creatorEarning, type CreatorPaidLine } from "./creator-sales";
import {
  getCreatorCollectionStorefrontUrl,
  getCreatorProductStorefrontUrl,
} from "./creator-storefront-urls";
import { DomainError } from "./domain";
import { correlationId, safeDiagnostic } from "./observability.server";

type CreatorOrderOwner = {
  creatorId: string;
  creatorProductId: string | null;
};

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function previewUrlsForProduct(product: { previewUrls: string }) {
  try {
    const parsed = JSON.parse(product.previewUrls || "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.startsWith("https://"),
        )
      : [];
  } catch {
    return [];
  }
}

function creatorPreviewForLine(
  line: CreatorPaidLine,
  product: { previewUrl: string | null; previewUrls: string },
) {
  if (line.creatorPreviewUrl?.startsWith("https://")) return line.creatorPreviewUrl;
  if (product.previewUrl?.startsWith("https://")) return product.previewUrl;
  return previewUrlsForProduct(product)[0] || null;
}

export function toShopifyOrderGid(orderId: string) {
  const value = String(orderId || "").trim();
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Order/${value}`;
  return value;
}

export function toShopifyLineItemGid(lineItemId: string) {
  const value = String(lineItemId || "").trim();
  if (/^gid:\/\/shopify\/LineItem\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/LineItem/${value}`;
  return value;
}

function cleanOptionValue(value: string) {
  const trimmed = value.trim();
  return trimmed && !/^default(?: title)?$/i.test(trimmed) ? trimmed : "";
}

export function selectedOptions(item: { selectedOptionsJson: string }) {
  try {
    const parsed = JSON.parse(item.selectedOptionsJson || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) =>
        typeof value === "object" && value !== null && "value" in value
          ? String((value as { value: unknown }).value)
          : String(value),
      )
      .map(cleanOptionValue)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function creatorOrderVariantLabel(item: {
  variantTitleSnapshot: string | null;
  selectedOptionsJson: string;
}) {
  const options = selectedOptions(item);
  const snapshot = cleanOptionValue(item.variantTitleSnapshot || "");
  if (snapshot && !/^default(?: title)?$/i.test(snapshot)) return snapshot;
  if (options.length) return options.join(" / ");
  return "Standard";
}

export function pitchPrintRenderUrl(projectId: string, format: "pdf" | "png") {
  const safeProjectId = String(projectId || "").trim();
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(safeProjectId)) {
    throw new DomainError(
      "INVALID_PITCHPRINT_PROJECT",
      "PitchPrint project reference is invalid.",
      422,
    );
  }
  return `https://${format}.pitchprint.com/${encodeURIComponent(safeProjectId)}`;
}

function hasPrefix(buffer: Buffer, prefix: number[]) {
  return prefix.every((value, index) => buffer[index] === value);
}

function isHtmlPayload(buffer: Buffer, contentType: string) {
  if (contentType.toLowerCase().includes("text/html")) return true;
  const start = buffer.subarray(0, 80).toString("utf8").trimStart().toLowerCase();
  return start.startsWith("<!doctype") || start.startsWith("<html");
}

function detectProductionFileType(
  buffer: Buffer,
  contentType: string,
): "pdf" | "png" | "zip" | "unknown" {
  const normalized = contentType.toLowerCase();
  if (buffer.subarray(0, 5).toString("utf8") === "%PDF-") return "pdf";
  if (hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (buffer.subarray(0, 2).toString("utf8") === "PK") return "zip";
  if (normalized.includes("application/pdf")) return "pdf";
  if (normalized.includes("image/png")) return "png";
  if (
    normalized.includes("application/zip") ||
    normalized.includes("application/x-zip-compressed")
  ) {
    return "zip";
  }
  return "unknown";
}

function safeFilenamePart(value: string | null | undefined) {
  return String(value || "")
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function productionFilename(input: {
  orderName: string | null;
  id: string;
  detectedType: "pdf" | "png" | "zip";
}) {
  const order = safeFilenamePart(input.orderName);
  const base = order
    ? `order-${order}-creator-design`
    : `creator-design-${safeFilenamePart(input.id)}`;
  if (input.detectedType === "zip") return `${base}-png.zip`;
  return `${base}.${input.detectedType}`;
}

function lineCustomAttribute(
  attributes: Array<{ key: string; value: string }> | undefined,
  key: string,
) {
  const value = attributes?.find((attribute) => attribute.key === key)?.value?.trim();
  return value && value.length <= 3000 ? value : null;
}

export async function ensureCreatorOrderItemForPaidLine(input: {
  shop: string;
  line: CreatorPaidLine;
  owner: CreatorOrderOwner;
  creatorSaleId: string;
}) {
  if (!input.owner.creatorProductId) return null;
  const product = await db.creatorProduct.findFirst({
    where: {
      id: input.owner.creatorProductId,
      shop: input.shop,
    },
    select: {
      id: true,
      creatorId: true,
      title: true,
      previewUrl: true,
      previewUrls: true,
      shopifyProductId: true,
      baseProductTitle: true,
      creator: {
        select: {
          id: true,
          displayName: true,
        },
      },
    },
  });
  if (!product || product.creatorId !== input.owner.creatorId) return null;
  const title =
    input.line.creatorDesignTitle ||
    product.title ||
    input.line.productTitle ||
    "Creator product";
  const creatorName = input.line.creatorName || product.creator.displayName;
  return db.creatorOrderItem.upsert({
    where: {
      shop_shopifyOrderId_shopifyLineItemId_creatorProductId: {
        shop: input.shop,
        shopifyOrderId: input.line.shopifyOrderId,
        shopifyLineItemId: input.line.shopifyLineItemId,
        creatorProductId: product.id,
      },
    },
    create: {
      shop: input.shop,
      shopifyOrderId: input.line.shopifyOrderId,
      shopifyOrderName: input.line.shopifyOrderName,
      shopifyLineItemId: input.line.shopifyLineItemId,
      creatorId: product.creatorId,
      creatorProductId: product.id,
      creatorSaleId: input.creatorSaleId,
      creatorCollectionId: input.line.creatorCollectionId,
      baseShopifyProductId: product.shopifyProductId,
      baseShopifyVariantId: input.line.shopifyVariantId,
      pitchprintProjectId: input.line.pitchprintProjectId,
      creatorProductTitleSnapshot: title,
      creatorNameSnapshot: creatorName,
      customerDisplayNameSnapshot: input.line.customerDisplayName,
      variantTitleSnapshot: input.line.variantTitle,
      selectedOptionsJson: input.line.selectedOptionsJson || "[]",
      quantity: input.line.quantity,
      unitPrice: input.line.unitPrice,
      lineSubtotal: input.line.grossSalesAmount,
      currencyCode: input.line.currencyCode,
      creatorPreviewUrl: creatorPreviewForLine(input.line, product),
    },
    update: {
      shopifyOrderName: input.line.shopifyOrderName,
      creatorSaleId: input.creatorSaleId,
      creatorId: product.creatorId,
      creatorCollectionId: input.line.creatorCollectionId,
      baseShopifyProductId: product.shopifyProductId,
      baseShopifyVariantId: input.line.shopifyVariantId,
      pitchprintProjectId: input.line.pitchprintProjectId,
      creatorProductTitleSnapshot: title,
      creatorNameSnapshot: creatorName,
      customerDisplayNameSnapshot: input.line.customerDisplayName,
      variantTitleSnapshot: input.line.variantTitle,
      selectedOptionsJson: input.line.selectedOptionsJson || "[]",
      quantity: input.line.quantity,
      unitPrice: input.line.unitPrice,
      lineSubtotal: input.line.grossSalesAmount,
      currencyCode: input.line.currencyCode,
      creatorPreviewUrl: creatorPreviewForLine(input.line, product),
    },
  });
}

export async function listCreatorOrderItems(input: {
  shop: string;
  status?: string | null;
  query?: string | null;
  page?: number;
  pageSize?: number;
}) {
  const pageSize = Math.min(Math.max(input.pageSize || 25, 1), 50);
  const page = Math.max(input.page || 1, 1);
  const allowedStatuses = Object.values(CreatorOrderProductionStatus);
  const status =
    input.status && allowedStatuses.includes(input.status as CreatorOrderProductionStatus)
      ? (input.status as CreatorOrderProductionStatus)
      : null;
  const query = String(input.query || "").trim();
  const where: Prisma.CreatorOrderItemWhereInput = {
    shop: input.shop,
    ...(status ? { productionStatus: status } : {}),
    ...(query
      ? {
          OR: [
            { shopifyOrderName: { contains: query, mode: "insensitive" } },
            { shopifyOrderId: { contains: query, mode: "insensitive" } },
            { creatorNameSnapshot: { contains: query, mode: "insensitive" } },
            {
              creatorProductTitleSnapshot: {
                contains: query,
                mode: "insensitive",
              },
            },
            {
              customerDisplayNameSnapshot: {
                contains: query,
                mode: "insensitive",
              },
            },
          ],
        }
      : {}),
  };
  const [items, total, summary, commission] = await Promise.all([
    db.creatorOrderItem.findMany({
      where,
      include: {
        creator: { select: { id: true, displayName: true, profileImageUrl: true } },
        creatorProduct: {
          select: {
            id: true,
            title: true,
            previewUrl: true,
            previewUrls: true,
            publishedShopifyProductUrl: true,
          },
        },
        creatorSale: {
          select: {
            id: true,
            grossSalesAmount: true,
            refundedSalesAmount: true,
            commissionRateBps: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.creatorOrderItem.count({ where }),
    db.creatorOrderItem.groupBy({
      by: ["productionStatus"],
      where: { shop: input.shop },
      _count: { _all: true },
    }),
    db.creatorSale.findMany({
      where: { shop: input.shop },
      select: {
        grossSalesAmount: true,
        refundedSalesAmount: true,
        commissionRateBps: true,
        currencyCode: true,
      },
      take: 500,
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
    summary,
    commissionDue: commission.reduce((totalByCurrency, sale) => {
      const net = sale.grossSalesAmount.minus(sale.refundedSalesAmount);
      const earning = creatorEarning(net, sale.commissionRateBps);
      const previous =
        totalByCurrency.get(sale.currencyCode) || new Prisma.Decimal(0);
      totalByCurrency.set(sale.currencyCode, previous.plus(earning));
      return totalByCurrency;
    }, new Map<string, Prisma.Decimal>()),
  };
}

export async function getCreatorOrderItem(shop: string, id: string) {
  const item = await db.creatorOrderItem.findFirst({
    where: { shop, id },
    include: {
      creator: true,
      creatorProduct: {
        select: {
          id: true,
          title: true,
          previewUrl: true,
        },
      },
      creatorSale: { include: { adjustments: true } },
    },
  });
  if (!item) {
    throw new DomainError("CREATOR_ORDER_NOT_FOUND", "Creator order not found.", 404);
  }
  const collection = await db.creatorCollection.findFirst({
    where: { shop, creatorId: item.creatorId },
  });
  return {
    item,
    collection,
    publicCollectionUrl: collection
      ? getCreatorCollectionStorefrontUrl(collection)
      : null,
    publicProductUrl: collection
      ? getCreatorProductStorefrontUrl(collection, item.creatorProduct)
      : null,
  };
}

export function nextProductionStatus(
  current: CreatorOrderProductionStatus,
  requested: CreatorOrderProductionStatus,
) {
  if (requested === CreatorOrderProductionStatus.CANCELLED) return requested;
  const transitions: Record<
    CreatorOrderProductionStatus,
    CreatorOrderProductionStatus[]
  > = {
    NEW: [CreatorOrderProductionStatus.READY_FOR_PRODUCTION],
    READY_FOR_PRODUCTION: [CreatorOrderProductionStatus.IN_PRODUCTION],
    IN_PRODUCTION: [CreatorOrderProductionStatus.FULFILLED],
    FULFILLED: [],
    CANCELLED: [],
  };
  if (!transitions[current].includes(requested)) {
    throw new DomainError(
      "INVALID_PRODUCTION_STATUS_TRANSITION",
      "This production status change is not allowed.",
      422,
    );
  }
  return requested;
}

export async function updateCreatorOrderProduction(input: {
  shop: string;
  id: string;
  status?: string | null;
  notes?: string | null;
  adminId?: string | null;
}) {
  const existing = await db.creatorOrderItem.findFirst({
    where: { shop: input.shop, id: input.id },
  });
  if (!existing) {
    throw new DomainError("CREATOR_ORDER_NOT_FOUND", "Creator order not found.", 404);
  }
  const data: Prisma.CreatorOrderItemUpdateInput = {};
  if (typeof input.notes === "string") {
    data.productionNotes = input.notes.trim().slice(0, 2000) || null;
  }
  if (input.status) {
    const requested = input.status as CreatorOrderProductionStatus;
    if (!Object.values(CreatorOrderProductionStatus).includes(requested)) {
      throw new DomainError("INVALID_PRODUCTION_STATUS", "Choose a valid status.", 422);
    }
    const status = nextProductionStatus(existing.productionStatus, requested);
    data.productionStatus = status;
    if (status === CreatorOrderProductionStatus.READY_FOR_PRODUCTION) {
      data.readyAt = new Date();
    }
    if (status === CreatorOrderProductionStatus.IN_PRODUCTION) {
      data.productionStartedAt = new Date();
    }
    if (status === CreatorOrderProductionStatus.FULFILLED) {
      data.fulfilledAt = new Date();
    }
    if (status === CreatorOrderProductionStatus.CANCELLED) {
      data.cancelledAt = new Date();
    }
  }
  const updated = await db.creatorOrderItem.update({
    where: { id: existing.id },
    data,
  });
  await db.auditLog.create({
    data: {
      shop: input.shop,
      actorType: "ADMIN",
      actorId: input.adminId || null,
      action: "creator_order.updated",
      entityType: "CreatorOrderItem",
      entityId: existing.id,
      beforeJson: JSON.stringify({
        productionStatus: existing.productionStatus,
        notesPresent: Boolean(existing.productionNotes),
      }),
      afterJson: JSON.stringify({
        productionStatus: updated.productionStatus,
        notesPresent: Boolean(updated.productionNotes),
      }),
    },
  });
  return updated;
}

export async function creatorOrderDashboardSummary(shop: string) {
  const [statuses, recent] = await Promise.all([
    db.creatorOrderItem.groupBy({
      by: ["productionStatus"],
      where: { shop },
      _count: { _all: true },
    }),
    db.creatorOrderItem.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: {
        creatorSale: {
          select: {
            grossSalesAmount: true,
            refundedSalesAmount: true,
            commissionRateBps: true,
            currencyCode: true,
          },
        },
      },
    }),
  ]);
  return { statuses, recent };
}

export async function backfillCreatorOrderItemsFromSales(shop: string) {
  const sales = await db.creatorSale.findMany({
    where: {
      shop,
      creatorProductId: { not: null },
    },
    include: {
      creator: { select: { id: true, displayName: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const sale of sales) {
    if (!sale.creatorProductId) {
      skipped += 1;
      continue;
    }
    const product = await db.creatorProduct.findFirst({
      where: {
        shop,
        id: sale.creatorProductId,
        creatorId: sale.creatorId,
      },
      select: {
        id: true,
        title: true,
        previewUrl: true,
        previewUrls: true,
        shopifyProductId: true,
      },
    });
    if (!product) {
      skipped += 1;
      continue;
    }
    const existing = await db.creatorOrderItem.findUnique({
      where: {
        shop_shopifyOrderId_shopifyLineItemId_creatorProductId: {
          shop,
          shopifyOrderId: sale.shopifyOrderId,
          shopifyLineItemId: sale.shopifyLineItemId,
          creatorProductId: product.id,
        },
      },
    });
    await db.creatorOrderItem.upsert({
      where: {
        shop_shopifyOrderId_shopifyLineItemId_creatorProductId: {
          shop,
          shopifyOrderId: sale.shopifyOrderId,
          shopifyLineItemId: sale.shopifyLineItemId,
          creatorProductId: product.id,
        },
      },
      create: {
        shop,
        shopifyOrderId: sale.shopifyOrderId,
        shopifyLineItemId: sale.shopifyLineItemId,
        creatorId: sale.creatorId,
        creatorProductId: product.id,
        creatorSaleId: sale.id,
        baseShopifyProductId: product.shopifyProductId,
        baseShopifyVariantId: sale.shopifyVariantId,
        creatorProductTitleSnapshot: product.title || sale.productTitle,
        creatorNameSnapshot: sale.creator.displayName,
        variantTitleSnapshot: null,
        quantity: sale.quantity,
        unitPrice:
          sale.quantity > 0
            ? sale.grossSalesAmount.div(sale.quantity)
            : sale.grossSalesAmount,
        lineSubtotal: sale.grossSalesAmount,
        currencyCode: sale.currencyCode,
        creatorPreviewUrl: creatorPreviewForLine(
          {
            shopifyOrderId: sale.shopifyOrderId,
            shopifyOrderName: null,
            shopifyLineItemId: sale.shopifyLineItemId,
            shopifyProductId: sale.shopifyProductId,
            shopifyVariantId: sale.shopifyVariantId,
            creatorProductId: product.id,
            creatorCollectionId: null,
            pitchprintProjectId: null,
            creatorPreviewUrl: null,
            creatorDesignTitle: product.title,
            creatorName: sale.creator.displayName,
            attributionToken: null,
            productTitle: sale.productTitle,
            customerDisplayName: null,
            variantTitle: null,
            selectedOptionsJson: "[]",
            quantity: sale.quantity,
            currencyCode: sale.currencyCode,
            unitPrice:
              sale.quantity > 0
                ? sale.grossSalesAmount.div(sale.quantity)
                : sale.grossSalesAmount,
            grossSalesAmount: sale.grossSalesAmount,
            paidAt: sale.paidAt,
            bundleGroupId: null,
            bundleParentProductId: null,
            bundleParentVariantId: null,
            bundleParentQuantity: null,
          },
          product,
        ),
      },
      update: {
        creatorSaleId: sale.id,
        creatorId: sale.creatorId,
        creatorProductTitleSnapshot: product.title || sale.productTitle,
        creatorNameSnapshot: sale.creator.displayName,
        quantity: sale.quantity,
        unitPrice:
          sale.quantity > 0
            ? sale.grossSalesAmount.div(sale.quantity)
            : sale.grossSalesAmount,
        lineSubtotal: sale.grossSalesAmount,
        currencyCode: sale.currencyCode,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }
  return { scanned: sales.length, created, updated, skipped };
}

export async function shopifyOrderAdminDetails(input: {
  orderId: string;
  lineItemId?: string | null;
  client: ShopifyGraphqlClient;
}) {
  const normalizedOrderId = toShopifyOrderGid(input.orderId);
  const normalizedLineItemId = input.lineItemId
    ? toShopifyLineItemGid(input.lineItemId)
    : null;
  try {
    const request = input.client.requestWithMetadata
      ? input.client.requestWithMetadata.bind(input.client)
      : async <T>(query: string, variables?: Record<string, unknown>) => ({
          data: await input.client.request<T>(query, variables),
          errors: [],
          ok: true,
          status: 200,
        });
    const result = await request<{
      order: {
        id: string;
        name: string;
        createdAt: string;
        displayFinancialStatus: string | null;
        displayFulfillmentStatus: string | null;
        cancelledAt: string | null;
        email: string | null;
        phone: string | null;
        customer: {
          id: string;
          displayName: string;
          firstName: string | null;
          lastName: string | null;
          email: string | null;
          phone: string | null;
        } | null;
        shippingAddress: {
          name: string | null;
          firstName: string | null;
          lastName: string | null;
          company: string | null;
          address1: string | null;
          address2: string | null;
          city: string | null;
          province: string | null;
          provinceCode: string | null;
          country: string | null;
          countryCodeV2: string | null;
          zip: string | null;
          phone: string | null;
        } | null;
        lineItems: {
          nodes: Array<{
            id: string;
            name: string;
            title: string;
            variantTitle: string | null;
            quantity: number;
            currentQuantity: number;
            sku: string | null;
            product: { id: string; title: string } | null;
            variant: {
              id: string;
              title: string | null;
              selectedOptions: Array<{ name: string; value: string }>;
            } | null;
            originalUnitPriceSet: {
              shopMoney: { amount: string; currencyCode: string };
            } | null;
            discountedTotalSet: {
              shopMoney: { amount: string; currencyCode: string };
            } | null;
            customAttributes: Array<{ key: string; value: string }>;
          }>;
        };
      } | null;
    }>(
      `#graphql query CreatorOrderAdminDetails($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          email
          phone
          customer { id displayName firstName lastName email phone }
          shippingAddress {
            name firstName lastName company address1 address2 city province provinceCode country countryCodeV2 zip phone
          }
          lineItems(first: 100) {
            nodes {
              id
              name
              title
              variantTitle
              quantity
              currentQuantity
              sku
              product { id title }
              variant { id title selectedOptions { name value } }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              discountedTotalSet { shopMoney { amount currencyCode } }
              customAttributes { key value }
            }
          }
        }
      }`,
      { id: normalizedOrderId },
    );
    const order = result.data?.order || null;
    const lineItem =
      order?.lineItems.nodes.find(
        (item) => item.id === normalizedLineItemId || item.id === input.lineItemId,
      ) || null;
    const errorText = result.errors.map((error) => error.message).join(" ");
    const protectedDataIssue =
      /protected customer data|customer data|access denied|denied|not approved/i.test(
        errorText,
      );
    if (!result.ok) {
      safeDiagnostic("graphql_failure", "failed", {
        correlationId: correlationId(),
        operation: protectedDataIssue
          ? "CreatorOrderAdminDetailsProtectedCustomerData"
          : "CreatorOrderAdminDetails",
      });
    }
    return {
      order,
      lineItem,
      diagnostics: {
        normalizedOrderId,
        graphqlStatus: result.status,
        graphqlOk: result.ok,
        protectedDataIssue,
        orderFound: Boolean(order),
        customerAvailable: Boolean(order?.customer),
        customerEmailAvailable: Boolean(order?.customer?.email || order?.email),
        phoneAvailable: Boolean(
          order?.customer?.phone || order?.phone || order?.shippingAddress?.phone,
        ),
        shippingAvailable: Boolean(order?.shippingAddress),
        message: result.ok
          ? null
          : protectedDataIssue
            ? "Customer details access requires Shopify protected customer data configuration."
            : order
              ? "Some live Shopify order fields were unavailable."
              : "Live Shopify order details unavailable.",
      },
    };
  } catch {
    safeDiagnostic("graphql_failure", "failed", {
      correlationId: correlationId(),
      operation: "CreatorOrderAdminDetails",
    });
    return {
      order: null,
      lineItem: null,
      diagnostics: {
        normalizedOrderId,
        graphqlStatus: 0,
        graphqlOk: false,
        protectedDataIssue: false,
        orderFound: false,
        customerAvailable: false,
        customerEmailAvailable: false,
        phoneAvailable: false,
        shippingAvailable: false,
        message: "Live Shopify order details unavailable.",
      },
    };
  }
}

export type CreatorOrderProductionFile = {
  buffer: Buffer;
  contentType: "application/pdf" | "image/png" | "application/zip";
  extension: "pdf" | "png" | "zip";
  filename: string;
  size: number;
  upstreamStatus: number;
  upstreamContentType: string;
  detectedFileType: "pdf" | "png" | "zip";
};

export async function getCreatorOrderProductionFile(input: {
  shop: string;
  creatorOrderItemId: string;
  format: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<CreatorOrderProductionFile> {
  if (input.format !== "pdf" && input.format !== "png") {
    throw new DomainError("INVALID_PRODUCTION_FILE_FORMAT", "Choose PDF or PNG.", 422);
  }
  const item = await db.creatorOrderItem.findFirst({
    where: { shop: input.shop, id: input.creatorOrderItemId },
    select: {
      id: true,
      shop: true,
      shopifyOrderName: true,
      pitchprintProjectId: true,
    },
  });
  if (!item) {
    throw new DomainError("CREATOR_ORDER_NOT_FOUND", "Creator order not found.", 404);
  }
  if (!item.pitchprintProjectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_MISSING",
      "Production file unavailable for this historical order.",
      404,
    );
  }
  const renderUrl = pitchPrintRenderUrl(item.pitchprintProjectId, input.format);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs || 45_000);
  let upstream: Response;
  try {
    upstream = await (input.fetcher || fetch)(renderUrl, {
      method: "GET",
      headers: {
        Accept:
          input.format === "pdf"
            ? "application/pdf"
            : "image/png, application/zip, application/octet-stream",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new DomainError(
        "PITCHPRINT_RENDER_TIMEOUT",
        "Production file is still being generated. Please try again.",
        504,
      );
    }
    throw new DomainError(
      "PITCHPRINT_RENDER_FAILED",
      "Unable to generate production file. Please try again.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
  const upstreamContentType = upstream.headers.get("content-type") || "";
  const buffer = Buffer.from(await upstream.arrayBuffer());
  const detectedFileType = detectProductionFileType(buffer, upstreamContentType);
  const logDetails = {
    creatorOrderItemId: item.id,
    shop: item.shop,
    formatRequested: input.format,
    pitchprintProjectPresent: true,
    upstreamStatus: upstream.status,
    upstreamContentType,
    detectedFileType,
    size: buffer.length,
  };
  if (!upstream.ok) {
    console.info("creator_order_production_file", {
      ...logDetails,
      success: false,
    });
    throw new DomainError(
      "PITCHPRINT_RENDER_FAILED",
      "Unable to generate production file. Please try again.",
      502,
    );
  }
  if (isHtmlPayload(buffer, upstreamContentType) || detectedFileType === "unknown") {
    console.info("creator_order_production_file", {
      ...logDetails,
      success: false,
    });
    throw new DomainError(
      "PITCHPRINT_RENDER_HTML_ERROR",
      "Production file could not be generated.",
      502,
    );
  }
  if (input.format === "pdf" && detectedFileType !== "pdf") {
    console.info("creator_order_production_file", {
      ...logDetails,
      success: false,
    });
    throw new DomainError(
      "PITCHPRINT_RENDER_TYPE_MISMATCH",
      "Production file could not be generated.",
      502,
    );
  }
  if (input.format === "png" && detectedFileType !== "png" && detectedFileType !== "zip") {
    console.info("creator_order_production_file", {
      ...logDetails,
      success: false,
    });
    throw new DomainError(
      "PITCHPRINT_RENDER_TYPE_MISMATCH",
      "Production file could not be generated.",
      502,
    );
  }
  console.info("creator_order_production_file", {
    ...logDetails,
    success: true,
  });
  return {
    buffer,
    contentType:
      detectedFileType === "pdf"
        ? "application/pdf"
        : detectedFileType === "png"
          ? "image/png"
          : "application/zip",
    extension: detectedFileType,
    filename: productionFilename({
      orderName: item.shopifyOrderName,
      id: item.id,
      detectedType: detectedFileType,
    }),
    size: buffer.length,
    upstreamStatus: upstream.status,
    upstreamContentType,
    detectedFileType,
  };
}

export type ShopifyOrderSnapshotClient = Pick<
  ShopifyGraphqlClient,
  "request" | "requestWithMetadata"
>;

export async function syncCreatorOrderShopifySnapshots(input: {
  shop: string;
  client: ShopifyOrderSnapshotClient;
  dryRun?: boolean;
  limit?: number;
}) {
  const items = await db.creatorOrderItem.findMany({
    where: { shop: input.shop },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(input.limit || 100, 1), 250),
  });
  let changed = 0;
  let unchanged = 0;
  let unavailable = 0;
  const results: Array<{
    id: string;
    shopifyOrderId: string;
    shopifyOrderName: string | null;
    changed: boolean;
    reason: string;
  }> = [];
  for (const item of items) {
    const details = await shopifyOrderAdminDetails({
      orderId: item.shopifyOrderId,
      lineItemId: item.shopifyLineItemId,
      client: input.client,
    });
    const order = details.order;
    const lineItem = details.lineItem;
    if (!order) {
      unavailable += 1;
      results.push({
        id: item.id,
        shopifyOrderId: item.shopifyOrderId,
        shopifyOrderName: item.shopifyOrderName,
        changed: false,
        reason: details.diagnostics.message || "Shopify order unavailable",
      });
      continue;
    }
    const selected = lineItem?.variant?.selectedOptions
      ?.map((option) => option.value)
      .filter(Boolean);
    const customerDisplayName =
      order.customer?.displayName || order.shippingAddress?.name || null;
    const data: Prisma.CreatorOrderItemUpdateInput = {};
    if (!item.shopifyOrderName && order.name) data.shopifyOrderName = order.name;
    if (!item.customerDisplayNameSnapshot && customerDisplayName) {
      data.customerDisplayNameSnapshot = customerDisplayName;
    }
    const variantTitle = lineItem?.variantTitle || lineItem?.variant?.title || null;
    if (
      (!item.variantTitleSnapshot ||
        /^default(?: title)?$/i.test(item.variantTitleSnapshot)) &&
      variantTitle &&
      !/^default(?: title)?$/i.test(variantTitle)
    ) {
      data.variantTitleSnapshot = variantTitle;
    }
    if (selected?.length && selectedOptions(item).length === 0) {
      data.selectedOptionsJson = safeJson(selected);
    }
    const pitchprintProjectId = lineCustomAttribute(
      lineItem?.customAttributes,
      "_pitchprint",
    );
    if (!item.pitchprintProjectId && pitchprintProjectId) {
      data.pitchprintProjectId = pitchprintProjectId;
    }
    if (Object.keys(data).length) {
      changed += 1;
      if (!input.dryRun) {
        await db.creatorOrderItem.update({ where: { id: item.id }, data });
      }
      results.push({
        id: item.id,
        shopifyOrderId: item.shopifyOrderId,
        shopifyOrderName: order.name || item.shopifyOrderName,
        changed: true,
        reason: input.dryRun ? "would update snapshot" : "updated snapshot",
      });
    } else {
      unchanged += 1;
      results.push({
        id: item.id,
        shopifyOrderId: item.shopifyOrderId,
        shopifyOrderName: item.shopifyOrderName,
        changed: false,
        reason: "already current or redacted values unavailable",
      });
    }
  }
  return {
    scanned: items.length,
    changed,
    unchanged,
    unavailable,
    dryRun: Boolean(input.dryRun),
    results,
  };
}

export async function auditCreatorSalesOrderItemCoverage(shop: string) {
  const sales = await db.creatorSale.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyLineItemId: true,
      creatorId: true,
      creatorProductId: true,
      orderItem: { select: { id: true } },
    },
  });
  return sales.map((sale) => {
    const reason = sale.orderItem?.id
      ? "CreatorOrderItem already exists."
      : !sale.shopifyLineItemId
        ? "Missing Shopify line item ID."
        : !sale.creatorProductId
          ? "Missing immutable CreatorProduct ID; skipping to avoid guessing."
          : "Can map confidently by shop, order, line item, and CreatorProduct ID.";
    return {
      creatorSaleId: sale.id,
      shopifyOrderId: sale.shopifyOrderId,
      shopifyLineItemId: sale.shopifyLineItemId || null,
      creatorId: sale.creatorId,
      creatorProductId: sale.creatorProductId || null,
      creatorOrderItemId: sale.orderItem?.id || null,
      canMap: Boolean(!sale.orderItem && sale.shopifyLineItemId && sale.creatorProductId),
      reason,
    };
  });
}

export function shopifyAdminOrderUrl(shop: string, orderId: string) {
  const numeric = orderId.split("/").pop();
  const shopName = shop.replace(/\.myshopify\.com$/, "");
  return numeric && /^\d+$/.test(numeric)
    ? `https://admin.shopify.com/store/${shopName}/orders/${numeric}`
    : `https://${shop}/admin/orders`;
}

export { formatDecimalMoney } from "./money";

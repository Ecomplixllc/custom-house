import { CreatorProductStatus, Prisma } from "@prisma/client";
import db from "../db.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import {
  CREATOR_COMMISSION_BASIS_POINTS,
  bundleLineMatchesCreatorProduct,
  creatorEarning,
  parsePaidOrder,
  parseRefund,
  type CreatorBundleLineContext,
  type CreatorPaidLine,
} from "./creator-sales";
import { ensureCreatorOrderItemForPaidLine } from "./creator-orders.server";
import { verifyCreatorAttribution } from "./creator-attribution.server";
import {
  syncReferralAdjustmentForCreatorSaleAdjustment,
  syncReferralAdjustmentsForCreatorSale,
  syncReferralEarningForCreatorSale,
} from "./creator-referral-earnings.server";
import { getCreatorProductStorefrontUrl } from "./creator-storefront-urls";
import {
  decimalMoneyToMinorUnits,
  formatDecimalMoney,
  formatMinorMoney,
} from "./money";

type ProductOwnershipNode = {
  id: string;
  creatorId: { value: string } | null;
  creatorProductId: { value: string } | null;
  collections: { nodes: Array<{ id: string }> };
};

type LineOwner = {
  creatorId: string;
  creatorProductId: string | null;
};

type RecentPaidOrdersQuery = {
  orders: {
    nodes: Array<{
      id: string;
      processedAt: string | null;
      displayFinancialStatus: string | null;
      currencyCode: string;
      lineItems: {
        nodes: Array<{
          id: string;
          title: string;
          quantity: number;
          product: { id: string } | null;
          variant: { id: string } | null;
          discountedTotalSet: {
            shopMoney: { amount: string; currencyCode: string };
          } | null;
          originalTotalSet: {
            shopMoney: { amount: string; currencyCode: string };
          } | null;
        }>;
      };
    }>;
  };
};

type ProductCollectionMembershipNode = {
  id: string;
  collections: { nodes: Array<{ id: string }> };
};

type BundleOrderQuery = {
  order: {
    lineItems: {
      nodes: Array<{
        id: string;
        quantity: number;
        product: { id: string } | null;
        variant: { id: string } | null;
        discountedTotalSet: {
          shopMoney: { amount: string; currencyCode: string };
        } | null;
        originalTotalSet: {
          shopMoney: { amount: string; currencyCode: string };
        } | null;
        lineItemGroup: {
          id: string;
          productId: string | null;
          variantId: string | null;
          quantity: number;
          customAttributes: Array<{ key: string; value: string }>;
        } | null;
      }>;
    };
  } | null;
};

function webhookLineItemId(value: string) {
  const id = value.trim();
  return id.startsWith("gid://shopify/LineItem/")
    ? id.split("/").pop() || id
    : id;
}

function decimalAmount(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  return /^-?\d+(?:\.\d{1,4})?$/.test(normalized)
    ? new Prisma.Decimal(normalized)
    : null;
}

function graphqlOrderLineMoney(line: {
  originalTotalSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  discountedTotalSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
}) {
  return line.originalTotalSet?.shopMoney || line.discountedTotalSet?.shopMoney;
}

function lineItemIdFromGraphqlId(value: string) {
  const id = value.trim();
  return id.startsWith("gid://shopify/LineItem/")
    ? id.split("/").pop() || ""
    : id;
}

async function bundleLineContextsForPaidOrder(
  orderId: string,
  client: ShopifyGraphqlClient,
): Promise<CreatorBundleLineContext[]> {
  const result = await client.request<BundleOrderQuery>(
    `#graphql query CreatorBundlePaidOrder($id: ID!) {
      order(id: $id) {
        lineItems(first: 250) {
          nodes {
            id
            quantity
            product { id }
            variant { id }
            discountedTotalSet { shopMoney { amount currencyCode } }
            originalTotalSet { shopMoney { amount currencyCode } }
            lineItemGroup {
              id
              productId
              variantId
              quantity
              customAttributes { key value }
            }
          }
        }
      }
    }`,
    { id: orderId },
  );
  if (!result.order) return [];
  return result.order.lineItems.nodes.flatMap((line) => {
    const group = line.lineItemGroup;
    const money = line.discountedTotalSet?.shopMoney ||
      line.originalTotalSet?.shopMoney;
    const shopifyLineItemId = lineItemIdFromGraphqlId(line.id);
    if (
      !group?.id ||
      !group.productId ||
      !group.variantId ||
      !shopifyLineItemId ||
      !line.product?.id ||
      !line.variant?.id ||
      !money
    ) {
      return [];
    }
    return [{
      shopifyLineItemId,
      componentProductId: line.product.id,
      componentVariantId: line.variant.id,
      bundleGroupId: group.id,
      parentProductId: group.productId,
      parentVariantId: group.variantId,
      parentQuantity: group.quantity,
      allocatedTotal: money.amount,
      currencyCode: money.currencyCode,
      customAttributes: group.customAttributes,
    }];
  });
}

function addCandidate(
  candidates: Map<string, Set<string>>,
  productId: string,
  creatorId: string,
) {
  const owners = candidates.get(productId) || new Set<string>();
  owners.add(creatorId);
  candidates.set(productId, owners);
}

async function resolveCreatorOwners(
  shop: string,
  productIds: string[],
  client?: ShopifyGraphqlClient,
) {
  const [creatorProducts, designs, submissions, creators] = await Promise.all([
    db.creatorProduct.findMany({
      where: {
        shop,
        status: "PUBLISHED",
        publishedShopifyProductId: { in: productIds },
      },
      select: {
        id: true,
        creatorId: true,
        publishedShopifyProductId: true,
      },
    }),
    db.creatorDesign.findMany({
      where: { shop, shopifyCreatorProductId: { in: productIds } },
      select: { shopifyCreatorProductId: true, creatorId: true },
    }),
    db.designSubmission.findMany({
      where: { shop, createdProductId: { in: productIds } },
      select: { createdProductId: true, creatorId: true },
    }),
    db.creator.findMany({
      where: { shop },
      select: { id: true, collectionId: true },
    }),
  ]);
  const creatorIds = new Set(creators.map((creator) => creator.id));
  const explicit = new Map<string, Set<string>>();
  const nativeCreatorProducts = new Map<string, LineOwner>();
  for (const product of creatorProducts) {
    if (product.publishedShopifyProductId) {
      nativeCreatorProducts.set(product.publishedShopifyProductId, {
        creatorId: product.creatorId,
        creatorProductId: product.id,
      });
      addCandidate(explicit, product.publishedShopifyProductId, product.creatorId);
    }
  }
  for (const design of designs) {
    if (design.shopifyCreatorProductId) {
      addCandidate(explicit, design.shopifyCreatorProductId, design.creatorId);
    }
  }
  for (const submission of submissions) {
    if (submission.createdProductId) {
      addCandidate(explicit, submission.createdProductId, submission.creatorId);
    }
  }

  const collectionOwners = new Map(
    creators
      .filter((creator) => creator.collectionId)
      .map((creator) => [creator.collectionId!, creator.id]),
  );
  const collectionCandidates = new Map<string, Set<string>>();
  const productsNeedingShopifyLookup = productIds.filter(
    (productId) => !explicit.has(productId),
  );
  if (client && productsNeedingShopifyLookup.length) {
    const result = await client.request<{
      nodes: Array<ProductOwnershipNode | null>;
    }>(
      `#graphql query CreatorSaleProductOwnership($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            creatorId: metafield(namespace: "customhouse", key: "creator_id") {
              value
            }
            creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") {
              value
            }
            collections(first: 250) { nodes { id } }
          }
        }
      }`,
      { ids: productsNeedingShopifyLookup },
    );
    for (const product of result.nodes) {
      if (!product) continue;
      const metafieldCreatorProductId = product.creatorProductId?.value;
      if (metafieldCreatorProductId) {
        const creatorProduct = await db.creatorProduct.findFirst({
          where: {
            shop,
            id: metafieldCreatorProductId,
            status: "PUBLISHED",
          },
          select: { id: true, creatorId: true },
        });
        if (creatorProduct && creatorIds.has(creatorProduct.creatorId)) {
          nativeCreatorProducts.set(product.id, {
            creatorId: creatorProduct.creatorId,
            creatorProductId: creatorProduct.id,
          });
          addCandidate(explicit, product.id, creatorProduct.creatorId);
          continue;
        }
      }
      const metafieldCreatorId = product.creatorId?.value;
      if (metafieldCreatorId && creatorIds.has(metafieldCreatorId)) {
        addCandidate(explicit, product.id, metafieldCreatorId);
      }
      for (const collection of product.collections.nodes) {
        const owner = collectionOwners.get(collection.id);
        if (owner) addCandidate(collectionCandidates, product.id, owner);
      }
    }
  }

  return new Map(
    productIds.flatMap((productId): Array<[string, LineOwner]> => {
      const native = nativeCreatorProducts.get(productId);
      if (native) return [[productId, native]];
      const explicitOwners = explicit.get(productId);
      if (explicitOwners?.size === 1) {
        return [[productId, { creatorId: [...explicitOwners][0], creatorProductId: null }]];
      }
      if (explicitOwners && explicitOwners.size > 1) return [];
      const manualOwners = collectionCandidates.get(productId);
      return manualOwners?.size === 1
        ? [[productId, { creatorId: [...manualOwners][0], creatorProductId: null }]]
        : [];
    }),
  );
}

async function resolveCreatorProductLineOwners(
  shop: string,
  lines: CreatorPaidLine[],
) {
  const ids = [
    ...new Set(
      lines
        .map((line) => line.creatorProductId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return new Map<string, LineOwner>();
  const products = await db.creatorProduct.findMany({
    where: {
      shop,
      id: { in: ids },
      status: "PUBLISHED",
    },
    select: {
      id: true,
      creatorId: true,
      shopifyProductId: true,
      publishedShopifyProductId: true,
      baseVariantMappingJson: true,
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  return new Map(
    lines.flatMap((line): Array<[string, LineOwner]> => {
      if (!line.creatorProductId) return [];
      const product = byId.get(line.creatorProductId);
      if (
        !product ||
        ![product.publishedShopifyProductId, product.shopifyProductId].includes(
          line.shopifyProductId,
        ) ||
        !bundleLineMatchesCreatorProduct(line, product)
      ) {
        if (line.bundleGroupId) {
          console.warn("creator_bundle_attribution_rejected", {
            shop,
            shopifyOrderId: line.shopifyOrderId,
            shopifyLineItemId: line.shopifyLineItemId,
            reason: "canonical_mapping_mismatch",
          });
        }
        return [];
      }
      return [[line.shopifyLineItemId, {
        creatorId: product.creatorId,
        creatorProductId: product.id,
      }]];
    }),
  );
}

async function resolveSignedLineOwners(
  shop: string,
  lines: CreatorPaidLine[],
) {
  const verified = lines.flatMap((line) => {
    const payload = verifyCreatorAttribution(line.attributionToken);
    return payload
      ? [{ line, payload }]
      : [];
  });
  if (!verified.length) return new Map<string, LineOwner>();
  const products = await db.creatorProduct.findMany({
    where: {
      shop,
      id: { in: [...new Set(verified.map((item) => item.payload.creatorProductId))] },
      status: "PUBLISHED",
    },
    select: {
      id: true,
      creatorId: true,
      shopifyProductId: true,
      publishedShopifyProductId: true,
      baseVariantMappingJson: true,
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  const collections = await db.creatorCollection.findMany({
    where: {
      shop,
      creatorId: { in: [...new Set(products.map((product) => product.creatorId))] },
    },
    select: {
      creatorId: true,
      id: true,
    },
  });
  const collectionIdByCreatorId = new Map(
    collections.map((collection) => [collection.creatorId, collection.id]),
  );
  return new Map(
    verified.flatMap(({ line, payload }): Array<[string, LineOwner]> => {
      const product = byId.get(payload.creatorProductId);
      if (
        !product ||
        product.creatorId !== payload.creatorId ||
        collectionIdByCreatorId.get(product.creatorId) !==
          payload.creatorCollectionId ||
        product.shopifyProductId !== payload.baseProductId ||
        line.shopifyProductId !== payload.baseProductId ||
        line.shopifyVariantId !== payload.baseVariantId ||
        !bundleLineMatchesCreatorProduct(line, product)
      ) {
        if (line.bundleGroupId) {
          console.warn("creator_bundle_attribution_rejected", {
            shop,
            shopifyOrderId: line.shopifyOrderId,
            shopifyLineItemId: line.shopifyLineItemId,
            reason: "signed_mapping_mismatch",
          });
        }
        return [];
      }
      return [
        [
          line.shopifyLineItemId,
          {
            creatorId: product.creatorId,
            creatorProductId: product.id,
          },
        ],
      ];
    }),
  );
}

async function resolveDashboardCreatorOwners(input: {
  shop: string;
  productIds: string[];
  creatorId: string;
  collectionId: string | null;
  client: ShopifyGraphqlClient;
}) {
  const owners = await resolveCreatorOwners(
    input.shop,
    input.productIds,
    input.client,
  );
  const productsNeedingDashboardTieBreak = input.collectionId
    ? input.productIds.filter((productId) => !owners.has(productId))
    : [];
  if (!productsNeedingDashboardTieBreak.length) return owners;
  const result = await input.client.request<{
    nodes: Array<ProductCollectionMembershipNode | null>;
  }>(
    `#graphql query DashboardCreatorSaleCollectionMembership($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          collections(first: 250) { nodes { id } }
        }
      }
    }`,
    { ids: productsNeedingDashboardTieBreak },
  );
  for (const product of result.nodes) {
    if (
      product?.collections.nodes.some(
        (collection) => collection.id === input.collectionId,
      )
    ) {
      owners.set(product.id, {
        creatorId: input.creatorId,
        creatorProductId: null,
      });
    }
  }
  return owners;
}

async function reconcilePendingAdjustments(sale: {
  id: string;
  shop: string;
  shopifyLineItemId: string;
  quantity: number;
  refundedQuantity: number;
  grossSalesAmount: Prisma.Decimal;
  refundedSalesAmount: Prisma.Decimal;
}) {
  await db.$transaction(async (tx) => {
    const pending = await tx.creatorSaleAdjustment.findMany({
      where: {
        shop: sale.shop,
        shopifyLineItemId: sale.shopifyLineItemId,
        creatorSaleId: null,
      },
    });
    if (!pending.length) return;
    const requestedAmount = pending.reduce(
      (total, adjustment) => total.plus(adjustment.salesAmount),
      new Prisma.Decimal(0),
    );
    const requestedQuantity = pending.reduce(
      (total, adjustment) => total + adjustment.quantity,
      0,
    );
    const availableAmount = Prisma.Decimal.max(
      sale.grossSalesAmount.minus(sale.refundedSalesAmount),
      0,
    );
    const availableQuantity = Math.max(
      sale.quantity - sale.refundedQuantity,
      0,
    );
    await tx.creatorSale.update({
      where: { id: sale.id },
      data: {
        refundedSalesAmount: {
          increment: Prisma.Decimal.min(requestedAmount, availableAmount),
        },
        refundedQuantity: {
          increment: Math.min(requestedQuantity, availableQuantity),
        },
      },
    });
    await tx.creatorSaleAdjustment.updateMany({
      where: { id: { in: pending.map((adjustment) => adjustment.id) } },
      data: { creatorSaleId: sale.id },
    });
  });
}

export async function recordPaidCreatorSales(input: {
  shop: string;
  payload: unknown;
  webhookId: string;
  client?: ShopifyGraphqlClient;
}) {
  const ordinaryLines = parsePaidOrder(input.payload);
  const bundleContexts = ordinaryLines.length && input.client
    ? await bundleLineContextsForPaidOrder(
        ordinaryLines[0]!.shopifyOrderId,
        input.client,
      )
    : [];
  const lines = bundleContexts.length
    ? parsePaidOrder(input.payload, bundleContexts)
    : ordinaryLines;
  if (!lines.length) return { created: 0, skipped: 0 };
  const productIds = [...new Set(lines.map((line) => line.shopifyProductId))];
  const [lineOwners, owners] = await Promise.all([
    resolveCreatorProductLineOwners(input.shop, lines),
    resolveCreatorOwners(input.shop, productIds, input.client),
  ]);
  const signedLineOwners = await resolveSignedLineOwners(input.shop, lines);
  let created = 0;
  let updated = 0;
  let attributed = 0;
  for (const line of lines) {
    const owner =
      signedLineOwners.get(line.shopifyLineItemId) ||
      lineOwners.get(line.shopifyLineItemId) ||
      (line.bundleGroupId ? undefined : owners.get(line.shopifyProductId));
    if (!owner) continue;
    const lineData = {
      shopifyOrderId: line.shopifyOrderId,
      shopifyLineItemId: line.shopifyLineItemId,
      shopifyProductId: line.shopifyProductId,
      shopifyVariantId: line.shopifyVariantId,
      productTitle: line.productTitle,
      quantity: line.quantity,
      currencyCode: line.currencyCode,
      grossSalesAmount: line.grossSalesAmount,
      paidAt: line.paidAt,
    };
    attributed += 1;
    const existing = await db.creatorSale.findUnique({
      where: {
        shop_shopifyLineItemId: {
          shop: input.shop,
          shopifyLineItemId: line.shopifyLineItemId,
        },
      },
    });
    const sale = await db.creatorSale.upsert({
      where: {
        shop_shopifyLineItemId: {
          shop: input.shop,
          shopifyLineItemId: line.shopifyLineItemId,
        },
      },
      create: {
        shop: input.shop,
        creatorId: owner.creatorId,
        creatorProductId: owner.creatorProductId,
        ...lineData,
        commissionRateBps: CREATOR_COMMISSION_BASIS_POINTS,
        sourceWebhookId: input.webhookId,
      },
      update: {
        creatorId: owner.creatorId,
        creatorProductId: owner.creatorProductId,
        shopifyOrderId: line.shopifyOrderId,
        shopifyProductId: line.shopifyProductId,
        shopifyVariantId: line.shopifyVariantId,
        productTitle: line.productTitle,
        quantity: line.quantity,
        currencyCode: line.currencyCode,
        grossSalesAmount: line.grossSalesAmount,
        paidAt: line.paidAt,
      },
    });
    if (existing) updated += 1;
    else created += 1;
    if (sale) await reconcilePendingAdjustments(sale);
    if (sale) {
      await syncReferralEarningForCreatorSale({
        shop: input.shop,
        creatorSaleId: sale.id,
      });
      await syncReferralAdjustmentsForCreatorSale({
        shop: input.shop,
        creatorSaleId: sale.id,
      });
    }
    if (sale) {
      await ensureCreatorOrderItemForPaidLine({
        shop: input.shop,
        line,
        owner,
        creatorSaleId: sale.id,
      });
    }
  }
  const skipped = attributed - created - updated;
  if (created > 0 || updated > 0) {
    await db.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "WEBHOOK",
        actorId: input.webhookId,
        action: "creator_sales.paid_recorded",
        entityType: "Order",
        entityId: lines[0]!.shopifyOrderId,
        afterJson: JSON.stringify({ created, updated, skipped }),
      },
    });
  }
  console.info("creator_sales_paid_order", {
    shop: input.shop,
    orderId: lines[0]?.shopifyOrderId,
    lineCount: lines.length,
    created,
    updated,
    skipped,
  });
  return { created, skipped };
}

export async function reconcileRecentPaidCreatorSales(input: {
  shop: string;
  creatorId: string;
  client: ShopifyGraphqlClient;
}) {
  const creator = await db.creator.findFirst({
    where: { id: input.creatorId, shop: input.shop },
    select: { id: true, collectionId: true },
  });
  if (!creator) return { created: 0, scanned: 0 };
  const result = await input.client.request<RecentPaidOrdersQuery>(
    `#graphql query RecentCreatorPaidOrders {
      orders(first: 50, reverse: true, query: "financial_status:paid") {
        nodes {
          id
          processedAt
          displayFinancialStatus
          currencyCode
          lineItems(first: 100) {
            nodes {
              id
              title
              quantity
              product { id }
              variant { id }
              discountedTotalSet {
                shopMoney { amount currencyCode }
              }
              originalTotalSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
      }
    }`,
  );
  const lines = result.orders.nodes.flatMap((order) =>
    order.lineItems.nodes.map((line) => ({ order, line })),
  );
  const productIds = [
    ...new Set(
      lines
        .map(({ line }) => line.product?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!productIds.length) return { created: 0, scanned: lines.length };
  const owners = await resolveDashboardCreatorOwners({
    shop: input.shop,
    productIds,
    creatorId: input.creatorId,
    collectionId: creator.collectionId,
    client: input.client,
  });
  let created = 0;
  let updated = 0;
  for (const { order, line } of lines) {
    const productId = line.product?.id;
    if (!productId || owners.get(productId)?.creatorId !== input.creatorId) continue;
    const lineMoney = graphqlOrderLineMoney(line);
    const amount = decimalAmount(lineMoney?.amount);
    const currencyCode = String(lineMoney?.currencyCode || order.currencyCode)
      .toUpperCase();
    const quantity = Number.isSafeInteger(line.quantity) ? line.quantity : 0;
    const paidAt = order.processedAt ? new Date(order.processedAt) : null;
    if (
      !amount ||
      amount.lessThan(0) ||
      !quantity ||
      !/^[A-Z]{3}$/.test(currencyCode) ||
      (paidAt && Number.isNaN(paidAt.getTime()))
    ) {
      continue;
    }
    const shopifyLineItemId = webhookLineItemId(line.id);
    const existing = await db.creatorSale.findUnique({
      where: {
        shop_shopifyLineItemId: {
          shop: input.shop,
          shopifyLineItemId,
        },
      },
    });
    const sale = await db.creatorSale.upsert({
      where: {
        shop_shopifyLineItemId: {
          shop: input.shop,
          shopifyLineItemId,
        },
      },
      create: {
        shop: input.shop,
        creatorId: input.creatorId,
        creatorProductId: owners.get(productId)?.creatorProductId || null,
        shopifyOrderId: order.id,
        shopifyLineItemId,
        shopifyProductId: productId,
        shopifyVariantId: line.variant?.id || null,
        productTitle: line.title.trim().slice(0, 255) || "Creator product",
        quantity,
        currencyCode,
        grossSalesAmount: amount,
        paidAt,
        commissionRateBps: CREATOR_COMMISSION_BASIS_POINTS,
        sourceWebhookId: "dashboard-reconcile",
      },
      update: {
        creatorId: input.creatorId,
        creatorProductId: owners.get(productId)?.creatorProductId || null,
        shopifyOrderId: order.id,
        shopifyProductId: productId,
        shopifyVariantId: line.variant?.id || null,
        productTitle: line.title.trim().slice(0, 255) || "Creator product",
        quantity,
        currencyCode,
        grossSalesAmount: amount,
        paidAt,
      },
    });
    if (existing) updated += 1;
    else created += 1;
    if (sale) await reconcilePendingAdjustments(sale);
    if (sale) {
      await syncReferralEarningForCreatorSale({
        shop: input.shop,
        creatorSaleId: sale.id,
      });
      await syncReferralAdjustmentsForCreatorSale({
        shop: input.shop,
        creatorSaleId: sale.id,
      });
    }
  }
  if (created > 0 || updated > 0) {
    await db.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "SYSTEM",
        actorId: "dashboard-reconcile",
        action: "creator_sales.reconciled",
        entityType: "Creator",
        entityId: input.creatorId,
        afterJson: JSON.stringify({ created, updated, scanned: lines.length }),
      },
    });
  }
  return { created, scanned: lines.length };
}

export async function recordCreatorRefund(input: {
  shop: string;
  payload: unknown;
  webhookId: string;
}) {
  const lines = parseRefund(input.payload);
  let applied = 0;
  const creatorSaleAdjustmentIds: string[] = [];
  for (const line of lines) {
    await db.$transaction(async (tx) => {
      const duplicate = await tx.creatorSaleAdjustment.findUnique({
        where: {
          shop_adjustmentKey: {
            shop: input.shop,
            adjustmentKey: line.adjustmentKey,
          },
        },
      });
      if (duplicate) return;
      const sale = await tx.creatorSale.findUnique({
        where: {
          shop_shopifyLineItemId: {
            shop: input.shop,
            shopifyLineItemId: line.shopifyLineItemId,
          },
        },
      });
      const availableAmount = sale
        ? Prisma.Decimal.max(
            sale.grossSalesAmount.minus(sale.refundedSalesAmount),
            0,
          )
        : line.salesAmount;
      const availableQuantity = sale
        ? Math.max(sale.quantity - sale.refundedQuantity, 0)
        : line.quantity;
      const salesAmount = Prisma.Decimal.min(
        line.salesAmount,
        availableAmount,
      );
      const quantity = Math.min(line.quantity, availableQuantity);
      const adjustment = await tx.creatorSaleAdjustment.create({
        data: {
          shop: input.shop,
          ...line,
          salesAmount,
          quantity,
          creatorSaleId: sale?.id,
          sourceWebhookId: input.webhookId,
        },
      });
      creatorSaleAdjustmentIds.push(adjustment.id);
      if (sale) {
        await tx.creatorSale.update({
          where: { id: sale.id },
          data: {
            refundedSalesAmount: { increment: salesAmount },
            refundedQuantity: { increment: quantity },
          },
        });
        applied += 1;
      }
    });
  }
  console.info("creator_sales_refund", {
    shop: input.shop,
    lineCount: lines.length,
    applied,
  });
  if (applied > 0) {
    for (const creatorSaleAdjustmentId of creatorSaleAdjustmentIds) {
      await syncReferralAdjustmentForCreatorSaleAdjustment({
        shop: input.shop,
        creatorSaleAdjustmentId,
      });
    }
    await db.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "WEBHOOK",
        actorId: input.webhookId,
        action: "creator_sales.refund_recorded",
        entityType: "Order",
        entityId: lines[0]!.shopifyOrderId,
        afterJson: JSON.stringify({ applied, pending: lines.length - applied }),
      },
    });
  }
  return { applied, pending: lines.length - applied };
}

function netSales(sale: {
  grossSalesAmount: Prisma.Decimal;
  refundedSalesAmount: Prisma.Decimal;
}) {
  return Prisma.Decimal.max(
    sale.grossSalesAmount.minus(sale.refundedSalesAmount),
    0,
  );
}

function addMinorTotal(
  totals: Map<string, bigint>,
  currencyCode: string,
  amountMinor: bigint,
) {
  totals.set(currencyCode, (totals.get(currencyCode) || 0n) + amountMinor);
}

function serializeUnifiedTotals(
  productTotals: Map<string, bigint>,
  referralTotals: Map<string, bigint>,
) {
  const currencies = [...new Set([...productTotals.keys(), ...referralTotals.keys()])]
    .sort((a, b) => a.localeCompare(b));
  return currencies.map((currencyCode) => {
    const productEarningsMinor = productTotals.get(currencyCode) || 0n;
    const referralEarningsMinor = referralTotals.get(currencyCode) || 0n;
    const totalEarningsMinor = productEarningsMinor + referralEarningsMinor;
    return {
      currencyCode,
      productEarningsMinor: productEarningsMinor.toString(),
      referralEarningsMinor: referralEarningsMinor.toString(),
      totalEarningsMinor: totalEarningsMinor.toString(),
      productEarnings: formatMinorMoney(productEarningsMinor, currencyCode),
      referralEarnings: formatMinorMoney(referralEarningsMinor, currencyCode),
      totalEarnings: formatMinorMoney(totalEarningsMinor, currencyCode),
    };
  });
}

function totalsLabel(
  totals: Array<Record<string, string>>,
  field: "productEarnings" | "referralEarnings" | "totalEarnings",
) {
  return totals.map((total) => total[field]).filter(Boolean).join(" + ") || "0.00 kr";
}

function netItemQuantity(sale: { quantity: number; refundedQuantity: number }) {
  return Math.max(sale.quantity - sale.refundedQuantity, 0);
}

function saleDateRangeWhere(dateRange?: { start?: Date; end?: Date }) {
  if (!dateRange?.start && !dateRange?.end) return {};
  const range = {
    ...(dateRange.start ? { gte: dateRange.start } : {}),
    ...(dateRange.end ? { lt: dateRange.end } : {}),
  };
  return {
    OR: [
      { paidAt: range },
      { paidAt: null, createdAt: range },
    ],
  };
}

export async function getCreatorCommerceMetrics(input: {
  shop: string;
  creatorId: string;
  dateRange?: { start?: Date; end?: Date };
}) {
  const saleWhere: Prisma.CreatorSaleWhereInput = {
    shop: input.shop,
    creatorId: input.creatorId,
    ...saleDateRangeWhere(input.dateRange),
  };
  const [publishedProductsCount, saleRows, orderRows] = await Promise.all([
    db.creatorProduct.count({
      where: {
        shop: input.shop,
        creatorId: input.creatorId,
        status: CreatorProductStatus.PUBLISHED,
      },
    }),
    db.creatorSale.findMany({
      where: saleWhere,
      select: { quantity: true, refundedQuantity: true },
    }),
    db.creatorSale.findMany({
      where: saleWhere,
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
  ]);
  return {
    publishedProductsCount,
    ordersCount: orderRows.length,
    itemsSoldCount: saleRows.reduce(
      (total, sale) => total + netItemQuantity(sale),
      0,
    ),
  };
}

export async function getCreatorUnifiedEarningsSummary(input: {
  shop: string;
  creatorId: string;
}) {
  const [sales, referralRows] = await Promise.all([
    db.creatorSale.findMany({
      where: { shop: input.shop, creatorId: input.creatorId },
      select: {
        currencyCode: true,
        grossSalesAmount: true,
        refundedSalesAmount: true,
        commissionRateBps: true,
      },
    }),
    db.referralEarning.findMany({
      where: { shop: input.shop, referrerCreatorId: input.creatorId },
      select: {
        currencyCode: true,
        amountMinor: true,
        adjustments: {
          select: { referralAdjustmentMinor: true },
        },
      },
    }),
  ]);
  const productTotals = new Map<string, bigint>();
  const referralTotals = new Map<string, bigint>();
  for (const sale of sales) {
    const earning = creatorEarning(
      netSales({
        grossSalesAmount: sale.grossSalesAmount,
        refundedSalesAmount: sale.refundedSalesAmount,
      }),
      sale.commissionRateBps,
    );
    addMinorTotal(
      productTotals,
      sale.currencyCode,
      decimalMoneyToMinorUnits(earning),
    );
  }
  for (const row of referralRows) {
    const finalReferral = row.adjustments.reduce(
      (total, adjustment) => total + adjustment.referralAdjustmentMinor,
      row.amountMinor,
    );
    addMinorTotal(referralTotals, row.currencyCode, finalReferral);
  }
  const totals = serializeUnifiedTotals(productTotals, referralTotals);
  return {
    creatorId: input.creatorId,
    currencies: totals,
    productEarningsByCurrency: totals.map((total) => ({
      currencyCode: total.currencyCode,
      amountMinor: total.productEarningsMinor,
      amount: total.productEarnings,
    })),
    referralEarningsByCurrency: totals.map((total) => ({
      currencyCode: total.currencyCode,
      amountMinor: total.referralEarningsMinor,
      amount: total.referralEarnings,
    })),
    totalEarningsByCurrency: totals.map((total) => ({
      currencyCode: total.currencyCode,
      amountMinor: total.totalEarningsMinor,
      amount: total.totalEarnings,
    })),
    productEarnings: totalsLabel(totals, "productEarnings"),
    referralEarnings: totalsLabel(totals, "referralEarnings"),
    totalEarnings: totalsLabel(totals, "totalEarnings"),
  };
}

export async function creatorSalesOverview(creatorId: string) {
  const creator = await db.creator.findUnique({
    where: { id: creatorId },
    select: { shop: true },
  });
  const [currencyGroups, productGroups, creatorProducts, collection, salesForSeries, unifiedEarnings, commerceMetrics] = await Promise.all([
    db.creatorSale.groupBy({
      by: ["currencyCode"],
      where: { creatorId },
      _sum: {
        grossSalesAmount: true,
        refundedSalesAmount: true,
        quantity: true,
        refundedQuantity: true,
      },
    }),
    db.creatorSale.groupBy({
      by: ["creatorProductId", "shopifyProductId", "productTitle"],
      where: { creatorId },
      _sum: {
        quantity: true,
        refundedQuantity: true,
        grossSalesAmount: true,
        refundedSalesAmount: true,
      },
    }),
    db.creatorProduct.findMany({
      where: { creatorId },
      select: {
        id: true,
        title: true,
        previewUrl: true,
      },
    }),
    db.creatorCollection.findUnique({
      where: { creatorId },
      select: { publicHandle: true },
    }),
    db.creatorSale.findMany({
      where: { creatorId },
      orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
      select: {
        paidAt: true,
        createdAt: true,
        currencyCode: true,
        grossSalesAmount: true,
        refundedSalesAmount: true,
        commissionRateBps: true,
      },
    }),
    creator
      ? getCreatorUnifiedEarningsSummary({ shop: creator.shop, creatorId })
      : null,
    creator
      ? getCreatorCommerceMetrics({ shop: creator.shop, creatorId })
      : null,
  ]);
  const creatorProductById = new Map(
    creatorProducts.map((product) => [product.id, product]),
  );
  const ordersCount = commerceMetrics?.ordersCount || 0;
  const itemsSoldCount = commerceMetrics?.itemsSoldCount || 0;
  const totals = new Map<
    string,
    { sales: Prisma.Decimal; earnings: Prisma.Decimal }
  >();
  for (const group of currencyGroups) {
    const amount = netSales({
      grossSalesAmount: group._sum.grossSalesAmount || new Prisma.Decimal(0),
      refundedSalesAmount:
        group._sum.refundedSalesAmount || new Prisma.Decimal(0),
    });
    totals.set(group.currencyCode, {
      sales: amount,
      earnings: creatorEarning(amount),
    });
  }
  const formatted = [...totals.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const earningsByDay = new Map<
    string,
    { date: Date; totals: Map<string, Prisma.Decimal> }
  >();
  for (const sale of salesForSeries) {
    const date = sale.paidAt || sale.createdAt;
    const key = date.toISOString().slice(0, 10);
    const entry =
      earningsByDay.get(key) || {
        date,
        totals: new Map<string, Prisma.Decimal>(),
      };
    const amount = creatorEarning(
      netSales({
        grossSalesAmount: sale.grossSalesAmount,
        refundedSalesAmount: sale.refundedSalesAmount,
      }),
      sale.commissionRateBps,
    );
    entry.totals.set(
      sale.currencyCode,
      (entry.totals.get(sale.currencyCode) || new Prisma.Decimal(0)).plus(
        amount,
      ),
    );
    earningsByDay.set(key, entry);
  }
  const earningsSeries = [...earningsByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-5)
    .map(([, entry]) => {
      const formattedTotals = [...entry.totals.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      return {
        label: new Intl.DateTimeFormat("en-GB", {
          day: "2-digit",
          month: "short",
          timeZone: "UTC",
        }).format(entry.date),
        value: formattedTotals.reduce(
          (sum, [, amount]) => sum + Number(amount.toFixed(2)),
          0,
        ),
        valueLabel: formattedTotals.length
          ? formattedTotals
              .map(([currency, amount]) => formatDecimalMoney(amount, currency))
              .join(" + ")
          : "0.00",
      };
    });
  return {
    totalSales: formatted.length
      ? formatted
          .map(([currency, total]) => formatDecimalMoney(total.sales, currency))
          .join(" + ")
      : "0.00",
    productEarnings: unifiedEarnings?.productEarnings || "0.00 kr",
    referralEarnings: unifiedEarnings?.referralEarnings || "0.00 kr",
    totalEarnings: unifiedEarnings?.totalEarnings || "0.00 kr",
    unifiedEarnings,
    ordersCount,
    itemsSoldCount,
    publishedProductsCount: commerceMetrics?.publishedProductsCount || 0,
    commissionRatePercent: CREATOR_COMMISSION_BASIS_POINTS / 100,
    earningsSeries,
    topSellingProducts: productGroups
      .map((product) => ({
        creatorProductId: product.creatorProductId,
        title:
          (product.creatorProductId
            ? creatorProductById.get(product.creatorProductId)?.title
            : null) || product.productTitle,
        previewUrl: product.creatorProductId
          ? creatorProductById.get(product.creatorProductId)?.previewUrl || null
          : null,
        productUrl:
          product.creatorProductId
            ? getCreatorProductStorefrontUrl(collection, {
                id: product.creatorProductId,
              })
            : null,
        unitsSold: Math.max(
          (product._sum.quantity || 0) -
            (product._sum.refundedQuantity || 0),
          0,
        ),
        revenue: netSales({
          grossSalesAmount: product._sum.grossSalesAmount || new Prisma.Decimal(0),
          refundedSalesAmount:
            product._sum.refundedSalesAmount || new Prisma.Decimal(0),
        }).toFixed(2),
      }))
      .filter((product) => product.unitsSold > 0)
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 5),
  };
}

export type { CreatorPaidLine };

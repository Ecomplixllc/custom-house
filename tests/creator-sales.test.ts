import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATOR_COMMISSION_BASIS_POINTS,
  bundleLineMatchesCreatorProduct,
  creatorProductForBundleLine,
  creatorEarning,
  parsePaidOrder,
  parseRefund,
} from "../app/services/creator-sales.ts";
import {
  signCreatorAttribution,
  verifyCreatorAttribution,
} from "../app/services/creator-attribution.server.ts";
import { creatorProductionMetadataFromAttributes } from "../app/services/creator-production-metadata.ts";
import { shouldRedirectToCreatorDashboard } from "../extensions/customhouse-creator-storefront/assets/creator-application-guard.js";

test("paid creator sales use the product line total from the order", () => {
  const lines = parsePaidOrder({
    id: 101,
    name: "#101",
    currency: "SEK",
    processed_at: "2026-08-03T10:00:00Z",
    customer: { first_name: "John", last_name: "Doe", email: "john@example.com" },
    line_items: [
      {
        id: 201,
        product_id: 301,
        variant_id: 401,
        title: "Creator shirt",
        variant_title: "Green / M",
        variant_options: ["Green", "M"],
        quantity: 2,
        price: "100.00",
        discount_allocations: [{ amount: "20.00" }],
        properties: [
          { name: "_creator_product_id", value: "cmcreatorproduct00000001" },
          { name: "_creator_collection_id", value: "cmcreatorcollection00001" },
          { name: "_pitchprint", value: "pp_order_project" },
          { name: "_creator_preview_url", value: "https://cdn.pitchprint.test/creator.png" },
          { name: "_creator_design_title", value: "Creator shirt" },
          { name: "_creator_name", value: "Choyon Khan" },
        ],
      },
    ],
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.shopifyOrderId, "gid://shopify/Order/101");
  assert.equal(lines[0]?.shopifyOrderName, "#101");
  assert.equal(lines[0]?.shopifyProductId, "gid://shopify/Product/301");
  assert.equal(lines[0]?.creatorProductId, "cmcreatorproduct00000001");
  assert.equal(lines[0]?.creatorCollectionId, "cmcreatorcollection00001");
  assert.equal(lines[0]?.pitchprintProjectId, "pp_order_project");
  assert.equal(lines[0]?.creatorPreviewUrl, "https://cdn.pitchprint.test/creator.png");
  assert.equal(lines[0]?.creatorDesignTitle, "Creator shirt");
  assert.equal(lines[0]?.creatorName, "Choyon Khan");
  assert.equal(lines[0]?.customerDisplayName, "John Doe");
  assert.equal(lines[0]?.variantTitle, "Green / M");
  assert.equal(lines[0]?.selectedOptionsJson, JSON.stringify(["Green", "M"]));
  assert.equal(lines[0]?.unitPrice.toFixed(2), "100.00");
  assert.equal(lines[0]?.grossSalesAmount.toFixed(2), "200.00");
  assert.equal(lines[0]?.currencyCode, "SEK");
});

test("invalid creator product line property is ignored safely", () => {
  const [line] = parsePaidOrder({
    id: 101,
    currency: "SEK",
    line_items: [
      {
        id: 201,
        product_id: 301,
        quantity: 1,
        price: "100.00",
        properties: [
          { name: "_creator_product_id", value: "not a safe id" },
        ],
      },
    ],
  });

  assert.equal(line?.creatorProductId, null);
});

test("signed creator attribution survives order parsing and rejects tampering", () => {
  const token = signCreatorAttribution({
    creatorProductId: "cmcreatorproduct00000001",
    creatorId: "creator-a",
    creatorCollectionId: "collection-a",
    baseProductId: "gid://shopify/Product/301",
    baseVariantId: "gid://shopify/ProductVariant/401",
    pitchprintProjectId: "pp_master",
  });
  const [line] = parsePaidOrder({
    id: 101,
    currency: "SEK",
    line_items: [
      {
        id: 201,
        product_id: 301,
        variant_id: 401,
        quantity: 1,
        price: "100.00",
        properties: [{ name: "_customhouse_attribution", value: token }],
      },
    ],
  });

  assert.equal(line?.attributionToken, token);
  assert.equal(
    verifyCreatorAttribution(token)?.creatorProductId,
    "cmcreatorproduct00000001",
  );
  assert.equal(verifyCreatorAttribution(`${token}tampered`), null);
});

test("grouped bundle sale uses parent attributes and component line identity", () => {
  const token = signCreatorAttribution({
    creatorProductId: "cmcreatorproduct00000001",
    creatorId: "creator-a",
    creatorCollectionId: "collection-a",
    baseProductId: "gid://shopify/Product/301",
    baseVariantId: "gid://shopify/ProductVariant/401",
    pitchprintProjectId: "pp_bundle",
  });
  const [line] = parsePaidOrder(
    {
      id: 101,
      currency: "SEK",
      line_items: [{
        id: 201,
        product_id: 301,
        variant_id: 401,
        title: "Base shirt",
        quantity: 2,
        price: "100.00",
      }],
    },
    [{
      shopifyLineItemId: "201",
      componentProductId: "gid://shopify/Product/301",
      componentVariantId: "gid://shopify/ProductVariant/401",
      bundleGroupId: "gid://shopify/LineItemGroup/901",
      parentProductId: "gid://shopify/Product/501",
      parentVariantId: "gid://shopify/ProductVariant/601",
      parentQuantity: 2,
      allocatedTotal: "180.00",
      currencyCode: "SEK",
      customAttributes: [
        { key: "_creator_product_id", value: "cmcreatorproduct00000001" },
        { key: "_creator_collection_id", value: "cmcreatorcollection00001" },
        { key: "_customhouse_attribution", value: token },
      ],
    }],
  );

  assert.equal(line?.shopifyLineItemId, "201");
  assert.equal(line?.creatorProductId, "cmcreatorproduct00000001");
  assert.equal(line?.attributionToken, token);
  assert.equal(line?.bundleParentProductId, "gid://shopify/Product/501");
  assert.equal(line?.bundleParentVariantId, "gid://shopify/ProductVariant/601");
  assert.equal(line?.bundleParentQuantity, 2);
  assert.equal(line?.quantity, 2);
  assert.equal(line?.unitPrice.toFixed(2), "90.00");
  assert.equal(line?.grossSalesAmount.toFixed(2), "180.00");
});

test("grouped bundle sale preserves full and partial Shopify discount allocation", () => {
  const payload = {
    id: 101,
    currency: "SEK",
    line_items: [{
      id: 201,
      product_id: 301,
      variant_id: 401,
      quantity: 1,
      price: "599.00",
    }],
  };
  const context = {
    shopifyLineItemId: "201",
    componentProductId: "gid://shopify/Product/301",
    componentVariantId: "gid://shopify/ProductVariant/401",
    bundleGroupId: "gid://shopify/LineItemGroup/901",
    parentProductId: "gid://shopify/Product/501",
    parentVariantId: "gid://shopify/ProductVariant/601",
    parentQuantity: 1,
    allocatedTotal: "499.00",
    currencyCode: "SEK",
    customAttributes: [],
  };
  assert.equal(
    parsePaidOrder(payload, [context])[0]?.grossSalesAmount.toFixed(2),
    "499.00",
  );
  assert.equal(
    parsePaidOrder(payload, [{ ...context, allocatedTotal: "0.00" }])[0]
      ?.grossSalesAmount.toFixed(2),
    "0.00",
  );
});

test("grouped bundle sale fails closed when GraphQL component identity differs", () => {
  const lines = parsePaidOrder(
    {
      id: 101,
      currency: "SEK",
      line_items: [{
        id: 201,
        product_id: 301,
        variant_id: 401,
        quantity: 1,
        price: "599.00",
      }],
    },
    [{
      shopifyLineItemId: "201",
      componentProductId: "gid://shopify/Product/301",
      componentVariantId: "gid://shopify/ProductVariant/999",
      bundleGroupId: "gid://shopify/LineItemGroup/901",
      parentProductId: "gid://shopify/Product/501",
      parentVariantId: "gid://shopify/ProductVariant/601",
      parentQuantity: 1,
      allocatedTotal: "599.00",
      currencyCode: "SEK",
      customAttributes: [],
    }],
  );
  assert.deepEqual(lines, []);
});

test("bundle Creator attribution requires the canonical parent-to-component mapping", () => {
  const line = {
    bundleGroupId: "gid://shopify/LineItemGroup/901",
    bundleParentProductId: "gid://shopify/Product/501",
    bundleParentVariantId: "gid://shopify/ProductVariant/601",
    bundleParentQuantity: 1,
    shopifyProductId: "gid://shopify/Product/301",
    shopifyVariantId: "gid://shopify/ProductVariant/401",
    quantity: 1,
  };
  const product = {
    shopifyProductId: "gid://shopify/Product/301",
    publishedShopifyProductId: "gid://shopify/Product/501",
    baseVariantMappingJson: JSON.stringify({
      "gid://shopify/ProductVariant/601": "gid://shopify/ProductVariant/401",
    }),
  };
  assert.equal(bundleLineMatchesCreatorProduct(line, product), true);
  assert.equal(
    bundleLineMatchesCreatorProduct(
      { ...line, shopifyVariantId: "gid://shopify/ProductVariant/999" },
      product,
    ),
    false,
  );
  assert.equal(
    bundleLineMatchesCreatorProduct(
      { ...line, bundleParentVariantId: "gid://shopify/ProductVariant/999" },
      product,
    ),
    false,
  );
});

test("native bundle parent identity attributes without custom group attributes", () => {
  const [line] = parsePaidOrder(
    {
      id: 101,
      currency: "SEK",
      financial_status: "paid",
      line_items: [{
        id: 201,
        product_id: 301,
        variant_id: 401,
        quantity: 1,
        price: "110.00",
      }],
    },
    [{
      shopifyLineItemId: "201",
      componentProductId: "gid://shopify/Product/301",
      componentVariantId: "gid://shopify/ProductVariant/401",
      bundleGroupId: "gid://shopify/LineItemGroup/901",
      parentProductId: "gid://shopify/Product/501",
      parentVariantId: "gid://shopify/ProductVariant/601",
      parentQuantity: 1,
      allocatedTotal: "110.00",
      currencyCode: "SEK",
      customAttributes: [],
    }],
  );
  assert.ok(line);
  assert.equal(line.creatorProductId, null);
  const creatorProduct = creatorProductForBundleLine(line, [{
    id: "cmcreatorproduct00000001",
    creatorId: "cmcreator000000000000001",
    shopifyProductId: "gid://shopify/Product/301",
    publishedShopifyProductId: "gid://shopify/Product/501",
    baseVariantMappingJson: JSON.stringify({
      "gid://shopify/ProductVariant/601": "gid://shopify/ProductVariant/401",
    }),
  }]);
  assert.equal(creatorProduct?.id, "cmcreatorproduct00000001");
});


test("unpaid order create payloads are not counted as creator sales", () => {
  assert.deepEqual(
    parsePaidOrder({
      id: 102,
      currency: "SEK",
      financial_status: "pending",
      line_items: [
        {
          id: 202,
          product_id: 302,
          quantity: 1,
          price: "100.00",
        },
      ],
    }),
    [],
  );
});

test("creator earnings are exactly ten percent of attributed net sales", () => {
  const [line] = parsePaidOrder({
    id: 1,
    currency: "SEK",
    line_items: [
      { id: 2, product_id: 3, quantity: 1, price: "123.45" },
    ],
  });
  assert.equal(CREATOR_COMMISSION_BASIS_POINTS, 1_000);
  assert.equal(
    creatorEarning(line!.grossSalesAmount).toFixed(3),
    "12.345",
  );
});

test("refund line items are normalized for idempotent sales adjustments", () => {
  const lines = parseRefund({
    id: 501,
    order_id: 101,
    refund_line_items: [
      {
        id: 601,
        line_item_id: 201,
        quantity: 1,
        subtotal: "-50.00",
      },
    ],
  });
  assert.deepEqual(
    lines.map((line) => ({
      key: line.adjustmentKey,
      order: line.shopifyOrderId,
      line: line.shopifyLineItemId,
      amount: line.salesAmount.toFixed(2),
    })),
    [
      {
        key: "refund-line:601",
        order: "gid://shopify/Order/101",
        line: "201",
        amount: "50.00",
      },
    ],
  );
});

test("invalid or unattributable webhook money data is rejected", () => {
  assert.deepEqual(
    parsePaidOrder({
      id: 1,
      currency: "SEK",
      line_items: [{ id: 2, product_id: 3, quantity: 1, price: "secret" }],
    }),
    [],
  );
  assert.deepEqual(parseRefund({ order_id: 1, refund_line_items: [] }), []);
});

test("application guard redirects existing creator states only", () => {
  for (const state of [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "SUSPENDED",
    "SYNC_CONFLICT",
  ]) {
    assert.equal(shouldRedirectToCreatorDashboard({ state }), true);
  }
  for (const state of [
    "NOT_APPLIED",
    "APPLICATION_NOT_SUBMITTED",
    "CREATOR_RECORD_MISSING",
    "LOGGED_OUT",
  ]) {
    assert.equal(shouldRedirectToCreatorDashboard({ state }), false);
  }
});

test("storefront creator login returns to the creator dashboard", () => {
  const guard = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-application-guard.liquid",
    "utf8",
  );
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );

  for (const source of [guard, dashboard]) {
    assert.match(source, /\/customer_authentication\/login\?return_to=/);
    assert.doesNotMatch(source, /return_url=/);
  }
  assert.match(guard, /default: '\/pages\/creator-dashboard'/);
});

test("header customer login links return to the creator dashboard", () => {
  const header = readFileSync("theme-export/sections/header.liquid", "utf8");

  assert.match(header, /\/customer_authentication\/login\?return_to=/);
  assert.match(header, /assign creator_dashboard_url = '\/pages\/creator-dashboard'/);
  assert.match(header, /data-customhouse-become-creator-link/);
  assert.match(header, /\/apps\/customhouse\/api\/creator-dashboard/);
  assert.match(header, /status === 'APPROVED'/);
  assert.doesNotMatch(header, />My account<\/a>/);
  assert.doesNotMatch(header, />MY ACCOUNT<\/span>/);
  assert.doesNotMatch(header, /routes\.account_login_url/);
  assert.doesNotMatch(header, /return_url=/);
});

test("creator status changes sync the storefront customer status metafield", () => {
  const service = readFileSync("app/services/creator.server.ts", "utf8");

  assert.match(service, /metafieldsSet\(metafields: \$metafields\)/);
  assert.match(service, /namespace: "customhouse"/);
  assert.match(service, /key: "creator_status"/);
  assert.match(service, /value: status/);
  assert.match(service, /syncCustomerCreatorStatusMetafield\(creator\.customerId, next, client\)/);
});

test("production configuration subscribes to paid sales and refunds", () => {
  const config = readFileSync("shopify.app.production.toml", "utf8");
  assert.match(config, /read_orders/);
  assert.match(config, /topics = \["orders\/create"\]/);
  assert.match(config, /topics = \["orders\/paid"\]/);
  assert.match(config, /topics = \["refunds\/create"\]/);
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /@@unique\(\[shop, shopifyLineItemId\]\)/);
  assert.match(schema, /commissionRateBps\s+Int\s+@default\(1000\)/);
  const createWebhook = readFileSync("app/routes/webhooks.orders.create.tsx", "utf8");
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");
  const ordersService = readFileSync("app/services/creator-orders.server.ts", "utf8");
  assert.match(createWebhook, /recordPaidCreatorSales/);
  assert.match(dashboardService, /reconcileRecentPaidCreatorSales/);
  assert.match(salesService, /ensureCreatorOrderItemForPaidLine/);
  assert.match(ordersService, /creatorOrderItem\.upsert/);
  assert.match(ordersService, /shop_shopifyOrderId_shopifyLineItemId_creatorProductId/);
  assert.match(salesService, /DashboardCreatorSaleCollectionMembership/);
  assert.match(salesService, /collection\.id === input\.collectionId/);
  assert.match(salesService, /originalTotalSet/);
  assert.match(salesService, /upsert/);
  assert.match(salesService, /getCreatorUnifiedEarningsSummary/);
  assert.match(salesService, /formatDecimalMoney/);
  assert.doesNotMatch(salesService, /sv-SE|narrowSymbol/);
});

test("creator order item schema separates operations from CreatorSale finance", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const orderBlock = schema.match(/model CreatorOrderItem \{[\s\S]*?\n\}/)?.[0] || "";
  const saleBlock = schema.match(/model CreatorSale \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(schema, /enum CreatorOrderProductionStatus/);
  assert.match(schema, /NEW/);
  assert.match(schema, /READY_FOR_PRODUCTION/);
  assert.match(schema, /IN_PRODUCTION/);
  assert.match(schema, /FULFILLED/);
  assert.match(schema, /CANCELLED/);
  assert.match(orderBlock, /creatorSaleId\s+String\?\s+@unique/);
  assert.match(orderBlock, /pitchprintProjectId\s+String\?/);
  assert.match(orderBlock, /creatorPreviewUrl\s+String\?/);
  assert.match(orderBlock, /productionNotes\s+String\?/);
  assert.match(orderBlock, /@@unique\(\[shop, shopifyOrderId, shopifyLineItemId, creatorProductId\]\)/);
  assert.doesNotMatch(saleBlock, /productionStatus|productionNotes|readyAt|fulfilledAt/);
});

test("creator order view parses authoritative Shopify line production metadata", () => {
  assert.deepEqual(
    creatorProductionMetadataFromAttributes([
      { key: "_pitchprint", value: "pp_order_clone" },
      { name: "_creator_master_project_id", value: "pp_master" },
      { key: "_pitchprint_design_id", value: "pp_design" },
      { key: "_fixed_color", value: "Green" },
      { key: "_production_method", value: "EMBROIDERY" },
      { key: "_embroidery_subtype", value: "IMAGE_OR_LOGO" },
      { key: "_designed_placement_count", value: "2" },
    ]),
    {
      version: 1,
      pitchprintProjectId: "pp_order_clone",
      pitchprintMasterProjectId: "pp_master",
      pitchprintDesignId: "pp_design",
      fixedColor: "Green",
      productionMethod: "EMBROIDERY",
      embroiderySubtype: "IMAGE_OR_LOGO",
      placementCount: 2,
    },
  );
  assert.equal(
    creatorProductionMetadataFromAttributes([
      { key: "_production_method", value: "STICKER_PRINTING" },
      { key: "_designed_placement_count", value: "1" },
    ]).productionMethod,
    "STICKER_PRINTING",
  );
});

test("creator order admin routes are admin-only and public routes do not expose operations", () => {
  const index = readFileSync("app/routes/app.creator-orders.tsx", "utf8");
  const detail = readFileSync("app/routes/app.creator-orders.$id.tsx", "utf8");
  const fileRoute = readFileSync("app/routes/app.creator-orders.$id.production-file.tsx", "utf8");
  const appProxy = readFileSync("app/services/storefront-proxy.server.ts", "utf8");
  const dashboardProxy = readFileSync("app/routes/proxy.api.creator-dashboard.tsx", "utf8");

  assert.match(index, /authenticate\.admin\(request\)/);
  assert.match(index, /to=\{`\/app\/creator-orders\/\$\{item\.id\}`\}/);
  assert.match(index, /useParams/);
  assert.match(index, /<Outlet \/>/);
  assert.match(detail, /authenticate\.admin\(request\)/);
  assert.match(detail, /getCreatorOrderItem\(session\.shop, id\)/);
  assert.match(detail, /data-page="creator-order-detail"/);
  assert.match(detail, /creator_order_detail_loader/);
  assert.match(detail, /shopifyOrderAdminDetails/);
  assert.match(detail, /creatorProductionMetadataFromAttributes/);
  assert.match(detail, /Open Shopify Order/);
  assert.match(detail, /production-file\?format=pdf/);
  assert.match(detail, /production-file\?format=png/);
  assert.match(detail, /downloadCreatorProductionFile/);
  assert.match(detail, /shopify\.idToken\(\)/);
  assert.match(detail, /Authorization: `Bearer \$\{token\}`/);
  assert.match(detail, /fetch\(url/);
  assert.match(detail, /credentials: "same-origin"/);
  assert.match(detail, /response\.blob\(\)/);
  assert.match(detail, /parseFilenameFromContentDisposition/);
  assert.match(detail, /filename="\(\[\^"\]\+\)"/);
  assert.match(detail, /creator-design\.pdf/);
  assert.match(detail, /creator-design-png\.zip/);
  assert.match(detail, /URL\.createObjectURL\(blob\)/);
  assert.match(detail, /document\.createElement\("a"\)/);
  assert.match(detail, /anchor\.download = filename/);
  assert.match(detail, /anchor\.click\(\)/);
  assert.match(detail, /URL\.revokeObjectURL\(blobUrl\)/);
  assert.match(detail, /contentType\.includes\("text\/html"\)/);
  assert.match(detail, /PRODUCTION_FILE_AUTH_HTML_RESPONSE/);
  assert.match(detail, /response\.json\(\)/);
  assert.match(detail, /PITCHPRINT_PROJECT_MISSING/);
  assert.match(detail, /PITCHPRINT_RENDER_FAILED/);
  assert.match(detail, /Generating PDF\.\.\./);
  assert.match(detail, /Preparing PNG Package\.\.\./);
  assert.match(detail, /PDF downloaded/);
  assert.match(detail, /PNG package downloaded/);
  assert.match(detail, /creator-preview-modal/);
  assert.doesNotMatch(detail, /href=\{order\.productionFiles\.pdfUrl\}/);
  assert.doesNotMatch(detail, /href=\{order\.productionFiles\.pngUrl\}/);
  assert.doesNotMatch(detail, /window\.open|location\.href|custom-house\.vercel\.app|SHOPIFY_APP_URL/);
  assert.doesNotMatch(detail, /createApp\(|@shopify\/app-bridge/);
  assert.match(fileRoute, /authenticate\.admin\(request\)/);
  assert.match(fileRoute, /getCreatorOrderProductionFile/);
  assert.match(fileRoute, /new Response\(new Uint8Array\(file\.buffer\)/);
  assert.match(fileRoute, /Content-Disposition/);
  assert.match(fileRoute, /Content-Length/);
  assert.match(fileRoute, /private, no-store/);
  assert.match(fileRoute, /nosniff/);
  assert.match(fileRoute, /Response\.json/);
  assert.doesNotMatch(fileRoute, /Response\.redirect/);
  assert.doesNotMatch(fileRoute, /projectId/);
  assert.match(fileRoute, /Response\.json/);
  assert.match(fileRoute, /Content-Type/);
  assert.match(fileRoute, /file\.contentType/);
  assert.doesNotMatch(appProxy, /creatorOrderItem/);
  assert.doesNotMatch(dashboardProxy, /creatorOrderItem/);
});

test("creator order production transitions and dashboard operations are explicit", () => {
  const service = readFileSync("app/services/creator-orders.server.ts", "utf8");
  const dashboard = readFileSync("app/routes/app._index.tsx", "utf8");
  const nav = readFileSync("app/routes/app.tsx", "utf8");

  assert.match(service, /NEW: \[CreatorOrderProductionStatus\.READY_FOR_PRODUCTION\]/);
  assert.match(service, /READY_FOR_PRODUCTION: \[CreatorOrderProductionStatus\.IN_PRODUCTION\]/);
  assert.match(service, /IN_PRODUCTION: \[CreatorOrderProductionStatus\.FULFILLED\]/);
  assert.match(service, /INVALID_PRODUCTION_STATUS_TRANSITION/);
  assert.match(service, /toShopifyOrderGid/);
  assert.match(service, /gid:\/\/shopify\/Order\/\$\{value\}/);
  assert.match(service, /pitchPrintRenderUrl/);
  assert.match(service, /https:\/\/\$\{format\}\.pitchprint\.com/);
  assert.match(service, /getCreatorOrderProductionFile/);
  assert.match(service, /arrayBuffer\(\)/);
  assert.doesNotMatch(service, /creatorOrderProductionFileTarget/);
  assert.match(service, /PITCHPRINT_PROJECT_MISSING/);
  assert.match(service, /PITCHPRINT_RENDER_TIMEOUT/);
  assert.match(service, /PITCHPRINT_RENDER_HTML_ERROR/);
  assert.match(service, /PITCHPRINT_RENDER_TYPE_MISMATCH/);
  assert.match(service, /application\/pdf/);
  assert.match(service, /image\/png/);
  assert.match(service, /application\/zip/);
  assert.match(service, /%PDF-/);
  assert.match(service, /0x89, 0x50, 0x4e, 0x47/);
  assert.match(service, /buffer\.subarray\(0, 2\)\.toString\("utf8"\) === "PK"/);
  assert.match(service, /-png\.zip/);
  assert.match(service, /safeFilenamePart/);
  assert.match(service, /creator_order_production_file/);
  assert.match(service, /protectedDataIssue/);
  assert.match(service, /syncCreatorOrderShopifySnapshots/);
  assert.match(service, /lineCustomAttribute/);
  assert.match(service, /"_pitchprint"/);
  assert.match(dashboard, /Recent Creator Orders/);
  assert.match(nav, /Creator Orders/);
  assert.match(nav, /Payouts/);
});

test("creator order admin keeps primary UI human-friendly and diagnostics collapsed", () => {
  const index = readFileSync("app/routes/app.creator-orders.tsx", "utf8");
  const detail = readFileSync("app/routes/app.creator-orders.$id.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");
  const script = readFileSync("scripts/sync-creator-order-shopify-snapshots.ts", "utf8");
  const ordersService = readFileSync("app/services/creator-orders.server.ts", "utf8");

  assert.match(index, /creatorOrderVariantLabel/);
  assert.match(index, /orderName: item\.shopifyOrderName/);
  assert.match(index, /creator-order-metrics/);
  assert.match(index, /creator-status-tabs/);
  assert.doesNotMatch(index, /variantTitleSnapshot \|\| "Default"/);
  assert.match(detail, /<details className="creator-admin-details creator-admin-panel">/);
  assert.match(detail, /Customer details are managed in Shopify/);
  assert.match(detail, /legalActions\.map/);
  assert.match(detail, /Download PDF/);
  assert.match(detail, /Download PNG Package/);
  assert.doesNotMatch(ordersService, /creatorProduct:\s*true/);
  assert.match(ordersService, /creatorProduct:\s*\{\s*select:/s);
  assert.match(styles, /\.creator-preview-modal\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.creator-preview-modal\s*\{[^}]*inset: 0;/s);
  assert.match(styles, /\.creator-preview-modal\s*\{[^}]*height: 100dvh;/s);
  assert.match(styles, /\.creator-preview-modal\s*\{[^}]*place-items: center;/s);
  assert.match(styles, /\.creator-preview-modal-backdrop\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.creator-preview-modal-content\s*\{[^}]*max-height: calc\(100dvh - 40px\);/s);
  assert.match(script, /dryRun = !process\.argv\.includes\("--apply"\)/);
  assert.match(script, /auditCreatorSalesOrderItemCoverage/);
});

test("native creator product sales resolve through immutable CreatorProduct identity", () => {
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");

  assert.match(
    salesService,
    /creatorProductId: metafield\(namespace: "customhouse", key: "creator_product_id"\)/,
  );
  assert.match(salesService, /publishedShopifyProductId: \{ in: productIds \}/);
  assert.match(salesService, /creatorProductId: owner\.creatorProductId/);
  assert.doesNotMatch(salesService, /displayName.*creatorSale|productTitle.*creatorId/);
});

test("native creator sale rows keep idempotency and canonical product linkage", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const saleBlock = schema.match(/model CreatorSale \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(saleBlock, /creatorProductId\s+String\?/);
  assert.match(saleBlock, /@@unique\(\[shop, shopifyLineItemId\]\)/);
  assert.match(saleBlock, /@@index\(\[creatorProductId\]\)/);
});

test("creator commerce metrics use canonical product status and net item quantity", () => {
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");

  assert.match(salesService, /export async function getCreatorCommerceMetrics/);
  assert.match(salesService, /status: CreatorProductStatus\.PUBLISHED/);
  assert.match(salesService, /shop: input\.shop/);
  assert.match(salesService, /creatorId: input\.creatorId/);
  assert.match(salesService, /function netItemQuantity/);
  assert.match(salesService, /function saleDateRangeWhere/);
  assert.match(salesService, /dateRange\?: \{ start\?: Date; end\?: Date \}/);
  assert.match(salesService, /paidAt: range/);
  assert.match(salesService, /createdAt: range/);
  assert.match(salesService, /Math\.max\(sale\.quantity - sale\.refundedQuantity, 0\)/);
  assert.match(salesService, /saleRows\.reduce/);
  assert.match(salesService, /distinct: \["shopifyOrderId"\]/);
  assert.match(salesService, /publishedProductsCount: commerceMetrics\?\.publishedProductsCount/);
  assert.match(dashboardService, /publishedProductsCount: sales\.publishedProductsCount/);
  assert.doesNotMatch(
    dashboardService,
    /publishedProducts\.length \+ creator\.creatorProducts\.length/,
  );
});

test("items sold is not derived from order count or creator sale row count", () => {
  const salesService = readFileSync("app/services/creator-sales.server.ts", "utf8");

  assert.match(salesService, /itemsSoldCount {1}= {1}commerceMetrics\?\.itemsSoldCount {1}\|\| {1}0/);
  assert.doesNotMatch(
    salesService,
    /itemsSoldCount\s*=\s*(?:orderIds\.length|productGroups\.length|currencyGroups\.length)/,
  );
});

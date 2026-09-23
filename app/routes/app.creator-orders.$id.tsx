import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import {
  AdminStyles,
  SafeAdminError,
  SubmitButton,
} from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  creatorOrderVariantLabel,
  formatDecimalMoney,
  getCreatorOrderItem,
  shopifyAdminOrderUrl,
  shopifyOrderAdminDetails,
  updateCreatorOrderProduction,
} from "../services/creator-orders.server";
import { creatorEarning } from "../services/creator-sales";

function statusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value: string | null | undefined) {
  if (!value) return "-";
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function dateLabel(value: string | Date | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

type ProductionFileFormat = "pdf" | "png";
type DownloadState = ProductionFileFormat | null;

type ShopifyAdminGlobal = {
  idToken?: () => Promise<string>;
  toast?: {
    show?: (message: string, options?: { isError?: boolean }) => void;
  };
};

declare const shopify: ShopifyAdminGlobal | undefined;

function parseFilenameFromContentDisposition(value: string | null) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded.replace(/^"|"$/g, "");
    }
  }
  return value.match(/filename="([^"]+)"/i)?.[1] || value.match(/filename=([^;]+)/i)?.[1]?.trim() || null;
}

function fallbackProductionFilename(format: ProductionFileFormat, contentType: string) {
  if (format === "pdf") return "creator-design.pdf";
  return contentType.includes("application/zip")
    ? "creator-design-png.zip"
    : "creator-design.png";
}

function productionFileAcceptHeader(format: ProductionFileFormat) {
  return format === "pdf"
    ? "application/pdf"
    : "image/png, application/zip, application/octet-stream";
}

function productionFileSuccessMessage(format: ProductionFileFormat, contentType: string) {
  if (format === "pdf") return "PDF downloaded";
  return contentType.includes("application/zip")
    ? "PNG package downloaded"
    : "PNG downloaded";
}

function productionFileErrorMessage(code: string) {
  if (code === "AUTH_OR_HTML_RESPONSE" || code === "PRODUCTION_FILE_AUTH_HTML_RESPONSE") {
    return "Your Shopify Admin session needs to be refreshed.";
  }
  if (code === "PITCHPRINT_PROJECT_MISSING") {
    return "No production project is available for this historical order.";
  }
  if (code === "PITCHPRINT_RENDER_FAILED") {
    return "PitchPrint could not generate this file. Please try again.";
  }
  return "Unable to download the file. Please try again.";
}

async function currentShopifyIdToken() {
  if (typeof shopify === "undefined" || !shopify.idToken) {
    throw new Error("AUTH_OR_HTML_RESPONSE");
  }
  return shopify.idToken();
}

function showAdminToast(message: string, isError = false) {
  if (typeof shopify !== "undefined" && shopify.toast?.show) {
    shopify.toast.show(message, isError ? { isError: true } : undefined);
  }
}

async function errorCodeFromResponse(response: Response, contentType: string) {
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    return payload?.error?.code || "NETWORK_ERROR";
  }
  if (contentType.includes("text/html")) {
    return "PRODUCTION_FILE_AUTH_HTML_RESPONSE";
  }
  return "NETWORK_ERROR";
}

async function downloadCreatorProductionFile({
  creatorOrderItemId,
  format,
}: {
  creatorOrderItemId: string;
  format: ProductionFileFormat;
}) {
  const token = await currentShopifyIdToken();
  const url =
    `/app/creator-orders/${encodeURIComponent(creatorOrderItemId)}` +
    `/production-file?format=${encodeURIComponent(format)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: productionFileAcceptHeader(format),
    },
    credentials: "same-origin",
  });
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(await errorCodeFromResponse(response, contentType));
  }
  if (contentType.includes("text/html")) {
    throw new Error("PRODUCTION_FILE_AUTH_HTML_RESPONSE");
  }

  const blob = await response.blob();
  const filename =
    parseFilenameFromContentDisposition(response.headers.get("content-disposition")) ||
    fallbackProductionFilename(format, contentType);
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 1000);
  return { contentType, filename };
}

function legalStatusActions(status: string) {
  if (status === "NEW") {
    return [{ value: "READY_FOR_PRODUCTION", label: "Mark Ready for Production" }];
  }
  if (status === "READY_FOR_PRODUCTION") {
    return [{ value: "IN_PRODUCTION", label: "Mark In Production" }];
  }
  if (status === "IN_PRODUCTION") {
    return [{ value: "FULFILLED", label: "Mark Fulfilled" }];
  }
  return [];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id || "";
  const result = await getCreatorOrderItem(session.shop, id);
  console.info("creator_order_detail_loader", {
    id,
    shop: session.shop,
    itemFound: Boolean(result.item),
    requestUrl: new URL(request.url).pathname,
  });
  const shopify = admin
    ? await shopifyOrderAdminDetails({
        orderId: result.item.shopifyOrderId,
        lineItemId: result.item.shopifyLineItemId,
        client: new AdminGraphqlClient(admin),
      })
    : {
        order: null,
        lineItem: null,
        diagnostics: {
          normalizedOrderId: result.item.shopifyOrderId,
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
  const sale = result.item.creatorSale;
  const netSale = sale
    ? sale.grossSalesAmount.minus(sale.refundedSalesAmount)
    : null;
  const commission = sale
    ? creatorEarning(netSale!, sale.commissionRateBps)
    : null;
  return {
    shop: session.shop,
    shopifyOrderUrl: shopifyAdminOrderUrl(session.shop, result.item.shopifyOrderId),
    shopifyOrder: shopify.order,
    shopifyLineItem: shopify.lineItem,
    shopifyDiagnostics: shopify.diagnostics,
    publicCollectionUrl: result.publicCollectionUrl,
    publicProductUrl: result.publicProductUrl,
    order: {
      id: result.item.id,
      orderName:
        shopify.order?.name ||
        result.item.shopifyOrderName ||
        result.item.shopifyOrderId.split("/").pop(),
      shopifyOrderId: result.item.shopifyOrderId,
      shopifyLineItemId: result.item.shopifyLineItemId,
      creatorProductTitle: result.item.creatorProductTitleSnapshot,
      creatorName: result.item.creatorNameSnapshot,
      customerSnapshot:
        result.item.customerDisplayNameSnapshot || "Managed in Shopify",
      variantTitle: creatorOrderVariantLabel(result.item),
      quantity: result.item.quantity,
      unitPrice: formatDecimalMoney(result.item.unitPrice, result.item.currencyCode),
      lineSubtotal: formatDecimalMoney(
        result.item.lineSubtotal,
        result.item.currencyCode,
      ),
      currencyCode: result.item.currencyCode,
      creatorPreviewUrl:
        result.item.creatorPreviewUrl ||
        result.item.creatorProduct.previewUrl ||
        null,
      pitchprintProjectId: result.item.pitchprintProjectId,
      productionFiles: result.item.pitchprintProjectId
        ? {
            status: "Ready",
            pdfUrl: `/app/creator-orders/${result.item.id}/production-file?format=pdf`,
            pngUrl: `/app/creator-orders/${result.item.id}/production-file?format=png`,
          }
        : {
            status: "Unavailable",
            pdfUrl: null,
            pngUrl: null,
          },
      productionStatus: result.item.productionStatus,
      legalActions: legalStatusActions(result.item.productionStatus),
      productionNotes: result.item.productionNotes || "",
      readyAt: result.item.readyAt,
      productionStartedAt: result.item.productionStartedAt,
      fulfilledAt: result.item.fulfilledAt,
      cancelledAt: result.item.cancelledAt,
      baseShopifyProductId: result.item.baseShopifyProductId,
      baseShopifyVariantId: result.item.baseShopifyVariantId,
      creator: {
        id: result.item.creator.id,
        displayName: result.item.creator.displayName,
        handle: result.item.creator.handle,
        profileImageUrl: result.item.creator.profileImageUrl,
      },
      creatorProduct: {
        id: result.item.creatorProduct.id,
        title: result.item.creatorProduct.title,
      },
      sale: sale
        ? {
            id: sale.id,
            gross: formatDecimalMoney(sale.grossSalesAmount, sale.currencyCode),
            refunded: formatDecimalMoney(
              sale.refundedSalesAmount,
              sale.currencyCode,
            ),
            net: formatDecimalMoney(netSale!, sale.currencyCode),
            commissionRatePercent: sale.commissionRateBps / 100,
            commission: formatDecimalMoney(commission!, sale.currencyCode),
            adjustments: sale.adjustments.map((adjustment) => ({
              id: adjustment.id,
              amount: formatDecimalMoney(adjustment.salesAmount, sale.currencyCode),
              quantity: adjustment.quantity,
              createdAt: adjustment.createdAt,
            })),
          }
        : null,
    },
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  await updateCreatorOrderProduction({
    shop: session.shop,
    id: params.id || "",
    status: form.get("status") ? String(form.get("status")) : null,
    notes: form.get("productionNotes")
      ? String(form.get("productionNotes"))
      : null,
    adminId: session.id,
  });
  return { ok: true, message: "Creator order updated." };
}

export default function CreatorOrderDetail() {
  const { order, shopifyOrder, shopifyLineItem, shopifyDiagnostics, shopifyOrderUrl, publicCollectionUrl, publicProductUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [downloading, setDownloading] = useState<DownloadState>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const customerName =
    shopifyOrder?.customer?.displayName ||
    shopifyOrder?.shippingAddress?.name ||
    order.customerSnapshot;
  const customerEmail = shopifyOrder?.customer?.email || shopifyOrder?.email || null;
  const customerPhone =
    shopifyOrder?.customer?.phone ||
    shopifyOrder?.phone ||
    shopifyOrder?.shippingAddress?.phone ||
    null;
  const shippingLines = [
    shopifyOrder?.shippingAddress?.name,
    shopifyOrder?.shippingAddress?.company,
    shopifyOrder?.shippingAddress?.address1,
    shopifyOrder?.shippingAddress?.address2,
    [
      shopifyOrder?.shippingAddress?.zip,
      shopifyOrder?.shippingAddress?.city,
      shopifyOrder?.shippingAddress?.provinceCode ||
        shopifyOrder?.shippingAddress?.province,
    ]
      .filter(Boolean)
      .join(" "),
    shopifyOrder?.shippingAddress?.country,
  ].filter(Boolean);

  async function handleProductionFileDownload(format: ProductionFileFormat) {
    setDownloading(format);
    setDownloadMessage(null);
    try {
      const result = await downloadCreatorProductionFile({
        creatorOrderItemId: order.id,
        format,
      });
      const message = productionFileSuccessMessage(format, result.contentType);
      setDownloadMessage(message);
      showAdminToast(message);
    } catch (error) {
      const code = error instanceof Error ? error.message : "NETWORK_ERROR";
      const message = productionFileErrorMessage(code);
      setDownloadMessage(message);
      showAdminToast(message, true);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <s-page heading="Creator Order">
      <AdminStyles />
      <div className="creator-admin-page creator-order-detail-page" data-page="creator-order-detail">
        <header className="creator-order-detail-header">
          <div>
            <nav className="creator-orders-breadcrumb" aria-label="Breadcrumb">
              <Link to="/app" aria-label="Dashboard">Home</Link>
              <span aria-hidden="true">&gt;</span>
              <Link to="/app/creator-orders">Orders</Link>
              <span aria-hidden="true">&gt;</span>
              <strong>Creator Order</strong>
            </nav>
            <h1>Creator Order</h1>
          </div>
          <Link className="creator-order-detail-menu" to="/app/creator-orders" aria-label="Back to Creator Orders">
            <span>Back to Creator Orders</span>
          </Link>
        </header>
        {actionData?.message ? (
          <div className="creator-admin-message">{actionData.message}</div>
        ) : null}
        {downloadMessage ? (
          <div className="creator-admin-message">{downloadMessage}</div>
        ) : null}
        {shopifyDiagnostics.message ? (
          <div className="creator-admin-warning">
            {shopifyDiagnostics.message}
          </div>
        ) : null}

        <section className="creator-order-detail-layout">
          <div className="creator-order-main-column">
            <article className="creator-admin-panel">
              <h2>Customer & Shipping</h2>
              {shopifyOrder?.customer || shopifyOrder?.shippingAddress ? (
                <div className="creator-order-customer-grid">
                  <div>
                    <span className="creator-card-label">Customer</span>
                    <strong>{customerName}</strong>
                    <p>{customerEmail || "Email managed in Shopify"}</p>
                    <p>{customerPhone || "Phone managed in Shopify"}</p>
                  </div>
                  <div>
                    <span className="creator-card-label">Shipping Address</span>
                    {shippingLines.length ? (
                      shippingLines.map((line) => <p key={line}>{line}</p>)
                    ) : (
                      <p>Shipping details are managed in Shopify.</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="dashboard-empty">
                  <strong>Customer details are managed in Shopify.</strong>
                  <span className="dashboard-muted">
                    Open the Shopify order for customer and shipping details, or configure protected customer data access.
                  </span>
                </div>
              )}
              <a className="creator-action-link" href={shopifyOrderUrl} target="_blank" rel="noreferrer">
                Open Shopify Order
              </a>
            </article>

            <article className="creator-admin-panel creator-order-design-panel">
              <div>
                <span className="creator-card-label">Creator Design</span>
                <h2>{order.creatorProductTitle}</h2>
                <p>
                  Artwork identity is locked to the purchased PitchPrint project.
                </p>
              </div>
              {order.creatorPreviewUrl ? (
                <img
                  src={order.creatorPreviewUrl}
                  alt={order.creatorProductTitle}
                  className="creator-admin-preview"
                />
              ) : (
                <div className="dashboard-empty">
                  <strong>Design preview unavailable.</strong>
                </div>
              )}
              <div className="creator-order-info-grid">
                <span><strong>Creator</strong>{order.creatorName}</span>
                <span><strong>Variant</strong>{order.variantTitle}</span>
                <span><strong>Quantity</strong>{order.quantity}</span>
                <span><strong>Order Line</strong>{shopifyLineItem?.name || order.lineSubtotal}</span>
              </div>
              <div className="creator-order-files">
                <div>
                  <span className="creator-card-label">Design Files</span>
                  <strong>
                    {order.productionFiles.status === "Ready"
                      ? "PitchPrint project found"
                      : "Design file unavailable"}
                  </strong>
                  {order.productionFiles.status !== "Ready" ? (
                    <p>No PitchPrint project was stored for this historical order.</p>
                  ) : null}
                </div>
                <div className="creator-link-row">
                  {order.creatorPreviewUrl ? (
                    <button
                      className="creator-action-link"
                      type="button"
                      onClick={() => setPreviewOpen(true)}
                    >
                      Preview Design
                    </button>
                  ) : null}
                  {order.productionFiles.pdfUrl ? (
                    <button
                      className="creator-action-link"
                      type="button"
                      disabled={downloading === "pdf"}
                      onClick={() => handleProductionFileDownload("pdf")}
                    >
                      {downloading === "pdf" ? "Generating PDF..." : "Download PDF"}
                    </button>
                  ) : null}
                  {order.productionFiles.pngUrl ? (
                    <button
                      className="creator-action-link"
                      type="button"
                      disabled={downloading === "png"}
                      onClick={() => handleProductionFileDownload("png")}
                    >
                      {downloading === "png"
                        ? "Preparing PNG Package..."
                        : "Download PNG Package"}
                    </button>
                  ) : null}
                </div>
              </div>
            </article>

            <article className="creator-admin-panel">
              <h2>Order Information</h2>
              <dl className="creator-detail-list">
                <dt>Payment</dt>
                <dd>{shopifyOrder?.displayFinancialStatus || "Managed in Shopify"}</dd>
                <dt>Fulfillment</dt>
                <dd>{shopifyOrder?.displayFulfillmentStatus || "Managed in Shopify"}</dd>
                <dt>Unit Price</dt>
                <dd>{order.unitPrice}</dd>
                <dt>Line Subtotal</dt>
                <dd>{order.lineSubtotal}</dd>
                <dt>Shopify Created</dt>
                <dd>{dateLabel(shopifyOrder?.createdAt)}</dd>
              </dl>
            </article>
          </div>

          <aside className="creator-order-side-column">
            <article className="creator-admin-panel creator-order-sticky">
              <h2>Production Status</h2>
              <span
                className={`creator-order-badge creator-order-badge--${order.productionStatus.toLowerCase()}`}
              >
                {statusLabel(order.productionStatus)}
              </span>
              <Form method="post" className="creator-decision-form">
                <label>
                  <span>Internal Production Notes</span>
                  <textarea
                    name="productionNotes"
                    defaultValue={order.productionNotes}
                    maxLength={2000}
                  />
                </label>
                <div className="creator-link-row">
                  {order.legalActions.map((action) => (
                    <SubmitButton key={action.value} name="status" value={action.value}>
                      {action.label}
                    </SubmitButton>
                  ))}
                  {order.productionStatus !== "FULFILLED" &&
                  order.productionStatus !== "CANCELLED" ? (
                    <SubmitButton
                      name="status"
                      value="CANCELLED"
                      confirmMessage="Cancel this creator order production item?"
                    >
                      Cancel
                    </SubmitButton>
                  ) : null}
                  <SubmitButton>Save Note</SubmitButton>
                </div>
              </Form>
            </article>

            <article className="creator-admin-panel">
              <h2>Commission</h2>
              {order.sale ? (
                <dl className="creator-detail-list">
                  <dt>Sale Value</dt>
                  <dd>{order.sale.gross}</dd>
                  <dt>Adjustment</dt>
                  <dd>{order.sale.refunded}</dd>
                  <dt>Net Sale</dt>
                  <dd>{order.sale.net}</dd>
                  <dt>Commission Rate</dt>
                  <dd>{order.sale.commissionRatePercent}%</dd>
                  <dt>Creator Earning</dt>
                  <dd>{order.sale.commission}</dd>
                  <dt>Payout</dt>
                  <dd>Pending</dd>
                </dl>
              ) : (
                <div className="dashboard-empty">CreatorSale missing.</div>
              )}
            </article>

            <article className="creator-admin-panel">
              <h2>Creator</h2>
              <div className="creator-application-main">
                {order.creator.profileImageUrl ? (
                  <img src={order.creator.profileImageUrl} alt="" />
                ) : (
                  <span>{order.creatorName.slice(0, 2).toUpperCase()}</span>
                )}
                <div>
                  <h3>{order.creatorName}</h3>
                  <p>@{order.creator.handle}</p>
                </div>
              </div>
              <div className="creator-link-row">
                <Link className="creator-action-link" to="/app/creators">
                  View Creator
                </Link>
                <Link className="creator-action-link" to="/app/creator-products?status=ALL">
                  View CreatorProduct
                </Link>
                {publicProductUrl ? (
                  <a className="creator-action-link" href={publicProductUrl}>
                    View Public Product
                  </a>
                ) : null}
                {publicCollectionUrl ? (
                  <a className="creator-action-link" href={publicCollectionUrl}>
                    View Creator Collection
                  </a>
                ) : null}
              </div>
            </article>

            <article className="creator-admin-panel">
              <h2>Timeline</h2>
              <ol className="creator-order-timeline">
                <li><strong>Order received</strong><span>{dateLabel(shopifyOrder?.createdAt)}</span></li>
                <li><strong>Creator sale recorded</strong><span>{order.sale ? "Recorded" : "Missing"}</span></li>
                <li><strong>Ready for production</strong><span>{dateLabel(order.readyAt)}</span></li>
                <li><strong>Production started</strong><span>{dateLabel(order.productionStartedAt)}</span></li>
                <li><strong>Fulfilled</strong><span>{dateLabel(order.fulfilledAt)}</span></li>
              </ol>
            </article>
          </aside>
        </section>

        <details className="creator-admin-details creator-admin-panel">
          <summary>Diagnostics</summary>
          <dl className="creator-detail-list">
            <dt>CreatorOrderItem ID</dt>
            <dd>{order.id}</dd>
            <dt>CreatorProduct ID</dt>
            <dd>{order.creatorProduct.id}</dd>
            <dt>Creator ID</dt>
            <dd>{order.creator.id}</dd>
            <dt>Shopify order GID</dt>
            <dd>{shopifyDiagnostics.normalizedOrderId}</dd>
            <dt>Stored Shopify order ID</dt>
            <dd>{order.shopifyOrderId}</dd>
            <dt>Shopify line item ID</dt>
            <dd>{order.shopifyLineItemId}</dd>
            <dt>PitchPrint project ID</dt>
            <dd>{order.pitchprintProjectId || "-"}</dd>
            <dt>Customer access</dt>
            <dd>
              Name: {shopifyDiagnostics.customerAvailable ? "Available" : "Not Available"}; Email:{" "}
              {shopifyDiagnostics.customerEmailAvailable ? "Available" : "Not Available"}; Phone:{" "}
              {shopifyDiagnostics.phoneAvailable ? "Available" : "Not Available"}; Shipping:{" "}
              {shopifyDiagnostics.shippingAvailable ? "Available" : "Not Available"}
            </dd>
            <dt>Base Variant ID</dt>
            <dd>{shortId(order.baseShopifyVariantId)}</dd>
          </dl>
        </details>
        {previewOpen && order.creatorPreviewUrl ? (
          <div
            className="creator-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Creator design preview"
          >
            <button
              className="creator-preview-modal-backdrop"
              type="button"
              aria-label="Close preview"
              onClick={() => setPreviewOpen(false)}
            />
            <div className="creator-preview-modal-content">
              <button
                className="creator-preview-modal-close"
                type="button"
                onClick={() => setPreviewOpen(false)}
              >
                Close
              </button>
              <img src={order.creatorPreviewUrl} alt={order.creatorProductTitle} />
            </div>
          </div>
        ) : null}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Order" />;
}

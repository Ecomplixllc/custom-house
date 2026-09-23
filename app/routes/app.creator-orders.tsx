import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, Outlet, useLoaderData, useParams } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  creatorOrderVariantLabel,
  formatDecimalMoney,
  listCreatorOrderItems,
} from "../services/creator-orders.server";
import { creatorEarning } from "../services/creator-sales";

const STATUS_FILTERS = [
  "ALL",
  "NEW",
  "READY_FOR_PRODUCTION",
  "IN_PRODUCTION",
  "FULFILLED",
  "CANCELLED",
] as const;

function statusLabel(status: string) {
  return status
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "ALL";
  const query = url.searchParams.get("q") || "";
  const page = Number(url.searchParams.get("page") || 1);
  const result = await listCreatorOrderItems({
    shop: session.shop,
    status: status === "ALL" ? null : status,
    query,
    page,
    pageSize: 25,
  });
  const summary = new Map(
    result.summary.map((item) => [item.productionStatus, item._count._all]),
  );
  return {
    selected: STATUS_FILTERS.includes(status as (typeof STATUS_FILTERS)[number])
      ? status
      : "ALL",
    query,
    page: result.page,
    pageCount: result.pageCount,
    total: result.total,
    summary: Object.fromEntries(summary),
    commissionDue: [...result.commissionDue.entries()].map(([currency, value]) => ({
      currency,
      amount: formatDecimalMoney(value, currency),
    })),
    items: result.items.map((item) => {
      const sale = item.creatorSale;
      const commission = sale
        ? creatorEarning(
            sale.grossSalesAmount.minus(sale.refundedSalesAmount),
            sale.commissionRateBps,
          )
        : null;
      return {
        id: item.id,
        orderName: item.shopifyOrderName || item.shopifyOrderId.split("/").pop(),
        createdAt: item.createdAt,
        customer: item.customerDisplayNameSnapshot || "Managed in Shopify",
        creator: item.creatorNameSnapshot,
        design: item.creatorProductTitleSnapshot,
        variant: creatorOrderVariantLabel(item),
        thumbnail:
          item.creatorPreviewUrl ||
          item.creatorProduct.previewUrl ||
          null,
        quantity: item.quantity,
        value: formatDecimalMoney(item.lineSubtotal, item.currencyCode),
        commission: commission
          ? formatDecimalMoney(commission, item.currencyCode)
          : "Missing sale",
        productionStatus: item.productionStatus,
      };
    }),
  };
}

export default function CreatorOrdersIndex() {
  const data = useLoaderData<typeof loader>();
  const routeParams = useParams();
  const params = new URLSearchParams();
  if (data.query) params.set("q", data.query);

  if (routeParams.id) {
    return (
      <>
        <AdminStyles />
        <Outlet />
      </>
    );
  }

  return (
    <s-page heading="Creator Orders">
      <AdminStyles />
      <div className="creator-admin-page creator-orders-page">
        <header className="creator-orders-header">
          <div>
            <nav className="creator-orders-breadcrumb" aria-label="Breadcrumb">
              <Link to="/app">Dashboard</Link>
              <span aria-hidden="true">›</span>
              <strong>Creator Orders</strong>
            </nav>
            <h1>Creator Orders</h1>
            <p>
              One Shopify order can contain multiple creator lines. Each row is managed independently for production.
            </p>
          </div>
          <Form method="get" className="creator-orders-search">
            <span aria-hidden="true" />
            <input
              name="q"
              defaultValue={data.query}
              placeholder="Search order, creator, design, customer"
            />
            <input type="hidden" name="status" value={data.selected} />
            <button type="submit">Search</button>
          </Form>
        </header>

        <section className="creator-order-metrics creator-orders-metrics" aria-label="Creator order summary">
          {["NEW", "READY_FOR_PRODUCTION", "IN_PRODUCTION", "FULFILLED"].map(
            (status) => (
              <article className="creator-order-metric" key={status}>
                <span className={`creator-status-dot creator-status-dot--${status.toLowerCase()}`} />
                <p>{statusLabel(status)}</p>
                <strong>{data.summary[status] || 0}</strong>
              </article>
            ),
          )}
          <article className="creator-order-metric">
            <span className="creator-status-dot creator-status-dot--commission" />
            <p>Commission Due</p>
            <strong>
              {data.commissionDue.length
                ? data.commissionDue.map((item) => item.amount).join(" / ")
                : "-"}
            </strong>
          </article>
        </section>

        <div className="creator-status-tabs creator-orders-tabs">
          {STATUS_FILTERS.map((status) => (
            <Link
              key={status}
              to={`/app/creator-orders?status=${status}${
                data.query ? `&q=${encodeURIComponent(data.query)}` : ""
              }`}
              className={
                status === data.selected
                  ? "creator-status-tab creator-status-tab--active"
                  : "creator-status-tab"
              }
            >
              {statusLabel(status)}
            </Link>
          ))}
        </div>

        <section className="creator-admin-panel creator-orders-panel">
          {data.items.length ? (
            <div className="creator-table-wrap">
              <table className="creator-table creator-orders-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Design</th>
                    <th>Creator</th>
                    <th>Variant</th>
                    <th>Qty</th>
                    <th>Value</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td data-label="Order">
                        <strong className="creator-order-name">{item.orderName}</strong>
                        <span className="creator-table-subtext">
                          {formatDate(item.createdAt)}
                        </span>
                      </td>
                      <td data-label="Customer">{item.customer}</td>
                      <td data-label="Design">
                        <div className="creator-order-design-cell">
                          {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" />
                          ) : (
                            <span />
                          )}
                          <strong>{item.design}</strong>
                        </div>
                      </td>
                      <td data-label="Creator">{item.creator}</td>
                      <td data-label="Variant">{item.variant}</td>
                      <td data-label="Qty">{item.quantity}</td>
                      <td data-label="Value">{item.value}</td>
                      <td data-label="Status">
                        <span
                          className={`creator-order-badge creator-order-badge--${item.productionStatus.toLowerCase()}`}
                        >
                          {statusLabel(item.productionStatus)}
                        </span>
                      </td>
                      <td data-label="Actions">
                        <Link
                          to={`/app/creator-orders/${item.id}`}
                          className="creator-order-menu-link"
                          aria-label={`View ${item.orderName}`}
                          title="View order"
                        >
                          <span>View</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No creator orders yet.</strong>
              <span className="dashboard-muted">
                Creator-attributed order lines will appear here after paid
                Shopify orders are processed.
              </span>
            </div>
          )}

          <div className="creator-link-row creator-orders-pagination">
            <span>
              Showing {data.items.length ? (data.page - 1) * 25 + 1 : 0} to{" "}
              {Math.min(data.page * 25, data.total)} of {data.total} lines
            </span>
            <div>
              {data.page > 1 ? (
                <Link
                  className="creator-table-link creator-page-arrow"
                  to={`/app/creator-orders?status=${data.selected}&page=${
                    data.page - 1
                  }${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`}
                  aria-label="Previous page"
                >
                  ‹
                </Link>
              ) : (
                <span className="creator-page-arrow creator-page-arrow--disabled">‹</span>
              )}
              <strong>{data.page}</strong>
              {data.page < data.pageCount ? (
                <Link
                  className="creator-table-link creator-page-arrow"
                  to={`/app/creator-orders?status=${data.selected}&page=${
                    data.page + 1
                  }${data.query ? `&q=${encodeURIComponent(data.query)}` : ""}`}
                  aria-label="Next page"
                >
                  ›
                </Link>
              ) : (
                <span className="creator-page-arrow creator-page-arrow--disabled">›</span>
              )}
            </div>
            <span>Page {data.page} of {data.pageCount}</span>
          </div>
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Orders" />;
}

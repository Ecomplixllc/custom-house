import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from "../services/admin-notifications.server";
import {
  creatorOrderDashboardSummary,
  formatDecimalMoney,
} from "../services/creator-orders.server";
import { creatorEarning } from "../services/creator-sales";
import { formatMinorMoney } from "../services/money";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = 30;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthDay(date: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function toNumber(value: unknown) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  if (
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    return value.toNumber();
  }
  return Number(value) || 0;
}

function formatMoney(amount: number, currencyCode = "USD") {
  return formatMinorMoney(BigInt(Math.round(amount * 100)), currencyCode);
}

function formatInteger(value: number) {
  return String(Math.round(value));
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function metricTone(value: number) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

function makeLinePoints(values: number[], max: number) {
  if (!values.length) return "";
  const width = 560;
  const height = 180;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = Math.round(index * step);
      const y = Math.round(height - (max ? (value / max) * 150 : 0) - 15);
      return `${x},${y}`;
    })
    .join(" ");
}

function readableAction(action: string, entityType: string) {
  const labels: Record<string, string> = {
    "application.approved": "Creator application approved",
    "application.rejected": "Creator application rejected",
    "application.submitted": "New creator application submitted",
    "creator.application.submitted": "New creator application submitted",
    "creator.application.resubmitted": "Creator application resubmitted",
    "creator.application.rejected": "Creator application rejected",
    "creator.approved": "Creator approved",
    "creator.reactivated": "Creator reactivated",
    "creator.suspended": "Creator suspended",
    "submission.approved": "Design submission approved",
    "submission.published": "Product published",
    "submission.rejected": "Design submission rejected",
    "submission.failed": "Publishing job failed",
    "privacy.data_request": "Privacy data request recorded",
  };
  return labels[action] ?? `${action.replaceAll(".", " ")} on ${entityType}`;
}

function timeAgo(date: Date) {
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function compactCount(value: number) {
  if (value <= 0) return "";
  return value > 9 ? "9+" : String(value);
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "MARK_NOTIFICATION_READ") {
    await markAdminNotificationRead(session.shop, String(form.get("notificationId") || ""));
    return { ok: true };
  }
  if (intent === "MARK_ALL_NOTIFICATIONS_READ") {
    await markAllAdminNotificationsRead(session.shop);
    return { ok: true };
  }
  throw new Response("Invalid notification action", { status: 400 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const today = startOfDay(new Date());
  const rangeStart = addDays(today, -(RANGE_DAYS - 1));
  const previousStart = addDays(rangeStart, -RANGE_DAYS);
  const rangeEnd = addDays(today, 1);

  const [
    creatorStatus,
    totalCreators,
    currentCreators,
    previousCreators,
    pendingApplications,
    currentApplications,
    previousApplications,
    totalOrders,
    currentOrders,
    previousOrders,
    productCounts,
    currentProducts,
    previousProducts,
    salesTotals,
    currentSalesTotals,
    previousSalesTotals,
    chartSales,
    audit,
    creatorOrders,
    notifications,
    unreadNotifications,
  ] = await Promise.all([
    db.creator.groupBy({
      by: ["status"],
      where: { shop },
      _count: { _all: true },
    }),
    db.creator.count({ where: { shop } }),
    db.creator.count({
      where: { shop, createdAt: { gte: rangeStart, lt: rangeEnd } },
    }),
    db.creator.count({
      where: { shop, createdAt: { gte: previousStart, lt: rangeStart } },
    }),
    db.creator.count({ where: { shop, status: "PENDING" } }),
    db.creator.count({
      where: {
        shop,
        status: "PENDING",
        createdAt: { gte: rangeStart, lt: rangeEnd },
      },
    }),
    db.creator.count({
      where: {
        shop,
        status: "PENDING",
        createdAt: { gte: previousStart, lt: rangeStart },
      },
    }),
    db.creatorSale.findMany({
      where: { shop },
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
    db.creatorSale.findMany({
      where: { shop, createdAt: { gte: rangeStart, lt: rangeEnd } },
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
    db.creatorSale.findMany({
      where: { shop, createdAt: { gte: previousStart, lt: rangeStart } },
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
    Promise.all([
      db.creatorDesign.count({
        where: { shop, status: { in: ["ACTIVE", "PROCESSING"] } },
      }),
      db.designSubmission.count({
        where: { shop, status: "PUBLISHED", createdProductId: { not: null } },
      }),
    ]),
    Promise.all([
      db.creatorDesign.count({
        where: {
          shop,
          status: { in: ["ACTIVE", "PROCESSING"] },
          createdAt: { gte: rangeStart, lt: rangeEnd },
        },
      }),
      db.designSubmission.count({
        where: {
          shop,
          status: "PUBLISHED",
          createdProductId: { not: null },
          publishedAt: { gte: rangeStart, lt: rangeEnd },
        },
      }),
    ]),
    Promise.all([
      db.creatorDesign.count({
        where: {
          shop,
          status: { in: ["ACTIVE", "PROCESSING"] },
          createdAt: { gte: previousStart, lt: rangeStart },
        },
      }),
      db.designSubmission.count({
        where: {
          shop,
          status: "PUBLISHED",
          createdProductId: { not: null },
          publishedAt: { gte: previousStart, lt: rangeStart },
        },
      }),
    ]),
    db.creatorSale.groupBy({
      by: ["currencyCode"],
      where: { shop },
      _sum: { grossSalesAmount: true, refundedSalesAmount: true },
    }),
    db.creatorSale.groupBy({
      by: ["currencyCode"],
      where: { shop, createdAt: { gte: rangeStart, lt: rangeEnd } },
      _sum: { grossSalesAmount: true, refundedSalesAmount: true },
    }),
    db.creatorSale.groupBy({
      by: ["currencyCode"],
      where: { shop, createdAt: { gte: previousStart, lt: rangeStart } },
      _sum: { grossSalesAmount: true, refundedSalesAmount: true },
    }),
    db.creatorSale.findMany({
      where: { shop, createdAt: { gte: rangeStart, lt: rangeEnd } },
      select: {
        createdAt: true,
        grossSalesAmount: true,
        refundedSalesAmount: true,
        shopifyOrderId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.auditLog.findMany({
      where: {
        shop,
        NOT: { action: { startsWith: "helium." } },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorType: true,
        createdAt: true,
      },
    }),
    creatorOrderDashboardSummary(shop),
    db.adminNotification.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        message: true,
        actionUrl: true,
        readAt: true,
        createdAt: true,
      },
    }),
    db.adminNotification.count({ where: { shop, readAt: null } }),
  ]);

  const currencyCode = salesTotals[0]?.currencyCode ?? "USD";
  const sumSales = (
    groups: Array<{
      _sum: { grossSalesAmount: unknown; refundedSalesAmount: unknown };
    }>,
  ) =>
    groups.reduce(
      (total, group) =>
        total +
        Math.max(
          toNumber(group._sum.grossSalesAmount) -
            toNumber(group._sum.refundedSalesAmount),
          0,
        ),
      0,
    );

  const days = Array.from({ length: RANGE_DAYS }, (_, index) =>
    addDays(rangeStart, index),
  );
  const salesByDay = new Map(days.map((date) => [dayKey(date), 0]));
  const ordersByDay = new Map(days.map((date) => [dayKey(date), new Set()]));
  for (const sale of chartSales) {
    const key = dayKey(sale.createdAt);
    salesByDay.set(
      key,
      (salesByDay.get(key) ?? 0) +
        Math.max(
          toNumber(sale.grossSalesAmount) - toNumber(sale.refundedSalesAmount),
          0,
        ),
    );
    ordersByDay.get(key)?.add(sale.shopifyOrderId);
  }

  const salesValues = days.map((date) => salesByDay.get(dayKey(date)) ?? 0);
  const orderValues = days.map(
    (date) => ordersByDay.get(dayKey(date))?.size ?? 0,
  );
  const chartMax = Math.max(...salesValues, ...orderValues.map((v) => v * 100), 1);
  const statusTotal = Math.max(totalCreators, 1);
  const statusCounts = new Map(
    creatorStatus.map((status) => [status.status, status._count._all]),
  );
  const totalProducts = productCounts[0] + productCounts[1];
  const currentProductsCount = currentProducts[0] + currentProducts[1];
  const previousProductsCount = previousProducts[0] + previousProducts[1];
  const currentSales = sumSales(currentSalesTotals);
  const previousSales = sumSales(previousSalesTotals);
  const allSales = sumSales(salesTotals);
  const creatorOrderStatusCounts = new Map(
    creatorOrders.statuses.map((status) => [
      status.productionStatus,
      status._count._all,
    ]),
  );
  const recentCreatorOrders = creatorOrders.recent.map((item) => {
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
      creator: item.creatorNameSnapshot,
      design: item.creatorProductTitleSnapshot,
      status: item.productionStatus.replaceAll("_", " "),
      commission:
        sale && commission
          ? formatDecimalMoney(commission, sale.currencyCode)
          : "-",
    };
  });
  const activityCreatorIds = Array.from(
    new Set(
      audit
        .filter((item) => item.entityType === "Creator")
        .map((item) => item.entityId)
        .filter(Boolean),
    ),
  );
  const activityCreators = activityCreatorIds.length
    ? await db.creator.findMany({
        where: { shop, id: { in: activityCreatorIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const activityCreatorNames = new Map(
    activityCreators.map((creator) => [creator.id, creator.displayName]),
  );

  return {
    dateRange: `${monthDay(rangeStart)} - ${monthDay(today)}, ${today.getFullYear()}`,
    metrics: [
      {
        label: "Total Creators",
        value: formatInteger(totalCreators),
        delta: formatDelta(percentChange(currentCreators, previousCreators)),
        tone: metricTone(percentChange(currentCreators, previousCreators)),
        icon: "creators",
      },
      {
        label: "Pending Applications",
        value: formatInteger(pendingApplications),
        delta: formatDelta(
          percentChange(currentApplications, previousApplications),
        ),
        tone: metricTone(
          percentChange(currentApplications, previousApplications),
        ),
        icon: "applications",
      },
      {
        label: "Total Orders",
        value: formatInteger(totalOrders.length),
        delta: formatDelta(
          percentChange(currentOrders.length, previousOrders.length),
        ),
        tone: metricTone(
          percentChange(currentOrders.length, previousOrders.length),
        ),
        icon: "orders",
      },
      {
        label: "Total Products",
        value: formatInteger(totalProducts),
        delta: formatDelta(
          percentChange(currentProductsCount, previousProductsCount),
        ),
        tone: metricTone(
          percentChange(currentProductsCount, previousProductsCount),
        ),
        icon: "products",
      },
      {
        label: "Total Sales",
        value: formatMoney(allSales, currencyCode),
        delta: formatDelta(percentChange(currentSales, previousSales)),
        tone: metricTone(percentChange(currentSales, previousSales)),
        icon: "sales",
      },
    ],
    chart: {
      labels: [days[0], days[5], days[10], days[15], days[20], days[25], days[29]].map(
        monthDay,
      ),
      salesPoints: makeLinePoints(salesValues, chartMax),
      orderPoints: makeLinePoints(
        orderValues.map((value) => value * 100),
        chartMax,
      ),
      maxLabel: formatMoney(chartMax, currencyCode),
      midLabel: formatMoney(chartMax / 2, currencyCode),
    },
    status: [
      {
        label: "Approved",
        value: statusCounts.get("APPROVED") ?? 0,
        color: "#47bd78",
      },
      {
        label: "Pending",
        value: statusCounts.get("PENDING") ?? 0,
        color: "#ffb74a",
      },
      {
        label: "Rejected",
        value: statusCounts.get("REJECTED") ?? 0,
        color: "#ef5350",
      },
      {
        label: "Suspended",
        value: statusCounts.get("SUSPENDED") ?? 0,
        color: "#a7afbd",
      },
    ].map((item) => ({
      ...item,
      percent: Math.round((item.value / statusTotal) * 1000) / 10,
    })),
    activity: audit.map((item) => ({
      id: item.id,
      message:
        item.entityType === "Creator" && activityCreatorNames.get(item.entityId)
          ? `${activityCreatorNames.get(item.entityId)} ${readableAction(item.action, item.entityType).replace(/^Creator /, "").replace(/^New creator application submitted$/, "submitted a creator application").replace(/^Creator application resubmitted$/, "resubmitted a creator application").replace(/^Creator application rejected$/, "was rejected as a creator").replace(/^approved$/, "was approved as a creator").replace(/^reactivated$/, "was reactivated").replace(/^suspended$/, "was suspended")}`
          : readableAction(item.action, item.entityType),
      actor: item.actorType === "ADMIN" ? "Admin" : item.entityType,
      time: timeAgo(item.createdAt),
      tone: item.action.includes("failed")
        ? "danger"
        : item.action.includes("rejected")
          ? "danger"
          : item.action.includes("approved") || item.action.includes("published") || item.action.includes("reactivated")
            ? "success"
            : item.action.includes("submitted")
              ? "warning"
              : "info",
    })),
    creatorOrders: {
      new: creatorOrderStatusCounts.get("NEW") || 0,
      ready: creatorOrderStatusCounts.get("READY_FOR_PRODUCTION") || 0,
      inProduction: creatorOrderStatusCounts.get("IN_PRODUCTION") || 0,
      recent: recentCreatorOrders,
    },
    notificationCount:
      unreadNotifications,
    notificationBadge: compactCount(unreadNotifications),
    notifications: notifications.map((item) => ({
      id: item.id,
      title: item.title,
      message: item.message,
      actionUrl: item.actionUrl || "/app",
      unread: !item.readAt,
      time: timeAgo(item.createdAt),
    })),
  };
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const conicStops = data.status
    .reduce(
      (parts, item) => {
        const from = parts.offset;
        const to = from + item.percent;
        return {
          offset: to,
          stops: [
            ...parts.stops,
            `${item.color} ${from}% ${to}%`,
          ],
        };
      },
      { offset: 0, stops: [] as string[] },
    )
    .stops.join(", ");

  return (
    <s-page heading="Dashboard">
      <AdminStyles />
      <div className="admin-dashboard">
        <header className="admin-dashboard-header">
          <div>
            <h1>Dashboard</h1>
            <p>Welcome back, Admin</p>
          </div>
          <div className="admin-dashboard-tools">
            <button type="button" className="admin-date-pill">
              <span className="admin-date-pill-icon" aria-hidden="true" />
              {data.dateRange}
            </button>
            <details className="admin-notification-menu">
              <summary className="admin-bell-button" aria-label="Dashboard notifications">
                <span className="admin-bell-icon" aria-hidden="true" />
                {data.notificationBadge ? <strong>{data.notificationBadge}</strong> : null}
              </summary>
              <div className="admin-notification-panel">
                <header>
                  <h2>Notifications</h2>
                  {data.notificationCount > 0 ? (
                    <Form method="post">
                      <button type="submit" name="intent" value="MARK_ALL_NOTIFICATIONS_READ">
                        Mark all as read
                      </button>
                    </Form>
                  ) : null}
                </header>
                {data.notifications.length ? (
                  <div className="admin-notification-list">
                    {data.notifications.map((item) => (
                      <article
                        className={`admin-notification-item${item.unread ? " is-unread" : ""}`}
                        key={item.id}
                      >
                        <span aria-hidden="true" />
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.message}</p>
                          <small>{item.time}</small>
                        </div>
                        <Form method="post">
                          <input type="hidden" name="notificationId" value={item.id} />
                          <button type="submit" name="intent" value="MARK_NOTIFICATION_READ">
                            Read
                          </button>
                        </Form>
                        <Link to={item.actionUrl}>Open</Link>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="admin-notification-empty">No notifications yet.</p>
                )}
              </div>
            </details>
          </div>
        </header>

        <section className="admin-kpi-grid" aria-label="Marketplace metrics">
          {data.metrics.map((metric) => (
            <article className="admin-kpi-card" key={metric.label}>
              <span
                className={`admin-kpi-icon admin-kpi-icon--${metric.icon}`}
                aria-hidden="true"
              />
              <div>
                <p>{metric.label}</p>
                <strong>{metric.value}</strong>
                <small className={`admin-delta admin-delta--${metric.tone}`}>
                  {metric.delta}
                </small>
                <em>vs previous 30 days</em>
              </div>
            </article>
          ))}
        </section>

        <section className="admin-dashboard-main">
          <article className="admin-panel admin-sales-panel">
            <div className="admin-panel-heading">
              <h2>Sales Overview</h2>
              <button type="button">Last 30 days</button>
            </div>
            <div className="admin-chart-legend">
              <span>Sales</span>
              <span>Orders</span>
            </div>
            <div className="admin-chart-wrap">
              <div className="admin-chart-scale">
                <span>{data.chart.maxLabel}</span>
                <span>{data.chart.midLabel}</span>
                <span>$0</span>
              </div>
              <svg viewBox="0 0 560 190" role="img" aria-label="Sales and orders chart">
                <path d="M0 40H560M0 95H560M0 150H560" />
                <polyline className="admin-chart-orders" points={data.chart.orderPoints} />
                <polyline className="admin-chart-sales" points={data.chart.salesPoints} />
              </svg>
            </div>
            <div className="admin-chart-labels">
              {data.chart.labels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </article>

          <article className="admin-panel admin-status-panel">
            <h2>Creator Status</h2>
            <div className="admin-status-content">
              <div
                className="admin-donut"
                style={{
                  background: conicStops
                    ? `conic-gradient(${conicStops})`
                    : "#eef2f7",
                }}
                aria-hidden="true"
              />
              <div className="admin-status-list">
                {data.status.map((item) => (
                  <div key={item.label}>
                    <span style={{ background: item.color }} />
                    <p>{item.label}</p>
                    <strong>
                      {formatInteger(item.value)} ({item.percent}%)
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          </article>
        </section>

        <section className="admin-panel admin-activity-panel">
          <div className="admin-panel-heading">
            <h2>Recent Creator Orders</h2>
            <Link to="/app/creator-orders">View all</Link>
          </div>
          <div className="dashboard-metric-grid">
            <div className="dashboard-metric-card">
              <span>New Creator Orders</span>
              <strong>{data.creatorOrders.new}</strong>
            </div>
            <div className="dashboard-metric-card">
              <span>Ready for Production</span>
              <strong>{data.creatorOrders.ready}</strong>
            </div>
            <div className="dashboard-metric-card">
              <span>In Production</span>
              <strong>{data.creatorOrders.inProduction}</strong>
            </div>
          </div>
          {data.creatorOrders.recent.length ? (
            <div className="admin-activity-list">
              {data.creatorOrders.recent.map((item) => (
                <article className="admin-activity-row" key={item.id}>
                  <span
                    className="admin-activity-icon admin-activity-icon--info"
                    aria-hidden="true"
                  />
                  <p>
                    {item.orderName} - {item.design}
                  </p>
                  <Link to={`/app/creator-orders/${item.id}`}>{item.creator}</Link>
                  <time>
                    {item.status} | {item.commission}
                  </time>
                </article>
              ))}
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No creator orders yet.</strong>
              <span className="dashboard-muted">
                Paid creator order lines will appear here after webhooks run.
              </span>
            </div>
          )}
        </section>

        <section className="admin-panel admin-activity-panel">
          <div className="admin-panel-heading">
            <h2>Recent Activity</h2>
            <Link to="/app/creators">View all activity</Link>
          </div>
          {data.activity.length ? (
            <div className="admin-activity-list">
              {data.activity.map((item) => (
                <article className="admin-activity-row" key={item.id}>
                  <span
                    className={`admin-activity-icon admin-activity-icon--${item.tone}`}
                    aria-hidden="true"
                  />
                  <p>{item.message}</p>
                  <Link to="/app/creators">{item.actor}</Link>
                  <time>{item.time}</time>
                </article>
              ))}
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No activity has been recorded yet.</strong>
              <span className="dashboard-muted">
                Creator reviews and synchronization events will appear here.
              </span>
            </div>
          )}
          <Link className="admin-activity-more" to="/app/creators">
            View all activity
          </Link>
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Dashboard" />;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { CreatorStatus, ReferralAttributionStatus } from "@prisma/client";
import { AdminStyles, SafeAdminError, StatusBadge } from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { adminReferralEarningsSummary } from "../services/creator-referral-earnings.server";

const CREATOR_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] as const;
const REFERRAL_STAGES = ["CAPTURED", "CONVERTED"] as const;

function parseStage(value: string | null): ReferralAttributionStatus | null {
  const normalized = value?.toUpperCase();
  return REFERRAL_STAGES.find((item) => item === normalized) || null;
}

function parseCreatorStatus(value: string | null): CreatorStatus | null {
  const normalized = value?.toUpperCase();
  return CREATOR_STATUSES.find((item) => item === normalized) || null;
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function totalsLabel(
  totals: Array<{ original: string; adjustments: string; final: string }> | undefined,
  field: "original" | "adjustments" | "final",
) {
  return totals?.map((total) => total[field]).filter(Boolean).join(" + ") || "0.00 kr";
}

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const stage = parseStage(url.searchParams.get("stage"));
  const creatorStatus = parseCreatorStatus(url.searchParams.get("status"));
  const earningsPage = Number(url.searchParams.get("earningsPage") || "1");

  const matchingReferredCreators =
    q || creatorStatus
      ? await db.creator.findMany({
          where: {
            shop: session.shop,
            ...(creatorStatus ? { status: creatorStatus } : {}),
            ...(q
              ? {
                  OR: [
                    { displayName: { contains: q, mode: "insensitive" as const } },
                    { handle: { contains: q, mode: "insensitive" as const } },
                    { emailSnapshot: { contains: q, mode: "insensitive" as const } },
                  ],
                }
              : {}),
          },
          select: {
            shop: true,
            customerId: true,
          },
        })
      : [];
  const matchingCustomerIds = matchingReferredCreators.map((creator) => creator.customerId);
  const impossibleCreatorStatusFilter = Boolean(creatorStatus && matchingCustomerIds.length === 0);
  const impossibleSearchFilter = Boolean(q && matchingCustomerIds.length === 0);

  const rows = impossibleCreatorStatusFilter
    ? []
    : await db.referralAttribution.findMany({
        where: {
          shop: session.shop,
          ...(stage ? { status: stage } : {}),
          ...(creatorStatus ? { shopifyCustomerId: { in: matchingCustomerIds } } : {}),
          ...(q
            ? {
                OR: [
                  { referralCodeSnapshot: { contains: q, mode: "insensitive" as const } },
                  {
                    referrerCreator: {
                      is: { displayName: { contains: q, mode: "insensitive" as const } },
                    },
                  },
                  ...(impossibleSearchFilter
                    ? []
                    : [{ shopifyCustomerId: { in: matchingCustomerIds } }]),
                ],
              }
            : {}),
        },
        include: {
          referrerCreator: {
            select: {
              id: true,
              displayName: true,
              referralCode: true,
            },
          },
        },
        orderBy: { capturedAt: "desc" },
        take: 150,
      });

  const referredCustomerIds = rows.map((row) => row.shopifyCustomerId);
  const referredCreators = referredCustomerIds.length
    ? await db.creator.findMany({
        where: {
          shop: session.shop,
          customerId: { in: referredCustomerIds },
        },
        select: {
          id: true,
          displayName: true,
          customerId: true,
          status: true,
          referredByCreatorId: true,
        },
      })
    : [];
  const referredCreatorByCustomer = new Map(
    referredCreators.map((creator) => [creator.customerId, creator]),
  );

  for (const row of rows) {
    const creator = referredCreatorByCustomer.get(row.shopifyCustomerId);
    if (
      row.status === "CONVERTED" &&
      creator?.referredByCreatorId &&
      creator.referredByCreatorId !== row.referrerCreatorId
    ) {
      console.warn("creator_referral_inconsistency_detected", {
        shop: session.shop,
        attributionId: row.id,
        creatorId: creator.id,
      });
    }
  }

  const [leadCount, convertedCount, referredStatusCounts, financial] = await Promise.all([
    db.referralAttribution.count({ where: { shop: session.shop, status: "CAPTURED" } }),
    db.referralAttribution.count({ where: { shop: session.shop, status: "CONVERTED" } }),
    db.creator.groupBy({
      by: ["status"],
      where: { shop: session.shop, referredByCreatorId: { not: null } },
      _count: { _all: true },
    }),
    adminReferralEarningsSummary(session.shop, { page: earningsPage, pageSize: 25 }),
  ]);

  return {
    filters: { q, stage: stage || "ALL", status: creatorStatus || "ALL" },
    rows: rows.map((row) => ({
      ...row,
      referredCreator: referredCreatorByCustomer.get(row.shopifyCustomerId) || null,
    })),
    summary: {
      leads: leadCount,
      converted: convertedCount,
      creatorStatuses: Object.fromEntries(
        referredStatusCounts.map((item) => [item.status, item._count._all]),
      ),
    },
    financial,
  };
}

export default function ReferralOverview() {
  const { financial, rows, summary } = useLoaderData<typeof loader>();
  const totalReferrals = summary.leads + summary.converted;
  const approvedReferrals = Number(summary.creatorStatuses.APPROVED || 0);
  const rejectedReferrals = Number(summary.creatorStatuses.REJECTED || 0);
  const topReferrer = financial.summary.byReferrer[0] || null;
  const dateRangeStart =
    financial.rows[financial.rows.length - 1]?.createdAt || rows[rows.length - 1]?.capturedAt;
  const dateRangeEnd = financial.rows[0]?.createdAt || rows[0]?.capturedAt || new Date();
  const conversionRate = totalReferrals
    ? Math.round((summary.converted / totalReferrals) * 100)
    : 0;

  function exportCsv() {
    const header = [
      "Date",
      "Referrer",
      "Referred Creator",
      "Creator Sale Source",
      "Base Earning",
      "Rate",
      "Amount",
    ];
    const csv = [
      header.join(","),
      ...financial.rows.map((earning) =>
        [
          formatDateTime(earning.createdAt),
          earning.referrerCreator?.displayName || "Unknown creator",
          earning.referredCreator?.displayName || "Unknown creator",
          earning.creatorSale?.id || earning.shopifyOrderId,
          earning.baseCreatorEarning,
          earning.ratePercent,
          earning.finalEntitlement,
        ].map(csvCell).join(","),
      ),
    ].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `referral-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <s-page heading="Referral Overview">
      <AdminStyles />
      <div className="creator-admin-page referral-admin-page">
        <header className="referral-hero">
          <span className="referral-hero-icon" aria-hidden="true" />
          <div>
            <h1>Referral Overview</h1>
            <p>Track referral performance and earnings from creators</p>
          </div>
          <div className="referral-date-pill">
            <span aria-hidden="true" />
            {formatShortDate(dateRangeStart)} - {formatShortDate(dateRangeEnd)}
          </div>
        </header>

        <section className="creator-admin-stats referral-admin-stats">
          <article className="referral-stat-card referral-stat-card--total">
            <span className="referral-card-icon referral-card-icon--people" aria-hidden="true" />
            <div>
              <p>Total Referrals</p>
              <strong>{totalReferrals}</strong>
              <small>All time referrals</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--up">12%</em>
          </article>
          <article className="referral-stat-card referral-stat-card--converted">
            <span className="referral-card-icon referral-card-icon--gift" aria-hidden="true" />
            <div>
              <p>Converted Applications</p>
              <strong>{summary.converted}</strong>
              <small>Referral attribution converted</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--up">12%</em>
          </article>
          <article className="referral-stat-card referral-stat-card--pending">
            <span className="referral-card-icon referral-card-icon--clock" aria-hidden="true" />
            <div>
              <p>Pending</p>
              <strong>{summary.creatorStatuses.PENDING || 0}</strong>
              <small>Referred creators pending</small>
            </div>
          </article>
          <article className="referral-stat-card referral-stat-card--approved">
            <span className="referral-card-icon referral-card-icon--check" aria-hidden="true" />
            <div>
              <p>Approved</p>
              <strong>{approvedReferrals}</strong>
              <small>Referred creators approved</small>
            </div>
          </article>
        </section>

        <section className="referral-dashboard-grid">
          <article className="referral-dashboard-panel referral-earnings-panel">
            <header>
              <span className="referral-panel-icon referral-panel-icon--earnings" aria-hidden="true" />
              <h2>Referral Earnings</h2>
              <Link to="#referral-transactions">View All Earnings</Link>
            </header>
            <div className="referral-earnings-metrics">
              <div className="referral-total-earned">
                <strong>{totalsLabel(financial.summary.totals, "final")}</strong>
                <small>Total Earnings</small>
              </div>
              <span>
                <strong>2%</strong>
                <small>Referral Rate</small>
              </span>
              <span>
                <strong>{totalsLabel(financial.summary.totals, "original")}</strong>
                <small>Per Referral</small>
              </span>
              <span>
                <strong>{summary.converted}</strong>
                <small>Active Referrals</small>
              </span>
            </div>
            <div className="referral-line-chart" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          </article>

          <article className="referral-dashboard-panel referral-activity-panel">
            <header>
              <span className="referral-panel-icon referral-panel-icon--activity" aria-hidden="true" />
              <h2>Referral Activity</h2>
              <button type="button">This Month</button>
            </header>
            <div className="referral-activity-metrics">
              <span><strong>{summary.leads}</strong><small>Leads</small></span>
              <span><strong>{summary.converted}</strong><small>Converted</small></span>
              <span><strong>{rejectedReferrals}</strong><small>Rejected</small></span>
              <span><strong>{approvedReferrals}</strong><small>Approved</small></span>
            </div>
            <div className="referral-conversion-row">
              <div className="referral-donut">
                <strong>{conversionRate}%</strong>
                <small>Conversion</small>
              </div>
              <div className="referral-legend">
                <span><i />Converted - {summary.converted} ({conversionRate}%)</span>
                <span><i />Not Converted - {summary.leads} ({Math.max(0, 100 - conversionRate)}%)</span>
              </div>
              <div className="referral-top-card">
                <span aria-hidden="true" />
                <small>Top Referrer</small>
                <strong>{topReferrer?.displayName || "No referrer yet"}</strong>
                <small>{topReferrer ? summary.converted : 0} conversion{summary.converted === 1 ? "" : "s"}</small>
              </div>
            </div>
          </article>
        </section>

        <section className="referral-dashboard-panel referral-transactions-panel" id="referral-transactions">
          <header>
            <span className="referral-panel-icon referral-panel-icon--list" aria-hidden="true" />
            <h2>Referral Transactions</h2>
            <button type="button" className="referral-export-button" onClick={exportCsv}>
              Export CSV
            </button>
          </header>
          {financial.rows.length ? (
            <div className="creator-table-wrap">
              <table className="creator-table referral-transactions-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Referrer</th>
                    <th scope="col">Referred Creator</th>
                    <th scope="col">Creator Sale Source</th>
                    <th scope="col">Base Earning</th>
                    <th scope="col">Rate</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {financial.rows.map((earning) => (
                    <tr key={earning.id}>
                      <td data-label="Date">{formatDateTime(earning.createdAt)}</td>
                      <td data-label="Referrer">
                        {earning.referrerCreator ? (
                          <Link to={`/app/creators?creator=${earning.referrerCreator.id}`}>
                            {earning.referrerCreator.displayName}
                          </Link>
                        ) : (
                          "Unknown creator"
                        )}
                      </td>
                      <td data-label="Referred Creator">
                        {earning.referredCreator ? (
                          <Link to={`/app/creators?creator=${earning.referredCreator.id}`}>
                            {earning.referredCreator.displayName || "Unnamed creator"}
                          </Link>
                        ) : (
                          "Unknown creator"
                        )}
                      </td>
                      <td data-label="Creator Sale Source">{earning.creatorSale?.id || earning.shopifyOrderId}</td>
                      <td data-label="Base Earning">{earning.baseCreatorEarning}</td>
                      <td data-label="Rate">{earning.ratePercent}</td>
                      <td data-label="Amount"><strong>{earning.finalEntitlement}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dashboard-empty">No referral earnings have been recorded.</div>
          )}
        </section>

        <section className="referral-summary-grid">
          <article className="referral-dashboard-panel">
            <header>
              <span className="referral-panel-icon referral-panel-icon--people" aria-hidden="true" />
              <h2>By Referrer</h2>
            </header>
            {financial.summary.byReferrer.length ? (
              <div className="creator-table-wrap creator-referral-table-wrap">
                <table className="creator-table creator-referral-table">
                  <thead>
                    <tr>
                      <th scope="col">Creator</th>
                      <th scope="col">Status</th>
                      <th scope="col">Original</th>
                      <th scope="col">Adjustments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {financial.summary.byReferrer.map((creator) => (
                      <tr key={creator.creatorId}>
                        <td data-label="Creator">
                          <Link to={`/app/creators?creator=${creator.creatorId}`}>
                            {creator.displayName}
                          </Link>
                        </td>
                        <td data-label="Status"><StatusBadge status={creator.status} /></td>
                        <td data-label="Original">{totalsLabel(creator.totals, "original")}</td>
                        <td data-label="Adjustments">{totalsLabel(creator.totals, "adjustments")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="creator-referral-empty">No referrer earnings yet.</p>
            )}
          </article>
          <article className="referral-dashboard-panel">
            <header>
              <span className="referral-panel-icon referral-panel-icon--user" aria-hidden="true" />
              <h2>By Referred Creator</h2>
            </header>
            {financial.summary.byReferredCreator.length ? (
              <div className="creator-table-wrap creator-referral-table-wrap">
                <table className="creator-table creator-referral-table">
                  <thead>
                    <tr>
                      <th scope="col">Creator</th>
                      <th scope="col">Status</th>
                      <th scope="col">Original</th>
                      <th scope="col">Adjustments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {financial.summary.byReferredCreator.map((creator) => (
                      <tr key={creator.creatorId}>
                        <td data-label="Creator">
                          <Link to={`/app/creators?creator=${creator.creatorId}`}>
                            {creator.displayName}
                          </Link>
                        </td>
                        <td data-label="Status"><StatusBadge status={creator.status} /></td>
                        <td data-label="Original">{totalsLabel(creator.totals, "original")}</td>
                        <td data-label="Adjustments">{totalsLabel(creator.totals, "adjustments")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="creator-referral-empty">No referred creator earnings yet.</p>
            )}
          </article>
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Referral overview unavailable" />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

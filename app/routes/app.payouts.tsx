import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AdminStyles, SafeAdminError, StatusBadge, SubmitButton } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  adminPayoutDetail,
  adminPayoutsSummary,
  approvePayout,
  markPayoutPaid,
  rejectPayout,
} from "../services/payouts.server";

const PAYOUT_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PROCESSING",
  "PAID",
  "REJECTED",
  "CANCELLED",
  "FAILED",
] as const;

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join(" ");
}

function statusClass(value: string) {
  return value.toLowerCase().replace(/_/g, "-");
}

function detailEntries(details: Record<string, string | null> | null | undefined) {
  return Object.entries(details || {}).filter(([, value]) => value);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const currency = url.searchParams.get("currency");
  const payoutId = url.searchParams.get("payoutId");
  const page = Number(url.searchParams.get("page") || "1");
  const [summary, selectedPayout] = await Promise.all([
    adminPayoutsSummary(session.shop, { status, currency, page, pageSize: 25 }),
    payoutId ? adminPayoutDetail(session.shop, payoutId).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    filters: { status: status || "ALL", currency: currency || "", payoutId: payoutId || "" },
    selectedPayout,
    summary,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "approve") {
    await approvePayout({
      shop: session.shop,
      payoutId: String(form.get("payoutId") || ""),
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  if (intent === "reject") {
    await rejectPayout({
      shop: session.shop,
      payoutId: String(form.get("payoutId") || ""),
      rejectionReason: String(form.get("rejectionReason") || ""),
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  if (intent === "mark-paid") {
    await markPayoutPaid({
      shop: session.shop,
      payoutId: String(form.get("payoutId") || ""),
      transactionReference: String(form.get("transactionReference") || ""),
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  return redirect("/app/payouts");
}

export default function AdminPayouts() {
  const { filters, selectedPayout, summary } = useLoaderData<typeof loader>();
  const statusCounts = summary.statusCounts || {};

  return (
    <s-page heading="Creator Payouts">
      <AdminStyles />
      <div className="creator-admin-page payout-admin-page">
        <header className="payout-admin-header">
          <span className="payout-home-icon" aria-hidden="true" />
          <span className="payout-header-divider" aria-hidden="true">/</span>
          <h1>Creator Payouts</h1>
          <button type="button" className="payout-header-menu" aria-label="More payout options" />
        </header>

        <section className="creator-admin-stats payout-status-grid">
          {PAYOUT_STATUSES.map((status) => (
            <article key={status} className={`payout-stat-card payout-stat-card--${statusClass(status)}`}>
              <span className="payout-stat-icon" aria-hidden="true" />
              <div>
                <p>{titleCase(status)}</p>
                <strong>{statusCounts[status] || 0}</strong>
                <small>records</small>
              </div>
            </article>
          ))}
        </section>

        <section className="creator-admin-card payout-admin-panel payout-history-panel">
          <header className="payout-panel-header">
            <div>
              <h2>Payout History</h2>
              <p>Review creator payout requests, status changes, and manual payment records.</p>
            </div>
          </header>
          <Form method="get" className="creator-filter-bar payout-filter-form">
            <label>
              Status
              <select name="status" defaultValue={filters.status}>
                <option value="ALL">All</option>
                {PAYOUT_STATUSES.map((status) => (
                  <option key={status} value={status}>{titleCase(status)}</option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <input name="currency" defaultValue={filters.currency} placeholder="SEK" />
            </label>
            <button type="submit" className="payout-filter-button">Filter Payouts</button>
          </Form>
          <p className="creator-admin-table-note">
            Default view is All statuses, including rejected and cancelled payout history.
          </p>
          <div className="creator-table-wrap">
            <table className="creator-table payout-table payout-history-table">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Method</th>
                  <th>Amount</th>
                  <th>Product</th>
                  <th>Referral</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.length ? summary.rows.map((payout) => (
                  <tr key={payout.id}>
                    <td data-label="Creator">
                      <Link to={`/app/payouts?payoutId=${payout.id}`}>{payout.creator.displayName}</Link>
                    </td>
                    <td data-label="Method">{payout.method}</td>
                    <td data-label="Amount">{payout.amount}</td>
                    <td data-label="Product">{payout.productAllocation}</td>
                    <td data-label="Referral">{payout.referralAllocation}</td>
                    <td data-label="Status"><StatusBadge status={payout.status} /></td>
                    <td data-label="Requested">{formatDateTime(payout.requestedAt)}</td>
                    <td data-label="Actions">
                      <div className="creator-inline-actions payout-action-group">
                        <Link className="payout-view-link" to={`/app/payouts?payoutId=${payout.id}`}>View</Link>
                        {payout.status === "REQUESTED" ? (
                          <>
                          <Form method="post">
                            <input type="hidden" name="intent" value="approve" />
                            <input type="hidden" name="payoutId" value={payout.id} />
                            <SubmitButton>Approve</SubmitButton>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="reject" />
                            <input type="hidden" name="payoutId" value={payout.id} />
                            <input name="rejectionReason" placeholder="Reason" required />
                            <SubmitButton>Reject</SubmitButton>
                          </Form>
                          </>
                        ) : payout.status === "APPROVED" ? (
                        <Form method="post" className="creator-inline-actions payout-action-group">
                          <input type="hidden" name="intent" value="mark-paid" />
                          <input type="hidden" name="payoutId" value={payout.id} />
                          <input name="transactionReference" placeholder="Payment reference" required />
                          <SubmitButton>Mark Paid</SubmitButton>
                        </Form>
                      ) : (
                        <span className="payout-muted-action">No action</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={8}>No payout requests found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="creator-admin-table-note">
            Showing {summary.rows.length} of {summary.total} payout records.
          </p>
        </section>

        {selectedPayout ? (
          <div className="payout-detail-modal-backdrop" role="presentation">
            <section
              aria-labelledby="payout-detail-title"
              aria-modal="true"
              className="creator-admin-card payout-admin-panel payout-detail-modal"
              role="dialog"
            >
              <header className="payout-panel-header payout-detail-modal-header">
                <div>
                  <h2 id="payout-detail-title">Payout History Detail</h2>
                  <p>{selectedPayout.creator.displayName} · {selectedPayout.amount} · {selectedPayout.currency}</p>
                </div>
                <div className="creator-inline-actions payout-action-group">
                  <StatusBadge status={selectedPayout.status} />
                  <Link className="payout-modal-close" to="/app/payouts" aria-label="Close payout details">Close</Link>
                </div>
              </header>
              {selectedPayout.methodDetailsError ? (
                <s-banner tone="critical">{selectedPayout.methodDetailsError}</s-banner>
              ) : null}
              <div className="payout-detail-grid">
                <section>
                  <h3>Payout History</h3>
                  <dl className="creator-admin-definition-grid">
                    <dt>Requested</dt>
                    <dd>{selectedPayout.requestedAmount}</dd>
                    <dt>Fee</dt>
                    <dd>{selectedPayout.fee}</dd>
                    <dt>Net</dt>
                    <dd>{selectedPayout.netAmount}</dd>
                    <dt>Product Allocation</dt>
                    <dd>{selectedPayout.productAllocation}</dd>
                    <dt>Referral Allocation</dt>
                    <dd>{selectedPayout.referralAllocation}</dd>
                    <dt>Requested At</dt>
                    <dd>{formatDateTime(selectedPayout.requestedAt)}</dd>
                    <dt>Approved At</dt>
                    <dd>{formatDateTime(selectedPayout.approvedAt)}</dd>
                    <dt>Paid At</dt>
                    <dd>{formatDateTime(selectedPayout.paidAt)}</dd>
                    <dt>Rejected At</dt>
                    <dd>{formatDateTime(selectedPayout.rejectedAt)}</dd>
                    <dt>Cancelled At</dt>
                    <dd>{formatDateTime(selectedPayout.cancelledAt)}</dd>
                    <dt>Transaction Reference</dt>
                    <dd>{selectedPayout.transactionReference || "Not recorded"}</dd>
                  </dl>
                </section>
                <section>
                  <h3>Payment Snapshot</h3>
                  <dl className="creator-admin-definition-grid">
                    <dt>Method</dt>
                    <dd>{selectedPayout.method}</dd>
                    {detailEntries(selectedPayout.methodDetails).map(([key, value]) => (
                      <div key={key}>
                        <dt>{titleCase(key)}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                    <dt>Creator Note</dt>
                    <dd>{selectedPayout.creatorNote || "Not recorded"}</dd>
                    <dt>Admin Note</dt>
                    <dd>{selectedPayout.adminNote || "Not recorded"}</dd>
                    <dt>Rejection Reason</dt>
                    <dd>{selectedPayout.rejectionReason || "Not recorded"}</dd>
                  </dl>
                </section>
              </div>
            </section>
          </div>
        ) : filters.payoutId ? (
          <div className="payout-detail-modal-backdrop" role="presentation">
            <section
              aria-labelledby="payout-detail-missing-title"
              aria-modal="true"
              className="creator-admin-card payout-admin-panel payout-detail-modal payout-detail-modal--small"
              role="dialog"
            >
              <header className="payout-panel-header payout-detail-modal-header">
                <div>
                  <h2 id="payout-detail-missing-title">Payout History Detail</h2>
                  <p>This payout record could not be found. It may have been removed or belongs to another shop.</p>
                </div>
                <Link className="payout-modal-close" to="/app/payouts" aria-label="Close payout details">Close</Link>
              </header>
            </section>
          </div>
        ) : null}

      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <AdminStyles />
      <SafeAdminError />
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

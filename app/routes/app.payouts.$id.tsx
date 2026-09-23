import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AdminStyles, SafeAdminError, StatusBadge, SubmitButton } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  adminPayoutDetail,
  approvePayout,
  markPayoutPaid,
  rejectPayout,
} from "../services/payouts.server";

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

function detailEntries(details: Record<string, string | null> | null | undefined) {
  return Object.entries(details || {}).filter(([, value]) => value);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const payoutId = params.id || "";
  if (!payoutId) return redirect("/app/payouts");
  const payout = await adminPayoutDetail(session.shop, payoutId);
  return { payout };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const payoutId = params.id || "";
  if (!payoutId) return redirect("/app/payouts");
  if (intent === "approve") {
    await approvePayout({
      shop: session.shop,
      payoutId,
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  if (intent === "reject") {
    await rejectPayout({
      shop: session.shop,
      payoutId,
      rejectionReason: String(form.get("rejectionReason") || ""),
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  if (intent === "mark-paid") {
    await markPayoutPaid({
      shop: session.shop,
      payoutId,
      transactionReference: String(form.get("transactionReference") || ""),
      adminNote: String(form.get("adminNote") || ""),
    });
  }
  return redirect(`/app/payouts/${encodeURIComponent(payoutId)}`);
}

export default function AdminPayoutDetail() {
  const { payout } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Payout History Detail">
      <AdminStyles />
      <div className="creator-admin-page payout-admin-page payout-detail-page">
        <header className="payout-admin-header">
          <span className="payout-home-icon" aria-hidden="true" />
          <span className="payout-header-divider" aria-hidden="true">/</span>
          <h1>Payout History Detail</h1>
          <Link className="payout-modal-close" to="/app/payouts">Back</Link>
        </header>

        <section className="creator-admin-card payout-admin-panel payout-detail-header">
          <header className="payout-panel-header">
            <div>
              <h2>{payout.creator.displayName}</h2>
              <p>{payout.amount} · {payout.currency}</p>
            </div>
            <div className="creator-inline-actions payout-action-group">
              <StatusBadge status={payout.status} />
              {payout.status === "REQUESTED" ? (
                <>
                  <Form method="post">
                    <input type="hidden" name="intent" value="approve" />
                    <SubmitButton>Approve</SubmitButton>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reject" />
                    <input name="rejectionReason" placeholder="Reason" required />
                    <SubmitButton>Reject</SubmitButton>
                  </Form>
                </>
              ) : payout.status === "APPROVED" ? (
                <Form method="post" className="creator-inline-actions payout-action-group">
                  <input type="hidden" name="intent" value="mark-paid" />
                  <input name="transactionReference" placeholder="Payment reference" required />
                  <SubmitButton>Mark Paid</SubmitButton>
                </Form>
              ) : null}
            </div>
          </header>
        </section>

        {payout.methodDetailsError ? (
          <s-banner tone="critical">{payout.methodDetailsError}</s-banner>
        ) : null}

        <div className="payout-detail-grid">
          <section className="creator-admin-card payout-admin-panel">
            <h2>Payout History</h2>
            <dl className="creator-admin-definition-grid">
              <dt>Requested</dt>
              <dd>{payout.requestedAmount}</dd>
              <dt>Fee</dt>
              <dd>{payout.fee}</dd>
              <dt>Net</dt>
              <dd>{payout.netAmount}</dd>
              <dt>Product Allocation</dt>
              <dd>{payout.productAllocation}</dd>
              <dt>Referral Allocation</dt>
              <dd>{payout.referralAllocation}</dd>
              <dt>Requested At</dt>
              <dd>{formatDateTime(payout.requestedAt)}</dd>
              <dt>Approved At</dt>
              <dd>{formatDateTime(payout.approvedAt)}</dd>
              <dt>Paid At</dt>
              <dd>{formatDateTime(payout.paidAt)}</dd>
              <dt>Rejected At</dt>
              <dd>{formatDateTime(payout.rejectedAt)}</dd>
              <dt>Cancelled At</dt>
              <dd>{formatDateTime(payout.cancelledAt)}</dd>
              <dt>Transaction Reference</dt>
              <dd>{payout.transactionReference || "Not recorded"}</dd>
            </dl>
          </section>
          <section className="creator-admin-card payout-admin-panel">
            <h2>Payment Snapshot</h2>
            <dl className="creator-admin-definition-grid">
              <dt>Method</dt>
              <dd>{payout.method}</dd>
              {detailEntries(payout.methodDetails).map(([key, value]) => (
                <div key={key}>
                  <dt>{titleCase(key)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              <dt>Creator Note</dt>
              <dd>{payout.creatorNote || "Not recorded"}</dd>
              <dt>Admin Note</dt>
              <dd>{payout.adminNote || "Not recorded"}</dd>
              <dt>Rejection Reason</dt>
              <dd>{payout.rejectionReason || "Not recorded"}</dd>
            </dl>
          </section>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Payout history detail unavailable" />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

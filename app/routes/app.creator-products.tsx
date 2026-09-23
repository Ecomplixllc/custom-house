import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  StatusBadge,
  SubmitButton,
} from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  listCreatorProductsForAdmin,
  cleanupCreatorProductAsAdmin,
  moderateCreatorProductAsAdmin,
} from "../services/creator-products.server";

const FILTERS = ["PENDING", "PUBLISHED", "REJECTED", "DRAFT", "ARCHIVED", "ALL"] as const;

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function projectLabel(value: string | null) {
  if (!value) return "-";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.toUpperCase() || "PENDING";
  const selected = FILTERS.includes(status as (typeof FILTERS)[number])
    ? status
    : "PENDING";
  const products = await listCreatorProductsForAdmin(
    session.shop,
    selected === "ALL" ? null : selected,
  );
  return { products, selected };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const decision = String(form.get("decision") || "");
  const creatorProductId = String(form.get("creatorProductId") || "");
  if (decision === "ARCHIVE" || decision === "DELETE") {
    const result = await cleanupCreatorProductAsAdmin(
      session.shop,
      session.id || null,
      creatorProductId,
      decision,
    );
    return {
      ok: true,
      message: result.hardDeleted
        ? "Creator Product permanently deleted after dependency checks."
        : "Creator Product archived; order and financial history remain preserved.",
    };
  }
  const product = await moderateCreatorProductAsAdmin(
    session.shop,
    null,
    {
      creatorProductId: form.get("creatorProductId"),
      decision,
      rejectionReason: form.get("rejectionReason"),
    },
  );
  return {
    ok: true,
    message:
      product.status === "PUBLISHED"
        ? "Creator Product approved and published to the Custom House marketplace."
        : "Creator Product rejected.",
  };
}

export default function CreatorProductsAdmin() {
  const { products, selected } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Creator Products">
      <AdminStyles />
      <div className="creator-admin-page">
        <header className="creator-admin-header">
          <div>
            <span className="creator-admin-eyebrow">Creator Operations</span>
            <h1>Creator Products</h1>
            <p>
              Review submitted PitchPrint creator drafts and publish them to
              the app-managed Custom House creator marketplace.
            </p>
          </div>
        </header>
        {actionData?.message && (
          <div className="creator-admin-message">{actionData.message}</div>
        )}
        <section className="creator-admin-panel">
          <div className="creator-section-heading">
            <div>
              <h2>{selected === "ALL" ? "All" : selected} Creator Products</h2>
              <p>
                Approval makes the Creator Product visible in the creator&apos;s
                Custom House collection. Checkout uses the original Shopify base
                product and validated variant.
              </p>
            </div>
            <div className="creator-link-row">
              {FILTERS.map((filter) => (
                <Link
                  key={filter}
                  to={`/app/creator-products?status=${filter}`}
                  className="creator-table-link"
                >
                  {filter}
                </Link>
              ))}
            </div>
          </div>
          {products.length ? (
            <div className="creator-application-list">
              {products.map((product) => (
                <article className="creator-application-card" key={product.id}>
                  <div className="creator-application-main">
                    {product.previewUrl?.startsWith("https://") ? (
                      <img src={product.previewUrl} alt="" />
                    ) : (
                      <span>CP</span>
                    )}
                    <div>
                      <h3>{product.title}</h3>
                      <p>{product.baseProductTitle}</p>
                      <small>ID: {product.id}</small>
                    </div>
                  </div>
                  <div className="creator-application-details">
                    <StatusBadge status={product.status} />
                    <p>
                      Creator: <strong>{product.creator.displayName}</strong>{" "}
                      @{product.creator.handle}
                    </p>
                    <p>Customer: {product.creator.customerId}</p>
                    <p>Base product: {product.shopifyProductId}</p>
                    <p>PitchPrint project: {projectLabel(product.pitchprintProjectId)}</p>
                    {product.publishedShopifyProductId ? (
                      <p>Shopify product: {product.publishedShopifyProductId}</p>
                    ) : null}
                    {product.publishedShopifyProductUrl ? (
                      <p>
                        Product URL:{" "}
                        <a href={product.publishedShopifyProductUrl}>
                          {product.publishedShopifyProductUrl}
                        </a>
                      </p>
                    ) : null}
                    <p>Submitted: {formatDate(product.submittedAt)}</p>
                    <p>Published: {formatDate(product.publishedAt)}</p>
                    {product.rejectionReason ? (
                      <p>Rejection reason: {product.rejectionReason}</p>
                    ) : null}
                  </div>
                  {product.status === "PENDING" ? (
                    <div className="creator-review-actions">
                      <Form method="post" className="creator-decision-form">
                        <input
                          type="hidden"
                          name="creatorProductId"
                          value={product.id}
                        />
                        <label>
                          <span>Rejection reason</span>
                          <input
                            name="rejectionReason"
                            placeholder="Required only when rejecting"
                          />
                        </label>
                        <div>
                          <SubmitButton
                            name="decision"
                            value="PUBLISHED"
                            confirmMessage="Approve this Creator Product? It will appear in the creator's Custom House collection and use the original Shopify base product for checkout."
                          >
                            Approve
                          </SubmitButton>
                          <SubmitButton
                            name="decision"
                            value="REJECTED"
                            confirmMessage="Reject this Creator Product? The reason will be shown to the creator."
                          >
                            Reject
                          </SubmitButton>
                        </div>
                      </Form>
                    </div>
                  ) : null}
                  {["PUBLISHED", "DRAFT", "REJECTED", "ARCHIVED"].includes(product.status) ? (
                    <div className="creator-review-actions">
                      <Form method="post" className="creator-decision-form">
                        <input type="hidden" name="creatorProductId" value={product.id} />
                        <p>Cleanup checks linked orders and financial history before any hard deletion.</p>
                        <div>
                          {product.status !== "ARCHIVED" ? (
                            <SubmitButton name="decision" value="ARCHIVE" confirmMessage="Archive this Creator Product? It will leave normal active views and public purchase flow while history is preserved.">Archive</SubmitButton>
                          ) : null}
                          {["DRAFT", "REJECTED", "ARCHIVED"].includes(product.status) ? (
                            <SubmitButton name="decision" value="DELETE" confirmMessage="Permanently delete this Creator Product only if it has no order or financial dependencies?">Delete if safe</SubmitButton>
                          ) : null}
                        </div>
                      </Form>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No Creator Products found.</strong>
              <span className="dashboard-muted">
                Submitted creator products will appear here for review.
              </span>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Products" />;
}

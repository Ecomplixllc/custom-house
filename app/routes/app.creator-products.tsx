import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  StatusBadge,
  SubmitButton,
} from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import {
  listCreatorProductsForAdmin,
  cleanupCreatorProductAsAdmin,
  moderateCreatorContentAsAdmin,
  moderateCreatorProductAsAdmin,
} from "../services/creator-products.server";
import { publishCreatorProductToShopify } from "../services/creator-product-publishing.server";

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

function creatorPricingPreview(value: string) {
  try {
    const preview = JSON.parse(value) as {
      pricingMode?: string;
      productionMethod?: string;
      embroiderySubtype?: string | null;
      placementCount?: number;
      surchargeMinor?: string;
      productionCostMinor?: string;
      currencyCode?: string;
      variants?: Array<{
        baseVariantId?: string;
        size?: string;
        basePrice?: string;
        finalPrice?: string;
      }>;
    };
    return preview.pricingMode === "BAKED_IN_V1" ? preview : null;
  } catch {
    return null;
  }
}

function minorAmount(value: string | undefined) {
  try {
    const minor = BigInt(value || "0");
    return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
  } catch {
    return "-";
  }
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
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const decision = String(form.get("decision") || "");
  const creatorProductId = String(form.get("creatorProductId") || "");
  if (decision === "UPDATE_CREATOR_CONTENT") {
    const product = await moderateCreatorContentAsAdmin(
      session.shop,
      session.id || null,
      {
        creatorProductId,
        creatorContentTags: String(form.get("creatorContentTags") || "")
          .split(/[,\n]/u)
          .map((tag) => tag.trim())
          .filter(Boolean),
        creatorContentHiddenByAdmin: form
          .getAll("creatorContentHiddenByAdmin")
          .map(String)
          .includes("true"),
      },
    );
    return {
      ok: true,
      message: product.creatorContentHiddenByAdmin
        ? "Product hidden from Creator Content only; publication and buying remain unchanged."
        : "Creator Content tags and visibility restored.",
    };
  }
  if (decision === "ARCHIVE" || decision === "DELETE") {
    const result = await cleanupCreatorProductAsAdmin(
      session.shop,
      session.id || null,
      creatorProductId,
      decision,
      new AdminGraphqlClient(admin),
    );
    return {
      ok: true,
      message: result.hardDeleted
        ? "Creator Product permanently deleted after dependency checks."
        : "Creator Product archived; order and financial history remain preserved.",
    };
  }
  const product = decision === "PUBLISHED"
    ? await publishCreatorProductToShopify(
        session.shop,
        creatorProductId,
        new AdminGraphqlClient(admin),
      )
    : await moderateCreatorProductAsAdmin(
        session.shop,
        session.id || null,
        {
          creatorProductId,
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
          <Link
            to="/app/creator-products/compatibility"
            className="creator-action-link"
          >
            Compatibility / Legacy Repair
          </Link>
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
                Custom House collection. Publishing recalculates every Shopify
                variant from the base price plus its configured production cost.
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
              {products.map((product) => {
                const pricing = creatorPricingPreview(
                  product.creatorPricingPreviewJson || "{}",
                );
                return (
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
                    {product.creatorPricingMode ? (
                      <p>Pricing mode: <strong>{product.creatorPricingMode}</strong></p>
                    ) : null}
                    {pricing ? (
                      <div className="creator-pricing-preview">
                        <p>
                          Expected pricing: <strong>{pricing.productionMethod}</strong>
                          {pricing.embroiderySubtype
                            ? ` / ${pricing.embroiderySubtype}`
                            : ""}
                          {` / ${pricing.placementCount || 0} placement(s)`}
                        </p>
                        <p>
                          Surcharge: {minorAmount(pricing.surchargeMinor)} {pricing.currencyCode || ""}
                          {" per placement; production total: "}
                          {minorAmount(pricing.productionCostMinor)} {pricing.currencyCode || ""}
                        </p>
                        <ul>
                          {(pricing.variants || []).map((variant) => (
                            <li key={variant.baseVariantId || variant.size}>
                              {variant.size || "Variant"}: {variant.basePrice} → {variant.finalPrice} {pricing.currencyCode || ""}
                            </li>
                          ))}
                        </ul>
                        <small>Publishing recalculates these prices from fresh Shopify and Admin data.</small>
                      </div>
                    ) : null}
                    <div className="creator-pricing-preview">
                      <p>
                        Creator Content: <strong>{product.creatorContentOptIn ? "Yes" : "No"}</strong>
                        {product.creatorContentHiddenByAdmin ? " · Hidden by admin" : ""}
                      </p>
                      <p>
                        Tags: {product.creatorContentTags.length
                          ? product.creatorContentTags.join(" · ")
                          : "No tags"}
                      </p>
                      <Form method="post" className="creator-decision-form">
                        <input type="hidden" name="creatorProductId" value={product.id} />
                        <label>
                          <span>Creator Content tags (maximum 5, comma separated)</span>
                          <input
                            name="creatorContentTags"
                            defaultValue={product.creatorContentTags.join(", ")}
                            maxLength={164}
                          />
                        </label>
                        <label>
                          <input type="hidden" name="creatorContentHiddenByAdmin" value="false" />
                          <input
                            type="checkbox"
                            name="creatorContentHiddenByAdmin"
                            value="true"
                            defaultChecked={product.creatorContentHiddenByAdmin}
                          />{" "}
                          Hide from Creator Content only
                        </label>
                        <SubmitButton name="decision" value="UPDATE_CREATOR_CONTENT">
                          Save Creator Content settings
                        </SubmitButton>
                      </Form>
                    </div>
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
                            confirmMessage="Approve and publish this Creator Product with the displayed production cost baked into every Shopify variant price?"
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
                );
              })}
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

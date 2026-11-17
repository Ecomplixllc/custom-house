import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  AdminStyles,
  SafeAdminError,
  SubmitButton,
} from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import { DomainError } from "../services/domain";
import {
  applyLegacyCreatorProductRepair,
  getLegacyRepairDetail,
  listLegacyCompatibilityRecords,
  type LegacyVariantEvidence,
} from "../services/creator-product-legacy-remediation.server";
import { cleanupCreatorProductAsAdmin } from "../services/creator-products.server";

function displayMethod(value: string) {
  return value === "EMBROIDERY" ? "Embroidery" : value;
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function variantColor(variant: LegacyVariantEvidence) {
  return variant.selectedOptions.find((option) =>
    /^(color|colour|farg|färg|farbe|couleur|colore|kleur|kolor|cor)$/i.test(
      option.name,
    ),
  )?.value;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const url = new URL(request.url);
  const overview = await listLegacyCompatibilityRecords(session.shop, client);
  if (url.searchParams.get("export") === "json") {
    return new Response(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          shop: session.shop,
          summary: overview.summary,
          records: overview.records,
        },
        null,
        2,
      ),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="creator-product-compatibility.json"',
        },
      },
    );
  }
  const creatorProductId = url.searchParams.get("productId")?.trim() || null;
  const detail = creatorProductId
    ? await getLegacyRepairDetail(session.shop, creatorProductId, client)
    : null;
  return { overview, detail };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const creatorProductId = String(form.get("creatorProductId") || "");
  try {
    if (intent === "repair") {
      const result = await applyLegacyCreatorProductRepair(
        session.shop,
        session.id || null,
        {
          creatorProductId,
          fixedColor: form.get("fixedColor"),
          productionMethod: form.get("productionMethod"),
          placementCount: form.get("placementCount"),
          mappingProductId: form.get("mappingProductId"),
          confirmMapping: form.get("confirmMapping"),
          confirmApply: form.get("confirmApply"),
          republish: form.get("republish"),
        },
        client,
      );
      return {
        ok: result.compatibility.status === "COMPATIBLE",
        message:
          result.compatibility.status === "COMPATIBLE"
            ? "COMPATIBLE — legacy configuration and Shopify product are synchronized."
            : `STILL NEEDS REPAIR — ${result.compatibility.reason}`,
      };
    }
    if (intent === "archive" || intent === "delete") {
      const result = await cleanupCreatorProductAsAdmin(
        session.shop,
        session.id || null,
        creatorProductId,
        intent === "archive" ? "ARCHIVE" : "DELETE",
        client,
      );
      return {
        ok: true,
        message: result.hardDeleted
          ? "Dependency-free legacy record deleted through the existing cleanup service."
          : "Legacy record archived; historical orders and financial records were preserved.",
      };
    }
    throw new DomainError("INVALID_REMEDIATION_ACTION", "Choose a valid remediation action.", 400);
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, message: error.message, code: error.code };
    }
    return {
      ok: false,
      message: "The repair could not be completed. No historical financial records were changed.",
    };
  }
}

function CompatibilityBadge({ status }: { status: string }) {
  const tone = status === "COMPATIBLE" ? "ok" : status.toLowerCase().replaceAll("_", "-");
  return <span className={`legacy-compatibility-badge legacy-compatibility-badge--${tone}`}>{status.replaceAll("_", " ")}</span>;
}

function RepairPanel({ detail }: { detail: NonNullable<ReturnType<typeof useLoaderData<typeof loader>>["detail"]> }) {
  const [color, setColor] = useState(detail.currentSetup.fixedColor || "");
  const [method, setMethod] = useState(detail.currentSetup.productionMethod || "");
  const [placements, setPlacements] = useState(String(detail.currentSetup.placementCount || ""));
  const [mapping, setMapping] = useState(detail.product.publishedShopifyProductId || "");
  const selectedCandidate = detail.candidates.find((candidate) => candidate.id === mapping);
  const selectedPublishedProduct =
    mapping === detail.product.publishedShopifyProductId
      ? detail.publishedProduct
      : selectedCandidate;
  const variants = selectedPublishedProduct?.variants || detail.baseProduct?.variants || [];
  const remaining = variants.filter(
    (variant) => color && variantColor(variant)?.toLowerCase() === color.toLowerCase(),
  );
  const removed = variants.filter((variant) => !remaining.includes(variant));

  return (
    <section className="creator-admin-panel legacy-review-panel">
      <div className="creator-section-heading">
        <div>
          <span className="creator-admin-eyebrow">Individual review</span>
          <h2>{detail.product.title}</h2>
          <p>{detail.product.id}</p>
        </div>
        <CompatibilityBadge status={detail.compatibility.status} />
      </div>

      <div className="legacy-review-grid">
        <article>
          <h3>Creator product</h3>
          <dl>
            <dt>Creator</dt><dd>{detail.product.creator.displayName} · @{detail.product.creator.handle}</dd>
            <dt>Status</dt><dd>{detail.product.status}</dd>
            <dt>Created</dt><dd>{formatDate(detail.product.createdAt)}</dd>
          </dl>
        </article>
        <article>
          <h3>Base product</h3>
          <dl>
            <dt>Product</dt><dd>{detail.product.shopifyProductId}</dd>
            <dt>Colors</dt><dd>{detail.availableColors.join(", ") || "No color options found"}</dd>
            <dt>Available variants</dt><dd>{detail.baseProduct?.variants.map((variant) => variant.title).join(", ") || "None found"}</dd>
          </dl>
        </article>
        <article>
          <h3>Published Shopify product</h3>
          <dl>
            <dt>Mapping</dt><dd>{detail.product.publishedShopifyProductId || "Missing"}</dd>
            <dt>Shopify status</dt><dd>{detail.publishedProduct?.status || "Not found"}</dd>
            <dt>Variants</dt><dd>{detail.publishedProduct?.variants.length || 0}</dd>
            <dt>Origin / mode / type</dt><dd>{detail.publishedProduct ? `${detail.publishedProduct.productOrigin || "missing"} / ${detail.publishedProduct.designMode || "missing"} / ${detail.publishedProduct.productType || "missing"}` : "Not found"}</dd>
            <dt>CreatorProduct marker</dt><dd>{detail.publishedProduct?.creatorProductId || "Missing"}</dd>
            <dt>Fixed configuration</dt><dd>{detail.publishedProduct ? `${detail.publishedProduct.fixedColor || "missing"} / ${detail.publishedProduct.productionMethod || "missing"} / ${detail.publishedProduct.designedPlacementCount || "missing"} placement(s)` : "Not found"}</dd>
          </dl>
        </article>
        <article>
          <h3>Current saved configuration</h3>
          <dl>
            <dt>Fixed color</dt><dd>{detail.currentSetup.fixedColor || "Missing"}</dd>
            <dt>Production method</dt><dd>{detail.currentSetup.productionMethod || "Missing"}</dd>
            <dt>Placement count</dt><dd>{detail.currentSetup.placementCount || "Missing"}</dd>
            <dt>PitchPrint project</dt><dd>{detail.product.pitchprintProjectId || "Missing"}</dd>
            <dt>PitchPrint design</dt><dd>{detail.product.pitchprintDesignId || "Missing"}</dd>
            <dt>Canonical contract</dt><dd>{detail.publishedProduct?.creatorCartValidation ? JSON.stringify(detail.publishedProduct.creatorCartValidation) : "Missing"}</dd>
          </dl>
        </article>
        <article>
          <h3>Dependencies</h3>
          <dl>
            <dt>Orders / items</dt><dd>{detail.dependencies.orders} / {detail.dependencies.creatorOrderItems}</dd>
            <dt>Sales / earnings</dt><dd>{detail.dependencies.sales} / {detail.dependencies.earnings}</dd>
            <dt>Payouts / allocations</dt><dd>{detail.dependencies.payouts} / {detail.dependencies.payoutAllocations}</dd>
          </dl>
        </article>
      </div>

      <div className="creator-admin-warning">
        Legacy product configuration was not stored when this product was originally created. Confirm these values from the original design/order records before saving.
      </div>
      <div className="legacy-history-note">Historical orders and financial records will not be changed.</div>

      <Form method="post" className="legacy-repair-form">
        <input type="hidden" name="intent" value="repair" />
        <input type="hidden" name="creatorProductId" value={detail.product.id} />
        <div className="legacy-form-grid">
          <label>
            <span>Fixed color</span>
            <select name="fixedColor" value={color} onChange={(event) => setColor(event.currentTarget.value)} required>
              <option value="">Choose a base-product color</option>
              {detail.availableColors.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>Printing method</span>
            <select name="productionMethod" value={method} onChange={(event) => setMethod(event.currentTarget.value)} required>
              <option value="">Choose a method</option>
              {detail.enabledMethods.map((value) => <option key={value} value={value}>{displayMethod(value)}</option>)}
            </select>
          </label>
          <label>
            <span>Placement count</span>
            <input name="placementCount" type="number" min="1" max="20" step="1" value={placements} onChange={(event) => setPlacements(event.currentTarget.value)} required />
          </label>
          <label>
            <span>Existing Creator Shopify product GID</span>
            <input name="mappingProductId" list="legacy-product-candidates" value={mapping} onChange={(event) => setMapping(event.currentTarget.value)} placeholder="gid://shopify/Product/..." />
            <datalist id="legacy-product-candidates">
              {detail.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </datalist>
          </label>
        </div>

        <div className="legacy-preview-grid">
          <article>
            <h3>Current</h3>
            <p>Color: {detail.currentSetup.fixedColor || "Missing"}</p>
            <p>Method: {detail.currentSetup.productionMethod || "Missing"}</p>
            <p>Placement count: {detail.currentSetup.placementCount || "Missing"}</p>
          </article>
          <article>
            <h3>After repair</h3>
            <p>Color: {color || "Choose a color"}</p>
            <p>Method: {method ? displayMethod(method) : "Choose a method"}</p>
            <p>Placement count: {placements || "Enter a count"}</p>
            <p>Shopify product: {mapping || "No mapping selected"}</p>
          </article>
          <article>
            <h3>Variants to remain</h3>
            <p>{remaining.map((variant) => variant.title).join(", ") || "Choose a color to preview"}</p>
          </article>
          <article>
            <h3>Variants to remove</h3>
            <p>{removed.map((variant) => variant.title).join(", ") || "None"}</p>
          </article>
        </div>

        {mapping && mapping !== detail.product.publishedShopifyProductId ? (
          <label className="legacy-confirm-row">
            <input type="checkbox" name="confirmMapping" required />
            <span>Confirm Shopify product mapping</span>
          </label>
        ) : null}
        {!mapping ? (
          <label className="legacy-confirm-row">
            <input type="checkbox" name="republish" />
            <span>No published Shopify product found — republish through the canonical publishing service</span>
          </label>
        ) : null}
        <label className="legacy-confirm-row">
          <input type="checkbox" name="confirmApply" required />
          <span>Apply repair using the reviewed values above</span>
        </label>
        <SubmitButton confirmMessage="Apply this legacy repair? Historical orders and financial records will not be changed.">Apply repair</SubmitButton>
      </Form>

      <div className="legacy-candidate-list">
        <h3>Matching Shopify candidates</h3>
        {detail.candidates.length ? detail.candidates.map((candidate) => (
          <p key={candidate.id}><strong>{candidate.title}</strong> · {candidate.id} · creator_product_id: {candidate.creatorProductId || "missing"} · creator_id: {candidate.creatorId || "missing"} · {candidate.productOrigin || "missing origin"} / {candidate.designMode || "missing mode"} / {candidate.productType || "missing type"}</p>
        )) : <p>No deterministic canonical candidate was found.</p>}
      </div>

      <Form method="post" className="legacy-cleanup-actions">
        <input type="hidden" name="creatorProductId" value={detail.product.id} />
        <p>If the merchant confirms this is stale/test data, use the existing cleanup rules.</p>
        <SubmitButton name="intent" value="archive" confirmMessage="Archive this legacy record? Historical records will be preserved.">Archive stale/test record</SubmitButton>
        <SubmitButton name="intent" value="delete" confirmMessage="Delete only if the existing dependency checks confirm this record is dependency-free?">Delete if safe</SubmitButton>
      </Form>
    </section>
  );
}

export default function CreatorProductCompatibilityAdmin() {
  const { overview, detail } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <s-page heading="Creator Product Compatibility">
      <AdminStyles />
      <div className="creator-admin-page legacy-remediation-page">
        <header className="creator-admin-header">
          <div>
            <span className="creator-admin-eyebrow">
              Creator Products → Compatibility / Legacy Repair
            </span>
            <h1>Creator Product Compatibility</h1>
            <p>Review and repair legacy CreatorProducts individually before checkout validation is enabled.</p>
          </div>
          <div className="creator-admin-sync-actions">
            <Link className="creator-action-link" to="/app/creator-products/compatibility">Run compatibility audit</Link>
            <a className="creator-action-link" href="/app/creator-products/compatibility?export=json">Export compatibility report</a>
            <Link className="creator-action-link" to="/app/creator-products">Back to Creator Products</Link>
          </div>
        </header>

        {actionData?.message ? <div className={actionData.ok ? "creator-admin-message" : "creator-admin-warning"}>{actionData.message}</div> : null}

        <section className="creator-admin-stats">
          <article><span className="creator-icon creator-icon--approved" /><p>Compatible</p><strong>{overview.summary.compatible}</strong><small>Ready products</small></article>
          <article><span className="creator-icon creator-icon--pending" /><p>Needs Repair</p><strong>{overview.summary.needsRepair}</strong><small>Mapped but incompatible</small></article>
          <article><span className="creator-icon creator-icon--applications" /><p>Missing Mapping</p><strong>{overview.summary.missingMapping}</strong><small>No published product mapping</small></article>
          <article><span className="creator-icon creator-icon--review" /><p>Manual Review</p><strong>{overview.summary.manualReview}</strong><small>Never repaired blindly</small></article>
        </section>

        <div className={overview.summary.ready ? "creator-admin-message" : "creator-admin-warning"}>
          {overview.summary.ready ? (
            <>CHECKOUT VALIDATION READY — Shopify Admin → Settings → Checkout → Checkout rules → Add rule → customhouse-creator-cart-validation → Enable → Save</>
          ) : (
            <>Checkout validation remains blocked until Needs Repair and Missing Mapping are both zero.</>
          )}
        </div>

        <section className="creator-admin-panel">
          <div className="creator-section-heading"><div><h2>Published legacy records</h2><p>Repairs are available only through individual Review actions.</p></div></div>
          <div className="creator-table-wrap">
            <table className="creator-table legacy-compatibility-table">
              <thead><tr><th>CreatorProduct</th><th>Creator</th><th>Base product</th><th>Published product</th><th>Saved setup</th><th>History</th><th>Compatibility</th><th>Action</th></tr></thead>
              <tbody>
                {overview.records.map((record) => (
                  <tr key={record.id}>
                    <td data-label="CreatorProduct"><strong>{record.title}</strong><small>{record.id}</small><small>{record.status}</small></td>
                    <td data-label="Creator">{record.creator.displayName}<small>@{record.creator.handle}</small></td>
                    <td data-label="Base product">{record.baseProductTitle}<small>{record.baseProductId}</small></td>
                    <td data-label="Published product">{record.publishedShopifyProductId || "Missing"}</td>
                    <td data-label="Saved setup">Color: {record.setup.fixedColor || "Missing"}<br />Method: {record.setup.productionMethod || "Missing"}<br />Placements: {record.setup.placementCount || "Missing"}</td>
                    <td data-label="History">{record.hasFinancialHistory ? `Protected · ${record.orderCount} orders · ${record.saleCount} sales` : "No order/sale history"}</td>
                    <td data-label="Compatibility"><CompatibilityBadge status={record.compatibility.status} /><small>{record.compatibility.missingFields.join(", ") || "No missing fields"}</small></td>
                    <td data-label="Action"><Link className="creator-action-link" to={`/app/creator-products/compatibility?productId=${encodeURIComponent(record.id)}`}>Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {detail ? <RepairPanel key={detail.product.id} detail={detail} /> : null}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Product Compatibility" />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

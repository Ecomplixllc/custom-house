import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { ProductionPricingMatrix } from "../components/production-pricing-matrix";
import { authenticate } from "../shopify.server";
import { DomainError } from "../services/domain";
import { parseProductionPricingBatchForm } from "../services/production-pricing-admin";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import {
  createProductionMethodDefinition,
  listProductionPricingRows,
  listProductionMethodDefinitions,
  productProductionConfiguration,
  saveProductProductionConfiguration,
} from "../services/production-method-pricing.server";

type ProductRow = {
  id: string;
  title: string;
  handle: string;
  status: string;
  tags: string[];
  productType: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  origin: { value: string } | null;
  mode: { value: string } | null;
  designStatus: { value: string } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
};

function isPublicCustomizableProduct(product: {
  tags?: string[];
  productType: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  origin?: { value: string } | null;
  mode?: { value: string } | null;
}) {
  const tags = new Set((product.tags || []).map((tag) => tag.trim().toLowerCase()));
  const isCreatorFixed =
    product.productType?.value === "creator_fixed" ||
    tags.has("creator-fixed") ||
    product.origin?.value === "creator" ||
    product.mode?.value === "buy_only";
  const isLegacyGlobalCustomizable =
    product.origin?.value === "global" && product.mode?.value === "customizable";
  const hasPitchPrintSignal =
    product.pitchprintEnabled?.value === "true" ||
    tags.has("pitchprint") ||
    tags.has("pitchprint-enabled") ||
    tags.has("pitchprint-designlab") ||
    tags.has("pitchprint-options");
  return (
    !isCreatorFixed &&
    (isLegacyGlobalCustomizable ||
      (product.productType?.value === "global_customizable" && hasPitchPrintSignal) ||
      hasPitchPrintSignal)
  );
}

async function verifyPublicCustomizableProduct(
  client: AdminGraphqlClient,
  productId: string,
) {
  const data = await client.request<{
    product: {
      id: string;
      tags: string[];
      productType: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      origin: { value: string } | null;
      mode: { value: string } | null;
    } | null;
  }>(
    `#graphql query ProductionPricingProductEligibility($id: ID!) {
      product(id: $id) {
        id tags
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
      }
    }`,
    { id: productId },
  );
  if (!data.product || !isPublicCustomizableProduct(data.product)) {
    throw new DomainError(
      "PRODUCTION_PRICING_PRODUCT_INELIGIBLE",
      "Production pricing is only available for public customizable PitchPrint products.",
      422,
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const data = await client.request<{
    products: { nodes: ProductRow[] };
  }>(`#graphql
    query MarketplaceProducts {
      products(first: 100, query: "status:active") {
        nodes {
          id title handle status tags
          productType: metafield(namespace: "customhouse", key: "product_type") { value }
          pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
          origin: metafield(namespace: "customhouse", key: "product_origin") { value }
          mode: metafield(namespace: "customhouse", key: "design_mode") { value }
          designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  `);
  const [pricingRows, methodDefinitions] = await Promise.all([
    listProductionPricingRows(session.shop),
    listProductionMethodDefinitions(session.shop),
  ]);
  const configurationByProduct = Object.fromEntries(
    pricingRows
      .filter((row) => row.shopifyProductId.startsWith("gid://shopify/Product/"))
      .map((row) => [row.shopifyProductId, productProductionConfiguration(row)]),
  );
  return {
    products: data.products.nodes,
    configurationByProduct,
    methodDefinitions,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "add-production-method") {
      const definition = await createProductionMethodDefinition(session.shop, {
        label: form.get("methodName"),
        code: form.get("methodCode"),
        pricingBehavior: form.get("pricingBehavior"),
        maxWidthCm: form.get("maxWidthCm"),
        maxHeightCm: form.get("maxHeightCm"),
      });
      return {
        ok: true,
        intent,
        message: `${definition.label} was added and starts disabled for every product.`,
        details: [] as string[],
      };
    }

    if (intent === "save-production-pricing-batch") {
      const definitions = await listProductionMethodDefinitions(session.shop);
      const inputs = parseProductionPricingBatchForm(form, definitions);

      // Validate the entire batch before any database or Shopify writes occur.
      for (const input of inputs) {
        await verifyPublicCustomizableProduct(client, input.shopifyProductId);
      }

      const results = [];
      for (const input of inputs) {
        results.push(await saveProductProductionConfiguration(session.shop, input, client));
      }
      const errors = results.flatMap((result) => result.errors);
      const fullySaved = results.every((result) => result.status === "saved");
      return {
        ok: fullySaved,
        intent,
        message: fullySaved
          ? `Production pricing saved for ${results.length} product${results.length === 1 ? "" : "s"}.`
          : "Production pricing was saved with sync warnings.",
        details: errors,
      };
    }

    throw new DomainError("UNSUPPORTED_PRODUCT_ACTION", "Unsupported product action.", 400);
  } catch (error) {
    return {
      ok: false,
      intent,
      message:
        error instanceof DomainError
          ? error.message
          : "Production pricing could not be saved.",
      details: [] as string[],
    };
  }
}

export default function Products() {
  const { products, configurationByProduct, methodDefinitions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const eligibleProducts = products.filter(isPublicCustomizableProduct);
  const excludedProducts = products.filter(
    (product) => !isPublicCustomizableProduct(product),
  );

  return (
    <s-page heading="Marketplace products"><AdminStyles /><s-section>
        <div className="settings-admin-page">
          <header className="settings-admin-header">
            <div>
              <h1>Production Pricing</h1>
              <p>
                Configure per-product Printing Method surcharges for public
                customizable PitchPrint products.
              </p>
            </div>
          </header>

          {eligibleProducts.length ? (
            <ProductionPricingMatrix
              products={eligibleProducts.map((product) => ({
                id: product.id,
                title: product.title,
                handle: product.handle,
                currency: product.priceRangeV2.minVariantPrice.currencyCode,
                basePrice: product.priceRangeV2.minVariantPrice.amount,
              }))}
              configurationByProduct={configurationByProduct}
              methodDefinitions={methodDefinitions}
              actionData={actionData}
            />
          ) : (
            <div className="dashboard-empty">
              <strong>No public customizable products were found.</strong>
              <span className="dashboard-muted">
                Products with Custom House product_type global_customizable and
                PitchPrint enabled will appear here.
              </span>
            </div>
          )}

          {excludedProducts.length ? (
            <details className="settings-card production-pricing-diagnostics">
              <summary className="production-pricing-diagnostics-summary">
                <span className="settings-icon settings-icon--general" />
                <div>
                  <h2>Excluded products ({excludedProducts.length})</h2>
                  <p>
                    Internal, Creator, and non-customizable products are hidden
                    from normal pricing controls.
                  </p>
                </div>
              </summary>
              <div className="settings-toggle-list production-pricing-diagnostics-list">
                {excludedProducts.map((product) => (
                  <div className="settings-toggle-row" key={product.id}>
                    <span>{product.title}</span>
                    <small>
                      {product.productType?.value ||
                        product.origin?.value ||
                        "Not public customizable"}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Marketplace products" />;
}

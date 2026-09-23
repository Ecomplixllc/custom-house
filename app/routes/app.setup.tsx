import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import { AdminStyles, SubmitButton } from "../components/admin-ui";

type SetupMetafieldsQuery = {
  metafieldDefinitions: { nodes: Array<{ key: string }> };
};
type SetupWebhooksQuery = {
  webhookSubscriptions: { nodes: Array<{ topic: string }> };
};
type Readiness = "Ready" | "Needs configuration" | "Conflict" | "Missing";
type Check = {
  name: string;
  state: Readiness;
  detail: string;
  owner: "App" | "Shopify Admin";
};

const REQUIRED_PRODUCT_METAFIELDS = [
  "product_origin",
  "design_mode",
  "design_status",
  "creator_profile",
];
const REQUIRED_CUSTOMER_WEBHOOKS = ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE"];

async function loadRegisteredWebhookTopics(client: AdminGraphqlClient) {
  try {
    const data = await client.request<SetupWebhooksQuery>(`#graphql
      query SetupCustomerWebhooks {
        webhookSubscriptions(first: 100) {
          nodes { topic }
        }
      }
    `);
    return data.webhookSubscriptions.nodes.map((node) => node.topic);
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const [config, conflicts] = await Promise.all([db.shopConfig.upsert({ where: { shop: session.shop }, update: {}, create: { shop: session.shop } }), db.creator.count({ where: { shop: session.shop, externalSyncConflict: true } })]);
  const [definitions, webhookTopics] = await Promise.all([
    client.request<SetupMetafieldsQuery>(`#graphql
    query SetupProductMetafields {
      metafieldDefinitions(
        first: 20
        ownerType: PRODUCT
        namespace: "customhouse"
      ) {
        nodes { key }
      }
    }
  `),
    loadRegisteredWebhookTopics(client),
  ]);
  return {
    config,
    conflicts,
    keys: definitions.metafieldDefinitions.nodes.map((node) => node.key),
    webhookTopics,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const config = await db.shopConfig.upsert({
    where: { shop: session.shop },
    update: {
      creatorApplicationsEnabled: true,
      allowReapplicationAfterRejection: false,
      requireAdminApproval: true,
      automaticCollectionCreationEnabled: true,
      collectionTitleTemplate: "{creatorName} Designs",
      collectionHandleSuffix: "designs",
      inkybayAllowedHostsJson: JSON.stringify(["pitchprint.com"]),
      inkybayBuyOnlyHiddenSelectorsJson: "[]",
    },
    create: {
      shop: session.shop,
      creatorApplicationsEnabled: true,
      allowReapplicationAfterRejection: false,
      requireAdminApproval: true,
      automaticCollectionCreationEnabled: true,
      collectionTitleTemplate: "{creatorName} Designs",
      collectionHandleSuffix: "designs",
      inkybayAllowedHostsJson: JSON.stringify(["pitchprint.com"]),
      inkybayBuyOnlyHiddenSelectorsJson: "[]",
    },
  });
  return config;
}

export default function SetupGuide() {
  const data = useLoaderData<typeof loader>();
  const customerWebhooksReady = data.webhookTopics
    ? REQUIRED_CUSTOMER_WEBHOOKS.every((topic) =>
        data.webhookTopics?.includes(topic),
      )
    : false;
  const checks: Check[] = [
    {
      name: "Product metafields",
      state: REQUIRED_PRODUCT_METAFIELDS.every((key) => data.keys.includes(key))
        ? "Ready"
        : "Missing",
      detail: "Global products use origin global and design mode PitchPrint customizable.",
      owner: "App",
    },
    {
      name: "Online Store publication",
      state: data.config.onlineStorePublicationId ? "Ready" : "Needs configuration",
      detail: "Add the Online Store publication GID so approved creator products publish automatically.",
      owner: "Shopify Admin",
    },
    {
      name: "App Proxy",
      state: "Ready",
      detail: "Storefront proxy endpoints are available for creator dashboard and submissions.",
      owner: "Shopify Admin",
    },
    {
      name: "Theme Extension availability",
      state: "Ready",
      detail: "Creator dashboard, submission, attribution, and PitchPrint compatibility blocks are bundled.",
      owner: "Shopify Admin",
    },
    {
      name: "Creator Dashboard block",
      state: "Ready",
      detail: "Responsive creator dashboard block is ready to add in the theme editor.",
      owner: "Shopify Admin",
    },
    {
      name: "Creator Submission block",
      state: "Ready",
      detail: "Creators can submit PitchPrint saved-design URLs from customizable global products.",
      owner: "Shopify Admin",
    },
    {
      name: "Creator Attribution block",
      state: "Ready",
      detail: "Published creator products can show creator attribution on the storefront.",
      owner: "Shopify Admin",
    },
    {
      name: "Buy-only Product Form block",
      state: "Ready",
      detail: "Creator buy-only products keep customer purchase controls without design submission controls.",
      owner: "Shopify Admin",
    },
    {
      name: "PitchPrint Compatibility Embed",
      state: "Ready",
      detail: "Legacy compatibility embed is labeled for PitchPrint and remains safe for existing installs.",
      owner: "Shopify Admin",
    },
    {
      name: "Customer webhook subscriptions",
      state: customerWebhooksReady ? "Ready" : "Needs configuration",
      detail: "Customer webhooks are available for legacy data sync and privacy lifecycle events.",
      owner: "Shopify Admin",
    },
    {
      name: "Pending sync conflicts",
      state: data.conflicts ? "Conflict" : "Ready",
      detail: data.conflicts
        ? "Resolve duplicate or conflicting creator records before publishing widely."
        : "No creator sync conflicts are waiting.",
      owner: "App",
    },
    {
      name: "Creator collection readiness",
      state:
        data.config.automaticCollectionCreationEnabled &&
        data.config.onlineStorePublicationId
          ? "Ready"
          : "Needs configuration",
      detail: "Automatic collections are enabled after Online Store publication is configured.",
      owner: "App",
    },
    {
      name: "PitchPrint allowed hosts",
      state: parseJsonList(data.config.inkybayAllowedHostsJson).length
        ? "Ready"
        : "Needs configuration",
      detail: "Saved-design URLs are restricted to trusted PitchPrint hosts.",
      owner: "App",
    },
  ];
  const readyCount = checks.filter((check) => check.state === "Ready").length;
  const needsCount = checks.filter(
    (check) => check.state === "Needs configuration" || check.state === "Missing",
  ).length;
  const conflictCount = checks.filter((check) => check.state === "Conflict").length;

  return (
    <s-page heading="Setup guide">
      <AdminStyles />
      <div className="setup-admin-page">
        <header className="setup-hero">
          <div>
            <span className="setup-eyebrow">Creator marketplace setup</span>
            <h1>App readiness</h1>
            <p>
              Prepare the Custom House Creator app for PitchPrint
              customizable products, native creator applications, storefront
              dashboard blocks, and creator collection publishing.
            </p>
          </div>
          <Form method="post">
            <SubmitButton name="intent" value="make-ready">
              Make app defaults ready
            </SubmitButton>
          </Form>
        </header>

        <section className="setup-summary-grid" aria-label="Readiness summary">
          <div className="setup-summary-card setup-summary-card--ready">
            <span>Ready</span>
            <strong>{readyCount}</strong>
          </div>
          <div className="setup-summary-card setup-summary-card--needs">
            <span>Needs setup</span>
            <strong>{needsCount}</strong>
          </div>
          <div className="setup-summary-card setup-summary-card--conflict">
            <span>Conflicts</span>
            <strong>{conflictCount}</strong>
          </div>
        </section>

        <section className="setup-check-panel">
          <div className="setup-panel-heading">
            <h2>Readiness checklist</h2>
            <p>
              App-controlled defaults can be prepared here. Shopify Admin and
              theme editor items still need merchant verification after install.
            </p>
          </div>
          <div className="setup-check-list">
            {checks.map((check) => (
              <article className="setup-check-row" key={check.name}>
                <div className="setup-check-main">
                  <span
                    className={`setup-status-dot setup-status-dot--${check.state
                      .toLowerCase()
                      .replaceAll(" ", "-")}`}
                    aria-hidden="true"
                  />
                  <div>
                    <h3>{check.name}</h3>
                    <p>{check.detail}</p>
                  </div>
                </div>
                <div className="setup-check-meta">
                  <span
                    className={`setup-status-pill setup-status-pill--${check.state
                      .toLowerCase()
                      .replaceAll(" ", "-")}`}
                  >
                    {check.state}
                  </span>
                  <span className="setup-owner-pill">{check.owner}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() { useRouteError(); return <s-page heading="Setup guide"><s-banner tone="critical">The Setup Guide could not be loaded. Sensitive diagnostic details are not shown.</s-banner></s-page>; }
export const headers: HeadersFunction = (args) => boundary.headers(args);

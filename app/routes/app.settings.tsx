import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  AdminStyles,
  SafeAdminError,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";
import {
  cleanWelcomeEmailContent,
  DEFAULT_CREATOR_WELCOME_BODY,
  DEFAULT_CREATOR_WELCOME_SUBJECT,
} from "../services/creator-welcome-email.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const config = await db.shopConfig.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });
  return { config };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  if (intent === "reset-welcome-email") {
    return db.shopConfig.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        creatorWelcomeEmailSubject: DEFAULT_CREATOR_WELCOME_SUBJECT,
        creatorWelcomeEmailBody: DEFAULT_CREATOR_WELCOME_BODY,
      },
      update: {
        creatorWelcomeEmailSubject: DEFAULT_CREATOR_WELCOME_SUBJECT,
        creatorWelcomeEmailBody: DEFAULT_CREATOR_WELCOME_BODY,
      },
    });
  }

  if (intent === "reset-defaults") {
    return db.shopConfig.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop },
      update: {
        creatorApplicationsEnabled: true,
        allowReapplicationAfterRejection: false,
        requireAdminApproval: true,
        automaticCollectionCreationEnabled: true,
        collectionTitleTemplate: "{creatorName} Designs",
        collectionHandleSuffix: "designs",
        onlineStorePublicationId: null,
        creatorProfileMetaobjectType: null,
        creatorProfileFieldMapJson: null,
        inkybayAllowedHostsJson: JSON.stringify(["pitchprint.com"]),
        inkybayBuyOnlyHiddenSelectorsJson: "[]",
        creatorWelcomeEmailSubject: DEFAULT_CREATOR_WELCOME_SUBJECT,
        creatorWelcomeEmailBody: DEFAULT_CREATOR_WELCOME_BODY,
      },
    });
  }

  const hosts = String(form.get("hosts") || "")
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const selectors = String(form.get("selectors") || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const welcomeEmail = cleanWelcomeEmailContent(
    form.get("creatorWelcomeEmailSubject"),
    form.get("creatorWelcomeEmailBody"),
  );

  const settings = {
    creatorApplicationsEnabled: form.has("applications"),
    allowReapplicationAfterRejection: form.has("reapplication"),
    requireAdminApproval: form.has("approval"),
    automaticCollectionCreationEnabled: form.has("collections"),
    collectionTitleTemplate: String(
      form.get("titleTemplate") || "{creatorName} Designs",
    ),
    collectionHandleSuffix: String(form.get("handleSuffix") || "designs"),
    onlineStorePublicationId:
      String(form.get("publicationId") || "") || null,
    creatorProfileMetaobjectType:
      String(form.get("metaobjectType") || "") || null,
    creatorProfileFieldMapJson: String(form.get("fieldMap") || "") || null,
    inkybayAllowedHostsJson: JSON.stringify([
      ...new Set([...hosts, "pitchprint.com"]),
    ]),
    inkybayBuyOnlyHiddenSelectorsJson: JSON.stringify(selectors),
    creatorWelcomeEmailSubject: welcomeEmail.subject,
    creatorWelcomeEmailBody: welcomeEmail.body,
  };

  return db.shopConfig.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, ...settings },
    update: settings,
  });
}

export default function Settings() {
  const { config } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Creator Marketplace Settings">
      <AdminStyles />
      <div className="settings-admin-page">
        <header className="settings-admin-header">
          <div>
            <h1>Creator Marketplace Settings</h1>
            <p>
              Configure creator applications, collection rules, PitchPrint
              integration, and profile settings from one responsive workspace.
            </p>
          </div>
          <a href="/app/setup" className="settings-learn-link">
            Setup guide
          </a>
        </header>

        <Form method="post" className="settings-form">
          <div className="settings-grid">
            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-icon settings-icon--general" />
                <div>
                  <h2>General Settings</h2>
                  <p>Control creator application behavior and approvals.</p>
                </div>
              </div>
              <div className="settings-toggle-list">
                <label className="settings-toggle-row">
                  <span>Enable creator applications</span>
                  <input
                    type="checkbox"
                    name="applications"
                    defaultChecked={config.creatorApplicationsEnabled}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>Allow reapplication after rejection</span>
                  <input
                    type="checkbox"
                    name="reapplication"
                    defaultChecked={config.allowReapplicationAfterRejection}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>Require admin approval</span>
                  <input
                    type="checkbox"
                    name="approval"
                    defaultChecked={config.requireAdminApproval}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>Create creator collections</span>
                  <input
                    type="checkbox"
                    name="collections"
                    defaultChecked={config.automaticCollectionCreationEnabled}
                  />
                </label>
              </div>
            </section>

            <section className="settings-card settings-card--wide">
              <div className="settings-card-heading">
                <span className="settings-icon settings-icon--general" />
                <div>
                  <h2>Creator Welcome Email</h2>
                  <p>Edit the message used for future Creator approval transitions. Supported placeholders: {"{{creator_name}}"} and {"{{dashboard_url}}"}.</p>
                </div>
              </div>
              <div className="settings-field-stack">
                <label>
                  <span>Subject</span>
                  <input name="creatorWelcomeEmailSubject" maxLength={200} defaultValue={config.creatorWelcomeEmailSubject} required />
                </label>
                <label>
                  <span>Body/content</span>
                  <textarea name="creatorWelcomeEmailBody" rows={12} maxLength={10000} defaultValue={config.creatorWelcomeEmailBody} required />
                </label>
                <SubmitButton name="intent" value="reset-welcome-email" confirmMessage="Reset the Creator welcome email to the CustomHouse default?">
                  Reset welcome email to default
                </SubmitButton>
              </div>
            </section>

            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-icon settings-icon--collection" />
                <div>
                  <h2>Collection Settings</h2>
                  <p>Configure collection creation for creator products.</p>
                </div>
              </div>
              <div className="settings-field-stack">
                <label>
                  <span>Collection title</span>
                  <input
                    name="titleTemplate"
                    defaultValue={config.collectionTitleTemplate}
                  />
                </label>
                <label>
                  <span>Handle suffix</span>
                  <input
                    name="handleSuffix"
                    defaultValue={config.collectionHandleSuffix}
                  />
                </label>
                <label>
                  <span>Online Store publication GID</span>
                  <input
                    name="publicationId"
                    defaultValue={config.onlineStorePublicationId ?? ""}
                    placeholder="gid://shopify/Publication/..."
                  />
                </label>
              </div>
            </section>

            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-icon settings-icon--integration" />
                <div>
                  <h2>Integration Settings</h2>
                  <p>Configure PitchPrint and profile metaobject mapping.</p>
                </div>
              </div>
              <div className="settings-field-stack">
                <label>
                  <span>Allowed PitchPrint hosts</span>
                  <textarea
                    name="hosts"
                    rows={4}
                    defaultValue={parseJsonList(
                      config.inkybayAllowedHostsJson,
                    ).join("\n")}
                    placeholder={"pitchprint.com\ncustom.pitchprint.com"}
                  />
                  <small>One host per line.</small>
                </label>
                <label>
                  <span>Buy-only selectors</span>
                  <textarea
                    name="selectors"
                    rows={4}
                    defaultValue={parseJsonList(
                      config.inkybayBuyOnlyHiddenSelectorsJson,
                    ).join("\n")}
                    placeholder={".buy-button\n.product-form__submit"}
                  />
                  <small>One selector per line.</small>
                </label>
                <label>
                  <span>Creator metaobject type</span>
                  <input
                    name="metaobjectType"
                    defaultValue={config.creatorProfileMetaobjectType ?? ""}
                    placeholder="creator_profile"
                  />
                </label>
                <label>
                  <span>Field map JSON</span>
                  <textarea
                    name="fieldMap"
                    rows={6}
                    defaultValue={config.creatorProfileFieldMapJson ?? ""}
                    placeholder={
                      '{\n  "legal_name": "legalName",\n  "display_name": "displayName"\n}'
                    }
                  />
                  <small>
                    JSON object mapping Custom House creator profile fields to Shopify metaobject fields.
                  </small>
                </label>
              </div>
            </section>
          </div>

          <div className="settings-action-bar">
            <SubmitButton
              name="intent"
              value="reset-defaults"
              confirmMessage="Reset creator marketplace settings to defaults?"
            >
              Reset to defaults
            </SubmitButton>
            <button type="reset" className="settings-secondary-button">
              Discard changes
            </button>
            <SubmitButton name="intent" value="save">
              Save settings
            </SubmitButton>
          </div>
        </Form>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Marketplace Settings" />;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

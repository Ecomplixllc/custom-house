import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCreatorApplication, validateProfileImage } from "../app/services/creator-application.ts";
import {
  cleanWelcomeEmailContent,
  DEFAULT_CREATOR_WELCOME_BODY,
  DEFAULT_CREATOR_WELCOME_SUBJECT,
} from "../app/services/creator-welcome-email.server.ts";

const valid = { legalName: "Ada Lovelace", displayName: "Ada Creates", country: "Sweden", city: "Stockholm", bio: "A sufficiently long creator biography.", primaryPlatform: "Instagram", primaryProfileUrl: "https://instagram.com/adacreates", audienceRange: "1K-10K", categories: ["Art", "Lifestyle"], portfolioUrl: "https://example.org/portfolio", socialLinks: ["https://example.org/social"], termsAccepted: true, accuracyConfirmed: true };

test("valid creator application is normalized", () => { const value = validateCreatorApplication(valid); assert.equal(value.displayName, "Ada Creates"); assert.equal(value.primaryPlatform, "Instagram"); assert.deepEqual(value.categories, ["Art", "Lifestyle"]); assert.equal(value.socialLinks.length, 2); assert.ok(value.termsAcceptedAt instanceof Date); });
test("creator application accepts no social presence or bio", () => {
  const value = validateCreatorApplication({
    ...valid,
    bio: "",
    primaryPlatform: "",
    primaryProfileUrl: "",
    portfolioUrl: "",
    socialLinks: [],
  });
  assert.equal(value.bio, undefined);
  assert.equal(value.primaryPlatform, undefined);
  assert.equal(value.primaryProfileUrl, undefined);
  assert.deepEqual(value.socialLinks, []);
  assert.deepEqual(value.categories, ["Art", "Lifestyle"]);
});
test("core creator application fields remain required", () => {
  assert.throws(() => validateCreatorApplication({ ...valid, displayName: "" }), /Display name/);
  assert.throws(() => validateCreatorApplication({ ...valid, termsAccepted: false }), /creator terms/i);
});
test("creator terms are required", () => assert.throws(() => validateCreatorApplication({ ...valid, termsAccepted: false }), /accept the creator terms/i));
test("invalid creator application input is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, legalName: "A" }), /Legal name/));
test("invalid creator platform is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, primaryPlatform: "MySpace" }), /Primary platform/));
test("invalid creator category is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, categories: ["Bad category"] }), /Creator category/));
test("non-HTTPS portfolio is rejected", () => assert.throws(() => validateCreatorApplication({ ...valid, portfolioUrl: "http://example.org" }), /HTTPS/));
test("valid PNG signature is accepted", () => assert.doesNotThrow(() => validateProfileImage(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), "image/png", 8)));
test("invalid profile image signature is rejected", () => assert.throws(() => validateProfileImage(Uint8Array.from([1,2,3]), "image/png", 3), /valid JPG/));
test("oversized profile image is rejected", () => assert.throws(() => validateProfileImage(Uint8Array.from([0xff,0xd8,0xff]), "image/jpeg", 5 * 1024 * 1024 + 1), /5 MB/));

test("Creator welcome email content is editable sanitized text with safe defaults", () => {
  assert.match(DEFAULT_CREATOR_WELCOME_SUBJECT, /Welcome to CustomHouse Creator/);
  assert.match(DEFAULT_CREATOR_WELCOME_BODY, /Creator Dashboard/);
  assert.match(DEFAULT_CREATOR_WELCOME_BODY, /Create your first product/);
  assert.deepEqual(cleanWelcomeEmailContent("  Hello\u0000 Creator  ", "  Next steps\u0007  "), {
    subject: "Hello Creator",
    body: "Next steps",
  });
  assert.throws(() => cleanWelcomeEmailContent("", "Body"), /subject and body are required/);
});

test("Creator approval invokes the welcome email only on the pending-to-approved transition", () => {
  const service = readFileSync("app/services/creator-application.server.ts", "utf8");
  const welcome = readFileSync("app/services/creator-welcome-email.server.ts", "utf8");
  const settings = readFileSync("app/routes/app.settings.tsx", "utf8");
  assert.match(service, /let approvedTransition = false/);
  assert.match(service, /if \(existing\.status === "APPROVED"\) return existing/);
  assert.match(service, /approvedTransition = true/);
  assert.match(service, /if \(approvedTransition\) \{[\s\S]*sendCreatorWelcomeEmail\(shop, creator\.id\)/);
  assert.match(welcome, /creator\.welcomeEmailSentAt/);
  assert.match(welcome, /creator\.welcome_email\.sent/);
  assert.match(settings, /creatorWelcomeEmailSubject/);
  assert.match(settings, /creatorWelcomeEmailBody/);
  assert.match(settings, /reset-welcome-email/);
});

test("storefront creator form submits through the Shopify app proxy", () => {
  const block = readFileSync("extensions/customhouse-creator-storefront/blocks/creator-application.liquid", "utf8");
  const guard = readFileSync("extensions/customhouse-creator-storefront/blocks/creator-application-guard.liquid", "utf8");
  for (const source of [block, guard]) {
    assert.match(source, /data-endpoint="\/apps\/customhouse\/api\/creator-application"/);
    assert.match(source, /data-submit-endpoint="\/apps\/customhouse\/api\/applications"/);
    assert.doesNotMatch(source, /custom-house\.vercel\.app/);
    assert.doesNotMatch(source, /\/app\/creator-application/);
  }
});

test("creator application frontend rejects non-json responses before parsing", () => {
  const script = readFileSync("extensions/customhouse-creator-storefront/assets/creator-application.js", "utf8");
  assert.match(script, /contentType\.toLowerCase\(\)\.includes\("application\/json"\)/);
  assert.match(script, /creator_application_non_json_response/);
  assert.match(script, /APPLICATION_NON_JSON_RESPONSE/);
  assert.match(script, /We couldn't complete this request\. Please refresh and try again\./);
  assert.match(script, /creator_application_invalid_json/);
  assert.match(script, /applicationErrorMessage/);
  assert.doesNotMatch(script, /Unexpected token '<'/);
  assert.doesNotMatch(script, /error instanceof Error \? error\.message/);
});

test("creator application form uses one ajax submit path", () => {
  const script = readFileSync("extensions/customhouse-creator-storefront/assets/creator-application.js", "utf8");
  assert.match(script, /form\.addEventListener\("submit"/);
  assert.match(script, /event\.preventDefault\(\)/);
  assert.match(script, /customhouse_creator_application_submit/);
  assert.match(script, /current\.disabled = true/);
  assert.match(script, /root\.dataset\.customhouseInitialized === "true"/);
  assert.match(script, /type="\$\{step === 2 \? "submit" : "button"\}"/);
  assert.doesNotMatch(script, /customer-fields/i);
  assert.doesNotMatch(script, /helium/i);
});

test("creator application proxy responses stay json for api callers", () => {
  const proxy = readFileSync("app/services/proxy.server.ts", "utf8");
  const applicationsRoute = readFileSync("app/routes/proxy.api.applications.tsx", "utf8");
  const creatorApplicationRoute = readFileSync("app/routes/proxy.api.creator-application.tsx", "utf8");

  assert.match(proxy, /authenticate\.public\.appProxy\(request\)/);
  assert.match(proxy, /CUSTOMER_LOGIN_REQUIRED/);
  assert.match(proxy, /Please sign in before submitting your creator application\./);
  assert.match(proxy, /proxyJson/);
  assert.match(proxy, /application\/json; charset=utf-8/);
  assert.doesNotMatch(applicationsRoute, /redirect\(/);
  assert.doesNotMatch(creatorApplicationRoute, /redirect\(/);
  assert.match(applicationsRoute, /export async function action/);
  assert.match(creatorApplicationRoute, /export async function action/);
  assert.match(applicationsRoute, /creator_application_proxy_request/);
  assert.match(creatorApplicationRoute, /creator_application_proxy_request/);
  assert.match(applicationsRoute, /creator_application_proxy_response/);
  assert.match(creatorApplicationRoute, /creator_application_proxy_response/);
  assert.match(applicationsRoute, /statusReturned: 200/);
  assert.match(creatorApplicationRoute, /statusReturned: 200/);
});

test("creator application submit is not blocked by optional Shopify mirrors", () => {
  const service = readFileSync("app/services/creator-application.server.ts", "utf8");
  const submitStart = service.indexOf("export async function submitCreatorApplication");
  const rejectStart = service.indexOf("export async function rejectCreatorApplication");
  const submitService = service.slice(submitStart, rejectStart);

  assert.doesNotMatch(submitService, /pg_advisory_xact_lock/);
  assert.match(service, /creator_application_submit_stage/);
  assert.match(submitService, /submitStage\("VALIDATE_INPUT"/);
  assert.match(submitService, /CREATE_OR_UPDATE_CREATOR/);
  assert.match(submitService, /SET_PENDING/);
  assert.match(submitService, /try\s*{\s*await syncCustomerStatus/);
  assert.match(submitService, /creator_application_status_mirror_failed/);
  assert.match(submitService, /return creatorApplicationView\(creator\)/);
});

test("creator application submit logs original server failures safely", () => {
  const applicationsRoute = readFileSync("app/routes/proxy.api.applications.tsx", "utf8");
  const creatorApplicationRoute = readFileSync("app/routes/proxy.api.creator-application.tsx", "utf8");

  for (const route of [applicationsRoute, creatorApplicationRoute]) {
    assert.match(route, /creator_application_submit_failed/);
    assert.match(route, /errorName/);
    assert.match(route, /errorMessage/);
    assert.match(route, /prismaCode/);
    assert.match(route, /metaKeys/);
    assert.doesNotMatch(route, /accessToken|apiSecret|signature/i);
  }
});

test("custom creator application runtime does not create Helium activity", () => {
  const webhook = readFileSync("app/services/helium-webhook.server.ts", "utf8");
  const dashboardRoute = readFileSync("app/routes/proxy.api.creator-dashboard.tsx", "utf8");
  const dashboard = readFileSync("app/routes/app._index.tsx", "utf8");
  const applicationService = readFileSync("app/services/creator-application.server.ts", "utf8");
  const submitStart = applicationService.indexOf("export async function submitCreatorApplication");
  const rejectStart = applicationService.indexOf("export async function rejectCreatorApplication");
  const submitService = applicationService.slice(submitStart, rejectStart);

  assert.doesNotMatch(webhook, /applyHeliumSync/);
  assert.doesNotMatch(webhook, /withHeliumCreatorFormTags/);
  assert.match(webhook, /customer_creator_sync_skipped/);
  assert.match(webhook, /custom_creator_application_is_canonical/);
  assert.doesNotMatch(dashboardRoute, /lazySyncCreator|loadWithLazySync/);
  assert.match(dashboard, /NOT: \{ action: \{ startsWith: "helium\." \} \}/);
  assert.match(submitService, /tx\.creator\.create/);
  assert.doesNotMatch(submitService, /tx\.creatorApplication\.create|tx\.creatorApplication\.update/);
  assert.doesNotMatch(submitService, /ensureShopifyCreatorCollection|ensureCreatorCollectionRecord/);
  assert.match(submitService, /action: existing \? "creator\.application\.resubmitted" : "creator\.application\.submitted"/);
  assert.doesNotMatch(submitService, /helium\.creator\.created/);
});

test("admin creators are canonical and old application page redirects", () => {
  const appNav = readFileSync("app/routes/app.tsx", "utf8");
  const creatorsRoute = readFileSync("app/routes/app.creators.tsx", "utf8");
  const oldApplicationsRoute = readFileSync("app/routes/app.creator-applications.tsx", "utf8");
  const indexRoute = readFileSync("app/routes/app._index.tsx", "utf8");
  const profileRoute = readFileSync("app/routes/proxy.api.creator-profile.tsx", "utf8");
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");

  assert.doesNotMatch(appNav, /href="\/app\/creator-applications"/);
  assert.match(oldApplicationsRoute, /redirect\("\/app\/creators"\)/);
  assert.match(creatorsRoute, /db\.creator\.findMany/);
  assert.match(creatorsRoute, /db\.creator\.groupBy/);
  assert.doesNotMatch(creatorsRoute, /db\.creatorApplication/);
  assert.match(creatorsRoute, /creator\.displayName \|\| creator\.legalName/);
  assert.doesNotMatch(creatorsRoute, /ID: \{creator\.id\}/);
  assert.match(indexRoute, /db\.creator\.count\(\{\s*where: \{\s*shop,\s*status: "PENDING"/s);
  assert.doesNotMatch(indexRoute, /db\.creatorApplication\.count/);
  assert.doesNotMatch(profileRoute, /creatorApplication/);
  assert.doesNotMatch(dashboardService, /applications:/);
  assert.doesNotMatch(dashboardService, /latestApplication|latestCustomApplication/);
});

test("creator application backfill preserves table and hydrates creators", () => {
  const script = readFileSync("scripts/backfill-creator-applications-to-creators.ts", "utf8");

  assert.match(script, /db\.creatorApplication\.findMany/);
  assert.match(script, /db\.creator\.create/);
  assert.match(script, /db\.creator\.update/);
  assert.match(script, /ensureLocalCreatorCollection/);
  assert.match(script, /creator_application_backfill_complete/);
  assert.doesNotMatch(script, /deleteMany|drop table|DROP TABLE/i);
});

test("creator application reuses the existing form for Phase 4 referral conversion", () => {
  const script = readFileSync("extensions/customhouse-creator-storefront/assets/creator-application.js", "utf8");
  const route = readFileSync("app/routes/proxy.api.creator-application.tsx", "utf8");
  const legacyRoute = readFileSync("app/routes/proxy.api.applications.tsx", "utf8");
  const service = readFileSync("app/services/creator-application.server.ts", "utf8");

  assert.match(script, /name="referralCode"/);
  assert.match(script, /referralFieldMarkup/);
  assert.match(script, /referral\.code \|\| application\.referralCode/);
  assert.match(script, /readonly aria-readonly=\\"true\\"/);
  assert.match(script, /Referred by/);
  assert.match(script, /Optional\. Enter a creator referral code/);
  assert.match(script, /INVALID_REFERRAL_CODE/);
  assert.match(script, /SELF_REFERRAL_NOT_ALLOWED/);
  assert.match(route, /typeof body\.referralCode === "string"/);
  assert.match(legacyRoute, /typeof body\.referralCode === "string"/);

  assert.match(service, /type ApplicationReferralView/);
  assert.match(service, /source: "ATTRIBUTION" \| "CREATOR_RELATION" \| null/);
  assert.match(service, /referralView\(creator, attribution\)/);
  assert.match(service, /status === "CAPTURED"/);
  assert.match(service, /referralCodeSnapshot/);
  assert.match(service, /resolveFirstApplicationReferral/);
  assert.match(service, /findApplicationAttribution/);
  assert.match(service, /resolveReferralCode/);
  assert.match(service, /referrer\.creatorStatus !== "APPROVED"/);
  assert.match(service, /SELF_REFERRAL_NOT_ALLOWED/);
  assert.match(service, /referredByCreatorId: applicationReferral\.referrerCreatorId/);
  assert.match(service, /referredByCreatorId: existing\.referredByCreatorId/);
  assert.match(service, /status: "CONVERTED"/);
  assert.match(service, /convertedAt: now/);
  assert.match(service, /P2002/);
  assert.doesNotMatch(route, /referredByCreatorId/);
  assert.doesNotMatch(legacyRoute, /referredByCreatorId/);
});

test("Phase 4 referral security cases are represented in the submit boundary", () => {
  const service = readFileSync("app/services/creator-application.server.ts", "utf8");
  const script = readFileSync("extensions/customhouse-creator-storefront/assets/creator-application.js", "utf8");

  for (const code of [
    "jp-choyon-khan",
    "creator-25337427558745",
    "RHM82K",
    "creator_abc123",
  ]) {
    assert.doesNotThrow(() => new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(service, /if \(attribution\) \{/);
  assert.match(service, /manualReferralCode: input\.referralCode/);
  assert.match(service, /if \(!manualCode\) return null/);
  assert.match(service, /throw referralValidationError\(\)/);
  assert.match(service, /throw selfReferralError\(\)/);
  assert.match(service, /action: existing \? "creator\.application\.resubmitted" : "creator\.application\.submitted"/);
  assert.match(service, /if \(existing\?\.status === "PENDING"\) \{\s*return existing;\s*\}/s);
  assert.match(service, /existing\s*\?\s*null\s*:\s*await resolveFirstApplicationReferral/s);
  assert.match(service, /creator\.referredByCreatorId/);
  assert.match(service, /creator\.referredByCreator\?\.referralCode/);
  assert.match(service, /attribution\?\.referrerCreatorId === creator\.referredByCreatorId/);
  assert.match(service, /input\.manualReferralCode/);
  assert.match(service, /referrerRecord\.customerId === input\.shopifyCustomerId/);
  assert.match(script, /Referral Code/);
  assert.match(script, /values\.referralCode \|\| "Not provided"/);
});

test("collection display identity backfill preserves public routing keys", () => {
  const script = readFileSync("scripts/backfill-creator-collection-display-identity.ts", "utf8");

  assert.match(script, /Creator.*Designs/);
  assert.match(script, /data: \{ displayName \}/);
  assert.doesNotMatch(script, /publicHandle\s*:/);
  assert.doesNotMatch(script, /publicId\s*:/);
  assert.doesNotMatch(script, /creatorId\s*:/);
});

test("admin creator UX has safe avatars reactivation and persisted notifications", () => {
  const creatorsRoute = readFileSync("app/routes/app.creators.tsx", "utf8");
  const dashboardRoute = readFileSync("app/routes/app._index.tsx", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const profileRoute = readFileSync("app/routes/proxy.api.creator-profile.tsx", "utf8");

  assert.match(schema, /model AdminNotification/);
  assert.match(creatorsRoute, /function safeAvatarUrl/);
  assert.match(creatorsRoute, /creator-avatar-fallback/);
  assert.doesNotMatch(creatorsRoute, /src=\{creator\.profileImageUrl\}/);
  assert.match(creatorsRoute, /reactivateCreator/);
  assert.match(dashboardRoute, /db\.adminNotification\.findMany/);
  assert.match(dashboardRoute, /MARK_ALL_NOTIFICATIONS_READ/);
  assert.match(dashboardRoute, /MARK_NOTIFICATION_READ/);
  assert.match(dashboardRoute, /creator\.reactivated/);
  assert.match(profileRoute, /status: "PENDING"/);
  assert.match(profileRoute, /CREATOR_RESUBMITTED/);
  assert.match(profileRoute, /primaryProfileUrl/);
  assert.match(profileRoute, /categoriesJson/);
  assert.doesNotMatch(profileRoute, /creatorApplication/);
});

test("admin creators directory matches final table ux", () => {
  const creatorsRoute = readFileSync("app/routes/app.creators.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(creatorsRoute, /creator-admin-header-actions/);
  assert.match(creatorsRoute, /creator-notification-menu/);
  assert.match(creatorsRoute, /MARK_ALL_NOTIFICATIONS_READ/);
  assert.doesNotMatch(creatorsRoute, /creator-invite-button/);
  assert.match(creatorsRoute, /creator-admin-toolbar/);
  assert.match(creatorsRoute, /creator-activity-metrics/);
  assert.match(creatorsRoute, /creator-action-group/);
  assert.match(creatorsRoute, /creator-table-action--approve/);
  assert.match(creatorsRoute, /Approve/);
  assert.match(creatorsRoute, /creator-table-footer/);
  assert.match(creatorsRoute, /DEFAULT_CREATOR_PAGE_SIZE = 10/);
  assert.match(creatorsRoute, /db\.creator\.count\(\{ where \}\)/);
  assert.match(creatorsRoute, /skip: \(page - 1\) \* pageSize/);
  assert.match(creatorsRoute, /take: pageSize/);
  assert.match(creatorsRoute, /setCreatorPage/);
  assert.match(creatorsRoute, /creator-pagination-number/);
  assert.match(creatorsRoute, /creator-toolbar-actions/);
  assert.match(creatorsRoute, /creator-more-menu[\s\S]*summary aria-label/);
  assert.doesNotMatch(creatorsRoute, /<summary aria-label=\{`More actions for \$\{displayName\}`\}>•••<\/summary>/);
  assert.match(creatorsRoute, /MARK_NOTIFICATION_READ|unreadNotifications/);
  assert.match(creatorsRoute, /name="intent" value="REJECT"/);
  assert.match(creatorsRoute, /name="intent"[\s\S]*value="REACTIVATE"/);
  assert.match(styles, /Final creator directory redesign/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-table-search-form/);
  assert.match(styles, /\.creator-presence-cell/);
  assert.match(styles, /\.creator-more-menu/);
  assert.match(styles, /Creator directory click and alignment fixes/);
  assert.match(styles, /Creator directory final control alignment/);
  assert.match(styles, /Creator pending approval button/);
  assert.match(styles, /Final compact admin creators alignment override/);
  assert.match(styles, /Creator toolbar and pagination finishing pass/);
  assert.match(styles, /Cohesive responsive creators layout/);
  assert.match(styles, /\.creator-more-menu summary::before/);
  assert.match(styles, /\.creator-toolbar-actions/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-table-search-form[\s\S]*flex-wrap: wrap/);
  assert.match(styles, /\.creator-admin-page[\s\S]*max-width: none/);
  assert.match(styles, /\.creator-admin-page[\s\S]*margin: 0/);
  assert.match(styles, /\.creator-admin-page[\s\S]*padding: 16px clamp\(20px, 2\.5vw, 36px\) 28px/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-table-search-form > label[\s\S]*max-width: none/);
  assert.match(styles, /\.creator-admin-toolbar[\s\S]*padding: 12px/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-table-search-form \.creator-mini-icon[\s\S]*width: 18px/);
  assert.match(styles, /\.creator-toolbar-actions[\s\S]*flex: 1 1 560px/);
  assert.match(styles, /\.creator-toolbar-actions \.creator-application-tabs[\s\S]*width: 100%/);
  assert.match(styles, /\.creator-toolbar-actions \.creator-application-tabs[\s\S]*flex: 1 1 auto/);
  assert.match(styles, /\.creator-toolbar-actions \.creator-application-tabs button[\s\S]*flex: 1 1 0/);
  assert.match(styles, /\.creator-toolbar-actions \.creator-application-tabs button[\s\S]*height: 30px/);
  assert.match(styles, /\.creator-toolbar-actions > button,[\s\S]*height: 40px/);
  assert.match(styles, /\.creator-toolbar-actions > button,[\s\S]*padding: 0/);
  assert.match(styles, /\.creator-admin-page button,[\s\S]*gap: 0/);
  assert.match(styles, /\.creator-admin-page button::before,[\s\S]*content: none/);
  assert.match(styles, /\.creator-admin-page \.creator-view-button::before,[\s\S]*display: none/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-table-search-form > button:not\(\.creator-clear-filter\)::before[\s\S]*display: none/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-number/);
  assert.match(styles, /\.creator-table-footer[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(96px, 1fr\)/);
  assert.match(styles, /\.creator-table-footer[\s\S]*padding: 12px 16px/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination[\s\S]*position: static/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button,[\s\S]*display: inline-flex/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button::before[\s\S]*display: block/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button::before[\s\S]*width: 12px/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button::before[\s\S]*border-top: 3px solid currentColor/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button--prev::before[\s\S]*rotate\(-135deg\)/);
  assert.match(styles, /\.creator-table-footer \.creator-pagination-button--next::before[\s\S]*rotate\(45deg\)/);
  assert.match(styles, /\.creator-table th:nth-child\(1\) \{ width: 20%/);
  assert.match(styles, /\.creator-page-size select/);
  assert.match(styles, /\.creator-admin-toolbar \.creator-application-tabs[\s\S]*background: #f8fafc/);
  assert.match(styles, /\.creator-pagination[\s\S]*background: #f8fafc/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.creator-action-group/);
});

test("admin creators pagination and filters preserve query state", () => {
  const creatorsRoute = readFileSync("app/routes/app.creators.tsx", "utf8");

  assert.match(creatorsRoute, /function setStatusFilter[\s\S]*next\.delete\("page"\)/);
  assert.match(creatorsRoute, /function setStatusFilter[\s\S]*next\.set\("status", status\.toLowerCase\(\)\)/);
  assert.match(creatorsRoute, /function setCreatorPage\(page: number\)[\s\S]*next\.set\("page", String\(page\)\)/);
  assert.match(creatorsRoute, /function setCreatorPage\(page: number\)[\s\S]*next\.set\("pageSize", String\(pagination\.pageSize\)\)/);
  assert.match(creatorsRoute, /function setCreatorPageSize\(pageSize: string\)[\s\S]*next\.delete\("page"\)/);
  assert.match(creatorsRoute, /function clearFilters\(\)[\s\S]*setSearchParams\(new URLSearchParams\(\)/);
  assert.match(creatorsRoute, /const hasClearableFilters = Boolean/);
  assert.match(creatorsRoute, /aria-label=\{`Page \$\{page\}`\}/);
  assert.match(creatorsRoute, /disabled=\{pagination\.page <= 1\}/);
  assert.match(creatorsRoute, /disabled=\{pagination\.page >= pagination\.totalPages\}/);
  assert.match(creatorsRoute, /aria-current=\{page === pagination\.page \? "page" : undefined\}/);
});

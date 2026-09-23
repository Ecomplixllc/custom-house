import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  creatorPitchPrintLaunchConfig,
  loadDashboardState,
  normalizeCreatorSetupEvent,
  normalizePitchPrintSaveEvent,
  resolveDashboardState,
} from "../extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js";
import { countActiveCollectionProducts } from "../app/services/creator-collection-products.server.ts";
import { uploadProfileImage } from "../app/services/profile-image.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

const block = readFileSync(
  "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
  "utf8",
);
const script = readFileSync(
  "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
  "utf8",
);
const styles = readFileSync(
  "extensions/customhouse-creator-storefront/assets/customhouse.css",
  "utf8",
);

function cssMediaBlockAfterComment(
  source: string,
  comment: string,
  condition: string,
) {
  const markerIndex = source.indexOf(comment);
  assert.notEqual(markerIndex, -1, `Missing CSS contract marker: ${comment}`);
  assert.equal(
    source.indexOf(comment, markerIndex + comment.length),
    -1,
    `CSS contract marker must be unique: ${comment}`,
  );

  const header = `@media (${condition})`;
  let headerIndex = markerIndex + comment.length;
  while (/\s/.test(source[headerIndex] || "")) headerIndex += 1;
  assert.equal(
    source.slice(headerIndex, headerIndex + header.length),
    header,
    `Expected ${header} immediately after ${comment}`,
  );

  const openingBrace = source.indexOf("{", headerIndex + header.length);
  assert.notEqual(openingBrace, -1, `Missing opening brace for ${header}`);
  assert.match(source.slice(headerIndex + header.length, openingBrace), /^\s*$/);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(headerIndex, index + 1);
  }

  assert.fail(`Missing closing brace for ${header}`);
}

test("logged-out dashboard state", () => {
  assert.deepEqual(resolveDashboardState({ state: "LOGGED_OUT" }), {
    state: "LOGGED_OUT",
    message: "Please sign in to access your creator dashboard.",
  });
});

test("creator dashboard matches the mobile and iPad responsive shell", () => {
  assert.match(block, /customhouse-dashboard-topbar-brand/);
  assert.match(block, /customhouse-dashboard-mobile-nav/);
  assert.match(block, /data-dashboard-tab-target="overview"[^>]*>[\s\S]*Home/);
  assert.match(block, /data-dashboard-tab-target="my-products"[^>]*>[\s\S]*Products/);
  assert.match(block, /data-dashboard-tab-target="sales"[^>]*>[\s\S]*Sales/);
  assert.match(block, /data-dashboard-tab-target="account"[^>]*>[\s\S]*Account/);
  assert.match(script, /window\.matchMedia\("\(max-width: 1100px\)"\)/);
  assert.match(styles, /Responsive creator dashboard: tablet and phone reference layout/);
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-dashboard-tabs-rail\s*\{[^}]*width: 100% !important;[^}]*max-width: none !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-dashboard-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-dashboard-mobile-nav\s*\{[^}]*display: grid;[^}]*position: fixed;/s,
  );
});

test("missing creator becomes not-applied state", () => {
  assert.deepEqual(resolveDashboardState({ state: "NOT_APPLIED", creatorFound: false }), {
    state: "NOT_APPLIED",
    message: "No creator application was found.",
  });
});

test("dashboard exposes a safe synchronization conflict state", () => { assert.equal(resolveDashboardState({ state: "SYNC_CONFLICT" }).state, "SYNC_CONFLICT"); });

test("pending dashboard state", () => {
  const state = resolveDashboardState({ state: "PENDING", status: "PENDING" });
  assert.equal(state.state, "PENDING");
  assert.equal(state.message, "Your creator application is under review.");
});

test("approved dashboard preserves profile and overview data", () => {
  const data = { state: "APPROVED", displayName: "Ari", status: "APPROVED", collectionUrl: "/apps/customhouse/creators/ari-designs", overview: { totalSales: "USD 100.00", totalEarnings: "USD 10.20", productEarnings: "USD 10.00", referralEarnings: "USD 0.20", commissionRatePercent: 10, collectionsCount: 1, publishedProductsCount: 2 }, topSellingProducts: [], submissions: [{ designName: "Sky", status: "PENDING" }] };
  const view = resolveDashboardState(data);
  assert.equal(view.state, "APPROVED");
  assert.equal(view.data.displayName, "Ari");
  assert.equal(view.data.collectionUrl, "/apps/customhouse/creators/ari-designs");
  assert.equal(view.data.submissions.length, 1);
  assert.equal(view.data.overview.totalSales, "USD 100.00");
  assert.equal(view.data.overview.totalEarnings, "USD 10.20");
  assert.equal(view.data.overview.productEarnings, "USD 10.00");
  assert.equal(view.data.overview.referralEarnings, "USD 0.20");
  assert.equal(view.data.overview.commissionRatePercent, 10);
  assert.equal(view.data.overview.collectionsCount, 1);
  assert.equal(view.data.overview.publishedProductsCount, 2);
});

test("creator dashboard canonical marketplace links avoid native collection URLs", () => {
  const dashboard = readFileSync(
    "app/services/submission.server.ts",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(dashboard, /getCreatorCollectionStorefrontUrl/);
  assert.match(dashboard, /publicHandle: true/);
  assert.doesNotMatch(dashboard, /`\/collections\/\$\{encodeURIComponent\(creator\.marketplaceCollection\.shopifyCollectionHandle\)\}`/);
  assert.match(script, /view\.data\.collectionUrl/);
});

test("storefront dashboard displays total sales and ten percent commission", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );
  const uploadRoute = readFileSync(
    "app/routes/proxy.api.creator-profile-upload.tsx",
    "utf8",
  );
  const dashboardRoute = readFileSync(
    "app/routes/proxy.api.creator-dashboard.tsx",
    "utf8",
  );
  const dashboardService = readFileSync(
    "app/services/submission.server.ts",
    "utf8",
  );
  const collectionProductsRoute = readFileSync(
    "app/routes/proxy.api.creator-collection-products.tsx",
    "utf8",
  );
  const profileRoute = readFileSync(
    "app/routes/proxy.api.creator-profile.tsx",
    "utf8",
  );

  assert.match(block, /data-dashboard-total-sales/);
  assert.match(block, /data-dashboard-total-earnings/);
  assert.match(block, /data-dashboard-product-earnings/);
  assert.match(block, /data-dashboard-referral-earnings-total/);
  assert.match(block, /data-dashboard-commission-rate/);
  assert.match(block, /Commission earnings/);
  assert.match(block, /2% referral bonus/);
  assert.match(script, /overview\.totalSales/);
  assert.match(script, /overview\.totalEarnings/);
  assert.match(script, /overview\.productEarnings/);
  assert.match(script, /overview\.referralEarnings/);
  assert.match(script, /overview\.commissionRatePercent/);
  assert.match(script, /enableDashboardStatCards/);
  assert.match(script, /card\.open = !card\.open/);
  assert.match(script, /showProfileImage/);
  assert.doesNotMatch(script, /renderProfileDetails\(root, view\.data\)/);
  assert.match(script, /refreshUploadedProfileImage/);
  assert.match(script, /removeProfilePhoto/);
  assert.match(script, /removeProfileImage: true/);
  assert.match(script, /data-dashboard-remove-image/);
  assert.match(script, /data-profile-modal-remove-photo/);
  assert.match(script, /bindProfileUpdateModal/);
  assert.match(script, /hydrateProfileUpdateForm/);
  assert.match(script, /profileUpdateValues/);
  assert.match(script, /PROFILE_UPDATE_ENDPOINT/);
  assert.match(script, /saveProfileUpdate/);
  assert.match(script, /readProfileUpdateFormValues/);
  assert.match(script, /short_creator_bio/);
  assert.match(script, /socialportfolio_url/);
  assert.match(script, /terms_agreement/);
  assert.match(script, /field\.type === "checkbox"/);
  assert.match(script, /field\.tagName === "SELECT"/);
  assert.match(script, /hydrateNativeProfileForm/);
  assert.match(script, /nativeProfilePayload/);
  assert.match(script, /saveProfileUpdate\(nativeProfilePayload\(form\)\)/);
  assert.match(script, /refreshDashboard\(\{ quiet: true \}\)/);
  assert.doesNotMatch(script, /refreshDashboard\(\{ sync: true, quiet: true \}\)/);
  assert.doesNotMatch(script, /MutationObserver/);
  assert.doesNotMatch(script, /\.then\(scheduleHydration\)/);
  assert.doesNotMatch(script, /if \(typeof refreshDashboard === "function"\) void refreshDashboard\(\);/);
  assert.match(script, /data-dashboard-profile-modal/);
  assert.doesNotMatch(script, /dashboardProfileFormId/);
  assert.match(script, /dataset\.customhouseInitialized === "true"/);
  assert.match(script, /dataset\.relatedDashboardLoaded !== "true"/);
  assert.doesNotMatch(script, /window\.addEventListener\("pageshow", refreshAfterReturn\)/);
  assert.doesNotMatch(script, /window\.addEventListener\("focus", refreshAfterReturn\)/);
  assert.doesNotMatch(script, /visibilitychange/);
  assert.match(script, /const bioText = view\.data\.bio \|\| ""/);
  assert.doesNotMatch(script, /root\.dataset\.helium/);
  assert.match(script, /data-dashboard-social-link/);
  assert.match(script, /firstProfileLink\(view\.data\.socialLinksJson\)/);
  assert.doesNotMatch(script, /creator-collection-products/);
  assert.doesNotMatch(script, /refreshCollectionProductCount/);
  assert.match(script, /querySelectorAll\("\[data-dashboard-items-sold\]"\)/);
  assert.doesNotMatch(script, /const itemsSold = profile\.querySelector\("\[data-dashboard-items-sold\]"\)/);
  assert.match(
    uploadRoute,
    /profileImageUrl: uploaded\.profileImageUrl \|\| uploaded\.profileImageId/,
  );
  assert.match(dashboardRoute, /CreatorProfileImage/);
  assert.match(dashboardRoute, /\.\.\. on GenericFile \{ url \}/);
  assert.match(dashboardRoute, /profileImage\?\.image\?\.url \|\| result\.profileImage\?\.url/);
  assert.doesNotMatch(dashboardRoute, /lazySyncCreator/);
  assert.doesNotMatch(dashboardRoute, /loadWithLazySync/);
  assert.doesNotMatch(dashboardRoute, /searchParams\.get\("sync"\) === "1"/);
  assert.doesNotMatch(dashboardRoute, /forceSync &&/);
  assert.doesNotMatch(dashboardRoute, /customer\(id:/);
  assert.doesNotMatch(dashboardRoute, /legalName: dashboard\.displayName/);
  assert.doesNotMatch(dashboardRoute, /\["APPROVED", "SYNC_CONFLICT"\]\.includes\(dashboard\.state\)/);
  assert.doesNotMatch(dashboardService, /applications:/);
  assert.doesNotMatch(dashboardService, /latestApplication|latestCustomApplication/);
  assert.match(dashboardService, /const legalName = creator\.legalName/);
  assert.match(dashboardService, /const socialLinksJson = creator\.socialLinksJson/);
  assert.match(dashboardService, /termsAccepted: Boolean\(creator\.termsAcceptedAt\)/);
  assert.doesNotMatch(dashboardService, /latestHeliumApplication/);
  assert.doesNotMatch(dashboardService, /countActiveCollectionProducts/);
  assert.doesNotMatch(dashboardService, /submission\.status === "PUBLISHED" && submission\.createdProductId/);
  assert.match(dashboardService, /publishedProductsCount: sales\.publishedProductsCount/);
  assert.match(collectionProductsRoute, /countActiveCollectionProducts/);
  assert.match(collectionProductsRoute, /publishedProductsCount/);
  assert.match(profileRoute, /creator\.profile\.updated/);
  assert.match(profileRoute, /removeProfileImage/);
  assert.match(profileRoute, /profileImageUrl: removeProfileImage \? null : undefined/);
  assert.match(profileRoute, /portfolioUrl/);
  assert.match(profileRoute, /socialLinksJson/);
  assert.match(profileRoute, /termsAcceptedAt/);
  assert.match(script, /Loading\.\.\./);
  assert.match(script, /const showStatusMessage = !\["LOADING", "APPROVED"\]\.includes\(view\.state\)/);
  assert.match(script, /heading\.textContent = displayName/);
  assert.doesNotMatch(script, /'s Dashboard/);
  assert.match(script, /renderEarningsCharts\(root, overview\)/);
  assert.match(script, /data-dashboard-earnings-chart/);
  assert.match(script, /customhouse-earnings-line/);
  assert.match(script, /customhouse-earnings-dot/);
  assert.doesNotMatch(script, /customhouse-earnings-bar/);
  assert.doesNotMatch(script, /svg\.style\.minWidth/);
  assert.match(script, /function bindDashboardMobileNav\(root\)/);
  assert.match(script, /customhouse-dashboard-nav-open/);
  assert.match(script, /customhouse-dashboard-sidebar-collapsed/);
  assert.match(script, /function setDashboardSidebarCollapsed\(root, collapsed\)/);
  assert.match(script, /function resetDashboardHorizontalScroll\(\)/);
  assert.match(script, /document\.documentElement\.scrollLeft = 0/);
  assert.match(script, /document\.body\.scrollLeft = 0/);
  assert.match(script, /aria-controls/);
  assert.match(script, /setDashboardMobileNav\(root, false\)/);
  assert.match(block, /customhouse-dashboard-skeleton/);
  assert.match(block, /customhouse-dashboard-hero__kicker/);
  assert.doesNotMatch(styles, /\.customhouse-dashboard-hero span:first-child\s*\{[^}]*display: block;/s);
  assert.match(block, /<details class="customhouse-dashboard-stat" data-stat-icon="money">[\s\S]*Total Sales/);
  assert.match(block, /View store/);
  assert.match(block, /open_in_new/);
  assert.match(block, /Copy link/);
  assert.match(block, /content_copy/);
  assert.match(block, /ios_share/);
  assert.match(block, />\s*<span>Share<\/span>/);
  assert.match(block, /data-dashboard-share-store/);
  assert.match(block, /data-dashboard-share-menu/);
  assert.match(styles, /\.customhouse-store-card__heading\s*\{[^}]*grid-template-columns: 64px minmax\(0, 1fr\);[^}]*align-items: center;/s);
  assert.match(styles, /\.customhouse-store-card__heading > \.material-symbols-outlined\s*\{[^}]*width: 64px;[^}]*height: 64px;[^}]*place-items: center;[^}]*font-size: 1\.35rem;/s);
  assert.match(styles, /\.customhouse-store-card__actions \.material-symbols-outlined\s*\{[^}]*width: 1\.35rem;[^}]*height: 1\.35rem;[^}]*font-size: 1\.35rem;/s);
  assert.match(styles, /\.customhouse-store-card__actions button,\s*\.customhouse-store-card__actions a\s*\{[^}]*min-height: 48px;[^}]*align-items: center;[^}]*gap: \.55rem;/s);
  assert.match(styles, /\.customhouse-store-card__actions span:not\(\.material-symbols-outlined\)\s*\{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*color: inherit;[^}]*font-size: \.72rem;[^}]*line-height: 1\.1;/s);
  assert.match(script, /bindStoreCopy\(root, storeCopyUrl, profile\.querySelector\("\[data-dashboard-copy-store-message\]"\)\)/);
  assert.match(block, /Remove photo/);
  assert.match(block, /aria-label="Loading creator dashboard"/);
  assert.doesNotMatch(block, />Loading\.\.\.<\/p>/);
  assert.match(block, /class="customhouse-dashboard-tabs-rail" data-dashboard-tabs-rail/);
  assert.match(block, /data-dashboard-tabs-rail[\s\S]*data-dashboard-tab-panel="overview"[\s\S]*data-dashboard-tab-panel="add-product"[\s\S]*data-dashboard-tab-panel="my-products"[\s\S]*data-dashboard-tab-panel="sales"[\s\S]*data-dashboard-tab-panel="account"/);
  assert.match(block, /class="customhouse-dashboard-tab-panel customhouse-dashboard-section customhouse-profile-panel" data-dashboard-tab-panel="account"/);
  assert.match(block, /data-dashboard-edit-profile-icon/);
  assert.match(block, /data-dashboard-social-link/);
  assert.doesNotMatch(block, /data-dashboard-portfolio/);
  assert.doesNotMatch(block, /Creator portfolio/);
  assert.doesNotMatch(script, /data-dashboard-portfolio/);
  assert.doesNotMatch(block, /data-dashboard-profile-details/);
  assert.doesNotMatch(block, /data-dashboard-legal-name/);
  assert.doesNotMatch(block, /data-dashboard-display-name/);
  assert.match(block, /data-dashboard-profile-update-form/);
  assert.match(block, /data-profile-field="displayName"/);
  assert.match(block, /data-profile-field="legalName"/);
  assert.match(block, /data-profile-field="bio"/);
  assert.match(block, /data-profile-field="portfolioUrl"/);
  assert.match(block, /data-profile-field="termsAccepted"/);
  assert.match(styles, /\.customhouse-native-profile-check input:checked/);
  assert.match(styles, /appearance: none/);
  assert.match(styles, /stroke='white'/);
  assert.doesNotMatch(block, /data-helium-/);
  assert.doesNotMatch(block, /customer_fields/);
  assert.match(block, /customer\.first_name/);
  assert.match(block, /customer\.last_name/);
  assert.match(block, /data-shopify-first-name/);
  assert.match(block, /data-shopify-last-name/);
  assert.match(block, /data-dashboard-profile-modal/);
  assert.match(block, /Start a New Design/);
  assert.match(script, /Start Design/);
  assert.match(block, /data-dashboard-review-modal/);
  assert.doesNotMatch(block, /data-dashboard-pitchprint-modal/);
  assert.doesNotMatch(block, /Create Draft/);
  assert.doesNotMatch(block, /Open PitchPrint/);
  assert.doesNotMatch(block, /data-cf-form/);
  assert.doesNotMatch(block, /profile_form_id/);
  assert.doesNotMatch(block, /Helium edit account form ID/);
  assert.doesNotMatch(block, /dGtXke/);
  assert.doesNotMatch(block, /lXteLY/);
  assert.match(block, /Material\+Symbols\+Outlined/);
  assert.match(block, /material-symbols-outlined notranslate" translate="no"/);
  assert.match(block, /customhouse-logout-icon" translate="no" aria-hidden="true">logout<\/span>Logout/);
  assert.match(block, />edit<\/span>/);
  assert.match(block, /← Back to Account/);
  assert.match(block, /customhouse-profile-editor-layout/);
  assert.match(block, /customhouse-profile-editor-sidebar/);
  assert.match(block, /data-profile-modal-progress/);
  assert.match(script, /function updateNativeProfileModalSummary/);
  assert.doesNotMatch(block, /data-dashboard-helium-update/);
  assert.doesNotMatch(block, /Update profile details/);
  assert.doesNotMatch(block, /profile_update_url \| default: block\.settings\.application_url/);
  assert.match(styles, /\.customhouse-profile-title-row/);
  assert.match(styles, /\.customhouse-profile-edit-icon/);
  assert.match(styles, /\.customhouse-profile-social-link/);
  assert.match(styles, /Mobile account tab polish/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-profile-copy h3\s*\{[^}]*white-space: nowrap;[^}]*word-break: normal;/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-card button\.customhouse-profile-edit-icon\s*\{[^}]*width: 2\.25rem;/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-profile-actions\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  assert.doesNotMatch(styles, /\.customhouse-profile-details/);
  assert.match(styles, /\.customhouse-card button\.customhouse-quick-action/);
  assert.match(styles, /\.ch-creator-modal/);
  assert.match(styles, /width: min\(680px, calc\(100vw - 32px\)\)/);
  assert.match(styles, /max-height: calc\(100dvh - 40px\)/);
  assert.doesNotMatch(styles, /\.modal-content/);
  assert.doesNotMatch(styles, /\.customhouse-pitchprint-modal-panel/);
  assert.match(styles, /\.customhouse-card a\.customhouse-quick-action/);
  assert.match(styles, /\.customhouse-profile-form-wrap/);
  assert.match(styles, /Creator account update modal screenshot match/);
  assert.match(styles, /Creator account update modal full editor override/);
  assert.match(styles, /Creator account update modal unscoped live override/);
  assert.match(styles, /\.customhouse-profile-modal \.customhouse-profile-editor-layout\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\) 318px/);
  assert.match(styles, /width: min\(1040px, calc\(100vw - 40px\)\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 318px/);
  assert.match(styles, /\.customhouse-native-profile-grid\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.customhouse-sidebar-nav \.material-symbols-outlined\s*\{[^}]*display: inline-grid;[^}]*width: 1\.45rem;[^}]*height: 1\.45rem;[^}]*place-items: center;[^}]*font-size: 1\.45rem;/s);
  assert.match(styles, /\.customhouse-store-card__heading > \.material-symbols-outlined\s*\{[^}]*width: 64px;[^}]*height: 64px;[^}]*place-items: center;[^}]*font-size: 1\.35rem;/s);
  assert.match(styles, /\.customhouse-store-card__actions \.material-symbols-outlined\s*\{[^}]*width: 1\.35rem;[^}]*height: 1\.35rem;[^}]*place-items: center;[^}]*font-size: 1\.35rem;/s);
  assert.match(styles, /\.customhouse-sidebar-nav \.material-symbols-outlined\.notranslate\s*\{[^}]*translate: no;/s);
  assert.match(styles, /\.customhouse-sidebar-nav \.customhouse-logout-icon\s*\{[^}]*font-size: 0;/s);
  assert.match(styles, /\.customhouse-sidebar-nav \.customhouse-logout-icon::before\s*\{[^}]*mask: url/s);
  assert.match(styles, /\.customhouse-dashboard-shell\s*\{[^}]*display: grid;[^}]*grid-template-columns: 256px minmax\(0, 1fr\);[^}]*min-width: 1500px;/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.customhouse-dashboard-shell\s*\{[^}]*min-width: 0;/s);
  assert.match(styles, /\.customhouse-dashboard-nav-open \.customhouse-dashboard-sidebar\s*\{[^}]*transform: translateX\(0\);/s);
  assert.match(styles, /\.customhouse-dashboard-shell::before/);
  assert.match(styles, /\.customhouse-card button\.customhouse-dashboard-menu\s*\{[^}]*background: #fff;/s);
  assert.match(styles, /\.customhouse-dashboard-skeleton/);
  assert.match(styles, /@keyframes customhouse-skeleton-shimmer/);
  assert.match(styles, /\.customhouse-dashboard-sidebar-collapsed \.customhouse-dashboard-shell\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  assert.match(styles, /Final dashboard responsiveness[\s\S]*\.customhouse-card\.customhouse-dashboard-page\s*\{[^}]*left: auto;[^}]*width: 100%;[^}]*max-width: 1520px;[^}]*transform: none;/s);
  assert.match(styles, /320px mobile hardening/);
  assert.match(styles, /html:has\(\[data-customhouse-dashboard\]\),\s*body:has\(\[data-customhouse-dashboard\]\)\s*\{[^}]*overflow-x: hidden;/s);
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]*\.customhouse-card\.customhouse-dashboard-page\s*\{[^}]*inline-size: 100vw;/s);
  assert.match(styles, /Mobile panel fit: recent activity and earnings must never crop to the right/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-dashboard-bottom\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-earnings-chart svg\s*\{[^}]*min-width: 0;/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-submission-product strong\s*\{[^}]*-webkit-line-clamp: 2;/s);
  assert.match(styles, /\.customhouse-dashboard-page\s*{[^}]*width: 100%;/s);
  assert.match(styles, /\.customhouse-dashboard-page\s*{[^}]*max-width: 1520px;/s);
  assert.match(styles, /--ch-dashboard-tab-rail-width: 1200px;/);
  assert.match(styles, /\.customhouse-dashboard-tabs-rail\s*\{[^}]*width: min\(100%, var\(--ch-dashboard-tab-rail-width\)\);[^}]*max-width: var\(--ch-dashboard-tab-rail-width\);[^}]*margin-right: auto;[^}]*margin-left: 0;[^}]*justify-self: start;/s);
  assert.match(styles, /Desktop tab width alignment: every dashboard tab fills the same content rail/);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*justify-self: stretch;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-profile-panel\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*display: grid;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-creator-products-panel \.ch-design-card\s*\{[^}]*max-width: 330px;[^}]*justify-self: start;/s);
  assert.match(styles, /Desktop tab full-width enforcement/);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-shell\s*\{[^}]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-shell\s*\{[^}]*min-width: 1500px !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-main\s*\{[^}]*width: 100% !important;[^}]*justify-items: stretch !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail\s*\{[^}]*width: min\(100%, var\(--ch-dashboard-tab-rail-width\)\) !important;[^}]*min-width: var\(--ch-dashboard-tab-rail-width\) !important;[^}]*max-width: var\(--ch-dashboard-tab-rail-width\) !important;[^}]*justify-self: start !important;/s);
  assert.match(styles, /Desktop topbar removal and Add Product card polish/);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-topbar\s*\{[^}]*display: none !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \[data-dashboard-tab-panel\]\.is-active[\s\S]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-main > \[data-dashboard-tab-panel\]\.is-active[\s\S]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-main > \.customhouse-dashboard-section\.is-active\s*\{[^}]*display: grid !important;[^}]*grid-template-columns: minmax\(0, 1fr\) !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-dashboard-main > \.customhouse-add-product-panel\.is-active[\s\S]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-dashboard-main > \.customhouse-sales-tab-panel\.is-active[\s\S]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-dashboard-main > \.customhouse-profile-panel\.is-active[\s\S]*width: 100% !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-creator-products-panel \.ch-designs__grid\s*\{[^}]*repeat\(auto-fill, minmax\(min\(100%, 250px\), 330px\)\);[^}]*justify-content: start;[^}]*justify-items: start;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-creator-products-panel \.ch-design-card\s*\{[^}]*width: 100%;[^}]*max-width: 330px;[^}]*justify-self: start;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-base-product-card\s*\{[^}]*width: 100%;[^}]*max-width: none;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-add-product-panel\.is-active,[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.is-active\s*\{[^}]*min-inline-size: var\(--ch-dashboard-tab-rail-width\) !important;[^}]*max-inline-size: var\(--ch-dashboard-tab-rail-width\) !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1\.05fr\) minmax\(220px, \.42fr\) minmax\(280px, \.53fr\) !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-add-product-panel \.customhouse-base-products\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /Add Product and Account width parity: both tabs must match the shared rail on every device/);
  assert.match(styles, /\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-add-product-panel,[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\s*\{[^}]*width: 100% !important;[^}]*max-width: 100% !important;[^}]*justify-self: stretch !important;/s);
  assert.match(styles, /\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-add-product-panel\.is-active,[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.is-active\s*\{[^}]*display: grid !important;[^}]*grid-column: 1 \/ -1 !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-add-product-panel \.customhouse-base-products\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-add-product-panel\.is-active,[\s\S]*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) !important;/s);
  assert.match(styles, /Mobile earnings readability/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-earnings-panel > strong\s*\{[^}]*font-size: 2rem;/s);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.customhouse-earnings-value,[\s\S]*\.customhouse-earnings-label\s*\{[^}]*font-size: 14px;/s);
  assert.match(styles, /Dashboard mobile card and activity cleanup/);
  assert.match(styles, /\.customhouse-submission-action::after,[\s\S]*\.customhouse-submission-action a::after,[\s\S]*\.customhouse-submission-row a::after\s*\{[^}]*content: "" !important;[^}]*display: none !important;/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.customhouse-card button\.ch-design-menu__button\s*\{[^}]*width: 2\.75rem !important;[^}]*color: #111827 !important;[^}]*background: #fff !important;/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.customhouse-card button\.ch-design-menu__button \.material-symbols-outlined\s*\{[^}]*color: #111827 !important;[^}]*font-size: 1\.5rem !important;/s);
  assert.match(styles, /@media \(min-width: 981px\)[\s\S]*\.customhouse-sales-tab-panel > \.customhouse-earnings-panel[\s\S]*width: 100%;/s);
  assert.match(styles, /\[data-customhouse-dashboard\] \.customhouse-base-product-card\.ch-design-card\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-rows: auto 1fr auto;/s);
  assert.match(styles, /\[data-customhouse-dashboard\] \.customhouse-base-product-card\.ch-design-card \.ch-design-card__button\s*\{[^}]*width: 100%;/s);
  assert.doesNotMatch(styles, /calc\(50% - 50vw/);
  assert.match(styles, /View details \+/);
  assert.match(styles, /Hide details -/);
});

test("creator dashboard starts PitchPrint directly and reviews saved designs without reloads", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(script, /bindPitchPrintManager/);
  assert.match(script, /bindCreatorDesignActions/);
  assert.match(script, /window\.matchMedia\("\(max-width: 520px\)"\)\.matches/);
  assert.match(script, /compact \? Math\.max\(360, source\.length \* 70\) : Math\.max\(720, source\.length \* 104\)/);
  assert.match(script, /data-base-product-start/);
  assert.match(script, /createCreatorProductDraft/);
  assert.match(script, /await root\.__customHouseOpenPitchPrintDesigner\?\.\(created, startButton\)/);
  assert.match(script, /setActionLoading\(startButton, "Preparing designer\.\.\."\)/);
  assert.match(script, /if \(manager\.showAppCalled\) return/);
  assert.match(script, /client\.showApp\(\)/);
  assert.match(script, /bindPitchPrintEvent\(client, "project-saved"/);
  assert.match(script, /manager\.projectSaved/);
  assert.match(script, /saveCreatorProductPitchPrintProject/);
  assert.match(script, /updateCreatorProductInState\(root, updated\)/);
  assert.match(script, /openDesignReviewModal\(root, updated\)/);
  assert.match(script, /data-dashboard-review-edit/);
  assert.match(script, /data-dashboard-review-draft/);
  assert.match(script, /data-dashboard-review-submit/);
  assert.match(script, /Submit for Review/);
  assert.match(script, /Resubmit for Review/);
  assert.match(script, /Design saved as draft/);
  assert.match(script, /Submitted for review/);
  assert.match(script, /creatorProductStatusLabel/);
  assert.match(script, /Pending Review/);
  assert.match(script, /Needs Changes/);
  assert.match(script, /card\.className = "customhouse-base-product-card ch-design-card ch-design-card--base"/);
  assert.match(script, /media\.className = "ch-design-card__preview"/);
  assert.match(script, /copy\.className = "ch-design-card__body customhouse-base-product-card__body"/);
  assert.match(script, /button\.className = "ch-design-card__button ch-design-card__button--primary"/);
  assert.match(script, /Unavailable/);
  assert.match(script, /data-base-product-color/);
  assert.match(script, /data-base-product-method/);
  assert.match(script, /Choose exactly one product color and one printing method/);
  assert.match(script, /existing\?\.readyState === "complete"/);
  assert.match(script, /src === JQUERY_SRC && window\.jQuery/);
  assert.match(script, /root\.__customHouseCreatorDesignActionsBound/);
  assert.match(script, /root\.__customHousePitchPrintManagerBound/);
  assert.match(script, /root\.__customHouseDesignReviewBound/);
  assert.match(script, /state\.actionLoading\.has\(key\)/);
  assert.match(script, /dashboardState\(root\)\.baseProducts = products/);
  assert.match(script, /dashboardState\(root\)\.creatorProducts = products/);
  assert.match(script, /dataset\.relatedDashboardLoaded = "true"/);
  assert.doesNotMatch(script, /location\.reload|window\.location\.reload|location\.href/);
  assert.doesNotMatch(script, /data-dashboard-pitchprint-launch/);
  assert.doesNotMatch(script, /Open Designer/);
  assert.doesNotMatch(script, /Open PitchPrint/);
  assert.doesNotMatch(script, /bindCreatorProductForm/);
  assert.doesNotMatch(script, /refreshAfterReturn/);
  assert.doesNotMatch(script, /window\.addEventListener\("focus"/);
  assert.doesNotMatch(script, /visibilitychange/);

  assert.match(script, /Start Design/);
  assert.doesNotMatch(script, /Ready for creator design/);
  assert.match(block, /Review your design before submitting it for approval/);
  assert.match(block, /Continue Editing/);
  assert.match(block, /Keep as Draft/);
  assert.match(block, /Submit for Review/);
  assert.doesNotMatch(block, /data-dashboard-creator-products-form/);
  assert.doesNotMatch(block, /data-dashboard-pitchprint-launch/);
  assert.doesNotMatch(block, /Edit Draft/);

  assert.match(styles, /\.ch-creator-modal__dialog/);
  assert.match(styles, /height:/);
  const sharedDialog = styles.match(/\.ch-creator-modal__dialog\s*\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(sharedDialog, /\n\s*height:/);
});

test("creator dashboard renders professional My Designs management UI", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /aria-label="My Designs"/);
  assert.match(block, /Manage your designs, review status, and published products/);
  assert.match(block, /data-dashboard-design-filters/);
  assert.match(block, /placeholder="Search your designs"/);
  assert.match(block, /Recently Updated/);
  assert.match(block, /data-dashboard-details-modal/);
  assert.match(block, /Edit design details/);
  assert.match(block, /Design title/);
  assert.match(block, /data-dashboard-action-modal/);
  assert.match(block, /data-dashboard-action-confirm/);

  assert.match(script, /updateCreatorProductDetails/);
  assert.match(script, /performCreatorProductAction/);
  assert.match(script, /filterCreatorProducts/);
  assert.match(script, /renderDesignFilters/);
  assert.match(script, /creatorProductPreviewUrl/);
  assert.match(script, /data-design-menu-toggle/);
  assert.match(script, /data-design-menu-action/);
  assert.match(script, /more_horiz/);
  assert.match(script, /aria-haspopup/);
  assert.match(script, /role", "menu"/);
  assert.match(script, /role", "menuitem"/);
  assert.match(script, /Edit Details/);
  assert.match(script, /Delete Design/);
  assert.match(script, /Archive Design/);
  assert.match(script, /Withdraw to Draft/);
  assert.match(script, /Restore to Draft/);
  assert.match(script, /Design details updated/);
  assert.match(script, /Design deleted/);
  assert.match(script, /Design archived/);
  assert.match(script, /removeCreatorProductFromState/);
  assert.match(script, /state\.designFilter/);
  assert.match(script, /state\.designSearch/);
  assert.match(script, /state\.designSort/);
  assert.match(script, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(script, /location\.reload|window\.location\.reload|location\.href/);

  assert.match(styles, /\.ch-designs__grid\s*\{[^}]*repeat\(auto-fill, minmax\(250px, 1fr\)\)/s);
  assert.match(styles, /\.ch-designs__grid\s*\{[^}]*gap: \.8rem;/s);
  assert.match(styles, /\.ch-design-card\s*\{[^}]*max-width: 330px;/s);
  assert.doesNotMatch(styles, /\.ch-design-card__description\s*\{[^}]*min-height:/s);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.ch-designs__grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.ch-designs__grid\s*\{[^}]*grid-template-columns: 1fr/s);
  assert.match(styles, /\.ch-design-card__preview\s*\{[^}]*aspect-ratio: 4 \/ 3/s);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(styles, /\.ch-design-menu__panel/);
  assert.match(styles, /\.ch-design-menu__button \.material-symbols-outlined/);
  assert.match(styles, /\.customhouse-card button\.ch-design-menu__button\s*\{[^}]*width: 2\.55rem;/s);
  assert.match(styles, /\.ch-design-edit-modal__form/);
  assert.match(styles, /\.ch-design-delete-modal__confirm/);
  assert.doesNotMatch(styles, /\.card\s*\{/);
  assert.doesNotMatch(styles, /\.modal\s*\{/);
});

test("design review modal matches the responsive mobile submission sheet", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /ch-design-review-modal/);
  assert.match(block, /data-summary-icon="sell"/);
  assert.match(block, /data-summary-icon="layers"/);
  assert.match(block, /data-summary-icon="schedule"/);
  assert.match(styles, /Responsive creator design submission sheet/);
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.ch-design-review-modal\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-review-modal \.ch-creator-modal__previews\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    styles,
    /\[data-dashboard-review-submit\]\s*\{[^}]*order: 1;/s,
  );
});

test("My Products matches the responsive iPad and mobile design", () => {
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(styles, /Responsive My Products tablet and phone layout/);
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-creator-products-panel \.ch-designs__grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-creator-products-panel \.ch-designs__grid\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) !important;/s,
  );
  assert.match(
    styles,
    /\.customhouse-creator-products-panel \.ch-design-card\s*\{[^}]*grid-template-columns: 108px minmax\(0, 1fr\) !important;/s,
  );
  assert.match(
    styles,
    /:has\(\[data-dashboard-tab-panel="my-products"\]\.is-active\) \.customhouse-dashboard-topbar/s,
  );
  assert.match(
    styles,
    /\.ch-design-card__body > small\.ch-design-card__meta:first-of-type\s*\{[^}]*display: none;/s,
  );
});

test("creator dashboard delete modal and action menu stay compact and scoped", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /class="ch-creator-modal ch-design-delete-modal"/);
  assert.match(block, /data-dashboard-action-confirm/);
  assert.match(script, /data-design-menu-action/);
  assert.match(script, /ch-design-menu__item--danger/);

  assert.match(styles, /\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*width: min\(540px, calc\(100vw - 32px\)\);/s);
  assert.match(styles, /\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*height: auto;/s);
  assert.match(styles, /\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*max-height: calc\(100dvh - 40px\);/s);
  assert.match(styles, /\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*overflow: hidden;/s);
  assert.match(styles, /\.ch-design-delete-modal footer\s*\{[^}]*gap: 10px;/s);
  assert.match(styles, /\.ch-design-delete-modal footer\s*\{[^}]*margin: 0;/s);
  assert.match(styles, /\.ch-design-delete-modal__confirm\s*\{[^}]*background: #d92d20;/s);
  assert.doesNotMatch(styles, /\.ch-design-delete-modal footer\s*\{[^}]*margin: \.25rem -1\.15rem/s);

  assert.match(styles, /\.ch-design-menu__panel\s*\{[^}]*display: flex;/s);
  assert.match(styles, /\.ch-design-menu__panel\s*\{[^}]*flex-direction: column;/s);
  assert.match(styles, /\.ch-design-menu__panel\s*\{[^}]*gap: 4px;/s);
  assert.match(styles, /\.ch-design-menu__panel\s*\{[^}]*padding: 6px;/s);
  assert.match(styles, /\.customhouse-card \.ch-design-menu__item\s*\{[^}]*background: transparent;/s);
  assert.match(styles, /\.customhouse-card \.ch-design-menu__item\s*\{[^}]*border-radius: 8px;/s);
  assert.match(styles, /\.customhouse-card \.ch-design-menu__item--danger\s*\{[^}]*color: #b42318;/s);
  assert.doesNotMatch(styles, /\.ch-design-menu__item\s*\{[^}]*background: #4f46e5/s);
  assert.doesNotMatch(styles, /\.modal\s*\{|\.button\s*\{|\.dropdown\s*\{/);
});

test("withdraw design uses the responsive mobile confirmation sheet", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /data-dashboard-withdraw-notice/);
  assert.match(block, /Pending review will be canceled/);
  assert.match(block, /The design will be moved back to Draft, and you can edit it anytime\./);
  assert.match(
    script,
    /classList\.toggle\("ch-design-delete-modal--withdraw", action === "withdraw"\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.ch-design-delete-modal--withdraw\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal--withdraw \.ch-creator-modal__dialog\s*\{[^}]*width: 100%;[^}]*border-radius: 28px 28px 0 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal--withdraw footer\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  );
});

test("delete design uses the responsive destructive confirmation sheet", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /data-dashboard-delete-notice/);
  assert.match(block, /Design will be permanently deleted/);
  assert.match(block, /This action cannot be undone, and the design cannot be recovered\./);
  assert.match(
    script,
    /classList\.toggle\("ch-design-delete-modal--delete", action === "delete"\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.ch-design-delete-modal--delete\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal--delete \.ch-creator-modal__dialog\s*\{[^}]*width: 100%;[^}]*border-radius: 28px 28px 0 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal--delete \.ch-design-delete-notice > \.material-symbols-outlined\s*\{[^}]*color: #b42318;[^}]*background: #fee4e2;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal--delete \.ch-design-delete-modal__confirm\s*\{[^}]*background: #d92d20;/s,
  );
});

test("design details editor uses the responsive mobile bottom sheet", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /ch-design-edit-modal/);
  assert.match(block, /data-summary-icon="deployed_code"/);
  assert.match(block, /data-summary-icon="circle"/);
  assert.match(styles, /Responsive design details editor sheet/);
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.ch-design-edit-modal\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-edit-modal \.ch-creator-modal__dialog\s*\{[^}]*width: 100%;[^}]*border-radius: 28px 28px 0 0;/s,
  );
  assert.match(
    styles,
    /\.ch-design-edit-modal \.ch-creator-modal__summary\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  );
  assert.match(
    styles,
    /\.ch-design-edit-modal \[data-dashboard-details-save\]\s*\{[^}]*order: 1;/s,
  );
  assert.match(
    styles,
    /\.ch-design-edit-modal \[data-dashboard-details-save\]\s*\{[^}]*color: #fff;/s,
  );
});

test("creator dashboard popups share the professional mobile sheet contract", () => {
  const phoneContract = cssMediaBlockAfterComment(
    styles,
    "/* Shared professional mobile popup contract. */",
    "max-width: 600px",
  );

  assert.match(
    phoneContract,
    /\.customhouse-payout-method-modal,\s*\.customhouse-profile-modal,\s*\.ch-design-review-modal,\s*\.ch-design-edit-modal,\s*\.ch-design-delete-modal\s*\{[^}]*align-items: end;[^}]*padding: 0;/s,
  );
  assert.match(
    phoneContract,
    /\.customhouse-payout-method-modal \.ch-creator-modal__dialog,\s*\.customhouse-profile-modal-panel,\s*\.ch-design-review-modal \.ch-creator-modal__dialog,\s*\.ch-design-edit-modal \.ch-creator-modal__dialog,\s*\.ch-design-delete-modal \.ch-creator-modal__dialog\s*\{[^}]*width: 100%;[^}]*max-height: calc\(100dvh - 54px\);[^}]*border-radius: 28px 28px 0 0;/s,
  );
  assert.match(
    phoneContract,
    /\.customhouse-payout-method-modal \.ch-creator-modal__dialog header button,\s*\.customhouse-profile-modal-panel header button,\s*\.ch-design-review-modal \.ch-creator-modal__dialog header button,\s*\.ch-design-edit-modal \.ch-creator-modal__dialog header button,\s*\.ch-design-delete-modal \.ch-creator-modal__dialog header button\s*\{[^}]*width: 40px !important;[^}]*height: 40px;[^}]*min-height: 40px !important;/s,
  );
  assert.match(
    phoneContract,
    /\.ch-design-delete-modal:not\(\.ch-design-delete-modal--withdraw\):not\(\.ch-design-delete-modal--delete\) footer\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*padding: 0 20px calc\(20px \+ env\(safe-area-inset-bottom\)\);/s,
  );
  assert.match(
    phoneContract,
    /\.ch-design-delete-modal:not\(\.ch-design-delete-modal--withdraw\):not\(\.ch-design-delete-modal--delete\) footer button\s*\{[^}]*width: 100% !important;[^}]*min-width: 0;[^}]*min-height: 50px !important;/s,
  );
  assert.match(
    script,
    /openDashboardActionModal\(\s*root,\s*\{\s*kind: "collection-banner-remove",[^{}]*destructive: true,/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal__confirm\s*\{[^}]*background: #d92d20;/s,
  );
  assert.match(
    styles,
    /\.ch-design-delete-modal__confirm--safe\s*\{[^}]*background: #4f46e5;/s,
  );
});

test("creator dashboard modals use one viewport-fixed modal root", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /id="customhouse-modal-root"/);
  assert.equal((block.match(/id="customhouse-modal-root"/g) || []).length, 1);
  assert.match(script, /function customhouseModalRoot\(\)/);
  assert.match(script, /document\.body\.append\(modalRoot\)/);
  assert.match(script, /function portalDashboardModals\(root\)/);
  assert.match(script, /portalDashboardModals\(root\)/);
  assert.match(script, /dashboardModalQuery\(root, "\[data-dashboard-review-modal\]"\)/);
  assert.match(script, /dashboardModalQuery\(root, "\[data-dashboard-details-modal\]"\)/);
  assert.match(script, /dashboardModalQuery\(root, "\[data-dashboard-action-modal\]"\)/);
  assert.match(script, /dashboardModalQuery\(root, "\[data-dashboard-profile-modal\]"\)/);
  assert.match(script, /document\.body\.style\.overflow = "hidden"/);
  assert.doesNotMatch(script, /scrollY|pageYOffset|scrollHeight|offsetTop|window\.scrollTo|location\.hash/);

  assert.match(styles, /\.ch-creator-modal\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.ch-creator-modal\s*\{[^}]*inset: 0;/s);
  assert.match(styles, /\.ch-creator-modal\s*\{[^}]*display: grid;/s);
  assert.match(styles, /\.ch-creator-modal\s*\{[^}]*place-items: center;/s);
  assert.match(styles, /\.ch-creator-modal\s*\{[^}]*height: 100dvh;/s);
  assert.match(styles, /\.ch-creator-modal__backdrop\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.ch-creator-modal__dialog\s*\{[^}]*max-height: calc\(100dvh - 40px\);/s);
  assert.match(styles, /\.ch-creator-modal__dialog\s*\{[^}]*overflow: hidden;/s);
  assert.match(styles, /\.ch-design-edit-modal__form\s*\{[^}]*overflow-y: auto;/s);
  assert.match(styles, /\.ch-creator-modal__previews\s*\{[^}]*overflow-y: auto;/s);
  assert.match(styles, /\.customhouse-profile-modal\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.customhouse-profile-modal\s*\{[^}]*height: 100dvh;/s);
  assert.match(styles, /\.customhouse-profile-modal-backdrop\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.customhouse-profile-modal-panel\s*\{[^}]*max-height: calc\(100dvh - 40px\);/s);
  assert.match(styles, /\.customhouse-profile-form-wrap\s*\{[^}]*overflow-y: auto;/s);
  assert.doesNotMatch(styles, /\.ch-creator-modal\s*\{[^}]*position: absolute;/s);
  assert.doesNotMatch(styles, /\.customhouse-profile-modal\s*\{[^}]*position: absolute;/s);
});

test("creator dashboard derives recent submissions from creator products", () => {
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(script, /function recentSubmissionProducts\(products, limit = 5\)/);
  assert.match(script, /new Set\(\["PENDING", "REJECTED", "PUBLISHED", "ARCHIVED"\]\)/);
  assert.match(script, /\.filter\(\(product\) => allowed\.has\(String\(product\.status \|\| ""\)\.toUpperCase\(\)\)\)/);
  assert.match(script, /return bTime - aTime/);
  assert.match(script, /\.slice\(0, limit\)/);
  assert.match(script, /function renderRecentSubmissionsFromProducts\(root, products\)/);
  assert.match(script, /renderSubmissions\(list, recentSubmissionProducts\(products\)\)/);
  assert.match(script, /renderRecentSubmissionsFromProducts\(root, products\)/);
  assert.match(script, /renderRecentSubmissionsFromProducts\(root, state\.creatorProducts\)/);
  assert.match(script, /dashboardState\(root\)\.creatorProducts \|\| \[\]/);
  assert.match(script, /title\.textContent = submission\.title \|\| submission\.baseProductTitle \|\| "Untitled design"/);
  assert.match(script, /button\.dataset\.creatorProductDesign = submission\.id/);
  assert.match(script, /link\.href =\s*submission\.publicProductUrl \|\|/s);
  assert.match(script, /action\.textContent = statusValue === "ARCHIVED" \? "Archived" : "View status"/);
  assert.doesNotMatch(script, /view\.data\.submissions/);
  assert.doesNotMatch(script, /designName/);
  assert.doesNotMatch(script, /createdProductId/);
  assert.doesNotMatch(script, /renderSubmissions\(submissions/);

  assert.match(styles, /\.customhouse-submission-head,\s*\.customhouse-submission-row\s*\{[^}]*minmax\(190px, 1fr\) max-content max-content max-content/s);
  assert.match(styles, /\.customhouse-submission-row\s*\{[^}]*min-height: 52px;/s);
  assert.match(styles, /\.customhouse-submission-product img,\s*\.customhouse-submission-product i\s*\{[^}]*width: 34px;/s);
  assert.match(styles, /\.customhouse-submission-empty\s*\{[^}]*display: grid;/s);
});

test("creator dashboard reuses in-flight product requests and keeps submit actions in menus", () => {
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(script, /let creatorProductsLoadPromise = null/);
  assert.match(script, /let creatorBaseProductsLoadPromise = null/);
  assert.match(script, /if \(!creatorProductsLoadPromise\) \{/);
  assert.match(script, /creatorProductsLoadPromise = \(async \(\) =>/);
  assert.match(script, /creatorProductsLoadPromise = null/);
  assert.match(script, /if \(!creatorBaseProductsLoadPromise\) \{/);
  assert.match(script, /creatorBaseProductsLoadPromise = \(async \(\) =>/);
  assert.match(script, /creatorBaseProductsLoadPromise = null/);
  assert.match(script, /addMenuAction\(menu, "Submit for Review", "submit", product\.id\)/);
  assert.match(script, /addMenuAction\(menu, "Resubmit for Review", "submit", product\.id\)/);
  assert.match(script, /action === "submit" && product\?\.id/);
  assert.match(script, /const updated = await submitCreatorProductForReview\(product\.id\)/);
  assert.match(script, /updateCreatorProductInState\(root, updated\)/);
});

test("creator dashboard PitchPrint bridge uses Creator setup contract instead of order quantities", () => {
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(script, /function creatorPitchPrintConfig/);
  assert.match(script, /window\.CustomHouseCreatorPitchPrintConfig = config/);
  assert.match(script, /enabled: true/);
  assert.match(script, /flowMode: "CREATOR_DESIGN"/);
  assert.match(script, /creatorContext: true/);
  assert.match(script, /launchContext: "creator_dashboard"/);
  assert.match(script, /const \{ designId, projectId, mode \} = creatorPitchPrintLaunchConfig\(product\)/);
  assert.match(script, /const clientOptions = \{/);
  assert.match(script, /designId,/);
  assert.match(script, /projectId,/);
  assert.match(script, /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/);
  assert.doesNotMatch(script, /mode,\s*projectId,\s*userId/);
  assert.doesNotMatch(script, /creatorPitchPrintLaunchProjectId\(product\)/);
  assert.doesNotMatch(script, /creatorPitchPrintLaunchProjectIdSource/);
  assert.doesNotMatch(script, /const projectId = product\.pitchprintProjectId \|\| ""/);
  assert.doesNotMatch(script, /product\.pitchprintProjectId \|\| product\.pitchprintDesignId/);
  assert.match(script, /productOrigin:\s*baseProductOrigin/);
  assert.match(script, /designMode: "creator_design"/);
  assert.match(script, /isCreatorProduct: true/);
  assert.match(script, /creatorProductId: product\.id/);
  assert.match(script, /creatorPublicHandle/);
  assert.match(script, /colorOptionValues/);
  assert.match(script, /colors: colorOptionValues/);
  assert.match(script, /sizeOptionValues/);
  assert.match(script, /sizes: sizeOptionValues/);
  assert.match(script, /optionGroups/);
  assert.match(script, /productionMethods/);
  assert.match(script, /productionMethodPricing/);
  assert.match(script, /selectedColor: setup\?\.fixedColor \|\| ""/);
  assert.match(script, /selectedColors: setup\?\.fixedColor \? \[setup\.fixedColor\] : \[\]/);
  assert.match(script, /fixedColor: setup\?\.fixedColor \|\| ""/);
  assert.match(script, /selectedProductionMethod: setup\?\.productionMethod \|\| ""/);
  assert.match(script, /fixedProductionMethod: setup\?\.productionMethod \|\| ""/);
  assert.match(script, /supportsMultipleSelections: false/);
  assert.match(script, /CUSTOMHOUSE_PP_CREATOR_SETUP_READY/);
  assert.match(script, /customhouse:pitchprint-creator-setup-ready/);
  assert.match(script, /CUSTOMHOUSE_PP_CREATOR_CONFIG_REQUEST/);
  assert.match(script, /CUSTOMHOUSE_PP_CREATOR_CONFIG_DATA/);
  assert.match(script, /CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST/);
  assert.match(script, /CUSTOMHOUSE_PP_ORDER_CONFIG_DATA/);
  assert.match(script, /ensurePitchPrintBaseProductConfig\(root, product\)/);
  assert.match(script, /pendingCreatorSetup: null/);
  assert.match(script, /pendingPitchPrintSave: null/);
  assert.match(script, /const savePayload = buildCreatorSavePayload\(\)/);
  assert.match(script, /if \(!savePayload\)/);
  assert.match(script, /handlePitchPrintProjectSaved\(product, event, token\)/);
  assert.match(script, /creatorSetup: normalizeCreatorSetupPayload\(setup\)/);
  assert.match(script, /Choose one color and confirm copyright\./);
  assert.doesNotMatch(script, /Sizes \/ Amount/);
  assert.doesNotMatch(script, /selectedPitchPrintVariants/);
  assert.doesNotMatch(script, /data-variant-quantity-action/);
  assert.doesNotMatch(script, /Select at least one size and quantity\./);
});

test("creator PitchPrint launch config separates template design ID from saved project ID", () => {
  const newDesign = creatorPitchPrintLaunchConfig({
    pitchprintDesignId: " pp_design_global_hoodie ",
    pitchprintProjectId: "",
  });
  assert.deepEqual(newDesign, {
    designId: "pp_design_global_hoodie",
    projectId: "",
    mode: "new",
  });
  assert.notEqual(newDesign.projectId, newDesign.designId);

  const savedProject = creatorPitchPrintLaunchConfig({
    pitchprintDesignId: "pp_design_global_hoodie",
    pitchprintProjectId: " pp_project_saved_123 ",
  });
  assert.deepEqual(savedProject, {
    designId: "pp_design_global_hoodie",
    projectId: "pp_project_saved_123",
    mode: "edit",
  });
});

test("creator PitchPrint launch config requires a template design ID only", () => {
  assert.throws(
    () =>
      creatorPitchPrintLaunchConfig({
        pitchprintDesignId: "",
        pitchprintProjectId: "",
      }),
    /PitchPrint is not configured for this product/,
  );
});
test("creator PitchPrint save normalization ignores generic non-PitchPrint IDs", () => {
  const saveEvent = normalizePitchPrintSaveEvent({
    data: {
      id: "gid://shopify/Product/123",
      previewUrl: "https://cdn.pitchprint.test/preview.png",
    },
  });
  assert.equal(saveEvent.projectId, "");
  assert.equal(saveEvent.previewUrl, "https://cdn.pitchprint.test/preview.png");

  const undefinedProject = normalizePitchPrintSaveEvent({
    data: { projectId: "undefined" },
  });
  assert.equal(undefinedProject.projectId, "");

  const setupEvent = normalizeCreatorSetupEvent({
    type: "CUSTOMHOUSE_PP_CREATOR_SETUP_READY",
    payload: {
      creatorContext: true,
      launchContext: "creator_dashboard",
      id: "mtndb59p00041104rz1d5t4e",
      fixedColor: "White",
      selectedColor: "White",
      selectedColors: ["White"],
      copyrightAccepted: true,
    },
  });
  assert.equal(setupEvent?.projectId, "");
  assert.equal(setupEvent?.creatorSetup.fixedColor, "White");
});

test("creator PitchPrint save normalization keeps uploaded file previews", () => {
  const saveEvent = normalizePitchPrintSaveEvent({
    data: {
      projectId: "pp_project_with_file",
      files: [{ url: "https://cdn.pitchprint.test/uploaded-front.png" }],
    },
  });

  assert.equal(saveEvent.projectId, "pp_project_with_file");
  assert.deepEqual(saveEvent.previews, [
    { url: "https://cdn.pitchprint.test/uploaded-front.png" },
  ]);
  assert.deepEqual(saveEvent.previewUrl, {
    url: "https://cdn.pitchprint.test/uploaded-front.png",
  });
});

test("profile picture upload stores Shopify media and returns a display URL", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      requests.push(query);
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/profile",
                resourceUrl: "https://cdn.shopify.test/staged/profile.png",
                parameters: [{ name: "key", value: "profile.png" }],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("fileCreate")) {
        return {
          fileCreate: {
            files: [
              {
                id: "gid://shopify/MediaImage/123",
                fileStatus: "READY",
                image: { url: "https://cdn.shopify.test/profile.png" },
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    const uploaded = await uploadProfileImage(
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "profile.png",
        { type: "image/png" },
      ),
      client,
    );

    assert.equal(uploaded.profileImageId, "gid://shopify/MediaImage/123");
    assert.equal(uploaded.profileImageUrl, "https://cdn.shopify.test/profile.png");
    assert.equal(uploaded.status, "READY");
    assert.equal(requests.some((query) => query.includes("stagedUploadsCreate")), true);
    assert.equal(requests.some((query) => query.includes("fileCreate")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejected dashboard state includes safe reason", () => {
  assert.equal(resolveDashboardState({ state: "REJECTED", rejectionReason: "Portfolio incomplete" }).message, "Your creator application was rejected: Portfolio incomplete");
});

test("suspended dashboard state includes safe reason", () => {
  assert.equal(resolveDashboardState({ state: "SUSPENDED", suspensionReason: "Review required" }).message, "Your creator account is suspended: Review required");
});

test("API failure emits error and always clears loading", async () => {
  const events: Array<{ state: string; loading: boolean }> = [];
  await loadDashboardState(async () => { throw new Error("private upstream error"); }, (event: { state: string; loading: boolean }) => events.push(event));
  assert.deepEqual(events.map((event) => event.state), ["LOADING", "API_ERROR", "LOADING_COMPLETE"]);
  assert.equal(events[0]?.loading, true);
  assert.equal(events.at(-1)?.loading, false);
});

test("successful response always clears loading", async () => {
  const events: Array<{ state: string; loading: boolean }> = [];
  await loadDashboardState(async () => ({ state: "PENDING" }), (event: { state: string; loading: boolean }) => events.push(event));
  assert.deepEqual(events.map((event) => event.state), ["LOADING", "PENDING", "LOADING_COMPLETE"]);
  assert.equal(events.at(-1)?.loading, false);
});

test("manually added active collection products are included in the published count", async () => {
  const cursors: Array<unknown> = [];
  const client: ShopifyGraphqlClient = {
    async request<T>(_query: string, variables?: Record<string, unknown>) {
      cursors.push(variables?.after);
      const response = variables?.after
        ? {
            collection: {
              products: {
                nodes: [{ status: "ACTIVE" }, { status: "ACTIVE" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        : {
            collection: {
              products: {
                nodes: [
                  { status: "ACTIVE" },
                  { status: "DRAFT" },
                  { status: "ARCHIVED" },
                ],
                pageInfo: { hasNextPage: true, endCursor: "page-2" },
              },
            },
          };
      return response as T;
    },
  };

  assert.equal(
    await countActiveCollectionProducts(
      client,
      "gid://shopify/Collection/123",
    ),
    3,
  );
  assert.deepEqual(cursors, [null, "page-2"]);
});

test("a deleted or unavailable creator collection has zero published products", async () => {
  const client: ShopifyGraphqlClient = {
    async request<T>() {
      return { collection: null } as T;
    },
  };

  assert.equal(
    await countActiveCollectionProducts(
      client,
      "gid://shopify/Collection/404",
    ),
    0,
  );
});

test("creator dashboard surfaces Phase 7 referral financials without browser creator identity", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");
  const proxyRoute = readFileSync("app/routes/proxy.api.creator-dashboard.tsx", "utf8");

  assert.match(block, /data-dashboard-tab-target="referrals"/);
  assert.match(block, /data-dashboard-tab-panel="referrals"/);
  assert.match(block, /earn a 2% referral bonus/);
  assert.match(block, /2% of eligible referred creator earnings/);
  assert.match(block, /data-dashboard-referral-total-creators/);
  assert.match(block, /data-dashboard-referral-original/);
  assert.match(block, /data-dashboard-referral-adjustments/);
  assert.match(block, /data-dashboard-referral-final/);
  assert.match(block, /data-dashboard-referral-creators/);
  assert.match(block, /data-dashboard-referral-earnings/);
  assert.match(script, /function renderReferralFinancials/);
  assert.match(script, /referralTotalLabel\(totals, "final"\)/);
  assert.match(script, /row\.finalEntitlement/);
  assert.match(script, /row\.adjustmentsTotal/);
  assert.match(script, /view\.data\.referrals \|\| \{\}/);
  assert.match(dashboardService, /referralEarningsForAuthenticatedCreator/);
  assert.match(dashboardService, /authenticatedCreatorId: creator\.id/);
  assert.match(proxyRoute, /context\.customerId/);
  assert.doesNotMatch(proxyRoute, /searchParams\.get\(["']creatorId["']\)/);
  assert.doesNotMatch(block, /10% referral|2% of eligible referred creator sales/);
});

test("referrals tab matches the responsive iPad and mobile design", () => {
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(styles, /Responsive referrals tablet and phone layout/);
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-referrals-tab-panel > \.customhouse-dashboard-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-referrals-tab-panel \.customhouse-referral-panel\s*\{[^}]*text-align: center;/s,
  );
  assert.match(
    styles,
    /\.customhouse-referrals-tab-panel \.customhouse-dashboard-referral-statuses\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    styles,
    /\.customhouse-referrals-tab-panel > \.customhouse-dashboard-bottom\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  );
  assert.match(
    styles,
    /\.customhouse-referrals-tab-panel \.customhouse-referral-row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
  );
  assert.match(
    styles,
    /\.customhouse-referrals-tab-panel \.customhouse-referral-list-item > b\s*\{[^}]*grid-column: 2;[^}]*grid-row: 1 \/ 3;/s,
  );
});

test("account tab matches the responsive iPad mini and mobile design", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /customhouse-account-intro/);
  assert.match(block, /customhouse-account-public-card/);
  assert.match(block, /data-dashboard-account-toggle="details"/);
  assert.match(block, /data-dashboard-account-toggle="actions"/);
  assert.match(script, /function bindAccountMobileSections/);
  assert.match(script, /classList\.toggle\("is-mobile-open", expanded\)/);
  assert.match(
    script,
    /const header = button\.closest\("\.customhouse-account-section-heading"\)/,
  );
  assert.match(
    script,
    /if \(!window\.matchMedia\("\(max-width: 600px\)"\)\.matches\) return;/,
  );
  assert.match(script, /header\.addEventListener\("click", toggleSection\)/);
  assert.match(script, /bindAccountMobileSections\(root\)/);
  assert.match(styles, /Responsive account tablet and phone layout/);
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-account-hero\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(240px, 34%\);/s,
  );
  assert.match(
    styles,
    /\.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1\.62fr\) minmax\(300px, \.88fr\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1\.45fr\) minmax\(260px, \.75fr\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\) and \(min-width: 601px\)[\s\S]*\.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) !important;/s,
  );
  assert.match(
    styles,
    /Responsive account tablet and phone layout[\s\S]*@media \(max-width: 600px\)\s*\{\s*\[data-customhouse-dashboard\] \.customhouse-dashboard-tabs-rail > \.customhouse-profile-panel\.customhouse-dashboard-tab-panel\.is-active\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*\.customhouse-profile-panel\.is-active > \.customhouse-account-hero,[\s\S]*\.customhouse-profile-panel\.is-active > \.customhouse-account-details\s*\{[^}]*grid-column: 1 \/ -1 !important;/s,
  );
  assert.match(
    styles,
    /\.customhouse-account-section-heading > div\s*\{[^}]*border: 0 !important;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 600px\)[\s\S]*\.customhouse-account-details:not\(\.is-mobile-open\) > div\s*\{[^}]*display: none;/s,
  );
  assert.match(
    styles,
    /\.customhouse-profile-actions:not\(\.is-mobile-open\) > :not\(header\)\s*\{[^}]*display: none;/s,
  );
  assert.match(
    styles,
    /\.customhouse-banner-actions\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
  );
});

test("dashboard sections do not clip between 1101px and 1510px", () => {
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(
    styles,
    /@media \(min-width: 1101px\) and \(max-width: 1510px\)[\s\S]*\.customhouse-dashboard-shell\s*\{[^}]*min-inline-size: 0 !important;[^}]*min-width: 0 !important;/s,
  );
  assert.match(
    styles,
    /@media \(min-width: 1101px\) and \(max-width: 1510px\)[\s\S]*\.customhouse-dashboard-tabs-rail\s*\{[^}]*inline-size: 100% !important;[^}]*min-inline-size: 0 !important;[^}]*max-inline-size: none !important;/s,
  );
  assert.match(
    styles,
    /@media \(min-width: 1101px\) and \(max-width: 1510px\)[\s\S]*\.customhouse-dashboard-tabs-rail > \[data-dashboard-tab-panel\]\.is-active\s*\{[^}]*width: 100% !important;[^}]*min-width: 0 !important;[^}]*max-width: none !important;/s,
  );
});

test("client-final dashboard controls reuse existing flows and preserve safe state", () => {
  assert.match(block, /No products yet/);
  assert.match(block, /data-dashboard-tab-target="add-product"[^>]*>Create Product</);
  assert.match(block, /data-dashboard-notification-toggle/);
  assert.match(block, /data-dashboard-notification-panel/);
  assert.match(block, /data-has-unread="false"/);
  assert.match(script, /function bindCreatorNotifications\(root\)/);
  assert.match(script, /document\.addEventListener\("click"/);
  assert.match(script, /event\.key === "Escape"/);
  assert.match(styles, /\[data-dashboard-notification-panel\][\s\S]*z-index: 1000/);
  assert.match(script, /root\.__customHouseBannerDraft/);
  assert.match(script, /bannerDraft\.bannerImageUrl = URL\.createObjectURL\(file\)/);
  assert.match(block, /Danger Zone/);
  assert.match(block, /Delete Creator Account/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /confirmation !== "DEACTIVATE"/);
  const profileRoute = readFileSync("app/routes/proxy.api.creator-profile.tsx", "utf8");
  assert.match(profileRoute, /changeCreatorStatus\([\s\S]*"SUSPENDED"/);
  assert.match(profileRoute, /shopifyCustomerPreserved: true/);
  assert.match(script, /designFilter: "ACTIVE"/);
  assert.match(script, /status !== "ARCHIVED"/);
});

test("theme account choices and footer explain the canonical Creator path", () => {
  const header = readFileSync("theme-live-cart/sections/header.liquid", "utf8");
  const footer = readFileSync("theme-live-cart/sections/footer-group.json", "utf8");
  assert.match(header, /Create a customer account to manage your orders and purchases\./);
  assert.match(header, /Apply to become a Creator and publish your designs on CustomHouse\./);
  assert.match(footer, /BECOME A CREATOR/);
  assert.match(footer, /shopify:\/\/pages\/become-a-creator/);
});


import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("setup readiness does not hard-code deployed storefront checks as unverifiable", () => {
  const setupRoute = readFileSync("app/routes/app.setup.tsx", "utf8");

  assert.doesNotMatch(setupRoute, /Unable to verify automatically/);
  assert.match(setupRoute, /SetupCustomerWebhooks/);
  assert.match(setupRoute, /CUSTOMERS_CREATE/);
  assert.match(setupRoute, /CUSTOMERS_UPDATE/);
  assert.match(setupRoute, /name: "Creator Dashboard block"/);
  assert.match(setupRoute, /name: "PitchPrint Compatibility Embed"/);
  assert.match(setupRoute, /PitchPrint customizable/);
  assert.match(setupRoute, /Make app defaults ready/);
});

test("native marketplace uses canonical collection IDs instead of creator names", () => {
  const collections = readFileSync("app/services/creator-collections.server.ts", "utf8");
  const publishing = readFileSync("app/services/creator-product-publishing.server.ts", "utf8");
  const dashboard = readFileSync("app/services/submission.server.ts", "utf8");

  assert.match(collections, /getCanonicalShopifyCreatorCollection/);
  assert.match(collections, /creator_collection_id/);
  assert.match(collections, /CREATOR_COLLECTION_RECOVERY_CONFLICT/);
  assert.match(publishing, /collection\.shopifyCollectionId/);
  assert.doesNotMatch(publishing, /collectionTitle|collections\(first:[\s\S]*title:/);
  assert.match(dashboard, /marketplaceCollection/);
  assert.match(dashboard, /getCreatorCollectionStorefrontUrl/);
  assert.match(dashboard, /publicHandle: true/);
  assert.doesNotMatch(dashboard, /shopifyCollectionHandle: true/);
  assert.doesNotMatch(dashboard, /creator\.handle-\$\{slugify/);
});

test("native marketplace audit and reconcile scripts are safe and id based", () => {
  const audit = readFileSync("scripts/native-marketplace-audit.ts", "utf8");
  const reconcile = readFileSync("scripts/native-marketplace-reconcile.ts", "utf8");

  assert.match(audit, /nativeProductsMissingFromCanonicalCollection/);
  assert.match(audit, /duplicateCanonicalCandidates/);
  assert.match(reconcile, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(reconcile, /mode: apply \? "apply" : "dry-run"/);
  assert.match(reconcile, /creatorCollectionId/);
  assert.doesNotMatch(reconcile, /title:\*\$\{creator\.displayName\}/);
});

test("creator locked products use canonical storefront classification", () => {
  const productSection = readFileSync(
    "theme-source/horizon-live-creator-button/sections/product-information.liquid",
    "utf8",
  );
  const productDetails = readFileSync(
    "theme-source/horizon-live-creator-button/blocks/_product-details.liquid",
    "utf8",
  );
  const compatibilityBlock = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/inkybay-compatibility-embed.liquid",
    "utf8",
  );
  const storefrontJs = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.js",
    "utf8",
  );

  for (const source of [productSection, productDetails, compatibilityBlock]) {
    assert.match(source, /product_origin/);
    assert.match(source, /design_mode/);
    assert.match(source, /design_status/);
    assert.match(source, /buy_only/);
    assert.match(source, /published/);
    assert.match(source, /is_creator_locked_product/);
  }
  assert.match(productSection, /data-customhouse-product-mode="\{% if is_creator_locked_product %\}creator-locked/);
  assert.match(productSection, /premium_product\.metafields\.customhouse\.creator_display_name\.value/);
  assert.match(productSection, /premium_product\.metafields\.customhouse\.creator_handle\.value/);
  assert.match(productSection, /premium_creator_profile\.display_name/);
  assert.match(productSection, /premium_creator_brand = 'Custom House'/);
  assert.match(productSection, /unless is_inkybay_designlab_product or is_creator_locked_product/);
  assert.match(productDetails, /data-customhouse-product-mode="\{% if is_creator_locked_product %\}creator-locked/);
  assert.match(productDetails, /unless is_creator_locked_product/);
  assert.match(storefrontJs, /data-customhouse-product-mode='creator-locked'/);
  assert.match(storefrontJs, /MutationObserver/);
  assert.match(storefrontJs, /observer\.disconnect/);
  assert.match(storefrontJs, /setTimeout\(\(\) => \{[\s\S]*observer\.disconnect\(\);[\s\S]*\}, 6000\)/);
});

test("global customizable products still render PitchPrint customization path", () => {
  const productSection = readFileSync(
    "theme-source/horizon-live-creator-button/sections/product-information.liquid",
    "utf8",
  );
  const productDetails = readFileSync(
    "theme-source/horizon-live-creator-button/blocks/_product-details.liquid",
    "utf8",
  );

  assert.match(productSection, /current_product_type == 'global_customizable' and current_pitchprint_enabled == true/);
  assert.match(productSection, /data-pitchprint-enabled="true"/);
  assert.match(productDetails, /product_type == 'global_customizable' and pitchprint_enabled == true/);
  assert.match(productDetails, /data-customhouse-pitchprint-required="true"/);
  assert.match(productDetails, /Add to cart/);
});

test("native creator product publishing strips customization triggers and sets locked values", () => {
  const publishing = readFileSync(
    "app/services/creator-product-publishing.server.ts",
    "utf8",
  );

  assert.match(publishing, /metafieldsDelete/);
  assert.match(publishing, /customhouse", key: "pitchprint_design_id"/);
  assert.match(publishing, /customhouse", key: "pitchprint_enabled"/);
  assert.match(publishing, /customhouse", key: "inkybay_enabled"/);
  assert.match(publishing, /pitchprint", key: "design_id"/);
  assert.match(publishing, /\["product_origin", "creator"\]/);
  assert.match(publishing, /\["design_mode", "buy_only"\]/);
  assert.match(publishing, /\["design_status", "published"\]/);
  assert.match(publishing, /\["product_type", "creator_fixed"\]/);
  assert.match(publishing, /\["base_product_id", input\.product\.shopifyProductId\]/);
  assert.match(publishing, /\["creator_display_name", input\.product\.creator\?\.displayName \|\| input\.collection\.displayName\]/);
  assert.match(publishing, /\["creator_handle", input\.collection\.publicHandle\]/);
});

test("native marketplace backfill sanitizes creator products without touching base products", () => {
  const reconcile = readFileSync("scripts/native-marketplace-reconcile.ts", "utf8");
  const audit = readFileSync("scripts/native-marketplace-audit.ts", "utf8");

  assert.match(reconcile, /remove-customization-trigger-metafields/);
  assert.match(reconcile, /deleteCustomizationTriggers/);
  assert.match(reconcile, /product\.publishedShopifyProductId/);
  assert.match(reconcile, /baseProductId/);
  assert.doesNotMatch(reconcile, /product\.shopifyProductId!\)/);
  assert.match(audit, /pitchprintDesignIdPresent/);
  assert.match(audit, /customizeExpected/);
});

test("final marketplace approval and links are app managed", () => {
  const creatorProducts = readFileSync("app/services/creator-products.server.ts", "utf8");
  const adminRoute = readFileSync("app/routes/app.creator-products.tsx", "utf8");
  const dashboardJs = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const urls = readFileSync("app/services/creator-storefront-urls.ts", "utf8");

  const moderationBlock =
    creatorProducts.match(/export async function moderateCreatorProductAsAdmin[\s\S]*?export async function listPublishedCreatorProductsForHandle/)?.[0] || "";
  assert.doesNotMatch(moderationBlock, /publishCreatorProductToShopify/);
  assert.match(moderationBlock, /status: "PUBLISHED"/);
  assert.match(adminRoute, /Custom House marketplace/);
  assert.match(adminRoute, /new AdminGraphqlClient/);
  assert.match(adminRoute, /cleanupCreatorProductAsAdmin/);
  assert.match(creatorProducts, /GLOBAL_PRODUCT_CLEANUP_FORBIDDEN/);
  assert.match(creatorProducts, /CREATOR_PRODUCT_CLEANUP_IDENTITY_MISMATCH/);
  assert.match(creatorProducts, /getCreatorProductStorefrontUrl/);
  assert.doesNotMatch(creatorProducts, /publicProductUrl: product\.publishedShopifyProductUrl/);
  assert.match(dashboardJs, /View Product/);
  assert.match(urls, /\/apps\/customhouse\/creators/);
  assert.doesNotMatch(urls, /\/pages\/creator-collection/);
  assert.doesNotMatch(urls, /\/pages\/creator-product/);
});

test("app managed creator cart uses base variants and signed attribution", () => {
  const proxy = readFileSync("app/services/storefront-proxy.server.ts", "utf8");
  const products = readFileSync("app/services/creator-products.server.ts", "utf8");
  const sales = readFileSync("app/services/creator-sales.server.ts", "utf8");
  const attribution = readFileSync("app/services/creator-attribution.server.ts", "utf8");

  assert.match(proxy, /data-customhouse-option/);
  assert.match(proxy, /name="variantId"/);
  assert.match(proxy, /Content-Type": "application\/json"/);
  assert.match(proxy, /preparedPayload\.items/);
  assert.match(products, /items: \[/);
  assert.match(proxy, /class CustomHouseCartError extends Error/);
  assert.match(proxy, /fetchStage\("PREPARE_CART"/);
  assert.match(proxy, /fetchStage\("SHOPIFY_CART_ADD"/);
  assert.match(proxy, /readPrepareCartResponse/);
  assert.match(proxy, /readShopifyAjaxResponse/);
  assert.match(proxy, /JSON\.parse\(raw\)/);
  assert.match(proxy, /SHOPIFY_CART_INVALID_JSON/);
  assert.match(proxy, /SHOPIFY_CART_422/);
  assert.match(proxy, /SHOPIFY_CART_VARIANT_MISMATCH/);
  assert.match(proxy, /CART_CONFIRMATION/);
  assert.match(proxy, /CART_CONFIRMATION_STALE/);
  assert.match(proxy, /credentials: "same-origin"/);
  assert.match(proxy, /NON_JSON|APP_PROXY_HTML_RESPONSE|SHOPIFY_CART_NON_JSON/);
  assert.match(proxy, /STOREFRONT_PASSWORD_REDIRECT/);
  assert.match(proxy, /INVALID_CART_VARIANT_ID/);
  assert.match(proxy, /customhouse_creator_cart_debug/);
  assert.match(proxy, /customhouse_creator_cart_error/);
  assert.match(proxy, /stage: wrapped\.stage/);
  assert.match(proxy, /customhouse-product-gallery/);
  assert.match(proxy, /customhouse-creator-line/);
  assert.match(proxy, /Custom House/);
  assert.match(proxy, /function productPreviewImages/);
  assert.match(proxy, /JSON\.parse\(input\.previewUrls \|\| "\[\]"\)/);
  assert.match(proxy, /mainPreviewImage/);
  assert.match(proxy, /Back preview/);
  assert.match(proxy, /data-customhouse-gallery-thumb/);
  assert.match(proxy, /data-customhouse-gallery-main/);
  assert.match(proxy, /thumb\.addEventListener\("click"/);
  assert.match(proxy, /mainImage\.src = nextImage/);
  assert.match(proxy, /customhouse-more/);
  assert.match(proxy, /More from/);
  assert.match(proxy, /collectionName/);
  assert.match(proxy, /customhouse-public-services/);
  assert.match(proxy, /customhouse-public-toolbar/);
  assert.match(proxy, /customhouse-public-card-favorite/);
  assert.match(proxy, /customhouse-public-card-body/);
  assert.match(proxy, /productCount/);
  assert.match(proxy, /Creator collection/);
  assert.match(proxy, /const href = getCreatorProductStorefrontUrl\(input\.collection, product\) \|\| "#"/);
  assert.doesNotMatch(proxy, /product\.publishedShopifyProductUrl \|\|\s*getCreatorProductStorefrontUrl\(input\.collection, product\)/);
  assert.doesNotMatch(proxy, /customhouse-proxy-header/);
  assert.doesNotMatch(proxy, /customhouse-proxy-footer/);
  assert.match(proxy, /async function siteHeaderAccount\(context: VerifiedProxyContext\)/);
  assert.match(
    proxy,
    /function siteHeader\(\s*account: SiteHeaderAccount = \{ loggedIn: false \},\s*activePage\?: "creatorContent",\s*\)/,
  );
  assert.match(proxy, /function siteFooter\(\)/);
  assert.match(proxy, /\$\{siteHeader\(input\.headerAccount\)\}/);
  assert.match(proxy, /headerAccount: await siteHeaderAccount\(context\)/);
  assert.match(proxy, /Creator dashboard/);
  assert.match(proxy, /Log out/);
  assert.match(proxy, /\$\{siteFooter\(\)\}/);
  assert.match(proxy, /customhouse-header__nav/);
  assert.match(proxy, /CUSTOMHOUSE_HEADER_LOGO_URL/);
  assert.match(proxy, /CUSTOMHOUSE_FOOTER_BACKGROUND_URL/);
  assert.match(proxy, /Screenshot_43-removebg-preview\.png\?width=900/);
  assert.match(proxy, /ChatGPT_Image_Jun_27_2026_06_10_23_PM\.png\?width=2400/);
  assert.match(proxy, /background:#050505/);
  assert.doesNotMatch(proxy, /body:has\(\.customhouse-public-page\) \.customhouse-public-hero\{padding-top/);
  assert.match(proxy, /customhouse-header__nav a\{font-family:Inter/);
  assert.match(proxy, /customhouse-mobile-drawer__nav a,.customhouse-mobile-drawer__account a\{display:grid[^}]*font-weight:800/);
  assert.match(proxy, /@media screen and \(min-width:901px\)\{\.customhouse-header__menu-button\{display:none!important\}/);
  assert.match(proxy, /FooterStrip-customhouse-app/);
  assert.match(proxy, /footer-strip__texture/);
  assert.match(proxy, /#FooterStrip-customhouse-app \.footer-strip__heading,#FooterStrip-customhouse-app \.footer-strip__link\{[^}]*font-family:Inter/);
  assert.match(proxy, /--footer-link-size:17px/);
  assert.match(proxy, /customhouse-mobile-drawer__line-icon/);
  assert.match(proxy, /customhouse-header__profile-menu/);
  assert.match(proxy, /customhouse-header__profile-menu\{[^}]*gap:4px/);
  assert.match(proxy, /customhouse-header__profile-choice\{[^}]*display:grid;gap:6px;[^}]*border-top:1px solid rgb\(255 255 255 \/ \.1\)/);
  assert.match(proxy, /customhouse-header__profile-choice strong\{display:block/);
  assert.match(proxy, /customhouse-header__profile-choice small\{display:block;[^}]*line-height:1\.45/);
  assert.match(proxy, /T-SHIRTS/);
  assert.match(proxy, /HOODIES/);
  assert.match(proxy, /DESIGN SELV/);
  assert.match(proxy, /INSPIRATION/);
  assert.match(proxy, /FÖLJ OSS/);
  assert.match(proxy, /BECOME A CREATOR/);
  assert.match(proxy, /Material\+Symbols\+Outlined/);
  assert.match(proxy, /material-symbols-outlined/);
  assert.match(proxy, /shopping_bag/);
  assert.match(proxy, /workspace_premium/);
  assert.match(proxy, /grid_view/);
  assert.match(proxy, /customhouse-public-service\{display:flex;align-items:center;justify-content:center;text-align:left/);
  assert.match(proxy, /customhouse-public-stat\{display:flex;align-items:center;justify-content:center;text-align:left/);
  assert.match(proxy, /customhouse-public-service-icon\{display:inline-flex;[^}]*background:transparent/);
  assert.match(proxy, /customhouse-public-stat-icon\{display:inline-flex;[^}]*background:transparent/);
  assert.match(proxy, /customhouse-public-service-icon\.material-symbols-outlined\{font-size:1\.9rem\}/);
  assert.match(proxy, /customhouse-public-stat-icon\.material-symbols-outlined\{font-size:1\.8rem\}/);
  assert.match(proxy, /customhouse-product-panel h1\{[^}]*font-size:clamp\(1\.85rem,3\.4vw,3rem\)/);
  assert.match(proxy, /data-customhouse-more-card/);
  assert.match(proxy, /data-customhouse-more-prev/);
  assert.match(proxy, /data-customhouse-more-next/);
  assert.match(proxy, /listPublishedCreatorProductsForHandle/);
  assert.match(proxy, /relatedProducts: related\.products/);
  assert.match(proxy, /customhouse-more__price/);
  assert.match(proxy, /customhouse-more__button/);
  assert.match(proxy, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(proxy, /max-width: 1100px/);
  assert.match(proxy, /\? 3 : 4/);
  assert.match(proxy, /justify-self:center/);
  assert.match(proxy, /width:min\(100%,178px\)/);
  assert.match(proxy, /object-position:center center/);
  assert.match(proxy, /-webkit-line-clamp:2/);
  assert.match(proxy, /relatedBase\.baseProduct\?\.priceRange/);
  assert.doesNotMatch(proxy, /customhouse-more__subtitle/);
  assert.doesNotMatch(proxy, /customhouse-public-breadcrumb/);
  assert.doesNotMatch(proxy, /customhouse-more__rating/);
  assert.doesNotMatch(proxy, /4\.9 \(128\)/);
  assert.doesNotMatch(proxy, /Check out more designs from this creator/);
  assert.match(proxy, /data-customhouse-option-pill/);
  assert.match(proxy, /data-customhouse-qty/);
  assert.match(proxy, /select\.dataset\.optionName/);
  assert.match(proxy, /customhouse-add-button/);
  assert.doesNotMatch(proxy, /customhouse-rating/);
  assert.doesNotMatch(proxy, /\(256 reviews\)/);
  assert.match(proxy, /body: JSON\.stringify\(\{\s*variantId: form\.variantId\.value/s);
  assert.match(products, /legacyResourceId/);
  assert.match(products, /cartId: variant\.legacyResourceId/);
  assert.match(products, /selectedVariantKey/);
  assert.match(products, /PITCHPRINT_PROJECT_MISSING/);
  assert.match(products, /VARIANT_UNAVAILABLE/);
  assert.match(products, /ATTRIBUTION_SIGNING_FAILED/);
  assert.match(products, /signCreatorAttribution/);
  assert.match(products, /_customhouse_attribution/);
  assert.match(products, /_base_variant_id/);
  assert.match(products, /_creator_preview_url/);
  assert.match(products, /creatorCartPreviewUrl/);
  assert.match(products, /preparePitchPrintOrderProject/);
  assert.match(sales, /verifyCreatorAttribution/);
  assert.match(sales, /signedLineOwners\.get/);
  assert.match(attribution, /createHmac\("sha256"/);
});

test("Shopify Ajax cart accepts text/javascript JSON responses", () => {
  const proxy = readFileSync("app/services/storefront-proxy.server.ts", "utf8");
  const raw = JSON.stringify({
    items: [
      {
        id: 58775360045401,
        properties: {
          _creator_product_id: "test-product",
        },
      },
    ],
  });
  const liveShopifyResponse = new Response(
    raw,
    {
      status: 200,
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    },
  );

  assert.equal(liveShopifyResponse.ok, true);
  assert.match(liveShopifyResponse.headers.get("content-type") || "", /text\/javascript/);
  assert.equal(JSON.parse(raw).items[0].id, 58775360045401);
  assert.match(proxy, /readShopifyAjaxResponse/);
  assert.match(proxy, /creatorPreviewPresent/);
  assert.match(proxy, /parsed = raw \? JSON\.parse\(raw\) : null/);
  assert.doesNotMatch(proxy, /SHOPIFY_CART_NON_JSON/);
  assert.match(proxy, /SHOPIFY_CART_INVALID_JSON/);
  assert.match(proxy, /String\(item\?\.id \?\? item\?\.variant_id \?\? ""\) === String\(expectedCartId\)/);
});

test("live theme cart renders creator previews without exposing private properties", () => {
  const cartProducts = readFileSync("theme-live-cart/snippets/cart-products.liquid", "utf8");
  const mainCart = readFileSync("theme-live-cart/sections/main-cart.liquid", "utf8");

  for (const source of [cartProducts, mainCart]) {
    assert.match(source, /item\.properties\['_creator_product_id'\]/);
    assert.match(source, /item\.properties\['_creator_preview_url'\]/);
    assert.match(source, /has_creator_preview/);
    assert.match(source, /creator_product_id != blank and creator_preview_https == 'https:\/\/'/);
    assert.match(source, /onerror="this\.onerror=null;this\.src='/);
    assert.match(source, /property\.first \| slice: 0/);
    assert.match(source, /property_first_char != '_'/);
  }
});


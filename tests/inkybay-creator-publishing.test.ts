import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseCompatibleVariantIds,
  parseInkyBaySavedDesign,
  validateProductionArtwork,
} from "../app/services/inkybay/inkybay-validation.ts";
import {
  signInkyBaySessionToken,
  verifyInkyBaySessionToken,
} from "../app/services/inkybay/inkybay-session-token.server.ts";
import { inkyBayWorkspaceHtml } from "../app/services/inkybay/inkybay-workspace.server.ts";
import { inkyBayProductContract } from "../app/services/inkybay/inkybay-product.server.ts";

process.env.DESIGN_SIGNING_SECRET = "i".repeat(48);

test("saved PitchPrint URL extracts a project ID from an allowlisted HTTPS host", () => {
  assert.deepEqual(
    parseInkyBaySavedDesign({
      savedDesignUrl:
        "https://pitchprint.com/products/shirt?projectId=design_12345#ignored",
      allowedHosts: ["customhouse.se", "pitchprint.com"],
    }),
    {
      savedDesignUrl: "https://pitchprint.com/products/shirt?projectId=design_12345",
      tid: "design_12345",
    },
  );
});

test("saved design validation rejects unsafe hosts, schemes and mismatched tids", () => {
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "http://customhouse.se/design?tid=design_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "https://evil.example/design?tid=design_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "https://customhouse.se/design?tid=design_12345",
      tid: "different_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
});

test("compatible variants are restricted to the verified product variants", () => {
  assert.deepEqual(
    parseCompatibleVariantIds(
      ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/999"],
      ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
    ),
    ["gid://shopify/ProductVariant/1"],
  );
  assert.throws(() =>
    parseCompatibleVariantIds(
      ["gid://shopify/ProductVariant/999"],
      ["gid://shopify/ProductVariant/1"],
    ),
  );
});

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("production artwork accepts high resolution PNG and valid PDF only", () => {
  assert.equal(
    validateProductionArtwork(png(3000, 3000), "art.png", "image/png", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }).mimeType,
    "image/png",
  );
  const pdf = new TextEncoder().encode("%PDF-1.7\ncreator artwork\n%%EOF");
  assert.equal(
    validateProductionArtwork(pdf, "art.pdf", "application/pdf", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }).mimeType,
    "application/pdf",
  );
  assert.throws(() =>
    validateProductionArtwork(png(500, 500), "small.png", "image/png", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }),
  );
  assert.throws(() =>
    validateProductionArtwork(
      new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
      "art.svg",
      "image/svg+xml",
      { maximumBytes: 10_000, minimumWidth: 2000, minimumHeight: 2000 },
    ),
  );
});

test("creator session token is signed, scoped and expiring", () => {
  const token = signInkyBaySessionToken(
    {
      sessionId: "session-a",
      shop: "custom-house.myshopify.com",
      customerId: "gid://shopify/Customer/1",
      creatorId: "creator-a",
    },
    60,
  );
  assert.equal(verifyInkyBaySessionToken(token).sessionId, "session-a");
  assert.throws(() => verifyInkyBaySessionToken(`${token}tampered`));
  assert.throws(() =>
    verifyInkyBaySessionToken(
      signInkyBaySessionToken(
        {
          sessionId: "session-a",
          shop: "custom-house.myshopify.com",
          customerId: "gid://shopify/Customer/1",
          creatorId: "creator-a",
        },
        -1,
      ),
    ),
  );
});

test("workspace requires private production artwork and documents manual bridge", () => {
  const html = inkyBayWorkspaceHtml({
    sessionToken: "safe-token",
    data: {
      id: "session-a",
      status: "WAITING_FOR_ASSETS",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      savedDesignUrl: null,
      tid: null,
      title: null,
      description: null,
      previewUrl: null,
      productionArtworkReady: false,
      compatibleVariantIds: [],
      product: {
        title: "Global T-shirt",
        imageUrl: null,
        selectedVariantId: "gid://shopify/ProductVariant/1",
        inkyBayProductUrl: "/products/global-shirt",
        variants: [
          {
            id: "gid://shopify/ProductVariant/1",
            title: "Small / Black",
            availableForSale: true,
          },
        ],
      },
      creator: { displayName: "Ari", collectionUrl: null },
    },
  });
  assert.match(html, /name="productionArtwork"/);
  assert.match(
    html,
    /manual bridge does not claim an unsupported PitchPrint API/i,
  );
  assert.match(html, /Publish to My Collection/);
  assert.match(html, /X-Customhouse-Session-Token/);
});

test("live product section gates the direct creator action through production proxy", async () => {
  const section = await readFile(
    "theme-source/horizon-live-creator-button/sections/product-information.liquid",
    "utf8",
  );
  const details = await readFile(
    "theme-source/horizon-live-creator-button/blocks/_product-details.liquid",
    "utf8",
  );

  assert.match(section, /data-customhouse-creator-actions/);
  assert.match(section, /data-create-for-collection/);
  assert.match(section, /data-creator-action-message/);
  assert.match(section, /Create for My Collection/);
  assert.match(section, /Creating design session\\u2026/);
  assert.match(
    section,
    /We could not start your creator design\. Please try again\./,
  );
  assert.match(section, /const ENDPOINT = '\/apps\/customhouse\/api\/inkybay'/);
  assert.match(section, /eligibility\?\$\{query\}/);
  assert.match(section, /creator-designs\/start/);
  assert.match(section, /eligibility\?\.creatorPublishAvailable === true/);
  assert.match(section, /eligibility\?\.isApprovedCreator === true/);
  assert.match(section, /eligibility\?\.isSuspendedCreator === false/);
  assert.match(section, /creatorActionsReady/);
  assert.match(section, /creatorActionBound/);
  assert.match(section, /shopify:section:load/);
  assert.match(section, /idempotencyKey: sessionKey\(root\)/);
  assert.match(section, /current_pitchprint_enabled == true/);
  assert.match(section, /current_creator_publishing_enabled == true/);
  assert.match(section, /pitchprint-designlab/);
  assert.match(section, /pitchprint-options/);
  assert.match(section, /creator_fixed/);
  assert.match(section, /creator-fixed/);
  assert.doesNotMatch(section, /customhouse-inkybay-preview/);
  assert.doesNotMatch(section, /localStorage|customerId|logged_in_customer_id/);

  assert.doesNotMatch(details, /Customize this product/);
  assert.doesNotMatch(details, /if is_inkybay_designer_product/);
  assert.doesNotMatch(details, /isPitchPrintDesignerProduct/);
  assert.doesNotMatch(details, /findPitchPrintCustomizeButton/);
  assert.match(details, /data-customhouse-pitchprint-required/);
  assert.match(details, /form \| payment_button/);
  assert.match(details, /data-color-option-value/);
  assert.match(details, /getVariantForOptionValue/);
  assert.match(details, /syncVariantImage\(selectedVariant\)/);
  assert.match(details, /premium:gallery:show/);
  assert.match(details, /option_name_handle contains 'farg'/);
  assert.doesNotMatch(details, /inkybay\.com\/shopify\/js\/inkybay\.js/);
});

test("PitchPrint product contract supports new and legacy tags and always excludes creator-fixed", () => {
  assert.deepEqual(
    inkyBayProductContract({
      productType: "global_customizable",
      inkyBayEnabled: true,
      pitchPrintEnabled: false,
      creatorPublishingEnabled: true,
      tags: [],
    }),
    {
      isCreatorFixed: false,
      isGlobalCustomizable: true,
      creatorPublishingEnabled: true,
    },
  );
  assert.equal(
    inkyBayProductContract({
      productType: null,
      inkyBayEnabled: false,
      pitchPrintEnabled: true,
      creatorPublishingEnabled: true,
      tags: [],
    }).isGlobalCustomizable,
    true,
  );
  assert.equal(
    inkyBayProductContract({
      productType: null,
      inkyBayEnabled: false,
      pitchPrintEnabled: false,
      creatorPublishingEnabled: false,
      tags: ["pitchprint-options"],
    }).creatorPublishingEnabled,
    false,
  );
  assert.equal(
    inkyBayProductContract({
      productType: "creator_fixed",
      inkyBayEnabled: true,
      pitchPrintEnabled: true,
      creatorPublishingEnabled: true,
      tags: ["pitchprint-designlab"],
    }).isGlobalCustomizable,
    false,
  );
  assert.equal(
    inkyBayProductContract({
      productType: "global_customizable",
      inkyBayEnabled: true,
      pitchPrintEnabled: true,
      creatorPublishingEnabled: true,
      tags: ["creator-fixed", "pitchprint-options"],
    }).isGlobalCustomizable,
    false,
  );
});

test("fixed product publishing never exposes private artwork in Shopify metafields", async () => {
  const source = await readFile(
    "app/services/designer-publishing.server.ts",
    "utf8",
  );
  const metafieldSection = source.slice(
    source.indexOf("const metafields ="),
    source.indexOf("const metafieldResult ="),
  );
  assert.match(metafieldSection, /inkybay_saved_design_tid/);
  assert.doesNotMatch(metafieldSection, /productionArtworkKey|artworkUrl/);
  assert.match(source, /status: "DRAFT"/);
  assert.ok(
    source.lastIndexOf('setProductStatus(client, input.productId, "ACTIVE")') >
      source.indexOf("Designer collection membership"),
  );
});

test("creator fixed order snapshots are immutable and retain private artwork mapping", async () => {
  const source = await readFile(
    "app/services/order-design-snapshot.server.ts",
    "utf8",
  );
  assert.match(source, /productionArtworkKey: design\.productionArtworkKey/);
  assert.match(source, /skipDuplicates: true/);
  assert.doesNotMatch(source, /updateMany|upsert/);
});

test("private production artwork supports Vercel Blob without exposing a public URL", async () => {
  const storage = await readFile(
    "app/services/inkybay/private-storage.server.ts",
    "utf8",
  );
  const adminDownload = await readFile(
    "app/routes/app.inkybay.artwork.$designId.tsx",
    "utf8",
  );
  assert.match(storage, /put\(key, Buffer\.from\(input\.bytes\)/);
  assert.match(storage, /access: "private"/);
  assert.match(storage, /useCache: false/);
  assert.match(storage, /kind: "stream"/);
  assert.match(adminDownload, /await authenticate\.admin\(request\)/);
  assert.match(adminDownload, /new Response\(download\.stream/);
  assert.match(adminDownload, /"Cache-Control": "private, no-store"/);
  assert.doesNotMatch(
    adminDownload,
    /productionArtworkKey.*json|json.*productionArtworkKey/i,
  );
});

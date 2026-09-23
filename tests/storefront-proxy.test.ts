import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  collectionShareTargets,
  handleStorefrontProxy,
  parseProxyRoute,
  type ProxyAuthenticator,
} from "../app/services/storefront-proxy.server.ts";

const TEST_SECRET = "test-only-secret";

function signedUrl(
  pathname: string,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    shop: "example.myshopify.com",
    timestamp: "1785000000",
    path_prefix: "/apps/customhouse",
    ...extra,
  });
  const message = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  params.set(
    "signature",
    createHmac("sha256", TEST_SECRET).update(message).digest("hex"),
  );
  return `https://app.example.invalid${pathname}?${params.toString()}`;
}

const verifyTestSignature: ProxyAuthenticator = async (request) => {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("signature");
  if (!supplied) throw new Response(null, { status: 401 });
  url.searchParams.delete("signature");
  const message = [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  const expected = createHmac("sha256", TEST_SECRET)
    .update(message)
    .digest("hex");
  const valid =
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw new Response(null, { status: 403 });
  return {
    shop: url.searchParams.get("shop")!,
    customerId: url.searchParams.get("logged_in_customer_id"),
  };
};

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("base proxy route provides an unsigned production-safe health response", async () => {
  const response = await handleStorefrontProxy(
    new Request("https://app.example.invalid/proxy"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    ok: true,
    success: true,
    message: "Custom House Shopify App Proxy is working",
  });
});

test("catch-all child routes are parsed deterministically", () => {
  assert.deepEqual(parseProxyRoute("creators"), { kind: "creators" });
  assert.deepEqual(parseProxyRoute("creator/john-doe"), {
    kind: "creator",
    creatorHandle: "john-doe",
  });
  assert.deepEqual(parseProxyRoute("creator/john-doe/products/cmabc123456789012345"), {
    kind: "creatorProduct",
    creatorHandle: "john-doe",
    creatorProductId: "cmabc123456789012345",
  });
  assert.deepEqual(parseProxyRoute("creator/john-doe/products/cmabc123456789012345/prepare-cart"), {
    kind: "creatorProductCart",
    creatorHandle: "john-doe",
    creatorProductId: "cmabc123456789012345",
  });
  assert.deepEqual(parseProxyRoute("design/abc123"), {
    kind: "design",
    designSlug: "abc123",
  });
  assert.deepEqual(parseProxyRoute("design/abc123/cart"), {
    kind: "designCart",
    designId: "abc123",
  });
});

test("public collection share targets encode the canonical collection URL", () => {
  const collectionUrl =
    "https://customhouse.se/apps/customhouse/creators/jane-smith?ref=creator&campaign=launch";
  const shareText = "Shop Jane & Co's collection";
  const targets = collectionShareTargets(collectionUrl, shareText);

  assert.equal(new URL(targets.facebook).searchParams.get("u"), collectionUrl);
  assert.equal(new URL(targets.x).searchParams.get("url"), collectionUrl);
  assert.equal(new URL(targets.x).searchParams.get("text"), shareText);
  assert.equal(
    new URL(targets.whatsapp).searchParams.get("text"),
    `${shareText} ${collectionUrl}`,
  );
  assert.equal(new URL(targets.linkedin).searchParams.get("url"), collectionUrl);
});

test("public creator collection exposes basic share controls without Instagram direct posting", () => {
  const source = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(source, /data-customhouse-collection-share/);
  assert.match(source, /Share my collection/);
  assert.match(source, /data-customhouse-share-platform="facebook"/);
  assert.match(source, /data-customhouse-share-platform="x"/);
  assert.match(source, /data-customhouse-share-platform="whatsapp"/);
  assert.match(source, /data-customhouse-share-platform="linkedin"/);
  assert.match(source, /Copy link for Instagram/);
  assert.match(source, /navigator\.share/);
  assert.match(source, /\.customhouse-public-hero\{position:relative;z-index:2;[^}]*overflow:visible/);
  assert.match(source, /\.customhouse-public-share\{position:relative;z-index:40;[^}]*isolation:isolate/);
  assert.match(source, /\.customhouse-public-share-menu\{position:absolute;[^}]*z-index:80/);
  assert.match(source, /\.customhouse-public-share-menu\{position:static;width:100%;margin-top:-\.2rem\}/);
  assert.match(source, /window\.matchMedia\("\(max-width: 760px\)"\)\.matches/);
  assert.match(source, /new URL\(sharePath, window\.location\.origin\)\.href/);
  assert.match(source, /new URLSearchParams/);
  assert.doesNotMatch(source, /instagram\.com\/share|instagram\.com\/intent/i);
});

test("public Creator product page is buy-only with fixed color and fixed printing method", () => {
  const source = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(source, /creatorProductSetupFromRecord/);
  assert.match(source, /customhouse-locked-details/);
  assert.match(source, /<dt>Color<\/dt>/);
  assert.match(source, /<dt>Designed placements<\/dt>/);
  assert.match(source, /name="selectedProductionMethod"/);
  assert.match(source, /<dt>Printing method<\/dt>/);
  assert.match(source, /const sizeControls = optionControls/);
  assert.match(source, /One size/);
  assert.match(source, /aria-label="Size options"/);
  assert.doesNotMatch(source, /data-option-target="selectedProductionMethod"/);
  assert.match(source, /data-customhouse-production-method/);
  assert.match(source, /selectedProductionMethod: productionMethodInput\?\.value \|\| ""/);
  assert.match(source, /nonReturnAcknowledged: Boolean\(form\.nonReturnAcknowledged\?\.checked\)/);
  assert.match(source, /termsAccepted: Boolean\(form\.termsAccepted\?\.checked\)/);
  assert.match(source, /name="nonReturnAcknowledged" type="checkbox" required/);
  assert.match(source, /name="termsAccepted" type="checkbox" required/);
  assert.match(source, /customhouse-made-to-order-note/);
  assert.match(source, /made to order and cannot be returned/);
  assert.match(source, /optionName\.includes\("color"\)/);
  assert.match(source, /optionName\.includes\("production"\)/);
  assert.match(source, /const preparedPayload = prepared\?\.data \|\| prepared/);
  assert.match(source, /const preparedItems = Array\.isArray\(preparedPayload\.items\)/);
  assert.match(source, /preparedPayload\.cartVariantId/);
  assert.match(source, /cart\/add\.js/);
  assert.match(source, /customhouseMinorMoney/);
  assert.match(source, /productionMethods/);
  assert.match(source, /placementCount/);
  assert.doesNotMatch(source, /pitchprint.*showApp\(/i);
});

test("valid Shopify-style signature reaches a protected GET route", async () => {
  const response = await handleStorefrontProxy(
    new Request(signedUrl("/proxy")),
    "",
    verifyTestSignature,
  );
  assert.equal(response.status, 200);
  assert.equal((await json(response)).success, true);
});

test("invalid proxy signature is rejected safely", async () => {
  const url = new URL(signedUrl("/proxy/creators"));
  url.searchParams.set("signature", "invalid");
  const request = new Request(url);
  const response = await handleStorefrontProxy(
    request,
    "creators",
    verifyTestSignature,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), {
    ok: false,
    success: false,
    error: {
      code: "INVALID_PROXY_SIGNATURE",
      message: "The storefront request could not be verified.",
    },
  });
});

test("missing signature is rejected on protected child routes", async () => {
  const response = await handleStorefrontProxy(
    new Request("https://app.example.invalid/proxy/creators"),
    "creators",
  );
  assert.equal(response.status, 401);
  assert.equal(
    ((await json(response)).error as { code: string }).code,
    "MISSING_PROXY_SIGNATURE",
  );
});

test("verified logged-in customer ID is exposed only after authentication", async () => {
  const response = await handleStorefrontProxy(
    new Request(
      signedUrl("/proxy", { logged_in_customer_id: "123456789" }),
    ),
    "",
    verifyTestSignature,
  );
  const body = await json(response);
  assert.deepEqual(body.customer, {
    loggedIn: true,
    customerId: "123456789",
  });
});

test("verified anonymous customer request remains logged out", async () => {
  const response = await handleStorefrontProxy(
    new Request(signedUrl("/proxy")),
    "",
    verifyTestSignature,
  );
  const body = await json(response);
  assert.deepEqual(body.customer, {
    loggedIn: false,
    customerId: null,
  });
});

test("signed POST requests are supported on the base route", async () => {
  const response = await handleStorefrontProxy(
    new Request(signedUrl("/proxy"), { method: "POST" }),
    "",
    verifyTestSignature,
  );
  assert.equal(response.status, 200);
});

test("prepare-cart malformed requests return JSON, never an HTML document", async () => {
  const authenticator: ProxyAuthenticator = async (request) => {
    const context = await verifyTestSignature(request);
    return {
      ...context,
      client: {
        async request() {
          throw new Error("should not reach Shopify for malformed JSON");
        },
      },
    };
  };
  const response = await handleStorefrontProxy(
    new Request(
      signedUrl(
        "/proxy/creators/john-doe/products/cmabc123456789012345/prepare-cart",
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{",
      },
    ),
    "creators/john-doe/products/cmabc123456789012345/prepare-cart",
    authenticator,
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await json(response);
  assert.equal(body.ok, false);
  assert.equal((body.error as { code: string }).code, "INVALID_JSON");
});

test("unsupported methods return a structured 405 response", async () => {
  const response = await handleStorefrontProxy(
    new Request("https://app.example.invalid/proxy", { method: "PUT" }),
  );
  assert.equal(response.status, 405);
  assert.equal(
    ((await json(response)).error as { code: string }).code,
    "METHOD_NOT_ALLOWED",
  );
});

test("safe error responses never expose secrets or stack traces", async () => {
  const leakingAuthenticator: ProxyAuthenticator = async () => {
    throw new Error(
      "DATABASE_URL=postgresql://private Shopify secret access token",
    );
  };
  const response = await handleStorefrontProxy(
    new Request(signedUrl("/proxy/creators")),
    "creators",
    leakingAuthenticator,
  );
  const body = JSON.stringify(await json(response));
  assert.equal(response.status, 500);
  assert.equal(body.includes("postgresql://"), false);
  assert.equal(body.includes("access token"), false);
  assert.equal(body.includes("stack"), false);
});

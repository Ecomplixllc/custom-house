import assert from "node:assert/strict";
import test from "node:test";
import config from "../react-router.config.ts";
import {
  evaluateHealth,
  REQUIRED_ENVIRONMENT_VARIABLES,
} from "../app/services/health.server.ts";
import {
  correlationId,
  observeAuthentication,
} from "../app/services/observability.server.ts";

const configuredEnvironment = Object.fromEntries(
  REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, "configured"]),
);
configuredEnvironment.SHOPIFY_APP_URL = "https://custom-house.vercel.app";

test("Vercel React Router preset keeps SSR enabled", () => {
  assert.equal(config.ssr, true);
  assert.equal(config.presets?.length, 1);
});

test("health succeeds only after a database query succeeds", async () => {
  let queried = false;
  const result = await evaluateHealth(configuredEnvironment, async () => {
    queried = true;
    return [{ "?column?": 1 }];
  });
  assert.equal(queried, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    status: "ok",
    app: "running",
    database: "connected",
  });
});

test("health returns non-200 when Neon is unavailable", async () => {
  const result = await evaluateHealth(configuredEnvironment, async () => {
    throw new Error("database unavailable");
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.database, "unavailable");
  assert.equal(result.body.status, "error");
  if (result.body.status === "error") {
    assert.equal(result.body.code, "DATABASE_UNAVAILABLE");
  }
});

test("health reports missing configuration without exposing values", async () => {
  const result = await evaluateHealth({}, async () => {
    throw new Error("must not run");
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    status: "error",
    app: "running",
    database: "unavailable",
    code: "MISSING_ENVIRONMENT",
  });
});

test("health rejects a malformed production application URL", async () => {
  const result = await evaluateHealth(
    { ...configuredEnvironment, SHOPIFY_APP_URL: "custom-house.vercel.app" },
    async () => 1,
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.status, "error");
  if (result.body.status === "error") {
    assert.equal(result.body.code, "INVALID_APP_URL");
  }
});

test("authentication diagnostics preserve Shopify redirects and errors", async () => {
  const redirect = new Response(null, {
    status: 302,
    headers: { Location: "https://example.invalid/auth" },
  });
  await assert.rejects(
    observeAuthentication(
      "admin_authentication",
      new Request("https://app.example.invalid/app"),
      async () => {
        throw redirect;
      },
    ),
    (error) => error === redirect,
  );
});

test("webhook authentication receives the original raw request", async () => {
  const rawBody = "{\"id\":123,\"topic\":\"customers/create\"}";
  const request = new Request("https://app.example.invalid/webhooks/customers/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  await observeAuthentication("webhook_authentication", request, async () => {
    assert.equal(await request.clone().text(), rawBody);
    return undefined;
  });
  assert.equal(await request.text(), rawBody);
});

test("app proxy authentication preserves verified query parameters", async () => {
  const request = new Request(
    "https://app.example.invalid/proxy/api/me?shop=example.myshopify.com&logged_in_customer_id=123&signature=signed",
  );
  await observeAuthentication("app_proxy_authentication", request, async () => {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get("logged_in_customer_id"), "123");
    assert.equal(url.searchParams.get("signature"), "signed");
    return undefined;
  });
});

test("production validation includes Node and migration configuration", () => {
  assert.equal(REQUIRED_ENVIRONMENT_VARIABLES.includes("NODE_ENV"), true);
  assert.equal(
    REQUIRED_ENVIRONMENT_VARIABLES.includes("DIRECT_DATABASE_URL"),
    true,
  );
});

test("correlation IDs accept safe request IDs and reject unsafe values", () => {
  assert.equal(
    correlationId(
      new Request("https://app.example.invalid", {
        headers: { "x-request-id": "request-12345" },
      }),
    ),
    "request-12345",
  );
  assert.notEqual(
    correlationId(
      new Request("https://app.example.invalid", {
        headers: { "x-request-id": "bad value with spaces" },
      }),
    ),
    "bad value with spaces",
  );
});

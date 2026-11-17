import assert from "node:assert/strict";
import test from "node:test";
import {
  action,
  loader,
} from "../app/routes/api.email.creator-welcome.ts";
import { deliverCreatorWelcomeEmail } from "../app/services/creator-welcome-email-endpoint.server.ts";

const environment = {
  RESEND_API_KEY: "re_test_key",
  CREATOR_EMAIL_FROM: "CustomHouse Creators <creators@customhouse.test>",
  CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET: "welcome-secret",
};

const payload = {
  to: "creator@example.com",
  subject: "Welcome, Creator",
  text: "Open your Creator Dashboard to get started.",
  template: "creator-welcome",
  creatorId: "creator-123",
};

function request(
  method: string,
  options: { authorization?: string; body?: unknown } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.authorization) headers.set("Authorization", options.authorization);
  return new Request("https://custom-house.test/api/email/creator-welcome", {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? payload),
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("creator welcome email endpoint rejects GET and non-POST methods", async () => {
  const getResponse = await loader();
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("Allow"), "POST");

  const putResponse = await deliverCreatorWelcomeEmail(request("PUT"), { environment });
  assert.equal(putResponse.status, 405);
  assert.equal((await responseBody(putResponse)).error, "METHOD_NOT_ALLOWED");
});

test("creator welcome email endpoint rejects a missing webhook secret", async () => {
  const response = await deliverCreatorWelcomeEmail(request("POST"), { environment });
  assert.equal(response.status, 401);
  assert.equal((await responseBody(response)).error, "UNAUTHORIZED");
});

test("creator welcome email endpoint rejects a wrong webhook secret", async () => {
  const response = await deliverCreatorWelcomeEmail(
    request("POST", { authorization: "Bearer wrong-secret" }),
    { environment },
  );
  assert.equal(response.status, 401);
  assert.equal((await responseBody(response)).error, "UNAUTHORIZED");
});

test("creator welcome email endpoint fails safely without RESEND_API_KEY", async () => {
  const response = await deliverCreatorWelcomeEmail(
    request("POST", { authorization: "Bearer welcome-secret" }),
    { environment: { ...environment, RESEND_API_KEY: "" } },
  );
  assert.equal(response.status, 503);
  assert.equal((await responseBody(response)).error, "EMAIL_TRANSPORT_UNCONFIGURED");
});

test("creator welcome email endpoint fails safely without CREATOR_EMAIL_FROM", async () => {
  const response = await deliverCreatorWelcomeEmail(
    request("POST", { authorization: "Bearer welcome-secret" }),
    { environment: { ...environment, CREATOR_EMAIL_FROM: "" } },
  );
  assert.equal(response.status, 503);
  assert.equal((await responseBody(response)).error, "EMAIL_TRANSPORT_UNCONFIGURED");
});

test("valid welcome payload reaches the mocked Resend sender as safe plain text", async () => {
  const calls: unknown[][] = [];
  const sender = {
    async send(...args: unknown[]) {
      calls.push(args);
      return { data: { id: "email_123" }, error: null };
    },
  };
  const response = await deliverCreatorWelcomeEmail(
    request("POST", {
      authorization: "Bearer welcome-secret",
      body: { ...payload, subject: "  Welcome, Creator  ", text: "  Plain text only.  " },
    }),
    { environment, sender },
  );

  assert.equal(response.status, 202);
  assert.equal((await responseBody(response)).emailId, "email_123");
  assert.deepEqual(calls, [
    [
      {
        from: environment.CREATOR_EMAIL_FROM,
        to: payload.to,
        subject: "Welcome, Creator",
        text: "Plain text only.",
      },
      { idempotencyKey: `creator-welcome/${payload.creatorId}` },
    ],
  ]);
});

test("Resend rejection produces a non-success response", async () => {
  const sender = {
    async send() {
      return {
        data: null,
        error: {
          name: "validation_error",
          message: "Sender creators@customhouse.test is not verified; re_secret_must_not_escape",
        },
      };
    },
  };
  const response = await deliverCreatorWelcomeEmail(
    request("POST", { authorization: "Bearer welcome-secret" }),
    { environment, sender },
  );
  const body = await responseBody(response);

  assert.equal(response.status, 502);
  assert.equal(body.error, "EMAIL_DELIVERY_FAILED");
  assert.equal(body.providerErrorCode, "validation_error");
  assert.match(String(body.providerMessage), /not verified/i);
  assert.match(String(body.providerMessage), /\[email@customhouse\.test\]/);
  assert.doesNotMatch(JSON.stringify(body), /creators@customhouse\.test|re_secret/i);
});

test("Resend exceptions return safe structured diagnostics", async () => {
  const sender = {
    async send() {
      throw new Error("Network rejected Authorization: Bearer secret-value");
    },
  };
  const response = await deliverCreatorWelcomeEmail(
    request("POST", { authorization: "Bearer welcome-secret" }),
    { environment, sender },
  );
  const body = await responseBody(response);

  assert.equal(response.status, 502);
  assert.equal(body.providerErrorCode, "provider_exception");
  assert.doesNotMatch(JSON.stringify(body), /secret-value|welcome-secret/);
});

test("route action delegates valid POST delivery without exposing configuration", async () => {
  const response = await action({ request: request("PATCH") } as never);
  assert.equal(response.status, 405);
});

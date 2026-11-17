import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DomainError } from "../app/services/domain.ts";
import { fetchPitchPrintProjectSource } from "../app/services/pitchprint-project-fetch.server.ts";

function withPitchPrintCredentials() {
  const previous = {
    endpoint: process.env.PITCHPRINT_FETCH_PROJECT_ENDPOINT,
    apiKey: process.env.PITCHPRINT_API_KEY,
    secret: process.env.PITCHPRINT_SECRET_KEY,
  };
  process.env.PITCHPRINT_FETCH_PROJECT_ENDPOINT =
    "https://pitchprint.test/fetch-project";
  process.env.PITCHPRINT_API_KEY = "domain-api-key";
  process.env.PITCHPRINT_SECRET_KEY = "server-secret";
  return () => {
    if (previous.endpoint === undefined) {
      delete process.env.PITCHPRINT_FETCH_PROJECT_ENDPOINT;
    } else process.env.PITCHPRINT_FETCH_PROJECT_ENDPOINT = previous.endpoint;
    if (previous.apiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
    else process.env.PITCHPRINT_API_KEY = previous.apiKey;
    if (previous.secret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
    else process.env.PITCHPRINT_SECRET_KEY = previous.secret;
  };
}

test("PitchPrint project fetch signs the documented request and returns bounded source", async () => {
  const restore = withPitchPrintCredentials();
  try {
    const source = await fetchPitchPrintProjectSource(
      "project-123",
      async (url, init) => {
        assert.equal(String(url), "https://pitchprint.test/fetch-project");
        assert.equal(init?.method, "POST");
        assert.ok(init?.signal instanceof AbortSignal);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.apiKey, "domain-api-key");
        assert.equal(body.projectId, "project-123");
        assert.match(body.signature, /^[a-f0-9]{32}$/);
        assert.equal(JSON.stringify(body).includes("server-secret"), false);
        return Response.json({
          data: {
            _id: "project-123",
            designId: "design-123",
            pages: [{ id: "page-1", objects: [] }],
          },
        });
      },
    );
    assert.equal(source._id, "project-123");
    assert.equal((source.pages as unknown[]).length, 1);
  } finally {
    restore();
  }
});

test("PitchPrint project fetch rejects mismatched or malformed source safely", async () => {
  const restore = withPitchPrintCredentials();
  try {
    await assert.rejects(
      () =>
        fetchPitchPrintProjectSource("project-123", async () =>
          Response.json({
            data: { _id: "different-project", pages: [{ id: "page-1" }] },
          }),
        ),
      (error) =>
        error instanceof DomainError &&
        error.code === "PITCHPRINT_PROJECT_FETCH_FAILED" &&
        error.status === 502,
    );
    await assert.rejects(
      () =>
        fetchPitchPrintProjectSource("project-123", async () =>
          Response.json({ data: { _id: "project-123", pages: [] } }),
        ),
      /couldn't load your saved design/i,
    );
  } finally {
    restore();
  }
});

test("PitchPrint project fetch reports an unavailable saved project for recovery", async () => {
  const restore = withPitchPrintCredentials();
  try {
    await assert.rejects(
      () =>
        fetchPitchPrintProjectSource("project-123", async () =>
          Response.json({
            error: true,
            message: "Project does not exist",
          }),
        ),
      (error) =>
        error instanceof DomainError &&
        error.code === "PITCHPRINT_PROJECT_UNAVAILABLE" &&
        error.status === 410 &&
        error.message === "This saved design is no longer available in PitchPrint.",
    );
  } finally {
    restore();
  }
});

test("PitchPrint project fetch requires server-only credentials", async () => {
  const previousApiKey = process.env.PITCHPRINT_API_KEY;
  const previousSecret = process.env.PITCHPRINT_SECRET_KEY;
  delete process.env.PITCHPRINT_API_KEY;
  delete process.env.PITCHPRINT_SECRET_KEY;
  try {
    await assert.rejects(
      () => fetchPitchPrintProjectSource("project-123"),
      (error) =>
        error instanceof DomainError &&
        error.code === "PITCHPRINT_NOT_CONFIGURED" &&
        error.status === 503,
    );
  } finally {
    if (previousApiKey === undefined) delete process.env.PITCHPRINT_API_KEY;
    else process.env.PITCHPRINT_API_KEY = previousApiKey;
    if (previousSecret === undefined) delete process.env.PITCHPRINT_SECRET_KEY;
    else process.env.PITCHPRINT_SECRET_KEY = previousSecret;
  }
});

test("saved-project source route authenticates the app proxy and scopes access to its customer", async () => {
  const route = await readFile(
    new URL(
      "../app/routes/proxy.api.creator-products.$id.pitchprint-project.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(route, /const context = await proxyContext\(request\)/);
  assert.match(
    route,
    /getCreatorProductForCustomer\(\s*context\.shop,\s*context\.customerId!,/,
  );
  assert.match(
    route,
    /fetchPitchPrintProjectSource\(\s*product\.pitchprintProjectId/,
  );
  assert.match(
    route,
    /assertPitchPrintProjectOwner\(\s*context\.shop,\s*product\.creatorId,\s*source/,
  );
  assert.doesNotMatch(route, /request\.(?:json|formData)\(/);
  assert.doesNotMatch(route, /PITCHPRINT_(?:SECRET_KEY|API_SECRET)/);
});

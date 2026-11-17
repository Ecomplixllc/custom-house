import { createHash } from "node:crypto";
import { DomainError } from "./domain.ts";

const MAX_PROJECT_SOURCE_BYTES = 8 * 1024 * 1024;

function cleanProjectId(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(trimmed) ? trimmed : "";
}

function fetchProjectEndpoint() {
  return (
    String(process.env.PITCHPRINT_FETCH_PROJECT_ENDPOINT || "").trim() ||
    "https://api.pitchprint.io/runtime/fetch-project"
  );
}

function runtimeCredentials() {
  return {
    apiKey: String(process.env.PITCHPRINT_API_KEY || "").trim(),
    secret: String(
      process.env.PITCHPRINT_SECRET_KEY ||
        process.env.PITCHPRINT_API_SECRET ||
        "",
    ).trim(),
  };
}

function fetchTimeoutMs() {
  const configured = Number(process.env.PITCHPRINT_FETCH_PROJECT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 8000;
  return Math.min(Math.max(Math.round(configured), 1000), 15000);
}

function projectFetchError(
  stage: string,
  details: Record<string, string | number | boolean> = {},
) {
  console.error("pitchprint_project_fetch_failed", { stage, ...details });
  return new DomainError(
    "PITCHPRINT_PROJECT_FETCH_FAILED",
    "We couldn't load your saved design. Please try again.",
    502,
  );
}

function projectUnavailableError() {
  console.warn("pitchprint_project_fetch_failed", {
    stage: "invalid_source",
    errorCategory: "project_unavailable",
  });
  return new DomainError(
    "PITCHPRINT_PROJECT_UNAVAILABLE",
    "This saved design is no longer available in PitchPrint.",
    410,
  );
}

function classifyUpstreamMessage(value: unknown) {
  const message = typeof value === "string" ? value.toLowerCase() : "";
  if (!message) return "missing";
  if (/api\s*key|signature|secret|auth|credential/.test(message))
    return "authentication";
  if (
    /project/.test(message) &&
    /not\s+found|missing|invalid|exist/.test(message)
  ) {
    return "project_unavailable";
  }
  if (/rate|limit|too many/.test(message)) return "rate_limited";
  if (/parameter|payload|request|required/.test(message))
    return "invalid_request";
  return "unknown";
}

export async function fetchPitchPrintProjectSource(
  projectIdInput: unknown,
  fetchImpl: typeof fetch = fetch,
) {
  const projectId = cleanProjectId(projectIdInput);
  if (!projectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_INVALID",
      "This saved design is not ready to edit.",
      409,
    );
  }

  const endpoint = fetchProjectEndpoint();
  const { apiKey, secret } = runtimeCredentials();
  if (!apiKey || !secret) {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "Saved-design editing is not configured.",
      503,
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "Saved-design editing is not configured.",
      503,
    );
  }
  if (url.protocol !== "https:") {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "Saved-design editing requires a secure PitchPrint endpoint.",
      503,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("md5")
    .update(`${apiKey}${secret}${timestamp}`)
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs());

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, timestamp, signature, projectId }),
      signal: controller.signal,
    });
  } catch {
    throw projectFetchError("request_failed");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw projectFetchError("upstream_status", { status: response.status });
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROJECT_SOURCE_BYTES
  ) {
    throw projectFetchError("declared_size", { declaredLength });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw projectFetchError("response_read_failed");
  }
  if (!text || Buffer.byteLength(text, "utf8") > MAX_PROJECT_SOURCE_BYTES) {
    throw projectFetchError("response_size", {
      empty: !text,
      bytes: Buffer.byteLength(text || "", "utf8"),
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw projectFetchError("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw projectFetchError("invalid_body");
  }
  const source = (body as Record<string, unknown>).data;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    const record = body as Record<string, unknown>;
    const errorValue = record.error;
    const errorCategory = classifyUpstreamMessage(record.message);
    if (errorCategory === "project_unavailable") {
      throw projectUnavailableError();
    }
    throw projectFetchError("invalid_source", {
      bodyKeys: Object.keys(record).sort().slice(0, 10).join(","),
      dataType: Array.isArray(source) ? "array" : typeof source,
      hasError: Boolean(errorValue),
      errorType: Array.isArray(errorValue) ? "array" : typeof errorValue,
      errorCategory,
    });
  }
  const project = source as Record<string, unknown>;
  const returnedProjectId = cleanProjectId(project._id || project.projectId);
  if (returnedProjectId && returnedProjectId !== projectId) {
    throw projectFetchError("project_mismatch");
  }
  if (
    !Array.isArray(project.pages) ||
    project.pages.length < 1 ||
    project.pages.length > 50
  ) {
    throw projectFetchError("invalid_pages", {
      pageCount: Array.isArray(project.pages) ? project.pages.length : -1,
    });
  }

  return project;
}

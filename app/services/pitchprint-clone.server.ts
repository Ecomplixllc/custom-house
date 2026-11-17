import { DomainError } from "./domain.ts";
import { createHash } from "node:crypto";

export type PitchPrintProjectCloner = (
  masterProjectId: string,
) => Promise<string>;

function cleanProjectId(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(trimmed) ? trimmed : "";
}

function cloneEndpoint() {
  return (
    String(process.env.PITCHPRINT_CLONE_ENDPOINT || "").trim() ||
    "https://api.pitchprint.io/runtime/clone-project"
  );
}

function cloneApiKey() {
  return String(process.env.PITCHPRINT_API_KEY || "").trim();
}

function cloneSecret() {
  return String(
    process.env.PITCHPRINT_SECRET_KEY ||
      process.env.PITCHPRINT_API_SECRET ||
      "",
  ).trim();
}

function cloneTimeoutMs() {
  const configured = Number(process.env.PITCHPRINT_CLONE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 6500;
  return Math.min(Math.max(Math.round(configured), 1000), 15000);
}

export async function clonePitchPrintProject(
  masterProjectId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const projectId = cleanProjectId(masterProjectId);
  if (!projectId) {
    throw new DomainError(
      "PITCHPRINT_PROJECT_INVALID",
      "The creator design is not ready for purchase.",
      409,
    );
  }
  const endpoint = cloneEndpoint();
  const apiKey = cloneApiKey();
  const secret = cloneSecret();
  if (!apiKey || !secret) {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "Creator design purchasing needs PitchPrint clone credentials configured server-side.",
      503,
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "Creator design purchasing needs a valid PitchPrint clone endpoint.",
      503,
    );
  }
  if (url.protocol !== "https:") {
    throw new DomainError(
      "PITCHPRINT_NOT_CONFIGURED",
      "PitchPrint clone endpoint must use HTTPS.",
      503,
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("md5")
    .update(`${apiKey}${secret}${timestamp}`)
    .digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cloneTimeoutMs());
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey, timestamp, signature, projectId }),
      signal: controller.signal,
    });
  } catch {
    console.error("pitchprint_clone_failed", {
      status: "request_failed",
      projectId,
    });
    throw new DomainError(
      "PITCHPRINT_CLONE_FAILED",
      "Unable to prepare this design for purchase.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    console.error("pitchprint_clone_failed", {
      status: response.status,
      projectId,
    });
    throw new DomainError(
      "PITCHPRINT_CLONE_FAILED",
      "Unable to prepare this design for purchase.",
      502,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new DomainError(
      "PITCHPRINT_CLONE_FAILED",
      "Unable to prepare this design for purchase.",
      502,
    );
  }
  const cloned =
    cleanProjectId(body.newId) ||
    cleanProjectId(body.clonedProjectId) ||
    cleanProjectId(body.projectId) ||
    cleanProjectId(body.id);
  if (!cloned || cloned === projectId) {
    throw new DomainError(
      "PITCHPRINT_CLONE_FAILED",
      "PitchPrint did not return an order-specific design.",
      502,
    );
  }
  return cloned;
}

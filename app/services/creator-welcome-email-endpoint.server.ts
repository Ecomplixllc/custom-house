import { timingSafeEqual } from "node:crypto";
import { Resend } from "resend";
import { cleanWelcomeEmailContent } from "./creator-welcome-email.server.ts";

type WelcomeEmailEnvironment = Record<string, string | undefined>;

type WelcomeEmailSender = {
  send(
    payload: {
      from: string;
      to: string;
      subject: string;
      text: string;
    },
    options: { idempotencyKey: string },
  ): Promise<{
    data: { id: string } | null;
    error: { name?: string; message?: string } | null;
  }>;
};

type CreatorWelcomeEmailEndpointOptions = {
  environment?: WelcomeEmailEnvironment;
  sender?: WelcomeEmailSender;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body: Record<string, unknown>, status: number, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export function creatorWelcomeEmailMethodNotAllowed() {
  return jsonResponse(
    { ok: false, error: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." },
    405,
    { Allow: "POST" },
  );
}

function safeSecretEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function bearerSecret(request: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  return match?.[1]?.trim() || "";
}

function senderEmail(value: string) {
  const displayNameMatch = /<([^<>]+)>\s*$/.exec(value);
  return (displayNameMatch?.[1] || value).trim();
}

function recipientDomain(value: string) {
  return value.split("@").at(-1)?.toLowerCase() || "unavailable";
}

function safeProviderErrorCode(value: unknown, fallback = "provider_rejected") {
  const code = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .slice(0, 100);
  return code || fallback;
}

function safeProviderMessage(value: unknown) {
  const message = String(value || "Resend did not accept the email.")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bre_[a-z0-9_-]+\b/gi, "[REDACTED_API_KEY]")
    .replace(
      /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+\.[a-z]{2,})/gi,
      (_email, domain: string) => `[email@${domain.toLowerCase()}]`,
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return message || "Resend did not accept the email.";
}

function providerFailureResponse(
  creatorId: string,
  to: string,
  error: { name?: string; message?: string } | Error | null,
  fallbackCode = "provider_rejected",
) {
  const providerErrorCode = safeProviderErrorCode(
    "name" in (error || {}) ? error?.name : undefined,
    fallbackCode,
  );
  const providerMessage = safeProviderMessage(error?.message);
  console.error("creator_welcome_email_resend_failed", {
    creatorId,
    recipientDomain: recipientDomain(to),
    providerErrorCode,
    providerMessage,
  });
  return jsonResponse(
    {
      ok: false,
      error: "EMAIL_DELIVERY_FAILED",
      message: "Resend did not accept the email.",
      providerErrorCode,
      providerMessage,
    },
    502,
  );
}

export async function deliverCreatorWelcomeEmail(
  request: Request,
  options: CreatorWelcomeEmailEndpointOptions = {},
) {
  if (request.method.toUpperCase() !== "POST") return creatorWelcomeEmailMethodNotAllowed();

  const environment = options.environment || process.env;
  const expectedSecret = String(environment.CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET || "").trim();
  if (!expectedSecret) {
    return jsonResponse(
      { ok: false, error: "EMAIL_TRANSPORT_UNCONFIGURED", message: "Email delivery is not configured." },
      503,
    );
  }
  const providedSecret = bearerSecret(request);
  if (!providedSecret || !safeSecretEqual(providedSecret, expectedSecret)) {
    return jsonResponse(
      { ok: false, error: "UNAUTHORIZED", message: "Webhook authentication failed." },
      401,
    );
  }

  const apiKey = String(environment.RESEND_API_KEY || "").trim();
  const from = String(environment.CREATOR_EMAIL_FROM || "").trim();
  if (!apiKey || !from || !EMAIL_PATTERN.test(senderEmail(from))) {
    return jsonResponse(
      { ok: false, error: "EMAIL_TRANSPORT_UNCONFIGURED", message: "Email delivery is not configured." },
      503,
    );
  }

  let input: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payload");
    input = value as Record<string, unknown>;
  } catch {
    return jsonResponse(
      { ok: false, error: "INVALID_PAYLOAD", message: "Provide a valid JSON payload." },
      400,
    );
  }

  const to = String(input.to || "").trim();
  const creatorId = String(input.creatorId || "").trim();
  if (
    !EMAIL_PATTERN.test(to) ||
    input.template !== "creator-welcome" ||
    !creatorId ||
    creatorId.length > 200
  ) {
    return jsonResponse(
      { ok: false, error: "INVALID_PAYLOAD", message: "Welcome email payload is invalid." },
      400,
    );
  }

  let content: { subject: string; body: string };
  try {
    content = cleanWelcomeEmailContent(input.subject, input.text);
  } catch {
    return jsonResponse(
      { ok: false, error: "INVALID_PAYLOAD", message: "Welcome email content is invalid." },
      400,
    );
  }

  const sender = options.sender || new Resend(apiKey).emails;
  console.info("creator_welcome_email_webhook_entered", {
    creatorId,
    recipientDomain: recipientDomain(to),
  });
  try {
    const result = await sender.send(
      { from, to, subject: content.subject, text: content.body },
      { idempotencyKey: `creator-welcome/${creatorId}` },
    );
    if (result.error || !result.data?.id) {
      return providerFailureResponse(creatorId, to, result.error, "missing_provider_email_id");
    }
    console.info("creator_welcome_email_resend_accepted", {
      creatorId,
      recipientDomain: recipientDomain(to),
      emailId: result.data.id,
    });
    return jsonResponse({ ok: true, emailId: result.data.id }, 202);
  } catch (error) {
    return providerFailureResponse(
      creatorId,
      to,
      error instanceof Error ? { message: error.message } : null,
      "provider_exception",
    );
  }
}

import db from "../db.server.ts";
import { safeJson } from "./domain.ts";

type WelcomeEmailCreator = {
  id: string;
  status: string;
  displayName: string;
  emailSnapshot: string | null;
  welcomeEmailSentAt: Date | null;
};

type WelcomeEmailDatabase = {
  creator: {
    findFirst(args: unknown): Promise<WelcomeEmailCreator | null>;
    update(args: unknown): unknown;
  };
  shopConfig: {
    upsert(args: unknown): Promise<{
      creatorWelcomeEmailSubject: string;
      creatorWelcomeEmailBody: string;
    }>;
  };
  auditLog: {
    create(args: unknown): unknown;
  };
  $transaction(operations: unknown[]): Promise<unknown>;
};

type WelcomeEmailOptions = {
  database?: WelcomeEmailDatabase;
  fetcher?: typeof fetch;
  endpoint?: string;
  secret?: string;
};

type WelcomeEmailEnvironment = Record<string, string | undefined>;

type WelcomeEmailWebhookBody = {
  ok?: boolean;
  emailId?: string;
  error?: string;
  message?: string;
  providerErrorCode?: string;
  providerMessage?: string;
};

export const CREATOR_WELCOME_EMAIL_ENVIRONMENT_KEYS = [
  "RESEND_API_KEY",
  "CREATOR_EMAIL_FROM",
  "CREATOR_WELCOME_EMAIL_WEBHOOK_URL",
  "CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET",
] as const;

export const DEFAULT_CREATOR_WELCOME_SUBJECT = "Welcome to CustomHouse Creator";
export const DEFAULT_CREATOR_WELCOME_BODY = `Welcome to CustomHouse Creator, {{creator_name}}!

Next steps:
1. Open your Creator Dashboard: {{dashboard_url}}
2. Complete your profile and collection banner.
3. Create your first product by choosing one color and one printing method.

Tips & tricks: use a clear product title, preview every placement, and submit only artwork you have the rights to use.`;

export function cleanWelcomeEmailContent(subject: unknown, body: unknown) {
  const clean = (value: unknown, limit: number) =>
    Array.from(String(value || ""))
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      })
      .join("")
      .trim()
      .slice(0, limit);
  const cleanSubject = clean(subject, 200);
  const cleanBody = clean(body, 10000);
  if (!cleanSubject || !cleanBody) throw new Error("Welcome email subject and body are required.");
  return { subject: cleanSubject, body: cleanBody };
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(creator_name|dashboard_url)\}\}/g, (_match, key: string) => values[key] || "");
}

function isHttpsEndpoint(value: unknown) {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function safeDeliveryCode(value: unknown, fallback: string) {
  const code = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 100);
  return code || fallback;
}

function safeDeliveryMessage(value: unknown, fallback: string) {
  const message = String(value || fallback)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bre_[a-z0-9_-]+\b/gi, "[REDACTED_API_KEY]")
    .replace(
      /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+\.[a-z]{2,})/gi,
      (_email, domain: string) => `[email@${domain.toLowerCase()}]`,
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return message || fallback;
}

async function welcomeEmailWebhookBody(response: Response) {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as WelcomeEmailWebhookBody;
  } catch {
    return null;
  }
}

export function creatorWelcomeEmailTransportStatus(
  environment: WelcomeEmailEnvironment = process.env,
) {
  const missing = CREATOR_WELCOME_EMAIL_ENVIRONMENT_KEYS.filter((key) => {
    const value = String(environment[key] || "").trim();
    if (key === "CREATOR_WELCOME_EMAIL_WEBHOOK_URL") return !isHttpsEndpoint(value);
    return !value;
  });
  return { configured: missing.length === 0, missing };
}

export function creatorWelcomeEmailTransportConfigured(
  environment: WelcomeEmailEnvironment = process.env,
) {
  return creatorWelcomeEmailTransportStatus(environment).configured;
}

export function canSendCreatorWelcomeEmail(
  creator: Pick<WelcomeEmailCreator, "status" | "welcomeEmailSentAt">,
) {
  return creator.status === "APPROVED" && !creator.welcomeEmailSentAt;
}

export async function sendCreatorWelcomeEmail(
  shop: string,
  creatorId: string,
  options: WelcomeEmailOptions = {},
) {
  const database = options.database || (db as unknown as WelcomeEmailDatabase);
  const fetcher = options.fetcher || fetch;
  const creator = await database.creator.findFirst({ where: { id: creatorId, shop } });
  if (!creator || !canSendCreatorWelcomeEmail(creator)) {
    return { sent: false as const, reason: "not-eligible" as const };
  }
  const config = await database.shopConfig.upsert({ where: { shop }, update: {}, create: { shop } });
  const recipient = String(creator.emailSnapshot || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false as const, reason: "email-unavailable" as const };
  }
  const endpoint = String(
    options.endpoint ?? process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_URL ?? "",
  ).trim();
  const secret = String(
    options.secret ?? process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET ?? "",
  ).trim();
  if (!isHttpsEndpoint(endpoint) || !secret) {
    await database.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.pending_configuration",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ recipientAvailable: true }),
      },
    });
    return { sent: false as const, reason: "transport-unconfigured" as const };
  }
  const values = { creator_name: creator.displayName, dashboard_url: `https://${shop}/pages/creator-dashboard` };
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        to: recipient,
        subject: renderTemplate(config.creatorWelcomeEmailSubject, values),
        text: renderTemplate(config.creatorWelcomeEmailBody, values),
        template: "creator-welcome",
        creatorId: creator.id,
      }),
    });
    const responseBody = await welcomeEmailWebhookBody(response);
    const emailId = String(responseBody?.emailId || "").trim();
    if (!response.ok || !emailId) {
      const httpStatus = response.status;
      const errorCode = safeDeliveryCode(
        responseBody?.providerErrorCode || responseBody?.error,
        response.ok ? "MISSING_PROVIDER_EMAIL_ID" : "WEBHOOK_DELIVERY_FAILED",
      );
      const message = safeDeliveryMessage(
        responseBody?.providerMessage || responseBody?.message,
        response.ok
          ? "The email provider did not return an accepted email ID."
          : "The welcome email webhook rejected delivery.",
      );
      console.error("creator_welcome_email_delivery_failed", {
        creatorId: creator.id,
        recipientDomain: recipient.split("@").at(-1)?.toLowerCase() || "unavailable",
        httpStatus,
        errorCode,
        message,
      });
      await database.auditLog.create({
        data: {
          shop,
          actorType: "SYSTEM",
          action: "creator.welcome_email.delivery_failed",
          entityType: "Creator",
          entityId: creator.id,
          afterJson: safeJson({ retryable: true, httpStatus, errorCode, message }),
        },
      });
      return {
        sent: false as const,
        reason: "delivery-failed" as const,
        httpStatus,
        errorCode,
      };
    }
    const sentAt = new Date();
    await database.$transaction([
      database.creator.update({ where: { id: creator.id }, data: { welcomeEmailSentAt: sentAt } }),
      database.auditLog.create({
        data: {
          shop,
          actorType: "SYSTEM",
          action: "creator.welcome_email.sent",
          entityType: "Creator",
          entityId: creator.id,
          afterJson: safeJson({ sentAt, emailId }),
        },
      }),
    ]);
    console.info("creator_welcome_email_delivery_succeeded", {
      creatorId: creator.id,
      recipientDomain: recipient.split("@").at(-1)?.toLowerCase() || "unavailable",
      httpStatus: response.status,
      emailId,
    });
    return { sent: true as const, sentAt, emailId };
  } catch (error) {
    const errorCode = "WEBHOOK_REQUEST_FAILED";
    const message = safeDeliveryMessage(
      error instanceof Error ? error.message : undefined,
      "The welcome email webhook request failed.",
    );
    console.error("creator_welcome_email_delivery_failed", {
      creatorId: creator.id,
      recipientDomain: recipient.split("@").at(-1)?.toLowerCase() || "unavailable",
      httpStatus: null,
      errorCode,
      message,
    });
    await database.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.delivery_failed",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ retryable: true, httpStatus: null, errorCode, message }),
      },
    });
    return {
      sent: false as const,
      reason: "delivery-failed" as const,
      httpStatus: null,
      errorCode,
    };
  }
}

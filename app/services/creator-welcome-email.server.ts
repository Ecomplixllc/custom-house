import db from "../db.server.ts";
import { safeJson } from "./domain.ts";

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

export async function sendCreatorWelcomeEmail(shop: string, creatorId: string) {
  const creator = await db.creator.findFirst({ where: { id: creatorId, shop } });
  if (!creator || creator.status !== "APPROVED" || creator.welcomeEmailSentAt) return { sent: false, reason: "not-eligible" };
  const config = await db.shopConfig.upsert({ where: { shop }, update: {}, create: { shop } });
  const recipient = String(creator.emailSnapshot || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return { sent: false, reason: "email-unavailable" };
  const endpoint = String(process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_URL || "").trim();
  if (!endpoint.startsWith("https://")) {
    await db.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.pending_configuration",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ recipientAvailable: true }),
      },
    });
    return { sent: false, reason: "transport-unconfigured" };
  }
  const values = { creator_name: creator.displayName, dashboard_url: `https://${shop}/pages/creator-dashboard` };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_TOKEN
        ? { Authorization: `Bearer ${process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      to: recipient,
      subject: renderTemplate(config.creatorWelcomeEmailSubject, values),
      text: renderTemplate(config.creatorWelcomeEmailBody, values),
      template: "creator-welcome",
      creatorId: creator.id,
    }),
  });
  if (!response.ok) throw new Error("Creator welcome email delivery failed.");
  const sentAt = new Date();
  await db.$transaction([
    db.creator.update({ where: { id: creator.id }, data: { welcomeEmailSentAt: sentAt } }),
    db.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.sent",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ sentAt }),
      },
    }),
  ]);
  return { sent: true, sentAt };
}

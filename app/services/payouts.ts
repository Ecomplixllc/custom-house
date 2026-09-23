import crypto from "node:crypto";
import { PayoutMethodType } from "@prisma/client";
import { DomainError } from "./domain";

const ENCRYPTION_VERSION = "v1";

export type PayoutDetails = Record<string, string | null>;

function encryptionKey() {
  const raw = process.env.PAYOUT_ENCRYPTION_KEY;
  if (!raw) {
    throw new DomainError(
      "PAYOUT_ENCRYPTION_NOT_CONFIGURED",
      "Payout encryption is not configured.",
      503,
    );
  }
  const normalized = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) {
    throw new DomainError(
      "PAYOUT_ENCRYPTION_INVALID",
      "Payout encryption key is invalid.",
      503,
    );
  }
  return key;
}

export function encryptPayoutDetails(details: PayoutDetails) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(details), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptPayoutDetails(payload: string): PayoutDetails {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split(":");
  if (version !== ENCRYPTION_VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new DomainError("PAYOUT_DETAILS_INVALID", "Payout details are invalid.", 500);
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as PayoutDetails)
    : {};
}

export function cleanPayoutString(value: unknown, maxLength = 255) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parsePayoutAmountMinor(value: unknown) {
  const normalized = cleanPayoutString(value, 40);
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new DomainError("INVALID_PAYOUT_AMOUNT", "Enter a valid payout amount.");
  }
  const [major, cents = ""] = normalized.split(".");
  const amount = BigInt(major) * 100n + BigInt(cents.padEnd(2, "0"));
  if (amount <= 0n) {
    throw new DomainError("INVALID_PAYOUT_AMOUNT", "Payout amount must be greater than zero.");
  }
  return amount;
}

function emailMask(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return "PayPal account";
  return `${name[0] || "*"}***@${domain}`;
}

function lastFour(value: string) {
  const compact = value.replace(/\s+/g, "");
  return compact.slice(-4);
}

export function maskPayoutDetails(type: PayoutMethodType, details: PayoutDetails) {
  if (type === PayoutMethodType.PAYPAL) {
    const email = cleanPayoutString(details.paypalEmail).toLowerCase();
    return email ? emailMask(email) : "PayPal account";
  }
  const iban = cleanPayoutString(details.iban);
  if (iban) return `IBAN ****${lastFour(iban)}`;
  const accountNumber = cleanPayoutString(details.accountNumber);
  if (accountNumber) return `Bank ****${lastFour(accountNumber)}`;
  return "Bank transfer";
}

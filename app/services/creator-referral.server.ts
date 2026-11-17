import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type CreatorStatus } from "@prisma/client";
import db from "../db.server.ts";

const MAX_REFERRAL_CODE_LENGTH = 100;
export const PENDING_REFERRAL_COOKIE = "customhouse_referral_pending";
export const PENDING_REFERRAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const PENDING_REFERRAL_TTL_MS = PENDING_REFERRAL_TTL_SECONDS * 1000;
const PENDING_REFERRAL_TOKEN_VERSION = 1;

export type ReferralCodeFields = {
  referralCode: string;
  referralCodeNormalized: string;
};

export type ResolvedReferralCode = {
  creatorId: string;
  referralCode: string;
  creatorStatus: CreatorStatus;
  displayName: string;
};

export type PendingReferralPayload = {
  version: typeof PENDING_REFERRAL_TOKEN_VERSION;
  shop: string;
  referrerCreatorId: string;
  referralCodeSnapshot: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type PendingReferralResult =
  | {
      status: "RESOLVED";
      token: string;
      referralCode: string;
      expiresAt: string;
      maxAgeSeconds: number;
    }
  | { status: "PENDING_EXISTS" }
  | { status: "INVALID_CODE" | "NOT_FOUND" | "INELIGIBLE" };

export type ReferralClaimStatus =
  | "CLAIMED"
  | "ALREADY_ATTRIBUTED"
  | "EXISTING_CREATOR"
  | "SELF_REFERRAL"
  | "NOT_LOGGED_IN"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "REFERRER_INVALID"
  | "SHOP_MISMATCH";

type CreatorReferralDatabase = {
  creator: {
    findFirst(args: unknown): Promise<{
      id: string;
      referralCode: string;
      status: CreatorStatus;
      displayName: string;
      customerId?: string;
    } | null>;
    findUnique?(args: unknown): Promise<{
      id: string;
      shop?: string;
      customerId?: string;
      status?: CreatorStatus;
      referralCode?: string;
    } | null>;
    update?(args: unknown): Promise<{
      id: string;
      referralCode: string;
      referralCodeNormalized: string;
    }>;
  };
  referralAttribution?: {
    findUnique(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
};

function referralSecret() {
  const secret =
    process.env.CUSTOMHOUSE_REFERRAL_SECRET ||
    process.env.CUSTOMHOUSE_ATTRIBUTION_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    process.env.SESSION_SECRET ||
    "";
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") {
    return "customhouse-dev-referral-secret";
  }
  throw new Error("CUSTOMHOUSE_REFERRAL_SECRET is required.");
}

function encodeTokenBody(value: PendingReferralPayload) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeTokenBody(value: string): PendingReferralPayload {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function tokenSignature(body: string) {
  return createHmac("sha256", referralSecret()).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function diagnostic(event: string, details: Record<string, unknown>) {
  console.info(event, details);
}

function decodeReferralCode(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function normalizeReferralCodeForLookup(code: string) {
  const decoded = decodeReferralCode(String(code || "")).trim();
  if (!decoded || decoded.length > MAX_REFERRAL_CODE_LENGTH) return null;
  if (hasControlCharacter(decoded)) return null;
  return decoded.toLowerCase();
}

function normalizeCustomerGidForReferral(customerId: string) {
  const value = String(customerId || "").trim();
  if (!value) return "";
  if (value.startsWith("gid://shopify/Customer/")) return value;
  return `gid://shopify/Customer/${value}`;
}

export function referralFieldsForCode(code: string): ReferralCodeFields {
  const normalized = normalizeReferralCodeForLookup(code);
  if (!normalized) {
    throw new Error("Referral code is empty or invalid.");
  }
  return {
    referralCode: decodeReferralCode(String(code)).trim(),
    referralCodeNormalized: normalized,
  };
}

export function signPendingReferralToken(payload: PendingReferralPayload) {
  const body = encodeTokenBody(payload);
  return `${body}.${tokenSignature(body)}`;
}

export function verifyPendingReferralToken(
  token: string,
  now = Date.now(),
):
  | { ok: true; payload: PendingReferralPayload }
  | { ok: false; reason: "TOKEN_INVALID" | "TOKEN_EXPIRED" } {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "TOKEN_INVALID" };
  }
  const [body, signature] = parts;
  if (!body || !signature) {
    return { ok: false, reason: "TOKEN_INVALID" };
  }
  const expectedSignature = tokenSignature(body);
  if (!safeEqual(expectedSignature, signature)) {
    return { ok: false, reason: "TOKEN_INVALID" };
  }
  try {
    const payload = decodeTokenBody(body);
    if (
      payload.version !== PENDING_REFERRAL_TOKEN_VERSION ||
      !payload.shop ||
      !payload.referrerCreatorId ||
      !payload.referralCodeSnapshot ||
      !payload.expiresAt
    ) {
      return { ok: false, reason: "TOKEN_INVALID" };
    }
    if (payload.expiresAt <= now) return { ok: false, reason: "TOKEN_EXPIRED" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "TOKEN_INVALID" };
  }
}

export async function ensureCreatorReferralCode(
  creator: {
    id: string;
    shop: string;
    handle: string;
    referralCode?: string | null;
    referralCodeNormalized?: string | null;
  },
  database: CreatorReferralDatabase = db,
) {
  if (creator.referralCode && creator.referralCodeNormalized) {
    return {
      referralCode: creator.referralCode,
      referralCodeNormalized: creator.referralCodeNormalized,
    };
  }
  const fields = referralFieldsForCode(creator.referralCode || creator.handle);
  if (!database.creator.update) {
    throw new Error("Creator referral code update is unavailable.");
  }
  await database.creator.update({
    where: { id: creator.id },
    data: fields,
  });
  return fields;
}

export async function resolveReferralCode(
  input: { shop: string; code: string },
  database: CreatorReferralDatabase = db,
): Promise<ResolvedReferralCode | null> {
  const shop = String(input.shop || "").trim();
  const normalized = normalizeReferralCodeForLookup(input.code);
  if (!shop || !normalized) return null;

  const creator = await database.creator.findFirst({
    where: {
      shop,
      referralCodeNormalized: normalized,
    },
    select: {
      id: true,
      referralCode: true,
      status: true,
      displayName: true,
    },
  });
  if (!creator) return null;
  return {
    creatorId: creator.id,
    referralCode: creator.referralCode,
    creatorStatus: creator.status,
    displayName: creator.displayName,
  };
}

export async function createPendingReferral(
  input: { shop: string; code: string; existingToken?: string | null; now?: number },
  database: CreatorReferralDatabase = db,
): Promise<PendingReferralResult> {
  const shop = String(input.shop || "").trim();
  const normalized = normalizeReferralCodeForLookup(input.code);
  if (!shop || !normalized) {
    diagnostic("creator_referral_resolve_invalid", { shop, reason: "INVALID_CODE" });
    return { status: "INVALID_CODE" };
  }

  if (input.existingToken) {
    const existing = verifyPendingReferralToken(
      input.existingToken,
      input.now ?? Date.now(),
    );
    if (existing.ok && existing.payload.shop === shop) {
      diagnostic("creator_referral_pending_exists", { shop });
      return { status: "PENDING_EXISTS" };
    }
  }

  const creator = await resolveReferralCode(
    { shop, code: input.code },
    database,
  );
  if (!creator) {
    diagnostic("creator_referral_resolve_not_found", { shop });
    return { status: "NOT_FOUND" };
  }
  if (creator.creatorStatus !== "APPROVED") {
    diagnostic("creator_referral_resolve_ineligible", {
      shop,
      referrerCreatorId: creator.creatorId,
      creatorStatus: creator.creatorStatus,
    });
    return { status: "INELIGIBLE" };
  }

  const now = input.now ?? Date.now();
  const expiresAt = now + PENDING_REFERRAL_TTL_MS;
  const token = signPendingReferralToken({
    version: PENDING_REFERRAL_TOKEN_VERSION,
    shop,
    referrerCreatorId: creator.creatorId,
    referralCodeSnapshot: creator.referralCode,
    issuedAt: now,
    expiresAt,
    nonce: randomUUID(),
  });
  diagnostic("creator_referral_resolved", {
    shop,
    referrerCreatorId: creator.creatorId,
  });
  return {
    status: "RESOLVED",
    token,
    referralCode: creator.referralCode,
    expiresAt: new Date(expiresAt).toISOString(),
    maxAgeSeconds: PENDING_REFERRAL_TTL_SECONDS,
  };
}

export async function claimPendingReferral(
  input: { shop: string; customerId?: string | null; token: string; now?: number },
  database: CreatorReferralDatabase = db,
): Promise<{ status: ReferralClaimStatus }> {
  const shop = String(input.shop || "").trim();
  const customerId = normalizeCustomerGidForReferral(String(input.customerId || ""));
  if (!shop || !customerId) {
    diagnostic("creator_referral_claim_not_logged_in", { shop });
    return { status: "NOT_LOGGED_IN" };
  }

  const verified = verifyPendingReferralToken(input.token, input.now ?? Date.now());
  if (!verified.ok) {
    diagnostic("creator_referral_claim_token_rejected", {
      shop,
      reason: verified.reason,
    });
    return { status: verified.reason };
  }
  if (verified.payload.shop !== shop) {
    diagnostic("creator_referral_claim_shop_mismatch", { shop });
    return { status: "SHOP_MISMATCH" };
  }

  const referrer = await database.creator.findUnique?.({
    where: { id: verified.payload.referrerCreatorId },
    select: {
      id: true,
      shop: true,
      customerId: true,
      status: true,
      referralCode: true,
    },
  });
  if (
    !referrer ||
    referrer.shop !== shop ||
    referrer.status !== "APPROVED" ||
    referrer.referralCode !== verified.payload.referralCodeSnapshot
  ) {
    diagnostic("creator_referral_claim_referrer_invalid", {
      shop,
      referrerCreatorId: verified.payload.referrerCreatorId,
    });
    return { status: "REFERRER_INVALID" };
  }
  if (referrer.customerId === customerId) {
    diagnostic("creator_referral_claim_self_referral", {
      shop,
      referrerCreatorId: referrer.id,
    });
    return { status: "SELF_REFERRAL" };
  }

  const existingCreator = await database.creator.findUnique?.({
    where: { shop_customerId: { shop, customerId } },
    select: { id: true },
  });
  if (existingCreator) {
    diagnostic("creator_referral_claim_existing_creator", { shop });
    return { status: "EXISTING_CREATOR" };
  }

  const existingAttribution = await database.referralAttribution?.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } },
    select: { id: true },
  });
  if (existingAttribution) {
    diagnostic("creator_referral_claim_already_attributed", { shop });
    return { status: "ALREADY_ATTRIBUTED" };
  }

  try {
    await database.referralAttribution?.create({
      data: {
        shop,
        shopifyCustomerId: customerId,
        referrerCreatorId: verified.payload.referrerCreatorId,
        referralCodeSnapshot: verified.payload.referralCodeSnapshot,
        status: "CAPTURED",
        capturedAt: new Date(input.now ?? Date.now()),
      },
      select: { id: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      diagnostic("creator_referral_claim_race_already_attributed", { shop });
      return { status: "ALREADY_ATTRIBUTED" };
    }
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      diagnostic("creator_referral_claim_race_already_attributed", { shop });
      return { status: "ALREADY_ATTRIBUTED" };
    }
    throw error;
  }

  diagnostic("creator_referral_claimed", {
    shop,
    referrerCreatorId: verified.payload.referrerCreatorId,
  });
  return { status: "CLAIMED" };
}

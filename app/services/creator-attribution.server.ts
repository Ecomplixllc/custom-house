import { createHmac, timingSafeEqual } from "node:crypto";

export type CreatorAttributionPayload = {
  creatorProductId: string;
  creatorId: string;
  creatorCollectionId: string;
  baseProductId: string;
  baseVariantId: string;
  pitchprintProjectId: string;
  issuedAt: number;
};

function attributionSecret() {
  const secret =
    process.env.CUSTOMHOUSE_ATTRIBUTION_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    process.env.SESSION_SECRET ||
    "";
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "customhouse-dev-attribution-secret";
  throw new Error("CUSTOMHOUSE_ATTRIBUTION_SECRET is required.");
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function signature(body: string) {
  return createHmac("sha256", attributionSecret()).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function cleanId(value: unknown) {
  return typeof value === "string" && value.length <= 255 ? value : "";
}

export function signCreatorAttribution(
  payload: Omit<CreatorAttributionPayload, "issuedAt">,
) {
  const body = encode({ ...payload, issuedAt: Date.now() });
  return `${body}.${signature(body)}`;
}

export function verifyCreatorAttribution(
  token: string | null | undefined,
): CreatorAttributionPayload | null {
  if (!token || token.length > 3000 || !token.includes(".")) return null;
  const [body, mac, ...extra] = token.split(".");
  if (!body || !mac || extra.length || !safeEqual(signature(body), mac)) return null;
  let parsed: unknown;
  try {
    parsed = decode(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const payload: CreatorAttributionPayload = {
    creatorProductId: cleanId(value.creatorProductId),
    creatorId: cleanId(value.creatorId),
    creatorCollectionId: cleanId(value.creatorCollectionId),
    baseProductId: cleanId(value.baseProductId),
    baseVariantId: cleanId(value.baseVariantId),
    pitchprintProjectId: cleanId(value.pitchprintProjectId),
    issuedAt: Number(value.issuedAt),
  };
  if (
    !payload.creatorProductId ||
    !payload.creatorId ||
    !payload.creatorCollectionId ||
    !payload.baseProductId ||
    !payload.baseVariantId ||
    !payload.pitchprintProjectId ||
    !Number.isFinite(payload.issuedAt)
  ) {
    return null;
  }
  return payload;
}

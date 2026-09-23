import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain.ts";

export type InkyBaySessionToken = {
  sessionId: string;
  shop: string;
  customerId: string;
  creatorId: string;
  expiresAt: number;
};

function secret() {
  const value = process.env.DESIGN_SIGNING_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "Creator publishing is not configured.",
      503,
    );
  }
  return value;
}

export function signInkyBaySessionToken(
  payload: Omit<InkyBaySessionToken, "expiresAt">,
  lifetimeSeconds: number,
) {
  const value: InkyBaySessionToken = {
    ...payload,
    expiresAt: Math.floor(Date.now() / 1_000) + lifetimeSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyInkyBaySessionToken(token: string) {
  const [encoded, supplied] = token.split(".");
  if (!encoded || !supplied) {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_INVALID",
      "The creator design session is invalid.",
      401,
    );
  }
  const expected = createHmac("sha256", secret())
    .update(encoded)
    .digest("base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_INVALID",
      "The creator design session is invalid.",
      401,
    );
  }
  let payload: InkyBaySessionToken;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as InkyBaySessionToken;
  } catch {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_INVALID",
      "The creator design session is invalid.",
      401,
    );
  }
  if (
    !payload.sessionId ||
    !payload.shop ||
    !payload.customerId ||
    !payload.creatorId ||
    payload.expiresAt < Math.floor(Date.now() / 1_000)
  ) {
    throw new DomainError(
      "CREATOR_DESIGN_SESSION_EXPIRED",
      "The creator design session has expired. Start a new session.",
      401,
    );
  }
  return payload;
}

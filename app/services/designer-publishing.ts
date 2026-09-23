import { createHash } from "node:crypto";
import { canApprovedCreatorPublish } from "./creator-status.ts";

export type VariantShape = {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

export function canCreatorPublish(
  status: unknown,
  suspendedAt: Date | string | null | undefined,
) {
  return canApprovedCreatorPublish(status, suspendedAt);
}

export function ownsDesignSession(
  session: { shop: string; customerId: string; creatorId: string | null },
  actor: { shop: string; customerId: string; creatorId: string },
) {
  return (
    session.shop === actor.shop &&
    session.customerId === actor.customerId &&
    session.creatorId === actor.creatorId
  );
}

export function designerPublishKey(
  shop: string,
  creatorId: string,
  sessionId: string,
) {
  return createHash("sha256")
    .update(`${shop}\n${creatorId}\n${sessionId}`)
    .digest("hex");
}

export function variantFingerprint(
  options: Array<{ name: string; value: string }>,
) {
  return options
    .map(({ name, value }) => `${name.trim().toLowerCase()}=${value.trim().toLowerCase()}`)
    .sort()
    .join("|");
}

export function duplicateVariantsToDelete(
  sourceVariants: VariantShape[],
  allowedSourceVariantIds: readonly string[],
  duplicateVariants: VariantShape[],
) {
  if (!allowedSourceVariantIds.length) return [];
  const allowed = new Set(
    sourceVariants
      .filter((variant) => allowedSourceVariantIds.includes(variant.id))
      .map((variant) => variantFingerprint(variant.selectedOptions)),
  );
  return duplicateVariants
    .filter((variant) => !allowed.has(variantFingerprint(variant.selectedOptions)))
    .map((variant) => variant.id);
}

export function fixedProductTags(existing: string[]) {
  return [
    ...new Set([
      ...existing.filter((tag) => tag !== "creator-base"),
      "creator-fixed",
      "custom-house-creator-product",
    ]),
  ];
}

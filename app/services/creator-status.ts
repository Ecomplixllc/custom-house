export function normalizeCreatorStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isApprovedCreatorStatus(value: unknown): boolean {
  return normalizeCreatorStatus(value) === "approved";
}

export function isSuspendedCreatorStatus(value: unknown): boolean {
  return normalizeCreatorStatus(value) === "suspended";
}

export function canApprovedCreatorPublish(
  status: unknown,
  suspendedAt: Date | string | null | undefined,
): boolean {
  return isApprovedCreatorStatus(status) && !suspendedAt;
}

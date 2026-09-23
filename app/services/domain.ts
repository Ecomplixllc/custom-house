export const CREATOR_TAGS = { applicant: "creator-applicant", PENDING: "creator-pending", APPROVED: "creator-approved", REJECTED: "creator-rejected", SUSPENDED: "creator-suspended" } as const;
export type CreatorState = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
export type SubmissionState = "PENDING" | "APPROVED" | "REJECTED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "ARCHIVED";
export class DomainError extends Error { readonly code: string; readonly status: number; constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; this.name = "DomainError"; } }
export function slugify(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "creator"; }
export function collectionTitle(template: string, creatorName: string): string { return template.replaceAll("{creatorName}", creatorName).trim().slice(0, 255); }
export function normalizeHttpsUrl(value: string, allowedHosts?: string[]): string {
  let url: URL; try { url = new URL(value.trim()); } catch { throw new DomainError("INVALID_URL", "Enter a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new DomainError("INVALID_URL", "Only public HTTPS URLs are allowed.");
  url.hash = ""; url.hostname = url.hostname.toLowerCase();
  if (allowedHosts && (!allowedHosts.length || !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))) throw new DomainError("HOST_NOT_ALLOWED", "This saved-design hostname is not allowed.");
  return url.toString();
}
export function statusTags(current: string[], next: CreatorState): string[] { const conflicting = new Set<string>(Object.values(CREATOR_TAGS)); return [...new Set([...current.filter((tag) => !conflicting.has(tag)), CREATOR_TAGS.applicant, CREATOR_TAGS[next]])]; }
export function parseJsonList(value: string): string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []; } catch { return []; } }
export function safeJson(value: unknown): string { return JSON.stringify(value, (key, item) => /token|secret|password/i.test(key) ? "[REDACTED]" : item); }
export function assertTransition(from: SubmissionState, to: SubmissionState): void {
  const allowed: Record<SubmissionState, SubmissionState[]> = { PENDING: ["APPROVED", "REJECTED", "PUBLISHING", "ARCHIVED"], APPROVED: ["PUBLISHING", "REJECTED", "ARCHIVED"], REJECTED: ["ARCHIVED"], PUBLISHING: ["PUBLISHED", "FAILED"], PUBLISHED: ["ARCHIVED"], FAILED: ["PUBLISHING", "ARCHIVED"], ARCHIVED: [] };
  if (!allowed[from].includes(to)) throw new DomainError("INVALID_TRANSITION", `Cannot change submission from ${from} to ${to}.`, 409);
}

import type { Creator, CreatorStatus } from "@prisma/client";
import { CREATOR_TAGS, DomainError } from "./domain.ts";

export const HELIUM_FIELDS = [
  "legalName",
  "creatorDisplayName",
  "country",
  "city",
  "creatorProfilePhoto",
  "shortCreatorBio",
  "portfolioUrl",
  "socialProfiles",
  "termsAccepted",
  "applicationMessage",
] as const;
export type HeliumField = (typeof HELIUM_FIELDS)[number];
export type HeliumMappedValues = Partial<Record<HeliumField, string>>;
export interface HeliumMappingEntry {
  namespace: string;
  key: string;
  type: string;
  enabled: boolean;
}
export type HeliumMetafieldMap = Partial<
  Record<HeliumField, HeliumMappingEntry>
>;
export const HELIUM_EXPECTED_TYPES: Record<HeliumField, string[]> = { legalName: ["single_line_text_field"], creatorDisplayName: ["single_line_text_field"], country: ["single_line_text_field"], city: ["single_line_text_field"], creatorProfilePhoto: ["file_reference"], shortCreatorBio: ["multi_line_text_field", "single_line_text_field"], portfolioUrl: ["url", "single_line_text_field"], socialProfiles: ["list.url", "multi_line_text_field", "json"], termsAccepted: ["boolean", "single_line_text_field"], applicationMessage: ["multi_line_text_field", "single_line_text_field"] };
export const HELIUM_DEFAULT_KEYS: Record<HeliumField, string> = {
  legalName: "legal_name",
  creatorDisplayName: "creator_display_name_1",
  country: "country",
  city: "city",
  creatorProfilePhoto: "creator_profile_photo_1",
  shortCreatorBio: "short_creator_bio",
  portfolioUrl: "socialportfolio_url",
  socialProfiles: "socialportfolio_url",
  termsAccepted: "terms_agreement",
  applicationMessage: "application_message",
};
export interface HeliumCustomerInput {
  customerId: string;
  tags: string[];
  formIds?: string[];
  fields?: HeliumMappedValues;
  snapshotHash?: string;
}
export const DEFAULT_HELIUM_CREATOR_FORM_ID = "lXteLY";
export const DEFAULT_HELIUM_PROFILE_UPDATE_FORM_ID = "dGtXke";

export interface HeliumSyncOptions {
  profileUpdateFormIds?: string[];
  useExistingStatus?: boolean;
}
export type HeliumSyncAction = "CREATE" | "UPDATE" | "SKIP";
export type HeliumSyncResultCode =
  | "CREATED"
  | "UPDATED"
  | "SKIPPED"
  | "CONFLICT"
  | "NOT_CREATOR"
  | "MISSING_MAPPING"
  | "ERROR";
export interface HeliumSyncPlan {
  action: HeliumSyncAction;
  result: HeliumSyncResultCode;
  status: CreatorStatus | null;
  data: Record<string, unknown>;
  reason: string;
}

const legacyAliases: Record<string, HeliumField> = {
  displayName: "creatorDisplayName",
  biography: "shortCreatorBio",
  profileImage: "creatorProfilePhoto",
  applicationAnswers: "applicationMessage",
};

export function defaultHeliumMetafieldMap(): HeliumMetafieldMap {
  return Object.fromEntries(
    HELIUM_FIELDS.map((field) => [
      field,
      {
        namespace: "customer_fields",
        key: HELIUM_DEFAULT_KEYS[field],
        type: HELIUM_EXPECTED_TYPES[field][0],
        enabled: true,
      },
    ]),
  ) as HeliumMetafieldMap;
}

export function parseHeliumMetafieldMap(
  value: string | null | undefined,
): HeliumMetafieldMap {
  try {
    const parsed = JSON.parse(value || "{}") as Record<string, unknown>;
    const result: HeliumMetafieldMap = {};
    for (const [rawField, rawEntry] of Object.entries(parsed)) {
      const field = (legacyAliases[rawField] || rawField) as HeliumField;
      if (
        !HELIUM_FIELDS.includes(field) ||
        !rawEntry ||
        typeof rawEntry !== "object"
      )
        continue;
      const entry = rawEntry as Partial<HeliumMappingEntry>;
      if (
        typeof entry.namespace === "string" &&
        entry.namespace &&
        typeof entry.key === "string" &&
        entry.key
      )
        result[field] = {
          namespace: entry.namespace,
          key: entry.key,
          type: typeof entry.type === "string" ? entry.type : "unknown",
          enabled: entry.enabled !== false,
        };
    }
    return result;
  } catch {
    return {};
  }
}

export function serializeHeliumMetafieldMap(form: FormData): string {
  const result: HeliumMetafieldMap = {};
  for (const field of HELIUM_FIELDS) {
    const definition = String(form.get(`helium.${field}.definition`) || "");
    const enabled = form.has(`helium.${field}.enabled`);
    if (!definition) {
      const namespace = String(
        form.get(`helium.${field}.namespace`) || "customer_fields",
      ).trim();
      const key = String(
        form.get(`helium.${field}.key`) || HELIUM_DEFAULT_KEYS[field],
      ).trim();
      const type = String(
        form.get(`helium.${field}.type`) || HELIUM_EXPECTED_TYPES[field][0],
      ).trim();
      if (!enabled && !key) continue;
      if (!namespace || !key || !type)
        throw new DomainError(
          "INVALID_HELIUM_MAPPING",
          `Enter a valid namespace, key, and type for ${field}.`,
        );
      result[field] = { namespace, key, type, enabled };
      continue;
    }
    const [namespace, key, type] = definition.split("|");
    if (!namespace || !key || !type)
      throw new DomainError(
        "INVALID_HELIUM_MAPPING",
        `Select a valid definition for ${field}.`,
      );
    result[field] = { namespace, key, type, enabled };
  }
  return JSON.stringify(result);
}

export function formatHeliumMappingEntry(
  map: HeliumMetafieldMap,
  field: HeliumField,
): string {
  const entry = map[field];
  return entry ? `${entry.namespace}|${entry.key}|${entry.type}` : "";
}

export function normalizeCustomerGid(value: string | number): string {
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value <= 0)
  )
    throw new DomainError(
      "INVALID_CUSTOMER_ID",
      "Shopify customer identity is invalid.",
      400,
    );
  const input = String(value).trim();
  const match = input.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
  const numeric = match?.[1] || (/^\d+$/.test(input) ? input : null);
  if (!numeric || BigInt(numeric) <= 0n)
    throw new DomainError(
      "INVALID_CUSTOMER_ID",
      "Shopify customer identity is invalid.",
      400,
    );
  return `gid://shopify/Customer/${BigInt(numeric).toString()}`;
}

export function parseHeliumFormIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const normalized = (items: unknown[]) => [
    ...new Set(
      items
        .filter((item): item is string => typeof item === "string")
        .flatMap((item) => item.split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return normalized(parsed);
    if (typeof parsed === "string") return normalized([parsed]);
    return [];
  } catch {
    return normalized([value]);
  }
}

export function creatorStatusFromTags(tags: string[]): CreatorStatus | null {
  const values = new Set(tags.map((tag) => tag.toLowerCase()));
  if (values.has(CREATOR_TAGS.SUSPENDED)) return "SUSPENDED";
  if (values.has(CREATOR_TAGS.APPROVED)) return "APPROVED";
  if (values.has(CREATOR_TAGS.REJECTED)) return "REJECTED";
  if (values.has(CREATOR_TAGS.PENDING) || values.has(CREATOR_TAGS.applicant))
    return "PENDING";
  return null;
}

function normalizeSocialProfiles(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.startsWith("https://"),
        ),
      );
    }
  } catch {
    // Plain text social profile values are normalized below.
  }
  const links = input
    .split(/[\s,\r\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.startsWith("https://"))
    .slice(0, 5);
  return links.length ? JSON.stringify(links) : input;
}

export function isHeliumCreatorFormSubmission(
  formIds: string[] | undefined,
  configuredFormId: string | null | undefined,
): boolean {
  const formId = configuredFormId?.trim() || DEFAULT_HELIUM_CREATOR_FORM_ID;
  return Boolean(
    formId &&
      formIds?.some(
        (value) => value.trim().toLowerCase() === formId.toLowerCase(),
      ),
  );
}

export function isHeliumProfileUpdateFormSubmission(
  formIds: string[] | undefined,
  configuredFormIds: string[] = [DEFAULT_HELIUM_PROFILE_UPDATE_FORM_ID],
): boolean {
  const normalizedConfiguredIds = configuredFormIds
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(
    normalizedConfiguredIds.length &&
      formIds?.some((value) =>
        normalizedConfiguredIds.includes(value.trim().toLowerCase()),
      ),
  );
}

export function withHeliumCreatorFormTags(
  input: HeliumCustomerInput,
  configuredFormId: string | null | undefined,
): HeliumCustomerInput {
  if (
    creatorStatusFromTags(input.tags) ||
    !isHeliumCreatorFormSubmission(input.formIds, configuredFormId)
  )
    return input;
  return {
    ...input,
    tags: [...new Set([...input.tags, CREATOR_TAGS.applicant, CREATOR_TAGS.PENDING])],
  };
}
export function hasConflictingCreatorTags(tags: string[]): boolean {
  const statuses = new Set([
    CREATOR_TAGS.PENDING,
    CREATOR_TAGS.APPROVED,
    CREATOR_TAGS.REJECTED,
    CREATOR_TAGS.SUSPENDED,
  ]);
  return (
    new Set(
      tags
        .map((tag) => tag.toLowerCase())
        .filter((tag) => statuses.has(tag as typeof CREATOR_TAGS.PENDING)),
    ).size > 1
  );
}

export function planHeliumSync(
  existing: Creator | null,
  input: HeliumCustomerInput,
  options: HeliumSyncOptions = {},
): HeliumSyncPlan {
  const externalStatus = creatorStatusFromTags(input.tags);
  const isProfileUpdate =
    Boolean(existing) &&
    (options.useExistingStatus ||
      isHeliumProfileUpdateFormSubmission(
        input.formIds,
        options.profileUpdateFormIds,
      ));
  const status = isProfileUpdate ? existing!.status : externalStatus;
  if (!status)
    return {
      action: "SKIP",
      result: "NOT_CREATOR",
      status: null,
      data: {},
      reason: "No creator tag",
    };
  const fields = input.fields || {};
  const profile = {
    displayName: fields.creatorDisplayName?.trim(),
    legalName: fields.legalName?.trim(),
    country: fields.country?.trim(),
    city: fields.city?.trim(),
    bio: fields.shortCreatorBio?.trim(),
    portfolioUrl: fields.portfolioUrl?.trim(),
    profileImageUrl: fields.creatorProfilePhoto?.trim(),
    socialLinksJson: normalizeSocialProfiles(fields.socialProfiles || fields.portfolioUrl),
  };
  if (!existing)
    return {
      action: "CREATE",
      result: hasConflictingCreatorTags(input.tags) ? "CONFLICT" : "CREATED",
      status,
      reason: "Creator tag found",
      data: {
        status,
        displayName:
          profile.displayName ||
          `Creator ${normalizeCustomerGid(input.customerId).split("/").at(-1)}`,
        legalName: profile.legalName || null,
        country: profile.country || null,
        city: profile.city || null,
        bio: profile.bio || null,
        portfolioUrl: profile.portfolioUrl || null,
        profileImageUrl: profile.profileImageUrl || null,
        socialLinksJson: profile.socialLinksJson || "[]",
      },
    };
  const data: Record<string, unknown> = {};
  const authorityConflict =
    !isProfileUpdate &&
    existing.statusAuthority === "CUSTOM_APP" &&
    existing.status !== status;
  if (
    !isProfileUpdate &&
    existing.statusAuthority === "HELIUM_IMPORT" &&
    existing.status !== status
  )
    data.status = status;
  for (const [key, value] of Object.entries(profile))
    if (value && existing[key as keyof Creator] !== value) data[key] = value;
  if (
    input.snapshotHash &&
    existing.externalSnapshotHash === input.snapshotHash &&
    !Object.keys(data).length
  )
    return {
      action: "SKIP",
      result: "SKIPPED",
      status,
      data: {},
      reason: "External snapshot unchanged",
    };
  return Object.keys(data).length
    ? {
        action: "UPDATE",
        result: authorityConflict ? "CONFLICT" : "UPDATED",
        status,
        data,
        reason: authorityConflict
          ? "External status conflicts with app-managed decision; profile fields may update"
          : "External profile or status changed",
      }
    : {
        action: "SKIP",
        result: authorityConflict ? "CONFLICT" : "SKIPPED",
        status,
        data: {},
        reason: authorityConflict
          ? "App-managed status preserved"
          : "Already synchronized",
      };
}

export async function loadWithLazySync<T extends { creatorFound: boolean }>(
  load: () => Promise<T>,
  synchronize: () => Promise<unknown>,
): Promise<T> {
  let result = await load();
  if (!result.creatorFound) {
    await synchronize();
    result = await load();
  }
  return result;
}

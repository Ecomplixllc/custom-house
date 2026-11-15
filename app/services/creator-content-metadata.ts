import { DomainError } from "./domain.ts";

export const CREATOR_CONTENT_MAX_TAGS = 5;
export const CREATOR_CONTENT_MAX_TAG_LENGTH = 30;

const UNSAFE_TAG_PATTERN = /[<>]|\b(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu;

function containsUnsafeControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function normalizeCreatorContentTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new DomainError(
      "INVALID_CREATOR_CONTENT_TAGS",
      "Creator Content tags must be a list.",
      422,
    );
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value) {
    if (typeof rawTag !== "string") {
      throw new DomainError(
        "INVALID_CREATOR_CONTENT_TAG",
        "Each Creator Content tag must be text.",
        422,
      );
    }
    const tag = rawTag.trim().replace(/\s+/gu, " ");
    if (!tag) {
      throw new DomainError(
        "BLANK_CREATOR_CONTENT_TAG",
        "Creator Content tags cannot be blank.",
        422,
      );
    }
    if ([...tag].length > CREATOR_CONTENT_MAX_TAG_LENGTH) {
      throw new DomainError(
        "CREATOR_CONTENT_TAG_TOO_LONG",
        `Creator Content tags may contain at most ${CREATOR_CONTENT_MAX_TAG_LENGTH} characters.`,
        422,
      );
    }
    if (UNSAFE_TAG_PATTERN.test(tag) || containsUnsafeControlCharacter(tag)) {
      throw new DomainError(
        "UNSAFE_CREATOR_CONTENT_TAG",
        "Creator Content tags cannot contain unsafe HTML or script content.",
        422,
      );
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  if (normalized.length > CREATOR_CONTENT_MAX_TAGS) {
    throw new DomainError(
      "CREATOR_CONTENT_TAG_LIMIT",
      `Add no more than ${CREATOR_CONTENT_MAX_TAGS} tags.`,
      422,
    );
  }
  return normalized;
}

export function normalizeCreatorContentBoolean(
  value: unknown,
  fallback: boolean,
  fieldLabel: string,
) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1" || value === "on") return true;
  if (value === false || value === "false" || value === "0" || value === "off") return false;
  throw new DomainError(
    "INVALID_CREATOR_CONTENT_VISIBILITY",
    `${fieldLabel} must be true or false.`,
    422,
  );
}

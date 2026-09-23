import { DomainError, normalizeHttpsUrl } from "./domain.ts";

export const CREATOR_PLATFORMS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "Facebook",
  "Website",
  "Other",
] as const;

export const CREATOR_AUDIENCE_RANGES = [
  "Under 1K",
  "1K-10K",
  "10K-50K",
  "50K-100K",
  "100K-500K",
  "500K+",
] as const;

export const CREATOR_CATEGORIES = [
  "Streetwear",
  "Sports",
  "Gaming",
  "Art",
  "Lifestyle",
  "Music",
  "Humor",
  "Other",
] as const;

export interface CreatorApplicationInput {
  legalName?: string;
  displayName: string;
  emailSnapshot?: string;
  country?: string;
  city?: string;
  bio?: string;
  primaryPlatform?: string;
  primaryProfileUrl?: string;
  audienceRange?: string;
  categories?: string[];
  portfolioUrl?: string;
  aboutWork?: string;
  socialLinks?: string[];
  profileImageUrl?: string;
  message?: string;
  referralCode?: string;
  termsAccepted: boolean;
  accuracyConfirmed?: boolean;
}

function cleanText(value: string, name: string, min: number, max: number): string {
  const normalized = Array.from(value, (character) => { const code = character.charCodeAt(0); return code < 32 || code === 127 ? " " : character; }).join("").replace(/\s+/g, " ").trim();
  if (normalized.length < min || normalized.length > max) throw new DomainError("INVALID_INPUT", `${name} must be ${min}-${max} characters.`);
  return normalized;
}

export function validateCreatorApplication(input: CreatorApplicationInput) {
  if (!input.termsAccepted) throw new DomainError("TERMS_REQUIRED", "You must accept the creator terms.");
  if (input.accuracyConfirmed === false) throw new DomainError("ACCURACY_REQUIRED", "Confirm the application details are accurate.");
  const primaryPlatform = input.primaryPlatform
    ? cleanChoice(input.primaryPlatform, CREATOR_PLATFORMS, "Primary platform")
    : undefined;
  const primaryProfileUrl = input.primaryProfileUrl
    ? normalizeHttpsUrl(input.primaryProfileUrl)
    : undefined;
  const audienceRange = input.audienceRange
    ? cleanChoice(input.audienceRange, CREATOR_AUDIENCE_RANGES, "Audience size")
    : undefined;
  const categories = Array.from(new Set(input.categories || []))
    .map((category) => cleanChoice(category, CREATOR_CATEGORIES, "Creator category"))
    .slice(0, 8);
  const profileImageUrl = input.profileImageUrl ? (input.profileImageUrl.startsWith("gid://shopify/MediaImage/") ? input.profileImageUrl : normalizeHttpsUrl(input.profileImageUrl)) : undefined;
  const socialLinks = [
    ...(primaryProfileUrl ? [primaryProfileUrl] : []),
    ...(input.socialLinks || []),
  ];
  return { legalName: input.legalName?.trim() ? cleanText(input.legalName, "Legal name", 2, 120) : undefined, displayName: cleanText(input.displayName, "Display name", 2, 80), emailSnapshot: input.emailSnapshot?.trim() ? cleanText(input.emailSnapshot, "Email", 3, 254) : undefined, country: input.country?.trim() ? cleanText(input.country, "Country", 2, 80) : undefined, city: input.city?.trim() ? cleanText(input.city, "City", 1, 100) : undefined, bio: input.bio?.trim() ? cleanText(input.bio, "Biography", 10, 500) : undefined, primaryPlatform, primaryProfileUrl, audienceRange, categories, portfolioUrl: input.portfolioUrl ? normalizeHttpsUrl(input.portfolioUrl) : undefined, aboutWork: input.aboutWork?.trim() ? cleanText(input.aboutWork, "About your work", 1, 1000) : undefined, socialLinks: socialLinks.filter(Boolean).slice(0, 5).map((url) => normalizeHttpsUrl(url)), profileImageUrl, message: input.message?.trim() ? cleanText(input.message, "Message", 1, 1000) : undefined, termsAcceptedAt: new Date() };
}

function cleanChoice<T extends readonly string[]>(value: string | undefined, choices: T, name: string): T[number] {
  const normalized = String(value || "").trim();
  const match = choices.find((choice) => choice.toLowerCase() === normalized.toLowerCase());
  if (!match) throw new DomainError("INVALID_INPUT", `${name} is invalid.`);
  return match;
}

export function validateProfileImage(bytes: Uint8Array, mimeType: string, size: number): void {
  if (size <= 0 || size > 5 * 1024 * 1024) throw new DomainError("INVALID_PROFILE_IMAGE", "Profile image must be 5 MB or smaller.");
  const jpg = mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = mimeType === "image/png" && pngSignature.every((value, index) => bytes[index] === value);
  const webp = mimeType === "image/webp" && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!jpg && !png && !webp) throw new DomainError("INVALID_PROFILE_IMAGE", "Profile image must be a valid JPG, PNG, or WebP file.");
}

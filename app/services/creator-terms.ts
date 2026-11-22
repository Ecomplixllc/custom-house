import { DomainError } from "./domain.ts";

export const DEFAULT_CREATOR_TERMS_TITLE = "Creator Terms & Conditions";
export const DEFAULT_CREATOR_TERMS_BODY =
  "Please replace this placeholder with the approved Creator Terms & Conditions in Creator Marketplace Settings before accepting applications.";

function cleanLegalText(value: unknown) {
  return Array.from(String(value ?? ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        (code >= 32 && code !== 127) || character === "\n" || character === "\r"
      );
    })
    .join("")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function cleanCreatorTermsContent(title: unknown, body: unknown) {
  const cleanTitle = cleanLegalText(title);
  const cleanBody = cleanLegalText(body);
  if (!cleanTitle || !cleanBody) {
    throw new DomainError(
      "CREATOR_TERMS_REQUIRED",
      "Creator Terms title and legal text are required.",
      422,
    );
  }
  if (cleanTitle.length > 200 || cleanBody.length > 50_000) {
    throw new DomainError(
      "CREATOR_TERMS_TOO_LONG",
      "Creator Terms title or legal text is too long.",
      422,
    );
  }
  return { title: cleanTitle, body: cleanBody };
}

import { randomUUID } from "node:crypto";
import { DomainError } from "./domain";
import { safeDiagnostic } from "./observability.server";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

export function designerApiSuccess(data: unknown, status = 200) {
  return Response.json({ success: true, data }, { status, headers: HEADERS });
}

export function designerApiError(error: unknown, operation: string) {
  const referenceId = randomUUID();
  const known = error instanceof DomainError;
  safeDiagnostic("designer_request", "failed", {
    correlationId: referenceId,
    operation,
  });
  return Response.json(
    {
      success: false,
      error: {
        code: known ? error.code : "DESIGN_REQUEST_FAILED",
        message: known
          ? error.message
          : "We could not complete this design request. Please try again.",
        referenceId,
      },
    },
    { status: known ? error.status : 500, headers: HEADERS },
  );
}

export function requireFormFile(form: FormData, name: string) {
  const value = form.get(name);
  if (!(value instanceof File) || !value.size) {
    throw new DomainError(
      "DESIGN_FILE_MISSING",
      "The design export is missing. Please export it again.",
      422,
    );
  }
  return value;
}

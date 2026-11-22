import { authenticate } from "../shopify.server";
import { DomainError } from "./domain";
import { AdminGraphqlClient } from "./shopify-graphql.server";

export async function proxyContext(request: Request, requireCustomer = true) {
  const context = await authenticate.public.appProxy(request);
  if (!context.session || !context.admin) {
    throw new DomainError(
      "SHOP_NOT_INSTALLED",
      "The marketplace app is not available.",
      503,
    );
  }

  const params = new URL(request.url).searchParams;
  const customerId = params.get("logged_in_customer_id");
  if (requireCustomer && !customerId) {
    throw new DomainError(
      "CUSTOMER_LOGIN_REQUIRED",
      "Please sign in before submitting your creator application.",
      401,
    );
  }

  return {
    shop: context.session.shop,
    customerId,
    client: new AdminGraphqlClient(context.admin),
    liquid: context.liquid,
  };
}

export function apiError(error: unknown): Response {
  const known = error instanceof DomainError;
  return Response.json(
    {
      ok: false,
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "The request could not be completed.",
      },
    },
    {
      status: known ? error.status : 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function apiData(data: unknown, status = 200): Response {
  return Response.json(
    { ok: true, data },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
      },
    },
  );
}

export function proxyJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

export function proxyJsonError(error: DomainError | unknown): Response {
  const known = error instanceof DomainError;
  return proxyJson({
    ok: false,
    error: {
      code: known ? error.code : "APPLICATION_SUBMIT_FAILED",
      message: known
        ? error.message
        : "Unable to submit the application. Please try again.",
    },
  });
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Send JSON.", 415);
  }
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_JSON", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

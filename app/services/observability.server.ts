import { randomUUID } from "node:crypto";

export type DiagnosticCategory =
  | "admin_authentication"
  | "webhook_authentication"
  | "app_proxy_authentication"
  | "database_connection"
  | "graphql_failure"
  | "designer_request";

export function correlationId(request?: Request): string {
  const supplied = request?.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)
    ? supplied
    : randomUUID();
}

export function safeDiagnostic(
  category: DiagnosticCategory,
  outcome: "started" | "succeeded" | "failed",
  details: {
    correlationId: string;
    route?: string;
    shop?: string;
    operation?: string;
  },
) {
  console.info("customhouse_diagnostic", {
    category,
    outcome,
    correlationId: details.correlationId,
    route: details.route,
    shop: details.shop,
    operation: details.operation,
  });
}

export async function observeAuthentication<T>(
  category:
    | "admin_authentication"
    | "webhook_authentication"
    | "app_proxy_authentication",
  request: Request,
  authenticate: () => Promise<T>,
): Promise<T> {
  const id = correlationId(request);
  const route = new URL(request.url).pathname;
  safeDiagnostic(category, "started", { correlationId: id, route });
  try {
    const result = await authenticate();
    safeDiagnostic(category, "succeeded", { correlationId: id, route });
    return result;
  } catch (error) {
    safeDiagnostic(category, "failed", { correlationId: id, route });
    throw error;
  }
}

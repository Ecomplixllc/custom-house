export interface GraphqlResponse<T> { data?: T; errors?: Array<{ message: string }> }
function safeGraphqlErrorMessage(
  errors: Array<{ message: string }> | undefined,
  operation: string,
) {
  if (!errors?.length) return `${operation} failed.`;
  return `${operation} failed: ${errors
    .map((error) => error.message)
    .join("; ")
    .replace(/\s+/g, " ")
    .slice(0, 500)}`;
}
export interface ShopifyGraphqlResult<T> {
  data?: T;
  errors: Array<{ message: string }>;
  ok: boolean;
  status: number;
}
export interface ShopifyGraphqlClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  requestWithMetadata?<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<ShopifyGraphqlResult<T>>;
}
type AdminClient = { graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response> };

export class AdminGraphqlClient implements ShopifyGraphqlClient {
  private readonly admin: AdminClient;

  constructor(admin: AdminClient) {
    this.admin = admin;
  }

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const document = query.replace(/^#graphql\s+/, "");
    const operation =
      document.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/)?.[2] ||
      "anonymous";
    const id = correlationId();
    try {
      const response = await this.admin.graphql(document, { variables });
      const body = await response.json() as GraphqlResponse<T>;
      if (!response.ok || body.errors?.length || !body.data)
        throw new Error(safeGraphqlErrorMessage(body.errors, operation));
      return body.data;
    } catch (error) {
      safeDiagnostic("graphql_failure", "failed", {
        correlationId: id,
        operation,
      });
      throw new Error(error instanceof Error ? error.message : `${operation} failed.`);
    }
  }

  async requestWithMetadata<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<ShopifyGraphqlResult<T>> {
    const document = query.replace(/^#graphql\s+/, "");
    const response = await this.admin.graphql(document, { variables });
    const body = (await response.json()) as GraphqlResponse<T>;
    return {
      data: body.data,
      errors: body.errors || [],
      ok: response.ok && !body.errors?.length && Boolean(body.data),
      status: response.status,
    };
  }
}

export function throwUserErrors(errors: Array<{ message: string }> | undefined, operation: string): void {
  if (errors?.length) throw new Error(`${operation} failed: ${errors.map((error) => error.message).join("; ").slice(0, 500)}`);
}
import {
  correlationId,
  safeDiagnostic,
} from "./observability.server.ts";

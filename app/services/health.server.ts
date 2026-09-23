export const REQUIRED_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "NODE_ENV",
] as const;

export type HealthResult =
  | {
      status: "ok";
      app: "running";
      database: "connected";
    }
  | {
      status: "error";
      app: "running";
      database: "unavailable";
      code:
        | "MISSING_ENVIRONMENT"
        | "INVALID_APP_URL"
        | "DATABASE_UNAVAILABLE";
    };

export async function evaluateHealth(
  environment: Record<string, string | undefined>,
  pingDatabase: () => Promise<unknown>,
): Promise<{ status: number; body: HealthResult }> {
  const configured = REQUIRED_ENVIRONMENT_VARIABLES.every(
    (name) => Boolean(environment[name]?.trim()),
  );
  if (!configured) {
    return {
      status: 503,
      body: {
        status: "error",
        app: "running",
        database: "unavailable",
        code: "MISSING_ENVIRONMENT",
      },
    };
  }
  try {
    const appUrl = new URL(environment.SHOPIFY_APP_URL!);
    if (appUrl.protocol !== "https:") {
      throw new Error("SHOPIFY_APP_URL must use HTTPS");
    }
  } catch {
    return {
      status: 503,
      body: {
        status: "error",
        app: "running",
        database: "unavailable",
        code: "INVALID_APP_URL",
      },
    };
  }
  try {
    await pingDatabase();
    return {
      status: 200,
      body: {
        status: "ok",
        app: "running",
        database: "connected",
      },
    };
  } catch {
    return {
      status: 503,
      body: {
        status: "error",
        app: "running",
        database: "unavailable",
        code: "DATABASE_UNAVAILABLE",
      },
    };
  }
}

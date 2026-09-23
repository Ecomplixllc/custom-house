import { evaluateHealth } from "../services/health.server";
import {
  correlationId,
  safeDiagnostic,
} from "../services/observability.server";

export async function loader({ request }: { request: Request }) {
  const id = correlationId(request);
  const result = await evaluateHealth(process.env, async () => {
    const { default: db } = await import("../db.server");
    return db.$queryRaw`SELECT 1`;
  });
  safeDiagnostic(
    "database_connection",
    result.body.database === "connected" ? "succeeded" : "failed",
    { correlationId: id, route: "/health" },
  );
  return Response.json(
    result.body,
    {
      status: result.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Correlation-ID": id,
      },
    },
  );
}

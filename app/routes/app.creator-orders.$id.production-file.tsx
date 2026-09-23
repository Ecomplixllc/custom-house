import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getCreatorOrderProductionFile } from "../services/creator-orders.server";
import { DomainError } from "../services/domain";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  try {
    const file = await getCreatorOrderProductionFile({
      shop: session.shop,
      creatorOrderItemId: params.id || "",
      format: url.searchParams.get("format"),
    });
    return new Response(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const domainError =
      error instanceof DomainError
        ? error
        : new DomainError(
            "PITCHPRINT_RENDER_FAILED",
            "Unable to generate production file. Please try again.",
            502,
          );
    return Response.json(
      {
        ok: false,
        error: {
          code: domainError.code,
          message: domainError.message,
        },
      },
      {
        status: domainError.status,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}

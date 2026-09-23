import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { DomainError } from "../services/domain";
import { getPrivateProductionDownload } from "../services/inkybay/private-storage.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const design = await db.creatorDesign.findFirst({
    where: {
      id: params.designId || "",
      shop: session.shop,
      provider: "INKYBAY",
    },
    select: { productionArtworkKey: true },
  });
  if (!design?.productionArtworkKey) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_NOT_FOUND",
      "The production artwork was not found.",
      404,
    );
  }
  const download = await getPrivateProductionDownload(
    design.productionArtworkKey,
  );
  if (download.kind === "redirect") {
    return Response.redirect(download.url, 302);
  }
  const extension = design.productionArtworkKey.split(".").pop() || "bin";
  return new Response(download.stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="creator-artwork.${extension}"`,
      "Content-Length": String(download.size),
      "Content-Type": download.contentType || "application/octet-stream",
      ETag: download.etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

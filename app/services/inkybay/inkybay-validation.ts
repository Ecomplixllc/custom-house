import { DomainError, normalizeHttpsUrl } from "../domain.ts";
import { inspectImage } from "../designer-validation.ts";

const TID_PATTERN = /^[A-Za-z0-9_-]{6,200}$/;

function normalizeTid(value: unknown) {
  const tid = typeof value === "string" ? value.trim() : "";
  if (!TID_PATTERN.test(tid)) {
    throw new DomainError(
      "INKYBAY_TID_INVALID",
      "Enter a valid PitchPrint saved-design ID.",
      422,
    );
  }
  return tid;
}

export function parseInkyBaySavedDesign(input: {
  savedDesignUrl: string;
  tid?: string | null;
  allowedHosts: readonly string[];
}) {
  const savedDesignUrl = normalizeHttpsUrl(
    input.savedDesignUrl,
    [...new Set(input.allowedHosts.map((host) => host.toLowerCase()))],
  );
  const url = new URL(savedDesignUrl);
  const urlTid =
    url.searchParams.get("tid") ||
    url.searchParams.get("designTid") ||
    url.searchParams.get("projectId") ||
    url.searchParams.get("project_id") ||
    url.searchParams.get("_pitchprint") ||
    url.searchParams.get("pprint") ||
    url.searchParams.get("design_id");
  const suppliedTid = input.tid?.trim() || "";
  if (urlTid && suppliedTid && urlTid !== suppliedTid) {
    throw new DomainError(
      "INKYBAY_TID_MISMATCH",
      "The saved-design URL and tid do not match.",
      422,
    );
  }
  const tid = normalizeTid(urlTid || suppliedTid);
  return { savedDesignUrl, tid };
}

function hasPdfFooter(bytes: Uint8Array) {
  const tail = new TextDecoder("latin1").decode(bytes.slice(-1_024));
  return tail.includes("%%EOF");
}

export function validateProductionArtwork(
  bytes: Uint8Array,
  fileName: string,
  claimedMimeType: string,
  limits: {
    maximumBytes: number;
    minimumWidth: number;
    minimumHeight: number;
  },
) {
  if (!bytes.length || bytes.length > limits.maximumBytes) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_SIZE_INVALID",
      `Choose production artwork smaller than ${Math.floor(
        limits.maximumBytes / 1024 / 1024,
      )} MB.`,
      413,
    );
  }
  const extension = fileName.toLowerCase().split(".").pop();
  if (
    claimedMimeType === "application/pdf" &&
    extension === "pdf" &&
    bytes.length >= 8 &&
    new TextDecoder("latin1").decode(bytes.slice(0, 5)) === "%PDF-" &&
    hasPdfFooter(bytes)
  ) {
    return { mimeType: "application/pdf" as const, extension: "pdf" };
  }
  const image = inspectImage(bytes);
  if (
    image.mimeType !== "image/png" ||
    claimedMimeType !== "image/png" ||
    extension !== "png"
  ) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_TYPE_INVALID",
      "Production artwork must be a valid high-resolution PNG or PDF.",
      422,
    );
  }
  if (
    image.width < limits.minimumWidth ||
    image.height < limits.minimumHeight
  ) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_RESOLUTION_INVALID",
      `Use production artwork at least ${limits.minimumWidth} × ${limits.minimumHeight} pixels.`,
      422,
    );
  }
  return {
    mimeType: "image/png" as const,
    extension: "png",
    width: image.width,
    height: image.height,
  };
}

export function parseCompatibleVariantIds(
  value: unknown,
  allowedVariantIds: readonly string[],
) {
  const candidate = Array.isArray(value) ? value : [];
  const allowed = new Set(allowedVariantIds);
  const selected = [
    ...new Set(
      candidate
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => allowed.has(item)),
    ),
  ];
  if (!selected.length) {
    throw new DomainError(
      "COMPATIBLE_VARIANTS_REQUIRED",
      "Choose at least one supported size or color option.",
      422,
    );
  }
  return selected;
}

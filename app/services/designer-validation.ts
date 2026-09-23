import { DomainError } from "./domain.ts";

export type ImageInfo = {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

function uint24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mimeType: "image/png",
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        mimeType: "image/jpeg",
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += length + 2;
  }
  return null;
}

function webpInfo(bytes: Uint8Array): ImageInfo | null {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  ) {
    return null;
  }
  const kind = String.fromCharCode(...bytes.slice(12, 16));
  if (kind === "VP8X") {
    return {
      mimeType: "image/webp",
      width: uint24le(bytes, 24) + 1,
      height: uint24le(bytes, 27) + 1,
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      mimeType: "image/webp",
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  return null;
}

export function inspectImage(bytes: Uint8Array): ImageInfo {
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
  if (!info || info.width < 1 || info.height < 1) {
    throw new DomainError(
      "INVALID_IMAGE",
      "Use a valid PNG, JPEG, or WebP image.",
      422,
    );
  }
  return info;
}

export function validateImageUpload(
  bytes: Uint8Array,
  fileName: string,
  claimedMimeType: string,
  constraints: {
    maximumBytes: number;
    minimumWidth: number;
    minimumHeight: number;
    allowedTypes: readonly string[];
  },
) {
  if (!bytes.length || bytes.length > constraints.maximumBytes) {
    throw new DomainError(
      "IMAGE_SIZE_INVALID",
      `Choose an image smaller than ${Math.floor(constraints.maximumBytes / 1024 / 1024)} MB.`,
      413,
    );
  }
  const info = inspectImage(bytes);
  const extension = fileName.toLowerCase().split(".").pop();
  const expectedExtensions: Record<ImageInfo["mimeType"], string[]> = {
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/webp": ["webp"],
  };
  if (
    !constraints.allowedTypes.includes(info.mimeType) ||
    claimedMimeType !== info.mimeType ||
    !extension ||
    !expectedExtensions[info.mimeType].includes(extension)
  ) {
    throw new DomainError(
      "IMAGE_TYPE_INVALID",
      "The image type does not match the file.",
      422,
    );
  }
  if (info.width < constraints.minimumWidth || info.height < constraints.minimumHeight) {
    throw new DomainError(
      "IMAGE_DIMENSIONS_INVALID",
      `Use an image at least ${constraints.minimumWidth} × ${constraints.minimumHeight} pixels.`,
      422,
    );
  }
  return info;
}

function inspectJsonValue(value: unknown, depth: number, state: { objects: number }) {
  if (depth > 12) {
    throw new DomainError("DESIGN_INVALID", "The design is too complex.", 422);
  }
  if (typeof value === "string") {
    if (/^data:/i.test(value) || value.length > 20_000) {
      throw new DomainError(
        "DESIGN_INVALID",
        "Embedded files are not allowed in saved designs.",
        422,
      );
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  state.objects += 1;
  if (state.objects > 500) {
    throw new DomainError("DESIGN_INVALID", "The design is too complex.", 422);
  }
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new DomainError("DESIGN_INVALID", "The design contains invalid data.", 422);
    }
    inspectJsonValue(item, depth + 1, state);
  }
}

export function validateDesignJson(serialized: string) {
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 500_000) {
    throw new DomainError("DESIGN_INVALID", "The saved design is too large.", 422);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DomainError("DESIGN_INVALID", "The saved design is invalid.", 422);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("DESIGN_INVALID", "The saved design is invalid.", 422);
  }
  const candidate = parsed as { objects?: unknown };
  if (!Array.isArray(candidate.objects) || candidate.objects.length > 50) {
    throw new DomainError(
      "DESIGN_INVALID",
      "A design must contain no more than 50 objects.",
      422,
    );
  }
  for (const item of candidate.objects) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DomainError("DESIGN_INVALID", "The design contains invalid objects.", 422);
    }
    const object = item as Record<string, unknown>;
    if (!["Textbox", "Image"].includes(String(object.type ?? ""))) {
      throw new DomainError(
        "DESIGN_OBJECT_NOT_ALLOWED",
        "The design contains an unsupported object.",
        422,
      );
    }
    if (
      object.type === "Textbox" &&
      (typeof object.text !== "string" || object.text.length > 500)
    ) {
      throw new DomainError(
        "DESIGN_TEXT_INVALID",
        "The design contains invalid text.",
        422,
      );
    }
  }
  inspectJsonValue(parsed, 0, { objects: 0 });
  return parsed as Record<string, unknown>;
}

export function validateDesignAssetUrls(
  design: Record<string, unknown>,
  allowedHosts: readonly string[],
) {
  const urls: string[] = [];
  const walk = (value: unknown, depth = 0) => {
    if (depth > 12 || !value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "src" && typeof item === "string") {
        let url: URL;
        try {
          url = new URL(item);
        } catch {
          throw new DomainError(
            "DESIGN_ASSET_INVALID",
            "The design contains an invalid image.",
            422,
          );
        }
        const host = url.hostname.toLowerCase();
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !allowedHosts.some(
            (allowed) => host === allowed || host.endsWith(`.${allowed}`),
          )
        ) {
          throw new DomainError(
            "DESIGN_ASSET_INVALID",
            "The design contains an image from an unsupported source.",
            422,
          );
        }
        urls.push(url.toString());
      } else {
        walk(item, depth + 1);
      }
    }
  };
  walk(design);
  return urls;
}

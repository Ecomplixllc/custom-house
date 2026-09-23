import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { get, put } from "@vercel/blob";
import { DomainError } from "../domain";
import {
  getPrivateStorageConfig,
  type S3PrivateStorageConfig,
  type VercelBlobStorageConfig,
} from "./inkybay-config.server";

function s3Client(config: S3PrivateStorageConfig) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function blobAuthentication(config: VercelBlobStorageConfig) {
  return {
    ...(config.storeId ? { storeId: config.storeId } : {}),
    ...(config.readWriteToken ? { token: config.readWriteToken } : {}),
  };
}

function segment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "unknown";
}

export async function storePrivateProductionArtwork(input: {
  shop: string;
  creatorId: string;
  sessionId: string;
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}) {
  const config = getPrivateStorageConfig();
  const key = [
    "creator-production",
    segment(input.shop),
    segment(input.creatorId),
    segment(input.sessionId),
    `${randomUUID()}.${segment(input.extension)}`,
  ].join("/");
  try {
    if (config.provider === "vercel_blob") {
      await put(key, Buffer.from(input.bytes), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        contentType: input.mimeType,
        multipart: input.bytes.byteLength > 5 * 1024 * 1024,
        ...blobAuthentication(config),
      });
    } else {
      await s3Client(config).send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: input.bytes,
          ContentType: input.mimeType,
          CacheControl: "private, no-store",
          ServerSideEncryption: "AES256",
          Metadata: {
            purpose: "creator-production-artwork",
          },
        }),
      );
    }
  } catch {
    throw new DomainError(
      "PRODUCTION_ARTWORK_STORAGE_FAILED",
      "The production artwork could not be stored. Please try again.",
      502,
    );
  }
  return { key };
}

export type PrivateProductionDownload =
  | { kind: "redirect"; url: string }
  | {
      kind: "stream";
      stream: ReadableStream<Uint8Array>;
      contentType: string;
      size: number;
      etag: string;
    };

export async function getPrivateProductionDownload(
  key: string,
  lifetimeSeconds = 5 * 60,
): Promise<PrivateProductionDownload> {
  const config = getPrivateStorageConfig();
  if (!key.startsWith("creator-production/")) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_INVALID",
      "The production artwork reference is invalid.",
      422,
    );
  }
  try {
    if (config.provider === "vercel_blob") {
      const result = await get(key, {
        access: "private",
        useCache: false,
        ...blobAuthentication(config),
      });
      if (!result || result.statusCode !== 200) {
        throw new Error("Private blob was not found");
      }
      return {
        kind: "stream",
        stream: result.stream,
        contentType: result.blob.contentType,
        size: result.blob.size,
        etag: result.blob.etag,
      };
    }

    return {
      kind: "redirect",
      url: await getSignedUrl(
        s3Client(config),
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: Math.max(60, Math.min(lifetimeSeconds, 15 * 60)) },
      ),
    };
  } catch {
    throw new DomainError(
      "PRODUCTION_ARTWORK_UNAVAILABLE",
      "The production artwork is temporarily unavailable.",
      503,
    );
  }
}

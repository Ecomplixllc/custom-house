import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  creatorCollectionBannerForCustomer,
  removeCreatorCollectionBanner,
  updateCreatorCollectionBanner,
  uploadCollectionBannerImage,
} from "../services/creator-collection-banner.server";
import { getCreatorCollectionStorefrontUrl } from "../services/creator-storefront-urls";
import { DomainError } from "../services/domain";
import {
  apiData,
  jsonBody,
  proxyContext,
} from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

function bannerApiError(error: unknown): Response {
  const known = error instanceof DomainError;
  const code = known ? error.code : "UNKNOWN_ERROR";
  const status = known ? error.status : 500;
  console.info("customhouse_collection_banner", {
    outcome: "failed",
    stage: "route",
    code,
  });
  return Response.json(
    {
      ok: false,
      code,
      message: known
        ? error.message
        : "Collection banner could not be saved.",
      error: {
        code,
        message: known
          ? error.message
          : "Collection banner could not be saved.",
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function bannerPayload(collection: {
  id: string;
  publicHandle: string;
  bannerImageUrl?: string | null;
  bannerTitle?: string | null;
  bannerSubtitle?: string | null;
  bannerUpdatedAt?: Date | string | null;
}) {
  return {
    collection: {
      id: collection.id,
      publicHandle: collection.publicHandle,
      publicUrl: getCreatorCollectionStorefrontUrl(collection),
      bannerImageUrl: collection.bannerImageUrl || null,
      bannerTitle: collection.bannerTitle || null,
      bannerSubtitle: collection.bannerSubtitle || null,
      bannerUpdatedAt: collection.bannerUpdatedAt
        ? new Date(collection.bannerUpdatedAt).toISOString()
        : null,
    },
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shop, customerId } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:collection-banner`, 30, 60 * 60 * 1000);
    const collection = await creatorCollectionBannerForCustomer({
      shop,
      customerId: customerId!,
    });
    return apiData(bannerPayload(collection));
  } catch (error) {
    return bannerApiError(error);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:collection-banner-save`, 12, 60 * 60 * 1000);
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await jsonBody(request);
      if (body.intent !== "remove") {
        throw new DomainError(
          "INVALID_BANNER_ACTION",
          "Choose a valid banner action.",
          400,
        );
      }
      const collection = await removeCreatorCollectionBanner({
        shop,
        customerId: customerId!,
      });
      return apiData(bannerPayload(collection));
    }

    if (!contentType.includes("multipart/form-data")) {
      throw new DomainError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Send a multipart form request.",
        415,
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new DomainError(
        "REQUEST_PARSE_FAILED",
        "Collection banner request could not be read.",
        400,
      );
    }
    if (String(form.get("intent") || "save") !== "save") {
      throw new DomainError(
        "INVALID_BANNER_ACTION",
        "Choose a valid banner action.",
        400,
      );
    }
    const file = form.get("bannerImage");
    let bannerImageUrl: string | undefined;
    if (file instanceof File && file.size > 0) {
      const title = String(form.get("bannerTitle") || "");
      const uploaded = await uploadCollectionBannerImage(
        file,
        client,
        title || "Creator collection banner",
      );
      bannerImageUrl = uploaded.bannerImageUrl;
    }

    const collection = await updateCreatorCollectionBanner({
      shop,
      customerId: customerId!,
      title: form.get("bannerTitle"),
      subtitle: form.get("bannerSubtitle"),
      ...(bannerImageUrl ? { bannerImageUrl } : {}),
    });
    return apiData(bannerPayload(collection));
  } catch (error) {
    return bannerApiError(error);
  }
}

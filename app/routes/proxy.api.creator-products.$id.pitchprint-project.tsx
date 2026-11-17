import type { LoaderFunctionArgs } from "react-router";
import {
  assertPitchPrintProjectOwner,
  getCreatorProductForCustomer,
} from "../services/creator-products.server";
import { DomainError } from "../services/domain";
import { fetchPitchPrintProjectSource } from "../services/pitchprint-project-fetch.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(
      `${context.shop}:${context.customerId}:creator-products:project-source`,
      20,
      60_000,
    );
    const product = await getCreatorProductForCustomer(
      context.shop,
      context.customerId!,
      String(params.id || ""),
    );
    if (!product.pitchprintProjectId) {
      throw new DomainError(
        "PITCHPRINT_PROJECT_REQUIRED",
        "This design has not been saved yet.",
        409,
      );
    }
    if (!["DRAFT", "REJECTED", "PUBLISHED"].includes(product.status)) {
      throw new DomainError(
        "CREATOR_PRODUCT_NOT_EDITABLE",
        "This design cannot be edited in its current status.",
        409,
      );
    }

    const source = await fetchPitchPrintProjectSource(
      product.pitchprintProjectId,
    );
    assertPitchPrintProjectOwner(context.shop, product.creatorId, source);
    const sourceDesignId = String(source.designId || "").trim();
    if (
      product.pitchprintDesignId &&
      sourceDesignId &&
      sourceDesignId !== product.pitchprintDesignId
    ) {
      throw new DomainError(
        "PITCHPRINT_DESIGN_MISMATCH",
        "The saved design no longer matches its base product.",
        409,
      );
    }

    return apiData({ source });
  } catch (error) {
    return apiError(error);
  }
}

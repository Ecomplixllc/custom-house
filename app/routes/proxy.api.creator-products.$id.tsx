import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  archiveCreatorProductForCustomer,
  attachPitchPrintProjectToCreatorProduct,
  deleteCreatorProductForCustomer,
  getCreatorProductForCustomer,
  restoreCreatorProductToDraftForCustomer,
  submitCreatorProductForReview,
  updateCreatorProductDetailsForCustomer,
  withdrawCreatorProductForCustomer,
  type AttachPitchPrintProjectInput,
} from "../services/creator-products.server";
import { apiData, apiError, jsonBody, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-products:read`);
    return apiData({
      product: await getCreatorProductForCustomer(
        context.shop,
        context.customerId!,
        String(params.id || ""),
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function action({ params, request }: ActionFunctionArgs) {
  try {
    const context = await proxyContext(request);
    enforceRateLimit(`${context.shop}:${context.customerId}:creator-products:write`);
    const body = await jsonBody(request);
    const actionName = String(body.action || body.intent || "").trim();
    if (actionName === "submit") {
      return apiData({
        product: await submitCreatorProductForReview(
          context.shop,
          context.customerId!,
          String(params.id || ""),
        ),
      });
    }
    if (actionName === "update-details") {
      return apiData({
        product: await updateCreatorProductDetailsForCustomer(
          context.shop,
          context.customerId!,
          String(params.id || ""),
          body,
        ),
      });
    }
    if (actionName === "delete") {
      return apiData({
        product: await deleteCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          String(params.id || ""),
        ),
        deleted: true,
      });
    }
    if (actionName === "archive") {
      return apiData({
        product: await archiveCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          String(params.id || ""),
        ),
      });
    }
    if (actionName === "withdraw") {
      return apiData({
        product: await withdrawCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          String(params.id || ""),
        ),
      });
    }
    if (actionName === "restore-to-draft") {
      return apiData({
        product: await restoreCreatorProductToDraftForCustomer(
          context.shop,
          context.customerId!,
          String(params.id || ""),
        ),
      });
    }
    return apiData({
      product: await attachPitchPrintProjectToCreatorProduct(
        context.shop,
        context.customerId!,
        String(params.id || ""),
        body as AttachPitchPrintProjectInput,
      ),
    });
  } catch (error) {
    return apiError(error);
  }
}

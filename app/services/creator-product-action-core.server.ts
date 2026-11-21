import {
  archiveCreatorProductForCustomer,
  attachPitchPrintProjectToCreatorProduct,
  creatorProductColorInputDiagnostics,
  deleteCreatorProductForCustomer,
  restoreCreatorProductToDraftForCustomer,
  saveCreatorContentMetadataForCustomer,
  savePitchPrintDraftSessionForCustomer,
  submitCreatorProductForReview,
  updateCreatorProductDetailsForCustomer,
  withdrawCreatorProductForCustomer,
  type AttachPitchPrintProjectInput,
  type SavePitchPrintDraftSessionInput,
} from "./creator-products.server.ts";

type CreatorSaveLog = ReturnType<typeof creatorProductColorInputDiagnostics> & {
  event: "creator_product_save_color_resolution";
  stage: "request" | "success" | "error";
  creatorProductId: string;
  errorCode?: string;
};

type CreatorProductActionContext = {
  shop: string;
  customerId?: string | null;
  client: unknown;
};

export type CreatorProductActionCoreDependencies = {
  proxyContext(request: Request): Promise<CreatorProductActionContext>;
  enforceRateLimit(key: string): void;
  jsonBody(request: Request): Promise<Record<string, unknown>>;
  apiData(data: unknown): Response;
  apiError(error: unknown): Response;
  archiveCreatorProductForCustomer: typeof archiveCreatorProductForCustomer;
  attachPitchPrintProjectToCreatorProduct: typeof attachPitchPrintProjectToCreatorProduct;
  deleteCreatorProductForCustomer: typeof deleteCreatorProductForCustomer;
  restoreCreatorProductToDraftForCustomer: typeof restoreCreatorProductToDraftForCustomer;
  saveCreatorContentMetadataForCustomer: typeof saveCreatorContentMetadataForCustomer;
  savePitchPrintDraftSessionForCustomer: typeof savePitchPrintDraftSessionForCustomer;
  submitCreatorProductForReview: typeof submitCreatorProductForReview;
  updateCreatorProductDetailsForCustomer: typeof updateCreatorProductDetailsForCustomer;
  withdrawCreatorProductForCustomer: typeof withdrawCreatorProductForCustomer;
  logCreatorSave(entry: CreatorSaveLog): void;
};

export const creatorProductActionServices = {
  archiveCreatorProductForCustomer,
  attachPitchPrintProjectToCreatorProduct,
  deleteCreatorProductForCustomer,
  restoreCreatorProductToDraftForCustomer,
  saveCreatorContentMetadataForCustomer,
  savePitchPrintDraftSessionForCustomer,
  submitCreatorProductForReview,
  updateCreatorProductDetailsForCustomer,
  withdrawCreatorProductForCustomer,
};

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  const code = String((error as { code?: unknown }).code || "UNKNOWN").trim();
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "UNKNOWN";
}

export async function creatorProductActionCore(
  { params, request }: { params: { id?: string }; request: Request },
  dependencies: CreatorProductActionCoreDependencies,
) {
  const creatorProductId = String(params.id || "");
  let saveLog: Omit<CreatorSaveLog, "event" | "stage"> | null = null;
  try {
    const context = await dependencies.proxyContext(request);
    dependencies.enforceRateLimit(
      `${context.shop}:${context.customerId}:creator-products:write`,
    );
    const body = await dependencies.jsonBody(request);
    const actionName = String(body.action || body.intent || "").trim();
    if (actionName === "submit") {
      return dependencies.apiData({
        product: await dependencies.submitCreatorProductForReview(
          context.shop,
          context.customerId!,
          creatorProductId,
          body,
        ),
      });
    }
    if (actionName === "update-creator-content") {
      return dependencies.apiData({
        product: await dependencies.saveCreatorContentMetadataForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
          body,
        ),
      });
    }
    if (actionName === "update-details") {
      return dependencies.apiData({
        product: await dependencies.updateCreatorProductDetailsForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
          body,
          undefined,
          context.client as never,
        ),
      });
    }
    if (actionName === "delete") {
      return dependencies.apiData({
        product: await dependencies.deleteCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
        ),
        deleted: true,
      });
    }
    if (actionName === "archive") {
      return dependencies.apiData({
        product: await dependencies.archiveCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
          context.client as never,
        ),
      });
    }
    if (actionName === "withdraw") {
      return dependencies.apiData({
        product: await dependencies.withdrawCreatorProductForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
        ),
      });
    }
    if (actionName === "restore-to-draft") {
      return dependencies.apiData({
        product: await dependencies.restoreCreatorProductToDraftForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
        ),
      });
    }
    if (actionName === "save-draft-session") {
      return dependencies.apiData({
        product: await dependencies.savePitchPrintDraftSessionForCustomer(
          context.shop,
          context.customerId!,
          creatorProductId,
          body as SavePitchPrintDraftSessionInput,
        ),
      });
    }
    const input = body as AttachPitchPrintProjectInput;
    saveLog = {
      creatorProductId,
      ...creatorProductColorInputDiagnostics(input),
    };
    dependencies.logCreatorSave({
      event: "creator_product_save_color_resolution",
      stage: "request",
      ...saveLog,
    });
    const product = await dependencies.attachPitchPrintProjectToCreatorProduct(
      context.shop,
      context.customerId!,
      creatorProductId,
      input,
    );
    dependencies.logCreatorSave({
      event: "creator_product_save_color_resolution",
      stage: "success",
      ...saveLog,
    });
    return dependencies.apiData({ product });
  } catch (error) {
    if (saveLog) {
      dependencies.logCreatorSave({
        event: "creator_product_save_color_resolution",
        stage: "error",
        ...saveLog,
        errorCode: safeErrorCode(error),
      });
    }
    return dependencies.apiError(error);
  }
}

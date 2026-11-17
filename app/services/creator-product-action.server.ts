import type { ActionFunctionArgs } from "react-router";
import {
  creatorProductActionCore,
  creatorProductActionServices,
} from "./creator-product-action-core.server.ts";
import { apiData, apiError, jsonBody, proxyContext } from "./proxy.server.ts";
import { enforceRateLimit } from "./rate-limit.server.ts";

export async function creatorProductAction(args: ActionFunctionArgs) {
  return creatorProductActionCore(args, {
    ...creatorProductActionServices,
    proxyContext,
    enforceRateLimit,
    jsonBody,
    apiData,
    apiError,
    logCreatorSave(entry) {
      console.info("creator_product_save_color_resolution", entry);
    },
  });
}

import type { LoaderFunctionArgs } from "react-router";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { getInkyBayFeatureFlags } from "../services/inkybay/inkybay-config.server";
import { verifyInkyBayGlobalProduct } from "../services/inkybay/inkybay-product.server";
import { getStorefrontActor } from "../services/storefront-actor.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    const productId = new URL(request.url).searchParams.get("product_id") || "";
    const flags = getInkyBayFeatureFlags();
    await verifyInkyBayGlobalProduct(actor.client, productId);
    return designerApiSuccess({
      productType: "global_customizable",
      creatorPublishAvailable: Boolean(
        flags.creatorPublishing &&
        flags.manualBridge &&
        actor.isApprovedCreator &&
        !actor.isSuspendedCreator,
      ),
      creatorButtonText: "Create for My Collection",
      isCreator: actor.isCreator,
      creatorStatus: actor.creatorStatus,
      normalizedCreatorStatus: actor.normalizedCreatorStatus,
      isApprovedCreator: actor.isApprovedCreator,
      isSuspendedCreator: actor.isSuspendedCreator,
      actor: {
        loggedIn: Boolean(actor.customerId),
        isCreator: actor.isCreator,
        creatorStatus: actor.creatorStatus,
        normalizedCreatorStatus: actor.normalizedCreatorStatus,
        isApprovedCreator: actor.isApprovedCreator,
        isSuspendedCreator: actor.isSuspendedCreator,
      },
    });
  } catch (error) {
    return designerApiError(error, "inkybay.eligibility");
  }
}

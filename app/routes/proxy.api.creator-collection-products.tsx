import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { countActiveCollectionProducts } from "../services/creator-collection-products.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(
      `${shop}:${customerId}:creator-collection-products`,
      20,
      60 * 1000,
    );
    const creator = await db.creator.findUnique({
      where: {
        shop_customerId: {
          shop,
          customerId: normalizeCustomerGid(customerId!),
        },
      },
      select: { collectionId: true, status: true },
    });
    if (!creator || creator.status !== "APPROVED" || !creator.collectionId) {
      return apiData({ publishedProductsCount: 0 });
    }
    const publishedProductsCount = await countActiveCollectionProducts(
      client,
      creator.collectionId,
    );
    return apiData({ publishedProductsCount });
  } catch (error) {
    return apiError(error);
  }
}

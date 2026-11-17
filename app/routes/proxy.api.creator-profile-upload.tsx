import type { ActionFunctionArgs } from "react-router";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { uploadProfileImage } from "../services/profile-image.server";
import db from "../db.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:profile-image`, 5, 60 * 60 * 1000);
    if (!request.headers.get("content-type")?.includes("multipart/form-data")) throw new Response("Multipart form required", { status: 415 });
    const form = await request.formData();
    const file = form.get("profileImage");
    if (!(file instanceof File)) throw new Response("Profile image required", { status: 400 });
    const uploaded = await uploadProfileImage(file, client);
    await db.creator.update({
      where: {
        shop_customerId: {
          shop,
          customerId: normalizeCustomerGid(customerId!),
        },
      },
      data: { profileImageUrl: uploaded.profileImageUrl || uploaded.profileImageId },
    });
    return apiData(uploaded, 201);
  } catch (error) { return apiError(error); }
}

import type { LoaderFunctionArgs } from "react-router";
import { creatorDashboard } from "../services/submission.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { DomainError } from "../services/domain";
import {
  isTransientDatabaseConnectivityError,
  withTransientDatabaseRetry,
} from "../services/session-recovery.server";

type DashboardStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | "NOT_APPLIED" | "SYNC_CONFLICT";

async function profileImageUrl(
  client: {
    request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  },
  profileImageUrl?: string | null,
) {
  if (!profileImageUrl?.startsWith("gid://")) {
    return profileImageUrl?.startsWith("https://") ? profileImageUrl : null;
  }
  const result = await client.request<{
    profileImage: {
      image?: { url: string } | null;
      url?: string | null;
    } | null;
  }>(
    `#graphql query CreatorProfileImage($profileImageId: ID!) {
      profileImage: node(id: $profileImageId) {
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
      }
    }`,
    { profileImageId: profileImageUrl },
  );
  return result.profileImage?.image?.url || result.profileImage?.url || null;
}

function diagnostic(details: {
  shop: string;
  customerIdExists: boolean;
  creatorFound: boolean;
  creatorStatus: DashboardStatus | null;
}) {
  console.info("creator_dashboard_lookup", details);
}

export async function loader({ request }: LoaderFunctionArgs) {
  let shop = "unknown";
  let customerIdExists = false;
  try {
    // appProxy verifies Shopify's signature before signed query parameters are used.
    const context = await proxyContext(request, false);
    shop = context.shop;
    customerIdExists = Boolean(context.customerId);

    if (!context.customerId) {
      diagnostic({ shop, customerIdExists: false, creatorFound: false, creatorStatus: null });
      return apiData({ state: "LOGGED_OUT", loggedIn: false });
    }

    const authenticatedCustomerId = context.customerId;
    enforceRateLimit(`${shop}:${authenticatedCustomerId}:dashboard`);
    const dashboard = await withTransientDatabaseRetry(() =>
      creatorDashboard(context.shop, authenticatedCustomerId),
    );
    const liveProfileImageUrl =
      dashboard.creatorFound && dashboard.profileImageUrl?.startsWith("gid://")
        ? await profileImageUrl(context.client, dashboard.profileImageUrl)
        : dashboard.creatorFound
          ? dashboard.profileImageUrl
          : null;
    diagnostic({
      shop,
      customerIdExists: true,
      creatorFound: dashboard.creatorFound,
      creatorStatus: dashboard.state,
    });
    return apiData({
      loggedIn: true,
      ...dashboard,
      profileImageUrl: liveProfileImageUrl || dashboard.profileImageUrl || null,
    });
  } catch (error) {
    diagnostic({ shop, customerIdExists, creatorFound: false, creatorStatus: null });
    if (isTransientDatabaseConnectivityError(error)) {
      return apiError(
        new DomainError(
          "DATABASE_TEMPORARILY_UNAVAILABLE",
          "The Creator Dashboard is temporarily unavailable. Please try again.",
          503,
        ),
      );
    }
    return apiError(error);
  }
}

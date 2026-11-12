import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/creators">Creators</s-link>
        <s-link href="/app/creator-content">Creator Content</s-link>
        <s-link href="/app/referrals">Referrals</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/creator-products">Creator Products</s-link>
        <s-link href="/app/creator-products/compatibility">
          Compatibility / Legacy Repair
        </s-link>
        <s-link href="/app/creator-orders">Creator Orders</s-link>
        <s-link href="/app/payouts">Payouts</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

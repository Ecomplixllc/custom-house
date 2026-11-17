import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleStorefrontProxy } from "../services/storefront-proxy.server";
import { authenticateStorefrontProxy } from "../services/storefront-proxy-auth.server";

export function loader({ request, params }: LoaderFunctionArgs) {
  return handleStorefrontProxy(
    request,
    params["*"],
    authenticateStorefrontProxy,
  );
}

export function action({ request, params }: ActionFunctionArgs) {
  return handleStorefrontProxy(
    request,
    params["*"],
    authenticateStorefrontProxy,
  );
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleStorefrontProxy } from "../services/storefront-proxy.server";
import { authenticateStorefrontProxy } from "../services/storefront-proxy-auth.server";

export function loader({ request }: LoaderFunctionArgs) {
  return handleStorefrontProxy(request, "", authenticateStorefrontProxy);
}

export function action({ request }: ActionFunctionArgs) {
  return handleStorefrontProxy(request, "", authenticateStorefrontProxy);
}

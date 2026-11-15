import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { observeAuthentication } from "./services/observability.server";
import { withSessionStorageRecovery } from "./services/session-recovery.server";

function createShopify() {
  return shopifyApp({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
    apiVersion: ApiVersion.July26,
    scopes: process.env.SCOPES?.split(","),
    appUrl: process.env.SHOPIFY_APP_URL || "",
    authPathPrefix: "/auth",
    sessionStorage: new PrismaSessionStorage(prisma),
    distribution: AppDistribution.AppStore,
    future: {
      expiringOfflineAccessTokens: true,
    },
    ...(process.env.SHOP_CUSTOM_DOMAIN
      ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
      : {}),
  });
}

type ShopifyInstance = ReturnType<typeof createShopify>;
let shopifyInstance: ShopifyInstance | undefined;

function getShopify(): ShopifyInstance {
  shopifyInstance ??= createShopify();
  return shopifyInstance;
}

function lazyObject<T extends object>(getObject: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const object = getObject();
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

export default lazyObject(getShopify);
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = (
  ...args: Parameters<ShopifyInstance["addDocumentResponseHeaders"]>
) => getShopify().addDocumentResponseHeaders(...args);
export const authenticate = {
  admin: (request: Request) =>
    observeAuthentication("admin_authentication", request, () =>
      withSessionStorageRecovery(
        () => getShopify().authenticate.admin(request),
        () => prisma.session.count(),
        () => {
          shopifyInstance = undefined;
        },
      ),
    ),
  webhook: (request: Request) =>
    observeAuthentication("webhook_authentication", request, () =>
      getShopify().authenticate.webhook(request),
    ),
  public: {
    appProxy: (request: Request) =>
      observeAuthentication("app_proxy_authentication", request, () =>
        withSessionStorageRecovery(
          () => getShopify().authenticate.public.appProxy(request),
          () => prisma.session.count(),
          () => {
            shopifyInstance = undefined;
          },
        ),
      ),
  },
};
export const unauthenticated = lazyObject(
  () => getShopify().unauthenticated,
);
export const login = (...args: Parameters<ShopifyInstance["login"]>) =>
  getShopify().login(...args);
export const registerWebhooks = (
  ...args: Parameters<ShopifyInstance["registerWebhooks"]>
) => getShopify().registerWebhooks(...args);
export const sessionStorage = lazyObject(
  () => getShopify().sessionStorage,
);

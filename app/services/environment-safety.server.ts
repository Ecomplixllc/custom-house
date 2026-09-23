const PREVIEW_CLIENT_ID_SUFFIX = "800679";

export type RuntimeEnvironment = "preview" | "production" | "unknown";

export type SafetyEnvironment = Record<string, string | undefined>;

export type PreviewMutationContext = {
  shop: string;
  resourceType?: "product" | "collection";
  resourceId?: string | null;
  previewOwned?: boolean;
};

export type PreviewOrderContext = {
  shop: string;
  productIds: readonly string[];
  previewOwnedProductIds?: readonly string[];
  hasVerifiedPreviewReference: boolean;
};

type PreviewOrderPayload = {
  line_items?: Array<{
    product_id?: string | number;
    properties?: Array<{ name?: string; value?: string }>;
  }>;
};

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function values(value: string | undefined) {
  return new Set(
    (value || "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeShop(value: string | undefined) {
  return value?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "") || "";
}

function normalizeResourceId(value: string | null | undefined) {
  const id = value?.trim() || "";
  if (/^\d+$/.test(id)) return id;
  return id.match(/\/([^/]+)$/)?.[1] || id;
}

function endpointId(value: string | undefined) {
  if (!value) return "";
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const firstLabel = hostname.split(".")[0] || "";
    return firstLabel.startsWith("ep-")
      ? firstLabel.replace(/-pooler$/, "")
      : "";
  } catch {
    return "";
  }
}

export function runtimeEnvironment(
  environment: SafetyEnvironment = process.env,
): RuntimeEnvironment {
  const value = environment.APP_ENV?.trim().toLowerCase();
  return value === "preview" || value === "production" ? value : "unknown";
}

export function isPreviewRuntime(
  environment: SafetyEnvironment = process.env,
) {
  return runtimeEnvironment(environment) === "preview";
}

export function isPreviewDevelopmentClient(
  environment: SafetyEnvironment = process.env,
) {
  const key = environment.SHOPIFY_API_KEY?.trim() || "";
  const expectedSuffix =
    environment.PREVIEW_SHOPIFY_CLIENT_ID_SUFFIX?.trim() ||
    PREVIEW_CLIENT_ID_SUFFIX;
  return Boolean(key && expectedSuffix && key.endsWith(expectedSuffix));
}

export function isAllowedPreviewShop(
  shop: string,
  environment: SafetyEnvironment = process.env,
) {
  const configured = normalizeShop(environment.PREVIEW_SHOP_DOMAIN);
  return Boolean(configured && normalizeShop(shop) === configured);
}

export function isAllowedPreviewProduct(
  productId: string,
  environment: SafetyEnvironment = process.env,
) {
  const requested = normalizeResourceId(productId);
  if (!requested) return false;
  return [...values(environment.PREVIEW_TEST_PRODUCT_IDS)].some(
    (candidate) => normalizeResourceId(candidate) === requested,
  );
}

export function isAllowedPreviewCollection(
  collectionId: string,
  environment: SafetyEnvironment = process.env,
) {
  const requested = normalizeResourceId(collectionId);
  if (!requested) return false;
  return [...values(environment.PREVIEW_TEST_COLLECTION_IDS)].some(
    (candidate) => normalizeResourceId(candidate) === requested,
  );
}

export function isPreviewOwnedRecord(
  record: { previewPoc?: boolean | null; previewOwnerApp?: string | null },
  environment: SafetyEnvironment = process.env,
) {
  const owner = record.previewOwnerApp?.trim() || "";
  const expectedSuffix =
    environment.PREVIEW_SHOPIFY_CLIENT_ID_SUFFIX?.trim() ||
    PREVIEW_CLIENT_ID_SUFFIX;
  return Boolean(record.previewPoc && owner && owner.endsWith(expectedSuffix));
}

export function previewMutationsEnabled(
  environment: SafetyEnvironment = process.env,
) {
  return enabled(environment.PREVIEW_MUTATIONS_ENABLED);
}

export function previewOrderTestingEnabled(
  environment: SafetyEnvironment = process.env,
) {
  return enabled(environment.PREVIEW_ORDER_TESTING_ENABLED);
}

function previewBaseAllowed(shop: string, environment: SafetyEnvironment) {
  return (
    isPreviewRuntime(environment) &&
    isPreviewDevelopmentClient(environment) &&
    isAllowedPreviewShop(shop, environment) &&
    previewMutationsEnabled(environment)
  );
}

export function canRunPreviewMutation(
  context: PreviewMutationContext,
  environment: SafetyEnvironment = process.env,
) {
  if (!previewBaseAllowed(context.shop, environment)) return false;
  if (!context.resourceType || !context.resourceId) return false;
  if (context.previewOwned) return true;
  return context.resourceType === "product"
    ? isAllowedPreviewProduct(context.resourceId, environment)
    : isAllowedPreviewCollection(context.resourceId, environment);
}

export function canHandleMutatingWebhook(
  context: PreviewMutationContext,
  environment: SafetyEnvironment = process.env,
) {
  const runtime = runtimeEnvironment(environment);
  if (runtime === "production") return true;
  if (runtime !== "preview") return false;
  return canRunPreviewMutation(context, environment);
}

export function canProcessPreviewOrder(
  context: PreviewOrderContext,
  environment: SafetyEnvironment = process.env,
) {
  if (
    !previewBaseAllowed(context.shop, environment) ||
    !previewOrderTestingEnabled(environment) ||
    !context.hasVerifiedPreviewReference ||
    !context.productIds.length
  ) {
    return false;
  }
  const owned = new Set(
    (context.previewOwnedProductIds || []).map(normalizeResourceId),
  );
  return context.productIds.every(
    (id) =>
      owned.has(normalizeResourceId(id)) ||
      isAllowedPreviewProduct(id, environment),
  );
}

export function previewOrderCandidate(payload: unknown) {
  const order = (payload || {}) as PreviewOrderPayload;
  const productIds: string[] = [];
  let hasPreviewReference = false;
  for (const line of Array.isArray(order.line_items) ? order.line_items : []) {
    const properties = new Map(
      (Array.isArray(line.properties) ? line.properties : [])
        .filter(
          (item): item is Required<{ name?: string; value?: string }> =>
            typeof item?.name === "string" &&
            typeof item?.value === "string",
        )
        .map((item) => [item.name, item.value]),
    );
    const marker = properties.get("_custom_house_preview_poc") === "true";
    const signedReference =
      properties.get("_custom_house_purchase_token") ||
      properties.get("_custom_house_design_token") ||
      properties.get("_custom_house_preview_session_id");
    if (!marker || !signedReference) continue;
    const id = normalizeResourceId(String(line.product_id || ""));
    if (id) productIds.push(`gid://shopify/Product/${id}`);
    hasPreviewReference = true;
  }
  return { productIds, hasPreviewReference };
}

export function canRunProductionCreatorPublishing(
  environment: SafetyEnvironment = process.env,
) {
  return (
    runtimeEnvironment(environment) === "production" &&
    enabled(environment.INKYBAY_CREATOR_PUBLISHING_ENABLED) &&
    enabled(environment.PRODUCTION_ROLLOUT_APPROVED)
  );
}

export function customerMutationDecision(
  environment: SafetyEnvironment = process.env,
) {
  if (isPreviewRuntime(environment)) {
    return {
      allowed: false as const,
      skipped: true as const,
      reason: "PREVIEW_CUSTOMER_MUTATION_DISABLED" as const,
    };
  }
  if (runtimeEnvironment(environment) !== "production") {
    return {
      allowed: false as const,
      skipped: true as const,
      reason: "UNKNOWN_ENVIRONMENT" as const,
    };
  }
  return { allowed: true as const, skipped: false as const, reason: null };
}

export async function runCustomerMutation<T>(
  mutation: () => Promise<T>,
  environment: SafetyEnvironment = process.env,
): Promise<
  | {
      skipped: true;
      reason: "PREVIEW_CUSTOMER_MUTATION_DISABLED" | "UNKNOWN_ENVIRONMENT";
    }
  | { skipped: false; value: T }
> {
  const decision = customerMutationDecision(environment);
  if (!decision.allowed) {
    return { skipped: true, reason: decision.reason };
  }
  return { skipped: false, value: await mutation() };
}

export function databaseIsolationStatus(
  environment: SafetyEnvironment = process.env,
): "verified" | "not_applicable" | "unverified" {
  if (!isPreviewRuntime(environment)) return "not_applicable";
  const previewBranch = environment.PREVIEW_DATABASE_BRANCH_ID?.trim() || "";
  const productionBranch =
    environment.PRODUCTION_DATABASE_BRANCH_ID?.trim() || "";
  const previewEndpoint =
    environment.PREVIEW_DATABASE_ENDPOINT_ID?.trim().toLowerCase() || "";
  const productionEndpoint =
    environment.PRODUCTION_DATABASE_ENDPOINT_ID?.trim().toLowerCase() || "";
  const pooledEndpoint = endpointId(environment.DATABASE_URL);
  const directEndpoint = endpointId(environment.DIRECT_DATABASE_URL);
  return previewBranch &&
    productionBranch &&
    previewBranch !== productionBranch &&
    previewEndpoint &&
    productionEndpoint &&
    previewEndpoint !== productionEndpoint &&
    pooledEndpoint === previewEndpoint &&
    directEndpoint === previewEndpoint
    ? "verified"
    : "unverified";
}

export function safetyDiagnostics(
  environment: SafetyEnvironment = process.env,
) {
  const runtime = runtimeEnvironment(environment);
  const rawCreatorPublishing = enabled(
    environment.INKYBAY_CREATOR_PUBLISHING_ENABLED,
  );
  return {
    environment: runtime,
    databaseIsolation: databaseIsolationStatus(environment),
    creatorPublishingEnabled:
      runtime === "preview"
        ? rawCreatorPublishing
        : canRunProductionCreatorPublishing(environment),
    manualBridgeEnabled: enabled(
      environment.INKYBAY_MANUAL_PUBLISH_BRIDGE_ENABLED,
    ),
    customCallbackEnabled: enabled(
      environment.INKYBAY_CUSTOM_CALLBACK_ENABLED,
    ),
    previewMutationsEnabled: previewMutationsEnabled(environment),
    previewOrderTestingEnabled: previewOrderTestingEnabled(environment),
    productionRolloutApproved: enabled(
      environment.PRODUCTION_ROLLOUT_APPROVED,
    ),
  };
}

export function sanitizedPreviewSkip(shop: string, topic: string, reason: string) {
  console.info("PREVIEW_WEBHOOK_SKIPPED", {
    shop: normalizeShop(shop),
    topic,
    reason,
  });
}

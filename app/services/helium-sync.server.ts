import db from "../db.server";
import { createHash } from "node:crypto";
import { safeJson, slugify } from "./domain";
import {
  ensureCreatorCollectionRecord,
  syncCreatorCollectionStatus,
} from "./creator-collections.server";
import { referralFieldsForCode } from "./creator-referral.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import {
  creatorStatusFromTags,
  hasConflictingCreatorTags,
  isHeliumCreatorFormSubmission,
  isHeliumProfileUpdateFormSubmission,
  normalizeCustomerGid,
  parseHeliumFormIds,
  parseHeliumMetafieldMap,
  planHeliumSync,
  withHeliumCreatorFormTags,
  type HeliumCustomerInput,
  type HeliumField,
  type HeliumMetafieldMap,
} from "./helium-sync";
export {
  creatorStatusFromTags,
  loadWithLazySync,
  normalizeCustomerGid,
  parseHeliumMetafieldMap,
  planHeliumSync,
} from "./helium-sync";

type CustomerMetafield = {
  namespace: string;
  key: string;
  value: string;
  reference?: {
    image?: { url?: string };
    url?: string;
  } | null;
};

const HELIUM_FIELD_FALLBACKS: Record<
  HeliumField,
  Array<{ namespace: string; key: string; type?: string }>
> = {
  legalName: [
    { namespace: "app--960624--helium", key: "legal_name" },
    { namespace: "app--960624--helium", key: "creator_legal_name" },
    { namespace: "customer_fields", key: "legal_name" },
    { namespace: "customer_fields", key: "creator_legal_name" },
  ],
  creatorDisplayName: [
    { namespace: "app--960624--helium", key: "creator_display_name_1" },
    { namespace: "app--960624--helium", key: "creator_display_name" },
    { namespace: "customer_fields", key: "creator_display_name_1" },
    { namespace: "customer_fields", key: "creator_display_name" },
  ],
  country: [
    { namespace: "app--960624--helium", key: "country" },
    { namespace: "app--960624--helium", key: "creator_country" },
    { namespace: "customer_fields", key: "country" },
    { namespace: "customer_fields", key: "creator_country" },
  ],
  city: [
    { namespace: "app--960624--helium", key: "city" },
    { namespace: "app--960624--helium", key: "creator_city" },
    { namespace: "customer_fields", key: "city" },
    { namespace: "customer_fields", key: "creator_city" },
  ],
  creatorProfilePhoto: [
    { namespace: "app--960624--helium", key: "creator_profile_photo_1" },
    { namespace: "app--960624--helium", key: "creator_profile_photo" },
    { namespace: "customer_fields", key: "creator_profile_photo_1" },
    { namespace: "customer_fields", key: "creator_profile_photo" },
  ],
  shortCreatorBio: [
    { namespace: "app--960624--helium", key: "short_creator_bio" },
    { namespace: "app--960624--helium", key: "creator_bio" },
    { namespace: "customer_fields", key: "short_creator_bio" },
    { namespace: "customer_fields", key: "creator_bio" },
  ],
  portfolioUrl: [
    { namespace: "app--960624--helium", key: "socialportfolio_url" },
    { namespace: "app--960624--helium", key: "portfolio_url" },
    { namespace: "customer_fields", key: "socialportfolio_url" },
    { namespace: "customer_fields", key: "portfolio_url" },
  ],
  socialProfiles: [
    { namespace: "app--960624--helium", key: "socialportfolio_url" },
    { namespace: "app--960624--helium", key: "social_profiles" },
    { namespace: "app--960624--helium", key: "social_links" },
    { namespace: "app--960624--helium", key: "instagram_profile_url" },
    { namespace: "app--960624--helium", key: "facebook_profile_url" },
    { namespace: "app--960624--helium", key: "tiktok_profile_url" },
    { namespace: "app--960624--helium", key: "x__twitter_profile_url" },
    { namespace: "app--960624--helium", key: "youtube_channel_url" },
    { namespace: "customer_fields", key: "socialportfolio_url" },
    { namespace: "customer_fields", key: "social_profiles" },
    { namespace: "customer_fields", key: "social_links" },
    { namespace: "customer_fields", key: "instagram_profile_url" },
    { namespace: "customer_fields", key: "facebook_profile_url" },
    { namespace: "customer_fields", key: "tiktok_profile_url" },
    { namespace: "customer_fields", key: "x__twitter_profile_url" },
    { namespace: "customer_fields", key: "youtube_channel_url" },
  ],
  termsAccepted: [
    { namespace: "app--960624--helium", key: "terms_agreement" },
    { namespace: "app--960624--helium", key: "terms_accepted" },
    { namespace: "app--960624--helium", key: "terms_and_conditions" },
    { namespace: "customer_fields", key: "terms_agreement" },
    { namespace: "customer_fields", key: "terms_accepted" },
    { namespace: "customer_fields", key: "terms_and_conditions" },
  ],
  applicationMessage: [
    { namespace: "app--960624--helium", key: "application_message" },
    { namespace: "customer_fields", key: "application_message" },
  ],
};

function mappedMetafieldQuery(map: HeliumMetafieldMap) {
  const entries = [
    ...Object.values(map).filter((entry) => entry.enabled),
    ...Object.values(HELIUM_FIELD_FALLBACKS).flat(),
  ].filter(
    (entry, index, list) =>
      list.findIndex(
        (candidate) =>
          candidate.namespace === entry.namespace && candidate.key === entry.key,
      ) === index,
  );
  const variableDefinitions = entries
    .flatMap((_, index) => [
      `$metafieldNamespace${index}: String!`,
      `$metafieldKey${index}: String!`,
    ])
    .join(", ");
  const selection = entries
    .map(
      (_, index) =>
        `metafield${index}: metafield(namespace: $metafieldNamespace${index}, key: $metafieldKey${index}) { namespace key value reference { ... on MediaImage { image { url } } ... on GenericFile { url } } }`,
    )
    .join("\n");
  const namespaceSelection = `
    heliumMetafields: metafields(first: 100, namespace: "app--960624--helium") {
      nodes { namespace key value reference { ... on MediaImage { image { url } } ... on GenericFile { url } } }
    }
    customerFieldsMetafields: metafields(first: 100, namespace: "customer_fields") {
      nodes { namespace key value reference { ... on MediaImage { image { url } } ... on GenericFile { url } } }
    }
  `;
  const variables = Object.fromEntries(
    entries.flatMap((entry, index) => [
      [`metafieldNamespace${index}`, entry.namespace],
      [`metafieldKey${index}`, entry.key],
    ]),
  );
  return {
    variableDefinitions,
    selection: `${selection}\n${namespaceSelection}`,
    variables,
    values(customer: Record<string, unknown>): CustomerMetafield[] {
      const explicit = entries
        .map(
          (_, index) =>
            customer[`metafield${index}`] as CustomerMetafield | null,
        )
        .filter((value): value is CustomerMetafield => Boolean(value));
      const heliumNodes = (customer.heliumMetafields as { nodes?: CustomerMetafield[] } | null)
        ?.nodes || [];
      const customerFieldNodes = (customer.customerFieldsMetafields as { nodes?: CustomerMetafield[] } | null)
        ?.nodes || [];
      return [...explicit, ...heliumNodes, ...customerFieldNodes].filter(
        (item, index, list) =>
          list.findIndex(
            (candidate) =>
              candidate.namespace === item.namespace && candidate.key === item.key,
          ) === index,
      );
    },
  };
}

function snapshotHash(input: HeliumCustomerInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tags: [...input.tags].sort(),
        formIds: [...(input.formIds || [])].sort(),
        fields: input.fields || {},
      }),
    )
    .digest("hex");
}

function customerFormIds(customer: Record<string, unknown>): string[] {
  const metafield = customer.creatorFormIds as { value?: unknown } | null;
  return parseHeliumFormIds(metafield?.value);
}

export async function addInitialCreatorTags(
  client: ShopifyGraphqlClient,
  customerId: string,
): Promise<void> {
  const result = await client.request<{
    tagsAdd: { userErrors: Array<{ message: string }> };
  }>(
    `#graphql mutation AddInitialCreatorTags($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    {
      id: normalizeCustomerGid(customerId),
      tags: ["creator-applicant", "creator-pending"],
    },
  );
  if (result.tagsAdd.userErrors.length)
    throw new Error("Initial creator tag synchronization failed.");
}

function mapMetafieldValues(
  map: HeliumMetafieldMap,
  metafields: CustomerMetafield[],
): HeliumCustomerInput["fields"] {
  const fields: HeliumCustomerInput["fields"] = {};
  for (const field of [
    "legalName",
    "creatorDisplayName",
    "country",
    "city",
    "creatorProfilePhoto",
    "shortCreatorBio",
    "portfolioUrl",
    "socialProfiles",
    "termsAccepted",
    "applicationMessage",
  ] as HeliumField[]) {
    const configured = map[field];
    const candidates = [
      ...(configured?.enabled !== false && configured ? [configured] : []),
      ...(HELIUM_FIELD_FALLBACKS[field] || []),
    ];
    const metafield = candidates
      .map((candidate) =>
        metafields.find(
          (item) =>
            item.namespace === candidate.namespace && item.key === candidate.key,
        ),
      )
      .find((item) => item?.value || item?.reference);
    fields![field] = field === "creatorProfilePhoto" ? (metafield?.reference?.image?.url || metafield?.reference?.url || metafield?.value) : metafield?.value;
  }
  return fields;
}

function heliumApplicationData(input: HeliumCustomerInput) {
  return {
    legalName: input.fields?.legalName,
    displayName: input.fields?.creatorDisplayName,
    country: input.fields?.country,
    city: input.fields?.city,
    bio: input.fields?.shortCreatorBio,
    portfolioUrl: input.fields?.portfolioUrl,
    socialLinksJson: input.fields?.socialProfiles || "[]",
    profileImageUrl: input.fields?.creatorProfilePhoto,
    message: input.fields?.applicationMessage,
    termsAcceptedAt: input.fields?.termsAccepted ? new Date() : undefined,
  };
}

async function ensureHeliumApplication(shop: string, creatorId: string, status: string | null, input: HeliumCustomerInput) {
  const data = heliumApplicationData(input);
  await db.creator.update({
    where: { id: creatorId },
    data: {
      ...data,
      aboutWork: input.fields?.applicationMessage,
      submittedAt: new Date(),
      reviewedAt: status === "APPROVED" || status === "REJECTED" ? new Date() : null,
      approvedAt: status === "APPROVED" ? new Date() : undefined,
      rejectedAt: status === "REJECTED" ? new Date() : undefined,
    },
  });
  return "UPDATED" as const;
}

export async function fetchHeliumCustomer(
  client: ShopifyGraphqlClient,
  customerId: string,
  map: HeliumMetafieldMap,
): Promise<HeliumCustomerInput | null> {
  const metafields = mappedMetafieldQuery(map);
  const result = await client.request<{
    customer: ({
      id: string;
      tags: string[];
      firstName: string | null;
      lastName: string | null;
    } & Record<string, unknown>) | null;
  }>(
    `#graphql query HeliumCustomer($id: ID!${metafields.variableDefinitions ? `, ${metafields.variableDefinitions}` : ""}) { customer(id: $id) { id tags firstName lastName creatorFormIds: metafield(namespace: "customer_fields", key: "form_ids") { value } ${metafields.selection} } }`,
    {
      id: normalizeCustomerGid(customerId),
      ...metafields.variables,
    },
  );
  if (!result.customer) return null;
  const fields = mapMetafieldValues(
    map,
    metafields.values(result.customer),
  ) || {};
  const customerName = [result.customer.firstName, result.customer.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (customerName) {
    fields.legalName ||= customerName;
    fields.creatorDisplayName ||= customerName;
  }
  return {
        customerId: result.customer.id,
        tags: result.customer.tags,
        formIds: customerFormIds(result.customer),
        fields,
      };
}

async function uniqueHandle(
  shop: string,
  displayName: string,
): Promise<string> {
  const base = slugify(displayName);
  let handle = base;
  let suffix = 2;
  while (await db.creator.findFirst({ where: { shop, handle } }))
    handle = `${base}-${suffix++}`;
  return handle;
}

export async function findCreatorByCustomerIdentity(
  shop: string,
  customerId: string,
) {
  const gid = normalizeCustomerGid(customerId);
  return db.creator.findUnique({
    where: { shop_customerId: { shop, customerId: gid } },
  });
}

export async function applyHeliumSync(
  shop: string,
  input: HeliumCustomerInput,
  source: "WEBHOOK" | "IMPORT" | "LAZY",
  dryRun = false,
  options: { useExistingStatus?: boolean } = {},
) {
  const customerId = normalizeCustomerGid(input.customerId);
  const existing = await findCreatorByCustomerIdentity(shop, customerId);
  const externalSnapshotHash = snapshotHash(input);
  const plan = planHeliumSync(existing, {
    ...input,
    customerId,
    snapshotHash: externalSnapshotHash,
  }, options);
  if (dryRun) return plan;
  if (plan.action === "SKIP") {
    if (existing && (existing.externalSnapshotHash !== externalSnapshotHash || existing.externalSyncConflict !== (plan.result === "CONFLICT"))) await db.creator.update({ where: { id: existing.id }, data: { externalSnapshotHash, lastExternalSyncAt: new Date(), externalSyncConflict: plan.result === "CONFLICT" } });
    if (plan.result === "CONFLICT" && existing)
      await db.auditLog.create({
        data: {
          shop,
          actorType: source,
          action: "helium.status_conflict",
          entityType: "Creator",
          entityId: existing.id,
          beforeJson: safeJson({
            status: existing.status,
            authority: existing.statusAuthority,
          }),
          afterJson: safeJson({ externalStatus: plan.status }),
        },
      });
    if (existing && plan.status)
      await ensureHeliumApplication(shop, existing.id, plan.status, input);
    return plan;
  }
  if (plan.action === "CREATE") {
    const displayName = String(plan.data.displayName);
    const handle = await uniqueHandle(shop, displayName);
    const created = await db.$transaction(async (tx) => {
      const created = await tx.creator.create({
        data: {
          shop,
          customerId,
          handle,
          ...referralFieldsForCode(handle),
          displayName,
          applicationSource: "HELIUM_IMPORT",
          statusAuthority: "HELIUM_IMPORT",
          lastExternalSyncAt: new Date(),
          externalSnapshotHash,
          externalSyncConflict: plan.result === "CONFLICT",
          status: plan.status!,
          legalName: plan.data.legalName as string | null,
          country: plan.data.country as string | null,
          city: plan.data.city as string | null,
          emailSnapshot: null,
          submittedAt: new Date(),
          reviewedAt:
            plan.status === "APPROVED" || plan.status === "REJECTED"
              ? new Date()
              : null,
          socialLinksJson: String(plan.data.socialLinksJson || "[]"),
          bio: plan.data.bio as string | null,
          portfolioUrl: plan.data.portfolioUrl as string | null,
          aboutWork: input.fields?.applicationMessage,
          termsAcceptedAt: input.fields?.termsAccepted ? new Date() : null,
          profileImageUrl: plan.data.profileImageUrl as string | null,
          approvedAt: plan.status === "APPROVED" ? new Date() : null,
          rejectedAt: plan.status === "REJECTED" ? new Date() : null,
          suspendedAt: plan.status === "SUSPENDED" ? new Date() : null,
        },
      });
      await tx.auditLog.create({
        data: {
          shop,
          actorType: source,
          action: "helium.creator.created",
          entityType: "Creator",
          entityId: created.id,
          afterJson: safeJson({ status: created.status, source }),
        },
      });
      return created;
    });
    if (created.status === "APPROVED") {
      await ensureCreatorCollectionRecord(shop, created.id);
    }
    return plan;
  }
  const statusDates = plan.data.status
    ? {
        approvedAt:
          plan.data.status === "APPROVED" ? new Date() : existing!.approvedAt,
        rejectedAt: plan.data.status === "REJECTED" ? new Date() : null,
        suspendedAt: plan.data.status === "SUSPENDED" ? new Date() : null,
      }
    : {};
  const creator = await db.creator.update({
    where: { id: existing!.id },
    data: {
      ...plan.data,
      ...statusDates,
      lastExternalSyncAt: new Date(),
      externalSnapshotHash,
      externalSyncConflict: plan.result === "CONFLICT",
    },
  });
  await ensureHeliumApplication(shop, creator.id, plan.status, input);
  await db.auditLog.create({
    data: {
      shop,
      actorType: source,
      action: "helium.creator.updated",
      entityType: "Creator",
      entityId: creator.id,
      beforeJson: safeJson({ status: existing!.status }),
      afterJson: safeJson({ status: creator.status, source }),
    },
  });
  if (creator.status === "APPROVED" || creator.status === "SUSPENDED") {
    await syncCreatorCollectionStatus(shop, creator.id);
  }
  return plan;
}

export async function lazySyncCreator(
  shop: string,
  customerId: string,
  client: ShopifyGraphqlClient,
): Promise<boolean> {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { heliumMetafieldMapJson: true, heliumCreatorFormId: true },
  });
  const customer = await fetchHeliumCustomer(
    client,
    customerId,
    parseHeliumMetafieldMap(config?.heliumMetafieldMapJson),
  );
  if (!customer) return false;
  const input = withHeliumCreatorFormTags(
    customer,
    config?.heliumCreatorFormId,
  );
  const existing = await findCreatorByCustomerIdentity(shop, customer.customerId);
  const profileUpdateSubmission =
    Boolean(existing) && isHeliumProfileUpdateFormSubmission(customer.formIds);
  const existingRefresh = Boolean(existing);
  if (!creatorStatusFromTags(input.tags) && !profileUpdateSubmission && !existingRefresh)
    return false;
  if (!creatorStatusFromTags(customer.tags) && !profileUpdateSubmission && !existingRefresh)
    await addInitialCreatorTags(client, customer.customerId);
  await applyHeliumSync(shop, input, "LAZY", false, {
    useExistingStatus: existingRefresh && !creatorStatusFromTags(input.tags),
  });
  return true;
}

export async function syncExistingCreators(
  shop: string,
  client: ShopifyGraphqlClient,
  dryRun: boolean,
) {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { heliumMetafieldMapJson: true, heliumCreatorFormId: true },
  });
  const map = parseHeliumMetafieldMap(config?.heliumMetafieldMapJson);
  const metafields = mappedMetafieldQuery(map);
  let cursor: string | null = null;
  const counts = {
    create: 0,
    update: 0,
    skip: 0,
    conflict: 0,
    applicationCreate: 0,
    applicationUpdate: 0,
    invalidImageReference: 0,
    customersScanned: 0,
    creatorTaggedCustomers: 0,
    configuredFormSubmissions: 0,
    customersWithoutCreatorSignal: 0,
  };
  const preview: Array<{
    customerId: string;
    action: string;
    status: string | null;
    conflict: boolean;
    reason: string;
  }> = [];
  let customersWithoutUsableId = 0;
  do {
    const result: {
      customers: {
        nodes: Array<
          {
          id: string;
          tags: string[];
          } & Record<string, unknown>
        >;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      `#graphql query HeliumCreators($after: String${metafields.variableDefinitions ? `, ${metafields.variableDefinitions}` : ""}) { customers(first: 100, after: $after) { nodes { id tags firstName lastName creatorFormIds: metafield(namespace: "customer_fields", key: "form_ids") { value } ${metafields.selection} } pageInfo { hasNextPage endCursor } } }`,
      { after: cursor, ...metafields.variables },
    );
    for (const customer of result.customers.nodes) {
      counts.customersScanned++;
      if (!customer.id.startsWith("gid://shopify/Customer/")) {
        customersWithoutUsableId++;
        continue;
      }
      const originalStatus = creatorStatusFromTags(customer.tags);
      if (originalStatus) counts.creatorTaggedCustomers++;
      const formIds = customerFormIds(customer);
      const configuredFormSubmission = isHeliumCreatorFormSubmission(
        formIds,
        config?.heliumCreatorFormId,
      );
      if (configuredFormSubmission) counts.configuredFormSubmissions++;
      const mappedFields = mapMetafieldValues(
        map,
        metafields.values(customer),
      ) || {};
      const customerName = [
        typeof customer.firstName === "string" ? customer.firstName : null,
        typeof customer.lastName === "string" ? customer.lastName : null,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (customerName) {
        mappedFields.legalName ||= customerName;
        mappedFields.creatorDisplayName ||= customerName;
      }
      const input = withHeliumCreatorFormTags(
        {
          customerId: customer.id,
          tags: customer.tags,
          formIds,
          fields: mappedFields,
        },
        config?.heliumCreatorFormId,
      );
      const existingCreator = await findCreatorByCustomerIdentity(shop, customer.id);
      const profileUpdateSubmission =
        Boolean(existingCreator) && isHeliumProfileUpdateFormSubmission(formIds);
      if (!creatorStatusFromTags(input.tags) && !profileUpdateSubmission) {
        counts.customersWithoutCreatorSignal++;
        continue;
      }
      const conflict = hasConflictingCreatorTags(input.tags);
      if (conflict) counts.conflict++;
      const existingApplication = existingCreator?.applicationSource === "HELIUM_IMPORT";
      if (!profileUpdateSubmission) {
        if (existingApplication) counts.applicationUpdate++; else counts.applicationCreate++;
      }
      if (input.fields?.creatorProfilePhoto?.startsWith("gid://")) counts.invalidImageReference++;
      if (!dryRun && !originalStatus && !profileUpdateSubmission)
        await addInitialCreatorTags(client, customer.id);
      const plan = await applyHeliumSync(
        shop,
        {
          customerId: customer.id,
          tags: input.tags,
          formIds: input.formIds,
          fields: input.fields,
        },
        "IMPORT",
        dryRun,
      );
      counts[plan.action.toLowerCase() as "create" | "update" | "skip"]++;
      if (plan.result === "CONFLICT" && !conflict) counts.conflict++;
      if (preview.length < 100)
        preview.push({
          customerId: customer.id,
          action: plan.action,
          status: plan.status,
          conflict,
          reason: plan.reason,
        });
    }
    cursor = result.customers.pageInfo.hasNextPage
      ? result.customers.pageInfo.endCursor
      : null;
  } while (cursor);
  const missingMappings = (
    [
      "legalName",
      "creatorDisplayName",
      "country",
      "city",
      "creatorProfilePhoto",
      "shortCreatorBio",
      "portfolioUrl",
      "socialProfiles",
      "termsAccepted",
      "applicationMessage",
    ] as HeliumField[]
  ).filter((field) => !map[field]);
  if (!dryRun)
    await db.shopConfig.update({
      where: { shop },
      data: { heliumMigrationCompletedAt: new Date() },
    });
  return {
    ...counts,
    applicantsFound: counts.create + counts.update + counts.skip,
    customersWithoutUsableId,
    missingMappings,
    preview,
  };
}

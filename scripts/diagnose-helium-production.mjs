import "dotenv/config";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const shop = "gkd2hy-mf.myshopify.com";
const fingerprint = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 10);

async function graphql(accessToken) {
  return fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query RecentCreatorIntakeDiagnostics {
          customers(first: 20, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id
              tags
              createdAt
              updatedAt
              formIds: metafield(namespace: "customer_fields", key: "form_ids") {
                value
              }
            }
          }
        }`,
    }),
  });
}

async function addPendingTags(accessToken, customerId) {
  const response = await fetch(
    `https://${shop}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `#graphql
          mutation RepairCreatorApplicantTags($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) {
              userErrors { message }
            }
          }`,
        variables: {
          id: customerId,
          tags: ["creator-applicant", "creator-pending"],
        },
      }),
    },
  );
  const body = await response.json();
  if (
    !response.ok ||
    body.errors?.length ||
    body.data?.tagsAdd?.userErrors?.length
  ) {
    throw new Error("Verified creator applicant tag repair failed.");
  }
}

try {
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session) throw new Error("Offline Shopify session is missing.");

  let response = await graphql(session.accessToken);
  let activeAccessToken = session.accessToken;
  let tokenRefreshed = false;
  if (response.status === 401 && session.refreshToken) {
    const refreshed = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: process.env.SHOPIFY_API_KEY || "",
          client_secret: process.env.SHOPIFY_API_SECRET || "",
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        }),
      },
    );
    const tokens = await refreshed.json();
    if (!refreshed.ok || !tokens.access_token || !tokens.refresh_token) {
      console.log(JSON.stringify({
        tokenRefreshed: false,
        refreshStatus: refreshed.status,
        requiresAppReopen: true,
      }, null, 2));
      process.exitCode = 1;
    } else {
      const now = Date.now();
      await db.session.update({
        where: { id: session.id },
        data: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope || session.scope,
          expires: new Date(now + Number(tokens.expires_in) * 1000),
          refreshTokenExpires: new Date(
            now + Number(tokens.refresh_token_expires_in) * 1000,
          ),
        },
      });
      tokenRefreshed = true;
      activeAccessToken = tokens.access_token;
      response = await graphql(activeAccessToken);
    }
  }

  if (!response.ok) {
    console.log({
      tokenRefreshed,
      graphqlStatus: response.status,
      requiresAppReopen: response.status === 401,
    });
    process.exitCode = 1;
  } else {
    const body = await response.json();
    if (body.errors?.length) {
      console.log(JSON.stringify({
        tokenRefreshed,
        graphqlErrorCodes: body.errors.map(
          (error) => error.extensions?.code || "UNKNOWN",
        ),
      }, null, 2));
      process.exitCode = 1;
    } else {
      const ids = body.data.customers.nodes.map((customer) => customer.id);
      const creators = await db.creator.findMany({
        where: { shop, customerId: { in: ids } },
        select: { customerId: true, status: true },
      });
      const known = new Map(
        creators.map((creator) => [creator.customerId, creator.status]),
      );
      const repairCandidates = body.data.customers.nodes.filter((customer) => {
        let formIds = [];
        try {
          const parsed = JSON.parse(customer.formIds?.value || "[]");
          formIds = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          formIds = String(customer.formIds?.value || "")
            .split(",")
            .map((value) => value.trim());
        }
        const hasCreatorTag = customer.tags.some((tag) =>
          tag.toLowerCase().startsWith("creator-"),
        );
        return (
          formIds.includes("lXteLY") &&
          !hasCreatorTag &&
          !known.has(customer.id)
        );
      });
      if (process.argv.includes("--repair")) {
        for (const customer of repairCandidates) {
          await addPendingTags(activeAccessToken, customer.id);
        }
      }
      console.log({
        tokenRefreshed,
        repairRequested: process.argv.includes("--repair"),
        repairedApplicants: process.argv.includes("--repair")
          ? repairCandidates.map((customer) => fingerprint(customer.id))
          : [],
        repairCandidateCount: repairCandidates.length,
        recentCustomers: body.data.customers.nodes.map((customer) => ({
          fingerprint: fingerprint(customer.id),
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          creatorTags: customer.tags.filter((tag) =>
            tag.toLowerCase().startsWith("creator-"),
          ),
          formIds: customer.formIds?.value || null,
          localStatus: known.get(customer.id) || null,
        })),
      });
    }
  }
} finally {
  await db.$disconnect();
}

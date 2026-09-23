import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { CreatorStatus, ReferralAttributionStatus } from "@prisma/client";
import {
  AdminStyles,
  SafeAdminError,
  StatusBadge,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from "../services/admin-notifications.server";
import {
  approveCreatorApplication,
  rejectCreatorApplication,
} from "../services/creator-application.server";
import { changeCreatorStatus, reactivateCreator } from "../services/creator.server";
import {
  referralEarningsGeneratedByCreator,
  referralFinancialsForCreatorAdmin,
} from "../services/creator-referral-earnings.server";
import { getCreatorUnifiedEarningsSummary } from "../services/creator-sales.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] as const;
const DEFAULT_CREATOR_PAGE_SIZE = 10;
const CREATOR_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

function parsePositiveInteger(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type ReferralAttributionView = {
  id: string;
  status: ReferralAttributionStatus;
  shopifyCustomerId: string;
  referrerCreatorId: string;
  referralCodeSnapshot: string;
  capturedAt: Date;
  convertedAt: Date | null;
  referrerCreator: {
    id: string;
    displayName: string;
    referralCode: string;
  } | null;
};

type ReferralInfo = {
  source: "ATTRIBUTION" | "CREATOR_RELATION" | null;
  referrerId: string | null;
  referrerName: string | null;
  referralCodeSnapshot: string | null;
  currentReferrerCode: string | null;
  status: ReferralAttributionStatus | null;
  capturedAt: Date | null;
  convertedAt: Date | null;
  inconsistent: boolean;
};

function parseJsonList(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "Not submitted";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function timeAgo(date: Date | string) {
  const value = new Date(date);
  const seconds = Math.max(1, Math.floor((Date.now() - value.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function titleCase(value: string) {
  return value[0] + value.slice(1).toLowerCase();
}

function totalsLabel(
  totals: Array<{ original: string; adjustments: string; final: string }> | undefined,
  field: "original" | "adjustments" | "final",
) {
  return totals?.map((total) => total[field]).filter(Boolean).join(" + ") || "0.00 kr";
}

function statusTabLabel(value: "ALL" | CreatorStatus) {
  if (value === "ALL") return "All";
  if (value === "PENDING") return "Pending";
  if (value === "REJECTED") return "Rejected";
  return titleCase(value);
}

function creatorInitials(name: string | null | undefined) {
  const words = String(name || "CH")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.[0] || "C").toUpperCase();
}

function safeAvatarUrl(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeBannerUrl(value: string | null | undefined) {
  return safeAvatarUrl(value);
}

function socialPlatformKey(value: string | null | undefined) {
  const platform = String(value || "").toLowerCase();
  if (platform.includes("tiktok")) return "tiktok";
  if (platform.includes("youtube")) return "youtube";
  if (platform.includes("instagram")) return "instagram";
  return "social";
}

function referralAttributionForCustomer(
  map: Map<string, ReferralAttributionView>,
  customerId: string,
) {
  return map.get(customerId) || null;
}

function referralInfoForCreator(
  creator: {
    id: string;
    shop: string;
    customerId: string;
    referredByCreatorId: string | null;
    referredByCreator?: { id: string; displayName: string; referralCode: string } | null;
  },
  attribution: ReferralAttributionView | null,
): ReferralInfo {
  if (creator.referredByCreatorId) {
    const convertedAttribution = attribution?.status === "CONVERTED" ? attribution : null;
    const inconsistent = Boolean(
      convertedAttribution &&
        convertedAttribution.referrerCreatorId !== creator.referredByCreatorId,
    );
    if (inconsistent) {
      console.warn("creator_referral_inconsistency_detected", {
        shop: creator.shop,
        creatorId: creator.id,
        attributionId: convertedAttribution?.id,
      });
    }
    return {
      source: "CREATOR_RELATION",
      referrerId: creator.referredByCreatorId,
      referrerName: creator.referredByCreator?.displayName || "Unknown creator",
      referralCodeSnapshot: convertedAttribution?.referralCodeSnapshot || null,
      currentReferrerCode: creator.referredByCreator?.referralCode || null,
      status: convertedAttribution?.status || null,
      capturedAt: convertedAttribution?.capturedAt || null,
      convertedAt: convertedAttribution?.convertedAt || null,
      inconsistent,
    };
  }
  if (attribution?.status === "CAPTURED") {
    return {
      source: "ATTRIBUTION",
      referrerId: attribution.referrerCreatorId,
      referrerName: attribution.referrerCreator?.displayName || "Unknown creator",
      referralCodeSnapshot: attribution.referralCodeSnapshot,
      currentReferrerCode: attribution.referrerCreator?.referralCode || null,
      status: attribution.status,
      capturedAt: attribution.capturedAt,
      convertedAt: attribution.convertedAt,
      inconsistent: false,
    };
  }
  return {
    source: null,
    referrerId: null,
    referrerName: null,
    referralCodeSnapshot: null,
    currentReferrerCode: null,
    status: null,
    capturedAt: null,
    convertedAt: null,
    inconsistent: false,
  };
}

function emptyReferralInfo(): ReferralInfo {
  return {
    source: null,
    referrerId: null,
    referrerName: null,
    referralCodeSnapshot: null,
    currentReferrerCode: null,
    status: null,
    capturedAt: null,
    convertedAt: null,
    inconsistent: false,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rawStatus = (url.searchParams.get("status") || url.searchParams.get("tab"))?.toUpperCase();
  const status = STATUSES.find((item) => item === rawStatus);
  const search = url.searchParams.get("q")?.trim();
  const selectedCreatorId = url.searchParams.get("creator")?.trim() || null;
  const requestedPage = parsePositiveInteger(url.searchParams.get("page"), 1);
  const requestedPageSize = parsePositiveInteger(
    url.searchParams.get("pageSize"),
    DEFAULT_CREATOR_PAGE_SIZE,
  );
  const pageSize = CREATOR_PAGE_SIZE_OPTIONS.includes(
    requestedPageSize as (typeof CREATOR_PAGE_SIZE_OPTIONS)[number],
  )
    ? requestedPageSize
    : DEFAULT_CREATOR_PAGE_SIZE;

  const searchWhere = search
    ? {
        OR: [
          { id: { contains: search, mode: "insensitive" as const } },
          { customerId: { contains: search, mode: "insensitive" as const } },
          { displayName: { contains: search, mode: "insensitive" as const } },
          { legalName: { contains: search, mode: "insensitive" as const } },
          { handle: { contains: search, mode: "insensitive" as const } },
          { emailSnapshot: { contains: search, mode: "insensitive" as const } },
          { primaryProfileUrl: { contains: search, mode: "insensitive" as const } },
          { portfolioUrl: { contains: search, mode: "insensitive" as const } },
          { bio: { contains: search, mode: "insensitive" as const } },
          { socialLinksJson: { contains: search, mode: "insensitive" as const } },
          { referralCode: { contains: search, mode: "insensitive" as const } },
          {
            referredByCreator: {
              is: { displayName: { contains: search, mode: "insensitive" as const } },
            },
          },
        ],
      }
    : {};

  const where = {
    shop: session.shop,
    ...(status ? { status } : {}),
    ...searchWhere,
  };

  const [creatorTotal, counts, notifications, unreadNotifications] = await Promise.all([
    db.creator.count({ where }),
    db.creator.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
    db.adminNotification.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    db.adminNotification.count({ where: { shop: session.shop, readAt: null } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(creatorTotal / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const creators = await db.creator.findMany({
    where,
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: {
      _count: {
        select: {
          submissions: true,
          creatorProducts: true,
          sales: true,
        },
      },
      referredByCreator: {
        select: {
          id: true,
          displayName: true,
          referralCode: true,
        },
      },
      marketplaceCollection: {
        select: {
          publicHandle: true,
          bannerImageUrl: true,
          bannerTitle: true,
          bannerSubtitle: true,
          bannerUpdatedAt: true,
        },
      },
    },
  });

  const creatorCustomerIds = creators.map((creator) => creator.customerId);
  const creatorAttributions = creatorCustomerIds.length
    ? await db.referralAttribution.findMany({
        where: {
          shop: session.shop,
          shopifyCustomerId: { in: creatorCustomerIds },
        },
        include: {
          referrerCreator: {
            select: {
              id: true,
              displayName: true,
              referralCode: true,
            },
          },
        },
      })
    : [];
  const attributionByCustomer = new Map(
    creatorAttributions.map((attribution) => [
      attribution.shopifyCustomerId,
      attribution as ReferralAttributionView,
    ]),
  );

  const selectedCreator = selectedCreatorId
    ? await db.creator.findFirst({
        where: { shop: session.shop, id: selectedCreatorId },
        include: {
          referredByCreator: {
            select: {
              id: true,
              displayName: true,
              referralCode: true,
            },
          },
          _count: {
            select: {
              creatorProducts: true,
              submissions: true,
              sales: true,
              referredCreators: true,
            },
          },
          marketplaceCollection: {
            select: {
              publicHandle: true,
              bannerImageUrl: true,
              bannerTitle: true,
              bannerSubtitle: true,
              bannerUpdatedAt: true,
            },
          },
        },
      })
    : null;
  const selectedAttribution = selectedCreator
    ? ((await db.referralAttribution.findUnique({
        where: {
          shop_shopifyCustomerId: {
            shop: session.shop,
            shopifyCustomerId: selectedCreator.customerId,
          },
        },
        include: {
          referrerCreator: {
            select: {
              id: true,
              displayName: true,
              referralCode: true,
            },
          },
        },
      })) as ReferralAttributionView | null)
    : null;
  const [referralCounts, referredCreators] = selectedCreator
    ? await Promise.all([
        db.creator.groupBy({
          by: ["status"],
          where: {
            shop: session.shop,
            referredByCreatorId: selectedCreator.id,
          },
          _count: { _all: true },
        }),
        db.creator.findMany({
          where: {
            shop: session.shop,
            referredByCreatorId: selectedCreator.id,
          },
          orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
          take: 25,
          select: {
            id: true,
            displayName: true,
            status: true,
            customerId: true,
            submittedAt: true,
            createdAt: true,
          },
        }),
      ])
    : [[], []];
  const referredAttributions = referredCreators.length
    ? await db.referralAttribution.findMany({
        where: {
          shop: session.shop,
          shopifyCustomerId: {
            in: referredCreators.map((creator) => creator.customerId),
          },
        },
        select: {
          shopifyCustomerId: true,
          referralCodeSnapshot: true,
          status: true,
          capturedAt: true,
          convertedAt: true,
          referrerCreatorId: true,
        },
      })
    : [];
  const referredAttributionByCustomer = new Map(
    referredAttributions.map((attribution) => [attribution.shopifyCustomerId, attribution]),
  );

  const selectedReferral = selectedCreator
    ? referralInfoForCreator(selectedCreator, selectedAttribution)
    : emptyReferralInfo();
  const [selectedReferralFinancials, selectedGeneratedFinancials, selectedUnifiedEarnings] = selectedCreator
    ? await Promise.all([
        referralFinancialsForCreatorAdmin({
          shop: session.shop,
          creatorId: selectedCreator.id,
          page: 1,
          pageSize: 10,
        }),
        referralEarningsGeneratedByCreator({
          shop: session.shop,
          creatorId: selectedCreator.id,
          page: 1,
          pageSize: 10,
        }),
        getCreatorUnifiedEarningsSummary({
          shop: session.shop,
          creatorId: selectedCreator.id,
        }),
      ])
    : [null, null, null];

  return {
    creators: creators.map((creator) => ({
      ...creator,
      referralInfo: referralInfoForCreator(
        creator,
        referralAttributionForCustomer(attributionByCustomer, creator.customerId),
      ),
    })),
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
    notifications: notifications.map((item) => ({
      id: item.id,
      title: item.title,
      message: item.message,
      time: timeAgo(item.createdAt),
      unread: !item.readAt,
      actionUrl: item.actionUrl || "/app/creators",
    })),
    search: search || "",
    tab: status || "ALL",
    pagination: {
      page,
      pageSize,
      total: creatorTotal,
      totalPages,
      start: creatorTotal ? (page - 1) * pageSize + 1 : 0,
      end: Math.min(page * pageSize, creatorTotal),
      pageSizeOptions: CREATOR_PAGE_SIZE_OPTIONS,
    },
    unreadNotifications,
    selectedCreator,
    selectedReferral,
    selectedReferralFinancials,
    selectedGeneratedFinancials,
    selectedUnifiedEarnings,
    referralSummary: Object.fromEntries(
      referralCounts.map((row) => [row.status, row._count._all]),
    ),
    referredCreators: referredCreators.map((creator) => ({
      ...creator,
      attribution: referredAttributionByCustomer.get(creator.customerId) || null,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const creatorId = String(form.get("creatorId") || "");
  const reason = String(form.get("reason") || "");
  const client = new AdminGraphqlClient(admin);

  if (intent === "MARK_NOTIFICATION_READ") {
    await markAdminNotificationRead(session.shop, String(form.get("notificationId") || ""));
    return { ok: true, message: "Notification marked as read." };
  }
  if (intent === "MARK_ALL_NOTIFICATIONS_READ") {
    await markAllAdminNotificationsRead(session.shop);
    return { ok: true, message: "Notifications marked as read." };
  }

  if (!creatorId) throw new Response("Creator is required", { status: 400 });

  if (intent === "APPROVE") {
    await approveCreatorApplication(session.shop, creatorId, client);
    return { ok: true, message: "Creator approved." };
  }
  if (intent === "REJECT") {
    await rejectCreatorApplication(session.shop, creatorId, reason, client);
    return { ok: true, message: "Creator rejected." };
  }
  if (intent === "SUSPEND") {
    await changeCreatorStatus(session.shop, creatorId, "SUSPENDED", client, reason || "Suspended by admin");
    return { ok: true, message: "Creator suspended." };
  }
  if (intent === "REACTIVATE") {
    await reactivateCreator(session.shop, creatorId, client);
    return { ok: true, message: "Creator reactivated." };
  }
  throw new Response("Invalid action", { status: 400 });
}

export default function Creators() {
  const {
    creators,
    counts,
    notifications,
    referredCreators,
    referralSummary,
    search,
    selectedCreator,
    selectedGeneratedFinancials,
    selectedReferral,
    selectedReferralFinancials,
    selectedUnifiedEarnings,
    pagination,
    tab,
    unreadNotifications,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setSearchParams] = useSearchParams();
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const needsAttention = Number(counts.REJECTED || 0) + Number(counts.SUSPENDED || 0);
  const hasClearableFilters = Boolean(
    search || tab !== "ALL" || params.get("q") || params.get("status") || params.get("tab"),
  );

  function setStatusFilter(status: "ALL" | CreatorStatus) {
    const next = new URLSearchParams(params);
    next.delete("tab");
    next.delete("creator");
    next.delete("page");
    if (status === "ALL") {
      next.delete("status");
    } else {
      next.set("status", status.toLowerCase());
    }
    setSearchParams(next, { replace: true });
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams(), { replace: true });
  }

  function setCreatorPage(page: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    next.set("pageSize", String(pagination.pageSize));
    setSearchParams(next, { replace: true });
  }

  function setCreatorPageSize(pageSize: string) {
    const next = new URLSearchParams(params);
    next.delete("page");
    next.set("pageSize", pageSize);
    setSearchParams(next, { replace: true });
  }

  const creatorPages = Array.from({ length: pagination.totalPages }, (_, index) => index + 1).filter(
    (page) =>
      pagination.totalPages <= 5 ||
      page === 1 ||
      page === pagination.totalPages ||
      Math.abs(page - pagination.page) <= 1,
  );
  const selectedBannerUrl = safeBannerUrl(
    selectedCreator?.marketplaceCollection?.bannerImageUrl,
  );

  return (
    <s-page heading="Creators">
      <AdminStyles />
      <div className="creator-admin-page">
        <header className="creator-admin-header">
          <div>
            <span className="creator-admin-eyebrow">Creator operations</span>
            <h1>Creators</h1>
            <p>
              Manage every creator account from one table. Pending, approved,
              rejected, and suspended creators all stay here as one source of truth.
            </p>
          </div>
          <div className="creator-admin-header-actions">
            <details className="admin-notification-menu creator-notification-menu">
              <summary className="creator-admin-bell" aria-label="Creator notifications">
                <span aria-hidden="true">notifications</span>
                {unreadNotifications ? <strong>{unreadNotifications > 9 ? "9+" : unreadNotifications}</strong> : null}
              </summary>
              <div className="admin-notification-panel">
                <header>
                  <h2>Notifications</h2>
                  {unreadNotifications > 0 ? (
                    <Form method="post">
                      <button type="submit" name="intent" value="MARK_ALL_NOTIFICATIONS_READ">
                        Mark all as read
                      </button>
                    </Form>
                  ) : null}
                </header>
                {notifications.length ? (
                  <div className="admin-notification-list">
                    {notifications.map((item) => (
                      <article
                        className={`admin-notification-item${item.unread ? " is-unread" : ""}`}
                        key={item.id}
                      >
                        <span aria-hidden="true" />
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.message}</p>
                          <small>{item.time}</small>
                        </div>
                        {item.unread ? (
                          <Form method="post">
                            <input type="hidden" name="notificationId" value={item.id} />
                            <button type="submit" name="intent" value="MARK_NOTIFICATION_READ">
                              Read
                            </button>
                          </Form>
                        ) : null}
                        <Link to={item.actionUrl}>Open</Link>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="admin-notification-empty">No notifications yet.</p>
                )}
              </div>
            </details>
          </div>
        </header>

        {actionData && "message" in actionData && (
          <div className="creator-admin-message">{actionData.message}</div>
        )}

        <section className="creator-admin-stats">
          <article className="creator-stat-card--total">
            <span className="creator-icon creator-icon--team" aria-hidden="true" />
            <div>
              <p>Total Creators</p>
              <strong>{total}</strong>
              <small>All creator accounts</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--up">12%</em>
          </article>
          <article className="creator-stat-card--pending">
            <span className="creator-icon creator-icon--pending" aria-hidden="true" />
            <div>
              <p>Pending Review</p>
              <strong>{counts.PENDING || 0}</strong>
              <small>Awaiting admin decision</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--flat">0%</em>
          </article>
          <article className="creator-stat-card--approved">
            <span className="creator-icon creator-icon--success" aria-hidden="true" />
            <div>
              <p>Approved</p>
              <strong>{counts.APPROVED || 0}</strong>
              <small>Live creator accounts</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--up">10%</em>
          </article>
          <article className="creator-stat-card--attention">
            <span className="creator-icon creator-icon--warning" aria-hidden="true" />
            <div>
              <p>Needs Attention</p>
              <strong>{needsAttention}</strong>
              <small>Rejected or suspended</small>
            </div>
            <em className="creator-stat-trend creator-stat-trend--down">5%</em>
          </article>
        </section>

        <section className="creator-admin-toolbar">
          <Form method="get" className="creator-table-search-form">
            <label aria-label="Search creators">
              <span className="creator-mini-icon creator-mini-icon--search" aria-hidden="true" />
              <input name="q" defaultValue={search} placeholder="Search creators by name, email or username..." />
            </label>
            {tab !== "ALL" && <input type="hidden" name="status" value={tab.toLowerCase()} />}
            <input type="hidden" name="pageSize" value={pagination.pageSize} />
            <div className="creator-toolbar-actions">
              <nav className="creator-application-tabs" aria-label="Creator status">
                {(["ALL", ...STATUSES] as Array<"ALL" | CreatorStatus>).map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={tab === item ? "is-active" : ""}
                    onClick={() => setStatusFilter(item)}
                  >
                    {statusTabLabel(item)}
                  </button>
                ))}
              </nav>
              <SubmitButton>Filters</SubmitButton>
              {hasClearableFilters ? (
                <button className="creator-clear-filter" type="button" onClick={clearFilters}>
                  Clear
                </button>
              ) : (
                <button className="creator-clear-filter" type="button" disabled>
                  Clear
                </button>
              )}
            </div>
          </Form>
        </section>

        {selectedCreator ? (
          <section className="creator-admin-panel creator-referral-detail-panel">
            <div className="creator-detail-panel-header">
              <div>
                <span className="creator-admin-eyebrow">Creator detail</span>
                <h2>{selectedCreator.displayName || selectedCreator.legalName || "Unnamed creator"}</h2>
              </div>
              <Link className="creator-clear-filter" to="/app/creators">
                Back to list
              </Link>
            </div>
            <div className="creator-referral-detail-grid">
              <article className="creator-referral-section creator-banner-status-card">
                <h3>Collection Banner</h3>
                {selectedCreator.marketplaceCollection ? (
                  <div className="creator-banner-status">
                    <div className="creator-banner-preview">
                      {selectedBannerUrl ? (
                        <img src={selectedBannerUrl} alt="" />
                      ) : (
                        <span>No banner</span>
                      )}
                    </div>
                    <dl className="creator-detail-list">
                      <dt>Status</dt>
                      <dd>
                        {selectedCreator.marketplaceCollection.bannerImageUrl ? (
                          <span className="creator-referral-chip">Banner configured</span>
                        ) : (
                          <span className="creator-referral-empty">No banner</span>
                        )}
                      </dd>
                      <dt>Title</dt>
                      <dd>{selectedCreator.marketplaceCollection.bannerTitle || "Not set"}</dd>
                      <dt>Subtitle</dt>
                      <dd>{selectedCreator.marketplaceCollection.bannerSubtitle || "Not set"}</dd>
                      <dt>Updated</dt>
                      <dd>{formatDateTime(selectedCreator.marketplaceCollection.bannerUpdatedAt)}</dd>
                    </dl>
                  </div>
                ) : (
                  <p className="creator-referral-empty">No public collection yet.</p>
                )}
              </article>
              <article className="creator-referral-section">
                <h3>Earnings Summary</h3>
                <div className="creator-referral-summary">
                  <span>
                    <strong>{selectedUnifiedEarnings?.productEarnings || "0.00 kr"}</strong>
                    <small>Product Earnings</small>
                  </span>
                  <span>
                    <strong>{selectedUnifiedEarnings?.referralEarnings || "0.00 kr"}</strong>
                    <small>Referral Earnings</small>
                  </span>
                  <span>
                    <strong>{selectedUnifiedEarnings?.totalEarnings || "0.00 kr"}</strong>
                    <small>Total Creator Earnings</small>
                  </span>
                </div>
              </article>
              <article className="creator-referral-section">
                <h3>Referral Relationship</h3>
                {selectedReferral.referrerId ? (
                  <dl className="creator-detail-list">
                    <dt>Referred By</dt>
                    <dd>
                      <Link to={`/app/creators?creator=${selectedReferral.referrerId}`}>
                        {selectedReferral.referrerName || "Unknown creator"}
                      </Link>
                    </dd>
                    <dt>Referral Code Used</dt>
                    <dd>{selectedReferral.referralCodeSnapshot || "Not recorded"}</dd>
                    <dt>Current Referrer Code</dt>
                    <dd>{selectedReferral.currentReferrerCode || "Not available"}</dd>
                    <dt>Stage</dt>
                    <dd>{selectedReferral.status || "Converted creator relationship"}</dd>
                    <dt>Captured</dt>
                    <dd>{formatDateTime(selectedReferral.capturedAt)}</dd>
                    <dt>Converted</dt>
                    <dd>{formatDateTime(selectedReferral.convertedAt)}</dd>
                  </dl>
                ) : (
                  <p className="creator-referral-empty">Direct / No Referral</p>
                )}
                {selectedReferral.inconsistent ? (
                  <p className="referral-warning">
                    Referral attribution and creator relationship disagree. The data was not changed.
                  </p>
                ) : null}
              </article>
              <article className="creator-referral-section">
                <h3>Referral Summary</h3>
                <div className="creator-referral-summary">
                  <span>
                    <strong>{selectedCreator._count.referredCreators}</strong>
                    <small>Total Referred Creators</small>
                  </span>
                  {STATUSES.map((item) => (
                    <span key={item}>
                      <strong>{referralSummary[item] || 0}</strong>
                      <small>{statusTabLabel(item)}</small>
                    </span>
                  ))}
                </div>
              </article>
              <article className="creator-referral-section">
                <h3>Referrer Financial Summary</h3>
                <div className="creator-referral-summary">
                  <span>
                    <strong>{totalsLabel(selectedReferralFinancials?.summary.totals, "original")}</strong>
                    <small>Original 2%</small>
                  </span>
                  <span>
                    <strong>{totalsLabel(selectedReferralFinancials?.summary.totals, "adjustments")}</strong>
                    <small>Refund Adjustments</small>
                  </span>
                  <span>
                    <strong>{totalsLabel(selectedReferralFinancials?.summary.totals, "final")}</strong>
                    <small>Final Entitlement</small>
                  </span>
                </div>
              </article>
              <article className="creator-referral-section">
                <h3>Referral Generated For Referrer</h3>
                {selectedReferral.referrerId ? (
                  <div className="creator-referral-summary">
                    <span>
                      <strong>{totalsLabel(selectedGeneratedFinancials?.summary.totals, "original")}</strong>
                      <small>Original 2%</small>
                    </span>
                    <span>
                      <strong>{totalsLabel(selectedGeneratedFinancials?.summary.totals, "adjustments")}</strong>
                      <small>Refund Adjustments</small>
                    </span>
                    <span>
                      <strong>{totalsLabel(selectedGeneratedFinancials?.summary.totals, "final")}</strong>
                      <small>Final Entitlement</small>
                    </span>
                  </div>
                ) : (
                  <p className="creator-referral-empty">Direct creators do not generate referrer financials.</p>
                )}
              </article>
            </div>
            {selectedReferralFinancials?.rows.length ? (
              <div className="creator-referral-section">
                <h3>Recent Referral Earnings</h3>
                <div className="creator-table-wrap creator-referral-table-wrap">
                  <table className="creator-table creator-referral-table">
                    <thead>
                      <tr>
                        <th scope="col">Referred Creator</th>
                        <th scope="col">CreatorSale</th>
                        <th scope="col">Original</th>
                        <th scope="col">Adjustments</th>
                        <th scope="col">Final</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedReferralFinancials.rows.map((earning) => (
                        <tr key={earning.id}>
                          <td data-label="Referred Creator">
                            {earning.referredCreator?.displayName || "Unknown creator"}
                          </td>
                          <td data-label="CreatorSale">{earning.creatorSale?.id || earning.shopifyOrderId}</td>
                          <td data-label="Original">{earning.originalReferral}</td>
                          <td data-label="Adjustments">{earning.adjustmentsTotal}</td>
                          <td data-label="Final">{earning.finalEntitlement}</td>
                          <td data-label="Status">
                            <span className="creator-referral-chip">{titleCase(earning.status)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <div className="creator-referral-section">
              <h3>Referred Creators</h3>
              {referredCreators.length ? (
                <div className="creator-table-wrap creator-referral-table-wrap">
                  <table className="creator-table creator-referral-table">
                    <thead>
                      <tr>
                        <th scope="col">Creator</th>
                        <th scope="col">Status</th>
                        <th scope="col">Referral Code Used</th>
                        <th scope="col">Captured</th>
                        <th scope="col">Converted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {referredCreators.map((creator) => (
                        <tr key={creator.id}>
                          <td data-label="Creator">
                            <Link to={`/app/creators?creator=${creator.id}`}>
                              {creator.displayName || "Unnamed creator"}
                            </Link>
                          </td>
                          <td data-label="Status">
                            <StatusBadge status={creator.status} />
                          </td>
                          <td data-label="Referral Code Used">
                            {creator.attribution?.referralCodeSnapshot || "Not recorded"}
                          </td>
                          <td data-label="Captured">
                            {formatDateTime(creator.attribution?.capturedAt)}
                          </td>
                          <td data-label="Converted">
                            {formatDateTime(creator.attribution?.convertedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="creator-referral-empty">No referred creators yet.</p>
              )}
            </div>
          </section>
        ) : null}

        <section className="creator-admin-panel">
          {creators.length ? (
            <div className="creator-table-wrap">
              <table className="creator-table">
                <thead>
                  <tr>
                    <th scope="col">Creator</th>
                    <th scope="col">Status</th>
                    <th scope="col">Referred By</th>
                    <th scope="col">Presence</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Activity</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.map((creator) => {
                    const socialLinks = parseJsonList(creator.socialLinksJson);
                    const profileUrl = creator.primaryProfileUrl || creator.portfolioUrl || socialLinks[0] || "";
                    const avatarUrl = safeAvatarUrl(creator.profileImageUrl);
                    const displayName = creator.displayName || creator.legalName || "Unnamed creator";
                    const canOpenProfile = profileUrl.startsWith("https://");
                    const hasCollectionBanner = Boolean(
                      creator.marketplaceCollection?.bannerImageUrl,
                    );
                    return (
                      <tr key={creator.id}>
                        <td data-label="Creator">
                          <div className="creator-table-profile">
                            <span className="creator-avatar-fallback" aria-hidden="true">
                              {creatorInitials(displayName)}
                            </span>
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt=""
                                onError={(event) => {
                                  event.currentTarget.closest(".creator-table-profile")?.classList.add("creator-avatar--fallback");
                                }}
                              />
                            ) : null}
                            <div>
                              <strong>{displayName}</strong>
                              <small>@{creator.handle}</small>
                            </div>
                          </div>
                        </td>
                        <td data-label="Status">
                          <StatusBadge status={creator.status} />
                          {creator.rejectionReason && <small>{creator.rejectionReason}</small>}
                          {creator.suspensionReason && <small>{creator.suspensionReason}</small>}
                        </td>
                        <td data-label="Referred By">
                          {creator.referralInfo.referrerId ? (
                            <div className="creator-referral-cell">
                              <Link to={`/app/creators?creator=${creator.referralInfo.referrerId}`}>
                                {creator.referralInfo.referrerName || "Unknown creator"}
                              </Link>
                              <small>
                                {creator.referralInfo.referralCodeSnapshot ||
                                  creator.referralInfo.currentReferrerCode ||
                                  "Code not recorded"}
                              </small>
                              {creator.referralInfo.inconsistent ? (
                                <span className="creator-referral-chip creator-referral-chip--warning">
                                  Check
                                </span>
                              ) : (
                                <span className="creator-referral-chip">
                                  {creator.referralInfo.status || "Converted"}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="creator-referral-empty">Direct</span>
                          )}
                        </td>
                        <td data-label="Presence">
                          <div className="creator-presence-cell">
                            <span
                              className={`creator-presence-icon creator-presence-icon--${
                                creator.primaryPlatform
                                  ? socialPlatformKey(creator.primaryPlatform)
                                  : "web"
                              }`}
                              aria-hidden="true"
                            />
                            <div>
                              <strong>{creator.primaryPlatform || "Not provided"}</strong>
                              {canOpenProfile ? (
                                <a className="creator-table-link" href={profileUrl} target="_blank" rel="noreferrer">
                                  View profile
                                </a>
                              ) : (
                                <small>Add profile</small>
                              )}
                              <small>
                                {hasCollectionBanner ? "Banner configured" : "No banner"}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td data-label="Joined">
                          <span>{formatDate(creator.submittedAt || creator.createdAt)}</span>
                          <small>{creator.emailSnapshot || "No email snapshot"}</small>
                        </td>
                        <td data-label="Activity">
                          <div className="creator-activity-metrics">
                            <span><strong>{creator._count.creatorProducts}</strong><small>Products</small></span>
                            <span><strong>{creator._count.submissions}</strong><small>Submissions</small></span>
                          </div>
                        </td>
                        <td data-label="Actions">
                          <div className="creator-action-group">
                            <Link className="creator-view-button" to={`/app/creators?creator=${creator.id}`}>
                              View
                            </Link>
                            {creator.status === "PENDING" ? (
                              <>
                                <Form method="post" className="creator-table-action creator-table-action--approve">
                                  <input type="hidden" name="creatorId" value={creator.id} />
                                  <SubmitButton name="intent" value="APPROVE">
                                    Approve
                                  </SubmitButton>
                                </Form>
                                <details className="creator-more-menu">
                                  <summary aria-label={`More actions for ${displayName}`} />
                                  <Form method="post" className="creator-table-action">
                                    <input type="hidden" name="creatorId" value={creator.id} />
                                    <input name="reason" placeholder="Reason" required minLength={3} />
                                    <SubmitButton name="intent" value="REJECT">
                                      Reject
                                    </SubmitButton>
                                  </Form>
                                </details>
                              </>
                            ) : creator.status === "APPROVED" ? (
                              <details className="creator-more-menu">
                                <summary aria-label={`More actions for ${displayName}`} />
                                <Form method="post" className="creator-table-action">
                                  <input type="hidden" name="creatorId" value={creator.id} />
                                  <input name="reason" placeholder="Optional deactivation reason" />
                                  <SubmitButton
                                    name="intent"
                                    value="SUSPEND"
                                    confirmMessage="Deactivate this Creator? Dashboard and marketplace access will be suspended while orders, products, earnings, payouts, and audit history remain preserved."
                                  >
                                    Deactivate
                                  </SubmitButton>
                                </Form>
                              </details>
                            ) : creator.status === "SUSPENDED" ? (
                              <Form method="post" className="creator-table-action creator-table-action--activate">
                                <input type="hidden" name="creatorId" value={creator.id} />
                                <SubmitButton
                                  name="intent"
                                  value="REACTIVATE"
                                  confirmMessage="Reactivate creator? This will restore the creator's access to their dashboard and published marketplace presence."
                                >
                                  Reactivate
                                </SubmitButton>
                              </Form>
                            ) : creator.status === "REJECTED" ? (
                              <details className="creator-more-menu">
                                <summary aria-label={`More actions for ${displayName}`} />
                                <span className="creator-table-subtext">Waiting for creator resubmission</span>
                              </details>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <footer className="creator-table-footer">
                <span>
                  Showing {pagination.start} to {pagination.end} of {pagination.total} creators
                </span>
                <div className="creator-pagination">
                  <button
                    className="creator-pagination-button creator-pagination-button--prev"
                    type="button"
                    disabled={pagination.page <= 1}
                    onClick={() => setCreatorPage(pagination.page - 1)}
                    aria-label="Previous page"
                  />
                  {creatorPages.map((page) => (
                    <button
                      key={page}
                      className={`creator-pagination-number${page === pagination.page ? " is-active" : ""}`}
                      type="button"
                      onClick={() => setCreatorPage(page)}
                      aria-label={`Page ${page}`}
                      aria-current={page === pagination.page ? "page" : undefined}
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    className="creator-pagination-button creator-pagination-button--next"
                    type="button"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setCreatorPage(pagination.page + 1)}
                    aria-label="Next page"
                  />
                </div>
                <label className="creator-page-size">
                  <select
                    aria-label="Creators per page"
                    value={pagination.pageSize}
                    onChange={(event) => setCreatorPageSize(event.currentTarget.value)}
                  >
                    {pagination.pageSizeOptions.map((size) => (
                      <option value={size} key={size}>
                        {size} / page
                      </option>
                    ))}
                  </select>
                </label>
              </footer>
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No creators found</strong>
              <span>Try another status or search term.</span>
            </div>
          )}
        </section>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creators unavailable" />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

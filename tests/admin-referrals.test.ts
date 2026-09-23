import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("admin referral overview is authenticated visibility only", () => {
  const route = readFileSync("app/routes/app.referrals.tsx", "utf8");
  const nav = readFileSync("app/routes/app.tsx", "utf8");

  assert.match(route, /authenticate\.admin\(request\)/);
  assert.doesNotMatch(route, /authenticate\.public/);
  assert.doesNotMatch(route, /proxy\.api/);
  assert.match(nav, /href="\/app\/referrals"/);
  assert.match(route, /Referral Overview/);
  assert.match(route, /Leads/);
  assert.match(route, /Converted Applications/);
  assert.match(route, /No referral earnings have been recorded/);
  assert.match(route, /adminReferralEarningsSummary/);
  assert.match(route, /Referral Earnings/);
  assert.match(route, /Creator Sale Source/);
  assert.doesNotMatch(route, /mark.*PAID|payout|transfer/i);
});

test("admin referral overview keeps scoped filters and creator links", () => {
  const route = readFileSync("app/routes/app.referrals.tsx", "utf8");

  assert.match(route, /url\.searchParams\.get\("q"\)\?\.trim\(\) \|\| ""/);
  assert.match(route, /parseStage\(url\.searchParams\.get\("stage"\)\)/);
  assert.match(route, /parseCreatorStatus\(url\.searchParams\.get\("status"\)\)/);
  assert.match(route, /CAPTURED/);
  assert.match(route, /CONVERTED/);
  assert.match(route, /referralCodeSnapshot: \{ contains: q/);
  assert.match(route, /displayName: \{ contains: q/);
  assert.match(route, /shopifyCustomerId: \{ in: matchingCustomerIds \}/);
  assert.doesNotMatch(route, /normalizeReferralCode|strip|punctuation/);
  assert.match(route, /referredCreatorByCustomer/);
  assert.match(route, /StatusBadge status=\{creator\.status\}/);
  assert.match(route, /\/app\/creators\?creator=\$\{earning\.referrerCreator\.id\}/);
  assert.match(route, /\/app\/creators\?creator=\$\{earning\.referredCreator\.id\}/);
});

test("admin creator list and detail surface referral lifecycle without editing ownership", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(route, /referredByCreator: \{/);
  assert.match(route, /referralAttributionForCustomer/);
  assert.match(route, /referralInfoForCreator/);
  assert.match(route, /creator_referral_inconsistency_detected/);
  assert.match(route, /Referral Relationship/);
  assert.match(route, /Direct \/ No Referral/);
  assert.match(route, /Referral Code Used/);
  assert.match(route, /Current Referrer Code/);
  assert.match(route, /Referral Summary/);
  assert.match(route, /Referred Creators/);
  assert.match(route, /data-label="Referred By"/);
  assert.match(route, /\/app\/creators\?creator=\$\{creator\.id\}/);
  assert.match(styles, /Phase 5 referral admin visibility/);
  assert.match(styles, /\.creator-referral-chip/);
  assert.match(styles, /\.referral-admin-stats/);
  assert.doesNotMatch(route, /Change Referrer|Edit Referrer|name="referredByCreatorId"/);
});

test("admin creator status actions do not mutate referral ownership", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");
  const actionBlock = route.slice(
    route.indexOf("export async function action"),
    route.indexOf("export default function Creators"),
  );

  assert.match(actionBlock, /approveCreatorApplication/);
  assert.match(actionBlock, /rejectCreatorApplication/);
  assert.match(actionBlock, /changeCreatorStatus/);
  assert.match(actionBlock, /reactivateCreator/);
  assert.doesNotMatch(actionBlock, /referredByCreatorId|referralAttribution|ReferralAttribution/);
});

test("referrer detail summary uses canonical creator relationship counts", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");
  const overview = readFileSync("app/routes/app.referrals.tsx", "utf8");

  assert.match(route, /groupBy\(\{[\s\S]*referredByCreatorId: selectedCreator\.id/);
  assert.match(route, /_count: \{[\s\S]*referredCreators: true/);
  assert.match(overview, /groupBy\(\{[\s\S]*referredByCreatorId: \{ not: null \}/);
  assert.match(overview, /creator\.referredByCreatorId !== row\.referrerCreatorId/);
});

test("Phase 7 admin referrals show read-only financial dashboard totals", () => {
  const route = readFileSync("app/routes/app.referrals.tsx", "utf8");

  assert.match(route, /Referral Transactions/);
  assert.match(route, /Base Earning/);
  assert.match(route, /Rate/);
  assert.match(route, /Amount/);
  assert.match(route, /By Referrer/);
  assert.match(route, /By Referred Creator/);
  assert.match(route, /totalsLabel\(financial\.summary\.totals, "final"\)/);
  assert.match(route, /totalsLabel\(financial\.summary\.totals, "original"\)/);
  assert.match(route, /totalsLabel\(creator\.totals, "adjustments"\)/);
  assert.match(route, /earning\.creatorSale\?\.id/);
  assert.match(route, /adminReferralEarningsSummary\(session\.shop, \{ page: earningsPage, pageSize: 25 \}\)/);
  assert.doesNotMatch(route, /name="referralEarningsLaunchAt"|Activate Referral Earnings|activation\/edit/i);
});

test("admin referral dashboard spacing removes summary scrollbars", () => {
  const route = readFileSync("app/routes/app.referrals.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(route, /className="creator-admin-stats referral-admin-stats"/);
  assert.match(route, /creator-table-wrap creator-referral-table-wrap/);
  assert.match(styles, /Referral dashboard final spacing and summary-table fit/);
  assert.match(styles, /\.referral-admin-page \.referral-admin-stats[\s\S]*padding: 12px 0 14px/);
  assert.match(styles, /\.referral-admin-page \.referral-stat-card[\s\S]*grid-template-columns: 56px minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.referral-admin-page \.referral-stat-card[\s\S]*gap: 18px/);
  assert.match(styles, /\.referral-summary-grid \.creator-table-wrap[\s\S]*overflow-x: hidden/);
  assert.match(styles, /\.referral-summary-grid \.creator-table[\s\S]*min-width: 0/);
  assert.match(styles, /\.referral-summary-grid \.creator-table th:nth-child\(4\) \{ width: 20%/);
});

test("Phase 7 creator admin detail includes referral financial summaries", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");

  assert.match(route, /referralFinancialsForCreatorAdmin/);
  assert.match(route, /referralEarningsGeneratedByCreator/);
  assert.match(route, /Referrer Financial Summary/);
  assert.match(route, /Referral Generated For Referrer/);
  assert.match(route, /Recent Referral Earnings/);
  assert.match(route, /Original 2%/);
  assert.match(route, /Final Entitlement/);
  assert.match(route, /Direct creators do not generate referrer financials/);
  assert.doesNotMatch(route, /Change Referrer|Edit Referrer|name="referredByCreatorId"/);
});

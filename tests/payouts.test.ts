import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("manual payout schema is additive and future ready", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260820030000_manual_creator_payouts/migration.sql",
    "utf8",
  );

  assert.match(schema, /model PayoutMethod \{/);
  assert.match(schema, /model Payout \{/);
  assert.match(schema, /model PayoutAllocation \{/);
  assert.match(schema, /enum PayoutStatus/);
  assert.match(schema, /REQUESTED/);
  assert.match(schema, /APPROVED/);
  assert.match(schema, /PROCESSING/);
  assert.match(schema, /PAID/);
  assert.match(schema, /REJECTED/);
  assert.match(schema, /CANCELLED/);
  assert.match(schema, /FAILED/);
  assert.match(schema, /enum PayoutExecutionMode/);
  assert.match(schema, /MANUAL/);
  assert.match(schema, /minimumPayoutMinor\s+BigInt\s+@default\(0\)/);
  assert.doesNotMatch(migration, /UPDATE "CreatorSale"|UPDATE "ReferralEarning"|db push/i);
});

test("payout details use AES-GCM encryption and masked display helpers", () => {
  const helpers = readFileSync("app/services/payouts.ts", "utf8");

  assert.match(helpers, /createCipheriv\("aes-256-gcm"/);
  assert.match(helpers, /createDecipheriv\(\s*"aes-256-gcm"/);
  assert.match(helpers, /crypto\.randomBytes\(12\)/);
  assert.match(helpers, /getAuthTag\(\)/);
  assert.match(helpers, /setAuthTag/);
  assert.match(helpers, /PAYOUT_ENCRYPTION_KEY/);
  assert.match(helpers, /base64:/);
  assert.match(helpers, /emailMask/);
  assert.match(helpers, /IBAN \*\*\*\*/);
  assert.match(helpers, /Bank \*\*\*\*/);
  assert.doesNotMatch(helpers, /password|2FA|twoFactor/i);
});

test("payout amount parser uses integer minor units", () => {
  const helpers = readFileSync("app/services/payouts.ts", "utf8");

  assert.match(helpers, /BigInt\(major\) \* 100n \+ BigInt\(cents\.padEnd\(2, "0"\)\)/);
  assert.match(helpers, /amount <= 0n/);
  assert.match(helpers, /INVALID_PAYOUT_AMOUNT/);
  assert.doesNotMatch(helpers, /parseFloat|Number\(/);
});

test("balance formula supports paid reserved and negative carry-forward", () => {
  const available = (earned: bigint, paid: bigint, reserved: bigint) =>
    earned - paid - reserved;

  assert.equal(available(10_000n, 0n, 0n), 10_000n);
  assert.equal(available(200n, 0n, 0n), 200n);
  assert.equal(available(10_200n, 0n, 0n), 10_200n);
  assert.equal(available(10_200n, 5_000n, 0n), 5_200n);
  assert.equal(available(10_200n, 0n, 5_000n), 5_200n);
  assert.equal(available(10_200n, 4_000n, 2_000n), 4_200n);
  assert.equal(available(6_120n, 10_200n, 0n), -4_080n);
  assert.equal(available(16_120n, 10_200n, 0n), 5_920n);
});

test("payout service preserves manual execution and source allocation boundaries", () => {
  const service = readFileSync("app/services/payouts.server.ts", "utf8");
  const dashboard = readFileSync("app/services/submission.server.ts", "utf8");
  const creatorProxy = readFileSync("app/routes/proxy.api.payouts.tsx", "utf8");
  const adminRoute = readFileSync("app/routes/app.payouts.tsx", "utf8");

  assert.match(service, /getCreatorPayoutBalance/);
  assert.match(service, /PayoutAllocationSourceType\.PRODUCT_EARNING/);
  assert.match(service, /PayoutAllocationSourceType\.REFERRAL_EARNING/);
  assert.match(service, /PayoutStatus\.REQUESTED/);
  assert.match(service, /PayoutStatus\.APPROVED/);
  assert.match(service, /PayoutStatus\.PAID/);
  assert.match(service, /feeMinor: 0n/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /TransactionIsolationLevel\.Serializable/);
  assert.match(service, /PAYOUT_BALANCE_CHANGED/);
  assert.match(dashboard, /payoutDashboardForCreator/);
  assert.match(creatorProxy, /proxyContext\(request\)/);
  assert.doesNotMatch(creatorProxy, /searchParams\.get\(["']creatorId["']\)/);
  assert.match(adminRoute, /authenticate\.admin\(request\)/);
  assert.doesNotMatch(service, /paypal\.com\/v|stripe|wise|transfer\(/i);
});

test("creator dashboard exposes manual payout UI without changing earnings labels", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(block, /data-dashboard-tab-target="withdraw"/);
  assert.match(block, /Available to Withdraw/);
  assert.match(block, /Pending Withdrawal/);
  assert.match(block, /Already Paid/);
  assert.match(block, /Current Total Earnings/);
  assert.match(block, /PayPal Email/);
  assert.match(block, /IBAN/);
  assert.match(block, /Saved Methods/);
  assert.match(block, /Add Payout Method/);
  assert.match(block, /data-payout-method-id/);
  assert.match(block, /data-dashboard-payout-method-cancel/);
  assert.match(block, /data-dashboard-payout-method-modal/);
  assert.match(block, /data-dashboard-payout-method-modal-form/);
  assert.match(block, /data-payout-method-modal-current/);
  assert.match(block, /customhouse-payout-method-modal-grid/);
  assert.match(block, /customhouse-payout-method-default-toggle/);
  assert.match(block, /data-profile-modal-avatar-image/);
  assert.match(block, /data-profile-modal-sidebar-image/);
  assert.match(script, /data-profile-modal-avatar-image/);
  assert.match(script, /showProfileImage\(image, data\.profileImageUrl/);
  assert.match(block, /data-dashboard-payout-methods-empty/);
  assert.match(block, /data-dashboard-payout-request-note/);
  assert.match(block, /type="hidden" name="currency" data-dashboard-payout-currency-select/);
  assert.doesNotMatch(block, />\s*Currency\s*</);
  assert.doesNotMatch(block, /<th scope="col">Action<\/th>/);
  assert.match(script, /PAYOUT_METHODS_ENDPOINT/);
  assert.match(script, /PAYOUTS_ENDPOINT/);
  assert.match(script, /renderPayouts/);
  assert.match(script, /Add a payout method before requesting a withdrawal/);
  assert.match(script, /showDashboardToast/);
  assert.match(script, /Withdrawal request submitted successfully\./);
  assert.match(script, /Payout method updated successfully\./);
  assert.match(script, /method\.status === "VERIFIED"/);
  assert.match(script, /method\.status === "DISABLED"/);
  assert.match(script, /editPayoutMethod/);
  assert.match(script, /closePayoutMethodModal/);
  assert.match(script, /data-dashboard-payout-method-modal-close/);
  assert.match(script, /more_horiz/);
  assert.match(script, /hasAllMethodTypes/);
  assert.match(script, /All payout methods saved/);
  assert.match(script, /Use the 3-dot button on a saved method to edit its details\./);
  assert.match(script, /profile\?\.__customHousePayoutMethods \|\| root\.__customHousePayoutMethods/);
  assert.match(script, /payoutMethodEditDetails/);
  assert.match(script, /setPayoutInputValue\(form, "paypalEmail", editDetails\.paypalEmail\)/);
  assert.match(script, /setPayoutInputValue\(form, "iban", editDetails\.iban\)/);
  assert.doesNotMatch(script, /appendPayoutCell\(row, "Action"/);
  assert.match(script, /option\.selected = Boolean\(method\.isDefault\)/);
  assert.match(script, /button\.dataset\.hasVerifiedPayoutMethod === "false"/);
  assert.match(script, /overview\.totalEarnings/);
  assert.doesNotMatch(script, /Intl\.NumberFormat\("sv-SE"|narrowSymbol/);
});

test("withdrawal dropdown is restricted to verified methods for the authenticated creator scope", () => {
  const service = readFileSync("app/services/payouts.server.ts", "utf8");
  const proxy = readFileSync("app/routes/proxy.api.payouts.tsx", "utf8");
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(proxy, /proxyContext\(request\)/);
  assert.match(proxy, /shop_customerId/);
  assert.match(proxy, /normalizeCustomerGid\(customerId!\)/);
  assert.doesNotMatch(proxy, /body\.creatorId|searchParams\.get\(["']creatorId["']\)/);
  assert.match(service, /creatorId: input\.creatorId/);
  assert.match(service, /shop: input\.shop/);
  assert.match(service, /status: PayoutMethodStatus\.VERIFIED/);
  assert.match(service, /encryptedDetails: true/);
  assert.match(service, /editDetails: editablePayoutMethodDetails/);
  assert.match(dashboard, /const activeMethods = methods\.filter\(\(method\) => method\.status === "VERIFIED"\)/);
  assert.match(dashboard, /select\.disabled = true/);
  assert.match(dashboard, /throw new Error\("Add a payout method before requesting a withdrawal\."\)/);
});

test("payout method save and edit become active without admin verification", () => {
  const service = readFileSync("app/services/payouts.server.ts", "utf8");
  const methodsProxy = readFileSync("app/routes/proxy.api.payout-methods.tsx", "utf8");
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );

  assert.match(service, /status: PayoutMethodStatus\.VERIFIED/);
  assert.match(service, /action: "payout_method\.updated"/);
  assert.match(service, /action: "payout_method\.verified"/);
  assert.match(service, /action: "payout_method\.disabled"/);
  assert.match(service, /const shouldBeDefault = Boolean\(input\.isDefault\) \|\| !existingDefault/);
  assert.match(service, /const shouldBeDefault = input\.isDefault \?\? existing\.isDefault/);
  assert.match(methodsProxy, /shop_customerId/);
  assert.match(methodsProxy, /createPayoutMethod/);
  assert.match(methodsProxy, /updatePayoutMethod/);
  assert.doesNotMatch(methodsProxy, /const type = methodType/);
  assert.match(dashboard, /Payout method saved successfully\./);
  assert.match(dashboard, /payoutMethodId/);
  assert.match(dashboard, /resetPayoutMethodForm\(root\)/);
  assert.doesNotMatch(dashboard, /Admin verification|Waiting for admin verification|sent for verification/);
});

test("admin payout page removes method verification queue and keeps payout history filters", () => {
  const adminRoute = readFileSync("app/routes/app.payouts.tsx", "utf8");

  assert.doesNotMatch(adminRoute, /adminPayoutMethodsSummary/);
  assert.doesNotMatch(adminRoute, /PayoutMethodStatus/);
  assert.doesNotMatch(adminRoute, /<h2>Payout Methods<\/h2>/);
  assert.doesNotMatch(adminRoute, /name="methodStatus"/);
  assert.doesNotMatch(adminRoute, /verify-method/);
  assert.doesNotMatch(adminRoute, /Verify<\/SubmitButton>/);
  assert.doesNotMatch(adminRoute, /disable-method/);
  assert.match(adminRoute, /<h2>Payout History<\/h2>/);
  assert.match(adminRoute, /Default view is All statuses/);
  assert.match(adminRoute, /const PAYOUT_STATUSES/);
  assert.doesNotMatch(adminRoute, /@prisma\/client/);
  assert.match(adminRoute, /payoutId \? adminPayoutDetail/);
  assert.match(adminRoute, /Showing \{summary\.rows\.length\} of \{summary\.total\}/);
  assert.doesNotMatch(adminRoute, /where: \{ shop: session\.shop, status: "PENDING_VERIFICATION" \}/);
});

test("admin payout detail action redirects safely and tolerates snapshot decrypt issues", () => {
  const service = readFileSync("app/services/payouts.server.ts", "utf8");
  const detailRoute = readFileSync("app/routes/app.payouts.$id.tsx", "utf8");
  const adminRoute = readFileSync("app/routes/app.payouts.tsx", "utf8");

  assert.match(adminRoute, /adminPayoutDetail/);
  assert.match(adminRoute, /selectedPayout/);
  assert.match(adminRoute, /role="dialog"/);
  assert.match(adminRoute, /payout-detail-modal/);
  assert.doesNotMatch(adminRoute, /reloadDocument/);
  assert.match(adminRoute, /to=\{`\/app\/payouts\?payoutId=\$\{payout\.id\}`\}/);
  assert.match(adminRoute, /return redirect\("\/app\/payouts"\)/);
  assert.match(adminRoute, /timeZone: "UTC"/);
  assert.match(detailRoute, /timeZone: "UTC"/);
  assert.match(detailRoute, /if \(!payoutId\) return redirect\("\/app\/payouts"\)/);
  assert.match(detailRoute, /adminPayoutDetail/);
  assert.match(detailRoute, /useLoaderData/);
  assert.match(detailRoute, /Payout History Detail/);
  assert.doesNotMatch(detailRoute, /export default function AdminPayoutDetail\(\) \{\s*return null;\s*\}/);
  assert.match(adminRoute, /methodDetailsError/);
  assert.match(adminRoute, /Approved At/);
  assert.match(adminRoute, /Rejected At/);
  assert.match(adminRoute, /Cancelled At/);
  assert.match(service, /try \{\s*methodDetails = decryptPayoutDetails/);
  assert.match(service, /could not be decrypted/);
  assert.doesNotMatch(service, /allocations: payout\.allocations/);
});

test("historical rejected payouts remain queryable through admin filters", () => {
  const service = readFileSync("app/services/payouts.server.ts", "utf8");
  const adminRoute = readFileSync("app/routes/app.payouts.tsx", "utf8");

  assert.match(service, /filters\.status && filters\.status in PayoutStatus/);
  assert.match(service, /status: filters\.status as PayoutStatus/);
  assert.match(service, /orderBy: \{ requestedAt: "desc" \}/);
  assert.match(adminRoute, /<option value="ALL">All<\/option>/);
  assert.match(adminRoute, /PAYOUT_STATUSES\.map/);
  assert.doesNotMatch(service, /deleteMany\(\{[^}]*payout/i);
});

test("payout form select styling uses one clean native-safe border", () => {
  const css = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(css, /customhouse-payout-request-form select/);
  assert.match(css, /appearance: none/);
  assert.match(css, /box-shadow: none/);
  assert.match(css, /background-image: linear-gradient/);
  assert.match(css, /padding-right: 34px/);
});

test("creator payout cards keep readable, deterministic mobile layouts", () => {
  const css = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(
    css,
    /\.customhouse-payout-method-item\s*>\s*\.customhouse-payout-method-icon\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/s,
  );
  assert.match(
    css,
    /\.customhouse-payout-method-item\s*>\s*\.customhouse-payout-method-copy\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s,
  );
  assert.match(
    css,
    /\.customhouse-payout-method-item\s*>\s*\.customhouse-payout-method-badges\s*\{[^}]*grid-column:\s*2\s*\/\s*4;[^}]*grid-row:\s*2;/s,
  );
  assert.match(
    css,
    /\.customhouse-payout-method-item\s*>\s*\.customhouse-payout-method-actions\s*\{[^}]*grid-column:\s*3\s*!important;[^}]*grid-row:\s*1\s*\/\s*span\s*2\s*!important;/s,
  );
  assert.match(
    css,
    /\.customhouse-payout-history-table td\s*\{[^}]*grid-template-columns:\s*82px minmax\(0, 1fr\);[^}]*overflow-wrap:\s*anywhere;/s,
  );
});

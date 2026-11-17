# Final Non-PitchPrint Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the four remaining non-PitchPrint gaps by adding guarded Admin Creator deletion and tamper-resistant Shopify platform validation for Creator production fees and acknowledgements, then release and report the exact live activation state.

**Architecture:** Admin deletion will use a transactional eligibility service that blocks every historical, financial, product, publication, design, referral, and payout dependency while explicitly deleting only the dependency-free CustomHouse profile/application data and preserving the Shopify customer. Creator cart enforcement will be a Shopify CLI-generated Cart and Checkout Validation Function that identifies Creator lines by existing immutable product metafields, consumes one versioned `customhouse.creator_cart_validation` JSON product metafield for expected fee variant/placement data, and pairs lines using the existing `_customhouse_fee_key` plus `_creator_product_id` attributes. The existing preparation service remains price/fee authority; the Function only enforces structural integrity and line-specific acknowledgements.

**Tech Stack:** React Router 7, TypeScript, Prisma/PostgreSQL, Shopify Admin GraphQL 2026-07 conventions, Shopify CLI 4.8.0, Shopify Cart and Checkout Validation Function, Node test runner, Vercel.

**Spec:** `C:/Users/jpcho/.codex/attachments/aa09176b-0124-4f8f-bc18-0d226e19703e/Pasted text.txt`

## Global Constraints

- Work only on the current `development` branch; preserve local commits, merge current `origin/main` into it without reset, and never commit normal work directly to `main`.
- Do not touch PitchPrint templates, events, editor UI, rendering/export, placement detection, or reopening internals.
- Do not redesign or overwrite Header, Footer, Menu, Homepage, or general Collections.
- Preserve Shopify React Router authentication, Prisma session storage, App Bridge, webhook patterns, and Admin GraphQL-only access.
- Never delete the Shopify customer, bulk-change products, or automatically modify existing published Creator products.
- Keep `prepareCreatorProductCart` as the preparation and price authority; the Function validates only canonical product identity, pairing, quantity, and acknowledgement evidence.
- Generate the Function with the installed Shopify CLI and retain its generated current API/target structure; do not hand-create an obsolete Function format.
- Use focused tests during development. Run `npm test`, `npm run typecheck`, and `npm run build` only once after implementation, plus changed-file ESLint, `git diff --check`, and generated Function tests.
- Release only existing Vercel and Shopify app projects. Do not release the storefront theme extension unless its files actually change.
- Do not claim the Shopify Function is live until the checkout rule is enabled and behavior is verified.

## Review Focus

- Two Creator products deliberately reuse the same `_customhouse_fee_key`; each must still require its own canonical fee pairing and quantity.
- A normal product or arbitrary cheap variant carries spoofed Creator/fee attributes; immutable product metafields and expected variant IDs must prevent it satisfying validation.
- A Creator validation contract is missing, malformed, zero-placement, or references a non-fee variant; checkout must fail closed with a concise repair message while normal products remain unaffected.
- A dependency is inserted while Admin deletion is being attempted; the transaction must not silently cascade business history.
- Existing published products predate the new validation metafield; the read-only audit must classify them without mutation, and activation must remain blocked until compatibility is known.

---

### Task 1: Guarded Admin Creator hard deletion

**Files:**
- Create: `tests/creator-deletion.test.ts`
- Modify: `app/services/creator.server.ts`
- Modify: `app/routes/app.creators.tsx`

**Interfaces:**
- Produces: `getCreatorDeletionEligibility(shop: string, creatorId: string, database?: CreatorDeletionDb): Promise<CreatorDeletionEligibility>`.
- Produces: `deleteCreatorPermanently(shop: string, creatorId: string, confirmation: unknown, database?: CreatorDeletionDb): Promise<{ id: string; displayName: string; handle: string }>`.
- `CreatorDeletionEligibility` contains `eligible: boolean`, `blockers: string[]`, and the safe Creator reference.

- [ ] **Step 1: Write failing deletion-service tests**

Add tests proving: dependency-free deletion succeeds; CreatorProduct, CreatorOrderItem, CreatorSale, payout/payout method/allocation, referral relation/attribution/earning, design/submission/session, and collection/publication dependencies block; blocked deletion retains the Creator; success writes `creator.deleted_permanently`; and no Shopify GraphQL/customer deletion call exists.

- [ ] **Step 2: Run deletion tests and verify RED**

Run: `node --experimental-strip-types --test tests/creator-deletion.test.ts`

Expected: FAIL because the eligibility and deletion exports do not exist.

- [ ] **Step 3: Implement transactional eligibility and deletion**

Use actual Prisma relations. Lock/re-read the Creator inside the transaction, count all protected dependencies, and throw `DomainError("CREATOR_DELETE_BLOCKED", "This Creator has historical or financial records and cannot be permanently deleted. Deactivate the Creator instead.", 409)` when any blocker exists. Require confirmation exactly `DELETE`. Explicitly remove only associated CreatorApplication rows, create the independent AuditLog with safe ID/displayName/handle metadata, delete the Creator row, and make no Shopify API call.

- [ ] **Step 4: Run deletion tests and verify GREEN**

Run: `node --experimental-strip-types --test tests/creator-deletion.test.ts`

Expected: all deletion tests PASS.

- [ ] **Step 5: Add the Admin action and strong confirmation UI**

Add `DELETE_PERMANENTLY` handling to the authenticated creators action. Add a danger-zone form with a required `confirmation` input and existing Deactivate guidance; surface the safe blocked message without exposing Prisma details.

- [ ] **Step 6: Add and run focused route contract tests**

Extend `tests/creator-application.test.ts` with assertions for the exact intent, `DELETE` confirmation, blocked guidance, and existing Deactivate action.

Run: `node --experimental-strip-types --test tests/creator-application.test.ts tests/creator-deletion.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add app/services/creator.server.ts app/routes/app.creators.tsx tests/creator-deletion.test.ts tests/creator-application.test.ts
git commit -m "feat: add guarded admin creator deletion"
```

### Task 2: Canonical Creator cart-validation contract

**Files:**
- Modify: `app/services/creator-product-publishing.server.ts`
- Modify: `app/services/creator-products.server.ts`
- Modify: `tests/creator-products.test.ts`
- Modify: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Produces: product metafield `customhouse.creator_cart_validation` of type `json` with `{ version: 1, creatorProductId: string, feeRequired: boolean, feeVariantId: string | null, placementCount: number }`.
- Produces: fee-line attribute `_creator_product_id` while retaining `_customhouse_production_fee`, `_customhouse_parent_product_id`, `_customhouse_parent_project_id`, and `_customhouse_fee_key`.
- Consumes: persisted fixed production method, embroidery subtype, placement count, and existing `PublicProductProductionPricing` fee-variant selection.

- [ ] **Step 1: Write failing contract tests**

Test that publishing writes a versioned JSON contract derived from saved configuration; positive surcharge requires the canonical fee variant; zero surcharge records `feeRequired: false`; malformed/missing required fee configuration fails publication; and prepared fee lines carry the same CreatorProduct ID and existing fee key as the Creator line.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `node --experimental-strip-types --test tests/creator-products.test.ts tests/production-method-pricing.test.ts`

Expected: new assertions FAIL because the JSON metafield and fee-line CreatorProduct ID are absent.

- [ ] **Step 3: Implement the minimal contract producer**

Add a focused helper that resolves the correct fee variant from current pricing without recalculating price. Pass the resolved contract into native product configuration and add the JSON metafield. Preserve all current Creator identity/metafields and cart properties.

- [ ] **Step 4: Add `_creator_product_id` to fee lines**

Modify only server-produced cart metadata; do not redesign the storefront form or touch PitchPrint placement detection.

- [ ] **Step 5: Run contract tests and verify GREEN**

Run: `node --experimental-strip-types --test tests/creator-products.test.ts tests/production-method-pricing.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add app/services/creator-product-publishing.server.ts app/services/creator-products.server.ts tests/creator-products.test.ts tests/production-method-pricing.test.ts
git commit -m "feat: publish creator cart validation contract"
```

### Task 3: Shopify Cart and Checkout Validation Function

**Files:**
- Create with Shopify CLI: `extensions/customhouse-creator-cart-validation/**`
- Modify only generated Function query/source/tests inside that extension.

**Interfaces:**
- Consumes: immutable product metafields `customhouse.product_origin=creator`, `customhouse.design_mode=buy_only`, `customhouse.product_type=creator_fixed`, `customhouse.creator_product_id`, and `customhouse.creator_cart_validation`.
- Consumes Creator-line attributes `_creator_product_id`, `_customhouse_fee_key`, `Customized product acknowledgement`, and `Terms & Conditions`.
- Consumes fee-line immutable `customhouse.product_type=production_fee` and attributes `_creator_product_id`, `_customhouse_production_fee=true`, and `_customhouse_fee_key`.
- Produces: `validationAdd.errors` targeting `$.cart` on `cart.validations.generate.run`.

- [ ] **Step 1: Generate the current official extension scaffold**

Run: `shopify app generate extension --template cart_checkout_validation --name customhouse-creator-cart-validation --flavor typescript`

Expected: CLI-generated Function extension under `extensions/` with current supported API and target. Record the generated API version; do not replace it with an older hand-written version.

- [ ] **Step 2: Write the ten required failing Function fixtures/tests**

Cover: normal-only valid; complete Creator pair valid; missing fee; wrong fee quantity; mismatched pairing; missing non-return; missing Terms; two independently valid pairs; one valid plus one invalid pair; normal mixed with valid Creator. Add Review Focus cases for duplicate fee keys across distinct CreatorProduct IDs, spoofed normal lines, malformed contracts, orphan fee lines, and zero-fee contracts.

- [ ] **Step 3: Run generated Function tests and verify RED**

Run the extension's generated test command from its own package metadata.

Expected: required invalid-cart fixtures FAIL because generated logic does not enforce the contract.

- [ ] **Step 4: Define the exact input query**

Query cart-line ID/quantity, aliased line attributes, ProductVariant ID, and aliased product metafields needed by the Interfaces block. Do not query titles or handles for identity.

- [ ] **Step 5: Implement per-CreatorProduct pairing and acknowledgement validation**

Parse the versioned JSON contract fail-closed. Group Creator and fee lines by the composite `creatorProductId + feeKey`; require the immutable expected fee variant; compare aggregate fee quantity with aggregate Creator quantity multiplied by placement count; reject missing/orphan/mismatched fee lines; require each Creator line's two canonical acceptance attributes; ignore unrelated normal products.

- [ ] **Step 6: Run Function tests and verify GREEN**

Run the extension's generated test command and `shopify app function build --path extensions/customhouse-creator-cart-validation` if supported by CLI 4.8.0.

Expected: all fixtures PASS and Wasm/build succeeds.

- [ ] **Step 7: Commit**

```powershell
git add extensions/customhouse-creator-cart-validation
git commit -m "feat: enforce creator cart integrity in Shopify"
```

### Task 4: Read-only published Creator-product audit

**Files:**
- Create: `scripts/native-marketplace-audit-classifier.ts`
- Modify: `scripts/native-marketplace-audit.ts`
- Create: `tests/native-marketplace-audit.test.ts`
- Modify: `package.json` only if a named read-only audit script is useful.

**Interfaces:**
- Produces: `classifyPublishedCreatorProduct(input): "OK" | "NEEDS_REPUBLISH" | "NEEDS_REPAIR" | "MISSING_MAPPING"` plus issue strings.
- Report fields: CreatorProduct ID, Shopify product ID, fixedColor, fixedProductionMethod, Shopify variant count, fixed-color match result, canonical metafield presence, category.
- Must perform Admin GraphQL reads only and never call mutations.

- [ ] **Step 1: Write failing classifier tests**

Cover all four categories, multilingual color option names, missing Shopify product, wrong-color variants, missing canonical identity markers, and missing/new validation contract.

- [ ] **Step 2: Run classifier tests and verify RED**

Run: `node --experimental-strip-types --test tests/native-marketplace-audit.test.ts`

Expected: FAIL because the classifier does not exist.

- [ ] **Step 3: Implement pure classification and extend the read-only query/report**

Reuse the existing audit script and its authenticated Admin GraphQL read client. Add variant selected options and the canonical cart-validation metafield. Add an explicit no-mutations source test.

- [ ] **Step 4: Run audit tests and verify GREEN**

Run: `node --experimental-strip-types --test tests/native-marketplace-audit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/native-marketplace-audit.ts scripts/native-marketplace-audit-classifier.ts tests/native-marketplace-audit.test.ts package.json
git commit -m "feat: audit published creator cart readiness"
```

### Task 5: Whole-project verification and development release

**Files:**
- No product-code changes unless a failing verification exposes an in-scope defect; any fix must start with a failing regression test.

**Interfaces:**
- Consumes Tasks 1-4.
- Produces verified development commits and deployment evidence.

- [ ] **Step 1: Confirm protected files/security remain untouched**

Run `git diff --name-only <merge-base>..HEAD`, confirm no PitchPrint/Header/Footer/Menu files changed, confirm `public/fonts/fa-solid-500.woff2` and `.vscode/tasks.json` are absent, and run `git diff --check`.

- [ ] **Step 2: Run changed-file ESLint**

Run ESLint only on changed JavaScript/TypeScript/TSX files, excluding generated files according to project conventions.

Expected: zero errors in changed files.

- [ ] **Step 3: Run Function tests/build**

Run the generated extension test command and Function build once more.

Expected: PASS.

- [ ] **Step 4: Run the three requested project commands once**

Run, in order: `npm test`, `npm run typecheck`, `npm run build`.

Expected: all exit 0. Report unrelated historical warnings without changing out-of-scope files.

- [ ] **Step 5: Final source review**

Review the complete branch diff against the approved spec, with special attention to all Review Focus inputs and Function fail-closed behavior.

- [ ] **Step 6: Push `development` and verify its test deployment**

Push the existing `development` branch. Confirm the existing Vercel project receives the commit and health endpoint is healthy. Do not create a project.

- [ ] **Step 7: Commit any verification-only metadata if required**

Do not create empty or evidence-only commits.

### Task 6: Production release, activation gate, and live report

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: verified development release and read-only audit results.
- Produces: production Vercel deployment ID, Shopify app release/version, Function activation state, and exact blocked live checks.

- [ ] **Step 1: Run the read-only published-product audit against the target shop**

Record category counts without modifying Shopify products. If incompatible existing Creator products would be blocked by activation, leave the rule disabled and report the exact IDs/categories requiring merchant-approved republish/repair.

- [ ] **Step 2: Merge approved development into `main` without resetting history**

Validate the merge contains only reviewed commits, push `main`, and allow the existing Vercel production project to deploy.

- [ ] **Step 3: Verify Vercel production**

Record deployment ID/commit/domain and verify the health endpoint and guarded email route availability.

- [ ] **Step 4: Deploy the existing Shopify app release**

Run the existing production-config Shopify app deploy so the new Function extension is included. Record the release/version. Do not deploy the theme extension unless its source changed.

- [ ] **Step 5: Activate and verify the checkout rule only when safe**

Use authenticated Shopify Admin `Settings > Checkout > Checkout rules` to add/enable `customhouse-creator-cart-validation`, or use the current Admin `validationCreate` API only if the app already has merchant-approved `write_validations` scope. Do not expand scopes/reinstall silently. If authentication or compatibility blocks activation, stop and report `SHOPIFY_FUNCTION_ACTIVATION = LIVE_VERIFICATION_BLOCKED` with the exact one-time Admin step.

- [ ] **Step 6: Perform safe live checks without a paid order**

Check valid Creator cart, missing fee, manipulated fee quantity, missing each acknowledgement, and a normal product. Verify Admin deletion UI/blocking using designated safe test records only. Verify Creator Application optional fields if storefront access exists, Welcome Email badge/configuration without sending unsolicited email, and malicious font URL 404.

- [ ] **Step 7: Produce the exact requested final report**

Include changed files, dependency rules, Function name/API/target/activation, pairing/quantity rules, acknowledgement property names, audit counts, every test command/result, deployment/release IDs, all blocked live checks, PitchPrint-deferred items, untouched confirmations, and the required final sentence.

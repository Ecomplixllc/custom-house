# Creator Save Color Route Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the one canonical PitchPrint garment color through the exact storefront Save Design request and the production Creator Product route.

**Architecture:** Treat non-empty PitchPrint color evidence as one logical selection while preventing empty wrapper aliases from overwriting a valid nested Creator setup. Build the request with a pure exported boundary function, dispatch it through the same route helper used by production, and keep server-side canonicalization authoritative against base-product variants.

**Tech Stack:** JavaScript storefront extension, TypeScript React Router actions, Prisma-style service dependencies, Node test runner.

**Spec:** `C:/Users/jpcho/.codex/attachments/cbb37332-8c94-467e-bf91-c0f29df87015/Pasted text.txt`

## Global Constraints

- Work only on `development`; deploy a development preview and stop for manual approval.
- Do not modify PitchPrint, the checkout Function, checkout-rule state, pricing, or unrelated UI.
- Keep the exactly-one-fixed-color business rule and validate the canonical color against base-product variants.
- Never log PII, secrets, artwork, preview payloads, or signed URLs.
- Do not create duplicate Creator Product drafts.

## Review Focus

- A valid nested Navy color plus empty outer aliases must resolve to exactly one Navy.
- Outer current Navy must still replace a stale nested Gray value.
- Case variants and duplicate aliases must collapse before counting.
- Available base colors must never be counted as selected colors.
- Missing, conflicting, or unavailable colors must continue to fail clearly.

---

### Task 1: Pin the Production Event and Request Boundary

**Files:**
- Modify: `tests/creator-dashboard.test.ts`
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`

**Interfaces:**
- Consumes: raw `CUSTOMHOUSE_PP_CREATOR_SETUP_READY` event plus PitchPrint save event and Creator Product.
- Produces: `buildCreatorSavePayload(product, setupEvent, saveEvent)` containing one canonical nested `creatorSetup.fixedColor` and `selectedColors` value.

- [ ] **Step 1: Add a failing test for a nested Navy setup wrapped by empty outer color aliases**

Assert that event normalization and the real save-payload builder produce `fixedColor: "Navy"`, `selectedColor: "Navy"`, and `selectedColors: ["Navy"]`.

- [ ] **Step 2: Run the focused dashboard test and verify it fails because the outer empty aliases erase Navy**

Run: `node --experimental-strip-types --test --test-name-pattern="nested Navy.*empty outer" tests/creator-dashboard.test.ts`

- [ ] **Step 3: Implement meaningful-value precedence and extract the production payload builder**

Merge nested and outer setup without allowing empty strings/arrays to erase a non-empty canonical color; keep a non-empty outer current color authoritative over stale nested data. Replace the closure-only request builder with the exported pure boundary function used by the runtime manager.

- [ ] **Step 4: Run the focused dashboard tests and verify they pass**

- [ ] **Step 5: Commit the completed boundary task**

### Task 2: Exercise the Actual Creator Product Route with the Live-Shaped Body

**Files:**
- Create: `tests/creator-product-save-route.test.ts`
- Modify: `app/routes/proxy.api.creator-products.$id.tsx`
- Modify: `app/services/creator-products.server.ts`
- Modify: `tests/creator-products.test.ts`

**Interfaces:**
- Consumes: the exact body emitted by `buildCreatorSavePayload` and authenticated `{shop, customerId}` route context.
- Produces: successful route JSON with persisted `designVariantSelectionsJson.fixedColor === "Navy"` and logical color count `1`.

- [ ] **Step 1: Add a failing route-dispatch integration test**

Use a complete live-shaped body with nested Navy, empty outer aliases, duplicate/case aliases, stale Gray persisted state, and base colors `[White, Gray, Navy, Black]`. Assert HTTP/action success, one updated draft, no duplicate draft, and persisted canonical Navy.

- [ ] **Step 2: Run the route test and verify the current path returns `CREATOR_COLOR_REQUIRED`**

- [ ] **Step 3: Add one canonical fixed-color resolver and route dispatcher seam**

Implement `resolveCanonicalCreatorFixedColor(...)` in the Creator Product service and use it for Save Design plus persisted setup validation consumed by submit and publishing. Export a route dispatcher used unchanged by the production `action`, allowing the integration test to keep authentication external while exercising the real body dispatch and service.

- [ ] **Step 4: Add sanitized structured diagnostics at the exact save boundary**

Log only Creator Product ID, canonical color, logical count, and validation stage under the requested `CREATOR_SAVE_*` event names. Keep failure diagnostics low-noise and exclude payloads, artwork, previews, customer identity, and URLs.

- [ ] **Step 5: Run route and service regression tests**

Cover outer+nested aliases, casing, stale Gray to Navy, base-color separation, missing color, conflicting colors, invalid base color, submit, publish setup, and duplicate prevention.

- [ ] **Step 6: Commit the completed server/route task**

### Task 3: Verify and Release to Development Only

**Files:**
- Modify only if verification exposes a defect in Task 1 or Task 2 files.

**Interfaces:**
- Consumes: completed route and service fix.
- Produces: pushed `development` commit and healthy Vercel development preview; no production release.

- [ ] **Step 1: Run focused tests, changed-file ESLint, and `git diff --check`**

- [ ] **Step 2: Run `npm test`, `npm run typecheck`, and `npm run build` once**

- [ ] **Step 3: Verify checkout Function source/config hashes are unchanged**

- [ ] **Step 4: Commit and push `development`**

- [ ] **Step 5: Verify development preview health**

- [ ] **Step 6: Perform one development manual QA through Save Design and Edit Design**

Confirm Embroidery, Text only, Navy, artwork rendering, successful Save Design, persisted Navy, one My Products draft, and Edit Design restoration. Do not place an order.

- [ ] **Step 7: Stop and report for production approval**


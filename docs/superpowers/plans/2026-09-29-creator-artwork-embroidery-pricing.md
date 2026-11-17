# Creator Artwork Preview and Embroidery Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist canonical PitchPrint project renders and saved artwork facts so Creator previews, Embroidery subtype pricing, placement quantities, publishing, and production metadata are correct end to end.

**Architecture:** Tighten the existing `project-saved` boundary instead of adding a second integration. The browser forwards only canonical PitchPrint save fields; the server parses bounded saved-source metadata, derives artwork type and placements, persists normalized facts in the existing CreatorProduct setup JSON, and reuses existing pricing/publishing/cart contracts.

**Tech Stack:** TypeScript, browser ES modules, React Router app-proxy routes, Prisma/PostgreSQL, Shopify Admin GraphQL, Shopify theme app extension, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-29-creator-artwork-embroidery-pricing-design.md`

## Global Constraints

- Preserve Shopify authentication, Prisma sessions, App Bridge, webhooks, and Admin GraphQL-only patterns.
- Never expose credentials, raw GraphQL errors, customer IDs supplied by browsers, or unsanitized PitchPrint source data.
- Reuse `CreatorProduct.designVariantSelectionsJson`, `previewUrl`, and `previewUrls`; do not add duplicate schema fields.
- Reuse existing Embroidery Text/Image price columns and fee variants; never hardcode monetary values.
- Do not change the checkout Function unless a failing integration contract test proves it necessary.
- Keep Add Product color removal, method selection, public customization, referrals, payouts, email, application, footer, menu, and unrelated UI unchanged.
- Do not call an undocumented PitchPrint API.

## Review Focus

- Malformed or oversized `source` must fail recoverably without persisting a partial design.
- Generic screenshot-like `preview`, `url`, or `src` fields must never become production previews.
- Mixed text and image objects must resolve to `IMAGE_OR_LOGO`, even if the browser claims `TEXT_ONLY`.
- Surface order and labels must remain distinct through save, edit, and review; Front must not be reused for Back.
- Zero or unsynced subtype pricing must block fee-bearing publication/cart preparation without changing DTF/DTG.

---

### Task 1: Canonical PitchPrint Save Fixture and Browser Normalization

**Files:**
- Modify: `tests/creator-dashboard.test.ts`
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`

**Interfaces:**
- Consumes: documented `project-saved` payload containing `data.projectId`, `data.previews`, `data.source`, `data.numPages`, and `data.meta`.
- Produces: `normalizePitchPrintSaveEvent(value)` returning project/design identity, canonical previews, bounded raw saved source, page count, and surface metadata without generic image fallbacks.

- [ ] **Step 1: Add a realistic canonical `project-saved` fixture and failing tests**

  Test that `data.previews` are retained in order, Front and Back remain distinct, `source` is forwarded for server classification, and generic `preview`/`url`/`src` screenshot candidates are ignored.

- [ ] **Step 2: Run the focused dashboard tests and verify the new assertions fail for the current broad fallback behavior**

  Run: `node --test --import tsx tests/creator-dashboard.test.ts`
  Expected: FAIL because screenshot candidates are accepted and saved-source facts are absent.

- [ ] **Step 3: Implement the minimal strict normalizer and sanitized diagnostics**

  Prefer only documented canonical save fields. Log booleans, counts, type names, and surface names; never raw source, IDs, tokens, or URLs.

- [ ] **Step 4: Run the focused dashboard tests and verify they pass**

  Run: `node --test --import tsx tests/creator-dashboard.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "fix: use canonical PitchPrint project previews"`

### Task 2: Server-Side Artwork Classification and Placement Derivation

**Files:**
- Create: `app/services/pitchprint-project-metadata.ts`
- Modify: `app/services/creator-products.server.ts`
- Modify: `tests/creator-products.test.ts`

**Interfaces:**
- Consumes: bounded `source`, canonical preview records, method, color, project/design identity, and required confirmation.
- Produces: `classifyPitchPrintProjectSource(source: unknown): { embroiderySubtype: "TEXT_ONLY" | "IMAGE_OR_LOGO"; placements: string[]; placementCount: number; objectCounts: { text: number; image: number } }` and normalized surface previews persisted in CreatorProduct setup JSON.

- [ ] **Step 1: Add failing table-driven classification tests**

  Cover Textbox-only -> `TEXT_ONLY`, uploaded/raster/vector image -> `IMAGE_OR_LOGO`, text plus image -> `IMAGE_OR_LOGO`, empty/unknown source -> recoverable error, Front only -> 1, Front+Back -> 2, and malformed/oversized input rejection.

- [ ] **Step 2: Add failing CreatorProduct attachment tests**

  Assert the server ignores a claimed cheaper subtype, derives subtype and placement count from saved objects, persists fixed color/method/project/design identity, stores distinct side previews, and recomputes values when Edit Design saves changed source.

- [ ] **Step 3: Run focused CreatorProduct tests and confirm the expected failures**

  Run: `node --test --import tsx tests/creator-products.test.ts`
  Expected: FAIL because there is no source classifier and subtype remains optional.

- [ ] **Step 4: Implement bounded source parsing and server-authoritative derivation**

  Enforce byte, depth, object-count, prototype-key, URL, and supported-object-kind limits. Ignore the submitted subtype; derive it from normalized object kinds. Use saved printable surfaces for placements rather than thumbnail count.

- [ ] **Step 5: Tighten final save and completion validation**

  Require canonical project previews, valid project identity, valid color/method, at least one placement, required confirmation, and resolved Embroidery subtype. Preserve the draft on failure.

- [ ] **Step 6: Run focused CreatorProduct tests and verify they pass**

  Run: `node --test --import tsx tests/creator-products.test.ts`
  Expected: PASS.

- [ ] **Step 7: Commit**

  `git commit -m "fix: derive creator artwork metadata on save"`

### Task 3: Review UI Uses Persisted Surface Renders and Derived Artwork Type

**Files:**
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`
- Modify: `extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid` only if semantic markup is missing
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse.css` only if existing thumbnail states cannot express the behavior
- Modify: `tests/creator-dashboard.test.ts`

**Interfaces:**
- Consumes: persisted normalized surface previews and server-derived `embroiderySubtype` from the returned CreatorProduct.
- Produces: review main image and thumbnails whose selected surface changes the main image, plus a nonblank Embroidery label only for Embroidery.

- [ ] **Step 1: Add failing behavior tests for review rendering**

  Assert Front and Back use distinct canonical URLs, selecting Back changes the main image, generic editor screenshot fields are absent, `TEXT_ONLY` renders `Text only`, `IMAGE_OR_LOGO` renders `Image / Logo`, and DTF/DTG omit the row.

- [ ] **Step 2: Run dashboard tests and verify the new behavior tests fail**

  Run: `node --test --import tsx tests/creator-dashboard.test.ts`
  Expected: FAIL on missing subtype/surface behavior.

- [ ] **Step 3: Implement review rendering from persisted surface records**

  Do not composite or overlay images. Reuse the saved PitchPrint render as the complete preview image.

- [ ] **Step 4: Run dashboard tests and verify they pass**

  Run: `node --test --import tsx tests/creator-dashboard.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "fix: render creator review surfaces and artwork type"`

### Task 4: Authoritative Subtype Pricing, Publishing, Cart, and Order Metadata

**Files:**
- Modify: `app/services/creator-product-publishing.server.ts`
- Modify: `app/services/creator-products.server.ts`
- Modify: `app/services/production-method-cart.server.ts` if production properties currently omit subtype/project identity
- Modify: `app/services/creator-orders.server.ts` if order snapshots currently omit canonical metadata
- Modify: `tests/creator-products.test.ts`
- Modify: `tests/production-method-pricing.test.ts`
- Modify: `tests/inkybay-creator-publishing.test.ts` only for existing publish boundary coverage

**Interfaces:**
- Consumes: server-derived subtype, configured Creator production-pricing row, fixed method/color, placement count, and project identity.
- Produces: correct subtype fee variant/price, immutable published metadata, cart fee quantity `purchase quantity * placementCount`, and production-visible project/type/color/method/placement properties.

- [ ] **Step 1: Add failing pricing and tamper-resistance tests**

  Assert Text uses configured Text values, Image/Logo uses configured Image values, mixed objects cannot obtain Text pricing, DTF/DTG remain unchanged, and missing/unsynced subtype configuration fails safely.

- [ ] **Step 2: Add failing lifecycle metadata tests**

  Assert published products fix method/color/type/artwork, customers can select only Size and Quantity, fee quantity remains multiplicative, and cart/order properties retain CreatorProduct ID, project ID, color, method, subtype, and placement count.

- [ ] **Step 3: Run focused pricing/product/publishing tests and verify failures**

  Run: `node --test --import tsx tests/creator-products.test.ts tests/production-method-pricing.test.ts tests/inkybay-creator-publishing.test.ts`
  Expected: FAIL only for the newly specified metadata/validation gaps.

- [ ] **Step 4: Implement minimal contract completion**

  Reuse `pricingForEmbroiderySubtype` and `feeVariantIdForEmbroiderySubtype`. Add no prices or columns. Extend only metadata/properties missing from the existing lifecycle.

- [ ] **Step 5: Prove the checkout Function requires no source change**

  Run its existing tests against the resulting contract. If they pass, leave every Function file untouched. If a contract test fails, stop and present the minimal compatibility change before editing it.

- [ ] **Step 6: Run all focused tests and verify they pass**

  Run: `node --test --import tsx tests/creator-products.test.ts tests/production-method-pricing.test.ts tests/inkybay-creator-publishing.test.ts`
  Expected: PASS.

- [ ] **Step 7: Commit**

  `git commit -m "fix: enforce embroidery subtype production pricing"`

### Task 5: Integrated Verification and Development Release

**Files:**
- Modify only test fixtures or implementation files required by concrete failures from this plan.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: validated `development` release candidate and exact evidence for approval.

- [ ] **Step 1: Run changed-file ESLint**

  Expected: zero errors.

- [ ] **Step 2: Run the complete suite once**

  Run: `npm test`
  Expected: all tests pass.

- [ ] **Step 3: Run typecheck, build, and diff checks once**

  Run: `npm run typecheck`, `npm run build`, and `git diff --check`.
  Expected: all exit 0.

- [ ] **Step 4: Push `development` and verify the exact Vercel preview commit and `/health` response**

- [ ] **Step 5: Report the merchant pricing prerequisite**

  Confirm current values without exposing IDs. Do not proceed to price-selection live QA until nonzero merchant-approved Text and Image/Logo prices are saved and their fee variants are synced.

### Task 6: Approved Production Release and Two-Design Live QA

**Files:**
- No new source files unless live evidence identifies a reproducible, tested defect.

**Interfaces:**
- Consumes: approved development release and merchant-configured subtype prices.
- Produces: synchronized `main`/`development`, exact Vercel production evidence, storefront extension release, and two-design live QA record.

- [ ] **Step 1: After explicit approval, fast-forward `main`, rerun release verification, push, and verify the exact production commit**

- [ ] **Step 2: Release the storefront/dashboard extension under Shopify's app-version constraint**

  Verify the checkout Function source has no diff. Because Shopify versions all extensions together, obtain explicit approval if releasing the unchanged Function snapshot is unavoidable.

- [ ] **Step 3: Run exactly two fresh live designs**

  Test A: Green T-shirt, Embroidery, editable text `HELLO` on Front. Verify canonical rendered preview, `Text only`, configured Text fee, color/method persistence, project identity, and placement count.

  Test B: Green T-shirt, Embroidery, one obvious image/logo on Front. Verify canonical rendered preview, `Image / Logo`, configured Image fee, no editor screenshot, color/method persistence, project identity, and placement count.

- [ ] **Step 4: Reopen Edit Design and verify project, artwork, color, method, subtype, surfaces, and recomputation after a change**

- [ ] **Step 5: Verify published fixed configuration, Size/Quantity-only customer choices, fee quantity, and production metadata**

- [ ] **Step 6: Deliver the final evidence report**

  Use the requested exact completion phrase only when every live item passes.

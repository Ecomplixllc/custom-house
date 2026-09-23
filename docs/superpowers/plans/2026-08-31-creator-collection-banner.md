# Creator Collection Banner Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure creator-managed collection banners to existing app-managed creator collection pages.

**Architecture:** Store nullable banner metadata on `CreatorCollection`, reuse Shopify-hosted staged upload/fileCreate for images, expose a signed app-proxy endpoint for the authenticated creator, render the banner in the app-managed public collection page only when configured, and add small admin visibility.

**Tech Stack:** React Router app routes, Prisma/PostgreSQL, Shopify Admin GraphQL, Shopify app proxy, theme app extension Liquid/JS/CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-creator-collection-banner-design.md`

## Global Constraints

- Keep banner data on existing `CreatorCollection`.
- Fields are nullable: `bannerImageUrl`, `bannerTitle`, `bannerSubtitle`, `bannerUpdatedAt`.
- Use a new forward-only Prisma migration only.
- Never run `prisma migrate reset`.
- Reuse Shopify-hosted upload flow from `profile-image.server.ts`.
- Never trust browser-supplied `creatorId`.
- Do not modify creator products, PitchPrint, pricing, commission, referral, payout, order processing, or public product customization.
- Existing creators with no banner keep the current public collection appearance.
- Do not delete old banner media unless exclusive ownership is provable; current design does not delete old media.

---

### Task 1: Schema And Banner Service

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260831000000_creator_collection_banner/migration.sql`
- Create: `app/services/creator-collection-banner.server.ts`
- Modify: `tests/creator-dashboard.test.ts`

**Interfaces:**
- Produces: `creatorCollectionBannerForCustomer(input)`, `updateCreatorCollectionBanner(input)`, `removeCreatorCollectionBanner(input)`, `validateCollectionBannerImage(bytes, mimeType, size, fileName)`.

- [ ] Write failing service tests for authenticated creator-only save/remove and invalid file rejection.
- [ ] Run focused tests and confirm they fail because the service/schema fields do not exist.
- [ ] Add nullable Prisma fields and forward-only SQL migration.
- [ ] Implement text cleaning, Shopify image upload wrapper, authenticated creator lookup, save, remove, and audit logging.
- [ ] Run focused tests and confirm they pass.

### Task 2: App Proxy Route And Dashboard Data

**Files:**
- Create: `app/routes/proxy.api.creator-collection-banner.tsx`
- Modify: `app/services/submission.server.ts`
- Modify: `tests/creator-dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1 banner service functions.
- Produces: `/apps/customhouse/api/creator-collection-banner` GET/POST and `dashboard.collection.banner*` data.

- [ ] Write failing tests proving the route does not read browser `creatorId`, supports save/remove, and dashboard response exposes banner fields.
- [ ] Run focused tests and confirm failure.
- [ ] Add the route using `proxyContext`, `enforceRateLimit`, `apiData`, and `apiError`.
- [ ] Add banner fields to `creatorDashboard()` collection select/response.
- [ ] Run focused tests and confirm pass.

### Task 3: Creator Dashboard UI

**Files:**
- Modify: `extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid`
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js`
- Modify: `extensions/customhouse-creator-storefront/assets/customhouse.css`
- Modify: `tests/creator-dashboard.test.ts`

**Interfaces:**
- Consumes: `/apps/customhouse/api/creator-collection-banner` route.

- [ ] Write failing structure tests for Collection Banner markup, JS endpoint/save/remove/preview handlers, and responsive CSS selectors.
- [ ] Run focused tests and confirm failure.
- [ ] Add compact banner manager markup to Account tab and use the existing action modal for removal confirmation.
- [ ] Add JS for preview, title/subtitle hydration, save, remove, loading, success/error, and dashboard refresh.
- [ ] Add scoped responsive CSS.
- [ ] Run focused tests and confirm pass.

### Task 4: Public Storefront Rendering

**Files:**
- Modify: `app/services/creator-collections.server.ts`
- Modify: `app/services/creator-products.server.ts`
- Modify: `app/services/storefront-proxy.server.ts`
- Modify: `tests/storefront-proxy.test.ts`
- Modify: `tests/creator-products.test.ts` if public collection shape tests belong there.

**Interfaces:**
- Consumes: `CreatorCollection` banner fields.

- [ ] Write failing tests for public JSON and HTML rendering with a banner and fallback without a banner.
- [ ] Run focused tests and confirm failure.
- [ ] Extend collection record types/selects and public product collection return shape.
- [ ] Render the optional banner above the existing hero without changing fallback hero markup.
- [ ] Run focused tests and confirm pass.

### Task 5: Admin Visibility

**Files:**
- Modify: `app/routes/app.creators.tsx`
- Modify: `tests/creator-application.test.ts` or `tests/admin-dashboard.test.ts` depending on existing coverage fit.

**Interfaces:**
- Consumes: `marketplaceCollection.bannerImageUrl`.

- [ ] Write failing tests for admin Creators banner status/preview and optional remove action if implemented.
- [ ] Run focused tests and confirm failure.
- [ ] Include marketplace collection banner fields in admin loader.
- [ ] Add compact table/detail display and safe HTTPS image preview.
- [ ] Run focused tests and confirm pass.

### Task 6: Full Verification And Deployment Gate

**Files:**
- No feature files unless verification exposes defects.

- [ ] Run `npx prisma validate` with required DB env vars present.
- [ ] Run `npx prisma migrate status` against production/direct database before deploying migration.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Inspect `git status --short` and `git diff --name-only`.
- [ ] Confirm no production-method-pricing/cart/order changes are present.
- [ ] Commit implementation.
- [ ] If migration state is safe, run `npx prisma migrate deploy` against production.
- [ ] Deploy app using the existing Vercel/Shopify workflow.
- [ ] Deploy Shopify extension only because dashboard Liquid/JS/CSS changed.
- [ ] Perform live smoke test with an approved creator: upload, save, public display, edit, replace, remove, fallback, re-add, unrelated creator unaffected, product page and add-to-cart still working.

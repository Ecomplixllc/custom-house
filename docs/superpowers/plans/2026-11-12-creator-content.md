# Creator Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-data Creator Content discovery page and ordered Admin Featured Creator curation while reusing the existing secured buy-only Creator routes.

**Architecture:** A new Prisma relation stores only shop-scoped Featured Creator order. A domain service validates Admin writes and joins eligible Creator records with batched Shopify product data. The existing storefront app-proxy renderer serves the responsive page and links to the current Creator profile/product implementations.

**Tech Stack:** React Router, Prisma/PostgreSQL, Shopify Admin GraphQL abstraction, server-rendered HTML/CSS/JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-12-creator-content-design.md`

## Global Constraints

- Work on `development`; do not deploy or merge to `main`.
- Preserve existing Creator profile/product routes and buy-only cart preparation unchanged.
- Public rows require approved Creator, active collection, published CreatorProduct, and valid Shopify data.
- Do not add fake Follow, Wishlist, popularity, rating, or follower behavior.
- Do not modify Collections, Base Products, PitchPrint, pricing, inventory, attribution, commission, referral, payout, checkout, shipping, or tax behavior.

## Review Focus

- A curated Creator later becomes suspended: public response omits them without requiring curation cleanup.
- A published DB row points to a missing or inactive Shopify product: page omits that product safely.
- Duplicate or cross-shop Creator IDs in Admin input: save rejects them and leaves ordering unchanged.
- A product has no usable variants or price: it is excluded rather than rendering invented values.
- Search/filter values contain punctuation or non-Latin text: normalization remains safe and links retain canonical IDs/handles.

---

### Task 1: Featured Creator persistence and domain rules

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261112000000_featured_creators/migration.sql`
- Create: `app/services/creator-content.server.ts`
- Create: `tests/creator-content.test.ts`

**Interfaces:**
- Produces: `listFeaturedCreatorAdminState(shop, query)`, `saveFeaturedCreatorOrder(shop, creatorIds)`, and public discovery types.

- [ ] Write failing tests for schema shape, approved/active/published eligibility, ordered persistence, duplicate/cross-shop rejection, and automatic public suppression after suspension.
- [ ] Run `node --experimental-strip-types --test tests/creator-content.test.ts` and confirm the missing service/model failures.
- [ ] Add the `FeaturedCreator` relation and reviewed migration; implement transactional order replacement after full eligibility validation.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Authenticated Admin curation screen

**Files:**
- Create: `app/routes/app.creator-content.tsx`
- Modify: `app/routes/app.tsx`
- Modify: `tests/creator-content.test.ts`

**Interfaces:**
- Consumes: Task 1 Admin list/save functions.
- Produces: `/app/creator-content` loader, action, and professional ordered list UI.

- [ ] Add failing source/behavior tests for `authenticate.admin`, approved-only candidates, add/remove/reorder/save controls, and navigation.
- [ ] Implement the loader/action and a minimal accessible Admin UI using existing Admin styles.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Public discovery dataset with real Shopify product data

**Files:**
- Modify: `app/services/creator-content.server.ts`
- Modify: `tests/creator-content.test.ts`

**Interfaces:**
- Produces: `loadPublicCreatorContent(shop, client, options)` returning featured Creators, categories, products, filters, paging, and sort state with canonical profile/product URLs.

- [ ] Add failing tests for approved/active/published intersections, batched Shopify lookup, inactive/missing product suppression, real price/size/color/availability fields, pagination, and canonical links.
- [ ] Implement bounded DB reads and one batched `nodes(ids:)` GraphQL query per page; use published product prices when present and existing authoritative legacy pricing data otherwise.
- [ ] Re-run the focused tests and confirm they pass.

### Task 4: App-proxy route and responsive Creator Content renderer

**Files:**
- Modify: `app/services/storefront-proxy.server.ts`
- Modify: `tests/storefront-proxy.test.ts`
- Modify: `tests/creator-content.test.ts`

**Interfaces:**
- Consumes: Task 3 public dataset.
- Produces: `/apps/customhouse/creator-content` HTML and JSON responses using the existing site shell.

- [ ] Add failing route/markup tests for the exact route, server data, scoped wrapper, search, real chips, featured order, sidebar/drawer filters, sort, responsive grid, canonical links, and absence of Customize/PitchPrint/Follow/Wishlist.
- [ ] Add the `creatorContent` proxy route and a scoped server renderer with debounced client-side interactions and URL-backed state.
- [ ] Validate JavaScript syntax extracted from the HTML and run focused proxy/content tests.

### Task 5: Duplicate-safe storefront navigation

**Files:**
- Create: `theme-live-cart/snippets/customhouse-creator-content-menu-fallback.liquid`
- Modify: `theme-live-cart/blocks/_header-menu.liquid`
- Modify: `theme-live-cart/snippets/header-drawer.liquid`
- Modify: `app/services/storefront-proxy.server.ts`
- Modify: `tests/creator-content.test.ts`

**Interfaces:**
- Produces: one `CREATOR CONTENT` link in desktop/mobile Shopify headers and the app-proxy shell.

- [ ] Add failing tests that preserve merchant links and prevent duplicate fallback links.
- [ ] Implement the fallback snippet and active app-proxy navigation state.
- [ ] Run the focused tests and theme validation.

### Task 6: Full regression and release verification

**Files:**
- Modify only files required to address verified failures.

- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Run Prisma validation and `shopify theme check`, isolating any pre-existing unrelated diagnostics.
- [ ] Run responsive browser QA at 375, 390, 430, 768, 1024, 1280, 1440, and 1920 pixels when local preview/browser tooling is available.
- [ ] Inspect `git diff --check` and confirm existing Collections work and protected commerce flows were not reverted.
- [ ] Produce the requested final PASS/FAIL report without deploying.

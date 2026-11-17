# Creator Content Pagination and Profile Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Creator Content Load More with accessible 12-item numbered pagination and render uploaded Creator profile images reliably.

**Architecture:** Keep the existing authenticated HTML batch loader, store the next offset on the page root, load the complete safe catalog, then paginate the filtered DOM cards with one tested pure pagination model. Resolve only stored Shopify file GIDs with one batched Admin GraphQL node query while passing HTTPS URLs through unchanged.

**Tech Stack:** TypeScript, Node test runner, Shopify Admin GraphQL, server-rendered HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-11-12-creator-content-pagination-profile-images-design.md`

## Global Constraints

- Preserve Shopify React Router authentication, Prisma session storage, App Bridge, webhook patterns, and app-proxy customer verification.
- Use Admin GraphQL only and never expose tokens, raw GraphQL errors, database URLs, or unresolved Shopify GIDs.
- Keep Creator products `creator` + `buy_only` and do not change publishing, pricing, or approval behavior.
- Keep unrelated working-tree files untouched and work only on `development` until manual production approval.

## Review Focus

- Empty and single-page result sets must keep pagination accessible without invalid page numbers.
- Filter or search changes from a later page must reset to page 1.
- Invalid or out-of-range `page` query values must clamp safely.
- MediaImage and GenericFile GIDs must resolve through one batched query; failed resolution must fall back to initials.
- HTTPS profile URLs must not cause an unnecessary profile-image query.

---

### Task 1: Resolve public Creator profile images

**Files:**
- Modify: `app/services/creator-content.server.ts`
- Test: `tests/creator-content.test.ts`

**Interfaces:**
- Consumes: `ShopifyGraphqlClient.request`, stored `Creator.profileImageUrl` values.
- Produces: public `featuredCreators[].profileImageUrl` and `products[].creatorAvatarUrl` containing HTTPS URLs or `null`, never Shopify GIDs.

- [ ] **Step 1: Write failing service tests** for MediaImage GID resolution, HTTPS pass-through, and unresolved fallback.
- [ ] **Step 2: Run `node --experimental-strip-types --test tests/creator-content.test.ts`** and confirm the new assertions fail because GIDs are returned unchanged.
- [ ] **Step 3: Add one batched resolver** that queries only unique Shopify file GIDs and maps resolved HTTPS URLs into featured creators and product summaries.
- [ ] **Step 4: Rerun the focused test** and confirm it passes without changing existing product-query behavior.

### Task 2: Replace Load More with numbered pagination

**Files:**
- Modify: `app/services/storefront-proxy.server.ts`
- Test: `tests/creator-content.test.ts`

**Interfaces:**
- Produces: `creatorContentPaginationModel(totalItems, requestedPage, pageSize)` and accessible pagination markup/runtime using 12 items per page.
- Consumes: existing safe HTML batch responses and discovery filter state.

- [ ] **Step 1: Write failing pagination-model and renderer tests** covering zero items, clamping, 12-item boundaries, absence of Load More, and presence of Previous/page/Next controls.
- [ ] **Step 2: Run the focused test** and confirm failure for missing numbered pagination.
- [ ] **Step 3: Implement the pure pagination model** and use its exact runtime function in the page script.
- [ ] **Step 4: Move continuation state to the page root, preload remaining safe batches, paginate only matching sorted cards, and sync `page` in browser history.**
- [ ] **Step 5: Add polished responsive CSS** for compact controls, active/disabled states, focus visibility, loading state, and mobile overflow.
- [ ] **Step 6: Rerun the focused test** and confirm all Creator Content tests pass.

### Task 3: Validate and prepare development preview

**Files:**
- Modify only files from Tasks 1-2 plus this spec and plan.

**Interfaces:**
- Produces: one reviewable `development` commit and preview deployment; no production mutation.

- [ ] **Step 1: Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.**
- [ ] **Step 2: Review the exact diff and confirm unrelated dirty files are unchanged.**
- [ ] **Step 3: Commit and push `development`.**
- [ ] **Step 4: Deploy a development preview and inspect pagination, filters, profile images, desktop, and mobile behavior.**
- [ ] **Step 5: Report the preview and stop for explicit production approval.**

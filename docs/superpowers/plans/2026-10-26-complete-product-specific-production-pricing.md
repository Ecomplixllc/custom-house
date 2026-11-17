# Complete Product-Specific Production Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved product-specific production-method implementation across Admin, Public Customize, Creator drafts, and Creator publishing without changing Creator financial rules.

**Architecture:** Keep `PublicProductProductionPricing.methodConfigurations` and `production-method-pricing.server.ts` as the single authority. Admin writes isolated base-product configuration; storefront and Creator consumers resolve enabled methods and prices through the canonical resolver. The shared Creator pricing row remains legacy-only and is never used for new drafts or new publishing calculations.

**Tech Stack:** React Router, TypeScript, Prisma/PostgreSQL, Shopify Admin GraphQL, Shopify theme JavaScript/Liquid, Node test runner.

**Spec:** User attachment `f7bd5f80-2dda-4090-8911-1ea342e07af5/Pasted text.txt`.

## Global Constraints

- Work only on `development`; do not merge or deploy production.
- Preserve Shopify authentication, Admin GraphQL, Prisma sessions, App Bridge, webhooks, historical records, Creator earnings, commission, referrals, payouts, and checkout-rule state.
- Keep Embroidery `TEXT_ONLY` and `IMAGE_OR_LOGO` independently enabled and priced.
- Never infer enabled state from price and never trust browser-submitted prices.
- Do not add product-name conditionals or Sticker-specific runtime code.

## Review Focus

- Disabled product methods must be absent from public and Creator choices and rejected server-side.
- Creator publishing must re-read the current base-product cost and avoid legacy shared pricing or price compounding.
- Dynamic methods such as Sticker Printing must traverse the same public cart path and fee mapping.
- Saving one product must not mutate another product's configuration or fee mappings.
- Existing Creator financial records and calculations must remain structurally unchanged.

---

### Task 1: Audit and pin current Admin/Public behavior

**Files:**
- Test: `tests/production-method-pricing.test.ts`
- Test: `tests/public-pitchprint-contract.test.ts`
- Test: `tests/public-cart-bridge.test.ts`

**Interfaces:**
- Consumes: canonical registry and `resolveProductionPricing(...)`.
- Produces: regression evidence for product cards, enabled-only public payloads, dynamic methods, canonical cart pricing, and isolated saves.

- [ ] Add only missing failing tests required by the approved specification.
- [ ] Run the focused tests and verify any added test fails for the missing behavior.
- [ ] Implement the smallest bounded fix if a real gap exists.
- [ ] Re-run focused tests to green.

### Task 2: Make new Creator flows exclusively product-specific

**Files:**
- Modify if required: `app/services/creator-products.server.ts`
- Modify if required: `app/services/creator-product-publishing.server.ts`
- Modify if required: `app/services/creator-product-pricing.server.ts`
- Test: `tests/creator-products.test.ts`
- Test: `tests/creator-product-publishing.test.ts`
- Test: `tests/creator-product-pricing.test.ts`

**Interfaces:**
- Consumes: `getEnabledProductionMethodsForProduct(...)` and `resolveProductionPricing(...)` keyed by the base Shopify product ID.
- Produces: new draft validation and publish/re-publish cost inputs sourced only from the selected base product.

- [ ] Write a failing regression test for every discovered shared-pricing dependency in a new draft or publish path.
- [ ] Run each new test and verify the expected failure.
- [ ] Replace only the failing dependency with the canonical product resolver.
- [ ] Re-run Creator-focused tests and confirm BAKED_IN_V1 and earnings behavior remain green.

### Task 3: Verify persistence, financial isolation, and release

**Files:**
- Modify only if a test proves a defect.
- Verify: Prisma schema/migration, app tests, checkout Function tests, typecheck, build, changed-file ESLint, and `git diff --check`.

**Interfaces:**
- Consumes: completed canonical implementation.
- Produces: one healthy development preview deployment and concrete final evidence.

- [ ] Verify live canonical T-shirt, Hoodie, Cap, and Sticker configurations without mutating them.
- [ ] Run focused tests, full app tests once, checkout Function tests, typecheck, production build, changed-file ESLint, Prisma validation/migration status, and `git diff --check`.
- [ ] Commit and push only `development` when changes are required.
- [ ] Deploy the completed `development` branch to preview and verify `/health`.

# Production Pricing Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the merchant-facing product pricing cards with one responsive spreadsheet-style matrix whose explicit enabled states and prices drive both Public and Creator flows.

**Architecture:** Keep `ProductionMethodSetting` and `PublicProductProductionPricing.methodConfigurations` as the only canonical sources. Add safe custom-method creation to the registry service, post the entire product matrix through one authenticated action, and render the matrix as a focused React component with local dirty state and one sticky save action.

**Tech Stack:** React Router 7, React 18, Shopify embedded Admin/App Bridge shell, Prisma/PostgreSQL, Admin GraphQL, CSS.

**Spec:** `C:/Users/jpcho/.codex/attachments/13049d28-47be-4eb5-9140-3a6466f0893b/Pasted text.txt`

## Global Constraints

- Work only on `development`; do not merge or deploy production.
- Preserve Shopify authentication, Admin GraphQL, session storage, app proxy, webhook, and financial behavior.
- Keep enabled state independent from price, including enabled zero-price methods.
- Never erase a disabled method's stored price.
- Do not introduce a Creator-specific production price source or product-name conditionals.
- Preserve historical products, orders, CreatorSale, referrals, and payouts.
- Leave unrelated untracked Liquid files untouched.

## Review Focus

- An unchecked field is disabled visually but still submits its previous price so re-enabling restores it.
- A duplicate or reserved custom method code is rejected with a safe domain error.
- A newly created registry method appears for every product but starts unchecked because product configuration is absent.
- A partial Shopify/fee synchronization is summarized per batch without exposing raw upstream errors.
- Narrow layouts retain usable checkbox/price controls without squeezing the desktop matrix.

---

### Task 1: Safe registry method creation

**Files:**
- Modify: `app/services/production-method-pricing.server.ts`
- Test: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Consumes: existing `ProductionMethodSetting` model and `listProductionMethodDefinitions(shop)`.
- Produces: `createProductionMethodDefinition(shop, input, database?)` and `canonicalProductionMethodCode(value)`.

- [x] Write failing tests for generated `SCREEN_PRINTING`, duplicate/reserved rejection, numeric dimension validation, and registry reload.
- [x] Run focused tests and confirm RED.
- [x] Implement single-price custom method creation with safe code/label validation and no product configuration writes.
- [x] Run focused tests and confirm GREEN.

### Task 2: Batch matrix action and merchant UI

**Files:**
- Create: `app/components/production-pricing-matrix.tsx`
- Modify: `app/routes/app.products.tsx`
- Test: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Consumes: loader products/configurations/definitions and `saveProductProductionConfiguration`.
- Produces: one matrix form using `save-production-pricing-batch`, one add-method dialog using `add-production-method`, and safe aggregate action results.

- [x] Replace card-source assertions with failing tests for product rows, registry columns, separate embroidery tiers, disabled price inputs, one Save Changes action, modal fields, and collapsed diagnostics.
- [x] Run focused tests and confirm RED.
- [x] Implement prevalidated sequential batch saving, safe errors, and method creation action.
- [x] Implement matrix rows/columns, local dirty state, price-preserving disabled inputs, and one sticky save action.
- [x] Run focused tests and confirm GREEN.

### Task 3: Responsive spreadsheet presentation

**Files:**
- Modify: `app/styles/admin.css`
- Test: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Consumes: semantic classes emitted by `ProductionPricingMatrix`.
- Produces: sticky product column/header, grouped method columns, horizontal tablet scroll, and mobile product panels.

- [x] Add failing CSS/source assertions for sticky headers/product cells, compact controls, horizontal overflow, modal, and mobile layout.
- [x] Run focused tests and confirm RED.
- [x] Implement responsive matrix styling without changing the Shopify Admin shell.
- [x] Run focused tests and confirm GREEN.

### Task 4: Regression, review, and development preview

**Files:**
- Modify only if verification proves a defect.

**Interfaces:**
- Consumes: completed matrix and canonical services.
- Produces: reviewed `development` commit and healthy preview deployment.

- [x] Run Public, Creator, financial, registry, and checkout Function tests.
- [x] Run full suite, changed-file ESLint, typecheck, production build, Prisma validation/status, and `git diff --check`.
- [x] Request read-only whole-branch review and fix Critical/Important findings test-first.
- [ ] Commit and push `development` only.
- [ ] Deploy Vercel preview only, verify `/health`, and visually inspect the actual embedded Admin Products page on desktop and mobile/tablet widths.

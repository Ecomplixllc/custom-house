# New Creator Product Baked Pricing Implementation Plan

> **Execution:** Use `superpowers:executing-plans` and test-driven development. Do not delegate unless explicitly requested.

**Goal:** Publish new Creator Products with production cost baked into every Shopify variant and add only the selected published variant to cart.

**Architecture:** Add a nullable pricing mode, centralize authoritative price-plan construction in one pure service, apply and verify the plan during publishing, and branch native Creator cart preparation by explicit mode. Legacy Creator and public-customization fee paths remain intact.

**Spec:** `docs/superpowers/specs/2026-10-01-new-creator-baked-pricing-design.md`

### Task 1: Persist explicit pricing mode

**Files:** `prisma/schema.prisma`, a reviewed migration, CreatorProduct service types, test fakes.

- [ ] Add failing persistence/type tests for nullable legacy mode and `BAKED_IN_V1`.
- [ ] Add nullable `creatorPricingMode` with no data migration/backfill.
- [ ] Update only required selects, fakes, and record types.
- [ ] Run focused tests.

### Task 2: Build the canonical pricing calculator

**Files:** new `app/services/creator-product-pricing.server.ts`, `tests/creator-product-pricing.test.ts`.

- [ ] Add failing tests for Embroidery Text/Image, DTF, DTG, placement multiplication, differing size prices, order-independent full-option mapping, missing/duplicate/ambiguous mappings, invalid configuration, and republish non-compounding.
- [ ] Implement authoritative surcharge selection and immutable variant plans using exact decimal/minor-unit arithmetic.
- [ ] Add deterministic canonical variant identity and fail-closed bijective mapping.
- [ ] Run the focused calculator tests.

### Task 3: Calculate the Save Design pricing preview

**Files:** `app/services/creator-products.server.ts`, `tests/creator-products.test.ts`.

- [ ] Add prices/currency to server-fetched base-variant snapshots.
- [ ] Add failing tests proving Save Design ignores browser prices and stores an expected-price preview derived from saved setup plus Admin pricing.
- [ ] Reuse the canonical surcharge/calculation helpers and persist preview data inside the existing setup JSON.
- [ ] Block missing/invalid required pricing with method-specific errors.
- [ ] Run focused CreatorProduct tests.

### Task 4: Apply baked prices during publish and republish

**Files:** `app/services/creator-product-publishing.server.ts`, calculator tests, publishing tests.

- [ ] Add failing tests for fresh base-price reads, exact per-variant prices, fixed-color mapping, mode metafield, `feeRequired: false`, verification-before-database-mode, and non-compounding republish.
- [ ] Query base and published variants with IDs, selected options, and prices.
- [ ] Build and apply the canonical plan with `productVariantsBulkUpdate`.
- [ ] Re-read and verify prices and Shopify pricing/validation metafields.
- [ ] Persist `creatorPricingMode` only after Shopify verification.
- [ ] Run focused publishing tests.

### Task 5: Add baked native cart behavior

**Files:** `app/services/creator-products.server.ts`, native cart tests, storefront contract tests.

- [ ] Add failing tests asserting one selected published variant, no fee line/sync, quantity behavior, and preserved Creator/PitchPrint metadata.
- [ ] Branch only on explicit `BAKED_IN_V1`; keep `null` on the existing legacy path.
- [ ] Add the published variant directly and keep acknowledgements/attribution/project cloning.
- [ ] Verify public customization and legacy Creator cart tests remain unchanged.

### Task 6: Regression and development release

- [ ] Prove the checkout Function directory has no source diff and run its existing tests.
- [ ] Run changed-file lint, full tests, typecheck, build, and `git diff --check`.
- [ ] Commit and push `development`.
- [ ] Deploy/verify the Vercel preview and `/health`.
- [ ] Stop for manual QA/production approval; do not promote `main` or release Shopify without the required approval.

# Production Method Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-controlled per-product Printing Method surcharges for public customizable PitchPrint products, with trusted server validation and Shopify cart/checkout totals matching the PitchPrint preview.

**Architecture:** Reuse the existing production DB tables `ProductionMethodSetting` and `PublicProductProductionPricing` as the authoritative source. Admin saves pricing, syncs display metafields and hidden fee merchandise, while public PitchPrint uses display config only and a server prepare-cart endpoint returns trusted base and fee lines.

**Tech Stack:** React Router app routes, Shopify Admin GraphQL, Prisma/PostgreSQL, Shopify app proxy, Shopify Ajax cart, Liquid theme files, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-27-production-method-pricing-design.md`

## Global Constraints

- Work from baseline SHA `8924490a61570e959128e62a7c2cfb34564364ab`.
- Do not use GitHub/origin as source of truth.
- Do not deploy Vercel during implementation until all gates pass.
- Do not deploy Shopify during implementation until all gates pass.
- Do not modify production DB directly; test migrations on a Neon clone first.
- Reuse existing production DB tables; do not create duplicate production-method pricing tables.
- Admin DB/server values are authoritative.
- Browser/PitchPrint pricing is display-only.
- Server must reload trusted surcharge and current Shopify variant prices.
- Creator buy-only products remain unchanged.
- Actual Shopify Cart and Checkout must charge the same total shown in PitchPrint.
- Do not assume Cart Transform is available; use hidden fee merchandise unless eligibility is proven.
- Use TDD: write failing tests before production code.

---

### Task 1: Local Schema Alignment For Existing Production Tables

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260826010000_production_method_pricing/migration.sql`
- Test: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Produces Prisma enum `ProductionMethod`.
- Produces Prisma models `ProductionMethodSetting` and `PublicProductProductionPricing`.
- Later services consume `db.productionMethodSetting` and `db.publicProductProductionPricing`.

- [ ] **Step 1: Write the failing schema test**

```ts
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("production method pricing schema matches existing production DB objects", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /enum ProductionMethod\s*\{[\s\S]*EMBROIDERY[\s\S]*DTF[\s\S]*DTG[\s\S]*\}/);
  assert.match(schema, /model ProductionMethodSetting\s*\{/);
  assert.match(schema, /@@unique\(\[shopKey, method\]\)/);
  assert.match(schema, /model PublicProductProductionPricing\s*\{/);
  assert.match(schema, /embroiderySurcharge\s+Decimal\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /dtfSurcharge\s+Decimal\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /dtgSurcharge\s+Decimal\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /@@unique\(\[shopKey, shopifyProductId\]\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL because the schema lacks the enum/models.

- [ ] **Step 3: Add Prisma enum/models**

Add:

```prisma
enum ProductionMethod {
  EMBROIDERY
  DTF
  DTG
}

model ProductionMethodSetting {
  id          String           @id @default(cuid())
  shopKey     String
  method      ProductionMethod
  label       String
  description String
  enabled     Boolean          @default(true)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@unique([shopKey, method])
  @@index([shopKey, enabled])
}

model PublicProductProductionPricing {
  id                     String   @id @default(cuid())
  shopKey                String
  shopifyProductId       String
  embroiderySurcharge    Decimal  @db.Decimal(10, 2)
  dtfSurcharge           Decimal  @db.Decimal(10, 2)
  dtgSurcharge           Decimal  @db.Decimal(10, 2)
  embroideryFeeVariantId String?
  dtfFeeVariantId        String?
  dtgFeeVariantId        String?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  @@unique([shopKey, shopifyProductId])
  @@index([shopKey])
}
```

- [ ] **Step 4: Add matching migration SQL**

Create the local migration file matching the production-applied table shape. Use `CREATE TYPE` and `CREATE TABLE` guarded only if local reset/dev needs it. Do not run it against production during this task.

- [ ] **Step 5: Run schema test and Prisma validation**

Run:

```bash
node --experimental-strip-types --test tests/production-method-pricing.test.ts
npx prisma generate
npx prisma validate
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260826010000_production_method_pricing/migration.sql tests/production-method-pricing.test.ts
git commit -m "Add production method pricing schema"
```

### Task 2: Pricing Domain Service

**Files:**
- Create: `app/services/production-method-pricing.server.ts`
- Modify: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Produces `parseSurchargeInput(value: unknown): Prisma.Decimal`.
- Produces `pricingConfigToMetafieldValue(input): string`.
- Produces `pricingForMethod(pricing, method): Prisma.Decimal`.
- Produces `decimalToMinor(amount: Prisma.Decimal): bigint` using existing money helpers.

- [ ] **Step 1: Write failing tests for validation and math**

Add tests:

```ts
test("production method surcharge validation accepts zero and two decimals", () => {
  assert.equal(parseSurchargeInput("0").toFixed(2), "0.00");
  assert.equal(parseSurchargeInput("50.25").toFixed(2), "50.25");
});

test("production method surcharge validation rejects negative and too many decimals", () => {
  assert.throws(() => parseSurchargeInput("-1"), /negative/i);
  assert.throws(() => parseSurchargeInput("1.234"), /two decimals/i);
});

test("production method display config serializes minor units", () => {
  const value = JSON.parse(pricingConfigToMetafieldValue({
    currency: "SEK",
    methods: [
      { method: "EMBROIDERY", label: "Embroidery", surcharge: parseSurchargeInput("50.00") },
      { method: "DTF", label: "DTF printing", surcharge: parseSurchargeInput("30.00") },
      { method: "DTG", label: "DTG printing", surcharge: parseSurchargeInput("20.00") },
    ],
  }));
  assert.equal(value.methods.EMBROIDERY.surchargeMinor, 5000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL because service/functions do not exist.

- [ ] **Step 3: Implement minimal pricing helpers**

Use `Prisma.Decimal`, reject invalid values with `DomainError`, and serialize exact minor units.

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/services/production-method-pricing.server.ts tests/production-method-pricing.test.ts
git commit -m "Add production method pricing helpers"
```

### Task 3: Admin Products Pricing UI And Save Flow

**Files:**
- Modify: `app/routes/app.products.tsx`
- Modify: `app/services/production-method-pricing.server.ts`
- Modify: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Produces `loadProductionPricingAdminProducts(shop, client, db)`.
- Produces `savePublicProductProductionPricing(shop, input, client, db)`.
- Admin action accepts `intent=save-production-pricing`.

- [ ] **Step 1: Write failing admin tests**

Add source and service tests:

```ts
test("admin products page exposes pricing only for public customizable products", () => {
  const source = readFileSync("app/routes/app.products.tsx", "utf8");
  assert.match(source, /save-production-pricing/);
  assert.match(source, /product_type/);
  assert.match(source, /global_customizable/);
  assert.doesNotMatch(source, /creator_fixed[\s\S]*name="embroiderySurcharge"/);
});

test("admin save flow surfaces Shopify sync failures", () => {
  const service = readFileSync("app/services/production-method-pricing.server.ts", "utf8");
  assert.match(service, /metafieldsSet/);
  assert.match(service, /partial/i);
  assert.match(service, /production_method_pricing/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL because admin UI/service are missing.

- [ ] **Step 3: Implement admin loader**

Fetch active Shopify products with:

- `customhouse.product_type`
- `customhouse.pitchprint_enabled`
- `customhouse.product_origin`
- `customhouse.design_mode`
- variant price range

Merge DB pricing rows by `shopKey + shopifyProductId`.

- [ ] **Step 4: Implement admin form action**

Validate one product per submit. Save DB row. Sync metafield JSON. Call fee merchandise sync stub that returns `notConfigured` until Task 5 implements it. Return explicit status.

- [ ] **Step 5: Render compact UI**

Add a `Production Pricing` section per eligible public customizable product:

```text
Embroidery + [50.00] SEK
DTF        + [30.00] SEK
DTG        + [20.00] SEK
```

Keep creator/buy-only products excluded from editable pricing.

- [ ] **Step 6: Run tests**

Run:

```bash
node --experimental-strip-types --test tests/production-method-pricing.test.ts
npx eslint app/routes/app.products.tsx app/services/production-method-pricing.server.ts tests/production-method-pricing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.products.tsx app/services/production-method-pricing.server.ts tests/production-method-pricing.test.ts
git commit -m "Add admin production pricing form"
```

### Task 4: Trusted Pricing Calculation And Public Cart Preparation

**Files:**
- Create: `app/services/production-method-cart.server.ts`
- Create or modify: `app/routes/proxy.api.public-production-cart.tsx` or `app/services/storefront-proxy.server.ts`
- Modify: `tests/production-method-pricing.test.ts`
- Modify: `tests/storefront-proxy.test.ts`

**Interfaces:**
- Produces `preparePublicProductionCart(shop, input, client, db)`.
- Input includes `shopifyProductId`, `pitchprintProjectId`, `productionMethod`, `selections`.
- Output includes trusted base cart lines, trusted fee cart line, and totals in minor units.

- [ ] **Step 1: Write failing pricing tests**

Add tests:

```ts
test("trusted total uses actual variant prices plus method surcharge", async () => {
  const result = await calculateTrustedProductionTotal({
    surchargeMinor: 5000n,
    selections: [
      { variantId: "gid://shopify/ProductVariant/1", priceMinor: 10000n, quantity: 1 },
      { variantId: "gid://shopify/ProductVariant/2", priceMinor: 11000n, quantity: 2 },
    ],
  });
  assert.equal(result.productSubtotalMinor, 32000n);
  assert.equal(result.productionSurchargeMinor, 15000n);
  assert.equal(result.totalMinor, 47000n);
});

test("trusted cart prep rejects browser price tampering", async () => {
  await assert.rejects(
    () => preparePublicProductionCart("shop.test", {
      productionMethod: "EMBROIDERY",
      browserSurchargeMinor: 1,
      selections: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    }, fakeClient, fakeDb),
    /trusted/i
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL because service is missing.

- [ ] **Step 3: Implement trusted calculation**

Use integer minor units only. Reject invalid method, missing pricing, wrong product, invalid quantities, and variants from another product.

- [ ] **Step 4: Add public app-proxy route**

Use existing app-proxy auth patterns. Do not require customer login unless current product flow requires it. Return JSON only.

- [ ] **Step 5: Run tests**

Run:

```bash
node --experimental-strip-types --test tests/production-method-pricing.test.ts tests/storefront-proxy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/services/production-method-cart.server.ts app/routes/proxy.api.public-production-cart.tsx app/services/storefront-proxy.server.ts tests/production-method-pricing.test.ts tests/storefront-proxy.test.ts
git commit -m "Add trusted public production cart preparation"
```

### Task 5: Hidden Fee Merchandise Sync

**Files:**
- Modify: `app/services/production-method-pricing.server.ts`
- Modify: `app/services/production-method-cart.server.ts`
- Modify: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Produces `syncProductionFeeMerchandise(shop, productPricing, client, db)`.
- Persists fee variant IDs in `PublicProductProductionPricing`.
- Cart prep consumes the selected method fee variant ID.

- [ ] **Step 1: Write failing fee sync tests**

Add tests proving:

- one hidden fee product per public product
- three variants exist for Embroidery, DTF, DTG
- fee variant prices match DB surcharge
- fee variant IDs are saved
- Product A fee variants never leak into Product B

- [ ] **Step 2: Run tests to verify failure**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL because sync is not implemented.

- [ ] **Step 3: Implement fee sync via Admin GraphQL**

Create or update an app-managed hidden product. Use product tags/metafields to identify it. Do not expose it in normal navigation/search if avoidable. Update method variant prices when admin pricing changes.

- [ ] **Step 4: Require fee variants for cart prep**

Public cart prep must reject pricing rows with missing fee variant ID for the selected method and return a clear admin sync error.

- [ ] **Step 5: Run tests**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/services/production-method-pricing.server.ts app/services/production-method-cart.server.ts tests/production-method-pricing.test.ts
git commit -m "Sync production method fee merchandise"
```

### Task 6: Public PitchPrint Method UI And Display Totals

**Files:**
- Modify: `theme-live-cart/blocks/_product-details.liquid`
- Modify: `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`
- Modify: `tests/production-method-pricing.test.ts`
- Modify: `tests/setup-readiness.test.ts`

**Interfaces:**
- Browser reads `data-production-method-pricing`.
- Browser sends `productionMethod` and `selections` to server.
- Browser receives trusted cart lines and adds them to Shopify Ajax cart.

- [ ] **Step 1: Write failing theme tests**

Add tests asserting:

- Printing Method section exists only for public customizable PitchPrint products.
- Creator fixed products are excluded.
- Browser total formula uses variant prices plus surcharge in minor units.
- Browser payload sends method and selections, not trusted prices.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts tests/setup-readiness.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add Liquid data contract**

Add escaped JSON metafield value and variant JSON with prices to the marked product actions root.

- [ ] **Step 4: Extend handoff JS**

Render method choices, maintain selected method, calculate display summary, and call the server prepare-cart endpoint on `project-saved`.

- [ ] **Step 5: Add trusted Shopify Ajax add**

Use server-returned `items` array so base lines and fee line are added together.

- [ ] **Step 6: Run tests**

Run:

```bash
node --experimental-strip-types --test tests/production-method-pricing.test.ts tests/setup-readiness.test.ts
npx eslint tests/production-method-pricing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add theme-live-cart/blocks/_product-details.liquid theme-live-cart/assets/customhouse-pitchprint-order-handoff.js tests/production-method-pricing.test.ts tests/setup-readiness.test.ts
git commit -m "Add PitchPrint production method pricing UI"
```

### Task 7: Cart Fee Pairing And Reconciliation

**Files:**
- Modify: `theme-live-cart/assets/component-cart-items.js`
- Possibly modify: `theme-live-cart/snippets/cart-items-component.liquid`
- Modify: `tests/production-method-pricing.test.ts`

**Interfaces:**
- Cart lines use `_customhouse_fee_key`.
- Fee quantity equals total linked base quantity.
- Removing all linked base lines removes fee line.

- [ ] **Step 1: Write failing cart tests**

Add source tests asserting cart code:

- detects `_customhouse_fee_key`
- detects `_customhouse_production_fee`
- uses `cart/update.js` or `cart/change.js` to reconcile fee quantity
- ignores unrelated cart lines

- [ ] **Step 2: Run test to verify failure**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement cart reconciliation**

After quantity changes, fetch `cart.js`, group base and fee lines by fee key, and update fee line quantities. Prevent fee-only orphan lines.

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test tests/production-method-pricing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add theme-live-cart/assets/component-cart-items.js theme-live-cart/snippets/cart-items-component.liquid tests/production-method-pricing.test.ts
git commit -m "Keep production fee cart lines paired"
```

### Task 8: Regression And Verification Gates

**Files:**
- Modify only files needed to fix defects found by verification.

**Interfaces:**
- Verifies all previously implemented interfaces.

- [ ] **Step 1: Run required local verification**

Run:

```bash
npx prisma generate
npx prisma validate
npm test
npm run typecheck
npm run build
```

- [ ] **Step 2: Run targeted lint**

Run:

```bash
npx eslint app/routes/app.products.tsx app/services/production-method-pricing.server.ts app/services/production-method-cart.server.ts tests/production-method-pricing.test.ts tests/storefront-proxy.test.ts tests/setup-readiness.test.ts
```

- [ ] **Step 3: Report known unrelated baseline failure if still present**

If `tests/creator-sales.test.ts` still fails on the pre-existing source-text assertion, report it separately and do not hide it.

- [ ] **Step 4: Review diff**

Run:

```bash
git status --short
git diff --stat 8924490a61570e959128e62a7c2cfb34564364ab..HEAD
```

- [ ] **Step 5: Stop before deployment**

Do not deploy Vercel or Shopify until merchant approval and live E2E plan are confirmed.

## Self-Review

Spec coverage:

- Admin pricing is covered in Task 3.
- DB reuse and local schema alignment are covered in Task 1.
- Exact money validation and minor-unit serialization are covered in Task 2.
- Trusted server validation and tamper protection are covered in Task 4.
- Authoritative checkout via hidden fee merchandise is covered in Task 5.
- PitchPrint UI and display totals are covered in Task 6.
- Cart consistency is covered in Task 7.
- Verification gates are covered in Task 8.

Known gap:

- Live E2E, Vercel deployment, Shopify app/theme release, and final golden backup are intentionally not included in this Phase 0/1 plan execution. They require merchant approval after design review.

Plan complete and saved to `docs/superpowers/plans/2026-08-27-production-method-pricing.md`. Two execution options after approval:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

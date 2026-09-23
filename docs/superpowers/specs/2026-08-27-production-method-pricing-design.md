# Production Method Pricing Design

## Phase 0 Baseline

Baseline branch: `restore-working-before-pitchprint-20260827`

Baseline SHA: `8924490a61570e959128e62a7c2cfb34564364ab`

Safety refs created from the baseline:

- Branch: `backup-before-print-method-pricing-20260827`
- Tag: `backup-before-print-method-pricing-20260827`

Filesystem backup:

`C:\Users\jpcho\Downloads\custom house app\customhouse-app-backup-before-print-method-pricing-20260827`

Feature branch:

`feature/production-method-pricing`

No GitHub, Vercel deploy, Shopify deploy, Prisma migration, or DB write was used during Phase 0/1 discovery.

## Requirement

Public customizable products need admin-controlled Printing Method surcharges. One method is selected for the whole PitchPrint design/order configuration.

Supported methods:

- `EMBROIDERY`
- `DTF`
- `DTG`

Authoritative pricing rule:

```text
final per-item price = actual Shopify variant base price + selected method surcharge
```

For multiple selected variants:

```text
totalMinor = SUM((variant.priceMinor + method.surchargeMinor) * quantity)
```

Example:

```text
Black / S = 100 SEK x 1
Black / L = 110 SEK x 2
Embroidery = +50 SEK per item

(100 + 50) x 1 + (110 + 50) x 2 = 470 SEK
```

Admin DB/server values are authoritative. Browser/PitchPrint totals are display-only diagnostics. The server must reload trusted surcharge and current Shopify variant prices before preparing cart lines.

Creator buy-only products must remain unchanged.

## Discovery Summary

### Admin Products Flow

Current admin product page:

- `app/routes/app.products.tsx`

The route authenticates admin, queries Shopify Admin GraphQL for products with `customhouse.product_origin` of `global` or `creator`, and renders a read-only marketplace metafield list. It currently fetches:

- `id`
- `title`
- `handle`
- `status`
- `customhouse.product_origin`
- `customhouse.design_mode`
- `customhouse.design_status`

It does not fetch variant price ranges, does not write DB values, and has no production-pricing form.

Admin settings route:

- `app/routes/app.settings.tsx`

This route manages creator marketplace settings and PitchPrint host/selector settings. It is not the right home for per-product pricing because pricing is product-specific.

### Prisma And Production DB Shape

Current local Prisma schema:

- `prisma/schema.prisma`

Local schema does not include `ProductionMethod`, `ProductionMethodSetting`, or `PublicProductProductionPricing`.

Production DB read-only discovery found existing objects from migration `20260826010000_production_method_pricing`, even though the restored local code does not include that migration folder.

Existing production tables:

`ProductionMethodSetting`

- `id` text, primary key
- `shopKey` text, required
- `method` enum `ProductionMethod`, required
- `label` text, required
- `description` text, required
- `enabled` boolean, required
- `createdAt` timestamp, required
- `updatedAt` timestamp, required
- unique index: `shopKey, method`
- index: `shopKey, enabled`

`PublicProductProductionPricing`

- `id` text, primary key
- `shopKey` text, required
- `shopifyProductId` text, required
- `embroiderySurcharge` numeric(10,2), required
- `dtfSurcharge` numeric(10,2), required
- `dtgSurcharge` numeric(10,2), required
- `embroideryFeeVariantId` text, nullable
- `dtfFeeVariantId` text, nullable
- `dtgFeeVariantId` text, nullable
- `createdAt` timestamp, required
- `updatedAt` timestamp, required
- unique index: `shopKey, shopifyProductId`
- index: `shopKey`

Existing enum:

`ProductionMethod`

- `EMBROIDERY`
- `DTF`
- `DTG`

Existing production rows:

- `ProductionMethodSetting`: 3 rows for shop `gkd2hy-mf.myshopify.com`
- `PublicProductProductionPricing`: 0 rows

Conclusion: these production DB objects are compatible with the requested conceptual model and should be reused. Do not create duplicate tables. The implementation should add matching Prisma schema models and a local forward-only migration file that represents this already-applied production migration, then validate production migration state before any future deploy.

### Public PitchPrint Flow

Theme product files:

- `theme-live-cart/sections/product-information.liquid`
- `theme-live-cart/blocks/_product-details.liquid`
- `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`

Public customizable product detection currently uses:

- `customhouse.product_type = global_customizable`
- `customhouse.pitchprint_enabled = true`
- fallback PitchPrint tags such as `pitchprint`, `pitchprint-enabled`, `pitchprint-designlab`, `pitchprint-options`

Creator fixed products are excluded when:

- `customhouse.product_type = creator_fixed`
- or product tag contains `creator-fixed`

PitchPrint-required public products are identified by the `pitchprint-required` tag. For those products:

- `product-information.liquid` loads `customhouse-pitchprint-order-handoff.js`
- `_product-details.liquid` marks the product form with `data-customhouse-pitchprint-form="true"`
- add-to-cart is intercepted; if PitchPrint is required, it opens the Customize trigger instead of adding directly
- the handoff script listens for `project-saved`
- it captures one selected variant ID and one quantity from the product form
- it adds a single Shopify Ajax cart line with `_pitchprint` and optional `_pitchprint_preview` properties

Current limitation: the handoff supports one variant/quantity snapshot only. The requested pricing examples include multi-size/multi-variant quantities, so implementation must extend the final PitchPrint/order UI to send a selection array, not just one variant.

### Current Cart And Checkout Flow

Public customizable flow:

- Browser uses Shopify Ajax `cart/add.js` directly from `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`.
- It adds only the selected product variant.
- No app-proxy/server validation currently runs for public customizable add-to-cart.
- No authoritative surcharge is charged.

Creator product flow:

- `app/services/storefront-proxy.server.ts`
- `app/services/creator-products.server.ts`
- `app/routes/proxy.api.native-creator-product-cart.tsx`

Creator products already have app-managed cart preparation:

- app proxy validates signed storefront request
- server verifies creator product ownership/status and selected variant
- server clones/prepares PitchPrint order project
- server returns trusted cart variant ID and private properties
- browser adds the returned line to Shopify Ajax cart

This creator flow must remain unchanged and must not receive public production pricing.

Theme cart update files:

- `theme-live-cart/assets/component-cart-items.js`
- `theme-live-cart/assets/cart-drawer.js`

The cart uses Shopify Ajax `cart/change.js`, `cart.js`, and cart line update events. There is no existing fee-line pairing logic.

### Product Metafields

Existing customhouse metafields used by product classification include:

- `customhouse.product_type`
- `customhouse.pitchprint_enabled`
- `customhouse.inkybay_enabled`
- `customhouse.creator_publishing_enabled`
- `customhouse.product_origin`
- `customhouse.design_mode`
- `customhouse.design_status`
- `customhouse.pitchprint_design_id`

Creator publishing sets creator product metafields in:

- `app/services/creator-product-publishing.server.ts`

That code also deletes customization-trigger metafields from creator buy-only products, protecting creator flow from public customization behavior.

New storefront display/config metafield should be:

- namespace: `customhouse`
- key: `production_method_pricing`
- type: `json`

Conceptual value:

```json
{
  "version": 1,
  "currency": "SEK",
  "methods": {
    "EMBROIDERY": { "label": "Embroidery", "surchargeMinor": 5000 },
    "DTF": { "label": "DTF printing", "surchargeMinor": 3000 },
    "DTG": { "label": "DTG printing", "surchargeMinor": 2000 }
  }
}
```

The metafield is display/config delivery only. Server-side DB values remain authoritative.

## Proposed Architecture

### Source Of Truth

Reuse production DB table `PublicProductProductionPricing` as the per-product authoritative pricing source.

Use `ProductionMethodSetting` for method labels/enabled state.

Add matching Prisma enum/model definitions locally:

- `enum ProductionMethod`
- `model ProductionMethodSetting`
- `model PublicProductProductionPricing`

Use `Prisma.Decimal` for admin-entered major-unit surcharges. Serialize to browser as integer minor units using existing `app/services/money.ts` helpers.

Do not trust browser prices, metafield prices, DOM totals, or query string prices.

### Admin UI

Extend `app/routes/app.products.tsx` rather than `app.settings.tsx`.

The admin product page should:

1. Fetch public customizable products only for pricing forms.
2. Keep creator/buy-only products visible only as read-only marketplace status rows or clearly excluded rows.
3. Fetch Shopify variant price range read-only.
4. Load DB pricing by `shopKey` and `shopifyProductId`.
5. Render compact inputs for Embroidery, DTF, and DTG surcharge.
6. Validate numeric input server-side: required, `>= 0`, max two decimals.
7. Save one product at a time.
8. Sync the `customhouse.production_method_pricing` metafield.
9. Sync hidden fee merchandise if the selected checkout strategy requires it.
10. Return explicit status: saved, metafield synced, fee merchandise synced, or partial failure.

### Public PitchPrint UI

Extend `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js` and the product details markup.

The public UI should:

1. Read display config from `customhouse.production_method_pricing`.
2. Render a Printing Method section on PitchPrint-required public customizable products.
3. Require one method before final cart confirmation.
4. Track selected Shopify variant IDs and quantities as an array.
5. Calculate display totals in minor units:
   - product subtotal
   - printing surcharge
   - total quantity
   - final total
6. Recalculate on method, quantity, color, and size changes.
7. Send only identifiers/selections to the server:
   - product ID
   - PitchPrint project ID
   - preview URL if available
   - production method
   - variant/quantity selections
   - optional display totals for diagnostics only

### Server Validation

Add a new public customizable cart preparation service and app-proxy route.

Recommended route shape:

`POST /apps/customhouse/api/public-customizable-products/prepare-cart`

or, if using the catch-all app proxy:

`POST /apps/customhouse/public-products/:productId/prepare-cart`

The service must:

1. Authenticate app proxy and identify shop.
2. Validate product is public customizable, not creator/buy-only.
3. Load `PublicProductProductionPricing` for the shop/product.
4. Reject missing pricing instead of silently charging wrong totals.
5. Validate selected method is enabled.
6. Fetch current Shopify product variants with actual prices from Admin GraphQL.
7. Validate each selected variant belongs to the same product.
8. Validate quantities are safe integers and total quantity is at least 1.
9. Calculate trusted totals from current Shopify variant prices and DB surcharge.
10. Return trusted cart lines for Shopify Ajax add.

### Authoritative Checkout Strategy

Do not assume Cart Transform is available. No current app code indicates an installed, configured Cart Transform function. The safe strategy for this current app is hidden fee merchandise.

Use one app-managed hidden fee product per public customizable product. Each fee product has method variants:

- Embroidery Production Fee
- DTF Production Fee
- DTG Production Fee

Fee variant prices equal the product-specific trusted surcharge. Admin save syncs these variants after DB save.

Prepared cart lines:

1. One base product line per selected Shopify variant/quantity.
2. One production fee line for the selected method.

Fee quantity:

```text
feeQuantity = SUM(selected base variant quantities)
```

Fee line properties:

- `_customhouse_production_fee = true`
- `_customhouse_parent_product_id`
- `_customhouse_parent_project_id`
- `_customhouse_fee_key`
- `_pitchprint`
- `_production_method`

Base line properties:

- `_pitchprint`
- `_pitchprint_preview` when available
- `_production_method`
- `_customhouse_fee_key`

The fee line must be tied to the base lines by `_customhouse_fee_key`. The cart update/reconciliation script must keep fee quantity equal to linked base quantity and remove fee lines when all linked base lines are gone.

Admin sync must prevent preview/cart mismatch:

- If DB save succeeds but metafield sync fails, return partial failure.
- If fee variant sync fails, return partial failure.
- Do not show generic success.
- Product remains saved in DB, but admin must see retry/reconcile action before considering the product fully live.

### Migration Position

Production already has compatible tables and enum. Local repo does not have the matching migration/schema. Implementation should add a local forward-only migration named for the existing production migration and matching Prisma models.

Before any production deploy in a later phase:

1. Inspect production migration state read-only.
2. Confirm `20260826010000_production_method_pricing` is already applied.
3. Run migration status against a Neon clone, not production.
4. Do not apply duplicate production DDL.

If Prisma migration tooling sees the migration as already applied in production, no production DB change should be needed for these tables.

## Expected Files To Change During Implementation

App code:

- `prisma/schema.prisma`
- `prisma/migrations/20260826010000_production_method_pricing/migration.sql`
- `app/routes/app.products.tsx`
- `app/services/production-method-pricing.server.ts` new
- `app/services/production-method-cart.server.ts` new
- `app/routes/proxy.api.public-production-cart.tsx` new, or app-proxy catch-all extension in `app/services/storefront-proxy.server.ts`
- `app/services/shopify-graphql.server.ts` only if safer GraphQL metadata handling is needed
- `app/services/money.ts` only if additional minor-unit helpers are needed

Theme/storefront:

- `theme-live-cart/blocks/_product-details.liquid`
- `theme-live-cart/assets/customhouse-pitchprint-order-handoff.js`
- `theme-live-cart/assets/component-cart-items.js`
- possibly `theme-live-cart/snippets/cart-items-component.liquid` or cart line snippets if fee line display/hiding requires markup changes

Tests:

- `tests/production-method-pricing.test.ts` new
- `tests/storefront-proxy.test.ts`
- `tests/setup-readiness.test.ts`
- `tests/creator-products.test.ts`
- `tests/creator-sales.test.ts` regression only if source-text assertion is updated intentionally

Docs:

- `docs/superpowers/specs/2026-08-27-production-method-pricing-design.md`
- `docs/superpowers/plans/2026-08-27-production-method-pricing.md`

## Risks And Blockers

- Current public PitchPrint handoff captures only one variant/quantity. Multi-size/multi-variant support is a real feature expansion.
- Hidden fee merchandise requires careful Shopify product/variant lifecycle management.
- Shopify cart line pairing can drift when customers update quantities in the cart unless the theme update flow is extended.
- Dynamic checkout/buy-now buttons should be disabled or rerouted for pricing-enabled PitchPrint products because they bypass the fee-line prepare-cart flow.
- Existing production tables are present but local migration history lacks `20260826010000_production_method_pricing`. Later implementation must reconcile local migration files with production state carefully.
- Full `npm test` currently has an unrelated pre-existing `tests/creator-sales.test.ts` source-text assertion failure on the restored baseline. Feature work should not hide that; it should be reported separately or fixed only with approval.

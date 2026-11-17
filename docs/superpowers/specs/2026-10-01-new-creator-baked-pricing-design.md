# New Creator Product Baked Pricing Design

**Source:** User-provided final implementation brief dated 2026-10-01.

## Goal

Make every newly published Creator Product carry its complete production cost in each Shopify variant price. Customers must add the published Creator variant directly and must never receive a second production-fee merchandise line.

## Scope

- Apply only to current and future Creator Products published after this implementation.
- Re-publishing a new-mode product recalculates from the current base-product prices and current Admin production pricing.
- Preserve `null` as the legacy pricing mode. Legacy Creator Products remain on their existing cart behavior and are not migrated, repaired, reconciled, or bulk repriced.
- Preserve the existing separate-fee architecture for public customization.
- Keep the checkout Function source, target, API configuration, and rule state unchanged.

## Canonical Pricing Model

The persisted internal mode and Shopify metafield value are `BAKED_IN_V1`.

For every published variant:

```
final price = base variant price + (authoritative surcharge * placement count)
```

Surcharge selection is server-authoritative:

- Embroidery `TEXT_ONLY`: configured Embroidery Text surcharge.
- Embroidery `IMAGE_OR_LOGO`: configured Embroidery Image/Logo surcharge.
- DTF: configured DTF surcharge.
- DTG: configured DTG surcharge.

The saved PitchPrint contract remains authoritative for artwork subtype and placement count. Browser-submitted prices are ignored. Missing, invalid, or unresolved required pricing blocks publication; no fallback or hardcoded price is permitted.

## Data Model

Add nullable `CreatorProduct.creatorPricingMode`. Existing rows remain `null`. Newly published products receive `BAKED_IN_V1` only after Shopify variant prices and metafields are successfully written and verified.

The saved Creator setup JSON may contain a server-calculated pricing preview for draft/Admin review. It is an estimate based on the server-held base variant snapshot and current Admin pricing. Publishing always rebuilds the immutable pricing plan from fresh Shopify base prices and fresh Admin pricing.

The published Shopify product receives `customhouse.creator_pricing_mode = BAKED_IN_V1` and the existing `customhouse.creator_cart_validation` JSON contract with `feeRequired: false`.

## Canonical Calculator and Variant Identity

One server-side pricing module selects the authoritative surcharge and builds published pricing plans. It is used by new publishing and republishing.

Published variants map to base variants by a canonical normalized identity made from the full selected-option name/value set. Mapping never uses list position, display order, or title alone. Missing matches, duplicate identities, ambiguous identities, and non-bijective mappings fail closed.

Each immutable plan records CreatorProduct identity, mode, method, subtype, placement count, surcharge, base product identity, and for every variant: base ID, published ID, normalized option identity, base price, production cost, and final price.

All money calculations use decimal/minor-unit arithmetic. Every variant begins from the base-product price, so republishing cannot compound a previously baked price and size-specific price differences remain intact.

## Save and Publish Flow

Save Design validates and persists base product, fixed color, method, server-derived artwork subtype, saved placement count, PitchPrint project/design identity, and canonical previews. It calculates and stores a server-side expected-price preview using the existing base variant snapshot and current Admin pricing.

Publishing re-reads the base variants and Admin pricing, duplicates or reuses the Creator Shopify product, restricts it to the fixed color, builds the canonical pricing plan, bulk-updates every remaining published variant, verifies exact prices, writes and verifies the pricing-mode and no-fee validation metafields, then persists `creatorPricingMode = BAKED_IN_V1` and activates the product. A failure must not mark the database row baked while Shopify remains legacy-priced.

## Cart Behavior

`BAKED_IN_V1` cart preparation verifies the selected variant belongs to the published Creator product, clones the saved PitchPrint project as today, preserves Creator/PitchPrint/design/color/method/subtype/placement/acknowledgement/attribution properties, and adds exactly one merchandise item: the selected published Creator variant.

It does not map back to the base variant, create a fee key that requires fee merchandise, synchronize fee merchandise, or append a production-fee line. Quantity is applied only to the selected final-priced variant.

Legacy mode continues through the existing base-variant-plus-fee path. Public customization is unchanged.

## Failure Handling

- Invalid setup, missing pricing, unresolved Embroidery subtype, invalid placement count, and unsafe variant mapping block publication with sanitized Admin-facing errors.
- Shopify bulk-update user errors or price verification mismatches block activation and leave `creatorPricingMode` unset.
- Metafield write or verification failure blocks activation and leaves `creatorPricingMode` unset.
- Re-publication always recalculates from fresh base prices.
- No order, sale, earning, referral, payout, or previous order-price record is updated.

## Verification and Release

Focused tests cover method/subtype pricing, placement multiplication, variant identity, size price differences, republish non-compounding, mode/metafield/contract persistence, baked cart composition, metadata, legacy behavior, public customization regression, and unchanged checkout Function source.

Work proceeds on `development`, followed by automated verification and a Vercel preview. Manual QA uses a completely new Creator Product. Promotion to `main`, Vercel production, and any Shopify app release require the repository's approval gate.

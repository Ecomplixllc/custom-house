# Creator Artwork Preview and Embroidery Pricing Design

**Source:** User-provided final implementation brief dated 2026-09-29.

## Goal

Use PitchPrint's canonical saved-project output for Creator Product previews, derive Embroidery artwork type from saved design objects, and select the existing Admin-configured Text or Image/Logo production fee without changing working color, method, size, quantity, or public-customization behavior.

## Verified Current State

- Creator Add Product already requires one Printing Method and no dashboard color.
- Color is selected inside PitchPrint and persists through CreatorProduct setup.
- `project-saved` is already the intended save boundary.
- The browser preview normalizer accepts broad fallback fields such as `preview`, `url`, and `src`; these can admit editor/canvas imagery instead of PitchPrint's canonical page renders.
- PitchPrint documents `project-saved.data.previews` as the canonical array of saved project page previews and `project-saved.data.source` as the serialized project source.
- `embroiderySubtype` is optional in the current setup and is not derived from saved project objects, so the review UI can display no value.
- Existing persistence already supports `embroiderySubtype`, `placementCount`, `placements`, project/design IDs, and preview URLs inside existing CreatorProduct columns/contracts.
- Existing Admin schema and services already support separate `embroideryTextSurcharge`, `embroideryImageSurcharge`, and fee-variant IDs. No new pricing schema is needed.
- Production currently has a legacy Embroidery surcharge of 30, but both subtype prices are 0 and both subtype fee-variant IDs are absent. Those values are merchant configuration, not implementation defaults.

## Data Contract

At `project-saved`, accept the canonical PitchPrint fields from `event.data`:

- `projectId`
- `designId` when supplied
- `previews` in page/surface order
- `source`, parsed with strict size/depth/object limits
- `numPages`
- `meta` only for documented surface labels or identifiers

Do not accept generic editor screenshot candidates as production previews. Persist a normalized surface-preview list in existing CreatorProduct JSON storage, preserving distinct Front, Back, and Side mappings where the saved event identifies them.

Derive normalized artwork facts from the saved source:

- text object count
- image/logo/photo object count
- printable surface identifiers containing artwork
- total placement count from those saved printable surfaces

For Embroidery, classify `TEXT_ONLY` only when every printable object is text and at least one printable text object exists. Classify `IMAGE_OR_LOGO` when any printable image, photo, logo, raster, or vector-image object exists. Text plus image is `IMAGE_OR_LOGO`. A missing or unrecognized object contract is a recoverable validation error, never a guess.

The server ignores a browser-claimed subtype and recomputes the subtype from the bounded saved-source facts. This is the strongest validation available from the documented client save contract; no undocumented PitchPrint API will be called. Admin approval remains the human verification boundary for a Creator-submitted design.

## Pricing and Publishing

Use the existing Creator production-pricing row and existing subtype helpers:

- `TEXT_ONLY` -> configured Embroidery Text surcharge and fee variant
- `IMAGE_OR_LOGO` -> configured Embroidery Image/Logo surcharge and fee variant
- DTF/DTG -> unchanged existing method pricing

Publishing and cart preparation must reject unresolved Embroidery subtype or an unsynced required subtype fee variant. The checkout Function contract remains unchanged because it already consumes the server-selected fee variant and placement count.

Persist artwork type, placement count, project identity, fixed color, fixed method, and side preview references through edit, publish, cart, and order metadata using existing JSON/metafield/property mechanisms.

## UI and Failure Handling

The Save Design review uses only saved project page previews. Its thumbnails and main image share the same normalized surface records. Selecting a thumbnail updates the main image; no CSS overlay or manual garment composition is introduced.

For Embroidery, show `Text only` or `Image / Logo`. For DTF/DTG, omit the Embroidery artwork-type row.

Reject final save when project identity, canonical previews, color, method, confirmation, placement facts, or Embroidery classification is missing. Keep the draft and display a recoverable message.

## Scope Boundaries

- No Product Color selector on Add Product.
- No Printing Method dropdown refactor.
- No pricing schema duplication or hardcoded prices.
- No public-customer customization changes.
- No referral, payout, welcome-email, application, footer, menu, or unrelated UI changes.
- No checkout Function change unless a failing contract test proves a minimal compatibility change is necessary.
- No bulk product changes.

## Release and QA

Implement on `development`, run focused tests, then the complete test/typecheck/build/lint/diff verification. After test deployment and approval, merge to `main`, verify the exact Vercel production commit, and release the storefront extension only when Shopify's platform constraints permit it without unrelated risk.

Live QA uses exactly two fresh designs: one Green T-shirt with Embroidery text `HELLO`, and one Green T-shirt with one obvious logo/image. Merchant-configured subtype prices must exist before price-selection QA can pass.

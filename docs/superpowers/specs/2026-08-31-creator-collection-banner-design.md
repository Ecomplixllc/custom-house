# Creator Collection Banner Management Design

## Goal

Approved creators can manage a creator-controlled banner on their existing app-managed creator collection page. Banner data belongs to the existing `CreatorCollection` record and never creates Shopify native collections or changes creator product, pricing, commission, referral, payout, order, PitchPrint, or checkout behavior.

## Current Architecture

The creator dashboard is a Shopify theme app extension block in `extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid`, hydrated by `extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js` and styled by `extensions/customhouse-creator-storefront/assets/customhouse.css`.

Creator dashboard data is loaded through signed Shopify app-proxy routes such as `/apps/customhouse/api/creator-dashboard`. The server resolves the signed app-proxy session in `app/services/proxy.server.ts`, normalizes `logged_in_customer_id`, and looks up the creator by `(shop, customerId)`.

Public creator pages are app-managed app-proxy HTML pages routed through `app/routes/proxy.$.tsx` into `app/services/storefront-proxy.server.ts`. `/apps/customhouse/creators/{publicHandle}` loads the existing `CreatorCollection` via `getPublicCreatorCollection()` and lists only published creator products for that creator.

Image upload already uses Shopify-hosted media in `app/services/profile-image.server.ts`: validate server-side, create a Shopify staged upload, POST the file bytes, then call Admin GraphQL `fileCreate`. This feature reuses that pattern for public banner media.

## Data Model

Extend `CreatorCollection` with nullable fields:

- `bannerImageUrl String?`
- `bannerTitle String?`
- `bannerSubtitle String?`
- `bannerUpdatedAt DateTime?`

The migration is forward-only and additive. Existing creators with no banner keep rendering exactly as they do today.

## Server Behavior

Add a focused banner service that:

- Resolves the authenticated creator from server-side app-proxy context using `(shop, logged_in_customer_id)`.
- Requires the creator to exist and be `APPROVED`.
- Reads or updates only the authenticated creator's `CreatorCollection`.
- Rejects missing collection, unauthenticated visitor, suspended/pending/rejected creators, invalid files, invalid text, and failed Shopify upload with safe `DomainError` messages.
- Never accepts `creatorId` from the browser.
- Writes audit rows for save and remove.

Banner image upload uses Shopify Admin GraphQL only. If an old image is replaced or removed, the old remote media is not deleted because the current schema stores only a public URL, not a proven exclusive Shopify media ID. Retaining it is safer than deleting a potentially shared asset.

## API

Add `/apps/customhouse/api/creator-collection-banner`.

`GET` returns the authenticated creator's collection banner fields and public URL.

`POST multipart/form-data` supports `intent=save` with optional `bannerImage`, `bannerTitle`, and `bannerSubtitle`. Title/subtitle can be updated without an image. If an image is present, it is validated and uploaded to Shopify Files.

`POST application/json` supports `intent=remove`, clearing the complete banner configuration.

## Creator Dashboard UI

Add a compact "Collection Banner" section to the existing Account area. It includes responsive preview, file input, title/subtitle fields, 1920 x 600 px helper copy, loading/success/error feedback, and a remove confirmation using the existing dashboard action modal pattern.

The dashboard JS stores latest banner data in dashboard state and rehydrates after save/remove so refresh persistence is visible.

## Public Storefront

`collectionHtml()` renders a banner block above the existing hero only when `collection.bannerImageUrl` is a safe HTTPS URL.

The existing hero remains untouched and remains the fallback when no banner exists. The banner uses responsive cover cropping, a soft overlay for text readability, alt text from `bannerTitle` or `${creatorName} collection banner`, and does not introduce an extra `h1`.

## Admin

The existing Admin -> Creators page includes each creator's `marketplaceCollection` banner fields. The table/detail view shows whether a banner exists and, when present, a compact preview link/thumbnail. Admin removal may be added through the existing form/action pattern if it remains small and safe.

## Tests And Verification

Test-first coverage includes banner validation, Shopify-hosted upload, authenticated creator-only save/remove, route/dashboard wiring, public HTML/JSON fallback behavior, and admin visibility.

Deployment requires passing Prisma validation, migration status, typecheck, lint, relevant tests, production build, isolated branch diff review, production migration deploy, app deployment, Shopify extension deployment if dashboard assets changed, and live smoke tests.

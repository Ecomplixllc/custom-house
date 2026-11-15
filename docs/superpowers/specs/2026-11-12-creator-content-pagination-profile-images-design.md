# Creator Content Pagination and Profile Images Design

## Intent

Polish the public Creator Content discovery page by replacing the Load More control with professional numbered pagination and ensuring uploaded Creator profile images appear wherever Creator identity is shown.

## Goals

- Show 12 matching products per page with Previous, numbered pages, Next, a current-page state, and a compact page summary.
- Keep search, sorting, category chips, filters, browser history, and responsive filter-drawer behavior working across the complete catalog.
- Reset pagination to page 1 when discovery criteria change and preserve a valid `page` query parameter during navigation.
- Resolve stored Shopify MediaImage or GenericFile GIDs through authenticated Admin GraphQL before rendering public Creator avatars.
- Keep HTTPS profile URLs unchanged and use initials only when no safe resolved image exists.

## Non-goals

- No changes to upload authorization, creator approval, product publishing, pricing, or storefront product routes.
- No new image provider, undocumented Shopify API, database migration, or client-supplied customer identity.
- No production deployment without a new explicit approval after the development preview is verified.

## Constraints

- Preserve Shopify authentication, app-proxy verification, Prisma sessions, Admin GraphQL patterns, and current Creator/Public separation.
- Use the existing 12-product server batch and complete-catalog fetch path; do not expose Shopify GIDs in rendered image URLs.
- Keep all unrelated working-tree changes untouched.

## Approaches

1. **Client-side numbered pagination over the authenticated complete-catalog fetch (selected).** It preserves full-catalog filters and requires no count migration or extra public endpoint.
2. Server-only Previous/Next links. Simpler, but cannot provide reliable page numbers after Shopify validation without a new total-count contract.
3. New JSON pagination API. Flexible, but adds unnecessary surface area for the current page and duplicates the existing safe HTML fetch path.

The selected approach reuses the current app-proxy HTML pagination batches, loads remaining safe pages in the background, and paginates the resulting filtered card set in the browser.


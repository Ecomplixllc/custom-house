# Creator Content Discovery Design

## Intent

Add a dedicated CustomHouse storefront discovery page for real published Creator products and a small authenticated Admin curation screen for ordering Featured Creators. The page must preserve the existing Creator profile, buy-only product detail, shared inventory, pricing, attribution, commission, referral, payout, and cart flows.

## Goals

- Serve `/apps/customhouse/creator-content` from the existing authenticated Shopify app-proxy architecture.
- Show only approved Creators with active public collections and published, purchasable Creator products.
- Use real Creator categories and real Shopify product price, variant, color, size, and availability data.
- Let Admin users manage an ordered Featured Creator list at `/app/creator-content`.
- Link cards to the existing Creator profile and buy-only product routes.
- Provide isolated dark CustomHouse styling, responsive filters, debounced search, and real newest/price sorting.

## Non-goals and anti-goals

- No new product detail page, direct grid cart, product customization, PitchPrint entry, fake Follow control, fake Wishlist control, popularity metric, or static Creator data.
- No changes to Base Products, normal collections, normal products, Creator draft/submit, publishing, production pricing, shared inventory, checkout, commission, referral, or payout behavior.
- No production deployment in this task.

## Constraints

- Shopify app-proxy authentication remains the public trust boundary; Admin mutations require `authenticate.admin`.
- Creator identity uses `Creator.id` and `CreatorCollection.publicHandle`, never display-name matching.
- Public eligibility is the intersection of `Creator.status = APPROVED`, `CreatorCollection.status = ACTIVE`, and `CreatorProduct.status = PUBLISHED`, plus valid Shopify product publication/buy-only data.
- Styles and scripts are scoped beneath `.customhouse-creator-content-page`.
- Existing dirty Collections-page work is preserved unchanged.

## Approaches

1. **Dedicated app-proxy HTML page (selected).** Reuses the current public Creator shell, routes, GraphQL abstraction, and buy-only links while keeping authoritative Creator data server-side.
2. Theme page backed by app-proxy JSON. Rejected because it duplicates a complex public data renderer in Liquid and creates more cross-system state.
3. Native Shopify collection. Rejected because Featured Creator ordering and Creator lifecycle filtering are app-owned and cannot safely be inferred from collection membership alone.

## Architecture

- Add a shop-scoped ordered `FeaturedCreator` relation in Prisma.
- Add a Creator Content domain service that validates Admin selections and produces a bounded, public discovery dataset with one database query group and batched Shopify GraphQL product lookup.
- Add `/app/creator-content` for authenticated selection, removal, and ordering.
- Extend the existing app-proxy router with `/apps/customhouse/creator-content`, render the new discovery HTML in `storefront-proxy.server.ts`, and preserve existing profile/product routes.
- Add duplicate-safe desktop and mobile storefront navigation links without replacing merchant links.

## Product behavior

- Search covers Creator display name, public handle, categories, collection title, and product title.
- Filters are generated only from returned Creator, category, product type, size, color, price, and availability values.
- Sorting supports Newest, Price low to high, and Price high to low.
- Product cards expose only `BUY PRODUCT`; Creator cards expose only `VIEW CREATOR`.
- Mobile uses horizontal category/Creator scrolling and a modal filter drawer; desktop uses a sidebar.


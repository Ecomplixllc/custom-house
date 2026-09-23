# Implementation Status

## Render PostgreSQL production preparation

- Prisma datasource converted from SQLite to PostgreSQL via `DATABASE_URL`.
- SQLite migrations replaced with a clean PostgreSQL baseline generated from the complete current schema.
- Added unauthenticated `GET /health`, Render deployment instructions, and production environment template.
- Production server verified with `PORT=4010` and `HOST=0.0.0.0`; `/health` returned `{"status":"ok"}` without querying Shopify or exposing configuration.
- Publishing retries now claim the submission atomically, reuse `createdProductId`, keep products DRAFT through configuration/publication, activate last, and attempt to return failures to DRAFT.
- A live `prisma migrate deploy` still requires the new Render PostgreSQL `DATABASE_URL`; local migration validation confirmed the baseline exactly matches Prisma's generated PostgreSQL SQL.

## Phases 1–6 — implemented and locally validated

- Audited generated React Router scaffold, SQLite Session model, Shopify runtime API July 2026, and TOML webhook API 2026-10.
- Git checkpoint unavailable: the repository has no commits and every scaffold file is untracked.
- Created project rules and implementation plan.

- Added marketplace schema/migration, transactional applications/status changes/submissions/audits, GraphQL abstraction, manual provider, publishing retry state, signed proxy APIs, admin navigation, setup/settings/product validation, privacy/deletion webhooks, and six theme integration components.
- Validation: Prisma migration applied; 6 tests passed; ESLint passed; strict typecheck passed; production client/SSR build passed.

## Live-shop and known limitations

- Credentials were not available, so GraphQL mutations, webhook delivery, extension deployment, publication, and Theme Editor placement require merchant testing.
- Profile-image input supports validated HTTPS URLs; staged upload/Files UI is not implemented.
- Creator metaobject/customer-status-metafield settings are persisted, but automatic sync awaits merchant field mapping validation.
- Preview media attachment is intentionally deferred until live-Shopify file/media validation; publishing does not blindly copy base media.
- Helium tagged-customer import UI and bulk product validator remain follow-up work; Helium/Flow are not modified.
- In-memory rate limits are suitable only for a single process; production multi-instance hosting needs shared storage.

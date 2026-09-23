# Render Deployment

## Architecture

Use one Render PostgreSQL database and one Node Web Service. All Shopify sessions and Creator Marketplace records use the single Prisma `DATABASE_URL`. This repository intentionally does not include `render.yaml`: the current Render Blueprint schema was not validated during this change, so manual setup avoids guessing deployment fields or secret wiring.

## 1. Create Render PostgreSQL

1. In Render, create a PostgreSQL database in the same region as the Web Service.
2. Select an appropriate paid production plan, retention period, and high-availability option.
3. Copy the **internal database URL** into the Web Service's secret `DATABASE_URL` environment variable. Never commit it.
4. Keep Render backups enabled and test restoration before launch.

The database is expected to be empty for the first deployment. The prior SQLite database contained development-only data and is not imported.

## 2. Create the Render Web Service

- Runtime: Node
- Repository: this repository and production branch
- Build command: `npm ci && npx prisma generate && npm run build`
- Pre-deploy command: `npx prisma migrate deploy`
- Start command: `npm run start`
- Health check path: `/health`

The compiled app is started by `react-router-serve ./build/server/index.js`. The installed server reads Render's `PORT`; with no host override, Node listens on all interfaces. If the Render service configuration requires an explicit host, set `HOST=0.0.0.0` in Render only.

## 3. Required environment variables

Configure these as Render secrets/environment values:

- `DATABASE_URL` — Render PostgreSQL internal URL
- `SHOPIFY_API_KEY` — production app client ID
- `SHOPIFY_API_SECRET` — production app client secret
- `SHOPIFY_APP_URL` — permanent HTTPS Render/custom-domain origin, without a trailing path
- `SCOPES` — comma-separated scopes matching the production Shopify TOML
- `NODE_ENV=production`

Never place secret values in Git, logs, Blueprint files, browser JavaScript, or Shopify theme assets.

## 4. Shopify production configuration

Keep `shopify.app.toml` as the development configuration. Create/link a separate `shopify.app.production.toml` through Shopify CLI for the same app and preserve all scopes, webhooks, metafield/metaobject declarations, and extension configuration. Set:

- `application_url` to the permanent HTTPS app origin
- the auth callback URL to `<origin>/auth/callback` as required by the linked CLI configuration
- `[app_proxy].url` to `<origin>/proxy`
- `[build].automatically_update_urls_on_dev = false`
- `embedded = true`
- managed installation (`use_legacy_install_flow` omitted or `false`)

Deploy the production Shopify configuration and extension using the production config selection. Reinstall or approve changed scopes before testing.

Required scopes: `read_products`, `write_products`, `read_customers`, `write_customers`, `read_metaobjects`, `write_metaobjects`, `write_metaobject_definitions`, `read_files`, `write_files`, `read_publications`, and `write_publications`.

## 5. App Proxy

The Shopify proxy remains `/apps/customhouse` and forwards to the backend `/proxy`. In production, set the proxy destination to `<origin>/proxy`, deploy the configuration, and verify signed requests. Do not point production proxy traffic at a development tunnel.

## 6. Custom Distribution installation

For a custom-distribution app, use the installation link generated for the intended merchant/store. Confirm the store and app identity before approval. After installation, verify an offline session exists, webhooks are registered, and the embedded app loads from Shopify Admin. Never publish or share a custom installation link beyond intended merchants.

## 7. First deployment verification

1. Confirm `GET /health` returns only `{"status":"ok"}`.
2. Confirm the pre-deploy migration completed before the new service version started.
3. Open every embedded admin page and verify authentication.
4. Verify app-proxy login and ownership checks.
5. Use a disposable Global Product to test creator approval, submission, failure recovery, and publication.
6. Confirm failed publishing leaves the duplicated product DRAFT and retry reuses its saved product ID.

## 8. Rollback

1. Stop marketplace write actions or place the app in maintenance mode at the platform edge.
2. Restore the prior Render service deployment.
3. Do not automatically roll back a database migration. Inspect the migration and restore the matching Render PostgreSQL backup when schema rollback is actually required.
4. If restoring a backup, point `DATABASE_URL` only after verifying the target database and recovery time, then restart the service.
5. Re-run health, authentication, session, and publishing-retry checks.

## Troubleshooting

- **Build cannot import Prisma Client:** ensure `npx prisma generate` runs after `npm ci`.
- **Migration cannot connect:** verify the internal `DATABASE_URL`, database status, region/network, and TLS parameters supplied by Render.
- **App redirects to a tunnel/example URL:** deploy/select `shopify.app.production.toml` and verify `SHOPIFY_APP_URL`.
- **OAuth callback rejected:** make the production callback URL exactly match Shopify configuration.
- **App proxy 404/signature failure:** verify the permanent proxy URL and that the request comes through Shopify's `/apps/customhouse` path.
- **Publication access denied:** approve the publication scopes through managed installation.
- **Service fails Render health checks:** inspect startup logs, confirm the build exists, and verify Render supplies `PORT`; `/health` never depends on Shopify or the database.
- **Prisma migration drift:** do not use `db push`; reconcile schema changes through reviewed migrations in a non-production database first.

# Vercel deployment — Custom House Creator

This runbook migrates the existing ECOMPLIX Custom House Creator backend from
Render to Vercel without creating or relinking a Shopify app. Render remains the
rollback target until production acceptance is complete.

## Architecture

- Runtime: Vercel Node.js Functions through the official
  `@vercel/react-router` preset.
- Framework build: `npm run build`.
- Runtime database: Neon pooled PostgreSQL URL in `DATABASE_URL`.
- Migration database: Neon direct PostgreSQL URL in `DIRECT_DATABASE_URL`.
- Migrations are an explicit release step. They are not executed by requests.

## Required Vercel environment variables

Add these in **Vercel Project → Settings → Environment Variables**. Apply them
to Production. Add Preview values only if a preview deployment must access the
same resources.

| Name | Source | Secret |
| --- | --- | --- |
| `DATABASE_URL` | Neon pooled connection string | Yes |
| `DIRECT_DATABASE_URL` | Neon direct connection string | Yes |
| `SHOPIFY_API_KEY` | Existing ECOMPLIX app client ID | Yes |
| `SHOPIFY_API_SECRET` | Existing ECOMPLIX app secret | Yes |
| `SHOPIFY_APP_URL` | Final Vercel production origin, no trailing slash | No |
| `SCOPES` | Existing production scope list | No |
| `SHOP_CUSTOM_DOMAIN` | Optional custom Shopify domain allowlist value | No |
| `NODE_ENV` | `production` | No |

Never paste values into source files, build logs, screenshots, support tickets,
or Git commits.

## Create the Vercel project

1. In Vercel, import the existing GitHub repository.
2. Select the existing production branch; do not create a new Shopify app.
3. Confirm Vercel detects React Router.
4. Install command: `npm ci`.
5. Build command: `npm run build`.
6. Do not configure a long-running start command.
7. Use Node.js 22.
8. Keep Deployment Protection disabled for the production `/health`,
   `/webhooks/*`, `/proxy/*`, `/auth/*`, and embedded `/app/*` endpoints.
9. Add all environment variables above using encrypted Vercel settings.
10. Deploy to the temporary Vercel production URL.

## Database validation

Run these from a trusted release environment with both Neon URLs present:

```powershell
npx prisma format
npx prisma validate
npx prisma generate
npx prisma migrate status
```

Expected result: `Database schema is up to date.` Do not use `prisma db push`,
`prisma migrate reset`, or destructive SQL.

For a future migration, run `npx prisma migrate deploy` once as an explicit
pre-release command against `DIRECT_DATABASE_URL`. Never run migrations from a
Vercel request handler.

## Pre-cutover verification

Before changing Shopify:

1. Vercel deployment state is Ready.
2. `GET https://<vercel-origin>/health` returns HTTP 200.
3. The response reports `environment: configured` and `database: connected`.
4. No Render origin is hard-coded in server code.
5. Vercel production endpoints are not behind Deployment Protection.

## Shopify cutover

Only after pre-cutover verification:

1. Replace only the Render origin in `shopify.app.production.toml` for
   `application_url`, the existing auth redirect URL, and `app_proxy.url`.
2. Preserve every existing path exactly.
3. Set Vercel `SHOPIFY_APP_URL` to the same origin.
4. Run:

```powershell
shopify app config validate --config production
shopify app deploy --config production
```

Do not run `shopify app dev`, relink the app, uninstall it, delete Flow
workflows, or publish a theme.

## Acceptance checks

Verify embedded Admin pages, Settings, Setup Guide, Applications, Creators,
Dry Run, Helium customer synchronization, approval/tag transitions, one
collection, Creator Dashboard, design submission, and buy-only product
publishing. Confirm no duplicate Creator, CreatorApplication, collection, or
product is produced.

## Rollback to Render

1. Confirm `https://custom-house.onrender.com/health` is healthy.
2. Restore the Render origin in the three existing
   `shopify.app.production.toml` URL locations without changing their paths.
3. Set the Render service `SHOPIFY_APP_URL` to
   `https://custom-house.onrender.com`.
4. Run `shopify app config validate --config production`.
5. Run `shopify app deploy --config production`.
6. Verify embedded Admin, App Proxy, webhooks, and creator dashboard.
7. Keep Neon unchanged; do not restore or recreate the database.

Do not delete the Vercel project or Render service until rollback verification
and merchant approval are complete.

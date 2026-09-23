# Production Database

The app now uses PostgreSQL through `DATABASE_URL` in every environment. Prisma session storage and all Creator Marketplace models share the exported client in `app/db.server.ts`.

Production deployments must run `npx prisma migrate deploy`; `prisma db push` is not an accepted deployment strategy. The PostgreSQL baseline in `prisma/migrations` represents the complete current schema. The former SQLite database is development-only and intentionally not migrated.

Use encrypted managed PostgreSQL, least-privilege credentials, private networking, automated backups, restore drills, monitoring, and a single controlled migration step before application rollout. See `docs/RENDER_DEPLOYMENT.md`.

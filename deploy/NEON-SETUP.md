# Neon PostgreSQL setup

**Never commit** your real connection string to GitHub. Use **Render → Environment** only.

## Connection string format

In Render, add:

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Use the **pooled** connection string from the Neon dashboard (recommended for Render).

## Optional direct URL (migrations)

```
DATABASE_URL_DIRECT=postgresql://USER:PASSWORD@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

## One-time schema

In Neon **SQL Editor**, paste contents of `lib/schema-postgres.sql`, or let the app create tables on first deploy (`npm run build` runs schema generation).

Local apply:

```bash
set DATABASE_URL=postgresql://...
node scripts/apply-neon-schema.js
```

## Local dev

```bash
# .env
DATABASE_URL=postgresql://...
PUBLIC_BASE_URL=http://localhost:3000
```

Without `DATABASE_URL`, the app uses local `database.sqlite`.

Production hosting: **[DEPLOY-RENDER.md](DEPLOY-RENDER.md)**.

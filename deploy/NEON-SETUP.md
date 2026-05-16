# Neon PostgreSQL setup

## Security

**Never commit** your real connection string to GitHub. Use Vercel → **Environment Variables** only.

If your password was shared in chat or email, **rotate it** in Neon → Project → Connection details → Reset password.

---

## Connection string format (Vercel)

In Vercel, add one variable:

```text
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Use the **pooled** connection string from the Neon dashboard (recommended for Vercel).

You can omit `&channel_binding=require` if clients fail to connect; `sslmode=require` is enough for Node `pg`.

---

## Connect with psql (optional)

Install [PostgreSQL client](https://www.postgresql.org/download/windows/) or use Neon SQL Editor in the browser.

From Neon dashboard, copy the connection string, then:

```powershell
# Windows — use the URL from Neon (replace with your current password)
psql "postgresql://neondb_owner:YOUR_PASSWORD@ep-ancient-math-ap3ioz6o-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require"
```

Neon also supports:

```text
Host: ep-ancient-math-ap3ioz6o-pooler.c-7.us-east-1.aws.neon.tech
Database: neondb
User: neondb_owner
SSL: require
```

`psql -h pg.neon.tech` is an interactive helper some docs mention; the **host in your connection string** is the correct endpoint for your project.

---

## Apply schema once (optional)

In Neon **SQL Editor**, paste contents of `lib/schema-postgres.sql`, or let the app create tables on first Vercel deploy.

---

## Local dev with Neon

Create `.env` in project root (this file is gitignored):

```env
DATABASE_URL=postgresql://...
PUBLIC_BASE_URL=http://localhost:3000
```

Then:

```bash
npm install
npm start
```

Without `DATABASE_URL`, the app uses local `database.sqlite`.

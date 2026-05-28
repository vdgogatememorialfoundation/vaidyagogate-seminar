# Deploy on Render + Neon PostgreSQL

Production hosting uses **[Render](https://render.com)** (Web Service) and **[Neon](https://neon.tech)** (PostgreSQL).

## Render Web Service

| Setting | Value |
|---------|--------|
| **Build Command** | `npm run build` |
| **Start Command** | `npm start` |
| **Node version** | 20+ |

## Required environment variables

Set in **Render → Web Service → Environment**:

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | Neon **pooled** URL with `?sslmode=require` |
| `PUBLIC_BASE_URL` | `https://seminar.vaidyagogate.org` |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | Super admin email |
| `ADMIN_PASSWORD` | Strong password |
| `SEMINAR_HOST` | `seminar.vaidyagogate.org` |
| `ADMIN_HOST` | `admin.vaidyagogate.org` |
| `JUDGE_HOST` | `judge.vaidyagogate.org` |
| `WIX_SITE_URL` | `https://www.vaidyagogate.org` |
| `JWT_SECRET` | Long random string |

Optional: payment keys, Zoho SMTP, Shiprocket, R2 — see `.env.example`.

## Cron jobs (notifications)

On Render, use **Cron Jobs** in the dashboard or an external scheduler to call:

- `GET https://your-domain/api/cron/process-notifications` with header `Authorization: Bearer YOUR_CRON_SECRET`
- `GET https://your-domain/api/cron/pending-registration-reminders` (same auth)

Set `CRON_SECRET` in Render env.

## Public book shipment tracking

Branded page: **`https://seminar.vaidyagogate.org/track-shipment`** (also `/track-shipment.html`).  
Legacy `/order-tracker` and `/track-book` redirect here. Set `PUBLIC_BASE_URL` so API share links use the full URL.

## Health check

`GET /api/health` — confirms `DATABASE_URL`, Postgres connectivity, and bootstrap state.

## DNS

Point `seminar.vaidyagogate.org` (and other subdomains) to your Render service hostname or custom domain in Render → Settings → Custom Domains.

See also: [deploy/WIX-DNS.md](WIX-DNS.md), [deploy/NEON-SETUP.md](NEON-SETUP.md).

## Local dev

Omit `DATABASE_URL` to use `database.sqlite`, or set Neon URL in `.env`.

Never commit `.env` or real passwords to Git.

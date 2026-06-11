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

## Keep web service awake (free tier spin-down)

Render free web services sleep after ~15 minutes without **incoming** HTTP traffic. This app auto-pings its own public health URL every 10 minutes when `RENDER=true` (set automatically on Render). Requires `PUBLIC_BASE_URL` (or Render’s `RENDER_EXTERNAL_URL`).

- Disable: `DISABLE_RENDER_KEEPALIVE=1`
- Interval: `RENDER_KEEPALIVE_INTERVAL_MS=600000` (default 10 min)

Logs: `[render-keepalive] enabled — pinging …` after deploy.

**Note:** If the instance is already asleep, the first visitor still waits for cold start (~30–60s). For 24/7 uptime, use a paid Render instance or an external monitor (e.g. UptimeRobot) hitting `/api/health` every 5–10 minutes.

## DNS

Point `seminar.vaidyagogate.org` (and other subdomains) to your Render service hostname or custom domain in Render → Settings → Custom Domains.

See also: [deploy/WIX-DNS.md](WIX-DNS.md), [deploy/NEON-SETUP.md](NEON-SETUP.md).

## Local dev

Omit `DATABASE_URL` to use `database.sqlite`, or set Neon URL in `.env`.

Never commit `.env` or real passwords to Git.

## Deploy not appearing on Render?

Git pushes to GitHub **do not deploy by themselves** unless **Auto-Deploy** is enabled on the Web Service.

1. Open **[Render Dashboard](https://dashboard.render.com)** → your **Web Service** (seminar app).
2. **Events** tab — if nothing new after `git push`, auto-deploy is likely off or the wrong branch/repo is linked.
3. **Settings → Build & Deploy**
   - **Repository:** `vdgogatememorialfoundation/vaidyagogate-seminar`
   - **Branch:** `main`
   - **Auto-Deploy:** **Yes**
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
4. **Manual Deploy now:** top-right **Manual Deploy** → **Deploy latest commit** (should show `2dc607e7` or newer — *Phase 2 support desk*).
5. Wait for build to finish (green **Live**). Then verify:
   - `https://seminar.vaidyagogate.org/support.html` → **200**
   - `https://seminar.vaidyagogate.org/api/public/support/hours` → JSON with `openNow`

If the build **fails**, open the failed deploy log. Common fixes: set `DATABASE_URL` (Neon pooled URL), Node 20+, and ensure `npm run build` passes locally.

### Deploy hook (optional)

Render → Settings → **Deploy Hook** gives a URL. POST to it after push (or save as GitHub Actions secret `RENDER_DEPLOY_HOOK_URL`) to force deploy when auto-deploy is off.

### Confirm production version

After deploy, `/api/public/support/hours` must return **200**. If it returns **404**, production is still on an older build (support desk is in commit `2dc607e7` on `main`).

# Static frontend on Vercel (no serverless CPU on page loads)

This repo is **Express + static HTML** (not Next.js). For the registration surge, deploy **only `public/`** on Vercel and run **`server.js` on a separate host** (Railway, Render, Fly.io, VPS).

## 1. Vercel (static site)

Set **Environment variable** (Production):

| Variable | Example |
|----------|---------|
| `API_BACKEND_URL` | `https://api.seminar.vaidyagogate.org` |

Build runs `node scripts/prepare-static-deploy.js`, which:

- Sets `outputDirectory` to `public`
- **Removes** `server.js` from Vercel builds (no Fluid CPU on HTML/JS)
- Adds **rewrites**: `/api/*` and `/uploads/*` → your backend URL
- Host redirects: `admin.*` → `admin.html`, `judge.*` → `judge.html`

Push to GitHub; Vercel redeploys automatically.

## 2. Backend (API + database)

On Railway/Render/VPS:

```bash
npm start   # node server.js
```

Required env: `DATABASE_URL`, `PUBLIC_BASE_URL`, payment keys, SMTP, etc. (see `.env.example`).

**Crons** (notifications, reminders) must run on the **backend** host, not Vercel:

- `GET /api/cron/process-notifications` (daily)
- `GET /api/cron/pending-registration-reminders` (daily)

Use your host’s cron or an external cron service hitting those URLs with your cron secret.

## 3. DNS

| Host | Points to |
|------|-----------|
| `seminar.vaidyagogate.org` | Vercel (static) |
| `admin.vaidyagogate.org` | Vercel (static) |
| `judge.vaidyagogate.org` | Vercel (static) |
| `api.seminar.vaidyagogate.org` (or same seminar host) | Backend server |

If frontend and API share one domain, set `API_BACKEND_URL` to that same origin (e.g. `https://seminar.vaidyagogate.org`) only if the **API is still served from that host** via rewrite/proxy—not via Vercel Node.

## 4. What breaks on static-only Vercel

| Feature | Where it runs |
|---------|----------------|
| Registration, OTP, payments | Backend `/api/*` |
| File uploads | Backend `/uploads/*` or R2 |
| Webhooks (Razorpay, WhatsApp, Mailparser) | Backend only |
| Book sales courier polling | Backend only |

The browser already uses `fetch('/api/...')`; Vercel **rewrites** forward those to `API_BACKEND_URL` without running `server.js`.

## 5. Local static preview

```bash
API_BACKEND_URL=http://localhost:3000 node scripts/prepare-static-deploy.js
npx serve public
```

Backend must be running on port 3000 for API calls (or set `API_BACKEND_URL` to your staging API).

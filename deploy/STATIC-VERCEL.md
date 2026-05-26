# Vercel-only deployment (static frontend + API backend)

Two **Vercel projects** from this **same GitHub repo**. Page loads use **zero Node CPU**; API runs only on the backend project.

## Project A — Static frontend (seminar / admin / judge domains)

| Setting | Value |
|---------|--------|
| **Build Command** | `npm run vercel-build` (default) |
| **Environment variable** | `VERCEL_DEPLOYMENT_TYPE` = `static` (optional; default) |
| **`API_BACKEND_URL`** | `https://api.vaidyagogate.org` (your API project URL or custom domain) |

### Steps

1. Vercel → **Settings → Environment Variables** → add:
   - `API_BACKEND_URL` = `https://api.vaidyagogate.org`  
     (or your backend `*.vercel.app` URL until DNS is ready)
2. **Redeploy** → enable **Clear Build Cache**.
3. Build runs `prepare-static-deploy.js`, which:
   - Sets `outputDirectory: public` (static only)
   - Adds edge **rewrites**: `/api/*` and `/uploads/*` → `API_BACKEND_URL`
   - Host redirects: `admin.*` → `admin.html`, `judge.*` → `judge.html`

Browsers keep `fetch('/api/...')` on the same host; Vercel edge proxies to the backend **without** running `server.js` on the frontend project.

**Do not** set `API_BACKEND_URL` to the same host as the static site (e.g. `seminar.vaidyagogate.org`) — that causes broken routing. Use the **API subdomain** or a separate `*.vercel.app` backend URL.

---

## Project B — API backend (`server.js`)

| Setting | Value |
|---------|--------|
| **Environment variable** | `VERCEL_DEPLOYMENT_TYPE` = `api` |
| **Build Command** | `npm run vercel-build` (same script; router picks API config) |

### Steps

1. Create a **second Vercel project** linked to this repo.
2. Add environment variable: **`VERCEL_DEPLOYMENT_TYPE`** = `api`
3. Copy all backend secrets: `DATABASE_URL`, `PUBLIC_BASE_URL`, payment keys, SMTP, etc. (see `.env.example`)
4. Set custom domain: `api.vaidyagogate.org` (recommended)
5. Deploy

Build copies `deploy/vercel-backend.json` → `vercel.json` with:

```json
"functions": {
  "server.js": {
    "maxDuration": 60,
    "memory": 1024
  }
}
```

This is the **maximum execution window** on Hobby for serverless functions (60s). Heavy OTP/payment/DB work must finish within that limit or Vercel returns **504 Gateway Timeout**.

**Crons** (notifications) run on this project only:

- `GET /api/cron/process-notifications` — daily 09:00 UTC
- `GET /api/cron/pending-registration-reminders` — daily 10:00 UTC

---

## DNS summary

| Host | Vercel project |
|------|----------------|
| `seminar.vaidyagogate.org` | Static (A) |
| `admin.vaidyagogate.org` | Static (A) |
| `judge.vaidyagogate.org` | Static (A) |
| `api.vaidyagogate.org` | API (B) |

---

## Traffic surge (20k+ users)

| Layer | CPU on page load |
|-------|------------------|
| Static HTML/CSS/JS | **None** (CDN only) |
| `/api/*` on frontend project | **Edge rewrite** (minimal) |
| `server.js` on API project | Serverless CPU per API request |

Tips:

- Ensure **Neon connection pooling** (`-pooler` in `DATABASE_URL`)
- Keep `API_BACKEND_URL` pointing at the **API project**, not the static project
- After env changes: **Redeploy both projects** with **Clear Build Cache**

---

## Local dev

```bash
# Terminal 1 — API
npm start

# Terminal 2 — static preview
API_BACKEND_URL=http://localhost:3000 node scripts/prepare-static-deploy.js
npx serve public
```

---

## Reference

- [Vercel serverless function duration limits](https://vercel.com/docs/functions/runtimes#max-duration)

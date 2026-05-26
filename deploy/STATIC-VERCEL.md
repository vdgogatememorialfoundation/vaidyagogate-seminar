# Vercel-only deployment (static frontend + API backend)

Two **Vercel projects** from this **same GitHub repo**. Page loads use **zero Node CPU**; API runs only on the backend project.

## Project A — Static frontend (seminar / admin / judge domains)

| Setting | Value |
|---------|--------|
| **Build Command** | `npm run vercel-build` (default) |
| **Environment variable** | `VERCEL_DEPLOYMENT_TYPE` = `static` (optional; default) |
| **`API_BACKEND_URL`** | `https://api.vaidyagogate.org` — **not** `api.seminar.vaidyagogate.org` unless you deliberately created that DNS name |
| **`PUBLIC_BASE_URL`** | `https://seminar.vaidyagogate.org` |
| **`SEMINAR_HOST`** | `seminar.vaidyagogate.org` |

### Steps

1. Vercel → **Settings → Environment Variables** → add:
   - `API_BACKEND_URL` = `https://api.vaidyagogate.org`  
     (or your backend `*.vercel.app` URL until DNS is ready)
2. **Redeploy** → enable **Clear Build Cache**.
3. Build runs `prepare-static-deploy.js`, which:
   - Sets `outputDirectory: public` (static only)
   - Adds edge **rewrites**: `/api/*` and `/uploads/*` → `API_BACKEND_URL`
   - Path shortcuts: `/admin` → `admin.html`, `/judge` → `judge.html` (on any host)
   - Optional legacy host redirects: `admin.vaidyagogate.org` → `admin.html` (only if that DNS exists)

### Which API URL?

| URL | Use? |
|-----|------|
| **`https://api.vaidyagogate.org`** | **Yes** — this is what the repo expects for `API_BACKEND_URL` and Vercel rewrites. |
| **`https://api.seminar.vaidyagogate.org`** | Only if **you** added that DNS CNAME to the **API** Vercel project. It is **not** the default in this repo. |
| **`https://seminar.vaidyagogate.org`** | **No** for `API_BACKEND_URL` — that is the **website** (HTML). API calls go to `/api/...` on seminar, which Vercel **proxies** to `api.vaidyagogate.org`. |

**Admin / doctor / judge** are **paths** on the seminar site, e.g. `https://seminar.vaidyagogate.org/admin` (or `/admin.html`). You do **not** need `admin.vaidyagogate.org`.

Browsers keep `fetch('/api/...')` on `seminar.vaidyagogate.org`; Vercel edge proxies to the backend **without** running `server.js` on the frontend project.

**Do not** set `API_BACKEND_URL` to `seminar.vaidyagogate.org` — that causes broken routing. Use the **API host** (`api.vaidyagogate.org`) or your backend `*.vercel.app` URL.

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

| Host | Vercel project | Notes |
|------|----------------|--------|
| `seminar.vaidyagogate.org` | Static (A) | Public site + `/admin`, `/doctor`, `/judge`, `/scanner` |
| `api.vaidyagogate.org` | API (B) | Node/`server.js` only — doctors/admins never open this in the browser |
| `admin.vaidyagogate.org` | Static (A) | **Optional** legacy DNS; not required if you use `/admin` on seminar |
| `judge.vaidyagogate.org` | Static (A) | **Optional** legacy DNS |

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

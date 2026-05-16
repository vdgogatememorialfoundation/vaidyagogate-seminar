# Deploy on Vercel + Neon PostgreSQL + Wix DNS

**Not Railway / Supabase** — use **Vercel** (app) + **Neon** (Postgres) + **Wix** (main site + DNS).

| Service | Role |
|---------|------|
| **Wix** | `www.vaidyagogate.org` marketing site |
| **Vercel** | Node app (seminar, admin, judge subdomains) |
| **Neon** | PostgreSQL (`DATABASE_URL`) |
| **Zoho** | Email (admin settings or env) |
| **Meta** | WhatsApp |
| **Razorpay** | Payments |

---

## Step 1 — GitHub

```bash
git init
git add .
git commit -m "Prepare for Vercel and Neon"
git remote add origin https://github.com/YOUR_ORG/vaidyagogate-seminar.git
git push -u origin main
```

Do **not** commit `.env` or real `DATABASE_URL` passwords.

---

## Step 2 — Neon database

1. [https://neon.tech](https://neon.tech) → create project.
2. Copy connection string (pooler URL recommended):

```text
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

3. Optional: run `lib/schema-postgres.sql` once in Neon SQL editor. On deploy, `vercel-build` regenerates this file and the app applies it on first connection.

---

## Step 3 — Vercel project

1. [https://vercel.com](https://vercel.com) → **Add New Project** → import GitHub repo.
2. Framework: **Other** (root `server.js`).
3. **Environment variables** (Production):

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | Neon connection string |
| `PUBLIC_BASE_URL` | `https://seminar.vaidyagogate.org` |
| `SEMINAR_HOST` | `seminar.vaidyagogate.org` |
| `ADMIN_HOST` | `admin.vaidyagogate.org` |
| `JUDGE_HOST` | `judge.vaidyagogate.org` |
| `WIX_SITE_URL` | `https://www.vaidyagogate.org` |
| `ZOHO_HOST` | `smtp.zoho.in` |
| `ZOHO_PORT` | `465` |
| `ZOHO_USER` | your mailbox |
| `ZOHO_PASS` | app password |
| `ZOHO_FROM` | `info@vaidyagogate.org` |
| `WHATSAPP_TOKEN` | Meta token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone id |
| `WHATSAPP_VERIFY_TOKEN` | webhook verify string |
| `RAZORPAY_KEY_ID` | live/test key (also save in admin payment UI) |
| `RAZORPAY_KEY_SECRET` | secret |
| `JWT_SECRET` | long random string |

`VERCEL` is set automatically on Vercel; do not add it manually.

If the site shows `Database initializing, retry shortly.`, check **Production** logs: missing/wrong `DATABASE_URL`, Neon project paused, or bootstrap timeout. Redeploy after fixing env vars.

Or configure Zoho/WhatsApp in **Admin → Global Settings** after deploy (stored in DB).

4. Deploy. Note your Vercel URL: `https://your-project.vercel.app`

---

## Step 4 — Wix DNS (subdomains → Vercel)

Wix → **Domains** → **vaidyagogate.org** → **Manage DNS**

Add **CNAME** records (Vercel docs: [custom domains](https://vercel.com/docs/projects/domains)):

| Host | Type | Value |
|------|------|--------|
| `seminar` | CNAME | `cname.vercel-dns.com` (or value Vercel shows) |
| `admin` | CNAME | same |
| `judge` | CNAME | same |

Then in **Vercel** → Project → **Settings** → **Domains** → add:

- `seminar.vaidyagogate.org`
- `admin.vaidyagogate.org`
- `judge.vaidyagogate.org`

Wait for SSL (automatic on Vercel).

---

## Step 5 — Wix buttons (link out)

On Wix pages:

- **National Seminar / Register** → `https://seminar.vaidyagogate.org`
- **Doctor login** → `https://seminar.vaidyagogate.org/doctor.html`
- Staff link → `https://admin.vaidyagogate.org`
- Judges → `https://judge.vaidyagogate.org`

---

## Step 6 — After deploy (admin checklist)

1. Open `https://admin.vaidyagogate.org`
2. **Global Settings** → seminar URL, Zoho, WhatsApp → Save → Test
3. **Website & doctor updates** → venue, contact → Save CMS
4. **Payment gateways** → Razorpay live keys
5. **Notifications** → Seed defaults

WhatsApp webhook: `https://seminar.vaidyagogate.org/api/webhooks/whatsapp`

---

## Local development

Without `DATABASE_URL` → uses **SQLite** (`database.sqlite`) as before:

```bash
npm install
npm start
```

With Neon locally:

```bash
set DATABASE_URL=postgresql://...
npm start
```

---

## Vercel limitations

| Feature | Note |
|---------|------|
| **Cron reminders** | `node-cron` disabled on Vercel; use [Vercel Cron](https://vercel.com/docs/cron-jobs) hitting `/api/cron/reminders` (add route if needed) |
| **File uploads** | `/public/uploads` is ephemeral; use **Cloudinary** for production uploads (next phase) |
| **Scanner APK** | Point to `https://seminar.vaidyagogate.org/scanner` |

---

## Security

- Rotate any database password that was shared in chat.
- Never commit `DATABASE_URL` to GitHub.
- Use Vercel **encrypted** environment variables only.

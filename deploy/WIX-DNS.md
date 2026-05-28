# Wix DNS → Render (seminar portals)

Main marketing site stays on **Wix** (`www.vaidyagogate.org`). Seminar, admin, and judge portals run on **Render** (one Web Service; the app routes by hostname).

| Host | Purpose |
|------|---------|
| `seminar.vaidyagogate.org` | Public site + doctor portal |
| `admin.vaidyagogate.org` | Admin (or `/admin.html` on seminar host) |
| `judge.vaidyagogate.org` | Judge portal |

## 1. Render — custom domains

1. Render → your **Web Service** → **Settings** → **Custom Domains**
2. Add `seminar.vaidyagogate.org`, `admin.vaidyagogate.org`, `judge.vaidyagogate.org` (as needed)
3. Render shows the DNS records to add in Wix

## 2. Wix — DNS records

In Wix → Domains → DNS, add the records Render provides (typically **CNAME** to your `*.onrender.com` hostname).

Example pattern (use values from Render UI):

| Host | Type | Value |
|------|------|--------|
| `seminar` | CNAME | `your-service.onrender.com` |
| `admin` | CNAME | `your-service.onrender.com` |
| `judge` | CNAME | `your-service.onrender.com` |

SSL is issued by Render after DNS propagates.

## 3. Environment on Render

Set at minimum: `DATABASE_URL`, `PUBLIC_BASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, host vars — see **[DEPLOY-RENDER.md](DEPLOY-RENDER.md)**.

## 4. VPS alternative

If you host on your own server instead of Render, use **A** records to your VPS IP. See `deploy/nginx-vaidyagogate.conf` and **[DEPLOY.md](../DEPLOY.md)**.

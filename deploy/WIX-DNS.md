# Wix DNS → Vercel (seminar portals)

Main marketing site stays on **Wix**. Seminar, admin, and judge portals run on **one Vercel project** (same deployment; the app routes by hostname).

| URL | Portal |
|-----|--------|
| `https://www.vaidyagogate.org` | Wix (marketing) |
| `https://seminar.vaidyagogate.org` | Public site + doctor login + **scanner** (`/scanner`) |
| `https://admin.vaidyagogate.org` | Admin panel |
| `https://judge.vaidyagogate.org` | Judge portal |
| `https://vaidyagogate-seminar.vercel.app` | Vercel default URL (same app, before custom domains) |

---

## 1. Vercel — add domains

Project → **Settings** → **Domains** → add:

- `seminar.vaidyagogate.org`
- `admin.vaidyagogate.org`
- `judge.vaidyagogate.org`

Vercel shows the exact DNS rows to use (host + value). Use those if they differ from the table below.

---

## 2. Wix — DNS records

Wix → **Domains** → **vaidyagogate.org** → **Manage DNS**

Do **not** change `www` / apex records that point at Wix.

Add three **CNAME** records (recommended for Vercel subdomains):

| Host / name | Type | Value (points to) | TTL |
|-------------|------|-------------------|-----|
| `seminar` | **CNAME** | `cname.vercel-dns.com` | 1 hour (or default) |
| `admin` | **CNAME** | `cname.vercel-dns.com` | 1 hour |
| `judge` | **CNAME** | `cname.vercel-dns.com` | 1 hour |

If Wix shows “conflict” or only allows **A** for subdomains, use the IPv4 Vercel lists in the domain setup UI (often `76.76.21.21`) for each host instead of CNAME.

Propagation: often 15–60 minutes; up to 48 hours.

Verify:

```powershell
nslookup seminar.vaidyagogate.org
nslookup admin.vaidyagogate.org
nslookup judge.vaidyagogate.org
```

---

## 3. How hostnames map to the app

All three subdomains hit the **same** Vercel deployment. `lib/subdomain-portal.js` serves:

| Request host | `/` serves |
|--------------|------------|
| `seminar.vaidyagogate.org` | `index.html` (public homepage) |
| `admin.vaidyagogate.org` | `admin.html` |
| `judge.vaidyagogate.org` | `judge.html` |

Scanner (seminar host only): `https://seminar.vaidyagogate.org/scanner` → `scanner.html`

API routes (`/api/...`) work on any of the three hosts.

---

## 4. Wix buttons (link out — do not iframe)

| Button | URL |
|--------|-----|
| National seminar / register | `https://seminar.vaidyagogate.org` |
| Doctor login | `https://seminar.vaidyagogate.org/doctor.html` |
| Staff admin | `https://admin.vaidyagogate.org` |
| Judges | `https://judge.vaidyagogate.org` |
| QR scanner | `https://seminar.vaidyagogate.org/scanner` |

---

## 5. Webhooks (seminar host)

- WhatsApp: `https://seminar.vaidyagogate.org/api/webhooks/whatsapp`
- Payment return (example): `https://seminar.vaidyagogate.org/doctor.html`

---

## 6. Optional: VPS instead of Vercel

If you host on your own server, use **A** records to your VPS IP instead of CNAME to Vercel. See `deploy/nginx-vaidyagogate.conf` and set `PUBLIC_BASE_URL` / host env vars accordingly.

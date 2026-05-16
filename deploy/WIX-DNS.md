# Wix domain + seminar subdomains (vaidyagogate.org)

Your setup:

| URL | Purpose | Hosted on |
|-----|---------|-----------|
| `https://www.vaidyagogate.org` (or root) | Main marketing site | **Wix** |
| `https://seminar.vaidyagogate.org` | Public seminar site + doctor signup/login | **Your VPS** (Node app) |
| `https://admin.vaidyagogate.org` | Admin panel | **Your VPS** |
| `https://judge.vaidyagogate.org` | Judge portal | **Your VPS** |
| `https://seminar.vaidyagogate.org/scanner.html` | QR scanner (or APK) | **Your VPS** |

The Node app is **one server**; Nginx routes by subdomain name.

---

## Step 1 — Get your VPS IP

Example: `203.0.113.50` (replace with your real server IP from Hostinger, AWS, DigitalOcean, etc.)

---

## Step 2 — DNS in Wix

1. Log in to **Wix** → **Domains** → select **vaidyagogate.org** → **Manage DNS** (or “DNS records”).
2. **Do not** move the root/`www` records if the main site should stay on Wix.
3. Add **subdomain** records pointing to your VPS:

| Type | Host / Name | Points to | TTL |
|------|-------------|-----------|-----|
| **A** | `seminar` | `203.0.113.50` | 1 hour |
| **A** | `admin` | `203.0.113.50` | 1 hour |
| **A** | `judge` | `203.0.113.50` | 1 hour |

If Wix only allows **CNAME** for subdomains, use a DNS provider (Cloudflare) for those three names, or Wix “subdomain” → external IP if supported.

DNS can take **15 minutes to 48 hours** to propagate.

Check:

```bash
nslookup seminar.vaidyagogate.org
nslookup admin.vaidyagogate.org
```

---

## Step 3 — Link from Wix to the seminar portal

On your Wix pages, add buttons:

- **Register for seminar** → `https://seminar.vaidyagogate.org`  
- **Doctor login** → `https://seminar.vaidyagogate.org/doctor.html`  
- **Staff admin** (hidden or footer) → `https://admin.vaidyagogate.org`  
- **Judges** → `https://judge.vaidyagogate.org`

Do **not** embed the Node app in a Wix iframe for login/payments (cookies and Razorpay often break). Always open the subdomain in the same tab.

---

## Step 4 — Point DNS to Vercel (recommended)

Use **CNAME** to Vercel (see **`deploy/DEPLOY-VERCEL.md`**) instead of a VPS.

In Vercel → Project → **Domains**, add all three subdomains after DNS is set.

*(Optional VPS + Nginx: use `deploy/nginx-vaidyagogate.conf` and certbot if you host on your own server instead of Vercel.)*

---

## Step 5 — App configuration

On the server `.env`:

```env
PUBLIC_BASE_URL=https://seminar.vaidyagogate.org
SEMINAR_HOST=seminar.vaidyagogate.org
ADMIN_HOST=admin.vaidyagogate.org
JUDGE_HOST=judge.vaidyagogate.org
WIX_SITE_URL=https://www.vaidyagogate.org
```

Or set the same in **Admin → Global Settings → Email, WhatsApp & live site URL** after first login.

---

## Step 6 — Razorpay / WhatsApp webhooks

Use **seminar** subdomain URLs:

- Payment return: `https://seminar.vaidyagogate.org/doctor.html`
- WhatsApp webhook: `https://seminar.vaidyagogate.org/api/webhooks/whatsapp`

---

## How subdomains work in the app

When a user opens:

- `admin.vaidyagogate.org/` → serves **admin** login  
- `seminar.vaidyagogate.org/` → serves **public homepage**  
- `judge.vaidyagogate.org/` → serves **judge** portal  

API calls (`/api/...`) work on **any** of the three hosts.

Emails use `https://seminar.vaidyagogate.org/doctor.html` as the doctor login link.

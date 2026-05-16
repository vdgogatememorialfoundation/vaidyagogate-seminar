# Deploy VGMF Seminar System (live server)

**Wix + subdomains:** Main site stays on Wix (`www.vaidyagogate.org`). Seminar app uses `seminar`, `admin`, and `judge` subdomains on a VPS. Full DNS steps: **[deploy/WIX-DNS.md](deploy/WIX-DNS.md)**. Nginx sample: **[deploy/nginx-vaidyagogate.conf](deploy/nginx-vaidyagogate.conf)**.

| Subdomain | Role |
|-----------|------|
| `seminar.vaidyagogate.org` | Public site + doctor portal |
| `admin.vaidyagogate.org` | Admin panel |
| `judge.vaidyagogate.org` | Judge portal |

## Requirements

- Ubuntu 22.04+ or similar Linux VPS
- Node.js 20 LTS
- Nginx (reverse proxy + SSL)
- Domain pointed to server IP (e.g. `seminar.yourdomain.com`)

## 1. Upload project

```bash
cd /var/www
git clone <your-repo-url> seminarsystem
cd seminarsystem
npm install --production
```

Copy `.env.example` to `.env` and set secrets (or use **Admin → Global Settings → Email, WhatsApp & live site URL** after first boot).

## 2. Environment

```bash
cp .env.example .env
nano .env
```

Minimum for production:

```
PORT=3000
NODE_ENV=production
PUBLIC_BASE_URL=https://seminar.yourdomain.com
```

Email/WhatsApp can be set in `.env` **or** in the admin panel (DB overrides env when filled).

## 3. Run with PM2

```bash
npm install -g pm2
pm2 start server.js --name vgmf-seminar
pm2 save
pm2 startup
```

## 4. Nginx

`/etc/nginx/sites-available/seminar`:

```nginx
server {
    listen 80;
    server_name seminar.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name seminar.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/seminar.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seminar.yourdomain.com/privkey.pem;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/seminar /etc/nginx/sites-enabled/
sudo certbot --nginx -d seminar.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

## 5. After go-live (admin checklist)

1. **Global Settings** → Public site URL = `https://seminar.yourdomain.com`
2. **Global Settings** → Zoho SMTP + WhatsApp keys → Save → Test email / Test WhatsApp
3. **Website & doctor updates** → edit **Venue line** and **Contact address** (replaces “Convention Centre, Pune” on homepage)
4. **Payment gateways** → Razorpay/Cashfree live keys, enable one gateway
5. **Notifications** → Seed defaults, review templates
6. Meta WhatsApp webhook: `https://seminar.yourdomain.com/api/webhooks/whatsapp`

## 6. Scanner APK

See `scanner-mobile/README.md`. Point the app at `https://seminar.yourdomain.com/scanner.html`.

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 8. Backups

Back up `seminar.db` (or your SQLite path) and `public/uploads/` daily.

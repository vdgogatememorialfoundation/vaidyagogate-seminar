# Wix — seminar announcements feed

Use this on your Wix homepage to show the same ticker / notices as the seminar portal (managed in **Admin → Website & doctor updates**).

## Public API

```
GET https://seminar.vaidyagogate.org/api/public/announcements
```

Response (JSON):

- `scrollingAnnouncements` — cards for ticker / repeater
- `publicNotices` — static notice blocks
- `portalUrls.seminar` — link “Register” buttons here
- `portalUrls.wix` — your main site
- `updatedAt` — cache busting

CORS is enabled (`Access-Control-Allow-Origin: *` via `cors` middleware).

## Wix Velo example

```javascript
import { fetch } from 'wix-fetch';

$w.onReady(async function () {
  const base = 'https://seminar.vaidyagogate.org';
  const res = await fetch(`${base}/api/public/announcements`, { method: 'get' });
  const data = await res.json();
  const items = data.scrollingAnnouncements || [];
  $w('#announceRepeater').data = items.map((a, i) => ({
    _id: String(i),
    title: a.title || a.headline || '',
    text: a.text || a.body || '',
    link: a.linkUrl || a.href || data.portalUrls?.seminar || base
  }));
});
```

## Full CMS (optional)

For hero, FAQ, speakers, etc. use:

```
GET https://seminar.vaidyagogate.org/api/public/site-cms
```

## Confirmed participant list (homepage verify)

Enable **Publish public participant list** on the seminar in Admin → Seminar Management.

The homepage **Verify registration** section lists only **confirmed** delegates: document-approved (when required) + successful payment.

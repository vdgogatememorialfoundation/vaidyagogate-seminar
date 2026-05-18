# WhatsApp Cloud API — templates, OTP, and notifications

Meta **does not** allow creating approved message templates purely from this app: each template is created in **Meta Business Suite** (or WhatsApp Manager) and goes through **category + review** (utility / authentication / marketing). This document describes how to align our portal with Meta so **email + WhatsApp** work for OTP, account creation, and step notifications.

## Security

- **Never** paste an **App Secret** as the WhatsApp “Access token”. Use a **System User** permanent token only.
- If a token was ever pasted in chat, email, or a ticket, **rotate it** in Meta (generate a new token and revoke the old one).

## Environment variables (Vercel / `.env`)

| Variable | Purpose |
|----------|---------|
| `WHATSAPP_TOKEN` | System User access token (or store in Admin → Global Settings) |
| `WHATSAPP_PHONE_NUMBER_ID` | From Meta → WhatsApp → API Setup |
| `WHATSAPP_VERIFY_TOKEN` | Your chosen string; same in Meta webhook config |
| `WHATSAPP_VERIFY_TOKEN_ALT` | Optional comma-separated extra verify strings (e.g. while changing Meta token) |
| `WHATSAPP_OTP_TEMPLATE_NAME` | **Optional.** Approved **authentication** template name used for OTP (see below). If unset, OTP WhatsApp falls back to **plain text** (only works inside the **24-hour customer service window**). |

## Webhook

- **Callback URL:** `https://<your-seminar-host>/api/webhooks/whatsapp`
- **Verify token:** must match `WHATSAPP_VERIFY_TOKEN` (or value saved in admin integrations).
- Subscribe to **`messages`** (and status fields you need) in the Meta app dashboard.

## Recommended Meta templates (create manually)

Our server sends **template** messages with **one body variable** `{{1}}` when you set **Meta template name** on a notification row (Admin → Notifications). The rendered WhatsApp body text is passed as that single variable. Create templates in Meta with **exactly one** body variable named as Meta shows (often `{{1}}`).

### 1) OTP / authentication (for login & signup OTP)

1. WhatsApp Manager → **Message templates** → **Create template**.
2. Category: **Authentication** (or **Utility** if auth is not available).
3. Body example: `{{1}}` only, or `Your VGMF code is {{1}}. Valid 10 minutes.`
4. After approval, set **`WHATSAPP_OTP_TEMPLATE_NAME`** to that template name (e.g. `vgmf_otp_en`) **or** set the same name in the **OTP_VERIFICATION** row → **Meta template name** in Admin → Notifications.

### 2) Generic “alert” (optional, one template for many events)

Create one **Utility** template, body: `{{1}}`. For each notification template in admin, set **Meta template name** to this template name. The app fills `{{1}}` with the full rendered message for that event (login details, payment, ticket, etc.).

### 3) Account / registration (optional dedicated templates)

If you prefer separate templates per event, each must match how many variables Meta expects. The app’s default integration assumes **one variable**; for multi-variable templates, adjust copy in Meta and optionally extend `notification-engine.js` later.

## 24-hour window vs templates

- **Plain text** WhatsApp only works if the user messaged your business number recently (**24-hour window**).
- **OTP to new users** almost always needs an **approved template** (set `WHATSAPP_OTP_TEMPLATE_NAME` or template on `OTP_VERIFICATION`).

## What the app sends today

| Trigger | Email | WhatsApp |
|---------|-------|----------|
| Self signup | `ACCOUNT_CREATED` | Same (if phone + configured) |
| Admin → Create user | `ACCOUNT_CREATED` with password | Same |
| Admin → New registration for doctor | `SEMINAR_REGISTRATION_SUCCESS` | Same |
| OTP (login/signup) | `OTP_VERIFICATION` | Template if configured, else text |
| Other events | Per template in Admin → Notifications | Same row (channel both / WA only) |

After changing defaults in code, run **Seed missing defaults** or edit templates in admin; production DB keeps existing rows until you update them.

## Further reading

- [WhatsApp Cloud API — Get started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
- [Message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates)

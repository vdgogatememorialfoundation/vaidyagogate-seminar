/**
 * Lock email to ZeptoMail HTTPS only (no Sender fallback, no Zoho SMTP relay).
 * Usage:
 *   ZEPTOMAIL_TOKEN=... node scripts/apply-zeptomail-only.js [baseUrl]
 */
const base = (process.argv[2] || process.env.PUBLIC_BASE_URL || 'https://seminar.vaidyagogate.org').replace(
    /\/$/,
    ''
);
const zepto = String(process.env.ZEPTOMAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || '').trim();
const from = String(process.env.ZEPTOMAIL_FROM || process.env.ZOHO_FROM || 'noreply@seminar.vaidyagogate.org').trim();

const body = {
    email_api_provider: 'zeptomail',
    email_api_fallback_provider: '',
    email_primary_enabled: true,
    email_fallback_enabled: false,
    email_smtp_standby_enabled: false,
    zoho_from: from
};
if (zepto) {
    body.email_api_key = zepto;
    body.email_provider_keys = { zeptomail: zepto };
}

async function main() {
    const res = await fetch(base + '/api/admin/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        console.error('Save failed:', res.status, data.error || data);
        process.exit(1);
    }
    console.log('ZeptoMail-only mode saved.');
    console.log('Email configured:', data.email_configured);
    console.log('Email status:', JSON.stringify(data.email_status || {}, null, 2));
    if (!zepto) {
        console.warn('Note: ZEPTOMAIL_TOKEN not set — paste Zepto Send Mail token in Admin → Integrations.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

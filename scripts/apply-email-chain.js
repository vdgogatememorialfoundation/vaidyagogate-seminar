/**
 * Configure production email chain: ZeptoMail primary → Sender.net fallback.
 * Usage:
 *   ZEPTOMAIL_TOKEN=... SENDER_NET_API_TOKEN=... node scripts/apply-email-chain.js
 */
const base = (process.argv[2] || process.env.PUBLIC_BASE_URL || 'https://seminar.vaidyagogate.org').replace(
    /\/$/,
    ''
);
const zepto = String(process.env.ZEPTOMAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || '').trim();
const sender = String(process.env.SENDER_NET_API_TOKEN || process.env.SENDER_API_TOKEN || '').trim();
const from = String(process.env.ZEPTOMAIL_FROM || process.env.ZOHO_FROM || 'noreply@seminar.vaidyagogate.org').trim();

const body = {
    email_api_provider: 'zeptomail',
    email_api_fallback_provider: sender ? 'sender' : '',
    zoho_from: from
};
if (zepto) body.email_api_key = zepto;
if (sender) body.email_api_fallback_key = sender;

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
    console.log('Email chain saved:', JSON.stringify(data.email_status || {}, null, 2));
    if (!zepto) {
        console.warn('Note: ZEPTOMAIL_TOKEN not set — paste Zepto Send Mail token in Admin → Integrations.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

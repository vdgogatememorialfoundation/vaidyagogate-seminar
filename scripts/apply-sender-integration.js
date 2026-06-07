/**
 * One-shot: save Sender.net as primary email provider on a running server.
 * Usage: SENDER_NET_API_TOKEN=... node scripts/apply-sender-integration.js [baseUrl]
 */
const base = (process.argv[2] || process.env.PUBLIC_BASE_URL || 'https://seminar.vaidyagogate.org').replace(
    /\/$/,
    ''
);
const token = String(process.env.SENDER_NET_API_TOKEN || process.env.SENDER_API_TOKEN || '').trim();
if (!token) {
    console.error('Set SENDER_NET_API_TOKEN');
    process.exit(1);
}

const body = {
    email_api_provider: 'sender',
    email_api_key: token,
    zoho_from: process.env.ZOHO_FROM || 'care@vaidyagogate.org'
};

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
    console.log('Sender.net integration saved.');
    console.log('Email configured:', data.email_configured);
    console.log('Email status:', JSON.stringify(data.email_status || {}));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

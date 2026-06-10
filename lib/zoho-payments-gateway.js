/**
 * Zoho Payments — hosted payment page (India: payments.zoho.in).
 */
const crypto = require('crypto');
const axios = require('axios');
const shared = require('./payment-checkout-shared');

const API_BASE = {
    test: 'https://payments.zoho.in/api/v1',
    prod: 'https://payments.zoho.in/api/v1'
};

const HOSTED_BASE = {
    test: 'https://payments.zoho.in/hostedpages/',
    prod: 'https://payments.zoho.in/hostedpages/'
};

const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    const live = c.live || c;
    return {
        clientId: String(live.client_id || c.client_id || '').trim(),
        clientSecret: String(live.client_secret || c.client_secret || '').trim(),
        refreshToken: String(live.refresh_token || c.refresh_token || '').trim(),
        organizationId: String(live.organization_id || c.organization_id || '').trim(),
        signingKey: String(live.signing_key || c.signing_key || '').trim(),
        mode
    };
}

function getAccessToken(creds, callback) {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
        return callback(new Error('Zoho Payments OAuth client ID, secret, and refresh token are required.'));
    }
    axios
        .post(
            TOKEN_URL,
            new URLSearchParams({
                refresh_token: creds.refreshToken,
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                grant_type: 'refresh_token'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
        )
        .then((res) => {
            const token = res.data && res.data.access_token;
            if (!token) {
                return callback(new Error((res.data && res.data.error) || 'Zoho OAuth token missing'));
            }
            callback(null, token);
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && (e.response.data.error || e.response.data.message)) ||
                e.message;
            callback(new Error('Zoho OAuth failed: ' + msg));
        });
}

function apiHeaders(token, organizationId) {
    const h = { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' };
    if (organizationId) h['X-com-zoho-payments-organizationid'] = organizationId;
    return h;
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.organizationId) {
        return callback(new Error('Zoho Payments organization ID is required in Admin → Payment Gateways.'));
    }
    const email = String(opts.email || '').trim();
    if (!email) return callback(new Error('Your profile must include email before paying with Zoho Payments.'));

    getAccessToken(creds, (tokErr, token) => {
        if (tokErr) return callback(tokErr);
        const txnid = shared.sanitizeTxnid(opts.txnid, 40);
        const body = {
            amount: shared.formatInrAmount(opts.amount),
            currency: 'INR',
            description: String(opts.productinfo || 'Seminar Registration').slice(0, 500),
            invoice_number: txnid,
            meta_data: [
                { key: 'order_ref', value: txnid.slice(0, 20) },
                { key: 'reg_id', value: String(opts.registrationId || '').slice(0, 20) }
            ],
            configurations: {
                hosted_page_parameters: {
                    name: String(opts.firstname || 'Doctor').slice(0, 100),
                    email,
                    phone: shared.sanitizePhone10(opts.phone),
                    phone_country_code: '+91',
                    description: String(opts.productinfo || 'Seminar Registration').slice(0, 200),
                    success_url: shared.returnPath('zoho', 'success'),
                    failure_url: shared.returnPath('zoho', 'failure'),
                    udf1: String(opts.registrationId || ''),
                    udf2: String(opts.orderDbId || ''),
                    udf3: txnid
                }
            }
        };

        axios
            .post(`${API_BASE[creds.mode]}/payment_sessions`, body, {
                headers: apiHeaders(token, creds.organizationId),
                timeout: 25000
            })
            .then((res) => {
                const data = res.data || {};
                const session = data.payment_session || data;
                const accessKey = session.access_key || data.access_key;
                const sessionId = session.payments_session_id || data.payments_session_id;
                if (!accessKey) {
                    return callback(new Error('Zoho Payments did not return a hosted page access key.'));
                }
                callback(null, {
                    paymentUrl: HOSTED_BASE[creds.mode] + encodeURIComponent(accessKey),
                    providerRef: sessionId || accessKey,
                    accessKey
                });
            })
            .catch((e) => {
                const msg =
                    (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 300)) ||
                    e.message;
                callback(new Error('Zoho Payments session failed: ' + msg));
            });
    });
}

function verifyReturnSignature(data, signingKey) {
    if (!signingKey || !data || !data.signature) return false;
    const parts = [
        data.payments_session_id,
        data.payment_session_status,
        data.payment_id,
        data.payment_status,
        data.amount
    ]
        .filter((x) => x != null && String(x).trim() !== '')
        .map((x) => String(x));
    if (!parts.length) return false;
    const expected = crypto.createHmac('sha256', signingKey).update(parts.join('|')).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(data.signature)));
    } catch (_) {
        return expected === String(data.signature);
    }
}

function fetchSessionStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const sessionId = String(opts.txnid || opts.sessionId || '').trim();
    if (!sessionId) return callback(null, { paid: false, status: 'pending' });

    getAccessToken(creds, (tokErr, token) => {
        if (tokErr) return callback(tokErr);
        axios
            .get(`${API_BASE[creds.mode]}/payment_sessions/${encodeURIComponent(sessionId)}`, {
                headers: apiHeaders(token, creds.organizationId),
                timeout: 20000
            })
            .then((res) => {
                const session = (res.data && res.data.payment_session) || res.data || {};
                const st = String(session.status || session.payment_session_status || '').toLowerCase();
                const paid = st === 'succeeded' || st === 'success' || st === 'paid';
                callback(null, {
                    paid,
                    status: st,
                    providerRef: session.payment_id || session.payments_session_id
                });
            })
            .catch((e) => callback(e));
    });
}

module.exports = {
    extractCredentials,
    initiatePayment,
    verifyReturnSignature,
    fetchSessionStatus
};

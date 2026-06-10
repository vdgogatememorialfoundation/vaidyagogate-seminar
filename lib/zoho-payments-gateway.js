/**
 * Zoho Payments hosted checkout — India (payments.zoho.in).
 * @see https://www.zoho.com/in/payments/developerdocs/web-integration/hosted-payment-page/
 */
const crypto = require('crypto');
const axios = require('axios');
const shared = require('./payment-checkout-shared');

const API_BASE = 'https://payments.zoho.in/api/v1';
const HOSTED_CHECKOUT_BASE = 'https://payments.zoho.in/hostedcheckout/';
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

function parseSessionResponse(data) {
    const root = data || {};
    const session = root.payments_session || root.payment_session || root;
    return {
        accessKey: session.access_key || root.access_key || null,
        sessionId: session.payments_session_id || root.payments_session_id || null,
        status: session.status || session.payment_session_status || null
    };
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
            configurations: {
                hosted_checkout_parameters: {
                    email,
                    phone: shared.sanitizePhone10(opts.phone),
                    description: String(opts.productinfo || 'Seminar Registration').slice(0, 200),
                    success_url: shared.returnPath('zoho', 'success'),
                    failure_url: shared.returnPath('zoho', 'failure'),
                    udf1: String(opts.registrationId || ''),
                    udf2: String(opts.orderDbId || ''),
                    udf3: txnid,
                    udf4: '',
                    udf5: ''
                }
            }
        };

        axios
            .post(`${API_BASE}/payment_sessions`, body, {
                headers: apiHeaders(token, creds.organizationId),
                timeout: 25000
            })
            .then((res) => {
                const data = res.data || {};
                if (data.code != null && Number(data.code) !== 0) {
                    return callback(new Error(data.message || 'Zoho Payments session creation failed'));
                }
                const parsed = parseSessionResponse(data);
                if (!parsed.accessKey) {
                    return callback(new Error('Zoho Payments did not return a hosted checkout access key.'));
                }
                callback(null, {
                    paymentUrl: HOSTED_CHECKOUT_BASE + parsed.accessKey,
                    providerRef: parsed.sessionId || parsed.accessKey,
                    accessKey: parsed.accessKey
                });
            })
            .catch((e) => {
                const msg =
                    (e.response && e.response.data && JSON.stringify(e.response.data).slice(0, 400)) ||
                    e.message;
                callback(new Error('Zoho Payments session failed: ' + msg));
            });
    });
}

/** Official redirect signature: dot-separated fields with empty string for absent values. */
function buildReturnSignatureMessage(data) {
    const d = data || {};
    return [
        d.payments_session_id,
        d.payment_session_status,
        d.payment_id,
        d.payment_status,
        d.amount,
        d.mandate_id,
        d.udf1,
        d.udf2,
        d.udf3,
        d.udf4,
        d.udf5
    ]
        .map((x) => (x == null ? '' : String(x)))
        .join('.');
}

function verifyReturnSignature(data, signingKey) {
    if (!signingKey || !data || !data.signature) return false;
    const message = buildReturnSignatureMessage(data);
    const expected = crypto.createHmac('sha256', signingKey).update(message).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(data.signature)));
    } catch (_) {
        return expected === String(data.signature);
    }
}

function isSessionPaid(data) {
    const st = String((data && data.payment_session_status) || (data && data.status) || '').toLowerCase();
    const paySt = String((data && data.payment_status) || '').toLowerCase();
    return st === 'succeeded' || paySt === 'succeeded' || st === 'success';
}

function fetchSessionStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const sessionId = String(opts.sessionId || opts.txnid || '').trim();
    if (!sessionId) return callback(null, { paid: false, status: 'pending' });

    getAccessToken(creds, (tokErr, token) => {
        if (tokErr) return callback(tokErr);
        axios
            .get(`${API_BASE}/payment_sessions/${encodeURIComponent(sessionId)}`, {
                headers: apiHeaders(token, creds.organizationId),
                timeout: 20000
            })
            .then((res) => {
                const data = res.data || {};
                const session = data.payments_session || data.payment_session || data;
                const st = String(session.status || session.payment_session_status || '').toLowerCase();
                const paid = st === 'succeeded' || st === 'success' || st === 'paid';
                callback(null, {
                    paid,
                    status: st,
                    providerRef: session.payment_id || session.payments_session_id || sessionId
                });
            })
            .catch((e) => callback(e));
    });
}

module.exports = {
    extractCredentials,
    initiatePayment,
    verifyReturnSignature,
    isSessionPaid,
    fetchSessionStatus,
    buildReturnSignatureMessage
};

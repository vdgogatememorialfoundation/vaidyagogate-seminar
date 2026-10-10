/**
 * Slice UPI (developer.slicebank.com) — merchant order API.
 *
 * Auth headers on every request:
 *   client-id, tts (epoch ms), request-id (uuid), x-encryption-key-version,
 *   s-access-token = base64(HMAC-SHA256(`${client-id}|${tts}`, secret))
 *
 * Endpoints (relative to base):
 *   POST /v1/order                       create UPI order (QR / INTENT_URL / COLLECT)
 *   GET  /v1/order/{clientReferenceId}   fetch order status
 */
const crypto = require('crypto');
const axios = require('axios');
const integrationSettings = require('./integration-settings');

const BASE_URLS = {
    prod: 'https://api.slice.bank.in/banking/merchant',
    uat: 'https://api.uat-slice.bank.in/banking/merchant'
};

const GATEWAY_TAG = 'upi_slice';
const SUCCESS_STATES = new Set(['SUCCESS', 'ORDER_SUCCESS', 'COMPLETED', 'PAID']);
const FAILED_STATES = new Set(['FAILED', 'ORDER_FAILED', 'EXPIRED', 'CANCELLED', 'DECLINED']);

function flag(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    return !(v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false');
}

function getConfig() {
    const r = integrationSettings.getRuntimeIntegrations() || {};
    const env = String(r.slice_env || process.env.SLICE_ENV || 'prod').toLowerCase() === 'uat' ? 'uat' : 'prod';
    const baseOverride = String(r.slice_base_url || process.env.SLICE_BASE_URL || '').trim().replace(/\/$/, '');
    return {
        enabled: flag(r.slice_enabled, false),
        env,
        baseUrl: baseOverride || BASE_URLS[env],
        clientId: String(r.slice_client_id || process.env.SLICE_CLIENT_ID || '').trim(),
        secretKey: String(r.slice_secret_key || process.env.SLICE_SECRET_KEY || '').trim(),
        partnerId: String(r.slice_partner_id || process.env.SLICE_PARTNER_ID || '').trim(),
        encryptionKeyVersion: String(r.slice_encryption_key_version || process.env.SLICE_ENCRYPTION_KEY_VERSION || '1').trim() || '1',
        expirySeconds: Math.max(120, parseInt(r.slice_order_expiry_seconds, 10) || 900)
    };
}

function getStatus() {
    const c = getConfig();
    const missing = [];
    if (!c.clientId) missing.push('Client ID');
    if (!c.secretKey) missing.push('Secret key');
    if (!c.partnerId) missing.push('Partner ID');
    return {
        enabled: c.enabled,
        configured: missing.length === 0,
        active: c.enabled && missing.length === 0,
        env: c.env,
        baseUrl: c.baseUrl,
        missing
    };
}

function isActive() {
    return getStatus().active;
}

function authHeaders(c) {
    const tts = String(Date.now());
    const sig = crypto.createHmac('sha256', c.secretKey).update(`${c.clientId}|${tts}`).digest('base64');
    return {
        'client-id': c.clientId,
        tts,
        'request-id': crypto.randomUUID(),
        's-access-token': sig,
        'x-encryption-key-version': c.encryptionKeyVersion,
        'Content-Type': 'application/json',
        Accept: 'application/json'
    };
}

function apiError(err, fallback) {
    const d = err && err.response && err.response.data;
    const msg =
        (d && (d.message || d.error || (d.errors && d.errors[0] && d.errors[0].message))) ||
        (err && err.message) ||
        fallback;
    const e = new Error(`Slice: ${msg}`);
    e.status = err && err.response && err.response.status;
    e.data = d;
    return e;
}

function pick(obj, keys) {
    if (!obj) return undefined;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
}

function unwrap(data) {
    if (!data) return {};
    return data.data && typeof data.data === 'object' ? data.data : data;
}

/**
 * Create a UPI order. Returns { clientReferenceId, orderId, intentUrl, qrString, qrImage, status, expiresAt, raw }.
 */
function createOrder({ amountRupee, clientReferenceId, note, orderType, payerVpa, expirySeconds }, cb) {
    const c = getConfig();
    const st = getStatus();
    if (!st.active) {
        return cb(new Error('Slice UPI is not configured: ' + (st.missing.join(', ') || 'disabled')));
    }
    const amount = Number(amountRupee);
    if (!(amount > 0)) return cb(new Error('Slice: amount must be greater than zero'));
    const type = String(orderType || 'QR').toUpperCase();
    const body = {
        clientReferenceId: String(clientReferenceId),
        partnerId: c.partnerId,
        amount: Number(amount.toFixed(2)),
        orderType: type,
        currency: 'INR',
        expiryInSeconds: expirySeconds || c.expirySeconds
    };
    if (note) body.remarks = String(note).slice(0, 50);
    if (type === 'COLLECT' && payerVpa) body.payerVpa = String(payerVpa).trim();

    axios
        .post(`${c.baseUrl}/v1/order`, body, { headers: authHeaders(c), timeout: 15000 })
        .then((resp) => {
            const d = unwrap(resp.data);
            const intentUrl = pick(d, ['intentUrl', 'universalIntentUrl', 'upiIntentUrl', 'intent_url', 'upiUrl']);
            const qrString = pick(d, ['qrString', 'qrData', 'qr_string', 'qrCode', 'upiString']) || intentUrl;
            cb(null, {
                clientReferenceId: String(pick(d, ['clientReferenceId']) || clientReferenceId),
                orderId: pick(d, ['orderId', 'id', 'sliceOrderId']) || null,
                intentUrl: intentUrl || null,
                qrString: qrString || null,
                qrImage: pick(d, ['qrImage', 'qrImageBase64', 'qrImageUrl']) || null,
                status: String(pick(d, ['status', 'orderStatus']) || 'PENDING').toUpperCase(),
                expiresAt: pick(d, ['expiryAt', 'expiresAt', 'expiry']) || null,
                raw: d
            });
        })
        .catch((err) => cb(apiError(err, 'order creation failed')));
}

/**
 * Fetch order status. Returns { status, paid, failed, utr, payerVpa, amount, raw }.
 */
function getOrderStatus(clientReferenceId, cb) {
    const c = getConfig();
    const st = getStatus();
    if (!st.configured) return cb(new Error('Slice UPI is not configured: ' + st.missing.join(', ')));
    axios
        .get(`${c.baseUrl}/v1/order/${encodeURIComponent(String(clientReferenceId))}`, {
            headers: authHeaders(c),
            timeout: 15000
        })
        .then((resp) => cb(null, normalizeStatus(unwrap(resp.data))))
        .catch((err) => cb(apiError(err, 'status fetch failed')));
}

function normalizeStatus(d) {
    const status = String(pick(d, ['status', 'orderStatus', 'txnStatus', 'event']) || 'PENDING').toUpperCase();
    const amt = pick(d, ['amount', 'txnAmount', 'orderAmount']);
    return {
        status,
        paid: SUCCESS_STATES.has(status),
        failed: FAILED_STATES.has(status),
        utr: pick(d, ['utr', 'rrn', 'bankRrn', 'npciTxnId', 'transactionId', 'txnId']) || null,
        payerVpa: pick(d, ['payerVpa', 'payerVPA', 'vpa']) || null,
        amount: amt != null ? Number(amt) : null,
        clientReferenceId: pick(d, ['clientReferenceId']) || null,
        raw: d
    };
}

/** Parse a webhook body (ORDER_SUCCESS / ORDER_FAILED / ORDER_REFUND_*) into a normalized status. */
function parseWebhook(body) {
    const b = body || {};
    const d = b.data && typeof b.data === 'object' ? { ...b.data, event: b.event || b.eventType } : b;
    const ev = String(b.event || b.eventType || d.event || '').toUpperCase();
    const out = normalizeStatus(d);
    if (ev === 'ORDER_SUCCESS') { out.paid = true; out.failed = false; out.status = 'SUCCESS'; }
    if (ev === 'ORDER_FAILED') { out.paid = false; out.failed = true; out.status = 'FAILED'; }
    out.event = ev;
    return out;
}

function buildClientReferenceId(orderIdString) {
    // Slice reference ids: alphanumeric, keep ≤ 40 chars.
    const base = String(orderIdString || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
    return (base || 'ORD') + Date.now().toString(36).toUpperCase();
}

module.exports = {
    GATEWAY_TAG,
    BASE_URLS,
    getConfig,
    getStatus,
    isActive,
    authHeaders,
    createOrder,
    getOrderStatus,
    normalizeStatus,
    parseWebhook,
    buildClientReferenceId
};

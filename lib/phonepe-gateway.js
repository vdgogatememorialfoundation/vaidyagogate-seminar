/**
 * PhonePe PG — standard checkout (pay API, redirect URL).
 */
const crypto = require('crypto');
const axios = require('axios');
const integrationSettings = require('./integration-settings');

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        merchantId: String(c.merchant_id || c.mid || '').trim(),
        saltKey: String(c.salt_key || c.salt || '').trim(),
        saltIndex: String(c.salt_index != null ? c.salt_index : '1').trim() || '1',
        mode
    };
}

function apiBase(mode) {
    return mode === 'live' ? 'https://api.phonepe.com/apis/hermes' : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
}

function sanitizeTxnId(raw) {
    let s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 40);
    if (s.length < 4) s = 'PP' + Date.now();
    return s;
}

function sha256Hex(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

async function createPayment(opts) {
    const creds = extractCredentials(opts.config);
    if (!creds.merchantId || !creds.saltKey) {
        throw new Error('PhonePe Merchant ID and Salt Key are required in Admin → Payment Gateways.');
    }

    const merchantTransactionId = sanitizeTxnId(opts.txnid);
    const amountPaise = Math.round(Number(opts.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        throw new Error('Invalid amount for PhonePe (minimum ₹1).');
    }

    const siteBase = integrationSettings.getPublicBaseUrl();
    const payload = {
        merchantId: creds.merchantId,
        merchantTransactionId,
        merchantUserId: String(opts.userId || 'doctor'),
        amount: amountPaise,
        redirectUrl: siteBase + '/api/payments/phonepe/return?txn=' + encodeURIComponent(merchantTransactionId),
        redirectMode: 'REDIRECT',
        callbackUrl: siteBase + '/api/payments/phonepe/webhook',
        paymentInstrument: { type: 'PAY_PAGE' }
    };

    const path = '/pg/v1/pay';
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const verify = sha256Hex(b64 + path + creds.saltKey) + '###' + creds.saltIndex;

    const url = apiBase(creds.mode) + path;
    const res = await axios.post(
        url,
        { request: b64 },
        {
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': verify,
                'X-MERCHANT-ID': creds.merchantId
            },
            timeout: 30000,
            validateStatus: () => true
        }
    );

    const data = res.data || {};
    if (!data.success) {
        const msg = (data.message || data.code || res.status) + '';
        throw new Error('PhonePe: ' + (msg || 'Could not start payment'));
    }

    const redirect =
        data.data &&
        data.data.instrumentResponse &&
        data.data.instrumentResponse.redirectInfo &&
        data.data.instrumentResponse.redirectInfo.url;
    if (!redirect) throw new Error('PhonePe did not return a checkout URL.');

    return {
        merchantTransactionId,
        paymentUrl: redirect,
        mode: creds.mode
    };
}

async function checkStatus(config, merchantTransactionId) {
    const creds = extractCredentials(config);
    const path =
        '/pg/v1/status/' + creds.merchantId + '/' + encodeURIComponent(merchantTransactionId);
    const verify = sha256Hex(path + creds.saltKey) + '###' + creds.saltIndex;
    const url = apiBase(creds.mode) + path;
    const res = await axios.get(url, {
        headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': verify,
            'X-MERCHANT-ID': creds.merchantId
        },
        timeout: 30000,
        validateStatus: () => true
    });
    const data = res.data || {};
    const st = data.data && data.data.state ? String(data.data.state) : '';
    const paid = st === 'COMPLETED';
    return {
        paid,
        status: st,
        transactionId: (data.data && data.data.transactionId) || '',
        raw: data
    };
}

module.exports = {
    extractCredentials,
    createPayment,
    checkStatus,
    sanitizeTxnId
};

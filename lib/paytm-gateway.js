/**
 * Paytm — initiate transaction + status (All-in-One checkout).
 */
const crypto = require('crypto');
const axios = require('axios');
const integrationSettings = require('./integration-settings');

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        mid: String(c.merchant_id || c.mid || '').trim(),
        key: String(c.merchant_key || c.key || '').trim(),
        website: String(c.website || 'DEFAULT').trim() || 'DEFAULT',
        mode
    };
}

function host(mode) {
    return mode === 'live' ? 'https://securegw.paytm.in' : 'https://securegw-stage.paytm.in';
}

function sanitizeOrderId(raw) {
    let s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 40);
    if (s.length < 4) s = 'PTM' + Date.now();
    return s;
}

function paytmChecksum(params, key) {
    const str = Object.keys(params)
        .sort()
        .map((k) => (params[k] != null ? k + '=' + params[k] : ''))
        .filter(Boolean)
        .join('&');
    return crypto
        .createHash('sha256')
        .update(str + '|' + key)
        .digest('hex');
}

async function initiateCheckout(opts) {
    const creds = extractCredentials(opts.config);
    if (!creds.mid || !creds.key) {
        throw new Error('Paytm Merchant ID and Merchant Key are required in Admin → Payment Gateways.');
    }

    const orderId = sanitizeOrderId(opts.orderId);
    const amount = formatAmount(opts.amount);
    const siteBase = integrationSettings.getPublicBaseUrl();
    const custId = String(opts.userId || 'doctor').slice(0, 50);

    const paytmParams = {
        MID: creds.mid,
        ORDER_ID: orderId,
        CUST_ID: custId,
        TXN_AMOUNT: amount,
        CHANNEL_ID: 'WEB',
        INDUSTRY_TYPE_ID: 'Retail',
        WEBSITE: creds.website,
        CALLBACK_URL: siteBase + '/api/payments/paytm/return'
    };
    paytmParams.CHECKSUMHASH = paytmChecksum(paytmParams, creds.key);

    return {
        orderId,
        formAction: host(creds.mode) + '/theia/processTransaction',
        formFields: paytmParams,
        mode: creds.mode
    };
}

function formatAmount(amount) {
    return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

async function fetchOrderStatus(config, orderId) {
    const creds = extractCredentials(config);
    const oid = sanitizeOrderId(orderId);
    const body = {
        mid: creds.mid,
        orderId: oid
    };
    body.checksumHash = paytmChecksum(body, creds.key);

    const url = host(creds.mode) + '/v3/order/status';
    const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true
    });
    const data = res.data && res.data.body ? res.data.body : res.data || {};
    const st = String(data.resultInfo && data.resultInfo.resultStatus ? data.resultInfo.resultStatus : data.resultStatus || '').toUpperCase();
    const paid = st === 'TXN_SUCCESS';
    return {
        paid,
        status: st,
        txnId: data.txnId || '',
        raw: data
    };
}

module.exports = {
    extractCredentials,
    initiateCheckout,
    fetchOrderStatus,
    sanitizeOrderId,
    isSuccessStatus: (s) => String(s || '').toUpperCase() === 'TXN_SUCCESS'
};

/**
 * Juspay Hyper Checkout — Session API (web redirect via payment_links.web).
 */
const axios = require('axios');
const shared = require('./payment-checkout-shared');

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    const bucket = mode === 'live' ? c.live || c : c.test || c;
    return {
        merchantId: String(bucket.merchant_id || c.merchant_id || '').trim(),
        apiKey: String(bucket.api_key || c.api_key || '').trim(),
        clientId: String(bucket.payment_page_client_id || c.payment_page_client_id || '').trim(),
        mode
    };
}

function apiBase(mode) {
    return mode === 'live' ? 'https://api.juspay.in' : 'https://sandbox.juspay.in';
}

function authHeader(apiKey) {
    return 'Basic ' + Buffer.from(String(apiKey) + ':').toString('base64');
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.merchantId || !creds.apiKey || !creds.clientId) {
        return callback(
            new Error(
                'Juspay merchant ID, API key, and Payment Page Client ID are required in Admin → Payment Gateways.'
            )
        );
    }
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    const phone = shared.sanitizePhone10(opts.phone);
    const email = String(opts.email || '').trim();
    if (!email) return callback(new Error('Your profile must include email before paying with Juspay.'));

    const returnUrl =
        `${shared.returnPath('juspay', 'success')}` +
        `&order_id=${encodeURIComponent(orderId)}` +
        `&udf1=${encodeURIComponent(String(opts.registrationId || ''))}` +
        `&udf2=${encodeURIComponent(String(opts.orderDbId || ''))}`;

    const body = {
        order_id: orderId,
        amount: shared.formatInrAmount(opts.amount),
        customer_id: String(opts.userId || opts.registrationId || orderId).slice(0, 50),
        customer_email: email,
        customer_phone: phone,
        payment_page_client_id: creds.clientId,
        action: 'paymentPage',
        return_url: returnUrl,
        description: String(opts.productinfo || 'Seminar registration').slice(0, 200),
        udf1: String(opts.registrationId || ''),
        udf2: String(opts.orderDbId || '')
    };

    axios
        .post(`${apiBase(creds.mode)}/session`, body, {
            headers: {
                Authorization: authHeader(creds.apiKey),
                'x-merchantid': creds.merchantId,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        })
        .then((res) => {
            const d = res.data || {};
            const webUrl = d.payment_links && d.payment_links.web;
            if (!webUrl) {
                const msg = d.error_message || d.message || d.error || JSON.stringify(d);
                return callback(new Error('Juspay session failed: ' + msg));
            }
            callback(null, {
                txnid: orderId,
                providerRef: d.id || orderId,
                paymentUrl: webUrl
            });
        })
        .catch((e) => {
            const msg =
                (e.response &&
                    e.response.data &&
                    (e.response.data.error_message || e.response.data.message || e.response.data.error)) ||
                e.message;
            callback(new Error('Juspay: ' + msg));
        });
}

function fetchOrderStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    axios
        .get(`${apiBase(creds.mode)}/orders/${encodeURIComponent(orderId)}`, {
            headers: {
                Authorization: authHeader(creds.apiKey),
                'x-merchantid': creds.merchantId
            },
            timeout: 20000
        })
        .then((res) => {
            const d = res.data || {};
            const st = String(d.status || '').toUpperCase();
            const paid = st === 'CHARGED' || st === 'AUTHORIZED';
            callback(null, {
                paid,
                status: st,
                paymentId: (d.txn_detail && d.txn_detail.txn_id) || d.txn_id || d.id || ''
            });
        })
        .catch((e) => callback(e));
}

module.exports = {
    extractCredentials,
    initiatePayment,
    fetchOrderStatus
};

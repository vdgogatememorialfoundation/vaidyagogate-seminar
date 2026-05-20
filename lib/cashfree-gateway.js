/**
 * Cashfree PG — create order + fetch status (REST API v2023-08-01).
 */
const axios = require('axios');
const integrationSettings = require('./integration-settings');

const API_VERSION = '2023-08-01';

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        appId: String(c.app_id || c.client_id || '').trim(),
        secretKey: String(c.secret_key || c.client_secret || '').trim(),
        mode
    };
}

function apiBase(mode) {
    return mode === 'live' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

function sanitizeOrderId(raw) {
    let s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 45);
    if (s.length < 3) s = ('CF' + Date.now()).slice(0, 45);
    return s;
}

function apiHeaders(creds) {
    return {
        'x-client-id': creds.appId,
        'x-client-secret': creds.secretKey,
        'x-api-version': API_VERSION,
        'Content-Type': 'application/json'
    };
}

async function createOrder(opts) {
    const creds = extractCredentials(opts.config);
    if (!creds.appId || !creds.secretKey) {
        throw new Error('Cashfree App ID and Secret Key are required in Admin → Payment Gateways.');
    }

    const orderId = sanitizeOrderId(opts.orderId);
    const amount = Math.round(Number(opts.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 1) {
        throw new Error('Invalid payment amount for Cashfree.');
    }

    const siteBase = integrationSettings.getPublicBaseUrl();
    const customerId = String(opts.userId || opts.customerId || 'doc').slice(0, 50);
    const phone = String(opts.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';
    const email = String(opts.email || '').trim();
    if (!email) throw new Error('Your profile must include a valid email before paying with Cashfree.');

    const body = {
        order_id: orderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
            customer_id: customerId,
            customer_phone: phone,
            customer_email: email,
            customer_name: String(opts.customerName || 'Doctor').slice(0, 100)
        },
        order_meta: {
            return_url:
                siteBase +
                '/api/payments/cashfree/return?order_id={order_id}&registration_id=' +
                encodeURIComponent(String(opts.registrationId || ''))
        },
        order_note: 'Seminar registration ' + (opts.applicationNo || orderId)
    };

    const url = apiBase(creds.mode) + '/orders';
    const res = await axios.post(url, body, { headers: apiHeaders(creds), timeout: 30000 });
    const data = res.data || {};
    const sessionId = data.payment_session_id || data.paymentSessionId;
    if (!sessionId) {
        const msg = data.message || data.error || 'Cashfree did not return a payment session.';
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    return {
        orderId,
        paymentSessionId: sessionId,
        mode: creds.mode === 'live' ? 'production' : 'sandbox'
    };
}

async function fetchOrder(config, orderId) {
    const creds = extractCredentials(config);
    const id = sanitizeOrderId(orderId);
    const url = apiBase(creds.mode) + '/orders/' + encodeURIComponent(id);
    const res = await axios.get(url, { headers: apiHeaders(creds), timeout: 30000 });
    const data = res.data || {};
    const st = String(data.order_status || '').toUpperCase();
    const paid = st === 'PAID';
    const payments = data.payments || [];
    const captured = payments.find((p) => String(p.payment_status || '').toUpperCase() === 'SUCCESS');
    return {
        paid: paid || !!captured,
        status: st,
        cfPaymentId: (captured && (captured.cf_payment_id || captured.payment_id)) || '',
        raw: data
    };
}

module.exports = {
    extractCredentials,
    createOrder,
    fetchOrder,
    sanitizeOrderId
};

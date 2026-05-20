/**
 * Cashfree PG — create order + payment session (hosted checkout).
 */
const axios = require('axios');
const shared = require('./payment-checkout-shared');

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        appId: String(c.app_id || c.client_id || '').trim(),
        secretKey: String(c.secret_key || c.client_secret || '').trim(),
        apiVersion: String(c.api_version || '2023-08-01').trim(),
        mode
    };
}

function apiBase(mode) {
    return mode === 'live' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

function checkoutUrl(mode, sessionId) {
    if (!sessionId) return null;
    if (mode === 'live') {
        return `https://payments.cashfree.com/order/#${sessionId}`;
    }
    return `https://sandbox.cashfree.com/pg/view/sessions/checkout/web/${sessionId}`;
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.appId || !creds.secretKey) {
        return callback(new Error('Cashfree App ID and Secret Key are required in Admin → Payment Gateways.'));
    }
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    const phone = shared.sanitizePhone10(opts.phone);
    const email = String(opts.email || '').trim();
    if (!email) return callback(new Error('Your profile must include email before paying with Cashfree.'));

    const body = {
        order_id: orderId,
        order_amount: Number(shared.formatInrAmount(opts.amount)),
        order_currency: 'INR',
        customer_details: {
            customer_id: String(opts.userId || opts.registrationId || orderId).slice(0, 50),
            customer_name: String(opts.firstname || 'Doctor').slice(0, 100),
            customer_email: email,
            customer_phone: phone
        },
        order_meta: {
            return_url: `${shared.returnPath('cashfree', 'success')}&order_id=${encodeURIComponent(orderId)}`,
            notify_url: `${shared.siteBase()}/api/payments/cashfree/webhook`
        },
        order_note: String(opts.productinfo || 'Seminar registration').slice(0, 200),
        order_tags: {
            registration_id: String(opts.registrationId || ''),
            order_db_id: String(opts.orderDbId || '')
        }
    };

    axios
        .post(`${apiBase(creds.mode)}/pg/orders`, body, {
            headers: {
                'x-client-id': creds.appId,
                'x-client-secret': creds.secretKey,
                'x-api-version': creds.apiVersion,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        })
        .then((res) => {
            const d = res.data || {};
            const sessionId = d.payment_session_id;
            if (!sessionId) {
                const msg = d.message || d.error || JSON.stringify(d);
                return callback(new Error('Cashfree order failed: ' + msg));
            }
            callback(null, {
                txnid: orderId,
                providerRef: d.cf_order_id || sessionId,
                paymentUrl: checkoutUrl(creds.mode, sessionId),
                paymentSessionId: sessionId
            });
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && (e.response.data.message || e.response.data.error)) ||
                e.message;
            callback(new Error('Cashfree: ' + msg));
        });
}

function fetchOrderStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    axios
        .get(`${apiBase(creds.mode)}/pg/orders/${encodeURIComponent(orderId)}`, {
            headers: {
                'x-client-id': creds.appId,
                'x-client-secret': creds.secretKey,
                'x-api-version': creds.apiVersion
            },
            timeout: 20000
        })
        .then((res) => {
            const d = res.data || {};
            const st = String(d.order_status || '').toUpperCase();
            const paid = st === 'PAID';
            callback(null, {
                paid,
                status: st,
                paymentId: d.cf_payment_id || (d.payment && d.payment.cf_payment_id) || ''
            });
        })
        .catch((e) => callback(e));
}

module.exports = {
    extractCredentials,
    initiatePayment,
    fetchOrderStatus,
    checkoutUrl
};

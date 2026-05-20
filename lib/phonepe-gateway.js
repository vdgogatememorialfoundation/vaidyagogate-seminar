/**
 * PhonePe Standard Checkout — pg/v1/pay redirect URL.
 */
const crypto = require('crypto');
const axios = require('axios');
const shared = require('./payment-checkout-shared');

const API = {
    test: {
        pay: 'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay',
        status: 'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/status'
    },
    prod: {
        pay: 'https://api.phonepe.com/apis/pg/v1/pay',
        status: 'https://api.phonepe.com/apis/pg/v1/status'
    }
};

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        merchantId: String(c.merchant_id || c.merchantId || '').trim(),
        saltKey: String(c.salt_key || c.salt || '').trim(),
        saltIndex: String(c.salt_index || c.saltIndex || '1').trim() || '1',
        mode
    };
}

function xVerify(base64Payload, path, salt, saltIndex) {
    const raw = crypto.createHash('sha256').update(base64Payload + path + salt).digest('hex');
    return raw + '###' + saltIndex;
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.merchantId || !creds.saltKey) {
        return callback(new Error('PhonePe Merchant ID and Salt Key are required in Admin → Payment Gateways.'));
    }
    const txnid = shared.sanitizeTxnid(opts.txnid, 40);
    const amountPaise = Math.round(Number(opts.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        return callback(new Error('Invalid payment amount for PhonePe.'));
    }

    const payload = {
        merchantId: creds.merchantId,
        merchantTransactionId: txnid,
        merchantUserId: String(opts.userId || opts.registrationId || txnid).slice(0, 40),
        amount: amountPaise,
        redirectUrl: `${shared.returnPath('phonepe', 'success')}&txnid=${encodeURIComponent(txnid)}`,
        redirectMode: 'REDIRECT',
        callbackUrl: `${shared.siteBase()}/api/payments/phonepe/webhook`,
        mobileNumber: shared.sanitizePhone10(opts.phone),
        paymentInstrument: { type: 'PAY_PAGE' }
    };

    const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const path = '/pg/v1/pay';
    const env = creds.mode === 'live' ? 'prod' : 'test';
    const url = API[env].pay;

    axios
        .post(url, { request: base64 }, {
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerify(base64, path, creds.saltKey, creds.saltIndex),
                'X-MERCHANT-ID': creds.merchantId
            },
            timeout: 30000
        })
        .then((res) => {
            const d = res.data || {};
            if (!d.success) {
                return callback(new Error(d.message || d.code || 'PhonePe payment initiation failed'));
            }
            const redirect =
                d.data &&
                d.data.instrumentResponse &&
                d.data.instrumentResponse.redirectInfo &&
                d.data.instrumentResponse.redirectInfo.url;
            if (!redirect) {
                return callback(new Error('PhonePe did not return a checkout URL'));
            }
            callback(null, { txnid, paymentUrl: redirect });
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) ||
                e.message;
            callback(new Error('PhonePe: ' + msg));
        });
}

function fetchPaymentStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const txnid = shared.sanitizeTxnid(opts.txnid, 40);
    const env = creds.mode === 'live' ? 'prod' : 'test';
    const path = `/pg/v1/status/${creds.merchantId}/${txnid}`;
    const base64 = Buffer.from(JSON.stringify({ merchantId: creds.merchantId, merchantTransactionId: txnid })).toString(
        'base64'
    );
    const url = `${API[env].status}/${creds.merchantId}/${txnid}`;

    axios
        .get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerify(base64, path, creds.saltKey, creds.saltIndex),
                'X-MERCHANT-ID': creds.merchantId
            },
            timeout: 20000
        })
        .then((res) => {
            const d = res.data || {};
            const code =
                d.code ||
                (d.data && d.data.state) ||
                (d.data && d.data.paymentState);
            const paid = String(code || '').toUpperCase() === 'PAYMENT_SUCCESS' || String(code || '').toUpperCase() === 'COMPLETED';
            callback(null, {
                paid,
                status: code,
                providerRef: (d.data && d.data.transactionId) || ''
            });
        })
        .catch((e) => callback(e));
}

module.exports = {
    extractCredentials,
    initiatePayment,
    fetchPaymentStatus
};

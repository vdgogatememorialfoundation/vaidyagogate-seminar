/**
 * PhonePe Standard Checkout v2 — developer.phonepe.com
 * OAuth + checkout/v2/pay + order status API.
 * Falls back to legacy v1 (salt) when OAuth credentials are not configured.
 */
const crypto = require('crypto');
const axios = require('axios');
const shared = require('./payment-checkout-shared');

const V2 = {
    test: {
        token: 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token',
        pay: 'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay',
        status: 'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order'
    },
    prod: {
        token: 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token',
        pay: 'https://api.phonepe.com/apis/pg/checkout/v2/pay',
        status: 'https://api.phonepe.com/apis/pg/checkout/v2/order'
    }
};

const V1 = {
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
    const live = c.live || c;
    return {
        clientId: String(live.client_id || c.client_id || '').trim(),
        clientSecret: String(live.client_secret || c.client_secret || '').trim(),
        clientVersion: String(live.client_version || c.client_version || '1').trim() || '1',
        merchantId: String(live.merchant_id || c.merchant_id || c.merchantId || '').trim(),
        saltKey: String(live.salt_key || c.salt_key || c.salt || '').trim(),
        saltIndex: String(live.salt_index || c.salt_index || '1').trim() || '1',
        mode,
        useV2() {
            return !!(this.clientId && this.clientSecret);
        }
    };
}

function sanitizeMerchantOrderId(raw) {
    return String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 63);
}

function getOAuthToken(creds, callback) {
    const env = creds.mode === 'live' ? 'prod' : 'test';
    const body = new URLSearchParams({
        client_id: creds.clientId,
        client_version: creds.clientVersion,
        client_secret: creds.clientSecret,
        grant_type: 'client_credentials'
    });
    axios
        .post(V2[env].token, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000
        })
        .then((res) => {
            const token = res.data && res.data.access_token;
            if (!token) return callback(new Error('PhonePe OAuth token missing'));
            callback(null, token);
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) ||
                e.message;
            callback(new Error('PhonePe OAuth failed: ' + msg));
        });
}

function initiatePaymentV2(opts, creds, callback) {
    const merchantOrderId = sanitizeMerchantOrderId(opts.txnid);
    const amountPaise = Math.round(Number(opts.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        return callback(new Error('Invalid payment amount for PhonePe.'));
    }

    getOAuthToken(creds, (tokErr, token) => {
        if (tokErr) return callback(tokErr);
        const env = creds.mode === 'live' ? 'prod' : 'test';
        const body = {
            merchantOrderId,
            amount: amountPaise,
            expireAfter: 1200,
            metaInfo: {
                udf1: String(opts.registrationId || '').slice(0, 256),
                udf2: String(opts.orderDbId || '').slice(0, 256),
                udf3: merchantOrderId
            },
            paymentFlow: {
                type: 'PG_CHECKOUT',
                message: 'Seminar registration payment',
                merchantUrls: {
                    redirectUrl: `${shared.returnPath('phonepe', 'success')}&merchantOrderId=${encodeURIComponent(merchantOrderId)}`
                }
            }
        };

        axios
            .post(V2[env].pay, body, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'O-Bearer ' + token
                },
                timeout: 30000
            })
            .then((res) => {
                const d = res.data || {};
                if (d.code && d.code !== 'SUCCESS') {
                    return callback(new Error(d.message || d.code || 'PhonePe payment initiation failed'));
                }
                const redirect = d.redirectUrl;
                if (!redirect) return callback(new Error('PhonePe did not return a checkout URL'));
                callback(null, { txnid: merchantOrderId, paymentUrl: redirect, phonePeVersion: 2 });
            })
            .catch((e) => {
                const msg =
                    (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) ||
                    e.message;
                callback(new Error('PhonePe: ' + msg));
            });
    });
}

function xVerifyV1(base64Payload, path, salt, saltIndex) {
    const raw = crypto.createHash('sha256').update(base64Payload + path + salt).digest('hex');
    return raw + '###' + saltIndex;
}

function initiatePaymentV1(opts, creds, callback) {
    const txnid = sanitizeMerchantOrderId(opts.txnid);
    const amountPaise = Math.round(Number(opts.amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
        return callback(new Error('Invalid payment amount for PhonePe.'));
    }
    if (!creds.merchantId || !creds.saltKey) {
        return callback(
            new Error('PhonePe v1 needs Merchant ID and Salt Key, or configure OAuth client ID/secret for v2.')
        );
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

    axios
        .post(V1[env].pay, { request: base64 }, {
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerifyV1(base64, path, creds.saltKey, creds.saltIndex),
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
            if (!redirect) return callback(new Error('PhonePe did not return a checkout URL'));
            callback(null, { txnid, paymentUrl: redirect, phonePeVersion: 1 });
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data))) ||
                e.message;
            callback(new Error('PhonePe: ' + msg));
        });
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (creds.useV2()) return initiatePaymentV2(opts, creds, callback);
    return initiatePaymentV1(opts, creds, callback);
}

function fetchPaymentStatusV2(opts, creds, callback) {
    const merchantOrderId = sanitizeMerchantOrderId(opts.txnid);
    getOAuthToken(creds, (tokErr, token) => {
        if (tokErr) return callback(tokErr);
        const env = creds.mode === 'live' ? 'prod' : 'test';
        const url = `${V2[env].status}/${encodeURIComponent(merchantOrderId)}/status?details=false`;
        axios
            .get(url, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'O-Bearer ' + token
                },
                timeout: 20000
            })
            .then((res) => {
                const d = res.data || {};
                const state = String(d.state || '').toUpperCase();
                const paid = state === 'COMPLETED';
                const txnId =
                    (d.paymentDetails && d.paymentDetails[0] && d.paymentDetails[0].transactionId) || '';
                callback(null, { paid, status: state, providerRef: txnId });
            })
            .catch((e) => callback(e));
    });
}

function fetchPaymentStatusV1(opts, creds, callback) {
    const txnid = sanitizeMerchantOrderId(opts.txnid);
    const env = creds.mode === 'live' ? 'prod' : 'test';
    const path = `/pg/v1/status/${creds.merchantId}/${txnid}`;
    const base64 = Buffer.from(
        JSON.stringify({ merchantId: creds.merchantId, merchantTransactionId: txnid })
    ).toString('base64');
    const url = `${V1[env].status}/${creds.merchantId}/${txnid}`;

    axios
        .get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': xVerifyV1(base64, path, creds.saltKey, creds.saltIndex),
                'X-MERCHANT-ID': creds.merchantId
            },
            timeout: 20000
        })
        .then((res) => {
            const d = res.data || {};
            const code = d.code || (d.data && d.data.state) || (d.data && d.data.paymentState);
            const paid =
                String(code || '').toUpperCase() === 'PAYMENT_SUCCESS' ||
                String(code || '').toUpperCase() === 'COMPLETED';
            callback(null, {
                paid,
                status: code,
                providerRef: (d.data && d.data.transactionId) || ''
            });
        })
        .catch((e) => callback(e));
}

function fetchPaymentStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (creds.useV2()) return fetchPaymentStatusV2(opts, creds, callback);
    return fetchPaymentStatusV1(opts, creds, callback);
}

module.exports = {
    extractCredentials,
    initiatePayment,
    fetchPaymentStatus
};

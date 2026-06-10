/**
 * Paytm Payment Gateway — business.paytm.com / paytmpayments.com docs.
 * Initiate Transaction API + Transaction Status API v3.
 */
const axios = require('axios');
const PaytmChecksum = require('paytmchecksum');
const shared = require('./payment-checkout-shared');

const API = {
    test: 'https://securestage.paytmpayments.com',
    prod: 'https://secure.paytmpayments.com'
};

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        mid: String(c.merchant_id || c.mid || '').trim(),
        merchantKey: String(c.merchant_key || c.key || '').trim(),
        website: String(c.website || 'DEFAULT').trim() || 'DEFAULT',
        mode
    };
}

function apiBase(creds) {
    return API[creds.mode === 'live' ? 'prod' : 'test'];
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.mid || !creds.merchantKey) {
        return callback(new Error('Paytm Merchant ID and Merchant Key are required in Admin → Payment Gateways.'));
    }
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    const email = String(opts.email || '').trim();
    if (!email) return callback(new Error('Your profile must include email before paying with Paytm.'));

    const paytmParams = {
        body: {
            requestType: 'Payment',
            mid: creds.mid,
            websiteName: creds.website,
            orderId,
            callbackUrl: `${shared.returnPath('paytm', 'success')}&orderId=${encodeURIComponent(orderId)}`,
            txnAmount: {
                value: shared.formatInrAmount(opts.amount),
                currency: 'INR'
            },
            userInfo: {
                custId: String(opts.userId || opts.registrationId || orderId).slice(0, 50),
                email,
                mobile: shared.sanitizePhone10(opts.phone),
                firstName: String(opts.firstname || 'Doctor').slice(0, 60)
            }
        }
    };

    PaytmChecksum.generateSignature(JSON.stringify(paytmParams.body), creds.merchantKey)
        .then((checksum) => {
            paytmParams.head = { signature: checksum };
            const base = apiBase(creds);
            const url = `${base}/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(creds.mid)}&orderId=${encodeURIComponent(orderId)}`;
            return axios.post(url, paytmParams, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
        })
        .then((res) => {
            const body = (res.data && res.data.body) || {};
            const info = body.resultInfo || {};
            if (String(info.resultStatus || '').toUpperCase() !== 'S') {
                return callback(
                    new Error(info.resultMsg || info.resultCode || 'Paytm initiate transaction failed')
                );
            }
            const txnToken = body.txnToken;
            if (!txnToken) return callback(new Error('Paytm did not return txnToken'));
            const base = apiBase(creds);
            const paymentUrl = `${base}/theia/api/v1/showPaymentPage?mid=${encodeURIComponent(creds.mid)}&orderId=${encodeURIComponent(orderId)}&txnToken=${encodeURIComponent(txnToken)}`;
            callback(null, { txnid: orderId, paymentUrl, txnToken });
        })
        .catch((e) => {
            const msg =
                (e.response && e.response.data && JSON.stringify(e.response.data)) || e.message;
            callback(new Error('Paytm: ' + msg));
        });
}

/** Transaction Status API v3 — always use server-to-server before marking paid. */
function fetchOrderStatus(opts, callback) {
    const creds = extractCredentials(opts.config);
    const orderId = shared.sanitizeTxnid(opts.txnid, 40);
    const body = { mid: creds.mid, orderId };
    PaytmChecksum.generateSignature(JSON.stringify(body), creds.merchantKey)
        .then((checksum) => {
            const base = apiBase(creds);
            const url = `${base}/v3/order/status`;
            return axios.post(
                url,
                { body, head: { signature: checksum } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
            );
        })
        .then((res) => {
            const b = (res.data && res.data.body) || {};
            const info = b.resultInfo || {};
            const resultStatus = String(info.resultStatus || b.txnStatus || '').toUpperCase();
            const resultCode = String(info.resultCode || '').toUpperCase();
            const paid = resultStatus === 'TXN_SUCCESS' || resultCode === '01';
            callback(null, {
                paid,
                status: resultStatus || resultCode,
                providerRef: b.txnId || ''
            });
        })
        .catch((e) => callback(e));
}

/** Verify callback/checksum from Paytm redirect (form post). */
function verifyCallbackChecksum(params, merchantKey, checksumHash) {
    if (!merchantKey || !checksumHash) return false;
    try {
        return PaytmChecksum.verifySignature(params, merchantKey, checksumHash);
    } catch (_) {
        return false;
    }
}

module.exports = {
    extractCredentials,
    initiatePayment,
    fetchOrderStatus,
    verifyCallbackChecksum
};

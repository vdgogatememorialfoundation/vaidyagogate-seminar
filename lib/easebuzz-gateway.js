/**
 * Easebuzz payment gateway — initiate link, return verification, transaction retrieve.
 * Hash sequences match paywitheasebuzz-php-lib.
 */
const crypto = require('crypto');
const axios = require('axios');
const integrationSettings = require('./integration-settings');

const PAY_BASE = {
    test: 'https://testpay.easebuzz.in/',
    prod: 'https://pay.easebuzz.in/'
};

const DASH_BASE = {
    test: 'https://testdashboard.easebuzz.in/',
    prod: 'https://dashboard.easebuzz.in/'
};

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        key: String(c.merchant_key || c.key || '').trim(),
        salt: String(c.merchant_salt || c.salt || '').trim(),
        env: mode === 'live' ? 'prod' : 'test'
    };
}

function formatAmount(amount) {
    const n = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(n) || n < 0) return '0.0';
    if (Number.isInteger(n)) return n.toString() + '.0';
    return n.toFixed(2);
}

function sha512Lower(parts) {
    return crypto.createHash('sha512').update(parts.join('|')).digest('hex').toLowerCase();
}

function buildInitiateHash(fields, salt) {
    const seq = [
        'key',
        'txnid',
        'amount',
        'productinfo',
        'firstname',
        'email',
        'udf1',
        'udf2',
        'udf3',
        'udf4',
        'udf5',
        'udf6',
        'udf7',
        'udf8',
        'udf9',
        'udf10'
    ];
    const parts = seq.map((k) => String(fields[k] != null ? fields[k] : ''));
    parts.push(salt);
    return sha512Lower(parts);
}

function buildTransactionHash(fields, salt) {
    const seq = ['key', 'txnid', 'amount', 'email', 'phone'];
    const parts = seq.map((k) => String(fields[k] != null ? fields[k] : ''));
    parts.push(salt);
    return sha512Lower(parts);
}

function buildReverseHash(data, salt, status) {
    const seq = [
        'udf10',
        'udf9',
        'udf8',
        'udf7',
        'udf6',
        'udf5',
        'udf4',
        'udf3',
        'udf2',
        'udf1',
        'email',
        'firstname',
        'productinfo',
        'amount',
        'txnid',
        'key'
    ];
    const parts = [salt, String(status || data.status || '')];
    seq.forEach((k) => parts.push(String(data[k] != null ? data[k] : '')));
    return sha512Lower(parts);
}

function sanitizeTxnid(raw) {
    const s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 30);
    return s || 'TXN' + Date.now();
}

function sanitizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return '9999999999';
}

async function postForm(url, fields) {
    const body = new URLSearchParams();
    Object.entries(fields).forEach(([k, v]) => {
        if (v != null && v !== '') body.append(k, String(v));
    });
    const res = await axios.post(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        validateStatus: () => true
    });
    let data = res.data;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (_) {
            data = { status: 0, data: data, error: 'Invalid response from Easebuzz' };
        }
    }
    return data;
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.key || !creds.salt) {
        return callback(new Error('Easebuzz merchant key and salt are required in Admin → Payment Gateways.'));
    }

    const base = PAY_BASE[creds.env] || PAY_BASE.test;
    const amountStr = formatAmount(opts.amount);
    const txnid = sanitizeTxnid(opts.txnid);
    const siteBase = integrationSettings.getPublicBaseUrl();
    const regId = String(opts.registrationId || '');
    const orderDbId = String(opts.orderDbId || '');

    const fields = {
        key: creds.key,
        txnid,
        amount: amountStr,
        productinfo: String(opts.productinfo || 'Seminar Registration').slice(0, 100),
        firstname: String(opts.firstname || 'Doctor').slice(0, 50),
        email: String(opts.email || '').trim(),
        phone: sanitizePhone(opts.phone),
        surl: `${siteBase}/api/payments/easebuzz/return?outcome=success`,
        furl: `${siteBase}/api/payments/easebuzz/return?outcome=failure`,
        udf1: regId,
        udf2: orderDbId,
        udf3: '',
        udf4: '',
        udf5: '',
        udf6: '',
        udf7: '',
        udf8: '',
        udf9: '',
        udf10: ''
    };

    if (!fields.email) {
        return callback(new Error('Your profile must include a valid email before paying with Easebuzz.'));
    }

    fields.hash = buildInitiateHash(fields, creds.salt);

    postForm(base + 'payment/initiateLink', fields)
        .then((result) => {
            if (!result || Number(result.status) !== 1 || !result.data) {
                const msg =
                    (result && (result.error_desc || result.error || result.data)) ||
                    'Easebuzz could not start payment. Check merchant key/salt and mode (test vs live).';
                return callback(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
            }
            const accessKey = String(result.data).trim();
            callback(null, {
                txnid,
                accessKey,
                paymentUrl: base + 'pay/' + accessKey,
                env: creds.env,
                easebuzzKey: creds.key,
                easebuzzEnv: creds.env
            });
        })
        .catch((e) => callback(e));
}

function retrieveTransaction(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.key || !creds.salt) {
        return callback(new Error('Easebuzz not configured'));
    }
    const dash = DASH_BASE[creds.env] || DASH_BASE.test;
    const amountStr = formatAmount(opts.amount);
    const fields = {
        key: creds.key,
        txnid: sanitizeTxnid(opts.txnid),
        amount: amountStr,
        email: String(opts.email || '').trim(),
        phone: sanitizePhone(opts.phone)
    };
    fields.hash = buildTransactionHash(fields, creds.salt);

    postForm(dash + 'transaction/v1/retrieve', fields)
        .then((result) => {
            if (!result || Number(result.status) !== 1) {
                return callback(null, { paid: false, status: 'pending', raw: result });
            }
            const row = result.data || result;
            const st = String((row && row.status) || '').toLowerCase();
            const paid = st === 'success' || st === 'received' || st === 'captured';
            callback(null, {
                paid,
                status: st,
                easepayId: (row && (row.easepayid || row.easepay_id || row.bank_ref_num)) || '',
                raw: row
            });
        })
        .catch((e) => callback(e));
}

function verifyReturnPayload(payload, salt) {
    const data = payload || {};
    const received = String(data.hash || '').toLowerCase();
    if (!received) return false;
    const expected = buildReverseHash(data, salt, data.status);
    return expected === received;
}

function isPaymentSuccessStatus(status) {
    const st = String(status || '').toLowerCase();
    return st === 'success' || st === 'received' || st === 'captured';
}

module.exports = {
    extractCredentials,
    formatAmount,
    initiatePayment,
    retrieveTransaction,
    verifyReturnPayload,
    isPaymentSuccessStatus,
    sanitizeTxnid
};

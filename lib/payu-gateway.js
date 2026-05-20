/**
 * PayU — hosted checkout via form POST to _payment.
 */
const crypto = require('crypto');
const integrationSettings = require('./integration-settings');

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        key: String(c.merchant_key || c.key || '').trim(),
        salt: String(c.merchant_salt || c.salt || '').trim(),
        merchantId: String(c.merchant_id || '').trim(),
        mode
    };
}

function paymentUrl(mode) {
    return mode === 'live' ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment';
}

function formatAmount(amount) {
    return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

function buildHash(fields, salt) {
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
    return crypto.createHash('sha512').update(parts.join('|')).digest('hex').toLowerCase();
}

function sanitizeTxnid(raw) {
    let s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 25);
    if (s.length < 4) s = 'PU' + Date.now();
    return s;
}

function buildPaymentRequest(opts) {
    const creds = extractCredentials(opts.config);
    if (!creds.key || !creds.salt) {
        throw new Error('PayU merchant key and salt are required in Admin → Payment Gateways.');
    }

    const txnid = sanitizeTxnid(opts.txnid);
    const amount = formatAmount(opts.amount);
    const siteBase = integrationSettings.getPublicBaseUrl();
    const email = String(opts.email || '').trim();
    if (!email) throw new Error('Your profile must include a valid email before paying with PayU.');

    const fields = {
        key: creds.key,
        txnid,
        amount,
        productinfo: String(opts.productinfo || 'Seminar Registration').slice(0, 100),
        firstname: String(opts.firstname || 'Doctor').slice(0, 60),
        email,
        phone: String(opts.phone || '').replace(/\D/g, '').slice(-10) || '9999999999',
        surl: siteBase + '/api/payments/payu/return?status=success',
        furl: siteBase + '/api/payments/payu/return?status=failure',
        udf1: String(opts.registrationId || ''),
        udf2: String(opts.orderDbId || ''),
        udf3: '',
        udf4: '',
        udf5: '',
        udf6: '',
        udf7: '',
        udf8: '',
        udf9: '',
        udf10: ''
    };
    if (creds.merchantId) fields.udf5 = creds.merchantId;
    fields.hash = buildHash(fields, creds.salt);

    return {
        txnid,
        formAction: paymentUrl(creds.mode),
        formFields: fields,
        mode: creds.mode
    };
}

function isSuccessStatus(status) {
    const st = String(status || '').toLowerCase();
    return st === 'success' || st === 'captured';
}

module.exports = {
    extractCredentials,
    buildPaymentRequest,
    isSuccessStatus,
    sanitizeTxnid
};

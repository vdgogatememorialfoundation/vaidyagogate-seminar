/**
 * PayU hosted checkout (_payment) — auto-submit form POST.
 */
const crypto = require('crypto');
const shared = require('./payment-checkout-shared');

const PAY_BASE = {
    test: 'https://test.payu.in/_payment',
    prod: 'https://secure.payu.in/_payment'
};

function extractCredentials(config) {
    const c = config || {};
    const mode = c.mode === 'live' ? 'live' : 'test';
    return {
        key: String(c.merchant_key || c.key || '').trim(),
        salt: String(c.merchant_salt || c.salt || '').trim(),
        mode
    };
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
        '',
        '',
        '',
        '',
        '',
        ''
    ];
    const parts = seq.map((k) => (k ? String(fields[k] != null ? fields[k] : '') : ''));
    parts.push(salt);
    return crypto.createHash('sha512').update(parts.join('|')).digest('hex').toLowerCase();
}

function initiatePayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.key || !creds.salt) {
        return callback(new Error('PayU merchant key and salt are required in Admin → Payment Gateways.'));
    }
    const txnid = shared.sanitizeTxnid(opts.txnid, 25);
    const email = String(opts.email || '').trim();
    if (!email) return callback(new Error('Your profile must include email before paying with PayU.'));

    const fields = {
        key: creds.key,
        txnid,
        amount: shared.formatInrAmount(opts.amount),
        productinfo: String(opts.productinfo || 'Seminar Registration').slice(0, 100),
        firstname: String(opts.firstname || 'Doctor').slice(0, 60),
        email,
        phone: shared.sanitizePhone10(opts.phone),
        surl: shared.returnPath('payu', 'success'),
        furl: shared.returnPath('payu', 'failure'),
        udf1: String(opts.registrationId || ''),
        udf2: String(opts.orderDbId || ''),
        udf3: '',
        udf4: '',
        udf5: ''
    };
    fields.hash = buildHash(fields, creds.salt);

    callback(null, {
        txnid,
        formPost: {
            action: PAY_BASE[creds.mode === 'live' ? 'prod' : 'test'],
            fields
        },
        paymentUrl: null
    });
}

function verifyReturnHash(data, salt) {
    const received = String(data.hash || '').toLowerCase();
    if (!received) return false;
    const seq = ['status', 'udf5', 'udf4', 'udf3', 'udf2', 'udf1', 'email', 'firstname', 'productinfo', 'amount', 'txnid', 'key'];
    const parts = [salt, ...seq.map((k) => String(data[k] != null ? data[k] : ''))];
    const expected = crypto.createHash('sha512').update(parts.join('|')).digest('hex').toLowerCase();
    return expected === received;
}

module.exports = {
    extractCredentials,
    initiatePayment,
    verifyReturnHash,
    isPaidStatus: shared.isPaidStatus
};

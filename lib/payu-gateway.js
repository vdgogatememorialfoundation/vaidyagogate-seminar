/**
 * PayU hosted checkout (_payment) — docs.payu.in
 * Hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT)
 */
const crypto = require('crypto');
const axios = require('axios');
const shared = require('./payment-checkout-shared');

const PAY_BASE = {
    test: 'https://test.payu.in/_payment',
    prod: 'https://secure.payu.in/_payment'
};

const POSTSERVICE = {
    test: 'https://test.payu.in/merchant/postservice?form=2',
    prod: 'https://info.payu.in/merchant/postservice.php?form=2'
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

function sha512Pipe(parts) {
    return crypto.createHash('sha512').update(parts.join('|')).digest('hex').toLowerCase();
}

function buildPaymentHash(fields, salt) {
    const parts = [
        fields.key,
        fields.txnid,
        fields.amount,
        fields.productinfo,
        fields.firstname,
        fields.email,
        fields.udf1 || '',
        fields.udf2 || '',
        fields.udf3 || '',
        fields.udf4 || '',
        fields.udf5 || '',
        '',
        '',
        '',
        '',
        '',
        '',
        salt
    ].map((x) => String(x != null ? x : ''));
    return sha512Pipe(parts);
}

function buildVerifyHash(key, command, var1, salt) {
    return sha512Pipe([key, command, var1, salt]);
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
    fields.hash = buildPaymentHash(fields, creds.salt);

    callback(null, {
        txnid,
        formPost: {
            action: PAY_BASE[creds.mode === 'live' ? 'prod' : 'test'],
            fields
        },
        paymentUrl: null
    });
}

/** PayU reverse hash on response: sha512(SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key) */
function verifyReturnHash(data, salt) {
    const received = String(data.hash || '').toLowerCase();
    if (!received) return false;
    const seq = [
        salt,
        data.status || '',
        '',
        '',
        '',
        '',
        '',
        data.udf5 || '',
        data.udf4 || '',
        data.udf3 || '',
        data.udf2 || '',
        data.udf1 || '',
        data.email || '',
        data.firstname || '',
        data.productinfo || '',
        data.amount || '',
        data.txnid || '',
        data.key || ''
    ];
    const expected = sha512Pipe(seq);
    return expected === received;
}

function verifyPayment(opts, callback) {
    const creds = extractCredentials(opts.config);
    if (!creds.key || !creds.salt) return callback(new Error('PayU not configured'));
    const txnid = shared.sanitizeTxnid(opts.txnid, 25);
    const command = 'verify_payment';
    const hash = buildVerifyHash(creds.key, command, txnid, creds.salt);
    const body = new URLSearchParams({
        key: creds.key,
        command,
        var1: txnid,
        hash
    });

    axios
        .post(POSTSERVICE[creds.mode === 'live' ? 'prod' : 'test'], body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
            validateStatus: () => true
        })
        .then((res) => {
            let data = res.data;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch (_) {
                    return callback(null, { paid: false, status: 'unknown', raw: data });
                }
            }
            const row =
                (data && data.transaction_details && data.transaction_details[txnid]) ||
                (data && data.transaction_details && Object.values(data.transaction_details)[0]) ||
                data;
            const st = String((row && row.status) || (data && data.status) || '').toLowerCase();
            const paid = st === 'success' || st === 'captured';
            callback(null, {
                paid,
                status: st,
                providerRef: (row && row.mihpayid) || ''
            });
        })
        .catch((e) => callback(e));
}

module.exports = {
    extractCredentials,
    initiatePayment,
    verifyReturnHash,
    verifyPayment,
    isPaidStatus: shared.isPaidStatus
};

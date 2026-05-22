/**
 * Unified hosted checkout for Easebuzz, Cashfree, PayU, Paytm, PhonePe.
 */
const easebuzzGateway = require('./easebuzz-gateway');
const cashfreeGateway = require('./cashfree-gateway');
const payuGateway = require('./payu-gateway');
const paytmGateway = require('./paytm-gateway');
const phonepeGateway = require('./phonepe-gateway');
const shared = require('./payment-checkout-shared');

const HOSTED_GATEWAYS = new Set(['easebuzz', 'cashfree', 'payu', 'paytm', 'phonepe']);

const GATEWAY_MODULES = {
    easebuzz: easebuzzGateway,
    cashfree: cashfreeGateway,
    payu: payuGateway,
    paytm: paytmGateway,
    phonepe: phonepeGateway
};

const LABELS = {
    easebuzz: 'Easebuzz',
    cashfree: 'Cashfree',
    payu: 'PayU',
    paytm: 'Paytm',
    phonepe: 'PhonePe'
};

function isHosted(gateway) {
    return HOSTED_GATEWAYS.has(String(gateway || '').toLowerCase());
}

function buildInitResponse(gateway, mode, result) {
    const body = {
        paymentType: gateway + '_checkout',
        gateway,
        mode,
        pollRequired: true,
        message: `Opening ${LABELS[gateway] || gateway} secure payment page. Complete payment to receive your e-ticket.`
    };
    if (result.paymentUrl) body.paymentUrl = result.paymentUrl;
    if (result.formPost) body.formPost = result.formPost;
    if (gateway === 'easebuzz' && result.accessKey) {
        body.easebuzzAccessKey = result.accessKey;
        body.easebuzzKey = result.easebuzzKey;
        body.easebuzzEnv = result.easebuzzEnv;
    }
    return body;
}

function initiate(db, params, callback) {
    const { reg, orderRow, registrationId, amount, resolved, finishInit } = params;
    const gateway = resolved.gateway;
    const mod = GATEWAY_MODULES[gateway];
    if (!mod) return callback(new Error('Unsupported gateway: ' + gateway));

    db.get(
        `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
        [reg.user_id],
        (uErr, user) => {
            if (uErr) return callback(uErr);
            const firstname =
                [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || 'Doctor';
            const opts = {
                config: resolved.config,
                amount,
                txnid: orderRow.order_id_string,
                registrationId,
                orderDbId: orderRow.id,
                userId: reg.user_id,
                firstname,
                email: user && user.email,
                phone: user && user.phone,
                productinfo: 'Seminar ' + (reg.application_no || registrationId)
            };
            mod.initiatePayment(opts, (err, result) => {
                if (err) return callback(null, { error: err.message });
                const gwTag = shared.gatewayTag(gateway, resolved.mode);
                const providerId = result.providerRef || result.txnid;
                db.run(
                    `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                    [amount, gwTag, providerId || result.txnid, orderRow.id],
                    (uErr2) => {
                        if (uErr2) return callback(uErr2);
                        finishInit(buildInitResponse(gateway, resolved.mode, result));
                        callback(null);
                    }
                );
            });
        }
    );
}

function pollGateway(gateway, config, row, user, cb) {
    const mod = GATEWAY_MODULES[gateway];
    if (!mod) return cb(new Error('Unknown gateway'));
    const opts = {
        config,
        txnid: row.provider_order_id,
        amount: row.amount,
        email: user && user.email,
        phone: user && user.phone
    };
    if (gateway === 'easebuzz' && mod.retrieveTransaction) {
        return mod.retrieveTransaction(opts, cb);
    }
    if (gateway === 'cashfree' && mod.fetchOrderStatus) {
        return mod.fetchOrderStatus(opts, cb);
    }
    if (gateway === 'paytm' && mod.fetchOrderStatus) {
        return mod.fetchOrderStatus(opts, cb);
    }
    if (gateway === 'phonepe' && mod.fetchPaymentStatus) {
        return mod.fetchPaymentStatus(opts, cb);
    }
    cb(null, { paid: false, status: 'pending' });
}

function processReturn(gateway, db, deps, payload, cb) {
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
    const data = payload || {};
    const registrationId = parseInt(data.udf1 || data.registration_id, 10);
    const orderDbId = parseInt(data.udf2 || data.order_db_id, 10);
    const txnid = String(data.txnid || data.orderId || data.order_id || data.merchantTransactionId || '').trim();

    const finish = (paid, message) => {
        cb(null, {
            ok: paid,
            paid,
            message,
            redirectQuery: paid ? 'payment=success' : 'payment=failed'
        });
    };

    const loadOrder = (cbOrder) => {
        if (orderDbId) {
            return db.get(
                `SELECT o.*, r.user_id, r.seminar_id, u.email, u.phone
                 FROM orders o JOIN registrations r ON r.id = o.registration_id
                 JOIN users u ON u.id = r.user_id WHERE o.id = ?`,
                [orderDbId],
                cbOrder
            );
        }
        if (txnid) {
            return db.get(
                `SELECT o.*, r.user_id, r.seminar_id, u.email, u.phone
                 FROM orders o JOIN registrations r ON r.id = o.registration_id
                 JOIN users u ON u.id = r.user_id
                 WHERE o.provider_order_id = ? ORDER BY o.id DESC LIMIT 1`,
                [txnid],
                cbOrder
            );
        }
        if (registrationId) {
            return db.get(
                `SELECT o.*, r.user_id, r.seminar_id, u.email, u.phone
                 FROM orders o JOIN registrations r ON r.id = o.registration_id
                 JOIN users u ON u.id = r.user_id
                 WHERE o.registration_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1`,
                [registrationId],
                cbOrder
            );
        }
        cbOrder(null, null);
    };

    loadOrder((err, row) => {
        if (err) return cb(err);
        if (!row) return finish(false, 'Order not found');

        const gw = String(row.payment_gateway || '');
        if (!gw.startsWith(gateway)) {
            return finish(false, 'Invalid payment order');
        }
        if (row.status === 'success') {
            return finish(true, 'Payment already recorded.');
        }

        db.all(`SELECT * FROM payment_gateways WHERE name = ? AND is_active = 1`, [gateway], (eG, gwRows) => {
            if (eG) return cb(eG);
            const mode = gw.includes('live') ? 'live' : 'test';
            const resolved = (gwRows || [])
                .flatMap((r) => require('./payment-gateway-options').expandGatewayRow(r))
                .find((o) => o.gateway === gateway && o.mode === mode);
            if (!resolved) return finish(false, 'Gateway not configured');

            const complete = (txnRef, msg) => {
                fulfillRegistrationPayment(
                    row.registration_id,
                    row.user_id,
                    row.amount,
                    gw,
                    txnRef || 'PG_' + Date.now(),
                    (fErr, meta) => {
                        if (fErr) return cb(fErr);
                        if (notifEngine && notifEngine.notifyRegistrationPaid) {
                            notifEngine.notifyRegistrationPaid(db, {
                                userId: row.user_id,
                                seminarId: row.seminar_id,
                                registrationId: row.registration_id,
                                vars: { payment_amount: row.amount, payment_status: 'PAID' }
                            });
                        }
                        if (meta && meta.ticketId && notifyTicketIssued) {
                            notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId, {
                                email: true,
                                whatsapp: false
                            });
                        }
                        finish(true, msg);
                    }
                );
            };

            const tryPoll = () => {
                pollGateway(
                    gateway,
                    resolved.config,
                    row,
                    { email: row.email, phone: row.phone },
                    (pErr, poll) => {
                        if (pErr) {
                            return finish(
                                false,
                                'Payment verification pending. Refresh My Applications shortly.'
                            );
                        }
                        if (poll && poll.paid) {
                            const ref =
                                poll.easepayId ||
                                poll.paymentId ||
                                poll.providerRef ||
                                'PG_' + row.provider_order_id;
                            return complete(
                                ref,
                                'Payment successful. Your e-ticket is under Participant tickets.'
                            );
                        }
                        return finish(false, 'Payment was not completed.');
                    }
                );
            };

            if (gateway === 'payu') {
                const salt = payuGateway.extractCredentials(resolved.config).salt;
                if (payuGateway.verifyReturnHash(data, salt) && shared.isPaidStatus(data.status)) {
                    return complete(
                        data.mihpayid || data.txnid,
                        'Payment successful. Your e-ticket is under Participant tickets.'
                    );
                }
                if (String(data.outcome || '').toLowerCase() === 'success') return tryPoll();
                return finish(false, 'Payment was not completed.');
            }

            if (gateway === 'easebuzz') {
                const salt = easebuzzGateway.extractCredentials(resolved.config).salt;
                const hashOk = easebuzzGateway.verifyReturnPayload(data, salt);
                const success = easebuzzGateway.isPaymentSuccessStatus(data.status);
                if (hashOk && success) {
                    return complete(
                        data.easepayid || data.easepay_id || 'EBZ_' + txnid,
                        'Payment successful. Your e-ticket is under Participant tickets.'
                    );
                }
                if (String(data.outcome || '').toLowerCase() === 'success' || success) {
                    return tryPoll();
                }
                return finish(false, 'Payment was not completed.');
            }

            if (String(data.outcome || '').toLowerCase() === 'success' || shared.isPaidStatus(data.status)) {
                return tryPoll();
            }
            return finish(false, 'Payment was not completed.');
        });
    });
}

module.exports = {
    HOSTED_GATEWAYS,
    isHosted,
    initiate,
    pollGateway,
    processReturn,
    buildInitResponse,
    LABELS
};

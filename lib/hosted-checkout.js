/**
 * Unified hosted checkout for Easebuzz, Cashfree, PayU, Paytm, PhonePe.
 */
const easebuzzGateway = require('./easebuzz-gateway');
const cashfreeGateway = require('./cashfree-gateway');
const payuGateway = require('./payu-gateway');
const paytmGateway = require('./paytm-gateway');
const phonepeGateway = require('./phonepe-gateway');
const juspayGateway = require('./juspay-gateway');
const zohoPaymentsGateway = require('./zoho-payments-gateway');
const shared = require('./payment-checkout-shared');

const HOSTED_GATEWAYS = new Set(['easebuzz', 'cashfree', 'payu', 'paytm', 'phonepe', 'juspay', 'zoho']);

const GATEWAY_MODULES = {
    easebuzz: easebuzzGateway,
    cashfree: cashfreeGateway,
    payu: payuGateway,
    paytm: paytmGateway,
    phonepe: phonepeGateway,
    juspay: juspayGateway,
    zoho: zohoPaymentsGateway
};

const LABELS = {
    easebuzz: 'Easebuzz',
    cashfree: 'Cashfree',
    payu: 'PayU',
    paytm: 'Paytm',
    phonepe: 'PhonePe',
    juspay: 'Juspay',
    zoho: 'Zoho Payments'
};

function isHosted(gateway) {
    return HOSTED_GATEWAYS.has(String(gateway || '').toLowerCase());
}

function buildInitResponse(gateway, mode, result, opts) {
    const isBook = opts && opts.bookOrder;
    const body = {
        paymentType: gateway + '_checkout',
        gateway,
        mode,
        pollRequired: true,
        message: isBook
            ? `Opening ${LABELS[gateway] || gateway} secure payment page. Complete payment to confirm your book order.`
            : `Opening ${LABELS[gateway] || gateway} secure payment page. Complete payment to receive your e-ticket.`
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

function runGatewayInitiate(db, params, callback) {
    const {
        orderRow,
        amount,
        resolved,
        finishInit,
        userId,
        firstname,
        email,
        phone,
        registrationId,
        orderDbId,
        productinfo,
        udf5,
        bookOrder
    } = params;
    const gateway = resolved.gateway;
    const mod = GATEWAY_MODULES[gateway];
    if (!mod) return callback(new Error('Unsupported gateway: ' + gateway));

    const payOpts = {
        config: resolved.config,
        amount,
        txnid: orderRow.order_id_string,
        registrationId,
        orderDbId: orderDbId || orderRow.id,
        userId,
        firstname,
        email,
        phone,
        productinfo,
        udf5: udf5 || ''
    };
    mod.initiatePayment(payOpts, (err, result) => {
        if (err) return callback(null, { error: err.message });
        const gwTag = shared.gatewayTag(gateway, resolved.mode);
        const providerId = result.providerRef || result.txnid;
        db.run(
            `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
            [amount, gwTag, providerId || result.txnid, orderRow.id],
            (uErr2) => {
                if (uErr2) return callback(uErr2);
                finishInit(buildInitResponse(gateway, resolved.mode, result, { bookOrder }));
                callback(null);
            }
        );
    });
}

function initiate(db, params, callback) {
    const { reg, orderRow, registrationId, amount, resolved, finishInit } = params;
    db.get(
        `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
        [reg.user_id],
        (uErr, user) => {
            if (uErr) return callback(uErr);
            const firstname =
                [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || 'Doctor';
            runGatewayInitiate(
                db,
                {
                    orderRow,
                    amount,
                    resolved,
                    finishInit,
                    userId: reg.user_id,
                    firstname,
                    email: user && user.email,
                    phone: user && user.phone,
                    registrationId,
                    orderDbId: orderRow.id,
                    productinfo: 'Seminar ' + (reg.application_no || registrationId)
                },
                callback
            );
        }
    );
}

function initiateBookOrder(db, params, callback) {
    const { orderRow, bookOrderId, bookOrderCode, userId, amount, resolved, finishInit } = params;
    db.get(
        `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
        [userId],
        (uErr, user) => {
            if (uErr) return callback(uErr);
            const firstname =
                [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || 'Doctor';
            runGatewayInitiate(
                db,
                {
                    orderRow,
                    amount,
                    resolved,
                    finishInit,
                    userId,
                    firstname,
                    email: user && user.email,
                    phone: user && user.phone,
                    registrationId: bookOrderId,
                    orderDbId: orderRow.id,
                    productinfo: 'Books ' + (bookOrderCode || bookOrderId),
                    udf5: 'book_order',
                    bookOrder: true
                },
                callback
            );
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
    if (gateway === 'juspay' && mod.fetchOrderStatus) {
        return mod.fetchOrderStatus(opts, cb);
    }
    if (gateway === 'payu' && mod.verifyPayment) {
        return mod.verifyPayment(opts, cb);
    }
    if (gateway === 'paytm' && mod.fetchOrderStatus) {
        return mod.fetchOrderStatus(opts, cb);
    }
    if (gateway === 'phonepe' && mod.fetchPaymentStatus) {
        return mod.fetchPaymentStatus(opts, cb);
    }
    if (gateway === 'zoho' && mod.fetchSessionStatus) {
        return mod.fetchSessionStatus(
            { ...opts, sessionId: row.provider_order_id || opts.txnid },
            cb
        );
    }
    cb(null, { paid: false, status: 'pending' });
}

function isBookOrderPayload(data, row) {
    if (row && row.book_order_id) return true;
    const udf5 = String((data && data.udf5) || '').toLowerCase();
    return udf5 === 'book_order' || udf5 === 'book';
}

function processReturn(gateway, db, deps, payload, cb) {
    const { fulfillRegistrationPayment, fulfillBookOrderPayment, notifyTicketIssued, notifEngine } = deps;
    const data = payload || {};
    const registrationId = parseInt(data.udf1 || data.registration_id, 10);
    const orderDbId = parseInt(data.udf2 || data.order_db_id, 10);
    const txnid = String(
        data.txnid ||
            data.orderId ||
            data.ORDERID ||
            data.order_id ||
            data.merchantTransactionId ||
            data.merchantOrderId ||
            data.payments_session_id ||
            ''
    ).trim();

    const finish = (paid, message, row) => {
        const bookOrder = isBookOrderPayload(data, row);
        cb(null, {
            ok: paid,
            paid,
            message,
            redirectQuery: paid
                ? bookOrder
                    ? 'tab=tab-books&payment=success'
                    : 'payment=success'
                : bookOrder
                  ? 'tab=tab-books&payment=failed'
                  : 'payment=failed'
        });
    };

    const orderSelectSql = `
        SELECT o.*,
               r.user_id AS reg_user_id,
               r.seminar_id,
               bo.id AS book_order_id,
               bo.user_id AS book_user_id,
               bo.order_code AS book_order_code,
               COALESCE(r.user_id, bo.user_id) AS user_id,
               u.email,
               u.phone
        FROM orders o
        LEFT JOIN registrations r ON r.id = o.registration_id
        LEFT JOIN book_orders bo ON bo.order_id = o.id
        LEFT JOIN users u ON u.id = COALESCE(r.user_id, bo.user_id)`;

    const loadOrder = (cbOrder) => {
        if (orderDbId) {
            return db.get(`${orderSelectSql} WHERE o.id = ?`, [orderDbId], cbOrder);
        }
        if (txnid) {
            return db.get(
                `${orderSelectSql} WHERE o.provider_order_id = ? OR o.order_id_string = ? ORDER BY o.id DESC LIMIT 1`,
                [txnid, txnid],
                cbOrder
            );
        }
        if (registrationId && !isBookOrderPayload(data, null)) {
            return db.get(
                `${orderSelectSql} WHERE o.registration_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1`,
                [registrationId],
                cbOrder
            );
        }
        if (registrationId && isBookOrderPayload(data, null)) {
            return db.get(
                `${orderSelectSql} WHERE bo.id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1`,
                [registrationId],
                cbOrder
            );
        }
        cbOrder(null, null);
    };

    loadOrder((err, row) => {
        if (err) return cb(err);
        if (!row) return finish(false, 'Order not found', null);

        const gw = String(row.payment_gateway || '');
        if (!gw.startsWith(gateway)) {
            return finish(false, 'Invalid payment order', row);
        }
        if (row.status === 'success') {
            return finish(true, 'Payment already recorded.', row);
        }

        db.all(`SELECT * FROM payment_gateways WHERE name = ? AND is_active = 1`, [gateway], (eG, gwRows) => {
            if (eG) return cb(eG);
            const mode = gw.includes('live') ? 'live' : 'test';
            const resolved = (gwRows || [])
                .flatMap((r) => require('./payment-gateway-options').expandGatewayRow(r))
                .find((o) => o.gateway === gateway && o.mode === mode);
            if (!resolved) return finish(false, 'Gateway not configured', row);

            const bookOrder = isBookOrderPayload(data, row);
            const successMsg = bookOrder
                ? 'Payment successful. Your book order is confirmed — see Book orders for your pickup QR.'
                : 'Payment successful. Your e-ticket is under Participant tickets.';

            const complete = (txnRef, msg) => {
                const txn = txnRef || 'PG_' + Date.now();
                if (bookOrder && fulfillBookOrderPayment) {
                    return fulfillBookOrderPayment(
                        db,
                        {
                            bookOrderId: row.book_order_id,
                            orderDbId: row.id,
                            gateway: gw,
                            txnId: txn
                        },
                        (fErr) => {
                            if (fErr) return cb(fErr);
                            finish(true, msg || successMsg, row);
                        }
                    );
                }
                if (!row.registration_id) {
                    return finish(false, 'Payment order is not linked to a registration or book order.', row);
                }
                fulfillRegistrationPayment(
                    row.registration_id,
                    row.user_id,
                    row.amount,
                    gw,
                    txn,
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
                                whatsapp: false,
                                immediate: true
                            });
                        }
                        finish(true, msg || successMsg, row);
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
                                bookOrder
                                    ? 'Payment verification pending. Refresh Book orders shortly.'
                                    : 'Payment verification pending. Refresh My Applications shortly.',
                                row
                            );
                        }
                        if (poll && poll.paid) {
                            const ref =
                                poll.easepayId ||
                                poll.paymentId ||
                                poll.providerRef ||
                                'PG_' + row.provider_order_id;
                            return complete(ref, successMsg);
                        }
                        return finish(false, 'Payment was not completed.', row);
                    }
                );
            };

            if (gateway === 'payu') {
                const salt = payuGateway.extractCredentials(resolved.config).salt;
                if (payuGateway.verifyReturnHash(data, salt) && shared.isPaidStatus(data.status)) {
                    return complete(data.mihpayid || data.txnid, successMsg);
                }
                if (String(data.outcome || '').toLowerCase() === 'success') return tryPoll();
                return finish(false, 'Payment was not completed.', row);
            }

            if (gateway === 'easebuzz') {
                const salt = easebuzzGateway.extractCredentials(resolved.config).salt;
                const hashOk = easebuzzGateway.verifyReturnPayload(data, salt);
                const success = easebuzzGateway.isPaymentSuccessStatus(data.status);
                if (hashOk && success) {
                    return complete(data.easepayid || data.easepay_id || 'EBZ_' + txnid, successMsg);
                }
                if (String(data.outcome || '').toLowerCase() === 'success' || success) {
                    return tryPoll();
                }
                return finish(false, 'Payment was not completed.', row);
            }

            if (gateway === 'paytm') {
                const creds = paytmGateway.extractCredentials(resolved.config);
                const checksum = data.CHECKSUMHASH || data.checksumHash;
                const params = { ...data };
                delete params.CHECKSUMHASH;
                delete params.checksumHash;
                if (checksum && !paytmGateway.verifyCallbackChecksum(params, creds.merchantKey, checksum)) {
                    return finish(false, 'Paytm callback checksum verification failed.', row);
                }
                if (String(data.outcome || '').toLowerCase() === 'success') return tryPoll();
                return finish(false, 'Payment was not completed.', row);
            }

            if (gateway === 'zoho') {
                const signingKey = zohoPaymentsGateway.extractCredentials(resolved.config).signingKey;
                const sigOk = signingKey ? zohoPaymentsGateway.verifyReturnSignature(data, signingKey) : true;
                if (sigOk && zohoPaymentsGateway.isSessionPaid(data)) {
                    return complete(data.payment_id || data.payments_session_id || 'ZOHO_' + txnid, successMsg);
                }
                if (String(data.outcome || '').toLowerCase() === 'success' || zohoPaymentsGateway.isSessionPaid(data)) {
                    return tryPoll();
                }
                return finish(false, 'Payment was not completed.', row);
            }

            if (String(data.outcome || '').toLowerCase() === 'success' || shared.isPaidStatus(data.status)) {
                return tryPoll();
            }
            return finish(false, 'Payment was not completed.', row);
        });
    });
}

module.exports = {
    HOSTED_GATEWAYS,
    isHosted,
    initiate,
    initiateBookOrder,
    pollGateway,
    processReturn,
    buildInitResponse,
    LABELS
};

/**
 * Razorpay Standard Web Checkout — create order, open modal, verify signature.
 * @see https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
 */
const crypto = require('crypto');
const paymentGatewayOptions = require('./payment-gateway-options');
const adminPaymentFlow = require('./admin-payment-flow');
const razorpayCredentials = require('./razorpay-credentials');
const razorpayResolve = require('./razorpay-resolve');

function verifyRazorpaySignature(orderId, paymentId, signature, keySecret) {
    if (!orderId || !paymentId || !signature || !keySecret) return false;
    const expected = crypto
        .createHmac('sha256', keySecret)
        .update(String(orderId) + '|' + String(paymentId))
        .digest('hex');
    return expected === String(signature);
}

function syncRazorpayEnvToDb(db, cb) {
    const env = razorpayCredentials.fromEnv();
    if (!env) return cb && cb(null, false);

    const force = String(process.env.RAZORPAY_FORCE_ENV_SYNC || '').trim() === '1';

    db.get(`SELECT config, is_active FROM payment_gateways WHERE name = ?`, ['razorpay'], (e, row) => {
        if (e) return cb && cb(e);

        const existing = row && row.config ? paymentGatewayOptions.parseGatewayConfig(row.config) : {};
        const ex = paymentGatewayOptions.migrateLegacyRazorpay(existing);

        if (!force) {
            if (env.mode === 'test' && paymentGatewayOptions.razorpayModeIsActive(ex.test, 'test')) {
                console.log(
                    '[razorpay] keeping admin test keys (' +
                        razorpayCredentials.keyIdPrefix(ex.test.key_id) +
                        '); set RAZORPAY_FORCE_ENV_SYNC=1 to overwrite from env'
                );
                return cb && cb(null, false);
            }
            if (env.mode === 'live' && paymentGatewayOptions.razorpayModeIsActive(ex.live, 'live')) {
                console.log(
                    '[razorpay] keeping admin live keys (' +
                        razorpayCredentials.keyIdPrefix(ex.live.key_id) +
                        '); set RAZORPAY_FORCE_ENV_SYNC=1 to overwrite from env'
                );
                return cb && cb(null, false);
            }
        }

        const incoming = {
            test: { ...(ex.test || {}), enabled: ex.test && ex.test.enabled === true },
            live: { ...(ex.live || {}), enabled: ex.live && ex.live.enabled === true }
        };
        if (env.mode === 'test') {
            incoming.test = { enabled: true, key_id: env.key_id, key_secret: env.key_secret };
        } else {
            incoming.live = { enabled: true, key_id: env.key_id, key_secret: env.key_secret };
        }
        const merged = paymentGatewayOptions.mergeRazorpayConfig(existing, incoming);
        const normalized = paymentGatewayOptions.normalizeGatewaySave('razorpay', merged, true);

        db.run(
            `INSERT OR REPLACE INTO payment_gateways (name, is_active, config) VALUES (?, ?, ?)`,
            ['razorpay', normalized.is_active, JSON.stringify(normalized.config)],
            (uErr) => cb && cb(uErr, !uErr)
        );
    });
}

function loadRegistrationForPayment(db, registrationId, userId, cb) {
    db.get(
        `SELECT r.id, r.user_id, r.status, r.application_no, r.seminar_id, s.price, s.title
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [registrationId],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(null, { error: 'Registration not found', status: 404 });
            if (Number(reg.user_id) !== Number(userId)) {
                return cb(null, { error: 'This registration does not belong to your account.', status: 403 });
            }
            const st = String(reg.status || '').toLowerCase();
            if (st === 'rejected' || st === 'cancelled') {
                return cb(null, { error: 'Payment is not available for rejected or cancelled applications.', status: 403 });
            }
            if (st === 'completed' || st === 'checked_in') {
                return cb(null, { error: 'Payment is already completed for this application.', status: 400 });
            }
            if (st !== 'approved_pending_payment') {
                return cb(null, {
                    error: 'Payment opens after admin approval. Current status: ' + (reg.status || 'unknown') + '.',
                    status: 403
                });
            }
            cb(null, { reg });
        }
    );
}

function handleCreateOrder(req, res, deps) {
    const { db, getOrCreatePendingOrder } = deps;
    const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
    const userId = parseInt((req.body && req.body.userId) || '', 10);
    const paymentOption = (req.body && req.body.paymentOption) || (req.body && req.body.methodId) || '';
    const amountOverride = req.body && req.body.amount != null ? Number(req.body.amount) : null;

    if (!registrationId || registrationId < 1) {
        return res.status(400).json({ success: false, error: 'registrationId is required.' });
    }
    if (!userId || userId < 1) {
        return res.status(400).json({ success: false, error: 'userId is required. Please sign in again.' });
    }

    loadRegistrationForPayment(db, registrationId, userId, (eReg, ctx) => {
        if (eReg) return res.status(500).json({ success: false, error: eReg.message });
        if (ctx && ctx.error) return res.status(ctx.status || 400).json({ success: false, error: ctx.error });

        const { reg } = ctx;
        const amount =
            amountOverride != null && !Number.isNaN(amountOverride) && amountOverride > 0
                ? Math.round(amountOverride * 100) / 100
                : Number(reg.price) || 0;
        const amountPaise = Math.round(amount * 100);

        if (amountPaise < 100) {
            return res.status(400).json({
                success: false,
                error: 'Payment amount must be at least ₹1. Set the seminar fee in admin seminar settings.'
            });
        }

        razorpayResolve.resolveRazorpayForCheckout(db, paymentOption, (eGw, resolved) => {
            if (eGw) return res.status(500).json({ success: false, error: eGw.message });
            if (!resolved) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the server, or save test keys in Admin → Payment gateways.'
                });
            }

            getOrCreatePendingOrder(registrationId, amount, (oErr, orderRow) => {
                if (oErr) return res.status(500).json({ success: false, error: oErr.message });
                if (!orderRow) {
                    return res.status(500).json({ success: false, error: 'Could not create order' });
                }

                const receipt =
                    orderRow.order_id_string.length > 40
                        ? orderRow.order_id_string.slice(0, 40)
                        : orderRow.order_id_string;

                razorpayResolve.createRazorpayOrderWithFallback(
                    paymentOption,
                    resolved,
                    { amount: amountPaise, currency: 'INR', receipt },
                    (rzErr, rzOrder, usedOpt, source) => {
                        if (rzErr) {
                            const msg = adminPaymentFlow.razorpayErrorMessage(rzErr, 'Razorpay order failed');
                            const status = /auth|unauthorized|invalid.*key/i.test(msg) ? 401 : 500;
                            return res.status(status).json({ success: false, error: msg });
                        }

                        const gwTag =
                            usedOpt.mode === 'live'
                                ? 'razorpay_live'
                                : usedOpt.mode === 'test'
                                  ? 'razorpay_test'
                                  : 'razorpay';
                        if (source === 'env') {
                            console.log('[razorpay] checkout using env keys after DB auth failure');
                        }

                        db.run(
                            `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                            [amount, gwTag, rzOrder.id, orderRow.id],
                            (uErr) => {
                                if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                                res.json({
                                    success: true,
                                    paymentType: 'razorpay_checkout',
                                    gateway: 'razorpay',
                                    mode: usedOpt.mode,
                                    key_id: usedOpt.config.key_id,
                                    keyId: usedOpt.config.key_id,
                                    order_id: rzOrder.id,
                                    amount: rzOrder.amount,
                                    currency: rzOrder.currency || 'INR',
                                    order: rzOrder,
                                    razorpayOrder: rzOrder,
                                    orderDbId: orderRow.id,
                                    registrationId,
                                    message: 'Razorpay checkout ready.'
                                });
                            }
                        );
                    }
                );
            });
        });
    });
}

function fulfillVerifiedPayment(db, deps, { applicationId, razorpay_order_id, razorpay_payment_id, activeGateway }, res) {
    const { fulfillRegistrationPayment, notifEngine, notifyTicketIssued, portalTracking } = deps;

    db.get(
        `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND provider_order_id = ?`,
        [applicationId, razorpay_order_id],
        (err, order) => {
            if (err) return res.status(500).json({ success: false, error: err.message });

            const tryFallback = (cb) => {
                db.get(
                    `SELECT id, order_id_string, status FROM orders WHERE registration_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
                    [applicationId],
                    cb
                );
            };

            const proceed = (ord) => {
                if (!ord) {
                    return tryFallback((e2, ord2) => {
                        if (e2) return res.status(500).json({ success: false, error: e2.message });
                        if (!ord2) return res.status(404).json({ success: false, error: 'Order not found' });
                        return proceed(ord2);
                    });
                }

                db.get(`SELECT status FROM registrations WHERE id = ?`, [applicationId], (ers, regSt) => {
                    if (ers) return res.status(500).json({ success: false, error: ers.message });
                    const st = String((regSt && regSt.status) || '').toLowerCase();
                    if (st === 'rejected' || st === 'cancelled') {
                        return res.status(403).json({
                            success: false,
                            error: 'This registration is rejected or cancelled; e-tickets are not issued.'
                        });
                    }

                    db.get(
                        `SELECT o.id, o.amount, o.status, r.user_id, r.seminar_id, r.id AS registration_id
                         FROM orders o JOIN registrations r ON r.id = o.registration_id WHERE o.id = ?`,
                        [ord.id],
                        (eRow, payRow) => {
                            if (eRow) return res.status(500).json({ success: false, error: eRow.message });
                            if (!payRow) return res.status(404).json({ success: false, error: 'Order not found' });

                            const gwTag =
                                activeGateway.mode === 'live'
                                    ? 'razorpay_live'
                                    : activeGateway.mode === 'test'
                                      ? 'razorpay_test'
                                      : 'razorpay';

                            fulfillRegistrationPayment(
                                applicationId,
                                payRow.user_id,
                                Number(payRow.amount) || 0,
                                gwTag,
                                razorpay_payment_id,
                                (fErr, meta) => {
                                    if (fErr) return res.status(500).json({ success: false, error: fErr.message });
                                    db.run(
                                        `UPDATE orders SET provider_order_id = COALESCE(NULLIF(provider_order_id, ''), ?) WHERE id = ?`,
                                        [razorpay_order_id, ord.id],
                                        () => {
                                            adminPaymentFlow.notifyAfterRegistrationPaid(
                                                db,
                                                notifEngine,
                                                notifyTicketIssued,
                                                payRow,
                                                meta,
                                                {
                                                    invoice_url:
                                                        notifEngine.publicBaseUrl() + '/doctor#tab-orders'
                                                },
                                                portalTracking
                                            );
                                            res.json({
                                                success: true,
                                                message:
                                                    meta && meta.ticketId
                                                        ? 'Payment verified and e-ticket issued.'
                                                        : 'Payment verified. Your e-ticket is under Participant tickets.',
                                                transactionId: razorpay_payment_id,
                                                ticketId: meta && meta.ticketId
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                });
            };

            if (order) return proceed(order);
            tryFallback((e2, ord2) => {
                if (e2) return res.status(500).json({ success: false, error: e2.message });
                proceed(ord2);
            });
        }
    );
}

function handleVerifyPayment(req, res, deps) {
    const { db, notifEngine } = deps;
    const body = req.body || {};
    const applicationId = parseInt(body.registrationId || body.applicationId || '', 10);
    const userId = parseInt(body.userId || '', 10);
    const paymentOption = body.paymentOption || body.paymentOptionId || body.methodId || '';
    const razorpay_order_id =
        body.razorpay_order_id || (body.paymentData && body.paymentData.razorpay_order_id) || '';
    const razorpay_payment_id =
        body.razorpay_payment_id || (body.paymentData && body.paymentData.razorpay_payment_id) || '';
    const razorpay_signature =
        body.razorpay_signature || (body.paymentData && body.paymentData.razorpay_signature) || '';

    if (!applicationId || applicationId < 1) {
        return res.status(400).json({ success: false, error: 'registrationId is required.' });
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({
            success: false,
            error: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.'
        });
    }

    if (userId) {
        return loadRegistrationForPayment(db, applicationId, userId, (eReg, ctx) => {
            if (eReg) return res.status(500).json({ success: false, error: eReg.message });
            if (ctx && ctx.error) return res.status(ctx.status || 400).json({ success: false, error: ctx.error });
            verifyAndFulfill();
        });
    }
    verifyAndFulfill();

    function verifyAndFulfill() {
        razorpayResolve.resolveRazorpayForCheckout(db, paymentOption, (eGw, activeGateway) => {
            if (eGw) return res.status(500).json({ success: false, error: eGw.message });
            if (!activeGateway) {
                return res.status(400).json({ success: false, error: 'Razorpay is not configured.' });
            }

            const valid = verifyRazorpaySignature(
                razorpay_order_id,
                razorpay_payment_id,
                razorpay_signature,
                activeGateway.config.key_secret
            );

            if (!valid) {
                if (notifEngine && userId) {
                    db.get(`SELECT user_id, seminar_id FROM registrations WHERE id = ?`, [applicationId], (ePf, pr) => {
                        if (!ePf && pr) {
                            notifEngine.notify(db, 'PAYMENT_FAILED', {
                                userId: pr.user_id,
                                seminarId: pr.seminar_id,
                                registrationId: applicationId,
                                vars: { payment_status: 'FAILED' }
                            });
                        }
                    });
                }
                return res.status(400).json({ success: false, error: 'Payment verification failed — signature mismatch.' });
            }

            fulfillVerifiedPayment(db, deps, {
                applicationId,
                razorpay_order_id,
                razorpay_payment_id,
                activeGateway
            }, res);
        });
    }
}

function registerRazorpayStandardRoutes(app, deps) {
    app.post('/api/create-order', (req, res) => handleCreateOrder(req, res, deps));
    app.post('/api/verify-payment', (req, res) => handleVerifyPayment(req, res, deps));
}

module.exports = {
    registerRazorpayStandardRoutes,
    resolveRazorpayForCheckout: razorpayResolve.resolveRazorpayForCheckout,
    verifyRazorpaySignature,
    syncRazorpayEnvToDb,
    handleCreateOrder,
    handleVerifyPayment
};

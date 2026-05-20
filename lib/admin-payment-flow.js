/**
 * Admin-initiated payments: method catalog, DQR (Razorpay / UPI), polling, fulfillment.
 */
const Razorpay = require('razorpay');
const paymentGatewayOptions = require('./payment-gateway-options');
const easebuzzGateway = require('./easebuzz-gateway');
const cashfreeGateway = require('./cashfree-gateway');
const payuGateway = require('./payu-gateway');
const paytmGateway = require('./paytm-gateway');
const phonepeGateway = require('./phonepe-gateway');

const MANUAL_CHECKOUT_GATEWAYS = new Set();
const HOSTED_CHECKOUT_GATEWAYS = new Set(['easebuzz', 'cashfree', 'payu', 'paytm', 'phonepe']);

function checkoutTypeForGateway(gw) {
    if (gw === 'razorpay') return 'razorpay_checkout';
    if (gw === 'easebuzz') return 'easebuzz_checkout';
    if (gw === 'cashfree') return 'cashfree_checkout';
    if (gw === 'payu') return 'payu_checkout';
    if (gw === 'paytm') return 'paytm_checkout';
    if (gw === 'phonepe') return 'phonepe_checkout';
    return 'manual_gateway';
}

function isAdminConfirmableGateway(gw) {
    const g = String(gw || '');
    if (g === 'dqr_upi_static') return true;
    return ['payu', 'paytm', 'phonepe', 'cashfree'].some((p) => g === p || g.startsWith(p + '_'));
}

function manualGatewayTag(gateway, mode) {
    const m = mode === 'live' ? 'live' : 'test';
    return `${gateway}_${m}`;
}

const GATEWAY_DESCRIPTIONS = {
    razorpay:
        'Razorpay Checkout — card, UPI apps, netbanking. Opens hosted checkout; doctor can also pay from their portal.',
    payu: 'PayU — UPI, cards, netbanking via hosted PayU checkout.',
    easebuzz: 'Easebuzz — UPI, cards, netbanking via hosted Easebuzz checkout page.',
    paytm: 'Paytm — hosted Paytm checkout page.',
    phonepe: 'PhonePe — hosted PhonePe payment page.',
    cashfree: 'Cashfree — UPI, cards, netbanking via Cashfree checkout.',
    mock: 'Test mode — instantly marks paid and issues e-ticket (no real money).'
};

const UPI_CONFIG_KEY = 'payment_upi_config';

function loadUpiConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [UPI_CONFIG_KEY], (err, row) => {
        if (err) return cb(err, { vpa: '', payee_name: 'VGMF Seminar' });
        let parsed = { vpa: '', payee_name: 'VGMF Seminar' };
        if (row && row.value) {
            try {
                const o = JSON.parse(row.value) || {};
                parsed.vpa = String(o.vpa || '').trim();
                parsed.payee_name = String(o.payee_name || 'VGMF Seminar').trim();
            } catch (_) {}
        }
        cb(null, parsed);
    });
}

function pickRazorpayGateway(rows) {
    const all = [];
    (rows || []).forEach((row) => {
        if (Number(row.is_active) !== 1) return;
        all.push(...paymentGatewayOptions.expandGatewayRow(row));
    });
    const live = all.find((o) => o.gateway === 'razorpay' && o.mode === 'live');
    if (live) return live;
    return all.find((o) => o.gateway === 'razorpay') || null;
}

function buildAdminPaymentMethods(rows, upiCfg) {
    const methods = [];
    const rz = pickRazorpayGateway(rows);
    const hasUpi = !!(upiCfg && upiCfg.vpa);

    methods.push({
        id: 'cash',
        type: 'cash',
        label: 'Cash',
        description: 'Record cash received at the desk. Marks the order paid and issues the e-ticket immediately.',
        available: true,
        autoConfirm: true
    });

    methods.push({
        id: 'dqr',
        type: 'dqr',
        label: 'DQR — Dynamic QR (UPI scan)',
        description: rz
            ? 'Creates a one-time Razorpay UPI QR for the exact fee. Status updates automatically when payment is received; the doctor sees the order and e-ticket in their dashboard.'
            : hasUpi
              ? `Shows a UPI QR to ${upiCfg.vpa}. Use "Mark UPI received" after the bank confirms payment.`
              : 'Configure Razorpay (recommended) or UPI VPA in Admin → Integrations / payment settings.',
        available: !!(rz || hasUpi),
        autoConfirm: !!rz
    });

    const all = [];
    (rows || []).forEach((row) => {
        if (Number(row.is_active) !== 1) return;
        all.push(...paymentGatewayOptions.expandGatewayRow(row));
    });

    all.forEach((o) => {
        const gw = o.gateway;
        const desc = GATEWAY_DESCRIPTIONS[gw] || `${o.label} — see gateway dashboard for settlement.`;
        const manual = MANUAL_CHECKOUT_GATEWAYS.has(gw);
        const hosted = HOSTED_CHECKOUT_GATEWAYS.has(gw) || gw === 'razorpay';
        methods.push({
            id: o.id,
            type: checkoutTypeForGateway(gw),
            label: o.label,
            description: desc,
            available: true,
            gateway: gw,
            mode: o.mode,
            autoConfirm: hosted,
            manualConfirm: manual
        });
    });

    if (!all.length) {
        methods.push({
            id: 'mock',
            type: 'mock',
            label: 'Test payment (mock)',
            description: GATEWAY_DESCRIPTIONS.mock,
            available: true,
            autoConfirm: true
        });
    }

    return methods;
}

/** Doctor portal: DQR + enabled gateways (no cash). */
function buildDoctorPaymentMethods(rows, upiCfg) {
    return buildAdminPaymentMethods(rows, upiCfg).filter((m) => m.id !== 'cash' && m.available !== false);
}

function cancelPendingOrdersForRegistration(db, registrationId, cb) {
    db.run(
        `UPDATE orders SET status = 'cancelled' WHERE registration_id = ? AND status = 'pending'`,
        [registrationId],
        function (err) {
            cb(err, this.changes || 0);
        }
    );
}

function cancelPendingOrder(db, orderDbId, cb) {
    db.get(`SELECT id, registration_id, status FROM orders WHERE id = ?`, [orderDbId], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, { error: 'Order not found' });
        if (String(row.status || '').toLowerCase() !== 'pending') {
            return cb(null, { error: 'Only pending orders can be cancelled.' });
        }
        db.run(`UPDATE orders SET status = 'cancelled' WHERE id = ?`, [orderDbId], function (uErr) {
            if (uErr) return cb(uErr);
            cb(null, { success: true, registrationId: row.registration_id, message: 'Pending order cancelled.' });
        });
    });
}

function buildUpiPayString(vpa, payeeName, amountRupee, note) {
    const params = new URLSearchParams();
    params.set('pa', vpa);
    params.set('pn', payeeName || 'Seminar');
    params.set('am', String(Number(amountRupee).toFixed(2)));
    params.set('cu', 'INR');
    if (note) params.set('tn', String(note).slice(0, 80));
    return 'upi://pay?' + params.toString();
}

function razorpayErrorMessage(err, fallback) {
    if (!err) return fallback || 'Payment gateway error';
    if (typeof err === 'string') return err;
    const body = err.error || err;
    if (body && body.description) return String(body.description);
    if (body && body.message) return String(body.message);
    if (err.description) return String(err.description);
    if (err.message) return String(err.message);
    return fallback || 'Payment gateway error';
}

function createRazorpayDqr(gatewayOpt, { amountRupee, orderIdStr, applicationNo }, cb) {
    const rz = new Razorpay({
        key_id: gatewayOpt.config.key_id,
        key_secret: gatewayOpt.config.key_secret
    });
    const amountPaise = Math.round(Number(amountRupee) * 100);
    if (amountPaise < 100) return cb(new Error('Amount must be at least ₹1'));
    if (!rz.qrCode || typeof rz.qrCode.create !== 'function') {
        return cb(
            new Error(
                'Razorpay QR API is unavailable. Use Razorpay Checkout (card/UPI apps) instead, or contact Razorpay to enable QR codes on your account.'
            )
        );
    }

    const payload = {
        type: 'upi_qr',
        name: 'VGMF Seminar',
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: amountPaise,
        description: `App ${applicationNo || orderIdStr}`.slice(0, 40),
        notes: {
            order_ref: String(orderIdStr || '').slice(0, 40),
            application_no: String(applicationNo || '').slice(0, 40)
        }
    };

    rz.qrCode.create(payload, (err, qr) => {
        if (err) {
            const msg = razorpayErrorMessage(
                err,
                'DQR creation failed. Enable QR codes in Razorpay Dashboard or use Razorpay Checkout.'
            );
            return cb(new Error(msg));
        }
        if (!qr || !qr.id) {
            return cb(
                new Error(
                    'Razorpay did not return a QR code. Enable QR codes on your Razorpay account or choose Razorpay Checkout.'
                )
            );
        }
        const imageUrl = qr.image_url || (qr.image && qr.image.url) || '';
        if (!imageUrl) {
            return cb(
                new Error(
                    'QR created but no image URL returned. Try Razorpay Checkout or check Razorpay dashboard for this QR.'
                )
            );
        }
        cb(null, {
            qrId: qr.id,
            imageUrl,
            shortUrl: qr.short_url || '',
            gatewayTag: gatewayOpt.mode === 'live' ? 'dqr_razorpay_live' : 'dqr_razorpay_test'
        });
    });
}

function pollRazorpayDqr(gatewayOpt, qrId, expectedPaise, cb) {
    const rz = new Razorpay({
        key_id: gatewayOpt.config.key_id,
        key_secret: gatewayOpt.config.key_secret
    });
    rz.qrCode.fetch(qrId, (err, qr) => {
        if (err) return cb(err);
        const received = Number(qr.payments_amount_received || 0);
        const closed = String(qr.status || '').toLowerCase() === 'closed';
        const paid = received >= expectedPaise || (closed && received > 0);
        cb(null, {
            paid,
            receivedPaise: received,
            status: qr.status,
            closeReason: qr.close_reason
        });
    });
}

function approveRegistrationForPayment(db, registrationId, portalTracking, notifEngine, cb) {
    db.get(
        `SELECT r.id, r.user_id, r.status, r.seminar_id, r.application_no, s.price, s.title
         FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
        [registrationId],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(null, { error: 'Registration not found' });
            const st = String(reg.status || '').toLowerCase();
            const amount = Number(reg.price) || 0;
            const done = () => cb(null, { reg, amount });

            if (st === 'approved_pending_payment' || st === 'completed' || st === 'checked_in') {
                return done();
            }
            if (st === 'rejected' || st === 'cancelled') {
                return cb(null, { error: 'Application is closed.' });
            }
            db.run(
                `UPDATE registrations SET status = 'approved_pending_payment' WHERE id = ?`,
                [registrationId],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    if (portalTracking && portalTracking.logRegistrationEvent) {
                        portalTracking.logRegistrationEvent(
                            db,
                            registrationId,
                            'approved',
                            'Approved for payment',
                            'Approved for payment collection.',
                            () => {}
                        );
                    }
                    if (notifEngine) {
                        notifEngine.notify(db, 'APPLICATION_APPROVED', {
                            userId: reg.user_id,
                            seminarId: reg.seminar_id,
                            registrationId,
                            vars: { approval_status: 'approved_pending_payment' }
                        });
                    }
                    reg.status = 'approved_pending_payment';
                    done();
                }
            );
        }
    );
}

function loadPaymentUser(db, userId, cb) {
    db.get(
        `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
        [userId],
        (err, user) => {
            if (err) return cb(err);
            const firstname =
                [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || 'Doctor';
            cb(null, { user, firstname });
        }
    );
}

function resolvePaymentAmount(reg, params) {
    const base = Number(reg.price) || 0;
    if (params && params.amount != null && params.amount !== '') {
        const a = Number(params.amount);
        if (!Number.isNaN(a) && a >= 0) return a;
    }
    const discount = params && params.discountAmount != null ? Number(params.discountAmount) : 0;
    if (!Number.isNaN(discount) && discount > 0) {
        return Math.max(0, Math.round((base - discount) * 100) / 100);
    }
    return base;
}

function initiateAdminPayment(db, deps, params, cb) {
    const {
        getOrCreatePendingOrder,
        fulfillRegistrationPayment,
        portalTracking,
        notifEngine,
        notifyTicketIssued
    } = deps;
    const {
        registrationId,
        methodId,
        adminUserId,
        amount: amountOverride,
        discountAmount
    } = params || {};
    const mid = String(methodId || '').trim();
    if (!mid) return cb(null, { error: 'methodId required' });

    approveRegistrationForPayment(db, registrationId, portalTracking, notifEngine, (e0, ctx) => {
        if (e0) return cb(e0);
        if (ctx && ctx.error) return cb(null, ctx);
        const { reg } = ctx;
        const amount = resolvePaymentAmount(reg, { amount: amountOverride, discountAmount });

        getOrCreatePendingOrder(registrationId, amount, (oErr, orderRow) => {
            if (oErr) return cb(oErr);
            if (!orderRow) return cb(null, { error: 'Could not create order' });

            const finishInit = (payload) => {
                cb(null, {
                    success: true,
                    registrationId,
                    userId: reg.user_id,
                    applicationNo: reg.application_no,
                    amount,
                    orderDbId: orderRow.id,
                    orderIdString: orderRow.order_id_string,
                    methodId: mid,
                    ...payload
                });
            };

            if (mid === 'cash') {
                return fulfillRegistrationPayment(
                    registrationId,
                    reg.user_id,
                    amount,
                    'cash',
                    'CASH_' + Date.now(),
                    (fErr, meta) => {
                        if (fErr) return cb(fErr);
                        if (meta && meta.ticketId && notifyTicketIssued) {
                            notifyTicketIssued(reg.user_id, registrationId, meta.ticketId);
                        }
                        finishInit({
                            paid: true,
                            message: 'Cash payment recorded. Doctor dashboard updated.',
                            gateway: 'cash'
                        });
                    }
                );
            }

            if (mid === 'mock') {
                return fulfillRegistrationPayment(
                    registrationId,
                    reg.user_id,
                    amount,
                    'mock',
                    'MOCK_' + Date.now(),
                    (fErr, meta) => {
                        if (fErr) return cb(fErr);
                        if (meta && meta.ticketId && notifyTicketIssued) {
                            notifyTicketIssued(reg.user_id, registrationId, meta.ticketId);
                        }
                        finishInit({
                            paid: true,
                            message: 'Test payment recorded. Doctor dashboard updated.',
                            gateway: 'mock'
                        });
                    }
                );
            }

            db.all(`SELECT * FROM payment_gateways`, [], (eGw, gwRows) => {
                if (eGw) return cb(eGw);

                if (mid === 'dqr') {
                    const rz = pickRazorpayGateway(gwRows);
                    if (rz) {
                        return createRazorpayDqr(
                            rz,
                            {
                                amountRupee: amount,
                                orderIdStr: orderRow.order_id_string,
                                applicationNo: reg.application_no
                            },
                            (dErr, dqr) => {
                                if (dErr) return cb(null, { error: dErr.message || 'DQR creation failed' });
                                db.run(
                                    `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                    [amount, dqr.gatewayTag, dqr.qrId, orderRow.id],
                                    (uErr) => {
                                        if (uErr) return cb(uErr);
                                        finishInit({
                                            paymentType: 'dqr',
                                            dqrProvider: 'razorpay',
                                            qrId: dqr.qrId,
                                            qrImageUrl: dqr.imageUrl,
                                            qrShortUrl: dqr.shortUrl,
                                            pollRequired: true,
                                            message:
                                                'DQR created. Ask the doctor to scan the QR; payment will confirm automatically.'
                                        });
                                    }
                                );
                            }
                        );
                    }
                    return loadUpiConfig(db, (eUpi, upiCfg) => {
                        if (eUpi) return cb(eUpi);
                        if (!upiCfg.vpa) {
                            return cb(null, {
                                error: 'DQR needs Razorpay keys or a UPI VPA in payment settings (payment_upi_config).'
                            });
                        }
                        const upiStr = buildUpiPayString(
                            upiCfg.vpa,
                            upiCfg.payee_name,
                            amount,
                            `App ${reg.application_no}`
                        );
                        const qrPath =
                            '/api/qrcode/' + encodeURIComponent(upiStr);
                        db.run(
                            `UPDATE orders SET amount = ?, payment_gateway = 'dqr_upi_static', provider_order_id = ? WHERE id = ?`,
                            [amount, 'upi:' + orderRow.order_id_string, orderRow.id],
                            (uErr) => {
                                if (uErr) return cb(uErr);
                                finishInit({
                                    paymentType: 'dqr',
                                    dqrProvider: 'upi_static',
                                    qrImageUrl: qrPath,
                                    upiString: upiStr,
                                    pollRequired: false,
                                    manualConfirm: true,
                                    message:
                                        'UPI QR shown. After bank confirms payment, click Mark UPI received.'
                                });
                            }
                        );
                    });
                }

                const resolved = paymentGatewayOptions.resolvePaymentOption(mid, gwRows);
                if (!resolved) return cb(null, { error: 'Unknown payment method.' });

                if (resolved.gateway === 'easebuzz') {
                    return db.get(
                        `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
                        [reg.user_id],
                        (uErr, user) => {
                            if (uErr) return cb(uErr);
                            const firstname =
                                [user && user.first_name, user && user.last_name]
                                    .filter(Boolean)
                                    .join(' ')
                                    .trim() || 'Doctor';
                            easebuzzGateway.initiatePayment(
                                {
                                    config: resolved.config,
                                    amount,
                                    txnid: orderRow.order_id_string,
                                    registrationId,
                                    orderDbId: orderRow.id,
                                    firstname,
                                    email: user && user.email,
                                    phone: user && user.phone,
                                    productinfo: 'Seminar ' + (reg.application_no || registrationId)
                                },
                                (ebErr, eb) => {
                                    if (ebErr) {
                                        return cb(null, {
                                            error: ebErr.message || 'Easebuzz payment could not be started.'
                                        });
                                    }
                                    const gwTag =
                                        resolved.mode === 'live' ? 'easebuzz_live' : 'easebuzz_test';
                                    db.run(
                                        `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                        [amount, gwTag, eb.txnid, orderRow.id],
                                        (uErr) => {
                                            if (uErr) return cb(uErr);
                                            finishInit({
                                                paymentType: 'easebuzz_checkout',
                                                gateway: 'easebuzz',
                                                mode: resolved.mode,
                                                paymentUrl: eb.paymentUrl,
                                                pollRequired: true,
                                                message:
                                                    'Opening Easebuzz secure payment page. Complete payment to receive your e-ticket.'
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                }

                if (resolved.gateway === 'cashfree') {
                    return loadPaymentUser(db, reg.user_id, (uErr, uCtx) => {
                        if (uErr) return cb(uErr);
                        cashfreeGateway
                            .createOrder({
                                config: resolved.config,
                                orderId: orderRow.order_id_string,
                                amount,
                                userId: reg.user_id,
                                email: uCtx.user && uCtx.user.email,
                                phone: uCtx.user && uCtx.user.phone,
                                customerName: uCtx.firstname,
                                registrationId,
                                applicationNo: reg.application_no
                            })
                            .then((cf) => {
                                const gwTag =
                                    resolved.mode === 'live' ? 'cashfree_live' : 'cashfree_test';
                                db.run(
                                    `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                    [amount, gwTag, cf.orderId, orderRow.id],
                                    (uErr) => {
                                        if (uErr) return cb(uErr);
                                        finishInit({
                                            paymentType: 'cashfree_checkout',
                                            gateway: 'cashfree',
                                            mode: resolved.mode,
                                            cashfreeMode: cf.mode,
                                            paymentSessionId: cf.paymentSessionId,
                                            cashfreeOrderId: cf.orderId,
                                            pollRequired: true,
                                            message:
                                                'Opening Cashfree checkout. Complete payment to receive your e-ticket.'
                                        });
                                    }
                                );
                            })
                            .catch((e) => cb(null, { error: e.message || 'Cashfree checkout failed' }));
                    });
                }

                if (resolved.gateway === 'payu') {
                    return loadPaymentUser(db, reg.user_id, (uErr, uCtx) => {
                        if (uErr) return cb(uErr);
                        try {
                            const pu = payuGateway.buildPaymentRequest({
                                config: resolved.config,
                                txnid: orderRow.order_id_string,
                                amount,
                                firstname: uCtx.firstname,
                                email: uCtx.user && uCtx.user.email,
                                phone: uCtx.user && uCtx.user.phone,
                                registrationId,
                                orderDbId: orderRow.id,
                                productinfo: 'Seminar ' + (reg.application_no || registrationId)
                            });
                            const gwTag = resolved.mode === 'live' ? 'payu_live' : 'payu_test';
                            db.run(
                                `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                [amount, gwTag, pu.txnid, orderRow.id],
                                (uErr) => {
                                    if (uErr) return cb(uErr);
                                    finishInit({
                                        paymentType: 'payu_checkout',
                                        gateway: 'payu',
                                        mode: resolved.mode,
                                        formAction: pu.formAction,
                                        formFields: pu.formFields,
                                        pollRequired: true,
                                        message: 'Opening PayU checkout…'
                                    });
                                }
                            );
                        } catch (e) {
                            cb(null, { error: e.message || 'PayU checkout failed' });
                        }
                    });
                }

                if (resolved.gateway === 'paytm') {
                    return loadPaymentUser(db, reg.user_id, (uErr, uCtx) => {
                        if (uErr) return cb(uErr);
                        paytmGateway
                            .initiateCheckout({
                                config: resolved.config,
                                orderId: orderRow.order_id_string,
                                amount,
                                userId: reg.user_id,
                                email: uCtx.user && uCtx.user.email
                            })
                            .then((pt) => {
                                const gwTag =
                                    resolved.mode === 'live' ? 'paytm_live' : 'paytm_test';
                                db.run(
                                    `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                    [amount, gwTag, pt.orderId, orderRow.id],
                                    (uErr) => {
                                        if (uErr) return cb(uErr);
                                        finishInit({
                                            paymentType: 'paytm_checkout',
                                            gateway: 'paytm',
                                            mode: resolved.mode,
                                            formAction: pt.formAction,
                                            formFields: pt.formFields,
                                            pollRequired: true,
                                            message: 'Opening Paytm checkout…'
                                        });
                                    }
                                );
                            })
                            .catch((e) => cb(null, { error: e.message || 'Paytm checkout failed' }));
                    });
                }

                if (resolved.gateway === 'phonepe') {
                    return loadPaymentUser(db, reg.user_id, (uErr, uCtx) => {
                        if (uErr) return cb(uErr);
                        phonepeGateway
                            .createPayment({
                                config: resolved.config,
                                txnid: orderRow.order_id_string,
                                amount,
                                userId: reg.user_id,
                                email: uCtx.user && uCtx.user.email
                            })
                            .then((pp) => {
                                const gwTag =
                                    resolved.mode === 'live' ? 'phonepe_live' : 'phonepe_test';
                                db.run(
                                    `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                    [amount, gwTag, pp.merchantTransactionId, orderRow.id],
                                    (uErr) => {
                                        if (uErr) return cb(uErr);
                                        finishInit({
                                            paymentType: 'phonepe_checkout',
                                            gateway: 'phonepe',
                                            mode: resolved.mode,
                                            paymentUrl: pp.paymentUrl,
                                            pollRequired: true,
                                            message: 'Opening PhonePe checkout…'
                                        });
                                    }
                                );
                            })
                            .catch((e) => cb(null, { error: e.message || 'PhonePe checkout failed' }));
                    });
                }

                if (MANUAL_CHECKOUT_GATEWAYS.has(resolved.gateway)) {
                    const gwTag = manualGatewayTag(resolved.gateway, resolved.mode);
                    return db.run(
                        `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                        [amount, gwTag, 'pending:' + orderRow.order_id_string, orderRow.id],
                        (uErr) => {
                            if (uErr) return cb(uErr);
                            finishInit({
                                paymentType: 'manual_gateway',
                                gateway: resolved.gateway,
                                mode: resolved.mode,
                                manualConfirm: true,
                                pollRequired: true,
                                message:
                                    `Payment started via ${resolved.label}. Complete payment on the ${resolved.gateway} page or app; our team will confirm and issue your e-ticket.`
                            });
                        }
                    );
                }

                if (resolved.gateway === 'razorpay') {
                    const rz = new Razorpay({
                        key_id: resolved.config.key_id,
                        key_secret: resolved.config.key_secret
                    });
                    const gwTag =
                        resolved.mode === 'live' ? 'razorpay_live' : resolved.mode === 'test' ? 'razorpay_test' : 'razorpay';
                    const receipt =
                        orderRow.order_id_string.length > 40
                            ? orderRow.order_id_string.slice(0, 40)
                            : orderRow.order_id_string;
                    rz.orders.create(
                        { amount: Math.round(amount * 100), currency: 'INR', receipt },
                        (rzErr, rzOrder) => {
                            if (rzErr) return cb(null, { error: rzErr.message || 'Razorpay order failed' });
                            db.run(
                                `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                [amount, gwTag, rzOrder.id, orderRow.id],
                                (uErr) => {
                                    if (uErr) return cb(uErr);
                                    finishInit({
                                        paymentType: 'razorpay_checkout',
                                        gateway: 'razorpay',
                                        mode: resolved.mode,
                                        keyId: resolved.config.key_id,
                                        razorpayOrder: rzOrder,
                                        pollRequired: true,
                                        message: 'Razorpay checkout ready. Complete payment in the popup or doctor portal.'
                                    });
                                }
                            );
                        }
                    );
                    return;
                }

                cb(null, { error: `${resolved.label} is not available. Check gateway keys in Admin → Payment Gateways.` });
            });
        });
    });
}

function pollAdminPaymentOrder(db, deps, orderDbId, cb) {
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
    db.get(
        `SELECT o.id, o.order_id_string, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                r.user_id, r.application_no, r.seminar_id
         FROM orders o
         JOIN registrations r ON r.id = o.registration_id
         WHERE o.id = ?`,
        [orderDbId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, { error: 'Order not found' });
            if (row.status === 'success') {
                return cb(null, {
                    paid: true,
                    status: 'success',
                    message: 'Already paid — visible in doctor dashboard.'
                });
            }

            const gw = String(row.payment_gateway || '');
            if (gw.startsWith('dqr_razorpay') && row.provider_order_id) {
                return db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                    if (eG) return cb(eG);
                    const rz = pickRazorpayGateway(gwRows);
                    if (!rz) return cb(null, { error: 'Razorpay not configured' });
                    const expectedPaise = Math.round(Number(row.amount) * 100);
                    pollRazorpayDqr(rz, row.provider_order_id, expectedPaise, (pErr, poll) => {
                        if (pErr) return cb(pErr);
                        if (!poll.paid) {
                            return cb(null, {
                                paid: false,
                                status: 'pending',
                                receivedPaise: poll.receivedPaise,
                                message: 'Waiting for UPI scan…'
                            });
                        }
                        fulfillRegistrationPayment(
                            row.registration_id,
                            row.user_id,
                            row.amount,
                            gw,
                            'DQR_' + row.provider_order_id,
                            (fErr, meta) => {
                                if (fErr) return cb(fErr);
                                if (notifEngine) {
                                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                        userId: row.user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: row.registration_id,
                                        vars: { amount: row.amount, order_id: row.order_id_string }
                                    });
                                }
                                if (meta && meta.ticketId && notifyTicketIssued) {
                                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                                }
                                cb(null, {
                                    paid: true,
                                    status: 'success',
                                    ticketId: meta && meta.ticketId,
                                    message: 'Payment received. Doctor dashboard updated.'
                                });
                            }
                        );
                    });
                });
            }

            if (gw.includes('razorpay') && row.provider_order_id) {
                return db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                    if (eG) return cb(eG);
                    const resolved = (gwRows || [])
                        .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                        .find((o) => o.gateway === 'razorpay' && gw.includes(o.mode));
                    const opt =
                        resolved ||
                        pickRazorpayGateway(gwRows);
                    if (!opt) return cb(null, { error: 'Razorpay not configured' });
                    const rz = new Razorpay({
                        key_id: opt.config.key_id,
                        key_secret: opt.config.key_secret
                    });
                    rz.orders.fetchPayments(row.provider_order_id, (payErr, payments) => {
                        if (payErr) return cb(null, { paid: false, status: 'pending' });
                        const items = (payments && payments.items) || [];
                        const captured = items.find((p) => String(p.status).toLowerCase() === 'captured');
                        if (!captured) {
                            return cb(null, { paid: false, status: 'pending', message: 'Checkout not completed yet.' });
                        }
                        fulfillRegistrationPayment(
                            row.registration_id,
                            row.user_id,
                            row.amount,
                            gw,
                            captured.id,
                            (fErr, meta) => {
                                if (fErr) return cb(fErr);
                                if (notifEngine) {
                                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                        userId: row.user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: row.registration_id,
                                        vars: { amount: row.amount }
                                    });
                                }
                                if (meta && meta.ticketId && notifyTicketIssued) {
                                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                                }
                                cb(null, {
                                    paid: true,
                                    status: 'success',
                                    message: 'Razorpay payment captured. Doctor dashboard updated.'
                                });
                            }
                        );
                    });
                });
            }

            if (gw.startsWith('easebuzz') && row.provider_order_id) {
                return db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                    if (eG) return cb(eG);
                    const resolved = (gwRows || [])
                        .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                        .find((o) => o.gateway === 'easebuzz' && gw.includes(o.mode));
                    if (!resolved) return cb(null, { error: 'Easebuzz not configured' });
                    db.get(
                        `SELECT email, phone FROM users WHERE id = ?`,
                        [row.user_id],
                        (eu, user) => {
                            if (eu) return cb(eu);
                            easebuzzGateway.retrieveTransaction(
                                {
                                    config: resolved.config,
                                    txnid: row.provider_order_id,
                                    amount: row.amount,
                                    email: user && user.email,
                                    phone: user && user.phone
                                },
                                (trErr, tr) => {
                                    if (trErr) return cb(trErr);
                                    if (!tr || !tr.paid) {
                                        return cb(null, {
                                            paid: false,
                                            status: 'pending',
                                            message: 'Easebuzz payment not completed yet.'
                                        });
                                    }
                                    const txnId =
                                        tr.easepayId || 'EBZ_' + row.provider_order_id;
                                    fulfillRegistrationPayment(
                                        row.registration_id,
                                        row.user_id,
                                        row.amount,
                                        gw,
                                        txnId,
                                        (fErr, meta) => {
                                            if (fErr) return cb(fErr);
                                            if (notifEngine) {
                                                notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                                    userId: row.user_id,
                                                    seminarId: row.seminar_id,
                                                    registrationId: row.registration_id,
                                                    vars: { amount: row.amount }
                                                });
                                            }
                                            if (meta && meta.ticketId && notifyTicketIssued) {
                                                notifyTicketIssued(
                                                    row.user_id,
                                                    row.registration_id,
                                                    meta.ticketId
                                                );
                                            }
                                            cb(null, {
                                                paid: true,
                                                status: 'success',
                                                ticketId: meta && meta.ticketId,
                                                message:
                                                    'Easebuzz payment received. Doctor dashboard updated.'
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                });
            }

            const pollHosted = (gatewayName, runCheck) => {
                db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
                    if (eG) return cb(eG);
                    const mode = gw.includes('live') ? 'live' : 'test';
                    const resolved = (gwRows || [])
                        .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                        .find((o) => o.gateway === gatewayName && o.mode === mode);
                    if (!resolved) return cb(null, { error: gatewayName + ' not configured' });
                    runCheck(resolved, (checkErr, paid, txnId, pendingMsg) => {
                        if (checkErr) return cb(checkErr);
                        if (!paid) {
                            return cb(null, {
                                paid: false,
                                status: 'pending',
                                message: pendingMsg || 'Payment not completed yet.'
                            });
                        }
                        fulfillRegistrationPayment(
                            row.registration_id,
                            row.user_id,
                            row.amount,
                            gw,
                            txnId,
                            (fErr, meta) => {
                                if (fErr) return cb(fErr);
                                if (notifEngine) {
                                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                        userId: row.user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: row.registration_id,
                                        vars: { amount: row.amount }
                                    });
                                }
                                if (meta && meta.ticketId && notifyTicketIssued) {
                                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                                }
                                cb(null, {
                                    paid: true,
                                    status: 'success',
                                    ticketId: meta && meta.ticketId,
                                    message: 'Payment received. Doctor dashboard updated.'
                                });
                            }
                        );
                    });
                });
            };

            if (gw.startsWith('cashfree') && row.provider_order_id) {
                return pollHosted('cashfree', (resolved, done) => {
                    cashfreeGateway
                        .fetchOrder(resolved.config, row.provider_order_id)
                        .then((st) =>
                            done(null, st.paid, st.cfPaymentId || 'CF_' + row.provider_order_id, null)
                        )
                        .catch((e) => done(e));
                });
            }

            if (gw.startsWith('paytm') && row.provider_order_id) {
                return pollHosted('paytm', (resolved, done) => {
                    paytmGateway
                        .fetchOrderStatus(resolved.config, row.provider_order_id)
                        .then((st) =>
                            done(null, st.paid, st.txnId || 'PTM_' + row.provider_order_id, null)
                        )
                        .catch((e) => done(e));
                });
            }

            if (gw.startsWith('phonepe') && row.provider_order_id) {
                return pollHosted('phonepe', (resolved, done) => {
                    phonepeGateway
                        .checkStatus(resolved.config, row.provider_order_id)
                        .then((st) =>
                            done(
                                null,
                                st.paid,
                                st.transactionId || 'PP_' + row.provider_order_id,
                                null
                            )
                        )
                        .catch((e) => done(e));
                });
            }

            cb(null, {
                paid: false,
                status: row.status || 'pending',
                manualConfirm: isAdminConfirmableGateway(gw),
                message: isAdminConfirmableGateway(gw)
                    ? 'Waiting for payment confirmation. Refresh shortly or contact the seminar desk.'
                    : undefined
            });
        }
    );
}

function processCashfreeReturn(db, deps, payload, cb) {
    const orderId = String((payload && payload.order_id) || '').trim();
    if (!orderId) {
        return cb(null, { ok: false, redirectQuery: 'payment=failed', message: 'Missing order reference.' });
    }
    db.get(
        `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                r.user_id, r.seminar_id
         FROM orders o
         JOIN registrations r ON r.id = o.registration_id
         WHERE o.provider_order_id = ? OR o.order_id_string = ?
         ORDER BY o.id DESC LIMIT 1`,
        [orderId, orderId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) {
                return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Order not found.' });
            }
            if (row.status === 'success') {
                return cb(null, {
                    ok: true,
                    paid: true,
                    redirectQuery: 'payment=success',
                    message: 'Payment already recorded.'
                });
            }
            const mode = String(row.payment_gateway || '').includes('live') ? 'live' : 'test';
            db.all(`SELECT * FROM payment_gateways WHERE name = 'cashfree' AND is_active = 1`, [], (eG, gwRows) => {
                if (eG) return cb(eG);
                const resolved = (gwRows || [])
                    .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                    .find((o) => o.mode === mode);
                if (!resolved) {
                    return cb(null, { ok: false, redirectQuery: 'payment=error', message: 'Cashfree not configured.' });
                }
                cashfreeGateway
                    .fetchOrder(resolved.config, orderId)
                    .then((st) => {
                        if (!st.paid) {
                            return cb(null, {
                                ok: false,
                                paid: false,
                                redirectQuery: 'payment=failed',
                                message: 'Payment not completed yet. Refresh My Applications shortly.'
                            });
                        }
                        const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
                        fulfillRegistrationPayment(
                            row.registration_id,
                            row.user_id,
                            row.amount,
                            row.payment_gateway,
                            st.cfPaymentId || 'CF_' + orderId,
                            (fErr, meta) => {
                                if (fErr) return cb(fErr);
                                if (notifEngine) {
                                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                        userId: row.user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: row.registration_id,
                                        vars: { amount: row.amount }
                                    });
                                }
                                if (meta && meta.ticketId && notifyTicketIssued) {
                                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                                }
                                cb(null, {
                                    ok: true,
                                    paid: true,
                                    redirectQuery: 'payment=success',
                                    message:
                                        'Payment successful. Your e-ticket is under Participant tickets.'
                                });
                            }
                        );
                    })
                    .catch((e) =>
                        cb(null, {
                            ok: false,
                            redirectQuery: 'payment=error',
                            message: e.message || 'Could not verify Cashfree payment.'
                        })
                    );
            });
        }
    );
}

function processPayuReturn(db, deps, payload, cb) {
    const data = payload || {};
    const txnid = String(data.txnid || '').trim();
    const status = String(data.status || data.unmappedstatus || '').toLowerCase();
    const regId = parseInt(data.udf1, 10);
    const orderDbId = parseInt(data.udf2, 10);
    const success = payuGateway.isSuccessStatus(status);

    const finish = (row, paid, message) => {
        if (!paid) {
            return cb(null, {
                ok: false,
                paid: false,
                redirectQuery: 'payment=failed',
                message: message || 'Payment was not completed.'
            });
        }
        const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
        fulfillRegistrationPayment(
            row.registration_id,
            row.user_id,
            row.amount,
            row.payment_gateway,
            String(data.mihpayid || data.bank_ref_num || 'PU_' + txnid),
            (fErr, meta) => {
                if (fErr) return cb(fErr);
                if (notifEngine) {
                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                        userId: row.user_id,
                        seminarId: row.seminar_id,
                        registrationId: row.registration_id,
                        vars: { amount: row.amount }
                    });
                }
                if (meta && meta.ticketId && notifyTicketIssued) {
                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                }
                cb(null, {
                    ok: true,
                    paid: true,
                    redirectQuery: 'payment=success',
                    message: 'Payment successful. Your e-ticket is under Participant tickets.'
                });
            }
        );
    };

    const sqlBase = `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                r.user_id, r.seminar_id
         FROM orders o JOIN registrations r ON r.id = o.registration_id WHERE `;
    const afterLoad = (err, row) => {
            if (err) return cb(err);
            if (!row) {
                return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Order not found.' });
            }
            if (row.status === 'success') {
                return cb(null, { ok: true, paid: true, redirectQuery: 'payment=success', message: 'Already paid.' });
            }
            finish(row, success, success ? null : 'PayU reported payment failure.');
    };

    if (orderDbId > 0) {
        return db.get(sqlBase + `o.id = ? ORDER BY o.id DESC LIMIT 1`, [orderDbId], afterLoad);
    }
    if (txnid) {
        return db.get(sqlBase + `o.provider_order_id = ? ORDER BY o.id DESC LIMIT 1`, [txnid], afterLoad);
    }
    if (regId > 0) {
        return db.get(
            sqlBase + `o.registration_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1`,
            [regId],
            afterLoad
        );
    }
    return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Missing payment reference.' });
}

function processPaytmReturn(db, deps, payload, cb) {
    const data = payload || {};
    const orderId = String(data.ORDERID || data.orderId || '').trim();
    const status = String(data.STATUS || data.status || '').toUpperCase();
    const paid = status === 'TXN_SUCCESS';
    if (!orderId) {
        return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Missing order id.' });
    }
    db.get(
        `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                r.user_id, r.seminar_id
         FROM orders o JOIN registrations r ON r.id = o.registration_id
         WHERE o.provider_order_id = ? ORDER BY o.id DESC LIMIT 1`,
        [orderId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) {
                return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Order not found.' });
            }
            if (row.status === 'success') {
                return cb(null, { ok: true, paid: true, redirectQuery: 'payment=success', message: 'Already paid.' });
            }
            if (!paid) {
                return cb(null, {
                    ok: false,
                    paid: false,
                    redirectQuery: 'payment=failed',
                    message: 'Paytm payment was not successful.'
                });
            }
            const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
            fulfillRegistrationPayment(
                row.registration_id,
                row.user_id,
                row.amount,
                row.payment_gateway,
                String(data.TXNID || data.txnId || 'PTM_' + orderId),
                (fErr, meta) => {
                    if (fErr) return cb(fErr);
                    if (notifEngine) {
                        notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                            userId: row.user_id,
                            seminarId: row.seminar_id,
                            registrationId: row.registration_id,
                            vars: { amount: row.amount }
                        });
                    }
                    if (meta && meta.ticketId && notifyTicketIssued) {
                        notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                    }
                    cb(null, {
                        ok: true,
                        paid: true,
                        redirectQuery: 'payment=success',
                        message: 'Payment successful. Your e-ticket is under Participant tickets.'
                    });
                }
            );
        }
    );
}

function processPhonepeReturn(db, deps, payload, cb) {
    const txn = String((payload && payload.txn) || (payload && payload.transactionId) || '').trim();
    if (!txn) {
        return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Missing transaction id.' });
    }
    db.get(
        `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                r.user_id, r.seminar_id
         FROM orders o JOIN registrations r ON r.id = o.registration_id
         WHERE o.provider_order_id = ? ORDER BY o.id DESC LIMIT 1`,
        [txn],
        (err, row) => {
            if (err) return cb(err);
            if (!row) {
                return cb(null, { ok: false, redirectQuery: 'payment=unknown', message: 'Order not found.' });
            }
            if (row.status === 'success') {
                return cb(null, { ok: true, paid: true, redirectQuery: 'payment=success', message: 'Already paid.' });
            }
            const mode = String(row.payment_gateway || '').includes('live') ? 'live' : 'test';
            db.all(`SELECT * FROM payment_gateways WHERE name = 'phonepe' AND is_active = 1`, [], (eG, gwRows) => {
                if (eG) return cb(eG);
                const resolved = (gwRows || [])
                    .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                    .find((o) => o.mode === mode);
                if (!resolved) {
                    return cb(null, { ok: false, redirectQuery: 'payment=error', message: 'PhonePe not configured.' });
                }
                phonepeGateway
                    .checkStatus(resolved.config, txn)
                    .then((st) => {
                        if (!st.paid) {
                            return cb(null, {
                                ok: false,
                                paid: false,
                                redirectQuery: 'payment=failed',
                                message: 'PhonePe payment not completed.'
                            });
                        }
                        const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
                        fulfillRegistrationPayment(
                            row.registration_id,
                            row.user_id,
                            row.amount,
                            row.payment_gateway,
                            st.transactionId || 'PP_' + txn,
                            (fErr, meta) => {
                                if (fErr) return cb(fErr);
                                if (notifEngine) {
                                    notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                        userId: row.user_id,
                                        seminarId: row.seminar_id,
                                        registrationId: row.registration_id,
                                        vars: { amount: row.amount }
                                    });
                                }
                                if (meta && meta.ticketId && notifyTicketIssued) {
                                    notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                                }
                                cb(null, {
                                    ok: true,
                                    paid: true,
                                    redirectQuery: 'payment=success',
                                    message:
                                        'Payment successful. Your e-ticket is under Participant tickets.'
                                });
                            }
                        );
                    })
                    .catch((e) =>
                        cb(null, {
                            ok: false,
                            redirectQuery: 'payment=error',
                            message: e.message || 'Could not verify PhonePe payment.'
                        })
                    );
            });
        }
    );
}

function processEasebuzzReturn(db, deps, payload, cb) {
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
    const data = payload || {};
    const registrationId = parseInt(data.udf1, 10);
    const orderDbId = parseInt(data.udf2, 10);
    const txnid = String(data.txnid || '').trim();

    if (!registrationId && !orderDbId && !txnid) {
        return cb(null, { ok: false, error: 'Missing payment reference', redirectQuery: 'payment=unknown' });
    }

    const loadOrder = (cbOrder) => {
        if (orderDbId) {
            return db.get(
                `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                        r.user_id, r.seminar_id, u.email, u.phone
                 FROM orders o
                 JOIN registrations r ON r.id = o.registration_id
                 JOIN users u ON u.id = r.user_id
                 WHERE o.id = ?`,
                [orderDbId],
                cbOrder
            );
        }
        if (txnid) {
            return db.get(
                `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                        r.user_id, r.seminar_id, u.email, u.phone
                 FROM orders o
                 JOIN registrations r ON r.id = o.registration_id
                 JOIN users u ON u.id = r.user_id
                 WHERE o.provider_order_id = ? ORDER BY o.id DESC LIMIT 1`,
                [txnid],
                cbOrder
            );
        }
        db.get(
            `SELECT o.id, o.registration_id, o.amount, o.status, o.payment_gateway, o.provider_order_id,
                    r.user_id, r.seminar_id, u.email, u.phone
             FROM orders o
             JOIN registrations r ON r.id = o.registration_id
             JOIN users u ON u.id = r.user_id
             WHERE o.registration_id = ? AND o.status = 'pending'
             ORDER BY o.id DESC LIMIT 1`,
            [registrationId],
            cbOrder
        );
    };

    loadOrder((err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, { ok: false, error: 'Order not found', redirectQuery: 'payment=unknown' });

        const gw = String(row.payment_gateway || '');
        if (!gw.startsWith('easebuzz')) {
            return cb(null, { ok: false, error: 'Not an Easebuzz order', redirectQuery: 'payment=unknown' });
        }

        db.all(`SELECT * FROM payment_gateways WHERE name = 'easebuzz' AND is_active = 1`, [], (eG, gwRows) => {
            if (eG) return cb(eG);
            const mode = gw.includes('live') ? 'live' : 'test';
            const resolved = (gwRows || [])
                .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
                .find((o) => o.gateway === 'easebuzz' && o.mode === mode);
            if (!resolved) {
                return cb(null, { ok: false, error: 'Easebuzz not configured', redirectQuery: 'payment=error' });
            }

            const creds = easebuzzGateway.extractCredentials(resolved.config);
            const hashOk = easebuzzGateway.verifyReturnPayload(data, creds.salt);
            const success = easebuzzGateway.isPaymentSuccessStatus(data.status);
            const outcomeHint = String(data.outcome || '').toLowerCase() === 'success';

            const finishRedirect = (paid, message) => {
                cb(null, {
                    ok: paid,
                    paid,
                    message,
                    registrationId: row.registration_id,
                    redirectQuery: paid ? 'payment=success' : 'payment=failed'
                });
            };

            const completePaid = (txnRef, message) => {
                fulfillRegistrationPayment(
                    row.registration_id,
                    row.user_id,
                    row.amount,
                    gw,
                    txnRef,
                    (fErr, meta) => {
                        if (fErr) return cb(fErr);
                        if (notifEngine) {
                            notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                                userId: row.user_id,
                                seminarId: row.seminar_id,
                                registrationId: row.registration_id,
                                vars: { amount: row.amount }
                            });
                        }
                        if (meta && meta.ticketId && notifyTicketIssued) {
                            notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                        }
                        finishRedirect(true, message);
                    }
                );
            };

            if (row.status === 'success') {
                return finishRedirect(true, 'Payment already recorded.');
            }

            const tryRetrieveThenComplete = () => {
                easebuzzGateway.retrieveTransaction(
                    {
                        config: resolved.config,
                        txnid: row.provider_order_id || txnid,
                        amount: row.amount,
                        email: row.email,
                        phone: row.phone
                    },
                    (trErr, tr) => {
                        if (trErr) {
                            return finishRedirect(
                                false,
                                'Could not verify payment yet. Refresh My Applications in a minute.'
                            );
                        }
                        if (tr && tr.paid) {
                            const txnRef =
                                tr.easepayId ||
                                String(data.easepayid || data.easepay_id || 'EBZ_' + txnid);
                            return completePaid(
                                txnRef,
                                'Payment successful. Your e-ticket is available under Participant tickets.'
                            );
                        }
                        return finishRedirect(
                            false,
                            'Payment was not completed or is still processing.'
                        );
                    }
                );
            };

            if (hashOk && success) {
                const txnRef = String(
                    data.easepayid || data.easepay_id || data.bank_ref_num || 'EBZ_' + txnid
                );
                return completePaid(
                    txnRef,
                    'Payment successful. Your e-ticket is available under Participant tickets.'
                );
            }

            if (outcomeHint || success) {
                return tryRetrieveThenComplete();
            }

            return finishRedirect(false, 'Payment was not completed or was cancelled.');
        });
    });
}

function markUpiStaticPaid(db, deps, orderDbId, adminUserId, cb) {
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
    db.get(
        `SELECT o.id, o.registration_id, o.amount, o.payment_gateway, o.status, r.user_id, r.seminar_id
         FROM orders o JOIN registrations r ON r.id = o.registration_id WHERE o.id = ?`,
        [orderDbId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, { error: 'Order not found' });
            if (row.status === 'success') return cb(null, { paid: true, message: 'Already paid.' });
            const gw = String(row.payment_gateway || '');
            if (!isAdminConfirmableGateway(gw)) {
                return cb(null, { error: 'This order cannot be marked paid manually.' });
            }
            const txnPrefix = gw === 'dqr_upi_static' ? 'UPI_' : 'MANUAL_';
            fulfillRegistrationPayment(
                row.registration_id,
                row.user_id,
                row.amount,
                gw,
                txnPrefix + Date.now(),
                (fErr, meta) => {
                    if (fErr) return cb(fErr);
                    if (notifEngine) {
                        notifEngine.notify(db, 'PAYMENT_SUCCESS', {
                            userId: row.user_id,
                            seminarId: row.seminar_id,
                            registrationId: row.registration_id,
                            vars: { amount: row.amount, confirmed_by_admin: adminUserId }
                        });
                    }
                    if (meta && meta.ticketId && notifyTicketIssued) {
                        notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId);
                    }
                    cb(null, {
                        paid: true,
                        message: 'Payment recorded. Doctor dashboard updated.',
                        ticketId: meta && meta.ticketId
                    });
                }
            );
        }
    );
}

module.exports = {
    UPI_CONFIG_KEY,
    loadUpiConfig,
    buildAdminPaymentMethods,
    buildDoctorPaymentMethods,
    cancelPendingOrdersForRegistration,
    cancelPendingOrder,
    razorpayErrorMessage,
    initiateAdminPayment,
    pollAdminPaymentOrder,
    markUpiStaticPaid,
    processEasebuzzReturn,
    processCashfreeReturn,
    processPayuReturn,
    processPaytmReturn,
    processPhonepeReturn,
    buildUpiPayString,
    pickRazorpayGateway,
    isAdminConfirmableGateway,
    MANUAL_CHECKOUT_GATEWAYS
};

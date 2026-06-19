/**
 * Admin-initiated payments: method catalog, DQR (Razorpay / UPI), polling, fulfillment.
 */
const Razorpay = require('razorpay');
const paymentGatewayOptions = require('./payment-gateway-options');
const easebuzzGateway = require('./easebuzz-gateway');
const hostedCheckout = require('./hosted-checkout');
const razorpayResolve = require('./razorpay-resolve');

const MANUAL_CHECKOUT_GATEWAYS = new Set();

function isAdminConfirmableGateway(gw) {
    const g = String(gw || '');
    if (g === 'dqr_upi_static') return true;
    return ['payu', 'paytm', 'phonepe', 'cashfree', 'juspay', 'easebuzz', 'zoho'].some(
        (p) => g === p || g.startsWith(p + '_')
    );
}

function manualGatewayTag(gateway, mode) {
    const m = mode === 'live' ? 'live' : 'test';
    return `${gateway}_${m}`;
}

const GATEWAY_DESCRIPTIONS = {
    razorpay:
        'Razorpay Checkout — card, UPI apps, netbanking. Opens hosted checkout; doctor can also pay from their portal.',
    payu: 'PayU — UPI, cards, netbanking via hosted PayU checkout.',
    easebuzz: 'Easebuzz — UPI, cards, netbanking via hosted Easebuzz checkout.',
    paytm: 'Paytm — UPI, cards, wallet via hosted Paytm checkout.',
    phonepe: 'PhonePe — UPI and cards via hosted PhonePe checkout.',
    cashfree: 'Cashfree — UPI, cards, netbanking via hosted Cashfree checkout.',
    juspay: 'Juspay Hyper Checkout — UPI, cards, netbanking via hosted Juspay payment page.',
    zoho: 'Zoho Payments — UPI, cards, netbanking via Zoho hosted checkout page.',
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
        if (!paymentGatewayOptions.isGatewayRowActive(row)) return;
        all.push(...paymentGatewayOptions.expandGatewayRow(row));
    });
    return all.find((o) => o.gateway === 'razorpay' && o.mode === 'live') || null;
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

    const all = [];
    (rows || []).forEach((row) => {
        if (!paymentGatewayOptions.isGatewayRowActive(row)) return;
        all.push(...paymentGatewayOptions.expandGatewayRow(row));
    });

    all.forEach((o) => {
        const gw = o.gateway;
        const desc = GATEWAY_DESCRIPTIONS[gw] || `${o.label} — see gateway dashboard for settlement.`;
        const hosted = hostedCheckout.isHosted(gw);
        methods.push({
            id: o.id,
            type:
                gw === 'razorpay' ? 'razorpay_checkout' : hosted ? gw + '_checkout' : 'manual_gateway',
            label: o.label,
            description: desc,
            available: true,
            gateway: gw,
            mode: o.mode,
            autoConfirm: gw === 'razorpay' || hosted,
            manualConfirm: !hosted && gw !== 'razorpay'
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

/** Doctor portal: enabled gateways only (no cash, no mock, no DQR). */
function buildDoctorPaymentMethods(rows, upiCfg) {
    return buildAdminPaymentMethods(rows, upiCfg).filter(
        (m) => m.id !== 'cash' && m.id !== 'mock' && m.id !== 'dqr' && m.available !== false
    );
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

function razorpayAuthHelpMessage() {
    return (
        'Razorpay rejected the API keys (Authentication failed). In Admin → Payment gateways, enter a matching Key ID and Secret from Razorpay Dashboard → Settings → API Keys. ' +
        'If Render environment variables RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set, they must be the same pair — or remove them so admin-saved keys are used after redeploy.'
    );
}

function razorpayErrorMessage(err, fallback) {
    if (!err) return fallback || 'Payment gateway error';
    let msg;
    if (typeof err === 'string') msg = err;
    else {
        const body = err.error || err;
        if (body && body.description) msg = String(body.description);
        else if (body && body.message) msg = String(body.message);
        else if (err.description) msg = String(err.description);
        else if (err.message) msg = String(err.message);
    }
    msg = msg || fallback || 'Payment gateway error';
    if (/authentication failed|unauthorized|invalid.*key|bad auth/i.test(msg)) {
        return razorpayAuthHelpMessage();
    }
    return msg;
}

function validateRazorpayCredentials(key_id, key_secret, cb) {
    const id = String(key_id || '').trim();
    const secret = String(key_secret || '').trim();
    if (!id || !secret) {
        return cb(null, { ok: false, error: 'Key ID and Secret are both required.' });
    }
    const rz = new Razorpay({ key_id: id, key_secret: secret });
    createRazorpayOrder(
        rz,
        { amount: 100, currency: 'INR', receipt: 'keytest_' + Date.now() },
        (err) => {
            if (err) return cb(null, { ok: false, error: razorpayErrorMessage(err, 'Invalid Razorpay keys') });
            cb(null, { ok: true });
        }
    );
}

function validateSavedRazorpayConfig(config, cb) {
    const c = paymentGatewayOptions.migrateLegacyRazorpay(
        paymentGatewayOptions.parseGatewayConfig(config)
    );
    const checkMode = (modeCfg, mode, next) => {
        const m = paymentGatewayOptions.normalizeRazorpayModeSave(modeCfg);
        if (!m.enabled) return next(null, { ok: true, skipped: true });
        if (!paymentGatewayOptions.razorpayModeIsActive(m, mode)) {
            return next(null, {
                ok: false,
                error:
                    mode === 'test'
                        ? 'Enable Test mode and enter rzp_test_ Key ID + Secret.'
                        : 'Enable Live mode and enter rzp_live_ Key ID + Secret.'
            });
        }
        validateRazorpayCredentials(m.key_id, m.key_secret, next);
    };
    checkMode(c.test, 'test', (e1, test) => {
        if (e1) return cb(e1);
        checkMode(c.live, 'live', (e2, live) => {
            if (e2) return cb(e2);
            cb(null, { test, live });
        });
    });
}

function createRazorpayOrder(rz, orderPayload, cb) {
    if (!rz || !rz.orders || typeof rz.orders.create !== 'function') {
        return cb(new Error('Razorpay SDK not available'));
    }
    let finished = false;
    const done = (rzErr, rzOrder) => {
        if (finished) return;
        finished = true;
        if (rzErr) return cb(rzErr);
        const order =
            rzOrder && rzOrder.id
                ? rzOrder
                : rzOrder && rzOrder.order_id
                  ? { ...rzOrder, id: rzOrder.order_id }
                  : null;
        if (!order || !order.id) {
            return cb(new Error(razorpayErrorMessage(null, 'Razorpay order failed')));
        }
        cb(null, order);
    };
    try {
        const ret = rz.orders.create(orderPayload, (rzErr, rzOrder) => done(rzErr, rzOrder));
        if (ret && typeof ret.then === 'function') {
            ret.then((rzOrder) => done(null, rzOrder)).catch((rzErr) => done(rzErr));
        }
    } catch (e) {
        done(e);
    }
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
            const seminarEvents = require('./seminar-events');
            seminarEvents.computeRegistrationPaymentAmount(db, registrationId, (payErr, pay) => {
                if (payErr) return cb(payErr);
                if (pay && pay.error) return cb(null, { error: pay.error });
                const amount = pay && pay.amount != null ? pay.amount : Number(reg.price) || 0;
                const done = () => cb(null, { reg, amount, paymentBreakdown: pay && pay.breakdown });

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
            });
        }
    );
}

function prepareApplicationPaymentLink(db, deps, params, cb) {
    const { getOrCreatePendingOrder, portalTracking, notifEngine } = deps || {};
    const registrationId = parseInt((params && params.registrationId) || '', 10);
    const methodId = String((params && params.methodId) || '').trim();
    if (!registrationId) return cb(null, { error: 'registrationId required' });
    if (!getOrCreatePendingOrder) return cb(null, { error: 'Payment orders not available' });

    const integrationSettings = require('./integration-settings');

    db.get(
        `SELECT r.id, r.user_id, r.status, r.application_no, r.seminar_id,
                u.user_id_string, u.email, u.first_name, u.middle_name, u.last_name,
                s.title AS seminar_title, s.price
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [registrationId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, { error: 'Registration not found' });
            const st = String(row.status || '').toLowerCase();
            if (st === 'completed' || st === 'checked_in') {
                return cb(null, {
                    error: 'This application is already paid — e-ticket issued.',
                    alreadyPaid: true,
                    registrationId: row.id,
                    applicationNo: row.application_no || null
                });
            }
            if (st === 'rejected' || st === 'cancelled') {
                return cb(null, { error: 'Application is closed.' });
            }

            db.get(
                `SELECT id FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
                [registrationId],
                (ePaid, paidOrd) => {
                    if (ePaid) return cb(ePaid);
                    if (paidOrd) {
                        return cb(null, {
                            error: 'This application is already paid.',
                            alreadyPaid: true,
                            registrationId: row.id,
                            applicationNo: row.application_no || null
                        });
                    }

                    approveRegistrationForPayment(
                        db,
                        registrationId,
                        portalTracking,
                        notifEngine,
                        (e0, ctx) => {
                            if (e0) return cb(e0);
                            if (ctx && ctx.error) return cb(null, ctx);
                            const amount = ctx && ctx.amount != null ? ctx.amount : Number(row.price) || 0;

                            getOrCreatePendingOrder(registrationId, amount, (oErr, orderRow) => {
                                if (oErr) return cb(oErr);
                                if (!orderRow) return cb(null, { error: 'Could not create payment order' });

                                const qs = new URLSearchParams();
                                qs.set('pay_registration', String(registrationId));
                                if (row.application_no) qs.set('pay_app', String(row.application_no));
                                if (row.user_id_string) qs.set('pay_user', String(row.user_id_string));
                                if (methodId) qs.set('pay_method', methodId);

                                const paymentLink =
                                    integrationSettings.getPublicBaseUrl() + '/doctor?' + qs.toString();
                                const fullName = [row.first_name, row.middle_name, row.last_name]
                                    .filter(Boolean)
                                    .join(' ')
                                    .trim();

                                cb(null, {
                                    success: true,
                                    registrationId,
                                    applicationNo: row.application_no || null,
                                    paymentLink,
                                    amount,
                                    applicantEmail: row.email || '',
                                    applicantName: fullName || 'Doctor',
                                    userIdString: row.user_id_string || '',
                                    seminarTitle: row.seminar_title || '',
                                    userId: row.user_id,
                                    seminarId: row.seminar_id,
                                    payable: true,
                                    orderDbId: orderRow.id
                                });
                            });
                        }
                    );
                }
            );
        }
    );
}

function notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta, extraVars, portalTracking) {
    if (!row) return;
    const vars = Object.assign(
        { payment_amount: row.amount, payment_status: 'PAID' },
        extraVars || {}
    );
    if (notifEngine) {
        notifEngine.notifyRegistrationPaid(db, {
            userId: row.user_id,
            seminarId: row.seminar_id,
            registrationId: row.registration_id,
            vars,
            immediate: true
        });
    }
    if (meta && meta.ticketId && !meta.skipped) {
        if (portalTracking && row.registration_id) {
            portalTracking.registrationStatusToLog('e_ticket_issued', '').forEach((entry) => {
                portalTracking.logRegistrationEvent(
                    db,
                    row.registration_id,
                    entry.key,
                    entry.label,
                    entry.message,
                    () => {}
                );
            });
        }
        if (notifyTicketIssued) {
            notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId, {
                email: true,
                whatsapp: false,
                immediate: true
            });
        }
    }
}

function resolvePaymentAmount(reg, params) {
    if (params && params.amount != null && params.amount !== '') {
        const a = Number(params.amount);
        if (!Number.isNaN(a) && a >= 0) return Math.round(a * 100) / 100;
    }
    const base = Number(reg.price) || 0;
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
        if (ctx && ctx.error) {
            const hasOverride =
                params &&
                params.amount != null &&
                params.amount !== '' &&
                !Number.isNaN(Number(params.amount));
            if (!hasOverride) return cb(null, ctx);
        }
        const { reg } = ctx;
        const amount = resolvePaymentAmount(reg, {
            amount:
                params && params.amount != null && params.amount !== ''
                    ? params.amount
                    : ctx.amount,
            discountAmount: params && params.discountAmount
        });

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
                        notifyAfterRegistrationPaid(
                            db,
                            notifEngine,
                            notifyTicketIssued,
                            {
                                user_id: reg.user_id,
                                seminar_id: reg.seminar_id,
                                registration_id: registrationId,
                                amount
                            },
                            meta,
                            null,
                            portalTracking
                        );
                        finishInit({
                            paid: true,
                            message: 'Cash payment recorded. E-ticket issued on the doctor dashboard.',
                            gateway: 'cash',
                            ticketId: meta && meta.ticketId
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
                        notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, reg, meta, null, portalTracking);
                        finishInit({
                            paid: true,
                            message: 'Test payment recorded. Doctor dashboard updated.',
                            gateway: 'mock',
                            ticketId: meta && meta.ticketId
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

                if (hostedCheckout.isHosted(resolved.gateway)) {
                    return hostedCheckout.initiate(
                        db,
                        { reg, orderRow, registrationId, amount, resolved, finishInit },
                        (hErr, hOut) => {
                            if (hErr) return cb(hErr);
                            if (hOut && hOut.error) return cb(null, hOut);
                        }
                    );
                }

                if (resolved.gateway === 'razorpay') {
                    const receipt =
                        orderRow.order_id_string.length > 40
                            ? orderRow.order_id_string.slice(0, 40)
                            : orderRow.order_id_string;
                    const amountPaise = Math.round(amount * 100);
                    if (amountPaise < 100) {
                        return cb(null, {
                            error: 'Payment amount must be at least ₹1. Set the seminar fee in seminar settings before checkout.'
                        });
                    }
                    return razorpayResolve.createRazorpayOrderWithFallback(
                        mid,
                        { ...resolved, source: 'db' },
                        { amount: amountPaise, currency: 'INR', receipt },
                        (rzErr, rzOrder, usedOpt, source) => {
                            if (rzErr) {
                                const razorpayCredentials = require('./razorpay-credentials');
                                console.warn('[razorpay] order create failed:', {
                                    mode: resolved.mode,
                                    keyPrefix: razorpayCredentials.keyIdPrefix(resolved.config.key_id),
                                    message: razorpayErrorMessage(rzErr, 'Razorpay order failed')
                                });
                                return cb(null, { error: razorpayErrorMessage(rzErr, 'Razorpay order failed') });
                            }
                            const gwTag =
                                usedOpt.mode === 'live'
                                    ? 'razorpay_live'
                                    : usedOpt.mode === 'test'
                                      ? 'razorpay_test'
                                      : 'razorpay';
                            if (source === 'env') {
                                console.log('[razorpay] doctor payment using env keys after DB auth failure');
                            }
                            db.run(
                                `UPDATE orders SET amount = ?, payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                [amount, gwTag, rzOrder.id, orderRow.id],
                                (uErr) => {
                                    if (uErr) return cb(uErr);
                                    finishInit({
                                        paymentType: 'razorpay_checkout',
                                        gateway: 'razorpay',
                                        mode: usedOpt.mode,
                                        keyId: usedOpt.config.key_id,
                                        razorpayOrder: rzOrder,
                                        pollRequired: true,
                                        message: 'Razorpay checkout ready. Complete payment in the popup or doctor portal.'
                                    });
                                }
                            );
                        }
                    );
                }

                cb(null, { error: `${resolved.label} is not available. Check gateway keys in Admin → Payment Gateways.` });
            });
        });
    });
}

function pollHostedGatewayOrder(db, deps, row, gw, cb) {
    const gateway = [...hostedCheckout.HOSTED_GATEWAYS].find((g) => gw.startsWith(g));
    if (!gateway || !row.provider_order_id) {
        return cb(null, { paid: false, status: 'pending' });
    }
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine } = deps;
    db.all(`SELECT * FROM payment_gateways WHERE is_active = 1`, [], (eG, gwRows) => {
        if (eG) return cb(eG);
        const resolved = (gwRows || [])
            .flatMap((r) => paymentGatewayOptions.expandGatewayRow(r))
            .find((o) => o.gateway === gateway && gw.includes(o.mode));
        if (!resolved) return cb(null, { error: hostedCheckout.LABELS[gateway] + ' not configured' });
        db.get(`SELECT email, phone FROM users WHERE id = ?`, [row.user_id], (eu, user) => {
            if (eu) return cb(eu);
            hostedCheckout.pollGateway(
                gateway,
                resolved.config,
                row,
                user,
                (trErr, tr) => {
                    if (trErr) return cb(trErr);
                    if (!tr || !tr.paid) {
                        return cb(null, {
                            paid: false,
                            status: 'pending',
                            message: (hostedCheckout.LABELS[gateway] || gateway) + ' payment not completed yet.'
                        });
                    }
                    const txnId =
                        tr.easepayId ||
                        tr.paymentId ||
                        tr.providerRef ||
                        'PG_' + row.provider_order_id;
                    fulfillRegistrationPayment(
                        row.registration_id,
                        row.user_id,
                        row.amount,
                        gw,
                        txnId,
                        (fErr, meta) => {
                            if (fErr) return cb(fErr);
                            notifyAfterRegistrationPaid(
                                db,
                                notifEngine,
                                notifyTicketIssued,
                                row,
                                meta,
                                null,
                                deps.portalTracking
                            );
                            cb(null, {
                                paid: true,
                                status: 'success',
                                ticketId: meta && meta.ticketId,
                                message:
                                    (hostedCheckout.LABELS[gateway] || gateway) +
                                    ' payment received. E-ticket issued on the doctor dashboard.'
                            });
                        }
                    );
                }
            );
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
                                notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta, {
                                    order_id: row.order_id_string
                                }, deps.portalTracking);
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
                                notifyAfterRegistrationPaid(
                                    db,
                                    notifEngine,
                                    notifyTicketIssued,
                                    row,
                                    meta,
                                    null,
                                    deps.portalTracking
                                );
                                cb(null, {
                                    paid: true,
                                    status: 'success',
                                    ticketId: meta && meta.ticketId,
                                    message: 'Razorpay payment captured. E-ticket issued on the doctor dashboard.'
                                });
                            }
                        );
                    });
                });
            }

            const hostedGw = [...hostedCheckout.HOSTED_GATEWAYS].find((g) => gw.startsWith(g));
            if (hostedGw && row.provider_order_id) {
                return pollHostedGatewayOrder(db, deps, row, gw, cb);
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

function processEasebuzzReturn(db, deps, payload, cb) {
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine, portalTracking } = deps;
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
                        notifyAfterRegistrationPaid(
                            db,
                            notifEngine,
                            notifyTicketIssued,
                            row,
                            meta,
                            null,
                            portalTracking
                        );
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
    const { fulfillRegistrationPayment, notifyTicketIssued, notifEngine, portalTracking } = deps;
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
                    notifyAfterRegistrationPaid(
                        db,
                        notifEngine,
                        notifyTicketIssued,
                        row,
                        meta,
                        { confirmed_by_admin: adminUserId },
                        portalTracking
                    );
                    cb(null, {
                        paid: true,
                        message: 'Payment recorded. E-ticket issued on the doctor dashboard.',
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
    razorpayAuthHelpMessage,
    validateRazorpayCredentials,
    validateSavedRazorpayConfig,
    createRazorpayOrder,
    initiateAdminPayment,
    prepareApplicationPaymentLink,
    pollAdminPaymentOrder,
    markUpiStaticPaid,
    processEasebuzzReturn,
    buildUpiPayString,
    pickRazorpayGateway,
    createRazorpayDqr,
    isAdminConfirmableGateway,
    MANUAL_CHECKOUT_GATEWAYS,
    notifyAfterRegistrationPaid
};

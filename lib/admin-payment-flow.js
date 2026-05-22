/**
 * Admin-initiated payments: method catalog, DQR (Razorpay / UPI), polling, fulfillment.
 */
const Razorpay = require('razorpay');
const paymentGatewayOptions = require('./payment-gateway-options');
const easebuzzGateway = require('./easebuzz-gateway');
const hostedCheckout = require('./hosted-checkout');

const MANUAL_CHECKOUT_GATEWAYS = new Set();

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
    easebuzz: 'Easebuzz — UPI, cards, netbanking via hosted Easebuzz checkout.',
    paytm: 'Paytm — UPI, cards, wallet via hosted Paytm checkout.',
    phonepe: 'PhonePe — UPI and cards via hosted PhonePe checkout.',
    cashfree: 'Cashfree — UPI, cards, netbanking via hosted Cashfree checkout.',
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

/** Doctor portal: DQR + enabled gateways (no cash, no mock). */
function buildDoctorPaymentMethods(rows, upiCfg) {
    return buildAdminPaymentMethods(rows, upiCfg).filter(
        (m) => m.id !== 'cash' && m.id !== 'mock' && m.available !== false
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

function notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta, extraVars) {
    if (!notifEngine || !row) return;
    const vars = Object.assign(
        { payment_amount: row.amount, payment_status: 'PAID' },
        extraVars || {}
    );
    notifEngine.notifyRegistrationPaid(db, {
        userId: row.user_id,
        seminarId: row.seminar_id,
        registrationId: row.registration_id,
        vars
    });
    if (meta && meta.ticketId && notifyTicketIssued) {
        notifyTicketIssued(row.user_id, row.registration_id, meta.ticketId, {
            email: true,
            whatsapp: false
        });
    }
}

function resolvePaymentAmount(reg, params) {
    const base = Number(reg.price) || 0;
    if (params && params.amount != null && params.amount !== '') {
        const a = Number(params.amount);
        if (!Number.isNaN(a) && a > 0) return Math.round(a * 100) / 100;
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
                        notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, reg, meta);
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
                            notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta);
                            cb(null, {
                                paid: true,
                                status: 'success',
                                ticketId: meta && meta.ticketId,
                                message:
                                    (hostedCheckout.LABELS[gateway] || gateway) +
                                    ' payment received. Doctor dashboard updated.'
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
                                });
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
                                notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta);
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
                        notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta);
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
                    notifyAfterRegistrationPaid(db, notifEngine, notifyTicketIssued, row, meta, {
                        confirmed_by_admin: adminUserId
                    });
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
    buildUpiPayString,
    pickRazorpayGateway,
    isAdminConfirmableGateway,
    MANUAL_CHECKOUT_GATEWAYS,
    notifyAfterRegistrationPaid
};

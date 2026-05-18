/**
 * Admin-initiated payments: method catalog, DQR (Razorpay / UPI), polling, fulfillment.
 */
const Razorpay = require('razorpay');
const paymentGatewayOptions = require('./payment-gateway-options');

const GATEWAY_DESCRIPTIONS = {
    razorpay:
        'Razorpay Checkout — card, UPI apps, netbanking. Opens hosted checkout; doctor can also pay from their portal.',
    payu: 'PayU — record payment in PayU dashboard; automatic capture pending full API integration.',
    easebuzz: 'Easebuzz — manual settlement in Easebuzz dashboard until API integration is completed.',
    paytm: 'Paytm — manual settlement in Paytm dashboard until API integration is completed.',
    phonepe: 'PhonePe — manual settlement in PhonePe dashboard until API integration is completed.',
    cashfree: 'Cashfree — refunds supported; checkout DQR via Cashfree API pending integration.',
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
        methods.push({
            id: o.id,
            type: gw === 'razorpay' ? 'razorpay_checkout' : 'manual_gateway',
            label: o.label,
            description: desc,
            available: gw === 'razorpay',
            gateway: gw,
            mode: o.mode,
            autoConfirm: gw === 'razorpay'
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

function buildUpiPayString(vpa, payeeName, amountRupee, note) {
    const params = new URLSearchParams();
    params.set('pa', vpa);
    params.set('pn', payeeName || 'Seminar');
    params.set('am', String(Number(amountRupee).toFixed(2)));
    params.set('cu', 'INR');
    if (note) params.set('tn', String(note).slice(0, 80));
    return 'upi://pay?' + params.toString();
}

function createRazorpayDqr(gatewayOpt, { amountRupee, orderIdStr, applicationNo }, cb) {
    const rz = new Razorpay({
        key_id: gatewayOpt.config.key_id,
        key_secret: gatewayOpt.config.key_secret
    });
    const amountPaise = Math.round(Number(amountRupee) * 100);
    if (amountPaise < 100) return cb(new Error('Amount must be at least ₹1'));

    rz.qrCode.create(
        {
            type: 'upi_qr',
            name: 'Seminar fee',
            usage: 'single_use',
            fixed_amount: true,
            payment_amount: amountPaise,
            description: `App ${applicationNo || orderIdStr}`.slice(0, 40),
            notes: {
                order_ref: orderIdStr,
                application_no: applicationNo || ''
            }
        },
        (err, qr) => {
            if (err) return cb(err);
            cb(null, {
                qrId: qr.id,
                imageUrl: qr.image_url,
                shortUrl: qr.short_url,
                gatewayTag: gatewayOpt.mode === 'live' ? 'dqr_razorpay_live' : 'dqr_razorpay_test'
            });
        }
    );
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

function initiateAdminPayment(db, deps, params, cb) {
    const {
        registrationId,
        methodId,
        adminUserId,
        getOrCreatePendingOrder,
        fulfillRegistrationPayment,
        portalTracking,
        notifEngine,
        notifyTicketIssued
    } = deps;
    const mid = String(methodId || '').trim();
    if (!mid) return cb(null, { error: 'methodId required' });

    approveRegistrationForPayment(db, registrationId, portalTracking, notifEngine, (e0, ctx) => {
        if (e0) return cb(e0);
        if (ctx && ctx.error) return cb(null, ctx);
        const { reg, amount } = ctx;

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

                cb(null, {
                    error: `${resolved.label} checkout is not automated yet. Use DQR or Razorpay, or waive the fee.`
                });
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

            cb(null, { paid: false, status: row.status || 'pending', manualConfirm: gw === 'dqr_upi_static' });
        }
    );
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
            if (String(row.payment_gateway) !== 'dqr_upi_static') {
                return cb(null, { error: 'Not a static UPI DQR order.' });
            }
            fulfillRegistrationPayment(
                row.registration_id,
                row.user_id,
                row.amount,
                'dqr_upi_static',
                'UPI_' + Date.now(),
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
                        message: 'UPI payment recorded. Doctor dashboard updated.',
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
    initiateAdminPayment,
    pollAdminPaymentOrder,
    markUpiStaticPaid,
    buildUpiPayString
};

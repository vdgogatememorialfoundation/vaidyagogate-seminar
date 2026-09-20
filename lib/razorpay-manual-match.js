'use strict';
/**
 * Admin: match a Razorpay payment (pay_xxx) that the site never recorded
 * (missed callback / closed browser) to a registration, then fulfil it
 * exactly like a verified checkout would.
 */
const Razorpay = require('razorpay');
const pgOpts = require('./payment-gateway-options');
const adminPaymentFlow = require('./admin-payment-flow');
const activityLog = require('./activity-log');

const PAY_ID_RE = /^pay_[A-Za-z0-9]{10,}$/;

function normalizePaymentId(raw) {
    const s = String(raw || '').trim();
    return PAY_ID_RE.test(s) ? s : '';
}

function loadCredentials(db, cb) {
    pgOpts.loadGatewayCredentials(db, 'razorpay', (err, opt) => {
        if (err) return cb(err);
        if (!opt || !opt.config || !opt.config.key_id || !opt.config.key_secret) {
            return cb(null, null);
        }
        cb(null, { key_id: opt.config.key_id, key_secret: opt.config.key_secret, mode: opt.mode || opt.config.mode });
    });
}

function summarizePayment(p) {
    return {
        id: p.id,
        orderId: p.order_id || null,
        amount: Math.round(Number(p.amount) || 0) / 100,
        currency: p.currency || 'INR',
        status: p.status || '',
        method: p.method || '',
        email: p.email || '',
        contact: p.contact || '',
        description: p.description || '',
        notes: p.notes || {},
        createdAt: p.created_at ? new Date(Number(p.created_at) * 1000).toISOString() : null,
        captured: p.status === 'captured',
        refundedAmount: Math.round(Number(p.amount_refunded) || 0) / 100
    };
}

function fetchPayment(db, paymentId, cb) {
    loadCredentials(db, (err, creds) => {
        if (err) return cb(err);
        if (!creds) return cb(null, { ok: false, error: 'Razorpay is not configured.' });
        const rz = new Razorpay({ key_id: creds.key_id, key_secret: creds.key_secret });
        rz.payments.fetch(paymentId, (fErr, payment) => {
            if (fErr) {
                const msg = (fErr.error && fErr.error.description) || fErr.message || 'Razorpay fetch failed';
                return cb(null, { ok: false, error: msg });
            }
            cb(null, { ok: true, payment, rz });
        });
    });
}

function digitsOnly(s) {
    return String(s || '').replace(/\D+/g, '');
}

/** Registration already holding this payment id, if any. */
function findExistingMatch(db, paymentId, cb) {
    db.get(
        `SELECT o.id AS order_id, o.registration_id, r.application_no, r.status, r.seminar_id, s.title AS seminar_title,
                u.first_name, u.last_name, u.email
         FROM orders o
         JOIN registrations r ON r.id = o.registration_id
         JOIN seminars s ON s.id = r.seminar_id
         JOIN users u ON u.id = r.user_id
         WHERE o.provider_transaction_id = ?
         ORDER BY o.id DESC LIMIT 1`,
        [paymentId],
        cb
    );
}

const REG_SELECT = `SELECT r.id AS registration_id, r.application_no, r.status, r.seminar_id, r.created_at,
                s.title AS seminar_title, s.price AS seminar_price,
                u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, u.user_id_string,
                (SELECT o.id FROM orders o WHERE o.registration_id = r.id AND LOWER(TRIM(o.status)) = 'success' ORDER BY o.id DESC LIMIT 1) AS paid_order_id,
                (SELECT o.amount FROM orders o WHERE o.registration_id = r.id ORDER BY o.id DESC LIMIT 1) AS last_order_amount
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         JOIN users u ON u.id = r.user_id`;

function shapeReg(row) {
    return {
        registrationId: row.registration_id,
        applicationNo: row.application_no,
        status: row.status,
        seminarId: row.seminar_id,
        seminarTitle: row.seminar_title,
        seminarPrice: row.seminar_price != null ? Number(row.seminar_price) : null,
        lastOrderAmount: row.last_order_amount != null ? Number(row.last_order_amount) : null,
        userId: row.user_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
        email: row.email || '',
        phone: row.phone || '',
        userIdString: row.user_id_string || '',
        paid: !!row.paid_order_id,
        createdAt: row.created_at
    };
}

/** Registrations that plausibly belong to this payment: same Razorpay order, notes, email or phone. */
function suggestRegistrations(db, payment, cb) {
    const out = new Map();
    const push = (rows) => (rows || []).forEach((r) => out.set(r.registration_id, shapeReg(r)));
    const byOrder = (next) => {
        if (!payment.order_id) return next();
        db.all(
            REG_SELECT + ` JOIN orders po ON po.registration_id = r.id WHERE po.provider_order_id = ?`,
            [payment.order_id],
            (e, rows) => {
                if (!e) push(rows);
                next();
            }
        );
    };
    const byNotes = (next) => {
        const n = payment.notes || {};
        const regId = parseInt(n.registrationId || n.registration_id || n.applicationId || '', 10);
        if (!regId) return next();
        db.all(REG_SELECT + ` WHERE r.id = ?`, [regId], (e, rows) => {
            if (!e) push(rows);
            next();
        });
    };
    const byContact = (next) => {
        const email = String(payment.email || '').trim().toLowerCase();
        const phone = digitsOnly(payment.contact).slice(-10);
        if (!email && !phone) return next();
        const conds = [];
        const params = [];
        if (email) {
            conds.push('LOWER(TRIM(u.email)) = ?');
            params.push(email);
        }
        if (phone.length === 10) {
            conds.push(`COALESCE(u.phone, '') LIKE ?`);
            params.push('%' + phone);
        }
        db.all(
            REG_SELECT + ` WHERE (${conds.join(' OR ')}) ORDER BY r.id DESC LIMIT 20`,
            params,
            (e, rows) => {
                if (!e) push(rows);
                next();
            }
        );
    };
    byOrder(() => byNotes(() => byContact(() => cb(null, Array.from(out.values())))));
}

/** Admin free-text registration search: application no, email, phone, user id, or name. */
function searchRegistrations(db, q, cb) {
    const s = String(q || '').trim();
    if (!s) return cb(null, []);
    const digits = digitsOnly(s);
    const like = '%' + s.toLowerCase() + '%';
    const conds = [
        `LOWER(TRIM(u.email)) LIKE ?`,
        `LOWER(u.user_id_string) = ?`,
        `LOWER(u.first_name || ' ' || COALESCE(u.last_name, '')) LIKE ?`
    ];
    const params = [like, s.toLowerCase(), like];
    if (digits) {
        conds.push(`COALESCE(r.application_no, '') LIKE ?`);
        params.push('%' + digits + '%');
        if (digits.length >= 6) {
            conds.push(`COALESCE(u.phone, '') LIKE ?`);
            params.push('%' + digits + '%');
        }
    }
    db.all(
        REG_SELECT + ` WHERE (${conds.join(' OR ')}) ORDER BY r.id DESC LIMIT 30`,
        params,
        (e, rows) => (e ? cb(e) : cb(null, (rows || []).map(shapeReg)))
    );
}

function lookup(db, paymentId, cb) {
    const pid = normalizePaymentId(paymentId);
    if (!pid) return cb(null, { ok: false, error: 'Enter a Razorpay payment id like pay_XXXXXXXXXXXXXX.' });
    fetchPayment(db, pid, (err, got) => {
        if (err) return cb(err);
        if (!got.ok) return cb(null, got);
        const payment = summarizePayment(got.payment);
        findExistingMatch(db, pid, (e2, existing) => {
            if (e2) return cb(e2);
            suggestRegistrations(db, got.payment, (e3, suggestions) => {
                if (e3) return cb(e3);
                cb(null, {
                    ok: true,
                    payment,
                    alreadyMatched: existing
                        ? {
                              registrationId: existing.registration_id,
                              applicationNo: existing.application_no,
                              status: existing.status,
                              seminarTitle: existing.seminar_title,
                              name: [existing.first_name, existing.last_name].filter(Boolean).join(' ').trim(),
                              email: existing.email
                          }
                        : null,
                    suggestions
                });
            });
        });
    });
}

function capturePayment(rz, payment, cb) {
    rz.payments.capture(payment.id, payment.amount, payment.currency || 'INR', (err, captured) => {
        if (err) {
            const msg = (err.error && err.error.description) || err.message || 'Capture failed';
            return cb(null, { ok: false, error: msg });
        }
        cb(null, { ok: true, payment: captured });
    });
}

/**
 * Verify the payment with Razorpay, then mark the registration paid and issue tickets.
 * deps: { fulfillRegistrationPayment, notifEngine, notifyTicketIssued, portalTracking }
 */
function match(db, deps, opts, cb) {
    const pid = normalizePaymentId(opts.paymentId);
    const registrationId = parseInt(opts.registrationId, 10);
    const actingAdminId = parseInt(opts.actingAdminId, 10);
    if (!pid) return cb(null, { ok: false, error: 'Invalid Razorpay payment id.' });
    if (!registrationId) return cb(null, { ok: false, error: 'registrationId required.' });

    fetchPayment(db, pid, (err, got) => {
        if (err) return cb(err);
        if (!got.ok) return cb(null, got);

        const ensureCaptured = (next) => {
            const p = got.payment;
            if (p.status === 'captured') return next(null, p);
            if (p.status === 'authorized') {
                return capturePayment(got.rz, p, (cErr, out) => {
                    if (cErr) return next(cErr);
                    if (!out.ok) return next(null, null, 'Payment is authorized but not captured: ' + out.error);
                    next(null, out.payment);
                });
            }
            next(null, null, `Payment status is "${p.status}" — only captured payments can be matched.`);
        };

        ensureCaptured((cErr, payment, blockMsg) => {
            if (cErr) return cb(cErr);
            if (!payment) return cb(null, { ok: false, error: blockMsg });

            findExistingMatch(db, pid, (e2, existing) => {
                if (e2) return cb(e2);
                if (existing && Number(existing.registration_id) !== registrationId) {
                    return cb(null, {
                        ok: false,
                        error: `This payment is already matched to application ${existing.application_no} (${existing.seminar_title}).`
                    });
                }
                db.get(REG_SELECT + ` WHERE r.id = ?`, [registrationId], (e3, regRow) => {
                    if (e3) return cb(e3);
                    if (!regRow) return cb(null, { ok: false, error: 'Registration not found.' });
                    const st = String(regRow.status || '').toLowerCase();
                    if (st === 'cancelled' || st === 'rejected') {
                        return cb(null, { ok: false, error: `Registration is ${st}; cannot match a payment to it.` });
                    }
                    if (regRow.paid_order_id && !existing) {
                        return cb(null, {
                            ok: false,
                            error: 'This registration already has a successful payment. Refund the duplicate in Razorpay instead.'
                        });
                    }
                    const amount = Math.round(Number(payment.amount) || 0) / 100;
                    const gwTag = 'razorpay_manual';
                    deps.fulfillRegistrationPayment(
                        registrationId,
                        regRow.user_id,
                        amount,
                        gwTag,
                        pid,
                        (fErr, meta) => {
                            if (fErr) return cb(fErr);
                            db.run(
                                `UPDATE orders SET provider_order_id = COALESCE(NULLIF(provider_order_id, ''), ?),
                                        provider_transaction_id = COALESCE(NULLIF(provider_transaction_id, ''), ?)
                                 WHERE id = ?`,
                                [payment.order_id || null, pid, meta && meta.orderId],
                                () => {
                                    activityLog.logActivity(db, {
                                        user_id: actingAdminId || null,
                                        action: 'payment.manual_match',
                                        resource_type: 'registration',
                                        resource_id: String(registrationId),
                                        meta: { razorpay_payment_id: pid, razorpay_order_id: payment.order_id || null, amount }
                                    });
                                    if (!(meta && meta.alreadyPaid)) {
                                        adminPaymentFlow.notifyAfterRegistrationPaid(
                                            db,
                                            deps.notifEngine,
                                            deps.notifyTicketIssued,
                                            {
                                                user_id: regRow.user_id,
                                                seminar_id: regRow.seminar_id,
                                                registration_id: registrationId,
                                                amount
                                            },
                                            meta,
                                            {
                                                invoice_url: deps.notifEngine
                                                    ? deps.notifEngine.publicBaseUrl() + '/doctor#tab-orders'
                                                    : ''
                                            },
                                            deps.portalTracking
                                        );
                                    }
                                    cb(null, {
                                        ok: true,
                                        alreadyPaid: !!(meta && meta.alreadyPaid),
                                        ticketId: meta && meta.ticketId,
                                        amount,
                                        payment: summarizePayment(payment),
                                        registration: shapeReg(regRow)
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });
    });
}

module.exports = { lookup, match, searchRegistrations, normalizePaymentId };

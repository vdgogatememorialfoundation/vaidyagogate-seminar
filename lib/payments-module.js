/**
 * Payments admin: refunds, fee waiver, cancellation requests (IST policy).
 */
const refundLib = require('./refunds');
const cancelPolicy = require('./cancellation-policy');
const seminarDt = require('./seminar-datetime');
const pgOpts = require('./payment-gateway-options');

const CANCELLATION_REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

function ensurePaymentsModuleSchema(db, ignoreErr, next) {
    const steps = [
        `CREATE TABLE IF NOT EXISTS cancellation_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            registration_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            refund_percent INTEGER DEFAULT 0,
            refund_amount REAL DEFAULT 0,
            refund_status TEXT DEFAULT 'none',
            provider_refund_id TEXT,
            admin_notes TEXT,
            reviewed_by INTEGER,
            reviewed_at DATETIME,
            requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            policy_snapshot TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_cancel_req_reg ON cancellation_requests (registration_id)`,
        `CREATE INDEX IF NOT EXISTS idx_cancel_req_status ON cancellation_requests (status)`,
        `ALTER TABLE orders ADD COLUMN refund_status TEXT`,
        `ALTER TABLE orders ADD COLUMN refunded_amount REAL DEFAULT 0`
    ];
    let i = 0;
    const run = () => {
        if (i >= steps.length) return next && next();
        db.run(steps[i], (e) => {
            ignoreErr(e);
            i++;
            run();
        });
    };
    run();
}

function pgCancellationRequestsDdl() {
    return `CREATE TABLE IF NOT EXISTS cancellation_requests (
        id SERIAL PRIMARY KEY,
        registration_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        refund_percent INTEGER DEFAULT 0,
        refund_amount REAL DEFAULT 0,
        refund_status TEXT DEFAULT 'none',
        provider_refund_id TEXT,
        admin_notes TEXT,
        reviewed_by INTEGER,
        reviewed_at TIMESTAMPTZ,
        requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        policy_snapshot TEXT
    )`;
}

function nowIstLabel() {
    return seminarDt.formatSeminarDateTime(new Date().toISOString(), {
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

function loadRegistrationPaymentContext(db, registrationId, cb) {
    db.get(
        `SELECT r.id, r.user_id, r.status, r.application_no, r.seminar_id,
                s.title AS seminar_title, s.event_date, s.price, s.cancellation_policy_json
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [registrationId],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(null, null);
            db.get(
                `SELECT * FROM orders WHERE registration_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
                [registrationId],
                (e2, order) => {
                    if (e2) return cb(e2);
                    cb(null, { registration: reg, order: order || null });
                }
            );
        }
    );
}

function computeRefundForContext(policyJson, eventDate, orderAmount) {
    let policy = {};
    try {
        policy = policyJson ? JSON.parse(policyJson) : {};
    } catch (_) {
        policy = {};
    }
    const calc = refundLib.computeRefundPercent(policy, eventDate);
    const amt = Number(orderAmount) || 0;
    const refundAmount = amt > 0 ? Math.round((amt * calc.percent) / 100 * 100) / 100 : 0;
    return {
        percent: calc.percent,
        eligible: calc.eligible,
        reason: calc.reason,
        refundAmount,
        evaluatedAtIst: nowIstLabel()
    };
}

function resolveGatewayFromOrder(order) {
    const gw = String((order && order.payment_gateway) || '').toLowerCase();
    if (gw.startsWith('razorpay')) return 'razorpay';
    if (gw.startsWith('cashfree')) return 'cashfree';
    if (gw.startsWith('payu')) return 'payu';
    if (gw.startsWith('easebuzz')) return 'easebuzz';
    if (gw.startsWith('paytm')) return 'paytm';
    if (gw.startsWith('phonepe')) return 'phonepe';
    return gw || 'mock';
}

function loadGatewayCredentials(db, gatewayName, cb) {
    db.get(`SELECT name, config, is_active FROM payment_gateways WHERE name = ?`, [gatewayName], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        let config = {};
        try {
            config = row.config ? JSON.parse(row.config) : {};
        } catch (_) {
            config = {};
        }
        const options = pgOpts.expandGatewayRow({ name: row.name, config: JSON.stringify(config), is_active: row.is_active });
        cb(null, options[0] || null);
    });
}

function executeGatewayRefundWithDb(db, order, amountRupees, cb) {
    const gatewayName = resolveGatewayFromOrder(order);
    const payId = order.provider_transaction_id || order.provider_order_id;
    const orderAmt = Number(order.amount) || 0;
    const refundAmt = Math.min(Number(amountRupees) || orderAmt, orderAmt);
    if (refundAmt <= 0) return cb(null, { ok: true, refundId: null, gateway: gatewayName, skipped: true });
    if (gatewayName === 'mock') {
        return cb(null, { ok: true, refundId: 'MOCK_' + Date.now(), gateway: 'mock' });
    }
    if (!payId) return cb(null, { ok: false, error: 'Missing provider transaction id on order.' });

    loadGatewayCredentials(db, gatewayName, async (err, opt) => {
        if (err) return cb(err);
        if (!opt || !opt.config) {
            return cb(null, {
                ok: false,
                error: `Gateway ${gatewayName} is not configured for automated refund. Process manually in the provider dashboard.`
            });
        }
        if (gatewayName === 'razorpay') {
            const r = await refundLib.refundRazorpay({
                keyId: opt.config.key_id,
                keySecret: opt.config.key_secret,
                paymentId: payId,
                amountRupees: refundAmt
            });
            return cb(null, { ...r, gateway: 'razorpay', amount: refundAmt });
        }
        if (gatewayName === 'cashfree') {
            const r = await refundLib.refundCashfree({
                clientId: opt.config.client_id || opt.config.app_id,
                clientSecret: opt.config.client_secret || opt.config.secret_key,
                apiVersion: opt.config.api_version,
                paymentId: payId,
                amountRupees: refundAmt,
                orderId: order.provider_order_id
            });
            return cb(null, { ...r, gateway: 'cashfree', amount: refundAmt });
        }
        cb(null, {
            ok: false,
            error: `Automated refund for ${gatewayName} is not wired yet. Use the provider dashboard or mark as manual refund.`,
            gateway: gatewayName,
            manualRequired: true
        });
    });
}

function recordRefund(db, { orderId, registrationId, amount, percent, gateway, providerRefundId, status, raw }, cb) {
    db.run(
        `INSERT INTO refunds (order_id, registration_id, amount, percent, gateway, provider_refund_id, status, raw_response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            orderId,
            registrationId,
            amount,
            percent,
            gateway,
            providerRefundId || null,
            status || 'completed',
            raw ? JSON.stringify(raw).slice(0, 4000) : null
        ],
        function (insErr) {
            if (insErr) return cb(insErr);
            const refunded = Number(amount) || 0;
            const orderStatus = refunded >= 0 ? 'refunded' : 'success';
            db.run(
                `UPDATE orders SET refund_status = ?, refunded_amount = COALESCE(refunded_amount, 0) + ? WHERE id = ?`,
                [orderStatus, refunded, orderId],
                (uErr) => cb(uErr, { refundRowId: this.lastID })
            );
        }
    );
}

function processOrderRefund(db, { orderId, amountRupees, percent, reason, adminUserId }, cb) {
    db.get(`SELECT o.*, r.id AS registration_id FROM orders o JOIN registrations r ON r.id = o.registration_id WHERE o.id = ?`, [orderId], (err, order) => {
        if (err) return cb(err);
        if (!order) return cb(null, { ok: false, error: 'Order not found' });
        if (order.status !== 'success') return cb(null, { ok: false, error: 'Only successful orders can be refunded.' });
        const orderAmt = Number(order.amount) || 0;
        const already = Number(order.refunded_amount) || 0;
        const maxRefundable = Math.max(0, orderAmt - already);
        let refundAmt = amountRupees != null && amountRupees !== '' ? Number(amountRupees) : maxRefundable;
        if (Number.isNaN(refundAmt) || refundAmt <= 0) refundAmt = maxRefundable;
        if (refundAmt > maxRefundable) {
            return cb(null, { ok: false, error: `Max refundable is ₹${maxRefundable}` });
        }
        const pct = percent != null ? Number(percent) : orderAmt ? Math.round((refundAmt / orderAmt) * 100) : 100;

        executeGatewayRefundWithDb(db, order, refundAmt, (gErr, gw) => {
            if (gErr) return cb(gErr);
            if (!gw || (!gw.ok && !gw.manualRequired)) {
                return cb(null, { ok: false, error: (gw && gw.error) || 'Refund failed' });
            }
            const st = gw.manualRequired ? 'manual_pending' : gw.ok ? 'completed' : 'failed';
            recordRefund(
                db,
                {
                    orderId: order.id,
                    registrationId: order.registration_id,
                    amount: refundAmt,
                    percent: pct,
                    gateway: gw.gateway || resolveGatewayFromOrder(order),
                    providerRefundId: gw.refundId,
                    status: st,
                    raw: gw.raw || gw
                },
                (rErr) => {
                    if (rErr) return cb(rErr);
                    if (adminUserId) {
                        require('./activity-log').logActivity(db, {
                            user_id: adminUserId,
                            action: 'payment.refund',
                            resource_type: 'order',
                            resource_id: String(orderId),
                            meta: { amount: refundAmt, reason: reason || '', gateway: gw.gateway }
                        });
                    }
                    cb(null, {
                        ok: true,
                        refundAmount: refundAmt,
                        refundPercent: pct,
                        providerRefundId: gw.refundId,
                        manualRequired: !!gw.manualRequired,
                        message: gw.manualRequired
                            ? 'Refund recorded as manual — complete in payment gateway dashboard.'
                            : `Refund of ₹${refundAmt} initiated.`
                    });
                }
            );
        });
    });
}

module.exports = {
    CANCELLATION_REQUEST_STATUSES,
    ensurePaymentsModuleSchema,
    pgCancellationRequestsDdl,
    nowIstLabel,
    loadRegistrationPaymentContext,
    computeRefundForContext,
    resolveGatewayFromOrder,
    executeGatewayRefundWithDb,
    recordRefund,
    processOrderRefund,
    cancelPolicy,
    refundLib
};

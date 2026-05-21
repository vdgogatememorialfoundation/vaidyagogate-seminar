/**
 * Additional / supplemental payments (not tied to seminar registration fee).
 */
const { resolveInternalUserId, doctorNotFoundMessage, safeInternalUserRowId } = require('./internal-user-id');

function genOrderId() {
    return 'SUP' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function registerSupplementalPaymentRoutes(app, db, deps) {
    const { fileStore, adminPaymentFlow, finishDoctorPayment, listDoctorPaymentOptions, parsePositiveUserId } = deps;

    app.get('/api/doctor/supplemental-payments', (req, res) => {
        const uid = parsePositiveUserId ? parsePositiveUserId(req.query.userId) : safeInternalUserRowId(req.query.userId);
        if (!uid) return res.status(400).json({ error: 'Invalid user' });
        db.all(
            `SELECT sp.*, s.title AS seminar_title, o.order_id_string, o.status AS order_status, o.payment_date
             FROM supplemental_payments sp
             LEFT JOIN seminars s ON s.id = sp.seminar_id
             LEFT JOIN orders o ON o.id = sp.order_id
             WHERE sp.user_id = ?
             ORDER BY sp.id DESC`,
            [uid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/admin/supplemental-payments', (req, res) => {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
        db.all(
            `SELECT sp.*, u.first_name, u.last_name, u.email, u.user_id_string, s.title AS seminar_title,
                    o.order_id_string, o.status AS order_status
             FROM supplemental_payments sp
             JOIN users u ON u.id = sp.user_id
             LEFT JOIN seminars s ON s.id = sp.seminar_id
             LEFT JOIN orders o ON o.id = sp.order_id
             ORDER BY sp.id DESC
             LIMIT ?`,
            [limit],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/admin/supplemental-payments', (req, res) => {
        const body = req.body || {};
        const amount = Number(body.amount);
        const title = String(body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'title required' });
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
        const seminarId = body.seminarId != null && body.seminarId !== '' ? parseInt(body.seminarId, 10) : null;
        const regId = body.registrationId != null && body.registrationId !== '' ? parseInt(body.registrationId, 10) : null;
        const adminId = safeInternalUserRowId(body.actingAdminId);
        resolveInternalUserId(db, body.userId, body.userIdString || body.userId, (e, userId) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!userId) {
                return res.status(404).json({ error: doctorNotFoundMessage(body.userIdString || body.userId) });
            }
            db.run(
                `INSERT INTO supplemental_payments (user_id, seminar_id, registration_id, title, description, amount, status, created_by_admin, admin_note)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [
                    userId,
                    Number.isInteger(seminarId) && seminarId > 0 ? seminarId : null,
                    Number.isInteger(regId) && regId > 0 ? regId : null,
                    title,
                    String(body.description || '').trim() || null,
                    amount,
                    adminId,
                    String(body.adminNote || '').trim() || null
                ],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, id: this.lastID });
                }
            );
        });
    });

    app.post('/api/admin/supplemental-payments/:id/mark-paid', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const method = String((req.body && req.body.method) || 'cash').trim();
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        db.get(`SELECT * FROM supplemental_payments WHERE id = ?`, [id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Not found' });
            if (String(row.status).toLowerCase() === 'paid') {
                return res.json({ success: true, message: 'Already paid' });
            }
            const orderStr = genOrderId();
            db.run(
                `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date, payment_gateway)
                 VALUES (?, NULL, ?, 'success', CURRENT_TIMESTAMP, ?)`,
                [orderStr, row.amount, method],
                function (oErr) {
                    if (oErr) return res.status(500).json({ error: oErr.message });
                    const orderId = this.lastID;
                    db.run(
                        `UPDATE supplemental_payments SET status = 'paid', order_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [orderId, id],
                        (uErr) => {
                            if (uErr) return res.status(500).json({ error: uErr.message });
                            res.json({ success: true, orderIdString: orderStr });
                        }
                    );
                }
            );
        });
    });

    app.delete('/api/admin/supplemental-payments/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        db.get(`SELECT * FROM supplemental_payments WHERE id = ?`, [id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Not found' });
            if (String(row.status).toLowerCase() === 'paid') {
                return res.status(400).json({ error: 'Cannot delete a paid charge' });
            }
            db.run(`DELETE FROM supplemental_payments WHERE id = ?`, [id], function (dErr) {
                if (dErr) return res.status(500).json({ error: dErr.message });
                res.json({ success: true, deleted: this.changes > 0 });
            });
        });
    });

    app.post('/api/payments/process-supplemental', (req, res) => {
        const supplementalId = parseInt(req.body && req.body.supplementalId, 10);
        const uid = parsePositiveUserId
            ? parsePositiveUserId(req.body && req.body.userId)
            : safeInternalUserRowId(req.body && req.body.userId);
        const mid = String((req.body && req.body.methodId) || '').trim();
        if (!Number.isInteger(supplementalId) || supplementalId < 1) {
            return res.status(400).json({ success: false, error: 'Invalid supplemental payment id' });
        }
        if (!uid) {
            return res.status(400).json({ success: false, error: 'Invalid user' });
        }
        db.get(`SELECT * FROM supplemental_payments WHERE id = ?`, [supplementalId], (e, sp) => {
            if (e) return res.status(500).json({ success: false, error: e.message });
            if (!sp) return res.status(404).json({ success: false, error: 'Charge not found' });
            if (Number(sp.user_id) !== uid) {
                return res.status(403).json({ success: false, error: 'This charge does not belong to your account.' });
            }
            if (String(sp.status).toLowerCase() === 'paid') {
                return res.status(400).json({ success: false, error: 'Already paid' });
            }
            const amount = Number(sp.amount);
            const orderStr = genOrderId();
            const markPaid = (orderDbId, gateway, txnId) => {
                db.run(
                    `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = ?, provider_transaction_id = ? WHERE id = ?`,
                    [gateway, txnId || null, orderDbId],
                    (uErr) => {
                        if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                        db.run(
                            `UPDATE supplemental_payments SET status = 'paid', order_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [orderDbId, supplementalId],
                            () => {
                                res.json({
                                    success: true,
                                    paid: true,
                                    message: 'Payment recorded.',
                                    orderIdString: orderStr,
                                    amount
                                });
                            }
                        );
                    }
                );
            };
            db.run(
                `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, 'pending')`,
                [orderStr, amount],
                function (insErr) {
                    if (insErr) return res.status(500).json({ success: false, error: insErr.message });
                    const orderDbId = this.lastID;
                    db.run(
                        `UPDATE supplemental_payments SET order_id = ? WHERE id = ?`,
                        [orderDbId, supplementalId],
                        () => {}
                    );
                    if (!mid || mid === 'mock') {
                        return markPaid(orderDbId, 'mock', 'MOCK_' + Date.now());
                    }
                    return res.status(400).json({
                        success: false,
                        error:
                            'Online payment for additional charges is recorded by admin. Use test/mock mode if enabled, or pay at the registration desk.',
                        orderIdString: orderStr,
                        amount
                    });
                }
            );
        });
    });
}

module.exports = {
    registerSupplementalPaymentRoutes
};

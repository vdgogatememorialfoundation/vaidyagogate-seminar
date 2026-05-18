/**
 * Payments module & cancellation request API routes.
 */
const paymentsMod = require('./payments-module');

function registerPaymentsRoutes(app, deps) {
    const {
        db,
        generateId,
        invalidateTicketsForRegistration,
        fulfillRegistrationPayment,
        insertParticipantTicket,
        notifEngine,
        activityLog,
        jobsModule
    } = deps;

    app.post('/api/doctor/cancellation-requests', (req, res) => {
        const userId = parseInt((req.body && req.body.userId) || '', 10);
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!userId || !registrationId) {
            return res.status(400).json({ error: 'userId and registrationId are required.' });
        }
        if (!reason || reason.length < 10) {
            return res.status(400).json({ error: 'Please describe your reason (at least 10 characters).' });
        }

        db.get(
            `SELECT r.id, r.user_id, r.status, r.application_no,
                    s.title AS seminar_title, s.event_date, s.cancellation_policy_json
             FROM registrations r
             JOIN seminars s ON s.id = r.seminar_id
             WHERE r.id = ?`,
            [registrationId],
            (err, reg) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!reg) return res.status(404).json({ error: 'Application not found.' });
                if (Number(reg.user_id) !== userId) {
                    return res.status(403).json({ error: 'Not your application.' });
                }
                const st = String(reg.status || '').toLowerCase();
                if (['cancelled', 'rejected'].includes(st)) {
                    return res.status(400).json({ error: 'This application is already closed.' });
                }
                const gate = paymentsMod.cancelPolicy.evaluateDoctorCancellation(
                    reg.cancellation_policy_json,
                    reg.event_date
                );
                if (!gate.allowed) {
                    return res.status(400).json({ error: gate.reason || 'Cancellation request not allowed.' });
                }

                db.get(
                    `SELECT id FROM cancellation_requests WHERE registration_id = ? AND status = 'pending'`,
                    [registrationId],
                    (e2, pending) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        if (pending) {
                            return res.status(400).json({ error: 'You already have a pending cancellation request for this application.' });
                        }

                        paymentsMod.loadRegistrationPaymentContext(db, registrationId, (e3, ctx) => {
                            if (e3) return res.status(500).json({ error: e3.message });
                            const refundPreview = paymentsMod.computeRefundForContext(
                                reg.cancellation_policy_json,
                                reg.event_date,
                                ctx && ctx.order ? ctx.order.amount : 0
                            );
                            const snapshot = JSON.stringify({
                                policy: reg.cancellation_policy_json,
                                evaluatedAtIst: refundPreview.evaluatedAtIst,
                                preview: refundPreview
                            });
                            db.run(
                                `INSERT INTO cancellation_requests (registration_id, user_id, reason, status, refund_percent, refund_amount, refund_status, policy_snapshot)
                                 VALUES (?, ?, ?, 'pending', ?, ?, 'none', ?)`,
                                [
                                    registrationId,
                                    userId,
                                    reason,
                                    refundPreview.percent,
                                    refundPreview.refundAmount,
                                    snapshot
                                ],
                                function (insErr) {
                                    if (insErr) return res.status(500).json({ error: insErr.message });
                                    activityLog.logFromRequest(db, req, {
                                        user_id: userId,
                                        action: 'cancellation.requested',
                                        resource_type: 'registration',
                                        resource_id: String(registrationId),
                                        meta: { application_no: reg.application_no }
                                    });
                                    res.json({
                                        success: true,
                                        requestId: this.lastID,
                                        message:
                                            'Cancellation request submitted. Our team will review it and process any eligible refund per the seminar policy (IST).',
                                        refundPreview: {
                                            percent: refundPreview.percent,
                                            amount: refundPreview.refundAmount,
                                            reason: refundPreview.reason,
                                            evaluatedAtIst: refundPreview.evaluatedAtIst
                                        }
                                    });
                                }
                            );
                        });
                    }
                );
            }
        );
    });

    app.get('/api/doctor/cancellation-requests', (req, res) => {
        const userId = parseInt(req.query.userId, 10);
        if (!userId) return res.status(400).json({ error: 'userId required' });
        db.all(
            `SELECT cr.*, r.application_no, s.title AS seminar_title
             FROM cancellation_requests cr
             JOIN registrations r ON r.id = cr.registration_id
             JOIN seminars s ON s.id = r.seminar_id
             WHERE cr.user_id = ?
             ORDER BY cr.id DESC`,
            [userId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/admin/cancellation-requests', (req, res) => {
        const status = req.query.status ? String(req.query.status).trim() : '';
        let sql = `SELECT cr.*, r.application_no, r.status AS registration_status,
                          s.title AS seminar_title, s.event_date,
                          u.first_name, u.last_name, u.email, u.phone, u.user_id_string,
                          o.id AS order_id, o.order_id_string, o.amount AS order_amount, o.payment_gateway,
                          o.provider_transaction_id, o.refund_status AS order_refund_status
                   FROM cancellation_requests cr
                   JOIN registrations r ON r.id = cr.registration_id
                   JOIN seminars s ON s.id = r.seminar_id
                   JOIN users u ON u.id = cr.user_id
                   LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
                   WHERE 1=1`;
        const params = [];
        if (status) {
            sql += ` AND cr.status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY cr.id DESC LIMIT 300`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/admin/cancellation-requests/:id/resolve', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const action = String((req.body && req.body.action) || '').toLowerCase();
        const adminNotes = (req.body && req.body.adminNotes) != null ? String(req.body.adminNotes).trim() : '';
        const processRefund = !!(req.body && req.body.processRefund);
        const customRefundAmount =
            req.body && req.body.refundAmount != null && req.body.refundAmount !== ''
                ? Number(req.body.refundAmount)
                : null;
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);

        if (!id || !['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'action must be approve or reject' });
        }

        db.get(`SELECT * FROM cancellation_requests WHERE id = ?`, [id], (err, reqRow) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!reqRow) return res.status(404).json({ error: 'Request not found' });
            if (reqRow.status !== 'pending') {
                return res.status(400).json({ error: 'Request already resolved.' });
            }

            if (action === 'reject') {
                return db.run(
                    `UPDATE cancellation_requests SET status = 'rejected', admin_notes = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [adminNotes || null, actingAdminId || null, id],
                    (uErr) => {
                        if (uErr) return res.status(500).json({ error: uErr.message });
                        res.json({ success: true, message: 'Cancellation request rejected.' });
                    }
                );
            }

            const registrationId = reqRow.registration_id;
            paymentsMod.loadRegistrationPaymentContext(db, registrationId, (e2, ctx) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const reg = ctx && ctx.registration;
                const order = ctx && ctx.order;
                const refundInfo = paymentsMod.computeRefundForContext(
                    reg.cancellation_policy_json,
                    reg.event_date,
                    order ? order.amount : 0
                );
                let refundAmt =
                    customRefundAmount != null && !Number.isNaN(customRefundAmount)
                        ? customRefundAmount
                        : Number(reqRow.refund_amount) || refundInfo.refundAmount;
                const refundPct = order && order.amount ? Math.round((refundAmt / Number(order.amount)) * 100) : refundInfo.percent;

                const finalizeApprove = (refundResult) => {
                    invalidateTicketsForRegistration(registrationId, (invErr) => {
                        if (invErr) return res.status(500).json({ error: invErr.message });
                        db.run(`UPDATE registrations SET status = 'cancelled' WHERE id = ?`, [registrationId], (cErr) => {
                            if (cErr) return res.status(500).json({ error: cErr.message });
                            db.run(
                                `UPDATE user_certificates SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE registration_id = ?`,
                                [registrationId],
                                () => {}
                            );
                            const refundStatus = refundResult && refundResult.ok ? 'completed' : refundResult && refundResult.manualRequired ? 'manual_pending' : 'none';
                            db.run(
                                `UPDATE cancellation_requests SET status = 'approved', admin_notes = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                                 refund_percent = ?, refund_amount = ?, refund_status = ?, provider_refund_id = ?
                                 WHERE id = ?`,
                                [
                                    adminNotes || null,
                                    actingAdminId || null,
                                    refundPct,
                                    refundAmt,
                                    refundStatus,
                                    (refundResult && refundResult.providerRefundId) || null,
                                    id
                                ],
                                (uErr) => {
                                    if (uErr) return res.status(500).json({ error: uErr.message });
                                    notifEngine.notify(db, 'REGISTRATION_CANCELLED', { userId: reqRow.user_id }, () => {});
                                    if (refundAmt > 0 && processRefund) {
                                        notifEngine.notify(db, 'REFUND_INITIATED', {
                                            userId: reqRow.user_id,
                                            vars: { refund_amount: String(refundAmt) }
                                        });
                                    }
                                    res.json({
                                        success: true,
                                        message: 'Application cancelled.',
                                        refund: refundResult || { skipped: true },
                                        refundAmount: refundAmt,
                                        refundPercent: refundPct
                                    });
                                }
                            );
                        });
                    });
                };

                if (order && processRefund && refundAmt > 0) {
                    paymentsMod.processOrderRefund(
                        db,
                        {
                            orderId: order.id,
                            amountRupees: refundAmt,
                            percent: refundPct,
                            reason: 'Cancellation request approved',
                            adminUserId: actingAdminId
                        },
                        (rErr, rOut) => {
                            if (rErr) return res.status(500).json({ error: rErr.message });
                            if (!rOut.ok) return res.status(400).json({ error: rOut.error });
                            finalizeApprove(rOut);
                        }
                    );
                } else {
                    finalizeApprove(null);
                }
            });
        });
    });

    app.post('/api/admin/payments/refund', (req, res) => {
        const orderId = parseInt((req.body && req.body.orderId) || '', 10);
        const amount = req.body && req.body.amount;
        const percent = req.body && req.body.percent;
        const reason = (req.body && req.body.reason) || '';
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!orderId) return res.status(400).json({ error: 'orderId required' });
        paymentsMod.processOrderRefund(
            db,
            { orderId, amountRupees: amount, percent, reason, adminUserId: actingAdminId },
            (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!out.ok) return res.status(400).json({ error: out.error });
                res.json({ success: true, ...out });
            }
        );
    });

    app.post('/api/admin/payments/waive-and-ticket', (req, res) => {
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        const note = String((req.body && req.body.note) || '').trim();
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!registrationId) return res.status(400).json({ error: 'registrationId required' });

        db.get(
            `SELECT r.id, r.user_id, r.application_no, r.status, s.price
             FROM registrations r
             JOIN seminars s ON s.id = r.seminar_id
             WHERE r.id = ?`,
            [registrationId],
            (err, reg) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!reg) return res.status(404).json({ error: 'Registration not found' });
                const amount = Number(reg.price) || 0;
                fulfillRegistrationPayment(registrationId, reg.user_id, amount, 'waived', 'WAIVE_' + generateId(), (fErr, meta) => {
                    if (fErr) return res.status(500).json({ error: fErr.message });
                    db.run(
                        `UPDATE registrations SET status = 'completed' WHERE id = ?`,
                        [registrationId],
                        () => {
                            activityLog.logActivity(db, {
                                user_id: actingAdminId || null,
                                action: 'payment.waived',
                                resource_type: 'registration',
                                resource_id: String(registrationId),
                                meta: { note, amount }
                            });
                            res.json({
                                success: true,
                                message: 'Fee waived and e-ticket issued (if eligible).',
                                ticketId: meta && meta.ticketId,
                                orderId: meta && meta.orderIdString
                            });
                        }
                    );
                });
            }
        );
    });

    app.get('/api/admin/payments/enriched-orders', (req, res) => {
        const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
        let sql = `SELECT o.id, o.order_id_string, o.amount, o.status, o.payment_date,
                          o.payment_gateway, o.provider_order_id, o.provider_transaction_id,
                          o.refund_status, o.refunded_amount,
                          r.id as registration_id, r.application_no, r.status as registration_status,
                          s.title as seminar_title, s.event_date,
                          u.id as user_id, u.first_name, u.last_name, u.user_id_string, u.email, u.phone,
                          t.ticket_id_string AS e_ticket_id,
                          (SELECT COUNT(*) FROM refunds rf WHERE rf.order_id = o.id) AS refund_count
                   FROM orders o
                   JOIN registrations r ON o.registration_id = r.id
                   JOIN users u ON r.user_id = u.id
                   LEFT JOIN seminars s ON r.seminar_id = s.id
                   LEFT JOIN tickets t ON t.order_id = o.id
                   WHERE 1=1`;
        const params = [];
        if (userId) {
            sql += ` AND u.id = ?`;
            params.push(userId);
        }
        sql += ` ORDER BY o.id DESC LIMIT 500`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/admin/payments/preview-refund', (req, res) => {
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        if (!registrationId) return res.status(400).json({ error: 'registrationId required' });
        paymentsMod.loadRegistrationPaymentContext(db, registrationId, (err, ctx) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ctx) return res.status(404).json({ error: 'Not found' });
            const info = paymentsMod.computeRefundForContext(
                ctx.registration.cancellation_policy_json,
                ctx.registration.event_date,
                ctx.order ? ctx.order.amount : 0
            );
            res.json({
                ...info,
                orderAmount: ctx.order ? ctx.order.amount : 0,
                gateway: ctx.order ? paymentsMod.resolveGatewayFromOrder(ctx.order) : null
            });
        });
    });
}

module.exports = { registerPaymentsRoutes };

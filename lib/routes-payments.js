/**
 * Payments module & cancellation request API routes.
 */
const paymentsMod = require('./payments-module');
const adminPaymentFlow = require('./admin-payment-flow');
const adminPaymentLookup = require('./admin-payment-lookup');
const integrationSettings = require('./integration-settings');
const hostedCheckout = require('./hosted-checkout');
const refundTracking = require('./refund-tracking');
const razorpayStandard = require('./razorpay-standard-checkout');
const razorpayRefundSync = require('./razorpay-refund-sync');

function registerPaymentsRoutes(app, deps) {
    const {
        db,
        generateId,
        invalidateTicketsForRegistration,
        fulfillRegistrationPayment,
        insertParticipantTicket,
        notifEngine,
        activityLog,
        jobsModule,
        getOrCreatePendingOrder,
        portalTracking,
        notifyTicketIssued,
        assertAdminPortalActor
    } = deps;

    const paymentDeps = {
        getOrCreatePendingOrder,
        fulfillRegistrationPayment,
        portalTracking,
        notifEngine,
        notifyTicketIssued,
        fulfillBookOrderPayment: deps.fulfillBookOrderPayment
    };

    razorpayStandard.registerRazorpayStandardRoutes(app, {
        db,
        getOrCreatePendingOrder,
        fulfillRegistrationPayment,
        notifEngine,
        notifyTicketIssued,
        portalTracking
    });

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
                            const insertCancelRequest = () => {
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
                                        if (insErr) {
                                            if (/no such table|does not exist/i.test(insErr.message)) {
                                                return paymentsMod.ensurePaymentsModuleSchema(db, () => {}, () =>
                                                    insertCancelRequest()
                                                );
                                            }
                                            return res.status(500).json({ error: insErr.message });
                                        }
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
                            };
                            insertCancelRequest();
                        });
                    }
                );
            }
        );
    });

    app.get('/api/doctor/cancellation-preview', (req, res) => {
        const userId = parseInt(req.query.userId, 10);
        const registrationId = parseInt(req.query.registrationId, 10);
        if (!userId || !registrationId) {
            return res.status(400).json({ error: 'userId and registrationId required' });
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
                paymentsMod.loadRegistrationPaymentContext(db, registrationId, (e2, ctx) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const orderAmt = ctx && ctx.order ? ctx.order.amount : 0;
                    const eligibility = refundTracking.buildRefundEligibilityView(
                        reg.cancellation_policy_json,
                        reg.event_date,
                        orderAmt
                    );
                    res.json({
                        success: true,
                        applicationNo: reg.application_no,
                        seminarTitle: reg.seminar_title,
                        eligibility
                    });
                });
            }
        );
    });

    app.get('/api/doctor/cancellation-requests', (req, res) => {
        const userId = parseInt(req.query.userId, 10);
        if (!userId) return res.status(400).json({ error: 'userId required' });
        db.all(
            `SELECT cr.*, r.application_no, r.status AS registration_status,
                    s.title AS seminar_title, s.event_date, s.cancellation_policy_json,
                    o.amount AS order_amount, o.refund_status AS order_refund_status, o.refunded_amount AS order_refunded_amount
             FROM cancellation_requests cr
             JOIN registrations r ON r.id = cr.registration_id
             JOIN seminars s ON s.id = r.seminar_id
             LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
             WHERE cr.user_id = ?
             ORDER BY cr.id DESC`,
            [userId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const list = rows || [];
                if (!list.length) return res.json([]);
                const regIds = list.map((r) => r.registration_id);
                refundTracking.loadRefundsForRegistrations(db, regIds, (e2, refundsByReg) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const out = list.map((row) => {
                        const refunds = refundsByReg[row.registration_id] || [];
                        const live = refundTracking.buildRefundEligibilityView(
                            row.cancellation_policy_json,
                            row.event_date,
                            row.order_amount
                        );
                        return refundTracking.mapCancellationRowForClient(row, refunds, live);
                    });
                    res.json(out);
                });
            }
        );
    });

    app.get('/api/admin/cancellation-requests', (req, res) => {
        const status = req.query.status ? String(req.query.status).trim() : '';
        const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
        let sql = `SELECT cr.*, r.application_no, r.status AS registration_status, r.form_data, r.doc_review_json,
                          r.created_at AS application_created_at, r.seminar_id,
                          s.title AS seminar_title, s.event_date, s.price AS seminar_price, s.cancellation_policy_json,
                          u.first_name, u.last_name, u.email, u.phone, u.user_id_string,
                          o.id AS order_id, o.order_id_string, o.amount AS order_amount, o.payment_gateway,
                          o.provider_transaction_id, o.refund_status AS order_refund_status, o.refunded_amount AS order_refunded_amount,
                          t.ticket_id_string, t.is_scanned, t.scan_time
                   FROM cancellation_requests cr
                   JOIN registrations r ON r.id = cr.registration_id
                   JOIN seminars s ON s.id = r.seminar_id
                   JOIN users u ON u.id = cr.user_id
                   LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
                   LEFT JOIN tickets t ON t.id = (
                       SELECT tk.id FROM tickets tk
                       JOIN orders ord ON tk.order_id = ord.id
                       WHERE ord.registration_id = r.id AND ord.status = 'success'
                       ORDER BY tk.id DESC LIMIT 1
                   )
                   WHERE 1=1`;
        const params = [];
        if (status) {
            sql += ` AND cr.status = ?`;
            params.push(status);
        }
        if (Number.isInteger(userId) && userId > 0) {
            sql += ` AND cr.user_id = ?`;
            params.push(userId);
        }
        sql += ` ORDER BY cr.id DESC LIMIT 300`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const list = rows || [];
            if (!list.length) return res.json([]);
            const regIds = list.map((r) => r.registration_id);
            refundTracking.loadRefundsForRegistrations(db, regIds, (e2, refundsByReg) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const out = list.map((row) => {
                    const refunds = refundsByReg[row.registration_id] || [];
                    return refundTracking.enrichAdminCancellationRow(row, refunds);
                });
                res.json(out);
            });
        });
    });

    app.get('/api/admin/cancellation-requests/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid request id' });
        db.get(
            `SELECT cr.*, r.application_no, r.status AS registration_status, r.form_data, r.doc_review_json,
                    r.created_at AS application_created_at, r.seminar_id,
                    s.title AS seminar_title, s.event_date, s.price AS seminar_price, s.cancellation_policy_json,
                    u.first_name, u.last_name, u.email, u.phone, u.user_id_string,
                    o.id AS order_id, o.order_id_string, o.amount AS order_amount, o.payment_gateway,
                    o.provider_transaction_id, o.refund_status AS order_refund_status, o.refunded_amount AS order_refunded_amount,
                    t.ticket_id_string, t.is_scanned, t.scan_time
             FROM cancellation_requests cr
             JOIN registrations r ON r.id = cr.registration_id
             JOIN seminars s ON s.id = r.seminar_id
             JOIN users u ON u.id = cr.user_id
             LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
             LEFT JOIN tickets t ON t.id = (
                 SELECT tk.id FROM tickets tk
                 JOIN orders ord ON tk.order_id = ord.id
                 WHERE ord.registration_id = r.id AND ord.status = 'success'
                 ORDER BY tk.id DESC LIMIT 1
             )
             WHERE cr.id = ?`,
            [id],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Request not found' });
                refundTracking.loadRefundsForRegistrations(db, [row.registration_id], (e2, refundsByReg) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const refunds = refundsByReg[row.registration_id] || [];
                    res.json(refundTracking.enrichAdminCancellationRow(row, refunds));
                });
            }
        );
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
                            const refundStatus = razorpayRefundSync.deriveRefundStatusFromGatewayResult(
                                refundResult,
                                refundAmt
                            );
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
                                    const notifyVars = {
                                        cancellation_reason: reqRow.reason || '',
                                        admin_notes: adminNotes || 'No additional note from the office.',
                                        refund_amount: refundAmt > 0 ? String(refundAmt) : '0',
                                        refund_percent: refundPct > 0 ? String(refundPct) : '0',
                                        approval_status: 'cancelled'
                                    };
                                    notifEngine.notify(db, 'REGISTRATION_CANCELLED', {
                                        userId: reqRow.user_id,
                                        registrationId,
                                        seminarId: reg && reg.seminar_id,
                                        vars: notifyVars
                                    }, () => {});
                                    if (refundAmt > 0) {
                                        const refundTracking = require('./refund-tracking');
                                        notifEngine.notify(db, 'REFUND_INITIATED', {
                                            userId: reqRow.user_id,
                                            registrationId,
                                            seminarId: reg && reg.seminar_id,
                                            vars: Object.assign({}, notifyVars, {
                                                provider_refund_id:
                                                    (refundResult && refundResult.providerRefundId) || '',
                                                refund_status: refundStatus,
                                                refund_status_label: refundTracking.refundStatusLabel(refundStatus),
                                                order_id_string: order && order.order_id_string,
                                                provider_transaction_id: order && order.provider_transaction_id,
                                                payment_gateway: order && order.payment_gateway,
                                                payment_amount: order && order.amount
                                            })
                                        });
                                    }
                                    if (
                                        refundResult &&
                                        refundResult.providerRefundId &&
                                        refundStatus === 'processing'
                                    ) {
                                        razorpayRefundSync.syncRefundByProviderId(
                                            db,
                                            refundResult.providerRefundId,
                                            () => {}
                                        );
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

    app.post('/api/admin/cancellation-requests/:id/process-refund', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!id) return res.status(400).json({ error: 'Invalid request id' });

        db.get(`SELECT * FROM cancellation_requests WHERE id = ?`, [id], (err, reqRow) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!reqRow) return res.status(404).json({ error: 'Request not found' });
            if (reqRow.status !== 'approved') {
                return res.status(400).json({ error: 'Refund can only be processed for approved cancellations.' });
            }
            const refundAmt = Number(reqRow.refund_amount) || 0;
            if (refundAmt <= 0) {
                return res.status(400).json({ error: 'No refund amount on this request.' });
            }
            const refundSt = String(reqRow.refund_status || 'none').toLowerCase();
            if (refundSt === 'completed') {
                return res.status(400).json({ error: 'Refund already completed.' });
            }

            paymentsMod.loadRegistrationPaymentContext(db, reqRow.registration_id, (e2, ctx) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const order = ctx && ctx.order;
                if (!order) return res.status(400).json({ error: 'No successful payment order found for this application.' });
                const refundPct =
                    order.amount && Number(order.amount) > 0
                        ? Math.round((refundAmt / Number(order.amount)) * 100)
                        : Number(reqRow.refund_percent) || 0;

                paymentsMod.processOrderRefund(
                    db,
                    {
                        orderId: order.id,
                        amountRupees: refundAmt,
                        percent: refundPct,
                        reason: 'Cancellation refund (admin)',
                        adminUserId: actingAdminId
                    },
                    (rErr, rOut) => {
                        if (rErr) return res.status(500).json({ error: rErr.message });
                        if (!rOut.ok) return res.status(400).json({ error: rOut.error });
                        const newStatus =
                            rOut.refundStatus ||
                            razorpayRefundSync.deriveRefundStatusFromGatewayResult(rOut, refundAmt);
                        db.run(
                            `UPDATE cancellation_requests SET refund_status = ?, provider_refund_id = ?, reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP) WHERE id = ?`,
                            [newStatus, rOut.providerRefundId || null, id],
                            (uErr) => {
                                if (uErr) return res.status(500).json({ error: uErr.message });
                                notifEngine.notify(db, 'REFUND_INITIATED', {
                                    userId: reqRow.user_id,
                                    registrationId: reqRow.registration_id,
                                    seminarId: ctx.registration && ctx.registration.seminar_id,
                                    vars: {
                                        refund_amount: String(refundAmt),
                                        refund_percent: String(refundPct),
                                        admin_notes: reqRow.admin_notes || '',
                                        provider_refund_id: rOut.providerRefundId || '',
                                        refund_status: newStatus,
                                        refund_status_label: require('./refund-tracking').refundStatusLabel(newStatus),
                                        order_id_string: order && order.order_id_string,
                                        provider_transaction_id: order && order.provider_transaction_id,
                                        payment_gateway: order && order.payment_gateway,
                                        payment_amount: order && order.amount
                                    }
                                });
                                if (rOut.providerRefundId && newStatus === 'processing') {
                                    razorpayRefundSync.syncRefundByProviderId(
                                        db,
                                        rOut.providerRefundId,
                                        () => {}
                                    );
                                }
                                activityLog.logActivity(db, {
                                    user_id: actingAdminId || null,
                                    action: 'cancellation.refund_processed',
                                    resource_type: 'cancellation_request',
                                    resource_id: String(id),
                                    meta: { refundAmount: refundAmt, status: newStatus }
                                });
                                res.json({
                                    success: true,
                                    message: rOut.message || 'Refund initiated.',
                                    refundStatus: newStatus,
                                    providerRefundId: rOut.providerRefundId || null
                                });
                            }
                        );
                    }
                );
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
                    db.get(
                        `SELECT r.user_id, r.seminar_id, s.price FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
                        [registrationId],
                        (eRow, payRow) => {
                            if (!eRow && payRow) {
                                adminPaymentFlow.notifyAfterRegistrationPaid(
                                    db,
                                    notifEngine,
                                    notifyTicketIssued,
                                    {
                                        user_id: payRow.user_id,
                                        seminar_id: payRow.seminar_id,
                                        registration_id: registrationId,
                                        amount
                                    },
                                    meta,
                                    null,
                                    portalTracking
                                );
                            }
                        }
                    );
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

    app.get('/api/admin/payments/methods', (req, res) => {
        const aid = parseInt(req.query.actingAdminId, 10);
        if (!Number.isInteger(aid) || aid < 1) {
            return res.status(400).json({ error: 'actingAdminId query parameter is required' });
        }
        if (!assertAdminPortalActor) {
            return res.status(500).json({ error: 'Admin auth not configured' });
        }
        assertAdminPortalActor(aid, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            db.all(`SELECT * FROM payment_gateways`, [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                adminPaymentFlow.loadUpiConfig(db, (eUpi, upiCfg) => {
                    if (eUpi) return res.status(500).json({ error: eUpi.message });
                    res.json({
                        success: true,
                        methods: adminPaymentFlow.buildAdminPaymentMethods(rows, upiCfg),
                        upiConfigured: !!(upiCfg && upiCfg.vpa)
                    });
                });
            });
        });
    });

    app.get('/api/admin/payments/lookup', (req, res) => {
        const aid = parseInt(req.query.actingAdminId, 10);
        const seminarId = parseInt(req.query.seminarId, 10);
        const query = String(req.query.q || req.query.userId || '').trim();
        if (!aid || !seminarId || !query) {
            return res.status(400).json({ error: 'actingAdminId, seminarId, and q (user ID / email / phone) are required' });
        }
        assertAdminPortalActor(aid, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentLookup.lookupPaymentContext(db, { query, seminarId }, (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(out);
            });
        });
    });

    app.post('/api/admin/payments/ensure-registration', (req, res) => {
        const userId = parseInt((req.body && req.body.userId) || '', 10);
        const seminarId = parseInt((req.body && req.body.seminarId) || '', 10);
        const adminUserId = parseInt((req.body && req.body.adminUserId) || '', 10);
        if (!userId || !seminarId || !adminUserId) {
            return res.status(400).json({ error: 'userId, seminarId, and adminUserId are required' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentLookup.ensureRegistrationForPayment(
                db,
                { userId, seminarId },
                portalTracking,
                notifEngine,
                (err, out) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (out && out.error) return res.status(400).json(out);
                    res.json({ success: true, ...out });
                }
            );
        });
    });

    app.post('/api/admin/payments/initiate', (req, res) => {
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        const adminUserId = parseInt((req.body && req.body.adminUserId) || '', 10);
        const methodId = (req.body && req.body.methodId) || '';
        const amount = req.body && req.body.amount != null ? req.body.amount : null;
        const discountAmount = req.body && req.body.discountAmount != null ? req.body.discountAmount : null;
        if (!registrationId || !adminUserId || !methodId) {
            return res.status(400).json({ error: 'registrationId, adminUserId, and methodId are required' });
        }
        if (!getOrCreatePendingOrder) {
            return res.status(500).json({ error: 'Payment initiation not available' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentFlow.initiateAdminPayment(
                db,
                paymentDeps,
                { registrationId, methodId, adminUserId, amount, discountAmount },
                (err, out) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (out && out.error) return res.status(400).json(out);
                    res.json(out);
                }
            );
        });
    });

    app.get('/api/admin/payments/application-link', (req, res) => {
        const registrationId = parseInt(req.query.registrationId, 10);
        const adminUserId = parseInt(req.query.actingAdminId, 10);
        const methodId = String(req.query.methodId || '').trim();
        if (!registrationId || !adminUserId) {
            return res.status(400).json({ error: 'registrationId and actingAdminId are required' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            db.get(
                `SELECT id, application_no FROM registrations WHERE id = ?`,
                [registrationId],
                (err, reg) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!reg) return res.status(404).json({ error: 'Application not found' });
                    const qs = new URLSearchParams();
                    qs.set('pay_registration', String(reg.id));
                    if (reg.application_no) qs.set('pay_app', String(reg.application_no));
                    if (methodId) qs.set('pay_method', methodId);
                    const paymentLink = integrationSettings.getPublicBaseUrl() + '/doctor?' + qs.toString();
                    res.json({
                        success: true,
                        registrationId: reg.id,
                        applicationNo: reg.application_no || null,
                        paymentLink
                    });
                }
            );
        });
    });

    app.get('/api/admin/payments/poll/:orderDbId', (req, res) => {
        const orderDbId = parseInt(req.params.orderDbId, 10);
        const aid = parseInt(req.query.actingAdminId, 10);
        if (!orderDbId || !aid) {
            return res.status(400).json({ error: 'order id and actingAdminId required' });
        }
        assertAdminPortalActor(aid, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentFlow.pollAdminPaymentOrder(db, paymentDeps, orderDbId, (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                if (out && out.error) return res.status(400).json(out);
                res.json(out);
            });
        });
    });

    app.post('/api/admin/payments/mark-upi-paid', (req, res) => {
        const orderDbId = parseInt((req.body && req.body.orderDbId) || '', 10);
        const adminUserId = parseInt((req.body && req.body.adminUserId) || '', 10);
        if (!orderDbId || !adminUserId) {
            return res.status(400).json({ error: 'orderDbId and adminUserId required' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentFlow.markUpiStaticPaid(db, paymentDeps, orderDbId, adminUserId, (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                if (out && out.error) return res.status(400).json(out);
                res.json(out);
            });
        });
    });

    app.get('/api/payments/status', (req, res) => {
        const registrationId = parseInt(req.query.registrationId, 10);
        const userId = parseInt(req.query.userId, 10);
        if (!registrationId || !userId) {
            return res.status(400).json({ error: 'registrationId and userId required' });
        }
        db.get(
            `SELECT id, status, application_no, seminar_id FROM registrations WHERE id = ? AND user_id = ?`,
            [registrationId, userId],
            (err, reg) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!reg) return res.status(404).json({ error: 'Not found' });
                db.get(
                    `SELECT o.id, o.status, o.amount, o.payment_gateway, o.payment_date, t.ticket_id_string
                     FROM orders o
                     LEFT JOIN tickets t ON t.order_id = o.id
                     WHERE o.registration_id = ?
                     ORDER BY o.id DESC LIMIT 1`,
                    [registrationId],
                    (e2, ord) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        const respond = (extra) => {
                            const paid =
                                (ord && ord.status === 'success') ||
                                ['completed', 'checked_in', 'e_ticket_issued'].includes(
                                    String(reg.status || '').toLowerCase()
                                );
                            res.json({
                                registrationId,
                                applicationNo: reg.application_no,
                                registrationStatus: reg.status,
                                paid,
                                orderDbId: ord && ord.id,
                                orderStatus: (ord && ord.status) || null,
                                amount: ord && ord.amount,
                                gateway: ord && ord.payment_gateway,
                                paymentDate: ord && ord.payment_date,
                                ticketId: ord && ord.ticket_id_string,
                                ...(extra || {})
                            });
                        };
                        const gw = ord && String(ord.payment_gateway || '');
                        const hostedPoll = [...hostedCheckout.HOSTED_GATEWAYS].some((g) =>
                            gw.startsWith(g)
                        );
                        const shouldPoll =
                            ord &&
                            ord.status === 'pending' &&
                            ord.id &&
                            (gw.startsWith('dqr_') || hostedPoll);
                        if (shouldPoll) {
                            return adminPaymentFlow.pollAdminPaymentOrder(db, paymentDeps, ord.id, (pErr, poll) => {
                                if (pErr) return res.status(500).json({ error: pErr.message });
                                if (poll && poll.paid) {
                                    ord.status = 'success';
                                    reg.status = 'completed';
                                }
                                respond({
                                    pollMessage: (poll && poll.message) || '',
                                    pollPaid: !!(poll && poll.paid)
                                });
                            });
                        }
                        respond();
                    }
                );
            }
        );
    });

    app.post('/api/payments/cancel-pending', (req, res) => {
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        const userId = parseInt((req.body && req.body.userId) || '', 10);
        if (!registrationId || !userId) {
            return res.status(400).json({ error: 'registrationId and userId required' });
        }
        db.get(`SELECT id, user_id FROM registrations WHERE id = ?`, [registrationId], (err, reg) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!reg) return res.status(404).json({ error: 'Not found' });
            if (Number(reg.user_id) !== userId) {
                return res.status(403).json({ error: 'Not your application' });
            }
            adminPaymentFlow.cancelPendingOrdersForRegistration(db, registrationId, (cErr, n) => {
                if (cErr) return res.status(500).json({ error: cErr.message });
                res.json({
                    success: true,
                    cancelled: n,
                    message: n ? 'Pending payment cancelled. You can start a new payment.' : 'No pending payment to cancel.'
                });
            });
        });
    });

    app.post('/api/admin/payments/cancel-order', (req, res) => {
        const orderDbId = parseInt((req.body && req.body.orderDbId) || '', 10);
        const adminUserId = parseInt((req.body && req.body.adminUserId) || '', 10);
        if (!orderDbId || !adminUserId) {
            return res.status(400).json({ error: 'orderDbId and adminUserId required' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentFlow.cancelPendingOrder(db, orderDbId, (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                if (out && out.error) return res.status(400).json(out);
                res.json(out);
            });
        });
    });

    app.post('/api/admin/payments/retry', (req, res) => {
        const registrationId = parseInt((req.body && req.body.registrationId) || '', 10);
        const adminUserId = parseInt((req.body && req.body.adminUserId) || '', 10);
        const methodId = String((req.body && req.body.methodId) || '').trim();
        const amount = req.body && req.body.amount != null ? req.body.amount : null;
        if (!registrationId || !adminUserId || !methodId) {
            return res.status(400).json({ error: 'registrationId, adminUserId, and methodId required' });
        }
        assertAdminPortalActor(adminUserId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            adminPaymentFlow.cancelPendingOrdersForRegistration(db, registrationId, () => {
                adminPaymentFlow.initiateAdminPayment(
                    db,
                    paymentDeps,
                    { registrationId, methodId, adminUserId, amount },
                    (err, out) => {
                        if (err) return res.status(500).json({ error: err.message });
                        if (out && out.error) return res.status(400).json(out);
                        res.json(out);
                    }
                );
            });
        });
    });

    function redirectPaymentReturn(gateway, req, res) {
        const payload = { ...(req.query || {}), ...(req.body || {}) };
        hostedCheckout.processReturn(gateway, db, paymentDeps, payload, (err, out) => {
            if (err) {
                console.error(`[${gateway}-return]`, err.message);
                return res.redirect(
                    integrationSettings.getPublicBaseUrl() +
                        '/doctor?payment=error&msg=' +
                        encodeURIComponent(err.message)
                );
            }
            const base = integrationSettings.getPublicBaseUrl() + '/doctor';
            const q = (out && out.redirectQuery) || (out && out.paid ? 'payment=success' : 'payment=failed');
            const msg = out && out.message ? '&msg=' + encodeURIComponent(out.message) : '';
            res.redirect(base + '?' + q + msg);
        });
    }

    ['easebuzz', 'cashfree', 'payu', 'paytm', 'phonepe', 'juspay', 'zoho'].forEach((gateway) => {
        app.all(`/api/payments/${gateway}/return`, (req, res) => redirectPaymentReturn(gateway, req, res));
    });

    app.post('/api/payments/cashfree/webhook', (req, res) => {
        hostedCheckout.processReturn('cashfree', db, paymentDeps, req.body || {}, () => {
            res.json({ success: true });
        });
    });

    app.post('/api/payments/phonepe/webhook', (req, res) => {
        hostedCheckout.processReturn('phonepe', db, paymentDeps, req.body || {}, () => {
            res.json({ success: true });
        });
    });

    app.post('/api/payments/razorpay/webhook', (req, res) => {
        const signature = req.get('x-razorpay-signature') || req.get('X-Razorpay-Signature') || '';
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        razorpayRefundSync.getWebhookSecret(db, (secErr, secret) => {
            if (secErr) return res.status(500).json({ error: secErr.message });
            const verified = razorpayRefundSync.verifyWebhookSignature(rawBody, signature, secret);
            if (!verified.ok && !verified.skipped) {
                return res.status(400).json({ error: verified.error || 'Invalid webhook signature' });
            }
            razorpayRefundSync.handleRazorpayWebhook(db, req.body || {}, (hErr, result) => {
                if (hErr) return res.status(500).json({ error: hErr.message });
                res.json({ success: true, result: result || { ok: true } });
            });
        });
    });

    app.post('/api/admin/payments/refunds/sync-razorpay', (req, res) => {
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!actingAdminId) return res.status(400).json({ error: 'actingAdminId required' });
        assertAdminPortalActor(actingAdminId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            const providerRefundId =
                (req.body && (req.body.providerRefundId || req.body.provider_refund_id)) || '';
            if (providerRefundId) {
                return razorpayRefundSync.syncRefundByProviderId(db, providerRefundId, (err, out) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!out.ok) return res.status(400).json(out);
                    res.json(out);
                });
            }
            razorpayRefundSync.reconcilePendingRazorpayRefunds(db, (err, summary) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(summary || { checked: 0, updated: 0 });
            });
        });
    });

    app.post('/api/admin/cancellation-requests/:id/sync-refund', (req, res) => {
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!actingAdminId) return res.status(400).json({ error: 'actingAdminId required' });
        assertAdminPortalActor(actingAdminId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            const id = parseInt(req.params.id, 10);
            if (!id) return res.status(400).json({ error: 'Invalid id' });
            db.get(`SELECT provider_refund_id FROM cancellation_requests WHERE id = ?`, [id], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row || !row.provider_refund_id) {
                    return res.status(400).json({ error: 'No Razorpay refund id on this request yet.' });
                }
                razorpayRefundSync.syncRefundByProviderId(db, row.provider_refund_id, (sErr, out) => {
                    if (sErr) return res.status(500).json({ error: sErr.message });
                    if (!out.ok) return res.status(400).json(out);
                    res.json(out);
                });
            });
        });
    });

    app.post('/api/admin/cancellation-requests/:id/bank-utr', (req, res) => {
        const actingAdminId = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (!actingAdminId) return res.status(400).json({ error: 'actingAdminId required' });
        assertAdminPortalActor(actingAdminId, (eAct, adm) => {
            if (eAct || !adm) return res.status(403).json({ error: 'Admin access required' });
            const id = parseInt(req.params.id, 10);
            const bankUtr = String((req.body && (req.body.bankUtr || req.body.bank_utr)) || '').trim();
            if (!id) return res.status(400).json({ error: 'Invalid id' });
            if (!bankUtr) return res.status(400).json({ error: 'Bank UTR / RRN is required.' });
            db.get(
                `SELECT registration_id FROM cancellation_requests WHERE id = ?`,
                [id],
                (err, row) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!row) return res.status(404).json({ error: 'Cancellation request not found' });
                    db.get(
                        `SELECT id FROM refunds WHERE registration_id = ? ORDER BY id DESC LIMIT 1`,
                        [row.registration_id],
                        (e2, refund) => {
                            if (e2) return res.status(500).json({ error: e2.message });
                            if (!refund) {
                                return res.status(400).json({
                                    error: 'No refund record yet. Process the refund first, then save the UTR.'
                                });
                            }
                            db.run(
                                `UPDATE refunds SET bank_utr = ?, updated_at = ? WHERE id = ?`,
                                [bankUtr, new Date().toISOString(), refund.id],
                                (uErr) => {
                                    if (uErr) return res.status(500).json({ error: uErr.message });
                                    activityLog.logActivity(db, {
                                        user_id: actingAdminId,
                                        action: 'refund.bank_utr_saved',
                                        resource_type: 'refund',
                                        resource_id: String(refund.id),
                                        meta: { cancellationRequestId: id, bankUtr }
                                    });
                                    res.json({ success: true, bankUtr, refundId: refund.id });
                                }
                            );
                        }
                    );
                }
            );
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

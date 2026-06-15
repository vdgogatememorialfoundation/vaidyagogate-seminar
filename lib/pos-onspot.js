/**
 * On-spot POS registration — quick doctor + registration + cash or integrated PG (Razorpay DQR / checkout).
 * Email is queued (never blocks registration); venue default skips participant email.
 */
function registerPosRoutes(app, deps) {
    const {
        db,
        generateId,
        requireAdminActor,
        getOrCreatePendingOrder,
        fulfillRegistrationPayment,
        seminarCapacity,
        activityLog,
        notifyTicketIssued,
        emailDeliveryPolicy,
        adminPaymentFlow,
        paymentDeps
    } = deps;

    function queuePosTicketEmail(userId, registrationId, ticketId, sendTicketEmail) {
        if (!notifyTicketIssued || !ticketId) return;
        const policy = emailDeliveryPolicy || require('./email-delivery-policy');
        policy.loadConfig(db, (e, cfg) => {
            if (e) return;
            const want =
                !!sendTicketEmail && !policy.shouldSkipPosParticipantEmail(cfg, { source: 'pos', isPos: true });
            if (!want) return;
            try {
                notifyTicketIssued(userId, registrationId, ticketId, {
                    email: true,
                    whatsapp: false,
                    immediate: false,
                    source: 'pos'
                });
            } catch (_) {}
        });
    }

    app.post('/api/admin/pos/register', (req, res) => {
        requireAdminActor(req, res, (actor) => {
            const {
                seminarId,
                firstName,
                middleName,
                lastName,
                email,
                phone,
                amount,
                paymentMethod,
                sendTicketEmail
            } = req.body || {};
            const sid = parseInt(seminarId, 10);
            const fn = String(firstName || '').trim();
            const mn = String(middleName || '').trim();
            const ln = String(lastName || '').trim();
            const em = String(email || '').trim().toLowerCase();
            const ph = String(phone || '').trim();
            if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'seminarId required' });
            if (!fn || !ln) return res.status(400).json({ error: 'First and last name required' });
            if (!ph && !em) return res.status(400).json({ error: 'Phone or email required' });

            seminarCapacity.assertSeminarHasCapacity(db, sid, (capErr, capBlock) => {
                if (capErr) return res.status(500).json({ error: capErr.message });
                if (capBlock) return res.status(409).json(capBlock);

                const findUser = (next) => {
                    if (em) {
                        return db.get(`SELECT id FROM users WHERE LOWER(email) = ?`, [em], (e, row) => {
                            if (e) return res.status(500).json({ error: e.message });
                            if (row) return next(null, row.id);
                            if (ph) {
                                return db.get(`SELECT id FROM users WHERE phone = ?`, [ph], (e2, row2) => {
                                    if (e2) return res.status(500).json({ error: e2.message });
                                    next(null, row2 ? row2.id : null);
                                });
                            }
                            next(null, null);
                        });
                    }
                    if (ph) {
                        return db.get(`SELECT id FROM users WHERE phone = ?`, [ph], (e, row) => {
                            if (e) return res.status(500).json({ error: e.message });
                            next(null, row ? row.id : null);
                        });
                    }
                    next(null, null);
                };

                findUser((_, existingUserId) => {
                    const createUser = (cb) => {
                        if (existingUserId) return cb(null, existingUserId);
                        const tempPass = 'POS_' + generateId().slice(0, 10);
                        const uidStr = 'DOC_' + generateId();
                        const loginEmail = em || `pos_${uidStr.toLowerCase()}@onspot.local`;
                        db.run(
                            `INSERT INTO users (user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, email_verified, profile_complete)
                             VALUES (?, ?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1, 0)`,
                            [uidStr, fn, mn || null, ln, loginEmail, ph || '', tempPass],
                            function (insErr) {
                                if (insErr) {
                                    if (/no such column|profile_complete/i.test(String(insErr.message))) {
                                        return db.run(
                                            `INSERT INTO users (user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, email_verified)
                                             VALUES (?, ?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1)`,
                                            [uidStr, fn, mn || null, ln, loginEmail, ph || '', tempPass],
                                            function (e2) {
                                                if (e2) return cb(e2);
                                                cb(null, this.lastID);
                                            }
                                        );
                                    }
                                    return cb(insErr);
                                }
                                cb(null, this.lastID);
                            }
                        );
                    };

                    createUser((uErr, userId) => {
                        if (uErr) return res.status(500).json({ error: uErr.message });

                        db.get(
                            `SELECT id, status, application_no FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
                            [userId, sid],
                            (rErr, existingReg) => {
                                if (rErr) return res.status(500).json({ error: rErr.message });

                                const method = String(paymentMethod || 'cash').toLowerCase();
                                const isCash = method === 'cash';
                                const amt = amount != null ? Number(amount) : null;

                                const finishCashPayment = (registrationId, applicationNo) => {
                                    getOrCreatePendingOrder(registrationId, amt, (oErr, orderRow) => {
                                        if (oErr) return res.status(500).json({ error: oErr.message });
                                        fulfillRegistrationPayment(
                                            registrationId,
                                            userId,
                                            amt || 1500,
                                            'cash',
                                            'POS_' + Date.now(),
                                            (fErr, meta) => {
                                                if (fErr) return res.status(500).json({ error: fErr.message });
                                                activityLog.logActivity(db, {
                                                    user_id: actor.id,
                                                    action: 'pos.registration',
                                                    resource_type: 'registration',
                                                    resource_id: String(registrationId),
                                                    meta: {
                                                        seminarId: sid,
                                                        userId,
                                                        ticketId: meta && meta.ticketId,
                                                        paymentMethod: 'cash'
                                                    }
                                                });
                                                const ticketId = meta && meta.ticketId;
                                                res.json({
                                                    success: true,
                                                    paid: true,
                                                    userId,
                                                    registrationId,
                                                    applicationNo,
                                                    ticketId,
                                                    profileComplete: false,
                                                    message:
                                                        'On-spot registration recorded (cash). Doctor must complete profile in the portal.',
                                                    emailQueued: !!sendTicketEmail,
                                                    emailNote:
                                                        'Ticket email is queued (not sent immediately) to protect SMTP limits. Print QR at venue or send later from E-tickets.'
                                                });
                                                if (notifyTicketIssued) {
                                                    queuePosTicketEmail(userId, registrationId, ticketId, sendTicketEmail);
                                                }
                                            }
                                        );
                                    });
                                };

                                const finishGatewayPayment = (registrationId, applicationNo) => {
                                    if (!adminPaymentFlow || !paymentDeps) {
                                        return res.status(500).json({
                                            error: 'Integrated payment is not configured on the server.'
                                        });
                                    }
                                    adminPaymentFlow.initiateAdminPayment(
                                        db,
                                        paymentDeps,
                                        {
                                            registrationId,
                                            methodId: method,
                                            adminUserId: actor.id,
                                            amount: amt
                                        },
                                        (payErr, payOut) => {
                                            if (payErr) return res.status(500).json({ error: payErr.message });
                                            if (payOut && payOut.error) {
                                                return res.status(400).json({ error: payOut.error });
                                            }
                                            if (payOut && payOut.paid) {
                                                activityLog.logActivity(db, {
                                                    user_id: actor.id,
                                                    action: 'pos.registration',
                                                    resource_type: 'registration',
                                                    resource_id: String(registrationId),
                                                    meta: {
                                                        seminarId: sid,
                                                        userId,
                                                        paymentMethod: method,
                                                        ticketId: payOut.ticketId
                                                    }
                                                });
                                                return res.json({
                                                    success: true,
                                                    paid: true,
                                                    userId,
                                                    registrationId,
                                                    applicationNo,
                                                    ticketId: payOut.ticketId,
                                                    profileComplete: false,
                                                    message: payOut.message || 'Payment recorded. E-ticket issued.',
                                                    emailQueued: !!sendTicketEmail
                                                });
                                            }
                                            activityLog.logActivity(db, {
                                                user_id: actor.id,
                                                action: 'pos.registration',
                                                resource_type: 'registration',
                                                resource_id: String(registrationId),
                                                meta: {
                                                    seminarId: sid,
                                                    userId,
                                                    paymentMethod: method,
                                                    orderDbId: payOut && payOut.orderDbId
                                                }
                                            });
                                            res.json({
                                                success: true,
                                                paid: false,
                                                paymentPending: true,
                                                userId,
                                                registrationId,
                                                applicationNo,
                                                profileComplete: false,
                                                payment: payOut,
                                                message:
                                                    payOut.message ||
                                                    'Registration saved. Complete payment via QR or gateway below — e-ticket issues automatically when paid.'
                                            });
                                        }
                                    );
                                };

                                const finishPayment = (registrationId, applicationNo) => {
                                    if (isCash) return finishCashPayment(registrationId, applicationNo);
                                    return finishGatewayPayment(registrationId, applicationNo);
                                };

                                if (existingReg) {
                                    const st = String(existingReg.status || '').toLowerCase();
                                    if (st === 'completed' || st === 'checked_in') {
                                        return res.status(400).json({
                                            error: 'This doctor already has a paid registration for this seminar.'
                                        });
                                    }
                                    return finishPayment(
                                        existingReg.id,
                                        existingReg.application_no || null
                                    );
                                }

                                const appNo = 'APP_' + generateId();
                                db.run(
                                    `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data)
                                     VALUES (?, ?, ?, 'approved_pending_payment', ?)`,
                                    [
                                        userId,
                                        sid,
                                        appNo,
                                        JSON.stringify({
                                            source: 'pos',
                                            onSpot: true,
                                            registeredBy: actor.id,
                                            fname: fn,
                                            mname: mn,
                                            lname: ln,
                                            phone: ph,
                                            email: em || ''
                                        })
                                    ],
                                    function (insRegErr) {
                                        if (insRegErr) return res.status(500).json({ error: insRegErr.message });
                                        finishPayment(this.lastID, appNo);
                                    }
                                );
                            }
                        );
                    });
                });
            });
        });
    });
}

module.exports = { registerPosRoutes };

/**
 * On-spot POS registration — quick doctor + registration + cash or integrated PG (Razorpay DQR / checkout).
 * Matches existing doctors by email and phone; creates portal ID + emails credentials for new accounts.
 */
const { normalizePhoneDigits } = require('./admin-user-lookup');

function apiErrMessage(err, fallback) {
    if (!err) return fallback || 'Request failed';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.error) return String(err.error);
    return fallback || 'Request failed';
}

function phoneSqlMatchClause() {
    return `replace(replace(replace(trim(phone), ' ', ''), '-', ''), '+', '') = ?`;
}

function findPosUser(db, email, phone, cb) {
    const em = String(email || '')
        .trim()
        .toLowerCase();
    const phDigits = normalizePhoneDigits(phone);
    const phNorm = String(phone || '').trim();

    const finish = (user) => cb(null, user || null);

    if (em && phDigits.length >= 8) {
        return db.get(
            `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone
             FROM users WHERE LOWER(TRIM(email)) = ? AND ${phoneSqlMatchClause()} LIMIT 1`,
            [em, phDigits],
            (e, row) => {
                if (e) return cb(e);
                if (row) return finish(row);
                tryEmailThenPhone();
            }
        );
    }
    tryEmailThenPhone();

    function tryEmailThenPhone() {
        if (em) {
            return db.get(
                `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone
                 FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1`,
                [em],
                (e, row) => {
                    if (e) return cb(e);
                    if (row) return finish(row);
                    tryPhoneOnly();
                }
            );
        }
        tryPhoneOnly();
    }

    function tryPhoneOnly() {
        if (!phDigits || phDigits.length < 8) return finish(null);
        db.get(
            `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone
             FROM users WHERE ${phoneSqlMatchClause()} LIMIT 1`,
            [phDigits],
            (e, row) => {
                if (e) return cb(e);
                finish(row);
            }
        );
    }
}

function queuePosAccountCreatedEmail(db, notifEngine, flushNotificationQueue, userId, tempPassword) {
    if (!notifEngine || !userId || !tempPassword) return;
    db.get(`SELECT email FROM users WHERE id = ?`, [userId], (e, row) => {
        if (e || !row || !row.email || /@onspot\.local$/i.test(String(row.email))) return;
        notifEngine.notify(
            db,
            'ACCOUNT_CREATED',
            {
                userId,
                vars: { temporary_password: tempPassword },
                immediate: false
            },
            () => {
                if (typeof flushNotificationQueue === 'function') flushNotificationQueue();
            }
        );
    });
}

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
        paymentDeps,
        notifEngine,
        flushNotificationQueue
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

    app.get('/api/admin/pos/lookup-user', (req, res) => {
        requireAdminActor(req, res, () => {
            const em = String(req.query.email || '').trim();
            const ph = String(req.query.phone || '').trim();
            if (!em && !ph) return res.status(400).json({ error: 'email or phone required' });
            findPosUser(db, em, ph, (err, user) => {
                if (err) return res.status(500).json({ error: apiErrMessage(err) });
                if (!user) {
                    return res.json({
                        found: false,
                        message: 'No existing account — a new doctor ID will be created on registration.'
                    });
                }
                const name = [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(' ');
                res.json({
                    found: true,
                    user: {
                        id: user.id,
                        userIdString: user.user_id_string,
                        name,
                        email: user.email,
                        phone: user.phone
                    },
                    message: 'Existing account: ' + (user.user_id_string || '') + (name ? ' · ' + name : '')
                });
            });
        });
    });

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
                if (capErr) return res.status(500).json({ error: apiErrMessage(capErr) });
                if (capBlock) return res.status(409).json(capBlock);

                findPosUser(db, em, ph, (findErr, existingUser) => {
                    if (findErr) return res.status(500).json({ error: apiErrMessage(findErr) });

                    const createUser = (cb) => {
                        if (existingUser) return cb(null, existingUser.id, existingUser.user_id_string, false, null);
                        const tempPass = 'POS_' + generateId().slice(0, 10);
                        const uidStr = 'DOC_' + generateId();
                        const loginEmail = em || `pos_${uidStr.toLowerCase()}@onspot.local`;

                        const onInsert = (insErr) => {
                            if (!insErr) {
                                const newId = this.lastID;
                                if (newId) {
                                    return cb(null, newId, uidStr, true, tempPass);
                                }
                                return db.get(
                                    `SELECT id FROM users WHERE user_id_string = ?`,
                                    [uidStr],
                                    (eId, row) => {
                                        if (eId || !row) {
                                            return cb(eId || new Error('User created but id not returned'));
                                        }
                                        cb(null, row.id, uidStr, true, tempPass);
                                    }
                                );
                            }
                            if (/unique|duplicate/i.test(String(insErr.message || ''))) {
                                return findPosUser(db, em, ph, (e2, again) => {
                                    if (e2) return cb(e2);
                                    if (again) return cb(null, again.id, again.user_id_string, false, null);
                                    cb(insErr);
                                });
                            }
                            cb(insErr);
                        };

                        db.run(
                            `INSERT INTO users (user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, email_verified, profile_complete)
                             VALUES (?, ?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1, 0)`,
                            [uidStr, fn, mn || null, ln, loginEmail, ph || '', tempPass],
                            function (insErr) {
                                if (insErr && /no such column|profile_complete/i.test(String(insErr.message))) {
                                    return db.run(
                                        `INSERT INTO users (user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role, email_verified)
                                         VALUES (?, ?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1)`,
                                        [uidStr, fn, mn || null, ln, loginEmail, ph || '', tempPass],
                                        function (e2) {
                                            onInsert.call(this, e2);
                                        }
                                    );
                                }
                                onInsert.call(this, insErr);
                            }
                        );
                    };

                    createUser((uErr, userId, userIdString, isNewUser, tempPass) => {
                        if (uErr) return res.status(500).json({ error: apiErrMessage(uErr) });
                        if (isNewUser && tempPass) {
                            queuePosAccountCreatedEmail(db, notifEngine, flushNotificationQueue, userId, tempPass);
                        }

                        db.get(
                            `SELECT id, status, application_no FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
                            [userId, sid],
                            (rErr, existingReg) => {
                                if (rErr) return res.status(500).json({ error: apiErrMessage(rErr) });

                                const method = String(paymentMethod || 'cash').toLowerCase();
                                const isCash = method === 'cash';
                                const amt = amount != null && amount !== '' ? Number(amount) : null;

                                const basePayload = {
                                    userId,
                                    userIdString,
                                    isNewUser: !!isNewUser,
                                    existingUser: !isNewUser
                                };

                                const finishCashPayment = (registrationId, applicationNo) => {
                                    getOrCreatePendingOrder(registrationId, amt, (oErr, orderRow) => {
                                        if (oErr) return res.status(500).json({ error: apiErrMessage(oErr) });
                                        fulfillRegistrationPayment(
                                            registrationId,
                                            userId,
                                            amt || 1500,
                                            'cash',
                                            'POS_' + Date.now(),
                                            (fErr, meta) => {
                                                if (fErr) return res.status(500).json({ error: apiErrMessage(fErr) });
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
                                                    ...basePayload,
                                                    registrationId,
                                                    applicationNo,
                                                    ticketId,
                                                    profileComplete: false,
                                                    message:
                                                        (isNewUser
                                                            ? 'New doctor ID ' +
                                                              userIdString +
                                                              ' created. Portal login details emailed when a real email is on file. '
                                                            : 'Existing doctor ' +
                                                              userIdString +
                                                              ' linked. ') +
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
                                            if (payErr) {
                                                return res.status(500).json({ error: apiErrMessage(payErr) });
                                            }
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
                                                    ...basePayload,
                                                    registrationId,
                                                    applicationNo,
                                                    ticketId: payOut.ticketId,
                                                    profileComplete: false,
                                                    message:
                                                        (isNewUser
                                                            ? 'New doctor ID ' +
                                                              userIdString +
                                                              ' created — login details emailed. '
                                                            : '') +
                                                        (payOut.message || 'Payment recorded. E-ticket issued.'),
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
                                                ...basePayload,
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
                                            error: 'This doctor already has a paid registration for this seminar.',
                                            userIdString,
                                            existingUser: true
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
                                        if (insRegErr) {
                                            return res.status(500).json({ error: apiErrMessage(insRegErr) });
                                        }
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

module.exports = { registerPosRoutes, findPosUser };

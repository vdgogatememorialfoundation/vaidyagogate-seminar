/**
 * Admin payment lookup — find user + registration + order state for manual order creation.
 */

function findUser(db, q, cb) {
    const raw = String(q || '').trim();
    if (!raw) return cb(null, null);
    const lower = raw.toLowerCase();
    db.get(
        `SELECT id, user_id_string, email, phone, first_name, middle_name, last_name, user_role
         FROM users
         WHERE lower(trim(user_id_string)) = ? OR lower(trim(email)) = ? OR replace(replace(trim(phone), ' ', ''), '-', '') = replace(replace(?, ' ', ''), '-', '')
         LIMIT 1`,
        [lower, lower, raw.replace(/\s/g, '')],
        (e, row) => {
            if (e) return cb(e);
            cb(null, row || null);
        }
    );
}

function lookupPaymentContext(db, { query, seminarId }, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return cb(new Error('seminarId is required'));
    }
    findUser(db, query, (e, user) => {
        if (e) return cb(e);
        if (!user) return cb(null, { found: false, message: 'No user found for this ID, email, or phone.' });
        db.get(`SELECT id, title, price, event_date FROM seminars WHERE id = ?`, [sid], (eS, seminar) => {
            if (eS) return cb(eS);
            if (!seminar) return cb(null, { found: false, message: 'Seminar not found.' });
            db.get(
                `SELECT r.id, r.application_no, r.status, r.created_at,
                        o.id AS order_id, o.order_id_string, o.amount AS order_amount, o.status AS order_status,
                        o.payment_gateway, o.payment_date, o.provider_transaction_id,
                        t.ticket_id_string
                 FROM registrations r
                 LEFT JOIN orders o ON o.registration_id = r.id AND o.id = (
                     SELECT id FROM orders WHERE registration_id = r.id ORDER BY id DESC LIMIT 1
                 )
                 LEFT JOIN tickets t ON t.order_id = o.id
                 WHERE r.user_id = ? AND r.seminar_id = ?
                 ORDER BY r.id DESC LIMIT 1`,
                [user.id, sid],
                (eR, reg) => {
                    if (eR) return cb(eR);
                    const basePrice = Number(seminar.price) || 0;
                    const name = [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(' ');
                    cb(null, {
                        found: true,
                        user: {
                            id: user.id,
                            userIdString: user.user_id_string,
                            name,
                            email: user.email,
                            phone: user.phone
                        },
                        seminar: {
                            id: seminar.id,
                            title: seminar.title,
                            price: basePrice,
                            eventDate: seminar.event_date
                        },
                        registration: reg
                            ? {
                                  id: reg.id,
                                  applicationNo: reg.application_no,
                                  status: reg.status,
                                  createdAt: reg.created_at
                              }
                            : null,
                        order: reg && reg.order_id
                            ? {
                                  id: reg.order_id,
                                  orderIdString: reg.order_id_string,
                                  amount: reg.order_amount,
                                  status: reg.order_status,
                                  gateway: reg.payment_gateway,
                                  paymentDate: reg.payment_date,
                                  providerTransactionId: reg.provider_transaction_id,
                                  ticketIdString: reg.ticket_id_string
                              }
                            : null,
                        paid:
                            (reg && reg.order_status === 'success') ||
                            (reg &&
                                ['completed', 'checked_in', 'e_ticket_issued'].includes(
                                    String(reg.status || '').toLowerCase()
                                )),
                        suggestedAmount: basePrice,
                        needsRegistration: !reg,
                        canCollectPayment:
                            !!reg &&
                            reg.order_status !== 'success' &&
                            !['rejected', 'cancelled'].includes(String(reg.status || '').toLowerCase())
                    });
                }
            );
        });
    });
}

/**
 * Ensure registration exists and is eligible for payment (approve if needed).
 */
function ensureRegistrationForPayment(db, { userId, seminarId }, portalTracking, notifEngine, cb) {
    const uid = parseInt(userId, 10);
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(uid) || !Number.isInteger(sid)) {
        return cb(new Error('userId and seminarId required'));
    }
    db.get(
        `SELECT r.* FROM registrations r WHERE r.user_id = ? AND r.seminar_id = ? ORDER BY r.id DESC LIMIT 1`,
        [uid, sid],
        (e, reg) => {
            if (e) return cb(e);
            if (reg) {
                const st = String(reg.status || '').toLowerCase();
                if (st === 'rejected' || st === 'cancelled') {
                    return cb(null, { error: 'Application is closed (rejected/cancelled).' });
                }
                if (st === 'submitted' || st === 'under_review') {
                    return db.run(
                        `UPDATE registrations SET status = 'approved_pending_payment', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [reg.id],
                        (uErr) => {
                            if (uErr) return cb(uErr);
                            reg.status = 'approved_pending_payment';
                            cb(null, { registration: reg, created: false, approved: true });
                        }
                    );
                }
                return cb(null, { registration: reg, created: false, approved: false });
            }
            db.get(`SELECT first_name, last_name, email, phone FROM users WHERE id = ?`, [uid], (eU, u) => {
                if (eU) return cb(eU);
                if (!u) return cb(new Error('User not found'));
                const appNo = 'APP_' + Date.now().toString(36).toUpperCase();
                db.run(
                    `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data, created_at, updated_at)
                     VALUES (?, ?, ?, 'approved_pending_payment', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [
                        uid,
                        sid,
                        appNo,
                        JSON.stringify({
                            first_name: u.first_name,
                            last_name: u.last_name,
                            email: u.email,
                            phone: u.phone,
                            admin_created: true
                        })
                    ],
                    function (insErr) {
                        if (insErr) return cb(insErr);
                        const regRow = {
                            id: this.lastID,
                            user_id: uid,
                            seminar_id: sid,
                            application_no: appNo,
                            status: 'approved_pending_payment'
                        };
                        if (notifEngine) {
                            notifEngine.notify(db, 'APPLICATION_APPROVED', {
                                userId: uid,
                                seminarId: sid,
                                registrationId: regRow.id,
                                vars: { approval_status: 'approved_pending_payment' }
                            });
                        }
                        cb(null, { registration: regRow, created: true, approved: true });
                    }
                );
            });
        }
    );
}

module.exports = {
    lookupPaymentContext,
    ensureRegistrationForPayment,
    findUser
};

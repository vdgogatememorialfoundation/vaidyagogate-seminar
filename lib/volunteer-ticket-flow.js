/**
 * Seminar volunteers: assign from admin, doctor completes registration, then ₹0 ticket + notify.
 */
const volunteerCertFlow = require('./volunteer-cert-flow');

function parseRegFormData(regRow) {
    let fd = regRow && regRow.form_data;
    if (typeof fd === 'string') {
        try {
            fd = JSON.parse(fd);
        } catch (_) {
            fd = {};
        }
    }
    return fd && typeof fd === 'object' ? fd : {};
}

const VOLUNTEER_COMPLETE_STATUSES = new Set([
    'submitted',
    'approved',
    'approved_pending_payment',
    'completed',
    'checked_in',
    'e_ticket_issued',
    'certificate_issued',
    'revision_required',
    'documents_requested'
]);

function isRegistrationCompleteForVolunteer(regRow) {
    if (!regRow || !regRow.id) return false;
    const st = String(regRow.status || '').toLowerCase();
    if (st === 'rejected' || st === 'cancelled' || st === 'draft' || st === 'new' || !st) {
        return false;
    }
    if (!VOLUNTEER_COMPLETE_STATUSES.has(st)) return false;

    const fd = parseRegFormData(regRow);
    if (fd.source === 'pos') return false;

    const qual = String(fd.qual || '').trim();
    if (!qual || qual.toLowerCase() === 'new') return false;

    const required = ['fname', 'lname', 'email', 'phone', 'address', 'pin', 'qual'];
    for (const k of required) {
        if (!fd[k] || !String(fd[k]).trim()) return false;
    }
    return true;
}

function loadVolunteerAssignment(db, userId, seminarId, cb) {
    db.get(
        `SELECT * FROM seminar_volunteers WHERE user_id = ? AND seminar_id = ? AND status IN ('pending', 'approved')`,
        [userId, seminarId],
        cb
    );
}

function loadRegistration(db, userId, seminarId, registrationId, cb) {
    if (registrationId) {
        return db.get(`SELECT * FROM registrations WHERE id = ? AND user_id = ? AND seminar_id = ?`, [
            registrationId,
            userId,
            seminarId
        ], cb);
    }
    db.get(
        `SELECT * FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
        [userId, seminarId],
        cb
    );
}

function hasVolunteerTicketOrder(db, registrationId, cb) {
    db.get(
        `SELECT o.id FROM orders o
         WHERE o.registration_id = ? AND lower(trim(o.status)) = 'success'
           AND (o.payment_gateway = 'volunteer_waiver' OR IFNULL(o.amount, 0) = 0)
         LIMIT 1`,
        [registrationId],
        (e, row) => cb(e, !!(row && row.id))
    );
}

/**
 * Issue ₹0 order, VOL_ ticket, dual certificates, queued notifications.
 */
function fulfillVolunteerAfterRegistration(db, deps, params, cb) {
    const uid = parseInt(params.userId, 10);
    const sid = parseInt(params.seminarId, 10);
    const regIdParam = params.registrationId != null ? parseInt(params.registrationId, 10) : null;
    const adminUserId = params.adminUserId != null ? parseInt(params.adminUserId, 10) : null;
    const {
        generateId,
        insertParticipantTicket,
        syncCertificateEligibilityForTicket,
        certVerify,
        notifEngine,
        notifyTicketIssued,
        buildDisplayNameFromFormData,
        markRegistrationETicketIssued
    } = deps;

    if (!Number.isInteger(uid) || !Number.isInteger(sid)) {
        return cb(null, { skipped: true, reason: 'invalid_ids' });
    }

    loadVolunteerAssignment(db, uid, sid, (eVol, vol) => {
        if (eVol) return cb(eVol);
        if (!vol) return cb(null, { skipped: true, reason: 'not_assigned' });
        if (vol.volunteer_ticket_id_string && String(vol.volunteer_ticket_id_string).trim()) {
            return cb(null, { skipped: true, reason: 'already_issued', ticketId: vol.volunteer_ticket_id_string });
        }

        loadRegistration(db, uid, sid, regIdParam, (eReg, reg) => {
            if (eReg) return cb(eReg);
            if (!isRegistrationCompleteForVolunteer(reg)) {
                return cb(null, {
                    skipped: true,
                    reason: 'registration_incomplete',
                    message: 'Doctor must complete seminar registration before a free volunteer ticket can be issued.'
                });
            }

            hasVolunteerTicketOrder(db, reg.id, (eOrd, hasOrd) => {
                if (eOrd) return cb(eOrd);
                if (hasOrd) {
                    return cb(null, { skipped: true, reason: 'order_exists' });
                }

                const ticketStr = 'VOL_' + generateId();
                const orderStr = 'ORD_VOL_' + generateId();
                const dn = buildDisplayNameFromFormData(reg.form_data, {});

                db.run(
                    `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date, payment_gateway)
                     VALUES (?, ?, 0, 'success', CURRENT_TIMESTAMP, 'volunteer_waiver')`,
                    [orderStr, reg.id],
                    function (oErr) {
                        if (oErr) return cb(oErr);
                        const orderId = this.lastID;
                        insertParticipantTicket(
                            orderId,
                            uid,
                            orderStr,
                            reg.id,
                            reg.application_no,
                            (tErr, _etk, qrData) => {
                                if (tErr) return cb(tErr);
                                db.run(
                                    `UPDATE tickets SET ticket_id_string = ? WHERE order_id = ?`,
                                    [ticketStr, orderId],
                                    () => {
                                        if (markRegistrationETicketIssued) {
                                            markRegistrationETicketIssued(db, reg.id, () => {});
                                        }
                                        applyVolunteerDoctorPortalRole(db, uid, () => {});
                                        db.run(
                                            `UPDATE seminar_volunteers SET status = 'approved', approved_by = COALESCE(?, approved_by),
                                             approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), volunteer_ticket_id_string = ? WHERE id = ?`,
                                            [adminUserId || null, ticketStr, vol.id],
                                            (uErr) => {
                                                if (uErr) return cb(uErr);
                                                db.get(
                                                    `SELECT id, qr_code_data FROM tickets WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
                                                    [orderId],
                                                    (eTid, trow) => {
                                                        const ticketDbId =
                                                            !eTid && trow && trow.id ? trow.id : null;
                                                        if (ticketDbId && trow.qr_code_data) {
                                                            try {
                                                                const qr = JSON.parse(trow.qr_code_data);
                                                                qr.ticketId = ticketStr;
                                                                qr.volunteer = true;
                                                                qr.dualCertificates = true;
                                                                db.run(
                                                                    `UPDATE tickets SET qr_code_data = ? WHERE id = ?`,
                                                                    [JSON.stringify(qr), ticketDbId],
                                                                    () => {}
                                                                );
                                                            } catch (_) {}
                                                        }
                                                        volunteerCertFlow.autoIssueDualVolunteerCertificates(
                                                            db,
                                                            certVerify,
                                                            {
                                                                userId: uid,
                                                                seminarId: sid,
                                                                registrationId: reg.id,
                                                                displayName: dn,
                                                                ticketId: ticketDbId,
                                                                adminUserId,
                                                                scanVerified: 0,
                                                                scanTime: null
                                                            },
                                                            (certErr) => {
                                                                if (certErr) return cb(certErr);
                                                                if (ticketDbId) {
                                                                    syncCertificateEligibilityForTicket(
                                                                        ticketDbId,
                                                                        () => {}
                                                                    );
                                                                }
                                                                if (notifEngine) {
                                                                    notifEngine.notify(
                                                                        db,
                                                                        'PAYMENT_SUCCESS',
                                                                        {
                                                                            userId: uid,
                                                                            seminarId: sid,
                                                                            registrationId: reg.id,
                                                                            immediate: false,
                                                                            vars: {
                                                                                payment_amount: 0,
                                                                                payment_status: 'PAID',
                                                                                payment_method: 'Volunteer (no fee)'
                                                                            }
                                                                        },
                                                                        () => {}
                                                                    );
                                                                }
                                                                if (notifyTicketIssued && ticketDbId) {
                                                                    notifyTicketIssued(uid, reg.id, ticketStr, {
                                                                        email: true,
                                                                        whatsapp: false,
                                                                        immediate: false,
                                                                        source: 'volunteer'
                                                                    });
                                                                }
                                                                cb(null, {
                                                                    issued: true,
                                                                    ticketId: ticketStr,
                                                                    registrationId: reg.id,
                                                                    message:
                                                                        'Volunteer registration complete. Free e-ticket (₹0) and certificates are ready in the doctor portal.'
                                                                });
                                                            }
                                                        );
                                                    }
                                                );
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    });
}

function tryFulfillVolunteerAfterRegistration(db, deps, params, cb) {
    fulfillVolunteerAfterRegistration(db, deps, params, (err, result) => {
        if (err) {
            console.warn('[volunteer-ticket]', err.message);
            return cb && cb(err);
        }
        if (result && result.issued) {
            console.log('[volunteer-ticket] issued', result.ticketId, 'user', params.userId);
        }
        cb && cb(null, result);
    });
}

function ensureVolunteerRegistrationOverride(db, userId, seminarId, adminUserId, cb) {
    db.run(
        `INSERT INTO registration_overrides (user_id, seminar_id, enabled, note, created_by)
         VALUES (?, ?, 1, 'Seminar volunteer — may register after public window', ?)
         ON CONFLICT(user_id, seminar_id) DO UPDATE SET enabled = 1, note = excluded.note`,
        [userId, seminarId, adminUserId || null],
        cb
    );
}

function userIsPendingSeminarVolunteer(db, userId, seminarId, cb) {
    db.get(
        `SELECT id FROM seminar_volunteers
         WHERE user_id = ? AND seminar_id = ? AND status = 'pending'
           AND (volunteer_ticket_id_string IS NULL OR trim(volunteer_ticket_id_string) = '')`,
        [userId, seminarId],
        (e, row) => cb(e, !!(row && row.id))
    );
}

function applyVolunteerDoctorPortalRole(db, userId, cb) {
    const modulesJson = JSON.stringify({
        'tab-dashboard': true,
        'tab-profile': true,
        'tab-volunteer': true,
        'tab-ticket': true,
        'tab-certificate': true,
        'tab-reset-pwd': true
    });
    db.run(
        `UPDATE users SET doctor_category = 'volunteer', doctor_modules = ?
         WHERE id = ? AND lower(trim(COALESCE(role, ''))) IN ('doctor', 'volunteer', '')`,
        [modulesJson, userId],
        cb
    );
}

module.exports = {
    parseRegFormData,
    isRegistrationCompleteForVolunteer,
    fulfillVolunteerAfterRegistration,
    tryFulfillVolunteerAfterRegistration,
    ensureVolunteerRegistrationOverride,
    userIsPendingSeminarVolunteer,
    applyVolunteerDoctorPortalRole,
    loadVolunteerAssignment
};

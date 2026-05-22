/**
 * Permanently delete a portal user (doctor or staff) and related data.
 */
const userRoles = require('./user-roles');

function runSteps(db, steps, cb) {
    let i = 0;
    const next = (err) => {
        if (err) return cb(err);
        if (i >= steps.length) return cb(null);
        const [sql, params] = steps[i++];
        db.run(sql, params, (runErr) => {
            if (runErr && !/no such table|does not exist|undefined table/i.test(String(runErr.message))) {
                return cb(runErr);
            }
            next();
        });
    };
    next();
}

function isSuperAdminRow(row) {
    if (!row) return false;
    const r = String(row.role || '').toLowerCase();
    const ur = String(row.user_role || '').trim().toLowerCase();
    return r === 'admin' && ur !== 'co_admin';
}

function deleteCaseSubmissionById(db, subId, cb) {
    const sid = parseInt(subId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(null);
    runSteps(
        db,
        [
            [`DELETE FROM case_judge_scores WHERE submission_id = ?`, [sid]],
            [`DELETE FROM case_judge_assignments WHERE submission_id = ?`, [sid]],
            [`DELETE FROM case_status_log WHERE submission_id = ?`, [sid]],
            [`DELETE FROM case_files WHERE submission_id = ?`, [sid]],
            [`DELETE FROM case_submissions WHERE id = ?`, [sid]]
        ],
        cb
    );
}

function deleteAllRegistrationsForUser(db, userId, deleteRegistrationCascade, cb) {
    const uid = parseInt(userId, 10);
    db.all(`SELECT id FROM registrations WHERE user_id = ?`, [uid], (e, rows) => {
        if (e) return cb(e);
        const list = rows || [];
        let i = 0;
        const next = (err) => {
            if (err) return cb(err);
            if (i >= list.length) return cb(null, list.length);
            deleteRegistrationCascade(list[i++].id, next);
        };
        next();
    });
}

function deleteAllCaseSubmissionsForUser(db, userId, cb) {
    const uid = parseInt(userId, 10);
    db.all(`SELECT id FROM case_submissions WHERE user_id = ?`, [uid], (e, rows) => {
        if (e) return cb(e);
        const list = rows || [];
        let i = 0;
        const next = (err) => {
            if (err) return cb(err);
            if (i >= list.length) return cb(null, list.length);
            deleteCaseSubmissionById(db, list[i++].id, next);
        };
        next();
    });
}

function deleteSupportTicketsForUser(db, userId, cb) {
    const uid = parseInt(userId, 10);
    db.all(
        `SELECT COALESCE(ticket_id, tracking_id) AS tid FROM support_tickets WHERE user_id = ?`,
        [uid],
        (e, rows) => {
            if (e) return cb(e);
            const ids = (rows || []).map((r) => r.tid).filter(Boolean);
            if (!ids.length) return cb(null);
            const placeholders = ids.map(() => '?').join(',');
            runSteps(
                db,
                [
                    [`DELETE FROM ticket_messages WHERE ticket_id IN (${placeholders})`, ids],
                    [`DELETE FROM support_tickets WHERE user_id = ?`, [uid]]
                ],
                cb
            );
        }
    );
}

function purgeUserScopedRows(db, userId, cb) {
    const uid = parseInt(userId, 10);
    const steps = [
        [`DELETE FROM case_judge_scores WHERE judge_user_id = ?`, [uid]],
        [`DELETE FROM case_judge_assignments WHERE judge_user_id = ?`, [uid]],
        [`DELETE FROM case_participant_messages WHERE judge_user_id = ? OR author_user_id = ?`, [uid, uid]],
        [`DELETE FROM judge_communication_log WHERE judge_user_id = ? OR participant_user_id = ?`, [uid, uid]],
        [`DELETE FROM case_pending_uploads WHERE user_id = ?`, [uid]],
        [`DELETE FROM abstracts WHERE user_id = ?`, [uid]],
        [`DELETE FROM supplemental_payments WHERE user_id = ?`, [uid]],
        [`DELETE FROM seminar_volunteers WHERE user_id = ?`, [uid]],
        [`UPDATE seminar_volunteers SET approved_by = NULL WHERE approved_by = ?`, [uid]],
        [`DELETE FROM user_certificates WHERE user_id = ?`, [uid]],
        [`DELETE FROM volunteer_certificates WHERE user_id = ?`, [uid]],
        [`DELETE FROM registration_overrides WHERE user_id = ?`, [uid]],
        [`DELETE FROM ticket_scan_events WHERE doctor_user_id = ? OR scanned_by = ?`, [uid, uid]],
        [`DELETE FROM tickets WHERE user_id = ?`, [uid]],
        [`DELETE FROM interactive_session_registrations WHERE user_id = ?`, [uid]],
        [`DELETE FROM seminar_feedback WHERE user_id = ?`, [uid]],
        [`DELETE FROM cancellation_requests WHERE user_id = ?`, [uid]],
        [`DELETE FROM application_edits WHERE edited_by_user_id = ?`, [uid]],
        [`DELETE FROM notification_logs WHERE user_id = ?`, [uid]],
        [`DELETE FROM user_activity_logs WHERE user_id = ?`, [uid]],
        [`DELETE FROM otp_verification_tokens WHERE user_id = ?`, [uid]],
        [`DELETE FROM email_verify_tokens WHERE user_id = ?`, [uid]],
        [`DELETE FROM live_chat_messages WHERE sender_id = ?`, [uid]],
        [`DELETE FROM live_chat_sessions WHERE user_id = ? OR admin_id = ?`, [uid, uid]],
        [`UPDATE certificate_templates SET uploaded_by = NULL WHERE uploaded_by = ?`, [uid]],
        [`DELETE FROM doctor_profile WHERE user_id = ?`, [uid]],
        [`DELETE FROM users WHERE id = ?`, [uid]]
    ];
    runSteps(db, steps, cb);
}

/**
 * @param {object} opts
 * @param {number} opts.actingAdminId
 * @param {string} opts.confirmPortalId - must match target user_id_string
 */
function deleteUserAccount(db, userId, deleteRegistrationCascade, opts, cb) {
    const uid = parseInt(userId, 10);
    const actingAdminId = parseInt(opts && opts.actingAdminId, 10);
    const confirm = String((opts && opts.confirmPortalId) || '')
        .trim()
        .toLowerCase();
    if (!Number.isInteger(uid) || uid < 1) return cb(new Error('Invalid user id'));
    if (!Number.isInteger(actingAdminId) || actingAdminId < 1) {
        return cb(new Error('actingAdminId is required'));
    }
    if (!confirm) return cb(new Error('Portal ID confirmation is required'));

    db.get(
        `SELECT id, user_id_string, first_name, last_name, email, role, user_role FROM users WHERE id = ?`,
        [uid],
        (e0, target) => {
            if (e0) return cb(e0);
            if (!target) return cb(new Error('User not found'));
            const portal = String(target.user_id_string || '')
                .trim()
                .toLowerCase();
            if (portal !== confirm) {
                return cb(new Error('Confirmation does not match this user’s portal ID.'));
            }
            if (Number(target.id) === actingAdminId) {
                return cb(new Error('You cannot delete your own account while logged in.'));
            }
            if (isSuperAdminRow(target)) {
                return cb(new Error('The primary Super Admin account cannot be deleted.'));
            }

            db.get(
                `SELECT id, role, user_role FROM users WHERE id = ?`,
                [actingAdminId],
                (eAct, actor) => {
                    if (eAct) return cb(eAct);
                    if (!actor) return cb(new Error('Administrator session invalid'));
                    const actorOk =
                        isSuperAdminRow(actor) ||
                        String(actor.user_role || '').toLowerCase() === 'co_admin';
                    if (!actorOk) {
                        return cb(new Error('Only Super Admin or Co Admin can delete accounts.'));
                    }

                    deleteAllRegistrationsForUser(db, uid, deleteRegistrationCascade, (e1) => {
                        if (e1) return cb(e1);
                        deleteAllCaseSubmissionsForUser(db, uid, (e2) => {
                            if (e2) return cb(e2);
                            deleteSupportTicketsForUser(db, uid, (e3) => {
                                if (e3) return cb(e3);
                                purgeUserScopedRows(db, uid, (e4) => {
                                    if (e4) return cb(e4);
                                    cb(null, {
                                        deleted: true,
                                        userId: uid,
                                        portalId: target.user_id_string,
                                        accountType: userRoles.isDoctorPortalAccount(target)
                                            ? 'doctor'
                                            : 'staff'
                                    });
                                });
                            });
                        });
                    });
                }
            );
        }
    );
}

module.exports = {
    deleteUserAccount,
    isSuperAdminRow
};

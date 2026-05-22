/**
 * Auto-issue participant + volunteer certificates for seminar volunteers.
 * Ticket QR scans update eligibility for both cert types.
 */
const certRender = require('./certificate-render');

function getActiveTemplateId(db, seminarId, certType, cb) {
    certRender.getActiveTemplate(db, seminarId, certType, (e, tpl) => {
        if (e) return cb(e);
        cb(null, tpl && tpl.id ? tpl.id : null);
    });
}

function ensureBuiltinTemplateIfMissing(db, seminarId, certType, adminUserId, cb) {
    getActiveTemplateId(db, seminarId, certType, (e, tid) => {
        if (e) return cb(e);
        if (tid) return cb(null, tid);
        certRender.applyBuiltinTemplate(db, { seminarId, certType, adminUserId }, (e2, out) => {
            if (e2) return cb(e2);
            cb(null, out && out.templateId ? out.templateId : null);
        });
    });
}

function ensureBothTemplates(db, seminarId, adminUserId, cb) {
    ensureBuiltinTemplateIfMissing(db, seminarId, 'participant', adminUserId, (e1, pTpl) => {
        if (e1) return cb(e1);
        ensureBuiltinTemplateIfMissing(db, seminarId, 'volunteer', adminUserId, (e2, vTpl) => {
            if (e2) return cb(e2);
            cb(null, { participantTemplateId: pTpl, volunteerTemplateId: vTpl });
        });
    });
}

/**
 * Enable both certificates with verify tokens (scan_verified updated on venue scan).
 */
function autoIssueDualVolunteerCertificates(db, certVerify, params, cb) {
    const uid = parseInt(params.userId, 10);
    const sid = parseInt(params.seminarId, 10);
    const regId = params.registrationId != null ? parseInt(params.registrationId, 10) : null;
    const ticketId = params.ticketId != null ? parseInt(params.ticketId, 10) : null;
    const displayName = String(params.displayName || '').trim() || 'Volunteer';
    const adminUserId = params.adminUserId != null ? parseInt(params.adminUserId, 10) : null;
    const scanVerified = params.scanVerified ? 1 : 0;
    const scanTime = params.scanTime || null;

    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(sid) || sid < 1) {
        return cb(new Error('userId and seminarId required'));
    }
    if (!certVerify) return cb(new Error('Certificate verification module not loaded'));

    ensureBothTemplates(db, sid, adminUserId, (eTpl, tpls) => {
        if (eTpl) return cb(eTpl);
        const pTpl = tpls.participantTemplateId;
        const vTpl = tpls.volunteerTemplateId;

        db.run(
            `INSERT INTO user_certificates (user_id, seminar_id, registration_id, ticket_id, display_name, template_id, enabled, scan_verified, scan_time, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id, seminar_id) DO UPDATE SET
               registration_id = COALESCE(excluded.registration_id, user_certificates.registration_id),
               ticket_id = COALESCE(excluded.ticket_id, user_certificates.ticket_id),
               display_name = COALESCE(excluded.display_name, user_certificates.display_name),
               template_id = COALESCE(excluded.template_id, user_certificates.template_id),
               enabled = 1,
               scan_verified = CASE WHEN excluded.scan_verified = 1 THEN 1 ELSE user_certificates.scan_verified END,
               scan_time = COALESCE(excluded.scan_time, user_certificates.scan_time),
               updated_at = CURRENT_TIMESTAMP`,
            [uid, sid, regId, ticketId, displayName, pTpl, scanVerified, scanTime],
            (eP) => {
                if (eP) return cb(eP);
                db.run(
                    `INSERT INTO volunteer_certificates (user_id, seminar_id, registration_id, display_name, template_id, enabled, scan_verified, scan_time, updated_at)
                     VALUES (?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                       registration_id = COALESCE(excluded.registration_id, volunteer_certificates.registration_id),
                       display_name = COALESCE(excluded.display_name, volunteer_certificates.display_name),
                       template_id = COALESCE(excluded.template_id, volunteer_certificates.template_id),
                       enabled = 1,
                       scan_verified = CASE WHEN excluded.scan_verified = 1 THEN 1 ELSE volunteer_certificates.scan_verified END,
                       scan_time = COALESCE(excluded.scan_time, volunteer_certificates.scan_time),
                       updated_at = CURRENT_TIMESTAMP`,
                    [uid, sid, regId, displayName, vTpl, scanVerified, scanTime],
                    (eV) => {
                        if (eV) return cb(eV);
                        db.get(
                            `SELECT id FROM user_certificates WHERE user_id = ? AND seminar_id = ?`,
                            [uid, sid],
                            (eUc, uc) => {
                                if (eUc) return cb(eUc);
                                db.get(
                                    `SELECT id FROM volunteer_certificates WHERE user_id = ? AND seminar_id = ?`,
                                    [uid, sid],
                                    (eVc, vc) => {
                                        if (eVc) return cb(eVc);
                                        const tasks = [];
                                        if (uc && uc.id) {
                                            tasks.push(
                                                new Promise((res, rej) => {
                                                    certVerify.ensureUserCertVerifyToken(db, uc.id, (e, tok) =>
                                                        e ? rej(e) : res({ participantToken: tok })
                                                    );
                                                })
                                            );
                                        }
                                        if (vc && vc.id) {
                                            tasks.push(
                                                new Promise((res, rej) => {
                                                    certVerify.ensureVolunteerCertVerifyToken(db, vc.id, (e, tok) =>
                                                        e ? rej(e) : res({ volunteerToken: tok })
                                                    );
                                                })
                                            );
                                        }
                                        Promise.all(tasks)
                                            .then((parts) => {
                                                const out = Object.assign({}, ...parts, {
                                                    participantCertId: uc && uc.id,
                                                    volunteerCertId: vc && vc.id
                                                });
                                                cb(null, out);
                                            })
                                            .catch((err) => cb(err));
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}

/**
 * After ticket scan — sync participant + volunteer certificate scan_verified for approved volunteers.
 */
function displayNameFromRow(row, buildDisplayNameFromFormData) {
    if (typeof buildDisplayNameFromFormData === 'function') {
        return buildDisplayNameFromFormData(row.form_data, row) || 'Volunteer';
    }
    const fn = row.first_name || '';
    const ln = row.last_name || '';
    const mn = row.middle_name || '';
    return [fn, mn, ln].filter(Boolean).join(' ').trim() || 'Volunteer';
}

function syncDualCertEligibilityFromTicketScan(db, certVerify, ticketId, buildDisplayNameFromFormData, cb) {
    if (typeof buildDisplayNameFromFormData === 'function' && typeof cb !== 'function') {
        cb = buildDisplayNameFromFormData;
        buildDisplayNameFromFormData = null;
    }
    const q = `
        SELECT t.id AS ticket_id, IFNULL(t.scan_count, 0) AS scan_count, t.scan_time, t.user_id, t.order_id,
               r.id AS registration_id, r.seminar_id, r.form_data,
               u.first_name, u.middle_name, u.last_name,
               o.status AS order_status,
               IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
               sv.id AS volunteer_row_id, sv.status AS volunteer_status
        FROM tickets t
        JOIN orders o ON o.id = t.order_id
        JOIN registrations r ON r.id = o.registration_id
        JOIN seminars s ON s.id = r.seminar_id
        JOIN users u ON u.id = t.user_id
        LEFT JOIN seminar_volunteers sv ON sv.user_id = t.user_id AND sv.seminar_id = r.seminar_id AND sv.status = 'approved'
        WHERE t.id = ?
    `;
    db.get(q, [ticketId], (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null);
        const dn = displayNameFromRow(row, buildDisplayNameFromFormData);

        const paid = String(row.order_status || '').toLowerCase() === 'success';
        const scansOk = certVerify.ticketMeetsScanRequirement(row.scan_count, row.cert_scans_required);
        const scanVerified = paid && scansOk ? 1 : 0;
        const isVolunteer = !!(row.volunteer_row_id && row.volunteer_status === 'approved');

        getActiveTemplateId(db, row.seminar_id, 'participant', (e2, pTpl) => {
            if (e2) return cb && cb(e2);
            db.run(
                `INSERT INTO user_certificates (user_id, seminar_id, ticket_id, registration_id, display_name, template_id, enabled, scan_verified, scan_time, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                   ticket_id = excluded.ticket_id,
                   registration_id = excluded.registration_id,
                   display_name = COALESCE(excluded.display_name, user_certificates.display_name),
                   template_id = COALESCE(excluded.template_id, user_certificates.template_id),
                   enabled = CASE WHEN user_certificates.enabled = 1 THEN 1 ELSE user_certificates.enabled END,
                   scan_verified = excluded.scan_verified,
                   scan_time = excluded.scan_time,
                   updated_at = CURRENT_TIMESTAMP`,
                [
                    row.user_id,
                    row.seminar_id,
                    row.ticket_id,
                    row.registration_id,
                    dn,
                    pTpl,
                    scanVerified,
                    row.scan_time || null
                ],
                () => {
                    if (!isVolunteer) return cb && cb(null);
                    getActiveTemplateId(db, row.seminar_id, 'volunteer', (e3, vTpl) => {
                        if (e3) return cb && cb(e3);
                        db.run(
                            `INSERT INTO volunteer_certificates (user_id, seminar_id, registration_id, display_name, template_id, enabled, scan_verified, scan_time, updated_at)
                             VALUES (?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
                             ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                               display_name = COALESCE(excluded.display_name, volunteer_certificates.display_name),
                               template_id = COALESCE(excluded.template_id, volunteer_certificates.template_id),
                               enabled = CASE WHEN volunteer_certificates.enabled = 1 THEN 1 ELSE volunteer_certificates.enabled END,
                               scan_verified = excluded.scan_verified,
                               scan_time = excluded.scan_time,
                               updated_at = CURRENT_TIMESTAMP`,
                            [
                                row.user_id,
                                row.seminar_id,
                                row.registration_id,
                                dn,
                                vTpl,
                                scanVerified,
                                row.scan_time || null
                            ],
                            () => cb && cb(null)
                        );
                    });
                }
            );
        });
    });
}

module.exports = {
    ensureBothTemplates,
    autoIssueDualVolunteerCertificates,
    syncDualCertEligibilityFromTicketScan
};

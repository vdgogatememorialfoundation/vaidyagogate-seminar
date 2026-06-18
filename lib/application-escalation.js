/**
 * Seminar application escalation — L1 → L2 → L3 with notes and reviewer notifications.
 */
const appAuthority = require('./application-authority');
const supportDeskNotify = require('./support-desk-notify');
const notifEngine = require('./notification-engine');
const { PATHS } = require('./app-paths');

const REVIEWABLE_STATUSES = new Set([
    'submitted',
    'waitlisted',
    'pending_approval',
    'revision_required',
    'documents_requested'
]);

function parseEscalationJson(raw) {
    if (!raw) return { history: [] };
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!o || typeof o !== 'object') return { history: [] };
        if (!Array.isArray(o.history)) o.history = [];
        return o;
    } catch (_) {
        return { history: [] };
    }
}

function stringifyEscalationJson(obj) {
    return JSON.stringify(obj || { history: [] });
}

function registrationReviewLevel(row) {
    return appAuthority.clampLevel(row && row.review_required_level);
}

function canEscalateRegistration(row) {
    const st = String((row && row.status) || '').toLowerCase();
    if (!REVIEWABLE_STATUSES.has(st)) {
        return { ok: false, error: 'This application is not in a reviewable status for escalation.' };
    }
    const level = registrationReviewLevel(row);
    if (level >= 3) {
        return {
            ok: false,
            error: 'This application already requires highest authority. Contact super admin if further help is needed.'
        };
    }
    return { ok: true, currentLevel: level, newLevel: level + 1 };
}

function escalateSeminarApplication(db, registrationId, actorUser, note, deps, cb) {
    const rid = parseInt(registrationId, 10);
    const actorNote = String(note || '').trim();
    if (!Number.isInteger(rid) || rid < 1) {
        return cb(null, { ok: false, error: 'Invalid application id' });
    }
    if (!actorUser || !actorUser.id) {
        return cb(null, { ok: false, error: 'Reviewer account required' });
    }

    db.get(
        `SELECT r.*, u.first_name, u.last_name, u.email, s.title AS seminar_title
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [rid],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, { ok: false, error: 'Application not found' });

            const gate = canEscalateRegistration(row);
            if (!gate.ok) return cb(null, { ok: false, error: gate.error });

            appAuthority.checkApplicationAuthority(
                db,
                actorUser,
                row,
                'Escalation',
                (eAuth, auth) => {
                    if (eAuth) return cb(eAuth);
                    if (!auth.ok) return cb(null, { ok: false, error: auth.error });

                    const newLevel = gate.newLevel;
                    const agentName =
                        [actorUser.first_name, actorUser.last_name].filter(Boolean).join(' ') || 'Reviewer';
                    const esc = parseEscalationJson(row.review_escalation_json);
                    esc.history.push({
                        at: new Date().toISOString(),
                        by: actorUser.id,
                        by_name: agentName,
                        from_level: gate.currentLevel,
                        to_level: newLevel,
                        note: actorNote || null
                    });
                    esc.latest_note = actorNote || null;

                    const systemMsg =
                        'Application escalated to ' +
                        appAuthority.requiredLevelLabel(newLevel) +
                        ' by ' +
                        agentName +
                        (actorNote ? '. Note: ' + actorNote : '.');

                    db.run(
                        `UPDATE registrations SET review_required_level = ?, review_assigned_to = NULL,
                         review_escalated_at = CURRENT_TIMESTAMP, review_escalated_by = ?,
                         review_escalation_json = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [newLevel, actorUser.id, stringifyEscalationJson(esc), rid],
                        (uErr) => {
                            if (uErr) return cb(uErr);
                            const portalTracking = deps && deps.portalTracking;
                            if (portalTracking && portalTracking.logRegistrationEvent) {
                                portalTracking.logRegistrationEvent(
                                    db,
                                    rid,
                                    'application_escalated',
                                    'Escalated for higher review',
                                    systemMsg,
                                    () => {}
                                );
                            }
                            notifyReviewersApplicationEscalated(db, row, newLevel, actorNote, () => {
                                cb(null, {
                                    ok: true,
                                    reviewRequiredLevel: newLevel,
                                    reviewRequiredLabel: appAuthority.requiredLevelLabel(newLevel),
                                    message: systemMsg
                                });
                            });
                        }
                    );
                }
            );
        }
    );
}

function notifyReviewerByEmail(db, userId, subject, text, html, cb) {
    db.get(`SELECT id, email FROM users WHERE id = ?`, [parseInt(userId, 10)], (e, u) => {
        if (e || !u || !u.email) return cb && cb(e || null, { skipped: true });
        notifEngine.enqueueDirectMessage(
            db,
            {
                channel: 'email',
                destination: u.email,
                subject,
                text,
                html,
                event_key: 'APPLICATION_REVIEW_ESCALATED',
                immediate: true
            },
            cb
        );
    });
}

function notifyReviewersApplicationEscalated(db, registrationRow, minLevel, note, cb) {
    const appNo = registrationRow.application_no || String(registrationRow.id);
    const staffLink = notifEngine.publicBaseUrl().replace(/\/$/, '') + PATHS.staffLogin;
    const adminLink = notifEngine.publicBaseUrl().replace(/\/$/, '') + PATHS.admin;
    const title =
        'Seminar application needs ' + appAuthority.levelLabel(minLevel) + ': ' + appNo;
    const body =
        (registrationRow.seminar_title ? registrationRow.seminar_title + '\n' : '') +
        'Applicant: ' +
        [registrationRow.first_name, registrationRow.last_name].filter(Boolean).join(' ') +
        (note ? '\n\n' + note : '') +
        '\n\nRequired authority: ' +
        appAuthority.requiredLevelLabel(minLevel);

    db.all(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.user_role, u.staff_modules,
                COALESCE(p.authority_level, 1) AS authority_level
         FROM users u
         LEFT JOIN application_reviewer_profiles p ON p.user_id = u.id
         WHERE COALESCE(u.is_disabled,0) = 0
           AND COALESCE(p.authority_level, 1) >= ?`,
        [appAuthority.clampLevel(minLevel)],
        (e, rows) => {
            if (e || !rows || !rows.length) return cb && cb(e);
            const agents = rows.filter((u) => appAuthority.userCanReviewApplications(u));
            if (!agents.length) return cb && cb(null, { notified: 0 });
            let pending = agents.length;
            agents.forEach((a) => {
                const link =
                    String(a.user_role || '').toLowerCase() === 'co_admin' ||
                    String(a.role || '').toLowerCase() === 'admin'
                        ? adminLink
                        : staffLink;
                supportDeskNotify.pushInbox(
                    db,
                    {
                        userId: a.id,
                        type: 'application_escalated',
                        title,
                        body,
                        link,
                        refId: appNo
                    },
                    () => {
                        notifyReviewerByEmail(
                            db,
                            a.id,
                            title,
                            body + '\n\nOpen portal: ' + link,
                            '<p><strong>' +
                                title +
                                '</strong></p><p>' +
                                String(body).replace(/\n/g, '<br>') +
                                '</p><p><a href="' +
                                link +
                                '">Open portal</a></p>',
                            () => {
                                pending--;
                                if (pending <= 0) cb && cb(null, { notified: agents.length });
                            }
                        );
                    }
                );
            });
        }
    );
}

function clearReviewEscalationOnDecision(db, registrationId, cb) {
    db.run(
        `UPDATE registrations SET review_required_level = 1, review_assigned_to = NULL,
         review_escalated_at = NULL, review_escalated_by = NULL
         WHERE id = ?`,
        [parseInt(registrationId, 10)],
        cb
    );
}

function saveApplicationReviewerProfile(db, userId, body, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb(new Error('Invalid user id'));
    const authorityLevel = Math.max(1, Math.min(3, parseInt(body.authorityLevel, 10) || 1));
    const notes = String((body && body.notes) || '').trim() || null;
    db.get(`SELECT user_id FROM application_reviewer_profiles WHERE user_id = ?`, [uid], (e, row) => {
        if (e) return cb(e);
        const sql = row
            ? `UPDATE application_reviewer_profiles SET authority_level = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
            : `INSERT INTO application_reviewer_profiles (authority_level, notes, user_id) VALUES (?, ?, ?)`;
        db.run(sql, [authorityLevel, notes, uid], function (uErr) {
            if (uErr) return cb(uErr);
            cb(null, { success: true, authorityLevel });
        });
    });
}

function listApplicationReviewers(db, cb) {
    db.all(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.user_role, u.staff_modules,
                p.authority_level, p.notes
         FROM users u
         LEFT JOIN application_reviewer_profiles p ON p.user_id = u.id
         WHERE COALESCE(u.is_disabled,0) = 0
         ORDER BY u.first_name, u.last_name`,
        [],
        (e, rows) => {
            if (e) return cb(e);
            const reviewers = (rows || [])
                .filter((u) => appAuthority.userCanReviewApplications(u))
                .map((u) => ({
                    id: u.id,
                    first_name: u.first_name,
                    last_name: u.last_name,
                    email: u.email,
                    user_role: u.user_role,
                    authority_level: appAuthority.getReviewerAuthorityLevel(u, {
                        authority_level: u.authority_level
                    }),
                    profile_level: u.authority_level,
                    notes: u.notes
                }));
            cb(null, reviewers);
        }
    );
}

module.exports = {
    REVIEWABLE_STATUSES,
    parseEscalationJson,
    registrationReviewLevel,
    canEscalateRegistration,
    escalateSeminarApplication,
    notifyReviewersApplicationEscalated,
    clearReviewEscalationOnDecision,
    saveApplicationReviewerProfile,
    listApplicationReviewers
};

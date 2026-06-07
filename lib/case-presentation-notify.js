/**
 * Email / WhatsApp updates for case presentation participants.
 */
function loadSubmission(db, submissionId, cb) {
    const sid = parseInt(submissionId, 10);
    if (!Number.isInteger(sid)) return cb && cb(null, null);
    db.get(
        `SELECT cs.*, cp.title AS program_title
         FROM case_submissions cs
         LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
         WHERE cs.id = ?`,
        [sid],
        cb
    );
}

function buildCaseNotifyVars(sub, extra) {
    const out = {
        application_no: sub.application_no || String(sub.id),
        case_presentation_title: sub.title || '',
        case_topic: sub.title || '',
        program_title: sub.program_title || '',
        approval_status: sub.status || ''
    };
    if (extra && typeof extra === 'object') {
        Object.keys(extra).forEach((k) => {
            if (extra[k] != null && extra[k] !== '') out[k] = extra[k];
        });
    }
    return out;
}

function notifyCaseDoctor(db, notifEngine, submissionId, eventKey, extraVars, cb) {
    const notify = notifEngine || require('./notification-engine');
    loadSubmission(db, submissionId, (e, sub) => {
        if (e) return cb && cb(e);
        if (!sub || !sub.user_id) return cb && cb(null, { skipped: true });
        notify.notify(
            db,
            eventKey,
            {
                userId: sub.user_id,
                seminarId: sub.seminar_id || null,
                vars: buildCaseNotifyVars(sub, extraVars)
            },
            cb
        );
    });
}

module.exports = { notifyCaseDoctor, buildCaseNotifyVars, loadSubmission };

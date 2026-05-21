/**
 * Transfer case presentation assignment from one judge to another (admin or judge).
 */
const notifEngine = require('./notification-engine');
const integrationSettings = require('./integration-settings');

function resolveJudgeRef(db, ref, cb) {
    const s = String(ref || '').trim();
    if (!s) return cb(new Error('Judge user ID is required'));
    const digits = s.replace(/\D/g, '');
    const portalId = /^USR_/i.test(s) ? s : digits.length >= 10 ? digits : s;
    const asInt = parseInt(s, 10);
    db.get(
        `SELECT id, user_id_string, first_name, last_name, email, role, user_role
         FROM users
         WHERE user_id_string = ? OR id = ?
         LIMIT 1`,
        [portalId, Number.isInteger(asInt) && asInt > 0 ? asInt : -1],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(new Error('No judge account found for that ID'));
            const ur = String(row.user_role || row.role || '').toLowerCase();
            const okJudge = ['judge', 'reviewer', 'judge_user'].includes(ur);
            if (!okJudge) {
                return cb(new Error('Target account is not a judge/reviewer'));
            }
            cb(null, row);
        }
    );
}

function judgePortalUrl() {
    const base =
        integrationSettings.getRuntimeIntegrations().judge_host ||
        integrationSettings.getRuntimeIntegrations().public_base_url ||
        process.env.PUBLIC_BASE_URL ||
        'https://seminar.vaidyagogate.org';
    return String(base).replace(/\/$/, '').replace(/\/doctor\.html$/i, '') + '/judge.html';
}

function loadSubmissionBrief(db, submissionId, cb) {
    db.get(
        `SELECT cs.id, cs.application_no, cs.title, u.first_name, u.last_name, u.email
         FROM case_submissions cs
         JOIN users u ON u.id = cs.user_id
         WHERE cs.id = ?`,
        [submissionId],
        cb
    );
}

function notifyJudgeTransfer(db, judgeRow, eventKey, vars, cb) {
    if (!judgeRow || !judgeRow.id) return cb && cb(null, { skipped: true });
    notifEngine.notify(
        db,
        eventKey,
        {
            userId: judgeRow.id,
            vars: Object.assign(
                {
                    portal_login_url: judgePortalUrl(),
                    judge_name: [judgeRow.first_name, judgeRow.last_name].filter(Boolean).join(' ').trim()
                },
                vars
            ),
            immediate: true
        },
        cb
    );
}

function transferAssignment(db, opts, cb) {
    const submissionId = parseInt(opts.submissionId, 10);
    const fromJudgeId = parseInt(opts.fromJudgeId, 10);
    const toJudgeId = parseInt(opts.toJudgeId, 10);
    const byUserId = parseInt(opts.byUserId, 10) || null;
    const byLabel = opts.byLabel || 'Admin';

    if (!Number.isInteger(submissionId) || submissionId < 1) {
        return cb(new Error('Invalid submission'));
    }
    if (!Number.isInteger(fromJudgeId) || fromJudgeId < 1) {
        return cb(new Error('Invalid source judge'));
    }
    if (!Number.isInteger(toJudgeId) || toJudgeId < 1) {
        return cb(new Error('Invalid target judge'));
    }
    if (fromJudgeId === toJudgeId) return cb(new Error('Source and target judge are the same'));

    db.get(
        `SELECT 1 FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
        [submissionId, fromJudgeId],
        (eA, assigned) => {
            if (eA) return cb(eA);
            if (!assigned) return cb(new Error('Source judge is not assigned to this submission'));

            db.get(`SELECT id, first_name, last_name, email, user_id_string FROM users WHERE id = ?`, [fromJudgeId], (eF, fromJ) => {
                if (eF) return cb(eF);
                db.get(`SELECT id, first_name, last_name, email, user_id_string FROM users WHERE id = ?`, [toJudgeId], (eT, toJ) => {
                    if (eT) return cb(eT);
                    if (!toJ) return cb(new Error('Target judge not found'));

                    db.run(
                        `DELETE FROM case_judge_assignments WHERE submission_id = ? AND judge_user_id = ?`,
                        [submissionId, fromJudgeId],
                        (eDel) => {
                            if (eDel) return cb(eDel);
                            db.run(
                                `INSERT OR IGNORE INTO case_judge_assignments (submission_id, judge_user_id) VALUES (?, ?)`,
                                [submissionId, toJudgeId],
                                (eIns) => {
                                    if (eIns) return cb(eIns);
                                    loadSubmissionBrief(db, submissionId, (eSub, sub) => {
                                        const appNo = (sub && sub.application_no) || String(submissionId);
                                        const topic = (sub && sub.title) || '';
                                        const fromName = fromJ
                                            ? [fromJ.first_name, fromJ.last_name].filter(Boolean).join(' ')
                                            : 'Judge';
                                        const toName = [toJ.first_name, toJ.last_name].filter(Boolean).join(' ');
                                        const vars = {
                                            application_no: appNo,
                                            case_topic: topic,
                                            from_judge_name: fromName,
                                            to_judge_name: toName,
                                            transferred_by: byLabel
                                        };
                                        notifyJudgeTransfer(db, fromJ, 'CASE_JUDGE_TRANSFER_REMOVED', vars, () => {
                                            notifyJudgeTransfer(db, toJ, 'CASE_JUDGE_TRANSFER_ASSIGNED', vars, () => {
                                                cb(null, {
                                                    success: true,
                                                    submissionId,
                                                    fromJudgeId,
                                                    toJudgeId,
                                                    applicationNo: appNo,
                                                    byUserId
                                                });
                                            });
                                        });
                                    });
                                }
                            );
                        }
                    );
                });
            });
        }
    );
}

module.exports = {
    resolveJudgeRef,
    transferAssignment
};

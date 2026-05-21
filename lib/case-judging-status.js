/**
 * Advance case submission from judging → judged when all assigned judges lock scores.
 */
const portalTracking = require('./portal-tracking');

function maybeAdvanceCaseJudgingStatus(db, submissionId, cb) {
    const sid = parseInt(submissionId, 10);
    if (!Number.isInteger(sid)) return cb && cb(null, { skipped: true });
    db.get(
        `SELECT cs.status,
                (SELECT COUNT(*) FROM case_judge_assignments cja WHERE cja.submission_id = cs.id) AS assigned,
                (SELECT COUNT(*) FROM case_judge_scores cjs
                 WHERE cjs.submission_id = cs.id AND IFNULL(cjs.is_locked, 0) = 1) AS locked
         FROM case_submissions cs WHERE cs.id = ?`,
        [sid],
        (e, row) => {
            if (e) return cb && cb(e);
            if (!row || String(row.status || '').toLowerCase() !== 'judging') {
                return cb && cb(null, { advanced: false });
            }
            const assigned = Number(row.assigned) || 0;
            const locked = Number(row.locked) || 0;
            if (!(assigned > 0 && locked >= assigned)) {
                return cb && cb(null, { advanced: false, assigned, locked });
            }
            db.run(
                `UPDATE case_submissions SET status = 'judged', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'judging'`,
                [sid],
                function (uErr) {
                    if (uErr) return cb && cb(uErr);
                    if (!this.changes) return cb && cb(null, { advanced: false });
                    portalTracking.logCaseEvent(
                        db,
                        sid,
                        'judged',
                        'Judged',
                        'All assigned judges have submitted their scores.',
                        () => cb && cb(null, { advanced: true, assigned, locked })
                    );
                }
            );
        }
    );
}

module.exports = { maybeAdvanceCaseJudgingStatus };

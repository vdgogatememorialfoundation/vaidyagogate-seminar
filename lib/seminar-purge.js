/**
 * Purge seminar-scoped data while keeping doctor accounts (users + doctor_profile).
 */

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

function purgeSeminarOrphanData(db, seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar id'));
    const steps = [
        [`DELETE FROM ticket_scan_events WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM event_schedules WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM registration_overrides WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM seminar_volunteers WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM volunteer_certificates WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM notices WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM certificate_templates WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM supplemental_payments WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM notification_logs WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM notification_templates WHERE seminar_id = ?`, [sid]],
        [`DELETE FROM case_submissions WHERE seminar_id = ?`, [sid]]
    ];
    runSteps(db, steps, cb);
}

function purgeSeminarTestData(db, seminarId, deleteRegistrationCascade, opts, cb) {
    const sid = parseInt(seminarId, 10);
    const deleteSeminar = !!(opts && opts.deleteSeminar);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar id'));

    db.all(`SELECT id FROM registrations WHERE seminar_id = ?`, [sid], (e0, regs) => {
        if (e0) return cb(e0);
        const list = regs || [];
        let i = 0;
        const nextReg = (err) => {
            if (err) return cb(err);
            if (i >= list.length) {
                return purgeSeminarOrphanData(db, sid, (eOrphan) => {
                    if (eOrphan) return cb(eOrphan);
                    if (!deleteSeminar) {
                        return cb(null, {
                            purgedRegistrations: list.length,
                            seminarKept: true
                        });
                    }
                    db.run(`DELETE FROM seminars WHERE id = ?`, [sid], function (eDel) {
                        if (eDel) return cb(eDel);
                        cb(null, {
                            purgedRegistrations: list.length,
                            seminarDeleted: this.changes > 0
                        });
                    });
                });
            }
            deleteRegistrationCascade(list[i++].id, nextReg);
        };
        nextReg();
    });
}

module.exports = {
    purgeSeminarOrphanData,
    purgeSeminarTestData
};

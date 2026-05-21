/**
 * Auto-create case application for selected doctors who have not applied yet.
 */
const notifEngine = require('./notification-engine');
const portalTracking = require('./portal-tracking');

function generateCaseApplicationNo() {
    let id = '';
    for (let i = 0; i < 12; i++) id += Math.floor(Math.random() * 10).toString();
    return id;
}

function buildPrefillForm(db, userId, seminarId, cb) {
    let sql = `SELECT r.form_data, r.seminar_id, u.first_name, u.middle_name, u.last_name, u.email, u.phone
               FROM registrations r
               JOIN users u ON u.id = r.user_id
               WHERE r.user_id = ? AND r.status NOT IN ('cancelled','rejected')`;
    const params = [userId];
    if (seminarId) {
        sql += ` AND r.seminar_id = ?`;
        params.push(seminarId);
    }
    sql += ` ORDER BY r.id DESC LIMIT 1`;
    db.get(sql, params, (err, row) => {
        if (err) return cb(err);
        if (row) {
            let fd = {};
            try {
                fd = row.form_data ? JSON.parse(row.form_data) : {};
            } catch (_) {}
            return cb(null, {
                fname: fd.fname || row.first_name || '',
                mname: fd.mname || row.middle_name || '',
                lname: fd.lname || row.last_name || '',
                email: fd.email || row.email || '',
                phone: fd.phone || row.phone || '',
                whatsapp: fd.whatsapp || fd.phone || row.phone || '',
                category: fd.category || '',
                topic: fd.topic || fd.case_topic || ''
            });
        }
        db.get(
            `SELECT first_name, middle_name, last_name, email, phone FROM users WHERE id = ?`,
            [userId],
            (e2, u) => {
                if (e2) return cb(e2);
                cb(null, {
                    fname: u?.first_name || '',
                    mname: u?.middle_name || '',
                    lname: u?.last_name || '',
                    email: u?.email || '',
                    phone: u?.phone || '',
                    whatsapp: u?.phone || '',
                    category: '',
                    topic: ''
                });
            }
        );
    });
}

function applyRegistrationOverride(db, userId, seminarId, note, adminId, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid)) return cb && cb(null, { skipped: true });
    db.run(
        `INSERT INTO registration_overrides (user_id, seminar_id, enabled, note, created_by)
         VALUES (?, ?, 1, ?, ?)`,
        [userId, sid, note || 'Priority case selection', adminId || null],
        (err) => {
            if (err && /unique|duplicate/i.test(String(err.message))) {
                return db.run(
                    `UPDATE registration_overrides SET enabled = 1, note = ? WHERE user_id = ? AND seminar_id = ?`,
                    [note || 'Priority case selection', userId, sid],
                    () => cb && cb(null, { updated: true })
                );
            }
            cb && cb(err);
        }
    );
}

function createPriorityInvitation(db, opts, cb) {
    const programId = parseInt(opts.programId, 10);
    const userId = parseInt(opts.userId, 10);
    const category = String(opts.category || 'agnikarma').toLowerCase();
    if (!Number.isInteger(programId) || !Number.isInteger(userId)) {
        return cb(new Error('programId and userId required'));
    }

    db.get(`SELECT * FROM case_programs WHERE id = ?`, [programId], (e0, program) => {
        if (e0) return cb(e0);
        if (!program) return cb(new Error('Case program not found'));

        db.get(
            `SELECT id, status FROM case_submissions
             WHERE user_id = ? AND case_program_id = ? AND status NOT IN ('cancelled')`,
            [userId, programId],
            (e1, existing) => {
                if (e1) return cb(e1);
                if (existing) {
                    return cb(
                        new Error(
                            'Doctor already has a case application for this program (status: ' +
                                (existing.status || 'unknown') +
                                ').'
                        )
                    );
                }

                buildPrefillForm(db, userId, program.seminar_id, (e2, form) => {
                    if (e2) return cb(e2);
                    if (!form.category) form.category = category;
                    if (!form.topic) form.topic = 'Priority selection — complete your case topic';
                    const appNo = generateCaseApplicationNo();
                    const seminarId = program.seminar_id || null;
                    const formJson = JSON.stringify(form);

                    db.run(
                        `INSERT INTO case_submissions (
                            user_id, seminar_id, case_program_id, application_no, category, title,
                            form_data, status, updated_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'priority_invited', CURRENT_TIMESTAMP)`,
                        [
                            userId,
                            seminarId,
                            programId,
                            appNo,
                            form.category,
                            form.topic,
                            formJson
                        ],
                        function (insErr) {
                            if (insErr) return cb(insErr);
                            const subId = this.lastID;
                            portalTracking.logCaseEvent(
                                db,
                                subId,
                                'priority_invited',
                                'Priority invitation',
                                'Admin selected you — complete any missing details and upload files.',
                                () => {}
                            );
                            const afterOverride = () => {
                                notifEngine.notify(
                                    db,
                                    'CASE_PRIORITY_INVITED',
                                    {
                                        userId,
                                        vars: {
                                            application_no: appNo,
                                            program_title: program.title || '',
                                            portal_login_url:
                                                notifEngine.publicBaseUrl() + '/doctor.html#tab-case'
                                        },
                                        immediate: true
                                    },
                                    () =>
                                        cb(null, {
                                            submissionId: subId,
                                            applicationNo: appNo,
                                            status: 'priority_invited'
                                        })
                                );
                            };
                            if (seminarId) {
                                return applyRegistrationOverride(
                                    db,
                                    userId,
                                    seminarId,
                                    'Priority case program selection',
                                    opts.adminUserId,
                                    afterOverride
                                );
                            }
                            afterOverride();
                        }
                    );
                });
            }
        );
    });
}

module.exports = {
    buildPrefillForm,
    createPriorityInvitation,
    applyRegistrationOverride
};

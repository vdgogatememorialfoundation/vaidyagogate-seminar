/**
 * Admin edits to live doctor data (applications, accounts, profiles).
 */
function assertAdminAccess(db, adminUserId, cb) {
    const aid = parseInt(adminUserId, 10);
    if (!Number.isInteger(aid) || aid < 1) {
        return cb(null, { ok: false, error: 'adminUserId is required' });
    }
    db.get(`SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`, [aid], (e, adm) => {
        if (e) return cb(e);
        if (!adm) return cb(null, { ok: false, error: 'Invalid admin user' });
        const ok =
            String(adm.role || '').toLowerCase() === 'admin' ||
            String(adm.user_role || '').toLowerCase() === 'co_admin';
        if (!ok) return cb(null, { ok: false, error: 'Admin portal access required' });
        cb(null, { ok: true, admin: adm });
    });
}

function logApplicationEdit(db, applicationId, editorUserId, oldFormData, newFormData) {
    const changes = JSON.stringify({
        old: oldFormData,
        new: newFormData,
        timestamp: new Date().toISOString(),
        editor: 'admin'
    });
    db.run(
        `INSERT INTO application_edits (application_id, edited_by_user_id, changes) VALUES (?, ?, ?)`,
        [applicationId, editorUserId, changes],
        (editErr) => {
            if (editErr) console.warn('[admin-live-edit] application_edits:', editErr.message);
        }
    );
}

function mergeRegistrationFormData(prev, incoming) {
    const p = prev && typeof prev === 'object' ? prev : {};
    const n = incoming && typeof incoming === 'object' ? incoming : {};
    return { ...p, ...n };
}

function adminUpdateRegistrationFormData(db, deps, opts, cb) {
    const rid = parseInt(opts.registrationId, 10);
    const aid = parseInt(opts.adminUserId, 10);
    const incoming = opts.formData;
    const {
        validateFormDataAgainstRegistrationConfig,
        sanitizeFormDataForStorage,
        loadRegistrationFormConfig
    } = deps;

    if (!Number.isInteger(rid) || rid < 1) {
        return cb(null, { ok: false, error: 'Invalid registration id' });
    }

    db.get(
        `SELECT id, user_id, seminar_id, status, form_data, application_no FROM registrations WHERE id = ?`,
        [rid],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, { ok: false, error: 'Application not found' });
            const st = String(row.status || '').toLowerCase();
            if (st === 'cancelled' || st === 'rejected') {
                return cb(null, { ok: false, error: 'Cannot edit a cancelled or rejected application.' });
            }
            let prev = {};
            try {
                prev = JSON.parse(row.form_data || '{}');
            } catch (_) {
                prev = {};
            }
            const merged = mergeRegistrationFormData(prev, incoming);
            const hasCert = !!merged.certificate_path;

            loadRegistrationFormConfig(row.seminar_id, (cfgErr, regCfg) => {
                if (cfgErr) return cb(cfgErr);
                const validationError = validateFormDataAgainstRegistrationConfig(
                    merged,
                    hasCert,
                    (regCfg && regCfg.fields) || [],
                    null,
                    regCfg
                );
                if (validationError) {
                    return cb(null, { ok: false, error: validationError });
                }
                const stored = sanitizeFormDataForStorage(merged);
                const fdJson = JSON.stringify(stored);
                db.run(
                    `UPDATE registrations SET form_data = ?, registration_source = 'admin', admin_editor_user_id = ? WHERE id = ?`,
                    [fdJson, aid, rid],
                    function (uerr) {
                        if (uerr) return cb(uerr);
                        logApplicationEdit(db, rid, aid, row.form_data, fdJson);
                        cb(null, {
                            ok: true,
                            registrationId: rid,
                            applicationNo: row.application_no,
                            formData: stored
                        });
                    }
                );
            });
        }
    );
}

module.exports = {
    assertAdminAccess,
    logApplicationEdit,
    mergeRegistrationFormData,
    adminUpdateRegistrationFormData
};

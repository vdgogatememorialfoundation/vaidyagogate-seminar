/**
 * Extended API routes — register with: require('./lib/routes-ext')(app, deps)
 */
const multer = require('multer');
const portalTracking = require('./portal-tracking');

const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }
});

function upsertGlobalSetting(db, key, value, cb) {
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [value, key], function (uerr) {
        if (uerr) return cb(uerr);
        if (this.changes > 0) return cb();
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [key, value], cb);
    });
}

/** Resolve internal users.id from numeric id or portal user_id_string (letters + numbers). */
function resolveInternalUserId(db, userId, userIdString, cb) {
    const n = parseInt(userId, 10);
    if (Number.isInteger(n) && n > 0) {
        return db.get(`SELECT id, user_id_string FROM users WHERE id = ?`, [n], (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, null);
            return cb(null, row.id);
        });
    }
    const s = String(userIdString != null && userIdString !== '' ? userIdString : userId || '').trim();
    if (!s) return cb(null, null);
    const asNum = parseInt(s, 10);
    db.get(
        `SELECT id FROM users WHERE user_id_string = ? OR id = ?`,
        [s, Number.isInteger(asNum) && String(asNum) === s ? asNum : -1],
        (e, row) => {
            if (e) return cb(e);
            cb(null, row ? row.id : null);
        }
    );
}

module.exports = function registerExtendedRoutes(app, deps) {
    const {
        db,
        upload,
        generateId,
        fileStore,
        uploadsDir,
        buildDisplayNameFromFormData,
        syncCertificateEligibilityForTicket,
        insertParticipantTicket,
        ignoreSchemaMigrationErr,
        certVerify,
        docVerify,
        notifEngine
    } = deps;

    // ——— Logo (stored in DB — Vercel has no persistent /uploads disk) ———
    app.get('/api/branding/logo', (req, res) => {
        db.get(`SELECT value FROM global_settings WHERE key = 'site_logo_meta'`, [], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            if (row && row.value) {
                try {
                    const meta = JSON.parse(row.value);
                    if (meta.version) {
                        return res.json({ logoPath: '/api/branding/logo/file?v=' + meta.version });
                    }
                } catch (_) {
                    /* fall through */
                }
            }
            db.get(`SELECT value FROM global_settings WHERE key = 'site_logo_path'`, [], (e2, legacy) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ logoPath: legacy && legacy.value ? legacy.value : '' });
            });
        });
    });

    app.get('/api/branding/logo/file', (req, res) => {
        db.get(`SELECT value FROM global_settings WHERE key = 'site_logo_b64'`, [], (e, row) => {
            if (e) return res.status(500).end();
            if (!row || !row.value) return res.status(404).end();
            let payload;
            try {
                payload = JSON.parse(row.value);
            } catch (_) {
                return res.status(404).end();
            }
            if (!payload || !payload.data) return res.status(404).end();
            const buf = Buffer.from(payload.data, 'base64');
            res.setHeader('Content-Type', payload.mime || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(buf);
        });
    });

    app.post('/api/admin/branding/logo', logoUpload.single('logo'), (req, res) => {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'logo file required' });
        }
        const mime = req.file.mimetype || 'image/png';
        const version = Date.now();
        const b64Payload = JSON.stringify({
            mime,
            data: req.file.buffer.toString('base64')
        });
        const metaPayload = JSON.stringify({ version, mime });
        const logoPath = '/api/branding/logo/file?v=' + version;

        upsertGlobalSetting(db, 'site_logo_b64', b64Payload, (e1) => {
            if (e1) return res.status(500).json({ error: e1.message });
            upsertGlobalSetting(db, 'site_logo_meta', metaPayload, (e2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                upsertGlobalSetting(db, 'site_logo_path', logoPath, (e3) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    res.json({ success: true, logoPath });
                });
            });
        });
    });

    // ——— Certificate candidates (all registrations for seminar) ———
    app.get('/api/admin/certificates/candidates', (req, res) => {
        const seminarId = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId is required' });
        }
        const sql = `
            SELECT r.id AS registration_id, r.user_id, r.application_no, r.status AS reg_status,
                   u.user_id_string, u.first_name, u.last_name, u.email,
                   o.id AS order_id, o.status AS order_status, o.amount,
                   t.id AS ticket_id, t.is_scanned, IFNULL(t.scan_count, 0) AS scan_count, t.scan_time, t.ticket_id_string,
                   IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
                   uc.id AS certificate_id, IFNULL(uc.enabled, 0) AS cert_enabled,
                   IFNULL(uc.scan_verified, 0) AS scan_verified, uc.display_name
            FROM registrations r
            JOIN users u ON u.id = r.user_id
            JOIN seminars s ON s.id = r.seminar_id
            LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
            LEFT JOIN tickets t ON t.order_id = o.id
            LEFT JOIN user_certificates uc ON uc.user_id = r.user_id AND uc.seminar_id = r.seminar_id
            WHERE r.seminar_id = ?
            ORDER BY u.last_name, u.first_name
        `;
        db.all(sql, [seminarId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/admin/certificates/bulk-toggle', (req, res) => {
        const { seminarId, userIds, enabled } = req.body || {};
        const sid = parseInt(seminarId, 10);
        const en = enabled ? 1 : 0;
        const ids = Array.isArray(userIds) ? userIds.map((x) => parseInt(x, 10)).filter((x) => x > 0) : [];
        if (!Number.isInteger(sid) || sid < 1 || !ids.length) {
            return res.status(400).json({ error: 'seminarId and userIds[] required' });
        }
        if (en === 1 && !certVerify) {
            return res.status(500).json({ error: 'Certificate verification module not loaded' });
        }
        db.get(
            `SELECT id, file_path FROM certificate_templates WHERE seminar_id = ? AND is_active = 1 AND IFNULL(cert_type,'participant') = 'participant' ORDER BY id DESC LIMIT 1`,
            [sid],
            (eTpl, tplRow) => {
                if (eTpl) return res.status(500).json({ error: eTpl.message });
                const templateMissing = !tplRow || !tplRow.file_path;
                let done = 0;
                let errMsg = null;
                const skipped = [];
                ids.forEach((uid) => {
                    db.get(
                        `SELECT r.id AS registration_id, r.application_no, r.form_data, t.id AS ticket_id,
                                IFNULL(t.scan_count, 0) AS scan_count, o.status AS order_status,
                                u.user_id_string, IFNULL(s.cert_scans_required, 1) AS cert_scans_required
                         FROM registrations r
                         JOIN users u ON u.id = r.user_id
                         JOIN seminars s ON s.id = r.seminar_id
                         LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
                         LEFT JOIN tickets t ON t.order_id = o.id
                         WHERE r.user_id = ? AND r.seminar_id = ?`,
                        [uid, sid],
                        (e0, regRow) => {
                            if (e0 && !errMsg) errMsg = e0.message;
                            if (en === 1 && certVerify) {
                                const chk = certVerify.validateCertMandatoryFields(regRow || {});
                                if (!chk.ok) {
                                    skipped.push({ userId: uid, error: chk.error });
                                    done++;
                                    if (done === ids.length) finishBulk();
                                    return;
                                }
                                if (String(regRow.order_status || '').toLowerCase() !== 'success') {
                                    skipped.push({
                                        userId: uid,
                                        error: 'Payment not confirmed — certificate cannot be enabled.'
                                    });
                                    done++;
                                    if (done === ids.length) finishBulk();
                                    return;
                                }
                                if (
                                    !certVerify.ticketMeetsScanRequirement(
                                        regRow.scan_count,
                                        regRow.cert_scans_required
                                    )
                                ) {
                                    const req = certVerify.normalizeCertScansRequired(
                                        regRow.cert_scans_required
                                    );
                                    skipped.push({
                                        userId: uid,
                                        error:
                                            req === 2
                                                ? `Requires ${req} scans (current: ${regRow.scan_count || 0}).`
                                                : 'Not checked in at venue yet.'
                                    });
                                    done++;
                                    if (done === ids.length) finishBulk();
                                    return;
                                }
                            }
                            const dn = buildDisplayNameFromFormData(regRow && regRow.form_data, {});
                            db.run(
                                `INSERT INTO user_certificates (user_id, seminar_id, ticket_id, registration_id, display_name, template_id, enabled, scan_verified, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, IFNULL((SELECT scan_verified FROM user_certificates WHERE user_id = ? AND seminar_id = ?), 0), CURRENT_TIMESTAMP)
                                 ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                                   enabled = excluded.enabled,
                                   display_name = COALESCE(excluded.display_name, user_certificates.display_name),
                                   template_id = COALESCE(excluded.template_id, user_certificates.template_id),
                                   updated_at = CURRENT_TIMESTAMP`,
                                [
                                    uid,
                                    sid,
                                    regRow && regRow.ticket_id ? regRow.ticket_id : null,
                                    regRow && regRow.registration_id ? regRow.registration_id : null,
                                    dn,
                                    tplRow ? tplRow.id : null,
                                    en,
                                    uid,
                                    sid
                                ],
                                (e) => {
                                    if (e && !errMsg) errMsg = e.message;
                                    if (en === 1 && certVerify && !e) {
                                        db.get(
                                            `SELECT id FROM user_certificates WHERE user_id = ? AND seminar_id = ?`,
                                            [uid, sid],
                                            (eCert, certRow) => {
                                                if (eCert && !errMsg) errMsg = eCert.message;
                                                if (certRow && certRow.id) {
                                                    certVerify.ensureUserCertVerifyToken(db, certRow.id, () => {
                                                        done++;
                                                        if (done === ids.length) finishBulk();
                                                    });
                                                } else {
                                                    done++;
                                                    if (done === ids.length) finishBulk();
                                                }
                                            }
                                        );
                                    } else {
                                        done++;
                                        if (done === ids.length) finishBulk();
                                    }
                                }
                            );
                        }
                    );
                });

                function finishBulk() {
                    if (errMsg) return res.status(500).json({ error: errMsg });
                    res.json({
                        success: true,
                        updated: ids.length - skipped.length,
                        skipped,
                        templateMissing: en === 1 && templateMissing,
                        templatePath: tplRow && tplRow.file_path ? tplRow.file_path : null
                    });
                }
            }
        );
    });

    if (certVerify) {
        app.get('/api/admin/seminars/:seminarId/certificate-verify', (req, res) => {
            const sid = parseInt(req.params.seminarId, 10);
            if (!Number.isInteger(sid) || sid < 1) {
                return res.status(400).json({ error: 'Invalid seminar id' });
            }
            db.get(
                `SELECT id, title, event_date, IFNULL(certificate_verify_enabled, 0) AS certificate_verify_enabled FROM seminars WHERE id = ?`,
                [sid],
                (e, row) => {
                    if (e) return res.status(500).json({ error: e.message });
                    if (!row) return res.status(404).json({ error: 'Seminar not found' });
                    const { isSeminarEnded } = require('./local-date');
                    res.json({
                        seminarId: row.id,
                        title: row.title,
                        eventDate: row.event_date,
                        enabled: !!Number(row.certificate_verify_enabled),
                        seminarEnded: isSeminarEnded(row.event_date)
                    });
                }
            );
        });

        app.put('/api/admin/seminars/:seminarId/certificate-verify', (req, res) => {
            const sid = parseInt(req.params.seminarId, 10);
            const enabled = !!(req.body && req.body.enabled);
            if (!Number.isInteger(sid) || sid < 1) {
                return res.status(400).json({ error: 'Invalid seminar id' });
            }
            db.get(`SELECT event_date FROM seminars WHERE id = ?`, [sid], (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Seminar not found' });
                const { isSeminarEnded } = require('./local-date');
                if (enabled && !isSeminarEnded(row.event_date)) {
                    return res.status(400).json({
                        error: 'Public certificate verification can only be enabled after the seminar has ended.'
                    });
                }
                db.run(
                    `UPDATE seminars SET certificate_verify_enabled = ? WHERE id = ?`,
                    [enabled ? 1 : 0, sid],
                    (e2) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        res.json({ success: true, enabled });
                    }
                );
            });
        });

        app.post('/api/admin/certificates/dispatch-all', (req, res) => {
            const sid = parseInt((req.body && req.body.seminarId) || 0, 10);
            if (!Number.isInteger(sid) || sid < 1) {
                return res.status(400).json({ error: 'seminarId is required' });
            }
            certVerify.dispatchAllEnabledCertificates(db, sid, (e, out) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!out.ok) return res.status(400).json({ error: out.error });
                res.json(out);
            });
        });
    }

    // ——— Registration override ———
    app.post('/api/admin/registration-overrides', (req, res) => {
        const { userId, userIdString, seminarId, enabled, note, adminUserId } = req.body || {};
        const sid = parseInt(seminarId, 10);
        if (!Number.isInteger(sid)) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        resolveInternalUserId(db, userId, userIdString || userId, (e, uid) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!uid) {
                return res.status(404).json({
                    error: 'Doctor not found. Use portal User ID (letters and numbers, e.g. USR_...) or internal numeric id.'
                });
            }
            db.run(
                `INSERT INTO registration_overrides (user_id, seminar_id, enabled, note, created_by)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, seminar_id) DO UPDATE SET enabled = excluded.enabled, note = excluded.note`,
                [uid, sid, enabled !== false ? 1 : 0, note || null, adminUserId || null],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, userId: uid });
                }
            );
        });
    });

    app.get('/api/admin/registration-overrides', (req, res) => {
        const sid = req.query.seminarId ? parseInt(req.query.seminarId, 10) : null;
        let sql = `SELECT ro.*, u.user_id_string, u.first_name, u.last_name, u.email, s.title AS seminar_title
                   FROM registration_overrides ro
                   JOIN users u ON u.id = ro.user_id
                   LEFT JOIN seminars s ON s.id = ro.seminar_id WHERE 1=1`;
        const params = [];
        if (sid) {
            sql += ` AND ro.seminar_id = ?`;
            params.push(sid);
        }
        db.all(sql, params, (e, rows) => {
            if (e) return res.status(500).json({ error: e.message });
            res.json(rows || []);
        });
    });

    // ——— Volunteers ———
    app.get('/api/admin/volunteers', (req, res) => {
        const sid = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'seminarId required' });
        db.all(
            `SELECT sv.*, u.user_id_string, u.first_name, u.last_name, u.email, u.phone
             FROM seminar_volunteers sv
             JOIN users u ON u.id = sv.user_id
             WHERE sv.seminar_id = ?
             ORDER BY sv.created_at DESC`,
            [sid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/admin/volunteers', (req, res) => {
        const { seminarId, userId, userIdString, notes } = req.body || {};
        const sid = parseInt(seminarId, 10);
        if (!Number.isInteger(sid)) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        resolveInternalUserId(db, userId, userIdString || userId, (e, uid) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!uid) {
                return res.status(404).json({
                    error: 'Doctor not found. Enter portal User ID (letters and numbers, e.g. USR_...) or internal numeric id.'
                });
            }
            db.run(
                `INSERT INTO seminar_volunteers (seminar_id, user_id, status, notes) VALUES (?, ?, 'pending', ?)
                 ON CONFLICT(seminar_id, user_id) DO UPDATE SET notes = excluded.notes`,
                [sid, uid, notes || null],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, id: this.lastID, userId: uid });
                }
            );
        });
    });

    app.post('/api/admin/volunteers/:id/approve', (req, res) => {
        const vid = parseInt(req.params.id, 10);
        const adminId = parseInt((req.body && req.body.adminUserId) || '', 10);
        db.get(`SELECT * FROM seminar_volunteers WHERE id = ?`, [vid], (e, vol) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!vol) return res.status(404).json({ error: 'Volunteer record not found' });
            if (vol.status === 'approved') return res.json({ success: true, message: 'Already approved' });

            const ticketStr = 'VOL_' + generateId();
            db.get(
                `SELECT id FROM registrations WHERE user_id = ? AND seminar_id = ?`,
                [vol.user_id, vol.seminar_id],
                (e2, reg) => {
                    const finish = (regId, appNo) => {
                        const orderStr = 'ORD_VOL_' + generateId();
                        db.run(
                            `INSERT INTO orders (order_id_string, registration_id, amount, status, payment_date, payment_gateway)
                             VALUES (?, ?, 0, 'success', CURRENT_TIMESTAMP, 'volunteer_waiver')`,
                            [orderStr, regId],
                            function (oErr) {
                                if (oErr) return res.status(500).json({ error: oErr.message });
                                const orderId = this.lastID;
                                insertParticipantTicket(
                                    orderId,
                                    vol.user_id,
                                    orderStr,
                                    regId,
                                    appNo,
                                    (tErr, _etk, qrData) => {
                                        if (tErr) return res.status(500).json({ error: tErr.message });
                                        db.run(
                                            `UPDATE tickets SET ticket_id_string = ? WHERE order_id = ?`,
                                            [ticketStr, orderId],
                                            () => {
                                                db.run(
                                                    `UPDATE seminar_volunteers SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, volunteer_ticket_id_string = ? WHERE id = ?`,
                                                    [adminId || null, ticketStr, vid],
                                                    (uErr) => {
                                                        if (uErr) return res.status(500).json({ error: uErr.message });
                                                        db.get(
                                                            `SELECT form_data FROM registrations WHERE id = ?`,
                                                            [regId],
                                                            (e3, rrow) => {
                                                                const dn = buildDisplayNameFromFormData(
                                                                    rrow && rrow.form_data,
                                                                    {}
                                                                );
                                                                db.run(
                                                                    `INSERT INTO volunteer_certificates (user_id, seminar_id, registration_id, display_name, enabled, scan_verified)
                                                                     VALUES (?, ?, ?, ?, 0, 1)
                                                                     ON CONFLICT(user_id, seminar_id) DO UPDATE SET display_name = excluded.display_name, scan_verified = 1`,
                                                                    [vol.user_id, vol.seminar_id, regId, dn],
                                                                    () => {
                                                                        syncCertificateEligibilityForTicket(
                                                                            null,
                                                                            () => {}
                                                                        );
                                                                        res.json({
                                                                            success: true,
                                                                            ticketId: ticketStr,
                                                                            message:
                                                                                'Volunteer approved. Free registration and ticket created. Enable certificates after verification.'
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
                    };

                    if (reg) {
                        db.run(
                            `UPDATE registrations SET status = 'completed' WHERE id = ?`,
                            [reg.id],
                            () => finish(reg.id, reg.application_no)
                        );
                    } else {
                        const appNo = 'APP_VOL_' + generateId();
                        db.run(
                            `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data, registration_source)
                             VALUES (?, ?, ?, 'completed', '{}', 'volunteer')`,
                            [vol.user_id, vol.seminar_id, appNo],
                            function (iErr) {
                                if (iErr) return res.status(500).json({ error: iErr.message });
                                finish(this.lastID, appNo);
                            }
                        );
                    }
                }
            );
        });
    });

    app.get('/api/doctor/volunteer-seminars/:userId', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        db.all(
            `SELECT sv.*, s.title, s.event_date
             FROM seminar_volunteers sv
             JOIN seminars s ON s.id = sv.seminar_id
             WHERE sv.user_id = ? AND sv.status = 'approved'
             ORDER BY s.event_date DESC`,
            [uid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/doctor/volunteer-assignments/:userId', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        db.all(
            `SELECT sv.*, s.title, s.event_date, s.registration_open
             FROM seminar_volunteers sv
             JOIN seminars s ON s.id = sv.seminar_id
             WHERE sv.user_id = ?
             ORDER BY s.event_date DESC`,
            [uid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/doctor/case/submissions/:userId/files', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        const subId = req.query.submissionId ? parseInt(req.query.submissionId, 10) : null;
        if (!Number.isInteger(uid)) return res.status(400).json({ error: 'userId required' });
        if (!Number.isInteger(subId)) return res.status(400).json({ error: 'submissionId query required' });
        db.get(`SELECT * FROM case_submissions WHERE id = ? AND user_id = ?`, [subId, uid], (e, sub) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!sub) return res.status(404).json({ error: 'Not found' });
            db.all(`SELECT * FROM case_files WHERE submission_id = ? ORDER BY sort_order`, [subId], (e2, files) => {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ submission: sub, files: files || [] });
            });
        });
    });

    app.post('/api/case/resubmit', upload.array('files', 5), (req, res) => {
        const userId = parseInt(req.body.userId, 10);
        const submissionId = parseInt(req.body.submissionId, 10);
        const replaceFileIds = (req.body.replaceFileIds || '')
            .split(',')
            .map((x) => parseInt(x.trim(), 10))
            .filter((x) => x > 0);
        const files = req.files || [];
        if (!Number.isInteger(userId) || !Number.isInteger(submissionId)) {
            return res.status(400).json({ error: 'userId and submissionId required' });
        }
        if (!files.length || !replaceFileIds.length) {
            return res.status(400).json({ error: 'Upload file(s) and specify replaceFileIds for rejected slots' });
        }
        db.get(`SELECT * FROM case_submissions WHERE id = ? AND user_id = ?`, [submissionId, userId], (e, sub) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!sub) return res.status(404).json({ error: 'Submission not found' });
            const subSt = String(sub.status || '').toLowerCase();
            if (!['revision_required', 'resubmitted', 'submitted', 'under_review'].includes(subSt)) {
                return res.status(400).json({ error: 'This case application cannot accept file replacements now.' });
            }
            db.all(
                `SELECT * FROM case_files WHERE submission_id = ? AND id IN (${replaceFileIds.map(() => '?').join(',')})`,
                [submissionId, ...replaceFileIds],
                (e2, existing) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const bad = (existing || []).some((f) => f.status === 'approved');
                    if (bad) return res.status(400).json({ error: 'Approved files cannot be replaced' });
                    let i = 0;
                    const next = () => {
                        if (i >= files.length) {
                            db.run(
                                `UPDATE case_submissions SET status = 'submitted', doc_review_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [submissionId],
                                () => {
                                    portalTracking.logCaseEvent(
                                        db,
                                        submissionId,
                                        'submitted',
                                        'Files resubmitted',
                                        'Updated files received — under admin review again.',
                                        () => res.json({ success: true })
                                    );
                                }
                            );
                            return;
                        }
                        const f = files[i];
                        const fid = replaceFileIds[i] || replaceFileIds[0];
                        const applyUpdate = (filePath) => {
                            db.run(
                                `UPDATE case_files SET file_path = ?, original_name = ?, status = 'pending', rejection_reason = NULL WHERE id = ? AND submission_id = ? AND status != 'approved'`,
                                [filePath, f.originalname, fid, submissionId],
                                () => {
                                    i++;
                                    next();
                                }
                            );
                        };
                        if (fileStore && uploadsDir) {
                            fileStore.persistMulterFile(db, f, uploadsDir, (pErr, filePath) => {
                                if (pErr) return res.status(500).json({ error: pErr.message });
                                applyUpdate(filePath || '/uploads/' + f.filename);
                            });
                        } else {
                            applyUpdate('/uploads/' + f.filename);
                        }
                    };
                    next();
                }
            );
        });
    });

    app.get('/api/doctor/volunteer-certificates/:userId', (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        db.all(
            `SELECT vc.*, s.title AS seminar_title, ct.file_path AS template_path, ct.mime_type
             FROM volunteer_certificates vc
             LEFT JOIN seminars s ON s.id = vc.seminar_id
             LEFT JOIN certificate_templates ct ON ct.id = vc.template_id AND ct.cert_type = 'volunteer'
             WHERE vc.user_id = ?`,
            [uid],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    // Case submit / judge scoring / programs: lib/case-presentation.js

    app.get('/api/admin/case/submissions', (req, res) => {
        db.all(
            `SELECT cs.*, u.user_id_string, u.first_name, u.last_name, u.email,
                    cp.title AS program_title,
                    (SELECT COUNT(*) FROM case_files cf WHERE cf.submission_id = cs.id) AS file_count
             FROM case_submissions cs
             JOIN users u ON u.id = cs.user_id
             LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
             ORDER BY cs.updated_at DESC`,
            [],
            (e, rows) => {
                if (e) return res.status(500).json({ error: e.message });
                res.json(rows || []);
            }
        );
    });

    app.get('/api/admin/case/submissions/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(
            `SELECT cs.*, u.user_id_string, u.first_name, u.last_name, u.email, u.phone
             FROM case_submissions cs JOIN users u ON u.id = cs.user_id WHERE cs.id = ?`,
            [id],
            (e, sub) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!sub) return res.status(404).json({ error: 'Not found' });
                db.all(`SELECT * FROM case_files WHERE submission_id = ? ORDER BY sort_order`, [id], (e2, files) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    db.all(
                        `SELECT cja.judge_user_id, u.user_id_string, u.first_name, u.last_name
                         FROM case_judge_assignments cja
                         JOIN users u ON u.id = cja.judge_user_id
                         WHERE cja.submission_id = ?`,
                        [id],
                        (e3, judges) => {
                            if (e3) return res.status(500).json({ error: e3.message });
                            res.json({ submission: sub, files: files || [], assignedJudges: judges || [] });
                        }
                    );
                });
            }
        );
    });

    app.post('/api/admin/case/files/:fileId/review', (req, res) => {
        const fid = parseInt(req.params.fileId, 10);
        const { status, reason } = req.body || {};
        const st = String(status || '').toLowerCase();
        if (!['approved', 'rejected'].includes(st)) {
            return res.status(400).json({ error: 'status must be approved or rejected' });
        }
        db.run(
            `UPDATE case_files SET status = ?, rejection_reason = ? WHERE id = ? AND status != 'approved'`,
            [st, reason || null, fid],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) {
                    return res.status(400).json({ error: 'File not found or already approved (cannot change)' });
                }
                if (st !== 'rejected' || !docVerify) {
                    return res.json({ success: true });
                }
                db.get(`SELECT submission_id FROM case_files WHERE id = ?`, [fid], (eSub, frow) => {
                    if (eSub || !frow) return res.json({ success: true });
                    docVerify.markCaseRevisionFromFileReject(
                        db,
                        frow.submission_id,
                        reason,
                        { portalTracking, notifEngine },
                        () => res.json({ success: true, revisionRequired: true })
                    );
                });
            }
        );
    });

    app.post('/api/admin/case/submissions/:id/document-verify', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!docVerify) return res.status(503).json({ error: 'Document verify module not loaded' });
        docVerify.verifyCaseSubmission(
            db,
            sid,
            req.body || {},
            { portalTracking, notifEngine },
            (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!result || !result.ok) {
                    return res.status(400).json({ error: (result && result.error) || 'Verify failed' });
                }
                res.json({ success: true, status: result.status, message: result.message });
            }
        );
    });

    app.post('/api/admin/case/submissions/:id/assign-judges', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!Number.isInteger(sid)) return res.status(400).json({ error: 'Invalid submission id' });
        const body = req.body || {};
        let judgeIds = (Array.isArray(body.judgeIds) ? body.judgeIds : [])
            .map((x) => parseInt(x, 10))
            .filter((x) => Number.isInteger(x) && x > 0);
        const idStrings = (Array.isArray(body.judgeUserIdStrings) ? body.judgeUserIdStrings : [])
            .map((s) => String(s || '').trim())
            .filter(Boolean);
        if (body.judgeUserIdString) idStrings.push(String(body.judgeUserIdString).trim());

        const finishAssign = (ids) => {
            const unique = [...new Set(ids)];
            if (!unique.length) {
                return res.status(400).json({ error: 'No valid judges selected' });
            }
            let done = 0;
            unique.forEach((jid) => {
                db.run(
                    `INSERT OR IGNORE INTO case_judge_assignments (submission_id, judge_user_id) VALUES (?, ?)`,
                    [sid, jid],
                    () => {
                        done++;
                        if (done === unique.length) {
                            db.run(
                                `UPDATE case_submissions SET status = 'judging', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [sid],
                                () => {
                                    portalTracking.logCaseEvent(
                                        db,
                                        sid,
                                        'judging',
                                        'Judges assigned',
                                        unique.length + ' judge(s) assigned for scoring.',
                                        () => {}
                                    );
                                    res.json({ success: true, judgeIds: unique });
                                }
                            );
                        }
                    }
                );
            });
        };

        if (idStrings.length) {
            const resolved = [];
            let pending = idStrings.length;
            idStrings.forEach((uidStr) => {
                db.get(
                    `SELECT id FROM users WHERE user_id_string = ? AND (
                        LOWER(COALESCE(user_role,'')) IN ('judge','reviewer','judge_user')
                        OR LOWER(COALESCE(role,'')) IN ('judge','reviewer')
                    )`,
                    [uidStr],
                    (e, row) => {
                        if (row && row.id) resolved.push(row.id);
                        pending--;
                        if (pending === 0) {
                            finishAssign([...judgeIds, ...resolved]);
                        }
                    }
                );
            });
            return;
        }
        if (!judgeIds.length) {
            return res.status(400).json({ error: 'Select a reviewer or enter judge portal ID (e.g. 393671924601)' });
        }
        finishAssign(judgeIds);
    });

    const exportReports = require('./export-reports');

  function sendAdminReport(req, res) {
        const sid = parseInt(req.params.seminarId, 10);
        const type = req.params.reportType;
        const format = String((req.query && req.query.format) || 'csv')
            .toLowerCase()
            .replace(/^\./, '');
        const spec = exportReports.REPORT_QUERIES[type];
        if (!spec) return res.status(400).json({ error: 'Invalid report type' });
        db.all(spec.sql, [sid], (e, rows) => {
            if (e) return res.status(500).json({ error: e.message });
            let out = rows || [];
            if (typeof spec.postFilter === 'function') out = spec.postFilter(out);
            const base = `${type}-seminar-${sid}`;
            if (format === 'xlsx' || format === 'excel') {
                const buf = exportReports.toXlsxBuffer(out, spec.title);
                res.setHeader(
                    'Content-Type',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                );
                res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
                return res.send(buf);
            }
            if (format === 'pdf' || format === 'html') {
                const html = exportReports.toHtmlTable(out, spec.title);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${base}.html"`);
                return res.send(html);
            }
            const csv = exportReports.toCsv(out);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
            res.send(csv);
        });
    }

    app.get('/api/admin/reports/:seminarId/:reportType.csv', sendAdminReport);
    app.get('/api/admin/reports/:seminarId/:reportType', sendAdminReport);
};

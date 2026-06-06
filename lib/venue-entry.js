/**
 * DigiYatra-style venue entry: doctor selfie enrollment + digital pass QR + gate verification.
 * Separate from the e-ticket scanner portal.
 */
const crypto = require('crypto');
const fileStore = require('./file-store');
const scannerIdCapture = require('./scanner-id-capture');

const PASS_PREFIX = 'VE:';

function generatePassToken() {
    return crypto.randomBytes(12).toString('hex');
}

function passQrPayload(token) {
    return PASS_PREFIX + token;
}

function parsePassQr(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s.startsWith(PASS_PREFIX)) return s.slice(PASS_PREFIX.length).trim();
    try {
        const j = JSON.parse(s);
        if (j && j.venuePassToken) return String(j.venuePassToken).trim();
        if (j && j.token) return String(j.token).trim();
    } catch (_) {}
    if (/^[a-f0-9]{16,32}$/i.test(s)) return s;
    return null;
}

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS venue_entry_profiles (
            user_id INTEGER PRIMARY KEY,
            selfie_path TEXT NOT NULL,
            enrolled_at TEXT DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'active',
            consent_at TEXT
        )`,
        [],
        (e1) => {
            if (e1 && !/already exists/i.test(String(e1.message))) return cb && cb(e1);
            db.run(
                `CREATE TABLE IF NOT EXISTS venue_entry_passes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    registration_id INTEGER NOT NULL,
                    seminar_id INTEGER NOT NULL,
                    pass_token TEXT NOT NULL UNIQUE,
                    ticket_id_string TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    revoked INTEGER DEFAULT 0
                )`,
                [],
                (e2) => {
                    if (e2 && !/already exists/i.test(String(e2.message))) return cb && cb(e2);
                    db.run(
                        `CREATE TABLE IF NOT EXISTS venue_entry_events (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            pass_id INTEGER,
                            seminar_id INTEGER NOT NULL,
                            registration_id INTEGER,
                            doctor_user_id INTEGER,
                            gate_user_id INTEGER,
                            outcome TEXT NOT NULL,
                            message TEXT,
                            id_capture_id INTEGER,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )`,
                        [],
                        (e3) => {
                            if (e3 && !/already exists/i.test(String(e3.message))) return cb && cb(e3);
                            scannerIdCapture.ensureSchema(db, cb);
                        }
                    );
                }
            );
        }
    );
}

function resolveDoctorUserId(db, userId, userIdString, cb) {
    const n = parseInt(userId, 10);
    if (Number.isInteger(n) && n > 0) return cb(null, n);
    const s = String(userIdString || userId || '').trim();
    if (!s) return cb(new Error('userId required'));
    db.get(`SELECT id FROM users WHERE user_id_string = ? OR id = ? LIMIT 1`, [s, parseInt(s, 10) || -1], (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('User not found'));
        cb(null, row.id);
    });
}

function resolveGateUserId(db, gateUserId, cb) {
    const n = parseInt(gateUserId, 10);
    if (!Number.isInteger(n) || n < 1) return cb(new Error('gateUserId required'));
    db.get(`SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0)=0`, [n], (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('Invalid gate user'));
        const ur = String(row.user_role || '').toLowerCase();
        const r = String(row.role || '').toLowerCase();
        const ok = ur === 'venue_gate_user' || ur === 'scanner_portal_user' || r === 'admin';
        if (!ok) return cb(new Error('Account is not permitted for venue gate'));
        cb(null, row.id);
    });
}

function getProfile(db, userId, cb) {
    db.get(`SELECT * FROM venue_entry_profiles WHERE user_id = ? AND status = 'active'`, [userId], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        cb(null, {
            enrolled: true,
            enrolledAt: row.enrolled_at,
            selfieUrl: fileStore.publicFileUrl(row.selfie_path)
        });
    });
}

function loadPassByToken(db, token, cb) {
    db.get(
        `SELECT p.*, r.application_no, r.status AS registration_status, r.form_data,
                s.title AS seminar_title, s.checkin_enabled, s.checkin_date, s.event_date,
                IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
                u.id AS doctor_user_id, u.user_id_string, u.first_name, u.last_name, u.email, u.phone,
                dp.profile_photo_path,
                t.id AS ticket_db_id, t.ticket_id_string, t.scan_count, IFNULL(t.is_scanned,0) AS is_scanned,
                o.status AS payment_status
         FROM venue_entry_passes p
         JOIN registrations r ON r.id = p.registration_id
         JOIN seminars s ON s.id = p.seminar_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN doctor_profile dp ON dp.user_id = u.id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE p.pass_token = ? AND IFNULL(p.revoked,0) = 0`,
        [token],
        cb
    );
}

function issuePassForRegistration(db, userId, registrationId, cb) {
    const rid = parseInt(registrationId, 10);
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(rid) || !Number.isInteger(uid)) return cb(new Error('Invalid ids'));
    db.get(
        `SELECT r.id, r.seminar_id, r.user_id, r.status, o.status AS payment_status, t.ticket_id_string
         FROM registrations r
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE r.id = ? AND r.user_id = ?`,
        [rid, uid],
        (err, reg) => {
            if (err) return cb(err);
            if (!reg) return cb(new Error('Registration not found'));
            if (String(reg.payment_status || '').toLowerCase() !== 'success') {
                return cb(new Error('Venue pass is available only after payment is confirmed'));
            }
            db.get(
                `SELECT * FROM venue_entry_passes WHERE registration_id = ? AND IFNULL(revoked,0)=0 ORDER BY id DESC LIMIT 1`,
                [rid],
                (e2, existing) => {
                    if (e2) return cb(e2);
                    if (existing) {
                        return cb(null, {
                            passToken: existing.pass_token,
                            qrPayload: passQrPayload(existing.pass_token),
                            registrationId: rid,
                            seminarId: existing.seminar_id,
                            ticketId: existing.ticket_id_string
                        });
                    }
                    const token = generatePassToken();
                    db.run(
                        `INSERT INTO venue_entry_passes (user_id, registration_id, seminar_id, pass_token, ticket_id_string)
                         VALUES (?, ?, ?, ?, ?)`,
                        [uid, rid, reg.seminar_id, token, reg.ticket_id_string || null],
                        function (iErr) {
                            if (iErr) return cb(iErr);
                            cb(null, {
                                passToken: token,
                                qrPayload: passQrPayload(token),
                                registrationId: rid,
                                seminarId: reg.seminar_id,
                                ticketId: reg.ticket_id_string
                            });
                        }
                    );
                }
            );
        }
    );
}

function doctorPayloadFromPassRow(row, buildDisplayNameFromFormData) {
    const name =
        (buildDisplayNameFromFormData && buildDisplayNameFromFormData(row.form_data, row)) ||
        [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    return {
        userId: row.doctor_user_id || row.user_id,
        userIdString: row.user_id_string,
        name,
        email: row.email,
        phone: row.phone,
        applicationNo: row.application_no,
        seminarTitle: row.seminar_title,
        ticketId: row.ticket_id_string,
        profilePhotoUrl: row.profile_photo_path ? fileStore.publicFileUrl(row.profile_photo_path) : null
    };
}

function saveVenueEntryProfile(db, uid, selfiePath, consentAt, cb) {
    db.run(
        `UPDATE venue_entry_profiles SET selfie_path = ?, status = 'active', consent_at = ?, enrolled_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [selfiePath, consentAt, uid],
        function (uErr) {
            if (uErr) return cb(uErr);
            if (this.changes > 0) return cb(null);
            db.run(
                `INSERT INTO venue_entry_profiles (user_id, selfie_path, status, consent_at, enrolled_at)
                 VALUES (?, ?, 'active', ?, CURRENT_TIMESTAMP)`,
                [uid, selfiePath, consentAt],
                (iErr) => cb(iErr)
            );
        }
    );
}

function registerVenueEntryRoutes(app, deps) {
    const db = deps.db;
    const uploadsDir = deps.uploadsDir;
    const withUpload = deps.withMemoryAwareUpload;
    const buildDisplayNameFromFormData = deps.buildDisplayNameFromFormData;

    app.get('/api/venue-entry/status', (req, res) => {
        const userId = req.query.userId;
        const userIdString = req.query.userIdString;
        resolveDoctorUserId(db, userId, userIdString, (e, uid) => {
            if (e) return res.status(400).json({ error: e.message });
            getProfile(db, uid, (eP, profile) => {
                if (eP) return res.status(500).json({ error: eP.message });
                res.json({
                    enrolled: !!(profile && profile.enrolled),
                    profile: profile || { enrolled: false }
                });
            });
        });
    });

    app.post('/api/venue-entry/enroll', withUpload('selfie'), (req, res) => {
        const body = req.body || {};
        if (!req.file) return res.status(400).json({ error: 'Selfie photo required' });
        resolveDoctorUserId(db, body.userId, body.userIdString, (e, uid) => {
            if (e) return res.status(400).json({ error: e.message });
            fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, selfiePath) => {
                if (pErr) return res.status(500).json({ error: pErr.message });
                const consentAt = new Date().toISOString();
                saveVenueEntryProfile(db, uid, selfiePath, consentAt, (uErr) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    res.json({
                        success: true,
                        selfieUrl: fileStore.publicFileUrl(selfiePath),
                        enrolled: true
                    });
                });
            });
        });
    });

    app.get('/api/venue-entry/pass', (req, res) => {
        const registrationId = parseInt(req.query.registrationId, 10);
        resolveDoctorUserId(db, req.query.userId, req.query.userIdString, (e, uid) => {
            if (e) return res.status(400).json({ error: e.message });
            if (!Number.isInteger(registrationId)) return res.status(400).json({ error: 'registrationId required' });
            getProfile(db, uid, (eP, profile) => {
                if (eP) return res.status(500).json({ error: eP.message });
                if (!profile || !profile.enrolled) {
                    return res.status(400).json({
                        error: 'Enroll with a selfie first to get your venue pass.',
                        needsEnrollment: true
                    });
                }
                issuePassForRegistration(db, uid, registrationId, (ePass, pass) => {
                    if (ePass) return res.status(400).json({ error: ePass.message });
                    const qrUrl =
                        '/api/qrcode/' + encodeURIComponent(pass.qrPayload) + '?size=320';
                    res.json({
                        success: true,
                        pass,
                        qrPayload: pass.qrPayload,
                        qrUrl,
                        selfieUrl: profile.selfieUrl
                    });
                });
            });
        });
    });

    app.get('/api/venue-entry/registrations', (req, res) => {
        resolveDoctorUserId(db, req.query.userId, req.query.userIdString, (e, uid) => {
            if (e) return res.status(400).json({ error: e.message });
            db.all(
                `SELECT r.id AS registration_id, r.application_no, r.status, s.id AS seminar_id, s.title AS seminar_title,
                        o.status AS payment_status, t.ticket_id_string
                 FROM registrations r
                 JOIN seminars s ON s.id = r.seminar_id
                 LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
                 LEFT JOIN tickets t ON t.order_id = o.id
                 WHERE r.user_id = ? AND lower(trim(o.status)) = 'success'
                 ORDER BY r.id DESC`,
                [uid],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json(rows || []);
                }
            );
        });
    });

    app.post('/api/venue-gate/scan', (req, res) => {
        const body = req.body || {};
        const token = parsePassQr(body.qrData || body.passToken || body.qr_payload);
        const seminarId = parseInt(body.seminarId, 10);
        if (!token) return res.status(400).json({ error: 'Invalid venue pass QR' });
        resolveGateUserId(db, body.gateUserId, (eG, gateId) => {
            if (eG) return res.status(403).json({ error: eG.message });
            loadPassByToken(db, token, (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Venue pass not found or revoked' });
                if (Number.isInteger(seminarId) && seminarId > 0 && Number(row.seminar_id) !== seminarId) {
                    return res.status(403).json({
                        error: 'Pass is for another seminar: ' + (row.seminar_title || row.seminar_id)
                    });
                }
                getProfile(db, row.user_id, (eP, profile) => {
                    if (eP) return res.status(500).json({ error: eP.message });
                    db.get(
                        `SELECT selfie_path FROM venue_entry_profiles WHERE user_id = ? AND status = 'active'`,
                        [row.user_id],
                        (eS, profRow) => {
                            const selfieUrl =
                                profRow && profRow.selfie_path
                                    ? fileStore.publicFileUrl(profRow.selfie_path)
                                    : profile && profile.selfieUrl;
                            res.json({
                                success: true,
                                passToken: token,
                                passId: row.id,
                                seminarId: row.seminar_id,
                                registrationId: row.registration_id,
                                ticketId: row.ticket_id_string,
                                paymentStatus: row.payment_status,
                                isScanned: !!row.is_scanned,
                                scanCount: row.scan_count,
                                doctor: doctorPayloadFromPassRow(row, buildDisplayNameFromFormData),
                                enrolledSelfieUrl: selfieUrl || null,
                                needsEnrollment: !selfieUrl
                            });
                        }
                    );
                });
            });
        });
    });

    app.post('/api/venue-gate/checkin', withUpload('idPhoto'), (req, res) => {
        const body = req.body || {};
        const token = parsePassQr(body.qrData || body.passToken);
        const seminarId = parseInt(body.seminarId, 10);
        if (!token) return res.status(400).json({ error: 'Invalid venue pass' });
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        resolveGateUserId(db, body.gateUserId, (eG, gateId) => {
            if (eG) return res.status(403).json({ error: eG.message });
            loadPassByToken(db, token, (e, row) => {
                if (e) return res.status(500).json({ error: e.message });
                if (!row) return res.status(404).json({ error: 'Venue pass not found' });
                if (Number(row.seminar_id) !== seminarId) {
                    return res.status(403).json({ error: 'Wrong seminar selected for this pass' });
                }
                if (!row.ticket_db_id) {
                    return res.status(400).json({ error: 'No e-ticket linked to this registration yet' });
                }
                const finish = (checkinResult, idCapture) => {
                    db.run(
                        `INSERT INTO venue_entry_events (pass_id, seminar_id, registration_id, doctor_user_id, gate_user_id, outcome, message, id_capture_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            row.id,
                            seminarId,
                            row.registration_id,
                            row.user_id,
                            gateId,
                            checkinResult && checkinResult.success ? 'success' : 'denied',
                            (checkinResult && (checkinResult.message || checkinResult.error)) || 'Entry',
                            idCapture && idCapture.id ? idCapture.id : null
                        ],
                        () => {
                            if (!checkinResult || !checkinResult.success) {
                                return res.status(checkinResult && checkinResult.statusCode ? checkinResult.statusCode : 403).json({
                                    success: false,
                                    error: (checkinResult && checkinResult.error) || 'Check-in denied',
                                    doctor: checkinResult && checkinResult.doctor,
                                    idCapture: idCapture || null
                                });
                            }
                            res.json({
                                success: true,
                                message: checkinResult.message,
                                doctor: checkinResult.doctor,
                                scanCount: checkinResult.scanCount,
                                idCapture: idCapture || null
                            });
                        }
                    );
                };

                const seminarDt = require('./seminar-datetime');
                const scansRequired = Math.max(1, parseInt(row.cert_scans_required, 10) || 1);
                const currentScanCount = Number(row.scan_count) || 0;
                if (currentScanCount >= scansRequired) {
                    return finish(
                        {
                            success: false,
                            error: 'Check-in already completed for this pass.',
                            statusCode: 400,
                            doctor: doctorPayloadFromPassRow(row, buildDisplayNameFromFormData)
                        },
                        null
                    );
                }

                const runCheckin = (idCapture) => {
                    const newScanCount = currentScanCount + 1;
                    const scanAtIst = seminarDt.scanTimeNowForStorage
                        ? seminarDt.scanTimeNowForStorage()
                        : new Date().toISOString();
                    db.run(
                        `UPDATE tickets SET scan_count = ?, is_scanned = 1, scan_time = ?, scanned_by = ? WHERE id = ?`,
                        [newScanCount, scanAtIst, gateId, row.ticket_db_id],
                        (uErr) => {
                            if (uErr) {
                                return finish({ success: false, error: uErr.message, statusCode: 500 }, idCapture);
                            }
                            db.run(
                                `UPDATE registrations SET status = 'checked_in' WHERE id = ? AND status NOT IN ('rejected','cancelled')`,
                                [row.registration_id],
                                () => {
                                    const doctor = doctorPayloadFromPassRow(row, buildDisplayNameFromFormData);
                                    finish(
                                        {
                                            success: true,
                                            message: 'Venue entry confirmed (DigiYatra pass).',
                                            scanCount: newScanCount,
                                            doctor
                                        },
                                        idCapture
                                    );
                                }
                            );
                        }
                    );
                };

                if (req.file) {
                    fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, photoPath) => {
                        if (pErr) return res.status(500).json({ error: pErr.message });
                        scannerIdCapture.saveIdCapture(
                            db,
                            uploadsDir,
                            {
                                seminar_id: seminarId,
                                ticket_db_id: row.ticket_db_id,
                                ticket_id_string: row.ticket_id_string,
                                registration_id: row.registration_id,
                                doctor_user_id: row.user_id,
                                scanner_user_id: gateId,
                                id_photo_path: photoPath
                            },
                            (sErr, cap) => {
                                if (sErr) return res.status(500).json({ error: sErr.message });
                                runCheckin(cap);
                            }
                        );
                    });
                } else {
                    runCheckin(null);
                }
            });
        });
    });

    app.get('/api/venue-gate/checkin-seminars', (req, res) => {
        db.all(
            `SELECT id, title, checkin_date, event_date, checkin_enabled
             FROM seminars WHERE is_active = 1 AND IFNULL(checkin_enabled, 0) = 1
             ORDER BY event_date ASC, title ASC`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : rows || [])
        );
    });
}

module.exports = {
    PASS_PREFIX,
    passQrPayload,
    parsePassQr,
    ensureSchema,
    registerVenueEntryRoutes,
    getProfile,
    issuePassForRegistration
};

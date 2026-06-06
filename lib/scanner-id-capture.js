/**
 * ID proof photo captured at scanner check-in (linked to ticket_scan_events).
 */
const fileStore = require('./file-store');

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS venue_id_captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_event_id INTEGER,
            seminar_id INTEGER NOT NULL,
            ticket_db_id INTEGER,
            ticket_id_string TEXT,
            registration_id INTEGER,
            doctor_user_id INTEGER,
            scanner_user_id INTEGER,
            id_photo_path TEXT NOT NULL,
            captured_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        [],
        (err) => {
            if (err && !/already exists/i.test(String(err.message))) return cb && cb(err);
            db.run(
                `CREATE INDEX IF NOT EXISTS idx_venue_id_captures_scan ON venue_id_captures (scan_event_id)`,
                [],
                () => cb && cb(null)
            );
        }
    );
}

function saveIdCapture(db, uploadsDir, row, cb) {
    const r = row || {};
    if (!r.id_photo_path) return cb(new Error('id_photo_path required'));
    db.run(
        `INSERT INTO venue_id_captures (
            scan_event_id, seminar_id, ticket_db_id, ticket_id_string,
            registration_id, doctor_user_id, scanner_user_id, id_photo_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            r.scan_event_id || null,
            r.seminar_id,
            r.ticket_db_id || null,
            r.ticket_id_string || null,
            r.registration_id || null,
            r.doctor_user_id || null,
            r.scanner_user_id || null,
            r.id_photo_path
        ],
        function (err) {
            if (err) return cb(err);
            cb(null, { id: this.lastID, photoUrl: fileStore.publicFileUrl(r.id_photo_path) });
        }
    );
}

function getCaptureForScanEvent(db, scanEventId, cb) {
    const id = parseInt(scanEventId, 10);
    if (!Number.isInteger(id) || id < 1) return cb(null, null);
    db.get(`SELECT * FROM venue_id_captures WHERE scan_event_id = ? ORDER BY id DESC LIMIT 1`, [id], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        cb(null, {
            id: row.id,
            scanEventId: row.scan_event_id,
            photoUrl: fileStore.publicFileUrl(row.id_photo_path),
            capturedAt: row.captured_at
        });
    });
}

function registerScannerIdCaptureRoutes(app, deps) {
    const db = deps.db;
    const uploadsDir = deps.uploadsDir;
    const withUpload = deps.withMemoryAwareUpload;

    app.post('/api/scanner/id-capture', withUpload('idPhoto'), (req, res) => {
        const body = req.body || {};
        const scannerUserId = parseInt(body.scannerUserId, 10);
        const seminarId = parseInt(body.seminarId, 10);
        const scanEventId = parseInt(body.scanEventId, 10);
        const ticketDbId = parseInt(body.ticketDbId, 10);
        const registrationId = parseInt(body.registrationId, 10);
        const doctorUserId = parseInt(body.doctorUserId, 10);

        if (!Number.isInteger(scannerUserId) || scannerUserId < 1) {
            return res.status(401).json({ error: 'scannerUserId required' });
        }
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        if (!req.file) return res.status(400).json({ error: 'idPhoto image required' });

        db.get(
            `SELECT id, role, user_role FROM users WHERE id = ? AND IFNULL(is_disabled,0) = 0`,
            [scannerUserId],
            (eu, staff) => {
                if (eu) return res.status(500).json({ error: eu.message });
                if (!staff) return res.status(401).json({ error: 'Invalid scanner user' });
                const ur = String(staff.user_role || '').toLowerCase();
                const r = String(staff.role || '').toLowerCase();
                const allowed =
                    ur === 'scanner_portal_user' ||
                    ur === 'venue_gate_user' ||
                    r === 'admin';
                if (!allowed) return res.status(403).json({ error: 'Not permitted to upload ID captures' });

                fileStore.persistMulterFile(db, req.file, uploadsDir, (pErr, photoPath) => {
                    if (pErr) return res.status(500).json({ error: pErr.message });
                    saveIdCapture(
                        db,
                        uploadsDir,
                        {
                            scan_event_id: Number.isInteger(scanEventId) ? scanEventId : null,
                            seminar_id: seminarId,
                            ticket_db_id: Number.isInteger(ticketDbId) ? ticketDbId : null,
                            ticket_id_string: body.ticketIdString || body.ticket_id_string || null,
                            registration_id: Number.isInteger(registrationId) ? registrationId : null,
                            doctor_user_id: Number.isInteger(doctorUserId) ? doctorUserId : null,
                            scanner_user_id: scannerUserId,
                            id_photo_path: photoPath
                        },
                        (sErr, saved) => {
                            if (sErr) return res.status(500).json({ error: sErr.message });
                            res.json({ success: true, capture: saved });
                        }
                    );
                });
            }
        );
    });

    app.get('/api/admin/scanner/id-capture/:scanEventId', (req, res) => {
        const scanEventId = parseInt(req.params.scanEventId, 10);
        if (!Number.isInteger(scanEventId)) return res.status(400).json({ error: 'Invalid scan event id' });
        getCaptureForScanEvent(db, scanEventId, (err, cap) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!cap) return res.status(404).json({ error: 'No ID capture for this scan' });
            res.json(cap);
        });
    });
}

module.exports = {
    ensureSchema,
    saveIdCapture,
    getCaptureForScanEvent,
    registerScannerIdCaptureRoutes
};

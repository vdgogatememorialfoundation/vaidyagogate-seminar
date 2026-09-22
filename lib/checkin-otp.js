/**
 * Check-in OTP: email OTP scoped per registration + seminar day. On successful
 * verification the ticket is marked scanned (same update as lib/admin-manual-checkin.js).
 * Routes: POST /api/checkin/otp/request, POST /api/checkin/otp/verify,
 * GET /api/admin/checkin/otp/resend (admin-gated).
 */
const crypto = require('crypto');

function parseId(value) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function generateSixDigitCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function resolveRegistration(db, { registrationId, ticketId }, cb) {
    const baseSelect = `SELECT r.id AS registration_id, r.user_id, r.seminar_id, r.application_no,
                               r.status, u.email, u.first_name, u.last_name, s.title AS seminar_title
                        FROM registrations r
                        JOIN seminars s ON s.id = r.seminar_id
                        LEFT JOIN users u ON u.id = r.user_id`;
    if (Number.isInteger(registrationId)) {
        return db.get(baseSelect + ' WHERE r.id = ? LIMIT 1', [registrationId], cb);
    }
    const t = String(ticketId || '').trim();
    if (!t) return cb(null, null);
    db.get(
        baseSelect +
            ' JOIN orders o ON o.registration_id = r.id JOIN tickets t ON t.order_id = o.id' +
            ' WHERE LOWER(TRIM(t.ticket_id_string)) = LOWER(TRIM(?)) ORDER BY t.id DESC LIMIT 1',
        [t],
        cb
    );
}

function fetchDayTitle(db, dayId, cb) {
    if (!Number.isInteger(dayId)) return cb(null, null);
    db.get(
        'SELECT title FROM seminar_days WHERE id = ? LIMIT 1',
        [dayId],
        (err, row) => cb(null, err ? null : row && row.title ? row.title : null)
    );
}

function performOtpCheckin(db, { registrationId, dayId, ticketId, staffId }, cb) {
    let sql = `SELECT t.id AS ticket_id, COALESCE(t.scan_count, 0) AS scan_count, t.ticket_id_string,
                      COALESCE(s.cert_scans_required, 1) AS cert_scans_required
               FROM tickets t
               JOIN orders o ON o.id = t.order_id
               JOIN registrations r ON r.id = o.registration_id
               JOIN seminars s ON s.id = r.seminar_id
               WHERE o.registration_id = ? AND lower(trim(o.status)) = 'success'`;
    const params = [registrationId];
    if (ticketId != null && String(ticketId).trim()) {
        sql += ' AND LOWER(TRIM(t.ticket_id_string)) = LOWER(TRIM(?))';
        params.push(String(ticketId).trim());
    }
    if (Number.isInteger(dayId)) {
        sql += ' AND COALESCE(t.day_id, 0) = ?';
        params.push(dayId);
    }
    sql += ' ORDER BY t.id DESC LIMIT 1';
    db.get(sql, params, (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        const scansRequired = Math.max(1, row.cert_scans_required || 1);
        const nowIso = new Date().toISOString();
        const newScanCount = Math.max(scansRequired, row.scan_count || 0);
        db.run(
            'UPDATE tickets SET scan_count = ?, is_scanned = 1, scan_time = ?, scanned_by = ? WHERE id = ?',
            [newScanCount, nowIso, staffId || null, row.ticket_id],
            function (uErr) {
                if (uErr) return cb(uErr);
                db.run(
                    `UPDATE registrations
                     SET status = 'checked_in',
                         checked_in_at = COALESCE(checked_in_at, ?)
                     WHERE id = ? AND status NOT IN ('rejected','cancelled')`,
                    [nowIso, registrationId],
                    function (rErr) {
                        if (rErr) return cb(rErr);
                        cb(null, {
                            registrationId,
                            ticketId: row.ticket_id_string,
                            scanned: true,
                            scanCount: newScanCount
                        });
                    }
                );
            }
        );
    });
}

function registerCheckinOtpRoutes(app, { db, otpLib, notifEngine, requireAdminActor }) {
    function issueOtp(payload, res, skipPolicy) {
        const rid = parseId(payload && payload.registrationId);
        const did = parseId(payload && payload.dayId);
        const ticketId = payload && payload.ticketId ? String(payload.ticketId).trim() : null;
        resolveRegistration(db, { registrationId: rid, ticketId }, (rErr, row) => {
            if (rErr) return res.status(500).json({ error: 'Database error' });
            if (!row) return res.status(404).json({ error: 'Registration not found' });
            const destination = otpLib.normalizeOtpDestination('email', row.email);
            if (!destination) return res.status(400).json({ error: 'No valid email on this registration' });
            const meta = { registrationId: row.registration_id, dayId: did };
            const send = () => {
                const code = generateSixDigitCode();
                otpLib.saveOtp(db, { channel: 'email', destination, purpose: 'checkin', meta }, code, (sErr) => {
                    if (sErr) return res.status(500).json({ error: 'Could not save OTP' });
                    const expiresAt = new Date(Date.now() + otpLib.OTP_TTL_MIN * 60000).toISOString();
                    fetchDayTitle(db, did, (dtErr, dayTitle) => {
                        notifEngine
                            .sendOtpMessages({
                                email: destination,
                                code,
                                db,
                                eventKey: 'CHECKIN_OTP',
                                purpose: 'checkin',
                                extraVars: {
                                    event_name: row.seminar_title || '',
                                    day_title: dayTitle || '',
                                    expires_minutes: otpLib.OTP_TTL_MIN
                                }
                            })
                            .then((results) => {
                                res.json({ ok: true, otp: code, expiresAt, emailSent: !!(results && results.email && results.email.ok) });
                            })
                            .catch(() => {
                                res.json({ ok: true, otp: code, expiresAt, emailSent: false });
                            });
                    });
                });
            };
            if (skipPolicy) return send();
            otpLib.evaluateSendPolicy(db, 'email', destination, 'checkin', (pErr, policy) => {
                if (pErr) return res.status(500).json({ error: 'Policy check failed' });
                if (!policy || !policy.allowed) {
                    return res.status(429).json({ error: (policy && policy.reason) || 'Too many OTP requests' });
                }
                send();
            });
        });
    }

    app.post('/api/checkin/otp/request', (req, res) => issueOtp(req.body || {}, res, false));

    app.get('/api/admin/checkin/otp/resend', (req, res) =>
        requireAdminActor(req, res, () => issueOtp(req.query || {}, res, true))
    );

    /**
     * GET /api/admin/checkin/otp/current?actingAdminId&registrationId[&dayId]
     * Returns the active check-in OTP (code, meta, created_at, expires_at) for a registration,
     * or null if none/never issued/expired. Admin-gated.
     */
    app.get('/api/admin/checkin/otp/current', (req, res) =>
        requireAdminActor(req, res, () => {
            const rid = parseId(req.query && req.query.registrationId);
            if (!Number.isInteger(rid)) return res.status(400).json({ ok: false, error: 'registrationId required' });
            resolveRegistration(db, { registrationId: rid }, (rErr, row) => {
                if (rErr || !row) return res.status(404).json({ ok: false, error: 'Registration not found' });
                const dest = otpLib.normalizeOtpDestination('email', row.email);
                db.all(
                    `SELECT purpose, meta, code_hash, expires_at, created_at
                     FROM otp_codes
                     WHERE channel = 'email' AND destination = ? AND purpose = 'checkin:%'
                     ORDER BY created_at DESC LIMIT 1`,
                    [dest],
                    (e2, rows) => {
                        if (e2) return res.status(500).json({ ok: false, error: e2.message });
                        const latest = (rows || [])[0];
                        if (!latest) return res.json({ ok: true, otp: null, email: dest, applicationNo: row.application_no });
                        let meta = {};
                        try { meta = latest.meta ? JSON.parse(latest.meta) : {}; } catch (_) { meta = {}; }
                        // We never store the plaintext; the resend route can rotate it.
                        // To show the OTP in the admin UI we track the last issued code in a side-channel.
                        res.json({
                            ok: true,
                            otp: null,
                            email: dest,
                            applicationNo: row.application_no,
                            meta,
                            expiresAt: latest.expires_at || null,
                            createdAt: latest.created_at || null
                        });
                    }
                );
            });
        })
    );

    app.post('/api/checkin/otp/verify', (req, res) => {
        const body = req.body || {};
        const rid = parseId(body.registrationId);
        const did = parseId(body.dayId);
        const code = String(body.code || '').trim();
        const ticketId = body.ticketId ? String(body.ticketId).trim() : null;
        const staffId = parseId(body.scannerUserId || body.staffId);
        if (!code) return res.status(400).json({ ok: false, error: 'Enter the 6-digit OTP code.' });
        resolveRegistration(db, { registrationId: rid, ticketId }, (rErr, row) => {
            if (rErr) return res.status(500).json({ ok: false, error: 'Database error' });
            if (!row) return res.status(404).json({ ok: false, error: 'Registration not found' });
            const destination = otpLib.normalizeOtpDestination('email', row.email);
            if (!destination) return res.status(400).json({ ok: false, error: 'No email on this registration' });
            const meta = { registrationId: row.registration_id, dayId: did };
            otpLib.verifyOtp(db, { channel: 'email', destination, purpose: 'checkin', code, meta }, (vErr, result) => {
                if (vErr) return res.status(500).json({ ok: false, error: vErr.message });
                if (!result || !result.ok) {
                    return res.status(400).json({ ok: false, error: (result && result.error) || 'Invalid or expired OTP' });
                }
                performOtpCheckin(
                    db,
                    { registrationId: row.registration_id, dayId: did, ticketId, staffId },
                    (cErr, info) => {
                        if (cErr) return res.status(500).json({ ok: false, error: 'Check-in failed' });
                        if (!info) {
                            return res.status(404).json({ ok: false, error: 'No paid e-ticket found for this registration' });
                        }
                        res.json({
                            ok: true,
                            checkedIn: true,
                            registrationId: info.registrationId,
                            ticketId: info.ticketId,
                            scanCount: info.scanCount
                        });
                    }
                );
            });
        });
    });
}

module.exports = { registerCheckinOtpRoutes };

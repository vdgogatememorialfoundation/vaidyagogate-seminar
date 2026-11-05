/**
 * Real-time scan event log for admin live scanner dashboard.
 */
const SCAN_OUTCOMES = new Set([
    'success',
    'duplicate',
    'failed',
    'not_found',
    'unpaid',
    'invalid',
    'wrong_seminar',
    'wrong_date',
    'expired',
    'checkin_disabled',
    'account_blocked'
]);

function ensureTicketScanEventsTable(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS ticket_scan_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER NOT NULL,
            ticket_db_id INTEGER,
            ticket_id_string TEXT,
            application_no TEXT,
            doctor_user_id INTEGER,
            doctor_name TEXT,
            outcome TEXT NOT NULL,
            message TEXT,
            scanned_by INTEGER,
            day_id INTEGER,
            day_title TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        [],
        (err) => {
            if (err && !/already exists/i.test(String(err.message))) return cb && cb(err);
            db.run(
                `CREATE INDEX IF NOT EXISTS idx_ticket_scan_events_seminar_time ON ticket_scan_events (seminar_id, id DESC)`,
                [],
                () => {
                    db.run(`ALTER TABLE ticket_scan_events ADD COLUMN day_id INTEGER`, [], () => {
                        db.run(`ALTER TABLE ticket_scan_events ADD COLUMN day_title TEXT`, [], () => cb && cb(null));
                    });
                }
            );
        }
    );
}

function recordTicketScanEvent(db, row, cb) {
    if (!db || !row || !row.seminar_id) return cb && cb(null, null);
    const outcome = SCAN_OUTCOMES.has(String(row.outcome)) ? String(row.outcome) : 'failed';
    ensureTicketScanEventsTable(db, (eTable) => {
        if (eTable) {
            console.warn('[scan-events] table:', eTable.message);
            return cb && cb(null, null);
        }
        db.run(
            `INSERT INTO ticket_scan_events (
                seminar_id, ticket_db_id, ticket_id_string, application_no,
                doctor_user_id, doctor_name, outcome, message, scanned_by, day_id, day_title
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.seminar_id,
                row.ticket_db_id || null,
                row.ticket_id_string || null,
                row.application_no || null,
                row.doctor_user_id || null,
                row.doctor_name || null,
                outcome,
                row.message || null,
                row.scanned_by || null,
                row.day_id || null,
                row.day_title || null
            ],
            function (err) {
                if (err) console.warn('[scan-events] insert:', err.message);
                cb && cb(err, err ? null : this.lastID);
            }
        );
    });
}

function listTicketScanEvents(db, seminarId, opts, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return cb(new Error('Invalid seminar'));
    const sinceId = parseInt(opts && opts.sinceId, 10);
    const limit = Math.min(200, Math.max(1, parseInt(opts && opts.limit, 10) || 80));
    const params = [sid];
    let sql = `SELECT e.*, u.first_name AS scanner_first, u.last_name AS scanner_last,
                      COALESCE(e.day_id, tk.day_id) AS eff_day_id,
                      COALESCE(e.day_title, sdy.title) AS eff_day_title,
                      sdy.day_date AS eff_day_date
               FROM ticket_scan_events e
               LEFT JOIN users u ON u.id = e.scanned_by
               LEFT JOIN tickets tk ON tk.id = e.ticket_db_id
               LEFT JOIN seminar_days sdy ON sdy.id = COALESCE(e.day_id, tk.day_id)
               WHERE e.seminar_id = ?`;
    // Live board default: only scans of registrations that actually hold an issued e-ticket.
    if (opts && opts.issuedOnly) {
        sql += ` AND EXISTS (
                    SELECT 1 FROM registrations r
                     WHERE r.seminar_id = e.seminar_id
                       AND r.application_no = e.application_no
                       AND LOWER(r.status) = 'e_ticket_issued')`;
    }
    if (Number.isInteger(sinceId) && sinceId > 0) {
        sql += ` AND e.id > ?`;
        params.push(sinceId);
    }
    sql += ` ORDER BY e.id DESC LIMIT ?`;
    params.push(limit);
    db.all(sql, params, (err, rows) => {
        if (err) return cb(err);
        const list = (rows || []).map((r) => ({
            id: r.id,
            seminarId: r.seminar_id,
            ticketId: r.ticket_id_string,
            applicationNo: r.application_no,
            doctorUserId: r.doctor_user_id,
            doctorName: r.doctor_name,
            outcome: r.outcome,
            message: r.message,
            scannedBy: r.scanned_by,
            scannerName: [r.scanner_first, r.scanner_last].filter(Boolean).join(' ').trim() || null,
            dayId: r.eff_day_id != null ? Number(r.eff_day_id) : null,
            dayTitle: r.eff_day_title || null,
            dayDate: r.eff_day_date ? String(r.eff_day_date).slice(0, 10) : null,
            createdAt: r.created_at
        }));
        cb(null, list.reverse());
    });
}

module.exports = {
    ensureTicketScanEventsTable,
    recordTicketScanEvent,
    listTicketScanEvents,
    SCAN_OUTCOMES
};

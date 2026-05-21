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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        [],
        (err) => {
            if (err && !/already exists/i.test(String(err.message))) return cb && cb(err);
            db.run(
                `CREATE INDEX IF NOT EXISTS idx_ticket_scan_events_seminar_time ON ticket_scan_events (seminar_id, id DESC)`,
                [],
                () => cb && cb(null)
            );
        }
    );
}

function recordTicketScanEvent(db, row, cb) {
    if (!db || !row || !row.seminar_id) return cb && cb(null);
    const outcome = SCAN_OUTCOMES.has(String(row.outcome)) ? String(row.outcome) : 'failed';
    ensureTicketScanEventsTable(db, (eTable) => {
        if (eTable) {
            console.warn('[scan-events] table:', eTable.message);
            return cb && cb(null);
        }
        db.run(
            `INSERT INTO ticket_scan_events (
                seminar_id, ticket_db_id, ticket_id_string, application_no,
                doctor_user_id, doctor_name, outcome, message, scanned_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.seminar_id,
                row.ticket_db_id || null,
                row.ticket_id_string || null,
                row.application_no || null,
                row.doctor_user_id || null,
                row.doctor_name || null,
                outcome,
                row.message || null,
                row.scanned_by || null
            ],
            (err) => {
                if (err) console.warn('[scan-events] insert:', err.message);
                cb && cb(err);
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
    let sql = `SELECT e.*, u.first_name AS scanner_first, u.last_name AS scanner_last
               FROM ticket_scan_events e
               LEFT JOIN users u ON u.id = e.scanned_by
               WHERE e.seminar_id = ?`;
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

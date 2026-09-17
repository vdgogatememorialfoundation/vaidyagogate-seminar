/**
 * Admin live scanner dashboard — near real-time scan feed (poll ~1s).
 */
const ticketScanEvents = require('./ticket-scan-events');

function registerLiveScannerRoutes(app, { db, requireAdminActor }) {
    app.get('/api/admin/live-scanner/seminars', (req, res) => {
        requireAdminActor(req, res, () => {
        db.all(
            `SELECT id, title, event_date, checkin_date, checkin_enabled
             FROM seminars
             WHERE IFNULL(checkin_enabled, 0) = 1
             ORDER BY event_date DESC, id DESC`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
        });
    });

    app.get('/api/admin/live-scanner/events', (req, res) => {
        requireAdminActor(req, res, () => {
        const seminarId = req.query.seminarId;
        const sinceId = req.query.sinceId;
        ticketScanEvents.listTicketScanEvents(
            db,
            seminarId,
            { sinceId, limit: req.query.limit },
            (err, events) => {
                if (err) return res.status(500).json({ error: err.message });
                const list = events || [];
                // Older events (before day columns) -- backfill day from the ticket row.
                const missing = list.filter((ev) => ev.dayTitle == null && ev.ticketId);
                if (!missing.length) {
                    return res.json({ events: list, serverTime: new Date().toISOString() });
                }
                let left = missing.length;
                missing.forEach((ev) => {
                    db.get(
                        `SELECT sday.title AS day_title, sday.day_date AS day_date
                         FROM tickets t LEFT JOIN seminar_days sday ON sday.id = t.day_id
                         WHERE TRIM(t.ticket_id_string) = TRIM(?) LIMIT 1`,
                        [ev.ticketId],
                        (_e, row) => {
                            if (row && row.day_title) {
                                ev.dayTitle = row.day_title;
                                ev.dayDate = row.day_date || null;
                            }
                            if (--left === 0) {
                                res.json({ events: list, serverTime: new Date().toISOString() });
                            }
                        }
                    );
                });
            }
        );
        });
    });

    app.get('/api/admin/live-scanner/stats', (req, res) => {
        requireAdminActor(req, res, () => {
        const seminarId = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        const dayId = parseInt(req.query.dayId, 10);
        const dayFilter = Number.isInteger(dayId) && dayId > 0;
        const params = [seminarId];
        let where = 'WHERE e.seminar_id = ?';
        if (dayFilter) {
            where += ' AND e.day_id = ?';
            params.push(dayId);
        }
        db.get(
            `SELECT
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
                SUM(CASE WHEN outcome = 'duplicate' THEN 1 ELSE 0 END) AS duplicate_count,
                SUM(CASE WHEN outcome NOT IN ('success','duplicate') THEN 1 ELSE 0 END) AS failed_count,
                COUNT(*) AS total_events,
                MAX(id) AS last_event_id
             FROM ticket_scan_events e ` + where,
            params,
            (err, agg) => {
                if (err) return res.status(500).json({ error: err.message });
                const tixSql =
                    `SELECT COUNT(*) AS scanned FROM tickets t
                     JOIN orders o ON o.id = t.order_id
                     JOIN registrations r ON r.id = o.registration_id
                     WHERE r.seminar_id = ? AND IFNULL(t.is_scanned, 0) = 1` +
                    (dayFilter ? ' AND t.day_id = ?' : '');
                db.get(tixSql, dayFilter ? [seminarId, dayId] : [seminarId], (e2, scannedRow) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        res.json({
                            successCount: Number(agg && agg.success_count) || 0,
                            duplicateCount: Number(agg && agg.duplicate_count) || 0,
                            failedCount: Number(agg && agg.failed_count) || 0,
                            totalEvents: Number(agg && agg.total_events) || 0,
                            lastEventId: agg && agg.last_event_id ? Number(agg.last_event_id) : 0,
                            ticketsScanned: Number(scannedRow && scannedRow.scanned) || 0
                        });
                });
            }
        );
        });
    });

    app.get('/api/admin/live-scanner/days', (req, res) => {
        requireAdminActor(req, res, () => {
        const seminarId = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        db.all(
            `SELECT id, title, day_date, checkin_date
             FROM seminar_days
             WHERE seminar_id = ? AND IFNULL(is_active, 1) = 1
             ORDER BY day_date ASC, id ASC`,
            [seminarId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
        });
    });

    app.get('/api/admin/live-scanner/registrations', (req, res) => {
        requireAdminActor(req, res, () => {
        const seminarId = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        const dayId = parseInt(req.query.dayId, 10);
        const hasDay = Number.isInteger(dayId) && dayId > 0;
        // One row per (registration, day) pair when all days; one row per
        // registration for the chosen day. Seminars without configured days
        // still list each registration once (day fields NULL).
        const dayClause = hasDay ? 'AND sday.id = ?' : '';
        const params = hasDay ? [dayId, seminarId] : [seminarId];
        const sql =
            `SELECT r.id AS registration_id,
                    r.application_no,
                    r.status AS reg_status,
                    u.first_name,
                    u.last_name,
                    u.email,
                    sday.id AS day_id,
                    sday.title AS day_title,
                    sday.day_date,
                    t.id AS ticket_db_id,
                    t.ticket_id_string,
                    IFNULL(t.is_scanned, 0) AS is_scanned,
                    t.scan_time
             FROM registrations r
             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN seminar_days sday ON sday.seminar_id = r.seminar_id ${dayClause}
             LEFT JOIN orders o ON o.registration_id = r.id
             LEFT JOIN tickets t ON t.order_id = o.id
                                    AND (t.day_id = sday.id OR sday.id IS NULL)
             WHERE r.seminar_id = ?
             ORDER BY IFNULL(u.first_name, ''), IFNULL(u.last_name, ''), r.id,
                      IFNULL(sday.sort_order, 0), sday.day_date, sday.id`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const list = (rows || []).map((row) => {
                const scanned = row.is_scanned === true || Number(row.is_scanned) === 1;
                const first = row.first_name || '';
                const last = row.last_name || '';
                return {
                    registrationId: row.registration_id,
                    applicationNo: row.application_no || null,
                    status: row.reg_status || null,
                    name: (first + ' ' + last).trim() || 'Unnamed applicant',
                    email: row.email || null,
                    dayId: row.day_id || null,
                    dayTitle: row.day_title || null,
                    dayDate: row.day_date || null,
                    ticketId: row.ticket_id_string || null,
                    checkedIn: scanned,
                    scanTime: scanned ? row.scan_time || null : null
                };
            });
            res.json({ registrations: list, seminarId, dayId: hasDay ? dayId : null });
        });
        });
    });
}

module.exports = { registerLiveScannerRoutes };

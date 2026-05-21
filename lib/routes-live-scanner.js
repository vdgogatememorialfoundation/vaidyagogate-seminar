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
                res.json({ events: events || [], serverTime: new Date().toISOString() });
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
        db.get(
            `SELECT
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
                SUM(CASE WHEN outcome = 'duplicate' THEN 1 ELSE 0 END) AS duplicate_count,
                SUM(CASE WHEN outcome NOT IN ('success','duplicate') THEN 1 ELSE 0 END) AS failed_count,
                COUNT(*) AS total_events,
                MAX(id) AS last_event_id
             FROM ticket_scan_events WHERE seminar_id = ?`,
            [seminarId],
            (err, agg) => {
                if (err) return res.status(500).json({ error: err.message });
                db.get(
                    `SELECT COUNT(*) AS scanned FROM tickets t
                     JOIN orders o ON o.id = t.order_id
                     JOIN registrations r ON r.id = o.registration_id
                     WHERE r.seminar_id = ? AND IFNULL(t.is_scanned, 0) = 1`,
                    [seminarId],
                    (e2, scannedRow) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        res.json({
                            successCount: Number(agg && agg.success_count) || 0,
                            duplicateCount: Number(agg && agg.duplicate_count) || 0,
                            failedCount: Number(agg && agg.failed_count) || 0,
                            totalEvents: Number(agg && agg.total_events) || 0,
                            lastEventId: agg && agg.last_event_id ? Number(agg.last_event_id) : 0,
                            ticketsScanned: Number(scannedRow && scannedRow.scanned) || 0
                        });
                    }
                );
            }
        );
        });
    });
}

module.exports = { registerLiveScannerRoutes };

/**
 * Admin live scanner dashboard — near real-time scan feed (poll ~1s).
 */
const ticketScanEvents = require('./ticket-scan-events');
const { normalizeCheckinDateYmd, localDateYmd } = require('./local-date');

/** Effective check-in date (admin override else today IST) and the seminar day it maps to. */
function loadCheckinContext(db, seminarId, cb) {
    db.get(
        `SELECT checkin_date, checkin_enabled FROM seminars WHERE id = ?`,
        [seminarId],
        (err, sem) => {
            if (err) return cb(err);
            db.all(
                `SELECT id, title, day_date, checkin_date, checkin_enabled
                 FROM seminar_days WHERE seminar_id = ? ORDER BY day_date, sort_order, id`,
                [seminarId],
                (e2, days) => {
                    if (e2) return cb(e2);
                    const semEnabled = !!(sem && (sem.checkin_enabled === true || Number(sem.checkin_enabled) === 1));
                    const override = normalizeCheckinDateYmd(sem && sem.checkin_date);
                    const effective = semEnabled ? override || localDateYmd() : null;
                    const list = (days || []).map((d) => ({
                        id: d.id,
                        title: d.title,
                        dayDate: normalizeCheckinDateYmd(d.day_date),
                        checkinDate: normalizeCheckinDateYmd(d.checkin_date) || normalizeCheckinDateYmd(d.day_date),
                        enabled: d.checkin_enabled == null ? true : Number(d.checkin_enabled) === 1
                    }));
                    const active = effective ? list.find((d) => d.checkinDate === effective && d.enabled) || null : null;
                    cb(null, {
                        seminarCheckinEnabled: semEnabled,
                        overrideDate: semEnabled ? override || null : null,
                        effectiveDate: effective,
                        today: localDateYmd(),
                        activeDayId: active ? active.id : null,
                        activeDayTitle: active ? active.title : null,
                        days: list
                    });
                }
            );
        }
    );
}

function registerLiveScannerRoutes(app, { db, requireAdminActor }) {
    app.get('/api/admin/live-scanner/seminars', (req, res) => {
        requireAdminActor(req, res, () => {
        db.all(
            `SELECT id, title, event_date, checkin_date, checkin_enabled
             FROM seminars
             WHERE IFNULL(checkin_enabled, 0) = 1 OR is_active = 1
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
            { sinceId, limit: req.query.limit, issuedOnly: String(req.query.all || '') !== '1' },
            (err, events) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ events: events || [], serverTime: new Date().toISOString() });
            }
        );
        });
    });

    // Full attendee roster: every e-ticket-issued registration with its per-day tickets and scan state.
    app.get('/api/admin/live-scanner/roster', (req, res) => {
        requireAdminActor(req, res, () => {
        const seminarId = parseInt(req.query.seminarId, 10);
        if (!Number.isInteger(seminarId) || seminarId < 1) {
            return res.status(400).json({ error: 'seminarId required' });
        }
        db.all(
            `SELECT r.id AS registration_id, r.application_no, r.status,
                    u.first_name, u.last_name, u.email, u.phone,
                    t.id AS ticket_db_id, t.ticket_id_string, t.is_scanned, t.scan_time, t.day_id,
                    IFNULL(t.is_valid, 1) AS is_valid,
                    sd.title AS day_title, sd.day_date
             FROM registrations r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN orders o ON o.registration_id = r.id AND LOWER(TRIM(o.status)) = 'success'
             LEFT JOIN tickets t ON t.order_id = o.id
             LEFT JOIN seminar_days sd ON sd.id = t.day_id
             WHERE r.seminar_id = ? AND LOWER(TRIM(r.status)) = 'e_ticket_issued'
             ORDER BY u.first_name, u.last_name, r.id, sd.day_date, t.id`,
            [seminarId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const byReg = new Map();
                (rows || []).forEach((row) => {
                    let reg = byReg.get(row.registration_id);
                    if (!reg) {
                        reg = {
                            registrationId: row.registration_id,
                            applicationNo: row.application_no,
                            name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Guest',
                            email: row.email || '',
                            phone: row.phone || '',
                            tickets: []
                        };
                        byReg.set(row.registration_id, reg);
                    }
                    if (row.ticket_id_string && !reg.tickets.some((t) => t.ticketId === row.ticket_id_string)) {
                        reg.tickets.push({
                            ticketId: row.ticket_id_string,
                            dayId: row.day_id || null,
                            dayTitle: row.day_title || null,
                            dayDate: normalizeCheckinDateYmd(row.day_date) || null,
                            scanned: row.is_scanned === true || Number(row.is_scanned) === 1,
                            scanTime: row.scan_time || null,
                            valid: Number(row.is_valid) !== 0
                        });
                    }
                });
                loadCheckinContext(db, seminarId, (e3, checkin) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    let roster = Array.from(byReg.values());
                    if (!checkin.seminarCheckinEnabled) {
                        roster = [];
                        checkin.days = [];
                        checkin.lockedToDay = true;
                    } else if (checkin.activeDayId) {
                        roster = roster
                            .map((r) => ({
                                ...r,
                                tickets: r.tickets.filter((t) => Number(t.dayId) === Number(checkin.activeDayId))
                            }))
                            .filter((r) => r.tickets.length);
                        checkin.days = checkin.days.filter((d) => d.id === checkin.activeDayId);
                        checkin.lockedToDay = true;
                    } else if (checkin.days.length) {
                        roster = [];
                        checkin.lockedToDay = true;
                        checkin.noDayForDate = true;
                    }
                    const attendeesCheckedIn = roster.filter((r) => r.tickets.some((t) => t.scanned)).length;
                    res.json({ roster, total: roster.length, checkedIn: attendeesCheckedIn, checkin });
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

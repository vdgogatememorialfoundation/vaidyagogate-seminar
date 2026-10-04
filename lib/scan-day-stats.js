'use strict';

const ticketScanEvents = require('./ticket-scan-events');

/**
 * Day-wise scan statistics for multi-day seminars.
 * A scan event belongs to the day recorded on the event; older events without
 * a day are attributed through the ticket they scanned.
 */
let schemaReady = false;

function dayWiseScanStats(db, seminarId, cb) {
    if (schemaReady) return dayWiseScanStatsInner(db, seminarId, cb);
    ticketScanEvents.ensureTicketScanEventsTable(db, () => {
        schemaReady = true;
        dayWiseScanStatsInner(db, seminarId, cb);
    });
}

function dayWiseScanStatsInner(db, seminarId, cb) {
    db.all(
        `SELECT id, title, day_date, checkin_date, sort_order
         FROM seminar_days
         WHERE seminar_id = ? AND IFNULL(is_active, 1) = 1
         ORDER BY day_date ASC, sort_order ASC, id ASC`,
        [seminarId],
        (e1, dayRows) => {
            if (e1) return cb(e1);
            db.all(
                `SELECT COALESCE(e.day_id, t.day_id) AS eff_day,
                        e.scanned_by AS scanner_id,
                        u.first_name AS sf, u.last_name AS sl, u.user_id_string AS sus,
                        SUM(CASE WHEN e.outcome = 'success' THEN 1 ELSE 0 END) AS ok,
                        SUM(CASE WHEN e.outcome = 'duplicate' THEN 1 ELSE 0 END) AS dup,
                        SUM(CASE WHEN e.outcome NOT IN ('success','duplicate') THEN 1 ELSE 0 END) AS bad,
                        MAX(e.id) AS last_id,
                        MAX(e.created_at) AS last_at
                 FROM ticket_scan_events e
                 LEFT JOIN tickets t ON t.id = e.ticket_db_id
                 LEFT JOIN users u ON u.id = e.scanned_by
                 WHERE e.seminar_id = ?
                 GROUP BY COALESCE(e.day_id, t.day_id), e.scanned_by, u.first_name, u.last_name, u.user_id_string`,
                [seminarId],
                (e2, evRows) => {
                    if (e2) return cb(e2);
                    db.all(
                        `SELECT t.day_id AS day_id,
                                COUNT(*) AS total,
                                SUM(CASE WHEN IFNULL(t.is_scanned, 0) = 1 THEN 1 ELSE 0 END) AS scanned
                         FROM tickets t
                         JOIN orders o ON o.id = t.order_id
                         JOIN registrations r ON r.id = o.registration_id
                         WHERE r.seminar_id = ?
                         GROUP BY t.day_id`,
                        [seminarId],
                        (e3, tixRows) => {
                            if (e3) return cb(e3);
                            const tixByDay = {};
                            (tixRows || []).forEach((r) => {
                                tixByDay[r.day_id == null ? 'none' : r.day_id] = r;
                            });
                            const mk = (d) => ({
                                dayId: d ? d.id : null,
                                title: d ? d.title || `Day ${d.id}` : 'Day not recorded',
                                dayDate: d ? d.day_date || d.checkin_date || null : null,
                                successCount: 0,
                                duplicateCount: 0,
                                failedCount: 0,
                                totalEvents: 0,
                                lastEventId: 0,
                                lastScanAt: null,
                                ticketsTotal: 0,
                                ticketsScanned: 0,
                                scanners: []
                            });
                            const byId = {};
                            const days = (dayRows || []).map((d, i) => {
                                const o = mk(d);
                                o.dayNumber = i + 1;
                                byId[d.id] = o;
                                const tx = tixByDay[d.id];
                                if (tx) {
                                    o.ticketsTotal = Number(tx.total) || 0;
                                    o.ticketsScanned = Number(tx.scanned) || 0;
                                }
                                return o;
                            });
                            const other = mk(null);
                            (evRows || []).forEach((r) => {
                                const target = r.eff_day != null && byId[r.eff_day] ? byId[r.eff_day] : other;
                                const ok = Number(r.ok) || 0;
                                const dup = Number(r.dup) || 0;
                                const bad = Number(r.bad) || 0;
                                target.successCount += ok;
                                target.duplicateCount += dup;
                                target.failedCount += bad;
                                target.totalEvents += ok + dup + bad;
                                target.lastEventId = Math.max(target.lastEventId, Number(r.last_id) || 0);
                                if (r.last_at && (!target.lastScanAt || r.last_at > target.lastScanAt)) {
                                    target.lastScanAt = r.last_at;
                                }
                                const name = r.scanner_id
                                    ? `${r.sf || ''} ${r.sl || ''}`.trim() || r.sus || `User #${r.scanner_id}`
                                    : 'Unknown';
                                target.scanners.push({
                                    scannerId: r.scanner_id || null,
                                    name,
                                    userIdString: r.sus || null,
                                    successCount: ok,
                                    duplicateCount: dup,
                                    failedCount: bad
                                });
                            });
                            days.forEach((d) => d.scanners.sort((a, b) => b.successCount - a.successCount));
                            other.scanners.sort((a, b) => b.successCount - a.successCount);
                            cb(null, { days, unassigned: other.totalEvents > 0 ? other : null });
                        }
                    );
                }
            );
        }
    );
}

module.exports = { dayWiseScanStats };

/**
 * Post-event ticket expiry.
 *
 * Once a seminar's QR validity window closes (admin-set `seminars.ticket_expires_at`, else
 * 00:00 IST the day after `event_end_date` / `event_date` / last `seminar_days` date), every
 * registration still sitting at `e_ticket_issued` whose tickets were never scanned is moved
 * to `expired` and its tickets are flagged invalid so the scanner rejects them.
 */
const { ticketExpiryMs } = require('./local-date');
const seminarDt = require('./seminar-datetime');

const EXPIRABLE_STATUSES = ['e_ticket_issued'];

function seminarExpiryMs(sem, days) {
    const list = seminarDt.seminarDateList(sem, days);
    const lastYmd = list.length ? list[list.length - 1] : null;
    return ticketExpiryMs({
        ticket_expires_at: sem.ticket_expires_at,
        event_date: sem.event_date,
        event_end_date: sem.event_end_date || (lastYmd ? lastYmd + 'T23:59:00' : null)
    });
}

function expireSeminar(db, sem, nowIso, cb) {
    const ph = EXPIRABLE_STATUSES.map(() => '?').join(',');
    db.all(
        `SELECT r.id
           FROM registrations r
          WHERE r.seminar_id = ?
            AND LOWER(TRIM(r.status)) IN (${ph})
            AND NOT EXISTS (
                SELECT 1 FROM tickets t JOIN orders o ON o.id = t.order_id
                 WHERE o.registration_id = r.id
                   AND (t.is_scanned = 1 OR IFNULL(t.scan_count, 0) > 0)
            )`,
        [sem.id, ...EXPIRABLE_STATUSES],
        (err, rows) => {
            if (err) return cb(err);
            const ids = (rows || []).map((r) => r.id);
            if (!ids.length) return cb(null, 0);
            const idPh = ids.map(() => '?').join(',');
            db.run(
                `UPDATE registrations SET status = 'expired', ticket_expired_at = ? WHERE id IN (${idPh})`,
                [nowIso, ...ids],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    db.run(
                        `UPDATE tickets SET is_valid = 0
                          WHERE order_id IN (SELECT id FROM orders WHERE registration_id IN (${idPh}))
                            AND IFNULL(scan_count, 0) = 0 AND (is_scanned IS NULL OR is_scanned = 0)`,
                        ids,
                        (tErr) => {
                            if (tErr) return cb(tErr);
                            cb(null, ids.length);
                        }
                    );
                }
            );
        }
    );
}

/** Runs across all seminars whose expiry moment has passed. */
function runTicketExpiry(db, cb) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    db.all(
        `SELECT id, event_date, event_end_date, ticket_expires_at FROM seminars WHERE event_date IS NOT NULL`,
        [],
        (err, sems) => {
            if (err) return cb && cb(err);
            const list = sems || [];
            const summary = { seminars: 0, expired: 0 };
            let i = 0;
            const next = () => {
                if (i >= list.length) return cb && cb(null, summary);
                const sem = list[i++];
                db.all(
                    `SELECT day_date FROM seminar_days WHERE seminar_id = ? AND IFNULL(is_active, 1) = 1 ORDER BY sort_order ASC, day_date ASC`,
                    [sem.id],
                    (dErr, days) => {
                        const expMs = seminarExpiryMs(sem, dErr ? [] : days);
                        if (expMs == null || now < expMs) return next();
                        expireSeminar(db, sem, nowIso, (eErr, n) => {
                            if (eErr) console.warn('[ticket-expiry] seminar', sem.id, eErr.message);
                            else if (n) {
                                summary.seminars++;
                                summary.expired += n;
                            }
                            next();
                        });
                    }
                );
            };
            next();
        }
    );
}

module.exports = { runTicketExpiry, seminarExpiryMs, EXPIRABLE_STATUSES };

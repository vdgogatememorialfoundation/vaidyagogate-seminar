/**
 * Seminar seat capacity — a seat is consumed only once an e-ticket has been issued
 * (status e_ticket_issued / checked_in / certificate_issued, or a ticket row exists).
 * Volunteers (active seminar_volunteers row or VOL_ ticket) never consume a seat.
 */
const ACTIVE_STATUSES_EXCLUDE = ['rejected', 'cancelled', 'waitlisted'];
const SEAT_STATUSES = ['e_ticket_issued', 'checked_in', 'certificate_issued'];

function countFilledSeats(db, seminarId, cb) {
    const statusPh = SEAT_STATUSES.map(() => '?').join(',');
    const exclPh = ACTIVE_STATUSES_EXCLUDE.map(() => '?').join(',');
    db.get(
        `SELECT COUNT(*) AS c FROM registrations r
         WHERE r.seminar_id = ?
         AND LOWER(IFNULL(r.status,'')) NOT IN (${exclPh})
         AND (
             LOWER(IFNULL(r.status,'')) IN (${statusPh})
             OR EXISTS (
                 SELECT 1 FROM tickets t JOIN orders o ON o.id = t.order_id
                 WHERE o.registration_id = r.id AND IFNULL(t.ticket_id_string,'') NOT LIKE 'VOL_%'
             )
         )
         AND NOT EXISTS (
             SELECT 1 FROM seminar_volunteers sv
             WHERE sv.seminar_id = r.seminar_id AND sv.user_id = r.user_id
             AND LOWER(IFNULL(sv.status,'')) <> 'removed'
         )
         AND NOT EXISTS (
             SELECT 1 FROM tickets t2 JOIN orders o2 ON o2.id = t2.order_id
             WHERE o2.registration_id = r.id AND t2.ticket_id_string LIKE 'VOL_%'
         )`,
        [seminarId, ...ACTIVE_STATUSES_EXCLUDE, ...SEAT_STATUSES],
        (err, row) => {
            if (err) return cb(err);
            cb(null, Number((row && row.c) || 0));
        }
    );
}

function getSeminarCapacity(db, seminarId, cb) {
    db.get(`SELECT id, title, capacity, price FROM seminars WHERE id = ?`, [seminarId], (err, sem) => {
        if (err) return cb(err);
        if (!sem) return cb(null, null);
        countFilledSeats(db, seminarId, (e2, filled) => {
            if (e2) return cb(e2);
            const cap = Number(sem.capacity) || 0;
            const unlimited = cap <= 0;
            const remaining = unlimited ? null : Math.max(0, cap - filled);
            const full = !unlimited && filled >= cap;
            cb(null, {
                seminarId,
                title: sem.title,
                price: Number(sem.price) || 0,
                capacity: cap,
                filled,
                remaining,
                unlimited,
                full
            });
        });
    });
}

function assertSeminarHasCapacity(db, seminarId, cb) {
    getSeminarCapacity(db, seminarId, (err, info) => {
        if (err) return cb(err);
        if (!info) return cb(null, { ok: false, error: 'Seminar not found.' });
        if (info.full) {
            return cb(null, {
                ok: false,
                error: `This seminar is full (${info.filled}/${info.capacity} seats). No more registrations can be accepted.`,
                capacity: info
            });
        }
        cb(null, { ok: true, capacity: info });
    });
}

module.exports = {
    ACTIVE_STATUSES_EXCLUDE,
    SEAT_STATUSES,
    countFilledSeats,
    getSeminarCapacity,
    assertSeminarHasCapacity
};

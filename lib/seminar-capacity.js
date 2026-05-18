/**
 * Seminar seat capacity — counts active registrations against seminars.capacity.
 */
const ACTIVE_STATUSES_EXCLUDE = ['rejected', 'cancelled'];

function countFilledSeats(db, seminarId, cb) {
    const placeholders = ACTIVE_STATUSES_EXCLUDE.map(() => '?').join(',');
    db.get(
        `SELECT COUNT(*) AS c FROM registrations
         WHERE seminar_id = ?
         AND LOWER(IFNULL(status,'')) NOT IN (${placeholders})`,
        [seminarId, ...ACTIVE_STATUSES_EXCLUDE],
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
    countFilledSeats,
    getSeminarCapacity,
    assertSeminarHasCapacity
};

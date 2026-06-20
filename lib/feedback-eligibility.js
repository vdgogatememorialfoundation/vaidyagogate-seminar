/**
 * Seminar feedback is available only after venue check-in (scanner or admin manual).
 */

const CHECKIN_REG_STATUSES = new Set(['checked_in', 'certificate_issued', 'completed']);

/** Portable SQL — alias as has_checkin; registration row must be `r`. */
const HAS_CHECKIN_SQL = `CASE
    WHEN LOWER(IFNULL(r.status, '')) IN ('checked_in', 'certificate_issued', 'completed') THEN 1
    WHEN EXISTS (
        SELECT 1 FROM orders o
        INNER JOIN tickets t ON t.order_id = o.id
        WHERE o.registration_id = r.id
          AND LOWER(IFNULL(o.status, '')) = 'success'
          AND (IFNULL(t.is_scanned, 0) = 1 OR IFNULL(t.scan_count, 0) > 0)
    ) THEN 1
    ELSE 0
END`;

function registrationRowHasCheckin(row) {
    if (!row) return false;
    if (row.has_checkin != null) return Number(row.has_checkin) === 1;
    const st = String(row.status || '').toLowerCase();
    return CHECKIN_REG_STATUSES.has(st);
}

function isFeedbackEligibleRegistration(row) {
    return registrationRowHasCheckin(row);
}

function loadRegistrationCheckin(db, { userId, seminarId }, cb) {
    const uid = parseInt(userId, 10);
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(sid) || sid < 1) {
        return cb(null, null);
    }
    db.get(
        `SELECT r.id, r.status, (${HAS_CHECKIN_SQL}) AS has_checkin
         FROM registrations r
         WHERE r.user_id = ? AND r.seminar_id = ?
         ORDER BY r.id DESC LIMIT 1`,
        [uid, sid],
        cb
    );
}

module.exports = {
    CHECKIN_REG_STATUSES,
    HAS_CHECKIN_SQL,
    registrationRowHasCheckin,
    isFeedbackEligibleRegistration,
    loadRegistrationCheckin
};

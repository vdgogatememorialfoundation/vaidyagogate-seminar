/**
 * Shared user lookup for portal auth (SQLite + PostgreSQL).
 */
const otpLib = require('./otp');

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function sqlEmailMatches(column = 'email') {
    return `LOWER(TRIM(${column})) = ?`;
}

/** Active user — SQLite and PostgreSQL store is_disabled as 0/1 integer. */
function sqlUserActive(column = 'is_disabled') {
    return `COALESCE(${column}, 0) = 0`;
}

function findUserByEmail(db, email, cb) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return cb(null, null);
    db.get(
        `SELECT id, user_id_string, first_name, last_name, email, phone, password, role, user_role,
                COALESCE(is_disabled, 0) AS is_disabled,
                doctor_category, doctor_modules,
                COALESCE(email_verified, 1) AS email_verified
         FROM users
         WHERE ${sqlEmailMatches('email')} AND ${sqlUserActive('is_disabled')}`,
        [emailNorm],
        cb
    );
}

/** Match active user by normalized 10-digit Indian mobile (email may differ). */
function findUserByPhone(db, phone, cb) {
    const norm =
        otpLib.normalizeOtpDestination('phone', phone) ||
        String(phone || '')
            .replace(/\D/g, '')
            .slice(-10);
    if (!norm || norm.length < 10) return cb(null, null);
    db.all(
        `SELECT id, user_id_string, first_name, last_name, email, phone, password, role, user_role, doctor_category, doctor_modules
         FROM users
         WHERE ${sqlUserActive('is_disabled')}`,
        [],
        (err, rows) => {
            if (err) return cb(err);
            const row = (rows || []).find((u) => otpLib.normalizeOtpDestination('phone', u.phone) === norm);
            cb(null, row || null);
        }
    );
}

function findUserByEmailAndPassword(db, email, password, cb) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return cb(null, null);
    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                is_disabled, COALESCE(is_banned, 0) AS is_banned, COALESCE(is_demo, 0) AS is_demo, admin_modules,
                doctor_category, doctor_modules,
                COALESCE(email_verified, 1) AS email_verified
         FROM users
         WHERE ${sqlEmailMatches('email')} AND password = ? AND ${sqlUserActive('is_disabled')}`,
        [emailNorm, password],
        cb
    );
}

function loginOtpDestination(channel, row) {
    if (channel === 'email') {
        return String(row.email || '')
            .trim()
            .toLowerCase();
    }
    return (
        otpLib.normalizeOtpDestination('phone', String(row.phone || '').trim()) ||
        String(row.phone || '').trim()
    );
}

module.exports = {
    normalizeEmail,
    sqlEmailMatches,
    sqlUserActive,
    findUserByEmail,
    findUserByPhone,
    findUserByEmailAndPassword,
    loginOtpDestination
};

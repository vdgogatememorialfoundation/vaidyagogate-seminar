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

/** Active user — works with SQLite 0/1 and PostgreSQL boolean. */
function sqlUserActive(column = 'is_disabled') {
    return `(COALESCE(${column}, 0) = 0 OR ${column} IS FALSE)`;
}

function findUserByEmail(db, email, cb) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return cb(null, null);
    db.get(
        `SELECT id, user_id_string, first_name, last_name, email, phone, password, role, user_role,
                COALESCE(is_disabled, 0) AS is_disabled,
                COALESCE(email_verified, 1) AS email_verified
         FROM users
         WHERE ${sqlEmailMatches('email')} AND ${sqlUserActive('is_disabled')}`,
        [emailNorm],
        cb
    );
}

function findUserByEmailAndPassword(db, email, password, cb) {
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return cb(null, null);
    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                is_disabled, COALESCE(is_banned, 0) AS is_banned, COALESCE(is_demo, 0) AS is_demo, admin_modules,
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
    findUserByEmailAndPassword,
    loginOtpDestination
};

/**
 * Email uniqueness: one doctor login per email; staff test accounts may share an email.
 * Staff sign-in can use 12-digit portal ID + password when email is duplicated.
 */
const userRoles = require('./user-roles');
const authUsers = require('./auth-users');

const PG_DOCTOR_EMAIL_INDEX = 'users_email_doctor_unique';

function isPostgres() {
    return !!require('./env-db').resolveDatabaseUrl();
}

/** Idempotent: drop global email UNIQUE, enforce unique email for doctor-class accounts only (PostgreSQL). */
function ensureUsersEmailPolicy(db, cb) {
    if (!isPostgres()) {
        return cb && cb(null);
    }
    const steps = [
        'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key',
        'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique',
        'DROP INDEX IF EXISTS users_email_key',
        'DROP INDEX IF EXISTS users_email_unique'
    ];
    let i = 0;
    const next = (err) => {
        if (err && !/does not exist|undefined/i.test(String(err.message))) {
            console.warn('[users-email-policy]', err.message);
        }
        if (i >= steps.length) return createPartialIndex();
        const sql = steps[i++];
        db.run(sql, [], next);
    };
    function createPartialIndex() {
        db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${PG_DOCTOR_EMAIL_INDEX}
             ON users (LOWER(TRIM(email)))
             WHERE LOWER(TRIM(COALESCE(user_role, 'doctor'))) IN ('doctor', 'event_attendee')`,
            [],
            (e2) => {
                if (e2) console.warn('[users-email-policy] partial index:', e2.message);
                cb && cb(null);
            }
        );
    }
    next(null);
}

function isPortalIdLogin(value) {
    const raw = String(value || '').trim();
    if (raw.includes('@')) return false;
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10;
}

function normalizePortalId(value) {
    return String(value || '')
        .replace(/\D/g, '');
}

/** True if another doctor-class account already uses this email (staff may share email). */
function doctorEmailTaken(db, emailNorm, excludeUserId, cb) {
    db.all(
        `SELECT id, user_role, role, user_id_string FROM users WHERE ${authUsers.sqlEmailMatches('email')}`,
        [emailNorm],
        (err, rows) => {
            if (err) return cb(err);
            const doctors = (rows || []).filter((r) => {
                if (excludeUserId != null && Number(r.id) === Number(excludeUserId)) return false;
                return userRoles.isDoctorPortalAccount(r);
            });
            cb(null, doctors.length > 0, doctors[0] || null);
        }
    );
}

function findUserByPortalIdAndPassword(db, portalId, password, cb) {
    const pid = normalizePortalId(portalId);
    if (!pid) return cb(null, null);
    db.get(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                is_disabled, COALESCE(is_banned, 0) AS is_banned, COALESCE(is_demo, 0) AS is_demo, admin_modules,
                doctor_category, doctor_modules,
                COALESCE(email_verified, 1) AS email_verified,
                created_at, activated_at, last_login_at
         FROM users
         WHERE REPLACE(TRIM(user_id_string), ' ', '') = ? AND password = ? AND ${authUsers.sqlUserActive('is_disabled')}`,
        [pid, password],
        cb
    );
}

/**
 * Login identifier: email (doctors / single match) or 12-digit portal ID (staff testing).
 */
function findUserForLogin(db, { identifier, password, portal }, cb) {
    const id = String(identifier || '').trim();
    if (!id || password === undefined || password === null) return cb(null, null);

    if (isPortalIdLogin(id)) {
        return findUserByPortalIdAndPassword(db, id, password, (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            return cb(null, row);
        });
    }

    const emailNorm = authUsers.normalizeEmail(id);
    if (!emailNorm) return cb(null, null);

    db.all(
        `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, password, role, user_role,
                is_disabled, COALESCE(is_banned, 0) AS is_banned, COALESCE(is_demo, 0) AS is_demo, admin_modules,
                doctor_category, doctor_modules,
                COALESCE(email_verified, 1) AS email_verified,
                created_at, activated_at, last_login_at
         FROM users
         WHERE ${authUsers.sqlEmailMatches('email')} AND password = ? AND ${authUsers.sqlUserActive('is_disabled')}`,
        [emailNorm, password],
        (err, rows) => {
            if (err) return cb(err);
            const matches = rows || [];
            if (!matches.length) return cb(null, null);
            if (matches.length === 1) return cb(null, matches[0]);
            const portalNorm = require('./portal-auth-policy').normalizeLoginPortal(portal);
            if (portalNorm && portalNorm !== 'public') {
                const staff = matches.filter((r) => userRoles.isStaffPortalAccount(r));
                if (staff.length === 1) return cb(null, staff[0]);
            }
            const doctors = matches.filter((r) => userRoles.isDoctorPortalAccount(r));
            if (doctors.length === 1) return cb(null, doctors[0]);
            return cb(null, null, {
                ambiguous: true,
                hint: 'Several accounts share this email. Sign in with your 12-digit Portal User ID instead of email.'
            });
        }
    );
}

module.exports = {
    ensureUsersEmailPolicy,
    isPortalIdLogin,
    normalizePortalId,
    doctorEmailTaken,
    findUserByPortalIdAndPassword,
    findUserForLogin,
    PG_DOCTOR_EMAIL_INDEX
};

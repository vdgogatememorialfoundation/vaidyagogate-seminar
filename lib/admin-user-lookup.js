/**
 * Admin CRM user search — email, portal ID, phone, name, or seminar application no (SQLite + PostgreSQL).
 */
const authUsers = require('./auth-users');
const userRoles = require('./user-roles');
const { resolveInternalUserId } = require('./internal-user-id');

function normalizePortalId(raw) {
    return String(raw || '')
        .replace(/\D/g, '');
}

function normalizePhoneDigits(raw) {
    return String(raw || '').replace(/\D/g, '');
}

/**
 * @param {import('./db')} db
 * @param {string} query
 * @param {(err: Error|null, rows: object[]) => void} cb
 */
function searchAdminUsers(db, query, cb) {
    const raw = String(query || '').trim();
    if (!raw) return cb(null, []);

    const emailNorm = authUsers.normalizeEmail(raw);
    const portalDigits = normalizePortalId(raw);
    const phoneDigits = normalizePhoneDigits(raw);
    const nameLike = `%${raw.toLowerCase().replace(/[%_]/g, '')}%`;

    const clauses = [];
    const params = [];

    if (raw.includes('@')) {
        clauses.push(authUsers.sqlEmailMatches('email'));
        params.push(emailNorm);
    }

    if (portalDigits.length >= 6) {
        clauses.push(`REPLACE(TRIM(user_id_string), ' ', '') = ?`);
        params.push(portalDigits);
        clauses.push(`TRIM(user_id_string) = ?`);
        params.push(portalDigits);
        if (portalDigits.length >= 10) {
            clauses.push(`user_id_string LIKE ?`);
            params.push(`%${portalDigits.slice(-10)}%`);
        }
    }

    if (phoneDigits.length >= 10) {
        const tail = phoneDigits.slice(-10);
        clauses.push(
            `REPLACE(REPLACE(REPLACE(TRIM(phone), ' ', ''), '-', ''), '+', '') LIKE ?`
        );
        params.push(`%${tail}%`);
    }

    if (raw.length >= 2 && !raw.includes('@')) {
        clauses.push(
            `(LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(COALESCE(middle_name,'')) LIKE ? OR LOWER(email) LIKE ?)`
        );
        params.push(nameLike, nameLike, nameLike, nameLike);
    }

    if (!clauses.length) return cb(null, []);

    const sql = `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, role, user_role,
                created_at, activated_at, last_login_at, IFNULL(email_verified, 1) AS email_verified
         FROM users
         WHERE (${clauses.join(' OR ')})
         ORDER BY id DESC
         LIMIT 25`;

    db.all(sql, params, (err, rows) => {
        if (err) return cb(err);
        const seen = new Set();
        const out = [];
        for (const row of rows || []) {
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            out.push({
                ...row,
                effective_user_role: userRoles.effectiveUserRole(row) || row.user_role || row.role,
                account_list: userRoles.isDoctorPortalAccount(row) ? 'doctors' : 'staff'
            });
        }
        cb(null, out);
    });
}

function mapUserForAdminResponse(row) {
    if (!row) return null;
    const mapped = {
        id: row.id,
        user_id_string: row.user_id_string,
        first_name: row.first_name,
        middle_name: row.middle_name,
        last_name: row.last_name,
        email: row.email,
        phone: row.phone,
        role: row.role,
        user_role: row.user_role,
        effective_user_role: row.effective_user_role || userRoles.effectiveUserRole(row),
        account_list: row.account_list || (userRoles.isDoctorPortalAccount(row) ? 'doctors' : 'staff'),
        created_at: row.created_at,
        activated_at: row.activated_at,
        last_login_at: row.last_login_at,
        email_verified: row.email_verified,
        application_no: row.application_no || null,
        registration_status: row.registration_status || null,
        seminar_id: row.seminar_id || null
    };
    return mapped;
}

/**
 * Search doctors for volunteer assignment — name, email, phone, portal ID, or application no for a seminar.
 */
function searchVolunteerDoctorsForSeminar(db, seminarId, query, cb) {
    const sid = parseInt(seminarId, 10);
    const raw = String(query || '').trim();
    if (!Number.isInteger(sid) || sid < 1 || !raw) return cb(null, []);

    const userIds = new Set();
    const appQ = raw.toUpperCase().replace(/[%_\\]/g, '');

    function collectFromUsers(next) {
        searchAdminUsers(db, raw, (err, rows) => {
            if (err) return next(err);
            (rows || []).forEach((row) => {
                if (row && userRoles.isDoctorPortalAccount(row)) userIds.add(row.id);
            });
            resolveInternalUserId(db, null, raw, (e2, uid) => {
                if (e2) return next(e2);
                if (uid) userIds.add(uid);
                next(null);
            });
        });
    }

    function loadMatches(next) {
        const ids = Array.from(userIds).slice(0, 25);
        if (!ids.length) return next(null, []);
        const placeholders = ids.map(() => '?').join(',');
        db.all(
            `SELECT u.id, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone, u.role, u.user_role,
                    u.created_at, u.activated_at, u.last_login_at, IFNULL(u.email_verified, 1) AS email_verified,
                    r.application_no, r.status AS registration_status, r.seminar_id
             FROM users u
             LEFT JOIN registrations r ON r.user_id = u.id AND r.seminar_id = ?
             WHERE u.id IN (${placeholders})
             ORDER BY u.id DESC`,
            [sid].concat(ids),
            (err, rows) => {
                if (err) return next(err);
                const seen = new Set();
                const out = [];
                for (const row of rows || []) {
                    if (!row || seen.has(row.id)) continue;
                    seen.add(row.id);
                    out.push(mapUserForAdminResponse(row));
                }
                next(null, out);
            }
        );
    }

    if (appQ.length >= 3) {
        db.all(
            `SELECT DISTINCT user_id AS id FROM registrations
             WHERE seminar_id = ? AND (UPPER(application_no) = ? OR UPPER(application_no) LIKE ?)`,
            [sid, appQ, appQ + '%'],
            (eApp, appRows) => {
                if (eApp) return cb(eApp);
                (appRows || []).forEach((r) => {
                    if (r && r.id) userIds.add(r.id);
                });
                collectFromUsers((e1) => {
                    if (e1) return cb(e1);
                    loadMatches(cb);
                });
            }
        );
    } else {
        collectFromUsers((e1) => {
            if (e1) return cb(e1);
            loadMatches(cb);
        });
    }
}

module.exports = {
    normalizePortalId,
    searchAdminUsers,
    searchVolunteerDoctorsForSeminar,
    mapUserForAdminResponse
};

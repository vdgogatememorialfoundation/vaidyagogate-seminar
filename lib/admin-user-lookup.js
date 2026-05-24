/**
 * Admin CRM user search — email, portal ID, phone, or name (SQLite + PostgreSQL).
 */
const authUsers = require('./auth-users');
const userRoles = require('./user-roles');

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
        email_verified: row.email_verified
    };
    return mapped;
}

module.exports = {
    normalizePortalId,
    searchAdminUsers,
    mapUserForAdminResponse
};

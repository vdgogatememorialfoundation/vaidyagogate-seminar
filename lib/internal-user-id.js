/**
 * Resolve portal user_id_string vs internal users.id without PG integer overflow.
 */
const PG_INT_MAX = 2147483647;

function safeInternalUserRowId(val) {
    const n = parseInt(val, 10);
    if (!Number.isInteger(n) || n < 1 || n > PG_INT_MAX) return null;
    return n;
}

function resolveInternalUserId(db, userId, userIdString, cb) {
    const n = safeInternalUserRowId(userId);
    if (n != null) {
        return db.get(`SELECT id, user_id_string FROM users WHERE id = ?`, [n], (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, null);
            return cb(null, row.id);
        });
    }
    const s = String(userIdString != null && userIdString !== '' ? userIdString : userId || '').trim();
    if (!s) return cb(null, null);
    const asNum = safeInternalUserRowId(s);
    const idLookup = asNum != null && String(asNum) === s ? asNum : -1;
    db.get(`SELECT id FROM users WHERE user_id_string = ? OR id = ?`, [s, idLookup], (e, row) => {
        if (e) return cb(e);
        cb(null, row ? row.id : null);
    });
}

function doctorNotFoundMessage(hint) {
    const h = String(hint || '').trim();
    if (/^\d{10,}$/.test(h)) {
        return 'That looks like an e-ticket number, not a portal User ID. Use the doctor PRN (e.g. USR_...).';
    }
    return 'Doctor not found. Enter portal User ID (e.g. USR_...) or internal numeric id.';
}

module.exports = {
    PG_INT_MAX,
    safeInternalUserRowId,
    resolveInternalUserId,
    doctorNotFoundMessage
};

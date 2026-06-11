/**
 * Find or create a portal user record for website / live-chat guests (support tickets).
 */
const crypto = require('crypto');

function splitName(name) {
    const parts = String(name || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return { first: 'Guest', last: 'Visitor' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

function insertGuestUser(db, uidStr, first, last, email, phone, cb) {
    const tempPass = 'GUEST_' + crypto.randomBytes(12).toString('hex');
    db.run(
        `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role, email_verified, profile_complete)
         VALUES (?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1, 0)`,
        [uidStr, first, last || null, email, phone || '', tempPass],
        function (err) {
            if (err && /no such column|profile_complete/i.test(String(err.message))) {
                return db.run(
                    `INSERT INTO users (user_id_string, first_name, last_name, email, phone, password, role, user_role, email_verified)
                     VALUES (?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 1)`,
                    [uidStr, first, last || null, email, phone || '', tempPass],
                    function (e2) {
                        if (e2) return cb(e2);
                        cb(null, this.lastID);
                    }
                );
            }
            if (err) return cb(err);
            cb(null, this.lastID);
        }
    );
}

function findOrCreateGuestPortalUser(db, fields, cb) {
    const email = String((fields && fields.email) || '')
        .trim()
        .toLowerCase();
    const phone = String((fields && fields.phone) || '').trim();
    const { first, last } = splitName(fields && fields.name);

    if (!email) return cb(new Error('Email is required'));

    db.get(`SELECT id, phone FROM users WHERE LOWER(email) = ?`, [email], (err, row) => {
        if (err) return cb(err);
        if (row) {
            if (phone && !String(row.phone || '').trim()) {
                return db.run(`UPDATE users SET phone = ? WHERE id = ?`, [phone, row.id], () => cb(null, row.id));
            }
            return cb(null, row.id);
        }
        const uidStr = 'GUEST_' + crypto.randomBytes(8).toString('hex');
        insertGuestUser(db, uidStr, first, last, email, phone, cb);
    });
}

module.exports = {
    findOrCreateGuestPortalUser,
    splitName
};

'use strict';

const FIRST_KEYS = ['fname', 'first_name', 'firstName'];
const MIDDLE_KEYS = ['mname', 'middle_name', 'middleName'];
const LAST_KEYS = ['lname', 'last_name', 'lastName'];

function pick(formData, keys) {
    for (const k of keys) {
        const v = formData[k];
        if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
}

function namePartsFromFormData(formData) {
    const src = formData && typeof formData === 'object' ? formData : {};
    return {
        first: pick(src, FIRST_KEYS),
        middle: pick(src, MIDDLE_KEYS),
        last: pick(src, LAST_KEYS),
        hasMiddleKey: MIDDLE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(src, k))
    };
}

/**
 * Keeps users.first_name / middle_name / last_name in step with the name
 * entered on the registration form so tickets, certificates and emails
 * (which read the users row) show the applicant's current name.
 * No-op when the form carries no first/last name.
 */
function syncUserNameFromFormData(db, userId, formData, cb) {
    const done = typeof cb === 'function' ? cb : () => {};
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return done(null, { changed: false });
    const parts = namePartsFromFormData(formData);
    if (!parts.first || !parts.last) return done(null, { changed: false });
    db.get(`SELECT first_name, middle_name, last_name FROM users WHERE id = ?`, [uid], (e, row) => {
        if (e) return done(e);
        if (!row) return done(null, { changed: false });
        const middle = parts.hasMiddleKey ? parts.middle || null : row.middle_name || null;
        if (
            String(row.first_name || '') === parts.first &&
            String(row.last_name || '') === parts.last &&
            String(row.middle_name || '') === String(middle || '')
        ) {
            return done(null, { changed: false });
        }
        db.run(
            `UPDATE users SET first_name = ?, middle_name = ?, last_name = ? WHERE id = ?`,
            [parts.first, middle, parts.last, uid],
            (uErr) => (uErr ? done(uErr) : done(null, { changed: true }))
        );
    });
}

module.exports = { syncUserNameFromFormData, namePartsFromFormData };

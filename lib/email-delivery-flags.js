/**
 * Track recipient mailbox issues (full inbox, invalid address) for admin visibility.
 */
function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[email-delivery-flags]', e.message);
    }
}

function classifyEmailError(errMsg, responseCode) {
    const msg = String(errMsg || '').toLowerCase();
    const code = responseCode != null ? Number(responseCode) : null;
    const mailboxFull =
        code === 552 ||
        /552/.test(msg) ||
        /mailbox full|mailbox is full|over quota|quota exceeded|storage limit|insufficient storage|user is over/i.test(
            msg
        );
    const invalidAddress =
        code === 550 ||
        code === 551 ||
        code === 553 ||
        /user unknown|no such user|invalid recipient|address rejected|does not exist|not found/i.test(msg);
    return { mailboxFull, invalidAddress };
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    db.run(
        `CREATE TABLE IF NOT EXISTS email_delivery_flags (
            email TEXT PRIMARY KEY,
            mailbox_full INTEGER DEFAULT 0,
            invalid_address INTEGER DEFAULT 0,
            last_error TEXT,
            last_error_at ${ts},
            updated_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`,
        (e) => {
            ignoreErr(e);
            cb && cb(null);
        }
    );
}

function recordEmailDeliveryFailure(db, email, errMsg, responseCode, cb) {
    const addr = String(email || '')
        .trim()
        .toLowerCase();
    if (!addr) return cb && cb(null);
    const { mailboxFull, invalidAddress } = classifyEmailError(errMsg, responseCode);
    if (!mailboxFull && !invalidAddress) return cb && cb(null);

    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);
        db.run(
            `INSERT INTO email_delivery_flags (email, mailbox_full, invalid_address, last_error, last_error_at, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(email) DO UPDATE SET
               mailbox_full = CASE WHEN excluded.mailbox_full = 1 THEN 1 ELSE email_delivery_flags.mailbox_full END,
               invalid_address = CASE WHEN excluded.invalid_address = 1 THEN 1 ELSE email_delivery_flags.invalid_address END,
               last_error = excluded.last_error,
               last_error_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP`,
            [addr, mailboxFull ? 1 : 0, invalidAddress ? 1 : 0, String(errMsg || '').slice(0, 500)],
            (e) => {
                if (e && !isPg()) {
                    return db.run(
                        `INSERT OR REPLACE INTO email_delivery_flags (email, mailbox_full, invalid_address, last_error, last_error_at, updated_at)
                         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [addr, mailboxFull ? 1 : 0, invalidAddress ? 1 : 0, String(errMsg || '').slice(0, 500)],
                        cb
                    );
                }
                cb && cb(e);
            }
        );
    });
}

function getFlagForEmail(db, email, cb) {
    const addr = String(email || '')
        .trim()
        .toLowerCase();
    if (!addr) return cb(null, null);
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.get(`SELECT * FROM email_delivery_flags WHERE email = ?`, [addr], (err, row) => {
            if (err) return cb(err);
            cb(null, row || null);
        });
    });
}

function listProblemEmails(db, cb) {
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.all(
            `SELECT email, mailbox_full, invalid_address, last_error, last_error_at, updated_at
             FROM email_delivery_flags
             WHERE mailbox_full = 1 OR invalid_address = 1
             ORDER BY updated_at DESC LIMIT 200`,
            [],
            cb
        );
    });
}

module.exports = {
    classifyEmailError,
    ensureSchema,
    recordEmailDeliveryFailure,
    getFlagForEmail,
    listProblemEmails
};

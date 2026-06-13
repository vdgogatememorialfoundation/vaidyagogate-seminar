/**
 * Razorpay / checkout payment attempt logging for admin (success, failure, cancel).
 */
const userClientTelemetry = require('./user-client-telemetry');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[payment-attempts]', e.message);
    }
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    db.run(
        `CREATE TABLE IF NOT EXISTS payment_attempts (
            id ${isPg() ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            registration_id INTEGER,
            user_id INTEGER,
            order_db_id INTEGER,
            application_no TEXT,
            user_name TEXT,
            user_email TEXT,
            user_phone TEXT,
            gateway TEXT,
            mode TEXT,
            amount REAL,
            status TEXT NOT NULL,
            error_code TEXT,
            error_description TEXT,
            razorpay_order_id TEXT,
            razorpay_payment_id TEXT,
            metadata_json TEXT,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`,
        (e) => {
            ignoreErr(e);
            cb && cb(null);
        }
    );
}

function logPaymentAttempt(db, row, cb) {
    ensureSchema(db, (schemaErr) => {
        if (schemaErr) return cb && cb(schemaErr);
        const meta =
            row.metadata != null
                ? typeof row.metadata === 'string'
                    ? row.metadata
                    : JSON.stringify(row.metadata)
                : null;
        db.run(
            `INSERT INTO payment_attempts (
                registration_id, user_id, order_db_id, application_no, user_name, user_email, user_phone,
                gateway, mode, amount, status, error_code, error_description,
                razorpay_order_id, razorpay_payment_id, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.registration_id || null,
                row.user_id || null,
                row.order_db_id || null,
                row.application_no || null,
                row.user_name || null,
                row.user_email || null,
                row.user_phone || null,
                row.gateway || 'razorpay',
                row.mode || null,
                row.amount != null ? Number(row.amount) : null,
                String(row.status || 'unknown'),
                row.error_code || null,
                row.error_description || null,
                row.razorpay_order_id || null,
                row.razorpay_payment_id || null,
                meta
            ],
            function (err) {
                cb && cb(err, this.lastID);
            }
        );
    });
}

function listRecentAttempts(db, opts, cb) {
    const limit = Math.min(200, Math.max(1, parseInt(opts && opts.limit, 10) || 50));
    const status = opts && opts.status ? String(opts.status) : '';
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        if (status) {
            return db.all(
                `SELECT * FROM payment_attempts WHERE status = ? ORDER BY id DESC LIMIT ?`,
                [status, limit],
                (err, rows) => cb(err, rows || [])
            );
        }
        db.all(`SELECT * FROM payment_attempts ORDER BY id DESC LIMIT ?`, [limit], (err, rows) =>
            cb(err, rows || [])
        );
    });
}

function listFailedForRegistration(db, registrationId, cb) {
    ensureSchema(db, (e) => {
        if (e) return cb(e);
        db.all(
            `SELECT * FROM payment_attempts WHERE registration_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 20`,
            [registrationId],
            (err, rows) => cb(err, rows || [])
        );
    });
}

function enrichFromUser(db, userId, base, cb) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb(null, base);
    db.get(
        `SELECT id, first_name, last_name, email, phone, user_id_string FROM users WHERE id = ?`,
        [uid],
        (err, u) => {
            if (err || !u) return cb(null, base);
            cb(null, {
                ...base,
                user_id: uid,
                user_name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim(),
                user_email: u.email,
                user_phone: u.phone
            });
        }
    );
}

module.exports = {
    ensureSchema,
    logPaymentAttempt,
    listRecentAttempts,
    listFailedForRegistration,
    enrichFromUser
};

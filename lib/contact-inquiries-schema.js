/**
 * Public website contact form submissions for admin follow-up.
 */
const SQLITE_DDL = `CREATE TABLE IF NOT EXISTS contact_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'new',
    admin_notes TEXT,
    replied_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
)`;

function ensureContactInquiriesSchema(db, ignoreErr, next) {
    let sql = SQLITE_DDL;
    if (process.env.DATABASE_URL) {
        try {
            const { AUX_TABLE_DDL } = require('./extended-schema-pg');
            const def = AUX_TABLE_DDL.find((t) => t.name === 'contact_inquiries');
            if (def && def.sql) sql = def.sql;
        } catch (_) {
            /* use sqlite ddl; sql-convert will adjust for PG */
        }
    }
    db.run(sql, (e) => {
        ignoreErr(e);
        if (next) next();
    });
}

module.exports = { ensureContactInquiriesSchema };

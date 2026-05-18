/**
 * Public website contact form submissions for admin follow-up.
 */
function ensureContactInquiriesSchema(db, ignoreErr, next) {
    db.run(
        `CREATE TABLE IF NOT EXISTS contact_inquiries (
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
        )`,
        (e) => {
            ignoreErr(e);
            if (next) next();
        }
    );
}

module.exports = { ensureContactInquiriesSchema };

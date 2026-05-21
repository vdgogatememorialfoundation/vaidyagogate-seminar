/**
 * Ensures support_tickets + ticket_messages match the API used by doctor/admin portals.
 */
function isPostgresEnv() {
    return !!process.env.DATABASE_URL;
}

function ensureSupportTicketSchema(db, ignoreErr, next) {
    const cols = [
        ['ticket_id', 'TEXT'],
        ['category', 'TEXT'],
        ['description', 'TEXT'],
        ['priority', "TEXT DEFAULT 'medium'"],
        ['attachment_path', 'TEXT'],
        ['assigned_to_admin', 'INTEGER'],
        ['updated_at', isPostgresEnv() ? 'TIMESTAMPTZ' : 'DATETIME'],
        ['resolved_at', isPostgresEnv() ? 'TIMESTAMPTZ' : 'DATETIME'],
        ['admin_response', 'TEXT'],
        ['expected_response_at', isPostgresEnv() ? 'TIMESTAMPTZ' : 'DATETIME']
    ];
    const pg = isPostgresEnv();

    const runCol = (i) => {
        if (i >= cols.length) return createMessagesTable();
        const [name, type] = cols[i];
        const sql = pg
            ? `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ${name} ${type}`
            : `ALTER TABLE support_tickets ADD COLUMN ${name} ${type}`;
        db.run(sql, (e) => {
            ignoreErr(e);
            runCol(i + 1);
        });
    };

    function createMessagesTable() {
        const msgSql = pg
            ? `CREATE TABLE IF NOT EXISTS ticket_messages (
                id SERIAL PRIMARY KEY,
                ticket_id TEXT NOT NULL,
                sender_id INTEGER NOT NULL,
                sender_type TEXT,
                message TEXT NOT NULL,
                attachment_path TEXT,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS ticket_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id TEXT NOT NULL,
                sender_id INTEGER NOT NULL,
                sender_type TEXT,
                message TEXT NOT NULL,
                attachment_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`;
        db.run(msgSql, (e) => {
            ignoreErr(e);
            const srcSql = pg
                ? `ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'portal'`
                : `ALTER TABLE ticket_messages ADD COLUMN source TEXT DEFAULT 'portal'`;
            db.run(srcSql, (eSrc) => {
                ignoreErr(eSrc);
            db.run(
                `UPDATE support_tickets SET ticket_id = tracking_id WHERE (ticket_id IS NULL OR ticket_id = '') AND tracking_id IS NOT NULL AND tracking_id != ''`,
                (e2) => {
                    ignoreErr(e2);
                    if (next) next();
                }
            );
            });
        });
    }

    const createSql = pg
        ? `CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY,
            ticket_id TEXT UNIQUE,
            tracking_id TEXT UNIQUE,
            user_id INTEGER,
            category TEXT,
            subject TEXT NOT NULL,
            description TEXT,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'open',
            attachment_path TEXT,
            assigned_to_admin INTEGER,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            admin_response TEXT
        )`
        : `CREATE TABLE IF NOT EXISTS support_tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id TEXT UNIQUE,
            tracking_id TEXT UNIQUE,
            user_id INTEGER,
            category TEXT,
            subject TEXT NOT NULL,
            description TEXT,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'open',
            attachment_path TEXT,
            assigned_to_admin INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME,
            resolved_at DATETIME,
            admin_response TEXT
        )`;

    db.run(createSql, (e) => {
        ignoreErr(e);
        runCol(0);
    });
}

module.exports = { ensureSupportTicketSchema };

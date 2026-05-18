/**
 * Ensures support_tickets + ticket_messages match the API used by doctor/admin portals.
 */
function ensureSupportTicketSchema(db, ignoreErr, next) {
    const cols = [
        ['ticket_id', 'TEXT'],
        ['category', 'TEXT'],
        ['description', 'TEXT'],
        ['priority', "TEXT DEFAULT 'medium'"],
        ['attachment_path', 'TEXT'],
        ['assigned_to_admin', 'INTEGER'],
        ['updated_at', 'DATETIME'],
        ['resolved_at', 'DATETIME'],
        ['admin_response', 'TEXT']
    ];

    const runCol = (i) => {
        if (i >= cols.length) return createMessagesTable();
        const [name, type] = cols[i];
        db.run(`ALTER TABLE support_tickets ADD COLUMN ${name} ${type}`, (e) => {
            ignoreErr(e);
            runCol(i + 1);
        });
    };

    function createMessagesTable() {
        db.run(
            `CREATE TABLE IF NOT EXISTS ticket_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id TEXT NOT NULL,
                sender_id INTEGER NOT NULL,
                sender_type TEXT,
                message TEXT NOT NULL,
                attachment_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            (e) => {
                ignoreErr(e);
                db.run(
                    `UPDATE support_tickets SET ticket_id = tracking_id WHERE (ticket_id IS NULL OR ticket_id = '') AND tracking_id IS NOT NULL AND tracking_id != ''`,
                    (e2) => {
                        ignoreErr(e2);
                        if (next) next();
                    }
                );
            }
        );
    }

    db.run(
        `CREATE TABLE IF NOT EXISTS support_tickets (
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
        )`,
        (e) => {
            ignoreErr(e);
            runCol(0);
        }
    );
}

module.exports = { ensureSupportTicketSchema };

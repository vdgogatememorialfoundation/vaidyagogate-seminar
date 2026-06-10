/**
 * Post-close feedback for support tickets.
 */
function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreSchemaErr(e) {
    if (e && !/duplicate|already exists/i.test(String(e.message))) {
        console.warn('[support-ticket-feedback]', e.message);
    }
}

function ensureSupportTicketFeedbackSchema(db, cb) {
    const pg = isPg();
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const sql = pg
        ? `CREATE TABLE IF NOT EXISTS support_ticket_feedback (
            id SERIAL PRIMARY KEY,
            ticket_ref TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            rating INTEGER NOT NULL,
            comment TEXT,
            closed_by_agent_id INTEGER,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ticket_ref, user_id)
        )`
        : `CREATE TABLE IF NOT EXISTS support_ticket_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_ref TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            rating INTEGER NOT NULL,
            comment TEXT,
            closed_by_agent_id INTEGER,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ticket_ref, user_id)
        )`;
    db.run(sql, (e) => {
        ignoreSchemaErr(e);
        if (cb) cb(e);
    });
}

function getTicketFeedback(db, ticketRef, cb) {
    const ref = String(ticketRef || '').trim();
    if (!ref) return cb(null, null);
    db.get(
        `SELECT f.*, u.first_name, u.last_name
         FROM support_ticket_feedback f
         LEFT JOIN users u ON u.id = f.user_id
         WHERE f.ticket_ref = ?
         ORDER BY f.id DESC LIMIT 1`,
        [ref],
        (e, row) => cb(e, row || null)
    );
}

function saveTicketFeedback(db, opts, cb) {
    const ticketRef = String(opts.ticketRef || '').trim();
    const userId = parseInt(opts.userId, 10);
    const rating = parseInt(opts.rating, 10);
    const comment = String(opts.comment || '').trim();
    if (!ticketRef) return cb(new Error('Ticket reference required'));
    if (!Number.isInteger(userId) || userId < 1) return cb(new Error('Invalid user'));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return cb(new Error('Rating must be between 1 and 5'));
    }
    ensureSupportTicketFeedbackSchema(db, (eSch) => {
        if (eSch) return cb(eSch);
        db.get(
            `SELECT id FROM support_ticket_feedback WHERE ticket_ref = ? AND user_id = ? LIMIT 1`,
            [ticketRef, userId],
            (eGet, existing) => {
                if (eGet) return cb(eGet);
                const agentId = opts.closedByAgentId || null;
                if (existing) {
                    return db.run(
                        `UPDATE support_ticket_feedback SET rating = ?, comment = ?, created_at = CURRENT_TIMESTAMP
                         WHERE ticket_ref = ? AND user_id = ?`,
                        [rating, comment || null, ticketRef, userId],
                        (uErr) => cb(uErr)
                    );
                }
                db.run(
                    `INSERT INTO support_ticket_feedback (ticket_ref, user_id, rating, comment, closed_by_agent_id)
                     VALUES (?, ?, ?, ?, ?)`,
                    [ticketRef, userId, rating, comment || null, agentId],
                    function (err) {
                        if (err) return cb(err);
                        cb(null, { success: true });
                    }
                );
            }
        );
    });
}

module.exports = {
    ensureSupportTicketFeedbackSchema,
    getTicketFeedback,
    saveTicketFeedback
};

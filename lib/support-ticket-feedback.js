/**
 * Post-close feedback for support tickets + one-time rating links.
 */
const crypto = require('crypto');
const notifEngine = require('./notification-engine');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreSchemaErr(e) {
    if (e && !/duplicate|already exists/i.test(String(e.message))) {
        console.warn('[support-ticket-feedback]', e.message);
    }
}

function isTerminalTicketStatus(status) {
    const st = String(status || '').toLowerCase();
    return st === 'closed' || st === 'resolved';
}

function newFeedbackToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function ratingPageUrl(token) {
    const base = notifEngine.publicBaseUrl().replace(/\/$/, '');
    return base + '/support-rate?token=' + encodeURIComponent(String(token || '').trim());
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
        const inviteSql = pg
            ? `CREATE TABLE IF NOT EXISTS support_ticket_feedback_invites (
                id SERIAL PRIMARY KEY,
                token TEXT NOT NULL UNIQUE,
                ticket_ref TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                closed_by_agent_id INTEGER,
                used_at ${ts},
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`
            : `CREATE TABLE IF NOT EXISTS support_ticket_feedback_invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                ticket_ref TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                closed_by_agent_id INTEGER,
                used_at ${ts},
                created_at ${ts} DEFAULT CURRENT_TIMESTAMP
            )`;
        db.run(inviteSql, (e2) => {
            ignoreSchemaErr(e2);
            if (cb) cb(e2 || e);
        });
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
                const finish = (err) => {
                    if (err) return cb(err);
                    if (opts.inviteToken) {
                        db.run(
                            `UPDATE support_ticket_feedback_invites SET used_at = CURRENT_TIMESTAMP WHERE token = ?`,
                            [String(opts.inviteToken).trim()],
                            () => cb(null, { success: true })
                        );
                    } else {
                        cb(null, { success: true });
                    }
                };
                if (existing) {
                    return db.run(
                        `UPDATE support_ticket_feedback SET rating = ?, comment = ?, created_at = CURRENT_TIMESTAMP
                         WHERE ticket_ref = ? AND user_id = ?`,
                        [rating, comment || null, ticketRef, userId],
                        finish
                    );
                }
                db.run(
                    `INSERT INTO support_ticket_feedback (ticket_ref, user_id, rating, comment, closed_by_agent_id)
                     VALUES (?, ?, ?, ?, ?)`,
                    [ticketRef, userId, rating, comment || null, agentId],
                    (err) => finish(err)
                );
            }
        );
    });
}

function createFeedbackInvite(db, opts, cb) {
    const ticketRef = String(opts.ticketRef || '').trim();
    const userId = parseInt(opts.userId, 10);
    const closedByAgentId = opts.closedByAgentId ? parseInt(opts.closedByAgentId, 10) : null;
    if (!ticketRef || !Number.isInteger(userId) || userId < 1) {
        return cb(new Error('Invalid ticket for feedback invite'));
    }
    ensureSupportTicketFeedbackSchema(db, (eSch) => {
        if (eSch) return cb(eSch);
        getTicketFeedback(db, ticketRef, (eFb, existing) => {
            if (eFb) return cb(eFb);
            if (existing) return cb(null, { skipped: true, reason: 'already_rated' });
            const token = newFeedbackToken();
            db.run(
                `DELETE FROM support_ticket_feedback_invites WHERE ticket_ref = ? AND used_at IS NULL`,
                [ticketRef],
                () => {
                    db.run(
                        `INSERT INTO support_ticket_feedback_invites (token, ticket_ref, user_id, closed_by_agent_id)
                         VALUES (?, ?, ?, ?)`,
                        [token, ticketRef, userId, closedByAgentId],
                        (insErr) => {
                            if (insErr) return cb(insErr);
                            cb(null, { token, url: ratingPageUrl(token) });
                        }
                    );
                }
            );
        });
    });
}

function resolveFeedbackToken(db, token, cb) {
    const tok = String(token || '').trim();
    if (!tok) return cb(null, null);
    ensureSupportTicketFeedbackSchema(db, (eSch) => {
        if (eSch) return cb(eSch);
        db.get(
            `SELECT i.*, st.subject, st.status, st.ticket_id, st.tracking_id, st.user_id,
                    u.first_name, u.last_name, u.email
             FROM support_ticket_feedback_invites i
             LEFT JOIN support_tickets st ON st.ticket_id = i.ticket_ref OR st.tracking_id = i.ticket_ref
             LEFT JOIN users u ON u.id = i.user_id
             WHERE i.token = ?
             LIMIT 1`,
            [tok],
            (e, row) => {
                if (e) return cb(e);
                if (!row) return cb(null, null);
                getTicketFeedback(db, row.ticket_ref, (e2, feedback) => {
                    if (e2) return cb(e2);
                    cb(null, {
                        token: tok,
                        ticketRef: row.ticket_ref,
                        ticketId: row.ticket_id || row.tracking_id || row.ticket_ref,
                        subject: row.subject || '',
                        status: row.status || '',
                        userId: row.user_id,
                        userName: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Participant',
                        alreadyRated: !!feedback,
                        rating: feedback ? feedback.rating : null,
                        used: !!row.used_at
                    });
                });
            }
        );
    });
}

function submitFeedbackByToken(db, token, rating, comment, cb) {
    resolveFeedbackToken(db, token, (e, info) => {
        if (e) return cb(e);
        if (!info) return cb(new Error('Invalid or expired rating link'));
        if (info.alreadyRated) return cb(new Error('Feedback was already submitted for this ticket'));
        saveTicketFeedback(
            db,
            {
                ticketRef: info.ticketRef,
                userId: info.userId || undefined,
                rating,
                comment,
                inviteToken: token
            },
            (saveErr, out) => {
                if (saveErr) return cb(saveErr);
                cb(null, out);
            }
        );
    });
}

function resolveFeedbackTokenWithUserId(db, token, cb) {
    const tok = String(token || '').trim();
    db.get(`SELECT * FROM support_ticket_feedback_invites WHERE token = ?`, [tok], (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(null, null);
        resolveFeedbackToken(db, token, (e2, info) => {
            if (e2) return cb(e2);
            if (!info) return cb(null, null);
            cb(null, Object.assign({}, info, { userId: row.user_id, closedByAgentId: row.closed_by_agent_id }));
        });
    });
}

function submitFeedbackByTokenFixed(db, token, rating, comment, cb) {
    resolveFeedbackTokenWithUserId(db, token, (e, info) => {
        if (e) return cb(e);
        if (!info) return cb(new Error('Invalid or expired rating link'));
        if (info.alreadyRated) return cb(new Error('Feedback was already submitted for this ticket'));
        saveTicketFeedback(
            db,
            {
                ticketRef: info.ticketRef,
                userId: info.userId,
                rating,
                comment,
                closedByAgentId: info.closedByAgentId,
                inviteToken: token
            },
            cb
        );
    });
}

module.exports = {
    ensureSupportTicketFeedbackSchema,
    getTicketFeedback,
    saveTicketFeedback,
    createFeedbackInvite,
    resolveFeedbackToken,
    submitFeedbackByToken: submitFeedbackByTokenFixed,
    ratingPageUrl,
    isTerminalTicketStatus
};

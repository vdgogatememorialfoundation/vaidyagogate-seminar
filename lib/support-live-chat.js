/**
 * Live chat sessions + messages (polling-based).
 */
const supportDesk = require('./support-desk');
const { ensureSupportDeskSchema } = require('./support-desk-schema');
const crypto = require('crypto');

function newVisitorKey() {
    return 'v_' + crypto.randomBytes(12).toString('hex');
}

function formatChatRef(sessionId) {
    const id = parseInt(sessionId, 10);
    if (!Number.isInteger(id) || id < 1) return '';
    return 'LCHAT-' + String(id).padStart(8, '0');
}

function parseChatRef(ref) {
    const raw = String(ref || '').trim().toUpperCase();
    const m = raw.match(/^LCHAT-(\d+)$/);
    if (m) return parseInt(m[1], 10);
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return null;
}

function agentDisplayName(row) {
    if (!row) return '';
    const fn = row.agent_first_name || row.first_name;
    const ln = row.agent_last_name || row.last_name;
    return [fn, ln].filter(Boolean).join(' ').trim();
}

function ensureLiveMessagesSchema(db, cb) {
    const pg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const sql = pg
        ? `CREATE TABLE IF NOT EXISTS support_live_messages (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL,
            sender_type TEXT NOT NULL,
            sender_id INTEGER,
            message TEXT NOT NULL,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS support_live_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            sender_type TEXT NOT NULL,
            sender_id INTEGER,
            message TEXT NOT NULL,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`;
    db.run(sql, (e) => cb && cb(e));
}

function pickLiveChatAgent(db, cb) {
    db.all(
        `SELECT u.id, u.first_name, u.last_name, p.max_open_tickets
         FROM users u
         JOIN support_agent_profiles p ON p.user_id = u.id
         WHERE IFNULL(u.is_disabled,0) = 0
           AND IFNULL(p.is_available,1) = 1
           AND IFNULL(p.live_chat_enabled,1) = 1
           AND LOWER(TRIM(COALESCE(u.user_role,''))) IN ('support_agent','staff_user','co_admin')
         ORDER BY u.id ASC`,
        [],
        (e, agents) => {
            if (e) return cb(e);
            if (!agents || !agents.length) return cb(null, null);
            let i = 0;
            const tryNext = () => {
                if (i >= agents.length) return cb(null, null);
                const agent = agents[i++];
                supportDesk.isAgentWithinHours(db, agent.id, new Date(), (eH, onDuty) => {
                    if (eH || !onDuty) return tryNext();
                    db.get(
                        `SELECT COUNT(*) AS c FROM support_live_sessions
                         WHERE assigned_agent_id = ? AND status = 'active'`,
                        [agent.id],
                        (eC, row) => {
                            if (eC) return cb(eC);
                            const active = parseInt(row && row.c, 10) || 0;
                            if (active >= 3) return tryNext();
                            cb(null, agent.id);
                        }
                    );
                });
            };
            tryNext();
        }
    );
}

function getSession(db, sessionId, cb) {
    const sid = parseInt(sessionId, 10);
    if (!Number.isInteger(sid)) return cb(new Error('Invalid session'));
    db.get(
        `SELECT s.*, u.first_name, u.last_name, u.email, u.user_id_string, u.phone,
                a.first_name AS agent_first_name, a.last_name AS agent_last_name, a.email AS agent_email
         FROM support_live_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users a ON a.id = s.assigned_agent_id
         WHERE s.id = ?`,
        [sid],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            cb(null, {
                sessionId: row.id,
                chatRef: formatChatRef(row.id),
                visitorKey: row.visitor_key,
                userId: row.user_id,
                assignedAgentId: row.assigned_agent_id,
                agentName: agentDisplayName(row) || null,
                status: row.status,
                channel: row.channel,
                linkedTicketId: row.linked_ticket_id || null,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                lastMessageAt: row.last_message_at,
                visitorName: row.first_name ? [row.first_name, row.last_name].filter(Boolean).join(' ') : null,
                visitorEmail: row.email || null,
                visitorPortalId: row.user_id_string || null
            });
        }
    );
}

function createSession(db, opts, cb) {
    const visitorKey = opts.visitorKey || newVisitorKey();
    const userId = opts.userId ? parseInt(opts.userId, 10) : null;
    const channel = opts.channel || 'web';
    const initialMessage = String(opts.initialMessage || '').trim();
    const cfg = supportDesk.getConfig();
    const canLive = cfg.liveChatEnabled && supportDesk.isWithinBusinessHours(cfg);

    ensureSupportDeskSchema(db, () => {
        ensureLiveMessagesSchema(db, () => {
        const finish = (sessionId, agentId, status) => {
            getSession(db, sessionId, (eS, session) => {
                const base = {
                    sessionId,
                    chatRef: formatChatRef(sessionId),
                    visitorKey,
                    agentId,
                    agentName: session && session.agentName,
                    status,
                    canLive,
                    linkedTicketId: session && session.linkedTicketId
                };
                if (!initialMessage) return cb(null, base);
                db.run(
                    `INSERT INTO support_live_messages (session_id, sender_type, sender_id, message) VALUES (?, 'visitor', ?, ?)`,
                    [sessionId, userId, initialMessage],
                    () => cb(null, base)
                );
            });
        };

        if (!canLive) {
            return db.run(
                `INSERT INTO support_live_sessions (visitor_key, user_id, status, channel, last_message_at)
                 VALUES (?, ?, 'offline', ?, CURRENT_TIMESTAMP)`,
                [visitorKey, userId, channel],
                function (insErr) {
                    if (insErr) return cb(insErr);
                    finish(this.lastID, null, 'offline');
                }
            );
        }

        pickLiveChatAgent(db, (ePick, agentId) => {
            if (ePick) return cb(ePick);
            const status = agentId ? 'active' : 'waiting';
            db.run(
                `INSERT INTO support_live_sessions (visitor_key, user_id, assigned_agent_id, status, channel, last_message_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [visitorKey, userId, agentId, status, channel],
                function (insErr) {
                    if (insErr) return cb(insErr);
                    const sessionId = this.lastID;
                    const supportDeskNotify = require('./support-desk-notify');
                    if (agentId) {
                        supportDeskNotify.notifyAgentLiveChatAssigned(db, agentId, sessionId, initialMessage, () => {});
                    } else {
                        supportDeskNotify.notifyAgentsLiveChatWaiting(db, sessionId, initialMessage, () => {});
                    }
                    finish(sessionId, agentId, status);
                }
            );
        });
    });
    });
}

function listMessages(db, sessionId, sinceId, cb) {
    const sid = parseInt(sessionId, 10);
    const since = parseInt(sinceId, 10) || 0;
    db.all(
        `SELECT m.id, m.session_id, m.sender_type, m.sender_id, m.message, m.created_at,
                u.first_name, u.last_name
         FROM support_live_messages m
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.session_id = ? AND m.id > ?
         ORDER BY m.id ASC`,
        [sid, since],
        (err, rows) => {
            if (err) return cb(err);
            cb(
                null,
                (rows || []).map((m) => ({
                    id: m.id,
                    session_id: m.session_id,
                    sender_type: m.sender_type,
                    sender_id: m.sender_id,
                    message: m.message,
                    created_at: m.created_at,
                    sender_name:
                        m.sender_type === 'system'
                            ? 'Support desk'
                            : m.sender_type === 'agent'
                              ? agentDisplayName(m) || 'Support agent'
                              : m.sender_type === 'visitor'
                                ? 'You'
                                : agentDisplayName(m) || 'Visitor'
                }))
            );
        }
    );
}

function addMessage(db, sessionId, senderType, senderId, message, cb) {
    const sid = parseInt(sessionId, 10);
    const msg = String(message || '').trim();
    if (!msg) return cb(new Error('Message required'));
    db.run(
        `INSERT INTO support_live_messages (session_id, sender_type, sender_id, message) VALUES (?, ?, ?, ?)`,
        [sid, senderType, senderId || null, msg],
        function (err) {
            if (err) return cb(err);
            db.run(
                `UPDATE support_live_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [sid],
                () => cb(null, { id: this.lastID })
            );
        }
    );
}

function addSystemMessage(db, sessionId, message, cb) {
    addMessage(db, sessionId, 'system', null, message, cb);
}

function claimSession(db, sessionId, agentId, cb) {
    const sid = parseInt(sessionId, 10);
    const aid = parseInt(agentId, 10);
    db.run(
        `UPDATE support_live_sessions SET assigned_agent_id = ?, status = 'active', last_message_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('waiting','active') AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)`,
        [aid, sid, aid],
        function (err) {
            if (err) return cb(err);
            if (!this.changes) return cb(new Error('Session not available'));
            getSession(db, sid, (eS, session) => {
                if (eS) return cb(eS);
                addSystemMessage(
                    db,
                    sid,
                    'You are now connected with ' +
                        (session && session.agentName ? session.agentName : 'a support agent') +
                        '. Chat reference: ' +
                        formatChatRef(sid) +
                        '.',
                    () => cb(null, { success: true, session })
                );
            });
        }
    );
}

function linkTicket(db, sessionId, ticketId, cb) {
    db.run(
        `UPDATE support_live_sessions SET linked_ticket_id = ? WHERE id = ?`,
        [String(ticketId || '').trim(), parseInt(sessionId, 10)],
        cb
    );
}

function closeSession(db, sessionId, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    const sid = parseInt(sessionId, 10);
    const closingMessage = String((opts && opts.closingMessage) || '').trim();
    const ticketId = opts && opts.ticketId ? String(opts.ticketId).trim() : null;

    const doClose = () => {
        db.run(
            `UPDATE support_live_sessions SET status = 'closed', ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [sid],
            (err) => cb && cb(err)
        );
    };

    getSession(db, sid, (eS, session) => {
        if (eS) return cb && cb(eS);
        const ref = formatChatRef(sid);
        const linked = ticketId || (session && session.linkedTicketId);
        let msg =
            closingMessage ||
            'This live chat has ended. Thank you for contacting VGMF support. Your chat reference is ' + ref + '.';
        if (linked) {
            msg += ' Support ticket: ' + linked + '. You can continue in the doctor portal under Support tickets.';
        } else {
            msg += ' For follow-up, open Support tickets or Live chat in the doctor portal, or email care@vaidyagogate.org.';
        }
        addSystemMessage(db, sid, msg, () => {
            if (ticketId) {
                return linkTicket(db, sid, ticketId, doClose);
            }
            doClose();
        });
    });
}

function doctorPortalTicketFormUrl() {
    const base =
        (process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org').replace(/\/$/, '');
    return base + '/doctor.html';
}

function ticketFormMessage(chatRef) {
    const url = doctorPortalTicketFormUrl();
    return (
        'To continue with a formal support ticket, sign in to the doctor portal and open Support tickets: ' +
        url +
        (chatRef ? ' (mention chat reference ' + chatRef + ' in your ticket).' : '.')
    );
}

module.exports = {
    newVisitorKey,
    formatChatRef,
    parseChatRef,
    ensureLiveMessagesSchema,
    createSession,
    getSession,
    listMessages,
    addMessage,
    addSystemMessage,
    claimSession,
    linkTicket,
    closeSession,
    pickLiveChatAgent,
    doctorPortalTicketFormUrl,
    ticketFormMessage,
    agentDisplayName
};

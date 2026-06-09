/**
 * Live chat sessions + messages (polling-based).
 */
const supportDesk = require('./support-desk');
const crypto = require('crypto');

function newVisitorKey() {
    return 'v_' + crypto.randomBytes(12).toString('hex');
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
        `SELECT u.id, p.max_open_tickets
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

function createSession(db, opts, cb) {
    const visitorKey = opts.visitorKey || newVisitorKey();
    const userId = opts.userId ? parseInt(opts.userId, 10) : null;
    const channel = opts.channel || 'web';
    const initialMessage = String(opts.initialMessage || '').trim();
    const cfg = supportDesk.getConfig();
    const canLive = cfg.liveChatEnabled && supportDesk.isWithinBusinessHours(cfg);

    ensureLiveMessagesSchema(db, () => {
        const finish = (sessionId, agentId, status) => {
            if (!initialMessage) return cb(null, { sessionId, visitorKey, agentId, status, canLive });
            db.run(
                `INSERT INTO support_live_messages (session_id, sender_type, sender_id, message) VALUES (?, 'visitor', ?, ?)`,
                [sessionId, userId, initialMessage],
                () => cb(null, { sessionId, visitorKey, agentId, status, canLive })
            );
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
                    if (agentId) {
                        const supportDeskNotify = require('./support-desk-notify');
                        supportDeskNotify.notifyAgentLiveChatAssigned(db, agentId, sessionId, initialMessage, () => {});
                    } else {
                        const supportDeskNotify = require('./support-desk-notify');
                        supportDeskNotify.notifyAgentsLiveChatWaiting(db, sessionId, initialMessage, () => {});
                    }
                    finish(sessionId, agentId, status);
                }
            );
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
        cb
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
            cb(null, { success: true });
        }
    );
}

function closeSession(db, sessionId, cb) {
    db.run(
        `UPDATE support_live_sessions SET status = 'closed', ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [parseInt(sessionId, 10)],
        cb
    );
}

module.exports = {
    newVisitorKey,
    ensureLiveMessagesSchema,
    createSession,
    listMessages,
    addMessage,
    claimSession,
    closeSession,
    pickLiveChatAgent
};

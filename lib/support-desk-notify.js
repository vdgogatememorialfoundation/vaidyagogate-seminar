/**
 * Support desk notifications: agent email + in-app inbox.
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');

function ensureInboxSchema(db, cb) {
    const pg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const sql = pg
        ? `CREATE TABLE IF NOT EXISTS support_desk_inbox (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            ref_id TEXT,
            read_at ${ts},
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS support_desk_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            ref_id TEXT,
            read_at ${ts},
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`;
    db.run(sql, (e) => cb && cb(e));
}

function pushInbox(db, row, cb) {
    ensureInboxSchema(db, () => {
        db.run(
            `INSERT INTO support_desk_inbox (user_id, type, title, body, link, ref_id) VALUES (?, ?, ?, ?, ?, ?)`,
            [row.userId, row.type, row.title, row.body || '', row.link || '', row.refId || ''],
            cb
        );
    });
}

function notifyAgentByEmail(db, agentId, subject, text, html, cb) {
    db.get(`SELECT id, email, first_name, last_name FROM users WHERE id = ?`, [parseInt(agentId, 10)], (e, u) => {
        if (e || !u || !u.email) return cb && cb(e || null, { skipped: true });
        notifEngine.enqueueDirectMessage(
            db,
            {
                channel: 'email',
                destination: u.email,
                subject,
                text,
                html,
                event_key: 'SUPPORT_AGENT_ALERT',
                immediate: true
            },
            cb
        );
    });
}

function notifyAgentTicketAssigned(db, agentId, ticketRow, cb) {
    if (!agentId || !ticketRow) return cb && cb(null, { skipped: true });
    const tid = ticketRow.ticket_id || ticketRow.tracking_id || '';
    const link = notifEngine.publicBaseUrl().replace(/\/$/, '') + '/support';
    const title = 'Ticket assigned: ' + tid;
    const body = (ticketRow.subject || 'Support ticket') + ' (' + (ticketRow.category || 'general') + ')';
    pushInbox(
        db,
        { userId: agentId, type: 'ticket_assigned', title, body, link, refId: tid },
        () => {
            notifyAgentByEmail(
                db,
                agentId,
                title,
                body + '\n\nOpen support desk: ' + link,
                '<p><strong>' +
                    title +
                    '</strong></p><p>' +
                    body +
                    '</p><p><a href="' +
                    link +
                    '">Open support desk</a></p>',
                cb
            );
        }
    );
}

function notifyAgentLiveChatAssigned(db, agentId, sessionId, preview, cb) {
    const link = notifEngine.publicBaseUrl().replace(/\/$/, '') + '/support#live';
    const title = 'Live chat connected';
    const body = preview || 'A visitor started live chat.';
    pushInbox(
        db,
        { userId: agentId, type: 'live_chat', title, body, link, refId: String(sessionId) },
        () => cb && cb(null, { queued: true })
    );
}

function notifyAgentsLiveChatWaiting(db, sessionId, preview, cb) {
    db.all(
        `SELECT u.id FROM users u
         JOIN support_agent_profiles p ON p.user_id = u.id
         WHERE IFNULL(u.is_disabled,0)=0 AND IFNULL(p.is_available,1)=1 AND IFNULL(p.live_chat_enabled,1)=1
           AND LOWER(TRIM(COALESCE(u.user_role,''))) IN ('support_agent','staff_user','co_admin')`,
        [],
        (e, agents) => {
            if (e || !agents || !agents.length) return cb && cb(e);
            const link = notifEngine.publicBaseUrl().replace(/\/$/, '') + '/support#live';
            let pending = agents.length;
            agents.forEach((a) => {
                pushInbox(
                    db,
                    {
                        userId: a.id,
                        type: 'live_chat_waiting',
                        title: 'Visitor waiting for live chat',
                        body: preview || 'New live chat in queue.',
                        link,
                        refId: String(sessionId)
                    },
                    () => {
                        pending--;
                        if (pending === 0) cb && cb(null, { queued: true });
                    }
                );
            });
        }
    );
}

function notifyAgentTicketTransfer(db, agentId, ticketRow, fromName, cb) {
    const tid = ticketRow.ticket_id || ticketRow.tracking_id || '';
    const link = notifEngine.publicBaseUrl().replace(/\/$/, '') + '/support';
    pushInbox(
        db,
        {
            userId: agentId,
            type: 'ticket_transfer',
            title: 'Ticket transferred to you: ' + tid,
            body: (fromName ? 'From ' + fromName + '. ' : '') + (ticketRow.subject || ''),
            link,
            refId: tid
        },
        () => cb && cb(null, { queued: true })
    );
}

function notifyAgentTicketDoctorReply(db, agentId, ticketRow, messagePreview, cb) {
    if (!agentId || !ticketRow) return cb && cb(null, { skipped: true });
    const tid = ticketRow.ticket_id || ticketRow.tracking_id || '';
    const link = notifEngine.publicBaseUrl().replace(/\/$/, '') + '/support';
    const preview = String(messagePreview || '').trim().slice(0, 500);
    const title = 'Doctor replied on ticket ' + tid;
    const body = (ticketRow.subject || 'Support ticket') + '\n\n' + preview;
    pushInbox(
        db,
        { userId: agentId, type: 'ticket_doctor_reply', title, body, link, refId: tid },
        () => {
            notifyAgentByEmail(
                db,
                agentId,
                title,
                body + '\n\nOpen support desk: ' + link,
                '<p><strong>' +
                    title +
                    '</strong></p><p>' +
                    String(ticketRow.subject || '').replace(/</g, '&lt;') +
                    '</p><blockquote style="border-left:4px solid #f97316;padding:8px 14px;background:#fff7ed;">' +
                    preview.replace(/</g, '&lt;').replace(/\n/g, '<br>') +
                    '</blockquote><p><a href="' +
                    link +
                    '">Open support desk</a></p>',
                cb
            );
        }
    );
}

module.exports = {
    ensureInboxSchema,
    pushInbox,
    notifyAgentByEmail,
    notifyAgentTicketAssigned,
    notifyAgentTicketDoctorReply,
    notifyAgentLiveChatAssigned,
    notifyAgentsLiveChatWaiting,
    notifyAgentTicketTransfer
};

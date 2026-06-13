/**
 * Live chat sessions + messages (polling-based).
 */
const crypto = require('crypto');
const supportDesk = require('./support-desk');
const { ensureSupportDeskSchema } = require('./support-desk-schema');
const { ensureContactInquiriesSchema } = require('./contact-inquiries-schema');
const { findOrCreateGuestPortalUser } = require('./guest-portal-user');
const contactInquiryNotify = require('./contact-inquiry-notify');
const supportTicketNotify = require('./support-ticket-notify');

const NO_REPLY_ESCALATION_MS = 5 * 60 * 1000;

function newVisitorKey() {
    return 'v_' + crypto.randomBytes(12).toString('hex');
}

function generateLiveChatRef() {
    return String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
}

function refFromRow(row) {
    if (!row) return '';
    const digits = row.chat_ref != null ? String(row.chat_ref).trim() : '';
    if (/^\d{12}$/.test(digits)) return 'LCHAT-' + digits;
    return '';
}

function formatChatRef(sessionRowOrRefDigits) {
    if (sessionRowOrRefDigits && typeof sessionRowOrRefDigits === 'object') {
        return refFromRow(sessionRowOrRefDigits);
    }
    const digits = String(sessionRowOrRefDigits || '').trim();
    if (/^\d{12}$/.test(digits)) return 'LCHAT-' + digits;
    return '';
}

function parseChatRefDigits(ref) {
    const raw = String(ref || '').trim().toUpperCase();
    const prefixed = raw.match(/^LCHAT-(\d{12})$/);
    if (prefixed) return prefixed[1];
    if (/^\d{12}$/.test(raw)) return raw;
    return null;
}

/** @deprecated Use resolveSessionId — kept for legacy LCHAT-{smallId} URLs */
function parseChatRef(ref) {
    const digits = parseChatRefDigits(ref);
    if (digits) return null;
    const raw = String(ref || '').trim().toUpperCase();
    const m = raw.match(/^LCHAT-(\d+)$/);
    if (m) return parseInt(m[1], 10);
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return null;
}

function resolveSessionId(db, ref, cb) {
    const digits = parseChatRefDigits(ref);
    if (digits) {
        return db.get(`SELECT id FROM support_live_sessions WHERE chat_ref = ?`, [digits], (err, row) => {
            if (err) return cb(err);
            cb(null, row ? row.id : null);
        });
    }
    const legacy = parseChatRef(ref);
    if (legacy) return cb(null, legacy);
    cb(null, null);
}

function insertLiveSession(db, fields, cb) {
    const chatRef = generateLiveChatRef();
    const cols = Object.keys(fields);
    const vals = Object.values(fields);
    const allCols = cols.concat(['chat_ref', 'last_message_at']);
    const placeholders = cols.map(() => '?').concat(['?', 'CURRENT_TIMESTAMP']).join(', ');
    db.run(
        `INSERT INTO support_live_sessions (${allCols.join(', ')}) VALUES (${placeholders})`,
        vals.concat([chatRef]),
        function (err) {
            if (err && /unique|duplicate/i.test(String(err.message))) {
                return insertLiveSession(db, fields, cb);
            }
            if (err) return cb(err);
            cb(null, this.lastID, chatRef);
        }
    );
}

function agentDisplayName(row) {
    if (!row) return '';
    if (row.agent_first_name != null || row.agent_last_name != null) {
        return [row.agent_first_name, row.agent_last_name].filter(Boolean).join(' ').trim();
    }
    if (String(row.sender_type || '').toLowerCase() === 'agent') {
        return [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    }
    return '';
}

function parseJsonField(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'object' ? raw : JSON.parse(String(raw));
    } catch (_) {
        return null;
    }
}

function getClientIpFromReq(req) {
    if (!req) return '';
    const xf = req.headers && req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

function lookupIpGeo(ip, cb) {
    const clean = String(ip || '').trim();
    if (!clean || /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(clean)) {
        return cb(null, null);
    }
    const https = require('https');
    const url = 'https://ipapi.co/' + encodeURIComponent(clean) + '/json/';
    const req = https.get(url, { timeout: 4500 }, (res) => {
        let data = '';
        res.on('data', (c) => {
            data += c;
        });
        res.on('end', () => {
            try {
                const j = JSON.parse(data);
                if (!j || j.error) return cb(null, null);
                const parts = [j.city, j.region, j.country_name].filter(Boolean);
                cb(null, {
                    label: parts.join(', ') || null,
                    city: j.city || null,
                    region: j.region || null,
                    country: j.country_name || null,
                    lat: j.latitude != null ? j.latitude : null,
                    lon: j.longitude != null ? j.longitude : null,
                    isp: j.org || null,
                    ip: clean
                });
            } catch (_) {
                cb(null, null);
            }
        });
    });
    req.on('error', () => cb(null, null));
    req.on('timeout', () => {
        req.destroy();
        cb(null, null);
    });
}

function saveSessionClientMeta(db, sessionId, meta, cb) {
    const sid = parseInt(sessionId, 10);
    if (!Number.isInteger(sid)) return cb && cb(new Error('Invalid session'));
    const ip = meta && meta.visitorIp ? String(meta.visitorIp).trim() : null;
    const diagnostics =
        meta && meta.clientDiagnostics
            ? typeof meta.clientDiagnostics === 'string'
                ? meta.clientDiagnostics
                : JSON.stringify(meta.clientDiagnostics)
            : null;
    db.run(
        `UPDATE support_live_sessions SET visitor_ip = COALESCE(?, visitor_ip), client_diagnostics_json = COALESCE(?, client_diagnostics_json) WHERE id = ?`,
        [ip, diagnostics, sid],
        (err) => {
            if (err) return cb && cb(err);
            if (!ip) return cb && cb(null);
            lookupIpGeo(ip, (geoErr, geo) => {
                if (geoErr || !geo) return cb && cb(null);
                db.run(
                    `UPDATE support_live_sessions SET visitor_location = COALESCE(?, visitor_location), visitor_geo_json = COALESCE(?, visitor_geo_json) WHERE id = ?`,
                    [geo.label, JSON.stringify(geo), sid],
                    () => cb && cb(null)
                );
            });
        }
    );
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
                chatRef: refFromRow(row),
                visitorKey: row.visitor_key,
                userId: row.user_id,
                assignedAgentId: row.assigned_agent_id,
                agentName: agentDisplayName(row) || null,
                status: row.status,
                channel: row.channel,
                linkedTicketId: row.linked_ticket_id || null,
                noReplyEscalated: !!row.no_reply_escalated_at,
                needsContactForm:
                    !row.contact_form_submitted_at &&
                    !row.user_id &&
                    !!row.no_reply_escalated_at &&
                    !String(row.linked_ticket_id || '').match(/^(INQ-|TKT_)/i),
                guestChatUrl: publicGuestChatUrl(refFromRow(row), row.visitor_key),
                startedAt: row.started_at,
                endedAt: row.ended_at,
                lastMessageAt: row.last_message_at,
                visitorName: row.first_name ? [row.first_name, row.last_name].filter(Boolean).join(' ') : null,
                visitorEmail: row.email || null,
                visitorPortalId: row.user_id_string || null,
                visitorIp: row.visitor_ip || null,
                visitorLocation: row.visitor_location || null,
                visitorGeo: parseJsonField(row.visitor_geo_json),
                clientDiagnostics: parseJsonField(row.client_diagnostics_json)
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
        const finish = (sessionId, agentId, status, chatRefDigits) => {
            saveSessionClientMeta(
                db,
                sessionId,
                {
                    visitorIp: opts.visitorIp || null,
                    clientDiagnostics: opts.clientDiagnostics || null
                },
                () => {
                    getSession(db, sessionId, (eS, session) => {
                        const base = {
                            sessionId,
                            chatRef: (session && session.chatRef) || formatChatRef(chatRefDigits),
                            visitorKey,
                            agentId,
                            agentName: session && session.agentName,
                            status,
                            canLive,
                            linkedTicketId: session && session.linkedTicketId,
                            startedAt: session && session.startedAt,
                            visitorName: session && session.visitorName
                        };
                        if (!userId && channel === 'web') {
                            base.guestChatUrl = publicGuestChatUrl(base.chatRef, visitorKey);
                        }
                        const done = () => cb(null, base);
                        const afterWelcome = () => {
                            if (!initialMessage) return done();
                            db.run(
                                `INSERT INTO support_live_messages (session_id, sender_type, sender_id, message) VALUES (?, 'visitor', ?, ?)`,
                                [sessionId, userId, initialMessage],
                                () => done()
                            );
                        };
                        addSessionStartMessages(db, sessionId, session, status, afterWelcome);
                    });
                }
            );
        };

        if (!canLive) {
            return insertLiveSession(
                db,
                {
                    visitor_key: visitorKey,
                    user_id: userId,
                    status: 'offline',
                    channel
                },
                (insErr, sessionId, chatRefDigits) => {
                    if (insErr) return cb(insErr);
                    finish(sessionId, null, 'offline', chatRefDigits);
                }
            );
        }

        pickLiveChatAgent(db, (ePick, agentId) => {
            if (ePick) return cb(ePick);
            const status = agentId ? 'active' : 'waiting';
            insertLiveSession(
                db,
                {
                    visitor_key: visitorKey,
                    user_id: userId,
                    assigned_agent_id: agentId,
                    status,
                    channel
                },
                (insErr, sessionId, chatRefDigits) => {
                    if (insErr) return cb(insErr);
                    const supportDeskNotify = require('./support-desk-notify');
                    if (agentId) {
                        supportDeskNotify.notifyAgentLiveChatAssigned(db, agentId, sessionId, initialMessage, () => {});
                    } else {
                        supportDeskNotify.notifyAgentsLiveChatWaiting(db, sessionId, initialMessage, () => {});
                    }
                    finish(sessionId, agentId, status, chatRefDigits);
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

function visitorGreetingName(session) {
    const name = session && session.visitorName ? String(session.visitorName).trim() : '';
    return name || null;
}

function greetingHello(session) {
    const name = visitorGreetingName(session);
    return name ? 'Hello ' + name + ',' : 'Hello,';
}

function sessionStartSystemMessage(session, status) {
    const st = status || (session && session.status) || '';
    const ref = (session && session.chatRef) || '';
    const hello = greetingHello(session);
    if (st === 'offline') {
        return (
            hello +
            ' live chat is currently offline. Please share your details using the form below and we will reach out during our next support window.'
        );
    }
    if (st === 'waiting') {
        return (
            hello +
            ' your live chat has started (reference ' +
            ref +
            '). You are in the queue — an agent will join shortly. If no one joins within 5 minutes, please use the form below and we will reach out to you.'
        );
    }
    if (st === 'active') {
        const agent = session && session.agentName ? session.agentName : 'our support team';
        return hello + ' you are now connected with ' + agent + '. Chat reference: ' + ref + '.';
    }
    return '';
}

function addSessionStartMessages(db, sessionId, session, status, cb) {
    const msg = sessionStartSystemMessage(session, status);
    if (!msg) return cb && cb();
    addSystemMessage(db, sessionId, msg, cb || (() => {}));
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
                    greetingHello(session) +
                        ' you are now connected with ' +
                        (session && session.agentName ? session.agentName : 'a support agent') +
                        '. Chat reference: ' +
                        (session && session.chatRef ? session.chatRef : '') +
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
        const ref = (session && session.chatRef) || '';
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

function publicContactFormUrl(chatRef) {
    const base =
        (process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org').replace(/\/$/, '');
    const ref = encodeURIComponent(chatRef || '');
    const subj = encodeURIComponent('Live chat follow-up ' + (chatRef || ''));
    return base + '/?livechat=' + ref + '&subject=' + subj + '#contact';
}

function publicGuestChatUrl(chatRef, visitorKey) {
    const base =
        (process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org').replace(/\/$/, '');
    const ref = encodeURIComponent(chatRef || '');
    const vk = encodeURIComponent(visitorKey || '');
    return base + '/live-chat?ref=' + ref + '&vk=' + vk;
}

function verifyGuestSession(db, sessionId, visitorKey, cb) {
    const sid = parseInt(sessionId, 10);
    const vk = String(visitorKey || '').trim();
    if (!Number.isInteger(sid) || !vk) return cb(new Error('Invalid session'));
    db.get(`SELECT id, visitor_key, user_id, channel FROM support_live_sessions WHERE id = ?`, [sid], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(new Error('Session not found'));
        if (row.user_id) return cb(new Error('Use the doctor portal for this chat'));
        if (String(row.visitor_key || '') !== vk) return cb(new Error('Invalid chat link'));
        cb(null, row);
    });
}

function resumeGuestSession(db, visitorKey, chatRef, cb) {
    resolveSessionId(db, chatRef, (eR, sid) => {
        if (eR) return cb(eR);
        if (!sid) return cb(new Error('Invalid chat reference'));
        verifyGuestSession(db, sid, visitorKey, (err) => {
            if (err) return cb(err);
            getSession(db, sid, cb);
        });
    });
}

function submitGuestContactForm(db, sessionRef, visitorKey, fields, deps, cb) {
    if (typeof deps === 'function') {
        cb = deps;
        deps = {};
    }
    resolveSessionId(db, sessionRef, (eR, sid) => {
        if (eR) return cb(eR);
        if (!sid) return cb(new Error('Invalid chat reference'));
        verifyGuestSession(db, sid, visitorKey, (err, row) => {
            if (err) return cb(err);
            const name = String((fields && fields.name) || '').trim();
            const email = String((fields && fields.email) || '').trim();
            const phone = String((fields && fields.phone) || '').trim();
            const subject = String((fields && fields.subject) || '').trim();
            const message = String((fields && fields.message) || '').trim();
            if (!name || !email || !phone || !message) {
                return cb(new Error('Name, email, phone, and issue description are required.'));
            }
            getSession(db, sid, (eS, session) => {
                if (eS) return cb(eS);
                const ref = (session && session.chatRef) || '';
                db.all(
                    `SELECT sender_type, message FROM support_live_messages WHERE session_id = ? ORDER BY id ASC`,
                    [sid],
                    (eM, msgs) => {
                        if (eM) return cb(eM);
                        const transcript = buildChatTranscript(msgs);
                        const ticketSubject =
                            subject || 'Live chat follow-up' + (ref ? ' (' + ref + ')' : '');
                        const ticketDescription =
                            message +
                            '\n\n---\nLive chat reference: ' +
                            ref +
                            '\nPhone: ' +
                            phone +
                            '\n\nChat transcript:\n' +
                            (transcript || '(none)');

                        const finishWithInquiry = (guestUserId, ticketRef) => {
                            ensureContactInquiriesSchema(db, () => {}, () => {
                                db.run(
                                    `INSERT INTO contact_inquiries (name, email, phone, subject, message, status, created_at, updated_at)
                                     VALUES (?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                                    [name, email, phone, ticketSubject, ticketDescription],
                                    function (insErr) {
                                        if (insErr) return cb(insErr);
                                        const inqRef = 'INQ-' + this.lastID;
                                        const linkId = ticketRef || inqRef;
                                        const guestUrl = publicGuestChatUrl(ref, row.visitor_key);
                                        const systemMsg = ticketRef
                                            ? 'Thank you. Support ticket ' +
                                              ticketRef +
                                              ' was created. Our team will email you at ' +
                                              email +
                                              '. You can keep chatting here or return anytime: ' +
                                              guestUrl
                                            : 'Thank you. Your message was received as ' +
                                              inqRef +
                                              '. Our team will email you at ' +
                                              email +
                                              '. You can keep chatting here or return anytime: ' +
                                              guestUrl;

                                        db.run(
                                            `UPDATE support_live_sessions
                                             SET linked_ticket_id = ?,
                                                 user_id = COALESCE(user_id, ?),
                                                 contact_form_submitted_at = CURRENT_TIMESTAMP,
                                                 no_reply_escalated_at = COALESCE(no_reply_escalated_at, CURRENT_TIMESTAMP)
                                             WHERE id = ?`,
                                            [linkId, guestUserId || null, sid],
                                            (uErr) => {
                                                if (uErr) return cb(uErr);
                                                const afterNotify = () => {
                                                    addSystemMessage(db, sid, systemMsg, () =>
                                                        cb(null, {
                                                            inquiryRef: inqRef,
                                                            ticketRef: ticketRef || null
                                                        })
                                                    );
                                                };
                                                if (ticketRef) return afterNotify();
                                                contactInquiryNotify.notifyStaffContactInquiry(
                                                    db,
                                                    {
                                                        id: this.lastID,
                                                        name,
                                                        email,
                                                        phone,
                                                        subject: ticketSubject,
                                                        message: ticketDescription
                                                    },
                                                    afterNotify
                                                );
                                            }
                                        );
                                    }
                                );
                            });
                        };

                        findOrCreateGuestPortalUser(db, { name, email, phone }, (uErr, userId) => {
                            if (uErr) return cb(uErr);
                            if (userId && typeof deps.createSupportTicketRecord === 'function') {
                                return deps.createSupportTicketRecord(
                                    {
                                        userId,
                                        category: 'general',
                                        subject: ticketSubject,
                                        description: ticketDescription,
                                        senderType: 'user',
                                        senderId: userId
                                    },
                                    (tErr, out) => {
                                        if (tErr) return finishWithInquiry(userId, null);
                                        const ticketRef = out && out.ticketId;
                                        supportTicketNotify.notifyStaffNewSupportTicket(
                                            db,
                                            ticketRef,
                                            { guestName: name, guestEmail: email, guestPhone: phone },
                                            () => finishWithInquiry(userId, ticketRef)
                                        );
                                    }
                                );
                            }
                            finishWithInquiry(userId, null);
                        });
                    }
                );
            });
        });
    });
}

function buildChatTranscript(rows) {
    return (rows || [])
        .map((m) => {
            const who =
                m.sender_type === 'agent'
                    ? m.sender_name || 'Agent'
                    : m.sender_type === 'visitor'
                      ? 'Visitor'
                      : 'System';
            return who + ': ' + String(m.message || '');
        })
        .join('\n');
}

function hasAgentReplied(db, sessionId, cb) {
    db.get(
        `SELECT COUNT(*) AS c FROM support_live_messages WHERE session_id = ? AND sender_type = 'agent'`,
        [parseInt(sessionId, 10)],
        (err, row) => {
            if (err) return cb(err);
            cb(null, (parseInt(row && row.c, 10) || 0) > 0);
        }
    );
}

function isPgDb() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

/** One escalation per session — must run before creating tickets/inquiries (polls race otherwise). */
function claimNoReplyEscalationSlot(db, sessionId, cb) {
    const sid = parseInt(sessionId, 10);
    if (!Number.isInteger(sid)) return cb(null, false);
    const pg = isPgDb();
    const timeClause = pg
        ? `started_at <= NOW() - INTERVAL '5 minutes'`
        : `started_at <= datetime('now', '-5 minutes')`;
    db.run(
        `UPDATE support_live_sessions
         SET no_reply_escalated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND no_reply_escalated_at IS NULL
           AND (linked_ticket_id IS NULL OR TRIM(COALESCE(linked_ticket_id, '')) = '')
           AND LOWER(TRIM(COALESCE(status, ''))) IN ('waiting', 'active')
           AND ${timeClause}`,
        [sid],
        function (err) {
            if (err) return cb(err);
            cb(null, this.changes > 0);
        }
    );
}

function insertContactInquiryFromLiveChat(db, sessionRow, transcript, cb) {
    const ref = refFromRow(sessionRow);
    const name =
        sessionRow.first_name || sessionRow.last_name
            ? [sessionRow.first_name, sessionRow.last_name].filter(Boolean).join(' ')
            : 'Website live chat visitor';
    const email =
        (sessionRow.email && String(sessionRow.email).trim()) ||
        'livechat+' + String(sessionRow.id) + '@visitor.vaidyagogate.org';
    const phone = sessionRow.phone ? String(sessionRow.phone).trim() : null;
    const subject = 'Live chat – no agent reply (' + ref + ')';
    const message =
        'Auto-created after 5 minutes with no agent reply.\n\nChat reference: ' +
        ref +
        '\n\n' +
        (transcript || '(no messages)') +
        '\n\nVisitor can also use the website contact form: ' +
        publicContactFormUrl(ref);

    ensureContactInquiriesSchema(db, () => {}, () => {
        db.run(
            `INSERT INTO contact_inquiries (name, email, phone, subject, message, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [name, email, phone, subject, message],
            function (err) {
                if (err) return cb(err);
                cb(null, { inquiryId: this.lastID, ref: 'INQ-' + this.lastID });
            }
        );
    });
}

function processNoReplyEscalation(db, sessionId, deps, cb) {
    if (typeof cb !== 'function') cb = () => {};
    const sid = parseInt(sessionId, 10);
    if (!Number.isInteger(sid)) return cb();

    hasAgentReplied(db, sid, (eA, agentReplied) => {
        if (eA) return cb(eA);
        if (agentReplied) return cb();

        claimNoReplyEscalationSlot(db, sid, (eC, claimed) => {
            if (eC) return cb(eC);
            if (!claimed) return cb();

            db.get(
                `SELECT s.*, u.first_name, u.last_name, u.email, u.phone, u.user_id_string
                 FROM support_live_sessions s
                 LEFT JOIN users u ON u.id = s.user_id
                 WHERE s.id = ?`,
                [sid],
                (err, row) => {
                    if (err || !row) return cb(err);

                    db.all(
                        `SELECT sender_type, message, created_at FROM support_live_messages WHERE session_id = ? ORDER BY id ASC`,
                        [sid],
                        (eM, msgs) => {
                            if (eM) return cb(eM);
                            const transcript = buildChatTranscript(msgs);
                            const ref = refFromRow(row);
                            const userId = row.user_id ? parseInt(row.user_id, 10) : null;
                            const finishEscalation = (linkId, systemMsg) => {
                                const notify = () => {
                                    addSystemMessage(db, sid, systemMsg, () =>
                                        cb(null, { escalated: true, linkId: linkId || null })
                                    );
                                };
                                if (linkId) {
                                    db.run(
                                        `UPDATE support_live_sessions SET linked_ticket_id = ? WHERE id = ?`,
                                        [linkId, sid],
                                        () => notify()
                                    );
                                } else {
                                    notify();
                                }
                            };

                            if (!userId) {
                                const guestUrl = publicGuestChatUrl(ref, row.visitor_key);
                                return finishEscalation(
                                    null,
                                    'No agent replied within 5 minutes. Please fill in the contact form below so our team can follow up by email.\n\nYour personal 1-to-1 chat link (bookmark or open on another device):\n' +
                                        guestUrl
                                );
                            }

                            if (userId && typeof deps.createSupportTicketRecord === 'function') {
                                deps.createSupportTicketRecord(
                                    {
                                        userId,
                                        category: 'general',
                                        subject: 'Live chat follow-up – no agent reply (' + ref + ')',
                                        description:
                                            'Visitor waited 5+ minutes in live chat without an agent reply.\n\nChat reference: ' +
                                            ref +
                                            '\n\nConversation:\n' +
                                            transcript,
                                        senderType: 'support',
                                        senderId: null
                                    },
                                    (eT, out) => {
                                        if (eT) {
                                            return insertContactInquiryFromLiveChat(db, row, transcript, (eI, inq) => {
                                                if (eI) return cb(eI);
                                                const formUrl = publicContactFormUrl(ref);
                                                finishEscalation(
                                                    inq.ref,
                                                    'No agent replied within 5 minutes. A support request (' +
                                                        inq.ref +
                                                        ') was logged. You can also send details via our website form: ' +
                                                        formUrl
                                                );
                                            });
                                        }
                                        finishEscalation(
                                            out.ticketId,
                                            'No agent replied within 5 minutes. Support ticket ' +
                                                out.ticketId +
                                                ' was created. Our team will follow up. Chat reference: ' +
                                                ref +
                                                '.'
                                        );
                                    }
                                );
                                return;
                            }

                            insertContactInquiryFromLiveChat(db, row, transcript, (eI, inq) => {
                                if (eI) return cb(eI);
                                const formUrl = publicContactFormUrl(ref);
                                finishEscalation(
                                    inq.ref,
                                    'No agent replied within 5 minutes. Support request ' +
                                        inq.ref +
                                        ' was logged for our team. Please also complete the support form if you can: ' +
                                        formUrl
                                );
                            });
                        }
                    );
                }
            );
        });
    });
}

function processAllNoReplyEscalations(db, deps, cb) {
    db.all(
        `SELECT id, started_at FROM support_live_sessions
         WHERE status IN ('waiting','active')
           AND no_reply_escalated_at IS NULL
           AND (linked_ticket_id IS NULL OR linked_ticket_id = '')`,
        [],
        (err, rows) => {
            if (err) return cb(err);
            const now = Date.now();
            const ids = (rows || [])
                .filter((r) => {
                    const t = new Date(r.started_at).getTime();
                    return !Number.isNaN(t) && now - t >= NO_REPLY_ESCALATION_MS;
                })
                .map((r) => r.id);
            let i = 0;
            let escalated = 0;
            const next = () => {
                if (i >= ids.length) return cb(null, { checked: ids.length, escalated });
                const id = ids[i++];
                processNoReplyEscalation(db, id, deps, (e, out) => {
                    if (!e && out && out.escalated) escalated++;
                    next();
                });
            };
            next();
        }
    );
}

function doctorPortalTicketFormUrl() {
    const base =
        (process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org').replace(/\/$/, '');
    return base + '/doctor';
}

/** Doctor portal live chat only — logged-in doctors already have an account. */
function ticketFormMessage(chatRef) {
    const url = doctorPortalTicketFormUrl();
    return (
        'To continue with a formal support ticket, sign in to the doctor portal and open Support tickets: ' +
        url +
        (chatRef ? ' (mention chat reference ' + chatRef + ' in your ticket).' : '.')
    );
}

function markGuestNeedsContactForm(db, sessionId, cb) {
    const sid = parseInt(sessionId, 10);
    if (!Number.isInteger(sid)) return cb(new Error('Invalid session'));
    db.run(
        `UPDATE support_live_sessions SET no_reply_escalated_at = COALESCE(no_reply_escalated_at, CURRENT_TIMESTAMP)
         WHERE id = ? AND user_id IS NULL`,
        [sid],
        cb
    );
}

/** Main website guest live chat — unique link + inline contact form (name, email, phone, issue). */
function guestContactFormMessage(session) {
    const ref = session && session.chatRef ? session.chatRef : '';
    const url = publicGuestChatUrl(ref, session && session.visitorKey);
    return (
        'Please share your full name, email, phone number, and describe your issue using the contact form on your personal support page:\n\n' +
        url +
        '\n\n(The same form also appears below if you are still in the chat widget.)\n\nChat reference: ' +
        ref +
        '.'
    );
}

module.exports = {
    lookupIpGeo,
    newVisitorKey,
    formatChatRef,
    refFromRow,
    parseChatRef,
    parseChatRefDigits,
    resolveSessionId,
    generateLiveChatRef,
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
    guestContactFormMessage,
    markGuestNeedsContactForm,
    agentDisplayName,
    getClientIpFromReq,
    saveSessionClientMeta,
    parseJsonField,
    NO_REPLY_ESCALATION_MS,
    processNoReplyEscalation,
    processAllNoReplyEscalations,
    sessionStartSystemMessage,
    greetingHello,
    publicContactFormUrl,
    publicGuestChatUrl,
    resumeGuestSession,
    submitGuestContactForm,
    verifyGuestSession
};

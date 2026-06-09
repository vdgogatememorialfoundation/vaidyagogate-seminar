/**
 * Support desk API routes — public chat/track, agent portal.
 */
const bookAuth = require('./book-sales-auth');
const supportDesk = require('./support-desk');
const supportLiveChat = require('./support-live-chat');
const supportDeskNotify = require('./support-desk-notify');
const chatbotKnowledge = require('./chatbot-knowledge');
const { effectiveUserRole } = require('./user-roles');

function readActorId(req) {
    return bookAuth.readActorId(req);
}

function requireSupportAgent(db, handler) {
    return (req, res) => {
        const actorId = readActorId(req);
        if (!actorId) return res.status(401).json({ error: 'Sign in required.' });
        bookAuth.loadStaffActor(db, actorId, (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: 'Invalid account' });
            const ur = effectiveUserRole(user);
            const isAgent =
                ur === 'support_agent' ||
                ur === 'co_admin' ||
                (ur === 'staff_user' && supportDesk.isSupportAgentUser(user));
            const isAdmin = String(user.role || '').toLowerCase() === 'admin' && ur !== 'co_admin';
            if (!isAgent && !isAdmin) {
                return res.status(403).json({ error: 'Support desk access required.' });
            }
            req.supportAgent = user;
            req.supportAgentId = actorId;
            handler(req, res);
        });
    };
}

function trackApplication(db, q, cb) {
    const raw = String(q || '').trim();
    if (!raw) return cb(null, { error: 'Enter an application or ticket number.' });
    const norm = raw.replace(/^sem-/i, '').replace(/^case-/i, '');

    db.get(
        `SELECT r.id, r.application_no, r.status, r.created_at, r.updated_at,
                s.title AS seminar_title, s.event_date,
                u.first_name, u.last_name, u.email, u.phone, u.user_id_string
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE TRIM(r.application_no) = TRIM(?) OR TRIM(r.application_no) = TRIM(?)
         ORDER BY r.id DESC LIMIT 1`,
        [raw, norm],
        (eReg, reg) => {
            if (eReg) return cb(eReg);
            if (reg) {
                return cb(null, {
                    type: 'seminar',
                    applicationNo: reg.application_no,
                    status: reg.status,
                    seminarTitle: reg.seminar_title,
                    eventDate: reg.event_date,
                    createdAt: reg.created_at,
                    updatedAt: reg.updated_at,
                    participant: {
                        name: [reg.first_name, reg.last_name].filter(Boolean).join(' '),
                        email: reg.email,
                        phone: reg.phone,
                        portalId: reg.user_id_string
                    }
                });
            }
            db.get(
                `SELECT cs.id, cs.status, cs.category, cs.created_at, cs.updated_at, cs.application_no,
                        cp.title AS program_title,
                        u.first_name, u.last_name, u.email, u.phone, u.user_id_string
                 FROM case_submissions cs
                 JOIN users u ON u.id = cs.user_id
                 LEFT JOIN case_programs cp ON cp.id = cs.case_program_id
                 WHERE TRIM(COALESCE(cs.application_no,'')) = TRIM(?) OR CAST(cs.id AS TEXT) = TRIM(?)
                 ORDER BY cs.id DESC LIMIT 1`,
                [raw, norm],
                (eCase, cs) => {
                    if (eCase) return cb(eCase);
                    if (cs) {
                        return cb(null, {
                            type: 'case',
                            applicationNo: cs.application_no || 'CASE-' + cs.id,
                            status: cs.status,
                            category: cs.category,
                            programTitle: cs.program_title,
                            createdAt: cs.created_at,
                            updatedAt: cs.updated_at,
                            participant: {
                                name: [cs.first_name, cs.last_name].filter(Boolean).join(' '),
                                email: cs.email,
                                phone: cs.phone,
                                portalId: cs.user_id_string
                            }
                        });
                    }
                    db.get(
                        `SELECT st.id, st.status, st.category, st.subject, st.priority, st.expected_response_at, st.created_at,
                                COALESCE(NULLIF(TRIM(st.ticket_id), ''), NULLIF(TRIM(st.tracking_id), '')) AS ticket_ref
                         FROM support_tickets st
                         WHERE TRIM(COALESCE(st.ticket_id,'')) = TRIM(?)
                            OR TRIM(COALESCE(st.tracking_id,'')) = TRIM(?)
                         LIMIT 1`,
                        [raw, raw],
                        (eT, ticket) => {
                            if (eT) return cb(eT);
                            if (ticket) {
                                return cb(null, {
                                    type: 'support_ticket',
                                    ticketRef: ticket.ticket_ref,
                                    status: ticket.status,
                                    category: ticket.category,
                                    subject: ticket.subject,
                                    priority: ticket.priority,
                                    expectedResponseAt: ticket.expected_response_at,
                                    createdAt: ticket.created_at
                                });
                            }
                            cb(null, { error: 'No matching application or ticket found. Check the number and try again.' });
                        }
                    );
                }
            );
        }
    );
}

function registerSupportDeskRoutes(app, deps) {
    const {
        db,
        loadPublicSiteCms,
        getSupportTicketPayload,
        resolveSupportTicketByRef,
        canonicalTicketMessageId,
        createSupportTicketRecord
    } = deps;

    app.get('/api/public/support/track', (req, res) => {
        trackApplication(db, req.query.q || req.query.ref, (err, data) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(data);
        });
    });

    app.post('/api/public/support/chat', async (req, res) => {
        try {
            const body = req.body || {};
            const message = String(body.message || '').trim();
            if (!message) return res.status(400).json({ error: 'Message required' });
            let knowledge = '';
            try {
                knowledge = await chatbotKnowledge.buildChatbotKnowledge(db, loadPublicSiteCms);
            } catch (kErr) {
                console.warn('[support-chat] knowledge', kErr.message);
            }
            let userContext = null;
            const trackRef = body.applicationNo || body.ticketRef;
            if (trackRef) {
                trackApplication(db, trackRef, (_e, tr) => {
                    if (tr && !tr.error) userContext = { track: tr };
                });
            }
            let reply = chatbotKnowledge.answerFromKnowledge(message, knowledge, userContext);
            const cfg = supportDesk.getConfig();
            const liveOpen = cfg.liveChatEnabled && supportDesk.isWithinBusinessHours(cfg);
            if (/track|status|application|where is my/i.test(message) && body.applicationNo) {
                trackApplication(db, body.applicationNo, (eTr, tr) => {
                    if (!eTr && tr && !tr.error) {
                        if (tr.type === 'seminar') {
                            reply =
                                `Seminar application ${tr.applicationNo}: ${tr.status}` +
                                (tr.seminarTitle ? ` (${tr.seminarTitle})` : '') +
                                '. Sign in to the doctor portal for full details.';
                        } else if (tr.type === 'case') {
                            reply = `Case submission ${tr.applicationNo}: ${tr.status}. Check the Case presentation tab in the doctor portal.`;
                        } else if (tr.type === 'support_ticket') {
                            reply = `Support ticket ${tr.ticketRef}: ${tr.status}. Replies appear in the doctor portal under Support tickets.`;
                        }
                    }
                    res.json({ reply, liveChatAvailable: liveOpen, businessHoursOpen: liveOpen });
                });
                return;
            }
            res.json({ reply, liveChatAvailable: liveOpen, businessHoursOpen: liveOpen });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Chat failed' });
        }
    });

    app.get('/api/public/support/faqs', (req, res) => {
        loadPublicSiteCms((e, cms) => {
            const faqs = (cms && Array.isArray(cms.faq) ? cms.faq : []).slice(0, 30);
            res.json({ faqs, liveChatAvailable: supportDesk.isWithinBusinessHours() });
        });
    });

    app.get('/api/public/support/hours', (_req, res) => {
        const cfg = supportDesk.getConfig();
        res.json({
            timezone: cfg.timezone,
            businessHours: cfg.businessHours,
            openNow: supportDesk.isWithinBusinessHours(cfg),
            liveChatEnabled: cfg.liveChatEnabled
        });
    });

    app.get('/api/support-desk/session', requireSupportAgent(db, (req, res) => {
        const u = req.supportAgent;
        db.get(`SELECT * FROM support_agent_profiles WHERE user_id = ?`, [u.id], (e, profile) => {
            supportDesk.isAgentWithinHours(db, u.id, new Date(), (eH, onDuty) => {
                res.json({
                    user: {
                        id: u.id,
                        name: [u.first_name, u.last_name].filter(Boolean).join(' '),
                        email: u.email,
                        role: effectiveUserRole(u)
                    },
                    profile: profile || { is_available: 1, live_chat_enabled: 1 },
                    onDuty: !!onDuty,
                    config: supportDesk.getConfig()
                });
            });
        });
    }));

    app.put('/api/support-desk/availability', requireSupportAgent(db, (req, res) => {
        const body = req.body || {};
        const isAvailable = body.isAvailable !== false ? 1 : 0;
        const liveChat = body.liveChatEnabled !== false ? 1 : 0;
        const uid = req.supportAgentId;
        db.get(`SELECT user_id FROM support_agent_profiles WHERE user_id = ?`, [uid], (e, row) => {
            if (e) return res.status(500).json({ error: e.message });
            const sql = row
                ? `UPDATE support_agent_profiles SET is_available = ?, live_chat_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
                : `INSERT INTO support_agent_profiles (user_id, is_available, live_chat_enabled, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`;
            const params = row ? [isAvailable, liveChat, uid] : [uid, isAvailable, liveChat];
            db.run(sql, params, (uErr) => {
                if (uErr) return res.status(500).json({ error: uErr.message });
                res.json({ success: true });
            });
        });
    }));

    app.get('/api/support-desk/tickets', requireSupportAgent(db, (req, res) => {
        const mine = req.query.mine === '1';
        const status = String(req.query.status || '').trim();
        let sql = `SELECT st.id, st.user_id, st.category, st.subject, st.priority, st.status, st.created_at,
                          st.expected_response_at, st.assigned_to_staff, st.department_id, st.assignment_mode,
                          COALESCE(NULLIF(TRIM(st.ticket_id), ''), NULLIF(TRIM(st.tracking_id), '')) AS ticket_id,
                          u.first_name, u.last_name, u.email, u.user_id_string,
                          sa.first_name AS agent_first_name, sa.last_name AS agent_last_name,
                          sd.name AS department_name
                   FROM support_tickets st
                   LEFT JOIN users u ON st.user_id = u.id
                   LEFT JOIN users sa ON sa.id = st.assigned_to_staff
                   LEFT JOIN support_departments sd ON sd.id = st.department_id
                   WHERE 1=1`;
        const params = [];
        if (mine) {
            sql += ` AND st.assigned_to_staff = ?`;
            params.push(req.supportAgentId);
        }
        if (status) {
            sql += ` AND LOWER(TRIM(st.status)) = ?`;
            params.push(status.toLowerCase());
        }
        sql += ` ORDER BY st.created_at DESC LIMIT 400`;
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    }));

    app.get('/api/support-desk/tickets/:ticketRef', requireSupportAgent(db, (req, res) => {
        getSupportTicketPayload(req.params.ticketRef, { includeHiddenMessages: true }, (err, payload) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!payload) return res.status(404).json({ error: 'Ticket not found' });
            res.json(payload);
        });
    }));

    app.post('/api/support-desk/tickets/:ticketRef/reply', requireSupportAgent(db, (req, res) => {
        const msg = String((req.body && req.body.message) || '').trim();
        if (!msg) return res.status(400).json({ error: 'Message required' });
        resolveSupportTicketByRef(req.params.ticketRef, (err, ticket) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
            const canonical = canonicalTicketMessageId(ticket);
            const visibleAt = supportDesk.computeVisibleAtForStaffReply(ticket, null, req.supportAgent);
            db.run(
                `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, visible_at, source)
                 VALUES (?, ?, 'support', ?, ?, 'support-desk')`,
                [canonical, req.supportAgentId, msg, visibleAt],
                function (insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    db.run(
                        `UPDATE support_tickets SET assigned_to_staff = COALESCE(assigned_to_staff, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [req.supportAgentId, ticket.id],
                        () => {
                            const supportTicketNotify = require('./support-ticket-notify');
                            if (!visibleAt) {
                                supportTicketNotify.notifySupportTicketReply(
                                    db,
                                    canonical,
                                    'admin',
                                    msg,
                                    req.supportAgentId,
                                    () => res.json({ success: true, messageId: this.lastID, heldUntil: null })
                                );
                            } else {
                                res.json({
                                    success: true,
                                    messageId: this.lastID,
                                    heldUntil: visibleAt,
                                    note: 'Reply saved but hidden from participant until expected response time.'
                                });
                            }
                        }
                    );
                }
            );
        });
    }));

    app.put('/api/support-desk/tickets/:ticketRef/assign', requireSupportAgent(db, (req, res) => {
        const agentId = parseInt(req.body && req.body.agentId, 10);
        const deptId = parseInt(req.body && req.body.departmentId, 10);
        resolveSupportTicketByRef(req.params.ticketRef, (err, ticket) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
            db.run(
                `UPDATE support_tickets SET assigned_to_staff = ?, department_id = COALESCE(?, department_id),
                 assignment_mode = 'manual', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [Number.isInteger(agentId) ? agentId : req.supportAgentId, Number.isInteger(deptId) ? deptId : null, ticket.id],
                (uErr) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    const targetAgent = Number.isInteger(agentId) ? agentId : req.supportAgentId;
                    db.get(
                        `SELECT first_name, last_name FROM users WHERE id = ?`,
                        [req.supportAgentId],
                        (eFrom, fromU) => {
                            const fromName = fromU
                                ? [fromU.first_name, fromU.last_name].filter(Boolean).join(' ')
                                : '';
                            supportDeskNotify.notifyAgentTicketTransfer(db, targetAgent, ticket, fromName, () => {});
                            res.json({ success: true });
                        }
                    );
                }
            );
        });
    }));

    app.get('/api/support-desk/agents', requireSupportAgent(db, (_req, res) => {
        db.all(
            `SELECT u.id, u.first_name, u.last_name, u.email, p.is_available, p.department_id, sd.name AS department_name
             FROM users u
             LEFT JOIN support_agent_profiles p ON p.user_id = u.id
             LEFT JOIN support_departments sd ON sd.id = p.department_id
             WHERE IFNULL(u.is_disabled,0) = 0
               AND LOWER(TRIM(COALESCE(u.user_role,''))) IN ('support_agent','staff_user','co_admin')
             ORDER BY u.first_name, u.last_name`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : rows || [])
        );
    }));

    app.get('/api/support-desk/departments', requireSupportAgent(db, (_req, res) => {
        db.all(
            `SELECT id, slug, name, portal, sort_order FROM support_departments WHERE IFNULL(is_active,1)=1 ORDER BY sort_order, name`,
            [],
            (err, rows) => res.json(err ? { error: err.message } : rows || [])
        );
    }));

    app.get('/api/support-desk/lookup', requireSupportAgent(db, (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'Search query required' });
        trackApplication(db, q, (err, track) => {
            if (err) return res.status(500).json({ error: err.message });
            const like = '%' + q.replace(/%/g, '') + '%';
            db.all(
                `SELECT u.id, u.user_id_string, u.first_name, u.last_name, u.email, u.phone, u.user_role,
                        (SELECT COUNT(*) FROM registrations r WHERE r.user_id = u.id) AS registration_count,
                        (SELECT COUNT(*) FROM support_tickets st WHERE st.user_id = u.id AND LOWER(TRIM(st.status)) NOT IN ('resolved','closed')) AS open_tickets
                 FROM users u
                 WHERE u.user_id_string LIKE ? OR LOWER(u.email) LIKE LOWER(?) OR u.phone LIKE ?
                 ORDER BY u.id DESC LIMIT 20`,
                [like, like, like],
                (e2, users) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ track: track && !track.error ? track : null, users: users || [] });
                }
            );
        });
    }));

    app.get('/api/support-desk/user/:userId/summary', requireSupportAgent(db, (req, res) => {
        const uid = parseInt(req.params.userId, 10);
        if (!Number.isInteger(uid)) return res.status(400).json({ error: 'Invalid user id' });
        db.get(`SELECT id, user_id_string, first_name, last_name, email, phone, user_role, created_at FROM users WHERE id = ?`, [uid], (e, user) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!user) return res.status(404).json({ error: 'User not found' });
            db.all(`SELECT id, application_no, status, created_at FROM registrations WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [uid], (eR, regs) => {
                db.all(
                    `SELECT id, status, category, subject, created_at,
                            COALESCE(NULLIF(TRIM(ticket_id), ''), NULLIF(TRIM(tracking_id), '')) AS ticket_id
                     FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
                    [uid],
                    (eT, tickets) => {
                        db.all(
                            `SELECT o.order_id_string, o.amount, o.status, o.payment_date, r.application_no
                             FROM orders o JOIN registrations r ON r.id = o.registration_id
                             WHERE r.user_id = ? ORDER BY o.id DESC LIMIT 20`,
                            [uid],
                            (eO, orders) => {
                                res.json({
                                    user,
                                    registrations: regs || [],
                                    tickets: tickets || [],
                                    orders: orders || []
                                });
                            }
                        );
                    }
                );
            });
        });
    }));

    app.get('/api/support-desk/inbox', requireSupportAgent(db, (req, res) => {
        const unread = req.query.unread === '1';
        let sql = `SELECT id, type, title, body, link, ref_id, read_at, created_at FROM support_desk_inbox WHERE user_id = ?`;
        if (unread) sql += ` AND read_at IS NULL`;
        sql += ` ORDER BY id DESC LIMIT 100`;
        supportDeskNotify.ensureInboxSchema(db, () => {
            db.all(sql, [req.supportAgentId], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            });
        });
    }));

    app.put('/api/support-desk/inbox/:id/read', requireSupportAgent(db, (req, res) => {
        db.run(
            `UPDATE support_desk_inbox SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
            [parseInt(req.params.id, 10), req.supportAgentId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, updated: this.changes });
            }
        );
    }));

    app.put('/api/support-desk/inbox/read-all', requireSupportAgent(db, (req, res) => {
        db.run(
            `UPDATE support_desk_inbox SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL`,
            [req.supportAgentId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, updated: this.changes });
            }
        );
    }));

    app.post('/api/public/support/live/start', (req, res) => {
        const body = req.body || {};
        supportLiveChat.createSession(
            db,
            {
                visitorKey: body.visitorKey,
                userId: body.userId,
                channel: body.channel || 'web',
                initialMessage: body.message
            },
            (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(out);
            }
        );
    });

    app.get('/api/public/support/live/:sessionId', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.getSession(db, sid, (err, session) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json(session);
        });
    });

    app.get('/api/public/support/live/:sessionId/messages', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.listMessages(db, sid, req.query.since, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/public/support/live/:sessionId/message', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        const msg = String((req.body && req.body.message) || '').trim();
        const userId = req.body && req.body.userId ? parseInt(req.body.userId, 10) : null;
        supportLiveChat.addMessage(db, sid, 'visitor', userId, msg, (err, out) => {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ success: true, id: out.id });
        });
    });

    app.post('/api/support-ticket/live/start', (req, res) => {
        const body = req.body || {};
        const userId = parseInt(body.userId, 10);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ error: 'userId required' });
        }
        supportLiveChat.createSession(
            db,
            {
                visitorKey: body.visitorKey || 'doc_' + userId,
                userId,
                channel: 'doctor_portal',
                initialMessage: body.message || 'Hello, I need help from the doctor portal.'
            },
            (err, out) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(out);
            }
        );
    });

    app.get('/api/support-ticket/live/:sessionId', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.getSession(db, sid, (err, session) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json(session);
        });
    });

    app.get('/api/support-ticket/live/:sessionId/messages', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.listMessages(db, sid, req.query.since, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/support-ticket/live/:sessionId/message', (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        const userId = parseInt((req.body && req.body.userId) || '', 10);
        const msg = String((req.body && req.body.message) || '').trim();
        if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required' });
        supportLiveChat.getSession(db, sid, (eS, session) => {
            if (eS) return res.status(500).json({ error: eS.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.status === 'closed') return res.status(400).json({ error: 'This chat has ended.' });
            if (session.userId && session.userId !== userId) {
                return res.status(403).json({ error: 'Not your chat session.' });
            }
            supportLiveChat.addMessage(db, sid, 'visitor', userId, msg, (err, out) => {
                if (err) return res.status(400).json({ error: err.message });
                res.json({ success: true, id: out.id });
            });
        });
    });

    app.get('/api/support-desk/live/sessions', requireSupportAgent(db, (req, res) => {
        const status = String(req.query.status || 'waiting,active').split(',');
        const ph = status.map(() => '?').join(',');
        db.all(
            `SELECT s.id, s.visitor_key, s.user_id, s.assigned_agent_id, s.status, s.channel, s.started_at, s.last_message_at,
                    s.linked_ticket_id,
                    u.first_name, u.last_name, u.email, u.user_id_string,
                    a.first_name AS agent_first_name, a.last_name AS agent_last_name
             FROM support_live_sessions s
             LEFT JOIN users u ON u.id = s.user_id
             LEFT JOIN users a ON a.id = s.assigned_agent_id
             WHERE s.status IN (${ph})
             ORDER BY s.last_message_at DESC LIMIT 50`,
            status,
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(
                    (rows || []).map((r) => ({
                        ...r,
                        chatRef: supportLiveChat.formatChatRef(r.id),
                        agentName: supportLiveChat.agentDisplayName(r) || null
                    }))
                );
            }
        );
    }));

    app.get('/api/support-desk/live/:sessionId', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.getSession(db, sid, (err, session) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json(session);
        });
    }));

    app.post('/api/support-desk/live/:sessionId/claim', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.claimSession(db, sid, req.supportAgentId, (err, out) => {
            if (err) return res.status(400).json({ error: err.message });
            res.json(out);
        });
    }));

    app.post('/api/support-desk/live/:sessionId/message', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        const msg = String((req.body && req.body.message) || '').trim();
        supportLiveChat.addMessage(db, sid, 'agent', req.supportAgentId, msg, (err, out) => {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ success: true, id: out.id });
        });
    }));

    app.get('/api/support-desk/live/:sessionId/messages', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.listMessages(db, sid, req.query.since, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    }));

    app.post('/api/support-desk/live/:sessionId/send-ticket-form', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        supportLiveChat.getSession(db, sid, (eS, session) => {
            if (eS) return res.status(500).json({ error: eS.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const msg = supportLiveChat.ticketFormMessage(session.chatRef);
            supportLiveChat.addMessage(db, sid, 'agent', req.supportAgentId, msg, (err) => {
                if (err) return res.status(400).json({ error: err.message });
                res.json({ success: true, message: msg });
            });
        });
    }));

    app.post('/api/support-desk/live/:sessionId/create-ticket', requireSupportAgent(db, (req, res) => {
        if (typeof createSupportTicketRecord !== 'function') {
            return res.status(501).json({ error: 'Ticket creation not configured' });
        }
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        const body = req.body || {};
        const subject = String(body.subject || '').trim();
        const description = String(body.description || body.message || '').trim();
        const category = String(body.category || 'general').trim() || 'general';
        if (!subject) return res.status(400).json({ error: 'Subject is required' });
        if (!description) return res.status(400).json({ error: 'Description is required' });

        supportLiveChat.getSession(db, sid, (eS, session) => {
            if (eS) return res.status(500).json({ error: eS.message });
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const targetUserId = parseInt(body.userId, 10) || session.userId;
            if (!Number.isInteger(targetUserId) || targetUserId < 1) {
                return res.status(400).json({
                    error: 'This visitor has no doctor account linked. Send the support ticket form link instead.'
                });
            }
            const fullDescription =
                description + (session.chatRef ? '\n\nLive chat reference: ' + session.chatRef : '');
            createSupportTicketRecord(
                {
                    userId: targetUserId,
                    category,
                    subject,
                    description: fullDescription,
                    senderType: 'support',
                    senderId: req.supportAgentId
                },
                (err, out) => {
                    if (err) return res.status(500).json({ error: err.message });
                    supportLiveChat.linkTicket(db, sid, out.ticketId, () => {
                        const note =
                            'Support ticket ' +
                            out.ticketId +
                            ' created for follow-up. Chat reference: ' +
                            session.chatRef +
                            '.';
                        supportLiveChat.addMessage(db, sid, 'agent', req.supportAgentId, note, () => {
                            res.json({
                                success: true,
                                ticketId: out.ticketId,
                                chatRef: session.chatRef,
                                expectedResponseDisplay: out.expectedResponseDisplay
                            });
                        });
                    });
                }
            );
        });
    }));

    app.post('/api/support-desk/live/:sessionId/close', requireSupportAgent(db, (req, res) => {
        const sid = supportLiveChat.parseChatRef(req.params.sessionId) || parseInt(req.params.sessionId, 10);
        const body = req.body || {};
        supportLiveChat.closeSession(
            db,
            sid,
            {
                closingMessage: body.closingMessage,
                ticketId: body.ticketId
            },
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, chatRef: supportLiveChat.formatChatRef(sid) });
            }
        );
    }));
}

module.exports = { registerSupportDeskRoutes, trackApplication, requireSupportAgent };

/**
 * Admin ↔ participant email threads (portal inbox + inbound email replies).
 */
const messageReplyAddress = require('./message-reply-address');
const adminComposeMail = require('./admin-compose-mail');
const threadReplyNotify = require('./thread-reply-notify');
const notifEngine = require('./notification-engine');

const BULK_CAP = adminComposeMail.BULK_CAP;

function dedupeRecipients(list) {
    const seen = new Set();
    const out = [];
    for (const r of list || []) {
        const em = normalizeEmail(r.email);
        if (!em || seen.has(em)) continue;
        seen.add(em);
        out.push({ email: em, name: r.name || '' });
    }
    return out;
}

const THREADS = 'admin_mail_threads';
const MSGS = 'admin_mail_thread_messages';

function ensureSchema(db, cb) {
    db.run(
        `CREATE TABLE IF NOT EXISTS ${THREADS} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            participant_email TEXT NOT NULL,
            participant_user_id INTEGER,
            participant_name TEXT,
            created_by INTEGER,
            seminar_id INTEGER,
            status TEXT DEFAULT 'open',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        [],
        (e1) => {
            if (e1 && !/already exists/i.test(String(e1.message))) return cb && cb(e1);
            db.run(
                `CREATE TABLE IF NOT EXISTS ${MSGS} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id INTEGER NOT NULL,
                    direction TEXT NOT NULL,
                    author_user_id INTEGER,
                    body TEXT NOT NULL,
                    source TEXT DEFAULT 'portal',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )`,
                [],
                (e2) => {
                    if (e2 && !/already exists/i.test(String(e2.message))) return cb && cb(e2);
                    db.run(
                        `CREATE INDEX IF NOT EXISTS idx_admin_mail_threads_email ON ${THREADS}(participant_email)`,
                        [],
                        () => {
                            db.run(
                                `CREATE INDEX IF NOT EXISTS idx_admin_mail_threads_updated ON ${THREADS}(updated_at)`,
                                [],
                                () => cb && cb(null)
                            );
                        }
                    );
                }
            );
        }
    );
}

function normalizeEmail(s) {
    return String(s || '')
        .trim()
        .toLowerCase();
}

function wrapOutboundBody(body, name, refToken) {
    const footer = messageReplyAddress.replyFooterNote(null, refToken);
    const text = String(body || '').trim() + footer;
    const html =
        adminComposeMail.wrapHtmlBody(body, name) +
        '<p style="margin-top:20px;font-size:0.82rem;color:#64748b;">Reply to this email to continue the conversation.' +
        (refToken ? ' Keep reference <strong>' + refToken + '</strong> in your reply.' : '') +
        '</p>';
    return { text, html };
}

function createThread(db, row, cb) {
    const email = normalizeEmail(row.participant_email);
    if (!email) return cb(new Error('Participant email required'));
    const subject = String(row.subject || '').trim();
    if (!subject) return cb(new Error('Subject required'));
    db.run(
        `INSERT INTO ${THREADS} (subject, participant_email, participant_user_id, participant_name, created_by, seminar_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [
            subject,
            email,
            row.participant_user_id || null,
            row.participant_name || null,
            row.created_by || null,
            row.seminar_id || null
        ],
        function (err) {
            if (err) return cb(err);
            cb(null, { id: this.lastID, subject, participant_email: email });
        }
    );
}

function addMessage(db, row, cb) {
    const tid = parseInt(row.thread_id, 10);
    if (!Number.isInteger(tid) || tid < 1) return cb(new Error('Invalid thread id'));
    const body = String(row.body || '').trim();
    if (!body) return cb(new Error('Message body required'));
    const direction = row.direction === 'participant' ? 'participant' : 'admin';
    db.run(
        `INSERT INTO ${MSGS} (thread_id, direction, author_user_id, body, source)
         VALUES (?, ?, ?, ?, ?)`,
        [tid, direction, row.author_user_id || null, body, row.source || 'portal'],
        function (err) {
            if (err) return cb(err);
            db.run(
                `UPDATE ${THREADS} SET updated_at = CURRENT_TIMESTAMP, status = 'open' WHERE id = ?`,
                [tid],
                () => cb(null, { id: this.lastID, thread_id: tid })
            );
        }
    );
}

function listThreads(db, opts, cb) {
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 50));
    const q = String(opts.q || '').trim();
    let sql = `SELECT t.*,
        (SELECT COUNT(*) FROM ${MSGS} m WHERE m.thread_id = t.id) AS message_count,
        (SELECT m.body FROM ${MSGS} m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_preview,
        (SELECT m.created_at FROM ${MSGS} m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at
        FROM ${THREADS} t`;
    const params = [];
    if (q) {
        sql += ` WHERE lower(t.participant_email) LIKE ? OR lower(t.participant_name) LIKE ? OR lower(t.subject) LIKE ? OR CAST(t.id AS TEXT) = ?`;
        const like = '%' + q.toLowerCase() + '%';
        params.push(like, like, like, q);
    }
    sql += ` ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
    params.push(limit);
    db.all(sql, params, cb);
}

function getThread(db, threadId, cb) {
    const tid = parseInt(threadId, 10);
    if (!Number.isInteger(tid) || tid < 1) return cb(new Error('Invalid thread id'));
    db.get(`SELECT * FROM ${THREADS} WHERE id = ?`, [tid], (e, thread) => {
        if (e) return cb(e);
        if (!thread) return cb(new Error('Thread not found'));
        db.all(
            `SELECT id, thread_id, direction, author_user_id, body, source, created_at
             FROM ${MSGS} WHERE thread_id = ? ORDER BY id ASC`,
            [tid],
            (eM, messages) => {
                if (eM) return cb(eM);
                cb(null, { thread, messages: messages || [] });
            }
        );
    });
}

function lookupUserIdByEmail(db, email, cb) {
    const em = normalizeEmail(email);
    if (!em) return cb(null, null);
    db.get(
        `SELECT id, first_name, last_name FROM users WHERE lower(trim(email)) = ? AND IFNULL(is_disabled,0) = 0 LIMIT 1`,
        [em],
        (e, row) => cb(e, row || null)
    );
}

function queueThreadEmail(db, { threadId, to, name, subject, text, html, replyTo, fromDisplay }, cb) {
    notifEngine.enqueueDirectMessage(
        db,
        {
            channel: 'email',
            destination: to,
            subject,
            html,
            text,
            event_key: 'ADMIN_MAIL_THREAD',
            replyTo: replyTo || undefined,
            fromDisplay: fromDisplay || undefined,
            immediate: false
        },
        cb
    );
}

function sendOutbound(db, opts, cb) {
    const email = normalizeEmail(opts.to);
    const subject = String(opts.subject || '').trim();
    const body = String(opts.body || '').trim();
    if (!email || !subject || !body) return cb(new Error('To, subject, and message are required'));

    lookupUserIdByEmail(db, email, (eU, userRow) => {
        if (eU) return cb(eU);
        const participantName =
            opts.name ||
            (userRow ? [userRow.first_name, userRow.last_name].filter(Boolean).join(' ').trim() : '');

        createThread(
            db,
            {
                subject,
                participant_email: email,
                participant_user_id: userRow ? userRow.id : opts.userId || null,
                participant_name: participantName,
                created_by: opts.createdBy || null,
                seminar_id: opts.seminarId || null
            },
            (eT, thread) => {
                if (eT) return cb(eT);
                addMessage(
                    db,
                    {
                        thread_id: thread.id,
                        direction: 'admin',
                        author_user_id: opts.createdBy || null,
                        body,
                        source: 'portal'
                    },
                    (eM) => {
                        if (eM) return cb(eM);
                        const refToken = messageReplyAddress.adminRefToken(thread.id);
                        const subjWithRef =
                            subject.indexOf(refToken) >= 0 ? subject : subject + ' [' + refToken + ']';
                        const replyTo = messageReplyAddress.buildAdminThreadReplyAddress(thread.id);
                        const wrapped = wrapOutboundBody(body, participantName, refToken);
                        queueThreadEmail(
                            db,
                            {
                                threadId: thread.id,
                                to: email,
                                name: participantName,
                                subject: subjWithRef,
                                text: wrapped.text,
                                html: wrapped.html,
                                replyTo,
                                fromDisplay: opts.fromDisplay
                            },
                            (eQ) => {
                                if (eQ) return cb(eQ);
                                cb(null, {
                                    ok: true,
                                    threadId: thread.id,
                                    refToken,
                                    queued: true
                                });
                            }
                        );
                    }
                );
            }
        );
    });
}

function sendThreadReply(db, opts, cb) {
    const tid = parseInt(opts.threadId, 10);
    const body = String(opts.body || '').trim();
    if (!Number.isInteger(tid) || tid < 1) return cb(new Error('Invalid thread id'));
    if (!body) return cb(new Error('Message body required'));

    getThread(db, tid, (e, data) => {
        if (e) return cb(e);
        const thread = data.thread;
        addMessage(
            db,
            {
                thread_id: tid,
                direction: 'admin',
                author_user_id: opts.authorUserId || null,
                body,
                source: 'portal'
            },
            (eM) => {
                if (eM) return cb(eM);
                const refToken = messageReplyAddress.adminRefToken(tid);
                const subj = `Re: ${thread.subject} [${refToken}]`;
                const replyTo = messageReplyAddress.buildAdminThreadReplyAddress(tid);
                const wrapped = wrapOutboundBody(body, thread.participant_name, refToken);
                queueThreadEmail(
                    db,
                    {
                        threadId: tid,
                        to: thread.participant_email,
                        name: thread.participant_name,
                        subject: subj,
                        text: wrapped.text,
                        html: wrapped.html,
                        replyTo,
                        fromDisplay: opts.fromDisplay
                    },
                    (eQ) => {
                        if (eQ) return cb(eQ);
                        if (thread.participant_user_id) {
                            threadReplyNotify.notifyUserResponse(
                                db,
                                {
                                    userId: thread.participant_user_id,
                                    threadLabel: thread.subject,
                                    messagePreview: body,
                                    portalPath: 'doctor_support'
                                },
                                () => {}
                            );
                        }
                        cb(null, { ok: true, threadId: tid, queued: true });
                    }
                );
            }
        );
    });
}

function ingestParticipantReply(db, threadId, senderEmail, message, cb) {
    const tid = parseInt(threadId, 10);
    const body = String(message || '').trim();
    if (!Number.isInteger(tid) || tid < 1) return cb(new Error('Invalid thread id'));
    if (!body) return cb(new Error('Empty message'));

    db.get(`SELECT * FROM ${THREADS} WHERE id = ?`, [tid], (e, thread) => {
        if (e) return cb(e);
        if (!thread) return cb(new Error('Admin mail thread not found'));
        const expected = normalizeEmail(thread.participant_email);
        const sender = normalizeEmail(senderEmail);
        if (expected && sender && expected !== sender) {
            return cb(
                new Error(
                    'Sender email does not match this thread. Expected ' + expected + ', got ' + (sender || '(empty)')
                )
            );
        }
        lookupUserIdByEmail(db, sender, (eU, userRow) => {
            if (eU) return cb(eU);
            const uid = thread.participant_user_id || (userRow && userRow.id) || null;
            if (userRow && !thread.participant_user_id) {
                db.run(`UPDATE ${THREADS} SET participant_user_id = ? WHERE id = ?`, [userRow.id, tid], () => {});
            }
            addMessage(
                db,
                {
                    thread_id: tid,
                    direction: 'participant',
                    author_user_id: uid,
                    body,
                    source: 'email'
                },
                (eM, msg) => {
                    if (eM) return cb(eM);
                    threadReplyNotify.notifyStaffInbox(
                        db,
                        {
                            threadLabel: thread.subject + ' — ' + (thread.participant_name || thread.participant_email),
                            messagePreview: body,
                            dashboardUrl: threadReplyNotify.dashboardUrl('admin_mail_threads'),
                            intro: 'A participant replied by email.'
                        },
                        () => cb(null, { type: 'admin', threadId: tid, messageId: msg.id, via: 'email' })
                    );
                }
            );
        });
    });
}

function inboundStatus() {
    const secret = String(process.env.INBOUND_MAIL_WEBHOOK_SECRET || '').trim();
    const parser = messageReplyAddress.parserInboxAddress();
    const domain = messageReplyAddress.replyDomain();
    return {
        configured: !!(secret && (parser || domain)),
        webhookPath: '/api/webhooks/mailparser',
        parserInbox: parser || null,
        replyDomain: domain,
        needsSecret: !secret,
        needsParserInbox: !parser,
        hint: !secret
            ? 'Set INBOUND_MAIL_WEBHOOK_SECRET on Render.'
            : !parser
              ? 'Set MAILPARSER_INBOUND_EMAIL to your Mailparser.io inbox address (free tier available).'
              : 'Inbound email ready — replies route via Mailparser to website contact, support tickets, admin threads, and case judge messages when they include the [VGMF-…] reference.'
    };
}

function sendBulkWithThreads(db, { recipients, subject, body, fromDisplay, createdBy, seminarId }, cb) {
    const capped = dedupeRecipients(recipients).slice(0, BULK_CAP);
    if (!capped.length) return cb(null, { threads: 0, failed: 0, total: 0 });
    let threads = 0;
    let failed = 0;
    let left = capped.length;

    capped.forEach((r) => {
        sendOutbound(
            db,
            {
                to: r.email,
                name: r.name,
                subject,
                body,
                fromDisplay,
                createdBy,
                seminarId
            },
            (err) => {
                if (err) failed++;
                else threads++;
                left--;
                if (left === 0) {
                    setImmediate(() => {
                        notifEngine.drainNotificationQueue(db, 12).catch(() => {});
                    });
                    cb(null, { threads, failed, total: capped.length });
                }
            }
        );
    });
}

module.exports = {
    ensureSchema,
    sendOutbound,
    sendThreadReply,
    sendBulkWithThreads,
    listThreads,
    getThread,
    ingestParticipantReply,
    inboundStatus,
    THREADS,
    MSGS
};

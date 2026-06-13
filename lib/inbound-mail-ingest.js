/**
 * Shared inbound email → portal thread ingest (webhook, Gmail IMAP poller, etc.).
 */
const messageReplyAddress = require('./message-reply-address');
const judgeContact = require('./judge-participant-contact');
const supportTicketNotify = require('./support-ticket-notify');

function extractSenderEmail(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return (m ? m[1] : from).trim().toLowerCase();
}

function stripQuotedReply(text) {
    const lines = String(text || '').split('\n');
    const out = [];
    for (const line of lines) {
        if (/^On .+ wrote:/i.test(line)) break;
        if (/^>{1,}/.test(line)) break;
        if (/^From:/i.test(line) && out.length > 2) break;
        if (/^-----Original Message-----/i.test(line)) break;
        if (/^\[VGMF-/i.test(line.trim())) continue;
        out.push(line);
    }
    return out.join('\n').trim();
}

function resolveThreadRef(norm) {
    for (const addr of norm.toList || []) {
        const ref = messageReplyAddress.parseInboundRecipient(addr);
        if (ref) return ref;
    }
    const blobs = [norm.subject, norm.text, norm.html];
    for (const blob of blobs) {
        const ref = messageReplyAddress.parseRefFromText(blob);
        if (ref) return ref;
    }
    return null;
}

function canonicalTicketMessageId(ticket) {
    return ticket.ticket_id || ticket.tracking_id || String(ticket.id);
}

function isClientError(err) {
    const msg = String((err && err.message) || err || '').toLowerCase();
    return (
        msg.includes('not found') ||
        msg.includes('not recognized') ||
        msg.includes('does not match') ||
        msg.includes('empty message') ||
        msg.includes('required') ||
        msg.includes('already processed')
    );
}

function resolveTicketSenderId(db, ticket, senderType, senderEmail, cb) {
    if (senderType === 'user') {
        if (!ticket.user_id) return cb(new Error('Ticket owner account missing'));
        return cb(null, ticket.user_id);
    }
    const em = String(senderEmail || '').trim().toLowerCase();
    if (!em) return cb(new Error('Staff sender email required for ticket email reply'));
    db.get(
        `SELECT id FROM users
         WHERE lower(trim(email)) = ? AND IFNULL(is_disabled, 0) = 0
         ORDER BY CASE
           WHEN LOWER(TRIM(COALESCE(user_role,''))) IN ('support_agent','staff_user','co_admin') THEN 0
           WHEN LOWER(TRIM(COALESCE(role,''))) = 'admin' THEN 1
           ELSE 2 END, id ASC
         LIMIT 1`,
        [em],
        (e, row) => {
            if (e) return cb(e);
            if (row && row.id) return cb(null, row.id);
            cb(new Error('Staff sender not recognized for ticket email reply: ' + em));
        }
    );
}

function ensureInboundDedupSchema(db, cb) {
    const pg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const sql = pg
        ? `CREATE TABLE IF NOT EXISTS inbound_mail_seen (
            id SERIAL PRIMARY KEY,
            provider TEXT NOT NULL,
            message_key TEXT NOT NULL UNIQUE,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS inbound_mail_seen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            message_key TEXT NOT NULL UNIQUE,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP
        )`;
    db.run(sql, (e) => cb && cb(e));
}

function claimInboundMessage(db, provider, messageKey, cb) {
    ensureInboundDedupSchema(db, () => {
        db.run(
            `INSERT INTO inbound_mail_seen (provider, message_key) VALUES (?, ?)`,
            [String(provider || 'unknown'), String(messageKey || '').trim()],
            function (err) {
                if (err && /unique|duplicate/i.test(String(err.message))) {
                    return cb(new Error('Message already processed'));
                }
                if (err) return cb(err);
                cb(null, true);
            }
        );
    });
}

function ingestTicketReply(db, ref, senderEmail, message, cb) {
    const ticketId = ref.ticketId;
    db.get(
        `SELECT st.*, u.id AS owner_id, u.email AS owner_email
         FROM support_tickets st
         LEFT JOIN users u ON u.id = st.user_id
         WHERE st.ticket_id = ? OR st.tracking_id = ? OR CAST(st.id AS TEXT) = ?`,
        [ticketId, ticketId, ticketId],
        (err, ticket) => {
            if (err) return cb(err);
            if (!ticket) return cb(new Error('Ticket not found for inbound reply'));
            const canonical = canonicalTicketMessageId(ticket);
            const ownerEmail = String(ticket.owner_email || '').toLowerCase();
            const senderType = ownerEmail && senderEmail === ownerEmail ? 'user' : 'support';

            resolveTicketSenderId(db, ticket, senderType === 'user' ? 'user' : 'admin', senderEmail, (senderErr, senderId) => {
                if (senderErr) return cb(senderErr);
                const stInsert = senderType === 'user' ? 'user' : 'support';

                db.run(
                    `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path, source)
                     VALUES (?, ?, ?, ?, NULL, 'email')`,
                    [canonical, senderId, stInsert, message],
                    function (insErr) {
                        if (insErr) {
                            return db.run(
                                `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path)
                                 VALUES (?, ?, ?, ?, NULL)`,
                                [canonical, senderId, stInsert, message],
                                function (insErr2) {
                                    if (insErr2) return cb(insErr2);
                                    finishTicketInsert.call(this, db, ticket, canonical, stInsert, message, cb);
                                }
                            );
                        }
                        finishTicketInsert.call(this, db, ticket, canonical, stInsert, message, cb);
                    }
                );
            });
        }
    );
}

function finishTicketInsert(db, ticket, canonical, senderType, message, cb) {
    const messageId = this.lastID;
    db.run(`UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [ticket.id], () => {
        supportTicketNotify.notifySupportTicketReply(db, canonical, senderType, message, null, () => {
            cb(null, { type: 'ticket', messageId, senderType, via: 'email' });
        });
    });
}

function ingestCaseReply(db, ref, senderEmail, message, cb) {
    const { submissionId, judgeUserId } = ref;
    db.get(
        `SELECT cs.*, u.email AS account_email, u.phone AS account_phone
         FROM case_submissions cs
         JOIN users u ON u.id = cs.user_id
         WHERE cs.id = ?`,
        [submissionId],
        (err, sub) => {
            if (err) return cb(err);
            if (!sub) return cb(new Error('Case submission not found'));

            db.get(`SELECT * FROM users WHERE id = ?`, [judgeUserId], (eJ, judge) => {
                if (eJ) return cb(eJ);
                if (!judge) return cb(new Error('Judge not found for thread'));

                const participant = judgeContact.parseParticipantFromSubmission(sub, {
                    email: sub.account_email,
                    phone: sub.account_phone
                });
                const doctorEmail = String(participant.email || sub.account_email || '').toLowerCase();
                const judgeEmail = String(judge.email || '').toLowerCase();

                if (doctorEmail && senderEmail === doctorEmail) {
                    db.get(`SELECT id FROM users WHERE id = ?`, [sub.user_id], (eU, participantUser) => {
                        if (eU || !participantUser) return cb(eU || new Error('Participant user missing'));
                        judgeContact
                            .sendParticipantReply(db, {
                                participantUser,
                                judge,
                                participant,
                                submissionId,
                                message,
                                judgeUserId,
                                viaEmail: true
                            })
                            .then((r) => cb(null, { type: 'case', direction: 'participant', result: r, via: 'email' }))
                            .catch((ex) => cb(ex));
                    });
                    return;
                }
                if (judgeEmail && senderEmail === judgeEmail) {
                    judgeContact
                        .sendJudgeMessage(db, {
                            judge,
                            participant,
                            subject: null,
                            message,
                            submissionId,
                            viaEmail: true
                        })
                        .then((r) => cb(null, { type: 'case', direction: 'judge', result: r, via: 'email' }))
                        .catch((ex) => cb(ex));
                    return;
                }
                cb(
                    new Error(
                        'Sender email does not match doctor or judge on this thread. Expected ' +
                            doctorEmail +
                            ' or ' +
                            judgeEmail
                    )
                );
            });
        }
    );
}

function ingestAdminReply(db, ref, senderEmail, message, cb) {
    const adminMailThreads = require('./admin-mail-threads');
    adminMailThreads.ingestParticipantReply(db, ref.threadId, senderEmail, message, cb);
}

/**
 * @param {object} norm { from, subject, text, html, toList }
 */
function processInboundNormalized(db, norm, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    const provider = (opts && opts.provider) || 'webhook';
    const messageKey = (opts && opts.messageKey) || null;
    const skipDedup = !!(opts && opts.skipDedup);

    const run = () => {
        const ref = resolveThreadRef(norm);
        if (!ref) {
            return cb(
                new Error(
                    'Could not find thread reference. Include [VGMF-TKT-…] or ticket id TKT_… in the email (keep the reference line when replying).'
                )
            );
        }
        const senderEmail = extractSenderEmail(norm.from);
        let message = stripQuotedReply(String(norm.text || '').trim());
        if (!message && norm.html) {
            message = stripQuotedReply(
                String(norm.html)
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .trim()
            );
        }
        if (!message) message = stripQuotedReply(String(norm.subject || '').trim());
        if (!message) return cb(new Error('Empty message body'));

        const done = (err, result) => {
            if (err) return cb(err);
            cb(null, { success: true, provider, ...result });
        };

        if (ref.type === 'ticket') return ingestTicketReply(db, ref, senderEmail, message, done);
        if (ref.type === 'case') return ingestCaseReply(db, ref, senderEmail, message, done);
        if (ref.type === 'admin') return ingestAdminReply(db, ref, senderEmail, message, done);
        cb(new Error('Unknown thread type'));
    };

    if (skipDedup || !messageKey) return run();
    claimInboundMessage(db, provider, messageKey, (eClaim) => {
        if (eClaim) return cb(eClaim);
        run();
    });
}

module.exports = {
    extractSenderEmail,
    stripQuotedReply,
    resolveThreadRef,
    processInboundNormalized,
    claimInboundMessage,
    ensureInboundDedupSchema,
    isClientError
};

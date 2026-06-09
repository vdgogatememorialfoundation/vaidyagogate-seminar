/**
 * Ingest inbound email via Mailparser.io / SendGrid / Mailgun webhooks into portal threads.
 * POST /api/webhooks/inbound-email  (header x-inbound-mail-secret)
 * POST /api/webhooks/mailparser     (alias)
 */
const messageReplyAddress = require('./message-reply-address');
const emailParserNormalize = require('./email-parser-normalize');
const judgeContact = require('./judge-participant-contact');
const supportTicketNotify = require('./support-ticket-notify');

function webhookSecretOk(req) {
    const expected = String(process.env.INBOUND_MAIL_WEBHOOK_SECRET || '').trim();
    if (!expected) return false;
    const got =
        String(req.headers['x-inbound-mail-secret'] || req.headers['x-webhook-secret'] || '').trim() ||
        String((req.body && req.body.secret) || '').trim();
    return got === expected;
}

function extractSenderEmail(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return (m ? m[1] : from).trim().toLowerCase();
}

function extractMessageText(norm) {
    const text = norm.text || '';
    if (text && String(text).trim()) return String(text).trim();
    const html = norm.html || '';
    if (!html) return '';
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
    return (
        messageReplyAddress.parseRefFromText(norm.subject) ||
        messageReplyAddress.parseRefFromText(norm.text) ||
        messageReplyAddress.parseRefFromText(norm.html)
    );
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
        msg.includes('required')
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
        `SELECT id FROM users WHERE lower(trim(email)) = ? AND IFNULL(is_disabled, 0) = 0 LIMIT 1`,
        [em],
        (e, row) => {
            if (e) return cb(e);
            if (row && row.id) return cb(null, row.id);
            db.get(
                `SELECT id FROM users WHERE lower(trim(role)) = 'admin' AND IFNULL(is_disabled, 0) = 0 ORDER BY id LIMIT 1`,
                [],
                (e2, adminRow) => {
                    if (e2) return cb(e2);
                    if (adminRow && adminRow.id) return cb(null, adminRow.id);
                    cb(new Error('Staff sender not recognized for ticket email reply'));
                }
            );
        }
    );
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
            const senderType = ownerEmail && senderEmail === ownerEmail ? 'user' : 'admin';

            resolveTicketSenderId(db, ticket, senderType, senderEmail, (senderErr, senderId) => {
                if (senderErr) return cb(senderErr);

            db.run(
                `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path, source)
                 VALUES (?, ?, ?, ?, NULL, 'email')`,
                [canonical, senderId, senderType, message],
                function (insErr) {
                    if (insErr) {
                        return db.run(
                            `INSERT INTO ticket_messages (ticket_id, sender_id, sender_type, message, attachment_path)
                             VALUES (?, ?, ?, ?, NULL)`,
                            [canonical, senderId, senderType, message],
                            function (insErr2) {
                                if (insErr2) return cb(insErr2);
                                finishTicketInsert.call(this, db, ticket, canonical, senderType, message, cb);
                            }
                        );
                    }
                    finishTicketInsert.call(this, db, ticket, canonical, senderType, message, cb);
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

function handleInboundMail(db, req, res) {
    if (!webhookSecretOk(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const norm = emailParserNormalize.normalizeInboundPayload(req.body || {});
    const ref = resolveThreadRef(norm);
    if (!ref) {
        return res.status(400).json({
            error: 'Could not find thread reference. Include [VGMF-ADM-id], [VGMF-CASE-id-judgeId], or [VGMF-TKT-…] in the email.',
            provider: norm.provider
        });
    }
    const senderEmail = extractSenderEmail(norm.from);
    let message = stripQuotedReply(extractMessageText(norm));
    if (!message) message = stripQuotedReply(String(norm.subject || '').trim());
    if (!message) return res.status(400).json({ error: 'Empty message body' });

    const done = (err, result) => {
        if (err) {
            console.warn('[inbound-mail]', err.message);
            const code = isClientError(err) ? 400 : 500;
            return res.status(code).json({ error: err.message });
        }
        res.json({ success: true, provider: norm.provider, ...result });
    };

    if (ref.type === 'ticket') return ingestTicketReply(db, ref, senderEmail, message, done);
    if (ref.type === 'case') return ingestCaseReply(db, ref, senderEmail, message, done);
    if (ref.type === 'admin') return ingestAdminReply(db, ref, senderEmail, message, done);
    res.status(400).json({ error: 'Unknown thread type' });
}

function ingestAdminReply(db, ref, senderEmail, message, cb) {
    const adminMailThreads = require('./admin-mail-threads');
    adminMailThreads.ingestParticipantReply(db, ref.threadId, senderEmail, message, cb);
}

module.exports = {
    handleInboundMail,
    extractMessageText,
    stripQuotedReply
};

/**
 * Email/WhatsApp when support tickets are created or replied to.
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');
const messageReplyAddress = require('./message-reply-address');
const threadReplyNotify = require('./thread-reply-notify');
const supportTicketSla = require('./support-ticket-sla');

function loadTicketWithUser(db, ticketId, cb) {
    db.get(
        `SELECT st.ticket_id, st.tracking_id, st.subject, st.category, st.status, st.priority,
                st.expected_response_at, st.user_id, u.first_name, u.last_name, u.email, u.phone, u.user_id_string
         FROM support_tickets st
         LEFT JOIN users u ON u.id = st.user_id
         WHERE st.ticket_id = ? OR st.tracking_id = ?`,
        [ticketId, ticketId],
        cb
    );
}

function ticketCanonicalId(ticketRow) {
    return ticketRow.ticket_id || ticketRow.tracking_id || String(ticketRow.id || '');
}

function ticketReplyTo(ticketRow) {
    return messageReplyAddress.buildTicketReplyAddress(ticketCanonicalId(ticketRow));
}

function ticketRef(ticketRow) {
    return messageReplyAddress.ticketRefToken(ticketCanonicalId(ticketRow));
}

function notifyDoctorSupportEvent(db, ticketRow, eventKey, extra, cb) {
    if (!ticketRow || !ticketRow.user_id) return cb && cb(null, { skipped: true });
    const replyTo = ticketReplyTo(ticketRow);
    const refToken = ticketRef(ticketRow);
    const msg = (extra && extra.message) || '';
    notifEngine.notify(
        db,
        eventKey,
        {
            userId: ticketRow.user_id,
            vars: {
                ticket_id: ticketRow.ticket_id || ticketRow.tracking_id || '',
                ticket_subject: ticketRow.subject || '',
                ticket_message: msg + messageReplyAddress.replyFooterNote(replyTo, refToken),
                portal_login_url: notifEngine.publicBaseUrl() + '/doctor.html#tab-support',
                ticket_reply_to: replyTo || '',
                expected_response_display: ticketRow.expected_response_at
                    ? supportTicketSla.formatExpectedDisplay(ticketRow.expected_response_at)
                    : ''
            },
            immediate: true,
            emailExtras: replyTo ? { replyTo } : {}
        },
        cb
    );
}

function notifyStaffSupportReply(db, ticketRow, message, cb) {
    const body =
        'Support ticket reply from doctor\n\n' +
        `Ticket: ${ticketRow.ticket_id || ticketRow.tracking_id}\n` +
        `Subject: ${ticketRow.subject || '—'}\n` +
        `Doctor: ${[ticketRow.first_name, ticketRow.last_name].filter(Boolean).join(' ')} (${ticketRow.user_id_string || ticketRow.user_id})\n` +
        `Email: ${ticketRow.email || '—'}\n\n` +
        `Message:\n${message || ''}`;
    const subject = `Support ticket reply: ${ticketRow.ticket_id || ticketRow.tracking_id}`;

    designatedNotify.loadConfig(db, (eCfg, cfg) => {
        const emails = (cfg && cfg.emails) || [];
        const fallback = String(process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '').trim();
        const targets = emails.length ? emails : fallback ? [fallback] : [];
        if (!targets.length) return cb && cb(null, { skipped: true, reason: 'no staff email' });

        let pending = targets.length;
        const replyTo = ticketReplyTo(ticketRow);
        const refToken = ticketRef(ticketRow);
        const bodyWithFooter = body + messageReplyAddress.replyFooterNote(replyTo, refToken);
        const htmlWithFooter =
            '<div style="font-family:Segoe UI,sans-serif;line-height:1.55">' +
            bodyWithFooter.replace(/\n/g, '<br>') +
            '</div>';
        targets.forEach((dest) => {
            notifEngine.enqueueDirectMessage(
                db,
                {
                    channel: 'email',
                    destination: dest,
                    subject,
                    html: htmlWithFooter,
                    text: bodyWithFooter,
                    event_key: 'SUPPORT_TICKET_REPLY_TO_ADMIN',
                    immediate: true,
                    replyTo: replyTo || undefined
                },
                () => {
                    pending--;
                    if (pending === 0) cb && cb(null, { queued: true });
                }
            );
        });
    });
}

function notifySupportTicketCreated(db, ticketId, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const extra = { message: '' };
        if (row.expected_response_at) {
            extra.message =
                'Expected response by ' + supportTicketSla.formatExpectedDisplay(row.expected_response_at) + ' (IST).';
        }
        notifyDoctorSupportEvent(db, row, 'SUPPORT_TICKET_CREATED', extra, cb);
    });
}

function notifySupportTicketReply(db, ticketId, senderType, message, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const st = String(senderType || '').toLowerCase();
        const ticketLabel = 'Support ticket ' + (row.ticket_id || row.tracking_id || '');
        if (st === 'admin' || st === 'staff') {
            return notifyDoctorSupportEvent(db, row, 'SUPPORT_TICKET_REPLY_TO_DOCTOR', { message }, (nErr, out) => {
                if (nErr) return cb && cb(nErr);
                threadReplyNotify.notifyUserResponse(
                    db,
                    {
                        userId: row.user_id,
                        threadLabel: ticketLabel,
                        messagePreview: message,
                        portalPath: 'doctor_support'
                    },
                    () => cb && cb(null, out)
                );
            });
        }
        if (st === 'user' || st === 'doctor') {
            return notifyStaffSupportReply(db, row, message, (nErr, out) => {
                if (nErr) return cb && cb(nErr);
                threadReplyNotify.notifyStaffInbox(
                    db,
                    {
                        threadLabel: ticketLabel + ' — ' + (row.subject || ''),
                        messagePreview: message,
                        subject: 'New support ticket reply — open dashboard'
                    },
                    () => cb && cb(null, out)
                );
            });
        }
        notifyStaffSupportReply(db, row, message, cb);
    });
}

function notifySupportTicketStatusChange(db, ticketId, oldStatus, newStatus, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        notifyDoctorSupportEvent(
            db,
            row,
            'SUPPORT_TICKET_STATUS_CHANGED',
            {
                ticket_status: newStatus || '',
                ticket_status_previous: oldStatus || '',
                message: `Status changed from ${oldStatus || '—'} to ${newStatus || '—'}.`
            },
            cb
        );
    });
}

function notifySupportTicketPriorityChange(db, ticketId, oldPriority, newPriority, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        notifyDoctorSupportEvent(
            db,
            row,
            'SUPPORT_TICKET_PRIORITY_CHANGED',
            {
                ticket_priority: newPriority || '',
                ticket_priority_previous: oldPriority || '',
                message: `Priority changed from ${oldPriority || '—'} to ${newPriority || '—'}.`
            },
            cb
        );
    });
}

function notifySupportTicketTransferred(db, ticketId, oldUserId, newUserRow, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const newName = newUserRow
            ? [newUserRow.first_name, newUserRow.last_name].filter(Boolean).join(' ')
            : '';
        notifyDoctorSupportEvent(
            db,
            row,
            'SUPPORT_TICKET_TRANSFERRED',
            {
                message:
                    'This ticket was transferred to your account' +
                    (newName ? ' (' + newName + ').' : '.')
            },
            (e1) => {
                if (!oldUserId || oldUserId === row.user_id) return cb && cb(e1);
                db.get(
                    `SELECT id, first_name, last_name, email FROM users WHERE id = ?`,
                    [oldUserId],
                    (e2, oldU) => {
                        if (e2 || !oldU) return cb && cb(e1);
                        notifEngine.notify(
                            db,
                            'SUPPORT_TICKET_TRANSFERRED_AWAY',
                            {
                                userId: oldUserId,
                                vars: {
                                    ticket_id: row.ticket_id || row.tracking_id || '',
                                    ticket_subject: row.subject || '',
                                    message: 'This ticket was moved to another doctor account.',
                                    portal_login_url: notifEngine.publicBaseUrl() + '/doctor.html#tab-support'
                                },
                                immediate: true
                            },
                            () => cb && cb(e1)
                        );
                    }
                );
            }
        );
    });
}

module.exports = {
    notifySupportTicketCreated,
    notifySupportTicketReply,
    notifySupportTicketStatusChange,
    notifySupportTicketPriorityChange,
    notifySupportTicketTransferred
};

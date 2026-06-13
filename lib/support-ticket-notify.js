/**
 * Email/WhatsApp when support tickets are created or replied to.
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');
const messageReplyAddress = require('./message-reply-address');
const threadReplyNotify = require('./thread-reply-notify');
const supportTicketSla = require('./support-ticket-sla');
const { careReplyToEmail } = require('./support-care-email');

const staffDisplay = require('./staff-display-name');

function loadTicketWithUser(db, ticketId, cb) {
    db.get(
        `SELECT st.ticket_id, st.tracking_id, st.subject, st.category, st.status, st.priority,
                st.expected_response_at, st.user_id, st.assigned_to_staff,
                u.first_name, u.last_name, u.email, u.phone, u.user_id_string
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

function ticketEmailFooter(ticketRow, messageBody) {
    const canonical = ticketCanonicalId(ticketRow);
    const refToken = messageReplyAddress.ticketRefToken(canonical);
    let msg = String(messageBody || '');
    if (refToken && !msg.includes(refToken)) {
        msg += messageReplyAddress.embedRefLine(refToken);
        msg += '\nReply to this email (keep the reference line above) and your message will appear on the ticket.';
    }
    return {
        message: msg,
        replyTo: messageReplyAddress.buildTicketReplyAddress(canonical) || careReplyToEmail()
    };
}

function notifyDoctorSupportEvent(db, ticketRow, eventKey, extra, cb) {
    if (!ticketRow || !ticketRow.user_id) return cb && cb(null, { skipped: true });
    const portalUrl = notifEngine.publicBaseUrl() + '/doctor#tab-support';
    const footer = ticketEmailFooter(ticketRow, (extra && extra.message) || '');
    const emailExtras = { replyTo: footer.replyTo };
    if (extra && extra.fromDisplay) emailExtras.fromDisplay = extra.fromDisplay;
    notifEngine.notify(
        db,
        eventKey,
        {
            userId: ticketRow.user_id,
            vars: {
                ticket_id: ticketRow.ticket_id || ticketRow.tracking_id || '',
                ticket_subject: ticketRow.subject || '',
                ticket_message: footer.message + messageReplyAddress.supportTicketPortalFooter(portalUrl),
                portal_login_url: portalUrl,
                ticket_reply_to: footer.replyTo,
                expected_response_display: ticketRow.expected_response_at
                    ? supportTicketSla.formatExpectedDisplay(ticketRow.expected_response_at)
                    : '',
                staff_name: (extra && extra.staff_name) || 'Support team'
            },
            immediate: true,
            emailExtras
        },
        cb
    );
}

function notifyStaffSupportReply(db, ticketRow, message, cb) {
    const ticketRef = ticketRow.ticket_id || ticketRow.tracking_id || '';
    const subject = `Support ticket reply: ${ticketRef}`;
    const portalUrl = notifEngine.publicBaseUrl() + '/support';
    const body =
        'Support ticket reply from doctor\n\n' +
        `Ticket: ${ticketRef}\n` +
        `Subject: ${ticketRow.subject || '—'}\n` +
        `Doctor: ${[ticketRow.first_name, ticketRow.last_name].filter(Boolean).join(' ')} (${ticketRow.user_id_string || ticketRow.user_id})\n` +
        `Email: ${ticketRow.email || '—'}\n\n` +
        `Message:\n${message || ''}`;
    const bodyWithFooter =
        body +
        '\n\n—\nOpen your assigned ticket in the support desk (you can also reply by email if your portal email matches):\n' +
        portalUrl;
    const htmlWithFooter =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55">' +
        bodyWithFooter.replace(/\n/g, '<br>') +
        '</div>';

    const agentId = parseInt(ticketRow.assigned_to_staff, 10);
    const supportDeskNotify = require('./support-desk-notify');

    const notifyAgent = (done) => {
        supportDeskNotify.notifyAgentTicketDoctorReply(
            db,
            agentId,
            ticketRow,
            message,
            (eA) => {
                if (eA) console.warn('[support-ticket] agent notify:', eA.message);
                done && done(null, { queued: true, agentId });
            }
        );
    };

    if (Number.isInteger(agentId) && agentId > 0) {
        return notifyAgent(cb);
    }

    designatedNotify.loadConfig(db, (eCfg, cfg) => {
        const emails = (cfg && cfg.emails) || [];
        const fallback = String(process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '').trim();
        const targets = emails.length ? emails : fallback ? [fallback] : [];
        if (!targets.length) return cb && cb(null, { skipped: true, reason: 'no staff email' });

        const care = careReplyToEmail();
        let pending = targets.length;
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
                    replyTo: care
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

function notifySupportTicketReply(db, ticketId, senderType, message, senderId, cb) {
    if (typeof senderId === 'function') {
        cb = senderId;
        senderId = null;
    }
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const st = String(senderType || '').toLowerCase();
        const ticketLabel = 'Support ticket ' + (row.ticket_id || row.tracking_id || '');
        const finishStaffReply = (staffUser) => {
            const staffName = staffDisplay.formatStaffPersonName(staffUser);
            const fromDisplay = staffDisplay.formatStaffFromDisplay(staffUser);
            return notifyDoctorSupportEvent(
                db,
                row,
                'SUPPORT_TICKET_REPLY_TO_DOCTOR',
                { message, staff_name: staffName, fromDisplay },
                (nErr, out) => {
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
                }
            );
        };
        if (st === 'admin' || st === 'staff' || st === 'support') {
            const sid = parseInt(senderId, 10);
            if (!Number.isInteger(sid) || sid < 1) return finishStaffReply(null);
            return db.get(
                `SELECT id, first_name, middle_name, last_name, email FROM users WHERE id = ?`,
                [sid],
                (eU, staffUser) => finishStaffReply(eU ? null : staffUser)
            );
        }
        if (st === 'user' || st === 'doctor') {
            return notifyStaffSupportReply(db, row, message, (nErr, out) => {
                if (nErr) return cb && cb(nErr);
                const agentId = parseInt(row.assigned_to_staff, 10);
                if (Number.isInteger(agentId) && agentId > 0) {
                    return cb && cb(null, out);
                }
                threadReplyNotify.notifyStaffInbox(
                    db,
                    {
                        threadLabel: ticketLabel + ' — ' + (row.subject || ''),
                        messagePreview: message,
                        subject: 'New support ticket reply — open support desk',
                        dashboardUrl: threadReplyNotify.dashboardUrl('support_desk')
                    },
                    () => cb && cb(null, out)
                );
            });
        }
        notifyStaffSupportReply(db, row, message, cb);
    });
}

function notifySupportTicketStatusChange(db, ticketId, oldStatus, newStatus, adminId, cb) {
    if (typeof adminId === 'function') {
        cb = adminId;
        adminId = null;
    }
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const apply = (staffUser) => {
            const staffName = staffDisplay.formatStaffPersonName(staffUser);
            notifyDoctorSupportEvent(
                db,
                row,
                'SUPPORT_TICKET_STATUS_CHANGED',
                {
                    ticket_status: newStatus || '',
                    ticket_status_previous: oldStatus || '',
                    message: `Status changed from ${oldStatus || '—'} to ${newStatus || '—'}${staffName !== 'Support team' ? ' by ' + staffName : ''}.`,
                    staff_name: staffName,
                    fromDisplay: staffDisplay.formatStaffFromDisplay(staffUser)
                },
                cb
            );
        };
        const sid = parseInt(adminId, 10);
        if (!Number.isInteger(sid) || sid < 1) return apply(null);
        db.get(
            `SELECT id, first_name, middle_name, last_name FROM users WHERE id = ?`,
            [sid],
            (eU, staffUser) => apply(eU ? null : staffUser)
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
                                    portal_login_url: notifEngine.publicBaseUrl() + '/doctor#tab-support'
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

function notifyStaffNewSupportTicket(db, ticketId, guestMeta, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const subject = 'New support ticket: ' + (row.ticket_id || row.tracking_id || '');
        const guest = guestMeta || {};
        const text =
            'A new support ticket was created from the website / live chat.\n\n' +
            `Ticket: ${row.ticket_id || row.tracking_id || '—'}\n` +
            `Subject: ${row.subject || '—'}\n` +
            `Category: ${row.category || '—'}\n` +
            (guest.guestName ? `Contact: ${guest.guestName}\n` : '') +
            (guest.guestEmail ? `Email: ${guest.guestEmail}\n` : '') +
            (guest.guestPhone ? `Phone: ${guest.guestPhone}\n` : '') +
            '\nOpen the support desk:\n' +
            notifEngine.publicBaseUrl() +
            '/support';
        const html =
            '<div style="font-family:Segoe UI,sans-serif;line-height:1.55;max-width:560px;">' +
            '<p><strong>New support ticket</strong></p>' +
            '<p><strong>' +
            String(row.ticket_id || row.tracking_id || '').replace(/</g, '&lt;') +
            '</strong> — ' +
            String(row.subject || '').replace(/</g, '&lt;') +
            '</p></div>';

        designatedNotify.loadConfig(db, (eCfg, cfg) => {
            const emails = (cfg && cfg.emails) || [];
            const fallback = String(process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '').trim();
            const targets = emails.length ? emails : fallback ? [fallback] : [];
            if (!targets.length) return cb && cb(null, { skipped: true, reason: 'no staff email' });

            const care = careReplyToEmail();
            let pending = targets.length;
            targets.forEach((dest) => {
                notifEngine.enqueueDirectMessage(
                    db,
                    {
                        channel: 'email',
                        destination: dest,
                        subject,
                        html,
                        text,
                        event_key: 'SUPPORT_TICKET_CREATED_TO_ADMIN',
                        immediate: true,
                        replyTo: care
                    },
                    () => {
                        pending--;
                        if (pending === 0) cb && cb(null, { queued: true });
                    }
                );
            });
        });
    });
}

module.exports = {
    notifySupportTicketCreated,
    notifySupportTicketReply,
    notifySupportTicketStatusChange,
    notifySupportTicketPriorityChange,
    notifySupportTicketTransferred,
    notifyStaffNewSupportTicket
};

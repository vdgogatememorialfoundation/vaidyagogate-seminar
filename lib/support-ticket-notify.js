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

function notifyDoctorSupportEvent(db, ticketRow, eventKey, extra, cb) {
    if (!ticketRow || !ticketRow.user_id) return cb && cb(null, { skipped: true });
    const portalUrl = notifEngine.publicBaseUrl() + '/doctor#tab-support';
    const canonical = ticketCanonicalId(ticketRow);
    const refToken = messageReplyAddress.ticketRefToken(canonical);
    const replyTo = messageReplyAddress.buildTicketReplyAddress(canonical) || careReplyToEmail();
    const msg = (extra && extra.message) || '';
    const msgWithFooter =
        msg + messageReplyAddress.replyFooterNote(replyTo, refToken) + messageReplyAddress.supportTicketPortalFooter(portalUrl);
    const emailExtras = { replyTo: replyTo || careReplyToEmail() };
    if (extra && extra.fromDisplay) emailExtras.fromDisplay = extra.fromDisplay;
    notifEngine.notify(
        db,
        eventKey,
        {
            userId: ticketRow.user_id,
            vars: {
                ticket_id: ticketRow.ticket_id || ticketRow.tracking_id || '',
                ticket_subject: ticketRow.subject || '',
                ticket_message: msgWithFooter,
                portal_login_url: portalUrl,
                ticket_reply_to: replyTo || '',
                ticket_ref_token: refToken,
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
    const canonical = ticketCanonicalId(ticketRow);
    const refToken = messageReplyAddress.ticketRefToken(canonical);
    const care = careReplyToEmail();
    const portalUrl = notifEngine.publicBaseUrl() + '/support';
    const body =
        'Support ticket reply from doctor\n\n' +
        `Ticket: ${ticketRow.ticket_id || ticketRow.tracking_id}\n` +
        `Subject: ${ticketRow.subject || '—'}\n` +
        `Doctor: ${[ticketRow.first_name, ticketRow.last_name].filter(Boolean).join(' ')} (${ticketRow.user_id_string || ticketRow.user_id})\n` +
        `Email: ${ticketRow.email || '—'}\n\n` +
        `Message:\n${message || ''}` +
        messageReplyAddress.embedRefLine(refToken) +
        '\n\n—\nReply to this email (keep the reference line above) or open the support desk:\n' +
        portalUrl;
    const subject = `[${refToken}] Doctor replied — ${ticketRow.ticket_id || ticketRow.tracking_id}`;
    const html =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55">' +
        body.replace(/\n/g, '<br>') +
        '</div>';

    const supportDeskNotify = require('./support-desk-notify');
    const assignedId = parseInt(ticketRow.assigned_to_staff, 10);

    const notifyTargets = (targets, done) => {
        if (!targets.length) return done && done(null, { skipped: true, reason: 'no staff email' });
        let pending = targets.length;
        targets.forEach((dest) => {
            notifEngine.enqueueDirectMessage(
                db,
                {
                    channel: 'email',
                    destination: dest,
                    subject,
                    html,
                    text: body,
                    event_key: 'SUPPORT_TICKET_REPLY_TO_ADMIN',
                    immediate: true,
                    replyTo: care
                },
                () => {
                    pending--;
                    if (pending === 0) done && done(null, { queued: true });
                }
            );
        });
    };

    const afterAgentInbox = () => {
        if (Number.isInteger(assignedId) && assignedId > 0) {
            return cb(null, { queued: true, assignedAgent: assignedId });
        }
        fallbackDesignated();
    };

    function fallbackDesignated() {
        designatedNotify.loadConfig(db, (eCfg, cfg) => {
            const emails = (cfg && cfg.emails) || [];
            const fallback = String(process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '').trim();
            const targets = emails.length ? emails : fallback ? [fallback] : [];
            notifyTargets(targets, cb);
        });
    }

    if (Number.isInteger(assignedId) && assignedId > 0) {
        supportDeskNotify.notifyAgentTicketUserReply(db, assignedId, ticketRow, message, refToken, () => {
            afterAgentInbox();
        });
        return;
    }

    threadReplyNotify.notifyStaffInbox(
        db,
        {
            threadLabel: 'Support ticket ' + (ticketRow.ticket_id || ticketRow.tracking_id) + ' — ' + (ticketRow.subject || ''),
            messagePreview: message,
            subject: 'New support ticket reply — open support desk',
            dashboardUrl: portalUrl,
            intro: 'A doctor replied by email or portal.'
        },
        () => afterAgentInbox()
    );
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
            return notifyStaffSupportReply(db, row, message, cb);
        }
        notifyStaffSupportReply(db, row, message, cb);
    });
}

function notifySupportTicketStatusChange(db, ticketId, oldStatus, newStatus, adminId, cb) {
    if (typeof adminId === 'function') {
        cb = adminId;
        adminId = null;
    }
    const supportTicketFeedback = require('./support-ticket-feedback');
    const terminal = supportTicketFeedback.isTerminalTicketStatus(newStatus);
    const wasTerminal = supportTicketFeedback.isTerminalTicketStatus(oldStatus);
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const canonical = ticketCanonicalId(row);
        const apply = (staffUser) => {
            const staffName = staffDisplay.formatStaffPersonName(staffUser);
            const statusMsg = terminal
                ? `Your support ticket has been marked as ${newStatus}.`
                : `Status changed from ${oldStatus || '—'} to ${newStatus || '—'}${staffName !== 'Support team' ? ' by ' + staffName : ''}.`;
            notifyDoctorSupportEvent(
                db,
                row,
                'SUPPORT_TICKET_STATUS_CHANGED',
                {
                    ticket_status: newStatus || '',
                    ticket_status_previous: oldStatus || '',
                    message: statusMsg,
                    staff_name: staffName,
                    fromDisplay: staffDisplay.formatStaffFromDisplay(staffUser)
                },
                (nErr) => {
                    if (nErr) return cb && cb(nErr);
                    if (!terminal || wasTerminal || !row.user_id) return cb && cb(null, { notified: true });
                    const closedBy =
                        parseInt(adminId, 10) > 0
                            ? parseInt(adminId, 10)
                            : parseInt(row.assigned_to_staff, 10) > 0
                              ? parseInt(row.assigned_to_staff, 10)
                              : null;
                    supportTicketFeedback.createFeedbackInvite(
                        db,
                        {
                            ticketRef: canonical,
                            userId: row.user_id,
                            closedByAgentId: closedBy
                        },
                        (eInv, invite) => {
                            if (eInv) {
                                console.warn('[support-ticket] feedback invite:', eInv.message);
                                return cb && cb(null, { notified: true });
                            }
                            if (!invite || invite.skipped) return cb && cb(null, { notified: true });
                            sendRatingInviteEmail(db, row, invite.url, newStatus, (eMail) => {
                                if (eMail) console.warn('[support-ticket] rating email:', eMail.message);
                                cb && cb(null, { notified: true, ratingUrl: invite.url });
                            });
                        }
                    );
                }
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

function sendRatingInviteEmail(db, ticketRow, ratingUrl, status, cb) {
    if (!ticketRow || !ticketRow.user_id || !ratingUrl) return cb && cb(null, { skipped: true });
    const portalUrl = notifEngine.publicBaseUrl() + '/doctor#tab-support';
    const tid = ticketRow.ticket_id || ticketRow.tracking_id || '';
    const text =
        'Dear ' +
        [ticketRow.first_name, ticketRow.last_name].filter(Boolean).join(' ') +
        ',\n\n' +
        'Your support ticket ' +
        tid +
        ' (' +
        (ticketRow.subject || 'Support') +
        ') has been marked as ' +
        status +
        '.\n\n' +
        'Please rate your support experience using this one-time link (valid for you only):\n' +
        ratingUrl +
        '\n\n' +
        'You can also sign in to the doctor portal to view the conversation:\n' +
        portalUrl +
        '\n\nThank you for helping us improve our support.';
    const html =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55;max-width:560px;">' +
        '<p>Dear ' +
        String([ticketRow.first_name, ticketRow.last_name].filter(Boolean).join(' ') || 'Doctor').replace(
            /</g,
            '&lt;'
        ) +
        ',</p>' +
        '<p>Your support ticket <strong>' +
        String(tid).replace(/</g, '&lt;') +
        '</strong> has been marked as <strong>' +
        String(status).replace(/</g, '&lt;') +
        '</strong>.</p>' +
        '<p><a href="' +
        ratingUrl +
        '" style="display:inline-block;padding:12px 22px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Rate support (1–5 stars)</a></p>' +
        '<p style="font-size:0.88rem;color:#64748b;">This link is unique to your ticket. You can also rate from the <a href="' +
        portalUrl +
        '">doctor portal</a>.</p></div>';
    notifEngine.notify(
        db,
        'SUPPORT_TICKET_RATING_INVITE',
        {
            userId: ticketRow.user_id,
            vars: {
                ticket_id: tid,
                ticket_subject: ticketRow.subject || '',
                ticket_status: status || '',
                rating_url: ratingUrl,
                portal_login_url: portalUrl,
                ticket_message: text
            },
            immediate: true,
            emailExtras: {
                replyTo: require('./support-care-email').careReplyToEmail()
            }
        },
        (nErr) => {
            if (!nErr) return cb && cb(null, { queued: true });
            db.get(`SELECT email FROM users WHERE id = ?`, [ticketRow.user_id], (eU, u) => {
                if (eU || !u || !u.email) return cb && cb(nErr);
                notifEngine.enqueueDirectMessage(
                    db,
                    {
                        channel: 'email',
                        destination: u.email,
                        subject: 'Rate your support experience — ticket ' + tid,
                        html,
                        text,
                        event_key: 'SUPPORT_TICKET_RATING_INVITE',
                        immediate: true,
                        userId: ticketRow.user_id
                    },
                    cb
                );
            });
        }
    );
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

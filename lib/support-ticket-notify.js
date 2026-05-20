/**
 * Email/WhatsApp when support tickets are created or replied to.
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');

function loadTicketWithUser(db, ticketId, cb) {
    db.get(
        `SELECT st.ticket_id, st.tracking_id, st.subject, st.category, st.status, st.priority,
                st.user_id, u.first_name, u.last_name, u.email, u.phone, u.user_id_string
         FROM support_tickets st
         LEFT JOIN users u ON u.id = st.user_id
         WHERE st.ticket_id = ? OR st.tracking_id = ?`,
        [ticketId, ticketId],
        cb
    );
}

function notifyDoctorSupportEvent(db, ticketRow, eventKey, extra, cb) {
    if (!ticketRow || !ticketRow.user_id) return cb && cb(null, { skipped: true });
    notifEngine.notify(
        db,
        eventKey,
        {
            userId: ticketRow.user_id,
            vars: {
                ticket_id: ticketRow.ticket_id || ticketRow.tracking_id || '',
                ticket_subject: ticketRow.subject || '',
                ticket_message: (extra && extra.message) || '',
                portal_login_url: notifEngine.publicBaseUrl() + '/doctor.html#tab-support'
            },
            immediate: true
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
    const html =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55">' +
        body.replace(/\n/g, '<br>') +
        '</div>';

    designatedNotify.loadConfig(db, (eCfg, cfg) => {
        const emails = (cfg && cfg.emails) || [];
        const fallback = String(process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '').trim();
        const targets = emails.length ? emails : fallback ? [fallback] : [];
        if (!targets.length) return cb && cb(null, { skipped: true, reason: 'no staff email' });

        let pending = targets.length;
        targets.forEach((dest) => {
            notifEngine.enqueueDirectMessage(
                db,
                {
                    channel: 'email',
                    destination: dest,
                    subject,
                    html: html.replace('<motion-div', '<motion-div').replace('motion-div', 'motion-div'),
                    text: body,
                    event_key: 'SUPPORT_TICKET_REPLY_TO_ADMIN',
                    immediate: true
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
        notifyDoctorSupportEvent(db, row, 'SUPPORT_TICKET_CREATED', { message: '' }, cb);
    });
}

function notifySupportTicketReply(db, ticketId, senderType, message, cb) {
    loadTicketWithUser(db, ticketId, (err, row) => {
        if (err) return cb && cb(err);
        if (!row) return cb && cb(null, { skipped: true });
        const st = String(senderType || '').toLowerCase();
        if (st === 'admin') {
            return notifyDoctorSupportEvent(db, row, 'SUPPORT_TICKET_REPLY_TO_DOCTOR', { message }, cb);
        }
        notifyStaffSupportReply(db, row, message, cb);
    });
}

module.exports = {
    notifySupportTicketCreated,
    notifySupportTicketReply
};

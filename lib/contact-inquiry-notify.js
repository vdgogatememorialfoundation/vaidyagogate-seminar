/**
 * Staff notification when a public website contact inquiry is submitted.
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');
const { careReplyToEmail } = require('./support-care-email');

function notifyStaffContactInquiry(db, row, cb) {
    if (!row) return cb && cb(null, { skipped: true });
    const inqRef = 'INQ-' + row.id;
    const subject = 'Website contact: ' + String(row.subject || inqRef).slice(0, 120);
    const text =
        'New website contact inquiry\n\n' +
        `Reference: ${inqRef}\n` +
        `Name: ${row.name || '—'}\n` +
        `Email: ${row.email || '—'}\n` +
        `Phone: ${row.phone || '—'}\n` +
        `Subject: ${row.subject || '—'}\n\n` +
        `Message:\n${row.message || ''}\n\n` +
        '—\nOpen admin → Website contact to reply:\n' +
        notifEngine.publicBaseUrl() +
        '/admin#tab-contact-inquiries';
    const html =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55;max-width:560px;">' +
        '<p><strong>New website contact inquiry</strong></p>' +
        '<p><strong>' +
        String(inqRef).replace(/</g, '&lt;') +
        '</strong> — ' +
        String(row.subject || '').replace(/</g, '&lt;') +
        '</p>' +
        '<p>Name: ' +
        String(row.name || '—').replace(/</g, '&lt;') +
        '<br>Email: ' +
        String(row.email || '—').replace(/</g, '&lt;') +
        '<br>Phone: ' +
        String(row.phone || '—').replace(/</g, '&lt;') +
        '</p>' +
        '<p style="padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;white-space:pre-wrap;">' +
        String(row.message || '').replace(/</g, '&lt;') +
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
                    event_key: 'CONTACT_INQUIRY_TO_ADMIN',
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

module.exports = {
    notifyStaffContactInquiry
};

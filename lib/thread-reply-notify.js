/**
 * Short "you have a new response" emails with dashboard links (support, case, judge).
 */
const notifEngine = require('./notification-engine');
const designatedNotify = require('./designated-notify');

const PORTAL_PATHS = {
    doctor_support: '/doctor.html#tab-support',
    doctor_case: '/doctor.html#tab-case',
    judge: '/judge.html',
    admin_support: '/admin.html#tab-support-tickets'
};

function dashboardUrl(pathKey) {
    const base = notifEngine.publicBaseUrl().replace(/\/$/, '');
    const path = PORTAL_PATHS[pathKey] || PORTAL_PATHS.doctor_support;
    return base + path;
}

function previewText(text, maxLen) {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    if (!s) return '(no preview)';
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function notifyUserResponse(db, opts, cb) {
    const userId = parseInt(opts.userId, 10);
    if (!Number.isInteger(userId) || userId < 1) return cb && cb(null, { skipped: true });
    const pathKey = opts.portalPath || 'doctor_support';
    notifEngine.notify(
        db,
        'THREAD_REPLY_NEW_RESPONSE',
        {
            userId,
            vars: {
                thread_label: opts.threadLabel || 'Conversation',
                message_preview: previewText(opts.messagePreview, 280),
                dashboard_url: opts.dashboardUrl || dashboardUrl(pathKey),
                portal_name: opts.portalName || 'portal'
            },
            immediate: true
        },
        cb
    );
}

function notifyStaffInbox(db, opts, cb) {
    const subject = opts.subject || 'New response — open admin dashboard';
    const url = opts.dashboardUrl || dashboardUrl('admin_support');
    const text =
        (opts.intro || 'Someone replied on a support thread.') +
        '\n\n' +
        (opts.threadLabel ? 'Thread: ' + opts.threadLabel + '\n' : '') +
        previewText(opts.messagePreview, 500) +
        '\n\nOpen the admin dashboard to reply:\n' +
        url;
    const html =
        '<div style="font-family:Segoe UI,sans-serif;line-height:1.55;max-width:560px;">' +
        '<p><strong>You have a new response.</strong></p>' +
        (opts.threadLabel ? '<p>' + String(opts.threadLabel).replace(/</g, '&lt;') + '</p>' : '') +
        '<p style="padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">' +
        previewText(opts.messagePreview, 500).replace(/</g, '&lt;').replace(/\n/g, '<br>') +
        '</p>' +
        '<p><a href="' +
        url +
        '" style="display:inline-block;padding:12px 22px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Open admin dashboard</a></p></div>';

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
                    html,
                    text,
                    event_key: 'THREAD_REPLY_NEW_RESPONSE',
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

module.exports = {
    dashboardUrl,
    notifyUserResponse,
    notifyStaffInbox
};

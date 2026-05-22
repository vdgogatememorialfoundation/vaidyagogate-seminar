/**
 * Notify designated staff (email + WhatsApp) when accounts are created.
 * Config: global_settings.designated_notify_config JSON { emails: [], phones: [] }
 */
const notifEngine = require('./notification-engine');
const emailDeliveryPolicy = require('./email-delivery-policy');

const KEY = 'designated_notify_config';

function loadConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (err) return cb(err, { emails: [], phones: [] });
        let parsed = { emails: [], phones: [] };
        if (row && row.value) {
            try {
                const o = JSON.parse(row.value) || {};
                parsed.emails = Array.isArray(o.emails) ? o.emails.filter(Boolean) : [];
                parsed.phones = Array.isArray(o.phones) ? o.phones.filter(Boolean) : [];
            } catch (_) {}
        }
        cb(null, parsed);
    });
}

function buildAccountCreatedStaffMessage(user, extra) {
    const u = user || {};
    const full = [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' ').trim();
    const lines = [
        'New portal account created',
        '',
        `Name: ${full || '—'}`,
        `User ID: ${u.user_id_string || extra.user_id_string || '—'}`,
        `Email: ${u.email || '—'}`,
        `Phone: ${u.phone || '—'}`,
        `Role: ${u.user_role || u.role || 'doctor'}`,
        `Source: ${extra.source || 'signup'}`,
        extra.temporary_password ? `Password: ${extra.temporary_password}` : ''
    ].filter(Boolean);
    return lines.join('\n');
}

function notifyDesignatedAccountCreated(db, userId, extra, cb) {
    extra = extra || {};
    emailDeliveryPolicy.loadConfig(db, (ePol, pol) => {
        if (ePol) return cb && cb(ePol);
        if (emailDeliveryPolicy.shouldSkipPosStaffAlerts(pol, { source: extra.source, isPos: extra.isPos })) {
            return cb && cb(null, { skipped: true, reason: 'pos_staff_alerts_disabled' });
        }
    loadConfig(db, (eCfg, cfg) => {
        if (eCfg) return cb && cb(eCfg);
        const emails = cfg.emails || [];
        const phones = cfg.phones || [];
        if (!emails.length && !phones.length) return cb && cb(null, { skipped: true });

        db.get(
            `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, role, user_role FROM users WHERE id = ?`,
            [userId],
            (eu, user) => {
                if (eu) return cb && cb(eu);
                if (!user) return cb && cb(null, { skipped: true });
                const body = buildAccountCreatedStaffMessage(user, extra);
                const subject = `New account: ${user.first_name || ''} ${user.last_name || ''} (${user.user_id_string || user.id})`.trim();
                const html =
                    '<div style="font-family:Segoe UI,sans-serif;line-height:1.5">' +
                    body.replace(/\n/g, '<br>') +
                    '</div>';

                let pending = emails.length + phones.length;
                if (!pending) return cb && cb(null, { skipped: true });

                emails.forEach((dest) => {
                    notifEngine.enqueueDirectMessage(
                        db,
                        {
                            channel: 'email',
                            destination: dest,
                            subject,
                            html,
                            text: body,
                            event_key: 'ACCOUNT_CREATED_STAFF',
                            immediate: false
                        },
                        () => {
                            pending--;
                            if (pending === 0) cb && cb(null, { queued: true });
                        }
                    );
                });
                phones.forEach((dest) => {
                    notifEngine.enqueueDirectMessage(
                        db,
                        { channel: 'whatsapp', destination: dest, body, event_key: 'ACCOUNT_CREATED_STAFF' },
                        () => {
                            pending--;
                            if (pending === 0) cb && cb(null, { queued: true });
                        }
                    );
                });
            }
        );
    });
    });
}

module.exports = {
    KEY,
    loadConfig,
    notifyDesignatedAccountCreated,
    buildAccountCreatedStaffMessage
};

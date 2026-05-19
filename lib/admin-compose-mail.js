/**
 * Admin single & bulk email compose (SMTP via email-service / notification queue).
 */
const { sendEmail, isEmailConfigured } = require('./email-service');
const notifEngine = require('./notification-engine');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const BULK_CAP = 500;

function normalizeEmail(s) {
    return String(s || '')
        .trim()
        .toLowerCase();
}

function wrapHtmlBody(body, name) {
    const greeting = name ? `<p>Dear ${escapeHtml(name)},</p>` : '';
    const html = String(body || '')
        .trim()
        .replace(/\n/g, '<br>');
    return (
        '<div style="font-family:Georgia,serif;line-height:1.6;color:#333;max-width:640px;">' +
        greeting +
        '<div>' +
        html +
        '</div><p style="margin-top:24px;font-size:0.85rem;color:#64748b;">Vaidya Gogate Memorial Foundation</p></div>'
    );
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {object} db
 * @param {{ audience: string, seminarId?: number, userIds?: number[], emails?: string[] }} opts
 */
function resolveRecipients(db, opts, cb) {
    const audience = String(opts.audience || 'single_email').trim();
    const sid = opts.seminarId != null ? parseInt(opts.seminarId, 10) : null;

    if (audience === 'custom_emails') {
        const list = (Array.isArray(opts.emails) ? opts.emails : [])
            .map((e) => normalizeEmail(e))
            .filter((e) => EMAIL_RE.test(e));
        const uniq = [...new Set(list)];
        return cb(null, uniq.map((email) => ({ email, name: '' })));
    }

    if (audience === 'user_ids') {
        const ids = (Array.isArray(opts.userIds) ? opts.userIds : [])
            .map((x) => parseInt(x, 10))
            .filter((x) => x > 0);
        if (!ids.length) return cb(null, []);
        const ph = ids.map(() => '?').join(',');
        return db.all(
            `SELECT id, email, first_name, last_name FROM users WHERE id IN (${ph}) AND IFNULL(is_disabled,0) = 0`,
            ids,
            (e, rows) => {
                if (e) return cb(e);
                const out = (rows || [])
                    .map((u) => ({
                        email: normalizeEmail(u.email),
                        name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
                    }))
                    .filter((r) => EMAIL_RE.test(r.email));
                cb(null, out);
            }
        );
    }

    if (audience === 'all_doctors') {
        return db.all(
            `SELECT id, email, first_name, last_name FROM users
             WHERE lower(trim(IFNULL(user_role,''))) = 'doctor' AND IFNULL(is_disabled,0) = 0 AND email IS NOT NULL AND trim(email) != ''`,
            [],
            (e, rows) => {
                if (e) return cb(e);
                const out = (rows || [])
                    .map((u) => ({
                        email: normalizeEmail(u.email),
                        name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
                    }))
                    .filter((r) => EMAIL_RE.test(r.email));
                cb(null, out);
            }
        );
    }

    if (audience === 'seminar_paid' || audience === 'seminar_all') {
        if (!Number.isInteger(sid) || sid < 1) return cb(new Error('seminarId is required for this audience'));
        let sql = `SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
                   FROM registrations r
                   JOIN users u ON u.id = r.user_id
                   WHERE r.seminar_id = ? AND r.status NOT IN ('rejected', 'cancelled')`;
        if (audience === 'seminar_paid') {
            sql += ` AND EXISTS (
                SELECT 1 FROM orders o WHERE o.registration_id = r.id AND lower(trim(o.status)) = 'success'
            )`;
        }
        return db.all(sql, [sid], (e, rows) => {
            if (e) return cb(e);
            const out = (rows || [])
                .map((u) => ({
                    email: normalizeEmail(u.email),
                    name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
                }))
                .filter((r) => EMAIL_RE.test(r.email));
            cb(null, out);
        });
    }

  if (audience === 'single_email') {
        const em = normalizeEmail(opts.to || (opts.emails && opts.emails[0]));
        if (!EMAIL_RE.test(em)) return cb(new Error('Valid email address is required'));
        return cb(null, [{ email: em, name: String(opts.name || '').trim() }]);
    }

    return cb(new Error('Unknown audience: ' + audience));
}

function dedupeRecipients(list) {
    const seen = new Set();
    const out = [];
    for (const r of list || []) {
        const em = normalizeEmail(r.email);
        if (!EMAIL_RE.test(em) || seen.has(em)) continue;
        seen.add(em);
        out.push({ email: em, name: r.name || '' });
    }
    return out;
}

/**
 * Send one email immediately.
 */
async function sendSingleMail({ to, name, subject, body, replyTo }) {
    const em = normalizeEmail(to);
    if (!EMAIL_RE.test(em)) return { ok: false, error: 'Invalid email address' };
    if (!isEmailConfigured()) return { ok: false, error: 'Email (SMTP) is not configured in integrations' };
    const sub = String(subject || '').trim();
    const b = String(body || '').trim();
    if (!sub || !b) return { ok: false, error: 'Subject and message are required' };
    const html = wrapHtmlBody(b, name);
    const text = b;
    return sendEmail(em, sub, html, { text, replyTo: replyTo || undefined });
}

/**
 * Queue or send bulk emails.
 * @param {boolean} [useQueue=true] — use notification queue (recommended for bulk)
 */
function sendBulkMail(db, { recipients, subject, body, useQueue = true, eventKey = 'ADMIN_COMPOSE' }, cb) {
    const list = dedupeRecipients(recipients).slice(0, BULK_CAP);
    if (!list.length) return cb(null, { sent: 0, queued: 0, skipped: 0, total: 0 });
    if (!isEmailConfigured()) return cb(new Error('Email (SMTP) is not configured in integrations'));
    const sub = String(subject || '').trim();
    const b = String(body || '').trim();
    if (!sub || !b) return cb(new Error('Subject and message are required'));

    let queued = 0;
    let sent = 0;
    let failed = 0;
    let left = list.length;

    const finish = (err) => {
        if (err) return cb(err);
        if (useQueue) {
            notifEngine.processQueueOnce(db);
        }
        cb(null, { sent, queued, failed, total: list.length });
    };

    list.forEach((r) => {
        const html = wrapHtmlBody(b, r.name);
        const text = b;
        const done = (err, ok) => {
            if (err || (ok && ok.ok === false)) failed++;
            else if (useQueue) queued++;
            else sent++;
            left--;
            if (left === 0) finish();
        };
        if (useQueue) {
            notifEngine.enqueueDirectMessage(
                db,
                {
                    channel: 'email',
                    destination: r.email,
                    subject: sub,
                    html,
                    text,
                    event_key: eventKey
                },
                (e) => done(e, { ok: !e })
            );
        } else {
            sendEmail(r.email, sub, html, { text })
                .then((res) => done(null, res))
                .catch((e) => done(e));
        }
    });
}

function countRecipients(db, opts, cb) {
    resolveRecipients(db, opts, (err, list) => {
        if (err) return cb(err);
        cb(null, { count: dedupeRecipients(list).length });
    });
}

module.exports = {
    sendSingleMail,
    sendBulkMail,
    resolveRecipients,
    countRecipients,
    wrapHtmlBody,
    BULK_CAP
};

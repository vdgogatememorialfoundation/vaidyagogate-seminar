/**
 * Configurable notifications — email (Zoho) + WhatsApp (Meta).
 */
const { sendEmail, isEmailConfigured } = require('./email-service');
const { formatSeminarDateTime } = require('./seminar-datetime');
const { sendWhatsAppTemplate, sendWhatsAppText, isWhatsAppConfigured } = require('./whatsapp-service');
const { DEFAULT_TEMPLATES, EVENT_KEYS } = require('./notification-defaults');

function renderTemplate(str, vars) {
    if (!str) return '';
    return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const v = vars[key];
        return v != null ? String(v) : '';
    });
}

function publicBaseUrl() {
    try {
        return require('./integration-settings').getPublicBaseUrl();
    } catch (_) {
        return (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
    }
}

function doctorPortalUrl() {
    try {
        return require('./portal-urls').portalLoginUrl();
    } catch (_) {
        return publicBaseUrl() + '/doctor.html';
    }
}

function ensureNotificationSchema(db, ignoreErr, next) {
    db.serialize(() => {
        db.run(
            `CREATE TABLE IF NOT EXISTS notification_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL,
                seminar_id INTEGER,
                enabled INTEGER DEFAULT 1,
                channel TEXT DEFAULT 'both',
                email_subject TEXT,
                email_html TEXT,
                whatsapp_template_name TEXT,
                whatsapp_body TEXT,
                version INTEGER DEFAULT 1,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(event_key, seminar_id)
            )`,
            ignoreErr
        );
        db.run(
            `CREATE TABLE IF NOT EXISTS notification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT,
                channel TEXT,
                destination TEXT,
                user_id INTEGER,
                seminar_id INTEGER,
                status TEXT,
                subject TEXT,
                body_preview TEXT,
                error TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`,
            ignoreErr
        );
        db.run(`CREATE INDEX IF NOT EXISTS idx_notif_tpl_event ON notification_templates (event_key, seminar_id)`, ignoreErr);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_logs (created_at DESC)`, ignoreErr);
        db.run(
            `CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`,
            ignoreErr,
            () => {
                seedDefaultTemplates(db, next);
            }
        );
    });
}

function seedDefaultTemplates(db, next) {
    let pending = DEFAULT_TEMPLATES.length;
    if (!pending) return next && next();
    DEFAULT_TEMPLATES.forEach((t) => {
        db.run(
            `INSERT OR IGNORE INTO notification_templates (event_key, seminar_id, enabled, channel, email_subject, email_html, whatsapp_template_name, whatsapp_body)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
            [
                t.event_key,
                t.enabled !== 0 ? 1 : 0,
                t.channel || 'both',
                t.email_subject || '',
                t.email_html || '',
                t.whatsapp_template_name || '',
                t.whatsapp_body || ''
            ],
            () => {
                pending--;
                if (pending === 0 && next) next();
            }
        );
    });
}

/** Push latest global default copy into DB (VGMF 2026 templates). */
function syncDefaultNotificationTemplates(db, cb) {
    let pending = DEFAULT_TEMPLATES.length;
    if (!pending) return cb && cb(null);
    DEFAULT_TEMPLATES.forEach((t) => {
        db.run(
            `UPDATE notification_templates SET enabled = ?, channel = ?, email_subject = ?, email_html = ?,
             whatsapp_template_name = ?, whatsapp_body = ?, updated_at = CURRENT_TIMESTAMP
             WHERE event_key = ? AND seminar_id IS NULL`,
            [
                t.enabled !== 0 ? 1 : 0,
                t.channel || 'both',
                t.email_subject || '',
                t.email_html || '',
                t.whatsapp_template_name || '',
                t.whatsapp_body || '',
                t.event_key
            ],
            function () {
                if (this.changes === 0) {
                    db.run(
                        `INSERT INTO notification_templates (event_key, seminar_id, enabled, channel, email_subject, email_html, whatsapp_template_name, whatsapp_body)
                         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
                        [
                            t.event_key,
                            t.enabled !== 0 ? 1 : 0,
                            t.channel || 'both',
                            t.email_subject || '',
                            t.email_html || '',
                            t.whatsapp_template_name || '',
                            t.whatsapp_body || ''
                        ],
                        () => {
                            pending--;
                            if (pending === 0 && cb) cb(null);
                        }
                    );
                    return;
                }
                pending--;
                if (pending === 0 && cb) cb(null);
            }
        );
    });
}

function loadTemplate(db, eventKey, seminarId, cb) {
    const sid = seminarId != null && !Number.isNaN(parseInt(seminarId, 10)) ? parseInt(seminarId, 10) : null;
    const finish = (row) => {
        if (row) return cb(null, row);
        db.get(
            `SELECT * FROM notification_templates WHERE event_key = ? AND seminar_id IS NULL LIMIT 1`,
            [eventKey],
            (e2, global) => cb(e2, global)
        );
    };
    if (sid) {
        db.get(
            `SELECT * FROM notification_templates WHERE event_key = ? AND seminar_id = ? LIMIT 1`,
            [eventKey, sid],
            (err, row) => {
                if (err) return cb(err);
                finish(row);
            }
        );
    } else {
        finish(null);
    }
}

function buildVarsFromRows(user, seminar, reg, order, extra) {
    const base = publicBaseUrl();
    const first = user && user.first_name ? user.first_name : '';
    const last = user && user.last_name ? user.last_name : '';
    const full = [first, user && user.middle_name, last].filter(Boolean).join(' ').trim();
    const vars = {
        full_name: full || 'Doctor',
        first_name: first || 'Doctor',
        email: (user && user.email) || '',
        phone: (user && user.phone) || '',
        user_id_string: (user && user.user_id_string) || (extra && extra.user_id_string) || '',
        participant_id: (user && user.user_id_string) || (extra && extra.participant_id) || '',
        payment_id: (extra && extra.payment_id) || (order && order.order_id_string) || (order && order.id != null ? String(order.id) : '') || '',
        certificate_id: (extra && extra.certificate_id) || '',
        check_in_time: (extra && extra.check_in_time) || '',
        portal_login_url: doctorPortalUrl(),
        seminar_name: (seminar && seminar.title) || 'VGMF National Seminar',
        seminar_date: seminar && seminar.event_date ? formatSeminarDateTime(seminar.event_date) : '',
        seminar_venue: (seminar && seminar.location_url) || (seminar && seminar.venue) || '',
        ticket_id: (extra && extra.ticket_id) || '',
        qr_code_url: (extra && extra.qr_code_url) || '',
        payment_status: (extra && extra.payment_status) || (order && order.status === 'success' ? 'PAID' : 'PENDING'),
        payment_amount: (extra && extra.payment_amount) != null ? extra.payment_amount : order && order.amount != null ? order.amount : '',
        certificate_url: (extra && extra.certificate_url) || '',
        invoice_url: (extra && extra.invoice_url) || '',
        forgot_password_link: (extra && extra.forgot_password_link) || '',
        temporary_password: (extra && extra.temporary_password) || '',
        case_presentation_title: (extra && extra.case_presentation_title) || '',
        approval_status: (extra && extra.approval_status) || (reg && reg.status) || '',
        rejection_reason: (extra && extra.rejection_reason) || '',
        whatsapp_group_link: (seminar && seminar.whatsapp_group_url) || '',
        admin_contact: process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || process.env.MAIL_FROM || 'info@vaidyagogate.org',
        otp_code: (extra && extra.otp_code) || '',
        announcement_body: (extra && extra.announcement_body) || '',
        verify_link: (extra && extra.verify_link) || ''
    };
    if (reg && reg.application_no) vars.application_no = reg.application_no;
    if (extra && extra.otp_code) vars.otp_code = extra.otp_code;
    return vars;
}

function fetchContext(db, { userId, seminarId, registrationId }, cb) {
    const out = { user: null, seminar: null, reg: null, order: null };
    db.get(`SELECT * FROM users WHERE id = ?`, [userId], (eu, user) => {
        if (eu) return cb(eu);
        out.user = user;
        const loadSem = (next) => {
            if (!seminarId) return next();
            db.get(`SELECT * FROM seminars WHERE id = ?`, [seminarId], (es, sem) => {
                out.seminar = sem;
                next();
            });
        };
        const loadReg = (next) => {
            if (!registrationId) return next();
            db.get(`SELECT * FROM registrations WHERE id = ?`, [registrationId], (er, reg) => {
                out.reg = reg;
                if (reg && !seminarId) seminarId = reg.seminar_id;
                next();
            });
        };
        loadReg(() => {
            loadSem(() => {
                const rid = registrationId || (out.reg && out.reg.id);
                if (!rid) return cb(null, out);
                db.get(
                    `SELECT * FROM orders WHERE registration_id = ? ORDER BY id DESC LIMIT 1`,
                    [rid],
                    (eo, order) => {
                        out.order = order;
                        cb(null, out);
                    }
                );
            });
        });
    });
}

function logNotification(db, row, cb) {
    db.run(
        `INSERT INTO notification_logs (event_key, channel, destination, user_id, seminar_id, status, subject, body_preview, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.event_key,
            row.channel,
            row.destination,
            row.user_id || null,
            row.seminar_id || null,
            row.status,
            row.subject || null,
            (row.body_preview || '').slice(0, 500),
            row.error || null
        ],
        cb
    );
}

function enqueueNotification(db, row, cb) {
    db.run(
        `INSERT INTO notification_queue (channel, destination, template_key, payload, scheduled_at, status, attempts)
         VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
        [
            row.channel,
            row.destination,
            row.event_key,
            JSON.stringify(row.payload || {}),
            row.scheduled_at || new Date().toISOString()
        ],
        cb
    );
}

/** Queue a one-off message (designated staff, venue broadcast, etc.). */
function enqueueDirectMessage(db, { channel, destination, subject, html, text, body, event_key }, cb) {
    const dest = String(destination || '').trim();
    if (!dest) return cb && cb(null);
    const payload =
        channel === 'email'
            ? { subject: subject || 'Notification', html: html || '', text: text || '' }
            : { body: body || text || '', text: body || text || '' };
    enqueueNotification(
        db,
        {
            channel,
            destination: dest,
            event_key: event_key || 'DIRECT_MESSAGE',
            payload,
            scheduled_at: new Date().toISOString()
        },
        cb
    );
}

/**
 * Dispatch notification for an event (queues email/whatsapp).
 */
function notify(db, eventKey, opts, cb) {
    opts = opts || {};
    const userId = opts.userId;
    const seminarId = opts.seminarId;
    const registrationId = opts.registrationId;
    const extra = opts.vars || {};

    loadTemplate(db, eventKey, seminarId, (te, tpl) => {
        if (te) return cb && cb(te);
        if (!tpl || !tpl.enabled) return cb && cb(null, { skipped: true });

        fetchContext(db, { userId, seminarId, registrationId }, (ce, ctx) => {
            if (ce) return cb && cb(ce);
            if (!ctx.user) return cb && cb(null, { skipped: true, reason: 'no user' });

            const vars = buildVarsFromRows(ctx.user, ctx.seminar, ctx.reg, ctx.order, extra);
            const channel = tpl.channel || 'both';
            const subject = renderTemplate(tpl.email_subject, vars);
            const html = renderTemplate(tpl.email_html, vars);
            const waBody = renderTemplate(tpl.whatsapp_body, vars);
            const tasks = [];

            if ((channel === 'email' || channel === 'both') && ctx.user.email) {
                tasks.push({
                    channel: 'email',
                    destination: ctx.user.email,
                    payload: { subject, html, text: waBody.replace(/<[^>]+>/g, ' ') }
                });
            }
            if ((channel === 'whatsapp' || channel === 'both') && ctx.user.phone) {
                const tplName = tpl.whatsapp_template_name && String(tpl.whatsapp_template_name).trim();
                const waPayload = { body: waBody, templateName: tplName || '' };
                if (tplName) {
                    const one = waBody.replace(/\s+/g, ' ').trim().slice(0, 1024);
                    waPayload.bodyParams = one ? [one] : [];
                }
                tasks.push({
                    channel: 'whatsapp',
                    destination: ctx.user.phone,
                    payload: waPayload
                });
            }

            if (!tasks.length) return cb && cb(null, { skipped: true });

            let left = tasks.length;
            tasks.forEach((t) => {
                enqueueNotification(
                    db,
                    {
                        channel: t.channel,
                        destination: t.destination,
                        event_key: eventKey,
                        payload: { ...t.payload, userId, seminarId: seminarId || (ctx.seminar && ctx.seminar.id) },
                        scheduled_at: opts.scheduledAt
                    },
                    () => {
                        left--;
                        if (left === 0) {
                            processQueueOnce(db);
                            cb && cb(null, { queued: true });
                        }
                    }
                );
            });
        });
    });
}

async function deliverQueueRow(db, row) {
    let payload = {};
    try {
        payload = JSON.parse(row.payload || '{}');
    } catch (_) {}
    const eventKey = row.template_key || payload.eventKey || '';
    let ok = false;
    let lastErr = '';

    if (row.channel === 'email') {
        const r = await sendEmail(row.destination, payload.subject || 'Notification', payload.html || payload.text || '', {
            text: payload.text,
            attachments: payload.attachments
        });
        ok = !!r.ok;
        lastErr = r.error || '';
    } else if (row.channel === 'whatsapp') {
        let r;
        if (payload.templateName) {
            let params = payload.bodyParams;
            if (!params || !params.length) {
                const fallback = String(payload.body || payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 1024);
                params = fallback ? [fallback] : [];
            }
            r = await sendWhatsAppTemplate(row.destination, payload.templateName, params);
        } else {
            r = await sendWhatsAppText(row.destination, payload.body || payload.text || '');
        }
        ok = !!r.ok;
        lastErr = r.error || '';
    } else if (row.channel === 'sms') {
        const { sendWhatsAppText: wa } = require('./whatsapp-service');
        const r = await wa(row.destination, payload.sms || payload.text || '');
        ok = !!r.ok;
        lastErr = r.error || '';
    }

    let status = ok ? 'sent' : 'failed';
    if (!ok && lastErr && /not configured|skipped/i.test(lastErr)) status = 'skipped';
    db.run(
        `UPDATE notification_queue SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`,
        [status, ok ? null : lastErr, row.id]
    );
    logNotification(db, {
        event_key: eventKey,
        channel: row.channel,
        destination: row.destination,
        user_id: payload.userId,
        seminar_id: payload.seminarId,
        status,
        subject: payload.subject,
        body_preview: payload.text || payload.body,
        error: ok ? null : lastErr
    });

    return { ok, error: lastErr };
}

function processQueueOnce(db) {
    const now = new Date().toISOString();
    db.all(
        `SELECT * FROM notification_queue WHERE status = 'pending' AND scheduled_at <= ? ORDER BY id ASC LIMIT 30`,
        [now],
        async (err, rows) => {
            if (err || !rows || !rows.length) return;
            for (const row of rows) {
                await deliverQueueRow(db, row);
            }
            db.all(
                `SELECT * FROM notification_queue WHERE status = 'failed' AND attempts < 5 ORDER BY id ASC LIMIT 10`,
                [],
                async (e2, failed) => {
                    if (e2 || !failed) return;
                    for (const row of failed) {
                        db.run(`UPDATE notification_queue SET status = 'pending' WHERE id = ?`, [row.id]);
                    }
                }
            );
        }
    );
}

function loadTemplateAsync(db, eventKey, seminarId) {
    return new Promise((resolve, reject) => {
        loadTemplate(db, eventKey, seminarId, (e, row) => (e ? reject(e) : resolve(row)));
    });
}

/** OTP — immediate delivery (email + WhatsApp, no queue). */
async function sendOtpMessages({ email, phone, code, db, eventKey }) {
    const vars = {
        otp_code: code,
        first_name: 'Participant',
        full_name: 'Participant',
        admin_contact: process.env.ADMIN_CONTACT_EMAIL || process.env.ZOHO_FROM || '',
        seminar_name: require('./notification-defaults').SEMINAR
    };
    const key = eventKey || 'OTP_VERIFICATION';
    const tpl = db ? await loadTemplateAsync(db, key, null).catch(() => null) : null;
    const results = { email: { ok: false, skipped: true }, whatsapp: { ok: false, skipped: true } };

    if (email && isEmailConfigured()) {
        const subject = tpl ? renderTemplate(tpl.email_subject, vars) : 'Your verification code';
        const html = tpl
            ? renderTemplate(tpl.email_html, vars)
            : '<p>Your verification code is <strong>' + code + '</strong></p>';
        results.email = await sendEmail(email, subject, html, { text: 'Your code is ' + code });
    }

    if (phone && isWhatsAppConfigured()) {
        const waBody = tpl
            ? renderTemplate(tpl.whatsapp_body, vars)
            : 'Your verification code is ' + code + '. Valid for a short time.';
        const otpTplName =
            (process.env.WHATSAPP_OTP_TEMPLATE_NAME && String(process.env.WHATSAPP_OTP_TEMPLATE_NAME).trim()) ||
            (tpl && tpl.whatsapp_template_name && String(tpl.whatsapp_template_name).trim()) ||
            '';
        if (otpTplName) {
            const bodyOne = waBody.replace(/\s+/g, ' ').trim().slice(0, 1024);
            results.whatsapp = await sendWhatsAppTemplate(phone, otpTplName, bodyOne ? [bodyOne] : [String(code)]);
        } else {
            results.whatsapp = await sendWhatsAppText(phone, waBody);
        }
    }

    return results;
}

function isMessagingConfigured() {
    return isEmailConfigured() || isWhatsAppConfigured();
}

module.exports = {
    EVENT_KEYS: require('./notification-defaults').EVENT_KEYS,
    ensureNotificationSchema,
    seedDefaultTemplates,
    syncDefaultNotificationTemplates,
    renderTemplate,
    buildVarsFromRows,
    publicBaseUrl,
    loadTemplate,
    notify,
    enqueueDirectMessage,
    processQueueOnce,
    deliverQueueRow,
    logNotification,
    sendOtpMessages,
    isMessagingConfigured,
    isEmailConfigured,
    isWhatsAppConfigured
};

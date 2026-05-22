/**
 * Configurable notifications — email (Zoho) + WhatsApp (Meta).
 */
const { sendEmail, isEmailConfigured } = require('./email-service');
const { formatSeminarDateTime, formatSeminarDateForTicketLine } = require('./seminar-datetime');
const {
    sendWhatsAppTemplate,
    sendWhatsAppOtpTemplate,
    sendWhatsAppText,
    isWhatsAppConfigured
} = require('./whatsapp-service');
const { DEFAULT_TEMPLATES, EVENT_KEYS } = require('./notification-defaults');
const emailDeliveryPolicy = require('./email-delivery-policy');

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
        db.run(`ALTER TABLE notification_logs ADD COLUMN provider_message_id TEXT`, ignoreErr);
        db.run(
            `CREATE INDEX IF NOT EXISTS idx_notif_log_provider_msg ON notification_logs (provider_message_id)`,
            ignoreErr
        );
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
        seminar_date:
            seminar && seminar.event_date ? formatSeminarDateForTicketLine(seminar.event_date) : '',
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
        verify_link: (extra && extra.verify_link) || '',
        ticket_id: (extra && extra.ticket_id) || '',
        ticket_subject: (extra && extra.ticket_subject) || '',
        ticket_message: (extra && extra.ticket_message) || ''
    };
    if (reg && reg.application_no) vars.application_no = reg.application_no;
    if (extra && extra.otp_code) vars.otp_code = extra.otp_code;
    const groupLink = vars.whatsapp_group_link && String(vars.whatsapp_group_link).trim();
    vars.whatsapp_group_line = groupLink
        ? '\n\nJoin the seminar WhatsApp group:\n' + groupLink
        : '';
    return vars;
}

/**
 * One payment confirmation (email + optional WhatsApp) with seminar group link when configured.
 * Does not send a separate e-ticket WhatsApp — use notifyTicketIssued with email only after this.
 */
function wasPaymentSuccessRecentlyNotified(db, { userId, seminarId }, cb) {
    const uid = parseInt(userId, 10);
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(uid) || uid < 1) return cb(null, false);
    const since = new Date(Date.now() - WA_DEDUP_MINUTES * 60000).toISOString();
    const params = [uid, since];
    let sql = `SELECT 1 AS ok FROM notification_logs
         WHERE event_key = 'PAYMENT_SUCCESS' AND user_id = ? AND status = 'sent' AND created_at >= ?`;
    if (Number.isInteger(sid) && sid > 0) {
        sql += ` AND seminar_id = ?`;
        params.push(sid);
    }
    sql += ` LIMIT 1`;
    db.get(sql, params, (e, row) => cb(e, !!(row && row.ok)));
}

function notifyRegistrationPaid(db, opts, cb) {
    opts = opts || {};
    const userId = opts.userId;
    const seminarId = opts.seminarId;
    const registrationId = opts.registrationId;
    const extra = opts.vars || {};
    fetchContext(db, { userId, seminarId, registrationId }, (ce, ctx) => {
        if (ce) return cb && cb(ce);
        if (!ctx.user) return cb && cb(null, { skipped: true });
        const sid = seminarId || (ctx.seminar && ctx.seminar.id) || (ctx.reg && ctx.reg.seminar_id);
        return wasPaymentSuccessRecentlyNotified(db, { userId, seminarId: sid }, (eDupAll, dupAll) => {
            if (eDupAll) return cb && cb(eDupAll);
            if (dupAll) return cb && cb(null, { skipped: true, reason: 'payment_success_already_sent' });
        const finish = () => {
            notify(
                db,
                'PAYMENT_SUCCESS',
                {
                    userId,
                    seminarId: sid,
                    registrationId,
                    vars: extra,
                    immediate: opts.immediate === true
                },
                cb
            );
        };
        if (ctx.user.phone) {
            return wasWhatsAppEventRecentlySent(
                db,
                { eventKey: 'PAYMENT_SUCCESS', destination: ctx.user.phone, userId },
                (eDup, dup) => {
                    if (eDup) return cb && cb(eDup);
                    if (dup) {
                        return notify(
                            db,
                            'PAYMENT_SUCCESS',
                            {
                                userId,
                                seminarId: sid,
                                registrationId,
                                vars: extra,
                                immediate: opts.immediate === true,
                                skipWhatsapp: true
                            },
                            cb
                        );
                    }
                    finish();
                }
            );
        }
        if (ctx.seminar && ctx.seminar.whatsapp_group_url) {
            return finish();
        }
        if (!sid) return finish();
        db.get(`SELECT whatsapp_group_url FROM seminars WHERE id = ?`, [sid], (e, sem) => {
            if (!e && sem && sem.whatsapp_group_url) {
                ctx.seminar = Object.assign({}, ctx.seminar || {}, { whatsapp_group_url: sem.whatsapp_group_url });
            }
            finish();
        });
        });
    });
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

const WA_DEDUP_MINUTES = Math.max(5, parseInt(process.env.NOTIF_WA_DEDUP_MINUTES || '30', 10) || 30);
const WA_BURST_WINDOW_MIN = Math.max(10, parseInt(process.env.NOTIF_WA_BURST_WINDOW_MIN || '60', 10) || 60);
const WA_BURST_MAX = Math.max(1, parseInt(process.env.NOTIF_WA_BURST_MAX || '2', 10) || 2);
const WA_BURST_EVENTS = new Set([
    'SEMINAR_REGISTRATION_SUCCESS',
    'APPLICATION_UNDER_REVIEW',
    'APPLICATION_APPROVED',
    'APPLICATION_REVISION_REQUIRED',
    'PAYMENT_SUCCESS',
    'PAYMENT_PENDING',
    'TICKET_ISSUED',
    'WHATSAPP_GROUP_INVITE'
]);

function normalizeLogDestination(channel, destination) {
    if (channel !== 'whatsapp') return String(destination || '').trim().toLowerCase();
    try {
        const { normalizePhoneE164 } = require('./whatsapp-service');
        return normalizePhoneE164(destination) || String(destination || '').trim();
    } catch (_) {
        return String(destination || '').trim();
    }
}

/** Skip duplicate WhatsApp for the same event to the same phone within NOTIF_WA_DEDUP_MINUTES. */
function wasWhatsAppEventRecentlySent(db, { eventKey, destination, userId }, cb) {
    const dest = normalizeLogDestination('whatsapp', destination);
    if (!dest || !eventKey) return cb(null, false);
    const since = new Date(Date.now() - WA_DEDUP_MINUTES * 60000).toISOString();
    db.get(
        `SELECT 1 AS ok FROM notification_logs
         WHERE channel = 'whatsapp' AND status = 'sent' AND event_key = ? AND destination = ? AND created_at >= ?
         LIMIT 1`,
        [eventKey, dest, since],
        (e, row) => cb(e, !!(row && row.ok))
    );
}

/** Cap lifecycle WhatsApp bursts (submit + approve + pay) per phone per hour. */
function isWhatsAppBurstThrottled(db, { destination, eventKey }, cb) {
    if (!WA_BURST_EVENTS.has(eventKey)) return cb(null, false);
    const dest = normalizeLogDestination('whatsapp', destination);
    if (!dest) return cb(null, false);
    const since = new Date(Date.now() - WA_BURST_WINDOW_MIN * 60000).toISOString();
    const keys = Array.from(WA_BURST_EVENTS);
    const placeholders = keys.map(() => '?').join(',');
    db.get(
        `SELECT COUNT(*) AS c FROM notification_logs
         WHERE channel = 'whatsapp' AND status = 'sent' AND destination = ? AND created_at >= ?
         AND event_key IN (${placeholders})`,
        [dest, since, ...keys],
        (e, row) => {
            if (e) return cb(e);
            cb(null, (row && row.c) >= WA_BURST_MAX);
        }
    );
}

function isWhatsAppPendingInQueue(db, { eventKey, destination }, cb) {
    const dest = normalizeLogDestination('whatsapp', destination);
    if (!dest || !eventKey) return cb(null, false);
    const since = new Date(Date.now() - WA_DEDUP_MINUTES * 60000).toISOString();
    db.get(
        `SELECT 1 AS ok FROM notification_queue
         WHERE channel = 'whatsapp' AND template_key = ? AND destination = ?
         AND status IN ('pending', 'processing') AND scheduled_at >= ?
         LIMIT 1`,
        [eventKey, dest, since],
        (e, row) => cb(e, !!(row && row.ok))
    );
}

function wasSameWhatsAppBodyRecentlySent(db, destination, body) {
    const dest = normalizeLogDestination('whatsapp', destination);
    const snippet = String(body || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 72);
    if (!dest || snippet.length < 24) return false;
    const since = new Date(Date.now() - WA_DEDUP_MINUTES * 60000).toISOString();
    return new Promise((resolve) => {
        db.get(
            `SELECT 1 AS ok FROM notification_logs
             WHERE channel = 'whatsapp' AND status = 'sent' AND destination = ?
             AND created_at >= ? AND substr(IFNULL(body_preview,''), 1, 72) = ?
             LIMIT 1`,
            [dest, since, snippet],
            (e, row) => resolve(!!(row && row.ok))
        );
    });
}

function shouldSkipWhatsAppEnqueue(db, { eventKey, destination, userId, body }, cb) {
    wasWhatsAppEventRecentlySent(db, { eventKey, destination, userId }, (e1, dup) => {
        if (e1) return cb(e1, true);
        if (dup) return cb(null, true);
        isWhatsAppPendingInQueue(db, { eventKey, destination }, (e2, queued) => {
            if (e2) return cb(e2, true);
            if (queued) return cb(null, true);
            isWhatsAppBurstThrottled(db, { destination, eventKey }, (e3, burst) => {
                if (e3 || burst) return cb(e3, burst);
                wasSameWhatsAppBodyRecentlySent(db, destination, body).then((sameBody) => cb(null, sameBody));
            });
        });
    });
}

function claimQueueRow(db, rowId) {
    return new Promise((resolve) => {
        db.run(
            `UPDATE notification_queue SET status = 'processing' WHERE id = ? AND status = 'pending'`,
            [rowId],
            function (err) {
                resolve(!err && this.changes === 1);
            }
        );
    });
}

function logNotification(db, row, cb) {
    let dest = row.destination;
    if (row.channel === 'whatsapp' && dest) {
        try {
            const { normalizePhoneE164 } = require('./whatsapp-service');
            dest = normalizePhoneE164(dest) || dest;
        } catch (_) {}
    }
    const providerMessageId = row.provider_message_id || row.messageId || null;
    db.run(
        `INSERT INTO notification_logs (event_key, channel, destination, user_id, seminar_id, status, subject, body_preview, error, provider_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.event_key,
            row.channel,
            dest,
            row.user_id || null,
            row.seminar_id || null,
            row.status,
            row.subject || null,
            (row.body_preview || '').slice(0, 500),
            row.error || null,
            providerMessageId
        ],
        cb
    );
}

function enqueueNotificationRaw(db, row, cb) {
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

function enqueueNotification(db, row, cb) {
    if (row.channel !== 'whatsapp') {
        return enqueueNotificationRaw(db, row, cb);
    }
    const dest = normalizeLogDestination('whatsapp', row.destination);
    let payload = {};
    try {
        payload = JSON.parse(row.payload || '{}');
    } catch (_) {}
    const body = payload.body || payload.text || '';
    shouldSkipWhatsAppEnqueue(
        db,
        { eventKey: row.event_key, destination: dest, userId: payload.userId, body },
        (eSkip, skip) => {
            if (eSkip) return cb && cb(eSkip);
            if (skip) return cb && cb(null);
            enqueueNotificationRaw(db, { ...row, destination: dest }, cb);
        }
    );
}

/** Queue a one-off message (designated staff, venue broadcast, etc.). */
function drainNotificationQueue(db, maxRounds) {
    const limit = maxRounds == null ? 5 : Math.max(1, maxRounds);
    const now = new Date().toISOString();
    return new Promise((resolve) => {
        let round = 0;
        const step = () => {
            db.all(
                `SELECT * FROM notification_queue WHERE status = 'pending' AND scheduled_at <= ? ORDER BY id ASC LIMIT 30`,
                [now],
                async (err, rows) => {
                    if (err || !rows || !rows.length) return resolve();
                    for (const row of rows) {
                        await deliverQueueRow(db, row);
                    }
                    round++;
                    if (round < limit) return step();
                    resolve();
                }
            );
        };
        step();
    });
}

function enqueueDirectMessage(db, { channel, destination, subject, html, text, body, event_key, immediate, replyTo, userId }, cb) {
    const dest = String(destination || '').trim();
    if (!dest) return cb && cb(null);
    const evKey = event_key || 'DIRECT_MESSAGE';
    const finishEnqueue = () => {
    const payload =
        channel === 'email'
            ? { subject: subject || 'Notification', html: html || '', text: text || '' }
            : { body: body || text || '', text: body || text || '' };
    if (replyTo && channel === 'email') payload.replyTo = replyTo;
    enqueueNotification(
        db,
        {
            channel,
            destination: dest,
            event_key: evKey,
            payload,
            scheduled_at: new Date().toISOString()
        },
        () => {
            const done = () => {
                if (cb) cb();
            };
            if (immediate) {
                emailDeliveryPolicy.loadConfig(db, (eCfg, cfg) => {
                    const runNow = !emailDeliveryPolicy.shouldDeferImmediateEmail(cfg);
                    if (runNow) {
                        drainNotificationQueue(db, 1).then(done).catch(() => done());
                    } else {
                        done();
                    }
                });
                return;
            }
            try {
                processQueueOnce(db);
            } catch (_) {}
            done();
        }
    );
    };
    if (channel === 'whatsapp') {
        const waBody = body || text || '';
        return shouldSkipWhatsAppEnqueue(db, { eventKey: evKey, destination: dest, userId, body: waBody }, (eSkip, skip) => {
            if (eSkip) return cb && cb(eSkip);
            if (skip) return cb && cb(null, { skipped: true, reason: 'whatsapp_deduped' });
            finishEnqueue();
        });
    }
    finishEnqueue();
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
                const emailPayload = { subject, html, text: waBody.replace(/<[^>]+>/g, ' ') };
                if (opts.emailExtras && opts.emailExtras.replyTo) emailPayload.replyTo = opts.emailExtras.replyTo;
                tasks.push({
                    channel: 'email',
                    destination: ctx.user.email,
                    payload: emailPayload
                });
            }
            const queueTasks = (list) => {
                if (!list.length) return cb && cb(null, { skipped: true });
                let left = list.length;
                list.forEach((t) => {
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
                            const finishNotify = () => cb && cb(null, { queued: true });
                            if (opts.immediate === true) {
                                drainNotificationQueue(db, 1).then(finishNotify).catch(finishNotify);
                            } else {
                                processQueueOnce(db);
                                finishNotify();
                            }
                        }
                    }
                );
                });
            };

            if (
                !opts.skipWhatsapp &&
                (channel === 'whatsapp' || channel === 'both') &&
                ctx.user.phone
            ) {
                const tplName = tpl.whatsapp_template_name && String(tpl.whatsapp_template_name).trim();
                const integrationSettings = require('./integration-settings');
                const waPayload = {
                    body: waBody,
                    templateName: tplName || '',
                    templateLang: integrationSettings.getEventWhatsAppTemplateLang(eventKey),
                    vars,
                    eventKey
                };
                return shouldSkipWhatsAppEnqueue(
                    db,
                    { eventKey, destination: ctx.user.phone, userId, body: waBody },
                    (eSkip, skip) => {
                        if (eSkip) return cb && cb(eSkip);
                        if (skip) {
                            return queueTasks(tasks);
                        }
                        tasks.push({
                            channel: 'whatsapp',
                            destination: ctx.user.phone,
                            payload: waPayload
                        });
                        queueTasks(tasks);
                    }
                );
            }

            queueTasks(tasks);
        });
    });
}

async function deliverQueueRow(db, row) {
    const claimed = await claimQueueRow(db, row.id);
    if (!claimed) {
        return { ok: true, skipped: true, reason: 'already_processing_or_sent' };
    }
    let payload = {};
    try {
        payload = JSON.parse(row.payload || '{}');
    } catch (_) {}
    const eventKey = row.template_key || payload.eventKey || '';
    let ok = false;
    let lastErr = '';

    if (row.channel === 'email') {
        const gate = await new Promise((resolve) => {
            emailDeliveryPolicy.checkEmailSendAllowed(
                db,
                { hasAttachment: !!(payload.attachments && payload.attachments.length) },
                (eGate, allowed) => {
                    if (eGate) return resolve({ allowed: true });
                    resolve(allowed || { allowed: true });
                }
            );
        });
        if (!gate.allowed) {
            await new Promise((res) =>
                emailDeliveryPolicy.deferQueueRow(
                    db,
                    row.id,
                    gate.deferMinutes || 30,
                    gate.reason || 'throttled',
                    res
                )
            );
            return { ok: false, deferred: true, reason: gate.reason };
        }
        const r = await sendEmail(row.destination, payload.subject || 'Notification', payload.html || payload.text || '', {
            text: payload.text,
            attachments: payload.attachments,
            replyTo: payload.replyTo
        });
        ok = !!r.ok;
        lastErr = r.error || '';
        if (!ok && emailDeliveryPolicy.isRateLimitSmtpError(lastErr)) {
            const deferMin =
                (gate.cfg && gate.cfg.deferMinutesOnRateLimit) ||
                (await new Promise((res) => {
                    emailDeliveryPolicy.loadConfig(db, (e, cfg) => res((cfg && cfg.deferMinutesOnRateLimit) || 45));
                }));
            await new Promise((res) => emailDeliveryPolicy.deferQueueRow(db, row.id, deferMin, lastErr, res));
            return { ok: false, deferred: true, reason: 'rate_limit' };
        }
    } else if (row.channel === 'whatsapp') {
        const { resolveTemplateBodyParams } = require('./whatsapp-service');
        let r;
        if (payload.templateName) {
            const params = await resolveTemplateBodyParams(
                payload.templateName,
                payload.body || payload.text || '',
                payload.vars || {},
                payload.bodyParams
            );
            r = await sendWhatsAppTemplate(row.destination, payload.templateName, params, {
                lang: payload.templateLang
            });
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

    if (lastErr && emailDeliveryPolicy.isRateLimitSmtpError(lastErr)) {
        return { ok: false, deferred: true, reason: 'rate_limit' };
    }

    let status = ok ? 'sent' : 'failed';
    if (!ok && lastErr && /not configured|skipped/i.test(lastErr)) status = 'skipped';
    db.run(
        `UPDATE notification_queue SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`,
        [status, ok ? null : lastErr, row.id]
    );
    const logDest =
        row.channel === 'whatsapp'
            ? normalizeLogDestination('whatsapp', row.destination)
            : row.destination;
    logNotification(db, {
        event_key: eventKey,
        channel: row.channel,
        destination: logDest,
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
    const staleProcessing = new Date(Date.now() - 15 * 60000).toISOString();
    db.run(
        `UPDATE notification_queue SET status = 'pending' WHERE status = 'processing' AND scheduled_at < ?`,
        [staleProcessing],
        () => {}
    );
    db.all(
        `SELECT * FROM notification_queue WHERE status = 'pending' AND scheduled_at <= ? ORDER BY id ASC LIMIT 30`,
        [now],
        async (err, rows) => {
            if (err || !rows || !rows.length) return;
            for (const row of rows) {
                await deliverQueueRow(db, row);
            }
            db.all(
                `SELECT * FROM notification_queue WHERE status = 'failed' AND attempts < 3 AND channel != 'whatsapp' ORDER BY id ASC LIMIT 10`,
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
        const otpTplName = db ? await getOtpWhatsAppTemplateName(db) : '';
        if (otpTplName) {
            results.whatsapp = await sendWhatsAppOtpTemplate(phone, otpTplName, String(code));
            if (!results.whatsapp.ok) {
                const fallback = await sendWhatsAppTemplate(phone, otpTplName, [String(code)]);
                if (fallback.ok) results.whatsapp = fallback;
            }
        } else {
            results.whatsapp = await sendWhatsAppText(phone, waBody);
        }
    }

    return results;
}

function isMessagingConfigured() {
    return isEmailConfigured() || isWhatsAppConfigured();
}

async function getOtpWhatsAppTemplateName(db) {
    const { sanitizeWhatsAppTemplateName } = require('./whatsapp-service');
    let fromIntegration = '';
    let fromDb = '';
    let fromEnv = '';
    try {
        const rt = require('./integration-settings').getRuntimeIntegrations();
        if (rt.whatsapp_otp_template_name) {
            fromIntegration = String(rt.whatsapp_otp_template_name).trim();
        }
    } catch (_) {}
    if (db) {
        const tpl = await loadTemplateAsync(db, 'OTP_VERIFICATION', null).catch(() => null);
        if (tpl && tpl.whatsapp_template_name) {
            fromDb = String(tpl.whatsapp_template_name).trim();
        }
    }
    if (process.env.WHATSAPP_OTP_TEMPLATE_NAME) {
        fromEnv = String(process.env.WHATSAPP_OTP_TEMPLATE_NAME).trim();
    }
    const name = fromIntegration || fromDb || fromEnv;
    return sanitizeWhatsAppTemplateName(name);
}

async function getOtpWhatsAppTemplateDebug(db) {
    const { sanitizeWhatsAppTemplateName } = require('./whatsapp-service');
    let source = 'none';
    let raw = '';
    try {
        const rt = require('./integration-settings').getRuntimeIntegrations();
        if (rt.whatsapp_otp_template_name) {
            raw = String(rt.whatsapp_otp_template_name).trim();
            source = 'integrations';
        }
    } catch (_) {}
    if (!raw && db) {
        const tpl = await loadTemplateAsync(db, 'OTP_VERIFICATION', null).catch(() => null);
        if (tpl && tpl.whatsapp_template_name) {
            raw = String(tpl.whatsapp_template_name).trim();
            source = 'OTP_VERIFICATION row';
        }
    }
    if (!raw && process.env.WHATSAPP_OTP_TEMPLATE_NAME) {
        raw = String(process.env.WHATSAPP_OTP_TEMPLATE_NAME).trim();
        source = 'WHATSAPP_OTP_TEMPLATE_NAME env';
    }
    const resolved = sanitizeWhatsAppTemplateName(raw);
    return { source, raw, resolved, lang: require('./integration-settings').getWhatsAppConfig().templateLang || 'en' };
}

function syncOtpNotificationDefaults(db, payload, cb) {
    if (!db) return cb && cb();
    const { sanitizeWhatsAppTemplateName } = require('./whatsapp-service');
    const waTpl =
        payload && payload.whatsapp_otp_template_name
            ? sanitizeWhatsAppTemplateName(payload.whatsapp_otp_template_name)
            : '';
    const emailSub =
        payload && payload.otp_email_subject ? String(payload.otp_email_subject).trim() : '';
    if (!waTpl && !emailSub) return cb && cb();
    db.get(
        `SELECT id FROM notification_templates WHERE event_key = 'OTP_VERIFICATION' AND seminar_id IS NULL`,
        [],
        (e, row) => {
            if (e) return cb && cb(e);
            const apply = (id) => {
                const sets = [];
                const params = [];
                if (waTpl) {
                    sets.push('whatsapp_template_name = ?');
                    params.push(waTpl);
                }
                if (emailSub) {
                    sets.push('email_subject = ?');
                    params.push(emailSub);
                }
                if (!sets.length) return cb && cb();
                sets.push('updated_at = CURRENT_TIMESTAMP');
                params.push(id);
                db.run(
                    `UPDATE notification_templates SET ${sets.join(', ')} WHERE id = ?`,
                    params,
                    (uerr) => cb && cb(uerr)
                );
            };
            if (row && row.id) return apply(row.id);
            db.run(
                `INSERT INTO notification_templates (event_key, seminar_id, enabled, channel, email_subject, whatsapp_template_name)
                 VALUES ('OTP_VERIFICATION', NULL, 1, 'both', ?, ?)`,
                [emailSub || 'Verify Your Email', waTpl || null],
                function (ierr) {
                    if (ierr) return cb && cb(ierr);
                    apply(this.lastID);
                }
            );
        }
    );
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
    notifyRegistrationPaid,
    enqueueDirectMessage,
    processQueueOnce,
    drainNotificationQueue,
    deliverQueueRow,
    logNotification,
    sendOtpMessages,
    getOtpWhatsAppTemplateName,
    getOtpWhatsAppTemplateDebug,
    syncOtpNotificationDefaults,
    isMessagingConfigured,
    isEmailConfigured,
    isWhatsAppConfigured
};

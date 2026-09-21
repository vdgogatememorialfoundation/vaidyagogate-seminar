/**
 * Central WhatsApp communication service.
 *
 * Every WhatsApp message (except the legacy OTP + notification-engine paths, which keep
 * working unchanged) goes through `send()` here so that logging, opt-out checks, rate
 * limiting, retries and delivery-status updates live in exactly one place.
 *
 * Campaigns are rows in wa_campaigns + wa_campaign_recipients; a background worker
 * (`tick`) drains recipients in rate-limited batches.
 */
const waSvc = require('./whatsapp-service');
const integrationSettings = require('./integration-settings');

const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'cancel', 'quit', 'end'];
const OPT_IN_WORDS = ['start', 'subscribe', 'optin', 'opt in', 'unstop', 'resume'];

const SETTING_DEFAULTS = {
    rate_per_second: 8,
    campaign_batch_size: 25,
    max_retries: 3,
    retry_delay_seconds: 120,
    campaigns_enabled: 1,
    quiet_start: '',
    quiet_end: '',
    opt_out_enabled: 1,
    opt_out_reply: 'You have been unsubscribed from WhatsApp updates. Reply START to subscribe again.',
    opt_in_reply: 'You are subscribed to WhatsApp updates from Vaidya Gogate Memorial Foundation.',
    flow_private_key: '',
    flow_private_key_passphrase: '',
    default_template_lang: ''
};

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS wa_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS wa_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        meta_name TEXT NOT NULL,
        meta_id TEXT,
        language TEXT DEFAULT 'en',
        category TEXT,
        status TEXT,
        header_type TEXT,
        body_text TEXT,
        variable_count INTEGER DEFAULT 0,
        variables_json TEXT,
        is_active INTEGER DEFAULT 1,
        synced_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meta_name, language)
    )`,
    `CREATE TABLE IF NOT EXISTS wa_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        campaign_type TEXT DEFAULT 'custom',
        source TEXT DEFAULT 'event',
        seminar_id INTEGER,
        day_id INTEGER,
        audience_filter TEXT,
        audience_json TEXT,
        per_ticket INTEGER DEFAULT 0,
        message_kind TEXT DEFAULT 'template',
        template_id INTEGER,
        template_name TEXT,
        template_lang TEXT,
        body_text TEXT,
        media_url TEXT,
        media_type TEXT,
        media_filename TEXT,
        media_caption TEXT,
        variable_map_json TEXT,
        status TEXT DEFAULT 'draft',
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        delivered_count INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        scheduled_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_by INTEGER,
        confirmed_by INTEGER,
        confirmed_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS wa_campaign_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        user_id INTEGER,
        registration_id INTEGER,
        ticket_id INTEGER,
        phone TEXT NOT NULL,
        name TEXT,
        vars_json TEXT,
        status TEXT DEFAULT 'pending',
        provider_message_id TEXT,
        error TEXT,
        attempts INTEGER DEFAULT 0,
        next_attempt_at TEXT,
        sent_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_recip_campaign ON wa_campaign_recipients (campaign_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_recip_msg ON wa_campaign_recipients (provider_message_id)`,
    `CREATE TABLE IF NOT EXISTS wa_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_message_id TEXT,
        direction TEXT DEFAULT 'out',
        campaign_id INTEGER,
        recipient_id INTEGER,
        user_id INTEGER,
        registration_id INTEGER,
        seminar_id INTEGER,
        phone TEXT,
        message_type TEXT,
        template_name TEXT,
        preview TEXT,
        status TEXT,
        error TEXT,
        sent_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        failed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_msg_provider ON wa_messages (provider_message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_msg_created ON wa_messages (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages (phone)`,
    `CREATE TABLE IF NOT EXISTS wa_contacts (
        phone TEXT PRIMARY KEY,
        name TEXT,
        opted_out INTEGER DEFAULT 0,
        opted_out_at TEXT,
        opted_in_at TEXT,
        opt_source TEXT,
        last_inbound_at TEXT,
        last_inbound_text TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS wa_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        meta_flow_id TEXT,
        purpose TEXT DEFAULT 'registration',
        seminar_id INTEGER,
        first_screen TEXT,
        cta_text TEXT,
        body_text TEXT,
        header_text TEXT,
        config_json TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS wa_flow_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_token TEXT UNIQUE,
        flow_id INTEGER,
        meta_flow_id TEXT,
        phone TEXT,
        user_id INTEGER,
        registration_id INTEGER,
        seminar_id INTEGER,
        last_screen TEXT,
        last_action TEXT,
        data_json TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
];

let schemaDone = null;
function ensureSchema(db, cb) {
    if (schemaDone) return schemaDone.then(() => cb && cb());
    schemaDone = new Promise((resolve) => {
        let i = 0;
        const next = () => {
            if (i >= SCHEMA.length) return resolve();
            const sql = SCHEMA[i++];
            db.run(sql, (e) => {
                if (e && !/already exists/i.test(String(e.message))) console.warn('[wa-central] schema', e.message);
                next();
            });
        };
        next();
    });
    schemaDone.then(() => cb && cb());
}

/* ------------------------------------------------------------------ settings */

const settingsCache = { at: 0, map: null };
function loadSettings(db, cb) {
    if (settingsCache.map && Date.now() - settingsCache.at < 15000) return cb(null, settingsCache.map);
    db.all(`SELECT key, value FROM wa_settings`, [], (e, rows) => {
        if (e) return cb(e);
        const map = { ...SETTING_DEFAULTS };
        (rows || []).forEach((r) => {
            if (r.key in SETTING_DEFAULTS) {
                map[r.key] = typeof SETTING_DEFAULTS[r.key] === 'number' ? Number(r.value) : String(r.value || '');
            }
        });
        if (!map.default_template_lang) map.default_template_lang = integrationSettings.getWhatsAppConfig().templateLang || 'en';
        settingsCache.at = Date.now();
        settingsCache.map = map;
        cb(null, map);
    });
}

function saveSettings(db, patch, cb) {
    const keys = Object.keys(patch || {}).filter((k) => k in SETTING_DEFAULTS);
    let pending = keys.length;
    if (!pending) return cb(null);
    let err = null;
    keys.forEach((k) => {
        const v = patch[k] == null ? '' : String(patch[k]);
        db.run(`DELETE FROM wa_settings WHERE key = ?`, [k], () => {
            db.run(`INSERT INTO wa_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [k, v], (e) => {
                if (e) err = e;
                if (--pending === 0) {
                    settingsCache.map = null;
                    cb(err);
                }
            });
        });
    });
}

function publicSettings(map) {
    const out = { ...map };
    out.flow_private_key_set = !!String(map.flow_private_key || '').trim();
    delete out.flow_private_key;
    delete out.flow_private_key_passphrase;
    return out;
}

/* ------------------------------------------------------------- rate limiter */

const bucket = { tokens: 0, at: Date.now(), rate: 8 };
function takeToken(rate) {
    const now = Date.now();
    const r = Math.max(1, Number(rate) || 8);
    bucket.tokens = Math.min(r, bucket.tokens + ((now - bucket.at) / 1000) * r);
    bucket.at = now;
    bucket.rate = r;
    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return 0;
    }
    return Math.ceil(((1 - bucket.tokens) / r) * 1000);
}
async function waitForToken(rate) {
    for (;;) {
        const ms = takeToken(rate);
        if (!ms) return;
        await new Promise((r) => setTimeout(r, ms));
    }
}

/* ---------------------------------------------------------------- contacts */

function isOptedOut(db, phone, cb) {
    const p = waSvc.normalizePhoneE164(phone);
    if (!p) return cb(null, false);
    db.get(`SELECT opted_out FROM wa_contacts WHERE phone = ?`, [p], (e, row) => {
        if (e) return cb(e);
        cb(null, !!(row && Number(row.opted_out) === 1));
    });
}

function setOptStatus(db, phone, optedOut, source, cb) {
    const p = waSvc.normalizePhoneE164(phone);
    if (!p) return cb && cb(new Error('Invalid phone'));
    db.get(`SELECT phone FROM wa_contacts WHERE phone = ?`, [p], (e, row) => {
        if (e) return cb && cb(e);
        const col = optedOut ? 'opted_out_at' : 'opted_in_at';
        if (row) {
            db.run(
                `UPDATE wa_contacts SET opted_out = ?, ${col} = CURRENT_TIMESTAMP, opt_source = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`,
                [optedOut ? 1 : 0, source || 'admin', p],
                (e2) => cb && cb(e2)
            );
        } else {
            db.run(
                `INSERT INTO wa_contacts (phone, opted_out, ${col}, opt_source) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`,
                [p, optedOut ? 1 : 0, source || 'admin'],
                (e2) => cb && cb(e2)
            );
        }
    });
}

function recordInbound(db, phone, text, name, cb) {
    const p = waSvc.normalizePhoneE164(phone);
    if (!p) return cb && cb();
    const t = String(text || '').slice(0, 500);
    db.get(`SELECT phone FROM wa_contacts WHERE phone = ?`, [p], (e, row) => {
        const done = () => cb && cb();
        if (row) {
            const nm = String(name || '').trim();
            db.run(
                nm
                    ? `UPDATE wa_contacts SET last_inbound_at = CURRENT_TIMESTAMP, last_inbound_text = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`
                    : `UPDATE wa_contacts SET last_inbound_at = CURRENT_TIMESTAMP, last_inbound_text = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`,
                nm ? [t, nm, p] : [t, p],
                done
            );
        } else {
            db.run(
                `INSERT INTO wa_contacts (phone, name, last_inbound_at, last_inbound_text) VALUES (?, ?, CURRENT_TIMESTAMP, ?)`,
                [p, name || null, t],
                done
            );
        }
    });
}

function classifyKeyword(text) {
    const s = String(text || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (!s || s.length > 20) return null;
    if (OPT_OUT_WORDS.includes(s)) return 'out';
    if (OPT_IN_WORDS.includes(s)) return 'in';
    return null;
}

/* --------------------------------------------------------------- messaging */

function logMessage(db, row, cb) {
    db.run(
        `INSERT INTO wa_messages (provider_message_id, direction, campaign_id, recipient_id, user_id, registration_id, seminar_id,
             phone, message_type, template_name, preview, status, error, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.providerMessageId || null,
            row.direction || 'out',
            row.campaignId || null,
            row.recipientId || null,
            row.userId || null,
            row.registrationId || null,
            row.seminarId || null,
            row.phone || null,
            row.messageType || null,
            row.templateName || null,
            String(row.preview || '').slice(0, 500),
            row.status || null,
            row.error ? String(row.error).slice(0, 1000) : null,
            row.status === 'sent' || row.status === 'accepted' ? new Date().toISOString() : null
        ],
        function (e) {
            if (e) console.warn('[wa-central] log', e.message);
            cb && cb(e, this && this.lastID);
        }
    );
}

function renderTemplateString(str, vars) {
    return String(str || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, k) => {
        const v = vars && vars[k];
        return v == null ? '' : String(v);
    });
}

/** Ordered body params from a variables definition (array of var keys or {{n}} mapping). */
function buildParamsFromMapping(mapping, vars, count) {
    const out = [];
    const n = Math.max(0, Number(count) || (Array.isArray(mapping) ? mapping.length : 0));
    for (let i = 0; i < n; i++) {
        const key = Array.isArray(mapping) ? mapping[i] : mapping && mapping[String(i + 1)];
        let v = '';
        if (key != null && key !== '') {
            v = /\{\{/.test(String(key)) ? renderTemplateString(key, vars) : vars && vars[key] != null ? vars[key] : key;
        }
        v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        out.push(v || '-');
    }
    return out;
}

/**
 * Unified send. msg = {
 *   kind: 'template'|'text'|'media'|'document'|'flow',
 *   phone, templateName, lang, params (array) | mapping + vars, headerMediaUrl,
 *   body, mediaUrl, mediaType, filename, caption,
 *   flow: { flowId, flowToken, cta, body, firstScreen, data },
 *   meta: { campaignId, recipientId, userId, registrationId, seminarId, messageType, bypassOptOut }
 * }
 */
function send(db, msg, cb) {
    ensureSchema(db, () => {
        const m = msg || {};
        const meta = m.meta || {};
        const phone = waSvc.normalizePhoneE164(m.phone);
        const finish = (result, statusOverride) => {
            const status = statusOverride || (result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed');
            logMessage(
                db,
                {
                    providerMessageId: result.messageId || null,
                    campaignId: meta.campaignId,
                    recipientId: meta.recipientId,
                    userId: meta.userId,
                    registrationId: meta.registrationId,
                    seminarId: meta.seminarId,
                    phone,
                    messageType: meta.messageType || m.kind || 'custom',
                    templateName: m.templateName || null,
                    preview: m.kind === 'template' ? (m.params || []).join(' | ') : m.body || m.mediaUrl || '',
                    status,
                    error: result.error || null
                },
                (e, logId) => cb && cb(null, { ...result, status, logId })
            );
        };
        if (!phone) return finish({ ok: false, error: 'Invalid phone number' });
        if (!waSvc.isWhatsAppConfigured()) return finish({ ok: false, skipped: true, error: 'WhatsApp not configured' });
        loadSettings(db, (eS, settings) => {
            const s = settings || SETTING_DEFAULTS;
            const proceed = async () => {
                await waitForToken(s.rate_per_second);
                try {
                    const kind = String(m.kind || 'template');
                    if (kind === 'template') {
                        const params = Array.isArray(m.params)
                            ? m.params
                            : buildParamsFromMapping(m.mapping, m.vars || {}, m.variableCount);
                        const opts = { lang: m.lang || s.default_template_lang };
                        if (m.headerMediaUrl) {
                            const t = m.headerMediaType === 'image' || m.headerMediaType === 'video' ? m.headerMediaType : 'document';
                            const p = { link: m.headerMediaUrl };
                            if (t === 'document' && m.filename) p.filename = m.filename;
                            opts.headerComponent = { type: 'header', parameters: [{ type: t, [t]: p }] };
                        }
                        if (Array.isArray(m.extraComponents)) opts.extraComponents = m.extraComponents;
                        return finish(await waSvc.sendWhatsAppTemplate(phone, m.templateName, params, opts));
                    }
                    if (kind === 'text') {
                        return finish(await waSvc.sendWhatsAppText(phone, renderTemplateString(m.body, m.vars || {})));
                    }
                    if (kind === 'media' || kind === 'document') {
                        return finish(
                            await waSvc.sendWhatsAppMedia(phone, {
                                type: kind === 'document' ? 'document' : m.mediaType || 'image',
                                link: m.mediaUrl,
                                caption: renderTemplateString(m.caption, m.vars || {}),
                                filename: m.filename
                            })
                        );
                    }
                    if (kind === 'flow') {
                        return finish(await waSvc.sendWhatsAppFlow(phone, m.flow || {}));
                    }
                    return finish({ ok: false, error: 'Unknown message kind: ' + kind });
                } catch (e) {
                    return finish({ ok: false, error: e.message });
                }
            };
            if (meta.bypassOptOut || Number(s.opt_out_enabled) !== 1) return proceed();
            isOptedOut(db, phone, (eO, out) => {
                if (out) return finish({ ok: false, skipped: true, error: 'Recipient opted out' }, 'skipped');
                proceed();
            });
        });
    });
}

function sendAsync(db, msg) {
    return new Promise((resolve) => send(db, msg, (e, r) => resolve(r || { ok: false, error: e && e.message })));
}

/* --------------------------------------------------------- status updates */

const STATUS_RANK = { accepted: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

function applyDeliveryStatus(db, messageId, status, errorDetail, cb) {
    const mid = String(messageId || '').trim();
    if (!mid) return cb && cb(null, 0);
    const st = String(status || '').toLowerCase();
    const col = st === 'delivered' ? 'delivered_at' : st === 'read' ? 'read_at' : st === 'failed' ? 'failed_at' : st === 'sent' ? 'sent_at' : null;
    ensureSchema(db, () => {
        db.get(`SELECT id, status, campaign_id, recipient_id FROM wa_messages WHERE provider_message_id = ? ORDER BY id DESC LIMIT 1`, [mid], (e, row) => {
            if (e || !row) return cb && cb(e, 0);
            const cur = STATUS_RANK[String(row.status || '').toLowerCase()] || 0;
            const nxt = STATUS_RANK[st] || 0;
            const setStatus = nxt >= cur || st === 'failed';
            const sets = [];
            const params = [];
            if (setStatus) {
                sets.push('status = ?');
                params.push(st);
            }
            if (col) sets.push(`${col} = CURRENT_TIMESTAMP`);
            if (st === 'failed' && errorDetail) {
                sets.push('error = ?');
                params.push(String(errorDetail).slice(0, 1000));
            }
            if (!sets.length) return cb && cb(null, 0);
            params.push(row.id);
            db.run(`UPDATE wa_messages SET ${sets.join(', ')} WHERE id = ?`, params, (e2) => {
                if (!row.recipient_id) return cb && cb(e2, 1);
                const rSets = ['updated_at = CURRENT_TIMESTAMP'];
                const rParams = [];
                if (setStatus) {
                    rSets.push('status = ?');
                    rParams.push(st);
                }
                if (st === 'failed' && errorDetail) {
                    rSets.push('error = ?');
                    rParams.push(String(errorDetail).slice(0, 1000));
                }
                rParams.push(row.recipient_id);
                db.run(`UPDATE wa_campaign_recipients SET ${rSets.join(', ')} WHERE id = ?`, rParams, () => {
                    if (row.campaign_id) refreshCampaignCounters(db, row.campaign_id, () => cb && cb(e2, 1));
                    else cb && cb(e2, 1);
                });
            });
        });
    });
}

/* --------------------------------------------------------------- campaigns */

function refreshCampaignCounters(db, campaignId, cb) {
    db.all(`SELECT status, COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? GROUP BY status`, [campaignId], (e, rows) => {
        if (e) return cb && cb(e);
        const c = { pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, accepted: 0 };
        let total = 0;
        (rows || []).forEach((r) => {
            c[String(r.status)] = Number(r.n) || 0;
            total += Number(r.n) || 0;
        });
        const sent = c.sent + c.delivered + c.read + c.accepted;
        db.run(
            `UPDATE wa_campaigns SET total_recipients = ?, sent_count = ?, delivered_count = ?, read_count = ?, failed_count = ?, skipped_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [total, sent, c.delivered + c.read, c.read, c.failed, c.skipped, campaignId],
            () => cb && cb(null, { total, ...c })
        );
    });
}

function getCampaign(db, id, cb) {
    db.get(`SELECT * FROM wa_campaigns WHERE id = ?`, [id], cb);
}

/** Insert de-duplicated recipients for a campaign (dedupe key = phone[+ticket]). */
function replaceRecipients(db, campaignId, recipients, perTicket, cb) {
    db.run(`DELETE FROM wa_campaign_recipients WHERE campaign_id = ? AND status IN ('pending','skipped')`, [campaignId], () => {
        const seen = new Set();
        const list = [];
        let invalid = 0;
        let duplicates = 0;
        (recipients || []).forEach((r) => {
            const phone = waSvc.normalizePhoneE164(r.phone);
            if (!phone || phone.length < 10 || phone.length > 15) {
                invalid++;
                return;
            }
            const key = perTicket ? phone + ':' + (r.ticketId || 0) : phone;
            if (seen.has(key)) {
                duplicates++;
                return;
            }
            seen.add(key);
            list.push({ ...r, phone });
        });
        let i = 0;
        const next = () => {
            if (i >= list.length) {
                return refreshCampaignCounters(db, campaignId, () => cb(null, { inserted: list.length, invalid, duplicates }));
            }
            const r = list[i++];
            db.run(
                `INSERT INTO wa_campaign_recipients (campaign_id, user_id, registration_id, ticket_id, phone, name, vars_json, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [campaignId, r.userId || null, r.registrationId || null, r.ticketId || null, r.phone, r.name || null, JSON.stringify(r.vars || {})],
                next
            );
        };
        next();
    });
}

/** Mark ready → sending. Refuses if already sending/completed (duplicate-send guard). */
function startCampaign(db, campaignId, adminId, cb) {
    getCampaign(db, campaignId, (e, c) => {
        if (e) return cb(e);
        if (!c) return cb(new Error('Campaign not found'));
        const st = String(c.status || '');
        if (st === 'sending') return cb(new Error('Campaign is already sending'));
        if (st === 'completed') return cb(new Error('Campaign already completed — duplicate send blocked. Create a new campaign to resend.'));
        if (st === 'cancelled') return cb(new Error('Campaign was cancelled'));
        if (!Number(c.total_recipients)) return cb(new Error('Campaign has no recipients'));
        db.run(
            `UPDATE wa_campaigns SET status = 'sending', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('draft','ready','paused')`,
            [adminId || null, campaignId],
            function (e2) {
                if (e2) return cb(e2);
                if (!this || !this.changes) return cb(new Error('Campaign state changed — refresh and try again'));
                setImmediate(() => tick(db));
                cb(null, { ok: true });
            }
        );
    });
}

function pauseCampaign(db, campaignId, cb) {
    db.run(`UPDATE wa_campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'`, [campaignId], function (e) {
        cb(e, { ok: !!(this && this.changes) });
    });
}

function cancelCampaign(db, campaignId, cb) {
    db.run(
        `UPDATE wa_campaigns SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft','ready','sending','paused')`,
        [campaignId],
        function (e) {
            if (e) return cb(e);
            db.run(`UPDATE wa_campaign_recipients SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND status = 'pending'`, [campaignId], () =>
                refreshCampaignCounters(db, campaignId, () => cb(null, { ok: !!(this && this.changes) }))
            );
        }
    );
}

function retryFailed(db, campaignId, cb) {
    db.run(
        `UPDATE wa_campaign_recipients SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND status = 'failed'`,
        [campaignId],
        function (e) {
            if (e) return cb(e);
            const n = (this && this.changes) || 0;
            const sql = n > 0
                ? `UPDATE wa_campaigns SET status = 'sending', completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
                : `UPDATE wa_campaigns SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
            db.run(sql, [campaignId], () => {
                setImmediate(() => tick(db));
                cb(null, { retried: n });
            });
        }
    );
}

function buildMessageForRecipient(campaign, recipient, template) {
    let vars = {};
    try {
        vars = JSON.parse(recipient.vars_json || '{}') || {};
    } catch (_) {}
    let mapping = null;
    try {
        mapping = campaign.variable_map_json ? JSON.parse(campaign.variable_map_json) : null;
    } catch (_) {}
    const kind = String(campaign.message_kind || 'template');
    const base = {
        kind,
        phone: recipient.phone,
        vars,
        meta: {
            campaignId: campaign.id,
            recipientId: recipient.id,
            userId: recipient.user_id,
            registrationId: recipient.registration_id,
            seminarId: campaign.seminar_id,
            messageType: campaign.campaign_type || 'campaign'
        }
    };
    if (kind === 'template') {
        const count = template ? Number(template.variable_count) || 0 : mapping ? (Array.isArray(mapping) ? mapping.length : Object.keys(mapping).length) : 0;
        let tplVars = null;
        try {
            tplVars = template && template.variables_json ? JSON.parse(template.variables_json) : null;
        } catch (_) {}
        const effMapping = mapping && (Array.isArray(mapping) ? mapping.length : Object.keys(mapping).length) ? mapping : Array.isArray(tplVars) ? tplVars.map((v) => (v && v.key) || v) : null;
        base.templateName = campaign.template_name || (template && template.meta_name);
        base.lang = campaign.template_lang || (template && template.language) || undefined;
        base.mapping = effMapping;
        base.variableCount = count;
        if (campaign.media_url && template && template.header_type && template.header_type !== 'text') {
            base.headerMediaUrl = campaign.media_url;
            base.headerMediaType = template.header_type;
            base.filename = campaign.media_filename || undefined;
        }
    } else if (kind === 'text') {
        base.body = campaign.body_text || '';
    } else {
        base.kind = campaign.media_type === 'document' ? 'document' : 'media';
        base.mediaUrl = campaign.media_url;
        base.mediaType = campaign.media_type || 'image';
        base.filename = campaign.media_filename || undefined;
        base.caption = campaign.media_caption || campaign.body_text || '';
    }
    return base;
}

/** Quiet hours in IST (HH:MM strings); campaigns pause while inside the window. */
function inQuietHours(s) {
    const a = String(s.quiet_start || '').trim();
    const b = String(s.quiet_end || '').trim();
    if (!/^\d{2}:\d{2}$/.test(a) || !/^\d{2}:\d{2}$/.test(b) || a === b) return false;
    const now = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    return a < b ? now >= a && now < b : now >= a || now < b;
}

let ticking = false;
/** Worker: process due recipients of all `sending` campaigns (called on an interval + after start). */
function tick(db, done) {
    if (ticking) return done && done();
    ticking = true;
    const end = () => {
        ticking = false;
        done && done();
    };
    ensureSchema(db, () => {
        loadSettings(db, (eS, settings) => {
            const s = settings || SETTING_DEFAULTS;
            if (String(s.campaigns_enabled) === '0' || inQuietHours(s)) return end();
            db.all(`SELECT * FROM wa_campaigns WHERE status = 'sending' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY id ASC`, [new Date().toISOString()], (e, campaigns) => {
                if (e || !campaigns || !campaigns.length) return end();
                let ci = 0;
                const nextCampaign = () => {
                    if (ci >= campaigns.length) return end();
                    const c = campaigns[ci++];
                    const tplLoad = (cbT) => {
                        if (c.message_kind !== 'template') return cbT(null);
                        if (c.template_id) return db.get(`SELECT * FROM wa_templates WHERE id = ?`, [c.template_id], (e1, t) => cbT(t || null));
                        db.get(`SELECT * FROM wa_templates WHERE meta_name = ? ORDER BY is_active DESC, id DESC LIMIT 1`, [c.template_name], (e1, t) => cbT(t || null));
                    };
                    tplLoad((template) => {
                        db.all(
                            `SELECT * FROM wa_campaign_recipients WHERE campaign_id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id ASC LIMIT ?`,
                            [c.id, new Date().toISOString(), Math.max(1, Number(s.campaign_batch_size) || 25)],
                            async (e2, recips) => {
                                if (e2) return nextCampaign();
                                if (!recips || !recips.length) {
                                    db.get(`SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? AND status IN ('pending','sending')`, [c.id], (e3, row) => {
                                        if (!e3 && row && Number(row.n) === 0) {
                                            db.run(`UPDATE wa_campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'`, [c.id], () =>
                                                refreshCampaignCounters(db, c.id, nextCampaign)
                                            );
                                        } else nextCampaign();
                                    });
                                    return;
                                }
                                for (const r of recips) {
                                    // Re-check campaign still sending (pause/cancel mid-batch).
                                    const still = await new Promise((res) => db.get(`SELECT status FROM wa_campaigns WHERE id = ?`, [c.id], (e4, row) => res(row && row.status === 'sending')));
                                    if (!still) break;
                                    await new Promise((res) => db.run(`UPDATE wa_campaign_recipients SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, [r.id], res));
                                    const msg = buildMessageForRecipient(c, r, template);
                                    const result = await sendAsync(db, msg);
                                    let st = result.ok ? 'sent' : result.skipped ? 'skipped' : 'failed';
                                    let nextAt = null;
                                    const attempts = Number(r.attempts || 0) + 1;
                                    if (!result.ok && !result.skipped && attempts < Number(s.max_retries) && isRetryable(result.error)) {
                                        st = 'pending';
                                        nextAt = new Date(Date.now() + Math.max(10, Number(s.retry_delay_seconds) || 120) * 1000).toISOString();
                                    }
                                    await new Promise((res) =>
                                        db.run(
                                            `UPDATE wa_campaign_recipients SET status = ?, provider_message_id = ?, error = ?, next_attempt_at = ?, sent_at = ${st === 'sent' ? 'CURRENT_TIMESTAMP' : 'sent_at'}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                            [st, result.messageId || null, result.error ? String(result.error).slice(0, 1000) : null, nextAt, r.id],
                                            res
                                        )
                                    );
                                }
                                refreshCampaignCounters(db, c.id, nextCampaign);
                            }
                        );
                    });
                };
                nextCampaign();
            });
        });
    });
}

function isRetryable(err) {
    const s = String(err || '').toLowerCase();
    if (!s) return false;
    if (/invalid phone|opted out|not configured|131026|131047|132000|132001|132012|133010|100\b/.test(s)) return false;
    return /timeout|econn|socket|rate|throttl|130429|131048|131056|500|503|temporar|network|hang up/.test(s);
}

let workerTimer = null;
function startWorker(db, intervalMs) {
    if (workerTimer) return;
    workerTimer = setInterval(() => tick(db), Math.max(3000, intervalMs || 5000));
    if (workerTimer.unref) workerTimer.unref();
}

/* ---------------------------------------------------------------- templates */

function syncTemplatesFromMeta(db, cb) {
    waSvc.listAllMetaTemplates().then((r) => {
        if (!r.ok) return cb(new Error(r.error || 'Could not read templates from Meta'));
        let i = 0;
        let upserted = 0;
        const list = r.templates || [];
        const next = () => {
            if (i >= list.length) return cb(null, { synced: upserted, total: list.length });
            const t = list[i++];
            db.get(`SELECT id, variables_json FROM wa_templates WHERE meta_name = ? AND language = ?`, [t.name, t.language || 'en'], (e, row) => {
                const vars = row && row.variables_json ? row.variables_json : JSON.stringify(defaultVariableKeys(t.bodyVariableCount));
                if (row) {
                    db.run(
                        `UPDATE wa_templates SET meta_id = ?, category = ?, status = ?, header_type = ?, body_text = ?, variable_count = ?, variables_json = ?, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [t.id || null, t.category || null, t.status || null, t.headerType || null, t.bodyText || null, t.bodyVariableCount || 0, vars, row.id],
                        () => {
                            upserted++;
                            next();
                        }
                    );
                } else {
                    db.run(
                        `INSERT INTO wa_templates (name, meta_name, meta_id, language, category, status, header_type, body_text, variable_count, variables_json, is_active, synced_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [t.name, t.name, t.id || null, t.language || 'en', t.category || null, t.status || null, t.headerType || null, t.bodyText || null, t.bodyVariableCount || 0, vars, String(t.status).toUpperCase() === 'APPROVED' ? 1 : 0],
                        () => {
                            upserted++;
                            next();
                        }
                    );
                }
            });
        };
        next();
    });
}

function defaultVariableKeys(n) {
    const out = [];
    for (let i = 0; i < (Number(n) || 0); i++) out.push('');
    return out;
}

module.exports = {
    SCHEMA,
    ensureSchema,
    loadSettings,
    saveSettings,
    publicSettings,
    SETTING_DEFAULTS,
    send,
    sendAsync,
    logMessage,
    applyDeliveryStatus,
    isOptedOut,
    setOptStatus,
    recordInbound,
    classifyKeyword,
    renderTemplateString,
    buildParamsFromMapping,
    replaceRecipients,
    startCampaign,
    pauseCampaign,
    cancelCampaign,
    retryFailed,
    refreshCampaignCounters,
    getCampaign,
    tick,
    startWorker,
    syncTemplatesFromMeta,
    buildMessageForRecipient
};

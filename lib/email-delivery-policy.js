/**
 * Throttle outbound email to stay within free SMTP limits (e.g. Zoho ~550 rate blocks).
 * Config in global_settings.notification_delivery_config
 */
const KEY = 'notification_delivery_config';

const DEFAULT_CONFIG = {
    posSkipParticipantEmail: true,
    posSkipStaffAlerts: true,
    queueAllEmails: true,
    emailMaxPerHour: 80,
    emailMinGapMs: 2500,
    deferMinutesOnRateLimit: 45,
    maxAttachmentEmailsPerHour: 40
};

let cached = null;
let cacheAt = 0;
const CACHE_MS = 15000;

function normalizeConfig(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    return {
        posSkipParticipantEmail: o.posSkipParticipantEmail !== false,
        posSkipStaffAlerts: o.posSkipStaffAlerts !== false,
        queueAllEmails: o.queueAllEmails !== false,
        emailMaxPerHour: Math.max(10, parseInt(o.emailMaxPerHour, 10) || DEFAULT_CONFIG.emailMaxPerHour),
        emailMinGapMs: Math.max(500, parseInt(o.emailMinGapMs, 10) || DEFAULT_CONFIG.emailMinGapMs),
        deferMinutesOnRateLimit: Math.max(5, parseInt(o.deferMinutesOnRateLimit, 10) || DEFAULT_CONFIG.deferMinutesOnRateLimit),
        maxAttachmentEmailsPerHour: Math.max(
            5,
            parseInt(o.maxAttachmentEmailsPerHour, 10) || DEFAULT_CONFIG.maxAttachmentEmailsPerHour
        )
    };
}

function loadConfig(db, cb) {
    if (cached && Date.now() - cacheAt < CACHE_MS) {
        return cb(null, cached);
    }
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [KEY], (err, row) => {
        if (err) return cb(err, normalizeConfig(DEFAULT_CONFIG));
        let parsed = { ...DEFAULT_CONFIG };
        if (row && row.value) {
            try {
                parsed = normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(row.value) });
            } catch (_) {}
        }
        cached = parsed;
        cacheAt = Date.now();
        cb(null, parsed);
    });
}

function saveConfig(db, config, cb) {
    const norm = normalizeConfig(config);
    const json = JSON.stringify(norm);
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, KEY], function (uErr) {
        if (uErr) return cb(uErr);
        if (this.changes > 0) {
            cached = norm;
            cacheAt = Date.now();
            return cb(null, norm);
        }
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [KEY, json], (iErr) => {
            if (!iErr) {
                cached = norm;
                cacheAt = Date.now();
            }
            cb(iErr, norm);
        });
    });
}

function isRateLimitSmtpError(errMsg) {
    const m = String(errMsg || '').toLowerCase();
    return (
        m.includes('550') ||
        m.includes('5.4.6') ||
        m.includes('unusual sending activity') ||
        m.includes('too many') ||
        m.includes('rate limit') ||
        m.includes('throttl')
    );
}

function shouldSkipPosParticipantEmail(cfg, context) {
    if (!cfg || !cfg.posSkipParticipantEmail) return false;
    return !!(context && (context.source === 'pos' || context.isPos));
}

function shouldSkipPosStaffAlerts(cfg, context) {
    if (!cfg || !cfg.posSkipStaffAlerts) return false;
    return !!(context && (context.source === 'pos' || context.isPos));
}

function shouldDeferImmediateEmail(cfg) {
    return !!(cfg && cfg.queueAllEmails);
}

/**
 * @param {object} db
 * @param {{ hasAttachment?: boolean }} meta
 */
function checkEmailSendAllowed(db, meta, cb) {
    loadConfig(db, (e, cfg) => {
        if (e) return cb(e, { allowed: true });
        const hourAgo = new Date(Date.now() - 3600000).toISOString();
        const cap = meta && meta.hasAttachment ? cfg.maxAttachmentEmailsPerHour : cfg.emailMaxPerHour;
        db.get(
            `SELECT COUNT(*) AS c FROM notification_logs
             WHERE channel = 'email' AND status = 'sent' AND created_at >= ?`,
            [hourAgo],
            (e2, row) => {
                if (e2) return cb(e2, { allowed: true });
                const sent = row && row.c != null ? Number(row.c) : 0;
                if (sent >= cap) {
                    return cb(null, {
                        allowed: false,
                        reason: 'hourly_cap',
                        deferMinutes: cfg.deferMinutesOnRateLimit,
                        sent,
                        cap
                    });
                }
                db.get(
                    `SELECT created_at FROM notification_logs
                     WHERE channel = 'email' AND status = 'sent' ORDER BY id DESC LIMIT 1`,
                    [],
                    (e3, last) => {
                        if (e3 || !last || !last.created_at) {
                            return cb(null, { allowed: true, cfg });
                        }
                        const gap = Date.now() - new Date(last.created_at).getTime();
                        if (gap < cfg.emailMinGapMs) {
                            const waitMin = Math.ceil((cfg.emailMinGapMs - gap) / 60000) || 1;
                            return cb(null, {
                                allowed: false,
                                reason: 'min_gap',
                                deferMinutes: Math.max(1, waitMin),
                                cfg
                            });
                        }
                        cb(null, { allowed: true, cfg });
                    }
                );
            }
        );
    });
}

function deferQueueRow(db, rowId, minutes, lastError, cb) {
    const at = new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
    db.run(
        `UPDATE notification_queue SET status = 'pending', scheduled_at = ?, last_error = ? WHERE id = ?`,
        [at, lastError || 'deferred', rowId],
        cb
    );
}

module.exports = {
    KEY,
    DEFAULT_CONFIG,
    loadConfig,
    saveConfig,
    normalizeConfig,
    isRateLimitSmtpError,
    shouldSkipPosParticipantEmail,
    shouldSkipPosStaffAlerts,
    shouldDeferImmediateEmail,
    checkEmailSendAllowed,
    deferQueueRow
};

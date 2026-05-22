/**
 * Admin-stored API keys (global_settings.integration_secrets).
 * Merged with process.env — DB values override env when set.
 */
const SETTINGS_KEY = 'integration_secrets';

let runtime = {};
let transporterReset = null;

function registerTransporterReset(fn) {
    transporterReset = fn;
}

function applyToProcessEnv(data) {
    const d = data || {};
    if (d.zoho_host) process.env.ZOHO_HOST = d.zoho_host;
    if (d.zoho_port != null && d.zoho_port !== '') process.env.ZOHO_PORT = String(d.zoho_port);
    if (d.zoho_user) process.env.ZOHO_USER = d.zoho_user;
    if (d.zoho_pass) process.env.ZOHO_PASS = d.zoho_pass;
    if (d.zoho_from) process.env.ZOHO_FROM = d.zoho_from;
    if (d.whatsapp_token) process.env.WHATSAPP_TOKEN = d.whatsapp_token;
    if (d.whatsapp_phone_number_id) process.env.WHATSAPP_PHONE_NUMBER_ID = d.whatsapp_phone_number_id;
    if (d.whatsapp_business_account_id) {
        process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = d.whatsapp_business_account_id;
    }
    if (d.whatsapp_verify_token) process.env.WHATSAPP_VERIFY_TOKEN = d.whatsapp_verify_token;
    if (d.whatsapp_template_lang) process.env.WHATSAPP_TEMPLATE_LANG = d.whatsapp_template_lang;
    if (d.whatsapp_otp_template_name) {
        process.env.WHATSAPP_OTP_TEMPLATE_NAME = d.whatsapp_otp_template_name;
    }
    if (d.otp_email_subject) process.env.OTP_EMAIL_SUBJECT = d.otp_email_subject;
    if (d.public_base_url) process.env.PUBLIC_BASE_URL = d.public_base_url;
    if (d.admin_contact_email) process.env.ADMIN_CONTACT_EMAIL = d.admin_contact_email;
    if (d.seminar_host) process.env.SEMINAR_HOST = d.seminar_host;
    if (d.admin_host) process.env.ADMIN_HOST = d.admin_host;
    if (d.judge_host) process.env.JUDGE_HOST = d.judge_host;
    if (d.wix_site_url) process.env.WIX_SITE_URL = d.wix_site_url;
}

function setRuntimeIntegrations(data) {
    runtime = { ...(data || {}) };
    applyToProcessEnv(runtime);
    if (typeof transporterReset === 'function') transporterReset();
}

function getRuntimeIntegrations() {
    return { ...runtime };
}

function normalizeEmail(v) {
    return String(v || '')
        .trim()
        .toLowerCase();
}

function getMailConfig(overrides) {
    const o = overrides || {};
    const host = String(o.zoho_host || runtime.zoho_host || process.env.ZOHO_HOST || '').trim();
    const user = normalizeEmail(o.zoho_user || runtime.zoho_user || process.env.ZOHO_USER);
    let pass = o.zoho_pass != null ? String(o.zoho_pass) : runtime.zoho_pass || process.env.ZOHO_PASS || '';
    pass = pass.trim();
    if (isMaskedSecretValue(pass)) {
        pass = String(runtime.zoho_pass || process.env.ZOHO_PASS || '').trim();
    }
    if (host && user && pass) {
        const port = parseInt(String(o.zoho_port || runtime.zoho_port || process.env.ZOHO_PORT || '465'), 10) || 465;
        const from = normalizeEmail(o.zoho_from || runtime.zoho_from || process.env.ZOHO_FROM || user) || user;
        return {
            host,
            port,
            secure: port === 465,
            requireTLS: port === 587,
            auth: { user, pass },
            from
        };
    }
    if (process.env.SMTP_HOST && process.env.MAIL_FROM) {
        const port = parseInt(process.env.SMTP_PORT || '587', 10);
        return {
            host: process.env.SMTP_HOST,
            port,
            secure: process.env.SMTP_SECURE === '1' || port === 465,
            auth:
                process.env.SMTP_USER && process.env.SMTP_PASS
                    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                    : undefined,
            from: process.env.MAIL_FROM
        };
    }
    return null;
}

function isEmailConfiguredFromSettings() {
    return !!getMailConfig();
}

function isWhatsAppConfiguredFromSettings() {
    const token = String(runtime.whatsapp_token || process.env.WHATSAPP_TOKEN || '').trim();
    const phoneId = String(
        runtime.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || ''
    ).trim();
    return !!(token && phoneId);
}

function getWhatsAppConfigStatus() {
    const token = String(runtime.whatsapp_token || process.env.WHATSAPP_TOKEN || '').trim();
    const phoneId = String(
        runtime.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || ''
    ).trim();
    const missing = [];
    if (!token) missing.push('WhatsApp access token');
    if (!phoneId) missing.push('Phone number ID');
    return {
        configured: missing.length === 0,
        missing,
        hasOtpTemplateHint:
            'OTP Meta template name is separate — set it on OTP_VERIFICATION in Notifications or WHATSAPP_OTP_TEMPLATE_NAME env.'
    };
}

function getWhatsAppConfig() {
    return {
        token: runtime.whatsapp_token || process.env.WHATSAPP_TOKEN || '',
        phoneNumberId: runtime.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        businessAccountId:
            runtime.whatsapp_business_account_id || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
        verifyToken: runtime.whatsapp_verify_token || process.env.WHATSAPP_VERIFY_TOKEN || '',
        templateLang: runtime.whatsapp_template_lang || process.env.WHATSAPP_TEMPLATE_LANG || 'en'
    };
}

function getEventWhatsAppTemplateLang(eventKey) {
    const key = String(eventKey || '').trim();
    const map =
        runtime.whatsapp_event_templates && typeof runtime.whatsapp_event_templates === 'object'
            ? runtime.whatsapp_event_templates
            : {};
    const row = map[key];
    if (row && row.lang) return String(row.lang).trim();
    return getWhatsAppConfig().templateLang || 'en';
}

/** All verify strings accepted for Meta webhook GET (primary + optional env alternates). */
function getWhatsAppVerifyCandidates() {
    const cfg = getWhatsAppConfig();
    const raw = [
        cfg.verifyToken,
        process.env.WHATSAPP_VERIFY_TOKEN,
        process.env.WHATSAPP_VERIFY_TOKEN_ALT,
        process.env.WHATSAPP_VERIFY_TOKEN_EXTRA
    ];
    const out = [];
    raw.forEach((v) => {
        String(v || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((t) => {
                if (!out.includes(t)) out.push(t);
            });
    });
    return out;
}

function matchesWhatsAppVerifyToken(provided) {
    const t = String(provided || '').trim();
    if (!t) return false;
    return getWhatsAppVerifyCandidates().some((c) => c === t);
}

function getPublicBaseUrl() {
    const u = runtime.public_base_url || process.env.PUBLIC_BASE_URL || process.env.SITE_URL || 'http://localhost:3000';
    return String(u).replace(/\/$/, '');
}

const SECRET_FIELDS = ['zoho_pass', 'whatsapp_token', 'whatsapp_verify_token'];

function maskSecretsForClient(data) {
    const out = { ...(data || {}) };
    SECRET_FIELDS.forEach((k) => {
        if (out[k]) out[k] = '********';
    });
    return out;
}

function isMaskedSecretValue(v) {
    if (v === undefined || v === null) return true;
    const s = String(v).trim();
    if (!s) return true;
    if (s === '********' || /^[\*•·]+$/.test(s)) return true;
    return false;
}

function mergeSavePayload(existing, incoming) {
    const out = { ...(existing || {}) };
    Object.keys(incoming || {}).forEach((k) => {
        let v = incoming[k];
        if (v === undefined || v === null) return;
        if (SECRET_FIELDS.includes(k) && (isMaskedSecretValue(v) || String(v).trim() === '')) return;
        if (k === 'zoho_user' || k === 'zoho_from' || k === 'admin_contact_email') v = normalizeEmail(v);
        if (k === 'zoho_pass' && typeof v === 'string') v = v.trim();
        if (k === 'zoho_host' && typeof v === 'string') v = v.trim();
        out[k] = v;
    });
    return out;
}

function getMailConfigSummary() {
    const cfg = getMailConfig();
    if (!cfg) {
        const st = getEmailConfigStatus();
        return { configured: false, missing: st.missing || [] };
    }
    return {
        configured: true,
        host: cfg.host,
        port: cfg.port,
        user: cfg.auth.user,
        from: cfg.from,
        secure: cfg.secure,
        requireTLS: !!cfg.requireTLS
    };
}

/** Reload integration_secrets from DB (needed on Vercel serverless before OTP/email). */
function ensureIntegrationSettingsLoaded(db, cb) {
    loadFromDb(db, cb);
}

function getEmailConfigStatus() {
    const rt = getRuntimeIntegrations();
    const host = rt.zoho_host || process.env.ZOHO_HOST;
    const user = rt.zoho_user || process.env.ZOHO_USER;
    const pass = rt.zoho_pass || process.env.ZOHO_PASS;
    const missing = [];
    if (!host) missing.push('SMTP host');
    if (!user) missing.push('SMTP user');
    if (!pass) missing.push('SMTP password');
    if (process.env.SMTP_HOST && process.env.MAIL_FROM && missing.length) {
        return { configured: true, missing: [], viaEnv: 'SMTP_HOST' };
    }
    return {
        configured: missing.length === 0,
        missing
    };
}

function loadFromDb(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [SETTINGS_KEY], (err, row) => {
        if (err) return cb && cb(err);
        let data = {};
        if (row && row.value) {
            try {
                data = JSON.parse(row.value);
            } catch (_) {
                data = {};
            }
        }
        setRuntimeIntegrations(data);
        cb && cb(null, data);
    });
}

function saveToDb(db, payload, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [SETTINGS_KEY], (err, row) => {
        if (err) return cb && cb(err);
        let existing = {};
        if (row && row.value) {
            try {
                existing = JSON.parse(row.value);
            } catch (_) {
                existing = {};
            }
        }
        const merged = mergeSavePayload(existing, payload);
        const json = JSON.stringify(merged);
        db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [json, SETTINGS_KEY], function (uerr) {
            if (uerr) return cb && cb(uerr);
            if (this.changes > 0) {
                setRuntimeIntegrations(merged);
                return cb && cb(null, merged);
            }
            db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [SETTINGS_KEY, json], (ierr) => {
                if (ierr) return cb && cb(ierr);
                setRuntimeIntegrations(merged);
                cb && cb(null, merged);
            });
        });
    });
}

function seedSettingKeyIfMissing(db, next) {
    db.get(`SELECT 1 AS ok FROM global_settings WHERE key = ?`, [SETTINGS_KEY], (e, row) => {
        if (e) return next && next(e);
        if (row && row.ok) return next && next();
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [SETTINGS_KEY, '{}'], () => next && next());
    });
}

module.exports = {
    SETTINGS_KEY,
    registerTransporterReset,
    setRuntimeIntegrations,
    getRuntimeIntegrations,
    getMailConfig,
    isEmailConfiguredFromSettings,
    isWhatsAppConfiguredFromSettings,
    getWhatsAppConfigStatus,
    getWhatsAppConfig,
    getEventWhatsAppTemplateLang,
    getPublicBaseUrl,
    getEmailConfigStatus,
    maskSecretsForClient,
    isMaskedSecretValue,
    mergeSavePayload,
    normalizeEmail,
    getMailConfigSummary,
    loadFromDb,
    ensureIntegrationSettingsLoaded,
    saveToDb,
    seedSettingKeyIfMissing,
    getWhatsAppVerifyCandidates,
    matchesWhatsAppVerifyToken
};

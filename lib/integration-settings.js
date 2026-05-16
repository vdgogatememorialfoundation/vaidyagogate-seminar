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
    if (d.whatsapp_verify_token) process.env.WHATSAPP_VERIFY_TOKEN = d.whatsapp_verify_token;
    if (d.whatsapp_template_lang) process.env.WHATSAPP_TEMPLATE_LANG = d.whatsapp_template_lang;
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

function getMailConfig() {
    const host = runtime.zoho_host || process.env.ZOHO_HOST;
    const user = runtime.zoho_user || process.env.ZOHO_USER;
    const pass = runtime.zoho_pass || process.env.ZOHO_PASS;
    if (host && user && pass) {
        const port = parseInt(runtime.zoho_port || process.env.ZOHO_PORT || '465', 10);
        return {
            host,
            port,
            secure: port === 465 || process.env.ZOHO_SECURE === '1',
            auth: { user, pass },
            from: runtime.zoho_from || process.env.ZOHO_FROM || user
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
    const token = runtime.whatsapp_token || process.env.WHATSAPP_TOKEN;
    const phoneId = runtime.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    return !!(token && phoneId);
}

function getWhatsAppConfig() {
    return {
        token: runtime.whatsapp_token || process.env.WHATSAPP_TOKEN || '',
        phoneNumberId: runtime.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        verifyToken: runtime.whatsapp_verify_token || process.env.WHATSAPP_VERIFY_TOKEN || '',
        templateLang: runtime.whatsapp_template_lang || process.env.WHATSAPP_TEMPLATE_LANG || 'en'
    };
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

function mergeSavePayload(existing, incoming) {
    const out = { ...(existing || {}) };
    Object.keys(incoming || {}).forEach((k) => {
        const v = incoming[k];
        if (v === undefined || v === null) return;
        if (SECRET_FIELDS.includes(k) && (v === '' || v === '********')) return;
        out[k] = v;
    });
    return out;
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
    getWhatsAppConfig,
    getPublicBaseUrl,
    maskSecretsForClient,
    mergeSavePayload,
    loadFromDb,
    saveToDb,
    seedSettingKeyIfMissing
};

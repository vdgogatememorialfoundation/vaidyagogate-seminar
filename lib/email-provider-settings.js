/**
 * Per-provider email API credentials and enable flags for admin integrations.
 */
const HTTP_PROVIDERS = ['zeptomail', 'sender', 'brevo', 'resend'];

const PROVIDER_DOCS = {
    zeptomail: {
        label: 'Zoho ZeptoMail',
        tokenLabel: 'Send Mail token',
        placeholder: 'Paste ZeptoMail Send Mail token',
        docs:
            'API: POST https://api.zeptomail.in/v1.1/email · Auth: Zoho-enczapikey TOKEN. ' +
            'SMTP: smtp.zeptomail.in port 587 (TLS), user emailapikey. ' +
            'Verify domain seminar.vaidyagogate.org in ZeptoMail.',
        fromExample: 'noreply@seminar.vaidyagogate.org'
    },
    sender: {
        label: 'Sender.net',
        tokenLabel: 'API access token',
        placeholder: 'Paste Sender.net API token',
        docs:
            'API: POST https://api.sender.net/v2/message/send · Auth: Bearer TOKEN. ' +
            'Create token at Sender.net → Settings → API access tokens.',
        fromExample: 'noreply@seminar.vaidyagogate.org'
    },
    brevo: {
        label: 'Brevo (Sendinblue)',
        tokenLabel: 'API key',
        placeholder: 'Paste Brevo API key',
        docs: 'API: POST https://api.brevo.com/v3/smtp/email · Header: api-key.',
        fromExample: 'care@vaidyagogate.org'
    },
    resend: {
        label: 'Resend',
        tokenLabel: 'API key',
        placeholder: 'Paste Resend API key',
        docs: 'API: POST https://api.resend.com/emails · Auth: Bearer TOKEN.',
        fromExample: 'noreply@seminar.vaidyagogate.org'
    }
};

function isMaskedSecretValue(v) {
    if (v === undefined || v === null) return true;
    const s = String(v).trim();
    if (!s) return true;
    if (s === '********' || /^[\*•·]+$/.test(s)) return true;
    return false;
}

/** Strip quotes / Zoho-enczapikey prefix; store raw token only. */
function normalizeZeptoMailToken(raw) {
    let k = String(raw || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .trim();
    k = k.replace(/^["']+|["']+$/g, '');
    k = k.replace(/^zoho-enczapikey\s+/i, '').trim();
    k = k.replace(/\s+/g, '');
    return k;
}

/** Return validated token or empty string (never a Sender JWT / masked placeholder). */
function resolveZeptoMailKey(raw) {
    const v = validateZeptoMailToken(raw);
    return v.wrong ? '' : v.token;
}

function validateZeptoMailToken(raw) {
    const k = normalizeZeptoMailToken(raw);
    if (!k) return { wrong: true, reason: 'ZeptoMail Send Mail token is empty.' };
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(k)) {
        return {
            wrong: true,
            reason:
                'This looks like a Sender.net JWT, not a ZeptoMail token. In ZeptoMail open your Mail Agent → SMTP/API → copy Send Mail Token (not Sender.net).'
        };
    }
    if (k.length < 16) {
        return { wrong: true, reason: 'ZeptoMail token looks too short — copy the full Send Mail token from the Agent API tab.' };
    }
    return { wrong: false, token: k };
}

function sanitizeProviderKey(provider, raw) {
    const p = String(provider || '').toLowerCase();
    if (p === 'zeptomail') {
        const v = validateZeptoMailToken(raw);
        return v.wrong ? '' : v.token;
    }
    return String(raw || '').trim();
}

function parseProviderKeys(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            const j = JSON.parse(raw);
            return j && typeof j === 'object' ? { ...j } : {};
        } catch (_) {
            return {};
        }
    }
    return typeof raw === 'object' ? { ...raw } : {};
}

function providerKeysSavedFlags(keys) {
    const map = parseProviderKeys(keys);
    const out = {};
    HTTP_PROVIDERS.forEach((p) => {
        out[p] = !!(map[p] && String(map[p]).trim());
    });
    return out;
}

function mergeProviderKeys(existing, incoming, body) {
    const out = parseProviderKeys(existing && existing.email_provider_keys);
    const b = body || {};

    if (b.email_provider_keys && typeof b.email_provider_keys === 'object') {
        HTTP_PROVIDERS.forEach((p) => {
            const v = b.email_provider_keys[p];
            if (v != null && String(v).trim() && !isMaskedSecretValue(v)) {
                const cleaned = p === 'zeptomail' ? sanitizeProviderKey(p, v) : String(v).trim();
                if (cleaned) out[p] = cleaned;
            }
        });
    }

    if (b.email_api_key && b.email_api_provider && !isMaskedSecretValue(b.email_api_key)) {
        const pp = String(b.email_api_provider).toLowerCase();
        const cleaned =
            pp === 'zeptomail' ? sanitizeProviderKey(pp, b.email_api_key) : String(b.email_api_key).trim();
        if (cleaned) out[pp] = cleaned;
    }
    if (
        b.email_api_fallback_key &&
        b.email_api_fallback_provider &&
        !isMaskedSecretValue(b.email_api_fallback_key)
    ) {
        out[String(b.email_api_fallback_provider).toLowerCase()] = String(b.email_api_fallback_key).trim();
    }

    // Migrate legacy single keys into map when missing
    if (existing) {
        const pp = String(existing.email_api_provider || '').toLowerCase();
        if (pp && existing.email_api_key && !out[pp]) {
            const cleaned =
                pp === 'zeptomail'
                    ? sanitizeProviderKey(pp, existing.email_api_key)
                    : String(existing.email_api_key).trim();
            if (cleaned) out[pp] = cleaned;
        }
        const fp = String(existing.email_api_fallback_provider || '').toLowerCase();
        if (fp && existing.email_api_fallback_key && !out[fp]) {
            out[fp] = String(existing.email_api_fallback_key).trim();
        }
    }

    return out;
}

function flagEnabled(val, defaultOn) {
    if (val === undefined || val === null || val === '') return defaultOn !== false;
    if (val === true || val === 1 || val === '1') return true;
    if (val === false || val === 0 || val === '0') return false;
    return !!val;
}

function applyEmailProviderFlags(row) {
    const out = { ...(row || {}) };
    out.email_primary_enabled = flagEnabled(out.email_primary_enabled, true) ? 1 : 0;
    out.email_fallback_enabled = flagEnabled(out.email_fallback_enabled, false) ? 1 : 0;
    out.email_smtp_standby_enabled = flagEnabled(out.email_smtp_standby_enabled, false) ? 1 : 0;
    return out;
}

/** Sync legacy email_api_key fields from per-provider map + enable flags. */
function syncActiveEmailCredentials(row) {
    const out = applyEmailProviderFlags(row);
    const keys = parseProviderKeys(out.email_provider_keys);
    const primary = String(out.email_api_provider || '').toLowerCase();
    const fallback = String(out.email_api_fallback_provider || '').toLowerCase();

    if (!out.email_primary_enabled || !primary || !HTTP_PROVIDERS.includes(primary)) {
        out.email_api_provider = out.email_primary_enabled ? primary || 'zeptomail' : '';
    } else {
        out.email_api_provider = primary;
    }

    if (!out.email_fallback_enabled || !fallback || !HTTP_PROVIDERS.includes(fallback)) {
        out.email_api_fallback_provider = '';
    } else {
        out.email_api_fallback_provider = fallback;
    }

    if (out.email_api_provider && keys[out.email_api_provider]) {
        out.email_api_key = keys[out.email_api_provider];
    }
    if (out.email_api_fallback_provider && keys[out.email_api_fallback_provider]) {
        out.email_api_fallback_key = keys[out.email_api_fallback_provider];
    }

    out.email_provider_keys = keys;
    return out;
}

function isSmtpStandbyEnabled(row) {
    const rt = row || {};
    return flagEnabled(rt.email_smtp_standby_enabled, false);
}

/** Force ZeptoMail HTTPS primary; disable Sender fallback and Zoho SMTP relay. */
function enforceZeptoMailOnlySettings(existing) {
    const ex = { ...(existing || {}) };
    const keys = parseProviderKeys(ex.email_provider_keys);
    const primaryWas = String(ex.email_api_provider || '').toLowerCase();
    let zeptoKey = keys.zeptomail ? sanitizeProviderKey('zeptomail', keys.zeptomail) : '';
    if (!zeptoKey && primaryWas === 'zeptomail' && ex.email_api_key && !isMaskedSecretValue(ex.email_api_key)) {
        zeptoKey = sanitizeProviderKey('zeptomail', ex.email_api_key);
    }
    if (!zeptoKey) {
        const envKey = String(
            process.env.ZEPTOMAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || process.env.EMAIL_API_KEY || ''
        ).trim();
        if (envKey) zeptoKey = sanitizeProviderKey('zeptomail', envKey);
    }
    if (zeptoKey) keys.zeptomail = zeptoKey;
    else delete keys.zeptomail;
    const out = {
        ...ex,
        email_api_provider: 'zeptomail',
        email_api_fallback_provider: '',
        email_api_fallback_key: '',
        email_primary_enabled: 1,
        email_fallback_enabled: 0,
        email_smtp_standby_enabled: 0,
        email_provider_keys: keys,
        zoho_from:
            ex.zoho_from ||
            process.env.ZOHO_FROM ||
            process.env.ZEPTOMAIL_FROM ||
            'noreply@seminar.vaidyagogate.org'
    };
    if (zeptoKey) out.email_api_key = zeptoKey;
    return syncActiveEmailCredentials(out);
}

function maskProviderKeysForClient(keys) {
    const map = parseProviderKeys(keys);
    const out = {};
    HTTP_PROVIDERS.forEach((p) => {
        if (map[p]) out[p] = '********';
    });
    return out;
}

module.exports = {
    HTTP_PROVIDERS,
    PROVIDER_DOCS,
    parseProviderKeys,
    mergeProviderKeys,
    providerKeysSavedFlags,
    syncActiveEmailCredentials,
    isSmtpStandbyEnabled,
    maskProviderKeysForClient,
    isMaskedSecretValue,
    normalizeZeptoMailToken,
    validateZeptoMailToken,
    resolveZeptoMailKey,
    sanitizeProviderKey,
    enforceZeptoMailOnlySettings
};

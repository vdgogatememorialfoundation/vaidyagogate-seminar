/**
 * Send email over HTTPS (port 443) — works on Render free tier where SMTP 465/587 is blocked.
 * Primary: ZeptoMail (or admin-selected HTTPS provider). Fallback only when explicitly enabled.
 */
const integrationSettings = require('./integration-settings');
const emailProv = require('./email-provider-settings');

const PROVIDERS = {
    sender: {
        label: 'Sender.net',
        url: 'https://api.sender.net/v2/message/send'
    },
    brevo: {
        label: 'Brevo',
        url: 'https://api.brevo.com/v3/smtp/email'
    },
    resend: {
        label: 'Resend',
        url: 'https://api.resend.com/emails'
    },
    zeptomail: {
        label: 'Zoho ZeptoMail',
        url: 'https://api.zeptomail.in/v1.1/email'
    }
};

function normalizeProvider(v) {
    const p = String(v || '')
        .trim()
        .toLowerCase();
    return PROVIDERS[p] ? p : '';
}

function sanitizeEmailDisplayName(name) {
    return (
        String(name || 'Vaidya Gogate Memorial Foundation')
            .replace(/[\r\n<>"]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'Vaidya Gogate Memorial Foundation'
    );
}

function resolveFromAddress(o, rt) {
    return (
        integrationSettings.normalizeEmail(o.zoho_from || rt.zoho_from || process.env.ZOHO_FROM) ||
        integrationSettings.normalizeEmail(process.env.ZEPTOMAIL_FROM) ||
        integrationSettings.normalizeEmail(o.zoho_user || rt.zoho_user || process.env.ZOHO_USER) ||
        integrationSettings.normalizeEmail(process.env.MAIL_FROM) ||
        'noreply@seminar.vaidyagogate.org'
    );
}

function resolveProviderKey(provider, rawKey, rt) {
    let key = rawKey != null ? String(rawKey) : '';
    key = key.trim();
    if (integrationSettings.isMaskedSecretValue(key)) key = '';
    if (key) {
        if (provider === 'zeptomail') {
            const tok = emailProv.resolveZeptoMailKey(key);
            if (tok) return tok;
            key = '';
        } else {
            return key;
        }
    }

    if (provider === 'sender') {
        return String(process.env.SENDER_NET_API_TOKEN || process.env.SENDER_API_TOKEN || '').trim();
    }
    if (provider === 'brevo') return String(process.env.BREVO_API_KEY || '').trim();
    if (provider === 'resend') return String(process.env.RESEND_API_KEY || '').trim();
    if (provider === 'zeptomail') {
        for (const envName of ['ZEPTOMAIL_TOKEN', 'ZEPTOMAIL_API_KEY', 'EMAIL_API_KEY']) {
            const tok = emailProv.resolveZeptoMailKey(process.env[envName]);
            if (tok) return tok;
        }
        return '';
    }
    return '';
}

function resolveApiKeyForProvider(provider, rawKey, rt) {
    const p = normalizeProvider(provider);
    if (!p) return '';
    const keys = emailProv.parseProviderKeys((rt && rt.email_provider_keys) || {});
    if (keys[p] && String(keys[p]).trim() && !integrationSettings.isMaskedSecretValue(keys[p])) {
        const k = String(keys[p]).trim();
        if (p === 'zeptomail') {
            const tok = emailProv.resolveZeptoMailKey(k);
            if (tok) return tok;
        } else {
            return k;
        }
    }
    return resolveProviderKey(p, rawKey, rt);
}

const ZEPTO_REGION_URLS = {
    in: 'https://api.zeptomail.in/v1.1/email',
    com: 'https://api.zeptomail.com/v1.1/email',
    eu: 'https://api.zeptomail.eu/v1.1/email'
};

function getZeptoMailApiUrl(rt, overrides) {
    const o = overrides || {};
    if (process.env.ZEPTOMAIL_API_URL) return String(process.env.ZEPTOMAIL_API_URL).trim();
    const region = String(
        o.zeptomail_api_region || (rt && rt.zeptomail_api_region) || process.env.ZEPTOMAIL_API_REGION || 'in'
    ).toLowerCase();
    return ZEPTO_REGION_URLS[region] || ZEPTO_REGION_URLS.in;
}

function zeptoAlternateApiUrls(currentUrl) {
    const u = String(currentUrl || '').trim();
    return Object.values(ZEPTO_REGION_URLS).filter((url) => url !== u);
}

function providerApiUrl(provider, rt, overrides) {
    if (provider === 'zeptomail') return getZeptoMailApiUrl(rt, overrides);
    const meta = PROVIDERS[provider];
    return meta ? meta.url : '';
}

function buildConfigForProvider(provider, key, from, rt, overrides) {
    const p = normalizeProvider(provider);
    if (!p || !key || !from) return null;
    const normalizedKey = p === 'zeptomail' ? emailProv.resolveZeptoMailKey(key) || emailProv.normalizeZeptoMailToken(key) : key;
    if (p === 'zeptomail' && !normalizedKey) return null;
    return { provider: p, key: normalizedKey, from, apiUrl: providerApiUrl(p, rt, overrides) };
}

function getHttpEmailConfig(overrides, explicit) {
    const o = overrides || {};
    const rt = integrationSettings.getRuntimeIntegrations();
    if (!integrationSettings.flagEnabled(rt.email_primary_enabled, true)) return null;
    const provider = normalizeProvider(
        (explicit && explicit.provider) ||
            o.email_api_provider ||
            rt.email_api_provider ||
            process.env.EMAIL_API_PROVIDER ||
            'zeptomail'
    );
    const rawKey =
        explicit && explicit.key != null
            ? explicit.key
            : o.email_api_key != null
              ? o.email_api_key
              : rt.email_api_key || '';
    const key = resolveApiKeyForProvider(provider, rawKey, rt);
    if (!provider || !key) return null;
    const from = resolveFromAddress(o, rt);
    return buildConfigForProvider(provider, key, from, rt, o);
}

function getHttpFallbackConfig(overrides) {
    const o = overrides || {};
    const rt = integrationSettings.getRuntimeIntegrations();
    if (!integrationSettings.flagEnabled(rt.email_primary_enabled, true)) return null;
    if (!integrationSettings.flagEnabled(rt.email_fallback_enabled, true)) return null;
    const provider = normalizeProvider(
        o.email_api_fallback_provider ||
            rt.email_api_fallback_provider ||
            process.env.EMAIL_API_FALLBACK_PROVIDER ||
            ''
    );
    if (!provider) return null;
    const rawKey =
        o.email_api_fallback_key != null ? o.email_api_fallback_key : rt.email_api_fallback_key || '';
    const key = resolveApiKeyForProvider(provider, rawKey, rt);
    if (!key) return null;
    const from = resolveFromAddress(o, rt);
    return buildConfigForProvider(provider, key, from, rt, o);
}

function getHttpEmailProviderChain(overrides) {
    const primary = getHttpEmailConfig(overrides);
    const chain = [];
    if (primary) chain.push(primary);
    const fallback = getHttpFallbackConfig(overrides);
    if (fallback && (!primary || fallback.provider !== primary.provider || fallback.key !== primary.key)) {
        chain.push(fallback);
    }
    return chain;
}

function isHttpEmailConfigured(overrides) {
    return !!getHttpEmailConfig(overrides);
}

function isHttpQuotaOrLimitError(status, errMsg) {
    const s = Number(status) || 0;
    const m = String(errMsg || '').toLowerCase();
    if (s === 429 || s === 402 || s === 413) return true;
    return (
        m.includes('quota') ||
        m.includes('limit') ||
        m.includes('rate') ||
        m.includes('exceeded') ||
        m.includes('too many') ||
        m.includes('credit') ||
        m.includes('daily') ||
        m.includes('monthly') ||
        m.includes('insufficient')
    );
}

function shouldTryHttpFallback(result, chainIndex, chainLength) {
    if (!result || result.ok) return false;
    if (chainIndex >= chainLength - 1) return false;
    const rt = integrationSettings.getRuntimeIntegrations();
    if (!integrationSettings.flagEnabled(rt.email_fallback_enabled, true)) return false;
    return isHttpQuotaOrLimitError(result.httpStatus, result.error);
}

function attachmentBase64(content) {
    if (Buffer.isBuffer(content)) return content.toString('base64');
    return Buffer.from(String(content || ''), 'utf8').toString('base64');
}

function mapAttachments(provider, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return undefined;
    if (provider === 'sender') return undefined;
    if (provider === 'brevo') {
        return attachments.map((a) => ({
            content: attachmentBase64(a.content),
            name: a.filename || 'attachment'
        }));
    }
    if (provider === 'resend') {
        return attachments.map((a) => ({
            filename: a.filename || 'attachment',
            content: attachmentBase64(a.content)
        }));
    }
    if (provider === 'zeptomail') {
        return attachments.map((a) => ({
            content: attachmentBase64(a.content),
            mime_type: a.contentType || 'application/octet-stream',
            name: a.filename || 'attachment'
        }));
    }
    return undefined;
}

function buildPayload(cfg, to, subject, html, opts) {
    const display = sanitizeEmailDisplayName((opts && opts.fromDisplay) || 'Vaidya Gogate Memorial Foundation');
    const text = (opts && opts.text) || undefined;
    const attachments = mapAttachments(cfg.provider, opts && opts.attachments);
    const toEmail = String(to || '').trim();

    if (cfg.provider === 'sender') {
        const body = {
            from: { email: cfg.from, name: display },
            to: { email: toEmail },
            subject: subject || 'Notification',
            html: html || text || ''
        };
        if (text) body.text = text;
        const headers = {};
        if (opts && opts.replyTo) headers['Reply-To'] = String(opts.replyTo).trim();
        if (Object.keys(headers).length) body.headers = headers;
        if (Array.isArray(opts && opts.attachments) && opts.attachments.length) {
            console.warn('[email] Sender.net: skipping inline attachments (use public URLs).');
        }
        return body;
    }

    if (cfg.provider === 'brevo') {
        const body = {
            sender: { email: cfg.from, name: display },
            to: [{ email: toEmail }],
            subject: subject || 'Notification',
            htmlContent: html || text || ''
        };
        if (text) body.textContent = text;
        if (attachments) body.attachment = attachments;
        if (opts && opts.replyTo) body.replyTo = { email: String(opts.replyTo).trim() };
        return body;
    }

    if (cfg.provider === 'resend') {
        const body = {
            from: `"${display.replace(/"/g, "'")}" <${cfg.from}>`,
            to: [toEmail],
            subject: subject || 'Notification',
            html: html || undefined,
            text: text || undefined
        };
        if (attachments) body.attachments = attachments;
        if (opts && opts.replyTo) body.reply_to = String(opts.replyTo).trim();
        return body;
    }

    if (cfg.provider === 'zeptomail') {
        const toName =
            sanitizeEmailDisplayName((opts && opts.toName) || String(toEmail).split('@')[0] || 'Recipient');
        const body = {
            from: { address: cfg.from, name: display },
            to: [{ email_address: { address: toEmail, name: toName } }],
            subject: subject || 'Notification',
            htmlbody: html || text || ''
        };
        if (text && html) body.textbody = text;
        else if (text && !html) body.textbody = text;
        if (attachments) body.attachments = attachments;
        if (opts && opts.replyTo) {
            body.reply_to = [{ address: String(opts.replyTo).trim() }];
        }
        return body;
    }

    return null;
}

function zeptoAuthHeader(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (/^zoho-enczapikey\s/i.test(k)) return k;
    return 'Zoho-enczapikey ' + k;
}

function authHeaders(cfg) {
    if (cfg.provider === 'sender') {
        return {
            Authorization: 'Bearer ' + cfg.key,
            accept: 'application/json',
            'content-type': 'application/json'
        };
    }
    if (cfg.provider === 'brevo') {
        return { 'api-key': cfg.key, accept: 'application/json', 'content-type': 'application/json' };
    }
    if (cfg.provider === 'resend') {
        return { Authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json' };
    }
    if (cfg.provider === 'zeptomail') {
        return {
            Authorization: zeptoAuthHeader(cfg.key),
            accept: 'application/json',
            'content-type': 'application/json'
        };
    }
    return { 'content-type': 'application/json' };
}

function parseErrorResponse(provider, status, raw) {
    let msg = 'HTTP ' + status;
    try {
        const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (provider === 'sender' && j && j.message) msg = j.message;
        else if (provider === 'brevo' && j && j.message) msg = j.message;
        else if (provider === 'resend' && j && j.message) msg = j.message;
        else if (provider === 'zeptomail' && j && j.error && j.error.message) msg = j.error.message;
        else if (provider === 'zeptomail' && j && j.message) msg = j.message;
        else if (j && j.error) msg = String(j.error);
    } catch (_) {
        if (raw) msg = String(raw).slice(0, 300);
    }
    return msg;
}

async function sendEmailHttpWithConfig(cfg, to, subject, html, opts) {
    const meta = PROVIDERS[cfg.provider];
    const body = buildPayload(cfg, to, subject, html, opts);
    if (!body) return { ok: false, error: 'Unsupported email API provider' };

    const rt = integrationSettings.getRuntimeIntegrations();
    const sendOverrides = (opts && opts.smtpOverrides) || {};
    let apiUrl = cfg.apiUrl || providerApiUrl(cfg.provider, rt, sendOverrides);

    async function attempt(url) {
        const res = await fetch(url, {
            method: 'POST',
            headers: authHeaders(cfg),
            body: JSON.stringify(body)
        });
        const raw = await res.text();
        return { res, raw, url };
    }

    try {
        let { res, raw, url: usedUrl } = await attempt(apiUrl);
        if (
            !res.ok &&
            cfg.provider === 'zeptomail' &&
            (res.status === 401 || res.status === 403)
        ) {
            for (const altUrl of zeptoAlternateApiUrls(usedUrl)) {
                const retry = await attempt(altUrl);
                if (retry.res.ok) {
                    res = retry.res;
                    raw = retry.raw;
                    usedUrl = retry.url;
                    apiUrl = altUrl;
                    break;
                }
            }
        }
        if (res.ok) {
            return {
                ok: true,
                transport: 'http',
                provider: cfg.provider,
                from: cfg.from,
                zeptoApiUrl: cfg.provider === 'zeptomail' ? usedUrl : undefined
            };
        }
        const errMsg = parseErrorResponse(cfg.provider, res.status, raw);
        let hint = null;
        if (res.status === 401 || res.status === 403) {
            hint =
                cfg.provider === 'zeptomail'
                    ? 'Invalid ZeptoMail Send Mail token or wrong API region. ZeptoMail → Mail Agent → SMTP/API → Send Mail Token (not SMTP password). Match API region to your ZeptoMail login (.in / .com / .eu). If Render has stale ZEPTOMAIL_TOKEN or EMAIL_API_KEY env vars, remove them and save the token in Admin only.'
                    : cfg.provider === 'sender'
                      ? 'Invalid Sender.net API token.'
                      : 'Invalid API key for ' + meta.label + '. Paste the key again and Save.';
        } else if (isHttpQuotaOrLimitError(res.status, errMsg)) {
            hint =
                cfg.provider === 'zeptomail'
                    ? 'ZeptoMail quota/rate limit reached. Enable fallback provider in Admin only if needed.'
                    : 'Email API quota or rate limit reached.';
        } else if (String(errMsg).toLowerCase().includes('domain') || String(errMsg).toLowerCase().includes('verify')) {
            hint = 'Verify sender ' + cfg.from + ' in ' + meta.label + ' (domain/DKIM must be set up).';
        }
        return {
            ok: false,
            error: errMsg,
            hint,
            transport: 'http',
            provider: cfg.provider,
            httpStatus: res.status,
            zeptoApiUrl: cfg.provider === 'zeptomail' ? usedUrl : undefined
        };
    } catch (e) {
        return {
            ok: false,
            error: String((e && e.message) || e || 'HTTP send failed'),
            hint: 'Network error calling ' + meta.label + ' API.',
            transport: 'http',
            provider: cfg.provider
        };
    }
}

async function sendEmailHttp(to, subject, html, opts) {
    const chain = getHttpEmailProviderChain(opts && opts.smtpOverrides);
    if (!chain.length) {
        return { ok: false, skipped: true, error: 'HTTP email API not configured' };
    }

    let last = { ok: false, error: 'Send failed' };
    for (let i = 0; i < chain.length; i++) {
        const cfg = chain[i];
        const result = await sendEmailHttpWithConfig(cfg, to, subject, html, opts);
        if (result.ok) {
            if (i > 0) {
                return {
                    ...result,
                    fallback: cfg.provider,
                    primaryProvider: chain[0].provider,
                    primaryError: last.error
                };
            }
            return result;
        }
        last = result;
        if (shouldTryHttpFallback(result, i, chain.length)) {
            console.warn(
                '[email]',
                result.provider,
                'quota/limit — trying fallback',
                chain[i + 1].provider,
                ':',
                result.error
            );
            continue;
        }
        break;
    }
    return last;
}

module.exports = {
    PROVIDERS,
    ZEPTO_REGION_URLS,
    sanitizeEmailDisplayName,
    getZeptoMailApiUrl,
    getHttpEmailConfig,
    getHttpFallbackConfig,
    getHttpEmailProviderChain,
    isHttpEmailConfigured,
    isHttpQuotaOrLimitError,
    sendEmailHttp,
    sendEmailHttpWithConfig,
    normalizeProvider
};

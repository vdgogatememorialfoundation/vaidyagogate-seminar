/**
 * Send email over HTTPS (port 443) — works on Render free tier where SMTP 465/587 is blocked.
 * Providers: sender (Sender.net), brevo, resend, zeptomail
 */
const integrationSettings = require('./integration-settings');

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

function getHttpEmailConfig(overrides) {
    const o = overrides || {};
    const rt = integrationSettings.getRuntimeIntegrations();
    const provider = normalizeProvider(
        o.email_api_provider || rt.email_api_provider || process.env.EMAIL_API_PROVIDER || ''
    );
    let key = o.email_api_key != null ? String(o.email_api_key) : rt.email_api_key || '';
    if (!key) key = process.env.EMAIL_API_KEY || '';
    if (!key) {
        if (provider === 'sender') key = process.env.SENDER_NET_API_TOKEN || process.env.SENDER_API_TOKEN || '';
        else if (provider === 'brevo') key = process.env.BREVO_API_KEY || '';
        else if (provider === 'resend') key = process.env.RESEND_API_KEY || '';
        else if (provider === 'zeptomail') key = process.env.ZEPTOMAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || '';
    }
    key = key.trim();
    if (integrationSettings.isMaskedSecretValue(key)) {
        key = String(rt.email_api_key || '').trim();
        if (provider === 'sender' && !key) {
            key = String(process.env.SENDER_NET_API_TOKEN || process.env.SENDER_API_TOKEN || '').trim();
        }
        if (provider === 'brevo' && !key) key = String(process.env.BREVO_API_KEY || '').trim();
        if (provider === 'resend' && !key) key = String(process.env.RESEND_API_KEY || '').trim();
        if (provider === 'zeptomail' && !key) {
            key = String(process.env.ZEPTOMAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || '').trim();
        }
    }
    if (!provider || !key) return null;

    const from =
        integrationSettings.normalizeEmail(o.zoho_from || rt.zoho_from || process.env.ZOHO_FROM) ||
        integrationSettings.normalizeEmail(o.zoho_user || rt.zoho_user || process.env.ZOHO_USER) ||
        integrationSettings.normalizeEmail(process.env.MAIL_FROM);
    if (!from) return null;

    return { provider, key, from };
}

function isHttpEmailConfigured(overrides) {
    return !!getHttpEmailConfig(overrides);
}

function attachmentBase64(content) {
    if (Buffer.isBuffer(content)) return content.toString('base64');
    return Buffer.from(String(content || ''), 'utf8').toString('base64');
}

function mapAttachments(provider, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return undefined;
    if (provider === 'sender') {
        // Sender.net attachments require public URLs — inline/base64 not supported here.
        return undefined;
    }
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
    const display =
        (opts && opts.fromDisplay) || 'Vaidya Gogate Memorial Foundation';
    const text = (opts && opts.text) || undefined;
    const attachments = mapAttachments(cfg.provider, opts && opts.attachments);

    if (cfg.provider === 'sender') {
        const body = {
            from: { email: cfg.from, name: display },
            to: { email: String(to || '').trim() },
            subject: subject || 'Notification',
            html: html || text || ''
        };
        if (text) body.text = text;
        const headers = {};
        if (opts && opts.replyTo) headers['Reply-To'] = String(opts.replyTo).trim();
        if (Object.keys(headers).length) body.headers = headers;
        if (Array.isArray(opts && opts.attachments) && opts.attachments.length) {
            console.warn('[email] Sender.net: skipping inline attachments (use Zoho SMTP fallback or public URLs).');
        }
        return body;
    }

    if (cfg.provider === 'brevo') {
        const body = {
            sender: { email: cfg.from, name: display },
            to: [{ email: to }],
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
            from: `"${String(display).replace(/"/g, "'")}" <${cfg.from}>`,
            to: [to],
            subject: subject || 'Notification',
            html: html || undefined,
            text: text || undefined
        };
        if (attachments) body.attachments = attachments;
        if (opts && opts.replyTo) body.reply_to = String(opts.replyTo).trim();
        return body;
    }

    if (cfg.provider === 'zeptomail') {
        const body = {
            from: { address: cfg.from, name: display },
            to: [{ email_address: { address: to } }],
            subject: subject || 'Notification',
            htmlbody: html || text || ''
        };
        if (text && html) body.textbody = text;
        if (attachments) body.attachments = attachments;
        return body;
    }

    return null;
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
            Authorization: 'Zoho-enczapikey ' + cfg.key,
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
        else if (j && j.error) msg = String(j.error);
    } catch (_) {
        if (raw) msg = String(raw).slice(0, 300);
    }
    return msg;
}

async function sendEmailHttp(to, subject, html, opts) {
    const overrides = opts && opts.smtpOverrides;
    const cfg = getHttpEmailConfig(overrides);
    if (!cfg) {
        return { ok: false, skipped: true, error: 'HTTP email API not configured' };
    }
    const meta = PROVIDERS[cfg.provider];
    const body = buildPayload(cfg, to, subject, html, opts);
    if (!body) return { ok: false, error: 'Unsupported email API provider' };

    try {
        const res = await fetch(meta.url, {
            method: 'POST',
            headers: authHeaders(cfg),
            body: JSON.stringify(body)
        });
        const raw = await res.text();
        if (res.ok) {
            return { ok: true, transport: 'http', provider: cfg.provider, from: cfg.from };
        }
        const errMsg = parseErrorResponse(cfg.provider, res.status, raw);
        let hint = null;
        if (res.status === 401 || res.status === 403) {
            hint =
                cfg.provider === 'sender'
                    ? 'Invalid Sender.net API token. Settings → API access tokens, then Save in Admin.'
                    : 'Invalid API key for ' + meta.label + '. Paste the key again and Save.';
        } else if (String(errMsg).toLowerCase().includes('domain') || String(errMsg).toLowerCase().includes('verify')) {
            hint =
                'Verify sender ' +
                cfg.from +
                ' in your ' +
                meta.label +
                ' dashboard (domain/DKIM must be set up).';
        }
        return { ok: false, error: errMsg, hint, transport: 'http', provider: cfg.provider };
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

module.exports = {
    PROVIDERS,
    getHttpEmailConfig,
    isHttpEmailConfigured,
    sendEmailHttp,
    normalizeProvider
};

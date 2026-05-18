/**
 * Meta WhatsApp Cloud API
 * WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN (webhook)
 */
const axios = require('axios');
const integrationSettings = require('./integration-settings');

function waCfg() {
    return integrationSettings.getWhatsAppConfig();
}

function isWhatsAppConfigured() {
    return integrationSettings.isWhatsAppConfiguredFromSettings();
}

function sanitizeWhatsAppTemplateName(name) {
    return String(name || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
}

function normalizePhoneE164(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (digits.startsWith('91') && digits.length === 12) return digits;
    if (digits.length === 10) return '91' + digits;
    if (digits.startsWith('91') && digits.length > 12) return digits.slice(0, 12);
    return digits;
}

async function postWhatsAppMessage(payload) {
    if (!isWhatsAppConfigured()) {
        return { ok: false, skipped: true, error: 'WhatsApp not configured' };
    }
    const { token, phoneNumberId: phoneId } = waCfg();
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    try {
        const res = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });
        const messageId =
            res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id
                ? res.data.messages[0].id
                : null;
        return { ok: true, messageId, raw: res.data };
    } catch (e) {
        const msg = formatWhatsAppError(e);
        console.error('[whatsapp]', msg);
        return { ok: false, error: msg, raw: e.response && e.response.data };
    }
}

/**
 * Send approved template message.
 * @param {string} phone E.164 without +
 * @param {string} templateName Meta template name
 * @param {string[]} [bodyParams] positional body parameters
 */
async function sendWhatsAppTemplate(phone, templateName, bodyParams) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const { templateLang } = waCfg();
    const components = [];
    if (bodyParams && bodyParams.length) {
        components.push({
            type: 'body',
            parameters: bodyParams.map((t) => ({ type: 'text', text: String(t).slice(0, 1024) }))
        });
    }
    return postWhatsAppMessage({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: templateLang || 'en' },
            components: components.length ? components : undefined
        }
    });
}

function whatsappLangCandidates(primary) {
    const out = [];
    const add = (c) => {
        const x = String(c || '').trim();
        if (x && !out.includes(x)) out.push(x);
    };
    add(primary || 'en');
    add('en_US');
    add('en_IN');
    add('en_GB');
    add('en');
    return out;
}

function isTemplateTranslationError(errMsg) {
    const s = String(errMsg || '').toLowerCase();
    return s.includes('132001') || s.includes('does not exist in the translation');
}

/** Authentication / OTP templates (body + copy/url button). */
async function sendWhatsAppOtpTemplate(phone, templateName, code) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    if (!tplName) return { ok: false, error: 'WhatsApp template name is empty' };
    const { templateLang } = waCfg();
    const otp = String(code || '').slice(0, 32);
    const langCandidates = whatsappLangCandidates(templateLang);

    // Authentication templates like vgmf_otp_auth: only {{1}} in body — no button components.
    const attempts = [
        {
            label: 'body_only',
            components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }]
        }
    ];

    let last = { ok: false, error: 'Template send failed', template: tplName };
    for (const langCode of langCandidates) {
        for (const attempt of attempts) {
            const r = await postWhatsAppMessage({
                messaging_product: 'whatsapp',
                to,
                type: 'template',
                template: {
                    name: tplName,
                    language: { code: langCode },
                    components: attempt.components
                }
            });
            if (r.ok) {
                return Object.assign({ method: attempt.label, lang: langCode, template: tplName }, r);
            }
            last = Object.assign({ method: attempt.label, lang: langCode, template: tplName }, r);
            const err = String(r.error || '').toLowerCase();
            if (isTemplateTranslationError(r.error)) continue;
            if (err.includes('template') && (err.includes('not found') || err.includes('does not exist'))) {
                return last;
            }
        }
    }
    return last;
}

/** Plain text (session / utility). Works within 24h window or with allowed messaging. */
async function sendWhatsAppText(phone, body) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    return postWhatsAppMessage({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: String(body).slice(0, 4096) }
    });
}

function formatWhatsAppError(e) {
    const data = e.response && e.response.data;
    const raw = (data && JSON.stringify(data)) || e.message || 'WhatsApp send failed';
    const lower = String(raw).toLowerCase();
    if (lower.includes('invalid oauth') || lower.includes('access token')) {
        return (
            'Invalid access token. Use a permanent System User token from Meta Business Settings — NOT the App Secret. Raw: ' +
            raw
        );
    }
    if (lower.includes('131047') || lower.includes('re-engagement') || lower.includes('24 hour')) {
        return (
            'Outside the 24-hour window. Use an approved OTP template (OTP_VERIFICATION → Meta template name), ' +
            'or message your business number first. Raw: ' +
            raw
        );
    }
    if (lower.includes('131030') || lower.includes('not in allowed') || lower.includes('recipient')) {
        return (
            'Recipient not allowed. In Meta App → WhatsApp → API Setup, add this phone as a test number (development mode), ' +
            'or publish the app. Raw: ' +
            raw
        );
    }
    if (lower.includes('131026') || lower.includes('not a valid whatsapp')) {
        return 'This number is not registered on WhatsApp. Raw: ' + raw;
    }
    if (lower.includes('132001') || lower.includes('does not exist in the translation')) {
        return (
            'Template name or language code does not match Meta. Open WhatsApp Manager → your template → copy exact name and language (e.g. en_US not en). Raw: ' +
            raw
        );
    }
    if (lower.includes('132000') || lower.includes('parameter')) {
        return (
            'Template parameter mismatch — check body/button variables match Meta. Raw: ' +
            raw
        );
    }
    return String(raw);
}

module.exports = {
    isWhatsAppConfigured,
    sendWhatsAppTemplate,
    sendWhatsAppOtpTemplate,
    sendWhatsAppText,
    normalizePhoneE164,
    sanitizeWhatsAppTemplateName,
    formatWhatsAppError
};

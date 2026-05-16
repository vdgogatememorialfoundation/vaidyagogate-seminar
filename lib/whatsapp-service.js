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

function normalizePhoneE164(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return '91' + digits;
    if (digits.startsWith('91') && digits.length === 12) return digits;
    return digits;
}

/**
 * Send approved template message.
 * @param {string} phone E.164 without +
 * @param {string} templateName Meta template name
 * @param {string[]} [bodyParams] positional body parameters
 */
async function sendWhatsAppTemplate(phone, templateName, bodyParams) {
    if (!isWhatsAppConfigured()) {
        return { ok: false, skipped: true, error: 'WhatsApp not configured' };
    }
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const { token, phoneNumberId: phoneId, templateLang } = waCfg();
    const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    const components = [];
    if (bodyParams && bodyParams.length) {
        components.push({
            type: 'body',
            parameters: bodyParams.map((t) => ({ type: 'text', text: String(t).slice(0, 1024) }))
        });
    }
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: templateLang || 'en' },
            components: components.length ? components : undefined
        }
    };
    try {
        await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });
        return { ok: true };
    } catch (e) {
        const msg = (e.response && e.response.data && JSON.stringify(e.response.data)) || e.message;
        console.error('[whatsapp] template', msg);
        return { ok: false, error: String(msg) };
    }
}

/** Plain text (session / utility). Works within 24h window or with allowed messaging. */
async function sendWhatsAppText(phone, body) {
    if (!isWhatsAppConfigured()) {
        return { ok: false, skipped: true, error: 'WhatsApp not configured' };
    }
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const { token, phoneNumberId: phoneId, templateLang } = waCfg();
    const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
    try {
        await axios.post(
            url,
            {
                messaging_product: 'whatsapp',
                to,
                type: 'text',
                text: { body: String(body).slice(0, 4096) }
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            }
        );
        return { ok: true };
    } catch (e) {
        const msg = (e.response && e.response.data && JSON.stringify(e.response.data)) || e.message;
        console.error('[whatsapp] text', msg);
        return { ok: false, error: String(msg) };
    }
}

module.exports = {
    isWhatsAppConfigured,
    sendWhatsAppTemplate,
    sendWhatsAppText,
    normalizePhoneE164
};

/**
 * Meta WhatsApp Cloud API
 * WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN (webhook)
 * Optional: WHATSAPP_BUSINESS_ACCOUNT_ID (WABA) for template lookup
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

function templateLanguageCode(t) {
    if (!t) return '';
    if (typeof t.language === 'string') return t.language;
    if (t.language && t.language.code) return t.language.code;
    return '';
}

async function resolveWabaId() {
    const { token, phoneNumberId, businessAccountId } = waCfg();
    if (businessAccountId) return String(businessAccountId).trim();
    if (!token) return null;

    if (phoneNumberId) {
        try {
            const pnRes = await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    fields: 'id,display_phone_number,verified_name,whatsapp_business_account'
                },
                timeout: 15000
            });
            let waba = pnRes.data && pnRes.data.whatsapp_business_account;
            if (waba && typeof waba === 'object' && waba.id) return String(waba.id);
            if (typeof waba === 'string' && waba) return waba;
        } catch (e) {
            console.warn('[whatsapp] resolveWabaId phone', (e.response && e.response.data) || e.message);
        }
    }

    try {
        const bizRes = await axios.get('https://graph.facebook.com/v21.0/me/businesses', {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,name', limit: 25 },
            timeout: 15000
        });
        for (const biz of bizRes.data?.data || []) {
            try {
                const wabaRes = await axios.get(
                    `https://graph.facebook.com/v21.0/${biz.id}/owned_whatsapp_business_accounts`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        params: { fields: 'id,name', limit: 10 },
                        timeout: 15000
                    }
                );
                const wabas = wabaRes.data?.data || [];
                if (wabas.length === 1) return String(wabas[0].id);
                if (wabas.length > 1) return String(wabas[0].id);
            } catch (_) {}
        }
    } catch (e) {
        console.warn('[whatsapp] resolveWabaId businesses', (e.response && e.response.data) || e.message);
    }

    return null;
}

async function listMessageTemplatesOnWaba(wabaId) {
    const { token } = waCfg();
    if (!token || !wabaId) return [];
    const all = [];
    let url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
    let params = { limit: 100 };
    for (let page = 0; page < 5; page++) {
        const res = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            params,
            timeout: 20000
        });
        all.push(...(res.data?.data || []));
        const next = res.data?.paging?.next;
        if (!next) break;
        url = next;
        params = {};
    }
    return all;
}

/** Read approved language codes for a template from Meta (exact name match on WABA). */
async function fetchTemplateLanguageCodes(templateName) {
    const dbg = await debugWhatsAppTemplateLookup(templateName);
    return dbg.languages || [];
}

/** Admin diagnostics: is template on the same WABA as the configured phone number? */
async function debugWhatsAppTemplateLookup(templateName) {
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    const { phoneNumberId } = waCfg();
    const wabaId = await resolveWabaId();
    const out = {
        templateName: tplName,
        phoneNumberId: phoneNumberId || '',
        wabaId: wabaId || '',
        languages: [],
        templates: [],
        otpLikeNames: [],
        error: null,
        hint: null
    };

    if (!wabaId) {
        out.error = 'Could not resolve WhatsApp Business Account ID (WABA).';
        out.hint =
            'In Meta → WhatsApp Manager → Account tools → Account overview, copy WhatsApp Business Account ID and paste it in admin → WhatsApp Business Account ID, then Save.';
        return out;
    }

    try {
        const all = await listMessageTemplatesOnWaba(wabaId);
        const matches = all.filter((t) => t.name === tplName);
        out.templates = matches.map((t) => ({
            name: t.name,
            language: templateLanguageCode(t),
            status: t.status,
            category: t.category
        }));
        out.languages = [...new Set(matches.map((t) => templateLanguageCode(t)).filter(Boolean))];
        out.otpLikeNames = all
            .filter((t) => t.name && /otp|auth|verify/i.test(t.name))
            .map((t) => `${t.name} (${templateLanguageCode(t)}, ${t.status})`)
            .slice(0, 15);

        if (!matches.length) {
            out.error =
                'Template "' + tplName + '" was NOT found on WABA ' + wabaId + ' linked to your Phone number ID.';
            out.hint =
                'Create the template on this account, or change Phone number ID to the number from the same Meta business where vgmf_otp_auth exists. OTP-like templates on this WABA: ' +
                (out.otpLikeNames.length ? out.otpLikeNames.join('; ') : '(none found)');
        } else if (!out.languages.length) {
            out.error = 'Template found but no language code returned from Meta.';
        }
    } catch (e) {
        out.error = JSON.stringify((e.response && e.response.data) || e.message);
        out.hint = 'Check token has whatsapp_business_management permission and WABA ID is correct.';
    }

    return out;
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
    const p = String(primary || '').trim() || 'en';
    const out = [];
    const add = (c) => {
        const x = String(c || '').trim();
        if (x && !out.includes(x)) out.push(x);
    };
    add(p);
    add('en');
    add('en_US');
    add('en_IN');
    if (p === 'en_GB') add('en_GB');
    return out;
}

function isTemplateTranslationError(errMsg) {
    const s = String(errMsg || '').toLowerCase();
    return s.includes('132001') || s.includes('does not exist in the translation');
}

async function sendWhatsAppOtpTemplate(phone, templateName, code) {
    const to = normalizePhoneE164(phone);
    if (!to) return { ok: false, error: 'Invalid phone' };
    const tplName = sanitizeWhatsAppTemplateName(templateName);
    if (!tplName) return { ok: false, error: 'WhatsApp template name is empty' };
    const { templateLang, phoneNumberId } = waCfg();
    const otp = String(code || '').slice(0, 32);

    const dbg = await debugWhatsAppTemplateLookup(tplName);
    const metaLangs = dbg.languages || [];
    const fallbackLangs = whatsappLangCandidates(templateLang);
    const langCandidates = metaLangs.length
        ? [...metaLangs, ...fallbackLangs.filter((l) => !metaLangs.includes(l))]
        : fallbackLangs;

    if (!metaLangs.length && dbg.error) {
        return {
            ok: false,
            error: dbg.error + (dbg.hint ? ' ' + dbg.hint : ''),
            template: tplName,
            metaLangs: [],
            triedLangs: [],
            wabaId: dbg.wabaId,
            phoneNumberId
        };
    }

    const attempts = [
        {
            label: 'body_only',
            components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }]
        }
    ];

    const triedLangs = [];
    let last = { ok: false, error: 'Template send failed', template: tplName, metaLangs, wabaId: dbg.wabaId };
    for (const langCode of langCandidates) {
        triedLangs.push(langCode);
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
                return Object.assign(
                    { method: attempt.label, lang: langCode, template: tplName, metaLangs, triedLangs, wabaId: dbg.wabaId },
                    r
                );
            }
            last = Object.assign(
                { method: attempt.label, lang: langCode, template: tplName, metaLangs, triedLangs, wabaId: dbg.wabaId },
                r
            );
            if (isTemplateTranslationError(r.error)) continue;
        }
    }

    if (isTemplateTranslationError(last.error)) {
        last.error =
            metaLangs.length > 0
                ? 'Template "' +
                  tplName +
                  '" failed for languages: ' +
                  triedLangs.join(', ') +
                  '. Meta reports: ' +
                  metaLangs.join(', ') +
                  '. WABA ' +
                  (dbg.wabaId || '?') +
                  ' Phone ID ' +
                  (phoneNumberId || '?') +
                  '.'
                : 'Template "' +
                  tplName +
                  '" is not on the WhatsApp account for Phone number ID ' +
                  (phoneNumberId || '?') +
                  '. ' +
                  (dbg.hint || 'Paste WhatsApp Business Account ID in admin and click Check template on Meta.');
    }
    return last;
}

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
            'Outside the 24-hour window. Use an approved OTP template or message your business number first. Raw: ' +
            raw
        );
    }
    if (lower.includes('131030') || lower.includes('not in allowed') || lower.includes('recipient')) {
        return (
            'Recipient not allowed. Add this phone as a Meta test number (development mode). Raw: ' +
            raw
        );
    }
    if (lower.includes('131026') || lower.includes('not a valid whatsapp')) {
        return 'This number is not registered on WhatsApp. Raw: ' + raw;
    }
    if (lower.includes('132001') || lower.includes('does not exist in the translation')) {
        return (
            'Template not on this Phone number / WABA, or wrong language code. Use Check template on Meta in admin. Raw: ' +
            raw
        );
    }
    if (lower.includes('132000') || lower.includes('parameter')) {
        return 'Template parameter mismatch. Raw: ' + raw;
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
    fetchTemplateLanguageCodes,
    debugWhatsAppTemplateLookup,
    resolveWabaId,
    formatWhatsAppError
};

/**
 * AiSensy WhatsApp provider.
 *
 * Campaign API (documented at wiki.aisensy.com → "API Reference Docs"):
 *   POST https://backend.aisensy.com/campaign/t1/api/v2
 *   { apiKey, campaignName, destination, userName, source, media:{url,filename}, templateParams:[...], tags, attributes }
 *   destination must be +<country code><number> for non-Indian numbers (Indian numbers may omit +91).
 *   The campaign must be a *live API campaign* in AiSensy bound to an approved template.
 *
 * Project API (aisensy.stoplight.io "Project API"): https://apis.aisensy.com/project-apis/v1/project/{projectId}/...
 *   with header X-AiSensy-Project-API-Pwd — used here only to list API campaigns for the admin UI.
 *
 * Meta template names are mapped to AiSensy campaign names via `aisensy_campaign_map`
 * (one "template=campaign" per line); unmapped templates use the template name as campaign name.
 */
const axios = require('axios');
const integrationSettings = require('./integration-settings');

const CAMPAIGN_API_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';
const PROJECT_API_BASE = 'https://apis.aisensy.com';
const TIMEOUT_MS = 15000;

function cfg() {
    return integrationSettings.getAisensyConfig();
}

function isAisensyConfigured() {
    return !!cfg().apiKey;
}

/** True when AiSensy is the selected outbound WhatsApp provider and has an API key. */
function isAisensyActive() {
    const c = cfg();
    return c.provider === 'aisensy' && !!c.apiKey;
}

function toDestination(phone) {
    const raw = String(phone || '').trim();
    let digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    const explicitIntl = /^\+/.test(raw) || /^00[1-9]/.test(raw);
    if (explicitIntl) {
        if (/^00/.test(raw)) digits = digits.replace(/^00/, '');
        return '+' + digits;
    }
    digits = digits.replace(/^0+/, '');
    if (digits.length === 10) return '+91' + digits;
    if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
    return '+' + digits;
}

function parseCampaignMap(text) {
    const out = {};
    const src = text == null ? '' : text;
    if (typeof src === 'object') {
        Object.keys(src).forEach((k) => {
            if (src[k]) out[String(k).trim().toLowerCase()] = String(src[k]).trim();
        });
        return out;
    }
    const s = String(src).trim();
    if (!s) return out;
    if (s.startsWith('{')) {
        try {
            return parseCampaignMap(JSON.parse(s));
        } catch (_) {
            return out;
        }
    }
    s.split(/\r?\n|,/).forEach((line) => {
        const m = String(line).split(/[=:]/);
        if (m.length >= 2) {
            const k = m[0].trim().toLowerCase();
            const v = m.slice(1).join('=').trim();
            if (k && v) out[k] = v;
        }
    });
    return out;
}

function campaignForTemplate(templateName) {
    const name = String(templateName || '').trim();
    if (!name) return '';
    const map = parseCampaignMap(cfg().campaignMap);
    return map[name.toLowerCase()] || name;
}

function formatAisensyError(e) {
    if (!e) return 'Unknown AiSensy error';
    if (e.response) {
        const d = e.response.data;
        let msg = '';
        if (d && typeof d === 'object') msg = d.errorMessage || d.message || d.error || JSON.stringify(d);
        else if (d) msg = String(d);
        return `AiSensy HTTP ${e.response.status}${msg ? ': ' + String(msg).slice(0, 400) : ''}`;
    }
    if (e.code === 'ECONNABORTED') return 'AiSensy request timed out';
    return 'AiSensy: ' + (e.message || String(e));
}

/**
 * Send one API-campaign message.
 * @param {{phone:string, campaignName:string, userName?:string, templateParams?:string[], media?:{url:string,filename?:string}, source?:string, tags?:string[], attributes?:object}} p
 */
async function sendAisensyCampaign(p) {
    const c = cfg();
    if (!c.apiKey) return { ok: false, error: 'AiSensy API key not configured' };
    const destination = toDestination(p.phone);
    if (!destination || destination.length < 8) return { ok: false, error: 'Invalid phone' };
    const campaignName = String(p.campaignName || '').trim();
    if (!campaignName) return { ok: false, error: 'AiSensy campaign name missing' };

    const body = {
        apiKey: c.apiKey,
        campaignName,
        destination,
        userName: String(p.userName || 'Participant').trim() || 'Participant',
        source: String(p.source || c.source || 'VGMF Seminar Portal')
    };
    const params = Array.isArray(p.templateParams) ? p.templateParams.map((v) => String(v == null ? '' : v)) : [];
    if (params.length) body.templateParams = params;
    if (p.media && p.media.url) {
        body.media = { url: String(p.media.url), filename: String(p.media.filename || 'file') };
    }
    if (Array.isArray(p.tags) && p.tags.length) body.tags = p.tags.map(String);
    if (p.attributes && typeof p.attributes === 'object' && Object.keys(p.attributes).length) body.attributes = p.attributes;

    try {
        const r = await axios.post(CAMPAIGN_API_URL, body, {
            timeout: TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json' }
        });
        const d = r.data || {};
        if (d && typeof d === 'object' && d.success === false) {
            return { ok: false, error: 'AiSensy: ' + String(d.errorMessage || d.message || 'rejected').slice(0, 400), raw: d };
        }
        const messageId =
            (d && (d.submitted_message_id || d.messageId || d.message_id || d.id)) || null;
        return { ok: true, messageId, provider: 'aisensy', campaignName, destination, raw: d };
    } catch (e) {
        return { ok: false, error: formatAisensyError(e), provider: 'aisensy', campaignName, destination };
    }
}

/** Meta-style template send → AiSensy campaign named after the template (or mapped). */
async function sendAisensyTemplate(phone, templateName, bodyParams, opts) {
    const o = opts || {};
    const campaignName = campaignForTemplate(templateName);
    return sendAisensyCampaign({
        phone,
        campaignName,
        userName: o.userName,
        templateParams: Array.isArray(bodyParams) ? bodyParams : [],
        media: o.media,
        source: o.source
    });
}

/** Free text is not supported by API campaigns; route through a one-variable "text" campaign. */
async function sendAisensyText(phone, text, opts) {
    const c = cfg();
    if (!c.textCampaign) {
        return {
            ok: false,
            error: 'AiSensy: set "Text campaign" (template with a single {{1}} body variable) in Integrations to send plain messages'
        };
    }
    return sendAisensyCampaign({
        phone,
        campaignName: c.textCampaign,
        userName: opts && opts.userName,
        templateParams: [String(text || '').slice(0, 1024)]
    });
}

async function sendAisensyOtp(phone, templateName, code) {
    const c = cfg();
    const campaignName = c.otpCampaign || campaignForTemplate(templateName);
    if (!campaignName) return { ok: false, error: 'AiSensy: OTP campaign not configured' };
    return sendAisensyCampaign({ phone, campaignName, templateParams: [String(code)] });
}

/** Document/image with a caption → "media" campaign (template with media header + one body variable). */
async function sendAisensyMedia(phone, media, opts) {
    const c = cfg();
    const m = media || {};
    const campaignName = (opts && opts.campaignName) || c.mediaCampaign;
    if (!campaignName) {
        return { ok: false, error: 'AiSensy: set "Media campaign" in Integrations to send documents/images' };
    }
    return sendAisensyCampaign({
        phone,
        campaignName,
        userName: opts && opts.userName,
        templateParams: m.caption ? [String(m.caption).slice(0, 1024)] : [],
        media: { url: m.link || m.url, filename: m.filename || 'file' }
    });
}

/** Project API: list API campaigns (needs Project ID + Project API password). */
async function listAisensyApiCampaigns() {
    const c = cfg();
    if (!c.projectId || !c.projectApiPwd) {
        return { ok: false, error: 'Project ID and Project API password are required to list campaigns' };
    }
    try {
        const r = await axios.get(
            `${PROJECT_API_BASE}/project-apis/v1/project/${encodeURIComponent(c.projectId)}/campaign/api`,
            { timeout: TIMEOUT_MS, headers: { 'X-AiSensy-Project-API-Pwd': c.projectApiPwd, Accept: 'application/json' } }
        );
        const d = r.data || {};
        const list = Array.isArray(d) ? d : d.campaign || d.campaigns || [];
        return {
            ok: true,
            campaigns: list.map((x) => ({
                id: x.id || x._id || '',
                name: x.name || x.campaignName || '',
                status: x.status || '',
                type: x.message_type || x.type || '',
                template:
                    (x.message_payload && x.message_payload.template && x.message_payload.template.name) ||
                    x.templateName ||
                    ''
            }))
        };
    } catch (e) {
        return { ok: false, error: formatAisensyError(e) };
    }
}

function getAisensyStatus() {
    const c = cfg();
    const missing = [];
    if (!c.apiKey) missing.push('AiSensy API key');
    return {
        configured: missing.length === 0,
        active: isAisensyActive(),
        provider: c.provider,
        missing,
        otpCampaign: c.otpCampaign || '',
        textCampaign: c.textCampaign || '',
        mediaCampaign: c.mediaCampaign || '',
        projectApi: !!(c.projectId && c.projectApiPwd)
    };
}

module.exports = {
    CAMPAIGN_API_URL,
    isAisensyConfigured,
    isAisensyActive,
    toDestination,
    parseCampaignMap,
    campaignForTemplate,
    sendAisensyCampaign,
    sendAisensyTemplate,
    sendAisensyText,
    sendAisensyOtp,
    sendAisensyMedia,
    listAisensyApiCampaigns,
    getAisensyStatus,
    formatAisensyError
};

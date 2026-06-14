/**
 * MSG91 SMS — transactional status updates and OTP (India DLT flow / OTP templates).
 * Env: MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_ROUTE, MSG91_DEFAULT_FLOW_ID, MSG91_OTP_TEMPLATE_ID
 */
const axios = require('axios');
const integrationSettings = require('./integration-settings');

function msg91Cfg() {
    return integrationSettings.getMsg91Config();
}

function isMsg91Configured() {
    return integrationSettings.isMsg91ConfiguredFromSettings();
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

function plainTextForSms(raw) {
    if (!raw) return '';
    return String(raw)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateSms(text, max) {
    const lim = max || 480;
    const s = String(text || '').trim();
    if (s.length <= lim) return s;
    return s.slice(0, lim - 1) + '…';
}

function getEventFlowId(eventKey) {
    const cfg = msg91Cfg();
    const map =
        cfg.eventFlows && typeof cfg.eventFlows === 'object' ? cfg.eventFlows : {};
    const row = map[String(eventKey || '').trim()];
    if (row && row.flow_id) return String(row.flow_id).trim();
    if (row && typeof row === 'string') return row.trim();
    return '';
}

function flowMessageVarName() {
    return String(msg91Cfg().flowMessageVar || process.env.MSG91_FLOW_MESSAGE_VAR || 'VAR1').trim() || 'VAR1';
}

async function postMsg91(url, body, timeout) {
    const cfg = msg91Cfg();
    if (!cfg.authKey) {
        return { ok: false, skipped: true, error: 'MSG91 auth key not configured' };
    }
    try {
        const res = await axios.post(url, body, {
            headers: {
                authkey: cfg.authKey,
                'Content-Type': 'application/json'
            },
            timeout: timeout || 20000,
            validateStatus: () => true
        });
        const data = res.data;
        if (typeof data === 'string' && /^(4\d\d|5\d\d)/.test(data.trim())) {
            return { ok: false, error: data.trim() };
        }
        if (data && (data.type === 'error' || data.message === 'Invalid Auth Key')) {
            return { ok: false, error: (data.message || data.type || 'MSG91 error') + '' };
        }
        const reqId =
            (data && (data.request_id || data.message || data.type)) ||
            (typeof data === 'string' ? data : '');
        return { ok: true, requestId: String(reqId || ''), raw: data };
    } catch (e) {
        const err = (e.response && e.response.data) || e.message;
        return { ok: false, error: typeof err === 'object' ? JSON.stringify(err) : String(err) };
    }
}

async function sendMsg91Flow(phone, flowId, vars, senderId) {
    const mobile = normalizePhoneE164(phone);
    if (!mobile) return { ok: false, error: 'Invalid mobile number' };
    const cfg = msg91Cfg();
    const recipient = Object.assign({ mobiles: mobile }, vars || {});
    const body = {
        flow_id: flowId,
        sender: senderId || cfg.senderId || 'VGOMF',
        recipients: [recipient]
    };
    if (cfg.route) body.route = cfg.route;
    return postMsg91('https://control.msg91.com/api/v5/flow/', body);
}

async function sendMsg91Http(phone, message) {
    const cfg = msg91Cfg();
    const mobile = normalizePhoneE164(phone);
    if (!mobile) return { ok: false, error: 'Invalid mobile number' };
    if (!cfg.senderId) return { ok: false, error: 'MSG91 sender ID required for direct SMS' };
    try {
        const res = await axios.get('https://control.msg91.com/api/sendhttp.php', {
            params: {
                authkey: cfg.authKey,
                mobiles: mobile,
                message: truncateSms(message),
                sender: cfg.senderId,
                route: cfg.route || '4',
                country: cfg.country || '91'
            },
            timeout: 20000,
            validateStatus: () => true
        });
        const text = String(res.data || '').trim();
        if (!text || /error|invalid/i.test(text)) {
            return { ok: false, error: text || 'MSG91 send failed' };
        }
        return { ok: true, requestId: text };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Send transactional SMS for status updates.
 * Uses per-event flow_id, default flow_id, or HTTP fallback.
 */
async function sendMsg91Sms(phone, message, opts) {
    opts = opts || {};
    if (!isMsg91Configured()) {
        return { ok: false, skipped: true, error: 'MSG91 not configured' };
    }
    const text = truncateSms(plainTextForSms(message));
    if (!text) return { ok: false, error: 'Empty SMS body' };

    const flowId =
        opts.flowId ||
        getEventFlowId(opts.eventKey) ||
        msg91Cfg().defaultFlowId ||
        '';

    if (flowId) {
        const varName = flowMessageVarName();
        const vars = opts.vars && typeof opts.vars === 'object' ? { ...opts.vars } : {};
        if (!vars[varName]) vars[varName] = text;
        if (!vars.message) vars.message = text;
        const r = await sendMsg91Flow(phone, flowId, vars);
        if (r.ok) return r;
        if (!opts.allowHttpFallback) return r;
    }

    return sendMsg91Http(phone, text);
}

/** Send OTP via MSG91 OTP API (DLT template). */
async function sendMsg91Otp(phone, otp, templateId) {
    if (!isMsg91Configured()) {
        return { ok: false, skipped: true, error: 'MSG91 not configured' };
    }
    const mobile = normalizePhoneE164(phone);
    if (!mobile) return { ok: false, error: 'Invalid mobile number' };
    const tpl = String(templateId || msg91Cfg().otpTemplateId || '').trim();
    if (!tpl) {
        const body = 'Your verification code is ' + String(otp) + '. Do not share it with anyone.';
        return sendMsg91Sms(phone, body, { allowHttpFallback: true });
    }
    return postMsg91('https://control.msg91.com/api/v5/otp', {
        template_id: tpl,
        mobile: mobile,
        otp: String(otp)
    });
}

async function sendMsg91Test(phone, message) {
    const sample =
        message ||
        'VGMF test SMS from seminar portal. If you received this, MSG91 is configured correctly.';
    return sendMsg91Sms(phone, sample, { allowHttpFallback: true, eventKey: 'ADMIN_TEST' });
}

module.exports = {
    msg91Cfg,
    isMsg91Configured,
    normalizePhoneE164,
    plainTextForSms,
    truncateSms,
    getEventFlowId,
    sendMsg91Sms,
    sendMsg91Otp,
    sendMsg91Test,
    sendMsg91Flow,
    sendMsg91Http
};

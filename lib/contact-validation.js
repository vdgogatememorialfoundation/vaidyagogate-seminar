/**
 * Email and Indian mobile validation (reject partial values like "gmail" or 8-digit numbers).
 */

const EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const BARE_PROVIDER_WORDS = new Set([
    'gmail',
    'yahoo',
    'hotmail',
    'outlook',
    'rediffmail',
    'icloud',
    'protonmail',
    'live'
]);

function normalizeIndianPhoneDigits(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
}

function validateEmail(email, fieldLabel) {
    const label = fieldLabel || 'Email';
    const raw = String(email || '').trim();
    if (!raw) {
        return { valid: false, message: `${label} is required` };
    }
    const lower = raw.toLowerCase();
    if (BARE_PROVIDER_WORDS.has(lower)) {
        return {
            valid: false,
            message: `Enter your full ${label.toLowerCase()} (e.g. yourname@gmail.com), not just "${raw}"`
        };
    }
    if (!lower.includes('@')) {
        return {
            valid: false,
            message: `Enter a complete ${label.toLowerCase()} with @ and domain (e.g. yourname@gmail.com)`
        };
    }
    const at = lower.indexOf('@');
    const local = lower.slice(0, at);
    const domain = lower.slice(at + 1);
    if (!local || !domain) {
        return {
            valid: false,
            message: `Enter a complete ${label.toLowerCase()} (e.g. yourname@gmail.com)`
        };
    }
    if (!domain.includes('.')) {
        return {
            valid: false,
            message: `Enter a complete ${label.toLowerCase()} including domain (e.g. yourname@gmail.com)`
        };
    }
    const tld = domain.split('.').pop();
    if (!tld || tld.length < 2) {
        return {
            valid: false,
            message: `Enter a valid ${label.toLowerCase()} with a proper domain ending (e.g. .com, .in)`
        };
    }
    if (!EMAIL_RE.test(lower)) {
        return {
            valid: false,
            message: `Enter a valid ${label.toLowerCase()} (e.g. yourname@gmail.com)`
        };
    }
    return { valid: true, cleanedEmail: lower };
}

function validatePhone(phone, fieldLabel, options) {
    const opts = options || {};
    const label = fieldLabel || 'Phone';
    const raw = String(phone || '').trim();
    if (!raw) {
        if (opts.required === false) return { valid: true, cleanedPhone: '' };
        return { valid: false, message: `${label} is required` };
    }
    const d = normalizeIndianPhoneDigits(raw);
    if (d.length !== 10) {
        return {
            valid: false,
            message: `${label} must be a valid 10-digit Indian mobile number`
        };
    }
    if (!/^[6-9]\d{9}$/.test(d)) {
        return {
            valid: false,
            message: `${label} must be a valid Indian mobile number (10 digits, starting with 6–9)`
        };
    }
    return { valid: true, cleanedPhone: d };
}

function isContactFieldKey(key) {
    const k = String(key || '').toLowerCase();
    return k === 'email' || k.includes('email') || k === 'phone' || k === 'whatsapp' || k.includes('phone');
}

function validateFormContactFields(formData, fields) {
    const fd = formData && typeof formData === 'object' ? formData : {};
    const list = Array.isArray(fields) ? fields : [];
    for (const f of list) {
        if (!f || f.enabled === false) continue;
        const key = String(f.key || '');
        const t = String(f.type || '').toLowerCase();
        const raw = fd[key];
        if (raw == null || String(raw).trim() === '') continue;

        if (key === 'email' || t === 'email' || key.toLowerCase().includes('email')) {
            const ev = validateEmail(raw, f.label || 'Email');
            if (!ev.valid) return ev.message;
        }
        if (key === 'phone' || key === 'whatsapp' || t === 'tel' || key.toLowerCase().includes('phone')) {
            const pv = validatePhone(raw, f.label || (key === 'whatsapp' ? 'WhatsApp' : 'Phone'), {
                required: f.required !== false
            });
            if (!pv.valid) return pv.message;
        }
    }
    return null;
}

module.exports = {
    validateEmail,
    validatePhone,
    normalizeIndianPhoneDigits,
    validateFormContactFields,
    isContactFieldKey
};

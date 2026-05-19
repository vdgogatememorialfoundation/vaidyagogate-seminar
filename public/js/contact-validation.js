/** Client-side email and Indian mobile validation (same rules as server). */
const CONTACT_BARE_PROVIDERS = new Set([
    'gmail',
    'yahoo',
    'hotmail',
    'outlook',
    'rediffmail',
    'icloud',
    'protonmail',
    'live'
]);

const CONTACT_EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function normalizeIndianPhoneDigitsClient(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
}

function validateEmailClient(email, fieldLabel) {
    const label = fieldLabel || 'Email';
    const raw = String(email || '').trim();
    if (!raw) {
        return { valid: false, message: `${label} is required` };
    }
    const lower = raw.toLowerCase();
    if (CONTACT_BARE_PROVIDERS.has(lower)) {
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
    if (!CONTACT_EMAIL_RE.test(lower)) {
        return {
            valid: false,
            message: `Enter a valid ${label.toLowerCase()} (e.g. yourname@gmail.com)`
        };
    }
    return { valid: true, cleanedEmail: lower };
}

function validatePhoneClient(phone, fieldLabel, options) {
    const opts = options || {};
    const label = fieldLabel || 'Phone';
    const raw = String(phone || '').trim();
    if (!raw) {
        if (opts.required === false) return { valid: true, cleanedPhone: '' };
        return { valid: false, message: `${label} is required` };
    }
    const d = normalizeIndianPhoneDigitsClient(raw);
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

function validateOtpDestinationClient(channel, value, fieldLabel) {
    if (channel === 'email') {
        return validateEmailClient(value, fieldLabel || 'Email');
    }
    return validatePhoneClient(value, fieldLabel || 'Phone');
}

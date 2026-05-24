/**
 * Normalize legacy registration field configs and validate submitted form_data.
 */

const OTP_PLACEHOLDER_KEYS = new Set(['phone_otp', 'email_otp']);
const PG_COLLEGE_KEYS = new Set(['cpin', 'college', 'ccity', 'cstate']);

function fieldOnlyWhenPgCollege(f) {
    return !!(f && (PG_COLLEGE_KEYS.has(f.key) || f.onlyWhenPgCollege));
}

function isOtpPlaceholderField(f) {
    if (!f) return false;
    const k = String(f.key || '');
    if (OTP_PLACEHOLDER_KEYS.has(k)) return true;
    return (f.type || '').toLowerCase() === 'otp';
}

function inferType(f) {
    if (f.type) return String(f.type).toLowerCase();
    const k = String(f.key || '');
    if (k === 'phone_otp' || k === 'email_otp') return 'otp';
    if (k === 'certificate') return 'file';
    if (k === 'email') return 'email';
    if (k === 'phone') return 'tel';
    if (k.includes('email')) return 'email';
    if (k.includes('phone')) return 'tel';
    if (k === 'address') return 'textarea';
    if (k === 'pin' || k.includes('year')) return 'number';
    return 'text';
}

const LEGACY_STEP = {
    fname: 1,
    mname: 1,
    lname: 1,
    email: 1,
    phone: 1,
    phone_otp: 1,
    email_otp: 1,
    address: 2,
    pin: 2,
    city: 2,
    state: 2,
    country: 2,
    dob: 1,
    qual: 3,
    ncism: 3,
    certificate: 3,
    college: 4,
    ccity: 4,
    cstate: 4,
    cpin: 4
};

function qualNeedsPgCollege(qual) {
    return String(qual || '').trim() === 'PG';
}

function normalizeFields(fields) {
    if (!Array.isArray(fields)) return [];
    return fields
        .map((f) => {
            if (!f || !f.key) return null;
            const step = f.step != null ? parseInt(f.step, 10) : LEGACY_STEP[f.key] || 1;
            const type = inferType(f);
            let out = { ...f, step: Number.isNaN(step) ? 1 : step, type };
            if (PG_COLLEGE_KEYS.has(out.key)) {
                out.onlyWhenPgCollege = true;
                out.step = 4;
            }
            if (out.key === 'mname') {
                out.required = false;
            }
            return out;
        })
        .filter(Boolean);
}

/** Legacy configs used separate phone_otp/email_otp rows; OTP is verified on phone/email inputs. */
function sanitizeRegistrationFormFields(fields) {
    const list = normalizeFields(fields || []);
    const hasPhone = list.some((f) => f.key === 'phone' && f.enabled !== false);
    const hasEmail = list.some((f) => f.key === 'email' && f.enabled !== false);
    const phoneOtpRequired = list.some((f) => f.key === 'phone_otp' && f.enabled !== false && f.required);
    const emailOtpRequired = list.some((f) => f.key === 'email_otp' && f.enabled !== false && f.required);

    return list
        .filter((f) => {
            if (f.key === 'phone_otp' && hasPhone) return false;
            if (f.key === 'email_otp' && hasEmail) return false;
            return true;
        })
        .map((f) => {
            if (f.key === 'phone' && phoneOtpRequired && !f.verifyOtp) {
                return { ...f, verifyOtp: true };
            }
            if (f.key === 'email' && emailOtpRequired && !f.verifyOtp) {
                return { ...f, verifyOtp: true };
            }
            return f;
        });
}

function getFieldValue(formData, f, hasCertificateFile) {
    const key = f.key;
    const t = (f.type || 'text').toLowerCase();
    if (key === 'certificate') {
        return hasCertificateFile || (formData && formData.certificate_path) ? '1' : '';
    }
    const raw = formData && formData[key];
    if (t === 'checkbox' || t === 'boolean') {
        if (raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'true') return '1';
        return '';
    }
    if (raw === undefined || raw === null) return '';
    return String(raw);
}

function validateDynamicForm(formData, hasCertificateFile, fields, qualOverride) {
    const list = normalizeFields(fields);
    const qual = qualOverride != null ? qualOverride : formData && formData.qual;
    const adv = ['PG', 'Practicing Vaidya', 'Practitioner'].includes(String(qual || ''));

    for (const f of list) {
        if (!f.enabled) continue;
        if (f.required === false) continue;
        if (f.onlyWhenAdvancedQual && !adv) continue;
        if (fieldOnlyWhenPgCollege(f) && !qualNeedsPgCollege(qual)) continue;
        if (isOtpPlaceholderField(f)) continue; // validated separately via tokens
        const v = getFieldValue(formData, f, hasCertificateFile);
        if (v.trim() === '') {
            return `Missing required field: ${f.label || f.key}`;
        }
        const t = (f.type || 'text').toLowerCase();
        if (t === 'select' && Array.isArray(f.options)) {
            const ok = f.options.some((o) => String(o.value) === String(formData[f.key]));
            if (!ok) return `Invalid choice for: ${f.label || f.key}`;
        }
        if (t === 'date' && v.trim()) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
                return `Invalid date for: ${f.label || f.key}`;
            }
        }
    }
    return null;
}

function maxStepFromFields(fields) {
    const list = normalizeFields(fields);
    let m = 1;
    list.forEach((f) => {
        if (f.step > m) m = f.step;
    });
    return m;
}

module.exports = {
    normalizeFields,
    sanitizeRegistrationFormFields,
    isOtpPlaceholderField,
    validateDynamicForm,
    maxStepFromFields,
    getFieldValue,
    qualNeedsPgCollege,
    LEGACY_STEP,
    OTP_PLACEHOLDER_KEYS
};

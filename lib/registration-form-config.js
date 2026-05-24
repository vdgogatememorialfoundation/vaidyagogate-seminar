/**
 * Registration form config: merge global + seminar overrides, qual options, birth-year rules.
 */
const { sanitizeRegistrationFormFields, normalizeFields, validateDynamicForm } = require('./dynamic-fields');

const CANONICAL_QUAL_OPTIONS = [
    { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
    { value: 'Practitioner', label: 'Practitioner' },
    { value: 'PG', label: 'PG' }
];

function normalizeQualOptions(options) {
    if (!Array.isArray(options) || !options.length) return CANONICAL_QUAL_OPTIONS.slice();
    const canon = {};
    CANONICAL_QUAL_OPTIONS.forEach((o) => {
        canon[o.value] = o;
    });
    const out = [];
    options.forEach((o) => {
        if (!o) return;
        const v = String(o.value != null ? o.value : o.label || '').trim();
        if (!v || v.toLowerCase() === 'new') return;
        if (canon[v]) out.push(canon[v]);
        else if (v.length > 1) out.push({ value: v, label: String(o.label || v).trim() || v });
    });
    return out.length ? out : CANONICAL_QUAL_OPTIONS.slice();
}

function normalizeQualOptionsField(fields) {
    return (fields || []).map((f) => {
        if (!f || f.key !== 'qual' || !Array.isArray(f.options)) return f;
        return { ...f, options: normalizeQualOptions(f.options) };
    });
}

function parseRegistrationFormPayload(raw) {
    if (!raw) return { fields: [], birthYearMin: null, birthYearMax: null };
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            return { fields: [], birthYearMin: null, birthYearMax: null };
        }
    }
    if (Array.isArray(parsed)) {
        return { fields: parsed, birthYearMin: null, birthYearMax: null };
    }
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    const birthYearMin = parseBirthYear(parsed.birthYearMin);
    const birthYearMax = parseBirthYear(parsed.birthYearMax);
    return { fields, birthYearMin, birthYearMax };
}

function parseBirthYear(v) {
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n > 1900 && n < 2100 ? n : null;
}

function mergeRegistrationFields(globalFields, overrideFields) {
    const globals = sanitizeRegistrationFormFields(globalFields || []);
    const overrides = Array.isArray(overrideFields) ? overrideFields : [];
    const ovByKey = {};
    overrides.forEach((f) => {
        if (f && f.key) ovByKey[f.key] = f;
    });
    const merged = globals.map((gf) => {
        const ov = ovByKey[gf.key];
        if (!ov) return { ...gf };
        const out = {
            ...gf,
            label: ov.label != null && String(ov.label).trim() ? ov.label : gf.label,
            enabled: ov.enabled != null ? ov.enabled !== false : gf.enabled !== false,
            required: ov.required != null ? !!ov.required : !!gf.required
        };
        if (ov.options != null && Array.isArray(ov.options)) out.options = ov.options;
        if (ov.step != null) out.step = ov.step;
        if (ov.type != null) out.type = ov.type;
        return out;
    });
    overrides.forEach((f) => {
        if (!f || !f.key) return;
        if (!merged.some((m) => m.key === f.key)) merged.push(f);
    });
    return sanitizeRegistrationFormFields(normalizeQualOptionsField(merged));
}

function birthYearFromDob(dob) {
    if (!dob) return null;
    const s = String(dob).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return parseInt(m[1], 10);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.getFullYear();
    return null;
}

function validateBirthYearFromDob(dob, birthYearMin, birthYearMax) {
    const min = parseBirthYear(birthYearMin);
    const max = parseBirthYear(birthYearMax);
    if (min == null && max == null) return null;
    const y = birthYearFromDob(dob);
    if (y == null) return 'Valid date of birth is required.';
    if (min != null && y < min) {
        return `Date of birth must be on or after 1 January ${min} (eligible from birth year ${min}).`;
    }
    if (max != null && y > max) {
        return `Date of birth must be on or before 31 December ${max} (eligible up to birth year ${max}).`;
    }
    return null;
}

function validateFormWithPolicy(formData, hasCertificateFile, fields, qualOverride, policy) {
    const baseErr = validateDynamicForm(formData, hasCertificateFile, fields, qualOverride);
    if (baseErr) return baseErr;
    const list = normalizeFields(fields || []);
    const dobField = list.find((f) => f.key === 'dob' && f.enabled !== false);
    if (dobField && (dobField.required !== false || (formData && formData.dob))) {
        const pol = policy || {};
        const dobErr = validateBirthYearFromDob(
            formData && formData.dob,
            pol.birthYearMin,
            pol.birthYearMax
        );
        if (dobErr) return dobErr;
    }
    return null;
}

function buildConfigPayload(fields, meta) {
    const m = meta || {};
    const out = {
        version: 1,
        fields: sanitizeRegistrationFormFields(normalizeQualOptionsField(fields || []))
    };
    const min = parseBirthYear(m.birthYearMin);
    const max = parseBirthYear(m.birthYearMax);
    if (min != null) out.birthYearMin = min;
    if (max != null) out.birthYearMax = max;
    return out;
}

module.exports = {
    CANONICAL_QUAL_OPTIONS,
    parseRegistrationFormPayload,
    mergeRegistrationFields,
    normalizeQualOptions,
    normalizeQualOptionsField,
    birthYearFromDob,
    validateBirthYearFromDob,
    validateFormWithPolicy,
    buildConfigPayload,
    parseBirthYear
};

'use strict';

/**
 * Admin-filled registrations may leave some configured fields for the applicant
 * to complete later. The keys live in `form_data.pending_fields`; those fields
 * are treated as optional during validation until the applicant fills them in.
 */

const NON_DEFERRABLE_KEYS = new Set(['fname', 'lname', 'email', 'phone', 'qual', 'certificate']);

function parseFormData(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? o : {};
    } catch (_) {
        return {};
    }
}

function isDeferrableKey(key) {
    const k = String(key || '').trim();
    return !!k && !NON_DEFERRABLE_KEYS.has(k);
}

function pendingKeys(formData) {
    const fd = parseFormData(formData);
    const raw = fd.pending_fields;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
    const out = [];
    list.forEach((k) => {
        const s = String(k || '').trim();
        if (isDeferrableKey(s) && !out.includes(s)) out.push(s);
    });
    return out;
}

/** Fields whose keys are pending become optional for validation. */
function relaxFieldsForPending(fields, formData) {
    const pend = pendingKeys(formData);
    if (!pend.length) return fields || [];
    return (fields || []).map((f) => (f && pend.includes(String(f.key)) ? { ...f, required: false } : f));
}

function stripPending(formData) {
    const fd = parseFormData(formData);
    if (!('pending_fields' in fd)) return fd;
    const out = { ...fd };
    delete out.pending_fields;
    return out;
}

function hasValue(v) {
    return v != null && String(v).trim() !== '';
}

/** Drop keys from pending_fields that now carry a value; remove the list when empty. */
function settlePending(formData) {
    const fd = { ...parseFormData(formData) };
    const still = pendingKeys(fd).filter((k) => !hasValue(fd[k]));
    if (still.length) fd.pending_fields = still;
    else delete fd.pending_fields;
    return fd;
}

/** Configured field definitions the applicant still has to complete. */
function pendingFieldDefs(formData, fields) {
    const pend = pendingKeys(formData);
    if (!pend.length) return [];
    const byKey = {};
    (fields || []).forEach((f) => {
        if (f && f.key) byKey[String(f.key)] = f;
    });
    return pend.map((k) => {
        const f = byKey[k] || {};
        return {
            key: k,
            label: f.label || k,
            type: f.type || 'text',
            options: Array.isArray(f.options) ? f.options : undefined
        };
    });
}

module.exports = {
    NON_DEFERRABLE_KEYS,
    isDeferrableKey,
    pendingKeys,
    relaxFieldsForPending,
    stripPending,
    settlePending,
    pendingFieldDefs,
    parseFormData
};

/** Client-side person name rules (no Dr./Vd./Doctor titles). */
const NAME_REJECTED_PREFIXES = [
    'dr', 'dr.', 'doctor', 'vd', 'vd.', 'vaidya', 'prof', 'prof.', 'professor',
    'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'shri', 'shri.', 'smt', 'smt.'
];

function validatePersonNameClient(name, fieldLabel) {
    const label = fieldLabel || 'Name';
    if (name == null || String(name).trim() === '') {
        return { valid: false, message: `${label} is required` };
    }
    const trimmed = String(name).trim().replace(/\s+/g, ' ');
    const lower = trimmed.toLowerCase();
    for (const prefix of NAME_REJECTED_PREFIXES) {
        if (lower === prefix || lower.startsWith(prefix + ' ') || lower.startsWith(prefix + '.')) {
            return {
                valid: false,
                message: `${label} cannot include titles like Dr., Vd., or Doctor. Use only your name (e.g. First Rajesh, Middle Raj, Last Dhave).`
            };
        }
    }
    if (/\d/.test(trimmed)) {
        return { valid: false, message: `${label} cannot contain numbers` };
    }
    if (trimmed.length < 2) {
        return { valid: false, message: `${label} must be at least 2 characters` };
    }
    return { valid: true, cleanedName: trimmed };
}

function validateRegistrationNamesClient(formData) {
    const fd = formData || {};
    const checks = [['fname', 'First name'], ['mname', 'Middle name'], ['lname', 'Last name']];
    for (const [key, label] of checks) {
        const raw = fd[key];
        if (raw == null || String(raw).trim() === '') {
            if (key === 'mname') continue;
            return `Missing required field: ${label}`;
        }
        const v = validatePersonNameClient(raw, label);
        if (!v.valid) return v.message;
    }
    return null;
}

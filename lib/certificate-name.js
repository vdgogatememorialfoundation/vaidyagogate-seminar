/**
 * Admin-editable recipient name / honorific shown on certificates.
 * cert_honorific: '' or null = automatic, 'none' = no prefix, anything else = literal prefix (e.g. "Dr.").
 */
const PREFIX_RE = /^(mr|mrs|ms|miss|dr|prof|shri|smt|vaidya)\.?\s+/i;

function stripHonorific(name) {
    return String(name || '')
        .trim()
        .replace(PREFIX_RE, '')
        .trim();
}

function leadingHonorific(name) {
    const m = PREFIX_RE.exec(String(name || '').trim());
    if (!m) return '';
    const word = m[1];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + '.';
}

function normalizeHonorific(value) {
    const raw = String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw || /^auto(matic)?$/i.test(raw)) return '';
    if (/^none$/i.test(raw)) return 'none';
    return raw.slice(0, 20);
}

function isEdited(row) {
    return Number(row && row.name_edited) === 1;
}

/** Name + honorific for an edited certificate, or null when the row uses automatic naming. */
function editedRecipient(row) {
    if (!isEdited(row)) return null;
    const name = stripHonorific(row.display_name) || String(row.display_name || '').trim();
    const hon = normalizeHonorific(row.cert_honorific);
    if (!name) return null;
    if (hon === 'none') return { name, text: name, auto: false };
    if (hon) return { name, text: hon + ' ' + name, auto: false };
    return { name, text: name, auto: true };
}

function ensureColumnsSql(isPg) {
    const tables = ['user_certificates', 'volunteer_certificates'];
    const out = [];
    tables.forEach((t) => {
        out.push(
            isPg
                ? `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS name_edited INTEGER DEFAULT 0`
                : `ALTER TABLE ${t} ADD COLUMN name_edited INTEGER DEFAULT 0`
        );
        out.push(
            isPg
                ? `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cert_honorific TEXT`
                : `ALTER TABLE ${t} ADD COLUMN cert_honorific TEXT`
        );
    });
    ['config_json', 'signature_left_path', 'signature_right_path'].forEach((c) => {
        out.push(
            isPg
                ? `ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS ${c} TEXT`
                : `ALTER TABLE certificate_templates ADD COLUMN ${c} TEXT`
        );
    });
    return out;
}

function verifyDisplayName(row) {
    const e = editedRecipient(row);
    return e ? e.text : row && row.display_name;
}

module.exports = {
    leadingHonorific,
    verifyDisplayName, stripHonorific, normalizeHonorific, isEdited, editedRecipient, ensureColumnsSql };

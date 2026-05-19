/** Parse registrations.form_data JSON (shared — avoid circular requires). */
function parseFormData(raw) {
    if (!raw) return {};
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return {};
    }
}

module.exports = { parseFormData };

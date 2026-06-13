/**
 * Staff / co-admin display names for tickets, email From headers, and UI.
 * Pattern: "Nitin Thatte | Vaidya Gogate Memorial Foundation"
 */
const ORG_NAME = 'Vaidya Gogate Memorial Foundation';

function formatStaffPersonName(user) {
    if (!user) return 'Support team';
    const name = [user.first_name, user.middle_name, user.last_name].filter(Boolean).join(' ').trim();
    if (name && name.toLowerCase() !== 'admin') return name;
    return 'Support team';
}

function formatStaffFromDisplay(user, fallbackRole) {
    const person = formatStaffPersonName(user);
    const label = person === 'Support team' && fallbackRole ? String(fallbackRole).trim() : person;
    return `${label} | ${ORG_NAME}`;
}

function isStaffSenderType(senderType) {
    const st = String(senderType || '').toLowerCase();
    return st === 'admin' || st === 'staff';
}

function formatSupportMessageSenderLabel(msg) {
    const st = String((msg && msg.sender_type) || '').toLowerCase();
    if (st === 'system') return 'Support desk';
    if (st === 'support') return formatStaffPersonName(msg) || 'Support team';
    if (!isStaffSenderType(st)) {
        return [msg && msg.first_name, msg && msg.last_name].filter(Boolean).join(' ').trim() || 'Doctor';
    }
    return formatStaffPersonName(msg);
}

function enrichSupportMessages(messages) {
    return (messages || []).map((m) =>
        Object.assign({}, m, {
            sender_display_name: formatSupportMessageSenderLabel(m)
        })
    );
}

module.exports = {
    ORG_NAME,
    formatStaffPersonName,
    formatStaffFromDisplay,
    isStaffSenderType,
    formatSupportMessageSenderLabel,
    enrichSupportMessages
};

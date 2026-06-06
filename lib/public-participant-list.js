/**
 * Public website verify-delegate list: paid participants only (volunteers excluded).
 * Admins can force-include paid registrations that are missing from the auto list.
 */
const { parseFormData } = require('./parse-form-data');
const { isConfirmedParticipant } = require('./confirmed-participants');

const EXCLUDED_REG_STATUSES = ['cancelled', 'rejected'];

function isVolunteerOrderRow(row) {
    const gw = String(row.payment_gateway || '').toLowerCase();
    if (gw === 'volunteer_waiver') return true;
    if (Number(row.is_seminar_volunteer) === 1) return true;
    return false;
}

function isPaidOrderRow(row) {
    return String(row.order_status || row.payment_status || '').toLowerCase() === 'success';
}

function displayNameFromRow(row) {
    const nameFromUser = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ').trim();
    const fd = parseFormData(row.form_data);
    const nameFromForm = [fd.fname, fd.mname, fd.lname].filter(Boolean).join(' ').trim();
    return nameFromUser || nameFromForm || '—';
}

function locationFromRow(row) {
    const fd = parseFormData(row.form_data);
    return {
        city: fd.city || '',
        state: fd.state || '',
        phone: fd.phone || row.phone || ''
    };
}

function dedupeRegistrationRows(rows) {
    const byReg = new Map();
    (rows || []).forEach((row) => {
        const rid = row.registration_id || row.id;
        if (!rid) return;
        const prev = byReg.get(rid);
        const amt = Number(row.amount) || 0;
        const prevAmt = prev ? Number(prev.amount) || 0 : -1;
        if (!prev || amt > prevAmt) byReg.set(rid, row);
    });
    return Array.from(byReg.values());
}

function wouldAutoListOnPublicSite(row) {
    if (Number(row.public_list_exclude) === 1) return false;
    if (!isPaidOrderRow(row)) return false;
    if (isVolunteerOrderRow(row)) return false;
    return isConfirmedParticipant({
        ...row,
        order_status: row.order_status || row.payment_status
    });
}

function shouldAppearOnPublicList(row) {
    if (Number(row.public_list_exclude) === 1) return false;
    if (!isPaidOrderRow(row)) return false;
    if (isVolunteerOrderRow(row)) return false;
    if (Number(row.public_list_include) === 1) return true;
    return wouldAutoListOnPublicSite(row);
}

function toPublicParticipant(row, source) {
    const loc = locationFromRow(row);
    return {
        registrationId: row.registration_id || row.id,
        applicationNo: row.application_no,
        name: displayNameFromRow(row),
        city: loc.city,
        state: loc.state,
        phone: loc.phone,
        status: row.status,
        paid: true,
        amount: row.amount != null ? Number(row.amount) : null,
        paymentGateway: row.payment_gateway || '',
        userIdString: row.user_id_string,
        source: source || (Number(row.public_list_include) === 1 ? 'manual' : 'auto')
    };
}

function buildPublicParticipantList(rows) {
    const unique = dedupeRegistrationRows(rows);
    const seen = new Set();
    const participants = [];
    unique.forEach((row) => {
        if (!shouldAppearOnPublicList(row)) return;
        const key = String(row.application_no || row.registration_id || row.id || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        participants.push(toPublicParticipant(row));
    });
    participants.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );
    return participants;
}

function buildAdminVerifyDelegatePayload(rows, seminar) {
    const unique = dedupeRegistrationRows(rows);
    const listed = [];
    const missingPaid = [];
    let volunteersExcluded = 0;
    let paidCount = 0;

    unique.forEach((row) => {
        if (EXCLUDED_REG_STATUSES.includes(String(row.status || '').toLowerCase())) return;
        if (!isPaidOrderRow(row)) return;
        paidCount += 1;
        if (isVolunteerOrderRow(row)) {
            volunteersExcluded += 1;
            return;
        }

        const onList = shouldAppearOnPublicList(row);
        const autoEligible = wouldAutoListOnPublicSite(row);
        const manual = Number(row.public_list_include) === 1;

        if (onList) {
            listed.push({
                ...toPublicParticipant(row, manual ? 'manual' : 'auto'),
                autoEligible,
                manualInclude: manual,
                excluded: false
            });
            return;
        }

        missingPaid.push({
            ...toPublicParticipant(row, 'missing'),
            autoEligible,
            manualInclude: false,
            excluded: Number(row.public_list_exclude) === 1,
            reason: Number(row.public_list_exclude) === 1 ? 'excluded_by_admin' : 'not_auto_eligible'
        });
    });

    listed.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );
    missingPaid.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );

    return {
        seminarId: seminar && seminar.id,
        seminarTitle: seminar && seminar.title,
        publicListEnabled: !!(seminar && seminar.public_list_enabled),
        stats: {
            listed: listed.length,
            missingPaid: missingPaid.length,
            paidNonVolunteer: listed.length + missingPaid.length,
            volunteersExcluded,
            paidTotal: paidCount
        },
        listed,
        missingPaid
    };
}

function filterParticipantsByQuery(list, q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return list;
    return (list || []).filter(
        (p) =>
            String(p.applicationNo || '').toLowerCase().includes(needle) ||
            String(p.name || '').toLowerCase().includes(needle) ||
            String(p.userIdString || '').toLowerCase().includes(needle) ||
            String(p.city || '').toLowerCase().includes(needle) ||
            String(p.state || '').toLowerCase().includes(needle) ||
            String(p.phone || '').toLowerCase().includes(needle)
    );
}

const VERIFY_DELEGATE_LIST_SQL = `SELECT r.id AS registration_id, r.application_no, r.status, r.form_data, r.doc_review_json,
       IFNULL(r.public_list_include, 0) AS public_list_include,
       IFNULL(r.public_list_exclude, 0) AS public_list_exclude,
       u.first_name, u.middle_name, u.last_name, u.user_id_string, u.email, u.phone,
       o.status AS payment_status, o.amount, o.payment_gateway, o.payment_date,
       t.ticket_id_string,
       CASE WHEN sv.id IS NOT NULL THEN 1 ELSE 0 END AS is_seminar_volunteer
FROM registrations r
JOIN users u ON u.id = r.user_id
INNER JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
LEFT JOIN tickets t ON t.order_id = o.id
LEFT JOIN seminar_volunteers sv ON sv.user_id = r.user_id AND sv.seminar_id = r.seminar_id
  AND lower(trim(sv.status)) = 'approved'
WHERE r.seminar_id = ?
  AND r.status NOT IN ('cancelled','rejected','submitted','waitlisted','pending_approval','revision_required')
ORDER BY r.application_no ASC`;

module.exports = {
    VERIFY_DELEGATE_LIST_SQL,
    isVolunteerOrderRow,
    isPaidOrderRow,
    displayNameFromRow,
    dedupeRegistrationRows,
    wouldAutoListOnPublicSite,
    shouldAppearOnPublicList,
    buildPublicParticipantList,
    buildAdminVerifyDelegatePayload,
    filterParticipantsByQuery,
    toPublicParticipant
};

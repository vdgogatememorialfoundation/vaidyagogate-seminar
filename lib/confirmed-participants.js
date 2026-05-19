/**
 * Confirmed participant rules: document-approved (when required) + successful payment.
 */
const { parseFormData } = require('./parse-form-data');
const { needsAdvancedQualDocs, parseDocReview } = require('./application-document-verify');

function isConfirmedParticipant(row) {
    if (!row) return false;
    const status = String(row.status || '').toLowerCase();
    if (['cancelled', 'rejected', 'submitted', 'pending_approval', 'revision_required'].includes(status)) {
        return false;
    }
    const pay = row.order_status || row.payment_status;
    if (pay !== 'success') return false;

    const fd = parseFormData(row.form_data);
    if (needsAdvancedQualDocs(fd)) {
        const review = parseDocReview(row.doc_review_json);
        return !!(review && review.decision === 'approve');
    }
    return ['approved_pending_payment', 'completed', 'checked_in', 'e_ticket_issued', 'certificate_issued'].includes(
        status
    );
}

const CONFIRMED_EXPORT_SQL = `SELECT r.application_no, r.status, r.created_at, r.form_data, r.doc_review_json,
              u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone,
              o.order_id_string, o.amount, o.payment_date, o.payment_gateway, o.status AS order_status,
              t.ticket_id_string, t.is_scanned, t.scan_time
              FROM registrations r
              JOIN users u ON u.id = r.user_id
              INNER JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
              LEFT JOIN tickets t ON t.order_id = o.id
              WHERE r.seminar_id = ?
                AND r.status NOT IN ('cancelled','rejected','submitted','pending_approval','revision_required')
              ORDER BY u.last_name, u.first_name`;

function filterConfirmedRows(rows) {
    return (rows || []).filter(isConfirmedParticipant);
}

module.exports = {
    isConfirmedParticipant,
    CONFIRMED_EXPORT_SQL,
    filterConfirmedRows
};

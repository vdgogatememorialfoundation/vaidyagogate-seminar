/**
 * Registration status after successful payment or e-ticket issuance.
 */
function markRegistrationETicketIssued(db, registrationId, cb) {
    if (!db || registrationId == null) return cb && cb();
    db.run(
        `UPDATE registrations SET status = 'e_ticket_issued'
         WHERE id = ? AND status NOT IN ('checked_in', 'certificate_issued', 'rejected', 'cancelled')`,
        [registrationId],
        (err) => cb && cb(err)
    );
}

module.exports = {
    markRegistrationETicketIssued
};

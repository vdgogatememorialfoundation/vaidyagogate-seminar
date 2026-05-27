/**
 * Post-registration waiting list — join without payment; admin promotes to payment.
 */

function isWaitingListEnabled(seminar) {
    return !!(seminar && Number(seminar.waiting_list_enabled) === 1);
}

function parseJoinWaitlistFlag(raw) {
    return raw === true || raw === 1 || raw === '1' || String(raw || '').toLowerCase() === 'true';
}

function isWaitlistedStatus(status) {
    return String(status || '').toLowerCase() === 'waitlisted';
}

/**
 * Create pending order and notify doctor to pay (portal dashboard + email).
 */
function offerRegistrationPayment(db, deps, registrationId, cb) {
    const { getOrCreatePendingOrder, notifEngine, paymentAmountForSeminar } = deps;
    if (!getOrCreatePendingOrder || !notifEngine) {
        return cb && cb(new Error('Payment offer dependencies missing'));
    }
    db.get(
        `SELECT r.user_id, r.seminar_id, r.application_no, s.price
         FROM registrations r
         LEFT JOIN seminars s ON s.id = r.seminar_id
         WHERE r.id = ?`,
        [registrationId],
        (err, row) => {
            if (err) return cb && cb(err);
            if (!row) return cb && cb(new Error('Registration not found'));
            const amt = paymentAmountForSeminar(row);
            getOrCreatePendingOrder(registrationId, amt, (oErr) => {
                if (oErr) return cb && cb(oErr);
                notifEngine.notify(db, 'PAYMENT_PENDING', {
                    userId: row.user_id,
                    seminarId: row.seminar_id,
                    registrationId,
                    vars: { application_no: row.application_no || '' }
                });
                cb && cb(null, { amount: amt });
            });
        }
    );
}

module.exports = {
    isWaitingListEnabled,
    parseJoinWaitlistFlag,
    isWaitlistedStatus,
    offerRegistrationPayment
};

/**
 * After cancellation + refund settlement, allow the same doctor to register again for a seminar.
 */

function refundSettled(refundStatus) {
    const rs = String(refundStatus || '').toLowerCase();
    return rs === 'completed' || rs === 'refunded';
}

function registrationAllowsReapplyFromRows(registrationRow, cancelRow, orderRow) {
    if (!registrationRow) return false;
    if (String(registrationRow.status || '').toLowerCase() !== 'cancelled') return false;

    const refundSt = String(
        (cancelRow && cancelRow.refund_status) || (orderRow && orderRow.refund_status) || ''
    ).toLowerCase();
    if (refundSettled(refundSt)) return true;

    const refundAmt = Number((cancelRow && cancelRow.refund_amount) || 0);
    const orderPaid = orderRow && String(orderRow.status || '').toLowerCase() === 'success';

    if (!orderPaid && refundAmt <= 0) return true;
    if (cancelRow && String(cancelRow.status || '').toLowerCase() === 'approved' && refundAmt <= 0) {
        return true;
    }

    const latestRefund = cancelRow && cancelRow.latest_refund_status;
    if (refundSettled(latestRefund)) return true;

    return false;
}

function registrationAllowsReapply(db, registrationRow, cb) {
    if (!registrationRow || !registrationRow.id) return cb(null, false);
    if (String(registrationRow.status || '').toLowerCase() !== 'cancelled') return cb(null, false);

    db.get(
        `SELECT status, refund_status, refund_amount
         FROM cancellation_requests
         WHERE registration_id = ?
         ORDER BY id DESC LIMIT 1`,
        [registrationRow.id],
        (err, cancelRow) => {
            if (err) return cb(err);
            db.get(
                `SELECT status, refund_status, amount, refunded_amount FROM orders WHERE registration_id = ? ORDER BY id DESC LIMIT 1`,
                [registrationRow.id],
                (e2, orderRow) => {
                    if (e2) return cb(e2);
                    if (!cancelRow && orderRow) {
                        return db.get(
                            `SELECT status FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
                            [orderRow.id],
                            (e3, refundRow) => {
                                if (e3) return cb(e3);
                                const merged = cancelRow || {};
                                if (refundRow) merged.latest_refund_status = refundRow.status;
                                cb(
                                    null,
                                    registrationAllowsReapplyFromRows(registrationRow, merged, orderRow)
                                );
                            }
                        );
                    }
                    if (cancelRow && orderRow) {
                        return db.get(
                            `SELECT status FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
                            [orderRow.id],
                            (e3, refundRow) => {
                                if (e3) return cb(e3);
                                const merged = { ...cancelRow };
                                if (refundRow) merged.latest_refund_status = refundRow.status;
                                cb(
                                    null,
                                    registrationAllowsReapplyFromRows(registrationRow, merged, orderRow)
                                );
                            }
                        );
                    }
                    cb(null, registrationAllowsReapplyFromRows(registrationRow, cancelRow, orderRow));
                }
            );
        }
    );
}

function reopenCancelledRegistration(db, registrationId, cb) {
    db.run(
        `UPDATE tickets SET is_valid = 0
         WHERE order_id IN (SELECT id FROM orders WHERE registration_id = ?)`,
        [registrationId],
        () => {
            db.run(
                `UPDATE orders SET status = 'cancelled' WHERE registration_id = ? AND lower(trim(status)) = 'pending'`,
                [registrationId],
                () => {
                    db.run(
                        `UPDATE registrations SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'cancelled'`,
                        [registrationId],
                        function (uErr) {
                            if (uErr) return cb(uErr);
                            cb(null, { ok: !!(this.changes) });
                        }
                    );
                }
            );
        }
    );
}

function reapplyAllowedFromApplication(app) {
    if (!app) return false;
    if (String(app.status || '').toLowerCase() !== 'cancelled') return false;
    const ct = app.cancellationTracking;
    if (ct && refundSettled(ct.refundStatus)) return true;
    if (ct && Number(ct.refundAmount || 0) <= 0 && String(ct.status || '').toLowerCase() === 'approved') {
        return true;
    }
    const refunds = ct && ct.refunds;
    if (Array.isArray(refunds) && refunds.some((r) => refundSettled(r.status))) return true;
    return false;
}

function resolveExistingRegistrationForSeminar(db, userId, seminarId, cb) {
    db.get(
        `SELECT id, status, application_no FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
        [userId, seminarId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            const st = String(row.status || '').toLowerCase();
            if (st === 'draft') return cb(null, row);
            if (st === 'cancelled') {
                return registrationAllowsReapply(db, row, (reErr, can) => {
                    if (reErr) return cb(reErr);
                    if (!can) {
                        return cb(null, {
                            blocked: true,
                            error:
                                'Your previous application was cancelled. You can register again after the refund is completed and credited to your bank account.'
                        });
                    }
                    return reopenCancelledRegistration(db, row.id, (oErr, out) => {
                        if (oErr) return cb(oErr);
                        if (!out || !out.ok) {
                            return cb(null, {
                                blocked: true,
                                error: 'Could not reopen your cancelled application. Contact the seminar office.'
                            });
                        }
                        cb(null, { id: row.id, status: 'draft', application_no: row.application_no });
                    });
                });
            }
            cb(null, {
                blocked: true,
                error: 'You already have a submitted application for this seminar. Track it under Track seminar applications.'
            });
        }
    );
}

module.exports = {
    registrationAllowsReapply,
    registrationAllowsReapplyFromRows,
    reopenCancelledRegistration,
    reapplyAllowedFromApplication,
    refundSettled,
    resolveExistingRegistrationForSeminar
};

/**
 * Auto-confirm seminar registrations — skip manual review, approve for payment immediately.
 * Admin can still reject later via status / verify endpoints.
 */

function isAutoConfirmEnabled(seminarRow) {
    return !!(seminarRow && Number(seminarRow.auto_confirm_registration) === 1);
}

function buildAutoConfirmReview() {
    return {
        decision: 'auto_confirm',
        auto_confirmed: true,
        info_ok: true,
        ncism_ok: true,
        certificate_ok: true,
        reviewed_at: new Date().toISOString(),
        rejection_reason: null,
        fee_type: 'regular'
    };
}

/**
 * @param {object} deps - { portalTracking, notifEngine, getOrCreatePendingOrder }
 * @param {object} ctx - { registrationId, userId, seminarId, applicationNo, seminarPrice }
 */
function autoConfirmRegistration(db, deps, ctx, cb) {
    const rid = parseInt(ctx && ctx.registrationId, 10);
    if (!Number.isInteger(rid) || rid < 1) return cb && cb(new Error('Invalid registration id'));

    const { portalTracking, notifEngine, getOrCreatePendingOrder } = deps || {};
    const review = buildAutoConfirmReview();
    const defaultAmt =
        ctx.seminarPrice != null && Number(ctx.seminarPrice) > 0 ? Number(ctx.seminarPrice) : 1500;

    db.run(
        `UPDATE registrations SET status = 'approved_pending_payment', doc_review_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('submitted','pending_approval','revision_required','documents_requested')`,
        [JSON.stringify(review), rid],
        function (uErr) {
            if (uErr) return cb && cb(uErr);
            if (!this.changes) return cb && cb(null, { skipped: true });

            if (portalTracking && portalTracking.logRegistrationEvent) {
                portalTracking.logRegistrationEvent(
                    db,
                    rid,
                    'approved',
                    'Auto-confirmed for payment',
                    'Registration auto-approved — doctor can pay immediately. Admin may reject later if needed.',
                    () => {}
                );
            }

            const finish = (extra) => {
                cb && cb(null, Object.assign({ ok: true, status: 'approved_pending_payment', feeAmount: defaultAmt }, extra || {}));
            };

            if (!getOrCreatePendingOrder) return finish();

            getOrCreatePendingOrder(rid, defaultAmt, () => {
                if (notifEngine) {
                    notifEngine.notify(db, 'APPLICATION_APPROVED', {
                        userId: ctx.userId,
                        seminarId: ctx.seminarId,
                        registrationId: rid,
                        vars: {
                            application_no: ctx.applicationNo || '',
                            approval_status: 'approved_pending_payment',
                            auto_confirmed: true
                        }
                    });
                    notifEngine.notify(db, 'PAYMENT_PENDING', {
                        userId: ctx.userId,
                        seminarId: ctx.seminarId,
                        registrationId: rid,
                        vars: { application_no: ctx.applicationNo || '' }
                    });
                }
                finish({ orderCreated: true });
            });
        }
    );
}

module.exports = {
    isAutoConfirmEnabled,
    buildAutoConfirmReview,
    autoConfirmRegistration
};

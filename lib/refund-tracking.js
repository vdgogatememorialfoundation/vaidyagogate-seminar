/**
 * Cancellation refund eligibility (IST) and refund status tracking for doctor/admin UI.
 */
const cancelPolicy = require('./cancellation-policy');
const seminarDt = require('./seminar-datetime');
const paymentsMod = require('./payments-module');

const REFUND_STATUS_LABELS = {
    none: 'No refund applicable',
    pending: 'Refund processing',
    processing: 'Refund processing',
    completed: 'Refund completed',
    manual_pending: 'Refund queued — admin will complete via payment gateway',
    failed: 'Refund failed — contact support',
    partial: 'Partial refund issued'
};

function refundStatusLabel(status) {
    const s = String(status || 'none').toLowerCase();
    return REFUND_STATUS_LABELS[s] || (s ? s.replace(/_/g, ' ') : '—');
}

function refundStatusTone(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (s === 'manual_pending' || s === 'pending' || s === 'processing') return 'pending';
    if (s === 'failed') return 'error';
    if (s === 'none') return 'muted';
    return 'info';
}

function daysUntilEvent(eventDate) {
    const evMs = seminarDt.parseSeminarMs(eventDate);
    if (evMs == null) return null;
    return (evMs - Date.now()) / 86400000;
}

function formatDaysUntil(days) {
    if (days == null || Number.isNaN(days)) return '';
    if (days < 0) return 'Event has started or passed';
    const d = Math.floor(days);
    if (d === 0) return 'Less than 1 day until event (IST)';
    if (d === 1) return '1 day until event (IST)';
    return d + ' days until event (IST)';
}

/**
 * Live policy evaluation + tier timeline for display before/after cancel request.
 */
function buildRefundEligibilityView(policyJson, eventDate, orderAmount) {
    const policy = cancelPolicy.parseCancellationPolicy(policyJson);
    const gate = cancelPolicy.evaluateDoctorCancellation(policyJson, eventDate);
    const refundCalc = paymentsMod.computeRefundForContext(policyJson, eventDate, orderAmount);
    const days = daysUntilEvent(eventDate);
    const tiers = Array.isArray(policy.tiers)
        ? [...policy.tiers].sort((a, b) => (b.minDaysBeforeEvent || 0) - (a.minDaysBeforeEvent || 0))
        : [];
    const tierViews = tiers.map((t) => {
        const minD = Number(t.minDaysBeforeEvent);
        const pct = Number(t.refundPercent);
        const active = days != null && !Number.isNaN(minD) && days >= minD;
        return {
            minDaysBeforeEvent: minD,
            refundPercent: pct,
            active,
            label:
                (Number.isFinite(pct) ? pct + '% refund' : 'Refund') +
                ' if cancelling at least ' +
                minD +
                ' day' +
                (minD === 1 ? '' : 's') +
                ' before the event'
        };
    });
    const noRefundDays = policy.noRefundWithinDays != null ? Number(policy.noRefundWithinDays) : null;
    const insideNoRefund =
        noRefundDays != null && days != null && days < noRefundDays && days >= 0;
    return {
        cancellationAllowed: gate.allowed,
        cancellationReason: gate.reason || null,
        policySummary: cancelPolicy.summaryCancellationPolicyText(policyJson),
        daysUntilEvent: days != null ? Math.floor(days * 10) / 10 : null,
        daysUntilLabel: formatDaysUntil(days),
        eligiblePercent: refundCalc.percent,
        eligibleAmount: refundCalc.refundAmount,
        eligibilityReason: refundCalc.reason,
        evaluatedAtIst: refundCalc.evaluatedAtIst,
        orderAmount: Number(orderAmount) || 0,
        insideNoRefundWindow: insideNoRefund,
        noRefundWithinDays: noRefundDays,
        tiers: tierViews,
        applicable:
            gate.allowed &&
            (Number(orderAmount) || 0) > 0 &&
            refundCalc.percent > 0 &&
            refundCalc.refundAmount > 0
    };
}

function parsePolicySnapshot(raw) {
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return null;
    }
}

/**
 * Vertical timeline steps for cancellation + refund on doctor portal.
 */
function buildRefundTrackingSteps(cancelRow, refunds, regStatus) {
    if (!cancelRow) return [];
    const st = String(cancelRow.status || '').toLowerCase();
    const refundSt = String(cancelRow.refund_status || 'none').toLowerCase();
    const amt = Number(cancelRow.refund_amount) || 0;
    const pct = Number(cancelRow.refund_percent) || 0;
    const steps = [];

    steps.push({
        key: 'requested',
        title: 'Cancellation requested',
        state: 'completed',
        at: cancelRow.requested_at || null,
        desc: cancelRow.reason ? String(cancelRow.reason).slice(0, 180) : 'Your request was submitted.'
    });

    if (st === 'pending') {
        steps.push({
            key: 'review',
            title: 'Admin review',
            state: 'active',
            at: null,
            desc:
                amt > 0
                    ? 'Policy preview (IST): ' + pct + '% — ₹' + amt + '. Refund is processed if approved.'
                    : 'Our team is reviewing your request. Refund eligibility follows the seminar cancellation policy (IST).'
        });
    } else {
        steps.push({
            key: 'review',
            title: st === 'approved' ? 'Cancellation approved' : 'Request ' + st,
            state: st === 'rejected' ? 'cancelled' : 'completed',
            at: cancelRow.reviewed_at || null,
            desc:
                st === 'rejected'
                    ? cancelRow.admin_notes || 'Your cancellation request was not approved.'
                    : cancelRow.admin_notes || 'Registration marked cancelled.'
        });
    }

    if (st !== 'approved') return steps;

    if (amt <= 0) {
        steps.push({
            key: 'refund',
            title: 'Refund',
            state: 'completed',
            at: cancelRow.reviewed_at || null,
            desc: 'No refund applies for this cancellation under the seminar policy.'
        });
        return steps;
    }

    const latestRefund = (refunds || [])[0];
    if (refundSt === 'completed' || (latestRefund && String(latestRefund.status).toLowerCase() === 'completed')) {
        steps.push({
            key: 'refund_init',
            title: 'Refund initiated',
            state: 'completed',
            at: (latestRefund && latestRefund.created_at) || cancelRow.reviewed_at || null,
            desc: '₹' + amt + ' (' + pct + '%) refund was initiated.'
        });
        steps.push({
            key: 'refund_done',
            title: 'Refund completed',
            state: 'completed',
            at: (latestRefund && latestRefund.created_at) || cancelRow.reviewed_at || null,
            desc:
                cancelRow.provider_refund_id || (latestRefund && latestRefund.provider_refund_id)
                    ? 'Reference: ' + (cancelRow.provider_refund_id || latestRefund.provider_refund_id)
                    : 'Refund should reflect in your account within 5–10 business days.'
        });
    } else if (refundSt === 'manual_pending') {
        steps.push({
            key: 'refund_init',
            title: 'Refund queued',
            state: 'active',
            at: cancelRow.reviewed_at || null,
            desc: '₹' + amt + ' (' + pct + '%) — processing manually via payment gateway. You will be notified when complete.'
        });
    } else if (refundSt === 'failed') {
        steps.push({
            key: 'refund_init',
            title: 'Refund issue',
            state: 'cancelled',
            at: cancelRow.reviewed_at || null,
            desc: 'Refund could not be completed automatically. Please contact support with application ' + (cancelRow.application_no || '') + '.'
        });
    } else {
        steps.push({
            key: 'refund_init',
            title: 'Refund pending',
            state: 'active',
            at: cancelRow.reviewed_at || null,
            desc: 'Eligible refund: ₹' + amt + ' (' + pct + '%). Processing will begin shortly after approval.'
        });
    }
    return steps;
}

function mapCancellationRowForClient(row, refunds, liveEligibility) {
    if (!row) return null;
    const snapshot = parsePolicySnapshot(row.policy_snapshot);
    const trackingSteps = buildRefundTrackingSteps(row, refunds, row.registration_status);
    return {
        id: row.id,
        registrationId: row.registration_id,
        status: row.status,
        reason: row.reason,
        refundPercent: row.refund_percent,
        refundAmount: row.refund_amount,
        refundStatus: row.refund_status || 'none',
        refundStatusLabel: refundStatusLabel(row.refund_status),
        refundStatusTone: refundStatusTone(row.refund_status),
        providerRefundId: row.provider_refund_id || null,
        requestedAt: row.requested_at,
        reviewedAt: row.reviewed_at,
        adminNotes: row.admin_notes || null,
        applicationNo: row.application_no,
        seminarTitle: row.seminar_title,
        eventDate: row.event_date,
        orderAmount: row.order_amount != null ? row.order_amount : liveEligibility && liveEligibility.orderAmount,
        orderRefundStatus: row.order_refund_status || null,
        orderRefundedAmount: row.order_refunded_amount != null ? row.order_refunded_amount : null,
        policySnapshot: snapshot,
        eligibility: liveEligibility || null,
        refunds: (refunds || []).map((r) => ({
            id: r.id,
            amount: r.amount,
            percent: r.percent,
            gateway: r.gateway,
            status: r.status,
            providerRefundId: r.provider_refund_id,
            createdAt: r.created_at
        })),
        trackingSteps
    };
}

function loadRefundsForRegistrations(db, registrationIds, cb) {
    const ids = (registrationIds || []).filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return cb(null, {});
    const ph = ids.map(() => '?').join(',');
    db.all(
        `SELECT * FROM refunds WHERE registration_id IN (${ph}) ORDER BY id DESC`,
        ids,
        (err, rows) => {
            if (err) return cb(err);
            const byReg = {};
            (rows || []).forEach((r) => {
                const rid = r.registration_id;
                if (!byReg[rid]) byReg[rid] = [];
                byReg[rid].push(r);
            });
            cb(null, byReg);
        }
    );
}

function loadLatestCancellationsForRegistrations(db, registrationIds, cb) {
    const ids = (registrationIds || []).filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return cb(null, {});
    const ph = ids.map(() => '?').join(',');
    db.all(
        `SELECT cr.*, r.application_no, r.status AS registration_status, r.seminar_id,
                s.title AS seminar_title, s.event_date, s.cancellation_policy_json,
                o.amount AS order_amount, o.refund_status AS order_refund_status, o.refunded_amount AS order_refunded_amount
         FROM cancellation_requests cr
         JOIN registrations r ON r.id = cr.registration_id
         JOIN seminars s ON s.id = r.seminar_id
         LEFT JOIN orders o ON o.registration_id = r.id AND o.status = 'success'
         WHERE cr.registration_id IN (${ph})
         ORDER BY cr.id DESC`,
        ids,
        (err, rows) => {
            if (err) return cb(err);
            const latest = {};
            (rows || []).forEach((row) => {
                if (!latest[row.registration_id]) latest[row.registration_id] = row;
            });
            cb(null, latest);
        }
    );
}

function attachCancellationRefundToApplications(db, applications, cb) {
    const list = applications || [];
    if (!list.length) return cb(null, list);
    const ids = list.map((r) => r.id);
    loadLatestCancellationsForRegistrations(db, ids, (e1, cancelByReg) => {
        if (e1) return cb(e1);
        loadRefundsForRegistrations(db, ids, (e2, refundsByReg) => {
            if (e2) return cb(e2);
            const out = list.map((row) => {
                const cancelRow = cancelByReg[row.id];
                if (!cancelRow) return { ...row, cancellationTracking: null };
                const refunds = refundsByReg[row.id] || [];
                const live = buildRefundEligibilityView(
                    row.cancellation_policy_json || cancelRow.cancellation_policy_json,
                    row.seminar_event_date || cancelRow.event_date,
                    cancelRow.order_amount || row.seminar_price
                );
                return {
                    ...row,
                    cancellationTracking: mapCancellationForClient(cancelRow, refunds, live)
                };
            });
            cb(null, out);
        });
    });
}

module.exports = {
    refundStatusLabel,
    refundStatusTone,
    buildRefundEligibilityView,
    buildRefundTrackingSteps,
    mapCancellationRowForClient,
    loadRefundsForRegistrations,
    loadLatestCancellationsForRegistrations,
    attachCancellationRefundToApplications
};

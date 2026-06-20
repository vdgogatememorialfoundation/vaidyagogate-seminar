/**
 * Seminar cancellation policy JSON:
 * { enabled, allowedUntil?, noRefundWithinDays?, tiers? }
 */
const seminarDt = require('./seminar-datetime');

function parseCancellationPolicy(raw) {
    if (raw == null || raw === '') return { enabled: true, tiers: [] };
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!p || typeof p !== 'object') return { enabled: true, tiers: [] };
        return p;
    } catch (_) {
        return { enabled: true, tiers: [] };
    }
}

/** Legacy seminars (no `enabled` key) stay cancellable until event day. */
function isCancellationEnabled(policy) {
    const p = parseCancellationPolicy(policy);
    if (p.enabled === false) return false;
    return true;
}

function formatAllowedUntilForDisplay(iso) {
    if (!iso) return '';
    return seminarDt.formatSeminarDateTime(iso, { hour: '2-digit', minute: '2-digit' });
}

/** True after venue e-ticket scan or registration marked checked_in. */
function registrationHasVenueCheckin(input) {
    if (!input) return false;
    const st = String(input.status || '').toLowerCase();
    if (st === 'checked_in' || st === 'certificate_issued') return true;
    if (Number(input.is_scanned) === 1 || input.is_scanned === true) return true;
    const sc = Number(input.scan_count);
    if (Number.isFinite(sc) && sc > 0) return true;
    if (input.checked_in_at || input.checkedInAt) return true;
    return false;
}

/**
 * @param {object} [checkinContext] registration row or { status, is_scanned, scan_count, checked_in_at }
 * @returns {{ allowed: boolean, reason?: string }}
 */
function evaluateDoctorCancellation(policy, eventDate, checkinContext) {
    if (registrationHasVenueCheckin(checkinContext)) {
        return {
            allowed: false,
            reason:
                'You have checked in at the venue. Cancellation is no longer available for this registration.'
        };
    }
    const p = parseCancellationPolicy(policy);
    if (!isCancellationEnabled(p)) {
        return {
            allowed: false,
            reason: 'Self-cancellation is turned off for this seminar. Contact the organizer if you need help.'
        };
    }
    if (p.allowedUntil) {
        const untilMs = seminarDt.parseSeminarMs(p.allowedUntil);
        if (untilMs != null && Date.now() > untilMs) {
            const when = formatAllowedUntilForDisplay(p.allowedUntil);
            return {
                allowed: false,
                reason: when
                    ? `The cancellation window closed on ${when} (IST).`
                    : 'The cancellation window has closed.'
            };
        }
    }
    if (eventDate) {
        const evMs = seminarDt.parseSeminarMs(eventDate);
        if (evMs != null) {
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: seminarDt.IST,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
            const todayStr = fmt.format(new Date());
            const evStr = fmt.format(new Date(evMs));
            if (todayStr >= evStr) {
                return {
                    allowed: false,
                    reason: 'Cancellation is only allowed before the seminar day. Contact support if you need help.'
                };
            }
        }
    }
    return { allowed: true };
}

function summaryCancellationPolicyText(raw) {
    const p = parseCancellationPolicy(raw);
    const parts = [];
    if (p.enabled === false) {
        parts.push('Self-cancellation is disabled for this seminar.');
    } else {
        parts.push('Doctors may cancel their own application');
        if (p.allowedUntil) {
            const when = formatAllowedUntilForDisplay(p.allowedUntil);
            parts.push(when ? `until ${when} (IST)` : 'until the scheduled deadline');
        } else {
            parts.push('until the seminar day');
        }
        parts.push(' (not after venue check-in).');
    }
    if (p.noRefundWithinDays != null) {
        parts.push(` No refund within ${p.noRefundWithinDays} days of the event.`);
    }
    if (Array.isArray(p.tiers)) {
        p.tiers.forEach((t) => {
            if (t.minDaysBeforeEvent != null && t.refundPercent != null) {
                parts.push(
                    ` ${t.refundPercent}% refund if cancelling at least ${t.minDaysBeforeEvent} days before the event.`
                );
            }
        });
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
}

module.exports = {
    parseCancellationPolicy,
    isCancellationEnabled,
    registrationHasVenueCheckin,
    evaluateDoctorCancellation,
    summaryCancellationPolicyText,
    formatAllowedUntilForDisplay
};

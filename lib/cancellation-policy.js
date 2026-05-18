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

/**
 * @returns {{ allowed: boolean, reason?: string }}
 */
function evaluateDoctorCancellation(policy, eventDate) {
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
        parts.push('.');
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
    evaluateDoctorCancellation,
    summaryCancellationPolicyText,
    formatAllowedUntilForDisplay
};

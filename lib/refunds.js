const Razorpay = require('razorpay');
const axios = require('axios');

/**
 * @param {object} policy — { noRefundWithinDays?: number, tiers?: { minDaysBeforeEvent: number, refundPercent: number }[] }
 * @param {string|Date} eventDate
 * @returns {{ percent: number, eligible: boolean, reason: string }}
 */
function computeRefundPercent(policy, eventDate) {
    if (!eventDate) return { percent: 0, eligible: false, reason: 'No event date' };
    const ev = new Date(eventDate).getTime();
    if (Number.isNaN(ev)) return { percent: 0, eligible: false, reason: 'Bad event date' };
    const days = (ev - Date.now()) / (86400 * 1000);
    const noRefundWithin = policy && policy.noRefundWithinDays != null ? Number(policy.noRefundWithinDays) : 0;
    if (days < noRefundWithin) {
        return { percent: 0, eligible: true, reason: `Inside no-refund window (${noRefundWithin} days before event)` };
    }
    const tiers = Array.isArray(policy && policy.tiers) ? [...policy.tiers].sort((a, b) => (b.minDaysBeforeEvent || 0) - (a.minDaysBeforeEvent || 0)) : [];
    for (const t of tiers) {
        const minD = Number(t.minDaysBeforeEvent);
        const pct = Number(t.refundPercent);
        if (!Number.isNaN(minD) && !Number.isNaN(pct) && days >= minD) {
            return { percent: Math.min(100, Math.max(0, pct)), eligible: true, reason: `Tier ≥${minD} days before event` };
        }
    }
    return { percent: 0, eligible: true, reason: 'No matching refund tier' };
}

function rupeesToPaisa(amount) {
    return Math.round(Number(amount) * 100);
}

async function refundRazorpay({ keyId, keySecret, paymentId, amountRupees }) {
    const rz = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const paisa = rupeesToPaisa(amountRupees);
    return new Promise((resolve) => {
        rz.payments.refund(paymentId, { amount: paisa, speed: 'normal' }, (err, refund) => {
            if (err) return resolve({ ok: false, error: err.error && err.error.description ? err.error.description : err.message });
            resolve({ ok: true, refundId: refund && refund.id, raw: refund });
        });
    });
}

/**
 * Cashfree PG refund (payment_id from successful order).
 * Env: CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, CASHFREE_API_VERSION (e.g. 2023-08-01)
 */
async function refundCashfree({ clientId, clientSecret, apiVersion, paymentId, amountRupees, orderId }) {
    const ver = apiVersion || process.env.CASHFREE_API_VERSION || '2023-08-01';
    const url = `https://api.cashfree.com/pg/orders/${encodeURIComponent(orderId || '')}/payments/${encodeURIComponent(paymentId)}/refunds`;
    try {
        const body = {
            refund_amount: Number(amountRupees),
            refund_id: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            refund_note: 'Seminar cancellation policy'
        };
        const res = await axios.post(url, body, {
            headers: {
                'x-client-id': clientId,
                'x-client-secret': clientSecret,
                'x-api-version': ver,
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });
        return { ok: true, raw: res.data };
    } catch (e) {
        const msg =
            (e.response && e.response.data && (e.response.data.message || e.response.data.error)) || e.message;
        return { ok: false, error: String(msg) };
    }
}

module.exports = { computeRefundPercent, refundRazorpay, refundCashfree, rupeesToPaisa };

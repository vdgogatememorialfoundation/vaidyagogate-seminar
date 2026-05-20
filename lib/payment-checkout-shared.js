/**
 * Shared helpers for hosted payment gateway integrations.
 */
const integrationSettings = require('./integration-settings');

function siteBase() {
    return integrationSettings.getPublicBaseUrl();
}

function returnPath(gateway, outcome) {
    return `${siteBase()}/api/payments/${gateway}/return?outcome=${outcome}`;
}

function formatInrAmount(amount) {
    const n = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(n) || n < 0) return '0.0';
    if (Number.isInteger(n)) return n.toString() + '.0';
    return n.toFixed(2);
}

function sanitizeTxnid(raw, maxLen) {
    const s = String(raw || '')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, maxLen || 30);
    return s || 'TXN' + Date.now();
}

function sanitizePhone10(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return '9999999999';
}

function isPaidStatus(status) {
    const st = String(status || '').toLowerCase();
    return ['success', 'paid', 'captured', 'received', 'completed', 'payment_success'].includes(st);
}

function gatewayTag(gateway, mode) {
    return `${gateway}_${mode === 'live' ? 'live' : 'test'}`;
}

module.exports = {
    siteBase,
    returnPath,
    formatInrAmount,
    sanitizeTxnid,
    sanitizePhone10,
    isPaidStatus,
    gatewayTag
};

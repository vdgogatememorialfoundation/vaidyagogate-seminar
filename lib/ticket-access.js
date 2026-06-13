/**
 * Short-lived signed tokens for e-ticket view/download (non-shareable links).
 */
const crypto = require('crypto');

function secret() {
    return String(process.env.JWT_SECRET || 'change-me-long-random');
}

function createTicketAccessToken(ticketIdString, userId, ttlMs) {
    const tid = String(ticketIdString || '').trim();
    const uid = parseInt(userId, 10);
    if (!tid || !Number.isInteger(uid) || uid < 1) return null;
    const ms = Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60000, parseInt(ttlMs, 10) || 900000));
    const exp = Date.now() + ms;
    const payload = `${tid}:${uid}:${exp}`;
    const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
    return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function parseTicketAccessToken(token) {
    try {
        const raw = Buffer.from(String(token || ''), 'base64url').toString('utf8');
        const idx = raw.lastIndexOf(':');
        if (idx < 1) return null;
        const sig = raw.slice(idx + 1);
        const body = raw.slice(0, idx);
        const parts = body.split(':');
        if (parts.length !== 3) return null;
        const ticketIdString = parts[0];
        const userId = parseInt(parts[1], 10);
        const exp = parseInt(parts[2], 10);
        if (!ticketIdString || !Number.isInteger(userId) || !Number.isFinite(exp)) return null;
        const payload = `${ticketIdString}:${userId}:${exp}`;
        const expected = crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
        if (sig !== expected) return null;
        if (Date.now() > exp) return { expired: true, ticketIdString, userId };
        return { ticketIdString, userId, exp };
    } catch (_) {
        return null;
    }
}

function verifyTicketAccessToken(token, ticketIdString, userId) {
    const parsed = parseTicketAccessToken(token);
    if (!parsed || parsed.expired) return false;
    if (String(parsed.ticketIdString).trim() !== String(ticketIdString || '').trim()) return false;
    if (Number(parsed.userId) !== Number(userId)) return false;
    return true;
}

module.exports = {
    createTicketAccessToken,
    parseTicketAccessToken,
    verifyTicketAccessToken
};

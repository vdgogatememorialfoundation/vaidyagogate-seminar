/**
 * Razorpay keys from environment (Render / .env). Never expose key_secret to the client.
 */
function trimEnvValue(raw) {
    return String(raw || '')
        .trim()
        .replace(/^["']|["']$/g, '');
}

function fromEnv() {
    const key_id = trimEnvValue(process.env.RAZORPAY_KEY_ID);
    const key_secret = trimEnvValue(process.env.RAZORPAY_KEY_SECRET);
    if (!key_id || !key_secret) return null;
    const mode = key_id.startsWith('rzp_live_') ? 'live' : 'test';
    return { key_id, key_secret, mode };
}

/** Safe prefix for logs (never log full key_id). */
function keyIdPrefix(key_id) {
    const id = String(key_id || '');
    if (!id) return '(none)';
    return id.length > 14 ? id.slice(0, 14) + '…' : id;
}

function hasEnvCredentials() {
    return !!fromEnv();
}

module.exports = {
    fromEnv,
    hasEnvCredentials,
    keyIdPrefix
};

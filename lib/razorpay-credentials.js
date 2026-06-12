/**
 * Razorpay keys from environment (Render / .env). Never expose key_secret to the client.
 */
function fromEnv() {
    const key_id = String(process.env.RAZORPAY_KEY_ID || '').trim();
    const key_secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!key_id || !key_secret) return null;
    const mode = key_id.startsWith('rzp_live_') ? 'live' : 'test';
    return { key_id, key_secret, mode };
}

function hasEnvCredentials() {
    return !!fromEnv();
}

module.exports = {
    fromEnv,
    hasEnvCredentials
};

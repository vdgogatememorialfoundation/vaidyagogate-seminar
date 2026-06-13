/**
 * Lightweight in-memory rate limiting for hot public endpoints.
 * Per-process only — use Render horizontal scaling + PG pool for heavy load.
 */
function clientKey(req) {
    const fwd = req.headers['x-forwarded-for'];
    const ip = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || req.socket?.remoteAddress || 'unknown';
    return String(ip).slice(0, 120);
}

function createRateLimiter(opts) {
    const windowMs = Math.max(1000, parseInt(opts.windowMs, 10) || 60000);
    const max = Math.max(1, parseInt(opts.max, 10) || 30);
    const buckets = new Map();

    setInterval(() => {
        const now = Date.now();
        buckets.forEach((entry, key) => {
            if (now - entry.start >= windowMs) buckets.delete(key);
        });
    }, windowMs).unref();

    return function rateLimit(req, res, next) {
        const key = (opts.keyPrefix || 'rl') + ':' + clientKey(req);
        const now = Date.now();
        let entry = buckets.get(key);
        if (!entry || now - entry.start >= windowMs) {
            entry = { start: now, count: 0 };
            buckets.set(key, entry);
        }
        entry.count += 1;
        if (entry.count > max) {
            res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
            return res.status(429).json({
                error: opts.message || 'Too many requests. Please wait a moment and try again.',
                retryAfterSeconds: Math.ceil(windowMs / 1000)
            });
        }
        if (typeof next === 'function') next();
    };
}

const registrationSubmitLimit = createRateLimiter({
    keyPrefix: 'reg-submit',
    windowMs: parseInt(process.env.REG_SUBMIT_RATE_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.REG_SUBMIT_RATE_MAX, 10) || 8,
    message: 'Too many registration attempts from your network. Please wait one minute and try again.'
});

const registrationDraftLimit = createRateLimiter({
    keyPrefix: 'reg-draft',
    windowMs: 60000,
    max: parseInt(process.env.REG_DRAFT_RATE_MAX, 10) || 30,
    message: 'Too many draft saves. Please wait a moment.'
});

const authLoginLimit = createRateLimiter({
    keyPrefix: 'auth-login',
    windowMs: 60000,
    max: parseInt(process.env.AUTH_LOGIN_RATE_MAX, 10) || 20,
    message: 'Too many login attempts. Please wait one minute.'
});

module.exports = {
    createRateLimiter,
    registrationSubmitLimit,
    registrationDraftLimit,
    authLoginLimit
};

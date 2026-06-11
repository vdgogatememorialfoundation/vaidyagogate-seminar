/**
 * Prevent Render free-tier web services from spinning down due to inactivity.
 * Periodically hits this app's public /api/health URL (outbound → inbound request).
 *
 * Disable: DISABLE_RENDER_KEEPALIVE=1
 * Interval ms: RENDER_KEEPALIVE_INTERVAL_MS (default 10 min; Render sleeps after ~15 min idle)
 */
const axios = require('axios');
const hosting = require('./hosting');

let timer = null;

function resolvePingUrl() {
    const raw =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.PUBLIC_BASE_URL ||
        process.env.PUBLIC_TRACK_BASE_URL ||
        '';
    const base = String(raw).trim().replace(/\/+$/, '');
    if (!base) return null;
    if (!/^https?:\/\//i.test(base)) return `https://${base}/api/health`;
    return `${base}/api/health`;
}

function shouldRun() {
    if (process.env.DISABLE_RENDER_KEEPALIVE === '1' || process.env.DISABLE_RENDER_KEEPALIVE === 'true') {
        return false;
    }
    if (!hosting.isRender()) return false;
    if (process.env.NODE_ENV !== 'production' && !process.env.RENDER_EXTERNAL_URL) return false;
    return !!resolvePingUrl();
}

async function pingOnce() {
    const url = resolvePingUrl();
    if (!url) return;
    try {
        const res = await axios.get(url, {
            timeout: 25000,
            validateStatus: (s) => s >= 200 && s < 500
        });
        if (res.status >= 200 && res.status < 300) {
            console.log('[render-keepalive] ping ok', res.status);
        } else {
            console.warn('[render-keepalive] ping unexpected status', res.status);
        }
    } catch (e) {
        console.warn('[render-keepalive] ping failed:', e.message);
    }
}

function startRenderKeepalive() {
    if (timer) return;
    if (!shouldRun()) return;

    const url = resolvePingUrl();
    const intervalMs = Math.max(
        60000,
        parseInt(process.env.RENDER_KEEPALIVE_INTERVAL_MS, 10) || 10 * 60 * 1000
    );

    console.log(`[render-keepalive] enabled — pinging ${url} every ${Math.round(intervalMs / 60000)} min`);

    // Initial ping shortly after boot so the first idle window is covered.
    setTimeout(() => pingOnce(), 15000);
    timer = setInterval(() => pingOnce(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
}

function stopRenderKeepalive() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

module.exports = {
    startRenderKeepalive,
    stopRenderKeepalive,
    resolvePingUrl,
    shouldRun
};

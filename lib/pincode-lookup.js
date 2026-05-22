/**
 * Indian PIN → city/state lookup (server-side proxy + shared parse).
 */
const https = require('https');

const LEGACY_PINCODE_API = 'https://api.postalpincode.in/pincode';
const PRIMARY_PINCODE_API = 'https://postal-pincode-api.vercel.app/api/v1/pincode';

function parsePostalPincodePayload(raw, clean) {
    const data = Array.isArray(raw) ? raw[0] : raw;
    const status = String((data && (data.Status || data.status)) || '').toLowerCase();
    if (!data || status !== 'success' || !Array.isArray(data.PostOffice) || !data.PostOffice.length) {
        return { ok: false, error: (data && (data.Message || data.message)) || 'PIN not found' };
    }
    const cities = [...new Set(data.PostOffice.map((p) => p.District).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    const states = [...new Set(data.PostOffice.map((p) => p.State).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    const country = data.PostOffice[0].Country || 'India';
    return { ok: true, pin: clean, cities, states, country };
}

function parseVercelPincodePayload(raw, clean) {
    if (!raw || String(raw.message || '').toLowerCase() !== 'ok' || !Array.isArray(raw.data) || !raw.data.length) {
        return { ok: false, error: 'PIN not found' };
    }
    const cities = [...new Set(raw.data.map((p) => p.district).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    const states = [...new Set(raw.data.map((p) => p.state).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
    return { ok: true, pin: clean, cities, states, country: 'India' };
}

function fetchJsonUrl(url, opts) {
    const options = opts || {};
    return new Promise((resolve) => {
        const u = new URL(url);
        const req = https.get(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                port: u.port || 443,
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'VGMFSeminar/1.0'
                },
                rejectUnauthorized: options.rejectUnauthorized !== false
            },
            (res) => {
                let body = '';
                res.on('data', (c) => {
                    body += c;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) return resolve(null);
                    try {
                        resolve(JSON.parse(body));
                    } catch (_) {
                        resolve(null);
                    }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(12000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

async function fetchWithNodeFetch(url, signal) {
    if (typeof fetch !== 'function') return null;
    try {
        const res = await fetch(url, {
            signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'VGMFSeminar/1.0'
            }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

async function fetchPrimaryPincodeApi(pin) {
    const url = `${PRIMARY_PINCODE_API}/${pin}`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
        let raw = await fetchWithNodeFetch(url, ctrl && ctrl.signal);
        if (raw == null) raw = await fetchJsonUrl(url);
        if (raw == null) return null;
        return parseVercelPincodePayload(raw, pin);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function fetchLegacyPincodeApi(pin) {
    const url = `${LEGACY_PINCODE_API}/${pin}`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
        let raw = await fetchWithNodeFetch(url, ctrl && ctrl.signal);
        if (raw == null) {
            raw = await fetchJsonUrl(url, { rejectUnauthorized: false });
        }
        if (raw == null) return null;
        return parsePostalPincodePayload(raw, pin);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * @param {string} pin
 * @returns {Promise<{ ok: boolean, pin?: string, cities?: string[], states?: string[], country?: string, error?: string }>}
 */
async function lookupPincode(pin) {
    const clean = String(pin || '').replace(/\D/g, '');
    if (clean.length !== 6) {
        return { ok: false, error: 'PIN must be 6 digits' };
    }

    const primary = await fetchPrimaryPincodeApi(clean);
    if (primary && primary.ok) return primary;
    if (primary && primary.error && primary.error !== 'PIN not found') {
        return primary;
    }

    const legacy = await fetchLegacyPincodeApi(clean);
    if (legacy && legacy.ok) return legacy;
    if (legacy && legacy.error) {
        return { ok: false, error: legacy.error };
    }

    return {
        ok: false,
        error: (primary && primary.error) || (legacy && legacy.error) || 'PIN lookup service unavailable'
    };
}

module.exports = { lookupPincode, parsePostalPincodePayload, parseVercelPincodePayload, PINCODE_API: PRIMARY_PINCODE_API };

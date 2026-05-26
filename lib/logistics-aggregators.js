/**
 * Shiprocket & Nimbuspost tracking APIs (credentials from env or book_logistics_config).
 */
const https = require('https');

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in';
const NIMBUSPOST_BASE = process.env.NIMBUSPOST_API_BASE || 'https://api.nimbuspost.com';

let _shiprocketToken = null;
let _shiprocketTokenExp = 0;
let _nimbusToken = null;
let _nimbusTokenExp = 0;

function requestJson(method, url, { headers = {}, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body != null ? JSON.stringify(body) : null;
        const opts = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'VGMF-Seminar-BookSales/1.0',
                ...headers
            },
            timeout: timeoutMs
        };
        if (data) {
            opts.headers['Content-Type'] = 'application/json';
            opts.headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = https.request(opts, (res) => {
            let raw = '';
            res.on('data', (c) => {
                raw += c;
            });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (_) {
                    parsed = { _raw: raw };
                }
                resolve({ statusCode: res.statusCode, data: parsed, raw });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        if (data) req.write(data);
        req.end();
    });
}

function normalizeLogisticsConfig(raw) {
    const env = {
        shiprocket: {
            enabled: !!(process.env.SHIPROCKET_API_EMAIL && process.env.SHIPROCKET_API_PASSWORD),
            email: process.env.SHIPROCKET_API_EMAIL || '',
            password: process.env.SHIPROCKET_API_PASSWORD || ''
        },
        nimbuspost: {
            enabled: !!(process.env.NIMBUSPOST_API_KEY && process.env.NIMBUSPOST_API_SECRET),
            apiKey: process.env.NIMBUSPOST_API_KEY || '',
            apiSecret: process.env.NIMBUSPOST_API_SECRET || '',
            email: process.env.NIMBUSPOST_API_EMAIL || ''
        }
    };
    const c = raw && typeof raw === 'object' ? raw : {};
    const sr = { ...env.shiprocket, ...(c.shiprocket || {}) };
    const nb = { ...env.nimbuspost, ...(c.nimbuspost || {}) };
    sr.enabled = !!(sr.enabled && sr.email && sr.password);
    nb.enabled = !!(nb.enabled && nb.apiKey && nb.apiSecret);
    return { shiprocket: sr, nimbuspost: nb };
}

async function shiprocketLogin(cfg) {
    const now = Date.now();
    if (_shiprocketToken && _shiprocketTokenExp > now + 60000) return _shiprocketToken;
    const res = await requestJson('POST', SHIPROCKET_BASE + '/v1/external/auth/login', {
        body: { email: cfg.email, password: cfg.password }
    });
    const token = res.data && (res.data.token || res.data.access_token);
    if (!token) throw new Error((res.data && res.data.message) || 'Shiprocket login failed');
    _shiprocketToken = token;
    _shiprocketTokenExp = now + 9 * 24 * 60 * 60 * 1000;
    return token;
}

async function trackShiprocket(awb, logisticsRaw) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
    if (!cfg.enabled) return null;
    const token = await shiprocketLogin(cfg);
    const res = await requestJson('GET', SHIPROCKET_BASE + '/v1/external/courier/track/awb/' + encodeURIComponent(awb), {
        headers: { Authorization: 'Bearer ' + token }
    });
    if (res.statusCode !== 200 || !res.data) return null;
    const td = res.data.tracking_data || res.data;
    const acts = td.shipment_track_activities || td.shipment_track || td.activities || [];
    const events = (Array.isArray(acts) ? acts : []).map((a) => ({
        at: a.date || a.activity_date || a['date'] || null,
        location: a.location || a.sr_location || '',
        description: a.activity || a.status || a['activity'] || ''
    }));
    const statusText = String(
        td.shipment_status || td.track_status || td.current_status || events[0]?.description || ''
    );
    const delivered = /deliver/i.test(statusText) || Number(td.track_status) === 7;
    return {
        ok: true,
        status: delivered ? 'delivered' : /out for delivery/i.test(statusText) ? 'out_for_delivery' : 'in_transit',
        statusLabel: statusText || 'Shiprocket update',
        delivered,
        events,
        source: 'shiprocket'
    };
}

async function nimbusLogin(cfg) {
    const now = Date.now();
    if (_nimbusToken && _nimbusTokenExp > now + 60000) return _nimbusToken;
    const attempts = [
        () =>
            requestJson('POST', NIMBUSPOST_BASE + '/v1/users/login', {
                body: { email: cfg.email, password: cfg.apiSecret }
            }),
        () =>
            requestJson('POST', NIMBUSPOST_BASE + '/v1/users/login', {
                body: { api_key: cfg.apiKey, api_secret: cfg.apiSecret }
            }),
        () =>
            requestJson('POST', NIMBUSPOST_BASE + '/v1/auth/login', {
                headers: { 'Api-Key': cfg.apiKey, 'Api-Secret': cfg.apiSecret },
                body: {}
            })
    ];
    for (const fn of attempts) {
        try {
            const res = await fn();
            const token =
                (res.data && (res.data.token || res.data.access_token || res.data.data?.token)) || null;
            if (token) {
                _nimbusToken = token;
                _nimbusTokenExp = now + 9 * 24 * 60 * 60 * 1000;
                return token;
            }
        } catch (_) {}
    }
    return cfg.apiKey;
}

async function trackNimbuspost(awb, logisticsRaw) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).nimbuspost;
    if (!cfg.enabled) return null;
    const token = await nimbusLogin(cfg);
    const headers = token && token.length > 40 ? { Authorization: 'Bearer ' + token } : { 'Api-Key': cfg.apiKey, 'Api-Secret': cfg.apiSecret };
    const urls = [
        NIMBUSPOST_BASE + '/v1/shipments/track/' + encodeURIComponent(awb),
        NIMBUSPOST_BASE + '/v1/shipment/track/' + encodeURIComponent(awb),
        NIMBUSPOST_BASE + '/v1/track/' + encodeURIComponent(awb)
    ];
    for (const url of urls) {
        try {
            const res = await requestJson('GET', url, { headers });
            if (res.statusCode !== 200 || !res.data) continue;
            const d = res.data.data || res.data;
            const hist = d.history || d.tracking_history || d.events || d.scans || [];
            const events = (Array.isArray(hist) ? hist : []).map((h) => ({
                at: h.date || h.event_time || h.created_at,
                location: h.location || h.city || '',
                description: h.status || h.message || h.activity || ''
            }));
            const statusText = String(d.status || d.current_status || events[0]?.description || '');
            const delivered = /deliver/i.test(statusText);
            return {
                ok: true,
                status: delivered ? 'delivered' : 'in_transit',
                statusLabel: statusText || 'Nimbuspost update',
                delivered,
                events,
                source: 'nimbuspost'
            };
        } catch (_) {}
    }
    return null;
}

module.exports = {
    normalizeLogisticsConfig,
    trackShiprocket,
    trackNimbuspost
};

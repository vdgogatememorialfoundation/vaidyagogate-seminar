/**
 * Live courier tracking — provider adapters + optional Track123 aggregator (TRACK123_API_SECRET).
 */
const https = require('https');
const http = require('http');
const { courierProviderLabel, courierTrackingUrl } = require('./book-courier-tracking');

const TRACK_STATUS = {
    booked: 'booked',
    in_transit: 'in_transit',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    exception: 'exception',
    unknown: 'unknown'
};

const TRACK_STATUS_LABELS = {
    booked: 'Booked / picked up',
    in_transit: 'In transit',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    exception: 'Exception / delay',
    unknown: 'Status unavailable'
};

function httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(
            url,
            {
                headers: {
                    'User-Agent': 'VGMF-Seminar-BookSales/1.0',
                    Accept: 'application/json, text/html, */*'
                },
                timeout: timeoutMs || 12000
            },
            (res) => {
                let body = '';
                res.on('data', (c) => {
                    body += c;
                });
                res.on('end', () => resolve({ statusCode: res.statusCode, body }));
            }
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function httpPostJson(url, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const u = new URL(url);
        const opts = {
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'VGMF-Seminar-BookSales/1.0'
            },
            timeout: timeoutMs || 12000
        };
        const req = https.request(opts, (res) => {
            let body = '';
            res.on('data', (c) => {
                body += c;
            });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.write(data);
        req.end();
    });
}

function normEvents(events) {
    return (events || [])
        .map((ev) => ({
            at: ev.at || ev.time || ev.eventTime || null,
            location: ev.location || ev.office || ev.city || '',
            description: String(ev.description || ev.status || ev.type || ev.activity || '').trim()
        }))
        .filter((ev) => ev.description);
}

function resultFrom(status, label, delivered, events, source) {
    return {
        ok: true,
        status: status || TRACK_STATUS.unknown,
        statusLabel: label || TRACK_STATUS_LABELS[status] || 'Update',
        delivered: !!delivered,
        events: normEvents(events),
        source: source || 'adapter'
    };
}

function guessStatusFromText(text) {
    const t = String(text || '').toLowerCase();
    if (/deliver|delivered|delivery completed|handed over/.test(t)) return TRACK_STATUS.delivered;
    if (/out for delivery|out-for-delivery/.test(t)) return TRACK_STATUS.out_for_delivery;
    if (/in transit|dispatched|shipped|arrived|received at|bagged|departed/.test(t)) return TRACK_STATUS.in_transit;
    if (/booked|picked|manifest|accepted/.test(t)) return TRACK_STATUS.booked;
    if (/return|undeliver|failed|exception|delay/.test(t)) return TRACK_STATUS.exception;
    return TRACK_STATUS.in_transit;
}

async function trackDelhivery(trackingNo) {
    const res = await httpGet(
        'https://track.delhivery.com/api/v1/packages/json/?waybill=' + encodeURIComponent(trackingNo)
    );
    if (res.statusCode !== 200) throw new Error('Delhivery HTTP ' + res.statusCode);
    const data = JSON.parse(res.body);
    const pkg = (data.ShipmentData && data.ShipmentData[0]) || data;
    const scans = (pkg.Scans && pkg.Scans) || pkg.Scan || [];
    const events = (Array.isArray(scans) ? scans : [scans]).map((s) => ({
        at: s.ScanDateTime || s.StatusDateTime,
        location: s.ScannedLocation || s.CityLocation || '',
        description: s.Scan || s.ScanDetail || s.StatusCode || ''
    }));
    const last = events[0] && events[0].description ? events[0].description : '';
    const status = guessStatusFromText(last);
    const delivered = status === TRACK_STATUS.delivered || /delivered/i.test(String(pkg.Status || ''));
    return resultFrom(
        delivered ? TRACK_STATUS.delivered : status,
        last || TRACK_STATUS_LABELS[status],
        delivered,
        events,
        'delhivery'
    );
}

async function trackDtdc(trackingNo) {
    const res = await httpPostJson('https://blktracksvc.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails', {
        strcnno: trackingNo,
        addtnlDtl: 'Y'
    });
    const data = JSON.parse(res.body);
    const hist =
        (data.trackDetails && data.trackDetails[0] && data.trackDetails[0].trackHeader) ||
        data.trackHeader ||
        data;
    const rows = hist.strDestination || hist.strOrigin ? [hist] : data.trackDetails || [];
    const events = [];
    (data.trackDetails || []).forEach((block) => {
        (block.trackHeader || []).forEach((h) => {
            events.push({
                at: h.strActionDate || h.strActionTime,
                location: h.strOrigin || h.strDestination || '',
                description: h.strAction || h.strManifestNo || ''
            });
        });
        (block.trackDetails || []).forEach((row) => {
            events.push({
                at: row.strActionDate,
                location: row.strOrigin || row.strDestination || '',
                description: row.strAction || ''
            });
        });
    });
    const lastDesc = events.length ? events[events.length - 1].description : '';
    const status = guessStatusFromText(lastDesc);
    const delivered = /delivered/i.test(lastDesc);
    return resultFrom(
        delivered ? TRACK_STATUS.delivered : status,
        lastDesc || TRACK_STATUS_LABELS[status],
        delivered,
        events.length ? events : [{ description: JSON.stringify(data).slice(0, 120) }],
        'dtdc'
    );
}

async function trackIndianPost(trackingNo) {
    const attempts = [
        'https://track.indiapost.gov.in/api/track/' + encodeURIComponent(trackingNo),
        'https://www.indiapost.gov.in/_vti_bin/DOP.Portal.Tracking/api/TrackConsignment?TrackingNumber=' +
            encodeURIComponent(trackingNo)
    ];
    for (const url of attempts) {
        try {
            const res = await httpGet(url);
            if (res.statusCode !== 200) continue;
            const data = JSON.parse(res.body);
            const events = [];
            (data.events || data.Event || data.trackingEvents || []).forEach((ev) => {
                events.push({
                    at: ev.time || ev.date || ev.EventDate,
                    location: ev.office || ev.location || ev.EventOffice,
                    description: ev.type || ev.description || ev.EventDescription || ev.status
                });
            });
            if (data.delivered || /deliver/i.test(JSON.stringify(data))) {
                return resultFrom(
                    TRACK_STATUS.delivered,
                    'Delivered',
                    true,
                    events,
                    'indian_post_api'
                );
            }
            if (events.length) {
                const last = events[events.length - 1].description;
                const status = guessStatusFromText(last);
                return resultFrom(status, last, status === TRACK_STATUS.delivered, events, 'indian_post_api');
            }
        } catch (_) {
            /* try next */
        }
    }
    const page = await httpGet(
        'https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx?TrackingNumber=' +
            encodeURIComponent(trackingNo)
    );
    const html = page.body || '';
    const events = [];
    const rowRe = /<td[^>]*>([^<]+)<\/td>/gi;
    let m;
    const cells = [];
    while ((m = rowRe.exec(html)) !== null) {
        const t = m[1].replace(/&nbsp;/g, ' ').trim();
        if (t) cells.push(t);
    }
    for (let i = 0; i + 2 < cells.length; i += 3) {
        events.push({ at: cells[i], location: cells[i + 1] || '', description: cells[i + 2] || cells[i + 1] });
    }
    const blob = cells.join(' ');
    const status = guessStatusFromText(blob);
    const delivered = status === TRACK_STATUS.delivered;
    if (!events.length && !blob) {
        return resultFrom(
            TRACK_STATUS.in_transit,
            'Dispatched — open India Post to view live scans',
            false,
            [],
            'indian_post_link'
        );
    }
    return resultFrom(
        delivered ? TRACK_STATUS.delivered : status,
        events.length ? events[events.length - 1].description : TRACK_STATUS_LABELS[status],
        delivered,
        events,
        'indian_post_html'
    );
}

const TRACK123_CARRIER = {
    indian_post: 'india-post',
    dtdc: 'dtdc',
    bluedart: 'bluedart',
    delhivery: 'delhivery',
    ecom_express: 'ecom-express',
    professional: 'professional-courier',
    xpressbees: 'xpressbees',
    fedex: 'fedex',
    dhl: 'dhl'
};

async function trackViaTrack123(provider, trackingNo) {
    const secret = process.env.TRACK123_API_SECRET || process.env.TRACKING_API_SECRET;
    if (!secret) return null;
    const courierCode = TRACK123_CARRIER[provider] || 'india-post';
    await httpPostJson(
        'https://api.track123.com/gateway/open-api/tk/v2/track/import',
        [{ trackNo: trackingNo, courierCode }],
        15000
    ).catch(() => null);
    const q = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ trackNos: [trackingNo], queryPageSize: 5 });
        const req = https.request(
            {
                hostname: 'api.track123.com',
                path: '/gateway/open-api/tk/v2/track/query',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Track123-Api-Secret': secret,
                    Accept: 'application/json'
                },
                timeout: 15000
            },
            (r) => {
                let body = '';
                r.on('data', (c) => (body += c));
                r.on('end', () => resolve({ statusCode: r.statusCode, body }));
            }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
    if (q.statusCode !== 200) return null;
    const parsed = JSON.parse(q.body);
    const row = (parsed.data && parsed.data.accepted && parsed.data.accepted[0]) || (parsed.data && parsed.data[0]);
    if (!row) return null;
    const events = (row.trackDetails || row.events || []).map((ev) => ({
        at: ev.eventTime || ev.time,
        location: ev.location || ev.address || '',
        description: ev.eventDescription || ev.status || ''
    }));
    const st = String(row.transitStatus || row.status || '').toLowerCase();
    let status = TRACK_STATUS.in_transit;
    if (/deliver/.test(st)) status = TRACK_STATUS.delivered;
    else if (/out/.test(st)) status = TRACK_STATUS.out_for_delivery;
    const delivered = status === TRACK_STATUS.delivered || row.delivered;
    return resultFrom(
        status,
        row.transitStatus || row.status || TRACK_STATUS_LABELS[status],
        delivered,
        events,
        'track123'
    );
}

async function fetchLiveCourierTracking(provider, trackingNo) {
    const p = String(provider || '').toLowerCase();
    const t = String(trackingNo || '').trim();
    if (!t) {
        return { ok: false, error: 'No tracking number' };
    }
    const externalUrl = courierTrackingUrl(p, t);
    const tryOrder = [];
    if (process.env.TRACK123_API_SECRET || process.env.TRACKING_API_SECRET) {
        tryOrder.push(() => trackViaTrack123(p, t));
    }
    if (p === 'delhivery') tryOrder.push(() => trackDelhivery(t));
    if (p === 'dtdc') tryOrder.push(() => trackDtdc(t));
    if (p === 'indian_post' || p === 'speed_post' || /IN$/i.test(t)) {
        tryOrder.push(() => trackIndianPost(t));
    }
    tryOrder.push(() => trackIndianPost(t));
    for (const fn of tryOrder) {
        try {
            const r = await fn();
            if (r && r.ok) {
                r.externalUrl = externalUrl;
                return r;
            }
        } catch (e) {
            /* next adapter */
        }
    }
    return {
        ok: true,
        status: TRACK_STATUS.in_transit,
        statusLabel: 'In transit — refresh or open carrier site',
        delivered: false,
        events: [],
        source: 'fallback',
        externalUrl
    };
}

module.exports = {
    TRACK_STATUS,
    TRACK_STATUS_LABELS,
    fetchLiveCourierTracking,
    guessStatusFromText
};

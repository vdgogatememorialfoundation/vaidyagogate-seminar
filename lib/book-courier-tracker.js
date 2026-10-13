/**
 * Live courier tracking — provider adapters + optional Track123 aggregator (TRACK123_API_SECRET).
 */
const https = require('https');
const http = require('http');
const { courierProviderLabel, courierTrackingUrl, courierExternalLink } = require('./book-courier-tracking');
const { trackShiprocket, trackNimbuspost, normalizeLogisticsConfig } = require('./logistics-aggregators');

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

function httpGet(url, timeoutMs, extraHeaders) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(
            url,
            {
                headers: Object.assign(
                    {
                        'User-Agent': 'VGMF-Seminar-BookSales/1.0',
                        Accept: 'application/json, text/html, */*'
                    },
                    extraHeaders || {}
                ),
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
        .map((ev) => {
            const city = String(ev.city || '').trim();
            const state = String(ev.state || '').trim();
            const country = String(ev.country || '').trim() || 'India';
            const facility = String(ev.facility || ev.hub || '').trim();
            const desc = String(ev.description || ev.status || ev.type || ev.activity || '').trim();
            const loc =
                ev.location ||
                [facility, city, state, country].filter((p, i, arr) => p && arr.indexOf(p) === i).join(', ') ||
                ev.office ||
                '';
            return {
                at: ev.at || ev.time || ev.eventTime || null,
                location: loc,
                city,
                state,
                country,
                facility,
                description: desc
            };
        })
        .filter((ev) => ev.description);
}

function delhiveryScanTime(scan, state) {
    const raw = (scan && (scan.scanDateTime || scan.scanDate)) || (state && (state.scanDateTime || state.date)) || '';
    if (!raw) return null;
    const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + '+05:30');
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function trackDelhiveryUnified(trackingNo) {
    const res = await httpGet(
        'https://dlv-api.delhivery.com/v3/unified-tracking?wbn=' + encodeURIComponent(trackingNo),
        15000,
        { Origin: 'https://www.delhivery.com', Referer: 'https://www.delhivery.com/' }
    );
    if (res.statusCode !== 200 || !res.body) return null;
    const data = JSON.parse(res.body);
    const pkg = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!pkg) return null;
    const events = [];
    (pkg.trackingStates || []).forEach((state) => {
        (state.scans || []).forEach((scan) => {
            const desc = scan.scanNslRemark || scan.scan || state.label || '';
            if (!desc) return;
            events.push({
                at: delhiveryScanTime(scan, state) || delhiveryScanTime({ scanDateTime: pkg.status && pkg.status.statusDateTime }, null),
                location: scan.scannedLocation || scan.cityLocation || '',
                city: scan.cityLocation || '',
                description: desc
            });
        });
    });
    const st = pkg.status || {};
    const statusText = pkg.hqStatus || st.status || st.instructions || '';
    const code = String(st.status || '').toUpperCase();
    let status =
        code === 'DELIVERED' ? TRACK_STATUS.delivered
        : code === 'DISPATCHED' || /out for delivery/i.test(statusText) ? TRACK_STATUS.out_for_delivery
        : code === 'MANIFESTED' || code === 'NOT PICKED' ? TRACK_STATUS.booked
        : /RTO|RETURN|PENDING|UNDELIVERED|LOST|DAMAGED/i.test(code) || /undeliver|rto|return/i.test(statusText) ? TRACK_STATUS.exception
        : guessStatusFromText(statusText || code);
    if (/picked up|pickup/i.test(st.instructions || '') && status === TRACK_STATUS.in_transit && !events.length) status = TRACK_STATUS.booked;
    const delivered = status === TRACK_STATUS.delivered;
    const label = st.instructions ? (pkg.hqStatus ? pkg.hqStatus + ' — ' : '') + st.instructions : statusText || TRACK_STATUS_LABELS[status];
    const out = resultFrom(delivered ? TRACK_STATUS.delivered : status, label, delivered, events, 'delhivery');
    const promise = pkg.promiseDeliveryDate || null;
    if (promise) {
        const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(promise) ? promise : promise + '+05:30');
        if (Number.isFinite(d.getTime())) out.expectedDeliveryAt = d.toISOString();
    }
    if (pkg.deliveryDate) out.expectedDeliveryText = String(pkg.deliveryDate);
    if (pkg.slot && pkg.slot.from && pkg.slot.to) out.deliverySlot = { date: pkg.slot.date || '', from: pkg.slot.from, to: pkg.slot.to };
    if (pkg.destination) out.destination = String(pkg.destination);
    if (/RTO|RETURN/i.test(code) || /Reverse|RTO/i.test(String(pkg.currentFlow || ''))) out.rto = true;
    if (st.statusType === 'UD' && /undeliver|not delivered|attempt/i.test(String(st.instructions || ''))) out.attemptFailed = true;
    return out;
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
    try {
        const unified = await trackDelhiveryUnified(trackingNo);
        if (unified) return unified;
    } catch (_) {
        /* fall through to legacy endpoints */
    }
    const awb = encodeURIComponent(trackingNo);
    const urls = [
        'https://track.delhivery.com/api/v1/packages/json/?waybill=' + awb,
        'https://www.delhivery.com/api/v1/packages/json/?waybill=' + awb,
        'https://www.delhivery.com/track/package/' + awb
    ];
    let lastErr = null;
    for (const url of urls) {
        try {
            const res = await httpGet(url);
            if (res.statusCode !== 200 || !res.body) continue;
            let data = null;
            let pkg = null;
            let events = [];
            let statusText = '';
            if (url.includes('/api/')) {
                data = JSON.parse(res.body);
                pkg =
                    (data.ShipmentData &&
                        data.ShipmentData[0] &&
                        (data.ShipmentData[0].Shipment || data.ShipmentData[0])) ||
                    data;
                const scans =
                    pkg.Scans ||
                    pkg.Scan ||
                    (pkg.Shipment && (pkg.Shipment.Scans || pkg.Shipment.Scan)) ||
                    [];
                events = (Array.isArray(scans) ? scans : [scans])
                    .map((s) => ({
                        at: s.ScanDateTime || s.StatusDateTime || s.date || s.time || null,
                        location: s.ScannedLocation || s.CityLocation || s.location || '',
                        description:
                            s.Scan || s.ScanDetail || s.StatusCode || s.status || s.activity || s.description || ''
                    }))
                    .filter((x) => x.description);
                statusText =
                    (pkg.Status && (pkg.Status.Status || pkg.Status.StatusType || pkg.Status.Instructions)) ||
                    pkg.CurrentStatus ||
                    pkg.status ||
                    '';
            } else {
                // Next.js page fallback: attempt to parse embedded __NEXT_DATA__ / status text
                const m = res.body.match(
                    /"status"\s*:\s*"([^"]+)"|"current_status"\s*:\s*"([^"]+)"|"shipment_status"\s*:\s*"([^"]+)"/i
                );
                statusText = (m && (m[1] || m[2] || m[3])) || '';
                const loc = res.body.match(/"location"\s*:\s*"([^"]+)"/i);
                if (statusText) {
                    events = [
                        {
                            at: null,
                            location: loc ? loc[1] : '',
                            description: statusText
                        }
                    ];
                }
            }
            events.sort((a, b) => {
                const ta = a.at ? new Date(a.at).getTime() : NaN;
                const tb = b.at ? new Date(b.at).getTime() : NaN;
                if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
                if (!Number.isFinite(ta)) return 1;
                if (!Number.isFinite(tb)) return -1;
                return ta - tb;
            });
            if (!statusText && events.length) statusText = events[events.length - 1].description;
            if (!statusText && !events.length) continue;
            const status = guessStatusFromText(statusText);
            const delivered = status === TRACK_STATUS.delivered || /delivered/i.test(String(statusText || ''));
            return resultFrom(
                delivered ? TRACK_STATUS.delivered : status,
                statusText || TRACK_STATUS_LABELS[status],
                delivered,
                events,
                'delhivery'
            );
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) throw lastErr;
    return resultFrom(TRACK_STATUS.in_transit, 'Awaiting Delhivery scan updates', false, [], 'delhivery_pending');
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
    const awb = String(trackingNo || '').trim();
    const apiAttempts = [
        {
            method: 'GET',
            url: 'https://track.indiapost.gov.in/api/track/' + encodeURIComponent(awb)
        },
        {
            method: 'POST',
            url: 'https://track.indiapost.gov.in/api/Tracking/Consignment',
            body: { BarcodeNo: awb, consignmentNo: awb }
        }
    ];
    for (const attempt of apiAttempts) {
        try {
            let res;
            if (attempt.method === 'POST') {
                res = await httpPostJson(attempt.url, attempt.body);
            } else {
                res = await httpGet(attempt.url);
            }
            if (res.statusCode !== 200) continue;
            const data = JSON.parse(res.body);
            const events = [];
            const list = data.events || data.Event || data.trackingEvents || data.TrackingEvents || data.data || [];
            (Array.isArray(list) ? list : []).forEach((ev) => {
                events.push({
                    at: ev.time || ev.date || ev.EventDate || ev.eventDate,
                    location: ev.office || ev.location || ev.EventOffice || '',
                    description: ev.type || ev.description || ev.EventDescription || ev.status || ev.remarks || ''
                });
            });
            if (events.length) {
                const last = events[events.length - 1].description;
                const status = guessStatusFromText(last);
                return resultFrom(
                    status === TRACK_STATUS.delivered ? TRACK_STATUS.delivered : status,
                    last,
                    status === TRACK_STATUS.delivered,
                    events,
                    'indian_post_api'
                );
            }
        } catch (_) {}
    }
    return resultFrom(
        TRACK_STATUS.in_transit,
        'Awaiting India Post scans',
        false,
        [],
        'indian_post_pending'
    );
}

function parseEkartHtmlEvents(html) {
    const events = [];
    const body = String(html || '');
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(body))) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let c;
        while ((c = cellRe.exec(m[1]))) {
            cells.push(c[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
        }
        if (cells.length < 2) continue;
        const dateIdx = cells.findIndex((x) => /\d{1,2}[\s\/-][A-Za-z]{3}|\d{4}-\d\d-\d\d|\d{1,2}:\d\d/.test(x));
        if (dateIdx < 0) continue;
        const desc = cells.filter((x, i) => i !== dateIdx).join(' · ');
        if (!desc || /^(date|time|status|location)/i.test(desc)) continue;
        const parsed = new Date(cells[dateIdx]);
        events.push({
            at: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
            location: cells.length > 2 ? cells[cells.length - 1] : '',
            description: desc
        });
    }
    return events;
}

async function trackEkart(trackingNo) {
    const awb = String(trackingNo || '').trim();
    const enc = encodeURIComponent(awb);
    let lastErr = null;
    // 1) JSON endpoint used by the Ekart public tracking page
    try {
        const res = await httpPostJson('https://ekartlogistics.com/ws/getTrackingDetails', { trackingId: awb }, 15000);
        if (res && res.statusCode === 200 && res.body) {
            const data = JSON.parse(res.body);
            const payload = data && (data.data || data.result || data);
            const details = payload && (payload.shipmentTrackingDetails || payload.trackingDetails || payload.scans || payload.events || []);
            const events = (Array.isArray(details) ? details : [])
                .map((e) => ({
                    at: e.date || e.eventDate || e.timestamp || e.time || e.scanDate || null,
                    location: e.city || e.location || e.hub || '',
                    description: e.status || e.statusDescription || e.description || e.event || ''
                }))
                .filter((x) => x.description);
            const statusText =
                (payload && (payload.currentStatus || payload.status || payload.shipmentStatus)) ||
                (events.length ? events[events.length - 1].description : '');
            if (statusText || events.length) {
                const status = guessStatusFromText(statusText);
                const delivered = status === TRACK_STATUS.delivered || /delivered/i.test(String(statusText || ''));
                return resultFrom(delivered ? TRACK_STATUS.delivered : status, statusText || TRACK_STATUS_LABELS[status], delivered, events, 'ekart');
            }
        }
    } catch (e) {
        lastErr = e;
    }
    // 2) Public HTML page scrape
    for (const url of ['https://ekartlogistics.com/shipmenttrack/' + enc, 'https://ekartlogistics.com/track/' + enc]) {
        try {
            const res = await httpGet(url, 15000);
            if (!res || res.statusCode !== 200 || !res.body) continue;
            const events = parseEkartHtmlEvents(res.body);
            const sm = res.body.match(/(?:current\s*status|shipment\s*status)[^<]*<[^>]*>\s*([^<]{3,80})</i);
            const statusText = (sm && sm[1].trim()) || (events.length ? events[events.length - 1].description : '');
            if (!statusText && !events.length) continue;
            const status = guessStatusFromText(statusText);
            const delivered = status === TRACK_STATUS.delivered || /delivered/i.test(statusText);
            return resultFrom(delivered ? TRACK_STATUS.delivered : status, statusText || TRACK_STATUS_LABELS[status], delivered, events, 'ekart');
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr && !/ENOTFOUND|ECONN|timeout|socket/i.test(String(lastErr.message || ''))) throw lastErr;
    return resultFrom(TRACK_STATUS.in_transit, 'Awaiting Ekart scan updates', false, [], 'ekart_pending');
}

const TRACK123_CARRIER = {
    indian_post: 'india-post',
    dtdc: 'dtdc',
    bluedart: 'bluedart',
    delhivery: 'delhivery',
    ekart: 'ekart',
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

async function fetchLiveCourierTracking(provider, trackingNo, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const p = String(provider || '').toLowerCase();
    const t = String(trackingNo || '').trim();
    if (!t) {
        return { ok: false, error: 'No tracking number' };
    }
    const ext = courierExternalLink(p, t);
    const integration = String(opts.courierIntegration || 'direct').toLowerCase();
    const logistics = opts.logistics || null;
    const tryOrder = [];
    const pushDirect = () => {
        if (p === 'delhivery') tryOrder.push(() => trackDelhivery(t));
        if (p === 'ekart' || p === 'ekart_logistics') tryOrder.push(() => trackEkart(t));
        if (p === 'dtdc') tryOrder.push(() => trackDtdc(t));
        if (p === 'indian_post' || p === 'speed_post' || /IN$/i.test(t)) {
            tryOrder.push(() => trackIndianPost(t));
        }
    };
    const pushAggregators = () => {
        if (integration === 'nimbuspost') {
            tryOrder.push(() => trackNimbuspost(t, logistics));
            return;
        }
        tryOrder.push(() => trackShiprocket(t, logistics));
        if (integration !== 'shiprocket') {
            tryOrder.push(() => trackNimbuspost(t, logistics));
        }
    };

    if (integration === 'shiprocket') {
        tryOrder.push(() => trackShiprocket(t, logistics));
        pushDirect();
    } else if (integration === 'nimbuspost') {
        tryOrder.push(() => trackNimbuspost(t, logistics));
        pushDirect();
    } else {
        // auto: Shiprocket/Nimbuspost first (many AWBs), then direct carrier adapters
        const srOn = logistics && normalizeLogisticsConfig(logistics).shiprocket.enabled;
        if (srOn) pushAggregators();
        pushDirect();
        if (!srOn) pushAggregators();
    }
    if (process.env.TRACK123_API_SECRET || process.env.TRACKING_API_SECRET) {
        tryOrder.push(() => trackViaTrack123(p, t));
    }

    function scoreTrackResult(r) {
        if (!r || !r.ok) return -1;
        const n = (r.events && r.events.length) || 0;
        let score = n * 12;
        if (r.delivered) score += 8;
        if (r.source === 'shiprocket' || r.source === 'nimbuspost') score += 4;
        if (r.source === 'indian_post_pending' || r.source === 'delhivery_pending') score -= 15;
        const lbl = String(r.statusLabel || '').toLowerCase();
        if (!n && /when available|awaiting|refresh|click refresh|no scan/i.test(lbl)) score -= 12;
        return score;
    }

    let best = null;
    let bestScore = -1;
    for (const fn of tryOrder) {
        try {
            const r = await fn();
            if (!r || !r.ok) continue;
            const score = scoreTrackResult(r);
            if (score > bestScore) {
                best = r;
                bestScore = score;
            }
        } catch (_) {
            /* next adapter */
        }
    }
    if (best && bestScore >= 0) {
        best.externalLink = ext;
        best.externalUrl = ext.portalOnly ? null : ext.url;
        return best;
    }
    return {
        ok: true,
        status: TRACK_STATUS.in_transit,
        statusLabel: 'In transit — click Refresh for latest scans',
        delivered: false,
        events: [],
        source: 'fallback',
        externalLink: ext,
        externalUrl: ext.portalOnly ? null : ext.url
    };
}

module.exports = {
    TRACK_STATUS,
    TRACK_STATUS_LABELS,
    fetchLiveCourierTracking,
    guessStatusFromText
};

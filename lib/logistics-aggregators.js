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
let _shiprocketPickupPinCache = '';
let _shiprocketPickupPinCacheExp = 0;
let _shiprocketPickupListCache = null;
let _shiprocketPickupListCacheExp = 0;

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
    const envPickup = String(process.env.SHIPROCKET_PICKUP_PINCODE || '').replace(/\D/g, '').slice(0, 6);
    const env = {
        shiprocket: {
            enabled: !!(process.env.SHIPROCKET_API_EMAIL && process.env.SHIPROCKET_API_PASSWORD),
            email: process.env.SHIPROCKET_API_EMAIL || '',
            password: process.env.SHIPROCKET_API_PASSWORD || '',
            pickupPincode: envPickup,
            pickupLocation: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary'
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
    if (!sr.pickupPincode) sr.pickupPincode = envPickup;
    if (!sr.pickupLocation) sr.pickupLocation = process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary';
    if (sr.pickupLocationId != null) sr.pickupLocationId = Number(sr.pickupLocationId) || null;
    nb.enabled = !!(nb.enabled && nb.apiKey && nb.apiSecret);
    return { shiprocket: sr, nimbuspost: nb };
}

function normalizePickupRow(row) {
    if (!row || typeof row !== 'object') return null;
    const pincode = String(row.pin_code || row.pincode || row.pin || '')
        .replace(/\D/g, '')
        .slice(0, 6);
    const pickupLocation = String(
        row.pickup_location || row.pickup_location_name || row.name || row.warehouse_name || row.company_name || ''
    ).trim();
    const line1 = String(row.address || row.address_1 || row.address_line_1 || row.street || '').trim();
    const line2 = String(row.address_2 || row.address_line_2 || '').trim();
    const id = row.id != null ? Number(row.id) : row.pickup_location_id != null ? Number(row.pickup_location_id) : null;
    if (!pickupLocation && !pincode && !line1) return null;
    return {
        id: Number.isFinite(id) ? id : null,
        name: pickupLocation || 'Pickup',
        pickupLocation: pickupLocation || 'Pickup',
        addressLine: [line1, line2].filter(Boolean).join(', '),
        city: String(row.city || '').trim(),
        state: String(row.state || '').trim(),
        pincode,
        phone: String(row.phone || row.mobile || '').trim(),
        email: String(row.email || '').trim(),
        isPrimary: !!(row.is_primary || row.primary || row.is_default || row.default)
    };
}

function parsePickupLocationsFromApiResponse(data) {
    if (!data) return [];
    const out = [];
    const pushRow = (row) => {
        const n = normalizePickupRow(row);
        if (n) out.push(n);
    };
    const root = data.data != null ? data.data : data;
    if (Array.isArray(root)) root.forEach(pushRow);
    else if (root && typeof root === 'object') {
        if (Array.isArray(root.shipping_address)) root.shipping_address.forEach(pushRow);
        if (Array.isArray(root.pickup_addresses)) root.pickup_addresses.forEach(pushRow);
        if (Array.isArray(root.addresses)) root.addresses.forEach(pushRow);
        if (Array.isArray(root.data)) root.data.forEach(pushRow);
        pushRow(root);
    }
    const seen = new Set();
    return out.filter((loc) => {
        const key = (loc.id || '') + '|' + loc.pickupLocation + '|' + loc.pincode;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function listShiprocketPickupLocations(logisticsRaw, opts) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
    if (!cfg.enabled) throw new Error('Shiprocket API is not configured.');
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (!force && _shiprocketPickupListCache && _shiprocketPickupListCacheExp > now) {
        return _shiprocketPickupListCache;
    }
    const token = await shiprocketLogin(cfg);
    const endpoints = [
        SHIPROCKET_BASE + '/v1/external/settings/company/pickup',
        SHIPROCKET_BASE + '/v1/external/address/pickup'
    ];
    let locations = [];
    for (const url of endpoints) {
        try {
            const res = await requestJson('GET', url, { headers: { Authorization: 'Bearer ' + token } });
            if (res.statusCode === 200 && res.data) {
                locations = locations.concat(parsePickupLocationsFromApiResponse(res.data));
            }
        } catch (_) {}
    }
    const seen = new Set();
    locations = locations.filter((loc) => {
        const key = (loc.id || '') + '|' + loc.pickupLocation + '|' + loc.pincode;
        if (seen.has(key)) return false;
        seen.add(key);
        return loc.pincode.length === 6 || loc.pickupLocation;
    });
    locations.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || a.name.localeCompare(b.name));
    if (!locations.length && cfg.pickupPincode) {
        locations.push({
            id: cfg.pickupLocationId || null,
            name: cfg.pickupLocation || 'Primary',
            pickupLocation: cfg.pickupLocation || 'Primary',
            addressLine: '',
            city: '',
            state: '',
            pincode: String(cfg.pickupPincode).replace(/\D/g, '').slice(0, 6),
            phone: '',
            email: '',
            isPrimary: true
        });
    }
    const result = {
        ok: true,
        locations,
        defaultPickupLocation: cfg.pickupLocation || (locations[0] && locations[0].pickupLocation) || 'Primary',
        defaultPickupPincode:
            cfg.pickupPincode || (locations[0] && locations[0].pincode) || '',
        defaultPickupLocationId: cfg.pickupLocationId || (locations[0] && locations[0].id) || null
    };
    _shiprocketPickupListCache = result;
    _shiprocketPickupListCacheExp = now + 30 * 60 * 1000;
    return result;
}

function pickShiprocketLocation(locations, cfg, params) {
    const list = locations || [];
    const locId =
        params && params.pickupLocationId != null
            ? Number(params.pickupLocationId)
            : cfg.pickupLocationId != null
              ? Number(cfg.pickupLocationId)
              : null;
    const locName = String(
        (params && (params.pickupLocation || params.pickup_location)) || cfg.pickupLocation || ''
    ).trim();
    if (Number.isFinite(locId) && locId > 0) {
        const byId = list.find((l) => l.id === locId);
        if (byId) return byId;
    }
    if (locName) {
        const byName = list.find((l) => l.pickupLocation === locName || l.name === locName);
        if (byName) return byName;
    }
    return list.find((l) => l.isPrimary) || list[0] || null;
}

async function resolveShiprocketPickupSelection(cfg, params, token) {
    const fromParamsPin = String((params && params.pickupPostcode) || '')
        .replace(/\D/g, '')
        .slice(0, 6);
    const fromCfgPin = String(cfg.pickupPincode || process.env.SHIPROCKET_PICKUP_PINCODE || '')
        .replace(/\D/g, '')
        .slice(0, 6);
    let locations = [];
    try {
        const listed = await listShiprocketPickupLocations({ shiprocket: cfg }, { force: false });
        locations = listed.locations || [];
    } catch (_) {}
    const chosen = pickShiprocketLocation(locations, cfg, params);
    if (chosen && chosen.pincode.length === 6) {
        return {
            pincode: chosen.pincode,
            pickupLocation: chosen.pickupLocation,
            pickupLocationId: chosen.id,
            address: chosen
        };
    }
    if (fromParamsPin.length === 6) {
        return {
            pincode: fromParamsPin,
            pickupLocation: (params && params.pickupLocation) || cfg.pickupLocation || 'Primary',
            pickupLocationId: null,
            address: null
        };
    }
    if (fromCfgPin.length === 6) {
        return {
            pincode: fromCfgPin,
            pickupLocation: cfg.pickupLocation || 'Primary',
            pickupLocationId: cfg.pickupLocationId || null,
            address: null
        };
    }
    if (token) {
        const pin = await resolveShiprocketPickupPincodeLegacy(cfg, params, token);
        if (pin.length === 6) {
            return { pincode: pin, pickupLocation: cfg.pickupLocation || 'Primary', pickupLocationId: null, address: null };
        }
    }
    return { pincode: '', pickupLocation: cfg.pickupLocation || 'Primary', pickupLocationId: null, address: null };
}

async function resolveShiprocketPickupPincodeLegacy(cfg, params, token) {
    if (!token) return '';
    try {
        const res = await requestJson('GET', SHIPROCKET_BASE + '/v1/external/settings/company/pickup', {
            headers: { Authorization: 'Bearer ' + token }
        });
        const rows = parsePickupLocationsFromApiResponse(res.data || {});
        for (const row of rows) {
            if (row.pincode.length === 6) {
                cfg.pickupPincode = row.pincode;
                return row.pincode;
            }
        }
    } catch (_) {}
    return '';
}

function nowIST() {
    const now = new Date();
    return new Date(now.getTime() + (330 - now.getTimezoneOffset()) * 60000);
}

function formatShiprocketDateLabel(val) {
    if (val == null || val === '') return '';
    const s = String(val).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const d = new Date(s.slice(0, 10) + 'T12:00:00+05:30');
        if (!Number.isNaN(d.getTime())) {
            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        }
    }
    return s;
}

function addCalendarDaysIST(base, days) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + days);
    while (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d;
}

function defaultEstimatedPickupIST(cutoffTime) {
    const n = nowIST();
    let offsetDays = 0;
    const m = String(cutoffTime || '').match(/(\d{1,2}):(\d{2})/);
    if (m) {
        const cutoffMins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        const nowMins = n.getHours() * 60 + n.getMinutes();
        offsetDays = nowMins < cutoffMins ? 0 : 1;
    } else {
        offsetDays = n.getHours() < 14 ? 0 : 1;
    }
    return formatShiprocketDateLabel(addCalendarDaysIST(n, offsetDays).toISOString().slice(0, 10));
}

function resolveShiprocketPickupInfo(c, root) {
    const rootCtx = root && typeof root === 'object' ? root : {};
    const explicit =
        c.pickup_date ||
        c.pickup_availability_date ||
        c.pickup_scheduled_date ||
        c.estimated_pickup_date ||
        c.pickup_supress_date ||
        c.pickup_suppress_date ||
        c.suppress_date ||
        c.pickup_eta ||
        c.etd_pickup ||
        c.pickup_on ||
        rootCtx.pickup_date ||
        rootCtx.pickup_scheduled_date;
    if (explicit) {
        return {
            pickupDate: formatShiprocketDateLabel(explicit),
            pickupDateSource: 'api',
            cutoffTime: c.cutoff_time || c.courier_cutoff_time || rootCtx.cutoff_time || null
        };
    }
    const suppressDays = Number(
        c.pickup_supress_days != null
            ? c.pickup_supress_days
            : c.pickup_suppress_days != null
              ? c.pickup_suppress_days
              : c.pickup_suppression_days != null
                ? c.pickup_suppression_days
                : c.supress_days
    );
    if (Number.isFinite(suppressDays) && suppressDays >= 0) {
        const d = addCalendarDaysIST(nowIST(), Math.round(suppressDays));
        return {
            pickupDate: formatShiprocketDateLabel(d.toISOString().slice(0, 10)),
            pickupDateSource: 'api',
            cutoffTime: c.cutoff_time || c.courier_cutoff_time || null
        };
    }
    const cutoff = c.cutoff_time || c.courier_cutoff_time || rootCtx.cutoff_time || rootCtx.shiprocket_cutoff_time;
    const estimated = defaultEstimatedPickupIST(cutoff);
    return {
        pickupDate: estimated,
        pickupDateSource: 'estimated',
        cutoffTime: cutoff || null
    };
}

function parseShiprocketCourierList(data) {
    const root = data && (data.data || data);
    const list =
        (root && root.available_courier_companies) ||
        (root && root.available_courier_company_ids) ||
        (root && root.couriers) ||
        [];
    if (!Array.isArray(list)) return [];
    return list
        .map((c) => {
            const id = c.courier_company_id != null ? c.courier_company_id : c.id;
            const rate = Number(c.rate != null ? c.rate : c.freight_charge != null ? c.freight_charge : c.charge);
            const rating = c.rating != null ? Number(c.rating) : c.courier_rating != null ? Number(c.courier_rating) : null;
            const deliveryDate = c.edd || c.estimated_delivery_date || c.delivery_date || null;
            const etd =
                (deliveryDate ? formatShiprocketDateLabel(deliveryDate) : '') ||
                (c.etd ? formatShiprocketDateLabel(c.etd) : '') ||
                (c.estimated_delivery_days != null ? String(c.estimated_delivery_days) + ' days' : '') ||
                '';
            const pickup = resolveShiprocketPickupInfo(c, root);
            return {
                courierId: id != null ? Number(id) : null,
                courierName: String(c.courier_name || c.name || '').trim(),
                rate: Number.isFinite(rate) ? rate : null,
                rating: Number.isFinite(rating) ? rating : null,
                etd: etd ? String(etd) : '',
                pickupDate: pickup.pickupDate || null,
                pickupDateSource: pickup.pickupDateSource,
                cutoffTime: pickup.cutoffTime,
                deliveryDate: deliveryDate ? formatShiprocketDateLabel(deliveryDate) : etd || null,
                cod: c.cod != null ? !!Number(c.cod) : false,
                mode: c.mode ? String(c.mode) : '',
                isSurface: /surface/i.test(String(c.mode || c.courier_type || '')),
                isAir: /air|express/i.test(String(c.mode || c.courier_type || ''))
            };
        })
        .filter((c) => c.courierName || c.courierId != null)
        .sort((a, b) => {
            const ra = a.rate != null ? a.rate : 1e9;
            const rb = b.rate != null ? b.rate : 1e9;
            return ra - rb;
        });
}

async function resolveShiprocketPickupPincode(cfg, params, token) {
    const sel = await resolveShiprocketPickupSelection(cfg, params, token);
    if (sel.pincode.length === 6) {
        _shiprocketPickupPinCache = sel.pincode;
        _shiprocketPickupPinCacheExp = Date.now() + 6 * 60 * 60 * 1000;
        return sel.pincode;
    }
    return '';
}

function extractShiprocketTrackEvents(td) {
    if (!td || typeof td !== 'object') return [];
    const events = [];
    const seen = new Set();
    const push = (a) => {
        if (!a || typeof a !== 'object') return;
        const desc = [a.activity, a.status, a['sr-status-label'], a.sr_status_label, a.remark, a.comments]
            .map((x) => (x != null ? String(x).trim() : ''))
            .filter(Boolean)
            .join(' — ');
        if (!desc) return;
        const at = a.date || a.activity_date || a['date'] || a.event_date || a.datetime || null;
        const city = String(a.city || a.location_city || a.destination_city || '').trim();
        const state = String(a.state || a.location_state || a.destination_state || '').trim();
        const country = String(a.country || a.location_country || 'India').trim() || 'India';
        const facility = String(
            a.sr_facility || a.facility || a.hub_name || a.hub || a.current_location || a.location || a.sr_location || ''
        ).trim();
        const locationParts = [facility, city, state, country].filter((p, i, arr) => p && arr.indexOf(p) === i);
        const key = (at || '') + '|' + desc + '|' + locationParts.join(',');
        if (seen.has(key)) return;
        seen.add(key);
        events.push({
            at,
            description: desc,
            city,
            state,
            country,
            facility,
            location: locationParts.join(', ')
        });
    };
    const acts = td.shipment_track_activities || td.activities || [];
    if (Array.isArray(acts)) acts.forEach(push);
    const tracks = td.shipment_track || [];
    if (Array.isArray(tracks)) {
        tracks.forEach((block) => {
            if (block && block.shipment_track_activities) block.shipment_track_activities.forEach(push);
            if (block && (block.activity || block.status)) push(block);
        });
    }
    events.sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : NaN;
        const tb = b.at ? new Date(b.at).getTime() : NaN;
        if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
        if (!Number.isFinite(ta)) return 1;
        if (!Number.isFinite(tb)) return -1;
        return ta - tb;
    });
    return events;
}

async function getShiprocketServiceability(logisticsRaw, params) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
    if (!cfg.enabled) throw new Error('Shiprocket API is not configured.');
    const token = await shiprocketLogin(cfg);
    const pickupSel = await resolveShiprocketPickupSelection(cfg, params, token);
    let pickupPostcode = pickupSel.pincode;
    const deliveryPostcode = String((params && params.deliveryPostcode) || '')
        .replace(/\D/g, '')
        .slice(0, 6);
    if (pickupPostcode.length !== 6 || deliveryPostcode.length !== 6) {
        throw new Error(
            pickupPostcode.length !== 6
                ? 'Shiprocket pickup PIN missing. Set warehouse PIN in Book sales → Settings → Logistics API (Pickup PIN), or add pickupPostcode in the rate request.'
                : 'Valid 6-digit delivery PIN code is required.'
        );
    }
    const weightKg = Math.max(0.2, Number(params && params.weightKg) || 0.5);
    const cod = params && params.cod ? 1 : 0;
    const length = Math.max(1, Math.round(Number(params && params.length) || 25));
    const breadth = Math.max(1, Math.round(Number(params && params.breadth) || 20));
    const height = Math.max(1, Math.round(Number(params && params.height) || 5));
    const qs = new URLSearchParams({
        pickup_postcode: pickupPostcode,
        delivery_postcode: deliveryPostcode,
        weight: String(weightKg),
        cod: String(cod),
        length: String(length),
        breadth: String(breadth),
        height: String(height)
    });
    const res = await requestJson(
        'GET',
        SHIPROCKET_BASE + '/v1/external/courier/serviceability/?' + qs.toString(),
        { headers: { Authorization: 'Bearer ' + token } }
    );
    if (res.statusCode !== 200 || !res.data) {
        const msg =
            (res.data && (res.data.message || res.data.error)) ||
            'Shiprocket serviceability check failed (HTTP ' + res.statusCode + ')';
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    const root = res.data.data || res.data;
    const couriers = parseShiprocketCourierList(res.data);
    const serviceable =
        root && (root.is_pincode_serviceable != null
            ? !!Number(root.is_pincode_serviceable)
            : couriers.length > 0);
    return {
        ok: true,
        serviceable,
        pickupPostcode,
        pickupLocation: pickupSel.pickupLocation,
        pickupLocationId: pickupSel.pickupLocationId,
        deliveryPostcode,
        weightKg,
        length,
        breadth,
        height,
        couriers,
        city: root && (root.city || root.delivery_city) ? String(root.city || root.delivery_city) : '',
        state: root && (root.state || root.delivery_state) ? String(root.state || root.delivery_state) : '',
        raw: res.data
    };
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
    const root = res.data;
    const td = root.tracking_data || root.data || root;
    const events = extractShiprocketTrackEvents(td);
    const statusText = String(
        td.shipment_status ||
            td.track_status ||
            td.current_status ||
            (events.length ? events[events.length - 1].description : '') ||
            ''
    );
    const delivered = /deliver/i.test(statusText) || Number(td.shipment_status) === 7 || Number(td.track_status) === 7;
    if (!events.length && !statusText) return null;
    return {
        ok: true,
        status: delivered ? 'delivered' : /out for delivery/i.test(statusText) ? 'out_for_delivery' : 'in_transit',
        statusLabel: statusText || (events.length ? events[events.length - 1].description : 'Shiprocket update'),
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

function splitCustomerName(full) {
    const parts = String(full || 'Customer').trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || 'Customer', last: parts.slice(1).join(' ') || '.' };
}

function orderItemsForAggregator(order) {
    const items = (order.items || []).map((it, i) => ({
        name: String(it.bookTitle || it.bookId || 'Book').slice(0, 120),
        sku: 'BOOK_' + String(it.bookId || i).replace(/[^a-zA-Z0-9_-]/g, '_'),
        units: Math.max(1, parseInt(it.qty, 10) || 1),
        selling_price: Number(it.unitPrice) || 0,
        discount: 0,
        tax: 0
    }));
    if (!items.length) {
        items.push({
            name: 'Books',
            sku: 'BOOK_SET',
            units: 1,
            selling_price: Number(order.totalAmount) || 0,
            discount: 0,
            tax: 0
        });
    }
    return items;
}

function shiprocketOrderPayload(order, opts) {
    const { first, last } = splitCustomerName(order.shippingRecipientName || order.buyerName);
    const pincode = String(order.shippingPincode || '').replace(/\D/g, '').slice(0, 6);
    const weight = Math.max(0.2, Number(opts && opts.weightKg) || 0.8);
    const orderDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return {
        order_id: String(order.orderCode || order.id),
        order_date: orderDate,
        pickup_location: (opts && opts.pickupLocation) || process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
        billing_customer_name: first,
        billing_last_name: last,
        billing_address: String(order.deliveryAddress || order.shippingCity || 'Address').slice(0, 180),
        billing_city: String(order.shippingCity || '').slice(0, 60),
        billing_pincode: pincode,
        billing_state: String(order.shippingState || '').slice(0, 60),
        billing_country: 'India',
        billing_email: String(order.buyerEmail || opts?.buyerEmail || 'books@vaidyagogate.org').slice(0, 80),
        billing_phone: String(order.shippingPhone || order.buyerPhone || '9999999999').replace(/\D/g, '').slice(-10),
        shipping_is_billing: true,
        order_items: orderItemsForAggregator(order),
        payment_method: 'Prepaid',
        sub_total: Number(order.totalAmount) || 0,
        length: Math.max(1, Number(opts && opts.length) || 25),
        breadth: Math.max(1, Number(opts && opts.breadth) || 20),
        height: Math.max(1, Number(opts && opts.height) || 5),
        weight
    };
}

async function bookShiprocketShipment(order, logisticsRaw, opts) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
    if (!cfg.enabled) throw new Error('Shiprocket API is not configured. Add credentials in Book sales → Logistics API.');
    const token = await shiprocketLogin(cfg);
    const payload = shiprocketOrderPayload(order, opts);
    const createRes = await requestJson('POST', SHIPROCKET_BASE + '/v1/external/orders/create/adhoc', {
        headers: { Authorization: 'Bearer ' + token },
        body: payload
    });
    const createData = createRes.data || {};
    const shipmentId =
        createData.shipment_id ||
        (createData.payload && createData.payload.shipment_id) ||
        (createData.data && createData.data.shipment_id);
    if (!shipmentId) {
        const msg =
            (createData.message || createData.error || createData.errors) &&
            JSON.stringify(createData.message || createData.error || createData.errors);
        throw new Error(msg || 'Shiprocket did not return a shipment id');
    }
    const assignBody = { shipment_id: shipmentId };
    const courierId = opts && opts.courierId != null ? parseInt(opts.courierId, 10) : null;
    if (Number.isInteger(courierId) && courierId > 0) assignBody.courier_id = courierId;
    const assignRes = await requestJson('POST', SHIPROCKET_BASE + '/v1/external/courier/assign/awb', {
        headers: { Authorization: 'Bearer ' + token },
        body: assignBody
    });
    const assignData = assignRes.data || {};
    const inner = assignData.response && assignData.response.data ? assignData.response.data : assignData;
    const awb =
        inner.awb_code ||
        inner.awb ||
        assignData.awb_code ||
        (assignData.data && assignData.data.awb_code);
    if (!awb) {
        throw new Error(
            (assignData.message && String(assignData.message)) ||
                'Shiprocket order created but AWB assignment failed — assign AWB in Shiprocket panel or enter AWB manually.'
        );
    }
    const labelUrl = await getShiprocketLabelUrl(token, shipmentId).catch(() => null);
    const shiprocketOrderId =
        createData.order_id ||
        (createData.data && createData.data.order_id) ||
        (createData.data && createData.data.id) ||
        createData.id ||
        assignData.order_id ||
        (assignData.data && assignData.data.order_id) ||
        null;
    return {
        awb: String(awb).trim(),
        shipmentId: String(shipmentId),
        aggregatorOrderId:
            shiprocketOrderId != null
                ? String(shiprocketOrderId)
                : String(createData.channel_order_id || order.orderCode || ''),
        courierName: inner.courier_name || assignData.courier_name || 'Shiprocket',
        courierProvider: String(inner.courier_name || 'shiprocket').toLowerCase().replace(/\s+/g, '_'),
        labelUrl,
        source: 'shiprocket',
        raw: { create: createData, assign: assignData }
    };
}

async function bookNimbuspostShipment(order, logisticsRaw, opts) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).nimbuspost;
    if (!cfg.enabled) throw new Error('Nimbuspost API is not configured. Add credentials in Book sales → Logistics API.');
    const token = await nimbusLogin(cfg);
    const headers =
        token && String(token).length > 40
            ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
            : { 'Api-Key': cfg.apiKey, 'Api-Secret': cfg.apiSecret, 'Content-Type': 'application/json' };
    const pincode = String(order.shippingPincode || '').replace(/\D/g, '').slice(0, 6);
    const weightG = Math.round(Math.max(200, (Number(opts && opts.weightKg) || 0.8) * 1000));
    const payload = {
        order_number: String(order.orderCode || order.id),
        order_id: String(order.orderCode || order.id),
        payment_type: 'prepaid',
        weight: weightG,
        consignee: {
            name: order.shippingRecipientName || order.buyerName || 'Customer',
            phone: String(order.shippingPhone || order.buyerPhone || '').replace(/\D/g, '').slice(-10),
            address: String(order.deliveryAddress || '').slice(0, 200),
            city: order.shippingCity || '',
            state: order.shippingState || '',
            pincode,
            country: 'IN'
        },
        order_items: orderItemsForAggregator(order).map((it) => ({
            name: it.name,
            sku: it.sku,
            qty: it.units,
            price: it.selling_price
        }))
    };
    const urls = [
        NIMBUSPOST_BASE + '/v1/shipments',
        NIMBUSPOST_BASE + '/v1/shipment/create',
        NIMBUSPOST_BASE + '/v1/orders'
    ];
    let lastErr = null;
    for (const url of urls) {
        try {
            const res = await requestJson('POST', url, { headers, body: payload });
            const d = res.data && (res.data.data || res.data);
            if (!d || (res.statusCode !== 200 && res.statusCode !== 201)) {
                lastErr = new Error((d && d.message) || 'Nimbuspost booking failed');
                continue;
            }
            const awb = d.awb || d.awb_number || d.waybill || d.tracking_number;
            if (!awb) {
                lastErr = new Error('Nimbuspost response missing AWB');
                continue;
            }
            const labelUrl = await getNimbuspostLabelUrl(headers, d.shipment_id || d.id || '').catch(() => null);
            return {
                awb: String(awb).trim(),
                shipmentId: String(d.shipment_id || d.id || ''),
                aggregatorOrderId: String(d.order_id || d.order_number || order.orderCode || ''),
                courierName: d.courier_name || d.courier || 'Nimbuspost',
                courierProvider: 'nimbuspost',
                labelUrl,
                source: 'nimbuspost',
                raw: d
            };
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('Nimbuspost booking failed — check API credentials or create shipment in Nimbuspost dashboard.');
}

async function getShiprocketLabelUrl(token, shipmentId) {
    const sid = shipmentId != null ? String(shipmentId).trim() : '';
    if (!sid) return null;
    const attempts = [
        () =>
            requestJson('POST', SHIPROCKET_BASE + '/v1/external/courier/generate/label', {
                headers: { Authorization: 'Bearer ' + token },
                body: { shipment_id: [parseInt(sid, 10)] }
            }),
        () =>
            requestJson('POST', SHIPROCKET_BASE + '/v1/external/courier/generate/label', {
                headers: { Authorization: 'Bearer ' + token },
                body: { shipment_id: parseInt(sid, 10) }
            })
    ];
    for (const fn of attempts) {
        const res = await fn().catch(() => null);
        if (!res || !res.data) continue;
        const d = res.data;
        const url =
            d.label_url ||
            (d.response && d.response.label_url) ||
            (d.data && d.data.label_url) ||
            (d.response && d.response.label && d.response.label.url) ||
            (d.data && d.data.label && d.data.label.url) ||
            null;
        if (url) return String(url);
    }
    return null;
}

async function getNimbuspostLabelUrl(headers, shipmentId) {
    const sid = shipmentId != null ? String(shipmentId).trim() : '';
    if (!sid) return null;
    const urls = [
        NIMBUSPOST_BASE + '/v1/shipments/label/' + encodeURIComponent(sid),
        NIMBUSPOST_BASE + '/v1/shipment/label/' + encodeURIComponent(sid),
        NIMBUSPOST_BASE + '/v1/label/' + encodeURIComponent(sid)
    ];
    for (const url of urls) {
        const res = await requestJson('GET', url, { headers }).catch(() => null);
        if (!res || !res.data) continue;
        const d = res.data.data || res.data;
        const out = d.label_url || d.label || d.pdf_url || d.url || null;
        if (out) return String(out);
    }
    return null;
}

function shiprocketApiSuccess(res) {
    if (!res || res.statusCode < 200 || res.statusCode >= 300) return false;
    const d = res.data;
    if (!d || typeof d !== 'object') return true;
    if (d.status === 1 || d.status === true || d.success === true || d.status_code === 200) return true;
    const msg = String(d.message || d.error || '').toLowerCase();
    if (/already cancel|cancelled|not found|no shipment/i.test(msg)) return true;
    if (Array.isArray(d.data) && d.data.length) return true;
    return res.statusCode === 200 || res.statusCode === 201;
}

async function cancelShiprocketShipment(logisticsRaw, params) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
    if (!cfg.enabled) return { ok: false, skipped: true, reason: 'shiprocket_not_configured' };
    const token = await shiprocketLogin(cfg);
    const p = params && typeof params === 'object' ? params : { shipmentId: params };
    const sid = parseInt(p.shipmentId, 10);
    const awb = String(p.awb || '').trim();
    const orderId = p.shiprocketOrderId != null ? parseInt(p.shiprocketOrderId, 10) : null;
    const attempts = [];
    if (Number.isInteger(orderId) && orderId > 0) {
        attempts.push({
            method: 'POST',
            url: SHIPROCKET_BASE + '/v1/external/orders/cancel',
            body: { ids: [orderId] }
        });
    }
    if (awb) {
        attempts.push({
            method: 'POST',
            url: SHIPROCKET_BASE + '/v1/external/orders/cancel/shipment',
            body: { awbs: [awb] }
        });
    }
    if (Number.isInteger(sid) && sid > 0) {
        attempts.push({
            method: 'POST',
            url: SHIPROCKET_BASE + '/v1/external/orders/cancel/shipment',
            body: { awbs: [], shipment_id: [sid] }
        });
        attempts.push({
            method: 'POST',
            url: SHIPROCKET_BASE + '/v1/external/orders/cancel',
            body: { ids: [sid] }
        });
    }
    if (!attempts.length) return { ok: false, skipped: true, reason: 'nothing_to_cancel' };
    let lastErr = 'Shiprocket cancellation API rejected the request';
    for (const a of attempts) {
        const res = await requestJson(a.method, a.url, {
            headers: { Authorization: 'Bearer ' + token },
            body: a.body
        }).catch((e) => ({ statusCode: 0, data: { message: e.message } }));
        if (shiprocketApiSuccess(res)) {
            return { ok: true, source: 'shiprocket', method: a.url, raw: res.data };
        }
        const msg = res && res.data && (res.data.message || res.data.error);
        if (msg) lastErr = String(msg);
    }
    return { ok: false, source: 'shiprocket', error: lastErr };
}

async function cancelNimbuspostShipment(logisticsRaw, shipmentId) {
    const cfg = normalizeLogisticsConfig(logisticsRaw).nimbuspost;
    if (!cfg.enabled) return { ok: false, skipped: true, reason: 'nimbuspost_not_configured' };
    const token = await nimbusLogin(cfg);
    const headers =
        token && String(token).length > 40
            ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
            : { 'Api-Key': cfg.apiKey, 'Api-Secret': cfg.apiSecret, 'Content-Type': 'application/json' };
    const sid = shipmentId != null ? String(shipmentId).trim() : '';
    if (!sid) return { ok: false, skipped: true, reason: 'invalid_shipment_id' };
    const attempts = [
        { method: 'POST', url: NIMBUSPOST_BASE + '/v1/shipments/cancel/' + encodeURIComponent(sid), body: {} },
        { method: 'POST', url: NIMBUSPOST_BASE + '/v1/shipment/cancel/' + encodeURIComponent(sid), body: {} },
        { method: 'POST', url: NIMBUSPOST_BASE + '/v1/shipments/cancel', body: { shipment_id: sid } }
    ];
    for (const a of attempts) {
        const res = await requestJson(a.method, a.url, { headers, body: a.body }).catch(() => null);
        if (res && (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 202)) {
            return { ok: true, source: 'nimbuspost', raw: res.data };
        }
    }
    return { ok: false, source: 'nimbuspost', error: 'Nimbuspost cancellation API rejected the request' };
}

async function getAggregatorLabel(logisticsRaw, aggregator, shipmentId) {
    const agg = String(aggregator || '').toLowerCase();
    if (agg === 'shiprocket') {
        const cfg = normalizeLogisticsConfig(logisticsRaw).shiprocket;
        if (!cfg.enabled) return { ok: false, error: 'Shiprocket not configured' };
        const token = await shiprocketLogin(cfg);
        const url = await getShiprocketLabelUrl(token, shipmentId);
        return { ok: !!url, labelUrl: url || null, source: 'shiprocket' };
    }
    if (agg === 'nimbuspost') {
        const cfg = normalizeLogisticsConfig(logisticsRaw).nimbuspost;
        if (!cfg.enabled) return { ok: false, error: 'Nimbuspost not configured' };
        const token = await nimbusLogin(cfg);
        const headers =
            token && String(token).length > 40
                ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
                : { 'Api-Key': cfg.apiKey, 'Api-Secret': cfg.apiSecret, 'Content-Type': 'application/json' };
        const url = await getNimbuspostLabelUrl(headers, shipmentId);
        return { ok: !!url, labelUrl: url || null, source: 'nimbuspost' };
    }
    return { ok: false, error: 'Unsupported aggregator' };
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
    shiprocketLogin,
    trackShiprocket,
    trackNimbuspost,
    getShiprocketServiceability,
    listShiprocketPickupLocations,
    resolveShiprocketPickupPincode,
    resolveShiprocketPickupSelection,
    parseShiprocketCourierList,
    bookShiprocketShipment,
    bookNimbuspostShipment,
    cancelShiprocketShipment,
    cancelNimbuspostShipment,
    getAggregatorLabel
};

/**
 * Tookan (logistics + hyperlocal), Shipday (hyperlocal), Pidge, and self-hosted Fleetbase
 * for book commerce. Keys live in global_settings (commerce_logistics_config).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');
const qrSvgTag = require('qrcode/lib/renderer/svg-tag');

const CONFIG_KEY = 'commerce_logistics_config';
const TOOKAN_BASE = 'https://api.tookanapp.com/v2';
const SHIPDAY_BASE = 'https://api.shipday.com';
const PIDGE_BASE = 'https://api.pidge.in';

const COMMERCE_COLUMNS = [
    ['commerce_provider', 'TEXT'],
    ['commerce_mode', 'TEXT'],
    ['commerce_stage', 'TEXT'],
    ['pickup_otp', 'TEXT'],
    ['delivery_otp', 'TEXT'],
    ['tookan_job_id', 'TEXT'],
    ['tookan_delivery_job_id', 'TEXT'],
    ['tookan_tracking_link', 'TEXT'],
    ['shipday_order_id', 'TEXT'],
    ['shipday_tracking_link', 'TEXT'],
    ['pidge_order_id', 'TEXT'],
    ['fleetbase_order_id', 'TEXT'],
    ['commerce_open_box', 'INTEGER'],
    ['agent_name', 'TEXT'],
    ['agent_phone', 'TEXT'],
    ['agent_lat', 'REAL'],
    ['agent_lng', 'REAL'],
    ['agent_location_at', 'TEXT'],
    ['rescheduled_at', 'TEXT'],
    ['rescheduled_for_start', 'TEXT'],
    ['rescheduled_for_end', 'TEXT'],
    ['delivery_note', 'TEXT'],
    ['store_lat', 'REAL'],
    ['store_lng', 'REAL'],
    ['drop_lat', 'REAL'],
    ['drop_lng', 'REAL'],
    ['tracking_token', 'TEXT'],
    ['live_leg', 'TEXT'],
    ['order_channel', 'TEXT'],
    ['return_kind', 'TEXT'],
    ['return_status', 'TEXT'],
    ['return_reason', 'TEXT'],
    ['return_provider', 'TEXT'],
    ['return_mode', 'TEXT'],
    ['return_pickup_otp', 'TEXT'],
    ['return_tookan_job_id', 'TEXT'],
    ['return_tookan_delivery_job_id', 'TEXT'],
    ['return_shipday_order_id', 'TEXT'],
    ['return_pidge_order_id', 'TEXT'],
    ['return_fleetbase_order_id', 'TEXT'],
    ['return_tracking_link', 'TEXT'],
    ['return_agent_name', 'TEXT'],
    ['return_agent_phone', 'TEXT'],
    ['return_agent_lat', 'REAL'],
    ['return_agent_lng', 'REAL'],
    ['return_scheduled_at', 'TEXT'],
    ['commerce_pickup_at', 'TEXT'],
    ['commerce_delivery_at', 'TEXT'],
    ['commerce_awb', 'TEXT'],
    ['commerce_fragile', 'INTEGER'],
    ['commerce_heavy', 'INTEGER'],
    ['commerce_cod', 'INTEGER'],
    ['commerce_cod_amount', 'REAL'],
    ['commerce_cancel_code', 'TEXT'],
    ['commerce_obd_otp', 'TEXT'],
    ['commerce_route_json', 'TEXT'],
    ['commerce_provider_tracking', 'TEXT'],
    ['commerce_razorpay_qr_id', 'TEXT'],
    ['commerce_razorpay_qr_image', 'TEXT'],
    ['commerce_cod_paid', 'INTEGER'],
    ['commerce_route_index', 'INTEGER'],
    ['commerce_hop_phase', 'TEXT'],
    ['commerce_hyperlocal_status', 'TEXT']
];

const STAGES = ['placed', 'accepted', 'preparing', 'ready', 'pickup_scheduled', 'in_transit', 'out_for_delivery', 'delivered'];

function columnAlters(isPg) {
    return COMMERCE_COLUMNS.map(([name, type]) =>
        isPg
            ? `ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS ${name} ${type}`
            : `ALTER TABLE book_orders ADD COLUMN ${name} ${type}`
    );
}

function deliveryAttemptsSql(isPg) {
    return isPg
        ? `CREATE TABLE IF NOT EXISTS delivery_attempts (
            id SERIAL PRIMARY KEY,
            shipment_id INTEGER NOT NULL,
            attempt_number INTEGER NOT NULL,
            provider TEXT,
            external_task_id TEXT,
            agent_id TEXT,
            scheduled_date TEXT,
            scheduled_start TEXT,
            scheduled_end TEXT,
            started_at TEXT,
            completed_at TEXT,
            status TEXT,
            failure_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            rescheduled_at TEXT,
            rescheduled_for_date TEXT,
            rescheduled_for_start TEXT,
            rescheduled_for_end TEXT,
            reschedule_reason TEXT,
            reschedule_source TEXT,
            original_attempt_id INTEGER,
            rescheduled_attempt_id INTEGER
        )`
        : `CREATE TABLE IF NOT EXISTS delivery_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shipment_id INTEGER NOT NULL,
            attempt_number INTEGER NOT NULL,
            provider TEXT,
            external_task_id TEXT,
            agent_id TEXT,
            scheduled_date TEXT,
            scheduled_start TEXT,
            scheduled_end TEXT,
            started_at TEXT,
            completed_at TEXT,
            status TEXT,
            failure_reason TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            rescheduled_at TEXT,
            rescheduled_for_date TEXT,
            rescheduled_for_start TEXT,
            rescheduled_for_end TEXT,
            reschedule_reason TEXT,
            reschedule_source TEXT,
            original_attempt_id INTEGER,
            rescheduled_attempt_id INTEGER
        )`;
}

function requestJson(method, url, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body != null ? JSON.stringify(body) : null;
        const opts = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'VGMF-Seminar-Commerce/1.0',
                ...headers
            },
            timeout: timeoutMs
        };
        if (data) {
            opts.headers['Content-Type'] = 'application/json';
            opts.headers['Content-Length'] = Buffer.byteLength(data);
        }
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(opts, (res) => {
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

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function generateOtp() {
    return String(crypto.randomInt(1000, 10000));
}

function generateToken() {
    return crypto.randomBytes(18).toString('hex');
}

function defaultShopSettings() {
    return {
        enabled: true,
        razorpayEnabled: true,
        codEnabled: true,
        storePickupEnabled: true,
        deliveryEnabled: true,
        orderOpen: '09:00',
        orderClose: '21:00',
        pickupOpen: '10:00',
        pickupClose: '18:00',
        deliveryOpen: '10:00',
        deliveryClose: '20:00',
        pickupLeadMinutes: 30,
        deliveryLeadMinutes: 90,
        returnWindowDays: 7,
        returnsEnabled: true,
        replacementsEnabled: true,
        codExtraCharge: 0
    };
}

function hhmm(value, fallback) {
    const s = String(value || '').trim();
    return /^\d{2}:\d{2}$/.test(s) ? s : fallback;
}

function normalizeShop(raw) {
    const base = defaultShopSettings();
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: s.enabled === undefined ? base.enabled : truthy(s.enabled),
        razorpayEnabled: s.razorpayEnabled === undefined ? base.razorpayEnabled : truthy(s.razorpayEnabled),
        codEnabled: s.codEnabled === undefined ? base.codEnabled : truthy(s.codEnabled),
        storePickupEnabled: s.storePickupEnabled === undefined ? base.storePickupEnabled : truthy(s.storePickupEnabled),
        deliveryEnabled: s.deliveryEnabled === undefined ? base.deliveryEnabled : truthy(s.deliveryEnabled),
        returnsEnabled: s.returnsEnabled === undefined ? base.returnsEnabled : truthy(s.returnsEnabled),
        replacementsEnabled: s.replacementsEnabled === undefined ? base.replacementsEnabled : truthy(s.replacementsEnabled),
        orderOpen: hhmm(s.orderOpen, base.orderOpen),
        orderClose: hhmm(s.orderClose, base.orderClose),
        pickupOpen: hhmm(s.pickupOpen, base.pickupOpen),
        pickupClose: hhmm(s.pickupClose, base.pickupClose),
        deliveryOpen: hhmm(s.deliveryOpen, base.deliveryOpen),
        deliveryClose: hhmm(s.deliveryClose, base.deliveryClose),
        pickupLeadMinutes: Math.max(5, parseInt(s.pickupLeadMinutes, 10) || base.pickupLeadMinutes),
        deliveryLeadMinutes: Math.max(15, parseInt(s.deliveryLeadMinutes, 10) || base.deliveryLeadMinutes),
        returnWindowDays: Math.max(0, parseInt(s.returnWindowDays, 10) || base.returnWindowDays),
        codExtraCharge: Math.max(0, Number(s.codExtraCharge) || 0)
    };
}

function istMinutesNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date());
    const g = (t) => {
        const hit = parts.find((p) => p.type === t);
        return hit ? hit.value : '00';
    };
    let hour = g('hour');
    if (hour === '24') hour = '00';
    return parseInt(hour, 10) * 60 + parseInt(g('minute'), 10);
}

function minutesOf(hhmmValue) {
    const [h, m] = String(hhmmValue || '00:00').split(':');
    return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
}

function withinIstWindow(open, close, nowMinutes) {
    const start = minutesOf(open);
    const end = minutesOf(close);
    const now = nowMinutes == null ? istMinutesNow() : nowMinutes;
    if (start === end) return true;
    if (start < end) return now >= start && now <= end;
    return now >= start || now <= end;
}

function normalizeFleetbaseHost(value) {
    const host = String(value || '').trim().replace(/\/+$/, '');
    if (!host) return '';
    if (!/^https?:\/\//i.test(host)) return '';
    return host;
}

function normalizeCommerceConfig(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const tookan = c.tookan && typeof c.tookan === 'object' ? c.tookan : {};
    const shipday = c.shipday && typeof c.shipday === 'object' ? c.shipday : {};
    const pidge = c.pidge && typeof c.pidge === 'object' ? c.pidge : {};
    const fleetbase = c.fleetbase && typeof c.fleetbase === 'object' ? c.fleetbase : {};
    const tookanKey = String(tookan.apiKey || process.env.TOOKAN_API_KEY || '').trim();
    const shipdayKey = String(shipday.apiKey || process.env.SHIPDAY_API_KEY || '').trim();
    const pidgeUser = String(pidge.username || process.env.PIDGE_USERNAME || '').trim();
    const pidgePass = String(pidge.password || process.env.PIDGE_PASSWORD || '').trim();
    const mapsKey = String(c.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY || '').trim();
    const fleetHost = normalizeFleetbaseHost(fleetbase.apiHost || process.env.FLEETBASE_API_HOST || '');
    const fleetKey = String(fleetbase.secretKey || process.env.FLEETBASE_SECRET_KEY || '').trim();
    const mode = String(c.defaultMode || tookan.defaultMode || 'logistics').toLowerCase() === 'hyperlocal' ? 'hyperlocal' : 'logistics';
    const hyperRaw = String(c.defaultHyperlocalProvider || 'shipday').toLowerCase();
    const hyper = hyperRaw === 'tookan' || hyperRaw === 'pidge' || hyperRaw === 'fleetbase' ? hyperRaw : 'shipday';
    return {
        storeName: String(c.storeName || 'VGMF Book Desk').trim(),
        storePhone: String(c.storePhone || '').trim(),
        storeEmail: String(c.storeEmail || '').trim(),
        storeAddress: String(c.storeAddress || '').trim(),
        storeCity: String(c.storeCity || '').trim(),
        storeState: String(c.storeState || '').trim(),
        storePincode: String(c.storePincode || '').replace(/\D/g, '').slice(0, 6),
        storeLat: numOrNull(c.storeLat),
        storeLng: numOrNull(c.storeLng),
        mapsApiKey: mapsKey,
        defaultMode: mode,
        defaultHyperlocalProvider: hyper,
        tookan: {
            enabled: truthy(tookan.enabled) && !!tookanKey,
            apiKey: tookanKey,
            sharedSecret: String(tookan.sharedSecret || '').trim(),
            defaultMode: String(tookan.defaultMode || mode).toLowerCase() === 'hyperlocal' ? 'hyperlocal' : 'logistics'
        },
        shipday: {
            enabled: truthy(shipday.enabled) && !!shipdayKey,
            apiKey: shipdayKey
        },
        pidge: {
            enabled: truthy(pidge.enabled) && !!pidgeUser && !!pidgePass,
            username: pidgeUser,
            password: pidgePass,
            webhookToken: String(pidge.webhookToken || '').trim(),
            channel: String(pidge.channel || '').trim()
        },
        fleetbase: {
            enabled: truthy(fleetbase.enabled) && !!fleetHost && !!fleetKey,
            apiHost: fleetHost,
            secretKey: fleetKey,
            webhookToken: String(fleetbase.webhookToken || '').trim(),
            orderType: String(fleetbase.orderType || '').trim(),
            hubs: String(fleetbase.hubs || '').trim(),
            openBoxDelivery: truthy(fleetbase.openBoxDelivery)
        },
        shop: normalizeShop(c.shop)
    };
}

function publicConfigView(cfg) {
    const c = normalizeCommerceConfig(cfg);
    const mask = (k) => (k ? '••••' + k.slice(-4) : '');
    return {
        storeName: c.storeName,
        storePhone: c.storePhone,
        storeEmail: c.storeEmail,
        storeAddress: c.storeAddress,
        storeCity: c.storeCity,
        storeState: c.storeState,
        storePincode: c.storePincode,
        storeLat: c.storeLat,
        storeLng: c.storeLng,
        mapsKeySet: !!c.mapsApiKey,
        mapsKeyHint: mask(c.mapsApiKey),
        defaultMode: c.defaultMode,
        defaultHyperlocalProvider: c.defaultHyperlocalProvider,
        tookan: {
            enabled: !!(cfg && cfg.tookan && truthy(cfg.tookan.enabled)),
            configured: c.tookan.enabled,
            apiKeyHint: mask(c.tookan.apiKey),
            sharedSecretSet: !!c.tookan.sharedSecret,
            defaultMode: c.tookan.defaultMode
        },
        shipday: {
            enabled: !!(cfg && cfg.shipday && truthy(cfg.shipday.enabled)),
            configured: c.shipday.enabled,
            apiKeyHint: mask(c.shipday.apiKey)
        },
        pidge: {
            enabled: !!(cfg && cfg.pidge && truthy(cfg.pidge.enabled)),
            configured: c.pidge.enabled,
            usernameHint: mask(c.pidge.username),
            webhookTokenSet: !!c.pidge.webhookToken,
            channel: c.pidge.channel || ''
        },
        fleetbase: {
            enabled: !!(cfg && cfg.fleetbase && truthy(cfg.fleetbase.enabled)),
            configured: c.fleetbase.enabled,
            apiHost: c.fleetbase.apiHost,
            secretHint: mask(c.fleetbase.secretKey),
            webhookTokenSet: !!c.fleetbase.webhookToken,
            orderType: c.fleetbase.orderType || '',
            hubs: c.fleetbase.hubs || '',
            openBoxDelivery: c.fleetbase.openBoxDelivery
        },
        shop: c.shop,
        shopPath: '/shop'
    };
}

function mergeConfigSecrets(previous, incoming) {
    const prev = previous && typeof previous === 'object' ? previous : {};
    const next = incoming && typeof incoming === 'object' ? incoming : {};
    const tookanIn = next.tookan && typeof next.tookan === 'object' ? next.tookan : {};
    const shipIn = next.shipday && typeof next.shipday === 'object' ? next.shipday : {};
    const pidgeIn = next.pidge && typeof next.pidge === 'object' ? next.pidge : {};
    const fleetIn = next.fleetbase && typeof next.fleetbase === 'object' ? next.fleetbase : {};
    const prevTookan = prev.tookan && typeof prev.tookan === 'object' ? prev.tookan : {};
    const prevShip = prev.shipday && typeof prev.shipday === 'object' ? prev.shipday : {};
    const prevPidge = prev.pidge && typeof prev.pidge === 'object' ? prev.pidge : {};
    const prevFleet = prev.fleetbase && typeof prev.fleetbase === 'object' ? prev.fleetbase : {};
    const keep = (incomingVal, prevVal) => {
        const s = incomingVal == null ? '' : String(incomingVal).trim();
        if (!s || s.indexOf('•') === 0) return prevVal || '';
        return s;
    };
    return normalizeCommerceConfig({
        storeName: next.storeName,
        storePhone: next.storePhone,
        storeEmail: next.storeEmail == null ? prev.storeEmail || '' : String(next.storeEmail).trim(),
        storeAddress: next.storeAddress,
        storeCity: next.storeCity,
        storeState: next.storeState == null ? prev.storeState || '' : String(next.storeState).trim(),
        storePincode: next.storePincode == null ? prev.storePincode || '' : String(next.storePincode).replace(/\D/g, '').slice(0, 6),
        storeLat: next.storeLat,
        storeLng: next.storeLng,
        mapsApiKey: keep(next.mapsApiKey, prev.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY),
        defaultMode: next.defaultMode,
        defaultHyperlocalProvider: next.defaultHyperlocalProvider,
        tookan: {
            enabled: tookanIn.enabled,
            apiKey: keep(tookanIn.apiKey, prevTookan.apiKey),
            sharedSecret: keep(tookanIn.sharedSecret, prevTookan.sharedSecret),
            defaultMode: tookanIn.defaultMode
        },
        shipday: {
            enabled: shipIn.enabled,
            apiKey: keep(shipIn.apiKey, prevShip.apiKey)
        },
        pidge: {
            enabled: pidgeIn.enabled,
            username: keep(pidgeIn.username, prevPidge.username),
            password: keep(pidgeIn.password, prevPidge.password),
            webhookToken: keep(pidgeIn.webhookToken, prevPidge.webhookToken),
            channel: pidgeIn.channel == null ? prevPidge.channel || '' : String(pidgeIn.channel).trim()
        },
        fleetbase: {
            enabled: fleetIn.enabled,
            apiHost: fleetIn.apiHost == null ? prevFleet.apiHost || '' : String(fleetIn.apiHost).trim(),
            secretKey: keep(fleetIn.secretKey, prevFleet.secretKey),
            webhookToken: keep(fleetIn.webhookToken, prevFleet.webhookToken),
            orderType: fleetIn.orderType == null ? prevFleet.orderType || '' : String(fleetIn.orderType).trim(),
            hubs: fleetIn.hubs == null ? prevFleet.hubs || '' : String(fleetIn.hubs),
            openBoxDelivery: fleetIn.openBoxDelivery
        },
        shop: Object.assign({}, prev.shop || {}, next.shop || {})
    });
}

/**
 * Map a carrier scan into our tracking copy.
 * Hub arrive / depart become courier-facility lines with city.
 * Out for delivery keeps the agent phone on the line.
 */
function phraseLogisticsUpdate(rawText, extras) {
    const extra = extras && typeof extras === 'object' ? extras : {};
    const text = String(rawText || '').trim();
    const t = text.toLowerCase();
    const city = String(extra.city || '').trim();
    const phone = String(extra.agentPhone || extra.phone || '').trim();
    const agent = String(extra.agentName || '').trim();
    const place = city || String(extra.location || '').trim();

    let title = text || 'Shipment update';
    let kind = 'update';

    const facilityWord = /hub|facility|warehouse|station|sorting|depot|centre|center|terminal|gateway|origin/;
    const agentLeg = /pick-?up (point|location|address)|drop (point|location)|customer|recipient|delivery (location|address)|your (location|address)/;
    const arrived =
        /arrived|arrival|reached|received at/.test(t) && facilityWord.test(t) && !agentLeg.test(t);
    const left =
        /departed|left (the )?(hub|facility|origin|warehouse|station|depot|centre|center)|dispatched from|forwarded to|in transit to next|left for next/.test(
            t
        );
    const out =
        /out for delivery|out-for-delivery|started delivery|delivery started|on the way to (customer|recipient|drop)/.test(t);
    const picked = /picked up|pickup (complete|successful|done)|collected from/.test(t);
    const delivered = /\bdelivered\b|delivery completed|successfully delivered/.test(t) && !/attempt failed|delivery failed|unsuccessful/.test(t);
    const attemptFailed = /attempt failed|delivery failed|could not be completed|attempt was unsuccessful|couldn.?t deliver/.test(t);

    if (attemptFailed) {
        title = 'Delivery attempt was unsuccessful';
        kind = 'failed';
    } else if (delivered) {
        title = 'Delivered';
        kind = 'delivered';
    } else if (out) {
        title = 'Out for delivery';
        kind = 'out_for_delivery';
    } else if (arrived) {
        title = 'Shipment arrived at Courier Facility';
        kind = 'arrived_facility';
    } else if (left) {
        title = 'Shipment left Courier Facility';
        kind = 'left_facility';
    } else if (picked) {
        title = 'Shipment picked up';
        kind = 'picked_up';
    }

    let detail = place;
    if (kind === 'out_for_delivery') {
        const who = [agent, phone].filter(Boolean).join(' · ');
        detail = [who, place].filter(Boolean).join(' · ');
    }
    return { title, kind, city: place, detail, agentName: agent, agentPhone: phone };
}

function tookanJobType(v) {
    const n = parseInt(v, 10);
    if (n === 1) return 'delivery';
    if (n === 0) return 'pickup';
    return null;
}

function tookanStatusLabel(n) {
    const map = {
        0: 'Assigned',
        1: 'Started',
        2: 'Successful',
        3: 'Failed',
        4: 'Arrived',
        6: 'Unassigned',
        7: 'Accepted',
        8: 'Declined',
        9: 'Cancelled',
        10: 'Deleted'
    };
    return map[n] || 'Shipment update';
}

const COURIER_PARTNER_NAME = 'Gogate Products';

function isDeskNoise(text) {
    const t = String(text || '').toLowerCase();
    return /created by api/.test(t) || /deleted by\b/.test(t);
}

const KIND_TITLES = {
    pickup_scheduled: 'Pickup requested from courier partner',
    agent_assigned: 'Courier partner assigned for pickup',
    to_store: 'Courier partner on the way to pick up',
    at_pickup: 'Courier partner reached the pickup point',
    picked_up: 'Shipment picked up',
    ready_for_pickup: 'Order ready for courier pickup',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    failed: 'Delivery attempt was unsuccessful'
};

/**
 * Hyperlocal Tookan still books a pickup task and a drop task. Each has its own Successful status.
 * A logistics booking is one parcel, so those two status codes are not created for it.
 */
function tookanTaskUpdate(jobType, jobStatus, text, extras) {
    const n = parseInt(jobStatus, 10);
    const phrase = phraseLogisticsUpdate(String(text || ''), extras || {});
    if (phrase.kind === 'arrived_facility' || phrase.kind === 'left_facility') {
        return { kind: phrase.kind, title: phrase.title, city: phrase.city, detail: phrase.detail };
    }
    const type = jobType === 'delivery' ? 'delivery' : 'pickup';
    const who = [phrase.agentName, phrase.agentPhone].filter(Boolean).join(' · ');
    if (n === 3 || n === 9 || n === 10) {
        const what = n === 9 ? 'cancelled' : 'attempt failed';
        return {
            kind: 'failed',
            title: type === 'delivery' ? 'Delivery attempt was unsuccessful' : 'Pickup ' + what,
            city: phrase.city,
            detail: phrase.city
        };
    }
    if (type === 'delivery') {
        if (n === 2) return { kind: 'delivered', title: KIND_TITLES.delivered, city: phrase.city, detail: phrase.city };
        if (n === 1) return { kind: 'out_for_delivery', title: KIND_TITLES.out_for_delivery, city: phrase.city, detail: [who, phrase.city].filter(Boolean).join(' · ') };
        if (n === 4) {
            return { kind: 'out_for_delivery', title: 'Delivery agent reached the drop location', city: phrase.city, detail: who };
        }
        return { kind: 'update', title: 'Delivery agent assigned', city: '', detail: who, skipEvent: true };
    }
    if (n === 2) return { kind: 'picked_up', title: KIND_TITLES.picked_up, city: phrase.city, detail: phrase.city };
    if (n === 1) return { kind: 'to_store', title: KIND_TITLES.to_store, city: '', detail: who };
    if (n === 4) return { kind: 'at_pickup', title: KIND_TITLES.at_pickup, city: '', detail: who };
    if (n === 0) return { kind: 'agent_assigned', title: KIND_TITLES.agent_assigned, city: '', detail: who };
    if (n === 7) return { kind: 'agent_assigned', title: 'Courier partner accepted the pickup', city: '', detail: who };
    if (n === 8) return { kind: 'pickup_scheduled', title: 'Courier partner declined - finding another', city: '', detail: '' };
    return { kind: 'pickup_scheduled', title: KIND_TITLES.pickup_scheduled, city: '', detail: '' };
}

function mapTookanStatus(jobStatus, text, jobType) {
    return tookanTaskUpdate(jobType === 'delivery' || jobType === 'pickup' ? jobType : null, jobStatus, text, {}).kind;
}

function mapShipdayStatus(status) {
    let raw = status;
    if (raw && typeof raw === 'object') raw = raw.orderState || raw.order_status || raw.status || raw.event || '';
    const s = String(raw || '').trim().toUpperCase();
    if (!s || s === '[OBJECT OBJECT]') return 'update';
    if (s === 'ALREADY_DELIVERED' || s === 'DELIVERED' || s === 'ORDER_COMPLETED') return 'delivered';
    if (s === 'PICKED_UP' || s === 'ORDER_PIKEDUP' || s === 'ORDER_PICKEDUP' || s === 'ORDER_ONTHEWAY') return 'out_for_delivery';
    if (s === 'READY_TO_DELIVER') return 'ready_for_pickup';
    if (s === 'STARTED' || s === 'ORDER_ACCEPTED_AND_STARTED') return 'to_store';
    if (s === 'NOT_STARTED_YET' || s === 'ORDER_ASSIGNED') return 'agent_assigned';
    if (s === 'NOT_ACCEPTED' || s === 'NOT_ASSIGNED' || s === 'ORDER_UNASSIGNED') return 'pickup_scheduled';
    if (s === 'FAILED_DELIVERY' || s === 'INCOMPLETE' || s === 'CANCELLED' || s === 'ORDER_FAILED' || s === 'ORDER_INCOMPLETE') return 'failed';
    return 'update';
}

function stageFromKind(kind, mode) {
    if (kind === 'hub_eta') return null;
    if (kind === 'delivered') return 'delivered';
    if (kind === 'out_for_delivery') return 'out_for_delivery';
    if (kind === 'picked_up') return 'in_transit';
    if (kind === 'to_store' || kind === 'agent_assigned' || kind === 'at_pickup') return 'pickup_scheduled';
    if (kind === 'arrived_facility' || kind === 'left_facility') return 'in_transit';
    if (kind === 'pickup_scheduled') return 'pickup_scheduled';
    return null;
}

function liveLegFor(kind, mode) {
    if (mode !== 'hyperlocal') return 'none';
    if (kind === 'to_store' || kind === 'pickup_scheduled' || kind === 'agent_assigned' || kind === 'at_pickup') return 'to_store';
    if (kind === 'picked_up' || kind === 'out_for_delivery') return 'to_drop';
    if (kind === 'delivered' || kind === 'failed') return 'none';
    return null;
}

function tookanDateTime(ms) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(new Date(ms));
    const g = (t) => {
        const hit = parts.find((p) => p.type === t);
        return hit ? hit.value : '00';
    };
    let hour = g('hour');
    if (hour === '24') hour = '00';
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + hour + ':' + g('minute') + ':' + g('second');
}

function shipdayDate(ms) {
    return tookanDateTime(ms).slice(0, 10);
}

function shipdayTime(ms) {
    return tookanDateTime(ms).slice(11);
}

function trackPath(token, provider) {
    const q = encodeURIComponent(String(token || ''));
    if (provider === 'fleetbase') return '/fleetbase/track/?token=' + q;
    return '/track-commerce?token=' + q;
}

function mapCommerceRow(row, items) {
    if (!row) return null;
    const token = row.tracking_token || null;
    return {
        id: row.id,
        orderCode: row.order_code,
        userId: row.user_id,
        status: row.status,
        paymentMode: row.payment_mode,
        totalAmount: row.total_amount,
        createdAt: row.created_at,
        buyerName: row.buyer_name || row.shipping_recipient_name || null,
        buyerPhone: row.buyer_phone || row.shipping_phone || null,
        buyerEmail: row.buyer_email || null,
        fulfillmentType: row.fulfillment_type || 'pickup',
        deliveryAddress: row.delivery_address || null,
        shippingRecipientName: row.shipping_recipient_name || null,
        shippingPhone: row.shipping_phone || null,
        shippingCity: row.shipping_city || null,
        shippingState: row.shipping_state || null,
        shippingPincode: row.shipping_pincode || null,
        commerceProvider: row.commerce_provider || null,
        commerceMode: row.commerce_mode || null,
        commerceStage: row.commerce_stage || 'placed',
        pickupOtp: row.commerce_provider === 'shipday' || row.commerce_provider === 'pidge' ? null : row.pickup_otp || null,
        deliveryOtp: row.commerce_provider === 'shipday' ? null : row.delivery_otp || null,
        pickupAt: row.commerce_pickup_at || null,
        deliveryAt: row.commerce_delivery_at || null,
        tookanJobId: row.tookan_job_id || null,
        tookanDeliveryJobId: row.tookan_delivery_job_id || null,
        tookanTrackingLink: row.tookan_tracking_link || null,
        shipdayOrderId: row.shipday_order_id || null,
        shipdayTrackingLink: row.shipday_tracking_link || null,
        pidgeOrderId: row.pidge_order_id || null,
        fleetbaseOrderId: row.fleetbase_order_id || null,
        openBox: truthy(row.commerce_open_box),
        agentName: row.agent_name || null,
        agentPhone: row.agent_phone || null,
        agentLat: numOrNull(row.agent_lat),
        agentLng: numOrNull(row.agent_lng),
        agentLocationAt: row.agent_location_at || null,
        rescheduledAt: row.rescheduled_at || null,
        rescheduledForStart: row.rescheduled_for_start || null,
        rescheduledForEnd: row.rescheduled_for_end || null,
        deliveryNote: row.delivery_note || null,
        storeLat: numOrNull(row.store_lat),
        storeLng: numOrNull(row.store_lng),
        dropLat: numOrNull(row.drop_lat),
        dropLng: numOrNull(row.drop_lng),
        trackingToken: token,
        commerceTrackUrl: token ? trackPath(token, row.commerce_provider) : null,
        commerceAwb: row.commerce_awb || null,
        fragile: truthy(row.commerce_fragile),
        heavy: truthy(row.commerce_heavy),
        cod: truthy(row.commerce_cod) || /^(cod|cash_on_delivery)$/i.test(String(row.payment_mode || '')),
        codAmount: numOrNull(row.commerce_cod_amount) != null ? numOrNull(row.commerce_cod_amount) : numOrNull(row.total_amount),
        codPaid: truthy(row.commerce_cod_paid),
        obdOtpSent: !!row.commerce_obd_otp,
        cancelCodeSent: !!row.commerce_cancel_code,
        routeJson: row.commerce_route_json || null,
        routeIndex: row.commerce_route_index == null ? null : Number(row.commerce_route_index),
        hopPhase: row.commerce_hop_phase || null,
        providerTracking: row.commerce_provider_tracking || null,
        razorpayQrId: row.commerce_razorpay_qr_id || null,
        razorpayQrImage: row.commerce_razorpay_qr_image || null,
        hyperlocalStatus: row.commerce_hyperlocal_status || null,
        liveLeg: row.live_leg || 'none',
        orderChannel: row.order_channel || null,
        returnKind: row.return_kind || null,
        returnStatus: row.return_status || null,
        returnReason: row.return_reason || null,
        returnProvider: row.return_provider || null,
        returnMode: row.return_mode || null,
        returnPickupOtp: row.return_pickup_otp || null,
        returnTookanJobId: row.return_tookan_job_id || null,
        returnTookanDeliveryJobId: row.return_tookan_delivery_job_id || null,
        returnShipdayOrderId: row.return_shipday_order_id || null,
        returnPidgeOrderId: row.return_pidge_order_id || null,
        returnFleetbaseOrderId: row.return_fleetbase_order_id || null,
        returnTrackingLink: row.return_tracking_link || null,
        returnAgentName: row.return_agent_name || null,
        returnAgentPhone: row.return_agent_phone || null,
        returnAgentLat: numOrNull(row.return_agent_lat),
        returnAgentLng: numOrNull(row.return_agent_lng),
        returnScheduledAt: row.return_scheduled_at || null,
        courierTrackStatus: row.courier_track_status || null,
        courierTrackLabel: row.courier_track_label || null,
        courierProvider: row.courier_provider || null,
        courierTrackingNo: row.courier_tracking_no || null,
        courierDeliveredAt: row.courier_delivered_at || null,
        updatedAt: row.updated_at || null,
        items: items || []
    };
}

function customerTrackView(order, events, cfg) {
    const hyper = order.commerceMode === 'hyperlocal';
    const live = hyper && (order.commerceStage === 'in_transit' || order.commerceStage === 'out_for_delivery');
    return {
        orderCode: order.orderCode,
        commerceStage: order.commerceStage,
        commerceMode: order.commerceMode,
        commerceProvider: order.commerceProvider,
        deliveryOtp:
            order.commerceProvider === 'shipday' || order.commerceStage !== 'out_for_delivery' ? null : order.deliveryOtp,
        agentName: order.commerceStage === 'out_for_delivery' ? order.agentName : null,
        agentPhone: order.commerceStage === 'out_for_delivery' ? order.agentPhone : null,
        agentLat: order.agentLat,
        agentLng: order.agentLng,
        storeLat: order.storeLat,
        storeLng: order.storeLng,
        dropLat: order.dropLat,
        dropLng: order.dropLng,
        liveLeg: order.liveLeg,
        liveMap: !!(live && (order.agentLat != null || order.storeLat != null)),
        mapsApiKey: live && cfg && cfg.mapsApiKey ? cfg.mapsApiKey : null,
        destination: '',
        events: (events || []).map(publicEvent).filter((ev) => ev && !isDeskNoise(ev.title) && !isDeskNoise(ev.detail)),
        returnStatus: order.returnStatus || null,
        returnKind: order.returnKind || null,
        returnAgentName: order.returnAgentName || null,
        returnAgentPhone: order.returnAgentPhone || null,
        returnPickupOtp: null
    };
}

function publicEvent(ev) {
    const line = require('./shipment-engine').customerEvent(ev);
    if (!line || line.internal) return null;
    return {
        at: line.at,
        title: line.message,
        detail: line.reason || line.location || '',
        city: line.location || '',
        kind: line.parentStage
    };
}

function otpDigits(value) {
    const s = String(value == null ? '' : value).replace(/\s+/g, '');
    return /^\d{4,8}$/.test(s) ? s : '';
}

function otpFromLabeledFields(job, pattern) {
    const lists = []
        .concat(job.custom_field || [])
        .concat(job.custom_fields || [])
        .concat(job.meta_data || [])
        .concat(job.pickup_meta_data || [])
        .concat((job.fields && job.fields.custom_field) || []);
    for (let i = 0; i < lists.length; i++) {
        const field = lists[i];
        if (!field || typeof field !== 'object') continue;
        const label = String(field.label || field.display_name || field.name || '');
        if (pattern && !pattern.test(label)) continue;
        if (!pattern && !/otp|pin/i.test(label)) continue;
        const hit = otpDigits(field.data != null ? field.data : field.value);
        if (hit) return hit;
    }
    return '';
}

/** Read the OTP Tookan generated. Pickup and drop are separate when both tasks exist. */
function tookanOtpsFromJob(job) {
    if (!job || typeof job !== 'object') return { pickupOtp: '', deliveryOtp: '' };
    const pickupSpecific = otpDigits(job.pickup_job_validate_otp) || otpDigits(job.pickup_otp) || otpFromLabeledFields(job, /pick/i);
    const deliverySpecific = otpDigits(job.job_validate_otp) || otpDigits(job.delivery_otp) || otpFromLabeledFields(job, /deliver|drop/i);
    const generic = otpDigits(job.job_otp) || otpDigits(job.otp) || otpDigits(job.customer_verification_code) || otpFromLabeledFields(job, null);
    const type = tookanJobType(job.job_type);
    return {
        pickupOtp: pickupSpecific || (type === 'pickup' ? generic : ''),
        deliveryOtp: deliverySpecific || (type === 'delivery' ? generic : type == null && !pickupSpecific ? generic : '')
    };
}

function mergeTookanOtps(list) {
    let pickupOtp = '';
    let deliveryOtp = '';
    (list || []).forEach((item) => {
        if (!item) return;
        if (!pickupOtp && item.pickupOtp) pickupOtp = item.pickupOtp;
        if (!deliveryOtp && item.deliveryOtp) deliveryOtp = item.deliveryOtp;
    });
    return { pickupOtp, deliveryOtp };
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const r = 6371;
    const p1 = (Number(lat1) * Math.PI) / 180;
    const p2 = (Number(lat2) * Math.PI) / 180;
    const dLat = p2 - p1;
    const dLng = ((Number(lng2) - Number(lng1)) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parcelWindowHours(storeLat, storeLng, dropLat, dropLng) {
    if (storeLat == null || dropLat == null) return 10;
    const km = haversineKm(storeLat, storeLng, dropLat, dropLng);
    return Math.max(10, Math.ceil(km / 35) + 2);
}

function tookanWallInstant(value) {
    if (value == null || value === '' || String(value).indexOf('0000-00-00') === 0) return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        const d = new Date(s.replace(' ', 'T') + '+05:30');
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) {
        const d = new Date(s.replace(/Z$/, '+05:30'));
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function hubCity(name) {
    const parts = String(name || '').split(' - ');
    return (parts.length > 1 ? parts[parts.length - 1] : parts[0] || '').trim();
}

function buildTookanParcelBody(cfg, order) {
    const now = Date.now();
    const storeLat = order.storeLat != null ? order.storeLat : cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg.storeLng;
    const pickupMs = order.pickupAtMs || now + 30 * 60 * 1000;
    const hours = parcelWindowHours(storeLat, storeLng, order.dropLat, order.dropLng);
    const dropMs = Math.max(order.dropAtMs || 0, pickupMs + hours * 60 * 60 * 1000);
    const code = order.orderCode || 'ORDER';
    return {
        timezone: -330,
        pickups: [
            {
                name: COURIER_PARTNER_NAME + ' ' + code,
                phone: String(cfg.storePhone || order.buyerPhone || '0000000000'),
                address: [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', ') || 'Book desk',
                latitude: storeLat != null ? String(storeLat) : '',
                longitude: storeLng != null ? String(storeLng) : '',
                time: tookanDateTime(pickupMs)
            }
        ],
        deliveries: [
            {
                name: (order.shippingRecipientName || order.buyerName || 'Customer') + ' ' + code,
                phone: String(order.shippingPhone || order.buyerPhone || '0000000000'),
                address: order.deliveryAddress || [order.shippingCity, order.shippingState].filter(Boolean).join(', ') || 'Delivery address',
                latitude: order.dropLat != null ? String(order.dropLat) : '',
                longitude: order.dropLng != null ? String(order.dropLng) : '',
                time: tookanDateTime(dropMs)
            }
        ]
    };
}

function tookanNorm(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tookanHubUsable(lat, lng) {
    const a = Number(lat);
    const b = Number(lng);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a) > 0.01 || Math.abs(b) > 0.01;
}

function tookanAreaPlace(parts) {
    return parts
        .map((part) => String(part || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(', ');
}

function tookanRoutePlaces(cfg, order) {
    return {
        seller: {
            city: String((cfg && cfg.storeCity) || '').trim(),
            state: String((cfg && cfg.storeState) || '').trim(),
            pincode: String((cfg && cfg.storePincode) || '').replace(/\D/g, '').slice(0, 6),
            locality: ''
        },
        drop: {
            city: String((order && (order.shippingCity || order.shipping_city)) || '').trim(),
            state: String((order && (order.shippingState || order.shipping_state)) || '').trim(),
            pincode: String((order && (order.shippingPincode || order.shipping_pincode)) || '')
                .replace(/\D/g, '')
                .slice(0, 6),
            locality: String((order && (order.shippingLocality || order.shipping_locality)) || '').trim()
        }
    };
}

function tookanAreaRequirements(seller, drop) {
    const from = seller || {};
    const to = drop || {};
    const fromPlace = tookanAreaPlace([from.locality, from.city, from.state, from.pincode]);
    const toPlace = tookanAreaPlace([to.locality, to.city, to.state, to.pincode]);
    const areas = [
        {
            role: 'seller_local',
            city: from.city || '',
            locality: from.locality || '',
            pincode: from.pincode || '',
            label: 'Seller local hub for ' + (fromPlace || 'the pickup address on this order')
        },
        {
            role: 'city_mother',
            city: from.city || '',
            locality: '',
            pincode: '',
            label: 'City mother hub for ' + (tookanAreaPlace([from.city, from.state]) || 'the pickup city on this order')
        }
    ];
    const different = tookanNorm(to.city) && tookanNorm(to.city) !== tookanNorm(from.city);
    if (different) {
        areas.push({
            role: 'transit',
            fromCity: from.city || '',
            toCity: to.city || '',
            label: 'Transit hub from ' + (from.city || 'the pickup city') + ' to ' + (to.city || 'the delivery city')
        });
        areas.push({
            role: 'destination_city',
            city: to.city || '',
            locality: '',
            pincode: '',
            label: 'Destination city hub for ' + (tookanAreaPlace([to.city, to.state]) || 'the delivery city on this order')
        });
    }
    areas.push({
        role: 'delivery_local',
        city: to.city || '',
        locality: to.locality || '',
        pincode: to.pincode || '',
        label: 'Delivery local hub for ' + (toPlace || 'the delivery address on this order')
    });
    return areas;
}

function tookanHubText(hub) {
    return tookanNorm(hub && hub.name);
}

function tookanIsMother(hub) {
    return tookanHubText(hub).indexOf('mother') !== -1;
}

function tookanHubParts(hub) {
    const name = String((hub && hub.name) || '');
    const bits = name.split(' - ');
    return {
        locality: tookanNorm(bits[0].replace(/motherhub|hub/gi, '')),
        city: tookanNorm(bits.length > 1 ? bits[bits.length - 1] : bits[0])
    };
}

function tookanCityMatch(hub, city) {
    const want = tookanNorm(city);
    if (!want) return false;
    const parts = tookanHubParts(hub);
    return parts.city === want || parts.locality === want;
}

function tookanHubCovers(area, hub, ignorePin) {
    if (!hub || !area) return false;
    if (!ignorePin && !hub.usable) return false;
    if (area.role === 'transit') {
        const name = tookanNorm(hub.name);
        return (' ' + name + ' ').indexOf(' ' + tookanNorm(area.fromCity) + ' ') !== -1 && (' ' + name + ' ').indexOf(' ' + tookanNorm(area.toCity) + ' ') !== -1;
    }
    if (area.role === 'city_mother' || area.role === 'destination_city') return tookanIsMother(hub) && tookanCityMatch(hub, area.city);
    if (tookanIsMother(hub) || !tookanCityMatch(hub, area.city)) return false;
    if (area.locality && tookanHubParts(hub).locality === tookanNorm(area.locality)) return true;
    if (area.pincode && String(hub.address || '').indexOf(String(area.pincode)) !== -1) return true;
    return !area.locality;
}

function tookanStopPoint(source, latKey, lngKey) {
    const lat = numOrNull(source && source[latKey]);
    const lng = numOrNull(source && source[lngKey]);
    if (lat == null || lng == null || !tookanHubUsable(lat, lng)) return null;
    return { lat, lng };
}

function tookanHubRadiusKm(hub) {
    const radius = Number(hub && hub.radius);
    return radius > 0 ? radius : 5;
}

function tookanWithinRadius(hub, point) {
    if (!hub || !hub.usable || !point) return false;
    return haversineKm(hub.lat, hub.lng, point.lat, point.lng) <= tookanHubRadiusKm(hub);
}

function tookanHubReach(hubs, point) {
    if (!point) return { inside: [], nearest: null, widenTo: null };
    const ranked = (hubs || [])
        .filter((hub) => hub && hub.usable && tookanHubUsable(hub.lat, hub.lng))
        .map((hub) => ({ hub, km: haversineKm(hub.lat, hub.lng, point.lat, point.lng) }))
        .sort((a, b) => a.km - b.km);
    const inside = ranked.filter((row) => row.km <= tookanHubRadiusKm(row.hub)).map((row) => row.hub);
    const nearest = ranked[0] || null;
    const second = ranked[1] || null;
    let widenTo = null;
    if (!inside.length && nearest && nearest.km <= 25 && !(second && nearest.km + 5 >= second.km)) {
        const next = Math.min(25, Math.ceil(nearest.km + 1));
        if (next > tookanHubRadiusKm(nearest.hub)) widenTo = next;
    }
    return { inside, nearest, widenTo };
}

function tookanHubsForArea(area, hubs, point) {
    const list = hubs || [];
    const named = list.filter((hub) => tookanHubCovers(area, hub, false));
    const near = point
        ? list.filter((hub) => {
              if (!tookanWithinRadius(hub, point)) return false;
              if (area.role === 'transit') return false;
              if (area.role === 'city_mother' || area.role === 'destination_city') return tookanIsMother(hub);
              return !tookanIsMother(hub);
          })
        : [];
    const seen = new Set();
    return named.concat(near).filter((hub) => {
        const key = hub.id || hub.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function tookanHubListSuffix(list) {
    const parts = [];
    const unpinned = list.filter((hub) => hub && hub.name && !hub.usable).map((hub) => hub.name);
    if (unpinned.length) parts.push('Saved without a map pin, so Tookan ignores them: ' + unpinned.join(', ') + '.');
    const usable = list.filter((hub) => hub && hub.name && hub.usable).map((hub) => hub.name);
    if (usable.length) parts.push('Hubs Tookan can use: ' + usable.join(', ') + '.');
    if (list.length) {
        parts.push('Hubs read from Tookan: ' + list.map((hub) => hub.name + (hub.usable ? '' : ' (no map pin)')).join(', ') + '.');
    }
    return parts;
}

function tookanReachLine(label, reach) {
    if (reach.inside.length) return label + ' is inside ' + reach.inside.map((hub) => hub.name).join(', ');
    if (reach.nearest) {
        const km = Math.round(reach.nearest.km * 10) / 10;
        return (
            label +
            ' is outside every hub radius. Nearest hub is ' +
            reach.nearest.hub.name +
            ', ' +
            km +
            ' km away, radius ' +
            tookanHubRadiusKm(reach.nearest.hub) +
            ' km'
        );
    }
    return label + ' is outside every hub radius';
}

function tookanHubGapMessage(cfg, order, hubs) {
    const places = tookanRoutePlaces(cfg, order);
    const areas = tookanAreaRequirements(places.seller, places.drop);
    const list = hubs || [];
    const pickupPoint = tookanStopPoint(order, 'storeLat', 'storeLng') || tookanStopPoint(cfg, 'storeLat', 'storeLng');
    const dropPoint = tookanStopPoint(order, 'dropLat', 'dropLng');
    if (pickupPoint && dropPoint) {
        const pickup = tookanHubReach(list, pickupPoint);
        const drop = tookanHubReach(list, dropPoint);
        return ['Area hubs required: ' + tookanReachLine('Pickup', pickup) + '; ' + tookanReachLine('Delivery', drop) + '.']
            .concat(tookanHubListSuffix(list))
            .join(' ');
    }
    const pointFor = (area) => {
        if (area.role === 'seller_local' || area.role === 'city_mother') return pickupPoint;
        if (area.role === 'delivery_local' || area.role === 'destination_city') return dropPoint;
        return null;
    };
    const sellerHit = areas.filter((area) => area.role === 'seller_local').some((area) => tookanHubsForArea(area, list, pickupPoint).length);
    const dropHit = areas.filter((area) => area.role === 'delivery_local').some((area) => tookanHubsForArea(area, list, dropPoint).length);
    const endsCovered = sellerHit && dropHit;
    const required = [];
    const still = [];
    areas.forEach((area) => {
        if (endsCovered && (area.role === 'transit' || area.role === 'destination_city')) return;
        const covered = tookanHubsForArea(area, list, pointFor(area));
        if (covered.length) {
            required.push(area.label + ' covered by ' + covered.map((hub) => hub.name).join(', '));
            return;
        }
        required.push(area.label);
        const saved = list.filter((hub) => !hub.usable && tookanHubCovers(area, hub, true));
        if (saved.length === 1) still.push(area.label + ' (' + saved[0].name + ' is saved but has no map pin)');
        else if (saved.length) still.push(area.label + ' (' + saved.map((hub) => hub.name).join(', ') + ' are saved but have no map pin)');
        else still.push(area.label);
    });
    const parts = ['Area hubs required: ' + required.join('; ') + '.'];
    if (still.length) parts.push('Still needed: ' + still.join('; ') + '.');
    return parts.concat(tookanHubListSuffix(list)).join(' ');
}

function tookanHubFailure(message, cfg, order, hubs) {
    const head = String(message || 'Tookan could not create the parcel').replace(/\s+/g, ' ').trim();
    const gap = tookanHubGapMessage(cfg, order, hubs || []);
    if (!gap || head.indexOf('Area hubs required:') !== -1) return head;
    return head + ' ' + gap;
}

function mapTookanHub(raw) {
    const lat = numOrNull(raw.hub_lat != null ? raw.hub_lat : raw.latitude);
    const lng = numOrNull(raw.hub_long != null ? raw.hub_long : raw.hub_lng != null ? raw.hub_lng : raw.longitude);
    return {
        id: String(raw.hub_id != null ? raw.hub_id : raw.id),
        name: String(raw.hub_name || raw.name || 'Hub').replace(/\s+/g, ' ').trim(),
        address: String(raw.hub_address || raw.address || '').replace(/\s+/g, ' ').trim(),
        lat,
        lng,
        radius: numOrNull(raw.hub_radius),
        usable: tookanHubUsable(lat, lng)
    };
}

function parseTookanHubPayload(body) {
    const box = body && body.data;
    const nested = box && !Array.isArray(box) ? box : null;
    const list = nested && Array.isArray(nested.data) ? nested.data : Array.isArray(box) ? box : Array.isArray(nested) ? nested : [];
    const pages = nested && Number(nested.totalPages) > 0 ? Number(nested.totalPages) : 1;
    return {
        pages,
        hubs: list.filter((row) => row && (row.hub_id != null || row.id != null)).map(mapTookanHub)
    };
}

function tookanPinInIndia(point) {
    const lat = point && Number(point.lat);
    const lng = point && Number(point.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 6 && lat <= 37.5 && lng >= 68 && lng <= 97.5;
}

async function saveTookanHubPin(cfg, hub, point) {
    const body = {
        api_key: cfg.tookan.apiKey,
        hub_id: /^\d+$/.test(String(hub.id)) ? Number(hub.id) : hub.id,
        hub_name: hub.name,
        hub_address: hub.address,
        hub_latitude: String(point.lat),
        hub_longitude: String(point.lng),
        is_delete: 0,
        is_hub_updated: 1
    };
    if (hub.radius && hub.radius > 0) body.hub_radius = hub.radius;
    const res = await requestJson('POST', TOOKAN_BASE + '/hubs/editHub', { body });
    const data = (res && res.data) || {};
    const saved = !!(res && res.statusCode < 400 && data.status === 200);
    if (saved) clearTookanHubCache();
    return saved;
}

let tookanHubCacheGen = 0;
let tookanHubCache = { key: '', at: 0, hubs: null, pending: null };

function tookanHubCacheKey(cfg) {
    const key = cfg && cfg.tookan && cfg.tookan.apiKey ? String(cfg.tookan.apiKey) : '';
    return key.length + ':' + key.slice(-4);
}

function clearTookanHubCache() {
    tookanHubCacheGen += 1;
    tookanHubCache = { key: '', at: 0, hubs: null, pending: null };
}

async function loadTookanHubs(cfg) {
    const seen = new Set();
    const rows = [];
    const collect = (parsed) => {
        let added = 0;
        (parsed.hubs || []).forEach((hub) => {
            if (!hub.id || seen.has(hub.id)) return;
            seen.add(hub.id);
            rows.push(hub);
            added += 1;
        });
        return added;
    };
    const first = await requestJson('POST', TOOKAN_BASE + '/hubs/getAllHubs', {
        body: { api_key: cfg.tookan.apiKey }
    });
    const parsed = parseTookanHubPayload(first && first.data);
    collect(parsed);
    for (let page = 2; page <= parsed.pages && page <= 20; page++) {
        const res = await requestJson('POST', TOOKAN_BASE + '/hubs/getAllHubs', {
            body: { api_key: cfg.tookan.apiKey, page: page }
        });
        if (!collect(parseTookanHubPayload(res && res.data))) break;
    }
    return rows;
}

async function fetchTookanHubs(cfg, opts) {
    if (!cfg.tookan.enabled) return [];
    const fresh = !!(opts && opts.fresh);
    const key = tookanHubCacheKey(cfg);
    if (!fresh && tookanHubCache.hubs && tookanHubCache.key === key && Date.now() - tookanHubCache.at < 60000) {
        return tookanHubCache.hubs;
    }
    if (!fresh && tookanHubCache.pending && tookanHubCache.key === key) return tookanHubCache.pending;
    const gen = tookanHubCacheGen;
    const run = loadTookanHubs(cfg)
        .then((hubs) => {
            if (gen === tookanHubCacheGen) tookanHubCache = { key, at: Date.now(), hubs, pending: null };
            return hubs;
        })
        .catch((err) => {
            if (tookanHubCache.key === key) tookanHubCache.pending = null;
            throw err;
        });
    if (!fresh) {
        tookanHubCache.key = key;
        tookanHubCache.pending = run;
    }
    return run;
}

async function prepareTookanHubs(cfg) {
    let hubs = await fetchTookanHubs(cfg);
    const pending = hubs.filter((hub) => !hub.usable && hub.address && hub.address.length >= 8);
    let changed = false;
    for (let i = 0; i < pending.length; i++) {
        const hub = pending[i];
        let point = null;
        try {
            point = await geocodeAddress(cfg, hub.address);
        } catch (_) {
            point = null;
        }
        if (!tookanPinInIndia(point)) continue;
        try {
            if (await saveTookanHubPin(cfg, hub, point)) changed = true;
        } catch (_) {}
    }
    if (changed) hubs = await fetchTookanHubs(cfg, { fresh: true });
    return hubs;
}

async function widenTookanHubs(cfg, hubs, points) {
    let list = hubs || [];
    let changed = false;
    for (let i = 0; i < (points || []).length; i++) {
        const reach = tookanHubReach(list, points[i]);
        if (!reach.widenTo || !reach.nearest) continue;
        const hub = reach.nearest.hub;
        try {
            const saved = await saveTookanHubPin(cfg, Object.assign({}, hub, { radius: reach.widenTo }), { lat: hub.lat, lng: hub.lng });
            if (saved) changed = true;
        } catch (_) {}
    }
    if (changed) {
        try {
            list = await fetchTookanHubs(cfg, { fresh: true });
        } catch (_) {}
    }
    return list;
}

function parcelLegInstant(job, nowMs) {
    if (!job) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const done = parseInt(job.job_status, 10) === 2;
    const completedRaw = job.completed_datetime;
    if (done && completedRaw && String(completedRaw).indexOf('0000-00-00') !== 0) {
        const completed = new Date(completedRaw);
        if (Number.isFinite(completed.getTime()) && completed.getTime() <= now + 5 * 60 * 1000) return completed.toISOString();
    }
    if (job.job_time_utc) {
        const utc = new Date(job.job_time_utc);
        if (Number.isFinite(utc.getTime()) && !(done && utc.getTime() > now + 5 * 60 * 1000)) return utc.toISOString();
    }
    const type = parseInt(job.job_type, 10);
    const raw = type === 0 ? job.job_pickup_datetime : job.job_delivery_datetime || job.job_pickup_datetime;
    const wall = tookanWallInstant(raw);
    if (!wall) return null;
    const wallMs = Date.parse(wall);
    if (done && Number.isFinite(wallMs) && wallMs > now + 5 * 60 * 1000) return null;
    return wall;
}

function parcelLineFill(plan, stage, now) {
    if (stage === 'delivered') return 1;
    if (!plan.length) return stage === 'out_for_delivery' ? 0.4 : 0.12;
    const times = plan
        .map((hub) => hub.ms)
        .filter((ms) => ms > 0)
        .sort((a, b) => a - b);
    const doneRatio = plan.filter((hub) => hub.done).length / plan.length;
    let ratio = Math.max(doneRatio, 0.12);
    if (times.length) {
        const start = times[0];
        const end = times.length > 1 ? times[times.length - 1] : start + 3 * 60 * 60 * 1000;
        if (now > start && end > start) ratio = Math.max(ratio, Math.min(1, (now - start) / (end - start)));
    }
    return Math.min(0.88, ratio);
}

function parcelJourneyUpdate(jobs, hubs, nowMs) {
    const hubById = {};
    (hubs || []).forEach((h) => {
        hubById[String(h.id)] = h;
    });
    const list = (jobs || []).filter((job) => job && job.job_id != null);
    if (!list.length) return null;
    const now = nowMs || Date.now();
    const deliveries = list.filter((job) => parseInt(job.job_type, 10) === 1);
    const pickups = list.filter((job) => parseInt(job.job_type, 10) === 0);
    const hubLegs = deliveries.filter((job) => hubById[String(job.order_id || '')]);
    const finalLegs = deliveries.filter((job) => !hubById[String(job.order_id || '')]);
    const final = finalLegs.slice().sort((a, b) => (Date.parse(parcelLegInstant(a, now) || 0) || 0) - (Date.parse(parcelLegInstant(b, now) || 0) || 0)).pop() || null;
    const statusOf = (job) => (job ? parseInt(job.job_status, 10) : NaN);
    const pickupDone = pickups.some((job) => statusOf(job) === 2);
    const hubMoving = hubLegs.some((job) => [1, 2, 4].indexOf(statusOf(job)) !== -1);
    const finalStatus = statusOf(final);
    let stage = 'pickup_scheduled';
    let kind = 'pickup_scheduled';
    if (final && finalStatus === 2) {
        stage = 'delivered';
        kind = 'delivered';
    } else if (final && (finalStatus === 1 || finalStatus === 4)) {
        stage = 'out_for_delivery';
        kind = 'out_for_delivery';
    } else if (pickupDone || hubMoving) {
        stage = 'in_transit';
        kind = 'arrived_facility';
    }
    const plan = hubLegs
        .map((job) => {
            const hub = hubById[String(job.order_id)];
            const at = parcelLegInstant(job, now);
            return {
                name: hub.name,
                city: hubCity(hub.name),
                at,
                done: statusOf(job) === 2,
                ms: at ? Date.parse(at) : 0
            };
        })
        .sort((a, b) => a.ms - b.ms);
    const events = plan.map((hub) =>
        hub.done
            ? { title: 'Arrived at ' + hub.name, city: hub.city, detail: hub.name, kind: 'arrived_facility', at: hub.at }
            : { title: 'Expected at ' + hub.name, city: hub.city, detail: '', kind: 'hub_eta', at: hub.at }
    );
    const latestHub = events.filter((ev) => ev.kind === 'arrived_facility').slice(-1)[0] || null;
    const lineFill = parcelLineFill(plan, stage, now);
    const active = list.find((job) => [1, 4].indexOf(statusOf(job)) !== -1) || final || pickups[0] || list[0];
    const barcode = (list.find((job) => job.barcode) || {}).barcode || '';
    const pickupAt = tookanWallInstant((pickups[0] && pickups[0].job_pickup_datetime) || null);
    const deliveryJob = final || deliveries[deliveries.length - 1] || null;
    const deliveryAt = tookanWallInstant(deliveryJob && deliveryJob.job_delivery_datetime);
    return {
        provider: 'tookan',
        kind,
        stage,
        title:
            kind === 'delivered'
                ? 'Delivered'
                : kind === 'out_for_delivery'
                  ? 'Out for delivery'
                  : stage === 'in_transit'
                    ? (latestHub && latestHub.title) || 'Shipment arrived at Courier Facility'
                    : 'Pickup requested from courier partner',
        detail: '',
        city: latestHub ? latestHub.city : plan.length ? plan[0].city : '',
        lineFill,
        events,
        parcel: true,
        jobId: pickups[0] ? String(pickups[0].job_id) : String(list[0].job_id),
        barcode: barcode ? String(barcode) : '',
        trackingNo: barcode ? String(barcode) : '',
        pickupAt,
        deliveryAt,
        agentName: (active && active.fleet_name) || null,
        agentPhone: (active && (active.fleet_phone || active.fleet_phone_number)) || null,
        agentLat: numOrNull(active && (active.fleet_latitude != null ? active.fleet_latitude : active.latitude)),
        agentLng: numOrNull(active && (active.fleet_longitude != null ? active.fleet_longitude : active.longitude)),
        liveLeg: stage === 'out_for_delivery' || stage === 'in_transit' ? 'to_drop' : 'none',
        skipEvent: stage === 'pickup_scheduled' || (stage === 'in_transit' && !!latestHub),
        pickupOtp: '',
        deliveryOtp: ''
    };
}

function cleanParcelText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function tookanParcelJourney(steps, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const rows = (Array.isArray(steps) ? steps : [])
        .map((step) => {
            const atMs = step && step.date_time ? Date.parse(step.date_time) : NaN;
            return {
                status: cleanParcelText(step && step.status),
                line: cleanParcelText(step && step.line_status),
                at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : '',
                atMs: Number.isFinite(atMs) ? atMs : 0
            };
        })
        .filter((step) => step.status && step.at && step.atMs <= now + 5 * 60 * 1000);
    if (!rows.length) return null;
    const events = [];
    rows.forEach((step) => {
        const arrived = step.status.match(/^arrived at destination\s+(.+)$/i);
        const next = step.status.match(/^out for next location\s+(.+)$/i);
        if (/^order placed$/i.test(step.status)) return;
        if (/^departed from origin$/i.test(step.status)) {
            events.push({ title: 'Shipment left origin', city: '', detail: '', kind: 'left_facility', at: step.at });
            return;
        }
        if (arrived) {
            const name = cleanParcelText(arrived[1]);
            events.push({ title: 'Arrived at ' + name, city: hubCity(name), detail: name, kind: 'arrived_facility', at: step.at });
            return;
        }
        if (next) {
            const name = cleanParcelText(next[1]);
            const from = /hub/i.test(step.line) ? step.line : '';
            events.push({
                title: 'Shipment left for ' + name,
                city: hubCity(from || name),
                detail: from || name,
                kind: 'left_facility',
                at: step.at
            });
            return;
        }
        if (/^out for delivery$/i.test(step.status)) {
            events.push({ title: 'Out for delivery', city: '', detail: '', kind: 'out_for_delivery', at: step.at });
            return;
        }
        if (/^delivered$/i.test(step.status)) {
            events.push({ title: 'Delivered', city: '', detail: '', kind: 'delivered', at: step.at });
        }
    });
    if (!events.length) return null;
    const arrivedHubs = events.filter((ev) => ev.kind === 'arrived_facility');
    const delivered = events.some((ev) => ev.kind === 'delivered');
    const out = events.some((ev) => ev.kind === 'out_for_delivery');
    const stage = delivered ? 'delivered' : out ? 'out_for_delivery' : 'in_transit';
    const kind = delivered ? 'delivered' : out ? 'out_for_delivery' : 'arrived_facility';
    const latestHub = arrivedHubs[arrivedHubs.length - 1] || null;
    const title = delivered ? 'Delivered' : out ? 'Out for delivery' : (latestHub && latestHub.title) || events[events.length - 1].title;
    return {
        provider: 'tookan',
        kind,
        stage,
        title,
        detail: '',
        city: latestHub ? latestHub.city : '',
        lineFill: stage === 'delivered' ? 1 : Math.min(0.88, 0.2 + arrivedHubs.length * 0.15),
        events: events.filter((ev) => ev.kind === 'arrived_facility' || ev.kind === 'left_facility'),
        parcel: true,
        skipEvent: stage === 'in_transit',
        liveLeg: 'none',
        pickupOtp: '',
        deliveryOtp: ''
    };
}

function parcelBelongsToOrder(steps, orderCode) {
    const code = String(orderCode || '').trim();
    if (!code) return false;
    return (Array.isArray(steps) ? steps : []).some((step) => String((step && step.customer_username) || '').indexOf(code) !== -1);
}

const tookanParcelIds = new Map();
const tookanParcelLists = new Map();
const tookanParcelReads = new Map();

function istDay(ms) {
    const d = new Date((Number(ms) || Date.now()) + 330 * 60 * 1000);
    return d.toISOString().slice(0, 10);
}

function addIstDays(day, count) {
    const d = new Date(String(day) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + count);
    return d.toISOString().slice(0, 10);
}

async function listTookanParcels(cfg, start, end) {
    const key = tookanHubCacheKey(cfg) + '|' + start + '|' + end;
    const hit = tookanParcelLists.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.rows;
    if (hit && hit.pending) return hit.pending;
    const pending = requestJson('POST', TOOKAN_BASE + '/parcel/parcelList', {
        body: { api_key: cfg.tookan.apiKey, start_date: start, end_date: end },
        timeoutMs: 12000
    }).then((res) => {
        const data = res && res.data;
        const rows = data && data.status === 200 && Array.isArray(data.data) ? data.data : [];
        tookanParcelLists.set(key, { at: Date.now(), rows, pending: null });
        return rows;
    }).catch((err) => {
        const current = tookanParcelLists.get(key);
        if (current && current.pending) tookanParcelLists.set(key, { at: 0, rows: [], pending: null });
        throw err;
    });
    tookanParcelLists.set(key, { at: 0, rows: [], pending });
    return pending;
}

async function readTookanParcel(cfg, parcelId) {
    const res = await requestJson('POST', TOOKAN_BASE + '/parcel/trackParcel', {
        body: { api_key: cfg.tookan.apiKey, parcel_id: parcelId },
        timeoutMs: 12000
    });
    const data = res && res.data;
    return data && data.status === 200 && Array.isArray(data.data) ? data.data : [];
}

async function loadTookanParcelTrack(cfg, order) {
    const code = String((order && order.orderCode) || '').trim();
    if (!code || !cfg || !cfg.tookan || !cfg.tookan.enabled) return null;
    const cachedId = tookanParcelIds.get(code);
    if (cachedId) {
        const steps = await readTookanParcel(cfg, cachedId);
        if (parcelBelongsToOrder(steps, code)) return tookanParcelJourney(steps, Date.now());
        tookanParcelIds.delete(code);
    }
    const created = Date.parse(order.createdAt || '') || Date.now();
    const start = istDay(created);
    const end = addIstDays(istDay(Date.now()), 2);
    const parcels = await listTookanParcels(cfg, start, end);
    for (let i = 0; i < parcels.length && i < 15; i++) {
        const id = parcels[i] && parcels[i].parcel_id;
        if (id == null || id === '') continue;
        const steps = await readTookanParcel(cfg, id);
        if (!parcelBelongsToOrder(steps, code)) continue;
        tookanParcelIds.set(code, id);
        return tookanParcelJourney(steps, Date.now());
    }
    return null;
}

function fetchTookanParcelTrack(cfg, order) {
    const code = String((order && order.orderCode) || '').trim();
    if (!code) return Promise.resolve(null);
    if (tookanParcelReads.has(code)) return tookanParcelReads.get(code);
    const run = loadTookanParcelTrack(cfg, order).finally(() => tookanParcelReads.delete(code));
    tookanParcelReads.set(code, run);
    return run;
}

async function findTookanParcelJobs(cfg, orderCode, fromMs, toMs) {
    const start = tookanDateTime(fromMs || Date.now()).slice(0, 10);
    const end = tookanDateTime(toMs || Date.now() + 2 * 24 * 60 * 60 * 1000).slice(0, 10);
    const ids = [];
    for (let type = 0; type <= 1; type++) {
        const res = await requestJson('POST', TOOKAN_BASE + '/get_all_tasks', {
            body: { api_key: cfg.tookan.apiKey, job_type: type, start_date: start, end_date: end }
        });
        const list = res && res.data && Array.isArray(res.data.data) ? res.data.data : [];
        list.forEach((task) => {
            const blob = [task.job_pickup_name, task.customer_username, task.job_description, task.order_id].join(' ');
            if (orderCode && blob.indexOf(orderCode) !== -1 && task.job_id != null) ids.push(task.job_id);
        });
    }
    const seen = new Set();
    const jobs = [];
    for (let i = 0; i < ids.length; i++) {
        const rel = await requestJson('POST', TOOKAN_BASE + '/get_related_tasks', {
            body: { api_key: cfg.tookan.apiKey, job_id: ids[i] }
        });
        let rows = rel && rel.data && Array.isArray(rel.data.data) ? rel.data.data : [];
        if (!rows.length) {
            const one = await fetchTookanJob(cfg, ids[i]);
            rows = one ? [one] : [];
        }
        rows.forEach((job) => {
            if (!job || job.job_id == null || seen.has(String(job.job_id))) return;
            seen.add(String(job.job_id));
            jobs.push(job);
        });
    }
    return jobs;
}

async function fetchTookanParcelUpdate(cfg, order) {
    try {
        const tracked = await fetchTookanParcelTrack(cfg, order);
        if (tracked) return tracked;
    } catch (_) {}
    let hubs = [];
    try {
        hubs = await fetchTookanHubs(cfg);
    } catch (_) {
        hubs = [];
    }
    let jobs = [];
    if (order.tookanJobId) {
        const rel = await requestJson('POST', TOOKAN_BASE + '/get_related_tasks', {
            body: { api_key: cfg.tookan.apiKey, job_id: order.tookanJobId }
        });
        jobs = rel && rel.data && Array.isArray(rel.data.data) ? rel.data.data : [];
    }
    if (!jobs.length && order.orderCode) {
        jobs = await findTookanParcelJobs(cfg, order.orderCode, Date.now() - 2 * 24 * 60 * 60 * 1000, Date.now() + 3 * 24 * 60 * 60 * 1000);
    }
    if (!jobs.length && order.tookanJobId) {
        const one = await fetchTookanJob(cfg, order.tookanJobId);
        return tookanJobToUpdate(one, 'logistics', 'pickup');
    }
    const hubIds = {};
    hubs.forEach((hub) => {
        hubIds[String(hub.id)] = true;
    });
    const onHub = jobs.some((job) => hubIds[String(job.order_id || '')]);
    let update = null;
    if (onHub) update = parcelJourneyUpdate(jobs, hubs, Date.now());
    else if (!hubs.length && jobs.length > 2) {
        update = {
            provider: 'tookan',
            kind: 'arrived_facility',
            stage: 'in_transit',
            title: 'Shipment arrived at Courier Facility',
            detail: '',
            city: '',
            lineFill: 0.2,
            events: [],
            parcel: true,
            skipEvent: false,
            liveLeg: 'none',
            pickupOtp: '',
            deliveryOtp: ''
        };
    } else {
        const pickup = jobs.find((job) => parseInt(job.job_type, 10) === 0) || null;
        const delivery = jobs.find((job) => parseInt(job.job_type, 10) === 1) || null;
        update = combineTookanUpdates(
            tookanJobToUpdate(pickup, 'logistics', 'pickup'),
            delivery ? tookanJobToUpdate(delivery, 'logistics', 'delivery') : null
        );
        if (update) {
            update.lineFill = update.stage === 'delivered' ? 1 : update.stage === 'out_for_delivery' ? 0.4 : 0.12;
            update.events = [];
        }
    }
    if (!update) return null;
    const otps = mergeTookanOtps(jobs.map(tookanOtpsFromJob));
    update.pickupOtp = otps.pickupOtp;
    update.deliveryOtp = otps.deliveryOtp;
    return update;
}

async function geocodeAddress(cfg, address) {
    const query = String(address || '').replace(/\s+/g, ' ').trim();
    if (!cfg || !cfg.mapsApiKey || query.length < 6) return null;
    const url =
        'https://maps.googleapis.com/maps/api/geocode/json?address=' +
        encodeURIComponent(query) +
        '&key=' +
        encodeURIComponent(cfg.mapsApiKey);
    const res = await requestJson('GET', url);
    const data = res && res.data;
    if (!data || data.status !== 'OK' || !Array.isArray(data.results) || !data.results[0]) return null;
    const loc = data.results[0].geometry && data.results[0].geometry.location;
    const lat = loc ? numOrNull(loc.lat) : null;
    const lng = loc ? numOrNull(loc.lng) : null;
    if (lat == null || lng == null) return null;
    return { lat, lng };
}

async function ensureTookanParcelCoordinates(cfg, order) {
    const storeAddress = [cfg.storeAddress, cfg.storeCity, cfg.storeState, cfg.storePincode].filter(Boolean).join(', ');
    const dropAddress = [order.deliveryAddress, order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).join(', ');
    if (order.storeLat == null || order.storeLng == null) {
        if (cfg.storeLat != null && cfg.storeLng != null) {
            order.storeLat = cfg.storeLat;
            order.storeLng = cfg.storeLng;
        } else {
            const point = await geocodeAddress(cfg, storeAddress);
            if (point) {
                order.storeLat = point.lat;
                order.storeLng = point.lng;
            }
        }
    }
    if (order.dropLat == null || order.dropLng == null) {
        const point = await geocodeAddress(cfg, dropAddress);
        if (point) {
            order.dropLat = point.lat;
            order.dropLng = point.lng;
        }
    }
}

async function createTookanParcel(cfg, order) {
    if (!cfg.tookan.enabled) throw new Error('Tookan API key is not configured.');
    await ensureTookanParcelCoordinates(cfg, order);
    let hubs = [];
    try {
        hubs = await prepareTookanHubs(cfg);
    } catch (_) {
        hubs = [];
    }
    const pickupPoint = tookanStopPoint(order, 'storeLat', 'storeLng') || tookanStopPoint(cfg, 'storeLat', 'storeLng');
    const dropPoint = tookanStopPoint(order, 'dropLat', 'dropLng');
    try {
        hubs = await widenTookanHubs(cfg, hubs, [pickupPoint, dropPoint]);
    } catch (_) {
        hubs = hubs || [];
    }
    const body = buildTookanParcelBody(cfg, order);
    if (!body.pickups[0].latitude || !body.deliveries[0].latitude) {
        throw new Error(tookanHubFailure('A Tookan parcel needs pickup and delivery coordinates so the hub path can be calculated.', cfg, order, hubs));
    }
    const res = await requestJson('POST', TOOKAN_BASE + '/parcel/addParcel', {
        body: Object.assign({ api_key: cfg.tookan.apiKey }, body)
    });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.status === 100 || data.status === 101 || data.status === 201 || data.status === 404) {
        throw new Error(tookanHubFailure(data.message || 'Tookan could not create the parcel', cfg, order, hubs));
    }
    const fromMs = Date.now() - 60 * 60 * 1000;
    const toMs = Date.now() + 3 * 24 * 60 * 60 * 1000;
    let jobs = [];
    for (let attempt = 0; attempt < 3 && !jobs.length; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 700));
        jobs = await findTookanParcelJobs(cfg, order.orderCode, fromMs, toMs);
    }
    if (!jobs.length) {
        throw new Error(tookanHubFailure('Tookan accepted the parcel, but the hub route was not returned. Check Tookan before booking again.', cfg, order, hubs));
    }
    const update = parcelJourneyUpdate(jobs, hubs, Date.now());
    const otps = mergeTookanOtps(jobs.map(tookanOtpsFromJob));
    return {
        jobId: update && update.jobId ? update.jobId : jobs[0] ? String(jobs[0].job_id) : '',
        deliveryJobId: '',
        trackingLink: '',
        pickupOtp: otps.pickupOtp,
        deliveryOtp: otps.deliveryOtp,
        parcel: true,
        barcode: update && update.barcode ? update.barcode : '',
        pickupAt: update && update.pickupAt ? update.pickupAt : null,
        deliveryAt: update && update.deliveryAt ? update.deliveryAt : null,
        events: update && update.events ? update.events : [],
        raw: data
    };
}

function buildTookanTaskBody(cfg, order, mode) {
    const now = Date.now();
    const pickupAt = tookanDateTime(order.pickupAtMs || now + 20 * 60 * 1000);
    const dropAt = tookanDateTime(order.dropAtMs || (order.pickupAtMs || now) + 90 * 60 * 1000);
    const returning = !!order.returnLeg;
    const logistics = mode === 'logistics' && !returning;
    const body = {
        api_key: cfg.tookan.apiKey,
        order_id: order.orderCode,
        barcode: order.orderCode,
        job_description: (logistics ? 'Parcel ' : returning ? 'Return pickup ' : 'Hyperlocal delivery ') + order.orderCode,
        job_pickup_phone: returning ? order.shippingPhone || order.buyerPhone || '0000000000' : cfg.storePhone || order.buyerPhone || '0000000000',
        job_pickup_name: returning ? order.shippingRecipientName || order.buyerName || 'Customer' : COURIER_PARTNER_NAME,
        job_pickup_address: returning
            ? order.deliveryAddress || [order.shippingCity, order.shippingState].filter(Boolean).join(', ') || 'Customer address'
            : [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', ') || 'Book desk',
        job_pickup_datetime: pickupAt,
        customer_username: returning ? cfg.storeName || COURIER_PARTNER_NAME : order.shippingRecipientName || order.buyerName || 'Customer',
        customer_phone: returning ? cfg.storePhone || '0000000000' : order.shippingPhone || order.buyerPhone || '0000000000',
        customer_address: returning
            ? [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', ') || 'Book desk'
            : order.deliveryAddress || [order.shippingCity, order.shippingState].filter(Boolean).join(', ') || 'Delivery address',
        job_delivery_datetime: dropAt,
        has_pickup: 1,
        has_delivery: 1,
        layout_type: 0,
        tracking_link: 1,
        timezone: '-330',
        auto_assignment: logistics ? 0 : 1,
        notify: 1,
        geofence: 0,
        tags: logistics ? 'parcel' : returning ? 'return' : 'hyperlocal',
        meta_data: [
            { label: 'Courier partner', data: COURIER_PARTNER_NAME },
            { label: 'Mode', data: logistics ? 'parcel' : mode }
        ]
    };
    if (logistics) body.is_multiple_tasks = 0;
    return body;
}

async function createTookanTask(cfg, order, mode) {
    if (!cfg.tookan.enabled) throw new Error('Tookan API key is not configured.');
    if (mode === 'logistics' && !order.returnLeg) return createTookanParcel(cfg, order);
    const storeLat = order.storeLat != null ? order.storeLat : cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg.storeLng;
    const returning = !!order.returnLeg;
    const logistics = mode === 'logistics' && !returning;
    const body = buildTookanTaskBody(cfg, order, mode);
    const pickupLat = returning ? order.dropLat : storeLat;
    const pickupLng = returning ? order.dropLng : storeLng;
    const dropLat = returning ? storeLat : order.dropLat;
    const dropLng = returning ? storeLng : order.dropLng;
    if (pickupLat != null && pickupLng != null) {
        body.job_pickup_latitude = String(pickupLat);
        body.job_pickup_longitude = String(pickupLng);
    }
    if (dropLat != null && dropLng != null) {
        body.latitude = String(dropLat);
        body.longitude = String(dropLng);
    }
    const res = await requestJson('POST', TOOKAN_BASE + '/create_task', { body });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.status === 101 || data.status === 201 || data.status === 404) {
        throw new Error(data.message || 'Tookan could not create the task');
    }
    const d = data.data && typeof data.data === 'object' ? data.data : {};
    const pickupId = d.pickup_job_id || d.job_id || (typeof data.data !== 'object' ? data.data : null);
    const deliveryId = logistics ? null : d.delivery_job_id || null;
    const link = (logistics ? d.tracking_link || d.pickup_tracking_link : d.delivery_tracing_link || d.tracking_link || d.pickup_tracking_link) || null;
    const jobIds = [pickupId, deliveryId].filter((id) => id != null && id !== '');
    const jobs = [];
    for (let i = 0; i < jobIds.length; i++) {
        try {
            jobs.push(await fetchTookanJob(cfg, jobIds[i]));
        } catch (_) {
            jobs.push(null);
        }
    }
    const otps = mergeTookanOtps([tookanOtpsFromJob(d)].concat(jobs.map(tookanOtpsFromJob)));
    return {
        jobId: pickupId != null ? String(pickupId) : '',
        deliveryJobId: deliveryId != null ? String(deliveryId) : '',
        trackingLink: link || '',
        pickupOtp: otps.pickupOtp,
        deliveryOtp: otps.deliveryOtp,
        parcel: logistics,
        raw: data
    };
}

async function fetchTookanJob(cfg, jobId) {
    if (!cfg.tookan.enabled || !jobId) return null;
    const res = await requestJson('POST', TOOKAN_BASE + '/get_job_details', {
        body: { api_key: cfg.tookan.apiKey, job_ids: [Number(jobId) || jobId], include_task_history: 1 }
    });
    const data = res.data || {};
    const list = (data.data && (Array.isArray(data.data) ? data.data : [data.data])) || [];
    return list[0] || null;
}

function tookanJobToUpdate(job, mode, forcedType) {
    if (!job) return null;
    const history = job.task_history || job.job_history || [];
    const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
    let text =
        (last && (last.description || last.job_status || last.type)) ||
        job.job_status_text ||
        tookanStatusLabel(job.job_status);
    if (isDeskNoise(text)) text = tookanStatusLabel(job.job_status);
    const city = (last && (last.city || last.location || last.address)) || job.job_address || '';
    const agentName = job.fleet_name || '';
    const agentPhone = job.fleet_phone || job.fleet_phone_number || '';
    const jobType = forcedType || tookanJobType(job.job_type);
    const otps = tookanOtpsFromJob(job);
    const task = tookanTaskUpdate(jobType, job.job_status, String(text), {
        city: typeof city === 'string' && !/^book desk$/i.test(city) ? city : '',
        agentName,
        agentPhone
    });
    const noisy = isDeskNoise(task.title);
    const kind = noisy ? 'update' : task.kind;
    return {
        provider: 'tookan',
        kind,
        title: noisy ? 'Shipment update' : task.title,
        skipEvent: noisy || !!task.skipEvent,
        detail: isDeskNoise(task.detail) ? '' : task.detail,
        city: task.city,
        taskType: jobType || 'pickup',
        taskStatus: parseInt(job.job_status, 10),
        agentName: agentName || null,
        agentPhone: agentPhone || null,
        agentLat: numOrNull(job.fleet_latitude != null ? job.fleet_latitude : job.latitude),
        agentLng: numOrNull(job.fleet_longitude != null ? job.fleet_longitude : job.longitude),
        trackingLink: job.tracking_link || null,
        stage: stageFromKind(kind, mode),
        liveLeg: liveLegFor(kind, mode),
        pickupOtp: otps.pickupOtp,
        deliveryOtp: otps.deliveryOtp,
        trackingNo: job.barcode ? String(job.barcode).trim() : '',
        pickupAt: tookanWallInstant(job.job_pickup_datetime),
        deliveryAt: tookanWallInstant(job.job_delivery_datetime),
        at: (last && (last.creation_datetime || last.time)) || null,
        externalTaskId: job.job_id != null ? String(job.job_id) : null,
        rawStatus: job.job_status != null ? String(job.job_status) : null
    };
}

/**
 * Pick the update that describes where the parcel really is. The delivery task only counts once
 * it has started; until then the pickup task decides.
 */
function combineTookanUpdates(pickupUpdate, deliveryUpdate) {
    if (!pickupUpdate) return deliveryUpdate || null;
    if (!deliveryUpdate) return pickupUpdate;
    const started = deliveryUpdate.taskStatus === 1 || deliveryUpdate.taskStatus === 2 || deliveryUpdate.taskStatus === 4;
    const dead = deliveryUpdate.kind === 'failed';
    const chosen = started || dead ? deliveryUpdate : pickupUpdate;
    const other = chosen === deliveryUpdate ? pickupUpdate : deliveryUpdate;
    return Object.assign({}, chosen, {
        agentName: chosen.agentName || other.agentName,
        agentPhone: chosen.agentPhone || other.agentPhone,
        pickupOtp: chosen.pickupOtp || other.pickupOtp || '',
        deliveryOtp: chosen.deliveryOtp || other.deliveryOtp || '',
        trackingNo: chosen.trackingNo || other.trackingNo || '',
        pickupAt: (pickupUpdate && pickupUpdate.pickupAt) || chosen.pickupAt || other.pickupAt || null,
        deliveryAt: (deliveryUpdate && deliveryUpdate.deliveryAt) || chosen.deliveryAt || other.deliveryAt || null
    });
}

function buildShipdayOrderBody(cfg, order) {
    const now = Date.now();
    const items = (order.items || []).map((it) => ({
        name: it.title || it.bookTitle || it.book_id || 'Book',
        quantity: Number(it.qty) || 1,
        unitPrice: Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0
    }));
    if (!items.length) items.push({ name: 'Book order ' + order.orderCode, quantity: 1, unitPrice: Number(order.totalAmount) || 0 });
    const body = {
        orderNumber: order.orderCode,
        customerName: order.returnLeg ? cfg.storeName : order.shippingRecipientName || order.buyerName || 'Customer',
        customerAddress: order.returnLeg
            ? [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', ')
            : order.deliveryAddress || [order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).join(', '),
        customerPhoneNumber: order.returnLeg ? cfg.storePhone || '' : order.shippingPhone || order.buyerPhone || '',
        restaurantName: order.returnLeg ? order.shippingRecipientName || order.buyerName || 'Customer' : COURIER_PARTNER_NAME,
        restaurantAddress: order.returnLeg
            ? order.deliveryAddress || [order.shippingCity, order.shippingState].filter(Boolean).join(', ')
            : [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', '),
        restaurantPhoneNumber: order.returnLeg ? order.shippingPhone || order.buyerPhone || '' : cfg.storePhone || '',
        expectedDeliveryDate: shipdayDate(order.dropAtMs || now + 90 * 60 * 1000),
        expectedPickupTime: shipdayTime(order.pickupAtMs || now + 20 * 60 * 1000),
        expectedDeliveryTime: shipdayTime(order.dropAtMs || now + 90 * 60 * 1000),
        deliveryInstruction: COURIER_PARTNER_NAME + ' order ' + order.orderCode,
        paymentMethod: 'credit_card',
        totalOrderCost: Number(order.totalAmount) || 0,
        deliveryFee: 0,
        orderItem: items
    };
    const storeLat = order.storeLat != null ? order.storeLat : cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg.storeLng;
    if (storeLat != null) body.pickupLatitude = storeLat;
    if (storeLng != null) body.pickupLongitude = storeLng;
    if (order.dropLat != null) body.deliveryLatitude = order.dropLat;
    if (order.dropLng != null) body.deliveryLongitude = order.dropLng;
    return body;
}

async function createShipdayOrder(cfg, order) {
    if (!cfg.shipday.enabled) throw new Error('Shipday API key is not configured.');
    const body = buildShipdayOrderBody(cfg, order);
    const res = await requestJson('POST', SHIPDAY_BASE + '/orders', {
        headers: { Authorization: 'Basic ' + cfg.shipday.apiKey },
        body
    });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.success === false) {
        throw new Error(data.message || data.error || 'Shipday could not create the order');
    }
    const orderId = data.orderId || data.id || (data.order && data.order.id);
    const link = data.trackingLink || data.trackingUrl || data.orderTrackingUrl || '';
    return { orderId: orderId != null ? String(orderId) : '', trackingLink: link, raw: data };
}

function shipdayList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object');
    if (Array.isArray(data.orders)) return data.orders.filter((row) => row && typeof row === 'object');
    if (data.order && typeof data.order === 'object') return [data.order];
    if (data.orderId != null || data.orderStatus || data.order_status) return [data];
    return [];
}

/**
 * GET /orders/{orderNumber} returns an array. The path is the order reference we sent,
 * not Shipday's numeric order id. An empty array is a miss, not an order.
 */
function selectShipdayOrder(data, orderId, orderNumber) {
    const list = shipdayList(data);
    if (!list.length) return null;
    const id = orderId != null && orderId !== '' ? String(orderId) : '';
    const number = orderNumber != null && orderNumber !== '' ? String(orderNumber) : '';
    if (id) {
        const byId = list.find((row) => String(row.orderId || row.id || '') === id);
        if (byId) return byId;
    }
    if (number) {
        const byNumber = list.filter((row) => String(row.orderNumber || row.order_number || '') === number);
        if (byNumber.length) return byNumber[0];
    }
    if (list.length === 1 && !id && !number) return list[0];
    return null;
}

async function fetchShipdayOrder(cfg, orderId, orderNumber) {
    if (!cfg.shipday.enabled || (!orderId && !orderNumber)) return null;
    const headers = { Authorization: 'Basic ' + cfg.shipday.apiKey };
    const refs = [];
    if (orderNumber) refs.push(String(orderNumber));
    if (orderId && String(orderId) !== String(orderNumber || '')) refs.push(String(orderId));
    for (let i = 0; i < refs.length; i++) {
        const res = await requestJson('GET', SHIPDAY_BASE + '/orders/' + encodeURIComponent(refs[i]), { headers });
        if (!res || res.statusCode >= 400) continue;
        const picked = selectShipdayOrder(res.data, orderId, orderNumber);
        if (picked) return picked;
    }
    return null;
}

function shipdayActivity(order) {
    const log = order && (order.activityLog || order.activity_log);
    const nested = order && order.order && typeof order.order === 'object' ? order.order : {};
    const src = log && typeof log === 'object' ? log : {};
    return {
        assignedTime: src.assignedTime || src.assigned_time || nested.assigned_time || null,
        startTime: src.startTime || src.start_time || nested.start_time || null,
        pickedUpTime: src.pickedUpTime || src.pickedupTime || src.pickedup_time || nested.pickedup_time || null,
        arrivedTime: src.arrivedTime || src.arrived_time || nested.arrived_time || null,
        deliveryTime: src.deliveryTime || src.delivery_time || nested.delivery_time || null
    };
}

function shipdayInstant(value) {
    if (value == null || value === '' || value === 0 || value === '0') return null;
    if (typeof value === 'number') {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    const s = String(value).trim();
    if (!s || s.toLowerCase() === 'null') return null;
    if (/^\d{10,13}$/.test(s)) return shipdayInstant(Number(s));
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z';
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function shipdayEventTime(order, kind) {
    const log = shipdayActivity(order);
    const pick = {
        delivered: log.deliveryTime || log.arrivedTime,
        out_for_delivery: log.pickedUpTime || log.arrivedTime,
        to_store: log.startTime,
        at_pickup: log.arrivedTime,
        agent_assigned: log.assignedTime,
        ready_for_pickup: log.assignedTime
    };
    return shipdayInstant(pick[kind]);
}

function shipdayProgressKind(order) {
    const log = shipdayActivity(order);
    if (shipdayInstant(log.deliveryTime)) return 'delivered';
    if (shipdayInstant(log.pickedUpTime) || shipdayInstant(log.arrivedTime)) return 'out_for_delivery';
    if (shipdayInstant(log.startTime)) return 'to_store';
    if (shipdayInstant(log.assignedTime)) return 'agent_assigned';
    return '';
}

function shipdayCarrier(order) {
    const row = order && typeof order === 'object' ? order : {};
    const assigned = row.assignedCarrier && typeof row.assignedCarrier === 'object' ? row.assignedCarrier : {};
    const carrier = row.carrier && typeof row.carrier === 'object' ? row.carrier : {};
    const third = row.thirdPartyDeliveryOrder && typeof row.thirdPartyDeliveryOrder === 'object' ? row.thirdPartyDeliveryOrder : {};
    const name = assigned.name || carrier.name || row.carrierName || third.driverName || '';
    const phone = assigned.phoneNumber || assigned.phone || carrier.phoneNumber || carrier.phone || row.carrierPhone || third.driverPhone || '';
    const lat = assigned.latitude != null ? assigned.latitude : assigned.lat != null ? assigned.lat : carrier.latitude != null ? carrier.latitude : carrier.lat != null ? carrier.lat : row.carrierLat != null ? row.carrierLat : row.latitude;
    const lng = assigned.longitude != null ? assigned.longitude : assigned.lng != null ? assigned.lng : carrier.longitude != null ? carrier.longitude : carrier.lng != null ? carrier.lng : row.carrierLng != null ? row.carrierLng : row.longitude;
    return {
        name: name || null,
        phone: phone || null,
        lat: numOrNull(lat),
        lng: numOrNull(lng)
    };
}

function shipdayWall(date, time) {
    const raw = String(date || '').trim();
    if (!raw) return null;
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) || raw.indexOf('T') !== -1) return shipdayInstant(raw);
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return shipdayInstant(raw);
    const day = raw.slice(0, 10);
    const clock = String(time || '').trim();
    const hm = clock.match(/(\d{1,2}):(\d{2})/);
    const hh = hm ? String(hm[1]).padStart(2, '0') : '00';
    const mm = hm ? hm[2] : '00';
    const parsed = new Date(day + 'T' + hh + ':' + mm + ':00+05:30');
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function shipdayAwb(order) {
    const row = order && typeof order === 'object' ? order : {};
    const third = row.thirdPartyDeliveryOrder && typeof row.thirdPartyDeliveryOrder === 'object' ? row.thirdPartyDeliveryOrder : {};
    const own = String(row.orderNumber || row.order_number || '');
    const ownId = String(row.orderId || row.id || '');
    const candidates = [third.trackingId, third.tracking_id, third.awb, third.referenceId, row.trackingId, row.trackingNumber, row.awb];
    for (let i = 0; i < candidates.length; i++) {
        const value = String(candidates[i] == null ? '' : candidates[i]).trim();
        if (value && value !== own && value !== ownId) return value;
    }
    return '';
}

function shipdayOrderToUpdate(order) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) return null;
    const status = order.orderStatus || order.order_status || order.status || order.event;
    let kind = mapShipdayStatus(status);
    if (kind === 'update') {
        const fromLog = shipdayProgressKind(order);
        if (fromLog) kind = fromLog;
    }
    const statusObj = status && typeof status === 'object' ? status : null;
    if (statusObj && statusObj.incomplete === true && kind !== 'delivered') kind = 'failed';
    const carrier = shipdayCarrier(order);
    const stateText = statusObj ? statusObj.orderState || statusObj.status || '' : status;
    const phrase = phraseLogisticsUpdate(String(stateText || 'Shipment update').replace(/_/g, ' '), {
        agentName: carrier.name || '',
        agentPhone: carrier.phone || ''
    });
    const title = KIND_TITLES[kind] || (isDeskNoise(phrase.title) ? 'Shipment update' : phrase.title);
    return {
        provider: 'shipday',
        kind,
        title,
        detail: [phrase.agentName, phrase.agentPhone].filter(Boolean).join(' · '),
        city: '',
        agentName: carrier.name,
        agentPhone: carrier.phone,
        agentLat: carrier.lat,
        agentLng: carrier.lng,
        carrierId: shipdayCarrierId(order),
        storeLat: shipdayPlace(order.restaurant).lat,
        storeLng: shipdayPlace(order.restaurant).lng,
        dropLat: shipdayPlace(order.customer).lat,
        dropLng: shipdayPlace(order.customer).lng,
        trackingLink: order.trackingLink || order.trackingUrl || null,
        stage: stageFromKind(kind, 'hyperlocal'),
        liveLeg: liveLegFor(kind, 'hyperlocal'),
        at: shipdayEventTime(order, kind),
        externalTaskId: order.orderId != null ? String(order.orderId) : order.id != null ? String(order.id) : null,
        rawStatus: stateText != null && stateText !== '' ? String(stateText) : null,
        agentId: shipdayCarrierId(order),
        trackingNo: shipdayAwb(order),
        pickupAt: shipdayWall(order.expectedPickupDate || order.expected_pickup_date || order.expectedDeliveryDate || order.expected_delivery_date, order.expectedPickupTime || order.expected_pickup_time),
        deliveryAt: shipdayWall(order.expectedDeliveryDate || order.expected_delivery_date, order.expectedDeliveryTime || order.expected_delivery_time),
        pickupOtp: '',
        deliveryOtp: ''
    };
}

function shipdayPlace(party) {
    if (!party || typeof party !== 'object') return { lat: null, lng: null };
    return {
        lat: numOrNull(party.latitude != null ? party.latitude : party.lat),
        lng: numOrNull(party.longitude != null ? party.longitude : party.lng)
    };
}

function shipdayCarrierId(order) {
    const assigned = order && order.assignedCarrier;
    const id = assigned && assigned.id != null ? assigned.id : order && order.assignedCarrierId;
    const n = parseInt(id, 10);
    return Number.isFinite(n) && n > 0 ? String(n) : null;
}

async function fetchShipdayCarrierPoint(cfg, carrierId) {
    if (!cfg.shipday.enabled || !carrierId) return null;
    const res = await requestJson('GET', SHIPDAY_BASE + '/carriers', {
        headers: { Authorization: 'Basic ' + cfg.shipday.apiKey }
    });
    if (!res || res.statusCode >= 400 || !Array.isArray(res.data)) return null;
    const hit = res.data.find((row) => row && String(row.id) === String(carrierId));
    if (!hit) return null;
    const lat = numOrNull(hit.carrrierLocationLat != null ? hit.carrrierLocationLat : hit.carrierLocationLat != null ? hit.carrierLocationLat : hit.latitude);
    const lng = numOrNull(hit.carrrierLocationLng != null ? hit.carrrierLocationLng : hit.carrierLocationLng != null ? hit.carrierLocationLng : hit.longitude);
    if (lat == null || lng == null) return null;
    return { lat, lng };
}

function parseTookanWebhook(body) {
    const b = body && typeof body === 'object' ? body : {};
    const text = String(b.job_state || b.job_status_text || b.task_status || tookanStatusLabel(b.job_status) || '');
    const jobType = tookanJobType(b.job_type);
    const foreignTask = b.job_type != null && b.job_type !== '' && jobType === null;
    const task = tookanTaskUpdate(jobType, b.job_status, text, {
        city: b.job_address || b.city || '',
        agentName: b.fleet_name || '',
        agentPhone: b.fleet_phone || ''
    });
    return {
        provider: 'tookan',
        jobId: b.job_id != null ? String(b.job_id) : '',
        orderCode: String(b.order_id || '').trim(),
        jobType,
        ignore: foreignTask,
        taskStatus: parseInt(b.job_status, 10),
        externalTaskId: b.job_id != null ? String(b.job_id) : '',
        rawStatus: b.job_status != null ? String(b.job_status) : null,
        kind: task.kind,
        title: task.title,
        detail: task.detail,
        city: task.city,
        skipEvent: !!task.skipEvent,
        agentName: b.fleet_name || null,
        agentPhone: b.fleet_phone || null,
        agentLat: numOrNull(b.fleet_latitude != null ? b.fleet_latitude : b.latitude),
        agentLng: numOrNull(b.fleet_longitude != null ? b.fleet_longitude : b.longitude),
        trackingLink: b.tracking_link || null,
        sharedSecret: b.tookan_shared_secret || b.shared_secret || ''
    };
}

function parseShipdayWebhook(body) {
    const b = body && typeof body === 'object' ? body : {};
    const nested = b.order && typeof b.order === 'object' ? b.order : {};
    const update = shipdayOrderToUpdate({
        orderStatus: b.order_status || b.orderStatus || b.status || b.event || '',
        activityLog: b.activityLog || null,
        order: nested,
        assignedCarrier: b.assignedCarrier || null,
        carrier: b.carrier || null,
        carrierName: b.carrierName || '',
        carrierPhone: b.carrierPhone || '',
        carrierLat: b.carrierLat != null ? b.carrierLat : b.latitude,
        carrierLng: b.carrierLng != null ? b.carrierLng : b.longitude,
        thirdPartyDeliveryOrder: b.thirdPartyDeliveryOrder || null,
        trackingLink: b.trackingUrl || b.trackingLink || null
    }) || {
        kind: 'update',
        title: 'Shipment update',
        detail: '',
        city: '',
        agentName: null,
        agentPhone: null,
        agentLat: null,
        agentLng: null,
        trackingLink: null
    };
    const id = b.orderId != null ? b.orderId : nested.id != null ? nested.id : nested.orderId;
    return {
        provider: 'shipday',
        shipdayOrderId: id != null && id !== '' ? String(id) : '',
        orderCode: String(b.orderNumber || b.order_number || nested.order_number || nested.orderNumber || '').trim(),
        kind: update.kind,
        title: update.title,
        detail: update.detail,
        city: update.city || '',
        externalTaskId: update.externalTaskId || (id != null && id !== '' ? String(id) : null),
        rawStatus: update.rawStatus || null,
        agentId: update.agentId || null,
        agentName: update.agentName,
        agentPhone: update.agentPhone,
        agentLat: update.agentLat,
        agentLng: update.agentLng,
        trackingLink: update.trackingLink,
        stage: update.stage,
        liveLeg: update.liveLeg,
        at: update.at || null
    };
}

async function rescheduleTookanDelivery(cfg, jobId, startMs) {
    const res = await requestJson('POST', TOOKAN_BASE + '/edit_task', {
        body: {
            api_key: cfg.tookan.apiKey,
            job_id: Number(jobId) || jobId,
            job_delivery_datetime: tookanDateTime(startMs)
        }
    });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.status === 100 || data.status === 101 || data.status === 201 || data.status === 404) {
        throw new Error(data.message || 'Tookan could not reschedule the delivery');
    }
    return data;
}

async function rescheduleShipdayDelivery(cfg, orderId, startMs) {
    const res = await requestJson('PUT', SHIPDAY_BASE + '/orders/edit/' + encodeURIComponent(String(orderId)), {
        headers: { Authorization: 'Basic ' + cfg.shipday.apiKey },
        body: {
            expectedDeliveryDate: tookanDateTime(startMs).slice(0, 10),
            expectedDeliveryTime: tookanDateTime(startMs).slice(11, 19)
        }
    });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.success === false) {
        throw new Error(data.message || data.response || 'Shipday could not reschedule the delivery');
    }
    return data;
}

const pidgeTokenCache = { token: '', username: '' };
const pidgeTrackAt = new Map();

function scrubSecret(text, secret) {
    const s = String(text || '');
    const key = String(secret || '');
    if (key.length >= 3) return s.split(key).join('').slice(0, 300);
    return s.slice(0, 300);
}

function pidgeAuthorization(token) {
    const t = String(token || '').trim();
    if (!t) return '';
    return /^bearer\s+/i.test(t) ? t : 'Bearer ' + t;
}

function pidgeMobile(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 10) return '';
    return digits.slice(-10);
}

function pidgeErrorMessage(res, password) {
    const data = res && res.data && typeof res.data === 'object' ? res.data : {};
    const nested = data.error && typeof data.error === 'object' ? data.error.message : '';
    return scrubSecret(data.message || nested || 'Pidge could not complete the request', password);
}

async function pidgeLogin(cfg) {
    if (!cfg.pidge || !cfg.pidge.username || !cfg.pidge.password) throw new Error('Pidge is not configured.');
    const res = await requestJson('POST', PIDGE_BASE + '/v1.0/store/channel/vendor/login', {
        body: { username: cfg.pidge.username, password: cfg.pidge.password }
    });
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const token = data.data && data.data.token;
    if (!token) throw new Error(pidgeErrorMessage(res, cfg.pidge.password) || 'Pidge login failed');
    pidgeTokenCache.token = String(token);
    pidgeTokenCache.username = cfg.pidge.username;
    return pidgeTokenCache.token;
}

async function pidgeRequest(cfg, method, path, body, attempt) {
    let token = pidgeTokenCache.username === cfg.pidge.username ? pidgeTokenCache.token : '';
    if (!token) token = await pidgeLogin(cfg);
    const res = await requestJson(method, PIDGE_BASE + path, {
        headers: { Authorization: pidgeAuthorization(token) },
        body: body == null ? null : body
    });
    if (res.statusCode === 401 && !attempt) {
        pidgeTokenCache.token = '';
        pidgeTokenCache.username = '';
        await pidgeLogin(cfg);
        return pidgeRequest(cfg, method, path, body, 1);
    }
    return res;
}

const PIDGE_STATES = [
    'Andhra Pradesh',
    'Arunachal Pradesh',
    'Andaman and Nicobar Islands',
    'Assam',
    'Bihar',
    'Chandigarh',
    'Chhattisgarh',
    'Dadra and Nagar Haveli and Daman and Diu',
    'Delhi',
    'Goa',
    'Gujarat',
    'Haryana',
    'Himachal Pradesh',
    'Jammu and Kashmir',
    'Jharkhand',
    'Karnataka',
    'Kerala',
    'Ladakh',
    'Lakshadweep',
    'Madhya Pradesh',
    'Maharashtra',
    'Manipur',
    'Meghalaya',
    'Mizoram',
    'Nagaland',
    'Odisha',
    'Puducherry',
    'Punjab',
    'Rajasthan',
    'Sikkim',
    'Tamil Nadu',
    'Telangana',
    'Tripura',
    'Uttar Pradesh',
    'Uttarakhand',
    'West Bengal'
].sort((a, b) => b.length - a.length);

function pidgePin(value) {
    const hit = String(value || '').match(/\d{6}/);
    return hit ? hit[0] : '';
}

function pidgeStateName(value) {
    const blob = String(value || '');
    for (let i = 0; i < PIDGE_STATES.length; i++) {
        const state = PIDGE_STATES[i];
        const pattern = new RegExp('\\b' + state.replace(/\s+/g, '\\s+') + '\\b', 'i');
        if (pattern.test(blob)) return state;
    }
    return '';
}

function pidgeParty(name, mobile, addressLine, city, state, pincode, lat, lng, email) {
    const line = String(addressLine || '').trim();
    const cityText = String(city || '').trim();
    const combined = [line, cityText].filter(Boolean).join(', ');
    const pin = pidgePin(pincode) || pidgePin(combined);
    const stateName = String(state || '').trim() || pidgeStateName(combined);
    const address = { address_line_1: line, country: 'India' };
    if (cityText) address.city = cityText;
    if (stateName) address.state = stateName;
    if (pin) address.pincode = pin;
    if (lat != null) address.latitude = lat;
    if (lng != null) address.longitude = lng;
    const party = {
        name: String(name || '').trim() || 'Customer',
        mobile: pidgeMobile(mobile),
        address
    };
    if (email && /@/.test(String(email))) party.email = String(email).trim();
    return party;
}

function pidgeRequirePlace(party, role) {
    const missing = [];
    if (!party.address.state) missing.push('state');
    if (!party.address.pincode) missing.push('PIN');
    if (missing.length) throw new Error('Pidge needs the ' + role + ' ' + missing.join(' and ') + '.');
}

function buildPidgeOrderBody(cfg, order) {
    const storeLat = order.storeLat != null ? order.storeLat : cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg.storeLng;
    const customer = pidgeParty(
        order.shippingRecipientName || order.buyerName,
        order.shippingPhone || order.buyerPhone,
        order.deliveryAddress,
        order.shippingCity,
        order.shippingState,
        order.shippingPincode,
        order.dropLat,
        order.dropLng,
        order.buyerEmail
    );
    const store = pidgeParty(
        cfg.storeName || COURIER_PARTNER_NAME,
        cfg.storePhone,
        cfg.storeAddress,
        cfg.storeCity,
        cfg.storeState,
        cfg.storePincode,
        storeLat,
        storeLng,
        ''
    );
    const sender = order.returnLeg ? customer : store;
    const receiver = order.returnLeg ? store : customer;
    if (!sender.mobile || !receiver.mobile) throw new Error('Pidge needs a phone number.');
    if (!sender.address.address_line_1 || !receiver.address.address_line_1) throw new Error('Pidge needs a delivery address.');
    pidgeRequirePlace(sender, 'pickup address');
    pidgeRequirePlace(receiver, 'delivery address');
    const items = (order.items || []).map((it) => ({
        name: it.title || it.bookTitle || it.book_id || 'Book',
        sku: String(it.bookId || it.book_id || it.sku || it.title || 'book').slice(0, 40),
        price: Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0,
        qty: Number(it.qty) || 1
    }));
    if (!items.length) items.push({ name: 'Book order ' + order.orderCode, sku: order.orderCode, price: Number(order.totalAmount) || 0, qty: 1 });
    const qty = items.reduce((sum, it) => sum + it.qty, 0);
    const trip = {
        receiver_detail: receiver,
        packages: [{ label: 'Books', quantity: qty || 1, code: order.orderCode }],
        source_order_id: order.orderCode,
        reference_id: order.orderCode,
        promised_prep_time: new Date(order.pickupAtMs || Date.now()).toISOString(),
        promised_delivery_time: new Date(order.dropAtMs || Date.now() + 90 * 60 * 1000).toISOString(),
        cod_amount: String(order.paymentMode || '').toLowerCase() === 'cod' ? Number(order.totalAmount) || 0 : 0,
        bill_amount: Number(order.totalAmount) || 0,
        products: items.map((it) => ({ name: it.name, sku: it.sku, price: it.price }))
    };
    const note = String(order.deliveryNote || '').replace(/\s+/g, ' ').trim();
    if (note) trip.notes = [{ name: 'delivery_note', value: note.slice(0, 240) }];
    const body = {
        sender_detail: sender,
        poc_detail: { name: cfg.storeName || COURIER_PARTNER_NAME, mobile: store.mobile },
        trips: [trip]
    };
    if (cfg.pidge && cfg.pidge.channel) body.channel = cfg.pidge.channel;
    return body;
}

async function createPidgeOrder(cfg, order) {
    if (!cfg.pidge || !cfg.pidge.enabled) throw new Error('Pidge is not configured.');
    const body = buildPidgeOrderBody(cfg, order);
    const res = await pidgeRequest(cfg, 'POST', '/v1.0/store/channel/vendor/order', body);
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const map = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : null;
    const id = map ? map[order.orderCode] || map[Object.keys(map)[0]] : '';
    if (res.statusCode >= 400 || !id) throw new Error(pidgeErrorMessage(res, cfg.pidge.password));
    return { orderId: String(id) };
}

function pidgeFulfillmentKind(status) {
    const s = String(status || '').trim().toUpperCase();
    if (s === 'CREATED' || s === 'CANCELLED') return 'pickup_scheduled';
    if (s === 'OUT_FOR_PICKUP') return 'to_store';
    if (s === 'REACHED_PICKUP') return 'at_pickup';
    if (s === 'PICKED_UP') return 'picked_up';
    if (s === 'IN_TRANSIT') return 'arrived_facility';
    if (s === 'OUT_FOR_DELIVERY' || s === 'REACHED_DELIVERY') return 'out_for_delivery';
    if (s === 'DELIVERED') return 'delivered';
    if (s === 'UNDELIVERED' || s === 'DISPOSED' || s === 'LOST' || s === 'DAMAGED' || s.indexOf('RTO_') === 0) return 'failed';
    return 'update';
}

function pidgeKindTitle(kind, fulfillmentStatus) {
    const s = String(fulfillmentStatus || '').trim().toUpperCase();
    if (s === 'REACHED_DELIVERY') return 'Delivery agent reached the drop location';
    if (s === 'IN_TRANSIT') return 'Item arrived at courier facility';
    if (s === 'CANCELLED') return KIND_TITLES.pickup_scheduled;
    return KIND_TITLES[kind] || 'Shipment update';
}

function unwrapPidgePayload(body) {
    if (!body || typeof body !== 'object') return {};
    const inner = body.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && (inner.id || inner.status || inner.fulfillment)) return inner;
    return body;
}

function pidgePayloadToUpdate(payload, mode) {
    const body = unwrapPidgePayload(payload);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const parent = String(body.status || '').trim().toUpperCase();
    const fulfillment = body.fulfillment && typeof body.fulfillment === 'object' ? body.fulfillment : {};
    const fStatus = String(fulfillment.status || '').trim().toUpperCase();
    const hyper = mode === 'hyperlocal';
    const cancelOrder = parent === 'CANCELLED';
    let kind = 'update';
    if (fStatus === 'CANCELLED') kind = 'pickup_scheduled';
    else if (fStatus) kind = pidgeFulfillmentKind(fStatus);
    else if (parent === 'PENDING' || parent === 'FULFILLED') kind = 'pickup_scheduled';
    if (parent === 'COMPLETED' && fStatus !== 'DELIVERED') {
        kind = fStatus && fStatus !== 'CANCELLED' ? pidgeFulfillmentKind(fStatus) : 'update';
        if (kind === 'delivered') kind = 'update';
    }
    if (cancelOrder) kind = 'update';
    const logs = Array.isArray(fulfillment.logs) ? fulfillment.logs : [];
    const last = logs.length ? logs[logs.length - 1] : null;
    const rider = (last && last.rider) || fulfillment.rider || null;
    const loc = last && last.location ? last.location : null;
    const title = kind === 'update' ? 'Shipment update' : pidgeKindTitle(kind, fStatus);
    const track = fulfillment.track_code || body.track_code || '';
    const otps = pidgeOtps(body, fulfillment, fStatus);
    const pickupEta = fulfillment.pickup && fulfillment.pickup.eta;
    const dropEta = fulfillment.drop && fulfillment.drop.eta;
    return {
        provider: 'pidge',
        kind,
        title,
        detail: '',
        city: '',
        skipEvent: kind === 'update',
        cancelOrder,
        agentName: hyper && rider && rider.name ? String(rider.name) : null,
        agentPhone: hyper && rider && (rider.mobile || rider.phone) ? String(rider.mobile || rider.phone) : null,
        agentLat: hyper && loc ? numOrNull(loc.latitude) : null,
        agentLng: hyper && loc ? numOrNull(loc.longitude) : null,
        trackingNo: track ? String(track) : null,
        stage: stageFromKind(kind, mode),
        liveLeg: liveLegFor(kind, mode),
        at: (last && last.timestamp) || body.updated_at || null,
        pidgeOrderId: body.id != null ? String(body.id) : '',
        referenceId: String(body.reference_id || (body.dd_channel && body.dd_channel.order_id) || '').trim(),
        externalTaskId: body.id != null ? String(body.id) : null,
        rawStatus: fStatus || parent || null,
        pickupOtp: otps.pickupOtp,
        deliveryOtp: otps.deliveryOtp,
        pickupAt: isoInstant(pickupEta),
        deliveryAt: isoInstant(dropEta) || pidgeSlotInstant(body.delivery_date || fulfillment.delivery_date, body.delivery_slot || fulfillment.delivery_slot)
    };
}

function isoInstant(value) {
    if (value == null || value === '') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function pidgeSlotInstant(date, slot) {
    const day = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const match = String(slot || '').match(/(\d{1,2}):(\d{2})/);
    const hh = match ? String(match[1]).padStart(2, '0') : '12';
    const mm = match ? match[2] : '00';
    const parsed = new Date(day + 'T' + hh + ':' + mm + ':00+05:30');
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function otpFromNamed(obj, which, allowGeneric) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (/pincode|pin_code|postal/i.test(key)) continue;
        if (!allowGeneric && /^(otp|verification_code)$/i.test(key)) continue;
        if (!/otp|verification_code|delivery_code/i.test(key)) continue;
        if (which === 'pickup' && /deliver|drop/i.test(key)) continue;
        if (which === 'delivery' && /pick/i.test(key) && !/deliver|drop/i.test(key)) continue;
        const hit = otpDigits(obj[key]);
        if (hit) return hit;
    }
    return '';
}

function otpFromProof(list, which) {
    if (!Array.isArray(list)) return '';
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || typeof item !== 'object') continue;
        const label = String(item.type || item.name || item.label || '');
        if (/pincode|postal/i.test(label)) continue;
        if (!/otp/i.test(label) && item.otp == null && item.verification_code == null) continue;
        const hit = otpDigits(item.otp != null ? item.otp : item.verification_code != null ? item.verification_code : item.value != null ? item.value : item.code);
        if (!hit) continue;
        if (which === 'pickup' && /deliver|drop/i.test(label)) continue;
        if (which === 'delivery' && /pick/i.test(label) && !/deliver|drop/i.test(label)) continue;
        return hit;
    }
    return '';
}

function pidgeOtps(body, fulfillment, fStatus) {
    const drop = fulfillment.drop && typeof fulfillment.drop === 'object' ? fulfillment.drop : {};
    const pickup = fulfillment.pickup && typeof fulfillment.pickup === 'object' ? fulfillment.pickup : {};
    const notes = []
        .concat(Array.isArray(body.notes) ? body.notes : [])
        .concat(Array.isArray(fulfillment.notes) ? fulfillment.notes : []);
    let notePickup = '';
    let noteDelivery = '';
    notes.forEach((note) => {
        if (!note || typeof note !== 'object') return;
        const name = String(note.name || note.label || '');
        if (/pincode|postal/i.test(name) || !/otp/i.test(name)) return;
        const hit = otpDigits(note.value != null ? note.value : note.data);
        if (!hit) return;
        if (/pick/i.test(name) && !/deliver|drop/i.test(name)) notePickup = notePickup || hit;
        else noteDelivery = noteDelivery || hit;
    });
    let deliveryOtp =
        otpFromNamed(drop, 'delivery', true) ||
        otpFromProof(drop.proof, 'delivery') ||
        otpFromNamed(fulfillment, 'delivery', false) ||
        noteDelivery;
    let pickupOtp =
        otpFromNamed(pickup, 'pickup', true) ||
        otpFromProof(pickup.proof, 'pickup') ||
        otpFromNamed(fulfillment, 'pickup', false) ||
        notePickup;
    const generic = otpDigits(fulfillment.otp);
    if (generic) {
        if (/OUT_FOR_DELIVERY|REACHED_DELIVERY|DELIVERED/.test(fStatus)) deliveryOtp = deliveryOtp || generic;
        else if (/OUT_FOR_PICKUP|REACHED_PICKUP|PICKED_UP/.test(fStatus)) pickupOtp = pickupOtp || generic;
        else deliveryOtp = deliveryOtp || generic;
    }
    return { pickupOtp, deliveryOtp };
}

async function fetchPidgeUpdate(cfg, order) {
    if (!cfg.pidge || !cfg.pidge.enabled || !order || !order.pidgeOrderId) return null;
    const res = await pidgeRequest(cfg, 'GET', '/v1.0/store/channel/vendor/order/' + encodeURIComponent(order.pidgeOrderId));
    if (!res || res.statusCode >= 400) throw new Error(pidgeErrorMessage(res, cfg.pidge.password));
    const update = pidgePayloadToUpdate(res.data, order.commerceMode);
    if (!update) return null;
    const terminal = update.kind === 'delivered' || update.kind === 'failed' || update.cancelOrder;
    if (order.commerceMode === 'hyperlocal' && !terminal) {
        const key = String(order.pidgeOrderId);
        const last = pidgeTrackAt.get(key) || 0;
        if (Date.now() - last >= 30000) {
            pidgeTrackAt.set(key, Date.now());
            try {
                const tr = await pidgeRequest(cfg, 'GET', '/v1.0/store/channel/vendor/order/' + encodeURIComponent(key) + '/fulfillment/tracking');
                const data = tr && tr.data && tr.data.data;
                if (tr && tr.statusCode < 400 && data && data.location) {
                    const lat = numOrNull(data.location.latitude);
                    const lng = numOrNull(data.location.longitude);
                    if (lat != null && lng != null) {
                        update.agentLat = lat;
                        update.agentLng = lng;
                        update.at = new Date().toISOString();
                    }
                    if (data.rider && data.rider.name) update.agentName = String(data.rider.name);
                    if (data.rider && data.rider.mobile) update.agentPhone = String(data.rider.mobile);
                }
            } catch (_) {}
        }
    }
    return update;
}

function pidgeWebhookAuthorized(cfg, headerValue) {
    const expected = cfg && cfg.pidge && cfg.pidge.webhookToken;
    if (!expected) return true;
    const got = String(headerValue || '').trim();
    return got === expected || got === 'Bearer ' + expected;
}

function parsePidgeWebhook(body) {
    return pidgePayloadToUpdate(unwrapPidgePayload(body), 'logistics');
}

function fleetbaseAuthHeader(secret) {
    const key = String(secret || '').trim();
    if (!key) return '';
    return /^bearer\s+/i.test(key) ? key : 'Bearer ' + key;
}

function fleetbaseErrorMessage(res, secret) {
    const data = res && res.data;
    let msg = 'Fleetbase could not complete the request';
    if (data && typeof data === 'object') {
        if (typeof data.message === 'string' && data.message) msg = data.message;
        else if (typeof data.error === 'string' && data.error) msg = data.error;
    } else if (res && res.raw && typeof res.raw === 'string' && res.raw.length < 240) msg = res.raw;
    if (secret) msg = msg.split(String(secret)).join('');
    return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function fleetbaseRequest(cfg, method, path, body) {
    const fleet = cfg && cfg.fleetbase;
    if (!fleet || !fleet.apiHost) throw new Error('Fleetbase API host is not configured.');
    const res = await requestJson(method, fleet.apiHost + path, {
        headers: {
            Authorization: fleetbaseAuthHeader(fleet.secretKey),
            Accept: 'application/json'
        },
        body: body == null ? null : body
    });
    return res;
}

function parseFleetbaseHubs(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => {
            const parts = String(line).split('|');
            const name = String(parts[0] || '').replace(/\s+/g, ' ').trim();
            const address = parts.slice(1).join('|').replace(/\s+/g, ' ').trim();
            if (!name || !address || name.length > 80) return null;
            return { name, address };
        })
        .filter(Boolean);
}

function fleetbasePlaceText(name, address) {
    const who = String(name || '').replace(/\s+/g, ' ').trim();
    const where = String(address || '').replace(/\s+/g, ' ').trim();
    return [who, where].filter(Boolean).join(', ');
}

function buildFleetbaseOrderBody(cfg, order) {
    const fleet = cfg.fleetbase || {};
    const returning = !!order.returnLeg;
    const storeAddress = [cfg.storeAddress, cfg.storeCity, cfg.storeState, cfg.storePincode].filter(Boolean).join(', ');
    const customerAddress = [order.deliveryAddress, order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).join(', ');
    const storeName = cfg.storeName || COURIER_PARTNER_NAME;
    const customerName = order.shippingRecipientName || order.buyerName || 'Customer';
    const pickup = fleetbasePlaceText(returning ? customerName : storeName, returning ? customerAddress : storeAddress);
    const dropoff = fleetbasePlaceText(returning ? storeName : customerName, returning ? storeAddress : customerAddress);
    if (!pickup || pickup.indexOf(',') === -1) throw new Error('Fleetbase needs a pickup address.');
    if (!dropoff || dropoff.indexOf(',') === -1) throw new Error('Fleetbase needs a delivery address.');
    const hops = Array.isArray(order.networkWaypoints) ? order.networkWaypoints : [];
    const waypoints = returning
        ? []
        : hops
              .map((hub) => (hub && hub.name && hub.address ? fleetbasePlaceText(hub.name, hub.address) : ''))
              .filter(Boolean);
    const items = (order.items || []).map((it) => ({
        name: String(it.title || it.bookTitle || it.book_id || 'Book').slice(0, 120),
        description: order.orderCode,
        currency: 'INR',
        price: Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0
    }));
    if (!items.length) {
        items.push({
            name: 'Book order ' + order.orderCode,
            description: order.orderCode,
            currency: 'INR',
            price: Number(order.totalAmount) || 0
        });
    }
    const openBox = !!(order.openBox || fleet.openBoxDelivery);
    const noteParts = [];
    if (openBox) noteParts.push('Open the box with the customer before completing delivery.');
    const deliveryNote = String(order.deliveryNote || '').replace(/\s+/g, ' ').trim();
    if (deliveryNote) noteParts.push(deliveryNote.slice(0, 240));
    const customer = {
        name: returning ? storeName : customerName,
        phone: String(returning ? cfg.storePhone || '' : order.shippingPhone || order.buyerPhone || '').trim()
    };
    const email = String(order.buyerEmail || '').trim();
    if (!returning && /@/.test(email)) customer.email = email;
    const body = {
        internal_id: order.orderCode,
        pickup,
        dropoff,
        customer,
        notes: noteParts.join(' ').slice(0, 500),
        dispatch: false,
        pod_required: true,
        pod_method: openBox ? 'photo' : 'scan',
        meta: {
            courier_partner: COURIER_PARTNER_NAME,
            gogate_order: order.orderCode,
            open_box_delivery: openBox,
            barcode_scan: true,
            fulfillment: order.commerceMode === 'hyperlocal' ? 'hyperlocal' : 'logistics',
            return_or_replacement: returning ? order.returnKind || 'return' : ''
        },
        entities: items
    };
    const awb = String(order.commerceAwb || '').trim();
    if (/^[1-9]\d{11}$/.test(awb)) body.meta.awb = awb;
    if (order.fragile) body.meta.fragile = true;
    if (order.heavy) body.meta.heavy = true;
    if (order.cod || /^(cod|cash_on_delivery)$/i.test(String(order.paymentMode || ''))) {
        body.meta.cod = true;
        const codAmount = Number(order.codAmount != null ? order.codAmount : order.totalAmount);
        if (Number.isFinite(codAmount) && codAmount > 0) body.meta.cod_amount = codAmount;
    }
    if (order.pickupAtMs) body.meta.expected_pickup_at = new Date(order.pickupAtMs).toISOString();
    if (order.dropAtMs) body.meta.expected_delivery_at = new Date(order.dropAtMs).toISOString();
    if (waypoints.length) body.waypoints = waypoints;
    if (fleet.orderType) body.type = fleet.orderType;
    if (order.dropAtMs) body.scheduled_at = new Date(order.dropAtMs).toISOString();
    return body;
}

function unwrapFleetbaseOrder(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.id && (body.status || body.tracking_number || body.payload || body.internal_id)) return body;
    if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return unwrapFleetbaseOrder(body.data);
    return body.id ? body : null;
}

function fleetbaseTrackingNo(order) {
    const tracking = order && order.tracking_number;
    if (!tracking) return '';
    if (typeof tracking === 'string') return tracking.trim();
    const number = tracking.tracking_number || tracking.number || '';
    return String(number || '').trim();
}

function fleetbaseKind(status) {
    const s = String(status || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!s) return 'update';
    if (s === 'created' || s === 'pending') return 'pickup_scheduled';
    if (s === 'dispatched') return 'agent_assigned';
    if (s === 'started' || s === 'enroute' || s === 'driver_enroute' || s === 'driver_enroute_to_pickup') return 'to_store';
    if (s === 'arrived_at_pickup') return 'at_pickup';
    if (s === 'items_loaded' || s === 'picked_up') return 'picked_up';
    if (s === 'in_transit' || s === 'arrived_at_hub') return 'arrived_facility';
    if (s === 'out_for_delivery' || s === 'driver_enroute_to_dropoff' || s === 'arrived_at_dropoff') return 'out_for_delivery';
    if (s === 'completed' || s === 'delivered') return 'delivered';
    if (s === 'canceled' || s === 'cancelled') return 'cancel';
    if (s === 'failed' || s === 'attempt_failed') return 'failed';
    return 'update';
}

function fleetbaseNamedPlace(row) {
    if (!row || typeof row !== 'object') return '';
    const candidates = [row.place_name, row.hub_name, row.hub, row.place, row.location_name, row.facility, row.name];
    if (row.waypoint && typeof row.waypoint === 'object') candidates.push(row.waypoint.name);
    if (row.location && typeof row.location === 'object') candidates.push(row.location.name);
    for (let i = 0; i < candidates.length; i++) {
        const name = String(candidates[i] || '').replace(/\s+/g, ' ').trim();
        if (!name || name.length > 80) continue;
        if (/^\d{6}$/.test(name)) continue;
        if (/\b\d{6}\b/.test(name) && /,/.test(name)) continue;
        return name;
    }
    const detail = String(row.details || row.status || '').replace(/\s+/g, ' ').trim();
    const match = detail.match(/^arrived at\s+(.+)$/i);
    if (!match) return '';
    const name = match[1].replace(/[.]+$/, '').trim();
    if (!name || name.length > 80 || /^\d{6}$/.test(name)) return '';
    return name;
}

function fleetbaseHubArrivals(order) {
    const payload = order && order.payload && typeof order.payload === 'object' ? order.payload : {};
    const skip = new Set(
        [payload.pickup && payload.pickup.name, payload.dropoff && payload.dropoff.name]
            .filter(Boolean)
            .map((name) => String(name).toLowerCase())
    );
    const rows = []
        .concat(Array.isArray(order.tracking_statuses) ? order.tracking_statuses : [])
        .concat(Array.isArray(payload.waypoints) ? payload.waypoints : []);
    const arrivals = [];
    const seen = new Set();
    rows.forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const code = String(row.code || row.status || row.status_code || '').toLowerCase();
        const arrived = /arriv/.test(code) || /^arrived at\b/i.test(String(row.details || ''));
        if (!arrived) return;
        const name = fleetbaseNamedPlace(row);
        if (!name || skip.has(name.toLowerCase()) || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        arrivals.push({
            name,
            city: String(row.city || '').trim(),
            at: row.updated_at || row.created_at || row.completed_at || null
        });
    });
    return arrivals;
}

function fleetbaseHubPhrases(order) {
    const rows = Array.isArray(order && order.tracking_statuses) ? order.tracking_statuses : [];
    const events = [];
    const seen = new Set();
    rows.forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const title = String(row.status || row.details || '')
            .replace(/\s+/g, ' ')
            .trim();
        const received = /^shipment received at\s+\S/i.test(title);
        const left = /^shipment left\s+\S/i.test(title);
        if (!received && !left) return;
        const key = title.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        events.push({
            title,
            kind: received ? 'arrived_facility' : 'left_facility',
            city: String(row.city || '').trim(),
            detail: '',
            at: row.updated_at || row.created_at || null
        });
    });
    return events;
}

function fleetbaseOtps(order) {
    const meta = order && order.meta && typeof order.meta === 'object' ? order.meta : {};
    let pickupOtp = otpFromNamed(meta, 'pickup', false);
    let deliveryOtp = otpFromNamed(meta, 'delivery', false);
    const proofs = []
        .concat(Array.isArray(order.proofs) ? order.proofs : [])
        .concat(order.payload && Array.isArray(order.payload.proofs) ? order.payload.proofs : []);
    proofs.forEach((proof) => {
        if (!proof || typeof proof !== 'object') return;
        const label = String(proof.type || proof.method || proof.pod_method || proof.name || '');
        if (/pincode|postal/i.test(label)) return;
        let raw = proof.verification_code;
        if (proof.otp != null) raw = proof.otp;
        else if (proof.code != null && /otp|sms/i.test(label)) raw = proof.code;
        const hit = otpDigits(raw);
        if (!hit) return;
        if (/pick/i.test(label) && !/deliver|drop/i.test(label)) pickupOtp = pickupOtp || hit;
        else deliveryOtp = deliveryOtp || hit;
    });
    const statuses = Array.isArray(order.tracking_statuses) ? order.tracking_statuses : [];
    statuses.forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const code = String(row.code || row.status || '');
        const hit = otpFromNamed(row, /pick/i.test(code) ? 'pickup' : 'delivery', true);
        if (!hit) return;
        if (/pick/i.test(code) && !/deliver|drop/i.test(code)) pickupOtp = pickupOtp || hit;
        else if (/deliver|drop|complet/i.test(code)) deliveryOtp = deliveryOtp || hit;
    });
    return { pickupOtp, deliveryOtp };
}

function fleetbaseOrderToUpdate(payload, mode) {
    const order = unwrapFleetbaseOrder(payload);
    if (!order) return null;
    const hyper = mode === 'hyperlocal';
    const status = String(order.status || '').trim();
    let kind = fleetbaseKind(status);
    const cancelOrder = kind === 'cancel';
    if (cancelOrder) kind = 'update';
    if (!hyper && (kind === 'out_for_delivery' || kind === 'delivered')) kind = 'arrived_facility';
    const arrivals = fleetbaseHubArrivals(order);
    const latestHub = arrivals.length ? arrivals[arrivals.length - 1] : null;
    let title = KIND_TITLES[kind] || 'Shipment update';
    let city = '';
    if (kind === 'arrived_facility' && latestHub) {
        title = 'Arrived at ' + latestHub.name;
        city = latestHub.city || '';
    } else if (kind === 'arrived_facility') {
        title = 'Item arrived at courier facility';
    } else if (status.toLowerCase() === 'arrived_at_dropoff') {
        title = 'Delivery partner reached your location';
    }
    const driver = order.driver_assigned && typeof order.driver_assigned === 'object' ? order.driver_assigned : null;
    const loc = driver && driver.location && typeof driver.location === 'object' ? driver.location : null;
    const locAt = loc ? isoInstant(loc.updated_at || loc.updatedAt) : null;
    const lat = loc ? numOrNull(loc.latitude != null ? loc.latitude : loc.lat) : null;
    const lng = loc ? numOrNull(loc.longitude != null ? loc.longitude : loc.lng) : null;
    const otps = fleetbaseOtps(order);
    const trackingNo = fleetbaseTrackingNo(order);
    const events = (kind === 'arrived_facility' && latestHub ? arrivals.slice(0, -1) : arrivals)
        .map((hub) => ({
            title: 'Arrived at ' + hub.name,
            kind: 'arrived_facility',
            city: hub.city || '',
            detail: '',
            at: hub.at || null
        }))
        .concat(fleetbaseHubPhrases(order));
    return {
        provider: 'fleetbase',
        kind,
        title,
        detail: '',
        city,
        skipEvent: kind === 'update' && !cancelOrder,
        cancelOrder,
        agentName: hyper && driver && driver.name ? String(driver.name) : null,
        agentPhone: hyper && driver && (driver.phone || driver.mobile) ? String(driver.phone || driver.mobile) : null,
        agentLat: hyper && locAt && lat != null ? lat : null,
        agentLng: hyper && locAt && lng != null ? lng : null,
        trackingNo: trackingNo || null,
        stage: stageFromKind(kind, mode),
        liveLeg: liveLegFor(kind, mode),
        at: locAt || order.updated_at || null,
        fleetbaseOrderId: order.id != null ? String(order.id) : '',
        referenceId: String(order.internal_id || '').trim(),
        externalTaskId: order.id != null ? String(order.id) : null,
        rawStatus: status || null,
        pickupOtp: otps.pickupOtp,
        deliveryOtp: otps.deliveryOtp,
        pickupAt: isoInstant(order.meta && order.meta.expected_pickup_at),
        deliveryAt: isoInstant(order.meta && order.meta.expected_delivery_at) || isoInstant(order.scheduled_at),
        events,
        openBox: !!(order.meta && order.meta.open_box_delivery)
    };
}

async function createFleetbaseOrder(cfg, order) {
    if (!cfg.fleetbase || !cfg.fleetbase.enabled) throw new Error('Fleetbase is not configured.');
    const body = buildFleetbaseOrderBody(cfg, order);
    const res = await fleetbaseRequest(cfg, 'POST', '/v1/orders', body);
    const created = unwrapFleetbaseOrder(res && res.data);
    if (!res || res.statusCode >= 400 || !created || !created.id) {
        throw new Error(fleetbaseErrorMessage(res, cfg.fleetbase.secretKey));
    }
    const update = fleetbaseOrderToUpdate(created, order.commerceMode || 'logistics');
    return {
        orderId: String(created.id),
        trackingNo: update && update.trackingNo ? update.trackingNo : '',
        pickupOtp: update && update.pickupOtp ? update.pickupOtp : '',
        deliveryOtp: update && update.deliveryOtp ? update.deliveryOtp : '',
        pickupAt: update && update.pickupAt ? update.pickupAt : null,
        deliveryAt: update && update.deliveryAt ? update.deliveryAt : null,
        events: update && update.events ? update.events : []
    };
}

async function fetchFleetbaseUpdate(cfg, order) {
    if (!cfg.fleetbase || !cfg.fleetbase.enabled || !order || !order.fleetbaseOrderId) return null;
    const res = await fleetbaseRequest(cfg, 'GET', '/v1/orders/' + encodeURIComponent(order.fleetbaseOrderId));
    if (!res || res.statusCode >= 400) throw new Error(fleetbaseErrorMessage(res, cfg.fleetbase.secretKey));
    return fleetbaseOrderToUpdate(res.data, order.commerceMode || 'logistics');
}

async function rescheduleFleetbaseDelivery(cfg, orderId, startMs) {
    if (!cfg.fleetbase || !cfg.fleetbase.enabled) throw new Error('Fleetbase is not configured.');
    if (!orderId) throw new Error('This shipment has no Fleetbase order to reschedule.');
    const wall = tookanDateTime(startMs);
    const res = await fleetbaseRequest(cfg, 'PATCH', '/v1/orders/' + encodeURIComponent(orderId) + '/schedule', {
        date: wall.slice(0, 10),
        time: wall.slice(11, 16),
        timezone: 'Asia/Kolkata'
    });
    if (!res || res.statusCode >= 400) throw new Error(fleetbaseErrorMessage(res, cfg.fleetbase.secretKey));
    return true;
}

function fleetbaseWebhookAuthorized(cfg, headerValue) {
    const expected = cfg && cfg.fleetbase && cfg.fleetbase.webhookToken;
    if (!expected) return true;
    const got = String(headerValue || '').trim();
    return got === expected || got === 'Bearer ' + expected;
}

function parseFleetbaseWebhook(body) {
    return fleetbaseOrderToUpdate(body, 'logistics');
}

// Code 128 patterns, values 0–106. Stop (106) is 13 modules.
const CODE128_BARS = [
    '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000',
    '10011000100', '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100',
    '10011001110', '10111001100', '10011101100', '10011100110', '11001110010', '11001011100', '11001001110',
    '11011100100', '11001110100', '11101101110', '11101001100', '11100101100', '11100100110', '11101100100',
    '11100110100', '11100110010', '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
    '10001000110', '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
    '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110', '11101110110',
    '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
    '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010',
    '10100110000', '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
    '10110000100', '10011010000', '10011000010', '10000110100', '10000110010', '11000010010', '11001010000',
    '11110111010', '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
    '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110', '11011110110',
    '11110110110', '10101111000', '10100011110', '10001011110', '10111101000', '10111100010', '11110101000',
    '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
    '11010011100', '1100011101011'
];

function code128Svg(value) {
    const text = String(value || '').trim();
    if (!text || !/^[\x20-\x7e]+$/.test(text)) return '';
    const codes = [104];
    for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i) - 32);
    let sum = codes[0];
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103);
    codes.push(106);
    let bits = '';
    for (let i = 0; i < codes.length; i++) bits += CODE128_BARS[codes[i]];
    const quiet = 10;
    const barH = 50;
    const width = bits.length + quiet * 2;
    let x = quiet;
    let i = 0;
    let rects = '';
    while (i < bits.length) {
        if (bits[i] === '1') {
            let w = 1;
            while (i + w < bits.length && bits[i + w] === '1') w++;
            rects += '<rect x="' + x + '" y="0" width="' + w + '" height="' + barH + '" fill="#111"/>';
            x += w;
            i += w;
        } else {
            x += 1;
            i += 1;
        }
    }
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
        width +
        ' ' +
        barH +
        '" width="100%" height="78" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="' +
        escapeHtml(text) +
        '">' +
        rects +
        '</svg>'
    );
}

function qrSvg(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    const symbol = QRCode.create(value, { errorCorrectionLevel: 'M' });
    return qrSvgTag.render(symbol, { margin: 1, width: 132, color: { dark: '#111111', light: '#ffffff' } }).trim();
}

function labelSiteBase() {
    return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org')
        .trim()
        .replace(/\/$/, '');
}

function absoluteTrackUrl(order) {
    const path = String((order && order.commerceTrackUrl) || '').trim();
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return labelSiteBase() + (path.charAt(0) === '/' ? path : '/' + path);
}

function labelSymbol(kind, caption, svg, readable) {
    if (!svg) return '';
    return (
        '<div class="sym" data-sym="' +
        kind +
        '">' +
        svg +
        '<div class="sym-cap">' +
        escapeHtml(caption) +
        '</div>' +
        (readable ? '<div class="sym-code">' + escapeHtml(readable) + '</div>' : '') +
        '</div>'
    );
}

function labelWaitingHtml(order) {
    const code = order && order.orderCode ? escapeHtml(order.orderCode) : '';
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shipping label</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#111} .box{border:2px solid #111;padding:16px;max-width:520px}</style></head><body><div class="box"><h1>Shipping label</h1><p>The shipping label is created after ' +
        escapeHtml(COURIER_PARTNER_NAME) +
        ' assigns an AWB.</p>' +
        (code ? '<p>Order <strong>' + code + '</strong></p>' : '') +
        '</div></body></html>'
    );
}

function awbFromUpdate(update) {
    if (!update) return '';
    const value = update.trackingNo || update.barcode || '';
    return String(value).trim();
}

async function fetchProviderSnapshot(cfg, order) {
    if (!cfg || !order) return null;
    if (order.commerceProvider === 'fleetbase' && order.fleetbaseOrderId && cfg.fleetbase && cfg.fleetbase.enabled) {
        const res = await fleetbaseRequest(cfg, 'GET', '/v1/orders/' + encodeURIComponent(order.fleetbaseOrderId));
        if (!res || res.statusCode >= 400) throw new Error(fleetbaseErrorMessage(res, cfg.fleetbase.secretKey));
        return fleetbaseOrderToUpdate(res.data, order.commerceMode || 'logistics');
    }
    if (order.commerceProvider === 'pidge' && order.pidgeOrderId && cfg.pidge && cfg.pidge.enabled) {
        const res = await pidgeRequest(cfg, 'GET', '/v1.0/store/channel/vendor/order/' + encodeURIComponent(order.pidgeOrderId));
        if (!res || res.statusCode >= 400) throw new Error(pidgeErrorMessage(res, cfg.pidge.password));
        return pidgePayloadToUpdate(res.data, order.commerceMode || 'logistics');
    }
    if (order.commerceProvider === 'shipday' && (order.shipdayOrderId || order.orderCode) && cfg.shipday && cfg.shipday.enabled) {
        const row = await fetchShipdayOrder(cfg, order.shipdayOrderId, order.orderCode);
        return shipdayOrderToUpdate(row);
    }
    if (order.commerceProvider === 'tookan' && order.tookanJobId && cfg.tookan && cfg.tookan.enabled) {
        if (order.commerceMode === 'logistics') return fetchTookanParcelUpdate(cfg, order);
        const pickup = await fetchTookanJob(cfg, order.tookanJobId);
        const delivery = order.tookanDeliveryJobId ? await fetchTookanJob(cfg, order.tookanDeliveryJobId) : null;
        return combineTookanUpdates(
            tookanJobToUpdate(pickup, order.commerceMode || 'hyperlocal', 'pickup'),
            delivery ? tookanJobToUpdate(delivery, order.commerceMode || 'hyperlocal', 'delivery') : null
        );
    }
    return null;
}

function labelHtml(order, cfg) {
    const lines = (order.items || [])
        .map((it) => {
            const name = it.bookTitle || it.title || it.book_id || 'Item';
            const lang = it.language ? ' · ' + it.language : '';
            return '<tr><td>' + escapeHtml(name + lang) + '</td><td>' + escapeHtml(String(it.qty || 1)) + '</td></tr>';
        })
        .join('');
    const to = [order.shippingRecipientName || order.buyerName, order.deliveryAddress, order.shippingCity, order.shippingState, order.shippingPincode]
        .filter(Boolean)
        .join('<br>');
    const from = [cfg && cfg.storeName, cfg && cfg.storeAddress, cfg && cfg.storeCity, cfg && cfg.storePhone].filter(Boolean).join('<br>');
    const orderCode = String((order && order.orderCode) || '').trim();
    const courierNo = String((order && order.courierTrackingNo) || '').trim();
    if (!courierNo) return labelWaitingHtml(order);
    const showCourier = courierNo !== orderCode;
    const showOtp =
        order.commerceProvider !== 'shipday' &&
        order.commerceProvider !== 'pidge' &&
        order.commerceProvider !== 'fleetbase' &&
        (order.pickupOtp || order.deliveryOtp);
    const codes =
        '<div class="sym-row">' +
        labelSymbol('order-qr', 'Order QR', qrSvg(orderCode), orderCode) +
        (showCourier ? labelSymbol('courier-qr', 'Courier QR', qrSvg(courierNo), courierNo) : '') +
        '</div><div class="bars">' +
        labelSymbol('order-barcode', 'Order barcode', code128Svg(orderCode), orderCode) +
        (showCourier ? labelSymbol('courier-barcode', 'Courier barcode', code128Svg(courierNo), courierNo) : '') +
        '</div>';
    const statuses = require('./shipment-engine').customerStatuses(order);
    const statusList =
        '<ol class="label-steps">' +
        statuses
            .map(
                (step) =>
                    '<li data-status="' +
                    escapeHtml(step.key) +
                    '"><b>' +
                    escapeHtml(step.title) +
                    '</b>' +
                    (step.expectedLabel ? '<div class="expect">' + escapeHtml(step.expectedLabel) + '</div>' : '') +
                    '</li>'
            )
            .join('') +
        '</ol>';
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Label ' +
        escapeHtml(orderCode) +
        '</title><style>body{font-family:Arial,sans-serif;margin:16px;color:#111} .box{border:2px solid #111;padding:14px;max-width:560px} h1{font-size:22px;margin:0 0 8px} table{width:100%;border-collapse:collapse;margin-top:12px} td{border-top:1px solid #ccc;padding:6px 0} .otp{font-size:20px;font-weight:800;letter-spacing:2px} .sym-row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin:8px 0} .sym svg{display:block;background:#fff} .sym-cap{font-size:11px;font-weight:700;margin-top:4px;letter-spacing:.04em;text-transform:uppercase} .sym-code{font-size:13px;font-weight:800;letter-spacing:1px;word-break:break-all} .bars .sym{margin:8px 0 4px} .bars svg{width:100%;height:78px} .label-steps{margin:12px 0 0;padding:0 0 0 18px} .label-steps li{margin:4px 0} .label-steps .expect{font-size:12px;color:#333;margin-top:2px} button{margin:0 0 10px;padding:8px 14px;font-weight:700} @media print{body{margin:0} .noprint{display:none!important} .box{max-width:none}}</style></head><body><div class="box"><button class="noprint" type="button" onclick="window.print()">Print</button><h1>Shipping label</h1><p><strong>' +
        escapeHtml(orderCode) +
        '</strong> · ' +
        escapeHtml(COURIER_PARTNER_NAME) +
        (order.commerceMode ? ' · ' + escapeHtml(order.commerceMode) : '') +
        '</p>' +
        (order.openBox ? '<p><strong>Open box delivery</strong></p>' : '') +
        codes +
        '<p><strong>From</strong><br>' +
        from +
        '</p><p><strong>To</strong><br>' +
        (to || '—') +
        '</p>' +
        (showOtp
            ? '<p>' +
              (order.pickupOtp ? 'Pickup OTP <span class="otp">' + escapeHtml(order.pickupOtp) + '</span><br>' : '') +
              (order.deliveryOtp ? 'Delivery OTP <span class="otp">' + escapeHtml(order.deliveryOtp) + '</span>' : '') +
              '</p>'
            : '') +
        statusList +
        '<table>' +
        lines +
        '</table>' +
        '</div><script>window.print&&setTimeout(function(){window.print()},300)</script></body></html>'
    );
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    CONFIG_KEY,
    STAGES,
    columnAlters,
    deliveryAttemptsSql,
    requestJson,
    normalizeCommerceConfig,
    normalizeShop,
    withinIstWindow,
    istMinutesNow,
    publicConfigView,
    mergeConfigSecrets,
    phraseLogisticsUpdate,
    mapTookanStatus,
    mapShipdayStatus,
    stageFromKind,
    liveLegFor,
    COURIER_PARTNER_NAME,
    isDeskNoise,
    generateOtp,
    generateToken,
    buildTookanTaskBody,
    buildTookanParcelBody,
    fetchTookanHubs,
    parseTookanHubPayload,
    tookanHubUsable,
    tookanAreaRequirements,
    tookanHubGapMessage,
    tookanHubReach,
    parcelJourneyUpdate,
    tookanParcelJourney,
    fetchTookanParcelUpdate,
    createTookanParcel,
    tookanOtpsFromJob,
    buildShipdayOrderBody,
    tookanDateTime,
    rescheduleTookanDelivery,
    rescheduleShipdayDelivery,
    trackPath,
    mapCommerceRow,
    customerTrackView,
    createTookanTask,
    fetchTookanJob,
    tookanJobToUpdate,
    combineTookanUpdates,
    tookanTaskUpdate,
    tookanJobType,
    KIND_TITLES,
    createShipdayOrder,
    selectShipdayOrder,
    fetchShipdayOrder,
    fetchShipdayCarrierPoint,
    shipdayOrderToUpdate,
    parseTookanWebhook,
    parseShipdayWebhook,
    buildPidgeOrderBody,
    createPidgeOrder,
    pidgeFulfillmentKind,
    pidgePayloadToUpdate,
    unwrapPidgePayload,
    fetchPidgeUpdate,
    pidgeWebhookAuthorized,
    parsePidgeWebhook,
    parseFleetbaseHubs,
    buildFleetbaseOrderBody,
    fleetbaseKind,
    fleetbaseOrderToUpdate,
    unwrapFleetbaseOrder,
    createFleetbaseOrder,
    fetchFleetbaseUpdate,
    rescheduleFleetbaseDelivery,
    fleetbaseWebhookAuthorized,
    parseFleetbaseWebhook,
    geocodeAddress,
    code128Svg,
    qrSvg,
    awbFromUpdate,
    fetchProviderSnapshot,
    labelWaitingHtml,
    labelHtml
};

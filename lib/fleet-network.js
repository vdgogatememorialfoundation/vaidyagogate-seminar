/**
 * Gogate hub network. A hub is a sorting location staff create.
 * The seller store is never turned into a hub, and missing hops are omitted.
 */
const crypto = require('crypto');
const https = require('https');
const shipmentEngine = require('./shipment-engine');

const ROLES = ['seller_local', 'city_mother', 'transit', 'destination_city', 'delivery_local'];
const MODES = ['logistics', 'hyperlocal', 'both'];
const STAFF_STATUSES = ['active', 'blocked', 'disabled'];

function norm(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isAwb(value) {
    const s = String(value || '').trim();
    return /^\d{12}$/.test(s) && s.charAt(0) !== '0';
}

function newAwb() {
    return String(crypto.randomInt(100000000000, 1000000000000));
}

function newCode(digits) {
    const n = Math.max(4, Math.min(8, digits || 6));
    const max = 10 ** n;
    return String(crypto.randomInt(0, max)).padStart(n, '0');
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return salt + ':' + hash;
}

function verifyPassword(password, stored) {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2 || !/^[0-9a-f]+$/i.test(parts[0]) || !/^[0-9a-f]+$/i.test(parts[1])) return false;
    const next = crypto.scryptSync(String(password), parts[0], 32);
    const prev = Buffer.from(parts[1], 'hex');
    if (next.length !== prev.length) return false;
    return crypto.timingSafeEqual(next, prev);
}

function sessionToken() {
    return crypto.randomBytes(24).toString('hex');
}

function receivedLine(hub) {
    return 'Shipment Received at ' + clean(hub.name) + '- ' + clean(hub.city) + ' ' + clean(hub.state) + ', ' + clean(hub.country);
}

function leftLine(hub) {
    return 'Shipment Left ' + clean(hub.name) + '- ' + clean(hub.city) + ' ' + clean(hub.state) + ', ' + clean(hub.country);
}

function hubActive(hub, mode) {
    if (!hub) return false;
    if (hub.active === 0 || hub.active === false || hub.active === '0') return false;
    const m = hub.mode || 'both';
    if (m !== 'both' && mode && m !== mode) return false;
    return !!(clean(hub.name) && clean(hub.address));
}

function sameCity(hub, place) {
    return !!norm(hub && hub.city) && norm(hub.city) === norm(place && place.city);
}

function localityHit(hub, place) {
    const loc = norm(hub && hub.locality);
    const pin = String((hub && hub.pincode) || '').replace(/\D/g, '');
    const placePin = String((place && place.pincode) || '').replace(/\D/g, '');
    if (pin && placePin && pin === placePin && sameCity(hub, place)) return true;
    if (!loc) return false;
    const blob = norm([place && place.locality, place && place.address, place && place.city].filter(Boolean).join(' '));
    return blob.length > 0 && (' ' + blob + ' ').indexOf(' ' + loc + ' ') !== -1;
}

function pickHub(list, role, place, mode) {
    return (
        (list || []).find((hub) => hub.role === role && hubActive(hub, mode) && sameCity(hub, place) && (role === 'city_mother' || role === 'destination_city' || localityHit(hub, place))) ||
        null
    );
}

function planRoute(hubs, seller, drop, mode) {
    const useMode = mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
    const list = (hubs || []).filter((hub) => hubActive(hub, useMode));
    const sellerLocal = pickHub(list, 'seller_local', seller, useMode);
    const mother = pickHub(list, 'city_mother', seller, useMode);
    const differentCity = norm(drop && drop.city) && norm(drop.city) !== norm(seller && seller.city);
    const transits = differentCity
        ? list.filter((hub) => hub.role === 'transit' && norm(hub.from_city) === norm(seller && seller.city) && norm(hub.to_city) === norm(drop && drop.city))
        : [];
    const destination = differentCity ? pickHub(list, 'destination_city', drop, useMode) : null;
    const deliveryLocal = pickHub(list, 'delivery_local', drop, useMode);
    const hops = [];
    [sellerLocal, mother].concat(transits, [destination, deliveryLocal]).forEach((hub) => {
        if (!hub || !hub.name || !hub.address) return;
        if (hops.some((row) => String(row.id) === String(hub.id))) return;
        hops.push({
            id: hub.id,
            name: clean(hub.name),
            locality: clean(hub.locality),
            city: clean(hub.city),
            state: clean(hub.state),
            country: clean(hub.country),
            address: clean(hub.address),
            pincode: String(hub.pincode || '').replace(/\D/g, '').slice(0, 6),
            role: hub.role
        });
    });
    return hops;
}

function sellerPlace(cfg) {
    return {
        locality: '',
        city: clean(cfg && cfg.storeCity),
        state: clean(cfg && cfg.storeState),
        country: clean(cfg && cfg.storeCountry) || '',
        pincode: String((cfg && cfg.storePincode) || '').replace(/\D/g, '').slice(0, 6),
        address: clean(cfg && cfg.storeAddress)
    };
}

function dropPlace(order) {
    return {
        locality: '',
        city: clean(order && (order.shippingCity || order.shipping_city)),
        state: clean(order && (order.shippingState || order.shipping_state)),
        country: '',
        pincode: String((order && (order.shippingPincode || order.shipping_pincode)) || '').replace(/\D/g, '').slice(0, 6),
        address: clean(order && (order.deliveryAddress || order.delivery_address))
    };
}

function scanMatches(awb, scanned) {
    const code = String(scanned || '').replace(/\s+/g, '');
    return isAwb(awb) && code === String(awb);
}

function needsOpenBox(order) {
    if (!order) return false;
    return !!(order.fragile || order.heavy || order.openBox || order.commerce_fragile || order.commerce_heavy || order.commerce_open_box);
}

function phoneLast4(order) {
    const digits = String((order && (order.shippingPhone || order.buyerPhone || order.shipping_phone || order.buyer_phone)) || '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : '';
}

function obdAnswersOk(order, body) {
    if (!needsOpenBox(order)) return { ok: true };
    const input = body && typeof body === 'object' ? body : {};
    const damagedRaw = input.damaged;
    if (damagedRaw !== true && damagedRaw !== false && damagedRaw !== 'yes' && damagedRaw !== 'no') {
        return { ok: false, error: 'Answer whether the item is damaged.' };
    }
    const expected = phoneLast4(order);
    if (!expected || String(input.mobileLast4 || '').replace(/\D/g, '') !== expected) {
        return { ok: false, error: 'The last 4 digits of the customer mobile do not match.' };
    }
    const otp = String(order.obdOtp || order.commerce_obd_otp || '');
    if (!/^\d{6}$/.test(otp) || String(input.obdOtp || '').trim() !== otp) {
        return { ok: false, error: 'The open-box OTP does not match the code emailed to the customer.' };
    }
    return { ok: true, damaged: damagedRaw === true || damagedRaw === 'yes' };
}

function scheduleWindow(shop, nowMs) {
    const slots = shipmentEngine.deliverySlots(shop, nowMs || Date.now());
    if (!slots.length) return null;
    const pickup = slots[0];
    const delivery = slots[slots.length - 1];
    return {
        pickupAt: pickup.date + 'T' + pickup.start + ':00+05:30',
        deliveryAt: delivery.date + 'T' + delivery.end + ':00+05:30',
        slots
    };
}

function plannedStopTimes(mode, provider, explicitPickupMs, shop, nowMs) {
    const now = nowMs || Date.now();
    const lead = Number(shop && shop.pickupLeadMinutes) || 30;
    const dropLead = Number(shop && shop.deliveryLeadMinutes) || 90;
    let pickupAtMs = explicitPickupMs || null;
    let dropAtMs = null;
    if (!pickupAtMs && (provider === 'fleetbase' || mode === 'logistics')) {
        const window = scheduleWindow(shop, now);
        if (window) {
            const pickup = Date.parse(window.pickupAt);
            const drop = Date.parse(window.deliveryAt);
            if (Number.isFinite(pickup)) pickupAtMs = pickup;
            if (Number.isFinite(drop)) dropAtMs = drop;
        }
    }
    if (!pickupAtMs) pickupAtMs = now + lead * 60 * 1000;
    if (!dropAtMs) dropAtMs = pickupAtMs + dropLead * 60 * 1000;
    return { pickupAtMs, dropAtMs };
}

function validateHub(body) {
    const row = body && typeof body === 'object' ? body : {};
    const hub = {
        name: clean(row.name).slice(0, 80),
        locality: clean(row.locality).slice(0, 80),
        city: clean(row.city).slice(0, 80),
        state: clean(row.state).slice(0, 80),
        country: clean(row.country).slice(0, 80),
        address: clean(row.address).slice(0, 240),
        pincode: String(row.pincode || '').replace(/\D/g, '').slice(0, 6),
        role: String(row.role || '').trim(),
        mode: MODES.includes(row.mode) ? row.mode : 'both',
        active: row.active === false || row.active === 0 || row.active === '0' ? 0 : 1,
        from_city: clean(row.fromCity || row.from_city).slice(0, 80),
        to_city: clean(row.toCity || row.to_city).slice(0, 80)
    };
    if (!hub.name || !hub.city || !hub.state || !hub.country || !hub.address || hub.pincode.length !== 6) {
        return { error: 'A hub needs a name, address, city, state, country, and 6-digit PIN.' };
    }
    if (!ROLES.includes(hub.role)) return { error: 'Choose a hub role.' };
    if ((hub.role === 'seller_local' || hub.role === 'delivery_local') && !hub.locality) {
        return { error: 'A local hub needs the locality it serves.' };
    }
    if (hub.role === 'transit' && (!hub.from_city || !hub.to_city)) {
        return { error: 'A transit hub needs the city it leaves and the city it reaches.' };
    }
    return { hub };
}

function schemaSql(isPg) {
    const id = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const stamp = isPg ? 'TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP' : 'TEXT DEFAULT CURRENT_TIMESTAMP';
    return [
        `CREATE TABLE IF NOT EXISTS commerce_hubs (
            id ${id}, name TEXT NOT NULL, locality TEXT, city TEXT NOT NULL, state TEXT NOT NULL,
            country TEXT NOT NULL, address TEXT NOT NULL, pincode TEXT NOT NULL, role TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'both', active INTEGER NOT NULL DEFAULT 1,
            from_city TEXT, to_city TEXT, created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_hub_staff (
            id ${id}, hub_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
            password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', role TEXT NOT NULL DEFAULT 'agent',
            created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_hub_sessions (
            id ${id}, token TEXT NOT NULL, staff_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_bags (
            id ${id}, hub_id INTEGER NOT NULL, code TEXT NOT NULL, trip_id INTEGER, status TEXT NOT NULL DEFAULT 'open',
            mode TEXT NOT NULL DEFAULT 'logistics', created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_trips (
            id ${id}, from_hub_id INTEGER NOT NULL, to_hub_id INTEGER NOT NULL, driver_id INTEGER,
            status TEXT NOT NULL DEFAULT 'planned', mode TEXT NOT NULL DEFAULT 'logistics', created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_runsheets (
            id ${id}, hub_id INTEGER NOT NULL, agent_id INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'logistics',
            status TEXT NOT NULL DEFAULT 'open', service_date TEXT, created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_runsheet_orders (
            id ${id}, runsheet_id INTEGER NOT NULL, order_id INTEGER NOT NULL, leg TEXT NOT NULL DEFAULT 'forward', created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_scans (
            id ${id}, order_id INTEGER NOT NULL, hub_id INTEGER, agent_id INTEGER, kind TEXT NOT NULL,
            barcode TEXT NOT NULL, leg TEXT NOT NULL DEFAULT 'forward', created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_hl_offers (
            id ${id}, order_id INTEGER NOT NULL, hub_id INTEGER NOT NULL, agent_id INTEGER,
            status TEXT NOT NULL DEFAULT 'offered', created_at ${stamp}
        )`,
        `CREATE TABLE IF NOT EXISTS commerce_delivery_slots (
            id ${id}, hub_id INTEGER, service_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'both', created_at ${stamp}
        )`
    ];
}

function ensureSchema(db, isPg, cb) {
    const sqls = schemaSql(!!isPg);
    let i = 0;
    const next = () => {
        if (i >= sqls.length) return cb && cb();
        db.run(sqls[i++], [], () => next());
    };
    next();
}

function issueAwb(db, orderId, cb) {
    db.get(`SELECT id, commerce_awb FROM book_orders WHERE id = ?`, [orderId], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(new Error('Order not found'));
        const write = (awb) => {
            db.run(
                `UPDATE book_orders SET commerce_awb = ?, courier_tracking_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [awb, awb, orderId],
                (e2) => cb(e2, awb)
            );
        };
        if (isAwb(row.commerce_awb)) return write(String(row.commerce_awb));
        const attempt = (left) => {
            const awb = newAwb();
            db.get(`SELECT id FROM book_orders WHERE commerce_awb = ? AND id <> ?`, [awb, orderId], (e3, hit) => {
                if (e3) return cb(e3);
                if (hit) {
                    if (left <= 0) return cb(new Error('Could not assign a unique AWB.'));
                    return attempt(left - 1);
                }
                write(awb);
            });
        };
        attempt(5);
    });
}

function prepareFleetbaseShipment(db, orderId, shop, cb) {
    issueAwb(db, orderId, (err) => {
        if (err) return cb(err);
        const window = scheduleWindow(shop, Date.now());
        if (!window) return cb(null);
        db.run(
            `UPDATE book_orders SET commerce_pickup_at = COALESCE(commerce_pickup_at, ?), commerce_delivery_at = COALESCE(commerce_delivery_at, ?) WHERE id = ?`,
            [window.pickupAt, window.deliveryAt, orderId],
            (e2) => cb(e2)
        );
    });
}

function parseRoute(raw) {
    if (!raw) return [];
    try {
        const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

function assignRoute(db, order, cfg, leg, cb) {
    db.all(`SELECT * FROM commerce_hubs`, [], (err, hubs) => {
        if (err) return cb(err);
        const seller = sellerPlace(cfg);
        const drop = dropPlace(order);
        const forward = leg !== 'return';
        const route = planRoute(hubs || [], forward ? seller : drop, forward ? drop : seller, 'logistics');
        db.run(
            `UPDATE book_orders SET commerce_route_json = ?, commerce_route_index = 0, commerce_hop_phase = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(route), route.length ? 'expect_receive' : '', order.id],
            (e2) => cb(e2, route)
        );
    });
}

function offerHyperlocal(db, order, cfg, cb) {
    const seller = sellerPlace(cfg);
    db.all(`SELECT * FROM commerce_hubs WHERE active = 1`, [], (err, hubs) => {
        if (err) return cb(err);
        const matches = (hubs || []).filter((hub) => hubActive(hub, 'hyperlocal') && sameCity(hub, seller));
        if (!matches.length) {
            db.run(`UPDATE book_orders SET commerce_hyperlocal_status = 'unassigned' WHERE id = ?`, [order.id], () => cb(null, []));
            return;
        }
        let left = matches.length;
        matches.forEach((hub) => {
            db.run(
                `INSERT INTO commerce_hl_offers (order_id, hub_id, status) VALUES (?, ?, 'offered')`,
                [order.id, hub.id],
                () => {
                    left -= 1;
                    if (!left) {
                        db.run(`UPDATE book_orders SET commerce_hyperlocal_status = 'offered' WHERE id = ?`, [order.id], () => cb(null, matches));
                    }
                }
            );
        });
    });
}

function requestJson(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: target.pathname + target.search,
                method,
                headers: Object.assign({ Accept: 'application/json' }, headers, payload ? { 'Content-Length': payload.length, 'Content-Type': 'application/json' } : {})
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try {
                        data = raw ? JSON.parse(raw) : null;
                    } catch (_) {
                        data = null;
                    }
                    resolve({ statusCode: res.statusCode, data, raw: raw.slice(0, 300) });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function createRazorpayQr(keys, order) {
    const amount = Math.round(Number(order.codAmount != null ? order.codAmount : order.totalAmount) * 100);
    if (!keys || !keys.key_id || !keys.key_secret) {
        const error = new Error('Razorpay live keys are not configured.');
        error.status = 400;
        throw error;
    }
    if (!Number.isFinite(amount) || amount < 100) {
        const error = new Error('This COD order has no amount to collect.');
        error.status = 400;
        throw error;
    }
    const auth = Buffer.from(keys.key_id + ':' + keys.key_secret).toString('base64');
    const res = await requestJson(
        'POST',
        'https://api.razorpay.com/v1/payments/qr_codes',
        { Authorization: 'Basic ' + auth },
        {
            type: 'upi_qr',
            name: ('Order ' + (order.orderCode || order.id)).slice(0, 40),
            usage: 'single_use',
            fixed_amount: true,
            payment_amount: amount,
            description: 'COD ' + (order.orderCode || ''),
            notes: { order_code: String(order.orderCode || '') }
        }
    );
    if (!res || res.statusCode >= 400 || !res.data || !res.data.id) {
        const error = new Error('Razorpay could not create a QR for this order.');
        error.status = 502;
        throw error;
    }
    return {
        id: res.data.id,
        imageUrl: res.data.image_url || '',
        amountReceived: Number(res.data.payments_amount_received) || 0,
        status: res.data.status || ''
    };
}

async function fetchRazorpayQr(keys, qrId) {
    if (!keys || !keys.key_id || !keys.key_secret || !qrId) return null;
    const auth = Buffer.from(keys.key_id + ':' + keys.key_secret).toString('base64');
    const res = await requestJson('GET', 'https://api.razorpay.com/v1/payments/qr_codes/' + encodeURIComponent(qrId), {
        Authorization: 'Basic ' + auth
    });
    if (!res || res.statusCode >= 400 || !res.data) return null;
    return {
        id: res.data.id,
        imageUrl: res.data.image_url || '',
        amountReceived: Number(res.data.payments_amount_received) || 0,
        paymentAmount: Number(res.data.payment_amount) || 0,
        status: res.data.status || ''
    };
}

function slotsForHub(shop, rows, nowMs) {
    const defaults = shipmentEngine.deliverySlots(shop, nowMs || Date.now());
    const extra = (rows || [])
        .filter((row) => row && row.enabled !== 0 && row.enabled !== false)
        .map((row) => ({
            date: row.service_date,
            start: row.start_time,
            end: row.end_time,
            label: row.service_date + ', ' + row.start_time + ' – ' + row.end_time,
            source: 'hub',
            id: row.id
        }));
    const closed = new Set(
        (rows || [])
            .filter((row) => row && (row.enabled === 0 || row.enabled === false))
            .map((row) => row.service_date + '|' + row.start_time + '|' + row.end_time)
    );
    return defaults
        .filter((slot) => !closed.has(slot.date + '|' + slot.start + '|' + slot.end))
        .concat(extra);
}

module.exports = {
    ROLES,
    MODES,
    STAFF_STATUSES,
    isAwb,
    newAwb,
    newCode,
    hashPassword,
    verifyPassword,
    sessionToken,
    receivedLine,
    leftLine,
    planRoute,
    sellerPlace,
    dropPlace,
    scanMatches,
    needsOpenBox,
    phoneLast4,
    obdAnswersOk,
    scheduleWindow,
    plannedStopTimes,
    validateHub,
    schemaSql,
    ensureSchema,
    issueAwb,
    prepareFleetbaseShipment,
    parseRoute,
    assignRoute,
    offerHyperlocal,
    createRazorpayQr,
    fetchRazorpayQr,
    slotsForHub,
    hubActive,
    sameCity
};

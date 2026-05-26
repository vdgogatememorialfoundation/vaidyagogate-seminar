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
    const assignRes = await requestJson('POST', SHIPROCKET_BASE + '/v1/external/courier/assign/awb', {
        headers: { Authorization: 'Bearer ' + token },
        body: { shipment_id: shipmentId }
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
    return {
        awb: String(awb).trim(),
        shipmentId: String(shipmentId),
        aggregatorOrderId: String(createData.order_id || createData.channel_order_id || order.orderCode || ''),
        courierName: inner.courier_name || assignData.courier_name || 'Shiprocket',
        courierProvider: String(inner.courier_name || 'shiprocket').toLowerCase().replace(/\s+/g, '_'),
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
            return {
                awb: String(awb).trim(),
                shipmentId: String(d.shipment_id || d.id || ''),
                aggregatorOrderId: String(d.order_id || d.order_number || order.orderCode || ''),
                courierName: d.courier_name || d.courier || 'Nimbuspost',
                courierProvider: 'nimbuspost',
                source: 'nimbuspost',
                raw: d
            };
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('Nimbuspost booking failed — check API credentials or create shipment in Nimbuspost dashboard.');
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
    trackNimbuspost,
    bookShiprocketShipment,
    bookNimbuspostShipment
};

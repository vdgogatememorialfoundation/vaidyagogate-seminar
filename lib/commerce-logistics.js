/**
 * Tookan (logistics + hyperlocal) and Shipday (hyperlocal) for book commerce.
 * API keys live in global_settings (commerce_logistics_config), same pattern as other logistics keys.
 */
const https = require('https');
const crypto = require('crypto');

const CONFIG_KEY = 'commerce_logistics_config';
const TOOKAN_BASE = 'https://api.tookanapp.com/v2';
const SHIPDAY_BASE = 'https://api.shipday.com';

const COMMERCE_COLUMNS = [
    ['commerce_provider', 'TEXT'],
    ['commerce_mode', 'TEXT'],
    ['commerce_stage', 'TEXT'],
    ['pickup_otp', 'TEXT'],
    ['delivery_otp', 'TEXT'],
    ['tookan_job_id', 'TEXT'],
    ['tookan_tracking_link', 'TEXT'],
    ['shipday_order_id', 'TEXT'],
    ['shipday_tracking_link', 'TEXT'],
    ['agent_name', 'TEXT'],
    ['agent_phone', 'TEXT'],
    ['agent_lat', 'REAL'],
    ['agent_lng', 'REAL'],
    ['store_lat', 'REAL'],
    ['store_lng', 'REAL'],
    ['drop_lat', 'REAL'],
    ['drop_lng', 'REAL'],
    ['tracking_token', 'TEXT'],
    ['live_leg', 'TEXT']
];

const STAGES = ['placed', 'accepted', 'preparing', 'ready', 'pickup_scheduled', 'in_transit', 'out_for_delivery', 'delivered'];

function columnAlters(isPg) {
    return COMMERCE_COLUMNS.map(([name, type]) =>
        isPg
            ? `ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS ${name} ${type}`
            : `ALTER TABLE book_orders ADD COLUMN ${name} ${type}`
    );
}

function requestJson(method, url, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
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
                'User-Agent': 'VGMF-Seminar-Commerce/1.0',
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

function normalizeCommerceConfig(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const tookan = c.tookan && typeof c.tookan === 'object' ? c.tookan : {};
    const shipday = c.shipday && typeof c.shipday === 'object' ? c.shipday : {};
    const tookanKey = String(tookan.apiKey || process.env.TOOKAN_API_KEY || '').trim();
    const shipdayKey = String(shipday.apiKey || process.env.SHIPDAY_API_KEY || '').trim();
    const mapsKey = String(c.mapsApiKey || process.env.GOOGLE_MAPS_API_KEY || '').trim();
    const mode = String(c.defaultMode || tookan.defaultMode || 'logistics').toLowerCase() === 'hyperlocal' ? 'hyperlocal' : 'logistics';
    const hyper = String(c.defaultHyperlocalProvider || 'shipday').toLowerCase() === 'tookan' ? 'tookan' : 'shipday';
    return {
        storeName: String(c.storeName || 'VGMF Book Desk').trim(),
        storePhone: String(c.storePhone || '').trim(),
        storeAddress: String(c.storeAddress || '').trim(),
        storeCity: String(c.storeCity || '').trim(),
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
        }
    };
}

function publicConfigView(cfg) {
    const c = normalizeCommerceConfig(cfg);
    const mask = (k) => (k ? '••••' + k.slice(-4) : '');
    return {
        storeName: c.storeName,
        storePhone: c.storePhone,
        storeAddress: c.storeAddress,
        storeCity: c.storeCity,
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
        }
    };
}

function mergeConfigSecrets(previous, incoming) {
    const prev = previous && typeof previous === 'object' ? previous : {};
    const next = incoming && typeof incoming === 'object' ? incoming : {};
    const tookanIn = next.tookan && typeof next.tookan === 'object' ? next.tookan : {};
    const shipIn = next.shipday && typeof next.shipday === 'object' ? next.shipday : {};
    const prevTookan = prev.tookan && typeof prev.tookan === 'object' ? prev.tookan : {};
    const prevShip = prev.shipday && typeof prev.shipday === 'object' ? prev.shipday : {};
    const keep = (incomingVal, prevVal) => {
        const s = incomingVal == null ? '' : String(incomingVal).trim();
        if (!s || s.indexOf('•') === 0) return prevVal || '';
        return s;
    };
    return normalizeCommerceConfig({
        storeName: next.storeName,
        storePhone: next.storePhone,
        storeAddress: next.storeAddress,
        storeCity: next.storeCity,
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
        }
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

    const arrived =
        /arrived at|arrival at|reached (the )?(hub|facility|warehouse|station)|received at|arrived (in|into) /.test(t) ||
        (/\barrived\b/.test(t) && /hub|facility|warehouse|station|origin/.test(t));
    const left =
        /departed|left (the )?(hub|facility|origin|warehouse|station)|dispatched from|forwarded to|in transit to next|left for next/.test(
            t
        );
    const out =
        /out for delivery|out-for-delivery|started delivery|delivery started|on the way to (customer|recipient|drop)/.test(t);
    const picked = /picked up|pickup (complete|successful|done)|collected from/.test(t);
    const delivered = /\bdelivered\b|delivery completed|successfully delivered/.test(t);

    if (delivered) {
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

function mapTookanStatus(jobStatus, text) {
    const n = parseInt(jobStatus, 10);
    const phrase = phraseLogisticsUpdate(text || tookanStatusLabel(n), {});
    if (phrase.kind !== 'update') return phrase.kind;
    if (n === 2) return 'delivered';
    if (n === 1) return 'out_for_delivery';
    if (n === 4) return 'arrived_facility';
    if (n === 7 || n === 0) return 'pickup_scheduled';
    if (n === 9 || n === 3 || n === 10) return 'failed';
    return 'update';
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

function mapShipdayStatus(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'ALREADY_DELIVERED' || s === 'DELIVERED') return 'delivered';
    if (s === 'PICKED_UP' || s === 'READY_TO_DELIVER') return 'out_for_delivery';
    if (s === 'STARTED') return 'to_store';
    if (s === 'NOT_STARTED_YET' || s === 'NOT_ACCEPTED' || s === 'NOT_ASSIGNED') return 'pickup_scheduled';
    if (s === 'FAILED_DELIVERY' || s === 'INCOMPLETE' || s === 'CANCELLED') return 'failed';
    return 'update';
}

function stageFromKind(kind, mode) {
    if (kind === 'delivered') return 'delivered';
    if (kind === 'out_for_delivery' || kind === 'picked_up') return 'out_for_delivery';
    if (kind === 'to_store') return 'pickup_scheduled';
    if (kind === 'arrived_facility' || kind === 'left_facility') return 'in_transit';
    if (kind === 'pickup_scheduled') return 'pickup_scheduled';
    if (mode === 'hyperlocal' && kind === 'update') return null;
    return null;
}

function liveLegFor(kind, mode) {
    if (mode !== 'hyperlocal') return 'none';
    if (kind === 'to_store' || kind === 'pickup_scheduled') return 'to_store';
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

function trackPath(token) {
    return '/track-commerce?token=' + encodeURIComponent(String(token || ''));
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
        pickupOtp: row.pickup_otp || null,
        deliveryOtp: row.delivery_otp || null,
        tookanJobId: row.tookan_job_id || null,
        tookanTrackingLink: row.tookan_tracking_link || null,
        shipdayOrderId: row.shipday_order_id || null,
        shipdayTrackingLink: row.shipday_tracking_link || null,
        agentName: row.agent_name || null,
        agentPhone: row.agent_phone || null,
        agentLat: numOrNull(row.agent_lat),
        agentLng: numOrNull(row.agent_lng),
        storeLat: numOrNull(row.store_lat),
        storeLng: numOrNull(row.store_lng),
        dropLat: numOrNull(row.drop_lat),
        dropLng: numOrNull(row.drop_lng),
        trackingToken: token,
        commerceTrackUrl: token ? trackPath(token) : null,
        liveLeg: row.live_leg || 'none',
        courierTrackStatus: row.courier_track_status || null,
        courierTrackLabel: row.courier_track_label || null,
        items: items || []
    };
}

function customerTrackView(order, events, cfg) {
    const hyper = order.commerceMode === 'hyperlocal';
    const live = hyper && order.commerceStage !== 'delivered' && order.commerceStage !== 'placed';
    return {
        orderCode: order.orderCode,
        commerceStage: order.commerceStage,
        commerceMode: order.commerceMode,
        commerceProvider: order.commerceProvider,
        deliveryOtp: order.deliveryOtp,
        agentName: order.agentName,
        agentPhone: order.agentPhone,
        agentLat: order.agentLat,
        agentLng: order.agentLng,
        storeLat: order.storeLat,
        storeLng: order.storeLng,
        dropLat: order.dropLat,
        dropLng: order.dropLng,
        liveLeg: order.liveLeg,
        liveMap: !!(live && (order.agentLat != null || order.storeLat != null)),
        mapsApiKey: live && cfg && cfg.mapsApiKey ? cfg.mapsApiKey : null,
        destination: [order.shippingCity, order.shippingState].filter(Boolean).join(', '),
        events: (events || []).map(publicEvent)
    };
}

function publicEvent(ev) {
    return {
        at: ev.at || ev.event_at || ev.created_at || null,
        title: ev.title || ev.description || 'Update',
        detail: ev.detail || ev.city || ev.event_city || ev.location || '',
        city: ev.city || ev.event_city || '',
        kind: ev.kind || ev.event_type || ''
    };
}

async function createTookanTask(cfg, order, mode) {
    if (!cfg.tookan.enabled) throw new Error('Tookan API key is not configured.');
    const now = Date.now();
    const pickupAt = tookanDateTime(now + 20 * 60 * 1000);
    const dropAt = tookanDateTime(now + 90 * 60 * 1000);
    const storeLat = order.storeLat != null ? order.storeLat : cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg.storeLng;
    const body = {
        api_key: cfg.tookan.apiKey,
        order_id: order.orderCode,
        job_description:
            (mode === 'logistics' ? 'Book shipment ' : 'Hyperlocal delivery ') +
            order.orderCode +
            (order.pickupOtp ? ' · Pickup OTP ' + order.pickupOtp : '') +
            (order.deliveryOtp ? ' · Delivery OTP ' + order.deliveryOtp : ''),
        job_pickup_phone: cfg.storePhone || order.buyerPhone || '0000000000',
        job_pickup_name: cfg.storeName,
        job_pickup_address: [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', ') || 'Book desk',
        job_pickup_datetime: pickupAt,
        customer_username: order.shippingRecipientName || order.buyerName || 'Customer',
        customer_phone: order.shippingPhone || order.buyerPhone || '0000000000',
        customer_address: order.deliveryAddress || [order.shippingCity, order.shippingState].filter(Boolean).join(', ') || 'Delivery address',
        job_delivery_datetime: dropAt,
        has_pickup: 1,
        has_delivery: 1,
        layout_type: 0,
        tracking_link: 1,
        timezone: '-330',
        auto_assignment: 1,
        notify: 1,
        geofence: 0,
        tags: mode === 'logistics' ? 'logistics' : 'hyperlocal',
        meta_data: [
            { label: 'Pickup OTP', data: order.pickupOtp || '' },
            { label: 'Delivery OTP', data: order.deliveryOtp || '' },
            { label: 'Mode', data: mode }
        ]
    };
    if (storeLat != null && storeLng != null) {
        body.job_pickup_latitude = String(storeLat);
        body.job_pickup_longitude = String(storeLng);
    }
    if (order.dropLat != null && order.dropLng != null) {
        body.latitude = String(order.dropLat);
        body.longitude = String(order.dropLng);
    }
    const res = await requestJson('POST', TOOKAN_BASE + '/create_task', { body });
    const data = res.data || {};
    if (res.statusCode >= 400 || data.status === 101 || data.status === 201 || data.status === 404) {
        throw new Error(data.message || 'Tookan could not create the task');
    }
    const jobId = data.data && (data.data.job_id || data.data.pickup_job_id) ? data.data.job_id || data.data.pickup_job_id : data.data;
    const link = (data.data && (data.data.tracking_link || data.data.delivery_tracing_link)) || null;
    return {
        jobId: jobId != null ? String(jobId) : '',
        trackingLink: link || '',
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

function tookanJobToUpdate(job, mode) {
    if (!job) return null;
    const history = job.task_history || job.job_history || [];
    const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;
    const text =
        (last && (last.description || last.job_status || last.type)) ||
        job.job_status_text ||
        tookanStatusLabel(job.job_status);
    const city = (last && (last.city || last.location || last.address)) || job.job_address || '';
    const phrase = phraseLogisticsUpdate(String(text), {
        city: typeof city === 'string' ? city : '',
        agentName: job.fleet_name || '',
        agentPhone: job.fleet_phone || job.fleet_phone_number || ''
    });
    const kindFromStatus = mapTookanStatus(job.job_status, text);
    const kind = phrase.kind !== 'update' ? phrase.kind : kindFromStatus;
    return {
        provider: 'tookan',
        kind,
        title: phrase.title,
        detail: phrase.detail,
        city: phrase.city,
        agentName: job.fleet_name || phrase.agentName || null,
        agentPhone: job.fleet_phone || job.fleet_phone_number || phrase.agentPhone || null,
        agentLat: numOrNull(job.fleet_latitude != null ? job.fleet_latitude : job.latitude),
        agentLng: numOrNull(job.fleet_longitude != null ? job.fleet_longitude : job.longitude),
        trackingLink: job.tracking_link || null,
        stage: stageFromKind(kind, mode),
        liveLeg: liveLegFor(kind, mode),
        at: (last && (last.creation_datetime || last.time)) || null
    };
}

async function createShipdayOrder(cfg, order) {
    if (!cfg.shipday.enabled) throw new Error('Shipday API key is not configured.');
    const now = Date.now();
    const items = (order.items || []).map((it) => ({
        name: it.title || it.bookTitle || it.book_id || 'Book',
        quantity: Number(it.qty) || 1,
        unitPrice: Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0
    }));
    if (!items.length) items.push({ name: 'Book order ' + order.orderCode, quantity: 1, unitPrice: Number(order.totalAmount) || 0 });
    const body = {
        orderNumber: order.orderCode,
        customerName: order.shippingRecipientName || order.buyerName || 'Customer',
        customerAddress: order.deliveryAddress || [order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).join(', '),
        customerPhoneNumber: order.shippingPhone || order.buyerPhone || '',
        restaurantName: cfg.storeName,
        restaurantAddress: [cfg.storeAddress, cfg.storeCity].filter(Boolean).join(', '),
        restaurantPhoneNumber: cfg.storePhone || '',
        expectedDeliveryDate: shipdayDate(now),
        expectedPickupTime: shipdayTime(now + 20 * 60 * 1000),
        expectedDeliveryTime: shipdayTime(now + 90 * 60 * 1000),
        deliveryInstruction: 'Delivery OTP ' + (order.deliveryOtp || '') + '. Pickup OTP ' + (order.pickupOtp || ''),
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

async function fetchShipdayOrder(cfg, orderId) {
    if (!cfg.shipday.enabled || !orderId) return null;
    const res = await requestJson('GET', SHIPDAY_BASE + '/orders/' + encodeURIComponent(orderId), {
        headers: { Authorization: 'Basic ' + cfg.shipday.apiKey }
    });
    if (res.statusCode >= 400) return null;
    const data = res.data || {};
    return data.order || data;
}

function shipdayOrderToUpdate(order) {
    if (!order) return null;
    const status = order.orderStatus || order.status || order.order_status;
    const kind = mapShipdayStatus(status);
    const carrier = order.carrier || order.assignedCarrier || {};
    const phrase = phraseLogisticsUpdate(String(status || 'Shipment update').replace(/_/g, ' '), {
        agentName: carrier.name || order.carrierName || '',
        agentPhone: carrier.phoneNumber || carrier.phone || order.carrierPhone || ''
    });
    const title =
        kind === 'out_for_delivery'
            ? 'Out for delivery'
            : kind === 'delivered'
              ? 'Delivered'
              : kind === 'to_store'
                ? 'Driver on the way to pickup'
                : phrase.title;
    return {
        provider: 'shipday',
        kind,
        title,
        detail: [phrase.agentName, phrase.agentPhone].filter(Boolean).join(' · '),
        city: '',
        agentName: carrier.name || order.carrierName || null,
        agentPhone: carrier.phoneNumber || carrier.phone || order.carrierPhone || null,
        agentLat: numOrNull(carrier.latitude != null ? carrier.latitude : carrier.lat),
        agentLng: numOrNull(carrier.longitude != null ? carrier.longitude : carrier.lng),
        trackingLink: order.trackingLink || order.trackingUrl || null,
        stage: stageFromKind(kind, 'hyperlocal'),
        liveLeg: liveLegFor(kind, 'hyperlocal'),
        at: order.expectedDeliveryDate || null
    };
}

function parseTookanWebhook(body) {
    const b = body && typeof body === 'object' ? body : {};
    const text = String(b.job_state || b.job_status_text || b.task_status || tookanStatusLabel(b.job_status) || '');
    const phrase = phraseLogisticsUpdate(text, {
        city: b.job_address || b.city || '',
        agentName: b.fleet_name || '',
        agentPhone: b.fleet_phone || ''
    });
    const kind = phrase.kind !== 'update' ? phrase.kind : mapTookanStatus(b.job_status, text);
    return {
        provider: 'tookan',
        jobId: b.job_id != null ? String(b.job_id) : '',
        orderCode: String(b.order_id || '').trim(),
        kind,
        title: phrase.title,
        detail: phrase.detail,
        city: phrase.city,
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
    const status = b.orderStatus || b.event || b.status;
    const kind = mapShipdayStatus(status);
    const phrase = phraseLogisticsUpdate(String(status || '').replace(/_/g, ' '), {
        agentName: b.carrierName || '',
        agentPhone: b.carrierPhone || ''
    });
    return {
        provider: 'shipday',
        shipdayOrderId: b.orderId != null ? String(b.orderId) : '',
        orderCode: String(b.orderNumber || b.order_number || '').trim(),
        kind,
        title: kind === 'out_for_delivery' ? 'Out for delivery' : kind === 'to_store' ? 'Driver on the way to pickup' : phrase.title,
        detail: [b.carrierName, b.carrierPhone].filter(Boolean).join(' · '),
        city: '',
        agentName: b.carrierName || null,
        agentPhone: b.carrierPhone || null,
        agentLat: numOrNull(b.carrierLat != null ? b.carrierLat : b.latitude),
        agentLng: numOrNull(b.carrierLng != null ? b.carrierLng : b.longitude),
        trackingLink: b.trackingUrl || b.trackingLink || null
    };
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
    const from = [cfg.storeName, cfg.storeAddress, cfg.storeCity, cfg.storePhone].filter(Boolean).join('<br>');
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Label ' +
        escapeHtml(order.orderCode) +
        '</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#111} .box{border:2px solid #111;padding:16px;max-width:520px} h1{font-size:22px;margin:0 0 8px} table{width:100%;border-collapse:collapse;margin-top:12px} td{border-top:1px solid #ccc;padding:6px 0} .otp{font-size:20px;font-weight:800;letter-spacing:2px}</style></head><body><div class="box"><h1>Shipping label</h1><p><strong>' +
        escapeHtml(order.orderCode) +
        '</strong> · ' +
        escapeHtml(order.commerceProvider || '') +
        ' · ' +
        escapeHtml(order.commerceMode || '') +
        '</p><p><strong>From</strong><br>' +
        from +
        '</p><p><strong>To</strong><br>' +
        (to || '—') +
        '</p><p>Pickup OTP <span class="otp">' +
        escapeHtml(order.pickupOtp || '—') +
        '</span><br>Delivery OTP <span class="otp">' +
        escapeHtml(order.deliveryOtp || '—') +
        '</span></p><table>' +
        lines +
        '</table><p style="margin-top:12px;font-size:13px;">Track: ' +
        escapeHtml(order.commerceTrackUrl || '') +
        '</p></div><script>window.print&&setTimeout(function(){window.print()},300)</script></body></html>'
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
    requestJson,
    normalizeCommerceConfig,
    publicConfigView,
    mergeConfigSecrets,
    phraseLogisticsUpdate,
    mapTookanStatus,
    mapShipdayStatus,
    stageFromKind,
    liveLegFor,
    generateOtp,
    generateToken,
    tookanDateTime,
    trackPath,
    mapCommerceRow,
    customerTrackView,
    createTookanTask,
    fetchTookanJob,
    tookanJobToUpdate,
    createShipdayOrder,
    fetchShipdayOrder,
    shipdayOrderToUpdate,
    parseTookanWebhook,
    parseShipdayWebhook,
    labelHtml
};

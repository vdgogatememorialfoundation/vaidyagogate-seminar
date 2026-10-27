/**
 * Customer-facing shipment lifecycle.
 * Tookan and Shipday stay operational providers. This module decides the five
 * statuses the customer sees: ORDERED, PACKED, SHIPPED, OUT_FOR_DELIVERY, DELIVERED.
 *
 * Provider fields that are not in the APIs we call stay null.
 * NOT AVAILABLE FROM PROVIDER API:
 * - Tookan parcel create does not return a parcel id (the response data is empty).
 * - Tookan hubs do not return separate city, state, or country fields.
 * - Shipday does not return a pickup OTP or a delivery OTP.
 * - The order APIs we read do not return a delivery time window.
 */
const MAIN = ['ORDERED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

const MAIN_COPY = {
    ORDERED: { title: 'Ordered', message: 'Your order has been placed' },
    PACKED: { title: 'Packed', message: 'Your item has been packed' },
    SHIPPED: { title: 'Shipped', message: 'Your item has been shipped' },
    OUT_FOR_DELIVERY: { title: 'Out for delivery', message: 'Your order is out for delivery' },
    DELIVERED: { title: 'Delivered', message: 'Your order has been delivered' }
};

const HYPER_COPY = {
    ORDERED: { title: 'Ordered', message: 'Your order has been placed' },
    PACKED: { title: 'Packed', message: 'Your order is packed at the store' },
    SHIPPED: { title: 'Picked up', message: 'The delivery partner has picked up your order' },
    OUT_FOR_DELIVERY: { title: 'Out for delivery', message: 'Your order is on the way' },
    DELIVERED: { title: 'Delivered', message: 'Your order has been delivered' }
};

function statusCopy(hyper) {
    return hyper ? HYPER_COPY : MAIN_COPY;
}

function mainKeyFromOrder(order) {
    const stage = String((order && order.commerceStage) || 'placed');
    const status = String((order && order.status) || '');
    if (stage === 'delivered' || status === 'delivered') return 'DELIVERED';
    if (stage === 'out_for_delivery') return 'OUT_FOR_DELIVERY';
    if (stage === 'in_transit') return 'SHIPPED';
    if (stage === 'ready' || stage === 'pickup_scheduled') return 'PACKED';
    if (!order || !order.commerceProvider) {
        if (status === 'fulfilled' && order && order.fulfillmentType === 'pickup') return 'DELIVERED';
        if (status === 'shipped') return 'SHIPPED';
    }
    return 'ORDERED';
}

/** Highest main stage proven by courier / ops events (scan beats a stale stored stage). */
function mainKeyFromEvents(events) {
    let best = -1;
    (events || []).forEach((ev) => {
        const b = eventBucket(ev);
        const key =
            b === 'delivered' ? 'DELIVERED'
            : b === 'out_for_delivery' || b === 'at_drop' ? 'OUT_FOR_DELIVERY'
            : b === 'pickup' || b === 'hub_arrived' || b === 'hub_left' || b === 'handover' || b === 'manifest' || b === 'crossdock' || b === 'rerouted' ? 'SHIPPED'
            : null;
        if (key) best = Math.max(best, MAIN.indexOf(key));
    });
    return best >= 0 ? MAIN[best] : null;
}

/** Courier task times saved on the order (Tookan parcel tasks) as pickup / delivery instants. */
function taskTimes(order) {
    const tasks = order && order.parcelInfo && Array.isArray(order.parcelInfo.tasks) ? order.parcelInfo.tasks : [];
    const pick = tasks.filter((t) => t.type === 'Pickup' && t.at).map((t) => Date.parse(t.at)).filter(Number.isFinite);
    const del = tasks.filter((t) => t.type === 'Delivery' && t.at).map((t) => Date.parse(t.at)).filter(Number.isFinite);
    return { pickup: pick.length ? Math.min.apply(null, pick) : NaN, delivery: del.length ? Math.max.apply(null, del) : NaN };
}

const TASK_STATE = { 0: 'Assigned', 1: 'Started', 2: 'Completed', 3: 'Failed', 4: 'In progress', 6: 'Waiting for agent', 7: 'Accepted', 8: 'Declined', 9: 'Cancelled' };

/** Leg-by-leg consignment view (store → hubs → customer) from saved courier tasks; no raw courier links. */
function consignmentView(order) {
    const info = order && order.parcelInfo;
    if (!info || !Array.isArray(info.tasks) || !info.tasks.length) return null;
    const legs = [];
    info.tasks.forEach((t) => {
        const n = t.leg || 1;
        let leg = legs.find((l) => l.n === n);
        if (!leg) {
            leg = { n, barcode: t.barcode || null, from: t.fromName || t.from || '', to: t.toName || t.to || '', tasks: [], state: 'upcoming', agent: null, at: null };
            legs.push(leg);
        }
        leg.tasks.push({ id: t.jobId, type: t.type, status: TASK_STATE[t.status] || 'Scheduled', code: t.status, at: t.completedAt || t.at || null, agent: t.agent || null, otp: t.otp || null });
        if (t.agent) leg.agent = t.agent;
        if (t.type === 'Delivery') leg.to = t.toName || t.to || leg.to;
        if (t.type === 'Pickup') leg.from = t.fromName || t.from || leg.from;
    });
    legs.forEach((leg) => {
        const codes = leg.tasks.map((x) => Number(x.code));
        leg.state = codes.length && codes.every((c) => c === 2) ? 'done' : codes.some((c) => c === 3 || c === 9) ? 'failed' : codes.some((c) => c === 1 || c === 4 || c === 7 || c === 0) ? 'active' : 'upcoming';
        const done = leg.tasks.filter((x) => Number(x.code) === 2).map((x) => x.at).filter(Boolean).sort();
        leg.at = done.length ? done[done.length - 1] : leg.tasks.map((x) => x.at).filter(Boolean).sort()[0] || null;
    });
    return { parcelId: info.parcelId || null, code: info.code || null, legs, reattempts: Array.isArray(info.reattempts) ? info.reattempts.length : 0 };
}

/** Delivery attempt history: each failed / cancelled attempt and the re-attempt scheduled from the hub. */
function attemptsView(order, events) {
    const out = [];
    const ra = order && order.parcelInfo && Array.isArray(order.parcelInfo.reattempts) ? order.parcelInfo.reattempts : [];
    ra.forEach((r, i) => out.push({ n: i + 1, outcome: r.failedStatus === 'cancelled' ? 'Cancelled by courier' : 'Attempt failed', returnedTo: r.fromHub || null, at: r.at || null, nextTask: r.deliveryJobId || r.pickupJobId || null }));
    (events || []).forEach((ev) => {
        if (eventBucket(ev) !== 'failed') return;
        const at = ev.at || ev.createdAt || null;
        if (out.some((o) => o.at && at && Math.abs(Date.parse(o.at) - Date.parse(at)) < 10 * 60 * 1000)) return;
        out.push({ n: out.length + 1, outcome: ev.title || 'Attempt failed', returnedTo: null, at, nextTask: null });
    });
    out.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
    out.forEach((o, i) => (o.n = i + 1));
    return out.length ? out : null;
}

function allowMainTransition(fromKey, toKey) {
    const from = MAIN.indexOf(fromKey);
    const to = MAIN.indexOf(toKey);
    if (from < 0 || to < 0) return false;
    return to >= from && to <= from + 1;
}

function acceptsStageChange(fromKey, toKey, update) {
    if (allowMainTransition(fromKey, toKey)) return true;
    return !!(
        update &&
        update.explicitDelivery &&
        update.kind === 'delivered' &&
        toKey === 'DELIVERED' &&
        (fromKey === 'SHIPPED' || fromKey === 'OUT_FOR_DELIVERY')
    );
}

function fulfillmentType(order) {
    if (!order) return null;
    if (order.commerceMode === 'hyperlocal') return 'HYPERLOCAL';
    if (order.commerceMode === 'logistics') return 'NORMAL_LOGISTICS';
    if (order.fulfillmentType === 'courier') return 'NORMAL_LOGISTICS';
    return null;
}

const PARENT_OF = {
    ordered: 'ORDERED',
    processing: 'ORDERED',
    packed: 'PACKED',
    pickup_requested: 'PACKED',
    agent_assigned: 'PACKED',
    to_pickup: 'PACKED',
    at_pickup: 'PACKED',
    pickup: 'SHIPPED',
    hub_arrived: 'SHIPPED',
    hub_left: 'SHIPPED',
    schedule: 'SHIPPED',
    handover: 'SHIPPED',
    manifest: 'SHIPPED',
    crossdock: 'SHIPPED',
    rerouted: 'SHIPPED',
    hold: 'SHIPPED',
    released: 'SHIPPED',
    restriction: 'SHIPPED',
    address_change: 'SHIPPED',
    collection_point: 'OUT_FOR_DELIVERY',
    issue: 'DELIVERED',
    appointment: 'SHIPPED',
    prep: 'PACKED',
    ops_pickup: 'PACKED',
    ops_delivery: 'OUT_FOR_DELIVERY',
    out_for_delivery: 'OUT_FOR_DELIVERY',
    at_drop: 'OUT_FOR_DELIVERY',
    failed: 'OUT_FOR_DELIVERY',
    rescheduled: 'OUT_FOR_DELIVERY',
    delivered: 'DELIVERED',
    update: 'SHIPPED'
};

function eventBucket(ev) {
    const kind = String(ev.kind || '').toLowerCase();
    const text = (String(ev.title || '') + ' ' + String(ev.detail || '')).toLowerCase();
    if (/^expected at\b/.test(text) || kind === 'hub_eta') return 'schedule';
    if (kind === 'prep' || kind === 'ops_pickup' || kind === 'ops_delivery' || kind === 'issue' || kind === 'appointment' || kind === 'address_change' || kind === 'hold' || kind === 'released') return kind;
    if (/released from hold|hold released|release(d)? for delivery/.test(text)) return 'released';
    if (/\bon hold\b|held at|hold at|shipment held|kept on hold/.test(text)) return 'hold';
    if (/re-?rout|redirected|diverted to/.test(text)) return 'rerouted';
    if (/not serviceable|service disruption|restricted area|embargo|area not accessible|delivery restricted/.test(text)) return 'restriction';
    if (/address (correction|updated|changed|corrected)/.test(text)) return 'address_change';
    if (/handed over to (partner|carrier|courier|co-?loader)|co-?loader|transferred to (partner|carrier)/.test(text)) return 'handover';
    if (/\bbag(ged)?\b|manifest/.test(text) && !/damage/.test(text)) return 'manifest';
    if (/cross.?dock/.test(text)) return 'crossdock';
    if (/collection point|pickup point|parcel locker|collect from/.test(text)) return 'collection_point';
    if (kind === 'placed' || /order placed|your order has been placed/.test(text)) return 'ordered';
    if (kind === 'accepted' || kind === 'preparing' || /preparing your order|seller is preparing/.test(text)) return 'processing';
    if (kind === 'failed' || /attempt failed|attempt was unsuccessful|delivery failed|could not be completed|couldn.?t deliver/.test(text)) return 'failed';
    if (kind === 'rescheduled' || /has been rescheduled|delivery rescheduled/.test(text)) return 'rescheduled';
    if (kind === 'delivered' || /\bdelivered\b|delivery completed/.test(text)) return 'delivered';
    if (kind === 'at_drop' || /reached (the |your )?(drop|delivery location|customer)/.test(text)) return 'at_drop';
    if (kind === 'out_for_delivery' || /out for delivery/.test(text)) return 'out_for_delivery';
    if (kind === 'picked_up' || /picked up|pickup from seller|pickup done|pickup complete|collected from (seller|shipper|store|merchant)|shipment picked|picked from/.test(text)) return 'pickup';
    if (kind === 'arrived_facility' || /arrived at courier facility|shipment arrived|shipment received at\b|^received at\b|^arrived at\b|reached .*(hub|facility|centre|center)|in-?scan/.test(text)) return 'hub_arrived';
    if (kind === 'left_facility' || /left a courier facility|shipment left|left courier|^dispatched (to|from)\b|^departed\b|out-?scan|in transit to\b|forwarded to\b/.test(text)) return 'hub_left';
    if (kind === 'at_pickup' || /reached the pickup/.test(text)) return 'at_pickup';
    if (kind === 'to_store' || /on the way to pick/.test(text)) return 'to_pickup';
    if (kind === 'agent_assigned' || /assigned for pickup|partner assigned|agent assigned/.test(text)) return 'agent_assigned';
    if (kind === 'pickup_scheduled' || /pickup requested|pickup scheduled|shipment created|soft data|awb (generated|assigned)|shipment booked|manifested/.test(text)) return 'pickup_requested';
    if (kind === 'ready' || kind === 'ready_for_pickup' || /\bpacked\b/.test(text)) return 'packed';
    return 'update';
}

function placeSuffix(ev) {
    const c = cleanPlace(ev && (ev.city || ev.facility));
    return c ? ' \u00b7 ' + c : '';
}
function reasonSuffix(ev) {
    const t = String((ev && ev.title) || '').trim();
    return t ? ' \u2014 ' + t : '';
}

function eventMessage(bucket, ev, hyper) {
    if (bucket === 'prep' || bucket === 'ops_pickup' || bucket === 'ops_delivery') return String((ev && ev.title) || '').trim() || null;
    if (bucket === 'ordered') return 'Your order has been placed';
    if (bucket === 'processing') return 'Seller is preparing your order';
    if (bucket === 'packed') return hyper ? 'Your order is packed at the store' : 'Your item has been packed';
    if (bucket === 'pickup_requested') return hyper ? 'Pickup requested from the store' : 'Shipping label created \u2014 awaiting courier pickup';
    if (bucket === 'issue' || bucket === 'appointment' || bucket === 'address_change') return String((ev && ev.title) || '').trim() || null;
    if (bucket === 'handover') return 'Handed over to partner carrier for the next leg' + placeSuffix(ev);
    if (bucket === 'manifest') return 'Parcel added to a dispatch bag / manifest' + placeSuffix(ev);
    if (bucket === 'crossdock') return 'Transferred between facilities (cross-dock)' + placeSuffix(ev);
    if (bucket === 'rerouted') return 'Parcel rerouted to a new facility' + placeSuffix(ev);
    if (bucket === 'hold') return 'Parcel on hold at the courier facility' + reasonSuffix(ev);
    if (bucket === 'released') return 'Hold released \u2014 parcel moving again';
    if (bucket === 'restriction') return 'Delivery restriction notice from the courier' + reasonSuffix(ev);
    if (bucket === 'collection_point') return 'Available at a collection point' + placeSuffix(ev);
    if (bucket === 'agent_assigned') return hyper ? 'Delivery partner assigned' : 'Courier partner assigned for pickup';
    if (bucket === 'to_pickup') return hyper ? 'Delivery partner is on the way to the store' : 'Courier partner is on the way to pickup';
    if (bucket === 'at_pickup') return hyper ? 'Delivery partner reached the store' : 'Courier partner reached the pickup point';
    if (bucket === 'pickup') return hyper ? 'Your order has been picked up' : 'Parcel accepted by courier partner (picked up)';
    if (bucket === 'hub_arrived') {
        const arrived = String((ev && ev.title) || '').trim();
        if (/^shipment received at\s+\S/i.test(arrived)) return arrived;
        if (/^(arrived|received) at\s+\S/i.test(arrived) && !/courier facility/i.test(arrived)) return arrived;
        return 'Item arrived at courier facility';
    }
    if (bucket === 'hub_left') {
        const left = String((ev && ev.title) || '').trim();
        if (/^(shipment left|dispatched to|dispatched from|departed)\s+\S/i.test(left)) return left;
        return 'Item left a courier facility';
    }
    if (bucket === 'failed') return 'Delivery attempt unsuccessful';
    if (bucket === 'rescheduled') return 'Delivery rescheduled';
    if (bucket === 'at_drop') return 'Delivery partner reached your location';
    if (bucket === 'out_for_delivery') return 'Your order is out for delivery';
    if (bucket === 'delivered') return 'Your order has been delivered';
    if (bucket === 'schedule') return '';
    const title = String((ev && ev.title) || '').trim();
    if (!title || /^(update|shipment update)$/i.test(title)) return '';
    return title;
}

function eventCopy(bucket, ev) {
    const message = eventMessage(bucket, ev);
    return { heading: message, message };
}

function cleanPlace(value) {
    const s = String(value || '').trim();
    if (!s || /^book desk$/i.test(s)) return '';
    return s;
}

function normalizeLocation(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\bpin\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function looksLikePostalAddress(value) {
    const s = String(value || '');
    return /\b\d{6}\b/.test(s) && (/,/.test(s) || /\bpin\b/i.test(s));
}

function uniqueLocations(parts) {
    const out = [];
    const seen = new Set();
    (parts || []).forEach((part) => {
        const text = cleanPlace(part);
        const key = normalizeLocation(text);
        if (!key || seen.has(key) || looksLikePostalAddress(text)) return;
        seen.add(key);
        out.push(text);
    });
    return out;
}

function failureReason(ev) {
    const detail = cleanPlace(ev && ev.detail);
    if (!detail) return null;
    const title = cleanPlace(ev.title);
    if (normalizeLocation(detail) === normalizeLocation(ev && ev.city)) return null;
    if (normalizeLocation(detail) === normalizeLocation(title)) return null;
    if (looksLikePostalAddress(detail)) return null;
    if (/attempt failed|attempt unsuccessful|could not be completed|couldn.?t deliver|delivery failed/.test(detail.toLowerCase())) return null;
    return detail;
}

function eventLocation(bucket, ev) {
    if (bucket === 'hub_arrived' || bucket === 'hub_left') {
        const lines = uniqueLocations([ev.facility, ev.detail, ev.city]);
        return lines.length ? lines.join(', ') : null;
    }
    if (bucket === 'pickup' || bucket === 'at_pickup') {
        const lines = uniqueLocations([ev.facility, ev.detail, ev.city]);
        return lines.length ? lines.join(', ') : null;
    }
    if (bucket === 'delivered' || bucket === 'out_for_delivery') {
        const lines = uniqueLocations([ev.detail, ev.city]).filter((line) => !/^(delivered|out for delivery)$/i.test(line));
        return lines.length ? lines.join(', ') : null;
    }
    return null;
}

function customerEvent(ev, opts) {
    const hyper = !!(opts && opts.hyperlocal);
    const title = String((ev && ev.title) || '');
    const detail = String((ev && ev.detail) || '');
    if (/created by api/.test((title + ' ' + detail).toLowerCase()) || /deleted by\b/.test((title + ' ' + detail).toLowerCase())) return null;
    const bucket = eventBucket(ev || {});
    if (hyper && (bucket === 'hub_arrived' || bucket === 'hub_left' || bucket === 'schedule')) return null;
    const parentStage = PARENT_OF[bucket] || null;
    if (!parentStage) return null;
    const message = eventMessage(bucket, ev, hyper);
    if (!message) return null;
    const row = {
        parentStage,
        message,
        at: (ev && ev.at) || null,
        location: eventLocation(bucket, ev || {}),
        reason: bucket === 'failed' ? failureReason(ev) : null,
        tone: bucket === 'failed' ? 'failed' : bucket === 'rescheduled' ? 'rescheduled' : bucket === 'hold' || bucket === 'restriction' || bucket === 'issue' ? 'warn' : '',
        internal: bucket === 'schedule',
        source: sourceLabel(ev && ev.source)
    };
    if (bucket === 'hub_arrived' || bucket === 'hub_left') {
        row.city = cleanPlace(ev && ev.city) || null;
        row.state = (ev && ev.state) || null;
        row.country = (ev && ev.country) || null;
        row.facilityName = cleanPlace(ev && (ev.facility || ev.detail)) || null;
    }
    return row;
}

function sourceLabel(src) {
    const v = String(src || '').toLowerCase();
    if (!v || v === 'commerce' || v === 'commerce_return' || v === 'admin' || v === 'store' || v === 'customer') return 'store';
    return 'courier';
}

function stampMs(ev) {
    const n = ev && ev.at ? Date.parse(ev.at) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function operationalFromEvents(events) {
    let failedAt = 0;
    let resumedAt = 0;
    let rescheduledAt = 0;
    (events || []).forEach((ev) => {
        const bucket = eventBucket(ev);
        const ms = stampMs(ev);
        if (bucket === 'failed') failedAt = Math.max(failedAt, ms || failedAt);
        if (bucket === 'rescheduled') rescheduledAt = Math.max(rescheduledAt, ms || rescheduledAt);
        if (bucket === 'out_for_delivery' || bucket === 'delivered' || bucket === 'pickup') resumedAt = Math.max(resumedAt, ms || resumedAt);
    });
    if (failedAt && failedAt >= resumedAt && failedAt >= rescheduledAt) return 'DELIVERY_ATTEMPT_FAILED';
    if (rescheduledAt && rescheduledAt >= resumedAt && rescheduledAt >= failedAt) return 'RESCHEDULED';
    return null;
}

function minutesOf(hhmm) {
    const m = /^(\d{2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function hhmmOf(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function istDateParts(ms) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(ms));
    const g = (t) => {
        const hit = parts.find((p) => p.type === t);
        return hit ? hit.value : '';
    };
    return { year: g('year'), month: g('month'), day: g('day') };
}

function clockLabel(hhmm) {
    const mins = minutesOf(hhmm);
    if (mins == null) return String(hhmm || '');
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return m ? h + ':' + String(m).padStart(2, '0') + ' ' + ap : h + ' ' + ap;
}

function slotLabel(date, start, end, nowMs) {
    const now = nowMs || Date.now();
    const tomorrow = istDateParts(now + 24 * 60 * 60 * 1000);
    const tomorrowKey = tomorrow.year + '-' + tomorrow.month + '-' + tomorrow.day;
    const when = date === tomorrowKey ? 'Tomorrow' : date;
    return when + ', ' + clockLabel(start) + ' – ' + clockLabel(end);
}

function windowLabel(startIso, endIso) {
    const start = startIso ? Date.parse(startIso) : NaN;
    if (!Number.isFinite(start)) return '';
    const date = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    }).format(new Date(start));
    const time = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
    const startText = time.format(new Date(start));
    const end = endIso ? Date.parse(endIso) : NaN;
    const range = Number.isFinite(end) ? startText + ' – ' + time.format(new Date(end)) : startText;
    return date + ', ' + range;
}

function deliverySlots(shop, nowMs) {
    const open = minutesOf((shop && shop.deliveryOpen) || '10:00');
    const close = minutesOf((shop && shop.deliveryClose) || '20:00');
    if (open == null || close == null || close - open < 60) return [];
    const now = nowMs || Date.now();
    const tomorrow = istDateParts(now + 24 * 60 * 60 * 1000);
    const date = tomorrow.year + '-' + tomorrow.month + '-' + tomorrow.day;
    const span = 180;
    const gap = 60;
    const slots = [];
    let cursor = open;
    while (cursor + span <= close && slots.length < 3) {
        const start = hhmmOf(cursor);
        const end = hhmmOf(cursor + span);
        slots.push({
            date,
            start,
            end,
            label: slotLabel(date, start, end, now),
            source: 'store_delivery_hours'
        });
        cursor += span + gap;
    }
    if (!slots.length) {
        const start = hhmmOf(open);
        const end = hhmmOf(close);
        slots.push({ date, start, end, label: slotLabel(date, start, end, now), source: 'store_delivery_hours' });
    }
    return slots;
}

function slotAllowed(shop, date, start, end) {
    const slots = deliverySlots(shop, Date.now());
    const listed = slots.some((slot) => slot.date === date && slot.start === start && slot.end === end);
    if (listed) return true;
    const open = minutesOf((shop && shop.deliveryOpen) || '10:00');
    const close = minutesOf((shop && shop.deliveryClose) || '20:00');
    const a = minutesOf(start);
    const b = minutesOf(end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || open == null || a == null || b == null) return false;
    if (a < open || b > close || b <= a) return false;
    const startMs = Date.parse(date + 'T' + start + ':00+05:30');
    return Number.isFinite(startMs) && startMs > Date.now() + 30 * 60 * 1000;
}

function locationIsFresh(at, nowMs) {
    const ms = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms)) return false;
    return (nowMs || Date.now()) - ms <= 20 * 60 * 1000;
}

function scheduleWindow(order, rank, enteredMs) {
    const tt = taskTimes(order);
    const pickup = order && order.pickupAt ? Date.parse(order.pickupAt) : tt.pickup;
    const delivery = order && order.deliveryAt ? Date.parse(order.deliveryAt) : tt.delivery;
    const created = order && order.createdAt ? Date.parse(order.createdAt) : NaN;
    const resEnd = order && (order.rescheduledForEnd || order.rescheduledForStart) ? Date.parse(order.rescheduledForEnd || order.rescheduledForStart) : NaN;
    const resStart = order && order.rescheduledAt ? Date.parse(order.rescheduledAt) : NaN;
    const pickupMs = Number.isFinite(pickup) ? pickup : 0;
    const deliveryMs = Number.isFinite(delivery) ? delivery : 0;
    const createdMs = Number.isFinite(created) ? created : 0;
    if (rank >= 4 && Number.isFinite(resEnd) && resEnd > 0) {
        const since = Number.isFinite(resStart) ? resStart : pickupMs || createdMs;
        if (since && resEnd > since) return { since, until: resEnd };
    }
    if (rank >= 4 && deliveryMs) {
        const since = (Number.isFinite(enteredMs) && enteredMs > 0 && enteredMs < deliveryMs ? enteredMs : 0) || pickupMs || createdMs || deliveryMs - 3 * 60 * 60 * 1000;
        if (deliveryMs > since) return { since, until: deliveryMs };
    }
    if (rank >= 3 && deliveryMs) {
        const since = (Number.isFinite(enteredMs) && enteredMs > 0 && enteredMs < deliveryMs ? enteredMs : 0) || pickupMs || createdMs;
        if (since && deliveryMs > since) return { since, until: deliveryMs };
    }
    if (rank >= 2 && pickupMs) {
        const since = createdMs || pickupMs - 6 * 60 * 60 * 1000;
        if (pickupMs > since) return { since, until: pickupMs };
    }
    return null;
}

function lineGrow(since, until, nowMs) {
    const now = nowMs || Date.now();
    if (!since || !until || until <= since) return 0.12;
    if (now <= since) return 0.12;
    const ratio = Math.min(1, (now - since) / (until - since));
    return Math.min(0.55, Math.max(0.12, Math.round(ratio * 100) / 100));
}

function expectedWhen(iso) {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return '';
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    }).format(new Date(ms));
}

function expectedStatusLabel(hyper, key, pickup, drop) {
    if (!hyper && key === 'PACKED' && pickup) return 'Expected pickup ' + pickup;
    if (key === 'SHIPPED' && pickup) return 'Expected shipping ' + pickup;
    if (key === 'OUT_FOR_DELIVERY' && drop) return 'Expected delivery ' + drop;
    return '';
}

function customerStatuses(order, opts) {
    const hyper = fulfillmentType(order) === 'HYPERLOCAL';
    const copy = statusCopy(hyper);
    const o = opts || {};
    const plan = order && !(order.pickupAt && order.deliveryAt) ? expectedPlan(order, o.shop || {}, o.store || {}) : null;
    const pickup = expectedWhen(order && order.pickupAt) || (plan ? expectedWhen(plan.pickupAt) : '');
    const drop = order && order.rescheduledForStart
        ? windowLabel(order.rescheduledForStart, order.rescheduledForEnd)
        : expectedWhen(order && order.deliveryAt) || (plan ? plan.deliveryText || expectedWhen(plan.deliveryAt) : '');
    return MAIN.map((key) => ({
        key,
        title: copy[key].title,
        message: copy[key].message,
        expectedLabel: expectedStatusLabel(hyper, key, pickup, drop)
    }));
}

function deliveryByLabel(order) {
    if (!order || String(order.status || '') === 'cancelled') return '';
    if (order.rescheduledForStart) return windowLabel(order.rescheduledForStart, order.rescheduledForEnd);
    if (!order.deliveryAt) return '';
    return windowLabel(order.deliveryAt, null);
}

function isoAt(ev) {
    const ms = ev && ev.at ? Date.parse(ev.at) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function shipmentDates(order, mainStatus, timeline) {
    const rows = (timeline || []).slice().sort((a, b) => (Date.parse(a && a.at) || 0) - (Date.parse(b && b.at) || 0));
    const depart = rows.find((ev) => ev.parentStage === 'SHIPPED' && isoAt(ev) && /left origin|picked up|accepted by courier|shipment left/i.test(String(ev.message || '')));
    const anyShip = rows.find((ev) => ev.parentStage === 'SHIPPED' && isoAt(ev));
    const shippedAt = isoAt(depart || anyShip);
    const delivered = rows.filter((ev) => ev.parentStage === 'DELIVERED' && isoAt(ev)).pop();
    const deliveryAt = mainStatus === 'DELIVERED' ? isoAt(delivered) || (order && order.courierDeliveredAt) || '' : '';
    const promised = deliveryByLabel(order);
    const pickup = order && order.pickupAt && !shippedAt && mainStatus !== 'ORDERED' && mainStatus !== 'DELIVERED' ? order.pickupAt : '';
    const stamped = rows.filter((ev) => isoAt(ev) && !ev.internal);
    const latest = stamped.length ? stamped[stamped.length - 1] : null;
    return {
        shippedAt: shippedAt || null,
        shippedExpected: pickup || null,
        shippedState: shippedAt ? 'actual' : pickup ? 'expected' : '',
        deliveryAt: deliveryAt || null,
        deliveryLabel: deliveryAt ? '' : promised,
        deliveryState: deliveryAt ? 'actual' : promised ? 'expected' : '',
        promisedLabel: promised,
        deliveryKind: deliveryAt ? 'actual' : order && (order.courierEtaAt || order.courierEtaText || order.rescheduledForStart) ? 'courier' : promised ? 'estimate' : '',
        updatedAt: latest ? isoAt(latest) : null,
        updatedLabel: latest && latest.message ? String(latest.message) : ''
    };
}

const EARLY_LATE_TOLERANCE_MS = 3 * 60 * 60 * 1000;

function shipmentTiming(order, mainStatus, timeline, nowMs, options) {
    if (!order || mainStatus === 'ORDERED' || String(order.status || '') === 'cancelled') return null;
    const opts = options || {};
    const sellerPlan = expectedPlan(
        Object.assign({}, order, { pickupAt: null, deliveryAt: null, courierEtaAt: null, courierEtaText: null }),
        opts.shop,
        opts.store
    );
    const livePlan = expectedPlan(order, opts.shop, opts.store);
    if (mainStatus !== 'DELIVERED' && livePlan && sellerPlan && livePlan.source === 'courier') {
        const diff = toMs(livePlan.deliveryAt) - toMs(sellerPlan.deliveryAt);
        if (Number.isFinite(diff)) {
            if (diff < -EARLY_LATE_TOLERANCE_MS) return { state: 'early', label: 'Arriving early', deliveredAt: null };
            if (diff > EARLY_LATE_TOLERANCE_MS) return { state: 'delayed', label: 'Running late', deliveredAt: null };
        }
    }
    const expectedIso = order.rescheduledForEnd || order.rescheduledForStart || order.deliveryAt || (sellerPlan && sellerPlan.deliveryAt) || '';
    const expectedMs = expectedIso ? Date.parse(expectedIso) : NaN;
    if (!Number.isFinite(expectedMs)) return null;
    let actualMs = nowMs || Date.now();
    let deliveredAt = null;
    if (mainStatus === 'DELIVERED') {
        const hits = (timeline || []).filter((ev) => ev.parentStage === 'DELIVERED' && ev.at);
        const fromEvent = hits.length ? Date.parse(hits[hits.length - 1].at) : NaN;
        const fromOrder = order.courierDeliveredAt ? Date.parse(order.courierDeliveredAt) : NaN;
        actualMs = Number.isFinite(fromEvent) ? fromEvent : fromOrder;
        if (!Number.isFinite(actualMs)) return null;
        deliveredAt = new Date(actualMs).toISOString();
    }
    const late = actualMs > expectedMs;
    if (deliveredAt && actualMs < expectedMs - EARLY_LATE_TOLERANCE_MS) return { state: 'early', label: 'Delivered early', deliveredAt };
    return { state: late ? 'delayed' : 'on_time', label: late ? 'Delayed' : 'On time', deliveredAt };
}

const PREP_STEPS = [
    ['received', 'Order received by store'],
    ['inventory_ok', 'Items available — confirmed'],
    ['picking', 'Picking started'],
    ['picked', 'Items picked & checked'],
    ['substitution', 'Substitution needed for an item'],
    ['packing', 'Packing in progress'],
    ['qc_done', 'Quality check completed'],
    ['ready_for_rider', 'Ready for delivery partner pickup']
];
const OPS_ACTIONS = {
    rider_arrived: ['ops_pickup', 'Delivery partner arrived at the store'],
    pickup_verified: ['ops_pickup', 'Pickup verified (OTP / QR) and packages handed over'],
    rider_departed: ['ops_pickup', 'Delivery partner left the store with your order'],
    reassign: ['ops_pickup', 'Delivery partner reassigned — a new partner is being arranged'],
    store_delay: ['prep', 'Store is running a little late preparing your order'],
    customer_unreachable: ['ops_delivery', 'Delivery partner could not reach you — please keep your phone handy'],
    waiting_customer: ['ops_delivery', 'Delivery partner is waiting at your location'],
    wrong_location: ['ops_delivery', 'Delivery partner is being guided to the correct address'],
    safe_drop: ['ops_delivery', 'Order left at the safe drop location you chose'],
    failed_delivery: ['failed', 'Delivery attempt failed']
};

function distanceKm(lat1, lng1, lat2, lng2) {
    const v = [lat1, lng1, lat2, lng2].map(Number);
    if (v.some((n) => !Number.isFinite(n))) return null;
    const R = 6371;
    const dLat = ((v[2] - v[0]) * Math.PI) / 180;
    const dLng = ((v[3] - v[1]) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((v[0] * Math.PI) / 180) * Math.cos((v[2] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Swiggy/Zepto-style hyperlocal insight block: preparation, rider, live journey, last-mile, delays. */
/** Distance-based customer state from the agent's last fresh GPS fix (any courier that reports one). */
function proximityState(order, ctx) {
    if (!order || ctx.failed || ctx.mainStatus !== 'OUT_FOR_DELIVERY') return null;
    if (order.agentLat == null || order.agentLng == null || order.dropLat == null || order.dropLng == null) return null;
    const fresh = locationIsFresh(order.agentLocationAt, ctx.nowMs);
    const km = distanceKm(order.agentLat, order.agentLng, order.dropLat, order.dropLng);
    if (!Number.isFinite(km)) return null;
    const state = !fresh ? 'stale' : km <= 0.1 ? 'doorstep' : km <= 0.5 ? 'nearing' : km <= 2 ? 'approaching' : 'enroute';
    const label = { doorstep: 'Arrived at your doorstep', nearing: 'Nearing you — please be available', approaching: 'Delivery partner approaching', enroute: 'On the way to you', stale: 'Last known position' }[state];
    return { state, label, distanceKm: Math.round(km * 10) / 10, etaMinutes: fresh ? Math.max(1, Math.round((km / 18) * 60 + 2)) : null, lastGpsAt: order.agentLocationAt || null, fresh };
}

function hyperlocalInsights(order, events, ctx) {
    const nowMs = ctx.nowMs;
    const by = (bucket) => (events || []).filter((ev) => eventBucket(ev) === bucket);
    const lastAt = (list) => (list.length ? list[list.length - 1].at || null : null);
    const prepDone = {};
    (events || []).forEach((ev) => {
        if (String(ev.kind || '') !== 'prep') return;
        const hit = PREP_STEPS.find(([, title]) => title === String(ev.title || '').trim());
        if (hit) prepDone[hit[0]] = ev.at || null;
    });
    const packedAt = lastAt(by('packed'));
    const placedAt = lastAt(by('ordered')) || order.createdAt || null;
    if (placedAt && !prepDone.received) prepDone.received = placedAt;
    if (packedAt) ['picking', 'picked', 'packing', 'qc_done', 'ready_for_rider'].forEach((k) => { if (!prepDone[k]) prepDone[k] = packedAt; });
    const prep = PREP_STEPS.filter(([k]) => k !== 'substitution' || prepDone.substitution).map(([key, title]) => ({ key, title, at: prepDone[key] || null, done: !!prepDone[key] }));
    const assigns = by('agent_assigned');
    const arrived = lastAt(by('at_pickup'));
    const pickedUp = lastAt(by('pickup'));
    const ops = (events || []).filter((ev) => String(ev.kind || '').startsWith('ops_'));
    const verifiedAt = lastAt(ops.filter((ev) => /Pickup verified/.test(ev.title || '')));
    const departedAt = pickedUp || lastAt(ops.filter((ev) => /left the store/.test(ev.title || '')));
    const waitMin = arrived && departedAt ? Math.max(0, Math.round((Date.parse(departedAt) - Date.parse(arrived)) / 60000)) : arrived && !departedAt ? Math.max(0, Math.round((nowMs - Date.parse(arrived)) / 60000)) : null;
    const rider = {
        status: ctx.mainStatus === 'DELIVERED' ? 'delivered' : departedAt ? 'departed' : arrived ? 'at_store' : assigns.length ? 'assigned' : ctx.mainStatus === 'PACKED' ? 'searching' : 'not_yet',
        assignedAt: lastAt(assigns),
        reassignments: Math.max(0, assigns.length - 1),
        arrivedAt: arrived,
        pickupVerifiedAt: verifiedAt,
        departedAt,
        waitingMinutes: waitMin,
        packages: order.packageInfo && order.packageInfo.count ? Number(order.packageInfo.count) : 1,
        name: ctx.agent ? ctx.agent.name : null,
        phone: ctx.agent ? ctx.agent.phone : null,
        vehicle: order.agentVehicle || null
    };
    const fresh = locationIsFresh(order.agentLocationAt, nowMs);
    const hasGps = order.agentLat != null && order.agentLng != null;
    const km = hasGps ? distanceKm(order.agentLat, order.agentLng, order.dropLat, order.dropLng) : null;
    const moving = ctx.mainStatus === 'OUT_FOR_DELIVERY' || (ctx.mainStatus === 'SHIPPED' && !!departedAt);
    const etaMin = km != null && moving ? Math.max(2, Math.round((km / 18) * 60 + 3)) : null;
    const live = {
        active: moving && !ctx.failed,
        gps: hasGps && fresh,
        gpsLost: hasGps && !fresh && moving,
        lastGpsAt: order.agentLocationAt || null,
        distanceKm: km != null ? Math.round(km * 10) / 10 : null,
        etaMinutes: etaMin,
        atDoorstep: km != null && fresh && moving && km <= 0.1,
        nearby: km != null && fresh && moving && km <= 0.3,
        approaching: km != null && fresh && moving && km <= 1.5,
        fallback: !hasGps || !fresh
    };
    const plan = ctx.plan || {};
    const packedDue = plan.packedAt ? Date.parse(plan.packedAt) : NaN;
    const deliveryDue = plan.deliveryAt ? Date.parse(plan.deliveryAt) : NaN;
    const storeDelay = !departedAt && Number.isFinite(packedDue) && nowMs > packedDue && (ctx.mainStatus === 'ORDERED' || ctx.mainStatus === 'PACKED');
    const riderDelay = moving && Number.isFinite(deliveryDue) && nowMs > deliveryDue;
    const lastOps = ops.length ? ops[ops.length - 1] : null;
    const cancellable = !departedAt && !ctx.failed && (ctx.mainStatus === 'ORDERED' || ctx.mainStatus === 'PACKED');
    return {
        prep,
        rider,
        live,
        delay: storeDelay ? { kind: 'store', text: 'The store is taking longer than planned to prepare your order.' } : riderDelay ? { kind: 'rider', text: 'Your delivery partner is running later than the promised time.' } : null,
        attention: lastOps && /could not reach you|waiting at your location|safe drop/.test(lastOps.title || '') ? { text: lastOps.title, at: lastOps.at || null } : null,
        cancellation: {
            allowed: cancellable,
            text: cancellable ? 'You can still cancel — the order has not left the store yet.' : ctx.mainStatus === 'DELIVERED' ? 'Delivered orders can be returned from your order page.' : 'Cancellation is no longer possible once the delivery partner has picked up the order.'
        },
        proof: ctx.mainStatus === 'DELIVERED' ? { deliveredAt: lastAt(by('delivered')), otpVerified: !!order.deliveryOtp, recipient: order.deliveryRecipient || null } : null
    };
}

function latestVerified(timeline) {
    const rows = (timeline || []).filter((ev) => ev.at && !ev.internal);
    const last = rows.length ? rows[rows.length - 1] : null;
    if (!last) return null;
    return { at: last.at, message: last.message, source: last.source || 'store', verified: last.source === 'courier' };
}

function lastIssue(events) {
    const rows = (events || []).filter((ev) => String(ev.kind || '') === 'issue');
    const last = rows.length ? rows[rows.length - 1] : null;
    if (!last) return null;
    const m = /Ref\s+(CASE-[A-Z0-9-]+)/i.exec(String(last.title || ''));
    return { reference: m ? m[1] : null, title: String(last.title || ''), detail: String(last.detail || ''), at: last.at || null, status: /resolved|closed/i.test(String(last.title || '')) ? 'resolved' : 'under_review' };
}

/** "Is my parcel on track?" — transit health, freshness, stall/anomaly detection, promise history, ETA confidence. */
function shipmentIntelligence(order, events, timeline, ctx) {
    const nowMs = ctx.nowMs;
    const main = ctx.mainStatus;
    const hyper = ctx.hyper;
    const courierRows = (timeline || []).filter((ev) => ev.source === 'courier' && ev.at);
    const lastCourier = courierRows.length ? courierRows[courierRows.length - 1] : null;
    const lastAny = (timeline || []).filter((ev) => ev.at && !ev.internal).pop() || null;
    const lastAt = lastCourier ? Date.parse(lastCourier.at) : lastAny ? Date.parse(lastAny.at) : NaN;
    const ageH = Number.isFinite(lastAt) ? (nowMs - lastAt) / 3600000 : null;
    const moving = main === 'SHIPPED' || main === 'OUT_FOR_DELIVERY';
    const stallH = hyper ? 0.75 : 36;
    const stalled = moving && ageH != null && ageH > stallH;
    const sellerPlan = ctx.sellerPlan || {};
    const livePlan = ctx.livePlan || {};
    const original = sellerPlan.deliveryAt || null;
    const current = order.rescheduledForStart || livePlan.deliveryAt || original;
    const changed = original && current && Math.abs(Date.parse(current) - Date.parse(original)) > 3 * 3600000;
    const history = [];
    if (original) history.push({ label: 'Original estimate', at: original, kind: 'estimate' });
    if (changed) history.push({ label: order.rescheduledForStart ? 'Rescheduled' : 'Revised by courier', at: current, kind: order.rescheduledForStart ? 'reschedule' : 'courier', reason: ctx.failed ? 'after a failed delivery attempt' : order.rescheduledForStart ? 'at your request' : 'based on the courier\u2019s latest scan' });
    const promisedMs = current ? Date.parse(current) : NaN;
    const late = Number.isFinite(promisedMs) && nowMs > promisedMs + 3 * 3600000 && main !== 'DELIVERED';
    let state = 'on_track';
    let answer = 'Yes \u2014 your parcel is on track.';
    if (main === 'DELIVERED') { state = 'delivered'; answer = 'Delivered.'; }
    else if (ctx.failed) { state = 'exception'; answer = 'A delivery attempt failed \u2014 action may be needed below.'; }
    else if (late) { state = 'delayed'; answer = 'Running late \u2014 the promised date has passed. We are following up with the courier.'; }
    else if (stalled) { state = 'stalled'; answer = 'No courier movement for ' + Math.round(ageH) + (hyper ? ' h' : ' hours') + ' \u2014 an update is expected; we will escalate if it stays silent.'; }
    else if (moving && ageH != null && ageH > stallH / 2) { state = 'update_expected'; answer = 'Moving, but the last courier scan is a while ago \u2014 the next update is expected soon.'; }
    else if (main === 'ORDERED' || main === 'PACKED') { answer = 'Yes \u2014 the order is being prepared on schedule.'; }
    const confidence = main === 'DELIVERED' ? 'confirmed' : stalled || late ? 'low' : livePlan.source === 'courier' || order.rescheduledForStart ? 'high' : moving ? 'medium' : 'low';
    // anomalies
    const anomalies = [];
    const seen = new Map();
    const facilities = [];
    let reversals = 0;
    (timeline || []).forEach((ev) => {
        const key = ev.message + '|' + ev.at;
        seen.set(key, (seen.get(key) || 0) + 1);
        if (ev.city) {
            if (facilities.length && facilities[facilities.length - 1] !== ev.city && facilities.includes(ev.city)) reversals++;
            facilities.push(ev.city);
        }
    });
    if ([...seen.values()].some((n) => n > 1)) anomalies.push({ kind: 'duplicate', text: 'Duplicate courier scans were detected and merged.' });
    if (reversals >= 2) anomalies.push({ kind: 'reversal', text: 'The parcel returned to a facility it had already passed \u2014 unusual routing is being checked.' });
    const transfers = facilities.reduce((n, c, i) => (i && facilities[i - 1] !== c ? n + 1 : n), 0);
    if (transfers >= 6) anomalies.push({ kind: 'transfers', text: 'More facility transfers than usual for this route.' });
    if ((events || []).some((ev) => eventBucket(ev) === 'address_change')) anomalies.push({ kind: 'address', text: 'The delivery address was changed on this shipment. If you did not request this, contact support.' });
    const deliveredRow = (timeline || []).find((ev) => ev.parentStage === 'DELIVERED');
    if (deliveredRow && !hyper) {
        const ofd = (timeline || []).some((ev) => ev.parentStage === 'OUT_FOR_DELIVERY');
        const shipAt = (timeline || []).filter((ev) => ev.parentStage === 'SHIPPED' && ev.at).map((ev) => Date.parse(ev.at)).filter(Number.isFinite);
        const deliveredMs = Date.parse(deliveredRow.at);
        if (!ofd || (shipAt.length && Number.isFinite(deliveredMs) && deliveredMs - Math.max(...shipAt) < 30 * 60000)) {
            anomalies.push({ kind: 'suspicious_delivered', text: 'This "delivered" scan looks unusual (no out-for-delivery step). If you have not received the parcel, report it below and it will be investigated.' });
        }
    }
    const nextMilestone = main === 'ORDERED' ? 'Packed' : main === 'PACKED' ? (hyper ? 'Delivery partner pickup' : 'Courier pickup') : main === 'SHIPPED' ? 'Out for delivery' : main === 'OUT_FOR_DELIVERY' ? 'Delivered' : null;
    const nextAt = main === 'ORDERED' ? livePlan.packedAt : main === 'PACKED' ? livePlan.pickupAt : main === 'SHIPPED' ? livePlan.outForDeliveryAt : main === 'OUT_FOR_DELIVERY' ? current : null;
    return {
        state,
        answer,
        freshness: { lastCourierAt: lastCourier ? lastCourier.at : null, lastAnyAt: lastAny ? lastAny.at : null, hours: ageH != null ? Math.round(ageH * 10) / 10 : null, label: lastCourier ? 'Courier last reported' : 'Last update' },
        stalled,
        etaConfidence: confidence,
        promise: { original, current, changed: !!changed, history },
        next: nextMilestone ? { label: nextMilestone, at: nextAt || null, predicted: true } : null,
        anomalies
    };
}

function securityView(order, track) {
    const awb = order.courierTrackingNo || order.commerceAwb || null;
    return {
        awbVerified: !!(awb && (order.commerceProvider || order.courierName)),
        reference: awb,
        courier: track.courier || order.commerceProvider || order.courierName || null,
        otpNotice: 'Share your delivery OTP only with the delivery partner at your door \u2014 never with callers, SMS or links.',
        linkProtected: true
    };
}

function packageView(order, track, options) {
    const info = order.packageInfo || {};
    const store = options.store || {};
    const packedRow = (track.timeline || []).find((ev) => ev.parentStage === 'PACKED' && ev.at);
    const dispatched = track.dates && track.dates.shippedAt;
    const count = Math.max(1, parseInt(info.count || info.pieces, 10) || 1);
    const awb = order.courierTrackingNo || order.commerceAwb || null;
    const dims = info.length && info.width && info.height ? [info.length, info.width, info.height].join(' \u00d7 ') + ' cm' : null;
    return {
        count,
        packages: Array.from({ length: count }, (_, i) => ({ index: i + 1, trackingId: awb ? (count > 1 ? awb + '-' + (i + 1) : awb) : null })),
        type: info.type || null,
        weightKg: info.weight ? Number(info.weight) : null,
        dimensions: dims,
        contents: info.contents || null,
        from: store.city ? store.city + (store.pincode ? ' ' + store.pincode : '') : null,
        toArea: [order.shippingCity, order.shippingPincode].filter(Boolean).join(' ') || null,
        service: order.service ? String(order.service).replace(/[_-]/g, ' ') : null,
        courier: track.courier || null,
        packedAt: packedRow ? packedRow.at : null,
        dispatchedAt: dispatched || null
    };
}

const COURIER_STATUS_COPY = {
    pickup_requested: ['Pickup requested', 'label'],
    agent_assigned: ['Courier assigned for pickup', 'label'],
    to_pickup: ['Courier heading to pickup', 'label'],
    at_pickup: ['Courier at pickup point', 'label'],
    pickup: ['Picked up by courier', 'move'],
    hub_arrived: ['Reached courier hub', 'hub'],
    hub_left: ['Left courier hub · in transit', 'move'],
    handover: ['Handed to partner carrier', 'move'],
    manifest: ['Loaded for dispatch', 'move'],
    crossdock: ['Transferred between hubs', 'hub'],
    rerouted: ['Rerouted', 'warn'],
    hold: ['On hold at hub', 'warn'],
    released: ['Released · moving again', 'move'],
    restriction: ['Delivery restriction', 'warn'],
    address_change: ['Address updated', 'label'],
    collection_point: ['At collection point', 'hub'],
    out_for_delivery: ['Out for delivery', 'move'],
    at_drop: ['Courier at your location', 'move'],
    failed: ['Delivery attempt failed', 'bad'],
    rescheduled: ['Delivery rescheduled', 'warn'],
    delivered: ['Delivered', 'ok']
};

/** Latest courier-reported main status (chip shown above the pipeline). */
function courierStatusView(events, timeline, mainStatus, order) {
    const rows = (events || []).filter((ev) => ev && ev.at && stampMs(ev)).sort((a, b) => stampMs(a) - stampMs(b));
    let hit = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const b = eventBucket(rows[i]);
        if (COURIER_STATUS_COPY[b]) { hit = { ev: rows[i], bucket: b }; break; }
    }
    if (!hit) {
        if (mainStatus === 'ORDERED' || mainStatus === 'PACKED') return null;
        const ct = String((order && order.courierTrackStatus) || '');
        if (ct === 'booked') return { key: 'booked', label: 'Booked with courier', tone: 'label', at: null, place: null };
        return null;
    }
    const copy = COURIER_STATUS_COPY[hit.bucket];
    const rto = order && order.courierTrackFlags && order.courierTrackFlags.rto;
    const place = cleanPlace(hit.ev.city || hit.ev.facility) || null;
    return {
        key: hit.bucket,
        label: rto && hit.bucket !== 'delivered' ? 'Returning to sender' : copy[0],
        tone: rto && hit.bucket !== 'delivered' ? 'bad' : copy[1],
        at: isoAt(hit.ev) || null,
        place,
        raw: String(hit.ev.title || '').trim() || null
    };
}

function shipmentStats(timeline, pipeline, nowMs) {
    const scans = (timeline || []).filter((ev) => ev && !ev.internal && ev.at && (ev.source === 'courier' || ['PICKED_UP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].indexOf(ev.parentStage) !== -1));
    const last = scans.length ? scans[scans.length - 1] : null;
    const steps = pipeline || [];
    const done = steps.filter((s) => s.state === 'done').length;
    const active = steps.find((s) => s.state === 'active');
    const grow = active ? Math.min(0.88, Number(active.lineGrow) || 0.12) : 0;
    const settled = steps.length && steps[steps.length - 1].state === 'active';
    const places = [];
    scans.forEach((ev) => { const p = cleanPlace(ev.city || ev.location); if (p && places[places.length - 1] !== p) places.push(p); });
    return {
        scans: scans.length,
        lastScanAt: last ? isoAt(last) : null,
        progressPct: settled ? 100 : steps.length ? Math.round(((done + grow) / steps.length) * 100) : 0,
        hubsVisited: places.length,
        route: places.slice(-6)
    };
}

function buildCustomerTracking(order, events, opts) {
    const options = opts || {};
    const nowMs = options.now || Date.now();
    const cancelled = String(order.status || '') === 'cancelled';
    const storedMain = cancelled ? 'ORDERED' : mainKeyFromOrder(order);
    const operational = cancelled ? null : operationalFromEvents(events);
    const scanned = cancelled ? null : mainKeyFromEvents(events);
    const mainStatus = scanned && MAIN.indexOf(scanned) > MAIN.indexOf(storedMain) ? scanned : storedMain;
    const mainIndex = MAIN.indexOf(mainStatus);
    const type = fulfillmentType(order);
    const hyper = type === 'HYPERLOCAL';
    const tookan = order.commerceProvider === 'tookan';
    const otpCourier = tookan || order.commerceProvider === 'fleetbase' || order.commerceProvider === 'pidge';
    const failed = operational === 'DELIVERY_ATTEMPT_FAILED';
    const rescheduled = operational === 'RESCHEDULED';
    const statuses = customerStatuses(order, { shop: options.shop, store: options.store });
    const pipeline = statuses.map((step, index) => ({
        key: step.key,
        title: step.title,
        message: step.message,
        expectedLabel: step.expectedLabel,
        state: cancelled ? 'upcoming' : index < mainIndex ? 'done' : index === mainIndex ? 'active' : 'upcoming'
    }));
    const timeline = [];
    (events || []).forEach((ev) => {
        const line = customerEvent(ev, { hyperlocal: hyper });
        if (!line) return;
        timeline.push(line);
    });
    const namedHub = timeline.some((ev) => /^arrived at\s+\S/i.test(ev.message) && !/courier facility/i.test(ev.message));
    if (namedHub) {
        for (let i = timeline.length - 1; i >= 0; i--) {
            if (timeline[i].message === 'Item arrived at courier facility') timeline.splice(i, 1);
        }
    }
    timeline.sort((a, b) => {
        const ta = a.at ? Date.parse(a.at) || 0 : 0;
        const tb = b.at ? Date.parse(b.at) || 0 : 0;
        return ta - tb;
    });
    const collapsed = [];
    timeline.forEach((ev) => {
        const prev = collapsed[collapsed.length - 1];
        const prevMs = prev && prev.at ? Date.parse(prev.at) || 0 : 0;
        const nextMs = ev.at ? Date.parse(ev.at) || 0 : 0;
        const same = prev && prev.parentStage === ev.parentStage && prev.message === ev.message && !prev.internal && !ev.internal;
        if (same && Math.abs(nextMs - prevMs) < 30 * 60 * 1000) {
            if (nextMs >= prevMs) collapsed[collapsed.length - 1] = ev;
            return;
        }
        collapsed.push(ev);
    });
    timeline.length = 0;
    collapsed.forEach((ev) => timeline.push(ev));
    if (order.createdAt && !timeline.some((ev) => ev.parentStage === 'ORDERED')) {
        timeline.unshift({
            parentStage: 'ORDERED',
            message: 'Your order has been placed',
            at: order.createdAt,
            location: null,
            reason: null,
            tone: '',
            internal: false
        });
    }
    if (!hyper && !cancelled) {
        const pickedEvents = timeline.filter((ev) => ev.parentStage === 'SHIPPED' && /picked up|accepted by courier/i.test(String(ev.message || '')));
        pickedEvents.forEach((ev) => { ev.parentStage = 'PICKED_UP'; });
        const pickedDone = mainIndex >= MAIN.indexOf('SHIPPED');
        pipeline.splice(MAIN.indexOf('SHIPPED'), 0, {
            key: 'PICKED_UP',
            title: 'Picked up by delivery partner',
            message: pickedDone ? 'Your parcel has been collected from the store' : 'The delivery partner collects your parcel from the store',
            expectedLabel: pickedDone ? '' : (pipeline[MAIN.indexOf('PACKED')] || {}).expectedLabel || '',
            state: pickedDone ? 'done' : 'upcoming'
        });
    }
    const activeIndex = pipeline.findIndex((step) => step.state === 'active');
    pipeline.forEach((step) => {
        step.events = timeline.filter((ev) => ev.parentStage === step.key && !ev.internal);
    });
    const showPartner = !cancelled && operational !== 'DELIVERY_ATTEMPT_FAILED' && operational !== 'RESCHEDULED' && (mainStatus === 'OUT_FOR_DELIVERY' || (hyper && mainStatus === 'SHIPPED' && (order.agentName || order.agentPhone)));
    const freshGps = locationIsFresh(order.agentLocationAt);
    const agent = showPartner && (order.agentName || order.agentPhone)
        ? {
              name: order.agentName || null,
              phone: order.agentPhone || null,
              latitude: freshGps && order.agentLat != null ? Number(order.agentLat) : null,
              longitude: freshGps && order.agentLng != null ? Number(order.agentLng) : null
          }
        : null;
    const fwdTasks = order.parcelInfo && Array.isArray(order.parcelInfo.tasks) ? order.parcelInfo.tasks : [];
    const taskOtp = (kind) => {
        const hits = fwdTasks.filter((t) => t.type === kind && t.otp);
        return hits.length ? (kind === 'Delivery' ? hits[hits.length - 1] : hits[0]).otp : '';
    };
    const pickupOtp = otpCourier && mainStatus === 'PACKED' && operational !== 'DELIVERY_ATTEMPT_FAILED' && (order.pickupOtp || taskOtp('Pickup')) ? String(order.pickupOtp || taskOtp('Pickup')) : null;
    const deliveryVisible = mainStatus === 'SHIPPED' || mainStatus === 'OUT_FOR_DELIVERY' || mainStatus === 'DELIVERED';
    const deliveryOtp = otpCourier && deliveryVisible && operational !== 'DELIVERY_ATTEMPT_FAILED' && (order.deliveryOtp || taskOtp('Delivery')) ? String(order.deliveryOtp || taskOtp('Delivery')) : null;
    const taskDone = (kind) => {
        const hits = fwdTasks.filter((t) => t.type === kind);
        const t = hits.length ? (kind === 'Delivery' ? hits[hits.length - 1] : hits[0]) : null;
        return !!(t && Number(t.status) === 2);
    };
    const pickupOtpVerified = !!(order.pickupOtp || taskOtp('Pickup')) && (taskDone('Pickup') || ['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(mainStatus));
    const deliveryOtpVerified = !!(order.deliveryOtp || taskOtp('Delivery')) && (taskDone('Delivery') || mainStatus === 'DELIVERED');
    const stageRank = { ORDERED: 0, PACKED: 2, SHIPPED: 3, OUT_FOR_DELIVERY: 4, DELIVERED: 5 };
    const enteredMs = (() => {
        const want = mainStatus === 'OUT_FOR_DELIVERY' ? ['out_for_delivery', 'at_drop'] : mainStatus === 'SHIPPED' ? ['pickup'] : [];
        const ms = (events || []).filter((ev) => want.indexOf(eventBucket(ev)) >= 0).map(stampMs).filter((v) => Number.isFinite(v) && v > 0);
        return ms.length ? Math.min.apply(null, ms) : NaN;
    })();
    const scheduled = !cancelled && !failed ? scheduleWindow(order, stageRank[mainStatus] || 0, enteredMs) : null;
    if (scheduled && activeIndex >= 0 && pipeline[activeIndex]) {
        pipeline[activeIndex].lineSince = scheduled.since;
        pipeline[activeIndex].lineUntil = scheduled.until;
        pipeline[activeIndex].lineGrow = lineGrow(scheduled.since, scheduled.until, nowMs);
    }
    if (!hyper && !cancelled && activeIndex >= 0 && pipeline[activeIndex].key === 'OUT_FOR_DELIVERY' && order.parcelInfo && order.parcelInfo.queue && order.parcelInfo.queue.position) {
        const q = order.parcelInfo.queue;
        const share = q.total > 1 ? (q.total - q.position) / (q.total - 1) : 1;
        pipeline[activeIndex].lineGrow = Math.max(Number(pipeline[activeIndex].lineGrow) || 0, Math.round((0.4 + 0.48 * share) * 100) / 100);
        pipeline[activeIndex].queue = { position: q.position, total: q.total, ahead: q.ahead, agent: q.agent || null };
    }
    const current = statusCopy(hyper)[mainStatus];
    const mapEnabled = hyper && !cancelled && storedMain !== 'DELIVERED' && !failed && !rescheduled;
    const windowText = windowLabel(order.rescheduledForStart, order.rescheduledForEnd);
    const dropLine = String(order.deliveryAddress || '').replace(/\s+/g, ' ').trim();
    const hours = {
        open: (options.shop && options.shop.deliveryOpen) || '10:00',
        close: (options.shop && options.shop.deliveryClose) || '20:00'
    };
    const out = {
        orderId: order.orderCode || null,
        fulfillmentType: type,
        mainStatus,
        operationalStatus: operational,
        currentStatus: cancelled ? 'Cancelled' : failed ? 'Delivery attempt unsuccessful' : operational === 'RESCHEDULED' ? 'Delivery rescheduled' : current.title,
        currentMessage: cancelled
            ? 'This order was cancelled.'
            : failed
              ? 'Delivery attempt unsuccessful'
              : operational === 'RESCHEDULED'
                ? 'Delivery rescheduled'
                : current.message,
        currentDetail: failed
            ? "We couldn't complete the delivery attempt. You can reschedule your delivery."
            : rescheduled
              ? windowText
                ? 'Your order will be attempted again on ' + windowText + '.'
                : 'Your order will be attempted again on the time you chose.'
              : null,
        expectedDelivery: order.rescheduledForStart
            ? { start: order.rescheduledForStart, end: order.rescheduledForEnd || null, label: windowText || null }
            : null,
        slots: failed && hyper ? deliverySlots(options.shop || null) : [],
        deliveryHours: failed && hyper ? hours : null,
        supportUrl: '/support',
        contact: !cancelled && (order.agentName || order.agentPhone)
            ? { name: order.agentName || null, phone: order.agentPhone || null }
            : null,
        shipment: {
            courier: order.commerceProvider ? 'Gogate Products' : order.courierProvider || null,
            provider: order.commerceProvider || null,
            trackingId: order.courierTrackingNo || null
        },
        agent,
        pickupOtp: pickupOtpVerified ? null : pickupOtp,
        deliveryOtp: deliveryOtpVerified ? null : deliveryOtp,
        pickupOtpVerified,
        deliveryOtpVerified,
        otpSupported: !!otpCourier && !cancelled,
        deliveryBy: mainStatus === 'DELIVERED' ? '' : deliveryByLabel(order),
        dates: shipmentDates(order, mainStatus, timeline),
        latestUpdate: latestVerified(timeline),
        health: null,
        security: null,
        package: null,
        appointment: {
            current: (order.appointments || []).slice(-1)[0] || null,
            history: order.appointments || [],
            eligible: !hyper && !cancelled && (failed || mainStatus === 'OUT_FOR_DELIVERY' || (mainStatus === 'SHIPPED' && (events || []).some((ev) => ['hub_arrived', 'hub_left', 'crossdock', 'handover'].includes(eventBucket(ev))))),
            slots: hyper ? [] : deliverySlots(options.shop || null),
            courierPush: ['tookan', 'shipday', 'fleetbase'].includes(String(order.commerceProvider || ''))
        },
        notifyPrefs: order.notifyPrefs || {},
        issue: lastIssue(events),
        timing: shipmentTiming(order, mainStatus, timeline, nowMs, { shop: options.shop, store: options.store }),
        deliveryNote: mapEnabled ? String(order.deliveryNote || '').replace(/\s+/g, ' ').trim().slice(0, 240) : null,
        dropLabel: mapEnabled && dropLine ? (dropLine.length > 80 ? dropLine.slice(0, 77) + '...' : dropLine) : null,
        map: { enabled: mapEnabled, live: mapEnabled && !!(agent && agent.latitude != null) },
        proximity: proximityState(order, { nowMs, mainStatus, failed }),
        hyperlocal: hyper && !cancelled ? hyperlocalInsights(order, events, { nowMs, mainStatus, failed, agent, plan: expectedPlan(order, options.shop, options.store) }) : null,
        pipeline,
        timeline,
        courierStatus: cancelled ? null : courierStatusView(events, timeline, mainStatus, order),
        stats: shipmentStats(timeline, pipeline, nowMs),
        providerStatus: order.courierTrackLabel || null,
        consignment: consignmentView(order),
        attempts: attemptsView(order, events)
    };
    if (!cancelled) {
        const sellerPlan = expectedPlan(
            Object.assign({}, order, { pickupAt: null, deliveryAt: null, courierEtaAt: null, courierEtaText: null }),
            options.shop,
            options.store
        );
        out.health = shipmentIntelligence(order, events, timeline, { nowMs, mainStatus, hyper, failed, sellerPlan, livePlan: expectedPlan(order, options.shop, options.store) });
    }
    out.security = securityView(order, out);
    out.package = packageView(order, out, options);
    return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(v) {
    if (!v) return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const str = String(v).trim();
    if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str)) return Date.parse(str.replace(' ', 'T') + 'Z');
    return Date.parse(str);
}

function shippingZone(order, shop, store) {
    const st = String((order && order.shippingState) || '').trim().toLowerCase();
    const city = String((order && order.shippingCity) || '').trim().toLowerCase();
    const pin = String((order && order.shippingPincode) || '').trim();
    const storeState = String((store && store.state) || '').trim().toLowerCase();
    const storeCity = String((store && store.city) || '').trim().toLowerCase();
    const storePin = String((store && store.pincode) || '').trim();
    if ((city && storeCity && city === storeCity) || (pin.length >= 3 && storePin.length >= 3 && pin.slice(0, 3) === storePin.slice(0, 3))) return 'local';
    const zonal = String((shop && shop.zonalStates) || '').toLowerCase().split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
    if ((st && storeState && st === storeState) || (st && zonal.includes(st)) || (pin.length >= 2 && storePin.length >= 2 && pin.slice(0, 2) === storePin.slice(0, 2))) return 'zonal';
    return 'national';
}

function endOfIstDay(ms) {
    const parts = istDateParts(ms);
    return Date.parse(parts.year + '-' + parts.month + '-' + parts.day + 'T23:59:59+05:30');
}

/** Seller-configured expected dates: packed, pickup, shipped, out for delivery, delivery. */
function expectedPlan(order, shop, store) {
    if (!order || String(order.status || '') === 'cancelled') return null;
    const placedMs = toMs(order.createdAt);
    if (!Number.isFinite(placedMs)) return null;
    const cfg = shop || {};
    const hyper = order.commerceMode === 'hyperlocal';
    const pickupOnly = order.fulfillmentType === 'pickup';
    const packHours = Math.max(1, Number(cfg.packHours) || 8);
    const pickupDays = Math.max(0, Number(cfg.pickupDays) || 1);
    const zone = hyper || pickupOnly ? 'local' : shippingZone(order, cfg, store);
    const transit = hyper ? 0 : zone === 'local' ? Number(cfg.transitLocalDays) || 3 : zone === 'zonal' ? Number(cfg.transitZonalDays) || 4 : Number(cfg.transitNationalDays) || 6;
    const tt = taskTimes(order);
    const packedMs = placedMs + packHours * 60 * 60 * 1000;
    let pickupMs = hyper ? packedMs + 60 * 60 * 1000 : endOfIstDay(packedMs + pickupDays * DAY_MS);
    let source = 'seller_settings';
    const courierPickupMs = Number.isFinite(toMs(order.pickupAt)) ? toMs(order.pickupAt) : tt.pickup;
    if (!pickupOnly && Number.isFinite(courierPickupMs)) {
        pickupMs = courierPickupMs;
        source = 'courier';
    }
    const shippedMs = pickupMs;
    let deliveryMs = hyper ? pickupMs + 2 * 60 * 60 * 1000 : endOfIstDay(pickupMs + transit * DAY_MS);
    const courierDeliveryMs = Number.isFinite(toMs(order.deliveryAt)) ? toMs(order.deliveryAt) : tt.delivery;
    if (!pickupOnly && Number.isFinite(courierDeliveryMs) && courierDeliveryMs > pickupMs) {
        deliveryMs = courierDeliveryMs;
        source = 'courier';
    }
    if (order.courierEtaAt && Number.isFinite(toMs(order.courierEtaAt))) {
        deliveryMs = toMs(order.courierEtaAt);
        source = 'courier';
    }
    if (order.rescheduledForStart && Number.isFinite(toMs(order.rescheduledForStart))) {
        deliveryMs = toMs(order.rescheduledForEnd || order.rescheduledForStart);
        source = 'rescheduled';
    }
    if (order.deliverySlot && order.deliverySlot.date && order.deliverySlot.end && source === 'seller_settings') {
        const slotMs = Date.parse(order.deliverySlot.date + 'T' + order.deliverySlot.end + ':00+05:30');
        if (Number.isFinite(slotMs) && slotMs >= deliveryMs - DAY_MS) {
            deliveryMs = slotMs;
            source = 'slot';
        }
    }
    const ofdMs = hyper ? deliveryMs - 60 * 60 * 1000 : Date.parse(istDateParts(deliveryMs).year + '-' + istDateParts(deliveryMs).month + '-' + istDateParts(deliveryMs).day + 'T08:00:00+05:30');
    const iso = (ms) => new Date(ms).toISOString();
    return {
        zone,
        source,
        packedAt: iso(packedMs),
        pickupAt: pickupOnly ? null : iso(pickupMs),
        shippedAt: pickupOnly ? null : iso(shippedMs),
        outForDeliveryAt: pickupOnly ? null : iso(ofdMs),
        deliveryAt: iso(deliveryMs),
        deliveryText: order.courierEtaText || null,
        slot: order.deliverySlot || null
    };
}

/** Customer-selectable delivery windows for the next few days (seller delivery hours split by slotHours). */
function deliverySlotOptions(shop, firstDayMs, days) {
    const cfg = shop || {};
    if (cfg.slotsEnabled === false) return [];
    const open = minutesOf(cfg.deliveryOpen || '10:00');
    const close = minutesOf(cfg.deliveryClose || '20:00');
    if (open == null || close == null || close <= open) return [];
    const span = Math.max(60, (Number(cfg.slotHours) || 3) * 60);
    const out = [];
    for (let d = 0; d < (days || 4); d++) {
        const dayMs = (firstDayMs || Date.now()) + d * DAY_MS;
        const parts = istDateParts(dayMs);
        const date = parts.year + '-' + parts.month + '-' + parts.day;
        let cursor = open;
        while (cursor + span <= close) {
            const start = hhmmOf(cursor);
            const end = hhmmOf(cursor + span);
            out.push({ date, start, end, label: slotLabel(date, start, end, Date.now()) });
            cursor += span;
        }
    }
    return out;
}

const RETURN_LABELS = {
    REQUESTED: ['Return requested', 'We received your request and the store is reviewing it.'],
    APPROVED: ['Approved', 'The store approved the request. A pickup will be arranged.'],
    PICKUP_SCHEDULED: ['Pickup scheduled', 'A courier partner will collect the item from your address.'],
    OUT_FOR_PICKUP: ['Out for pickup', 'The pickup agent is on the way to collect the item from you.'],
    PICKED_UP: ['Picked up', 'The item has been collected from you.'],
    IN_TRANSIT: ['On the way back', 'The item is travelling back to the store.'],
    RECEIVED: ['Received at store', 'The store received the item and is checking it.'],
    REFUNDED: ['Refund issued', 'The refund is sent to your original payment method.'],
    REPLACEMENT_PREPARING: ['Replacement being prepared', 'The store is packing your replacement.'],
    REPLACEMENT_SENT: ['Replacement shipped', 'Your replacement is on its way.'],
    REPLACEMENT_DELIVERED: ['Replacement delivered', 'Your replacement has been delivered.']
};

function returnStageOf(text) {
    const t = String(text || '').toLowerCase();
    if (/replacement[_ ]delivered/.test(t)) return 'REPLACEMENT_DELIVERED';
    if (/replacement[_ ](sent|shipped)/.test(t)) return 'REPLACEMENT_SENT';
    if (/replacement[_ ]prepar/.test(t)) return 'REPLACEMENT_PREPARING';
    if (/refund/.test(t)) return 'REFUNDED';
    if (/received|reached (the )?store/.test(t)) return 'RECEIVED';
    if (/in[_ ]transit|back to the store|on the way back|return shipment|awb|courier facility|next facility|hub/.test(t)) return 'IN_TRANSIT';
    if (/picked up|collected|pickup (complete|successful|done)/.test(t)) return 'PICKED_UP';
    if (/out for pickup|agent on the way|on the way to you|reached your location|agent assigned|agent reached/.test(t)) return 'OUT_FOR_PICKUP';
    if (/pickup|pick up|scheduled|agent|otp/.test(t)) return 'PICKUP_SCHEDULED';
    if (/approved/.test(t)) return 'APPROVED';
    if (/rejected|declined/.test(t)) return 'REJECTED';
    return 'REQUESTED';
}

/** Customer-facing return / replacement tracking in the same shape as buildCustomerTracking. */
const RETURN_WORDING = [
    [/^shipment arrived at (courier|delhivery|\w+) facility/i, 'Return parcel reached the courier hub'],
    [/^shipment left (for next facility|courier facility|\w+ facility)/i, 'Return parcel left the courier hub'],
    [/^shipment picked up$/i, 'Item picked up from you'],
    [/^out for delivery$/i, 'Return parcel on the way back to the store'],
    [/^delivered$/i, 'Return received at store']
];
function returnWording(message) {
    const hit = RETURN_WORDING.find(([re]) => re.test(String(message || '').trim()));
    return hit ? hit[1] : message;
}
function buildReturnTracking(order, returnEvents, opts) {
    if (!order || !order.returnStatus) return null;
    const options = opts || {};
    const shop = options.shop || {};
    const replacement = order.returnKind === 'replacement';
    const keys = ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'OUT_FOR_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED'].concat(
        replacement ? ['REPLACEMENT_PREPARING', 'REPLACEMENT_SENT', 'REPLACEMENT_DELIVERED'] : ['REFUNDED']
    );
    const rejected = order.returnStatus === 'rejected';
    let mainStatus = rejected ? 'REQUESTED' : String(order.returnStatus).toUpperCase();
    const events = (returnEvents || [])
        .map((ev) => {
            const title = String(ev.title || ev.description || '').trim();
            const detail = String(ev.detail || ev.location || '').trim();
            const status = /^[a-z_]+$/.test(detail) ? detail : '';
            const stage = returnStageOf(status || title + ' ' + detail);
            const labelled = status && RETURN_LABELS[status.toUpperCase()] ? RETURN_LABELS[status.toUpperCase()][0] : null;
            return {
                parentStage: stage === 'REJECTED' ? 'REQUESTED' : stage,
                message: returnWording(/^return status updated$/i.test(title) ? labelled || detail || title : title),
                at: ev.at ? new Date(toMs(ev.at)).toISOString() : null,
                location: status ? null : detail || null,
                reason: null,
                tone: stage === 'REJECTED' ? 'failed' : '',
                internal: false
            };
        })
        .sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0))
        .filter((ev, i, arr) => arr.findIndex((o) => o.message === ev.message && o.parentStage === ev.parentStage) === i);
    // courier pickup scans (out for pickup / picked up) advance the stored "pickup_scheduled" status
    if (mainStatus === 'PICKUP_SCHEDULED') {
        const seen = events.map((ev) => keys.indexOf(ev.parentStage)).filter((i) => i >= 0);
        const top = seen.length ? Math.max(...seen) : -1;
        if (top >= keys.indexOf('OUT_FOR_PICKUP') && top <= keys.indexOf('IN_TRANSIT')) mainStatus = keys[top];
    }
    const mainIndex = Math.max(0, keys.indexOf(mainStatus));
    const firstAt = events.length && events[0].at ? events[0].at : order.updatedAt || null;
    if (!events.some((ev) => ev.parentStage === 'REQUESTED')) {
        events.unshift({ parentStage: 'REQUESTED', message: (replacement ? 'Replacement' : 'Return') + ' requested', at: firstAt, location: null, reason: null, tone: '', internal: false });
    }
    const scheduledMs = toMs(order.returnScheduledAt);
    const transitDays = Number(shop.transitZonalDays) || 4;
    const expected = {};
    const courierReturnMs = toMs(order.returnExpectedAt);
    let returnTiming = null;
    if (Number.isFinite(scheduledMs) && !rejected) {
        const sellerAtStoreMs = endOfIstDay(scheduledMs + transitDays * DAY_MS);
        const received = ['RECEIVED', 'REFUNDED', 'REPLACEMENT_PREPARING', 'REPLACEMENT_SENT', 'REPLACEMENT_DELIVERED'].includes(mainStatus);
        const receivedEv = events.filter((ev) => ev.parentStage === 'RECEIVED' && ev.at).pop();
        const actualMs = received ? toMs(receivedEv && receivedEv.at) : Number.isFinite(courierReturnMs) ? courierReturnMs : NaN;
        if (Number.isFinite(actualMs)) {
            const diff = actualMs - sellerAtStoreMs;
            returnTiming =
                diff < -EARLY_LATE_TOLERANCE_MS
                    ? { state: 'early', label: received ? 'Received early' : 'Arriving early' }
                    : diff > EARLY_LATE_TOLERANCE_MS
                      ? { state: 'delayed', label: received ? 'Received late' : 'Running late' }
                      : { state: 'on_time', label: 'On time' };
        } else if (!received && Date.now() > sellerAtStoreMs + EARLY_LATE_TOLERANCE_MS) {
            returnTiming = { state: 'delayed', label: 'Running late' };
        }
    }
    if (Number.isFinite(scheduledMs)) {
        const atStoreMs = Number.isFinite(courierReturnMs) && courierReturnMs > scheduledMs ? courierReturnMs : endOfIstDay(scheduledMs + transitDays * DAY_MS);
        expected.PICKUP_SCHEDULED = 'Pickup ' + expectedWhen(new Date(scheduledMs).toISOString());
        expected.OUT_FOR_PICKUP = 'Expected pickup ' + expectedWhen(new Date(scheduledMs).toISOString());
        expected.IN_TRANSIT = 'Expected at store by ' + expectedWhen(new Date(atStoreMs).toISOString());
        expected.RECEIVED = 'Expected at store by ' + expectedWhen(new Date(atStoreMs).toISOString());
        const after = endOfIstDay(atStoreMs + 2 * DAY_MS);
        if (replacement) {
            expected.REPLACEMENT_PREPARING = 'Expected by ' + expectedWhen(new Date(after).toISOString());
            expected.REPLACEMENT_SENT = 'Expected shipping ' + expectedWhen(new Date(endOfIstDay(after + DAY_MS)).toISOString());
            expected.REPLACEMENT_DELIVERED = 'Expected ' + expectedWhen(new Date(endOfIstDay(after + (transitDays + 1) * DAY_MS)).toISOString());
        } else {
            expected.REFUNDED = 'Expected within 5–7 working days of receipt';
        }
    } else if (!rejected && mainIndex < 2) {
        const packHours = Math.max(1, Number(shop.packHours) || 24);
        const base = toMs(firstAt) || Date.now();
        expected.APPROVED = 'Expected by ' + expectedWhen(new Date(base + packHours * 60 * 60 * 1000).toISOString());
        expected.PICKUP_SCHEDULED = 'Expected by ' + expectedWhen(new Date(endOfIstDay(base + (1 + (Number(shop.pickupDays) || 0)) * DAY_MS)).toISOString());
    }
    const pipeline = keys.map((key, index) => ({
        key,
        title: RETURN_LABELS[key][0],
        message: RETURN_LABELS[key][1],
        expectedLabel: expected[key] || '',
        state: rejected ? (index === 0 ? 'active' : 'upcoming') : index < mainIndex ? 'done' : index === mainIndex ? 'active' : 'upcoming',
        events: events.filter((ev) => ev.parentStage === key)
    }));
    const link = String(order.returnTrackingLink || '');
    const awb = /^[A-Z0-9-]{6,}$/i.test(link) ? link : (link.match(/(?:wbn|waybill|awb|tracking_id|trackingId|id)=([A-Za-z0-9-]{6,})/i) || [])[1] || null;
    const current = rejected ? ['Request declined', 'The store could not accept this request. Contact support for help.'] : RETURN_LABELS[mainStatus] || RETURN_LABELS.REQUESTED;
    const returnTasks = (order.returnParcelInfo && Array.isArray(order.returnParcelInfo.tasks) ? order.returnParcelInfo.tasks : []);
    const liveStage = ['PICKUP_SCHEDULED', 'OUT_FOR_PICKUP', 'PICKED_UP', 'IN_TRANSIT'].includes(mainStatus);
    return {
        kind: replacement ? 'replacement' : 'return',
        orderId: order.orderCode || null,
        replacementOrderId: order.replacementOrderId || null,
        datesSource: Number.isFinite(courierReturnMs) ? 'courier' : 'seller_settings',
        fulfillmentType: 'LOGISTICS',
        mainStatus,
        operationalStatus: rejected ? 'REJECTED' : null,
        rejected,
        currentStatus: current[0],
        currentMessage: current[1],
        currentDetail: order.returnReason ? 'Reason: ' + order.returnReason : null,
        supportUrl: '/support',
        shipment: {
            courier: order.returnProvider
                ? ['tookan', 'shipday', 'pidge', 'fleetbase'].includes(String(order.returnProvider).toLowerCase())
                    ? 'Gogate Products'
                    : order.returnProvider.charAt(0).toUpperCase() + order.returnProvider.slice(1)
                : null,
            provider: order.returnProvider || null,
            trackingId: awb
        },
        timing: returnTiming,
        agent: liveStage && (order.returnAgentName || order.returnAgentPhone) ? { name: order.returnAgentName || null, phone: order.returnAgentPhone || null } : null,
        pickupOtp: liveStage ? String(order.returnPickupOtp || (returnTasks.find((t) => t.type === 'Pickup' && t.otp) || {}).otp || '') || null : null,
        deliveryOtp: liveStage ? (returnTasks.find((t) => t.type === 'Delivery' && t.otp) || {}).otp || null : null,
        deliveryBy: '',
        dates: null,
        progressPct: rejected ? 0 : Math.round((mainIndex / Math.max(1, keys.length - 1)) * 100),
        pickupWindow: order.returnScheduledAt || null,
        map: { enabled: false, live: false },
        pipeline,
        timeline: events
    };
}

module.exports = {
    courierStatusView,
    shipmentStats,
    PREP_STEPS,
    OPS_ACTIONS,
    buildReturnTracking,
    expectedPlan,
    expectedWhen,
    shippingZone,
    deliverySlotOptions,
    MAIN,
    mainKeyFromOrder,
    allowMainTransition,
    acceptsStageChange,
    shipmentTiming,
    shipmentDates,
    fulfillmentType,
    buildCustomerTracking,
    deliverySlots,
    slotAllowed,
    operationalFromEvents,
    windowLabel,
    scheduleWindow,
    deliveryByLabel,
    customerEvent,
    customerStatuses,
    expectedWhen
};

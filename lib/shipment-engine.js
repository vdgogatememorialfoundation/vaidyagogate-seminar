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

function allowMainTransition(fromKey, toKey) {
    const from = MAIN.indexOf(fromKey);
    const to = MAIN.indexOf(toKey);
    if (from < 0 || to < 0) return false;
    return to >= from && to <= from + 1;
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
    out_for_delivery: 'OUT_FOR_DELIVERY',
    at_drop: 'OUT_FOR_DELIVERY',
    failed: 'OUT_FOR_DELIVERY',
    rescheduled: 'OUT_FOR_DELIVERY',
    delivered: 'DELIVERED'
};

function eventBucket(ev) {
    const kind = String(ev.kind || '').toLowerCase();
    const text = (String(ev.title || '') + ' ' + String(ev.detail || '')).toLowerCase();
    if (/^expected at\b/.test(text) || kind === 'hub_eta') return 'schedule';
    if (kind === 'placed' || /order placed|your order has been placed/.test(text)) return 'ordered';
    if (kind === 'accepted' || kind === 'preparing' || /preparing your order|seller is preparing/.test(text)) return 'processing';
    if (kind === 'failed' || /attempt failed|attempt was unsuccessful|delivery failed|could not be completed|couldn.?t deliver/.test(text)) return 'failed';
    if (kind === 'rescheduled' || /has been rescheduled|delivery rescheduled/.test(text)) return 'rescheduled';
    if (kind === 'delivered' || /\bdelivered\b|delivery completed/.test(text)) return 'delivered';
    if (kind === 'at_drop' || /reached (the |your )?(drop|delivery location|customer)/.test(text)) return 'at_drop';
    if (kind === 'out_for_delivery' || /out for delivery/.test(text)) return 'out_for_delivery';
    if (kind === 'picked_up' || /picked up/.test(text)) return 'pickup';
    if (kind === 'arrived_facility' || /arrived at courier facility|shipment arrived|shipment received at\b/.test(text)) return 'hub_arrived';
    if (kind === 'left_facility' || /left a courier facility|shipment left|left courier/.test(text)) return 'hub_left';
    if (kind === 'at_pickup' || /reached the pickup/.test(text)) return 'at_pickup';
    if (kind === 'to_store' || /on the way to pick/.test(text)) return 'to_pickup';
    if (kind === 'agent_assigned' || /assigned for pickup|partner assigned|agent assigned/.test(text)) return 'agent_assigned';
    if (kind === 'pickup_scheduled' || /pickup requested|pickup scheduled/.test(text)) return 'pickup_requested';
    if (kind === 'ready' || kind === 'ready_for_pickup' || /\bpacked\b/.test(text)) return 'packed';
    return 'update';
}

function eventMessage(bucket, ev, hyper) {
    if (bucket === 'ordered') return 'Your order has been placed';
    if (bucket === 'processing') return 'Seller is preparing your order';
    if (bucket === 'packed') return hyper ? 'Your order is packed at the store' : 'Your item has been packed';
    if (bucket === 'pickup_requested') return hyper ? 'Pickup requested from the store' : 'Pickup requested from courier partner';
    if (bucket === 'agent_assigned') return hyper ? 'Delivery partner assigned' : 'Courier partner assigned for pickup';
    if (bucket === 'to_pickup') return hyper ? 'Delivery partner is on the way to the store' : 'Courier partner is on the way to pickup';
    if (bucket === 'at_pickup') return hyper ? 'Delivery partner reached the store' : 'Courier partner reached the pickup point';
    if (bucket === 'pickup') return hyper ? 'Your order has been picked up' : 'Your item has been picked up by courier partner';
    if (bucket === 'hub_arrived') {
        const arrived = String((ev && ev.title) || '').trim();
        if (/^shipment received at\s+\S/i.test(arrived)) return arrived;
        if (/^arrived at\s+\S/i.test(arrived) && !/courier facility/i.test(arrived)) return arrived;
        return 'Item arrived at courier facility';
    }
    if (bucket === 'hub_left') {
        const left = String((ev && ev.title) || '').trim();
        if (/^shipment left\s+\S/i.test(left)) return left;
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
        tone: bucket === 'failed' ? 'failed' : bucket === 'rescheduled' ? 'rescheduled' : '',
        internal: bucket === 'schedule'
    };
    if (bucket === 'hub_arrived' || bucket === 'hub_left') {
        row.city = cleanPlace(ev && ev.city) || null;
        row.state = (ev && ev.state) || null;
        row.country = (ev && ev.country) || null;
        row.facilityName = cleanPlace(ev && (ev.facility || ev.detail)) || null;
    }
    return row;
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

function scheduleWindow(order, rank) {
    const pickup = order && order.pickupAt ? Date.parse(order.pickupAt) : NaN;
    const delivery = order && order.deliveryAt ? Date.parse(order.deliveryAt) : NaN;
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
        const since = pickupMs || createdMs || deliveryMs - 3 * 60 * 60 * 1000;
        if (deliveryMs > since) return { since, until: deliveryMs };
    }
    if (rank >= 3 && deliveryMs) {
        const since = pickupMs || createdMs;
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

function customerStatuses(order) {
    const hyper = fulfillmentType(order) === 'HYPERLOCAL';
    const copy = statusCopy(hyper);
    const pickup = expectedWhen(order && order.pickupAt);
    const drop = order && order.rescheduledForStart
        ? windowLabel(order.rescheduledForStart, order.rescheduledForEnd)
        : expectedWhen(order && order.deliveryAt);
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

function buildCustomerTracking(order, events, opts) {
    const options = opts || {};
    const nowMs = options.now || Date.now();
    const cancelled = String(order.status || '') === 'cancelled';
    const storedMain = cancelled ? 'ORDERED' : mainKeyFromOrder(order);
    const operational = cancelled ? null : operationalFromEvents(events);
    const mainStatus = storedMain;
    const mainIndex = MAIN.indexOf(mainStatus);
    const type = fulfillmentType(order);
    const hyper = type === 'HYPERLOCAL';
    const tookan = order.commerceProvider === 'tookan';
    const otpCourier = tookan || order.commerceProvider === 'fleetbase';
    const failed = operational === 'DELIVERY_ATTEMPT_FAILED';
    const rescheduled = operational === 'RESCHEDULED';
    const statuses = customerStatuses(order);
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
    const pickupOtp = otpCourier && mainStatus === 'PACKED' && operational !== 'DELIVERY_ATTEMPT_FAILED' && order.pickupOtp ? String(order.pickupOtp) : null;
    const deliveryOtp = (otpCourier || order.commerceProvider === 'pidge') && mainStatus === 'OUT_FOR_DELIVERY' && operational !== 'DELIVERY_ATTEMPT_FAILED' && order.deliveryOtp ? String(order.deliveryOtp) : null;
    const stageRank = { ORDERED: 0, PACKED: 2, SHIPPED: 3, OUT_FOR_DELIVERY: 4, DELIVERED: 5 };
    const scheduled = !cancelled && !failed ? scheduleWindow(order, stageRank[mainStatus] || 0) : null;
    if (scheduled && pipeline[mainIndex]) {
        pipeline[mainIndex].lineSince = scheduled.since;
        pipeline[mainIndex].lineUntil = scheduled.until;
        pipeline[mainIndex].lineGrow = lineGrow(scheduled.since, scheduled.until, nowMs);
    }
    const current = statusCopy(hyper)[mainStatus];
    const mapEnabled = hyper && !cancelled && storedMain !== 'DELIVERED' && !failed && !rescheduled;
    const windowText = windowLabel(order.rescheduledForStart, order.rescheduledForEnd);
    const dropLine = String(order.deliveryAddress || '').replace(/\s+/g, ' ').trim();
    const hours = {
        open: (options.shop && options.shop.deliveryOpen) || '10:00',
        close: (options.shop && options.shop.deliveryClose) || '20:00'
    };
    return {
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
        pickupOtp,
        deliveryOtp,
        deliveryBy: deliveryByLabel(order),
        deliveryNote: mapEnabled ? String(order.deliveryNote || '').replace(/\s+/g, ' ').trim().slice(0, 240) : null,
        dropLabel: mapEnabled && dropLine ? (dropLine.length > 80 ? dropLine.slice(0, 77) + '...' : dropLine) : null,
        map: { enabled: mapEnabled, live: mapEnabled && !!(agent && agent.latitude != null) },
        pipeline,
        timeline,
        providerStatus: order.courierTrackLabel || null
    };
}

module.exports = {
    MAIN,
    mainKeyFromOrder,
    allowMainTransition,
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

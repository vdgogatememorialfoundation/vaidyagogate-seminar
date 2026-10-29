/**
 * Customer-facing order tracker for the private shop:
 * Logistics: Ordered, Packed, Shipped, Out for delivery, Delivered.
 * Hyperlocal: Ordered, Packed, Picked up, Out for delivery, Delivered.
 */
const STAGE_RANK = {
    placed: 0,
    accepted: 1,
    preparing: 1,
    ready: 2,
    pickup_scheduled: 2,
    in_transit: 3,
    out_for_delivery: 4,
    delivered: 5
};

const PACKED_KINDS = new Set(['accepted', 'preparing', 'ready', 'ready_for_pickup', 'pickup_scheduled', 'agent_assigned', 'to_store', 'at_pickup']);

const COURIER_PARTNER_NAME = 'Gogate Products';
const shipmentEngine = require('./shipment-engine');

function eventStage(ev) {
    const kind = String(ev.kind || '').toLowerCase();
    const text = (String(ev.title || '') + ' ' + String(ev.detail || '')).toLowerCase();
    if (kind === 'placed') return 'ordered';
    if (PACKED_KINDS.has(kind)) return 'packed';
    if (kind === 'delivered' || /\bdelivered\b|delivery completed/.test(text)) return 'delivered';
    if (kind === 'failed' || /attempt failed|attempt was unsuccessful|delivery failed|could not be completed/.test(text)) return 'out_for_delivery';
    if (kind === 'out_for_delivery' || /out for delivery/.test(text)) return 'out_for_delivery';
    if (/pickup requested|pickup scheduled|created by api|deleted by\b/.test(text)) return 'packed';
    return 'shipped';
}

function stageRank(order) {
    const status = String(order.status || '');
    if (status === 'delivered' || status === 'fulfilled') return 5;
    const stage = order.commerceStage || 'placed';
    let rank = STAGE_RANK[stage] != null ? STAGE_RANK[stage] : 0;
    const manualBooked = !order.commerceProvider && order.courierTrackingNo && String(order.courierTrackStatus || '') === 'booked';
    if (status === 'shipped' && rank < 3) rank = manualBooked ? Math.max(rank, 2) : 3;
    if (!order.commerceProvider && order.courierTrackingNo) {
        const ct = String(order.courierTrackStatus || '');
        const flags = order.courierTrackFlags || {};
        if (ct === 'delivered') rank = Math.max(rank, 5);
        else if (ct === 'out_for_delivery' && !flags.attemptFailed) rank = Math.max(rank, 4);
        else if (ct === 'in_transit' || ct === 'exception' || ct === 'out_for_delivery') rank = Math.max(rank, 3);
        else if (ct === 'booked') rank = Math.max(rank, 2);
    }
    return rank;
}

function courierPartner(order) {
    if (order.commerceProvider) {
        const mode = order.commerceMode === 'hyperlocal' ? 'Hyperlocal delivery' : 'Logistics';
        return {
            name: COURIER_PARTNER_NAME,
            service: mode,
            trackingNo: order.tookanJobId || order.shipdayOrderId || order.courierTrackingNo || null
        };
    }
    if (order.courierProvider) {
        const pretty = String(order.courierProvider).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        return { name: pretty, service: 'Courier', trackingNo: order.courierTrackingNo || null };
    }
    return null;
}

function isDeskNoise(ev) {
    const title = String((ev && (ev.title || ev.description)) || '');
    const extra = String((ev && (ev.detail || ev.location)) || '');
    const blob = (title + ' ' + extra).toLowerCase();
    return /created by api/.test(blob) || /deleted by\b/.test(blob);
}

function placeText(value) {
    const s = String(value || '').trim();
    if (!s || /^book desk$/i.test(s)) return '';
    return s;
}

function toUpdate(ev) {
    const title = placeText(ev.title) || 'Update';
    const detail = placeText(ev.detail && ev.detail !== ev.title ? ev.detail : '');
    const kind = String(ev.kind || '').toLowerCase();
    const blob = (title + ' ' + detail).toLowerCase();
    const failed = kind === 'failed' || /attempt failed|attempt was unsuccessful|delivery failed|could not be completed|couldn.?t deliver/.test(blob);
    const rescheduled = kind === 'rescheduled' || /has been rescheduled|delivery rescheduled/.test(blob);
    return { title, at: ev.at || null, city: placeText(ev.city), detail, tone: failed ? 'failed' : rescheduled ? 'rescheduled' : '' };
}

function sortNewest(list) {
    return list.slice().sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() || 0 : 0;
        const tb = b.at ? new Date(b.at).getTime() || 0 : 0;
        return tb - ta;
    });
}

function dedupe(list) {
    const seen = new Set();
    return list.filter((u) => {
        const key = u.title + '|' + (u.at || '') + '|' + u.city;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function clampLine(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const pct = n <= 1 ? n * 100 : n;
    return Math.max(0, Math.min(88, Math.round(pct)));
}

function hubStops(events) {
    const byCity = new Map();
    (events || []).forEach((ev) => {
        const kind = String(ev.kind || '').toLowerCase();
        if (kind !== 'hub_eta' && kind !== 'arrived_facility') return;
        const ms = ev.at ? Date.parse(ev.at) || 0 : 0;
        if (!ms) return;
        const city = String(ev.city || ev.title || 'hub');
        const prev = byCity.get(city);
        const done = kind === 'arrived_facility';
        if (!prev) byCity.set(city, { done, ms });
        else byCity.set(city, { done: prev.done || done, ms: done ? ms : prev.ms });
    });
    return Array.from(byCity.values()).sort((a, b) => a.ms - b.ms);
}

function fillFromWindow(now, since, until) {
    if (!since || !until || until <= since) return 12;
    if (now <= since) return 12;
    const ratio = Math.min(1, (now - since) / (until - since));
    return Math.min(88, Math.max(12, Math.round(ratio * 100)));
}

function buildShopTimeline(order, events, opts) {
    const options = opts || {};
    const cancelled = String(order.status || '') === 'cancelled';
    const pendingPayment = String(order.status || '') === 'pending_payment';
    const operationalEarly = shipmentEngine.operationalFromEvents(events);
    let rank = stageRank(order);
    // A failed / rescheduled attempt moves the parcel back to "Shipped" until the courier goes out again.
    if (rank === 4 && (operationalEarly === 'DELIVERY_ATTEMPT_FAILED' || operationalEarly === 'RESCHEDULED')) rank = 3;
    const plan = shipmentEngine.expectedPlan(order, options.shop || null, options.store || null);
    const pickup = order.fulfillmentType === 'pickup';
    const hyper = order.commerceMode === 'hyperlocal';
    const partner = courierPartner(order);

    const grouped = { ordered: [], packed: [], picked_up: [], shipped: [], out_for_delivery: [], delivered: [] };
    const PICKED_RE = /picked up|pickup from seller|pickup done|collected from|shipment picked|picked from|pickup complete/i;
    const fwdTasks = order.parcelInfo && Array.isArray(order.parcelInfo.tasks) ? order.parcelInfo.tasks : [];
    const taskOtp = (kind) => {
        const hits = fwdTasks.filter((t) => t && t.type === kind && t.otp);
        return hits.length ? String((kind === 'Delivery' ? hits[hits.length - 1] : hits[0]).otp) : '';
    };
    const queue = !hyper && order.parcelInfo && order.parcelInfo.queue && order.parcelInfo.queue.position ? order.parcelInfo.queue : null;
    const customerLines = [];
    const stageKey = {
        ORDERED: 'ordered',
        PACKED: 'packed',
        SHIPPED: 'shipped',
        OUT_FOR_DELIVERY: 'out_for_delivery',
        DELIVERED: 'delivered'
    };
    (events || []).forEach((ev) => {
        if (isDeskNoise(ev)) return;
        const line = shipmentEngine.customerEvent(ev, { hyperlocal: hyper });
        if (!line || line.internal) return;
        customerLines.push(line);
        let stage = stageKey[line.parentStage];
        if (!stage) return;
        if (!hyper && (stage === 'shipped' || stage === 'packed') && (PICKED_RE.test(String(line.message || '')) || PICKED_RE.test(String(ev.title || '')))) stage = 'picked_up';
        grouped[stage].push({
            title: line.message,
            at: line.at,
            city: line.location || '',
            detail: line.reason || '',
            tone: line.tone || ''
        });
    });

    const keys = pickup
        ? [
              ['ordered', 'Ordered', 0],
              ['packed', 'Packed', 2],
              ['delivered', 'Collected', 5]
          ]
        : [
              ['ordered', 'Ordered', 0],
              ['packed', 'Packed', 3],
              ['picked_up', 'Picked up by delivery partner', 3],
              ['shipped', hyper ? 'Picked up' : 'Shipped', 4],
              ['out_for_delivery', 'Out for delivery', 5],
              ['delivered', 'Delivered', 5]
          ];

    const hubArrived = (events || []).some((ev) => String(ev.kind || '').toLowerCase() === 'arrived_facility' || /arrived at|received at|reached .*hub|courier facility/i.test(String(ev.title || '')));
    const steps = keys.filter(([key]) => key !== 'picked_up' || !hyper).map(([key, title, doneAtRank]) => {
        let done = key === 'ordered' ? !pendingPayment : rank >= doneAtRank;
        if (key === 'shipped' && !hyper && !pickup) done = rank >= 4;
        return { key, title, state: done ? 'done' : 'upcoming', updates: [], at: null };
    });

    if (!cancelled) {
        const firstOpen = steps.findIndex((s) => s.state !== 'done');
        if (firstOpen >= 0) steps[firstOpen].state = 'active';
    }

    const byKey = {};
    steps.forEach((s) => {
        byKey[s.key] = s;
    });

    if (byKey.ordered) {
        byKey.ordered.at = order.createdAt || null;
        byKey.ordered.summary = pendingPayment
            ? 'Waiting for payment to confirm your order.'
            : 'Order ' + order.orderCode + ' placed.';
        byKey.ordered.updates = sortNewest(dedupe(grouped.ordered));
    }
    if (byKey.packed) {
        byKey.packed.updates = sortNewest(dedupe(grouped.packed)).map((u) => (options.admin ? u : Object.assign({}, u, { detail: '' })));
        const latest = byKey.packed.updates[0];
        byKey.packed.at = latest ? latest.at : null;
        if (byKey.packed.state === 'done') byKey.packed.summary = hyper ? 'Your order is packed at the store.' : 'Your books are packed and handed over.';
        else if (rank >= 2 && partner && !pickup) byKey.packed.summary = hyper ? 'Your order is packed at the store. A delivery partner will pick it up.' : 'Packed. ' + partner.name + ' has been asked to pick up your shipment from the store.';
        else if (rank >= 1) byKey.packed.summary = 'The store is preparing your books.';
        else byKey.packed.summary = 'The store will accept your order shortly.';
        if (!pickup && rank >= 2 && partner) {
            byKey.packed.pickup = {
                partner,
                requested: true,
                collected: rank >= 3,
                agent: options.admin && (order.agentName || order.agentPhone) ? { name: order.agentName || '', phone: order.agentPhone || '' } : null,
                pickupOtp:
                    order.commerceProvider !== 'shipday' && (order.pickupOtp || taskOtp('Pickup')) && (options.admin || (rank >= 2 && rank < 3))
                        ? order.pickupOtp || taskOtp('Pickup')
                        : null
            };
        }
    }
    if (byKey.packed && pickup) {
        byKey.packed.title = 'Packed - ready for pickup';
        byKey.packed.summary =
            byKey.packed.state === 'done'
                ? 'Show order ' + order.orderCode + ' at the store counter.'
                : 'We will tell you when your books are ready.';
    }
    if (byKey.picked_up) {
        const updates = sortNewest(dedupe(grouped.picked_up));
        byKey.picked_up.updates = updates;
        byKey.picked_up.at = updates.length ? updates[updates.length - 1].at : rank >= 3 ? order.commercePickupAt || null : null;
        byKey.picked_up.summary = rank >= 3 ? (partner ? partner.name + ' has collected your parcel from the store.' : 'Your parcel has been collected from the store.') : 'The delivery partner collects your parcel from the store.';
    }
    if (byKey.shipped) {
        const updates = sortNewest(dedupe(grouped.shipped));
        byKey.shipped.updates = updates;
        byKey.shipped.partner = rank >= 3 ? partner : null;
        byKey.shipped.at = updates.length ? updates[updates.length - 1].at : null;
        if (hyper) {
            if (rank < 3) byKey.shipped.summary = 'The delivery partner picks up your order from the store.';
            else byKey.shipped.summary = 'The delivery partner has picked up your order.';
        } else if (rank < 3) byKey.shipped.summary = 'Ships once the courier partner has collected your parcel.';
        else byKey.shipped.summary = partner ? 'Shipped with ' + partner.name + ' (' + partner.service + ').' : 'On its way to you.';
    }
    if (byKey.out_for_delivery) {
        const step = byKey.out_for_delivery;
        step.updates = sortNewest(dedupe(grouped.out_for_delivery));
        step.at = step.updates.length ? step.updates[step.updates.length - 1].at : null;
        const operational = operationalEarly;
        step.operational = operational;
        if (operational === 'DELIVERY_ATTEMPT_FAILED') step.summary = "Delivery attempt unsuccessful. We couldn't deliver your order today.";
        else if (operational === 'RESCHEDULED') {
            const when = order.rescheduledForStart ? shipmentEngine.windowLabel(order.rescheduledForStart, order.rescheduledForEnd) : '';
            step.summary = when ? 'Delivery has been rescheduled. ' + when + '.' : 'Delivery has been rescheduled.';
        } else step.summary = rank >= 4 ? (hyper ? 'Your order is on the way.' : 'Your order is out for delivery.') : hyper ? 'This step starts when the delivery partner leaves the store.' : 'This step starts when the delivery partner leaves with your package.';
        if (operational === 'DELIVERY_ATTEMPT_FAILED' && hyper) {
            step.reschedule = {
                token: trackingTokenOf(order),
                slots: shipmentEngine.deliverySlots(options.shop || null),
                supportUrl: '/support'
            };
        }
        if ((order.agentName || order.agentPhone) && operational === 'DELIVERY_ATTEMPT_FAILED') {
            step.contact = { name: order.agentName || '', phone: order.agentPhone || '' };
        }
        const showDetails = operational !== 'DELIVERY_ATTEMPT_FAILED' && operational !== 'RESCHEDULED' && ((rank >= 4 && rank < 5) || (options.admin && rank >= 2 && rank < 5));
        if (showDetails && (order.agentName || order.agentPhone)) {
            step.agent = {
                name: order.agentName || '',
                phone: order.agentPhone || ''
            };
            step.liveMapAvailable = !!hyper && rank < 5;
        }
        const deliveryOtpValue = order.deliveryOtp || taskOtp('Delivery');
        const showDeliveryOtp =
            order.commerceProvider &&
            order.commerceProvider !== 'shipday' &&
            deliveryOtpValue &&
            operational !== 'DELIVERY_ATTEMPT_FAILED' &&
            rank < 5 &&
            (hyper || (rank >= 3 && rank <= 5));
        if (showDeliveryOtp) {
            const host = rank >= 4 ? byKey.out_for_delivery : rank >= 3 ? byKey.shipped : byKey.packed || byKey.ordered;
            if (host) host.deliveryOtp = deliveryOtpValue;
        }
    }
    if (byKey.delivered) {
        byKey.delivered.updates = sortNewest(dedupe(grouped.delivered));
        byKey.delivered.at = byKey.delivered.updates.length
            ? byKey.delivered.updates[0].at
            : order.courierDeliveredAt || (rank >= 5 ? order.updatedAt || null : null);
        byKey.delivered.summary = rank >= 5 ? (pickup ? 'Collected from the store.' : 'Delivered to you.') : '';
    }

    const expectBy = {};
    shipmentEngine.customerStatuses(order, { shop: (opts || {}).shop, store: (opts || {}).store }).forEach((step) => {
        const key = stageKey[step.key];
        if (key && step.expectedLabel) expectBy[key] = step.expectedLabel;
    });
    if (plan && !cancelled) {
        const fmt = (iso) => shipmentEngine.expectedWhen(iso);
        if (plan.packedAt) expectBy.packed = 'Expected by ' + fmt(plan.packedAt);
        if (plan.shippedAt) expectBy.shipped = 'Expected ' + (hyper ? 'pickup ' : 'shipping ') + fmt(plan.shippedAt);
        if (plan.shippedAt && byKey.picked_up) expectBy.picked_up = 'Expected pickup ' + fmt(plan.shippedAt);
        if (plan.outForDeliveryAt) {
            const ofd = Date.parse(plan.outForDeliveryAt);
            const del = Date.parse(plan.deliveryAt);
            const fixed = Number.isFinite(ofd) && Number.isFinite(del) && ofd >= del ? new Date(del - 3 * 60 * 60 * 1000).toISOString() : plan.outForDeliveryAt;
            expectBy.out_for_delivery = 'Expected ' + fmt(fixed);
        }
        if (plan.deliveryAt) expectBy.delivered = 'Expected ' + (plan.deliveryText || fmt(plan.deliveryAt));
    }
    steps.forEach((s) => {
        if (expectBy[s.key]) s.expectedLabel = expectBy[s.key];
        if (s.state === 'upcoming' && !(s.key === 'out_for_delivery' && (operationalEarly === 'RESCHEDULED' || operationalEarly === 'DELIVERY_ATTEMPT_FAILED'))) {
            s.updates = [];
            s.at = null;
        }
    });

    const active = steps.find((s) => s.state === 'active');
    if (active && !pickup && !cancelled && rank >= 2 && rank < 5 && operationalEarly !== 'DELIVERY_ATTEMPT_FAILED') {
        const stops = hyper ? [] : hubStops(events);
        const now = Date.now();
        let since = 0;
        let until = 0;
        const scheduled = shipmentEngine.scheduleWindow(order, rank);
        if (scheduled) {
            since = scheduled.since;
            until = scheduled.until;
        } else if (rank >= 4) {
            const last = stops.length ? stops[stops.length - 1].ms : 0;
            since = last || now - 60 * 60 * 1000;
            until = since + 4 * 60 * 60 * 1000;
        } else if (rank >= 3 && stops.length) {
            since = stops[0].ms;
            until = stops.length > 1 ? stops[stops.length - 1].ms : since + 3 * 60 * 60 * 1000;
        } else if (stops.length) {
            until = stops[0].ms;
            since = until - 6 * 60 * 60 * 1000;
        }
        const donePct = !scheduled && rank < 4 && stops.length ? Math.min(88, Math.round((stops.filter((s) => s.done).length / stops.length) * 100)) : 0;
        let fill = since && until ? fillFromWindow(now, since, until) : rank >= 4 ? 36 : rank >= 3 ? 18 : 12;
        fill = Math.max(fill, donePct || 0);
        if (rank >= 4 && queue) {
            const share = queue.total > 1 ? (queue.total - queue.position) / (queue.total - 1) : 1;
            fill = Math.max(fill, 40 + Math.round(48 * share));
            active.queue = { position: queue.position, total: queue.total, ahead: queue.ahead, agent: queue.agent || null, started: !!queue.started };
        }
        if (!scheduled) {
            const fromOrder = clampLine(order.lineFill);
            if (fromOrder != null) fill = Math.max(fill, fromOrder);
        }
        active.lineFill = Math.min(88, fill);
        active.lineFloor = Math.min(88, Math.max(12, donePct || 12));
        if (since && until && until > since) {
            active.lineSince = since;
            active.lineUntil = until;
        }
    }
    const dateStatus = cancelled ? 'ORDERED' : shipmentEngine.mainKeyFromOrder(order);
    const headline = cancelled
        ? 'Cancelled'
        : operationalEarly === 'DELIVERY_ATTEMPT_FAILED'
          ? 'Delivery attempt unsuccessful'
          : operationalEarly === 'RESCHEDULED'
            ? 'Delivery rescheduled'
            : active
              ? active.title
              : steps[steps.length - 1].state === 'done'
                ? steps[steps.length - 1].title
                : 'Ordered';
    const flags = order.courierTrackFlags || {};
    const move = latestMove(events);
    const shownOtp = (steps.find((step) => step.deliveryOtp) || {}).deliveryOtp || '';
    const scan = shipmentEngine.shipmentScanBundle(Object.assign({}, order, { trackingToken: trackingTokenOf(order) }), {
        cancelled,
        delivered: rank >= 5
    });
    return {
        steps,
        headline,
        cancelled,
        expected: plan,
        courier: order.courierProvider || order.commerceProvider
            ? {
                  provider: partner ? partner.name : null,
                  trackingNo: order.courierTrackingNo || order.commerceAwb || null,
                  status: order.courierTrackStatus || null,
                  label: order.courierTrackLabel || null,
                  updatedAt: order.courierTrackUpdatedAt || null,
                  etaText: order.courierEtaText || null,
                  shippingRate: order.courierCharge != null && order.courierCharge > 0 ? order.courierCharge : null,
                  destination: flags.destination || null,
                  rto: !!flags.rto
              }
            : null,
        pickup,
        hyperlocal: hyper,
        partner,
        rank,
        operational: shipmentEngine.operationalFromEvents(events),
        deliveryBy: shipmentEngine.mainKeyFromOrder(order) === 'DELIVERED' ? '' : shipmentEngine.deliveryByLabel(order),
        otpSupported: !!(order.commerceProvider && order.commerceProvider !== 'shipday' && !cancelled),
        courierStatus: cancelled ? null : shipmentEngine.courierStatusView(events, customerLines, dateStatus, order),
        stats: shipmentEngine.shipmentStats(customerLines, steps.map((s) => ({ state: s.state, lineGrow: s.lineFill ? s.lineFill / 100 : 0 })), Date.now()),
        dates: shipmentEngine.shipmentDates(order, dateStatus, customerLines),
        timing: shipmentEngine.shipmentTiming(order, dateStatus, customerLines),
        move,
        deliveryOtp: shownOtp,
        orderCode: scan.orderCode || order.orderCode || '',
        orderQr: scan.orderQr,
        shipmentScanUrl: scan.shipmentScanUrl,
        shipmentQrSvg: scan.shipmentQrSvg,
        milestones: milestonesFor(order, { rank, cancelled, pickup, hyper, move, hub: hubArrived, operational: operationalEarly })
    };
}

function latestMove(events) {
    const kinds = ['delivered', 'out_for_delivery', 'picked_up', 'at_pickup', 'to_store', 'agent_assigned'];
    for (let i = (events || []).length - 1; i >= 0; i--) {
        const kind = String((events[i] && events[i].kind) || '');
        if (kinds.indexOf(kind) >= 0) return kind;
    }
    return '';
}

function milestonesFor(order, timeline) {
    if (!order || timeline.cancelled || timeline.pickup) return [];
    const rank = timeline.rank || 0;
    const assigned = !!(order.agentName || order.agentPhone || (order.agentLat != null && order.agentLng != null));
    const leg = timeline.hyper ? liveLegNow(order, { rank }) : '';
    const move = timeline.move || '';
    let rows;
    let current;
    if (timeline.hyper) {
        const km = dropKm(order);
        const door = km != null && km <= 0.12 && (leg === 'to_drop' || rank >= 4);
        const nearby = km != null && km <= 0.6 && (leg === 'to_drop' || rank >= 4);
        rows = [
            ['placed', 'Order placed', 'We have your order'],
            ['confirmed', 'Order confirmed', 'Payment and address are set'],
            ['preparing', 'Preparing at the store', 'The store is packing it'],
            ['assigned', 'Partner assigned', 'A delivery partner is on this order'],
            ['to_store', 'Heading to the store', 'Going to the store to collect it'],
            ['at_store', 'At the store', 'Waiting to collect the order'],
            ['picked', 'Picked up', 'Collected from the store'],
            ['to_you', 'On the way to you', 'Coming to your address'],
            ['nearby', 'Partner nearby', 'Please be available'],
            ['door', 'At your door', 'The partner has reached you'],
            ['delivered', 'Delivered', 'Handed over']
        ];
        const at = (key) => rows.findIndex((row) => row[0] === key);
        if (rank >= 5 || move === 'delivered') current = at('delivered');
        else if (door) current = at('door');
        else if (nearby) current = at('nearby');
        else if (rank >= 4 || move === 'out_for_delivery') current = at('to_you');
        else if (rank >= 3 || move === 'picked_up') current = at('picked');
        else if (move === 'at_pickup') current = at('at_store');
        else if (assigned && leg === 'to_store') current = at('to_store');
        else if (assigned || rank >= 2 || move === 'agent_assigned') current = at('assigned');
        else if (rank >= 1) current = at('preparing');
        else if (String(order.status || '') !== 'pending_payment') current = at('confirmed');
        else current = at('placed');
    } else {
        rows = [
            ['placed', 'Order placed', 'We have your order'],
            ['confirmed', 'Order confirmed', 'The store has accepted it'],
            ['packed', 'Packed', 'Packed at the store'],
            ['label', 'Label created', 'The courier label is ready'],
            ['picked', 'Picked up from the store', 'Collected by the courier'],
            ['shipped', 'Shipped', 'Moving between cities']
        ];
        if (timeline.hub) rows.push(['city', 'Arrived in your city', 'At the local facility']);
        rows.push(['out', 'Out for delivery', 'On the way to your address']);
        if (timeline.operational === 'DELIVERY_ATTEMPT_FAILED') rows.push(['attempt', 'Delivery attempted', 'The courier could not complete the drop']);
        rows.push(['delivered', 'Delivered', 'Handed over']);
        const at = (key) => rows.findIndex((row) => row[0] === key);
        if (rank >= 5) current = at('delivered');
        else if (timeline.operational === 'DELIVERY_ATTEMPT_FAILED') current = at('attempt');
        else if (rank >= 4) current = at('out');
        else if (timeline.hub && rank >= 3) current = at('city');
        else if (rank >= 3) current = at('shipped');
        else if (rank >= 2 && (order.courierTrackingNo || order.commerceAwb)) current = at('label');
        else if (rank >= 2) current = at('packed');
        else if (String(order.status || '') !== 'pending_payment' && rank >= 0) current = rank >= 1 ? at('packed') : at('confirmed');
        else current = at('placed');
    }
    return rows.map((row, i) => ({
        key: row[0],
        label: row[1],
        detail: row[2] || '',
        state: i < current ? 'done' : i === current ? 'active' : 'upcoming'
    }));
}

function trackingTokenOf(order) {
    if (order && order.trackingToken) return String(order.trackingToken);
    const url = String((order && order.commerceTrackUrl) || '');
    const match = /[?&]token=([^&]+)/.exec(url);
    return match ? decodeURIComponent(match[1]) : '';
}

function dropKm(order) {
    const lat = Number(order && order.agentLat);
    const lng = Number(order && order.agentLng);
    const dlat = Number(order && order.dropLat);
    const dlng = Number(order && order.dropLng);
    if (![lat, lng, dlat, dlng].every((n) => Number.isFinite(n))) return null;
    const r = 6371;
    const p = Math.PI / 180;
    const a = Math.sin(((dlat - lat) * p) / 2) ** 2 + Math.cos(lat * p) * Math.cos(dlat * p) * Math.sin(((dlng - lng) * p) / 2) ** 2;
    return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function riderPoint(order) {
    if (!order || order.agentLat == null || order.agentLng == null || order.agentLat === '' || order.agentLng === '') return null;
    const lat = Number(order.agentLat);
    const lng = Number(order.agentLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const ms = order.agentLocationAt ? Date.parse(order.agentLocationAt) : NaN;
    if (Number.isFinite(ms) && Date.now() - ms > 3 * 60 * 60 * 1000) return null;
    const point = { lat, lng };
    const heading = Number(order.agentHeading);
    if (Number.isFinite(heading)) point.heading = ((heading % 360) + 360) % 360;
    return point;
}

function liveLegNow(order, timeline) {
    const stored = String((order && order.liveLeg) || '');
    if (stored === 'to_store' || stored === 'to_drop') return stored;
    return timeline && timeline.rank >= 3 ? 'to_drop' : 'to_store';
}

function buildLiveView(order, timeline, mapsApiKey) {
    if (order.commerceMode !== 'hyperlocal' || timeline.cancelled || timeline.rank >= 5) return null;
    if (timeline.operational === 'DELIVERY_ATTEMPT_FAILED' || timeline.operational === 'RESCHEDULED') return null;
    const courierLink = String(
        (order.commerceProvider === 'tookan' && order.tookanTrackingLink) ||
            (order.commerceProvider === 'shipday' && order.shipdayTrackingLink) ||
            (order.commerceProvider === 'pidge' && order.pidgeTrackingLink) ||
            (order.commerceProvider === 'fleetbase' && order.fleetbaseTrackingLink) ||
            ''
    ).trim();
    const courierView = /^https?:\/\//i.test(courierLink) ? { provider: order.commerceProvider, url: courierLink, name: 'Gogate Products' } : null;
    if (!mapsApiKey && !courierView) return null;
    const pos = (lat, lng) => (lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null);
    const store = pos(order.storeLat, order.storeLng);
    const drop = pos(order.dropLat, order.dropLng);
    const agent = riderPoint(order);
    const delivered = timeline.rank >= 5;
    if (!store && !drop && !agent && !courierView) return null;
    const onRoad = !delivered && !!agent;
    const leg = delivered ? 'done' : onRoad ? liveLegNow(order, timeline) : 'preview';
    const active = (timeline.steps || []).find((step) => step.state === 'active');
    const atStore = onRoad && leg === 'to_store' && timeline.move === 'at_pickup';
    const km = onRoad && leg !== 'to_store' ? dropKm(order) : null;
    const door = km != null && km <= 0.12;
    const nearby = !door && km != null && km <= 0.6;
    const phaseLabel = !onRoad
        ? 'Route from the store to your address'
        : atStore
          ? 'At the store'
          : leg === 'to_store'
            ? 'Heading to the store'
            : door
              ? 'At your door'
              : nearby
                ? 'Partner nearby'
                : 'Picked up · on the way to you';
    return {
        mapsApiKey: mapsApiKey || null,
        courierView,
        slot: active ? active.key : 'ordered',
        leg,
        phase: !onRoad ? 'preview' : atStore ? 'at_store' : door ? 'door' : nearby ? 'nearby' : leg,
        phaseLabel,
        route: onRoad ? 'road' : 'dotted',
        agent: onRoad ? agent : null,
        watchToken: trackingTokenOf(order),
        store,
        drop,
        storeLabel: 'Gogate Products store',
        dropLabel: [order.deliveryAddress, order.shippingCity, order.shippingPincode].filter(Boolean).join(', ') || 'Delivery location'
    };
}

function buildReturnTimeline(order, returnEvents) {
    if (!order.returnStatus) return null;
    const order_ = ['requested', 'approved', 'pickup_scheduled', 'in_transit', 'received'];
    const labels = {
        requested: 'Return requested',
        approved: 'Approved',
        pickup_scheduled: 'Pickup scheduled',
        in_transit: 'On the way back',
        received: 'Received at store',
        refunded: 'Refund issued',
        replacement_preparing: 'Replacement being prepared',
        replacement_sent: 'Replacement shipped',
        replacement_delivered: 'Replacement delivered',
        rejected: 'Request declined'
    };
    const status = order.returnStatus;
    const isReplacement = order.returnKind === 'replacement';
    const flow = order_.slice();
    if (isReplacement) flow.push('replacement_preparing', 'replacement_sent', 'replacement_delivered');
    else flow.push('refunded');
    const currentIdx = flow.indexOf(status);
    const steps = flow.map((key, i) => ({
        key,
        title: labels[key],
        state: status === 'rejected' ? 'upcoming' : i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'upcoming'
    }));
    return {
        kind: order.returnKind || 'return',
        status,
        statusLabel: labels[status] || status,
        reason: order.returnReason || '',
        steps,
        pickupOtp: order.returnPickupOtp || null,
        agent: order.returnAgentPhone ? { name: order.returnAgentName || '', phone: order.returnAgentPhone } : null,
        scheduledAt: order.returnScheduledAt || null,
        provider: order.returnProvider || null,
        trackingLink: order.returnTrackingLink || null,
        updates: sortNewest(dedupe((returnEvents || []).map(toUpdate)))
    };
}

module.exports = { buildShopTimeline, buildLiveView, buildReturnTimeline, courierPartner, stageRank, milestonesFor, liveLegNow };

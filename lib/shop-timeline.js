/**
 * Customer-facing order tracker for the private shop:
 * Ordered, Packed, Shipped (courier partner + scans), Out for delivery, Delivered.
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

function eventStage(ev) {
    const kind = String(ev.kind || '').toLowerCase();
    const text = (String(ev.title || '') + ' ' + String(ev.detail || '')).toLowerCase();
    if (kind === 'placed') return 'ordered';
    if (PACKED_KINDS.has(kind)) return 'packed';
    if (kind === 'delivered' || /\bdelivered\b|delivery completed/.test(text)) return 'delivered';
    if (kind === 'out_for_delivery' || /out for delivery/.test(text)) return 'out_for_delivery';
    if (/pickup requested|pickup scheduled|created by api|deleted by\b/.test(text)) return 'packed';
    return 'shipped';
}

function stageRank(order) {
    const status = String(order.status || '');
    if (status === 'delivered' || status === 'fulfilled') return 5;
    const stage = order.commerceStage || 'placed';
    let rank = STAGE_RANK[stage] != null ? STAGE_RANK[stage] : 0;
    if (status === 'shipped' && rank < 3) rank = 3;
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
        return { name: order.courierProvider, service: 'Courier', trackingNo: order.courierTrackingNo || null };
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
    return { title, at: ev.at || null, city: placeText(ev.city), detail };
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

function buildShopTimeline(order, events, opts) {
    const options = opts || {};
    const cancelled = String(order.status || '') === 'cancelled';
    const pendingPayment = String(order.status || '') === 'pending_payment';
    const rank = stageRank(order);
    const pickup = order.fulfillmentType === 'pickup';
    const hyper = order.commerceMode === 'hyperlocal';
    const partner = courierPartner(order);

    const grouped = { ordered: [], packed: [], shipped: [], out_for_delivery: [], delivered: [] };
    (events || []).forEach((ev) => {
        if (isDeskNoise(ev)) return;
        const stage = eventStage(ev);
        grouped[stage].push(toUpdate(ev));
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
              ['shipped', 'Shipped', 4],
              ['out_for_delivery', 'Out for delivery', 5],
              ['delivered', 'Delivered', 5]
          ];

    const steps = keys.map(([key, title, doneAtRank]) => {
        const done = key === 'ordered' ? !pendingPayment : rank >= doneAtRank;
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
        if (byKey.packed.state === 'done') byKey.packed.summary = 'Your books are packed and handed over.';
        else if (rank >= 2 && partner && !pickup) byKey.packed.summary = 'Packed. ' + partner.name + ' has been asked to pick up your shipment from the store.';
        else if (rank >= 1) byKey.packed.summary = 'The store is preparing your books.';
        else byKey.packed.summary = 'The store will accept your order shortly.';
        if (!pickup && rank >= 2 && partner) {
            byKey.packed.pickup = {
                partner,
                requested: true,
                collected: rank >= 3,
                agent: options.admin && (order.agentName || order.agentPhone) ? { name: order.agentName || '', phone: order.agentPhone || '' } : null,
                pickupOtp: options.admin && order.commerceProvider !== 'shipday' ? order.pickupOtp || null : null
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
    if (byKey.shipped) {
        const updates = sortNewest(dedupe(grouped.shipped));
        byKey.shipped.updates = updates;
        byKey.shipped.partner = rank >= 3 ? partner : null;
        byKey.shipped.at = updates.length ? updates[updates.length - 1].at : null;
        if (rank < 3) byKey.shipped.summary = 'Ships once the courier partner has collected your parcel.';
        else byKey.shipped.summary = partner ? 'Shipped with ' + partner.name + ' (' + partner.service + ').' : 'On its way to you.';
    }
    if (byKey.out_for_delivery) {
        const step = byKey.out_for_delivery;
        step.updates = sortNewest(dedupe(grouped.out_for_delivery));
        step.at = step.updates.length ? step.updates[step.updates.length - 1].at : null;
        step.summary = rank >= 4 ? 'Your package is with the delivery agent.' : 'This step starts when the delivery agent leaves with your package.';
        const showDetails = (rank >= 4 && rank < 5) || (options.admin && rank >= 2 && rank < 5);
        if (showDetails) {
            step.agent = {
                name: order.agentName || '',
                phone: order.agentPhone || '',
                pincode: order.shippingPincode || '',
                address: [order.deliveryAddress, order.shippingCity, order.shippingState].filter(Boolean).join(', ')
            };
            step.deliveryOtp = order.commerceProvider === 'shipday' ? null : order.deliveryOtp || null;
            step.otpEarly = rank < 4;
            step.liveMapAvailable = !!hyper;
        }
    }
    if (byKey.delivered) {
        byKey.delivered.updates = sortNewest(dedupe(grouped.delivered));
        byKey.delivered.at = byKey.delivered.updates.length
            ? byKey.delivered.updates[0].at
            : order.courierDeliveredAt || (rank >= 5 ? order.updatedAt || null : null);
        byKey.delivered.summary = rank >= 5 ? (pickup ? 'Collected from the store.' : 'Delivered to you.') : '';
    }

    steps.forEach((s) => {
        if (s.state === 'upcoming') {
            s.updates = [];
            s.at = null;
        }
    });

    const active = steps.find((s) => s.state === 'active');
    const headline = cancelled
        ? 'Cancelled'
        : active
          ? active.title
          : steps[steps.length - 1].state === 'done'
            ? steps[steps.length - 1].title
            : 'Ordered';
    return { steps, headline, cancelled, pickup, hyperlocal: hyper, partner, rank };
}

function buildLiveView(order, timeline, mapsApiKey) {
    if (order.commerceMode !== 'hyperlocal' || timeline.cancelled) return null;
    if (!mapsApiKey) return null;
    const pos = (lat, lng) => (lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null);
    const store = pos(order.storeLat, order.storeLng);
    const drop = pos(order.dropLat, order.dropLng);
    const agent = pos(order.agentLat, order.agentLng);
    const delivered = timeline.rank >= 5;
    const assigned = !!(order.agentName || order.agentPhone || agent);
    if (!delivered && !assigned) return null;
    if (!store && !drop && !agent) return null;
    return {
        mapsApiKey,
        slot: delivered ? 'delivered' : timeline.rank >= 4 ? 'out_for_delivery' : timeline.rank >= 3 ? 'shipped' : 'packed',
        leg: delivered ? 'done' : order.liveLeg || (timeline.rank >= 3 ? 'to_drop' : 'to_store'),
        agent: delivered ? null : agent,
        store,
        drop
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
        updates: sortNewest(dedupe((returnEvents || []).map(toUpdate)))
    };
}

module.exports = { buildShopTimeline, buildLiveView, buildReturnTimeline, courierPartner, stageRank };

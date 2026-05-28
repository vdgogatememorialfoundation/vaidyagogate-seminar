/**
 * Shipment stage journey: Ordered → Shipped → Out for Delivery → Delivered.
 */
const { TRACK_STATUS, TRACK_STATUS_LABELS } = require('./book-courier-tracker');
const { courierProviderLabel } = require('./book-courier-tracking');

const STAGE_KEYS = ['ordered', 'shipped', 'out_for_delivery', 'delivered'];

const STAGE_TITLES = {
    ordered: 'Ordered',
    shipped: 'Shipped',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered'
};

const STAGE_ICONS = {
    ordered: 'fa-receipt',
    shipped: 'fa-truck',
    out_for_delivery: 'fa-motorcycle',
    delivered: 'fa-home'
};

const JOURNEY_LABELS = Object.assign({}, STAGE_TITLES, {
    confirmed: 'Order confirmed',
    packed: 'Packed',
    booked: 'Pickup scheduled',
    in_transit: 'On the way',
    ready_pickup: 'Ready for pickup',
    collected: 'Collected',
    cancelled: 'Cancelled'
});

function stepState(done, active) {
    if (done) return 'completed';
    if (active) return 'active';
    return 'upcoming';
}

function classifyScanStage(description, trackStatus) {
    const t = String(description || '').toLowerCase();
    const st = String(trackStatus || '');
    if (st === TRACK_STATUS.delivered || /delivered|delivery completed|handed over/.test(t)) return 'delivered';
    if (st === TRACK_STATUS.out_for_delivery || /out for delivery|out-for-delivery/.test(t)) return 'out_for_delivery';
    if (
        st === TRACK_STATUS.in_transit ||
        st === TRACK_STATUS.booked ||
        /in transit|shipped|dispatched|picked|manifest|departed|arrived|hub|bagged|received at/.test(t)
    ) {
        return 'shipped';
    }
    return 'ordered';
}

function findCancelEvent(order) {
    const events = order.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const ty = String(e.type || '').toLowerCase();
        if (ty === 'cancelled' || ty === 'aggregator_cancelled' || /cancel/i.test(String(e.title || ''))) {
            return e;
        }
    }
    return null;
}

function buildUpdateTimeline(order) {
    const rows = [];
    const push = (item) => {
        if (!item || !item.title) return;
        rows.push(item);
    };

    (order.events || []).forEach((e) => {
        const ty = String(e.type || '').toLowerCase();
        let stage = 'ordered';
        if (ty === 'cancelled' || ty === 'aggregator_cancelled') stage = 'cancelled';
        else if (ty === 'aggregator_booked' || ty === 'courier_dispatched') stage = 'shipped';
        else if (ty === 'courier_delivered') stage = 'delivered';
        push({
            at: e.at,
            title: e.title || e.description || 'Update',
            subtitle: e.description || '',
            stage,
            source: 'order',
            kind: ty
        });
    });

    (order.courierTrackEvents || []).forEach((ev) => {
        const desc = String(ev.description || 'Courier update').trim();
        push({
            at: ev.at,
            title: desc,
            subtitle: [ev.city, ev.state].filter(Boolean).join(', ') || ev.location || '',
            stage: classifyScanStage(desc, order.courierTrackStatus),
            source: 'courier',
            facility: ev.facility || null
        });
    });

    rows.sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        if (!ta && !tb) return 0;
        if (!ta) return -1;
        if (!tb) return 1;
        return ta - tb;
    });
    return rows;
}

function resolveCourierStages(order) {
    const st = String(order.status || '');
    const trackSt = String(order.courierTrackStatus || '');
    const shipSt = String(order.courierShipmentStatus || '');
    const awb = String(order.courierTrackingNo || '').trim();
    const cancelled = st === 'cancelled';
    const cancelEv = cancelled ? findCancelEvent(order) : null;

    const delivered =
        !cancelled &&
        (st === 'delivered' || trackSt === TRACK_STATUS.delivered || shipSt === 'delivered' || !!order.courierDeliveredAt);
    const outForDelivery = !cancelled && trackSt === TRACK_STATUS.out_for_delivery;
    const shipped =
        !cancelled &&
        (delivered ||
            outForDelivery ||
            st === 'shipped' ||
            st === 'delivered' ||
            shipSt === 'shipped' ||
            trackSt === TRACK_STATUS.in_transit ||
            trackSt === TRACK_STATUS.booked ||
            !!(awb && (order.courierDispatchedAt || st === 'fulfilled' || order.courierDetailsSavedAt)));
    const ordered =
        !cancelled &&
        st !== 'pending_payment' &&
        (st === 'confirmed' || st === 'shipped' || st === 'delivered' || st === 'fulfilled' || shipped || order.adminConfirmedAt);

    let highestDone = -1;
    if (ordered || cancelled) highestDone = 0;
    if (shipped) highestDone = 1;
    if (outForDelivery) highestDone = 2;
    if (delivered) highestDone = 3;
    if (cancelled && highestDone < 0) highestDone = 0;

    const activeIndex = cancelled ? highestDone : delivered ? 3 : Math.min(highestDone + 1, 3);

    const milestones = STAGE_KEYS.map((key, idx) => {
        let state;
        if (cancelled) {
            if (idx < highestDone) state = 'completed';
            else if (idx === highestDone) state = 'cancelled';
            else state = 'upcoming';
        } else if (delivered) {
            state = 'completed';
        } else if (idx <= highestDone) {
            state = 'completed';
        } else if (idx === activeIndex) {
            state = 'active';
        } else {
            state = 'upcoming';
        }
        const atMap = {
            ordered: order.createdAt,
            shipped: order.courierDispatchedAt || order.courierTrackUpdatedAt,
            out_for_delivery: outForDelivery ? order.courierTrackUpdatedAt : null,
            delivered: order.courierDeliveredAt || order.fulfilledAt
        };
        return {
            key,
            title: STAGE_TITLES[key],
            icon: STAGE_ICONS[key],
            state,
            at: atMap[key] || null
        };
    });

    const segmentCount = STAGE_KEYS.length - 1;
    let progressPercent = Math.round((Math.max(0, highestDone) / segmentCount) * 100);
    if (!cancelled && !delivered && activeIndex <= segmentCount) {
        const timeline = buildUpdateTimeline(order);
        const stageKey = STAGE_KEYS[activeIndex] || STAGE_KEYS[1];
        const stageEvents = timeline.filter((r) => r.stage === stageKey);
        const sub = Math.min(0.9, stageEvents.length ? 0.25 + stageEvents.length * 0.1 : 0.15);
        progressPercent = Math.min(99, Math.round(((Math.max(0, highestDone) + sub) / segmentCount) * 100));
    }
    if (delivered) progressPercent = 100;
    if (cancelled) progressPercent = Math.round((highestDone / segmentCount) * 100);

    return {
        milestones,
        activeIndex,
        progressPercent,
        cancelled,
        cancelEv,
        delivered,
        outForDelivery,
        shipped,
        ordered
    };
}

function scheduleHint(order, stage) {
    if (order.status === 'cancelled') return 'This shipment was cancelled — no further delivery.';
    if (stage.delivered) return 'Package delivered.';
    if (stage.outForDelivery) return 'Your parcel is out for delivery today.';
    if (stage.shipped) return 'On the way — scans update below in real time.';
    if (stage.ordered) return 'Order confirmed — we will ship after packing.';
    return 'Tracking updates appear below.';
}

function buildAmazonStyleJourney(order) {
    const st = String(order.status || '');
    const courier = order.fulfillmentType === 'courier';
    const awb = order.courierTrackingNo || '';
    const integration = order.courierIntegration || 'direct';
    const liveLabel = order.courierTrackLabel || TRACK_STATUS_LABELS[order.courierTrackStatus] || '';
    const updateTimeline = buildUpdateTimeline(order);

    if (st === 'cancelled') {
        const stage = resolveCourierStages(order);
        const cancelEv = stage.cancelEv;
        return {
            headline: 'Shipment cancelled',
            subheadline: cancelEv
                ? cancelEv.description || cancelEv.title || 'This order will not be delivered.'
                : 'This order was cancelled and will not be delivered.',
            progressPercent: stage.progressPercent,
            isLive: false,
            shipmentCancelled: true,
            awb,
            integration,
            providerLabel: courier ? courierProviderLabel(order.courierProvider) : null,
            milestones: stage.milestones,
            steps: stage.milestones,
            activeStageIndex: stage.activeIndex,
            scheduleHint: scheduleHint(order, stage),
            updateTimeline,
            cancelledAt: cancelEv && cancelEv.at ? cancelEv.at : order.updatedAt
        };
    }

    if (!courier) {
        const collected = st === 'fulfilled';
        const confirmed = st === 'confirmed' || collected;
        const steps = [
            { key: 'ordered', title: JOURNEY_LABELS.ordered, subtitle: order.orderCode || '', state: stepState(true, false), icon: 'fa-receipt', at: order.createdAt },
            {
                key: 'confirmed',
                title: JOURNEY_LABELS.confirmed,
                subtitle: 'Payment received',
                state: stepState(confirmed, st === 'awaiting_confirmation'),
                icon: 'fa-check',
                at: order.adminConfirmedAt
            },
            {
                key: 'pickup',
                title: JOURNEY_LABELS.ready_pickup,
                subtitle: 'Show QR at book desk',
                state: stepState(collected, confirmed && !collected),
                icon: 'fa-qrcode',
                at: order.adminConfirmedAt
            },
            {
                key: 'done',
                title: JOURNEY_LABELS.collected,
                subtitle: 'Enjoy your books',
                state: stepState(collected, false),
                icon: 'fa-book-open',
                at: order.fulfilledAt
            }
        ];
        const doneCount = steps.filter((s) => s.state === 'completed').length;
        return {
            headline: collected ? 'Collected' : confirmed ? 'Ready for pickup' : 'Processing',
            subheadline: collected ? 'Thank you' : 'Visit the seminar book counter',
            progressPercent: Math.round((doneCount / steps.length) * 100),
            isLive: !collected && confirmed,
            awb: null,
            integration: 'pickup',
            providerLabel: null,
            steps,
            milestones: null,
            updateTimeline
        };
    }

    const stage = resolveCourierStages(order);
    let headline = 'Order placed';
    let subheadline = scheduleHint(order, stage);
    if (stage.delivered) {
        headline = 'Delivered';
        subheadline = liveLabel || 'Your books have arrived';
    } else if (stage.outForDelivery) {
        headline = 'Out for delivery';
        subheadline = liveLabel || 'Arriving today';
    } else if (stage.shipped) {
        headline = 'Shipped';
        subheadline = liveLabel || 'On the way to you';
    } else if (stage.ordered) {
        headline = 'Ordered';
        subheadline = 'Preparing your parcel';
    }

    return {
        headline,
        subheadline,
        progressPercent: stage.progressPercent,
        isLive: stage.shipped && !stage.delivered && st !== 'cancelled',
        shipmentCancelled: false,
        awb,
        integration,
        providerLabel: courierProviderLabel(order.courierProvider),
        milestones: stage.milestones,
        steps: stage.milestones,
        activeStageIndex: stage.activeIndex,
        scheduleHint: scheduleHint(order, stage),
        updateTimeline
    };
}

module.exports = {
    JOURNEY_LABELS,
    STAGE_KEYS,
    STAGE_TITLES,
    buildAmazonStyleJourney,
    buildUpdateTimeline,
    classifyScanStage
};

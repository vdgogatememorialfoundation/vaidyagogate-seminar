/**
 * Amazon-style delivery journey for book orders (doctor + admin UI).
 */
const { TRACK_STATUS, TRACK_STATUS_LABELS } = require('./book-courier-tracker');
const { courierProviderLabel } = require('./book-courier-tracking');

const JOURNEY_LABELS = {
    ordered: 'Ordered',
    confirmed: 'Order confirmed',
    packed: 'Packed',
    booked: 'Pickup scheduled',
    shipped: 'Shipped',
    in_transit: 'On the way',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    ready_pickup: 'Ready for pickup',
    collected: 'Collected',
    cancelled: 'Cancelled'
};

function stepState(done, active) {
    if (done) return 'completed';
    if (active) return 'active';
    return 'upcoming';
}

function buildAmazonStyleJourney(order) {
    const st = String(order.status || '');
    const courier = order.fulfillmentType === 'courier';
    const shipSt = String(order.courierShipmentStatus || '');
    const trackSt = String(order.courierTrackStatus || '');
    const liveLabel = order.courierTrackLabel || TRACK_STATUS_LABELS[trackSt] || '';
    const awb = order.courierTrackingNo || '';
    const integration = order.courierIntegration || 'direct';

    if (st === 'cancelled') {
        return {
            headline: 'Order cancelled',
            subheadline: 'This order will not be fulfilled.',
            progressPercent: 100,
            isLive: false,
            awb,
            integration,
            providerLabel: courier ? courierProviderLabel(order.courierProvider) : null,
            steps: [{ key: 'cancelled', title: JOURNEY_LABELS.cancelled, subtitle: '', state: 'completed', icon: 'fa-ban' }]
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
        const activeIdx = steps.findIndex((s) => s.state === 'active');
        const doneCount = steps.filter((s) => s.state === 'completed').length;
        return {
            headline: collected ? 'Collected' : confirmed ? 'Ready for pickup' : 'Processing',
            subheadline: collected ? 'Thank you' : 'Visit the seminar book counter',
            progressPercent: Math.round((doneCount / steps.length) * 100),
            isLive: !collected && confirmed,
            awb: null,
            integration: 'pickup',
            providerLabel: null,
            steps
        };
    }

    const delivered = st === 'delivered' || trackSt === TRACK_STATUS.delivered || shipSt === 'delivered';
    const shipped =
        st === 'shipped' ||
        st === 'delivered' ||
        shipSt === 'shipped' ||
        !!(awb && (st === 'fulfilled' || order.courierDispatchedAt));
    const outForDelivery = trackSt === TRACK_STATUS.out_for_delivery;
    const packed = shipSt === 'ready_to_ship' || order.courierDetailsSavedAt || shipped;
    const confirmed = st !== 'awaiting_confirmation' && st !== 'pending_payment';

    const steps = [
        {
            key: 'ordered',
            title: JOURNEY_LABELS.ordered,
            subtitle: order.orderCode || '',
            state: stepState(true, false),
            icon: 'fa-receipt',
            at: order.createdAt
        },
        {
            key: 'confirmed',
            title: JOURNEY_LABELS.confirmed,
            subtitle: 'Books locked for dispatch',
            state: stepState(confirmed, !confirmed),
            icon: 'fa-check-circle',
            at: order.adminConfirmedAt
        },
        {
            key: 'packed',
            title: JOURNEY_LABELS.packed,
            subtitle: order.deliveryAddress ? 'Address verified' : 'Preparing parcel',
            state: stepState(packed && confirmed, confirmed && !packed),
            icon: 'fa-box',
            at: order.courierDetailsSavedAt
        },
        {
            key: 'shipped',
            title: JOURNEY_LABELS.shipped,
            subtitle: awb ? 'AWB ' + awb : 'Handed to courier',
            state: stepState(shipped, packed && !shipped),
            icon: 'fa-truck',
            at: order.courierDispatchedAt
        },
        {
            key: 'in_transit',
            title: JOURNEY_LABELS.in_transit,
            subtitle: liveLabel || 'Moving to your city',
            state: stepState(outForDelivery || delivered, shipped && !delivered && !outForDelivery),
            icon: 'fa-shipping-fast',
            at: order.courierTrackUpdatedAt
        },
        {
            key: 'ofd',
            title: JOURNEY_LABELS.out_for_delivery,
            subtitle: 'Courier will call before delivery',
            state: stepState(delivered, outForDelivery),
            icon: 'fa-map-marker-alt',
            at: order.courierTrackUpdatedAt
        },
        {
            key: 'delivered',
            title: JOURNEY_LABELS.delivered,
            subtitle: 'Package handed over',
            state: stepState(delivered, false),
            icon: 'fa-home',
            at: order.courierDeliveredAt || order.fulfilledAt
        }
    ];

    let headline = 'Preparing your order';
    let subheadline = 'We will notify you when it ships';
    if (delivered) {
        headline = 'Delivered';
        subheadline = liveLabel || 'Your books have arrived';
    } else if (outForDelivery) {
        headline = 'Arriving today';
        subheadline = liveLabel || 'Out for delivery';
    } else if (shipped) {
        headline = 'On the way';
        subheadline = liveLabel || 'Track updates live below';
    } else if (packed) {
        headline = 'Packed & ready to ship';
        subheadline = integration === 'shiprocket' ? 'Booking via Shiprocket' : integration === 'nimbuspost' ? 'Booking via Nimbuspost' : 'Awaiting courier pickup';
    } else if (confirmed) {
        headline = 'Order confirmed';
        subheadline = 'Packing will start soon';
    }

    const doneCount = steps.filter((s) => s.state === 'completed').length;
    const progressPercent = Math.min(100, Math.max(8, Math.round((doneCount / steps.length) * 100)));

    return {
        headline,
        subheadline,
        progressPercent,
        isLive: shipped && !delivered,
        awb,
        integration,
        providerLabel: courierProviderLabel(order.courierProvider),
        steps
    };
}

module.exports = {
    JOURNEY_LABELS,
    buildAmazonStyleJourney
};

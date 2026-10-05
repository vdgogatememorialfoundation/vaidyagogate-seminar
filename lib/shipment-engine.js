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

function eventBucket(ev) {
    const kind = String(ev.kind || '').toLowerCase();
    const text = (String(ev.title || '') + ' ' + String(ev.detail || '')).toLowerCase();
    if (/^expected at\b/.test(text) || kind === 'hub_eta') return 'schedule';
    if (kind === 'placed' || /order placed|your order has been placed/.test(text)) return 'ordered';
    if (kind === 'accepted' || kind === 'preparing' || /preparing your order|seller is preparing/.test(text)) return 'processing';
    if (kind === 'delivered' || /\bdelivered\b|delivery completed/.test(text)) return 'delivered';
    if (kind === 'out_for_delivery' || /out for delivery/.test(text)) return 'out_for_delivery';
    if (kind === 'picked_up' || /picked up/.test(text)) return 'pickup';
    if (kind === 'arrived_facility' || /arrived at courier facility|shipment arrived/.test(text)) return 'hub_arrived';
    if (kind === 'left_facility' || /left a courier facility|shipment left|left courier/.test(text)) return 'hub_left';
    if (kind === 'ready' || kind === 'pickup_scheduled' || kind === 'ready_for_pickup' || /packed|pickup requested|pickup scheduled/.test(text)) return 'packed';
    return 'update';
}

function eventCopy(bucket, ev) {
    if (bucket === 'ordered') return { heading: 'Ordered', message: 'Your order has been placed' };
    if (bucket === 'processing') return { heading: 'Processing', message: 'Seller is preparing your order' };
    if (bucket === 'packed') return { heading: 'Packed', message: 'Your item has been packed' };
    if (bucket === 'pickup') return { heading: 'Pickup', message: 'Your item has been picked up by courier partner' };
    if (bucket === 'hub_arrived') return { heading: 'Shipped', message: 'Item arrived at courier facility' };
    if (bucket === 'hub_left') return { heading: 'Shipped', message: 'Your item has left a courier facility' };
    if (bucket === 'out_for_delivery') return { heading: 'Out for delivery', message: 'Your order is out for delivery' };
    if (bucket === 'delivered') return { heading: 'Delivered', message: 'Your order has been delivered' };
    if (bucket === 'schedule') return { heading: 'Schedule', message: ev.title || 'Expected at a courier facility' };
    return { heading: 'Update', message: ev.title || 'Shipment update' };
}

function cleanPlace(value) {
    const s = String(value || '').trim();
    if (!s || /^book desk$/i.test(s)) return '';
    return s;
}

function buildCustomerTracking(order, events) {
    const cancelled = String(order.status || '') === 'cancelled';
    const mainStatus = cancelled ? 'ORDERED' : mainKeyFromOrder(order);
    const mainIndex = MAIN.indexOf(mainStatus);
    const type = fulfillmentType(order);
    const hyper = type === 'HYPERLOCAL';
    const tookan = order.commerceProvider === 'tookan';
    const pipeline = MAIN.map((key, index) => ({
        key,
        title: MAIN_COPY[key].title,
        message: MAIN_COPY[key].message,
        state: cancelled ? 'upcoming' : index < mainIndex ? 'done' : index === mainIndex ? 'active' : 'upcoming'
    }));
    const timeline = [];
    (events || []).forEach((ev) => {
        const title = String(ev.title || '');
        const detail = String(ev.detail || '');
        if (/created by api/.test((title + ' ' + detail).toLowerCase()) || /deleted by\b/.test((title + ' ' + detail).toLowerCase())) return;
        const bucket = eventBucket(ev);
        if (bucket === 'update' && !title) return;
        const copy = eventCopy(bucket, ev);
        const city = cleanPlace(ev.city);
        const facility = cleanPlace(ev.detail && ev.detail !== title ? ev.detail : '');
        timeline.push({
            heading: copy.heading,
            message: copy.message,
            at: ev.at || null,
            city: city || null,
            state: ev.state || null,
            country: ev.country || null,
            facilityName: facility || null,
            provider: order.commerceProvider || null,
            internal: bucket === 'schedule'
        });
    });
    timeline.sort((a, b) => {
        const ta = a.at ? Date.parse(a.at) || 0 : 0;
        const tb = b.at ? Date.parse(b.at) || 0 : 0;
        return ta - tb;
    });
    const showPartner = !cancelled && (mainStatus === 'OUT_FOR_DELIVERY' || (hyper && (mainStatus === 'SHIPPED' || mainStatus === 'OUT_FOR_DELIVERY')));
    const agent = showPartner && (order.agentName || order.agentPhone || order.agentLat != null)
        ? {
              name: order.agentName || null,
              phone: order.agentPhone || null,
              latitude: order.agentLat != null ? Number(order.agentLat) : null,
              longitude: order.agentLng != null ? Number(order.agentLng) : null
          }
        : null;
    const pickupOtp = tookan && mainStatus === 'PACKED' && order.pickupOtp ? String(order.pickupOtp) : null;
    const deliveryOtp = tookan && mainStatus === 'OUT_FOR_DELIVERY' && order.deliveryOtp ? String(order.deliveryOtp) : null;
    const current = MAIN_COPY[mainStatus];
    return {
        orderId: order.orderCode || null,
        fulfillmentType: type,
        mainStatus,
        currentStatus: cancelled ? 'Cancelled' : current.title,
        currentMessage: cancelled ? 'This order was cancelled.' : current.message,
        expectedDelivery: null,
        shipment: {
            courier: order.commerceProvider ? 'Gogate Products' : order.courierProvider || null,
            provider: order.commerceProvider || null,
            trackingId: order.courierTrackingNo || null
        },
        agent,
        pickupOtp,
        deliveryOtp,
        map: { enabled: hyper && !cancelled },
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
    buildCustomerTracking
};

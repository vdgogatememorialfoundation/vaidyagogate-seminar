/**
 * Carrier phrase mapping for Commerce tracking.
 */
const assert = require('assert');
const commerce = require('../lib/commerce-logistics');

const arrived = commerce.phraseLogisticsUpdate('Departed from origin', { city: 'Pune' });
assert.strictEqual(arrived.title, 'Shipment left Courier Facility');
assert.strictEqual(arrived.city, 'Pune');
assert.strictEqual(arrived.kind, 'left_facility');

const hub = commerce.phraseLogisticsUpdate('Arrived at hub', { city: 'Mumbai' });
assert.strictEqual(hub.title, 'Shipment arrived at Courier Facility');
assert.strictEqual(hub.city, 'Mumbai');

const out = commerce.phraseLogisticsUpdate('Out for delivery', { agentPhone: '9876543210', agentName: 'Ravi', city: 'Nashik' });
assert.strictEqual(out.title, 'Out for delivery');
assert.ok(out.detail.indexOf('9876543210') !== -1);
assert.ok(out.detail.indexOf('Nashik') !== -1);

assert.strictEqual(commerce.mapShipdayStatus('PICKED_UP'), 'out_for_delivery');
assert.strictEqual(commerce.mapShipdayStatus('STARTED'), 'to_store');
assert.strictEqual(commerce.mapShipdayStatus('ALREADY_DELIVERED'), 'delivered');
assert.strictEqual(commerce.mapTookanStatus(2, 'Successful', 'delivery'), 'delivered');
assert.strictEqual(commerce.mapTookanStatus(2, 'Successful', 'pickup'), 'picked_up');
assert.strictEqual(commerce.stageFromKind('arrived_facility', 'logistics'), 'in_transit');
assert.strictEqual(commerce.liveLegFor('out_for_delivery', 'hyperlocal'), 'to_drop');
assert.strictEqual(commerce.liveLegFor('to_store', 'hyperlocal'), 'to_store');

const tookan = commerce.parseTookanWebhook({
    job_id: 55,
    order_id: 'BK1',
    job_status: 4,
    job_state: 'Arrived at facility',
    fleet_phone: '9000000000',
    job_address: 'Thane'
});
assert.strictEqual(tookan.title, 'Shipment arrived at Courier Facility');
assert.strictEqual(tookan.city, 'Thane');

const ready = commerce.parseShipdayWebhook({
    orderId: 9,
    orderNumber: 'BK2',
    orderStatus: 'READY_TO_DELIVER',
    carrierPhone: '9111111111',
    carrierName: 'Asha'
});
assert.strictEqual(ready.kind, 'ready_for_pickup');
const ship = commerce.parseShipdayWebhook({
    orderId: 9,
    orderNumber: 'BK2',
    orderStatus: 'PICKED_UP',
    carrierPhone: '9111111111',
    carrierName: 'Asha'
});
assert.strictEqual(ship.kind, 'out_for_delivery');
assert.strictEqual(ship.title, 'Out for delivery');
assert.ok(ship.detail.indexOf('9111111111') !== -1);

const cfg = commerce.mergeConfigSecrets(
    { tookan: { apiKey: 'secret-tookan', enabled: true }, shipday: { apiKey: 'secret-ship', enabled: true }, mapsApiKey: 'mapkey' },
    { tookan: { apiKey: '', enabled: true }, shipday: { apiKey: '••••ship', enabled: true }, storeName: 'Desk' }
);
assert.strictEqual(cfg.tookan.apiKey, 'secret-tookan');
assert.strictEqual(cfg.shipday.apiKey, 'secret-ship');
assert.strictEqual(cfg.mapsApiKey, 'mapkey');
assert.strictEqual(cfg.storeName, 'Desk');

assert.strictEqual(commerce.withinIstWindow('09:00', '18:00', 10 * 60), true);
assert.strictEqual(commerce.withinIstWindow('09:00', '18:00', 8 * 60), false);
assert.strictEqual(commerce.withinIstWindow('09:00', '18:00', 18 * 60), true);

const sampleCfg = {
    tookan: { apiKey: 'k', enabled: true },
    shipday: { apiKey: 's', enabled: true },
    storeName: 'Desk',
    storePhone: '9000000000',
    storeAddress: 'Clinic road',
    storeCity: 'Pune'
};
const sampleOrder = {
    orderCode: 'BK1',
    buyerName: 'Asha',
    buyerPhone: '9111111111',
    deliveryAddress: 'Lane 2',
    shippingCity: 'Nashik',
    shippingState: 'MH',
    shippingPincode: '422001',
    pickupOtp: '4321',
    deliveryOtp: '8765',
    totalAmount: 100,
    items: []
};
const parcel = commerce.buildTookanTaskBody(sampleCfg, sampleOrder, 'logistics');
assert.strictEqual(parcel.is_multiple_tasks, 0);
assert.strictEqual(parcel.tags, 'parcel');
assert.strictEqual(parcel.job_description, 'Parcel BK1');
assert.strictEqual(parcel.job_pickup_name, 'Gogate Products');
assert.strictEqual(parcel.has_pickup, 1);
assert.strictEqual(parcel.has_delivery, 1);
assert.ok(JSON.stringify(parcel).indexOf('4321') === -1);
assert.ok(JSON.stringify(parcel).indexOf('8765') === -1);
const hyper = commerce.buildTookanTaskBody(sampleCfg, sampleOrder, 'hyperlocal');
assert.strictEqual(hyper.is_multiple_tasks, undefined);
assert.strictEqual(hyper.tags, 'hyperlocal');
assert.ok(hyper.job_description.indexOf('Hyperlocal') === 0);
const pickupJob = commerce.tookanOtpsFromJob({ job_type: 0, job_otp: '4321' });
assert.strictEqual(pickupJob.pickupOtp, '4321');
assert.strictEqual(pickupJob.deliveryOtp, '');
const dropJob = commerce.tookanOtpsFromJob({ job_type: 1, job_validate_otp: '7788', pickup_job_validate_otp: '1100' });
assert.strictEqual(dropJob.pickupOtp, '1100');
assert.strictEqual(dropJob.deliveryOtp, '7788');
const shipBody = commerce.buildShipdayOrderBody(sampleCfg, sampleOrder);
assert.strictEqual(shipBody.restaurantName, 'Gogate Products');
assert.ok(JSON.stringify(shipBody).indexOf('4321') === -1);
assert.ok(JSON.stringify(shipBody).indexOf('8765') === -1);
assert.ok(!/otp/i.test(shipBody.deliveryInstruction));

const deliveredOrder = {
    orderId: 20625,
    orderNumber: 'BK9',
    orderStatus: { incomplete: false, accepted: true, orderState: 'ALREADY_DELIVERED' },
    assignedCarrier: { name: 'Ravi', phoneNumber: '+919800000000' },
    activityLog: {
        startTime: '2026-10-04T10:05:00',
        pickedUpTime: '2026-10-04T10:20:00',
        deliveryTime: '2026-10-04T10:40:00'
    }
};
const deliveredUpdate = commerce.shipdayOrderToUpdate(deliveredOrder);
assert.strictEqual(deliveredUpdate.kind, 'delivered');
assert.strictEqual(deliveredUpdate.stage, 'delivered');
assert.strictEqual(deliveredUpdate.title, 'Delivered');
assert.strictEqual(deliveredUpdate.agentPhone, '+919800000000');
assert.ok(deliveredUpdate.at && deliveredUpdate.at.indexOf('2026-10-04T10:40:00') === 0);
assert.strictEqual(commerce.shipdayOrderToUpdate([]), null);

const activePicked = commerce.shipdayOrderToUpdate({
    orderStatus: { orderState: 'ACTIVE' },
    activityLog: { startTime: '2026-10-04T10:05:00', pickedUpTime: '2026-10-04T10:20:00' },
    assignedCarrier: { name: 'Ravi', phoneNumber: '9800000000' }
});
assert.strictEqual(activePicked.kind, 'out_for_delivery');
assert.strictEqual(activePicked.stage, 'out_for_delivery');
const activeIdle = commerce.shipdayOrderToUpdate({
    orderStatus: { orderState: 'ACTIVE', incomplete: false },
    activityLog: { placementTime: '2026-10-04T10:00:00' }
});
assert.strictEqual(activeIdle.kind, 'update');
assert.strictEqual(activeIdle.stage, null);

assert.strictEqual(commerce.selectShipdayOrder([], '54298088', 'BK9'), null);
assert.strictEqual(commerce.selectShipdayOrder([{ orderId: 1, orderNumber: 'OTHER' }], '54298088', 'BK9'), null);
const selected = commerce.selectShipdayOrder(
    [{ orderId: 20625, orderNumber: 'BK9', orderStatus: { orderState: 'PICKED_UP' } }],
    '20625',
    'BK9'
);
assert.strictEqual(selected.orderNumber, 'BK9');
assert.strictEqual(commerce.mapShipdayStatus({ orderState: 'STARTED' }), 'to_store');

const nestedHook = commerce.parseShipdayWebhook({
    event: 'ORDER_PIKEDUP',
    order_status: 'PICKED_UP',
    order: { id: 20625, order_number: 'BK2', delivery_time: 1684644196000 },
    carrier: { name: 'Asha', phone: '9111111111' }
});
assert.strictEqual(nestedHook.kind, 'out_for_delivery');
assert.strictEqual(nestedHook.shipdayOrderId, '20625');
assert.strictEqual(nestedHook.orderCode, 'BK2');
assert.ok(nestedHook.detail.indexOf('9111111111') !== -1);

console.log('commerce phrase tests passed');

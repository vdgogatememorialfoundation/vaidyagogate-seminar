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
const parcel = commerce.buildTookanParcelBody(
    Object.assign({}, sampleCfg, { storeLat: 18.5, storeLng: 73.85 }),
    Object.assign({}, sampleOrder, { storeLat: 18.5, storeLng: 73.85, dropLat: 19.07, dropLng: 72.87 })
);
assert.strictEqual(parcel.timezone, -330);
assert.strictEqual(parcel.has_pickup, undefined);
assert.strictEqual(parcel.order_id, undefined);
assert.strictEqual(parcel.pickups.length, 1);
assert.strictEqual(parcel.deliveries.length, 1);
assert.ok(parcel.pickups[0].name.indexOf('Gogate Products') === 0);
assert.ok(parcel.pickups[0].name.indexOf('BK1') !== -1);
assert.ok(parcel.deliveries[0].time > parcel.pickups[0].time);
assert.ok(JSON.stringify(parcel).indexOf('4321') === -1);
assert.ok(JSON.stringify(parcel).indexOf('8765') === -1);
const hubs = [{ id: '1917', name: '1917 Swargate Hub - Pune' }];
const now = Date.parse('2026-10-04T12:00:00Z');
const hubJobs = [
    { job_id: 1, job_type: 0, job_status: 2, job_time_utc: '2026-10-04T06:00:00.000Z', barcode: 'ABC' },
    { job_id: 2, job_type: 1, job_status: 2, order_id: '1917', job_time_utc: '2026-10-04T08:00:00.000Z' },
    { job_id: 3, job_type: 1, job_status: 6, order_id: '', job_time_utc: '2026-10-04T18:00:00.000Z' }
];
const hubJourney = commerce.parcelJourneyUpdate(hubJobs, hubs, now);
assert.strictEqual(hubJourney.stage, 'in_transit');
assert.notStrictEqual(hubJourney.stage, 'out_for_delivery');
assert.ok(hubJourney.lineFill <= 0.88);
assert.ok(hubJourney.lineFill >= 0.12);
assert.ok(hubJourney.events.some((ev) => ev.kind === 'arrived_facility' && ev.city === 'Pune'));
const ofdJobs = hubJobs.map((job, i) => (i === 2 ? Object.assign({}, job, { job_status: 1 }) : job));
const ofdJourney = commerce.parcelJourneyUpdate(ofdJobs, hubs, now);
assert.strictEqual(ofdJourney.stage, 'out_for_delivery');
assert.ok(ofdJourney.lineFill <= 0.88);
const deliveredJobs = hubJobs.map((job, i) => (i === 2 ? Object.assign({}, job, { job_status: 2 }) : job));
assert.strictEqual(commerce.parcelJourneyUpdate(deliveredJobs, hubs, now).stage, 'delivered');
assert.strictEqual(commerce.stageFromKind('hub_eta'), null);
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

assert.strictEqual(commerce.isDeskNoise('Created By API - Gogate Products - 884520'), true);
assert.strictEqual(commerce.isDeskNoise('Deleted by 884520'), true);
assert.strictEqual(commerce.isDeskNoise('Out for delivery'), false);

const placed = commerce.shipdayOrderToUpdate({
    orderStatus: { orderState: 'ORDER_ASSIGNED' },
    restaurant: { latitude: 18.5, longitude: 73.8 },
    customer: { latitude: 18.6, longitude: 73.9 },
    assignedCarrier: { id: 12, name: 'Ravi' }
});
assert.strictEqual(placed.kind, 'agent_assigned');
assert.strictEqual(placed.storeLat, 18.5);
assert.strictEqual(placed.dropLng, 73.9);
assert.strictEqual(placed.carrierId, '12');

const shop = require('../lib/shop-timeline');
const journey = require('../lib/book-tracking-journey');
assert.strictEqual(journey.classifyScanStage('Pickup requested from courier partner', ''), 'ordered');
assert.strictEqual(journey.classifyScanStage('Expected at Swargate Hub', ''), 'ordered');
assert.strictEqual(journey.classifyScanStage('Shipment arrived at Courier Facility', ''), 'shipped');
const onlyPickup = journey.buildAmazonStyleJourney({
    status: 'confirmed',
    fulfillmentType: 'courier',
    commerceProvider: 'shipday',
    commerceStage: 'pickup_scheduled',
    courierShipmentStatus: 'shipped',
    courierTrackStatus: 'in_transit',
    events: [{ type: 'pickup_scheduled', title: 'Pickup requested from courier partner', at: '2026-10-04T10:00:00Z' }],
    courierTrackEvents: [{ description: 'Created By API - Gogate Products - 884520', at: '2026-10-04T10:00:00Z' }]
});
assert.strictEqual(onlyPickup.headline, 'Ordered');
assert.strictEqual(onlyPickup.providerLabel, 'Gogate Products');
assert.ok(!onlyPickup.updateTimeline.some((row) => /created by api/i.test(row.title)));

const noiseOrder = {
    status: 'confirmed',
    commerceStage: 'pickup_scheduled',
    commerceMode: 'hyperlocal',
    commerceProvider: 'shipday',
    fulfillmentType: 'courier',
    orderCode: 'BK1'
};
const noiseEvents = [
    { title: 'Created By API - Gogate Products - 884520', detail: 'Book desk', city: 'Book desk', kind: 'update', at: '2026-10-04T10:00:00Z' },
    { title: 'Deleted by 884520', detail: 'Book desk', city: 'Book desk', kind: 'update', at: '2026-10-04T10:01:00Z' },
    { title: 'Pickup requested from courier partner', kind: 'pickup_scheduled', at: '2026-10-04T10:02:00Z' }
];
const noiseTl = shop.buildShopTimeline(noiseOrder, noiseEvents, {});
const shippedStep = noiseTl.steps.find((s) => s.key === 'shipped');
assert.notStrictEqual(shippedStep.state, 'done');
const packedStep = noiseTl.steps.find((s) => s.key === 'packed');
assert.ok(!packedStep.updates.some((u) => /created by api|deleted by/i.test(u.title)));
assert.strictEqual(shop.buildLiveView(noiseOrder, noiseTl, 'map-key'), null);

const assigned = Object.assign({}, noiseOrder, { agentName: 'Ravi', agentPhone: '9800000000', storeLat: 18.5, storeLng: 73.8, dropLat: 18.6, dropLng: 73.9, agentLat: 18.52, agentLng: 73.85, liveLeg: 'to_store' });
const assignedTl = shop.buildShopTimeline(assigned, noiseEvents, {});
const live = shop.buildLiveView(assigned, assignedTl, 'map-key');
assert.ok(live);
assert.strictEqual(live.leg, 'to_store');
assert.ok(live.agent && live.store && live.drop);

const deliveredTl = shop.buildShopTimeline(Object.assign({}, assigned, { status: 'delivered', commerceStage: 'delivered' }), [], {});
const done = shop.buildLiveView(Object.assign({}, assigned, { status: 'delivered', commerceStage: 'delivered' }), deliveredTl, 'map-key');
assert.strictEqual(done, null);

const failedOrder = {
    status: 'shipped',
    commerceStage: 'out_for_delivery',
    commerceMode: 'hyperlocal',
    commerceProvider: 'tookan',
    fulfillmentType: 'courier',
    orderCode: 'BK5',
    shippingPincode: '411009',
    agentName: '',
    agentPhone: '',
    storeLat: 18.5,
    storeLng: 73.8,
    dropLat: 18.6,
    dropLng: 73.9
};
const failedTl = shop.buildShopTimeline(
    failedOrder,
    [
        { title: 'Out for delivery', kind: 'out_for_delivery', at: '2026-10-04T11:24:00Z' },
        { title: 'Delivery attempt failed', kind: 'failed', at: '2026-10-04T11:27:00Z' }
    ],
    {}
);
assert.strictEqual(failedTl.operational, 'DELIVERY_ATTEMPT_FAILED');
assert.strictEqual(failedTl.headline, 'Delivery attempt unsuccessful');
const failedStep = failedTl.steps.find((s) => s.key === 'out_for_delivery');
assert.ok(failedStep.reschedule && failedStep.reschedule.slots.length > 0);
assert.ok(!failedStep.agent);
assert.ok(!JSON.stringify(failedStep).includes('411009'));
assert.strictEqual(shop.buildLiveView(failedOrder, failedTl, 'map-key'), null);

const transitTl = shop.buildShopTimeline(
    {
        status: 'shipped',
        commerceStage: 'in_transit',
        commerceMode: 'logistics',
        commerceProvider: 'tookan',
        fulfillmentType: 'courier',
        orderCode: 'BK1',
        lineFill: 0.99
    },
    [
        { title: 'Expected at Lonavala Hub', kind: 'hub_eta', city: 'Lonavala', at: '2026-10-05T06:00:00Z' },
        { title: 'Shipment arrived at Courier Facility', kind: 'arrived_facility', city: 'Pune', at: '2026-10-04T08:00:00Z' }
    ],
    {}
);
const transitActive = transitTl.steps.find((s) => s.state === 'active');
assert.strictEqual(transitActive.key, 'shipped');
assert.ok(transitActive.lineFill <= 88);
assert.strictEqual(transitTl.steps.find((s) => s.key === 'out_for_delivery').state, 'upcoming');
assert.strictEqual(transitTl.steps.find((s) => s.key === 'delivered').state, 'upcoming');

console.log('commerce phrase tests passed');

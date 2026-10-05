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

const assigned = Object.assign({}, noiseOrder, { agentName: 'Ravi', agentPhone: '9800000000', storeLat: 18.5, storeLng: 73.8, dropLat: 18.6, dropLng: 73.9, agentLat: 18.52, agentLng: 73.85, agentLocationAt: new Date().toISOString(), liveLeg: 'to_store' });
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

assert.strictEqual(commerce.pidgeFulfillmentKind('PICKED_UP'), 'picked_up');
assert.strictEqual(commerce.pidgeFulfillmentKind('DELIVERED'), 'delivered');
assert.strictEqual(commerce.pidgeFulfillmentKind('UNDELIVERED'), 'failed');
assert.strictEqual(commerce.pidgeFulfillmentKind('RTO_DELIVERED'), 'failed');
assert.strictEqual(commerce.pidgeFulfillmentKind('OUT_FOR_DELIVERY'), 'out_for_delivery');
assert.strictEqual(commerce.pidgeFulfillmentKind('IN_TRANSIT'), 'arrived_facility');
assert.strictEqual(commerce.pidgeFulfillmentKind('CANCELLED'), 'pickup_scheduled');
assert.strictEqual(commerce.stageFromKind('arrived_facility', 'logistics'), 'in_transit');

const pidgeTransit = commerce.pidgePayloadToUpdate({ status: 'fulfilled', fulfillment: { status: 'IN_TRANSIT' } }, 'logistics');
assert.strictEqual(pidgeTransit.kind, 'arrived_facility');
assert.strictEqual(pidgeTransit.stage, 'in_transit');
assert.strictEqual(pidgeTransit.title, 'Item arrived at courier facility');
assert.strictEqual(pidgeTransit.city, '');
assert.strictEqual(pidgeTransit.agentLat, null);

const pidgeHyper = commerce.pidgePayloadToUpdate(
    {
        id: 'pidge-1',
        reference_id: 'BKTEST',
        status: 'fulfilled',
        fulfillment: {
            status: 'OUT_FOR_DELIVERY',
            track_code: 'TRK1',
            logs: [
                {
                    timestamp: '2026-10-05T10:00:00.000Z',
                    status: 'OUT_FOR_DELIVERY',
                    location: { latitude: 18.52, longitude: 73.85 },
                    rider: { name: 'Asha', mobile: '9000000001' }
                }
            ]
        }
    },
    'hyperlocal'
);
assert.strictEqual(pidgeHyper.kind, 'out_for_delivery');
assert.strictEqual(pidgeHyper.agentName, 'Asha');
assert.strictEqual(pidgeHyper.agentLat, 18.52);
assert.strictEqual(pidgeHyper.trackingNo, 'TRK1');
assert.strictEqual(pidgeHyper.pickupOtp, '');
assert.strictEqual(pidgeHyper.deliveryOtp, '');
assert.ok(!JSON.stringify(pidgeHyper).match(/otp":"[0-9]/i));

const pidgeOtp = commerce.pidgePayloadToUpdate(
    {
        status: 'fulfilled',
        fulfillment: {
            status: 'OUT_FOR_DELIVERY',
            track_code: 'AWB45',
            pickup: { eta: '2026-10-06T04:30:00.000Z', pincode: '411001' },
            drop: { eta: '2026-10-06T08:30:00.000Z', otp: '4455', pincode: '411009' }
        }
    },
    'hyperlocal'
);
assert.strictEqual(pidgeOtp.deliveryOtp, '4455');
assert.strictEqual(pidgeOtp.pickupOtp, '');
assert.strictEqual(pidgeOtp.trackingNo, 'AWB45');
assert.strictEqual(pidgeOtp.pickupAt, '2026-10-06T04:30:00.000Z');
assert.strictEqual(pidgeOtp.deliveryAt, '2026-10-06T08:30:00.000Z');
assert.ok(!JSON.stringify(pidgeOtp).includes('411009'));
assert.ok(!JSON.stringify(pidgeOtp).includes('411001'));

const pidgeGeneric = commerce.pidgePayloadToUpdate(
    { status: 'fulfilled', fulfillment: { status: 'OUT_FOR_DELIVERY', otp: '7788' } },
    'logistics'
);
assert.strictEqual(pidgeGeneric.deliveryOtp, '7788');
assert.strictEqual(pidgeGeneric.pickupOtp, '');
assert.strictEqual(pidgeGeneric.agentLat, null);

const shipdayDated = commerce.shipdayOrderToUpdate({
    orderNumber: 'BK1',
    orderId: 9,
    orderStatus: 'STARTED',
    expectedDeliveryDate: '2026-10-06',
    expectedDeliveryTime: '16:00:00',
    expectedPickupTime: '14:00:00',
    thirdPartyDeliveryOrder: { trackingId: 'AWB99' }
});
assert.strictEqual(shipdayDated.trackingNo, 'AWB99');
assert.strictEqual(shipdayDated.deliveryOtp, '');
assert.strictEqual(shipdayDated.pickupOtp, '');
assert.ok(shipdayDated.pickupAt);
assert.ok(shipdayDated.deliveryAt);
assert.ok(shipdayDated.deliveryAt > shipdayDated.pickupAt);
const shipdayOwn = commerce.shipdayOrderToUpdate({ orderNumber: 'BK1', orderId: 9, orderStatus: 'STARTED', trackingId: 'BK1' });
assert.strictEqual(shipdayOwn.trackingNo, '');

const pidgeLogistics = commerce.pidgePayloadToUpdate(
    {
        id: 'pidge-1',
        status: 'fulfilled',
        fulfillment: {
            status: 'OUT_FOR_DELIVERY',
            logs: [{ status: 'OUT_FOR_DELIVERY', location: { latitude: 18.52, longitude: 73.85 }, rider: { name: 'Asha', mobile: '9000000001' } }]
        }
    },
    'logistics'
);
assert.strictEqual(pidgeLogistics.agentLat, null);
assert.strictEqual(pidgeLogistics.agentName, null);

const pidgeCompleted = commerce.pidgePayloadToUpdate({ status: 'completed', fulfillment: { status: 'RTO_DELIVERED' } }, 'logistics');
assert.strictEqual(pidgeCompleted.kind, 'failed');
const pidgeCompletedBare = commerce.pidgePayloadToUpdate({ status: 'completed' }, 'logistics');
assert.notStrictEqual(pidgeCompletedBare.kind, 'delivered');
const pidgeCancelled = commerce.pidgePayloadToUpdate({ id: 'x', status: 'cancelled' }, 'logistics');
assert.strictEqual(pidgeCancelled.cancelOrder, true);
assert.notStrictEqual(pidgeCancelled.kind, 'delivered');
const pidgeRevert = commerce.pidgePayloadToUpdate({ status: 'pending', fulfillment: { status: 'CANCELLED' } }, 'hyperlocal');
assert.strictEqual(pidgeRevert.kind, 'pickup_scheduled');
assert.notStrictEqual(pidgeRevert.kind, 'failed');
const pidgeReached = commerce.pidgePayloadToUpdate({ status: 'fulfilled', fulfillment: { status: 'REACHED_DELIVERY' } }, 'hyperlocal');
assert.strictEqual(pidgeReached.kind, 'out_for_delivery');
assert.strictEqual(pidgeReached.title, 'Delivery agent reached the drop location');
assert.strictEqual(pidgeReached.stage, 'out_for_delivery');

const pidgeCfg = commerce.normalizeCommerceConfig({
    storeName: 'VGMF',
    storePhone: '9123456780',
    storeAddress: 'Clinic road',
    storeCity: 'Pune',
    storeState: 'Maharashtra',
    storePincode: '411001',
    defaultHyperlocalProvider: 'pidge',
    pidge: { enabled: true, username: 'vendor1', password: 'secret-pass', channel: 'shop' }
});
assert.strictEqual(pidgeCfg.defaultHyperlocalProvider, 'pidge');
const pidgePublic = commerce.publicConfigView(pidgeCfg);
assert.ok(!JSON.stringify(pidgePublic).includes('secret-pass'));
assert.strictEqual(pidgePublic.pidge.configured, true);
assert.strictEqual(pidgePublic.pidge.channel, 'shop');
const pidgeKept = commerce.mergeConfigSecrets(pidgeCfg, { pidge: { enabled: true, username: '', password: '', webhookToken: '' }, defaultHyperlocalProvider: 'pidge' });
assert.strictEqual(pidgeKept.pidge.password, 'secret-pass');
assert.strictEqual(pidgeKept.pidge.username, 'vendor1');
assert.strictEqual(pidgeKept.defaultHyperlocalProvider, 'pidge');

const pidgeBody = commerce.buildPidgeOrderBody(pidgeCfg, {
    orderCode: 'BKTEST',
    shippingPhone: '9876543210',
    shippingRecipientName: 'Buyer',
    deliveryAddress: 'Lane 1',
    shippingCity: 'Pune',
    shippingState: 'Maharashtra',
    shippingPincode: '411009',
    paymentMode: 'cod',
    totalAmount: 100,
    items: [{ title: 'Book', qty: 1, unitPrice: 100, book_id: 'b1' }],
    pickupAtMs: Date.parse('2026-10-06T04:30:00.000Z'),
    dropAtMs: Date.parse('2026-10-06T06:30:00.000Z')
});
const pidgeJson = JSON.stringify(pidgeBody);
assert.strictEqual(pidgeBody.channel, 'shop');
assert.strictEqual(pidgeBody.trips[0].source_order_id, 'BKTEST');
assert.strictEqual(pidgeBody.trips[0].cod_amount, 100);
assert.strictEqual(pidgeBody.trips[0].receiver_detail.address.country, 'India');
assert.strictEqual(pidgeBody.sender_detail.address.state, 'Maharashtra');
assert.strictEqual(pidgeBody.sender_detail.address.pincode, '411001');
assert.strictEqual(pidgeBody.trips[0].receiver_detail.address.state, 'Maharashtra');
assert.strictEqual(pidgeBody.trips[0].receiver_detail.address.pincode, '411009');
const pidgeFromLine = commerce.buildPidgeOrderBody(
    commerce.normalizeCommerceConfig({
        storeName: 'VGMF',
        storePhone: '9123456780',
        storeAddress: 'Clinic road, Pune, Maharashtra 411001',
        storeCity: 'Pune',
        pidge: { enabled: true, username: 'vendor1', password: 'secret-pass' }
    }),
    {
        orderCode: 'BKLINE',
        shippingPhone: '9876543210',
        shippingRecipientName: 'Buyer',
        deliveryAddress: 'Lane 1, Pune, Maharashtra 411009',
        paymentMode: 'prepaid',
        totalAmount: 50,
        items: [{ title: 'Book', qty: 1, unitPrice: 50 }]
    }
);
assert.strictEqual(pidgeFromLine.sender_detail.address.state, 'Maharashtra');
assert.strictEqual(pidgeFromLine.sender_detail.address.pincode, '411001');
assert.strictEqual(pidgeFromLine.trips[0].receiver_detail.address.state, 'Maharashtra');
assert.strictEqual(pidgeFromLine.trips[0].receiver_detail.address.pincode, '411009');
assert.ok(!pidgeJson.includes('dead_weight'));
assert.ok(!pidgeJson.includes('image_url'));
assert.ok(!pidgeJson.includes('brand'));
assert.ok(!pidgeJson.includes('secret-pass'));
assert.strictEqual(commerce.pidgeWebhookAuthorized({ pidge: { webhookToken: '' } }, ''), true);
assert.strictEqual(commerce.pidgeWebhookAuthorized({ pidge: { webhookToken: 'hook' } }, 'Bearer hook'), true);
assert.strictEqual(commerce.pidgeWebhookAuthorized({ pidge: { webhookToken: 'hook' } }, 'nope'), false);

function code128Bits(svg) {
    const width = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
    const bits = new Array(width).fill('0');
    const re = /<rect x="(\d+)" y="0" width="(\d+)"/g;
    let m;
    while ((m = re.exec(svg))) {
        const x = Number(m[1]);
        const w = Number(m[2]);
        for (let i = 0; i < w; i++) bits[x + i] = '1';
    }
    return bits.join('').slice(10, width - 10);
}
const codeA = commerce.code128Svg('A');
assert.ok(codeA.includes('viewBox="0 0 66 '));
assert.strictEqual(code128Bits(codeA), '1101001000010100011000100010110001100011101011');
const codeOrder = commerce.code128Svg('BKLABEL1');
assert.ok(codeOrder.includes('viewBox="0 0 143 '));
assert.strictEqual(commerce.code128Svg(''), '');
assert.strictEqual(commerce.code128Svg('हिंदी'), '');
const qrMark = commerce.qrSvg('https://seminar.vaidyagogate.org/track-commerce?token=abc');
assert.ok(qrMark.includes('<svg'));
assert.ok(qrMark.includes('viewBox='));
assert.strictEqual(commerce.qrSvg(''), '');

const labelCfg = { storeName: 'VGMF', storeAddress: 'Clinic road', storeCity: 'Pune', storePhone: '9000000000' };
const labelBase = String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || process.env.APP_URL || 'https://seminar.vaidyagogate.org')
    .trim()
    .replace(/\/$/, '');
const labelHtml = commerce.labelHtml(
    {
        orderCode: 'BKLABEL1',
        commerceProvider: 'pidge',
        commerceMode: 'hyperlocal',
        pickupOtp: '9999',
        deliveryOtp: '1234',
        commerceTrackUrl: '/track-commerce?token=abc123token',
        courierTrackingNo: 'PIDGEAWB99',
        shippingRecipientName: 'Buyer',
        deliveryAddress: 'Lane 1',
        shippingCity: 'Pune',
        shippingState: 'Maharashtra',
        shippingPincode: '411009',
        items: [{ title: 'Book', qty: 2 }]
    },
    labelCfg
);
assert.ok(labelHtml.includes('data-sym="track-qr"'));
assert.ok(labelHtml.includes('data-sym="order-qr"'));
assert.ok(labelHtml.includes('data-sym="order-barcode"'));
assert.ok(labelHtml.includes('data-sym="courier-qr"'));
assert.ok(labelHtml.includes('data-sym="courier-barcode"'));
assert.ok(labelHtml.includes(labelBase + '/track-commerce?token=abc123token'));
assert.ok(labelHtml.includes('BKLABEL1'));
assert.ok(labelHtml.includes('PIDGEAWB99'));
assert.ok(labelHtml.includes('Gogate Products'));
assert.ok(!labelHtml.includes('9999'));
assert.ok(!labelHtml.includes('1234'));
assert.ok(!labelHtml.includes('api.qrserver.com'));
assert.ok(!labelHtml.includes('Delivery PIN'));
assert.strictEqual((labelHtml.match(/data-sym="order-barcode"/g) || []).length, 1);

const tookanLabel = commerce.labelHtml(
    {
        orderCode: 'BKLABEL1',
        commerceProvider: 'tookan',
        pickupOtp: '2468',
        deliveryOtp: '1357',
        courierTrackingNo: 'BKLABEL1',
        commerceTrackUrl: 'https://seminar.vaidyagogate.org/track-commerce?token=abc123token',
        items: []
    },
    labelCfg
);
assert.ok(!tookanLabel.includes('data-sym="courier-barcode"'));
assert.ok(!tookanLabel.includes('data-sym="courier-qr"'));
assert.ok(tookanLabel.includes('2468'));
assert.ok(tookanLabel.includes('1357'));
assert.ok(tookanLabel.includes('https://seminar.vaidyagogate.org/track-commerce?token=abc123token'));
assert.strictEqual((tookanLabel.match(/data-sym="order-barcode"/g) || []).length, 1);

const bareLabel = commerce.labelHtml({ orderCode: 'ONLYCODE', commerceProvider: 'shipday', pickupOtp: '0000', items: [] }, labelCfg);
assert.ok(bareLabel.includes('assigns an AWB'));
assert.ok(!bareLabel.includes('<svg'));
assert.ok(!bareLabel.includes('window.print'));
assert.ok(!bareLabel.includes('Pickup OTP'));
assert.ok(!bareLabel.includes('Delivery OTP'));
assert.strictEqual(commerce.awbFromUpdate({ trackingNo: 'AWB45' }), 'AWB45');
assert.strictEqual(commerce.awbFromUpdate({ barcode: 'BAR1' }), 'BAR1');
assert.strictEqual(commerce.awbFromUpdate(null), '');

console.log('commerce phrase tests passed');

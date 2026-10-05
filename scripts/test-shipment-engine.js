const assert = require('assert');
const engine = require('../lib/shipment-engine');
const shop = require('../lib/shop-timeline');

assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'placed', status: 'confirmed', commerceProvider: 'tookan' }), 'ORDERED');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'preparing', commerceProvider: 'tookan' }), 'ORDERED');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'ready', commerceProvider: 'tookan' }), 'PACKED');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'pickup_scheduled', status: 'shipped', commerceProvider: 'tookan' }), 'PACKED');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'in_transit', commerceProvider: 'tookan' }), 'SHIPPED');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'out_for_delivery', commerceProvider: 'shipday' }), 'OUT_FOR_DELIVERY');
assert.strictEqual(engine.mainKeyFromOrder({ commerceStage: 'delivered' }), 'DELIVERED');

assert.strictEqual(engine.allowMainTransition('ORDERED', 'PACKED'), true);
assert.strictEqual(engine.allowMainTransition('PACKED', 'SHIPPED'), true);
assert.strictEqual(engine.allowMainTransition('SHIPPED', 'OUT_FOR_DELIVERY'), true);
assert.strictEqual(engine.allowMainTransition('OUT_FOR_DELIVERY', 'DELIVERED'), true);
assert.strictEqual(engine.allowMainTransition('ORDERED', 'DELIVERED'), false);
assert.strictEqual(engine.allowMainTransition('PACKED', 'OUT_FOR_DELIVERY'), false);
assert.strictEqual(engine.allowMainTransition('DELIVERED', 'PACKED'), false);
assert.strictEqual(engine.allowMainTransition('ORDERED', 'ORDERED'), true);

const logistics = engine.buildCustomerTracking(
    {
        orderCode: 'BK1',
        status: 'shipped',
        commerceStage: 'in_transit',
        commerceMode: 'logistics',
        commerceProvider: 'tookan',
        fulfillmentType: 'courier',
        courierTrackingNo: 'RIECA5I4',
        pickupOtp: '4321',
        deliveryOtp: '8765',
        agentName: 'Ravi',
        agentPhone: '9800000000'
    },
    [
        { title: 'Created By API - Gogate Products - 884520', kind: 'update', at: '2026-10-05T06:00:00Z' },
        { title: 'Shipment arrived at Courier Facility', kind: 'arrived_facility', city: 'Pune', detail: 'Swargate Hub', at: '2026-10-05T08:00:00Z' },
        { title: 'Expected at Lonavala Hub', kind: 'hub_eta', city: 'Lonavala', at: '2026-10-05T12:00:00Z' }
    ]
);
assert.strictEqual(logistics.fulfillmentType, 'NORMAL_LOGISTICS');
assert.strictEqual(logistics.mainStatus, 'SHIPPED');
assert.strictEqual(logistics.map.enabled, false);
assert.strictEqual(logistics.shipment.trackingId, 'RIECA5I4');
assert.strictEqual(logistics.shipment.courier, 'Gogate Products');
assert.strictEqual(logistics.pickupOtp, null);
assert.strictEqual(logistics.deliveryOtp, null);
assert.strictEqual(logistics.agent, null);
assert.strictEqual(logistics.deliveryNote, null);
assert.strictEqual(logistics.dropLabel, null);
assert.strictEqual(logistics.expectedDelivery, null);
assert.ok(!logistics.timeline.some((row) => /created by api/i.test(row.message)));
const arrived = logistics.timeline.find((row) => row.message === 'Item arrived at courier facility');
assert.ok(arrived);
assert.strictEqual(arrived.city, 'Pune');
assert.strictEqual(arrived.state, null);
assert.strictEqual(arrived.country, null);
assert.strictEqual(arrived.facilityName, 'Swargate Hub');
const hubCopy = engine.customerEvent({
    title: 'Shipment Received at Local Hub- Pune Maharashtra, India',
    kind: 'arrived_facility',
    at: '2026-10-05T09:00:00Z'
});
assert.strictEqual(hubCopy.message, 'Shipment Received at Local Hub- Pune Maharashtra, India');
assert.strictEqual(hubCopy.parentStage, 'SHIPPED');
const leftCopy = engine.customerEvent({
    title: 'Shipment Left Local Hub- Pune Maharashtra, India',
    kind: 'left_facility',
    at: '2026-10-05T10:00:00Z'
});
assert.strictEqual(leftCopy.message, 'Shipment Left Local Hub- Pune Maharashtra, India');
assert.strictEqual(leftCopy.parentStage, 'SHIPPED');
assert.strictEqual(logistics.pipeline.filter((step) => step.state === 'done').length, 2);
assert.strictEqual(logistics.pipeline.find((step) => step.key === 'SHIPPED').state, 'active');
assert.strictEqual(logistics.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY').state, 'upcoming');

const hyper = engine.buildCustomerTracking(
    {
        orderCode: 'BK2',
        status: 'shipped',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        pickupOtp: '1111',
        deliveryOtp: '2222',
        agentName: 'Asha',
        agentPhone: '9811111111',
        agentLat: 18.52,
        agentLng: 73.85,
        agentLocationAt: new Date().toISOString(),
        deliveryAddress: '15th Cross, 2nd Street',
        deliveryNote: 'Leave at the door'
    },
    [{ title: 'Out for delivery', kind: 'out_for_delivery', at: '2026-10-05T09:00:00Z' }]
);
assert.strictEqual(hyper.fulfillmentType, 'HYPERLOCAL');
assert.strictEqual(hyper.mainStatus, 'OUT_FOR_DELIVERY');
assert.strictEqual(hyper.map.enabled, true);
assert.strictEqual(hyper.deliveryOtp, '2222');
assert.strictEqual(hyper.pickupOtp, null);
assert.strictEqual(hyper.agent.name, 'Asha');
assert.strictEqual(hyper.agent.phone, '9811111111');
assert.strictEqual(hyper.agent.latitude, 18.52);
assert.strictEqual(hyper.map.live, true);
assert.strictEqual(hyper.dropLabel, '15th Cross, 2nd Street');
assert.strictEqual(hyper.deliveryNote, 'Leave at the door');
const longDrop = engine.buildCustomerTracking(
    {
        orderCode: 'BK2B',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        deliveryAddress: 'A very long delivery address that should be shortened for the map card and not shown as a delivery pin'
    },
    []
);
assert.strictEqual(longDrop.dropLabel.length, 80);
assert.ok(longDrop.dropLabel.endsWith('...'));
assert.ok(!JSON.stringify(longDrop).includes('Delivery PIN'));

const shipday = engine.buildCustomerTracking(
    {
        orderCode: 'BK3',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'shipday',
        pickupOtp: '1111',
        deliveryOtp: '2222',
        agentName: 'Ravi',
        agentPhone: '9800000000'
    },
    []
);
assert.strictEqual(shipday.deliveryOtp, null);
assert.strictEqual(shipday.pickupOtp, null);

const pidgeTrack = engine.buildCustomerTracking(
    {
        orderCode: 'BKPIDGE',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'pidge',
        deliveryOtp: '4455',
        pickupAt: '2026-10-05T06:00:00.000Z',
        deliveryAt: '2026-10-05T10:00:00.000Z',
        shippingPincode: '411009'
    },
    [],
    { now: Date.parse('2026-10-05T08:00:00.000Z') }
);
assert.strictEqual(pidgeTrack.deliveryOtp, '4455');
assert.strictEqual(pidgeTrack.pickupOtp, null);
assert.ok(pidgeTrack.deliveryBy);
assert.ok(!pidgeTrack.pickupBy);
assert.ok(!JSON.stringify(pidgeTrack).includes('411009'));
const pidgeOfd = pidgeTrack.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY');
assert.ok(pidgeOfd.lineGrow <= 0.55);
assert.ok(pidgeOfd.lineGrow >= 0.45);
assert.ok(pidgeOfd.lineUntil > pidgeOfd.lineSince);

const moving = engine.buildCustomerTracking(
    {
        orderCode: 'BKMOVE',
        commerceStage: 'in_transit',
        commerceMode: 'logistics',
        commerceProvider: 'tookan',
        pickupAt: '2026-10-05T06:00:00.000Z',
        deliveryAt: '2026-10-05T10:00:00.000Z'
    },
    [],
    { now: Date.parse('2026-10-05T07:00:00.000Z') }
);
const movingShipped = moving.pipeline.find((step) => step.key === 'SHIPPED');
assert.strictEqual(movingShipped.state, 'active');
assert.ok(movingShipped.lineGrow < 0.55);
assert.ok(movingShipped.lineGrow > 0.12);
assert.ok(moving.deliveryBy);
assert.strictEqual(moving.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY').state, 'upcoming');
assert.strictEqual(shipday.map.enabled, true);
assert.strictEqual(shipday.map.live, false);
assert.strictEqual(shipday.deliveryNote, '');
assert.strictEqual(shipday.dropLabel, null);

const failed = engine.buildCustomerTracking(
    {
        orderCode: 'BK5',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        deliveryOtp: '2222',
        agentName: 'Asha',
        agentPhone: '9811111111',
        shippingPincode: '411009'
    },
    [
        { title: 'Out for delivery', kind: 'out_for_delivery', at: '2026-10-04T11:24:00Z' },
        { title: 'Delivery agent reached the drop location', kind: 'out_for_delivery', city: 'PUNE, MAHARASHTRA, PIN 411009', detail: 'PUNE, MAHARASHTRA, PIN 411009', at: '2026-10-04T11:26:00Z' },
        { title: 'Delivery attempt failed', kind: 'failed', city: 'PUNE, MAHARASHTRA, PIN 411009', detail: 'PUNE, MAHARASHTRA, PIN 411009', at: '2026-10-04T11:27:00Z' }
    ]
);
assert.strictEqual(failed.mainStatus, 'OUT_FOR_DELIVERY');
assert.strictEqual(failed.operationalStatus, 'DELIVERY_ATTEMPT_FAILED');
assert.strictEqual(failed.currentStatus, 'Delivery attempt unsuccessful');
assert.strictEqual(failed.map.enabled, false);
assert.strictEqual(failed.deliveryOtp, null);
assert.strictEqual(failed.agent, null);
assert.strictEqual(failed.deliveryNote, null);
assert.strictEqual(failed.dropLabel, null);
assert.ok(failed.slots.length > 0);
assert.strictEqual(failed.slots[0].source, 'store_delivery_hours');
assert.ok(/Tomorrow/.test(failed.slots[0].label));
assert.strictEqual(failed.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY').state, 'active');
assert.strictEqual(failed.pipeline.length, 5);
assert.ok(failed.timeline.some((row) => row.message === 'Delivery attempt unsuccessful' && row.parentStage === 'OUT_FOR_DELIVERY' && !row.location && !row.reason));
assert.ok(failed.timeline.some((row) => row.message === 'Delivery partner reached your location' && !row.location));
const ofd = failed.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY');
assert.ok(ofd.events && ofd.events.length === 3);
assert.ok(!JSON.stringify(failed).includes('411009'));
assert.ok(!JSON.stringify(failed).includes('"Update"'));
assert.ok(!JSON.stringify(failed).includes('Delivery PIN'));

const again = engine.buildCustomerTracking(
    {
        orderCode: 'BK5',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        rescheduledForStart: '2026-10-05T08:30:00+05:30',
        rescheduledForEnd: '2026-10-05T11:30:00+05:30'
    },
    [
        { title: 'Delivery attempt failed', kind: 'failed', at: '2026-10-04T11:27:00Z' },
        { title: 'Delivery has been rescheduled', kind: 'rescheduled', at: '2026-10-04T12:00:00Z' }
    ]
);
assert.strictEqual(again.operationalStatus, 'RESCHEDULED');
assert.strictEqual(again.mainStatus, 'OUT_FOR_DELIVERY');
assert.strictEqual(again.pipeline.find((step) => step.key === 'SHIPPED').state, 'done');
assert.strictEqual(again.pipeline.find((step) => step.key === 'OUT_FOR_DELIVERY').state, 'active');
assert.strictEqual(again.map.enabled, false);
assert.ok(again.expectedDelivery && again.expectedDelivery.label);

const packed = engine.buildCustomerTracking(
    {
        orderCode: 'BK4',
        commerceStage: 'pickup_scheduled',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        pickupOtp: '3434',
        storeLat: 18.5,
        storeLng: 73.8,
        dropLat: 18.6,
        dropLng: 73.9
    },
    [{ title: 'Your order has been placed', kind: 'placed', at: '2026-10-05T06:30:00Z' }]
);
assert.strictEqual(packed.mainStatus, 'PACKED');
assert.strictEqual(packed.pickupOtp, '3434');
assert.strictEqual(packed.agent, null);
const placedTl = shop.buildShopTimeline(
    {
        status: 'confirmed',
        commerceStage: 'pickup_scheduled',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        fulfillmentType: 'courier',
        orderCode: 'BK4',
        storeLat: 18.5,
        storeLng: 73.8,
        dropLat: 18.6,
        dropLng: 73.9
    },
    [],
    {}
);
const preview = shop.buildLiveView(
    {
        commerceMode: 'hyperlocal',
        commerceStage: 'pickup_scheduled',
        storeLat: 18.5,
        storeLng: 73.8,
        dropLat: 18.6,
        dropLng: 73.9
    },
    placedTl,
    'map-key'
);
assert.ok(preview);
assert.strictEqual(preview.agent, null);
assert.strictEqual(preview.route, 'dotted');
assert.strictEqual(
    shop.buildLiveView(
        {
            commerceMode: 'logistics',
            commerceStage: 'out_for_delivery',
            agentLat: 18.5,
            agentLng: 73.8,
            storeLat: 18.5,
            storeLng: 73.8,
            dropLat: 18.6,
            dropLng: 73.9,
            agentName: 'Ravi'
        },
        shop.buildShopTimeline(
            {
                status: 'shipped',
                commerceStage: 'out_for_delivery',
                commerceMode: 'logistics',
                commerceProvider: 'tookan',
                fulfillmentType: 'courier',
                orderCode: 'BK9'
            },
            [],
            {}
        ),
        'map-key'
    ),
    null
);

const fleetPacked = engine.buildCustomerTracking(
    {
        orderCode: 'FB4',
        commerceStage: 'pickup_scheduled',
        commerceMode: 'logistics',
        commerceProvider: 'fleetbase',
        fulfillmentType: 'courier',
        pickupOtp: '3434'
    },
    [{ title: 'Your order has been placed', kind: 'placed', at: '2026-10-05T06:30:00Z' }]
);
assert.strictEqual(fleetPacked.mainStatus, 'PACKED');
assert.strictEqual(fleetPacked.pickupOtp, '3434');
assert.strictEqual(fleetPacked.map.enabled, false);
const fleetHub = engine.buildCustomerTracking(
    {
        orderCode: 'FB5',
        commerceStage: 'in_transit',
        commerceMode: 'logistics',
        commerceProvider: 'fleetbase',
        fulfillmentType: 'courier'
    },
    [{ title: 'Arrived at Pune Hub', kind: 'arrived_facility', at: '2026-10-05T08:00:00Z', city: 'Pune' }]
);
assert.strictEqual(fleetHub.mainStatus, 'SHIPPED');
assert.ok(fleetHub.timeline.some((ev) => ev.message === 'Arrived at Pune Hub'));
const fleetOfd = engine.buildCustomerTracking(
    {
        orderCode: 'FB6',
        commerceStage: 'out_for_delivery',
        commerceMode: 'hyperlocal',
        commerceProvider: 'fleetbase',
        deliveryOtp: '4455',
        storeLat: 18.5,
        storeLng: 73.8,
        dropLat: 18.6,
        dropLng: 73.9
    },
    [{ title: 'Out for delivery', kind: 'out_for_delivery', at: '2026-10-05T09:00:00Z' }]
);
assert.strictEqual(fleetOfd.deliveryOtp, '4455');
assert.strictEqual(fleetOfd.pickupOtp, null);

console.log('shipment engine tests passed');

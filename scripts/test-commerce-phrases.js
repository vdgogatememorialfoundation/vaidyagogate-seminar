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

console.log('commerce phrase tests passed');

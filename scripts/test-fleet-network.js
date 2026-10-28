const assert = require('assert');
const network = require('../lib/fleet-network');

const seller = { city: 'Pune', state: 'Maharashtra', pincode: '411005', address: 'Shop 4 Shivaji Nagar Road' };
const drop = { city: 'Mumbai', state: 'Maharashtra', pincode: '400001', address: '12 Colaba Causeway' };
const hubs = [
    { id: 1, name: 'Local Hub', locality: 'Shivaji Nagar', city: 'Pune', state: 'Maharashtra', country: 'India', address: '1 Local Road', pincode: '411005', role: 'seller_local', mode: 'both', active: 1 },
    { id: 2, name: 'City Hub', locality: '', city: 'Pune', state: 'Maharashtra', country: 'India', address: '2 City Road', pincode: '411001', role: 'city_mother', mode: 'logistics', active: 1 },
    { id: 3, name: 'Route Hub', locality: '', city: 'Lonavala', state: 'Maharashtra', country: 'India', address: '3 Route Road', pincode: '410401', role: 'transit', mode: 'logistics', active: 1, from_city: 'Pune', to_city: 'Mumbai' },
    { id: 4, name: 'Destination Hub', locality: '', city: 'Mumbai', state: 'Maharashtra', country: 'India', address: '4 City Road', pincode: '400001', role: 'destination_city', mode: 'both', active: 1 },
    { id: 5, name: 'Drop Hub', locality: 'Colaba', city: 'Mumbai', state: 'Maharashtra', country: 'India', address: '5 Drop Road', pincode: '400001', role: 'delivery_local', mode: 'logistics', active: 1 },
    { id: 6, name: 'Other City', locality: 'Andheri', city: 'Mumbai', state: 'Maharashtra', country: 'India', address: '6 Other Road', pincode: '400053', role: 'seller_local', mode: 'both', active: 1 }
];

const route = network.planRoute(hubs, seller, drop, 'logistics');
assert.deepStrictEqual(route.map((hop) => hop.id), [1, 2, 3, 4, 5]);
assert.strictEqual(network.receivedLine(route[0]), 'Shipment Received at Local Hub- Pune Maharashtra, India');
assert.strictEqual(network.leftLine(route[0]), 'Shipment Left Local Hub- Pune Maharashtra, India');

const empty = network.planRoute([], seller, drop, 'logistics');
assert.deepStrictEqual(empty, []);
const noTransit = network.planRoute(
    hubs.filter((hub) => hub.role !== 'transit'),
    seller,
    drop,
    'logistics'
);
assert.ok(!noTransit.some((hop) => hop.role === 'transit'));

const sameCity = network.planRoute(hubs, seller, { city: 'Pune', state: 'Maharashtra', pincode: '411005', address: 'Shop 4 Shivaji Nagar Road' }, 'logistics');
assert.ok(!sameCity.some((hop) => hop.role === 'transit' || hop.role === 'destination_city'));

const awb = network.newAwb();
assert.ok(network.isAwb(awb));
assert.strictEqual(awb.length, 12);
assert.strictEqual(network.scanMatches(awb, awb), true);
assert.strictEqual(network.scanMatches(awb, '123'), false);
assert.strictEqual(network.scanMatches('000000000000', '000000000000'), false);

assert.strictEqual(network.needsOpenBox({ fragile: 1 }), true);
assert.strictEqual(network.needsOpenBox({ openBox: true }), true);
assert.strictEqual(network.needsOpenBox({}), false);
const obd = network.obdAnswersOk(
    { fragile: 1, shippingPhone: '919800011122', obdOtp: '135790' },
    { damaged: 'no', mobileLast4: '1122', obdOtp: '135790' }
);
assert.strictEqual(obd.ok, true);
assert.strictEqual(network.obdAnswersOk({ fragile: 1, shippingPhone: '919800011122', obdOtp: '135790' }, { damaged: 'no', mobileLast4: '0000', obdOtp: '135790' }).ok, false);

const bad = network.validateHub({ name: 'Store', address: 'Same as seller', city: 'Pune', state: 'Maharashtra', country: 'India', pincode: '411001', role: 'seller_local' });
assert.ok(bad.error);
const window = network.scheduleWindow({ deliveryOpen: '10:00', deliveryClose: '20:00' }, Date.parse('2026-10-05T12:00:00Z'));
assert.ok(window.pickupAt.indexOf('T10:00:00+05:30') !== -1);
assert.ok(window.deliveryAt.indexOf('+05:30') !== -1);
const logisticsTimes = network.plannedStopTimes('logistics', 'pidge', null, { deliveryOpen: '10:00', deliveryClose: '20:00' }, Date.parse('2026-10-05T12:00:00Z'));
assert.strictEqual(logisticsTimes.pickupAtMs, Date.parse('2026-10-06T10:00:00+05:30'));
assert.strictEqual(logisticsTimes.dropAtMs, Date.parse(window.deliveryAt));
const hyperTimes = network.plannedStopTimes('hyperlocal', 'pidge', null, { pickupLeadMinutes: 30, deliveryLeadMinutes: 90 }, Date.parse('2026-10-05T12:00:00.000Z'));
assert.strictEqual(hyperTimes.pickupAtMs, Date.parse('2026-10-05T12:00:00.000Z') + 30 * 60 * 1000);
assert.strictEqual(hyperTimes.dropAtMs, hyperTimes.pickupAtMs + 90 * 60 * 1000);
const chosen = Date.parse('2026-10-07T08:00:00Z');
const explicitTimes = network.plannedStopTimes('logistics', 'tookan', chosen, { deliveryOpen: '10:00', deliveryClose: '20:00' }, Date.parse('2026-10-05T12:00:00Z'));
assert.strictEqual(explicitTimes.pickupAtMs, chosen);

const hash = network.hashPassword('correct horse');
assert.strictEqual(network.verifyPassword('correct horse', hash), true);
assert.strictEqual(network.verifyPassword('wrong horse', hash), false);

console.log('fleet network tests passed');

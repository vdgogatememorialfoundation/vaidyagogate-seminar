/**
 * Rider icon stays put for GPS jitter and moves only after a real displacement.
 * Run: node scripts/rider-motion.test.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { payloadFor, attach, haversine, publishTrack } = require('../lib/rider-live-socket');
const shipmentEngine = require('../lib/shipment-engine');
const shopTimeline = require('../lib/shop-timeline');

function loadTimeline() {
    const sandbox = {
        window: {},
        document: {
            getElementById() {
                return null;
            },
            querySelectorAll() {
                return [];
            },
            body: { classList: { contains() { return false; } }, appendChild() {} },
            createElement() {
                return { style: {}, classList: { toggle() {}, remove() {} }, setAttribute() {}, appendChild() {} };
            }
        },
        location: { protocol: 'http:', host: '127.0.0.1' },
        WebSocket: function () {},
        console
    };
    sandbox.window = sandbox;
    sandbox.global = sandbox;
    const code = fs.readFileSync(path.join(__dirname, '../public/js/track-timeline.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'track-timeline.js' });
    return sandbox.TrackTimeline;
}

function shiftLat(point, meters) {
    return { lat: point.lat + meters / 111320, lng: point.lng };
}

async function socketScript() {
    const home = { lat: 19.076, lng: 72.8777 };
    let current = { agent: { lat: home.lat, lng: home.lng }, leg: 'to_drop' };
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });
    attach(server, null, {
        intervalMs: 80,
        sample(token, cb) {
            if (token !== 'track-token-1') return cb(null, null);
            cb(null, { orderId: 1, leg: current.leg, agent: { lat: current.agent.lat, lng: current.agent.lng } });
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const messages = [];
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/public/commerce/rider-live?token=track-token-1');
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('socket failed'));
    });
    ws.onmessage = (ev) => messages.push(JSON.parse(ev.data));
    await new Promise((r) => setTimeout(r, 180));
    current = { agent: shiftLat(home, 8), leg: 'to_drop' };
    await new Promise((r) => setTimeout(r, 200));
    const beforeMove = messages.length;
    current = { agent: shiftLat(home, 60), leg: 'to_drop' };
    await new Promise((r) => setTimeout(r, 250));
    ws.close();
    await new Promise((r) => server.close(r));
    return { messages, beforeMove };
}

async function trackSocketScript() {
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });
    attach(server, null, {
        intervalMs: 60000,
        trackIntervalMs: 40,
        sample(token, cb) {
            cb(null, null);
        },
        sampleTrack(token, cb) {
            if (token !== 'track-token-2') return cb(null, null);
            cb(null, {
                phase: 'Preparing your order',
                partner: 'Ravi',
                phone: '9999999999',
                deliveryOtp: '4821',
                pay: 'Pay on delivery',
                distance: ''
            });
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const messages = [];
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/public/commerce/track-live?token=track-token-2');
    ws.onmessage = (ev) => messages.push(JSON.parse(ev.data));
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('track socket failed'));
    });
    await new Promise((r) => setTimeout(r, 150));
    const pushed = publishTrack('track-token-2', {
        kind: 'picked_up',
        phase: 'On the way to you',
        partner: 'Ravi',
        deliveryOtp: '4821',
        leg: 'to_drop',
        distance: '1.2 km away'
    });
    await new Promise((r) => setTimeout(r, 80));
    ws.close();
    await new Promise((r) => server.close(r));
    return { messages, pushed };
}

function cardChecks(tl) {
    const order = {
        id: 9,
        orderCode: '482910334455',
        trackingToken: 'tokentoken12',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        fulfillmentType: 'courier',
        status: 'paid',
        commerceStage: 'preparing',
        liveLeg: 'to_store',
        deliveryOtp: '4821',
        agentName: 'Ravi',
        paymentMode: 'cod',
        items: [{ bookTitle: 'Child Health' }],
        createdAt: '2026-10-29T08:00:00Z',
        deliveryAddress: '12 Lake Road',
        shippingRecipientName: 'Asha',
        deliveryNote: 'Gate 2'
    };
    const cards = shipmentEngine.trackingCards(order, { hyper: true, cancelled: false, rank: 1, move: '' });
    const by = {};
    cards.forEach((card) => { by[card.key] = card; });
    assert.ok(cards.length <= 8);
    assert.strictEqual(by.now.value, 'Heading to the store');
    assert.strictEqual(by.partner.value, 'Ravi');
    assert.strictEqual(by.pay.value, 'Pay on delivery');
    assert.ok(by.bag && /1 item/.test(by.bag.value));
    assert.strictEqual(by.for.value, 'Asha');
    assert.strictEqual(by.note.value, 'Gate 2');
    assert.ok(!cards.some((card) => /Order confirmed|Waiting to collect|Partner nearby/.test(card.value + card.label)));
    const built = shipmentEngine.buildCustomerTracking(order, [], {});
    assert.strictEqual(built.deliveryOtp, '4821');
    assert.strictEqual(built.scanId, '482910334455');
    assert.ok(!/ship-scan|https?:/i.test(built.scanId));
    assert.strictEqual(built.shipmentQrSvg, shipmentEngine.shipmentQrSvg('482910334455'));
    const words = shipmentEngine.buildCustomerTracking(Object.assign({}, order, { deliveryOtp: 'call me' }), [], {});
    assert.ok(!words.deliveryOtp);
    const shipday = shipmentEngine.buildCustomerTracking(Object.assign({}, order, { commerceProvider: 'shipday', deliveryOtp: '9999' }), [], {});
    assert.ok(!shipday.deliveryOtp);
    const logistics = shipmentEngine.agentScanText({ commerceMode: 'logistics', orderCode: '482910334455', courierTrackingNo: 'AWB9988' });
    assert.strictEqual(logistics.scanId, 'AWB9988');
    assert.strictEqual(logistics.scanKind, 'tracking');
    const html = tl.render({
        timeline: {
            steps: [{ title: 'Ordered', state: 'active', key: 'ordered', summary: 'Placed' }],
            cards: cards,
            orderCode: '482910334455',
            deliveryOtp: '4821',
            scanId: '482910334455',
            scanKind: 'order',
            shipmentQrSvg: '<svg></svg>'
        },
        live: null
    });
    assert.ok(html.indexOf('data-tl-card="now"') >= 0);
    assert.ok(html.indexOf('Heading to the store') >= 0);
    assert.ok(html.indexOf('4821') >= 0);
    assert.ok(html.indexOf('Ordered') >= 0);
    assert.ok(html.indexOf('Order confirmed') < 0);
    assert.ok(html.indexOf('Waiting to collect') < 0);
}

async function main() {
    const tl = loadTimeline();
    const home = { lat: 19.076, lng: 72.8777 };
    const first = tl.acceptFix(null, home, 18);
    assert.strictEqual(first.first, true);
    assert.strictEqual(first.traveling, false);

    const jitter = tl.acceptFix(first.point, shiftLat(home, 8), 18);
    assert.strictEqual(jitter.ignored, true);
    assert.strictEqual(jitter.traveling, false);
    assert.strictEqual(jitter.point.lat, first.point.lat);

    const moved = tl.acceptFix(first.point, shiftLat(home, 60), 18);
    assert.strictEqual(moved.traveling, true);
    assert.ok(Math.abs(moved.point.lat - shiftLat(home, 60).lat) < 1e-9);

    const teleport = tl.acceptFix(first.point, shiftLat(home, 2000), 18);
    assert.strictEqual(teleport.snap, true);
    assert.strictEqual(teleport.traveling, false);

    const still = payloadFor({ agent: home, leg: 'to_drop' }, { agent: shiftLat(home, 5), leg: 'to_drop' });
    assert.strictEqual(still, null);
    const go = payloadFor({ agent: shiftLat(home, 40), leg: 'to_drop' }, { agent: home, leg: 'to_drop' });
    assert.strictEqual(go.type, 'rider');
    assert.ok(haversine(home, go.agent) > 18);

    const live = await socketScript();
    assert.ok(live.messages.length >= 1, 'first fix is pushed');
    assert.ok(live.messages[0].agent);
    const after = live.messages.slice(live.beforeMove);
    assert.ok(after.length >= 1, 'a real move is pushed');
    assert.ok(haversine(home, after[after.length - 1].agent) > 18);

    cardChecks(tl);
    const track = await trackSocketScript();
    assert.strictEqual(track.pushed, true);
    assert.ok(track.messages.some((msg) => msg.type === 'track' && msg.source === 'poll' && msg.phase === 'Preparing your order' && msg.deliveryOtp === '4821'));
    assert.ok(track.messages.some((msg) => msg.source === 'webhook' && msg.kind === 'picked_up' && msg.phase === 'On the way to you' && msg.distance === '1.2 km away'));
    const failedOnly = [{ kind: 'failed', title: 'Delivery attempt was unsuccessful', at: '2026-10-29T10:00:00Z' }];
    assert.strictEqual(shipmentEngine.operationalFromEvents(failedOnly), 'DELIVERY_ATTEMPT_FAILED');
    const reassigned = failedOnly.concat([
        { kind: 'rescheduled', title: 'New delivery attempt scheduled', at: '2026-10-29T10:05:00Z' },
        { kind: 'agent_assigned', title: 'Delivery partner assigned', detail: 'Neha', at: '2026-10-29T10:06:00Z' }
    ]);
    assert.strictEqual(shipmentEngine.operationalFromEvents(reassigned), null);
    const order = {
        id: 9,
        orderCode: '482910334455',
        commerceMode: 'hyperlocal',
        commerceProvider: 'tookan',
        status: 'shipped',
        commerceStage: 'out_for_delivery',
        createdAt: '2026-10-29T08:00:00Z',
        storeLat: 19.07,
        storeLng: 72.87,
        dropLat: 19.08,
        dropLng: 72.88,
        agentName: 'Neha',
        agentLat: 19.075,
        agentLng: 72.875,
        agentLocationAt: new Date().toISOString(),
        liveLeg: 'to_store',
        trackingToken: 'tokentoken12',
        parcelInfo: { reattempts: [{ at: '2026-10-29T10:05:00Z' }] }
    };
    const closed = shopTimeline.buildLiveView(order, shopTimeline.buildShopTimeline(order, failedOnly, {}), 'test-key');
    assert.strictEqual(closed, null);
    const timeline = shopTimeline.buildShopTimeline(order, reassigned, {});
    const opened = shopTimeline.buildLiveView(order, timeline, 'test-key');
    assert.ok(opened && opened.agent);
    assert.strictEqual(opened.leg, 'to_store');
    assert.strictEqual(opened.phaseLabel, 'Heading to the store');
    console.log('rider motion ok', live.messages.length, 'socket messages');
    console.log('track cards ok', track.messages.length, 'track messages');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

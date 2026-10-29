/**
 * Rider icon stays put for GPS jitter and moves only after a real displacement.
 * Run: node scripts/rider-motion.test.js
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { payloadFor, attach, haversine } = require('../lib/rider-live-socket');

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
    console.log('rider motion ok', live.messages.length, 'socket messages');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

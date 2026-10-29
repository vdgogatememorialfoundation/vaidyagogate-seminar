/**
 * Online seminar choice, provider calls, and the private hall.
 * Provider tests use a fake HTTP client. No Zoom, Google, or Zoho account is contacted.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const { WebSocket } = require('ws');
const providers = require('../lib/online-seminar-providers');
const hall = require('../lib/vgmf-hall');
const online = require('../lib/online-seminar');

function fakeHttp(routes) {
    return async function (url, opts) {
        const hit = routes.find((route) => url.indexOf(route.match) >= 0 && (!route.method || route.method === (opts && opts.method)));
        if (!hit) throw new Error('unexpected url ' + url);
        hit.seen = (hit.seen || 0) + 1;
        hit.last = { url, opts };
        return { status: hit.status || 200, json: hit.json || {}, text: hit.text || '' };
    };
}

(async () => {
    assert.strictEqual(providers.zohoStartTime(new Date('2026-02-04T10:30:00+05:30')), 'Feb 4, 2026 10:30 AM');
    assert.strictEqual(providers.zoomLocalStart(new Date('2026-02-04T16:05:00+05:30')), '2026-02-04T16:05:00');

    const masked = providers.maskSettings({
        zoom: { accountId: 'acc', clientId: 'cid', clientSecret: 'super-secret' },
        google: { clientId: 'g', clientSecret: 'gsec', refreshToken: 'refresh-1' }
    });
    assert.strictEqual(masked.zoom.clientSecret, '********');
    assert.strictEqual(masked.google.refreshToken, '********');
    assert.strictEqual(JSON.stringify(masked).includes('super-secret'), false);
    const merged = providers.mergeSettings(
        { zoom: { accountId: 'acc', clientId: 'cid', clientSecret: 'super-secret' } },
        { zoom: { accountId: 'acc', clientId: 'cid', clientSecret: '********' } }
    );
    assert.strictEqual(merged.zoom.clientSecret, 'super-secret');

    const zoomRoutes = [
        { match: 'zoom.us/oauth/token', json: { access_token: 'zoom-token' } },
        { match: '/users/me/meetings', json: { id: 99, join_url: 'https://zoom.example/j/99', start_url: 'https://zoom.example/s/99', password: '123456' } }
    ];
    const zoomHttp = fakeHttp(zoomRoutes);
    const created = await providers.provisionMeeting({
        provider: 'zoom',
        settings: { zoom: { accountId: 'acc', clientId: 'cid', clientSecret: 'sec' } },
        seminar: { id: 7, title: 'Manas Rog', description: 'Day', event_date: '2026-06-01T10:00:00+05:30', event_end_date: '2026-06-01T13:00:00+05:30' },
        existing: null,
        manual: {},
        http: zoomHttp
    });
    assert.strictEqual(created.joinUrl, 'https://zoom.example/j/99');
    assert.strictEqual(created.hostUrl, 'https://zoom.example/s/99');
    assert.strictEqual(JSON.stringify(zoomRoutes[1].last.opts.body).includes('Asia/Kolkata'), true);

    const pending = await providers.provisionMeeting({
        provider: 'google_meet',
        settings: providers.emptySettings(),
        seminar: { id: 7, title: 'Manas Rog', event_date: '2026-06-01T10:00:00+05:30' },
        existing: null,
        manual: { joinUrl: '' },
        http: async () => { throw new Error('should not call Google'); }
    });
    assert.strictEqual(pending.warning.includes('not connected'), true);

    const vgmf = await providers.provisionMeeting({
        provider: 'vgmf',
        settings: providers.emptySettings(),
        seminar: { id: 15, title: 'Hall' },
        existing: null,
        manual: { use: true, joinUrl: 'https://evil.example' },
        http: async () => { throw new Error('hall does not call out'); }
    });
    assert.strictEqual(vgmf.joinUrl, '/hall/15');

    const room = hall.createRoom(15, { waitingRoom: true, maxDirect: 2 });
    const host = { userId: 1, role: 'host', name: 'Office', sent: [], deliver(obj) { this.sent.push(obj); } };
    const doctor = { userId: 4, role: 'audience', name: 'Dr Asha', sent: [], deliver(obj) { this.sent.push(obj); } };
    assert.strictEqual(hall.addClient(room, host).ok, true);
    assert.strictEqual(hall.addClient(room, doctor).waiting, true);
    const blocked = hall.applyHallMessage(room, doctor, { type: 'chat', text: 'hello' });
    assert.strictEqual(blocked.ok, false);
    hall.applyHallMessage(room, host, { type: 'host', action: 'admit', userId: 4 });
    assert.strictEqual(doctor.waiting, false);
    hall.applyHallMessage(room, doctor, { type: 'chat', text: 'Good morning' });
    assert.strictEqual(host.sent.some((row) => row.type === 'chat' && row.message.text === 'Good morning'), true);
    const denied = hall.applyHallMessage(room, doctor, { type: 'host', action: 'end' });
    assert.strictEqual(denied.ok, false);
    const kicked = hall.applyHallMessage(room, host, { type: 'host', action: 'kick', userId: 4 });
    assert.strictEqual(kicked.effects[0], 'ban');
    assert.strictEqual(hall.addClient(room, doctor).ok, false);
    assert.strictEqual(hall.safeMediaName('..'), '');
    assert.strictEqual(hall.safeMediaName('live.m3u8'), 'live.m3u8');
    assert.strictEqual(hall.safeMediaName('seg3.ts'), 'seg3.ts');
    assert.strictEqual(hall.ffmpegArgs('/tmp/vgmf-hall/15').includes('libx264'), true);

    const db = new sqlite3.Database(':memory:');
    const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params || [], (err) => (err ? reject(err) : resolve())));
    await run(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT)`);
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, user_id_string TEXT, first_name TEXT, last_name TEXT, role TEXT, user_role TEXT)`);
    await run(`CREATE TABLE seminars (id INTEGER PRIMARY KEY, title TEXT, description TEXT, event_date TEXT, event_end_date TEXT, price REAL)`);
    await run(`CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, status TEXT)`);
    await run(`CREATE TABLE seminar_volunteers (id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, status TEXT)`);
    await run(`INSERT INTO users (id, user_id_string, first_name, last_name, role, user_role) VALUES (4, 'PRN1', 'Asha', 'Gogate', 'doctor', 'doctor')`);
    await run(`INSERT INTO users (id, user_id_string, first_name, last_name, role, user_role) VALUES (1, 'ADM1', 'Office', 'Admin', 'admin', 'admin')`);
    await run(`INSERT INTO seminars (id, title, description, event_date, event_end_date, price) VALUES (9, 'Manas Rog 3', 'Seminar', '2020-01-01T10:00:00+05:30', '2020-01-01T16:00:00+05:30', 100)`);
    await run(`INSERT INTO registrations (id, user_id, seminar_id, status) VALUES (3, 4, 9, 'e_ticket_issued')`);
    await new Promise((resolve, reject) => online.ensureSchema(db, (err) => (err ? reject(err) : resolve())));

    const saved = await new Promise((resolve, reject) => {
        online.persistFromSeminarBody(db, 9, { delivery_mode: 'online', meeting_provider: 'vgmf', meeting_waiting_room: true, meeting_passcode: '4491' }, (err, out) =>
            err ? reject(err) : resolve(out)
        );
    });
    assert.strictEqual(saved.meeting.join_url, '/hall/9');
    assert.strictEqual(saved.warning, '');

    const rows = [{ id: 9, title: 'Manas Rog 3' }];
    await new Promise((resolve, reject) => online.attachPublicSummary(db, rows, (err) => (err ? reject(err) : resolve())));
    assert.strictEqual(rows[0].online_seminar.provider, 'vgmf');
    assert.strictEqual(rows[0].online_seminar.join_url, undefined);
    assert.strictEqual(JSON.stringify(rows[0]).includes('4491'), false);

    const early = await online.issueJoin(db, { seminarId: 9, userId: 4, userIdString: 'PRN1', passcode: '4491', now: Date.parse('2019-01-01T00:00:00Z') });
    assert.strictEqual(early.status, 403);
    const wrongUser = await online.issueJoin(db, { seminarId: 9, userId: 4, userIdString: 'NOPE', passcode: '4491', now: Date.parse('2020-01-01T05:00:00Z') });
    assert.strictEqual(wrongUser.status, 403);
    const badPass = await online.issueJoin(db, { seminarId: 9, userId: 4, userIdString: 'PRN1', passcode: '0000', now: Date.parse('2020-01-01T05:00:00Z') });
    assert.strictEqual(badPass.status, 401);
    const joined = await online.issueJoin(db, { seminarId: 9, userId: 4, userIdString: 'PRN1', passcode: '4491', now: Date.parse('2020-01-01T05:00:00Z') });
    assert.strictEqual(joined.status, 200);
    assert.strictEqual(joined.body.mode, 'hall');
    assert.strictEqual(joined.body.url, '/hall/9');
    const hostJoin = await online.issueJoin(db, { seminarId: 9, admin: { id: 1, role: 'admin', user_role: 'admin', first_name: 'Office', last_name: 'Admin' }, now: Date.now() });
    assert.strictEqual(hostJoin.body.role, 'host');

    const app = express();
    app.use(express.json());
    online.registerOnlineSeminarRoutes(app, {
        db,
        publicDir: require('path').join(__dirname, '..', 'public'),
        assertAdminPortalActor(id, cb) {
            if (Number(id) === 1) return cb(null, { id: 1, role: 'admin', user_role: 'admin', first_name: 'Office', last_name: 'Admin' });
            cb(new Error('FORBIDDEN'));
        }
    });
    const server = http.createServer(app);
    online.attachHall(server, { db });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const page = await fetch(`http://127.0.0.1:${port}/hall/9`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.strictEqual(html.includes('VGMF Hall'), true);

    const wsHost = new WebSocket(`ws://127.0.0.1:${port}/api/hall/socket?token=${encodeURIComponent(hostJoin.token)}`);
    const wsDoctor = new WebSocket(`ws://127.0.0.1:${port}/api/hall/socket?token=${encodeURIComponent(joined.token)}`);
    const hostMsgs = [];
    const doctorMsgs = [];
    wsHost.on('message', (buf, isBinary) => { if (!isBinary) hostMsgs.push(JSON.parse(String(buf))); });
    wsDoctor.on('message', (buf, isBinary) => { if (!isBinary) doctorMsgs.push(JSON.parse(String(buf))); });
    await new Promise((resolve, reject) => {
        wsHost.on('open', resolve);
        wsHost.on('error', reject);
    });
    await new Promise((resolve, reject) => {
        wsDoctor.on('open', resolve);
        wsDoctor.on('error', reject);
    });
    function waitFor(list, pred) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (list.some(pred)) {
                    clearInterval(timer);
                    resolve();
                } else if (Date.now() - start > 2000) {
                    clearInterval(timer);
                    reject(new Error('timed out waiting for hall message ' + JSON.stringify(list)));
                }
            }, 20);
        });
    }
    await waitFor(hostMsgs, (m) => m.type === 'snapshot');
    await waitFor(doctorMsgs, (m) => m.type === 'snapshot' && m.you && m.you.waiting);
    wsHost.send(JSON.stringify({ type: 'host', action: 'admit', userId: 4 }));
    await waitFor(doctorMsgs, (m) => m.type === 'admitted');
    wsDoctor.send(JSON.stringify({ type: 'chat', text: 'From the hall' }));
    await waitFor(hostMsgs, (m) => m.type === 'chat' && m.message && m.message.text === 'From the hall');
    wsDoctor.send(JSON.stringify({ type: 'host', action: 'end' }));
    await waitFor(doctorMsgs, (m) => m.type === 'error');
    wsHost.close();
    wsDoctor.close();
    server.close();
    db.close();
    console.log('online seminar ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

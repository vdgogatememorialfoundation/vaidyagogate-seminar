/**
 * Album purchase unlocks every part. A single video unlocks only itself.
 * Unlock picks Razorpay without asking the doctor to choose a method.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const vl = require('../lib/video-library');
const modules = require('../lib/doctor-portal-modules');

assert.strictEqual(vl.purchaseItem({ id: 2, album_id: 1, kind: 'episode', published: 1, status: 'ready', year: 2026, price_inr: 0, title: 'Part 1' }, { id: 1, kind: 'album', published: 1, status: 'ready', year: 2026, price_inr: 500, title: 'Day 1' }).videoId, 1);
assert.strictEqual(vl.purchaseItem({ id: 2, album_id: 1, kind: 'episode', published: 1, status: 'ready', year: 2026, price_inr: 0, title: 'Part 1' }, { id: 1, kind: 'album', published: 1, status: 'ready', year: 2026, price_inr: 500, title: 'Day 1' }).amount, 500);
assert.strictEqual(vl.purchaseItem({ id: 9, kind: 'full', published: 1, status: 'ready', year: 2026, price_inr: 200, title: 'Talk' }, null).videoId, 9);
assert.strictEqual(vl.purchaseItem({ id: 9, kind: 'full', published: 0, status: 'ready', year: 2026, price_inr: 200, title: 'Talk' }, null), null);

const options = [
    { id: 'razorpay:test', gateway: 'razorpay', mode: 'test', config: { key_id: 'rzp_test' } },
    { id: 'razorpay:live', gateway: 'razorpay', mode: 'live', config: { key_id: 'rzp_live' } },
    { id: 'dqr', gateway: 'razorpay', mode: 'live', config: {} }
];
assert.strictEqual(vl.pickRazorpayOption(options, 'razorpay').id, 'razorpay:live');
assert.strictEqual(vl.pickRazorpayOption(options, '').id, 'razorpay:live');
assert.strictEqual(vl.pickRazorpayOption(options, 'razorpay:test').id, 'razorpay:test');
assert.strictEqual(vl.pickRazorpayOption([{ id: 'dqr', gateway: 'dqr' }], 'razorpay'), null);

const doctorJs = fs.readFileSync(path.join(__dirname, '../public/js/doctor-videos.js'), 'utf8');
assert.strictEqual(doctorJs.includes('Choose how to pay'), false);
assert.ok(doctorJs.includes('Opening Razorpay'));
assert.ok(doctorJs.includes('initDoctorSubscriptionTab'));
assert.ok(doctorJs.includes('initDoctorTransactionsTab'));
const libraryJs = fs.readFileSync(path.join(__dirname, '../lib/video-library.js'), 'utf8');
assert.strictEqual(libraryJs.includes('? IS NOT NULL AND video_id'), false);
assert.ok(libraryJs.includes('video_id = CAST(? AS INTEGER)'));

const allowed = modules.resolveDoctorAllowedTabs('regular', { 'tab-videos': true, 'tab-dashboard': true }, {}, null);
assert.ok(allowed.has('tab-video-subscription'));
assert.ok(allowed.has('tab-video-devices'));
assert.ok(allowed.has('tab-video-license'));
assert.ok(allowed.has('tab-transactions'));
const off = modules.resolveDoctorAllowedTabs('regular', null, null, {
    'tab-videos': true,
    'tab-video-subscription': false,
    'tab-orders': false
});
assert.strictEqual(off.has('tab-video-subscription'), false);
assert.ok(off.has('tab-video-devices'));
assert.ok(off.has('tab-transactions'));

function run(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params || [], function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}
function get(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function access(db, userId, video) {
    return new Promise((resolve, reject) => {
        vl.resolveAccess(db, userId, video, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

(async () => {
    const db = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => vl.ensureVideoLibrarySchema(db, (err) => (err ? reject(err) : resolve())));
    await run(db, `CREATE TABLE users (id INTEGER PRIMARY KEY, doctor_category TEXT, user_role TEXT, role TEXT, first_name TEXT, last_name TEXT, email TEXT)`);
    await run(db, `CREATE TABLE seminars (id INTEGER PRIMARY KEY, title TEXT, portal_year INTEGER, event_date TEXT)`);
    await run(db, `CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, status TEXT)`);
    await run(db, `CREATE TABLE orders (id INTEGER PRIMARY KEY, registration_id INTEGER, status TEXT, amount REAL)`);
    await run(db, `INSERT INTO users (id, doctor_category, first_name) VALUES (1, 'regular', 'Asha'), (2, 'volunteer', 'Vikram'), (3, 'regular', 'Paid')`);
    await run(db, `INSERT INTO seminars (id, title, portal_year, event_date) VALUES (7, 'National Seminar', 2026, '2026-02-01')`);
    await run(db, `INSERT INTO registrations (id, user_id, seminar_id, status) VALUES (1, 3, 7, 'completed')`);
    const ins = `INSERT INTO video_items (year, seminar_id, title, description, kind, album_id, part_no, price_inr, published, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, 'ready', 0, '2026-01-01', '2026-01-01')`;
    const album = await run(db, ins, [2026, 7, 'Day 1 album', 'album', null, null, 500]);
    const partA = await run(db, ins, [2026, 7, 'Inaugural', 'episode', album.lastID, 1, 0]);
    const partB = await run(db, ins, [2026, 7, 'Session 2', 'episode', album.lastID, 2, 0]);
    const single = await run(db, ins, [2026, 7, 'Guest talk', 'full', null, null, 200]);
    await run(db, `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, created_at) VALUES (1, 2026, ?, 'purchase', 500, '2026-01-02')`, [album.lastID]);

    const partRow = await get(db, `SELECT * FROM video_items WHERE id = ?`, [partA.lastID]);
    const otherPart = await get(db, `SELECT * FROM video_items WHERE id = ?`, [partB.lastID]);
    const singleRow = await get(db, `SELECT * FROM video_items WHERE id = ?`, [single.lastID]);
    const albumRow = await get(db, `SELECT * FROM video_items WHERE id = ?`, [album.lastID]);

    const bought = await access(db, 1, partRow);
    assert.strictEqual(bought.allowed, true, 'album payment unlocks part 1');
    assert.strictEqual((await access(db, 1, otherPart)).allowed, true, 'album payment unlocks part 2');
    assert.strictEqual((await access(db, 1, albumRow)).allowed, true);
    assert.strictEqual((await access(db, 1, singleRow)).allowed, false, 'album payment does not unlock a single video');

    await run(db, `INSERT INTO video_access (user_id, year, video_id, source, amount_inr, created_at) VALUES (1, 2026, ?, 'purchase', 200, '2026-01-03')`, [single.lastID]);
    assert.strictEqual((await access(db, 1, singleRow)).allowed, true);

    const strangerPart = Object.assign({}, partRow);
    await run(db, `INSERT INTO users (id, doctor_category, first_name) VALUES (4, 'regular', 'New')`);
    assert.strictEqual((await access(db, 4, strangerPart)).allowed, false);
    assert.strictEqual((await access(db, 2, partRow)).allowed, true, 'volunteers still watch free');
    assert.strictEqual((await access(db, 3, singleRow)).allowed, true, 'paid registration still watches free');

    const doubled = vl.collapseVideoRows([
        { id: 1, position_sec: 1, title: 'a' },
        { id: 1, position_sec: 4, title: 'a-later' },
        { id: 2, position_sec: 0, title: 'b' }
    ]);
    assert.strictEqual(doubled.length, 2);
    assert.strictEqual(doubled.find((row) => row.id === 1).position_sec, 4);

    await new Promise((resolve, reject) => vl.blockDoctorVideo(db, { userId: 2, year: 2026, videoId: partRow.id, adminId: 1 }, (err) => (err ? reject(err) : resolve())));
    const blockedVolunteer = await access(db, 2, partRow);
    assert.strictEqual(blockedVolunteer.allowed, false, 'turning off beats volunteer access');
    assert.strictEqual(blockedVolunteer.reason, 'blocked');
    await new Promise((resolve, reject) => vl.blockDoctorVideo(db, { userId: 3, year: 2026, videoId: singleRow.id, adminId: 1 }, (err) => (err ? reject(err) : resolve())));
    assert.strictEqual((await access(db, 3, singleRow)).allowed, false, 'turning off beats a paid registration');
    await new Promise((resolve, reject) => vl.enableDoctorVideo(db, { userId: 2, year: 2026, videoId: partRow.id, adminId: 1 }, (err) => (err ? reject(err) : resolve())));
    assert.strictEqual((await access(db, 2, partRow)).allowed, true, 'turning on restores the volunteer');
    await new Promise((resolve, reject) => vl.enableDoctorVideo(db, { userId: 3, year: 2026, videoId: singleRow.id, adminId: 1 }, (err) => (err ? reject(err) : resolve())));
    assert.strictEqual((await access(db, 3, singleRow)).allowed, true, 'turning on restores the paid doctor');

    db.close();
    console.log('video album ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

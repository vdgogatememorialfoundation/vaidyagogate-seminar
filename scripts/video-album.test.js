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
const heldSale = vl.purchaseItem(
    { id: 2, album_id: 1, kind: 'episode', published: 1, status: 'ready', year: 2026, price_inr: 0, title: 'Part 1' },
    { id: 1, kind: 'album', published: 1, status: 'ready', year: 2026, price_inr: 500, title: 'Day 1', price_tbd: 1 }
);
assert.strictEqual(heldSale.priceTbd, true);
assert.strictEqual(vl.priceHeld({ price_tbd: 1 }), true);
assert.strictEqual(vl.priceHeld({ price_tbd: 0 }), false);
assert.strictEqual(vl.priceHeld({ priceTbd: true }), true);
assert.strictEqual(vl.purchaseHoldMessage(heldSale), 'The price will be updated later. You cannot watch this until the office sets a price.');
heldSale.personalPrice = true;
assert.strictEqual(vl.purchaseHoldMessage(heldSale), null);
assert.strictEqual(vl.purchaseHoldMessage({ price_tbd: 0, amount: 500 }), null);
assert.deepStrictEqual(vl.publicAdConfig({ adsEnabled: false, adsenseClient: 'ca-pub-1234567890123', adsenseSlot: '1234567890' }), { enabled: false });
assert.deepStrictEqual(
    vl.publicAdConfig({ adsEnabled: true, adsenseClient: 'ca-pub-1234567890123', adsenseSlot: '1234567890', imaAdTag: 'https://pubads.g.doubleclick.net/gampad/ads?sz=640x480' }),
    { enabled: true, adsenseClient: 'ca-pub-1234567890123', adsenseSlot: '1234567890', imaAdTag: 'https://pubads.g.doubleclick.net/gampad/ads?sz=640x480' }
);
assert.strictEqual(vl.publicAdConfig({ adsEnabled: true, imaAdTag: 'http://pubads.g.doubleclick.net/ads' }).enabled, false);
assert.strictEqual(vl.publicAdConfig({ adsEnabled: true, imaAdTag: 'javascript:alert(1)' }).enabled, false);
assert.strictEqual(vl.cleanAdsenseClient('ca-pub-1234567890123'), 'ca-pub-1234567890123');
assert.strictEqual(vl.cleanAdsenseClient('pub-123'), '');

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
    assert.ok(libraryJs.includes('VIDEO_LIST_COLUMNS'));
    assert.strictEqual(libraryJs.includes('SELECT v.*'), false);
    const transcode = vl.hlsArgs('in.mp4', '/tmp/hls', '/tmp/enc.keyinfo', true);
    assert.ok(transcode.includes('expr:gte(t,n_forced*2)'));
    assert.strictEqual(transcode[transcode.indexOf('-hls_time') + 1], '2');
    const copied = vl.hlsArgs('in.mp4', '/tmp/hls', '/tmp/enc.keyinfo', false);
    assert.ok(copied.includes('copy'));
    assert.ok(!copied.includes('libx264'));
    assert.ok(doctorJs.includes('startFragPrefetch'));
    assert.ok(doctorJs.includes('maxBufferLength: 8'));
    assert.ok(doctorJs.includes('playFailures'));
    assert.strictEqual(libraryJs.includes('h264|hevc'), false);
    assert.strictEqual(vl.browserCopyOk({ video: 'h264', audio: 'aac', pixFmt: 'yuv420p' }), true);
    assert.strictEqual(vl.browserCopyOk({ video: 'h264', audio: '', pixFmt: '' }), true);
    assert.strictEqual(vl.browserCopyOk({ video: 'hevc', audio: 'aac', pixFmt: 'yuv420p' }), false);
    assert.strictEqual(vl.browserCopyOk({ video: 'h264', audio: 'aac', pixFmt: 'yuv420p10le' }), false);
    assert.strictEqual(vl.browserCopyOk({ video: 'h264', audio: 'ac3', pixFmt: 'yuv420p' }), false);

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

function access(db, userId, video, settings) {
    return new Promise((resolve, reject) => {
        vl.resolveAccess(db, userId, video, (err, row) => (err ? reject(err) : resolve(row)), settings);
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

    assert.strictEqual(vl.personalAmount(500, 120), 120);
    assert.strictEqual(vl.personalAmount(500, null), 500);
    assert.strictEqual(vl.personalAmount(500, ''), 500);
    assert.strictEqual(
        vl.grantCoversVideo({ id: 3, album_id: 1, created_at: '2026-07-01' }, { video_id: 1, source: 'purchase', created_at: '2026-01-02' }, 'subscription'),
        false
    );
    assert.strictEqual(
        vl.grantCoversVideo({ id: 2, album_id: 1, created_at: '2026-01-01' }, { video_id: 1, source: 'purchase', created_at: '2026-01-02' }, 'subscription'),
        true
    );
    assert.strictEqual(
        vl.grantCoversVideo({ id: 3, album_id: 1, created_at: '2026-07-01' }, { video_id: 1, source: 'purchase', created_at: '2026-01-02' }, 'fixed'),
        true
    );
    const certified = vl.summarizeRegistrations([{ id: 1, status: 'certificate_issued', paid_rows: 0, scan_rows: 0, cert_rows: 0, seminar_title: 'A' }]);
    assert.strictEqual(certified.attendedCertified, true);
    const absent = vl.summarizeRegistrations([{ id: 2, status: 'expired', paid_rows: 1, scan_rows: 0, cert_rows: 0, seminar_title: 'A' }]);
    assert.strictEqual(absent.paidAbsent, true);
    assert.strictEqual(absent.attendedCertified, false);
    const waiting = vl.summarizeRegistrations([{ id: 3, status: 'checked_in', paid_rows: 1, scan_rows: 0, cert_rows: 0, seminar_title: 'A' }]);
    assert.strictEqual(waiting.paidOther, true);
    assert.strictEqual(waiting.attendedCertified, false);

    await run(db, `INSERT INTO seminars (id, title, portal_year, event_date) VALUES (9, 'Other seminar', 2026, '2026-03-01')`);
    await run(db, `INSERT INTO users (id, doctor_category, first_name) VALUES (5, 'regular', 'Checked'), (6, 'regular', 'Certified'), (7, 'regular', 'Expired'), (8, 'regular', 'Other')`);
    await run(db, `INSERT INTO registrations (id, user_id, seminar_id, status) VALUES (2, 5, 7, 'checked_in'), (3, 6, 7, 'certificate_issued'), (4, 7, 7, 'expired'), (5, 8, 9, 'certificate_issued')`);
    await run(db, `INSERT INTO orders (id, registration_id, status, amount) VALUES (1, 4, 'success', 1000)`);
    const checkedIn = await access(db, 5, singleRow);
    assert.strictEqual(checkedIn.allowed, true, 'paid and checked in watches free without a certificate');
    assert.strictEqual(checkedIn.checks.paidCheckedIn, true);
    assert.strictEqual(checkedIn.reason, 'paid_checked_in');
    const cert = await access(db, 6, singleRow);
    assert.strictEqual(cert.allowed, true, 'certificate issued is the same paid-and-checked-in group');
    assert.strictEqual(cert.reason, 'paid_checked_in');
    assert.strictEqual((await access(db, 5, singleRow, { freeCheckedIn: false })).allowed, false, 'turning off paid-and-checked-in makes that group pay');
    const expired = await access(db, 7, singleRow);
    assert.strictEqual(expired.allowed, true, 'paid ticket that expired still watches free');
    assert.strictEqual(expired.reason, 'paid_absent');
    const otherSeminar = await access(db, 8, singleRow);
    assert.strictEqual(otherSeminar.allowed, false, 'a different seminar in the same year does not unlock this one');
    assert.strictEqual(otherSeminar.checks.registered, false);

    const inherited = await run(db, ins, [2026, null, 'Lecture without its own seminar', 'episode', album.lastID, 4, 0]);
    const inheritedRow = await get(db, `SELECT * FROM video_items WHERE id = ?`, [inherited.lastID]);
    assert.strictEqual((await access(db, 6, inheritedRow)).allowed, true, 'a part uses the album seminar');
    assert.strictEqual((await access(db, 8, inheritedRow)).allowed, false, 'another seminar still does not match the album');

    await run(db, `UPDATE video_items SET price_mode = 'subscription' WHERE id = ?`, [album.lastID]);
    const later = await run(db, ins, [2026, 7, 'Lecture added later', 'episode', album.lastID, 5, 0]);
    await run(db, `UPDATE video_items SET created_at = '2026-07-01' WHERE id = ?`, [later.lastID]);
    const laterRow = await get(db, `SELECT * FROM video_items WHERE id = ?`, [later.lastID]);
    assert.strictEqual((await access(db, 1, partRow)).allowed, true, 'a subscription still covers lectures that already existed');
    assert.strictEqual((await access(db, 1, laterRow)).allowed, false, 'a lecture added after payment needs another payment');

    const opened = await access(db, 4, singleRow, { freeNotRegistered: true });
    assert.strictEqual(opened.allowed, true, 'not registered for this event can be turned on');
    assert.strictEqual(opened.reason, 'not_registered');
    assert.strictEqual((await access(db, 8, singleRow, { freeNotRegistered: true })).allowed, true, 'a different seminar is not registered for this event');
    await run(db, `INSERT INTO users (id, doctor_category, first_name) VALUES (10, 'regular', 'Unpaid')`);
    await run(db, `INSERT INTO registrations (id, user_id, seminar_id, status) VALUES (6, 10, 7, 'pending')`);
    assert.strictEqual((await access(db, 10, singleRow, { freeNotRegistered: true })).allowed, false, 'registered but unpaid still pays');
    await new Promise((resolve, reject) => vl.blockDoctorVideo(db, { userId: 4, year: 2026, videoId: null, adminId: 1 }, (err) => (err ? reject(err) : resolve())));
    assert.strictEqual((await access(db, 4, singleRow, { freeNotRegistered: true })).allowed, false, 'turning off still stops a doctor who is not registered');

    const adminJs = fs.readFileSync(path.join(__dirname, '../public/js/admin-videos.js'), 'utf8');
    assert.ok(adminJs.includes('freeNotRegistered'));
    assert.ok(adminJs.includes('Registered for this event, paid and checked in'));
    assert.ok(adminJs.includes('Not registered for this event'));
    assert.ok(!adminJs.includes('Every signed-in doctor'));
    assert.ok(!adminJs.includes('certificate not issued yet'));
    assert.ok(adminJs.includes('vl-analytics'));
    assert.ok(adminJs.includes('price-overrides'));
    assert.ok(doctorJs.includes("reason === 'public'"));
    assert.ok(doctorJs.includes('paid_checked_in'));
    assert.ok(doctorJs.includes('not registered for this event'));
    assert.ok(doctorJs.includes('personalPrice'));
    assert.ok(doctorJs.includes('Price will be updated later'));
    assert.ok(doctorJs.includes('You are not registered for this seminar, so you cannot watch yet.'));
    assert.ok(adminJs.includes('Price will be updated later'));
    assert.ok(adminJs.includes('vlc-tbd'));
    assert.ok(adminJs.includes('vls-ads'));
    assert.ok(adminJs.includes('Seminar video ads'));
    assert.ok(adminJs.includes('cloudSpaceLine'));
    assert.ok(adminJs.includes('usage.label'));
    const r2 = require('../lib/r2-storage');
    const openSpace = r2.describeCloudSpace({ configured: true, ready: true, usedBytes: 1024 ** 3, objectCount: 3, quotaBytes: 0, freeBytes: null, seminarBytes: 512 * 1024 * 1024 });
    assert.ok(openSpace.includes('Cloudflare R2: 1.00 GB stored'));
    assert.ok(openSpace.includes('3 objects'));
    assert.ok(openSpace.includes('seminar videos 512.0 MB'));
    assert.ok(openSpace.includes('other files 512.0 MB'));
    assert.ok(openSpace.includes('no fixed disk size'));
    const capped = r2.describeCloudSpace({ configured: true, ready: true, usedBytes: 2 * 1024 ** 3, objectCount: 1, quotaBytes: 10 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, seminarBytes: 2 * 1024 ** 3 });
    assert.ok(capped.includes('Cloudflare: 8.00 GB left of 10.00 GB'));
    assert.ok(capped.includes('1 object'));
    assert.ok(!capped.includes('no fixed disk size'));
    assert.ok(!capped.includes('seminar videos'));
    const emptySeminar = r2.describeCloudSpace({ configured: true, ready: true, usedBytes: 1024 ** 3, objectCount: 4, quotaBytes: 0, freeBytes: null, seminarBytes: 0 });
    assert.ok(emptySeminar.includes('seminar videos 0 B'));
    assert.ok(!emptySeminar.includes('other files'));
    assert.strictEqual(r2.describeCloudSpace({ ready: false, error: 'Bucket not reachable' }), 'Cloudflare: Bucket not reachable');
    assert.strictEqual(r2.readQuotaBytes(), 0);
    assert.ok(doctorJs.includes('imasdk.googleapis.com/js/sdkloader/ima3.js'));
    assert.ok(doctorJs.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'));
    assert.ok(doctorJs.includes('insideSeminarVideos'));
    assert.ok(doctorJs.includes('tab-videos'));
    assert.strictEqual(doctorJs.includes('adsbygoogle.js'), true);

    db.close();
    console.log('video album ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

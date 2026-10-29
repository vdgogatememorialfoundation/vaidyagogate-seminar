/**
 * The main website looks up a printed 12-digit certificate id.
 * A valid issued certificate returns the holder and event. Email and phone stay off the response.
 */
const assert = require('assert');
const sqlite3 = require('sqlite3');
const certVerify = require('../lib/certificate-verify');

assert.strictEqual(certVerify.parsePublicCertificateId('4334 9514 6392'), '433495146392');
assert.strictEqual(certVerify.parsePublicCertificateId('433495146392'), '433495146392');
assert.strictEqual(certVerify.parsePublicCertificateId('123'), '');
assert.strictEqual(certVerify.parsePublicCertificateId('43349514639299'), '');

function run(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params || [], function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function lookup(db, id) {
    return new Promise((resolve, reject) => {
        certVerify.lookupCertificateByPublicId(db, id, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

(async () => {
    const db = new sqlite3.Database(':memory:');
    await run(db, `CREATE TABLE users (id INTEGER PRIMARY KEY, user_id_string TEXT, email TEXT, phone TEXT)`);
    await run(db, `CREATE TABLE seminars (id INTEGER PRIMARY KEY, title TEXT, event_date TEXT)`);
    await run(db, `CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, application_no TEXT)`);
    await run(
        db,
        `CREATE TABLE user_certificates (
            id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, registration_id INTEGER,
            display_name TEXT, name_edited TEXT, cert_honorific TEXT, enabled INTEGER,
            certificate_id_string TEXT, dispatched_at TEXT, updated_at TEXT
        )`
    );
    await run(
        db,
        `CREATE TABLE volunteer_certificates (
            id INTEGER PRIMARY KEY, user_id INTEGER, seminar_id INTEGER, registration_id INTEGER,
            display_name TEXT, name_edited TEXT, cert_honorific TEXT, enabled INTEGER,
            certificate_id_string TEXT, dispatched_at TEXT, updated_at TEXT
        )`
    );
    await run(db, `CREATE TABLE seminar_volunteers (seminar_id INTEGER, user_id INTEGER, volunteer_ticket_id_string TEXT)`);
    await run(db, `INSERT INTO users (id, user_id_string, email, phone) VALUES (4, 'PRN2600000001', 'asha@example.com', '9000000000')`);
    await run(db, `INSERT INTO seminars (id, title, event_date) VALUES (9, 'Manas Rog 3', '2026-02-04')`);
    await run(db, `INSERT INTO registrations (id, user_id, seminar_id, application_no) VALUES (15, 4, 9, 'SEM-2026-0015')`);
    await run(
        db,
        `INSERT INTO user_certificates (id, user_id, seminar_id, registration_id, display_name, enabled, certificate_id_string, dispatched_at)
         VALUES (3, 4, 9, 15, 'Dr Asha Gogate', 1, '433495146392', '2026-02-05T10:00:00.000Z')`
    );
    await run(
        db,
        `INSERT INTO user_certificates (id, user_id, seminar_id, registration_id, display_name, enabled, certificate_id_string)
         VALUES (4, 4, 9, 15, 'Hidden Name', 0, '111122223333')`
    );
    await run(
        db,
        `INSERT INTO volunteer_certificates (id, user_id, seminar_id, registration_id, display_name, enabled, certificate_id_string, dispatched_at)
         VALUES (8, 4, 9, 15, 'Volunteer Asha', 1, '998877665544', '2026-02-05T11:00:00.000Z')`
    );

    const valid = await lookup(db, '4334-9514-6392');
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.status, 'valid');
    assert.strictEqual(valid.certificateId, '433495146392');
    assert.strictEqual(valid.kind, 'participant');
    assert.strictEqual(valid.holderName, 'Dr Asha Gogate');
    assert.strictEqual(valid.prn, 'PRN2600000001');
    assert.strictEqual(valid.applicationNo, 'SEM-2026-0015');
    assert.strictEqual(valid.event.title, 'Manas Rog 3');
    assert.strictEqual(valid.event.date, '2026-02-04');
    assert.strictEqual(valid.event.id, 9);
    assert.strictEqual(JSON.stringify(valid).includes('asha@example.com'), false);
    assert.strictEqual(JSON.stringify(valid).includes('9000000000'), false);

    const volunteer = await lookup(db, '998877665544');
    assert.strictEqual(volunteer.valid, true);
    assert.strictEqual(volunteer.kind, 'volunteer');
    assert.strictEqual(volunteer.holderName, 'Volunteer Asha');

    const missing = await lookup(db, '000000000000');
    assert.strictEqual(missing.valid, false);
    assert.strictEqual(missing.status, 'not_found');
    assert.strictEqual(missing.holderName, undefined);

    const inactive = await lookup(db, '111122223333');
    assert.strictEqual(inactive.valid, false);
    assert.strictEqual(inactive.status, 'not_issued');
    assert.strictEqual(inactive.holderName, undefined);

    const bad = await lookup(db, '123');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.status, 'invalid_id');

    db.close();
    console.log('certificate public api ok');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

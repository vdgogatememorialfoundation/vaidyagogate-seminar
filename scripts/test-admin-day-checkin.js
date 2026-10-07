/**
 * Admin day check-in unlocks three certificate outcomes:
 * volunteering and participation for volunteers, participation for delegates.
 */
const assert = require('assert');
const checkin = require('../lib/admin-manual-checkin');

const day1 = { dayId: 1, title: 'Day 1', scanned: true, hasTicket: true };
const day2open = { dayId: 2, title: 'Day 2', scanned: false, hasTicket: true };
const day2in = { dayId: 2, title: 'Day 2', scanned: true, hasTicket: true };

const volunteerDay1 = checkin.certificateOffers('volunteer', [day1, day2open], {});
assert.strictEqual(volunteerDay1.length, 2);
assert.strictEqual(volunteerDay1[0].kind, 'volunteering');
assert.strictEqual(volunteerDay1[0].eligible, false);
assert.strictEqual(volunteerDay1[1].kind, 'volunteer_participation');
assert.strictEqual(volunteerDay1[1].eligible, true);

const volunteerBoth = checkin.certificateOffers('volunteer', [day1, day2in], {
    participationEnabled: true
});
assert.strictEqual(volunteerBoth[0].eligible, true);
assert.strictEqual(volunteerBoth[0].issued, false);
assert.strictEqual(volunteerBoth[1].eligible, true);
assert.strictEqual(volunteerBoth[1].issued, true);

const delegateDay1 = checkin.certificateOffers('delegate', [day1, day2open], {});
assert.strictEqual(delegateDay1.length, 1);
assert.strictEqual(delegateDay1[0].kind, 'delegate_participation');
assert.strictEqual(delegateDay1[0].eligible, true);
assert.ok(!delegateDay1.some((offer) => offer.kind === 'volunteering'));

const delegateNone = checkin.certificateOffers('delegate', [{ dayId: 1, title: 'Day 1', scanned: false }], {});
assert.strictEqual(delegateNone[0].eligible, false);

const oneDayVolunteer = checkin.certificateOffers('volunteer', [{ dayId: 8, title: 'Seminar day', scanned: true }], {});
assert.strictEqual(oneDayVolunteer[0].eligible, true);
assert.strictEqual(oneDayVolunteer[1].eligible, true);

const deduped = checkin.dedupeCandidateRows([
    { registration_id: 4, scan_count: 0, is_scanned: 0, ticket_id: 1 },
    { registration_id: 4, scan_count: 1, is_scanned: 1, ticket_id: 2 },
    { registration_id: 5, scan_count: 0, is_scanned: 0, ticket_id: 3 }
]);
assert.strictEqual(deduped.length, 2);
assert.strictEqual(deduped[0].ticket_id, 2);

assert.strictEqual(checkin.attendanceDaysForCandidate({ ticket_id: 9, is_scanned: 1, scan_count: 1 }, []).length, 1);
assert.strictEqual(checkin.attendanceDaysForCandidate({ ticket_id: 9, is_scanned: 1, scan_count: 1 }, []).scanned, undefined);
assert.strictEqual(checkin.attendanceDaysForCandidate({ ticket_id: 9, is_scanned: 1, scan_count: 1 }, [])[0].scanned, true);
assert.strictEqual(
    checkin.attendanceDaysForCandidate({}, [{ dayId: 1, title: 'Day 1', scanned: false }])[0].title,
    'Day 1'
);

function createDb(opts) {
    const options = opts || {};
    const tickets = {
        10: { scan_count: options.day1Scanned ? 1 : 0 },
        11: { scan_count: options.day2Scanned ? 1 : 0 }
    };
    const calls = { updated: [], synced: [], finalized: [], inserts: [] };
    const db = {
        calls,
        all(sql, params, cb) {
            if (/t\.day_id = \?/i.test(sql)) {
                const dayId = params[0];
                const ticketId = dayId === 1 ? 10 : dayId === 2 ? 11 : null;
                return cb(null, [
                    {
                        registration_id: 7,
                        payment_status: options.unpaid ? null : 'success',
                        ticket_id: ticketId,
                        scan_count: ticketId ? tickets[ticketId].scan_count : 0,
                        cert_scans_required: 1,
                        day_title: dayId === 2 ? 'Day 2' : 'Day 1'
                    }
                ]);
            }
            if (/JOIN seminar_days sd/i.test(sql)) {
                return cb(null, [
                    {
                        registration_id: 7,
                        day_id: 1,
                        title: 'Day 1',
                        day_date: '2026-11-01',
                        sort_order: 0,
                        ticket_id: 10,
                        is_scanned: tickets[10].scan_count > 0 ? 1 : 0,
                        scan_count: tickets[10].scan_count,
                        scan_time: null
                    },
                    {
                        registration_id: 7,
                        day_id: 2,
                        title: 'Day 2',
                        day_date: '2026-11-02',
                        sort_order: 1,
                        ticket_id: 11,
                        is_scanned: tickets[11].scan_count > 0 ? 1 : 0,
                        scan_count: tickets[11].scan_count,
                        scan_time: null
                    }
                ]);
            }
            cb(null, []);
        },
        get(sql, params, cb) {
            if (/volunteer_id/i.test(sql)) {
                return cb(null, {
                    id: 7,
                    application_no: 'APP1',
                    seminar_id: 3,
                    user_id: 5,
                    status: 'e_ticket_issued',
                    first_name: 'A',
                    middle_name: '',
                    last_name: 'B',
                    user_id_string: 'PRN1',
                    volunteer_id: options.delegate ? null : 9,
                    participation_enabled: options.participationEnabled ? 1 : 0,
                    volunteering_enabled: options.volunteeringEnabled ? 1 : 0
                });
            }
            if (/certificate_templates/i.test(sql)) return cb(null, options.noTemplate ? null : { id: 4 });
            if (/FROM user_certificates/i.test(sql) || /FROM volunteer_certificates/i.test(sql)) {
                return cb(null, { id: 8 });
            }
            cb(null, null);
        },
        run(sql, params, cb) {
            if (/UPDATE tickets/i.test(sql)) {
                const ticketId = params[params.length - 1];
                calls.updated.push(ticketId);
                if (tickets[ticketId]) tickets[ticketId].scan_count = params[0];
            }
            if (/INSERT INTO user_certificates/i.test(sql)) calls.inserts.push('participant');
            if (/INSERT INTO volunteer_certificates/i.test(sql)) calls.inserts.push('volunteer');
            const done = typeof cb === 'function' ? cb : () => {};
            done.call({ lastID: 8, changes: 1 }, null);
        }
    };
    return db;
}

function run(fn) {
    return new Promise((resolve, reject) => {
        fn((err, out) => (err ? reject(err) : resolve(out)));
    });
}

async function main() {
    const db = createDb();
    const deps = {
        syncCertificateEligibilityForTicket(ticketId, cb) {
            db.calls.synced.push(ticketId);
            cb(null);
        },
        finalizeParticipantCertificateAfterScan(database, ticketId, d, cb) {
            db.calls.finalized.push(ticketId);
            cb(null);
        },
        portalTracking: { logRegistrationEvent() {} }
    };
    const dayCheck = await run((cb) => checkin.performManualCheckin(db, deps, 7, 2, cb, { dayId: 1 }));
    assert.deepStrictEqual(db.calls.updated, [10]);
    assert.deepStrictEqual(db.calls.synced, []);
    assert.deepStrictEqual(db.calls.finalized, []);
    assert.strictEqual(dayCheck.dayTitle, 'Day 1');
    assert.strictEqual(dayCheck.role, 'volunteer');
    assert.strictEqual(dayCheck.offers[1].eligible, true);
    assert.strictEqual(dayCheck.offers[0].eligible, false);
    assert.ok(/final event day/i.test(dayCheck.eligibilityNote));

    await assert.rejects(
        run((cb) => checkin.performManualCheckin(db, deps, 7, 2, cb, { dayId: 9 })),
        /No e-ticket for this day/
    );

    const legacyDb = createDb();
    legacyDb.get = function (sql, params, cb) {
        if (/FROM registrations r/i.test(sql) && /payment_status/i.test(sql) && !/volunteer_id/i.test(sql)) {
            return cb(null, {
                registration_id: 7,
                ticket_id: 11,
                scan_count: 0,
                cert_scans_required: 1,
                payment_status: 'success'
            });
        }
        return createDb().get(sql, params, cb);
    };
    const legacyDeps = {
        syncCertificateEligibilityForTicket(ticketId, cb) {
            legacyDb.calls.synced.push(ticketId);
            cb(null);
        },
        finalizeParticipantCertificateAfterScan(database, ticketId, d, cb) {
            legacyDb.calls.finalized.push(ticketId);
            cb(null);
        },
        portalTracking: { logRegistrationEvent() {} }
    };
    await run((cb) => checkin.performManualCheckin(legacyDb, legacyDeps, 7, 2, cb));
    assert.deepStrictEqual(legacyDb.calls.synced, [11]);
    assert.deepStrictEqual(legacyDb.calls.finalized, [11]);

    const early = createDb({ day1Scanned: true });
    await assert.rejects(
        run((cb) => checkin.issueAttendanceCertificate(early, {}, 7, 'volunteering', cb)),
        /final event day/
    );
    const participation = await run((cb) =>
        checkin.issueAttendanceCertificate(
            early,
            {
                certVerify: {
                    ensureUserCertVerifyToken(d, id, cb2) {
                        cb2(null, 'tok');
                    }
                }
            },
            7,
            'volunteer_participation',
            cb
        )
    );
    assert.strictEqual(participation.success, true);
    assert.ok(early.calls.inserts.indexOf('participant') >= 0);
    assert.match(participation.message, /No certificate email was sent/);

    const delegateDb = createDb({ delegate: true, day2Scanned: true });
    await assert.rejects(
        run((cb) => checkin.issueAttendanceCertificate(delegateDb, {}, 7, 'volunteering', cb)),
        /does not apply/
    );
    const delegateCert = await run((cb) =>
        checkin.issueAttendanceCertificate(delegateDb, {}, 7, 'delegate_participation', cb)
    );
    assert.strictEqual(delegateCert.success, true);
    assert.ok(delegateDb.calls.inserts.indexOf('participant') >= 0);

    const ready = createDb({ day2Scanned: true });
    const volunteering = await run((cb) =>
        checkin.issueAttendanceCertificate(
            ready,
            { certVerify: { ensureVolunteerCertVerifyToken(d, id, cb2) { cb2(null, 'v'); } } },
            7,
            'volunteering',
            cb
        )
    );
    assert.strictEqual(volunteering.success, true);
    assert.ok(ready.calls.inserts.indexOf('volunteer') >= 0);
    assert.strictEqual(volunteering.templateMissing, false);

    console.log('admin day check-in ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

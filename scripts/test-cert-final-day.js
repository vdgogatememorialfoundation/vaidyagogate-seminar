/**
 * Multi-day seminars issue the certificate on the final day scan only.
 */
const assert = require('assert');
const certVerify = require('../lib/certificate-verify');
const volunteerCertFlow = require('../lib/volunteer-cert-flow');
const portalTracking = require('../lib/portal-tracking');

const paidDay1 = portalTracking.buildSeminarTimeline(
    { status: 'completed', created_at: '2026-10-01' },
    [{ step_key: 'completed', label: 'Payment confirmed', message: 'Payment received successfully.', created_at: '2026-10-01' }],
    {
        hasTicket: true,
        multiDay: true,
        awaitingFinalDay: true,
        certDayScanned: false,
        certDayTitle: 'Day 2 - Final Day Manas Rog 3',
        firstDayTitle: 'Day 1',
        checkedInAt: '2026-10-02'
    }
);
const paidByKey = {};
paidDay1.steps.forEach((step) => {
    paidByKey[step.key] = step;
});
assert.strictEqual(paidByKey.completed.state, 'completed');
assert.strictEqual(paidByKey.checked_in.state, 'completed');
assert.strictEqual(paidByKey.final_day_scan.state, 'active');
assert.ok(/not scanned yet/i.test(paidByKey.final_day_scan.desc));
assert.notStrictEqual(paidByKey.certificate.state, 'active');
assert.ok(String(paidByKey.checked_in.title).indexOf('Day 1') >= 0);

const days = [
    { id: 10, title: 'Day 1', sort_order: 0, day_date: '2026-11-01', is_active: 1 },
    { id: 11, title: 'Day 2', sort_order: 1, day_date: '2026-11-02', is_active: 1 }
];

assert.strictEqual(certVerify.certificateIssuingDay(days).id, 11);
assert.strictEqual(certVerify.scanIssuesCertificate(10, days), false);
assert.strictEqual(certVerify.scanIssuesCertificate(11, days), true);
assert.strictEqual(
    certVerify.scanIssuesCertificate(null, [{ id: 1, title: 'Only day', sort_order: 0, is_active: 1 }]),
    true
);
assert.strictEqual(certVerify.scanIssuesCertificate(null, []), true);

const hidden = certVerify.doctorCertificateViewState({
    cert_scans_required: 1,
    scan_count: 1,
    order_status: 'success',
    cert_enabled: 1,
    scan_verified: 1,
    template_path: '/cert.png',
    seminar_day_count: 2,
    cert_day_title: 'Day 2',
    cert_day_scanned: 0,
    venue_scan_count: 1,
    certificate_verify_enabled: 1,
    certificate_verify_manual: 1,
    event_date: '2099-01-01'
});
assert.strictEqual(hidden.phase, 'awaiting_final_day');
assert.strictEqual(hidden.canViewCertificate, false);

const ready = certVerify.doctorCertificateViewState({
    cert_scans_required: 1,
    scan_count: 1,
    order_status: 'success',
    cert_enabled: 1,
    scan_verified: 1,
    template_path: '/cert.png',
    seminar_day_count: 2,
    cert_day_title: 'Day 2',
    cert_day_scanned: 1,
    venue_scan_count: 2,
    certificate_verify_enabled: 1,
    certificate_verify_manual: 1,
    event_date: '2099-01-01'
});
assert.strictEqual(ready.phase, 'ready');
assert.strictEqual(ready.canViewCertificate, true);

function ticketRow(dayId) {
    return {
        ticket_id: dayId === 10 ? 100 : 101,
        scan_count: 1,
        user_id: 5,
        event_id: 0,
        day_id: dayId,
        registration_id: 7,
        seminar_id: 1,
        application_no: 'APP1',
        reg_status: 'checked_in',
        user_id_string: 'PRN1',
        email: 'a@example.com',
        phone: '999',
        order_status: 'success',
        cert_scans_required: 1,
        seminar_title: 'Manas Rog 3.0',
        certificate_verify_go_live_at: null,
        event_date: '2099-11-02',
        certificate_verify_enabled: 0,
        certificate_verify_manual: 0,
        sub_event_title: null,
        scan_event_title: dayId === 10 ? 'Day 1' : 'Day 2',
        cert_id: null,
        cert_enabled: 0,
        cert_dispatched_at: '',
        form_data: null,
        first_name: 'A',
        middle_name: '',
        last_name: 'B',
        order_id: 3,
        scan_time: '2099-11-01 10:00:00',
        volunteer_row_id: null,
        volunteer_status: null
    };
}

function createDb() {
    const state = { certInserts: 0, cert: null };
    const db = {
        state,
        all(sql, params, cb) {
            if (/FROM seminar_days/i.test(sql)) return cb(null, days);
            cb(null, []);
        },
        get(sql, params, cb) {
            if (/FROM tickets t/i.test(sql)) {
                const id = params[0];
                return cb(null, ticketRow(id === 100 ? 10 : 11));
            }
            if (/FROM certificate_templates/i.test(sql)) return cb(null, null);
            if (/FROM user_certificates/i.test(sql) && /WHERE user_id/i.test(sql)) {
                return cb(null, state.cert ? { id: 1 } : null);
            }
            if (/FROM user_certificates/i.test(sql)) {
                return cb(
                    null,
                    state.cert
                        ? {
                              cert_id: 1,
                              user_id_string: 'PRN1',
                              application_no: 'APP1',
                              cert_dispatched_at: ''
                          }
                        : null
                );
            }
            cb(null, null);
        },
        run(sql, params, cb) {
            const done = typeof cb === 'function' ? cb : () => {};
            if (/INSERT INTO user_certificates/i.test(sql)) {
                state.certInserts += 1;
                state.cert = { scan_verified: 1 };
            }
            done.call({ lastID: 1 }, null);
        }
    };
    return db;
}

function once(db, fn, arg) {
    return new Promise((resolve, reject) => {
        fn(db, arg, (err, out) => (err ? reject(err) : resolve(out)));
    });
}

async function main() {
    const db = createDb();
    const gate = await new Promise((resolve, reject) => {
        certVerify.scanMayIssueCertificate(db, 1, 10, (err, out) => (err ? reject(err) : resolve(out)));
    });
    assert.strictEqual(gate.issuesCertificate, false);
    assert.strictEqual(gate.certDayTitle, 'Day 2');

    const sync1 = await new Promise((resolve, reject) => {
        volunteerCertFlow.syncDualCertEligibilityFromTicketScan(db, certVerify, 100, (err, out) =>
            err ? reject(err) : resolve(out)
        );
    });
    assert.strictEqual(sync1.reason, 'awaiting_final_day');
    assert.strictEqual(db.state.certInserts, 0);

    const fin1 = await once(db, (d, id, cb) => certVerify.finalizeParticipantCertificateAfterScan(d, id, {}, cb), 100);
    assert.strictEqual(fin1.reason, 'awaiting_final_day');
    assert.strictEqual(db.state.certInserts, 0);

    await new Promise((resolve, reject) => {
        volunteerCertFlow.syncDualCertEligibilityFromTicketScan(db, certVerify, 101, (err) =>
            err ? reject(err) : resolve()
        );
    });
    assert.strictEqual(db.state.certInserts, 1);
    assert.strictEqual(db.state.cert.scan_verified, 1);

    const fin2 = await once(db, (d, id, cb) => certVerify.finalizeParticipantCertificateAfterScan(d, id, {}, cb), 101);
    assert.notStrictEqual(fin2 && fin2.reason, 'awaiting_final_day');
    assert.ok(fin2 && (fin2.scheduledRelease || fin2.issued || fin2.certId));

    console.log('cert final-day checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

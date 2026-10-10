/**
 * Admin manual venue check-in (without scanner QR), scoped to one seminar day.
 * Attendance decides which certificate can be enabled:
 * volunteering and participation for an approved volunteer, participation for a delegate.
 * Enabling a certificate here does not send certificate email.
 */
const seminarDt = require('./seminar-datetime');
const dayScans = require('./registration-day-scans');

const ISSUE_KINDS = {
    volunteering: {
        table: 'volunteer_certificates',
        templateType: 'volunteer',
        label: 'Volunteering certificate'
    },
    volunteer_participation: {
        table: 'user_certificates',
        templateType: 'participant',
        label: 'Participation certificate'
    },
    delegate_participation: {
        table: 'user_certificates',
        templateType: 'participant',
        label: 'Participation certificate'
    }
};

function certificateOffers(role, days, flags) {
    const list = Array.isArray(days) ? days : [];
    const any = list.some((d) => d && d.scanned);
    const multi = list.length >= 2;
    const last = multi ? list[list.length - 1] : null;
    const finalScanned = multi ? !!(last && last.scanned) : any;
    const participationIssued = !!(flags && (flags.participationEnabled === 1 || flags.participationEnabled === true));
    const volunteeringIssued = !!(flags && (flags.volunteeringEnabled === 1 || flags.volunteeringEnabled === true));
    if (role === 'volunteer') {
        return [
            {
                kind: 'volunteering',
                label: 'Volunteering certificate',
                audience: 'volunteer',
                eligible: finalScanned,
                issued: volunteeringIssued,
                reason: finalScanned
                    ? ''
                    : multi
                      ? 'Check in the final event day before issuing the volunteering certificate.'
                      : 'Check in the event day before issuing the volunteering certificate.'
            },
            {
                kind: 'volunteer_participation',
                label: 'Participation certificate',
                audience: 'volunteer',
                eligible: any,
                issued: participationIssued,
                reason: any ? '' : 'Check in at least one event day before issuing the participation certificate.'
            }
        ];
    }
    return [
        {
            kind: 'delegate_participation',
            label: 'Participation certificate',
            audience: 'delegate',
            eligible: any,
            issued: participationIssued,
            reason: any ? '' : 'Check in at least one event day before issuing the participation certificate.'
        }
    ];
}

function eligibilityNote(offers) {
    const ready = (offers || []).filter((o) => o && o.eligible).map((o) => o.label);
    const waiting = (offers || []).map((o) => (o && !o.eligible ? o.reason : '')).filter(Boolean);
    const parts = [];
    if (ready.length) parts.push('Can issue: ' + ready.join('; ') + '.');
    if (waiting.length) parts.push(waiting[0]);
    return parts.join(' ');
}

function dedupeCandidateRows(rows) {
    const by = new Map();
    (rows || []).forEach((row) => {
        if (!row) return;
        const key = String(row.registration_id);
        const prev = by.get(key);
        if (!prev) {
            by.set(key, row);
            return;
        }
        const score = (item) => (Number(item.scan_count) || 0) + (Number(item.is_scanned) ? 10 : 0);
        if (score(row) > score(prev)) by.set(key, row);
    });
    return Array.from(by.values());
}

/** Days already loaded for this registration, or one synthetic event day from the candidate row. */
function attendanceDaysForCandidate(row, scannedDays) {
    if (Array.isArray(scannedDays) && scannedDays.length) return scannedDays;
    const scanned = Number(row && row.is_scanned) === 1 || Number(row && row.scan_count) > 0;
    return [
        {
            dayId: null,
            title: 'Event day',
            dayDate: '',
            hasTicket: !!(row && row.ticket_id),
            scanned,
            scanCount: Number(row && row.scan_count) || 0,
            scanTime: (row && row.scan_time) || null
        }
    ];
}

function personName(row) {
    return [row && row.first_name, row && row.middle_name, row && row.last_name]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' ');
}

function collapseTicketRows(rows) {
    const days = new Map();
    (rows || []).forEach((row) => {
        const dayId = row.day_id == null || row.day_id === '' ? null : Number(row.day_id);
        const key = dayId == null ? 'event' : String(dayId);
        let day = days.get(key);
        if (!day) {
            day = {
                dayId,
                title: row.title || (dayId == null ? 'Event day' : 'Day'),
                dayDate: row.day_date ? String(row.day_date).slice(0, 10) : '',
                sortOrder: Number(row.sort_order) || 0,
                hasTicket: false,
                scanned: false,
                scanCount: 0,
                scanTime: null,
                ticketId: null
            };
            days.set(key, day);
        }
        if (row.ticket_id != null) {
            day.hasTicket = true;
            if (day.ticketId == null) day.ticketId = Number(row.ticket_id);
            const count = Number(row.scan_count) || 0;
            const scanned = row.is_scanned === true || row.is_scanned === 1 || row.is_scanned === '1' || count > 0;
            if (scanned) {
                day.scanned = true;
                day.scanCount = Math.max(day.scanCount, count || 1);
                if (!day.scanTime && row.scan_time) day.scanTime = row.scan_time;
            }
        }
    });
    return Array.from(days.values())
        .sort((a, b) => a.sortOrder - b.sortOrder || String(a.dayDate).localeCompare(String(b.dayDate)) || (a.dayId || 0) - (b.dayId || 0))
        .map((day) => ({
            dayId: day.dayId,
            title: day.title,
            dayDate: day.dayDate,
            hasTicket: day.hasTicket,
            scanned: day.scanned,
            scanCount: day.scanCount,
            scanTime: day.scanTime,
            ticketId: day.ticketId
        }));
}

function listCheckinState(db, registrationId, cb) {
    const rid = parseInt(registrationId, 10);
    if (!Number.isInteger(rid) || rid < 1) return cb(new Error('Invalid registration id'));
    db.get(
        `SELECT r.id, r.application_no, r.seminar_id, r.user_id, r.status,
                u.first_name, u.middle_name, u.last_name, u.user_id_string,
                sv.id AS volunteer_id,
                IFNULL(uc.enabled, 0) AS participation_enabled,
                IFNULL(vc.enabled, 0) AS volunteering_enabled
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN seminar_volunteers sv
           ON sv.user_id = r.user_id AND sv.seminar_id = r.seminar_id AND sv.status = 'approved'
         LEFT JOIN user_certificates uc ON uc.user_id = r.user_id AND uc.seminar_id = r.seminar_id
         LEFT JOIN volunteer_certificates vc ON vc.user_id = r.user_id AND vc.seminar_id = r.seminar_id
         WHERE r.id = ?`,
        [rid],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(new Error('Registration not found'));
            const role = row.volunteer_id ? 'volunteer' : 'delegate';
            const publish = (days) => {
                const offers = certificateOffers(role, days, {
                    participationEnabled: Number(row.participation_enabled) === 1,
                    volunteeringEnabled: Number(row.volunteering_enabled) === 1
                });
                cb(null, {
                    registrationId: rid,
                    applicationNo: row.application_no || '',
                    seminarId: row.seminar_id,
                    userId: row.user_id,
                    prn: row.user_id_string || '',
                    name: personName(row),
                    role,
                    days,
                    offers
                });
            };
            dayScans.loadDayScans(db, [rid], (dayErr, map) => {
                if (dayErr) return cb(dayErr);
                const loaded = (map && map.get(rid)) || [];
                if (loaded.length) return publish(loaded);
                db.all(
                    `SELECT t.id AS ticket_id, t.day_id, t.is_scanned, t.scan_count, t.scan_time,
                            sd.title, sd.day_date, sd.sort_order
                     FROM tickets t
                     JOIN orders o ON o.id = t.order_id AND lower(trim(o.status)) = 'success'
                     LEFT JOIN seminar_days sd ON sd.id = t.day_id
                     WHERE o.registration_id = ?
                     ORDER BY sd.sort_order ASC, sd.day_date ASC, t.id ASC`,
                    [rid],
                    (ticketErr, ticketRows) => {
                        if (ticketErr) {
                            if (/no such table|does not exist|no such column/i.test(String(ticketErr.message || ''))) {
                                return publish(attendanceDaysForCandidate({ ticket_id: null, is_scanned: 0, scan_count: 0 }, []));
                            }
                            return cb(ticketErr);
                        }
                        const collapsed = collapseTicketRows(ticketRows);
                        publish(
                            collapsed.length
                                ? collapsed
                                : attendanceDaysForCandidate({ ticket_id: null, is_scanned: 0, scan_count: 0 }, [])
                        );
                    }
                );
            });
        }
    );
}

function withEligibility(db, rid, payload, cb) {
    listCheckinState(db, rid, (err, state) => {
        if (err || !state) return cb(null, payload);
        payload.role = state.role;
        payload.days = state.days;
        payload.offers = state.offers;
        payload.eligibilityNote = eligibilityNote(state.offers);
        cb(null, payload);
    });
}

function performManualCheckin(db, deps, registrationId, staffId, cb, opts) {
    const rid = parseInt(registrationId, 10);
    const sid = parseInt(staffId, 10);
    const dayRaw = opts && opts.dayId != null && opts.dayId !== '' ? parseInt(opts.dayId, 10) : null;
    const dayId = Number.isInteger(dayRaw) && dayRaw > 0 ? dayRaw : null;
    if (!Number.isInteger(rid) || rid < 1) return cb(new Error('Invalid registration id'));

    const scanAt = seminarDt.scanTimeNowForStorage ? seminarDt.scanTimeNowForStorage() : new Date().toISOString();
    const staff = Number.isInteger(sid) && sid > 0 ? sid : null;

    function markAndFinish(tickets, dayTitle, syncCerts) {
        const scansRequired = Math.max(1, parseInt(tickets[0].cert_scans_required, 10) || 1);
        let index = 0;
        const step = () => {
            if (index >= tickets.length) return afterMarks();
            const row = tickets[index++];
            const newScanCount = Math.max(scansRequired, Number(row.scan_count) || 0);
            row.scan_count = newScanCount;
            db.run(
                `UPDATE tickets SET scan_count = ?, is_scanned = 1, scan_time = ?, scanned_by = ? WHERE id = ?`,
                [newScanCount, scanAt, staff, row.ticket_id],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    step();
                }
            );
        };
        const afterMarks = () => {
            const primary = tickets[0];
            const finish = () => {
                db.run(
                    `UPDATE registrations SET status = 'checked_in'
                     WHERE id = ? AND status NOT IN ('rejected', 'cancelled')`,
                    [rid],
                    () => {
                        if (deps && deps.portalTracking) {
                            deps.portalTracking.logRegistrationEvent(
                                db,
                                rid,
                                'checked_in',
                                dayTitle ? 'Checked in (admin manual) — ' + dayTitle : 'Checked in (admin manual)',
                                'Marked checked in by admin without scanner',
                                () => {}
                            );
                        }
                        withEligibility(
                            db,
                            rid,
                            {
                                success: true,
                                ticketId: primary.ticket_id,
                                ticketIds: tickets.map((row) => row.ticket_id),
                                scanCount: primary.scan_count,
                                scansRequired,
                                dayId,
                                dayTitle: dayTitle || null
                            },
                            cb
                        );
                    }
                );
            };
            if (!syncCerts) return finish();
            const sync = deps && deps.syncCertificateEligibilityForTicket;
            const afterSync = () => {
                if (!deps || typeof deps.finalizeParticipantCertificateAfterScan !== 'function') return finish();
                deps.finalizeParticipantCertificateAfterScan(db, primary.ticket_id, deps, () => finish());
            };
            if (typeof sync === 'function') sync(primary.ticket_id, afterSync);
            else afterSync();
        };
        step();
    }

    if (dayId) {
        return db.all(
            `SELECT r.id AS registration_id, r.user_id, r.seminar_id, r.status,
                    t.id AS ticket_id, IFNULL(t.scan_count, 0) AS scan_count, t.day_id,
                    IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
                    o.status AS payment_status,
                    sd.title AS day_title
             FROM registrations r
             JOIN seminars s ON s.id = r.seminar_id
             LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
             LEFT JOIN tickets t ON t.order_id = o.id AND t.day_id = ?
             LEFT JOIN seminar_days sd ON sd.id = ?
             WHERE r.id = ?`,
            [dayId, dayId, rid],
            (err, rows) => {
                if (err) return cb(err);
                if (!rows || !rows.length) return cb(new Error('Registration not found'));
                const paid = rows.filter((row) => String(row.payment_status || '').toLowerCase() === 'success');
                if (!paid.length) return cb(new Error('Payment must be confirmed before manual check-in.'));
                const seen = new Set();
                const tickets = [];
                paid.forEach((row) => {
                    if (!row.ticket_id || seen.has(row.ticket_id)) return;
                    seen.add(row.ticket_id);
                    tickets.push(row);
                });
                if (!tickets.length) {
                    return cb(new Error('No e-ticket for this day. Generate the day ticket first.'));
                }
                markAndFinish(tickets, tickets[0].day_title || null, false);
            }
        );
    }

    db.get(
        `SELECT r.id AS registration_id, r.user_id, r.seminar_id, r.status,
                t.id AS ticket_id, IFNULL(t.scan_count, 0) AS scan_count, t.day_id,
                IFNULL(s.cert_scans_required, 1) AS cert_scans_required,
                o.status AS payment_status
         FROM registrations r
         JOIN seminars s ON s.id = r.seminar_id
         LEFT JOIN orders o ON o.registration_id = r.id AND lower(trim(o.status)) = 'success'
         LEFT JOIN tickets t ON t.order_id = o.id
         WHERE r.id = ?
         ORDER BY CASE
             WHEN t.day_id = (
                 SELECT sd.id FROM seminar_days sd
                 WHERE sd.seminar_id = r.seminar_id AND IFNULL(sd.is_active, 1) = 1
                 ORDER BY sd.sort_order DESC, sd.day_date DESC, sd.id DESC LIMIT 1
             ) THEN 0 ELSE 1 END,
             t.id DESC
         LIMIT 1`,
        [rid],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(new Error('Registration not found'));
            if (String(row.payment_status || '').toLowerCase() !== 'success') {
                return cb(new Error('Payment must be confirmed before manual check-in.'));
            }
            if (!row.ticket_id) return cb(new Error('No e-ticket found for this registration. Issue ticket first.'));
            markAndFinish([row], null, true);
        }
    );
}

function issueAttendanceCertificate(db, deps, registrationId, kind, cb) {
    const spec = ISSUE_KINDS[String(kind || '')];
    if (!spec) return cb(new Error('Unknown certificate type.'));
    listCheckinState(db, registrationId, (err, state) => {
        if (err) return cb(err);
        const offer = (state.offers || []).find((item) => item.kind === kind);
        if (!offer) return cb(new Error('That certificate does not apply to this person.'));
        if (!offer.eligible) return cb(new Error(offer.reason || 'Check in the required day first.'));
        if (offer.issued) {
            return cb(null, {
                success: true,
                alreadyIssued: true,
                message: spec.label + ' is already enabled.',
                offers: state.offers,
                role: state.role,
                days: state.days
            });
        }
        const scanned = (state.days || []).filter((day) => day && day.scanned && day.ticketId);
        const ticketId = scanned.length ? scanned[scanned.length - 1].ticketId : null;
        const displayName = state.name || (state.role === 'volunteer' ? 'Volunteer' : 'Participant');
        db.get(
            `SELECT id FROM certificate_templates
             WHERE seminar_id = ? AND is_active = 1 AND IFNULL(cert_type, 'participant') = ?
             ORDER BY id DESC LIMIT 1`,
            [state.seminarId, spec.templateType],
            (tplErr, tpl) => {
                if (tplErr) return cb(tplErr);
                const templateId = tpl && tpl.id ? tpl.id : null;
                const afterWrite = (writeErr) => {
                    if (writeErr) return cb(writeErr);
                    const tokenFn =
                        spec.table === 'volunteer_certificates'
                            ? deps && deps.certVerify && deps.certVerify.ensureVolunteerCertVerifyToken
                            : deps && deps.certVerify && deps.certVerify.ensureUserCertVerifyToken;
                    const loadId = (next) => {
                        db.get(
                            `SELECT id FROM ${spec.table} WHERE user_id = ? AND seminar_id = ?`,
                            [state.userId, state.seminarId],
                            (idErr, certRow) => {
                                if (idErr) return cb(idErr);
                                if (!certRow || !certRow.id || typeof tokenFn !== 'function') return next();
                                tokenFn(db, certRow.id, () => next());
                            }
                        );
                    };
                    const markStatus = (next) => {
                        if (spec.table !== 'user_certificates') return next();
                        db.run(
                            `UPDATE registrations SET status = 'certificate_issued'
                             WHERE id = ? AND COALESCE(status, '') NOT IN ('rejected', 'cancelled')`,
                            [state.registrationId],
                            () => next()
                        );
                    };
                    loadId(() => {
                        markStatus(() => {
                            listCheckinState(db, state.registrationId, (reloadErr, fresh) => {
                                const note = templateId
                                    ? spec.label + ' enabled. No certificate email was sent.'
                                    : spec.label + ' enabled. Apply the VGMF design before it can be opened. No certificate email was sent.';
                                cb(null, {
                                    success: true,
                                    alreadyIssued: false,
                                    templateMissing: !templateId,
                                    message: note,
                                    offers: fresh && fresh.offers ? fresh.offers : state.offers,
                                    role: state.role,
                                    days: fresh && fresh.days ? fresh.days : state.days
                                });
                            });
                        });
                    });
                };
                if (spec.table === 'volunteer_certificates') {
                    return db.run(
                        `INSERT INTO volunteer_certificates (user_id, seminar_id, registration_id, display_name, template_id, enabled, scan_verified, updated_at)
                         VALUES (?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP)
                         ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                           enabled = 1,
                           scan_verified = 1,
                           registration_id = COALESCE(excluded.registration_id, volunteer_certificates.registration_id),
                           display_name = CASE WHEN IFNULL(volunteer_certificates.name_edited, 0) = 1 THEN volunteer_certificates.display_name ELSE COALESCE(excluded.display_name, volunteer_certificates.display_name) END,
                           template_id = COALESCE(excluded.template_id, volunteer_certificates.template_id),
                           updated_at = CURRENT_TIMESTAMP`,
                        [state.userId, state.seminarId, state.registrationId, displayName, templateId],
                        afterWrite
                    );
                }
                db.run(
                    `INSERT INTO user_certificates (user_id, seminar_id, ticket_id, registration_id, display_name, template_id, enabled, scan_verified, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id, seminar_id) DO UPDATE SET
                       enabled = 1,
                       scan_verified = 1,
                       ticket_id = COALESCE(excluded.ticket_id, user_certificates.ticket_id),
                       registration_id = COALESCE(excluded.registration_id, user_certificates.registration_id),
                       display_name = CASE WHEN IFNULL(user_certificates.name_edited, 0) = 1 THEN user_certificates.display_name ELSE COALESCE(excluded.display_name, user_certificates.display_name) END,
                       template_id = COALESCE(excluded.template_id, user_certificates.template_id),
                       updated_at = CURRENT_TIMESTAMP`,
                    [state.userId, state.seminarId, ticketId, state.registrationId, displayName, templateId],
                    afterWrite
                );
            }
        );
    });
}

module.exports = {
    performManualCheckin,
    listCheckinState,
    issueAttendanceCertificate,
    certificateOffers,
    eligibilityNote,
    dedupeCandidateRows,
    attendanceDaysForCandidate
};

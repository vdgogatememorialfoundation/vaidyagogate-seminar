/**
 * Portal year (2026 / 2027) and per-application status timelines.
 */
const PORTAL_YEAR_KEY = 'portal_year';

const SEMINAR_TRACK_STEPS = [
    { key: 'submitted', title: 'Application submitted', icon: 'fa-clipboard-list' },
    { key: 'pending_approval', title: 'Under admin review', icon: 'fa-user-shield' },
    { key: 'revision_required', title: 'Re-upload documents', icon: 'fa-file-circle-exclamation' },
    { key: 'approved_pending_payment', title: 'Approved — payment due', icon: 'fa-user-check' },
    { key: 'completed', title: 'Payment confirmed', icon: 'fa-rupee-sign' },
    { key: 'ticket', title: 'E-ticket issued', icon: 'fa-qrcode' },
    { key: 'checked_in', title: 'Checked in at venue', icon: 'fa-building-user' },
    { key: 'certificate', title: 'E-certificate', icon: 'fa-certificate' }
];

const CASE_TRACK_STEPS = [
    { key: 'submitted', title: 'Application submitted', icon: 'fa-file-upload' },
    { key: 'under_review', title: 'Admin file review', icon: 'fa-user-shield' },
    { key: 'approved_for_judging', title: 'Approved for judging', icon: 'fa-check-circle' },
    { key: 'judging', title: 'Judges assigned & scoring', icon: 'fa-gavel' },
    { key: 'scoring', title: 'Scores submitted', icon: 'fa-star-half-alt' },
    { key: 'selected', title: 'Final result', icon: 'fa-trophy' }
];

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[portal-tracking]', e.message);
    }
}

function ensurePortalTrackingSchema(db, ignoreMigrationErr, next) {
    const ie = ignoreMigrationErr || ignoreErr;
    const alters = [
        `ALTER TABLE seminars ADD COLUMN portal_year INTEGER`,
        `ALTER TABLE case_programs ADD COLUMN portal_year INTEGER`
    ];
    let i = 0;
    const runAlter = () => {
        if (i >= alters.length) return createTables();
        db.run(alters[i], (e) => {
            ie(e);
            i++;
            runAlter();
        });
    };
    const createTables = () => {
        db.run(
            `CREATE TABLE IF NOT EXISTS registration_status_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                registration_id INTEGER NOT NULL,
                step_key TEXT NOT NULL,
                label TEXT,
                message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            (e1) => {
                ie(e1);
                db.run(
                    `CREATE TABLE IF NOT EXISTS case_status_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        submission_id INTEGER NOT NULL,
                        step_key TEXT NOT NULL,
                        label TEXT,
                        message TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`,
                    (e2) => {
                        ie(e2);
                        db.run(
                            `CREATE INDEX IF NOT EXISTS idx_reg_status_log_reg ON registration_status_log(registration_id, created_at)`,
                            (e3) => {
                                ie(e3);
                                db.run(
                                    `CREATE INDEX IF NOT EXISTS idx_case_status_log_sub ON case_status_log(submission_id, created_at)`,
                                    (e4) => {
                                        ie(e4);
                                        backfillPortalYears(db, () => {
                                            db.run(
                                                `INSERT INTO registration_status_log (registration_id, step_key, label, message, created_at)
                                                 SELECT r.id, 'submitted', 'Application submitted', 'Registration received.', r.created_at
                                                 FROM registrations r
                                                 WHERE NOT EXISTS (
                                                    SELECT 1 FROM registration_status_log l WHERE l.registration_id = r.id AND l.step_key = 'submitted'
                                                 )`,
                                                (eB) => {
                                                    ignoreErr(eB);
                                                    db.run(
                                                        `INSERT INTO case_status_log (submission_id, step_key, label, message, created_at)
                                                         SELECT cs.id, 'submitted', 'Application submitted', 'Case files uploaded.', cs.created_at
                                                         FROM case_submissions cs
                                                         WHERE NOT EXISTS (
                                                            SELECT 1 FROM case_status_log l WHERE l.submission_id = cs.id AND l.step_key = 'submitted'
                                                         )`,
                                                        (eB2) => {
                                                            ignoreErr(eB2);
                                                            if (next) next();
                                                        }
                                                    );
                                                }
                                            );
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    };
    runAlter();
}

function backfillPortalYears(db, next) {
    db.run(
        `UPDATE seminars SET portal_year = CAST(strftime('%Y', COALESCE(event_date, created_at, 'now')) AS INTEGER)
         WHERE portal_year IS NULL OR portal_year = 0`,
        (e1) => {
            ignoreErr(e1);
            db.run(
                `UPDATE case_programs SET portal_year = (
                    SELECT s.portal_year FROM seminars s WHERE s.id = case_programs.seminar_id
                 ) WHERE (portal_year IS NULL OR portal_year = 0) AND seminar_id IS NOT NULL`,
                (e2) => {
                    ignoreErr(e2);
                    db.run(
                        `UPDATE case_programs SET portal_year = CAST(strftime('%Y', 'now') AS INTEGER)
                         WHERE portal_year IS NULL OR portal_year = 0`,
                        (e3) => {
                            ignoreErr(e3);
                            if (next) next();
                        }
                    );
                }
            );
        }
    );
}

function currentIstYear() {
    try {
        const parts = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric'
        }).formatToParts(new Date());
        const y = parseInt(parts.find((p) => p.type === 'year').value, 10);
        return Number.isInteger(y) ? y : new Date().getFullYear();
    } catch (_) {
        return new Date().getFullYear();
    }
}

function parsePortalYearValue(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    const s = String(raw).trim();
    try {
        const parsed = JSON.parse(s);
        if (typeof parsed === 'number' && Number.isInteger(parsed)) return parsed;
        const n = parseInt(parsed, 10);
        return Number.isInteger(n) ? n : null;
    } catch (_) {
        const n = parseInt(s, 10);
        return Number.isInteger(n) ? n : null;
    }
}

/** SQL fragment + two bind params for "current portal year" seminar lists. */
function seminarPortalYearMatchSql() {
    return `(
        portal_year = ?
        OR portal_year IS NULL
        OR CAST(strftime('%Y', COALESCE(event_date, created_at)) AS INTEGER) = ?
    )`;
}

function inferPortalYearFromSeminars(db, cb) {
    db.get(
        `SELECT MAX(portal_year) AS max_year FROM seminars WHERE is_active = 1 AND portal_year IS NOT NULL AND portal_year > 0`,
        [],
        (e, row) => {
            if (e) return cb(e, null);
            const n = row && row.max_year != null ? parseInt(row.max_year, 10) : null;
            cb(null, Number.isInteger(n) ? n : null);
        }
    );
}

function getPortalYear(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [PORTAL_YEAR_KEY], (e, row) => {
        if (e) return cb(e, currentIstYear());
        const stored = parsePortalYearValue(row && row.value);
        if (stored) return cb(null, stored);
        inferPortalYearFromSeminars(db, (e2, fromSeminars) => {
            if (e2) return cb(e2, currentIstYear());
            cb(null, fromSeminars || currentIstYear());
        });
    });
}

function alignSeminarsToPortalYear(db, newYear, previousYear, alignAllActive, cb) {
    const y = parseInt(newYear, 10);
    if (!Number.isInteger(y)) return cb && cb(new Error('Invalid portal year'));
    let sql;
    let params;
    if (alignAllActive) {
        sql = `UPDATE seminars SET portal_year = ? WHERE is_active = 1`;
        params = [y];
    } else {
        sql = `UPDATE seminars SET portal_year = ? WHERE portal_year IS NULL OR portal_year = 0`;
        params = [y];
        if (Number.isInteger(previousYear) && previousYear > 0) {
            sql += ` OR portal_year = ?`;
            params.push(previousYear);
        }
    }
    db.run(sql, params, (err) => cb && cb(err));
}

function setPortalYear(db, upsertGlobalSetting, year, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    const y = parseInt(year, 10);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        return cb(new Error('Invalid portal year'));
    }
    const alignAllActive = options && options.alignAllActive !== false;
    getPortalYear(db, (ePrev, previousYear) => {
        if (ePrev) return cb(ePrev);
        upsertGlobalSetting(PORTAL_YEAR_KEY, String(y), (eUp) => {
            if (eUp) return cb(eUp);
            alignSeminarsToPortalYear(db, y, previousYear, alignAllActive, cb);
        });
    });
}

function logRegistrationEvent(db, registrationId, stepKey, label, message, cb) {
    if (!registrationId || !stepKey) {
        if (cb) cb();
        return;
    }
    db.run(
        `INSERT INTO registration_status_log (registration_id, step_key, label, message) VALUES (?, ?, ?, ?)`,
        [registrationId, stepKey, label || null, message || null],
        (e) => {
            if (e && /relation .* does not exist/i.test(String(e.message))) {
                if (cb) return cb(null);
            }
            if (cb) cb(e);
        }
    );
}

function logCaseEvent(db, submissionId, stepKey, label, message, cb) {
    if (!submissionId || !stepKey) {
        if (cb) cb();
        return;
    }
    db.run(
        `INSERT INTO case_status_log (submission_id, step_key, label, message) VALUES (?, ?, ?, ?)`,
        [submissionId, stepKey, label || null, message || null],
        (e) => {
            if (cb) cb(e);
        }
    );
}

function fetchRegistrationLogs(db, registrationId, cb) {
    db.all(
        `SELECT step_key, label, message, created_at FROM registration_status_log
         WHERE registration_id = ? ORDER BY created_at ASC`,
        [registrationId],
        (e, rows) => {
            if (e && /does not exist|relation/i.test(String(e.message))) return cb(null, []);
            cb(e, rows);
        }
    );
}

function fetchCaseLogs(db, submissionId, cb) {
    db.all(
        `SELECT step_key, label, message, created_at FROM case_status_log
         WHERE submission_id = ? ORDER BY created_at ASC`,
        [submissionId],
        (e, rows) => {
            if (e && /does not exist|relation/i.test(String(e.message))) return cb(null, []);
            cb(e, rows);
        }
    );
}

const SEMINAR_STATUS_RANK = {
    submitted: 1,
    pending_approval: 2,
    revision_required: 2,
    approved_pending_payment: 3,
    completed: 4,
    e_ticket_issued: 5,
    checked_in: 6,
    certificate_issued: 7,
    rejected: 0,
    cancelled: 0
};

const SEMINAR_STEP_RANK = {
    submitted: 1,
    pending_approval: 2,
    revision_required: 2,
    approved_pending_payment: 3,
    completed: 4,
    ticket: 5,
    checked_in: 6,
    certificate: 7
};

function seminarStatusRank(status) {
    return SEMINAR_STATUS_RANK[String(status || '').toLowerCase()] || 0;
}

function buildSeminarTimeline(registration, logs, extra) {
    const status = String((registration && registration.status) || 'submitted').toLowerCase();
    const rank = seminarStatusRank(status);
    const logByKey = {};
    (logs || []).forEach((l) => {
        if (!logByKey[l.step_key]) logByKey[l.step_key] = l;
    });
    const submittedAt = (logByKey.submitted && logByKey.submitted.created_at) || registration.created_at;
    const hasTicket = !!(extra && extra.hasTicket);

    const steps = SEMINAR_TRACK_STEPS.map((def) => {
        let state = 'pending';
        let at = null;
        let desc = '';
        const stepRank = SEMINAR_STEP_RANK[def.key] || 0;
        const log = logByKey[def.key];

        if (def.key === 'submitted') {
            if (submittedAt) {
                state = 'completed';
                at = submittedAt;
                desc = 'Your registration was received.';
            }
        } else if (def.key === 'pending_approval') {
            desc = (log && log.message) || 'Admin is verifying your application.';
            if (rank >= 3) {
                state = 'completed';
                at = (log && log.created_at) || logByKey.approved_pending_payment?.created_at || null;
            } else if (rank === 2 || status === 'submitted') {
                state = status === 'revision_required' ? 'completed' : 'active';
                if (log) {
                    state = 'completed';
                    at = log.created_at;
                }
            }
        } else if (def.key === 'revision_required') {
            desc = (log && log.message) || 'Update documents and resubmit for review.';
            if (rank >= 3) {
                state = 'completed';
                at = log && log.created_at;
            } else if (status === 'revision_required') {
                state = 'active';
                at = log && log.created_at;
            }
        } else if (def.key === 'approved_pending_payment') {
            desc = (log && log.message) || 'Approved. Complete payment to confirm your seat.';
            if (rank >= 4) {
                state = 'completed';
                at = (log && log.created_at) || logByKey.completed?.created_at || null;
            } else if (rank === 3) {
                state = 'active';
                at = log ? log.created_at : null;
            }
        } else if (def.key === 'completed') {
            desc = (log && log.message) || 'Payment received successfully.';
            if (rank >= 4) {
                state = 'completed';
                at = (log && log.created_at) || null;
            } else if (rank === 3 && hasTicket) {
                state = 'active';
                desc = 'Complete payment to confirm your seat.';
            }
        } else if (def.key === 'ticket') {
            desc = (log && log.message) || 'Your e-ticket has been generated.';
            if ((rank >= 5 || status === 'e_ticket_issued') && hasTicket) {
                state = 'completed';
                at = (log && log.created_at) || null;
            } else if (rank >= 4) {
                state = hasTicket ? 'completed' : 'active';
                at = log ? log.created_at : null;
                if (!hasTicket) desc = 'Ticket will appear after payment is confirmed.';
            }
        } else if (def.key === 'checked_in') {
            const scannedAt = extra && extra.checkedInAt;
            const hasVenueCheckin = !!(scannedAt || status === 'checked_in' || extra?.scanVerified);
            desc = (log && log.message) || 'Checked in at the venue.';
            if (hasVenueCheckin) {
                state = 'completed';
                at = (log && log.created_at) || scannedAt || null;
                if (scannedAt && !log) {
                    desc = 'Checked in at the venue (synced from check-in scanner).';
                }
            } else if (rank >= 4 && extra && extra.hasTicket) {
                state = 'active';
                desc = 'Show your e-ticket QR at the venue entrance.';
            }
        } else if (def.key === 'certificate') {
            const scannedAt = extra && extra.checkedInAt;
            const hasVenueCheckin = !!(scannedAt || status === 'checked_in' || extra?.scanVerified);
            const certReady =
                hasVenueCheckin &&
                (!!(extra && extra.certEnabled) || status === 'certificate_issued');
            desc = (log && log.message) || 'Your e-certificate will appear after venue check-in.';
            if (certReady) {
                state = 'completed';
                at = (log && log.created_at) || scannedAt || null;
                desc = (log && log.message) || 'Your e-certificate is ready for download.';
            } else if (hasVenueCheckin) {
                state = 'active';
                desc = 'Checked in at the venue. Your e-certificate will be issued after admin approval.';
            }
        }

        if (status === 'rejected' || status === 'cancelled') {
            if (def.key === 'submitted') state = 'completed';
            else state = 'pending';
            at = def.key === 'submitted' ? submittedAt : null;
        } else if (stepRank > rank) {
            state = 'pending';
            at = null;
            const upcomingDesc = {
                completed: 'Payment will be confirmed after you pay online.',
                ticket: 'Your e-ticket QR will appear after payment.',
                checked_in: 'Venue check-in when you scan your e-ticket at the entrance.',
                certificate: 'E-certificate after check-in at the venue.'
            };
            if (!desc) desc = upcomingDesc[def.key] || 'Upcoming step.';
        }

        return {
            key: def.key,
            title: (log && log.label) || def.title,
            icon: def.icon,
            state,
            at,
            desc
        };
    });

    return { steps, status, rejected: status === 'rejected' || status === 'cancelled' };
}

function buildCaseTimeline(submission, logs) {
    const status = String((submission && submission.status) || 'submitted').toLowerCase();
    const logByKey = {};
    (logs || []).forEach((l) => {
        if (!logByKey[l.step_key]) logByKey[l.step_key] = l;
    });
    const judges = Number(submission.judge_count) || 0;
    const lockedScores = Number(submission.locked_score_count) || 0;
    const disq = status === 'disqualified' || submission.plagiarism_zero;

    if (disq) {
        return {
            steps: [],
            status,
            disqualified: true,
            disqualifiedAt: (logByKey.disqualified && logByKey.disqualified.created_at) || submission.updated_at
        };
    }

    const steps = CASE_TRACK_STEPS.map((def) => {
        let state = 'pending';
        let at = null;
        let desc = '';
        const log = logByKey[def.key];

        if (def.key === 'submitted') {
            state = 'completed';
            at = (log && log.created_at) || submission.created_at;
            desc = 'Files received and application ID issued.';
        } else if (def.key === 'under_review') {
            if (status === 'priority_invited') {
                state = 'active';
                desc = 'You were selected — complete missing details and upload files (priority review).';
            } else if (log || ['under_review', 'approved_for_judging', 'judging', 'judged', 'selected'].includes(status)) {
                state = log || status !== 'submitted' ? 'completed' : 'active';
                at = log && log.created_at;
            } else if (status === 'submitted') {
                state = 'active';
            }
            desc = log && log.message ? log.message : 'Admin reviews your uploaded files.';
        } else if (def.key === 'approved_for_judging') {
            if (log || ['approved_for_judging', 'judging', 'judged', 'selected'].includes(status)) {
                state = 'completed';
                at = log && log.created_at;
            }
            desc = log && log.message ? log.message : 'Cleared for judge assignment.';
        } else if (def.key === 'judging') {
            const allScored = judges > 0 && lockedScores >= judges;
            if (judges > 0 || ['judging', 'judged', 'selected'].includes(status)) {
                if (status === 'judged' || allScored) {
                    state = 'completed';
                    desc = 'All assigned judges have finished scoring.';
                } else if (status === 'judging') {
                    state = 'active';
                    desc =
                        lockedScores > 0
                            ? lockedScores + ' of ' + judges + ' judge(s) have scored.'
                            : judges + ' judge(s) assigned — scoring in progress.';
                } else {
                    state = 'completed';
                }
                at = log && log.created_at;
            }
            if (!desc) {
                desc =
                    log && log.message
                        ? log.message
                        : judges
                          ? judges + ' judge(s) assigned.'
                          : 'Waiting for judge assignment.';
            }
        } else if (def.key === 'scoring') {
            const allScored = judges > 0 && lockedScores >= judges;
            if (lockedScores > 0 || status === 'judged' || allScored) {
                state = 'completed';
                at = log && log.created_at;
                desc = allScored
                    ? 'All judge scores submitted.'
                    : lockedScores + ' score(s) locked in.';
            } else if (status === 'judging') {
                state = 'active';
                desc = 'Judges are submitting scores.';
            }
        } else if (def.key === 'selected') {
            if (status === 'selected') {
                state = 'completed';
                at = log && log.created_at;
                desc = 'Selected for this program.';
            } else {
                desc = 'Result pending.';
            }
        }

        return {
            key: def.key,
            title: (log && log.label) || def.title,
            icon: def.icon,
            state,
            at,
            desc
        };
    });

    return { steps, status, disqualified: false };
}

function attachRegistrationTimelines(db, rows, cb) {
    const list = rows || [];
    if (!list.length) return cb(null, list);
    let pending = list.length;
    const out = list.map((r) => ({ ...r }));
    out.forEach((row, idx) => {
        const regRank = seminarStatusRank(row.status);
        db.get(
            `SELECT 1 AS ok FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.registration_id = ? LIMIT 1`,
            [row.id],
            (eT, tRow) => {
                db.get(
                    `SELECT t.scan_time, t.is_scanned, IFNULL(t.scan_count, 0) AS scan_count,
                            IFNULL(s.cert_scans_required, 1) AS cert_scans_required
                     FROM tickets t
                     JOIN orders o ON o.id = t.order_id
                     JOIN registrations r2 ON r2.id = o.registration_id
                     JOIN seminars s ON s.id = r2.seminar_id
                     WHERE o.registration_id = ?
                     ORDER BY t.scan_time DESC LIMIT 1`,
                    [row.id],
                    (eSc, scanRow) => {
                        db.get(
                            `SELECT enabled, scan_verified, template_path FROM user_certificates WHERE registration_id = ? LIMIT 1`,
                            [row.id],
                            (eC, certRow) => {
                                fetchRegistrationLogs(db, row.id, (eL, logs) => {
                                    const scansReq =
                                        scanRow && scanRow.cert_scans_required != null
                                            ? parseInt(scanRow.cert_scans_required, 10) === 2
                                                ? 2
                                                : 1
                                            : 1;
                                    const scanCt = scanRow ? Number(scanRow.scan_count) || 0 : 0;
                                    const checkedInAt =
                                        scanRow && scanCt >= scansReq ? scanRow.scan_time : null;
                                    const certEnabled =
                                        certRow &&
                                        (Number(certRow.enabled) === 1 || certRow.enabled === true) &&
                                        certRow.template_path;
                                    const scanVerified =
                                        certRow &&
                                        (Number(certRow.scan_verified) === 1 || certRow.scan_verified === true);
                                    out[idx].timeline = buildSeminarTimeline(row, logs || [], {
                                        hasTicket: regRank >= 4 && !!(tRow && tRow.ok),
                                        checkedInAt,
                                        scanVerified: !!scanVerified,
                                        certEnabled: !!certEnabled
                                    });
                                    out[idx].portal_year = row.portal_year != null ? row.portal_year : null;
                                    if (--pending === 0) cb(null, out);
                                });
                            }
                        );
                    }
                );
            }
        );
    });
}

function attachCaseTimelines(db, rows, cb) {
    const list = rows || [];
    if (!list.length) return cb(null, list);
    let pending = list.length;
    const out = list.map((r) => ({ ...r }));
    out.forEach((row, idx) => {
        fetchCaseLogs(db, row.id, (eL, logs) => {
            out[idx].timeline = buildCaseTimeline(row, logs || []);
            out[idx].portal_year = row.portal_year != null ? row.portal_year : null;
            if (--pending === 0) cb(null, out);
        });
    });
}

function registrationStatusToLog(status, prevStatus) {
    const st = String(status || '').toLowerCase();
    const map = {
        submitted: { key: 'submitted', label: 'Application submitted', message: 'Registration received.' },
        pending_approval: {
            key: 'pending_approval',
            label: 'Under admin review',
            message: 'Application is being reviewed.'
        },
        approved_pending_payment: {
            key: 'approved_pending_payment',
            label: 'Approved — payment due',
            message: 'Approved. Please complete payment.'
        },
        completed: { key: 'completed', label: 'Payment confirmed', message: 'Payment successful.' },
        e_ticket_issued: {
            key: 'ticket',
            label: 'E-ticket issued',
            message: 'E-ticket is available in the doctor portal.'
        },
        certificate_issued: {
            key: 'certificate',
            label: 'E-certificate issued',
            message: 'Certificate is available for download.'
        },
        checked_in: { key: 'checked_in', label: 'Checked in', message: 'Venue check-in completed.' },
        revision_required: {
            key: 'revision_required',
            label: 'Documents need correction',
            message: 'Please re-upload documents on the same application number.'
        },
        rejected: { key: 'rejected', label: 'Application rejected', message: 'Application was rejected.' },
        cancelled: { key: 'cancelled', label: 'Application cancelled', message: 'Application was cancelled.' }
    };
    if (st === 'completed' && prevStatus !== 'completed') {
        return [
            map.completed,
            { key: 'ticket', label: 'E-ticket issued', message: 'Ticket generated after payment.' }
        ];
    }
    if (st === 'e_ticket_issued') return [map.e_ticket_issued];
    if (st === 'certificate_issued') return [map.certificate_issued];
    return map[st] ? [map[st]] : [];
}

function caseStatusToLog(status, extra) {
    const st = String(status || '').toLowerCase();
    const map = {
        submitted: { key: 'submitted', label: 'Application submitted', message: 'Case files uploaded.' },
        under_review: { key: 'under_review', label: 'Admin file review', message: 'Admin is reviewing files.' },
        approved_for_judging: {
            key: 'approved_for_judging',
            label: 'Approved for judging',
            message: 'Ready for judge assignment.'
        },
        judging: { key: 'judging', label: 'Judges assigned', message: extra || 'Judges are scoring.' },
        selected: { key: 'selected', label: 'Selected', message: 'Winner / selected for program.' },
        disqualified: { key: 'disqualified', label: 'Disqualified', message: extra || 'Marked disqualified.' },
        resubmitted: { key: 'submitted', label: 'Files resubmitted', message: 'Updated files received.' },
        revision_required: {
            key: 'revision_required',
            label: 'Documents need correction',
            message: 'Re-upload required on the same application ID.'
        }
    };
    if (st === 'judging' && extra) {
        return [{ key: 'judging', label: 'Judges assigned', message: extra }];
    }
    return map[st] ? [map[st]] : [];
}

module.exports = {
    PORTAL_YEAR_KEY,
    SEMINAR_TRACK_STEPS,
    CASE_TRACK_STEPS,
    ensurePortalTrackingSchema,
    currentIstYear,
    seminarPortalYearMatchSql,
    getPortalYear,
    setPortalYear,
    alignSeminarsToPortalYear,
    logRegistrationEvent,
    logCaseEvent,
    fetchRegistrationLogs,
    fetchCaseLogs,
    buildSeminarTimeline,
    buildCaseTimeline,
    attachRegistrationTimelines,
    attachCaseTimelines,
    registrationStatusToLog,
    caseStatusToLog,
    parsePortalYearValue
};

/**
 * Certificate verification tokens, public verify (post-seminar), and mandatory field checks.
 */
const crypto = require('crypto');
const { isSeminarEnded } = require('./local-date');
const otpLib = require('./otp');
const notifEngine = require('./notification-engine');

function parseGoLiveAt(val) {
    if (!val) return null;
    const t = new Date(val).getTime();
    return Number.isNaN(t) ? null : t;
}

/** Public verification is open for visitors (not countdown-only). */
function isPublicCertVerifyLive(sem) {
    if (!sem || !Number(sem.certificate_verify_enabled)) return false;
    const manual = Number(sem.certificate_verify_manual) === 1;
    if (!manual && !isSeminarEnded(sem.event_date)) return false;
    const goLive = parseGoLiveAt(sem.certificate_verify_go_live_at);
    if (goLive != null && Date.now() < goLive) return false;
    return true;
}

/** Show scheduled countdown before go-live. */
function getCertVerifyCountdownTarget(sem) {
    if (!sem || !Number(sem.certificate_verify_enabled)) return null;
    const goLive = parseGoLiveAt(sem.certificate_verify_go_live_at);
    if (goLive != null && Date.now() < goLive) {
        return { at: goLive, label: 'Certificate verification opens in' };
    }
    if (!isPublicCertVerifyLive(sem) && isSeminarEnded(sem.event_date) && goLive == null) {
        return null;
    }
    if (!isPublicCertVerifyLive(sem) && !isSeminarEnded(sem.event_date) && !Number(sem.certificate_verify_manual)) {
        const eventT = sem.event_date ? new Date(sem.event_date).getTime() : null;
        if (eventT != null && !Number.isNaN(eventT) && Date.now() < eventT) {
            return { at: eventT, label: 'Certificate verification opens after the seminar ends' };
        }
    }
    return null;
}

function ensureCertificateVerifySchema(db, ignoreErr, next) {
    const pg = !!process.env.DATABASE_URL;
    const alters = pg
        ? [
              `ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_enabled INTEGER DEFAULT 0`,
              `ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_manual INTEGER DEFAULT 0`,
              `ALTER TABLE seminars ADD COLUMN IF NOT EXISTS certificate_verify_go_live_at TIMESTAMPTZ`,
              `ALTER TABLE seminars ADD COLUMN IF NOT EXISTS cert_scans_required INTEGER DEFAULT 1`
          ]
        : [
              `ALTER TABLE seminars ADD COLUMN certificate_verify_enabled INTEGER DEFAULT 0`,
              `ALTER TABLE seminars ADD COLUMN certificate_verify_manual INTEGER DEFAULT 0`,
              `ALTER TABLE seminars ADD COLUMN certificate_verify_go_live_at TEXT`,
              `ALTER TABLE seminars ADD COLUMN cert_scans_required INTEGER DEFAULT 1`
          ];
    const ticketAlters = pg
        ? [
              `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS scan_count INTEGER DEFAULT 0`,
              `ALTER TABLE user_certificates ADD COLUMN IF NOT EXISTS verify_token TEXT`,
              `ALTER TABLE user_certificates ADD COLUMN IF NOT EXISTS dispatched_at TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS verify_token TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS dispatched_at TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS scan_time TIMESTAMPTZ`
          ]
        : [
              `ALTER TABLE tickets ADD COLUMN scan_count INTEGER DEFAULT 0`,
              `ALTER TABLE user_certificates ADD COLUMN verify_token TEXT`,
              `ALTER TABLE user_certificates ADD COLUMN dispatched_at TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN verify_token TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN dispatched_at TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN scan_time TEXT`
          ];
    const allAlters = alters.concat(ticketAlters);
    let i = 0;
    const step = () => {
        if (i >= allAlters.length) {
            db.run(
                `UPDATE tickets SET scan_count = 1 WHERE IFNULL(is_scanned, 0) = 1 AND IFNULL(scan_count, 0) = 0`,
                [],
                (e) => {
                    if (ignoreErr) ignoreErr(e);
                    if (next) next();
                }
            );
            return;
        }
        db.run(allAlters[i++], (e) => {
            if (ignoreErr) ignoreErr(e);
            step();
        });
    };
    step();
}

function normalizeCertScansRequired(val) {
    const n = parseInt(val, 10);
    return n === 2 ? 2 : 1;
}

function ticketMeetsScanRequirement(scanCount, scansRequired) {
    const required = normalizeCertScansRequired(scansRequired);
    const count = Number(scanCount) || 0;
    return count >= required;
}

function generateVerifyToken() {
    return crypto.randomBytes(18).toString('hex');
}

function publicVerifyUrl(token) {
    const base = notifEngine.publicBaseUrl().replace(/\/$/, '');
    return `${base}/verify-certificate.html?t=${encodeURIComponent(token)}`;
}

function qrImageUrl(token) {
    const base = notifEngine.publicBaseUrl().replace(/\/$/, '');
    return `${base}/api/qrcode/${encodeURIComponent(publicVerifyUrl(token))}`;
}

/**
 * @returns {{ ok: boolean, error?: string, prn?: string, applicationNo?: string }}
 */
/** Application / ticket id shown on volunteer certs and used for public verify lookup. */
const VOLUNTEER_APP_NO_SQL = `COALESCE(NULLIF(trim(sv.volunteer_ticket_id_string), ''), NULLIF(trim(r.application_no), ''))`;

function validateCertMandatoryFields(row) {
    const volunteer = row && row.cert_kind === 'volunteer';
    const prn = String((row && row.user_id_string) || '').trim();
    const applicationNo = String((row && row.application_no) || '').trim();
    if (!prn) {
        return {
            ok: false,
            error: volunteer
                ? 'Volunteer ID (portal Doctor ID) is missing for this certificate.'
                : 'PRN No. (portal Doctor ID) is missing for this registration.'
        };
    }
    if (!applicationNo) {
        return {
            ok: false,
            error: volunteer
                ? 'Volunteer ticket / application ID is missing for this certificate.'
                : 'Application No. is missing for this registration.'
        };
    }
    return { ok: true, prn, applicationNo, certKind: volunteer ? 'volunteer' : 'participant' };
}

function certVerifyOtpPurpose(certId, certKind, channel) {
    const kind = certKind === 'volunteer' ? 'volunteer' : 'participant';
    return `certificate_verify:${kind}:${parseInt(certId, 10)}:${channel}`;
}

function legacyCertVerifyOtpPurpose(certId, channel) {
    return `certificate_verify:${parseInt(certId, 10)}:${channel}`;
}

function ensureCertVerifyToken(db, certId, certKind, cb) {
    if (certKind === 'volunteer') return ensureVolunteerCertVerifyToken(db, certId, cb);
    return ensureUserCertVerifyToken(db, certId, cb);
}

function ensureUserCertVerifyToken(db, certId, cb) {
    const id = parseInt(certId, 10);
    if (!Number.isInteger(id) || id < 1) return cb(new Error('Invalid certificate id'));
    db.get(`SELECT id, verify_token FROM user_certificates WHERE id = ?`, [id], (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('Certificate not found'));
        if (row.verify_token) return cb(null, row.verify_token);
        const tok = generateVerifyToken();
        db.run(
            `UPDATE user_certificates SET verify_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [tok, id],
            (e2) => {
                if (e2) return cb(e2);
                cb(null, tok);
            }
        );
    });
}

function ensureVolunteerCertVerifyToken(db, certId, cb) {
    const id = parseInt(certId, 10);
    if (!Number.isInteger(id) || id < 1) return cb(new Error('Invalid certificate id'));
    db.get(`SELECT id, verify_token FROM volunteer_certificates WHERE id = ?`, [id], (e, row) => {
        if (e) return cb(e);
        if (!row) return cb(new Error('Certificate not found'));
        if (row.verify_token) return cb(null, row.verify_token);
        const tok = generateVerifyToken();
        db.run(
            `UPDATE volunteer_certificates SET verify_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [tok, id],
            (e2) => {
                if (e2) return cb(e2);
                cb(null, tok);
            }
        );
    });
}

function prepareParticipantCertRow(db, registrationId, userId, seminarId, cb) {
    db.get(
        `SELECT r.application_no, u.user_id_string, u.email, u.phone, uc.id AS cert_id
         FROM registrations r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN user_certificates uc ON uc.user_id = r.user_id AND uc.seminar_id = r.seminar_id
         WHERE r.id = ? AND r.user_id = ? AND r.seminar_id = ?`,
        [registrationId, userId, seminarId],
        (e, row) => {
            if (e) return cb(e);
            if (!row) return cb(null, { ok: false, error: 'Registration not found' });
            const chk = validateCertMandatoryFields(row);
            if (!chk.ok) return cb(null, chk);
            if (!row.cert_id) {
                return cb(null, { ok: false, error: 'Certificate record not created yet.' });
            }
            ensureUserCertVerifyToken(db, row.cert_id, (e2, tok) => {
                if (e2) return cb(e2);
                cb(null, { ok: true, certId: row.cert_id, verifyToken: tok, ...chk });
            });
        }
    );
}

function listPublicVerifySeminars(db, cb) {
    db.all(
        `SELECT id, title, event_date, certificate_verify_enabled, certificate_verify_manual, certificate_verify_go_live_at
         FROM seminars
         WHERE IFNULL(certificate_verify_enabled, 0) = 1
         ORDER BY event_date DESC, id DESC`,
        [],
        (e, rows) => {
            if (e) return cb(e);
            const out = (rows || []).filter((r) => isPublicCertVerifyLive(r));
            cb(
                null,
                out.map((r) => ({
                    id: r.id,
                    title: r.title,
                    eventDate: r.event_date
                }))
            );
        }
    );
}

function listPublicVerifySchedule(db, cb) {
    db.all(
        `SELECT id, title, event_date, certificate_verify_enabled, certificate_verify_manual, certificate_verify_go_live_at
         FROM seminars
         WHERE IFNULL(certificate_verify_enabled, 0) = 1
         ORDER BY certificate_verify_go_live_at ASC NULLS LAST, event_date DESC`,
        [],
        (e, rows) => {
            if (e) return cb(e);
            const items = (rows || [])
                .map((r) => {
                    const countdown = getCertVerifyCountdownTarget(r);
                    const live = isPublicCertVerifyLive(r);
                    return {
                        id: r.id,
                        title: r.title,
                        eventDate: r.event_date,
                        live,
                        countdown: countdown
                            ? { opensAt: new Date(countdown.at).toISOString(), label: countdown.label }
                            : null
                    };
                })
                .filter((x) => x.live || x.countdown);
            cb(null, items);
        }
    );
}

function resolveCertForPublicLookup(db, { seminarId, applicationNo, prn, token, certKind }, cb) {
    const sid = seminarId != null && seminarId !== '' ? parseInt(seminarId, 10) : null;
    const tok = String(token || '').trim();
    const app = String(applicationNo || '').trim();
    const prnNorm = String(prn || '').trim();

    if (!tok && (!Number.isInteger(sid) || sid < 1)) {
        return cb(null, { ok: false, error: 'Select a seminar.' });
    }

    function afterSeminarGate(sem, runQuery) {
        if (!sem) return cb(null, { ok: false, error: 'Seminar not found.' });
        if (!Number(sem.certificate_verify_enabled)) {
            return cb(null, {
                ok: false,
                error: 'Certificate verification is not enabled for this seminar yet.'
            });
        }
        const countdown = getCertVerifyCountdownTarget(sem);
        if (countdown) {
            return cb(null, {
                ok: false,
                error:
                    'Certificate verification is scheduled to open on ' +
                    new Date(countdown.at).toLocaleString() +
                    '.'
            });
        }
        if (!isPublicCertVerifyLive(sem)) {
            return cb(null, {
                ok: false,
                error: 'Certificate verification is available only after the seminar ends and the foundation has enabled it for that event.'
            });
        }
        runQuery(sem);
    }

    function finishLookup(sem, row) {
        const chk = validateCertMandatoryFields(row);
        if (!chk.ok) return cb(null, chk);
        const kind = row.cert_kind || chk.certKind || 'participant';
        if (!row.verify_token) {
            return ensureCertVerifyToken(db, row.cert_id, kind, (e3, vt) => {
                if (e3) return cb(e3);
                row.verify_token = vt;
                emitOk(sem, row, chk);
            });
        }
        emitOk(sem, row, chk);

        function emitOk(s, r, c) {
            cb(null, {
                ok: true,
                seminar: { id: s.id, title: s.title },
                cert: {
                    id: r.cert_id,
                    userId: r.user_id,
                    kind: r.cert_kind,
                    displayName: r.display_name,
                    applicationNo: c.applicationNo,
                    prn: c.prn,
                    enabled: !!Number(r.enabled),
                    verifyToken: r.verify_token,
                    email: r.email,
                    phone: r.phone
                }
            });
        }
    }

    if (tok) {
        const participantSql = `
            SELECT uc.id AS cert_id, uc.user_id, uc.seminar_id, uc.enabled, uc.verify_token, uc.dispatched_at,
                   uc.display_name, 'participant' AS cert_kind,
                   r.application_no, u.user_id_string, u.email, u.phone,
                   s.id AS sem_id, s.title AS seminar_title, s.event_date, s.certificate_verify_enabled,
                   s.certificate_verify_manual, s.certificate_verify_go_live_at
            FROM user_certificates uc
            JOIN users u ON u.id = uc.user_id
            JOIN seminars s ON s.id = uc.seminar_id
            LEFT JOIN registrations r ON r.id = uc.registration_id
            WHERE uc.verify_token = ? AND uc.enabled = 1
            LIMIT 1`;
        const volunteerSql = `
            SELECT vc.id AS cert_id, vc.user_id, vc.seminar_id, vc.enabled, vc.verify_token, vc.dispatched_at,
                   vc.display_name, 'volunteer' AS cert_kind,
                   ${VOLUNTEER_APP_NO_SQL} AS application_no, u.user_id_string, u.email, u.phone,
                   s.id AS sem_id, s.title AS seminar_title, s.event_date, s.certificate_verify_enabled,
                   s.certificate_verify_manual, s.certificate_verify_go_live_at
            FROM volunteer_certificates vc
            JOIN users u ON u.id = vc.user_id
            JOIN seminars s ON s.id = vc.seminar_id
            LEFT JOIN seminar_volunteers sv ON sv.seminar_id = vc.seminar_id AND sv.user_id = vc.user_id
            LEFT JOIN registrations r ON r.id = vc.registration_id
            WHERE vc.verify_token = ? AND vc.enabled = 1
            LIMIT 1`;
        const volunteerDisabledSql = `
            SELECT vc.enabled, 'volunteer' AS cert_kind
            FROM volunteer_certificates vc
            WHERE vc.verify_token = ?
            LIMIT 1`;
        return db.get(participantSql, [tok], (e, row) => {
            if (e) return cb(e);
            const runRow = (r) => {
                if (!r) {
                    return db.get(volunteerDisabledSql, [tok], (eDis, dis) => {
                        if (eDis) return cb(eDis);
                        if (dis && Number(dis.enabled) !== 1) {
                            return cb(null, {
                                ok: false,
                                error:
                                    'This volunteer certificate is not enabled for public verification yet. In admin, open Certificate Management, choose Volunteer certificate, and enable it for this person.'
                            });
                        }
                        return cb(null, { ok: false, error: 'No matching issued certificate found.' });
                    });
                }
                const sem = {
                    id: r.seminar_id || r.sem_id,
                    title: r.seminar_title,
                    event_date: r.event_date,
                    certificate_verify_enabled: r.certificate_verify_enabled,
                    certificate_verify_manual: r.certificate_verify_manual,
                    certificate_verify_go_live_at: r.certificate_verify_go_live_at
                };
                return afterSeminarGate(sem, () => finishLookup(sem, r));
            };
            if (row) return runRow(row);
            db.get(volunteerSql, [tok], (e2, vrow) => {
                if (e2) return cb(e2);
                runRow(vrow);
            });
        });
    }

    db.get(
        `SELECT id, title, event_date, certificate_verify_enabled, certificate_verify_manual, certificate_verify_go_live_at FROM seminars WHERE id = ?`,
        [sid],
        (e, sem) => {
            if (e) return cb(e);
            afterSeminarGate(sem, (semRow) => {
                if (!app && !prnNorm) {
                    return cb(null, {
                        ok: false,
                        error: 'Enter Application No., PRN No., or scan the certificate QR code.'
                    });
                }
                const participantSql = `
                SELECT uc.id AS cert_id, uc.user_id, uc.enabled, uc.verify_token, uc.dispatched_at,
                       uc.display_name, 'participant' AS cert_kind,
                       r.application_no, u.user_id_string, u.email, u.phone, s.title AS seminar_title
                FROM user_certificates uc
                JOIN users u ON u.id = uc.user_id
                JOIN seminars s ON s.id = uc.seminar_id
                LEFT JOIN registrations r ON r.id = uc.registration_id
                WHERE uc.seminar_id = ? AND uc.enabled = 1`;
                const volunteerSql = `
                SELECT vc.id AS cert_id, vc.user_id, vc.enabled, vc.verify_token, vc.dispatched_at,
                       vc.display_name, 'volunteer' AS cert_kind,
                       ${VOLUNTEER_APP_NO_SQL} AS application_no, u.user_id_string, u.email, u.phone,
                       s.title AS seminar_title
                FROM volunteer_certificates vc
                JOIN users u ON u.id = vc.user_id
                JOIN seminars s ON s.id = vc.seminar_id
                LEFT JOIN seminar_volunteers sv ON sv.seminar_id = vc.seminar_id AND sv.user_id = vc.user_id
                LEFT JOIN registrations r ON r.id = vc.registration_id
                WHERE vc.seminar_id = ? AND vc.enabled = 1`;
                const baseParams = [sid];
                let filterP = '';
                let filterV = '';
                let paramsP = baseParams.slice();
                let paramsV = baseParams.slice();
                if (app) {
                    filterP = ` AND r.application_no = ?`;
                    filterV = ` AND (r.application_no = ? OR sv.volunteer_ticket_id_string = ?)`;
                    paramsP.push(app);
                    paramsV.push(app, app);
                } else {
                    filterP = ` AND lower(trim(u.user_id_string)) = lower(trim(?))`;
                    filterV = filterP;
                    paramsP.push(prnNorm);
                    paramsV.push(prnNorm);
                }
                const runSearch = (sql, filter, params, cbRows) => {
                    db.all(sql + filter + ` LIMIT 2`, params, cbRows);
                };
                runSearch(participantSql, filterP, paramsP, (e2, pRows) => {
                    if (e2) return cb(e2);
                    runSearch(volunteerSql, filterV, paramsV, (e3, vRows) => {
                        if (e3) return cb(e3);
                        let rows = (pRows || []).concat(vRows || []);
                        if (!rows.length) {
                            return cb(null, { ok: false, error: 'No matching issued certificate found.' });
                        }
                        const kindFilter = String(certKind || '').toLowerCase();
                        if (rows.length > 1 && (kindFilter === 'volunteer' || kindFilter === 'participant')) {
                            rows = rows.filter((r) => String(r.cert_kind || '') === kindFilter);
                        }
                        if (!rows.length) {
                            return cb(null, {
                                ok: false,
                                error: 'No matching ' + kindFilter + ' certificate found for this seminar.'
                            });
                        }
                        if (rows.length > 1) {
                            return cb(null, {
                                ok: false,
                                error:
                                    'Both Participation and Volunteer certificates match. Scan the QR on the certificate you are verifying, or enter the ticket ID (VOL_…) for Volunteer / application no. for Participation.'
                            });
                        }
                        finishLookup(semRow, rows[0]);
                    });
                });
            });
        }
    );
}

function otpPurposeMatches(result, certId, certKind, channel) {
    if (!result || !result.ok) return false;
    if (result.channel !== channel) return false;
    const expected = certVerifyOtpPurpose(certId, certKind, channel);
    const legacy = legacyCertVerifyOtpPurpose(certId, channel);
    return result.purpose === expected || result.purpose === legacy;
}

function validateBothOtpTokens(db, { certId, certKind, emailToken, phoneToken }, cb) {
    const cid = parseInt(certId, 10);
    const kind = certKind === 'volunteer' ? 'volunteer' : 'participant';
    if (!Number.isInteger(cid) || cid < 1) {
        return cb(null, { ok: false, error: 'Certificate session invalid. Start again.' });
    }
    otpLib.consumeVerificationToken(db, emailToken, (e1, r1) => {
        if (e1) return cb(e1);
        if (!otpPurposeMatches(r1, cid, kind, 'email')) {
            return cb(null, { ok: false, error: 'Email OTP invalid or expired. Request a new code.' });
        }
        otpLib.consumeVerificationToken(db, phoneToken, (e2, r2) => {
            if (e2) return cb(e2);
            if (!otpPurposeMatches(r2, cid, kind, 'phone')) {
                return cb(null, {
                    ok: false,
                    error: 'WhatsApp OTP invalid or expired. Request a new code.'
                });
            }
            cb(null, { ok: true });
        });
    });
}

function maskEmail(email) {
    const e = String(email || '').trim();
    const at = e.indexOf('@');
    if (at < 2) return '***';
    return e.slice(0, 2) + '***' + e.slice(at);
}

function maskPhone(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 4) return '****';
    return '******' + d.slice(-4);
}

function dispatchCertList(db, seminarId, list, certKind, cb) {
    const sid = parseInt(seminarId, 10);
    let sent = 0;
    let skipped = 0;
    const errors = [];
    let i = 0;
    const volunteer = certKind === 'volunteer';
    const nextRow = () => {
        if (i >= list.length) {
            return cb(null, { dispatched: sent, skipped, errors: errors.slice(0, 8) });
        }
        const row = list[i++];
        row.cert_kind = certKind;
        const chk = validateCertMandatoryFields(row);
        if (!chk.ok) {
            skipped++;
            errors.push(chk.error);
            return nextRow();
        }
        ensureCertVerifyToken(db, row.cert_id, certKind, (e3, tok) => {
            if (e3) {
                skipped++;
                errors.push(e3.message);
                return nextRow();
            }
            const verifyUrl = publicVerifyUrl(tok);
            const viewUrl = volunteer
                ? notifEngine.publicBaseUrl() +
                  `/certificate/view?vc=${row.cert_id}&uid=${row.user_id}&type=volunteer`
                : notifEngine.publicBaseUrl() +
                  `/certificate/view?uc=${row.cert_id}&uid=${row.user_id}`;
            notifEngine.notify(
                db,
                'CERTIFICATE_AVAILABLE',
                {
                    userId: row.user_id,
                    seminarId: sid,
                    vars: {
                        certificate_url: viewUrl,
                        verify_url: verifyUrl,
                        application_no: chk.applicationNo,
                        prn_no: chk.prn
                    }
                },
                () => {
                    const table = volunteer ? 'volunteer_certificates' : 'user_certificates';
                    db.run(
                        `UPDATE ${table} SET dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [row.cert_id],
                        () => {
                            sent++;
                            nextRow();
                        }
                    );
                }
            );
        });
    };
    nextRow();
}

function dispatchAllEnabledCertificates(db, seminarId, cb) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return cb(null, { ok: false, error: 'seminarId is required' });
    }
    db.get(
        `SELECT id, title, event_date FROM seminars WHERE id = ?`,
        [sid],
        (e, sem) => {
            if (e) return cb(e);
            if (!sem) return cb(null, { ok: false, error: 'Seminar not found' });
            db.get(
                `SELECT id, file_path FROM certificate_templates WHERE seminar_id = ? AND (cert_type IS NULL OR cert_type = 'participant') AND is_active = 1 ORDER BY id DESC LIMIT 1`,
                [sid],
                (eTpl, tpl) => {
                    if (eTpl) return cb(eTpl);
                    db.get(
                        `SELECT id, file_path FROM certificate_templates WHERE seminar_id = ? AND cert_type = 'volunteer' AND is_active = 1 ORDER BY id DESC LIMIT 1`,
                        [sid],
                        (eTplV, tplV) => {
                            if (eTplV) return cb(eTplV);
                            const hasParticipantTpl = !!(tpl && tpl.file_path);
                            const hasVolunteerTpl = !!(tplV && tplV.file_path);
                            if (!hasParticipantTpl && !hasVolunteerTpl) {
                                return cb(null, {
                                    ok: false,
                                    error: 'Apply or upload participant and/or volunteer certificate templates before dispatching.'
                                });
                            }
                            db.all(
                                `SELECT uc.id AS cert_id, uc.user_id, uc.registration_id, r.application_no, u.user_id_string, u.email, u.phone
                                 FROM user_certificates uc
                                 JOIN users u ON u.id = uc.user_id
                                 LEFT JOIN registrations r ON r.id = uc.registration_id
                                 WHERE uc.seminar_id = ? AND uc.enabled = 1`,
                                [sid],
                                (e2, pRows) => {
                                    if (e2) return cb(e2);
                                    db.all(
                                        `SELECT vc.id AS cert_id, vc.user_id,
                                                ${VOLUNTEER_APP_NO_SQL} AS application_no,
                                                u.user_id_string, u.email, u.phone
                                         FROM volunteer_certificates vc
                                         JOIN users u ON u.id = vc.user_id
                                         LEFT JOIN seminar_volunteers sv ON sv.seminar_id = vc.seminar_id AND sv.user_id = vc.user_id
                                         LEFT JOIN registrations r ON r.id = vc.registration_id
                                         WHERE vc.seminar_id = ? AND vc.enabled = 1`,
                                        [sid],
                                        (e3, vRows) => {
                                            if (e3) return cb(e3);
                                            const participants = hasParticipantTpl ? pRows || [] : [];
                                            const volunteers = hasVolunteerTpl ? vRows || [] : [];
                                            if (!participants.length && !volunteers.length) {
                                                return cb(null, {
                                                    ok: false,
                                                    error: 'No enabled certificates to dispatch.'
                                                });
                                            }
                                            let totalSent = 0;
                                            let totalSkipped = 0;
                                            const allErrors = [];
                                            const afterParticipants = () => {
                                                if (!volunteers.length) {
                                                    return cb(null, {
                                                        ok: true,
                                                        dispatched: totalSent,
                                                        skipped: totalSkipped,
                                                        errors: allErrors.slice(0, 8)
                                                    });
                                                }
                                                dispatchCertList(db, sid, volunteers, 'volunteer', (e4, vOut) => {
                                                    if (e4) return cb(e4);
                                                    totalSent += vOut.dispatched;
                                                    totalSkipped += vOut.skipped;
                                                    allErrors.push.apply(allErrors, vOut.errors || []);
                                                    cb(null, {
                                                        ok: true,
                                                        dispatched: totalSent,
                                                        skipped: totalSkipped,
                                                        errors: allErrors.slice(0, 8)
                                                    });
                                                });
                                            };
                                            if (!participants.length) return afterParticipants();
                                            dispatchCertList(db, sid, participants, 'participant', (e5, pOut) => {
                                                if (e5) return cb(e5);
                                                totalSent += pOut.dispatched;
                                                totalSkipped += pOut.skipped;
                                                allErrors.push.apply(allErrors, pOut.errors || []);
                                                afterParticipants();
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );
}

module.exports = {
    ensureCertificateVerifySchema,
    normalizeCertScansRequired,
    ticketMeetsScanRequirement,
    generateVerifyToken,
    publicVerifyUrl,
    qrImageUrl,
    validateCertMandatoryFields,
    ensureUserCertVerifyToken,
    ensureVolunteerCertVerifyToken,
    ensureCertVerifyToken,
    prepareParticipantCertRow,
    listPublicVerifySeminars,
    listPublicVerifySchedule,
    isPublicCertVerifyLive,
    getCertVerifyCountdownTarget,
    resolveCertForPublicLookup,
    validateBothOtpTokens,
    maskEmail,
    maskPhone,
    dispatchAllEnabledCertificates
};

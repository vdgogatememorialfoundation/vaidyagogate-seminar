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
              `ALTER TABLE volunteer_certificates ADD COLUMN IF NOT EXISTS dispatched_at TEXT`
          ]
        : [
              `ALTER TABLE tickets ADD COLUMN scan_count INTEGER DEFAULT 0`,
              `ALTER TABLE user_certificates ADD COLUMN verify_token TEXT`,
              `ALTER TABLE user_certificates ADD COLUMN dispatched_at TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN verify_token TEXT`,
              `ALTER TABLE volunteer_certificates ADD COLUMN dispatched_at TEXT`
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
function validateCertMandatoryFields(row) {
    const prn = String((row && row.user_id_string) || '').trim();
    const applicationNo = String((row && row.application_no) || '').trim();
    if (!prn) {
        return { ok: false, error: 'PRN No. (portal Doctor ID) is missing for this registration.' };
    }
    if (!applicationNo) {
        return { ok: false, error: 'Application No. is missing for this registration.' };
    }
    return { ok: true, prn, applicationNo };
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

function resolveCertForPublicLookup(db, { seminarId, applicationNo, prn, token }, cb) {
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
        if (!row.verify_token) {
            return ensureUserCertVerifyToken(db, row.cert_id, (e3, vt) => {
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
        return db.get(
            `SELECT uc.id AS cert_id, uc.user_id, uc.seminar_id, uc.enabled, uc.verify_token, uc.dispatched_at,
                    uc.display_name, 'participant' AS cert_kind,
                    r.application_no, u.user_id_string, u.email, u.phone,
                    s.id AS sem_id, s.title AS seminar_title, s.event_date, s.certificate_verify_enabled,
                    s.certificate_verify_manual, s.certificate_verify_go_live_at
             FROM user_certificates uc
             JOIN users u ON u.id = uc.user_id
             JOIN seminars s ON s.id = uc.seminar_id
             LEFT JOIN registrations r ON r.id = uc.registration_id
             WHERE uc.verify_token = ? AND uc.enabled = 1
             LIMIT 1`,
            [tok],
            (e, row) => {
                if (e) return cb(e);
                if (!row) return cb(null, { ok: false, error: 'No matching issued certificate found.' });
                const sem = {
                    id: row.seminar_id || row.sem_id,
                    title: row.seminar_title,
                    event_date: row.event_date,
                    certificate_verify_enabled: row.certificate_verify_enabled,
                    certificate_verify_manual: row.certificate_verify_manual,
                    certificate_verify_go_live_at: row.certificate_verify_go_live_at
                };
                return afterSeminarGate(sem, () => finishLookup(sem, row));
            }
        );
    }

    db.get(
        `SELECT id, title, event_date, certificate_verify_enabled, certificate_verify_manual, certificate_verify_go_live_at FROM seminars WHERE id = ?`,
        [sid],
        (e, sem) => {
            if (e) return cb(e);
            afterSeminarGate(sem, (semRow) => {
                let sql = `
                SELECT uc.id AS cert_id, uc.user_id, uc.enabled, uc.verify_token, uc.dispatched_at,
                       uc.display_name, 'participant' AS cert_kind,
                       r.application_no, u.user_id_string, u.email, u.phone, s.title AS seminar_title
                FROM user_certificates uc
                JOIN users u ON u.id = uc.user_id
                JOIN seminars s ON s.id = uc.seminar_id
                LEFT JOIN registrations r ON r.id = uc.registration_id
                WHERE uc.seminar_id = ? AND uc.enabled = 1
            `;
                const params = [sid];

                if (app) {
                    sql += ` AND r.application_no = ?`;
                    params.push(app);
                } else if (prnNorm) {
                    sql += ` AND lower(trim(u.user_id_string)) = lower(trim(?))`;
                    params.push(prnNorm);
                } else {
                    return cb(null, {
                        ok: false,
                        error: 'Enter Application No., PRN No., or scan the certificate QR code.'
                    });
                }

                sql += ` LIMIT 2`;

                db.all(sql, params, (e2, rows) => {
                    if (e2) return cb(e2);
                    if (!rows || !rows.length) {
                        return cb(null, { ok: false, error: 'No matching issued certificate found.' });
                    }
                    if (rows.length > 1) {
                        return cb(null, {
                            ok: false,
                            error: 'Multiple matches — use Application No. or the QR code on the certificate.'
                        });
                    }
                    finishLookup(semRow, rows[0]);
                });
            });
        }
    );
}

function validateBothOtpTokens(db, { certId, emailToken, phoneToken }, cb) {
    const cid = parseInt(certId, 10);
    if (!Number.isInteger(cid) || cid < 1) {
        return cb(null, { ok: false, error: 'Certificate session invalid. Start again.' });
    }
    const pEmail = `certificate_verify:${cid}:email`;
    const pPhone = `certificate_verify:${cid}:phone`;
    otpLib.consumeVerificationToken(db, emailToken, (e1, r1) => {
        if (e1) return cb(e1);
        if (!r1 || !r1.ok || r1.purpose !== pEmail || r1.channel !== 'email') {
            return cb(null, { ok: false, error: 'Email OTP invalid or expired. Request a new code.' });
        }
        otpLib.consumeVerificationToken(db, phoneToken, (e2, r2) => {
            if (e2) return cb(e2);
            if (!r2 || !r2.ok || r2.purpose !== pPhone || r2.channel !== 'phone') {
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
                `SELECT id, file_path FROM certificate_templates WHERE seminar_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1`,
                [sid],
                (eTpl, tpl) => {
                    if (eTpl) return cb(eTpl);
                    if (!tpl || !tpl.file_path) {
                        return cb(null, {
                            ok: false,
                            error: 'Apply or upload a certificate template before dispatching.'
                        });
                    }
                    db.all(
                        `SELECT uc.id AS cert_id, uc.user_id, uc.registration_id, r.application_no, u.user_id_string, u.email, u.phone
                         FROM user_certificates uc
                         JOIN users u ON u.id = uc.user_id
                         LEFT JOIN registrations r ON r.id = uc.registration_id
                         WHERE uc.seminar_id = ? AND uc.enabled = 1`,
                        [sid],
                        (e2, rows) => {
                            if (e2) return cb(e2);
                            const list = rows || [];
                            if (!list.length) {
                                return cb(null, { ok: false, error: 'No enabled certificates to dispatch.' });
                            }
                            let sent = 0;
                            let skipped = 0;
                            const errors = [];
                            let i = 0;
                            const nextRow = () => {
                                if (i >= list.length) {
                                    return cb(null, {
                                        ok: true,
                                        dispatched: sent,
                                        skipped,
                                        errors: errors.slice(0, 8)
                                    });
                                }
                                const row = list[i++];
                                const chk = validateCertMandatoryFields(row);
                                if (!chk.ok) {
                                    skipped++;
                                    errors.push(chk.error);
                                    return nextRow();
                                }
                                ensureUserCertVerifyToken(db, row.cert_id, (e3, tok) => {
                                    if (e3) {
                                        skipped++;
                                        errors.push(e3.message);
                                        return nextRow();
                                    }
                                    const verifyUrl = publicVerifyUrl(tok);
                                    const viewUrl =
                                        notifEngine.publicBaseUrl() +
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
                                            db.run(
                                                `UPDATE user_certificates SET dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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

/**
 * On-spot POS: participant search (phone / name / email / doctor ID) and
 * private one-hour registration + payment links (admin & staff).
 */
const crypto = require('crypto');
const bookAuth = require('./book-sales-auth');
const posOnspot = require('./pos-onspot');
const integrationSettings = require('./integration-settings');
const seminarDt = require('./seminar-datetime');
const dynamicFields = require('./dynamic-fields');

const LINK_TTL_MS = 60 * 60 * 1000;

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ensureOnspotLinkSchema(db, cb) {
    const pg = isPg();
    const ts = pg ? 'TIMESTAMPTZ' : 'DATETIME';
    const sql = `CREATE TABLE IF NOT EXISTS onspot_links (
        id ${pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        token TEXT UNIQUE NOT NULL,
        seminar_id INTEGER NOT NULL,
        user_id INTEGER,
        registration_id INTEGER,
        first_name TEXT,
        middle_name TEXT,
        last_name TEXT,
        email TEXT,
        phone TEXT,
        amount REAL,
        created_by INTEGER,
        created_at ${ts} DEFAULT CURRENT_TIMESTAMP,
        expires_at ${ts} NOT NULL,
        opened_at ${ts},
        used_at ${ts},
        paid_at ${ts},
        email_sent_at ${ts}
    )`;
    db.run(sql, (e) => {
        if (e && !/already exists/i.test(String(e.message))) console.warn('[onspot-links]', e.message);
        cb && cb();
    });
}

function newToken() {
    return crypto.randomBytes(24).toString('hex');
}

function linkState(row, nowMs) {
    const now = nowMs || Date.now();
    if (!row) return 'missing';
    if (row.paid_at) return 'paid';
    const exp = new Date(row.expires_at).getTime();
    if (Number.isFinite(exp) && exp <= now) return 'expired';
    return 'active';
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function digits(s) {
    return String(s || '').replace(/\D+/g, '');
}

function registerOnspotRoutes(app, deps) {
    const { db, generateId, notifEngine, activityLog, seminarCapacity, listDoctorPaymentOptions, loadRegistrationFormConfig } = deps;

    const CORE_KEYS = new Set(['fname', 'mname', 'lname', 'email', 'phone']);
    /** Seminar-configured registration fields the on-spot page renders beyond the core identity fields. */
    function loadOnspotFormFields(seminarId, cb) {
        if (typeof loadRegistrationFormConfig !== 'function') return cb(null, []);
        loadRegistrationFormConfig(seminarId, (err, cfg) => {
            if (err) return cb(err);
            const fields = dynamicFields
                .sanitizeRegistrationFormFields((cfg && cfg.fields) || [])
                .filter((f) => f.enabled !== false && !CORE_KEYS.has(f.key) && !dynamicFields.isOtpPlaceholderField(f))
                .filter((f) => f.type !== 'file');
            cb(null, fields);
        });
    }
    const guard = (fn) => bookAuth.requireBookSalesActor(db, { section: 'pos' }, fn);

    function loadSeminar(seminarId, cb) {
        db.get(
            `SELECT id, title, price, event_date, event_end_date, location_url, ticket_expires_at, is_active
             FROM seminars WHERE id = ?`,
            [seminarId],
            (e, s) => {
                if (e || !s) return cb(e, null, []);
                db.all(
                    `SELECT * FROM seminar_days WHERE seminar_id = ? ORDER BY day_date ASC, id ASC`,
                    [seminarId],
                    (e2, days) => cb(null, s, e2 ? [] : days || [])
                );
            }
        );
    }

    function publicLinkUrl(token) {
        return integrationSettings.getPublicBaseUrl() + '/onspot/' + token;
    }

    // --- Search: phone / name / email / doctor ID / application no ---
    app.get('/api/pos/search', guard((req, res) => {
        const q = String(req.query.q || '').trim();
        const seminarId = parseInt(req.query.seminarId, 10) || null;
        if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters' });
        const like = '%' + q.replace(/[%_]/g, '') + '%';
        const qDigits = digits(q);
        const clauses = [
            `LOWER(u.email) LIKE LOWER(?)`,
            `LOWER(u.first_name || ' ' || COALESCE(u.middle_name || ' ', '') || u.last_name) LIKE LOWER(?)`,
            `LOWER(u.first_name || ' ' || u.last_name) LIKE LOWER(?)`,
            `LOWER(u.user_id_string) LIKE LOWER(?)`,
            `EXISTS (SELECT 1 FROM registrations rr WHERE rr.user_id = u.id AND LOWER(rr.application_no) LIKE LOWER(?))`
        ];
        const params = [like, like, like, like, like];
        if (qDigits.length >= 4) {
            clauses.push(`replace(replace(replace(COALESCE(u.phone,''), ' ', ''), '-', ''), '+', '') LIKE ?`);
            params.push('%' + qDigits + '%');
        }
        db.all(
            `SELECT u.id, u.user_id_string, u.first_name, u.middle_name, u.last_name, u.email, u.phone
             FROM users u
             WHERE COALESCE(u.role, 'doctor') NOT IN ('admin')
               AND (${clauses.join(' OR ')})
             ORDER BY u.id DESC LIMIT 25`,
            params,
            (err, users) => {
                if (err) return res.status(500).json({ error: err.message });
                const list = users || [];
                if (!list.length) return res.json({ results: [] });
                const ids = list.map((u) => u.id);
                const ph = ids.map(() => '?').join(',');
                const regParams = ids.slice();
                let regSql = `SELECT r.id, r.user_id, r.seminar_id, r.status, r.application_no, s.title AS seminar_title,
                                     (SELECT t.ticket_id_string FROM tickets t JOIN orders o ON o.id = t.order_id
                                       WHERE o.registration_id = r.id ORDER BY t.id DESC LIMIT 1) AS ticket_id_string
                              FROM registrations r JOIN seminars s ON s.id = r.seminar_id
                              WHERE r.user_id IN (${ph})`;
                if (seminarId) {
                    regSql += ' AND r.seminar_id = ?';
                    regParams.push(seminarId);
                }
                regSql += ' ORDER BY r.id DESC';
                db.all(regSql, regParams, (e2, regs) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const byUser = {};
                    (regs || []).forEach((r) => {
                        (byUser[r.user_id] = byUser[r.user_id] || []).push(r);
                    });
                    res.json({
                        results: list.map((u) => ({
                            id: u.id,
                            userIdString: u.user_id_string,
                            firstName: u.first_name,
                            middleName: u.middle_name,
                            lastName: u.last_name,
                            name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' '),
                            email: u.email,
                            phone: u.phone,
                            registrations: (byUser[u.id] || []).map((r) => ({
                                id: r.id,
                                seminarId: r.seminar_id,
                                seminarTitle: r.seminar_title,
                                status: r.status,
                                applicationNo: r.application_no,
                                ticketId: r.ticket_id_string || null
                            }))
                        }))
                    });
                });
            }
        );
    }));

    // --- Create + email a private 1-hour link ---
    app.post('/api/pos/onspot-link', guard((req, res) => {
        const actor = req.bookSalesActor;
        const b = req.body || {};
        const sid = parseInt(b.seminarId, 10);
        const em = String(b.email || '').trim().toLowerCase();
        const ph = String(b.phone || '').trim();
        const fn = String(b.firstName || '').trim();
        const mn = String(b.middleName || '').trim();
        const ln = String(b.lastName || '').trim();
        const userId = parseInt(b.userId, 10) || null;
        const amount = b.amount !== '' && b.amount != null && Number.isFinite(Number(b.amount)) ? Number(b.amount) : null;
        const sendEmail = b.sendEmail !== false;
        if (!Number.isInteger(sid) || sid < 1) return res.status(400).json({ error: 'seminarId required' });
        if (!em && sendEmail) return res.status(400).json({ error: 'Email address required to send the link' });
        if (!userId && (!fn || !ln)) return res.status(400).json({ error: 'First and last name required' });

        loadSeminar(sid, (sErr, sem, days) => {
            if (sErr) return res.status(500).json({ error: sErr.message });
            if (!sem) return res.status(404).json({ error: 'Seminar not found' });
            const token = newToken();
            const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
            db.run(
                `INSERT INTO onspot_links (token, seminar_id, user_id, first_name, middle_name, last_name, email, phone, amount, created_by, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [token, sid, userId, fn, mn, ln, em, ph, amount, actor.id, expiresAt],
                (iErr) => {
                    if (iErr) return res.status(500).json({ error: iErr.message });
                    const url = publicLinkUrl(token);
                    if (activityLog && activityLog.logActivity) {
                        activityLog.logActivity(db, {
                            user_id: actor.id,
                            action: 'pos.onspot_link',
                            resource_type: 'seminar',
                            resource_id: String(sid),
                            meta: { email: em, phone: ph, userId, expiresAt }
                        });
                    }
                    const finish = (emailQueued) =>
                        res.json({ success: true, url, token, expiresAt, emailQueued: !!emailQueued });
                    if (!sendEmail || !notifEngine || !notifEngine.enqueueDirectMessage) return finish(false);

                    const schedule = seminarDt.formatSeminarSchedule(sem, days);
                    const name = fn || 'Doctor';
                    const fee = amount != null ? amount : Number(sem.price) || null;
                    const html =
                        `<p>Dear ${escapeHtml(name)},</p>` +
                        `<p>Use your private link below to complete on-spot registration${fee ? ' and payment of <strong>₹' + escapeHtml(fee) + '</strong>' : ''} for <strong>${escapeHtml(sem.title)}</strong>.</p>` +
                        (schedule ? `<p><strong>Schedule:</strong> ${escapeHtml(schedule)}</p>` : '') +
                        `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Register &amp; pay now</a></p>` +
                        `<p>Or open: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
                        `<p style="color:#b45309"><strong>This link is personal and expires in 1 hour</strong> (${escapeHtml(new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST). Do not share it.</p>`;
                    notifEngine.enqueueDirectMessage(
                        db,
                        {
                            channel: 'email',
                            destination: em,
                            subject: 'Your private on-spot registration link — ' + sem.title,
                            html,
                            text:
                                `Dear ${name}, complete your on-spot registration for ${sem.title} here: ${url}\n` +
                                `This personal link expires in 1 hour.`,
                            event_key: 'ONSPOT_LINK',
                            immediate: true,
                            priority: true,
                            userId: userId || undefined
                        },
                        () => {
                            db.run(`UPDATE onspot_links SET email_sent_at = CURRENT_TIMESTAMP WHERE token = ?`, [token], () =>
                                finish(true)
                            );
                        }
                    );
                }
            );
        });
    }));

    // --- Public: resolve link ---
    app.get('/api/onspot/:token', (req, res) => {
        const token = String(req.params.token || '').trim();
        if (!/^[a-f0-9]{16,}$/i.test(token)) return res.status(404).json({ error: 'Invalid link' });
        db.get(`SELECT * FROM onspot_links WHERE token = ?`, [token], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'This link is not valid.' });
            const state = linkState(row);
            loadSeminar(row.seminar_id, (sErr, sem, days) => {
                if (sErr) return res.status(500).json({ error: sErr.message });
                if (!row.opened_at) {
                    db.run(`UPDATE onspot_links SET opened_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], () => {});
                }
                const payload = {
                    state,
                    expiresAt: row.expires_at,
                    seminar: sem
                        ? {
                              id: sem.id,
                              title: sem.title,
                              price: sem.price,
                              schedule: seminarDt.formatSeminarSchedule(sem, days),
                              scheduleDates: seminarDt.seminarDateList(sem, days),
                              locationUrl: sem.location_url
                          }
                        : null,
                    amount: row.amount != null ? Number(row.amount) : sem ? Number(sem.price) || null : null,
                    person: {
                        firstName: row.first_name || '',
                        middleName: row.middle_name || '',
                        lastName: row.last_name || '',
                        email: row.email || '',
                        phone: row.phone || '',
                        locked: !!row.user_id
                    },
                    registrationId: row.registration_id || null,
                    userId: row.user_id || null,
                    formFields: []
                };
                if (state !== 'active') return res.json(payload);
                loadOnspotFormFields(row.seminar_id, (fErr, fields) => {
                    if (!fErr) payload.formFields = fields;
                    if (!row.user_id) return res.json(payload);
                    db.get(
                        `SELECT first_name, middle_name, last_name, email, phone FROM users WHERE id = ?`,
                        [row.user_id],
                        (uErr, u) => {
                            if (!uErr && u) {
                                payload.person = {
                                    firstName: u.first_name || '',
                                    middleName: u.middle_name || '',
                                    lastName: u.last_name || '',
                                    email: u.email || row.email || '',
                                    phone: u.phone || row.phone || '',
                                    locked: true
                                };
                            }
                            res.json(payload);
                        }
                    );
                });
            });
        });
    });

    // --- Public: create/find user + registration for this link, return ids for payment ---
    app.post('/api/onspot/:token/register', (req, res) => {
        const token = String(req.params.token || '').trim();
        const b = req.body || {};
        if (!/^[a-f0-9]{16,}$/i.test(token)) return res.status(404).json({ error: 'Invalid link' });
        db.get(`SELECT * FROM onspot_links WHERE token = ?`, [token], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'This link is not valid.' });
            const state = linkState(row);
            if (state === 'expired') return res.status(410).json({ error: 'This link has expired. Ask the desk for a new one.' });
            if (state === 'paid') return res.status(409).json({ error: 'This registration is already paid.' });

            const person = row.user_id
                ? { userId: row.user_id }
                : {
                      firstName: String(b.firstName || row.first_name || '').trim(),
                      middleName: String(b.middleName || row.middle_name || '').trim(),
                      lastName: String(b.lastName || row.last_name || '').trim(),
                      email: String(b.email || row.email || '').trim().toLowerCase(),
                      phone: String(b.phone || row.phone || '').trim()
                  };
            if (!row.user_id && (!person.firstName || !person.lastName)) {
                return res.status(400).json({ error: 'First and last name are required' });
            }
            if (!row.user_id && !person.phone && !person.email) {
                return res.status(400).json({ error: 'Phone or email is required' });
            }

            const submitted = b.formData && typeof b.formData === 'object' && !Array.isArray(b.formData) ? b.formData : {};
            let extraFormData = {};

            const proceed = (userId) => {
                seminarCapacity.assertSeminarHasCapacity(db, row.seminar_id, (capErr, capBlock) => {
                    if (capErr) return res.status(500).json({ error: capErr.message });
                    // Private on-spot links are issued by staff: capacity is informational only.
                    const capacityNote = capBlock && capBlock.ok === false ? capBlock.error || 'Seminar is full' : null;
                    posOnspot.ensurePosRegistration(
                        db,
                        generateId,
                        {
                            userId,
                            seminarId: row.seminar_id,
                            actorId: row.created_by,
                            source: 'onspot_link',
                            firstName: person.firstName,
                            middleName: person.middleName,
                            lastName: person.lastName,
                            phone: person.phone,
                            email: person.email,
                            formData: extraFormData
                        },
                        (rErr, reg) => {
                            if (rErr) return res.status(500).json({ error: rErr.message });
                            db.run(
                                `UPDATE onspot_links SET user_id = ?, registration_id = ?, used_at = COALESCE(used_at, CURRENT_TIMESTAMP) WHERE id = ?`,
                                [userId, reg.registrationId, row.id],
                                () => {
                                    const alreadyPaid =
                                        reg.existing && ['completed', 'checked_in', 'e_ticket_issued'].includes(reg.status);
                                    const respond = (options) =>
                                        res.json({
                                            success: true,
                                            capacityNote,
                                            userId,
                                            registrationId: reg.registrationId,
                                            applicationNo: reg.applicationNo,
                                            alreadyPaid,
                                            status: reg.status,
                                            amount: row.amount != null ? Number(row.amount) : null,
                                            paymentOptions: options || []
                                        });
                                    if (alreadyPaid) {
                                        db.run(`UPDATE onspot_links SET paid_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], () =>
                                            respond([])
                                        );
                                        return;
                                    }
                                    if (reg.status !== 'approved_pending_payment') {
                                        return db.run(
                                            `UPDATE registrations SET status = 'approved_pending_payment' WHERE id = ? AND status NOT IN ('completed','checked_in','e_ticket_issued','certificate_issued')`,
                                            [reg.registrationId],
                                            () => listOptions(respond)
                                        );
                                    }
                                    listOptions(respond);
                                }
                            );
                        }
                    );
                });
            };

            const listOptions = (cb) => {
                if (typeof listDoctorPaymentOptions !== 'function') return cb([]);
                listDoctorPaymentOptions((e, opts) =>
                    cb(
                        e
                            ? []
                            : (opts || []).map((o) => ({
                                  id: o.id,
                                  label: o.label,
                                  type: o.type,
                                  gateway: o.gateway
                              }))
                    )
                );
            };

            const start = () => {
                if (row.user_id) return proceed(row.user_id);
                posOnspot.ensurePosUser(db, generateId, person, (uErr, u) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (u.isNewUser && u.tempPass && notifEngine && notifEngine.sendAccountWelcomeEmail) {
                        try {
                            notifEngine.sendAccountWelcomeEmail(
                                db,
                                { userId: u.userId, temporary_password: u.tempPass, sendWhatsapp: false },
                                () => {}
                            );
                        } catch (_) {}
                    }
                    proceed(u.userId);
                });
            };

            loadOnspotFormFields(row.seminar_id, (fErr, fields) => {
                if (fErr) return res.status(500).json({ error: fErr.message });
                const list = fields || [];
                list.forEach((f) => {
                    const v = dynamicFields.getFieldValue(submitted, f, false);
                    if (v !== '') extraFormData[f.key] = v.length > 2000 ? v.slice(0, 2000) : v;
                });
                const vErr = dynamicFields.validateDynamicForm(extraFormData, false, list, extraFormData.qual);
                if (vErr) return res.status(400).json({ error: vErr });
                start();
            });
        });
    });

    // --- Public: mark link paid once payment status confirms (called by the page) ---
    app.post('/api/onspot/:token/paid', (req, res) => {
        const token = String(req.params.token || '').trim();
        db.get(`SELECT id, registration_id FROM onspot_links WHERE token = ?`, [token], (err, row) => {
            if (err || !row || !row.registration_id) return res.json({ ok: false });
            db.get(
                `SELECT 1 AS ok FROM orders WHERE registration_id = ? AND status = 'success' LIMIT 1`,
                [row.registration_id],
                (e2, paid) => {
                    if (e2 || !paid) return res.json({ ok: false });
                    db.run(`UPDATE onspot_links SET paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?`, [row.id], () =>
                        res.json({ ok: true })
                    );
                }
            );
        });
    });
}

module.exports = { ensureOnspotLinkSchema, registerOnspotRoutes, linkState, LINK_TTL_MS };

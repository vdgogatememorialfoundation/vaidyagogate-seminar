/**
 * WhatsApp Flows — single data-exchange endpoint with an action dispatcher.
 *
 * Meta encrypts Flow requests with an AES-128-GCM key wrapped by our RSA public key
 * (https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint).
 * When no private key is configured (local testing / dry run) plain JSON is accepted.
 *
 * Adding a new Flow behaviour = add an entry to ACTIONS; no new route needed.
 */
const crypto = require('crypto');
const seminarDt = require('./seminar-datetime');
const seminarDays = require('./seminar-days');
const audience = require('./whatsapp-audience');

/* ------------------------------------------------------------ encryption */

function decryptRequest(body, privateKeyPem, passphrase) {
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body || {};
    if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) return null;
    const aesKey = crypto.privateDecrypt(
        {
            key: privateKeyPem,
            passphrase: passphrase || undefined,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        },
        Buffer.from(encrypted_aes_key, 'base64')
    );
    const flowData = Buffer.from(encrypted_flow_data, 'base64');
    const iv = Buffer.from(initial_vector, 'base64');
    const tagLen = 16;
    const cipherText = flowData.subarray(0, flowData.length - tagLen);
    const tag = flowData.subarray(flowData.length - tagLen);
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    return { data: JSON.parse(plain), aesKey, iv };
}

function encryptResponse(obj, aesKey, iv) {
    const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flipped);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return enc.toString('base64');
}

/* ---------------------------------------------------------------- helpers */

function q(db, sql, params) {
    return new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows || []))));
}
function one(db, sql, params) {
    return new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));
}
function run(db, sql, params) {
    return new Promise((res, rej) =>
        db.run(sql, params, function (e) {
            if (e) return rej(e);
            res({ lastID: this && this.lastID, changes: this && this.changes });
        })
    );
}

function digitsPhone(p) {
    return require('./whatsapp-service').normalizePhoneE164(p);
}

async function seminarSummary(db, sem) {
    const withDays = await new Promise((res) => seminarDays.attachDaysToSeminarRows(db, [sem], (e, out) => res((out && out[0]) || sem)));
    return {
        id: String(sem.id),
        title: sem.title,
        description: String(sem.description || '').slice(0, 300),
        schedule: seminarDt.formatSeminarSchedule(withDays, withDays.days),
        dates: seminarDt.seminarDateList(withDays, withDays.days),
        price: Number(sem.price) || 0,
        venue: sem.location_text || sem.location_url || '',
        days: (withDays.days || []).map((d) => ({ id: String(d.id), title: d.title, date: d.day_date }))
    };
}

/* ---------------------------------------------------------------- actions */

const ACTIONS = {
    /** Open seminars available for registration. */
    async list_seminars({ db }) {
        const rows = await q(
            db,
            `SELECT * FROM seminars WHERE IFNULL(is_active, 1) = 1 AND (registration_end IS NULL OR registration_end >= ?) ORDER BY event_date ASC LIMIT 20`,
            [new Date().toISOString()]
        );
        const seminars = [];
        for (const s of rows) seminars.push(await seminarSummary(db, s));
        return { seminars: seminars.map((s) => ({ id: s.id, title: s.title, description: s.schedule + (s.price ? ` · ₹${s.price}` : '') })), count: seminars.length };
    },

    /** Details for a selected seminar (dates, price, days). */
    async select_seminar({ db, data }) {
        const sem = await one(db, `SELECT * FROM seminars WHERE id = ?`, [parseInt(data.seminar_id, 10) || 0]);
        if (!sem) return { error: 'Seminar not found' };
        return { seminar: await seminarSummary(db, sem) };
    },

    /** Registration form definition (custom fields configured per seminar). */
    async registration_form({ db, data }) {
        const sem = await one(db, `SELECT id, title, price, custom_fields_schema, registration_form_json FROM seminars WHERE id = ?`, [parseInt(data.seminar_id, 10) || 0]);
        if (!sem) return { error: 'Seminar not found' };
        let fields = [];
        try {
            const raw = sem.registration_form_json || sem.custom_fields_schema;
            const parsed = raw ? JSON.parse(raw) : null;
            const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.fields) ? parsed.fields : [];
            fields = list.map((f) => ({ name: f.name || f.key || f.id, label: f.label || f.name, type: f.type || 'text', required: !!f.required }));
        } catch (_) {}
        return { seminar_id: String(sem.id), title: sem.title, price: Number(sem.price) || 0, fields };
    },

    /** Look up an existing user by phone/email. */
    async lookup_user({ db, data, session }) {
        const phone = digitsPhone(data.phone || session.phone);
        const email = String(data.email || '').trim().toLowerCase();
        const row = await one(
            db,
            `SELECT id, user_id_string, first_name, last_name, email, phone FROM users WHERE (? <> '' AND LOWER(email) = ?) OR (? <> '' AND (phone = ? OR phone LIKE ? OR whatsapp = ?)) ORDER BY id ASC LIMIT 1`,
            [email, email, phone, phone, '%' + phone.slice(-10), phone]
        );
        if (!row) return { found: false };
        return { found: true, user: { id: String(row.id), portal_id: row.user_id_string, first_name: row.first_name, last_name: row.last_name, email: row.email, phone: row.phone } };
    },

    /** Registrations for the current phone (or application number). */
    async lookup_registration({ db, data, session }) {
        const phone = digitsPhone(data.phone || session.phone);
        const appNo = String(data.application_no || '').replace(/\D/g, '');
        const rows = await q(
            db,
            `SELECT r.id, r.application_no, r.status, s.title, s.event_date,
                    EXISTS (SELECT 1 FROM orders o WHERE o.registration_id = r.id AND o.status = 'success') AS paid
             FROM registrations r JOIN users u ON u.id = r.user_id JOIN seminars s ON s.id = r.seminar_id
             WHERE (? <> '' AND r.application_no = ?) OR (? = '' AND ? <> '' AND (u.phone LIKE ? OR u.whatsapp LIKE ?))
             ORDER BY r.id DESC LIMIT 10`,
            [appNo, appNo, appNo, phone, '%' + phone.slice(-10), '%' + phone.slice(-10)]
        );
        return {
            registrations: rows.map((r) => ({
                id: String(r.id),
                application_no: r.application_no,
                seminar: r.title,
                status: String(r.status || '').replace(/_/g, ' '),
                paid: !!Number(r.paid)
            }))
        };
    },

    /** Create user (if needed) + registration. Reuses the standard registration row shape. */
    async submit_registration({ db, data, session, deps }) {
        const seminarId = parseInt(data.seminar_id, 10) || 0;
        const sem = await one(db, `SELECT * FROM seminars WHERE id = ?`, [seminarId]);
        if (!sem) return { error: 'Seminar not found' };
        const phone = digitsPhone(data.phone || session.phone);
        const email = String(data.email || '').trim().toLowerCase();
        const first = String(data.first_name || '').trim();
        const last = String(data.last_name || '').trim();
        if (!phone || !email || !first || !last) return { error: 'Name, email and phone are required' };
        let user = await one(db, `SELECT id, user_id_string FROM users WHERE LOWER(email) = ? LIMIT 1`, [email]);
        if (!user) {
            const uid = deps.generateId();
            const pw = crypto.randomBytes(6).toString('base64url');
            const ins = await run(
                db,
                `INSERT INTO users (user_id_string, first_name, last_name, email, phone, whatsapp, password, role, user_role, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, 'doctor', 'doctor', 0)`,
                [uid, first, last, email, phone, phone, pw]
            );
            user = { id: ins.lastID, user_id_string: uid };
            if (!user.id) user = await one(db, `SELECT id, user_id_string FROM users WHERE LOWER(email) = ? LIMIT 1`, [email]);
        }
        const existing = await one(
            db,
            `SELECT id, application_no, status FROM registrations WHERE user_id = ? AND seminar_id = ? AND status NOT IN ('cancelled','refunded','rejected') ORDER BY id DESC LIMIT 1`,
            [user.id, seminarId]
        );
        if (existing) {
            return { ok: true, already_registered: true, registration_id: String(existing.id), application_no: existing.application_no, status: existing.status };
        }
        const appNo = deps.generateId();
        const autoApprove = Number(sem.auto_confirm_registration) === 1;
        const formData = {};
        Object.keys(data || {}).forEach((k) => {
            if (!['seminar_id', 'flow_token', 'action', 'phone', 'email', 'first_name', 'last_name'].includes(k)) formData[k] = data[k];
        });
        formData.source = 'whatsapp_flow';
        const ins = await run(
            db,
            `INSERT INTO registrations (user_id, seminar_id, application_no, status, form_data, registration_source) VALUES (?, ?, ?, ?, ?, 'whatsapp_flow')`,
            [user.id, seminarId, appNo, autoApprove ? 'approved_pending_payment' : 'pending_approval', JSON.stringify(formData)]
        );
        const regId = ins.lastID || (await one(db, `SELECT id FROM registrations WHERE application_no = ?`, [appNo])).id;
        await run(db, `UPDATE wa_flow_sessions SET user_id = ?, registration_id = ?, seminar_id = ? WHERE flow_token = ?`, [user.id, regId, seminarId, session.flow_token || '']);
        const reg = { id: regId, application_no: appNo, user_id_string: user.user_id_string };
        return {
            ok: true,
            registration_id: String(regId),
            application_no: appNo,
            status: autoApprove ? 'approved_pending_payment' : 'pending_approval',
            amount: Number(sem.price) || 0,
            payment_link: autoApprove ? audience.paymentLink(reg) : ''
        };
    },

    /** Create/reuse pending order and return the hosted payment link. */
    async create_order({ db, data, deps }) {
        const regId = parseInt(data.registration_id, 10) || 0;
        const reg = await one(
            db,
            `SELECT r.id, r.application_no, r.status, r.user_id, u.user_id_string, s.price FROM registrations r JOIN users u ON u.id = r.user_id JOIN seminars s ON s.id = r.seminar_id WHERE r.id = ?`,
            [regId]
        );
        if (!reg) return { error: 'Registration not found' };
        const paid = await one(db, `SELECT id FROM orders WHERE registration_id = ? AND status = 'success' LIMIT 1`, [regId]);
        if (paid) return { ok: true, already_paid: true };
        const order = await new Promise((res, rej) => deps.getOrCreatePendingOrder(regId, Number(reg.price) || undefined, (e, o) => (e ? rej(e) : res(o))));
        return { ok: true, order_id: order && order.order_id_string, amount: order && order.amount, payment_link: audience.paymentLink(reg) };
    },

    async registration_status({ db, data }) {
        const regId = parseInt(data.registration_id, 10) || 0;
        const appNo = String(data.application_no || '').replace(/\D/g, '');
        const r = await one(
            db,
            `SELECT r.id, r.application_no, r.status, s.title,
                    EXISTS (SELECT 1 FROM orders o WHERE o.registration_id = r.id AND o.status = 'success') AS paid
             FROM registrations r JOIN seminars s ON s.id = r.seminar_id WHERE (? > 0 AND r.id = ?) OR (? <> '' AND r.application_no = ?) LIMIT 1`,
            [regId, regId, appNo, appNo]
        );
        if (!r) return { error: 'Registration not found' };
        return { registration_id: String(r.id), application_no: r.application_no, seminar: r.title, status: String(r.status || '').replace(/_/g, ' '), paid: !!Number(r.paid) };
    },

    async eticket_status({ db, data }) {
        const regId = parseInt(data.registration_id, 10) || 0;
        const rows = await q(
            db,
            `SELECT t.ticket_id_string, t.is_scanned, t.user_id, sd.title AS day_title, sd.day_date
             FROM tickets t JOIN orders o ON o.id = t.order_id LEFT JOIN seminar_days sd ON sd.id = t.day_id
             WHERE o.registration_id = ? AND IFNULL(t.is_valid, 1) = 1 ORDER BY sd.sort_order, t.id`,
            [regId]
        );
        return {
            issued: rows.length > 0,
            tickets: rows.map((t) => ({
                ticket_id: t.ticket_id_string,
                day: t.day_title || '',
                date: t.day_date || '',
                scanned: !!Number(t.is_scanned),
                link: t.ticket_id_string ? audience.ticketLink(t.ticket_id_string, t.user_id) : ''
            }))
        };
    },

    async ping() {
        return { status: 'active' };
    }
};

/**
 * Dispatch one Flow request (already decrypted). Meta shape:
 * { version, action: 'ping'|'INIT'|'data_exchange'|'BACK', screen, data, flow_token }
 * Our action name comes from data.action (or the screen name when omitted).
 */
async function dispatch(db, req, deps) {
    if (req.action === 'ping') return { data: { status: 'active' } };
    const flowToken = String(req.flow_token || '');
    const data = req.data || {};
    const actionName = String(data.action || (req.action === 'INIT' ? 'list_seminars' : req.screen || '')).toLowerCase();
    const session = (await one(db, `SELECT * FROM wa_flow_sessions WHERE flow_token = ?`, [flowToken])) || { flow_token: flowToken, phone: '' };
    if (!session.id && flowToken) {
        await run(db, `INSERT INTO wa_flow_sessions (flow_token, last_screen, last_action, data_json) VALUES (?, ?, ?, '{}')`, [flowToken, req.screen || null, actionName]);
    }
    const handler = ACTIONS[actionName];
    let out;
    if (!handler) out = { error: 'Unknown action: ' + actionName, available: Object.keys(ACTIONS) };
    else {
        try {
            out = await handler({ db, data, session, deps, req });
        } catch (e) {
            out = { error: e.message };
        }
    }
    if (flowToken) {
        let merged = {};
        try {
            merged = JSON.parse(session.data_json || '{}') || {};
        } catch (_) {}
        Object.assign(merged, data, { _last: out });
        await run(db, `UPDATE wa_flow_sessions SET last_screen = ?, last_action = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE flow_token = ?`, [
            req.screen || session.last_screen || null,
            actionName,
            JSON.stringify(merged).slice(0, 20000),
            flowToken
        ]);
    }
    const nextScreen = data.next_screen || req.screen || 'RESULT';
    return { screen: out && out.error ? data.error_screen || nextScreen : nextScreen, data: out };
}

/** Express handler for POST /api/whatsapp/flow/data-exchange */
function makeEndpoint(db, deps, loadSettings) {
    return (req, res) => {
        loadSettings(db, async (e, settings) => {
            const pem = String((settings && settings.flow_private_key) || process.env.WHATSAPP_FLOW_PRIVATE_KEY || '').trim();
            const body = req.body || {};
            let decrypted = null;
            if (body.encrypted_aes_key) {
                if (!pem) return res.status(421).send('Flow private key not configured');
                try {
                    decrypted = decryptRequest(body, pem, settings && settings.flow_private_key_passphrase);
                } catch (err) {
                    console.warn('[wa-flow] decrypt failed', err.message);
                    return res.status(421).send('Decryption failed');
                }
            }
            const payload = decrypted ? decrypted.data : body;
            let response;
            try {
                response = await dispatch(db, payload, deps);
            } catch (err) {
                console.warn('[wa-flow] dispatch', err.message);
                response = { screen: 'ERROR', data: { error: 'Server error' } };
            }
            if (decrypted) {
                res.type('text/plain').send(encryptResponse(response, decrypted.aesKey, decrypted.iv));
            } else {
                res.json(response);
            }
        });
    };
}

module.exports = { ACTIONS, dispatch, makeEndpoint, decryptRequest, encryptResponse, actionNames: () => Object.keys(ACTIONS) };

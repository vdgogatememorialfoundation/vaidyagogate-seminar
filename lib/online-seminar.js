/**
 * Online or venue seminars, outside meeting accounts, and the private VGMF Hall.
 * Join links and passcodes are not copied onto the public seminar list.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const providers = require('./online-seminar-providers');
const hall = require('./vgmf-hall');

const SETTINGS_KEY = 'online_seminar_secrets';
const HMAC_KEY = 'online_seminar_hmac';
const ELIGIBLE = new Set(['e_ticket_issued', 'checked_in', 'completed', 'certificate_issued', 'attended']);
const BLOCKED_REG = new Set(['draft', 'rejected', 'cancelled', 'canceled', 'refunded', 'declined', 'failed']);
const joinHits = new Map();

function dbGet(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row || null)));
    });
}

function dbAll(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params || [], function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function ensureSchema(db, cb) {
    const statements = [
        `CREATE TABLE IF NOT EXISTS online_seminar_meetings (
            seminar_id INTEGER PRIMARY KEY,
            delivery_mode TEXT,
            provider TEXT,
            external_id TEXT,
            join_url TEXT,
            host_url TEXT,
            passcode TEXT,
            waiting_room INTEGER DEFAULT 0,
            status TEXT,
            warning TEXT,
            provider_payload TEXT,
            banned_json TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS online_seminar_attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER,
            user_id INTEGER,
            role TEXT,
            joined_at TEXT,
            left_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS online_seminar_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            user_id INTEGER,
            invited_by INTEGER,
            created_at TEXT
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_online_seminar_invites_email ON online_seminar_invites (seminar_id, email)`,
        `CREATE TABLE IF NOT EXISTS online_seminar_recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seminar_id INTEGER NOT NULL,
            provider TEXT,
            title TEXT,
            file_name TEXT,
            bytes INTEGER DEFAULT 0,
            status TEXT,
            started_at TEXT,
            ended_at TEXT,
            created_by INTEGER
        )`
    ];
    let i = 0;
    const next = () => {
        if (i >= statements.length) return cb && cb();
        db.run(statements[i++], [], (err) => {
            if (err && !/already exists|duplicate column/i.test(String(err.message || ''))) {
                console.warn('[online-seminar] schema:', err.message);
            }
            next();
        });
    };
    next();
}

async function hmacSecret(db) {
    const row = await dbGet(db, `SELECT value FROM global_settings WHERE key = ?`, [HMAC_KEY]);
    if (row && row.value) return String(row.value);
    const secret = crypto.randomBytes(32).toString('base64url');
    const updated = await dbRun(db, `UPDATE global_settings SET value = ? WHERE key = ?`, [secret, HMAC_KEY]);
    if (!updated || !updated.changes) {
        try {
            await dbRun(db, `INSERT INTO global_settings (key, value) VALUES (?, ?)`, [HMAC_KEY, secret]);
        } catch (err) {
            const again = await dbGet(db, `SELECT value FROM global_settings WHERE key = ?`, [HMAC_KEY]);
            if (again && again.value) return String(again.value);
            throw err;
        }
    }
    return secret;
}

function signPayload(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function readPayload(token, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[1]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (!payload || !payload.exp || Number(payload.exp) < Date.now()) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

async function loadSettings(db) {
    const row = await dbGet(db, `SELECT value FROM global_settings WHERE key = ?`, [SETTINGS_KEY]);
    if (!row || !row.value) return providers.emptySettings();
    try {
        return providers.normalizeSettings(JSON.parse(row.value));
    } catch (_) {
        return providers.emptySettings();
    }
}

async function saveSettings(db, incoming) {
    const existing = await loadSettings(db);
    const next = providers.mergeSettings(existing, incoming);
    const json = JSON.stringify(next);
    const updated = await dbRun(db, `UPDATE global_settings SET value = ? WHERE key = ?`, [json, SETTINGS_KEY]);
    if (!updated || !updated.changes) {
        await dbRun(db, `INSERT INTO global_settings (key, value) VALUES (?, ?)`, [SETTINGS_KEY, json]);
    }
    return next;
}

function publicSummary(row) {
    if (!row || String(row.delivery_mode || 'offline') !== 'online') {
        return { delivery_mode: 'offline', provider: null, provider_label: 'At the venue', status: 'offline' };
    }
    const provider = providers.PROVIDERS.includes(row.provider) ? row.provider : 'vgmf';
    return {
        delivery_mode: 'online',
        provider,
        provider_label: providers.providerLabel(provider),
        status: row.status || 'scheduled',
        waiting_room: Number(row.waiting_room) === 1
    };
}

function attachPublicSummary(db, rows, cb) {
    const list = rows || [];
    const ids = list.map((r) => parseInt(r && r.id, 10)).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return cb(null, list);
    const sql = `SELECT seminar_id, delivery_mode, provider, waiting_room, status FROM online_seminar_meetings WHERE seminar_id IN (${ids
        .map(() => '?')
        .join(',')})`;
    db.all(sql, ids, (err, found) => {
        const map = new Map();
        if (!err) (found || []).forEach((row) => map.set(Number(row.seminar_id), row));
        list.forEach((row) => {
            if (!row) return;
            row.online_seminar = publicSummary(map.get(Number(row.id)));
        });
        cb(null, list);
    });
}

function meetingView(row, opts) {
    const admin = opts && opts.admin;
    const summary = publicSummary(row);
    if (!admin) return summary;
    const stored = String((row && (row.join_url || row.host_url)) || '');
    return {
        ...summary,
        external_id: (row && row.external_id) || '',
        private_link: !!stored && !stored.startsWith('/hall/'),
        passcode: (row && row.passcode) || '',
        waiting_room: !!(row && Number(row.waiting_room) === 1),
        warning: (row && row.warning) || '',
        use_manual_link: !!(row && row.provider_payload && String(row.provider_payload).includes('"manual":true'))
    };
}

async function defaultHttp(url, opts) {
    const res = await fetch(url, opts || {});
    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (_) {
        json = null;
    }
    return { status: res.status, json, text };
}

function flag(v) {
    return v === true || v === 1 || v === '1';
}

async function persistAsync(db, seminarId, body) {
    const sid = parseInt(seminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) throw new Error('Invalid seminar');
    const src = body && body.online_seminar && typeof body.online_seminar === 'object' ? Object.assign({}, body, body.online_seminar) : body || {};
    if (src.delivery_mode == null && src.meeting_provider == null) return null;
    const seminar = await dbGet(
        db,
        `SELECT id, title, description, event_date, event_end_date, price FROM seminars WHERE id = ?`,
        [sid]
    );
    if (!seminar) throw new Error('Seminar not found');
    const delivery = String(src.delivery_mode || 'offline') === 'online' ? 'online' : 'offline';
    const provider = delivery === 'online' && providers.PROVIDERS.includes(src.meeting_provider) ? src.meeting_provider : delivery === 'online' ? 'vgmf' : '';
    const existing = await dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [sid]);
    let result = {
        externalId: '',
        joinUrl: '',
        hostUrl: '',
        passcode: String(src.meeting_passcode || '').trim(),
        warning: '',
        payload: { provider: provider || 'offline' }
    };
    if (delivery === 'online') {
        const settings = await loadSettings(db);
        result = await providers.provisionMeeting({
            provider,
            settings,
            seminar,
            existing: existing
                ? { external_id: existing.external_id, join_url: existing.join_url, host_url: existing.host_url }
                : null,
            manual: {
                use: flag(src.use_manual_link),
                joinUrl: src.meeting_join_url,
                hostUrl: src.meeting_host_url,
                passcode: src.meeting_passcode
            },
            http: defaultHttp
        });
        if (src.meeting_passcode != null && String(src.meeting_passcode).trim()) {
            result.passcode = String(src.meeting_passcode).trim();
        }
    }
    const waiting = delivery === 'online' && provider === 'vgmf' && flag(src.meeting_waiting_room) ? 1 : 0;
    const now = new Date().toISOString();
    const params = [
        delivery,
        provider || null,
        result.externalId || null,
        result.joinUrl || null,
        result.hostUrl || null,
        result.passcode || null,
        waiting,
        delivery === 'online' ? 'scheduled' : 'offline',
        result.warning || null,
        JSON.stringify(result.payload || {}),
        now,
        sid
    ];
    if (existing) {
        await dbRun(
            db,
            `UPDATE online_seminar_meetings
             SET delivery_mode=?, provider=?, external_id=?, join_url=?, host_url=?, passcode=?, waiting_room=?, status=?, warning=?, provider_payload=?, updated_at=?
             WHERE seminar_id=?`,
            params
        );
    } else {
        await dbRun(
            db,
            `INSERT INTO online_seminar_meetings
             (delivery_mode, provider, external_id, join_url, host_url, passcode, waiting_room, status, warning, provider_payload, updated_at, seminar_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params
        );
    }
    return {
        warning: result.warning || '',
        meeting: meetingView(
            {
                delivery_mode: delivery,
                provider,
                external_id: result.externalId,
                join_url: result.joinUrl,
                host_url: result.hostUrl,
                passcode: result.passcode,
                waiting_room: waiting,
                status: delivery === 'online' ? 'scheduled' : 'offline',
                warning: result.warning,
                provider_payload: JSON.stringify(result.payload || {})
            },
            { admin: true }
        )
    };
}

function persistFromSeminarBody(db, seminarId, body, cb) {
    ensureSchema(db, () => {
        persistAsync(db, seminarId, body)
            .then((out) => cb(null, out))
            .catch((err) => cb(err));
    });
}

function personName(row) {
    const name = [row && row.first_name, row && row.last_name].filter(Boolean).join(' ').trim();
    return name || 'Doctor';
}

function allowJoinAttempt(ip) {
    const key = String(ip || 'unknown').slice(0, 80);
    const now = Date.now();
    let bucket = joinHits.get(key);
    if (!bucket || now - bucket.start > 60000) bucket = { start: now, n: 0 };
    bucket.n += 1;
    joinHits.set(key, bucket);
    return bucket.n <= 40;
}

async function loadUser(db, userId, userIdString) {
    const id = parseInt(userId, 10);
    if (!Number.isInteger(id) || id < 1) return null;
    const row = await dbGet(
        db,
        `SELECT id, user_id_string, first_name, last_name, email, role, user_role FROM users WHERE id = ?`,
        [id]
    );
    if (!row) return null;
    if (userIdString != null && String(userIdString).trim() && String(row.user_id_string || '') !== String(userIdString).trim()) {
        return null;
    }
    return row;
}

function isStaffHost(row) {
    const role = String((row && row.role) || '').toLowerCase();
    const ur = String((row && row.user_role) || '').toLowerCase();
    return role === 'admin' || ur === 'co_admin' || ur === 'admin';
}

function accountEmail(user) {
    const email = String((user && user.email) || '').trim().toLowerCase();
    return email.indexOf('@') > 0 ? email : '';
}

function isDoctorAccount(row) {
    const role = String((row && row.role) || '').toLowerCase();
    const ur = String((row && row.user_role) || '').toLowerCase();
    return role === 'doctor' || ur === 'doctor';
}

async function eligibility(db, seminar, user) {
    if (isStaffHost(user)) return { ok: true, role: 'host', reason: 'staff' };
    const email = accountEmail(user);
    if (!email) {
        return { ok: false, role: '', reason: 'email', error: 'This account needs the email used on the registration.' };
    }
    const invite = await dbGet(
        db,
        `SELECT id FROM online_seminar_invites WHERE seminar_id = ? AND email = ?`,
        [seminar.id, email]
    );
    if (invite) return { ok: true, role: 'audience', reason: 'staff_invite' };
    const reg = await dbGet(
        db,
        `SELECT status FROM registrations WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
        [user.id, seminar.id]
    );
    const status = String((reg && reg.status) || '').toLowerCase();
    const free = Number(seminar.price || 0) === 0;
    if (reg && !BLOCKED_REG.has(status) && (free || ELIGIBLE.has(status))) {
        return { ok: true, role: 'audience', reason: free ? 'free' : status };
    }
    let vol = null;
    try {
        vol = await dbGet(
            db,
            `SELECT status FROM seminar_volunteers WHERE user_id = ? AND seminar_id = ? ORDER BY id DESC LIMIT 1`,
            [user.id, seminar.id]
        );
    } catch (_) {
        vol = null;
    }
    if (vol && String(vol.status || '').toLowerCase() === 'approved') return { ok: true, role: 'audience', reason: 'volunteer' };
    return {
        ok: false,
        role: '',
        reason: status || 'none',
        error: free
            ? 'Only a registered email can join this online seminar.'
            : 'Only a registered email with a completed registration can join. Invited staff attend free.'
    };
}

function joinWindow(seminar, settings, now) {
    const early = settings && settings.hall ? settings.hall.joinEarlyMinutes : 30;
    const start = require('./seminar-datetime').parseSeminarMs(seminar.event_date);
    if (start == null) return { open: true };
    const end = require('./seminar-datetime').parseSeminarMs(seminar.event_end_date) || start + 6 * 3600000;
    const opens = start - early * 60000;
    const closes = end + 2 * 3600000;
    const at = now || Date.now();
    if (at < opens) return { open: false, tooEarly: true, opensAt: new Date(opens).toISOString() };
    if (at > closes) return { open: false, closed: true };
    return { open: true, opensAt: new Date(opens).toISOString() };
}

function bannedSet(row) {
    try {
        const list = JSON.parse((row && row.banned_json) || '[]');
        return new Set((Array.isArray(list) ? list : []).map((n) => Number(n)).filter((n) => n > 0));
    } catch (_) {
        return new Set();
    }
}

async function issueJoin(db, opts) {
    const seminarId = parseInt(opts.seminarId, 10);
    if (!Number.isInteger(seminarId) || seminarId < 1) {
        return { status: 400, body: { ok: false, error: 'Choose an online seminar.' } };
    }
    const seminar = await dbGet(db, `SELECT * FROM seminars WHERE id = ?`, [seminarId]);
    if (!seminar) return { status: 404, body: { ok: false, error: 'Seminar not found.' } };
    const meeting = await dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [seminar.id]);
    const summary = publicSummary(meeting);
    if (summary.delivery_mode !== 'online') {
        return { status: 400, body: { ok: false, error: 'This seminar is held at the venue.' } };
    }
    let user = opts.admin || (await loadUser(db, opts.userId, opts.userIdString));
    if (user && !user.first_name) {
        const named = await loadUser(db, user.id, null);
        if (named) user = Object.assign({}, user, named);
    }
    if (!user) return { status: 403, body: { ok: false, error: 'Sign in again from the doctor portal.' } };
    const gate = await eligibility(db, seminar, user);
    if (!gate.ok) {
        return { status: 403, body: { ok: false, error: gate.error || 'Only a registered email can join this online seminar.' } };
    }
    if (bannedSet(meeting).has(Number(user.id)) && gate.role !== 'host') {
        return { status: 403, body: { ok: false, error: 'You were removed from this hall.' } };
    }
    const settings = await loadSettings(db);
    if (gate.role !== 'host') {
        const window = joinWindow(seminar, settings, opts.now);
        if (!window.open) {
            return {
                status: 403,
                body: {
                    ok: false,
                    error: window.tooEarly
                        ? 'The online seminar opens shortly before the start. Please come back then.'
                        : 'This online seminar is no longer open.',
                    opensAt: window.opensAt || null
                }
            };
        }
        const pass = String((meeting && meeting.passcode) || '').trim();
        if (pass && String(opts.passcode || '').trim() !== pass) {
            return { status: 401, body: { ok: false, needsPasscode: true, error: 'Enter the seminar passcode.' } };
        }
    }
    const role = gate.role === 'host' ? 'host' : 'audience';
    const secret = await hmacSecret(db);
    const token = signPayload(
        {
            kind: 'hall',
            sid: seminar.id,
            uid: user.id,
            role,
            name: personName(user).slice(0, 80),
            exp: Date.now() + 4 * 3600000
        },
        secret
    );
    const provider = summary.provider;
    if (provider === 'vgmf') {
        return {
            status: 200,
            token,
            body: {
                ok: true,
                mode: 'hall',
                role,
                token,
                url: `/hall/${seminar.id}`,
                title: seminar.title || '',
                provider,
                provider_label: summary.provider_label
            }
        };
    }
    const stored = role === 'host' ? (meeting && (meeting.host_url || meeting.join_url)) || '' : (meeting && meeting.join_url) || '';
    if (!stored) {
        return {
            status: 409,
            body: {
                ok: false,
                error: (meeting && meeting.warning) || `${summary.provider_label} is not ready for registered emails yet.`
            }
        };
    }
    const enter = signPayload({ kind: 'enter', sid: seminar.id, uid: user.id, role, exp: Date.now() + 2 * 60000 }, secret);
    return {
        status: 200,
        token: null,
        body: {
            ok: true,
            mode: 'gate',
            role,
            url: `/api/online-seminar/enter?token=${encodeURIComponent(enter)}`,
            title: seminar.title || '',
            provider,
            provider_label: summary.provider_label
        }
    };
}

function oauthRedirect(req) {
    const env = process.env.PUBLIC_BASE_URL || process.env.SITE_URL;
    const base = env
        ? String(env).replace(/\/$/, '')
        : `${(req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim()}://${req.headers['x-forwarded-host'] || req.get('host')}`;
    return `${base}/api/public/online-seminar/oauth/callback`;
}

function setHallCookie(req, res, token) {
    if (!token) return;
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
    res.setHeader(
        'Set-Cookie',
        `vgmf_hall=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=14400${secure ? '; Secure' : ''}`
    );
}

function readHallCookie(req) {
    const raw = String((req.headers && req.headers.cookie) || '');
    const match = raw.match(/(?:^|;\s*)vgmf_hall=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

const rooms = new Map();

function getRoom(seminarId, meeting, settings) {
    const id = Number(seminarId);
    if (!rooms.has(id)) {
        const banned = [];
        bannedSet(meeting).forEach((n) => banned.push(n));
        rooms.set(
            id,
            hall.createRoom(id, {
                waitingRoom: !!(meeting && Number(meeting.waiting_room) === 1),
                maxDirect: settings && settings.hall ? settings.hall.maxDirectViewers : 12,
                banned
            })
        );
    }
    return rooms.get(id);
}

function recordingsDir() {
    return path.join(__dirname, '..', 'uploads', 'online-recordings');
}

function safeRecordingName(name) {
    const base = path.basename(String(name || ''));
    return /^(rec|pull)-\d+\.(webm|mp4)$/.test(base) ? base : '';
}

function beginRecording(db, room, userId) {
    if (room.recording) finishRecording(db, room);
    const rec = { id: null, stream: null, bytes: 0, chunks: [], name: '' };
    room.recording = rec;
    rec.ready = dbRun(
        db,
        `INSERT INTO online_seminar_recordings (seminar_id, provider, title, file_name, bytes, status, started_at, created_by) VALUES (?, 'vgmf', '', '', 0, 'recording', ?, ?)`,
        [room.seminarId, new Date().toISOString(), userId || null]
    )
        .then((result) => {
            const id = result && (result.lastID || result.lastId);
            if (!id || room.recording !== rec) return null;
            rec.id = id;
            rec.name = `rec-${id}.webm`;
            fs.mkdirSync(recordingsDir(), { recursive: true });
            rec.stream = fs.createWriteStream(path.join(recordingsDir(), rec.name));
            rec.chunks.forEach((buf) => {
                rec.bytes += buf.length;
                rec.stream.write(buf);
            });
            rec.chunks = [];
            return dbRun(db, `UPDATE online_seminar_recordings SET file_name = ? WHERE id = ?`, [rec.name, id]);
        })
        .catch((err) => {
            console.warn('[online-seminar] record:', err.message);
        });
    return rec.ready;
}

function appendRecording(room, buf) {
    const rec = room.recording;
    if (!rec || !Buffer.isBuffer(buf) || !buf.length) return;
    if (rec.stream) {
        rec.bytes += buf.length;
        rec.stream.write(buf);
        return;
    }
    rec.chunks.push(buf);
    let total = 0;
    rec.chunks.forEach((part) => {
        total += part.length;
    });
    while (total > 20 * 1024 * 1024 && rec.chunks.length) {
        total -= rec.chunks[0].length;
        rec.chunks.shift();
    }
}

function finishRecording(db, room) {
    const rec = room.recording;
    if (!rec) return Promise.resolve();
    room.recording = null;
    const ended = new Date().toISOString();
    const closed = new Promise((resolve) => {
        if (!rec.stream) return resolve();
        rec.stream.end(() => resolve());
    });
    return Promise.resolve(rec.ready)
        .then(() => closed)
        .then(() => {
            if (!rec.id) return null;
            return dbRun(
                db,
                `UPDATE online_seminar_recordings SET status = ?, bytes = ?, ended_at = ?, file_name = ? WHERE id = ?`,
                ['ready', rec.bytes, ended, rec.name || '', rec.id]
            );
        })
        .catch((err) => {
            console.warn('[online-seminar] record finish:', err.message);
        });
}

async function saveProviderRecording(db, seminar, meeting, settings) {
    const provider = String(meeting.provider || '');
    const located = await providers.recordingLocator(provider, settings, meeting.external_id, defaultHttp);
    const inserted = await dbRun(
        db,
        `INSERT INTO online_seminar_recordings (seminar_id, provider, title, file_name, bytes, status, started_at, created_by) VALUES (?, ?, ?, '', 0, 'saving', ?, ?)`,
        [seminar.id, provider, seminar.title || '', new Date().toISOString(), null]
    );
    const id = inserted && (inserted.lastID || inserted.lastId);
    if (!id) throw new Error('Could not save the recording.');
    const name = `pull-${id}.${located.ext === 'mp4' ? 'mp4' : 'webm'}`;
    fs.mkdirSync(recordingsDir(), { recursive: true });
    const dest = path.join(recordingsDir(), name);
    const res = await fetch(located.downloadUrl, { headers: located.headers || {} });
    if (!res.ok || !res.body) {
        await dbRun(db, `UPDATE online_seminar_recordings SET status = ? WHERE id = ?`, ['failed', id]);
        throw new Error('The account did not return a recording file.');
    }
    const { pipeline } = require('stream/promises');
    const { Readable } = require('stream');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    const bytes = fs.statSync(dest).size;
    await dbRun(
        db,
        `UPDATE online_seminar_recordings SET status = ?, bytes = ?, ended_at = ?, file_name = ? WHERE id = ?`,
        ['ready', bytes, new Date().toISOString(), name, id]
    );
    return { id, bytes };
}

function registerOnlineSeminarRoutes(app, deps) {
    const db = deps.db;
    const assertAdmin = deps.assertAdminPortalActor;
    const publicDir = deps.publicDir;

    function withAdmin(req, res, next) {
        const aid = parseInt((req.query && req.query.actingAdminId) || (req.body && req.body.actingAdminId) || '', 10);
        if (!Number.isInteger(aid) || aid < 1) return res.status(400).json({ error: 'actingAdminId is required' });
        assertAdmin(aid, (err, adm) => {
            if (err || !adm) return res.status(403).json({ error: 'Admin access required' });
            req.onlineAdmin = adm;
            next();
        });
    }

    app.get(['/hall/:seminarId', '/hall/:seminarId/'], (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(publicDir, 'hall.html'));
    });

    app.get('/api/admin/online-seminar/settings', (req, res) => {
        withAdmin(req, res, () => {
            loadSettings(db)
                .then((settings) => {
                    res.json({
                        ok: true,
                        settings: providers.maskSettings(settings),
                        oauthRedirect: oauthRedirect(req),
                        providers: providers.PROVIDERS.map((id) => ({ id, label: providers.providerLabel(id) }))
                    });
                })
                .catch((err) => res.status(500).json({ error: 'Could not load online seminar settings.' }));
        });
    });

    app.post('/api/admin/online-seminar/settings', (req, res) => {
        withAdmin(req, res, () => {
            saveSettings(db, req.body && req.body.settings)
                .then((settings) => res.json({ ok: true, settings: providers.maskSettings(settings) }))
                .catch(() => res.status(500).json({ error: 'Could not save online seminar settings.' }));
        });
    });

    app.post('/api/admin/online-seminar/test', (req, res) => {
        withAdmin(req, res, () => {
            const provider = String((req.body && req.body.provider) || '');
            loadSettings(db)
                .then((settings) => providers.testConnection(provider, settings, defaultHttp))
                .then((out) => res.json(out))
                .catch((err) => res.status(400).json({ ok: false, error: err.message || 'Connection test failed.' }));
        });
    });

    app.get('/api/admin/online-seminar/oauth/start', (req, res) => {
        withAdmin(req, res, () => {
            const provider = String(req.query.provider || '');
            if (!['google', 'zoho_webinar', 'zoho_backstage'].includes(provider)) {
                return res.status(400).send('Unknown connection.');
            }
            Promise.all([loadSettings(db), hmacSecret(db)])
                .then(([settings, secret]) => {
                    const state = signPayload(
                        { kind: 'oauth', provider, adminId: req.onlineAdmin.id, exp: Date.now() + 10 * 60000 },
                        secret
                    );
                    res.redirect(providers.oauthStartUrl(provider, settings, oauthRedirect(req), state));
                })
                .catch(() => res.status(500).send('Could not start the connection.'));
        });
    });

    app.get('/api/public/online-seminar/oauth/callback', (req, res) => {
        const code = String(req.query.code || '');
        const state = String(req.query.state || '');
        if (!code || !state) return res.status(400).send('Missing authorization code.');
        hmacSecret(db)
            .then(async (secret) => {
                const payload = readPayload(state, secret);
                if (!payload || payload.kind !== 'oauth') throw new Error('This connection link has expired. Start it again from the office console.');
                const settings = await loadSettings(db);
                const exchanged = await providers.exchangeOAuthCode(payload.provider, settings, code, oauthRedirect(req), defaultHttp);
                if (!exchanged.refreshToken) throw new Error('The account did not return a refresh token. Connect again and accept every permission.');
                const patch = {};
                if (payload.provider === 'google') patch.google = { refreshToken: exchanged.refreshToken };
                if (payload.provider === 'zoho_webinar') patch.zohoWebinar = { refreshToken: exchanged.refreshToken };
                if (payload.provider === 'zoho_backstage') patch.zohoBackstage = { refreshToken: exchanged.refreshToken };
                await saveSettings(db, patch);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.send(
                    '<!DOCTYPE html><html><body style="font-family:Georgia,serif;padding:40px;background:#f8fafc;color:#0f172a;"><h1>Account connected</h1><p>You can close this tab and return to Online seminar connections.</p></body></html>'
                );
            })
            .catch((err) => res.status(400).send(err.message || 'Connection failed.'));
    });

    app.get('/api/admin/online-seminar/meetings/:seminarId', (req, res) => {
        withAdmin(req, res, () => {
            const sid = parseInt(req.params.seminarId, 10);
            dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [sid])
                .then((row) => res.json({ ok: true, meeting: meetingView(row, { admin: true }) }))
                .catch(() => res.status(500).json({ error: 'Could not load the online seminar.' }));
        });
    });

    app.get('/api/online-seminar/enter', (req, res) => {
        const token = String(req.query.token || '');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        hmacSecret(db)
            .then(async (secret) => {
                const payload = readPayload(token, secret);
                if (!payload || payload.kind !== 'enter') throw new Error('This entry has expired. Join again from the portal.');
                const user = await loadUser(db, payload.uid, null);
                const meeting = await dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [payload.sid]);
                if (!user || !meeting || meeting.delivery_mode !== 'online') throw new Error('This online seminar is not open.');
                let dest = '';
                if (meeting.provider === 'zoom' && meeting.external_id) {
                    try {
                        const settings = await loadSettings(db);
                        dest = await providers.zoomRegistrantJoin(settings, meeting.external_id, user, defaultHttp);
                    } catch (_) {
                        dest = '';
                    }
                }
                if (!dest) {
                    dest = payload.role === 'host' ? meeting.host_url || meeting.join_url || '' : meeting.join_url || '';
                }
                if (!/^https?:\/\//i.test(dest)) throw new Error('This meeting is not ready for that email yet.');
                res.redirect(302, dest);
            })
            .catch((err) => {
                res.status(400).type('html').send(
                    `<!DOCTYPE html><html><body style="font-family:Georgia,serif;padding:40px;background:#f8fafc;color:#0f172a;"><h1>Online seminar</h1><p>${String(err.message || 'Join again from the portal.')
                        .replace(/</g, '')}</p></body></html>`
                );
            });
    });

    app.get('/api/admin/online-seminar/office', (req, res) => {
        withAdmin(req, res, () => {
            Promise.all([
                dbAll(
                    db,
                    `SELECT s.id, s.title, s.price, m.provider, m.status, m.join_url, m.host_url
                     FROM seminars s
                     JOIN online_seminar_meetings m ON m.seminar_id = s.id
                     WHERE m.delivery_mode = 'online'
                     ORDER BY s.event_date DESC, s.id DESC`
                ),
                dbAll(
                    db,
                    `SELECT i.id, i.seminar_id, i.email, i.created_at, u.first_name, u.last_name
                     FROM online_seminar_invites i
                     LEFT JOIN users u ON u.id = i.user_id
                     ORDER BY i.id DESC`
                ),
                dbAll(
                    db,
                    `SELECT r.id, r.seminar_id, r.provider, r.status, r.bytes, r.started_at, r.ended_at, s.title
                     FROM online_seminar_recordings r
                     LEFT JOIN seminars s ON s.id = r.seminar_id
                     ORDER BY r.id DESC`
                )
            ])
                .then(([seminars, invites, recordings]) => {
                    res.json({
                        ok: true,
                        seminars: (seminars || []).map((row) => ({
                            id: row.id,
                            title: row.title || '',
                            price: Number(row.price || 0),
                            provider: row.provider || 'vgmf',
                            provider_label: providers.providerLabel(row.provider || 'vgmf'),
                            status: row.status || '',
                            private_link: !!(row.join_url || row.host_url) && !String(row.join_url || '').startsWith('/hall/')
                        })),
                        invites: (invites || []).map((row) => ({
                            id: row.id,
                            seminar_id: row.seminar_id,
                            email: row.email,
                            name: [row.first_name, row.last_name].filter(Boolean).join(' '),
                            created_at: row.created_at
                        })),
                        recordings: (recordings || []).map((row) => ({
                            id: row.id,
                            seminar_id: row.seminar_id,
                            title: row.title || '',
                            provider: row.provider || '',
                            status: row.status || '',
                            bytes: Number(row.bytes || 0),
                            started_at: row.started_at,
                            ended_at: row.ended_at
                        }))
                    });
                })
                .catch(() => res.status(500).json({ error: 'Could not load online seminars.' }));
        });
    });

    app.post('/api/admin/online-seminar/invites', (req, res) => {
        withAdmin(req, res, () => {
            const sid = parseInt(req.body && req.body.seminarId, 10);
            const email = String((req.body && req.body.email) || '').trim().toLowerCase();
            if (!Number.isInteger(sid) || sid < 1 || email.indexOf('@') < 1) {
                return res.status(400).json({ error: 'Choose an online seminar and a staff email.' });
            }
            dbGet(db, `SELECT id, email, first_name, last_name, role, user_role FROM users WHERE lower(email) = ?`, [email])
                .then(async (user) => {
                    if (!user) throw Object.assign(new Error('No account uses that email.'), { status: 404 });
                    if (isDoctorAccount(user)) {
                        throw Object.assign(new Error('Doctors join with the email on their registration. Invite a staff account.'), { status: 400 });
                    }
                    const meeting = await dbGet(db, `SELECT delivery_mode FROM online_seminar_meetings WHERE seminar_id = ?`, [sid]);
                    if (!meeting || meeting.delivery_mode !== 'online') {
                        throw Object.assign(new Error('Turn this seminar online before inviting staff.'), { status: 400 });
                    }
                    const existing = await dbGet(db, `SELECT id FROM online_seminar_invites WHERE seminar_id = ? AND email = ?`, [sid, email]);
                    if (existing) return res.json({ ok: true, id: existing.id, email });
                    const inserted = await dbRun(
                        db,
                        `INSERT INTO online_seminar_invites (seminar_id, email, user_id, invited_by, created_at) VALUES (?, ?, ?, ?, ?)`,
                        [sid, email, user.id, req.onlineAdmin.id, new Date().toISOString()]
                    );
                    res.json({ ok: true, id: inserted && (inserted.lastID || inserted.lastId), email });
                })
                .catch((err) => res.status(err.status || 500).json({ error: err.message || 'Could not invite that staff account.' }));
        });
    });

    app.delete('/api/admin/online-seminar/invites/:id', (req, res) => {
        withAdmin(req, res, () => {
            const id = parseInt(req.params.id, 10);
            dbRun(db, `DELETE FROM online_seminar_invites WHERE id = ?`, [id])
                .then(() => res.json({ ok: true }))
                .catch(() => res.status(500).json({ error: 'Could not remove that invite.' }));
        });
    });

    app.post('/api/admin/online-seminar/recordings/pull', (req, res) => {
        withAdmin(req, res, () => {
            const sid = parseInt(req.body && req.body.seminarId, 10);
            dbGet(db, `SELECT id, title FROM seminars WHERE id = ?`, [sid])
                .then(async (seminar) => {
                    const meeting = await dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [sid]);
                    if (!seminar || !meeting || meeting.delivery_mode !== 'online') {
                        return res.status(404).json({ error: 'Online seminar not found.' });
                    }
                    if (meeting.provider === 'vgmf' || !meeting.provider) {
                        return res.status(400).json({ error: 'VGMF Hall saves the recording when the host goes live. Download it from this list.' });
                    }
                    const settings = await loadSettings(db);
                    const saved = await saveProviderRecording(db, seminar, meeting, settings);
                    res.json({ ok: true, id: saved.id, bytes: saved.bytes });
                })
                .catch((err) => res.status(400).json({ error: err.message || 'Could not save that recording.' }));
        });
    });

    app.get('/api/admin/online-seminar/recordings/:id/file', (req, res) => {
        withAdmin(req, res, () => {
            const id = parseInt(req.params.id, 10);
            dbGet(db, `SELECT * FROM online_seminar_recordings WHERE id = ?`, [id])
                .then((row) => {
                    const name = safeRecordingName(row && row.file_name);
                    if (!row || row.status !== 'ready' || !name) return res.status(404).json({ error: 'Recording not found.' });
                    const root = path.resolve(recordingsDir());
                    const file = path.resolve(root, name);
                    if (file !== root && !file.startsWith(root + path.sep)) return res.status(404).end();
                    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recording file is not on this server.' });
                    res.setHeader('Cache-Control', 'private, no-store');
                    res.download(file, name);
                })
                .catch(() => res.status(500).json({ error: 'Could not download the recording.' }));
        });
    });

    app.post('/api/online-seminar/join', (req, res) => {
        if (!allowJoinAttempt(req.ip)) return res.status(429).json({ ok: false, error: 'Too many join attempts. Try again in a minute.' });
        const sid = parseInt((req.body && (req.body.seminarId || req.body.seminar_id)) || '', 10);
        const finish = (user) => {
            issueJoin(db, {
                seminarId: sid,
                userId: req.body && req.body.userId,
                userIdString: req.body && req.body.userIdString,
                passcode: req.body && req.body.passcode,
                admin: user || null
            })
                .then((out) => {
                    res.setHeader('Cache-Control', 'no-store');
                    if (out.token) setHallCookie(req, res, out.token);
                    res.status(out.status).json(out.body);
                })
                .catch(() => res.status(500).json({ ok: false, error: 'Could not open the online seminar.' }));
        };
        const aid = parseInt((req.body && req.body.actingAdminId) || '', 10);
        if (Number.isInteger(aid) && aid > 0) {
            return assertAdmin(aid, (err, adm) => {
                if (err || !adm) return res.status(403).json({ ok: false, error: 'Admin access required' });
                finish(adm);
            });
        }
        finish(null);
    });

    app.get('/api/hall/:seminarId/media/:file', (req, res) => {
        const sid = parseInt(req.params.seminarId, 10);
        const name = hall.safeMediaName(req.params.file);
        if (!name) return res.status(404).end();
        hmacSecret(db)
            .then((secret) => {
                const payload = readPayload(readHallCookie(req), secret);
                if (!payload || payload.kind !== 'hall' || Number(payload.sid) !== sid) return res.status(401).end();
                const root = path.resolve(hall.hallMediaDir(sid));
                const file = path.resolve(root, name);
                if (file !== root && !file.startsWith(root + path.sep)) return res.status(404).end();
                if (!fs.existsSync(file)) return res.status(404).end();
                res.setHeader('Cache-Control', name.endsWith('.m3u8') ? 'private, no-store' : 'private, max-age=2');
                if (name.endsWith('.m3u8')) res.type('application/vnd.apple.mpegurl');
                else res.type('video/mp2t');
                fs.createReadStream(file).pipe(res);
            })
            .catch(() => res.status(500).end());
    });
}

let ffmpegReady = null;
function probeFfmpeg(cb) {
    if (ffmpegReady != null) return cb(ffmpegReady);
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    const { spawn } = require('child_process');
    const child = spawn(bin, ['-version']);
    let settled = false;
    const done = (ok) => {
        if (settled) return;
        settled = true;
        ffmpegReady = ok;
        cb(ok);
    };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
}

function attachHall(server, deps) {
    const { WebSocketServer } = require('ws');
    const db = deps.db;
    const wss = new WebSocketServer({ server, path: '/api/hall/socket' });
    wss.on('connection', (socket, req) => {
        let client = null;
        let room = null;
        const fail = (code, message) => {
            try {
                socket.send(JSON.stringify({ type: 'error', error: message }));
            } catch (_) {}
            socket.close(code || 4001);
        };
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token') || '';
        hmacSecret(db)
            .then(async (secret) => {
                const payload = readPayload(token, secret);
                if (!payload || payload.kind !== 'hall') return fail(4001, 'Sign in to the hall again.');
                const meeting = await dbGet(db, `SELECT * FROM online_seminar_meetings WHERE seminar_id = ?`, [payload.sid]);
                const settings = await loadSettings(db);
                room = getRoom(payload.sid, meeting, settings);
                client = {
                    userId: Number(payload.uid),
                    role: payload.role === 'host' || payload.role === 'speaker' ? payload.role : 'audience',
                    name: String(payload.name || 'Doctor').slice(0, 80),
                    deliver(obj) {
                        if (socket.readyState === 1) socket.send(JSON.stringify(obj));
                    },
                    deliverBinary(buf) {
                        if (socket.readyState === 1) socket.send(buf);
                    },
                    close() {
                        try {
                            socket.close(4000);
                        } catch (_) {}
                    }
                };
                const added = hall.addClient(room, client);
                if (!added.ok) return fail(4003, added.error);
                await dbRun(
                    db,
                    `INSERT INTO online_seminar_attendance (seminar_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
                    [payload.sid, payload.uid, client.role, new Date().toISOString()]
                ).catch(() => {});
            })
            .catch(() => fail(1011, 'The hall could not be opened.'));

        socket.on('message', (data, isBinary) => {
            if (!client || !room) return;
            const text = !isBinary ? (Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : '') : '';
            if (text && text.charCodeAt(0) === 123) {
                let msg = null;
                try {
                    msg = JSON.parse(text);
                } catch (_) {
                    return;
                }
                const result = hall.applyHallMessage(room, client, msg);
            if (result && result.error) client.deliver({ type: 'error', error: result.error });
            (result && result.effects ? result.effects : []).forEach((effect) => {
                if (effect === 'ban' && result.userId) {
                    const banned = Array.from(room.banned);
                    dbRun(db, `UPDATE online_seminar_meetings SET banned_json = ? WHERE seminar_id = ?`, [
                        JSON.stringify(banned),
                        room.seminarId
                    ]).catch(() => {});
                }
                if (effect === 'stop-feed') {
                    hall.stopFeed(room);
                    finishRecording(db, room);
                }
                if (effect === 'start-feed' || effect === 'restart-feed') {
                    if (effect === 'restart-feed') finishRecording(db, room);
                    beginRecording(db, room, client.userId);
                    probeFfmpeg((ok) => {
                        if (!ok) {
                            client.deliver({
                                type: 'playback',
                                hls: false,
                                note: 'Live video is being sent from this server. A phone can watch it directly when the host uses the hall.'
                            });
                            return;
                        }
                        hall.startFeed(room, process.env.FFMPEG_PATH || 'ffmpeg');
                    });
                }
            });
                return;
            }
            if (client.role !== 'host' || client.waiting) return;
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            hall.writeProgramChunk(room, buf);
            appendRecording(room, buf);
            if (room.ffmpeg) hall.noteHlsReady(room);
        });

        socket.on('close', () => {
            if (room && client) {
                hall.removeClient(room, client);
                dbRun(
                    db,
                    `UPDATE online_seminar_attendance SET left_at = ? WHERE seminar_id = ? AND user_id = ? AND left_at IS NULL`,
                    [new Date().toISOString(), room.seminarId, client.userId]
                ).catch(() => {});
                if (!room.clients.size) {
                    hall.stopFeed(room);
                    finishRecording(db, room);
                    rooms.delete(room.seminarId);
                }
            }
        });
    });
    return wss;
}

module.exports = {
    ensureSchema,
    attachPublicSummary,
    persistFromSeminarBody,
    publicSummary,
    registerOnlineSeminarRoutes,
    attachHall,
    signPayload,
    readPayload,
    loadSettings,
    saveSettings,
    issueJoin,
    joinWindow,
    ELIGIBLE
};

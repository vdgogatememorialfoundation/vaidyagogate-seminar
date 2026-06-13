/**
 * Online webinar access — gated join so Zoom/Meet/Teams/WebEx links are never public.
 */
const crypto = require('crypto');

const PROVIDERS = ['zoom', 'google_meet', 'microsoft_teams', 'cisco_webex', 'custom_link', 'vgmf_room'];
const DELIVERY_MODES = ['in_person', 'online', 'hybrid'];
const TOKEN_TTL_MS = 15 * 60 * 1000;

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ignoreErr(e) {
    if (e && !/duplicate column|already exists/i.test(String(e.message))) {
        console.warn('[webinar-access]', e.message);
    }
}

function normalizeDeliveryMode(raw) {
    const v = String(raw || 'in_person').trim().toLowerCase();
    return DELIVERY_MODES.indexOf(v) !== -1 ? v : 'in_person';
}

function normalizeProvider(raw) {
    const v = String(raw || 'custom_link').trim().toLowerCase();
    return PROVIDERS.indexOf(v) !== -1 ? v : 'custom_link';
}

function providerLabel(code) {
    const map = {
        zoom: 'Zoom',
        google_meet: 'Google Meet',
        microsoft_teams: 'Microsoft Teams',
        cisco_webex: 'Cisco Webex',
        custom_link: 'Custom link',
        vgmf_room: 'VGMF webinar room (built-in)'
    };
    return map[code] || 'Webinar';
}

function isOnlineDelivery(mode) {
    const m = normalizeDeliveryMode(mode);
    return m === 'online' || m === 'hybrid';
}

function ensureSchema(db, cb) {
    const ts = isPg() ? 'TIMESTAMPTZ' : 'DATETIME';
    const steps = [
        `ALTER TABLE seminars ADD COLUMN delivery_mode TEXT DEFAULT 'in_person'`,
        `ALTER TABLE seminars ADD COLUMN webinar_provider TEXT`,
        `ALTER TABLE seminars ADD COLUMN webinar_meeting_url TEXT`,
        `ALTER TABLE seminars ADD COLUMN webinar_join_instructions TEXT`,
        `ALTER TABLE seminars ADD COLUMN webinar_join_opens ${ts}`,
        `ALTER TABLE seminars ADD COLUMN webinar_join_closes ${ts}`,
        `ALTER TABLE seminars ADD COLUMN webinar_single_device INTEGER DEFAULT 0`,
        `CREATE TABLE IF NOT EXISTS webinar_join_tokens (
            token TEXT PRIMARY KEY,
            ticket_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            seminar_id INTEGER NOT NULL,
            created_at ${ts} DEFAULT CURRENT_TIMESTAMP,
            expires_at ${ts} NOT NULL,
            used_at ${ts},
            client_ip TEXT,
            user_agent TEXT,
            device_hash TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_webinar_join_tokens_ticket ON webinar_join_tokens(ticket_id, created_at DESC)`
    ];
    let i = 0;
    const next = () => {
        if (i >= steps.length) return cb && cb(null);
        db.run(steps[i++], (e) => {
            ignoreErr(e);
            next();
        });
    };
    next();
}

function parseJoinWindow(seminar) {
    const now = Date.now();
    const opens = seminar.webinar_join_opens ? new Date(seminar.webinar_join_opens).getTime() : null;
    const closes = seminar.webinar_join_closes ? new Date(seminar.webinar_join_closes).getTime() : null;
    if (opens != null && !Number.isNaN(opens) && now < opens) {
        return { ok: false, error: 'Webinar join opens at ' + new Date(opens).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' };
    }
    if (closes != null && !Number.isNaN(closes) && now > closes) {
        return { ok: false, error: 'Webinar join window has closed.' };
    }
    return { ok: true };
}

function ticketEligibleForWebinar(row) {
    if (!row) return { ok: false, error: 'Ticket not found' };
    if (!isOnlineDelivery(row.delivery_mode)) return { ok: false, error: 'This seminar is in-person only.' };
    const regSt = String(row.registration_status || '').toLowerCase();
    if (regSt === 'cancelled' || regSt === 'rejected') return { ok: false, error: 'Registration is not active.' };
    if (String(row.order_status || '').toLowerCase() !== 'success' && Number(row.price || 0) > 0) {
        return { ok: false, error: 'Payment must be confirmed before joining the webinar.' };
    }
    if (row.is_valid === 0 || row.is_valid === false) return { ok: false, error: 'This ticket is no longer valid.' };
    if (!row.webinar_meeting_url || !String(row.webinar_meeting_url).trim()) {
        return { ok: false, error: 'Webinar link has not been configured yet. Contact the seminar office.' };
    }
    const win = parseJoinWindow(row);
    if (!win.ok) return win;
    return { ok: true };
}

function deviceHash(req) {
    const ua = (req && req.get && req.get('user-agent')) || '';
    const ip = (req && req.headers && req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : req && req.socket && req.socket.remoteAddress) || '';
    return crypto.createHash('sha256').update(String(ip) + '|' + String(ua)).digest('hex').slice(0, 32);
}

function createJoinToken(db, req, row, cb) {
    const check = ticketEligibleForWebinar(row);
    if (!check.ok) return cb(null, check);

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    const ip =
        (req.headers && req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
        (req.socket && req.socket.remoteAddress) ||
        '';
    const ua = (req.get && req.get('user-agent')) || '';
    const hash = deviceHash(req);

    db.run(
        `INSERT INTO webinar_join_tokens (token, ticket_id, user_id, seminar_id, expires_at, client_ip, user_agent, device_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [token, row.ticket_row_id, row.user_id, row.seminar_id, expiresAt, ip, ua.slice(0, 500), hash],
        (err) => {
            if (err) return cb(err);
            cb(null, { ok: true, token, expiresAt, enterPath: '/webinar/enter/' + token });
        }
    );
}

function consumeJoinToken(db, token, req, cb) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 16) return cb(null, { ok: false, error: 'Invalid join link.' });

    db.get(
        `SELECT w.*, s.webinar_meeting_url, s.webinar_provider, s.title AS seminar_title,
                s.webinar_single_device, t.ticket_id_string, t.is_valid
         FROM webinar_join_tokens w
         JOIN seminars s ON s.id = w.seminar_id
         JOIN tickets t ON t.id = w.ticket_id
         WHERE w.token = ?`,
        [clean],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, { ok: false, error: 'Join link expired or invalid.' });
            if (row.used_at) return cb(null, { ok: false, error: 'This join link was already used. Open the doctor portal and join again.' });
            const exp = new Date(row.expires_at).getTime();
            if (Number.isNaN(exp) || Date.now() > exp) {
                return cb(null, { ok: false, error: 'Join link expired. Request a new link from the doctor portal.' });
            }
            if (row.is_valid === 0) return cb(null, { ok: false, error: 'Ticket is no longer valid.' });

            const hash = deviceHash(req);
            if (Number(row.webinar_single_device) === 1 && row.device_hash && row.device_hash !== hash) {
                return cb(null, {
                    ok: false,
                    error: 'This ticket is locked to the first device used to join. Contact admin if you changed devices.'
                });
            }

            db.run(
                `UPDATE webinar_join_tokens SET used_at = CURRENT_TIMESTAMP, device_hash = COALESCE(device_hash, ?) WHERE token = ?`,
                [hash, clean],
                (uErr) => {
                    if (uErr) return cb(uErr);
                    cb(null, {
                        ok: true,
                        meetingUrl: String(row.webinar_meeting_url || '').trim(),
                        provider: row.webinar_provider,
                        seminarTitle: row.seminar_title,
                        ticketId: row.ticket_id_string
                    });
                }
            );
        }
    );
}

function stripMeetingUrlFromSeminar(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    delete out.webinar_meeting_url;
    return out;
}

module.exports = {
    PROVIDERS,
    DELIVERY_MODES,
    normalizeDeliveryMode,
    normalizeProvider,
    providerLabel,
    isOnlineDelivery,
    ensureSchema,
    ticketEligibleForWebinar,
    createJoinToken,
    consumeJoinToken,
    stripMeetingUrlFromSeminar
};

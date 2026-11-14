'use strict';
// Theatre-style seat maps per seminar (optional). Admin designs rows/sections and
// blocks rows or single seats; doctors hold seats while registering; holds become
// bookings when the application is submitted.

const HOLD_MINUTES = 12;
const MAX_ROWS = 60;
const MAX_SEATS_PER_ROW = 60;

function ensureSchema(db, cb) {
    db.run(`ALTER TABLE seminars ADD COLUMN seat_map_json TEXT`, () => {
        db.run(
            `CREATE TABLE IF NOT EXISTS seminar_seats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seminar_id INTEGER NOT NULL,
                seat_code TEXT NOT NULL,
                user_id INTEGER,
                registration_id INTEGER,
                status TEXT NOT NULL DEFAULT 'held',
                hold_until TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (seminar_id, seat_code)
            )`,
            [],
            () => cb && cb()
        );
    });
}

function rowLabel(i) {
    let s = '';
    let n = i;
    do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
}

function normalizeMap(raw) {
    let src = raw;
    if (typeof src === 'string') {
        try {
            src = JSON.parse(src);
        } catch (_) {
            src = null;
        }
    }
    if (!src || typeof src !== 'object') return { enabled: false, rows: [], sections: [] };
    const sections = Array.isArray(src.sections)
        ? src.sections.slice(0, 12).map((s, i) => ({
              name: String((s && s.name) || 'Section ' + (i + 1)).slice(0, 40),
              color: /^#[0-9a-fA-F]{6}$/.test(String(s && s.color)) ? s.color : '#0f766e',
              price: s && s.price !== '' && s.price != null && Number.isFinite(Number(s.price)) ? Number(s.price) : null
          }))
        : [];
    const rows = Array.isArray(src.rows)
        ? src.rows.slice(0, MAX_ROWS).map((r, i) => {
              const seats = Math.max(0, Math.min(MAX_SEATS_PER_ROW, parseInt(r && r.seats, 10) || 0));
              const blockedSeats = Array.isArray(r && r.blockedSeats)
                  ? r.blockedSeats.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= seats)
                  : [];
              return {
                  label: String((r && r.label) || rowLabel(i)).slice(0, 4).toUpperCase(),
                  seats,
                  section: Math.max(0, Math.min(sections.length - 1, parseInt(r && r.section, 10) || 0)),
                  blocked: !!(r && r.blocked),
                  blockedSeats: Array.from(new Set(blockedSeats)).sort((a, b) => a - b),
                  gapAfter: Array.isArray(r && r.gapAfter)
                      ? r.gapAfter.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n < seats)
                      : [],
                  spaceAfter: !!(r && r.spaceAfter)
              };
          })
        : [];
    return {
        enabled: !!src.enabled && rows.length > 0,
        stageLabel: String(src.stageLabel || 'STAGE').slice(0, 30),
        curve: !!src.curve,
        maxPerBooking: Math.max(1, Math.min(10, parseInt(src.maxPerBooking, 10) || 1)),
        sections: sections.length ? sections : [{ name: 'General', color: '#0f766e', price: null }],
        rows
    };
}

function seatCodes(map) {
    const out = new Set();
    for (const r of map.rows) {
        if (r.blocked) continue;
        for (let n = 1; n <= r.seats; n++) {
            if (r.blockedSeats.includes(n)) continue;
            out.add(r.label + n);
        }
    }
    return out;
}

function loadMap(db, seminarId, cb) {
    db.get(`SELECT seat_map_json FROM seminars WHERE id = ?`, [seminarId], (e, row) => {
        if (e || !row) return cb(e || null, normalizeMap(null));
        cb(null, normalizeMap(row.seat_map_json));
    });
}

function purgeExpired(db, seminarId, cb) {
    db.run(
        `DELETE FROM seminar_seats WHERE seminar_id = ? AND status = 'held' AND (hold_until IS NULL OR hold_until < ?)`,
        [seminarId, new Date().toISOString()],
        () => {
            // free seats of cancelled / rejected / refunded applications
            db.run(
                `DELETE FROM seminar_seats WHERE seminar_id = ? AND status = 'booked' AND registration_id IS NOT NULL
                 AND registration_id IN (SELECT id FROM registrations WHERE seminar_id = ? AND status IN ('cancelled','rejected','refunded','withdrawn'))`,
                [seminarId, seminarId],
                () => cb && cb()
            );
        }
    );
}

function occupancy(db, seminarId, cb) {
    purgeExpired(db, seminarId, () => {
        db.all(
            `SELECT seat_code, user_id, registration_id, status, hold_until FROM seminar_seats WHERE seminar_id = ?`,
            [seminarId],
            (e, rows) => cb(e, rows || [])
        );
    });
}

function holdSeats(db, seminarId, userId, codes, cb) {
    loadMap(db, seminarId, (e, map) => {
        if (e) return cb(e);
        if (!map.enabled) return cb(new Error('Seat selection is not enabled for this seminar.'));
        const valid = seatCodes(map);
        const want = Array.from(new Set((codes || []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean)));
        if (!want.length) {
            return db.run(
                `DELETE FROM seminar_seats WHERE seminar_id = ? AND user_id = ? AND status = 'held'`,
                [seminarId, userId],
                () => cb(null, { held: [], holdUntil: null })
            );
        }
        if (want.length > map.maxPerBooking) return cb(new Error('You can select at most ' + map.maxPerBooking + ' seat(s).'));
        for (const c of want) if (!valid.has(c)) return cb(new Error('Seat ' + c + ' is not available.'));
        purgeExpired(db, seminarId, () => {
            db.all(
                `SELECT seat_code FROM seminar_seats WHERE seminar_id = ? AND seat_code IN (${want.map(() => '?').join(',')}) AND user_id <> ?`,
                [seminarId, ...want, userId],
                (e2, taken) => {
                    if (e2) return cb(e2);
                    if (taken && taken.length) {
                        return cb(
                            Object.assign(new Error('Seat ' + taken.map((t) => t.seat_code).join(', ') + ' was just taken. Pick another.'), {
                                code: 409,
                                taken: taken.map((t) => t.seat_code)
                            })
                        );
                    }
                    const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
                    db.run(
                        `DELETE FROM seminar_seats WHERE seminar_id = ? AND user_id = ? AND status = 'held'`,
                        [seminarId, userId],
                        () => {
                            let i = 0;
                            const next = () => {
                                if (i >= want.length) return cb(null, { held: want, holdUntil });
                                const code = want[i++];
                                db.run(
                                    `INSERT INTO seminar_seats (seminar_id, seat_code, user_id, status, hold_until) VALUES (?, ?, ?, 'held', ?)`,
                                    [seminarId, code, userId, holdUntil],
                                    (e3) => {
                                        if (e3) return cb(Object.assign(new Error('Seat ' + code + ' was just taken. Pick another.'), { code: 409, taken: [code] }));
                                        next();
                                    }
                                );
                            };
                            next();
                        }
                    );
                }
            );
        });
    });
}

// Called after the application row exists. Converts this user's holds into bookings.
function confirmSeats(db, seminarId, userId, registrationId, codes, cb) {
    const want = Array.from(new Set((codes || []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean)));
    if (!want.length) return cb && cb(null, []);
    db.run(
        `UPDATE seminar_seats SET status = 'booked', registration_id = ?, hold_until = NULL
         WHERE seminar_id = ? AND user_id = ? AND status = 'held' AND seat_code IN (${want.map(() => '?').join(',')})`,
        [registrationId, seminarId, userId, ...want],
        function (e) {
            if (e) return cb && cb(e);
            db.all(
                `SELECT seat_code FROM seminar_seats WHERE registration_id = ? ORDER BY seat_code`,
                [registrationId],
                (e2, rows) => cb && cb(e2, (rows || []).map((r) => r.seat_code))
            );
        }
    );
}

function releaseForRegistration(db, registrationId, cb) {
    db.run(`DELETE FROM seminar_seats WHERE registration_id = ?`, [registrationId], () => cb && cb());
}

function seatsForRegistration(db, key, cb) {
    const byId = Number.isInteger(parseInt(key, 10)) && String(key).trim() === String(parseInt(key, 10));
    const sql = byId
        ? `SELECT seat_code FROM seminar_seats WHERE registration_id = ? AND status = 'booked' ORDER BY seat_code`
        : `SELECT ss.seat_code FROM seminar_seats ss JOIN registrations r ON r.id = ss.registration_id
           WHERE r.application_no = ? AND ss.status = 'booked' ORDER BY ss.seat_code`;
    db.all(sql, [byId ? parseInt(key, 10) : String(key).trim()], (e, rows) => cb(e, (rows || []).map((r) => r.seat_code)));
}

function sortCodes(codes) {
    return codes.slice().sort((a, b) => {
        const ma = /^([A-Z]+)(\d+)$/.exec(a) || [];
        const mb = /^([A-Z]+)(\d+)$/.exec(b) || [];
        if ((ma[1] || a) !== (mb[1] || b)) return (ma[1] || a) < (mb[1] || b) ? -1 : 1;
        return (parseInt(ma[2], 10) || 0) - (parseInt(mb[2], 10) || 0);
    });
}

function mountRoutes(app, db, deps) {
    const adminGuard = (deps && deps.adminGuard) || ((req, res, next) => next());
    const resolveUserId = (deps && deps.resolveUserId) || ((req) => parseInt((req.body && req.body.userId) || (req.query && req.query.userId), 10) || 0);

    // Public (doctor portal): map + occupancy
    app.get('/api/seminars/:id/seats', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!sid) return res.status(400).json({ error: 'seminar id required' });
        const uid = resolveUserId(req);
        loadMap(db, sid, (e, map) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!map.enabled) return res.json({ enabled: false });
            occupancy(db, sid, (e2, rows) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const taken = [];
                const mine = [];
                let myHoldUntil = null;
                for (const r of rows) {
                    if (uid && Number(r.user_id) === uid && r.status === 'held') {
                        mine.push(r.seat_code);
                        myHoldUntil = r.hold_until;
                    } else taken.push(r.seat_code);
                }
                res.json({ enabled: true, map, taken, mine: sortCodes(mine), holdUntil: myHoldUntil, holdMinutes: HOLD_MINUTES });
            });
        });
    });

    app.post('/api/seminars/:id/seats/hold', (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const uid = resolveUserId(req);
        if (!sid || !uid) return res.status(400).json({ error: 'seminar id and user required' });
        holdSeats(db, sid, uid, (req.body && req.body.seats) || [], (e, out) => {
            if (e) return res.status(e.code === 409 ? 409 : 400).json({ error: e.message, taken: e.taken || [] });
            res.json({ success: true, held: out.held, holdUntil: out.holdUntil, holdMinutes: HOLD_MINUTES });
        });
    });

    // Admin: save map, view occupancy, release / assign
    app.get('/api/admin/seminars/:id/seat-map', adminGuard, (req, res) => {
        const sid = parseInt(req.params.id, 10);
        loadMap(db, sid, (e, map) => {
            if (e) return res.status(500).json({ error: e.message });
            db.all(
                `SELECT ss.seat_code, ss.status, ss.hold_until, ss.user_id, ss.registration_id, r.application_no, r.form_data,
                        u.first_name, u.last_name, u.email
                 FROM seminar_seats ss
                 LEFT JOIN registrations r ON r.id = ss.registration_id
                 LEFT JOIN users u ON u.id = ss.user_id
                 WHERE ss.seminar_id = ?`,
                [sid],
                (e2, rows) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const now = Date.now();
                    const seats = (rows || [])
                        .filter((r) => r.status !== 'held' || !r.hold_until || Date.parse(r.hold_until) > now)
                        .map((r) => {
                            let fname = '';
                            try {
                                const fd = r.form_data ? JSON.parse(r.form_data) : null;
                                fname = fd ? [fd.first_name || fd.firstName, fd.last_name || fd.lastName].filter(Boolean).join(' ') : '';
                            } catch (_) {}
                            return {
                                seat_code: r.seat_code,
                                status: r.status,
                                hold_until: r.hold_until,
                                registration_id: r.registration_id,
                                application_no: r.application_no,
                                name: fname || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || ''
                            };
                        });
                    res.json({ map, seats });
                }
            );
        });
    });

    app.put('/api/admin/seminars/:id/seat-map', adminGuard, (req, res) => {
        const sid = parseInt(req.params.id, 10);
        if (!sid) return res.status(400).json({ error: 'seminar id required' });
        const map = normalizeMap(req.body && (req.body.seat_map || req.body));
        db.run(`UPDATE seminars SET seat_map_json = ? WHERE id = ?`, [JSON.stringify(map), sid], (e) => {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ success: true, map });
        });
    });

    app.post('/api/admin/seminars/:id/seats/release', adminGuard, (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const code = String((req.body && req.body.seat) || '').trim().toUpperCase();
        if (!sid || !code) return res.status(400).json({ error: 'seminar id and seat required' });
        db.run(`DELETE FROM seminar_seats WHERE seminar_id = ? AND seat_code = ?`, [sid, code], function (e) {
            if (e) return res.status(500).json({ error: e.message });
            res.json({ success: true, released: this.changes });
        });
    });

    app.post('/api/admin/seminars/:id/seats/assign', adminGuard, (req, res) => {
        const sid = parseInt(req.params.id, 10);
        const code = String((req.body && req.body.seat) || '').trim().toUpperCase();
        const appNo = String((req.body && req.body.applicationNo) || '').trim();
        if (!sid || !code || !appNo) return res.status(400).json({ error: 'seminar id, seat and applicationNo required' });
        db.get(`SELECT id, user_id FROM registrations WHERE application_no = ? AND seminar_id = ?`, [appNo, sid], (e, reg) => {
            if (e) return res.status(500).json({ error: e.message });
            if (!reg) return res.status(404).json({ error: 'Application not found for this seminar' });
            loadMap(db, sid, (e1, map) => {
                if (!seatCodes(map).has(code)) return res.status(400).json({ error: 'Seat ' + code + ' is blocked or does not exist' });
                db.run(`DELETE FROM seminar_seats WHERE seminar_id = ? AND seat_code = ?`, [sid, code], () => {
                    db.run(
                        `INSERT INTO seminar_seats (seminar_id, seat_code, user_id, registration_id, status) VALUES (?, ?, ?, ?, 'booked')`,
                        [sid, code, reg.user_id, reg.id],
                        (e2) => {
                            if (e2) return res.status(500).json({ error: e2.message });
                            res.json({ success: true });
                        }
                    );
                });
            });
        });
    });
}

module.exports = {
    HOLD_MINUTES,
    ensureSchema,
    normalizeMap,
    seatCodes,
    loadMap,
    holdSeats,
    confirmSeats,
    releaseForRegistration,
    seatsForRegistration,
    sortCodes,
    mountRoutes
};

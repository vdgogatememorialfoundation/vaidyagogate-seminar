/**
 * Service appointment booking and the field-force desk.
 * Uses the Tookan API key already stored in commerce settings.
 * Shipment delivery windows (appointment_json) are a different feature.
 */
const path = require('path');
const crypto = require('crypto');
const commerce = require('./commerce-logistics');
const field = require('./tookan-field');
const bookAuth = require('./book-sales-auth');

const SEED = [
    ['Home consultation', 'A practitioner visits the address you give.', 60, 'appointment', 'home-visit'],
    ['Clinic appointment', 'A scheduled appointment at the clinic address.', 45, 'appointment', 'clinic'],
    ['Field follow-up', 'A field agent visits to complete a follow-up.', 90, 'fos', 'field']
];

let schemaReady = false;
let schemaWaiters = null;

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function schemaStatements() {
    if (isPg()) {
        return [
            `CREATE TABLE IF NOT EXISTS field_services (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                summary TEXT,
                duration_min INTEGER NOT NULL DEFAULT 60,
                price REAL,
                team_id TEXT,
                tags TEXT,
                kind TEXT NOT NULL DEFAULT 'appointment',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS field_bookings (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                client_token TEXT,
                service_id INTEGER,
                service_name TEXT,
                kind TEXT NOT NULL,
                duration_min INTEGER,
                customer_name TEXT,
                customer_phone TEXT,
                customer_email TEXT,
                customer_address TEXT,
                latitude REAL,
                longitude REAL,
                start_at TEXT,
                end_at TEXT,
                notes TEXT,
                status TEXT,
                tookan_job_id TEXT,
                tracking_link TEXT,
                fleet_id TEXT,
                fleet_name TEXT,
                fleet_phone TEXT,
                team_id TEXT,
                job_status INTEGER,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )`
        ];
    }
    return [
        `CREATE TABLE IF NOT EXISTS field_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            summary TEXT,
            duration_min INTEGER NOT NULL DEFAULT 60,
            price REAL,
            team_id TEXT,
            tags TEXT,
            kind TEXT NOT NULL DEFAULT 'appointment',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS field_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            client_token TEXT,
            service_id INTEGER,
            service_name TEXT,
            kind TEXT NOT NULL,
            duration_min INTEGER,
            customer_name TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            customer_address TEXT,
            latitude REAL,
            longitude REAL,
            start_at TEXT,
            end_at TEXT,
            notes TEXT,
            status TEXT,
            tookan_job_id TEXT,
            tracking_link TEXT,
            fleet_id TEXT,
            fleet_name TEXT,
            fleet_phone TEXT,
            team_id TEXT,
            job_status INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`
    ];
}

function ensureSchema(db, cb) {
    if (schemaReady) return cb && cb();
    if (schemaWaiters) {
        if (cb) schemaWaiters.push(cb);
        return;
    }
    schemaWaiters = cb ? [cb] : [];
    const finish = () => {
        schemaReady = true;
        const waiters = schemaWaiters || [];
        schemaWaiters = null;
        waiters.forEach((fn) => fn());
    };
    const statements = schemaStatements();
    let i = 0;
    const next = () => {
        if (i >= statements.length) return seedServices(db, finish);
        db.run(statements[i++], () => next());
    };
    next();
}

function seedServices(db, cb) {
    db.get(`SELECT COUNT(*) AS n FROM field_services`, [], (err, row) => {
        if (err || (row && Number(row.n) > 0)) return cb();
        let i = 0;
        const next = () => {
            if (i >= SEED.length) return cb();
            const rowSeed = SEED[i++];
            db.run(
                `INSERT INTO field_services (name, summary, duration_min, kind, tags, active) VALUES (?, ?, ?, ?, ?, 1)`,
                rowSeed,
                () => next()
            );
        };
        next();
    });
}

function loadConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [commerce.CONFIG_KEY], (err, row) => {
        if (err) return cb(err);
        let raw = {};
        if (row && row.value) {
            try {
                raw = JSON.parse(row.value);
            } catch (_) {
                raw = {};
            }
        }
        cb(null, commerce.normalizeCommerceConfig(raw));
    });
}

function publicService(row) {
    return {
        id: row.id,
        name: row.name,
        summary: row.summary || '',
        durationMin: Number(row.duration_min) || 60,
        price: row.price == null ? null : Number(row.price),
        teamId: row.team_id || '',
        tags: row.tags || '',
        kind: field.kindOf(row.kind),
        kindLabel: field.kindOf(row.kind) === 'fos' ? 'Field visit' : 'Appointment',
        active: Number(row.active) !== 0
    };
}

function publicBooking(row) {
    const status = row.status || 'booked';
    return {
        id: row.id,
        code: row.code,
        service: row.service_name || '',
        kind: field.kindOf(row.kind),
        kindLabel: field.kindOf(row.kind) === 'fos' ? 'Field visit' : 'Appointment',
        durationMin: Number(row.duration_min) || 60,
        name: row.customer_name || '',
        phone: row.customer_phone || '',
        email: row.customer_email || '',
        address: row.customer_address || '',
        start: row.start_at || '',
        end: row.end_at || '',
        startLabel: field.formatWall(row.start_at),
        endLabel: field.formatWall(row.end_at),
        notes: row.notes || '',
        status: status,
        statusLabel: field.BOOKING_LABEL[status] || status,
        partner: row.fleet_name || '',
        partnerPhone: row.fleet_phone || '',
        trackingLink: row.tracking_link || '',
        jobId: row.tookan_job_id || '',
        fleetId: row.fleet_id || '',
        teamId: row.team_id || '',
        latitude: row.latitude,
        longitude: row.longitude
    };
}

function customerBooking(row) {
    const view = publicBooking(row);
    delete view.id;
    delete view.fleetId;
    delete view.email;
    return view;
}

function sendError(res, err) {
    const status = err && err.status ? err.status : 500;
    res.status(status).json({ error: (err && err.message) || 'Request failed' });
}

function newCode() {
    return 'SV' + String(crypto.randomInt(10000000, 100000000));
}

function finiteCoord(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function guard(db, handler) {
    return (req, res) => {
        ensureSchema(db, () => {
            bookAuth.requireBookSalesActor(db, {}, (req2, res2) => {
                const sections = req2.staffPortalSections || {};
                if (!sections['field-force'] && !bookAuth.canAccessBookOrders(req2.bookSalesActor)) {
                    return res2.status(403).json({ error: 'Field force is not enabled for this account.' });
                }
                handler(req2, res2);
            })(req, res);
        });
    };
}

function readService(db, id, cb) {
    db.get(`SELECT * FROM field_services WHERE id = ?`, [id], cb);
}

function insertBooking(db, rec, cb) {
    const params = [
        rec.code,
        rec.clientToken || null,
        rec.serviceId || null,
        rec.serviceName,
        rec.kind,
        rec.durationMin,
        rec.name,
        rec.phone,
        rec.email || null,
        rec.address,
        rec.latitude,
        rec.longitude,
        rec.start,
        rec.end,
        rec.notes || null,
        rec.status,
        rec.jobId || null,
        rec.trackingLink || null,
        rec.fleetId || null,
        rec.fleetName || null,
        rec.teamId || null
    ];
    db.run(
        `INSERT INTO field_bookings (
            code, client_token, service_id, service_name, kind, duration_min,
            customer_name, customer_phone, customer_email, customer_address,
            latitude, longitude, start_at, end_at, notes, status,
            tookan_job_id, tracking_link, fleet_id, fleet_name, team_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
        function (err) {
            if (err) return cb(err);
            db.get(`SELECT * FROM field_bookings WHERE id = ?`, [this.lastID], cb);
        }
    );
}

function bookingInput(body, service) {
    const src = body || {};
    const kind = service ? field.kindOf(service.kind) : field.kindOf(src.kind);
    const duration = service ? Number(service.duration_min) || 60 : Math.min(480, Math.max(15, Number(src.durationMin) || 60));
    const start = field.wallClock(src.start || src.startAt);
    const end = field.addWallMinutes(start, duration);
    const now = field.istNowWall();
    if (!start) {
        const err = new Error('Choose a date and time.');
        err.status = 400;
        throw err;
    }
    if (start <= now) {
        const err = new Error('Choose a visit time that is still ahead.');
        err.status = 400;
        throw err;
    }
    const latest = field.addWallMinutes(now, 60 * 24 * 60);
    if (start > latest) {
        const err = new Error('Visits can be booked up to 60 days ahead.');
        err.status = 400;
        throw err;
    }
    return {
        kind: kind,
        durationMin: duration,
        name: src.name || src.customerName,
        phone: src.phone,
        email: src.email || '',
        address: src.address,
        latitude: src.latitude,
        longitude: src.longitude,
        start: start,
        end: end,
        notes: String(src.notes || '').trim().slice(0, 500),
        teamId: (service && service.team_id) || src.teamId || '',
        fleetId: src.fleetId || '',
        tags: (service && service.tags) || src.tags || (kind === 'fos' ? 'field' : 'appointment'),
        description: (service ? service.name : src.serviceName || 'Service visit') + (src.notes ? ' — ' + String(src.notes).trim().slice(0, 180) : ''),
        autoAssign: src.autoAssign !== false && src.autoAssign !== 0 && src.autoAssign !== '0'
    };
}

function placeBooking(db, cfg, spec, cb) {
    const attempt = (left) => {
        const code = newCode();
        const visit = Object.assign({}, spec, {
            orderId: code,
            meta: [
                { label: 'Booking', data: code },
                { label: 'Service', data: spec.serviceName || '' }
            ]
        });
        field.createVisit(cfg, visit).then((created) => {
            insertBooking(db, {
                code: code,
                clientToken: spec.clientToken,
                serviceId: spec.serviceId,
                serviceName: spec.serviceName,
                kind: created.kind,
                durationMin: spec.durationMin,
                name: visit.name,
                phone: String(visit.phone || '').replace(/\D/g, ''),
                email: visit.email,
                address: visit.address,
                latitude: finiteCoord(visit.latitude),
                longitude: finiteCoord(visit.longitude),
                start: created.start,
                end: created.end,
                notes: spec.notes,
                status: created.jobId ? (spec.fleetId ? 'assigned' : 'booked') : 'booked',
                jobId: created.jobId,
                trackingLink: created.trackingLink,
                fleetId: spec.fleetId || '',
                fleetName: spec.fleetName || '',
                teamId: spec.teamId || ''
            }, (err, row) => {
                if (err && left > 1 && /unique/i.test(err.message || '')) return attempt(left - 1);
                if (err) return cb(err);
                cb(null, row);
            });
        }).catch((err) => cb(err));
    };
    attempt(4);
}

function updateBooking(db, id, sets, params, cb) {
    db.run(
        `UPDATE field_bookings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        params.concat([id]),
        (err) => {
            if (err) return cb(err);
            db.get(`SELECT * FROM field_bookings WHERE id = ?`, [id], cb);
        }
    );
}

function noteTookanWebhook(db, parsed, cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    const jobId = parsed && parsed.jobId ? String(parsed.jobId) : '';
    const orderCode = parsed && parsed.orderCode ? String(parsed.orderCode) : '';
    if (!jobId && !orderCode) return done(false);
    ensureSchema(db, () => {
        db.get(
            `SELECT * FROM field_bookings WHERE tookan_job_id = ? OR (code = ? AND ? <> '') ORDER BY id DESC LIMIT 1`,
            [jobId, orderCode, orderCode],
            (err, row) => {
                if (err || !row) return done(false);
                const mapped = field.bookingFromJob(parsed.taskStatus);
                const sets = ['job_status = ?'];
                const params = [Number.isFinite(parsed.taskStatus) ? parsed.taskStatus : null];
                if (mapped) {
                    sets.push('status = ?');
                    params.push(mapped.status);
                }
                if (parsed.agentName) {
                    sets.push('fleet_name = ?');
                    params.push(String(parsed.agentName).slice(0, 120));
                }
                if (parsed.agentPhone) {
                    sets.push('fleet_phone = ?');
                    params.push(String(parsed.agentPhone).slice(0, 20));
                }
                if (jobId && !row.tookan_job_id) {
                    sets.push('tookan_job_id = ?');
                    params.push(jobId);
                }
                if (parsed.trackingLink) {
                    sets.push('tracking_link = ?');
                    params.push(String(parsed.trackingLink).slice(0, 400));
                }
                updateBooking(db, row.id, sets, params, () => done(true));
            }
        );
    });
}

function registerTookanFieldRoutes(app, db) {
    const page = (name) => (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', name));
    };
    app.get('/services', page('services.html'));
    app.get('/field-force', page('field-force.html'));

    app.get('/api/public/field/services', (req, res) => {
        ensureSchema(db, () => {
            db.all(
                `SELECT * FROM field_services WHERE COALESCE(active, 1) = 1 ORDER BY id`,
                [],
                (err, rows) => {
                    if (err) return sendError(res, err);
                    res.json({ services: (rows || []).map(publicService) });
                }
            );
        });
    });

    app.post('/api/public/field/bookings', (req, res) => {
        ensureSchema(db, () => {
            const body = req.body || {};
            const serviceId = parseInt(body.serviceId, 10);
            if (!Number.isFinite(serviceId)) return res.status(400).json({ error: 'Choose a service.' });
            const token = String(body.clientToken || '').trim().slice(0, 64);
            const start = () => {
                readService(db, serviceId, (err, service) => {
                    if (err) return sendError(res, err);
                    if (!service || Number(service.active) === 0) return res.status(404).json({ error: 'That service is not available.' });
                    let spec;
                    try {
                        spec = bookingInput(body, service);
                    } catch (inputErr) {
                        return sendError(res, inputErr);
                    }
                    spec.serviceId = service.id;
                    spec.serviceName = service.name;
                    spec.clientToken = token;
                    loadConfig(db, (cfgErr, cfg) => {
                        if (cfgErr) return sendError(res, cfgErr);
                        placeBooking(db, cfg, spec, (bookErr, row) => {
                            if (bookErr) return sendError(res, bookErr);
                            res.json({ success: true, booking: customerBooking(row) });
                        });
                    });
                });
            };
            if (!token) return start();
            db.get(`SELECT * FROM field_bookings WHERE client_token = ? ORDER BY id DESC LIMIT 1`, [token], (err, existing) => {
                if (!err && existing) return res.json({ success: true, booking: customerBooking(existing), existing: true });
                start();
            });
        });
    });

    app.post('/api/public/field/bookings/lookup', (req, res) => {
        ensureSchema(db, () => {
            const code = String((req.body && req.body.code) || '').trim();
            const phone = req.body && req.body.phone;
            if (!code) return res.status(400).json({ error: 'Enter the booking code.' });
            db.get(`SELECT * FROM field_bookings WHERE code = ?`, [code], (err, row) => {
                if (err) return sendError(res, err);
                if (!row || !field.phoneMatches(row.customer_phone, phone)) {
                    return res.status(404).json({ error: 'No visit matches that code and phone.' });
                }
                loadConfig(db, (cfgErr, cfg) => {
                    if (cfgErr || !row.tookan_job_id || !cfg || !cfg.tookan.enabled) {
                        return res.json({ booking: customerBooking(row) });
                    }
                    field.readTask(cfg, row.tookan_job_id).then((task) => {
                        const mapped = field.bookingFromJob(task.jobStatus);
                        const sets = ['job_status = ?'];
                        const params = [task.jobStatus];
                        if (mapped) {
                            sets.push('status = ?');
                            params.push(mapped.status);
                        }
                        if (task.fleetName) {
                            sets.push('fleet_name = ?');
                            params.push(task.fleetName);
                        }
                        if (task.fleetPhone) {
                            sets.push('fleet_phone = ?');
                            params.push(task.fleetPhone);
                        }
                        if (task.fleetId) {
                            sets.push('fleet_id = ?');
                            params.push(task.fleetId);
                        }
                        if (task.trackingLink) {
                            sets.push('tracking_link = ?');
                            params.push(task.trackingLink);
                        }
                        updateBooking(db, row.id, sets, params, (upErr, fresh) => {
                            const current = fresh || row;
                            const reply = customerBooking(current);
                            if (current.fleet_id && ['assigned', 'started', 'arrived'].indexOf(current.status) >= 0) {
                                return field.agentLocation(cfg, current.fleet_id).then((loc) => {
                                    reply.partnerLatitude = loc.latitude;
                                    reply.partnerLongitude = loc.longitude;
                                    res.json({ booking: reply });
                                }).catch(() => res.json({ booking: reply }));
                            }
                            res.json({ booking: reply });
                        });
                    }).catch(() => res.json({ booking: customerBooking(row) }));
                });
            });
        });
    });

    app.post('/api/public/field/bookings/cancel', (req, res) => {
        ensureSchema(db, () => {
            const code = String((req.body && req.body.code) || '').trim();
            const phone = req.body && req.body.phone;
            db.get(`SELECT * FROM field_bookings WHERE code = ?`, [code], (err, row) => {
                if (err) return sendError(res, err);
                if (!row || !field.phoneMatches(row.customer_phone, phone)) {
                    return res.status(404).json({ error: 'No visit matches that code and phone.' });
                }
                if (row.status === 'completed') return res.status(409).json({ error: 'This visit is already complete.' });
                if (row.status === 'cancelled') return res.json({ success: true, booking: customerBooking(row) });
                const mark = () => updateBooking(db, row.id, ['status = ?'], ['cancelled'], (upErr, fresh) => {
                    if (upErr) return sendError(res, upErr);
                    res.json({ success: true, booking: customerBooking(fresh) });
                });
                if (!row.tookan_job_id) return mark();
                loadConfig(db, (cfgErr, cfg) => {
                    if (cfgErr) return sendError(res, cfgErr);
                    field.cancelTask(cfg, row.tookan_job_id).then(mark).catch((cancelErr) => sendError(res, cancelErr));
                });
            });
        });
    });

    app.get('/api/admin/field/services', guard(db, (req, res) => {
        db.all(`SELECT * FROM field_services ORDER BY id`, [], (err, rows) => {
            if (err) return sendError(res, err);
            res.json({ services: (rows || []).map(publicService) });
        });
    }));

    app.post('/api/admin/field/services', guard(db, (req, res) => {
        const body = req.body || {};
        const name = String(body.name || '').trim().slice(0, 80);
        if (name.length < 2) return res.status(400).json({ error: 'Enter a service name.' });
        const duration = Math.min(480, Math.max(15, parseInt(body.durationMin, 10) || 60));
        const kind = field.kindOf(body.kind);
        const price = body.price === '' || body.price == null ? null : Number(body.price);
        db.run(
            `INSERT INTO field_services (name, summary, duration_min, price, team_id, tags, kind, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [name, String(body.summary || '').slice(0, 240), duration, Number.isFinite(price) ? price : null, String(body.teamId || '').slice(0, 20), String(body.tags || '').slice(0, 120), kind],
            function (err) {
                if (err) return sendError(res, err);
                readService(db, this.lastID, (e2, row) => {
                    if (e2) return sendError(res, e2);
                    res.json({ success: true, service: publicService(row) });
                });
            }
        );
    }));

    app.post('/api/admin/field/services/:id', guard(db, (req, res) => {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        readService(db, id, (err, row) => {
            if (err) return sendError(res, err);
            if (!row) return res.status(404).json({ error: 'Service not found.' });
            const active = body.active === 0 || body.active === false || body.active === '0' ? 0 : 1;
            const name = String(body.name || row.name).trim().slice(0, 80);
            const duration = body.durationMin != null ? Math.min(480, Math.max(15, parseInt(body.durationMin, 10) || 60)) : row.duration_min;
            db.run(
                `UPDATE field_services SET name = ?, summary = ?, duration_min = ?, team_id = ?, tags = ?, kind = ?, active = ? WHERE id = ?`,
                [
                    name,
                    body.summary != null ? String(body.summary).slice(0, 240) : row.summary,
                    duration,
                    body.teamId != null ? String(body.teamId).slice(0, 20) : row.team_id,
                    body.tags != null ? String(body.tags).slice(0, 120) : row.tags,
                    body.kind != null ? field.kindOf(body.kind) : row.kind,
                    body.active == null ? row.active : active,
                    id
                ],
                (e2) => {
                    if (e2) return sendError(res, e2);
                    readService(db, id, (e3, fresh) => res.json({ success: true, service: publicService(fresh) }));
                }
            );
        });
    }));

    app.get('/api/admin/field/bookings', guard(db, (req, res) => {
        db.all(`SELECT * FROM field_bookings ORDER BY start_at DESC, id DESC LIMIT 200`, [], (err, rows) => {
            if (err) return sendError(res, err);
            res.json({ bookings: (rows || []).map(publicBooking) });
        });
    }));

    app.post('/api/admin/field/bookings', guard(db, (req, res) => {
        const body = req.body || {};
        const serviceId = parseInt(body.serviceId, 10);
        const go = (service) => {
            let spec;
            try {
                spec = bookingInput(body, service);
            } catch (inputErr) {
                return sendError(res, inputErr);
            }
            spec.serviceId = service ? service.id : null;
            spec.serviceName = service ? service.name : String(body.serviceName || (spec.kind === 'fos' ? 'Field visit' : 'Appointment')).slice(0, 80);
            spec.fleetName = String(body.fleetName || '').slice(0, 80);
            loadConfig(db, (cfgErr, cfg) => {
                if (cfgErr) return sendError(res, cfgErr);
                placeBooking(db, cfg, spec, (bookErr, row) => {
                    if (bookErr) return sendError(res, bookErr);
                    res.json({ success: true, booking: publicBooking(row) });
                });
            });
        };
        if (!Number.isFinite(serviceId)) return go(null);
        readService(db, serviceId, (err, service) => {
            if (err) return sendError(res, err);
            if (!service) return res.status(404).json({ error: 'Service not found.' });
            go(service);
        });
    }));

    app.post('/api/admin/field/bookings/:id/assign', guard(db, (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(`SELECT * FROM field_bookings WHERE id = ?`, [id], (err, row) => {
            if (err) return sendError(res, err);
            if (!row) return res.status(404).json({ error: 'Visit not found.' });
            const fleetId = req.body && req.body.fleetId;
            const teamId = (req.body && req.body.teamId) || row.team_id;
            const fleetName = String((req.body && req.body.fleetName) || '').slice(0, 80);
            loadConfig(db, (cfgErr, cfg) => {
                if (cfgErr) return sendError(res, cfgErr);
                field.assignAgent(cfg, { fleetId: fleetId, jobId: row.tookan_job_id, teamId: teamId, jobStatus: '0' }).then(() => {
                    updateBooking(db, id, ['fleet_id = ?', 'fleet_name = ?', 'team_id = ?', 'status = ?'], [String(fleetId), fleetName, teamId ? String(teamId) : row.team_id, 'assigned'], (upErr, fresh) => {
                        if (upErr) return sendError(res, upErr);
                        res.json({ success: true, booking: publicBooking(fresh) });
                    });
                }).catch((assignErr) => sendError(res, assignErr));
            });
        });
    }));

    app.post('/api/admin/field/bookings/:id/cancel', guard(db, (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(`SELECT * FROM field_bookings WHERE id = ?`, [id], (err, row) => {
            if (err) return sendError(res, err);
            if (!row) return res.status(404).json({ error: 'Visit not found.' });
            const mark = () => updateBooking(db, id, ['status = ?'], ['cancelled'], (upErr, fresh) => {
                if (upErr) return sendError(res, upErr);
                res.json({ success: true, booking: publicBooking(fresh) });
            });
            if (!row.tookan_job_id) return mark();
            loadConfig(db, (cfgErr, cfg) => {
                if (cfgErr) return sendError(res, cfgErr);
                field.cancelTask(cfg, row.tookan_job_id).then(mark).catch((cancelErr) => sendError(res, cancelErr));
            });
        });
    }));

    app.post('/api/admin/field/bookings/:id/reschedule', guard(db, (req, res) => {
        const id = parseInt(req.params.id, 10);
        db.get(`SELECT * FROM field_bookings WHERE id = ?`, [id], (err, row) => {
            if (err) return sendError(res, err);
            if (!row) return res.status(404).json({ error: 'Visit not found.' });
            let spec;
            try {
                spec = bookingInput(Object.assign({}, req.body, { name: row.customer_name, phone: row.customer_phone, address: row.customer_address }), {
                    kind: row.kind,
                    duration_min: row.duration_min,
                    name: row.service_name
                });
            } catch (inputErr) {
                return sendError(res, inputErr);
            }
            const save = () => updateBooking(db, id, ['start_at = ?', 'end_at = ?'], [spec.start, spec.end], (upErr, fresh) => {
                if (upErr) return sendError(res, upErr);
                res.json({ success: true, booking: publicBooking(fresh) });
            });
            if (!row.tookan_job_id) return save();
            loadConfig(db, (cfgErr, cfg) => {
                if (cfgErr) return sendError(res, cfgErr);
                field.rescheduleTask(cfg, { jobId: row.tookan_job_id, start: spec.start, end: spec.end }).then(save).catch((editErr) => sendError(res, editErr));
            });
        });
    }));

    app.get('/api/admin/field/teams', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.listTeams(cfg).then((teams) => res.json({ teams: teams })).catch((listErr) => sendError(res, listErr));
        });
    }));

    app.post('/api/admin/field/teams', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.createTeam(cfg, req.body || {}).then((team) => res.json({ success: true, team: team })).catch((createErr) => sendError(res, createErr));
        });
    }));

    app.get('/api/admin/field/agents', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.listAgents(cfg, {
                teamId: req.query.teamId,
                availability: req.query.availability,
                tags: req.query.tags
            }).then((agents) => res.json({ agents: agents })).catch((listErr) => sendError(res, listErr));
        });
    }));

    app.post('/api/admin/field/agents', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.addAgent(cfg, req.body || {}).then((agent) => res.json({ success: true, agent: agent })).catch((addErr) => sendError(res, addErr));
        });
    }));

    app.get('/api/admin/field/agents/:fleetId', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.agentProfile(cfg, req.params.fleetId).then((agent) => res.json({ agent: agent })).catch((readErr) => sendError(res, readErr));
        });
    }));

    app.get('/api/admin/field/agents/:fleetId/location', guard(db, (req, res) => {
        loadConfig(db, (err, cfg) => {
            if (err) return sendError(res, err);
            field.agentLocation(cfg, req.params.fleetId).then((loc) => res.json(loc)).catch((locErr) => sendError(res, locErr));
        });
    }));
}

module.exports = {
    registerTookanFieldRoutes,
    noteTookanWebhook,
    ensureSchema,
    publicBooking,
    customerBooking,
    resetSchemaForTests() {
        schemaReady = false;
        schemaWaiters = null;
    }
};

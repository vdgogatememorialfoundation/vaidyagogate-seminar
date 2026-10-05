/**
 * Hub portal and navigator. Hubs are staff-created sorting locations.
 */
const network = require('./fleet-network');
const bookAuth = require('./book-sales-auth');
const emailService = require('./email-service');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function istDate(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
}

function istStartMs(now) {
    return Date.parse(istDate(now) + 'T00:00:00+05:30') || 0;
}

function stampMs(value) {
    const s = String(value || '').trim();
    if (!s) return 0;
    if (/[zZ]|[+-]\d{2}/.test(s)) {
        const n = Date.parse(s);
        return Number.isFinite(n) ? n : 0;
    }
    const n = Date.parse(s.replace(' ', 'T') + 'Z');
    return Number.isFinite(n) ? n : 0;
}

function publicStaff(row) {
    if (!row) return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        name: row.name,
        email: row.email,
        phone: row.phone || '',
        status: row.status,
        role: row.role,
        hubName: row.hub_name || '',
        hubCity: row.hub_city || ''
    };
}

function publicHub(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        locality: row.locality || '',
        city: row.city,
        state: row.state,
        country: row.country,
        address: row.address,
        pincode: row.pincode,
        role: row.role,
        mode: row.mode,
        active: row.active !== 0 && row.active !== false,
        fromCity: row.from_city || '',
        toCity: row.to_city || ''
    };
}

function fieldOrder(row) {
    const route = network.parseRoute(row.commerce_route_json);
    return {
        id: row.id,
        orderCode: row.order_code,
        awb: row.commerce_awb || '',
        mode: row.commerce_mode || '',
        stage: row.commerce_stage || '',
        buyerName: row.shipping_recipient_name || row.buyer_name || '',
        address: row.delivery_address || '',
        city: row.shipping_city || '',
        state: row.shipping_state || '',
        pincode: row.shipping_pincode || '',
        pickupAt: row.commerce_pickup_at || null,
        deliveryAt: row.commerce_delivery_at || null,
        openBox: network.needsOpenBox(row),
        fragile: !!row.commerce_fragile,
        heavy: !!row.commerce_heavy,
        cod: !!(row.commerce_cod || /^(cod|cash_on_delivery)$/i.test(String(row.payment_mode || ''))),
        codAmount: row.commerce_cod_amount != null ? Number(row.commerce_cod_amount) : Number(row.total_amount) || 0,
        codPaid: !!row.commerce_cod_paid,
        returnKind: row.return_kind || '',
        returnStatus: row.return_status || '',
        hyperlocalStatus: row.commerce_hyperlocal_status || '',
        route: route.map((hop) => hop.name + '- ' + hop.city),
        routeIndex: row.commerce_route_index == null ? 0 : Number(row.commerce_route_index),
        hopPhase: row.commerce_hop_phase || ''
    };
}

function logTrack(db, orderId, kind, title, city, cb) {
    const at = new Date().toISOString();
    db.run(
        `INSERT INTO book_order_events (book_order_id, event_type, title, description, meta_json) VALUES (?, ?, ?, ?, ?)`,
        [orderId, kind, title, city || '', JSON.stringify({ kind, city: city || '', source: 'commerce', at })],
        () => {
            db.run(
                `INSERT INTO book_courier_track_events (book_order_id, event_at, location, description, source, event_city, facility)
                 VALUES (?, ?, ?, ?, 'commerce', ?, ?)`,
                [orderId, at, city || '', title, city || '', kind],
                () => cb && cb()
            );
        }
    );
}

function loadRawOrder(db, id, cb) {
    db.get(
        `SELECT bo.*, u.email AS buyer_email FROM book_orders bo LEFT JOIN users u ON u.id = bo.user_id WHERE bo.id = ?`,
        [id],
        cb
    );
}

function loadByAwb(db, barcode, cb) {
    const code = String(barcode || '').replace(/\s+/g, '');
    db.get(
        `SELECT bo.*, u.email AS buyer_email FROM book_orders bo LEFT JOIN users u ON u.id = bo.user_id
         WHERE bo.commerce_awb = ? OR (bo.commerce_provider = 'fleetbase' AND bo.courier_tracking_no = ?)`,
        [code, code],
        cb
    );
}

async function emailCode(to, subject, intro, code) {
    const email = String(to || '').trim();
    if (!/@/.test(email)) return { ok: false, error: 'No email address is saved for this message.' };
    const html = '<p>' + intro + '</p><p style="font-size:22px;font-weight:800;letter-spacing:3px;">' + code + '</p>';
    const result = await emailService.sendEmail(email, subject, html, { text: intro + ' ' + code });
    if (result && result.ok) return { ok: true };
    return { ok: false, error: (result && (result.error || result.hint)) || 'Email could not be sent.' };
}

function requireStaff(db, req, res, cb) {
    const header = String(req.get('authorization') || '');
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
    db.get(
        `SELECT s.expires_at, st.*, h.name AS hub_name, h.city AS hub_city, h.role AS hub_role
         FROM commerce_hub_sessions s
         JOIN commerce_hub_staff st ON st.id = s.staff_id
         JOIN commerce_hubs h ON h.id = st.hub_id
         WHERE s.token = ?`,
        [token],
        (err, row) => {
            if (err) return res.status(500).json({ error: 'Could not check the sign-in.' });
            if (!row || stampMs(row.expires_at) < Date.now()) return res.status(401).json({ error: 'Sign in again.' });
            if (row.status === 'blocked') return res.status(403).json({ error: 'This login is blocked.' });
            if (row.status === 'disabled') return res.status(403).json({ error: 'This login is disabled.' });
            cb(row);
        }
    );
}

function requireManager(db, req, res, cb) {
    requireStaff(db, req, res, (staff) => {
        if (staff.role !== 'hub_manager') return res.status(403).json({ error: 'A hub manager has to do this.' });
        cb(staff);
    });
}

function legOf(order) {
    const status = String(order.return_status || '');
    if (['approved', 'pickup_scheduled', 'in_transit'].includes(status)) return 'return';
    return 'forward';
}

function registerFleetNetworkRoutes(app, db) {
    const path = require('path');
    const sendPage = (name) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', name));
    app.get('/hub', sendPage('hub.html'));
    app.get('/navigator', sendPage('navigator.html'));
    app.get('/track-fleetbase', sendPage('fleetbase-track.html'));
    network.ensureSchema(db, isPg(), () => {});

    app.post('/api/hub/login', (req, res) => {
        network.ensureSchema(db, isPg(), () => {
            const email = String((req.body && req.body.email) || '').trim().toLowerCase();
            const password = String((req.body && req.body.password) || '');
            db.get(
                `SELECT st.*, h.name AS hub_name, h.city AS hub_city FROM commerce_hub_staff st
                 JOIN commerce_hubs h ON h.id = st.hub_id WHERE lower(st.email) = ?`,
                [email],
                (err, row) => {
                    if (err) return res.status(500).json({ error: 'Could not sign in.' });
                    if (!row || !network.verifyPassword(password, row.password_hash)) {
                        return res.status(401).json({ error: 'Email or password is wrong.' });
                    }
                    if (row.status === 'blocked') return res.status(403).json({ error: 'This login is blocked.' });
                    if (row.status === 'disabled') return res.status(403).json({ error: 'This login is disabled.' });
                    const token = network.sessionToken();
                    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
                    db.run(`INSERT INTO commerce_hub_sessions (token, staff_id, expires_at) VALUES (?, ?, ?)`, [token, row.id, expires], (e2) => {
                        if (e2) return res.status(500).json({ error: 'Could not start the session.' });
                        res.json({ success: true, token, staff: publicStaff(row) });
                    });
                }
            );
        });
    });

    app.get('/api/hub/me', (req, res) => {
        requireStaff(db, req, res, (staff) => res.json({ success: true, staff: publicStaff(staff) }));
    });

    app.get('/api/hub/hubs', (req, res) => {
        requireStaff(db, req, res, () => {
            db.all(`SELECT * FROM commerce_hubs ORDER BY city, name`, [], (err, rows) => {
                if (err) return res.status(500).json({ error: 'Could not load hubs.' });
                res.json({ success: true, hubs: (rows || []).map(publicHub) });
            });
        });
    });

    app.post('/api/hub/hubs', (req, res) => {
        requireManager(db, req, res, () => saveHub(db, req.body || {}, null, res));
    });

    app.post('/api/hub/drivers', (req, res) => {
        requireManager(db, req, res, (staff) => {
            const body = req.body || {};
            const name = String(body.name || '').trim();
            const email = String(body.email || '').trim().toLowerCase();
            const password = String(body.password || '');
            const role = body.role === 'hub_manager' ? 'hub_manager' : 'agent';
            const hubId = parseInt(body.hubId, 10) || staff.hub_id;
            if (!name || !/@/.test(email) || password.length < 8) {
                return res.status(400).json({ error: 'A driver needs a name, email, and a password of at least 8 characters.' });
            }
            db.get(`SELECT id FROM commerce_hubs WHERE id = ?`, [hubId], (err, hub) => {
                if (err || !hub) return res.status(400).json({ error: 'Choose a hub for this driver.' });
                db.get(`SELECT id FROM commerce_hub_staff WHERE lower(email) = ?`, [email], (e2, existing) => {
                    if (existing) return res.status(400).json({ error: 'That email already has a hub login.' });
                    db.run(
                        `INSERT INTO commerce_hub_staff (hub_id, name, email, phone, password_hash, status, role) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
                        [hubId, name, email, String(body.phone || '').trim(), network.hashPassword(password), role],
                        function (e3) {
                            if (e3) return res.status(500).json({ error: 'Could not add the driver.' });
                            res.json({ success: true, id: this.lastID });
                        }
                    );
                });
            });
        });
    });

    app.get('/api/hub/drivers', (req, res) => {
        requireStaff(db, req, res, () => {
            db.all(
                `SELECT st.id, st.hub_id, st.name, st.email, st.phone, st.status, st.role, h.name AS hub_name, h.city AS hub_city
                 FROM commerce_hub_staff st JOIN commerce_hubs h ON h.id = st.hub_id ORDER BY st.name`,
                [],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Could not load drivers.' });
                    res.json({ success: true, drivers: rows || [] });
                }
            );
        });
    });

    app.get('/api/hub/drivers/:id', (req, res) => {
        requireStaff(db, req, res, () => {
            const id = parseInt(req.params.id, 10);
            db.get(
                `SELECT st.id, st.hub_id, st.name, st.email, st.phone, st.status, st.role, h.name AS hub_name, h.city AS hub_city
                 FROM commerce_hub_staff st JOIN commerce_hubs h ON h.id = st.hub_id WHERE st.id = ?`,
                [id],
                (err, row) => {
                    if (err || !row) return res.status(404).json({ error: 'Driver not found.' });
                    db.all(
                        `SELECT kind, barcode, created_at FROM commerce_scans WHERE agent_id = ? ORDER BY id DESC LIMIT 30`,
                        [id],
                        (e2, scans) => res.json({ success: true, driver: row, scans: scans || [] })
                    );
                }
            );
        });
    });

    app.post('/api/hub/drivers/:id/status', (req, res) => {
        requireManager(db, req, res, () => {
            const status = String((req.body && req.body.status) || '');
            if (!network.STAFF_STATUSES.includes(status)) return res.status(400).json({ error: 'Status must be active, blocked, or disabled.' });
            db.run(`UPDATE commerce_hub_staff SET status = ? WHERE id = ?`, [status, parseInt(req.params.id, 10)], function (err) {
                if (err || !this.changes) return res.status(404).json({ error: 'Driver not found.' });
                res.json({ success: true, status });
            });
        });
    });

    app.post('/api/hub/drivers/:id/password', (req, res) => {
        requireManager(db, req, res, () => {
            const password = String((req.body && req.body.password) || '');
            if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
            db.run(`UPDATE commerce_hub_staff SET password_hash = ? WHERE id = ?`, [network.hashPassword(password), parseInt(req.params.id, 10)], function (err) {
                if (err || !this.changes) return res.status(404).json({ error: 'Driver not found.' });
                res.json({ success: true });
            });
        });
    });

    app.get('/api/hub/bags', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const mode = req.query.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            db.all(`SELECT * FROM commerce_bags WHERE hub_id = ? AND mode = ? ORDER BY id DESC LIMIT 100`, [staff.hub_id, mode], (err, rows) => {
                if (err) return res.status(500).json({ error: 'Could not load bags.' });
                res.json({ success: true, bags: rows || [] });
            });
        });
    });

    app.post('/api/hub/bags', (req, res) => {
        requireManager(db, req, res, (staff) => {
            const mode = req.body && req.body.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            const code = 'BAG' + String(network.newAwb()).slice(0, 8);
            db.run(`INSERT INTO commerce_bags (hub_id, code, status, mode) VALUES (?, ?, 'open', ?)`, [staff.hub_id, code, mode], function (err) {
                if (err) return res.status(500).json({ error: 'Could not create the bag.' });
                res.json({ success: true, id: this.lastID, code });
            });
        });
    });

    app.get('/api/hub/trips', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const mode = req.query.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            db.all(
                `SELECT t.*, fh.name AS from_name, th.name AS to_name, st.name AS driver_name
                 FROM commerce_trips t
                 JOIN commerce_hubs fh ON fh.id = t.from_hub_id
                 JOIN commerce_hubs th ON th.id = t.to_hub_id
                 LEFT JOIN commerce_hub_staff st ON st.id = t.driver_id
                 WHERE t.mode = ? AND (t.from_hub_id = ? OR t.to_hub_id = ?)
                 ORDER BY t.id DESC LIMIT 100`,
                [mode, staff.hub_id, staff.hub_id],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Could not load trips.' });
                    res.json({ success: true, trips: rows || [] });
                }
            );
        });
    });

    app.post('/api/hub/trips', (req, res) => {
        requireManager(db, req, res, (staff) => {
            const toHub = parseInt(req.body && req.body.toHubId, 10);
            const driverId = parseInt(req.body && req.body.driverId, 10) || null;
            const mode = req.body && req.body.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            if (!toHub || toHub === staff.hub_id) return res.status(400).json({ error: 'Choose the hub this trip goes to.' });
            db.get(`SELECT id FROM commerce_hubs WHERE id = ? AND active = 1`, [toHub], (err, hub) => {
                if (err || !hub) return res.status(400).json({ error: 'That destination hub is not active.' });
                db.run(
                    `INSERT INTO commerce_trips (from_hub_id, to_hub_id, driver_id, status, mode) VALUES (?, ?, ?, 'planned', ?)`,
                    [staff.hub_id, toHub, driverId, mode],
                    function (e2) {
                        if (e2) return res.status(500).json({ error: 'Could not create the trip.' });
                        res.json({ success: true, id: this.lastID });
                    }
                );
            });
        });
    });

    app.post('/api/hub/scan', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const kind = req.body && req.body.kind === 'dispatch' ? 'dispatch' : req.body && req.body.kind === 'receive' ? 'receive' : '';
            if (!kind) return res.status(400).json({ error: 'Choose receive or dispatch.' });
            loadByAwb(db, req.body && req.body.barcode, (err, order) => {
                if (err) return res.status(500).json({ error: 'Could not read the shipment.' });
                if (!order || !network.scanMatches(order.commerce_awb, req.body.barcode)) {
                    return res.status(400).json({ error: 'Scan the 12-digit AWB on the shipping label.' });
                }
                const route = network.parseRoute(order.commerce_route_json);
                const index = order.commerce_route_index == null ? 0 : Number(order.commerce_route_index);
                const hop = route[index];
                if (!hop) return res.status(400).json({ error: 'This shipment has no hub on its route.' });
                if (Number(hop.id) !== Number(staff.hub_id)) {
                    return res.status(400).json({ error: 'This shipment is for ' + hop.name + ', not this hub.' });
                }
                const phase = order.commerce_hop_phase || 'expect_receive';
                if (kind === 'receive' && phase !== 'expect_receive') return res.status(400).json({ error: 'This shipment is already received at this hub.' });
                if (kind === 'dispatch' && phase !== 'at_hub') return res.status(400).json({ error: 'Receive this shipment before dispatching it.' });
                if (kind === 'dispatch' && index >= route.length - 1) {
                    return res.status(400).json({ error: 'This is the last hub. Add the shipment to a runsheet.' });
                }
                const leg = legOf(order);
                db.run(
                    `INSERT INTO commerce_scans (order_id, hub_id, agent_id, kind, barcode, leg) VALUES (?, ?, ?, ?, ?, ?)`,
                    [order.id, staff.hub_id, staff.id, kind, String(order.commerce_awb), leg],
                    (e2) => {
                        if (e2) return res.status(500).json({ error: 'Could not save the scan.' });
                        if (kind === 'receive') {
                            const title = network.receivedLine(hop);
                            db.run(
                                `UPDATE book_orders SET commerce_hop_phase = 'at_hub', commerce_stage = CASE WHEN commerce_stage = 'delivered' THEN commerce_stage ELSE 'in_transit' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [order.id],
                                () => logTrack(db, order.id, 'arrived_facility', title, hop.city, () => res.json({ success: true, tracking: title, order: fieldOrder(Object.assign({}, order, { commerce_hop_phase: 'at_hub' })) }))
                            );
                            return;
                        }
                        const title = network.leftLine(hop);
                        db.run(
                            `UPDATE book_orders SET commerce_route_index = ?, commerce_hop_phase = 'expect_receive', commerce_stage = 'in_transit', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [index + 1, order.id],
                            () => logTrack(db, order.id, 'left_facility', title, hop.city, () => res.json({ success: true, tracking: title }))
                        );
                    }
                );
            });
        });
    });

    app.get('/api/hub/orders', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const mode = req.query.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            const direction = req.query.direction === 'outgoing' ? 'outgoing' : 'receiving';
            db.all(
                `SELECT * FROM book_orders WHERE commerce_provider = 'fleetbase' AND COALESCE(commerce_mode, '') = ? ORDER BY id DESC LIMIT 300`,
                [mode],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Could not load orders.' });
                    const list = (rows || []).filter((row) => {
                        const route = network.parseRoute(row.commerce_route_json);
                        const index = row.commerce_route_index == null ? 0 : Number(row.commerce_route_index);
                        const hop = route[index];
                        if (!hop || Number(hop.id) !== Number(staff.hub_id)) return false;
                        if (direction === 'outgoing') return row.commerce_hop_phase === 'at_hub' && index < route.length - 1;
                        return (row.commerce_hop_phase || 'expect_receive') === 'expect_receive';
                    });
                    res.json({
                        success: true,
                        orders: list.map(fieldOrder),
                        pickupAt: list.map((row) => row.commerce_pickup_at).filter(Boolean),
                        deliveryAt: list.map((row) => row.commerce_delivery_at).filter(Boolean)
                    });
                }
            );
        });
    });

    app.post('/api/hub/runsheets', (req, res) => {
        requireManager(db, req, res, (staff) => {
            const agentId = parseInt(req.body && req.body.agentId, 10);
            const ids = Array.isArray(req.body && req.body.orderIds) ? req.body.orderIds.map((id) => parseInt(id, 10)).filter(Boolean) : [];
            const mode = req.body && req.body.mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            if (!agentId || !ids.length) return res.status(400).json({ error: 'Choose an agent and the shipments received today.' });
            db.get(`SELECT id, hub_id, status, role FROM commerce_hub_staff WHERE id = ?`, [agentId], (err, agent) => {
                if (err || !agent || Number(agent.hub_id) !== Number(staff.hub_id) || agent.status !== 'active') {
                    return res.status(400).json({ error: 'Choose an active agent allotted to this hub.' });
                }
                const start = istStartMs();
                db.all(`SELECT order_id, created_at FROM commerce_scans WHERE hub_id = ? AND kind = 'receive'`, [staff.hub_id], (e2, scans) => {
                    const today = new Set((scans || []).filter((scan) => stampMs(scan.created_at) >= start).map((scan) => Number(scan.order_id)));
                    db.all(`SELECT * FROM book_orders WHERE id IN (${ids.map(() => '?').join(',')})`, ids, (e3, orders) => {
                        if (e3) return res.status(500).json({ error: 'Could not read the shipments.' });
                        const ready = (orders || []).filter((order) => {
                            const route = network.parseRoute(order.commerce_route_json);
                            const index = order.commerce_route_index == null ? 0 : Number(order.commerce_route_index);
                            const hop = route[index];
                            return hop && Number(hop.id) === Number(staff.hub_id) && order.commerce_hop_phase === 'at_hub' && today.has(Number(order.id)) && index === route.length - 1;
                        });
                        if (ready.length !== ids.length) {
                            return res.status(400).json({ error: 'A runsheet can include only shipments this hub received today at the end of the route.' });
                        }
                        db.run(
                            `INSERT INTO commerce_runsheets (hub_id, agent_id, mode, status, service_date) VALUES (?, ?, ?, 'out_for_delivery', ?)`,
                            [staff.hub_id, agentId, mode, istDate()],
                            function (e4) {
                                if (e4) return res.status(500).json({ error: 'Could not create the runsheet.' });
                                const runId = this.lastID;
                                let left = ready.length;
                                ready.forEach((order) => {
                                    db.run(`INSERT INTO commerce_runsheet_orders (runsheet_id, order_id, leg) VALUES (?, ?, ?)`, [runId, order.id, legOf(order)], () => {
                                        db.run(`UPDATE book_orders SET commerce_stage = 'out_for_delivery', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND commerce_stage <> 'delivered'`, [order.id], () => {
                                            logTrack(db, order.id, 'out_for_delivery', 'Your order is out for delivery', '', () => {
                                                left -= 1;
                                                if (!left) res.json({ success: true, id: runId, orders: ready.length });
                                            });
                                        });
                                    });
                                });
                            }
                        );
                    });
                });
            });
        });
    });

    app.get('/api/hub/runsheets', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            db.all(
                `SELECT r.*, st.name AS agent_name FROM commerce_runsheets r JOIN commerce_hub_staff st ON st.id = r.agent_id
                 WHERE r.hub_id = ? ORDER BY r.id DESC LIMIT 50`,
                [staff.hub_id],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Could not load runsheets.' });
                    res.json({ success: true, runsheets: rows || [] });
                }
            );
        });
    });

    app.get('/api/hub/slots', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            loadShop(db, (shop) => {
                db.all(`SELECT * FROM commerce_delivery_slots WHERE hub_id = ? OR hub_id IS NULL ORDER BY service_date, start_time`, [staff.hub_id], (err, rows) => {
                    res.json({ success: true, slots: network.slotsForHub(shop, rows || [], Date.now()) });
                });
            });
        });
    });

    app.post('/api/hub/slots', (req, res) => {
        requireManager(db, req, res, (staff) => {
            const date = String((req.body && req.body.date) || '');
            const start = String((req.body && req.body.start) || '');
            const end = String((req.body && req.body.end) || '');
            const enabled = req.body && req.body.enabled === false ? 0 : 1;
            loadShop(db, (shop) => {
                const shipment = require('./shipment-engine');
                if (!shipment.slotAllowed(shop, date, start, end)) {
                    return res.status(400).json({ error: 'That slot is outside the store delivery hours.' });
                }
                db.run(
                    `INSERT INTO commerce_delivery_slots (hub_id, service_date, start_time, end_time, enabled, mode) VALUES (?, ?, ?, ?, ?, 'both')`,
                    [staff.hub_id, date, start, end, enabled],
                    function (err) {
                        if (err) return res.status(500).json({ error: 'Could not save the slot.' });
                        res.json({ success: true, id: this.lastID });
                    }
                );
            });
        });
    });

    app.get('/api/navigator/work', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            db.all(
                `SELECT bo.* FROM commerce_runsheet_orders ro
                 JOIN commerce_runsheets r ON r.id = ro.runsheet_id
                 JOIN book_orders bo ON bo.id = ro.order_id
                 WHERE r.agent_id = ? AND r.service_date = ? AND bo.commerce_stage <> 'delivered'`,
                [staff.id, istDate()],
                (err, runsheetOrders) => {
                    db.all(`SELECT * FROM commerce_hl_offers WHERE hub_id = ? AND status IN ('offered', 'accepted')`, [staff.hub_id], (e2, offers) => {
                        const offerIds = (offers || []).filter((row) => row.status === 'offered' || Number(row.agent_id) === Number(staff.id)).map((row) => row.order_id);
                        const finish = (extra) => {
                            loadConfigAsync(db).then((cfg) => {
                                db.all(
                                    `SELECT * FROM book_orders WHERE commerce_provider = 'fleetbase' AND commerce_awb IS NOT NULL AND ((commerce_mode = 'logistics' AND commerce_stage IN ('ready', 'pickup_scheduled')) OR return_status = 'pickup_scheduled') ORDER BY id DESC LIMIT 80`,
                                    [],
                                    (e4, waiting) => {
                                        db.all(`SELECT order_id FROM commerce_scans WHERE kind = 'pickup'`, [], (e5, scans) => {
                                            const picked = new Set((scans || []).map((row) => Number(row.order_id)));
                                            db.all(`SELECT * FROM commerce_hubs WHERE active = 1`, [], (e6, hubs) => {
                                                const seller = network.sellerPlace(cfg);
                                                const pickups = (waiting || []).filter((row) => {
                                                    if (picked.has(Number(row.id))) return false;
                                                    const returning = row.return_status === 'pickup_scheduled';
                                                    const origin = returning ? network.dropPlace(row) : seller;
                                                    const dest = returning ? seller : { city: '\u0000', address: '', pincode: '' };
                                                    const hop = network.planRoute(hubs || [], origin, dest, 'logistics')[0];
                                                    return hop && Number(hop.id) === Number(staff.hub_id);
                                                });
                                                res.json({
                                                    success: true,
                                                    hub: { id: staff.hub_id, name: staff.hub_name, city: staff.hub_city },
                                                    pickups: pickups.map(fieldOrder),
                                                    runsheet: (runsheetOrders || []).map(fieldOrder),
                                                    offers: (extra || []).map(fieldOrder)
                                                });
                                            });
                                        });
                                    }
                                );
                            });
                        };
                        if (!offerIds.length) return finish([]);
                        db.all(`SELECT * FROM book_orders WHERE id IN (${offerIds.map(() => '?').join(',')})`, offerIds, (e3, rows) => finish(rows || []));
                    });
                }
            );
        });
    });

    app.post('/api/navigator/orders/:id/accept', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const id = parseInt(req.params.id, 10);
            db.get(`SELECT * FROM commerce_hl_offers WHERE order_id = ? AND hub_id = ? AND status = 'offered'`, [id, staff.hub_id], (err, offer) => {
                if (err || !offer) return res.status(400).json({ error: 'This order is not waiting at your hub.' });
                db.run(`UPDATE commerce_hl_offers SET status = 'accepted', agent_id = ? WHERE id = ?`, [staff.id, offer.id], () => {
                    db.run(`UPDATE commerce_hl_offers SET status = 'passed' WHERE order_id = ? AND id <> ? AND status = 'offered'`, [id, offer.id], () => {
                        db.run(`UPDATE book_orders SET commerce_hyperlocal_status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], () => {
                            res.json({ success: true });
                        });
                    });
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/send-code', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const purpose = String((req.body && req.body.purpose) || '');
            loadRawOrder(db, parseInt(req.params.id, 10), async (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found.' });
                if (!agentCanTouch(staff, order)) return res.status(403).json({ error: 'This order is not allotted to your hub.' });
                const code = network.newCode(6);
                let to = '';
                let column = '';
                let intro = '';
                if (purpose === 'pickup') {
                    const cfg = await loadConfigAsync(db);
                    to = cfg.storeEmail;
                    column = 'pickup_otp';
                    intro = 'Your pickup code for order ' + order.order_code + ' is below. Give it to the delivery partner.';
                } else if (purpose === 'delivery') {
                    to = order.buyer_email;
                    column = 'delivery_otp';
                    intro = 'Your delivery code for order ' + order.order_code + ' is below. Tell it to the delivery partner.';
                } else if (purpose === 'obd') {
                    if (!network.needsOpenBox(order)) return res.status(400).json({ error: 'This shipment does not need an open-box code.' });
                    to = order.buyer_email;
                    column = 'commerce_obd_otp';
                    intro = 'Your open-box code for order ' + order.order_code + ' is below. The delivery partner enters it after opening the item.';
                } else if (purpose === 'cancel') {
                    to = order.buyer_email;
                    column = 'commerce_cancel_code';
                    intro = 'Your cancellation code for order ' + order.order_code + ' is below.';
                } else {
                    return res.status(400).json({ error: 'Choose a pickup, delivery, open-box, or cancellation code.' });
                }
                const sent = await emailCode(to, 'Gogate Products code', intro, code);
                if (!sent.ok) return res.status(400).json({ error: sent.error });
                db.run(`UPDATE book_orders SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [code, order.id], (e2) => {
                    if (e2) return res.status(500).json({ error: 'The email was sent but the code could not be saved.' });
                    res.json({ success: true, emailed: true });
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/pickup', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            loadRawOrder(db, parseInt(req.params.id, 10), (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found.' });
                if (!network.scanMatches(order.commerce_awb, req.body && req.body.barcode)) {
                    return res.status(400).json({ error: 'Scan the 12-digit AWB before pickup.' });
                }
                const hyper = order.commerce_mode === 'hyperlocal';
                const leg = legOf(order);
                const savePickup = () => {
                    db.run(
                        `INSERT INTO commerce_scans (order_id, hub_id, agent_id, kind, barcode, leg) VALUES (?, ?, ?, 'pickup', ?, ?)`,
                        [order.id, staff.hub_id, staff.id, String(order.commerce_awb), leg],
                        (e2) => {
                            if (e2) return res.status(500).json({ error: 'Could not save the pickup scan.' });
                            const after = () => {
                                db.run(
                                    `UPDATE book_orders SET commerce_stage = CASE WHEN commerce_stage = 'delivered' THEN commerce_stage ELSE 'in_transit' END,
                                     commerce_hyperlocal_status = CASE WHEN commerce_mode = 'hyperlocal' THEN 'picked' ELSE commerce_hyperlocal_status END,
                                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                    [order.id],
                                    () => logTrack(db, order.id, 'picked_up', 'Your item has been picked up by courier partner', '', () => res.json({ success: true }))
                                );
                            };
                            if (hyper) return after();
                            loadConfigAsync(db).then((cfg) => {
                                network.assignRoute(db, order, cfg, leg, (e3) => {
                                    if (e3) return res.status(500).json({ error: 'Pickup was scanned, but the hub route could not be saved.' });
                                    after();
                                });
                            });
                        }
                    );
                };
                if (hyper) {
                    const otp = String((req.body && req.body.otp) || '').trim();
                    if (!/^\d{6}$/.test(String(order.pickup_otp || '')) || otp !== String(order.pickup_otp)) {
                        return res.status(400).json({ error: 'Enter the 6-digit pickup code emailed to the seller.' });
                    }
                    return db.get(
                        `SELECT id FROM commerce_hl_offers WHERE order_id = ? AND agent_id = ? AND status = 'accepted'`,
                        [order.id, staff.id],
                        (eOffer, offer) => {
                            if (eOffer || !offer) return res.status(403).json({ error: 'Accept this order from your hub before pickup.' });
                            savePickup();
                        }
                    );
                }
                loadConfigAsync(db).then((cfg) => {
                    db.all(`SELECT * FROM commerce_hubs WHERE active = 1`, [], (eHub, hubs) => {
                        const seller = network.sellerPlace(cfg);
                        const returning = order.return_status === 'pickup_scheduled';
                        const origin = returning ? network.dropPlace(order) : seller;
                        const dest = returning ? seller : { city: '\u0000', address: '', pincode: '' };
                        const expected = network.planRoute(hubs || [], origin, dest, 'logistics')[0];
                        if (!expected) return res.status(400).json({ error: 'No hub is allotted for this pickup yet.' });
                        if (Number(expected.id) !== Number(staff.hub_id)) {
                            return res.status(403).json({ error: 'This pickup is allotted to ' + expected.name + '.' });
                        }
                        savePickup();
                    });
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/deliver', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            loadRawOrder(db, parseInt(req.params.id, 10), (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found.' });
                if (!network.scanMatches(order.commerce_awb, req.body && req.body.barcode)) {
                    return res.status(400).json({ error: 'Scan the 12-digit AWB before delivery.' });
                }
                const hyper = order.commerce_mode === 'hyperlocal';
                const gateSql = hyper
                    ? `SELECT id FROM commerce_hl_offers WHERE order_id = ? AND agent_id = ? AND status = 'accepted'`
                    : `SELECT ro.id FROM commerce_runsheet_orders ro JOIN commerce_runsheets r ON r.id = ro.runsheet_id WHERE ro.order_id = ? AND r.agent_id = ?`;
                return db.get(gateSql, [order.id, staff.id], (gateErr, gate) => {
                if (gateErr || !gate) {
                    return res.status(403).json({ error: hyper ? 'Accept this order before delivery.' : 'This order is not on your runsheet.' });
                }
                if (hyper) {
                    const otp = String((req.body && req.body.deliveryOtp) || '').trim();
                    if (!/^\d{6}$/.test(String(order.delivery_otp || '')) || otp !== String(order.delivery_otp)) {
                        return res.status(400).json({ error: 'Enter the 6-digit delivery code emailed to the customer.' });
                    }
                }
                const check = network.obdAnswersOk(
                    {
                        fragile: order.commerce_fragile,
                        heavy: order.commerce_heavy,
                        openBox: order.commerce_open_box,
                        shippingPhone: order.shipping_phone,
                        buyerPhone: order.buyer_phone,
                        obdOtp: order.commerce_obd_otp
                    },
                    req.body || {}
                );
                if (!check.ok) return res.status(400).json({ error: check.error });
                const cod = !!(order.commerce_cod || /^(cod|cash_on_delivery)$/i.test(String(order.payment_mode || '')));
                if (cod && !order.commerce_cod_paid && !(req.body && req.body.cashReceived === true)) {
                    return res.status(400).json({ error: 'Collect the cash or record the Razorpay QR payment before completing delivery.' });
                }
                db.run(
                    `INSERT INTO commerce_scans (order_id, hub_id, agent_id, kind, barcode, leg) VALUES (?, ?, ?, 'delivery', ?, ?)`,
                    [order.id, staff.hub_id, staff.id, String(order.commerce_awb), legOf(order)],
                    (e2) => {
                        if (e2) return res.status(500).json({ error: 'Could not save the delivery scan.' });
                        const note = check.damaged ? 'Item marked damaged at open-box delivery' : '';
                        db.run(
                            `UPDATE book_orders SET commerce_stage = 'delivered', status = 'delivered', commerce_hyperlocal_status = CASE WHEN commerce_mode = 'hyperlocal' THEN 'delivered' ELSE commerce_hyperlocal_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [order.id],
                            () => {
                                logTrack(db, order.id, 'delivered', 'Your order has been delivered', '', () => {
                                    if (!note) return res.json({ success: true });
                                    logTrack(db, order.id, 'update', note, '', () => res.json({ success: true, damaged: true }));
                                });
                            }
                        );
                    }
                );
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/cancel', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            loadRawOrder(db, parseInt(req.params.id, 10), async (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found.' });
                const code = String((req.body && req.body.code) || '').trim();
                if (!/^\d{6}$/.test(String(order.commerce_cancel_code || '')) || code !== String(order.commerce_cancel_code)) {
                    return res.status(400).json({ error: 'Enter the cancellation code that was emailed.' });
                }
                db.run(
                    `UPDATE book_orders SET status = 'cancelled', commerce_hyperlocal_status = CASE WHEN commerce_mode = 'hyperlocal' THEN 'cancelled' ELSE commerce_hyperlocal_status END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'delivered'`,
                    [order.id],
                    function (e2) {
                        if (e2) return res.status(500).json({ error: 'Could not cancel the order.' });
                        logTrack(db, order.id, 'update', 'Shipment cancelled', '', () => res.json({ success: true }));
                    }
                );
            });
        });
    });

    app.post('/api/navigator/orders/:id/cod-qr', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            loadRawOrder(db, parseInt(req.params.id, 10), (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found.' });
                const cod = !!(order.commerce_cod || /^(cod|cash_on_delivery)$/i.test(String(order.payment_mode || '')));
                if (!cod) return res.status(400).json({ error: 'This order is not cash on delivery.' });
                if (order.commerce_cod_paid) return res.json({ success: true, paid: true });
                if (order.commerce_razorpay_qr_image && order.commerce_razorpay_qr_id) {
                    return res.json({ success: true, imageUrl: order.commerce_razorpay_qr_image, qrId: order.commerce_razorpay_qr_id });
                }
                liveRazorpay(db, async (keys) => {
                    if (!keys) return res.status(400).json({ error: 'Razorpay live keys are not configured.' });
                    try {
                        const qr = await network.createRazorpayQr(keys, {
                            orderCode: order.order_code,
                            id: order.id,
                            codAmount: order.commerce_cod_amount != null ? Number(order.commerce_cod_amount) : Number(order.total_amount),
                            totalAmount: Number(order.total_amount)
                        });
                        if (!qr.imageUrl) return res.status(502).json({ error: 'Razorpay did not return a QR image.' });
                        db.run(
                            `UPDATE book_orders SET commerce_razorpay_qr_id = ?, commerce_razorpay_qr_image = ? WHERE id = ?`,
                            [qr.id, qr.imageUrl, order.id],
                            (e2) => {
                                if (e2) return res.status(500).json({ error: 'The QR was created but could not be saved.' });
                                res.json({ success: true, imageUrl: qr.imageUrl, qrId: qr.id });
                            }
                        );
                    } catch (e) {
                        res.status(e.status || 502).json({ error: e.message || 'Razorpay could not create a QR.' });
                    }
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/cod-status', (req, res) => {
        requireStaff(db, req, res, () => {
            loadRawOrder(db, parseInt(req.params.id, 10), (err, order) => {
                if (err || !order || !order.commerce_razorpay_qr_id) return res.status(400).json({ error: 'This order has no Razorpay QR yet.' });
                liveRazorpay(db, async (keys) => {
                    if (!keys) return res.status(400).json({ error: 'Razorpay live keys are not configured.' });
                    const qr = await network.fetchRazorpayQr(keys, order.commerce_razorpay_qr_id);
                    const paid = !!(qr && qr.paymentAmount && qr.amountReceived >= qr.paymentAmount);
                    if (!paid) return res.json({ success: true, paid: false, imageUrl: (qr && qr.imageUrl) || order.commerce_razorpay_qr_image || '' });
                    db.run(`UPDATE book_orders SET commerce_cod_paid = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [order.id], () => {
                        res.json({ success: true, paid: true });
                    });
                });
            });
        });
    });

    app.post('/api/navigator/orders/:id/arrived', (req, res) => {
        requireStaff(db, req, res, (staff) => {
            const where = req.body && req.body.place === 'delivery' ? 'delivery' : req.body && req.body.place === 'start' ? 'start' : 'pickup';
            const title = where === 'delivery' ? 'Delivery partner reached your location' : 'Courier partner reached the pickup point';
            const kind = where === 'delivery' ? 'at_drop' : 'at_pickup';
            const id = parseInt(req.params.id, 10);
            if (where === 'start') {
                logTrack(db, id, 'to_store', 'Courier partner is on the way to pickup', '', () => res.json({ success: true }));
                return;
            }
            if (where === 'delivery') {
                db.run(`UPDATE book_orders SET commerce_stage = CASE WHEN commerce_stage IN ('delivered') THEN commerce_stage ELSE 'out_for_delivery' END WHERE id = ?`, [id], () => {
                    logTrack(db, id, kind, title, '', () => res.json({ success: true }));
                });
                return;
            }
            logTrack(db, id, kind, title, '', () => res.json({ success: true }));
        });
    });

    const guard = (opts, fn) => (req, res) => bookAuth.requireBookSalesActor(db, opts, fn)(req, res);
    app.get(
        '/api/admin/commerce/hubs',
        guard({ orders: true }, (req, res) => {
            network.ensureSchema(db, isPg(), () => {
                db.all(`SELECT * FROM commerce_hubs ORDER BY city, name`, [], (err, rows) => {
                    if (err) return res.status(500).json({ error: 'Could not load hubs.' });
                    res.json({ success: true, hubs: (rows || []).map(publicHub) });
                });
            });
        })
    );
    app.post(
        '/api/admin/commerce/hubs',
        guard({ config: true }, (req, res) => {
            network.ensureSchema(db, isPg(), () => saveHub(db, req.body || {}, null, res));
        })
    );
}

function saveHub(db, body, id, res) {
    const checked = network.validateHub(body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const hub = checked.hub;
    const params = [hub.name, hub.locality, hub.city, hub.state, hub.country, hub.address, hub.pincode, hub.role, hub.mode, hub.active, hub.from_city, hub.to_city];
    db.run(
        `INSERT INTO commerce_hubs (name, locality, city, state, country, address, pincode, role, mode, active, from_city, to_city)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
        function (err) {
            if (err) return res.status(500).json({ error: 'Could not save the hub.' });
            const hubId = this.lastID;
            const manager = body.manager && typeof body.manager === 'object' ? body.manager : null;
            if (!manager) return res.json({ success: true, id: hubId });
            const email = String(manager.email || '').trim().toLowerCase();
            const password = String(manager.password || '');
            if (!manager.name || !/@/.test(email) || password.length < 8) {
                return res.status(400).json({ error: 'The hub was saved. The manager needs a name, email, and a password of at least 8 characters.' });
            }
            db.run(
                `INSERT INTO commerce_hub_staff (hub_id, name, email, phone, password_hash, status, role) VALUES (?, ?, ?, ?, ?, 'active', 'hub_manager')`,
                [hubId, String(manager.name).trim(), email, String(manager.phone || '').trim(), network.hashPassword(password)],
                (e2) => {
                    if (e2) return res.status(400).json({ error: 'The hub was saved, but that manager email is already used.' });
                    res.json({ success: true, id: hubId });
                }
            );
        }
    );
}

function loadShop(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, ['commerce_logistics_config'], (err, row) => {
        let shop = null;
        if (row && row.value) {
            try {
                shop = JSON.parse(row.value).shop;
            } catch (_) {
                shop = null;
            }
        }
        cb(shop);
    });
}

function loadConfigAsync(db) {
    const commerce = require('./commerce-logistics');
    return new Promise((resolve) => {
        db.get(`SELECT value FROM global_settings WHERE key = ?`, [commerce.CONFIG_KEY], (err, row) => {
            let raw = {};
            if (row && row.value) {
                try {
                    raw = JSON.parse(row.value);
                } catch (_) {
                    raw = {};
                }
            }
            resolve(commerce.normalizeCommerceConfig(raw));
        });
    });
}

function liveRazorpay(db, cb) {
    const flow = require('./admin-payment-flow');
    db.all(`SELECT * FROM payment_gateways`, [], (err, rows) => {
        if (err) return cb(null);
        const picked = flow.pickRazorpayGateway(rows || []);
        if (!picked || !picked.config) return cb(null);
        cb({ key_id: picked.config.key_id, key_secret: picked.config.key_secret });
    });
}

function agentCanTouch(staff, order) {
    return !!(staff && order && order.commerce_provider === 'fleetbase');
}

module.exports = { registerFleetNetworkRoutes };

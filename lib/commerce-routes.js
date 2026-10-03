/**
 * Admin Commerce desk + public tracking for Tookan and Shipday.
 */
const commerce = require('./commerce-logistics');
const bookAuth = require('./book-sales-auth');

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
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
        cb(null, raw, commerce.normalizeCommerceConfig(raw));
    });
}

function saveConfig(db, cfg, upsertGlobalSetting, cb) {
    const payload = JSON.stringify(cfg);
    if (typeof upsertGlobalSetting === 'function') {
        return upsertGlobalSetting(commerce.CONFIG_KEY, payload, cb);
    }
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [payload, commerce.CONFIG_KEY], function (uerr) {
        if (uerr) return cb(uerr);
        if (this.changes) return cb(null);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [commerce.CONFIG_KEY, payload], cb);
    });
}

function ensureCommerceSchema(db, cb) {
    const alters = commerce.columnAlters(isPg());
    let i = 0;
    const next = () => {
        if (i >= alters.length) return cb && cb();
        db.run(alters[i++], () => next());
    };
    next();
}

function logEvent(db, bookOrderId, eventType, title, description, meta, cb) {
    db.run(
        `INSERT INTO book_order_events (book_order_id, event_type, title, description, meta_json) VALUES (?, ?, ?, ?, ?)`,
        [bookOrderId, eventType, title, description || null, meta ? JSON.stringify(meta) : null],
        () => {
            db.run(
                `INSERT INTO book_courier_track_events (book_order_id, event_at, location, description, source, event_city, facility)
                 VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)`,
                [
                    bookOrderId,
                    description || title,
                    title,
                    'commerce',
                    (meta && meta.city) || null,
                    (meta && meta.kind) || null
                ],
                () => cb && cb()
            );
        }
    );
}

function loadItems(db, orderId, cb) {
    db.all(
        `SELECT id, book_id, language, qty, unit_price, line_total FROM book_order_items WHERE book_order_id = ?`,
        [orderId],
        (err, rows) => cb(err, rows || [])
    );
}

function loadOrder(db, id, cb) {
    db.get(
        `SELECT bo.*, u.email AS buyer_email FROM book_orders bo LEFT JOIN users u ON u.id = bo.user_id WHERE bo.id = ?`,
        [id],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            loadItems(db, row.id, (e2, items) => {
                if (e2) return cb(e2);
                cb(null, commerce.mapCommerceRow(row, items));
            });
        }
    );
}

function loadEvents(db, orderId, cb) {
    db.all(
        `SELECT description AS title, location AS detail, event_city AS city, facility AS kind, event_at AS at
         FROM book_courier_track_events WHERE book_order_id = ? AND source = 'commerce' ORDER BY id ASC`,
        [orderId],
        (err, rows) => cb(err, rows || [])
    );
}

function stampPlacement(db, orderId, cb) {
    const token = commerce.generateToken();
    db.run(
        `UPDATE book_orders SET
            tracking_token = COALESCE(NULLIF(tracking_token, ''), ?),
            commerce_stage = COALESCE(NULLIF(commerce_stage, ''), 'placed'),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [token, orderId],
        (err) => cb && cb(err)
    );
}

function applyUpdate(db, order, update, cb) {
    if (!update) return cb && cb(null);
    const stage = update.stage || null;
    const sets = ['updated_at = CURRENT_TIMESTAMP', 'courier_track_updated_at = CURRENT_TIMESTAMP'];
    const params = [];
    if (stage) {
        sets.push('commerce_stage = ?');
        params.push(stage);
        sets.push('courier_track_label = ?');
        params.push(update.title || stage);
    }
    if (update.agentName) {
        sets.push('agent_name = ?');
        params.push(update.agentName);
    }
    if (update.agentPhone) {
        sets.push('agent_phone = ?');
        params.push(update.agentPhone);
    }
    if (update.agentLat != null) {
        sets.push('agent_lat = ?');
        params.push(update.agentLat);
    }
    if (update.agentLng != null) {
        sets.push('agent_lng = ?');
        params.push(update.agentLng);
    }
    if (update.liveLeg) {
        sets.push('live_leg = ?');
        params.push(update.liveLeg);
    }
    if (update.trackingLink && update.provider === 'tookan') {
        sets.push('tookan_tracking_link = ?');
        params.push(update.trackingLink);
    }
    if (update.trackingLink && update.provider === 'shipday') {
        sets.push('shipday_tracking_link = ?');
        params.push(update.trackingLink);
    }
    if (stage === 'delivered') {
        sets.push("status = 'delivered'");
        sets.push("courier_track_status = 'delivered'");
        sets.push('courier_delivered_at = COALESCE(courier_delivered_at, CURRENT_TIMESTAMP)');
    } else if (stage === 'out_for_delivery') {
        sets.push("courier_track_status = 'out_for_delivery'");
        sets.push("status = CASE WHEN status IN ('cancelled') THEN status ELSE 'shipped' END");
    } else if (stage === 'in_transit' || stage === 'pickup_scheduled') {
        sets.push("courier_track_status = 'in_transit'");
    }
    params.push(order.id);
    db.run(`UPDATE book_orders SET ${sets.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) return cb(err);
        logEvent(db, order.id, update.kind || 'commerce', update.title || 'Shipment update', update.detail || update.city || '', {
            city: update.city || '',
            kind: update.kind || '',
            agentPhone: update.agentPhone || ''
        }, () => cb(null));
    });
}

async function bookWithProvider(cfg, order, provider, mode) {
    if (provider === 'shipday') {
        if (mode !== 'hyperlocal') throw new Error('Shipday is used for hyperlocal pickup and delivery.');
        const booked = await commerce.createShipdayOrder(cfg, order);
        return { provider: 'shipday', mode: 'hyperlocal', externalId: booked.orderId, trackingLink: booked.trackingLink };
    }
    const booked = await commerce.createTookanTask(cfg, order, mode);
    return { provider: 'tookan', mode, externalId: booked.jobId, trackingLink: booked.trackingLink };
}

function persistBooking(db, order, booked, cb) {
    const sets = [
        'commerce_provider = ?',
        'commerce_mode = ?',
        'commerce_stage = ?',
        'pickup_otp = ?',
        'delivery_otp = ?',
        'live_leg = ?',
        'store_lat = COALESCE(store_lat, ?)',
        'store_lng = COALESCE(store_lng, ?)',
        'drop_lat = COALESCE(?, drop_lat)',
        'drop_lng = COALESCE(?, drop_lng)',
        "courier_shipment_status = 'shipped'",
        'courier_dispatched_at = COALESCE(courier_dispatched_at, CURRENT_TIMESTAMP)',
        'updated_at = CURRENT_TIMESTAMP'
    ];
    const live = booked.mode === 'hyperlocal' ? 'to_store' : 'none';
    const params = [
        booked.provider,
        booked.mode,
        'pickup_scheduled',
        order.pickupOtp,
        order.deliveryOtp,
        live,
        order.storeLat,
        order.storeLng,
        order.dropLat,
        order.dropLng
    ];
    if (booked.provider === 'tookan') {
        sets.push('tookan_job_id = ?', 'tookan_tracking_link = ?');
        params.push(booked.externalId || null, booked.trackingLink || null);
    } else {
        sets.push('shipday_order_id = ?', 'shipday_tracking_link = ?');
        params.push(booked.externalId || null, booked.trackingLink || null);
    }
    params.push(order.id);
    db.run(`UPDATE book_orders SET ${sets.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) return cb(err);
        logEvent(
            db,
            order.id,
            'pickup_scheduled',
            'Pickup scheduled',
            (booked.provider === 'shipday' ? 'Shipday' : 'Tookan') + ' · ' + booked.mode,
            { kind: 'pickup_scheduled', city: '' },
            () => cb(null)
        );
    });
}

function schedulePickup(db, cfg, order, provider, mode, cb) {
    const next = Object.assign({}, order, {
        pickupOtp: order.pickupOtp || commerce.generateOtp(),
        deliveryOtp: order.deliveryOtp || commerce.generateOtp(),
        storeLat: order.storeLat != null ? order.storeLat : cfg.storeLat,
        storeLng: order.storeLng != null ? order.storeLng : cfg.storeLng
    });
    bookWithProvider(cfg, next, provider, mode)
        .then((booked) => {
            next.pickupOtp = next.pickupOtp;
            persistBooking(db, next, booked, (err) => cb(err, booked));
        })
        .catch((e) => cb(e));
}

function chooseAutoBooking(cfg, order) {
    const mode = order.commerceMode === 'hyperlocal' || order.commerceMode === 'logistics' ? order.commerceMode : order.fulfillmentType === 'courier' ? 'logistics' : cfg.defaultMode;
    if (mode === 'logistics') {
        if (!cfg.tookan.enabled) return { error: 'Tookan is not configured for logistics.' };
        return { provider: 'tookan', mode: 'logistics' };
    }
    const prefer = order.commerceProvider === 'tookan' || order.commerceProvider === 'shipday' ? order.commerceProvider : cfg.defaultHyperlocalProvider;
    if (prefer === 'shipday' && cfg.shipday.enabled) return { provider: 'shipday', mode: 'hyperlocal' };
    if (cfg.tookan.enabled) return { provider: 'tookan', mode: 'hyperlocal' };
    if (cfg.shipday.enabled) return { provider: 'shipday', mode: 'hyperlocal' };
    return { error: 'No hyperlocal provider is configured.' };
}

function refreshLive(db, cfg, order, cb) {
    const done = (update) => {
        if (!update) return loadOrder(db, order.id, cb);
        applyUpdate(db, order, update, (err) => {
            if (err) return cb(err);
            loadOrder(db, order.id, cb);
        });
    };
    if (order.commerceProvider === 'tookan' && order.tookanJobId) {
        commerce
            .fetchTookanJob(cfg, order.tookanJobId)
            .then((job) => done(commerce.tookanJobToUpdate(job, order.commerceMode)))
            .catch((e) => cb(e));
        return;
    }
    if (order.commerceProvider === 'shipday' && order.shipdayOrderId) {
        commerce
            .fetchShipdayOrder(cfg, order.shipdayOrderId)
            .then((row) => done(commerce.shipdayOrderToUpdate(row)))
            .catch((e) => cb(e));
        return;
    }
    loadOrder(db, order.id, cb);
}

function findOrderForWebhook(db, parsed, cb) {
    if (parsed.jobId) {
        return db.get(`SELECT id FROM book_orders WHERE tookan_job_id = ?`, [parsed.jobId], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, row.id);
            if (parsed.orderCode) {
                return db.get(`SELECT id FROM book_orders WHERE UPPER(order_code) = UPPER(?)`, [parsed.orderCode], (e2, row2) =>
                    cb(e2, row2 && row2.id)
                );
            }
            cb(null, null);
        });
    }
    if (parsed.shipdayOrderId) {
        return db.get(`SELECT id FROM book_orders WHERE shipday_order_id = ?`, [parsed.shipdayOrderId], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, row.id);
            if (parsed.orderCode) {
                return db.get(`SELECT id FROM book_orders WHERE UPPER(order_code) = UPPER(?)`, [parsed.orderCode], (e2, row2) =>
                    cb(e2, row2 && row2.id)
                );
            }
            cb(null, null);
        });
    }
    if (parsed.orderCode) {
        return db.get(`SELECT id FROM book_orders WHERE UPPER(order_code) = UPPER(?)`, [parsed.orderCode], (err, row) =>
            cb(err, row && row.id)
        );
    }
    cb(null, null);
}

function registerCommerceRoutes(app, db, deps) {
    const upsertGlobalSetting = deps && deps.upsertGlobalSetting;
    const guard = (opts, fn) => (req, res) => {
        ensureCommerceSchema(db, () => {
            bookAuth.requireBookSalesActor(db, opts, fn)(req, res);
        });
    };

    app.get('/track-commerce', (req, res) => {
        res.sendFile(require('path').join(__dirname, '..', 'public', 'commerce-track.html'));
    });

    app.get(
        '/api/admin/commerce/config',
        guard({ orders: true }, (req, res) => {
            loadConfig(db, (err, raw) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, config: commerce.publicConfigView(raw) });
            });
        })
    );

    app.post(
        '/api/admin/commerce/config',
        guard({ config: true }, (req, res) => {
            loadConfig(db, (err, raw) => {
                if (err) return res.status(500).json({ error: err.message });
                const merged = commerce.mergeConfigSecrets(raw, (req.body && req.body.config) || req.body || {});
                saveConfig(db, merged, upsertGlobalSetting, (e2) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ success: true, config: commerce.publicConfigView(merged) });
                });
            });
        })
    );

    app.get(
        '/api/admin/commerce/orders',
        guard({ orders: true }, (req, res) => {
            db.all(
                `SELECT bo.*, u.email AS buyer_email FROM book_orders bo
                 LEFT JOIN users u ON u.id = bo.user_id
                 ORDER BY bo.id DESC LIMIT 200`,
                [],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    const list = rows || [];
                    let left = list.length;
                    if (!left) return res.json({ orders: [] });
                    const out = [];
                    list.forEach((row) => {
                        const finish = () => {
                            loadItems(db, row.id, (e2, items) => {
                                out.push(commerce.mapCommerceRow(row, items));
                                left--;
                                if (!left) {
                                    out.sort((a, b) => b.id - a.id);
                                    res.json({ orders: out });
                                }
                            });
                        };
                        if (!row.tracking_token || !row.commerce_stage) {
                            stampPlacement(db, row.id, () => {
                                if (!row.tracking_token) row.tracking_token = 'pending';
                                if (!row.commerce_stage) row.commerce_stage = 'placed';
                                db.get(`SELECT tracking_token, commerce_stage FROM book_orders WHERE id = ?`, [row.id], (e3, fresh) => {
                                    if (fresh) {
                                        row.tracking_token = fresh.tracking_token;
                                        row.commerce_stage = fresh.commerce_stage;
                                    }
                                    finish();
                                });
                            });
                        } else finish();
                    });
                }
            );
        })
    );

    app.post(
        '/api/admin/commerce/orders',
        guard({ orders: true }, (req, res) => {
            const body = req.body || {};
            const buyerName = String(body.buyerName || body.recipientName || '').trim();
            const buyerPhone = String(body.buyerPhone || body.phone || '').trim();
            const address = String(body.deliveryAddress || body.address || '').trim();
            if (!buyerName && !buyerPhone) return res.status(400).json({ error: 'Buyer name or phone is required.' });
            const mode = String(body.mode || 'logistics').toLowerCase() === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            const provider = String(body.provider || '').toLowerCase();
            const items = Array.isArray(body.items) && body.items.length ? body.items : [{ title: 'Book', qty: 1 }];
            const orderCode = 'BK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            const token = commerce.generateToken();
            let total = 0;
            items.forEach((it) => {
                total += (Number(it.unitPrice) || 0) * (parseInt(it.qty, 10) || 1);
            });
            db.run(
                `INSERT INTO book_orders (
                    order_code, status, payment_mode, total_amount, fulfillment_type,
                    buyer_name, buyer_phone, shipping_recipient_name, shipping_phone,
                    delivery_address, shipping_city, shipping_state, shipping_pincode,
                    commerce_provider, commerce_mode, commerce_stage, tracking_token,
                    store_lat, store_lng, drop_lat, drop_lng, notes, updated_at
                 ) VALUES (?, 'awaiting_confirmation', 'counter', ?, 'courier', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    orderCode,
                    Math.round(total * 100) / 100,
                    buyerName || null,
                    buyerPhone || null,
                    buyerName || null,
                    buyerPhone || null,
                    address || null,
                    String(body.city || '').trim() || null,
                    String(body.state || '').trim() || null,
                    String(body.pincode || '').replace(/\D/g, '').slice(0, 6) || null,
                    provider === 'tookan' || provider === 'shipday' ? provider : null,
                    mode,
                    token,
                    commerceNum(body.storeLat),
                    commerceNum(body.storeLng),
                    commerceNum(body.dropLat),
                    commerceNum(body.dropLng),
                    'Placed from Commerce desk'
                ],
                function (insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    const id = this.lastID;
                    let left = items.length;
                    const after = () => {
                        logEvent(db, id, 'placed', 'Order placed', 'Recorded on the Commerce desk.', { kind: 'placed' }, () => {
                            loadOrder(db, id, (e2, order) => {
                                if (e2) return res.status(500).json({ error: e2.message });
                                res.json({ success: true, order });
                            });
                        });
                    };
                    items.forEach((it) => {
                        const qty = Math.max(1, parseInt(it.qty, 10) || 1);
                        const unit = Number(it.unitPrice) || 0;
                        db.run(
                            `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
                            [id, String(it.bookId || it.title || 'book').slice(0, 40), String(it.language || 'english'), qty, unit, unit * qty],
                            () => {
                                left--;
                                if (!left) after();
                            }
                        );
                    });
                }
            );
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/stage',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const stage = String((req.body && req.body.stage) || '').toLowerCase();
            if (!['accepted', 'preparing', 'ready'].includes(stage)) {
                return res.status(400).json({ error: 'Stage must be accepted, preparing, or ready.' });
            }
            loadOrder(db, id, (err, order) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                const titles = { accepted: 'Order accepted', preparing: 'Order being prepared', ready: 'Order ready' };
                db.run(
                    `UPDATE book_orders SET commerce_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [stage, id],
                    (uerr) => {
                        if (uerr) return res.status(500).json({ error: uerr.message });
                        logEvent(db, id, stage, titles[stage], '', { kind: stage }, () => {
                            if (stage !== 'ready') {
                                return loadOrder(db, id, (e2, fresh) => res.json({ success: true, order: fresh }));
                            }
                            loadConfig(db, (cErr, raw, cfg) => {
                                if (cErr) return res.status(500).json({ error: cErr.message });
                                const choice = chooseAutoBooking(cfg, order);
                                if (choice.error) {
                                    return loadOrder(db, id, (e2, fresh) =>
                                        res.json({ success: true, order: fresh, pickup: { skipped: choice.error } })
                                    );
                                }
                                schedulePickup(db, cfg, order, choice.provider, choice.mode, (bErr) => {
                                    if (bErr) {
                                        return loadOrder(db, id, (e2, fresh) =>
                                            res.json({ success: true, order: fresh, pickup: { error: bErr.message } })
                                        );
                                    }
                                    loadOrder(db, id, (e2, fresh) => res.json({ success: true, order: fresh, pickup: { scheduled: true } }));
                                });
                            });
                        });
                    }
                );
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/book',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const provider = String((req.body && req.body.provider) || '').toLowerCase();
            const mode = String((req.body && req.body.mode) || '').toLowerCase();
            if (provider !== 'tookan' && provider !== 'shipday') {
                return res.status(400).json({ error: 'Choose Tookan or Shipday.' });
            }
            const useMode = provider === 'shipday' ? 'hyperlocal' : mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (!order) return res.status(404).json({ error: 'Order not found' });
                    if (req.body && req.body.dropLat != null) order.dropLat = commerceNum(req.body.dropLat);
                    if (req.body && req.body.dropLng != null) order.dropLng = commerceNum(req.body.dropLng);
                    schedulePickup(db, cfg, order, provider, useMode, (bErr) => {
                        if (bErr) return res.status(400).json({ error: bErr.message });
                        loadOrder(db, id, (e3, fresh) => {
                            if (e3) return res.status(500).json({ error: e3.message });
                            res.json({ success: true, order: fresh });
                        });
                    });
                });
            });
        })
    );

    app.get(
        '/api/admin/commerce/orders/:id/track',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (!order) return res.status(404).json({ error: 'Order not found' });
                    refreshLive(db, cfg, order, (e3, fresh) => {
                        if (e3) return res.status(502).json({ error: e3.message });
                        loadEvents(db, id, (e4, events) => {
                            res.json({
                                success: true,
                                order: fresh,
                                events,
                                mapsApiKey: cfg.mapsApiKey || null,
                                pickupOtp: fresh && fresh.pickupOtp,
                                deliveryOtp: fresh && fresh.deliveryOtp
                            });
                        });
                    });
                });
            });
        })
    );

    app.get(
        '/api/admin/commerce/orders/:id/label',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order) => {
                    if (e2 || !order) return res.status(404).send('Order not found');
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.send(commerce.labelHtml(order, cfg));
                });
            });
        })
    );

    app.get('/api/public/commerce/track', (req, res) => {
        const token = String(req.query.token || '').trim();
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id FROM book_orders WHERE tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadConfig(db, (cErr, raw, cfg) => {
                    if (cErr) return res.status(500).json({ error: cErr.message });
                    loadOrder(db, row.id, (e2, order) => {
                        if (e2 || !order) return res.status(404).json({ error: 'Shipment not found.' });
                        const send = (fresh) => {
                            loadEvents(db, row.id, (e3, events) => {
                                res.json({ success: true, shipment: commerce.customerTrackView(fresh || order, events, cfg) });
                            });
                        };
                        if (order.tookanJobId || order.shipdayOrderId) {
                            return refreshLive(db, cfg, order, (e4, fresh) => send(fresh || order));
                        }
                        send(order);
                    });
                });
            });
        });
    });

    app.post('/api/public/tookan/webhook', (req, res) => {
        const parsed = commerce.parseTookanWebhook(req.body || {});
        loadConfig(db, (err, raw, cfg) => {
            if (cfg.tookan.sharedSecret && parsed.sharedSecret && parsed.sharedSecret !== cfg.tookan.sharedSecret) {
                return res.status(401).json({ error: 'Invalid shared secret' });
            }
            findOrderForWebhook(db, parsed, (e2, id) => {
                if (e2 || !id) return res.json({ success: true, matched: false });
                loadOrder(db, id, (e3, order) => {
                    if (!order) return res.json({ success: true, matched: false });
                    const update = Object.assign({}, parsed, {
                        stage: commerce.stageFromKind(parsed.kind, order.commerceMode || 'logistics'),
                        liveLeg: commerce.liveLegFor(parsed.kind, order.commerceMode || 'logistics')
                    });
                    applyUpdate(db, order, update, () => res.json({ success: true, matched: true }));
                });
            });
        });
    });

    app.post('/api/public/shipday/webhook', (req, res) => {
        const parsed = commerce.parseShipdayWebhook(req.body || {});
        findOrderForWebhook(db, parsed, (err, id) => {
            if (err || !id) return res.json({ success: true, matched: false });
            loadOrder(db, id, (e2, order) => {
                if (!order) return res.json({ success: true, matched: false });
                const update = Object.assign({}, parsed, {
                    stage: commerce.stageFromKind(parsed.kind, 'hyperlocal'),
                    liveLeg: commerce.liveLegFor(parsed.kind, 'hyperlocal')
                });
                applyUpdate(db, order, update, () => res.json({ success: true, matched: true }));
            });
        });
    });
}

function commerceNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

module.exports = {
    registerCommerceRoutes,
    ensureCommerceSchema,
    stampPlacement,
    loadConfig
};

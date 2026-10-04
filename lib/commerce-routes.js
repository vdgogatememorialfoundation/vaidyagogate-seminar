/**
 * Admin Commerce desk + public tracking for Tookan and Shipday.
 */
const commerce = require('./commerce-logistics');
const shopTimeline = require('./shop-timeline');
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
    const at = meta && meta.at ? meta.at : null;
    db.run(
        `INSERT INTO book_order_events (book_order_id, event_type, title, description, meta_json) VALUES (?, ?, ?, ?, ?)`,
        [bookOrderId, eventType, title, description || null, meta ? JSON.stringify(meta) : null],
        () => {
            db.run(
                `INSERT INTO book_courier_track_events (book_order_id, event_at, location, description, source, event_city, facility)
                 VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?)`,
                [
                    bookOrderId,
                    at,
                    description || title,
                    title,
                    (meta && meta.source) || 'commerce',
                    (meta && meta.city) || null,
                    (meta && meta.kind) || null
                ],
                () => cb && cb()
            );
        }
    );
}

function logEventOnce(db, bookOrderId, eventType, title, description, meta, cb) {
    const kind = (meta && meta.kind) || '';
    const city = (meta && meta.city) || '';
    const source = (meta && meta.source) || 'commerce';
    db.get(
        `SELECT id FROM book_courier_track_events
         WHERE book_order_id = ? AND source = ? AND description = ? AND COALESCE(facility, '') = ? AND COALESCE(event_city, '') = ?
         LIMIT 1`,
        [bookOrderId, source, title, kind, city],
        (err, row) => {
            if (!err && row) return cb && cb();
            logEvent(db, bookOrderId, eventType, title, description, meta, cb);
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

function stampPlacement(db, orderId, cb, channel) {
    const token = commerce.generateToken();
    const ch = channel ? String(channel) : '';
    ensureCommerceSchema(db, () => {
        db.run(
            `UPDATE book_orders SET
                tracking_token = COALESCE(NULLIF(tracking_token, ''), ?),
                commerce_stage = COALESCE(NULLIF(commerce_stage, ''), 'placed'),
                order_channel = COALESCE(NULLIF(order_channel, ''), NULLIF(?, '')),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [token, ch, orderId],
            (err) => cb && cb(err)
        );
    });
}

function applyUpdate(db, order, update, cb) {
    if (!update) return cb && cb(null);
    const currentRank = commerce.STAGES.indexOf(order.commerceStage || 'placed');
    let stage = update.stage || null;
    let regressed = false;
    if (stage && commerce.STAGES.indexOf(stage) < currentRank) {
        stage = null;
        regressed = true;
    }
    if (regressed) update = Object.assign({}, update, { liveLeg: null, skipEvent: true });
    if (commerce.isDeskNoise(update.title) || commerce.isDeskNoise(update.detail)) {
        const cleanTitle = commerce.KIND_TITLES[update.kind] || '';
        update = Object.assign({}, update, {
            title: cleanTitle || 'Shipment update',
            detail: commerce.isDeskNoise(update.detail) ? '' : update.detail,
            skipEvent: !cleanTitle
        });
    }
    if (/^book desk$/i.test(String(update.city || ''))) update = Object.assign({}, update, { city: '' });
    const quiet = update.kind === 'update' || (update.skipEvent && !stage);
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
    if (update.storeLat != null) {
        sets.push('store_lat = ?');
        params.push(update.storeLat);
    }
    if (update.storeLng != null) {
        sets.push('store_lng = ?');
        params.push(update.storeLng);
    }
    if (update.dropLat != null) {
        sets.push('drop_lat = ?');
        params.push(update.dropLat);
    }
    if (update.dropLng != null) {
        sets.push('drop_lng = ?');
        params.push(update.dropLng);
    }
    if (update.liveLeg && !regressed) {
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
    if (update.provider === 'shipday') {
        sets.push('pickup_otp = NULL', 'delivery_otp = NULL');
    } else {
        if (update.pickupOtp) {
            sets.push('pickup_otp = ?');
            params.push(update.pickupOtp);
        }
        if (update.deliveryOtp) {
            sets.push('delivery_otp = ?');
            params.push(update.deliveryOtp);
        }
    }
    if (quiet && sets.length === 2) return cb && cb(null);
    if (stage === 'delivered') {
        sets.push("status = 'delivered'");
        sets.push("courier_track_status = 'delivered'");
        sets.push('courier_delivered_at = COALESCE(courier_delivered_at, CURRENT_TIMESTAMP)');
    } else if (stage === 'out_for_delivery') {
        sets.push("courier_track_status = 'out_for_delivery'");
        sets.push("courier_shipment_status = 'shipped'");
        sets.push("status = CASE WHEN status IN ('cancelled') THEN status ELSE 'shipped' END");
    } else if (stage === 'in_transit') {
        sets.push("courier_track_status = 'in_transit'");
        sets.push("courier_shipment_status = 'shipped'");
        sets.push('courier_dispatched_at = COALESCE(courier_dispatched_at, CURRENT_TIMESTAMP)');
    } else if (stage === 'pickup_scheduled') {
        sets.push("courier_track_status = 'booked'");
    }
    params.push(order.id);
    db.run(`UPDATE book_orders SET ${sets.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) return cb(err);
        if (quiet || update.skipEvent) return cb(null);
        logEventOnce(db, order.id, update.kind || 'commerce', update.title || 'Shipment update', update.detail || update.city || '', {
            city: update.city || '',
            kind: update.kind || '',
            agentPhone: update.agentPhone || '',
            at: update.at || null
        }, () => cb(null));
    });
}

async function bookWithProvider(cfg, order, provider, mode) {
    if (provider === 'shipday') {
        if (mode !== 'hyperlocal') throw new Error('Shipday is used for hyperlocal pickup and delivery.');
        const booked = await commerce.createShipdayOrder(cfg, order);
        return { provider: 'shipday', mode: 'hyperlocal', externalId: booked.orderId, trackingLink: booked.trackingLink, pickupOtp: '', deliveryOtp: '' };
    }
    const booked = await commerce.createTookanTask(cfg, order, mode);
    return {
        provider: 'tookan',
        mode,
        externalId: booked.jobId,
        deliveryExternalId: booked.parcel ? '' : booked.deliveryJobId || '',
        trackingLink: booked.trackingLink,
        pickupOtp: booked.pickupOtp || '',
        deliveryOtp: booked.deliveryOtp || ''
    };
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
        "courier_track_status = 'booked'",
        'updated_at = CURRENT_TIMESTAMP'
    ];
    const live = booked.mode === 'hyperlocal' ? 'to_store' : 'none';
    const pickupOtp = booked.provider === 'shipday' ? '' : booked.pickupOtp || '';
    const deliveryOtp = booked.provider === 'shipday' ? '' : booked.deliveryOtp || '';
    const params = [
        booked.provider,
        booked.mode,
        'pickup_scheduled',
        pickupOtp,
        deliveryOtp,
        live,
        order.storeLat,
        order.storeLng,
        order.dropLat,
        order.dropLng
    ];
    if (booked.provider === 'tookan') {
        sets.push('tookan_job_id = ?', 'tookan_delivery_job_id = ?', 'tookan_tracking_link = ?');
        params.push(booked.externalId || null, booked.deliveryExternalId || null, booked.trackingLink || null);
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
            'Pickup requested from courier partner',
            commerce.COURIER_PARTNER_NAME + ' · ' + booked.mode,
            { kind: 'pickup_scheduled', city: '' },
            () => cb(null)
        );
    });
}

function parsePickupAt(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.length === 16 ? s + ':00+05:30' : s;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function schedulePickup(db, cfg, order, provider, mode, cb, opts) {
    const options = opts || {};
    const lead = Number(cfg.shop && cfg.shop.pickupLeadMinutes) || 30;
    const dropLead = Number(cfg.shop && cfg.shop.deliveryLeadMinutes) || 90;
    const pickupAtMs = options.pickupAtMs || Date.now() + lead * 60 * 1000;
    const next = Object.assign({}, order, {
        pickupOtp: '',
        deliveryOtp: '',
        storeLat: order.storeLat != null ? order.storeLat : cfg.storeLat,
        storeLng: order.storeLng != null ? order.storeLng : cfg.storeLng,
        pickupAtMs,
        dropAtMs: pickupAtMs + dropLead * 60 * 1000,
        returnLeg: !!options.returnLeg
    });
    if (options.returnLeg) {
        return bookWithProvider(cfg, next, provider, mode)
            .then((booked) => {
                const when = new Date(pickupAtMs).toISOString();
                db.run(
                    `UPDATE book_orders SET return_status = 'pickup_scheduled', return_provider = ?, return_mode = ?,
                     return_pickup_otp = ?, return_scheduled_at = ?, return_tracking_link = ?,
                     return_tookan_job_id = CASE WHEN ? = 'tookan' THEN ? ELSE return_tookan_job_id END,
                     return_tookan_delivery_job_id = CASE WHEN ? = 'tookan' THEN ? ELSE return_tookan_delivery_job_id END,
                     return_shipday_order_id = CASE WHEN ? = 'shipday' THEN ? ELSE return_shipday_order_id END,
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [
                        provider,
                        mode,
                        booked.pickupOtp || '',
                        when,
                        booked.trackingLink || null,
                        provider,
                        booked.externalId || null,
                        provider,
                        booked.deliveryExternalId || null,
                        provider,
                        booked.externalId || null,
                        order.id
                    ],
                    (err) => {
                        if (err) return cb(err);
                        logEvent(
                            db,
                            order.id,
                            'return_pickup_scheduled',
                            'Return pickup requested from courier partner',
                            commerce.COURIER_PARTNER_NAME + ' · ' + mode,
                            { kind: 'return', city: '' },
                            () => cb(null, booked)
                        );
                    }
                );
            })
            .catch((e) => cb(e));
    }
    bookWithProvider(cfg, next, provider, mode)
        .then((booked) => {
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
        if (!update) return refreshReturn(db, cfg, order, cb);
        applyUpdate(db, order, update, (err) => {
            if (err) return cb(err);
            refreshReturn(db, cfg, order, cb);
        });
    };
    if (order.commerceProvider === 'tookan' && order.tookanJobId && order.commerceStage !== 'delivered') {
        const pickup = commerce.fetchTookanJob(cfg, order.tookanJobId);
        const delivery = order.tookanDeliveryJobId ? commerce.fetchTookanJob(cfg, order.tookanDeliveryJobId) : Promise.resolve(null);
        Promise.all([pickup, delivery])
            .then(([pJob, dJob]) => {
                const p = commerce.tookanJobToUpdate(pJob, order.commerceMode, 'pickup');
                const d = dJob ? commerce.tookanJobToUpdate(dJob, order.commerceMode, 'delivery') : null;
                done(commerce.combineTookanUpdates(p, d));
            })
            .catch((e) => cb(e));
        return;
    }
    const shipdayNeedsPlace = order.storeLat == null || order.dropLat == null;
    if (order.commerceProvider === 'shipday' && order.shipdayOrderId && (order.commerceStage !== 'delivered' || shipdayNeedsPlace)) {
        commerce
            .fetchShipdayOrder(cfg, order.shipdayOrderId, order.orderCode)
            .then((row) => {
                const update = commerce.shipdayOrderToUpdate(row);
                if (!update || update.agentLat != null || !update.carrierId || update.stage === 'delivered' || order.commerceStage === 'delivered') return update;
                return commerce.fetchShipdayCarrierPoint(cfg, update.carrierId).then((point) => {
                    if (point) {
                        update.agentLat = point.lat;
                        update.agentLng = point.lng;
                    }
                    return update;
                });
            })
            .then((update) => done(update))
            .catch((e) => cb(e));
        return;
    }
    refreshReturn(db, cfg, order, cb);
}

function refreshReturn(db, cfg, order, cb) {
    const open = order.returnStatus === 'pickup_scheduled' || order.returnStatus === 'in_transit';
    if (!open || order.returnProvider !== 'tookan' || !order.returnTookanJobId) return loadOrder(db, order.id, cb);
    const pickup = commerce.fetchTookanJob(cfg, order.returnTookanJobId);
    const delivery = order.returnTookanDeliveryJobId ? commerce.fetchTookanJob(cfg, order.returnTookanDeliveryJobId) : Promise.resolve(null);
    Promise.all([pickup, delivery])
        .then(([pJob, dJob]) => {
            const p = commerce.tookanJobToUpdate(pJob, 'logistics', 'pickup');
            const d = dJob ? commerce.tookanJobToUpdate(dJob, 'logistics', 'delivery') : null;
            const update = commerce.combineTookanUpdates(p, d);
            if (!update) return loadOrder(db, order.id, cb);
            applyReturnUpdate(db, order, update, () => loadOrder(db, order.id, cb));
        })
        .catch(() => loadOrder(db, order.id, cb));
}

/**
 * Only tasks this site booked are tracked. Matching is by stored job / order ids, never by
 * order code, so other tasks created in the Tookan or Shipday dashboards are ignored.
 */
function findOrderForWebhook(db, parsed, cb) {
    const byCode = () => cb(null, null);
    if (parsed.jobId) {
        const lookups = [
            ['tookan_job_id', 'forward', 'pickup'],
            ['tookan_delivery_job_id', 'forward', 'delivery'],
            ['return_tookan_job_id', 'return', 'pickup'],
            ['return_tookan_delivery_job_id', 'return', 'delivery']
        ];
        const next = (i) => {
            if (i >= lookups.length) return byCode('forward');
            const [col, leg, jobType] = lookups[i];
            db.get(`SELECT id FROM book_orders WHERE ${col} = ?`, [parsed.jobId], (err, row) => {
                if (err) return cb(err);
                if (row) return cb(null, { id: row.id, leg, jobType });
                next(i + 1);
            });
        };
        return next(0);
    }
    if (parsed.shipdayOrderId) {
        return db.get(`SELECT id FROM book_orders WHERE shipday_order_id = ?`, [parsed.shipdayOrderId], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, { id: row.id, leg: 'forward' });
            db.get(`SELECT id FROM book_orders WHERE return_shipday_order_id = ?`, [parsed.shipdayOrderId], (e2, ret) => {
                if (e2) return cb(e2);
                if (ret) return cb(null, { id: ret.id, leg: 'return' });
                byCode('forward');
            });
        });
    }
    byCode('forward');
}

function applyReturnUpdate(db, order, update, cb) {
    let status = 'in_transit';
    if (update.kind === 'delivered') status = 'received';
    else if (update.kind === 'failed') status = 'approved';
    else if (['to_store', 'pickup_scheduled', 'agent_assigned', 'at_pickup'].includes(update.kind)) status = 'pickup_scheduled';
    if (update.kind === 'update' || (update.skipEvent && !['picked_up', 'delivered', 'failed'].includes(update.kind))) return cb(null);
    db.run(
        `UPDATE book_orders SET return_status = ?, return_agent_name = COALESCE(?, return_agent_name),
         return_agent_phone = COALESCE(?, return_agent_phone),
         return_agent_lat = COALESCE(?, return_agent_lat), return_agent_lng = COALESCE(?, return_agent_lng),
         return_tracking_link = COALESCE(?, return_tracking_link), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
            status,
            update.agentName || null,
            update.agentPhone || null,
            update.agentLat,
            update.agentLng,
            update.trackingLink || null,
            order.id
        ],
        (err) => {
            if (err) return cb(err);
            if (update.skipEvent) return cb(null);
            logEventOnce(
                db,
                order.id,
                'return_' + (update.kind || 'update'),
                update.kind === 'delivered' ? 'Return received at store' : update.title || 'Return shipment update',
                update.detail || update.city || '',
                { city: update.city || '', kind: update.kind || '', source: 'commerce_return' },
                () => cb(null)
            );
        }
    );
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
                    const pickupAtMs = parsePickupAt(req.body && req.body.pickupAt);
                    schedulePickup(
                        db,
                        cfg,
                        order,
                        provider,
                        useMode,
                        (bErr) => {
                            if (bErr) return res.status(400).json({ error: bErr.message });
                            loadOrder(db, id, (e3, fresh) => {
                                if (e3) return res.status(500).json({ error: e3.message });
                                res.json({ success: true, order: fresh });
                            });
                        },
                        { pickupAtMs }
                    );
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
                                deliveryOtp: fresh && fresh.deliveryOtp,
                                timeline: fresh ? shopTimeline.buildShopTimeline(fresh, events, { admin: true }) : null,
                                live: fresh
                                    ? shopTimeline.buildLiveView(
                                          fresh,
                                          shopTimeline.buildShopTimeline(fresh, events, { admin: true }),
                                          cfg.mapsApiKey,
                                          { admin: true }
                                      )
                                    : null
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

    const RETURN_STATUSES = [
        'requested',
        'approved',
        'rejected',
        'pickup_scheduled',
        'in_transit',
        'received',
        'refunded',
        'replacement_preparing',
        'replacement_sent',
        'replacement_delivered'
    ];

    app.post(
        '/api/admin/commerce/orders/:id/return',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const status = String((req.body && req.body.status) || '').toLowerCase();
            const kind = String((req.body && req.body.kind) || '').toLowerCase();
            if (status && !RETURN_STATUSES.includes(status)) {
                return res.status(400).json({ error: 'Unknown return status.' });
            }
            loadOrder(db, id, (err, order) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                db.run(
                    `UPDATE book_orders SET
                        return_status = COALESCE(?, return_status),
                        return_kind = COALESCE(?, return_kind),
                        return_reason = COALESCE(?, return_reason),
                        updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [status || null, kind === 'return' || kind === 'replacement' ? kind : null, (req.body && req.body.reason) || null, id],
                    (uerr) => {
                        if (uerr) return res.status(500).json({ error: uerr.message });
                        logEvent(
                            db,
                            id,
                            'return_status',
                            'Return status updated',
                            status || kind || 'updated',
                            { kind: 'return', source: 'commerce_return' },
                            () => loadOrder(db, id, (e2, fresh) => res.json({ success: true, order: fresh }))
                        );
                    }
                );
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/return-pickup',
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
                    if (!order.returnStatus) return res.status(400).json({ error: 'Record a return or replacement before scheduling pickup.' });
                    schedulePickup(
                        db,
                        cfg,
                        order,
                        provider,
                        useMode,
                        (bErr) => {
                            if (bErr) return res.status(400).json({ error: bErr.message });
                            loadOrder(db, id, (e3, fresh) => res.json({ success: true, order: fresh }));
                        },
                        { pickupAtMs: parsePickupAt(req.body && req.body.pickupAt), returnLeg: true }
                    );
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
                                const subject = fresh || order;
                                const timeline = shopTimeline.buildShopTimeline(subject, events, {});
                                const view = commerce.customerTrackView(subject, events, cfg);
                                view.timeline = timeline;
                                view.live = shopTimeline.buildLiveView(subject, timeline, cfg.mapsApiKey, {});
                                view.awbTrackUrl = null;
                                res.json({ success: true, shipment: view });
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
        if (parsed.ignore) return res.json({ success: true, matched: false });
        loadConfig(db, (err, raw, cfg) => {
            if (cfg.tookan.sharedSecret && parsed.sharedSecret && parsed.sharedSecret !== cfg.tookan.sharedSecret) {
                return res.status(401).json({ error: 'Invalid shared secret' });
            }
            findOrderForWebhook(db, parsed, (e2, hit) => {
                if (e2 || !hit) return res.json({ success: true, matched: false });
                loadOrder(db, hit.id, (e3, order) => {
                    if (!order) return res.json({ success: true, matched: false });
                    if (hit.jobType && !parsed.jobType) {
                        const task = commerce.tookanTaskUpdate(hit.jobType, parsed.taskStatus, '', {
                            agentName: parsed.agentName,
                            agentPhone: parsed.agentPhone
                        });
                        Object.assign(parsed, { kind: task.kind, title: task.title, detail: task.detail, skipEvent: !!task.skipEvent });
                    }
                    if (hit.leg === 'return') {
                        return applyReturnUpdate(db, order, parsed, () => res.json({ success: true, matched: true, leg: 'return' }));
                    }
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
        findOrderForWebhook(db, parsed, (err, hit) => {
            if (err || !hit) return res.json({ success: true, matched: false });
            loadOrder(db, hit.id, (e2, order) => {
                if (!order) return res.json({ success: true, matched: false });
                if (hit.leg === 'return') {
                    return applyReturnUpdate(db, order, parsed, () => res.json({ success: true, matched: true, leg: 'return' }));
                }
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
    loadConfig,
    refreshLive
};

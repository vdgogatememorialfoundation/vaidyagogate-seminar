/**
 * Admin Commerce desk + public tracking for Tookan and Shipday.
 */
const commerce = require('./commerce-logistics');
const shopTimeline = require('./shop-timeline');
const shipmentEngine = require('./shipment-engine');
const bookAuth = require('./book-sales-auth');
const fleetNetwork = require('./fleet-network');

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

let commerceSchemaReady = false;
let commerceSchemaWaiters = null;

function ensureCommerceSchema(db, cb) {
    if (commerceSchemaReady) return cb && cb();
    if (commerceSchemaWaiters) {
        if (cb) commerceSchemaWaiters.push(cb);
        return;
    }
    commerceSchemaWaiters = cb ? [cb] : [];
    const finish = () => {
        commerceSchemaReady = true;
        const waiters = commerceSchemaWaiters || [];
        commerceSchemaWaiters = null;
        waiters.forEach((fn) => fn());
    };
    db.run(commerce.deliveryAttemptsSql(isPg()), () => {
        const alters = commerce.columnAlters(isPg());
        let i = 0;
        const next = () => {
            if (i >= alters.length) return finish();
            db.run(alters[i++], () => next());
        };
        next();
    });
}

function attemptTaskId(order, update) {
    if (update && update.externalTaskId) return String(update.externalTaskId);
    if (!order) return null;
    return order.tookanDeliveryJobId || order.tookanJobId || order.shipdayOrderId || order.pidgeOrderId || null;
}

function syncDeliveryAttempt(db, order, update, cb) {
    const kind = update && update.kind;
    if (!order || (kind !== 'failed' && kind !== 'out_for_delivery' && kind !== 'delivered')) return cb && cb();
    const status = kind === 'failed' ? 'FAILED' : kind === 'delivered' ? 'DELIVERED' : 'OUT_FOR_DELIVERY';
    const now = new Date().toISOString();
    db.get(
        `SELECT id, attempt_number, status FROM delivery_attempts WHERE shipment_id = ? ORDER BY attempt_number DESC, id DESC LIMIT 1`,
        [order.id],
        (err, latest) => {
            if (err) return cb && cb();
            const insert = (number, originalId) => {
                db.run(
                    `INSERT INTO delivery_attempts (
                        shipment_id, attempt_number, provider, external_task_id, agent_id, status,
                        failure_reason, started_at, completed_at, original_attempt_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        order.id,
                        number,
                        order.commerceProvider || (update && update.provider) || null,
                        attemptTaskId(order, update),
                        (update && update.agentId) || null,
                        status,
                        status === 'FAILED' ? update.title || 'Delivery attempt was unsuccessful' : null,
                        status === 'OUT_FOR_DELIVERY' ? now : null,
                        status === 'FAILED' || status === 'DELIVERED' ? now : null,
                        originalId || null
                    ],
                    () => cb && cb()
                );
            };
            if (!latest) return insert(1, null);
            if (status === 'FAILED' && latest.status === 'FAILED') return cb && cb();
            if (status === 'FAILED') {
                return db.run(
                    `UPDATE delivery_attempts SET status = 'FAILED', completed_at = ?, failure_reason = ? WHERE id = ?`,
                    [now, update.title || 'Delivery attempt was unsuccessful', latest.id],
                    () => cb && cb()
                );
            }
            if (status === 'DELIVERED') {
                return db.run(
                    `UPDATE delivery_attempts SET status = 'DELIVERED', completed_at = ? WHERE id = ?`,
                    [now, latest.id],
                    () => cb && cb()
                );
            }
            if (latest.status === 'SCHEDULED' || latest.status === 'OUT_FOR_DELIVERY') {
                return db.run(
                    `UPDATE delivery_attempts SET status = 'OUT_FOR_DELIVERY', started_at = COALESCE(started_at, ?), external_task_id = COALESCE(?, external_task_id), agent_id = COALESCE(?, agent_id) WHERE id = ?`,
                    [now, attemptTaskId(order, update), (update && update.agentId) || null, latest.id],
                    () => cb && cb()
                );
            }
            insert(latest.attempt_number + 1, latest.status === 'FAILED' ? latest.id : null);
        }
    );
}

function recordReschedule(db, order, slot, cb) {
    const now = new Date().toISOString();
    const startIso = slot.date + 'T' + slot.start + ':00+05:30';
    const endIso = slot.date + 'T' + slot.end + ':00+05:30';
    db.get(
        `SELECT id, attempt_number, status FROM delivery_attempts WHERE shipment_id = ? ORDER BY attempt_number DESC, id DESC LIMIT 1`,
        [order.id],
        (err, latest) => {
            if (err) return cb && cb();
            const number = latest ? latest.attempt_number + 1 : 1;
            const originalId = latest && latest.status === 'FAILED' ? latest.id : latest ? latest.id : null;
            db.run(
                `INSERT INTO delivery_attempts (
                    shipment_id, attempt_number, provider, external_task_id, status,
                    scheduled_date, scheduled_start, scheduled_end,
                    rescheduled_at, rescheduled_for_date, rescheduled_for_start, rescheduled_for_end,
                    reschedule_reason, reschedule_source, original_attempt_id
                ) VALUES (?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, ?, ?, ?, ?, ?, 'customer', ?)`,
                [
                    order.id,
                    number,
                    order.commerceProvider || null,
                    attemptTaskId(order, null),
                    slot.date,
                    startIso,
                    endIso,
                    now,
                    slot.date,
                    startIso,
                    endIso,
                    'delivery_attempt_failed',
                    originalId
                ],
                function (insErr) {
                    if (insErr || !latest) return cb && cb();
                    const newId = this && this.lastID;
                    db.run(
                        `UPDATE delivery_attempts SET rescheduled_attempt_id = ?, rescheduled_at = ?, rescheduled_for_date = ?, rescheduled_for_start = ?, rescheduled_for_end = ?, reschedule_reason = ?, reschedule_source = ? WHERE id = ?`,
                        [newId || null, now, slot.date, startIso, endIso, 'delivery_attempt_failed', 'customer', latest.id],
                        () => cb && cb()
                    );
                }
            );
        }
    );
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
    const place = String(description || title || '');
    db.get(
        `SELECT id FROM book_courier_track_events
         WHERE book_order_id = ? AND source = ? AND description = ? AND COALESCE(facility, '') = ? AND COALESCE(event_city, '') = ? AND COALESCE(location, '') = ?
         LIMIT 1`,
        [bookOrderId, source, title, kind, city, place],
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
         FROM book_courier_track_events WHERE book_order_id = ? AND source = 'commerce' ORDER BY event_at ASC, id ASC`,
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

function logHubEvents(db, orderId, events, cb) {
    const extras = Array.isArray(events) ? events : [];
    let i = 0;
    const step = () => {
        if (i >= extras.length) return cb && cb();
        let ev = extras[i++];
        const title = ev && ev.title ? String(ev.title) : '';
        const received = /^shipment received at\s+\S/i.test(title);
        const left = /^shipment left\s+\S/i.test(title);
        if (!ev || (!received && !left && ev.kind !== 'hub_eta' && ev.kind !== 'arrived_facility') || !title) return step();
        if (left) ev = Object.assign({}, ev, { kind: 'left_facility' });
        else if (received) ev = Object.assign({}, ev, { kind: 'arrived_facility' });
        logEventOnce(
            db,
            orderId,
            ev.kind,
            ev.title,
            ev.detail || '',
            { city: ev.city || '', kind: ev.kind, at: ev.at || null },
            step
        );
    };
    step();
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
    if (stage) {
        const fromKey = shipmentEngine.mainKeyFromOrder(order);
        const toKey = shipmentEngine.mainKeyFromOrder({
            commerceStage: stage,
            status: order.status,
            commerceProvider: order.commerceProvider,
            fulfillmentType: order.fulfillmentType
        });
        if (!shipmentEngine.allowMainTransition(fromKey, toKey)) {
            stage = null;
            update = Object.assign({}, update, { liveLeg: null });
        }
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
    if (update.kind !== 'failed' && update.agentLat != null) {
        sets.push('agent_lat = ?');
        params.push(update.agentLat);
        sets.push('agent_location_at = ?');
        params.push(update.agentLocationAt || update.at || new Date().toISOString());
    }
    if (update.kind !== 'failed' && update.agentLng != null) {
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
    if (update.kind === 'failed') {
        sets.push("live_leg = 'none'");
    } else if (update.liveLeg && !regressed) {
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
        if (update.pickupOtp && update.provider !== 'pidge') {
            sets.push('pickup_otp = ?');
            params.push(update.pickupOtp);
        }
        if (update.deliveryOtp) {
            sets.push('delivery_otp = ?');
            params.push(update.deliveryOtp);
        }
    }
    if (update.pickupAt) {
        sets.push('commerce_pickup_at = ?');
        params.push(update.pickupAt);
    }
    if (update.deliveryAt) {
        sets.push('commerce_delivery_at = ?');
        params.push(update.deliveryAt);
    }
    if (update.trackingNo) {
        if (order.commerceProvider === 'fleetbase' && fleetNetwork.isAwb(order.commerceAwb)) {
            sets.push('commerce_provider_tracking = ?');
            params.push(String(update.trackingNo));
        } else {
            sets.push('courier_tracking_no = ?');
            params.push(String(update.trackingNo));
        }
    }
    if (update.cancelOrder && order.commerceStage !== 'delivered' && order.status !== 'delivered') {
        sets.push("status = CASE WHEN status = 'delivered' THEN status ELSE 'cancelled' END");
    }
    if (quiet && sets.length === 2) return logHubEvents(db, order.id, update.events, () => cb && cb(null));
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
        const after = () => logHubEvents(db, order.id, update.events, () => syncDeliveryAttempt(db, order, update, () => cb(null)));
        if (quiet || update.skipEvent) return after();
        logEventOnce(db, order.id, update.kind || 'commerce', update.title || 'Shipment update', update.detail || update.city || '', {
            city: update.city || '',
            kind: update.kind || '',
            agentPhone: update.agentPhone || '',
            at: update.at || null,
            provider: update.provider || order.commerceProvider || '',
            externalTaskId: attemptTaskId(order, update) || '',
            externalTimestamp: update.at || '',
            rawStatus: update.rawStatus != null ? String(update.rawStatus) : update.taskStatus != null ? String(update.taskStatus) : '',
            normalizedStatus: update.kind || ''
        }, after);
    });
}

async function bookWithProvider(cfg, order, provider, mode) {
    if (provider === 'shipday') {
        if (mode !== 'hyperlocal') throw new Error('Shipday is used for hyperlocal pickup and delivery.');
        const booked = await commerce.createShipdayOrder(cfg, order);
        return { provider: 'shipday', mode: 'hyperlocal', externalId: booked.orderId, trackingLink: booked.trackingLink, pickupOtp: '', deliveryOtp: '' };
    }
    if (provider === 'pidge') {
        const booked = await commerce.createPidgeOrder(cfg, order);
        const useMode = mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
        return { provider: 'pidge', mode: useMode, externalId: booked.orderId, trackingLink: '', trackingNo: '', pickupOtp: '', deliveryOtp: '' };
    }
    if (provider === 'fleetbase') {
        const booked = await commerce.createFleetbaseOrder(cfg, order);
        const useMode = mode === 'hyperlocal' ? 'hyperlocal' : 'logistics';
        return {
            provider: 'fleetbase',
            mode: useMode,
            externalId: booked.orderId,
            trackingLink: '',
            trackingNo: booked.trackingNo || '',
            pickupOtp: booked.pickupOtp || '',
            deliveryOtp: booked.deliveryOtp || '',
            pickupAt: booked.pickupAt || null,
            deliveryAt: booked.deliveryAt || null,
            events: booked.events || []
        };
    }
    const booked = await commerce.createTookanTask(cfg, order, mode);
    return {
        provider: 'tookan',
        mode,
        externalId: booked.jobId,
        deliveryExternalId: booked.parcel ? '' : booked.deliveryJobId || '',
        trackingLink: booked.parcel ? '' : booked.trackingLink || '',
        pickupOtp: booked.pickupOtp || '',
        deliveryOtp: booked.deliveryOtp || '',
        barcode: booked.barcode || '',
        events: booked.events || [],
        parcel: !!booked.parcel
    };
}

function persistBooking(db, order, booked, cb, cfg) {
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
        "status = CASE WHEN status = 'cancelled' THEN 'confirmed' ELSE status END",
        'updated_at = CURRENT_TIMESTAMP'
    ];
    const live = booked.mode === 'hyperlocal' ? 'to_store' : 'none';
    const pickupOtp = booked.provider === 'shipday' || booked.provider === 'pidge' ? '' : booked.pickupOtp || '';
    const deliveryOtp = booked.provider === 'shipday' ? '' : booked.deliveryOtp || '';
    const pickupAt = booked.pickupAt || (order.pickupAtMs ? new Date(order.pickupAtMs).toISOString() : null);
    const deliveryAt = booked.deliveryAt || (order.dropAtMs ? new Date(order.dropAtMs).toISOString() : null);
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
    if (pickupAt) {
        sets.push('commerce_pickup_at = ?');
        params.push(pickupAt);
    }
    if (deliveryAt) {
        sets.push('commerce_delivery_at = ?');
        params.push(deliveryAt);
    }
    if (booked.provider === 'tookan') {
        sets.push('tookan_job_id = ?', 'tookan_delivery_job_id = ?', 'tookan_tracking_link = ?');
        params.push(booked.externalId || null, booked.deliveryExternalId || null, booked.trackingLink || null);
        if (booked.barcode) {
            sets.push("courier_tracking_no = CASE WHEN courier_tracking_no IS NULL OR TRIM(courier_tracking_no) = '' THEN ? ELSE courier_tracking_no END");
            params.push(String(booked.barcode));
        }
    } else if (booked.provider === 'pidge') {
        sets.push('pidge_order_id = ?');
        params.push(booked.externalId || null);
    } else if (booked.provider === 'fleetbase') {
        sets.push('fleetbase_order_id = ?', 'commerce_open_box = ?', 'commerce_fragile = ?', 'commerce_heavy = ?', 'commerce_cod = ?', 'commerce_cod_amount = ?');
        const cod = order.cod != null ? !!order.cod : /^(cod|cash_on_delivery)$/i.test(String(order.paymentMode || ''));
        params.push(booked.externalId || null, order.openBox ? 1 : 0, order.fragile ? 1 : 0, order.heavy ? 1 : 0, cod ? 1 : 0, cod ? Number(order.totalAmount) || 0 : null);
        if (booked.trackingNo) {
            sets.push('commerce_provider_tracking = ?');
            params.push(String(booked.trackingNo));
        }
    } else {
        sets.push('shipday_order_id = ?', 'shipday_tracking_link = ?');
        params.push(booked.externalId || null, booked.trackingLink || null);
    }
    params.push(order.id);
    db.run(`UPDATE book_orders SET ${sets.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) return cb(err);
        const after = () =>
            logEvent(
                db,
                order.id,
                'pickup_scheduled',
                'Pickup requested from courier partner',
                commerce.COURIER_PARTNER_NAME + ' · ' + booked.mode,
                { kind: 'pickup_scheduled', city: '' },
                () => logHubEvents(db, order.id, booked.events, () => cb(null))
            );
        if (booked.provider !== 'fleetbase') return after();
        fleetNetwork.prepareFleetbaseShipment(db, order.id, cfg && cfg.shop, (e2) => {
            if (e2) return cb(e2);
            if (booked.mode !== 'hyperlocal') return after();
            fleetNetwork.offerHyperlocal(db, order, cfg, () => after());
        });
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
    const planned = fleetNetwork.plannedStopTimes(mode, provider, options.pickupAtMs || null, cfg && cfg.shop, Date.now());
    const pickupAtMs = planned.pickupAtMs;
    const dropAtMs = planned.dropAtMs;
    const next = Object.assign({}, order, {
        pickupOtp: '',
        deliveryOtp: '',
        storeLat: order.storeLat != null ? order.storeLat : cfg.storeLat,
        storeLng: order.storeLng != null ? order.storeLng : cfg.storeLng,
        pickupAtMs,
        dropAtMs,
        returnLeg: !!options.returnLeg,
        openBox: provider === 'fleetbase' && (options.openBox != null ? !!options.openBox : !!(cfg.fleetbase && cfg.fleetbase.openBoxDelivery))
    });
    const placeBooking = () => {
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
                     return_pidge_order_id = CASE WHEN ? = 'pidge' THEN ? ELSE return_pidge_order_id END,
                     return_fleetbase_order_id = CASE WHEN ? = 'fleetbase' THEN ? ELSE return_fleetbase_order_id END,
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [
                        provider,
                        mode,
                        booked.provider === 'pidge' || booked.provider === 'shipday' ? '' : booked.pickupOtp || '',
                        when,
                        booked.trackingLink || null,
                        provider,
                        booked.externalId || null,
                        provider,
                        booked.deliveryExternalId || null,
                        provider,
                        booked.externalId || null,
                        provider,
                        booked.externalId || null,
                        provider,
                        booked.externalId || null,
                        order.id
                    ],
                    (err) => {
                        if (err) return cb(err);
                        const done = () =>
                            logEvent(
                                db,
                                order.id,
                                'return_pickup_scheduled',
                                'Return pickup requested from courier partner',
                                commerce.COURIER_PARTNER_NAME + ' · ' + mode,
                                { kind: 'return', city: '' },
                                () => cb(null, booked)
                            );
                        if (provider !== 'fleetbase') return done();
                        fleetNetwork.prepareFleetbaseShipment(db, order.id, cfg && cfg.shop, () => done());
                    }
                );
            })
            .catch((e) => cb(e));
    }
    bookWithProvider(cfg, next, provider, mode)
        .then((booked) => {
            persistBooking(db, next, booked, (err) => cb(err, booked), cfg);
        })
        .catch((e) => cb(e));
    };
    if (provider !== 'fleetbase') return placeBooking();
    fleetNetwork.issueAwb(db, order.id, (awbErr, awb) => {
        if (awbErr) return cb(awbErr);
        next.commerceAwb = awb;
        placeBooking();
    });
}

function chooseAutoBooking(cfg, order) {
    const mode = order.commerceMode === 'hyperlocal' || order.commerceMode === 'logistics' ? order.commerceMode : order.fulfillmentType === 'courier' ? 'logistics' : cfg.defaultMode;
    if (mode === 'logistics') {
        if (cfg.tookan.enabled) return { provider: 'tookan', mode: 'logistics' };
        if (cfg.pidge && cfg.pidge.enabled) return { provider: 'pidge', mode: 'logistics' };
        if (cfg.fleetbase && cfg.fleetbase.enabled) return { provider: 'fleetbase', mode: 'logistics' };
        return { error: 'Tookan, Pidge, or Fleetbase is not configured for logistics.' };
    }
    const named = order.commerceProvider === 'tookan' || order.commerceProvider === 'shipday' || order.commerceProvider === 'pidge' || order.commerceProvider === 'fleetbase';
    const prefer = named ? order.commerceProvider : cfg.defaultHyperlocalProvider;
    if (prefer === 'shipday' && cfg.shipday.enabled) return { provider: 'shipday', mode: 'hyperlocal' };
    if (prefer === 'pidge' && cfg.pidge && cfg.pidge.enabled) return { provider: 'pidge', mode: 'hyperlocal' };
    if (prefer === 'fleetbase' && cfg.fleetbase && cfg.fleetbase.enabled) return { provider: 'fleetbase', mode: 'hyperlocal' };
    if (cfg.tookan.enabled) return { provider: 'tookan', mode: 'hyperlocal' };
    if (cfg.shipday.enabled) return { provider: 'shipday', mode: 'hyperlocal' };
    if (cfg.pidge && cfg.pidge.enabled) return { provider: 'pidge', mode: 'hyperlocal' };
    if (cfg.fleetbase && cfg.fleetbase.enabled) return { provider: 'fleetbase', mode: 'hyperlocal' };
    return { error: 'No hyperlocal provider is configured.' };
}

function refreshLive(db, cfg, order, cb) {
    const done = (update) => {
        if (!update) return refreshReturn(db, cfg, order, cb);
        applyUpdate(db, order, update, (err) => {
            if (err) return cb(err);
            refreshReturn(db, cfg, order, (e2, fresh) => {
                if (fresh && typeof update.lineFill === 'number') fresh.lineFill = update.lineFill;
                cb(e2, fresh);
            });
        });
    };
    if (order.commerceProvider === 'tookan' && order.tookanJobId && order.commerceStage !== 'delivered' && order.commerceMode === 'logistics') {
        commerce
            .fetchTookanParcelUpdate(cfg, order)
            .then((update) => done(update))
            .catch((e) => cb(e));
        return;
    }
    if (order.commerceProvider === 'tookan' && order.tookanJobId && order.commerceStage !== 'delivered') {
        const pickup = commerce.fetchTookanJob(cfg, order.tookanJobId);
        const delivery = order.tookanDeliveryJobId ? commerce.fetchTookanJob(cfg, order.tookanDeliveryJobId) : Promise.resolve(null);
        Promise.all([pickup, delivery])
            .then(([pJob, dJob]) => {
                const p = commerce.tookanJobToUpdate(pJob, order.commerceMode, 'pickup');
                const d = dJob ? commerce.tookanJobToUpdate(dJob, order.commerceMode, 'delivery') : null;
                const update = commerce.combineTookanUpdates(p, d);
                if (update && order.commerceMode !== 'logistics') {
                    const places = commerce.tookanPlacesFromJobs(pJob, dJob);
                    if (places.storeLat != null) {
                        update.storeLat = places.storeLat;
                        update.storeLng = places.storeLng;
                    }
                    if (places.dropLat != null) {
                        update.dropLat = places.dropLat;
                        update.dropLng = places.dropLng;
                    }
                }
                if (!update || order.commerceMode === 'logistics') return update;
                const fleetId = (dJob && dJob.fleet_id) || (pJob && pJob.fleet_id);
                return commerce
                    .fetchTookanFleet(cfg, fleetId)
                    .then((agent) => {
                        if (!agent) return update;
                        if (!update.agentName && agent.name) update.agentName = agent.name;
                        if (!update.agentPhone && agent.phone) update.agentPhone = agent.phone;
                        if (agent.lat != null && agent.lng != null && agent.at) {
                            update.agentLat = agent.lat;
                            update.agentLng = agent.lng;
                            update.agentLocationAt = agent.at;
                        }
                        if (agent.name || agent.phone) update.liveLeg = update.liveLeg || 'to_drop';
                        return update;
                    })
                    .catch(() => update);
            })
            .then((update) => done(update))
            .catch((e) => cb(e));
        return;
    }
    const shipdayNeedsPlace = order.storeLat == null || order.dropLat == null;
    if (order.commerceProvider === 'shipday' && order.shipdayOrderId && (order.commerceStage !== 'delivered' || shipdayNeedsPlace)) {
        commerce
            .fetchShipdayOrder(cfg, order.shipdayOrderId, order.orderCode)
            .then((row) => {
                const update = commerce.shipdayOrderToUpdate(row);
                if (!update || update.kind === 'failed' || update.agentLat != null || !update.carrierId || update.stage === 'delivered' || order.commerceStage === 'delivered') return update;
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
    if (order.commerceProvider === 'fleetbase' && order.fleetbaseOrderId && order.commerceStage !== 'delivered') {
        commerce
            .fetchFleetbaseUpdate(cfg, order)
            .then((update) => done(update))
            .catch((e) => cb(e));
        return;
    }
    if (order.commerceProvider === 'pidge' && order.pidgeOrderId && order.commerceStage !== 'delivered') {
        commerce
            .fetchPidgeUpdate(cfg, order)
            .then((update) => done(update))
            .catch((e) => cb(e));
        return;
    }
    refreshReturn(db, cfg, order, cb);
}

function refreshReturn(db, cfg, order, cb) {
    const open = order.returnStatus === 'pickup_scheduled' || order.returnStatus === 'in_transit';
    if (open && order.returnProvider === 'fleetbase' && order.returnFleetbaseOrderId) {
        commerce
            .fetchFleetbaseUpdate(cfg, {
                fleetbaseOrderId: order.returnFleetbaseOrderId,
                commerceMode: order.returnMode === 'hyperlocal' ? 'hyperlocal' : 'logistics'
            })
            .then((update) => {
                if (!update) return loadOrder(db, order.id, cb);
                applyReturnUpdate(db, order, update, () => loadOrder(db, order.id, cb));
            })
            .catch(() => loadOrder(db, order.id, cb));
        return;
    }
    if (open && order.returnProvider === 'pidge' && order.returnPidgeOrderId) {
        commerce
            .fetchPidgeUpdate(cfg, {
                pidgeOrderId: order.returnPidgeOrderId,
                commerceMode: order.returnMode === 'hyperlocal' ? 'hyperlocal' : 'logistics'
            })
            .then((update) => {
                if (!update) return loadOrder(db, order.id, cb);
                applyReturnUpdate(db, order, update, () => loadOrder(db, order.id, cb));
            })
            .catch(() => loadOrder(db, order.id, cb));
        return;
    }
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
 * Only tasks this site booked are tracked. Tookan and Shipday match stored job ids.
 * Pidge matches its order id, then the source order code we sent as reference_id.
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
    if (parsed.provider === 'fleetbase' && (parsed.fleetbaseOrderId || parsed.referenceId)) {
        return db.get(`SELECT id FROM book_orders WHERE fleetbase_order_id = ?`, [parsed.fleetbaseOrderId || ''], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, { id: row.id, leg: 'forward' });
            db.get(`SELECT id FROM book_orders WHERE return_fleetbase_order_id = ?`, [parsed.fleetbaseOrderId || ''], (e2, ret) => {
                if (e2) return cb(e2);
                if (ret) return cb(null, { id: ret.id, leg: 'return' });
                if (!parsed.referenceId) return byCode('forward');
                db.get(`SELECT id FROM book_orders WHERE order_code = ?`, [parsed.referenceId], (e3, byRef) => {
                    if (e3) return cb(e3);
                    if (byRef) return cb(null, { id: byRef.id, leg: 'forward' });
                    byCode('forward');
                });
            });
        });
    }
    if (parsed.pidgeOrderId || parsed.referenceId) {
        return db.get(`SELECT id FROM book_orders WHERE pidge_order_id = ?`, [parsed.pidgeOrderId || ''], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, { id: row.id, leg: 'forward' });
            db.get(`SELECT id FROM book_orders WHERE return_pidge_order_id = ?`, [parsed.pidgeOrderId || ''], (e2, ret) => {
                if (e2) return cb(e2);
                if (ret) return cb(null, { id: ret.id, leg: 'return' });
                if (!parsed.referenceId) return byCode('forward');
                db.get(`SELECT id FROM book_orders WHERE order_code = ?`, [parsed.referenceId], (e3, byRef) => {
                    if (e3) return cb(e3);
                    if (byRef) return cb(null, { id: byRef.id, leg: 'forward' });
                    byCode('forward');
                });
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
    ensureCommerceSchema(db, () => {});
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
                    provider === 'tookan' || provider === 'shipday' || provider === 'pidge' ? provider : null,
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
            if (provider !== 'tookan' && provider !== 'shipday' && provider !== 'pidge' && provider !== 'fleetbase') {
                return res.status(400).json({ error: 'Choose Tookan, Shipday, Pidge, or Fleetbase.' });
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
                    const openBox = req.body && Object.prototype.hasOwnProperty.call(req.body, 'openBox') ? !!req.body.openBox : null;
                    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'fragile')) order.fragile = !!req.body.fragile;
                    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'heavy')) order.heavy = !!req.body.heavy;
                    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'cod')) order.cod = !!req.body.cod;
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
                        { pickupAtMs, openBox }
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
                    const networkAwb = fleetNetwork.isAwb(order.commerceAwb) ? order.commerceAwb : '';
                    const sendPrinted = (awb) => {
                        res.setHeader('Content-Type', 'text/html; charset=utf-8');
                        const printed = order.commerceProvider === 'fleetbase' && networkAwb ? networkAwb : awb;
                        if (!printed) return res.status(409).send(commerce.labelWaitingHtml(order));
                        res.send(commerce.labelHtml(Object.assign({}, order, { courierTrackingNo: printed }), cfg));
                    };
                    commerce
                        .fetchProviderSnapshot(cfg, order)
                        .then((update) => {
                            const awb = commerce.awbFromUpdate(update) || networkAwb;
                            if (!update) return sendPrinted(awb);
                            applyUpdate(db, order, update, () => sendPrinted(awb));
                        })
                        .catch(() => {
                            if (networkAwb) return sendPrinted(networkAwb);
                            res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8');
                            res.send(commerce.labelWaitingHtml(order));
                        });
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
            if (provider !== 'tookan' && provider !== 'shipday' && provider !== 'pidge' && provider !== 'fleetbase') {
                return res.status(400).json({ error: 'Choose Tookan, Shipday, Pidge, or Fleetbase.' });
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

    app.post('/api/public/commerce/delivery-note', (req, res) => {
        const token = String((req.body && req.body.token) || '').trim();
        const note = String((req.body && req.body.note) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id FROM book_orders WHERE tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadConfig(db, (cErr, raw, cfg) => {
                    if (cErr) return res.status(500).json({ error: cErr.message });
                    loadOrder(db, row.id, (e2, order) => {
                        if (e2 || !order) return res.status(404).json({ error: 'Shipment not found.' });
                        loadEvents(db, row.id, (e3, events) => {
                            if (e3) return res.status(500).json({ error: e3.message });
                            const track = shipmentEngine.buildCustomerTracking(order, events || [], { shop: cfg.shop });
                            if (!track.map.enabled) {
                                return res.status(400).json({ error: 'Delivery instructions can be saved while this delivery is active.' });
                            }
                            db.run(`UPDATE book_orders SET delivery_note = ? WHERE id = ?`, [note || null, row.id], (e4) => {
                                if (e4) return res.status(500).json({ error: e4.message });
                                res.json({ success: true, deliveryNote: note });
                            });
                        });
                    });
                });
            });
        });
    });

    app.post('/api/public/commerce/reschedule', (req, res) => {
        const token = String((req.body && req.body.token) || '').trim();
        const date = String((req.body && req.body.date) || '').trim();
        const start = String((req.body && req.body.start) || '').trim();
        const end = String((req.body && req.body.end) || '').trim();
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id FROM book_orders WHERE tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadConfig(db, (cErr, raw, cfg) => {
                    if (cErr) return res.status(500).json({ error: cErr.message });
                    loadOrder(db, row.id, (e2, order) => {
                        if (e2 || !order) return res.status(404).json({ error: 'Shipment not found.' });
                        loadEvents(db, row.id, (e3, events) => {
                            const track = shipmentEngine.buildCustomerTracking(order, events || [], { shop: cfg.shop });
                            if (track.fulfillmentType !== 'HYPERLOCAL') {
                                return res.status(400).json({ error: 'Only a hyperlocal delivery can be rescheduled here.' });
                            }
                            if (track.operationalStatus !== 'DELIVERY_ATTEMPT_FAILED') {
                                return res.status(400).json({ error: 'This order is not waiting for a new delivery time.' });
                            }
                            if (!shipmentEngine.slotAllowed(cfg.shop, date, start, end)) {
                                return res.status(400).json({ error: 'That time is outside the store delivery hours.' });
                            }
                            if (order.commerceProvider === 'pidge') {
                                return res.status(400).json({ error: 'Pidge does not accept a new delivery window on the order update API.' });
                            }
                            if (order.commerceProvider === 'shipday' && !order.shipdayOrderId) {
                                return res.status(400).json({ error: 'This shipment has no Shipday order to reschedule.' });
                            }
                            if (order.commerceProvider === 'tookan' && !(order.tookanDeliveryJobId || order.tookanJobId)) {
                                return res.status(400).json({ error: 'This shipment has no Tookan task to reschedule.' });
                            }
                            if (order.commerceProvider === 'fleetbase' && !order.fleetbaseOrderId) {
                                return res.status(400).json({ error: 'This shipment has no Fleetbase order to reschedule.' });
                            }
                            const startMs = Date.parse(date + 'T' + start + ':00+05:30');
                            const endIso = date + 'T' + end + ':00+05:30';
                            const run = order.commerceProvider === 'shipday'
                                ? commerce.rescheduleShipdayDelivery(cfg, order.shipdayOrderId, startMs)
                                : order.commerceProvider === 'fleetbase'
                                  ? commerce.rescheduleFleetbaseDelivery(cfg, order.fleetbaseOrderId, startMs)
                                  : commerce.rescheduleTookanDelivery(cfg, order.tookanDeliveryJobId || order.tookanJobId, startMs);
                            run.then(() => {
                                db.run(
                                    `UPDATE book_orders SET rescheduled_at = ?, rescheduled_for_start = ?, rescheduled_for_end = ?, live_leg = 'none', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                    [new Date().toISOString(), date + 'T' + start + ':00+05:30', endIso, order.id],
                                    (uerr) => {
                                        if (uerr) return res.status(500).json({ error: uerr.message });
                                        recordReschedule(db, order, { date, start, end }, () => {
                                            logEvent(
                                                db,
                                                order.id,
                                                'rescheduled',
                                                'Delivery has been rescheduled',
                                                start + ' – ' + end,
                                                {
                                                    kind: 'rescheduled',
                                                    city: '',
                                                    at: new Date().toISOString(),
                                                    source: 'commerce',
                                                    provider: order.commerceProvider || '',
                                                    normalizedStatus: 'RESCHEDULED',
                                                    rescheduleSource: 'customer'
                                                },
                                                () => res.json({ success: true })
                                            );
                                        });
                                    }
                                );
                            }).catch((e) => res.status(400).json({ error: e.message || 'The delivery partner could not reschedule this order.' }));
                        });
                    });
                });
            });
        });
    });

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
                                const timeline = shopTimeline.buildShopTimeline(subject, events, { shop: cfg.shop });
                                const view = commerce.customerTrackView(subject, events, cfg);
                                const track = shipmentEngine.buildCustomerTracking(subject, events, { shop: cfg.shop });
                                const finish = (attempt) => {
                                    track.deliveryAttempt = attempt;
                                    view.timeline = timeline;
                                    view.track = track;
                                    const liveSubject = track.map.enabled && !track.map.live ? Object.assign({}, subject, { agentLat: null, agentLng: null }) : subject;
                                    view.live = track.map.enabled ? shopTimeline.buildLiveView(liveSubject, timeline, cfg.mapsApiKey, {}) : null;
                                    if (!track.map.enabled) {
                                        view.liveMap = false;
                                        view.mapsApiKey = null;
                                        view.agentLat = null;
                                        view.agentLng = null;
                                        view.liveLeg = 'none';
                                    }
                                    view.awbTrackUrl = null;
                                    view.deliveryOtp = track.deliveryOtp;
                                    view.agentName = track.agent ? track.agent.name : null;
                                    view.agentPhone = track.agent ? track.agent.phone : null;
                                    res.json({ success: true, shipment: view });
                                };
                                db.get(
                                    `SELECT attempt_number, status, scheduled_date, scheduled_start, scheduled_end, failure_reason,
                                            rescheduled_at, rescheduled_for_start, rescheduled_for_end, reschedule_source
                                     FROM delivery_attempts WHERE shipment_id = ? ORDER BY attempt_number DESC, id DESC LIMIT 1`,
                                    [row.id],
                                    (aErr, attempt) => {
                                        if (aErr || !attempt) return finish(null);
                                        finish({
                                            attemptNumber: attempt.attempt_number,
                                            status: attempt.status,
                                            scheduledDate: attempt.scheduled_date,
                                            scheduledStart: attempt.scheduled_start,
                                            scheduledEnd: attempt.scheduled_end,
                                            failureReason: attempt.failure_reason,
                                            rescheduledAt: attempt.rescheduled_at,
                                            rescheduledForStart: attempt.rescheduled_for_start,
                                            rescheduledForEnd: attempt.rescheduled_for_end,
                                            rescheduleSource: attempt.reschedule_source
                                        });
                                    }
                                );
                            });
                        };
                        if (order.tookanJobId || order.shipdayOrderId || order.pidgeOrderId || order.fleetbaseOrderId) {
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
        ensureCommerceSchema(db, () => loadConfig(db, (err, raw, cfg) => {
            if (cfg.tookan.sharedSecret && parsed.sharedSecret && parsed.sharedSecret !== cfg.tookan.sharedSecret) {
                return res.status(401).json({ error: 'Invalid shared secret' });
            }
            findOrderForWebhook(db, parsed, (e2, hit) => {
                if (e2 || !hit) return res.json({ success: true, matched: false });
                loadOrder(db, hit.id, (e3, order) => {
                    if (!order) return res.json({ success: true, matched: false });
                    if (hit.leg !== 'return' && order.commerceMode === 'logistics' && order.commerceProvider === 'tookan') {
                        return commerce
                            .fetchTookanParcelUpdate(cfg, order)
                            .then((update) => {
                                applyUpdate(db, order, update, () => res.json({ success: true, matched: true }));
                            })
                            .catch(() => res.json({ success: true, matched: true }));
                    }
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
        }));
    });

    app.post('/api/public/shipday/webhook', (req, res) => {
        const parsed = commerce.parseShipdayWebhook(req.body || {});
        ensureCommerceSchema(db, () => findOrderForWebhook(db, parsed, (err, hit) => {
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
        }));
    });

    app.post('/api/public/pidge/webhook', (req, res) => {
        ensureCommerceSchema(db, () => loadConfig(db, (err, raw, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!commerce.pidgeWebhookAuthorized(cfg, req.get('authorization'))) {
                return res.status(401).json({ error: 'Invalid token' });
            }
            const payload = commerce.unwrapPidgePayload(req.body || {});
            const parsed = commerce.pidgePayloadToUpdate(payload, 'logistics');
            if (!parsed || (!parsed.pidgeOrderId && !parsed.referenceId)) return res.json({ success: true, matched: false });
            findOrderForWebhook(db, parsed, (e2, hit) => {
                if (e2 || !hit) return res.json({ success: true, matched: false });
                loadOrder(db, hit.id, (e3, order) => {
                    if (!order) return res.json({ success: true, matched: false });
                    const mode = hit.leg === 'return' ? (order.returnMode === 'hyperlocal' ? 'hyperlocal' : 'logistics') : order.commerceMode || 'logistics';
                    const update = commerce.pidgePayloadToUpdate(payload, mode);
                    if (hit.leg === 'return') {
                        return applyReturnUpdate(db, order, update, () => res.json({ success: true, matched: true, leg: 'return' }));
                    }
                    applyUpdate(db, order, update, () => res.json({ success: true, matched: true }));
                });
            });
        }));
    });

    app.post('/api/public/fleetbase/webhook', (req, res) => {
        ensureCommerceSchema(db, () => loadConfig(db, (err, raw, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            const token = req.get('authorization') || req.get('x-fleetbase-webhook-token');
            if (!commerce.fleetbaseWebhookAuthorized(cfg, token)) {
                return res.status(401).json({ error: 'Invalid token' });
            }
            const parsed = commerce.parseFleetbaseWebhook(req.body || {});
            if (!parsed || (!parsed.fleetbaseOrderId && !parsed.referenceId)) return res.json({ success: true, matched: false });
            findOrderForWebhook(db, parsed, (e2, hit) => {
                if (e2 || !hit) return res.json({ success: true, matched: false });
                loadOrder(db, hit.id, (e3, order) => {
                    if (!order) return res.json({ success: true, matched: false });
                    const mode = hit.leg === 'return' ? (order.returnMode === 'hyperlocal' ? 'hyperlocal' : 'logistics') : order.commerceMode || 'logistics';
                    const update = commerce.fleetbaseOrderToUpdate(req.body || {}, mode);
                    if (hit.leg === 'return') {
                        return applyReturnUpdate(db, order, update, () => res.json({ success: true, matched: true, leg: 'return' }));
                    }
                    applyUpdate(db, order, update, () => res.json({ success: true, matched: true }));
                });
            });
        }));
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

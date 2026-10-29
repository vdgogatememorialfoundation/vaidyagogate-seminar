/**
 * Admin Commerce desk + public tracking for Tookan and Shipday.
 */
const commerce = require('./commerce-logistics');
const journey = require('./commerce-journey');
const shopTimeline = require('./shop-timeline');
const shipmentEngine = require('./shipment-engine');
const emailService = require('./email-service');
const ROUTINE_ALERTS = new Set(['transit']);
/** Material alerts (date change, action needed, reattempt confirmed, delivered receipt, case/appointment updates) — never muted; routine transit updates respect the mute preference. */
function notifyMaterial(order, kind, subject, text) {
    const prefs = (order && order.notifyPrefs) || {};
    if (ROUTINE_ALERTS.has(kind) && prefs.muteRoutine) return;
    const to = order && order.buyerEmail;
    if (!to || !emailService.isEmailConfigured || !emailService.isEmailConfigured()) return;
    const link = order.trackingToken ? '<p><a href="https://seminar.vaidyagogate.org/track-commerce?token=' + order.trackingToken + '">Open tracking</a></p>' : '';
    Promise.resolve()
        .then(() => emailService.sendEmail(to, subject, '<p>' + String(text || '').replace(/</g, '&lt;') + '</p>' + link))
        .catch(() => {});
}

function saveAppointments(db, orderId, list, cb) {
    db.run(`UPDATE book_orders SET appointment_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(list), orderId], cb);
}

const bookAuth = require('./book-sales-auth');
const fleetNetwork = require('./fleet-network');
const branding = require('./branding');
const pdfServer = require('./certificate-pdf-server');

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
        `SELECT bo.*, COALESCE(bo.buyer_email, u.email) AS buyer_email FROM book_orders bo LEFT JOIN users u ON u.id = bo.user_id WHERE bo.id = ?`,
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
        `SELECT description AS title, location AS detail, event_city AS city, facility AS kind, event_at AS at, source
         FROM book_courier_track_events WHERE book_order_id = ? AND COALESCE(source,'') <> 'commerce_return' ORDER BY event_at ASC, id ASC`,
        [orderId],
        (err, rows) => cb(err, rows || [])
    );
}

function loadReturnEvents(db, orderId, cb) {
    db.all(
        `SELECT description AS title, location AS detail, event_city AS city, facility AS kind, event_at AS at, source
         FROM book_courier_track_events WHERE book_order_id = ? AND source = 'commerce_return' ORDER BY event_at ASC, id ASC`,
        [orderId],
        (err, rows) => cb(err, rows || [])
    );
}

function ensureReturnToken(db, orderId, cb) {
    db.run(
        `UPDATE book_orders SET return_tracking_token = COALESCE(NULLIF(return_tracking_token, ''), ?) WHERE id = ?`,
        [commerce.generateToken(), orderId],
        () => cb && cb()
    );
}

const RETURN_TITLES = {
    requested: 'Return requested',
    approved: 'Return approved',
    rejected: 'Return request declined',
    pickup_scheduled: 'Return pickup scheduled',
    in_transit: 'Return on the way back to store',
    received: 'Return received at store',
    refunded: 'Refund issued',
    replacement_preparing: 'Replacement being prepared',
    replacement_sent: 'Replacement shipped',
    replacement_delivered: 'Replacement delivered'
};

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

function logHubEvents(db, orderId, events, cb, meta) {
    const extras = Array.isArray(events) ? events : [];
    let i = 0;
    const step = () => {
        if (i >= extras.length) return cb && cb();
        let ev = extras[i++];
        const title = ev && ev.title ? String(ev.title) : '';
        const received = /^shipment received at\s+\S/i.test(title);
        const left = /^shipment left\s+\S/i.test(title);
        const milestone = ev.kind === 'delivered' || ev.kind === 'out_for_delivery';
        if (!ev || (!received && !left && !milestone && ev.kind !== 'hub_eta' && ev.kind !== 'arrived_facility') || !title) return step();
        if (left) ev = Object.assign({}, ev, { kind: 'left_facility' });
        else if (received) ev = Object.assign({}, ev, { kind: 'arrived_facility' });
        logEventOnce(
            db,
            orderId,
            ev.kind,
            ev.title,
            ev.detail || '',
            Object.assign({ city: ev.city || '', kind: ev.kind, at: ev.at || null }, meta || {}),
            step
        );
    };
    step();
}


const STAGE_NOTIFY = { ready: 'BOOK_ORDER_PACKED', in_transit: 'BOOK_ORDER_SHIPPED', out_for_delivery: 'BOOK_ORDER_OUT_FOR_DELIVERY', delivered: 'BOOK_ORDER_DELIVERED' };
const KIND_NOTIFY = { picked_up: 'BOOK_ORDER_PICKED_UP', failed: 'BOOK_ORDER_ATTEMPT_FAILED' };
const RETURN_NOTIFY = { pickup_scheduled: 'BOOK_ORDER_RETURN_SCHEDULED', picked_up: 'BOOK_ORDER_RETURN_PICKED_UP', received: 'BOOK_ORDER_RETURN_RECEIVED', approved: 'BOOK_ORDER_RETURN_FAILED' };
/** Email/WhatsApp the buyer once per event per order (guarded by a book_order_events marker row). */
function notifyOnce(db, orderId, eventKey, cb) {
    if (!eventKey) return cb && cb();
    db.run(`CREATE TABLE IF NOT EXISTS book_order_notify_marks (book_order_id INTEGER NOT NULL, event_key TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (book_order_id, event_key))`, [], () => {
        db.get(`SELECT 1 AS hit FROM book_order_notify_marks WHERE book_order_id = ? AND event_key = ?`, [orderId, eventKey], (err, row) => {
            if (err || row) return cb && cb();
            db.run(`INSERT INTO book_order_notify_marks (book_order_id, event_key) VALUES (?, ?)`, [orderId, eventKey], (iErr) => {
                if (iErr) return cb && cb();
                try { require('./book-sales').notifyBookOrderById(db, orderId, eventKey, {}, () => cb && cb()); } catch (_) { cb && cb(); }
            });
        });
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
    if (stage) {
        const fromKey = shipmentEngine.mainKeyFromOrder(order);
        const toKey = shipmentEngine.mainKeyFromOrder({
            commerceStage: stage,
            status: order.status,
            commerceProvider: order.commerceProvider,
            fulfillmentType: order.fulfillmentType
        });
        if (!shipmentEngine.acceptsStageChange(fromKey, toKey, update)) {
            stage = null;
            update = Object.assign({}, update, {
                liveLeg: null,
                events: (update.events || []).filter((ev) => ev && ev.kind !== 'delivered' && ev.kind !== 'out_for_delivery')
            });
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
        if (update.pickupOtp) {
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
    if (update.cost != null && Number.isFinite(Number(update.cost))) {
        sets.push('commerce_cost = ?');
        params.push(Number(update.cost));
    }
    if (update.hubs && update.hubs.length) {
        sets.push('commerce_hubs_json = ?');
        params.push(JSON.stringify(update.hubs));
    }
    if (update.parcelInfo) {
        sets.push('commerce_parcel_json = ?');
        params.push(JSON.stringify(update.parcelInfo));
    }
    if (update.barcode) {
        sets.push("commerce_awb = CASE WHEN commerce_awb IS NULL OR TRIM(commerce_awb) = '' THEN ? ELSE commerce_awb END");
        params.push(String(update.barcode));
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
        sets.push('courier_delivered_at = COALESCE(?, courier_delivered_at, CURRENT_TIMESTAMP)');
        params.push(update.at || null);
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
        const notifyKey = (stage && stage !== order.commerceStage ? STAGE_NOTIFY[stage] : null) || KIND_NOTIFY[update.kind] || null;
        const after = () => logHubEvents(db, order.id, update.events, () => syncDeliveryAttempt(db, order, update, () => notifyOnce(db, order.id, notifyKey, () => {
            publishTrackingUpdate(order, update);
            cb(null);
        })));
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
        let pickupOtp = '';
        let deliveryOtp = '';
        try {
            const update = await commerce.fetchPidgeUpdate(cfg, { pidgeOrderId: booked.orderId, commerceMode: useMode });
            if (update && update.pickupOtp) pickupOtp = update.pickupOtp;
            if (update && update.deliveryOtp) deliveryOtp = update.deliveryOtp;
        } catch (_) {}
        return { provider: 'pidge', mode: useMode, externalId: booked.orderId, trackingLink: '', trackingNo: '', pickupOtp, deliveryOtp };
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
    const pickupOtp = booked.provider === 'shipday' ? '' : booked.pickupOtp || '';
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
    if (booked.quote && Number.isFinite(booked.quote.amount)) {
        sets.push('commerce_cost = ?');
        params.push(booked.quote.amount);
    }
    if (order.packageInfo && typeof order.packageInfo === 'object') {
        sets.push('commerce_package_json = ?');
        params.push(JSON.stringify(order.packageInfo));
    }
    if (booked.provider === 'tookan') {
        sets.push('tookan_job_id = ?', 'tookan_delivery_job_id = ?', 'tookan_tracking_link = ?');
        params.push(booked.externalId || null, booked.deliveryExternalId || null, booked.trackingLink || null);
        if (booked.barcode) {
            sets.push("courier_tracking_no = CASE WHEN courier_tracking_no IS NULL OR TRIM(courier_tracking_no) = '' THEN ? ELSE courier_tracking_no END", 'commerce_awb = ?');
            params.push(String(booked.barcode), String(booked.barcode));
        }
        if (booked.hubs && booked.hubs.length) {
            sets.push('commerce_hubs_json = ?');
            params.push(JSON.stringify(booked.hubs));
        }
        if (booked.parcelInfo) {
            sets.push('commerce_parcel_json = ?');
            params.push(JSON.stringify(booked.parcelInfo));
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
    let quote = (() => {
        try {
            return commerce.courierQuote(cfg, next, provider, mode, !!options.returnLeg);
        } catch (_) {
            return null;
        }
    })();
    const placeBooking = () =>
        commerce
            .providerQuote(cfg, next, provider, mode, !!options.returnLeg)
            .then((q) => {
                if (q) quote = q;
            })
            .catch(() => {})
            .then(() => placeBookingNow());
    const placeBookingNow = () => {
    if (options.returnLeg) {
        return bookWithProvider(cfg, next, provider, mode)
            .then((booked) => {
                booked.quote = quote;
                const when = booked.pickupAt || new Date(pickupAtMs).toISOString();
                const expected = booked.deliveryAt || (dropAtMs ? new Date(dropAtMs).toISOString() : null);
                db.run(
                    `UPDATE book_orders SET return_status = 'pickup_scheduled', return_provider = ?, return_mode = ?,
                     return_pickup_otp = ?, return_scheduled_at = ?, return_tracking_link = ?,
                     return_expected_at = ?, return_cost = ?, return_awb = ?, return_parcel_json = ?,
                     return_tookan_job_id = CASE WHEN ? = 'tookan' THEN ? ELSE return_tookan_job_id END,
                     return_tookan_delivery_job_id = CASE WHEN ? = 'tookan' THEN ? ELSE return_tookan_delivery_job_id END,
                     return_shipday_order_id = CASE WHEN ? = 'shipday' THEN ? ELSE return_shipday_order_id END,
                     return_pidge_order_id = CASE WHEN ? = 'pidge' THEN ? ELSE return_pidge_order_id END,
                     return_fleetbase_order_id = CASE WHEN ? = 'fleetbase' THEN ? ELSE return_fleetbase_order_id END,
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [
                        provider,
                        mode,
                        booked.provider === 'shipday' ? '' : booked.pickupOtp || '',
                        when,
                        booked.trackingLink || null,
                        expected,
                        quote && Number.isFinite(quote.amount) ? quote.amount : null,
                        booked.barcode || booked.trackingNo || null,
                        booked.parcelInfo ? JSON.stringify(booked.parcelInfo) : null,
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
                                commerce.COURIER_PARTNER_NAME + ' · ' + (mode === 'logistics' ? 'parcel' : mode),
                                { kind: 'return', city: '' },
                                () => loadOrder(db, order.id, (le, fresh) => require('./book-documents').emailReturnLabel(db, le ? null : fresh, () => cb(null, booked)))
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
            booked.quote = quote;
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
    if (!order.commerceProvider && order.courierTrackingNo && order.status !== 'delivered' && order.status !== 'cancelled') {
        const updatedMs = order.courierTrackUpdatedAt ? Date.parse(order.courierTrackUpdatedAt) : NaN;
        const stale = !Number.isFinite(updatedMs) || Math.abs(Date.now() - updatedMs) > 5 * 60 * 1000;
        if (stale) {
            const bookSales = require('./book-sales');
            return bookSales.refreshCourierTrackForOrder(db, order.id, (rErr) => {
                if (rErr) console.warn('[commerce] courier auto-refresh failed for order', order.id, rErr.message || rErr);
                loadOrder(db, order.id, (e2, fresh) => autoReturnShipment(db, cfg, fresh || order, (o2) => refreshReturn(db, cfg, o2, cb)));
            });
        }
    }
    refreshReturn(db, cfg, order, cb);
}

function courierLinkFor(provider, trackingNo) {
    if (!provider || !trackingNo) return null;
    const ext = require('./book-courier-tracking').courierExternalLink(provider, trackingNo);
    return ext && !ext.portalOnly ? ext.url : null;
}

/** When the courier marks the parcel RTO / returned, open a return shipment automatically. */
function autoReturnShipment(db, cfg, order, cb) {
    const flags = (order && order.courierTrackFlags) || {};
    if (!order || !flags.rto || order.returnStatus || !(cfg.shop && cfg.shop.autoReturnShipment)) return cb(order);
    createReturnShipment(db, order, { provider: order.courierProvider, trackingNo: order.courierTrackingNo, reason: 'Undelivered — returned by courier (RTO)', auto: true }, (err, fresh) =>
        cb(fresh || order)
    );
}

function createReturnShipment(db, order, opts, cb) {
    const provider = String((opts && opts.provider) || order.courierProvider || '').trim();
    const trackingNo = String((opts && opts.trackingNo) || '').trim();
    const link = courierLinkFor(provider, trackingNo);
    db.run(
        `UPDATE book_orders SET
            return_kind = COALESCE(return_kind, 'return'),
            return_status = 'in_transit',
            return_reason = COALESCE(return_reason, ?),
            return_provider = ?,
            return_mode = 'courier',
            return_tracking_link = ?,
            return_tracking_token = COALESCE(NULLIF(return_tracking_token, ''), ?),
            return_scheduled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [(opts && opts.reason) || 'Return shipment', provider || null, link || (trackingNo ? trackingNo : null), commerce.generateToken(), order.id],
        (uErr) => {
            if (uErr) return cb(uErr);
            logEvent(
                db,
                order.id,
                'return_shipment',
                (opts && opts.auto ? 'Return shipment opened automatically' : 'Return shipment created') + (provider ? ' · ' + provider : ''),
                trackingNo ? 'AWB ' + trackingNo : '',
                { kind: 'return', source: 'commerce_return', provider, trackingNo, link },
                () => loadOrder(db, order.id, cb)
            );
        }
    );
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
    if (order.returnMode === 'logistics') {
        commerce
            .fetchTookanParcelUpdate(cfg, {
                orderCode: order.orderCode,
                returnLeg: true,
                tookanJobId: order.returnTookanJobId,
                createdAt: order.returnScheduledAt || order.createdAt,
                commerceMode: 'logistics'
            })
            .then((update) => {
                if (!update) return loadOrder(db, order.id, cb);
                applyReturnUpdate(db, order, update, () => loadOrder(db, order.id, cb));
            })
            .catch(() => loadOrder(db, order.id, cb));
        return;
    }
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

const RETURN_EVENT_TITLES = {
    pickup_scheduled: 'Pickup requested from courier partner',
    agent_assigned: 'Pickup agent assigned',
    to_store: 'Pickup agent on the way to you',
    at_pickup: 'Pickup agent reached your location',
    picked_up: 'Item picked up from you',
    out_for_delivery: 'Item on the way back to the store',
    delivered: 'Return received at store',
    failed: 'Pickup attempt failed — will be retried'
};

function applyReturnUpdate(db, order, update, cb) {
    if (update.barcode || update.trackingLink || update.parcelInfo) {
        db.run(
            `UPDATE book_orders SET return_awb = COALESCE(NULLIF(return_awb, ''), ?), return_tracking_link = COALESCE(NULLIF(return_tracking_link, ''), ?), return_parcel_json = COALESCE(?, return_parcel_json) WHERE id = ?`,
            [update.barcode ? String(update.barcode) : null, update.trackingLink || null, update.parcelInfo ? JSON.stringify(update.parcelInfo) : null, order.id],
            () => {}
        );
    }
    if (update.cost != null && Number.isFinite(Number(update.cost))) {
        db.run(`UPDATE book_orders SET return_cost = ? WHERE id = ?`, [Number(update.cost), order.id], () => {});
    }
    let status = 'in_transit';
    if (update.kind === 'delivered') status = 'received';
    else if (update.kind === 'failed') status = 'approved';
    else if (update.kind === 'to_store' || update.kind === 'at_pickup') status = 'out_for_pickup';
    else if (update.kind === 'picked_up') status = 'picked_up';
    else if (['pickup_scheduled', 'agent_assigned'].includes(update.kind)) status = 'pickup_scheduled';
    const returnHubEvents = (update.events || []).map((ev) =>
        ev && ev.title ? Object.assign({}, ev, { title: String(ev.title).replace(/^shipment/i, 'Return shipment') }) : ev
    );
    const logReturnHubs = (next) => logHubEvents(db, order.id, returnHubEvents, next, { source: 'commerce_return' });
    if (update.kind === 'update' || (update.skipEvent && !['picked_up', 'delivered', 'failed'].includes(update.kind))) return logReturnHubs(() => cb(null));
    db.run(
        `UPDATE book_orders SET return_status = ?, return_agent_name = COALESCE(?, return_agent_name),
         return_agent_phone = COALESCE(?, return_agent_phone),
         return_agent_lat = COALESCE(?, return_agent_lat), return_agent_lng = COALESCE(?, return_agent_lng),
         return_tracking_link = COALESCE(?, return_tracking_link),
         return_scheduled_at = COALESCE(?, return_scheduled_at), return_expected_at = COALESCE(?, return_expected_at),
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
            status,
            update.agentName || null,
            update.agentPhone || null,
            update.agentLat,
            update.agentLng,
            update.trackingLink || null,
            update.pickupAt || null,
            update.deliveryAt || null,
            order.id
        ],
        (err) => {
            if (err) return cb(err);
            if (update.skipEvent) return logReturnHubs(() => cb(null));
            const phrased = /reached/i.test(update.title || '') && update.kind === 'out_for_delivery' ? 'Agent reached the store with your item' : RETURN_EVENT_TITLES[update.kind] || null;
            logEventOnce(
                db,
                order.id,
                'return_' + (update.kind || 'update'),
                phrased || update.title || 'Return shipment update',
                phrased ? (update.agentName ? 'Pickup agent ' + update.agentName : '') : update.detail || update.city || '',
                { city: update.city || '', kind: update.kind || '', source: 'commerce_return' },
                () => logReturnHubs(() => notifyOnce(db, order.id, status !== order.returnStatus || update.kind === 'failed' ? RETURN_NOTIFY[status] : null, () => cb(null)))
            );
        }
    );
}

/**
 * Tracking of the order linked to this one: the replacement order's forward shipment for a return,
 * or the original return/replacement pipeline for a replacement order.
 */
function loadLinkedTracks(db, cfg, order, cb) {
    const out = { replacementTrack: null, originReturnTrack: null, replacementOrderCode: null, originOrderCode: null };
    if (!order) return cb(null, out);
    const storeInfo = { state: cfg.storeState, city: cfg.storeCity, pincode: cfg.storePincode };
    const withReplacement = (next) => {
        if (!order.replacementOrderId) return next();
        loadOrder(db, order.replacementOrderId, (err, rep) => {
            if (err || !rep) return next();
            loadEvents(db, rep.id, (e2, events) => {
                out.replacementOrderCode = rep.orderCode || null;
                out.replacementTrack = shipmentEngine.buildCustomerTracking(rep, events || [], { shop: cfg.shop, store: storeInfo });
                next();
            });
        });
    };
    const withOrigin = (next) => {
        if (!order.replacementOfOrderId) return next();
        loadOrder(db, order.replacementOfOrderId, (err, orig) => {
            if (err || !orig || !orig.returnStatus) return next();
            loadReturnEvents(db, orig.id, (e2, events) => {
                out.originOrderCode = orig.orderCode || null;
                out.originReturnTrack = shipmentEngine.buildReturnTracking(orig, events || [], { shop: cfg.shop, store: storeInfo });
                next();
            });
        });
    };
    withReplacement(() => withOrigin(() => cb(null, out)));
}

function registerCommerceRoutes(app, db, deps) {
    /** Renders a label as HTML (print view) or, with ?format=pdf, as a downloadable PDF; store logo inlined when uploaded. */
    function sendLabel(req, res, cfg, fileBase, build) {
        const pdf = String(req.query.format || '').toLowerCase() === 'pdf';
        branding.loadSiteLogoDataUrl(db, (le, logoDataUrl) => {
            const opts = { labelSize: req.query.size, labelRoll: req.query.roll, labelStyle: req.query.style, labelPdf: pdf, labelUrl: req.originalUrl };
            const out = build(opts, logoDataUrl && !le ? Object.assign({}, cfg, { logoDataUrl }) : cfg);
            if (!pdf) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.send(out);
            }
            pdfServer
                .htmlToPdfBuffer(out, { landscape: false })
                .then((buf) => {
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', 'attachment; filename="' + String(fileBase).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf"');
                    res.send(buf);
                })
                .catch((pe) => res.status(500).send('PDF failed: ' + pe.message));
        });
    }

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

    const ORDER_CHILD_TABLES = [
        ['book_order_items', 'book_order_id'],
        ['book_order_events', 'book_order_id'],
        ['book_courier_track_events', 'book_order_id'],
        ['book_fulfillment_scans', 'book_order_id'],
        ['delivery_attempts', 'shipment_id'],
        ['commerce_runsheet_orders', 'order_id'],
        ['commerce_scans', 'order_id'],
        ['commerce_hl_offers', 'order_id'],
        ['commerce_delivery_slots', 'order_id']
    ];
    function deleteOrders(ids, cb) {
        if (!ids.length) return cb(null, 0);
        const marks = ids.map(() => '?').join(',');
        let i = 0;
        const next = () => {
            if (i >= ORDER_CHILD_TABLES.length) {
                return db.run(
                    `UPDATE book_orders SET replacement_order_id = NULL WHERE replacement_order_id IN (${marks})`,
                    ids,
                    () =>
                        db.run(`UPDATE book_orders SET replacement_of_order_id = NULL WHERE replacement_of_order_id IN (${marks})`, ids, () =>
                            db.run(`DELETE FROM book_orders WHERE id IN (${marks})`, ids, function (err) {
                                if (err) return cb(err);
                                cb(null, this && typeof this.changes === 'number' ? this.changes : ids.length);
                            })
                        )
                );
            }
            const [table, col] = ORDER_CHILD_TABLES[i++];
            db.run(`DELETE FROM ${table} WHERE ${col} IN (${marks})`, ids, () => next());
        };
        next();
    }

    app.post(
        '/api/admin/commerce/orders/:id/delete',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });
            deleteOrders([id], (err, n) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, deleted: n });
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/ops',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const action = String((req.body && req.body.action) || '').toLowerCase();
            const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
            const prep = shipmentEngine.PREP_STEPS.find(([k]) => k === action);
            const ops = shipmentEngine.OPS_ACTIONS[action];
            if (!prep && !ops) return res.status(400).json({ error: 'Unknown action' });
            const kind = prep ? 'prep' : ops[0];
            const title = prep ? prep[1] : ops[1];
            loadOrder(db, id, (err, order) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                const bump = prep && ['placed', 'accepted'].includes(String(order.commerceStage || 'placed')) ? 'preparing' : null;
                const next = () =>
                    logEvent(db, id, 'ops_' + action, title, note, { kind, source: 'commerce' }, () =>
                        loadOrder(db, id, (e2, fresh) => res.json({ success: true, order: fresh }))
                    );
                if (!bump) return next();
                db.run(`UPDATE book_orders SET commerce_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [bump, id], () => next());
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/return-delete',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid order id' });
            loadOrder(db, id, (e2, order) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                if (!order.returnStatus) return res.status(409).json({ error: 'No return or replacement request on this order.' });
                db.run(
                    `UPDATE book_orders SET return_status = NULL, return_kind = NULL, return_reason = NULL, return_provider = NULL, return_mode = NULL,
                     return_pickup_otp = NULL, return_scheduled_at = NULL, return_tracking_link = NULL, return_tracking_token = NULL, return_awb = NULL,
                     return_expected_at = NULL, return_cost = NULL, return_received_at = NULL, return_check_json = NULL,
                     return_tookan_job_id = NULL, return_tookan_delivery_job_id = NULL, return_shipday_order_id = NULL, return_pidge_order_id = NULL,
                     return_fleetbase_order_id = NULL, return_parcel_json = NULL, return_agent_name = NULL, return_agent_phone = NULL, return_agent_lat = NULL, return_agent_lng = NULL,
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [id],
                    (e3) => {
                        if (e3) return res.status(500).json({ error: e3.message });
                        db.run(`DELETE FROM book_courier_track_events WHERE book_order_id = ? AND source = 'commerce_return'`, [id], () =>
                            logEvent(db, id, 'return_deleted', 'Return / replacement request deleted by admin', '', { kind: 'order', city: '' }, () =>
                                loadOrder(db, id, (e4, fresh) => res.json({ success: true, order: fresh }))
                            )
                        );
                    }
                );
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/delete-all',
        guard({ orders: true }, (req, res) => {
            if (String(req.body && req.body.confirm) !== 'DELETE ALL') return res.status(400).json({ error: 'Type DELETE ALL to confirm.' });
            db.all(`SELECT id FROM book_orders`, [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const ids = (rows || []).map((r) => r.id);
                deleteOrders(ids, (e2, n) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ success: true, deleted: n });
                });
            });
        })
    );

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

    app.get(
        '/api/admin/commerce/orders/:id/quote',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const provider = String(req.query.provider || '').toLowerCase();
            const mode = provider === 'shipday' ? 'hyperlocal' : String(req.query.mode || '').toLowerCase() === 'hyperlocal' ? 'hyperlocal' : 'logistics';
            const returnLeg = /^(1|true|yes)$/i.test(String(req.query.returnLeg || ''));
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    if (!order) return res.status(404).json({ error: 'Order not found' });
                    commerce
                        .providerQuote(cfg, order, provider, mode, returnLeg)
                        .then((quote) => res.json({ success: true, quote }))
                        .catch((e3) => res.status(500).json({ error: e3.message }));
                });
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
                    if (req.body && req.body.service) order.service = String(req.body.service).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
                    if (req.body && req.body.package && typeof req.body.package === 'object') {
                        const pk = req.body.package;
                        order.packageInfo = {
                            type: String(pk.type || 'box').slice(0, 40),
                            boxSize: String(pk.boxSize || '').slice(0, 40),
                            lengthCm: commerceNum(pk.lengthCm),
                            widthCm: commerceNum(pk.widthCm),
                            heightCm: commerceNum(pk.heightCm),
                            weightKg: commerceNum(pk.weightKg),
                            count: Math.max(1, parseInt(pk.count, 10) || 1),
                            contents: String(pk.contents || '').slice(0, 200)
                        };
                    }
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
                        loadEvents(db, id, (e4, events) => loadReturnEvents(db, id, (e5, retEvents) => loadLinkedTracks(db, cfg, fresh, (e6, linked) => {
                            const storeInfo = { state: cfg.storeState, city: cfg.storeCity, pincode: cfg.storePincode };
                            const adminTimeline = fresh ? shopTimeline.buildShopTimeline(fresh, events, { admin: true, shop: cfg.shop, store: { state: cfg.storeState, city: cfg.storeCity, pincode: cfg.storePincode } }) : null;
                            const payload = {
                                success: true,
                                order: fresh,
                                linked,
                                events,
                                returnEvents: retEvents,
                                track: fresh ? shipmentEngine.buildCustomerTracking(fresh, events, { shop: cfg.shop, store: storeInfo }) : null,
                                returnTrack: fresh ? shipmentEngine.buildReturnTracking(fresh, retEvents, { shop: cfg.shop, store: storeInfo }) : null,
                                mapsApiKey: cfg.mapsApiKey || null,
                                pickupOtp: fresh && fresh.pickupOtp,
                                deliveryOtp: fresh && fresh.deliveryOtp,
                                timeline: adminTimeline,
                                live: fresh ? shopTimeline.buildLiveView(fresh, adminTimeline, cfg.mapsApiKey, { admin: true }) : null
                            };
                            commerce.applyTraffic(cfg, payload).then(() => res.json(payload)).catch(() => res.json(payload));
                        })));
                    });
                });
            });
        })
    );

    app.get(
        '/api/admin/commerce/orders/:id/return-label',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order) => {
                    if (e2 || !order) return res.status(404).send('Order not found');
                    if (!order.returnStatus) return res.status(409).send('No return or replacement is open on this order.');
                    sendLabel(req, res, cfg, 'return-label-' + order.orderCode, (opts, cfg2) => commerce.returnLabelHtml(Object.assign({}, order, opts), cfg2));
                });
            });
        })
    );

    const RETURN_CHECK_KEYS = ['itemsMatch', 'qtyMatch', 'condition', 'complete'];
    app.post(
        '/api/admin/commerce/orders/:id/return-receive',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const body = req.body || {};
            const checks = {};
            RETURN_CHECK_KEYS.forEach((k) => (checks[k] = !!(body.checks && body.checks[k])));
            const notes = String(body.notes || '').trim().slice(0, 500);
            const passed = RETURN_CHECK_KEYS.every((k) => checks[k]);
            loadOrder(db, id, (e2, order) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!order || !order.returnStatus) return res.status(404).json({ error: 'No return or replacement is open on this order.' });
                const status = passed ? 'received' : 'rejected';
                db.run(
                    `UPDATE book_orders SET return_status = ?, return_check_json = ?, return_received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [status, JSON.stringify({ checks, notes, passed, by: req.body.actingAdminId || null }), id],
                    (uErr) => {
                        if (uErr) return res.status(500).json({ error: uErr.message });
                        const failed = RETURN_CHECK_KEYS.filter((k) => !checks[k]);
                        const labels = { itemsMatch: 'items did not match', qtyMatch: 'quantity mismatch', condition: 'condition not acceptable', complete: 'packaging/accessories incomplete' };
                        logEvent(
                            db,
                            id,
                            'return_received',
                            passed ? 'Return received at store · checks passed' : 'Return received at store · check failed: ' + failed.map((k) => labels[k]).join(', '),
                            notes || (passed ? 'received' : 'rejected'),
                            { kind: 'return', source: 'commerce_return' },
                            () => loadOrder(db, id, (e3, fresh) => res.json({ success: true, passed, order: fresh }))
                        );
                    }
                );
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/replacement-order',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadOrder(db, id, (e2, order) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!order || !order.returnStatus) return res.status(404).json({ error: 'No return or replacement is open on this order.' });
                if (order.replacementOrderId) return res.status(409).json({ error: 'A replacement order already exists for this order.' });
                if (order.returnStatus !== 'received' && order.returnStatus !== 'replacement_preparing') {
                    return res.status(409).json({ error: 'Receive and verify the returned item first.' });
                }
                const orderCode = 'BK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
                db.run(
                    `INSERT INTO book_orders (
                        order_code, user_id, seminar_id, status, payment_mode, total_amount, fulfillment_type,
                        buyer_name, buyer_phone, shipping_recipient_name, shipping_phone,
                        delivery_address, shipping_city, shipping_state, shipping_pincode,
                        commerce_provider, commerce_mode, commerce_stage, tracking_token, drop_lat, drop_lng, notes, replacement_of_order_id, updated_at
                     )
                     SELECT ?, user_id, seminar_id, 'confirmed', 'replacement', 0, fulfillment_type,
                        buyer_name, buyer_phone, shipping_recipient_name, shipping_phone,
                        delivery_address, shipping_city, shipping_state, shipping_pincode,
                        commerce_provider, commerce_mode, 'placed', ?, drop_lat, drop_lng, ?, id, CURRENT_TIMESTAMP
                     FROM book_orders WHERE id = ?`,
                    [orderCode, commerce.generateToken(), 'Replacement for order ' + order.orderCode, id],
                    function (insErr) {
                        if (insErr) return res.status(500).json({ error: insErr.message });
                        const finish = (newId) => {
                            db.run(
                                `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total)
                                 SELECT ?, book_id, language, qty, 0, 0 FROM book_order_items WHERE book_order_id = ?`,
                                [newId, id],
                                () => {
                                    db.run(
                                        `UPDATE book_orders SET replacement_order_id = ?, return_kind = 'replacement', return_status = 'replacement_preparing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                        [newId, id],
                                        () => {
                                            logEvent(db, newId, 'placed', 'Replacement order created', 'Replaces order ' + order.orderCode, { kind: 'placed' }, () => {
                                                logEvent(
                                                    db,
                                                    id,
                                                    'return_status',
                                                    'Replacement being prepared · order ' + orderCode,
                                                    'replacement_preparing',
                                                    { kind: 'return', source: 'commerce_return' },
                                                    () => loadOrder(db, id, (e3, fresh) => loadOrder(db, newId, (e4, created) => res.json({ success: true, order: fresh, replacement: created })))
                                                );
                                            });
                                        }
                                    );
                                }
                            );
                        };
                        if (this && this.lastID) return finish(this.lastID);
                        db.get(`SELECT id FROM book_orders WHERE order_code = ?`, [orderCode], (gErr, row) => {
                            if (gErr || !row) return res.status(500).json({ error: 'Replacement order was not created.' });
                            finish(row.id);
                        });
                    }
                );
            });
        })
    );

    app.get(
        '/api/admin/commerce/orders/:id/invoice',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                loadOrder(db, id, (e2, order0) => {
                    if (e2 || !order0) return res.status(404).send('Order not found');
                    const docsMod = require('./book-documents');
                    docsMod.enrichForDocs(db, order0, (order) => {
                    const html = String(req.query.doc || '') === 'receipt' ? docsMod.receiptHtml(order, cfg) : docsMod.invoiceHtml(order, cfg);
                    if (String(req.query.format || '').toLowerCase() !== 'pdf') {
                        res.setHeader('Content-Type', 'text/html; charset=utf-8');
                        return res.send(html);
                    }
                    pdfServer
                        .htmlToPdfBuffer(html, { landscape: false })
                        .then((buf) => {
                            res.setHeader('Content-Type', 'application/pdf');
                            res.setHeader('Content-Disposition', 'attachment; filename="invoice-' + String(order.orderCode).replace(/[^A-Za-z0-9_-]/g, '') + '.pdf"');
                            res.send(buf);
                        })
                        .catch((e3) => res.status(500).json({ error: e3.message }));
                    });
                });
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/documents',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const docs = Array.isArray(req.body && req.body.docs) ? req.body.docs.map(String) : ['invoice'];
            const to = ['buyer', 'store', 'both'].includes(req.body && req.body.to) ? req.body.to : 'buyer';
            loadOrder(db, id, (e2, order) => {
                if (e2 || !order) return res.status(404).json({ error: 'Order not found' });
                require('./book-documents').sendDocuments(db, order, docs, to, (e3, out) => {
                    if (e3) return res.status(409).json({ error: e3.message });
                    logEvent(db, order.id, 'documents_sent', 'Documents emailed: ' + out.documents.join(', '), 'To ' + out.sent.join(', '), { kind: 'documents', city: '' }, () => res.json(Object.assign({ success: true }, out)));
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
                        const printed = order.commerceProvider === 'fleetbase' && networkAwb ? networkAwb : awb || order.courierTrackingNo || order.commerceAwb || '';
                        if (!printed) {
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            return res.status(409).send(commerce.labelWaitingHtml(order));
                        }
                        sendLabel(req, res, cfg, 'label-' + order.orderCode, (opts, cfg2) => commerce.labelHtml(Object.assign({}, order, { courierTrackingNo: printed }, opts), cfg2));
                    };
                    commerce
                        .fetchProviderSnapshot(cfg, order)
                        .then((update) => {
                            const awb = commerce.awbFromUpdate(update) || networkAwb;
                            if (!update) return sendPrinted(awb);
                            if (update.hubs && update.hubs.length) order.hubs = update.hubs;
                            if (update.parcelInfo) order.parcelInfo = update.parcelInfo;
                            if (update.pickupAt) order.pickupAt = update.pickupAt;
                            if (update.deliveryAt) order.deliveryAt = update.deliveryAt;
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
                        ensureReturnToken(db, id, () =>
                            logEvent(
                                db,
                                id,
                                'return_status',
                                RETURN_TITLES[status] || (kind === 'replacement' ? 'Replacement requested' : 'Return status updated'),
                                status || kind || 'updated',
                                { kind: 'return', source: 'commerce_return' },
                                () => loadOrder(db, id, (e2, fresh) => res.json({ success: true, order: fresh }))
                            )
                        );
                    }
                );
            });
        })
    );

    app.post(
        '/api/admin/commerce/orders/:id/return-shipment',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            loadOrder(db, id, (err, order) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                createReturnShipment(
                    db,
                    order,
                    {
                        provider: req.body && req.body.provider,
                        trackingNo: req.body && req.body.trackingNo,
                        reason: req.body && req.body.reason
                    },
                    (e2, fresh) => {
                        if (e2) return res.status(500).json({ error: e2.message });
                        res.json({ success: true, order: fresh });
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
                    ensureReturnToken(db, id, () => {});
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

    const ISSUE_TYPES = {
        non_receipt: 'Parcel marked delivered but not received',
        damaged: 'Damaged item',
        incomplete: 'Incomplete order / missing items',
        wrong_item: 'Wrong item received',
        other: 'Delivery problem'
    };

    
    app.post('/api/public/commerce/appointment', (req, res) => {
        const b = req.body || {};
        const token = String(b.token || '').trim();
        const date = String(b.date || '').trim();
        const start = String(b.start || '').trim();
        const end = String(b.end || '').trim();
        const recipient = String(b.recipient || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const instructions = String(b.instructions || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
            return res.status(400).json({ error: 'Choose a date and a time window.' });
        }
        if (Date.parse(date + 'T' + start + ':00+05:30') < Date.now() - 60000) return res.status(400).json({ error: 'That window is in the past.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id FROM book_orders WHERE tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadOrder(db, row.id, (e2, order) => {
                    if (e2 || !order) return res.status(500).json({ error: 'Could not load the order.' });
                    if (['delivered', 'cancelled'].includes(String(order.commerceStage || ''))) return res.status(400).json({ error: 'This shipment is already closed.' });
                    const list = (order.appointments || []).slice();
                    if (list.some((a) => a.status === 'pending')) return res.status(400).json({ error: 'A request is already pending — we will confirm it shortly.' });
                    const entry = { id: 'APT-' + Date.now().toString(36).toUpperCase(), requestedAt: new Date().toISOString(), date, start, end, recipient, instructions, status: 'pending', by: 'customer' };
                    list.push(entry);
                    const startMs = Date.parse(date + 'T' + start + ':00+05:30');
                    const push =
                        order.commerceProvider === 'shipday' && order.shipdayOrderId
                            ? commerce.rescheduleShipdayDelivery(cfg, order.shipdayOrderId, startMs)
                            : order.commerceProvider === 'fleetbase' && order.fleetbaseOrderId
                              ? commerce.rescheduleFleetbaseDelivery(cfg, order.fleetbaseOrderId, startMs)
                              : order.commerceProvider === 'tookan' && (order.tookanDeliveryJobId || order.tookanJobId)
                                ? commerce.rescheduleTookanDelivery(cfg, order.tookanDeliveryJobId || order.tookanJobId, startMs)
                                : null;
                    const done = () =>
                        saveAppointments(db, order.id, list, () =>
                            logEvent(
                                db, order.id, 'appointment_' + entry.status,
                                (entry.status === 'carrier_confirmed' ? 'Delivery appointment confirmed by courier · ' : 'Delivery appointment requested · ') + date + ' ' + start + '–' + end,
                                recipient ? 'Authorised recipient: ' + recipient : '',
                                { kind: 'appointment', source: entry.status === 'carrier_confirmed' ? order.commerceProvider : 'customer' },
                                () => res.json({ success: true, appointment: entry })
                            )
                        );
                    if (!push) return done();
                    push.then(() => {
                        entry.status = 'carrier_confirmed';
                        entry.decidedAt = new Date().toISOString();
                        db.run(
                            `UPDATE book_orders SET rescheduled_at = ?, rescheduled_for_start = ?, rescheduled_for_end = ?, delivery_note = COALESCE(NULLIF(?, ''), delivery_note) WHERE id = ?`,
                            [entry.decidedAt, date + 'T' + start + ':00+05:30', date + 'T' + end + ':00+05:30', [recipient ? 'Recipient: ' + recipient : '', instructions].filter(Boolean).join(' · '), order.id],
                            () => done()
                        );
                    }).catch(() => { entry.courierError = true; done(); });
                });
            });
        });
    });

    app.post('/api/public/commerce/notify-prefs', (req, res) => {
        const token = String((req.body && req.body.token) || '').trim();
        const mute = !!(req.body && req.body.muteRoutine);
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        db.run(`UPDATE book_orders SET notify_prefs_json = ? WHERE tracking_token = ?`, [JSON.stringify({ muteRoutine: mute }), token], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (!this.changes) return res.status(404).json({ error: 'Shipment not found.' });
            res.json({ success: true, muteRoutine: mute });
        });
    });

    app.post(
        '/api/admin/commerce/orders/:id/appointment',
        guard({ orders: true }, (req, res) => {
            const id = parseInt(req.params.id, 10);
            const aptId = String((req.body && req.body.appointmentId) || '');
            const decision = String((req.body && req.body.decision) || '').toLowerCase();
            const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
            if (!['accepted', 'rejected', 'carrier_confirmed'].includes(decision)) return res.status(400).json({ error: 'Decision must be accepted, rejected or carrier_confirmed' });
            loadOrder(db, id, (err, order) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!order) return res.status(404).json({ error: 'Order not found' });
                const list = (order.appointments || []).slice();
                const apt = list.find((a) => a.id === aptId) || list.filter((a) => a.status === 'pending').pop();
                if (!apt) return res.status(404).json({ error: 'No pending appointment' });
                apt.status = decision;
                apt.decidedAt = new Date().toISOString();
                apt.note = note;
                const accepted = decision !== 'rejected';
                const finish = () =>
                    saveAppointments(db, id, list, () =>
                        logEvent(
                            db, id, 'appointment_' + decision,
                            accepted ? (decision === 'carrier_confirmed' ? 'Delivery appointment confirmed by courier · ' : 'Delivery appointment accepted · ') + apt.date + ' ' + apt.start + '–' + apt.end : 'Delivery appointment could not be accepted' + (note ? ' — ' + note : ''),
                            apt.recipient ? 'Authorised recipient: ' + apt.recipient : '',
                            { kind: 'appointment', source: decision === 'carrier_confirmed' ? order.commerceProvider || 'courier' : 'commerce' },
                            () => {
                                notifyMaterial(order, 'appointment', 'Delivery appointment ' + (accepted ? 'confirmed' : 'not available') + ' — order ' + order.orderCode,
                                    accepted ? 'Your delivery is scheduled for ' + apt.date + ' between ' + apt.start + ' and ' + apt.end + '.' : 'We could not arrange ' + apt.date + ' ' + apt.start + '–' + apt.end + (note ? ': ' + note : '') + '. Please request another window from your tracking page.');
                                loadOrder(db, id, (e3, fresh) => res.json({ success: true, order: fresh }));
                            }
                        )
                    );
                if (!accepted) return finish();
                db.run(
                    `UPDATE book_orders SET rescheduled_at = ?, rescheduled_for_start = ?, rescheduled_for_end = ?, delivery_note = COALESCE(NULLIF(?, ''), delivery_note), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [new Date().toISOString(), apt.date + 'T' + apt.start + ':00+05:30', apt.date + 'T' + apt.end + ':00+05:30', [apt.recipient ? 'Recipient: ' + apt.recipient : '', apt.instructions].filter(Boolean).join(' · '), id],
                    () => finish()
                );
            });
        })
    );

    app.post('/api/public/commerce/issue', (req, res) => {
        const token = String((req.body && req.body.token) || '').trim();
        const type = String((req.body && req.body.type) || '').trim();
        const description = String((req.body && req.body.description) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        const items = String((req.body && req.body.items) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const qty = parseInt(req.body && req.body.quantity, 10);
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        if (!ISSUE_TYPES[type]) return res.status(400).json({ error: 'Choose what went wrong.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id, order_code FROM book_orders WHERE tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                const ref = 'CASE-' + String(row.order_code || row.id).slice(-6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
                const detail = [items ? 'Items: ' + items : '', Number.isFinite(qty) && qty > 0 ? 'Qty: ' + qty : '', description].filter(Boolean).join(' \u00b7 ');
                logEvent(db, row.id, 'issue_' + type, ISSUE_TYPES[type] + ' reported \u00b7 Ref ' + ref, detail, { kind: 'issue', source: 'customer' }, () =>
                    res.json({ success: true, reference: ref })
                );
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

    function scanNext(order) {
        const status = String(order.status || '');
        const stage = String(order.commerceStage || 'placed');
        if (status === 'cancelled' || stage === 'cancelled') return { error: 'This order was cancelled.', status: 409 };
        if (status === 'pending_payment') return { error: 'This order is not confirmed yet.', status: 409 };
        if (status === 'delivered' || status === 'fulfilled' || stage === 'delivered') return { next: null, label: 'Already delivered' };
        if (stage === 'in_transit' || stage === 'out_for_delivery') return { next: 'deliver', label: 'Mark delivered' };
        return { next: 'pickup', label: 'Mark picked up from the store' };
    }

    function scanLookupValue(source) {
        const body = source || {};
        const token = String(body.token || '').trim();
        const code = String(body.code || body.order || body.orderCode || body.id || body.scan || '').trim();
        return token || code;
    }

    function findShipmentForScan(db, raw, cb) {
        const value = String(raw || '').trim();
        if (value.length < 4) return cb(null, null);
        const queries = [];
        if (value.length >= 8) queries.push([`SELECT id FROM book_orders WHERE tracking_token = ?`, [value]]);
        queries.push([`SELECT id FROM book_orders WHERE order_code = ?`, [value]]);
        queries.push([`SELECT id FROM book_orders WHERE UPPER(order_code) = UPPER(?)`, [value]]);
        queries.push([`SELECT id FROM book_orders WHERE courier_tracking_no = ?`, [value]]);
        queries.push([`SELECT id FROM book_orders WHERE commerce_awb = ?`, [value]]);
        const next = (i) => {
            if (i >= queries.length) return cb(null, null);
            db.get(queries[i][0], queries[i][1], (err, row) => {
                if (err) return cb(err);
                if (row) return cb(null, row);
                next(i + 1);
            });
        };
        next(0);
    }

    app.get('/api/public/commerce/shipment-scan', (req, res) => {
        const raw = scanLookupValue(req.query);
        if (!raw || raw.length < 4) return res.status(400).json({ error: 'Scan code is incomplete.' });
        res.set('Cache-Control', 'no-store');
        ensureCommerceSchema(db, () => {
            findShipmentForScan(db, raw, (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadOrder(db, row.id, (e2, order) => {
                    if (e2 || !order) return res.status(404).json({ error: 'Shipment not found.' });
                    const step = scanNext(order);
                    if (step.error) return res.status(step.status).json({ error: step.error });
                    res.json({ success: true, orderCode: order.orderCode || '', trackingId: order.courierTrackingNo || order.commerceAwb || '', next: step.next, label: step.label });
                });
            });
        });
    });

    app.post('/api/public/commerce/shipment-scan', (req, res) => {
        const raw = scanLookupValue(req.body);
        if (!raw || raw.length < 4) return res.status(400).json({ error: 'Scan code is incomplete.' });
        ensureCommerceSchema(db, () => {
            findShipmentForScan(db, raw, (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Shipment not found.' });
                loadOrder(db, row.id, (e2, order) => {
                    if (e2 || !order) return res.status(404).json({ error: 'Shipment not found.' });
                    const step = scanNext(order);
                    if (step.error) return res.status(step.status).json({ error: step.error });
                    if (!step.next) return res.json({ success: true, marked: null, message: 'This shipment is already delivered.' });
                    const deliver = step.next === 'deliver';
                    const sql = deliver
                        ? `UPDATE book_orders SET commerce_stage = 'delivered', live_leg = 'none', status = 'delivered', courier_track_status = 'delivered', courier_delivered_at = COALESCE(courier_delivered_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
                        : `UPDATE book_orders SET commerce_stage = 'in_transit', live_leg = 'to_drop', courier_track_status = 'in_transit', courier_shipment_status = 'shipped', courier_dispatched_at = COALESCE(courier_dispatched_at, CURRENT_TIMESTAMP), status = CASE WHEN status IN ('cancelled', 'delivered') THEN status ELSE 'shipped' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
                    db.run(sql, [order.id], (uerr) => {
                        if (uerr) return res.status(500).json({ error: uerr.message });
                        const kind = deliver ? 'delivered' : 'picked_up';
                        const title = deliver ? 'Delivered' : 'Picked up from the store';
                        const detail = deliver ? 'Shipment QR scanned at the door' : 'Shipment QR scanned at the store';
                        logEventOnce(db, order.id, kind, title, detail, { kind, source: 'commerce', at: new Date().toISOString() }, () => {
                            db.run(
                                `INSERT INTO commerce_scans (order_id, kind, barcode, leg) VALUES (?, ?, ?, 'forward')`,
                                [order.id, kind, order.orderCode || raw],
                                () => {
                                    publishTrackingUpdate(order, {
                                        kind,
                                        title,
                                        stage: deliver ? 'delivered' : 'in_transit',
                                        liveLeg: deliver ? 'none' : 'to_drop',
                                        phase: deliver ? 'Delivered' : 'On the way to you',
                                        provider: order.commerceProvider || ''
                                    });
                                    res.json({ success: true, marked: step.next, message: deliver ? 'Marked delivered on the customer order.' : 'Marked picked up on the customer order.' });
                                }
                            );
                        });
                    });
                });
            });
        });
    });

    app.get('/api/public/commerce/rider-live', (req, res) => {
        const token = String(req.query.token || '').trim();
        res.set('Cache-Control', 'no-store');
        sampleRider(db, token, (err, sample) => {
            if (err) return res.status(500).json({ error: 'Could not read the rider location.' });
            if (!sample) return res.status(404).json({ error: 'Shipment not found.' });
            res.json({ type: 'rider', leg: sample.leg || null, agent: sample.agent || null });
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
                                    view.live = track.map.enabled ? shopTimeline.buildLiveView(subject, timeline, cfg.mapsApiKey, {}) : null;
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
                                    journey.buildJourney(subject, cfg).catch(() => null).then((jr) => {
                                        view.journey = jr;
                                        commerce.applyTraffic(cfg, view).then(() => res.json({ success: true, shipment: view }));
                                    });
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

    app.get('/api/public/commerce/track-return', (req, res) => {
        const token = String(req.query.token || '').trim();
        if (!token || token.length < 8) return res.status(400).json({ error: 'Tracking link is incomplete.' });
        ensureCommerceSchema(db, () => {
            db.get(`SELECT id FROM book_orders WHERE return_tracking_token = ?`, [token], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Return shipment not found.' });
                loadConfig(db, (cErr, raw, cfg) => {
                    if (cErr) return res.status(500).json({ error: cErr.message });
                    loadOrder(db, row.id, (e2, order) => {
                        if (e2 || !order || !order.returnStatus) return res.status(404).json({ error: 'Return shipment not found.' });
                        refreshReturn(db, cfg, order, (e3, fresh) => {
                            const subject = fresh || order;
                            loadReturnEvents(db, row.id, (e4, events) => loadLinkedTracks(db, cfg, subject, (e5, linked) => {
                                const track = shipmentEngine.buildReturnTracking(subject, events, { shop: cfg.shop });
                                journey.buildJourney(subject, cfg, { returnLeg: true }).catch(() => null).then((jr) =>
                                    res.json({ success: true, shipment: { linked, orderCode: subject.orderCode, kind: subject.returnKind || 'return', returnStatus: subject.returnStatus, track, journey: jr } })
                                );
                            }));
                        });
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

function publishTrackingUpdate(order, update) {
    try {
        const token = String((order && order.trackingToken) || '').trim();
        if (token.length < 8) return;
        const source = update || {};
        const provider = source.provider || (order && order.commerceProvider) || '';
        const otpRaw = provider === 'shipday' ? '' : source.deliveryOtp || (order && order.deliveryOtp) || '';
        const otp = String(otpRaw).replace(/\s+/g, '');
        const km = shipmentEngine.distanceKm(source.agentLat != null ? source.agentLat : order && order.agentLat, source.agentLng != null ? source.agentLng : order && order.agentLng, order && order.dropLat, order && order.dropLng);
        require('./rider-live-socket').publishTrack(token, {
            type: 'track',
            source: 'webhook',
            provider,
            kind: source.kind || '',
            title: source.title || '',
            stage: source.stage || (order && order.commerceStage) || '',
            leg: source.liveLeg || (order && order.liveLeg) || '',
            phase: source.phase || source.title || shipmentEngine.phaseNow(Object.assign({}, order, {
                liveLeg: source.liveLeg || (order && order.liveLeg),
                agentName: source.agentName || (order && order.agentName)
            }), { km: Number.isFinite(km) ? km : null }),
            partner: source.agentName || (order && order.agentName) || '',
            phone: source.agentPhone || (order && order.agentPhone) || '',
            deliveryOtp: /^\d{4,8}$/.test(otp) ? otp : '',
            distance: shipmentEngine.awayText(km),
            at: new Date().toISOString()
        });
    } catch (e) {}
}

function commerceNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Courier snapshot for the tracking socket. Reads the row webhooks already saved. */
function sampleTrack(db, token, cb) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 8 || clean.length > 200) return cb(null, null);
    ensureCommerceSchema(db, () => {
        db.get(
            `SELECT order_code, status, commerce_stage, commerce_provider, live_leg, agent_name, agent_phone,
                    delivery_otp, agent_lat, agent_lng, drop_lat, drop_lng, payment_mode, payment_status, courier_track_label
             FROM book_orders WHERE tracking_token = ?`,
            [clean],
            (err, row) => {
                if (err) return cb(err);
                if (!row) return cb(null, null);
                const km = shipmentEngine.distanceKm(row.agent_lat, row.agent_lng, row.drop_lat, row.drop_lng);
                const otp = row.commerce_provider === 'shipday' ? '' : String(row.delivery_otp || '').replace(/\s+/g, '');
                const rank = { placed: 0, accepted: 1, preparing: 1, ready: 2, pickup_scheduled: 2, in_transit: 3, out_for_delivery: 4, delivered: 5 }[String(row.commerce_stage || '')];
                const order = {
                    status: row.status,
                    commerceStage: row.commerce_stage,
                    commerceProvider: row.commerce_provider,
                    liveLeg: row.live_leg,
                    agentName: row.agent_name,
                    agentPhone: row.agent_phone
                };
                cb(null, {
                    type: 'track',
                    source: 'poll',
                    orderCode: row.order_code || '',
                    stage: row.commerce_stage || '',
                    leg: row.live_leg || '',
                    phase: shipmentEngine.phaseNow(order, { rank: rank == null ? 0 : rank, km: Number.isFinite(km) ? km : null }),
                    partner: row.agent_name || '',
                    phone: row.agent_phone || '',
                    deliveryOtp: /^\d{4,8}$/.test(otp) ? otp : '',
                    distance: shipmentEngine.awayText(km),
                    pay: shipmentEngine.trackingCards({ paymentMode: row.payment_mode, paymentStatus: row.payment_status, fulfillmentType: 'courier', commerceMode: 'logistics' }, {}).filter((c) => c.key === 'pay').map((c) => c.value)[0] || '',
                    at: new Date().toISOString()
                });
            }
        );
    });
}

/** Latest rider fix for a public tracking token. Used by the live websocket. */
function sampleRider(db, token, cb) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 8 || clean.length > 200) return cb(null, null);
    ensureCommerceSchema(db, () => {
        db.get(`SELECT id FROM book_orders WHERE tracking_token = ?`, [clean], (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            loadConfig(db, (cErr, raw, cfg) => {
                if (cErr) return cb(cErr);
                loadOrder(db, row.id, (e2, order) => {
                    if (e2 || !order) return cb(e2 || null, null);
                    const finish = (fresh) => {
                        const subject = fresh || order;
                        loadEvents(db, row.id, (e3, events) => {
                            if (e3) return cb(e3);
                            try {
                                const timeline = shopTimeline.buildShopTimeline(subject, events || [], { shop: cfg.shop });
                                const track = shipmentEngine.buildCustomerTracking(subject, events || [], { shop: cfg.shop });
                                const mapOn = !!(track && track.map && track.map.enabled);
                                const live = mapOn ? shopTimeline.buildLiveView(subject, timeline, cfg.mapsApiKey) : null;
                                const agent = live && live.agent ? { lat: Number(live.agent.lat), lng: Number(live.agent.lng) } : null;
                                cb(null, {
                                    orderId: row.id,
                                    leg: (live && live.leg) || 'preview',
                                    agent: agent && Number.isFinite(agent.lat) && Number.isFinite(agent.lng) ? agent : null
                                });
                            } catch (ex) {
                                cb(ex);
                            }
                        });
                    };
                    if (order.tookanJobId || order.shipdayOrderId || order.pidgeOrderId || order.fleetbaseOrderId) {
                        return refreshLive(db, cfg, order, (e4, fresh) => finish(e4 ? order : fresh || order));
                    }
                    finish(order);
                });
            });
        });
    });
}

module.exports = {
    loadLinkedTracks,
    registerCommerceRoutes,
    ensureCommerceSchema,
    stampPlacement,
    loadConfig,
    refreshLive,
    sampleRider,
    sampleTrack
};

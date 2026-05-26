/**
 * Dr. R.B. Gogate book sales — Agnikarma & Viddhakarma (multi-language), doctor portal + scanner fulfillment.
 */
const adminPaymentFlow = require('./admin-payment-flow');
const paymentGatewayOptions = require('./payment-gateway-options');
const { safeInternalUserRowId } = require('./internal-user-id');
const seminarDt = require('./seminar-datetime');
const bookCourier = require('./book-courier-tracking');
const {
    COURIER_PROVIDERS,
    courierProviderLabel,
    courierTrackingUrl,
    buildDeliveryAddressLine
} = bookCourier;
const { fetchLiveCourierTracking, TRACK_STATUS, TRACK_STATUS_LABELS } = require('./book-courier-tracker');

const CONFIG_KEY = 'book_sales_config';

/** Fixed book IDs kept for backward compat; custom books use arbitrary IDs. */
const BUILTIN_BOOK_IDS = ['agnikarma', 'viddhakarma'];

const LANGUAGE_DEFS = [
    { id: 'english', label: 'English' },
    { id: 'marathi', label: 'Marathi' },
    { id: 'hindi', label: 'Hindi' },
    { id: 'kannada', label: 'Kannada' }
];

const DEFAULT_CONFIG = {
    enabled: false,
    seminarId: null,
    orderStart: null,
    orderEnd: null,
    onlinePaymentEnabled: true,
    payAtCounterEnabled: true,
    courierEnabled: true,
    defaultCourierCharge: 60,
    books: [
        {
            id: 'agnikarma',
            title: 'Agnikarma',
            author: 'Dr. R.B. Gogate',
            price: 0,
            active: true
        },
        {
            id: 'viddhakarma',
            title: 'Viddhakarma',
            author: 'Dr. R.B. Gogate',
            price: 0,
            active: true
        }
    ]
};

function genBookOrderString() {
    return 'BK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

function normalizeConfig(raw) {
    const c = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
    c.enabled = !!(c.enabled === true || c.enabled === 1 || c.enabled === '1');
    c.onlinePaymentEnabled = c.onlinePaymentEnabled !== false && c.onlinePaymentEnabled !== 0;
    c.payAtCounterEnabled = c.payAtCounterEnabled !== false && c.payAtCounterEnabled !== 0;
    c.courierEnabled = c.courierEnabled !== false && c.courierEnabled !== 0;
    c.defaultCourierCharge = Math.max(0, Number(c.defaultCourierCharge) || 60);
    const sid = c.seminarId != null && c.seminarId !== '' ? parseInt(c.seminarId, 10) : null;
    c.seminarId = Number.isInteger(sid) && sid > 0 ? sid : null;
    const books = Array.isArray(c.books) ? c.books : DEFAULT_CONFIG.books;
    c.books = books
        .map((b) => ({
            id: String((b && b.id) || '').trim().toLowerCase().replace(/\s+/g, '_'),
            title: String((b && b.title) || '').trim(),
            author: String((b && b.author) || 'Dr. R.B. Gogate').trim(),
            price: Math.max(0, Number(b && b.price) || 0),
            active: b && b.active === false ? false : true
        }))
        // allow any book ID (custom books not just built-ins)
        .filter((b) => b.id && b.title);
    if (!c.books.length) c.books = DEFAULT_CONFIG.books.slice();
    c.orderStart = c.orderStart ? seminarDt.normalizeSeminarDateTimeForStorage(c.orderStart) : null;
    c.orderEnd = c.orderEnd ? seminarDt.normalizeSeminarRegistrationEndForStorage(c.orderEnd) : null;
    if (c.orderStart && c.orderEnd) {
        const sMs = seminarDt.parseSeminarMs(c.orderStart);
        const eMs = seminarDt.parseSeminarMs(c.orderEnd);
        if (sMs != null && eMs != null && sMs > eMs) {
            c.orderEnd = c.orderStart;
        }
    }
    return c;
}

/** Whether doctors may place new book orders right now (IST). */
function evaluateBookOrderWindow(config, nowMs) {
    const startMs = config.orderStart ? seminarDt.parseSeminarMs(config.orderStart) : null;
    const endMs = config.orderEnd ? seminarDt.parseSeminarMs(config.orderEnd) : null;
    const now = nowMs != null ? nowMs : Date.now();
    if (!startMs && !endMs) {
        return { open: true, phase: 'open', orderStart: config.orderStart || null, orderEnd: config.orderEnd || null };
    }
    if (startMs && now < startMs) {
        return {
            open: false,
            phase: 'before',
            orderStart: config.orderStart,
            orderEnd: config.orderEnd,
            message: 'Book ordering opens on ' + seminarDt.formatSeminarDateTime(config.orderStart) + ' (IST).'
        };
    }
    if (endMs && now > endMs) {
        return {
            open: false,
            phase: 'after',
            orderStart: config.orderStart,
            orderEnd: config.orderEnd,
            message: 'Book ordering closed on ' + seminarDt.formatSeminarDateTime(config.orderEnd) + ' (IST).'
        };
    }
    let message = 'Book ordering is open';
    if (config.orderEnd) {
        message += ' until ' + seminarDt.formatSeminarDateTime(config.orderEnd) + ' (IST)';
    }
    message += '.';
    return { open: true, phase: 'open', orderStart: config.orderStart, orderEnd: config.orderEnd, message };
}

function publicBookSalesPayload(config) {
    const window = evaluateBookOrderWindow(config);
    return {
        enabled: config.enabled,
        orderingOpen: !!(config.enabled && window.open),
        orderWindow: window,
        orderStart: config.orderStart || null,
        orderEnd: config.orderEnd || null,
        languages: LANGUAGE_DEFS,
        books: config.enabled
            ? config.books.filter((b) => b.active !== false).map((b) => ({
                  id: b.id,
                  title: b.title,
                  author: b.author,
                  price: b.price
              }))
            : [],
        onlinePaymentEnabled: config.onlinePaymentEnabled,
        payAtCounterEnabled: config.payAtCounterEnabled,
        seminarId: config.seminarId
    };
}

function loadBookSalesConfig(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [CONFIG_KEY], (err, row) => {
        if (err) return cb(err);
        let parsed = {};
        if (row && row.value) {
            try {
                parsed = JSON.parse(row.value) || {};
            } catch (_) {
                parsed = {};
            }
        }
        cb(null, normalizeConfig(parsed));
    });
}

function saveBookSalesConfig(db, config, upsertGlobalSetting, cb) {
    const payload = JSON.stringify(normalizeConfig(config));
    if (typeof upsertGlobalSetting === 'function') {
        return upsertGlobalSetting(CONFIG_KEY, payload, cb);
    }
    db.run(`UPDATE global_settings SET value = ? WHERE key = ?`, [payload, CONFIG_KEY], function (uerr) {
        if (uerr) return cb && cb(uerr);
        if (this.changes > 0) return cb && cb(null);
        db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?)`, [CONFIG_KEY, payload], (ierr) => cb && cb(ierr));
    });
}

function ensureBookSalesSchema(db, cb) {
    const isPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    const ordersSql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_orders (
            id SERIAL PRIMARY KEY,
            order_code TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            status TEXT NOT NULL DEFAULT 'awaiting_confirmation',
            payment_mode TEXT NOT NULL DEFAULT 'counter',
            total_amount REAL NOT NULL DEFAULT 0,
            order_id INTEGER,
            qr_code_data TEXT,
            admin_confirmed_by INTEGER,
            admin_confirmed_at TIMESTAMPTZ,
            fulfilled_at TIMESTAMPTZ,
            fulfilled_by INTEGER,
            notes TEXT,
            buyer_name TEXT,
            buyer_phone TEXT,
            fulfillment_type TEXT DEFAULT 'pickup',
            courier_provider TEXT,
            courier_tracking_no TEXT,
            courier_charge REAL DEFAULT 0,
            courier_dispatched_at TIMESTAMPTZ,
            delivery_address TEXT,
            shipping_recipient_name TEXT,
            shipping_phone TEXT,
            shipping_pincode TEXT,
            shipping_city TEXT,
            shipping_state TEXT,
            courier_shipment_status TEXT,
            courier_details_saved_at TIMESTAMPTZ,
            courier_track_status TEXT,
            courier_track_label TEXT,
            courier_track_updated_at TIMESTAMPTZ,
            courier_delivered_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS book_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_code TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            seminar_id INTEGER,
            status TEXT NOT NULL DEFAULT 'awaiting_confirmation',
            payment_mode TEXT NOT NULL DEFAULT 'counter',
            total_amount REAL NOT NULL DEFAULT 0,
            order_id INTEGER,
            qr_code_data TEXT,
            admin_confirmed_by INTEGER,
            admin_confirmed_at TEXT,
            fulfilled_at TEXT,
            fulfilled_by INTEGER,
            notes TEXT,
            buyer_name TEXT,
            buyer_phone TEXT,
            fulfillment_type TEXT DEFAULT 'pickup',
            courier_provider TEXT,
            courier_tracking_no TEXT,
            courier_charge REAL DEFAULT 0,
            courier_dispatched_at TEXT,
            delivery_address TEXT,
            shipping_recipient_name TEXT,
            shipping_phone TEXT,
            shipping_pincode TEXT,
            shipping_city TEXT,
            shipping_state TEXT,
            courier_shipment_status TEXT,
            courier_details_saved_at TEXT,
            courier_track_status TEXT,
            courier_track_label TEXT,
            courier_track_updated_at TEXT,
            courier_delivered_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;
    const itemsSql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_order_items (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            language TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL DEFAULT 0
        )`
        : `CREATE TABLE IF NOT EXISTS book_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order_id INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            language TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1,
            unit_price REAL NOT NULL DEFAULT 0,
            line_total REAL NOT NULL DEFAULT 0
        )`;
    const scansSql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_fulfillment_scans (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            scanner_user_id INTEGER,
            outcome TEXT NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS book_fulfillment_scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order_id INTEGER NOT NULL,
            scanner_user_id INTEGER,
            outcome TEXT NOT NULL,
            message TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;
    const eventsSql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_order_events (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            meta_json TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS book_order_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            meta_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;
    const ignore = (e) => {
        if (e && !/already exists|duplicate column/i.test(String(e.message))) {
            console.warn('[book-sales] schema:', e.message);
        }
    };
    const colAlters = isPg
        ? [
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS buyer_name TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS buyer_phone TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT DEFAULT \'pickup\'',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_provider TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_tracking_no TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_charge REAL DEFAULT 0',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_dispatched_at TIMESTAMPTZ',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS delivery_address TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_recipient_name TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_phone TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_pincode TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_city TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS shipping_state TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_shipment_status TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_details_saved_at TIMESTAMPTZ',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_status TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_label TEXT',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_track_updated_at TIMESTAMPTZ',
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS courier_delivered_at TIMESTAMPTZ'
          ]
        : [
            'ALTER TABLE book_orders ADD COLUMN buyer_name TEXT',
            'ALTER TABLE book_orders ADD COLUMN buyer_phone TEXT',
            'ALTER TABLE book_orders ADD COLUMN fulfillment_type TEXT DEFAULT \'pickup\'',
            'ALTER TABLE book_orders ADD COLUMN courier_provider TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_tracking_no TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_charge REAL DEFAULT 0',
            'ALTER TABLE book_orders ADD COLUMN courier_dispatched_at TEXT',
            'ALTER TABLE book_orders ADD COLUMN delivery_address TEXT',
            'ALTER TABLE book_orders ADD COLUMN shipping_recipient_name TEXT',
            'ALTER TABLE book_orders ADD COLUMN shipping_phone TEXT',
            'ALTER TABLE book_orders ADD COLUMN shipping_pincode TEXT',
            'ALTER TABLE book_orders ADD COLUMN shipping_city TEXT',
            'ALTER TABLE book_orders ADD COLUMN shipping_state TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_shipment_status TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_details_saved_at TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_track_status TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_track_label TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_track_updated_at TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_delivered_at TEXT'
          ];
    const trackEventsSql = isPg
        ? `CREATE TABLE IF NOT EXISTS book_courier_track_events (
            id SERIAL PRIMARY KEY,
            book_order_id INTEGER NOT NULL,
            event_at TIMESTAMPTZ,
            location TEXT,
            description TEXT NOT NULL,
            source TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS book_courier_track_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_order_id INTEGER NOT NULL,
            event_at TEXT,
            location TEXT,
            description TEXT NOT NULL,
            source TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;
    db.serialize(() => {
        db.run(ordersSql, (e1) => {
            if (e1) console.warn('[book-sales] schema orders', e1.message);
            db.run(itemsSql, (e2) => {
                if (e2) console.warn('[book-sales] schema items', e2.message);
                db.run(scansSql, (e3) => {
                    if (e3) console.warn('[book-sales] schema scans', e3.message);
                    db.run(eventsSql, (e4) => {
                        if (e4) console.warn('[book-sales] schema events', e4.message);
                        db.run(trackEventsSql, (e5) => {
                            if (e5) console.warn('[book-sales] schema courier track events', e5.message);
                        let i = 0;
                        const runAlter = () => {
                            if (i >= colAlters.length) {
                                return db.run(
                                    `UPDATE book_orders SET status = 'shipped',
                                     courier_track_status = COALESCE(courier_track_status, 'in_transit')
                                     WHERE fulfillment_type = 'courier' AND status = 'fulfilled'
                                     AND courier_shipment_status = 'shipped'
                                     AND (courier_track_status IS NULL OR courier_track_status != 'delivered')`,
                                    () => cb && cb()
                                );
                            }
                            db.run(colAlters[i++], (ae) => {
                                ignore(ae);
                                runAlter();
                            });
                        };
                        runAlter();
                        });
                    });
                });
            });
        });
    });
}

function bookById(config, bookId) {
    return (config.books || []).find((b) => b.id === bookId && b.active !== false);
}

function languageLabel(id) {
    const hit = LANGUAGE_DEFS.find((l) => l.id === id);
    return hit ? hit.label : id;
}

function validateLineItems(config, items) {
    const lines = [];
    let total = 0;
    if (!Array.isArray(items) || !items.length) {
        return { error: 'Add at least one book with quantity.' };
    }
    const validBookIds = new Set((config.books || []).map((b) => b.id));
    for (const raw of items) {
        const bookId = String((raw && raw.bookId) || '').trim().toLowerCase().replace(/\s+/g, '_');
        const lang = String((raw && raw.language) || '').trim().toLowerCase();
        const qty = parseInt(raw && raw.qty, 10);
        if (!validBookIds.has(bookId)) return { error: 'Invalid book: ' + bookId };
        if (!LANGUAGE_DEFS.some((l) => l.id === lang)) return { error: 'Invalid language: ' + lang };
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: 'Quantity must be 1–99 per line.' };
        const book = bookById(config, bookId);
        if (!book) return { error: bookId + ' is not available for sale.' };
        const unit = Number(book.price) || 0;
        if (unit <= 0) return { error: 'Book price not configured by admin yet (' + book.title + ').' };
        const lineTotal = Math.round(unit * qty * 100) / 100;
        total += lineTotal;
        lines.push({ bookId, language: lang, qty, unitPrice: unit, lineTotal, bookTitle: book.title });
    }
    return { lines, total: Math.round(total * 100) / 100 };
}

function buildBookQrPayload(order) {
    return JSON.stringify({
        type: 'book_order',
        bookOrderId: order.id,
        orderCode: order.order_code,
        userId: order.user_id
    });
}

function mapOrderRow(row, items) {
    if (!row) return null;
    return {
        id: row.id,
        orderCode: row.order_code,
        userId: row.user_id,
        seminarId: row.seminar_id,
        status: row.status,
        paymentMode: row.payment_mode,
        totalAmount: row.total_amount,
        orderId: row.order_id,
        qrCodeData: row.qr_code_data,
        paymentOrderString: row.payment_order_string || null,
        paymentStatus: row.payment_status || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        adminConfirmedAt: row.admin_confirmed_at,
        fulfilledAt: row.fulfilled_at,
        buyerName: row.buyer_name || null,
        buyerPhone: row.buyer_phone || null,
        fulfillmentType: row.fulfillment_type || 'pickup',
        courierProvider: row.courier_provider || null,
        courierTrackingNo: row.courier_tracking_no || null,
        courierCharge: Number(row.courier_charge) || 0,
        courierDispatchedAt: row.courier_dispatched_at || null,
        deliveryAddress: row.delivery_address || null,
        shippingRecipientName: row.shipping_recipient_name || null,
        shippingPhone: row.shipping_phone || null,
        shippingPincode: row.shipping_pincode || null,
        shippingCity: row.shipping_city || null,
        shippingState: row.shipping_state || null,
        courierShipmentStatus: row.courier_shipment_status || null,
        courierDetailsSavedAt: row.courier_details_saved_at || null,
        courierTrackStatus: row.courier_track_status || null,
        courierTrackLabel: row.courier_track_label || null,
        courierTrackUpdatedAt: row.courier_track_updated_at || null,
        courierDeliveredAt: row.courier_delivered_at || null,
        items: items || []
    };
}

function markBookOrderCourierDelivered(db, bookOrderId, adminId, cb) {
    db.run(
        `UPDATE book_orders SET status = 'delivered', courier_shipment_status = 'delivered',
         courier_track_status = 'delivered', courier_track_label = 'Delivered',
         courier_delivered_at = CURRENT_TIMESTAMP, fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP),
         fulfilled_by = COALESCE(fulfilled_by, ?), updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND fulfillment_type = 'courier' AND status IN ('shipped', 'fulfilled')`,
        [adminId || null, bookOrderId],
        function (err) {
            if (err) return cb(err);
            if (!this.changes) return cb(null, { error: 'Cannot mark delivered' });
            logBookOrderEvent(
                db,
                bookOrderId,
                'courier_delivered',
                'Delivered',
                'Package delivered to recipient.',
                { adminId: adminId || null },
                () => fetchBookOrderFull(db, bookOrderId, (e2, order) => cb(e2, { success: true, order }))
            );
        }
    );
}

function applyCourierTrackResult(db, bookOrderId, order, trackResult, cb) {
    if (!trackResult || !trackResult.ok) return cb(null, { skipped: true });
    const status = trackResult.delivered ? TRACK_STATUS.delivered : trackResult.status || TRACK_STATUS.in_transit;
    const label = trackResult.statusLabel || TRACK_STATUS_LABELS[status] || 'In transit';
    db.run(
        `UPDATE book_orders SET courier_track_status = ?, courier_track_label = ?, courier_track_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, label, bookOrderId],
        (uErr) => {
            if (uErr) return cb(uErr);
            const events = trackResult.events || [];
            function finishRefresh() {
                if (trackResult.delivered && order.status === 'shipped') {
                    return markBookOrderCourierDelivered(db, bookOrderId, null, (e2, r) =>
                        cb(e2, { success: true, track: trackResult, order: r && r.order, autoDelivered: true })
                    );
                }
                fetchBookOrderFull(db, bookOrderId, (e3, fresh) =>
                    cb(e3, { success: true, track: trackResult, order: fresh })
                );
            }
            if (!events.length) return finishRefresh();
            let left = events.length;
            events.forEach((ev) => {
                const desc = [ev.description, ev.location].filter(Boolean).join(' · ');
                db.run(
                    `INSERT INTO book_courier_track_events (book_order_id, event_at, location, description, source)
                     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
                       SELECT 1 FROM book_courier_track_events WHERE book_order_id = ? AND description = ? LIMIT 1
                     )`,
                    [
                        bookOrderId,
                        ev.at || null,
                        ev.location || null,
                        desc,
                        trackResult.source || 'poll',
                        bookOrderId,
                        desc
                    ],
                    () => {
                        left--;
                        if (!left) finishRefresh();
                    }
                );
            });
        }
    );
}

function refreshCourierTrackForOrder(db, bookOrderId, cb) {
    fetchBookOrderFull(db, bookOrderId, (err, order) => {
        if (err) return cb(err);
        if (!order || !order.courierTrackingNo) return cb(null, { skipped: true, reason: 'no_tracking' });
        fetchLiveCourierTracking(order.courierProvider, order.courierTrackingNo)
            .then((result) => applyCourierTrackResult(db, bookOrderId, order, result, cb))
            .catch((e) => cb(e));
    });
}

function loadCourierTrackEvents(db, bookOrderId, cb) {
    db.all(
        `SELECT event_at, location, description, source, created_at FROM book_courier_track_events WHERE book_order_id = ? ORDER BY COALESCE(event_at, created_at) DESC, id DESC LIMIT 40`,
        [bookOrderId],
        (err, rows) => {
            if (err) return cb(err);
            cb(
                null,
                (rows || []).map((r) => ({
                    at: r.event_at || r.created_at,
                    location: r.location,
                    description: r.description,
                    source: r.source
                }))
            );
        }
    );
}

function logBookOrderEvent(db, bookOrderId, eventType, title, description, meta, cb) {
    const metaJson = meta && typeof meta === 'object' ? JSON.stringify(meta) : meta || null;
    db.run(
        `INSERT INTO book_order_events (book_order_id, event_type, title, description, meta_json) VALUES (?, ?, ?, ?, ?)`,
        [bookOrderId, String(eventType || 'update'), String(title || 'Update'), description || null, metaJson],
        (err) => (cb ? cb(err) : undefined)
    );
}

function buildBookOrderTimeline(order) {
    const st = String(order.status || '');
    const online = order.paymentMode === 'online';
    const courier = order.fulfillmentType === 'courier';
    const trackUrl = courierTrackingUrl(order.courierProvider, order.courierTrackingNo);
    const shipSt = String(order.courierShipmentStatus || '');
    const mk = (title, desc, state, at, icon, extra) =>
        Object.assign({ title, desc, state, at: at || null, icon: icon || 'fa-circle' }, extra || {});

    const steps = [];
    steps.push(
        mk(
            'Order placed',
            'Book order ' + (order.orderCode || '') + ' received.',
            'completed',
            order.createdAt,
            'fa-shopping-cart'
        )
    );

    if (st === 'cancelled') {
        steps.push(mk('Order cancelled', 'This order was cancelled.', 'completed', order.updatedAt || order.createdAt, 'fa-ban'));
        return {
            steps,
            status: st,
            currentStepIndex: steps.length - 1,
            currentLabel: 'Cancelled',
            courierTrackingUrl: null
        };
    }

    if (online) {
        const payDone =
            st !== 'pending_payment' &&
            (st === 'confirmed' ||
                st === 'shipped' ||
                st === 'delivered' ||
                st === 'fulfilled' ||
                order.paymentStatus === 'success');
        if (st === 'pending_payment') {
            steps.push(mk('Payment pending', 'Complete online payment to confirm your order.', 'active', null, 'fa-credit-card'));
        } else {
            steps.push(
                mk(
                    'Payment received',
                    order.paymentOrderString
                        ? 'Payment ref: ' + order.paymentOrderString
                        : 'Online payment confirmed.',
                    'completed',
                    order.adminConfirmedAt || order.updatedAt,
                    'fa-credit-card'
                )
            );
        }
        if (!payDone && st === 'pending_payment') {
            steps.push(mk('Ready for pickup', 'Pickup QR after payment is confirmed.', 'upcoming', null, 'fa-qrcode'));
        }
    } else {
        if (st === 'awaiting_confirmation') {
            steps.push(
                mk('Pay at counter', 'Visit the book desk on seminar day to pay and confirm.', 'active', null, 'fa-money-bill-wave')
            );
        } else {
            steps.push(
                mk(
                    'Payment confirmed',
                    'Counter / desk payment received by staff.',
                    'completed',
                    order.adminConfirmedAt || order.updatedAt,
                    'fa-money-bill-wave'
                )
            );
        }
    }

    if (courier && shipSt === 'ready_to_ship' && st === 'confirmed') {
        steps.push(
            mk(
                'Courier delivery',
                'Shipping address saved. Books will ship by courier.',
                'active',
                order.courierDetailsSavedAt,
                'fa-truck'
            )
        );
        steps.push(mk('Awaiting dispatch', 'Staff will add AWB and confirm shipment.', 'upcoming', null, 'fa-box'));
    } else if (st === 'confirmed' && !courier) {
        steps.push(
            mk(
                'Ready for pickup',
                'Show your QR code at the seminar book desk.',
                'active',
                order.adminConfirmedAt,
                'fa-qrcode'
            )
        );
    } else if (st === 'awaiting_confirmation' || st === 'pending_payment') {
        steps.push(mk('Ready for pickup', 'Staff will issue your pickup QR after confirmation.', 'upcoming', null, 'fa-qrcode'));
    } else if (st === 'fulfilled' && !courier) {
        if (st !== 'awaiting_confirmation' && st !== 'pending_payment') {
            steps.push(
                mk('Ready for pickup', 'Pickup QR was issued.', 'completed', order.adminConfirmedAt, 'fa-qrcode')
            );
        }
        steps.push(
            mk(
                'Books collected',
                'Handed over at the seminar book desk.',
                'completed',
                order.fulfilledAt,
                'fa-book-open'
            )
        );
    } else if (courier) {
        steps.push(
            mk('Packed for shipping', 'Order confirmed and prepared for courier.', 'completed', order.adminConfirmedAt, 'fa-box')
        );
        if (order.courierDetailsSavedAt) {
            steps.push(
                mk(
                    'Shipping details confirmed',
                    order.deliveryAddress || 'Address on file.',
                    'completed',
                    order.courierDetailsSavedAt,
                    'fa-clipboard-check'
                )
            );
        }
        const prov = courierProviderLabel(order.courierProvider);
        const liveLabel = order.courierTrackLabel || TRACK_STATUS_LABELS[order.courierTrackStatus] || '';
        const isShipped =
            st === 'shipped' ||
            st === 'delivered' ||
            shipSt === 'shipped' ||
            (st === 'fulfilled' && order.courierTrackingNo);
        const isDelivered = st === 'delivered' || order.courierTrackStatus === TRACK_STATUS.delivered || shipSt === 'delivered';
        if (isShipped) {
            steps.push(
                mk(
                    'Shipped',
                    order.courierTrackingNo
                        ? prov + ' · AWB ' + order.courierTrackingNo + (liveLabel ? ' · ' + liveLabel : '')
                        : 'Dispatched via ' + prov,
                    'completed',
                    order.courierDispatchedAt,
                    'fa-truck',
                    { trackingUrl: trackUrl, trackingNo: order.courierTrackingNo }
                )
            );
        } else if (shipSt === 'ready_to_ship') {
            steps.push(mk('Awaiting dispatch', 'Staff will add AWB and confirm shipment.', 'active', null, 'fa-box'));
        }
        if (isShipped && !isDelivered) {
            steps.push(
                mk(
                    'In transit',
                    liveLabel || 'Shipment is on the way. Status updates automatically.',
                    'active',
                    order.courierTrackUpdatedAt || order.courierDispatchedAt,
                    'fa-shipping-fast',
                    { trackingUrl: trackUrl, trackingNo: order.courierTrackingNo }
                )
            );
            steps.push(
                mk(
                    'Delivered',
                    'Will show when the carrier confirms delivery.',
                    'upcoming',
                    null,
                    'fa-check-circle'
                )
            );
        } else if (isDelivered) {
            if (!isShipped) {
                steps.push(
                    mk(
                        'Shipped',
                        order.courierTrackingNo ? prov + ' · AWB ' + order.courierTrackingNo : 'Dispatched',
                        'completed',
                        order.courierDispatchedAt,
                        'fa-truck',
                        { trackingUrl: trackUrl }
                    )
                );
            }
            steps.push(
                mk(
                    'Delivered',
                    liveLabel || 'Package delivered to recipient.',
                    'completed',
                    order.courierDeliveredAt || order.fulfilledAt,
                    'fa-check-circle'
                )
            );
        }
    } else {
        steps.push(mk('Fulfillment', 'Awaiting pickup or shipping.', 'upcoming', null, 'fa-box'));
    }

    let currentStepIndex = steps.length - 1;
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].state === 'active') {
            currentStepIndex = i;
            break;
        }
        if (steps[i].state === 'completed') {
            currentStepIndex = i;
            break;
        }
    }
    const current = steps[currentStepIndex] || steps[steps.length - 1];
    return {
        steps,
        status: st,
        currentStepIndex,
        currentLabel: current ? current.title : st,
        courierTrackingUrl: trackUrl
    };
}

function enrichOrderWithTracking(db, order, cb) {
    if (!order) return cb(null, null);
    order.timeline = buildBookOrderTimeline(order);
    order.courierTrackingUrl = courierTrackingUrl(order.courierProvider, order.courierTrackingNo);
    loadCourierTrackEvents(db, order.id, (teErr, trackEvents) => {
        if (!teErr) order.courierTrackEvents = trackEvents || [];
        db.all(
            `SELECT event_type, title, description, meta_json, created_at FROM book_order_events WHERE book_order_id = ? ORDER BY id ASC`,
            [order.id],
            (err, events) => {
                if (!err && events && events.length) {
                    order.events = events.map((e) => {
                        let meta = null;
                        try {
                            meta = e.meta_json ? JSON.parse(e.meta_json) : null;
                        } catch (_) {}
                        return {
                            type: e.event_type,
                            title: e.title,
                            description: e.description,
                            at: e.created_at,
                            meta
                        };
                    });
                } else {
                    order.events = [];
                }
                cb(null, order);
            }
        );
    });
}

function bookQrImageUrl(qrPayload) {
    if (!qrPayload) return null;
    const data = typeof qrPayload === 'string' ? qrPayload : JSON.stringify(qrPayload);
    return (
        'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(data)
    );
}

function enrichBookScanPayload(db, base, cb) {
    const order = base.order;
    if (!order) return cb(null, base);
    const pickupPayload =
        order.qrCodeData ||
        JSON.stringify({
            type: 'book_order',
            bookOrderId: order.id,
            orderCode: order.orderCode,
            userId: order.userId
        });
    const out = {
        ...base,
        pickupQrImageUrl: null,
        paymentQrImageUrl: null,
        paymentPending:
            order.status === 'pending_payment' || order.status === 'awaiting_confirmation'
    };
    if ((order.status === 'confirmed' || order.status === 'fulfilled') && order.fulfillmentType !== 'courier') {
        out.pickupQrImageUrl = bookQrImageUrl(pickupPayload);
    }
    if (order.status === 'pending_payment' && order.orderId) {
        return db.get(
            `SELECT status FROM orders WHERE id = ?`,
            [order.orderId],
            (e2, payRow) => {
                if (!e2 && payRow && String(payRow.status).toLowerCase() !== 'success') {
                    out.paymentPending = true;
                }
                cb(null, out);
            }
        );
    }
    cb(null, out);
}

function fetchOrderWithCheckinStatus(db, bookOrderId, cb) {
    fetchBookOrderFull(db, bookOrderId, (err, order) => {
        if (err) return cb(err);
        if (!order || !order.userId) {
            return enrichBookScanPayload(db, { order, checkedIn: false, seminarStatus: null }, cb);
        }
        const sid =
            order.seminarId != null && order.seminarId !== ''
                ? parseInt(order.seminarId, 10)
                : null;
        let sql;
        let params;
        if (Number.isInteger(sid) && sid > 0) {
            sql = `SELECT t.is_scanned, t.scan_count, r.status AS reg_status
                   FROM registrations r
                   INNER JOIN orders o ON o.registration_id = r.id AND lower(o.status) = 'success'
                   LEFT JOIN tickets t ON t.order_id = o.id
                   WHERE r.user_id = ? AND r.seminar_id = ?
                   ORDER BY COALESCE(t.scan_count, 0) DESC, COALESCE(t.is_scanned, 0) DESC
                   LIMIT 1`;
            params = [order.userId, sid];
        } else {
            sql = `SELECT t.is_scanned, t.scan_count, r.status AS reg_status
                   FROM registrations r
                   INNER JOIN orders o ON o.registration_id = r.id AND lower(o.status) = 'success'
                   LEFT JOIN tickets t ON t.order_id = o.id
                   WHERE r.user_id = ?
                   ORDER BY COALESCE(t.scan_count, 0) DESC, COALESCE(t.is_scanned, 0) DESC
                   LIMIT 1`;
            params = [order.userId];
        }
        db.get(sql, params, (e2, row) => {
            if (e2) return cb(e2);
            enrichBookScanPayload(
                db,
                {
                    order,
                    checkedIn: !!(row && (Number(row.scan_count) > 0 || Number(row.is_scanned) === 1)),
                    seminarStatus: row ? row.reg_status : null
                },
                cb
            );
        });
    });
}

function fetchBookOrderFull(db, bookOrderId, cb) {
    db.get(
        `SELECT bo.*, o.order_id_string AS payment_order_string, o.status AS payment_status
         FROM book_orders bo
         LEFT JOIN orders o ON o.id = bo.order_id
         WHERE bo.id = ?`,
        [bookOrderId],
        (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            db.all(
                `SELECT * FROM book_order_items WHERE book_order_id = ? ORDER BY id`,
                [bookOrderId],
                (e2, itemRows) => {
                    if (e2) return cb(e2);
                    const items = (itemRows || []).map((it) => ({
                        bookId: it.book_id,
                        language: it.language,
                        languageLabel: languageLabel(it.language),
                        qty: it.qty,
                        unitPrice: it.unit_price,
                        lineTotal: it.line_total
                    }));
                    enrichOrderWithTracking(db, mapOrderRow(row, items), cb);
                }
            );
        }
    );
}

function confirmBookOrder(db, bookOrderId, adminId, cb) {
    fetchBookOrderFull(db, bookOrderId, (err, order) => {
        if (err) return cb(err);
        if (!order) return cb(null, { error: 'Order not found' });
        if (order.status === 'fulfilled') return cb(null, { error: 'Already fulfilled' });
        if (order.status === 'cancelled') return cb(null, { error: 'Order cancelled' });
        const qr = buildBookQrPayload({ id: order.id, order_code: order.orderCode, user_id: order.userId });
        db.run(
            `UPDATE book_orders SET status = 'confirmed', qr_code_data = ?, admin_confirmed_by = ?, admin_confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [qr, adminId || null, bookOrderId],
            (uErr) => {
                if (uErr) return cb(uErr);
                logBookOrderEvent(
                    db,
                    bookOrderId,
                    'confirmed',
                    'Ready for pickup',
                    'Pickup QR issued — show at book desk.',
                    { adminId: adminId || null }
                );
                fetchBookOrderFull(db, bookOrderId, (e2, fresh) => cb(e2, { success: true, order: fresh }));
            }
        );
    });
}

function fulfillBookOrderFromScan(db, bookOrderId, scannerUserId, cb) {
    fetchBookOrderFull(db, bookOrderId, (err, order) => {
        if (err) return cb(err);
        if (!order) return cb(null, { success: false, outcome: 'not_found', message: 'Book order not found' });
        if (order.status === 'fulfilled') {
            return cb(null, {
                success: false,
                outcome: 'duplicate',
                message: 'Already collected',
                order
            });
        }
        if (order.fulfillmentType === 'courier') {
            return cb(null, {
                success: false,
                outcome: 'courier',
                message: 'Courier delivery order — cannot mark collected at seminar desk.',
                order
            });
        }
        if (order.status !== 'confirmed') {
            return cb(null, {
                success: false,
                outcome: 'not_ready',
                message: 'Order not confirmed for pickup (status: ' + order.status + ')',
                order
            });
        }
        db.run(
            `UPDATE book_orders SET status = 'fulfilled', fulfillment_type = COALESCE(fulfillment_type, 'pickup'), fulfilled_at = CURRENT_TIMESTAMP, fulfilled_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [scannerUserId || null, bookOrderId],
            (uErr) => {
                if (uErr) return cb(uErr);
                db.run(
                    `INSERT INTO book_fulfillment_scans (book_order_id, scanner_user_id, outcome, message) VALUES (?, ?, 'success', ?)`,
                    [bookOrderId, scannerUserId || null, 'Books handed over at seminar'],
                    () => {
                        logBookOrderEvent(
                            db,
                            bookOrderId,
                            'fulfilled_pickup',
                            'Books collected',
                            'Handed over at seminar book desk.',
                            { scannerUserId: scannerUserId || null }
                        );
                        fetchBookOrderFull(db, bookOrderId, (e2, fresh) =>
                            cb(e2, { success: true, outcome: 'success', message: 'Fulfilled', order: fresh })
                        );
                    }
                );
            }
        );
    });
}

function lookupBookOrderFromQr(db, qrData, cb) {
    const raw = String(qrData || '').trim();
    if (!raw) return cb(null, null);
    const tryCode = (code, next) => {
        db.get(`SELECT id FROM book_orders WHERE order_code = ?`, [code], (err, row) => {
            if (err) return cb(err);
            if (row) return cb(null, row.id);
            next();
        });
    };
    const tryJson = (next) => {
        if (!raw.startsWith('{')) return next();
        try {
            const j = JSON.parse(raw);
            if (j.type === 'book_order' && j.bookOrderId) {
                return cb(null, parseInt(j.bookOrderId, 10));
            }
            if (j.orderCode) {
                return tryCode(String(j.orderCode).trim(), next);
            }
        } catch (_) {}
        next();
    };
    tryJson(() => {
        tryCode(raw, () => {
            if (raw.includes('book_order')) {
                const m = raw.match(/"bookOrderId"\s*:\s*(\d+)/);
                if (m) return cb(null, parseInt(m[1], 10));
            }
            cb(null, null);
        });
    });
}

function registerBookSalesRoutes(app, db, deps) {
    const { listDoctorPaymentOptions, parsePositiveUserId, upsertGlobalSetting } = deps;

    app.get('/api/public/book-sales/config', (req, res) => {
        loadBookSalesConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(publicBookSalesPayload(config));
        });
    });

    app.get('/api/admin/book-sales/config', (req, res) => {
        loadBookSalesConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config, languages: LANGUAGE_DEFS });
        });
    });

    app.post('/api/admin/book-sales/config', (req, res) => {
        const body = (req.body && req.body.config) || req.body || {};
        const config = normalizeConfig(body);
        saveBookSalesConfig(db, config, upsertGlobalSetting, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, config });
        });
    });

    app.get('/api/admin/book-sales/orders', (req, res) => {
        const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
        const status = String(req.query.status || '').trim();
        let sql = `SELECT bo.*, u.first_name, u.middle_name, u.last_name, u.email, u.phone, u.whatsapp,
                          u.user_id_string, u.qualification, u.registration_cert_no,
                          s.title AS seminar_title, o.order_id_string AS payment_order_string, o.status AS payment_status
                   FROM book_orders bo
                   LEFT JOIN users u ON u.id = bo.user_id
                   LEFT JOIN seminars s ON s.id = bo.seminar_id
                   LEFT JOIN orders o ON o.id = bo.order_id
                   WHERE 1=1`;
        const params = [];
        if (status) {
            sql += ` AND bo.status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY bo.id DESC LIMIT ?`;
        params.push(limit);
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/admin/book-sales/orders/:id/confirm', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const adminId = safeInternalUserRowId(req.body && req.body.actingAdminId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        confirmBookOrder(db, id, adminId, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result && result.error) return res.status(400).json({ error: result.error });
            res.json(result);
        });
    });

    app.post('/api/admin/book-sales/orders/:id/cancel', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        db.run(
            `UPDATE book_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('fulfilled')`,
            [id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (!this.changes) return res.status(400).json({ error: 'Cannot cancel' });
                logBookOrderEvent(db, id, 'cancelled', 'Order cancelled', 'Cancelled by admin.', null, () =>
                    res.json({ success: true })
                );
            }
        );
    });

    app.post('/api/admin/book-sales/orders/:id/status', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const status = String((req.body && req.body.status) || '')
            .trim()
            .toLowerCase();
        const adminId = safeInternalUserRowId(req.body && req.body.actingAdminId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        if (status === 'confirmed') {
            return confirmBookOrder(db, id, adminId, (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (result && result.error) return res.status(400).json({ error: result.error });
                res.json(result);
            });
        }
        if (status === 'cancelled') {
            return db.run(
                `UPDATE book_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('fulfilled')`,
                [id],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    if (!this.changes) return res.status(400).json({ error: 'Cannot cancel' });
                    logBookOrderEvent(db, id, 'cancelled', 'Order cancelled', 'Cancelled by admin.', null, () =>
                        res.json({ success: true })
                    );
                }
            );
        }
        if (status === 'fulfilled') {
            return fulfillBookOrderFromScan(db, id, adminId, (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (result && result.success === false) {
                    return res.status(400).json({ error: result.message || 'Cannot mark fulfilled' });
                }
                res.json(result);
            });
        }
        if (status === 'delivered') {
            return markBookOrderCourierDelivered(db, id, adminId, (err, result) => {
                if (err) return res.status(500).json({ error: err.message });
                if (result && result.error) return res.status(400).json({ error: result.error });
                res.json(result);
            });
        }
        return res.status(400).json({
            error: 'Unsupported status. Use confirmed, fulfilled (pickup), delivered (courier), or cancelled.'
        });
    });

    app.get('/api/doctor/book-orders', (req, res) => {
        const uid = parsePositiveUserId ? parsePositiveUserId(req.query.userId) : safeInternalUserRowId(req.query.userId);
        if (!uid) return res.status(400).json({ error: 'Invalid user' });
        db.all(
            `SELECT bo.*, o.order_id_string AS payment_order_string, o.status AS payment_status
             FROM book_orders bo
             LEFT JOIN orders o ON o.id = bo.order_id
             WHERE bo.user_id = ?
             ORDER BY bo.id DESC`,
            [uid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const out = [];
                let pending = (rows || []).length;
                if (!pending) return res.json([]);
                (rows || []).forEach((row) => {
                    db.all(`SELECT * FROM book_order_items WHERE book_order_id = ?`, [row.id], (e2, items) => {
                        out.push(mapOrderRow(row, (items || []).map((it) => ({
                            bookId: it.book_id,
                            language: it.language,
                            languageLabel: languageLabel(it.language),
                            qty: it.qty,
                            unitPrice: it.unit_price,
                            lineTotal: it.line_total
                        }))));
                        pending--;
                        if (!pending) {
                            out.sort((a, b) => b.id - a.id);
                            let left = out.length;
                            if (!left) return res.json([]);
                            out.forEach((ord, idx) => {
                                enrichOrderWithTracking(db, ord, () => {
                                    left--;
                                    if (!left) {
                                        out.sort((a, b) => b.id - a.id);
                                        res.json(out);
                                    }
                                });
                            });
                        }
                    });
                });
            }
        );
    });

    app.post('/api/doctor/book-orders/refresh-tracks', (req, res) => {
        const uid = parsePositiveUserId ? parsePositiveUserId(req.body.userId) : safeInternalUserRowId(req.body.userId);
        if (!uid) return res.status(400).json({ error: 'Invalid user' });
        db.all(
            `SELECT id FROM book_orders WHERE user_id = ? AND fulfillment_type = 'courier' AND status = 'shipped' AND courier_tracking_no IS NOT NULL LIMIT 10`,
            [uid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const ids = (rows || []).map((r) => r.id);
                if (!ids.length) return res.json({ success: true, refreshed: 0 });
                let left = ids.length;
                ids.forEach((oid) => refreshCourierTrackForOrder(db, oid, () => { left--; if (!left) res.json({ success: true, refreshed: ids.length }); }));
            }
        );
    });

    app.get('/api/doctor/book-orders/:id/tracking', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const uid = parsePositiveUserId ? parsePositiveUserId(req.query.userId) : safeInternalUserRowId(req.query.userId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Not found' });
            if (uid && order.userId && Number(order.userId) !== uid) return res.status(403).json({ error: 'Forbidden' });
            res.json({
                order,
                timeline: order.timeline,
                events: order.events || [],
                courierTrackingUrl: order.courierTrackingUrl
            });
        });
    });

    app.post('/api/doctor/book-orders', (req, res) => {
        const body = req.body || {};
        const uid = parsePositiveUserId ? parsePositiveUserId(body.userId) : safeInternalUserRowId(body.userId);
        if (!uid) return res.status(400).json({ error: 'Invalid user' });
        const paymentMode = String(body.paymentMode || 'counter').toLowerCase() === 'online' ? 'online' : 'counter';
        loadBookSalesConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!config.enabled) return res.status(403).json({ error: 'Book sales are not enabled on the doctor portal.' });
            const orderWindow = evaluateBookOrderWindow(config);
            if (!orderWindow.open) {
                return res.status(403).json({
                    error: orderWindow.message || 'Book ordering is not open at this time.',
                    orderWindow
                });
            }
            if (paymentMode === 'online' && !config.onlinePaymentEnabled) {
                return res.status(400).json({ error: 'Online payment is not available for books.' });
            }
            if (paymentMode === 'counter' && !config.payAtCounterEnabled) {
                return res.status(400).json({ error: 'Pay at counter is not available for books.' });
            }
            const validated = validateLineItems(config, body.items);
            if (validated.error) return res.status(400).json({ error: validated.error });
            const orderCode = genBookOrderString();
            const seminarId = config.seminarId;
            const initialStatus = paymentMode === 'counter' ? 'awaiting_confirmation' : 'pending_payment';
            db.run(
                `INSERT INTO book_orders (order_code, user_id, seminar_id, status, payment_mode, total_amount, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderCode,
                    uid,
                    seminarId,
                    initialStatus,
                    paymentMode,
                    validated.total,
                    String(body.notes || '').trim() || null
                ],
                function (insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    const bookOrderId = this.lastID;
                    let left = validated.lines.length;
                    validated.lines.forEach((line) => {
                        db.run(
                            `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [bookOrderId, line.bookId, line.language, line.qty, line.unitPrice, line.lineTotal],
                            () => {
                                left--;
                                if (!left) {
                                    logBookOrderEvent(
                                        db,
                                        bookOrderId,
                                        'placed',
                                        'Order placed',
                                        paymentMode === 'online'
                                            ? 'Complete online payment to confirm.'
                                            : 'Pay at the book desk to confirm.',
                                        { paymentMode, orderCode }
                                    );
                                    if (paymentMode === 'counter') {
                                        return fetchBookOrderFull(db, bookOrderId, (e3, order) =>
                                            res.json({
                                                success: true,
                                                order,
                                                message:
                                                    'Order placed. Pay at the counter; staff will confirm and you will receive a pickup QR.'
                                            })
                                        );
                                    }
                                    const orderStr = 'BKP' + Date.now().toString(36).toUpperCase();
                                    db.run(
                                        `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, 'pending')`,
                                        [orderStr, validated.total],
                                        function (oErr) {
                                            if (oErr) return res.status(500).json({ error: oErr.message });
                                            const orderDbId = this.lastID;
                                            db.run(
                                                `UPDATE book_orders SET order_id = ? WHERE id = ?`,
                                                [orderDbId, bookOrderId],
                                                () => {
                                                    res.json({
                                                        success: true,
                                                        bookOrderId,
                                                        orderDbId,
                                                        orderIdString: orderStr,
                                                        amount: validated.total,
                                                        needsPayment: true
                                                    });
                                                }
                                            );
                                        }
                                    );
                                }
                            }
                        );
                    });
                }
            );
        });
    });

    app.post('/api/payments/process-book-order', (req, res) => {
        const bookOrderId = parseInt(req.body && req.body.bookOrderId, 10);
        const uid = parsePositiveUserId ? parsePositiveUserId(req.body && req.body.userId) : safeInternalUserRowId(req.body && req.body.userId);
        const mid = String((req.body && req.body.methodId) || '').trim();
        if (!Number.isInteger(bookOrderId) || bookOrderId < 1) {
            return res.status(400).json({ success: false, error: 'Invalid book order id' });
        }
        if (!uid) return res.status(400).json({ success: false, error: 'Invalid user' });
        db.get(`SELECT * FROM book_orders WHERE id = ?`, [bookOrderId], (err, bo) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (!bo) return res.status(404).json({ success: false, error: 'Order not found' });
            if (Number(bo.user_id) !== uid) {
                return res.status(403).json({ success: false, error: 'Not your order' });
            }
            if (bo.status !== 'pending_payment') {
                return res.status(400).json({ success: false, error: 'Order is not awaiting payment (status: ' + bo.status + ')' });
            }
            const amount = Number(bo.total_amount);
            const orderDbId = bo.order_id;
            const markPaidAndConfirm = (gateway, txnId) => {
                db.run(
                    `UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = ?, provider_transaction_id = ? WHERE id = ?`,
                    [gateway, txnId || null, orderDbId],
                    (uErr) => {
                        if (uErr) return res.status(500).json({ success: false, error: uErr.message });
                        confirmBookOrder(db, bookOrderId, null, (cErr, result) => {
                            if (cErr) return res.status(500).json({ success: false, error: cErr.message });
                            if (result && result.error) {
                                return res.status(400).json({ success: false, error: result.error });
                            }
                            res.json({
                                success: true,
                                paid: true,
                                message: 'Payment received. Show your pickup QR at the book counter on seminar day.',
                                order: result.order
                            });
                        });
                    }
                );
            };
            if (!mid || mid === 'mock') {
                return markPaidAndConfirm('mock', 'MOCK_' + Date.now());
            }
            listDoctorPaymentOptions((eList, options) => {
                if (eList) return res.status(500).json({ success: false, error: eList.message });
                const opt = (options || []).find((o) => o.id === mid);
                if (!opt) {
                    return res.status(400).json({ success: false, error: 'Choose a payment method.' });
                }
                db.get(`SELECT order_id_string FROM orders WHERE id = ?`, [orderDbId], (e2, ord) => {
                    if (e2) return res.status(500).json({ success: false, error: e2.message });
                    const orderIdStr = ord && ord.order_id_string;
                    db.all(`SELECT * FROM payment_gateways`, [], (eGw, gwRows) => {
                        if (eGw) return res.status(500).json({ success: false, error: eGw.message });
                        if (mid === 'dqr') {
                            const all = [];
                            (gwRows || []).forEach((row) => {
                                if (Number(row.is_active) !== 1) return;
                                all.push(...paymentGatewayOptions.expandGatewayRow(row));
                            });
                            const razorpay = adminPaymentFlow.pickRazorpayGateway(gwRows);
                            if (!razorpay) {
                                return res.status(400).json({
                                    success: false,
                                    error: 'UPI QR is not configured. Use another method or pay at counter.'
                                });
                            }
                            return adminPaymentFlow.createRazorpayDqr(
                                razorpay,
                                { amountRupee: amount, orderIdStr, applicationNo: bo.order_code },
                                (dErr, dqr) => {
                                    if (dErr) {
                                        return res.status(400).json({ success: false, error: dErr.message });
                                    }
                                    db.run(
                                        `UPDATE orders SET payment_gateway = ?, provider_order_id = ? WHERE id = ?`,
                                        [dqr.gatewayTag, dqr.qrId, orderDbId],
                                        () => {
                                            res.json({
                                                success: true,
                                                paid: false,
                                                paymentType: 'dqr',
                                                orderDbId,
                                                bookOrderId,
                                                amount,
                                                qrImageUrl: dqr.imageUrl,
                                                qrShortUrl: dqr.shortUrl,
                                                pollRequired: true,
                                                message: 'Scan UPI QR to pay for your books.'
                                            });
                                        }
                                    );
                                }
                            );
                        }
                        if (opt.type === 'razorpay_checkout' || String(opt.type || '').includes('checkout')) {
                            return res.status(400).json({
                                success: false,
                                error: 'Use UPI QR (DQR) or test payment for book orders. Hosted checkout for books coming soon.',
                                options: (options || []).map((o) => ({ id: o.id, label: o.label }))
                            });
                        }
                        res.status(400).json({ success: false, error: 'Payment method not supported for book orders.' });
                    });
                });
            });
        });
    });

    app.get('/api/payments/book-order-status', (req, res) => {
        const bookOrderId = parseInt(req.query.bookOrderId, 10);
        const uid = parsePositiveUserId ? parsePositiveUserId(req.query.userId) : safeInternalUserRowId(req.query.userId);
        if (!Number.isInteger(bookOrderId) || bookOrderId < 1) return res.status(400).json({ error: 'Invalid id' });
        fetchBookOrderFull(db, bookOrderId, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Not found' });
            if (uid && Number(order.userId) !== uid) return res.status(403).json({ error: 'Forbidden' });
            if (order.status === 'pending_payment' && order.orderId) {
                db.get(`SELECT status FROM orders WHERE id = ?`, [order.orderId], (e2, pay) => {
                    if (pay && String(pay.status).toLowerCase() === 'success') {
                        return confirmBookOrder(db, bookOrderId, null, (cErr, result) => {
                            if (cErr) return res.status(500).json({ error: cErr.message });
                            return res.json({ order: (result && result.order) || order, paid: true });
                        });
                    }
                    res.json({ order, paid: false });
                });
            } else {
                res.json({
                    order,
                    paid: order.status === 'confirmed' || order.status === 'fulfilled'
                });
            }
        });
    });

    app.post('/api/scanner/book-fulfill', (req, res) => {
        const qrData = req.body && (req.body.qrData || req.body.qr);
        const scannerUserId = safeInternalUserRowId(req.body && req.body.scannerUserId);
        lookupBookOrderFromQr(db, qrData, (err, bookOrderId) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!bookOrderId) {
                return res.status(404).json({ success: false, outcome: 'not_found', message: 'Not a book pickup QR' });
            }
            fulfillBookOrderFromScan(db, bookOrderId, scannerUserId, (e2, result) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const code = result.success ? 200 : result.outcome === 'duplicate' ? 400 : 403;
                res.status(code).json(result);
            });
        });
    });

    app.get('/api/scanner/book-lookup', (req, res) => {
        const qrData = req.query.qrData || req.query.qr;
        lookupBookOrderFromQr(db, qrData, (err, bookOrderId) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!bookOrderId) return res.status(404).json({ error: 'Not found' });
            respondBookScanLookup(db, bookOrderId, res);
        });
    });

    function respondBookScanLookup(db, bookOrderId, res) {
        fetchOrderWithCheckinStatus(db, bookOrderId, (e2, result) => {
            if (e2) return res.status(500).json({ error: e2.message });
            if (!result.order) return res.status(404).json({ error: 'Not found' });
            const uid = result.order.userId;
            if (!uid) {
                return res.json({
                    ...result,
                    doctor: { name: result.order.buyerName, phone: result.order.buyerPhone }
                });
            }
            db.get(
                `SELECT first_name, last_name, email, phone, user_id_string FROM users WHERE id = ?`,
                [uid],
                (e3, u) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    res.json({ ...result, doctor: u || {} });
                }
            );
        });
    }

    // Admin: Save courier shipping details (step 1 — confirm address, then ship separately)
    app.post('/api/admin/book-sales/orders/:id/courier-details', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        const recipient = String(body.recipientName || body.shippingRecipientName || '').trim();
        const phone = String(body.shippingPhone || body.phone || '').trim();
        const addressLine = String(body.addressLine || body.deliveryAddress || '').trim();
        const city = String(body.city || body.shippingCity || '').trim();
        const state = String(body.state || body.shippingState || '').trim();
        const pincode = String(body.pincode || body.shippingPincode || '').trim();
        const provider = String(body.courierProvider || '').trim();
        const charge = Math.max(0, Number(body.courierCharge) || 0);
        const notes = String(body.notes || '').trim();
        if (!recipient) return res.status(400).json({ error: 'Recipient name required' });
        if (!phone) return res.status(400).json({ error: 'Shipping phone required' });
        if (!addressLine) return res.status(400).json({ error: 'Address line required' });
        if (!city) return res.status(400).json({ error: 'City required' });
        if (!state) return res.status(400).json({ error: 'State required' });
        if (!pincode) return res.status(400).json({ error: 'PIN code required' });
        if (!provider) return res.status(400).json({ error: 'Courier provider required' });
        const fullAddress = buildDeliveryAddressLine({ addressLine, city, state, pincode });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Order not found' });
            if (order.status === 'fulfilled' || order.status === 'cancelled') {
                return res.status(400).json({ error: 'Cannot edit shipping for ' + order.status + ' order' });
            }
            db.run(
                `UPDATE book_orders SET fulfillment_type = 'courier', courier_shipment_status = 'ready_to_ship',
                 shipping_recipient_name = ?, shipping_phone = ?, shipping_pincode = ?, shipping_city = ?, shipping_state = ?,
                 delivery_address = ?, courier_provider = ?, courier_charge = ?,
                 notes = COALESCE(?, notes), courier_details_saved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [recipient, phone, pincode, city, state, fullAddress, provider, charge, notes || null, id],
                function (uErr) {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (!this.changes) return res.status(404).json({ error: 'Order not found' });
                    logBookOrderEvent(
                        db,
                        id,
                        'courier_details_saved',
                        'Courier shipping details saved',
                        fullAddress + ' · ' + courierProviderLabel(provider),
                        { courierProvider: provider, recipient, phone, pincode, city, state, courierCharge: charge }
                    );
                    fetchBookOrderFull(db, id, (e2, fresh) =>
                        res.json({
                            success: true,
                            order: fresh,
                            courierTrackingUrl: null,
                            message: 'Shipping details saved. Enter AWB and confirm dispatch to ship.'
                        })
                    );
                }
            );
        });
    });

    // Admin: Confirm dispatch with AWB (step 2)
    app.post('/api/admin/book-sales/orders/:id/dispatch-courier', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        const trackingNo = String(body.trackingNo || '').trim();
        const adminId = safeInternalUserRowId(body.actingAdminId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        if (!trackingNo) return res.status(400).json({ error: 'Tracking / AWB number required' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Order not found' });
            if (order.status === 'cancelled') return res.status(400).json({ error: 'Order is cancelled' });
            if (order.fulfillmentType !== 'courier' || order.courierShipmentStatus !== 'ready_to_ship') {
                return res.status(400).json({
                    error: 'Save courier shipping details first (recipient, address, provider), then confirm dispatch.'
                });
            }
            const provider = String(body.courierProvider || order.courierProvider || '').trim();
            const trackUrl = courierTrackingUrl(provider, trackingNo);
            db.run(
                `UPDATE book_orders SET status = 'shipped', fulfillment_type = 'courier',
             courier_provider = ?, courier_tracking_no = ?, courier_shipment_status = 'shipped',
             courier_track_status = 'in_transit', courier_track_label = 'Dispatched — fetching live status',
             courier_dispatched_at = CURRENT_TIMESTAMP, fulfilled_at = NULL, fulfilled_by = ?,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [provider || order.courierProvider, trackingNo, adminId || null, id],
                function (uErr) {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (!this.changes) return res.status(404).json({ error: 'Order not found' });
                    logBookOrderEvent(
                        db,
                        id,
                        'shipped_courier',
                        'Shipped by courier',
                        courierProviderLabel(provider) + ' · AWB ' + trackingNo,
                        { courierProvider: provider, trackingNo, trackingUrl: trackUrl },
                        () =>
                            refreshCourierTrackForOrder(db, id, (ePoll, pollResult) => {
                                fetchBookOrderFull(db, id, (e2, fresh) =>
                                    res.json({
                                        success: true,
                                        order: (pollResult && pollResult.order) || fresh,
                                        courierTrackingUrl: trackUrl,
                                        liveTrack: pollResult && pollResult.track,
                                        message:
                                            'Order dispatched (in transit). Live tracking updates in dashboard — not marked delivered until carrier confirms.'
                                    })
                                );
                            })
                    );
                }
            );
        });
    });

    app.post('/api/admin/book-sales/orders/:id/refresh-courier-track', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        refreshCourierTrackForOrder(db, id, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result && result.skipped) {
                return res.status(400).json({ error: 'No courier tracking on this order' });
            }
            fetchBookOrderFull(db, id, (e2, order) =>
                res.json({
                    success: true,
                    order,
                    track: result && result.track,
                    timeline: order && order.timeline,
                    courierTrackEvents: order && order.courierTrackEvents
                })
            );
        });
    });

    app.post('/api/admin/book-sales/orders/:id/mark-delivered', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const adminId = safeInternalUserRowId(req.body && req.body.actingAdminId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        markBookOrderCourierDelivered(db, id, adminId, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result && result.error) return res.status(400).json({ error: result.error });
            res.json(result);
        });
    });

    app.post('/api/admin/book-sales/poll-courier-tracks', (req, res) => {
        db.all(
            `SELECT id FROM book_orders WHERE fulfillment_type = 'courier' AND status = 'shipped' AND courier_tracking_no IS NOT NULL AND courier_tracking_no != '' LIMIT 40`,
            [],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const ids = (rows || []).map((r) => r.id);
                if (!ids.length) return res.json({ success: true, polled: 0 });
                let left = ids.length;
                let done = 0;
                ids.forEach((oid) => {
                    refreshCourierTrackForOrder(db, oid, () => {
                        done++;
                        left--;
                        if (!left) res.json({ success: true, polled: done });
                    });
                });
            }
        );
    });

    // Admin: Update courier tracking number
    app.post('/api/admin/book-sales/orders/:id/update-tracking', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const trackingNo = String((req.body && req.body.trackingNo) || '').trim();
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Order not found' });
            const provider = String((req.body && req.body.courierProvider) || order.courierProvider || '').trim();
            const trackUrl = courierTrackingUrl(provider, trackingNo);
            db.run(
                `UPDATE book_orders SET courier_tracking_no = ?, courier_provider = COALESCE(?, courier_provider), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [trackingNo || null, provider || null, id],
                function (uErr) {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    if (trackingNo) {
                        logBookOrderEvent(
                            db,
                            id,
                            'tracking_updated',
                            'Tracking number updated',
                            'AWB: ' + trackingNo,
                            { trackingNo, trackingUrl: trackUrl, courierProvider: provider }
                        );
                    }
                    fetchBookOrderFull(db, id, (e2, fresh) =>
                        res.json({ success: true, order: fresh, courierTrackingUrl: trackUrl })
                    );
                }
            );
        });
    });

    // Admin: Book POS — create order for walk-in buyer
    app.post('/api/admin/book-sales/pos', (req, res) => {
        const body = req.body || {};
        const buyerName = String(body.buyerName || '').trim();
        const buyerPhone = String(body.buyerPhone || '').trim();
        const linkedUserId = safeInternalUserRowId(body.userId);
        const adminId = safeInternalUserRowId(body.actingAdminId);
        if (!buyerName && !buyerPhone && !linkedUserId) {
            return res.status(400).json({ error: 'Buyer name, phone, or linked doctor required' });
        }
        const finishPosInsert = (userId, name, phone) => {
            loadBookSalesConfig(db, (err, config) => {
                if (err) return res.status(500).json({ error: err.message });
                const validated = validateLineItems(config, body.items);
                if (validated.error) return res.status(400).json({ error: validated.error });
                const orderCode = genBookOrderString();
                const total = validated.total;
                const paymentMode = String(body.paymentMode || 'cash').toLowerCase();
                const initialStatus = 'confirmed'; // POS orders are immediately confirmed
                const qr = JSON.stringify({ type: 'book_order', orderCode, buyerName: name, buyerPhone: phone });
                db.run(
                    `INSERT INTO book_orders (order_code, user_id, seminar_id, status, payment_mode, total_amount,
                 buyer_name, buyer_phone, qr_code_data, admin_confirmed_by, admin_confirmed_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [
                        orderCode,
                        userId || null,
                        config.seminarId,
                        initialStatus,
                        paymentMode,
                        total,
                        name || null,
                        phone || null,
                        qr,
                        adminId || null
                    ],
                function (insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    const bookOrderId = this.lastID;
                    let left = validated.lines.length;
                    validated.lines.forEach((line) => {
                        db.run(
                            `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [bookOrderId, line.bookId, line.language, line.qty, line.unitPrice, line.lineTotal],
                            () => {
                                left--;
                                if (!left) {
                                    const properQr = buildBookQrPayload({
                                        id: bookOrderId,
                                        order_code: orderCode,
                                        user_id: userId || null
                                    });
                                    db.run(
                                        `UPDATE book_orders SET qr_code_data = ? WHERE id = ?`,
                                        [properQr, bookOrderId],
                                        () => {
                                            logBookOrderEvent(
                                                db,
                                                bookOrderId,
                                                'placed',
                                                'POS order placed',
                                                'Walk-in sale at book desk.',
                                                { orderCode, paymentMode }
                                            );
                                            logBookOrderEvent(
                                                db,
                                                bookOrderId,
                                                'confirmed',
                                                'Ready for pickup',
                                                'QR issued at POS.',
                                                null,
                                                () =>
                                                    fetchBookOrderFull(db, bookOrderId, (e3, order) => {
                                                        const pickupQrImageUrl = bookQrImageUrl(
                                                            order.qrCodeData || properQr
                                                        );
                                                        res.json({
                                                            success: true,
                                                            order,
                                                            orderCode,
                                                            qr: properQr,
                                                            pickupQrImageUrl
                                                        });
                                                    })
                                            );
                                        }
                                    );
                                }
                            }
                        );
                    });
                }
            );
            });
        };
        if (linkedUserId) {
            db.get(
                `SELECT id, first_name, middle_name, last_name, email, phone, whatsapp, qualification,
                        practitioner_type, registration_cert_no, user_id_string, doctor_category
                 FROM users WHERE id = ?`,
                [linkedUserId],
                (eU, u) => {
                    if (eU) return res.status(500).json({ error: eU.message });
                    if (!u) return res.status(404).json({ error: 'Doctor not found' });
                    const name =
                        buyerName ||
                        [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(' ').trim();
                    const phone = buyerPhone || u.phone || u.whatsapp || '';
                    finishPosInsert(u.id, name, phone);
                }
            );
            return;
        }
        finishPosInsert(null, buyerName, buyerPhone);
    });

    // Admin: Book POS search by phone/name
    app.get('/api/admin/book-sales/pos-search', (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json([]);
        const like = '%' + q + '%';
        db.all(
            `SELECT id, user_id_string, first_name, middle_name, last_name, email, phone, whatsapp,
                    qualification, practitioner_type, registration_cert_no, doctor_category, created_at
             FROM users
             WHERE phone LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ?
                OR middle_name LIKE ? OR user_id_string LIKE ? OR qualification LIKE ?
                OR registration_cert_no LIKE ?
             ORDER BY id DESC
             LIMIT 12`,
            [like, like, like, like, like, like, like, like],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    // Scanner: Volunteer scan — show checkin status + book details then fulfill
    app.post('/api/scanner/volunteer-book-fulfill', (req, res) => {
        const qrData = req.body && (req.body.qrData || req.body.qr);
        const scannerUserId = safeInternalUserRowId(req.body && req.body.scannerUserId);
        const previewOnly = !!(req.body && req.body.previewOnly);
        lookupBookOrderFromQr(db, qrData, (err, bookOrderId) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!bookOrderId) {
                return res.status(404).json({ success: false, outcome: 'not_found', message: 'Not a book order QR' });
            }
            fetchOrderWithCheckinStatus(db, bookOrderId, (e2, result) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!result.order) return res.status(404).json({ success: false, outcome: 'not_found', message: 'Order not found' });
                const order = result.order;
                const attachDoctor = (payload, done) => {
                    const uid = order.userId;
                    if (!uid) {
                        payload.doctor = { name: order.buyerName, phone: order.buyerPhone };
                        return done(payload);
                    }
                    db.get(
                        `SELECT first_name, last_name, email, phone, user_id_string FROM users WHERE id = ?`,
                        [uid],
                        (e4, u) => {
                            payload.doctor = u || {};
                            done(payload);
                        }
                    );
                };
                if (previewOnly || order.status !== 'confirmed' || order.fulfillmentType === 'courier') {
                    const courierOrder = order.fulfillmentType === 'courier';
                    const payload = {
                        success: order.status === 'confirmed' && !courierOrder,
                        preview: true,
                        outcome:
                            order.status === 'fulfilled'
                                ? 'duplicate'
                                : courierOrder
                                  ? 'courier'
                                  : order.status === 'confirmed'
                                    ? 'ready'
                                    : 'not_ready',
                        message:
                            order.status === 'fulfilled'
                                ? courierOrder
                                    ? 'Already shipped / fulfilled'
                                    : 'Already collected'
                                : courierOrder
                                  ? order.courierShipmentStatus === 'shipped'
                                    ? 'Shipped by courier — not seminar pickup'
                                    : 'Courier delivery — staff will ship to saved address'
                                  : order.status === 'confirmed'
                                    ? 'Ready for pickup — confirm handover below'
                                    : 'Order is ' + order.status + ' — payment or admin confirmation required',
                        order,
                        checkedIn: result.checkedIn,
                        seminarStatus: result.seminarStatus,
                        pickupQrImageUrl: result.pickupQrImageUrl,
                        paymentPending: result.paymentPending
                    };
                    const code = courierOrder
                        ? 403
                        : order.status === 'fulfilled'
                          ? 400
                          : order.status === 'confirmed'
                            ? 200
                            : 403;
                    return attachDoctor(payload, (p) => res.status(code).json(p));
                }
                fulfillBookOrderFromScan(db, bookOrderId, scannerUserId, (e3, fulfillResult) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    const payload = {
                        ...fulfillResult,
                        checkedIn: result.checkedIn,
                        seminarStatus: result.seminarStatus,
                        pickupQrImageUrl: result.pickupQrImageUrl
                    };
                    attachDoctor(payload, (p) => res.json(p));
                });
            });
        });
    });

    // Doctor: Real-time order poll (status check)
    app.get('/api/doctor/book-orders/:id/status', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const uid = parsePositiveUserId ? parsePositiveUserId(req.query.userId) : safeInternalUserRowId(req.query.userId);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Not found' });
            if (uid && order.userId && Number(order.userId) !== uid) return res.status(403).json({ error: 'Forbidden' });
            res.json({
                order,
                timeline: order.timeline,
                events: order.events || [],
                courierTrackingUrl: order.courierTrackingUrl
            });
        });
    });

    // Admin: Get single order
    app.get('/api/admin/book-sales/orders/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Not found' });
            res.json({
                order,
                timeline: order.timeline,
                events: order.events || [],
                courierTrackEvents: order.courierTrackEvents || [],
                courierTrackingUrl: order.courierTrackingUrl
            });
        });
    });

    app.get('/api/public/book-sales/courier-providers', (req, res) => {
        res.json(
            COURIER_PROVIDERS.map((p) => ({
                ...p,
                trackingHint: 'Official courier tracking opens after AWB is issued'
            }))
        );
    });

    app.get('/api/admin/book-sales/courier-tracking-url', (req, res) => {
        const provider = String(req.query.provider || '').trim();
        const trackingNo = String(req.query.trackingNo || '').trim();
        if (!trackingNo) return res.status(400).json({ error: 'trackingNo required' });
        res.json({
            url: courierTrackingUrl(provider, trackingNo),
            providerLabel: courierProviderLabel(provider)
        });
    });
}

module.exports = {
    CONFIG_KEY,
    BUILTIN_BOOK_IDS,
    LANGUAGE_DEFS,
    COURIER_PROVIDERS,
    DEFAULT_CONFIG,
    ensureBookSalesSchema,
    loadBookSalesConfig,
    saveBookSalesConfig,
    normalizeConfig,
    evaluateBookOrderWindow,
    publicBookSalesPayload,
    registerBookSalesRoutes,
    lookupBookOrderFromQr,
    confirmBookOrder,
    fulfillBookOrderFromScan,
    fetchBookOrderFull
};

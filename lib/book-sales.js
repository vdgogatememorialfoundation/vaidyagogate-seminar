/**
 * Dr. R.B. Gogate book sales — Agnikarma & Viddhakarma (multi-language), doctor portal + scanner fulfillment.
 */
const adminPaymentFlow = require('./admin-payment-flow');
const paymentGatewayOptions = require('./payment-gateway-options');
const { safeInternalUserRowId } = require('./internal-user-id');
const seminarDt = require('./seminar-datetime');

const CONFIG_KEY = 'book_sales_config';

/** Fixed book IDs kept for backward compat; custom books use arbitrary IDs. */
const BUILTIN_BOOK_IDS = ['agnikarma', 'viddhakarma'];

const LANGUAGE_DEFS = [
    { id: 'english', label: 'English' },
    { id: 'marathi', label: 'Marathi' },
    { id: 'hindi', label: 'Hindi' },
    { id: 'kannada', label: 'Kannada' }
];

const COURIER_PROVIDERS = [
    { id: 'indian_post', label: 'Indian Post / Speed Post' },
    { id: 'dtdc', label: 'DTDC' },
    { id: 'bluedart', label: 'Blue Dart' },
    { id: 'delhivery', label: 'Delhivery' },
    { id: 'ecom_express', label: 'Ecom Express' },
    { id: 'other', label: 'Other courier' }
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
            'ALTER TABLE book_orders ADD COLUMN IF NOT EXISTS delivery_address TEXT'
          ]
        : [
            'ALTER TABLE book_orders ADD COLUMN buyer_name TEXT',
            'ALTER TABLE book_orders ADD COLUMN buyer_phone TEXT',
            'ALTER TABLE book_orders ADD COLUMN fulfillment_type TEXT DEFAULT \'pickup\'',
            'ALTER TABLE book_orders ADD COLUMN courier_provider TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_tracking_no TEXT',
            'ALTER TABLE book_orders ADD COLUMN courier_charge REAL DEFAULT 0',
            'ALTER TABLE book_orders ADD COLUMN courier_dispatched_at TEXT',
            'ALTER TABLE book_orders ADD COLUMN delivery_address TEXT'
          ];
    db.serialize(() => {
        db.run(ordersSql, (e1) => {
            if (e1) console.warn('[book-sales] schema orders', e1.message);
            db.run(itemsSql, (e2) => {
                if (e2) console.warn('[book-sales] schema items', e2.message);
                db.run(scansSql, (e3) => {
                    if (e3) console.warn('[book-sales] schema scans', e3.message);
                    let i = 0;
                    const runAlter = () => {
                        if (i >= colAlters.length) return cb && cb();
                        db.run(colAlters[i++], (ae) => { ignore(ae); runAlter(); });
                    };
                    runAlter();
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
        fulfilledAt: row.fulfilled_at,
        buyerName: row.buyer_name || null,
        buyerPhone: row.buyer_phone || null,
        fulfillmentType: row.fulfillment_type || 'pickup',
        courierProvider: row.courier_provider || null,
        courierTrackingNo: row.courier_tracking_no || null,
        courierCharge: Number(row.courier_charge) || 0,
        courierDispatchedAt: row.courier_dispatched_at || null,
        deliveryAddress: row.delivery_address || null,
        items: items || []
    };
}

function fetchOrderWithCheckinStatus(db, bookOrderId, cb) {
    fetchBookOrderFull(db, bookOrderId, (err, order) => {
        if (err) return cb(err);
        if (!order || !order.userId) return cb(null, { order, checkedIn: false, seminarStatus: null });
        // Check if doctor has a checked-in ticket for the order's seminar
        db.get(
            `SELECT t.is_scanned, t.scan_count, r.status AS reg_status
             FROM registrations r
             LEFT JOIN orders o ON o.registration_id = r.id
             LEFT JOIN tickets t ON t.order_id = o.id
             WHERE r.user_id = ?
               AND (? IS NULL OR r.seminar_id = ?)
               AND lower(o.status) = 'success'
             ORDER BY t.scan_count DESC, t.is_scanned DESC
             LIMIT 1`,
            [order.userId, order.seminarId, order.seminarId],
            (e2, row) => {
                if (e2) return cb(e2);
                cb(null, {
                    order,
                    checkedIn: !!(row && (Number(row.scan_count) > 0 || Number(row.is_scanned) === 1)),
                    seminarStatus: row ? row.reg_status : null
                });
            }
        );
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
                    cb(null, mapOrderRow(row, items));
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
        if (order.status !== 'confirmed') {
            return cb(null, {
                success: false,
                outcome: 'not_ready',
                message: 'Order not confirmed for pickup (status: ' + order.status + ')',
                order
            });
        }
        db.run(
            `UPDATE book_orders SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP, fulfilled_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [scannerUserId || null, bookOrderId],
            (uErr) => {
                if (uErr) return cb(uErr);
                db.run(
                    `INSERT INTO book_fulfillment_scans (book_order_id, scanner_user_id, outcome, message) VALUES (?, ?, 'success', ?)`,
                    [bookOrderId, scannerUserId || null, 'Books handed over at seminar'],
                    () => {
                        fetchBookOrderFull(db, bookOrderId, (e2, fresh) =>
                            cb(e2, { success: true, outcome: 'success', message: 'Fulfilled', order: fresh })
                        );
                    }
                );
            }
        );
    });
}

function lookupBookOrderFromQr(qrData, cb) {
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
        let sql = `SELECT bo.*, u.first_name, u.last_name, u.email, u.phone, u.user_id_string,
                          s.title AS seminar_title, o.order_id_string AS payment_order_string, o.status AS payment_status
                   FROM book_orders bo
                   JOIN users u ON u.id = bo.user_id
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
                res.json({ success: true });
            }
        );
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
                            res.json(out);
                        }
                    });
                });
            }
        );
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
        lookupBookOrderFromQr(qrData, (err, bookOrderId) => {
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
        lookupBookOrderFromQr(qrData, (err, bookOrderId) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!bookOrderId) return res.status(404).json({ error: 'Not found' });
            fetchOrderWithCheckinStatus(db, bookOrderId, (e2, result) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!result.order) return res.status(404).json({ error: 'Not found' });
                const uid = result.order.userId;
                if (!uid) return res.json({ ...result, doctor: { name: result.order.buyerName, phone: result.order.buyerPhone } });
                db.get(
                    `SELECT first_name, last_name, email, phone, user_id_string FROM users WHERE id = ?`,
                    [uid],
                    (e3, u) => {
                        if (e3) return res.status(500).json({ error: e3.message });
                        res.json({ ...result, doctor: u || {} });
                    }
                );
            });
        });
    });

    // Admin: Mark as courier dispatch
    app.post('/api/admin/book-sales/orders/:id/dispatch-courier', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const body = req.body || {};
        const provider = String(body.courierProvider || '').trim();
        const trackingNo = String(body.trackingNo || '').trim();
        const charge = Math.max(0, Number(body.courierCharge) || 0);
        const address = String(body.deliveryAddress || '').trim();
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        if (!trackingNo) return res.status(400).json({ error: 'Tracking number required' });
        db.run(
            `UPDATE book_orders SET status = 'fulfilled', fulfillment_type = 'courier',
             courier_provider = ?, courier_tracking_no = ?, courier_charge = ?,
             delivery_address = ?, courier_dispatched_at = CURRENT_TIMESTAMP, fulfilled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [provider || null, trackingNo, charge, address || null, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (!this.changes) return res.status(404).json({ error: 'Order not found' });
                fetchBookOrderFull(db, id, (e2, order) => res.json({ success: true, order }));
            }
        );
    });

    // Admin: Update courier tracking number
    app.post('/api/admin/book-sales/orders/:id/update-tracking', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const trackingNo = String((req.body && req.body.trackingNo) || '').trim();
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
        db.run(
            `UPDATE book_orders SET courier_tracking_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [trackingNo || null, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    });

    // Admin: Book POS — create order for walk-in buyer
    app.post('/api/admin/book-sales/pos', (req, res) => {
        const body = req.body || {};
        const buyerName = String(body.buyerName || '').trim();
        const buyerPhone = String(body.buyerPhone || '').trim();
        const adminId = safeInternalUserRowId(body.actingAdminId);
        if (!buyerName && !buyerPhone) return res.status(400).json({ error: 'Buyer name or phone required' });
        loadBookSalesConfig(db, (err, config) => {
            if (err) return res.status(500).json({ error: err.message });
            const validated = validateLineItems(config, body.items);
            if (validated.error) return res.status(400).json({ error: validated.error });
            const orderCode = genBookOrderString();
            const total = validated.total;
            const paymentMode = String(body.paymentMode || 'cash').toLowerCase();
            const initialStatus = 'confirmed'; // POS orders are immediately confirmed
            const qr = JSON.stringify({ type: 'book_order', orderCode, buyerName, buyerPhone });
            db.run(
                `INSERT INTO book_orders (order_code, user_id, seminar_id, status, payment_mode, total_amount,
                 buyer_name, buyer_phone, qr_code_data, admin_confirmed_by, admin_confirmed_at, updated_at)
                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [orderCode, config.seminarId, initialStatus, paymentMode, total,
                 buyerName || null, buyerPhone || null, qr, adminId || null],
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
                                if (!left) fetchBookOrderFull(db, bookOrderId, (e3, order) =>
                                    res.json({ success: true, order, orderCode, qr }));
                            }
                        );
                    });
                }
            );
        });
    });

    // Admin: Book POS search by phone/name
    app.get('/api/admin/book-sales/pos-search', (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json([]);
        const like = '%' + q + '%';
        db.all(
            `SELECT id, first_name, last_name, email, phone, user_id_string FROM users
             WHERE (phone LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)
             LIMIT 10`,
            [like, like, like, like],
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
        lookupBookOrderFromQr(qrData, (err, bookOrderId) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!bookOrderId) {
                return res.status(404).json({ success: false, outcome: 'not_found', message: 'Not a book order QR' });
            }
            fetchOrderWithCheckinStatus(db, bookOrderId, (e2, result) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!result.order) return res.status(404).json({ success: false, outcome: 'not_found', message: 'Order not found' });
                const order = result.order;
                if (order.status === 'fulfilled') {
                    return res.status(400).json({
                        success: false,
                        outcome: 'duplicate',
                        message: 'Already collected',
                        order,
                        checkedIn: result.checkedIn
                    });
                }
                if (order.status !== 'confirmed') {
                    return res.status(403).json({
                        success: false,
                        outcome: 'not_ready',
                        message: 'Order is ' + order.status + ' — not ready for pickup',
                        order,
                        checkedIn: result.checkedIn
                    });
                }
                fulfillBookOrderFromScan(db, bookOrderId, scannerUserId, (e3, fulfillResult) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    const uid = order.userId;
                    if (!uid) {
                        return res.json({
                            ...fulfillResult,
                            checkedIn: result.checkedIn,
                            doctor: { name: order.buyerName, phone: order.buyerPhone }
                        });
                    }
                    db.get(
                        `SELECT first_name, last_name, email, phone, user_id_string FROM users WHERE id = ?`,
                        [uid],
                        (e4, u) => {
                            res.json({
                                ...fulfillResult,
                                checkedIn: result.checkedIn,
                                seminarStatus: result.seminarStatus,
                                doctor: u || {}
                            });
                        }
                    );
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
            res.json({ order });
        });
    });

    // Admin: Get single order
    app.get('/api/admin/book-sales/orders/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
        fetchBookOrderFull(db, id, (err, order) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!order) return res.status(404).json({ error: 'Not found' });
            res.json({ order });
        });
    });

    app.get('/api/public/book-sales/courier-providers', (req, res) => {
        res.json(COURIER_PROVIDERS);
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

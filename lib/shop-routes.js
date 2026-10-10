/**
 * Private book shop at /shop. Same portal accounts. Not linked from the public site or doctor portal.
 */
const commerce = require('./commerce-logistics');
const commerceRoutes = require('./commerce-routes');
const bookSales = require('./book-sales');

const LANGUAGES = ['english', 'marathi', 'hindi', 'kannada'];

function isPg() {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function ensureShopSchema(db, cb) {
    const sql = isPg()
        ? `CREATE TABLE IF NOT EXISTS shop_addresses (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            recipient_name TEXT,
            phone TEXT,
            line1 TEXT,
            city TEXT,
            state TEXT,
            pincode TEXT,
            is_default INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`
        : `CREATE TABLE IF NOT EXISTS shop_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            recipient_name TEXT,
            phone TEXT,
            line1 TEXT,
            city TEXT,
            state TEXT,
            pincode TEXT,
            is_default INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`;
    db.run(sql, () => commerceRoutes.ensureCommerceSchema(db, cb));
}

function shopClosedMessage(shop) {
    return 'The shop takes orders between ' + shop.orderOpen + ' and ' + shop.orderClose + ' IST.';
}

function mapAddress(row) {
    if (!row) return null;
    return {
        id: row.id,
        recipientName: row.recipient_name,
        phone: row.phone,
        line1: row.line1,
        city: row.city,
        state: row.state,
        pincode: row.pincode,
        isDefault: !!row.is_default
    };
}

function registerShopRoutes(app, db, deps) {
    const listDoctorPaymentOptions = deps && deps.listDoctorPaymentOptions;
    const parsePositiveUserId = deps && deps.parsePositiveUserId;

    app.get('/shop', (req, res) => {
        res.sendFile(require('path').join(__dirname, '..', 'public', 'shop.html'));
    });

    app.get('/api/shop/catalog', (req, res) => {
        ensureShopSchema(db, () => {
            commerceRoutes.loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                bookSales.loadBookSalesConfig(db, (e2, sales) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const open = commerce.withinIstWindow(cfg.shop.orderOpen, cfg.shop.orderClose);
                    res.json({
                        shopPath: '/shop',
                        open,
                        closedMessage: open ? '' : shopClosedMessage(cfg.shop),
                        store: {
                            name: cfg.storeName,
                            phone: cfg.storePhone,
                            address: cfg.storeAddress,
                            city: cfg.storeCity
                        },
                        settings: cfg.shop,
                        books: (sales.books || []).filter((b) => b.active !== false && Number(b.price) > 0),
                        languages: LANGUAGES
                    });
                });
            });
        });
    });

    app.get('/api/shop/pay-options', (req, res) => {
        if (typeof listDoctorPaymentOptions !== 'function') return res.json({ razorpay: null });
        listDoctorPaymentOptions((err, options) => {
            if (err) return res.status(500).json({ error: err.message });
            const hit = (options || []).find((o) => String(o.gateway || o.id || '').indexOf('razorpay') === 0 || String(o.id || '').indexOf('razorpay') === 0);
            res.json({ razorpay: hit ? { id: hit.id, label: hit.label || 'Razorpay' } : null });
        });
    });

    function uidOf(req) {
        const raw = (req.body && req.body.userId) || req.query.userId || (req.headers && req.headers['x-acting-user-id']);
        const id = parsePositiveUserId ? parsePositiveUserId(raw) : parseInt(raw, 10);
        return Number.isInteger(id) && id > 0 ? id : null;
    }

    app.get('/api/shop/addresses', (req, res) => {
        const uid = uidOf(req);
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        ensureShopSchema(db, () => {
            db.all(`SELECT * FROM shop_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC`, [uid], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ addresses: (rows || []).map(mapAddress) });
            });
        });
    });

    app.post('/api/shop/addresses', (req, res) => {
        const uid = uidOf(req);
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        const b = req.body || {};
        const name = String(b.recipientName || '').trim();
        const phone = String(b.phone || '').trim();
        const line1 = String(b.line1 || '').trim();
        if (!name || !phone || !line1) return res.status(400).json({ error: 'Name, phone, and address are required.' });
        ensureShopSchema(db, () => {
            db.run(
                `INSERT INTO shop_addresses (user_id, recipient_name, phone, line1, city, state, pincode, is_default)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uid,
                    name,
                    phone,
                    line1,
                    String(b.city || '').trim(),
                    String(b.state || '').trim(),
                    String(b.pincode || '').replace(/\D/g, '').slice(0, 6),
                    b.isDefault ? 1 : 0
                ],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, id: this.lastID });
                }
            );
        });
    });

    app.get('/api/shop/orders', (req, res) => {
        const uid = uidOf(req);
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        ensureShopSchema(db, () => {
            db.all(
                `SELECT * FROM book_orders WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
                [uid],
                (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ orders: (rows || []).map((row) => commerce.mapCommerceRow(row, [])) });
                }
            );
        });
    });

    app.get('/api/shop/orders/:id', (req, res) => {
        const uid = uidOf(req);
        const id = parseInt(req.params.id, 10);
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        db.get(`SELECT * FROM book_orders WHERE id = ? AND user_id = ?`, [id, uid], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Order not found' });
            db.all(`SELECT * FROM book_order_items WHERE book_order_id = ?`, [id], (e2, items) => {
                db.all(
                    `SELECT description AS title, location AS detail, event_city AS city, facility AS kind, event_at AS at, source
                     FROM book_courier_track_events WHERE book_order_id = ? ORDER BY event_at ASC, id ASC`,
                    [id],
                    (e3, events) => {
                        const order = commerce.mapCommerceRow(row, items || []);
                        const all = events || [];
                        res.json({
                            order,
                            events: all.filter((ev) => ev.source !== 'commerce_return'),
                            returnEvents: all.filter((ev) => ev.source === 'commerce_return')
                        });
                    }
                );
            });
        });
    });

    app.post('/api/shop/orders', (req, res) => {
        const uid = uidOf(req);
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        const body = req.body || {};
        const method = String(body.method || '').toLowerCase();
        const fulfillment = String(body.fulfillment || 'delivery').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
        ensureShopSchema(db, () => {
            commerceRoutes.loadConfig(db, (err, raw, cfg) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!cfg.shop.enabled) return res.status(403).json({ error: 'The shop is closed.' });
                if (!commerce.withinIstWindow(cfg.shop.orderOpen, cfg.shop.orderClose)) {
                    return res.status(403).json({ error: shopClosedMessage(cfg.shop) });
                }
                if (fulfillment === 'delivery' && !cfg.shop.deliveryEnabled) {
                    return res.status(400).json({ error: 'Home delivery is turned off.' });
                }
                if (fulfillment === 'pickup' && !cfg.shop.storePickupEnabled) {
                    return res.status(400).json({ error: 'Store pickup is turned off.' });
                }
                if (method === 'cod' && (!cfg.shop.codEnabled || fulfillment !== 'delivery')) {
                    return res.status(400).json({ error: 'Cash on delivery is not available for this order.' });
                }
                if (method === 'razorpay' && !cfg.shop.razorpayEnabled) {
                    return res.status(400).json({ error: 'Online payment is turned off.' });
                }
                if (method === 'store' && fulfillment !== 'pickup') {
                    return res.status(400).json({ error: 'Pay at the store is only for store pickup.' });
                }
                bookSales.loadBookSalesConfig(db, (e2, sales) => {
                    if (e2) return res.status(500).json({ error: e2.message });
                    const validated = bookSales.validateLineItems
                        ? bookSales.validateLineItems(sales, body.items)
                        : { error: 'Book catalog is not available.' };
                    if (validated.error) return res.status(400).json({ error: validated.error });
                    const addressId = parseInt(body.addressId, 10);
                    const useAddress = (next) => {
                        if (fulfillment !== 'delivery') return next(null, null);
                        if (!Number.isInteger(addressId)) return res.status(400).json({ error: 'Choose a delivery address.' });
                        db.get(`SELECT * FROM shop_addresses WHERE id = ? AND user_id = ?`, [addressId, uid], (aErr, addr) => {
                            if (aErr) return res.status(500).json({ error: aErr.message });
                            if (!addr) return res.status(400).json({ error: 'Address not found.' });
                            next(null, addr);
                        });
                    };
                    useAddress((aErr, addr) => {
                        if (aErr) return;
                        const codExtra = method === 'cod' ? Number(cfg.shop.codExtraCharge) || 0 : 0;
                        const total = Math.round((validated.total + codExtra) * 100) / 100;
                        const online = method === 'razorpay';
                        const orderCode = 'BK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
                        const token = commerce.generateToken();
                        const status = online ? 'pending_payment' : 'confirmed';
                        const paymentMode = method === 'cod' ? 'cod' : method === 'store' ? 'counter' : 'online';
                        db.get(`SELECT first_name, last_name, phone, email FROM users WHERE id = ?`, [uid], (uErr, user) => {
                            const buyer = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : '';
                            db.run(
                                `INSERT INTO book_orders (
                                    order_code, user_id, status, payment_mode, total_amount, fulfillment_type,
                                    buyer_name, buyer_phone, shipping_recipient_name, shipping_phone,
                                    delivery_address, shipping_city, shipping_state, shipping_pincode,
                                    commerce_mode, commerce_stage, tracking_token, order_channel, notes, updated_at
                                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', ?, 'shop', 'Private shop order', CURRENT_TIMESTAMP)`,
                                [
                                    orderCode,
                                    uid,
                                    status,
                                    paymentMode,
                                    total,
                                    fulfillment === 'pickup' ? 'pickup' : 'courier',
                                    buyer || (addr && addr.recipient_name) || null,
                                    (user && user.phone) || (addr && addr.phone) || null,
                                    (addr && addr.recipient_name) || buyer || null,
                                    (addr && addr.phone) || (user && user.phone) || null,
                                    addr ? addr.line1 : cfg.storeAddress,
                                    addr ? addr.city : cfg.storeCity,
                                    addr ? addr.state : null,
                                    addr ? addr.pincode : null,
                                    fulfillment === 'pickup' ? 'hyperlocal' : cfg.defaultMode,
                                    token
                                ],
                                function (insErr) {
                                    if (insErr) return res.status(500).json({ error: insErr.message });
                                    const bookOrderId = this.lastID;
                                    let left = validated.lines.length;
                                    const after = () => {
                                        if (!online) {
                                            return res.json({
                                                success: true,
                                                bookOrderId,
                                                orderCode,
                                                needsPayment: false,
                                                commerceTrackUrl: '/track-commerce?token=' + encodeURIComponent(token)
                                            });
                                        }
                                        const orderStr = 'BKP' + Date.now().toString(36).toUpperCase();
                                        db.run(
                                            `INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, 'pending')`,
                                            [orderStr, total],
                                            function (oErr) {
                                                if (oErr) return res.status(500).json({ error: oErr.message });
                                                const orderDbId = this.lastID;
                                                db.run(`UPDATE book_orders SET order_id = ? WHERE id = ?`, [orderDbId, bookOrderId], () => {
                                                    res.json({
                                                        success: true,
                                                        bookOrderId,
                                                        orderCode,
                                                        orderDbId,
                                                        needsPayment: true,
                                                        amount: total,
                                                        commerceTrackUrl: '/track-commerce?token=' + encodeURIComponent(token)
                                                    });
                                                });
                                            }
                                        );
                                    };
                                    validated.lines.forEach((line) => {
                                        db.run(
                                            `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
                                            [bookOrderId, line.bookId, line.language, line.qty, line.unitPrice, line.lineTotal],
                                            () => {
                                                left--;
                                                if (!left) after();
                                            }
                                        );
                                    });
                                }
                            );
                        });
                    });
                });
            });
        });
    });

    app.post('/api/shop/orders/:id/return', (req, res) => {
        const uid = uidOf(req);
        const id = parseInt(req.params.id, 10);
        const kind = String((req.body && req.body.kind) || 'return').toLowerCase() === 'replacement' ? 'replacement' : 'return';
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!uid) return res.status(401).json({ error: 'Sign in with your portal account.' });
        if (!reason) return res.status(400).json({ error: 'Tell us the reason for the return.' });
        commerceRoutes.loadConfig(db, (err, raw, cfg) => {
            if (err) return res.status(500).json({ error: err.message });
            if (kind === 'return' && !cfg.shop.returnsEnabled) return res.status(400).json({ error: 'Returns are turned off.' });
            if (kind === 'replacement' && !cfg.shop.replacementsEnabled) {
                return res.status(400).json({ error: 'Replacements are turned off.' });
            }
            db.get(`SELECT * FROM book_orders WHERE id = ? AND user_id = ?`, [id, uid], (e2, row) => {
                if (e2) return res.status(500).json({ error: e2.message });
                if (!row) return res.status(404).json({ error: 'Order not found' });
                if (row.return_status && row.return_status !== 'rejected') {
                    return res.status(400).json({ error: 'A return is already open for this order.' });
                }
                const ageMs = Date.now() - new Date(row.created_at).getTime();
                const windowMs = (Number(cfg.shop.returnWindowDays) || 7) * 24 * 60 * 60 * 1000;
                if (ageMs > windowMs) return res.status(400).json({ error: 'The return window for this order has ended.' });
                db.run(
                    `UPDATE book_orders SET return_kind = ?, return_status = 'requested', return_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [kind, reason, id],
                    (uerr) => {
                        if (uerr) return res.status(500).json({ error: uerr.message });
                        res.json({ success: true, returnStatus: 'requested', returnKind: kind });
                    }
                );
            });
        });
    });
}

module.exports = { registerShopRoutes };

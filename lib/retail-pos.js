/**
 * Retail POS — staff counter sales (/pos) and admin retail management:
 * gift cards, vouchers, loyalty points, store wallets, sales reports.
 * Orders are regular book_orders (order_channel = 'pos') so tracking, documents and notifications apply unchanged.
 */
const bookAuth = require('./book-sales-auth');
const bookInv = require('./book-sales-inventory');

const isPg = () => !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const pk = () => (isPg() ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT');
const SETTINGS_KEY = 'retail_pos_settings';

const DEFAULT_SETTINGS = {
    loyaltyEnabled: true,
    loyaltyEarnPerRupee: 0.01, // points earned per ₹1 spent (1 point / ₹100)
    loyaltyPointValue: 1, // ₹ per point on redemption
    loyaltyMinRedeem: 50,
    loyaltyMaxRedeemPct: 50,
    walletEnabled: true,
    giftCardsEnabled: true,
    giftCardDenominations: [500, 1000, 2000, 5000],
    giftCardValidityDays: 365,
    manualDiscountMaxPct: 10,
    staffManualDiscount: true,
    paymentModes: ['cash', 'upi', 'card', 'razorpay', 'wallet'],
    fulfillmentTypes: ['pickup', 'hyperlocal', 'courier'],
    hyperlocalCharge: 0,
    courierCharge: null, // null = use book-sales defaultCourierCharge
    receiptFooter: 'Thank you for shopping with us.'
};

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}
function code(prefix, len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = prefix || '';
    for (let i = 0; i < (len || 12); i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
function nowIso() {
    return new Date().toISOString();
}

function ensureRetailSchema(db, cb) {
    const stmts = [
        `CREATE TABLE IF NOT EXISTS retail_gift_cards (
            id ${pk()},
            code TEXT UNIQUE NOT NULL,
            initial_value REAL NOT NULL DEFAULT 0,
            balance REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            recipient_name TEXT,
            recipient_email TEXT,
            recipient_phone TEXT,
            user_id INTEGER,
            issued_by INTEGER,
            issued_order_id INTEGER,
            expires_at TEXT,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_gift_card_txns (
            id ${pk()},
            gift_card_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            kind TEXT NOT NULL,
            book_order_id INTEGER,
            actor_id INTEGER,
            note TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_vouchers (
            id ${pk()},
            code TEXT UNIQUE NOT NULL,
            title TEXT,
            kind TEXT NOT NULL DEFAULT 'percent',
            value REAL NOT NULL DEFAULT 0,
            min_order REAL DEFAULT 0,
            max_discount REAL,
            usage_limit INTEGER,
            used_count INTEGER DEFAULT 0,
            per_customer_limit INTEGER,
            starts_at TEXT,
            ends_at TEXT,
            channels TEXT DEFAULT 'pos,shop',
            active INTEGER DEFAULT 1,
            created_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_voucher_uses (
            id ${pk()},
            voucher_id INTEGER NOT NULL,
            book_order_id INTEGER,
            customer_key TEXT,
            amount REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_wallet_ledger (
            id ${pk()},
            customer_key TEXT NOT NULL,
            user_id INTEGER,
            amount REAL NOT NULL,
            kind TEXT NOT NULL,
            book_order_id INTEGER,
            actor_id INTEGER,
            note TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_loyalty_ledger (
            id ${pk()},
            customer_key TEXT NOT NULL,
            user_id INTEGER,
            points REAL NOT NULL,
            kind TEXT NOT NULL,
            book_order_id INTEGER,
            actor_id INTEGER,
            note TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_customers (
            customer_key TEXT PRIMARY KEY,
            user_id INTEGER,
            name TEXT,
            phone TEXT,
            email TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS retail_pos_sales (
            id ${pk()},
            book_order_id INTEGER NOT NULL,
            actor_id INTEGER,
            customer_key TEXT,
            subtotal REAL DEFAULT 0,
            discount_total REAL DEFAULT 0,
            voucher_code TEXT,
            voucher_discount REAL DEFAULT 0,
            manual_discount REAL DEFAULT 0,
            loyalty_points_used REAL DEFAULT 0,
            loyalty_discount REAL DEFAULT 0,
            loyalty_points_earned REAL DEFAULT 0,
            gift_card_code TEXT,
            gift_card_amount REAL DEFAULT 0,
            wallet_amount REAL DEFAULT 0,
            shipping_charge REAL DEFAULT 0,
            paid_amount REAL DEFAULT 0,
            payment_mode TEXT,
            fulfillment TEXT,
            mode TEXT DEFAULT 'staff',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`,
        `ALTER TABLE book_orders ADD COLUMN buyer_email TEXT`,
        isPg() ? `ALTER TABLE book_orders ALTER COLUMN user_id DROP NOT NULL` : `SELECT 1`
    ];
    let i = 0;
    const next = () => {
        if (i >= stmts.length) return cb && cb(null);
        const sql = stmts[i++];
        db.run(sql, [], () => next());
    };
    next();
}

function loadSettings(db, cb) {
    db.get(`SELECT value FROM global_settings WHERE key = ?`, [SETTINGS_KEY], (err, row) => {
        if (err) return cb(err);
        let parsed = {};
        try {
            parsed = row && row.value ? JSON.parse(row.value) : {};
        } catch (_) {
            parsed = {};
        }
        cb(null, Object.assign({}, DEFAULT_SETTINGS, parsed || {}));
    });
}

function customerKeyFor(c) {
    if (!c) return '';
    if (c.userId) return 'u:' + c.userId;
    const ph = String(c.phone || '').replace(/\D/g, '');
    if (ph) return 'p:' + ph.slice(-10);
    const em = String(c.email || '').trim().toLowerCase();
    if (em) return 'e:' + em;
    return '';
}

function sumLedger(db, table, col, key, cb) {
    if (!key) return cb(null, 0);
    db.get(`SELECT COALESCE(SUM(${col}),0) AS total FROM ${table} WHERE customer_key = ?`, [key], (err, row) => cb(err, round2(row ? row.total : 0)));
}
function walletBalance(db, key, cb) {
    sumLedger(db, 'retail_wallet_ledger', 'amount', key, cb);
}
function loyaltyBalance(db, key, cb) {
    sumLedger(db, 'retail_loyalty_ledger', 'points', key, cb);
}

function upsertCustomer(db, c, cb) {
    const key = customerKeyFor(c);
    if (!key) return cb && cb(null, '');
    db.get(`SELECT customer_key FROM retail_customers WHERE customer_key = ?`, [key], (err, row) => {
        if (err) return cb(err);
        const args = [c.userId || null, c.name || null, c.phone || null, c.email || null, key];
        const sql = row
            ? `UPDATE retail_customers SET user_id = COALESCE(?, user_id), name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP WHERE customer_key = ?`
            : `INSERT INTO retail_customers (user_id, name, phone, email, customer_key) VALUES (?, ?, ?, ?, ?)`;
        db.run(sql, args, () => cb && cb(null, key));
    });
}

function findCustomers(db, q, cb) {
    const like = '%' + String(q || '').trim().toLowerCase() + '%';
    const digits = String(q || '').replace(/\D/g, '');
    db.all(
        `SELECT id, user_id_string, first_name, last_name, email, phone FROM users
         WHERE (LOWER(COALESCE(email,'')) LIKE ? OR LOWER(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) LIKE ? OR LOWER(COALESCE(user_id_string,'')) LIKE ? ${digits ? 'OR COALESCE(phone,\'\') LIKE ?' : ''})
         ORDER BY id DESC LIMIT 8`,
        digits ? [like, like, like, '%' + digits + '%'] : [like, like, like],
        (err, users) => {
            if (err) return cb(err);
            db.all(
                `SELECT * FROM retail_customers WHERE user_id IS NULL AND (LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(email,'')) LIKE ? ${digits ? 'OR COALESCE(phone,\'\') LIKE ?' : ''}) ORDER BY updated_at DESC LIMIT 6`,
                digits ? [like, like, '%' + digits + '%'] : [like, like],
                (e2, walkins) => {
                    const list = (users || []).map((u) => ({
                        userId: u.id,
                        userIdString: u.user_id_string,
                        name: [u.first_name, u.last_name].filter(Boolean).join(' '),
                        email: u.email,
                        phone: u.phone,
                        account: true
                    }));
                    (walkins || []).forEach((w) => list.push({ userId: null, name: w.name, email: w.email, phone: w.phone, account: false }));
                    let left = list.length;
                    if (!left) return cb(null, []);
                    list.forEach((c) => {
                        const key = customerKeyFor(c);
                        c.customerKey = key;
                        walletBalance(db, key, (e3, w) => {
                            c.walletBalance = w || 0;
                            loyaltyBalance(db, key, (e4, p) => {
                                c.loyaltyPoints = p || 0;
                                if (--left === 0) cb(null, list);
                            });
                        });
                    });
                }
            );
        }
    );
}

function getGiftCard(db, codeStr, cb) {
    db.get(`SELECT * FROM retail_gift_cards WHERE UPPER(code) = ?`, [String(codeStr || '').trim().toUpperCase()], cb);
}
function giftCardUsable(gc) {
    if (!gc) return 'Gift card not found';
    if (gc.status !== 'active') return 'Gift card is ' + gc.status;
    if (gc.expires_at && new Date(gc.expires_at).getTime() < Date.now()) return 'Gift card expired';
    if (Number(gc.balance) <= 0) return 'Gift card has no balance';
    return '';
}

function getVoucher(db, codeStr, cb) {
    db.get(`SELECT * FROM retail_vouchers WHERE UPPER(code) = ?`, [String(codeStr || '').trim().toUpperCase()], cb);
}
function voucherDiscount(v, subtotal, channel, customerUses) {
    if (!v) return { error: 'Voucher not found' };
    if (!Number(v.active)) return { error: 'Voucher is inactive' };
    const now = Date.now();
    if (v.starts_at && new Date(v.starts_at).getTime() > now) return { error: 'Voucher not started yet' };
    if (v.ends_at && new Date(v.ends_at).getTime() < now) return { error: 'Voucher expired' };
    if (v.usage_limit != null && Number(v.used_count) >= Number(v.usage_limit)) return { error: 'Voucher usage limit reached' };
    if (v.per_customer_limit != null && customerUses >= Number(v.per_customer_limit)) return { error: 'Voucher already used by this customer' };
    const channels = String(v.channels || 'pos,shop').split(',').map((s) => s.trim());
    if (channel && !channels.includes(channel)) return { error: 'Voucher not valid for ' + channel };
    if (Number(v.min_order) > 0 && subtotal < Number(v.min_order)) return { error: 'Minimum order ₹' + v.min_order + ' for this voucher' };
    let d = v.kind === 'percent' ? (subtotal * Number(v.value)) / 100 : Number(v.value);
    if (v.max_discount != null && Number(v.max_discount) > 0) d = Math.min(d, Number(v.max_discount));
    d = Math.min(round2(d), subtotal);
    return { discount: d };
}

/**
 * Build a priced quote. Resolves voucher/gift-card/loyalty/wallet in order and returns the breakdown.
 */
function buildQuote(db, deps, body, actor, cb) {
    const bookSales = deps.bookSales;
    bookSales.loadBookSalesConfig(db, (err, config) => {
        if (err) return cb(err);
        loadSettings(db, (sErr, settings) => {
            if (sErr) return cb(sErr);
            const validated = bookSales.validateLineItems(config, body.items);
            if (validated.error) return cb(null, { error: validated.error });
            const subtotal = validated.total;
            const customer = body.customer || {};
            const key = customerKeyFor(customer);
            const fulfillment = ['pickup', 'hyperlocal', 'courier'].includes(body.fulfillment) ? body.fulfillment : 'pickup';
            if (!settings.fulfillmentTypes.includes(fulfillment)) return cb(null, { error: 'Fulfilment type disabled: ' + fulfillment });
            let shipping = 0;
            if (fulfillment === 'hyperlocal') shipping = round2(settings.hyperlocalCharge || 0);
            if (fulfillment === 'courier') shipping = round2(settings.courierCharge != null ? settings.courierCharge : config.defaultCourierCharge || 0);
            if (body.shippingOverride != null && body.shippingOverride !== '' && Number.isFinite(Number(body.shippingOverride))) shipping = round2(body.shippingOverride);
            const out = {
                lines: validated.lines,
                subtotal,
                fulfillment,
                shipping,
                manualDiscount: 0,
                voucher: null,
                voucherDiscount: 0,
                loyaltyPointsUsed: 0,
                loyaltyDiscount: 0,
                loyaltyPointsEarned: 0,
                giftCard: null,
                giftCardAmount: 0,
                walletAmount: 0,
                walletBalance: 0,
                loyaltyBalance: 0,
                customerKey: key,
                warnings: []
            };
            // manual discount
            const md = Number(body.manualDiscount) || 0;
            if (md > 0) {
                const maxPct = actor && actor.isAdmin ? 100 : Number(settings.manualDiscountMaxPct) || 0;
                if (!settings.staffManualDiscount && !(actor && actor.isAdmin)) return cb(null, { error: 'Manual discounts are disabled for staff' });
                const cap = round2((subtotal * maxPct) / 100);
                out.manualDiscount = Math.min(round2(md), cap, subtotal);
                if (out.manualDiscount < md) out.warnings.push('Manual discount capped at ' + maxPct + '% (₹' + cap + ')');
            }
            const afterManual = round2(subtotal - out.manualDiscount);
            const stepVoucher = (next) => {
                if (!body.voucherCode) return next();
                getVoucher(db, body.voucherCode, (vErr, v) => {
                    if (vErr || !v) {
                        out.warnings.push('Voucher not found');
                        return next();
                    }
                    const countUses = (cbU) => {
                        if (!key) return cbU(0);
                        db.get(`SELECT COUNT(*) AS n FROM retail_voucher_uses WHERE voucher_id = ? AND customer_key = ?`, [v.id, key], (e, r) => cbU(r ? Number(r.n) : 0));
                    };
                    countUses((uses) => {
                        const r = voucherDiscount(v, afterManual, 'pos', uses);
                        if (r.error) out.warnings.push(r.error);
                        else {
                            out.voucher = { code: v.code, title: v.title, kind: v.kind, value: v.value, id: v.id };
                            out.voucherDiscount = r.discount;
                        }
                        next();
                    });
                });
            };
            const stepLoyalty = (next) => {
                loyaltyBalance(db, key, (lErr, pts) => {
                    out.loyaltyBalance = pts || 0;
                    const want = Number(body.loyaltyPoints) || 0;
                    const base = round2(afterManual - out.voucherDiscount);
                    if (settings.loyaltyEnabled && want > 0 && key) {
                        if (want < Number(settings.loyaltyMinRedeem)) out.warnings.push('Minimum ' + settings.loyaltyMinRedeem + ' points to redeem');
                        else {
                            const maxPts = Math.floor(Math.min(pts, (base * (Number(settings.loyaltyMaxRedeemPct) || 100)) / 100 / (Number(settings.loyaltyPointValue) || 1)));
                            out.loyaltyPointsUsed = Math.min(Math.floor(want), maxPts);
                            out.loyaltyDiscount = round2(out.loyaltyPointsUsed * (Number(settings.loyaltyPointValue) || 1));
                            if (out.loyaltyPointsUsed < want) out.warnings.push('Only ' + out.loyaltyPointsUsed + ' points can be redeemed on this bill');
                        }
                    }
                    next();
                });
            };
            const stepGift = (next) => {
                if (!body.giftCardCode) return next();
                getGiftCard(db, body.giftCardCode, (gErr, gc) => {
                    const problem = gErr ? gErr.message : giftCardUsable(gc);
                    if (problem) {
                        out.warnings.push(problem);
                        return next();
                    }
                    const payable = round2(afterManual - out.voucherDiscount - out.loyaltyDiscount + out.shipping);
                    const want = body.giftCardAmount != null && body.giftCardAmount !== '' ? Number(body.giftCardAmount) : Number(gc.balance);
                    out.giftCard = { code: gc.code, balance: round2(gc.balance), id: gc.id };
                    out.giftCardAmount = Math.max(0, Math.min(round2(want), round2(gc.balance), payable));
                    next();
                });
            };
            const stepWallet = (next) => {
                walletBalance(db, key, (wErr, bal) => {
                    out.walletBalance = bal || 0;
                    const payable = round2(afterManual - out.voucherDiscount - out.loyaltyDiscount + out.shipping - out.giftCardAmount);
                    const want = Number(body.walletAmount) || 0;
                    if (settings.walletEnabled && want > 0 && key) {
                        out.walletAmount = Math.max(0, Math.min(round2(want), bal, payable));
                        if (out.walletAmount < want) out.warnings.push('Wallet covers ₹' + out.walletAmount);
                    }
                    next();
                });
            };
            stepVoucher(() =>
                stepLoyalty(() =>
                    stepGift(() =>
                        stepWallet(() => {
                            out.discountTotal = round2(out.manualDiscount + out.voucherDiscount + out.loyaltyDiscount);
                            out.goodsTotal = round2(subtotal - out.discountTotal);
                            out.grandTotal = round2(out.goodsTotal + out.shipping);
                            out.prepaid = round2(out.giftCardAmount + out.walletAmount);
                            out.dueAmount = round2(out.grandTotal - out.prepaid);
                            if (settings.loyaltyEnabled && key) out.loyaltyPointsEarned = Math.floor(out.goodsTotal * (Number(settings.loyaltyEarnPerRupee) || 0));
                            out.settings = {
                                paymentModes: settings.paymentModes,
                                fulfillmentTypes: settings.fulfillmentTypes,
                                loyaltyPointValue: settings.loyaltyPointValue,
                                loyaltyMinRedeem: settings.loyaltyMinRedeem
                            };
                            cb(null, out);
                        })
                    )
                )
            );
        });
    });
}

function sendDirectEmail(db, deps, { to, subject, html, eventKey }, cb) {
    const ne = deps.notifEngine;
    if (!to || !ne || typeof ne.enqueueDirectMessage !== 'function') return cb && cb();
    ne.enqueueDirectMessage(db, { channel: 'email', destination: to, subject, html, event_key: eventKey || 'RETAIL_POS', immediate: true }, () => cb && cb());
}

function issueGiftCard(db, deps, { value, recipient, actorId, orderId, notes, validityDays }, cb) {
    loadSettings(db, (sErr, settings) => {
        const v = round2(value);
        if (!(v > 0)) return cb(new Error('Gift card value must be above 0'));
        const days = Number(validityDays) || Number(settings.giftCardValidityDays) || 365;
        const expires = new Date(Date.now() + days * 86400000).toISOString();
        const gcCode = code('GC-', 10);
        db.run(
            `INSERT INTO retail_gift_cards (code, initial_value, balance, status, recipient_name, recipient_email, recipient_phone, user_id, issued_by, issued_order_id, expires_at, notes)
             VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [gcCode, v, v, (recipient && recipient.name) || null, (recipient && recipient.email) || null, (recipient && recipient.phone) || null, (recipient && recipient.userId) || null, actorId || null, orderId || null, expires, notes || null],
            function (err) {
                if (err) return cb(err);
                const id = this.lastID;
                db.run(`INSERT INTO retail_gift_card_txns (gift_card_id, amount, kind, book_order_id, actor_id, note) VALUES (?, ?, 'issue', ?, ?, ?)`, [id, v, orderId || null, actorId || null, notes || null], () => {
                    const card = { id, code: gcCode, value: v, balance: v, expiresAt: expires, recipient };
                    const html =
                        '<p>Dear ' + (recipient && recipient.name ? recipient.name : 'Customer') + ',</p><p>A gift card worth <strong>₹' + v.toFixed(2) + '</strong> has been issued to you.</p>' +
                        '<p style="font-size:22px;letter-spacing:2px;font-weight:700;">' + gcCode + '</p><p>Valid till ' + new Date(expires).toLocaleDateString('en-IN') + '. Present this code at the counter or enter it at checkout.</p>';
                    sendDirectEmail(db, deps, { to: recipient && recipient.email, subject: 'Your gift card ' + gcCode, html, eventKey: 'RETAIL_GIFT_CARD_ISSUED' }, () => cb(null, card));
                });
            }
        );
    });
}

function walletCredit(db, deps, { customer, amount, kind, actorId, note, orderId }, cb) {
    const key = customerKeyFor(customer);
    if (!key) return cb(new Error('Customer phone, email or account required for wallet'));
    const amt = round2(amount);
    if (!amt) return cb(new Error('Amount required'));
    upsertCustomer(db, customer, () => {
        db.run(`INSERT INTO retail_wallet_ledger (customer_key, user_id, amount, kind, book_order_id, actor_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)`, [key, customer.userId || null, amt, kind || (amt > 0 ? 'topup' : 'debit'), orderId || null, actorId || null, note || null], (err) => {
            if (err) return cb(err);
            walletBalance(db, key, (e2, bal) => {
                if (amt > 0 && customer.email) {
                    const html = '<p>Dear ' + (customer.name || 'Customer') + ',</p><p>₹' + amt.toFixed(2) + ' was added to your store wallet. New balance: <strong>₹' + Number(bal).toFixed(2) + '</strong>.</p>';
                    return sendDirectEmail(db, deps, { to: customer.email, subject: 'Wallet credited ₹' + amt.toFixed(2), html, eventKey: 'RETAIL_WALLET_CREDIT' }, () => cb(null, { balance: bal }));
                }
                cb(null, { balance: bal });
            });
        });
    });
}

function loyaltyAdjust(db, { customer, points, kind, actorId, note, orderId }, cb) {
    const key = customerKeyFor(customer);
    if (!key) return cb(new Error('Customer required for loyalty'));
    const pts = Math.round(Number(points) || 0);
    if (!pts) return cb(null, null);
    upsertCustomer(db, customer, () => {
        db.run(`INSERT INTO retail_loyalty_ledger (customer_key, user_id, points, kind, book_order_id, actor_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)`, [key, customer.userId || null, pts, kind || (pts > 0 ? 'earn' : 'redeem'), orderId || null, actorId || null, note || null], (err) => {
            if (err) return cb(err);
            loyaltyBalance(db, key, (e2, bal) => cb(null, { balance: bal }));
        });
    });
}

/** Create the order from a quote and record redemptions. */
function checkout(db, deps, body, actor, cb) {
    const bookSales = deps.bookSales;
    const commerceRoutes = deps.commerceRoutes;
    buildQuote(db, deps, body, actor, (qErr, quote) => {
        if (qErr) return cb(qErr);
        if (quote.error) return cb(null, { error: quote.error });
        const customer = body.customer || {};
        const name = String(customer.name || '').trim();
        const phone = String(customer.phone || '').trim();
        const email = String(customer.email || '').trim().toLowerCase();
        const userId = customer.userId ? Number(customer.userId) : null;
        if (!name && !phone && !userId) return cb(null, { error: 'Customer name or phone is required' });
        const paymentMode = String(body.paymentMode || 'cash').toLowerCase();
        loadSettings(db, (sErr, settings) => {
            if (!settings.paymentModes.includes(paymentMode) && quote.dueAmount > 0) return cb(null, { error: 'Payment mode not enabled: ' + paymentMode });
            if (paymentMode === 'wallet' && quote.dueAmount > 0) return cb(null, { error: 'Wallet balance does not cover the bill; add another payment mode for the remainder' });
            if (quote.fulfillment !== 'pickup') {
                const addr = body.address || {};
                if (!String(addr.line1 || '').trim() || !String(addr.pincode || '').trim()) return cb(null, { error: 'Delivery address and pincode are required for ' + quote.fulfillment });
            }
            bookInv.checkLinesStock(db, quote.lines, (stErr, stock) => {
                if (stErr) return cb(stErr);
                if (stock && !stock.ok) {
                    const msg = (stock.shortages || []).map((s) => (s.bookId || '') + ' (' + (s.language || '') + '): only ' + (s.available ?? 0) + ' left').join('; ');
                    return cb(null, { error: 'Not enough stock. ' + msg });
                }
                commerceRoutes.loadConfig(db, (cErr, raw, cfg) => {
                    const online = paymentMode === 'razorpay' && quote.dueAmount > 0;
                    const status = online ? 'pending_payment' : 'confirmed';
                    const orderCode = bookSales.genBookOrderString();
                    const token = deps.commerce.generateToken();
                    const addr = body.address || {};
                    const fulfillmentType = quote.fulfillment === 'pickup' ? 'pickup' : 'courier';
                    const commerceMode = quote.fulfillment === 'courier' ? (cfg && cfg.defaultMode) || 'logistics' : 'hyperlocal';
                    const pm = quote.dueAmount <= 0 ? (quote.walletAmount > 0 ? 'wallet' : 'gift_card') : paymentMode === 'razorpay' ? 'online' : paymentMode;
                    const notes = ['POS sale by ' + (actor.name || 'staff')];
                    if (quote.voucher) notes.push('Voucher ' + quote.voucher.code + ' −₹' + quote.voucherDiscount);
                    if (quote.manualDiscount) notes.push('Discount −₹' + quote.manualDiscount);
                    if (quote.loyaltyPointsUsed) notes.push(quote.loyaltyPointsUsed + ' points −₹' + quote.loyaltyDiscount);
                    if (quote.giftCardAmount) notes.push('Gift card ' + quote.giftCard.code + ' ₹' + quote.giftCardAmount);
                    if (quote.walletAmount) notes.push('Wallet ₹' + quote.walletAmount);
                    if (body.note) notes.push(String(body.note).slice(0, 300));
                    db.run(
                        `INSERT INTO book_orders (
                            order_code, user_id, seminar_id, status, payment_mode, total_amount, fulfillment_type, courier_charge,
                            buyer_name, buyer_phone, buyer_email, shipping_recipient_name, shipping_phone,
                            delivery_address, shipping_city, shipping_state, shipping_pincode,
                            commerce_mode, commerce_stage, tracking_token, order_channel, notes,
                            admin_confirmed_by, admin_confirmed_at, qr_code_data, updated_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', ?, 'pos', ?, ?, ?, '{}', CURRENT_TIMESTAMP)`,
                        [
                            orderCode,
                            userId,
                            null,
                            status,
                            pm,
                            quote.grandTotal,
                            fulfillmentType,
                            quote.shipping,
                            name || null,
                            phone || null,
                            email || null,
                            String(addr.recipient || name || '').trim() || null,
                            String(addr.phone || phone || '').trim() || null,
                            quote.fulfillment === 'pickup' ? (cfg && cfg.storeAddress) || null : String(addr.line1 || '').trim(),
                            quote.fulfillment === 'pickup' ? (cfg && cfg.storeCity) || null : String(addr.city || '').trim() || null,
                            quote.fulfillment === 'pickup' ? null : String(addr.state || '').trim() || null,
                            quote.fulfillment === 'pickup' ? null : String(addr.pincode || '').trim() || null,
                            commerceMode,
                            token,
                            notes.join(' · '),
                            online ? null : actor.id || null,
                            online ? null : nowIso()
                        ],
                        function (insErr) {
                            if (insErr) return cb(insErr);
                            const orderId = this.lastID;
                            let left = quote.lines.length;
                            quote.lines.forEach((line) => {
                                db.run(
                                    `INSERT INTO book_order_items (book_order_id, book_id, language, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
                                    [orderId, line.bookId, line.language, line.qty, line.unitPrice, line.lineTotal],
                                    () => {
                                        if (--left === 0) afterItems();
                                    }
                                );
                            });
                            const afterItems = () => {
                                const cust = { userId, name, phone, email };
                                const key = quote.customerKey;
                                upsertCustomer(db, cust, () => {
                                    const tasks = [];
                                    if (quote.voucher) {
                                        tasks.push((n) =>
                                            db.run(`UPDATE retail_vouchers SET used_count = COALESCE(used_count,0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [quote.voucher.id], () =>
                                                db.run(`INSERT INTO retail_voucher_uses (voucher_id, book_order_id, customer_key, amount) VALUES (?, ?, ?, ?)`, [quote.voucher.id, orderId, key || null, quote.voucherDiscount], () => n())
                                            )
                                        );
                                    }
                                    if (quote.giftCardAmount > 0) {
                                        tasks.push((n) =>
                                            db.run(`UPDATE retail_gift_cards SET balance = balance - ?, status = CASE WHEN balance - ? <= 0 THEN 'used' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [quote.giftCardAmount, quote.giftCardAmount, quote.giftCard.id], () =>
                                                db.run(`INSERT INTO retail_gift_card_txns (gift_card_id, amount, kind, book_order_id, actor_id) VALUES (?, ?, 'redeem', ?, ?)`, [quote.giftCard.id, -quote.giftCardAmount, orderId, actor.id || null], () => n())
                                            )
                                        );
                                    }
                                    if (quote.walletAmount > 0) tasks.push((n) => walletCredit(db, deps, { customer: cust, amount: -quote.walletAmount, kind: 'purchase', actorId: actor.id, orderId, note: 'Order ' + orderCode }, () => n()));
                                    if (quote.loyaltyPointsUsed > 0) tasks.push((n) => loyaltyAdjust(db, { customer: cust, points: -quote.loyaltyPointsUsed, kind: 'redeem', actorId: actor.id, orderId, note: 'Order ' + orderCode }, () => n()));
                                    if (!online && quote.loyaltyPointsEarned > 0) tasks.push((n) => loyaltyAdjust(db, { customer: cust, points: quote.loyaltyPointsEarned, kind: 'earn', actorId: actor.id, orderId, note: 'Order ' + orderCode }, () => n()));
                                    tasks.push((n) =>
                                        db.run(
                                            `INSERT INTO retail_pos_sales (book_order_id, actor_id, customer_key, subtotal, discount_total, voucher_code, voucher_discount, manual_discount, loyalty_points_used, loyalty_discount, loyalty_points_earned, gift_card_code, gift_card_amount, wallet_amount, shipping_charge, paid_amount, payment_mode, fulfillment, mode)
                                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                            [orderId, actor.id || null, key || null, quote.subtotal, quote.discountTotal, quote.voucher ? quote.voucher.code : null, quote.voucherDiscount, quote.manualDiscount, quote.loyaltyPointsUsed, quote.loyaltyDiscount, online ? 0 : quote.loyaltyPointsEarned, quote.giftCard ? quote.giftCard.code : null, quote.giftCardAmount, quote.walletAmount, quote.shipping, quote.dueAmount, pm, quote.fulfillment, actor.isAdmin ? 'admin' : 'staff'],
                                            () => n()
                                        )
                                    );
                                    const run = (i) => (i >= tasks.length ? done() : tasks[i](() => run(i + 1)));
                                    const done = () => {
                                        const qr = JSON.stringify({ type: 'book_order', bookOrderId: orderId, orderCode, userId });
                                        db.run(`UPDATE book_orders SET qr_code_data = ? WHERE id = ?`, [qr, orderId], () => {
                                            commerceRoutes.stampPlacement(db, orderId, () => {
                                                const finish = () =>
                                                    bookSales.fetchBookOrderFull(db, orderId, (fErr, order) => {
                                                        cb(null, {
                                                            success: true,
                                                            order,
                                                            orderId,
                                                            orderCode,
                                                            quote,
                                                            needsPayment: online,
                                                            amountDue: quote.dueAmount,
                                                            trackUrl: '/track-commerce?token=' + encodeURIComponent(token)
                                                        });
                                                    });
                                                if (online) {
                                                    const orderStr = 'BKP' + Date.now().toString(36).toUpperCase();
                                                    return db.run(`INSERT INTO orders (order_id_string, registration_id, amount, status) VALUES (?, NULL, ?, 'pending')`, [orderStr, quote.dueAmount], function (oErr) {
                                                        if (oErr) return cb(oErr);
                                                        db.run(`UPDATE book_orders SET order_id = ? WHERE id = ?`, [this.lastID, orderId], () => finish());
                                                    });
                                                }
                                                bookInv.reserveStockForOrder(db, orderId, () => {
                                                    bookSales.notifyBookOrderById(db, orderId, 'BOOK_ORDER_CONFIRMED', { pos_summary: notes.join(' · ') }, () => {});
                                                    finish();
                                                });
                                            });
                                        });
                                    };
                                    run(0);
                                });
                            };
                        }
                    );
                });
            });
        });
    });
}

function actorFromReq(req) {
    const u = req.bookSalesActor || {};
    const role = String(u.role || '').toLowerCase();
    const ur = String(u.user_role || '').toLowerCase();
    return {
        id: req.bookSalesActorId,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Staff',
        isAdmin: role === 'admin' || ur === 'admin' || ur === 'co_admin',
        email: u.email
    };
}

function registerRetailPosRoutes(app, db, deps) {
    const { bookSales, listDoctorPaymentOptions } = deps;
    const guard = (opts, fn) => (req, res) =>
        ensureRetailSchema(db, () => bookSales.ensureBookSalesSchema(db, () => bookAuth.requireBookSalesActor(db, opts, fn)(req, res)));
    const staff = (fn) => guard({ orders: true }, fn);
    const admin = (fn) => guard({ config: true }, fn);
    const fail = (res, err, status) => res.status(status || 500).json({ error: err && err.message ? err.message : String(err) });

    // ---------- staff POS ----------
    app.get('/api/pos/retail/catalog', staff((req, res) => {
        bookSales.loadBookSalesConfig(db, (err, config) => {
            if (err) return fail(res, err);
            loadSettings(db, (sErr, settings) => {
                bookInv.loadInventory(db, (iErr, rows) => {
                    const stock = {};
                    (rows || []).forEach((r) => {
                        if (!stock[r.book_id]) stock[r.book_id] = {};
                        stock[r.book_id][r.language] = bookInv.getAvailableQty(r);
                    });
                    const actor = actorFromReq(req);
                    const respond = (razorpay) =>
                        res.json({
                            actor,
                            books: (config.books || []).filter((b) => b.active !== false && Number(b.price) > 0),
                            languages: bookSales.LANGUAGE_DEFS,
                            stock,
                            settings: Object.assign({}, settings, { razorpayMethodId: razorpay ? razorpay.id : null }),
                            courierCharge: settings.courierCharge != null ? settings.courierCharge : config.defaultCourierCharge
                        });
                    if (typeof listDoctorPaymentOptions !== 'function') return respond(null);
                    listDoctorPaymentOptions((e, options) => {
                        const hit = (options || []).find((o) => String(o.gateway || o.id || '').indexOf('razorpay') === 0 || String(o.id || '').indexOf('razorpay') === 0);
                        respond(hit || null);
                    });
                });
            });
        });
    }));

    app.get('/api/pos/retail/customers', staff((req, res) => {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ customers: [] });
        findCustomers(db, q, (err, list) => (err ? fail(res, err) : res.json({ customers: list })));
    }));

    app.get('/api/pos/retail/customer-summary', staff((req, res) => {
        const c = { userId: req.query.userId ? Number(req.query.userId) : null, phone: req.query.phone, email: req.query.email };
        const key = customerKeyFor(c);
        walletBalance(db, key, (e1, w) =>
            loyaltyBalance(db, key, (e2, p) =>
                db.all(`SELECT bo.order_code, bo.total_amount, bo.status, bo.created_at FROM book_orders bo WHERE ${c.userId ? 'bo.user_id = ?' : c.phone ? 'bo.buyer_phone LIKE ?' : 'LOWER(bo.buyer_email) = ?'} ORDER BY bo.id DESC LIMIT 5`, [c.userId ? c.userId : c.phone ? '%' + String(c.phone).replace(/\D/g, '').slice(-10) : String(c.email || '').toLowerCase()], (e3, orders) =>
                    res.json({ customerKey: key, walletBalance: w || 0, loyaltyPoints: p || 0, recentOrders: orders || [] })
                )
            )
        );
    }));

    app.post('/api/pos/retail/quote', staff((req, res) => {
        buildQuote(db, deps, req.body || {}, actorFromReq(req), (err, quote) => {
            if (err) return fail(res, err);
            if (quote.error) return res.status(400).json({ error: quote.error });
            res.json({ quote });
        });
    }));

    app.post('/api/pos/retail/checkout', staff((req, res) => {
        checkout(db, deps, req.body || {}, actorFromReq(req), (err, out) => {
            if (err) return fail(res, err);
            if (out.error) return res.status(400).json({ error: out.error });
            res.json(out);
        });
    }));

    app.post('/api/pos/retail/orders/:id/pay', staff((req, res) => {
        const id = parseInt(req.params.id, 10);
        const mid = String((req.body && req.body.methodId) || '').trim();
        db.get(`SELECT * FROM book_orders WHERE id = ?`, [id], (err, bo) => {
            if (err) return fail(res, err);
            if (!bo) return fail(res, new Error('Order not found'), 404);
            if (bo.status !== 'pending_payment') return fail(res, new Error('Order is not awaiting payment'), 400);
            db.get(`SELECT order_id_string, amount FROM orders WHERE id = ?`, [bo.order_id], (e2, ord) => {
                bookSales.initiateBookOrderPayment(
                    db,
                    listDoctorPaymentOptions,
                    { bookOrderId: id, bookOrder: bo, orderDbId: bo.order_id, orderIdStr: (ord && ord.order_id_string) || '', amount: Number((ord && ord.amount) || bo.total_amount), uid: bo.user_id || null, mid },
                    res
                );
            });
        });
    }));

    app.get('/api/pos/retail/orders/:id/status', staff((req, res) => {
        const id = parseInt(req.params.id, 10);
        bookSales.fetchBookOrderFull(db, id, (err, order) => {
            if (err) return fail(res, err);
            if (!order) return fail(res, new Error('Not found'), 404);
            if (order.status !== 'pending_payment' || !order.orderId) return res.json({ order, paid: order.status !== 'pending_payment' });
            db.get(`SELECT * FROM orders WHERE id = ?`, [order.orderId], (e2, pay) => {
                if (pay && String(pay.status).toLowerCase() === 'success') {
                    return bookSales.confirmBookOrder(db, id, null, (cErr, result) => {
                        if (cErr) return fail(res, cErr);
                        db.get(`SELECT * FROM retail_pos_sales WHERE book_order_id = ?`, [id], (e3, sale) => {
                            if (sale && !Number(sale.loyalty_points_earned)) {
                                loadSettings(db, (e4, settings) => {
                                    const earned = settings.loyaltyEnabled ? Math.floor((Number(sale.subtotal) - Number(sale.discount_total)) * (Number(settings.loyaltyEarnPerRupee) || 0)) : 0;
                                    if (!earned || !sale.customer_key) return res.json({ order: (result && result.order) || order, paid: true });
                                    db.run(`UPDATE retail_pos_sales SET loyalty_points_earned = ? WHERE id = ?`, [earned, sale.id], () =>
                                        db.run(`INSERT INTO retail_loyalty_ledger (customer_key, user_id, points, kind, book_order_id, note) VALUES (?, ?, ?, 'earn', ?, ?)`, [sale.customer_key, order.userId || null, earned, id, 'Order ' + order.orderCode], () =>
                                            res.json({ order: (result && result.order) || order, paid: true })
                                        )
                                    );
                                });
                            } else res.json({ order: (result && result.order) || order, paid: true });
                        });
                    });
                }
                res.json({ order, paid: false });
            });
        });
    }));

    app.post('/api/pos/retail/orders/:id/mark-paid', staff((req, res) => {
        const id = parseInt(req.params.id, 10);
        const mode = String((req.body && req.body.paymentMode) || 'cash').toLowerCase();
        const actor = actorFromReq(req);
        db.get(`SELECT * FROM book_orders WHERE id = ?`, [id], (err, bo) => {
            if (err) return fail(res, err);
            if (!bo || bo.status !== 'pending_payment') return fail(res, new Error('Order is not awaiting payment'), 400);
            db.run(`UPDATE book_orders SET payment_mode = ?, admin_confirmed_by = ?, admin_confirmed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [mode, actor.id || null, nowIso(), id], () => {
                if (bo.order_id) db.run(`UPDATE orders SET status = 'success', payment_date = CURRENT_TIMESTAMP, payment_gateway = ? WHERE id = ?`, ['pos_' + mode, bo.order_id], () => {});
                bookSales.confirmBookOrder(db, id, actor.id || null, (cErr, result) => {
                    if (cErr) return fail(res, cErr);
                    res.json({ success: true, order: result && result.order });
                });
            });
        });
    }));

    app.post('/api/pos/retail/gift-cards', staff((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        issueGiftCard(db, deps, { value: b.value, recipient: b.recipient || {}, actorId: actor.id, notes: b.notes, validityDays: b.validityDays }, (err, card) => (err ? fail(res, err, 400) : res.json({ success: true, card })));
    }));
    app.get('/api/pos/retail/gift-cards/:code', staff((req, res) => {
        getGiftCard(db, req.params.code, (err, gc) => {
            if (err) return fail(res, err);
            if (!gc) return fail(res, new Error('Gift card not found'), 404);
            res.json({ card: { code: gc.code, balance: round2(gc.balance), status: gc.status, expiresAt: gc.expires_at, recipient: gc.recipient_name, usable: giftCardUsable(gc) || null } });
        });
    }));
    app.post('/api/pos/retail/wallet/topup', staff((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        walletCredit(db, deps, { customer: b.customer || {}, amount: Math.abs(Number(b.amount) || 0), kind: 'topup', actorId: actor.id, note: 'Top-up at POS (' + String(b.paymentMode || 'cash') + ')' }, (err, out) => (err ? fail(res, err, 400) : res.json({ success: true, balance: out.balance })));
    }));
    app.get('/api/pos/retail/vouchers/:code', staff((req, res) => {
        getVoucher(db, req.params.code, (err, v) => {
            if (err) return fail(res, err);
            if (!v) return fail(res, new Error('Voucher not found'), 404);
            res.json({ voucher: { code: v.code, title: v.title, kind: v.kind, value: v.value, minOrder: v.min_order, maxDiscount: v.max_discount, active: !!Number(v.active), endsAt: v.ends_at } });
        });
    }));
    app.get('/api/pos/retail/sales', staff((req, res) => {
        const actor = actorFromReq(req);
        const mine = !actor.isAdmin || req.query.mine === '1';
        db.all(
            `SELECT s.*, bo.order_code, bo.buyer_name, bo.buyer_phone, bo.status, bo.total_amount, bo.created_at AS order_at
             FROM retail_pos_sales s JOIN book_orders bo ON bo.id = s.book_order_id
             WHERE ${mine ? 's.actor_id = ? AND ' : ''} s.created_at >= ?
             ORDER BY s.id DESC LIMIT 100`,
            mine ? [actor.id, new Date(Date.now() - 86400000 * 1).toISOString().slice(0, 10)] : [new Date(Date.now() - 86400000).toISOString().slice(0, 10)],
            (err, rows) => (err ? fail(res, err) : res.json({ sales: rows || [] }))
        );
    }));

    // ---------- admin management ----------
    app.get('/api/admin/retail/settings', admin((req, res) => loadSettings(db, (err, s) => (err ? fail(res, err) : res.json({ settings: s, defaults: DEFAULT_SETTINGS })))));
    app.put('/api/admin/retail/settings', admin((req, res) => {
        loadSettings(db, (err, cur) => {
            const next = Object.assign({}, cur, req.body && req.body.settings ? req.body.settings : req.body || {});
            delete next.actingAdminId;
            ['paymentModes', 'fulfillmentTypes', 'giftCardDenominations'].forEach((k) => {
                if (typeof next[k] === 'string') next[k] = next[k].split(',').map((s) => s.trim()).filter(Boolean);
                if (k === 'giftCardDenominations') next[k] = (next[k] || []).map(Number).filter((n) => n > 0);
            });
            const save = deps.upsertGlobalSetting
                ? (cb) => deps.upsertGlobalSetting(SETTINGS_KEY, JSON.stringify(next), cb)
                : (cb) => db.run(`INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [SETTINGS_KEY, JSON.stringify(next)], cb);
            save((sErr) => (sErr ? fail(res, sErr) : res.json({ success: true, settings: next })));
        });
    }));

    app.get('/api/admin/retail/vouchers', admin((req, res) => db.all(`SELECT * FROM retail_vouchers ORDER BY id DESC`, [], (err, rows) => (err ? fail(res, err) : res.json({ vouchers: rows || [] })))));
    app.post('/api/admin/retail/vouchers', admin((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        const vCode = String(b.code || code('', 8)).trim().toUpperCase();
        const kind = b.kind === 'flat' ? 'flat' : 'percent';
        const value = Number(b.value) || 0;
        if (!(value > 0)) return fail(res, new Error('Value must be above 0'), 400);
        if (b.id) {
            return db.run(
                `UPDATE retail_vouchers SET code = ?, title = ?, kind = ?, value = ?, min_order = ?, max_discount = ?, usage_limit = ?, per_customer_limit = ?, starts_at = ?, ends_at = ?, channels = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [vCode, b.title || null, kind, value, Number(b.minOrder) || 0, b.maxDiscount != null && b.maxDiscount !== '' ? Number(b.maxDiscount) : null, b.usageLimit != null && b.usageLimit !== '' ? Number(b.usageLimit) : null, b.perCustomerLimit != null && b.perCustomerLimit !== '' ? Number(b.perCustomerLimit) : null, b.startsAt || null, b.endsAt || null, b.channels || 'pos,shop', b.active === false || b.active === 0 ? 0 : 1, Number(b.id)],
                (err) => (err ? fail(res, err, 400) : res.json({ success: true }))
            );
        }
        db.run(
            `INSERT INTO retail_vouchers (code, title, kind, value, min_order, max_discount, usage_limit, per_customer_limit, starts_at, ends_at, channels, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [vCode, b.title || null, kind, value, Number(b.minOrder) || 0, b.maxDiscount != null && b.maxDiscount !== '' ? Number(b.maxDiscount) : null, b.usageLimit != null && b.usageLimit !== '' ? Number(b.usageLimit) : null, b.perCustomerLimit != null && b.perCustomerLimit !== '' ? Number(b.perCustomerLimit) : null, b.startsAt || null, b.endsAt || null, b.channels || 'pos,shop', actor.id || null],
            function (err) {
                if (err) return fail(res, err, 400);
                res.json({ success: true, id: this.lastID, code: vCode });
            }
        );
    }));
    app.delete('/api/admin/retail/vouchers/:id', admin((req, res) => db.run(`DELETE FROM retail_vouchers WHERE id = ?`, [Number(req.params.id)], (err) => (err ? fail(res, err) : res.json({ success: true })))));

    app.get('/api/admin/retail/gift-cards', admin((req, res) =>
        db.all(`SELECT * FROM retail_gift_cards ORDER BY id DESC LIMIT 500`, [], (err, rows) => (err ? fail(res, err) : res.json({ giftCards: rows || [] })))
    ));
    app.post('/api/admin/retail/gift-cards', admin((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        issueGiftCard(db, deps, { value: b.value, recipient: b.recipient || {}, actorId: actor.id, notes: b.notes, validityDays: b.validityDays }, (err, card) => (err ? fail(res, err, 400) : res.json({ success: true, card })));
    }));
    app.post('/api/admin/retail/gift-cards/:id/adjust', admin((req, res) => {
        const id = Number(req.params.id);
        const b = req.body || {};
        const actor = actorFromReq(req);
        if (b.status) {
            return db.run(`UPDATE retail_gift_cards SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [String(b.status), id], (err) => (err ? fail(res, err) : res.json({ success: true })));
        }
        const amt = round2(b.amount);
        if (!amt) return fail(res, new Error('Amount required'), 400);
        db.run(`UPDATE retail_gift_cards SET balance = balance + ?, status = CASE WHEN balance + ? > 0 THEN 'active' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [amt, amt, id], (err) => {
            if (err) return fail(res, err);
            db.run(`INSERT INTO retail_gift_card_txns (gift_card_id, amount, kind, actor_id, note) VALUES (?, ?, 'adjust', ?, ?)`, [id, amt, actor.id || null, b.note || null], () => res.json({ success: true }));
        });
    }));
    app.get('/api/admin/retail/gift-cards/:id/txns', admin((req, res) => db.all(`SELECT * FROM retail_gift_card_txns WHERE gift_card_id = ? ORDER BY id DESC`, [Number(req.params.id)], (err, rows) => (err ? fail(res, err) : res.json({ txns: rows || [] })))));

    app.get('/api/admin/retail/customers', admin((req, res) => {
        const q = String(req.query.q || '').trim();
        const sql = `SELECT c.*, (SELECT COALESCE(SUM(amount),0) FROM retail_wallet_ledger w WHERE w.customer_key = c.customer_key) AS wallet_balance,
                            (SELECT COALESCE(SUM(points),0) FROM retail_loyalty_ledger l WHERE l.customer_key = c.customer_key) AS loyalty_points,
                            (SELECT COUNT(*) FROM retail_pos_sales s WHERE s.customer_key = c.customer_key) AS pos_orders
                     FROM retail_customers c ${q ? 'WHERE LOWER(COALESCE(c.name,\'\')) LIKE ? OR COALESCE(c.phone,\'\') LIKE ? OR LOWER(COALESCE(c.email,\'\')) LIKE ?' : ''} ORDER BY c.updated_at DESC LIMIT 300`;
        const like = '%' + q.toLowerCase() + '%';
        db.all(sql, q ? [like, like, like] : [], (err, rows) => (err ? fail(res, err) : res.json({ customers: rows || [] })));
    }));
    app.post('/api/admin/retail/wallet/adjust', admin((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        walletCredit(db, deps, { customer: b.customer || {}, amount: Number(b.amount) || 0, kind: Number(b.amount) > 0 ? 'credit' : 'debit', actorId: actor.id, note: b.note || 'Admin adjustment' }, (err, out) => (err ? fail(res, err, 400) : res.json({ success: true, balance: out.balance })));
    }));
    app.post('/api/admin/retail/loyalty/adjust', admin((req, res) => {
        const b = req.body || {};
        const actor = actorFromReq(req);
        loyaltyAdjust(db, { customer: b.customer || {}, points: Number(b.points) || 0, kind: 'adjust', actorId: actor.id, note: b.note || 'Admin adjustment' }, (err, out) => (err ? fail(res, err, 400) : res.json({ success: true, balance: out ? out.balance : 0 })));
    }));
    app.get('/api/admin/retail/ledger', admin((req, res) => {
        const key = String(req.query.customerKey || '');
        db.all(`SELECT 'wallet' AS kind_group, id, amount AS amount, kind, book_order_id, note, created_at FROM retail_wallet_ledger WHERE customer_key = ?
                UNION ALL SELECT 'loyalty', id, points, kind, book_order_id, note, created_at FROM retail_loyalty_ledger WHERE customer_key = ? ORDER BY created_at DESC LIMIT 200`, [key, key], (err, rows) => (err ? fail(res, err) : res.json({ ledger: rows || [] })));
    }));
    app.get('/api/admin/retail/report', admin((req, res) => {
        const from = String(req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
        const to = String(req.query.to || new Date().toISOString().slice(0, 10));
        db.all(
            `SELECT s.*, bo.order_code, bo.buyer_name, bo.buyer_phone, bo.status, bo.total_amount, bo.commerce_stage, bo.created_at AS order_at,
                    u.first_name AS staff_first, u.last_name AS staff_last
             FROM retail_pos_sales s JOIN book_orders bo ON bo.id = s.book_order_id LEFT JOIN users u ON u.id = s.actor_id
             WHERE SUBSTR(s.created_at,1,10) >= ? AND SUBSTR(s.created_at,1,10) <= ? ORDER BY s.id DESC`,
            [from, to],
            (err, rows) => {
                if (err) return fail(res, err);
                const sales = rows || [];
                const sum = (k) => round2(sales.filter((s) => s.status !== 'cancelled').reduce((a, s) => a + Number(s[k] || 0), 0));
                const byMode = {};
                const byStaff = {};
                const byFulfil = {};
                sales.forEach((s) => {
                    byMode[s.payment_mode || '?'] = round2((byMode[s.payment_mode || '?'] || 0) + Number(s.paid_amount || 0));
                    const st = [s.staff_first, s.staff_last].filter(Boolean).join(' ') || '#' + s.actor_id;
                    byStaff[st] = round2((byStaff[st] || 0) + Number(s.total_amount || 0));
                    byFulfil[s.fulfillment || 'pickup'] = (byFulfil[s.fulfillment || 'pickup'] || 0) + 1;
                });
                res.json({
                    from,
                    to,
                    totals: { orders: sales.length, gross: sum('subtotal'), discounts: sum('discount_total'), shipping: sum('shipping_charge'), giftCards: sum('gift_card_amount'), wallet: sum('wallet_amount'), collected: sum('paid_amount'), pointsIssued: sum('loyalty_points_earned'), pointsRedeemed: sum('loyalty_points_used') },
                    byMode,
                    byStaff,
                    byFulfil,
                    sales
                });
            }
        );
    }));
}

module.exports = { ensureRetailSchema, loadSettings, DEFAULT_SETTINGS, registerRetailPosRoutes, buildQuote, voucherDiscount, customerKeyFor };

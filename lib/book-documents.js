'use strict';
/**
 * Computer-generated order documents (invoice, shipping label, return label) as PDF email attachments,
 * plus a copy of every buyer notification to the store (sender) mailbox.
 */
const pdfServer = require('./certificate-pdf-server');

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function money(n) {
    const v = Number(n) || 0;
    return '₹ ' + v.toFixed(2);
}
function addrText(a) {
    if (!a) return '';
    if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch (_) { return a; }
    }
    return [a.line1 || a.address1 || a.address, a.line2 || a.address2, a.landmark, a.city, a.state, a.pincode || a.postalCode, a.country]
        .filter(Boolean).join(', ');
}

const LANG_LABEL = { english: 'English', marathi: 'Marathi', hindi: 'Hindi', kannada: 'Kannada' };
function fmtDate(v) {
    const d = v ? new Date(v) : new Date();
    return isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function payLabel(order) {
    const pm = String(order.paymentMode || '').toLowerCase();
    const map = { cash: 'Cash', upi: 'UPI', card: 'Card', online: 'Online (Razorpay)', cod: 'Cash on delivery', counter: 'Pay at counter', wallet: 'Store wallet', gift_card: 'Gift card' };
    return map[pm] || (pm ? pm.toUpperCase() : '—');
}
/** Pull payment references and POS discount breakdown so the documents show the complete money trail. */
function enrichForDocs(db, order, cb) {
    const out = Object.assign({}, order);
    out.items = (Array.isArray(order.items) ? order.items : []).map((it) =>
        Object.assign({}, it, {
            bookId: it.bookId || it.book_id,
            qty: Number(it.qty) || 0,
            unitPrice: Number(it.unitPrice != null ? it.unitPrice : it.unit_price) || 0,
            lineTotal: Number(it.lineTotal != null ? it.lineTotal : it.line_total) || 0
        })
    );
    const withTitles = (next) => {
        if (!db || !out.items.some((it) => !it.bookTitle && !it.title)) return next();
        try {
            require('./book-sales').loadBookSalesConfig(db, (e, cfg) => {
                const byId = {};
                ((cfg && cfg.books) || []).forEach((b) => (byId[String(b.id).toLowerCase()] = b.title));
                out.items = out.items.map((it) => Object.assign({}, it, { bookTitle: it.bookTitle || it.title || byId[String(it.bookId || '').toLowerCase()] || it.bookId }));
                next();
            });
        } catch (_) {
            next();
        }
    };
    const step2 = () => withTitles(() => step3());
    const step3 = () => {
        if (!db) return cb(out);
        db.get(`SELECT * FROM retail_pos_sales WHERE book_order_id = ? ORDER BY id DESC LIMIT 1`, [order.id], (e, sale) => {
            if (sale) out.posSale = sale;
            cb(out);
        });
    };
    if (!db || !order.orderId) return step2();
    db.get(`SELECT order_id_string, status, payment_gateway, provider_order_id, provider_transaction_id, payment_date FROM orders WHERE id = ?`, [order.orderId], (e, pay) => {
        if (pay) {
            out.paymentRef = pay.order_id_string || null;
            out.paymentGateway = pay.payment_gateway || null;
            out.providerOrderId = pay.provider_order_id || null;
            out.transactionId = pay.provider_transaction_id || null;
            out.paidAt = pay.payment_date || null;
            out.paymentStatus = pay.status || out.paymentStatus;
        }
        step2();
    });
}
function qrSvg(value) {
    try {
        const QRCode = require('qrcode');
        const svgTag = require('qrcode/lib/renderer/svg-tag');
        return svgTag.render(QRCode.create(String(value || ''), { errorCorrectionLevel: 'M' }), { margin: 0, width: 96 });
    } catch (_) {
        return '';
    }
}
function docStyles() {
    return 'body{font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;margin:0;padding:30px 34px;font-size:12.5px;line-height:1.45}' +
        '.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:14px;border-bottom:3px solid #0f766e;margin-bottom:18px}' +
        '.brand{display:flex;gap:12px;align-items:center}.logo{width:46px;height:46px;border-radius:12px;background:#0f766e;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px}' +
        'h1{margin:0;font-size:20px;letter-spacing:-.01em}.muted{color:#64748b}.kicker{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#0f766e;font-weight:800}' +
        '.doc{ text-align:right}.doc b{font-size:17px;display:block;margin-bottom:4px}.doc .no{font-size:15px;font-weight:800}' +
        '.cols{display:flex;gap:14px;margin-bottom:16px}.box{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;flex:1;background:#fff}.box h4{margin:0 0 6px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#64748b}' +
        'table{width:100%;border-collapse:collapse;margin-top:4px}th,td{padding:9px 10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}th{background:#f1f5f9;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#475569}' +
        '.r{text-align:right}.c{text-align:center}.sum{width:46%;margin-left:auto}.sum td{padding:6px 10px;border:0}.sum tr.tot td{font-weight:800;font-size:15px;border-top:2px solid #0f172a;padding-top:9px}.sum .neg{color:#b45309}' +
        '.paid{display:inline-block;border:2px solid #15803d;color:#15803d;border-radius:8px;padding:4px 12px;font-weight:800;letter-spacing:.14em;font-size:12px;transform:rotate(-4deg)}.due{border-color:#b91c1c;color:#b91c1c}' +
        '.ft{margin-top:26px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:10.5px;color:#64748b;display:flex;justify-content:space-between;gap:20px;align-items:flex-end}' +
        '.qr{display:flex;gap:12px;align-items:center}.qr svg{width:84px;height:84px}.chip{display:inline-block;background:#ecfeff;color:#0f766e;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:700;margin-right:4px}';
}
function storeBlock(store) {
    return '<div class="brand"><div class="logo">G</div><div><h1>' + esc(store.storeName || store.name || 'Gogate Products') + '</h1><div class="muted">' +
        esc(addrText(store.storeAddress || store.address || '')) + (store.storeCity ? ', ' + esc(store.storeCity) : '') +
        (store.storePhone ? '<br>' + esc(store.storePhone) : '') + (store.storeEmail ? ' · ' + esc(store.storeEmail) : '') +
        (store.gstin ? '<br>GSTIN ' + esc(store.gstin) : '') + '</div></div></div>';
}
function moneyRows(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const sub = items.reduce((s, it) => s + (Number(it.lineTotal) || (Number(it.unitPrice) || 0) * (Number(it.qty) || 0)), 0);
    const sale = order.posSale || null;
    const total = Number(order.totalAmount) || sub;
    const discounts = sale ? Number(sale.discount_total) || 0 : 0;
    const ship = sale ? Number(sale.shipping_charge) || 0 : Math.max(0, Math.round((total - sub) * 100) / 100);
    const prepaid = sale ? (Number(sale.gift_card_amount) || 0) + (Number(sale.wallet_amount) || 0) : 0;
    const rows = [['Subtotal', money(sub)]];
    if (sale && Number(sale.manual_discount)) rows.push(['Discount', '− ' + money(sale.manual_discount), 'neg']);
    if (sale && Number(sale.voucher_discount)) rows.push(['Voucher ' + (sale.voucher_code || ''), '− ' + money(sale.voucher_discount), 'neg']);
    if (sale && Number(sale.loyalty_discount)) rows.push(['Loyalty points (' + Math.round(Number(sale.loyalty_points_used)) + ')', '− ' + money(sale.loyalty_discount), 'neg']);
    if (ship) rows.push([order.fulfillmentType === 'pickup' ? 'Handling' : 'Shipping & handling', money(ship)]);
    rows.push(['Grand total', money(total), 'tot']);
    if (sale && Number(sale.gift_card_amount)) rows.push(['Gift card ' + (sale.gift_card_code || ''), '− ' + money(sale.gift_card_amount), 'neg']);
    if (sale && Number(sale.wallet_amount)) rows.push(['Store wallet', '− ' + money(sale.wallet_amount), 'neg']);
    if (prepaid) rows.push(['Paid by ' + payLabel(order), money(Math.max(0, total - prepaid))]);
    return { items, sub, total, discounts, ship, prepaid, rows };
}
function itemsTable(items) {
    return '<table><thead><tr><th style="width:28px">#</th><th>Item</th><th>Language</th><th class="c">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>' +
        items.map((it, i) =>
            '<tr><td>' + (i + 1) + '</td><td><b>' + esc(it.bookTitle || it.title || it.bookId || 'Item') + '</b></td><td>' + esc(LANG_LABEL[String(it.language || '').toLowerCase()] || it.language || '') +
            '</td><td class="c">' + esc(it.qty) + '</td><td class="r">' + money(it.unitPrice) + '</td><td class="r">' + money(it.lineTotal || (it.unitPrice * it.qty)) + '</td></tr>').join('') +
        '</tbody></table>';
}
function sumTable(rows) {
    return '<table class="sum"><tbody>' + rows.map((r) => '<tr class="' + (r[2] || '') + '"><td>' + esc(r[0]) + '</td><td class="r' + (r[2] === 'neg' ? ' neg' : '') + '">' + esc(r[1]) + '</td></tr>').join('') + '</tbody></table>';
}
function paymentBox(order) {
    const paid = order.status !== 'pending_payment' && String(order.paymentStatus || '').toLowerCase() !== 'pending';
    return '<div class="box"><h4>Payment</h4><b>' + esc(payLabel(order)) + '</b> <span class="paid' + (paid ? '' : ' due') + '" style="float:right">' + (paid ? 'PAID' : 'PAYMENT DUE') + '</span>' +
        (order.paymentRef ? '<br>Payment ref ' + esc(order.paymentRef) : '') + (order.transactionId ? '<br>Transaction ID <b>' + esc(order.transactionId) + '</b>' : '') +
        (order.providerOrderId ? '<br>Gateway order ' + esc(order.providerOrderId) : '') + (order.paidAt ? '<br>Paid on ' + esc(fmtDate(order.paidAt)) : '') + '</div>';
}
function shipBox(order) {
    const pickup = order.fulfillmentType === 'pickup';
    return '<div class="box"><h4>' + (pickup ? 'Collection' : 'Delivery') + '</h4>' + (pickup ? '<b>Store pickup</b><br>Show the QR on your receipt at the counter.' :
        '<b>' + esc(order.commerceMode === 'hyperlocal' ? 'Hyperlocal delivery' : 'Courier') + '</b>' + (order.courierProvider || order.commerceProvider ? ' · ' + esc(order.courierProvider || order.commerceProvider) : '') +
        (order.courierTrackingNo || order.commerceAwb ? '<br>AWB / tracking ' + esc(order.courierTrackingNo || order.commerceAwb) : '')) +
        (order.trackingToken ? '<br><span class="muted">Track: ' + esc(publicBase() + '/track-commerce?token=' + order.trackingToken) + '</span>' : '') + '</div>';
}
function publicBase() {
    return String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://seminar.vaidyagogate.org').replace(/\/+$/, '');
}
function billBox(order) {
    return '<div class="box"><h4>Bill to</h4><b>' + esc(order.buyerName || order.shippingRecipientName || 'Customer') + '</b>' + (order.buyerPhone ? '<br>' + esc(order.buyerPhone) : '') + (order.buyerEmail ? '<br>' + esc(order.buyerEmail) : '') + '</div>' +
        '<div class="box"><h4>Ship to</h4>' + esc(order.shippingRecipientName || order.buyerName || '') + (order.shippingPhone && order.shippingPhone !== order.buyerPhone ? ' · ' + esc(order.shippingPhone) : '') + '<br>' + esc(addrText(order.deliveryAddress) || '') +
        ([order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).length ? '<br>' + esc([order.shippingCity, order.shippingState, order.shippingPincode].filter(Boolean).join(', ')) : '') + '</div>';
}
function invoiceHtml(order, cfg) {
    const store = Object.assign({}, (cfg && cfg.shop) || {}, cfg || {});
    const m = moneyRows(order);
    const trackUrl = order.trackingToken ? publicBase() + '/track-commerce?token=' + order.trackingToken : publicBase() + '/track-shipment';
    return '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + esc(order.orderCode) + '</title><style>' + docStyles() + '</style></head><body>' +
        '<div class="hd">' + storeBlock(store) + '<div class="doc"><span class="kicker">Tax invoice</span><b>INV-' + esc(order.orderCode) + '</b><span class="muted">Order ID </span><span class="no">' + esc(order.orderCode) + '</span><br><span class="muted">' + esc(fmtDate(order.createdAt)) + '</span></div></div>' +
        '<div class="cols">' + billBox(order) + '</div>' +
        '<div class="cols">' + paymentBox(order) + shipBox(order) + '</div>' +
        itemsTable(m.items) + sumTable(m.rows) +
        '<div class="ft"><div class="qr">' + qrSvg(trackUrl) + '<div>Scan to track this order<br>' + esc(trackUrl) + '<br><br>Computer-generated invoice — no signature required.<br>Goods once sold are returnable only as per the store return policy.</div></div>' +
        '<div class="r">' + (store.storeName || 'Gogate Products') + '<br>Thank you for your purchase.</div></div></body></html>';
}
function receiptHtml(order, cfg) {
    const store = Object.assign({}, (cfg && cfg.shop) || {}, cfg || {});
    const m = moneyRows(order);
    const trackUrl = order.trackingToken ? publicBase() + '/track-commerce?token=' + order.trackingToken : '';
    return '<!doctype html><html><head><meta charset="utf-8"><title>Receipt ' + esc(order.orderCode) + '</title><style>' + docStyles() + 'body{max-width:560px;margin:0 auto}</style></head><body>' +
        '<div class="hd">' + storeBlock(store) + '<div class="doc"><span class="kicker">Order receipt</span><span class="no">' + esc(order.orderCode) + '</span><br><span class="muted">' + esc(fmtDate(order.createdAt)) + '</span></div></div>' +
        '<p><span class="chip">' + esc(order.fulfillmentType === 'pickup' ? 'Store pickup' : order.commerceMode === 'hyperlocal' ? 'Hyperlocal delivery' : 'Courier delivery') + '</span><span class="chip">' + esc(payLabel(order)) + '</span>' +
        (order.transactionId ? '<span class="chip">Txn ' + esc(order.transactionId) + '</span>' : '') + (order.paymentRef ? '<span class="chip">Ref ' + esc(order.paymentRef) + '</span>' : '') + '</p>' +
        '<p><b>' + esc(order.buyerName || 'Customer') + '</b>' + (order.buyerPhone ? ' · ' + esc(order.buyerPhone) : '') + (order.buyerEmail ? ' · ' + esc(order.buyerEmail) : '') + '</p>' +
        itemsTable(m.items) + sumTable(m.rows) +
        (order.posSale && Number(order.posSale.loyalty_points_earned) ? '<p class="muted">Loyalty points earned on this bill: <b>+' + Math.round(Number(order.posSale.loyalty_points_earned)) + '</b></p>' : '') +
        '<div class="ft"><div class="qr">' + qrSvg(order.qrCodeData || order.orderCode) + '<div>' + (order.fulfillmentType === 'pickup' ? 'Show this QR at the counter to collect your order.' : 'Order QR') + (trackUrl ? '<br>Track: ' + esc(trackUrl) : '') + '</div></div><div class="r">' + esc(store.receiptFooter || 'Thank you for shopping with us.') + '</div></div></body></html>';
}

function toPdfAttachment(filename, html, cb) {
    pdfServer
        .htmlToPdfBuffer(html, { landscape: false })
        .then((buf) => cb(null, { filename: filename + '.pdf', content: buf.toString('base64'), encoding: 'base64', contentType: 'application/pdf' }))
        .catch(() => cb(null, { filename: filename + '.html', content: html, contentType: 'text/html' }));
}

function labelHtmlSafe(order, cfg, kind) {
    try {
        const commerce = require('./commerce-logistics');
        if (kind === 'return') return order.returnTookanJobId || order.returnAwb ? commerce.returnLabelHtml(Object.assign({}, order, { labelStyle: 'sheet' }), cfg) : '';
        const awb = order.courierTrackingNo || order.commerceAwb || '';
        return awb ? commerce.labelHtml(Object.assign({}, order, { courierTrackingNo: awb, labelStyle: 'sheet' }), cfg) : '';
    } catch (_) {
        return '';
    }
}

const INVOICE_EVENTS = ['BOOK_ORDER_PLACED', 'BOOK_ORDER_CONFIRMED', 'INVOICE_GENERATED'];
const LABEL_EVENTS = ['BOOK_ORDER_PLACED', 'BOOK_ORDER_CONFIRMED', 'BOOK_ORDER_SHIPPING_READY', 'BOOK_ORDER_SHIPPED'];

function loadCfg(db, cb) {
    try {
        require('./commerce-routes').loadConfig(db, (err, raw, cfg) => cb(err ? null : cfg || null));
    } catch (_) {
        cb(null);
    }
}

/** Attachments for a buyer notification of the given event (invoice on placement, shipping label once an AWB exists). */
function attachmentsFor(db, eventKey, order, cb) {
    if (!order || (!INVOICE_EVENTS.includes(eventKey) && !LABEL_EVENTS.includes(eventKey))) return cb([]);
    loadCfg(db, (cfg) => enrichForDocs(db, order, (order) => {
        const jobs = [];
        if (INVOICE_EVENTS.includes(eventKey)) {
            jobs.push(['invoice-' + order.orderCode, invoiceHtml(order, cfg)]);
            jobs.push(['receipt-' + order.orderCode, receiptHtml(order, cfg)]);
        }
        // Forward shipping labels go to the store copy only (see copyToSender); buyers receive labels for returns/replacements.
        const out = [];
        const step = () => {
            if (!jobs.length) return cb(out, cfg);
            const [name, html] = jobs.shift();
            toPdfAttachment(name, html, (e, att) => { if (att) out.push(att); step(); });
        };
        step();
    }));
}

/** Mirror the buyer update to the store (sender) mailbox with the same attachments. */
function copyToSender(db, cfg, eventKey, order, attachments, cb) {
    let to = cfg && cfg.storeEmail;
    if (!to) { try { const mc = require('./integration-settings').getMailConfig(); to = (mc && mc.from) || ''; } catch (_) { to = ''; } }
    if (!to || !order) return cb && cb();
    let engine;
    try { engine = require('./notification-engine'); } catch (_) { return cb && cb(); }
    if (LABEL_EVENTS.includes(eventKey) && !(attachments || []).some((a) => /shipping-label/.test(a.filename || ''))) {
        const h = labelHtmlSafe(order, cfg, 'forward');
        if (h) {
            return toPdfAttachment('shipping-label-' + order.orderCode, h, (e, att) => copyToSender(db, cfg, eventKey, order, (attachments || []).concat(att ? [att] : []), cb));
        }
    }
    const title = String(eventKey || '').replace(/^BOOK_ORDER_/, '').replace(/_/g, ' ').toLowerCase();
    const html = '<p>Order <b>' + esc(order.orderCode) + '</b> — ' + esc(title) + '.</p><p>Buyer: ' + esc(order.buyerName || '') + ' · ' + esc(order.buyerPhone || '') +
        '<br>Amount: ' + money(order.totalAmount) + (order.courierTrackingNo ? '<br>AWB: ' + esc(order.courierTrackingNo) : '') + '</p>' +
        (attachments.length ? '<p>Attached: ' + attachments.map((a) => esc(a.filename)).join(', ') + '</p>' : '');
    engine.enqueueDirectMessage(db, {
        channel: 'email', destination: to, subject: '[Store] Order ' + order.orderCode + ' — ' + title,
        html, event_key: eventKey + '_SENDER', immediate: true, attachments
    }, () => cb && cb());
}

/** Return/replacement pickup booked: email the courier-type-specific return label to the customer (and store). */
function emailReturnLabel(db, order, cb) {
    if (!order || !order.buyerEmail) return cb && cb();
    loadCfg(db, (cfg) => {
        const html = labelHtmlSafe(order, cfg, 'return');
        if (!html) return cb && cb();
        toPdfAttachment('return-label-' + order.orderCode, html, (e, att) => {
            let engine;
            try { engine = require('./notification-engine'); } catch (_) { return cb && cb(); }
            const kind = order.returnKind === 'replacement' || order.replacementOrderId ? 'Replacement' : 'Return';
            const body = '<p>Hello ' + esc(order.buyerName || '') + ',</p><p>Your ' + kind.toLowerCase() + ' pickup for order <b>' + esc(order.orderCode) +
                '</b> has been scheduled' + (order.returnExpectedAt ? ' for ' + esc(new Date(order.returnExpectedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })) : '') +
                '.</p><p>Please print the attached ' + kind.toLowerCase() + ' shipping label and attach it to the parcel before handing it to the pickup agent.' +
                (order.returnPickupOtp ? ' Pickup OTP: <b>' + esc(order.returnPickupOtp) + '</b>.' : '') + '</p>' +
                (order.commerceTrackUrl ? '<p><a href="' + esc(order.commerceTrackUrl) + '">Track your ' + kind.toLowerCase() + '</a></p>' : '');
            const atts = att ? [att] : [];
            engine.enqueueDirectMessage(db, {
                channel: 'email', destination: order.buyerEmail, subject: kind + ' label for order ' + order.orderCode,
                html: body, event_key: 'BOOK_RETURN_LABEL', immediate: true, attachments: atts, userId: order.userId
            }, () => copyToSender(db, cfg, 'BOOK_RETURN_LABEL', order, atts, cb));
        });
    });
}

/** Admin-triggered documents: docs = ['invoice','label','return'], to = 'buyer' | 'store' | 'both'. */
function sendDocuments(db, order0, docs, to, cb) {
    enrichForDocs(db, order0, (order) => sendDocumentsRaw(db, order, docs, to, cb));
}
function sendDocumentsRaw(db, order, docs, to, cb) {
    docs = Array.isArray(docs) && docs.length ? docs : ['invoice'];
    loadCfg(db, (cfg) => {
        const jobs = [];
        if (docs.includes('invoice')) {
            jobs.push(['invoice-' + order.orderCode, invoiceHtml(order, cfg)]);
            jobs.push(['receipt-' + order.orderCode, receiptHtml(order, cfg)]);
        }
        if (docs.includes('label')) { const h = labelHtmlSafe(order, cfg, 'forward'); if (h) jobs.push(['shipping-label-' + order.orderCode, h]); }
        if (docs.includes('return')) { const h = labelHtmlSafe(order, cfg, 'return'); if (h) jobs.push(['return-label-' + order.orderCode, h]); }
        if (!jobs.length) return cb(new Error('No document available yet (label needs a booked courier / AWB)'));
        const atts = [];
        const step = () => {
            if (jobs.length) { const [n, h] = jobs.shift(); return toPdfAttachment(n, h, (e, a) => { if (a) atts.push(a); step(); }); }
            let engine;
            try { engine = require('./notification-engine'); } catch (_) { return cb(new Error('Notification engine unavailable')); }
            const names = atts.map((a) => a.filename).join(', ');
            const html = '<p>Hello ' + esc(order.buyerName || '') + ',</p><p>Please find the documents for your order <b>' + esc(order.orderCode) + '</b> attached: ' + esc(names) + '.</p>' +
                (order.commerceTrackUrl ? '<p><a href="' + esc(order.commerceTrackUrl) + '">Track your order</a></p>' : '');
            const sent = [];
            const toBuyer = (next) => {
                if ((to !== 'buyer' && to !== 'both') || !order.buyerEmail) return next();
                engine.enqueueDirectMessage(db, { channel: 'email', destination: order.buyerEmail, subject: 'Documents for order ' + order.orderCode, html, event_key: 'BOOK_ORDER_DOCUMENTS', immediate: true, attachments: atts, userId: order.userId }, () => { sent.push(order.buyerEmail); next(); });
            };
            const toStore = (next) => {
                if (to !== 'store' && to !== 'both') return next();
                copyToSender(db, cfg, 'BOOK_ORDER_DOCUMENTS', order, atts, () => { if (cfg && cfg.storeEmail) sent.push(cfg.storeEmail); next(); });
            };
            toBuyer(() => toStore(() => cb(null, { sent, documents: atts.map((a) => a.filename) })));
        };
        step();
    });
}

module.exports = {
    receiptHtml,
    enrichForDocs, invoiceHtml, labelHtmlSafe, attachmentsFor, copyToSender, emailReturnLabel, sendDocuments };

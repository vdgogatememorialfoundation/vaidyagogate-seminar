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

function invoiceHtml(order, cfg) {
    const items = Array.isArray(order.items) ? order.items : [];
    const sub = items.reduce((s, it) => s + (Number(it.lineTotal) || (Number(it.unitPrice) || 0) * (Number(it.qty) || 0)), 0);
    const total = Number(order.totalAmount) || sub;
    const ship = Math.max(0, Math.round((total - sub) * 100) / 100);
    const rows = items.map((it, i) =>
        '<tr><td>' + (i + 1) + '</td><td>' + esc(it.bookTitle || it.title || 'Item') + (it.language ? ' <small>(' + esc(it.language) + ')</small>' : '') +
        '</td><td class="r">' + esc(it.qty) + '</td><td class="r">' + money(it.unitPrice) + '</td><td class="r">' + money(it.lineTotal || (it.unitPrice * it.qty)) + '</td></tr>').join('');
    const store = (cfg && cfg.shop) || cfg || {};
    const date = order.createdAt ? new Date(order.createdAt) : new Date();
    return '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + esc(order.orderCode) + '</title><style>' +
        'body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;padding:28px;font-size:13px}' +
        '.hd{display:flex;justify-content:space-between;border-bottom:3px solid #0f9d8a;padding-bottom:12px;margin-bottom:16px}' +
        'h1{margin:0;font-size:22px;color:#0f9d8a}.muted{color:#64748b}.box{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;flex:1}' +
        '.cols{display:flex;gap:14px;margin-bottom:16px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}' +
        'th{background:#f1f5f9;font-size:12px}.r{text-align:right}.tot td{font-weight:700;border-top:2px solid #0f172a}.ft{margin-top:22px;font-size:11px;color:#64748b}' +
        '</style></head><body>' +
        '<div class="hd"><div><h1>' + esc(store.storeName || store.name || 'Gogate Products') + '</h1><div class="muted">' + esc(addrText(store.storeAddress || store.address) || '') +
        (store.storeEmail ? '<br>' + esc(store.storeEmail) : '') + (store.storePhone ? ' · ' + esc(store.storePhone) : '') + (store.gstin ? '<br>GSTIN ' + esc(store.gstin) : '') + '</div></div>' +
        '<div class="r"><b>TAX INVOICE</b><br>Invoice no. <b>INV-' + esc(order.orderCode) + '</b><br>Order ID <b>' + esc(order.orderCode) + '</b><br>' + esc(date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })) + '</div></div>' +
        '<div class="cols"><div class="box"><b>Bill to / Ship to</b><br>' + esc(order.buyerName || '') + '<br>' + esc(addrText(order.deliveryAddress)) +
        (order.buyerPhone ? '<br>' + esc(order.buyerPhone) : '') + (order.buyerEmail ? '<br>' + esc(order.buyerEmail) : '') + '</div>' +
        '<div class="box"><b>Payment</b><br>' + esc(order.paymentMethod || order.paymentProvider || '—') + ' · ' + esc(order.paymentStatus || order.status || '') +
        (order.paymentId ? '<br>Ref ' + esc(order.paymentId) : '') + '<br><b>Shipping</b><br>' + esc(order.courierProvider || order.commerceProvider || 'Courier') +
        (order.courierTrackingNo || order.commerceAwb ? ' · AWB ' + esc(order.courierTrackingNo || order.commerceAwb) : '') + '</div></div>' +
        '<table><thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>' + rows +
        '<tr><td colspan="4" class="r">Subtotal</td><td class="r">' + money(sub) + '</td></tr>' +
        (ship ? '<tr><td colspan="4" class="r">Shipping &amp; handling</td><td class="r">' + money(ship) + '</td></tr>' : '') +
        '<tr class="tot"><td colspan="4" class="r">Total</td><td class="r">' + money(total) + '</td></tr></tbody></table>' +
        '<div class="ft">This is a computer-generated invoice and does not require a signature.</div></body></html>';
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
    loadCfg(db, (cfg) => {
        const jobs = [];
        if (INVOICE_EVENTS.includes(eventKey)) jobs.push(['invoice-' + order.orderCode, invoiceHtml(order, cfg)]);
        if (LABEL_EVENTS.includes(eventKey)) {
            const h = labelHtmlSafe(order, cfg, 'forward');
            if (h) jobs.push(['shipping-label-' + order.orderCode, h]);
        }
        const out = [];
        const step = () => {
            if (!jobs.length) return cb(out, cfg);
            const [name, html] = jobs.shift();
            toPdfAttachment(name, html, (e, att) => { if (att) out.push(att); step(); });
        };
        step();
    });
}

/** Mirror the buyer update to the store (sender) mailbox with the same attachments. */
function copyToSender(db, cfg, eventKey, order, attachments, cb) {
    const to = cfg && cfg.storeEmail;
    if (!to || !order) return cb && cb();
    let engine;
    try { engine = require('./notification-engine'); } catch (_) { return cb && cb(); }
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

module.exports = { invoiceHtml, attachmentsFor, copyToSender, emailReturnLabel };

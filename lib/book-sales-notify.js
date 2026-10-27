/**
 * Email / WhatsApp for book order lifecycle.
 */
const { getPortalUrls } = require('./portal-urls');
const { courierProviderLabel } = require('./book-courier-tracking');

function buildBookOrderNotifyVars(order, extraVars) {
    const urls = getPortalUrls();
    const lines = (order && order.items) || [];
    const itemsText = lines
        .filter((it) => (it.lineStatus || 'active') === 'active')
        .map((it) => (it.bookTitle || it.bookId) + ' · ' + (it.languageLabel || it.language) + ' × ' + it.qty)
        .join('<br>');

    const fulfillment = (order && order.fulfillmentType) || '';
    const trackingNo = (order && order.courierTrackingNo) || '';
    const provider = (order && order.courierProvider) || '';
    const providerLabel = provider ? courierProviderLabel(provider) : '';

    return Object.assign(
        {
            order_code: (order && order.orderCode) || '',
            book_order_id: order && order.id != null ? String(order.id) : '',
            order_status: (order && order.status) || '',
            order_total: order && order.totalAmount != null ? String(order.totalAmount) : '',
            order_items_html: itemsText || '—',
            fulfillment_type: fulfillment === 'courier' ? 'Courier delivery' : 'Counter pickup',
            shipping_recipient: (order && order.shippingRecipientName) || (order && order.buyerName) || '',
            shipping_phone: (order && order.shippingPhone) || (order && order.buyerPhone) || '',
            shipping_address:
                (order && order.deliveryAddress) ||
                [order && order.shippingCity, order && order.shippingState, order && order.shippingPincode]
                    .filter(Boolean)
                    .join(', ') ||
                '',
            shipping_pincode: (order && order.shippingPincode) || '',
            courier_provider: providerLabel || provider || '',
            tracking_no: trackingNo,
            awb: trackingNo,
            courier_charge:
                order && order.courierCharge != null ? '₹' + Number(order.courierCharge).toFixed(0) : '',
            parcel_summary:
                order && order.parcelWeightKg != null
                    ? Number(order.parcelWeightKg) +
                      ' kg · ' +
                      Number(order.parcelLengthCm || 25) +
                      '×' +
                      Number(order.parcelBreadthCm || 20) +
                      '×' +
                      Number(order.parcelHeightCm || 5) +
                      ' cm'
                    : '',
            track_status_label: (order && order.courierTrackLabel) || '',
            tracking_url: (function () {
                const { buildTrackShipmentUrl } = require('./book-shipment-track');
                const path = (order && order.commerceTrackUrl) || (order && order.courierTrackingNo ? buildTrackShipmentUrl({ orderCode: order.orderCode, awb: order.courierTrackingNo }) : '') || '';
                if (!path) return '';
                if (/^https?:\/\//i.test(path)) return path;
                return urls.seminar.replace(/\/$/, '') + (path.charAt(0) === '/' ? path : '/' + path);
            })(),
            doctor_portal_url: urls.doctor,
            staff_portal_url: urls.seminar + '/staff/login'
        },
        extraVars || {}
    );
}

function notifyBookOrder(db, eventKey, order, userId, extraVars, cb) {
    let notifEngine;
    try {
        notifEngine = require('./notification-engine');
    } catch (_) {
        return cb && cb(null);
    }
    if (!notifEngine || typeof notifEngine.notify !== 'function') return cb && cb(null);

    const vars = buildBookOrderNotifyVars(order, extraVars);
    const docs = require('./book-documents');

    docs.attachmentsFor(db, eventKey, order, (attachments, cfg) => {
        notifEngine.notify(
            db,
            eventKey,
            {
                userId: userId || (order && order.userId),
                contact: order ? { name: order.buyerName || order.shippingRecipientName, email: order.buyerEmail, phone: order.buyerPhone || order.shippingPhone } : null,
                seminarId: order && order.seminarId,
                vars,
                attachments: attachments || [],
                immediate: !!(extraVars && extraVars.immediate)
            },
            (err, r) => {
                if (!/^BOOK_ORDER_/.test(String(eventKey || ''))) return cb && cb(err, r);
                const withCfg = (c) => docs.copyToSender(db, c, eventKey, order, attachments || [], () => cb && cb(err, r));
                if (cfg) return withCfg(cfg);
                try { require('./commerce-routes').loadConfig(db, (e2, raw, c) => withCfg(e2 ? null : c)); } catch (_) { withCfg(null); }
            }
        );
    });
}

module.exports = { notifyBookOrder, buildBookOrderNotifyVars };

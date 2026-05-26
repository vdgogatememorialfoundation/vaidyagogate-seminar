/**
 * Email / WhatsApp for book order lifecycle.
 */
const { getPortalUrls } = require('./portal-urls');

function notifyBookOrder(db, eventKey, order, userId, extraVars, cb) {
    let notifEngine;
    try {
        notifEngine = require('./notification-engine');
    } catch (_) {
        return cb && cb(null);
    }
    if (!notifEngine || typeof notifEngine.notify !== 'function') return cb && cb(null);

    const urls = getPortalUrls();
    const lines = (order && order.items) || [];
    const itemsText = lines
        .filter((it) => (it.lineStatus || 'active') === 'active')
        .map((it) => (it.bookTitle || it.bookId) + ' · ' + (it.languageLabel || it.language) + ' × ' + it.qty)
        .join('<br>');

    const vars = Object.assign(
        {
            order_code: (order && order.orderCode) || '',
            book_order_id: order && order.id,
            order_status: (order && order.status) || '',
            order_total: order && order.totalAmount != null ? String(order.totalAmount) : '',
            order_items_html: itemsText || '—',
            doctor_portal_url: urls.doctor,
            staff_portal_url: urls.seminar + '/staff/login'
        },
        extraVars || {}
    );

    notifEngine.notify(
        db,
        eventKey,
        {
            userId: userId || (order && order.userId),
            seminarId: order && order.seminarId,
            vars
        },
        cb || (() => {})
    );
}

module.exports = { notifyBookOrder };

/**
 * Public branded URL for book courier shipment tracking.
 */
const TRACK_PATH = '/track-shipment';

function getPublicBaseUrl() {
    const raw =
        process.env.PUBLIC_TRACK_BASE_URL ||
        process.env.PUBLIC_BASE_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        '';
    return String(raw).trim().replace(/\/$/, '');
}

function trackShipmentPath() {
    return TRACK_PATH;
}

function buildTrackShipmentUrl(params) {
    const base = getPublicBaseUrl();
    const q = new URLSearchParams();
    const p = params && typeof params === 'object' ? params : {};
    if (p.orderCode || p.order) q.set('order', String(p.orderCode || p.order).trim());
    if (p.awb || p.tracking) q.set('awb', String(p.awb || p.tracking).trim());
    if (p.phoneLast4 || p.phone) q.set('phone', String(p.phoneLast4 || p.phone).replace(/\D/g, '').slice(-4));
    const qs = q.toString();
    const path = TRACK_PATH + (qs ? '?' + qs : '');
    return base ? base + path : path;
}

module.exports = {
    TRACK_PATH,
    trackShipmentPath,
    buildTrackShipmentUrl,
    getPublicBaseUrl
};

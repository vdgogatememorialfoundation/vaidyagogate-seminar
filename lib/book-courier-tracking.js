/**
 * Indian courier providers and public tracking URL builders (India Post, DTDC, etc.).
 */
const COURIER_PROVIDERS = [
    { id: 'indian_post', label: 'India Post / Speed Post / Registered' },
    { id: 'dtdc', label: 'DTDC' },
    { id: 'bluedart', label: 'Blue Dart' },
    { id: 'delhivery', label: 'Delhivery' },
    { id: 'ecom_express', label: 'Ecom Express' },
    { id: 'professional', label: 'Professional Couriers' },
    { id: 'xpressbees', label: 'Xpressbees' },
    { id: 'shadowfax', label: 'Shadowfax' },
    { id: 'ekart', label: 'Ekart' },
    { id: 'fedex', label: 'FedEx' },
    { id: 'dhl', label: 'DHL' },
    { id: 'amazon', label: 'Amazon Shipping' },
    { id: 'other', label: 'Other courier' }
];

const PROVIDER_LABELS = Object.fromEntries(COURIER_PROVIDERS.map((p) => [p.id, p.label]));

function courierProviderLabel(providerId) {
    const p = String(providerId || '').toLowerCase();
    return PROVIDER_LABELS[p] || providerId || 'Courier';
}

/**
 * External carrier page (optional). India Post has no reliable deep-link API — use in-portal scans instead.
 * @returns {{ url: string|null, manualAwb: string|null, portalOnly: boolean, note: string|null }}
 */
function courierExternalLink(provider, trackingNo) {
    const t = String(trackingNo || '').trim();
    const p = String(provider || '').toLowerCase();
    if (!t) return { url: null, manualAwb: null, portalOnly: true, note: null };
    if (p === 'indian_post' || p === 'speed_post') {
        return {
            url: 'https://www.indiapost.gov.in/VAS/Pages/trackconsignment.aspx',
            manualAwb: t,
            portalOnly: true,
            note:
                'India Post does not allow direct AWB links (captcha on their site). Enter AWB on their portal if needed — all courier scans are shown here in VGMF portal.'
        };
    }
    return {
        url: courierTrackingUrl(p, t),
        manualAwb: t,
        portalOnly: false,
        note: null
    };
}

/** Build a direct tracking URL for the AWB / consignment number (carrier sites that support deep links). */
function courierTrackingUrl(provider, trackingNo) {
    const t = String(trackingNo || '').trim();
    if (!t) return null;
    const enc = encodeURIComponent(t);
    const p = String(provider || '').toLowerCase();

    if (p === 'indian_post' || p === 'speed_post') {
        return 'https://www.indiapost.gov.in/VAS/Pages/trackconsignment.aspx';
    }
    if (p === 'dtdc') {
        return 'https://www.dtdc.in/tracking/tracking_results.asp?Ttype=awb_no&strCnno=' + enc;
    }
    if (p === 'bluedart') {
        return 'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo=' + enc;
    }
    if (p === 'delhivery') {
        return 'https://www.delhivery.com/track/package/' + enc;
    }
    if (p === 'ecom_express') {
        return 'https://ecomexpress.in/tracking/?awb_field=' + enc;
    }
    if (p === 'professional') {
        return 'http://www.professionalcouriers.in/p-tracking.asp?tracking_no=' + enc;
    }
    if (p === 'xpressbees') {
        return 'https://www.xpressbees.com/track?isWeb=1&track_id=' + enc;
    }
    if (p === 'shadowfax') {
        return 'https://tracker.shadowfax.in/#/tracking/' + enc;
    }
    if (p === 'ekart') {
        return 'https://ekartlogistics.com/shipment/track/' + enc;
    }
    if (p === 'fedex') {
        return 'https://www.fedex.com/fedextrack/?trknbr=' + enc;
    }
    if (p === 'dhl') {
        return 'https://www.dhl.com/in-en/home/tracking/tracking-express.html?submit=1&tracking-id=' + enc;
    }
    if (p === 'amazon') {
        return 'https://track.amazon.in/tracking/' + enc;
    }

    const label = courierProviderLabel(p);
    return (
        'https://www.google.com/search?q=' +
        encodeURIComponent(label + ' track ' + t)
    );
}

function buildDeliveryAddressLine(parts) {
    const line = String(parts.addressLine || parts.deliveryAddress || '').trim();
    const city = String(parts.city || parts.shippingCity || '').trim();
    const state = String(parts.state || parts.shippingState || '').trim();
    const pin = String(parts.pincode || parts.shippingPincode || '').trim();
    const chunks = [line, city, state, pin ? 'PIN ' + pin : ''].filter(Boolean);
    return chunks.join(', ');
}

module.exports = {
    COURIER_PROVIDERS,
    PROVIDER_LABELS,
    courierProviderLabel,
    courierTrackingUrl,
    courierExternalLink,
    buildDeliveryAddressLine
};

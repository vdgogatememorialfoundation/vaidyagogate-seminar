/**
 * Google Maps Embed API — venue display for seminars and sub-events.
 * Set GOOGLE_MAPS_API_KEY (Maps Embed API enabled) on the server.
 */
const TBD_RE = /^(tbd|t\.b\.d\.?|to be decided|venue tbd|not decided|na|n\/a|none|-)$/i;

function getApiKey() {
    return String(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY || '').trim();
}

function isVenueTbd(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return TBD_RE.test(t);
}

function isValidEmbedUrl(url) {
    const u = String(url || '').trim();
    return /^https?:\/\/(www\.)?google\.[a-z.]+\/maps\/embed/i.test(u);
}

function buildEmbedUrlFromQuery(query) {
    const key = getApiKey();
    const q = String(query || '').trim();
    if (!key || !q || isVenueTbd(q)) return '';
    return (
        'https://www.google.com/maps/embed/v1/place?key=' +
        encodeURIComponent(key) +
        '&q=' +
        encodeURIComponent(q)
    );
}

function resolveVenueFields({ locationText, locationUrl }) {
    const text = String(locationText || '').trim();
    const url = String(locationUrl || '').trim();

    if (isVenueTbd(text) && !url) {
        return { venueLabel: 'TBD', venueTbd: true, mapsEmbedUrl: '', locationText: text };
    }

    let embed = '';
    if (isValidEmbedUrl(url)) {
        embed = url;
    } else if (text && !isVenueTbd(text)) {
        embed = buildEmbedUrlFromQuery(text);
    }

    const venueLabel = isVenueTbd(text) ? 'TBD' : text || (embed ? 'View on map' : 'TBD');
    return {
        venueLabel,
        venueTbd: isVenueTbd(text) && !embed,
        mapsEmbedUrl: embed,
        locationText: text
    };
}

function normalizeLocationOnSave({ location_text, locationText, location_url, locationUrl }) {
    const textRaw = location_text != null ? location_text : locationText;
    const text = String(textRaw || '').trim() || null;
    let url = String(location_url || locationUrl || '').trim() || null;

    if (isVenueTbd(text)) {
        return { location_text: text, location_url: null };
    }

    if (text && !isValidEmbedUrl(url)) {
        const built = buildEmbedUrlFromQuery(text);
        if (built) url = built;
    }

    return { location_text: text, location_url: url };
}

function enrichEventRow(ev) {
    if (!ev) return ev;
    const locText = ev.locationText || ev.location_text || '';
    const locUrl = ev.locationUrl || ev.location_url || '';
    const resolved = resolveVenueFields({ locationText: locText, locationUrl: locUrl });
    return {
        ...ev,
        location_text: locText,
        locationText: locText,
        venue_label: resolved.venueLabel,
        venueLabel: resolved.venueLabel,
        venue_tbd: resolved.venueTbd,
        venueTbd: resolved.venueTbd,
        maps_embed_url: resolved.mapsEmbedUrl,
        mapsEmbedUrl: resolved.mapsEmbedUrl
    };
}

function enrichSeminarRow(row) {
    if (!row) return row;
    const resolved = resolveVenueFields({
        locationText: row.location_text,
        locationUrl: row.location_url
    });
    const subEvents = (row.sub_events || row.subEvents || []).map(enrichEventRow);
    return {
        ...row,
        location_text: row.location_text || '',
        venue_label: resolved.venueLabel,
        venue_tbd: resolved.venueTbd,
        maps_embed_url: resolved.mapsEmbedUrl,
        sub_events: subEvents,
        subEvents: subEvents
    };
}

function enrichSeminarRows(rows) {
    return (rows || []).map(enrichSeminarRow);
}

module.exports = {
    getApiKey,
    isVenueTbd,
    isValidEmbedUrl,
    buildEmbedUrlFromQuery,
    resolveVenueFields,
    normalizeLocationOnSave,
    enrichEventRow,
    enrichSeminarRow,
    enrichSeminarRows
};

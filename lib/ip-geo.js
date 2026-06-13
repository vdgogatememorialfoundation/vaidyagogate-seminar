/**
 * IP + browser geolocation lookup for Live Radar and support chat.
 * Set GOOGLE_MAPS_API_KEY on the server for reverse geocoding (lat/lng → city/state/country).
 */
const https = require('https');
const http = require('http');

function isPrivateIp(ip) {
    const clean = String(ip || '').trim().replace(/^::ffff:/i, '');
    if (!clean) return true;
    if (clean === '::1' || clean === 'localhost') return true;
    if (/^127\./.test(clean)) return true;
    if (/^10\./.test(clean)) return true;
    if (/^192\.168\./.test(clean)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
    if (/^fc|^fd|^fe80:/i.test(clean)) return true;
    return false;
}

function buildGeoLabel(city, region, country) {
    const parts = [city, region, country].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
}

function normalizeGeo(raw, ip) {
    if (!raw) return null;
    const city = raw.city || null;
    const region = raw.region || raw.regionName || null;
    const country = raw.country || raw.country_name || null;
    const lat = raw.lat != null ? raw.lat : raw.latitude != null ? raw.latitude : null;
    const lon = raw.lon != null ? raw.lon : raw.longitude != null ? raw.longitude : null;
    const label = raw.label || buildGeoLabel(city, region, country);
    if (!label && lat == null && lon == null) return null;
    return {
        label: label || null,
        city,
        region,
        country,
        lat: lat != null ? Number(lat) : null,
        lon: lon != null ? Number(lon) : null,
        isp: raw.isp || raw.org || null,
        ip: ip || raw.ip || null,
        source: raw.source || null
    };
}

function fetchJson(url, opts, cb) {
    const lib = url.indexOf('https:') === 0 ? https : http;
    const req = lib.get(url, { timeout: opts && opts.timeout ? opts.timeout : 4500 }, (res) => {
        let data = '';
        res.on('data', (c) => {
            data += c;
        });
        res.on('end', () => {
            try {
                cb(null, JSON.parse(data));
            } catch (_) {
                cb(null, null);
            }
        });
    });
    req.on('error', () => cb(null, null));
    req.on('timeout', () => {
        req.destroy();
        cb(null, null);
    });
}

function lookupIpWhoIs(ip, cb) {
    fetchJson('https://ipwho.is/' + encodeURIComponent(ip), { timeout: 4500 }, (err, j) => {
        if (!j || j.success === false) return cb(null, null);
        cb(
            null,
            normalizeGeo(
                {
                    city: j.city,
                    region: j.region,
                    country: j.country,
                    lat: j.latitude,
                    lon: j.longitude,
                    isp: j.connection && j.connection.isp,
                    source: 'ipwho.is'
                },
                ip
            )
        );
    });
}

function lookupIpApiCo(ip, cb) {
    fetchJson('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', { timeout: 4500 }, (err, j) => {
        if (!j || j.error) return cb(null, null);
        cb(
            null,
            normalizeGeo(
                {
                    city: j.city,
                    region: j.region,
                    country: j.country_name,
                    lat: j.latitude,
                    lon: j.longitude,
                    isp: j.org,
                    source: 'ipapi.co'
                },
                ip
            )
        );
    });
}

function lookupIpApiCom(ip, cb) {
    fetchJson(
        'http://ip-api.com/json/' +
            encodeURIComponent(ip) +
            '?fields=status,message,country,regionName,city,lat,lon,isp,query',
        { timeout: 4500 },
        (err, j) => {
            if (!j || j.status !== 'success') return cb(null, null);
            cb(
                null,
                normalizeGeo(
                    {
                        city: j.city,
                        region: j.regionName,
                        country: j.country,
                        lat: j.lat,
                        lon: j.lon,
                        isp: j.isp,
                        source: 'ip-api.com'
                    },
                    ip
                )
            );
        }
    );
}

function hasPlaceNames(geo) {
    return !!(geo && (geo.label || geo.city || geo.country));
}

function enrichGeoPlaceNames(geo, cb) {
    if (!geo) return cb(null, null);
    if (hasPlaceNames(geo)) return cb(null, geo);
    if (geo.lat == null || geo.lon == null) return cb(null, geo);
    reverseGeocodeGoogle(geo.lat, geo.lon, (err, enriched) => {
        if (enriched && hasPlaceNames(enriched)) {
            cb(
                null,
                normalizeGeo(
                    {
                        label: enriched.label,
                        city: enriched.city,
                        region: enriched.region,
                        country: enriched.country,
                        lat: geo.lat,
                        lon: geo.lon,
                        isp: geo.isp,
                        source: enriched.source || geo.source
                    },
                    geo.ip
                )
            );
            return;
        }
        cb(null, geo);
    });
}

function lookupIpGeo(ip, cb) {
    const clean = String(ip || '').trim().replace(/^::ffff:/i, '');
    if (!clean || isPrivateIp(clean)) return cb(null, null);

    lookupIpWhoIs(clean, (err1, geo1) => {
        if (geo1 && hasPlaceNames(geo1)) return cb(null, geo1);
        lookupIpApiCo(clean, (err2, geo2) => {
            if (geo2 && hasPlaceNames(geo2)) return cb(null, geo2);
            lookupIpApiCom(clean, (err3, geo3) => {
                enrichGeoPlaceNames(geo3 || geo2 || geo1 || null, cb);
            });
        });
    });
}

function reverseGeocodeGoogle(lat, lon, cb) {
    const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
    if (!key) return cb(null, null);
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return cb(null, null);

    const url =
        'https://maps.googleapis.com/maps/api/geocode/json?latlng=' +
        encodeURIComponent(latN + ',' + lonN) +
        '&key=' +
        encodeURIComponent(key);

    fetchJson(url, { timeout: 6000 }, (err, j) => {
        if (!j || j.status !== 'OK' || !j.results || !j.results[0]) {
            if (j && j.status && j.status !== 'OK') {
                console.warn('[ip-geo] Google geocode:', j.status, j.error_message || '');
            }
            return cb(null, null);
        }
        const result = j.results[0];
        const comps = result.address_components || [];
        let city = null;
        let region = null;
        let country = null;
        comps.forEach(function (c) {
            const types = c.types || [];
            if (types.indexOf('locality') !== -1) city = c.long_name;
            else if (!city && types.indexOf('administrative_area_level_2') !== -1) city = c.long_name;
            if (types.indexOf('administrative_area_level_1') !== -1) region = c.long_name;
            if (types.indexOf('country') !== -1) country = c.long_name;
        });
        const loc = result.geometry && result.geometry.location;
        cb(
            null,
            normalizeGeo(
                {
                    label: buildGeoLabel(city, region, country) || result.formatted_address,
                    city,
                    region,
                    country,
                    lat: loc && loc.lat != null ? loc.lat : latN,
                    lon: loc && loc.lng != null ? loc.lng : lonN,
                    source: 'google_geocode'
                },
                null
            )
        );
    });
}

function parseClientGeo(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lat = raw.lat != null ? parseFloat(raw.lat) : raw.latitude != null ? parseFloat(raw.latitude) : null;
    const lon =
        raw.lon != null
            ? parseFloat(raw.lon)
            : raw.lng != null
              ? parseFloat(raw.lng)
              : raw.longitude != null
                ? parseFloat(raw.longitude)
                : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, accuracy: raw.accuracy != null ? raw.accuracy : null };
}

function resolveVisitorGeo(opts, cb) {
    const ip = opts && opts.ip ? String(opts.ip).trim().replace(/^::ffff:/i, '') : '';
    const clientGeo = parseClientGeo(opts && opts.clientGeo);

    if (clientGeo) {
        return reverseGeocodeGoogle(clientGeo.lat, clientGeo.lon, (gErr, geo) => {
            if (geo && hasPlaceNames(geo)) {
                geo.accuracy = clientGeo.accuracy;
                geo.source = geo.source || 'browser_geolocation';
                return cb(null, geo);
            }
            lookupIpGeo(ip, (ipErr, ipGeoResult) => {
                if (ipGeoResult) {
                    ipGeoResult.lat = clientGeo.lat;
                    ipGeoResult.lon = clientGeo.lon;
                    ipGeoResult.accuracy = clientGeo.accuracy;
                    ipGeoResult.source = 'browser_geolocation';
                    return cb(null, ipGeoResult);
                }
                cb(
                    null,
                    normalizeGeo(
                        {
                            lat: clientGeo.lat,
                            lon: clientGeo.lon,
                            label: buildGeoLabel(null, null, null) || 'GPS location',
                            source: 'browser_geolocation'
                        },
                        ip || null
                    )
                );
            });
        });
    }

    lookupIpGeo(ip, cb);
}

function hasUsableGeo(geoJson) {
    if (!geoJson) return false;
    let g = geoJson;
    if (typeof geoJson === 'string') {
        try {
            g = JSON.parse(geoJson);
        } catch (_) {
            return false;
        }
    }
    return hasPlaceNames(g);
}

module.exports = {
    isPrivateIp,
    buildGeoLabel,
    normalizeGeo,
    lookupIpGeo,
    reverseGeocodeGoogle,
    resolveVisitorGeo,
    hasUsableGeo,
    parseClientGeo
};

'use strict';

const https = require('https');

const CITY_CODES = {
    pune: 'PNQ', mumbai: 'BOM', delhi: 'DEL', 'new delhi': 'DEL', bengaluru: 'BLR', bangalore: 'BLR', hyderabad: 'HYD', chennai: 'MAA',
    kolkata: 'CCU', ahmedabad: 'AMD', surat: 'STV', jaipur: 'JAI', lucknow: 'LKO', nagpur: 'NAG', indore: 'IDR', bhopal: 'BHO', patna: 'PAT',
    vadodara: 'BDQ', goa: 'GOI', panaji: 'GOI', kochi: 'COK', thiruvananthapuram: 'TRV', coimbatore: 'CJB', madurai: 'IXM', visakhapatnam: 'VTZ',
    vijayawada: 'VGA', bhubaneswar: 'BBI', raipur: 'RPR', ranchi: 'IXR', guwahati: 'GAU', chandigarh: 'IXC', amritsar: 'ATQ', dehradun: 'DED',
    srinagar: 'SXR', jammu: 'IXJ', varanasi: 'VNS', kanpur: 'KNU', agra: 'AGR', udaipur: 'UDR', jodhpur: 'JDH', rajkot: 'RAJ', aurangabad: 'IXU',
    nashik: 'ISK', kolhapur: 'KLH', solapur: 'SSE', ratnagiri: 'RTC', sindhudurg: 'SDW', nanded: 'NDC', mangaluru: 'IXE', mangalore: 'IXE',
    hubli: 'HBX', mysuru: 'MYQ', mysore: 'MYQ', tiruchirappalli: 'TRZ', trichy: 'TRZ', salem: 'SXV', tirupati: 'TIR', hoskote: 'HSK',
    khed: 'KHD', dapoli: 'DPL', chiplun: 'CPL', satara: 'STR', sangli: 'SGL', thane: 'THN', 'navi mumbai': 'NVM', noida: 'NDA', gurugram: 'GGN', gurgaon: 'GGN',
    ghaziabad: 'GZB', faridabad: 'FBD', ludhiana: 'LUH', jalandhar: 'JLR', meerut: 'MRT', gwalior: 'GWL', jabalpur: 'JLR', dhanbad: 'DBD',
    siliguri: 'IXB', imphal: 'IMF', agartala: 'IXA', aizawl: 'AJL', shillong: 'SHL', dibrugarh: 'DIB', puducherry: 'PNY', belagavi: 'IXG', belgaum: 'IXG'
};

function hubCode(cityOrName) {
    const raw = String(cityOrName || '').trim();
    if (!raw) return '';
    const parts = raw.split(' - ').map((p) => p.replace(/,.*$/, '').trim()).filter(Boolean);
    const tail = parts[parts.length - 1] || '';
    const usable = parts.length > 1 && !/^[ivx\d]+$/i.test(tail) && tail.replace(/[^a-z]/gi, '').length >= 3 ? tail : parts[0] || '';
    const city = usable.toLowerCase();
    if (CITY_CODES[city]) return CITY_CODES[city];
    const key = Object.keys(CITY_CODES).find((k) => city.includes(k));
    if (key) return CITY_CODES[key];
    const letters = city.replace(/[^a-z]/g, '');
    if (!letters) return '';
    const cons = letters.charAt(0) + letters.slice(1).replace(/[aeiou]/g, '');
    return (cons.length >= 3 ? cons.slice(0, 3) : (letters + 'XXX').slice(0, 3)).toUpperCase();
}

function haversineKm(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some((v) => !Number.isFinite(Number(v)))) return null;
    const r = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return Math.round(r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getJson(url, timeoutMs) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: timeoutMs || 6000 }, (res) => {
            let buf = '';
            res.on('data', (d) => (buf += d));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(buf));
                } catch (_) {
                    resolve(null);
                }
            });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
    });
}

const cache = new Map();
function cached(key, ttlMs, loader) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);
    return loader().then((value) => {
        if (value) cache.set(key, { value, exp: Date.now() + ttlMs });
        return value;
    });
}

async function geocode(city, state) {
    const name = String(city || '').trim();
    if (!name) return null;
    return cached('geo:' + name.toLowerCase(), 7 * 24 * 3600e3, async () => {
        const data = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' + encodeURIComponent(name));
        const list = (data && data.results) || [];
        const india = list.filter((r) => r.country_code === 'IN');
        const pick = india.find((r) => state && String(r.admin1 || '').toLowerCase() === String(state).toLowerCase()) || india[0] || list[0];
        return pick ? { lat: pick.latitude, lng: pick.longitude, name: pick.name } : null;
    });
}

const WMO = [
    [0, 'Clear sky', 'sun'], [1, 'Mainly clear', 'sun'], [2, 'Partly cloudy', 'cloud-sun'], [3, 'Overcast', 'cloud'],
    [45, 'Fog', 'fog'], [48, 'Rime fog', 'fog'], [51, 'Light drizzle', 'drizzle'], [53, 'Drizzle', 'drizzle'], [55, 'Heavy drizzle', 'drizzle'],
    [61, 'Light rain', 'rain'], [63, 'Rain', 'rain'], [65, 'Heavy rain', 'rain'], [66, 'Freezing rain', 'rain'], [67, 'Freezing rain', 'rain'],
    [71, 'Light snow', 'snow'], [73, 'Snow', 'snow'], [75, 'Heavy snow', 'snow'], [77, 'Snow grains', 'snow'],
    [80, 'Rain showers', 'rain'], [81, 'Rain showers', 'rain'], [82, 'Violent showers', 'storm'], [85, 'Snow showers', 'snow'], [86, 'Snow showers', 'snow'],
    [95, 'Thunderstorm', 'storm'], [96, 'Thunderstorm with hail', 'storm'], [99, 'Thunderstorm with hail', 'storm']
];
function describeWmo(code) {
    const row = WMO.find((r) => r[0] === Number(code)) || [0, 'Clear', 'sun'];
    return { label: row[1], icon: row[2] };
}

async function weatherAt(lat, lng, label) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
    const key = 'wx:' + Number(lat).toFixed(2) + ',' + Number(lng).toFixed(2);
    return cached(key, 30 * 60e3, async () => {
        const url =
            'https://api.open-meteo.com/v1/forecast?latitude=' + Number(lat).toFixed(4) + '&longitude=' + Number(lng).toFixed(4) +
            '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FKolkata&forecast_days=7';
        const data = await getJson(url);
        if (!data || !data.current) return null;
        const cur = describeWmo(data.current.weather_code);
        const daily = data.daily || {};
        const days = (daily.time || []).map((day, i) => {
            const d = describeWmo((daily.weather_code || [])[i]);
            return {
                date: day,
                label: d.label,
                icon: d.icon,
                max: Math.round((daily.temperature_2m_max || [])[i]),
                min: Math.round((daily.temperature_2m_min || [])[i]),
                rain: (daily.precipitation_probability_max || [])[i]
            };
        });
        return {
            place: label || '',
            temp: Math.round(data.current.temperature_2m),
            humidity: data.current.relative_humidity_2m,
            wind: Math.round(data.current.wind_speed_10m),
            isDay: data.current.is_day !== 0,
            label: cur.label,
            icon: cur.icon,
            days
        };
    });
}

function weatherImpact(wx, expectedIso) {
    if (!wx) return '';
    let day = null;
    if (expectedIso) {
        const d = String(expectedIso).slice(0, 10);
        day = (wx.days || []).find((x) => x.date === d) || null;
    }
    const target = day || { icon: wx.icon, rain: null, label: wx.label };
    if (target.icon === 'storm') return 'Thunderstorms forecast at the destination — the courier may run a little late.';
    if (target.icon === 'rain' && (target.rain == null || target.rain >= 60)) return 'Rain is likely at the destination — allow some extra time for delivery.';
    if (target.icon === 'fog') return 'Fog at the destination may slow down the morning run.';
    if (target.icon === 'snow') return 'Snow at the destination — delivery may be delayed.';
    return 'Weather looks fine along the route — no delays expected.';
}

async function buildJourney(order, cfg, opts) {
    const options = opts || {};
    const ret = !!options.returnLeg;
    const shop = (cfg && cfg.shop) || {};
    const storeCity = (cfg && cfg.storeCity) || shop.storeCity || 'Pune';
    const custCity = order.shippingCity || '';
    const hubs = (ret ? order.returnHubs : order.hubs) || [];
    const storeLat = order.storeLat != null ? order.storeLat : cfg && cfg.storeLat;
    const storeLng = order.storeLng != null ? order.storeLng : cfg && cfg.storeLng;
    let dropLat = order.dropLat;
    let dropLng = order.dropLng;
    if (dropLat == null && custCity) {
        const g = await geocode(custCity, order.shippingState).catch(() => null);
        if (g) {
            dropLat = g.lat;
            dropLng = g.lng;
        }
    }
    const from = ret ? { city: custCity, code: hubCode(custCity), lat: dropLat, lng: dropLng, kind: 'Customer' } : { city: storeCity, code: hubCode(storeCity), lat: storeLat, lng: storeLng, kind: 'Store' };
    const to = ret ? { city: storeCity, code: hubCode(storeCity), lat: storeLat, lng: storeLng, kind: 'Store' } : { city: custCity, code: hubCode(custCity), lat: dropLat, lng: dropLng, kind: 'Destination' };
    const parcel = ret ? order.returnParcelInfo : order.parcelInfo;
    const [wxFrom, wxTo] = await Promise.all([weatherAt(from.lat, from.lng, from.city).catch(() => null), weatherAt(to.lat, to.lng, to.city).catch(() => null)]);
    const expected = ret ? order.returnExpectedAt : order.deliveryAt || order.commerceDeliveryAt || order.expectedDeliveryAt;
    return {
        from: { city: from.city, code: from.code, kind: from.kind },
        to: { city: to.city, code: to.code, kind: to.kind },
        hubs: hubs.map((h) => ({ name: h.name, city: h.city || '', code: hubCode(h.city || h.name), id: h.id || null, at: h.at || null, done: !!h.done })),
        distanceKm: haversineKm(from.lat, from.lng, to.lat, to.lng),
        parcel: parcel && (parcel.parcelId || parcel.code) ? { id: parcel.parcelId || '', code: parcel.code || '', tasks: (parcel.tasks || []).length } : null,
        weather: { from: wxFrom, to: wxTo, impact: weatherImpact(wxTo, expected) }
    };
}

module.exports = { hubCode, buildJourney, weatherAt, haversineKm };

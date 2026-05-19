const axios = require('axios');

const PINCODE_API = 'https://api.postalpincode.in/pincode';

/**
 * Look up Indian PIN code via India Post public API (proxied server-side).
 * @param {string} pin
 * @returns {Promise<{ ok: boolean, pin?: string, cities?: string[], states?: string[], country?: string, error?: string }>}
 */
async function lookupPincode(pin) {
    const clean = String(pin || '').replace(/\D/g, '');
    if (clean.length !== 6) {
        return { ok: false, error: 'PIN must be 6 digits' };
    }

    try {
        const { data: raw } = await axios.get(`${PINCODE_API}/${clean}`, {
            timeout: 12000,
            headers: { Accept: 'application/json' }
        });

        const data = Array.isArray(raw) ? raw[0] : raw;
        if (!data || data.Status !== 'Success' || !Array.isArray(data.PostOffice) || !data.PostOffice.length) {
            return { ok: false, error: (data && data.Message) || 'PIN not found' };
        }

        const cities = [...new Set(data.PostOffice.map((p) => p.District).filter(Boolean))].sort((a, b) =>
            a.localeCompare(b)
        );
        const states = [...new Set(data.PostOffice.map((p) => p.State).filter(Boolean))].sort((a, b) =>
            a.localeCompare(b)
        );
        const country = data.PostOffice[0].Country || 'India';

        return { ok: true, pin: clean, cities, states, country };
    } catch (err) {
        return { ok: false, error: 'PIN lookup service unavailable' };
    }
}

module.exports = { lookupPincode };

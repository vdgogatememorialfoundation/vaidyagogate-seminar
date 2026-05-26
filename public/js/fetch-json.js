/**
 * fetch() + safe JSON parse — avoids "Unexpected token" when API returns HTML/plain text.
 */
(function (global) {
    'use strict';

    async function fetchJson(url, opts) {
        const res = await global.fetch(url, opts);
        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                const snippet = String(text)
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 200);
                const err = new Error(
                    snippet.startsWith('<')
                        ? 'API unavailable (received a web page instead of JSON). Confirm api.vaidyagogate.org is deployed and reachable.'
                        : snippet || res.statusText || 'Request failed'
                );
                err.httpStatus = res.status;
                throw err;
            }
        }
        return { res, data };
    }

    global.fetchJson = fetchJson;
})(typeof window !== 'undefined' ? window : global);

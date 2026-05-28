/**
 * Optional API base URL when static frontend calls a separate API host.
 * - Empty apiBase: browser uses same-origin /api/...
 * - Set meta name="api-base" or /api-config.json apiBase for cross-origin API host.
 */
(function (global) {
    'use strict';

    function normalizeBase(base) {
        const b = String(base || '').trim().replace(/\/$/, '');
        return b;
    }

    function readMetaBase() {
        const meta = document.querySelector('meta[name="api-base"]');
        return meta && meta.getAttribute('content') ? meta.getAttribute('content') : '';
    }

    let configuredBase = normalizeBase(readMetaBase());

    function applyFetchShim() {
        if (!configuredBase) return;
        const orig = global.fetch.bind(global);
        global.fetch = function (input, init) {
            if (typeof input === 'string' && input.startsWith('/api/')) {
                input = configuredBase + input;
            } else if (input && input.url && String(input.url).startsWith('/api/')) {
                input = new Request(configuredBase + input.url, input);
            }
            return orig(input, init);
        };
    }

    function boot() {
        applyFetchShim();
        global.__API_BASE__ = configuredBase;
    }

    // Load /api-config.json if meta not set (generated at build time).
    if (!configuredBase) {
        fetch('/api-config.json', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => {
                if (cfg && cfg.apiBase) configuredBase = normalizeBase(cfg.apiBase);
                boot();
            })
            .catch(() => boot());
    } else {
        boot();
    }
})(typeof window !== 'undefined' ? window : global);

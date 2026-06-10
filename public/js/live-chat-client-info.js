/**
 * Collects device/network diagnostics for live chat (no location permission prompt).
 */
(function (global) {
    function collect() {
        const nav = global.navigator || {};
        const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
        const out = {
            userAgent: nav.userAgent || null,
            language: nav.language || null,
            platform: nav.platform || null,
            timezone: (function () {
                try {
                    return Intl.DateTimeFormat().resolvedOptions().timeZone;
                } catch (_) {
                    return null;
                }
            })(),
            screen: {
                width: global.screen && global.screen.width,
                height: global.screen && global.screen.height,
                dpr: global.devicePixelRatio || 1
            },
            online: nav.onLine !== false,
            collectedAt: new Date().toISOString()
        };
        if (conn) {
            out.network = {
                downlinkMbps: conn.downlink != null ? conn.downlink : null,
                effectiveType: conn.effectiveType || null,
                rttMs: conn.rtt != null ? conn.rtt : null,
                saveData: !!conn.saveData
            };
        }
        return out;
    }

    global.LiveChatClientInfo = { collect };
})(typeof window !== 'undefined' ? window : global);

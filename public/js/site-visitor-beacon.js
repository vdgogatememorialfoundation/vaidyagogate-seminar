/**
 * Sends periodic heartbeats so admin can see live visitors (page, device, location).
 */
(function (global) {
    const KEY = 'vgmf_visitor_session';

    function sessionId() {
        try {
            let id = sessionStorage.getItem(KEY);
            if (!id) {
                id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                sessionStorage.setItem(KEY, id);
            }
            return id;
        } catch (_) {
            return 'anon_' + Date.now();
        }
    }

    function collectDiagnostics() {
        if (global.LiveChatClientInfo && typeof global.LiveChatClientInfo.collect === 'function') {
            return global.LiveChatClientInfo.collect();
        }
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            online: navigator.onLine,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            screen: { width: screen.width, height: screen.height }
        };
    }

    function userContext() {
        const out = { userId: null, userLabel: null };
        try {
            if (global.PortalAuth && global.PortalAuth.getUser) {
                const portals = ['doctor', 'admin', 'judge', 'scanner', 'staff', 'support'];
                for (let i = 0; i < portals.length; i++) {
                    const u = global.PortalAuth.getUser(portals[i]);
                    if (u && u.id) {
                        out.userId = u.id;
                        out.userLabel =
                            [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
                            u.user_id_string ||
                            u.email ||
                            portals[i];
                        break;
                    }
                }
            }
        } catch (_) {}
        return out;
    }

    function sendHeartbeat() {
        const ctx = userContext();
        fetch('/api/public/visitor-heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: sessionId(),
                path: global.location.pathname + global.location.hash,
                referrer: document.referrer || '',
                userId: ctx.userId,
                userLabel: ctx.userLabel,
                clientDiagnostics: collectDiagnostics()
            })
        }).catch(function () {});
    }

    function boot() {
        sendHeartbeat();
        if (global.__vgmfVisitorTimer) clearInterval(global.__vgmfVisitorTimer);
        global.__vgmfVisitorTimer = setInterval(sendHeartbeat, 30000);
        global.addEventListener('hashchange', sendHeartbeat);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    global.SiteVisitorBeacon = { sendHeartbeat, sessionId };
})(typeof window !== 'undefined' ? window : global);

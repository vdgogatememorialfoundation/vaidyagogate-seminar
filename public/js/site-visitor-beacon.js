/**
 * Realtime activity beacon — seminar applications, payments, browsing.
 */
(function (global) {
    const KEY = 'vgmf_visitor_session';
    let activityState = { kind: 'browse', formProgress: 0 };
    let fastMode = false;

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

    function currentPath() {
        return global.location.pathname + global.location.hash;
    }

    function inferActivityFromDom() {
        const path = currentPath();
        if (path.indexOf('/doctor') !== -1) {
            const form = document.getElementById('multi-step-form');
            if (form && !form.classList.contains('hidden')) {
                let step = 0;
                document.querySelectorAll('.form-step').forEach(function (el, idx) {
                    if (!el.classList.contains('hidden')) step = idx;
                });
                const titleEl = document.getElementById('registration-seminar-name');
                const title = titleEl ? String(titleEl.innerText || '').replace(/^Registering for:\s*/i, '').trim() : '';
                return {
                    kind: 'seminar_apply',
                    stepNumber: step,
                    stepLabel: null,
                    seminarTitle: title || activityState.seminarTitle || null,
                    seminarId: activityState.seminarId || null,
                    formProgress: Math.round((step / 5) * 100)
                };
            }
            if (path.indexOf('tab-applications') !== -1) return { kind: 'track_applications', formProgress: 0 };
            if (path.indexOf('tab-seminars') !== -1 || path.indexOf('seminar') !== -1) {
                return { kind: 'browse_seminars', formProgress: 0 };
            }
            return { kind: 'doctor_portal', formProgress: 0 };
        }
        if (path === '/' || path.indexOf('index') !== -1) return { kind: 'homepage', formProgress: 0 };
        return { kind: 'browse', formProgress: 0 };
    }

    function mergedActivity() {
        const inferred = inferActivityFromDom();
        const merged = Object.assign({}, inferred, activityState);
        if (activityState.kind && activityState.kind !== 'browse') merged.kind = activityState.kind;
        if (merged.kind === 'seminar_apply' || merged.kind === 'payment') fastMode = true;
        else if (merged.kind === 'browse' || merged.kind === 'homepage') fastMode = false;
        return merged;
    }

    function heartbeatIntervalMs() {
        if (fastMode || activityState.kind === 'seminar_apply' || activityState.kind === 'payment') return 5000;
        return 12000;
    }

    function scheduleTimer() {
        if (global.__vgmfVisitorTimer) clearInterval(global.__vgmfVisitorTimer);
        global.__vgmfVisitorTimer = setInterval(sendHeartbeat, heartbeatIntervalMs());
    }

    function sendHeartbeat() {
        const ctx = userContext();
        const activity = mergedActivity();
        fetch('/api/public/visitor-heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: sessionId(),
                path: currentPath(),
                referrer: document.referrer || '',
                userId: ctx.userId,
                userLabel: ctx.userLabel,
                activity: activity,
                clientDiagnostics: collectDiagnostics()
            })
        }).catch(function () {});
        scheduleTimer();
    }

    function setActivity(partial) {
        activityState = Object.assign({}, activityState, partial || {});
        if (partial && partial.kind === 'browse') {
            activityState.seminarId = null;
            activityState.seminarTitle = null;
            activityState.stepNumber = null;
            activityState.stepLabel = null;
            activityState.formProgress = 0;
        }
        sendHeartbeat();
    }

    function boot() {
        sendHeartbeat();
        scheduleTimer();
        global.addEventListener('hashchange', sendHeartbeat);
        global.addEventListener('visibilitychange', function () {
            if (!document.hidden) sendHeartbeat();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    global.SiteVisitorBeacon = {
        sendHeartbeat,
        setActivity,
        sessionId,
        getActivity: function () {
            return mergedActivity();
        }
    };
})(typeof window !== 'undefined' ? window : global);

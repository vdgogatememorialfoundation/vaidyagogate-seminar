/**
 * Site-wide realtime activity beacon — doctor portal + public website visitors.
 */
(function (global) {
    const pathNorm = String(global.location.pathname || '').replace(/\/+$/, '');
    const isDoctorPortal =
        pathNorm === '/doctor' || pathNorm.endsWith('/doctor') || /\/doctor\.html$/i.test(pathNorm);
    const SESSION_KEY = isDoctorPortal ? 'vgmf_doctor_radar_session' : 'vgmf_site_radar_session';

    let activityState = { kind: isDoctorPortal ? 'doctor_portal' : 'homepage', formProgress: 0 };
    let started = false;
    let cachedClientGeo = null;
    let geoRequested = false;

    function sessionId() {
        try {
            let id = sessionStorage.getItem(SESSION_KEY);
            if (!id) {
                id = (isDoctorPortal ? 'dr_' : 'sv_') + Math.random().toString(36).slice(2) + Date.now().toString(36);
                sessionStorage.setItem(SESSION_KEY, id);
            }
            return id;
        } catch (_) {
            return (isDoctorPortal ? 'dr_' : 'sv_') + Date.now();
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
            screen: { width: screen.width, height: screen.height },
            viewport: { width: innerWidth, height: innerHeight }
        };
    }

    function userContext() {
        const out = { userId: null, userLabel: null };
        try {
            if (global.PortalAuth && global.PortalAuth.getUser) {
                const portals = isDoctorPortal
                    ? ['doctor']
                    : ['doctor', 'admin', 'judge', 'scanner', 'staff', 'support'];
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
        if (!out.userLabel && !isDoctorPortal) out.userLabel = 'Site visitor';
        return out;
    }

    function currentPath() {
        return global.location.pathname + global.location.hash;
    }

    function visibleRegistrationStep() {
        const steps = document.querySelectorAll('.form-step');
        for (let i = 0; i < steps.length; i++) {
            if (!steps[i].classList.contains('hidden')) return i;
        }
        return null;
    }

    function inferDoctorActivity() {
        const form = document.getElementById('multi-step-form');
        if (form && !form.classList.contains('hidden')) {
            const step = visibleRegistrationStep();
            const stepNum = step != null ? step : 0;
            const titleEl = document.getElementById('registration-seminar-name');
            const title = titleEl
                ? String(titleEl.innerText || '')
                      .replace(/^(Registering for:|Waiting list —|Draft —)\s*/i, '')
                      .trim()
                : '';
            return {
                kind: 'seminar_apply',
                stepNumber: stepNum,
                seminarTitle: title || activityState.seminarTitle || null,
                seminarId: activityState.seminarId || null,
                formProgress: Math.round((stepNum / 5) * 100)
            };
        }
        const hash = String(global.location.hash || '').toLowerCase();
        if (hash.indexOf('tab-applications') !== -1) return { kind: 'track_applications', formProgress: 0 };
        if (hash.indexOf('tab-seminars') !== -1) return { kind: 'browse_seminars', formProgress: 0 };
        return { kind: 'doctor_portal', formProgress: 0 };
    }

    function inferPublicActivity() {
        const p = currentPath().toLowerCase();
        if (p === '/' || p === '/index.html' || p.endsWith('/index')) {
            if (p.indexOf('#signup') !== -1 || p.indexOf('signup') !== -1) {
                return { kind: 'signup', stepLabel: 'Sign up', formProgress: 0 };
            }
            if (p.indexOf('#login') !== -1 || p.indexOf('login') !== -1) {
                return { kind: 'login', stepLabel: 'Sign in', formProgress: 0 };
            }
            return { kind: 'homepage', stepLabel: 'Homepage', formProgress: 0 };
        }
        if (p.indexOf('/verify-certificate') !== -1) {
            return { kind: 'verify_certificate', stepLabel: 'Verify certificate', formProgress: 0 };
        }
        if (p.indexOf('/track-shipment') !== -1) {
            return { kind: 'track_shipment', stepLabel: 'Track shipment', formProgress: 0 };
        }
        if (p.indexOf('/legal') !== -1) {
            return { kind: 'legal', stepLabel: 'Legal pages', formProgress: 0 };
        }
        if (p.indexOf('/live-chat') !== -1 || p.indexOf('/support') !== -1) {
            return { kind: 'support', stepLabel: 'Support', formProgress: 0 };
        }
        if (p.indexOf('/admin') !== -1) {
            return { kind: 'admin', stepLabel: 'Admin portal', formProgress: 0 };
        }
        return { kind: 'browse', stepLabel: 'Browsing site', formProgress: 0 };
    }

    function mergedActivity() {
        const inferred = isDoctorPortal ? inferDoctorActivity() : inferPublicActivity();
        const merged = Object.assign({}, inferred, activityState);
        if (activityState.kind === 'payment') merged.kind = 'payment';
        else if (isDoctorPortal && (activityState.kind === 'seminar_apply' || inferred.kind === 'seminar_apply')) {
            merged.kind = 'seminar_apply';
        } else if (inferred.kind) merged.kind = inferred.kind;
        return merged;
    }

    function heartbeatMs() {
        const k = mergedActivity().kind;
        if (k === 'seminar_apply' || k === 'payment') return 4000;
        if (k === 'signup' || k === 'login') return 6000;
        return isDoctorPortal ? 8000 : 10000;
    }

    function scheduleTimer() {
        if (global.__siteRadarTimer) clearInterval(global.__siteRadarTimer);
        global.__siteRadarTimer = setInterval(sendHeartbeat, heartbeatMs());
    }

    function requestClientGeo(cb) {
        if (cachedClientGeo) return cb(cachedClientGeo);
        if (geoRequested || !navigator.geolocation) return cb(null);
        geoRequested = true;
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                cachedClientGeo = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                };
                cb(cachedClientGeo);
            },
            function () {
                cb(null);
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
        );
    }

    function sendHeartbeat() {
        const ctx = userContext();
        const activity = mergedActivity();
        requestClientGeo(function (clientGeo) {
            const payload = {
                sessionId: sessionId(),
                path: currentPath(),
                pageTitle: document.title || '',
                referrer: document.referrer || '',
                userId: ctx.userId,
                userLabel: ctx.userLabel,
                activity: activity,
                clientDiagnostics: collectDiagnostics()
            };
            if (clientGeo) payload.clientGeo = clientGeo;
            fetch('/api/public/visitor-heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                keepalive: true,
                body: JSON.stringify(payload)
            })
                .then(function (r) {
                    return r.json();
                })
                .then(function (d) {
                    if (d && d.skipped) {
                        console.warn('[site-radar] heartbeat skipped — server could not store session');
                    }
                })
                .catch(function () {});
            scheduleTimer();
        });
    }

    function setActivity(partial) {
        activityState = Object.assign({}, activityState, partial || {});
        sendHeartbeat();
    }

    function boot() {
        if (started) return;
        started = true;
        sendHeartbeat();
        scheduleTimer();
        global.addEventListener('hashchange', sendHeartbeat);
        global.addEventListener('visibilitychange', function () {
            if (!document.hidden) sendHeartbeat();
        });
        global.addEventListener('focus', sendHeartbeat);
    }

    global.SiteVisitorBeacon = {
        sendHeartbeat: sendHeartbeat,
        setActivity: setActivity,
        sessionId: sessionId,
        getActivity: mergedActivity,
        boot: boot,
        isDoctorPortal: isDoctorPortal
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(typeof window !== 'undefined' ? window : global);

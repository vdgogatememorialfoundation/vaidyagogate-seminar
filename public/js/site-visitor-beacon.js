/**
 * Doctor portal only — realtime seminar application tracking beacon.
 */
(function (global) {
    const path = String(global.location.pathname || '').replace(/\/+$/, '');
    const isDoctorPortal = path === '/doctor' || path.endsWith('/doctor') || /\/doctor\.html$/i.test(path);
    if (!isDoctorPortal) return;

    const KEY = 'vgmf_doctor_radar_session';
    let activityState = { kind: 'doctor_portal', formProgress: 0 };
    let started = false;

    function sessionId() {
        try {
            let id = sessionStorage.getItem(KEY);
            if (!id) {
                id = 'dr_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
                sessionStorage.setItem(KEY, id);
            }
            return id;
        } catch (_) {
            return 'dr_' + Date.now();
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
                const u = global.PortalAuth.getUser('doctor');
                if (u && u.id) {
                    out.userId = u.id;
                    out.userLabel =
                        [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
                        u.user_id_string ||
                        u.email ||
                        'Doctor';
                }
            }
        } catch (_) {}
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

    function inferActivityFromDom() {
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

    function mergedActivity() {
        const inferred = inferActivityFromDom();
        const merged = Object.assign({}, inferred, activityState);
        if (activityState.kind === 'payment') merged.kind = 'payment';
        else if (activityState.kind === 'seminar_apply' || inferred.kind === 'seminar_apply') merged.kind = 'seminar_apply';
        else if (inferred.kind) merged.kind = inferred.kind;
        return merged;
    }

    function heartbeatMs() {
        const k = mergedActivity().kind;
        if (k === 'seminar_apply' || k === 'payment') return 4000;
        return 8000;
    }

    function scheduleTimer() {
        if (global.__doctorRadarTimer) clearInterval(global.__doctorRadarTimer);
        global.__doctorRadarTimer = setInterval(sendHeartbeat, heartbeatMs());
    }

    function sendHeartbeat() {
        const ctx = userContext();
        const activity = mergedActivity();
        fetch('/api/public/visitor-heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
                sessionId: sessionId(),
                path: currentPath(),
                referrer: document.referrer || '',
                userId: ctx.userId,
                userLabel: ctx.userLabel,
                activity: activity,
                clientDiagnostics: collectDiagnostics()
            })
        })
            .then(function (r) {
                return r.json();
            })
            .then(function (d) {
                if (d && d.skipped) {
                    console.warn('[seminar-radar] heartbeat skipped — server could not save session');
                }
            })
            .catch(function () {});
        scheduleTimer();
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
        boot: boot
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(typeof window !== 'undefined' ? window : global);

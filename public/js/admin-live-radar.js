/**
 * Admin — seminar application Live Radar (realtime SSE, graphics, animations).
 */
(function (global) {
    let eventSource = null;
    let pollTimer = null;
    let mapCanvas = null;
    let mapCtx = null;
    let mapPoints = [];
    let mapAnimFrame = null;
    let mapPhase = 0;
    let lastSnapshot = null;
    let mounted = false;
    let streamConnected = false;

    const STEP_NAMES = ['Terms', 'Personal', 'Address', 'Qualification', 'College', 'Submit'];

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function deviceIcon(type) {
        if (type === 'mobile') return '📱';
        if (type === 'tablet') return '📲';
        return '🖥️';
    }

    function deviceLabel(s) {
        const browser = s.browser || 'Browser';
        const dt = s.deviceType === 'mobile' ? 'Mobile' : s.deviceType === 'tablet' ? 'Tablet' : 'Desktop';
        return browser + ' · ' + dt;
    }

    function formatAge(sec) {
        if (sec == null) return '—';
        if (sec < 5) return 'live';
        if (sec < 60) return sec + 's';
        return Math.floor(sec / 60) + 'm';
    }

    function statIcon(kind) {
        const icons = {
            apply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>',
            live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>',
            pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
            browser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>'
        };
        return icons[kind] || icons.live;
    }

    function renderStepFunnel(stepNumber) {
        const n = stepNumber != null ? parseInt(stepNumber, 10) : 0;
        return (
            '<div class="lr-step-funnel" aria-hidden="true">' +
            STEP_NAMES.map(function (label, i) {
                let cls = 'step';
                if (i < n) cls += ' done';
                if (i === n) cls += ' active';
                return '<div class="' + cls + '" title="' + esc(label) + '"></div>';
            }).join('') +
            '</div><div class="lr-step-labels">' +
            STEP_NAMES.map(function (label, i) {
                return (
                    '<span class="' +
                    (i === n ? 'active' : i < n ? 'done' : '') +
                    '">' +
                    esc(label) +
                    '</span>'
                );
            }).join('') +
            '</div>'
        );
    }

    function buildShell(root) {
        root.innerHTML =
            '<div class="live-radar-wrap">' +
            '<div class="live-radar-hero">' +
            '<div><h2>📡 Live Radar <span class="live-radar-live-pill" id="lr-stream-pill"><span class="dot"></span><span id="lr-stream-text">Connecting</span></span></h2>' +
            '<p class="live-radar-sub">Realtime view of doctor seminar applications <strong>and</strong> all site visitors — homepage, signup, certificate verify, and more. Location, browser, device, and live activity.</p></div>' +
            '<div class="live-radar-updated" id="lr-updated">Starting stream…</div></div>' +
            '<div class="live-radar-stats" id="lr-stats"></div>' +
            '<div class="live-radar-grid">' +
            '<div class="lr-panel lr-panel-map">' +
            '<div class="lr-panel-head"><h3>🗺 Live locations</h3><span class="live-radar-updated" id="lr-map-count"></span></div>' +
            '<div class="lr-map-wrap"><canvas id="lr-map-canvas" width="720" height="360"></canvas>' +
            '<div class="lr-map-legend"><span><i style="background:#2dd4bf"></i> Active</span><span><i style="background:#fb923c"></i> Applying</span><span><i style="background:#a78bfa"></i> Guest</span></div></div>' +
            '<div class="lr-panel-head" style="margin-top:14px;"><h3>📊 By seminar</h3></div>' +
            '<div class="lr-seminar-bars" id="lr-seminar-bars"></div></div>' +
            '<div class="lr-panel"><div class="lr-panel-head"><h3>⚡ Live activity</h3><span id="lr-feed-count" class="live-radar-updated"></span></div>' +
            '<div class="lr-feed" id="lr-feed"></div></div></div></div>';
        mapCanvas = root.querySelector('#lr-map-canvas');
        if (mapCanvas) mapCtx = mapCanvas.getContext('2d');
    }

    function setStreamStatus(connected, msg) {
        streamConnected = connected;
        const pill = document.getElementById('lr-stream-pill');
        const txt = document.getElementById('lr-stream-text');
        if (txt) txt.textContent = msg || (connected ? 'Live' : 'Reconnecting');
        if (pill) {
            pill.style.borderColor = connected ? 'rgba(45,212,191,0.45)' : 'rgba(251,146,60,0.45)';
            pill.style.color = connected ? '#2dd4bf' : '#fb923c';
        }
    }

    function renderStats(stats) {
        const el = document.getElementById('lr-stats');
        if (!el || !stats) return;
        const cards = [
            { cls: 'orange', key: 'applying', label: 'Applying now', icon: 'apply' },
            { cls: 'purple', key: 'siteGuests', label: 'Site guests', icon: 'browser' },
            { cls: 'teal', key: 'liveNow', label: 'Live (<20s)', icon: 'live' },
            { cls: 'blue', key: 'doctorPortal', label: 'Doctor portal', icon: 'browser' },
            { cls: 'purple', key: 'paying', label: 'At payment', icon: 'pay' },
            { cls: 'blue', key: 'mobile', label: 'Mobile', icon: 'browser' }
        ];
        el.innerHTML = cards
            .map(function (c, idx) {
                return (
                    '<div class="lr-stat-card ' +
                    c.cls +
                    ' lr-stat-enter" style="animation-delay:' +
                    idx * 0.06 +
                    's"><div class="icon">' +
                    statIcon(c.icon) +
                    '</div><div class="value">' +
                    esc(stats[c.key] != null ? stats[c.key] : 0) +
                    '</div><div class="label">' +
                    esc(c.label) +
                    '</div></div>'
                );
            })
            .join('');
    }

    function renderSeminarBars(breakdown) {
        const el = document.getElementById('lr-seminar-bars');
        if (!el) return;
        if (!breakdown || !breakdown.length) {
            el.innerHTML =
                '<div class="lr-empty"><div class="lr-empty-icon">📝</div>No active applications — open <strong>/doctor</strong> and start registering to test.</div>';
            return;
        }
        const max = breakdown[0].count || 1;
        el.innerHTML = breakdown
            .slice(0, 5)
            .map(function (row, idx) {
                const pct = Math.round((row.count / max) * 100);
                return (
                    '<div class="lr-seminar-row lr-stat-enter" style="animation-delay:' +
                    idx * 0.08 +
                    's"><span>' +
                    esc(row.title) +
                    '</span><strong>' +
                    esc(row.count) +
                    '</strong><div class="bar"><span class="lr-bar-fill" style="width:' +
                    pct +
                    '%"></span></div></div>'
                );
            })
            .join('');
    }

    function activityLabel(s) {
        if (s.activityKind === 'seminar_apply') {
            return '📝 Applying' + (s.seminarTitle ? ' · ' + s.seminarTitle : '');
        }
        if (s.activityKind === 'payment') return '💳 Payment checkout';
        if (s.activityKind === 'track_applications') return '📂 Tracking applications';
        if (s.activityKind === 'browse_seminars') return '🔍 Browsing seminars';
        if (s.activityKind === 'homepage') return '🏠 Homepage';
        if (s.activityKind === 'signup') return '✨ Sign up';
        if (s.activityKind === 'login') return '🔐 Sign in';
        if (s.activityKind === 'verify_certificate') return '🎓 Verify certificate';
        if (s.visitorType === 'site_guest') return '🌐 ' + (s.activityLabel || 'Browsing site');
        if (s.isDoctorPortal) return '🩺 Doctor portal';
        return '🌐 ' + (s.activityLabel || 'On site');
    }

    function visitorBadge(s) {
        if (s.visitorType === 'site_guest') return ' <span class="lr-visitor-badge guest">Guest</span>';
        if (s.visitorType === 'doctor') return ' <span class="lr-visitor-badge doctor">Doctor</span>';
        if (s.visitorType === 'doctor_guest') return ' <span class="lr-visitor-badge doctor-guest">Guest</span>';
        return '';
    }

    function renderFeed(sessions) {
        const feed = document.getElementById('lr-feed');
        const countEl = document.getElementById('lr-feed-count');
        if (!feed) return;
        const rows = (sessions || []).slice(0, 40);
        if (countEl) countEl.textContent = rows.length + ' tracked';
        if (!rows.length) {
            feed.innerHTML =
                '<div class="lr-empty"><div class="lr-empty-icon lr-pulse-icon">📡</div>' +
                '<strong>Waiting for activity</strong><p style="margin:8px 0 0;font-size:0.85rem;">Open your homepage or <code>/doctor</code> in another tab — visitors appear here within seconds.</p></div>';
            return;
        }
        const applyingRows = rows.filter(function (s) {
            return s.activityKind === 'seminar_apply' || s.activityKind === 'payment';
        });
        const guestRows = rows.filter(function (s) {
            return s.visitorType === 'site_guest';
        });
        const doctorRows = rows.filter(function (s) {
            return s.isDoctorPortal && s.activityKind !== 'seminar_apply' && s.activityKind !== 'payment';
        });
        let html = '';
        if (applyingRows.length) {
            html += '<div class="lr-feed-section"><h4>📝 Seminar applications</h4>' + renderSessionCards(applyingRows) + '</div>';
        }
        if (guestRows.length) {
            html += '<div class="lr-feed-section"><h4>🌐 Site visitors</h4>' + renderSessionCards(guestRows) + '</div>';
        }
        if (doctorRows.length) {
            html += '<div class="lr-feed-section"><h4>🩺 Doctor portal</h4>' + renderSessionCards(doctorRows) + '</div>';
        }
        if (!html) html = renderSessionCards(rows);
        feed.innerHTML = html;
    }

    function formatLocation(s) {
        if (s.geo) {
            const parts = [s.geo.city, s.geo.region, s.geo.country].filter(Boolean);
            if (parts.length) return parts.join(', ');
            if (s.geo.label) return s.geo.label;
        }
        if (s.city || s.region || s.country) {
            return [s.city, s.region, s.country].filter(Boolean).join(', ');
        }
        if (s.location) return s.location;
        if (s.ip) return 'IP ' + s.ip;
        return 'Location pending';
    }

    function renderSessionCards(rows) {
        return rows
            .map(function (s, idx) {
                const name = s.userLabel || (s.userId ? 'User #' + s.userId : 'Anonymous visitor');
                const loc = formatLocation(s);
                const isApply = s.activityKind === 'seminar_apply';
                const guestCls = s.visitorType === 'site_guest' ? ' lr-session-guest' : '';
                const funnel = isApply ? renderStepFunnel(s.stepNumber) : '';
                const progressPct = isApply ? s.formProgress || 0 : 0;
                return (
                    '<article class="lr-session lr-stat-enter' +
                    guestCls +
                    (s.isNew ? ' new' : '') +
                    (s.pulse === 'live' ? ' lr-session-live' : '') +
                    '" style="animation-delay:' +
                    idx * 0.04 +
                    's">' +
                    '<div class="lr-device-badge" title="' +
                    esc(deviceLabel(s)) +
                    '">' +
                    deviceIcon(s.deviceType) +
                    '</div>' +
                    '<div class="lr-session-main"><strong>' +
                    esc(name) +
                    visitorBadge(s) +
                    (s.isNew ? ' <em class="lr-new-tag">NEW</em>' : '') +
                    '</strong>' +
                    '<div class="meta">' +
                    esc(deviceLabel(s)) +
                    '<br>📍 ' +
                    esc(loc) +
                    '<br>📄 ' +
                    esc(s.page || '—') +
                    (s.seminarTitle ? '<br>🎓 ' + esc(s.seminarTitle) : '') +
                    '</div>' +
                    '<span class="lr-activity-tag ' +
                    (isApply ? 'apply' : s.activityKind === 'payment' ? 'pay' : s.visitorType === 'site_guest' ? 'guest' : 'browse') +
                    '">' +
                    esc(activityLabel(s)) +
                    (isApply && s.stepLabel ? ' · ' + esc(s.stepLabel) : '') +
                    '</span>' +
                    funnel +
                    (isApply
                        ? '<div class="lr-progress"><span style="width:' + esc(progressPct) + '%"></span></div>'
                        : '') +
                    '</div>' +
                    '<div class="lr-age">' +
                    esc(formatAge(s.ageSec)) +
                    '</div></article>'
                );
            })
            .join('');
    }

    function drawMapFrame() {
        if (!mapCanvas || !mapCtx) return;
        const w = mapCanvas.width;
        const h = mapCanvas.height;
        mapCtx.clearRect(0, 0, w, h);

        const grd = mapCtx.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, '#ffffff');
        grd.addColorStop(1, '#f1f5f9');
        mapCtx.fillStyle = grd;
        mapCtx.fillRect(0, 0, w, h);

        mapCtx.strokeStyle = 'rgba(148,163,184,0.28)';
        mapCtx.lineWidth = 1;
        for (let i = 1; i < 10; i++) {
            const y = (h / 10) * i;
            mapCtx.beginPath();
            mapCtx.moveTo(0, y);
            mapCtx.lineTo(w, y);
            mapCtx.stroke();
        }
        for (let i = 1; i < 18; i++) {
            const x = (w / 18) * i;
            mapCtx.beginPath();
            mapCtx.moveTo(x, 0);
            mapCtx.lineTo(x, h);
            mapCtx.stroke();
        }

        mapPhase += 0.04;
        (mapPoints || []).forEach(function (p, idx) {
            const x = ((Number(p.lon) + 180) / 360) * w;
            const y = ((90 - Number(p.lat)) / 180) * h;
            const applying = p.kind === 'seminar_apply';
            const isGuest = p.kind === 'homepage' || p.kind === 'browse' || p.kind === 'signup' || p.kind === 'login';
            const color = applying ? '#fb923c' : isGuest ? '#a78bfa' : '#2dd4bf';
            const pulse = 4 + Math.sin(mapPhase + idx) * 3;

            mapCtx.beginPath();
            mapCtx.strokeStyle = color + '88';
            mapCtx.lineWidth = 2;
            mapCtx.arc(x, y, 10 + pulse, 0, Math.PI * 2);
            mapCtx.stroke();

            mapCtx.beginPath();
            mapCtx.fillStyle = color;
            mapCtx.arc(x, y, applying ? 6 : 4, 0, Math.PI * 2);
            mapCtx.fill();
        });

        mapAnimFrame = requestAnimationFrame(drawMapFrame);
    }

    function startMapAnim(points) {
        mapPoints = points || [];
        const countEl = document.getElementById('lr-map-count');
        if (countEl) {
            countEl.textContent = mapPoints.length
                ? mapPoints.length + ' on map'
                : 'Resolving city / state / country…';
        }
        if (!mapAnimFrame && mapCtx) drawMapFrame();
    }

    function stopMapAnim() {
        if (mapAnimFrame) {
            cancelAnimationFrame(mapAnimFrame);
            mapAnimFrame = null;
        }
    }

    function renderSnapshot(data) {
        if (!data) return;
        if (data.error) {
            setStreamStatus(false, 'Error');
            const upd = document.getElementById('lr-updated');
            if (upd) upd.textContent = 'Error: ' + data.error;
            return;
        }
        lastSnapshot = data;
        setStreamStatus(true, 'Live');
        renderStats(data.stats);
        renderSeminarBars(data.seminarBreakdown);
        renderFeed(data.sessions);
        startMapAnim(data.mapPoints);
        const upd = document.getElementById('lr-updated');
        if (upd) {
            upd.textContent =
                'Updated ' +
                new Date(data.generatedAt || Date.now()).toLocaleTimeString() +
                ' · ' +
                (data.stats.applying || 0) +
                ' applying';
        }
    }

    function startStream() {
        stopStream();
        setStreamStatus(false, 'Connecting');
        if (typeof EventSource !== 'undefined') {
            try {
                eventSource = new EventSource('/api/admin/live-radar/stream');
                eventSource.onopen = function () {
                    setStreamStatus(true, 'Live');
                };
                eventSource.onmessage = function (ev) {
                    try {
                        renderSnapshot(JSON.parse(ev.data));
                    } catch (_) {}
                };
                eventSource.onerror = function () {
                    if (eventSource) {
                        eventSource.close();
                        eventSource = null;
                    }
                    setStreamStatus(false, 'Polling');
                    startPollFallback();
                };
                return;
            } catch (_) {}
        }
        startPollFallback();
    }

    function startPollFallback() {
        if (pollTimer) clearInterval(pollTimer);
        const pull = function () {
            fetch('/api/admin/live-radar?minutes=3')
                .then(function (r) {
                    return r.json();
                })
                .then(function (d) {
                    if (d && d.error) renderSnapshot({ error: d.error });
                    else renderSnapshot(d);
                })
                .catch(function (e) {
                    renderSnapshot({ error: e.message || 'Network error' });
                });
        };
        pull();
        pollTimer = setInterval(pull, 3000);
    }

    function stopStream() {
        stopMapAnim();
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function initAdminLiveRadar() {
        const root = document.getElementById('live-radar-root');
        if (!root) return;
        if (!mounted) {
            buildShell(root);
            mounted = true;
        }
        startStream();
    }

    function stopAdminLiveRadar() {
        stopStream();
        setStreamStatus(false, 'Paused');
    }

    global.initAdminLiveRadar = initAdminLiveRadar;
    global.stopAdminLiveRadar = stopAdminLiveRadar;
    global.refreshAdminLiveVisitors = function () {
        if (lastSnapshot && !lastSnapshot.error) renderSnapshot(lastSnapshot);
        else initAdminLiveRadar();
    };
})(typeof window !== 'undefined' ? window : global);

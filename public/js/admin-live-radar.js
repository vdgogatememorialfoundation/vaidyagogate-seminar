/**
 * Admin Live Radar — realtime seminar application tracking (SSE + graphics).
 */
(function (global) {
    let eventSource = null;
    let pollTimer = null;
    let mapCanvas = null;
    let mapCtx = null;
    let lastSnapshot = null;
    let mounted = false;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function deviceEmoji(type) {
        if (type === 'mobile') return '📱';
        if (type === 'tablet') return '📲';
        return '💻';
    }

    function activityClass(kind) {
        if (kind === 'seminar_apply') return 'apply';
        if (kind === 'payment') return 'pay';
        return 'browse';
    }

    function activityLabel(s) {
        if (s.activityKind === 'seminar_apply') {
            return '📝 Applying' + (s.seminarTitle ? ' · ' + s.seminarTitle : '');
        }
        if (s.activityKind === 'payment') return '💳 Payment';
        if (s.activityKind === 'track_applications') return '📂 Tracking apps';
        if (s.activityKind === 'browse_seminars') return '🔍 Browsing seminars';
        return '🌐 ' + (s.activityLabel || 'On site');
    }

    function formatAge(sec) {
        if (sec == null) return '—';
        if (sec < 5) return 'just now';
        if (sec < 60) return sec + 's ago';
        return Math.floor(sec / 60) + 'm ago';
    }

    function statIcon(kind) {
        const icons = {
            live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
            apply:
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h6"/></svg>',
            pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
            mobile:
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>'
        };
        return icons[kind] || icons.live;
    }

    function buildShell(root) {
        root.innerHTML =
            '<div class="live-radar-wrap">' +
            '<div class="live-radar-hero">' +
            '<div><h2><span aria-hidden="true">📡</span> Live Radar <span class="live-radar-live-pill"><span class="dot"></span>Realtime</span></h2>' +
            '<p class="live-radar-sub">Watch doctors browse seminars, fill applications step-by-step, and pay — with location, device, and form progress updating every few seconds.</p></div>' +
            '<div class="live-radar-updated" id="lr-updated">Connecting…</div></div>' +
            '<div class="live-radar-stats" id="lr-stats"></div>' +
            '<div class="live-radar-grid">' +
            '<div class="lr-panel"><div class="lr-panel-head"><h3>🗺 Visitor map</h3><span class="live-radar-updated" id="lr-map-count"></span></div>' +
            '<div class="lr-map-wrap"><canvas id="lr-map-canvas" width="640" height="320"></canvas>' +
            '<div class="lr-map-legend"><span><i style="background:#2dd4bf"></i> Live</span><span><i style="background:#fb923c"></i> Applying</span></div></div>' +
            '<div class="lr-panel-head" style="margin-top:14px;"><h3>📊 Applications in progress</h3></div>' +
            '<div class="lr-seminar-bars" id="lr-seminar-bars"></div></div>' +
            '<div class="lr-panel"><div class="lr-panel-head"><h3>⚡ Live activity feed</h3><span id="lr-feed-count" class="live-radar-updated"></span></div>' +
            '<div class="lr-feed" id="lr-feed"></div></div></div></div>';
        mapCanvas = root.querySelector('#lr-map-canvas');
        if (mapCanvas) mapCtx = mapCanvas.getContext('2d');
    }

    function renderStats(stats) {
        const el = document.getElementById('lr-stats');
        if (!el || !stats) return;
        const cards = [
            { cls: 'teal', key: 'liveNow', label: 'Live now', icon: 'live' },
            { cls: 'orange', key: 'applying', label: 'Applying', icon: 'apply' },
            { cls: 'purple', key: 'paying', label: 'Paying', icon: 'pay' },
            { cls: 'blue', key: 'mobile', label: 'On mobile', icon: 'mobile' },
            { cls: 'teal', key: 'newVisitors', label: 'New (3 min)', icon: 'live' },
            { cls: 'blue', key: 'active', label: 'Active (10 min)', icon: 'live' }
        ];
        el.innerHTML = cards
            .map(function (c) {
                return (
                    '<div class="lr-stat-card ' +
                    c.cls +
                    '"><div class="icon">' +
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
            el.innerHTML = '<div class="lr-empty">No one is filling an application right now.</div>';
            return;
        }
        const max = breakdown[0].count || 1;
        el.innerHTML = breakdown
            .slice(0, 6)
            .map(function (row) {
                const pct = Math.round((row.count / max) * 100);
                return (
                    '<div class="lr-seminar-row"><span>' +
                    esc(row.title) +
                    '</span><strong>' +
                    esc(row.count) +
                    '</strong><div class="bar"><span style="width:' +
                    pct +
                    '%"></span></div></div>'
                );
            })
            .join('');
    }

    function renderFeed(sessions) {
        const feed = document.getElementById('lr-feed');
        const countEl = document.getElementById('lr-feed-count');
        if (!feed) return;
        const rows = (sessions || []).slice(0, 40);
        if (countEl) countEl.textContent = rows.length + ' sessions';
        if (!rows.length) {
            feed.innerHTML =
                '<div class="lr-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg><div>Waiting for visitors… Open the doctor portal on your phone to test.</div></div>';
            return;
        }
        feed.innerHTML = rows
            .map(function (s) {
                const tagCls = activityClass(s.activityKind);
                const name = s.userLabel || (s.userId ? 'Doctor #' + s.userId : 'Guest visitor');
                const loc = s.location || s.ip || 'Unknown location';
                const page = s.page || '—';
                const progress =
                    s.activityKind === 'seminar_apply'
                        ? '<div class="lr-progress"><span style="width:' +
                          esc(s.formProgress || 0) +
                          '%"></span></div><div class="meta" style="margin-top:4px;">Step ' +
                          esc(s.stepNumber != null ? s.stepNumber : '?') +
                          ' · ' +
                          esc(s.stepLabel || s.activityLabel || '') +
                          ' · ' +
                          esc(s.formProgress || 0) +
                          '%</div>'
                        : '';
                return (
                    '<article class="lr-session' +
                    (s.isNew ? ' new' : '') +
                    '"><div class="lr-device-badge" title="' +
                    esc(s.deviceType) +
                    '">' +
                    deviceEmoji(s.deviceType) +
                    '</div><div class="lr-session-main"><strong>' +
                    esc(name) +
                    (s.isNew ? ' <span style="color:#2dd4bf;font-size:0.72rem;">NEW</span>' : '') +
                    '</strong><div class="meta">📍 ' +
                    esc(loc) +
                    '<br>📄 ' +
                    esc(page) +
                    '</div><span class="lr-activity-tag ' +
                    tagCls +
                    '">' +
                    esc(activityLabel(s)) +
                    '</span>' +
                    progress +
                    '</div><div class="lr-age">' +
                    esc(formatAge(s.ageSec)) +
                    '</div></article>'
                );
            })
            .join('');
    }

    function drawMap(points) {
        if (!mapCanvas || !mapCtx) return;
        const w = mapCanvas.width;
        const h = mapCanvas.height;
        mapCtx.clearRect(0, 0, w, h);

        mapCtx.strokeStyle = 'rgba(148,163,184,0.08)';
        mapCtx.lineWidth = 1;
        for (let i = 1; i < 12; i++) {
            const y = (h / 12) * i;
            mapCtx.beginPath();
            mapCtx.moveTo(0, y);
            mapCtx.lineTo(w, y);
            mapCtx.stroke();
        }
        for (let j = 1; j < 24; j++) {
            const x = (w / 24) * j;
            mapCtx.beginPath();
            mapCtx.moveTo(x, 0);
            mapCtx.lineTo(x, h);
            mapCtx.stroke();
        }

        const pts = points || [];
        const countEl = document.getElementById('lr-map-count');
        if (countEl) countEl.textContent = pts.length ? pts.length + ' on map' : 'No geo yet';

        pts.forEach(function (p) {
            const x = ((Number(p.lon) + 180) / 360) * w;
            const y = ((90 - Number(p.lat)) / 180) * h;
            const applying = p.kind === 'seminar_apply';
            const color = applying ? '#fb923c' : p.pulse === 'live' ? '#2dd4bf' : '#64748b';
            const r = applying ? 7 : p.pulse === 'live' ? 6 : 4;

            mapCtx.beginPath();
            mapCtx.fillStyle = color + '33';
            mapCtx.arc(x, y, r + 6, 0, Math.PI * 2);
            mapCtx.fill();

            mapCtx.beginPath();
            mapCtx.fillStyle = color;
            mapCtx.arc(x, y, r, 0, Math.PI * 2);
            mapCtx.fill();
        });
    }

    function renderSnapshot(data) {
        if (!data || data.error) return;
        lastSnapshot = data;
        renderStats(data.stats);
        renderSeminarBars(data.seminarBreakdown);
        renderFeed(data.sessions);
        drawMap(data.mapPoints);
        const upd = document.getElementById('lr-updated');
        if (upd) {
            upd.textContent =
                'Updated ' +
                new Date(data.generatedAt || Date.now()).toLocaleTimeString() +
                ' · realtime stream';
        }
    }

    function startStream() {
        stopStream();
        if (typeof EventSource !== 'undefined') {
            try {
                eventSource = new EventSource('/api/admin/live-radar/stream');
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
            fetch('/api/admin/live-radar?minutes=10')
                .then(function (r) {
                    return r.json();
                })
                .then(function (d) {
                    if (d && d.success !== false) renderSnapshot(d);
                })
                .catch(function () {});
        };
        pull();
        pollTimer = setInterval(pull, 4000);
    }

    function stopStream() {
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
    }

    global.initAdminLiveRadar = initAdminLiveRadar;
    global.stopAdminLiveRadar = stopAdminLiveRadar;
    global.refreshAdminLiveVisitors = function () {
        if (lastSnapshot) renderSnapshot(lastSnapshot);
        else initAdminLiveRadar();
    };
})(typeof window !== 'undefined' ? window : global);

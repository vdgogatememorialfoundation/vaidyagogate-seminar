(function () {
    const pollMs = 1000;
    let lastEventId = 0;
    let pollTimer = null;
    let clockTimer = null;
    let actor = null;

    /** Resolved admin actor id for OTP/scanner APIs (null until init resolves). */
    function actorCtxId() {
        const s = getStoredAdminUser();
        return (s && s.id) || (actor && actor.id) || null;
    }
    let soundEnabled = true;
    let audioCtx = null;

    function ensureAudio() {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
        }
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    }

    function playTone(freq, duration, type, gain) {
        if (!soundEnabled || !audioCtx) return;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        const vol = gain != null ? gain : 0.12;
        g.gain.setValueAtTime(vol, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start();
        o.stop(audioCtx.currentTime + duration);
    }

    function playScanSound(outcome) {
        ensureAudio();
        const o = String(outcome || 'failed');
        if (o === 'success') {
            playTone(523, 0.1, 'sine', 0.14);
            setTimeout(() => playTone(784, 0.12, 'sine', 0.12), 90);
            setTimeout(() => playTone(1046, 0.14, 'sine', 0.1), 180);
        } else if (o === 'duplicate') {
            playTone(440, 0.08, 'triangle', 0.1);
            setTimeout(() => playTone(440, 0.08, 'triangle', 0.1), 120);
        } else {
            playTone(180, 0.22, 'sawtooth', 0.08);
            setTimeout(() => playTone(140, 0.28, 'sawtooth', 0.07), 160);
        }
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function getStoredAdminUser() {
        try {
            const raw =
                localStorage.getItem('admin_user') ||
                sessionStorage.getItem('admin_user') ||
                sessionStorage.getItem('adminUser');
            if (!raw) return null;
            const u = JSON.parse(raw);
            return u && u.id ? u : null;
        } catch (_) {
            return null;
        }
    }

    // Only the super administrator sees the back-to-admin button.
    // Super admin = role 'admin' AND user_role either unset or an admin-family value
    // ('admin', 'super_admin'). All staff roles (co_admin, *_user variants) are excluded.
    function isSuperAdminActor(u) {
        const role = String((u && u.role) || '').toLowerCase();
        const userRole = String((u && u.user_role) || '').toLowerCase();
        return role === 'admin' && (userRole === '' || userRole === 'admin' || userRole === 'super_admin');
    }

    // Hidden by default in CSS; shown only after the actor resolves as super admin.
    function applyBackVisibility(u) {
        const btn = document.getElementById('live-scanner-back');
        if (btn) btn.style.display = isSuperAdminActor(u) ? 'inline-flex' : 'none';
    }

    async function api(path) {
        const aid = actor && actor.id;
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(path + sep + 'actingAdminId=' + encodeURIComponent(aid), { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
    }

    function cardClass(outcome) {
        const o = String(outcome || 'failed');
        if (o === 'success') return 'success';
        if (o === 'duplicate') return 'duplicate';
        if (
            [
                'not_found',
                'unpaid',
                'invalid',
                'wrong_seminar',
                'wrong_date',
                'checkin_disabled',
                'account_blocked'
            ].includes(o)
        ) {
            return o;
        }
        return 'failed';
    }

    function initials(name) {
        const parts = String(name || 'Guest')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function parseFeedTime(iso) {
        if (!iso) return null;
        const s = String(iso).trim();
        if (!s) return null;
        if (/Z$|[+-]\d{2}(:?\d{2})?$/i.test(s)) return new Date(s);
        let norm = s.includes('T') ? s : s.replace(' ', 'T');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(norm)) norm += ':00';
        const d = new Date(norm + 'Z');
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function formatCardTime(iso) {
        const d = parseFeedTime(iso);
        if (!d) return iso ? String(iso) : '';
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    function outcomeTitle(outcome) {
        if (outcome === 'success') return 'Checked in';
        if (outcome === 'duplicate') return 'Already scanned';
        return String(outcome || 'failed').replace(/_/g, ' ');
    }

    function setLiveState(active, label) {
        const pill = document.getElementById('kiosk-live-pill');
        const lbl = document.getElementById('kiosk-live-label');
        if (pill) pill.classList.toggle('is-live', !!active);
        if (lbl) lbl.textContent = label || (active ? 'Live' : 'Paused');
    }

    function updateEmptyState() {
        const grid = document.getElementById('live-scan-grid');
        const empty = document.getElementById('live-scan-empty');
        if (!empty) return;
        const hasEvent = !!(document.getElementById('live-scanner-seminar') || {}).value;
        const hasCards = grid && grid.children.length > 0;
        empty.classList.toggle('hidden', !hasEvent || hasCards);
    }

    function tickClock() {
        const el = document.getElementById('kiosk-clock');
        if (!el) return;
        el.textContent = new Date().toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function prevDayLine(ev) {
        const p = ev && ev.previousDay;
        if (!p) return '';
        const label = esc(p.title || 'Previous day');
        if (p.attended) {
            return (
                '<div class="scan-card-prev is-yes"><i class="fas fa-circle-check"></i> Attended ' +
                label +
                (p.scanTime ? ' · checked in ' + esc(formatCardTime(p.scanTime)) : '') +
                '</div>'
            );
        }
        return (
            '<div class="scan-card-prev is-no"><i class="fas fa-circle-xmark"></i> ' +
            (p.hasTicket ? 'Did not attend ' : 'No ticket for ') +
            label +
            '</div>'
        );
    }

    function prependCard(ev) {
        const grid = document.getElementById('live-scan-grid');
        if (!grid) return;
        const el = document.createElement('article');
        el.className = 'scan-card is-new ' + cardClass(ev.outcome);
        el.dataset.id = String(ev.id);
        const outcomeLabel = String(ev.outcome || 'failed').replace(/_/g, ' ');
        const name = ev.doctorName || 'Guest';
        el.innerHTML =
            '<div class="scan-card-head">' +
            '<span class="scan-card-avatar" aria-hidden="true">' +
            esc(initials(name)) +
            '</span>' +
            '<div class="scan-card-head-main">' +
            '<span class="scan-outcome-badge">' +
            esc(outcomeLabel) +
            '</span>' +
            '<h4>' +
            esc(outcomeTitle(ev.outcome)) +
            '</h4>' +
            '<div class="meta"><strong>' +
            esc(name) +
            '</strong></div>' +
            '</div>' +
            '<span class="scan-card-time">' +
            esc(formatCardTime(ev.createdAt)) +
            '</span></div>' +
            (ev.dayTitle
                ? '<div style="margin:4px 0 0;"><span class="scan-outcome-badge" style="background:#e0e7ff;color:#3730a3;">' +
                  esc(ev.dayTitle) +
                  '</span></div>'
                : '') +
            prevDayLine(ev) +
            '<div class="scan-card-ids">' +
            '<div><span class="lbl">E-ticket</span><code>' +
            esc(ev.ticketId || '—') +
            '</code></div>' +
            '<div><span class="lbl">Application</span><code>' +
            esc(ev.applicationNo || '—') +
            '</code></div></div>' +
            (ev.message ? '<div class="reason">' + esc(ev.message) + '</div>' : '') +
            (ev.scannerName
                ? '<div class="scan-card-scanner"><i class="fas fa-user-check"></i> ' + esc(ev.scannerName) + '</div>'
                : '');
        grid.prepend(el);
        while (grid.children.length > 80) grid.removeChild(grid.lastChild);
        updateEmptyState();
    }

    function selectedDayId() {
        const el = document.getElementById('live-scanner-day');
        const v = el ? el.value : '';
        return v ? parseInt(v, 10) : null;
    }

    function renderApplicants(rows) {
        const body = document.getElementById('ls-applist-body');
        const countEl = document.getElementById('ls-applist-count');
        if (!body) return;
        const groups = new Map();
        (rows || []).forEach((r) => {
            let g = groups.get(r.registrationId);
            if (!g) {
                g = { registrationId: r.registrationId, name: r.name, applicationNo: r.applicationNo, days: [] };
                groups.set(r.registrationId, g);
            }
            if (r.dayId != null || r.dayTitle) {
                g.days.push({ id: r.dayId || null, title: r.dayTitle || 'Entry', checkedIn: !!r.checkedIn });
            } else if (r.ticketId) {
                g.days.push({ id: null, title: 'Entry', checkedIn: !!r.checkedIn });
            }
        });
        const did = selectedDayId();
        // When a day filter is active, count only registrations with that day.
        const shownGroups = [...groups.values()].filter((g) => !did || g.days.some((d2) => d2.id === did));
        if (countEl) {
            countEl.textContent = String(shownGroups.length);
            const daySel = document.getElementById('live-scanner-day');
            const opt = daySel && daySel.options[daySel.selectedIndex];
            countEl.title = did && opt ? 'Filtered by ' + opt.textContent : '';
        }
        body.innerHTML = '';
        if (!groups.size) {
            body.innerHTML =
                '<p class="ls-applist-empty" id="ls-applist-empty">No registrations yet for this event.</p>';
            return;
        }
        if (!shownGroups.length) {
            body.innerHTML =
                '<p class="ls-applist-empty" id="ls-applist-empty">No applicants for this day.</p>';
            return;
        }
        const frag = document.createDocumentFragment();
        groups.forEach((g) => {
            if (did) {
                const hasDay = g.days.some((d) => d.id === did);
                if (!hasDay) return;
            }
            const item = document.createElement('div');
            item.className = 'ls-app-item';
            item.dataset.regId = g.registrationId;
            let dayChips = '';
            g.days.forEach((d) => {
                dayChips +=
                    '<span class="ls-app-day ' +
                    (d.checkedIn ? 'is-in' : 'is-out') +
                    '" title="' +
                    esc(d.title) +
                    (d.checkedIn ? ' — checked in' : ' — not checked in') +
                    '">' +
                    '<i class="fas ' +
                    (d.checkedIn ? 'fa-check' : 'fa-xmark') +
                    '" aria-hidden="true"></i> ' +
                    esc(d.title) +
                    '</span>';
            });
            item.innerHTML =
                '<div class="ls-app-head"><strong>' +
                esc(g.name || 'Unnamed applicant') +
                '</strong><code>' +
                esc(g.applicationNo || '—') +
                '</code>' +
                '<button type="button" class="ls-app-otp-btn" title="Send check-in OTP by email"><i class="fas fa-key"></i> OTP</button>' +
                '</div>' +
                (dayChips ? '<div class="ls-app-days">' + dayChips + '</div>' : '');
            const firstDayId = g.days && g.days[0] ? g.days[0].id : null;
            item.querySelector('.ls-app-otp-btn').addEventListener('click', (ev) => {
                ev.stopPropagation();
                lsOtpSend({
                    registrationId: g.registrationId,
                    dayId: selectedDayId() || firstDayId || null,
                    name: g.name,
                    applicationNo: g.applicationNo
                });
            });
            item.addEventListener('click', () => {
                openLsOtpModal({
                    registrationId: Number(item.dataset.regId),
                    name: g.name,
                    applicationNo: g.applicationNo,
                    dayId: selectedDayId() || firstDayId || null
                });
            });
            frag.appendChild(item);
        });
        body.appendChild(frag);
    }

    function openLsOtpModal(ctx) {
        const modal = document.getElementById('ls-otp-modal');
        if (!modal) return;
        modal.dataset.regId = ctx.registrationId;
        modal.dataset.dayId = ctx.dayId || '';
        modal.dataset.name = ctx.name || '';
        modal.dataset.appNo = ctx.applicationNo || '';
        const who = document.getElementById('ls-otp-who');
        if (who) who.innerHTML = '<strong>' + esc(ctx.name || 'Applicant') + '</strong> — <code>' + esc(ctx.applicationNo || '') + '</code>';
        const code = document.getElementById('ls-otp-code');
        if (code) code.value = '';
        const msg = document.getElementById('ls-otp-msg');
        if (msg) msg.textContent = '';
        modal.classList.remove('hidden');
        if (code) code.focus();
    }
    function closeLsOtpModal() {
        const modal = document.getElementById('ls-otp-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function lsOtpSend(ctx) {
        const modal = document.getElementById('ls-otp-modal');
        const msg = document.getElementById('ls-otp-msg');
        const regId = ctx && ctx.registrationId ? Number(ctx.registrationId) : parseInt((modal && modal.dataset.regId) || '', 10);
        const dayId = ctx && ctx.dayId ? Number(ctx.dayId) : (modal && modal.dataset.dayId ? parseInt(modal.dataset.dayId, 10) : null);
        if (msg) { msg.style.color = '#64748b'; msg.textContent = 'Sending OTP…'; }
        try {
            const actor = actorCtxId();
            let url = '/api/admin/checkin/otp/resend?registrationId=' + encodeURIComponent(regId);
            if (dayId) url += '&dayId=' + encodeURIComponent(dayId);
            if (actor) url += '&actingAdminId=' + encodeURIComponent(actor);
            const data = await api(url);
            if (msg) {
                msg.style.color = '#166534';
                msg.textContent = 'OTP sent' + (data.deliveredTo ? ' to ' + data.deliveredTo : '') + '.';
            }
        } catch (e) {
            if (msg) { msg.style.color = '#b91c1c'; msg.textContent = e.message || 'Could not send OTP'; }
        }
    }

    async function lsOtpConfirm() {
        const modal = document.getElementById('ls-otp-modal');
        const code = (document.getElementById('ls-otp-code')?.value || '').trim();
        const msg = document.getElementById('ls-otp-msg');
        if (!/^\d{6}$/.test(code)) {
            if (msg) { msg.style.color = '#b91c1c'; msg.textContent = 'Enter the 6-digit OTP.'; }
            return;
        }
        if (msg) { msg.style.color = '#64748b'; msg.textContent = 'Verifying…'; }
        try {
            const data = await apiPost('/api/checkin/otp/verify', {
                registrationId: parseInt(modal.dataset.regId, 10),
                dayId: modal.dataset.dayId ? parseInt(modal.dataset.dayId, 10) : undefined,
                code,
                scannerUserId: actorCtxId()
            });
            if (msg) { msg.style.color = '#166534'; msg.textContent = 'Checked in successfully.'; }
            setTimeout(closeLsOtpModal, 700);
            loadApplicants();
            refreshStats();
        } catch (e) {
            if (msg) { msg.style.color = '#b91c1c'; msg.textContent = e.message || 'OTP verification failed'; }
        }
    }

    async function apiPost(path, body) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed (HTTP ' + res.status + ')');
        return data;
    }

    async function loadApplicants() {
        const body = document.getElementById('ls-applist-body');
        const countEl = document.getElementById('ls-applist-count');
        if (!body) return;
        const sid = document.getElementById('live-scanner-seminar').value;
        if (!sid) {
            if (countEl) countEl.textContent = '0';
            body.innerHTML =
                '<p class="ls-applist-empty" id="ls-applist-empty">Select an event to list applicants.</p>';
            return;
        }
        const did = selectedDayId();
        try {
            const data = await api(
                '/api/admin/live-scanner/registrations?seminarId=' +
                    encodeURIComponent(sid) +
                    (did ? '&dayId=' + encodeURIComponent(did) : '')
            );
            renderApplicants(data.registrations || []);
        } catch (e) {
            console.warn('[live-scanner] applicants:', e.message);
        }
    }

    async function refreshStats() {
        const sid = document.getElementById('live-scanner-seminar').value;
        if (!sid) return;
        const did = selectedDayId();
        const stats = await api(
            '/api/admin/live-scanner/stats?seminarId=' +
                encodeURIComponent(sid) +
                (did ? '&dayId=' + encodeURIComponent(did) : '')
        );
        document.getElementById('ls-stat-ok').textContent = stats.successCount || 0;
        document.getElementById('ls-stat-dup').textContent = stats.duplicateCount || 0;
        document.getElementById('ls-stat-fail').textContent = stats.failedCount || 0;
        document.getElementById('ls-stat-tix').textContent = stats.ticketsScanned || 0;
        const leftEl = document.getElementById('ls-stat-left');
        if (leftEl) {
            leftEl.textContent = stats.remaining || 0;
            const sub = document.getElementById('ls-stat-left-sub');
            if (sub) {
                const total = stats.ticketsTotal || 0;
                const pct = total ? Math.round(((stats.ticketsScanned || 0) / total) * 100) : 0;
                sub.textContent = total ? 'of ' + total + ' tickets · ' + pct + '% in' : '';
            }
        }
        if (stats.lastEventId > lastEventId) lastEventId = stats.lastEventId;
        const scope = document.getElementById('ls-stat-scope');
        if (scope) {
            const daySel = document.getElementById('live-scanner-day');
            const opt = daySel && daySel.options[daySel.selectedIndex];
            scope.textContent = did
                ? 'Showing ' + (opt ? opt.textContent : 'selected day') + ' only'
                : 'Showing all days combined — pick a day to see its own count';
            scope.classList.toggle('is-all', !did);
        }
    }

    let dayStatsAt = 0;
    let dayStatsData = null;

    function istToday() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date());
    }

    function renderDayBar(data) {
        const bar = document.getElementById('ls-daybar');
        if (!bar) return;
        const days = (data && data.days) || [];
        if (!days.length) {
            bar.classList.add('hidden');
            bar.innerHTML = '';
            return;
        }
        const did = selectedDayId();
        const today = istToday();
        let html = '';
        days.forEach((d, i) => {
            const isToday = String(d.dayDate || '').slice(0, 10) === today;
            const scanners = (d.scanners || [])
                .filter((x) => x.successCount || x.duplicateCount || x.failedCount)
                .slice(0, 4)
                .map(
                    (x) =>
                        '<li><span>' +
                        esc(x.name) +
                        '</span><b>' +
                        x.successCount +
                        '</b></li>'
                )
                .join('');
            html +=
                '<button type="button" class="ls-daycard' +
                (did === d.dayId ? ' is-active' : '') +
                (isToday ? ' is-today' : '') +
                '" data-day-id="' +
                d.dayId +
                '">' +
                '<div class="ls-daycard-head"><strong>Day ' +
                (i + 1) +
                '</strong>' +
                (isToday ? '<span class="ls-daycard-tag">Today</span>' : '') +
                '</div>' +
                '<div class="ls-daycard-title">' +
                esc(d.title) +
                (d.dayDate ? ' · ' + esc(String(d.dayDate).slice(0, 10)) : '') +
                '</div>' +
                '<div class="ls-daycard-count"><span>' +
                d.successCount +
                '</span> checked in' +
                (d.ticketsTotal ? ' <em>of ' + d.ticketsTotal + ' tickets</em>' : '') +
                '</div>' +
                '<div class="ls-daycard-sub">' +
                d.duplicateCount +
                ' duplicate · ' +
                d.failedCount +
                ' rejected · ' +
                d.ticketsScanned +
                ' unique tickets</div>' +
                '<div class="ls-daycard-left"><i class="fas fa-hourglass-half"></i> <b>' +
                (d.remaining || 0) +
                '</b> yet to check in</div>' +
                (scanners ? '<ul class="ls-daycard-scanners">' + scanners + '</ul>' : '') +
                '</button>';
        });
        if (data.unassigned) {
            const u = data.unassigned;
            html +=
                '<div class="ls-daycard ls-daycard--muted"><div class="ls-daycard-head"><strong>Day not recorded</strong></div>' +
                '<div class="ls-daycard-count"><span>' +
                u.successCount +
                '</span> checked in</div>' +
                '<div class="ls-daycard-sub">Older scans that could not be matched to a day</div></div>';
        }
        bar.innerHTML = html;
        bar.classList.remove('hidden');
        bar.querySelectorAll('.ls-daycard[data-day-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const daySel = document.getElementById('live-scanner-day');
                if (!daySel) return;
                const id = btn.dataset.dayId;
                daySel.value = daySel.value === id ? '' : id;
                daySel.dispatchEvent(new Event('change'));
            });
        });
    }

    async function refreshDayBar(force) {
        const sid = document.getElementById('live-scanner-seminar').value;
        if (!sid) return;
        if (!force && Date.now() - dayStatsAt < 4000) return;
        dayStatsAt = Date.now();
        try {
            dayStatsData = await api('/api/admin/live-scanner/day-stats?seminarId=' + encodeURIComponent(sid));
            renderDayBar(dayStatsData);
        } catch (e) {
            console.warn('[live-scanner] day-stats:', e.message);
        }
    }

    async function pollEvents() {
        const sid = document.getElementById('live-scanner-seminar').value;
        if (!sid || !actor) return;
        try {
            const data = await api(
                '/api/admin/live-scanner/events?seminarId=' +
                    encodeURIComponent(sid) +
                    '&sinceId=' +
                    encodeURIComponent(lastEventId)
            );
            const did = selectedDayId();
            (data.events || []).forEach((ev) => {
                if (ev.id > lastEventId) lastEventId = ev.id;
                if (did && ev.dayId != null && Number(ev.dayId) !== did) return;
                if (did && ev.dayId == null) return;
                prependCard(ev);
                playScanSound(ev.outcome);
            });
            const gotNew = (data.events || []).length > 0;
            if (gotNew) loadApplicants();
            await refreshStats();
            await refreshDayBar(gotNew);
            setLiveState(true, 'Live · updating');
        } catch (e) {
            console.warn('[live-scanner]', e.message);
            setLiveState(false, 'Connection issue');
        }
    }

    function stopPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        setLiveState(false, 'Select event');
    }

    function startPoll() {
        stopPoll();
        lastEventId = 0;
        dayStatsAt = 0;
        const grid = document.getElementById('live-scan-grid');
        if (grid) grid.innerHTML = '';
        updateEmptyState();
        setLiveState(true, 'Connecting…');
        pollEvents();
        pollTimer = setInterval(pollEvents, pollMs);
    }

    async function init() {
        actor = getStoredAdminUser();
        if (!actor || !actor.id) {
            window.location.href = '/admin';
            return;
        }
        applyBackVisibility(actor);
        tickClock();
        clockTimer = setInterval(tickClock, 1000);
        const seminars = await api('/api/admin/live-scanner/seminars');
        const sel = document.getElementById('live-scanner-seminar');
        sel.innerHTML = '<option value="">Choose event…</option>';
        (seminars || []).forEach((s) => {
            const o = document.createElement('option');
            o.value = s.id;
            const date = s.event_date ? String(s.event_date).slice(0, 10) : '';
            o.textContent = (s.title || 'Event') + (date ? ' · ' + date : '');
            sel.appendChild(o);
        });
        if ((seminars || []).length === 1) {
            sel.value = String(seminars[0].id);
        }
        const dayWrap = document.getElementById('live-scanner-day-wrap');
        const daySel = document.getElementById('live-scanner-day');

        async function loadLiveScannerDays(sid) {
            if (!dayWrap || !daySel) return;
            daySel.innerHTML = '<option value="">All days</option>';
            if (!sid) {
                dayWrap.classList.add('hidden');
                return;
            }
            try {
                const days = await api('/api/admin/live-scanner/days?seminarId=' + encodeURIComponent(sid));
                (days || []).forEach((d) => {
                    const o = document.createElement('option');
                    o.value = d.id;
                    const dt = d.day_date || d.checkin_date;
                    o.textContent = d.title + (dt ? ' · ' + String(dt).slice(0, 10) : '');
                    daySel.appendChild(o);
                });
                dayWrap.classList.toggle('hidden', !(days && days.length));
                // Default to today's day; otherwise the day with the latest scans; otherwise Day 1.
                if (days && days.length) {
                    const todayIst = istToday();
                    let pick = days.find((d) => String(d.day_date || d.checkin_date || '').slice(0, 10) === todayIst);
                    if (!pick) {
                        try {
                            const ds = await api('/api/admin/live-scanner/day-stats?seminarId=' + encodeURIComponent(sid));
                            const latest = (ds.days || [])
                                .filter((d) => d.totalEvents > 0)
                                .sort((x, y) => y.lastEventId - x.lastEventId)[0];
                            if (latest) pick = days.find((d) => d.id === latest.dayId);
                        } catch (_) {}
                    }
                    if (!pick && days.length > 1) pick = days[0];
                    if (pick) daySel.value = String(pick.id);
                }
            } catch (e) {
                console.warn('[live-scanner] days:', e.message);
                dayWrap.classList.add('hidden');
            }
        }

        if (sel.value) {
            await loadLiveScannerDays(sel.value);
            startPoll();
            loadApplicants();
        }

        sel.addEventListener('change', async () => {
            ensureAudio();
            await loadLiveScannerDays(sel.value);
            if (sel.value) startPoll();
            else {
                stopPoll();
                renderDayBar(null);
                const scope = document.getElementById('ls-stat-scope');
                if (scope) scope.textContent = '';
            }
            loadApplicants();
            updateEmptyState();
        });
        if (daySel) {
            daySel.addEventListener('change', () => {
                if (sel.value) startPoll();
                loadApplicants();
            });
        }
        const searchEl = document.getElementById('ls-applist-search');
        if (searchEl) searchEl.addEventListener('input', loadApplicants);
        const otpCancel = document.getElementById('ls-otp-cancel');
        if (otpCancel) otpCancel.addEventListener('click', closeLsOtpModal);
        const otpConfirm = document.getElementById('ls-otp-confirm');
        if (otpConfirm) otpConfirm.addEventListener('click', lsOtpConfirm);
        const otpSend = document.getElementById('ls-otp-send');
        if (otpSend) otpSend.addEventListener('click', lsOtpSend);
        const lsModal = document.getElementById('ls-otp-modal');
        if (lsModal) lsModal.addEventListener('click', (e) => { if (e.target === lsModal) closeLsOtpModal(); });
        const soundBtn = document.getElementById('kiosk-sound-toggle');
        if (soundBtn) {
            soundBtn.addEventListener('click', () => {
                soundEnabled = !soundEnabled;
                soundBtn.classList.toggle('is-on', soundEnabled);
                soundBtn.innerHTML = soundEnabled
                    ? '<i class="fas fa-volume-high"></i> Sounds on'
                    : '<i class="fas fa-volume-xmark"></i> Sounds off';
                if (soundEnabled) ensureAudio();
            });
        }
        document.getElementById('live-scanner-back').addEventListener('click', () => {
            window.location.href = '/admin';
        });
        updateEmptyState();
    }

    document.addEventListener('DOMContentLoaded', init);
})();

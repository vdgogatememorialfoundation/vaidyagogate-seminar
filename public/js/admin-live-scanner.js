(function () {
    const pollMs = 1000;
    let lastEventId = 0;
    let pollTimer = null;
    let clockTimer = null;
    let actor = null;

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function getActor() {
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

    function formatCardTime(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return String(iso);
            return d.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                day: 'numeric',
                month: 'short'
            });
        } catch (_) {
            return String(iso);
        }
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

    async function refreshStats() {
        const sid = document.getElementById('live-scanner-seminar').value;
        if (!sid) return;
        const stats = await api('/api/admin/live-scanner/stats?seminarId=' + encodeURIComponent(sid));
        document.getElementById('ls-stat-ok').textContent = stats.successCount || 0;
        document.getElementById('ls-stat-dup').textContent = stats.duplicateCount || 0;
        document.getElementById('ls-stat-fail').textContent = stats.failedCount || 0;
        document.getElementById('ls-stat-tix').textContent = stats.ticketsScanned || 0;
        if (stats.lastEventId > lastEventId) lastEventId = stats.lastEventId;
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
            (data.events || []).forEach((ev) => {
                if (ev.id > lastEventId) lastEventId = ev.id;
                prependCard(ev);
            });
            await refreshStats();
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
        const grid = document.getElementById('live-scan-grid');
        if (grid) grid.innerHTML = '';
        updateEmptyState();
        setLiveState(true, 'Connecting…');
        pollEvents();
        pollTimer = setInterval(pollEvents, pollMs);
    }

    async function init() {
        actor = getActor();
        if (!actor || !actor.id) {
            window.location.href = '/admin.html';
            return;
        }
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
            startPoll();
        }
        sel.addEventListener('change', () => {
            if (sel.value) startPoll();
            else stopPoll();
            updateEmptyState();
        });
        document.getElementById('live-scanner-back').addEventListener('click', () => {
            window.location.href = '/admin.html';
        });
        updateEmptyState();
    }

    document.addEventListener('DOMContentLoaded', init);
})();

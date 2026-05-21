(function () {
    const pollMs = 1000;
    let lastEventId = 0;
    let pollTimer = null;
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

    function prependCard(ev) {
        const grid = document.getElementById('live-scan-grid');
        if (!grid) return;
        const el = document.createElement('article');
        el.className = 'scan-card ' + cardClass(ev.outcome);
        el.dataset.id = String(ev.id);
        const outcomeLabel = String(ev.outcome || 'failed').replace(/_/g, ' ');
        const title =
            ev.outcome === 'success'
                ? '✓ Checked in'
                : ev.outcome === 'duplicate'
                  ? '↻ Duplicate scan'
                  : '✕ ' + outcomeLabel;
        el.innerHTML =
            '<div class="scan-card-head"><span class="scan-outcome-badge">' +
            esc(outcomeLabel) +
            '</span><span class="scan-card-time">' +
            esc(ev.createdAt || '') +
            '</span></div>' +
            '<h4>' +
            esc(title) +
            '</h4>' +
            '<div class="meta"><strong>' +
            esc(ev.doctorName || 'Guest') +
            '</strong></div>' +
            '<div class="scan-card-ids">' +
            '<div><span class="lbl">Ticket</span><code>' +
            esc(ev.ticketId || '—') +
            '</code></div>' +
            '<div><span class="lbl">Application</span><code>' +
            esc(ev.applicationNo || '—') +
            '</code></div></div>' +
            (ev.message ? '<div class="reason">' + esc(ev.message) + '</div>' : '') +
            (ev.scannerName ? '<div class="meta" style="margin-top:6px;">Scanner: ' + esc(ev.scannerName) + '</div>' : '');
        grid.prepend(el);
        while (grid.children.length > 120) grid.removeChild(grid.lastChild);
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
        } catch (e) {
            console.warn('[live-scanner]', e.message);
        }
    }

    function stopPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
    }

    function startPoll() {
        stopPoll();
        lastEventId = 0;
        const grid = document.getElementById('live-scan-grid');
        if (grid) grid.innerHTML = '';
        pollEvents();
        pollTimer = setInterval(pollEvents, pollMs);
    }

    async function init() {
        actor = getActor();
        if (!actor || !actor.id) {
            window.location.href = '/admin.html';
            return;
        }
        const seminars = await api('/api/admin/live-scanner/seminars');
        const sel = document.getElementById('live-scanner-seminar');
        sel.innerHTML = '<option value="">Select event</option>';
        (seminars || []).forEach((s) => {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = (s.title || 'Event') + ' · ' + (s.event_date || '').slice(0, 10);
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            if (sel.value) startPoll();
            else stopPoll();
        });
        document.getElementById('live-scanner-back').addEventListener('click', () => {
            window.location.href = '/admin.html';
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();

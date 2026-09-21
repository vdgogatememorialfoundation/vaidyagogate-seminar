/**
 * Shared on-spot POS UI (admin + staff portals): participant search and
 * 1-hour private registration/payment links.
 * Expects elements with ids: staff-pos-q, staff-pos-results, staff-pos-seminar,
 * staff-pos-amount, staff-pos-first, staff-pos-last, staff-pos-phone,
 * staff-pos-email, staff-pos-user-id, staff-pos-link-out.
 */
(function () {
    function esc(s) {
        return String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    function actorId() {
        try {
            const keys = ['admin_user', 'seminar_staff_user'];
            for (const k of keys) {
                const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
                if (raw) {
                    const u = JSON.parse(raw);
                    if (u && u.id) return u.id;
                }
            }
        } catch (_) {}
        return null;
    }

    function headers() {
        const id = actorId();
        const h = { 'Content-Type': 'application/json' };
        if (id) h['X-Acting-User-Id'] = String(id);
        return h;
    }

    function appNoHtml(no) {
        const str = String(no == null ? '' : no).replace(/^APP_/i, '');
        if (!str) return '';
        if (str.length <= 4) return '<strong>' + esc(str) + '</strong>';
        return (
            '<span style="font-family:ui-monospace,monospace;">' +
            esc(str.slice(0, -4)) +
            '<strong style="background:#fef3c7;color:#92400e;padding:0 3px;border-radius:3px;">' +
            esc(str.slice(-4)) +
            '</strong></span>'
        );
    }

    async function api(url, opts) {
        const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
        let data = {};
        try {
            data = await res.json();
        } catch (_) {}
        return { res, data };
    }

    /* Staff portal uses staff-pos-* ids; the admin portal shares one form (pos-*) between
       "register now" and "send link". */
    const ID_ALIASES = {
        'staff-pos-seminar': ['staff-pos-seminar', 'pos-seminar'],
        'staff-pos-amount': ['staff-pos-amount', 'pos-amount'],
        'staff-pos-first': ['staff-pos-first', 'pos-fname'],
        'staff-pos-middle': ['staff-pos-middle', 'pos-mname'],
        'staff-pos-last': ['staff-pos-last', 'pos-lname'],
        'staff-pos-phone': ['staff-pos-phone', 'pos-phone'],
        'staff-pos-email': ['staff-pos-email', 'pos-email']
    };
    function el(id) {
        const ids = ID_ALIASES[id] || [id];
        for (const i of ids) {
            const e = document.getElementById(i);
            if (e) return e;
        }
        return null;
    }

    let seminarsLoaded = false;
    async function ensureSeminars() {
        const sel = document.getElementById('staff-pos-seminar');
        if (!sel || seminarsLoaded) return;
        try {
            const { data } = await api('/api/seminars?bucket=current');
            const list = data.seminars || data || [];
            sel.innerHTML = '<option value="">Select seminar</option>';
            list.forEach((s) => {
                const o = document.createElement('option');
                o.value = s.id;
                o.textContent = s.title + (s.schedule_label ? ' — ' + s.schedule_label : '');
                sel.appendChild(o);
            });
            seminarsLoaded = list.length > 0;
        } catch (_) {}
    }

    window.staffPosInit = function () {
        ensureSeminars();
    };

    window.staffPosSearch = async function () {
        const root = document.getElementById('staff-pos-results');
        const q = (document.getElementById('staff-pos-q') || {}).value || '';
        if (!root) return;
        ensureSeminars();
        if (q.trim().length < 2) {
            root.innerHTML = '<p style="color:#64748b;">Type at least 2 characters.</p>';
            return;
        }
        root.innerHTML = '<p>Searching…</p>';
        const { res, data } = await api('/api/pos/search?q=' + encodeURIComponent(q.trim()), { headers: headers() });
        if (!res.ok) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Search failed') + '</p>';
            return;
        }
        const users = data.results || [];
        if (!users.length) {
            root.innerHTML =
                '<p style="color:#64748b;">Not registered in the system. Fill the form below to send a private link.</p>';
            return;
        }
        let html =
            '<table class="data-table" style="width:100%;"><thead><tr><th>Participant</th><th>Contact</th><th>Registrations</th><th></th></tr></thead><tbody>';
        users.forEach((u, i) => {
            const name = u.name || '—';
            const regs = (u.registrations || [])
                .map(
                    (r) =>
                        '<div style="font-size:0.82rem;margin-bottom:4px;"><strong>' +
                        esc(r.seminarTitle || 'Seminar') +
                        '</strong><br>' +
                        appNoHtml(r.applicationNo || '') +
                        ' · ' +
                        esc(r.status || '') +
                        (r.ticketId ? ' · Ticket ' + esc(r.ticketId) : '') +
                        '</div>'
                )
                .join('');
            html +=
                '<tr><td><strong>' +
                esc(name) +
                '</strong><br><small>' +
                esc(u.userIdString || '') +
                '</small></td><td style="font-size:0.85rem;">' +
                esc(u.email || '—') +
                '<br>' +
                esc(u.phone || '—') +
                '</td><td>' +
                (regs || '<span style="color:#64748b;">None</span>') +
                '</td><td><button type="button" class="btn btn-primary" data-pos-pick="' +
                i +
                '">Use</button></td></tr>';
        });
        html += '</tbody></table>';
        root.innerHTML = html;
        root.querySelectorAll('[data-pos-pick]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const u = users[Number(btn.getAttribute('data-pos-pick'))];
                if (!u) return;
                const set = (id, v) => {
                    const e = el(id);
                    if (e) e.value = v || '';
                };
                set('staff-pos-user-id', u.id);
                set('staff-pos-first', u.firstName);
                set('staff-pos-middle', u.middleName);
                set('staff-pos-last', u.lastName);
                set('staff-pos-phone', u.phone);
                set('staff-pos-email', u.email);
                const hint = document.getElementById('pos-user-hint');
                if (hint) hint.textContent = 'Selected ' + (u.name || '') + (u.userIdString ? ' (' + u.userIdString + ')' : '') + '.';
                const out = document.getElementById('staff-pos-link-out');
                if (out) out.innerHTML = '<p style="color:#0f766e;">Selected ' + esc(u.email || u.phone || '') + '.</p>';
            });
        });
    };

    window.staffPosCreateLink = async function () {
        const out = document.getElementById('staff-pos-link-out');
        const v = (id) => ((el(id) || {}).value || '').trim();
        const payload = {
            seminarId: v('staff-pos-seminar'),
            amount: v('staff-pos-amount'),
            firstName: v('staff-pos-first'),
            middleName: v('staff-pos-middle'),
            lastName: v('staff-pos-last'),
            phone: v('staff-pos-phone'),
            email: v('staff-pos-email'),
            userId: v('staff-pos-user-id') || null
        };
        if (!payload.seminarId) return alert('Select a seminar.');
        if (!payload.email) return alert('Email is required — the private link is sent there.');
        if (!payload.userId && (!payload.firstName || !payload.lastName)) {
            return alert('First and last name are required for a new participant.');
        }
        if (out) out.innerHTML = '<p>Creating link…</p>';
        const { res, data } = await api('/api/pos/onspot-link', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(payload)
        });
        if (!out) return;
        if (!res.ok) {
            out.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Could not create link') + '</p>';
            return;
        }
        const exp = data.expiresAt ? new Date(data.expiresAt).toLocaleTimeString() : '';
        out.innerHTML =
            '<div style="border:1px solid #cbd5e1;border-radius:8px;padding:10px;background:#f8fafc;">' +
            '<p style="margin:0 0 6px;color:#0f766e;font-weight:600;">' +
            (data.emailQueued ? 'Link emailed to ' + esc(payload.email) : 'Link created (email not queued)') +
            (exp ? ' · expires ' + esc(exp) : '') +
            '</p>' +
            '<input type="text" readonly value="' +
            esc(data.url) +
            '" style="width:100%;padding:6px;font-size:0.85rem;" onclick="this.select()">' +
            '<button type="button" class="btn btn-muted" style="margin-top:6px;" onclick="navigator.clipboard&&navigator.clipboard.writeText(' +
            "'" +
            esc(data.url) +
            "'" +
            ')">Copy link</button></div>';
        const uid = document.getElementById('staff-pos-user-id');
        if (uid) uid.value = '';
    };
})();

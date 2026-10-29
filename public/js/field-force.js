(function () {
    let actor = '';

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function readStored() {
        try {
            const admin = JSON.parse(localStorage.getItem('admin_user') || 'null');
            if (admin && admin.id) return String(admin.id);
        } catch (e) {}
        try {
            const staff = JSON.parse(localStorage.getItem('seminar_staff_user') || 'null');
            if (staff && staff.id) return String(staff.id);
        } catch (e) {}
        return '';
    }

    function istToday() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }

    async function api(url, options) {
        const opts = options || {};
        opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-acting-user-id': actor }, opts.headers || {});
        if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
        const join = url.indexOf('?') >= 0 ? '&' : '?';
        const res = await fetch(url + join + 'actingAdminId=' + encodeURIComponent(actor), opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    function dutyChip(agent) {
        const label = agent.dutyLabel || 'Unknown';
        const cls = agent.duty === 0 ? 'ok' : agent.duty === 2 ? 'warn' : 'muted';
        return '<span class="chip ' + cls + '">' + esc(label) + '</span>';
    }

    function show(id, html) {
        document.getElementById(id).innerHTML = html;
    }

    async function loadVisits() {
        const data = await api('/api/admin/field/bookings');
        const rows = data.bookings || [];
        if (!rows.length) {
            show('visits', '<p>No visits yet. Customers can book at <a href="/services">/services</a>.</p>');
            return;
        }
        show('visits', rows.map((row) => '<article class="visit"><div><strong>' + esc(row.code) + '</strong> <span class="chip">' + esc(row.statusLabel) + '</span></div><div>' + esc(row.startLabel) + '</div><div>' + esc(row.service) + ' · ' + esc(row.kindLabel) + (row.jobId ? ' · Task ' + esc(row.jobId) : '') + '</div><div>' + esc(row.name) + ' · ' + esc(row.phone) + '</div><div>' + esc(row.address) + '</div>' + (row.partner ? '<div>Partner ' + esc(row.partner) + '</div>' : '') + (row.status === 'cancelled' || row.status === 'completed' ? '' : '<p><button type="button" class="btn ghost" data-assign="' + esc(row.id) + '">Assign</button> <button type="button" class="btn ghost" data-cancel="' + esc(row.id) + '">Cancel</button></p>') + '</article>').join(''));
        document.querySelectorAll('[data-cancel]').forEach((button) => {
            button.addEventListener('click', async () => {
                if (!window.confirm('Cancel this visit in Tookan?')) return;
                try {
                    await api('/api/admin/field/bookings/' + button.getAttribute('data-cancel') + '/cancel', { method: 'POST', body: {} });
                    loadVisits();
                } catch (err) { alert(err.message); }
            });
        });
        document.querySelectorAll('[data-assign]').forEach((button) => {
            button.addEventListener('click', async () => {
                const fleetId = window.prompt('Agent id (fleet id)');
                if (!fleetId) return;
                const teamId = window.prompt('Team id', '') || '';
                const fleetName = window.prompt('Agent name', '') || '';
                try {
                    await api('/api/admin/field/bookings/' + button.getAttribute('data-assign') + '/assign', { method: 'POST', body: { fleetId: fleetId, teamId: teamId, fleetName: fleetName } });
                    loadVisits();
                } catch (err) { alert(err.message); }
            });
        });
    }

    async function loadTeams() {
        const data = await api('/api/admin/field/teams');
        const teams = data.teams || [];
        show('teams', teams.length ? teams.map((team) => '<article class="visit"><strong>' + esc(team.name) + '</strong><div>Id ' + esc(team.teamId) + (team.tags ? ' · ' + esc(team.tags) : '') + '</div></article>').join('') : '<p>No teams returned.</p>');
    }

    async function loadAgents() {
        const availability = document.getElementById('agent-filter').value;
        const data = await api('/api/admin/field/agents' + (availability ? '?availability=' + encodeURIComponent(availability) : ''));
        const agents = data.agents || [];
        show('agents', agents.length ? agents.map((agent) => {
            const map = agent.latitude != null && agent.longitude != null
                ? '<a href="https://www.google.com/maps?q=' + encodeURIComponent(agent.latitude + ',' + agent.longitude) + '" target="_blank" rel="noopener">Map</a>'
                : '<button type="button" class="btn ghost" data-loc="' + esc(agent.fleetId) + '">Locate</button>';
            return '<article class="visit"><strong>' + esc(agent.name) + '</strong> ' + dutyChip(agent) + '<div>' + esc(agent.phone) + ' · Id ' + esc(agent.fleetId) + '</div><div>' + esc(agent.teamName || agent.teamId) + (agent.transport ? ' · ' + esc(agent.transport) : '') + '</div><p>' + map + '</p></article>';
        }).join('') : '<p>No agents returned.</p>');
        document.querySelectorAll('[data-loc]').forEach((button) => {
            button.addEventListener('click', async () => {
                try {
                    const loc = await api('/api/admin/field/agents/' + encodeURIComponent(button.getAttribute('data-loc')) + '/location');
                    if (loc.latitude == null) return alert('No location yet.');
                    window.open('https://www.google.com/maps?q=' + loc.latitude + ',' + loc.longitude, '_blank', 'noopener');
                } catch (err) { alert(err.message); }
            });
        });
    }

    async function loadServiceOptions() {
        const data = await api('/api/admin/field/services');
        const select = document.getElementById('d-service');
        select.innerHTML = '<option value="">Custom</option>' + (data.services || []).map((service) => '<option value="' + esc(service.id) + '">' + esc(service.name) + '</option>').join('');
    }

    function fillTimes() {
        const select = document.getElementById('d-time');
        let html = '';
        for (let hour = 8; hour <= 19; hour++) {
            [0, 30].forEach((minute) => {
                const hh = String(hour).padStart(2, '0');
                const mm = String(minute).padStart(2, '0');
                html += '<option value="' + hh + ':' + mm + '">' + hh + ':' + mm + '</option>';
            });
        }
        select.innerHTML = html;
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
        const get = (type) => parts.find((part) => part.type === type).value;
        let hour = Number(get('hour'));
        let minute = Number(get('minute')) < 30 ? 30 : 0;
        if (minute === 0) hour += 1;
        let date = get('year') + '-' + get('month') + '-' + get('day');
        if (hour < 8) hour = 8;
        if (hour > 19) {
            const next = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))) + 86400000);
            const pad = (n) => String(n).padStart(2, '0');
            date = next.getUTCFullYear() + '-' + pad(next.getUTCMonth() + 1) + '-' + pad(next.getUTCDate());
            hour = 10;
            minute = 0;
        }
        const input = document.getElementById('d-date');
        input.min = istToday();
        input.value = date;
        select.value = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    }

    document.getElementById('tabs').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-tab]');
        if (!button) return;
        document.querySelectorAll('#tabs button').forEach((el) => el.classList.toggle('on', el === button));
        ['visits', 'teams', 'agents', 'new'].forEach((name) => {
            document.getElementById('panel-' + name).classList.toggle('hidden', button.getAttribute('data-tab') !== name);
        });
    });

    document.getElementById('actor-save').addEventListener('click', () => {
        actor = document.getElementById('actor-id').value.trim();
        boot();
    });
    document.getElementById('reload-visits').addEventListener('click', () => loadVisits().catch((err) => show('visits', '<div class="err">' + esc(err.message) + '</div>')));
    document.getElementById('reload-teams').addEventListener('click', () => loadTeams().catch((err) => show('teams', '<div class="err">' + esc(err.message) + '</div>')));
    document.getElementById('reload-agents').addEventListener('click', () => loadAgents().catch((err) => show('agents', '<div class="err">' + esc(err.message) + '</div>')));
    document.getElementById('agent-filter').addEventListener('change', () => loadAgents().catch((err) => show('agents', '<div class="err">' + esc(err.message) + '</div>')));

    document.getElementById('team-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            await api('/api/admin/field/teams', { method: 'POST', body: { teamName: document.getElementById('team-name').value, batteryUsage: document.getElementById('team-battery').value, tags: document.getElementById('team-tags').value } });
            document.getElementById('team-msg').innerHTML = '<div class="note">Team created.</div>';
            loadTeams();
        } catch (err) {
            document.getElementById('team-msg').innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        }
    });

    document.getElementById('agent-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const msg = document.getElementById('agent-msg');
        try {
            const data = await api('/api/admin/field/agents', {
                method: 'POST',
                body: {
                    firstName: document.getElementById('ag-first').value,
                    lastName: document.getElementById('ag-last').value,
                    phone: document.getElementById('ag-phone').value,
                    email: document.getElementById('ag-email').value,
                    username: document.getElementById('ag-user').value,
                    teamId: document.getElementById('ag-team').value,
                    transportType: document.getElementById('ag-vehicle').value,
                    password: document.getElementById('ag-pass').value
                }
            });
            msg.innerHTML = '<div class="note">Agent added' + (data.agent && data.agent.fleetId ? ' · id ' + esc(data.agent.fleetId) : '') + '.</div>';
            document.getElementById('ag-pass').value = '';
            loadAgents();
        } catch (err) {
            msg.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        }
    });

    document.getElementById('dispatch-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const msg = document.getElementById('dispatch-msg');
        try {
            const data = await api('/api/admin/field/bookings', {
                method: 'POST',
                body: {
                    serviceId: document.getElementById('d-service').value,
                    kind: document.getElementById('d-kind').value,
                    serviceName: document.getElementById('d-kind').value === 'fos' ? 'Field visit' : 'Appointment',
                    start: document.getElementById('d-date').value + ' ' + document.getElementById('d-time').value + ':00',
                    name: document.getElementById('d-name').value,
                    phone: document.getElementById('d-phone').value,
                    address: document.getElementById('d-address').value,
                    notes: document.getElementById('d-notes').value,
                    teamId: document.getElementById('d-team').value,
                    fleetId: document.getElementById('d-fleet').value
                }
            });
            msg.innerHTML = '<div class="note">Created ' + esc(data.booking.code) + ' · ' + esc(data.booking.startLabel) + '</div>';
            loadVisits();
        } catch (err) {
            msg.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        }
    });

    function boot() {
        document.getElementById('actor-id').value = actor;
        document.getElementById('actor-line').textContent = actor ? 'Using user id ' + actor + '.' : 'Sign in on the staff portal, then open this desk again. Or enter your user id.';
        if (!actor) return;
        loadVisits().catch((err) => show('visits', '<div class="err">' + esc(err.message) + '</div>'));
        loadTeams().catch(() => {});
        loadAgents().catch(() => {});
        loadServiceOptions().catch(() => {});
    }

    fillTimes();
    actor = readStored();
    boot();
})();

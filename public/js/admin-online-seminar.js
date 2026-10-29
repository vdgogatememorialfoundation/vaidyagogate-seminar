/**
 * Online / venue choice on the seminar form, and the office connection card.
 * Seminar save already posts JSON; this adds the online fields without rewriting that save.
 */
(function () {
    function actorId() {
        if (typeof adminActorId === 'function') return adminActorId();
        try {
            const raw = localStorage.getItem('admin_user');
            const user = raw ? JSON.parse(raw) : null;
            return user && user.id;
        } catch (_) {
            return null;
        }
    }

    function val(id) {
        const el = document.getElementById(id);
        return el ? el.value : '';
    }

    function collectOnlineFields() {
        const mode = val('seminar-attend-mode') || 'offline';
        return {
            delivery_mode: mode,
            meeting_provider: val('seminar-meeting-provider') || 'vgmf',
            use_manual_link: !!(document.getElementById('seminar-meeting-manual') || {}).checked,
            meeting_join_url: val('seminar-meeting-join-url').trim(),
            meeting_host_url: val('seminar-meeting-host-url').trim(),
            meeting_passcode: val('seminar-meeting-passcode').trim(),
            meeting_waiting_room: !!(document.getElementById('seminar-meeting-waiting') || {}).checked
        };
    }

    function syncOnlineSeminarFields() {
        const online = val('seminar-attend-mode') === 'online';
        const extra = document.getElementById('seminar-online-extra');
        const provider = document.getElementById('seminar-provider-wrap');
        if (extra) extra.style.display = online ? 'grid' : 'none';
        if (provider) provider.style.display = online ? '' : 'none';
        const vgmf = val('seminar-meeting-provider') === 'vgmf';
        const manualWrap = document.getElementById('seminar-manual-wrap');
        const waiting = document.getElementById('seminar-meeting-waiting');
        if (manualWrap) manualWrap.style.display = online && !vgmf ? 'flex' : 'none';
        if (waiting && waiting.parentElement) waiting.parentElement.style.display = online && vgmf ? 'flex' : 'none';
    }

    function resetOnlineSeminarForm() {
        const mode = document.getElementById('seminar-attend-mode');
        if (mode) mode.value = 'offline';
        const provider = document.getElementById('seminar-meeting-provider');
        if (provider) provider.value = 'vgmf';
        ['seminar-meeting-manual', 'seminar-meeting-waiting'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        ['seminar-meeting-join-url', 'seminar-meeting-host-url', 'seminar-meeting-passcode'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const warn = document.getElementById('seminar-online-warning');
        if (warn) warn.textContent = '';
        syncOnlineSeminarFields();
    }

    function fillOnlineSeminarForm(meeting) {
        const row = meeting || {};
        const mode = document.getElementById('seminar-attend-mode');
        if (mode) mode.value = row.delivery_mode === 'online' ? 'online' : 'offline';
        const provider = document.getElementById('seminar-meeting-provider');
        if (provider && row.provider) provider.value = row.provider;
        const manual = document.getElementById('seminar-meeting-manual');
        if (manual) manual.checked = !!row.use_manual_link;
        const waiting = document.getElementById('seminar-meeting-waiting');
        if (waiting) waiting.checked = !!row.waiting_room;
        const join = document.getElementById('seminar-meeting-join-url');
        if (join) join.value = row.join_url && /^https?:\/\//i.test(row.join_url) ? row.join_url : '';
        const host = document.getElementById('seminar-meeting-host-url');
        if (host) host.value = row.host_url && /^https?:\/\//i.test(row.host_url) ? row.host_url : '';
        const pass = document.getElementById('seminar-meeting-passcode');
        if (pass) pass.value = row.passcode || '';
        const warn = document.getElementById('seminar-online-warning');
        if (warn) warn.textContent = row.warning || '';
        syncOnlineSeminarFields();
    }

    async function loadOnlineSeminarIntoForm(seminarId) {
        const aid = actorId();
        if (!seminarId || !aid) return resetOnlineSeminarForm();
        try {
            const res = await fetch(
                '/api/admin/online-seminar/meetings/' + encodeURIComponent(seminarId) + '?actingAdminId=' + encodeURIComponent(aid),
                { cache: 'no-store' }
            );
            const data = await res.json();
            fillOnlineSeminarForm(data.meeting || {});
        } catch (_) {
            resetOnlineSeminarForm();
        }
    }

    window.openOnlineSeminarHost = async function () {
        const id = val('seminar-id');
        const aid = actorId();
        if (!id || !aid) {
            alert('Save the seminar first, then open the host hall.');
            return;
        }
        const res = await fetch('/api/online-seminar/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ seminarId: Number(id), actingAdminId: aid })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            alert(data.error || 'The hall could not be opened.');
            return;
        }
        if (data.mode === 'hall' && data.token) sessionStorage.setItem('vgmf_hall_token_' + id, data.token);
        window.open(data.url, '_blank', 'noopener');
    };

    const origFetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
        const target = typeof url === 'string' ? url : '';
        const isSave = opts && opts.body && /^\/api\/admin\/seminars(?:\/\d+)?$/.test(target.split('?')[0]);
        if (isSave && document.getElementById('seminar-attend-mode')) {
            try {
                const data = JSON.parse(opts.body);
                Object.assign(data, collectOnlineFields());
                opts = Object.assign({}, opts, { body: JSON.stringify(data) });
            } catch (_) {}
        }
        const pending = origFetch(url, opts);
        if (!isSave) return pending;
        return pending.then(async (res) => {
            try {
                const body = await res.clone().json();
                window.__onlineSeminarWarning = body.onlineSeminarWarning || '';
            } catch (_) {
                window.__onlineSeminarWarning = '';
            }
            return res;
        });
    };

    if (typeof window.saveSeminar === 'function') {
        const origSave = window.saveSeminar;
        window.saveSeminar = async function (e) {
            window.__onlineSeminarWarning = '';
            const origAlert = window.alert;
            window.alert = function (msg) {
                if (String(msg).indexOf('Seminar saved') === 0 && window.__onlineSeminarWarning) {
                    msg = msg + '\n\nOnline seminar: ' + window.__onlineSeminarWarning;
                }
                return origAlert(msg);
            };
            try {
                return await origSave(e);
            } finally {
                window.alert = origAlert;
            }
        };
    }

    if (typeof window.editSeminar === 'function') {
        const origEdit = window.editSeminar;
        window.editSeminar = function (index) {
            const result = origEdit.apply(this, arguments);
            const row = (window.globalSeminars || [])[index];
            loadOnlineSeminarIntoForm(row && row.id);
            return result;
        };
    }

    if (typeof window.openCreateSeminarModal === 'function') {
        const origOpen = window.openCreateSeminarModal;
        window.openCreateSeminarModal = function () {
            const result = origOpen.apply(this, arguments);
            resetOnlineSeminarForm();
            return result;
        };
    }

    document.addEventListener('change', (event) => {
        const id = event.target && event.target.id;
        if (id === 'seminar-attend-mode' || id === 'seminar-meeting-provider') syncOnlineSeminarFields();
    });

    function field(label, id, type, placeholder) {
        return (
            '<label style="display:block;margin:8px 0 4px;font-weight:600;">' +
            label +
            '</label><input id="' +
            id +
            '" type="' +
            (type || 'text') +
            '" autocomplete="off" placeholder="' +
            (placeholder || '') +
            '" style="width:100%;max-width:520px;padding:8px 10px;border:1px solid #99f6e4;border-radius:8px;">'
        );
    }

    function renderSettings(data) {
        const root = document.getElementById('online-seminar-settings-body');
        if (!root || !data) return;
        const s = data.settings || {};
        const z = s.zoom || {};
        const g = s.google || {};
        const w = s.zohoWebinar || {};
        const b = s.zohoBackstage || {};
        const redirect = data.oauthRedirect || '';
        root.innerHTML =
            '<p style="font-size:0.82rem;color:#334155;">OAuth redirect URL to register with Google and Zoho:<br><code>' +
            redirect.replace(/</g, '') +
            '</code></p>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">' +
            '<div><h4 style="margin:8px 0;">Zoom</h4><p style="font-size:0.8rem;color:#64748b;">Server-to-server OAuth app. Scopes: meeting write and meeting update.</p>' +
            field('Account ID', 'os-zoom-account', 'text', z.accountId || '') +
            field('Client ID', 'os-zoom-client', 'text') +
            field('Client secret', 'os-zoom-secret', 'password', z.clientSecret || '') +
            '<button type="button" class="btn-secondary" style="margin-top:8px;" onclick="testOnlineProvider(\'zoom\')">Test Zoom</button></div>' +
            '<div><h4 style="margin:8px 0;">Google Meet</h4><p style="font-size:0.8rem;color:#64748b;">Calendar API client. Scope: calendar events. ' +
            (s.connected && s.connected.google ? 'Account connected.' : 'Not connected yet.') +
            '</p>' +
            field('Client ID', 'os-google-client', 'text') +
            field('Client secret', 'os-google-secret', 'password', g.clientSecret || '') +
            '<button type="button" class="btn-primary" style="margin-top:8px;background:#0f766e;" onclick="connectOnlineProvider(\'google\')">Connect Google</button> ' +
            '<button type="button" class="btn-secondary" style="margin-top:8px;" onclick="testOnlineProvider(\'google\')">Test</button></div>' +
            '<div><h4 style="margin:8px 0;">Zoho Webinar</h4><p style="font-size:0.8rem;color:#64748b;">Scope ZohoWebinar.webinar.CREATE. zsoid is the organization id. ' +
            (s.connected && s.connected.zohoWebinar ? 'Account connected.' : 'Not connected yet.') +
            '</p>' +
            '<label style="display:block;margin:8px 0 4px;font-weight:600;">Data center</label><select id="os-webinar-dc"><option value="in">India</option><option value="com">United States</option><option value="eu">Europe</option><option value="au">Australia</option></select>' +
            field('Client ID', 'os-webinar-client', 'text') +
            field('Client secret', 'os-webinar-secret', 'password', w.clientSecret || '') +
            field('Organization id (zsoid)', 'os-webinar-zsoid', 'text') +
            '<button type="button" class="btn-primary" style="margin-top:8px;background:#0f766e;" onclick="connectOnlineProvider(\'zoho_webinar\')">Connect Zoho Webinar</button> ' +
            '<button type="button" class="btn-secondary" style="margin-top:8px;" onclick="testOnlineProvider(\'zoho_webinar\')">Test</button></div>' +
            '<div><h4 style="margin:8px 0;">Zoho Backstage</h4><p style="font-size:0.8rem;color:#64748b;">Scope ZohoBackstage.event.CREATE. ' +
            (s.connected && s.connected.zohoBackstage ? 'Account connected.' : 'Not connected yet.') +
            '</p>' +
            '<label style="display:block;margin:8px 0 4px;font-weight:600;">Data center</label><select id="os-backstage-dc"><option value="in">India</option><option value="com">United States</option><option value="eu">Europe</option><option value="au">Australia</option></select>' +
            field('Client ID', 'os-backstage-client', 'text') +
            field('Client secret', 'os-backstage-secret', 'password', b.clientSecret || '') +
            field('Portal id', 'os-backstage-portal', 'text') +
            '<button type="button" class="btn-primary" style="margin-top:8px;background:#0f766e;" onclick="connectOnlineProvider(\'zoho_backstage\')">Connect Zoho Backstage</button> ' +
            '<button type="button" class="btn-secondary" style="margin-top:8px;" onclick="testOnlineProvider(\'zoho_backstage\')">Test</button></div>' +
            '</div>' +
            '<button type="button" class="btn-primary" style="margin-top:14px;background:#0f766e;" onclick="saveOnlineSeminarSettings()">Save connections</button>' +
            '<p id="online-seminar-settings-msg" style="font-weight:600;color:#0f766e;"></p>';
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el && value) el.value = value;
        };
        set('os-zoom-account', z.accountId);
        set('os-zoom-client', z.clientId);
        set('os-zoom-secret', z.clientSecret);
        set('os-google-client', g.clientId);
        set('os-google-secret', g.clientSecret);
        set('os-webinar-client', w.clientId);
        set('os-webinar-secret', w.clientSecret);
        set('os-webinar-zsoid', w.zsoid);
        set('os-webinar-dc', w.dc || 'in');
        set('os-backstage-client', b.clientId);
        set('os-backstage-secret', b.clientSecret);
        set('os-backstage-portal', b.portalId);
        set('os-backstage-dc', b.dc || 'in');
    }

    async function loadOnlineSeminarSettings() {
        const aid = actorId();
        const root = document.getElementById('online-seminar-settings-body');
        if (!aid || !root) return;
        const res = await fetch('/api/admin/online-seminar/settings?actingAdminId=' + encodeURIComponent(aid), { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
            root.textContent = data.error || 'Could not load connections.';
            return;
        }
        renderSettings(data);
    }

    window.saveOnlineSeminarSettings = async function () {
        const aid = actorId();
        const msg = document.getElementById('online-seminar-settings-msg');
        const settings = {
            zoom: { accountId: val('os-zoom-account'), clientId: val('os-zoom-client'), clientSecret: val('os-zoom-secret') },
            google: { clientId: val('os-google-client'), clientSecret: val('os-google-secret') },
            zohoWebinar: {
                dc: val('os-webinar-dc') || 'in',
                clientId: val('os-webinar-client'),
                clientSecret: val('os-webinar-secret'),
                zsoid: val('os-webinar-zsoid')
            },
            zohoBackstage: {
                dc: val('os-backstage-dc') || 'in',
                clientId: val('os-backstage-client'),
                clientSecret: val('os-backstage-secret'),
                portalId: val('os-backstage-portal')
            }
        };
        const res = await fetch('/api/admin/online-seminar/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: aid, settings })
        });
        const data = await res.json().catch(() => ({}));
        if (msg) msg.textContent = res.ok ? 'Connections saved.' : data.error || 'Could not save.';
        if (res.ok) renderSettings(data.settings ? { settings: data.settings, oauthRedirect: '' } : data);
        if (res.ok) loadOnlineSeminarSettings();
    };

    window.connectOnlineProvider = async function (provider) {
        const aid = actorId();
        if (!aid) return;
        await window.saveOnlineSeminarSettings();
        window.location.href =
            '/api/admin/online-seminar/oauth/start?provider=' + encodeURIComponent(provider) + '&actingAdminId=' + encodeURIComponent(aid);
    };

    window.testOnlineProvider = async function (provider) {
        const aid = actorId();
        await window.saveOnlineSeminarSettings();
        const res = await fetch('/api/admin/online-seminar/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: aid, provider })
        });
        const data = await res.json().catch(() => ({}));
        const msg = document.getElementById('online-seminar-settings-msg');
        if (msg) msg.textContent = data.message || data.error || (res.ok ? 'Connected.' : 'Test failed.');
    };

    if (typeof window.switchTab === 'function') {
        const origTab = window.switchTab;
        window.switchTab = function (tabId) {
            const result = origTab.apply(this, arguments);
            if (tabId === 'tab-seminars') loadOnlineSeminarSettings().catch(() => {});
            return result;
        };
    }
    syncOnlineSeminarFields();
})();

(function () {
    let currentUser = null;
    let currentTicketRef = null;
    let lastLookup = null;
    let currentLiveSessionId = null;
    let livePollTimer = null;
    let liveMsgSince = 0;
    let inboxPollTimer = null;

    function actorHeaders() {
        return currentUser ? { 'Content-Type': 'application/json', 'X-Acting-User-Id': String(currentUser.id) } : {};
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    async function api(path, opts) {
        const options = opts || {};
        const res = await fetch(path, {
            method: options.method || 'GET',
            headers: Object.assign({}, actorHeaders(), options.headers || {}),
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    window.supportSwitchTab = function (name) {
        document.querySelectorAll('.tab').forEach((t) => {
            t.classList.toggle('active', t.getAttribute('data-panel') === name);
        });
        ['tickets', 'queue', 'live', 'lookup', 'assistant', 'inbox'].forEach((p) => {
            const el = document.getElementById('panel-' + p);
            if (el) el.classList.toggle('hidden', p !== name);
        });
        if (name === 'tickets') supportLoadTickets(true);
        if (name === 'queue') supportLoadTickets(false);
        if (name === 'live') supportLoadLiveSessions();
        if (name === 'inbox') supportLoadInbox();
    };

    window.supportLogout = function () {
        if (window.PortalAuth) PortalAuth.clearUser('support');
        currentUser = null;
        document.getElementById('app-shell').classList.add('hidden');
        document.getElementById('auth-overlay').classList.remove('hidden');
    };

    async function loadSession() {
        const session = await api('/api/support-desk/session');
        document.getElementById('support-user-label').textContent =
            session.user.name + ' · ' + session.user.email;
        document.getElementById('support-duty-label').textContent = session.onDuty
            ? 'On duty (within your working hours)'
            : 'Outside working hours — tickets can still be viewed';
        document.getElementById('support-available-toggle').checked = session.profile.is_available !== 0;
        document.getElementById('support-live-toggle').checked = session.profile.live_chat_enabled !== 0;
    }

    function renderTicketTable(rootId, rows, mine) {
        const root = document.getElementById(rootId);
        if (!rows.length) {
            root.innerHTML = '<p style="color:#64748b;">No tickets in this view.</p>';
            return;
        }
        root.innerHTML =
            '<table class="data-table"><thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Category</th><th>Assignee</th><th></th></tr></thead><tbody>' +
            rows
                .map((t) => {
                    const agent = t.agent_first_name
                        ? esc(t.agent_first_name + ' ' + (t.agent_last_name || ''))
                        : '<span style="color:#94a3b8;">Unassigned</span>';
                    return (
                        '<tr><td><code>' +
                        esc(t.ticket_id) +
                        '</code></td><td>' +
                        esc(t.subject) +
                        '</td><td><span class="badge badge-open">' +
                        esc(t.status) +
                        '</span></td><td>' +
                        esc(t.category || '') +
                        '</td><td>' +
                        agent +
                        '</td><td><button type="button" class="btn btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="supportOpenTicket(\'' +
                        esc(t.ticket_id) +
                        "')\">Open</button></td></tr>"
                    );
                })
                .join('') +
            '</tbody></table>';
    }

    window.supportLoadTickets = async function (mine) {
        const rootId = mine ? 'support-tickets-root' : 'support-queue-root';
        const root = document.getElementById(rootId);
        root.innerHTML = '<p>Loading…</p>';
        try {
            let rows = await api('/api/support-desk/tickets' + (mine ? '?mine=1' : ''));
            if (!mine) {
                rows = rows.filter((t) => !t.assigned_to_staff);
            }
            renderTicketTable(rootId, rows, mine);
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportOpenTicket = async function (ref) {
        currentTicketRef = ref;
        document.getElementById('support-ticket-modal').classList.remove('hidden');
        document.getElementById('support-modal-msg').textContent = '';
        try {
            const ticket = await api('/api/support-desk/tickets/' + encodeURIComponent(ref));
            document.getElementById('support-modal-title').textContent = ticket.subject || ref;
            document.getElementById('support-modal-meta').textContent =
                (ticket.ticket_id || ref) +
                ' · ' +
                (ticket.status || '') +
                ' · Expected response: ' +
                (ticket.expected_response_at
                    ? new Date(ticket.expected_response_at).toLocaleString('en-IN')
                    : '—');
            const thread = document.getElementById('support-modal-thread');
            thread.innerHTML = (ticket.messages || [])
                .map((m) => {
                    const staff = /admin|staff|support/i.test(String(m.sender_type || ''));
                    const held = m.visible_at && new Date(m.visible_at) > new Date();
                    return (
                        '<div class="msg ' +
                        (staff ? 'msg-staff' : 'msg-user') +
                        (held ? ' msg-held' : '') +
                        '"><div style="font-size:0.75rem;color:#64748b;margin-bottom:4px;">' +
                        esc(m.sender_display_name || m.sender_type || 'User') +
                        (held ? ' · hidden until ' + new Date(m.visible_at).toLocaleString('en-IN') : '') +
                        '</div>' +
                        esc(m.message) +
                        '</div>'
                    );
                })
                .join('');
            if (ticket.user_id) {
                const summary = await api('/api/support-desk/user/' + ticket.user_id + '/summary');
                document.getElementById('support-modal-user').innerHTML =
                    '<p><strong>' +
                    esc([summary.user.first_name, summary.user.last_name].filter(Boolean).join(' ')) +
                    '</strong></p><p style="font-size:0.85rem;">Portal ID: <code>' +
                    esc(summary.user.user_id_string) +
                    '</code><br>Email: ' +
                    esc(summary.user.email) +
                    '<br>Phone: ' +
                    esc(summary.user.phone || '—') +
                    '</p><p style="font-size:0.82rem;margin-top:10px;"><strong>Registrations</strong><br>' +
                    (summary.registrations || [])
                        .slice(0, 5)
                        .map((r) => esc(r.application_no + ' — ' + r.status))
                        .join('<br>') +
                    '</p><p style="font-size:0.82rem;margin-top:10px;"><strong>Payments</strong><br>' +
                    (summary.orders || [])
                        .slice(0, 5)
                        .map((o) => esc((o.application_no || '') + ' ₹' + o.amount + ' ' + o.status))
                        .join('<br>') +
                    '</p>';
            }
            const agents = await api('/api/support-desk/agents');
            const depts = await api('/api/support-desk/departments');
            const agSel = document.getElementById('support-transfer-agent');
            agSel.innerHTML =
                '<option value="">Transfer to agent…</option>' +
                agents
                    .map((a) => '<option value="' + a.id + '">' + esc(a.first_name + ' ' + (a.last_name || '')) + '</option>')
                    .join('');
            const dSel = document.getElementById('support-transfer-dept');
            dSel.innerHTML =
                '<option value="">Department…</option>' +
                depts.map((d) => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('');
        } catch (e) {
            document.getElementById('support-modal-msg').textContent = e.message;
        }
    };

    window.supportCloseTicketModal = function () {
        document.getElementById('support-ticket-modal').classList.add('hidden');
        currentTicketRef = null;
    };

    window.supportSendReply = async function () {
        const msg = document.getElementById('support-modal-reply').value.trim();
        if (!msg || !currentTicketRef) return;
        try {
            const out = await api('/api/support-desk/tickets/' + encodeURIComponent(currentTicketRef) + '/reply', {
                method: 'POST',
                body: { message: msg }
            });
            document.getElementById('support-modal-reply').value = '';
            document.getElementById('support-modal-msg').textContent = out.note || 'Reply sent.';
            supportOpenTicket(currentTicketRef);
        } catch (e) {
            document.getElementById('support-modal-msg').textContent = e.message;
        }
    };

    window.supportTransferTicket = async function () {
        if (!currentTicketRef) return;
        const agentId = document.getElementById('support-transfer-agent').value;
        const departmentId = document.getElementById('support-transfer-dept').value;
        try {
            await api('/api/support-desk/tickets/' + encodeURIComponent(currentTicketRef) + '/assign', {
                method: 'PUT',
                body: {
                    agentId: agentId ? parseInt(agentId, 10) : undefined,
                    departmentId: departmentId ? parseInt(departmentId, 10) : undefined
                }
            });
            document.getElementById('support-modal-msg').textContent = 'Ticket transferred.';
            supportLoadTickets(true);
        } catch (e) {
            document.getElementById('support-modal-msg').textContent = e.message;
        }
    };

    window.supportRunLookup = async function () {
        const q = document.getElementById('support-lookup-q').value.trim();
        const root = document.getElementById('support-lookup-root');
        if (!q) return;
        root.innerHTML = '<p>Searching…</p>';
        try {
            const data = await api('/api/support-desk/lookup?q=' + encodeURIComponent(q));
            lastLookup = data;
            let html = '';
            if (data.track) {
                html +=
                    '<div class="card" style="background:#ecfdf5;margin-bottom:12px;"><strong>Track result</strong><pre style="white-space:pre-wrap;font-size:0.85rem;">' +
                    esc(JSON.stringify(data.track, null, 2)) +
                    '</pre></div>';
            }
            html += '<table class="data-table"><thead><tr><th>Portal ID</th><th>Name</th><th>Email</th><th>Open tickets</th><th></th></tr></thead><tbody>';
            html += (data.users || [])
                .map(
                    (u) =>
                        '<tr><td><code>' +
                        esc(u.user_id_string) +
                        '</code></td><td>' +
                        esc(u.first_name + ' ' + (u.last_name || '')) +
                        '</td><td>' +
                        esc(u.email) +
                        '</td><td>' +
                        esc(u.open_tickets) +
                        '</td><td><button type="button" class="btn btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="supportShowUser(' +
                        u.id +
                        ')">Details</button></td></tr>'
                )
                .join('');
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportShowUser = async function (userId) {
        try {
            const summary = await api('/api/support-desk/user/' + userId + '/summary');
            lastLookup = { summary };
            document.getElementById('support-lookup-root').innerHTML =
                '<pre style="white-space:pre-wrap;font-size:0.85rem;background:#f8fafc;padding:12px;border-radius:8px;">' +
                esc(JSON.stringify(summary, null, 2)) +
                '</pre>';
        } catch (e) {
            alert(e.message);
        }
    };

    window.supportAssistantAsk = async function () {
        const input = document.getElementById('support-assistant-input');
        const q = input.value.trim();
        if (!q) return;
        const log = document.getElementById('support-assistant-log');
        log.innerHTML += '<div><strong>You:</strong> ' + esc(q) + '</div>';
        input.value = '';
        let reply = 'Search Account lookup first, then ask about portal ID, applications, or tickets.';
        if (lastLookup && lastLookup.summary) {
            const s = lastLookup.summary;
            reply =
                'Account ' +
                s.user.user_id_string +
                ': ' +
                (s.registrations || []).length +
                ' registration(s), ' +
                (s.tickets || []).length +
                ' ticket(s), ' +
                (s.orders || []).length +
                ' order(s).';
            if (/pending|payment/i.test(q)) {
                const pending = (s.orders || []).filter((o) => String(o.status).toLowerCase() !== 'success');
                reply += pending.length
                    ? ' Pending payments: ' + pending.map((o) => o.application_no + ' (' + o.status + ')').join(', ')
                    : ' No pending payments found.';
            }
        } else if (lastLookup && lastLookup.track) {
            reply = 'Latest track: ' + JSON.stringify(lastLookup.track);
        }
        log.innerHTML += '<div style="margin:8px 0;padding:8px;background:#ecfdf5;border-radius:8px;"><strong>Assistant:</strong> ' + esc(reply) + '</div>';
        log.scrollTop = log.scrollHeight;
    };

    window.supportLoadInbox = async function () {
        const root = document.getElementById('support-inbox-root');
        if (!root) return;
        try {
            const rows = await api('/api/support-desk/inbox');
            const unread = rows.filter((r) => !r.read_at).length;
            const badge = document.getElementById('support-inbox-badge');
            if (badge) {
                badge.textContent = String(unread);
                badge.classList.toggle('hidden', unread < 1);
            }
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No alerts.</p>';
                return;
            }
            root.innerHTML = rows
                .map(
                    (r) =>
                        '<div style="padding:10px;border-bottom:1px solid #e2e8f0;' +
                        (r.read_at ? '' : 'background:#ecfdf5;') +
                        '"><strong>' +
                        esc(r.title) +
                        '</strong><p style="margin:4px 0;font-size:0.85rem;">' +
                        esc(r.body) +
                        '</p><span style="font-size:0.75rem;color:#64748b;">' +
                        esc(r.created_at) +
                        '</span></div>'
                )
                .join('');
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportMarkAllInboxRead = async function () {
        try {
            await api('/api/support-desk/inbox/read-all', { method: 'PUT', body: {} });
            supportLoadInbox();
        } catch (_) {}
    };

    window.supportLoadLiveSessions = async function () {
        const root = document.getElementById('support-live-root');
        if (!root) return;
        try {
            const rows = await api('/api/support-desk/live/sessions?status=waiting,active');
            const waiting = rows.filter((r) => r.status === 'waiting').length;
            const badge = document.getElementById('support-live-badge');
            if (badge) {
                badge.textContent = String(waiting);
                badge.classList.toggle('hidden', waiting < 1);
            }
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No active sessions.</p>';
                return;
            }
            root.innerHTML =
                '<table class="data-table"><thead><tr><th>Session</th><th>Visitor</th><th>Status</th><th></th></tr></thead><tbody>' +
                rows
                    .map((s) => {
                        const name = s.first_name
                            ? esc(s.first_name + ' ' + (s.last_name || ''))
                            : 'Guest #' + s.id;
                        return (
                            '<tr><td>#' +
                            s.id +
                            '</td><td>' +
                            name +
                            '</td><td>' +
                            esc(s.status) +
                            '</td><td><button type="button" class="btn btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="supportOpenLiveSession(' +
                            s.id +
                            ')">' +
                            (s.status === 'waiting' ? 'Claim' : 'Open') +
                            '</button></td></tr>'
                        );
                    })
                    .join('') +
                '</tbody></table>';
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportOpenLiveSession = async function (sessionId) {
        currentLiveSessionId = sessionId;
        liveMsgSince = 0;
        document.getElementById('support-live-chat-panel').classList.remove('hidden');
        document.getElementById('support-live-chat-title').textContent = 'Live chat #' + sessionId;
        try {
            await api('/api/support-desk/live/' + sessionId + '/claim', { method: 'POST', body: {} });
        } catch (_) {}
        supportPollLiveMessages();
        if (livePollTimer) clearInterval(livePollTimer);
        livePollTimer = setInterval(supportPollLiveMessages, 3000);
    };

    async function supportPollLiveMessages() {
        if (!currentLiveSessionId) return;
        try {
            const rows = await api(
                '/api/support-desk/live/' + currentLiveSessionId + '/messages?since=' + liveMsgSince
            );
            const thread = document.getElementById('support-live-thread');
            rows.forEach((m) => {
                if (m.id > liveMsgSince) liveMsgSince = m.id;
                const staff = m.sender_type === 'agent';
                thread.innerHTML +=
                    '<div class="msg ' +
                    (staff ? 'msg-staff' : 'msg-user') +
                    '">' +
                    esc(m.message) +
                    '</div>';
            });
            thread.scrollTop = thread.scrollHeight;
        } catch (_) {}
    }

    window.supportSendLiveMessage = async function () {
        const input = document.getElementById('support-live-input');
        const msg = input.value.trim();
        if (!msg || !currentLiveSessionId) return;
        try {
            await api('/api/support-desk/live/' + currentLiveSessionId + '/message', {
                method: 'POST',
                body: { message: msg }
            });
            input.value = '';
            supportPollLiveMessages();
        } catch (e) {
            alert(e.message);
        }
    };

    window.supportCloseLiveSession = async function () {
        if (!currentLiveSessionId) return;
        try {
            await api('/api/support-desk/live/' + currentLiveSessionId + '/close', { method: 'POST', body: {} });
        } catch (_) {}
        currentLiveSessionId = null;
        if (livePollTimer) clearInterval(livePollTimer);
        document.getElementById('support-live-chat-panel').classList.add('hidden');
        supportLoadLiveSessions();
    };

    async function saveAvailability() {
        if (!currentUser) return;
        try {
            await api('/api/support-desk/availability', {
                method: 'PUT',
                body: {
                    isAvailable: document.getElementById('support-available-toggle').checked,
                    liveChatEnabled: document.getElementById('support-live-toggle').checked
                }
            });
        } catch (_) {}
    }

    document.getElementById('support-available-toggle').addEventListener('change', saveAvailability);
    document.getElementById('support-live-toggle').addEventListener('change', saveAvailability);

    function showSupportApp(user) {
        currentUser = user;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('app-shell').classList.remove('hidden');
        loadSession()
            .then(() => {
                supportLoadTickets(true);
                supportLoadInbox();
                if (inboxPollTimer) clearInterval(inboxPollTimer);
                inboxPollTimer = setInterval(function () {
                    supportLoadInbox();
                    supportLoadLiveSessions();
                }, 30000);
                if (location.hash === '#live') supportSwitchTab('live');
            })
            .catch(supportLogout);
    }

    if (window.PortalAuth && typeof PortalAuth.bindLoginForm === 'function') {
        PortalAuth.bindLoginForm({
            portal: 'support',
            formId: 'support-login-form',
            otpPanelId: 'support-login-otp-panel',
            emailInputId: 'support-login-email',
            passwordInputId: 'support-login-password',
            onSuccess: showSupportApp,
            onError: function (msg) {
                const el = document.getElementById('support-login-msg');
                if (el) {
                    el.textContent = msg;
                    el.style.color = '#b91c1c';
                }
            }
        });
    } else {
        document.getElementById('support-login-form').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            const msg = document.getElementById('support-login-msg');
            msg.textContent = 'Signing in…';
            msg.style.color = '#64748b';
            try {
                const email = document.getElementById('support-login-email').value.trim();
                const password = document.getElementById('support-login-password').value;
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, portal: 'support' })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) throw new Error(data.error || 'Login failed');
                if (window.PortalAuth) PortalAuth.setUser('support', data.user);
                showSupportApp(data.user);
                msg.textContent = '';
            } catch (e) {
                msg.textContent = e.message;
                msg.style.color = '#b91c1c';
            }
        });
    }

    (function init() {
        if (window.PortalAuth) {
            const saved = PortalAuth.getUser('support');
            if (saved && saved.id) {
                showSupportApp(saved);
            }
        }
    })();
})();

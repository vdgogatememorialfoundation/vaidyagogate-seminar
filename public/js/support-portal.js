(function () {
    let currentUser = null;
    let currentTicketRef = null;
    let lastLookup = null;
    let lastLookupQuery = '';
    let lastLookupResults = null;
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

    function formatSupportWhen(iso) {
        if (!iso) return '—';
        try {
            return (
                new Date(iso).toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    dateStyle: 'medium',
                    timeStyle: 'short'
                }) + ' IST'
            );
        } catch (_) {
            return String(iso);
        }
    }

    function supportStatusBadge(status) {
        const s = String(status || '').toLowerCase();
        let color = '#64748b';
        if (s === 'open' || s === 'approved' || s === 'success' || s === 'paid') color = '#059669';
        else if (s === 'in_progress' || s === 'pending' || s === 'waiting') color = '#d97706';
        else if (s === 'closed' || s === 'resolved' || s === 'rejected') color = '#64748b';
        return (
            '<span style="display:inline-block;background:' +
            color +
            '22;color:' +
            color +
            ';padding:2px 8px;border-radius:999px;font-size:0.78rem;font-weight:700;">' +
            esc(status || '—') +
            '</span>'
        );
    }

    function renderSupportTrackCard(track) {
        if (!track || track.error) {
            return track && track.error
                ? '<p style="color:#64748b;font-size:0.88rem;margin:0 0 12px;">' + esc(track.error) + '</p>'
                : '';
        }
        if (track.type === 'seminar') {
            return (
                '<div class="card" style="background:#ecfdf5;border:1px solid #99f6e4;margin-bottom:14px;padding:12px;">' +
                '<strong style="color:#0f766e;">Seminar application</strong>' +
                '<p style="margin:8px 0 0;font-size:0.88rem;"><code>' +
                esc(track.applicationNo) +
                '</code> · ' +
                supportStatusBadge(track.status) +
                (track.seminarTitle ? '<br>Seminar: ' + esc(track.seminarTitle) : '') +
                (track.participant && track.participant.portalId
                    ? '<br>Portal ID: <code>' + esc(track.participant.portalId) + '</code>'
                    : '') +
                '</p></div>'
            );
        }
        if (track.type === 'case') {
            return (
                '<div class="card" style="background:#eff6ff;border:1px solid #bfdbfe;margin-bottom:14px;padding:12px;">' +
                '<strong style="color:#1d4ed8;">Case submission</strong>' +
                '<p style="margin:8px 0 0;font-size:0.88rem;"><code>' +
                esc(track.applicationNo) +
                '</code> · ' +
                supportStatusBadge(track.status) +
                (track.programTitle ? '<br>Program: ' + esc(track.programTitle) : '') +
                '</p></div>'
            );
        }
        if (track.type === 'support_ticket') {
            return (
                '<div class="card" style="background:#fef3c7;border:1px solid #fcd34d;margin-bottom:14px;padding:12px;">' +
                '<strong style="color:#92400e;">Support ticket match</strong>' +
                '<p style="margin:8px 0 0;font-size:0.88rem;"><code>' +
                esc(track.ticketRef) +
                '</code> · ' +
                supportStatusBadge(track.status) +
                (track.subject ? '<br>' + esc(track.subject) : '') +
                '<br><button type="button" class="btn btn-primary" style="margin-top:8px;padding:6px 10px;font-size:0.8rem;" onclick="supportOpenTicket(' +
                JSON.stringify(String(track.ticketRef || '')) +
                ')">Open ticket</button></p></div>'
            );
        }
        return '';
    }

    function renderSupportUserSummary(summary, opts) {
        opts = opts || {};
        const u = summary.user || {};
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '—';
        let html = '';
        if (opts.showBack) {
            html +=
                '<button type="button" class="btn btn-muted" style="margin-bottom:12px;" onclick="supportLookupBack()">← Back to search</button>';
        }
        html +=
            '<div class="card" style="background:#f0fdfa;border:1px solid #99f6e4;margin-bottom:14px;padding:14px;">' +
            '<h3 style="margin:0 0 10px;font-size:1.05rem;color:#0f766e;">' +
            esc(name) +
            '</h3>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;font-size:0.88rem;">' +
            '<div><strong>Portal ID</strong><br><code>' +
            esc(u.user_id_string || '—') +
            '</code></div>' +
            '<div><strong>Email</strong><br>' +
            esc(u.email || '—') +
            '</div>' +
            '<div><strong>Phone</strong><br>' +
            esc(u.phone || '—') +
            '</div>' +
            '<div><strong>Role</strong><br>' +
            esc(u.user_role || '—') +
            '</div>' +
            '<div><strong>Joined</strong><br>' +
            esc(formatSupportWhen(u.created_at)) +
            '</div></div></div>';

        const regs = summary.registrations || [];
        html += '<h4 style="margin:0 0 8px;font-size:0.95rem;">Seminar registrations (' + regs.length + ')</h4>';
        if (!regs.length) {
            html += '<p style="color:#64748b;font-size:0.88rem;margin:0 0 16px;">No seminar registrations on file.</p>';
        } else {
            html +=
                '<table class="data-table" style="margin-bottom:16px;"><thead><tr><th>Application</th><th>Status</th><th>Created</th></tr></thead><tbody>' +
                regs
                    .map(
                        (r) =>
                            '<tr><td><code>' +
                            esc(r.application_no) +
                            '</code></td><td>' +
                            supportStatusBadge(r.status) +
                            '</td><td>' +
                            esc(formatSupportWhen(r.created_at)) +
                            '</td></tr>'
                    )
                    .join('') +
                '</tbody></table>';
        }

        const tickets = summary.tickets || [];
        html += '<h4 style="margin:0 0 8px;font-size:0.95rem;">Support tickets (' + tickets.length + ')</h4>';
        if (!tickets.length) {
            html += '<p style="color:#64748b;font-size:0.88rem;margin:0 0 16px;">No support tickets.</p>';
        } else {
            html +=
                '<table class="data-table" style="margin-bottom:16px;"><thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Category</th><th></th></tr></thead><tbody>' +
                tickets
                    .map((t) => {
                        const ref = t.ticket_id || t.tracking_id || '';
                        return (
                            '<tr><td><code>' +
                            esc(ref) +
                            '</code></td><td>' +
                            esc(t.subject || '—') +
                            '</td><td>' +
                            supportStatusBadge(t.status) +
                            '</td><td>' +
                            esc(t.category || '—') +
                            '</td><td><button type="button" class="btn btn-primary" style="padding:4px 8px;font-size:0.78rem;" onclick="supportOpenTicket(' +
                            JSON.stringify(String(ref)) +
                            ')">Open</button></td></tr>'
                        );
                    })
                    .join('') +
                '</tbody></table>';
        }

        const orders = summary.orders || [];
        html += '<h4 style="margin:0 0 8px;font-size:0.95rem;">Orders / payments (' + orders.length + ')</h4>';
        if (!orders.length) {
            html += '<p style="color:#64748b;font-size:0.88rem;margin:0;">No payment orders on file.</p>';
        } else {
            html +=
                '<table class="data-table"><thead><tr><th>Order</th><th>Application</th><th>Amount</th><th>Status</th><th>Paid</th></tr></thead><tbody>' +
                orders
                    .map(
                        (o) =>
                            '<tr><td><code>' +
                            esc(o.order_id_string || '—') +
                            '</code></td><td>' +
                            esc(o.application_no || '—') +
                            '</td><td>₹' +
                            esc(o.amount != null ? o.amount : '—') +
                            '</td><td>' +
                            supportStatusBadge(o.status) +
                            '</td><td>' +
                            esc(formatSupportWhen(o.payment_date)) +
                            '</td></tr>'
                    )
                    .join('') +
                '</tbody></table>';
        }
        return html;
    }

    function renderSupportLookupResults(data) {
        let html = renderSupportTrackCard(data.track);
        const users = data.users || [];
        if (!users.length) {
            html += '<p style="color:#64748b;">No matching doctor accounts. Try portal ID, email, or phone.</p>';
            return html;
        }
        html +=
            '<table class="data-table"><thead><tr><th>Portal ID</th><th>Name</th><th>Email</th><th>Phone</th><th>Registrations</th><th>Open tickets</th><th></th></tr></thead><tbody>';
        html += users
            .map(
                (u) =>
                    '<tr><td><code>' +
                    esc(u.user_id_string) +
                    '</code></td><td>' +
                    esc([u.first_name, u.last_name].filter(Boolean).join(' ')) +
                    '</td><td>' +
                    esc(u.email) +
                    '</td><td>' +
                    esc(u.phone || '—') +
                    '</td><td>' +
                    esc(u.registration_count != null ? u.registration_count : '0') +
                    '</td><td>' +
                    esc(u.open_tickets != null ? u.open_tickets : '0') +
                    '</td><td><button type="button" class="btn btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="supportShowUser(' +
                    u.id +
                    ', true)">View account</button></td></tr>'
            )
            .join('');
        html += '</tbody></table>';
        return html;
    }

    window.supportLookupBack = function () {
        const root = document.getElementById('support-lookup-root');
        if (!root) return;
        if (lastLookupResults) {
            root.innerHTML = renderSupportLookupResults(lastLookupResults);
            lastLookup = lastLookupResults;
            return;
        }
        if (lastLookupQuery) {
            document.getElementById('support-lookup-q').value = lastLookupQuery;
            supportRunLookup();
        }
    };

    window.supportRunLookup = async function () {
        const q = document.getElementById('support-lookup-q').value.trim();
        const root = document.getElementById('support-lookup-root');
        if (!q) return;
        lastLookupQuery = q;
        root.innerHTML = '<p>Searching…</p>';
        try {
            const data = await api('/api/support-desk/lookup?q=' + encodeURIComponent(q));
            lastLookupResults = data;
            lastLookup = data;
            const users = data.users || [];
            if (users.length === 1) {
                const u = users[0];
                const exactPortal = u.user_id_string && String(u.user_id_string) === q;
                const exactEmail = u.email && String(u.email).toLowerCase() === q.toLowerCase();
                const exactPhone = u.phone && String(u.phone).replace(/\D/g, '') === q.replace(/\D/g, '');
                if (exactPortal || exactEmail || exactPhone || /^\d{6,}$/.test(q)) {
                    return supportShowUser(u.id, true);
                }
            }
            root.innerHTML = renderSupportLookupResults(data);
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportShowUser = async function (userId, showBack) {
        const root = document.getElementById('support-lookup-root');
        if (root) root.innerHTML = '<p>Loading account…</p>';
        try {
            const summary = await api('/api/support-desk/user/' + userId + '/summary');
            lastLookup = { summary: summary, userId: userId };
            if (root) {
                root.innerHTML = renderSupportUserSummary(summary, { showBack: !!showBack });
            }
        } catch (e) {
            if (root) root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
            else alert(e.message);
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
            const u = s.user || {};
            const openTickets = (s.tickets || []).filter((t) => {
                const st = String(t.status || '').toLowerCase();
                return st !== 'closed' && st !== 'resolved';
            });
            reply =
                'Account ' +
                (u.user_id_string || '') +
                ' (' +
                [u.first_name, u.last_name].filter(Boolean).join(' ') +
                '): ' +
                (s.registrations || []).length +
                ' registration(s), ' +
                (s.tickets || []).length +
                ' ticket(s) (' +
                openTickets.length +
                ' open), ' +
                (s.orders || []).length +
                ' order(s).';
            if (/ticket|support/i.test(q)) {
                reply += openTickets.length
                    ? ' Open: ' +
                      openTickets
                          .map((t) => (t.ticket_id || t.tracking_id) + ' — ' + t.subject + ' (' + t.status + ')')
                          .join('; ')
                    : ' No open tickets.';
            }
            if (/pending|payment|order/i.test(q)) {
                const pending = (s.orders || []).filter((o) => String(o.status).toLowerCase() !== 'success');
                reply += pending.length
                    ? ' Pending payments: ' + pending.map((o) => (o.application_no || o.order_id_string) + ' (' + o.status + ')').join(', ')
                    : ' No pending payments found.';
            }
            if (/registration|seminar|apply/i.test(q)) {
                reply += (s.registrations || []).length
                    ? ' Registrations: ' +
                      (s.registrations || [])
                          .slice(0, 5)
                          .map((r) => r.application_no + ' (' + r.status + ')')
                          .join(', ')
                    : ' No seminar registrations on file.';
            }
        } else if (lastLookup && lastLookup.track && !lastLookup.track.error) {
            const tr = lastLookup.track;
            reply = 'Track result: ' + (tr.applicationNo || tr.ticketRef || '') + ' — ' + (tr.status || '');
        } else if (lastLookup && lastLookup.users && lastLookup.users.length) {
            reply =
                'Found ' +
                lastLookup.users.length +
                ' account(s). Click View account on the best match, then ask again for details.';
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
                '<table class="data-table"><thead><tr><th>Reference</th><th>Visitor</th><th>Channel</th><th>Status</th><th>Agent</th><th></th></tr></thead><tbody>' +
                rows
                    .map((s) => {
                        const name = s.first_name
                            ? esc(s.first_name + ' ' + (s.last_name || ''))
                            : s.user_id_string
                              ? 'Portal ' + esc(s.user_id_string)
                              : 'Guest';
                        const agent = s.agent_first_name
                            ? esc(s.agent_first_name + ' ' + (s.agent_last_name || ''))
                            : '—';
                        const ref = esc(s.chatRef || 'LCHAT-' + String(s.id).padStart(8, '0'));
                        return (
                            '<tr><td><strong>' +
                            ref +
                            '</strong></td><td>' +
                            name +
                            '</td><td>' +
                            esc(s.channel || 'web') +
                            '</td><td>' +
                            esc(s.status) +
                            '</td><td>' +
                            agent +
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
        const thread = document.getElementById('support-live-thread');
        if (thread) thread.innerHTML = '';
        document.getElementById('support-live-chat-panel').classList.remove('hidden');
        try {
            await api('/api/support-desk/live/' + sessionId + '/claim', { method: 'POST', body: {} });
        } catch (_) {}
        try {
            const session = await api('/api/support-desk/live/' + sessionId);
            const ref = session.chatRef || 'LCHAT-' + String(sessionId).padStart(8, '0');
            document.getElementById('support-live-chat-title').textContent = ref;
            const meta = [];
            if (session.visitorName) meta.push(session.visitorName);
            if (session.visitorPortalId) meta.push('Portal ' + session.visitorPortalId);
            if (session.visitorEmail) meta.push(session.visitorEmail);
            if (session.agentName) meta.push('Agent: ' + session.agentName);
            if (session.linkedTicketId) meta.push('Ticket ' + session.linkedTicketId);
            const metaEl = document.getElementById('support-live-visitor-meta');
            if (metaEl) metaEl.textContent = meta.join(' · ');
        } catch (_) {
            document.getElementById('support-live-chat-title').textContent =
                'LCHAT-' + String(sessionId).padStart(8, '0');
        }
        supportPollLiveMessages();
        if (livePollTimer) clearInterval(livePollTimer);
        livePollTimer = setInterval(supportPollLiveMessages, 3000);
    };

    function renderLiveThreadMessage(m) {
        const st = String(m.sender_type || '').toLowerCase();
        const staff = st === 'agent';
        const isSystem = st === 'system';
        const label = m.sender_name || (isSystem ? 'Support desk' : staff ? 'You' : 'Visitor');
        const cls = isSystem ? 'msg-system' : staff ? 'msg-staff' : 'msg-user';
        return (
            '<div class="msg ' +
            cls +
            '"><div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;font-weight:700;">' +
            esc(label) +
            '</div>' +
            esc(m.message) +
            '</div>'
        );
    }

    async function supportPollLiveMessages() {
        if (!currentLiveSessionId) return;
        try {
            const rows = await api(
                '/api/support-desk/live/' + currentLiveSessionId + '/messages?since=' + liveMsgSince
            );
            const thread = document.getElementById('support-live-thread');
            rows.forEach((m) => {
                if (m.id > liveMsgSince) liveMsgSince = m.id;
                thread.innerHTML += renderLiveThreadMessage(m);
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
        const noteEl = document.getElementById('support-live-close-note');
        const closingMessage = noteEl && noteEl.value.trim ? noteEl.value.trim() : '';
        try {
            await api('/api/support-desk/live/' + currentLiveSessionId + '/close', {
                method: 'POST',
                body: closingMessage ? { closingMessage: closingMessage } : {}
            });
        } catch (_) {}
        currentLiveSessionId = null;
        if (livePollTimer) clearInterval(livePollTimer);
        if (noteEl) noteEl.value = '';
        document.getElementById('support-live-chat-panel').classList.add('hidden');
        supportLoadLiveSessions();
    };

    window.supportSendTicketForm = async function () {
        if (!currentLiveSessionId) return alert('Open a live chat session first.');
        try {
            await api('/api/support-desk/live/' + currentLiveSessionId + '/send-ticket-form', {
                method: 'POST',
                body: {}
            });
            supportPollLiveMessages();
        } catch (e) {
            alert(e.message || 'Could not send ticket form link');
        }
    };

    window.supportCreateLiveTicket = async function () {
        if (!currentLiveSessionId) return alert('Open a live chat session first.');
        const subject = window.prompt('Ticket subject:', 'Follow-up from live chat');
        if (!subject || !subject.trim()) return;
        const description = window.prompt('Ticket description (include issue details):', '');
        if (!description || !description.trim()) return;
        const category = window.prompt('Category (general, technical, billing, registration, other):', 'general') || 'general';
        try {
            const out = await api('/api/support-desk/live/' + currentLiveSessionId + '/create-ticket', {
                method: 'POST',
                body: { subject: subject.trim(), description: description.trim(), category: category.trim() }
            });
            alert('Ticket created: ' + (out.ticketId || '') + (out.expectedResponseDisplay ? ' — Expected response ' + out.expectedResponseDisplay : ''));
            supportPollLiveMessages();
        } catch (e) {
            alert(e.message || 'Could not create ticket');
        }
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

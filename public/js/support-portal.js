(function () {
    let currentUser = null;
    let currentTicketRef = null;
    let lastLookup = null;
    let lastLookupQuery = '';
    let lastLookupResults = null;
    let currentLiveSessionId = null;
    let currentLiveChatRef = '';
    let currentLiveIsGuest = false;

    function liveSessionApiId() {
        return encodeURIComponent(currentLiveChatRef || String(currentLiveSessionId || ''));
    }

    function updateLiveSessionActions(session) {
        currentLiveIsGuest = !!(session && !session.userId);
        const contactBtn = document.getElementById('support-live-contact-form-btn');
        const createBtn = document.getElementById('support-live-create-ticket-btn');
        if (contactBtn) {
            contactBtn.textContent = currentLiveIsGuest ? 'Send contact form' : 'Send portal ticket link';
        }
        if (createBtn) {
            createBtn.style.display = currentLiveIsGuest ? 'none' : '';
        }
    }
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
        document.getElementById('support-duty-label').textContent =
            (session.onDuty
                ? 'On duty (within your working hours)'
                : 'Outside working hours — tickets can still be viewed') +
            ' · Your authority: ' +
            (session.authorityLabel || 'Frontline');
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
            '<table class="data-table"><thead><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Category</th><th>Authority</th><th>Assignee</th><th></th></tr></thead><tbody>' +
            rows
                .map((t) => {
                    const agent = t.agent_first_name
                        ? esc(t.agent_first_name + ' ' + (t.agent_last_name || ''))
                        : '<span style="color:#94a3b8;">Unassigned</span>';
                    const authBadge =
                        (t.required_authority_level || 1) >= 3
                            ? '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:999px;font-size:0.72rem;font-weight:700;">Authority</span>'
                            : (t.required_authority_level || 1) >= 2
                              ? '<span style="background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:999px;font-size:0.72rem;font-weight:700;">Senior</span>'
                              : '<span style="color:#64748b;font-size:0.78rem;">Frontline</span>';
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
                        authBadge +
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
            let meta = (ticket.ticket_id || ref) + ' · ' + (ticket.status || '');
            if (ticket.required_authority_label) {
                meta += ' · Requires ' + ticket.required_authority_label;
            }
            if (ticket.expected_response_at) {
                meta +=
                    ' · Expected response: ' +
                    new Date(ticket.expected_response_at).toLocaleString('en-IN');
            }
            document.getElementById('support-modal-meta').textContent = meta;
            const authBanner = document.getElementById('support-authority-banner');
            if (authBanner) {
                if (ticket.needsEscalation) {
                    authBanner.style.display = 'block';
                    authBanner.innerHTML =
                        '<strong>Higher authority required.</strong> This ticket needs ' +
                        esc(ticket.required_authority_label || 'Authority') +
                        '. You can view details and escalate, but cannot reply or close until it is handled by the right level.';
                } else {
                    authBanner.style.display = 'none';
                    authBanner.textContent = '';
                }
            }
            const replyBtn = document.querySelector('#support-ticket-modal button[onclick="supportSendReply()"]');
            const closeBtn = document.querySelector('#support-ticket-modal button[onclick="supportCloseTicket()"]');
            const replyBox = document.getElementById('support-modal-reply');
            const canAct = ticket.canAct !== false;
            if (replyBtn) replyBtn.disabled = !canAct;
            if (closeBtn) closeBtn.disabled = !canAct;
            if (replyBox) replyBox.disabled = !canAct;
            const statusSel = document.getElementById('support-ticket-status');
            if (statusSel) {
                const st = String(ticket.status || 'open').toLowerCase();
                statusSel.value = st === 'resolved' || st === 'closed' ? st : st === 'in_progress' ? 'in_progress' : 'in_progress';
            }
            const fbEl = document.getElementById('support-modal-feedback');
            if (fbEl) {
                if (ticket.feedback) {
                    fbEl.innerHTML =
                        '<strong>Participant feedback:</strong> ' +
                        '★'.repeat(Math.min(5, parseInt(ticket.feedback.rating, 10) || 0)) +
                        (ticket.feedback.comment ? ' — ' + esc(ticket.feedback.comment) : '');
                } else if (/^(closed|resolved)$/i.test(String(ticket.status || ''))) {
                    fbEl.textContent = 'No participant feedback yet.';
                } else {
                    fbEl.textContent = '';
                }
            }
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
                        .slice(0, 8)
                        .map(
                            (r) =>
                                '<button type="button" class="btn btn-muted" style="display:block;margin:4px 0;padding:4px 8px;font-size:0.78rem;text-align:left;" onclick="supportViewRegistration(' +
                                r.id +
                                ')"><code>' +
                                esc(r.application_no) +
                                '</code> — ' +
                                esc(r.status) +
                                (r.seminar_title ? ' · ' + esc(r.seminar_title) : '') +
                                '</button>'
                        )
                        .join('') +
                    '</p><p style="font-size:0.82rem;margin-top:10px;"><strong>Case applications</strong><br>' +
                    (summary.caseSubmissions || [])
                        .slice(0, 8)
                        .map(
                            (c) =>
                                '<button type="button" class="btn btn-muted" style="display:block;margin:4px 0;padding:4px 8px;font-size:0.78rem;text-align:left;" onclick="supportViewCaseSubmission(' +
                                c.id +
                                ')"><code>' +
                                esc(c.application_no || 'CASE-' + c.id) +
                                '</code> — ' +
                                esc(c.status) +
                                '</button>'
                        )
                        .join('') +
                    ((summary.caseSubmissions || []).length ? '' : '—') +
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

    window.supportEscalateTicket = async function () {
        if (!currentTicketRef) return;
        const note = window.prompt('Optional note for higher authority (cancellation/refund/certificate issues):', '');
        if (note === null) return;
        try {
            const out = await api('/api/support-desk/tickets/' + encodeURIComponent(currentTicketRef) + '/escalate', {
                method: 'POST',
                body: { note: note.trim() }
            });
            document.getElementById('support-modal-msg').textContent =
                out.message || 'Ticket escalated to higher authority.';
            document.getElementById('support-ticket-modal').classList.add('hidden');
            currentTicketRef = null;
            supportLoadTickets(true);
            supportLoadTickets(false);
        } catch (e) {
            document.getElementById('support-modal-msg').textContent = e.message;
        }
    };

    window.supportCloseTicket = async function () {
        if (!currentTicketRef) return;
        const status = document.getElementById('support-ticket-status').value || 'closed';
        const closingNote = document.getElementById('support-ticket-close-note').value.trim();
        if (!confirm('Mark this ticket as ' + status + '? It will leave the active queue and the participant will receive a one-time rating link by email.')) {
            return;
        }
        try {
            await api('/api/support-desk/tickets/' + encodeURIComponent(currentTicketRef) + '/status', {
                method: 'PUT',
                body: { status, closingNote }
            });
            document.getElementById('support-ticket-close-note').value = '';
            document.getElementById('support-ticket-modal').classList.add('hidden');
            currentTicketRef = null;
            supportLoadTickets(true);
        } catch (e) {
            document.getElementById('support-modal-msg').textContent = e.message;
        }
    };

    function supportCaseStatusLabel(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'draft') return 'Draft (not submitted)';
        if (s === 'revision_required') return 'Re-upload documents required';
        if (s === 'documents_requested') return 'Additional documents requested';
        if (s === 'priority_invited') return 'Complete application (priority)';
        if (s === 'judging') return 'Judging in progress';
        if (s === 'judged') return 'Final review in progress';
        if (s === 'under_review') return 'Under review';
        if (s === 'approved_for_judging') return 'Approved for judging';
        if (s === 'selected') return 'Selected / winner';
        if (s === 'disqualified') return 'Disqualified';
        if (s === 'cancelled') return 'Cancelled';
        if (s === 'submitted') return 'Submitted';
        if (s === 'rejected') return 'Rejected';
        return s ? s.replace(/_/g, ' ') : '—';
    }

    function supportCaseFormFieldLabels() {
        return {
            fname: 'First name',
            mname: 'Middle name',
            lname: 'Last name',
            dob: 'Date of birth',
            email: 'Email',
            phone: 'Phone',
            whatsapp: 'WhatsApp',
            category: 'Category',
            qual: 'Qualification',
            upload_cv: 'CV / document',
            upload_video: 'Presentation video',
            agree_terms: 'Terms accepted',
            topic: 'Case topic / title'
        };
    }

    function formatSupportCaseFormValue(key, val) {
        if (val == null || String(val).trim() === '') return '—';
        if (key === 'agree_terms') return val === '1' || val === 1 || val === true ? 'Yes' : 'No';
        return String(val);
    }

    function renderSupportCaseFormTable(formData) {
        const fd = formData && typeof formData === 'object' ? formData : {};
        const labels = supportCaseFormFieldLabels();
        const order = [
            'fname',
            'mname',
            'lname',
            'dob',
            'email',
            'phone',
            'whatsapp',
            'topic',
            'category',
            'qual',
            'upload_cv',
            'upload_video',
            'agree_terms'
        ];
        const seen = new Set();
        let rows = '';
        order.forEach((key) => {
            if (!(key in fd)) return;
            seen.add(key);
            rows +=
                '<tr><td style="width:34%;font-weight:600;vertical-align:top;">' +
                esc(labels[key] || key.replace(/_/g, ' ')) +
                '</td><td style="white-space:pre-wrap;word-break:break-word;">' +
                esc(formatSupportCaseFormValue(key, fd[key])) +
                '</td></tr>';
        });
        Object.keys(fd).forEach((key) => {
            if (seen.has(key)) return;
            rows +=
                '<tr><td style="width:34%;font-weight:600;vertical-align:top;">' +
                esc(labels[key] || key.replace(/_/g, ' ')) +
                '</td><td style="white-space:pre-wrap;word-break:break-word;">' +
                esc(formatSupportCaseFormValue(key, fd[key])) +
                '</td></tr>';
        });
        if (!rows) return '';
        return '<h4 style="margin:14px 0 8px;">Application form</h4><table class="data-table"><tbody>' + rows + '</tbody></table>';
    }

    function renderSupportDocReviewHtml(docReview) {
        if (!docReview || typeof docReview !== 'object') return '';
        const decisionLabels = {
            approve_for_judging: 'Approved for judging',
            reject_documents: 'Document revision requested',
            reject_application: 'Application rejected'
        };
        const decision = String(docReview.decision || '').toLowerCase();
        const decisionLabel = decisionLabels[decision] || (decision ? decision.replace(/_/g, ' ') : '—');
        let html =
            '<h4 style="margin:14px 0 8px;">Document review</h4>' +
            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">' +
            '<p style="margin:0 0 8px;"><strong>Decision:</strong> ' +
            esc(decisionLabel) +
            '</p>';
        if (docReview.reviewed_at) {
            html +=
                '<p style="margin:0 0 8px;"><strong>Reviewed:</strong> ' + esc(formatSupportWhen(docReview.reviewed_at)) + '</p>';
        }
        html +=
            '<p style="margin:0 0 8px;"><strong>Applicant details OK:</strong> ' +
            (docReview.info_ok ? 'Yes' : 'No') +
            '</p>' +
            '<p style="margin:0;"><strong>Files OK:</strong> ' +
            (docReview.files_ok ? 'Yes' : 'No') +
            '</p>';
        if (docReview.rejection_reason) {
            html +=
                '<p style="margin:10px 0 0;padding-top:10px;border-top:1px solid #e2e8f0;"><strong>Note:</strong> ' +
                esc(docReview.rejection_reason) +
                '</p>';
        }
        if (docReview.requested_docs && docReview.requested_docs.length) {
            html +=
                '<p style="margin:8px 0 0;"><strong>Requested documents:</strong> ' +
                esc(docReview.requested_docs.join(', ')) +
                '</p>';
        }
        html += '</div>';
        return html;
    }

    function renderApplicationDetail(detail) {
        if (!detail) return '<p style="color:#64748b;">No details.</p>';
        const p = detail.participant || {};
        const statusLabel =
            detail.type === 'case' ? supportCaseStatusLabel(detail.status) : detail.status || '—';
        let html =
            '<div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:12px;margin-bottom:12px;">' +
            '<strong>' +
            esc(p.name || 'Participant') +
            '</strong><br>Portal ID: <code>' +
            esc(p.portalId || '—') +
            '</code> · Email: ' +
            esc(p.email || '—') +
            ' · Phone: ' +
            esc(p.phone || '—') +
            '</div>';
        html +=
            '<p style="margin:0 0 10px;"><code>' +
            esc(detail.applicationNo || '—') +
            '</code> · ' +
            supportStatusBadge(detail.status, statusLabel) +
            '</p>';
        if (detail.type === 'seminar') {
            html +=
                '<p><strong>Seminar:</strong> ' +
                esc(detail.seminarTitle || '—') +
                (detail.eventDate ? ' · ' + esc(formatSupportWhen(detail.eventDate)) : '') +
                '</p>';
            if (detail.timeline && detail.timeline.steps && detail.timeline.steps.length) {
                html += '<h4 style="margin:14px 0 8px;">Timeline</h4><ul style="margin:0;padding-left:18px;">';
                detail.timeline.steps.forEach((s) => {
                    html +=
                        '<li>' +
                        esc(s.label || s.key || 'Step') +
                        ': <strong>' +
                        esc(s.state || s.status || '—') +
                        '</strong></li>';
                });
                html += '</ul>';
            }
            if (detail.orders && detail.orders.length) {
                html += '<h4 style="margin:14px 0 8px;">Payments</h4><ul style="margin:0;padding-left:18px;">';
                detail.orders.forEach((o) => {
                    html +=
                        '<li>' +
                        esc(o.order_id_string || 'Order') +
                        ' · ₹' +
                        esc(o.amount) +
                        ' · ' +
                        esc(o.status) +
                        '</li>';
                });
                html += '</ul>';
            }
        } else if (detail.type === 'case') {
            html +=
                '<p><strong>Program:</strong> ' +
                esc(detail.programTitle || '—') +
                (detail.category ? ' · ' + esc(detail.category) : '') +
                (detail.title ? '<br><strong>Case title:</strong> ' + esc(detail.title) : '') +
                '</p>';
            if (detail.markingDeadline) {
                html +=
                    '<p style="margin:0 0 10px;font-size:0.85rem;color:#4338ca;"><strong>Judge deadline:</strong> ' +
                    esc(formatSupportWhen(detail.markingDeadline)) +
                    '</p>';
            }
            if (detail.files && detail.files.length) {
                html += '<h4 style="margin:14px 0 8px;">Uploaded files</h4><ul style="margin:0;padding-left:0;list-style:none;">';
                detail.files.forEach((f) => {
                    const size =
                        f.size && Number(f.size) > 0
                            ? ' · ' + (Number(f.size) >= 1048576 ? (Number(f.size) / 1048576).toFixed(1) + ' MB' : Math.round(Number(f.size) / 1024) + ' KB')
                            : '';
                    html += '<li style="margin:0 0 8px;">';
                    if (f.id) {
                        html +=
                            '<button type="button" class="btn btn-primary" style="padding:4px 10px;font-size:0.8rem;" onclick="supportOpenCaseFile(' +
                            Number(f.id) +
                            ')"><i class="fas fa-download"></i> ' +
                            esc(f.name || 'file') +
                            '</button>';
                    } else {
                        html += esc(f.name || 'file');
                    }
                    if (f.status) html += ' <span style="color:#64748b;font-size:0.8rem;">(' + esc(f.status) + ')</span>';
                    if (size) html += '<span style="color:#94a3b8;font-size:0.78rem;">' + esc(size) + '</span>';
                    html += '</li>';
                });
                html += '</ul>';
            }
        }
        if (detail.docReview) {
            html += renderSupportDocReviewHtml(detail.docReview);
        }
        if (detail.type === 'case' && detail.formData) {
            html += renderSupportCaseFormTable(detail.formData);
        } else if (detail.formFields && detail.formFields.length) {
            html += '<h4 style="margin:14px 0 8px;">Application form</h4><table class="data-table"><tbody>';
            detail.formFields.forEach((f) => {
                const val =
                    typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value == null ? '' : f.value);
                html +=
                    '<tr><td style="width:34%;font-weight:600;vertical-align:top;">' +
                    esc(f.key) +
                    '</td><td style="white-space:pre-wrap;word-break:break-word;">' +
                    esc(val) +
                    '</td></tr>';
            });
            html += '</tbody></table>';
        }
        return html;
    }

    window.supportOpenCaseFile = async function (fileId) {
        try {
            const data = await api('/api/support-desk/case-files/' + encodeURIComponent(fileId) + '/access');
            if (data && data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
            else throw new Error('No download URL returned');
        } catch (e) {
            alert(e.message || 'Could not open file');
        }
    };

    window.supportViewRegistration = async function (regId) {
        const modal = document.getElementById('support-app-detail-modal');
        const body = document.getElementById('support-app-detail-body');
        const title = document.getElementById('support-app-detail-title');
        if (!modal || !body) return;
        modal.classList.remove('hidden');
        title.textContent = 'Seminar application';
        body.innerHTML = '<p>Loading…</p>';
        try {
            const detail = await api('/api/support-desk/registrations/' + regId);
            title.textContent = 'Seminar · ' + (detail.applicationNo || regId);
            body.innerHTML = renderApplicationDetail(detail);
        } catch (e) {
            body.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportViewCaseSubmission = async function (caseId) {
        const modal = document.getElementById('support-app-detail-modal');
        const body = document.getElementById('support-app-detail-body');
        const title = document.getElementById('support-app-detail-title');
        if (!modal || !body) return;
        modal.classList.remove('hidden');
        title.textContent = 'Case application';
        body.innerHTML = '<p>Loading…</p>';
        try {
            const detail = await api('/api/support-desk/case-submissions/' + caseId);
            title.textContent = 'Case · ' + (detail.applicationNo || caseId);
            body.innerHTML = renderApplicationDetail(detail);
        } catch (e) {
            body.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.supportCloseAppDetail = function () {
        const modal = document.getElementById('support-app-detail-modal');
        if (modal) modal.classList.add('hidden');
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

    function supportStatusBadge(status, labelOverride) {
        const s = String(status || '').toLowerCase();
        const label = labelOverride != null && String(labelOverride).trim() !== '' ? labelOverride : status || '—';
        let color = '#64748b';
        if (
            s === 'open' ||
            s === 'approved' ||
            s === 'success' ||
            s === 'paid' ||
            s === 'selected' ||
            s === 'approved_for_judging'
        )
            color = '#059669';
        else if (
            s === 'in_progress' ||
            s === 'pending' ||
            s === 'waiting' ||
            s === 'under_review' ||
            s === 'judging' ||
            s === 'judged' ||
            s === 'submitted'
        )
            color = '#d97706';
        else if (s === 'closed' || s === 'resolved' || s === 'rejected' || s === 'disqualified' || s === 'cancelled')
            color = '#64748b';
        return (
            '<span style="display:inline-block;background:' +
            color +
            '22;color:' +
            color +
            ';padding:2px 8px;border-radius:999px;font-size:0.78rem;font-weight:700;">' +
            esc(label) +
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
                (track.registrationId
                    ? '<br><button type="button" class="btn btn-primary" style="margin-top:8px;padding:6px 10px;font-size:0.8rem;" onclick="supportViewRegistration(' +
                      track.registrationId +
                      ')">View full application</button>'
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
                (track.caseSubmissionId
                    ? '<br><button type="button" class="btn btn-primary" style="margin-top:8px;padding:6px 10px;font-size:0.8rem;" onclick="supportViewCaseSubmission(' +
                      track.caseSubmissionId +
                      ')">View full application</button>'
                    : '') +
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
                '<table class="data-table" style="margin-bottom:16px;"><thead><tr><th>Application</th><th>Seminar</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>' +
                regs
                    .map(
                        (r) =>
                            '<tr><td><code>' +
                            esc(r.application_no) +
                            '</code></td><td>' +
                            esc(r.seminar_title || '—') +
                            '</td><td>' +
                            supportStatusBadge(r.status) +
                            '</td><td>' +
                            esc(formatSupportWhen(r.created_at)) +
                            '</td><td><button type="button" class="btn btn-primary" style="padding:4px 8px;font-size:0.78rem;" onclick="supportViewRegistration(' +
                            r.id +
                            ')">Details</button></td></tr>'
                    )
                    .join('') +
                '</tbody></table>';
        }

        const cases = summary.caseSubmissions || [];
        html += '<h4 style="margin:0 0 8px;font-size:0.95rem;">Case applications (' + cases.length + ')</h4>';
        if (!cases.length) {
            html += '<p style="color:#64748b;font-size:0.88rem;margin:0 0 16px;">No case applications on file.</p>';
        } else {
            html +=
                '<table class="data-table" style="margin-bottom:16px;"><thead><tr><th>Application</th><th>Program</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>' +
                cases
                    .map(
                        (c) =>
                            '<tr><td><code>' +
                            esc(c.application_no || 'CASE-' + c.id) +
                            '</code></td><td>' +
                            esc(c.program_title || c.title || '—') +
                            '</td><td>' +
                            supportStatusBadge(c.status) +
                            '</td><td>' +
                            esc(formatSupportWhen(c.created_at)) +
                            '</td><td><button type="button" class="btn btn-primary" style="padding:4px 8px;font-size:0.78rem;" onclick="supportViewCaseSubmission(' +
                            c.id +
                            ')">Details</button></td></tr>'
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

    function bindLiveSessionClicks(root) {
        if (!root || root.__liveClickBound) return;
        root.__liveClickBound = true;
        root.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-live-session-id]');
            if (!btn) return;
            const sid = parseInt(btn.getAttribute('data-live-session-id'), 10);
            if (!Number.isInteger(sid) || sid < 1) return;
            supportOpenLiveSession(sid);
        });
    }

    window.supportLoadLiveSessions = async function () {
        const root = document.getElementById('support-live-root');
        if (!root) return;
        bindLiveSessionClicks(root);
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
                        const ref = esc(s.chatRef || '—');
                        const sid = Number(s.id);
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
                            '</td><td><button type="button" class="btn btn-primary support-live-claim-btn" data-live-session-id="' +
                            sid +
                            '" style="padding:6px 10px;font-size:0.8rem;">' +
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

    window.supportOpenLiveSession = async function (sessionId, chatRef) {
        const sid = parseInt(sessionId, 10);
        if (!Number.isInteger(sid) || sid < 1) return;
        currentLiveSessionId = sid;
        currentLiveChatRef = chatRef || '';
        liveMsgSince = 0;
        const thread = document.getElementById('support-live-thread');
        if (thread) thread.innerHTML = '';
        const panel = document.getElementById('support-live-chat-panel');
        if (panel) panel.classList.remove('hidden');
        const apiId = encodeURIComponent(String(sid));
        let claimErr = '';
        try {
            await api('/api/support-desk/live/' + apiId + '/claim', { method: 'POST', body: {} });
        } catch (e) {
            claimErr = e.message || 'Could not claim session';
        }
        try {
            const session = await api('/api/support-desk/live/' + apiId);
            currentLiveChatRef = session.chatRef || currentLiveChatRef;
            updateLiveSessionActions(session);
            if (claimErr && session.status === 'waiting' && !session.agentName) {
                alert(claimErr);
                return;
            }
            const ref = session.chatRef || 'Live chat';
            document.getElementById('support-live-chat-title').textContent = ref;
            const meta = [];
            if (session.visitorName) meta.push(session.visitorName);
            if (session.visitorPortalId) meta.push('Portal ' + session.visitorPortalId);
            if (session.visitorEmail) meta.push(session.visitorEmail);
            if (!session.userId) meta.push('Website guest');
            if (session.agentName) meta.push('Agent: ' + session.agentName);
            if (session.linkedTicketId) meta.push('Ticket ' + session.linkedTicketId);
            const metaEl = document.getElementById('support-live-visitor-meta');
            if (metaEl) metaEl.textContent = meta.join(' · ');
            const diagWrap = document.getElementById('support-live-visitor-diag');
            const diagBody = document.getElementById('support-live-visitor-diag-body');
            if (diagWrap && diagBody) {
                const lines = [];
                if (session.visitorIp) lines.push('IP: ' + session.visitorIp);
                if (session.visitorLocation) lines.push('Location (IP): ' + session.visitorLocation);
                const d = session.clientDiagnostics || {};
                if (d.network && d.network.downlinkMbps != null) {
                    lines.push('Network: ~' + d.network.downlinkMbps + ' Mbps (' + (d.network.effectiveType || 'unknown') + ')');
                }
                if (d.network && d.network.rttMs != null) lines.push('RTT: ' + d.network.rttMs + ' ms');
                if (d.timezone) lines.push('Timezone: ' + d.timezone);
                if (d.platform) lines.push('Platform: ' + d.platform);
                if (d.userAgent) lines.push('UA: ' + d.userAgent);
                if (lines.length) {
                    diagWrap.classList.remove('hidden');
                    diagBody.textContent = lines.join('\n');
                } else {
                    diagWrap.classList.add('hidden');
                    diagBody.textContent = '';
                }
            }
        } catch (_) {
            document.getElementById('support-live-chat-title').textContent = 'Live chat';
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
                '/api/support-desk/live/' + liveSessionApiId() + '/messages?since=' + liveMsgSince
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
            await api('/api/support-desk/live/' + liveSessionApiId() + '/message', {
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
            await api('/api/support-desk/live/' + liveSessionApiId() + '/close', {
                method: 'POST',
                body: closingMessage ? { closingMessage: closingMessage } : {}
            });
        } catch (_) {}
        currentLiveSessionId = null;
        currentLiveChatRef = '';
        currentLiveIsGuest = false;
        if (livePollTimer) clearInterval(livePollTimer);
        if (noteEl) noteEl.value = '';
        document.getElementById('support-live-chat-panel').classList.add('hidden');
        supportLoadLiveSessions();
    };

    window.supportSendTicketForm = async function () {
        if (!currentLiveSessionId) return alert('Open a live chat session first.');
        try {
            await api('/api/support-desk/live/' + liveSessionApiId() + '/send-ticket-form', {
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
            const out = await api('/api/support-desk/live/' + liveSessionApiId() + '/create-ticket', {
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

(function () {
    'use strict';

    var rows = [];
    var historyRows = [];
    var selected = null;
    var staffList = [];
    var waTemplates = [];
    var waTemplateMap = {};
    var STATUS_LABELS = {
        not_contacted: 'Not Contacted',
        called: 'Called',
        answered: 'Answered',
        not_answered: 'Not Answered (didn\'t pick up)',
        call_back_requested: 'Call Back Requested',
        payment_link_sent: 'Payment Link Sent',
        payment_completed: 'Payment Completed',
        not_interested: 'Not Interested',
        wrong_number: 'Wrong Number',
        other: 'Other'
    };

    async function loadStaffAndTemplates() {
        var id = adminId();
        try {
            var r1 = await fetch('/api/admin/application-contact/staff?actingAdminId=' + encodeURIComponent(id), { cache: 'no-store' });
            var d1 = await r1.json();
            staffList = r1.ok && Array.isArray(d1) ? d1 : [];
        } catch (e) { staffList = []; }
        try {
            var r2 = await fetch('/api/admin/whatsapp/templates', { cache: 'no-store' });
            var d2 = await r2.json();
            waTemplates = r2.ok && Array.isArray(d2.templates) ? d2.templates.filter(function (t) { return Number(t.is_active) === 1; }) : [];
        } catch (e) { waTemplates = []; }
        try {
            var r3 = await fetch('/api/admin/application-contact/wa-template-map?actingAdminId=' + encodeURIComponent(id), { cache: 'no-store' });
            var d3 = await r3.json();
            waTemplateMap = r3.ok && d3 && typeof d3 === 'object' ? d3 : {};
        } catch (e) { waTemplateMap = {}; }
    }

    function staffName(s) {
        return [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email || ('#' + s.id);
    }

    function staffSelectHtml(r, i) {
        var h = '<select onchange="assignAdminPaymentFollowup(' + i + ', this.value)" style="padding:6px;border:1px solid #cbd5e1;border-radius:6px;max-width:170px">';
        h += '<option value="">— Unassigned —</option>';
        staffList.forEach(function (s) {
            h += '<option value="' + Number(s.id) + '"' + (Number(r.assigned_staff_id) === Number(s.id) ? ' selected' : '') + '>' + esc(staffName(s)) + '</option>';
        });
        h += '</select>';
        return h;
    }

    async function assignAdminPaymentFollowup(index, staffUserId) {
        var r = rows[index];
        if (!r) return;
        var url = staffUserId ? '/api/admin/application-contact/assign' : '/api/admin/application-contact/unassign';
        try {
            var response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actingAdminId: adminId(), registrationId: r.registration_id, staffUserId: Number(staffUserId) || undefined })
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to assign');
            r.assigned_staff_id = staffUserId ? Number(staffUserId) : null;
            var s = staffList.find(function (x) { return Number(x.id) === Number(staffUserId); });
            r.assigned_staff_name = s ? staffName(s) : '';
        } catch (e) {
            alert(e.message || 'Unable to assign');
            render();
        }
    }

    function defaultTemplateFor(status) {
        var s = status || 'not_contacted';
        var byMap = waTemplateMap[s] || waTemplateMap.default;
        var t = byMap && waTemplates.find(function (x) { return x.meta_name === byMap || String(x.id) === String(byMap); });
        if (t) return t;
        if (s === 'not_answered') {
            t = waTemplates.find(function (x) { return /not.?answer|missed|no.?answer|unreach|didnt|didn_t|pick/i.test((x.meta_name || '') + ' ' + (x.name || '') + ' ' + (x.category || '')); });
            if (t) return t;
        }
        return waTemplates.find(function (x) { return String(x.category || '').toLowerCase() === 'payment_reminder'; }) || null;
    }

    function templateOptionsHtml(selectedT) {
        var h = '<option value="">— choose a template —</option>';
        waTemplates.forEach(function (t) {
            h += '<option value="' + esc(t.meta_name) + '"' + (selectedT && selectedT.meta_name === t.meta_name ? ' selected' : '') + '>' + esc(t.name || t.meta_name) + ' (' + esc(t.language || 'en') + (t.category ? ', ' + esc(t.category) : '') + ')</option>';
        });
        return h;
    }

    function openTemplateDefaults() {
        var modal = document.getElementById('payment-followup-modal');
        if (!modal) return;
        var h = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">' +
            '<div style="background:white;width:min(650px,100%);max-height:90vh;overflow:auto;border-radius:12px;padding:22px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">WhatsApp template per status</h3><button class="btn" onclick="closeAdminPaymentFollowup()">Close</button></div><hr>' +
            '<p style="color:#475569;font-size:.9rem">Pick which approved Meta template is sent for each call outcome (e.g. the "didn\'t pick up" template for Not Answered). Leave blank to use the default payment reminder.</p>';
        Object.keys(STATUS_LABELS).forEach(function (k) {
            var cur = waTemplates.find(function (x) { return x.meta_name === waTemplateMap[k]; });
            h += '<label style="display:block;margin-top:8px">' + esc(STATUS_LABELS[k]) + '</label><select data-status="' + k + '" class="pf-tpl-map" style="width:100%;padding:8px">' + templateOptionsHtml(cur) + '</select>';
        });
        h += '<div style="margin-top:14px"><button class="btn btn-primary" onclick="saveAdminPaymentFollowupTemplateMap()">Save</button></div><div id="pf-message" style="margin-top:10px"></div></div></div>';
        modal.innerHTML = h;
    }

    async function saveAdminPaymentFollowupTemplateMap() {
        var map = {};
        document.querySelectorAll('.pf-tpl-map').forEach(function (sel) { if (sel.value) map[sel.getAttribute('data-status')] = sel.value; });
        try {
            var response = await fetch('/api/admin/application-contact/wa-template-map', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actingAdminId: adminId(), map: map })
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to save');
            waTemplateMap = data.map || map;
            closeAdminPaymentFollowup();
        } catch (e) { alert(e.message || 'Unable to save'); }
    }

    function adminId() {
        try {
            return Number(JSON.parse(localStorage.getItem('admin_user') || '{}').id || 0);
        } catch (e) {
            return 0;
        }
    }

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function nameOf(r) {
        return [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') || '-';
    }

    function money(v) {
        var n = Number(v);
        return Number.isFinite(n) ? '₹' + n.toFixed(2) : '₹-';
    }

    async function load() {
        var root = document.getElementById('payment-followup-root');
        if (!root) return;

        root.innerHTML = '<p>Loading pending payment applications...</p>';

        var id = adminId();
        if (id < 1) {
            root.innerHTML = '<p style="color:#b91c1c">Administrator session not found.</p>';
            return;
        }

        try {
            var response = await fetch('/api/admin/application-contact/pending-payment?actingAdminId=' + encodeURIComponent(id), {
                cache: 'no-store'
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load');
            rows = Array.isArray(data) ? data : [];
            await loadStaffAndTemplates();
            render();
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c">' + esc(e.message) + '</p>';
        }
    }

    function statusLabel(s) {
        return String(s || 'not_contacted').replace(/_/g, ' ');
    }

    function render() {
        var root = document.getElementById('payment-followup-root');
        if (!root) return;

        var counts = {};
        rows.forEach(function (r) {
            var s = r.contact_status || 'not_contacted';
            counts[s] = (counts[s] || 0) + 1;
        });

        var h = '';
        h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:15px">';
        h += '<strong>Approved but Pending Payment: ' + rows.length + '</strong>';
        h += '<button class="btn btn-primary" onclick="loadAdminPaymentFollowup()">Refresh</button>';
        h += '<button class="btn" onclick="exportAdminPaymentFollowupCsv()">Export CSV</button>';
        h += '<button class="btn" onclick="openAdminPaymentFollowupTemplateDefaults()">WhatsApp templates</button>';
        h += '<input id="payment-followup-search" oninput="filterAdminPaymentFollowup()" placeholder="Search name, application or mobile" style="min-width:280px;padding:8px;border:1px solid #cbd5e1;border-radius:6px">';
        h += '</div>';

        h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:15px">';
        h += '<span class="badge">Not Contacted: ' + (counts.not_contacted || 0) + '</span>';
        h += '<span class="badge">Answered: ' + (counts.answered || 0) + '</span>';
        h += '<span class="badge">Not Answered: ' + (counts.not_answered || 0) + '</span>';
        h += '<span class="badge">Callback: ' + (counts.call_back_requested || 0) + '</span>';
        h += '<span class="badge">Payment Link Sent: ' + (counts.payment_link_sent || 0) + '</span>';
        h += '</div>';

        h += '<div style="overflow:auto;border:1px solid #e2e8f0;border-radius:8px">';
        h += '<table style="width:100%;min-width:1250px;border-collapse:collapse">';
        h += '<thead><tr>';
        h += '<th>Application</th><th>Applicant</th><th>Mobile</th><th>Seminar</th><th>Amount</th>';
        h += '<th>Contact Status</th><th>Assigned staff</th><th>Last Contact</th><th>Follow-up</th><th>Actions</th>';
        h += '</tr></thead><tbody>';

        if (!rows.length) {
            h += '<tr><td colspan="10" style="padding:20px;text-align:center">No pending payment applications found.</td></tr>';
        } else {
            rows.forEach(function (r, i) {
                h += '<tr class="payment-followup-row" data-search="' +
                    esc((r.application_no || '') + ' ' + nameOf(r) + ' ' + (r.phone || '') + ' ' + (r.assigned_staff_name || '')).toLowerCase() + '">';

                h += '<td>' + esc(r.application_no || '-') + '</td>';
                h += '<td><strong>' + esc(nameOf(r)) + '</strong><br><small>' + esc(r.email || '') + '</small></td>';
                h += '<td>' + esc(r.phone || '-') + '</td>';
                h += '<td>' + esc(r.seminar_title || '-') + '</td>';
                h += '<td>' + money(r.order_amount || r.seminar_price) + '</td>';
                h += '<td>' + esc(statusLabel(r.contact_status)) + '</td>';
                h += '<td>' + staffSelectHtml(r, i) + '</td>';
                h += '<td>' + esc(r.last_contact_at || '-') + '</td>';
                h += '<td>' + esc(r.next_follow_up_at || '-') + '</td>';

                h += '<td style="white-space:nowrap">';
                h += '<button class="btn btn-primary" style="margin:2px" onclick="openAdminPaymentFollowup(' + i + ')">Manage</button>';
                h += '<button class="btn" style="margin:2px" onclick="viewAdminPaymentHistory(' + i + ')">History</button>';
                if (r.phone) {
                    h += '<button class="btn" style="margin:2px" onclick="sendAdminPaymentFollowupWhatsApp(' + i + ')">WhatsApp</button>';
                }
                h += '</td></tr>';
            });
        }

        h += '</tbody></table></div>';
        h += '<div id="payment-followup-modal"></div>';
        root.innerHTML = h;
    }

    function sendAdminPaymentFollowupWhatsApp(index) {
        var r = rows[index];
        if (!r || !r.registration_id) return;
        var modal = document.getElementById('payment-followup-modal');
        if (!modal) return;
        if (!waTemplates.length) { alert('No active WhatsApp templates. Sync templates under WhatsApp → Templates first.'); return; }
        var def = defaultTemplateFor(r.contact_status);
        modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">' +
            '<div style="background:white;width:min(560px,100%);border-radius:12px;padding:22px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">Send WhatsApp</h3><button class="btn" onclick="closeAdminPaymentFollowup()">Close</button></div><hr>' +
            '<p><strong>' + esc(nameOf(r)) + '</strong> · ' + esc(r.phone || '') + '<br><small>Status: ' + esc(statusLabel(r.contact_status)) + '</small></p>' +
            '<label>Meta template</label><select id="pf-wa-template" style="width:100%;padding:9px;margin:5px 0 12px">' + templateOptionsHtml(def) + '</select>' +
            '<div style="display:flex;gap:8px"><button class="btn btn-primary" onclick="sendAdminPaymentFollowupWhatsAppNow(' + index + ')">Send</button></div>' +
            '<div id="pf-message" style="margin-top:10px"></div></div></div>';
    }

    async function sendAdminPaymentFollowupWhatsAppNow(index, templateName) {
        var r = rows[index];
        if (!r || !r.registration_id) return;
        var sel = document.getElementById('pf-wa-template');
        var name = templateName || (sel && sel.value) || '';
        var t = waTemplates.find(function (x) { return x.meta_name === name; });
        if (!t) { alert('Choose a template first.'); return; }
        var msg = document.getElementById('pf-message');
        if (msg) msg.textContent = 'Sending…';
        try {
            var body = {
                kind: 'template',
                registration_id: r.registration_id,
                template_name: t.meta_name,
                template_lang: t.language,
                variable_count: Number(t.variable_count) || 0,
                variable_map: Array.isArray(t.variables) ? t.variables : [],
                message_type: r.contact_status === 'not_answered' ? 'payment_followup_not_answered' : 'payment_reminder'
            };
            var response = await fetch('/api/admin/whatsapp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'WhatsApp send failed');
            if (msg) { msg.style.color = '#166534'; msg.textContent = 'WhatsApp sent (' + t.meta_name + ').'; }
            else alert('WhatsApp sent.');
            return true;
        } catch (e) {
            if (msg) { msg.style.color = '#b91c1c'; msg.textContent = e.message || 'WhatsApp send failed'; }
            else alert(e.message || 'WhatsApp send failed');
            return false;
        }
    }

    function filterAdminPaymentFollowup() {
        var input = document.getElementById('payment-followup-search');
        var q = String(input && input.value || '').toLowerCase().trim();
        document.querySelectorAll('.payment-followup-row').forEach(function (row) {
            row.style.display = !q || String(row.getAttribute('data-search') || '').indexOf(q) >= 0 ? '' : 'none';
        });
    }

    function openAdminPaymentFollowup(index) {
        selected = rows[index];
        if (!selected) return;

        var modal = document.getElementById('payment-followup-modal');
        if (!modal) return;

        modal.innerHTML =
            '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">' +
            '<div style="background:white;width:min(650px,100%);max-height:90vh;overflow:auto;border-radius:12px;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.25)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<h3 style="margin:0">Payment Follow-up</h3>' +
            '<button class="btn" onclick="closeAdminPaymentFollowup()">Close</button>' +
            '</div>' +
            '<hr>' +
            '<p><strong>' + esc(nameOf(selected)) + '</strong><br>' +
            'Application: ' + esc(selected.application_no || '-') + '<br>' +
            'Mobile: ' + esc(selected.phone || '-') + '<br>' +
            'Seminar: ' + esc(selected.seminar_title || '-') + '<br>' +
            'Amount: ' + money(selected.order_amount || selected.seminar_price) + '</p>' +

            '<label>Status</label>' +
            '<select id="pf-status" style="width:100%;padding:9px;margin:5px 0 12px">' +
            '<option value="not_contacted">Not Contacted</option>' +
            '<option value="called">Called</option>' +
            '<option value="answered">Answered</option>' +
            '<option value="not_answered">Not Answered</option>' +
            '<option value="call_back_requested">Call Back Requested</option>' +
            '<option value="payment_link_sent">Payment Link Sent</option>' +
            '<option value="payment_completed">Payment Completed</option>' +
            '<option value="not_interested">Not Interested</option>' +
            '<option value="wrong_number">Wrong Number</option>' +
            '<option value="other">Other</option>' +
            '</select>' +

            '<label>Reason</label>' +
            '<input id="pf-reason" style="width:100%;padding:9px;margin:5px 0 12px" placeholder="Reason">' +

            '<label>Notes</label>' +
            '<textarea id="pf-notes" rows="4" style="width:100%;padding:9px;margin:5px 0 12px" placeholder="Add call or follow-up notes"></textarea>' +

            '<label>Follow-up Date / Time</label>' +
            '<input id="pf-followup" type="datetime-local" style="width:100%;padding:9px;margin:5px 0 12px">' +

            '<label>Assigned staff</label>' +
            '<select id="pf-assign" style="width:100%;padding:9px;margin:5px 0 12px"><option value="">— Unassigned —</option>' +
            staffList.map(function (s) { return '<option value="' + Number(s.id) + '"' + (Number(selected.assigned_staff_id) === Number(s.id) ? ' selected' : '') + '>' + esc(staffName(s)) + '</option>'; }).join('') +
            '</select>' +

            (selected.phone ? '<label style="display:flex;gap:8px;align-items:center;margin:0 0 15px"><input type="checkbox" id="pf-send-wa"> Also send WhatsApp template for this status: <span id="pf-wa-name" style="font-weight:600"></span></label>' : '') +

            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-primary" onclick="saveAdminPaymentFollowup()">Save Follow-up</button>' +
            '<button class="btn" onclick="viewAdminPaymentHistoryById(' + Number(selected.registration_id) + ')">View History</button>' +
            '</div>' +
            '<div id="pf-message" style="margin-top:12px"></div>' +
            '</div></div>';

        var s = selected.contact_status || 'not_contacted';
        var select = document.getElementById('pf-status');
        if (select) {
            select.value = s;
            var syncWaName = function () {
                var t = defaultTemplateFor(select.value);
                var el = document.getElementById('pf-wa-name');
                if (el) el.textContent = t ? t.meta_name : '(none configured)';
            };
            select.addEventListener('change', syncWaName);
            syncWaName();
        }
        var reason = document.getElementById('pf-reason');
        var notes = document.getElementById('pf-notes');
        var follow = document.getElementById('pf-followup');
        if (reason) reason.value = selected.contact_reason || '';
        if (notes) notes.value = selected.contact_notes || '';
        if (follow && selected.next_follow_up_at) {
            follow.value = String(selected.next_follow_up_at).replace(' ', 'T').slice(0, 16);
        }
    }

    function closeAdminPaymentFollowup() {
        var modal = document.getElementById('payment-followup-modal');
        if (modal) modal.innerHTML = '';
    }

    async function saveAdminPaymentFollowup() {
        if (!selected) return;

        var msg = document.getElementById('pf-message');
        var payload = {
            actingAdminId: adminId(),
            status: document.getElementById('pf-status').value,
            contactType: 'call',
            reason: document.getElementById('pf-reason').value,
            notes: document.getElementById('pf-notes').value,
            followUpAt: document.getElementById('pf-followup').value || null
        };

        try {
            var response = await fetch('/api/admin/application-contact/' + encodeURIComponent(selected.registration_id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to save');
            var assignSel = document.getElementById('pf-assign');
            if (assignSel && String(assignSel.value || '') !== String(selected.assigned_staff_id || '')) {
                await assignAdminPaymentFollowup(rows.indexOf(selected), assignSel.value);
            }
            var waCk = document.getElementById('pf-send-wa');
            var waNote = '';
            if (waCk && waCk.checked) {
                var t = defaultTemplateFor(payload.status);
                if (t) {
                    var ok = await sendAdminPaymentFollowupWhatsAppNow(rows.indexOf(selected), t.meta_name);
                    waNote = ok ? ' WhatsApp sent (' + t.meta_name + ').' : ' WhatsApp failed — see message above.';
                } else waNote = ' No WhatsApp template configured for this status.';
            }
            if (msg) {
                msg.style.color = '#166534';
                msg.textContent = 'Follow-up saved successfully.' + waNote;
            }
            await load();
            setTimeout(closeAdminPaymentFollowup, 500);
        } catch (e) {
            if (msg) {
                msg.style.color = '#b91c1c';
                msg.textContent = e.message;
            }
        }
    }

    async function viewAdminPaymentHistory(index) {
        var r = rows[index];
        if (r) await viewAdminPaymentHistoryById(r.registration_id);
    }

    async function viewAdminPaymentHistoryById(registrationId) {
        var root = document.getElementById('payment-followup-root');
        if (!root) return;

        try {
            var response = await fetch('/api/admin/application-contact/' + encodeURIComponent(registrationId) + '/history?actingAdminId=' + encodeURIComponent(adminId()), {
                cache: 'no-store'
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load history');
            historyRows = Array.isArray(data) ? data : [];

            var html = '<div style="margin-top:18px;border:1px solid #e2e8f0;border-radius:8px;padding:15px;background:#f8fafc">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center"><strong>Contact History</strong><button class="btn" onclick="this.parentElement.parentElement.remove()">Close</button></div>';

            if (!historyRows.length) {
                html += '<p>No contact history recorded.</p>';
            } else {
                historyRows.forEach(function (h) {
                    html += '<div style="background:white;border:1px solid #e2e8f0;border-radius:7px;padding:12px;margin-top:10px">';
                    html += '<strong>' + esc(statusLabel(h.status)) + '</strong>';
                    html += '<br><small>' + esc(h.created_at || '') + ' · ' + esc([h.admin_first_name, h.admin_last_name].filter(Boolean).join(' ') || 'Admin') + '</small>';
                    if (h.reason) html += '<br><strong>Reason:</strong> ' + esc(h.reason);
                    if (h.notes) html += '<br><strong>Notes:</strong> ' + esc(h.notes);
                    if (h.follow_up_at) html += '<br><strong>Follow-up:</strong> ' + esc(h.follow_up_at);
                    html += '</div>';
                });
            }

            html += '</div>';
            root.insertAdjacentHTML('beforeend', html);
        } catch (e) {
            alert(e.message);
        }
    }

    function exportAdminPaymentFollowupCsv() {
        var header = ['Application', 'Applicant', 'Email', 'Mobile', 'Seminar', 'Amount', 'Contact Status', 'Assigned staff', 'Reason', 'Notes', 'Follow-up', 'Last Contact'];
        var lines = [header];

        rows.forEach(function (r) {
            lines.push([
                r.application_no || '',
                nameOf(r),
                r.email || '',
                r.phone || '',
                r.seminar_title || '',
                r.order_amount || r.seminar_price || '',
                r.contact_status || 'not_contacted',
                r.assigned_staff_name || '',
                r.contact_reason || '',
                r.contact_notes || '',
                r.next_follow_up_at || '',
                r.last_contact_at || ''
            ]);
        });

        var csv = lines.map(function (line) {
            return line.map(function (v) {
                return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
            }).join(',');
        }).join('\n');

        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'payment-followup-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    window.loadAdminPaymentFollowup = load;
    window.initAdminPaymentFollowupTab = load;
    window.sendAdminPaymentFollowupWhatsApp = sendAdminPaymentFollowupWhatsApp;
    window.sendAdminPaymentFollowupWhatsAppNow = sendAdminPaymentFollowupWhatsAppNow;
    window.assignAdminPaymentFollowup = assignAdminPaymentFollowup;
    window.openAdminPaymentFollowupTemplateDefaults = openTemplateDefaults;
    window.saveAdminPaymentFollowupTemplateMap = saveAdminPaymentFollowupTemplateMap;
    window.filterAdminPaymentFollowup = filterAdminPaymentFollowup;
    window.openAdminPaymentFollowup = openAdminPaymentFollowup;
    window.closeAdminPaymentFollowup = closeAdminPaymentFollowup;
    window.saveAdminPaymentFollowup = saveAdminPaymentFollowup;
    window.viewAdminPaymentHistory = viewAdminPaymentHistory;
    window.viewAdminPaymentHistoryById = viewAdminPaymentHistoryById;
    window.exportAdminPaymentFollowupCsv = exportAdminPaymentFollowupCsv;
})();

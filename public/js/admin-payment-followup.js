(function () {
    'use strict';

    var rows = [];
    var historyRows = [];
    var selected = null;

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
        h += '<th>Contact Status</th><th>Last Contact</th><th>Follow-up</th><th>Actions</th>';
        h += '</tr></thead><tbody>';

        if (!rows.length) {
            h += '<tr><td colspan="9" style="padding:20px;text-align:center">No pending payment applications found.</td></tr>';
        } else {
            rows.forEach(function (r, i) {
                h += '<tr class="payment-followup-row" data-search="' +
                    esc((r.application_no || '') + ' ' + nameOf(r) + ' ' + (r.phone || '')).toLowerCase() + '">';

                h += '<td>' + esc(r.application_no || '-') + '</td>';
                h += '<td><strong>' + esc(nameOf(r)) + '</strong><br><small>' + esc(r.email || '') + '</small></td>';
                h += '<td>' + esc(r.phone || '-') + '</td>';
                h += '<td>' + esc(r.seminar_title || '-') + '</td>';
                h += '<td>' + money(r.order_amount || r.seminar_price) + '</td>';
                h += '<td>' + esc(statusLabel(r.contact_status)) + '</td>';
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

    async function sendAdminPaymentFollowupWhatsApp(index) {
        var r = rows[index];
        if (!r || !r.registration_id) return;
        try {
            var tplResponse = await fetch('/api/admin/whatsapp/templates', { cache: 'no-store' });
            var tplData = await tplResponse.json();
            if (!tplResponse.ok) throw new Error(tplData.error || 'Unable to load WhatsApp templates');
            var templates = Array.isArray(tplData.templates) ? tplData.templates : [];
            var t = templates.find(function (x) {
                return Number(x.is_active) === 1 && String(x.category || '').toLowerCase() === 'payment_reminder';
            });
            if (!t) throw new Error('No active payment reminder WhatsApp template is configured.');
            var body = {
                kind: 'template',
                registration_id: r.registration_id,
                template_name: t.meta_name,
                template_lang: t.language,
                variable_count: Number(t.variable_count) || 0,
                variable_map: Array.isArray(t.variables) ? t.variables : [],
                message_type: 'payment_reminder'
            };
            var response = await fetch('/api/admin/whatsapp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            var data = await response.json();
            if (!response.ok) throw new Error(data.error || 'WhatsApp send failed');
            alert('WhatsApp payment reminder sent successfully.');
        } catch (e) {
            alert(e.message || 'WhatsApp send failed');
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
            '<input id="pf-followup" type="datetime-local" style="width:100%;padding:9px;margin:5px 0 15px">' +

            '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-primary" onclick="saveAdminPaymentFollowup()">Save Follow-up</button>' +
            '<button class="btn" onclick="viewAdminPaymentHistoryById(' + Number(selected.registration_id) + ')">View History</button>' +
            '</div>' +
            '<div id="pf-message" style="margin-top:12px"></div>' +
            '</div></div>';

        var s = selected.contact_status || 'not_contacted';
        var select = document.getElementById('pf-status');
        if (select) select.value = s;
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
            if (msg) {
                msg.style.color = '#166534';
                msg.textContent = 'Follow-up saved successfully.';
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
        var header = ['Application', 'Applicant', 'Email', 'Mobile', 'Seminar', 'Amount', 'Contact Status', 'Reason', 'Notes', 'Follow-up', 'Last Contact'];
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
    window.filterAdminPaymentFollowup = filterAdminPaymentFollowup;
    window.openAdminPaymentFollowup = openAdminPaymentFollowup;
    window.closeAdminPaymentFollowup = closeAdminPaymentFollowup;
    window.saveAdminPaymentFollowup = saveAdminPaymentFollowup;
    window.viewAdminPaymentHistory = viewAdminPaymentHistory;
    window.viewAdminPaymentHistoryById = viewAdminPaymentHistoryById;
    window.exportAdminPaymentFollowupCsv = exportAdminPaymentFollowupCsv;
})();

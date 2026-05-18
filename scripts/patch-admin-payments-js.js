/**
 * Admin JS: payments module, refunds, cancellation queue, user account payments.
 */
const fs = require('fs');
const path = require('path');

const adminJs = path.join(__dirname, '..', 'public', 'js', 'admin.js');
let js = fs.readFileSync(adminJs, 'utf8');

if (js.includes('loadAdminPaymentsModule')) {
    console.log('admin.js payments already patched');
    process.exit(0);
}

js = js.replace(
    "['tab-admin-payments', 'Orders & receipts'],",
    "['tab-admin-payments', 'Payments'],"
);

const paymentsBlock = `
let __adminPaymentsTab = 'orders';
let __adminEnrichedOrdersCache = [];
let __adminCancelRequestsCache = [];

function switchAdminPaymentsTab(tab) {
    __adminPaymentsTab = tab;
    document.querySelectorAll('.admin-payments-subtab').forEach((btn) => {
        const on = btn.getAttribute('data-pay-tab') === tab;
        btn.style.background = on ? '#0d9488' : '#64748b';
        btn.classList.toggle('active', on);
    });
    const ordersPanel = document.getElementById('admin-payments-panel-orders');
    const cancelPanel = document.getElementById('admin-payments-panel-cancellations');
    if (ordersPanel) ordersPanel.classList.toggle('hidden', tab !== 'orders');
    if (cancelPanel) cancelPanel.classList.toggle('hidden', tab !== 'cancellations');
    if (tab === 'orders') loadAdminEnrichedOrders();
    else loadAdminCancellationRequests();
}

function loadAdminPaymentsModule() {
    switchAdminPaymentsTab(__adminPaymentsTab || 'orders');
}

async function loadAdminEnrichedOrders() {
    const tbody = document.getElementById('admin-orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
    try {
        const res = await fetch('/api/admin/payments/enriched-orders');
        const rows = await res.json();
        __adminEnrichedOrdersCache = Array.isArray(rows) ? rows : [];
        __adminOrdersCache = __adminEnrichedOrdersCache;
        tbody.innerHTML = '';
        if (!__adminEnrichedOrdersCache.length) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No orders.</td></tr>';
            return;
        }
        __adminEnrichedOrdersCache.forEach((o) => {
            const doc = escAdmin((o.first_name || '') + ' ' + (o.last_name || '') + ' (' + (o.user_id_string || o.user_id || '') + ')');
            const refunded = Number(o.refunded_amount) || 0;
            const amt = Number(o.amount) || 0;
            const canRefund = o.status === 'success' && refunded < amt - 0.01;
            const actions = [];
            if (o.status === 'success') {
                actions.push(
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;margin-right:4px;" onclick="openAdminOrderReceipt(' +
                        o.id +
                        ')">Receipt</button>'
                );
            }
            if (canRefund) {
                actions.push(
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b45309;border:none;" onclick="adminRefundOrderPrompt(' +
                        o.id +
                        ')">Refund</button>'
                );
            }
            if (o.registration_id && o.registration_status !== 'cancelled' && o.status !== 'success') {
                actions.push(
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#7c3aed;border:none;" onclick="adminWaiveAndTicket(' +
                        o.registration_id +
                        ')">Waive &amp; ticket</button>'
                );
            }
            tbody.innerHTML +=
                '<tr><td><strong>' +
                escAdmin(o.order_id_string || o.id) +
                '</strong></td><td>' +
                doc +
                '</td><td>' +
                escAdmin(o.seminar_title || '—') +
                '</td><td>' +
                escAdmin(o.application_no || '—') +
                '</td><td>' +
                escAdmin(o.payment_gateway || '—') +
                '</td><td>₹' +
                escAdmin(amt) +
                '</td><td>₹' +
                escAdmin(refunded) +
                (o.refund_status ? ' (' + escAdmin(o.refund_status) + ')' : '') +
                '</td><td>' +
                escAdmin(o.status) +
                '</td><td>' +
                (actions.join('') || '—') +
                '</td></tr>';
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="9">Failed to load</td></tr>';
    }
}

async function adminRefundOrderPrompt(orderDbId) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const o = __adminEnrichedOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
    if (!o) return alert('Order not found. Refresh the list.');
    const maxRefundable = Math.max(0, (Number(o.amount) || 0) - (Number(o.refunded_amount) || 0));
    const hint = 'Max refundable now: ₹' + maxRefundable;
    const raw = prompt(hint + '\\n\\nEnter refund amount in ₹ (or leave blank for full remaining):', String(maxRefundable));
    if (raw === null) return;
    const amount = raw.trim() === '' ? maxRefundable : Number(raw);
    if (Number.isNaN(amount) || amount <= 0) return alert('Invalid amount.');
    if (amount > maxRefundable + 0.01) return alert('Amount exceeds remaining paid balance.');
    const reason = prompt('Reason for refund (optional):', 'Admin refund') || '';
    if (!confirm('Refund ₹' + amount + ' for order ' + (o.order_id_string || o.id) + '?')) return;
    try {
        const res = await fetch('/api/admin/payments/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: o.id, amount, reason, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Refund failed');
        alert(data.message || 'Refund initiated.');
        loadAdminEnrichedOrders();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function adminWaiveAndTicket(registrationId) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const note = prompt('Note for waiver (optional):', 'Fee waived by admin') || '';
    if (!confirm('Waive seminar fee and issue e-ticket for registration #' + registrationId + '?')) return;
    try {
        const res = await fetch('/api/admin/payments/waive-and-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId, note, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not waive');
        alert(data.message || 'Done.');
        loadAdminEnrichedOrders();
        if (__adminUserDetailCache) renderAdminUserDetailTab();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function loadAdminCancellationRequests() {
    const tbody = document.getElementById('admin-cancel-req-tbody');
    if (!tbody) return;
    const status = document.getElementById('admin-cancel-req-filter')?.value || '';
    tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
    try {
        const q = status ? '?status=' + encodeURIComponent(status) : '';
        const res = await fetch('/api/admin/cancellation-requests' + q);
        const rows = await res.json();
        __adminCancelRequestsCache = Array.isArray(rows) ? rows : [];
        tbody.innerHTML = '';
        if (!__adminCancelRequestsCache.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">No requests.</td></tr>';
            return;
        }
        __adminCancelRequestsCache.forEach((r) => {
            const doc = escAdmin((r.first_name || '') + ' ' + (r.last_name || '') + ' (' + (r.user_id_string || '') + ')');
            const when = r.requested_at ? new Date(r.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';
            const pol = '₹' + (r.refund_amount || 0) + ' (' + (r.refund_percent || 0) + '%)';
            let actions = '—';
            if (r.status === 'pending') {
                actions =
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;margin-right:4px;" onclick="adminResolveCancelRequest(' +
                    r.id +
                    ',\\'approve\\')">Approve</button>' +
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#64748b;border:none;" onclick="adminResolveCancelRequest(' +
                    r.id +
                    ',\\'reject\\')">Reject</button>';
            }
            tbody.innerHTML +=
                '<tr><td>' +
                escAdmin(when) +
                '</td><td>' +
                doc +
                '</td><td>' +
                escAdmin(r.seminar_title) +
                '</td><td>' +
                escAdmin(r.application_no) +
                '</td><td style="max-width:200px;font-size:0.85rem;">' +
                escAdmin(r.reason) +
                '</td><td>' +
                escAdmin(pol) +
                '</td><td>' +
                escAdmin(r.status) +
                '</td><td>' +
                actions +
                '</td></tr>';
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="8">Failed to load</td></tr>';
    }
}

async function adminResolveCancelRequest(requestId, action) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const row = __adminCancelRequestsCache.find((x) => Number(x.id) === Number(requestId));
    if (!row) return alert('Refresh the list.');
    const adminNotes = prompt('Admin notes (optional):', '') || '';
    let processRefund = false;
    let refundAmount = null;
    if (action === 'approve') {
        const defAmt = row.refund_amount != null ? row.refund_amount : '';
        const amtRaw = prompt(
            'Refund amount in ₹ (IST policy preview: ' + defAmt + '). Leave blank to use policy amount:',
            String(defAmt)
        );
        if (amtRaw === null) return;
        if (amtRaw.trim() !== '') {
            refundAmount = Number(amtRaw);
            if (Number.isNaN(refundAmount)) return alert('Invalid amount.');
        }
        processRefund = confirm('Process payment gateway refund when approving? (No = cancel registration only)');
        if (!confirm('Approve cancellation for ' + (row.application_no || 'application') + '?')) return;
    } else if (!confirm('Reject this cancellation request?')) {
        return;
    }
    try {
        const res = await fetch('/api/admin/cancellation-requests/' + requestId + '/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                adminNotes,
                processRefund,
                refundAmount,
                actingAdminId: adm.id
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Done.');
        loadAdminCancellationRequests();
        loadAdminEnrichedOrders();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function loadAdminUserPaymentsPanel(userId, bodyEl) {
    if (!bodyEl) return;
    try {
        const res = await fetch('/api/admin/payments/enriched-orders?userId=' + encodeURIComponent(userId));
        const rows = await res.json();
        const list = Array.isArray(rows) ? rows : [];
        let html = '<p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Payments, refunds, and e-tickets for this account.</p>';
        html += '<table class="data-table"><thead><tr><th>Order</th><th>Seminar</th><th>Gateway</th><th>Amount</th><th>Refunded</th><th>Status</th><th>E-ticket</th><th>Actions</th></tr></thead><tbody>';
        if (!list.length) {
            html += '<tr><td colspan="8">No orders</td></tr>';
        } else {
            list.forEach((o) => {
                const refunded = Number(o.refunded_amount) || 0;
                const amt = Number(o.amount) || 0;
                const canRefund = o.status === 'success' && refunded < amt - 0.01;
                let acts = '';
                if (canRefund) {
                    acts +=
                        '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b45309;border:none;" onclick="adminRefundOrderPrompt(' +
                        o.id +
                        ')">Refund</button> ';
                }
                if (o.registration_id && o.status !== 'success') {
                    acts +=
                        '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#7c3aed;border:none;" onclick="adminWaiveAndTicket(' +
                        o.registration_id +
                        ')">Waive</button>';
                }
                html +=
                    '<tr><td>' +
                    escAdmin(o.order_id_string) +
                    '</td><td>' +
                    escAdmin(o.seminar_title) +
                    '</td><td>' +
                    escAdmin(o.payment_gateway) +
                    '</td><td>₹' +
                    escAdmin(amt) +
                    '</td><td>₹' +
                    escAdmin(refunded) +
                    '</td><td>' +
                    escAdmin(o.status) +
                    '</td><td>' +
                    escAdmin(o.e_ticket_id || '—') +
                    '</td><td>' +
                    (acts || '—') +
                    '</td></tr>';
            });
        }
        html += '</tbody></table>';
        const regs = (__adminUserDetailCache && __adminUserDetailCache.registrations) || [];
        if (regs.length) {
            html += '<h4 style="margin-top:16px;">Applications without payment</h4><ul style="font-size:0.88rem;">';
            regs.forEach((r) => {
                const paid = list.some(
                    (o) => Number(o.registration_id) === Number(r.id) && o.status === 'success'
                );
                if (!paid && r.status !== 'cancelled') {
                    html +=
                        '<li>' +
                        escAdmin(r.application_no) +
                        ' — ' +
                        escAdmin(r.seminar_title) +
                        ' <button type="button" class="btn-primary" style="padding:3px 8px;font-size:0.75rem;margin-left:8px;" onclick="adminWaiveAndTicket(' +
                        r.id +
                        ')">Waive &amp; ticket</button></li>';
                }
            });
            html += '</ul>';
        }
        bodyEl.innerHTML = html;
        __adminEnrichedOrdersCache = list;
    } catch (e) {
        console.error(e);
        bodyEl.innerHTML = '<p style="color:#b91c1c;">Failed to load payments</p>';
    }
}

`;

const anchor = 'async function loadAdminOrders() {';
if (!js.includes(anchor)) {
    console.error('loadAdminOrders anchor missing');
    process.exit(1);
}
js = js.replace(anchor, paymentsBlock + anchor);

js = js.replace(
    `    if (__adminUserDetailTab === 'orders') {
        let rows = '';
        (d.orders || []).forEach((o) => {
            rows += \`<tr>
                <td>\${escAdmin(o.order_id_string)}</td>
                <td>\${escAdmin(o.seminar_title)}</td>
                <td>₹\${escAdmin(o.amount)} · \${escAdmin(o.status)}</td>
                <td>\${escAdmin(o.ticket_id_string || '—')}</td>
                <td>\${o.is_scanned ? 'Yes ' + escAdmin(o.scan_time || '') : 'No'}</td>
            </tr>\`;
        });
        body.innerHTML = \`<table class="data-table"><thead><tr><th>Order</th><th>Seminar</th><th>Payment</th><th>E-ticket</th><th>Scanned</th></tr></thead><tbody>\${rows || '<tr><td colspan="5">No orders</td></tr>'}</tbody></table>\`;
        return;
    }`,
    `    if (__adminUserDetailTab === 'orders') {
        body.innerHTML = '<p>Loading payments…</p>';
        loadAdminUserPaymentsPanel(u.id, body);
        return;
    }`
);

js = js.replace(
    'async function loadAdminOrders() {\n    const tbody = document.getElementById(\'admin-orders-tbody\');\n    if (!tbody) return;\n    tbody.innerHTML = \'<tr><td colspan="8">Loading…</td></tr>\';',
    'async function loadAdminOrders() {\n    return loadAdminEnrichedOrders();\n    const tbody = document.getElementById(\'admin-orders-tbody\');\n    if (!tbody) return;\n    tbody.innerHTML = \'<tr><td colspan="9">Loading…</td></tr>\';'
);

fs.writeFileSync(adminJs, js);
console.log('Patched admin.js payments module');

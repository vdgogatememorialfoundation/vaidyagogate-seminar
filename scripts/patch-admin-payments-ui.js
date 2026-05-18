/**
 * Expand admin Payments tab (orders, refunds, cancellation queue).
 */
const fs = require('fs');
const path = require('path');

const adminHtml = path.join(__dirname, '..', 'public', 'admin.html');
let html = fs.readFileSync(adminHtml, 'utf8');

const marker = '<motion.div id="tab-admin-payments"';
const marker2 = '<div id="tab-admin-payments"';
const start = html.indexOf(marker2);
if (start < 0) {
    console.error('payments tab not found');
    process.exit(1);
}
const end = html.indexOf('<!-- Certificate management -->', start);
if (end < 0) {
    console.error('certificate section not found');
    process.exit(1);
}

const replacement = `            <!-- Payments module -->
            <div id="tab-admin-payments" class="tab-pane hidden">
                <h2 style="margin-bottom: 16px;">Payments &amp; refunds</h2>
                <p style="color:#64748b;margin-bottom:16px;">View all payments per doctor, issue refunds (full or partial), waive fees and issue e-tickets, and approve cancellation requests with IST-based refund policy. Razorpay and Cashfree refunds are sent automatically; PayU, Easebuzz, Paytm, and PhonePe are recorded for manual completion in the gateway dashboard.</p>
                <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
                    <button type="button" class="btn-primary admin-payments-subtab active" data-pay-tab="orders" style="background:#0d9488;" onclick="switchAdminPaymentsTab('orders')">Orders</button>
                    <button type="button" class="btn-primary admin-payments-subtab" data-pay-tab="cancellations" style="background:#64748b;" onclick="switchAdminPaymentsTab('cancellations')">Cancellation requests</button>
                </div>
                <div id="admin-payments-panel-orders" class="card">
                    <button type="button" class="btn-primary" style="margin-bottom:12px;background:#64748b;" onclick="loadAdminEnrichedOrders()">Refresh orders</button>
                    <table class="data-table">
                        <thead><tr><th>Order</th><th>Doctor</th><th>Seminar</th><th>App</th><th>Gateway</th><th>Amount</th><th>Refunded</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody id="admin-orders-tbody"><tr><td colspan="9" style="text-align:center;">Open this tab or click Refresh</td></tr></tbody>
                    </table>
                </div>
                <div id="admin-payments-panel-cancellations" class="card hidden" style="margin-top:0;">
                    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
                        <label>Status <select id="admin-cancel-req-filter" onchange="loadAdminCancellationRequests()"><option value="">All</option><option value="pending" selected>Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
                        <button type="button" class="btn-primary" style="background:#64748b;" onclick="loadAdminCancellationRequests()">Refresh</button>
                    </div>
                    <table class="data-table">
                        <thead><tr><th>Requested</th><th>Doctor</th><th>Seminar</th><th>App</th><th>Reason</th><th>Policy refund</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody id="admin-cancel-req-tbody"><tr><td colspan="8" style="text-align:center;">—</td></tr></tbody>
                    </table>
                </div>
            </div>

`;

html = html.slice(0, start) + replacement + html.slice(end);
if (!html.includes('loadAdminEnrichedOrders')) {
    console.error('patch failed');
    process.exit(1);
}
fs.writeFileSync(adminHtml, html);
console.log('Patched admin.html payments tab');

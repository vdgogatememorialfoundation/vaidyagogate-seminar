/**
 * Admin Commerce desk: order flow, Tookan / Shipday / Pidge / Fleetbase booking, tracking, labels.
 */
let commerceOrders = [];
let commercePanel = 'desk';
let commerceTrackTimer = null;

function commerceNoOtp(provider) {
    return provider === 'shipday';
}

function commerceActor() {
    const u = typeof getStoredAdminUser === 'function' ? getStoredAdminUser() : {};
    return u && u.id ? u.id : '';
}

async function commerceFetch(url, opts) {
    const actor = commerceActor();
    const headers = Object.assign({ 'Content-Type': 'application/json', 'x-acting-user-id': String(actor) }, (opts && opts.headers) || {});
    const res = await fetch(url, Object.assign({}, opts || {}, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function openCommercePanel(name) {
    commercePanel = name || 'desk';
    if (typeof switchTab === 'function') switchTab('tab-commerce');
    else loadCommerceAdmin();
}

function loadCommerceAdmin() {
    const nav = document.getElementById('commerce-subnav');
    if (!nav) return;
    const tabs = [
        ['pos', 'Order & courier POS'],
        ['desk', 'Order desk'],
        ['book', 'Schedule pickup'],
        ['track', 'Shipment tracking'],
        ['returns', 'Returns & replacements'],
        ['labels', 'Shipping labels'],
        ['settings', 'Shop settings']
    ];
    nav.innerHTML = tabs
        .map(
            ([id, label]) =>
                '<button type="button" class="btn-primary" style="background:' +
                (commercePanel === id ? '#0f766e' : '#64748b') +
                ';" onclick="openCommercePanel(\'' +
                id +
                '\')">' +
                label +
                '</button>'
        )
        .join('');
    if (commercePanel === 'settings') return renderCommerceSettings();
    commerceFetch('/api/admin/commerce/orders?actingAdminId=' + encodeURIComponent(commerceActor()))
        .then((data) => {
            commerceOrders = data.orders || [];
            if (commercePanel === 'pos') renderCommercePos();
            else if (commercePanel === 'desk') renderCommerceDesk();
            else if (commercePanel === 'book') renderCommerceBook();
            else if (commercePanel === 'track') renderCommerceTrackList();
            else if (commercePanel === 'returns') renderCommerceReturns();
            else renderCommerceLabels();
        })
        .catch((e) => {
            const panel = document.getElementById('commerce-panel');
            if (panel) panel.innerHTML = '<p style="color:#b91c1c;">' + escCommerce(e.message) + '</p>';
        });
}

function escCommerce(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function commerceStageLabel(stage) {
    const map = {
        placed: 'Placed',
        accepted: 'Accepted',
        preparing: 'Preparing',
        ready: 'Ready',
        pickup_scheduled: 'Pickup requested',
        in_transit: 'In transit',
        out_for_delivery: 'Out for delivery',
        delivered: 'Delivered'
    };
    return map[stage] || stage || 'Placed';
}

let commerceDeskQuery = '';
let commerceDeskStage = '';

function commerceDeskFilter(o) {
    if (commerceDeskStage && String(o.commerceStage || 'placed') !== commerceDeskStage) return false;
    if (!commerceDeskQuery) return true;
    const hay = [o.orderCode, o.buyerName, o.buyerPhone, o.buyerEmail, o.shippingCity, o.courierTrackingNo, o.commerceAwb, o.commerceProvider].map((x) => String(x || '').toLowerCase()).join(' ');
    return hay.indexOf(commerceDeskQuery) !== -1;
}

function commerceDeskSearch(v) {
    commerceDeskQuery = String(v || '').trim().toLowerCase();
    renderCommerceDesk(true);
}

function commerceDeskSetStage(v) {
    commerceDeskStage = String(v || '');
    renderCommerceDesk(true);
}

function commerceOpenOrder(panelId, orderId) {
    commercePanel = panelId;
    window.commerceFocusOrder = orderId;
    loadCommerceAdmin();
}

function commerceCourierCell(o) {
    if (!o.commerceProvider && !o.courierProvider) return '<span style="color:#94a3b8;">Not booked</span>';
    const name = o.commerceProvider ? o.commerceProvider + (o.commerceMode ? ' · ' + o.commerceMode : '') : o.courierProvider;
    const ref = o.commerceAwb || o.courierTrackingNo || '';
    const cost = o.commerceCost != null ? '<br>Charge ₹' + escCommerce(o.commerceCost) : '';
    return escCommerce(name) + (ref ? '<br><span style="color:#64748b;font-size:0.8rem;">' + escCommerce(ref) + '</span>' : '') + commerceParcelHtml(o.parcelInfo) + cost;
}

function commerceParcelHtml(info) {
    if (!info || !info.parcelId) return '';
    const tasks = (info.tasks || []).map((t) => t.type + ' #' + t.jobId + (t.otp ? ' · OTP ' + t.otp : '') + (t.at && window.PortalDateTime && window.PortalDateTime.format ? ' · ' + window.PortalDateTime.format(t.at) : '')).join('<br>');
    return '<br><span style="font-size:0.78rem;">Tookan parcel <strong>#' + escCommerce(info.parcelId) + '</strong>' + (info.code ? ' · ' + escCommerce(info.code) : '') + '</span>' + (tasks ? '<br><span style="font-size:0.74rem;color:#64748b;">' + tasks + '</span>' : '');
}

function renderCommerceDesk(keepFilters) {
    const panel = document.getElementById('commerce-panel');
    const all = commerceOrders;
    const counts = all.reduce((m, o) => {
        const k = o.commerceStage || 'placed';
        m[k] = (m[k] || 0) + 1;
        return m;
    }, {});
    const stageOptions = ['', 'placed', 'accepted', 'preparing', 'ready', 'pickup_scheduled', 'in_transit', 'out_for_delivery', 'delivered']
        .map((st) => '<option value="' + st + '"' + (commerceDeskStage === st ? ' selected' : '') + '>' + (st ? commerceStageLabel(st) + ' (' + (counts[st] || 0) + ')' : 'All stages (' + all.length + ')') + '</option>')
        .join('');
    const rows = all
        .filter(commerceDeskFilter)
        .map((o) => {
            return (
                '<tr><td><strong>' +
                escCommerce(o.orderCode) +
                '</strong><br><span style="color:#64748b;font-size:0.8rem;">' +
                escCommerce(o.buyerName || '') +
                ' ' +
                escCommerce(o.buyerPhone || '') +
                (o.shippingCity ? ' · ' + escCommerce(o.shippingCity) : '') +
                '</span>' +
                (o.returnStatus ? '<br><span style="font-size:0.78rem;color:#b45309;">Return: ' + escCommerce(o.returnStatus) + '</span>' : '') +
                '</td><td>' +
                escCommerce(commerceStageLabel(o.commerceStage)) +
                '</td><td>' +
                commerceCourierCell(o) +
                '</td><td>' +
                (commerceNoOtp(o.commerceProvider)
                    ? '—'
                    : 'Pickup <strong>' + escCommerce(o.pickupOtp || '—') + '</strong><br>Delivery <strong>' + escCommerce(o.deliveryOtp || '—') + '</strong>') +
                '</td><td>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#0f766e;" onclick="commerceSetStage(' +
                o.id +
                ',\'accepted\')">Accept</button>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#0369a1;" onclick="commerceSetStage(' +
                o.id +
                ',\'preparing\')">Preparing</button>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#15803d;" onclick="commerceSetStage(' +
                o.id +
                ',\'ready\')">Ready</button>' +
                '<br>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#334155;" onclick="commerceOpenOrder(\'track\',' + o.id + ')">Track</button>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#334155;" onclick="commerceOpenOrder(\'book\',' + o.id + ')">Book pickup</button>' +
                '<button type="button" class="btn-primary" style="margin:2px;background:#334155;" onclick="commerceOpenOrder(\'returns\',' + o.id + ')">Return</button>' +
                '<a class="btn-primary" style="margin:2px;background:#111;display:inline-block;" href="' + commerceLabelHref(o.id) + '" target="_blank" rel="noopener">Label</a>' +
                (o.trackUrl ? '<button type="button" class="btn-primary" style="margin:2px;background:#0369a1;" onclick="navigator.clipboard.writeText(\'' + escCommerce(o.trackUrl) + '\');this.textContent=\'Copied\'">Copy tracking link</button>' : '') +
                '<button type="button" class="btn-primary" style="margin:2px;background:#b91c1c;" onclick="commerceDeleteOrder(' +
                o.id +
                ',\'' + escCommerce(o.orderCode || '') + '\')">Delete</button>' +
                '</td></tr>'
            );
        })
        .join('');
    panel.innerHTML =
        '<div class="card" style="padding:16px;margin-bottom:16px;"><h3 style="margin-top:0;">Place an order</h3>' +
        '<p style="color:#64748b;font-size:0.88rem;">This writes the order for the admin desk even if doctors cannot open book orders.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;">' +
        field('c-name', 'Recipient name') +
        field('c-phone', 'Phone') +
        field('c-address', 'Delivery address') +
        field('c-city', 'City') +
        field('c-item', 'Item', 'Book') +
        '<label>Mode<select id="c-mode"><option value="logistics">Tookan logistics</option><option value="hyperlocal">Hyperlocal pickup & delivery</option></select></label>' +
        '<label>Shipping mode<select id="c-service"><option value="standard">Standard</option><option value="express">Express</option><option value="same-day">Same day</option><option value="next-day">Next day</option><option value="surface">Surface</option><option value="air">Air</option><option value="overnight">Overnight</option><option value="economy">Economy</option><option value="scheduled">Scheduled slot</option><option value="store-pickup">Store pickup</option></select></label>' +
        '<label>Hyperlocal provider<select id="c-provider"><option value="">Auto</option><option value="shipday">Shipday</option><option value="tookan">Tookan</option><option value="pidge">Pidge</option><option value="fleetbase">Fleetbase</option></select></label>' +
        '</div><button type="button" class="btn-primary" style="margin-top:12px;" onclick="commercePlaceOrder()">Save order</button>' +
        '<p id="commerce-place-msg" style="font-weight:600;"></p></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
        '<input id="c-desk-q" placeholder="Search order, name, phone, city, AWB" value="' + escCommerce(commerceDeskQuery) + '" oninput="commerceDeskSearch(this.value)" style="min-width:260px;">' +
        '<select onchange="commerceDeskSetStage(this.value)">' + stageOptions + '</select>' +
        '<button type="button" class="btn-primary" style="background:#64748b;" onclick="loadCommerceAdmin()">Refresh</button>' +
        '<span style="flex:1;"></span>' +
        '<button type="button" class="btn-primary" style="background:#b91c1c;" onclick="commerceDeleteAllOrders()">Delete all orders</button></div>' +
        '<table class="data-table" style="width:100%;"><thead><tr><th>Order</th><th>Stage</th><th>Courier</th><th>OTP</th><th>Actions</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">No orders match.</td></tr>') +
        '</tbody></table>';
    if (keepFilters) {
        const q = document.getElementById('c-desk-q');
        if (q) {
            q.focus();
            q.setSelectionRange(q.value.length, q.value.length);
        }
    }
}

function field(id, label, value) {
    return (
        '<label style="font-size:0.82rem;color:#334155;">' +
        escCommerce(label) +
        '<input id="' +
        id +
        '" style="width:100%;margin-top:4px;" value="' +
        escCommerce(value || '') +
        '"></label>'
    );
}

function commercePosSummary(o) {
    if (!o) return '<p style="color:#64748b;">Select an order.</p>';
    const items = (o.items || []).map((it) => escCommerce(it.name || it.title || '') + (it.variant ? ' · ' + escCommerce(it.variant) : '') + ' × ' + (it.qty || it.quantity || 1)).join('<br>');
    const addr = [o.shippingName || o.customerName, o.shippingAddress || o.address, o.shippingCity || o.city, o.shippingPincode || o.pincode].filter(Boolean).map(escCommerce).join(', ');
    const aid = encodeURIComponent(commerceActor());
    return (
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:0.86rem;">' +
        '<div><b>' + escCommerce(o.orderCode) + '</b><br><span style="color:#64748b;">' + escCommerce(commerceStageLabel(o.commerceStage)) + '</span></div>' +
        '<div><b>Customer</b><br>' + escCommerce(o.customerName || o.shippingName || '') + '<br>' + escCommerce(o.customerPhone || o.phone || '') + '</div>' +
        '<div><b>Ship to</b><br>' + addr + '</div>' +
        '<div><b>Items</b><br>' + (items || '—') + '</div>' +
        '<div><b>Courier</b><br>' + commerceCourierCell(o) + (o.service ? '<br><span style="color:#1d4ed8;font-weight:700;text-transform:capitalize;">' + escCommerce(String(o.service).replace(/[_-]/g, ' ')) + '</span>' : '') + '</div>' +
        '<div><b>Amount</b><br>₹' + escCommerce(o.total || o.amount || 0) + (o.cod ? ' · COD' : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">' +
        '<button type="button" class="btn-primary" style="background:#0f766e;" onclick="commerceOpenOrder(\'track\',' + o.id + ')">Track</button>' +
        '<a class="btn-primary" style="background:#334155;" target="_blank" href="/api/admin/commerce/orders/' + o.id + '/label?actingAdminId=' + aid + '">Label</a>' +
        '<a class="btn-primary" style="background:#334155;" target="_blank" href="/api/admin/commerce/orders/' + o.id + '/label?style=roll&actingAdminId=' + aid + '">58mm roll</a>' +
        '<a class="btn-primary" style="background:#334155;" target="_blank" href="/api/admin/commerce/orders/' + o.id + '/label?style=tag&actingAdminId=' + aid + '">Tag</a>' +
        '<a class="btn-primary" style="background:#067d62;" href="/api/admin/commerce/orders/' + o.id + '/label?format=pdf&actingAdminId=' + aid + '">PDF</a>' +
        '<button type="button" class="btn-primary" style="background:#b45309;" onclick="commerceOpenOrder(\'returns\',' + o.id + ')">Return / replace</button>' +
        (o.publicTrackingUrl ? '<button type="button" class="btn-primary" style="background:#64748b;" onclick="navigator.clipboard.writeText(\'' + escCommerce(o.publicTrackingUrl) + '\')">Copy tracking link</button>' : '') +
        '</div>' +
        commerceAppointmentsHtml(o) +
        commerceOpsHtml(o)
    );
}

const COMMERCE_OPS_GROUPS = [
    ['Preparation', '#0f766e', [['received', 'Received'], ['inventory_ok', 'Stock OK'], ['picking', 'Picking'], ['picked', 'Picked & checked'], ['substitution', 'Substitution'], ['packing', 'Packing'], ['qc_done', 'QC done'], ['ready_for_rider', 'Ready for rider'], ['store_delay', 'Store delay']]],
    ['Delivery partner', '#1d4ed8', [['rider_arrived', 'Arrived at store'], ['pickup_verified', 'Pickup verified'], ['rider_departed', 'Left store'], ['reassign', 'Reassign']]],
    ['Last mile', '#b45309', [['waiting_customer', 'Waiting at customer'], ['customer_unreachable', 'Not reachable'], ['wrong_location', 'Wrong location'], ['safe_drop', 'Safe drop'], ['failed_delivery', 'Failed delivery']]]
];

function commerceAppointmentsHtml(o) {
    const list = (o.appointments || []).slice().reverse();
    if (!list.length) return '';
    return '<div style="margin-top:12px;border-top:1px dashed #cbd5e1;padding-top:10px;"><b>Delivery appointments</b>' +
        list.map((a) => '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:.82rem;"><b>' + a.date + ' ' + a.start + '–' + a.end + '</b>' +
            (a.recipient ? '<span>Recipient: ' + a.recipient + '</span>' : '') + (a.instructions ? '<span style="color:#475569;">' + a.instructions + '</span>' : '') +
            '<span style="padding:2px 8px;border-radius:999px;background:' + (a.status === 'pending' ? '#fef3c7' : a.status === 'rejected' ? '#fee2e2' : '#dcfce7') + ';">' + a.status.replace('_', ' ') + '</span>' +
            (a.status === 'pending' ? '<button type="button" class="btn-primary" style="padding:3px 9px;font-size:.76rem;" onclick="commerceAppointment(' + o.id + ',\'' + a.id + '\',\'accepted\')">Accept</button><button type="button" class="btn-primary" style="padding:3px 9px;font-size:.76rem;background:#0369a1;" onclick="commerceAppointment(' + o.id + ',\'' + a.id + '\',\'carrier_confirmed\')">Courier confirmed</button><button type="button" class="btn-primary" style="padding:3px 9px;font-size:.76rem;background:#b91c1c;" onclick="commerceAppointment(' + o.id + ',\'' + a.id + '\',\'rejected\')">Reject</button>' : '') +
            '</div>').join('') + '</div>';
}

async function commerceAppointment(id, appointmentId, decision) {
    const note = decision === 'rejected' ? prompt('Reason shown to the customer') : '';
    if (note === null) return;
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/appointment', { method: 'POST', body: JSON.stringify({ actingAdminId: commerceActor(), appointmentId, decision, note: note || '' }) });
        loadCommerceAdmin();
    } catch (e) { alert(e.message); }
}

function commerceOpsHtml(o) {
    return '<div style="margin-top:12px;border-top:1px dashed #cbd5e1;padding-top:10px;"><b>Hyperlocal operations</b> <span style="color:#64748b;font-size:.8rem;">— each click is logged on the customer\'s live tracking</span>' +
        COMMERCE_OPS_GROUPS.map((g) => '<div style="margin-top:6px;"><span style="font-size:.78rem;color:#475569;font-weight:700;">' + g[0] + '</span><br>' +
            g[2].map((a) => '<button type="button" class="btn-primary" style="margin:2px;padding:4px 9px;font-size:.78rem;background:' + g[1] + ';" onclick="commerceOps(' + o.id + ',\'' + a[0] + '\')">' + a[1] + '</button>').join('') + '</div>').join('') +
        '</div>';
}

async function commerceOps(id, action) {
    const needsNote = ['substitution', 'store_delay', 'reassign', 'customer_unreachable', 'wrong_location', 'safe_drop', 'failed_delivery'].includes(action);
    const note = needsNote ? prompt('Note for this update (shown to the customer)') : '';
    if (needsNote && note === null) return;
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/ops', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), action, note: note || '' })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function renderCommercePos() {
    const panel = document.getElementById('commerce-panel');
    const stages = commerceOrders.reduce((m, o) => { const k = o.commerceStage || 'placed'; m[k] = (m[k] || 0) + 1; return m; }, {});
    panel.innerHTML =
        '<div class="card" style="padding:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
        '<h3 style="margin:0;">Order &amp; courier POS</h3>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:0.78rem;">' + Object.keys(stages).map((k) => '<span style="background:#f1f5f9;padding:3px 8px;border-radius:999px;">' + escCommerce(commerceStageLabel(k)) + ' <b>' + stages[k] + '</b></span>').join('') + '</div></div>' +
        '<div style="display:grid;grid-template-columns:minmax(260px,320px) 1fr;gap:14px;margin-top:12px;" class="commerce-pos-grid">' +
        '<div><input id="c-pos-q" placeholder="Search order / name / phone / AWB" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;">' +
        '<select id="c-pos-stage" style="width:100%;margin-top:6px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;"><option value="">All stages</option>' + Object.keys(stages).map((k) => '<option value="' + k + '">' + escCommerce(commerceStageLabel(k)) + '</option>').join('') + '</select>' +
        '<div id="c-pos-list" style="max-height:60vh;overflow:auto;margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;"></div></div>' +
        '<div><div id="c-pos-summary" style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#f8fafc;"></div>' +
        '<div id="c-pos-book" style="margin-top:12px;"></div></div></div></div>' +
        '<style>@media(max-width:860px){.commerce-pos-grid{grid-template-columns:1fr!important}}</style>';
    const list = document.getElementById('c-pos-list');
    const q = document.getElementById('c-pos-q');
    const st = document.getElementById('c-pos-stage');
    let selectedId = commerceOrders.length ? commerceOrders[0].id : null;
    function pick(id) {
        selectedId = id;
        const o = commerceOrders.find((x) => x.id === id) || null;
        document.getElementById('c-pos-summary').innerHTML = commercePosSummary(o);
        renderCommerceBook(document.getElementById('c-pos-book'));
        const sel = document.getElementById('c-book-order');
        if (sel && o) sel.value = String(o.id);
        list.querySelectorAll('[data-pos-id]').forEach((el) => (el.style.background = Number(el.getAttribute('data-pos-id')) === id ? '#ecfdf5' : ''));
    }
    function draw() {
        const term = (q.value || '').toLowerCase().trim();
        const rows = commerceOrders.filter((o) => (!st.value || (o.commerceStage || 'placed') === st.value) && (!term || [o.orderCode, o.customerName, o.customerPhone, o.phone, o.courierTrackingNo, o.commerceAwb].filter(Boolean).join(' ').toLowerCase().includes(term)));
        list.innerHTML = rows.length
            ? rows.map((o) => '<div data-pos-id="' + o.id + '" style="padding:8px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:0.84rem;' + (o.id === selectedId ? 'background:#ecfdf5;' : '') + '"><b>' + escCommerce(o.orderCode) + '</b> <span style="color:#64748b;">' + escCommerce(commerceStageLabel(o.commerceStage)) + '</span><br><span style="color:#475569;">' + escCommerce(o.customerName || o.shippingName || '') + ' · ' + escCommerce(o.shippingCity || o.city || '') + '</span></div>').join('')
            : '<p style="padding:10px;color:#64748b;">No orders match.</p>';
        list.querySelectorAll('[data-pos-id]').forEach((el) => el.addEventListener('click', () => pick(Number(el.getAttribute('data-pos-id')))));
    }
    q.addEventListener('input', draw);
    st.addEventListener('change', draw);
    draw();
    if (selectedId != null) pick(selectedId);
}

function renderCommerceBook(target) {
    const panel = target || document.getElementById('commerce-panel');
    const opts = commerceOrders
        .map((o) => '<option value="' + o.id + '">' + escCommerce(o.orderCode) + ' · ' + escCommerce(commerceStageLabel(o.commerceStage)) + '</option>')
        .join('');
    panel.innerHTML =
        '<div class="card" style="padding:16px;"><h3 style="margin-top:0;">Book a shipment</h3>' +
        '<p style="color:#64748b;font-size:0.88rem;">Logistics uses Tookan, Pidge, or Fleetbase. Hyperlocal can use Shipday, Tookan, Pidge, or Fleetbase. A Tookan parcel needs pickup and delivery coordinates. Fleetbase prints a 12-digit AWB when the shipment is ready, and hub staff track it from the hub portal.</p>' +
        '<label>Order<select id="c-book-order">' +
        opts +
        '</select></label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
        '<label>Provider<select id="c-book-provider"><option value="tookan">Tookan</option><option value="shipday">Shipday</option><option value="pidge">Pidge</option><option value="fleetbase">Fleetbase</option></select></label>' +
        '<label>Mode<select id="c-book-mode"><option value="logistics">Logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
        '<label>Shipping mode<select id="c-book-service"><option value="standard">Standard</option><option value="express">Express</option><option value="same-day">Same day</option><option value="next-day">Next day</option><option value="surface">Surface</option><option value="air">Air</option><option value="overnight">Overnight</option><option value="economy">Economy</option><option value="scheduled">Scheduled slot</option><option value="store-pickup">Store pickup</option></select></label>' +
        '<label>Pickup time (IST)<input id="c-book-when" type="datetime-local"></label>' +
        '<label style="align-self:end;"><input id="c-book-openbox" type="checkbox"> Open box delivery</label>' +
        '<label style="align-self:end;"><input id="c-book-fragile" type="checkbox"> Fragile</label>' +
        '<label style="align-self:end;"><input id="c-book-heavy" type="checkbox"> Heavy</label>' +
        '</div>' +
        '<h4 style="margin:14px 0 6px;">Package</h4>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<label>Shipment type<select id="c-pk-type"><option value="box">Box</option><option value="envelope">Envelope / document</option><option value="poly_bag">Poly bag</option><option value="tube">Tube / roll</option><option value="pallet">Pallet</option><option value="other">Other</option></select></label>' +
        '<label>Box size<select id="c-pk-size"><option value="">Custom</option><option value="S 20x15x10">S · 20×15×10 cm</option><option value="M 30x25x15">M · 30×25×15 cm</option><option value="L 40x30x25">L · 40×30×25 cm</option><option value="XL 50x40x30">XL · 50×40×30 cm</option></select></label>' +
        '<label>L (cm)<input id="c-pk-l" type="number" min="0" step="0.1" style="width:80px;"></label>' +
        '<label>W (cm)<input id="c-pk-w" type="number" min="0" step="0.1" style="width:80px;"></label>' +
        '<label>H (cm)<input id="c-pk-h" type="number" min="0" step="0.1" style="width:80px;"></label>' +
        '<label>Weight (kg)<input id="c-pk-kg" type="number" min="0" step="0.01" style="width:90px;"></label>' +
        '<label>Pieces<input id="c-pk-n" type="number" min="1" value="1" style="width:70px;"></label>' +
        '<label style="flex:1;min-width:200px;">Contents<input id="c-pk-contents" placeholder="e.g. 2 books"></label>' +
        '</div>' +
        '<div id="c-book-quote" style="font-size:0.85rem;margin-top:8px;"></div>' +
        '<button type="button" class="btn-primary" style="margin-top:12px;" onclick="commerceBookShipment()">Book pickup</button>' +
        '<button type="button" class="btn-primary" style="margin:12px 0 0 8px;background:#111;" onclick="commercePrintSelectedLabel()">Print label (regular)</button>' +
        '<button type="button" class="btn-primary" style="margin:12px 0 0 8px;background:#334155;" onclick="commercePrintSelectedLabel(58)">Print label (58mm)</button>' +
        '<p id="commerce-book-msg" style="font-weight:600;"></p></div>';
    const sizeSel = document.getElementById('c-pk-size');
    if (sizeSel) {
        sizeSel.addEventListener('change', () => {
            const m = String(sizeSel.value || '').match(/(\d+)x(\d+)x(\d+)/);
            if (!m) return;
            document.getElementById('c-pk-l').value = m[1];
            document.getElementById('c-pk-w').value = m[2];
            document.getElementById('c-pk-h').value = m[3];
        });
    }
    const bookQuote = () => commerceQuoteLine(val('c-book-order'), val('c-book-provider'), val('c-book-mode'), false, 'c-book-quote');
    ['c-book-order', 'c-book-provider', 'c-book-mode'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', bookQuote);
    });
    if (window.commerceFocusOrder) {
        const sel = document.getElementById('c-book-order');
        if (sel) sel.value = String(window.commerceFocusOrder);
        window.commerceFocusOrder = null;
    }
    if (val('c-book-order')) bookQuote();
}

function renderCommerceTrackList() {
    const panel = document.getElementById('commerce-panel');
    panel.innerHTML =
        '<div class="card" style="padding:16px;"><h3 style="margin-top:0;">Shipment tracking</h3>' +
        '<label>Order<select id="c-track-order" onchange="commerceLoadTrack()">' +
        commerceOrders
            .map((o) => '<option value="' + o.id + '">' + escCommerce(o.orderCode) + '</option>')
            .join('') +
        '</select></label><div id="commerce-track-body" style="margin-top:12px;"></div></div>';
    if (commerceOrders.length) commerceLoadTrack();
}

function renderCommerceReturns() {
    const panel = document.getElementById('commerce-panel');
    const rows = commerceOrders
        .filter((o) => o.returnStatus)
        .map((o) => {
            return (
                '<tr><td><strong>' +
                escCommerce(o.orderCode) +
                '</strong><br>' +
                escCommerce(o.returnKind || '') +
                ' · ' +
                escCommerce(o.returnReason || '') +
                '</td><td>' +
                escCommerce(o.returnStatus) +
                (o.returnAgentPhone ? '<br>Agent ' + escCommerce(o.returnAgentPhone) : '') +
                '<br>Pickup OTP ' +
                escCommerce(o.returnPickupOtp || '—') +
                (o.returnAwb ? '<br>Courier code ' + escCommerce(o.returnAwb) : '') +
                commerceParcelHtml(o.returnParcelInfo) +
                '</td><td>' +
                '<select id="ret-status-' +
                o.id +
                '">' +
                ['requested', 'approved', 'rejected', 'pickup_scheduled', 'in_transit', 'received', 'refunded', 'replacement_preparing', 'replacement_sent', 'replacement_delivered']
                    .map((s) => '<option value="' + s + '"' + (o.returnStatus === s ? ' selected' : '') + '>' + s + '</option>')
                    .join('') +
                '</select><br>' +
                '<button type="button" class="btn-primary" style="margin-top:6px;" onclick="commerceSaveReturn(' +
                o.id +
                ')">Update status</button>' +
                '<div style="margin-top:8px;"><select id="ret-provider-' +
                o.id +
                '"><option value="tookan">Tookan</option><option value="shipday">Shipday</option><option value="pidge">Pidge</option><option value="fleetbase">Fleetbase</option></select> ' +
                '<select id="ret-mode-' +
                o.id +
                '"><option value="hyperlocal">Hyperlocal</option><option value="logistics">Logistics</option></select><br>' +
                '<input id="ret-when-' +
                o.id +
                '" type="datetime-local" style="margin-top:6px;">' +
                '<button type="button" class="btn-primary" style="margin-top:6px;background:#0f766e;" onclick="commerceScheduleReturn(' +
                o.id +
                ')">Schedule return pickup</button></div>' +
                '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #e2e8f0;"><div style="font-size:0.8rem;color:#64748b;">Return shipment by courier (manual AWB)</div>' +
                '<select id="ret-cp-' + o.id + '">' + courierProviderOptions(o.courierProvider) + '</select> ' +
                '<input id="ret-awb-' + o.id + '" placeholder="Return AWB / tracking no" style="width:170px;">' +
                '<button type="button" class="btn-primary" style="margin-left:6px;background:#b45309;" onclick="commerceCreateReturnShipment(' + o.id + ')">Create return shipment</button>' +
                '<div style="margin-top:8px;"><button type="button" class="btn-primary" style="background:#1d4ed8;" onclick="commerceOpenReturnLabel(' + o.id + ')">Print return label</button> ' +
                '<button type="button" class="btn-primary" style="background:#334155;" onclick="commerceOpenReturnLabel(' + o.id + ',58)">Return label (58mm)</button> ' +
                '<button type="button" class="btn-primary" style="background:#b91c1c;" onclick="commerceDeleteReturn(' + o.id + ',\'' + escCommerce(o.orderCode || '') + '\')">Delete return / replacement</button></div>' +
                commerceReturnReceiveHtml(o) +
                (o.returnTrackingLink ? '<div style="margin-top:4px;"><a href="' + escCommerce(o.returnTrackingLink) + '" target="_blank" rel="noopener">Courier return tracking</a></div>' : '') +
                (o.returnTrackUrl ? '<div style="margin-top:4px;"><a href="' + escCommerce(o.returnTrackUrl) + '" target="_blank" rel="noopener">Customer return tracking page (shareable)</a> <button type="button" class="btn-primary" style="padding:2px 8px;font-size:0.76rem;" onclick="navigator.clipboard&&navigator.clipboard.writeText(location.origin+\'' + escCommerce(o.returnTrackUrl) + '\')">Copy link</button></div>' : '') +
                '</div></td></tr>'
            );
        })
        .join('');
    const undelivered = commerceOrders.filter((o) => !o.returnStatus && o.courierTrackFlags && (o.courierTrackFlags.rto || o.courierTrackFlags.attemptFailed));
    const raise =
        '<div class="card" style="padding:14px;margin-bottom:14px;"><h4 style="margin:0 0 8px;">Raise a return / replacement for an order</h4>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<select id="ret-new-order">' + commerceOrders.filter((o) => !o.returnStatus).map((o) => '<option value="' + o.id + '">' + escCommerce(o.orderCode) + ' · ' + escCommerce(o.buyerName || '') + '</option>').join('') + '</select>' +
        '<select id="ret-new-kind"><option value="return">Return (refund)</option><option value="replacement">Replacement</option></select>' +
        '<input id="ret-new-reason" placeholder="Reason" style="min-width:220px;">' +
        '<button type="button" class="btn-primary" onclick="commerceRaiseReturn()">Open request</button></div>' +
        (undelivered.length
            ? '<div style="margin-top:10px;color:#b45309;font-size:0.86rem;"><strong>Undelivered / RTO by courier:</strong> ' +
              undelivered.map((o) => escCommerce(o.orderCode) + ' <button type="button" class="btn-primary" style="padding:2px 8px;font-size:0.78rem;background:#b45309;" onclick="commerceCreateReturnShipment(' + o.id + ', true)">Create return shipment</button>').join(' · ') +
              '</div>'
            : '') +
        '</div>';
    panel.innerHTML =
        raise +
        '<p style="color:#64748b;">Customer return and replacement requests appear here. Update the status, then schedule a Tookan, Shipday, Pidge, or Fleetbase pickup for the return shipment. The customer sees the same updates on the order tracking screen.</p>' +
        '<table class="data-table" style="width:100%;"><thead><tr><th>Order</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="3">No return requests yet.</td></tr>') +
        '</tbody></table>';
}

function commerceReturnReceiveHtml(o) {
    const c = (o.returnCheck && o.returnCheck.checks) || null;
    const done = !!o.returnReceivedAt;
    const box = (key, label) => '<label style="display:block;font-size:0.82rem;"><input type="checkbox" id="ret-chk-' + key + '-' + o.id + '"' + (c && c[key] ? ' checked' : '') + (done ? ' disabled' : '') + '> ' + label + '</label>';
    let html = '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #e2e8f0;"><div style="font-size:0.8rem;color:#64748b;">Receive returned item · verification checks</div>' +
        box('itemsMatch', 'Items match the order') + box('qtyMatch', 'Quantity correct') + box('condition', 'Condition acceptable') + box('complete', 'Packaging / accessories complete') +
        (done
            ? '<div style="font-size:0.8rem;color:' + (o.returnCheck && o.returnCheck.passed ? '#047857' : '#b91c1c') + ';">' + (o.returnCheck && o.returnCheck.passed ? 'Checks passed' : 'Check failed — request declined') + ' · received ' + escCommerce(commerceWhen(o.returnReceivedAt)) + (o.returnCheck && o.returnCheck.notes ? ' · ' + escCommerce(o.returnCheck.notes) : '') + '</div>'
            : '<input id="ret-notes-' + o.id + '" placeholder="Notes (optional)" style="width:220px;margin-top:4px;"> <button type="button" class="btn-primary" style="margin-top:4px;background:#047857;" onclick="commerceReceiveReturn(' + o.id + ')">Mark received &amp; verify</button>');
    if (o.replacementOrderId) {
        const rep = commerceOrders.find((x) => x.id === o.replacementOrderId);
        html += '<div style="margin-top:6px;font-size:0.82rem;">Replacement order: <strong>' + escCommerce(rep ? rep.orderCode : '#' + o.replacementOrderId) + '</strong>' + (rep ? ' · ' + escCommerce(rep.commerceStage || rep.status || '') : '') + '</div>';
    } else if (o.returnKind === 'replacement' && (o.returnStatus === 'received' || o.returnStatus === 'replacement_preparing')) {
        html += '<div style="margin-top:6px;"><button type="button" class="btn-primary" style="background:#7c3aed;" onclick="commerceCreateReplacementOrder(' + o.id + ')">Create replacement order</button></div>';
    }
    return html + '</div>';
}

function commerceWhen(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function commerceOpenReturnLabel(id, size) {
    window.open('/api/admin/commerce/orders/' + id + '/return-label?actingAdminId=' + encodeURIComponent(commerceActor()) + (size ? '&size=' + encodeURIComponent(size) : ''), '_blank');
}

async function commerceReceiveReturn(id) {
    const checks = {};
    ['itemsMatch', 'qtyMatch', 'condition', 'complete'].forEach((k) => {
        const el = document.getElementById('ret-chk-' + k + '-' + id);
        checks[k] = !!(el && el.checked);
    });
    const allOk = Object.keys(checks).every((k) => checks[k]);
    if (!allOk && !confirm('Not all checks are ticked. Mark the return as received but DECLINE the request?')) return;
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return-receive', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), checks, notes: val('ret-notes-' + id) })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

async function commerceCreateReplacementOrder(id) {
    if (!confirm('Create a new ₹0 replacement order with the same items and address?')) return;
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/' + id + '/replacement-order', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor() })
        });
        alert('Replacement order ' + (data.replacement ? data.replacement.orderCode : '') + ' created. Pack and ship it from Orders.');
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function courierProviderOptions(selected) {
    const list = [['delhivery', 'Delhivery'], ['ekart', 'Ekart'], ['dtdc', 'DTDC'], ['bluedart', 'Blue Dart'], ['indian_post', 'India Post'], ['xpressbees', 'Xpressbees'], ['ecom_express', 'Ecom Express'], ['other', 'Other']];
    return list.map((x) => '<option value="' + x[0] + '"' + (selected === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
}

async function commerceRaiseReturn() {
    const id = val('ret-new-order');
    if (!id) return alert('Choose an order.');
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), status: 'requested', kind: val('ret-new-kind'), reason: val('ret-new-reason') || 'Raised by admin' })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

async function commerceCreateReturnShipment(id, fromUndelivered) {
    const provider = fromUndelivered ? '' : val('ret-cp-' + id);
    const trackingNo = fromUndelivered ? (prompt('Return AWB / tracking number (leave blank to reuse the forward AWB):') || '') : val('ret-awb-' + id);
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return-shipment', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), provider: provider || undefined, trackingNo, reason: fromUndelivered ? 'Undelivered — return to seller' : undefined })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

async function commerceSaveReturn(id) {
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), status: val('ret-status-' + id) })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function commerceReturnQuote(id) {
    commerceQuoteLine(id, val('ret-provider-' + id), val('ret-mode-' + id), true, 'ret-quote-' + id);
}

async function commerceScheduleReturn(id) {
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return-pickup', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                provider: val('ret-provider-' + id),
                mode: val('ret-mode-' + id),
                pickupAt: val('ret-when-' + id)
            })
        });
        alert('Return pickup scheduled.');
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function renderCommerceLabels() {
    const panel = document.getElementById('commerce-panel');
    const rows = commerceOrders
        .map(
            (o) =>
                '<tr><td>' +
                escCommerce(o.orderCode) +
                '</td><td>' +
                escCommerce(o.pickupOtp || '—') +
                '</td><td>' +
                escCommerce(o.deliveryOtp || '—') +
                '</td><td><a class="btn-primary" style="text-decoration:none;" target="_blank" href="/api/admin/commerce/orders/' +
                o.id +
                '/label?actingAdminId=' +
                encodeURIComponent(commerceActor()) +
                '">Print shipping label</a></td></tr>'
        )
        .join('');
    panel.innerHTML =
        '<table class="data-table" style="width:100%;"><thead><tr><th>Order</th><th>Pickup OTP</th><th>Delivery OTP</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4">No orders yet.</td></tr>') +
        '</tbody></table>';
}

async function renderCommerceSettings() {
    const panel = document.getElementById('commerce-panel');
    panel.innerHTML = '<p>Loading settings…</p>';
    try {
        const data = await commerceFetch('/api/admin/commerce/config?actingAdminId=' + encodeURIComponent(commerceActor()));
        const c = data.config || {};
        const t = c.tookan || {};
        const s = c.shipday || {};
        const p = c.pidge || {};
        panel.innerHTML =
            '<div class="card" style="padding:16px;"><h3 style="margin-top:0;">Store & keys</h3>' +
            '<p style="color:#64748b;font-size:0.86rem;">Leave a key blank to keep the saved value. Tookan key hint ' +
            escCommerce(t.apiKeyHint || 'not set') +
            '. Shipday key hint ' +
            escCommerce(s.apiKeyHint || 'not set') +
            '. Pidge username hint ' +
            escCommerce(p.usernameHint || 'not set') +
            '. Fleetbase key hint ' +
            escCommerce((c.fleetbase && c.fleetbase.secretHint) || 'not set') +
            '.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">' +
            field('cs-store', 'Store name', c.storeName) +
            field('cs-phone', 'Store phone', c.storePhone) +
            field('cs-email', 'Store email for pickup codes', c.storeEmail) +
            field('cs-addr', 'Store address', c.storeAddress) +
            field('cs-city', 'Store city', c.storeCity) +
            field('cs-state', 'Store state', c.storeState) +
            field('cs-pin', 'Store PIN', c.storePincode) +
            field('cs-lat', 'Store latitude', c.storeLat) +
            field('cs-lng', 'Store longitude', c.storeLng) +
            field('cs-maps', 'Google Maps API key', '') +
            field('cs-tookan', 'Tookan API key', '') +
            field('cs-secret', 'Tookan webhook secret', '') +
            field('cs-ship', 'Shipday API key', '') +
            field('cs-pidge-user', 'Pidge username', '') +
            field('cs-pidge-pass', 'Pidge password', '') +
            field('cs-pidge-hook', 'Pidge webhook token', '') +
            field('cs-pidge-channel', 'Pidge channel', p.channel || '') +
            field('cs-fleet-host', 'Fleetbase API host', (c.fleetbase && c.fleetbase.apiHost) || '') +
            field('cs-fleet-key', 'Fleetbase secret key', '') +
            field('cs-fleet-hook', 'Fleetbase webhook token', '') +
            field('cs-fleet-type', 'Fleetbase order type', (c.fleetbase && c.fleetbase.orderType) || '') +
            '</div>' +
            '<p style="font-size:0.84rem;margin:8px 0;">Hubs are sorting locations, not the store. Create them in the <a href="/fleetbase/hub/">Fleetbase hub</a>. Agents use <a href="/fleetbase/fleet-ops/settings/navigator-app">Fleetbase Navigator</a>. Fleetbase tracking uses <code>/fleetbase/track/</code>.</p>' +
            '<label style="display:block;margin-top:8px;"><input type="checkbox" id="cs-tookan-on" ' +
            (t.enabled ? 'checked' : '') +
            '> Tookan enabled</label>' +
            '<label style="display:block;"><input type="checkbox" id="cs-ship-on" ' +
            (s.enabled ? 'checked' : '') +
            '> Shipday enabled</label>' +
            '<label style="display:block;"><input type="checkbox" id="cs-pidge-on" ' +
            (p.enabled ? 'checked' : '') +
            '> Pidge enabled</label>' +
            '<label style="display:block;"><input type="checkbox" id="cs-fleet-on" ' +
            (c.fleetbase && c.fleetbase.enabled ? 'checked' : '') +
            '> Fleetbase enabled</label>' +
            '<label style="display:block;"><input type="checkbox" id="cs-fleet-open" ' +
            (c.fleetbase && c.fleetbase.openBoxDelivery ? 'checked' : '') +
            '> Fleetbase open box delivery</label>' +
            '<p style="color:#64748b;font-size:0.82rem;margin:8px 0;">Fleetbase accepts scan, signature, or photo as the order proof. An open-box order uses a photo. Other orders use a barcode scan. A hub line is included only when it has a name and an address. Tracking says Arrived at that hub name when Fleetbase reports the arrival. An OTP is shown only when Fleetbase sends a code. Webhook: <code>/api/public/fleetbase/webhook</code>.</p>' +
            '<label>Default mode<select id="cs-mode"><option value="logistics">Logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
            '<label style="margin-left:8px;">Hyperlocal provider<select id="cs-hyper"><option value="shipday">Shipday</option><option value="tookan">Tookan</option><option value="pidge">Pidge</option><option value="fleetbase">Fleetbase</option></select></label>' +
            '<h3 style="margin-top:18px;">Shop timings and checkout</h3>' +
            '<p style="color:#64748b;font-size:0.86rem;">The shop is only at <strong>/shop</strong>. It is not shown on the website or the doctor portal. Customers sign in with the same portal account.</p>' +
            '<label><input type="checkbox" id="cs-shop-on"> Shop link accepts orders</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-rz"> Razorpay</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-cod"> Cash on delivery</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-pickup"> Store pickup</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-delivery"> Home delivery</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-returns"> Returns</label>' +
            '<label style="margin-left:10px;"><input type="checkbox" id="cs-replace"> Replacements</label>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:8px;">' +
            field('cs-order-open', 'Order open IST', c.shop && c.shop.orderOpen) +
            field('cs-order-close', 'Order close IST', c.shop && c.shop.orderClose) +
            field('cs-pick-open', 'Pickup open', c.shop && c.shop.pickupOpen) +
            field('cs-pick-close', 'Pickup close', c.shop && c.shop.pickupClose) +
            field('cs-del-open', 'Delivery open', c.shop && c.shop.deliveryOpen) +
            field('cs-del-close', 'Delivery close', c.shop && c.shop.deliveryClose) +
            field('cs-lead', 'Pickup lead minutes', c.shop && c.shop.pickupLeadMinutes) +
            field('cs-dlead', 'Delivery lead minutes', c.shop && c.shop.deliveryLeadMinutes) +
            field('cs-window', 'Return window days', c.shop && c.shop.returnWindowDays) +
            field('cs-cod-fee', 'COD extra charge', c.shop && c.shop.codExtraCharge) +
            '</div>' +
            '<h4 style="margin:16px 0 6px;">Expected dates & delivery slots</h4>' +
            '<p style="color:#64748b;font-size:0.84rem;margin:0 0 8px;">Tracking shows expected packed / pickup / shipping / delivery dates from these values (courier ETA overrides delivery when available). Zone = local (same city / PIN area), zonal (same state or listed states), national (rest).</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">' +
            field('cs-pack-h', 'Packing time (hours)', c.shop && c.shop.packHours) +
            field('cs-pick-d', 'Courier pickup after packing (days)', c.shop && c.shop.pickupDays) +
            field('cs-tr-local', 'Transit days — local', c.shop && c.shop.transitLocalDays) +
            field('cs-tr-zonal', 'Transit days — zonal', c.shop && c.shop.transitZonalDays) +
            field('cs-tr-nat', 'Transit days — national', c.shop && c.shop.transitNationalDays) +
            field('cs-zonal-states', 'Zonal states (comma separated)', c.shop && c.shop.zonalStates) +
            field('cs-slot-h', 'Delivery slot length (hours)', c.shop && c.shop.slotHours) +
            '</div>' +
            '<h4 style="margin:16px 0 6px;">Courier rate card (₹)</h4>' +
            '<p style="color:#64748b;font-size:0.84rem;margin:0 0 8px;">Estimated courier charge shown while booking forward and return shipments and saved with the booking.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">' +
            field('cs-rate-hb', 'Hyperlocal base', c.shop && c.shop.rateHyperBase) +
            field('cs-rate-hk', 'Hyperlocal per km', c.shop && c.shop.rateHyperPerKm) +
            field('cs-rate-local', 'Parcel — local zone', c.shop && c.shop.rateLocal) +
            field('cs-rate-zonal', 'Parcel — zonal', c.shop && c.shop.rateZonal) +
            field('cs-rate-nat', 'Parcel — national', c.shop && c.shop.rateNational) +
            field('cs-rate-ret', 'Return leg (% of forward rate)', c.shop && c.shop.rateReturnPct) +
            '</div>' +
            '<label style="display:inline-block;margin-top:8px;"><input type="checkbox" id="cs-slots-on"> Let customers choose a delivery time slot at checkout</label>' +
            '<label style="display:inline-block;margin-left:14px;margin-top:8px;"><input type="checkbox" id="cs-auto-rto"> Auto-create return shipment when courier marks RTO / undelivered</label>' +
            '<div><button type="button" class="btn-primary" style="margin-top:12px;" onclick="commerceSaveSettings()">Save</button></div>' +
            '<p id="commerce-settings-msg" style="font-weight:600;"></p></div>';
        const mode = document.getElementById('cs-mode');
        const hyper = document.getElementById('cs-hyper');
        if (mode) mode.value = c.defaultMode || 'logistics';
        if (hyper) hyper.value = c.defaultHyperlocalProvider || 'shipday';
        const shop = c.shop || {};
        const box = (id, on) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!on;
        };
        box('cs-shop-on', shop.enabled !== false);
        box('cs-rz', shop.razorpayEnabled !== false);
        box('cs-cod', shop.codEnabled !== false);
        box('cs-pickup', shop.storePickupEnabled !== false);
        box('cs-delivery', shop.deliveryEnabled !== false);
        box('cs-returns', shop.returnsEnabled !== false);
        box('cs-replace', shop.replacementsEnabled !== false);
        box('cs-slots-on', shop.slotsEnabled !== false);
        box('cs-auto-rto', shop.autoReturnShipment !== false);
    } catch (e) {
        panel.innerHTML = '<p style="color:#b91c1c;">' + escCommerce(e.message) + '</p>';
    }
}

async function commerceSaveSettings() {
    const msg = document.getElementById('commerce-settings-msg');
    try {
        await commerceFetch('/api/admin/commerce/config', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                config: {
                    storeName: val('cs-store'),
                    storePhone: val('cs-phone'),
                    storeEmail: val('cs-email'),
                    storeAddress: val('cs-addr'),
                    storeCity: val('cs-city'),
                    storeState: val('cs-state'),
                    storePincode: val('cs-pin'),
                    storeLat: val('cs-lat'),
                    storeLng: val('cs-lng'),
                    mapsApiKey: val('cs-maps'),
                    defaultMode: val('cs-mode'),
                    defaultHyperlocalProvider: val('cs-hyper'),
                    tookan: { enabled: document.getElementById('cs-tookan-on').checked, apiKey: val('cs-tookan'), sharedSecret: val('cs-secret') },
                    shipday: { enabled: document.getElementById('cs-ship-on').checked, apiKey: val('cs-ship') },
                    pidge: {
                        enabled: document.getElementById('cs-pidge-on').checked,
                        username: val('cs-pidge-user'),
                        password: val('cs-pidge-pass'),
                        webhookToken: val('cs-pidge-hook'),
                        channel: val('cs-pidge-channel')
                    },
                    fleetbase: {
                        enabled: document.getElementById('cs-fleet-on').checked,
                        apiHost: val('cs-fleet-host'),
                        secretKey: val('cs-fleet-key'),
                        webhookToken: val('cs-fleet-hook'),
                        orderType: val('cs-fleet-type'),
                        hubs: '',
                        openBoxDelivery: document.getElementById('cs-fleet-open').checked
                    },
                    shop: {
                        enabled: document.getElementById('cs-shop-on').checked,
                        razorpayEnabled: document.getElementById('cs-rz').checked,
                        codEnabled: document.getElementById('cs-cod').checked,
                        storePickupEnabled: document.getElementById('cs-pickup').checked,
                        deliveryEnabled: document.getElementById('cs-delivery').checked,
                        returnsEnabled: document.getElementById('cs-returns').checked,
                        replacementsEnabled: document.getElementById('cs-replace').checked,
                        orderOpen: val('cs-order-open'),
                        orderClose: val('cs-order-close'),
                        pickupOpen: val('cs-pick-open'),
                        pickupClose: val('cs-pick-close'),
                        deliveryOpen: val('cs-del-open'),
                        deliveryClose: val('cs-del-close'),
                        pickupLeadMinutes: val('cs-lead'),
                        deliveryLeadMinutes: val('cs-dlead'),
                        returnWindowDays: val('cs-window'),
                        codExtraCharge: val('cs-cod-fee'),
                        packHours: val('cs-pack-h'),
                        pickupDays: val('cs-pick-d'),
                        transitLocalDays: val('cs-tr-local'),
                        transitZonalDays: val('cs-tr-zonal'),
                        transitNationalDays: val('cs-tr-nat'),
                        zonalStates: val('cs-zonal-states'),
                        slotHours: val('cs-slot-h'),
                        rateHyperBase: val('cs-rate-hb'),
                        rateHyperPerKm: val('cs-rate-hk'),
                        rateLocal: val('cs-rate-local'),
                        rateZonal: val('cs-rate-zonal'),
                        rateNational: val('cs-rate-nat'),
                        rateReturnPct: val('cs-rate-ret'),
                        slotsEnabled: document.getElementById('cs-slots-on').checked,
                        autoReturnShipment: document.getElementById('cs-auto-rto').checked
                    }
                }
            })
        });
        if (msg) msg.textContent = 'Saved.';
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

function val(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

async function commercePlaceOrder() {
    const msg = document.getElementById('commerce-place-msg');
    try {
        const data = await commerceFetch('/api/admin/commerce/orders', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                buyerName: val('c-name'),
                buyerPhone: val('c-phone'),
                deliveryAddress: val('c-address'),
                city: val('c-city'),
                mode: val('c-mode'),
                service: val('c-service'),
                provider: val('c-provider'),
                items: [{ title: val('c-item') || 'Book', qty: 1 }]
            })
        });
        if (msg) msg.textContent = 'Saved ' + (data.order && data.order.orderCode);
        loadCommerceAdmin();
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

async function commerceDeleteOrder(id, code) {
    if (!confirm('Delete order ' + (code || id) + ' permanently? Items, events, returns and tracking for it are removed.')) return;
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/delete', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor() })
        });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

async function commerceDeleteAllOrders() {
    const typed = prompt('This removes EVERY shop order and its tracking. Type DELETE ALL to confirm.');
    if (typed !== 'DELETE ALL') return;
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/delete-all', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), confirm: 'DELETE ALL' })
        });
        alert('Deleted ' + (data.deleted || 0) + ' orders.');
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

async function commerceSetStage(id, stage) {
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/' + id + '/stage', {
            method: 'POST',
            body: JSON.stringify({ actingAdminId: commerceActor(), stage })
        });
        const pickup = data.pickup || {};
        if (pickup.error) alert('Order updated. Pickup was not booked: ' + pickup.error);
        else if (pickup.skipped) alert('Order marked ready. ' + pickup.skipped);
        else if (pickup.scheduled) alert('Pickup scheduled.');
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function commerceLabelHref(id, size) {
    return '/api/admin/commerce/orders/' + encodeURIComponent(id) + '/label?actingAdminId=' + encodeURIComponent(commerceActor()) + (size ? '&size=' + encodeURIComponent(size) : '');
}

async function commerceDeleteReturn(id, code) {
    if (!confirm('Delete the return / replacement request on ' + code + '? Tracking events for the return are removed. The order itself stays.')) return;
    try {
        await commerceFetch('/api/admin/commerce/orders/' + id + '/return-delete', { method: 'POST', body: JSON.stringify({ actingAdminId: commerceActor() }) });
        loadCommerceAdmin();
    } catch (e) {
        alert(e.message);
    }
}

function openCommerceLabel(id, size) {
    if (!id) return;
    window.open(commerceLabelHref(id, size), "_blank", "noopener");
}

function commercePrintSelectedLabel(size) {
    openCommerceLabel(val("c-book-order") || val("c-track-order"), size);
}

function bsCommerceQuotes(id) {
    const box = document.getElementById('bs-commerce-quotes');
    if (!box || !id) return;
    const combos = [['tookan', 'logistics', 'Tookan parcel'], ['tookan', 'hyperlocal', 'Tookan hyperlocal'], ['shipday', 'hyperlocal', 'Shipday hyperlocal'], ['pidge', 'logistics', 'Pidge logistics'], ['pidge', 'hyperlocal', 'Pidge hyperlocal']];
    box.innerHTML = combos.map((c) => '<div id="bs-q-' + c[0] + '-' + c[1] + '">' + c[2] + ': …</div>').join('');
    combos.forEach((c) => {
        commerceFetch('/api/admin/commerce/orders/' + id + '/quote?provider=' + c[0] + '&mode=' + c[1])
            .then((data) => {
                const el = document.getElementById('bs-q-' + c[0] + '-' + c[1]);
                if (el && data.quote) el.innerHTML = c[2] + ': <strong>₹' + escCommerce(data.quote.amount) + '</strong> <span style="color:#64748b;">' + escCommerce(data.quote.basis || '') + '</span>';
            })
            .catch(() => {});
    });
}

function commerceBookedHtml(provider, order, id) {
    const o = order || {};
    let html = 'Booked with Gogate Products.';
    if (o.commerceCost != null) html += ' Courier charge ₹' + escCommerce(o.commerceCost) + '.';
    if (provider === 'pidge') {
        if (o.deliveryOtp) html += ' Delivery OTP ' + escCommerce(o.deliveryOtp);
    } else if (provider === 'fleetbase') {
        if (o.pickupOtp) html += ' Pickup OTP ' + escCommerce(o.pickupOtp);
        if (o.deliveryOtp) html += ' Delivery OTP ' + escCommerce(o.deliveryOtp);
        if (o.courierTrackingNo) html += ' · AWB ' + escCommerce(o.courierTrackingNo);
    } else if (!commerceNoOtp(provider)) {
        html += ' Pickup OTP ' + escCommerce(o.pickupOtp || '—') + ' · Delivery OTP ' + escCommerce(o.deliveryOtp || '—');
    }
    if (o.commerceTrackUrl) html += ' · ' + escCommerce(o.commerceTrackUrl);
    if (id) html += ' <a href="' + commerceLabelHref(id) + '" target="_blank" rel="noopener">Print shipping label</a>';
    return html;
}

function bsPrintCommerceLabel() {
    const id = parseInt((document.getElementById('bs-courier-order-id') || {}).value, 10);
    const msg = document.getElementById('bs-commerce-book-msg');
    if (!id) {
        if (msg) msg.textContent = 'Open an order before printing the shipping label.';
        return;
    }
    openCommerceLabel(id);
}

async function commerceBookShipment() {
    const msg = document.getElementById('commerce-book-msg');
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/' + val('c-book-order') + '/book', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                provider: val('c-book-provider'),
                mode: val('c-book-mode'),
                service: val('c-book-service'),
                pickupAt: val('c-book-when'),
                openBox: !!(document.getElementById('c-book-openbox') && document.getElementById('c-book-openbox').checked),
                fragile: !!(document.getElementById('c-book-fragile') && document.getElementById('c-book-fragile').checked),
                heavy: !!(document.getElementById('c-book-heavy') && document.getElementById('c-book-heavy').checked),
                package: {
                    type: val('c-pk-type'),
                    boxSize: val('c-pk-size'),
                    lengthCm: val('c-pk-l'),
                    widthCm: val('c-pk-w'),
                    heightCm: val('c-pk-h'),
                    weightKg: val('c-pk-kg'),
                    count: val('c-pk-n'),
                    contents: val('c-pk-contents')
                }
            })
        });
        const o = data.order || {};
        if (msg) {
            msg.style.color = '#15803d';
            msg.innerHTML = commerceBookedHtml(o.commerceProvider, o, val('c-book-order'));
        }
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

let commerceTrackSeen = null;

async function commerceLoadTrack() {
    const id = val('c-track-order');
    const body = document.getElementById('commerce-track-body');
    if (!id || !body) return;
    if (commerceTrackTimer) clearInterval(commerceTrackTimer);
    commerceTrackSeen = null;
    const draw = async () => {
        try {
            const data = await commerceFetch('/api/admin/commerce/orders/' + id + '/track?actingAdminId=' + encodeURIComponent(commerceActor()));
            if (commerceTrackSeen !== id || !body.querySelector('.adm-shiptrack')) body.innerHTML = renderCommerceShipment(data, commerceTrackSeen !== id);
            drawCommerceShipTracks(body, data);
            commerceTrackSeen = id;
            if (window.TrackTimeline) TrackTimeline.mount(data.live);
        } catch (e) {
            body.innerHTML = '<p style="color:#b91c1c;">' + escCommerce(e.message) + '</p>';
        }
    };
    await draw();
    commerceTrackTimer = setInterval(draw, 15000);
}

function renderCommerceShipment(data, animate) {
    const o = data.order || {};
    const hyper = o.commerceMode === 'hyperlocal';
    return (
        '<p><strong>' +
        escCommerce(o.orderCode) +
        '</strong> · Gogate Products' +
        (o.commerceMode ? ' · ' + escCommerce(o.commerceMode) : '') +
        (hyper ? '' : '') +
        '</p>' +
        (commerceNoOtp(o.commerceProvider)
            ? ''
            : '<p>Pickup OTP <strong>' +
              escCommerce(data.pickupOtp || o.pickupOtp || '—') +
              '</strong> · Delivery OTP <strong>' +
              escCommerce(data.deliveryOtp || o.deliveryOtp || '—') +
              '</strong></p>') +
        (o.commerceTrackUrl ? '<p><a href="' + escCommerce(o.commerceTrackUrl) + '" target="_blank">Customer tracking link</a></p>' : '') +
        (o.id ? '<p><a class="btn-primary" style="text-decoration:none;" target="_blank" rel="noopener" href="' + commerceLabelHref(o.id) + '">Print shipping label</a></p>' : '') +
        (o.returnTrackUrl ? '<p><a href="' + escCommerce(o.returnTrackUrl) + '" target="_blank" rel="noopener">Customer return tracking link</a></p>' : '') +
        (window.ShipTrack && data.track
            ? '<div class="adm-shiptrack" data-kind="order"></div>' + (data.returnTrack ? '<div class="adm-shiptrack" data-kind="return" style="margin-top:18px;"></div>' : '') + commerceLinkedTrackHtml(data)
            : window.TrackTimeline && data.timeline
              ? TrackTimeline.render(
                    { timeline: data.timeline, live: data.live, awbTrackUrl: o.tookanTrackingLink || o.shipdayTrackingLink || null, trackUrl: o.commerceTrackUrl },
                    { animate: animate !== false }
                )
              : '<p style="color:#64748b;">No tracking yet.</p>')
    );
}

function commerceLinkedTrackHtml(data) {
    const linked = (data && data.linked) || {};
    let html = '';
    if (linked.replacementTrack) {
        html += '<h4 style="margin:18px 0 6px;">Replacement order ' + escCommerce(linked.replacementOrderCode || '') + ' — shipment</h4><div class="adm-shiptrack" data-kind="replacement"></div>';
    }
    if (linked.originReturnTrack) {
        html += '<h4 style="margin:18px 0 6px;">Return / replacement request on order ' + escCommerce(linked.originOrderCode || '') + '</h4><div class="adm-shiptrack" data-kind="origin"></div>';
    }
    return html;
}

function commerceQuoteLine(id, provider, mode, returnLeg, targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.textContent = 'Estimating courier charge…';
    commerceFetch('/api/admin/commerce/orders/' + id + '/quote?provider=' + encodeURIComponent(provider) + '&mode=' + encodeURIComponent(mode) + (returnLeg ? '&returnLeg=1' : ''))
        .then((data) => {
            const q = data.quote || {};
            const src = q.source && q.source !== 'seller_rate_card' ? 'Live quote from ' + q.source : 'Seller rate card';
            el.innerHTML = 'Courier charge ≈ <strong>₹' + escCommerce(q.amount) + '</strong> <span style="color:#64748b;">(' + escCommerce(src) + ' · ' + escCommerce(q.basis || '') + ')</span>';
        })
        .catch((e) => {
            el.textContent = 'Courier charge: ' + e.message;
        });
}

function drawCommerceShipTracks(root, data) {
    if (!window.ShipTrack || !root) return;
    root.querySelectorAll('.adm-shiptrack').forEach((el) => {
        const kind = el.getAttribute('data-kind');
        const linked = data.linked || {};
        const track = kind === 'return' ? data.returnTrack : kind === 'replacement' ? linked.replacementTrack : kind === 'origin' ? linked.originReturnTrack : data.track;
        window.ShipTrack.draw(el, track, data.order || {});
    });
}

function formatCommerceWhen(at) {
    if (!at) return '';
    const d = new Date(at);
    if (isNaN(d.getTime())) return String(at);
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(d);
}

function mountCommerceMap(order, mapsKey, events) {
    const el = document.getElementById('commerce-map');
    if (!el || !order || order.commerceMode !== 'hyperlocal') return;
    if (!mapsKey) {
        el.innerHTML = '<p style="padding:12px;">Add a Google Maps API key under Tookan & Shipday to show the driver moving from the store to the delivery location.</p>';
        return;
    }
    const run = () => drawDriverMap(el, order);
    if (window.google && window.google.maps) return run();
    if (document.getElementById('commerce-maps-sdk')) {
        window.__commerceMapReady = run;
        return;
    }
    window.__commerceMapReady = run;
    const s = document.createElement('script');
    s.id = 'commerce-maps-sdk';
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(mapsKey) + '&callback=__commerceMapBoot';
    s.async = true;
    document.body.appendChild(s);
    window.__commerceMapBoot = function () {
        if (typeof window.__commerceMapReady === 'function') window.__commerceMapReady();
    };
}

function drawDriverMap(el, order) {
    const store = order.storeLat != null ? { lat: Number(order.storeLat), lng: Number(order.storeLng) } : null;
    const drop = order.dropLat != null ? { lat: Number(order.dropLat), lng: Number(order.dropLng) } : null;
    const agent = order.agentLat != null ? { lat: Number(order.agentLat), lng: Number(order.agentLng) } : null;
    const center = agent || store || drop || { lat: 18.52, lng: 73.85 };
    if (!el.__map) {
        el.__map = new google.maps.Map(el, {
            center,
            zoom: 13,
            mapTypeControl: false,
            streetViewControl: false,
            styles: [
                { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
                { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#99f6e4' }] }
            ]
        });
        el.__markers = {};
        el.__dir = new google.maps.DirectionsRenderer({
            map: el.__map,
            suppressMarkers: true,
            polylineOptions: { strokeColor: '#0f766e', strokeWeight: 5 }
        });
    }
    const map = el.__map;
    map.setCenter(center);
    placeMarker(el, 'store', store, 'Store');
    placeMarker(el, 'drop', drop, 'Delivery');
    placeMarker(el, 'agent', agent, 'Driver');
    const target = order.liveLeg === 'to_store' ? store : drop;
    if (agent && target && el.__dir) {
        new google.maps.DirectionsService().route(
            { origin: agent, destination: target, travelMode: 'DRIVING' },
            (result, status) => {
                if (status === 'OK') el.__dir.setDirections(result);
            }
        );
    }
}

function placeMarker(el, key, pos, title) {
    if (!pos || pos.lat == null || Number.isNaN(pos.lat)) {
        if (el.__markers[key]) el.__markers[key].setMap(null);
        return;
    }
    if (!el.__markers[key]) {
        el.__markers[key] = new google.maps.Marker({ map: el.__map, position: pos, title });
    } else {
        el.__markers[key].setMap(el.__map);
        el.__markers[key].setPosition(pos);
    }
}

function commerceKeyCardHtml(compact) {
    const hint = compact
        ? 'These are the same Tookan, Shipday, Pidge, and Fleetbase keys used by Commerce. A POS order still appears on the Commerce desk when doctor book orders are closed.'
        : 'Tookan, Pidge, and Fleetbase cover logistics and hyperlocal. Shipday covers hyperlocal. The Google Maps key draws the live driver route and can look up an address when a Tookan parcel has no coordinates. Shipday does not use an OTP. A Pidge or Fleetbase delivery OTP is shown only when that courier sends one.';
    return (
        '<div id="bs-commerce-keys" class="card" style="padding:18px;margin:0 0 14px;border:1px solid #99f6e4;background:#f0fdfa;">' +
        '<h3 style="margin:0 0 8px;color:#0f766e;">Tookan, Shipday, Pidge, Fleetbase and live map</h3>' +
        '<p style="font-size:0.84rem;color:#64748b;margin:0 0 10px;">' +
        hint +
        '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">' +
        field('bpos-store', 'Store name') +
        field('bpos-phone', 'Store phone') +
        field('bpos-email', 'Store email for pickup codes') +
        field('bpos-addr', 'Store address') +
        field('bpos-city', 'Store city') +
        field('bpos-state', 'Store state') +
        field('bpos-pin', 'Store PIN') +
        field('bpos-lat', 'Store latitude') +
        field('bpos-lng', 'Store longitude') +
        field('bpos-maps', 'Google Maps API key') +
        field('bpos-tookan', 'Tookan API key') +
        field('bpos-secret', 'Tookan webhook secret') +
        field('bpos-ship', 'Shipday API key') +
        field('bpos-pidge-user', 'Pidge username') +
        field('bpos-pidge-pass', 'Pidge password') +
        field('bpos-pidge-hook', 'Pidge webhook token') +
        field('bpos-pidge-channel', 'Pidge channel') +
        field('bpos-fleet-host', 'Fleetbase API host') +
        field('bpos-fleet-key', 'Fleetbase secret key') +
        field('bpos-fleet-hook', 'Fleetbase webhook token') +
        field('bpos-fleet-type', 'Fleetbase order type') +
        '</div>' +
        '<p style="font-size:0.78rem;color:#64748b;margin:8px 0 0;">The store is not a hub. Create sorting hubs and drivers in the <a href="/fleetbase/hub/">Fleetbase hub</a>. Agents use <a href="/fleetbase/fleet-ops/settings/navigator-app">Fleetbase Navigator</a>.</p>' +
        '<label style="display:block;margin-top:8px;"><input type="checkbox" id="bpos-tookan-on"> Tookan enabled (logistics and hyperlocal)</label>' +
        '<label style="display:block;"><input type="checkbox" id="bpos-ship-on"> Shipday enabled (hyperlocal)</label>' +
        '<label style="display:block;"><input type="checkbox" id="bpos-pidge-on"> Pidge enabled (logistics and hyperlocal)</label>' +
        '<label style="display:block;"><input type="checkbox" id="bpos-fleet-on"> Fleetbase enabled (logistics and hyperlocal)</label>' +
        '<label style="display:block;"><input type="checkbox" id="bpos-fleet-open"> Fleetbase open box delivery</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
        '<label>Default<select id="bpos-mode"><option value="logistics">Logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
        '<label>Hyperlocal provider<select id="bpos-hyper"><option value="shipday">Shipday</option><option value="tookan">Tookan</option><option value="pidge">Pidge</option><option value="fleetbase">Fleetbase</option></select></label>' +
        '</div>' +
        '<p style="font-size:0.78rem;color:#64748b;margin:8px 0 0;">Webhooks: <code>/api/public/tookan/webhook</code>, <code>/api/public/shipday/webhook</code>, <code>/api/public/pidge/webhook</code>, and <code>/api/public/fleetbase/webhook</code>. Fleetbase shipments use <code>/fleetbase/track/?token=…</code>. Other couriers stay on <code>/track-commerce?token=…</code>.</p>' +
        '<button type="button" class="btn-primary" style="margin-top:10px;background:#0f766e;" onclick="commerceSavePosKeys()">Save courier keys</button>' +
        '<p id="bpos-keys-msg" style="font-weight:600;margin:8px 0 0;"></p></div>'
    );
}

function mountBookIntegrations() {
    const config = document.getElementById('bs-panel-config');
    if (config && !document.getElementById('bs-commerce-keys')) {
        const card = document.createElement('div');
        card.innerHTML = commerceKeyCardHtml(false);
        const logisticsHeading = Array.from(config.querySelectorAll('h3')).find((h) => /Logistics API/i.test(h.textContent || ''));
        const host = logisticsHeading && logisticsHeading.closest('.card');
        if (host && host.parentNode) host.parentNode.insertBefore(card.firstChild, host.nextSibling);
        else config.insertBefore(card.firstChild, config.firstChild);
        commerceFillPosKeys();
    }
    const pos = document.getElementById('bs-panel-pos');
    if (pos && !document.getElementById('bs-pos-commerce-note')) {
        const note = document.createElement('div');
        note.id = 'bs-pos-commerce-note';
        note.style.cssText = 'grid-column:1/-1;padding:12px 14px;border:1px solid #99f6e4;background:#f0fdfa;border-radius:12px;margin-bottom:12px;font-size:0.86rem;color:#134e4a;';
        note.innerHTML =
            '<strong>Commerce integrations.</strong> Tookan, Shipday, Pidge, and Fleetbase keys are saved with the book-sales logistics settings. ' +
            'A POS order is listed in Commerce even when the doctor book-order screen is closed. ' +
            '<button type="button" class="btn-primary" style="margin-left:8px;background:#0f766e;padding:4px 10px;" onclick="switchBsTab(\'config\')">Open integrations</button>';
        pos.insertBefore(note, pos.firstChild);
    }
    const ship = document.getElementById('bs-courier-panel-ship');
    if (ship && !document.getElementById('bs-tookan-book-box') && !ship.querySelector('[onclick*="bsBookCommerce"]')) {
        const box = document.createElement('div');
        box.id = 'bs-tookan-book-box';
        box.style.cssText = 'border:2px solid #0f766e;border-radius:12px;padding:16px;margin:0 0 16px;';
        box.innerHTML =
            '<div style="font-weight:800;color:#0f766e;margin-bottom:6px;">Gogate Products</div>' +
            '<p style="font-size:0.8rem;color:#64748b;margin:0 0 10px;">Customers see Gogate Products as the courier partner. Tookan uses the pickup and delivery OTPs Tookan issues. Pidge and Fleetbase show a delivery OTP only when that courier sends one. Shipday does not use an OTP. A Tookan parcel needs pickup and delivery coordinates so the hub path can be calculated. A hub without a map pin is ignored. If Tookan rejects the booking, the message lists the seller local hub, city mother hub, transit hub, destination city hub, and delivery local hub this shipment needs. The shipping label is created only after the courier API returns an AWB.</p>' +
            '<label style="font-size:0.78rem;display:block;margin-bottom:8px;"><input id="bs-commerce-openbox" type="checkbox"> Open box delivery</label>' +
            '<label style="font-size:0.78rem;display:block;margin-bottom:8px;"><input id="bs-commerce-fragile" type="checkbox"> Fragile</label>' +
            '<label style="font-size:0.78rem;display:block;margin-bottom:8px;"><input id="bs-commerce-heavy" type="checkbox"> Heavy</label>' +
            '<label style="font-size:0.78rem;">Pickup time (IST)<input id="bs-commerce-when" type="datetime-local" style="width:100%;padding:8px;margin:4px 0 10px;"></label>' +
            '<div id="bs-commerce-quotes" style="font-size:0.8rem;margin:0 0 10px;color:#334155;"></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" class="btn-primary" style="background:#111;flex:1;min-width:140px;" onclick="bsPrintCommerceLabel()">Print shipping label</button>' +
            '<button type="button" class="btn-primary" style="background:#0d9488;flex:1;min-width:140px;" onclick="bsBookCommerce(\'tookan\',\'logistics\')">Tookan logistics</button>' +
            '<button type="button" class="btn-primary" style="background:#0f766e;flex:1;min-width:140px;" onclick="bsBookCommerce(\'tookan\',\'hyperlocal\')">Tookan hyperlocal</button>' +
            '<button type="button" class="btn-primary" style="background:#0369a1;flex:1;min-width:140px;" onclick="bsBookCommerce(\'shipday\',\'hyperlocal\')">Shipday hyperlocal</button>' +
            '<button type="button" class="btn-primary" style="background:#7c3aed;flex:1;min-width:140px;" onclick="bsBookCommerce(\'pidge\',\'logistics\')">Pidge logistics</button>' +
            '<button type="button" class="btn-primary" style="background:#6d28d9;flex:1;min-width:140px;" onclick="bsBookCommerce(\'pidge\',\'hyperlocal\')">Pidge hyperlocal</button>' +
            '<button type="button" class="btn-primary" style="background:#9a3412;flex:1;min-width:140px;" onclick="bsBookCommerce(\'fleetbase\',\'logistics\')">Fleetbase logistics</button>' +
            '<button type="button" class="btn-primary" style="background:#c2410c;flex:1;min-width:140px;" onclick="bsBookCommerce(\'fleetbase\',\'hyperlocal\')">Fleetbase hyperlocal</button>' +
            '</div>' +
            '<p id="bs-commerce-book-msg" style="font-weight:600;margin:8px 0 0;"></p>';
        const manual = ship.querySelector('#bs-courier-tracking');
        const manualBox = manual && manual.closest('div[style*="border:1px solid"]');
        if (manualBox && manualBox.parentNode) manualBox.parentNode.insertBefore(box, manualBox);
        else ship.appendChild(box);
        let lastQuoteId = '';
        setInterval(() => {
            const idEl = document.getElementById('bs-courier-order-id');
            const v = idEl && idEl.value ? String(idEl.value) : '';
            if (v && v !== lastQuoteId) {
                lastQuoteId = v;
                bsCommerceQuotes(parseInt(v, 10));
            }
        }, 1500);
    }
}

async function commerceFillPosKeys() {
    if (!document.getElementById('bpos-store')) return;
    try {
        const data = await commerceFetch('/api/admin/commerce/config?actingAdminId=' + encodeURIComponent(commerceActor()));
        const c = data.config || {};
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el && value != null) el.value = value;
        };
        set('bpos-store', c.storeName || '');
        set('bpos-phone', c.storePhone || '');
        set('bpos-email', c.storeEmail || '');
        set('bpos-addr', c.storeAddress || '');
        set('bpos-city', c.storeCity || '');
        set('bpos-state', c.storeState || '');
        set('bpos-pin', c.storePincode || '');
        set('bpos-lat', c.storeLat != null ? c.storeLat : '');
        set('bpos-lng', c.storeLng != null ? c.storeLng : '');
        const tookan = c.tookan || {};
        const ship = c.shipday || {};
        const pidge = c.pidge || {};
        const fleet = c.fleetbase || {};
        const tookanOn = document.getElementById('bpos-tookan-on');
        const shipOn = document.getElementById('bpos-ship-on');
        const pidgeOn = document.getElementById('bpos-pidge-on');
        const fleetOn = document.getElementById('bpos-fleet-on');
        const fleetOpen = document.getElementById('bpos-fleet-open');
        if (tookanOn) tookanOn.checked = !!tookan.enabled;
        if (shipOn) shipOn.checked = !!ship.enabled;
        if (pidgeOn) pidgeOn.checked = !!pidge.enabled;
        if (fleetOn) fleetOn.checked = !!fleet.enabled;
        if (fleetOpen) fleetOpen.checked = !!fleet.openBoxDelivery;
        set('bpos-pidge-channel', pidge.channel || '');
        set('bpos-fleet-host', fleet.apiHost || '');
        set('bpos-fleet-type', fleet.orderType || '');
        const mode = document.getElementById('bpos-mode');
        const hyper = document.getElementById('bpos-hyper');
        if (mode) mode.value = c.defaultMode || 'logistics';
        if (hyper) hyper.value = c.defaultHyperlocalProvider || 'shipday';
        const msg = document.getElementById('bpos-keys-msg');
        if (msg) {
            msg.style.color = '#0f766e';
            msg.textContent =
                (tookan.configured ? 'Tookan key saved' : 'Tookan key not saved') +
                (tookan.apiKeyHint ? ' (' + tookan.apiKeyHint + ')' : '') +
                ' · ' +
                (ship.configured ? 'Shipday key saved' : 'Shipday key not saved') +
                (ship.apiKeyHint ? ' (' + ship.apiKeyHint + ')' : '') +
                ' · ' +
                (pidge.configured ? 'Pidge login saved' : 'Pidge login not saved') +
                (pidge.usernameHint ? ' (' + pidge.usernameHint + ')' : '') +
                ' · ' +
                (fleet.configured ? 'Fleetbase key saved' : 'Fleetbase key not saved') +
                (fleet.secretHint ? ' (' + fleet.secretHint + ')' : '') +
                (fleet.apiHost ? ' · ' + fleet.apiHost : '') +
                (c.mapsKeySet ? ' · Maps key saved' : ' · Maps key not saved');
        }
    } catch (e) {
        const msg = document.getElementById('bpos-keys-msg');
        if (msg) msg.textContent = e.message;
    }
}

async function commerceSavePosKeys() {
    const msg = document.getElementById('bpos-keys-msg');
    try {
        await commerceFetch('/api/admin/commerce/config', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                config: {
                    storeName: val('bpos-store'),
                    storePhone: val('bpos-phone'),
                    storeEmail: val('bpos-email'),
                    storeAddress: val('bpos-addr'),
                    storeCity: val('bpos-city'),
                    storeState: val('bpos-state'),
                    storePincode: val('bpos-pin'),
                    storeLat: val('bpos-lat'),
                    storeLng: val('bpos-lng'),
                    mapsApiKey: val('bpos-maps'),
                    defaultMode: val('bpos-mode'),
                    defaultHyperlocalProvider: val('bpos-hyper'),
                    tookan: {
                        enabled: !!(document.getElementById('bpos-tookan-on') && document.getElementById('bpos-tookan-on').checked),
                        apiKey: val('bpos-tookan'),
                        sharedSecret: val('bpos-secret')
                    },
                    shipday: {
                        enabled: !!(document.getElementById('bpos-ship-on') && document.getElementById('bpos-ship-on').checked),
                        apiKey: val('bpos-ship')
                    },
                    pidge: {
                        enabled: !!(document.getElementById('bpos-pidge-on') && document.getElementById('bpos-pidge-on').checked),
                        username: val('bpos-pidge-user'),
                        password: val('bpos-pidge-pass'),
                        webhookToken: val('bpos-pidge-hook'),
                        channel: val('bpos-pidge-channel')
                    },
                    fleetbase: {
                        enabled: !!(document.getElementById('bpos-fleet-on') && document.getElementById('bpos-fleet-on').checked),
                        apiHost: val('bpos-fleet-host'),
                        secretKey: val('bpos-fleet-key'),
                        webhookToken: val('bpos-fleet-hook'),
                        orderType: val('bpos-fleet-type'),
                        hubs: '',
                        openBoxDelivery: !!(document.getElementById('bpos-fleet-open') && document.getElementById('bpos-fleet-open').checked)
                    }
                }
            })
        });
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent = 'Tookan, Shipday, Pidge, Fleetbase, and map settings saved.';
        }
        commerceFillPosKeys();
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message;
        }
    }
}

async function bsBookCommerce(provider, mode) {
    const msg = document.getElementById('bs-commerce-book-msg');
    const id = parseInt((document.getElementById('bs-courier-order-id') || {}).value, 10);
    if (!id) {
        if (msg) msg.textContent = 'Open an order before booking pickup.';
        return;
    }
    if (msg) msg.textContent = 'Booking…';
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/' + id + '/book', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                provider,
                mode,
                pickupAt: val('bs-commerce-when'),
                openBox: !!(document.getElementById('bs-commerce-openbox') && document.getElementById('bs-commerce-openbox').checked),
                fragile: !!(document.getElementById('bs-commerce-fragile') && document.getElementById('bs-commerce-fragile').checked),
                heavy: !!(document.getElementById('bs-commerce-heavy') && document.getElementById('bs-commerce-heavy').checked)
            })
        });
        const o = data.order || {};
        if (msg) {
            msg.style.color = '#15803d';
            msg.innerHTML = commerceBookedHtml(provider, o, id);
        }
        if (typeof bsViewOrderTracking === 'function') bsViewOrderTracking(id);
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message;
        }
    }
}

async function appendCommerceTrackPanel(id) {
    const body = document.getElementById('bs-tracking-body');
    if (!body || body.querySelector('.tl') || body.querySelector('#bs-commerce-live')) return;
    const data = await commerceFetch('/api/admin/commerce/orders/' + id + '/track?actingAdminId=' + encodeURIComponent(commerceActor()));
    const co = data && data.order;
    if (!co) return;
    const box = document.createElement('div');
    box.id = 'bs-commerce-live';
    box.style.cssText = 'border:1px solid #99f6e4;background:#f0fdfa;border-radius:12px;padding:14px;margin-bottom:14px;';
    let inner =
        '<p style="margin:0 0 6px;font-weight:700;">' +
        'Gogate Products' +
        (co.commerceMode ? ' · ' + escCommerce(co.commerceMode) : '') +
        '</p>' +
        (commerceNoOtp(co.commerceProvider) || (co.commerceProvider === 'fleetbase' && !co.pickupOtp && !co.deliveryOtp)
            ? ''
            : co.commerceProvider === 'fleetbase'
              ? '<p style="margin:0 0 8px;font-size:0.85rem;">' +
                (co.pickupOtp ? 'Pickup OTP <strong>' + escCommerce(co.pickupOtp) + '</strong>' : '') +
                (co.pickupOtp && co.deliveryOtp ? ' · ' : '') +
                (co.deliveryOtp ? 'Delivery OTP <strong>' + escCommerce(co.deliveryOtp) + '</strong>' : '') +
                (co.agentPhone ? ' · Agent ' + escCommerce(co.agentPhone) : '') +
                '</p>'
              : '<p style="margin:0 0 8px;font-size:0.85rem;">Pickup OTP <strong>' +
                escCommerce(co.pickupOtp || '—') +
                '</strong> · Delivery OTP <strong>' +
                escCommerce(co.deliveryOtp || '—') +
                '</strong>' +
                (co.agentPhone ? ' · Agent ' + escCommerce(co.agentPhone) : '') +
                '</p>') +
        (commerceNoOtp(co.commerceProvider) && co.agentPhone ? '<p style="margin:0 0 8px;font-size:0.85rem;">Agent ' + escCommerce(co.agentPhone) + '</p>' : '');
    if (co.commerceTrackUrl) {
        inner += '<p style="margin:0 0 8px;font-size:0.82rem;"><a href="' + escCommerce(co.commerceTrackUrl) + '" target="_blank" rel="noopener">Public tracking link</a></p>';
    }
    if (id) {
        inner +=
            '<p style="margin:0 0 8px;"><a class="btn-primary" style="text-decoration:none;" target="_blank" rel="noopener" href="' +
            commerceLabelHref(id) +
            '">Print shipping label</a></p>';
    }
    if (co.returnTrackUrl) {
        inner += '<p style="margin:0 0 8px;font-size:0.82rem;"><a href="' + escCommerce(co.returnTrackUrl) + '" target="_blank" rel="noopener">Customer return tracking link</a></p>';
    }
    if (data.track && window.ShipTrack) {
        inner += '<div class="adm-shiptrack" data-kind="order"></div>' + (data.returnTrack ? '<div class="adm-shiptrack" data-kind="return" style="margin-top:18px;"></div>' : '') + commerceLinkedTrackHtml(data);
    } else if (data.timeline && window.TrackTimeline) {
        inner += window.TrackTimeline.render(
            {
                timeline: data.timeline,
                live: data.live,
                awbTrackUrl: co.tookanTrackingLink || co.shipdayTrackingLink || null,
                trackUrl: co.commerceTrackUrl
            },
            { animate: false }
        );
    }
    box.innerHTML = inner;
    body.insertBefore(box, body.firstChild);
    drawCommerceShipTracks(box, data);
    if (window.TrackTimeline) {
        if (data.live) window.TrackTimeline.mount(data.live);
        else if (window.TrackTimeline.bind) window.TrackTimeline.bind(box);
    }
}

function installCommerceTrackingHook() {
    if (typeof window.bsViewOrderTracking !== 'function') return false;
    if (window.bsViewOrderTracking.__commerce) return true;
    const orig = window.bsViewOrderTracking;
    const wrapped = async function (id) {
        const out = await orig.apply(this, arguments);
        try {
            await appendCommerceTrackPanel(id);
        } catch (_) {}
        return out;
    };
    wrapped.__commerce = true;
    window.bsViewOrderTracking = wrapped;
    return true;
}

function bootCommerceEmbeds() {
    mountBookIntegrations();
    installCommerceTrackingHook();
}

document.addEventListener('click', function () {
    setTimeout(bootCommerceEmbeds, 40);
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootCommerceEmbeds);
else bootCommerceEmbeds();

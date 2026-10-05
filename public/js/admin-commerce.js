/**
 * Admin Commerce desk: order flow, Tookan / Shipday booking, tracking, labels.
 */
let commerceOrders = [];
let commercePanel = 'desk';
let commerceTrackTimer = null;

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
            if (commercePanel === 'desk') renderCommerceDesk();
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

function renderCommerceDesk() {
    const panel = document.getElementById('commerce-panel');
    const rows = commerceOrders
        .map((o) => {
            return (
                '<tr><td><strong>' +
                escCommerce(o.orderCode) +
                '</strong><br><span style="color:#64748b;font-size:0.8rem;">' +
                escCommerce(o.buyerName || '') +
                ' ' +
                escCommerce(o.buyerPhone || '') +
                '</span></td><td>' +
                escCommerce(commerceStageLabel(o.commerceStage)) +
                '</td><td>' +
                (o.commerceProvider === 'shipday'
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
        '<label>Hyperlocal provider<select id="c-provider"><option value="">Auto</option><option value="shipday">Shipday</option><option value="tookan">Tookan</option></select></label>' +
        '</div><button type="button" class="btn-primary" style="margin-top:12px;" onclick="commercePlaceOrder()">Save order</button>' +
        '<p id="commerce-place-msg" style="font-weight:600;"></p></div>' +
        '<table class="data-table" style="width:100%;"><thead><tr><th>Order</th><th>Stage</th><th>OTP</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4">No orders yet.</td></tr>') +
        '</tbody></table>';
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

function renderCommerceBook() {
    const panel = document.getElementById('commerce-panel');
    const opts = commerceOrders
        .map((o) => '<option value="' + o.id + '">' + escCommerce(o.orderCode) + ' · ' + escCommerce(commerceStageLabel(o.commerceStage)) + '</option>')
        .join('');
    panel.innerHTML =
        '<div class="card" style="padding:16px;"><h3 style="margin-top:0;">Book a shipment</h3>' +
        '<p style="color:#64748b;font-size:0.88rem;">Logistics uses Tookan. Hyperlocal can use Shipday or Tookan. Marking an order ready on the desk schedules this automatically when keys are saved.</p>' +
        '<label>Order<select id="c-book-order">' +
        opts +
        '</select></label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
        '<label>Provider<select id="c-book-provider"><option value="tookan">Tookan</option><option value="shipday">Shipday</option></select></label>' +
        '<label>Mode<select id="c-book-mode"><option value="logistics">Logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
        '<label>Pickup time (IST)<input id="c-book-when" type="datetime-local"></label>' +
        '</div>' +
        '<button type="button" class="btn-primary" style="margin-top:12px;" onclick="commerceBookShipment()">Book pickup</button>' +
        '<p id="commerce-book-msg" style="font-weight:600;"></p></div>';
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
                '"><option value="tookan">Tookan</option><option value="shipday">Shipday</option></select> ' +
                '<select id="ret-mode-' +
                o.id +
                '"><option value="hyperlocal">Hyperlocal</option><option value="logistics">Logistics</option></select><br>' +
                '<input id="ret-when-' +
                o.id +
                '" type="datetime-local" style="margin-top:6px;">' +
                '<button type="button" class="btn-primary" style="margin-top:6px;background:#0f766e;" onclick="commerceScheduleReturn(' +
                o.id +
                ')">Schedule return pickup</button></div></td></tr>'
            );
        })
        .join('');
    panel.innerHTML =
        '<p style="color:#64748b;">Customer return and replacement requests appear here. Update the status, then schedule a Tookan or Shipday pickup for the return shipment. The customer sees the same updates on the order tracking screen.</p>' +
        '<table class="data-table" style="width:100%;"><thead><tr><th>Order</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="3">No return requests yet.</td></tr>') +
        '</tbody></table>';
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
                '">Print label</a></td></tr>'
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
        panel.innerHTML =
            '<div class="card" style="padding:16px;"><h3 style="margin-top:0;">Store & keys</h3>' +
            '<p style="color:#64748b;font-size:0.86rem;">Leave a key blank to keep the saved value. Tookan key hint ' +
            escCommerce(t.apiKeyHint || 'not set') +
            '. Shipday key hint ' +
            escCommerce(s.apiKeyHint || 'not set') +
            '.</p>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">' +
            field('cs-store', 'Store name', c.storeName) +
            field('cs-phone', 'Store phone', c.storePhone) +
            field('cs-addr', 'Store address', c.storeAddress) +
            field('cs-city', 'Store city', c.storeCity) +
            field('cs-lat', 'Store latitude', c.storeLat) +
            field('cs-lng', 'Store longitude', c.storeLng) +
            field('cs-maps', 'Google Maps API key', '') +
            field('cs-tookan', 'Tookan API key', '') +
            field('cs-secret', 'Tookan webhook secret', '') +
            field('cs-ship', 'Shipday API key', '') +
            '</div>' +
            '<label style="display:block;margin-top:8px;"><input type="checkbox" id="cs-tookan-on" ' +
            (t.enabled ? 'checked' : '') +
            '> Tookan enabled</label>' +
            '<label style="display:block;"><input type="checkbox" id="cs-ship-on" ' +
            (s.enabled ? 'checked' : '') +
            '> Shipday enabled</label>' +
            '<label>Default mode<select id="cs-mode"><option value="logistics">Logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
            '<label style="margin-left:8px;">Hyperlocal provider<select id="cs-hyper"><option value="shipday">Shipday</option><option value="tookan">Tookan</option></select></label>' +
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
                    storeAddress: val('cs-addr'),
                    storeCity: val('cs-city'),
                    storeLat: val('cs-lat'),
                    storeLng: val('cs-lng'),
                    mapsApiKey: val('cs-maps'),
                    defaultMode: val('cs-mode'),
                    defaultHyperlocalProvider: val('cs-hyper'),
                    tookan: { enabled: document.getElementById('cs-tookan-on').checked, apiKey: val('cs-tookan'), sharedSecret: val('cs-secret') },
                    shipday: { enabled: document.getElementById('cs-ship-on').checked, apiKey: val('cs-ship') },
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
                        codExtraCharge: val('cs-cod-fee')
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

async function commerceBookShipment() {
    const msg = document.getElementById('commerce-book-msg');
    try {
        const data = await commerceFetch('/api/admin/commerce/orders/' + val('c-book-order') + '/book', {
            method: 'POST',
            body: JSON.stringify({
                actingAdminId: commerceActor(),
                provider: val('c-book-provider'),
                mode: val('c-book-mode'),
                pickupAt: val('c-book-when')
            })
        });
        const o = data.order || {};
        if (msg) {
            msg.textContent =
                'Booked with Gogate Products.' +
                (o.commerceProvider === 'shipday' ? '' : ' Pickup OTP ' + (o.pickupOtp || '—') + ' · Delivery OTP ' + (o.deliveryOtp || '—')) +
                (o.commerceTrackUrl ? ' · ' + o.commerceTrackUrl : '');
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
            body.innerHTML = renderCommerceShipment(data, commerceTrackSeen !== id);
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
        (o.commerceProvider === 'shipday'
            ? ''
            : '<p>Pickup OTP <strong>' +
              escCommerce(data.pickupOtp || o.pickupOtp || '—') +
              '</strong> · Delivery OTP <strong>' +
              escCommerce(data.deliveryOtp || o.deliveryOtp || '—') +
              '</strong></p>') +
        (o.commerceTrackUrl ? '<p><a href="' + escCommerce(o.commerceTrackUrl) + '" target="_blank">Customer tracking link</a></p>' : '') +
        (window.TrackTimeline && data.timeline
            ? TrackTimeline.render(
                  { timeline: data.timeline, live: data.live, awbTrackUrl: o.tookanTrackingLink || o.shipdayTrackingLink || null, trackUrl: o.commerceTrackUrl },
                  { animate: animate !== false }
              )
            : '<p style="color:#64748b;">No tracking yet.</p>')
    );
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
        ? 'These are the same Tookan and Shipday keys used by Commerce. A POS order still appears on the Commerce desk when doctor book orders are closed.'
        : 'Tookan covers logistics and hyperlocal pickup and delivery. Shipday covers hyperlocal. The Google Maps key draws the live driver route.';
    return (
        '<div id="bs-commerce-keys" class="card" style="padding:18px;margin:0 0 14px;border:1px solid #99f6e4;background:#f0fdfa;">' +
        '<h3 style="margin:0 0 8px;color:#0f766e;">Tookan, Shipday and live map</h3>' +
        '<p style="font-size:0.84rem;color:#64748b;margin:0 0 10px;">' +
        hint +
        '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;">' +
        field('bpos-store', 'Store name') +
        field('bpos-phone', 'Store phone') +
        field('bpos-addr', 'Store address') +
        field('bpos-city', 'Store city') +
        field('bpos-lat', 'Store latitude') +
        field('bpos-lng', 'Store longitude') +
        field('bpos-maps', 'Google Maps API key') +
        field('bpos-tookan', 'Tookan API key') +
        field('bpos-secret', 'Tookan webhook secret') +
        field('bpos-ship', 'Shipday API key') +
        '</div>' +
        '<label style="display:block;margin-top:8px;"><input type="checkbox" id="bpos-tookan-on"> Tookan enabled (logistics and hyperlocal)</label>' +
        '<label style="display:block;"><input type="checkbox" id="bpos-ship-on"> Shipday enabled (hyperlocal)</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
        '<label>Default<select id="bpos-mode"><option value="logistics">Tookan logistics</option><option value="hyperlocal">Hyperlocal</option></select></label>' +
        '<label>Hyperlocal provider<select id="bpos-hyper"><option value="shipday">Shipday</option><option value="tookan">Tookan</option></select></label>' +
        '</div>' +
        '<p style="font-size:0.78rem;color:#64748b;margin:8px 0 0;">Webhooks: <code>/api/public/tookan/webhook</code> and <code>/api/public/shipday/webhook</code>. Public tracking links use <code>/track-commerce?token=…</code>.</p>' +
        '<button type="button" class="btn-primary" style="margin-top:10px;background:#0f766e;" onclick="commerceSavePosKeys()">Save Tookan and Shipday</button>' +
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
            '<strong>Commerce integrations.</strong> Tookan and Shipday keys are saved with the book-sales logistics settings. ' +
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
            '<p style="font-size:0.8rem;color:#64748b;margin:0 0 10px;">Customers see Gogate Products as the courier partner. Tookan logistics creates one parcel and uses the pickup and drop OTPs Tookan issues. Shipday does not use an OTP.</p>' +
            '<label style="font-size:0.78rem;">Pickup time (IST)<input id="bs-commerce-when" type="datetime-local" style="width:100%;padding:8px;margin:4px 0 10px;"></label>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" class="btn-primary" style="background:#0d9488;flex:1;min-width:140px;" onclick="bsBookCommerce(\'tookan\',\'logistics\')">Tookan logistics</button>' +
            '<button type="button" class="btn-primary" style="background:#0f766e;flex:1;min-width:140px;" onclick="bsBookCommerce(\'tookan\',\'hyperlocal\')">Tookan hyperlocal</button>' +
            '<button type="button" class="btn-primary" style="background:#0369a1;flex:1;min-width:140px;" onclick="bsBookCommerce(\'shipday\',\'hyperlocal\')">Shipday hyperlocal</button>' +
            '</div>' +
            '<p id="bs-commerce-book-msg" style="font-weight:600;margin:8px 0 0;"></p>';
        const manual = ship.querySelector('#bs-courier-tracking');
        const manualBox = manual && manual.closest('div[style*="border:1px solid"]');
        if (manualBox && manualBox.parentNode) manualBox.parentNode.insertBefore(box, manualBox);
        else ship.appendChild(box);
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
        set('bpos-addr', c.storeAddress || '');
        set('bpos-city', c.storeCity || '');
        set('bpos-lat', c.storeLat != null ? c.storeLat : '');
        set('bpos-lng', c.storeLng != null ? c.storeLng : '');
        const tookan = c.tookan || {};
        const ship = c.shipday || {};
        const tookanOn = document.getElementById('bpos-tookan-on');
        const shipOn = document.getElementById('bpos-ship-on');
        if (tookanOn) tookanOn.checked = !!tookan.enabled;
        if (shipOn) shipOn.checked = !!ship.enabled;
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
                    storeAddress: val('bpos-addr'),
                    storeCity: val('bpos-city'),
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
                    }
                }
            })
        });
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent = 'Tookan, Shipday, and map settings saved.';
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
                pickupAt: val('bs-commerce-when')
            })
        });
        const o = data.order || {};
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent =
                'Booked with Gogate Products.' +
                (provider === 'shipday' ? '' : ' Pickup OTP ' + (o.pickupOtp || '—') + ' · Delivery OTP ' + (o.deliveryOtp || '—')) +
                (o.commerceTrackUrl ? ' · ' + o.commerceTrackUrl : '');
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
        (co.commerceProvider === 'shipday'
            ? ''
            : '<p style="margin:0 0 8px;font-size:0.85rem;">Pickup OTP <strong>' +
              escCommerce(co.pickupOtp || '—') +
              '</strong> · Delivery OTP <strong>' +
              escCommerce(co.deliveryOtp || '—') +
              '</strong>' +
              (co.agentPhone ? ' · Agent ' + escCommerce(co.agentPhone) : '') +
              '</p>') +
        (co.commerceProvider === 'shipday' && co.agentPhone ? '<p style="margin:0 0 8px;font-size:0.85rem;">Agent ' + escCommerce(co.agentPhone) + '</p>' : '');
    if (co.commerceTrackUrl) {
        inner += '<p style="margin:0 0 8px;font-size:0.82rem;"><a href="' + escCommerce(co.commerceTrackUrl) + '" target="_blank" rel="noopener">Public tracking link</a></p>';
    }
    if (data.timeline && window.TrackTimeline) {
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

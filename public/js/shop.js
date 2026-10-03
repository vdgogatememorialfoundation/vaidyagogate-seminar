let shopUser = null;
let shopCatalog = null;
let shopCart = [];
let shopAddresses = [];
let razorpayMethod = null;

function shopEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function loadShopUser() {
    try {
        shopUser = JSON.parse(localStorage.getItem('seminar_doctor_user') || 'null');
    } catch (_) {
        shopUser = null;
    }
}

async function shopLogin() {
    const msg = document.getElementById('login-msg');
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: document.getElementById('login-email').value,
                password: document.getElementById('login-password').value,
                portal: 'doctor'
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');
        shopUser = data.user || data;
        localStorage.setItem('seminar_doctor_user', JSON.stringify(shopUser));
        document.getElementById('shop-login').classList.add('hidden');
        shopShow('catalog');
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

function shopShow(name) {
    document.getElementById('view-catalog').classList.toggle('hidden', name !== 'catalog');
    document.getElementById('view-account').classList.toggle('hidden', name !== 'account');
    document.getElementById('view-order').classList.toggle('hidden', name !== 'order');
    if (!shopUser && name !== 'catalog') {
        document.getElementById('shop-login').classList.remove('hidden');
        return;
    }
    document.getElementById('shop-login').classList.add('hidden');
    if (name === 'account') renderAccount();
    if (name === 'catalog') renderCatalog();
}

async function bootShop() {
    loadShopUser();
    const res = await fetch('/api/shop/catalog');
    shopCatalog = await res.json();
    const store = (shopCatalog && shopCatalog.store) || {};
    document.getElementById('store-name').textContent = store.name || 'Book shop';
    const settings = (shopCatalog && shopCatalog.settings) || {};
    document.getElementById('shop-hours').textContent =
        'Orders ' +
        (settings.orderOpen || '') +
        '–' +
        (settings.orderClose || '') +
        ' IST · Pickup ' +
        (settings.pickupOpen || '') +
        '–' +
        (settings.pickupClose || '') +
        ' · Delivery ' +
        (settings.deliveryOpen || '') +
        '–' +
        (settings.deliveryClose || '') +
        (shopCatalog && shopCatalog.open ? '' : ' · ' + (shopCatalog.closedMessage || 'Closed'));
    const pay = await fetch('/api/shop/pay-options').then((r) => r.json());
    razorpayMethod = pay.razorpay || null;
    renderCatalog();
}

function renderCatalog() {
    const root = document.getElementById('view-catalog');
    const books = (shopCatalog && shopCatalog.books) || [];
    const langs = (shopCatalog && shopCatalog.languages) || ['english'];
    root.innerHTML =
        '<div class="grid">' +
        books
            .map(
                (b) =>
                    '<div class="card"><h3>' +
                    shopEsc(b.title) +
                    '</h3><p class="muted">' +
                    shopEsc(b.author || '') +
                    '</p><p><strong>₹' +
                    shopEsc(b.price) +
                    '</strong></p><label>Language<select id="lang-' +
                    shopEsc(b.id) +
                    '">' +
                    langs.map((l) => '<option value="' + l + '">' + l + '</option>').join('') +
                    '</select></label><button class="primary" style="margin-top:8px;" onclick="shopAdd(\'' +
                    shopEsc(b.id) +
                    '\')">Add to cart</button></div>'
            )
            .join('') +
        '</div>' +
        '<div class="card" style="margin-top:14px;"><h3>Cart</h3><div id="cart-body"></div></div>';
    renderCart();
}

function shopAdd(bookId) {
    const book = (shopCatalog.books || []).find((b) => b.id === bookId);
    const lang = document.getElementById('lang-' + bookId).value;
    shopCart.push({ bookId, language: lang, qty: 1, title: book.title, price: book.price });
    renderCart();
}

function renderCart() {
    const body = document.getElementById('cart-body');
    if (!body) return;
    if (!shopCart.length) {
        body.innerHTML = '<p class="muted">Your cart is empty.</p>';
        return;
    }
    const total = shopCart.reduce((sum, line) => sum + Number(line.price) * line.qty, 0);
    const settings = shopCatalog.settings || {};
    body.innerHTML =
        shopCart
            .map(
                (line, i) =>
                    '<p>' +
                    shopEsc(line.title) +
                    ' · ' +
                    shopEsc(line.language) +
                    ' · ₹' +
                    shopEsc(line.price) +
                    ' <button type="button" onclick="shopCart.splice(' +
                    i +
                    ',1);renderCart()">Remove</button></p>'
            )
            .join('') +
        '<p><strong>₹' +
        total.toFixed(0) +
        '</strong></p>' +
        '<label>How to receive<select id="cart-fulfillment"><option value="delivery">Home delivery</option>' +
        (settings.storePickupEnabled !== false ? '<option value="pickup">Store pickup</option>' : '') +
        '</select></label>' +
        '<label>Payment<select id="cart-method">' +
        (settings.razorpayEnabled !== false ? '<option value="razorpay">Razorpay</option>' : '') +
        (settings.codEnabled !== false ? '<option value="cod">Cash on delivery</option>' : '') +
        '<option value="store">Pay at store</option></select></label>' +
        '<div id="cart-address"></div>' +
        '<button class="primary" style="margin-top:10px;" onclick="shopCheckout()">Place order</button>' +
        '<p id="checkout-msg"></p>';
    loadAddressPicker();
}

async function loadAddressPicker() {
    const box = document.getElementById('cart-address');
    if (!box || !shopUser) {
        if (box) box.innerHTML = '<p class="muted">Sign in from Account to choose an address.</p>';
        return;
    }
    const res = await fetch('/api/shop/addresses?userId=' + encodeURIComponent(shopUser.id));
    const data = await res.json();
    shopAddresses = data.addresses || [];
    box.innerHTML =
        '<label>Delivery address<select id="cart-address-id">' +
        shopAddresses
            .map(
                (a) =>
                    '<option value="' +
                    a.id +
                    '">' +
                    shopEsc(a.recipientName) +
                    ', ' +
                    shopEsc(a.line1) +
                    ', ' +
                    shopEsc(a.city) +
                    '</option>'
            )
            .join('') +
        '</select></label>';
}

async function shopCheckout() {
    const msg = document.getElementById('checkout-msg');
    if (!shopUser) {
        shopShow('account');
        return;
    }
    try {
        const res = await fetch('/api/shop/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-acting-user-id': String(shopUser.id) },
            body: JSON.stringify({
                userId: shopUser.id,
                items: shopCart.map((l) => ({ bookId: l.bookId, language: l.language, qty: l.qty })),
                fulfillment: document.getElementById('cart-fulfillment').value,
                method: document.getElementById('cart-method').value,
                addressId: document.getElementById('cart-address-id') ? document.getElementById('cart-address-id').value : null
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not place the order');
        if (data.needsPayment) {
            await payRazorpay(data.bookOrderId);
        }
        shopCart = [];
        if (msg) msg.textContent = 'Order ' + data.orderCode + ' placed.';
        openShopOrder(data.bookOrderId);
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

async function payRazorpay(bookOrderId) {
    if (!razorpayMethod) throw new Error('Razorpay is not configured in payment gateways.');
    const res = await fetch('/api/payments/process-book-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookOrderId, userId: shopUser.id, methodId: razorpayMethod.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Payment could not start');
    if (data.paid) return;
    const rzOrder = data.razorpayOrder;
    if (!rzOrder || !window.Razorpay) throw new Error(data.message || 'Razorpay checkout is unavailable');
    await new Promise((resolve, reject) => {
        const checkout = new Razorpay({
            key: data.keyId,
            amount: rzOrder.amount,
            currency: rzOrder.currency || 'INR',
            order_id: rzOrder.id,
            name: (shopCatalog.store && shopCatalog.store.name) || 'Book shop',
            handler: function () {
                resolve();
            },
            modal: { ondismiss: function () { reject(new Error('Payment was closed.')); } }
        });
        checkout.open();
    });
}

async function renderAccount() {
    const root = document.getElementById('view-account');
    if (!shopUser) {
        document.getElementById('shop-login').classList.remove('hidden');
        root.innerHTML = '';
        return;
    }
    const [ordersRes, addrRes] = await Promise.all([
        fetch('/api/shop/orders?userId=' + encodeURIComponent(shopUser.id)),
        fetch('/api/shop/addresses?userId=' + encodeURIComponent(shopUser.id))
    ]);
    const orders = (await ordersRes.json()).orders || [];
    const addresses = (await addrRes.json()).addresses || [];
    root.innerHTML =
        '<div class="nav"><button class="primary" type="button" onclick="shopAccountTab(\'orders\')">My orders</button><button class="primary" type="button" style="background:#0369a1;" onclick="shopAccountTab(\'address\')">Address</button></div>' +
        '<div id="account-orders" class="card">' +
        (orders
            .map(
                (o) =>
                    '<p><button type="button" onclick="openShopOrder(' +
                    o.id +
                    ')">' +
                    shopEsc(o.orderCode) +
                    '</button> · ' +
                    shopEsc(o.commerceStage || o.status) +
                    (o.returnStatus ? ' · Return ' + shopEsc(o.returnStatus) : '') +
                    '</p>'
            )
            .join('') || '<p class="muted">No orders yet.</p>') +
        '</div>' +
        '<div id="account-address" class="card hidden"><h3>Saved addresses</h3>' +
        addresses
            .map((a) => '<p>' + shopEsc(a.recipientName) + ', ' + shopEsc(a.line1) + ', ' + shopEsc(a.city) + ' ' + shopEsc(a.pincode) + '</p>')
            .join('') +
        '<h3>Add address</h3><label>Name<input id="addr-name"></label><label>Phone<input id="addr-phone"></label><label>Address<input id="addr-line"></label><label>City<input id="addr-city"></label><label>State<input id="addr-state"></label><label>Pincode<input id="addr-pin"></label><button class="primary" style="margin-top:8px;" onclick="shopSaveAddress()">Save address</button><p id="addr-msg"></p></div>';
}

function shopAccountTab(name) {
    document.getElementById('account-orders').classList.toggle('hidden', name !== 'orders');
    document.getElementById('account-address').classList.toggle('hidden', name !== 'address');
}

async function shopSaveAddress() {
    const res = await fetch('/api/shop/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: shopUser.id,
            recipientName: document.getElementById('addr-name').value,
            phone: document.getElementById('addr-phone').value,
            line1: document.getElementById('addr-line').value,
            city: document.getElementById('addr-city').value,
            state: document.getElementById('addr-state').value,
            pincode: document.getElementById('addr-pin').value
        })
    });
    const data = await res.json();
    document.getElementById('addr-msg').textContent = data.error || 'Address saved.';
    if (res.ok) renderAccount();
}

async function openShopOrder(id) {
    shopShow('order');
    const root = document.getElementById('view-order');
    const res = await fetch('/api/shop/orders/' + id + '?userId=' + encodeURIComponent(shopUser.id));
    const data = await res.json();
    if (!res.ok) {
        root.innerHTML = '<p>' + shopEsc(data.error || 'Order not found') + '</p>';
        return;
    }
    const o = data.order;
    const line = (ev) =>
        '<div style="padding:8px 0;border-top:1px solid #e2e8f0;"><strong>' +
        shopEsc(ev.title || ev.description) +
        '</strong><div class="muted">' +
        shopEsc(ev.at || '') +
        (ev.city ? ' · ' + shopEsc(ev.city) : '') +
        (ev.detail ? ' · ' + shopEsc(ev.detail) : '') +
        '</div></div>';
    root.innerHTML =
        '<div class="card"><h2>' +
        shopEsc(o.orderCode) +
        '</h2><p>' +
        shopEsc(o.commerceStage || o.status) +
        ' · ' +
        shopEsc(o.paymentMode) +
        ' · ' +
        shopEsc(o.fulfillmentType) +
        '</p>' +
        (o.deliveryOtp ? '<p>Delivery OTP <span class="otp">' + shopEsc(o.deliveryOtp) + '</span></p>' : '') +
        (o.agentPhone ? '<p>Agent ' + shopEsc(o.agentName || '') + ' · ' + shopEsc(o.agentPhone) + '</p>' : '') +
        (o.commerceTrackUrl ? '<p><a href="' + shopEsc(o.commerceTrackUrl) + '">Open live map tracking</a></p>' : '') +
        '<h3>Shipment</h3>' +
        ((data.events || []).map(line).join('') || '<p class="muted">Waiting for the first scan.</p>') +
        '<h3>Return shipment</h3><p>' +
        shopEsc(o.returnKind || 'No return') +
        ' · ' +
        shopEsc(o.returnStatus || '') +
        (o.returnAgentPhone ? ' · Agent ' + shopEsc(o.returnAgentPhone) : '') +
        '</p>' +
        ((data.returnEvents || []).map(line).join('') || '<p class="muted">No return scans yet.</p>') +
        '<label>Request<select id="return-kind"><option value="return">Return</option><option value="replacement">Replacement</option></select></label>' +
        '<label>Reason<textarea id="return-reason"></textarea></label>' +
        '<button class="primary" onclick="shopRequestReturn(' +
        o.id +
        ')">Submit return</button><p id="return-msg"></p></div>';
}

async function shopRequestReturn(id) {
    const res = await fetch('/api/shop/orders/' + id + '/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: shopUser.id,
            kind: document.getElementById('return-kind').value,
            reason: document.getElementById('return-reason').value
        })
    });
    const data = await res.json();
    document.getElementById('return-msg').textContent = data.error || 'Return requested. Tracking updates will show on this screen.';
    if (res.ok) setTimeout(() => openShopOrder(id), 400);
}

bootShop();

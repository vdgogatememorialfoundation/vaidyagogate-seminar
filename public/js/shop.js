let shopUser = null;
let shopCatalog = null;
let shopCart = [];
let shopAddresses = [];
let razorpayMethod = null;
let shopSearchTerm = '';
let shopPending = null;
let orderPoll = null;
let checkoutState = { fulfillment: 'delivery', method: '', addressId: null, showForm: false };
let accountTab = 'orders';
let orderFilter = 'all';
let accountOrders = [];
let shopTrackerSeen = false;

const COVER_COLORS = [
    ['#0b3d2e', '#1f7a4d'],
    ['#4a1d6a', '#8e44ad'],
    ['#7a2e0e', '#d35400'],
    ['#12355b', '#2b79c2'],
    ['#5b1228', '#c0392b']
];

function shopEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function money(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function parseWhen(at) {
    if (!at) return null;
    let v = String(at);
    if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function when(at, withTime) {
    const d = parseWhen(at);
    if (!d) return at ? String(at) : '';
    const opts = { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
    if (withTime !== false) {
        opts.hour = '2-digit';
        opts.minute = '2-digit';
    }
    return new Intl.DateTimeFormat('en-IN', opts).format(d);
}

function coverColors(id) {
    let h = 0;
    String(id || '').split('').forEach((c) => {
        h = (h * 31 + c.charCodeAt(0)) >>> 0;
    });
    return COVER_COLORS[h % COVER_COLORS.length];
}

function coverBg(id) {
    const c = coverColors(id);
    return 'background:linear-gradient(135deg,' + c[0] + ',' + c[1] + ')';
}

function miniCover(item) {
    return '<div class="mini" style="' + coverBg(item.bookId) + '">' + shopEsc(item.title) + '</div>';
}

function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
}

function loadShopUser() {
    try {
        shopUser = JSON.parse(localStorage.getItem('seminar_doctor_user') || 'null');
    } catch (_) {
        shopUser = null;
    }
    try {
        shopCart = JSON.parse(localStorage.getItem('shop_cart') || '[]') || [];
    } catch (_) {
        shopCart = [];
    }
}

function saveCart() {
    localStorage.setItem('shop_cart', JSON.stringify(shopCart));
    const n = shopCart.reduce((s, l) => s + l.qty, 0);
    document.getElementById('cart-count').textContent = n;
}

function userQuery() {
    return 'userId=' + encodeURIComponent(shopUser ? shopUser.id : '');
}

function updateHello() {
    const name = shopUser ? shopUser.firstName || shopUser.first_name || shopUser.name || 'there' : null;
    document.getElementById('hello-line').textContent = name ? 'Hello, ' + name : 'Hello, sign in';
}

/* ---------- routing ---------- */

function shopGo(view, arg) {
    let hash = '#/';
    if (view === 'checkout') hash = '#/checkout';
    else if (view === 'account') hash = '#/account/' + (arg || 'orders');
    else if (view === 'order') hash = '#/order/' + arg;
    if (location.hash === hash) route();
    else location.hash = hash;
}

function stopPolling() {
    if (orderPoll) clearInterval(orderPoll);
    orderPoll = null;
}

function showView(name) {
    ['home', 'checkout', 'login', 'account', 'order'].forEach((v) => {
        document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
    });
    window.scrollTo(0, 0);
}

function route() {
    stopPolling();
    closeCartDrawer();
    const hash = location.hash || '#/';
    const needsLogin = /^#\/(checkout|account|order)/.test(hash);
    if (needsLogin && !shopUser) {
        shopPending = hash;
        renderLogin();
        return;
    }
    let m;
    if (hash === '#/checkout') return renderCheckout();
    if ((m = hash.match(/^#\/account\/(\w+)/))) {
        accountTab = m[1] === 'address' ? 'address' : 'orders';
        return renderAccount();
    }
    if ((m = hash.match(/^#\/order\/(\d+)/))) return openShopOrder(parseInt(m[1], 10));
    renderHome();
}

function shopSearch(e) {
    e.preventDefault();
    shopSearchTerm = document.getElementById('shop-search').value.trim().toLowerCase();
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else renderHome();
}

/* ---------- sign in ---------- */

function renderLogin() {
    showView('login');
    document.getElementById('view-login').innerHTML =
        '<div class="box signin"><h2>Sign in</h2>' +
        '<p class="muted">Use your Vaidya Gogate portal account. Your orders, addresses and tracking are linked to it.</p>' +
        '<label class="field">Email or portal ID<input id="login-email" autocomplete="username"></label>' +
        '<label class="field">Password<input id="login-password" type="password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')shopLogin()"></label>' +
        '<button class="btn" type="button" onclick="shopLogin()">Sign in</button><p id="login-msg" class="msg"></p></div>';
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
        updateHello();
        const target = shopPending || '#/';
        shopPending = null;
        if (location.hash === target) route();
        else location.hash = target;
    } catch (e) {
        if (msg) msg.textContent = e.message;
    }
}

function shopSignOut() {
    localStorage.removeItem('seminar_doctor_user');
    shopUser = null;
    updateHello();
    shopGo('home');
}

/* ---------- boot ---------- */

async function bootShop() {
    loadShopUser();
    updateHello();
    saveCart();
    const res = await fetch('/api/shop/catalog');
    shopCatalog = await res.json();
    const store = shopCatalog.store || {};
    const s = shopCatalog.settings || {};
    document.getElementById('store-name').textContent = store.name || 'Book shop';
    document.title = (store.name || 'Book shop') + ' - Online book shop';
    document.getElementById('shop-hours').textContent =
        'Orders ' + (s.orderOpen || '') + ' - ' + (s.orderClose || '') + ' IST';
    if (!shopCatalog.open) {
        const b = document.getElementById('closed-banner');
        b.textContent = shopCatalog.closedMessage || 'The shop is currently closed.';
        b.classList.remove('hidden');
    }
    document.getElementById('shop-footer').innerHTML =
        '<b>' + shopEsc(store.name || 'Book shop') + '</b><br>' +
        shopEsc([store.address, store.city].filter(Boolean).join(', ')) +
        (store.phone ? '<br>Call <a href="tel:' + shopEsc(store.phone) + '" style="color:#fff">' + shopEsc(store.phone) + '</a>' : '') +
        '<br><span style="opacity:.7">Pickup ' + shopEsc(s.pickupOpen || '') + ' - ' + shopEsc(s.pickupClose || '') +
        ' · Delivery ' + shopEsc(s.deliveryOpen || '') + ' - ' + shopEsc(s.deliveryClose || '') + '</span>';
    try {
        const pay = await fetch('/api/shop/pay-options').then((r) => r.json());
        razorpayMethod = pay.razorpay || null;
    } catch (_) {
        razorpayMethod = null;
    }
    window.addEventListener('hashchange', route);
    route();
}

/* ---------- home ---------- */

function renderHome() {
    showView('home');
    const s = shopCatalog.settings || {};
    const langs = shopCatalog.languages || ['english'];
    let books = shopCatalog.books || [];
    if (shopSearchTerm) {
        books = books.filter((b) => (b.title + ' ' + (b.author || '')).toLowerCase().includes(shopSearchTerm));
    }
    const badges = [];
    if (s.razorpayEnabled !== false) badges.push('Secure online payment');
    if (s.codEnabled !== false) badges.push('Cash on delivery');
    if (s.storePickupEnabled !== false) badges.push('Free store pickup');
    if (s.returnsEnabled !== false) badges.push('Easy returns');
    badges.push('Live order tracking');
    document.getElementById('view-home').innerHTML =
        '<div class="hero"><div><h1>Authentic Ayurveda texts</h1><p>Books by Dr. R.B. Gogate in English, Marathi, Hindi and Kannada, delivered to your door or ready for pickup.</p></div>' +
        '<div class="hero-badges">' + badges.map((b) => '<span>' + shopEsc(b) + '</span>').join('') + '</div></div>' +
        '<div class="section-title">' + (shopSearchTerm ? 'Results for "' + shopEsc(shopSearchTerm) + '"' : 'All books') + '</div>' +
        (books.length
            ? '<div class="product-grid">' +
              books
                  .map((b) => {
                      const id = shopEsc(b.id);
                      return (
                          '<div class="product"><div class="cover" style="' + coverBg(b.id) + '">' +
                          '<div class="c-title">' + shopEsc(b.title) + '</div><div class="c-author">' + shopEsc(b.author || '') + '</div><div class="c-mark">॥</div></div>' +
                          '<h3>' + shopEsc(b.title) + '</h3><div class="by">by ' + shopEsc(b.author || '') + '</div>' +
                          '<div class="price"><sup>₹</sup>' + shopEsc(Number(b.price).toLocaleString('en-IN')) + '</div>' +
                          '<div>' +
                          (s.storePickupEnabled !== false ? '<span class="badge">Store pickup</span>' : '') +
                          (s.codEnabled !== false ? '<span class="badge">COD</span>' : '') +
                          '</div>' +
                          '<div class="pill-row" id="langs-' + id + '">' +
                          langs.map((l, i) => '<button type="button" class="pill' + (i === 0 ? ' on' : '') + '" data-lang="' + shopEsc(l) + '" onclick="pickLang(\'' + id + '\',this)">' + shopEsc(l) + '</button>').join('') +
                          '</div>' +
                          '<div class="qty"><label class="muted" for="qty-' + id + '">Qty:</label><select id="qty-' + id + '">' +
                          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => '<option>' + n + '</option>').join('') + '</select></div>' +
                          '<button class="btn" type="button" onclick="shopAdd(\'' + id + '\')">Add to cart</button>' +
                          '<button class="btn buy" type="button" onclick="shopAdd(\'' + id + '\',true)">Buy now</button></div>'
                      );
                  })
                  .join('') +
              '</div>'
            : '<div class="box empty">No books match your search.</div>');
}

function pickLang(bookId, btn) {
    document.querySelectorAll('#langs-' + bookId + ' .pill').forEach((p) => p.classList.remove('on'));
    btn.classList.add('on');
}

function shopAdd(bookId, buyNow) {
    const book = (shopCatalog.books || []).find((b) => b.id === bookId);
    if (!book) return;
    const pill = document.querySelector('#langs-' + bookId + ' .pill.on');
    const lang = pill ? pill.getAttribute('data-lang') : 'english';
    const qty = parseInt(document.getElementById('qty-' + bookId).value, 10) || 1;
    const hit = shopCart.find((l) => l.bookId === bookId && l.language === lang);
    if (hit) hit.qty = Math.min(20, hit.qty + qty);
    else shopCart.push({ bookId, language: lang, qty, title: book.title, price: book.price });
    saveCart();
    if (buyNow) return shopGo('checkout');
    openCartDrawer();
}

/* ---------- cart drawer ---------- */

function cartTotal() {
    return shopCart.reduce((sum, l) => sum + Number(l.price) * l.qty, 0);
}

function openCartDrawer() {
    document.getElementById('drawer-mask').classList.remove('hidden');
    document.getElementById('cart-drawer').classList.remove('hidden');
    renderDrawer();
}

function closeCartDrawer() {
    document.getElementById('drawer-mask').classList.add('hidden');
    document.getElementById('cart-drawer').classList.add('hidden');
}

function cartQty(i, v) {
    const qty = parseInt(v, 10);
    if (qty <= 0) shopCart.splice(i, 1);
    else shopCart[i].qty = qty;
    saveCart();
    renderDrawer();
    if (location.hash === '#/checkout') renderCheckout();
}

function renderDrawer() {
    const body = document.getElementById('drawer-body');
    const foot = document.getElementById('drawer-foot');
    if (!shopCart.length) {
        body.innerHTML = '<div class="empty">Your cart is empty.<br><br><button class="btn sm" type="button" onclick="closeCartDrawer();shopGo(\'home\')">Browse books</button></div>';
        foot.innerHTML = '';
        return;
    }
    body.innerHTML = shopCart
        .map(
            (l, i) =>
                '<div class="cart-line"><div class="mini" style="' + coverBg(l.bookId) + '">' + shopEsc(l.title) + '</div><div class="info"><b>' + shopEsc(l.title) +
                '</b><div class="muted" style="text-transform:capitalize">' + shopEsc(l.language) + '</div><div><b>' + money(l.price) + '</b></div>' +
                '<div class="qty" style="margin-top:6px"><select onchange="cartQty(' + i + ',this.value)">' +
                [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => '<option value="' + n + '"' + (n === l.qty ? ' selected' : '') + '>' + (n === 0 ? '0 (remove)' : n) + '</option>').join('') +
                '</select> <a onclick="cartQty(' + i + ',0)" style="cursor:pointer">Delete</a></div></div></div>'
        )
        .join('');
    const count = shopCart.reduce((s, l) => s + l.qty, 0);
    foot.innerHTML =
        '<div class="sub-total"><span>Subtotal (' + count + ' item' + (count === 1 ? '' : 's') + ')</span><b>' + money(cartTotal()) + '</b></div>' +
        '<button class="btn buy" type="button" onclick="closeCartDrawer();shopGo(\'checkout\')">Proceed to checkout</button>';
}

/* ---------- checkout ---------- */

function paymentOptions() {
    const s = shopCatalog.settings || {};
    const out = [];
    if (s.razorpayEnabled !== false) out.push({ id: 'razorpay', label: 'Pay online (Razorpay)', hint: 'UPI, cards, net banking, wallets' });
    if (checkoutState.fulfillment === 'delivery' && s.codEnabled !== false) {
        out.push({ id: 'cod', label: 'Cash on delivery', hint: Number(s.codExtraCharge) ? 'Extra charge ' + money(s.codExtraCharge) : 'Pay the delivery agent in cash' });
    }
    if (checkoutState.fulfillment === 'pickup') out.push({ id: 'store', label: 'Pay at store', hint: 'Pay when you collect your books' });
    return out;
}

async function renderCheckout() {
    showView('checkout');
    const root = document.getElementById('view-checkout');
    if (!shopCart.length) {
        root.innerHTML = '<div class="box empty">Your cart is empty.<br><br><button class="btn sm" onclick="shopGo(\'home\')">Browse books</button></div>';
        return;
    }
    const s = shopCatalog.settings || {};
    if (checkoutState.fulfillment === 'pickup' && s.storePickupEnabled === false) checkoutState.fulfillment = 'delivery';
    if (checkoutState.fulfillment === 'delivery' && s.deliveryEnabled === false) checkoutState.fulfillment = 'pickup';
    const res = await fetch('/api/shop/addresses?' + userQuery());
    shopAddresses = ((await res.json()).addresses || []);
    if (!shopAddresses.find((a) => String(a.id) === String(checkoutState.addressId))) {
        checkoutState.addressId = shopAddresses.length ? shopAddresses[0].id : null;
    }
    const opts = paymentOptions();
    if (!opts.find((o) => o.id === checkoutState.method)) checkoutState.method = opts.length ? opts[0].id : '';
    const delivery = checkoutState.fulfillment === 'delivery';
    const cod = checkoutState.method === 'cod' ? Number(s.codExtraCharge) || 0 : 0;
    const total = cartTotal() + cod;
    const store = shopCatalog.store || {};

    const fulfillBox =
        '<div class="box"><div class="step-h"><i>1</i>How would you like to receive your books?</div>' +
        (s.deliveryEnabled !== false
            ? '<label class="choice' + (delivery ? ' on' : '') + '"><input type="radio" name="ful" ' + (delivery ? 'checked' : '') + ' onchange="setFulfillment(\'delivery\')"><div><b>Home delivery</b><div class="muted">Courier or hyperlocal delivery with live tracking</div></div></label>'
            : '') +
        (s.storePickupEnabled !== false
            ? '<label class="choice' + (!delivery ? ' on' : '') + '"><input type="radio" name="ful" ' + (!delivery ? 'checked' : '') + ' onchange="setFulfillment(\'pickup\')"><div><b>Store pickup</b><div class="muted">' + shopEsc([store.address, store.city].filter(Boolean).join(', ') || 'Collect from the store counter') + '</div></div></label>'
            : '') +
        '</div>';

    const addrBox = delivery
        ? '<div class="box"><div class="step-h"><i>2</i>Delivery address</div>' +
          shopAddresses
              .map(
                  (a) =>
                      '<label class="choice' + (String(a.id) === String(checkoutState.addressId) ? ' on' : '') + '"><input type="radio" name="addr" ' + (String(a.id) === String(checkoutState.addressId) ? 'checked' : '') + ' onchange="setAddress(' + a.id + ')"><div><b>' + shopEsc(a.recipientName) + '</b> · ' + shopEsc(a.phone) +
                      '<div class="muted">' + shopEsc(a.line1) + ', ' + shopEsc(a.city) + ', ' + shopEsc(a.state) + ' ' + shopEsc(a.pincode) + '</div></div></label>'
              )
              .join('') +
          (checkoutState.showForm || !shopAddresses.length ? addressForm('checkout') : '<a style="cursor:pointer" onclick="checkoutState.showForm=true;renderCheckout()">+ Add a new address</a>') +
          '</div>'
        : '';

    const slots = delivery && s.slotsEnabled !== false ? (shopCatalog.deliverySlots || []) : [];
    if (slots.length && !slots.find((x) => checkoutState.slot && x.date === checkoutState.slot.date && x.start === checkoutState.slot.start)) checkoutState.slot = null;
    const slotBox = slots.length
        ? '<div class="box"><div class="step-h"><i>' + (delivery ? '2b' : 2) + '</i>Preferred delivery time <span class="muted" style="font-weight:400;font-size:.85rem;">(optional)</span></div>' +
          '<div class="slot-grid">' +
          slots.map((x, i) => '<label class="slot' + (checkoutState.slot && x.date === checkoutState.slot.date && x.start === checkoutState.slot.start ? ' on' : '') + '"><input type="radio" name="slot" ' + (checkoutState.slot && x.date === checkoutState.slot.date && x.start === checkoutState.slot.start ? 'checked' : '') + ' onchange="setSlot(' + i + ')"><span>' + shopEsc(x.label || x.date + ' ' + x.start + '–' + x.end) + '</span></label>').join('') +
          '</div><p class="muted" style="margin:8px 0 0;font-size:.82rem;">Estimated from seller packing and transit times for your area; the courier may confirm a different date.</p></div>'
        : '';
    const payBox =
        slotBox +
        '<div class="box"><div class="step-h"><i>' + (delivery ? 3 : 2) + '</i>Payment method</div>' +
        opts
            .map(
                (o) =>
                    '<label class="choice' + (o.id === checkoutState.method ? ' on' : '') + '"><input type="radio" name="pay" ' + (o.id === checkoutState.method ? 'checked' : '') + ' onchange="setMethod(\'' + o.id + '\')"><div><b>' + shopEsc(o.label) + '</b><div class="muted">' + shopEsc(o.hint) + '</div></div></label>'
            )
            .join('') +
        '</div>';

    const reviewBox =
        '<div class="box"><div class="step-h"><i>' + (delivery ? 4 : 3) + '</i>Review items</div>' +
        shopCart
            .map(
                (l, i) =>
                    '<div class="item-line"><div class="mini" style="' + coverBg(l.bookId) + '">' + shopEsc(l.title) + '</div><div style="flex:1"><b>' + shopEsc(l.title) + '</b><div class="muted" style="text-transform:capitalize">' + shopEsc(l.language) +
                    '</div><div class="qty" style="margin-top:4px"><select onchange="cartQty(' + i + ',this.value)">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => '<option value="' + n + '"' + (n === l.qty ? ' selected' : '') + '>' + (n === 0 ? '0 (remove)' : n) + '</option>').join('') + '</select></div></div><b>' + money(l.price * l.qty) + '</b></div>'
            )
            .join('') +
        '</div>';

    const summary =
        '<div class="box" style="position:sticky;top:76px"><button class="btn buy" id="place-btn" type="button" onclick="shopCheckout()"' + (shopCatalog.open ? '' : ' disabled') + '>Place your order</button>' +
        '<h3 style="margin-top:14px">Order summary</h3>' +
        '<div class="sum-row"><span>Items</span><span>' + money(cartTotal()) + '</span></div>' +
        (cod ? '<div class="sum-row"><span>COD charge</span><span>' + money(cod) + '</span></div>' : '') +
        '<div class="sum-row total"><span>Order total</span><span>' + money(total) + '</span></div>' +
        '<p id="checkout-msg" class="msg"></p>' +
        (shopCatalog.open ? '' : '<p class="msg">' + shopEsc(shopCatalog.closedMessage || 'The shop is closed.') + '</p>') +
        '</div>';

    root.innerHTML = '<div class="section-title">Checkout</div><div class="layout-2"><div>' + fulfillBox + addrBox + payBox + reviewBox + '</div><div>' + summary + '</div></div>';
}

function addressForm(ctx) {
    return (
        '<div style="margin-top:12px;border-top:1px solid #eee;padding-top:12px"><b>New address</b>' +
        '<div class="grid-2"><label class="field">Full name<input id="addr-name"></label><label class="field">Mobile number<input id="addr-phone" inputmode="tel"></label></div>' +
        '<label class="field">Address (house, street, area)<input id="addr-line"></label>' +
        '<div class="grid-2"><label class="field">City<input id="addr-city"></label><label class="field">State<input id="addr-state"></label></div>' +
        '<label class="field" style="max-width:200px">PIN code<input id="addr-pin" inputmode="numeric" maxlength="6"></label>' +
        '<button class="btn sm" type="button" onclick="shopSaveAddress(\'' + ctx + '\')">Save address</button> <span id="addr-msg" class="msg"></span></div>'
    );
}

function setFulfillment(v) {
    checkoutState.fulfillment = v;
    renderCheckout();
}
function setAddress(id) {
    checkoutState.addressId = id;
    renderCheckout();
}
function setSlot(i) {
    const x = (shopCatalog.deliverySlots || [])[i];
    checkoutState.slot = x ? { date: x.date, start: x.start, end: x.end } : null;
    renderCheckout();
}
function setMethod(v) {
    checkoutState.method = v;
    renderCheckout();
}

async function shopSaveAddress(ctx) {
    const get = (id) => document.getElementById(id).value;
    const res = await fetch('/api/shop/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: shopUser.id,
            recipientName: get('addr-name'),
            phone: get('addr-phone'),
            line1: get('addr-line'),
            city: get('addr-city'),
            state: get('addr-state'),
            pincode: get('addr-pin')
        })
    });
    const data = await res.json();
    if (!res.ok) {
        document.getElementById('addr-msg').textContent = data.error || 'Could not save the address.';
        return;
    }
    toast('Address saved');
    if (ctx === 'checkout') {
        checkoutState.addressId = data.id;
        checkoutState.showForm = false;
        renderCheckout();
    } else {
        renderAccount();
    }
}

async function shopDeleteAddress(id) {
    if (!confirm('Delete this address?')) return;
    await fetch('/api/shop/addresses/' + id + '?' + userQuery(), { method: 'DELETE' });
    renderAccount();
}

async function shopCheckout() {
    const msg = document.getElementById('checkout-msg');
    const btn = document.getElementById('place-btn');
    msg.textContent = '';
    const delivery = checkoutState.fulfillment === 'delivery';
    if (delivery && !checkoutState.addressId) {
        msg.textContent = 'Add a delivery address first.';
        return;
    }
    btn.disabled = true;
    try {
        const res = await fetch('/api/shop/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-acting-user-id': String(shopUser.id) },
            body: JSON.stringify({
                userId: shopUser.id,
                items: shopCart.map((l) => ({ bookId: l.bookId, language: l.language, qty: l.qty })),
                fulfillment: checkoutState.fulfillment,
                method: checkoutState.method,
                addressId: delivery ? checkoutState.addressId : null,
                deliverySlot: delivery ? checkoutState.slot || null : null
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not place the order');
        shopCart = [];
        saveCart();
        if (data.needsPayment) {
            try {
                await payRazorpay(data.bookOrderId);
                toast('Payment received');
            } catch (e) {
                toast(e.message + ' You can complete the payment from your order.');
            }
        } else {
            toast('Order ' + data.orderCode + ' placed');
        }
        shopGo('order', data.bookOrderId);
    } catch (e) {
        msg.textContent = e.message;
        btn.disabled = false;
    }
}

async function payRazorpay(bookOrderId) {
    if (!razorpayMethod) throw new Error('Online payment is not configured.');
    const res = await fetch('/api/payments/process-book-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookOrderId, userId: shopUser.id, methodId: razorpayMethod.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Payment could not start');
    if (data.paid) return;
    const rzOrder = data.razorpayOrder;
    if (!rzOrder || !window.Razorpay) throw new Error(data.message || 'Razorpay checkout is unavailable.');
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
            modal: {
                ondismiss: function () {
                    reject(new Error('Payment was not completed.'));
                }
            }
        });
        checkout.open();
    });
}

async function payPending(id) {
    try {
        await payRazorpay(id);
        toast('Payment received');
    } catch (e) {
        toast(e.message);
    }
    openShopOrder(id);
}

/* ---------- account ---------- */

function orderStatusText(o) {
    if (o.status === 'cancelled') return { text: 'Cancelled', tone: 'red' };
    if (o.status === 'pending_payment') return { text: 'Payment pending', tone: 'red' };
    if (o.status === 'delivered' || o.status === 'fulfilled' || o.commerceStage === 'delivered') {
        return { text: o.fulfillmentType === 'pickup' ? 'Collected' : 'Delivered', tone: 'green' };
    }
    const pickup = o.fulfillmentType === 'pickup';
    const map = {
        placed: 'Order placed',
        accepted: 'Order accepted',
        preparing: 'Preparing your order',
        ready: pickup ? 'Ready for pickup' : 'Packed - ready to ship',
        pickup_scheduled: 'Courier pickup scheduled',
        in_transit: 'Shipped - in transit',
        out_for_delivery: 'Out for delivery'
    };
    return { text: map[o.commerceStage] || 'Order placed', tone: '' };
}

function payLabel(o) {
    if (o.paymentMode === 'cod') return 'Cash on delivery';
    if (o.paymentMode === 'counter') return 'Pay at store';
    return o.status === 'pending_payment' ? 'Online - unpaid' : 'Paid online';
}

function orderCardHtml(o) {
    const st = orderStatusText(o);
    const ret = o.returnStatus ? '<div class="badge warn" style="margin-top:6px">' + shopEsc(o.returnKind || 'return') + ': ' + shopEsc(String(o.returnStatus).replace(/_/g, ' ')) + '</div>' : '';
    return (
        '<div class="order-card" onclick="shopGo(\'order\',' + o.id + ')">' +
        '<div class="order-head"><div>ORDER PLACED<b>' + shopEsc(when(o.createdAt, false)) + '</b></div><div>TOTAL<b>' + money(o.totalAmount) + '</b></div>' +
        '<div>' + (o.fulfillmentType === 'pickup' ? 'COLLECT FROM' : 'SHIP TO') + '<b>' + shopEsc(o.fulfillmentType === 'pickup' ? 'Store' : o.shippingRecipientName || 'You') + '</b></div>' +
        '<div class="right">ORDER # ' + shopEsc(o.orderCode) + '<b style="color:#007185">View order details</b></div></div>' +
        '<div class="order-body"><div class="order-items"><div class="order-status ' + st.tone + '">' + shopEsc(st.text) + '</div>' +
        (o.items || [])
            .map((it) => '<div class="order-item">' + miniCover(it) + '<div><b>' + shopEsc(it.title) + '</b><div class="muted" style="text-transform:capitalize">' + shopEsc(it.language) + ' · Qty ' + shopEsc(it.qty) + '</div></div></div>')
            .join('') +
        ret + '</div><div class="order-actions" onclick="event.stopPropagation()">' +
        (o.status === 'pending_payment'
            ? '<button class="btn" type="button" onclick="payPending(' + o.id + ')">Complete payment</button>'
            : '<button class="btn" type="button" onclick="shopGo(\'order\',' + o.id + ')">Track package</button>') +
        '<button class="btn ghost" type="button" onclick="shopGo(\'order\',' + o.id + ')">View order details</button></div></div></div>'
    );
}

function filterOrders(list) {
    if (orderFilter === 'open') return list.filter((o) => !['cancelled'].includes(o.status) && !(o.status === 'delivered' || o.status === 'fulfilled' || o.commerceStage === 'delivered'));
    if (orderFilter === 'delivered') return list.filter((o) => o.status === 'delivered' || o.status === 'fulfilled' || o.commerceStage === 'delivered');
    if (orderFilter === 'returns') return list.filter((o) => o.returnStatus);
    return list;
}

function setOrderFilter(f) {
    orderFilter = f;
    renderOrdersList();
}

function renderOrdersList() {
    const el = document.getElementById('orders-list');
    if (!el) return;
    document.querySelectorAll('#order-filters .pill').forEach((p) => p.classList.toggle('on', p.getAttribute('data-f') === orderFilter));
    const list = filterOrders(accountOrders);
    el.innerHTML = list.length ? list.map(orderCardHtml).join('') : '<div class="box empty">No orders to show.</div>';
}

async function renderAccount() {
    showView('account');
    const root = document.getElementById('view-account');
    root.innerHTML = '<div class="box empty">Loading...</div>';
    const [ordersRes, addrRes] = await Promise.all([
        fetch('/api/shop/orders?' + userQuery()),
        fetch('/api/shop/addresses?' + userQuery())
    ]);
    accountOrders = (await ordersRes.json()).orders || [];
    shopAddresses = (await addrRes.json()).addresses || [];
    const name = [shopUser.firstName || shopUser.first_name, shopUser.lastName || shopUser.last_name].filter(Boolean).join(' ') || shopUser.name || 'Your account';
    root.innerHTML =
        '<div class="track-head" style="margin-bottom:8px"><div class="section-title" style="margin:0">' + shopEsc(name) + '</div><button class="btn ghost sm" type="button" onclick="shopSignOut()">Sign out</button></div>' +
        '<div class="tabs"><button type="button" class="' + (accountTab === 'orders' ? 'on' : '') + '" onclick="shopGo(\'account\',\'orders\')">Your orders</button>' +
        '<button type="button" class="' + (accountTab === 'address' ? 'on' : '') + '" onclick="shopGo(\'account\',\'address\')">Your addresses</button></div>' +
        (accountTab === 'orders'
            ? '<div class="filter-row" id="order-filters">' +
              [['all', 'All orders'], ['open', 'In progress'], ['delivered', 'Delivered'], ['returns', 'Returns & replacements']]
                  .map((f) => '<button type="button" class="pill" data-f="' + f[0] + '" onclick="setOrderFilter(\'' + f[0] + '\')">' + f[1] + '</button>')
                  .join('') +
              '</div><div id="orders-list"></div>'
            : '<div class="layout-2"><div>' +
              (shopAddresses
                  .map(
                      (a) =>
                          '<div class="box"><b>' + shopEsc(a.recipientName) + '</b><div>' + shopEsc(a.line1) + '</div><div>' + shopEsc(a.city) + ', ' + shopEsc(a.state) + ' ' + shopEsc(a.pincode) +
                          '</div><div class="muted">Phone: ' + shopEsc(a.phone) + '</div><div style="margin-top:8px"><a style="cursor:pointer" onclick="shopDeleteAddress(' + a.id + ')">Delete</a></div></div>'
                  )
                  .join('') || '<div class="box empty">No saved addresses yet.</div>') +
              '</div><div class="box"><h3>Add a new address</h3>' + addressForm('account') + '</div></div>');
    if (accountTab === 'orders') renderOrdersList();
}

/* ---------- order tracking ---------- */

function termOrder(data) {
    const t = data.timeline || {};
    return t.cancelled || (t.steps && t.steps[t.steps.length - 1].state === 'done');
}

function returnHtml(data) {
    const r = data.returnView;
    if (r && data.returnTrack && window.ShipTrack) {
        const url = data.order && data.order.returnTrackUrl;
        return '<div class="box ret-box" style="padding:0;overflow:hidden;"><div id="shop-return-track"></div></div>' +
            (url ? '<div class="box"><a href="' + shopEsc(url) + '" target="_blank" rel="noopener">Shareable ' + (r.kind === 'replacement' ? 'replacement' : 'return') + ' tracking link</a></div>' : '');
    }
    if (r) {
        const provName = r.provider ? r.provider.charAt(0).toUpperCase() + r.provider.slice(1) : '';
        return (
            '<div class="box ret-box"><div class="ret-head"><h3>' + (r.kind === 'replacement' ? 'Replacement' : 'Return') + ' tracking</h3>' +
            '<span class="badge ' + (r.status === 'rejected' ? 'red' : r.status === 'refunded' || r.status === 'replacement_delivered' ? 'ok' : 'warn') + '">' + shopEsc(r.statusLabel) + '</span></div>' +
            (r.reason ? '<div class="muted ret-reason">Reason: ' + shopEsc(r.reason) + '</div>' : '') +
            (r.status === 'rejected'
                ? '<p class="msg">This request was declined. Contact the store for help.</p>'
                : '<ol class="ret-list">' + r.steps.map((s) => '<li class="' + s.state + '"><span class="ret-dot"></span><span>' + shopEsc(s.title) + '</span>' +
                      (s.key === 'pickup_scheduled' && r.scheduledAt && s.state !== 'upcoming' ? '<small>' + shopEsc(when(r.scheduledAt)) + '</small>' : '') + '</li>').join('') + '</ol>') +
            (provName || r.trackingLink
                ? '<div class="ret-courier">' + (provName ? '<span>Pickup / return via <b>' + shopEsc(provName) + '</b></span>' : '') +
                  (r.trackingLink ? '<a class="btn sm ghost" href="' + shopEsc(r.trackingLink) + '" target="_blank" rel="noopener">Track return shipment</a>' : '') + '</div>'
                : '') +
            (r.agent || r.pickupOtp
                ? '<div class="agent-card">' +
                  (r.agent ? '<div><div class="lbl">Pickup agent</div><div class="val">' + shopEsc(r.agent.name || '') + ' <a href="tel:' + shopEsc(r.agent.phone) + '">' + shopEsc(r.agent.phone) + '</a></div></div>' : '') +
                  (r.pickupOtp ? '<div class="otp-box"><div class="lbl">Return pickup OTP</div><div class="code">' + shopEsc(r.pickupOtp) + '</div></div>' : '') +
                  '</div>'
                : '') +
            (r.updates && r.updates.length ? '<div class="ret-updates"><div class="lbl">Updates</div>' + TrackTimeline.updates(r.updates) + '</div>' : '') + '</div>'
        );
    }
    if (!data.canReturn) return '';
    const opt = data.returnOptions;
    return (
        '<div class="box"><h3>Return or replace items</h3><p class="muted">Eligible within ' + shopEsc(opt.windowDays) + ' days of ordering. Progress will appear on this page.</p>' +
        '<label class="field">Request<select id="return-kind">' + (opt.returns ? '<option value="return">Return for refund</option>' : '') + (opt.replacements ? '<option value="replacement">Replacement</option>' : '') + '</select></label>' +
        '<label class="field">Reason<textarea id="return-reason" rows="3"></textarea></label>' +
        '<button class="btn sm" type="button" onclick="shopRequestReturn(' + data.order.id + ')">Submit request</button><p id="return-msg" class="msg"></p></div>'
    );
}

function renderOrderDetail(data) {
    const root = document.getElementById('view-order');
    const o = data.order;
    const t = data.timeline;
    const lastStep = t.steps[t.steps.length - 1];
    let headline;
    if (t.cancelled) headline = 'Cancelled';
    else if (o.status === 'pending_payment') headline = 'Payment pending';
    else if (t.operational === 'DELIVERY_ATTEMPT_FAILED' || t.operational === 'RESCHEDULED') headline = t.headline;
    else if (lastStep.state === 'done') headline = lastStep.title;
    else headline = 'Next: ' + t.headline;
    const tone = t.cancelled || o.status === 'pending_payment' ? 'red' : '';
    const ship = o.shipTo || {};
    root.innerHTML =
        '<div class="crumb"><a onclick="shopGo(\'account\',\'orders\')">Your orders</a> &rsaquo; Order ' + shopEsc(o.orderCode) + '</div>' +
        '<div class="layout-2"><div><div class="box"><div class="track-head"><div><h1>Track package</h1><div class="muted">Order # ' + shopEsc(o.orderCode) + ' · Placed ' + shopEsc(when(o.createdAt, false)) + '</div></div>' +
        '<span class="eta-chip' + (tone ? ' ' + tone : '') + '">' + shopEsc(headline) + '</span></div>' +
        (o.status === 'pending_payment' ? '<p><button class="btn sm buy" type="button" onclick="payPending(' + o.id + ')">Complete payment</button></p>' : '') +
        '<div style="height:14px"></div>' + (data.track && window.ShipTrack ? '<div id="shop-order-track"></div>' : TrackTimeline.render({ timeline: data.timeline, live: data.live, awbTrackUrl: o.awbTrackUrl, trackUrl: o.trackUrl }, { animate: !shopTrackerSeen })) + '</div>' + returnHtml(data) + '</div>' +
        '<div><div class="box"><h3>Order summary</h3>' +
        (o.items || []).map((it) => '<div class="item-line">' + miniCover(it) + '<div style="flex:1"><b>' + shopEsc(it.title) + '</b><div class="muted" style="text-transform:capitalize">' + shopEsc(it.language) + ' · Qty ' + shopEsc(it.qty) + '</div></div><b>' + money(it.lineTotal) + '</b></div>').join('') +
        '<div class="sum-row total"><span>Total</span><span>' + money(o.totalAmount) + '</span></div><div class="muted">' + shopEsc(payLabel(o)) + '</div></div>' +
        '<div class="box"><h3>' + (o.fulfillmentType === 'pickup' ? 'Pickup' : 'Shipping address') + '</h3>' +
        (o.fulfillmentType === 'pickup'
            ? '<div>' + shopEsc((shopCatalog.store || {}).name || 'Store') + '</div><div class="muted">' + shopEsc([(shopCatalog.store || {}).address, (shopCatalog.store || {}).city].filter(Boolean).join(', ')) + '</div>'
            : '<b>' + shopEsc(ship.name || '') + '</b><div>' + shopEsc(ship.address || '') + '</div><div>' + shopEsc([ship.city, ship.state].filter(Boolean).join(', ')) + ' ' + shopEsc(ship.pincode || '') + '</div><div class="muted">Phone: ' + shopEsc(ship.phone || '') + '</div>') +
        '</div>' +
        (o.trackUrl ? '<div class="box"><a href="' + shopEsc(o.trackUrl) + '" target="_blank" rel="noopener">Shareable tracking link</a></div>' : '') +
        '</div></div>';
    shopTrackerSeen = true;
    if (window.ShipTrack) {
        window.ShipTrack.draw(document.getElementById('shop-order-track'), data.track, o);
        window.ShipTrack.draw(document.getElementById('shop-return-track'), data.returnTrack, o);
    }
    TrackTimeline.mount(data.live);
}

async function fetchOrder(id) {
    const res = await fetch('/api/shop/orders/' + id + '?' + userQuery());
    const data = await res.json();
    return { ok: res.ok, data };
}

async function openShopOrder(id) {
    showView('order');
    shopTrackerSeen = false;
    const root = document.getElementById('view-order');
    root.innerHTML = '<div class="box empty">Loading tracking...</div>';
    const { ok, data } = await fetchOrder(id);
    if (!ok) {
        root.innerHTML = '<div class="box empty">' + shopEsc(data.error || 'Order not found') + '</div>';
        return;
    }
    renderOrderDetail(data);
    if (!termOrder(data) || data.returnView) {
        orderPoll = setInterval(async () => {
            if (document.getElementById('view-order').classList.contains('hidden')) return stopPolling();
            try {
                const r = await fetchOrder(id);
                if (r.ok) {
                    renderOrderDetail(r.data);
                    if (termOrder(r.data) && !r.data.returnView) stopPolling();
                }
            } catch (_) {}
        }, 15000);
    }
}

async function shopRequestReturn(id) {
    const msg = document.getElementById('return-msg');
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
    if (!res.ok) {
        msg.textContent = data.error || 'Could not submit the request.';
        return;
    }
    toast('Request submitted');
    openShopOrder(id);
}

bootShop();

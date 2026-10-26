/* Retail POS — staff counter sales + admin retail management (/pos, /admin/pos). */
(function () {
    const STAFF_KEY = 'seminar_staff_user';
    const ADMIN_KEY = 'admin_user';
    const isAdminPath = location.pathname.indexOf('/admin/pos') === 0;
    let user = null;
    let catalog = null;
    let cart = [];
    let lang = '';
    let customer = { userId: null, name: '', phone: '', email: '' };
    let fulfil = 'pickup';
    let payMode = 'cash';
    let quote = null;
    let view = 'sale';

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = (n) => '₹' + (Number(n) || 0).toFixed(2);
    const FULFIL_LABEL = { pickup: 'Store pickup', hyperlocal: 'Hyperlocal delivery', courier: 'Courier' };
    const PAY_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', razorpay: 'Razorpay', wallet: 'Wallet' };

    function loadUser() {
        try {
            const a = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
            const s = JSON.parse(localStorage.getItem(STAFF_KEY) || 'null');
            user = (isAdminPath ? a || s : s || a) || null;
        } catch (_) {
            user = null;
        }
    }
    function headers() {
        return { 'Content-Type': 'application/json', 'X-Acting-User-Id': user ? String(user.id) : '' };
    }
    async function api(url, opts) {
        const res = await fetch(url, Object.assign({ headers: headers(), credentials: 'same-origin' }, opts || {}));
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            data = { error: 'Unexpected response' };
        }
        if (res.status === 401) {
            showLogin(data.error || 'Sign in required');
            throw new Error(data.error || 'Sign in required');
        }
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }
    function msg(t, ok) {
        const el = $('pos-msg');
        if (!el) return;
        el.style.color = ok ? '#15803d' : '#b91c1c';
        el.textContent = t || '';
    }

    /* ---------- auth ---------- */
    function showLogin(text) {
        $('pos-login').classList.remove('hidden');
        $('pos-sale').classList.add('hidden');
        $('pos-tools').classList.add('hidden');
        $('pos-admin').classList.add('hidden');
        $('pos-nav').innerHTML = '';
        $('pos-actor').textContent = '';
        if (text) $('pos-login-msg').textContent = text;
    }
    $('pos-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const m = $('pos-login-msg');
        m.textContent = 'Signing in…';
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: $('pos-login-email').value.trim(), password: $('pos-login-password').value, portal: 'staff' })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Login failed');
            user = data.user;
            localStorage.setItem(STAFF_KEY, JSON.stringify(user));
            m.textContent = '';
            boot();
        } catch (err) {
            m.textContent = err.message;
        }
    });
    $('pos-logout').addEventListener('click', () => {
        localStorage.removeItem(STAFF_KEY);
        user = null;
        showLogin('');
    });

    /* ---------- boot ---------- */
    async function boot() {
        loadUser();
        if (!user) return showLogin('');
        try {
            catalog = await api('/api/pos/retail/catalog');
        } catch (e) {
            return;
        }
        $('pos-login').classList.add('hidden');
        $('pos-actor').textContent = catalog.actor.name + (catalog.actor.isAdmin ? ' · Admin' : ' · Staff');
        $('pos-title').textContent = isAdminPath || catalog.actor.isAdmin ? 'Main admin POS' : 'Store POS';
        renderNav();
        setView(isAdminPath && catalog.actor.isAdmin ? 'admin' : 'sale');
    }
    function renderNav() {
        const items = [['sale', 'Sale'], ['tools', 'Gift cards & wallet'], ['recent', 'My sales']];
        if (catalog.actor.isAdmin) items.push(['admin', 'Admin: discounts · vouchers · gift cards · loyalty · reports']);
        $('pos-nav').innerHTML = items.map(([k, l]) => '<button type="button" data-v="' + k + '" class="' + (view === k ? 'active' : '') + '">' + esc(l) + '</button>').join('');
        $('pos-nav').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setView(b.getAttribute('data-v'))));
    }
    function setView(v) {
        view = v;
        renderNav();
        $('pos-sale').classList.toggle('hidden', v !== 'sale' && v !== 'recent');
        $('pos-tools').classList.toggle('hidden', v !== 'tools');
        $('pos-admin').classList.toggle('hidden', v !== 'admin');
        if (v === 'sale') {
            renderLangs();
            renderGrid();
            renderFulfil();
            renderPay();
            renderCart();
            loadRecent();
        }
        if (v === 'recent') {
            loadRecent();
            $('pos-recent-card').scrollIntoView({ behavior: 'smooth' });
        }
        if (v === 'tools') renderTools();
        if (v === 'admin') renderAdmin('settings');
    }

    /* ---------- products ---------- */
    function renderLangs() {
        const langs = catalog.languages || [];
        $('pos-langs').innerHTML =
            '<button type="button" class="' + (lang ? '' : 'active') + '" data-l="">All languages</button>' +
            langs.map((l) => '<button type="button" class="' + (lang === l.id ? 'active' : '') + '" data-l="' + esc(l.id) + '">' + esc(l.label) + '</button>').join('');
        $('pos-langs').querySelectorAll('button').forEach((b) =>
            b.addEventListener('click', () => {
                lang = b.getAttribute('data-l');
                renderLangs();
                renderGrid();
            })
        );
    }
    function tiles() {
        const q = $('pos-q').value.trim().toLowerCase();
        const out = [];
        (catalog.books || []).forEach((b) => {
            (catalog.languages || []).forEach((l) => {
                if (lang && l.id !== lang) return;
                const stock = catalog.stock && catalog.stock[b.id] ? catalog.stock[b.id][l.id] : null;
                const hay = (b.title + ' ' + (b.author || '') + ' ' + b.id + ' ' + l.label).toLowerCase();
                if (q && hay.indexOf(q) < 0) return;
                out.push({ book: b, lang: l, stock });
            });
        });
        return out;
    }
    function renderGrid() {
        const list = tiles();
        $('pos-grid').innerHTML = list.length
            ? list
                  .map(
                      (t, i) =>
                          '<button type="button" class="pos-tile ' + (t.stock != null && t.stock <= 0 ? 'oos' : '') + '" data-i="' + i + '"><b>' +
                          esc(t.book.title) +
                          '</b><small>' +
                          esc(t.lang.label) +
                          (t.book.author ? ' · ' + esc(t.book.author) : '') +
                          '</small><span class="price">' +
                          money(t.book.price) +
                          '</span><small>' +
                          (t.stock == null ? 'Stock: n/a' : 'Stock: ' + t.stock) +
                          '</small></button>'
                  )
                  .join('')
            : '<p class="pos-muted">No products match. Admin manages products &amp; prices under Book sales.</p>';
        $('pos-grid').querySelectorAll('.pos-tile').forEach((el) => el.addEventListener('click', () => addLine(list[Number(el.getAttribute('data-i'))])));
    }
    $('pos-q').addEventListener('input', renderGrid);
    $('pos-q').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const list = tiles();
            if (list.length) addLine(list[0]);
            $('pos-q').value = '';
            renderGrid();
        }
    });
    function addLine(t) {
        if (!t) return;
        const hit = cart.find((c) => c.bookId === t.book.id && c.language === t.lang.id);
        if (hit) hit.qty += 1;
        else cart.push({ bookId: t.book.id, language: t.lang.id, title: t.book.title, langLabel: t.lang.label, price: Number(t.book.price), qty: 1 });
        renderCart();
    }
    function renderCart() {
        const el = $('pos-cart');
        if (!cart.length) {
            el.innerHTML = '<p class="pos-muted">Tap products to add.</p>';
            quote = null;
            renderTotals();
            return;
        }
        el.innerHTML = cart
            .map(
                (c, i) =>
                    '<div class="line"><div><b>' + esc(c.title) + '</b><br><small>' + esc(c.langLabel) + ' · ' + money(c.price) + '</small></div>' +
                    '<div class="qty"><button type="button" data-d="-1" data-i="' + i + '">−</button><input type="number" min="1" max="99" value="' + c.qty + '" data-i="' + i + '"><button type="button" data-d="1" data-i="' + i + '">+</button></div>' +
                    '<div><b>' + money(c.price * c.qty) + '</b><br><button type="button" class="pos-btn small danger" data-rm="' + i + '">Remove</button></div></div>'
            )
            .join('');
        el.querySelectorAll('button[data-d]').forEach((b) =>
            b.addEventListener('click', () => {
                const c = cart[Number(b.getAttribute('data-i'))];
                c.qty = Math.max(1, Math.min(99, c.qty + Number(b.getAttribute('data-d'))));
                renderCart();
            })
        );
        el.querySelectorAll('input[data-i]').forEach((inp) =>
            inp.addEventListener('change', () => {
                cart[Number(inp.getAttribute('data-i'))].qty = Math.max(1, Math.min(99, parseInt(inp.value, 10) || 1));
                renderCart();
            })
        );
        el.querySelectorAll('button[data-rm]').forEach((b) =>
            b.addEventListener('click', () => {
                cart.splice(Number(b.getAttribute('data-rm')), 1);
                renderCart();
            })
        );
        posRequote();
    }

    /* ---------- customer ---------- */
    let custTimer = null;
    $('pos-cust-q').addEventListener('input', () => {
        clearTimeout(custTimer);
        const q = $('pos-cust-q').value.trim();
        if (q.length < 2) {
            $('pos-cust-results').innerHTML = '';
            return;
        }
        custTimer = setTimeout(async () => {
            try {
                const d = await api('/api/pos/retail/customers?q=' + encodeURIComponent(q));
                $('pos-cust-results').innerHTML = (d.customers || []).length
                    ? d.customers
                          .map(
                              (c, i) =>
                                  '<button type="button" data-i="' + i + '"><b>' + esc(c.name || '(no name)') + '</b> ' +
                                  (c.account ? '<span class="pill ok">' + esc(c.userIdString || 'account') + '</span>' : '<span class="pill">walk-in</span>') +
                                  '<br><small>' + esc(c.phone || '') + ' ' + esc(c.email || '') + ' · wallet ' + money(c.walletBalance) + ' · ' + (c.loyaltyPoints || 0) + ' pts</small></button>'
                          )
                          .join('')
                    : '<p class="pos-muted">No match — fill the fields below to add a walk-in customer.</p>';
                $('pos-cust-results').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => pickCustomer(d.customers[Number(b.getAttribute('data-i'))])));
            } catch (_) {}
        }, 250);
    });
    function pickCustomer(c) {
        customer = { userId: c.userId || null, name: c.name || '', phone: c.phone || '', email: c.email || '' };
        $('pos-cust-name').value = customer.name;
        $('pos-cust-phone').value = customer.phone;
        $('pos-cust-email').value = customer.email;
        $('pos-cust-results').innerHTML = '';
        $('pos-cust-q').value = '';
        loadCustomerSummary();
        posRequote();
    }
    ['pos-cust-name', 'pos-cust-phone', 'pos-cust-email'].forEach((id) =>
        $(id).addEventListener('change', () => {
            customer.userId = null;
            customer.name = $('pos-cust-name').value.trim();
            customer.phone = $('pos-cust-phone').value.trim();
            customer.email = $('pos-cust-email').value.trim();
            loadCustomerSummary();
            posRequote();
        })
    );
    async function loadCustomerSummary() {
        const el = $('pos-cust-summary');
        if (!customer.userId && !customer.phone && !customer.email) {
            el.innerHTML = '';
            return;
        }
        try {
            const qs = customer.userId ? 'userId=' + customer.userId : customer.phone ? 'phone=' + encodeURIComponent(customer.phone) : 'email=' + encodeURIComponent(customer.email);
            const d = await api('/api/pos/retail/customer-summary?' + qs);
            el.innerHTML =
                '<span><i class="fas fa-wallet"></i> Wallet ' + money(d.walletBalance) + '</span><span><i class="fas fa-star"></i> ' + (d.loyaltyPoints || 0) + ' points</span><span><i class="fas fa-box"></i> ' + (d.recentOrders || []).length + ' recent orders</span>';
        } catch (_) {
            el.innerHTML = '';
        }
    }

    /* ---------- fulfilment / payment ---------- */
    function renderFulfil() {
        const types = (catalog.settings.fulfillmentTypes || ['pickup']).filter((t) => FULFIL_LABEL[t]);
        if (!types.includes(fulfil)) fulfil = types[0] || 'pickup';
        $('pos-fulfil').innerHTML = types.map((t) => '<button type="button" data-f="' + t + '" class="' + (fulfil === t ? 'active' : '') + '">' + FULFIL_LABEL[t] + (t === 'courier' && catalog.courierCharge ? ' (' + money(catalog.courierCharge) + ')' : '') + '</button>').join('');
        $('pos-fulfil').querySelectorAll('button').forEach((b) =>
            b.addEventListener('click', () => {
                fulfil = b.getAttribute('data-f');
                renderFulfil();
                posRequote();
            })
        );
        $('pos-address').classList.toggle('hidden', fulfil === 'pickup');
        if (fulfil !== 'pickup') {
            if (!$('pos-addr-recipient').value) $('pos-addr-recipient').value = customer.name || '';
            if (!$('pos-addr-phone').value) $('pos-addr-phone').value = customer.phone || '';
        }
    }
    function renderPay() {
        const modes = (catalog.settings.paymentModes || ['cash']).filter((m) => PAY_LABEL[m] && (m !== 'razorpay' || catalog.settings.razorpayMethodId));
        if (!modes.includes(payMode)) payMode = modes[0] || 'cash';
        $('pos-paymodes').innerHTML = modes.map((m) => '<button type="button" data-p="' + m + '" class="' + (payMode === m ? 'active' : '') + '">' + PAY_LABEL[m] + '</button>').join('');
        $('pos-paymodes').querySelectorAll('button').forEach((b) =>
            b.addEventListener('click', () => {
                payMode = b.getAttribute('data-p');
                if (payMode === 'wallet' && quote) $('pos-wallet-amt').value = Math.min(quote.walletBalance, quote.grandTotal - quote.giftCardAmount);
                renderPay();
                posRequote();
            })
        );
    }

    /* ---------- quote ---------- */
    function quoteBody() {
        return {
            items: cart.map((c) => ({ bookId: c.bookId, language: c.language, qty: c.qty })),
            customer,
            fulfillment: fulfil,
            shippingOverride: $('pos-ship-override').value,
            voucherCode: $('pos-voucher').value.trim(),
            manualDiscount: $('pos-manual-disc').value,
            giftCardCode: $('pos-giftcard').value.trim(),
            giftCardAmount: $('pos-giftcard-amt').value,
            loyaltyPoints: $('pos-loyalty-pts').value,
            walletAmount: $('pos-wallet-amt').value,
            paymentMode: payMode,
            note: $('pos-note').value,
            address: {
                recipient: $('pos-addr-recipient').value,
                phone: $('pos-addr-phone').value,
                line1: $('pos-addr-line1').value,
                city: $('pos-addr-city').value,
                state: $('pos-addr-state').value,
                pincode: $('pos-addr-pin').value
            }
        };
    }
    let quoteSeq = 0;
    window.posRequote = async function () {
        if (!cart.length) {
            quote = null;
            renderTotals();
            return;
        }
        const seq = ++quoteSeq;
        try {
            const d = await api('/api/pos/retail/quote', { method: 'POST', body: JSON.stringify(quoteBody()) });
            if (seq !== quoteSeq) return;
            quote = d.quote;
            msg('');
        } catch (e) {
            msg(e.message);
        }
        renderTotals();
    };
    function renderTotals() {
        const el = $('pos-totals');
        if (!quote) {
            el.innerHTML = '';
            $('pos-charge').textContent = 'Charge';
            return;
        }
        const rows = [['Subtotal', money(quote.subtotal)]];
        if (quote.manualDiscount) rows.push(['Discount', '− ' + money(quote.manualDiscount)]);
        if (quote.voucherDiscount) rows.push(['Voucher ' + quote.voucher.code, '− ' + money(quote.voucherDiscount)]);
        if (quote.loyaltyDiscount) rows.push([quote.loyaltyPointsUsed + ' points', '− ' + money(quote.loyaltyDiscount)]);
        if (quote.shipping) rows.push([FULFIL_LABEL[quote.fulfillment] + ' charge', money(quote.shipping)]);
        rows.push(['Total', money(quote.grandTotal), 'grand']);
        if (quote.giftCardAmount) rows.push(['Gift card ' + quote.giftCard.code + ' (bal ' + money(quote.giftCard.balance) + ')', '− ' + money(quote.giftCardAmount)]);
        if (quote.walletAmount) rows.push(['Wallet (bal ' + money(quote.walletBalance) + ')', '− ' + money(quote.walletAmount)]);
        if (quote.prepaid) rows.push(['Due now', money(quote.dueAmount), 'grand']);
        if (quote.loyaltyPointsEarned) rows.push(['Points earned on this bill', '+' + quote.loyaltyPointsEarned]);
        if (quote.loyaltyBalance) rows.push(['Customer points available', String(quote.loyaltyBalance)]);
        el.innerHTML = rows.map((r) => '<div class="' + (r[2] || '') + '"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join('') + (quote.warnings || []).map((w) => '<div class="warn"><i class="fas fa-exclamation-triangle"></i>&nbsp;' + esc(w) + '</div>').join('');
        $('pos-charge').textContent = quote.dueAmount > 0 ? 'Charge ' + money(quote.dueAmount) + ' · ' + PAY_LABEL[payMode] : 'Complete sale (fully prepaid)';
    }

    /* ---------- checkout ---------- */
    window.posClear = function () {
        cart = [];
        quote = null;
        customer = { userId: null, name: '', phone: '', email: '' };
        ['pos-cust-name', 'pos-cust-phone', 'pos-cust-email', 'pos-voucher', 'pos-manual-disc', 'pos-giftcard', 'pos-giftcard-amt', 'pos-loyalty-pts', 'pos-wallet-amt', 'pos-note', 'pos-addr-recipient', 'pos-addr-phone', 'pos-addr-line1', 'pos-addr-city', 'pos-addr-state', 'pos-addr-pin', 'pos-ship-override'].forEach((id) => ($(id).value = ''));
        $('pos-cust-summary').innerHTML = '';
        renderCart();
        msg('');
    };
    window.posCheckout = async function () {
        if (!cart.length) return msg('Add products first');
        const btn = $('pos-charge');
        btn.disabled = true;
        msg('Processing…', true);
        try {
            const out = await api('/api/pos/retail/checkout', { method: 'POST', body: JSON.stringify(quoteBody()) });
            if (out.needsPayment) {
                await payRazorpay(out);
                const st = await api('/api/pos/retail/orders/' + out.orderId + '/status');
                if (!st.paid) throw new Error('Payment not confirmed yet. Use "My sales" to re-check or mark as paid.');
                out.order = st.order;
            }
            showReceipt(out);
            catalog = await api('/api/pos/retail/catalog');
            renderGrid();
            posClear();
            loadRecent();
        } catch (e) {
            msg(e.message);
        }
        btn.disabled = false;
    };
    async function payRazorpay(out) {
        const data = await api('/api/pos/retail/orders/' + out.orderId + '/pay', { method: 'POST', body: JSON.stringify({ methodId: catalog.settings.razorpayMethodId }) });
        if (data.paid) return;
        const rz = data.razorpayOrder;
        if (!rz || !window.Razorpay) throw new Error(data.message || data.error || 'Razorpay checkout unavailable');
        await new Promise((resolve, reject) => {
            new Razorpay({
                key: data.keyId,
                amount: rz.amount,
                currency: rz.currency || 'INR',
                order_id: rz.id,
                name: 'Store POS',
                description: 'Order ' + out.orderCode,
                prefill: { name: customer.name || '', contact: customer.phone || '', email: customer.email || '' },
                handler: () => resolve(),
                modal: { ondismiss: () => reject(new Error('Payment window closed — order ' + out.orderCode + ' is awaiting payment.')) }
            }).open();
        });
    }
    function showReceipt(out) {
        const o = out.order || {};
        const q = out.quote || {};
        const items = (o.items || cart).map((it) => '<tr><td>' + esc(it.bookTitle || it.title || it.bookId) + ' <small>' + esc(it.language || '') + '</small></td><td>' + (it.qty || 1) + '</td><td>' + money(it.lineTotal != null ? it.lineTotal : it.price * it.qty) + '</td></tr>').join('');
        $('pos-receipt-box').innerHTML =
            '<h2 style="margin:0 0 4px"><i class="fas fa-check-circle" style="color:#15803d"></i> Sale complete</h2><p class="pos-muted">Order <b>' + esc(out.orderCode) + '</b> · ' + esc(FULFIL_LABEL[q.fulfillment] || '') + '</p>' +
            '<table class="pos-table"><tr><th>Item</th><th>Qty</th><th>Amount</th></tr>' + items + '</table>' +
            '<div class="pos-totals"><div><span>Subtotal</span><span>' + money(q.subtotal) + '</span></div>' +
            (q.discountTotal ? '<div><span>Discounts</span><span>− ' + money(q.discountTotal) + '</span></div>' : '') +
            (q.shipping ? '<div><span>Delivery</span><span>' + money(q.shipping) + '</span></div>' : '') +
            '<div class="grand"><span>Total</span><span>' + money(q.grandTotal) + '</span></div>' +
            (q.prepaid ? '<div><span>Gift card / wallet</span><span>− ' + money(q.prepaid) + '</span></div><div><span>Paid now</span><span>' + money(q.dueAmount) + '</span></div>' : '') +
            (q.loyaltyPointsEarned ? '<div><span>Loyalty points earned</span><span>+' + q.loyaltyPointsEarned + '</span></div>' : '') + '</div>' +
            '<p class="pos-muted">' + esc(catalog.settings.receiptFooter || '') + '<br>Invoice emailed to ' + esc(o.buyerEmail || customer.email || 'customer (no email)') + '. Track: ' + location.origin + esc(out.trackUrl || '') + '</p>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pos-btn primary" onclick="window.print()">Print receipt</button>' +
            '<a class="pos-btn" href="' + esc(out.trackUrl || '#') + '" target="_blank">Open tracking</a>' +
            (q.fulfillment !== 'pickup' ? '<a class="pos-btn" href="/admin" target="_blank">Schedule pickup in admin</a>' : '') +
            '<button type="button" class="pos-btn ghost" onclick="document.getElementById(\'pos-receipt\').classList.add(\'hidden\')">Close</button></div>';
        $('pos-receipt').classList.remove('hidden');
    }

    /* ---------- recent sales ---------- */
    async function loadRecent() {
        try {
            const d = await api('/api/pos/retail/sales' + (catalog.actor.isAdmin ? '' : '?mine=1'));
            $('pos-recent').innerHTML = (d.sales || []).length
                ? '<table class="pos-table"><tr><th>Order</th><th>Customer</th><th>Total</th><th>Paid via</th><th>Status</th><th></th></tr>' +
                  d.sales
                      .map(
                          (s) =>
                              '<tr><td>' + esc(s.order_code) + '<br><small>' + esc(String(s.order_at || '').slice(0, 16).replace('T', ' ')) + '</small></td><td>' + esc(s.buyer_name || '') + '<br><small>' + esc(s.buyer_phone || '') + '</small></td><td>' + money(s.total_amount) + '</td><td>' + esc(s.payment_mode || '') + '</td><td>' + esc(s.status) + '</td><td>' +
                              (s.status === 'pending_payment' ? '<button type="button" class="pos-btn small" data-paid="' + s.book_order_id + '">Mark paid (cash/UPI)</button>' : '') + '</td></tr>'
                      )
                      .join('') +
                  '</table>'
                : '<p class="pos-muted">No sales yet today.</p>';
            $('pos-recent').querySelectorAll('button[data-paid]').forEach((b) =>
                b.addEventListener('click', async () => {
                    const mode = prompt('Payment mode received (cash / upi / card):', 'cash');
                    if (!mode) return;
                    try {
                        await api('/api/pos/retail/orders/' + b.getAttribute('data-paid') + '/mark-paid', { method: 'POST', body: JSON.stringify({ paymentMode: mode }) });
                        loadRecent();
                    } catch (e) {
                        alert(e.message);
                    }
                })
            );
        } catch (_) {}
    }

    /* ---------- tools: gift cards & wallet ---------- */
    function renderTools() {
        const denoms = catalog.settings.giftCardDenominations || [];
        $('pos-tools').innerHTML =
            '<div class="pos-sale"><div class="pos-card"><h3><i class="fas fa-gift"></i> Issue gift card</h3>' +
            '<div class="pos-seg" id="gc-denoms">' + denoms.map((d) => '<button type="button" data-v="' + d + '">' + money(d) + '</button>').join('') + '</div>' +
            '<div class="pos-form" style="margin-top:10px"><input type="number" id="gc-value" placeholder="Value ₹" min="1"><input type="text" id="gc-name" placeholder="Recipient name"><input type="email" id="gc-email" placeholder="Recipient email (card is emailed)"><input type="tel" id="gc-phone" placeholder="Recipient phone"><input type="text" id="gc-notes" placeholder="Note / paid via"></div>' +
            '<button type="button" class="pos-btn primary" id="gc-issue">Issue &amp; email gift card</button><p id="gc-msg" class="pos-msg"></p>' +
            '<h4>Check balance</h4><div class="pos-inline"><input type="text" id="gc-check" placeholder="Gift card code"><button type="button" class="pos-btn" id="gc-check-btn">Check</button></div><p id="gc-check-out" class="pos-muted"></p></div>' +
            '<div class="pos-card"><h3><i class="fas fa-wallet"></i> Wallet top-up</h3><p class="pos-muted">Customer pays at the counter; the amount is credited to their store wallet and can be used on any future bill.</p>' +
            '<div class="pos-form"><input type="text" id="w-name" placeholder="Customer name"><input type="tel" id="w-phone" placeholder="Phone (wallet key)"><input type="email" id="w-email" placeholder="Email (receipt)"><input type="number" id="w-amt" placeholder="Amount ₹" min="1"><select id="w-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></div>' +
            '<button type="button" class="pos-btn primary" id="w-topup">Credit wallet</button><p id="w-msg" class="pos-msg"></p>' +
            '<h4>Check voucher</h4><div class="pos-inline"><input type="text" id="v-check" placeholder="Voucher code"><button type="button" class="pos-btn" id="v-check-btn">Check</button></div><p id="v-check-out" class="pos-muted"></p></div></div>';
        $('gc-denoms').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => ($('gc-value').value = b.getAttribute('data-v'))));
        $('gc-issue').addEventListener('click', async () => {
            const m = $('gc-msg');
            try {
                const d = await api('/api/pos/retail/gift-cards', { method: 'POST', body: JSON.stringify({ value: $('gc-value').value, recipient: { name: $('gc-name').value, email: $('gc-email').value, phone: $('gc-phone').value }, notes: $('gc-notes').value }) });
                m.style.color = '#15803d';
                m.innerHTML = 'Issued <b style="font-size:1.2rem;letter-spacing:2px">' + esc(d.card.code) + '</b> worth ' + money(d.card.value) + ($('gc-email').value ? ' — emailed to ' + esc($('gc-email').value) : '');
            } catch (e) {
                m.style.color = '#b91c1c';
                m.textContent = e.message;
            }
        });
        $('gc-check-btn').addEventListener('click', async () => {
            try {
                const d = await api('/api/pos/retail/gift-cards/' + encodeURIComponent($('gc-check').value.trim()));
                $('gc-check-out').textContent = d.card.code + ': balance ' + money(d.card.balance) + ' · ' + d.card.status + (d.card.usable ? ' · ' + d.card.usable : '') + (d.card.expiresAt ? ' · expires ' + String(d.card.expiresAt).slice(0, 10) : '');
            } catch (e) {
                $('gc-check-out').textContent = e.message;
            }
        });
        $('w-topup').addEventListener('click', async () => {
            const m = $('w-msg');
            try {
                const d = await api('/api/pos/retail/wallet/topup', { method: 'POST', body: JSON.stringify({ customer: { name: $('w-name').value, phone: $('w-phone').value, email: $('w-email').value }, amount: $('w-amt').value, paymentMode: $('w-mode').value }) });
                m.style.color = '#15803d';
                m.textContent = 'Wallet credited. New balance ' + money(d.balance);
            } catch (e) {
                m.style.color = '#b91c1c';
                m.textContent = e.message;
            }
        });
        $('v-check-btn').addEventListener('click', async () => {
            try {
                const d = await api('/api/pos/retail/vouchers/' + encodeURIComponent($('v-check').value.trim()));
                const v = d.voucher;
                $('v-check-out').textContent = v.code + ': ' + (v.kind === 'percent' ? v.value + '% off' : money(v.value) + ' off') + (v.minOrder ? ' · min ' + money(v.minOrder) : '') + (v.maxDiscount ? ' · max ' + money(v.maxDiscount) : '') + ' · ' + (v.active ? 'active' : 'inactive') + (v.endsAt ? ' · till ' + String(v.endsAt).slice(0, 10) : '');
            } catch (e) {
                $('v-check-out').textContent = e.message;
            }
        });
    }

    /* ---------- admin ---------- */
    async function renderAdmin(tab) {
        const root = $('pos-admin');
        const tabs = [['settings', 'Discounts & rules'], ['vouchers', 'Vouchers'], ['giftcards', 'Gift cards'], ['customers', 'Loyalty & wallets'], ['report', 'Sales report']];
        root.innerHTML = '<div class="pos-seg" style="margin-bottom:12px">' + tabs.map(([k, l]) => '<button type="button" data-t="' + k + '" class="' + (tab === k ? 'active' : '') + '">' + l + '</button>').join('') + '</div><div id="pos-admin-body" class="pos-card">Loading…</div>';
        root.querySelectorAll('button[data-t]').forEach((b) => b.addEventListener('click', () => renderAdmin(b.getAttribute('data-t'))));
        const body = $('pos-admin-body');
        try {
            if (tab === 'settings') return adminSettings(body);
            if (tab === 'vouchers') return adminVouchers(body);
            if (tab === 'giftcards') return adminGiftCards(body);
            if (tab === 'customers') return adminCustomers(body);
            if (tab === 'report') return adminReport(body);
        } catch (e) {
            body.innerHTML = '<p class="pos-msg">' + esc(e.message) + '</p>';
        }
    }
    async function adminSettings(body) {
        const d = await api('/api/admin/retail/settings');
        const s = d.settings;
        const chk = (k) => '<label><input type="checkbox" id="st-' + k + '" ' + (s[k] ? 'checked' : '') + ' style="width:auto"> ' + k.replace(/([A-Z])/g, ' $1').toLowerCase() + '</label>';
        const num = (k, label) => '<label>' + label + '<input type="number" step="any" id="st-' + k + '" value="' + esc(s[k] == null ? '' : s[k]) + '"></label>';
        const txt = (k, label) => '<label>' + label + '<input type="text" id="st-' + k + '" value="' + esc(Array.isArray(s[k]) ? s[k].join(',') : s[k] == null ? '' : s[k]) + '"></label>';
        body.innerHTML =
            '<h3>Discount &amp; POS rules</h3><div class="pos-form">' + num('manualDiscountMaxPct', 'Staff manual discount cap (%)') + chk('staffManualDiscount') + '</div>' +
            '<h3>Loyalty</h3><div class="pos-form">' + chk('loyaltyEnabled') + num('loyaltyEarnPerRupee', 'Points earned per ₹1 (0.01 = 1 pt / ₹100)') + num('loyaltyPointValue', '₹ value per point') + num('loyaltyMinRedeem', 'Minimum points to redeem') + num('loyaltyMaxRedeemPct', 'Max % of bill payable by points') + '</div>' +
            '<h3>Gift cards &amp; wallet</h3><div class="pos-form">' + chk('giftCardsEnabled') + txt('giftCardDenominations', 'Quick denominations (comma)') + num('giftCardValidityDays', 'Validity (days)') + chk('walletEnabled') + '</div>' +
            '<h3>Payments &amp; fulfilment</h3><div class="pos-form">' + txt('paymentModes', 'Payment modes (cash,upi,card,razorpay,wallet)') + txt('fulfillmentTypes', 'Fulfilment types (pickup,hyperlocal,courier)') + num('hyperlocalCharge', 'Hyperlocal delivery charge ₹') + num('courierCharge', 'Courier charge ₹ (blank = book-sales default)') + txt('receiptFooter', 'Receipt footer') + '</div>' +
            '<button type="button" class="pos-btn primary" id="st-save">Save settings</button> <p id="st-msg" class="pos-msg"></p><p class="pos-muted">Products, prices and stock are managed under Admin → Book sales (inventory). Shop vouchers also apply at /shop checkout when channel includes "shop".</p>';
        $('st-save').addEventListener('click', async () => {
            const out = {};
            Object.keys(s).forEach((k) => {
                const el = $('st-' + k);
                if (!el) return;
                if (el.type === 'checkbox') out[k] = el.checked;
                else if (el.type === 'number') out[k] = el.value === '' ? null : Number(el.value);
                else out[k] = el.value;
            });
            try {
                await api('/api/admin/retail/settings', { method: 'PUT', body: JSON.stringify({ settings: out }) });
                $('st-msg').style.color = '#15803d';
                $('st-msg').textContent = 'Saved';
                catalog = await api('/api/pos/retail/catalog');
            } catch (e) {
                $('st-msg').textContent = e.message;
            }
        });
    }
    async function adminVouchers(body) {
        const d = await api('/api/admin/retail/vouchers');
        body.innerHTML =
            '<h3>Create / edit voucher</h3><div class="pos-form"><input type="hidden" id="v-id"><input type="text" id="v-code" placeholder="Code (blank = auto)"><input type="text" id="v-title" placeholder="Title"><select id="v-kind"><option value="percent">% off</option><option value="flat">Flat ₹ off</option></select><input type="number" id="v-value" placeholder="Value"><input type="number" id="v-min" placeholder="Min order ₹"><input type="number" id="v-max" placeholder="Max discount ₹"><input type="number" id="v-limit" placeholder="Total uses"><input type="number" id="v-pc" placeholder="Uses per customer"><input type="date" id="v-start"><input type="date" id="v-end"><select id="v-ch"><option value="pos,shop">POS + Shop</option><option value="pos">POS only</option><option value="shop">Shop only</option></select></div>' +
            '<button type="button" class="pos-btn primary" id="v-save">Save voucher</button> <button type="button" class="pos-btn ghost" id="v-reset">Reset</button> <p id="v-msg" class="pos-msg"></p>' +
            '<table class="pos-table"><tr><th>Code</th><th>Title</th><th>Discount</th><th>Rules</th><th>Used</th><th>Window</th><th>Status</th><th></th></tr>' +
            (d.vouchers || [])
                .map(
                    (v) =>
                        '<tr><td><b>' + esc(v.code) + '</b></td><td>' + esc(v.title || '') + '</td><td>' + (v.kind === 'percent' ? v.value + '%' : money(v.value)) + '</td><td>' + (v.min_order ? 'min ' + money(v.min_order) : '') + (v.max_discount ? ' · max ' + money(v.max_discount) : '') + ' · ' + esc(v.channels || '') + '</td><td>' + (v.used_count || 0) + (v.usage_limit ? '/' + v.usage_limit : '') + '</td><td>' + esc(String(v.starts_at || '').slice(0, 10)) + ' → ' + esc(String(v.ends_at || '').slice(0, 10)) + '</td><td><span class="pill ' + (Number(v.active) ? 'ok' : 'off') + '">' + (Number(v.active) ? 'active' : 'off') + '</span></td>' +
                        '<td><button type="button" class="pos-btn small" data-edit="' + v.id + '">Edit</button> <button type="button" class="pos-btn small" data-toggle="' + v.id + '">' + (Number(v.active) ? 'Disable' : 'Enable') + '</button> <button type="button" class="pos-btn small danger" data-del="' + v.id + '">Delete</button></td></tr>'
                )
                .join('') +
            '</table>';
        const byId = {};
        (d.vouchers || []).forEach((v) => (byId[v.id] = v));
        const fill = (v) => {
            $('v-id').value = v ? v.id : '';
            $('v-code').value = v ? v.code : '';
            $('v-title').value = v ? v.title || '' : '';
            $('v-kind').value = v ? v.kind : 'percent';
            $('v-value').value = v ? v.value : '';
            $('v-min').value = v ? v.min_order || '' : '';
            $('v-max').value = v && v.max_discount != null ? v.max_discount : '';
            $('v-limit').value = v && v.usage_limit != null ? v.usage_limit : '';
            $('v-pc').value = v && v.per_customer_limit != null ? v.per_customer_limit : '';
            $('v-start').value = v && v.starts_at ? String(v.starts_at).slice(0, 10) : '';
            $('v-end').value = v && v.ends_at ? String(v.ends_at).slice(0, 10) : '';
            $('v-ch').value = v ? v.channels || 'pos,shop' : 'pos,shop';
        };
        $('v-reset').addEventListener('click', () => fill(null));
        $('v-save').addEventListener('click', async () => {
            try {
                await api('/api/admin/retail/vouchers', {
                    method: 'POST',
                    body: JSON.stringify({ id: $('v-id').value || undefined, code: $('v-code').value, title: $('v-title').value, kind: $('v-kind').value, value: $('v-value').value, minOrder: $('v-min').value, maxDiscount: $('v-max').value, usageLimit: $('v-limit').value, perCustomerLimit: $('v-pc').value, startsAt: $('v-start').value ? $('v-start').value + 'T00:00:00' : null, endsAt: $('v-end').value ? $('v-end').value + 'T23:59:59' : null, channels: $('v-ch').value, active: $('v-id').value ? Number(byId[$('v-id').value].active) : 1 })
                });
                renderAdmin('vouchers');
            } catch (e) {
                $('v-msg').textContent = e.message;
            }
        });
        body.querySelectorAll('button[data-edit]').forEach((b) => b.addEventListener('click', () => fill(byId[b.getAttribute('data-edit')])));
        body.querySelectorAll('button[data-toggle]').forEach((b) =>
            b.addEventListener('click', async () => {
                const v = byId[b.getAttribute('data-toggle')];
                await api('/api/admin/retail/vouchers', { method: 'POST', body: JSON.stringify({ id: v.id, code: v.code, title: v.title, kind: v.kind, value: v.value, minOrder: v.min_order, maxDiscount: v.max_discount, usageLimit: v.usage_limit, perCustomerLimit: v.per_customer_limit, startsAt: v.starts_at, endsAt: v.ends_at, channels: v.channels, active: Number(v.active) ? 0 : 1 }) });
                renderAdmin('vouchers');
            })
        );
        body.querySelectorAll('button[data-del]').forEach((b) =>
            b.addEventListener('click', async () => {
                if (!confirm('Delete voucher?')) return;
                await api('/api/admin/retail/vouchers/' + b.getAttribute('data-del'), { method: 'DELETE' });
                renderAdmin('vouchers');
            })
        );
    }
    async function adminGiftCards(body) {
        const d = await api('/api/admin/retail/gift-cards');
        body.innerHTML =
            '<h3>Issue gift card</h3><div class="pos-form"><input type="number" id="ag-value" placeholder="Value ₹"><input type="text" id="ag-name" placeholder="Recipient name"><input type="email" id="ag-email" placeholder="Recipient email"><input type="tel" id="ag-phone" placeholder="Phone"><input type="number" id="ag-days" placeholder="Validity days (default)"><input type="text" id="ag-notes" placeholder="Note"></div><button type="button" class="pos-btn primary" id="ag-issue">Issue</button> <p id="ag-msg" class="pos-msg"></p>' +
            '<table class="pos-table"><tr><th>Code</th><th>Recipient</th><th>Value</th><th>Balance</th><th>Status</th><th>Expires</th><th>Issued</th><th></th></tr>' +
            (d.giftCards || [])
                .map(
                    (g) =>
                        '<tr><td><b>' + esc(g.code) + '</b></td><td>' + esc(g.recipient_name || '') + '<br><small>' + esc(g.recipient_email || g.recipient_phone || '') + '</small></td><td>' + money(g.initial_value) + '</td><td>' + money(g.balance) + '</td><td><span class="pill ' + (g.status === 'active' ? 'ok' : 'off') + '">' + esc(g.status) + '</span></td><td>' + esc(String(g.expires_at || '').slice(0, 10)) + '</td><td>' + esc(String(g.created_at || '').slice(0, 10)) + '</td>' +
                        '<td><button type="button" class="pos-btn small" data-adj="' + g.id + '">Adjust ₹</button> <button type="button" class="pos-btn small" data-st="' + g.id + '" data-to="' + (g.status === 'active' ? 'blocked' : 'active') + '">' + (g.status === 'active' ? 'Block' : 'Activate') + '</button></td></tr>'
                )
                .join('') +
            '</table>';
        $('ag-issue').addEventListener('click', async () => {
            try {
                const r = await api('/api/admin/retail/gift-cards', { method: 'POST', body: JSON.stringify({ value: $('ag-value').value, recipient: { name: $('ag-name').value, email: $('ag-email').value, phone: $('ag-phone').value }, validityDays: $('ag-days').value, notes: $('ag-notes').value }) });
                alert('Issued ' + r.card.code);
                renderAdmin('giftcards');
            } catch (e) {
                $('ag-msg').textContent = e.message;
            }
        });
        body.querySelectorAll('button[data-adj]').forEach((b) =>
            b.addEventListener('click', async () => {
                const amt = prompt('Amount to add (negative to deduct):', '0');
                if (!amt || !Number(amt)) return;
                await api('/api/admin/retail/gift-cards/' + b.getAttribute('data-adj') + '/adjust', { method: 'POST', body: JSON.stringify({ amount: Number(amt), note: 'Admin adjustment' }) });
                renderAdmin('giftcards');
            })
        );
        body.querySelectorAll('button[data-st]').forEach((b) =>
            b.addEventListener('click', async () => {
                await api('/api/admin/retail/gift-cards/' + b.getAttribute('data-st') + '/adjust', { method: 'POST', body: JSON.stringify({ status: b.getAttribute('data-to') }) });
                renderAdmin('giftcards');
            })
        );
    }
    async function adminCustomers(body) {
        const d = await api('/api/admin/retail/customers');
        body.innerHTML =
            '<h3>Loyalty &amp; wallets</h3><p class="pos-muted">Points and wallet balances are keyed by account, else phone, else email.</p>' +
            '<table class="pos-table"><tr><th>Customer</th><th>Contact</th><th>Wallet</th><th>Points</th><th>POS orders</th><th></th></tr>' +
            (d.customers || [])
                .map(
                    (c) =>
                        '<tr><td><b>' + esc(c.name || '(no name)') + '</b>' + (c.user_id ? ' <span class="pill ok">account</span>' : '') + '</td><td>' + esc(c.phone || '') + '<br><small>' + esc(c.email || '') + '</small></td><td>' + money(c.wallet_balance) + '</td><td>' + Math.round(Number(c.loyalty_points) || 0) + '</td><td>' + (c.pos_orders || 0) + '</td>' +
                        '<td><button type="button" class="pos-btn small" data-w="' + esc(c.customer_key) + '">Wallet ±₹</button> <button type="button" class="pos-btn small" data-l="' + esc(c.customer_key) + '">Points ±</button> <button type="button" class="pos-btn small" data-h="' + esc(c.customer_key) + '">History</button></td></tr>'
                )
                .join('') +
            '</table><div id="ac-ledger"></div>';
        const byKey = {};
        (d.customers || []).forEach((c) => (byKey[c.customer_key] = c));
        const cust = (k) => ({ userId: byKey[k].user_id, name: byKey[k].name, phone: byKey[k].phone, email: byKey[k].email });
        body.querySelectorAll('button[data-w]').forEach((b) =>
            b.addEventListener('click', async () => {
                const amt = prompt('Wallet amount (negative to deduct):', '0');
                if (!amt || !Number(amt)) return;
                await api('/api/admin/retail/wallet/adjust', { method: 'POST', body: JSON.stringify({ customer: cust(b.getAttribute('data-w')), amount: Number(amt), note: prompt('Note', 'Admin adjustment') || 'Admin adjustment' }) });
                renderAdmin('customers');
            })
        );
        body.querySelectorAll('button[data-l]').forEach((b) =>
            b.addEventListener('click', async () => {
                const pts = prompt('Points (negative to deduct):', '0');
                if (!pts || !Number(pts)) return;
                await api('/api/admin/retail/loyalty/adjust', { method: 'POST', body: JSON.stringify({ customer: cust(b.getAttribute('data-l')), points: Number(pts), note: 'Admin adjustment' }) });
                renderAdmin('customers');
            })
        );
        body.querySelectorAll('button[data-h]').forEach((b) =>
            b.addEventListener('click', async () => {
                const l = await api('/api/admin/retail/ledger?customerKey=' + encodeURIComponent(b.getAttribute('data-h')));
                $('ac-ledger').innerHTML = '<h4>History</h4><table class="pos-table"><tr><th>When</th><th>Type</th><th>Kind</th><th>Amount / points</th><th>Order</th><th>Note</th></tr>' + (l.ledger || []).map((r) => '<tr><td>' + esc(String(r.created_at).slice(0, 16)) + '</td><td>' + esc(r.kind_group) + '</td><td>' + esc(r.kind) + '</td><td>' + esc(r.amount) + '</td><td>' + esc(r.book_order_id || '') + '</td><td>' + esc(r.note || '') + '</td></tr>').join('') + '</table>';
            })
        );
    }
    async function adminReport(body, from, to) {
        const qs = from ? '?from=' + from + '&to=' + to : '';
        const d = await api('/api/admin/retail/report' + qs);
        const t = d.totals;
        const kpi = (l, v) => '<div class="pos-kpi"><small>' + l + '</small><b>' + v + '</b></div>';
        body.innerHTML =
            '<div class="pos-inline" style="margin-bottom:10px;max-width:520px"><input type="date" id="rp-from" value="' + d.from + '"><input type="date" id="rp-to" value="' + d.to + '"><button type="button" class="pos-btn" id="rp-go">Apply</button><button type="button" class="pos-btn" id="rp-csv">CSV</button></div>' +
            '<div class="pos-kpis">' + kpi('Orders', t.orders) + kpi('Gross', money(t.gross)) + kpi('Discounts', money(t.discounts)) + kpi('Collected at POS', money(t.collected)) + kpi('Gift cards used', money(t.giftCards)) + kpi('Wallet used', money(t.wallet)) + kpi('Points issued', t.pointsIssued) + kpi('Points redeemed', t.pointsRedeemed) + '</div>' +
            '<div class="pos-row3"><div><h4>By payment mode</h4>' + Object.keys(d.byMode).map((k) => '<div>' + esc(k) + ': <b>' + money(d.byMode[k]) + '</b></div>').join('') + '</div><div><h4>By staff</h4>' + Object.keys(d.byStaff).map((k) => '<div>' + esc(k) + ': <b>' + money(d.byStaff[k]) + '</b></div>').join('') + '</div><div><h4>By fulfilment</h4>' + Object.keys(d.byFulfil).map((k) => '<div>' + esc(FULFIL_LABEL[k] || k) + ': <b>' + d.byFulfil[k] + '</b></div>').join('') + '</div></div>' +
            '<table class="pos-table"><tr><th>When</th><th>Order</th><th>Customer</th><th>Staff</th><th>Subtotal</th><th>Discounts</th><th>Prepaid</th><th>Collected</th><th>Mode</th><th>Fulfilment</th><th>Status</th></tr>' +
            (d.sales || []).map((s) => '<tr><td>' + esc(String(s.created_at).slice(0, 16)) + '</td><td>' + esc(s.order_code) + '</td><td>' + esc(s.buyer_name || '') + '</td><td>' + esc([s.staff_first, s.staff_last].filter(Boolean).join(' ')) + '</td><td>' + money(s.subtotal) + '</td><td>' + money(s.discount_total) + '</td><td>' + money(Number(s.gift_card_amount) + Number(s.wallet_amount)) + '</td><td>' + money(s.paid_amount) + '</td><td>' + esc(s.payment_mode) + '</td><td>' + esc(s.fulfillment) + '</td><td>' + esc(s.status) + '</td></tr>').join('') +
            '</table>';
        $('rp-go').addEventListener('click', () => adminReport(body, $('rp-from').value, $('rp-to').value));
        $('rp-csv').addEventListener('click', () => {
            const rows = [['created_at', 'order_code', 'customer', 'phone', 'subtotal', 'discount', 'gift_card', 'wallet', 'collected', 'mode', 'fulfillment', 'status']].concat((d.sales || []).map((s) => [s.created_at, s.order_code, s.buyer_name, s.buyer_phone, s.subtotal, s.discount_total, s.gift_card_amount, s.wallet_amount, s.paid_amount, s.payment_mode, s.fulfillment, s.status]));
            const blob = new Blob([rows.map((r) => r.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'pos-sales-' + d.from + '-' + d.to + '.csv';
            a.click();
        });
    }

    boot();
})();

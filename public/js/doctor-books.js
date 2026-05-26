/**
 * Doctor portal — Agnikarma & Viddhakarma book orders.
 */
(function () {
    let bookConfig = null;
    let bookCart = {};
    let bookPollTimer = null;

    function uid() {
        if (typeof doctorNumericUserId === 'function') return doctorNumericUserId();
        return null;
    }

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function cartKey(bookId, language) {
        return bookId + '::' + language;
    }

    async function loadBookSalesConfig() {
        try {
            const res = await fetch('/api/public/book-sales/config', { cache: 'no-store' });
            bookConfig = await res.json();
        } catch (e) {
            bookConfig = { enabled: false };
        }
        window.__bookSalesConfig = bookConfig;
        const nav = document.getElementById('nav-books');
        if (nav) {
            const show = !!(bookConfig && bookConfig.enabled);
            nav.classList.toggle('hidden', !show);
        }
        return bookConfig;
    }

    function renderBookCatalog() {
        const root = document.getElementById('books-catalog');
        if (!root || !bookConfig || !bookConfig.enabled) return;
        const langs = bookConfig.languages || [];
        const books = bookConfig.books || [];
        if (!books.length) {
            root.innerHTML = '<p style="color:#64748b;">Book catalog is not configured yet. Contact the foundation office.</p>';
            return;
        }
        let html =
            '<p style="color:#64748b;margin:0 0 16px;">Books by <strong>Dr. R.B. Gogate</strong>. Orders are collected on the portal; payment online or at the counter. Pick up at the seminar book desk — show your QR when staff scan.</p>';
        html += '<div style="display:grid;gap:16px;">';
        books.forEach((book) => {
            html += `<div class="card" style="padding:16px;border:1px solid #e2e8f0;">
                <h3 style="margin:0 0 4px;color:#0f766e;">${esc(book.title)}</h3>
                <p style="margin:0 0 12px;font-size:0.88rem;color:#64748b;">${esc(book.author || 'Dr. R.B. Gogate')} · ₹${Number(book.price || 0).toFixed(2)} each</p>
                <div style="display:grid;gap:10px;">`;
            langs.forEach((lang) => {
                const k = cartKey(book.id, lang.id);
                const q = bookCart[k] || 0;
                html += `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px;background:#f8fafc;border-radius:8px;">
                    <span style="min-width:90px;font-weight:600;">${esc(lang.label)}</span>
                    <label style="font-size:0.85rem;">Qty <input type="number" min="0" max="99" value="${q}" data-book-qty data-book="${esc(book.id)}" data-lang="${esc(lang.id)}" style="width:64px;padding:6px;margin-left:4px;"></label>
                </div>`;
            });
            html += '</div></div>';
        });
        html += '</div>';
        html += `<div style="margin-top:16px;padding:14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;">
            <strong>Cart total: ₹<span id="books-cart-total">0.00</span></strong>
        </div>`;
        root.innerHTML = html;
        root.querySelectorAll('[data-book-qty]').forEach((inp) => {
            inp.addEventListener('input', () => {
                const b = inp.getAttribute('data-book');
                const l = inp.getAttribute('data-lang');
                const v = parseInt(inp.value, 10) || 0;
                const key = cartKey(b, l);
                if (v > 0) bookCart[key] = v;
                else delete bookCart[key];
                updateCartTotal();
            });
        });
        updateCartTotal();
    }

    function collectCartItems() {
        const items = [];
        Object.keys(bookCart).forEach((k) => {
            const qty = bookCart[k];
            if (!qty) return;
            const [bookId, language] = k.split('::');
            items.push({ bookId, language, qty });
        });
        return items;
    }

    function updateCartTotal() {
        let total = 0;
        if (!bookConfig || !bookConfig.books) return;
        const priceMap = {};
        bookConfig.books.forEach((b) => {
            priceMap[b.id] = Number(b.price) || 0;
        });
        collectCartItems().forEach((it) => {
            total += (priceMap[it.bookId] || 0) * it.qty;
        });
        const el = document.getElementById('books-cart-total');
        if (el) el.textContent = total.toFixed(2);
        return total;
    }

    function paymentOptionsHtml() {
        const opts = window.__doctorPaymentOptions || [];
        if (!opts.length) {
            return '<option value="mock">Test payment (mock)</option>';
        }
        return opts.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    }

    async function placeBookOrder() {
        const userId = uid();
        if (!userId) return alert('Please sign in again.');
        const items = collectCartItems();
        if (!items.length) return alert('Add quantity for at least one book and language.');
        const modeEl = document.querySelector('input[name="books-pay-mode"]:checked');
        const paymentMode = modeEl && modeEl.value === 'online' ? 'online' : 'counter';
        const msg = document.getElementById('books-order-msg');
        if (msg) msg.textContent = 'Placing order…';
        try {
            const res = await fetch('/api/doctor/book-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, items, paymentMode })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not place order');
            bookCart = {};
            if (paymentMode === 'online' && data.needsPayment) {
                const methodId = (document.getElementById('books-pay-method') || {}).value || 'mock';
                const payRes = await fetch('/api/payments/process-book-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bookOrderId: data.bookOrderId,
                        userId,
                        methodId
                    })
                });
                const payData = await payRes.json();
                if (!payRes.ok) throw new Error(payData.error || 'Payment failed');
                if (payData.paid) {
                    if (msg) {
                        msg.style.color = '#15803d';
                        msg.textContent = payData.message || 'Paid. Your pickup QR is ready below.';
                    }
                } else if (payData.paymentType === 'dqr' && payData.qrImageUrl) {
                    if (msg) {
                        msg.innerHTML =
                            'Scan UPI QR to pay. <img src="' +
                            esc(payData.qrImageUrl) +
                            '" alt="UPI QR" style="max-width:220px;display:block;margin-top:10px;">';
                    }
                    startBookPaymentPoll(data.bookOrderId, userId);
                } else {
                    if (msg) msg.textContent = payData.message || 'Complete payment.';
                }
            } else {
                if (msg) {
                    msg.style.color = '#15803d';
                    msg.textContent = data.message || 'Order placed.';
                }
            }
            await loadBookOrders();
            renderBookCatalog();
        } catch (e) {
            if (msg) {
                msg.style.color = '#b91c1c';
                msg.textContent = e.message || 'Order failed';
            }
        }
    }

    function startBookPaymentPoll(bookOrderId, userId) {
        if (bookPollTimer) clearInterval(bookPollTimer);
        bookPollTimer = setInterval(async () => {
            try {
                const res = await fetch(
                    '/api/payments/book-order-status?bookOrderId=' +
                        encodeURIComponent(bookOrderId) +
                        '&userId=' +
                        encodeURIComponent(userId)
                );
                const data = await res.json();
                if (data.paid || (data.order && data.order.status === 'confirmed')) {
                    clearInterval(bookPollTimer);
                    bookPollTimer = null;
                    const msg = document.getElementById('books-order-msg');
                    if (msg) {
                        msg.style.color = '#15803d';
                        msg.textContent = 'Payment confirmed. Show your pickup QR at the book counter.';
                    }
                    loadBookOrders();
                }
            } catch (_) {}
        }, 5000);
    }

    function statusLabel(st) {
        const m = {
            awaiting_confirmation: 'Awaiting counter payment / confirmation',
            pending_payment: 'Awaiting online payment',
            confirmed: 'Ready for pickup — show QR at book desk',
            fulfilled: 'Collected',
            cancelled: 'Cancelled'
        };
        return m[st] || st;
    }

    async function loadBookOrders() {
        const root = document.getElementById('books-orders-list');
        const userId = uid();
        if (!root || !userId) return;
        try {
            const res = await fetch('/api/doctor/book-orders?userId=' + encodeURIComponent(userId));
            const orders = await res.json();
            if (!Array.isArray(orders) || !orders.length) {
                root.innerHTML = '<p style="color:#64748b;">No book orders yet.</p>';
                return;
            }
            root.innerHTML = orders
                .map((o) => {
                    const lines = (o.items || [])
                        .map(
                            (it) =>
                                esc(it.bookId) +
                                ' · ' +
                                esc(it.languageLabel || it.language) +
                                ' × ' +
                                it.qty
                        )
                        .join('<br>');
                    let qr = '';
                    if (o.status === 'confirmed' && o.qrCodeData) {
                        const qrUrl =
                            'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' +
                            encodeURIComponent(o.qrCodeData);
                        qr =
                            '<div style="margin-top:10px;"><img src="' +
                            qrUrl +
                            '" alt="Pickup QR" width="160" height="160"><p style="font-size:0.8rem;color:#64748b;">Code: ' +
                            esc(o.orderCode) +
                            '</p></div>';
                    }
                    return `<div class="card" style="margin-bottom:12px;padding:14px;border:1px solid #e2e8f0;">
                        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
                            <strong>${esc(o.orderCode)}</strong>
                            <span style="font-size:0.85rem;color:#0f766e;">${esc(statusLabel(o.status))}</span>
                        </div>
                        <p style="margin:8px 0;font-size:0.88rem;">${lines}</p>
                        <p style="margin:0;font-size:0.88rem;color:#64748b;">Total ₹${Number(o.totalAmount || 0).toFixed(2)} · ${esc(o.paymentMode)}</p>
                        ${qr}
                    </div>`;
                })
                .join('');
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">Could not load orders.</p>';
        }
    }

    async function initBooksTab() {
        await loadBookSalesConfig();
        if (!bookConfig || !bookConfig.enabled) {
            const root = document.getElementById('books-catalog');
            if (root) root.innerHTML = '<p style="color:#64748b;">Book sales are not available on the portal right now.</p>';
            return;
        }
        if (typeof loadDoctorPaymentOptions === 'function') await loadDoctorPaymentOptions();
        const payBlock = document.getElementById('books-payment-options');
        if (payBlock) {
            const online = bookConfig.onlinePaymentEnabled !== false;
            const counter = bookConfig.payAtCounterEnabled !== false;
            payBlock.innerHTML =
                (online
                    ? '<label style="margin-right:16px;"><input type="radio" name="books-pay-mode" value="online" checked> Pay online</label>'
                    : '') +
                (counter
                    ? '<label><input type="radio" name="books-pay-mode" value="counter"' +
                      (online ? '' : ' checked') +
                      '> Pay at counter (seminar day)</label>'
                    : '') +
                (online
                    ? '<div style="margin-top:10px;"><label>Payment method</label><select id="books-pay-method" style="width:100%;max-width:320px;padding:8px;">' +
                      paymentOptionsHtml() +
                      '</select></div>'
                    : '');
        }
        renderBookCatalog();
        loadBookOrders();
    }

    window.initDoctorBooksTab = initBooksTab;
    window.placeDoctorBookOrder = placeBookOrder;
    window.loadDoctorBookSalesConfig = loadBookSalesConfig;

    document.addEventListener('DOMContentLoaded', () => {
        loadBookSalesConfig();
    });
})();

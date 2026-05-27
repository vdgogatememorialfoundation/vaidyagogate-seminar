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

    function formatBookDt(iso) {
        if (!iso) return '';
        if (window.PortalDateTime && window.PortalDateTime.format) return window.PortalDateTime.format(iso);
        try {
            return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        } catch (_) {
            return String(iso);
        }
    }

    function syncBookOrderWindowUi() {
        const banner = document.getElementById('books-window-banner');
        const panel = document.getElementById('books-order-panel');
        const btn = document.getElementById('books-place-order-btn');
        const open = !!(bookConfig && bookConfig.enabled && bookConfig.orderingOpen);
        if (panel) panel.classList.toggle('hidden', !open);
        if (btn) btn.disabled = !open;
        if (!banner) return;
        if (!bookConfig || !bookConfig.enabled) {
            banner.classList.add('hidden');
            return;
        }
        const win = bookConfig.orderWindow || {};
        if (bookConfig.orderingOpen) {
            banner.classList.remove('hidden');
            banner.style.background = '#ecfdf5';
            banner.style.border = '1px solid #a7f3d0';
            banner.style.color = '#166534';
            let text = win.message || 'Book ordering is open.';
            if (bookConfig.orderStart || bookConfig.orderEnd) {
                const parts = [];
                if (bookConfig.orderStart) parts.push('From ' + formatBookDt(bookConfig.orderStart));
                if (bookConfig.orderEnd) parts.push('until ' + formatBookDt(bookConfig.orderEnd));
                if (parts.length) text += ' (' + parts.join(' ') + ' IST)';
            }
            banner.textContent = text;
            return;
        }
        banner.classList.remove('hidden');
        banner.style.background = '#fef9c3';
        banner.style.border = '1px solid #fde047';
        banner.style.color = '#854d0e';
        if (win.phase === 'before') {
            banner.textContent =
                win.message ||
                'Book ordering has not started yet.' +
                    (bookConfig.orderStart ? ' Opens ' + formatBookDt(bookConfig.orderStart) + ' (IST).' : '');
        } else if (win.phase === 'after') {
            banner.textContent =
                win.message ||
                'Book ordering is closed.' +
                    (bookConfig.orderEnd ? ' Closed ' + formatBookDt(bookConfig.orderEnd) + ' (IST).' : '');
        } else {
            banner.textContent = win.message || 'Book ordering is not available right now.';
        }
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
        syncBookOrderWindowUi();
        return bookConfig;
    }

    function renderBookCatalog() {
        const root = document.getElementById('books-catalog');
        if (!root || !bookConfig || !bookConfig.enabled) return;
        syncBookOrderWindowUi();
        const langs = bookConfig.languages || [];
        const books = bookConfig.books || [];
        if (!books.length) {
            root.innerHTML = '<p style="color:#64748b;">Book catalog is not configured yet. Contact the foundation office.</p>';
            return;
        }
        const orderingOpen = !!bookConfig.orderingOpen;
        let html =
            '<p style="color:#64748b;margin:0 0 16px;">Books by <strong>Dr. R.B. Gogate</strong>. ' +
            (orderingOpen
                ? 'Choose language and quantity below; payment online or at the counter. Pick up at the seminar book desk.'
                : 'You can view the catalog below; new orders are not accepted outside the registration window.') +
            '</p>';
        html += '<div style="display:grid;gap:16px;">';
        books.forEach((book) => {
            html += `<div class="card" style="padding:16px;border:1px solid #e2e8f0;">
                <h3 style="margin:0 0 4px;color:#0f766e;">${esc(book.title)}</h3>
                <p style="margin:0 0 12px;font-size:0.88rem;color:#64748b;">${esc(book.author || 'Dr. R.B. Gogate')} · ₹${Number(book.price || 0).toFixed(2)} each</p>
                <div style="display:grid;gap:10px;">`;
            langs.forEach((lang) => {
                const k = cartKey(book.id, lang.id);
                const q = bookCart[k] || 0;
                const avail =
                    bookConfig &&
                    bookConfig.stock &&
                    bookConfig.stock[book.id] &&
                    Number.isFinite(Number(bookConfig.stock[book.id][lang.id]))
                        ? Math.max(0, Number(bookConfig.stock[book.id][lang.id]))
                        : null;
                const dis = orderingOpen ? '' : ' disabled';
                html += `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px;background:#f8fafc;border-radius:8px;${orderingOpen ? '' : 'opacity:0.65;'}">
                    <span style="min-width:90px;font-weight:600;">${esc(lang.label)}</span>
                    ${
                        avail != null
                            ? `<span style="font-size:0.78rem;color:${avail <= 3 ? '#b45309' : '#64748b'};">Available: <strong>${avail}</strong></span>`
                            : ''
                    }
                    <label style="font-size:0.85rem;">Qty <input type="number" min="0" max="99" value="${q}" data-book-qty data-book="${esc(book.id)}" data-lang="${esc(lang.id)}" style="width:64px;padding:6px;margin-left:4px;"${dis}></label>
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
        if (!bookConfig || !bookConfig.orderingOpen) {
            const win = (bookConfig && bookConfig.orderWindow) || {};
            return alert(win.message || 'Book ordering is not open at this time.');
        }
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

    const ST_LABEL = {
        awaiting_confirmation: 'Awaiting confirmation',
        pending_payment: 'Awaiting online payment',
        confirmed: 'Confirmed — show QR at book desk',
        ready_to_ship: 'Packed and ready to ship',
        shipped: 'Shipped — in transit',
        out_for_delivery: 'Out for delivery',
        delivered: 'Delivered ✓',
        fulfilled: 'Collected ✓',
        cancelled: 'Cancelled'
    };

    function statusLabel(st, o) {
        if (o && o.fulfillmentType === 'courier') {
            if (st === 'delivered') return 'Delivered by courier ✓';
            if (st === 'shipped') {
                return o.courierTrackLabel ? 'In transit — ' + o.courierTrackLabel : 'Shipped — in transit';
            }
            if (st === 'confirmed' && o.courierShipmentStatus === 'ready_to_ship') {
                return 'Courier — preparing shipment';
            }
            if (st === 'fulfilled' && o.courierTrackingNo) {
                return o.courierTrackLabel || 'Shipped — in transit';
            }
            if (st === 'confirmed') return 'Confirmed — courier delivery';
        }
        return ST_LABEL[st] || st;
    }

    function statusColor(st) {
        if (st === 'confirmed') return '#0d9488';
        if (st === 'shipped' || st === 'out_for_delivery') return '#0369a1';
        if (st === 'fulfilled') return '#15803d';
        if (st === 'cancelled') return '#b91c1c';
        return '#64748b';
    }

    function renderBilling(o) {
        const books = Number(o.booksSubtotal != null ? o.booksSubtotal : o.totalAmount || 0);
        const courier = Number(o.courierCharge != null ? o.courierCharge : 0);
        const cancelled = Number(o.cancelledSubtotal != null ? o.cancelledSubtotal : 0);
        const total = Number(o.billingTotal != null ? o.billingTotal : o.totalAmount || 0);
        return (
            '<div style="margin-top:10px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:0.84rem;">' +
            '<div style="display:flex;justify-content:space-between;"><span>Books subtotal</span><strong>₹' + books.toFixed(0) + '</strong></div>' +
            (courier > 0
                ? '<div style="display:flex;justify-content:space-between;color:#64748b;"><span>Courier charge</span><span>₹' + courier.toFixed(0) + '</span></div>'
                : '') +
            (cancelled > 0
                ? '<div style="display:flex;justify-content:space-between;color:#b91c1c;"><span>Cancelled items</span><span>-₹' + cancelled.toFixed(0) + '</span></div>'
                : '') +
            '<div style="display:flex;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px solid #cbd5e1;"><span>Total</span><strong>₹' + total.toFixed(0) + '</strong></div>' +
            '</div>'
        );
    }

    function renderBookTrackerStepsHtml(timeline) {
        if (!timeline || !timeline.steps || !timeline.steps.length) return '';
        const steps = timeline.steps;
        let html = '<div class="tracker-vertical" style="margin-top:12px;">';
        steps.forEach((step) => {
            const cls =
                step.state === 'completed' ? 'completed' : step.state === 'active' ? 'active' : 'upcoming';
            const when =
                step.at && (step.state === 'completed' || step.state === 'active')
                    ? '<p class="track-when" style="font-size:0.78rem;color:#0f766e;margin:4px 0 0;font-weight:600;">' +
                      esc(formatBookDt(step.at)) +
                      '</p>'
                    : step.state === 'upcoming'
                      ? '<p class="track-when" style="font-size:0.78rem;color:#94a3b8;margin:4px 0 0;">Upcoming</p>'
                      : '';
            const trackLink = step.trackingUrl
                ? '<p style="margin:6px 0 0;"><a href="' +
                  esc(step.trackingUrl) +
                  '" target="_blank" rel="noopener" style="font-size:0.82rem;color:#0d9488;font-weight:600;">Track shipment ↗</a></p>'
                : '';
            html +=
                '<div class="track-step ' +
                cls +
                '"><div class="track-icon"><i class="fas ' +
                esc(step.icon || 'fa-circle') +
                '"></i></div><div class="track-content"><div class="track-title">' +
                esc(step.title || '') +
                '</div><div class="track-desc">' +
                esc(step.desc || '') +
                '</div>' +
                when +
                trackLink +
                '</div></div>';
        });
        html += '</div>';
        return html;
    }

    function renderOrderCard(o) {
        const lines = (o.items || [])
            .map((it) => {
                const cancelled = (it.lineStatus || 'active') === 'cancelled';
                return (
                    '<li style="' +
                    (cancelled ? 'opacity:.65;' : '') +
                    '">' +
                    esc(it.bookTitle || it.bookId) +
                    ' · ' +
                    esc(it.languageLabel || it.language) +
                    ' × ' +
                    it.qty +
                    ' · ₹' +
                    Number(it.lineTotal || 0).toFixed(0) +
                    (cancelled ? ' <span style="color:#b91c1c;">(cancelled)</span>' : '') +
                    '</li>'
                );
            })
            .join('');
        const journey = o.deliveryJourney;
        // Compact stepper shown in card; click expands to full vertical timeline
        const compactTrack = journey && window.BookTrackingUI
            ? window.BookTrackingUI.renderHorizontalStepper(journey)
            : '';
        const fullTrackId = 'book-track-full-' + o.id;
        const trackHtml =
            '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0;">' +
            compactTrack +
            '<div id="' + fullTrackId + '" class="hidden" style="margin-top:10px;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">' +
            (journey && window.BookTrackingUI
                ? window.BookTrackingUI.renderVerticalJourney(journey, o.courierTrackEvents || [], {})
                : renderBookTrackerStepsHtml(o.timeline)) +
            '</div>' +
            '<button type="button" onclick="bookTrackToggle(' + o.id + ')" style="margin-top:8px;background:none;border:none;color:#0d9488;font-size:0.78rem;font-weight:700;cursor:pointer;padding:0;" id="book-track-toggle-' + o.id + '">▼ Show full tracking</button>' +
            '</div>';
        let extra = '';
        if (o.status === 'confirmed' && o.qrCodeData && o.fulfillmentType !== 'courier') {
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(o.qrCodeData);
            extra = '<div style="margin-top:12px;text-align:center;">' +
                '<img src="' + qrUrl + '" alt="Pickup QR" width="160" height="160" style="border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);">' +
                '<p style="font-size:0.8rem;color:#64748b;margin:4px 0 0;">Code: ' + esc(o.orderCode) + ' · Show to book desk volunteer</p></div>';
        } else if (o.fulfillmentType === 'courier' && o.courierShipmentStatus === 'ready_to_ship' && o.status === 'confirmed') {
            extra =
                '<p style="margin:8px 0 0;font-size:0.88rem;color:#0f766e;">Shipping address confirmed. AWB and tracking link will appear once staff dispatches your parcel.</p>';
        } else if (o.fulfillmentType === 'courier' && (o.status === 'shipped' || o.courierTrackingNo)) {
            const journey = o.deliveryJourney;
            if (!journey || !journey.isLive) {
                const live = o.courierTrackLabel
                    ? '<p style="margin:6px 0 0;font-size:0.88rem;color:#0f766e;font-weight:600;">' + esc(o.courierTrackLabel) + '</p>'
                    : '';
                extra = live;
            }
        }
        const detailMeta =
            '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">' +
            '<span style="font-size:0.76rem;padding:4px 8px;border-radius:999px;background:#f1f5f9;color:#334155;">' +
            esc(o.fulfillmentType === 'courier' ? 'Courier delivery' : 'Counter pickup') +
            '</span>' +
            '<span style="font-size:0.76rem;padding:4px 8px;border-radius:999px;background:#f1f5f9;color:#334155;">Payment: ' +
            esc(o.paymentMode || '—') +
            '</span>' +
            (o.courierTrackLabel
                ? '<span style="font-size:0.76rem;padding:4px 8px;border-radius:999px;background:#ecfeff;color:#0e7490;">' +
                  esc(o.courierTrackLabel) +
                  '</span>'
                : '') +
            '</div>';
        return '<div class="card" style="margin-bottom:12px;padding:14px;border:1px solid #e2e8f0;" data-book-order-id="' + o.id + '">' +
            '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
            '<strong>' + esc(o.orderCode) + '</strong>' +
            '<span style="font-size:0.85rem;font-weight:600;color:' + statusColor(o.status) + ';">' + esc(statusLabel(o.status, o)) + '</span>' +
            '</div>' +
            '<ul style="margin:8px 0 4px;padding-left:18px;font-size:0.88rem;">' + lines + '</ul>' +
            detailMeta +
            renderBilling(o) +
            extra +
            trackHtml +
            '</div>';
    }

    function orderTrackFingerprint(o) {
        const j = o.deliveryJourney || {};
        return [
            o.id,
            o.status,
            o.courierShipmentStatus,
            o.courierTrackStatus,
            o.courierTrackLabel,
            j.headline,
            j.progressPercent,
            o.courierTrackingNo,
            (o.courierTrackEvents || []).length,
            o.fulfilledAt
        ].join('|');
    }

    const _openBookTrackIds = new Set();
    const OPEN_TRACK_KEY = 'doctor_book_open_track_ids';

    function loadOpenTrackState() {
        try {
            const raw = sessionStorage.getItem(OPEN_TRACK_KEY);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            _openBookTrackIds.clear();
            arr.forEach((x) => {
                if (x != null && String(x).trim()) _openBookTrackIds.add(String(x));
            });
        } catch (_) {}
    }

    function saveOpenTrackState() {
        try {
            sessionStorage.setItem(OPEN_TRACK_KEY, JSON.stringify(Array.from(_openBookTrackIds)));
        } catch (_) {}
    }
    let _bookOrderPollTimer = null;
    let _bookConfigPollTimer = null;
    let _bookPollIntervalMs = 15000;
    let _bookRefreshTracksTick = 0;

    function startBookConfigPoll() {
        if (_bookConfigPollTimer) return;
        _bookConfigPollTimer = setInterval(async () => {
            const tab = document.getElementById('tab-books');
            if (!tab || tab.classList.contains('hidden')) return;
            const prevOpen = bookConfig && bookConfig.orderingOpen;
            await loadBookSalesConfig();
            if (prevOpen !== (bookConfig && bookConfig.orderingOpen)) {
                renderBookCatalog();
            }
        }, 30000);
    }

    function stopBookConfigPoll() {
        if (_bookConfigPollTimer) {
            clearInterval(_bookConfigPollTimer);
            _bookConfigPollTimer = null;
        }
    }

    let _lastBookOrdersFingerprint = '';

    async function loadBookOrders(silent) {
        const root = document.getElementById('books-orders-list');
        const live = document.getElementById('books-track-live');
        const userId = uid();
        if (!root || !userId) return;
        try {
            const tab = document.getElementById('tab-books');
            const tabVisible = tab && !tab.classList.contains('hidden');
            if (tabVisible) {
                _bookRefreshTracksTick++;
            }
            if (tabVisible && _bookRefreshTracksTick % 3 === 1) {
                fetch('/api/doctor/book-orders/refresh-tracks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId })
                }).catch(() => {});
            }
            const res = await fetch('/api/doctor/book-orders?userId=' + encodeURIComponent(userId));
            const orders = await res.json();
            if (!Array.isArray(orders) || !orders.length) {
                root.innerHTML = '<p style="color:#64748b;">No book orders yet.</p>';
                if (live) live.classList.add('hidden');
                stopBookOrderPoll();
                _lastBookOrdersFingerprint = '';
                return;
            }
            const fp = orders.map(orderTrackFingerprint).join(';;');
            const needsPoll = orders.some(
                (o) => o.status !== 'delivered' && o.status !== 'fulfilled' && o.status !== 'cancelled'
            );
            const needsFastPoll = orders.some(
                (o) =>
                    o.fulfillmentType === 'courier' &&
                    (o.status === 'shipped' || (o.deliveryJourney && o.deliveryJourney.isLive))
            );
            const nextInterval = needsFastPoll ? 10000 : 15000;
            if (nextInterval !== _bookPollIntervalMs) {
                _bookPollIntervalMs = nextInterval;
                stopBookOrderPoll();
            }
            if (live) {
                live.classList.toggle('hidden', !needsPoll);
                if (needsFastPoll) {
                    live.innerHTML =
                        '<span class="pkg-live-dot" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span> Live delivery tracking — refreshing every 10 seconds';
                }
            }
            if (silent && _openBookTrackIds.size > 0) {
                // Never re-render cards while any tracking panel is manually expanded.
                // This guarantees the panel stays open during auto-poll.
                _lastBookOrdersFingerprint = fp;
                if (needsPoll) startBookOrderPoll();
                else stopBookOrderPoll();
                return;
            }
            const keepExpandedStable = silent && _openBookTrackIds.size > 0 && fp !== _lastBookOrdersFingerprint;
            if (!silent || (!keepExpandedStable && fp !== _lastBookOrdersFingerprint)) {
                root.innerHTML = orders.map(renderOrderCard).join('');
                _openBookTrackIds.forEach((orderId) => {
                    const el = document.getElementById('book-track-full-' + orderId);
                    const btn = document.getElementById('book-track-toggle-' + orderId);
                    if (el) el.classList.remove('hidden');
                    if (btn) btn.textContent = '▲ Hide tracking';
                });
                _lastBookOrdersFingerprint = fp;
            } else if (keepExpandedStable) {
                // Keep open tracking panels exactly as-is while poll refreshes in background.
                // This avoids visible collapse/flicker in doctor portal.
                _lastBookOrdersFingerprint = fp;
            }
            if (needsPoll) startBookOrderPoll();
            else stopBookOrderPoll();
        } catch (e) {
            if (!silent) root.innerHTML = '<p style="color:#b91c1c;">Could not load orders.</p>';
        }
    }

    function startBookOrderPoll() {
        if (_bookOrderPollTimer) return;
        _bookOrderPollTimer = setInterval(() => loadBookOrders(true), _bookPollIntervalMs);
    }

    function stopBookOrderPoll() {
        if (_bookOrderPollTimer) { clearInterval(_bookOrderPollTimer); _bookOrderPollTimer = null; }
    }

    async function initBooksTab() {
        await loadBookSalesConfig();
        if (!bookConfig || !bookConfig.enabled) {
            const root = document.getElementById('books-catalog');
            if (root) root.innerHTML = '<p style="color:#64748b;">Book sales are not available on the portal right now.</p>';
            syncBookOrderWindowUi();
            return;
        }
        syncBookOrderWindowUi();
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
        startBookConfigPoll();
    }

    window.bookTrackToggle = function (orderId) {
        const el = document.getElementById('book-track-full-' + orderId);
        const btn = document.getElementById('book-track-toggle-' + orderId);
        if (!el) return;
        const hidden = el.classList.toggle('hidden');
        const key = String(orderId);
        if (hidden) _openBookTrackIds.delete(key);
        else _openBookTrackIds.add(key);
        saveOpenTrackState();
        if (btn) btn.textContent = hidden ? '▼ Show full tracking' : '▲ Hide tracking';
    };

    window.initDoctorBooksTab = initBooksTab;
    window.placeDoctorBookOrder = placeBookOrder;
    window.loadDoctorBookSalesConfig = loadBookSalesConfig;
    window.stopDoctorBookOrderPoll = stopBookOrderPoll;
    window.stopDoctorBookConfigPoll = stopBookConfigPoll;

    document.addEventListener('DOMContentLoaded', () => {
        loadOpenTrackState();
        loadBookSalesConfig();
    });
})();

/**
 * Staff portal — book inventory & orders (book_sales_staff, co-admin, super-admin).
 */
(function () {
    const STORAGE_KEY = 'seminar_staff_user';
    let staffUser = null;
    let staffModules = { inventory: true, orders: true };

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function actorId() {
        return staffUser && staffUser.id;
    }

    function headers() {
        const id = actorId();
        return id
            ? { 'Content-Type': 'application/json', 'X-Acting-User-Id': String(id) }
            : { 'Content-Type': 'application/json' };
    }

    function body(extra) {
        return Object.assign({ actingStaffId: actorId() }, extra || {});
    }

    function loadStoredUser() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function saveUser(u) {
        staffUser = u;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    }

    window.staffLogout = function () {
        staffUser = null;
        localStorage.removeItem(STORAGE_KEY);
        document.getElementById('app-shell').classList.add('hidden');
        document.getElementById('auth-overlay').style.display = 'flex';
    };

    async function refreshSession() {
        const res = await fetch('/api/staff/book-sales/session', { headers: headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Session expired');
        staffModules = data.modules || staffModules;
        return data;
    }

    function applyModuleTabs() {
        document.querySelectorAll('[data-staff-tab]').forEach((btn) => {
            const tab = btn.getAttribute('data-staff-tab');
            const show = tab === 'inventory' ? staffModules.inventory : staffModules.orders;
            btn.style.display = show ? '' : 'none';
        });
        if (!staffModules.inventory && staffModules.orders) staffSwitchTab('orders');
        else if (staffModules.inventory) staffSwitchTab('inventory');
    }

    window.staffSwitchTab = function (tab) {
        document.getElementById('staff-panel-inventory').classList.toggle('hidden', tab !== 'inventory');
        document.getElementById('staff-panel-orders').classList.toggle('hidden', tab !== 'orders');
        document.querySelectorAll('.tab[data-staff-tab]').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-staff-tab') === tab);
        });
        if (tab === 'inventory') staffLoadInventory();
        if (tab === 'orders') staffLoadOrders();
    };

    async function staffLoadInventory() {
        const root = document.getElementById('staff-inventory-root');
        if (!root || !staffModules.inventory) return;
        try {
            const res = await fetch('/api/staff/book-sales/inventory', { headers: headers() });
            const data = await res.json();
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error) + '</p>';
                return;
            }
            const books = data.books || [];
            const langs = data.languages || [];
            const invMap = {};
            (data.inventory || []).forEach((r) => {
                invMap[r.book_id + '::' + r.language] = r;
            });
            let html =
                '<table class="data-table"><thead><tr><th>Book</th><th>Language</th><th>Qty</th></tr></thead><tbody>';
            books.forEach((book) => {
                langs.forEach((lang) => {
                    const row = invMap[book.id + '::' + lang.id] || {};
                    html +=
                        '<tr><td>' +
                        esc(book.title) +
                        '</td><td>' +
                        esc(lang.label) +
                        '</td><td><input type="number" min="0" data-sinv-book="' +
                        esc(book.id) +
                        '" data-sinv-lang="' +
                        esc(lang.id) +
                        '" value="' +
                        (row.qty_on_hand != null ? row.qty_on_hand : 0) +
                        '" style="width:72px;padding:6px;"></td></tr>';
                });
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    }

    window.staffSaveInventory = async function () {
        const msg = document.getElementById('staff-inventory-msg');
        const rows = [];
        document.querySelectorAll('[data-sinv-book]').forEach((inp) => {
            rows.push({
                bookId: inp.getAttribute('data-sinv-book'),
                language: inp.getAttribute('data-sinv-lang'),
                qty_on_hand: parseInt(inp.value, 10) || 0,
                low_stock_threshold: 5
            });
        });
        if (msg) {
            msg.style.color = '#0d9488';
            msg.textContent = 'Saving…';
        }
        try {
            const res = await fetch('/api/staff/book-sales/inventory', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body({ rows }))
            });
            const data = await res.json();
            if (!res.ok) {
                if (msg) {
                    msg.style.color = '#b91c1c';
                    msg.textContent = data.error || 'Failed';
                }
                return;
            }
            if (msg) {
                msg.style.color = '#15803d';
                msg.textContent = '✓ Saved';
            }
            staffLoadInventory();
        } catch (e) {
            if (msg) {
                msg.style.color = '#b91c1c';
                msg.textContent = e.message;
            }
        }
    };

    window.staffLoadOrders = async function () {
        const root = document.getElementById('staff-orders-root');
        if (!root || !staffModules.orders) return;
        const st = (document.getElementById('staff-orders-filter') || {}).value || '';
        try {
            const res = await fetch(
                '/api/staff/book-sales/orders?limit=150' + (st ? '&status=' + encodeURIComponent(st) : ''),
                { headers: headers() }
            );
            const rows = await res.json();
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(rows.error) + '</p>';
                return;
            }
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No orders.</p>';
                return;
            }
            let html =
                '<table class="data-table"><thead><tr><th>Code</th><th>Buyer</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody>';
            rows.forEach((o) => {
                const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || o.buyer_name || '—';
                html +=
                    '<tr><td><strong>' +
                    esc(o.order_code) +
                    '</strong></td><td>' +
                    esc(name) +
                    '<br><small>' +
                    esc(o.email || o.phone || '') +
                    '</small></td><td>' +
                    esc(o.status) +
                    '</td><td>₹' +
                    Number(o.total_amount || 0).toFixed(0) +
                    '</td><td><button type="button" class="btn btn-primary" style="padding:4px 10px;font-size:0.8rem;" onclick="staffViewOrder(' +
                    o.id +
                    ')">View</button></td></tr>';
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.staffCloseOrderModal = function () {
        const modal = document.getElementById('staff-order-modal');
        modal.classList.add('hidden');
        modal.style.display = 'none';
    };

    window.staffViewOrder = async function (id) {
        const modal = document.getElementById('staff-order-modal');
        const body = document.getElementById('staff-order-modal-body');
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        body.innerHTML = '<p>Loading…</p>';
        try {
            const res = await fetch('/api/staff/book-sales/orders/' + id, { headers: headers() });
            const data = await res.json();
            if (!res.ok) {
                body.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error) + '</p>';
                return;
            }
            const o = data.order || {};
            let html = '<p><strong>' + esc(o.orderCode) + '</strong> · ' + esc(o.status) + '</p>';
            html += '<p style="font-size:0.88rem;color:#64748b;">Total ₹' + Number(o.totalAmount || 0).toFixed(0) + '</p>';
            if (o.items && o.items.length) {
                html += '<table class="data-table" style="margin:12px 0;"><thead><tr><th>Book</th><th>Lang</th><th>Qty</th><th></th></tr></thead><tbody>';
                o.items.forEach((it) => {
                    const cancelled = (it.lineStatus || 'active') === 'cancelled';
                    html +=
                        '<tr><td>' +
                        esc(it.bookTitle || it.bookId) +
                        '</td><td>' +
                        esc(it.languageLabel || it.language) +
                        '</td><td>' +
                        it.qty +
                        '</td><td>' +
                        (!cancelled && o.status !== 'fulfilled' && o.status !== 'delivered'
                            ? '<button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:0.75rem;" onclick="staffCancelLine(' +
                              id +
                              ',' +
                              it.id +
                              ')">Cancel</button>'
                            : esc(cancelled ? 'Cancelled' : '')) +
                        '</td></tr>';
                });
                html += '</tbody></table>';
            }
            if (o.deliveryJourney && window.BookTrackingUI) {
                html +=
                    '<div style="border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;margin-top:12px;">' +
                    window.BookTrackingUI.renderVerticalJourney(o.deliveryJourney, data.courierTrackEvents || [], {}) +
                    '</div>';
            }
            if (o.status === 'awaiting_confirmation') {
                html +=
                    '<button type="button" class="btn btn-primary" style="margin-top:12px;" onclick="staffConfirmOrder(' +
                    id +
                    ')">Confirm order</button>';
            }
            body.innerHTML = html;
        } catch (e) {
            body.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.staffCancelLine = async function (orderId, lineId) {
        const reason = prompt('Reason for cancellation:', 'Not available');
        if (!reason) return;
        try {
            const res = await fetch('/api/staff/book-sales/orders/' + orderId + '/items/' + lineId + '/cancel', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body({ reason }))
            });
            const data = await res.json();
            if (!res.ok) return alert(data.error || 'Failed');
            staffLoadOrders();
            staffViewOrder(orderId);
        } catch (e) {
            alert(e.message);
        }
    };

    window.staffConfirmOrder = async function (id) {
        if (!confirm('Confirm this order?')) return;
        try {
            const res = await fetch('/api/staff/book-sales/orders/' + id + '/confirm', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body())
            });
            const data = await res.json();
            if (!res.ok) return alert(data.error || 'Failed');
            staffLoadOrders();
            staffViewOrder(id);
        } catch (e) {
            alert(e.message);
        }
    };

    async function bootApp() {
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('app-shell').classList.remove('hidden');
        const label = document.getElementById('staff-user-label');
        if (label) {
            label.textContent =
                (staffUser.name || staffUser.email || '') +
                ' · ' +
                (staffUser.user_role || staffUser.role || 'staff');
        }
        const admLink = document.getElementById('staff-link-admin');
        if (admLink && window.PortalAuth && window.PortalAuth.isAdminPortalUser(staffUser)) {
            admLink.style.display = '';
        }
        try {
            const sess = await refreshSession();
            staffModules = sess.modules || staffModules;
        } catch (e) {
            alert(e.message || 'Session error');
            staffLogout();
            return;
        }
        applyModuleTabs();
    }

    document.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('staff-login-form');
        const u = loadStoredUser();
        if (u && window.PortalAuth) {
            const ur = String(u.user_role || '').toLowerCase();
            if (ur === 'book_sales_staff' || window.PortalAuth.isAdminPortalUser(u)) {
                staffUser = u;
                bootApp().catch(() => staffLogout());
                return;
            }
        }
        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('staff-login-msg');
                const email = (document.getElementById('staff-login-email') || {}).value.trim();
                const password = (document.getElementById('staff-login-password') || {}).value;
                if (msg) msg.textContent = 'Signing in…';
                try {
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password, portal: 'staff' })
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) {
                        if (msg) {
                            msg.style.color = '#b91c1c';
                            msg.textContent = data.error || 'Login failed';
                        }
                        return;
                    }
                    const user = data.user;
                    const ur = String(user.user_role || '').toLowerCase();
                    if (ur === 'scanner_portal_user' || ur === 'scanner_dashboard_user') {
                        if (msg) {
                            msg.style.color = '#b91c1c';
                            msg.textContent = 'Use the scanner portal at /scanner.html for entry scanning.';
                        }
                        return;
                    }
                    if (ur !== 'book_sales_staff' && !(window.PortalAuth && window.PortalAuth.isAdminPortalUser(user))) {
                        if (msg) {
                            msg.style.color = '#b91c1c';
                            msg.textContent =
                                window.PortalAuth && window.PortalAuth.wrongPortalHint
                                    ? window.PortalAuth.wrongPortalHint(user)
                                    : 'This account cannot use the staff book portal.';
                        }
                        return;
                    }
                    saveUser(user);
                    if (msg) msg.textContent = '';
                    await bootApp();
                } catch (err) {
                    if (msg) {
                        msg.style.color = '#b91c1c';
                        msg.textContent = err.message || 'Network error';
                    }
                }
            });
        }
    });
})();

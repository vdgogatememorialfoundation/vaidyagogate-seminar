/**
 * Staff portal — book inventory & orders (book_sales_staff, co-admin, super-admin).
 */
(function () {
    const STORAGE_KEY = 'seminar_staff_user';
    let staffUser = null;
    let staffSections = {};
    let staffSectionList = [];
    let activeStaffTab = null;

    const APP_STATUS_OPTS = [
        'submitted',
        'pending_approval',
        'revision_required',
        'documents_requested',
        'approved_pending_payment',
        'completed',
        'e_ticket_issued',
        'certificate_issued',
        'checked_in',
        'rejected',
        'cancelled'
    ];
    const TICKET_STATUS_OPTS = ['open', 'in_progress', 'resolved', 'closed'];

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

    async function apiJson(url, opts) {
        if (!window.fetchJson) throw new Error('fetch-json.js failed to load');
        return window.fetchJson(url, opts);
    }

    function canUseStaffPortal(user) {
        if (!user || !window.PortalAuth) return false;
        if (window.PortalAuth.isStaffPortalUser && window.PortalAuth.isStaffPortalUser(user)) return true;
        const ur = String(user.user_role || '').toLowerCase();
        if (ur === 'scanner_portal_user' || ur === 'scanner_dashboard_user') return false;
        if (ur === 'judge_user' || ur === 'reviewer') return false;
        if (window.PortalAuth.isDoctorUser && window.PortalAuth.isDoctorUser(user)) return false;
        if (window.PortalAuth.isAdminPortalUser && window.PortalAuth.isAdminPortalUser(user)) return true;
        return false;
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
        const { res, data } = await apiJson('/api/staff/session', { headers: headers() });
        if (!res.ok) throw new Error(data.error || 'Session expired');
        staffSections = data.sections || {};
        staffSectionList = data.sectionList || [];
        return data;
    }

    function hasStaffSection(id) {
        return !!(staffSections && staffSections[id]);
    }

    function renderStaffTabs() {
        const tabsEl = document.getElementById('staff-tabs');
        if (!tabsEl) return;
        const list = staffSectionList;
        tabsEl.innerHTML = list
            .map(
                (s) =>
                    '<button type="button" class="tab" data-staff-tab="' +
                    esc(s.id) +
                    '" onclick="staffSwitchTab(\'' +
                    String(s.id).replace(/'/g, "\\'") +
                    "')\">" +
                    esc(s.label) +
                    '</button>'
            )
            .join('');
        if (!list.length) {
            tabsEl.innerHTML = '<p style="color:#b91c1c;font-size:0.88rem;">No staff modules enabled for this account.</p>';
            return;
        }
        const first = activeStaffTab && hasStaffSection(activeStaffTab) ? activeStaffTab : list[0].id;
        staffSwitchTab(first);
    }

    function isCoAdminUser(user) {
        return String((user && user.user_role) || '').toLowerCase() === 'co_admin';
    }

    function goCoAdminCrm() {
        window.location.href = '/staff/crm';
    }

    function updateStaffPageHeader() {
        const title = document.getElementById('staff-page-title');
        const hint = document.getElementById('staff-page-hint');
        if (!title) return;
        const bookOnly =
            staffSectionList.length <= 2 &&
            staffSectionList.every((s) => s.id === 'inventory' || s.id === 'book-orders');
        title.textContent = bookOnly ? 'Staff — Book operations' : 'Staff portal';
        if (hint) {
            hint.textContent = staffSectionList.map((s) => s.label).join(' · ');
        }
    }

    window.staffSwitchTab = function (tab) {
        activeStaffTab = tab;
        const panelIds = [
            'inventory',
            'book-orders',
            'applications',
            'support-tickets',
            'payments',
            'etickets'
        ];
        panelIds.forEach((id) => {
            const panel = document.getElementById('staff-panel-' + id);
            if (panel) panel.classList.toggle('hidden', tab !== id);
        });
        document.querySelectorAll('.tab[data-staff-tab]').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-staff-tab') === tab);
        });
        if (tab === 'inventory') staffLoadInventory();
        if (tab === 'book-orders') staffLoadOrders();
        if (tab === 'applications') staffLoadApplications();
        if (tab === 'support-tickets') staffLoadSupportTickets();
        if (tab === 'payments') staffLoadSeminarOrders();
    };

    async function staffLoadInventory() {
        const root = document.getElementById('staff-inventory-root');
        if (!root || !hasStaffSection('inventory')) return;
        try {
            const { res, data } = await apiJson('/api/staff/book-sales/inventory', { headers: headers() });
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error) + '</p>';
                return;
            }
            const books = data.books || [];
            const langs = data.languages || [];
            if (!books.length || !langs.length) {
                root.innerHTML = '<p style="color:#64748b;">No book catalog configured.</p>';
                return;
            }
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
            const { res, data } = await apiJson('/api/staff/book-sales/inventory', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body({ rows }))
            });
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
        if (!root || !hasStaffSection('book-orders')) return;
        const st = (document.getElementById('staff-orders-filter') || {}).value || '';
        try {
            const { res, data: rows } = await apiJson(
                '/api/staff/book-sales/orders?limit=150' + (st ? '&status=' + encodeURIComponent(st) : ''),
                { headers: headers() }
            );
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
            const { res, data } = await apiJson('/api/staff/book-sales/orders/' + id, { headers: headers() });
            if (!res.ok) {
                body.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error) + '</p>';
                return;
            }
            const o = data.order || {};
            let html = '<p><strong>' + esc(o.orderCode) + '</strong> · ' + esc(o.status) + '</p>';
            if (o.items && o.items.length) {
                html += '<table class="data-table" style="margin:12px 0;"><thead><tr><th>Book</th><th>Lang</th><th>Qty</th><th>₹</th><th></th></tr></thead><tbody>';
                o.items.forEach((it) => {
                    const cancelled = (it.lineStatus || 'active') === 'cancelled';
                    const canCancel =
                        !cancelled &&
                        o.status !== 'fulfilled' &&
                        o.status !== 'delivered' &&
                        o.status !== 'cancelled';
                    html +=
                        '<tr><td>' +
                        esc(it.bookTitle || it.bookId) +
                        '</td><td>' +
                        esc(it.languageLabel || it.language) +
                        '</td><td>' +
                        it.qty +
                        '</td><td>' +
                        Number(it.lineTotal || 0).toFixed(0) +
                        '</td><td>' +
                        (canCancel
                            ? '<button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:0.75rem;" onclick="staffCancelLine(' +
                              id +
                              ',' +
                              it.id +
                              ')">Remove</button>'
                            : esc(cancelled ? 'Cancelled' : '')) +
                        '</td></tr>';
                });
                html += '</tbody></table>';
            }
            const subtotal = Number(o.booksSubtotal != null ? o.booksSubtotal : 0);
            const courier = Number(o.courierCharge != null ? o.courierCharge : 0);
            const total = Number(o.billingTotal != null ? o.billingTotal : o.totalAmount || 0);
            html +=
                '<div style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:0.85rem;">' +
                '<div style="display:flex;justify-content:space-between;"><span>Books</span><span>₹' +
                subtotal.toFixed(0) +
                '</span></div>';
            if (courier > 0) {
                html +=
                    '<div style="display:flex;justify-content:space-between;color:#64748b;"><span>Courier</span><span>₹' +
                    courier.toFixed(0) +
                    '</span></div>';
            }
            html +=
                '<div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:800;"><span>Total due</span><span>₹' +
                total.toFixed(0) +
                '</span></div></div>';
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
            const { res, data } = await apiJson('/api/staff/book-sales/orders/' + orderId + '/items/' + lineId + '/cancel', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body({ reason }))
            });
            if (!res.ok) return alert(data.error || 'Failed');
            const newTotal = data.order && (data.order.billingTotal != null ? data.order.billingTotal : data.order.totalAmount);
            if (newTotal != null) alert('Item removed. Updated bill: ₹' + Number(newTotal).toFixed(0));
            staffLoadOrders();
            staffViewOrder(orderId);
        } catch (e) {
            alert(e.message);
        }
    };

    window.staffConfirmOrder = async function (id) {
        if (!confirm('Confirm this order?')) return;
        try {
            const { res, data } = await apiJson('/api/staff/book-sales/orders/' + id + '/confirm', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body())
            });
            if (!res.ok) return alert(data.error || 'Failed');
            staffLoadOrders();
            staffViewOrder(id);
        } catch (e) {
            alert(e.message);
        }
    };

    window.staffLoadApplications = async function () {
        const root = document.getElementById('staff-applications-root');
        if (!root || !hasStaffSection('applications')) return;
        root.innerHTML = '<p>Loading…</p>';
        try {
            const { res, data } = await apiJson('/api/staff/applications', { headers: headers() });
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Failed to load') + '</p>';
                return;
            }
            const rows = Array.isArray(data) ? data : [];
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No applications.</p>';
                return;
            }
            let html =
                '<table class="data-table"><thead><tr><th>App no.</th><th>Name</th><th>Status</th><th>Submitted</th><th>Update</th></tr></thead><tbody>';
            rows.forEach((a) => {
                const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || '—';
                const opts = APP_STATUS_OPTS.map(
                    (st) =>
                        '<option value="' +
                        st +
                        '"' +
                        (String(a.status || '').toLowerCase() === st ? ' selected' : '') +
                        '>' +
                        st +
                        '</option>'
                ).join('');
                html +=
                    '<tr><td><strong>' +
                    esc(a.application_no) +
                    '</strong></td><td>' +
                    esc(name) +
                    '<br><small>' +
                    esc(a.user_id_string || '') +
                    '</small></td><td>' +
                    esc(a.status) +
                    '</td><td>' +
                    esc((a.created_at || '').slice(0, 10)) +
                    '</td><td><select id="staff-app-st-' +
                    a.id +
                    '" style="padding:4px;font-size:0.8rem;">' +
                    opts +
                    '</select> <button type="button" class="btn btn-primary" style="padding:4px 8px;font-size:0.75rem;" onclick="staffSaveApplicationStatus(' +
                    a.id +
                    ')">Save</button></td></tr>';
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.staffSaveApplicationStatus = async function (applicationId) {
        const sel = document.getElementById('staff-app-st-' + applicationId);
        const status = sel ? sel.value : '';
        if (!status) return alert('Choose a status');
        try {
            const { res, data } = await apiJson('/api/staff/applications/status', {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(body({ applicationId, status }))
            });
            if (!res.ok) return alert(data.error || 'Failed');
            staffLoadApplications();
        } catch (e) {
            alert(e.message);
        }
    };

    window.staffLoadSupportTickets = async function () {
        const root = document.getElementById('staff-tickets-root');
        if (!root || !hasStaffSection('support-tickets')) return;
        root.innerHTML = '<p>Loading…</p>';
        try {
            const { res, data } = await apiJson('/api/staff/support-tickets', { headers: headers() });
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Failed to load') + '</p>';
                return;
            }
            const rows = Array.isArray(data) ? data : [];
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No support tickets.</p>';
                return;
            }
            let html =
                '<table class="data-table"><thead><tr><th>Ticket</th><th>From</th><th>Subject</th><th>Priority</th><th>Status</th><th>Update</th></tr></thead><tbody>';
            rows.forEach((t) => {
                const name = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email || '—';
                const opts = TICKET_STATUS_OPTS.map(
                    (st) =>
                        '<option value="' +
                        st +
                        '"' +
                        (String(t.status || '').toLowerCase() === st ? ' selected' : '') +
                        '>' +
                        st +
                        '</option>'
                ).join('');
                html +=
                    '<tr><td><strong>' +
                    esc(t.ticket_id_string || t.id) +
                    '</strong></td><td>' +
                    esc(name) +
                    '</td><td>' +
                    esc(t.subject) +
                    '</td><td>' +
                    esc(t.priority || '—') +
                    '</td><td>' +
                    esc(t.status) +
                    '</td><td><select id="staff-tkt-st-' +
                    t.id +
                    '" style="padding:4px;font-size:0.8rem;">' +
                    opts +
                    '</select> <button type="button" class="btn btn-primary" style="padding:4px 8px;font-size:0.75rem;" onclick="staffSaveTicketStatus(' +
                    t.id +
                    ')">Save</button></td></tr>';
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.staffSaveTicketStatus = async function (ticketId) {
        const sel = document.getElementById('staff-tkt-st-' + ticketId);
        const status = sel ? sel.value : '';
        if (!status) return alert('Choose a status');
        try {
            const { res, data } = await apiJson('/api/staff/support-tickets/' + ticketId + '/status', {
                method: 'PUT',
                headers: headers(),
                body: JSON.stringify(body({ status }))
            });
            if (!res.ok) return alert(data.error || 'Failed');
            staffLoadSupportTickets();
        } catch (e) {
            alert(e.message);
        }
    };

    window.staffLoadSeminarOrders = async function () {
        const root = document.getElementById('staff-payments-root');
        if (!root || !hasStaffSection('payments')) return;
        root.innerHTML = '<p>Loading…</p>';
        try {
            const { res, data } = await apiJson('/api/staff/seminar-orders', { headers: headers() });
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Failed to load') + '</p>';
                return;
            }
            const rows = Array.isArray(data) ? data : [];
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No payment orders.</p>';
                return;
            }
            let html =
                '<table class="data-table"><thead><tr><th>Order</th><th>App</th><th>Seminar</th><th>Doctor</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
            rows.forEach((o) => {
                const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || '—';
                html +=
                    '<tr><td><strong>' +
                    esc(o.order_id_string || o.id) +
                    '</strong></td><td>' +
                    esc(o.application_no) +
                    '</td><td>' +
                    esc(o.seminar_title || '—') +
                    '</td><td>' +
                    esc(name) +
                    '<br><small>' +
                    esc(o.email || o.user_id_string || '') +
                    '</small></td><td>₹' +
                    Number(o.amount || 0).toFixed(0) +
                    '</td><td>' +
                    esc(o.status) +
                    '</td></tr>';
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
        }
    };

    window.staffSearchEtickets = async function () {
        const root = document.getElementById('staff-etickets-root');
        const qInp = document.getElementById('staff-eticket-q');
        if (!root || !hasStaffSection('etickets')) return;
        const q = qInp ? qInp.value.trim() : '';
        if (!q) {
            root.innerHTML = '<p style="color:#64748b;">Enter a search term.</p>';
            return;
        }
        root.innerHTML = '<p>Searching…</p>';
        try {
            const { res, data } = await apiJson('/api/staff/etickets/lookup?q=' + encodeURIComponent(q), {
                headers: headers()
            });
            if (!res.ok) {
                root.innerHTML = '<p style="color:#b91c1c;">' + esc(data.error || 'Search failed') + '</p>';
                return;
            }
            const rows = (data && data.results) || [];
            if (!rows.length) {
                root.innerHTML = '<p style="color:#64748b;">No matches for “' + esc(q) + '”.</p>';
                return;
            }
            let html =
                '<table class="data-table"><thead><tr><th>App</th><th>Doctor</th><th>Seminar</th><th>Ticket</th><th>Payment</th><th>Scanned</th></tr></thead><tbody>';
            rows.forEach((r) => {
                const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
                html +=
                    '<tr><td><strong>' +
                    esc(r.application_no) +
                    '</strong><br><small>' +
                    esc(r.registration_status) +
                    '</small></td><td>' +
                    esc(name) +
                    '<br><small>' +
                    esc(r.email || r.phone || '') +
                    '</small></td><td>' +
                    esc(r.seminar_title || '—') +
                    '</td><td>' +
                    esc(r.ticket_id_string || '—') +
                    '</td><td>' +
                    esc(r.payment_status || '—') +
                    '</td><td>' +
                    (r.is_scanned ? 'Yes' : 'No') +
                    '</td></tr>';
            });
            html += '</tbody></table>';
            root.innerHTML = html;
        } catch (e) {
            root.innerHTML = '<p style="color:#b91c1c;">' + esc(e.message) + '</p>';
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
        try {
            const sess = await refreshSession();
            staffSections = sess.sections || staffSections;
            staffSectionList = sess.sectionList || staffSectionList;
        } catch (e) {
            alert(e.message || 'Session error');
            staffLogout();
            return;
        }
        updateStaffPageHeader();
        renderStaffTabs();
    }

    document.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('staff-login-form');
        const u = loadStoredUser();
        if (u && canUseStaffPortal(u)) {
            if (isCoAdminUser(u)) {
                goCoAdminCrm();
                return;
            }
            staffUser = u;
            bootApp().catch(() => staffLogout());
            return;
        }
        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const msg = document.getElementById('staff-login-msg');
                const email = (document.getElementById('staff-login-email') || {}).value.trim();
                const password = (document.getElementById('staff-login-password') || {}).value;
                if (msg) msg.textContent = 'Signing in…';
                try {
                    const { res, data } = await apiJson('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password, portal: 'staff' })
                    });
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
                    if (ur === 'judge_user' || ur === 'reviewer') {
                        if (msg) {
                            msg.style.color = '#b91c1c';
                            msg.textContent = 'Judge accounts must use the judge portal at /judge.html.';
                        }
                        return;
                    }
                    if (!canUseStaffPortal(user)) {
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
                    if (isCoAdminUser(user)) {
                        goCoAdminCrm();
                        return;
                    }
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

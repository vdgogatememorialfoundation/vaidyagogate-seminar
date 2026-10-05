(function () {
    const API = '/fleetbase-api/int/v1';
    const TOKEN_KEY = 'gogate_fleetbase_hub_token';
    const state = { mode: 'logistics', section: 'scan', hubs: [], drivers: [], orders: [] };

    const $ = (id) => document.getElementById(id);

    function token() {
        return sessionStorage.getItem(TOKEN_KEY) || '';
    }

    function say(id, text, ok) {
        const el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.className = 'msg ' + (ok ? 'ok' : text ? 'bad' : '');
    }

    function listOf(data, key) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (Array.isArray(data[key])) return data[key];
        const inner = data.data;
        if (Array.isArray(inner)) return inner;
        if (inner && Array.isArray(inner[key])) return inner[key];
        return [];
    }

    async function api(method, path, body) {
        const res = await fetch(API + path, {
            method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token()
            },
            body: body == null ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = { message: text.slice(0, 180) };
            }
        }
        if (res.status === 401) {
            sessionStorage.removeItem(TOKEN_KEY);
            showLogin();
            throw new Error('Sign in again.');
        }
        if (!res.ok) {
            const message = data.message || data.error || (data.errors && JSON.stringify(data.errors)) || 'Fleetbase rejected the request.';
            throw new Error(String(message).slice(0, 240));
        }
        return data;
    }

    function showLogin() {
        $('login').classList.remove('hidden');
        $('app').classList.add('hidden');
        $('sign-out').classList.add('hidden');
    }

    function showApp() {
        $('login').classList.add('hidden');
        $('app').classList.remove('hidden');
        $('sign-out').classList.remove('hidden');
    }

    function metaOf(row) {
        if (!row || !row.meta) return {};
        if (typeof row.meta === 'string') {
            try {
                return JSON.parse(row.meta) || {};
            } catch (_) {
                return {};
            }
        }
        return row.meta;
    }

    function hubLabel(hub) {
        const meta = metaOf(hub);
        const place = [hub.city, hub.province, meta.country_name || hub.country].filter(Boolean).join(' ');
        return (hub.name || 'Hub') + (place ? ' · ' + place : '');
    }

    function phrase(kind, hub) {
        const meta = metaOf(hub);
        const name = String(hub.name || '').trim();
        const city = String(hub.city || '').trim();
        const state = String(hub.province || '').trim();
        const country = String(meta.country_name || hub.country || '').trim();
        if (!name || !city || !state || !country) return '';
        const where = name + '- ' + city + ' ' + state + ', ' + country;
        return kind === 'left' ? 'Shipment Left ' + where : 'Shipment Received at ' + where;
    }

    function trackingOf(order) {
        const tracking = order && order.tracking_number;
        if (!tracking) return order && order.tracking ? String(order.tracking) : '';
        if (typeof tracking === 'string') return tracking;
        return String(tracking.tracking_number || tracking.number || '');
    }

    function matchesScan(order, code) {
        const scan = String(code || '').trim();
        if (!scan) return false;
        const meta = metaOf(order);
        const values = [order.id, order.public_id, order.internal_id, order.tracking, trackingOf(order), meta.awb, order.barcode];
        return values.some((value) => String(value || '').trim() === scan);
    }

    function modeOf(order) {
        const meta = metaOf(order);
        return meta.fulfillment === 'hyperlocal' ? 'hyperlocal' : 'logistics';
    }

    function when(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    }

    function fillHubSelects() {
        const options = state.hubs
            .map((hub) => '<option value="' + escapeAttr(hub.id || hub.public_id || '') + '">' + escapeHtml(hubLabel(hub)) + '</option>')
            .join('');
        $('scan-hub').innerHTML = options || '<option value="">No hubs yet</option>';
        $('driver-hub').innerHTML = '<option value="">No hub yet</option>' + options;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/"/g, '&quot;');
    }

    function selectedHub() {
        const id = $('scan-hub').value;
        return state.hubs.find((hub) => String(hub.id || hub.public_id) === id) || null;
    }

    async function loadHubs() {
        const data = await api('GET', '/places?limit=100');
        state.hubs = listOf(data, 'places').filter((place) => String(place.type || '').toLowerCase() === 'hub');
        fillHubSelects();
        $('hubs').innerHTML = state.hubs.length
            ? '<table><thead><tr><th>Hub</th><th>Role</th><th>Address</th></tr></thead><tbody>' +
              state.hubs
                  .map((hub) => {
                      const meta = metaOf(hub);
                      return (
                          '<tr><td>' +
                          escapeHtml(hub.name || '') +
                          '</td><td>' +
                          escapeHtml(meta.role || '') +
                          '</td><td>' +
                          escapeHtml([hub.street1, hub.neighborhood, hub.city, hub.province, hub.postal_code, meta.country_name || hub.country].filter(Boolean).join(', ')) +
                          '</td></tr>'
                      );
                  })
                  .join('') +
              '</tbody></table>'
            : '<p class="muted">No sorting hubs yet.</p>';
    }

    function driverName(driver) {
        const user = driver.user || driver.user_account || {};
        return driver.name || user.name || driver.public_id || driver.id || 'Driver';
    }

    async function loadDrivers() {
        const data = await api('GET', '/drivers?limit=100');
        state.drivers = listOf(data, 'drivers');
        $('drivers').innerHTML = state.drivers.length
            ? '<table><thead><tr><th>Driver</th><th>Status</th><th>Hub</th><th></th></tr></thead><tbody>' +
              state.drivers
                  .map((driver) => {
                      const id = escapeAttr(driver.id || driver.public_id || '');
                      const meta = metaOf(driver);
                      const hub = state.hubs.find((row) => String(row.id || row.public_id) === String(meta.hub_id || ''));
                      return (
                          '<tr><td>' +
                          escapeHtml(driverName(driver)) +
                          '<div class="muted">' +
                          escapeHtml((driver.user && (driver.user.phone || driver.user.email)) || '') +
                          '</div></td><td>' +
                          escapeHtml(driver.status || '') +
                          '</td><td>' +
                          escapeHtml(hub ? hub.name : '') +
                          '</td><td class="row"><button type="button" class="secondary" data-driver="' +
                          id +
                          '" data-act="block">Block</button><button type="button" class="secondary" data-driver="' +
                          id +
                          '" data-act="enable">Enable</button><button type="button" class="secondary" data-driver="' +
                          id +
                          '" data-act="password">Reset password</button></td></tr>'
                      );
                  })
                  .join('') +
              '</tbody></table>'
            : '<p class="muted">No drivers yet.</p>';
    }

    async function loadOrders() {
        const data = await api('GET', '/orders?limit=80');
        const rows = listOf(data, 'orders').filter((order) => modeOf(order) === state.mode);
        state.orders = rows;
        $('orders').innerHTML = rows.length
            ? '<table><thead><tr><th>Shipment</th><th>Status</th><th>AWB</th><th>Scheduled</th><th></th></tr></thead><tbody>' +
              rows
                  .map((order) => {
                      const id = escapeAttr(order.id || order.public_id || '');
                      const meta = metaOf(order);
                      const status = order.latest_status || order.status || '';
                      const shown = String(status).toLowerCase() === 'created' ? 'Shipment Created' : status;
                      return (
                          '<tr><td>' +
                          escapeHtml(order.internal_id || order.public_id || order.id || '') +
                          '</td><td>' +
                          escapeHtml(shown) +
                          '</td><td><code>' +
                          escapeHtml(meta.awb || trackingOf(order) || '') +
                          '</code></td><td>' +
                          escapeHtml(when(meta.expected_pickup_at) ? 'Pickup ' + when(meta.expected_pickup_at) : '') +
                          '<div class="muted">' +
                          escapeHtml(when(meta.expected_delivery_at || order.scheduled_at)) +
                          '</div></td><td><button type="button" class="secondary" data-assign="' +
                          id +
                          '">Assign to Navigator driver</button></td></tr>'
                      );
                  })
                  .join('') +
              '</tbody></table>'
            : '<p class="muted">No ' + state.mode + ' shipments in the latest Fleetbase orders.</p>';
    }

    async function refresh() {
        say('work-msg', '');
        await loadHubs();
        await loadDrivers();
        await loadOrders();
    }

    async function findOrder(code) {
        const scan = String(code || '').trim();
        let hit = state.orders.find((order) => matchesScan(order, scan));
        if (hit) return hit;
        const listed = await api('GET', '/orders?limit=100');
        hit = listOf(listed, 'orders').find((order) => matchesScan(order, scan));
        if (hit) return hit;
        try {
            const one = await api('GET', '/orders/' + encodeURIComponent(scan));
            const order = one.order || one.data || one;
            if (order && (order.id || order.public_id)) return order;
        } catch (_) {}
        return null;
    }

    async function scan(kind) {
        try {
            const hub = selectedHub();
            const line = hub ? phrase(kind, hub) : '';
            if (!line) throw new Error('Choose a hub that has a name, city, state, and country.');
            const code = $('barcode').value.trim();
            if (!code) throw new Error('Scan the barcode.');
            const order = await findOrder(code);
            if (!order) throw new Error('No Fleetbase shipment matches that barcode.');
            const id = order.id || order.public_id;
            await api('PATCH', '/orders/update-activity/' + encodeURIComponent(id), {
                activity: {
                    code: kind === 'left' ? 'hub_left' : 'hub_received',
                    status: line,
                    details: line
                }
            });
            $('barcode').value = '';
            say('work-msg', line, true);
            await loadOrders();
        } catch (err) {
            say('work-msg', err.message || 'Scan failed.');
        }
    }

    $('sign-in').addEventListener('click', async () => {
        say('login-msg', '');
        try {
            const res = await fetch(API + '/auth/login', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: $('identity').value.trim(), password: $('password').value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.token) throw new Error(data.message || 'Sign in failed.');
            sessionStorage.setItem(TOKEN_KEY, data.token);
            $('password').value = '';
            showApp();
            await refresh();
        } catch (err) {
            say('login-msg', err.message || 'Sign in failed.');
        }
    });

    $('sign-out').addEventListener('click', () => {
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin();
    });

    document.getElementById('mode-tabs').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        state.mode = button.getAttribute('data-mode');
        document.querySelectorAll('#mode-tabs button').forEach((item) => item.setAttribute('aria-pressed', item === button ? 'true' : 'false'));
        loadOrders().catch((err) => say('work-msg', err.message));
    });

    document.getElementById('section-tabs').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        state.section = button.getAttribute('data-section');
        document.querySelectorAll('#section-tabs button').forEach((item) => item.setAttribute('aria-pressed', item === button ? 'true' : 'false'));
        document.querySelectorAll('[data-panel]').forEach((panel) => {
            panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== state.section);
        });
    });

    $('receive').addEventListener('click', () => scan('receive'));
    $('leave').addEventListener('click', () => scan('left'));
    $('barcode').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') scan('receive');
    });

    $('save-hub').addEventListener('click', async () => {
        try {
            const name = $('hub-name').value.trim();
            const city = $('hub-city').value.trim();
            const stateName = $('hub-state').value.trim();
            const country = $('hub-country').value.trim();
            const address = $('hub-address').value.trim();
            if (!name || !city || !stateName || !country || !address) throw new Error('Enter the hub name, address, city, state, and country.');
            await api('POST', '/places', {
                place: {
                    name,
                    street1: address,
                    neighborhood: $('hub-locality').value.trim(),
                    city,
                    province: stateName,
                    postal_code: $('hub-pin').value.trim(),
                    country,
                    type: 'hub',
                    meta: {
                        role: $('hub-role').value,
                        locality: $('hub-locality').value.trim(),
                        country_name: country
                    }
                }
            });
            ['hub-name', 'hub-locality', 'hub-city', 'hub-state', 'hub-country', 'hub-pin', 'hub-address'].forEach((id) => {
                $(id).value = '';
            });
            say('work-msg', 'Hub saved.', true);
            await loadHubs();
        } catch (err) {
            say('work-msg', err.message || 'Could not save the hub.');
        }
    });

    $('save-driver').addEventListener('click', async () => {
        try {
            const name = $('driver-name').value.trim();
            const password = $('driver-password').value;
            if (!name) throw new Error('Enter the driver name.');
            if (password && password.length < 8) throw new Error('Password must be at least 8 characters.');
            await api('POST', '/drivers', {
                driver: {
                    name,
                    phone: $('driver-phone').value.trim(),
                    email: $('driver-email').value.trim(),
                    password,
                    status: 'available',
                    meta: { hub_id: $('driver-hub').value }
                }
            });
            ['driver-name', 'driver-phone', 'driver-email', 'driver-password'].forEach((id) => {
                $(id).value = '';
            });
            say('work-msg', 'Driver added. They sign in with Fleetbase Navigator.', true);
            await loadDrivers();
        } catch (err) {
            say('work-msg', err.message || 'Could not add the driver.');
        }
    });

    $('drivers').addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const id = button.getAttribute('data-driver');
        const act = button.getAttribute('data-act');
        try {
            if (act === 'block') {
                await api('PUT', '/drivers/' + encodeURIComponent(id), { driver: { status: 'inactive' } });
                await api('POST', '/drivers/' + encodeURIComponent(id) + '/deactivate-login', {});
                say('work-msg', 'Driver blocked.', true);
            } else if (act === 'enable') {
                await api('PUT', '/drivers/' + encodeURIComponent(id), { driver: { status: 'available' } });
                await api('POST', '/drivers/' + encodeURIComponent(id) + '/reactivate-login', {});
                say('work-msg', 'Driver enabled.', true);
            } else if (act === 'password') {
                const password = window.prompt('New password (at least 8 characters)');
                if (!password) return;
                if (password.length < 8) throw new Error('Password must be at least 8 characters.');
                await api('POST', '/drivers/' + encodeURIComponent(id) + '/reset-credentials', {
                    password,
                    password_confirmation: password
                });
                say('work-msg', 'Password reset. Tell the driver the new password.', true);
            }
            await loadDrivers();
        } catch (err) {
            say('work-msg', err.message || 'Driver update failed.');
        }
    });

    $('orders').addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-assign]');
        if (!button) return;
        const orderId = button.getAttribute('data-assign');
        const choices = state.drivers.filter((driver) => String(driver.status || '') !== 'inactive');
        if (!choices.length) {
            say('work-msg', 'Add a driver before assigning Navigator work.');
            return;
        }
        const list = choices.map((driver, index) => index + 1 + '. ' + driverName(driver)).join('\n');
        const pick = window.prompt('Assign this shipment to a Navigator driver:\n' + list);
        const index = Number(pick) - 1;
        if (!choices[index]) return;
        try {
            const driverId = choices[index].id || choices[index].public_id;
            await api('POST', '/drivers/' + encodeURIComponent(driverId) + '/assign-order', { order: orderId });
            say('work-msg', 'Assigned. The driver sees it in Fleetbase Navigator.', true);
            await loadOrders();
        } catch (err) {
            say('work-msg', err.message || 'Could not assign the driver.');
        }
    });

    if (token()) {
        showApp();
        refresh().catch((err) => say('work-msg', err.message));
    }
})();

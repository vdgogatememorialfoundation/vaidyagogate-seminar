(function () {
    const tokenKey = 'gogate-hub-token';
    let mode = 'logistics';

    function token() {
        return sessionStorage.getItem(tokenKey) || '';
    }

    async function api(path, options) {
        const opts = options || {};
        const res = await fetch(path, {
            method: opts.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token()
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function table(rows, columns) {
        if (!rows.length) return '<p class="muted">Nothing here yet.</p>';
        return (
            '<table><tr>' +
            columns.map((col) => '<th>' + esc(col[0]) + '</th>').join('') +
            '</tr>' +
            rows
                .map(
                    (row) =>
                        '<tr>' +
                        columns.map((col) => '<td>' + esc(typeof col[1] === 'function' ? col[1](row) : row[col[1]]) + '</td>').join('') +
                        '</tr>'
                )
                .join('') +
            '</table>'
        );
    }

    async function refresh() {
        const me = await api('/api/hub/me');
        document.getElementById('who').textContent = me.staff.name + ' · ' + (me.staff.hubName || '');
        document.getElementById('login').hidden = true;
        document.getElementById('app').hidden = false;
        const hubs = await api('/api/hub/hubs');
        document.getElementById('hubs').innerHTML = table(hubs.hubs || [], [
            ['Id', 'id'],
            ['Name', 'name'],
            ['Role', 'role'],
            ['Locality', 'locality'],
            ['City', 'city'],
            ['State', 'state'],
            ['Country', 'country']
        ]);
        const receiving = await api('/api/hub/orders?direction=receiving&mode=' + mode);
        const outgoing = await api('/api/hub/orders?direction=outgoing&mode=' + mode);
        const cols = [
            ['Id', 'id'],
            ['Order', 'orderCode'],
            ['AWB', 'awb'],
            ['Pickup', 'pickupAt'],
            ['Delivery', 'deliveryAt'],
            ['Route', (row) => (row.route || []).join(' → ')]
        ];
        document.getElementById('receiving').innerHTML = table(receiving.orders || [], cols);
        document.getElementById('outgoing').innerHTML = table(outgoing.orders || [], cols);
        const bags = await api('/api/hub/bags?mode=' + mode);
        document.getElementById('bags').innerHTML = table(bags.bags || [], [
            ['Code', 'code'],
            ['Status', 'status']
        ]);
        const trips = await api('/api/hub/trips?mode=' + mode);
        document.getElementById('trips').innerHTML = table(trips.trips || [], [
            ['Id', 'id'],
            ['From', 'from_name'],
            ['To', 'to_name'],
            ['Driver', 'driver_name'],
            ['Status', 'status']
        ]);
        const drivers = await api('/api/hub/drivers');
        document.getElementById('drivers').innerHTML = table(drivers.drivers || [], [
            ['Id', 'id'],
            ['Name', 'name'],
            ['Email', 'email'],
            ['Hub', 'hub_name'],
            ['Status', 'status'],
            ['Role', 'role']
        ]);
        document.getElementById('drivers').insertAdjacentHTML(
            'beforeend',
            (drivers.drivers || [])
                .map(
                    (driver) =>
                        '<p><button type="button" data-block="' +
                        driver.id +
                        '">Block</button> <button type="button" data-disable="' +
                        driver.id +
                        '">Disable</button> <button type="button" data-active="' +
                        driver.id +
                        '">Enable</button> <button type="button" data-reset="' +
                        driver.id +
                        '">Reset password</button> <button type="button" data-view="' +
                        driver.id +
                        '">Details</button></p>'
                )
                .join('')
        );
        const runs = await api('/api/hub/runsheets');
        document.getElementById('runs').innerHTML = table(runs.runsheets || [], [
            ['Id', 'id'],
            ['Agent', 'agent_name'],
            ['Date', 'service_date'],
            ['Status', 'status'],
            ['Section', 'mode']
        ]);
        const slots = await api('/api/hub/slots');
        document.getElementById('slots').innerHTML = table(slots.slots || [], [
            ['When', 'label'],
            ['Date', 'date'],
            ['Start', 'start'],
            ['End', 'end']
        ]);
    }

    document.getElementById('signin').addEventListener('click', async () => {
        const msg = document.getElementById('login-msg');
        try {
            const res = await fetch('/api/hub/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: document.getElementById('email').value,
                    password: document.getElementById('password').value
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not sign in');
            sessionStorage.setItem(tokenKey, data.token);
            msg.textContent = '';
            refresh();
        } catch (err) {
            msg.textContent = err.message;
        }
    });

    document.querySelectorAll('.tabs button').forEach((button) => {
        button.addEventListener('click', () => {
            mode = button.getAttribute('data-mode');
            document.querySelectorAll('.tabs button').forEach((el) => el.classList.toggle('on', el === button));
            refresh().catch((err) => {
                document.getElementById('scan-msg').textContent = err.message;
            });
        });
    });

    document.getElementById('save-hub').addEventListener('click', async () => {
        const msg = document.getElementById('scan-msg');
        try {
            await api('/api/hub/hubs', {
                method: 'POST',
                body: {
                    name: document.getElementById('h-name').value,
                    locality: document.getElementById('h-locality').value,
                    city: document.getElementById('h-city').value,
                    state: document.getElementById('h-state').value,
                    country: document.getElementById('h-country').value,
                    pincode: document.getElementById('h-pin').value,
                    address: document.getElementById('h-address').value,
                    role: document.getElementById('h-role').value,
                    mode: document.getElementById('h-mode').value,
                    fromCity: document.getElementById('h-from').value,
                    toCity: document.getElementById('h-to').value,
                    manager: document.getElementById('m-email').value.trim()
                        ? {
                              name: document.getElementById('m-name').value,
                              email: document.getElementById('m-email').value,
                              password: document.getElementById('m-password').value
                          }
                        : undefined
                }
            });
            refresh();
        } catch (err) {
            msg.textContent = err.message;
        }
    });

    async function scan(kind) {
        const msg = document.getElementById('scan-msg');
        try {
            const data = await api('/api/hub/scan', {
                method: 'POST',
                body: { kind, barcode: document.getElementById('scan-code').value }
            });
            msg.textContent = data.tracking || 'Scan saved';
            refresh();
        } catch (err) {
            msg.textContent = err.message;
        }
    }

    document.getElementById('receive').addEventListener('click', () => scan('receive'));
    document.getElementById('dispatch').addEventListener('click', () => scan('dispatch'));

    document.getElementById('make-run').addEventListener('click', async () => {
        const msg = document.getElementById('scan-msg');
        try {
            await api('/api/hub/runsheets', {
                method: 'POST',
                body: {
                    mode,
                    agentId: document.getElementById('run-agent').value,
                    orderIds: document.getElementById('run-orders').value.split(/[^0-9]+/).filter(Boolean)
                }
            });
            refresh();
        } catch (err) {
            msg.textContent = err.message;
        }
    });

    document.getElementById('make-bag').addEventListener('click', async () => {
        try {
            await api('/api/hub/bags', { method: 'POST', body: { mode } });
            refresh();
        } catch (err) {
            document.getElementById('scan-msg').textContent = err.message;
        }
    });

    document.getElementById('make-trip').addEventListener('click', async () => {
        try {
            await api('/api/hub/trips', {
                method: 'POST',
                body: { mode, toHubId: document.getElementById('trip-hub').value, driverId: document.getElementById('trip-driver').value }
            });
            refresh();
        } catch (err) {
            document.getElementById('scan-msg').textContent = err.message;
        }
    });

    document.getElementById('add-driver').addEventListener('click', async () => {
        try {
            await api('/api/hub/drivers', {
                method: 'POST',
                body: {
                    name: document.getElementById('d-name').value,
                    email: document.getElementById('d-email').value,
                    phone: document.getElementById('d-phone').value,
                    password: document.getElementById('d-password').value,
                    hubId: document.getElementById('d-hub').value,
                    role: document.getElementById('d-role').value
                }
            });
            refresh();
        } catch (err) {
            document.getElementById('scan-msg').textContent = err.message;
        }
    });

    async function saveSlot(enabled) {
        try {
            await api('/api/hub/slots', {
                method: 'POST',
                body: {
                    date: document.getElementById('slot-date').value,
                    start: document.getElementById('slot-start').value,
                    end: document.getElementById('slot-end').value,
                    enabled
                }
            });
            refresh();
        } catch (err) {
            document.getElementById('scan-msg').textContent = err.message;
        }
    }

    document.getElementById('add-slot').addEventListener('click', () => saveSlot(true));
    document.getElementById('close-slot').addEventListener('click', () => saveSlot(false));

    document.getElementById('drivers').addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const id = button.getAttribute('data-block') || button.getAttribute('data-disable') || button.getAttribute('data-active') || button.getAttribute('data-reset') || button.getAttribute('data-view');
        try {
            if (button.hasAttribute('data-view')) {
                const data = await api('/api/hub/drivers/' + id);
                alert(data.driver.name + ' · ' + data.driver.email + ' · ' + data.driver.status + ' · scans ' + (data.scans || []).length);
                return;
            }
            if (button.hasAttribute('data-reset')) {
                const password = prompt('New password, at least 8 characters');
                if (!password) return;
                await api('/api/hub/drivers/' + id + '/password', { method: 'POST', body: { password } });
                return;
            }
            const status = button.hasAttribute('data-block') ? 'blocked' : button.hasAttribute('data-disable') ? 'disabled' : 'active';
            await api('/api/hub/drivers/' + id + '/status', { method: 'POST', body: { status } });
            refresh();
        } catch (err) {
            document.getElementById('scan-msg').textContent = err.message;
        }
    });

    if (token()) refresh().catch(() => sessionStorage.removeItem(tokenKey));
})();

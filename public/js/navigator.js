(function () {
    const tokenKey = 'gogate-hub-token';

    function token() {
        return sessionStorage.getItem(tokenKey) || '';
    }

    async function api(path, body) {
        const res = await fetch(path, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
            body: body ? JSON.stringify(body) : undefined
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

    function card(order, hyper) {
        const obd = order.openBox
            ? '<label>Item damaged?<select data-k="damaged"><option value="">Choose</option><option value="no">No</option><option value="yes">Yes</option></select></label>' +
              '<label>Last 4 digits of customer mobile<input data-k="mobileLast4" inputmode="numeric" maxlength="4"></label>' +
              '<button type="button" data-act="obd">Email open-box code</button>' +
              '<label>Open-box code<input data-k="obdOtp" inputmode="numeric"></label>'
            : '';
        const hyperOtp = hyper
            ? '<button type="button" data-act="pickup-code">Email seller pickup code</button><label>Seller pickup code<input data-k="otp" inputmode="numeric"></label>' +
              '<button type="button" data-act="delivery-code">Email customer delivery code</button><label>Delivery code<input data-k="deliveryOtp" inputmode="numeric"></label>'
            : '';
        const cod = order.cod
            ? '<button type="button" data-act="qr">Customer has no cash</button><div data-qr></div><button type="button" data-act="paid">Check Razorpay payment</button>'
            : '';
        return (
            '<article data-id="' +
            order.id +
            '"><h3>' +
            esc(order.orderCode) +
            '</h3><p>' +
            esc(order.buyerName) +
            '<br>' +
            esc(order.address) +
            '</p><p class="muted">AWB ' +
            esc(order.awb) +
            '<br>Pickup ' +
            esc(order.pickupAt || '—') +
            '<br>Delivery ' +
            esc(order.deliveryAt || '—') +
            (order.fragile ? '<br>Fragile' : '') +
            (order.heavy ? '<br>Heavy' : '') +
            (order.openBox ? '<br>Open box' : '') +
            '</p>' +
            (hyper ? '<button type="button" data-act="accept">Accept</button>' : '') +
            '<button type="button" data-act="start">Start</button>' +
            '<button type="button" data-act="arrived-pickup">Arrived at pickup</button>' +
            hyperOtp +
            '<label>Scan AWB<input data-k="barcode" inputmode="numeric"></label>' +
            '<button type="button" data-act="pickup">Pickup</button>' +
            '<button type="button" data-act="arrived-delivery">Arrived at delivery</button>' +
            obd +
            '<label><input data-k="cash" type="checkbox"> Cash collected</label>' +
            cod +
            '<button type="button" data-act="deliver">Complete delivery</button>' +
            '<button type="button" data-act="cancel-code">Email cancellation code</button>' +
            '<label>Cancellation code<input data-k="code" inputmode="numeric"></label>' +
            '<button type="button" data-act="cancel">Cancel</button>' +
            '<p class="msg" data-msg></p></article>'
        );
    }

    function read(article, key) {
        const el = article.querySelector('[data-k="' + key + '"]');
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    }

    async function act(article, name) {
        const id = article.getAttribute('data-id');
        const msg = article.querySelector('[data-msg]');
        const barcode = read(article, 'barcode');
        try {
            if (name === 'accept') await api('/api/navigator/orders/' + id + '/accept', {});
            if (name === 'start') await api('/api/navigator/orders/' + id + '/arrived', { place: 'start' });
            if (name === 'arrived-pickup') await api('/api/navigator/orders/' + id + '/arrived', { place: 'pickup' });
            if (name === 'arrived-delivery') await api('/api/navigator/orders/' + id + '/arrived', { place: 'delivery' });
            if (name === 'pickup-code') await api('/api/navigator/orders/' + id + '/send-code', { purpose: 'pickup' });
            if (name === 'delivery-code') await api('/api/navigator/orders/' + id + '/send-code', { purpose: 'delivery' });
            if (name === 'obd') await api('/api/navigator/orders/' + id + '/send-code', { purpose: 'obd' });
            if (name === 'cancel-code') await api('/api/navigator/orders/' + id + '/send-code', { purpose: 'cancel' });
            if (name === 'pickup') await api('/api/navigator/orders/' + id + '/pickup', { barcode, otp: read(article, 'otp') });
            if (name === 'deliver') {
                const damaged = read(article, 'damaged');
                await api('/api/navigator/orders/' + id + '/deliver', {
                    barcode,
                    deliveryOtp: read(article, 'deliveryOtp'),
                    damaged: damaged === 'yes' ? true : damaged === 'no' ? false : damaged,
                    mobileLast4: read(article, 'mobileLast4'),
                    obdOtp: read(article, 'obdOtp'),
                    cashReceived: read(article, 'cash') === true
                });
            }
            if (name === 'cancel') await api('/api/navigator/orders/' + id + '/cancel', { code: read(article, 'code') });
            if (name === 'qr') {
                const data = await api('/api/navigator/orders/' + id + '/cod-qr', {});
                const box = article.querySelector('[data-qr]');
                if (data.paid) box.textContent = 'Payment recorded';
                else if (data.imageUrl) box.innerHTML = '<img class="qr" alt="Razorpay QR" src="' + esc(data.imageUrl) + '">';
            }
            if (name === 'paid') {
                const data = await api('/api/navigator/orders/' + id + '/cod-status', {});
                msg.textContent = data.paid ? 'Razorpay payment recorded' : 'Payment is not recorded yet';
                return;
            }
            msg.textContent = 'Saved';
            if (name === 'pickup-code' || name === 'delivery-code' || name === 'obd' || name === 'cancel-code') msg.textContent = 'Code emailed';
        } catch (err) {
            msg.textContent = err.message;
        }
    }

    async function refresh() {
        const data = await api('/api/navigator/work');
        document.getElementById('who').textContent = data.hub ? data.hub.name + (data.hub.city ? ' · ' + data.hub.city : '') : '';
        document.getElementById('login').hidden = true;
        document.getElementById('app').hidden = false;
        const jobs = (data.pickups || []).concat(data.runsheet || []);
        document.getElementById('runsheet').innerHTML = jobs.map((order) => card(order, false)).join('') || '<p class="muted">No pickup or runsheet for this hub today.</p>';
        document.getElementById('offers').innerHTML = (data.offers || []).map((order) => card(order, true)).join('') || '<p class="muted">No hyperlocal orders at this hub.</p>';
    }

    document.getElementById('app').addEventListener('click', (event) => {
        const button = event.target.closest('button[data-act]');
        if (!button) return;
        act(button.closest('article'), button.getAttribute('data-act'));
    });

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

    if (token()) refresh().catch(() => sessionStorage.removeItem(tokenKey));
})();

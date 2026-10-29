(function () {
    const state = { services: [], selected: null };

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function istToday() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }

    function money(price) {
        if (price == null || price === '') return 'Fee at the visit';
        if (Number(price) === 0) return 'No charge';
        return '₹' + Number(price).toLocaleString('en-IN');
    }

    function token() {
        const key = 'vgmf-visit-token';
        let value = '';
        try { value = sessionStorage.getItem(key) || ''; } catch (e) { value = ''; }
        if (value) return value;
        value = 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        try { sessionStorage.setItem(key, value); } catch (e) {}
        return value;
    }

    function fillTimes() {
        const select = document.getElementById('visit-time');
        let html = '';
        for (let hour = 8; hour <= 19; hour++) {
            [0, 30].forEach((minute) => {
                const hh = String(hour).padStart(2, '0');
                const mm = String(minute).padStart(2, '0');
                const labelHour = hour % 12 || 12;
                html += '<option value="' + hh + ':' + mm + '">' + labelHour + ':' + mm + ' ' + (hour < 12 ? 'AM' : 'PM') + '</option>';
            });
        }
        select.innerHTML = html;
    }

    function nextSlot() {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
        const get = (type) => parts.find((part) => part.type === type).value;
        let hour = Number(get('hour'));
        let minute = Number(get('minute')) < 30 ? 30 : 0;
        if (minute === 0) hour += 1;
        let date = get('year') + '-' + get('month') + '-' + get('day');
        if (hour < 8) hour = 8;
        if (hour > 19) {
            const next = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))) + 86400000);
            const pad = (n) => String(n).padStart(2, '0');
            date = next.getUTCFullYear() + '-' + pad(next.getUTCMonth() + 1) + '-' + pad(next.getUTCDate());
            hour = 10;
            minute = 0;
        }
        return { date: date, time: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') };
    }

    function renderServices() {
        const root = document.getElementById('services');
        if (!state.services.length) {
            root.innerHTML = '<section class="card"><h2>No services yet</h2><p>The desk has not published a visit type.</p></section>';
            return;
        }
        root.innerHTML = state.services.map((service) => (
            '<article class="card"><h2>' + esc(service.name) + '</h2><p>' + esc(service.summary || 'A scheduled visit.') + '</p><div class="meta"><span class="pill">' + esc(service.kindLabel) + '</span><span class="pill">' + esc(service.durationMin) + ' min</span><span class="pill">' + esc(money(service.price)) + '</span></div><button class="btn" type="button" data-id="' + esc(service.id) + '">Book this</button></article>'
        )).join('');
        root.querySelectorAll('button[data-id]').forEach((button) => {
            button.addEventListener('click', () => selectService(button.getAttribute('data-id')));
        });
    }

    function selectService(id) {
        state.selected = state.services.find((service) => String(service.id) === String(id)) || null;
        document.getElementById('service-id').value = state.selected ? state.selected.id : '';
        document.getElementById('book-title').textContent = state.selected ? state.selected.name : 'Book a visit';
        document.getElementById('book-summary').textContent = state.selected
            ? state.selected.kindLabel + ' · ' + state.selected.durationMin + ' minutes · ' + money(state.selected.price)
            : 'Select a service to choose a time.';
        document.getElementById('book').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function showBooking(booking) {
        const phone = String(booking.partnerPhone || '').replace(/[^\d+]/g, '');
        const map = booking.partnerLatitude != null && booking.partnerLongitude != null
            ? '<p><a href="https://www.google.com/maps?q=' + encodeURIComponent(booking.partnerLatitude + ',' + booking.partnerLongitude) + '" target="_blank" rel="noopener">Partner location</a></p>'
            : '';
        return '<div class="note"><strong>' + esc(booking.code) + '</strong> · ' + esc(booking.statusLabel) +
            '<br>' + esc(booking.service) + ' · ' + esc(booking.kindLabel) +
            '<br>' + esc(booking.startLabel) + ' to ' + esc(booking.endLabel) +
            '<br>' + esc(booking.address) +
            (booking.partner ? '<br>Partner: ' + esc(booking.partner) + (phone ? ' · <a href="tel:' + esc(phone) + '">Call</a>' : '') : '<br>A partner will be assigned.') +
            (booking.trackingLink ? '<br><a href="' + esc(booking.trackingLink) + '" target="_blank" rel="noopener">Open partner tracking</a>' : '') +
            map +
            (booking.status !== 'cancelled' && booking.status !== 'completed' ? '<p><button class="btn ghost" id="cancel-visit" type="button">Cancel visit</button></p>' : '') +
            '</div>';
    }

    async function post(url, body) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    document.getElementById('book-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const msg = document.getElementById('book-msg');
        const button = document.getElementById('book-btn');
        msg.innerHTML = '';
        if (!document.getElementById('service-id').value) {
            msg.innerHTML = '<div class="err">Choose a service first.</div>';
            return;
        }
        button.disabled = true;
        try {
            const data = await post('/api/public/field/bookings', {
                serviceId: document.getElementById('service-id').value,
                start: document.getElementById('visit-date').value + ' ' + document.getElementById('visit-time').value + ':00',
                name: document.getElementById('visit-name').value,
                phone: document.getElementById('visit-phone').value,
                email: document.getElementById('visit-email').value,
                address: document.getElementById('visit-address').value,
                notes: document.getElementById('visit-notes').value,
                clientToken: token()
            });
            msg.innerHTML = showBooking(data.booking);
            const cancel = document.getElementById('cancel-visit');
            if (cancel) cancel.addEventListener('click', () => cancelVisit(data.booking.code, document.getElementById('visit-phone').value, msg));
        } catch (err) {
            msg.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        } finally {
            button.disabled = false;
        }
    });

    async function cancelVisit(code, phone, msg) {
        if (!window.confirm('Cancel this visit?')) return;
        try {
            const data = await post('/api/public/field/bookings/cancel', { code: code, phone: phone });
            msg.innerHTML = showBooking(data.booking);
        } catch (err) {
            msg.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        }
    }

    document.getElementById('lookup-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const out = document.getElementById('look-out');
        const code = document.getElementById('look-code').value.trim();
        const phone = document.getElementById('look-phone').value;
        try {
            const data = await post('/api/public/field/bookings/lookup', { code: code, phone: phone });
            out.innerHTML = showBooking(data.booking);
            const cancel = document.getElementById('cancel-visit');
            if (cancel) cancel.addEventListener('click', () => cancelVisit(code, phone, out));
        } catch (err) {
            out.innerHTML = '<div class="err">' + esc(err.message) + '</div>';
        }
    });

    fillTimes();
    const slot = nextSlot();
    document.getElementById('visit-date').min = istToday();
    document.getElementById('visit-date').value = slot.date;
    document.getElementById('visit-time').value = slot.time;
    fetch('/api/public/field/services')
        .then((res) => res.json())
        .then((data) => {
            state.services = data.services || [];
            renderServices();
            if (state.services[0]) selectService(state.services[0].id);
        })
        .catch(() => {
            document.getElementById('services').innerHTML = '<section class="card"><p>Services could not be loaded.</p></section>';
        });
})();

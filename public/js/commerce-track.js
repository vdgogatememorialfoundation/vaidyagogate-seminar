(function () {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const sub = document.getElementById('sub');
    const tracker = document.getElementById('tracker');
    let drawn = '';

    function esc(s) {
        return window.TrackTimeline ? TrackTimeline.esc(s) : String(s == null ? '' : s);
    }

    function when(at) {
        return window.TrackTimeline ? TrackTimeline.when(at) : '';
    }

    function render(shipment) {
        const track = shipment.track;
        if (!track || !track.pipeline) {
            sub.textContent = shipment.orderCode || '';
            tracker.textContent = 'No tracking yet.';
            drawn = '';
            return;
        }
        sub.textContent = '';
        const live = track.map.enabled ? shipment.live : null;
        const sig = JSON.stringify(track) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.leg ? live.leg : '') + '|' + (live && live.route ? live.route : '');
        if (sig !== drawn) {
            drawn = sig;
            const partner = track.agent
                ? '<div class="ship-card"><div class="lbl">Delivery partner</div><div class="val">' + esc(track.agent.name || 'Assigned') + '</div>' +
                  (track.agent.phone ? '<a class="call" href="tel:' + esc(track.agent.phone) + '">Call</a>' : '') +
                  '</div>'
                : track.mainStatus === 'OUT_FOR_DELIVERY' && track.operationalStatus !== 'DELIVERY_ATTEMPT_FAILED'
                  ? '<div class="ship-card"><div class="lbl">Delivery partner</div><div class="val">Finding a delivery partner</div></div>'
                  : '';
            const slots = (track.slots || [])
                .map(
                    (slot, i) =>
                        '<label class="ship-slot"><input type="radio" name="slot" value="' + i + '"' + (i === 0 ? ' checked' : '') +
                        ' data-date="' + esc(slot.date) + '" data-start="' + esc(slot.start) + '" data-end="' + esc(slot.end) + '"> ' +
                        esc(slot.label || slot.start + ' – ' + slot.end) + '</label>'
                )
                .join('');
            const hours = track.deliveryHours ? 'Store delivery hours ' + esc(track.deliveryHours.open) + ' – ' + esc(track.deliveryHours.close) + '.' : '';
            const failure = track.operationalStatus === 'DELIVERY_ATTEMPT_FAILED'
                ? '<div class="ship-fail"><b>Delivery attempt unsuccessful</b><p>' + esc(track.currentDetail || '') + '</p>' +
                  (hours ? '<p class="muted">' + hours + '</p>' : '') +
                  (track.fulfillmentType === 'HYPERLOCAL' && slots
                      ? '<form id="reschedule-form"><p class="muted">Choose a new delivery time</p>' + slots +
                        '<label class="ship-slot"><input type="radio" name="slot" value="custom"> Choose another time</label>' +
                        '<div class="tl-custom" hidden><input type="date" name="date"><input type="time" name="start"><input type="time" name="end"></div>' +
                        '<button type="submit">Reschedule delivery</button><p class="form-msg" id="reschedule-msg"></p></form>'
                      : '') +
                  '<a class="call" href="' + esc(track.supportUrl || '/support') + '">Get help</a></div>'
                : '';
            const child = (ev) =>
                '<li class="ship-sub' + (ev.tone ? ' ' + esc(ev.tone) : '') + '"><b>' + esc(ev.message) + '</b>' +
                (ev.at ? '<div class="when">' + esc(when(ev.at)) + '</div>' : '') +
                (ev.location ? '<div class="where">' + esc(ev.location) + '</div>' : '') +
                (ev.reason ? '<div class="where">Reason: ' + esc(ev.reason) + '</div>' : '') +
                '</li>';
            const pipe = (track.pipeline || [])
                .map((step) => {
                    const kids = (step.events || []).map(child).join('');
                    const shippedNote = step.key === 'SHIPPED' && step.state !== 'upcoming' && track.shipment
                        ? '<li class="ship-sub"><b>' + esc(track.shipment.courier || 'Gogate Products') + '</b><div class="where">' +
                          esc(track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal' : 'Logistics') +
                          (track.shipment.trackingId ? ' · Tracking ID ' + esc(track.shipment.trackingId) : '') +
                          '</div></li>'
                        : '';
                    return '<li class="' + esc(step.state) + '"><span class="dot"></span><b>' + esc(step.title) + '</b>' +
                        (kids || shippedNote ? '<ul class="ship-kids">' + kids + shippedNote + '</ul>' : '') +
                        '</li>';
                })
                .join('');
            const otp = (label, code) =>
                code ? '<div class="ship-otp"><div class="lbl">' + esc(label) + '</div><div class="code">' + esc(code) + '</div></div>' : '';
            const tracking = track.shipment && track.shipment.trackingId
                ? '<div class="ship-card"><div class="lbl">Tracking ID</div><div class="val">' + esc(track.shipment.trackingId) + '</div></div>'
                : '';
            tracker.innerHTML =
                '<div class="ship">' +
                '<div class="ship-head"><div class="kicker">Order #' + esc(track.orderId || shipment.orderCode || '') + '</div>' +
                '<h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
                (track.currentDetail || (track.expectedDelivery && track.expectedDelivery.label)
                    ? '<p class="expect">' + esc(track.currentDetail || track.expectedDelivery.label) + '</p>'
                    : '') +
                '</div>' +
                failure +
                '<div class="ship-grid"><div>' +
                '<ol class="ship-pipe">' + pipe + '</ol>' +
                (track.map.enabled ? '<div class="ship-card"><div class="lbl">' + (track.map.live ? 'Live delivery tracking' : 'Store and delivery location') + '</div>' +
                  (track.map.live ? '<div id="tl-eta" class="muted">Delivery partner is on the way.</div>' : '<div class="muted">The route stays dotted until a delivery partner location arrives.</div>') +
                  '<div id="tl-map-slot"></div></div>' : '') +
                '</div>' +
                '<aside>' +
                '<div class="ship-card"><div class="lbl">Courier</div><div class="val">' + esc((track.shipment && track.shipment.courier) || 'Gogate Products') + '</div>' +
                '<div class="muted">' + esc(track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal delivery' : 'Logistics') + '</div></div>' +
                tracking + partner + otp('Pickup OTP', track.pickupOtp) + otp('Delivery OTP', track.deliveryOtp) +
                '</aside></div></div>';
        }
        const form = document.getElementById('reschedule-form');
        if (form && !form.dataset.bound) {
            form.dataset.bound = '1';
            form.addEventListener('change', () => {
                const custom = form.querySelector('input[value="custom"]');
                const box = form.querySelector('.tl-custom');
                if (box) box.hidden = !(custom && custom.checked);
            });
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const msg = document.getElementById('reschedule-msg');
                const picked = form.querySelector('input[name="slot"]:checked');
                let date = '';
                let start = '';
                let end = '';
                if (picked && picked.value === 'custom') {
                    date = (form.querySelector('input[name="date"]') || {}).value || '';
                    start = (form.querySelector('input[name="start"]') || {}).value || '';
                    end = (form.querySelector('input[name="end"]') || {}).value || '';
                } else if (picked) {
                    date = picked.getAttribute('data-date') || '';
                    start = picked.getAttribute('data-start') || '';
                    end = picked.getAttribute('data-end') || '';
                }
                if (!date || !start || !end) {
                    if (msg) msg.textContent = 'Choose a delivery time.';
                    return;
                }
                if (msg) msg.textContent = 'Updating the delivery…';
                try {
                    const res = await fetch('/api/public/commerce/reschedule', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token, date, start, end })
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        if (msg) msg.textContent = data.error || 'Could not reschedule.';
                        return;
                    }
                    drawn = '';
                    poll();
                } catch (err) {
                    if (msg) msg.textContent = 'Could not reschedule.';
                }
            });
        }
        if (live && window.TrackTimeline) TrackTimeline.mount(live);
    }

    async function poll() {
        if (!token) {
            sub.textContent = 'This tracking link is missing a token.';
            return;
        }
        try {
            const res = await fetch('/api/public/commerce/track?token=' + encodeURIComponent(token));
            const data = await res.json();
            if (!res.ok) {
                sub.textContent = data.error || 'Shipment not found.';
                return;
            }
            render(data.shipment || {});
        } catch (e) {
            sub.textContent = 'Could not refresh tracking.';
        }
    }

    poll();
    setInterval(poll, 8000);
})();

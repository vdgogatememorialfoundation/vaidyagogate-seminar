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

    function hyperLive(track) {
        return !!(track && track.fulfillmentType === 'HYPERLOCAL' && track.map && track.map.enabled);
    }

    function partnerLine(track) {
        const name = track.agent && track.agent.name;
        if (name && track.map.live) return name + ' is on the way to deliver your order';
        if (name) return name + ' is assigned to this order';
        if (track.agent && track.agent.phone) return 'A delivery partner is assigned to this order';
        return 'Finding a delivery partner';
    }

    function telHref(phone) {
        const clean = String(phone || '').replace(/[^\d+]/g, '');
        return clean ? 'tel:' + clean : '';
    }

    function pipeHtml(track) {
        const child = (ev) =>
            '<li class="ship-sub' + (ev.tone ? ' ' + esc(ev.tone) : '') + '"><b>' + esc(ev.message) + '</b>' +
            (ev.at ? '<div class="when">' + esc(when(ev.at)) + '</div>' : '') +
            (ev.location ? '<div class="where">' + esc(ev.location) + '</div>' : '') +
            (ev.reason ? '<div class="where">Reason: ' + esc(ev.reason) + '</div>' : '') +
            '</li>';
        return (track.pipeline || [])
            .map((step, i) => {
                const kids = (step.events || []).map(child).join('');
                const shippedNote = step.key === 'SHIPPED' && step.state !== 'upcoming' && track.shipment
                    ? '<li class="ship-sub"><b>' + esc(track.shipment.courier || 'Gogate Products') + '</b><div class="where">' +
                      esc(track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal' : 'Logistics') +
                      (track.shipment.trackingId ? ' · Tracking ID ' + esc(track.shipment.trackingId) : '') +
                      '</div></li>'
                    : '';
                const grow = step.state === 'active' ? (step.lineGrow != null ? step.lineGrow : '0.55') : '1';
                const tick = step.state === 'active' && step.lineUntil
                    ? ' data-line-since="' + Number(step.lineSince) + '" data-line-until="' + Number(step.lineUntil) + '"'
                    : '';
                return '<li class="' + esc(step.state) + '"' + tick + ' style="--i:' + i + ';--grow:' + grow + '"><span class="dot"></span><b>' + esc(step.title) + '</b>' +
                    (step.expectedLabel ? '<span class="ship-expect">' + esc(step.expectedLabel) + '</span>' : '') +
                    (kids || shippedNote ? '<ul class="ship-kids">' + kids + shippedNote + '</ul>' : '') +
                    '</li>';
            })
            .join('');
    }

    function progressHtml(track) {
        return '<h2 class="hl-progress-title">Order progress</h2><ol class="ship-pipe">' + pipeHtml(track) + '</ol>';
    }

    function deliveryHtml(track) {
        return track && track.deliveryBy
            ? '<div class="hl-drop"><div class="lbl">Delivery by</div><div class="val">' + esc(track.deliveryBy) + '</div></div>'
            : '';
    }

    function tickPipe() {
        document.querySelectorAll('.ship-pipe > li.active[data-line-until]').forEach((el) => {
            const since = Number(el.getAttribute('data-line-since'));
            const until = Number(el.getAttribute('data-line-until'));
            if (!until || until <= since) return;
            const now = Date.now();
            const ratio = now <= since ? 0.12 : Math.min(1, (now - since) / (until - since));
            el.style.setProperty('--grow', String(Math.min(0.55, Math.max(0.12, Math.round(ratio * 100) / 100))));
        });
    }

    function otpHtml(label, code) {
        return code ? '<div class="ship-otp"><div class="lbl">' + esc(label) + '</div><div class="code">' + esc(code) + '</div></div>' : '';
    }

    function failureHtml(track) {
        const slots = (track.slots || [])
            .map(
                (slot, i) =>
                    '<label class="ship-slot"><input type="radio" name="slot" value="' + i + '"' + (i === 0 ? ' checked' : '') +
                    ' data-date="' + esc(slot.date) + '" data-start="' + esc(slot.start) + '" data-end="' + esc(slot.end) + '"> ' +
                    esc(slot.label || slot.start + ' – ' + slot.end) + '</label>'
            )
            .join('');
        const hours = track.deliveryHours ? 'Store delivery hours ' + esc(track.deliveryHours.open) + ' – ' + esc(track.deliveryHours.close) + '.' : '';
        if (track.operationalStatus !== 'DELIVERY_ATTEMPT_FAILED') return '';
        return '<div class="ship-fail"><b>Delivery attempt unsuccessful</b><p>' + esc(track.currentDetail || '') + '</p>' +
            (hours ? '<p class="muted">' + hours + '</p>' : '') +
            (track.fulfillmentType === 'HYPERLOCAL' && slots
                ? '<form id="reschedule-form"><p class="muted">Choose a new delivery time</p>' + slots +
                  '<label class="ship-slot"><input type="radio" name="slot" value="custom"> Choose another time</label>' +
                  '<div class="tl-custom" hidden><input type="date" name="date"><input type="time" name="start"><input type="time" name="end"></div>' +
                  '<button type="submit">Reschedule delivery</button><p class="form-msg" id="reschedule-msg"></p></form>'
                : '') +
            '<a class="call" href="' + esc(track.supportUrl || '/support') + '">Get help</a></div>';
    }

    function documentHtml(track, shipment) {
        const courier = (track.shipment && track.shipment.courier) || 'Gogate Products';
        const mode = track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal delivery' : 'Logistics';
        const detail = track.currentDetail || track.currentMessage || '';
        const tracking = track.shipment && track.shipment.trackingId
            ? '<div class="hl-drop"><div class="lbl">Tracking ID</div><div class="val">' + esc(track.shipment.trackingId) + '</div></div>'
            : '';
        return '<div class="hl"><section class="hl-sheet hl-sheet-flat">' +
            '<div class="hl-kicker">Order #' + esc(track.orderId || shipment.orderCode || '') + '</div>' +
            '<div class="hl-top"><div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            (detail ? '<p class="hl-sub">' + esc(detail) + '</p>' : '') +
            '</div></div>' +
            '<div class="hl-drop"><div class="lbl">Courier</div><div class="val">' + esc(courier) + '</div><div class="hl-note-hint">' + esc(mode) + '</div></div>' +
            tracking +
            deliveryHtml(track) +
            failureHtml(track) +
            '</section><div class="hl-below">' +
            otpHtml('Pickup OTP', track.pickupOtp) + otpHtml('Delivery OTP', track.deliveryOtp) +
            progressHtml(track) +
            '</div></div>';
    }

    function sheetHtml(track, shipment) {
        const name = track.agent && track.agent.name;
        const phone = track.agent && track.agent.phone;
        const href = telHref(phone);
        const initial = name ? name.trim().charAt(0).toUpperCase() : '';
        const note = track.deliveryNote || '';
        const call = href
            ? '<a class="hl-call" href="' + esc(href) + '" aria-label="Call delivery partner"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.6 1 1 0 01-.25 1L6.6 10.8z"/></svg></a>'
            : '';
        const bike =
            '<span class="hl-bike" aria-hidden="true"><svg viewBox="0 0 64 64" width="28" height="28"><circle cx="16" cy="44" r="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="48" cy="44" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 44h14l8-16h10M28 28l6 16M36 18h8l6 10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
        const partner = name || href
            ? '<div class="hl-partner">' +
              bike +
              (name ? '<span class="hl-avatar" aria-hidden="true">' + esc(initial) + '</span><span class="hl-partner-name">' + esc(name) + '</span>' : '<span class="hl-partner-name">Delivery partner</span>') +
              call + '</div>'
            : '<div class="hl-partner">' + bike + '<span class="hl-partner-name">Finding a delivery partner</span></div>';
        const map = shipment.live
            ? '<div class="hl-map"><div id="tl-map-slot"></div></div>'
            : '<div class="hl-map hl-map-empty">The map appears when the store and delivery locations are available.</div>';
        return '<div class="hl hl-wide">' + map +
            '<section class="hl-sheet">' +
            '<div class="hl-kicker">Order #' + esc(track.orderId || shipment.orderCode || '') + '</div>' +
            '<div class="hl-top"><div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            '<p class="hl-sub">' + esc(partnerLine(track)) + '</p>' +
            (track.map.live ? '' : '<p class="hl-wait">The route stays dotted until a delivery partner location arrives.</p>') +
            '</div><div id="tl-eta" class="hl-eta" hidden></div></div>' +
            (track.dropLabel ? '<div class="hl-drop"><div class="lbl">Delivering to</div><div class="val">' + esc(track.dropLabel) + '</div></div>' : '') +
            deliveryHtml(track) +
            '<div class="hl-note"><button type="button" class="hl-note-toggle" id="hl-note-toggle"><span class="hl-plus" aria-hidden="true">+</span><span><b>' +
            (note ? 'Delivery instructions' : 'Add delivery instructions') + '</b>' +
            (note ? '<span class="hl-note-text">' + esc(note) + '</span>' : '<span class="hl-note-hint">Saved with your order</span>') +
            '</span></button><form id="hl-note-form" hidden><textarea name="note" maxlength="240" placeholder="Gate, floor, or where to leave the order">' +
            esc(note) + '</textarea><div class="hl-note-actions"><button type="submit">Save</button><button type="button" id="hl-note-cancel">Cancel</button></div><p class="form-msg" id="hl-note-msg"></p></form></div>' +
            partner +
            '</section><div class="hl-below">' +
            otpHtml('Pickup OTP', track.pickupOtp) + otpHtml('Delivery OTP', track.deliveryOtp) +
            progressHtml(track) +
            '</div></div>';
    }

    function render(shipment) {
        const track = shipment.track;
        if (!track || !track.pipeline) {
            document.body.classList.remove('hl-page');
            sub.textContent = shipment.orderCode || '';
            tracker.textContent = 'No tracking yet.';
            drawn = '';
            return;
        }
        sub.textContent = '';
        const liveSheet = hyperLive(track);
        document.body.classList.add('hl-page');
        const live = track.map.enabled ? shipment.live : null;
        const editing = document.getElementById('hl-note-form');
        const sig = JSON.stringify(track) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.leg ? live.leg : '') + '|' + (live && live.route ? live.route : '');
        if (!(editing && !editing.hidden) && sig !== drawn) {
            drawn = sig;
            tracker.innerHTML = liveSheet ? sheetHtml(track, shipment) : documentHtml(track, shipment);
        }
        bindReschedule();
        bindNote();
        if (live && window.TrackTimeline) TrackTimeline.mount(live);
    }

    function bindReschedule() {
        const form = document.getElementById('reschedule-form');
        if (!form || form.dataset.bound) return;
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

    function bindNote() {
        const toggle = document.getElementById('hl-note-toggle');
        const form = document.getElementById('hl-note-form');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';
        const open = (show) => {
            form.hidden = !show;
            if (toggle) toggle.hidden = show;
        };
        if (toggle) toggle.addEventListener('click', () => open(true));
        const cancel = document.getElementById('hl-note-cancel');
        if (cancel) cancel.addEventListener('click', () => open(false));
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const msg = document.getElementById('hl-note-msg');
            const note = ((form.querySelector('textarea[name="note"]') || {}).value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            if (msg) msg.textContent = 'Saving…';
            try {
                const res = await fetch('/api/public/commerce/delivery-note', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, note })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (msg) msg.textContent = data.error || 'Could not save the instructions.';
                    return;
                }
                drawn = '';
                poll();
            } catch (err) {
                if (msg) msg.textContent = 'Could not save the instructions.';
            }
        });
    }

    async function poll() {
        if (!token) {
            document.body.classList.remove('hl-page');
            sub.textContent = 'This tracking link is missing a token.';
            return;
        }
        try {
            const res = await fetch('/api/public/commerce/track?token=' + encodeURIComponent(token));
            const data = await res.json();
            if (!res.ok) {
                document.body.classList.remove('hl-page');
                sub.textContent = data.error || 'Shipment not found.';
                return;
            }
            const shipment = data.shipment || {};
            if (document.body.getAttribute('data-track') === 'fleetbase' && shipment.commerceProvider !== 'fleetbase') {
                document.body.classList.remove('hl-page');
                sub.textContent = 'This Fleetbase tracking link does not match a Fleetbase shipment.';
                tracker.innerHTML = '';
                return;
            }
            render(shipment);
        } catch (e) {
            sub.textContent = 'Could not refresh tracking.';
        }
    }

    poll();
    setInterval(poll, 8000);
    setInterval(tickPipe, 2000);
})();

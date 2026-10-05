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

    function placeLine(ev) {
        return [ev.facilityName, ev.city, ev.state, ev.country].filter(Boolean).join(', ');
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
            const pipe = track.pipeline
                .map((step) => '<li class="' + esc(step.state) + '"><span class="dot"></span><b>' + esc(step.title) + '</b></li>')
                .join('');
            const events = (track.timeline || [])
                .map((ev) => {
                    const where = placeLine(ev);
                    return (
                        '<li><b>' + esc(ev.heading) + '</b><div>' + esc(ev.message) + '</div>' +
                        (ev.at ? '<div class="when">' + esc(when(ev.at)) + '</div>' : '') +
                        (where ? '<div class="where">' + esc(where) + '</div>' : '') +
                        '</li>'
                    );
                })
                .join('');
            const partner = track.agent
                ? '<div class="ship-card"><div class="lbl">Delivery partner</div><div class="val">' + esc(track.agent.name || 'Assigned') + '</div>' +
                  (track.agent.phone ? '<a class="call" href="tel:' + esc(track.agent.phone) + '">Call ' + esc(track.agent.phone) + '</a>' : '') +
                  '</div>'
                : '';
            const otp = (label, code) =>
                code ? '<div class="ship-otp"><div class="lbl">' + esc(label) + '</div><div class="code">' + esc(code) + '</div></div>' : '';
            const tracking = track.shipment && track.shipment.trackingId
                ? '<div class="ship-card"><div class="lbl">Tracking ID</div><div class="val">' + esc(track.shipment.trackingId) + '</div></div>'
                : '';
            tracker.innerHTML =
                '<div class="ship">' +
                '<div class="ship-head"><div class="kicker">Order #' + esc(track.orderId || shipment.orderCode || '') + '</div>' +
                '<h1>' + esc(track.currentMessage) + '</h1>' +
                '<p class="expect">' + (track.expectedDelivery ? esc(track.expectedDelivery) : 'The delivery window appears when the courier sends one.') + '</p></div>' +
                '<div class="ship-grid"><div>' +
                '<ol class="ship-pipe">' + pipe + '</ol>' +
                (track.map.enabled ? '<div class="ship-card"><div class="lbl">Live map</div><div id="tl-map-slot"></div></div>' : '') +
                '<h2>Updates</h2><ol class="ship-events">' + (events || '<li>No updates yet.</li>') + '</ol></div>' +
                '<aside>' +
                '<div class="ship-card"><div class="lbl">Courier</div><div class="val">' + esc((track.shipment && track.shipment.courier) || 'Gogate Products') + '</div>' +
                '<div class="muted">' + esc(track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal delivery' : 'Logistics') + '</div></div>' +
                tracking + partner + otp('Pickup OTP', track.pickupOtp) + otp('Delivery OTP', track.deliveryOtp) +
                '</aside></div></div>';
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

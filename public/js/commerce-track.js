(function () {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const sub = document.getElementById('sub');
    const tracker = document.getElementById('tracker');
    let drawn = '';

    function render(shipment) {
        const t = shipment.timeline;
        sub.textContent = shipment.orderCode + (t && t.cancelled ? ' · Cancelled' : '');
        if (!t) {
            tracker.textContent = 'No tracking yet.';
            drawn = '';
            return;
        }
        const live = shipment.live;
        const sig = JSON.stringify(t) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.leg ? live.leg : '');
        if (sig !== drawn) {
            drawn = sig;
            tracker.innerHTML = TrackTimeline.render(
                { timeline: t, live: shipment.live, awbTrackUrl: shipment.awbTrackUrl },
                { animate: false }
            );
        }
        TrackTimeline.mount(shipment.live);
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

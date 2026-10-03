(function () {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const sub = document.getElementById('sub');
    const summary = document.getElementById('summary');
    const eventsEl = document.getElementById('events');
    const mapCard = document.getElementById('map-card');

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function when(at) {
        if (!at) return '';
        const d = new Date(at);
        if (isNaN(d.getTime())) return String(at);
        return new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(d);
    }

    function stageLabel(stage) {
        const map = {
            placed: 'Order placed',
            accepted: 'Order accepted',
            preparing: 'Being prepared',
            ready: 'Ready for pickup',
            pickup_scheduled: 'Pickup scheduled',
            in_transit: 'In transit',
            out_for_delivery: 'Out for delivery',
            delivered: 'Delivered'
        };
        return map[stage] || stage || 'Order placed';
    }

    function render(shipment) {
        sub.textContent = shipment.orderCode + ' · ' + stageLabel(shipment.commerceStage);
        const otp =
            shipment.deliveryOtp && shipment.commerceStage !== 'placed'
                ? '<p>Delivery OTP <span class="otp">' + esc(shipment.deliveryOtp) + '</span></p>'
                : '';
        const agent = shipment.agentPhone
            ? '<p>Agent ' + esc(shipment.agentName || '') + ' · ' + esc(shipment.agentPhone) + '</p>'
            : '';
        summary.innerHTML = otp + agent + (shipment.destination ? '<p class="muted">' + esc(shipment.destination) + '</p>' : '');
        eventsEl.innerHTML = (shipment.events || [])
            .map(
                (ev) =>
                    '<div class="ev"><strong>' +
                    esc(ev.title) +
                    '</strong><span class="muted">' +
                    esc(when(ev.at)) +
                    (ev.city ? ' · ' + esc(ev.city) : '') +
                    (ev.detail ? ' · ' + esc(ev.detail) : '') +
                    '</span></div>'
            )
            .join('') || '<p class="muted">Waiting for the first carrier scan.</p>';
        if (shipment.liveMap) {
            mapCard.style.display = '';
            mount(shipment);
        }
    }

    function mount(shipment) {
        if (!shipment.mapsApiKey) {
            document.getElementById('map').innerHTML =
                '<p style="padding:12px;">Live driver navigation appears when a Google Maps key is saved in Commerce settings.</p>';
            return;
        }
        window.__publicCommerce = shipment;
        const boot = () => draw(shipment);
        if (window.google && window.google.maps) return boot();
        if (document.getElementById('pub-maps')) return;
        window.__publicCommerceBoot = boot;
        const s = document.createElement('script');
        s.id = 'pub-maps';
        s.async = true;
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(shipment.mapsApiKey) + '&callback=__publicCommerceBoot';
        document.body.appendChild(s);
    }

    function draw(shipment) {
        const el = document.getElementById('map');
        const store = shipment.storeLat != null ? { lat: Number(shipment.storeLat), lng: Number(shipment.storeLng) } : null;
        const drop = shipment.dropLat != null ? { lat: Number(shipment.dropLat), lng: Number(shipment.dropLng) } : null;
        const agent = shipment.agentLat != null ? { lat: Number(shipment.agentLat), lng: Number(shipment.agentLng) } : null;
        const center = agent || store || drop;
        if (!center) return;
        if (!el.__map) {
            el.__map = new google.maps.Map(el, { center, zoom: 13, mapTypeControl: false, streetViewControl: false });
            el.__dir = new google.maps.DirectionsRenderer({ map: el.__map, suppressMarkers: true });
            el.__markers = {};
        }
        function pin(key, pos, title) {
            if (!pos) return;
            if (!el.__markers[key]) el.__markers[key] = new google.maps.Marker({ map: el.__map, title });
            el.__markers[key].setPosition(pos);
        }
        pin('store', store, 'Store');
        pin('drop', drop, 'Delivery');
        pin('agent', agent, 'Driver');
        const target = shipment.liveLeg === 'to_store' ? store : drop;
        if (agent && target) {
            new google.maps.DirectionsService().route(
                { origin: agent, destination: target, travelMode: 'DRIVING' },
                (result, status) => {
                    if (status === 'OK') el.__dir.setDirections(result);
                }
            );
        }
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
    setInterval(poll, 12000);
})();

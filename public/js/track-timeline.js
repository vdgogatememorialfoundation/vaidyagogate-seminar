/**
 * Shared milestone tracker (Ordered, Packed, Shipped, Out for delivery, Delivered)
 * used by the private shop, the Commerce desk and the public tracking link.
 */
(function () {
    let mapEl = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function parseWhen(at) {
        if (!at) return null;
        let v = String(at);
        if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(v)) v = v.replace(' ', 'T') + 'Z';
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }

    function when(at, withTime) {
        const d = parseWhen(at);
        if (!d) return at ? String(at) : '';
        const opts = { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
        if (withTime !== false) {
            opts.hour = '2-digit';
            opts.minute = '2-digit';
        }
        return new Intl.DateTimeFormat('en-IN', opts).format(d);
    }

    function updates(list) {
        if (!list || !list.length) return '';
        const ordered = list.slice().reverse();
        return (
            '<ul class="tl-sub">' +
            ordered
                .map(
                    (u, i) =>
                        '<li' + (i === ordered.length - 1 ? ' class="tl-current"' : '') + '><b>' + esc(u.title) + '</b><span>' + esc(when(u.at)) + (u.city ? ' · ' + esc(u.city) : '') + (u.detail ? ' · ' + esc(u.detail) : '') + '</span></li>'
                )
                .join('') +
            '</ul>'
        );
    }

    function partnerCard(p, awbUrl, label) {
        return (
            '<div class="tl-card"><div><div class="lbl">' + esc(label || 'Courier partner') + '</div><div class="val">' + esc(p.name) + '</div><div class="tl-note" style="margin:0">' + esc(p.service) + '</div></div>' +
            (p.trackingNo ? '<div><div class="lbl">Tracking / AWB</div><div class="val">' + esc(p.trackingNo) + '</div></div>' : '') +
            '</div>'
        );
    }

    function extra(step, data) {
        let html = '';
        if (step.key === 'packed' && step.pickup) {
            const pk = step.pickup;
            html += partnerCard(pk.partner, null, pk.collected ? 'Collected by' : 'Pickup requested from');
            if (!pk.collected) html += '<div class="tl-note">Waiting for the courier partner to collect the shipment from the store.</div>';
            if (pk.agent) {
                html +=
                    '<div class="tl-card"><div><div class="lbl">Pickup agent</div><div class="val">' + esc(pk.agent.name || 'Assigned') + '</div></div>' +
                    (pk.agent.phone ? '<div><div class="lbl">Phone</div><div class="val"><a href="tel:' + esc(pk.agent.phone) + '">' + esc(pk.agent.phone) + '</a></div></div>' : '') + '</div>';
            }
            if (pk.pickupOtp) {
                html += '<div class="tl-otps"><div class="tl-otp"><div class="lbl">Pickup OTP</div><div class="code">' + esc(pk.pickupOtp) + '</div></div></div><div class="tl-note">Store staff: the courier agent must quote this at handover.</div>';
            }
        }
        if (step.key === 'shipped' && step.partner) {
            html += partnerCard(step.partner, null);
            if (!step.updates.length && step.state !== 'done') html += '<div class="tl-note">Shipped starts when the parcel is scanned at the local hub.</div>';
        }
        if (step.key === 'out_for_delivery' && step.agent) {
            const a = step.agent;
            html +=
                '<div class="tl-card"><div><div class="lbl">Delivery agent</div><div class="val">' + esc(a.name || 'Assigned shortly') + '</div></div>' +
                '<div><div class="lbl">Agent phone</div><div class="val">' + (a.phone ? '<a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + '</a>' : 'Not available yet') + '</div></div></div>' +
                '<div class="tl-otps">' +
                (a.pincode ? '<div class="tl-otp"><div class="lbl">Delivery PIN code</div><div class="code pin">' + esc(a.pincode) + '</div></div>' : '') +
                (step.deliveryOtp ? '<div class="tl-otp"><div class="lbl">Delivery OTP</div><div class="code">' + esc(step.deliveryOtp) + '</div></div>' : '') +
                '</div>' +
                (step.deliveryOtp
                    ? '<div class="tl-note">' +
                      (step.otpEarly ? 'Not yet out for delivery. ' : '') +
                      'The customer shares this OTP with the delivery agent only at handover.</div>'
                    : '');
        }
        if (data.live && data.live.slot === step.key) {
            const done = data.live.leg === 'done';
            html +=
                '<div class="tl-live">' + (done ? 'Delivery route' : 'Live driver map') + '</div>' +
                '<div class="tl-note">' +
                (done
                    ? 'The route from the store to the delivery location is shown here.'
                    : 'The driver and the route from the store to the delivery location stay on this map.') +
                '</div><div id="tl-map-slot"></div>';
        } else if (step.key === 'out_for_delivery' && step.agent && step.liveMapAvailable && !data.live) {
            html += '<div class="tl-note">The driver map appears here when a location is available.</div>';
        }
        return html;
    }

    /** data: { timeline, live, awbTrackUrl, trackUrl }; opts: { animate } */
    function render(data, opts) {
        const t = data.timeline;
        if (!t) return '';
        const animate = !opts || opts.animate !== false;
        return (
            '<div class="tl' + (animate ? '' : ' tl-static') + '">' +
            t.steps
                .map(
                    (s, i) =>
                        '<div class="tl-step ' + s.state + '" style="--i:' + i + '"><div class="tl-dot">' + (s.state === 'done' ? '&#10003;' : '') + '</div>' +
                        '<div class="tl-title">' + esc(s.title) + (s.at && s.state !== 'upcoming' ? '<span class="tl-time">' + esc(when(s.at)) + '</span>' : '') + '</div>' +
                        (s.summary ? '<div class="tl-sum">' + esc(s.summary) + '</div>' : '') +
                        extra(s, data) +
                        updates(s.updates) +
                        '</div>'
                )
                .join('') +
            '</div>'
        );
    }

    /** Call after the rendered HTML is in the page. */
    function mount(live) {
        if (!live) return;
        if (mapEl && mapEl.isConnected && mapEl.__map) return paint(live);
        const slot = document.getElementById('tl-map-slot');
        if (!slot) return;
        if (!mapEl) {
            mapEl = document.createElement('div');
            mapEl.className = 'tl-map';
        }
        slot.replaceWith(mapEl);
        if (!live.mapsApiKey) {
            mapEl.textContent = 'Live map needs a Google Maps key in Commerce settings.';
            return;
        }
        const run = () => paint(live);
        if (window.google && window.google.maps) return run();
        window.__tlMapBoot = run;
        if (document.getElementById('tl-maps-js')) return;
        const s = document.createElement('script');
        s.id = 'tl-maps-js';
        s.async = true;
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(live.mapsApiKey) + '&callback=__tlMapBoot';
        document.body.appendChild(s);
    }

    function paint(live) {
        const el = mapEl;
        if (!el) return;
        const center = live.agent || live.store || live.drop;
        if (!center) {
            el.textContent = 'Waiting for the driver location...';
            return;
        }
        if (!el.__map) {
            el.textContent = '';
            el.__map = new google.maps.Map(el, {
                center,
                zoom: 14,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                styles: [
                    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
                    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
                    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#e2e8f0' }] },
                    { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#99f6e4' }] },
                    { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f8fafc' }] }
                ]
            });
            el.__dir = new google.maps.DirectionsRenderer({
                map: el.__map,
                suppressMarkers: true,
                polylineOptions: { strokeColor: '#0f766e', strokeWeight: 5, strokeOpacity: 0.95 }
            });
            el.__markers = {};
        }
        const bounds = new google.maps.LatLngBounds();
        const pin = (key, pos, title, label) => {
            if (!pos) {
                if (el.__markers[key]) {
                    el.__markers[key].setMap(null);
                    delete el.__markers[key];
                }
                return;
            }
            bounds.extend(pos);
            if (!el.__markers[key]) el.__markers[key] = new google.maps.Marker({ map: el.__map, title, label });
            el.__markers[key].setMap(el.__map);
            el.__markers[key].setPosition(pos);
            el.__markers[key].setLabel(label);
        };
        pin('store', live.store, 'Store', 'S');
        pin('drop', live.drop, 'Delivery location', 'H');
        pin('agent', live.agent, 'Driver', 'D');
        if (!bounds.isEmpty()) el.__map.fitBounds(bounds, 48);
        let origin = null;
        let target = null;
        if (live.leg === 'done' || !live.agent) {
            origin = live.store;
            target = live.drop;
        } else if (live.leg === 'to_store') {
            origin = live.agent;
            target = live.store || live.drop;
        } else {
            origin = live.agent;
            target = live.drop || live.store;
        }
        const key = JSON.stringify([origin, target, live.leg]);
        if (origin && target && el.__routeKey !== key) {
            el.__routeKey = key;
            new google.maps.DirectionsService().route({ origin, destination: target, travelMode: 'DRIVING' }, (result, status) => {
                if (status === 'OK' && el.__dir) el.__dir.setDirections(result);
            });
        }
    }

    window.TrackTimeline = { render, mount, when, esc, updates };
})();

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
                .map((u, i) => {
                    const cls = u.tone === 'failed' ? 'tl-failed' : u.tone === 'rescheduled' ? 'tl-rescheduled' : i === ordered.length - 1 ? 'tl-current' : '';
                    const place = u.city ? '<div>' + esc(u.city) + '</div>' : '';
                    const reason = u.tone === 'failed' && u.detail ? '<div>Reason: ' + esc(u.detail) + '</div>' : u.detail && u.tone !== 'failed' ? '<div>' + esc(u.detail) + '</div>' : '';
                    return '<li' + (cls ? ' class="' + cls + '"' : '') + '><b>' + esc(u.title) + '</b><span>' + esc(when(u.at)) + '</span>' + place + reason + '</li>';
                })
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
        if (step.key === 'out_for_delivery' && step.operational === 'DELIVERY_ATTEMPT_FAILED') {
            const slots = step.reschedule && step.reschedule.slots ? step.reschedule.slots : [];
            html += '<div class="tl-warn"><b>Delivery attempt unsuccessful</b><div>We couldn\'t deliver your order today. Please choose a new delivery time.</div>';
            if (step.reschedule && step.reschedule.token && slots.length) {
                html += '<form id="tl-reschedule-form" data-token="' + esc(step.reschedule.token) + '">';
                slots.forEach((slot, i) => {
                    html +=
                        '<label class="ship-slot"><input type="radio" name="slot" value="' + i + '"' + (i === 0 ? ' checked' : '') +
                        ' data-date="' + esc(slot.date) + '" data-start="' + esc(slot.start) + '" data-end="' + esc(slot.end) + '"> ' +
                        esc(slot.label || slot.start + ' – ' + slot.end) + '</label>';
                });
                html += '<label class="ship-slot"><input type="radio" name="slot" value="custom"> Choose another time</label>';
                html += '<div class="tl-custom" hidden><input type="date" name="date" required><input type="time" name="start"><input type="time" name="end"></div>';
                html += '<button type="submit">Reschedule delivery</button><p class="form-msg" id="tl-reschedule-msg"></p></form>';
            }
            if (step.contact && step.contact.phone) {
                html += '<a class="call" href="tel:' + esc(step.contact.phone) + '">Contact delivery partner' + (step.contact.name ? ' · ' + esc(step.contact.name) : '') + '</a>';
            }
            html += '<div><a href="' + esc((step.reschedule && step.reschedule.supportUrl) || '/support') + '">Contact support</a></div></div>';
        } else if (step.key === 'out_for_delivery' && step.agent && (step.agent.name || step.agent.phone)) {
            const a = step.agent;
            html +=
                '<div class="tl-card"><div><div class="lbl">Delivery partner</div><div class="val">' + esc(a.name || 'Assigned') + '</div></div>' +
                (a.phone ? '<div><div class="lbl">Phone</div><div class="val"><a href="tel:' + esc(a.phone) + '">Call</a></div></div>' : '') +
                '</div>' +
                (step.deliveryOtp ? '<div class="tl-otps"><div class="tl-otp"><div class="lbl">Delivery OTP</div><div class="code">' + esc(step.deliveryOtp) + '</div></div></div>' : '');
        } else if (step.key === 'out_for_delivery' && step.state === 'active' && step.operational !== 'RESCHEDULED') {
            html += '<div class="tl-note">Finding a delivery partner.</div>';
        }
        if (data.live && data.live.slot === step.key && data.live.leg !== 'done') {
            const riding = !!(data.live.agent && data.live.route !== 'dotted');
            html +=
                '<div class="tl-live">' + (riding ? 'Live delivery tracking' : 'Store and delivery location') + '</div>' +
                (riding ? '<div id="tl-eta" class="tl-note">Delivery partner is on the way.</div>' : '<div class="tl-note">The route stays dotted until a delivery partner location arrives.</div>') +
                '<div id="tl-map-slot"></div>';
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
            (t.deliveryBy ? '<div class="tl-sum">Delivery by ' + esc(t.deliveryBy) + '</div>' : '') +
            t.steps
                .map(
                    (s, i) =>
                        '<div class="tl-step ' + s.state + '"' +
                        (s.lineUntil ? ' data-line-since="' + Number(s.lineSince) + '" data-line-until="' + Number(s.lineUntil) + '" data-line-floor="' + Number(s.lineFloor || 12) + '"' : '') +
                        ' style="--i:' + i + (s.lineFill != null ? ';--line:' + Number(s.lineFill) : '') + '"><div class="tl-dot">' + (s.state === 'done' ? '&#10003;' : '') + '</div>' +
                        '<div class="tl-title">' + esc(s.title) + (s.expectedLabel ? '<span class="tl-expect">' + esc(s.expectedLabel) + '</span>' : '') + (s.at && s.state !== 'upcoming' ? '<span class="tl-time">' + esc(when(s.at)) + '</span>' : '') + '</div>' +
                        (s.summary ? '<div class="tl-sum">' + esc(s.summary) + '</div>' : '') +
                        extra(s, data) +
                        updates(s.updates) +
                        '</div>'
                )
                .join('') +
            '</div>'
        );
    }

    function bind(root) {
        const scope = root && root.querySelector ? root : document;
        const form = scope.querySelector('#tl-reschedule-form');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';
        form.addEventListener('change', () => {
            const custom = form.querySelector('input[value="custom"]');
            const box = form.querySelector('.tl-custom');
            if (box) box.hidden = !(custom && custom.checked);
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const msg = document.getElementById('tl-reschedule-msg');
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
                    body: JSON.stringify({ token: form.getAttribute('data-token'), date, start, end })
                });
                const data = await res.json();
                if (!res.ok) {
                    if (msg) msg.textContent = data.error || 'Could not reschedule.';
                    return;
                }
                if (msg) msg.textContent = 'Delivery rescheduled.';
                setTimeout(() => location.reload(), 700);
            } catch (err) {
                if (msg) msg.textContent = 'Could not reschedule.';
            }
        });
    }

    /** Call after the rendered HTML is in the page. */
    function mount(live) {
        bind();
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

    function toRad(d) {
        return (d * Math.PI) / 180;
    }

    function haversine(a, b) {
        if (!a || !b) return 0;
        const R = 6371000;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    function bearingDeg(a, b) {
        const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
        const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
        return (Math.atan2(y, x) * 180) / Math.PI + 360;
    }

    function buildCum(path) {
        const cum = [0];
        for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
        return cum;
    }

    function along(path, cum, meters) {
        if (!path.length) return null;
        if (meters <= 0) {
            return { lat: path[0].lat, lng: path[0].lng, heading: path.length > 1 ? bearingDeg(path[0], path[1]) % 360 : 0 };
        }
        const total = cum[cum.length - 1];
        if (meters >= total) {
            const n = path.length - 1;
            return { lat: path[n].lat, lng: path[n].lng, heading: n > 0 ? bearingDeg(path[n - 1], path[n]) % 360 : 0 };
        }
        let i = 1;
        while (i < cum.length && cum[i] < meters) i++;
        const span = cum[i] - cum[i - 1] || 1;
        const t = (meters - cum[i - 1]) / span;
        const a = path[i - 1];
        const b = path[i];
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, heading: bearingDeg(a, b) % 360 };
    }

    function projectMeters(path, cum, point) {
        let best = { meters: 0, dist: Infinity };
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1];
            const b = path[i];
            const abLat = b.lat - a.lat;
            const abLng = b.lng - a.lng;
            const denom = abLat * abLat + abLng * abLng;
            let t = denom ? ((point.lat - a.lat) * abLat + (point.lng - a.lng) * abLng) / denom : 0;
            t = Math.max(0, Math.min(1, t));
            const p = { lat: a.lat + abLat * t, lng: a.lng + abLng * t };
            const dist = haversine(point, p);
            if (dist < best.dist) best = { meters: cum[i - 1] + haversine(a, p), dist: dist };
        }
        return best;
    }

    function tailPath(path, cum, meters) {
        const start = along(path, cum, meters);
        const out = [{ lat: start.lat, lng: start.lng }];
        for (let i = 1; i < path.length; i++) if (cum[i] >= meters) out.push(path[i]);
        return out;
    }

    function headPath(path, cum, meters) {
        const end = along(path, cum, meters);
        const out = [];
        for (let i = 0; i < path.length; i++) {
            if (cum[i] > meters) break;
            out.push(path[i]);
        }
        out.push({ lat: end.lat, lng: end.lng });
        return out;
    }

    function markerIcon(svg, w, h) {
        return {
            url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
            scaledSize: new google.maps.Size(w, h),
            anchor: new google.maps.Point(w / 2, h - 2)
        };
    }

    const STORE_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="52" viewBox="0 0 42 52"><path d="M21 50s16-14.2 16-28A16 16 0 1 0 5 22c0 13.8 16 28 16 28z" fill="#0f766e"/><circle cx="21" cy="21" r="11" fill="#fff"/><path d="M14 26V17h14v9M14 21h14M17 17v-2h8v2" fill="none" stroke="#0f766e" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    const HOME_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="52" viewBox="0 0 42 52"><path d="M21 50s16-14.2 16-28A16 16 0 1 0 5 22c0 13.8 16 28 16 28z" fill="#0f1111"/><circle cx="21" cy="21" r="11" fill="#fff"/><path d="M14 25V19l7-5 7 5v6h-5v-4h-4v4z" fill="#0f1111"/></svg>';
    // Front of the bike points up so a map heading rotates it along the road.
    const RIDER_BIKE =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="88" height="88" aria-hidden="true">' +
        '<defs>' +
        '<linearGradient id="tlBikePaint" x1="28" y1="8" x2="70" y2="88" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fdba74"/><stop offset="0.45" stop-color="#ea580c"/><stop offset="1" stop-color="#9a3412"/></linearGradient>' +
        '<radialGradient id="tlHelmet" cx="36%" cy="30%" r="70%"><stop offset="0" stop-color="#fff7ed"/><stop offset="0.42" stop-color="#fb923c"/><stop offset="1" stop-color="#9a3412"/></radialGradient>' +
        '<linearGradient id="tlCloth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient>' +
        '</defs>' +
        '<ellipse cx="48" cy="78" rx="18" ry="5" fill="#0f172a" opacity="0.28"/>' +
        '<g class="tl-wheel tl-wheel-rear"><circle cx="48" cy="64" r="13" fill="#e2e8f0" stroke="#0f172a" stroke-width="4.5"/>' +
        '<circle cx="48" cy="64" r="8.5" fill="none" stroke="#64748b" stroke-width="1.4"/>' +
        '<path d="M48 52.8v22.4M35.6 64h24.8M39.2 55.2l17.6 17.6M56.8 55.2L39.2 72.8" stroke="#f8fafc" stroke-width="1.15" stroke-linecap="round"/>' +
        '<circle cx="48" cy="64" r="2.3" fill="#ea580c"/></g>' +
        '<g class="tl-wheel tl-wheel-front"><circle cx="48" cy="22" r="11" fill="#e2e8f0" stroke="#0f172a" stroke-width="4.2"/>' +
        '<circle cx="48" cy="22" r="7" fill="none" stroke="#64748b" stroke-width="1.3"/>' +
        '<path d="M48 12.6v18.8M38.6 22h18.8M41.4 15.4l13.2 13.2M54.6 15.4L41.4 28.6" stroke="#f8fafc" stroke-width="1.05" stroke-linecap="round"/>' +
        '<circle cx="48" cy="22" r="2" fill="#ea580c"/></g>' +
        '<path d="M48 30v18" stroke="url(#tlBikePaint)" stroke-width="5.5" stroke-linecap="round"/>' +
        '<path d="M48 48 L36 68 M48 48 L60 64" stroke="url(#tlBikePaint)" stroke-width="3.6" stroke-linecap="round"/>' +
        '<path d="M48 12v8" stroke="#334155" stroke-width="2.8" stroke-linecap="round"/>' +
        '<path d="M30 12h36" stroke="#1e293b" stroke-width="3.4" stroke-linecap="round"/>' +
        '<path d="M30 12v6M66 12v6" stroke="#1e293b" stroke-width="3.4" stroke-linecap="round"/>' +
        '<ellipse cx="48" cy="52" rx="9" ry="3" fill="#1e293b"/>' +
        '<path d="M40 52c-1 7 0 12 3 13M56 52c1 7 0 12-3 13" fill="none" stroke="#0f172a" stroke-width="4" stroke-linecap="round"/>' +
        '<path d="M36 46c3-6 21-6 24 0l-1 10c-3 4-19 4-22 0z" fill="url(#tlCloth)" stroke="#94a3b8" stroke-width="0.6"/>' +
        '<circle cx="48" cy="34" r="9.2" fill="url(#tlHelmet)" stroke="#9a3412" stroke-width="0.8"/>' +
        '<path d="M39.5 36.5h17" stroke="#431407" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M39 47c-7-4-12-18-7-28" fill="none" stroke="#fdba74" stroke-width="4" stroke-linecap="round"/>' +
        '<path d="M57 47c7-4 12-18 7-28" fill="none" stroke="#c2410c" stroke-width="4" stroke-linecap="round"/>' +
        '<circle cx="32" cy="16" r="2.6" fill="#fdba74" stroke="#9a3412" stroke-width="0.4"/>' +
        '<circle cx="64" cy="16" r="2.6" fill="#ea580c" stroke="#9a3412" stroke-width="0.4"/>' +
        '</svg>';

    function ensureRider(el) {
        if (el.__rider) return el.__rider;
        function Rider() {
            this.div = null;
            this.pos = null;
            this.heading = 0;
            this.visible = false;
        }
        Rider.prototype = Object.create(google.maps.OverlayView.prototype);
        Rider.prototype.onAdd = function () {
            const div = document.createElement('div');
            div.className = 'tl-rider';
            div.innerHTML = '<div class="tl-rider-pulse"></div><div class="tl-rider-aim"><div class="tl-rider-bob">' + RIDER_BIKE + '</div></div>';
            this.div = div;
            this.getPanes().overlayMouseTarget.appendChild(div);
        };
        Rider.prototype.draw = function () {
            if (!this.div || !this.pos || !this.getProjection()) return;
            const pt = this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(this.pos.lat, this.pos.lng));
            if (!pt) return;
            this.div.style.left = pt.x + 'px';
            this.div.style.top = pt.y + 'px';
            this.div.style.display = this.visible ? 'block' : 'none';
            this.div.classList.toggle('is-moving', !!this.visible);
            const aim = this.div.querySelector('.tl-rider-aim');
            if (aim) aim.style.transform = 'rotate(' + (this.heading || 0) + 'deg)';
        };
        Rider.prototype.setRider = function (pos, heading, visible) {
            this.pos = pos;
            this.heading = heading || 0;
            this.visible = !!visible && !!pos;
            this.draw();
        };
        Rider.prototype.onRemove = function () {
            if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
            this.div = null;
        };
        const rider = new Rider();
        rider.setMap(el.__map);
        el.__rider = rider;
        return rider;
    }

    function ensureMotion(el) {
        if (el.__raf) return;
        let last = 0;
        let lineAt = 0;
        const step = (now) => {
            el.__raf = requestAnimationFrame(step);
            if (!last) last = now;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const path = el.__path;
            const cum = el.__cum;
            if (!path || !cum || !el.__agentLive || !el.__rider) return;
            const gps = el.__gpsMeters || 0;
            let m = el.__agentMeters || 0;
            if (m < gps) m += (gps - m) * Math.min(1, dt * 1.8);
            else m = gps;
            el.__agentMeters = m;
            const at = along(path, cum, m);
            el.__rider.setRider(at, at.heading, true);
            if (now - lineAt > 140) {
                lineAt = now;
                if (el.__remain) el.__remain.setPath(tailPath(path, cum, m));
                if (el.__doneLine) el.__doneLine.setPath(headPath(path, cum, m));
            }
        };
        el.__raf = requestAnimationFrame(step);
    }

    function applyPath(el, path) {
        if (!path || path.length < 2) return;
        el.__path = path;
        el.__cum = buildCum(path);
        const gps = el.__pendingGps;
        const hit = gps ? projectMeters(path, el.__cum, gps) : { meters: 0, dist: 0 };
        el.__gpsMeters = hit.meters;
        if (el.__agentMeters == null || Math.abs(el.__agentMeters - hit.meters) > 400) el.__agentMeters = hit.meters;
        if (el.__remain) el.__remain.setPath(tailPath(path, el.__cum, el.__agentMeters || 0));
        if (el.__doneLine) el.__doneLine.setPath(headPath(path, el.__cum, el.__agentMeters || 0));
    }

    function routePoints(result) {
        const pts = [];
        const leg = result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0];
        if (!leg) return pts;
        leg.steps.forEach((step) => {
            (step.path || []).forEach((ll) => pts.push({ lat: ll.lat(), lng: ll.lng() }));
        });
        return pts;
    }

    function paint(live) {
        const el = mapEl;
        if (!el) return;
        const center = live.agent || live.store || live.drop;
        if (!center) {
            el.textContent = 'Waiting for the delivery partner location...';
            return;
        }
        if (!el.__map) {
            el.textContent = '';
            el.__map = new google.maps.Map(el, {
                center,
                zoom: 15,
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: true,
                gestureHandling: 'greedy',
                styles: [
                    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
                    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
                    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
                    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#e2e8f0' }] },
                    { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#99f6e4' }] },
                    { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f8fafc' }] }
                ]
            });
            el.__map.addListener('dragstart', () => {
                el.__userMoved = true;
            });
            el.__doneLine = new google.maps.Polyline({ map: el.__map, strokeColor: '#94a3b8', strokeWeight: 5, strokeOpacity: 0.85, zIndex: 1 });
            el.__remain = new google.maps.Polyline({ map: el.__map, strokeColor: routeColor(), strokeWeight: 6, strokeOpacity: 1, zIndex: 2 });
            el.__markers = {};
            ensureRider(el);
            ensureMotion(el);
            ensureLinks(el);
        }
        ensureLinks(el);
        const place = (key, pos, title, svg) => {
            if (!pos) {
                if (el.__markers[key]) el.__markers[key].setMap(null);
                return;
            }
            if (!el.__markers[key]) {
                el.__markers[key] = new google.maps.Marker({ map: el.__map, title, icon: markerIcon(svg, 42, 52), zIndex: 3 });
            }
            el.__markers[key].setMap(el.__map);
            el.__markers[key].setPosition(pos);
        };
        place('store', live.store, 'Store', STORE_SVG);
        place('drop', live.drop, 'Delivery location', HOME_SVG);
        el.__liveSnap = live;
        el.__onTrip = (pts) => {
            const snap = el.__liveSnap;
            if (!snap) return;
            if (isPreview(snap)) return applyPreviewRoad(el, snap, pts);
            if (!el.__agentLive) return;
            followTrip(el, snap, pts);
        };
        const preview = isPreview(live);
        if (preview) {
            el.__agentLive = false;
            el.__path = null;
            if (el.__rider) el.__rider.setRider(null, 0, false);
            hideEta();
            if (live.store && live.drop) {
                if (!(el.__tripPath && samePoint(el.__tripFrom, live.store, 40) && samePoint(el.__tripTo, live.drop, 40))) {
                    dottedLine(el.__remain, live.store, live.drop);
                    clearConnectors(el);
                }
                loadTrip(el, live.store, live.drop);
            }
            else {
                if (el.__remain) el.__remain.setPath([]);
                if (el.__corridor) el.__corridor.setPath([]);
                clearConnectors(el);
            }
            if (!el.__fitted || el.__fitLeg !== live.leg) {
                const bounds = new google.maps.LatLngBounds();
                [live.store, live.drop].forEach((pos) => pos && bounds.extend(pos));
                if (!bounds.isEmpty()) el.__map.fitBounds(bounds, mapPadding());
                el.__fitted = true;
                el.__fitLeg = live.leg;
            }
            if (el.__map && window.google && google.maps.event) google.maps.event.trigger(el.__map, 'resize');
            return;
        }
        const moving = live.leg !== 'done' && !!live.agent;
        el.__agentLive = moving;
        el.__pendingGps = live.agent || null;
        if (!moving && el.__rider) el.__rider.setRider(null, 0, false);
        if (!moving) hideEta();
        if (el.__fitLeg && el.__fitLeg !== live.leg) el.__legPath = null;
        const toward = live.leg === 'to_store' ? live.store || live.drop : live.drop || live.store;
        if (moving && live.agent) {
            el.__lastGps = { lat: live.agent.lat, lng: live.agent.lng };
            el.__lastGpsAt = Date.now();
            if (!el.__path) parkRider(el, live.agent, toward);
        }
        if (live.store && live.drop) loadTrip(el, live.store, live.drop);
        else fallbackLive(el, live);
        if (!el.__fitted || el.__fitLeg !== live.leg) {
            const bounds = new google.maps.LatLngBounds();
            [live.store, live.drop, live.agent].forEach((pos) => pos && bounds.extend(pos));
            if (!bounds.isEmpty()) el.__map.fitBounds(bounds, mapPadding());
            el.__fitted = true;
            el.__fitLeg = live.leg;
            el.__userMoved = false;
        }
        if (el.__map && window.google && google.maps.event) google.maps.event.trigger(el.__map, 'resize');
    }

    function isPreview(live) {
        return !!(live && live.leg !== 'done' && (live.route === 'dotted' || !live.agent));
    }

    function samePoint(a, b, meters) {
        return !!(a && b && haversine(a, b) < meters);
    }

    function ensureLinks(el) {
        if (!el.__map || el.__linkStore) return;
        const link = () =>
            new google.maps.Polyline({
                map: el.__map,
                strokeOpacity: 0,
                strokeWeight: 0,
                zIndex: 4,
                icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.95, strokeColor: '#334155', scale: 2.2 }, offset: '0', repeat: '8px' }]
            });
        el.__linkStore = link();
        el.__linkDrop = link();
        el.__corridor = new google.maps.Polyline({ map: el.__map, strokeColor: routeColor(), strokeOpacity: 0.45, strokeWeight: 6, zIndex: 0 });
    }

    function setConnector(line, pin, roadPoint) {
        if (!line) return;
        if (!pin || !roadPoint || haversine(pin, roadPoint) < 12) {
            line.setPath([]);
            return;
        }
        line.setPath([pin, roadPoint]);
    }

    function clearConnectors(el) {
        if (el.__linkStore) el.__linkStore.setPath([]);
        if (el.__linkDrop) el.__linkDrop.setPath([]);
    }

    function closestOnRoads(pin, paths) {
        let best = null;
        (paths || []).forEach((path) => {
            if (!path || path.length < 2) return;
            const cum = buildCum(path);
            const hit = projectMeters(path, cum, pin);
            if (!best || hit.dist < best.dist) {
                const at = along(path, cum, hit.meters);
                best = { dist: hit.dist, pt: { lat: at.lat, lng: at.lng } };
            }
        });
        return best;
    }

    function paintAddressConnectors(el, store, drop, paths) {
        const storeHit = store ? closestOnRoads(store, paths) : null;
        const dropHit = drop ? closestOnRoads(drop, paths) : null;
        setConnector(el.__linkStore, store, storeHit && storeHit.pt);
        setConnector(el.__linkDrop, drop, dropHit && dropHit.pt);
    }

    function solidLine(line, pts) {
        if (!line) return;
        line.setOptions({ strokeColor: routeColor(), strokeOpacity: 1, strokeWeight: 6, icons: null });
        if (pts && pts.length) line.setPath(pts);
    }

    function dottedLine(line, a, b) {
        if (!line || !a || !b) return;
        line.setOptions({
            strokeColor: routeColor(),
            strokeOpacity: 0,
            strokeWeight: 6,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '14px' }]
        });
        line.setPath([a, b]);
    }

    function hideEta() {
        const eta = document.getElementById('tl-eta');
        if (!eta) return;
        eta.hidden = true;
        eta.classList.remove('is-on');
    }

    function showEta(text) {
        const eta = document.getElementById('tl-eta');
        if (!eta || !text) return;
        eta.hidden = false;
        eta.classList.add('is-on');
        eta.textContent = eta.classList.contains('hl-eta') ? text : 'Arriving in approximately ' + text;
    }

    function formatDriveText(seconds) {
        const mins = Math.max(1, Math.round(Math.max(0, seconds) / 60));
        if (mins < 60) return mins + (mins === 1 ? ' min' : ' mins');
        const hours = Math.floor(mins / 60);
        const rest = mins % 60;
        return hours + (hours === 1 ? ' hour' : ' hours') + (rest ? ' ' + rest + ' mins' : '');
    }

    function scaledEtaText(el) {
        const dur = el.__tripDuration;
        const cum = el.__tripCum;
        if (!dur || !dur.value || !cum || !cum.length) return '';
        const total = cum[cum.length - 1];
        if (!total) return '';
        const left = Math.max(0, total - (el.__gpsMeters || 0));
        return formatDriveText(dur.value * (left / total));
    }

    function requestDrive(origin, dest, cb) {
        new google.maps.DirectionsService().route(
            { origin: { lat: origin.lat, lng: origin.lng }, destination: { lat: dest.lat, lng: dest.lng }, travelMode: 'DRIVING' },
            (result, status) => {
                if (status !== 'OK') return cb(null, null);
                const pts = routePoints(result);
                const leg = result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0];
                cb(pts.length > 1 ? pts : null, (leg && leg.duration) || null);
            }
        );
    }

    function loadTrip(el, store, drop) {
        if (!store || !drop) {
            if (el.__onTrip) el.__onTrip(null);
            return;
        }
        if (el.__tripPath && samePoint(el.__tripFrom, store, 40) && samePoint(el.__tripTo, drop, 40)) {
            if (el.__onTrip) el.__onTrip(el.__tripPath);
            return;
        }
        const from = { lat: store.lat, lng: store.lng };
        const to = { lat: drop.lat, lng: drop.lng };
        if (el.__tripPending && samePoint(el.__tripPending, from, 1) && samePoint(el.__tripPendingTo, to, 1)) return;
        el.__tripPending = from;
        el.__tripPendingTo = to;
        requestDrive(from, to, (pts, duration) => {
            if (!el.__tripPending || !samePoint(el.__tripPending, from, 1) || !samePoint(el.__tripPendingTo, to, 1)) return;
            el.__tripPending = null;
            el.__tripPendingTo = null;
            const snap = el.__liveSnap;
            if (snap && (!samePoint(snap.store, from, 40) || !samePoint(snap.drop, to, 40))) return;
            if (pts) {
                el.__tripPath = pts;
                el.__tripCum = buildCum(pts);
                el.__tripFrom = from;
                el.__tripTo = to;
                el.__tripDuration = duration;
            }
            if (el.__onTrip) el.__onTrip(pts);
        });
    }

    function loadLeg(el, origin, dest, legName, cb) {
        if (!origin || !dest) return cb(null, null);
        if (el.__legPath && el.__legName === legName && samePoint(el.__legFrom, origin, 180) && samePoint(el.__legTo, dest, 40)) {
            return cb(el.__legPath, el.__legDuration);
        }
        const from = { lat: origin.lat, lng: origin.lng };
        const to = { lat: dest.lat, lng: dest.lng };
        const token = (el.__legToken = (el.__legToken || 0) + 1);
        if (el.__remain) el.__remain.setPath([]);
        if (el.__doneLine) el.__doneLine.setPath([]);
        requestDrive(from, to, (pts, duration) => {
            if (el.__legToken !== token) return;
            if (pts) {
                el.__legPath = pts;
                el.__legFrom = from;
                el.__legTo = to;
                el.__legName = legName;
                el.__legDuration = duration;
            }
            cb(pts, duration);
        });
    }

    function parkRider(el, agent, toward) {
        if (!el.__rider) return;
        if (!agent) {
            el.__rider.setRider(null, 0, false);
            return;
        }
        const heading = toward ? bearingDeg(agent, toward) % 360 : 0;
        el.__rider.setRider(agent, heading, true);
    }

    function applyPreviewRoad(el, live, pts) {
        hideEta();
        el.__agentLive = false;
        el.__path = null;
        if (el.__rider) el.__rider.setRider(null, 0, false);
        if (el.__doneLine) el.__doneLine.setPath([]);
        if (el.__corridor) el.__corridor.setPath([]);
        if (!live.store || !live.drop || !el.__remain) return;
        if (!pts) {
            dottedLine(el.__remain, live.store, live.drop);
            clearConnectors(el);
            return;
        }
        solidLine(el.__remain, pts);
        paintAddressConnectors(el, live.store, live.drop, [pts]);
    }

    function followTrip(el, live, pts) {
        if (!pts) return fallbackLive(el, live);
        const toStore = live.leg === 'to_store';
        const target = toStore ? live.store : live.drop;
        const hit = live.agent && el.__tripCum ? projectMeters(pts, el.__tripCum, live.agent) : { dist: Infinity, meters: 0 };
        if (!toStore && hit.dist <= 350) {
            if (el.__corridor) el.__corridor.setPath([]);
            el.__pendingGps = live.agent;
            solidLine(el.__remain);
            applyPath(el, pts);
            paintAddressConnectors(el, live.store, live.drop, [pts]);
            const text = scaledEtaText(el);
            if (text && el.__agentLive) showEta(text);
            else hideEta();
            return;
        }
        if (el.__corridor) {
            el.__corridor.setOptions({ strokeColor: routeColor(), strokeOpacity: 0.45, strokeWeight: 6, icons: null });
            el.__corridor.setPath(pts);
        }
        paintAddressConnectors(el, live.store, live.drop, [pts]);
        if (!live.agent || !target) {
            solidLine(el.__remain, pts);
            if (el.__doneLine) el.__doneLine.setPath([]);
            return;
        }
        const legName = toStore ? 'to_store' : 'to_drop';
        const cached = el.__legPath && el.__legName === legName && samePoint(el.__legFrom, live.agent, 180) && samePoint(el.__legTo, target, 40);
        if (!cached) parkRider(el, live.agent, target);
        loadLeg(el, live.agent, target, legName, (legPts, duration) => {
            const snap = el.__liveSnap;
            if (!snap || isPreview(snap) || !el.__agentLive) return;
            const roads = [el.__tripPath].filter(Boolean);
            if (!legPts) {
                dottedLine(el.__remain, snap.agent, target);
                if (el.__doneLine) el.__doneLine.setPath([]);
                parkRider(el, snap.agent, target);
                el.__path = null;
                paintAddressConnectors(el, snap.store, snap.drop, roads.concat([[snap.agent, target]]));
                hideEta();
                return;
            }
            if (!toStore && snap.leg !== 'to_store' && snap.agent && el.__tripPath && el.__tripCum) {
                const again = projectMeters(el.__tripPath, el.__tripCum, snap.agent);
                if (again.dist <= 350) return followTrip(el, snap, el.__tripPath);
            }
            roads.push(legPts);
            el.__pendingGps = snap.agent;
            solidLine(el.__remain);
            applyPath(el, legPts);
            paintAddressConnectors(el, snap.store, snap.drop, roads);
            if (duration && duration.text && el.__agentLive) showEta(duration.text);
            else hideEta();
        });
    }

    function fallbackLive(el, live) {
        const target = live.leg === 'to_store' ? live.store || live.drop : live.drop || live.store;
        const origin = live.agent || live.store;
        if (el.__corridor) el.__corridor.setPath([]);
        clearConnectors(el);
        el.__path = null;
        if (live.agent) parkRider(el, live.agent, target);
        else if (el.__rider) el.__rider.setRider(null, 0, false);
        if (origin && target) dottedLine(el.__remain, origin, target);
        if (live.store && live.drop && origin !== live.store) paintAddressConnectors(el, live.store, live.drop, [[live.store, live.drop], origin && target ? [origin, target] : null]);
        hideEta();
    }

    function routeColor() {
        return document.body.classList.contains('hl-page') ? '#ea580c' : '#067d62';
    }

    function mapPadding() {
        return document.body.classList.contains('hl-page') ? { top: 64, right: 64, bottom: 64, left: 64 } : 64;
    }

    function tickLines() {
        const nodes = document.querySelectorAll('.tl-step.active[data-line-until]');
        const now = Date.now();
        nodes.forEach((el) => {
            const since = Number(el.getAttribute('data-line-since'));
            const until = Number(el.getAttribute('data-line-until'));
            const floor = Number(el.getAttribute('data-line-floor')) || 12;
            if (!until || until <= since) return;
            const ratio = now <= since ? 0.12 : Math.min(1, (now - since) / (until - since));
            const pct = Math.min(88, Math.max(floor, Math.round(ratio * 100)));
            el.style.setProperty('--line', String(pct));
        });
    }
    setInterval(tickLines, 2000);

    window.TrackTimeline = { render, mount, bind, when, esc, updates };
})();

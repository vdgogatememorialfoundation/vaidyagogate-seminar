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
        if (step.deliveryOtp && (step.key === 'packed' || step.key === 'shipped' || step.key === 'out_for_delivery' || step.key === 'delivered')) {
            html += '<div class="tl-otps"><div class="tl-otp"><div class="lbl">Delivery OTP</div><div class="code">' + esc(step.deliveryOtp) + '</div></div></div><div class="tl-note">Share this code with the delivery partner.</div>';
        }
        if (step.queue && step.state === 'active') {
            const q = step.queue;
            const ord = q.position === 1 ? 'next' : q.position === 2 ? '2nd' : q.position === 3 ? '3rd' : q.position + 'th';
            html +=
                '<div class="tl-queue"><i class="fas fa-route"></i><div><b>' +
                (q.position === 1 ? 'You are next on the delivery route' : 'Your parcel is ' + ord + ' of ' + q.total + ' deliveries on the route') +
                '</b><span>' + (q.ahead ? q.ahead + (q.ahead === 1 ? ' delivery' : ' deliveries') + ' ahead of yours' : 'No deliveries ahead of yours') + (q.agent ? ' · ' + esc(q.agent) : '') + '</span></div></div>';
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
                '</div>';
        } else if (step.key === 'out_for_delivery' && step.state === 'active' && step.operational !== 'RESCHEDULED') {
            html += '<div class="tl-note">Finding a delivery partner.</div>';
        }
        return html;
    }

    function doorCode(t) {
        if (!t) return '';
        if (t.deliveryOtp) return String(t.deliveryOtp);
        const steps = t.steps || [];
        for (let i = 0; i < steps.length; i++) {
            if (steps[i] && steps[i].deliveryOtp) return String(steps[i].deliveryOtp);
        }
        return '';
    }

    function proofHtml(t) {
        if (!t || t.cancelled) return '';
        let html = '';
        const otp = doorCode(t);
        if (otp) {
            html += '<div class="ship-otp"><div class="lbl">Delivery OTP</div><div class="code">' + esc(otp) + '</div><div class="note">Share this code with the delivery partner at your door.</div></div>';
        }
        if (t.shipmentQrSvg) {
            const scanId = t.scanId || t.orderCode || '';
            const kind = t.scanKind === 'tracking' ? 'tracking id' : 'order id';
            const title = t.scanKind === 'tracking' ? 'Tracking QR' : 'Order QR';
            const extra = t.orderCode && scanId && t.orderCode !== scanId ? '<p>Order ' + esc(t.orderCode) + '</p>' : '';
            html += '<section class="trk-qr"><div class="trk-qr-copy"><b>' + title + '</b>' +
                (scanId ? '<div class="trk-qr-code">' + esc(scanId) + '</div>' : '') +
                extra +
                '<p>The delivery partner scans this ' + kind + ' in the agent app to confirm pickup, then delivery.</p></div><div class="trk-qr-img">' + t.shipmentQrSvg + '</div></section>';
        }
        return html;
    }

    function partnerContact(t) {
        const steps = (t && t.steps) || [];
        for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step.agent && (step.agent.name || step.agent.phone)) return step.agent;
            if (step.contact && (step.contact.name || step.contact.phone)) return step.contact;
            if (step.pickup && step.pickup.agent && (step.pickup.agent.name || step.pickup.agent.phone)) return step.pickup.agent;
        }
        return null;
    }

    function shareUrl(data) {
        let share = (data && data.trackUrl) || '';
        const live = data && data.live;
        if (!share && live && live.watchToken && typeof location !== 'undefined' && location.origin) {
            share = location.origin + '/track-commerce?token=' + encodeURIComponent(live.watchToken);
        }
        if (share && share.charAt(0) === '/' && typeof location !== 'undefined' && location.origin) share = location.origin + share;
        return share;
    }

    function assistHtml(t, data) {
        if (!t || t.cancelled) return '';
        const partner = partnerContact(t);
        const phone = partner && String(partner.phone || '').replace(/[^\d+]/g, '');
        const share = shareUrl(data);
        const live = data && data.live;
        const bits = [];
        if (phone) bits.push('<a class="tl-act" href="tel:' + esc(phone) + '">Call ' + esc((partner && partner.name) || 'partner') + '</a>');
        if (share) bits.push('<button type="button" class="tl-act" data-tl-copy="' + esc(share) + '">Share tracking</button>');
        if (t.orderCode) bits.push('<button type="button" class="tl-act" data-tl-copy="' + esc(t.orderCode) + '">Copy order code</button>');
        if (t.scanId && t.scanId !== t.orderCode) bits.push('<button type="button" class="tl-act" data-tl-copy="' + esc(t.scanId) + '">Copy tracking id</button>');
        const otp = doorCode(t);
        if (otp) bits.push('<button type="button" class="tl-act" data-tl-copy="' + esc(otp) + '">Copy delivery code</button>');
        const meta = [];
        if (live && live.dropLabel) meta.push(live.dropLabel);
        if (t.deliveryBy) meta.push('Delivery ' + t.deliveryBy);
        if (!bits.length && !meta.length) return '';
        return '<section class="tl-assist">' + (bits.length ? '<div class="tl-acts">' + bits.join('') + '</div>' : '') + (meta.length ? '<p class="tl-assist-meta">' + esc(meta.join(' · ')) + '</p>' : '') + '</section>';
    }

    function mapBlock(live) {
        if (!live || live.leg === 'done') return '';
        const label = live.phaseLabel || (live.route === 'dotted' ? 'Route from the store to your address' : 'Delivery partner');
        return '<div class="tl-map-block"><div class="tl-live">' + esc(label) + '</div>' +
            '<div id="tl-eta" class="tl-eta" hidden><span class="tl-eta-lbl">' + esc(label) + '</span><b class="tl-eta-val"></b><span class="tl-eta-sub"></span></div>' +
            '<div id="tl-map-slot"></div></div>';
    }

    function dateStrip(t) {
        const dates = (t && t.dates) || {};
        const shipped = dates.shippedState === 'actual' && dates.shippedAt
            ? when(dates.shippedAt)
            : dates.shippedState === 'expected' && dates.shippedExpected
              ? when(dates.shippedExpected)
              : '';
        const delivery = dates.deliveryState === 'actual' && dates.deliveryAt
            ? when(dates.deliveryAt)
            : dates.deliveryState === 'expected'
              ? dates.deliveryLabel || ''
              : '';
        if (!shipped && !delivery && !t.deliveryBy) return '';
        const kind = (state) => (state === 'actual' ? 'Actual' : state === 'expected' ? 'Expected' : '');
        const tile = (label, state, value, extra) =>
            value
                ? '<article class="trk-date' + extra + '"><div class="trk-date-copy"><div class="trk-date-top"><span class="lbl">' + esc(label) + '</span>' +
                  (state ? '<span class="kind is-' + esc(state) + '">' + esc(kind(state)) + '</span>' : '') +
                  '</div><div class="val">' + esc(value) + '</div></div></article>'
                : '';
        const timing = t.timing;
        const badge = timing && (timing.state === 'on_time' || timing.state === 'delayed')
            ? '<span class="trk-pill ' + (timing.state === 'delayed' ? 'is-late' : 'is-ok') + '">' + esc(timing.label) + '</span>'
            : '';
        const promised = dates.deliveryState === 'actual' && dates.promisedLabel
            ? '<p class="trk-date-note">Promised ' + esc(dates.promisedLabel) + '</p>'
            : '';
        const repeatsDelivery = dates.deliveryState === 'actual' && /delivered/i.test(String(dates.updatedLabel || ''));
        const fresh = dates.updatedAt && !repeatsDelivery
            ? '<span class="trk-date-fresh">Latest' + (dates.updatedLabel ? ' · ' + esc(dates.updatedLabel) : '') + ' · ' + esc(when(dates.updatedAt)) + '</span>'
            : '';
        return '<section class="trk-dates" aria-label="Shipping and delivery">' +
            tile('Shipping', dates.shippedState, shipped, '') +
            tile('Delivery', dates.deliveryState, delivery, ' is-delivery') +
            (!shipped && !delivery && t.deliveryBy ? tile('Delivery', 'expected', t.deliveryBy, ' is-delivery') : '') +
            '<div class="trk-date-meta">' + badge + promised + fresh + '</div></section>';
    }

    /** data: { timeline, live, awbTrackUrl, trackUrl }; opts: { animate } */
    function expectedStrip(t) {
        const e = t && t.expected;
        if (!e || t.cancelled) return '';
        const rows = [
            ['Packed', e.packedAt],
            ['Pickup', e.pickupAt],
            ['Shipped', e.shippedAt],
            ['Out for delivery', e.outForDeliveryAt],
            ['Delivery', e.deliveryAt, e.deliveryText]
        ].filter((r) => r[1]);
        if (!rows.length) return '';
        const src = e.source === 'courier' ? 'Delivery date from courier' : e.source === 'rescheduled' ? 'Rescheduled' : e.source === 'slot' ? 'Your chosen slot' : 'Seller estimate · ' + esc(e.zone) + ' zone';
        return (
            '<div class="tl-expected"><div class="tl-expected-h">Expected dates <span>' + src + '</span></div><div class="tl-expected-row">' +
            rows.map((r) => '<div class="tl-expected-cell"><div class="lbl">' + esc(r[0]) + '</div><div class="val">' + esc(r[2] || when(r[1])) + '</div></div>').join('') +
            '</div>' +
            (e.slot && e.slot.date ? '<div class="tl-expected-slot">Delivery slot: ' + esc(e.slot.date) + ' · ' + esc(e.slot.start) + '–' + esc(e.slot.end) + '</div>' : '') +
            '</div>'
        );
    }

    function cardsHtml(t) {
        const cards = (t && t.cards) || [];
        if (!cards.length) return '';
        return (
            '<section class="tl-cards" aria-label="Order details">' +
            cards
                .map((card) => {
                    const now = card.key === 'now' ? ' is-now' : '';
                    return (
                        '<article class="tl-mini' + now + '" data-tl-card="' + esc(card.key) + '"><div class="lbl">' + esc(card.label) + '</div><div class="val" data-tl-card-val>' +
                        esc(card.value) + '</div>' +
                        (card.detail ? '<div class="sub" data-tl-card-sub>' + esc(card.detail) + '</div>' : '<div class="sub" data-tl-card-sub hidden></div>') +
                        '</article>'
                    );
                })
                .join('') +
            '</section>'
        );
    }

    function courierCard(t, data) {
        const c = t && t.courier;
        if (!c || !(c.trackingNo || c.provider)) return '';
        const link = data && data.awbTrackUrl ? '<a class="tl-courier-link" href="' + esc(data.awbTrackUrl) + '" target="_blank" rel="noopener">Open on courier site</a>' : '';
        return (
            '<div class="tl-courier' + (c.rto ? ' is-rto' : '') + '"><div class="tl-courier-main"><div class="lbl">Courier</div><div class="val">' + esc(c.provider || 'Courier') +
            (c.trackingNo ? ' · AWB <code>' + esc(c.trackingNo) + '</code>' : '') + '</div>' +
            (c.label ? '<div class="tl-courier-status">' + esc(c.label) + (c.updatedAt ? ' <span>· updated ' + esc(when(c.updatedAt)) + '</span>' : '') + '</div>' : '') +
            (c.destination ? '<div class="tl-courier-status">Destination ' + esc(c.destination) + '</div>' : '') +
            '</div><div class="tl-courier-side">' +
            (c.shippingRate != null ? '<div class="tl-rate">Shipping ₹' + esc(Number(c.shippingRate).toFixed(0)) + '</div>' : '') +
            link + '</div></div>'
        );
    }

    function render(data, opts) {
        const t = data.timeline;
        if (!t) return '';
        const animate = !opts || opts.animate !== false;
        const settled = t.steps && t.steps.length && t.steps.every((step) => step.state === 'done');
        return (
            '<div class="tl' + (animate ? '' : ' tl-static') + (settled ? ' is-settled' : '') + '">' +
            assistHtml(t, data) +
            cardsHtml(t) +
            proofHtml(t) +
            mapBlock(data.live) +
            dateStrip(t) +
            expectedStrip(t) +
            courierCard(t, data) +
            (t.steps || [])
                .map((s, i) => {
                    const open = s.state === 'active';
                    const hint = s.state === 'done' ? 'This step is complete.' : s.state === 'active' ? 'This step is in progress.' : 'This step has not started.';
                    const body = (s.summary ? '<div class="tl-sum">' + esc(s.summary) + '</div>' : '<div class="tl-sum">' + esc(hint) + '</div>') + extra(s, data) + updates(s.updates);
                    return '<div class="tl-step ' + s.state + '"' +
                        (s.lineUntil ? ' data-line-since="' + Number(s.lineSince) + '" data-line-until="' + Number(s.lineUntil) + '" data-line-floor="' + Number(s.lineFloor || 12) + '"' : '') +
                        ' style="--i:' + i + (s.lineFill != null ? ';--line:' + Number(s.lineFill) : '') + '"><div class="tl-dot">' + (s.state === 'done' ? '&#10003;' : '') + '</div>' +
                        '<div class="tl-title">' + esc(s.title) + (s.expectedLabel && s.state !== 'done' && !(s.at && s.state === 'active') ? '<span class="tl-expect">' + esc(s.expectedLabel) + '</span>' : '') + (s.at && s.state !== 'upcoming' ? '<span class="tl-time">' + esc(when(s.at)) + '</span>' : '') + '</div>' +
                        '<button type="button" class="tl-drawer-btn" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? 'Hide details' : 'View details') + '</button>' +
                        '<div class="tl-drawer"' + (open ? '' : ' hidden') + '>' + body + '</div></div>';
                })
                .join('') +
            '</div>'
        );
    }

    function bind(root) {
        const scope = root && root.querySelector ? root : document;
        scope.querySelectorAll('[data-tl-copy]').forEach((btn) => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            const label = btn.textContent;
            btn.addEventListener('click', async () => {
                const text = btn.getAttribute('data-tl-copy') || '';
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
                    else return;
                    btn.textContent = 'Copied';
                    setTimeout(() => {
                        btn.textContent = label;
                    }, 1200);
                } catch (err) {
                    btn.textContent = label;
                }
            });
        });
        scope.querySelectorAll('.tl-drawer-btn').forEach((btn) => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', () => {
                const drawer = btn.nextElementSibling;
                if (!drawer || !drawer.classList.contains('tl-drawer')) return;
                const open = drawer.hasAttribute('hidden');
                if (open) drawer.removeAttribute('hidden');
                else drawer.setAttribute('hidden', '');
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
                btn.textContent = open ? 'Hide details' : 'View details';
            });
        });
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

    const RIDER_STILL_M = 18;
    let riderSocket = null;
    let riderToken = '';
    let riderRetry = null;
    let riderHttp = null;
    let riderMisses = 0;
    let pendingRider = null;

    function acceptFix(prev, next, deadband) {
        const band = deadband || RIDER_STILL_M;
        if (!next || !Number.isFinite(Number(next.lat)) || !Number.isFinite(Number(next.lng))) {
            return { point: null, traveling: false, first: false, clear: true };
        }
        const point = { lat: Number(next.lat), lng: Number(next.lng) };
        if (!prev) return { point: point, traveling: false, first: true };
        const dist = haversine(prev, point);
        if (dist < band) return { point: prev, traveling: false, ignored: true };
        if (dist > 1500) return { point: point, traveling: false, first: true, snap: true };
        return { point: point, traveling: true };
    }

    function lockRider(el, live) {
        if (!live || !live.agent) {
            el.__riderTraveling = false;
            return false;
        }
        const fix = acceptFix(el.__acceptedGps, live.agent, RIDER_STILL_M);
        if (fix.clear) {
            el.__riderTraveling = false;
            return false;
        }
        if (fix.ignored && !el.__riderTraveling && el.__map && el.__paintedLeg === live.leg) {
            syncBike(false);
            return true;
        }
        if (!fix.ignored) {
            const prev = el.__acceptedGps ? { lat: el.__acceptedGps.lat, lng: el.__acceptedGps.lng } : null;
            const reported = Number(live.agent && live.agent.heading);
            el.__acceptedGps = fix.point;
            el.__riderTraveling = !!fix.traveling;
            if (fix.snap || fix.first) el.__poseMeters = null;
            if (Number.isFinite(reported)) {
                el.__stillHeading = ((reported % 360) + 360) % 360;
                el.__headingFallback = false;
                el.__glide = null;
            } else if (fix.traveling && prev) {
                const heading = bearingDeg(prev, fix.point) % 360;
                const meters = haversine(prev, fix.point);
                el.__stillHeading = heading;
                el.__headingFallback = false;
                el.__glide = {
                    from: prev,
                    to: { lat: fix.point.lat, lng: fix.point.lng },
                    heading: heading,
                    start: 0,
                    ms: Math.min(700, Math.max(280, Math.round(meters * 6)))
                };
            } else if (fix.snap || fix.first) {
                el.__glide = null;
                el.__headingFallback = true;
            }
        }
        live.agent = Object.assign({}, el.__acceptedGps || live.agent);
        if (el.__stillHeading != null && !el.__headingFallback) live.agent.heading = el.__stillHeading;
        return false;
    }

    function applyRiderMessage(msg) {
        const el = mapEl;
        if (!msg || msg.type !== 'rider') return;
        if (!el || !el.__map || !el.__liveSnap) {
            pendingRider = msg;
            return;
        }
        const live = el.__liveSnap;
        if (msg.agent && Number.isFinite(Number(msg.agent.lat)) && Number.isFinite(Number(msg.agent.lng))) {
            live.agent = { lat: Number(msg.agent.lat), lng: Number(msg.agent.lng) };
            if (Number.isFinite(Number(msg.agent.heading))) live.agent.heading = Number(msg.agent.heading);
            live.route = 'road';
            if (!live.leg || live.leg === 'preview' || live.leg === 'done') live.leg = msg.leg || 'to_drop';
        } else if (msg.agent == null) {
            live.agent = null;
            live.route = 'dotted';
            if (msg.leg) live.leg = msg.leg;
        }
        if (msg.leg && live.leg !== 'done') live.leg = msg.leg;
        paint(live);
    }

    function stopRiderHttp() {
        if (riderHttp) clearInterval(riderHttp);
        riderHttp = null;
    }

    function startRiderHttp() {
        if (riderHttp || !riderToken) return;
        const pull = () => {
            fetch('/api/public/commerce/rider-live?token=' + encodeURIComponent(riderToken), { cache: 'no-store' })
                .then((res) => res.json())
                .then((data) => applyRiderMessage(data))
                .catch(() => {});
        };
        pull();
        riderHttp = setInterval(pull, 8000);
    }

    function scheduleRiderRetry() {
        if (riderRetry || !riderToken) return;
        riderRetry = setTimeout(() => {
            riderRetry = null;
            openRiderSocket();
        }, 4000);
    }

    function openRiderSocket() {
        if (!riderToken || typeof WebSocket === 'undefined') {
            startRiderHttp();
            return;
        }
        if (riderRetry) {
            clearTimeout(riderRetry);
            riderRetry = null;
        }
        if (riderSocket) {
            riderSocket.onclose = null;
            try { riderSocket.close(); } catch (e) {}
            riderSocket = null;
        }
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws;
        let opened = false;
        try {
            ws = new WebSocket(proto + '//' + location.host + '/api/public/commerce/rider-live?token=' + encodeURIComponent(riderToken));
        } catch (e) {
            riderMisses += 1;
            if (riderMisses >= 2) startRiderHttp();
            scheduleRiderRetry();
            return;
        }
        riderSocket = ws;
        ws.onopen = () => {
            opened = true;
            riderMisses = 0;
            stopRiderHttp();
        };
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            applyRiderMessage(msg);
        };
        ws.onerror = () => {};
        ws.onclose = () => {
            if (riderSocket === ws) riderSocket = null;
            if (!opened) riderMisses += 1;
            if (riderMisses >= 2) startRiderHttp();
            scheduleRiderRetry();
        };
    }

    let trackSocket = null;
    let trackToken = '';
    let trackRetry = null;
    let trackRefreshTimer = null;

    function cardHost() {
        return document.querySelector('.tl') || document.querySelector('.hl-sheet') || document.querySelector('.trk');
    }

    function ensureCard(key, label) {
        if (!document.querySelector) return null;
        let section = document.querySelector('.tl-cards');
        if (!section) {
            const host = cardHost();
            if (!host) return null;
            section = document.createElement('section');
            section.className = 'tl-cards';
            section.setAttribute('aria-label', 'Order details');
            const assist = host.querySelector('.tl-assist');
            if (assist && assist.parentNode === host) host.insertBefore(section, assist.nextSibling);
            else host.insertBefore(section, host.firstChild);
        }
        let card = section.querySelector('[data-tl-card="' + key + '"]');
        if (card) return card;
        card = document.createElement('article');
        card.className = 'tl-mini' + (key === 'now' ? ' is-now' : '');
        card.setAttribute('data-tl-card', key);
        const lbl = document.createElement('div');
        lbl.className = 'lbl';
        lbl.textContent = label;
        const val = document.createElement('div');
        val.className = 'val';
        val.setAttribute('data-tl-card-val', '');
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.setAttribute('data-tl-card-sub', '');
        sub.hidden = true;
        card.appendChild(lbl);
        card.appendChild(val);
        card.appendChild(sub);
        if (key === 'now') section.insertBefore(card, section.firstChild);
        else section.appendChild(card);
        return card;
    }

    function setCardText(key, label, value, detail) {
        const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!text) return;
        const card = ensureCard(key, label);
        if (!card) return;
        const val = card.querySelector('[data-tl-card-val]');
        const sub = card.querySelector('[data-tl-card-sub]');
        if (val) val.textContent = text;
        if (sub) {
            const extra = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 90);
            sub.textContent = extra;
            sub.hidden = !extra;
        }
        card.classList.add('tl-fresh');
        setTimeout(() => card.classList.remove('tl-fresh'), 1400);
    }

    function paintOtp(code) {
        const otp = String(code || '').replace(/\s+/g, '');
        if (!/^\d{4,8}$/.test(otp)) return;
        const boxes = document.querySelectorAll ? document.querySelectorAll('.ship-otp') : [];
        let found = false;
        boxes.forEach((box) => {
            const lbl = box.querySelector('.lbl');
            if (!lbl || !/delivery otp/i.test(lbl.textContent || '')) return;
            const codeEl = box.querySelector('.code');
            if (!codeEl) return;
            codeEl.textContent = otp;
            found = true;
        });
        if (found) return;
        const host = cardHost();
        if (!host) return;
        const box = document.createElement('div');
        box.className = 'ship-otp';
        const lbl = document.createElement('div');
        lbl.className = 'lbl';
        lbl.textContent = 'Delivery OTP';
        const codeEl = document.createElement('div');
        codeEl.className = 'code';
        codeEl.textContent = otp;
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = 'Share this code with the delivery partner at your door.';
        box.appendChild(lbl);
        box.appendChild(codeEl);
        box.appendChild(note);
        const cards = host.querySelector('.tl-cards');
        if (cards && cards.parentNode === host) host.insertBefore(box, cards.nextSibling);
        else host.insertBefore(box, host.firstChild);
    }

    function paintPartnerPhone(phone) {
        const clean = String(phone || '').replace(/[^\d+]/g, '');
        if (clean.length < 6 || clean.length > 16) return;
        document.querySelectorAll('a.hl-call, a.tl-act[href^="tel:"]').forEach((link) => {
            link.setAttribute('href', 'tel:' + clean);
        });
    }

    function applyTrackMessage(msg) {
        if (!msg || msg.type !== 'track' || !document.querySelector) return;
        if (msg.phase) setCardText('now', 'Right now', msg.phase, '');
        if (msg.partner) setCardText('partner', 'Delivery partner', msg.partner, msg.phone || '');
        if (msg.distance) setCardText('away', 'Distance', msg.distance, 'From your address');
        if (msg.pay) setCardText('pay', 'Payment', msg.pay, '');
        if (msg.deliveryOtp) paintOtp(msg.deliveryOtp);
        paintPartnerPhone(msg.phone);
        const nameEl = document.querySelector('.hl-partner-name');
        if (nameEl && msg.partner) nameEl.textContent = String(msg.partner).replace(/\s+/g, ' ').trim().slice(0, 80);
        const wait = document.querySelector('.hl-wait');
        if (wait && msg.phase) wait.textContent = String(msg.phase).replace(/\s+/g, ' ').trim().slice(0, 80);
        if (msg.source === 'webhook' && msg.kind) {
            if (trackRefreshTimer) clearTimeout(trackRefreshTimer);
            trackRefreshTimer = setTimeout(() => {
                trackRefreshTimer = null;
                try {
                    document.dispatchEvent(new CustomEvent('tl-track-refresh'));
                } catch (e) {}
            }, 700);
        }
    }

    function scheduleTrackRetry() {
        if (trackRetry || !trackToken) return;
        trackRetry = setTimeout(() => {
            trackRetry = null;
            openTrackSocket(trackToken);
        }, 4000);
    }

    function openTrackSocket(token) {
        token = String(token || '').trim();
        if (token.length < 8 || typeof WebSocket === 'undefined') return;
        if (trackToken === token && trackSocket && trackSocket.readyState <= 1) return;
        trackToken = token;
        if (trackRetry) {
            clearTimeout(trackRetry);
            trackRetry = null;
        }
        if (trackSocket) {
            trackSocket.onclose = null;
            try { trackSocket.close(); } catch (e) {}
            trackSocket = null;
        }
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let ws;
        try {
            ws = new WebSocket(proto + '//' + location.host + '/api/public/commerce/track-live?token=' + encodeURIComponent(trackToken));
        } catch (e) {
            scheduleTrackRetry();
            return;
        }
        trackSocket = ws;
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            applyTrackMessage(msg);
        };
        ws.onerror = () => {};
        ws.onclose = () => {
            if (trackSocket === ws) trackSocket = null;
            scheduleTrackRetry();
        };
    }

    function watchRider(token) {
        token = String(token || '').trim();
        if (token.length < 8) return;
        openTrackSocket(token);
        if (riderToken === token && riderSocket && riderSocket.readyState <= 1) return;
        riderToken = token;
        riderMisses = 0;
        openRiderSocket();
    }

    /** Call after the rendered HTML is in the page. */
    function mount(live) {
        if (live && live.watchToken) watchRider(live.watchToken);
        if (live && !live.mapsApiKey) return;
        bind();
        if (!live) return;
        const slot = document.getElementById('tl-map-slot');
        if (mapEl && mapEl.__map) {
            if (!mapEl.isConnected) {
                if (!slot) return;
                slot.replaceWith(mapEl);
            }
            return paint(live);
        }
        if (!slot) return;
        if (!mapEl) {
            mapEl = document.createElement('div');
            mapEl.className = 'tl-map';
        }
        slot.replaceWith(mapEl);
        if (!live.mapsApiKey) {
            mapEl.textContent = 'The live map is not available yet.';
            return;
        }
        const run = () => paint(live);
        if (window.google && window.google.maps) return run();
        window.__tlMapBoot = run;
        if (document.getElementById('tl-maps-js')) return;
        const s = document.createElement('script');
        s.id = 'tl-maps-js';
        s.async = true;
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(live.mapsApiKey) + '&v=weekly&callback=__tlMapBoot';
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
        '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="52" viewBox="0 0 42 52"><ellipse cx="21" cy="48" rx="8" ry="3" fill="#1d4ed8" opacity="0.18"/><path d="M21 46s14-12.4 14-25A14 14 0 1 0 7 21c0 12.6 14 25 14 25z" fill="#1d4ed8"/><circle cx="21" cy="20" r="8.5" fill="#fff"/><path d="M15.5 24.5v-7h11v7M15.5 20.5h11M18 17.5V16h6v1.5" fill="none" stroke="#1d4ed8" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const HOME_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="52" viewBox="0 0 42 52"><ellipse cx="21" cy="48" rx="8" ry="3" fill="#1d4ed8" opacity="0.18"/><path d="M21 46s14-12.4 14-25A14 14 0 1 0 7 21c0 12.6 14 25 14 25z" fill="#1d4ed8"/><circle cx="21" cy="20" r="8.5" fill="#fff"/><path d="M15 23.5V18l6-4.2 6 4.2v5.5h-4.2v-3.4h-3.6v3.4z" fill="#1d4ed8"/></svg>';
    const PREVIEW_STORE_SVG = STORE_SVG;
    const PREVIEW_HOME_SVG = HOME_SVG;
    // The scooter artwork faces right. A -90 degree turn points the front up so the map heading follows the road.
    const RIDER_ICON = '/media/delivery-agent.png?v=2';

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
            div.innerHTML = '<div class="tl-rider-plate"></div><div class="tl-rider-aim"><div class="tl-rider-bob"><img class="tl-rider-img" alt="" src="' + RIDER_ICON + '"></div></div>';
            this.div = div;
            this.getPanes().overlayMouseTarget.appendChild(div);
        };
        Rider.prototype.draw = function () {
            if (!this.div) return;
            if (!this.pos || !this.visible) {
                this.div.style.display = 'none';
                this.div.classList.remove('is-moving');
                return;
            }
            if (!this.getProjection()) return;
            const pt = this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(this.pos.lat, this.pos.lng));
            if (!pt) return;
            this.div.style.left = pt.x + 'px';
            this.div.style.top = pt.y + 'px';
            this.div.style.display = 'block';
            this.div.classList.toggle('is-moving', !!this.moving);
            const aim = this.div.querySelector('.tl-rider-aim');
            const heading = this.heading || 0;
            const sig = pt.x + ',' + pt.y + ':' + heading + ':' + (this.moving ? 1 : 0);
            if (this.div.__sig === sig) return;
            this.div.__sig = sig;
            if (aim) aim.style.transform = 'rotate(' + heading + 'deg)';
        };
        Rider.prototype.setRider = function (pos, heading, visible, moving) {
            this.pos = pos;
            this.heading = heading == null || !Number.isFinite(Number(heading)) ? 0 : Number(heading);
            this.visible = !!visible && !!pos;
            this.moving = false;
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

    function syncBike(moving) {
        document.querySelectorAll('.hl-bike-3d').forEach((node) => node.classList.toggle('is-moving', !!moving));
    }

    function holdRider(el, at) {
        if (!el.__rider || !at) return;
        const heading = at.heading != null ? at.heading : el.__stillHeading || 0;
        el.__stillHeading = heading;
        el.__rider.setRider(at, heading, true, false);
        syncBike(false);
    }

    function ensureMotion(el) {
        if (el.__raf) return;
        const step = (now) => {
            el.__raf = requestAnimationFrame(step);
            const g = el.__glide;
            if (!g || !el.__rider || !el.__agentLive) return;
            if (!g.start) g.start = now;
            const t = Math.min(1, (now - g.start) / g.ms);
            const lat = g.from.lat + (g.to.lat - g.from.lat) * t;
            const lng = g.from.lng + (g.to.lng - g.from.lng) * t;
            el.__rider.setRider({ lat: lat, lng: lng }, g.heading, true, false);
            syncBike(false);
            if (t >= 1) {
                el.__stillHeading = g.heading;
                el.__headingFallback = false;
                el.__glide = null;
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
        el.__agentMeters = hit.meters;
        el.__riderTraveling = false;
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
            const phone = document.documentElement && document.documentElement.classList.contains('tl-phone');
            const mapOpts = {
                center,
                zoom: 17,
                tilt: 45,
                heading: 0,
                mapId: 'DEMO_MAP_ID',
                mapTypeControl: false,
                streetViewControl: false,
                fullscreenControl: !phone,
                zoomControl: !phone,
                rotateControl: false,
                gestureHandling: 'greedy',
                clickableIcons: false,
                scaleControl: !phone,
                backgroundColor: '#e8f1fb',
                minZoom: 12,
                maxZoom: 20,
                isFractionalZoomEnabled: true,
                headingInteractionEnabled: false,
                tiltInteractionEnabled: false
            };
            if (google.maps.ColorScheme) mapOpts.colorScheme = google.maps.ColorScheme.LIGHT;
            if (google.maps.RenderingType) mapOpts.renderingType = google.maps.RenderingType.VECTOR;
            el.__buildings3d = true;
            try {
                el.__map = new google.maps.Map(el, mapOpts);
                el.__vectorMap = true;
            } catch (err) {
                delete mapOpts.mapId;
                delete mapOpts.renderingType;
                delete mapOpts.isFractionalZoomEnabled;
                mapOpts.tilt = 0;
                mapOpts.styles = rasterStyles();
                el.__map = new google.maps.Map(el, mapOpts);
                el.__vectorMap = false;
                el.__buildings3d = false;
            }
            applyBuildings(el);
            el.__map.addListener('dragstart', () => {
                el.__userMoved = true;
            });
            el.__doneLine = trackLine(el, '#64748b', 5, 1);
            el.__remain = trackLine(el, routeColor(), 6, 3);
            el.__markers = {};
            ensureRider(el);
            ensureMotion(el);
            ensureLinks(el);
            if (google.maps.TrafficLayer && !el.__traffic) {
                el.__traffic = new google.maps.TrafficLayer();
                el.__traffic.setMap(el.__map);
            }
            if (!el.querySelector('.tl-map-chip')) {
                const chip = document.createElement('div');
                chip.className = 'tl-map-chip';
                chip.innerHTML = '<b class="tl-map-phase"></b><span class="tl-map-eta"></span>';
                el.appendChild(chip);
            }
            if (!el.querySelector('.tl-map-recenter')) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tl-map-recenter';
                btn.textContent = 'Recenter';
                btn.addEventListener('click', () => {
                    const snap = el.__liveSnap || {};
                    const bounds = new google.maps.LatLngBounds();
                    [snap.store, snap.drop, snap.agent].forEach((pos) => pos && bounds.extend(pos));
                    el.__userMoved = false;
                    fitMap(el, bounds);
                });
                el.appendChild(btn);
            }
            if (el.__vectorMap && !el.querySelector('.tl-map-3d')) {
                const buildings = document.createElement('button');
                buildings.type = 'button';
                buildings.className = 'tl-map-3d is-on';
                buildings.textContent = 'Flat';
                buildings.addEventListener('click', () => {
                    el.__buildings3d = el.__buildings3d === false;
                    buildings.textContent = el.__buildings3d === false ? '3D' : 'Flat';
                    buildings.classList.toggle('is-on', el.__buildings3d !== false);
                    if (el.__buildings3d !== false) {
                        const snap = el.__liveSnap || {};
                        const focus = snap.agent || snap.store || snap.drop;
                        if (focus && el.__map.getZoom && el.__map.getZoom() < 16) {
                            el.__map.panTo(focus);
                            el.__map.setZoom(17);
                        }
                    }
                    applyBuildings(el);
                });
                el.appendChild(buildings);
            }
            if (!el.querySelector('.tl-map-traffic')) {
                const traffic = document.createElement('button');
                traffic.type = 'button';
                traffic.className = 'tl-map-traffic is-on';
                traffic.textContent = 'Traffic';
                traffic.addEventListener('click', () => {
                    const on = traffic.classList.toggle('is-on');
                    if (el.__traffic) el.__traffic.setMap(on ? el.__map : null);
                });
                el.appendChild(traffic);
            }
            startReadoutPoll();
        }
        ensureLinks(el);
        syncMapChrome(el, live);
        const place = (key, pos, title, svg) => {
            if (!pos) {
                if (el.__markers[key]) el.__markers[key].setMap(null);
                return;
            }
            if (!el.__markers[key]) {
                el.__markers[key] = new google.maps.Marker({ map: el.__map, title, icon: markerIcon(svg, 42, 52), zIndex: 3 });
                el.__markers[key].__svg = svg;
                el.__markers[key].addListener('click', () => focusPlace(key));
            } else if (el.__markers[key].__svg !== svg) {
                el.__markers[key].setIcon(markerIcon(svg, 42, 52));
                el.__markers[key].__svg = svg;
            }
            el.__markers[key].setMap(el.__map);
            el.__markers[key].setPosition(pos);
        };
        const previewPins = isPreview(live);
        place('store', live.store, 'Store', previewPins ? PREVIEW_STORE_SVG : STORE_SVG);
        place('drop', live.drop, 'Delivery location', previewPins ? PREVIEW_HOME_SVG : HOME_SVG);
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
                    previewArc(el.__remain, live.store, live.drop);
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
                [live.store, live.drop, live.store && live.drop ? arcMid(live.store, live.drop) : null].forEach((pos) => pos && bounds.extend(pos));
                fitMap(el, bounds);
                el.__fitted = true;
                el.__fitLeg = live.leg;
            }
            if (el.__map && window.google && google.maps.event) google.maps.event.trigger(el.__map, 'resize');
            return;
        }
        if (lockRider(el, live)) return;
        const moving = live.leg !== 'done' && !!live.agent;
        el.__agentLive = moving;
        el.__pendingGps = live.agent || null;
        if (!moving && el.__rider) el.__rider.setRider(null, 0, false, false);
        if (!moving) {
            el.__riderTraveling = false;
            hideEta();
            syncBike(false);
        }
        if (el.__fitLeg && el.__fitLeg !== live.leg) el.__legPath = null;
        const toward = live.leg === 'to_store' ? live.store || live.drop : live.drop || live.store;
        if (moving && live.agent) {
            el.__lastGps = { lat: live.agent.lat, lng: live.agent.lng };
            el.__lastGpsAt = Date.now();
            parkRider(el, live.agent, toward);
        }
        if (live.store && live.drop) loadTrip(el, live.store, live.drop);
        else fallbackLive(el, live);
        if (!el.__fitted || el.__fitLeg !== live.leg) {
            const bounds = new google.maps.LatLngBounds();
            [live.store, live.drop, live.agent].forEach((pos) => pos && bounds.extend(pos));
            fitMap(el, bounds);
            el.__fitted = true;
            el.__fitLeg = live.leg;
            el.__userMoved = false;
        }
        el.__paintedLeg = live.leg;
        if (el.__map && window.google && google.maps.event) google.maps.event.trigger(el.__map, 'resize');
        if (pendingRider) {
            const msg = pendingRider;
            pendingRider = null;
            applyRiderMessage(msg);
        }
    }

    function focusPlace(key) {
        const el = mapEl;
        if (!el || !el.__map || !el.__markers || !window.google) return;
        const live = el.__liveSnap || {};
        const pos = key === 'store' ? live.store : live.drop;
        if (!pos) return;
        Object.keys(el.__markers).forEach((k) => {
            const m = el.__markers[k];
            if (!m || !m.__svg) return;
            const on = k === key;
            m.setIcon(markerIcon(m.__svg, on ? 56 : 42, on ? 70 : 52));
            m.setZIndex(on ? 9 : 3);
        });
        el.__map.panTo(pos);
        if (el.__map.getZoom() < 15) el.__map.setZoom(15);
        if (!el.__info) el.__info = new google.maps.InfoWindow();
        const label = key === 'store' ? live.storeLabel || 'Store' : live.dropLabel || 'Delivery location';
        el.__info.setContent('<div style="font:600 13px/1.4 Inter,system-ui,sans-serif;color:#0f172a;max-width:240px"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#1d4ed8">' + (key === 'store' ? 'Store' : 'Delivery') + '</div>' + esc(label) + '</div>');
        el.__info.open({ map: el.__map, anchor: el.__markers[key] });
        document.querySelectorAll('[data-focus-place]').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-focus-place') === key));
    }

    function isPreview(live) {
        return !!(live && live.leg !== 'done' && (live.route === 'dotted' || live.leg === 'preview' || !live.agent));
    }

    function phaseCopy(live) {
        if (!live || isPreview(live)) return 'From the store';
        if (live.phaseLabel) return live.phaseLabel;
        if (live.leg === 'to_store') return 'Heading to the store';
        return 'On the way to you';
    }

    function syncMapChrome(el, live) {
        if (!el || !el.querySelector) return;
        const phase = el.querySelector('.tl-map-phase');
        const label = (live && live.phaseLabel) || phaseCopy(live);
        if (phase && label) phase.textContent = label;
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
                icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.95, strokeColor: '#1d4ed8', scale: 2.2 }, offset: '0', repeat: '8px' }]
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

    function arcPoints(a, b) {
        const dLat = b.lat - a.lat;
        const dLng = b.lng - a.lng;
        const len = Math.sqrt(dLat * dLat + dLng * dLng) || 0.0001;
        const bow = len * 0.42;
        const cx = (a.lat + b.lat) / 2 + (-dLng / len) * bow;
        const cy = (a.lng + b.lng) / 2 + (dLat / len) * bow;
        const pts = [];
        const steps = 56;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const u = 1 - t;
            pts.push({
                lat: u * u * a.lat + 2 * u * t * cx + t * t * b.lat,
                lng: u * u * a.lng + 2 * u * t * cy + t * t * b.lng
            });
        }
        return pts;
    }

    function arcMid(a, b) {
        const pts = arcPoints(a, b);
        return pts[Math.floor(pts.length / 2)];
    }

    function previewArc(line, a, b) {
        if (!line || !a || !b) return;
        line.setOptions({
            strokeOpacity: 0,
            strokeWeight: 0,
            icons: [{
                icon: { path: 'M 0,-3.2 0,3.2', strokeOpacity: 1, strokeColor: '#1d4ed8', strokeWeight: 3.5, scale: 3 },
                offset: '0',
                repeat: '28px'
            }]
        });
        line.setPath(arcPoints(a, b));
    }

    function dottedLine(line, a, b, pts) {
        if (!line || !a || !b) return;
        if (pts && pts.length > 1) {
            line.setOptions({ strokeColor: '#1d4ed8', strokeOpacity: 0, strokeWeight: 6, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#1d4ed8', scale: 3 }, offset: '0', repeat: '14px' }] });
            line.setPath(pts);
            return;
        }
        line.setOptions({
            strokeColor: routeColor(),
            strokeOpacity: 0,
            strokeWeight: 6,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#1d4ed8', scale: 3 }, offset: '0', repeat: '14px' }]
        });
        line.setPath([a, b]);
    }

    function hideEta() {
        const eta = document.getElementById('tl-eta');
        if (!eta) return;
        eta.hidden = true;
        eta.classList.remove('is-on');
    }

    function showEta(text, label, sub) {
        const eta = document.getElementById('tl-eta');
        if (eta && (text || sub)) {
            eta.hidden = false;
            eta.classList.add('is-on');
            const lbl = eta.querySelector ? eta.querySelector('.hl-eta-lbl, .tl-eta-lbl') : null;
            const val = eta.querySelector ? eta.querySelector('.hl-eta-val, .tl-eta-val') : null;
            const subEl = eta.querySelector ? eta.querySelector('.tl-eta-sub') : null;
            if (lbl && label) lbl.textContent = label;
            if (val && text) val.textContent = text;
            if (subEl && sub) subEl.textContent = sub;
        }
        const phases = document.querySelectorAll ? document.querySelectorAll('.tl-map-phase') : [];
        const etas = document.querySelectorAll ? document.querySelectorAll('.tl-map-eta') : [];
        const shown = text || '';
        const shownSub = sub || '';
        if (label && phases[0]) phases[0].textContent = label;
        const line = [shown, shownSub].filter(Boolean).join(' · ');
        if (etas[0] && line) etas[0].textContent = line;
        const traffic = document.getElementById('tl-traffic-line');
        if (traffic && line) traffic.textContent = line;
    }

    function formatKm(meters) {
        if (!Number.isFinite(meters) || meters < 0) return '';
        if (meters < 1000) return Math.max(10, Math.round(meters / 10) * 10) + ' m';
        const km = meters / 1000;
        return (km < 10 ? km.toFixed(1) : String(Math.round(km))) + ' km';
    }

    function arrivalClock(seconds) {
        const when = new Date(Date.now() + Math.max(0, Number(seconds) || 0) * 1000);
        try {
            return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(when);
        } catch (err) {
            return '';
        }
    }

    function etaSub(dur) {
        if (!dur) return '';
        const km = dur.distanceText || (dur.distanceValue != null ? formatKm(dur.distanceValue) : '');
        const by = dur.value ? 'by ' + arrivalClock(dur.value) : '';
        return [km, by].filter(Boolean).join(' · ');
    }

    function trackLine(el, color, weight, z) {
        const casing = new google.maps.Polyline({
            map: el.__map,
            strokeColor: '#ffffff',
            strokeWeight: weight + 6,
            strokeOpacity: 1,
            zIndex: z,
            clickable: false
        });
        const line = new google.maps.Polyline({
            map: el.__map,
            strokeColor: color,
            strokeWeight: weight,
            strokeOpacity: 1,
            zIndex: z + 1,
            clickable: false
        });
        const rawPath = line.setPath.bind(line);
        const rawOpt = line.setOptions.bind(line);
        line.setPath = function (path) {
            rawPath(path);
            casing.setPath(path || []);
        };
        line.setOptions = function (opts) {
            rawOpt(opts || {});
            const dotted = opts && opts.strokeOpacity === 0;
            casing.setOptions({
                strokeOpacity: dotted ? 0 : 0.96,
                strokeWeight: dotted ? 0 : ((opts && opts.strokeWeight) || weight) + 6,
                icons: null
            });
        };
        return line;
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

    function requestDrive(origin, dest, cb, plain) {
        const req = {
            origin: { lat: origin.lat, lng: origin.lng },
            destination: { lat: dest.lat, lng: dest.lng },
            travelMode: 'DRIVING'
        };
        if (!plain) req.drivingOptions = { departureTime: new Date(), trafficModel: 'bestguess' };
        new google.maps.DirectionsService().route(req, (result, status) => {
            if (status !== 'OK') {
                if (!plain) return requestDrive(origin, dest, cb, true);
                return cb(null, null);
            }
            const pts = routePoints(result);
            const leg = result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0];
            const dur = leg && (leg.duration_in_traffic || leg.duration);
            const distance = leg && leg.distance;
            cb(
                pts.length > 1 ? pts : null,
                dur
                    ? {
                          text: dur.text,
                          value: dur.value,
                          distanceText: distance && distance.text,
                          distanceValue: distance && distance.value,
                          traffic: !!(leg && leg.duration_in_traffic)
                      }
                    : null
            );
        });
    }

    function trafficEta(el, origin, dest, label) {
        if (!el || !origin || !dest) return;
        const key = [Number(origin.lat).toFixed(3), Number(origin.lng).toFixed(3), Number(dest.lat).toFixed(3), Number(dest.lng).toFixed(3), label || ''].join('|');
        const now = Date.now();
        const kmNow = formatKm(haversine(origin, dest));
        const cached = el.__etaKey === key && el.__etaAt && now - el.__etaAt < 8000;
        if (kmNow && !cached) showEta(el.__etaText || '', label, kmNow);
        if (cached) {
            if (el.__etaText || el.__etaSub || kmNow) showEta(el.__etaText || '', label, el.__etaSub || kmNow);
            return;
        }
        if (el.__etaPending === key) return;
        el.__etaPending = key;
        requestDrive(origin, dest, (pts, dur) => {
            if (el.__etaPending === key) el.__etaPending = null;
            if (!dur || !dur.text) return;
            el.__etaKey = key;
            el.__etaAt = Date.now();
            el.__etaText = dur.text;
            el.__etaSub = etaSub(dur);
            showEta(dur.text, label, el.__etaSub);
        });
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
        const fresh = el.__legAt && Date.now() - el.__legAt < 8000;
        if (el.__legPath && el.__legName === legName && fresh && samePoint(el.__legFrom, origin, 50) && samePoint(el.__legTo, dest, 40)) {
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
                el.__legAt = Date.now();
            }
            cb(pts, duration);
        });
    }

    function parkRider(el, agent, toward) {
        if (!el.__rider) return;
        if (!agent) {
            el.__rider.setRider(null, 0, false, false);
            syncBike(false);
            return;
        }
        if (el.__glide) return;
        const device = Number(agent.heading);
        let heading;
        if (Number.isFinite(device)) {
            heading = ((device % 360) + 360) % 360;
            el.__headingFallback = false;
        } else if (el.__stillHeading != null && !el.__headingFallback) {
            heading = el.__stillHeading;
        } else if (toward) {
            heading = bearingDeg(agent, toward) % 360;
            el.__headingFallback = true;
        } else heading = el.__stillHeading || 0;
        el.__stillHeading = heading;
        el.__rider.setRider({ lat: Number(agent.lat), lng: Number(agent.lng) }, heading, true, false);
        syncBike(false);
    }

    function applyPreviewRoad(el, live, pts) {
        el.__agentLive = false;
        el.__path = null;
        if (el.__rider) el.__rider.setRider(null, 0, false);
        if (el.__doneLine) el.__doneLine.setPath([]);
        if (el.__corridor) el.__corridor.setPath([]);
        if (!live.store || !live.drop || !el.__remain) return;
        previewArc(el.__remain, live.store, live.drop);
        clearConnectors(el);
        const dur = el.__tripDuration;
        if (dur && dur.text) showEta(dur.text, 'From the store', etaSub(dur));
        else trafficEta(el, live.store, live.drop, 'From the store');
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
            if (live.agent && target) trafficEta(el, live.agent, target, live.phaseLabel || 'On the way to you');
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
        const cached = el.__legPath && el.__legName === legName && el.__legAt && Date.now() - el.__legAt < 8000 && samePoint(el.__legFrom, live.agent, 50) && samePoint(el.__legTo, target, 40);
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
            const label = snap.phaseLabel || (snap.leg === 'to_store' ? 'Heading to the store' : 'On the way to you');
            if (duration && duration.text && el.__agentLive) showEta(duration.text, label, etaSub(duration));
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
        const label = live.phaseLabel || (live.leg === 'to_store' ? 'Heading to the store' : 'On the way to you');
        if (live.agent && target) trafficEta(el, live.agent, target, label);
        else if (live.store && live.drop) trafficEta(el, live.store, live.drop, 'From the store');
        else hideEta();
    }

    function rasterStyles() {
        return [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
            { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f4f7f5' }] },
            { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#eef2f0' }] },
            { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d7e6f4' }] },
            { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
            { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#dbe7f8' }] },
            { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#e8f1fb' }] },
            { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#dbeafe' }] },
            { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'simplified' }] },
            { featureType: 'administrative', elementType: 'labels.text.fill', stylers: [{ color: '#64748b' }] }
        ];
    }

    function applyBuildings(el) {
        if (!el || !el.__map || !el.__map.setTilt) return;
        try {
            if (el.__map.setHeading) el.__map.setHeading(0);
            el.__map.setTilt(el.__buildings3d === false ? 0 : 45);
        } catch (err) {}
    }

    function fitMap(el, bounds) {
        if (!el || !el.__map || !bounds || (bounds.isEmpty && bounds.isEmpty())) return;
        el.__map.fitBounds(bounds, mapPadding());
        const settle = () => applyBuildings(el);
        if (window.google && google.maps.event && google.maps.event.addListenerOnce) google.maps.event.addListenerOnce(el.__map, 'idle', settle);
        else settle();
    }

    function applyDeviceClass() {
        const root = document.documentElement;
        if (!root || !root.classList) return;
        const width = Math.min(window.innerWidth || 1200, root.clientWidth || window.innerWidth || 1200);
        const phone = width <= 760;
        const tablet = !phone && width <= 1100;
        root.classList.toggle('tl-phone', phone);
        root.classList.toggle('tl-tablet', tablet);
        root.classList.toggle('tl-desktop', !phone && !tablet);
        if (!mapEl || !mapEl.__map) return;
        const phoneNow = root.classList.contains('tl-phone');
        try {
            if (mapEl.__map.setOptions) mapEl.__map.setOptions({ fullscreenControl: !phoneNow, zoomControl: !phoneNow, scaleControl: !phoneNow });
        } catch (err) {}
        applyBuildings(mapEl);
        if (window.google && google.maps.event) google.maps.event.trigger(mapEl.__map, 'resize');
    }

    function routeColor() {
        return '#1d4ed8';
    }

    let readoutTimer = null;
    function startReadoutPoll() {
        if (readoutTimer) return;
        readoutTimer = setInterval(() => {
            const el = mapEl;
            const live = el && el.__liveSnap;
            if (!el || !el.__map || !live || live.leg === 'done') return;
            const preview = isPreview(live);
            const origin = preview ? live.store : live.agent || live.store;
            const target = preview ? live.drop : live.leg === 'to_store' ? live.store || live.drop : live.drop || live.store;
            if (origin && target) trafficEta(el, origin, target, phaseCopy(live));
        }, 8000);
    }

    function mapPadding() {
        const root = document.documentElement;
        if (root && root.classList && root.classList.contains('tl-phone')) return { top: 56, right: 16, bottom: 52, left: 16 };
        return document.body.classList.contains('hl-page') ? { top: 72, right: 72, bottom: 96, left: 72 } : 64;
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
    applyDeviceClass();
    if (window.addEventListener) window.addEventListener('resize', applyDeviceClass);
    window.TrackTimeline = { render, mount, bind, when, esc, updates, tick: tickLines, focusPlace, watch: watchRider, acceptFix, haversine };
})();

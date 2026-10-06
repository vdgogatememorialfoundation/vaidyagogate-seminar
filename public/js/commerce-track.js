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

    function iconSvg(paths) {
        return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="' + paths + '"/></svg>';
    }

    function stepIcon(key) {
        const paths = {
            ORDERED: 'M8 4h8v3H8zM7 7h10v13H7zM9 12h6M9 16h4',
            PACKED: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8M12 12v8',
            SHIPPED: 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM18 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3z',
            OUT_FOR_DELIVERY: 'M5 17a2 2 0 110-4 2 2 0 010 4zM16 17a2 2 0 110-4 2 2 0 010 4zM7 15h7l2-5H10M14 10l2 5M9 8h5',
            DELIVERED: 'M5 12l5 5L20 7'
        };
        return iconSvg(paths[key] || paths.ORDERED);
    }

    function latestAt(step) {
        let best = 0;
        let iso = '';
        (step.events || []).forEach((ev) => {
            const ms = ev && ev.at ? Date.parse(ev.at) : NaN;
            if (Number.isFinite(ms) && ms >= best) {
                best = ms;
                iso = ev.at;
            }
        });
        return iso;
    }

    function ago(at) {
        const ms = at ? Date.parse(at) : NaN;
        if (!Number.isFinite(ms)) return '';
        const min = Math.round((Date.now() - ms) / 60000);
        if (min < 1) return 'Just now';
        if (min < 60) return min + ' min ago';
        const hr = Math.round(min / 60);
        if (hr < 36) return hr + ' hr ago';
        return Math.round(hr / 24) + ' days ago';
    }

    function clock(at) {
        const text = when(at);
        const rel = ago(at);
        if (!text) return '';
        return rel ? text + ' · ' + rel : text;
    }

    function lineNote(track) {
        const steps = track.pipeline || [];
        const index = steps.findIndex((step) => step.state === 'active');
        const active = index >= 0 ? steps[index] : null;
        if (!active) return 'Completed steps stay green from the top of the journey to the bottom.';
        if (track.operationalStatus === 'DELIVERY_ATTEMPT_FAILED') {
            return 'The line stays on ' + active.title + ' until the next attempt starts.';
        }
        const next = steps[index + 1];
        if (!next) return 'The line has reached the bottom. This shipment is delivered.';
        if (active.key === 'PACKED') return 'The line moves down from the order time toward the expected pickup, and it stops before ' + next.title + '.';
        if (active.key === 'SHIPPED') return 'The line moves down from pickup toward the expected delivery, and it stops before ' + next.title + '.';
        if (active.key === 'OUT_FOR_DELIVERY') return 'The line moves down through the delivery window, and it stops before ' + next.title + '.';
        return 'The line moves down from the top and pauses on ' + active.title + ', before ' + next.title + '.';
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
                const timed = step.state === 'active' && step.lineUntil;
                const grow = timed ? '0' : step.state === 'active' ? (step.lineGrow != null ? step.lineGrow : '0.55') : '1';
                const tick = timed
                    ? ' data-line-since="' + Number(step.lineSince) + '" data-line-until="' + Number(step.lineUntil) + '"'
                    : '';
                const firstUpcoming = (track.pipeline || []).findIndex((row) => row.state === 'upcoming');
                const nextHint = i === firstUpcoming && step.message ? '<div class="ship-next">Up next · ' + esc(step.message) + '</div>' : '';
                const reached = step.state === 'upcoming' ? '' : latestAt(step);
                const stamp = reached ? '<span class="ship-time">' + esc(clock(reached)) + '</span>' : '';
                const head = timed ? '<span class="ship-headway" aria-hidden="true"></span>' : '';
                return '<li class="' + esc(step.state) + '"' + tick + ' style="--i:' + i + ';--grow:' + grow + '">' + head + '<span class="dot">' + stepIcon(step.key) + '</span><div class="ship-copy"><div class="ship-title"><b>' + esc(step.title) + '</b>' + stamp + '</div>' +
                    (step.message && step.state !== 'upcoming' ? '<div class="ship-msg">' + esc(step.message) + '</div>' : '') +
                    nextHint +
                    (step.expectedLabel ? '<span class="ship-expect">' + esc(step.expectedLabel) + '</span>' : '') +
                    (kids || shippedNote ? '<ul class="ship-kids">' + kids + shippedNote + '</ul>' : '') +
                    '</div></li>';
            })
            .join('');
    }

    function railHtml(track) {
        return '<ol class="trk-rail">' + (track.pipeline || []).map((step) =>
            '<li class="' + esc(step.state) + '"><span class="trk-rail-ico">' + stepIcon(step.key) + '</span><span>' + esc(step.title) + '</span></li>'
        ).join('') + '</ol>';
    }

    function progressHtml(track) {
        return '<h2 class="hl-progress-title">Order progress</h2><p class="trk-line-note">' + esc(lineNote(track)) + '</p><ol class="ship-pipe">' + pipeHtml(track) + '</ol>' + logHtml(track);
    }

    function deliveryHtml(track) {
        return track && track.deliveryBy
            ? '<div class="hl-drop"><div class="lbl">Delivery by</div><div class="val">' + esc(track.deliveryBy) + '</div></div>'
            : '';
    }

    function growFor(el) {
        const since = Number(el.getAttribute('data-line-since'));
        const until = Number(el.getAttribute('data-line-until'));
        if (!until || until <= since) return 0.12;
        const now = Date.now();
        const ratio = now <= since ? 0.12 : Math.min(1, (now - since) / (until - since));
        return Math.min(0.55, Math.max(0.12, Math.round(ratio * 100) / 100));
    }

    function tickPipe() {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const items = Array.from(document.querySelectorAll('.ship-pipe > li'));
        const activeIndex = items.findIndex((el) => el.classList.contains('active'));
        const stepMs = 1150;
        const wait = reduce || activeIndex <= 0 ? 0 : activeIndex * stepMs;
        items.forEach((el) => {
            if (!el.classList.contains('active') || !el.hasAttribute('data-line-until')) return;
            const grow = String(growFor(el));
            if (!el.dataset.lined) {
                const intro = Math.max(360, Math.round(Number(grow) * stepMs));
                el.dataset.lined = reduce ? '1' : 'wait';
                el.style.setProperty('--grow', reduce ? grow : '0');
                el.style.setProperty('--draw', reduce ? '0s' : intro + 'ms');
                if (!reduce) {
                    window.setTimeout(() => {
                        el.dataset.lined = '1';
                        requestAnimationFrame(() => el.style.setProperty('--grow', String(growFor(el))));
                    }, wait);
                }
            } else if (el.dataset.lined === '1') {
                el.style.setProperty('--draw', '2s');
                el.style.setProperty('--grow', grow);
            }
        });
        const ring = document.querySelector('.trk-ring');
        if (!ring || !items.length) return;
        let portion = 0;
        items.forEach((el) => {
            if (el.classList.contains('done')) portion += 1;
            else if (el.classList.contains('active')) {
                const grow = Number(String(el.style.getPropertyValue('--grow')).trim());
                portion += Number.isFinite(grow) ? Math.min(0.55, Math.max(0, grow)) : 0.12;
            }
        });
        const fill = String(Math.round((portion / items.length) * 100));
        if (!ring.dataset.filled) {
            ring.dataset.filled = '1';
            ring.style.setProperty('--fill', '0');
            requestAnimationFrame(() => ring.style.setProperty('--fill', fill));
        } else {
            ring.style.setProperty('--fill', fill);
        }
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

    function factCard(label, value, extra) {
        if (!value) return '';
        return '<article class="trk-fact"><div class="lbl">' + esc(label) + '</div><div class="val">' + esc(value) + '</div>' + (extra || '') + '</article>';
    }

    function logHtml(track) {
        const rows = [];
        (track.pipeline || []).forEach((step) => {
            (step.events || []).forEach((ev) => rows.push({ key: step.key, title: step.title, ev: ev }));
        });
        rows.sort((a, b) => (Date.parse(b.ev.at) || 0) - (Date.parse(a.ev.at) || 0));
        if (!rows.length) return '';
        const items = rows.map((row, i) =>
            '<li' + (i >= 4 ? ' class="trk-log-more"' : '') + '><span class="trk-log-ico">' + stepIcon(row.key) + '</span><div><span class="trk-log-step">' + esc(row.title) + '</span><b>' + esc(row.ev.message) + '</b>' +
            (row.ev.at ? '<div class="when">' + esc(clock(row.ev.at)) + '</div>' : '') +
            (row.ev.location ? '<div class="where">' + esc(row.ev.location) + '</div>' : '') +
            (row.ev.reason ? '<div class="where">Reason: ' + esc(row.ev.reason) + '</div>' : '') +
            '</div></li>'
        ).join('');
        const more = rows.length > 4
            ? '<button type="button" class="trk-more" data-more="1">Show all ' + rows.length + ' updates</button>'
            : '';
        return '<section class="trk-log"><div class="trk-log-head"><h2>Shipment updates</h2><span>' + rows.length + '</span></div><ol>' + items + '</ol>' + more + '</section>';
    }

    function attemptCard(track) {
        const attempt = track.deliveryAttempt;
        if (!attempt || !attempt.attemptNumber) return '';
        const windowText = attempt.scheduledDate && attempt.scheduledStart
            ? attempt.scheduledDate + ' ' + attempt.scheduledStart + (attempt.scheduledEnd ? ' – ' + attempt.scheduledEnd : '')
            : '';
        return factCard('Delivery attempt', String(attempt.attemptNumber), windowText ? '<div class="where">' + esc(windowText) + '</div>' : '');
    }

    function documentHtml(track, shipment) {
        const courier = (track.shipment && track.shipment.courier) || 'Gogate Products';
        const mode = track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal delivery' : 'Logistics';
        const detail = track.currentDetail || track.currentMessage || '';
        const code = track.orderId || shipment.orderCode || '';
        const active = (track.pipeline || []).find((step) => step.state === 'active') || (track.pipeline || [])[0] || {};
        const expects = (track.pipeline || []).filter((step) => step.expectedLabel).map((step) =>
            '<article class="trk-when"><span class="trk-when-ico">' + stepIcon(step.key) + '</span><div><div class="lbl">' + esc(step.title) + '</div><div class="val">' + esc(step.expectedLabel) + '</div></div></article>'
        ).join('');
        const trackingId = track.shipment && track.shipment.trackingId;
        const steps = track.pipeline || [];
        const doneCount = steps.filter((step) => step.state === 'done').length;
        const stepNo = active && active.state === 'active' ? doneCount + 1 : doneCount;
        return '<div class="trk">' +
            '<header class="trk-bar"><div class="trk-brand"><span class="trk-mark">' + iconSvg('M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8') + '</span><div><div class="trk-brand-name">Gogate Products</div><div class="trk-brand-sub">Shipment tracking</div></div></div>' +
            '<div class="trk-actions">' +
            (code ? '<button type="button" class="trk-copy" data-copy="' + esc(code) + '">Copy order</button>' : '') +
            '<button type="button" class="trk-copy" data-copy-href="1">Copy link</button>' +
            '</div></header>' +
            '<section class="trk-hero"><div class="trk-ring" style="--fill:0"><span class="trk-ring-ico">' + stepIcon(active.key) + '</span></div><div><div class="trk-kicker">Order #' + esc(code) + '</div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            (detail ? '<p>' + esc(detail) + '</p>' : '') +
            '<p class="trk-stepno">Step ' + stepNo + ' of ' + (steps.length || 5) + '</p>' +
            '</div></section>' +
            railHtml(track) +
            '<div class="trk-facts">' +
            factCard('Courier', courier) +
            factCard('Service', mode) +
            (trackingId ? factCard('Tracking ID', trackingId, '<button type="button" class="trk-copy trk-copy-mini" data-copy="' + esc(trackingId) + '">Copy</button>') : '') +
            (track.deliveryBy ? factCard('Delivery by', track.deliveryBy) : '') +
            attemptCard(track) +
            '</div>' +
            (expects ? '<div class="trk-whens">' + expects + '</div>' : '') +
            failureHtml(track) +
            otpHtml('Pickup OTP', track.pickupOtp) + otpHtml('Delivery OTP', track.deliveryOtp) +
            '<section class="trk-progress"><h2>Order progress</h2><p class="trk-line-note">' + esc(lineNote(track)) + '</p><ol class="ship-pipe">' + pipeHtml(track) + '</ol></section>' +
            logHtml(track) +
            '<footer class="trk-foot"><a href="' + esc(track.supportUrl || '/support') + '">Need help with this shipment?</a><span id="trk-fresh">Checking for updates</span><span>Refreshes automatically</span></footer>' +
            '</div>';
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
        const steady = Object.assign({}, track, {
            pipeline: (track.pipeline || []).map((step) => {
                const copy = Object.assign({}, step);
                delete copy.lineGrow;
                return copy;
            })
        });
        const sig = JSON.stringify(steady) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.leg ? live.leg : '') + '|' + (live && live.route ? live.route : '');
        if (!(editing && !editing.hidden) && sig !== drawn) {
            drawn = sig;
            tracker.innerHTML = liveSheet ? sheetHtml(track, shipment) : documentHtml(track, shipment);
            bindCopy();
            bindMore();
        }
        bindReschedule();
        bindNote();
        touchFresh();
        tickPipe();
        if (live && window.TrackTimeline) TrackTimeline.mount(live);
    }

    function bindCopy() {
        tracker.querySelectorAll('[data-copy], [data-copy-href]').forEach((btn) => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            const label = btn.textContent;
            btn.addEventListener('click', async () => {
                const text = btn.hasAttribute('data-copy-href') ? window.location.href : btn.getAttribute('data-copy') || '';
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
                    else return;
                    btn.textContent = 'Copied';
                    btn.classList.add('is-on');
                    setTimeout(() => {
                        btn.textContent = label;
                        btn.classList.remove('is-on');
                    }, 1200);
                } catch (err) {
                    btn.textContent = 'Copy blocked';
                }
            });
        });
    }

    function touchFresh() {
        const el = document.getElementById('trk-fresh');
        if (!el) return;
        el.textContent = 'Updated ' + new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            minute: '2-digit'
        }).format(new Date());
    }

    function bindMore() {
        const btn = tracker.querySelector('[data-more]');
        if (!btn || btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            const box = btn.closest('.trk-log');
            if (!box) return;
            const open = box.classList.toggle('is-open');
            btn.textContent = open ? 'Show fewer updates' : 'Show all ' + box.querySelectorAll('li').length + ' updates';
        });
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

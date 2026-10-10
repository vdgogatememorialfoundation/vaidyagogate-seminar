(function () {
    const params = new URLSearchParams(window.location.search);
    const returnToken = params.get('return') || '';
    const token = params.get('token') || '';
    const sub = document.getElementById('sub');
    const tracker = document.getElementById('tracker');
    const isReturn = (track) => !!(track && (track.kind === 'return' || track.kind === 'replacement'));
    const kindWord = (track) => (track && track.kind === 'replacement' ? 'Replacement' : 'Return');
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
            DELIVERED: 'M5 12l5 5L20 7',
            REQUESTED: 'M8 4h8v3H8zM7 7h10v13H7zM9 12h6M9 16h4',
            APPROVED: 'M5 12l5 5L20 7',
            PICKUP_SCHEDULED: 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM18 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3z',
            IN_TRANSIT: 'M5 17a2 2 0 110-4 2 2 0 010 4zM16 17a2 2 0 110-4 2 2 0 010 4zM7 15h7l2-5H10M14 10l2 5M9 8h5',
            RECEIVED: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8M12 12v8',
            REFUNDED: 'M12 3v18M7 8h7a3 3 0 010 6H8a3 3 0 000 6h8',
            REPLACEMENT_PREPARING: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8M12 12v8',
            REPLACEMENT_SENT: 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM18 18a1.5 1.5 0 110-3 1.5 1.5 0 010 3z',
            REPLACEMENT_DELIVERED: 'M5 12l5 5L20 7'
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
        if (isReturn(track)) {
            if (track.rejected) return 'This request was declined.';
            const nxt = steps[index + 1];
            return nxt ? 'Current step: ' + (active ? active.title : '') + '. Up next: ' + nxt.title + '.' : 'This ' + kindWord(track).toLowerCase() + ' is complete.';
        }
        if (!active) return 'Completed steps stay green from the top of the journey to the bottom.';
        if (track.operationalStatus === 'DELIVERY_ATTEMPT_FAILED') {
            return 'The line stays on ' + active.title + ' until the next attempt starts.';
        }
        const next = steps[index + 1];
        if (!next) {
            const at = track.dates && track.dates.deliveryAt ? when(track.dates.deliveryAt) : '';
            return at ? 'Delivered ' + at + '.' : 'This shipment is delivered.';
        }
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
                const courierStep = isReturn(track) ? 'PICKUP_SCHEDULED' : 'SHIPPED';
                const shippedNote = step.key === courierStep && step.state !== 'upcoming' && track.shipment && (track.shipment.courier || track.shipment.trackingId)
                    ? '<div class="ship-courier"><b>' + esc(track.shipment.courier || 'Gogate Products') + '</b><span>' +
                      esc(isReturn(track) ? kindWord(track) + ' pickup' : track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal' : 'Logistics') +
                      (track.shipment.trackingId ? ' · Tracking ID ' + esc(track.shipment.trackingId) : '') +
                      (track.shipment.externalLink ? ' · <a href="' + esc(track.shipment.externalLink) + '" target="_blank" rel="noopener">Courier site</a>' : '') +
                      '</span></div>'
                    : '';
                const settled = track.mainStatus === 'DELIVERED';
                const timed = step.state === 'active' && step.lineUntil && !settled;
                const grow = '0';
                const tick = timed
                    ? ' data-line-since="' + Number(step.lineSince) + '" data-line-until="' + Number(step.lineUntil) + '"'
                    : '';
                const firstUpcoming = (track.pipeline || []).findIndex((row) => row.state === 'upcoming');
                const nextHint = i === firstUpcoming && step.message ? '<div class="ship-next">Up next · ' + esc(step.message) + '</div>' : '';
                const reached = step.state === 'upcoming' ? '' : latestAt(step);
                const stamp = reached ? '<span class="ship-time">' + esc(clock(reached)) + '</span>' : '';
                const head = timed ? '<span class="ship-headway" aria-hidden="true"></span>' : '';
                const stageCopy = step.message && step.state !== 'upcoming' && !(step.state === 'done' && step.key === 'OUT_FOR_DELIVERY' && !(step.events || []).length);
                return '<li class="' + esc(step.state) + '"' + tick + ' style="--i:' + i + ';--grow:' + grow + '">' + head + '<span class="dot">' + stepIcon(step.key) + '</span><div class="ship-copy"><div class="ship-title"><b>' + esc(step.title) + '</b>' + stamp + '</div>' +
                    (stageCopy ? '<div class="ship-msg">' + esc(step.message) + '</div>' : '') +
                    nextHint +
                    (showExpect(step) ? '<span class="ship-expect">' + esc(step.expectedLabel) + '</span>' : '') +
                    shippedNote +
                    (kids ? '<ul class="ship-kids">' + kids + '</ul>' : '') +
                    '</div></li>';
            })
            .join('');
    }

    function showExpect(step) {
        if (!step || !step.expectedLabel || step.state === 'done') return false;
        if (step.state === 'active' && (step.events || []).length && step.key !== 'OUT_FOR_DELIVERY') return false;
        return true;
    }

    function timingBadge(track) {
        const timing = track && track.timing;
        if (!timing || (timing.state !== 'on_time' && timing.state !== 'delayed')) return '';
        const late = timing.state === 'delayed';
        return '<span class="trk-pill ' + (late ? 'is-late' : 'is-ok') + '">' + esc(timing.label || (late ? 'Delayed' : 'On time')) + '</span>';
    }

    function railHtml(track) {
        return '<nav class="trk-nav" aria-label="Shipment progress"><div class="trk-nav-line" aria-hidden="true"><span class="trk-nav-fill" style="--nav:0"></span></div><ol class="trk-rail">' +
            (track.pipeline || []).map((step, i) =>
                '<li class="' + esc(step.state) + '" style="--i:' + i + '"><span class="trk-rail-ico">' +
                (step.state === 'done' ? iconSvg('M5 12l5 5L20 7') : stepIcon(step.key)) +
                '</span><span class="trk-rail-name">' + esc(step.title) + '</span></li>'
            ).join('') +
            '</ol></nav>';
    }

    function progressHtml(track) {
        return '<h2 class="hl-progress-title">Order progress</h2><p class="trk-line-note">' + esc(lineNote(track)) + '</p><ol class="ship-pipe">' + pipeHtml(track) + '</ol>' + logHtml(track);
    }

    function deliveryHtml(track) {
        const badge = timingBadge(track);
        if (track && track.timing && track.timing.deliveredAt) {
            return '<div class="hl-drop"><div class="lbl">Delivered</div><div class="val">' + esc(when(track.timing.deliveredAt)) + (badge ? ' ' + badge : '') + '</div></div>';
        }
        return track && track.deliveryBy
            ? '<div class="hl-drop"><div class="lbl">Delivery by</div><div class="val">' + esc(track.deliveryBy) + (badge ? ' ' + badge : '') + '</div></div>'
            : badge ? '<div class="hl-drop">' + badge + '</div>' : '';
    }

    function growFor(el) {
        const since = Number(el.getAttribute('data-line-since'));
        const until = Number(el.getAttribute('data-line-until'));
        if (!until || until <= since) return 0.12;
        const now = Date.now();
        const ratio = now <= since ? 0.12 : Math.min(1, (now - since) / (until - since));
        return Math.min(0.55, Math.max(0.12, Math.round(ratio * 100) / 100));
    }

    function targetGrow(el) {
        if (el.classList.contains('done')) return 1;
        if (!el.classList.contains('active')) return 0;
        if (el.hasAttribute('data-line-until')) return growFor(el);
        return 0.55;
    }

    function tickPipe() {
        document.querySelectorAll('.ship-pipe').forEach(tickOnePipe);
    }

    function tickOnePipe(pipe) {
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const root = pipe.closest('.trk, .hl') || document;
        const items = Array.from(pipe.querySelectorAll(':scope > li'));
        const playable = items.filter((el) => el.classList.contains('done') || el.classList.contains('active'));
        const stepMs = 900;
        if (pipe && !pipe.dataset.playing) {
            pipe.dataset.playing = 'play';
            if (reduce) {
                playable.forEach((el) => {
                    el.style.setProperty('--draw', '0s');
                    el.style.setProperty('--grow', String(targetGrow(el)));
                });
                pipe.dataset.playing = 'live';
            } else {
                playable.forEach((el) => {
                    el.style.setProperty('--draw', '0s');
                    el.style.setProperty('--grow', '0');
                });
                let index = 0;
                const next = () => {
                    const el = playable[index];
                    if (!el) {
                        pipe.dataset.playing = 'live';
                        return;
                    }
                    const target = targetGrow(el);
                    const ms = el.classList.contains('done') ? stepMs : Math.max(280, Math.round(target * stepMs));
                    el.style.setProperty('--draw', ms + 'ms');
                    requestAnimationFrame(() => el.style.setProperty('--grow', String(target)));
                    index += 1;
                    window.setTimeout(next, ms);
                };
                requestAnimationFrame(next);
            }
        } else if (pipe && pipe.dataset.playing === 'live') {
            items.forEach((el) => {
                if (!el.classList.contains('active') || !el.hasAttribute('data-line-until')) return;
                el.style.setProperty('--draw', '2s');
                el.style.setProperty('--grow', String(growFor(el)));
            });
        }
        if (!items.length) return;
        const last = items[items.length - 1];
        const finished = last && last.classList.contains('active') && !items.some((el) => el.classList.contains('upcoming'));
        let portion = 0;
        if (!finished) {
            items.forEach((el) => {
                if (el.classList.contains('done')) portion += 1;
                else if (el.classList.contains('active')) {
                    const grow = Number(String(el.style.getPropertyValue('--grow')).trim());
                    portion += Number.isFinite(grow) ? Math.min(0.55, Math.max(0, grow)) : 0.12;
                }
            });
        }
        const fill = finished ? '100' : String(Math.round((portion / items.length) * 100));
        const ring = root.querySelector('.trk-ring');
        const nav = root.querySelector('.trk-nav-fill');
        [ring, nav].forEach((el) => {
            if (!el) return;
            const prop = el.classList.contains('trk-ring') ? '--fill' : '--nav';
            if (!el.dataset.filled) {
                el.dataset.filled = '1';
                el.style.setProperty(prop, '0');
                requestAnimationFrame(() => el.style.setProperty(prop, fill));
            } else {
                el.style.setProperty(prop, fill);
            }
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
        return '<section class="trk-log"><div class="trk-log-head"><h2>' + (isReturn(track) ? kindWord(track) + ' updates' : 'Shipment updates') + '</h2><span>' + rows.length + '</span></div><ol>' + items + '</ol>' + more + '</section>';
    }

    function attemptCard(track) {
        const attempt = track.deliveryAttempt;
        if (!attempt || !attempt.attemptNumber) return '';
        const notable = track.operationalStatus === 'DELIVERY_ATTEMPT_FAILED' || track.operationalStatus === 'RESCHEDULED' || attempt.failureReason || attempt.rescheduledForStart;
        if (!notable) return '';
        const windowText = attempt.scheduledDate && attempt.scheduledStart
            ? attempt.scheduledDate + ' ' + attempt.scheduledStart + (attempt.scheduledEnd ? ' – ' + attempt.scheduledEnd : '')
            : '';
        return factCard('Delivery attempt', String(attempt.attemptNumber), windowText ? '<div class="where">' + esc(windowText) + '</div>' : '');
    }

    function dateBoard(track) {
        const dates = (track && track.dates) || {};
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
        if (!shipped && !delivery) return '';
        const kind = (state) => (state === 'actual' ? 'Actual' : state === 'expected' ? 'Expected' : '');
        const shipIco = '<img src="/media/delivery-rider.webp" alt="">';
        const dropIco = iconSvg('M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z');
        const tile = (label, state, value, ico, extra) =>
            value
                ? '<article class="trk-date' + (extra || '') + '"><span class="trk-date-ico" aria-hidden="true">' + ico + '</span><div class="trk-date-copy"><div class="trk-date-top"><span class="lbl">' + esc(label) + '</span><span class="kind is-' + esc(state) + '">' + esc(kind(state)) + '</span></div><div class="val">' + esc(value) + '</div></div></article>'
                : '';
        const promised = dates.deliveryState === 'actual' && dates.promisedLabel
            ? '<p class="trk-date-note">Promised ' + esc(dates.promisedLabel) + '</p>'
            : '';
        const repeatsDelivery = dates.deliveryState === 'actual' && /delivered/i.test(String(dates.updatedLabel || ''));
        const fresh = dates.updatedAt && !repeatsDelivery
            ? '<span class="trk-date-fresh">Latest' + (dates.updatedLabel ? ' · ' + esc(dates.updatedLabel) : '') + ' · ' + esc(when(dates.updatedAt)) + '</span>'
            : '';
        return '<section class="trk-dates" aria-label="Shipping and delivery">' +
            tile('Shipping', dates.shippedState, shipped, shipIco, '') +
            tile('Delivery', dates.deliveryState, delivery, dropIco, ' is-delivery') +
            '<div class="trk-date-meta">' + (timingBadge(track) || '') + promised + fresh + '</div></section>';
    }

    function documentHtml(track, shipment) {
        const ret = isReturn(track);
        const courier = (track.shipment && track.shipment.courier) || (ret ? 'Store pickup / courier' : 'Gogate Products');
        const mode = ret ? kindWord(track) + ' pickup' : track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal delivery' : 'Logistics';
        const detail = track.currentDetail || track.currentMessage || '';
        const code = track.orderId || shipment.orderCode || '';
        const active = (track.pipeline || []).find((step) => step.state === 'active') || (track.pipeline || [])[0] || {};
        const expects = (track.pipeline || []).filter(showExpect).map((step) =>
            '<article class="trk-when"><span class="trk-when-ico">' + stepIcon(step.key) + '</span><div><div class="lbl">' + esc(step.title) + '</div><div class="val">' + esc(step.expectedLabel) + '</div></div></article>'
        ).join('');
        const trackingId = track.shipment && track.shipment.trackingId;
        const steps = track.pipeline || [];
        const doneCount = steps.filter((step) => step.state === 'done').length;
        const delivered = active && active.state === 'active' && (active.key === 'DELIVERED' || active.key === 'REFUNDED' || active.key === 'REPLACEMENT_DELIVERED');
        const stepNo = delivered ? steps.length : active && active.state === 'active' ? doneCount + 1 : doneCount;
        const board = dateBoard(track);
        const badge = board ? '' : timingBadge(track);
        return '<div class="trk' + (delivered ? ' is-settled' : '') + '">' +
            '<header class="trk-bar"><div class="trk-brand"><span class="trk-mark">' + iconSvg('M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8') + '</span><div><div class="trk-brand-name">Gogate Products</div><div class="trk-brand-sub">' + (ret ? kindWord(track) + ' tracking' : 'Shipment tracking') + '</div></div></div>' +
            '<div class="trk-actions">' +
            (code ? '<button type="button" class="trk-copy" data-copy="' + esc(code) + '">Copy order</button>' : '') +
            '<button type="button" class="trk-copy" data-copy-href="1">Copy link</button>' +
            '</div></header>' +
            '<section class="trk-hero"><div class="trk-ring" style="--fill:0"><span class="trk-ring-ico">' + stepIcon(active.key) + '</span></div><div class="trk-hero-copy"><div class="trk-kicker">' + (ret ? kindWord(track) + ' for order #' : 'Order #') + esc(code) + (badge ? ' ' + badge : '') + '</div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            (detail ? '<p>' + esc(detail) + '</p>' : '') +
            '<p class="trk-stepno">' + (delivered ? 'Completed' : 'Step ' + stepNo + ' of ' + (steps.length || 5)) + '</p>' +
            '</div>' + board + '</section>' +
            railHtml(track) +
            '<div class="trk-facts">' +
            factCard('Courier', courier) +
            factCard('Service', mode) +
            (trackingId ? factCard('Tracking ID', trackingId, '<button type="button" class="trk-copy trk-copy-mini" data-copy="' + esc(trackingId) + '">Copy</button>') : '') +
            attemptCard(track) +
            '</div>' +
            (expects ? '<div class="trk-whens">' + expects + '</div>' : '') +
            failureHtml(track) +
            otpHtml('Pickup OTP', track.pickupOtp) + otpHtml('Delivery OTP', track.deliveryOtp) +
            '<section class="trk-progress"><h2>' + (ret ? kindWord(track) + ' progress' : 'Order progress') + '</h2><p class="trk-line-note">' + esc(lineNote(track)) + '</p><ol class="ship-pipe">' + pipeHtml(track) + '</ol></section>' +
            logHtml(track) +
            '<footer class="trk-foot"><a href="' + esc(track.supportUrl || '/support') + '">Need help with this ' + (ret ? kindWord(track).toLowerCase() : 'shipment') + '?</a><span class="trk-fresh">Checking for updates</span><span>Refreshes automatically</span></footer>' +
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
        const onRoad =
            String(track.commerceStage || '') === 'out_for_delivery' &&
            Number.isFinite(Number(track.agentLat)) &&
            Number.isFinite(Number(track.agentLng));
        const bike = onRoad
            ? '<span class="hl-bike hl-bike-3d" aria-hidden="true"><img src="/media/delivery-rider.webp" alt=""></span>'
            : '<span class="hl-bike hl-bike-idle" aria-hidden="true"><svg viewBox="0 0 48 48" width="40" height="40"><path d="M8 18l16-8 16 8v14l-16 8-16-8z" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/><path d="M8 18l16 8 16-8M24 26v14" fill="none" stroke="#94a3b8" stroke-width="2"/></svg></span>';
        const partner = '<div class="hl-partner">' + bike +
            '<div class="hl-partner-copy"><div class="lbl">Delivery partner</div><div class="hl-partner-name">' +
            esc(name || (href ? 'Delivery partner' : 'Finding a delivery partner')) + '</div></div>' +
            (name ? '<span class="hl-avatar" aria-hidden="true">' + esc(initial) + '</span>' : '') +
            call + '</div>';
        const livePill = track.map && track.map.live ? '<span class="hl-live-pill">Live</span>' : '';
        const map = shipment.live
            ? '<div class="hl-map"><div id="tl-map-slot"></div><div class="hl-legend">' + livePill +
              '<span><i class="is-store"></i>Store</span><span><i class="is-road"></i>Route</span><span><i class="is-home"></i>Delivery</span></div></div>'
            : '<div class="hl-map hl-map-empty">The map appears when the store and delivery locations are available.</div>';
        const board = dateBoard(track);
        const badge = board ? '' : timingBadge(track);
        const settled = track.mainStatus === 'DELIVERED';
        return '<div class="hl hl-wide' + (settled ? ' is-settled' : '') + '">' + map +
            '<section class="hl-sheet">' +
            '<header class="hl-brand"><span class="trk-mark">' + iconSvg('M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8') + '</span><div><div class="trk-brand-name">Gogate Products</div><div class="trk-brand-sub">Hyperlocal delivery</div></div></header>' +
            '<div class="hl-top"><div><div class="hl-kicker">Order #' + esc(track.orderId || shipment.orderCode || '') + (badge ? ' ' + badge : '') + '</div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            '<p class="hl-sub">' + esc(partnerLine(track)) + '</p>' +
            (track.map.live ? '' : '<p class="hl-wait">The route stays dotted until a delivery partner location arrives.</p>') +
            '</div><div id="tl-eta" class="hl-eta" hidden><span class="hl-eta-lbl">Arriving</span><b class="hl-eta-val"></b></div></div>' +
            railHtml(track) +
            board +
            (track.dropLabel ? '<div class="hl-drop"><div class="lbl">Delivering to</div><div class="val">' + esc(track.dropLabel) + '</div></div>' : '') +
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

    function bindCopy(root) {
        (root || tracker).querySelectorAll('[data-copy], [data-copy-href]').forEach((btn) => {
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

    function touchFresh(root) {
        (root || document).querySelectorAll('.trk-fresh').forEach((el) => {
            el.textContent = 'Updated ' + new Intl.DateTimeFormat('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                minute: '2-digit'
            }).format(new Date());
        });
    }

    /** Embeddable renderer: draws an order or return `track` into any container (admin panel, shop order page). */
    window.ShipTrack = {
        html: function (track, shipment) {
            if (!track || !track.pipeline) return '';
            return documentHtml(track, shipment || {});
        },
        draw: function (container, track, shipment) {
            if (!container) return;
            const html = window.ShipTrack.html(track, shipment);
            if (container.dataset.sig === html) return;
            container.dataset.sig = html;
            container.innerHTML = html;
            container.querySelectorAll('.ship-pipe').forEach((pipe) => delete pipe.dataset.playing);
            bindCopy(container);
            bindMore(container);
            touchFresh(container);
            tickPipe();
        },
        tick: tickPipe
    };

    function bindMore(root) {
        (root || tracker).querySelectorAll('[data-more]').forEach((btn) => bindMoreBtn(btn));
    }

    function bindMoreBtn(btn) {
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
        if (returnToken) {
            try {
                const res = await fetch('/api/public/commerce/track-return?token=' + encodeURIComponent(returnToken));
                const data = await res.json();
                if (!res.ok) {
                    sub.textContent = data.error || 'Return shipment not found.';
                    return;
                }
                document.title = 'Return tracking';
                render(data.shipment || {});
            } catch (e) {
                sub.textContent = 'Could not refresh tracking.';
            }
            return;
        }
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

    if (tracker && sub) {
        poll();
        setInterval(poll, 8000);
    }
    setInterval(tickPipe, 2000);
})();

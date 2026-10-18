(function () {
    const params = new URLSearchParams(window.location.search);
    const returnToken = params.get('return') || '';
    const token = params.get('token') || '';
    const sub = document.getElementById('sub');
    const tracker = document.getElementById('tracker');
    const isReturn = (track) => !!(track && (track.kind === 'return' || track.kind === 'replacement'));
    const kindWord = (track) => (track && track.kind === 'replacement' ? 'Replacement' : 'Return');
    let drawn = '';
    let pipePlayed = false;

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
            OUT_FOR_PICKUP: 'M5 17a2 2 0 110-4 2 2 0 010 4zM16 17a2 2 0 110-4 2 2 0 010 4zM7 15h7l2-5H10M14 10l2 5M9 8h5',
            PICKED_UP: 'M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8M12 12v8M8 17l4-4 4 4',
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

    function pipeHtml(track, subset) {
        const child = (ev) =>
            '<li class="ship-sub' + (ev.tone ? ' ' + esc(ev.tone) : '') + '"><b>' + esc(ev.message) + '</b>' +
            (ev.at ? '<div class="when">' + esc(when(ev.at)) + '</div>' : '') +
            (ev.location ? '<div class="where">' + esc(ev.location) + '</div>' : '') +
            (ev.reason ? '<div class="where">Reason: ' + esc(ev.reason) + '</div>' : '') +
            '</li>';
        return (subset || track.pipeline || [])
            .map((step, i) => {
                const kids = (step.events || []).map(child).join('');
                const courierStep = isReturn(track) ? 'PICKUP_SCHEDULED' : 'SHIPPED';
                const shippedNote = step.key === courierStep && step.state !== 'upcoming' && track.shipment && (track.shipment.courier || track.shipment.trackingId)
                    ? '<div class="ship-courier"><b>' + esc(track.shipment.courier || 'Gogate Products') + '</b><span>' +
                      esc(isReturn(track) ? kindWord(track) + ' pickup' : track.fulfillmentType === 'HYPERLOCAL' ? 'Hyperlocal' : 'Logistics') +
                      (track.shipment.trackingId ? ' · Tracking ID ' + esc(track.shipment.trackingId) : '') +
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
        if (!timing || !['on_time', 'delayed', 'early'].includes(timing.state)) return '';
        const late = timing.state === 'delayed';
        const cls = late ? 'is-late' : timing.state === 'early' ? 'is-early' : 'is-ok';
        return '<span class="trk-pill ' + cls + '">' + esc(timing.label || (late ? 'Delayed' : 'On time')) + '</span>';
    }

    function railHtml(track) {
        const steps = track.pipeline || [];
        const n = steps.length;
        const activeI = steps.findIndex((st) => st.state === 'active');
        const settledAll = activeI === n - 1 && !steps.some((st) => st.state === 'upcoming');
        let reach = steps.filter((st) => st.state === 'done').length;
        if (activeI >= 0 && !settledAll) {
            const st = steps[activeI];
            let part = 0.55;
            if (st.lineUntil && st.lineSince && Number(st.lineUntil) > Number(st.lineSince)) {
                const r = (Date.now() - Number(st.lineSince)) / (Number(st.lineUntil) - Number(st.lineSince));
                part = Math.min(0.55, Math.max(0.12, r));
            }
            reach = activeI + part;
        }
        const navPct = n > 1 ? Math.round(((settledAll ? n - 1 : Math.min(n - 1, reach)) / (n - 1)) * 100) : 0;
        return '<nav class="trk-nav' + (pipePlayed ? ' trk-nav-still' : '') + '" aria-label="Shipment progress">' +
            '<ol class="trk-rail" style="--n:' + (n || 5) + '"><div class="trk-nav-line" aria-hidden="true"><span class="trk-nav-fill" data-fixed="1" style="--nav:' + navPct + '"></span></div>' +
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
        const kind = track && track.dates ? track.dates.deliveryKind : '';
        const lbl = kind === 'courier' ? 'Delivery date \u2014 confirmed by courier' : 'Estimated delivery';
        return track && track.deliveryBy
            ? '<div class="hl-drop"><div class="lbl">' + lbl + '</div><div class="val">' + esc(track.deliveryBy) + (badge ? ' ' + badge : '') + '</div>' +
              (kind === 'courier' ? '<div class="hl-sub">Updated from the courier\u2019s latest scan</div>' : kind === 'estimate' ? '<div class="hl-sub">Seller estimate \u2014 confirmed once the courier reports a date</div>' : '') + '</div>'
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
        const reduce = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || pipePlayed;
        const root = pipe.closest('.trk, .hl') || document;
        const items = Array.from(pipe.querySelectorAll(':scope > li'));
        const playable = items.filter((el) => el.classList.contains('done') || el.classList.contains('active'));
        const stepMs = 2600;
        if (pipe && !pipe.dataset.playing) {
            pipe.dataset.playing = 'play';
            pipePlayed = true;
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
                    const ms = el.classList.contains('done') ? stepMs : Math.max(6000, Math.round(target * stepMs * 4));
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
                el.style.setProperty('--draw', '12s');
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
            if (!el || el.dataset.fixed) return;
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

    const WX_ICON = {
        sun: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="9" fill="#fbbf24"/><g stroke="#f59e0b" stroke-width="3" stroke-linecap="round" class="wx-rays"><path d="M24 4v6M24 38v6M4 24h6M38 24h6M9.9 9.9l4.2 4.2M33.9 33.9l4.2 4.2M9.9 38.1l4.2-4.2M33.9 14.1l4.2-4.2"/></g></svg>',
        'cloud-sun': '<svg viewBox="0 0 48 48"><circle cx="18" cy="18" r="8" fill="#fbbf24"/><path class="wx-cloud" d="M16 38a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/></svg>',
        cloud: '<svg viewBox="0 0 48 48"><path class="wx-cloud" d="M14 38a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/></svg>',
        fog: '<svg viewBox="0 0 48 48"><path d="M14 30a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/><g stroke="#94a3b8" stroke-width="3" stroke-linecap="round" class="wx-fog"><path d="M10 38h26M14 44h18"/></g></svg>',
        drizzle: '<svg viewBox="0 0 48 48"><path d="M14 30a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#cbd5e1" stroke="#94a3b8" stroke-width="2"/><g stroke="#38bdf8" stroke-width="3" stroke-linecap="round" class="wx-drops"><path d="M18 36v3M26 36v3M34 36v3"/></g></svg>',
        rain: '<svg viewBox="0 0 48 48"><path d="M14 28a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#94a3b8" stroke="#64748b" stroke-width="2"/><g stroke="#0ea5e9" stroke-width="3" stroke-linecap="round" class="wx-drops"><path d="M16 34l-2 8M26 34l-2 8M36 34l-2 8"/></g></svg>',
        storm: '<svg viewBox="0 0 48 48"><path d="M14 28a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#64748b" stroke="#475569" stroke-width="2"/><path class="wx-bolt" d="M26 30l-6 9h5l-2 7 7-10h-5z" fill="#facc15"/></svg>',
        snow: '<svg viewBox="0 0 48 48"><path d="M14 28a8 8 0 010-16 11 11 0 0121-3 7 7 0 011 19z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/><g fill="#7dd3fc" class="wx-drops"><circle cx="16" cy="37" r="2"/><circle cx="26" cy="40" r="2"/><circle cx="36" cy="37" r="2"/></g></svg>'
    };

    function wxIcon(key) {
        return '<span class="wx-ico wx-' + esc(key || 'sun') + '">' + (WX_ICON[key] || WX_ICON.sun) + '</span>';
    }

    function weatherTile(w, role) {
        if (!w) return '';
        const day = (w.days || [])[0];
        return '<article class="wx-tile wx-tile-' + role + (w.isDay ? '' : ' is-night') + '">' + wxIcon(w.icon) +
            '<div class="wx-copy"><div class="lbl">' + esc(role === 'from' ? 'Origin' : 'Destination') + ' · ' + esc(w.place || '') + '</div>' +
            '<div class="wx-temp">' + esc(String(w.temp)) + '°C</div><div class="wx-lbl">' + esc(w.label) +
            (day ? ' · ' + esc(String(day.min)) + '° / ' + esc(String(day.max)) + '°' : '') + '</div>' +
            '<div class="wx-meta">Humidity ' + esc(String(w.humidity)) + '% · Wind ' + esc(String(w.wind)) + ' km/h' + (day && day.rain != null ? ' · Rain ' + esc(String(day.rain)) + '%' : '') + '</div></div></article>';
    }

    function weatherHtml(journey) {
        const wx = journey && journey.weather;
        if (!wx || (!wx.from && !wx.to)) return '';
        const week = wx.to && wx.to.days ? '<div class="wx-week">' + wx.to.days.slice(0, 5).map((d) =>
            '<span class="wx-day">' + wxIcon(d.icon) + '<b>' + esc(new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })) + '</b><i>' + esc(String(d.max)) + '°</i></span>').join('') + '</div>' : '';
        return '<section class="wx"><h2>Weather on the route</h2><div class="wx-grid">' + weatherTile(wx.from, 'from') + weatherTile(wx.to, 'to') + '</div>' +
            week + (wx.impact ? '<p class="wx-impact">' + esc(wx.impact) + '</p>' : '') + '</section>';
    }

    function isFinished(track) {
        return !!(track && (track.mainStatus === 'DELIVERED' || track.mainStatus === 'RECEIVED'));
    }

    function journeyHtml(journey, track) {
        if (!journey || !journey.from || !journey.to || isFinished(track) || isReturn(track)) return '';
        const stops = [{ code: journey.from.code, city: journey.from.city, sub: journey.from.kind, done: true }]
            .concat((journey.hubs || []).map((h) => ({ code: h.code, city: h.name, sub: 'Hub' + (h.id ? ' #' + h.id : ''), done: h.done, at: h.at })))
            .concat([{ code: journey.to.code, city: journey.to.city, sub: journey.to.kind, done: track.mainStatus === 'DELIVERED' || track.mainStatus === 'RECEIVED' }]);
        const doneStops = stops.filter((s) => s.done).length;
        const steps = Array.isArray(track.pipeline) ? track.pipeline : [];
        const doneSteps = steps.filter((st) => st.state === 'done').length;
        const activeIdx = steps.findIndex((st) => st.state === 'active');
        const tlFrac = steps.length > 1 ? Math.min(1, (doneSteps + (activeIdx >= 0 ? 0.5 : 0)) / (steps.length - 1)) : 0;
        const legs = Math.max(1, stops.length - 1);
        const legStart = Math.max(0, doneStops - 1) / legs;
        const legEnd = Math.min(1, Math.max(0, doneStops) / legs);
        let frac = track.mainStatus === 'DELIVERED' ? 1 : Math.max(legStart + 0.04, Math.min(legEnd - 0.03, tlFrac));
        if (track.mainStatus === 'OUT_FOR_DELIVERY') frac = Math.max(frac, 1 - 0.12);
        const pct = Math.round(Math.max(0, Math.min(100, frac * 100)));
        const activeLeg = Math.min(legs - 1, Math.max(0, doneStops - 1));
        const legPct = Math.round(Math.max(0, Math.min(100, (frac - activeLeg / legs) * legs * 100)));
        const nextStep = steps[activeIdx] || null;
        const upcoming = steps.find((st) => st.state === 'upcoming') || null;
        const etaChip = nextStep ? '<span class="jr-eta"><b>' + esc(nextStep.title) + '</b>' + (nextStep.expectedLabel ? ' · ' + esc(nextStep.expectedLabel) : '') + '</span>' : '';
        const nextChip = upcoming ? '<span class="jr-next">Next: ' + esc(upcoming.title) + (upcoming.expectedLabel ? ' · ' + esc(upcoming.expectedLabel) : '') + '</span>' : '';
        const serviceChip = journey.service ? '<span class="jr-chip jr-svc">' + esc(journey.service) + '</span>' : '';
        const shareBtn = '<button type="button" class="jr-share" data-share><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg> Share</button>';
        const truck = '<span class="jr-truck" style="--pos:' + pct + '%" aria-hidden="true"><svg viewBox="0 0 64 40"><rect x="2" y="10" width="36" height="20" rx="3" fill="#0f766e"/><path d="M38 16h12l8 8v6H38z" fill="#14b8a6"/><rect x="42" y="18" width="7" height="6" fill="#ccfbf1"/><circle cx="14" cy="32" r="5" fill="#111" class="jr-wheel"/><circle cx="50" cy="32" r="5" fill="#111" class="jr-wheel"/><circle cx="14" cy="32" r="2" fill="#94a3b8"/><circle cx="50" cy="32" r="2" fill="#94a3b8"/></svg></span>';
        return '<section class="jr"><div class="jr-head"><h2>Route</h2>' +
            (journey.distanceKm ? '<span class="jr-km">' + esc(String(journey.distanceKm)) + ' km</span>' : '') +
            (journey.parcel ? '<span class="jr-parcel">Parcel ' + esc(journey.parcel.code || '#' + journey.parcel.id) + '</span>' : '') + '</div>' +
            '<div class="jr-board">' + stops.map((s, i) =>
                '<div class="jr-stop' + (s.done ? ' is-done' : '') + '"><b class="jr-code">' + esc(s.code || '—') + '</b><span class="jr-city">' + esc(s.city || '') + '</span><span class="jr-sub">' + esc(s.sub) + (s.at ? ' · ' + esc(when(s.at)) : '') + '</span></div>' +
                (i < stops.length - 1 ? '<div class="jr-leg' + (stops[i + 1].done ? ' is-done' : i === activeLeg && track.mainStatus !== 'DELIVERED' ? ' is-active' : '') + '" style="--leg:' + (stops[i + 1].done ? 100 : i === activeLeg ? legPct : 0) + '%"><i></i></div>' : '')).join('') + '</div>' +
            '<div class="jr-road"><div class="jr-fill" style="--pct:' + pct + '%"></div>' + truck + '</div>' +
            '<div class="jr-meta"><span class="jr-pct">' + pct + '% of route</span>' + etaChip + nextChip + serviceChip + shareBtn + '</div></section>';
    }

    function hlNowHtml(track) {
        const h = track && track.hyperlocal;
        if (!h) return '';
        const live = h.live || {};
        const r = h.rider || {};
        let now = '';
        if (track.mainStatus === 'DELIVERED' && h.proof) {
            now = '<div class="hl-now is-done"><b>Delivered' + (h.proof.deliveredAt ? ' · ' + esc(when(h.proof.deliveredAt)) : '') + '</b><span>' +
                (h.proof.otpVerified ? 'OTP verified at handover' : 'Handed over to recipient') + (h.proof.recipient ? ' · ' + esc(h.proof.recipient) : '') + '</span></div>';
        } else if (live.active && live.gps) {
            now = '<div class="hl-now' + (live.nearby ? ' is-near' : '') + '"><b>' +
                (live.nearby ? 'Your delivery partner is nearby — please be available' : live.approaching ? 'Delivery partner approaching' : 'Arriving in about ' + esc(live.etaMinutes) + ' min') + '</b><span>' +
                (live.distanceKm != null ? esc(live.distanceKm) + ' km away · ' : '') + 'GPS updated ' + esc(ago(live.lastGpsAt)) + '</span></div>';
        } else if (live.active && live.gpsLost) {
            now = '<div class="hl-now is-warn"><b>Waiting for the partner\u2019s location</b><span>Last location received ' + esc(ago(live.lastGpsAt)) + ' · showing latest milestone</span></div>';
        } else if (live.active) {
            now = '<div class="hl-now"><b>Order is on its way</b><span>Live location will appear once the partner\u2019s app shares it</span></div>';
        } else if (r.status === 'at_store') {
            now = '<div class="hl-now"><b>Partner is at the store</b><span>' + (r.waitingMinutes != null ? 'Waiting ' + esc(r.waitingMinutes) + ' min · ' : '') + 'pickup verified by OTP before handover</span></div>';
        } else if (r.status === 'assigned') {
            now = '<div class="hl-now"><b>Delivery partner assigned</b><span>Heading to the store' + (r.assignedAt ? ' · assigned ' + esc(ago(r.assignedAt)) : '') + '</span></div>';
        } else if (r.status === 'searching') {
            now = '<div class="hl-now"><b>Finding a delivery partner</b><span>Your order is packed and waiting at the store</span></div>';
        } else if (track.mainStatus === 'ORDERED') {
            now = '<div class="hl-now"><b>Store is preparing your order</b><span>No delivery partner needed yet</span></div>';
        }
        const prep = (h.prep || []).map((st) => '<li class="' + (st.done ? 'is-done' : '') + (st.key === 'substitution' ? ' is-warn' : '') + '"><i></i><span>' + esc(st.title) + '</span>' + (st.at ? '<time>' + esc(when(st.at)) + '</time>' : '') + '</li>').join('');
        const riderRows = [];
        if (r.name) riderRows.push(['Partner', r.name + (r.vehicle ? ' · ' + r.vehicle : '')]);
        if (r.assignedAt) riderRows.push(['Assigned', when(r.assignedAt) + (r.reassignments ? ' · reassigned ' + r.reassignments + '×' : '')]);
        if (r.arrivedAt) riderRows.push(['Reached store', when(r.arrivedAt)]);
        if (r.pickupVerifiedAt) riderRows.push(['Pickup verified', when(r.pickupVerifiedAt)]);
        if (r.departedAt) riderRows.push(['Left store', when(r.departedAt) + ' · ' + r.packages + ' package' + (r.packages > 1 ? 's' : '')]);
        if (r.waitingMinutes != null && r.departedAt) riderRows.push(['Wait at pickup', r.waitingMinutes + ' min']);
        const riderHtml = riderRows.length ? '<dl class="hl-kv">' + riderRows.map((kv) => '<div><dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd></div>').join('') + '</dl>' : '';
        return '<section class="hl-ops">' + now +
            (h.attention ? '<div class="hl-flag"><b>Action needed</b><span>' + esc(h.attention.text) + '</span></div>' : '') +
            (h.delay ? '<div class="hl-flag is-delay"><b>' + (h.delay.kind === 'store' ? 'Store delay' : 'Partner delay') + '</b><span>' + esc(h.delay.text) + '</span></div>' : '') +
            '<details class="hl-acc"' + (track.mainStatus === 'ORDERED' || track.mainStatus === 'PACKED' ? ' open' : '') + '><summary>Order preparation</summary><ul class="hl-prep">' + prep + '</ul></details>' +
            (riderHtml ? '<details class="hl-acc" open><summary>Delivery partner</summary>' + riderHtml + '</details>' : '') +
            (h.cancellation ? '<p class="hl-policy">' + esc(h.cancellation.text) + '</p>' : '') +
            '</section>';
    }


    const HEALTH_LABEL = { on_track: 'On track', update_expected: 'Update expected', delayed: 'Delayed', stalled: 'No recent movement', exception: 'Needs attention', delivered: 'Delivered' };
    function healthHtml(track) {
        const h = track && track.health;
        if (!h) return '';
        const f = h.freshness || {};
        const p = h.promise || {};
        return (
            '<section class="trk-health is-' + esc(h.state) + '"><div class="trk-health-head"><span class="trk-health-pill">' + esc(HEALTH_LABEL[h.state] || h.state) + '</span><b>Is my parcel on track?</b></div>' +
            '<p>' + esc(h.answer) + '</p><div class="trk-health-grid">' +
            (f.lastCourierAt || f.lastAnyAt ? '<div><span>' + esc(f.label) + '</span><b>' + esc(ago(f.lastCourierAt || f.lastAnyAt)) + '</b><small>' + esc(when(f.lastCourierAt || f.lastAnyAt)) + '</small></div>' : '') +
            (h.state !== 'delivered' ? '<div><span>ETA confidence</span><b class="conf-' + esc(h.etaConfidence) + '">' + esc(h.etaConfidence === 'high' ? 'Reliable (courier-confirmed)' : h.etaConfidence === 'medium' ? 'Moderate (seller estimate)' : 'Uncertain') + '</b></div>' : '') +
            (h.next ? '<div><span>Next milestone <i>prediction</i></span><b>' + esc(h.next.label) + '</b>' + (h.next.at ? '<small>around ' + esc(when(h.next.at)) + '</small>' : '') + '</div>' : '') +
            '</div>' +
            (p.history && p.history.length > 1 ? '<details class="trk-promise"><summary>Delivery promise history</summary><ul>' + p.history.map((x) => '<li><b>' + esc(x.label) + '</b> ' + esc(when(x.at)) + (x.reason ? ' <span>— ' + esc(x.reason) + '</span>' : '') + '</li>').join('') + '</ul></details>' : '') +
            (h.anomalies && h.anomalies.length ? '<ul class="trk-anomalies">' + h.anomalies.map((a) => '<li class="an-' + esc(a.kind) + '">' + esc(a.text) + '</li>').join('') + '</ul>' : '') +
            '</section>'
        );
    }
    function packageHtml(track, shipment) {
        const pk = track && track.package;
        if (!pk) return '';
        const items = (shipment && shipment.items) || [];
        const row = (k, v) => (v ? '<div><span>' + k + '</span><b>' + esc(v) + '</b></div>' : '');
        return (
            '<details class="trk-pack"><summary>Package details · ' + pk.count + (pk.count > 1 ? ' packages' : ' package') + '</summary><div class="trk-pack-grid">' +
            pk.packages.map((x) => row('Package ' + x.index + (pk.count > 1 ? ' tracking ID' : ' tracking ID'), x.trackingId || 'Assigned at pickup')).join('') +
            row('Courier', pk.courier) + row('Service level', pk.service) + row('Type', pk.type) + row('Weight', pk.weightKg ? pk.weightKg + ' kg' : '') + row('Dimensions', pk.dimensions) +
            row('Dispatched from', pk.from) + row('Destination area', pk.toArea) + row('Packed', pk.packedAt ? when(pk.packedAt) : '') + row('Dispatched', pk.dispatchedAt ? when(pk.dispatchedAt) : '') +
            '</div>' + (items.length ? '<div class="trk-pack-items"><span>Contents</span>' + items.map((it) => '<em>' + esc(it.title || it.name || '') + (it.qty || it.quantity ? ' × ' + (it.qty || it.quantity) : '') + '</em>').join('') + '</div>' : pk.contents ? '<div class="trk-pack-items"><span>Contents</span><em>' + esc(pk.contents) + '</em></div>' : '') +
            '</details>'
        );
    }
    function securityHtml(track) {
        const sc = track && track.security;
        if (!sc) return '';
        return (
            '<section class="trk-secure"><div><span class="trk-shield' + (sc.awbVerified ? ' ok' : '') + '"></span><b>' + (sc.awbVerified ? 'Verified shipment' : 'Awaiting courier reference') + '</b>' +
            (sc.reference ? '<small>' + esc(sc.courier || 'Courier') + ' · ref ' + esc(sc.reference) + ' matches this order</small>' : '<small>The courier reference will appear here once the parcel is accepted.</small>') + '</div>' +
            '<p>' + esc(sc.otpNotice) + '</p></section>'
        );
    }
    function appointmentHtml(track) {
        if (!track || isFinished(track) || track.mainStatus === 'DELIVERED') return '';
        const ap = track.appointment || {};
        const cur = ap.current;
        if (!ap.eligible && !cur) return '';
        const hist = (ap.history || []).slice().reverse();
        const badge = (st) => '<span class="apt-st apt-' + esc(st) + '">' + esc(st === 'pending' ? 'Pending confirmation' : st === 'accepted' ? 'Accepted' : st === 'carrier_confirmed' ? 'Confirmed by courier' : 'Not available') + '</span>';
        let body = '';
        if (cur && cur.status === 'pending') {
            body = '<div class="apt-cur"><b>' + esc(cur.date) + ' · ' + esc(cur.start) + '–' + esc(cur.end) + '</b>' + badge('pending') + '<small>We will confirm with the courier and notify you. Nothing to do now.</small></div>';
        } else {
            if (cur) body += '<div class="apt-cur"><b>' + esc(cur.date) + ' · ' + esc(cur.start) + '–' + esc(cur.end) + '</b>' + badge(cur.status) + (cur.note ? '<small>' + esc(cur.note) + '</small>' : '') + '</div>';
            const slots = (ap.slots && ap.slots.length ? ap.slots : track.slots || []);
            body += (ap.courierPush ? '<small class="hl-sub">Slots are booked directly with the courier.</small>' : '<small class="hl-sub">The store confirms the slot with the courier.</small>') + '<form id="trk-apt-form" class="trk-issue-form"><input name="date" type="date" required min="' + new Date().toISOString().slice(0, 10) + '">' +
                (slots.length ? '<select name="win">' + slots.map((s) => '<option value="' + esc(s.start) + '|' + esc(s.end) + '">' + esc(s.label || s.start + '–' + s.end) + '</option>').join('') + '</select>' : '<select name="win"><option value="10:00|13:00">10:00 – 13:00</option><option value="13:00|16:00">13:00 – 16:00</option><option value="16:00|20:00">16:00 – 20:00</option></select>') +
                '<input name="recipient" maxlength="80" placeholder="Authorised recipient (optional)"><input name="instructions" maxlength="240" placeholder="Gate / building / access instructions">' +
                '<div class="trk-issue-actions"><button type="submit">' + (cur ? 'Request another window' : 'Request appointment') + '</button><span id="trk-apt-msg"></span></div></form>';
        }
        return '<details class="trk-issue trk-apt"' + (cur ? ' open' : '') + '><summary>Delivery appointment' + (cur ? ' · ' + (cur.status === 'pending' ? 'pending' : cur.status === 'rejected' ? 'not available' : 'confirmed') : '') + '</summary>' + body +
            (hist.length > 1 ? '<details class="trk-promise"><summary>Appointment history</summary><ul>' + hist.map((a) => '<li><b>' + esc(a.date) + ' ' + esc(a.start) + '–' + esc(a.end) + '</b> ' + badge(a.status) + ' <span>requested ' + esc(when(a.requestedAt)) + '</span></li>').join('') + '</ul></details>' : '') +
            '</details>';
    }
    function notifyHtml(track) {
        if (!track || isFinished(track)) return '';
        const mute = !!(track.notifyPrefs && track.notifyPrefs.muteRoutine);
        return '<label class="trk-notify"><input type="checkbox" id="trk-mute"' + (mute ? ' checked' : '') + '> <span><b>Mute routine transit updates</b><small>You will still get alerts when the date changes, action is needed, a reattempt is confirmed, delivery is done, or a refund/replacement moves.</small></span></label>';
    }
    async function postJson(url, payload) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save.');
        return data;
    }
    function bindExtras() {
        const apt = document.getElementById('trk-apt-form');
        if (apt && !apt.dataset.bound) {
            apt.dataset.bound = '1';
            apt.addEventListener('submit', async (event) => {
                event.preventDefault();
                const fd = new FormData(apt);
                const win = String(fd.get('win') || '').split('|');
                const msg = document.getElementById('trk-apt-msg');
                try {
                    await postJson('/api/public/commerce/appointment', { token, date: fd.get('date'), start: win[0], end: win[1], recipient: fd.get('recipient'), instructions: fd.get('instructions') });
                    drawn = '';
                    poll();
                } catch (e) { if (msg) msg.textContent = e.message; }
            });
        }
        const mute = document.getElementById('trk-mute');
        if (mute && !mute.dataset.bound) {
            mute.dataset.bound = '1';
            mute.addEventListener('change', () => postJson('/api/public/commerce/notify-prefs', { token, muteRoutine: mute.checked }).catch(() => {}));
        }
    }
    function extrasHtml(track, shipment) {
        if (isReturn(track)) return latestHtml(track);
        return healthHtml(track) + latestHtml(track) + issueHtml(track) + appointmentHtml(track) + packageHtml(track, shipment) + securityHtml(track) + notifyHtml(track);
    }
    function latestHtml(track) {
        const u = track && track.latestUpdate;
        if (!u) return '';
        return '<div class="trk-latest"><span class="trk-latest-dot' + (u.verified ? ' is-verified' : '') + '"></span><div><b>' + esc(u.message) + '</b><span>' +
            (u.verified ? 'Verified courier update' : 'Store update') + ' \u00b7 ' + esc(when(u.at)) + ' \u00b7 ' + esc(ago(u.at)) + '</span></div></div>';
    }

    function issueHtml(track) {
        if (!track) return '';
        const finished = isFinished(track);
        const failed = track.operationalStatus === 'DELIVERY_ATTEMPT_FAILED' || (track.timing && track.timing.state === 'failed');
        if (!finished && !failed) return '';
        if (track.issue) {
            return '<section class="trk-issue is-open"><b>Problem reported' + (track.issue.reference ? ' \u00b7 ' + esc(track.issue.reference) : '') + '</b><span>' +
                esc(track.issue.title) + (track.issue.detail ? ' \u2014 ' + esc(track.issue.detail) : '') + '</span><span class="trk-issue-state">' +
                (track.issue.status === 'resolved' ? 'Resolved' : 'Under review \u2014 keep this reference for support') + '</span></section>';
        }
        return '<details class="trk-issue"><summary>' + (finished ? 'Not received or something wrong with the order? Report a problem' : 'Report a delivery problem') + '</summary>' +
            '<form id="trk-issue-form" class="trk-issue-form">' +
            '<select name="type"><option value="non_receipt">Marked delivered but not received</option><option value="damaged">Damaged item</option><option value="incomplete">Missing items</option><option value="wrong_item">Wrong item</option><option value="other">Other</option></select>' +
            '<input name="items" maxlength="160" placeholder="Affected item(s)"><input name="quantity" type="number" min="1" placeholder="Qty">' +
            '<textarea name="description" maxlength="400" placeholder="What happened? Photos can be sent to support with your case reference."></textarea>' +
            '<div class="trk-issue-actions"><button type="submit">Submit</button><span id="trk-issue-msg"></span></div></form></details>';
    }

    function bindIssue() {
        const form = document.getElementById('trk-issue-form');
        if (!form || form.dataset.bound) return;
        form.dataset.bound = '1';
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const msg = document.getElementById('trk-issue-msg');
            const fd = new FormData(form);
            try {
                const res = await fetch('/api/public/commerce/issue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, type: fd.get('type'), items: fd.get('items'), quantity: fd.get('quantity'), description: fd.get('description') })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not submit.');
                form.innerHTML = '<p class="trk-issue-done">Reported. Your case reference is <b>' + esc(data.reference) + '</b> \u2014 quote it to support.</p>';
                drawn = '';
                setTimeout(() => poll(), 1200);
            } catch (e) {
                if (msg) msg.textContent = e.message;
            }
        });
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
            '<header class="trk-bar"><div class="trk-brand"><span class="trk-mark">' + iconSvg('M3 8l9-4 9 4-9 4-9-4zM3 8v8l9 4 9-4V8') + '</span><div><div class="trk-brand-name">Gogate Products</div><div class="trk-brand-sub">' + (ret ? kindWord(track) + ' tracking' : 'Shipment tracking <small class="trk-ver">v2</small>') + '</div></div></div>' +
            '<div class="trk-actions">' +
            (code ? '<button type="button" class="trk-copy" data-copy="' + esc(code) + '">Copy order</button>' : '') +
            '<button type="button" class="trk-copy" data-copy-href="1">Copy link</button><button type="button" class="trk-copy trk-refresh">Refresh</button>' +
            '</div></header>' +
            '<section class="trk-hero"><div class="trk-ring" style="--fill:0"><span class="trk-ring-ico">' + stepIcon(active.key) + '</span></div><div class="trk-hero-copy"><div class="trk-kicker">' + (ret ? kindWord(track) + ' for order #' : 'Order #') + esc(code) + (badge ? ' ' + badge : '') + '</div><h1>' + esc(track.currentStatus || track.currentMessage) + '</h1>' +
            (detail ? '<p>' + esc(detail) + '</p>' : '') +
            '<p class="trk-stepno">' + (delivered ? 'Completed' : 'Step ' + stepNo + ' of ' + (steps.length || 5)) + '</p>' +
            '</div>' + board + '</section>' +
            railHtml(track) +
            hlNowHtml(track) +
            journeyHtml(shipment.journey, track) +
            (isFinished(track) ? '' : weatherHtml(shipment.journey)) +
            extrasHtml(track, shipment) +
            '<div class="trk-facts">' +
            factCard('Courier', courier) +
            factCard('Service', mode) +
            (trackingId ? factCard('Tracking ID', trackingId, '<button type="button" class="trk-copy trk-copy-mini" data-copy="' + esc(trackingId) + '">Copy</button>') : '') +
            attemptCard(track) +
            (ret && track.agent && (track.agent.name || track.agent.phone) ? factCard('Pickup agent', [track.agent.name, track.agent.phone].filter(Boolean).join(' · ')) : '') +
            (ret && track.pickupWindow && !isFinished(track) ? factCard('Pickup slot', when(track.pickupWindow)) : '') +
            (ret && typeof track.progressPct === 'number' ? factCard('Progress', track.progressPct + '% complete') : '') +
            '</div>' +
            (expects ? '<div class="trk-whens">' + expects + '</div>' : '') +
            failureHtml(track) +
            otpHtml('Pickup OTP', track.pickupOtp) + otpHtml('Delivery OTP', track.deliveryOtp) +
            '<section class="trk-progress"><h2>' + (ret ? kindWord(track) + ' progress' : 'Order progress') + '</h2><p class="trk-line-note">' + esc(lineNote(track)) + '</p>' + '<ol class="ship-pipe">' + pipeHtml(track) + '</ol>' + '</section>' +
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
        const liveSrc = track.map && track.map.enabled ? shipment.live : null;
        const cv = liveSrc && liveSrc.courierView;
        const ownMap = !cv && !!(liveSrc && liveSrc.mapsApiKey);
        const courierFrame = cv
            ? '<div class="hl-courier-frame"><iframe src="' + esc(cv.url) + '" title="Live courier tracking map" loading="lazy" referrerpolicy="no-referrer" allow="geolocation"></iframe></div>'
            : '';
        const map = liveSrc
            ? '<div class="hl-map">' + (ownMap ? '<div id="tl-map-slot"></div>' : '') + courierFrame + '<div class="hl-legend">' + livePill +
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
            hlNowHtml(track) +
            railHtml(track) +
            board +
            journeyHtml(shipment.journey, track) +
            (isFinished(track) ? '' : weatherHtml(shipment.journey)) +
            extrasHtml(track, shipment) +
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
        const sig = JSON.stringify(steady) + '|' + JSON.stringify(shipment.linked || null) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.courierView ? live.courierView.url : '') + '|' + JSON.stringify(shipment.journey || null) + '|' + (live && live.leg ? live.leg : '') + '|' + (live && live.route ? live.route : '');
        if (!(editing && !editing.hidden) && sig !== drawn) {
            drawn = sig;
            tracker.innerHTML = (liveSheet ? sheetHtml(track, shipment) : documentHtml(track, shipment)) + linkedHtml(shipment);
            bindViewTabs();
            bindCopy();
            bindShare();
            bindMore();
        }
        bindReschedule();
        bindNote();
        bindIssue();
        bindExtras();
        touchFresh();
        tickPipe();
        if (live && !live.courierView && window.TrackTimeline) TrackTimeline.mount(live);
    }

    function bindViewTabs() {
        tracker.querySelectorAll('[data-hl-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const which = btn.getAttribute('data-hl-view');
                tracker.querySelectorAll('[data-hl-view]').forEach((b) => b.classList.toggle('is-on', b === btn));
                const slot = document.getElementById('tl-map-slot');
                const frame = tracker.querySelector('.hl-courier-frame');
                if (slot) slot.classList.toggle('is-hidden', which !== 'own');
                if (frame) frame.classList.toggle('is-hidden', which !== 'courier');
                if (which === 'own' && slot && slot.__map && window.google && google.maps.event) google.maps.event.trigger(slot.__map, 'resize');
            });
        });
    }

    function linkedHtml(shipment) {
        const linked = (shipment && shipment.linked) || {};
        let html = '';
        if (linked.replacementTrack && linked.replacementTrack.pipeline) {
            html += '<h3 style="margin:22px 0 8px;">Replacement order ' + (linked.replacementOrderCode || '') + ' — shipment</h3>' + documentHtml(linked.replacementTrack, {});
        }
        if (linked.originReturnTrack && linked.originReturnTrack.pipeline) {
            html += '<h3 style="margin:22px 0 8px;">Return / replacement request on order ' + (linked.originOrderCode || '') + '</h3>' + documentHtml(linked.originReturnTrack, {});
        }
        return html;
    }

    function bindShare(root) {
        (root || tracker).querySelectorAll('[data-share]').forEach((b) => {
            b.addEventListener('click', () => {
                const data = { title: document.title, text: 'Track my shipment', url: location.href };
                if (navigator.share) navigator.share(data).catch(() => {});
                else if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(() => { b.textContent = 'Link copied'; setTimeout(() => (b.textContent = 'Share'), 1800); });
            });
        });
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
            const sig = JSON.stringify(Object.assign({}, track, { pipeline: (track && track.pipeline || []).map((step) => Object.assign({}, step, { lineGrow: undefined })) }));
            if (container.dataset.sig === sig) return;
            container.dataset.sig = sig;
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
        document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.trk-refresh')) { pipePlayed = false; poll(); } });
    }
    setInterval(tickPipe, 2000);
})();

/**
 * Public branded shipment tracker — /track-shipment
 */
(function () {
    let pollTimer = null;

    function showErr(msg) {
        const el = document.getElementById('track-shipment-err');
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.classList.add('hidden');
        }
    }

    function qs(name) {
        return new URLSearchParams(window.location.search).get(name) || '';
    }

    let lastCommerceSig = '';
    let lastPayload = null;

    function fmtWhen(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function summaryHtml(o) {
        const t = o.commerceTimeline;
        const steps = (t && t.steps) || [];
        const active = steps.find(function (s) { return s.state === 'active'; });
        const doneCount = steps.filter(function (s) { return s.state === 'done'; }).length;
        const pct = steps.length ? Math.round(((doneCount + (active ? Math.min(0.88, (Number(active.lineFill) || 12) / 100) : 0)) / steps.length) * 100) : 0;
        const headline = (t && t.headline) || o.courierTrackLabel || 'Tracking';
        const tone = t && t.cancelled ? 'cancelled' : t && t.rank >= 5 ? 'delivered' : '';
        const latest = steps.slice().reverse().map(function (s) { return (s.updates || [])[0]; }).filter(Boolean)[0];
        const partner = t && t.partner;
        const otpStep = steps.find(function (s) { return s.deliveryOtp; });
        return (
            '<div class="ts-hero ' + tone + '">' +
            '<div class="ts-hero-top"><span class="ts-chip">Order #' + esc(o.orderCode) + '</span>' +
            '<button type="button" class="ts-refresh" id="ts-refresh"><i class="fas fa-rotate"></i> Refresh</button></div>' +
            '<h2>' + esc(headline) + '</h2>' +
            (active && active.summary ? '<p>' + esc(active.summary) + '</p>' : '') +
            '<div class="ts-ring" style="--p:' + (t && t.rank >= 5 ? 100 : pct) + '"><b>' + (t && t.rank >= 5 ? 100 : pct) + '%</b><span>complete</span></div>' +
            '</div>' +
            '<div class="ts-tiles">' +
            '<div class="ts-tile"><i class="fas fa-location-dot"></i><div><small>Where it is</small><b>' + esc(latest ? (latest.city || latest.title) : headline) + '</b></div></div>' +
            '<div class="ts-tile"><i class="fas fa-calendar-check"></i><div><small>' + (t && t.rank >= 5 ? 'Delivered' : 'Delivery by') + '</small><b>' + esc((t && t.deliveryBy) || (t && t.expected && t.expected.deliveryText) || '—') + '</b></div></div>' +
            '<div class="ts-tile"><i class="fas fa-truck"></i><div><small>Courier</small><b>' + esc(partner ? partner.name : (o.courierProviderLabel || o.courierProvider || '—')) + '</b>' + (partner && partner.trackingNo ? '<em>' + esc(partner.trackingNo) + '</em>' : o.courierTrackingNo ? '<em>' + esc(o.courierTrackingNo) + '</em>' : '') + '</div></div>' +
            '<div class="ts-tile"><i class="fas fa-clock-rotate-left"></i><div><small>Last update</small><b>' + esc(latest && latest.at ? fmtWhen(latest.at) : o.updatedAt ? fmtWhen(o.updatedAt) : '—') + '</b></div></div>' +
            (otpStep ? '<div class="ts-tile ts-otp"><i class="fas fa-key"></i><div><small>Delivery OTP</small><b>' + esc(otpStep.deliveryOtp) + '</b><em>Share only with the delivery partner at your door</em></div></div>' : '') +
            '</div>'
        );
    }

    function renderResult(data) {
        const root = document.getElementById('track-shipment-result');
        const poll = document.getElementById('track-shipment-poll');
        if (!root || !data || !data.order) return;
        const o = data.order;
        root.classList.remove('hidden');
        if (o.commerceTimeline && window.TrackTimeline) {
            const live = o.commerceLive || null;
            const sig = JSON.stringify(o.commerceTimeline) + '|' + (live && live.slot ? live.slot : '') + '|' + (live && live.leg ? live.leg : '');
            if (sig !== lastCommerceSig) {
                lastCommerceSig = sig;
                root.innerHTML = summaryHtml(o) + window.TrackTimeline.render({ timeline: o.commerceTimeline, live: live }, { animate: true });
            }
            window.TrackTimeline.mount(live);
            if (window.TrackTimeline.tick) window.TrackTimeline.tick();
        } else if (window.BookTrackingUI) {
            lastCommerceSig = '';
            root.innerHTML = window.BookTrackingUI.renderPackageTracker(o.deliveryJourney, o.courierTrackEvents || [], {
                destination: o.destination
            });
            if (window.BookTrackingUI.animateProgressFill) {
                window.BookTrackingUI.animateProgressFill(root);
            }
        }
        const live =
            o.deliveryJourney &&
            o.deliveryJourney.isLive &&
            !o.isCancelled &&
            !o.shipmentCancelled;
        if (poll) {
            poll.classList.toggle('hidden', !live);
            poll.innerHTML = 'Updated ' + esc(fmtWhen(new Date().toISOString())) + ' · updates when you refresh';
        }
    }

    async function trackOrder(payload, silent) {
        if (!silent) showErr('');
        const res = await fetch('/api/public/book-orders/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not track shipment');
        lastPayload = payload;
        renderResult(data);
        return data;
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    document.addEventListener('click', function (e) {
        const btn = e.target.closest && e.target.closest('#ts-refresh');
        if (!btn || !lastPayload) return;
        btn.disabled = true;
        lastCommerceSig = '';
        trackOrder(lastPayload, true).catch(function (err) { showErr(err.message || 'Refresh failed'); }).then(function () { btn.disabled = false; });
    });

    function readForm() {
        return {
            orderCode: (document.getElementById('ts-order-code') || {}).value.trim(),
            awb: (document.getElementById('ts-awb') || {}).value.trim() || undefined,
            phoneLast4:
                String((document.getElementById('ts-phone') || {}).value || '')
                    .replace(/\D/g, '')
                    .slice(-4) || undefined
        };
    }

    document.getElementById('track-shipment-form').addEventListener('submit', function (e) {
        e.preventDefault();
        const p = readForm();
        if (!p.awb && !p.phoneLast4) {
            return showErr('Enter AWB or last 4 digits of shipping mobile.');
        }
        trackOrder(p, false).catch(function (err) {
            showErr(err.message || 'Tracking failed');
        });
    });

    const orderFromUrl = qs('order') || qs('orderCode');
    const awbFromUrl = qs('awb') || qs('tracking');
    if (orderFromUrl) {
        const oc = document.getElementById('ts-order-code');
        if (oc) oc.value = orderFromUrl;
    }
    if (awbFromUrl) {
        const aw = document.getElementById('ts-awb');
        if (aw) aw.value = awbFromUrl;
    }
    if (orderFromUrl && (awbFromUrl || qs('phone'))) {
        trackOrder(
            {
                orderCode: orderFromUrl,
                awb: awbFromUrl || undefined,
                phoneLast4: qs('phone') || undefined
            },
            false
        ).catch(function (err) {
            showErr(err.message || 'Tracking failed');
        });
    }

    window.addEventListener('beforeunload', stopPoll);
})();

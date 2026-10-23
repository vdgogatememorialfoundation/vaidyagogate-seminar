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

    function pct(t) {
        const steps = (t && t.steps) || [];
        if (!steps.length) return 0;
        if (t.rank >= 5 || t.cancelled) return t.cancelled ? 0 : 100;
        const done = steps.filter(function (s) { return s.state === 'done'; }).length;
        const active = steps.find(function (s) { return s.state === 'active'; });
        return Math.round(((done + (active ? Math.min(0.88, (Number(active.lineFill) || 12) / 100) : 0)) / steps.length) * 100);
    }

    function stepIcon(key) {
        const m = { ordered: 'fa-receipt', packed: 'fa-box', picked_up: 'fa-hand-holding-box', shipped: 'fa-truck-fast', out_for_delivery: 'fa-motorcycle', delivered: 'fa-circle-check' };
        const fa = m[key] || 'fa-circle';
        return '<i class="fas ' + (fa === 'fa-hand-holding-box' ? 'fa-people-carry-box' : fa) + '"></i>';
    }

    function railHtml(t) {
        const steps = (t && t.steps) || [];
        if (!steps.length) return '';
        const done = steps.filter(function (s) { return s.state === 'done'; }).length;
        const activeIdx = steps.findIndex(function (s) { return s.state === 'active'; });
        const grow = activeIdx >= 0 ? Math.min(0.5, Math.max(0.1, (Number(steps[activeIdx].lineFill) || 12) / 100 * 0.5)) : 0;
        const reached = activeIdx >= 0 ? activeIdx : Math.max(0, done - 1);
        const fill = steps.length > 1 ? Math.min(100, ((reached + grow) / (steps.length - 1)) * 100) : 0;
        return (
            '<div class="ts4-rail" style="--fill:' + (t.rank >= 5 ? 100 : fill.toFixed(1)) + '">' +
            '<div class="ts4-rail-line"><span></span></div>' +
            '<ol class="ts4-rail-steps">' +
            steps.map(function (s) {
                return '<li class="' + s.state + '"><span class="ts4-rail-ico">' + stepIcon(s.key) + '</span><b>' + esc(s.title) + '</b>' + (s.state === 'active' ? '<i class="ts4-now">In progress</i>' : s.state === 'done' ? '<i class="ts4-done">Done</i>' : '') +
                    (s.at ? '<small>' + esc(fmtWhen(s.at)) + '</small>' : s.expectedLabel && s.state !== 'done' ? '<small class="exp">' + esc(s.expectedLabel) + '</small>' : '') + '</li>';
            }).join('') +
            '</ol></div>'
        );
    }

    function journeyHtml(o) {
        const t = o.commerceTimeline;
        const all = [];
        ((t && t.steps) || []).forEach(function (s) {
            (s.updates || []).forEach(function (u) { all.push({ at: u.at, title: u.title, city: u.city || '', tone: u.tone || '', step: s.title }); });
        });
        all.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
        if (!all.length) return '';
        const groups = [];
        all.forEach(function (u) {
            const last = groups[groups.length - 1];
            if (last && last.city === u.city) last.items.push(u);
            else groups.push({ city: u.city, items: [u] });
        });
        return (
            '<section class="ts4-card"><div class="ts4-card-head"><h3><i class="fas fa-route"></i> Journey so far</h3><span>' + all.length + ' updates</span></div>' +
            '<div class="ts4-journey">' +
            groups.map(function (g, gi) {
                return '<div class="ts4-jcity' + (gi === 0 ? ' now' : '') + '"><div class="ts4-jcity-h"><i class="fas fa-location-dot"></i> ' + esc(g.city || 'Courier network') + '</div><ul>' +
                    g.items.map(function (u) {
                        return '<li class="' + esc(u.tone) + '"><b>' + esc(u.title) + '</b><span>' + esc(fmtWhen(u.at)) + ' · ' + esc(u.step) + '</span></li>';
                    }).join('') + '</ul></div>';
            }).join('') +
            '</div></section>'
        );
    }

    function summaryHtml(o) {
        const t = o.commerceTimeline || {};
        const steps = t.steps || [];
        const active = steps.find(function (s) { return s.state === 'active'; });
        const p = pct(t);
        const headline = t.headline || o.courierTrackLabel || 'Tracking';
        const tone = t.cancelled ? 'cancelled' : t.rank >= 5 ? 'delivered' : '';
        const latest = steps.slice().reverse().map(function (s) { return (s.updates || [])[0]; }).filter(Boolean)[0];
        const partner = t.partner;
        const otpStep = steps.find(function (s) { return s.deliveryOtp; });
        const pickupStep = steps.find(function (s) { return s.pickup && s.pickup.pickupOtp; });
        const cs = t.courierStatus;
        const st = t.stats || {};
        const tile = function (ico, lbl, val, sub) {
            return val ? '<div class="ts4-tile"><i class="fas ' + ico + '"></i><div><small>' + lbl + '</small><b>' + esc(val) + '</b>' + (sub ? '<em>' + esc(sub) + '</em>' : '') + '</div></div>' : '';
        };
        return (
            '<section class="ts4-hero ' + tone + '">' +
            '<div class="ts4-hero-top"><span class="ts4-chip"><i class="fas fa-hashtag"></i> ' + esc(o.orderCode) + '</span>' +
            '<div class="ts4-actions"><button type="button" class="ts4-btn" data-copy="' + esc(o.orderCode) + '"><i class="fas fa-copy"></i> Copy</button><button type="button" class="ts4-btn" id="ts-share"><i class="fas fa-share-nodes"></i> Share</button><button type="button" class="ts4-btn primary" id="ts-refresh"><i class="fas fa-rotate"></i> Refresh</button></div></div>' +
            '<div class="ts4-hero-body"><div class="ts4-ring" style="--p:' + p + '"><b>' + p + '%</b></div><div>' +
            '<h2>' + esc(headline) + '</h2>' +
            (active && active.summary ? '<p>' + esc(active.summary) + '</p>' : '') +
            (cs && cs.label ? '<div class="ts4-cstatus is-' + esc(cs.tone || 'label') + '"><span></span><b>' + esc(cs.label) + '</b>' + (cs.place ? ' · ' + esc(cs.place) : '') + (cs.at ? ' · ' + esc(fmtWhen(cs.at)) : '') + '</div>' : '') +
            '</div></div>' +
            railHtml(t) +
            '</section>' +
            '<div class="ts4-tiles">' +
            tile('fa-location-dot', 'Where it is', latest ? latest.city || latest.title : headline, latest && latest.city ? latest.title : '') +
            tile('fa-calendar-check', t.rank >= 5 ? 'Delivered' : 'Delivery by', t.deliveryBy || (t.expected && t.expected.deliveryText) || String(((steps.find(function (s) { return s.key === 'delivered'; }) || {}).expectedLabel || '')).replace(/^Expected\s*/i, '') || '—', t.rank >= 5 ? '' : t.dates && t.dates.deliveryKind === 'courier' ? 'Confirmed by courier' : 'Seller estimate') +
            tile('fa-truck', 'Courier', partner ? partner.name : o.courierProviderLabel || o.courierProvider || '—', (partner && partner.trackingNo) || o.courierTrackingNo || '') +
            tile('fa-clock-rotate-left', 'Last update', latest && latest.at ? fmtWhen(latest.at) : o.updatedAt ? fmtWhen(o.updatedAt) : '—', st.scans ? st.scans + ' courier scans' : '') +
            tile('fa-warehouse', 'Hubs crossed', st.hubsVisited ? String(st.hubsVisited) : '', st.route && st.route.length ? st.route.join(' → ') : '') +
            (otpStep ? '<div class="ts4-tile ts4-otp"><i class="fas fa-key"></i><div><small>Delivery OTP</small><b>' + esc(otpStep.deliveryOtp) + '</b><em>Share only with the delivery partner at your door</em></div></div>' : t.otpSupported && !pickupStep && t.rank < 5 ? '<div class="ts4-tile ts4-otp is-empty"><i class="fas fa-key"></i><div><small>Delivery OTP</small><b>\u2014</b><em>The courier sends this code to your phone when the delivery task is assigned \u2014 the delivery partner will ask for it</em></div></div>' : '') +
            (pickupStep ? '<div class="ts4-tile ts4-otp"><i class="fas fa-key"></i><div><small>Pickup OTP</small><b>' + esc(pickupStep.pickup.pickupOtp) + '</b><em>Store staff quote this to the courier</em></div></div>' : t.otpSupported && t.rank >= 1 && t.rank < 3 ? '<div class="ts4-tile ts4-otp is-empty"><i class="fas fa-key"></i><div><small>Pickup OTP</small><b>\u2014</b><em>Not issued by the courier yet</em></div></div>' : '') +
            '</div>' +
            journeyHtml(o)
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
                root.innerHTML = summaryHtml(o) + '<section class="ts4-card"><div class="ts4-card-head"><h3><i class="fas fa-list-check"></i> Order progress</h3><span>Updates when you refresh</span></div>' + window.TrackTimeline.render({ timeline: o.commerceTimeline, live: live }, { animate: true }) + '</section>';
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
        const search = document.getElementById('track-shipment-search');
        if (search) search.classList.add('ts4-compact');
        if (poll) {
            poll.classList.remove('hidden');
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
        const copy = e.target.closest && e.target.closest('[data-copy]');
        if (copy && navigator.clipboard) {
            navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () { copy.classList.add('ok'); setTimeout(function () { copy.classList.remove('ok'); }, 1200); });
            return;
        }
        const share = e.target.closest && e.target.closest('#ts-share');
        if (share) {
            const url = location.href;
            if (navigator.share) navigator.share({ title: 'Shipment tracking', url: url }).catch(function () {});
            else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { share.classList.add('ok'); setTimeout(function () { share.classList.remove('ok'); }, 1200); });
            return;
        }
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

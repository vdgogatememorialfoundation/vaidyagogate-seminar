/**
 * Public book order tracker.
 */
(function () {
    let pollTimer = null;

    function showErr(msg) {
        const el = document.getElementById('order-tracker-err');
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

    function renderResult(data) {
        const root = document.getElementById('order-tracker-result');
        const poll = document.getElementById('order-tracker-poll');
        if (!root || !data || !data.order) return;
        const o = data.order;
        root.classList.remove('hidden');
        if (window.BookTrackingUI) {
            root.innerHTML = window.BookTrackingUI.renderPackageTracker(o.deliveryJourney, o.courierTrackEvents || [], {
                destination: o.destination
            });
        }
        const live = o.deliveryJourney && o.deliveryJourney.isLive;
        if (poll) poll.classList.toggle('hidden', !live);
        const ul = root.querySelector('.pkg-scan-timeline');
        if (ul) ul.scrollTop = ul.scrollHeight;
    }

    async function trackOrder(payload, silent) {
        if (!silent) showErr('');
        const res = await fetch('/api/public/book-orders/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not track order');
        renderResult(data);
        if (data.order && data.order.deliveryJourney && data.order.deliveryJourney.isLive) {
            startPoll(payload);
        } else {
            stopPoll();
        }
        return data;
    }

    function startPoll(payload) {
        stopPoll();
        pollTimer = setInterval(function () {
            trackOrder(payload, true).catch(function () {});
        }, 10000);
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function readForm() {
        return {
            orderCode: (document.getElementById('ot-order-code') || {}).value.trim(),
            awb: (document.getElementById('ot-awb') || {}).value.trim() || undefined,
            phoneLast4:
                String((document.getElementById('ot-phone') || {}).value || '')
                    .replace(/\D/g, '')
                    .slice(-4) || undefined
        };
    }

    document.getElementById('order-tracker-form').addEventListener('submit', function (e) {
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
        const oc = document.getElementById('ot-order-code');
        if (oc) oc.value = orderFromUrl;
    }
    if (awbFromUrl) {
        const aw = document.getElementById('ot-awb');
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

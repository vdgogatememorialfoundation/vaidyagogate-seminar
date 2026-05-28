/**
 * Public book order / courier tracking page (Amazon / Flipkart style).
 */
(function () {
    let pollTimer = null;

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;');
    }

    function qs(name) {
        return new URLSearchParams(window.location.search).get(name) || '';
    }

    function showErr(msg) {
        const el = document.getElementById('track-book-err');
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.classList.add('hidden');
        }
    }

    function renderResult(data) {
        const root = document.getElementById('track-book-result');
        const poll = document.getElementById('track-book-poll');
        if (!root || !data || !data.order) return;
        const o = data.order;
        const journey = o.deliveryJourney;
        const events = o.courierTrackEvents || [];
        root.classList.remove('hidden');
        if (window.BookTrackingUI) {
            root.innerHTML = window.BookTrackingUI.renderPackageTracker(journey, events, {
                destination: o.destination
            });
        } else {
            root.innerHTML = '<p>Tracking UI failed to load.</p>';
        }
        const live = journey && journey.isLive;
        if (poll) poll.classList.toggle('hidden', !live);
        const ul = root.querySelector('.pkg-scan-timeline');
        if (ul) ul.scrollTop = ul.scrollHeight;
    }

    async function trackOrder(payload, silent) {
        if (!silent) showErr('');
        try {
            const res = await fetch('/api/public/book-orders/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not track order');
            renderResult(data);
            const live = data.order && data.order.deliveryJourney && data.order.deliveryJourney.isLive;
            if (live) startPoll(payload);
            else stopPoll();
            return data;
        } catch (e) {
            if (!silent) showErr(e.message || 'Tracking failed');
            stopPoll();
            throw e;
        }
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
        const orderCode = (document.getElementById('track-order-code') || {}).value.trim();
        const awb = (document.getElementById('track-awb') || {}).value.trim();
        const phoneLast4 = String((document.getElementById('track-phone') || {}).value || '')
            .replace(/\D/g, '')
            .slice(-4);
        return { orderCode, awb: awb || undefined, phoneLast4: phoneLast4 || undefined };
    }

    document.getElementById('track-book-form').addEventListener('submit', function (e) {
        e.preventDefault();
        const p = readForm();
        if (!p.awb && !p.phoneLast4) {
            return showErr('Enter AWB or last 4 digits of shipping mobile.');
        }
        trackOrder(p, false);
    });

    const orderFromUrl = qs('order') || qs('orderCode');
    const awbFromUrl = qs('awb') || qs('tracking');
    if (orderFromUrl) {
        const oc = document.getElementById('track-order-code');
        if (oc) oc.value = orderFromUrl;
    }
    if (awbFromUrl) {
        const aw = document.getElementById('track-awb');
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
        );
    }

    window.addEventListener('beforeunload', stopPoll);
})();

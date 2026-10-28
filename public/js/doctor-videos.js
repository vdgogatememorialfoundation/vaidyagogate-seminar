/**
 * Doctor portal: seminar video library (year-wise list, token-gated HLS playback, purchases).
 * Uses the vendored hls.js build at /vendor/hls.light.min.js; Safari plays HLS natively.
 */
(function () {
    const HLS_SRC = '/vendor/hls.light.min.js?v=1.7.3';
    let data = null;
    let loading = false;
    let play = null; // { token, videoId, hls, heartbeat, wmTimer, ended }
    let payState = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function userId() {
        if (typeof doctorNumericUserId === 'function') return doctorNumericUserId();
        return null;
    }

    function $(id) {
        return document.getElementById(id);
    }

    function fmtDuration(sec) {
        const s = Math.max(0, Math.round(Number(sec) || 0));
        if (!s) return '';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (h) return h + ' h ' + (m ? m + ' min' : '');
        if (!m) return s + ' sec';
        return m + ' min';
    }

    function fmtMoney(n) {
        return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function accessLabel(access) {
        if (!access || !access.allowed) return '';
        if (access.reason === 'volunteer') return 'Free for volunteers';
        if (access.reason === 'registered_scanned') return 'Included — registered, paid, ticket scanned';
        if (access.reason === 'registered_paid' || access.reason === 'registered') return 'Included — registered and paid';
        if (access.reason === 'purchase') return 'Purchased';
        if (access.reason === 'admin_paid') return 'Payment recorded by the seminar office';
        return 'Enabled by the seminar office';
    }

    function whyLocked(access) {
        const c = (access && access.checks) || {};
        if (!c.registered) return 'You are not registered for this seminar.';
        if (!c.paid) return 'Your registration fee is not paid yet, so this video is not included.';
        return '';
    }

    /** A stable, random id for this browser. Devices are limited per account, so it is kept for good. */
    function deviceId() {
        try {
            let id = localStorage.getItem('vl_device');
            if (!/^[a-f0-9]{32}$/.test(id || '')) {
                const buf = new Uint8Array(16);
                (window.crypto || window.msCrypto).getRandomValues(buf);
                id = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
                localStorage.setItem('vl_device', id);
            }
            return id;
        } catch (_) {
            return '';
        }
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (window.Hls) return resolve();
            const existing = document.querySelector('script[data-vl-hls]');
            if (existing) {
                existing.addEventListener('load', () => resolve());
                existing.addEventListener('error', () => reject(new Error('player failed to load')));
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.setAttribute('data-vl-hls', '1');
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('player failed to load'));
            document.head.appendChild(s);
        });
    }

    async function api(url, opts) {
        const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
        let body = null;
        try {
            body = await res.json();
        } catch (_) {
            body = null;
        }
        if (!res.ok) {
            const err = new Error((body && body.error) || 'Request failed (' + res.status + ')');
            err.status = res.status;
            err.body = body;
            throw err;
        }
        return body;
    }

    /* ------------------------------------------------------------ list */

    async function load() {
        const uid = userId();
        const host = $('vl-years');
        if (!host) return;
        if (!uid) {
            host.innerHTML = '<p class="vl-note">Sign in to see the seminar videos.</p>';
            return;
        }
        if (loading) return;
        loading = true;
        try {
            data = await api('/api/doctor/videos?userId=' + encodeURIComponent(uid) + '&_=' + Date.now());
            render();
        } catch (e) {
            host.innerHTML = '<p class="vl-note" style="color:#b91c1c;">' + esc(e.message) + '</p>';
        } finally {
            loading = false;
        }
    }

    function render() {
        const host = $('vl-years');
        if (!host || !data) return;
        const years = data.years || [];
        if (!years.length) {
            const volunteer = data.viewer && data.viewer.volunteer;
            host.innerHTML =
                '<div class="vl-card"><h4>No videos published yet</h4><p>' +
                (volunteer
                    ? 'Seminar videos is turned on for volunteer accounts. Recordings appear here after the seminar office publishes them.'
                    : 'Seminar recordings appear here once the seminar office publishes them.') +
                '</p></div>';
            return;
        }
        const pending = data.pendingPurchases || [];
        const licenseBar = data.license
            ? '<div class="vl-license"><div><span class="vl-license-lbl">Your video license</span><b>' +
              esc(data.license) +
              '</b></div><div class="vl-license-note">This number is printed inside every video you watch. Videos play on up to ' +
              esc(data.maxDevices || 2) +
              ' of your own devices. <button type="button" class="vl-linkbtn" id="vl-devices-btn">My devices</button></div><div id="vl-devices" class="hidden"></div></div>'
            : '';
        host.innerHTML = licenseBar + years
            .map((y) => {
                const bundle =
                    y.bundlePriceInr != null && y.bundlePriceInr > 0 && !y.allAllowed
                        ? '<button type="button" class="vl-btn is-ghost is-small" data-vl-buy-year="' + y.year + '">Unlock all ' + y.year + ' videos · ' + fmtMoney(y.bundlePriceInr) + '</button>'
                        : '';
                const cards = y.videos.map((v) => card(v, pending)).join('');
                const accent = /^#[0-9a-fA-F]{6}$/.test(y.accent || '') ? y.accent : '';
                return (
                    '<section class="vl-year"' +
                    (accent ? ' style="border-top:4px solid ' + accent + ';padding-top:10px;"' : '') +
                    '><div class="vl-year-head"><h3>' +
                    esc(y.title || 'Seminar ' + y.year) +
                    '</h3><span class="vl-badge">' +
                    y.videos.length +
                    (y.videos.length === 1 ? ' video' : ' videos') +
                    '</span>' +
                    bundle +
                    (y.description ? '<p class="vl-note">' + esc(y.description) + '</p>' : '') +
                    '</div><div class="vl-grid">' +
                    cards +
                    '</div></section>'
                );
            })
            .join('');
        host.querySelectorAll('[data-vl-watch]').forEach((b) => b.addEventListener('click', () => watch(parseInt(b.getAttribute('data-vl-watch'), 10))));
        host.querySelectorAll('[data-vl-buy]').forEach((b) => b.addEventListener('click', () => startPurchase({ videoId: parseInt(b.getAttribute('data-vl-buy'), 10) })));
        host.querySelectorAll('[data-vl-buy-year]').forEach((b) => b.addEventListener('click', () => startPurchase({ year: parseInt(b.getAttribute('data-vl-buy-year'), 10) })));
        host.querySelectorAll('[data-vl-check]').forEach((b) => b.addEventListener('click', () => checkPending(parseInt(b.getAttribute('data-vl-check'), 10), b)));
        const devBtn = $('vl-devices-btn');
        if (devBtn) devBtn.addEventListener('click', showDevices);
    }

    async function showDevices() {
        const box = $('vl-devices');
        if (!box) return;
        box.classList.remove('hidden');
        box.innerHTML = '<span class="vl-note">Loading…</span>';
        try {
            const d = await api('/api/doctor/videos/devices?userId=' + encodeURIComponent(userId()) + '&deviceId=' + encodeURIComponent(deviceId()));
            const rows = (d.devices || []).map(
                (x) =>
                    '<li>' +
                    esc(x.label) +
                    (x.current ? ' <span class="vl-badge is-free">this device</span>' : '') +
                    '<small>first used ' + esc(fmtWhen(x.firstSeenAt)) + ' · last used ' + esc(fmtWhen(x.lastSeenAt)) + '</small></li>'
            );
            box.innerHTML =
                '<p class="vl-note">' + (d.devices || []).length + ' of ' + esc(d.limit) + ' devices in use. To move your access to a new device, contact the seminar office.</p>' +
                (rows.length ? '<ul class="vl-devlist">' + rows.join('') + '</ul>' : '<p class="vl-note">No device has played a video yet. The first device you watch on is registered automatically.</p>');
        } catch (e) {
            box.innerHTML = '<span class="vl-note" style="color:#b91c1c;">' + esc(e.message) + '</span>';
        }
    }

    function fmtWhen(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (_) {
            return iso;
        }
    }

    function card(v, pending) {
        const kind = v.kind === 'full' ? '<span class="vl-badge is-full">Full video</span>' : '<span class="vl-badge is-part">Part ' + (v.partNo != null ? v.partNo : '') + '</span>';
        const dur = fmtDuration(v.durationSec);
        const pend = pending.find((p) => (p.video_id && p.video_id === v.id) || (!p.video_id && p.year === v.year));
        const allowed = v.access && v.access.allowed;
        const resume = v.positionSec > 30 && v.durationSec && v.positionSec < v.durationSec - 30;
        let actions = '';
        if (allowed) {
            actions =
                '<button type="button" class="vl-btn" data-vl-watch="' + v.id + '"><i class="fas fa-play"></i> ' + (resume ? 'Resume' : 'Watch') + '</button>' +
                '<span class="vl-badge is-free">' + esc(accessLabel(v.access)) + '</span>';
        } else if (pend) {
            actions =
                '<span class="vl-badge is-paid">Payment pending</span>' +
                '<button type="button" class="vl-btn is-ghost is-small" data-vl-check="' + pend.id + '">Check payment</button>';
        } else if (v.priceInr > 0) {
            actions =
                '<button type="button" class="vl-btn is-warn" data-vl-buy="' + v.id + '"><i class="fas fa-lock"></i> Unlock · ' + fmtMoney(v.priceInr) + '</button>' +
                (whyLocked(v.access) ? '<span class="vl-note vl-why">' + esc(whyLocked(v.access)) + '</span>' : '');
        } else {
            actions = '<span class="vl-badge">Available to registered participants</span>' + (whyLocked(v.access) ? '<span class="vl-note vl-why">' + esc(whyLocked(v.access)) + '</span>' : '');
        }
        const progress = allowed && v.durationSec && v.positionSec > 0 ? '<div class="vl-progress"><span style="width:' + Math.min(100, Math.round((v.positionSec / v.durationSec) * 100)) + '%"></span></div>' : '';
        return (
            '<article class="vl-card"><div class="vl-card-top">' +
            kind +
            (dur ? '<span class="vl-note">' + esc(dur) + '</span>' : '') +
            '</div><h4>' +
            esc(v.title) +
            '</h4>' +
            (v.seminarTitle ? '<p class="vl-seminar"><i class="fas fa-calendar-check"></i> ' + esc(v.seminarTitle) + '</p>' : '') +
            (v.description ? '<p>' + esc(v.description.length > 180 ? v.description.slice(0, 177) + '…' : v.description) + '</p>' : '') +
            progress +
            '<div class="vl-card-actions">' +
            actions +
            '</div></article>'
        );
    }

    /* ---------------------------------------------------------- player */

    function wmText(wm) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        return '<b>' + esc(wm.license || '') + '</b><span>' + esc(wm.name || '') + '</span><small>' + esc(wm.id || '') + ' · ' + hh + ':' + mm + '</small>';
    }

    function moveWatermark() {
        const el = $('vl-wm');
        if (!el || !play) return;
        el.innerHTML = wmText(play.watermark || {});
        el.style.left = 5 + Math.random() * 65 + '%';
        el.style.top = 6 + Math.random() * 78 + '%';
    }

    async function watch(videoId) {
        const uid = userId();
        if (!uid) return;
        stop(true);
        const wrap = $('vl-player-wrap');
        const video = $('vl-video');
        const msg = $('vl-player-msg');
        if (!wrap || !video) return;
        wrap.classList.remove('hidden');
        msg.textContent = 'Preparing secure playback…';
        wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        let session;
        try {
            session = await api('/api/doctor/videos/' + videoId + '/session', { method: 'POST', body: JSON.stringify({ userId: uid, deviceId: deviceId() }) });
        } catch (e) {
            msg.textContent = e.message;
            if (e.body && (e.body.code === 'device_limit' || e.body.code === 'device_blocked')) {
                const box = $('vl-devices');
                if (box) {
                    showDevices();
                    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
            return;
        }
        const fixedWm = $('vl-wm-fixed');
        if (fixedWm) fixedWm.textContent = (session.watermark && session.watermark.license) || '';
        $('vl-player-title').textContent = session.video ? session.video.title : 'Seminar video';
        play = { token: session.token, videoId, hls: null, heartbeat: null, wmTimer: null, watermark: session.watermark || {}, ended: false };
        moveWatermark();
        play.wmTimer = setInterval(moveWatermark, 9000);
        video.setAttribute('controlsList', 'nodownload noremoteplayback noplaybackrate');
        video.controlsList && video.controlsList.add && video.controlsList.add('nodownload');
        video.disablePictureInPicture = true;
        video.disableRemotePlayback = true;
        video.setAttribute('controlslist', 'nodownload noremoteplayback noplaybackrate');
        video.oncontextmenu = () => false;
        const start = Number(session.positionSec) || 0;
        const onReady = () => {
            if (start > 5) {
                try {
                    video.currentTime = start;
                } catch (_) {}
            }
            video.play().catch(() => {});
            msg.textContent = '';
        };
        if (video.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) {
            video.src = session.playlistUrl;
            video.addEventListener('loadedmetadata', onReady, { once: true });
        } else {
            try {
                await loadScript(HLS_SRC);
            } catch (e) {
                msg.textContent = 'The video player could not be loaded. Refresh the page and try again.';
                return;
            }
            if (!window.Hls || !Hls.isSupported()) {
                msg.textContent = 'This browser cannot play protected video. Use a current version of Chrome, Edge, Firefox, or Safari.';
                return;
            }
            const hls = new Hls({
                enableWorker: false,
                lowLatencyMode: false,
                backBufferLength: 60,
                maxBufferLength: 45,
                xhrSetup: function (xhr) {
                    try {
                        xhr.withCredentials = true;
                        xhr.setRequestHeader('X-Vgmf-Device', deviceId());
                    } catch (_) {}
                }
            });
            play.hls = hls;
            hls.on(Hls.Events.ERROR, (_evt, err) => {
                const code = err && err.response && err.response.code;
                if (code === 403 || code === 410) return endedElsewhere();
                if (err && err.fatal) {
                    if (err.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                    else if (err.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                    else msg.textContent = 'Playback error. Press Watch again.';
                }
            });
            hls.on(Hls.Events.MANIFEST_PARSED, onReady);
            hls.loadSource(session.playlistUrl);
            hls.attachMedia(video);
        }
        play.heartbeat = setInterval(() => heartbeat(video), 15000);
        video.addEventListener('pause', () => heartbeat(video));
        video.addEventListener('ended', () => heartbeat(video));
    }

    function endedElsewhere() {
        if (!play || play.ended) return;
        play.ended = true;
        const msg = $('vl-player-msg');
        if (msg) msg.textContent = 'This video was opened on another device or tab, so playback stopped here. Press Watch to continue on this device.';
        const video = $('vl-video');
        if (video) video.pause();
        if (play.hls) {
            try {
                play.hls.stopLoad();
            } catch (_) {}
        }
    }

    async function heartbeat(video) {
        if (!play || play.ended) return;
        const uid = userId();
        try {
            await api('/api/doctor/videos/' + play.videoId + '/progress', {
                method: 'POST',
                body: JSON.stringify({ userId: uid, token: play.token, positionSec: video ? video.currentTime : null })
            });
        } catch (e) {
            if (e.status === 410 || e.status === 403) endedElsewhere();
        }
    }

    function stop(silent) {
        const wrap = $('vl-player-wrap');
        const video = $('vl-video');
        if (play) {
            clearInterval(play.heartbeat);
            clearInterval(play.wmTimer);
            if (play.hls) {
                try {
                    play.hls.destroy();
                } catch (_) {}
            }
            const token = play.token;
            const vid = play.videoId;
            const pos = video ? video.currentTime : null;
            const uid = userId();
            if (!play.ended) {
                fetch('/api/doctor/videos/' + vid + '/progress', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: uid, token, positionSec: pos }),
                    keepalive: true
                }).catch(() => {});
            }
            fetch('/api/doctor/videos/' + vid + '/session/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
                keepalive: true
            }).catch(() => {});
            play = null;
        }
        if (video) {
            try {
                video.pause();
                video.removeAttribute('src');
                video.load();
            } catch (_) {}
        }
        if (wrap && !silent) wrap.classList.add('hidden');
        if (!silent && data) load();
    }

    /* -------------------------------------------------------- purchases */

    async function startPurchase(target) {
        const uid = userId();
        if (!uid) return;
        const box = $('vl-pay');
        if (!box) return;
        payState = Object.assign({}, target);
        box.classList.remove('hidden');
        box.innerHTML = '<h4>Choose how to pay</h4><p class="vl-note">Loading payment methods…</p>';
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        let options = [];
        try {
            options = await api('/api/doctor/videos/payment-options?userId=' + encodeURIComponent(uid));
        } catch (e) {
            box.innerHTML = '<h4>Payment</h4><p class="vl-note" style="color:#b91c1c;">' + esc(e.message) + '</p>';
            return;
        }
        if (!options.length) {
            box.innerHTML = '<h4>Payment</h4><p class="vl-note">Online payment is not available right now. Contact the seminar office; they can unlock the video for you after payment.</p>';
            return;
        }
        box.innerHTML =
            '<h4>Choose how to pay</h4><div class="vl-pay-options">' +
            options.map((o) => '<button type="button" class="vl-btn is-ghost" data-vl-mid="' + esc(o.id) + '">' + esc(o.label || o.id) + '</button>').join('') +
            '<button type="button" class="vl-btn is-ghost is-small" data-vl-cancel>Cancel</button></div><div id="vl-pay-body"></div><p class="vl-pay-msg" id="vl-pay-msg"></p>';
        box.querySelectorAll('[data-vl-mid]').forEach((b) => b.addEventListener('click', () => pay(b.getAttribute('data-vl-mid'))));
        box.querySelector('[data-vl-cancel]').addEventListener('click', () => {
            box.classList.add('hidden');
            payState = null;
        });
    }

    async function pay(mid) {
        const uid = userId();
        const msg = $('vl-pay-msg');
        const body = $('vl-pay-body');
        if (!payState || !msg) return;
        msg.textContent = 'Starting payment…';
        let result;
        try {
            result = await api('/api/doctor/videos/purchase', {
                method: 'POST',
                body: JSON.stringify({ userId: uid, videoId: payState.videoId || null, year: payState.year || null, mid })
            });
        } catch (e) {
            msg.textContent = e.message;
            return;
        }
        payState.purchaseId = result.purchaseId;
        if (result.paymentType === 'dqr' && result.qrImageUrl) {
            body.innerHTML =
                '<div class="vl-pay-qr"><p style="font-weight:600;color:#0f766e;margin:0 0 8px;">Scan the UPI QR to pay ' + fmtMoney(result.amount) + '</p><img src="' + esc(result.qrImageUrl) + '" alt="UPI QR"></div>';
            msg.textContent = result.message || 'Waiting for the payment…';
            pollPurchase(result.purchaseId, 150);
            return;
        }
        if (result.paymentType === 'razorpay_checkout') {
            msg.textContent = 'Opening Razorpay…';
            if (typeof Razorpay === 'undefined' && typeof loadRazorpayCheckoutScript === 'function') {
                try {
                    await loadRazorpayCheckoutScript();
                } catch (_) {}
            }
            if (typeof Razorpay === 'undefined') {
                msg.textContent = 'Razorpay did not load. Disable ad blockers and try again.';
                return;
            }
            const user = typeof currentUser !== 'undefined' && currentUser ? currentUser : {};
            const rzp = new Razorpay({
                key: result.keyId,
                amount: result.razorpayOrder.amount,
                currency: result.razorpayOrder.currency || 'INR',
                name: 'Vaidya Gogate Memorial Foundation',
                description: result.label || 'Seminar video access',
                order_id: result.razorpayOrder.id,
                handler: function (response) {
                    verify(result.purchaseId, response);
                },
                modal: { ondismiss: () => (msg.textContent = 'Payment window closed. You can try again.') },
                prefill: { name: ((user.first_name || '') + ' ' + (user.last_name || '')).trim(), email: user.email || '', contact: user.phone || '' },
                theme: { color: '#0f766e' }
            });
            rzp.on('payment.failed', (resp) => {
                msg.textContent = (resp.error && resp.error.description) || 'Payment failed. You can try again.';
            });
            rzp.open();
            return;
        }
        msg.textContent = result.message || 'Payment started.';
    }

    async function verify(purchaseId, response) {
        const msg = $('vl-pay-msg');
        try {
            await api('/api/doctor/videos/purchase/' + purchaseId + '/verify', {
                method: 'POST',
                body: JSON.stringify({
                    userId: userId(),
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature
                })
            });
            if (msg) msg.textContent = 'Payment received. The video is unlocked.';
            setTimeout(() => {
                const box = $('vl-pay');
                if (box) box.classList.add('hidden');
                load();
            }, 1200);
        } catch (e) {
            if (msg) msg.textContent = e.message + ' We will also check the payment automatically.';
            pollPurchase(purchaseId, 20);
        }
    }

    async function pollPurchase(purchaseId, attemptsLeft) {
        if (!payState || payState.purchaseId !== purchaseId) return;
        if (attemptsLeft <= 0) {
            const msg = $('vl-pay-msg');
            if (msg) msg.textContent = 'Still waiting for the payment. Use "Check payment" on the video card after paying.';
            return;
        }
        try {
            const st = await api('/api/doctor/videos/purchase/' + purchaseId + '/status?userId=' + encodeURIComponent(userId()));
            if (st.paid) {
                const msg = $('vl-pay-msg');
                if (msg) msg.textContent = 'Payment received. The video is unlocked.';
                setTimeout(() => {
                    const box = $('vl-pay');
                    if (box) box.classList.add('hidden');
                    payState = null;
                    load();
                }, 1200);
                return;
            }
        } catch (_) {}
        setTimeout(() => pollPurchase(purchaseId, attemptsLeft - 1), 4000);
    }

    async function checkPending(purchaseId, btn) {
        if (btn) btn.disabled = true;
        try {
            const st = await api('/api/doctor/videos/purchase/' + purchaseId + '/status?userId=' + encodeURIComponent(userId()));
            if (st.paid) return load();
            alert('The payment has not been seen yet. If you have paid, wait a minute and check again, or contact the seminar office.');
        } catch (e) {
            alert(e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ------------------------------------------------------------- init */

    function playerOpen() {
        const wrap = $('vl-player-wrap');
        return !!(wrap && !wrap.classList.contains('hidden'));
    }

    function blockPlayerSave(e) {
        if (!playerOpen()) return;
        const wrap = $('vl-player-wrap');
        if (!wrap || !wrap.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
    }

    function bindOnce() {
        const pane = $('tab-videos');
        if (!pane || pane.__vlBound) return;
        pane.__vlBound = true;
        const close = $('vl-player-close');
        if (close) close.addEventListener('click', () => stop(false));
        const video = $('vl-video');
        const guard = $('vl-guard');
        if (guard && video) {
            guard.addEventListener('click', () => {
                if (video.paused) video.play().catch(() => {});
                else video.pause();
            });
            guard.addEventListener('dblclick', (e) => {
                e.preventDefault();
            });
        }
        if (video) {
            video.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            video.addEventListener('dragstart', (e) => e.preventDefault());
            video.addEventListener('enterpictureinpicture', () => {
                if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
            });
        }
        document.addEventListener('contextmenu', blockPlayerSave, true);
        document.addEventListener('dragstart', blockPlayerSave, true);
        document.addEventListener('keydown', (e) => {
            if (!playerOpen()) return;
            const k = String(e.key || '').toLowerCase();
            if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'u')) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && play && video && !video.paused) video.pause();
        });
        window.addEventListener('pagehide', () => stop(true));
    }

    window.initDoctorVideosTab = function () {
        bindOnce();
        load();
    };
    window.stopDoctorVideoPlayback = function () {
        if (play) stop(true);
        const wrap = $('vl-player-wrap');
        if (wrap) wrap.classList.add('hidden');
    };
})();

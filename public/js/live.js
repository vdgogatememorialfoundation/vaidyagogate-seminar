(function () {
    const seminarId = parseInt((location.pathname.match(/\/live\/(\d+)/) || [])[1] || '0', 10);
    const $ = (id) => document.getElementById(id);
    const errEl = $('live-error');
    const badge = $('live-badge');
    const video = $('live-video');
    const waitEl = $('live-wait');
    const statusEl = $('live-status');
    const key = 'vgmf_live_token_' + seminarId;
    let email = '';
    let token = sessionStorage.getItem(key) || '';
    let socket = null;
    let hls = null;
    let playing = false;

    function say(msg) { errEl.textContent = msg || ''; }
    function setBadge(text, on) { badge.textContent = text; badge.classList.toggle('on', !!on); }

    async function post(url, body) {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Request failed'), { data });
        return data;
    }

    fetch('/api/public/online-seminar/live').then((r) => r.json()).then((d) => {
        const s = ((d && d.seminars) || []).find((x) => Number(x.id) === seminarId);
        if (s) {
            $('live-title').textContent = s.title || 'Live seminar';
            document.title = (s.title || 'Live seminar') + ' · Live';
            setBadge(s.live ? 'LIVE' : 'Scheduled', s.live);
        } else setBadge('Not available', false);
    }).catch(() => setBadge('Offline', false));

    $('live-email-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        say('');
        const btn = ev.target.querySelector('button');
        btn.disabled = true;
        email = $('live-email').value.trim().toLowerCase();
        try {
            await post('/api/online-seminar/live/otp', { seminarId, email });
            $('live-email-form').classList.add('hidden');
            $('live-code-form').classList.remove('hidden');
            $('live-code').focus();
            say('');
            statusEl.textContent = 'Code sent to ' + email;
        } catch (e) { say(e.message); }
        btn.disabled = false;
    });

    $('live-resend').addEventListener('click', async () => {
        say('');
        try { await post('/api/online-seminar/live/otp', { seminarId, email }); say('A new code was sent.'); } catch (e) { say(e.message); }
    });

    $('live-code-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        say('');
        try {
            const out = await post('/api/online-seminar/live/verify', { seminarId, email, code: $('live-code').value, passcode: $('live-pass').value });
            if (out.mode !== 'hall' || !out.token) {
                if (out.url) { window.open(out.url, '_blank'); say('Opening the meeting in a new tab.'); }
                return;
            }
            token = out.token;
            sessionStorage.setItem(key, token);
            enter();
        } catch (e) {
            if (e.data && e.data.needsPasscode) $('live-pass').classList.remove('hidden');
            say(e.message);
        }
    });

    function playHls() {
        if (playing) return;
        playing = true;
        waitEl.style.display = 'none';
        const src = '/api/hall/' + seminarId + '/media/live.m3u8';
        if (window.Hls && Hls.isSupported()) {
            hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3, xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', 'Bearer ' + token) });
            hls.loadSource(src);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { playing = false; hls.destroy(); setTimeout(playHls, 3000); } });
        } else {
            video.src = src + '?t=' + encodeURIComponent(token);
            video.play().catch(() => {});
        }
    }

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(proto + '://' + location.host + '/api/hall/socket?token=' + encodeURIComponent(token));
        socket.onmessage = (ev) => {
            if (typeof ev.data !== 'string') return;
            let msg = null;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            if (msg.type === 'snapshot') {
                $('live-mark').textContent = ((msg.you && msg.you.name) || '') + ' · ' + email;
                if (msg.hls) { setBadge('LIVE', true); playHls(); }
                else waitEl.textContent = msg.you && msg.you.waiting ? 'The host will admit you shortly.' : 'Waiting for the host to go live…';
            } else if ((msg.type === 'playback' && msg.hls) || (msg.type === 'live' && msg.live)) {
                setBadge('LIVE', true);
                if (msg.type === 'playback') playHls();
            } else if (msg.type === 'admitted') {
                waitEl.textContent = 'You are in. Waiting for the stream…';
            } else if (msg.type === 'ended') {
                setBadge('Ended', false);
                waitEl.style.display = 'flex';
                waitEl.textContent = 'This seminar has ended. Thank you for attending.';
                if (hls) hls.destroy();
            } else if (msg.type === 'error') {
                say(msg.error || 'Disconnected.');
            }
        };
        socket.onclose = (ev) => {
            if (ev.code === 4000 || ev.code === 4003) {
                statusEl.textContent = 'You were signed in from another device, so this screen was closed.';
                waitEl.style.display = 'flex';
                waitEl.textContent = 'Session moved to another device.';
                if (hls) hls.destroy();
                return;
            }
            if (ev.code === 4001) { sessionStorage.removeItem(key); token = ''; $('live-stage').classList.add('hidden'); $('live-gate').classList.remove('hidden'); say('Sign in again.'); return; }
            setTimeout(connect, 4000);
        };
    }

    function enter() {
        $('live-gate').classList.add('hidden');
        $('live-stage').classList.remove('hidden');
        statusEl.textContent = 'Your name is shown on the video and this seat works on one device at a time.';
        connect();
    }

    if (token) enter();
})();

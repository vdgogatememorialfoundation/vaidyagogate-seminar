(function () {
    const match = location.pathname.match(/\/hall\/(\d+)/);
    const seminarId = match ? Number(match[1]) : 0;
    const video = document.getElementById('hall-video');
    const waitEl = document.getElementById('hall-wait');
    const controls = document.getElementById('hall-controls');
    const peopleEl = document.getElementById('hall-people');
    const chatEl = document.getElementById('hall-chat');
    const questionsEl = document.getElementById('hall-questions');
    const errorEl = document.getElementById('hall-error');
    const titleEl = document.getElementById('hall-title');
    const roleEl = document.getElementById('hall-role');
    const speakerRow = document.getElementById('speaker-row');

    let socket = null;
    let role = 'audience';
    let me = null;
    let localStream = null;
    let recorder = null;
    let mime = '';
    let sourceBuffer = null;
    let chunkQueue = [];
    let mediaSource = null;
    let peers = new Map();
    let remoteStreams = new Map();
    let hostUserId = null;

    function say(err) {
        errorEl.textContent = err || '';
    }

    function escapeText(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function storedPeople() {
        let admin = null;
        let doctor = null;
        try { admin = JSON.parse(localStorage.getItem('admin_user') || 'null'); } catch (_) {}
        try { doctor = JSON.parse(localStorage.getItem('seminar_doctor_user') || 'null'); } catch (_) {}
        const host = admin && (admin.role === 'admin' || admin.user_role === 'co_admin' || admin.user_role === 'admin');
        return { host: host ? admin : null, person: doctor || admin };
    }

    async function obtainToken() {
        const key = 'vgmf_hall_token_' + seminarId;
        const existing = sessionStorage.getItem(key);
        if (existing) return existing;
        const people = storedPeople();
        const person = people.person;
        if (!person || person.id == null) throw new Error('Sign in from the doctor portal or the office, then join again.');
        const body = { seminarId: seminarId, userId: person.id, userIdString: person.user_id_string || '' };
        if (people.host) body.actingAdminId = people.host.id;
        const res = await fetch('/api/online-seminar/join', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.token) throw new Error(data.error || 'This hall could not be opened.');
        sessionStorage.setItem(key, data.token);
        if (data.title) titleEl.textContent = data.title;
        return data.token;
    }

    function send(obj) {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
    }

    function button(label, className, onClick) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        if (className) el.className = className;
        el.addEventListener('click', onClick);
        return el;
    }

    function pickMime() {
        const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
        return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    }

    async function ensureLocal(screen) {
        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
            localStream = null;
        }
        localStream = screen
            ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (role === 'host') {
            video.srcObject = localStream;
            video.muted = true;
            waitEl.style.display = 'none';
        }
        return localStream;
    }

    function mixedStream() {
        if (!remoteStreams.size) return localStream;
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const videos = [];
        if (localStream) {
            const localVideo = document.createElement('video');
            localVideo.srcObject = localStream;
            localVideo.muted = true;
            localVideo.play().catch(() => {});
            videos.push(localVideo);
        }
        remoteStreams.forEach((stream) => {
            const el = document.createElement('video');
            el.srcObject = stream;
            el.muted = true;
            el.play().catch(() => {});
            videos.push(el);
        });
        const draw = () => {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const n = Math.max(videos.length, 1);
            const cols = Math.ceil(Math.sqrt(n));
            const rows = Math.ceil(n / cols);
            const w = canvas.width / cols;
            const h = canvas.height / rows;
            videos.forEach((el, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                try {
                    ctx.drawImage(el, col * w, row * h, w, h);
                } catch (_) {}
            });
            requestAnimationFrame(draw);
        };
        draw();
        const canvasStream = canvas.captureStream(15);
        const audio = new AudioContext();
        const dest = audio.createMediaStreamDestination();
        function addAudio(stream) {
            const tracks = stream.getAudioTracks();
            if (!tracks.length) return;
            const src = audio.createMediaStreamSource(new MediaStream(tracks));
            src.connect(dest);
        }
        if (localStream) addAudio(localStream);
        remoteStreams.forEach(addAudio);
        dest.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
        return canvasStream;
    }

    function startRecorder() {
        mime = pickMime();
        if (!mime || !localStream) {
            say('This browser cannot publish the hall. Open it in Chrome on the host computer.');
            return;
        }
        if (recorder) {
            try { recorder.stop(); } catch (_) {}
        }
        const stream = mixedStream();
        send({ type: 'program-mime', mime: mime });
        recorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size && socket && socket.readyState === 1) socket.send(event.data);
        };
        recorder.start(1000);
        send({ type: 'feed-restart' });
    }

    function ensureMse() {
        if (mediaSource || !window.MediaSource || !mime) return;
        mediaSource = new MediaSource();
        video.srcObject = null;
        video.src = URL.createObjectURL(mediaSource);
        video.muted = false;
        mediaSource.addEventListener('sourceopen', () => {
            try {
                sourceBuffer = mediaSource.addSourceBuffer(mime);
                sourceBuffer.mode = 'sequence';
                sourceBuffer.addEventListener('updateend', pumpChunks);
            } catch (err) {
                say('This browser cannot play the live feed. Use Chrome, or wait for the phone stream.');
            }
        });
    }

    function pumpChunks() {
        if (!sourceBuffer || sourceBuffer.updating || !chunkQueue.length) return;
        sourceBuffer.appendBuffer(chunkQueue.shift());
    }

    function playHls() {
        video.srcObject = null;
        video.src = '/api/hall/' + seminarId + '/media/live.m3u8';
        video.muted = false;
        video.play().catch(() => {});
        waitEl.style.display = 'none';
    }

    function renderPeople(list) {
        hostUserId = null;
        peopleEl.innerHTML = '';
        (list || []).forEach((person) => {
            if (person.role === 'host') hostUserId = person.userId;
            const li = document.createElement('li');
            const hand = person.hand ? ' · hand raised' : '';
            const where = person.waiting ? ' · lobby' : '';
            li.innerHTML = escapeText(person.name) + ' · ' + escapeText(person.role) + hand + where;
            if (role === 'host' && person.userId !== me.userId) {
                if (person.waiting) li.appendChild(button('Admit', 'secondary', () => send({ type: 'host', action: 'admit', userId: person.userId })));
                li.appendChild(button(person.role === 'speaker' ? 'To audience' : 'To stage', 'secondary', () =>
                    send({ type: 'host', action: person.role === 'speaker' ? 'demote' : 'promote', userId: person.userId })
                ));
                li.appendChild(button('Remove', 'danger', () => send({ type: 'host', action: 'kick', userId: person.userId })));
            }
            peopleEl.appendChild(li);
        });
    }

    function renderChat(message) {
        const li = document.createElement('li');
        li.innerHTML = '<strong>' + escapeText(message.name) + '</strong> ' + escapeText(message.text);
        chatEl.appendChild(li);
        chatEl.scrollTop = chatEl.scrollHeight;
    }

    function renderQuestion(question) {
        const li = document.createElement('li');
        li.innerHTML = escapeText(question.name) + ': ' + escapeText(question.text);
        if (role === 'host') {
            li.appendChild(button('Answered', 'secondary', () => send({ type: 'host', action: 'answer', questionId: question.id })));
        }
        questionsEl.appendChild(li);
    }

    function hostControls() {
        controls.innerHTML = '';
        controls.appendChild(button('Camera', '', () => ensureLocal(false).catch((err) => say(err.message))));
        controls.appendChild(button('Screen', 'secondary', () => ensureLocal(true).then(() => { if (recorder) startRecorder(); }).catch((err) => say(err.message))));
        controls.appendChild(button('Go live and record', '', async () => {
            await ensureLocal(false);
            send({ type: 'go-live' });
            startRecorder();
        }));
        controls.appendChild(button('Mic', 'secondary', () => {
            const track = localStream && localStream.getAudioTracks()[0];
            if (track) track.enabled = !track.enabled;
        }));
        controls.appendChild(button('Lock', 'secondary', () => send({ type: 'host', action: 'lock' })));
        controls.appendChild(button('Unlock', 'secondary', () => send({ type: 'host', action: 'unlock' })));
        controls.appendChild(button('End', 'danger', () => send({ type: 'host', action: 'end' })));
    }

    function audienceControls() {
        controls.innerHTML = '';
        controls.appendChild(button('Raise hand', 'secondary', () => send({ type: 'hand', up: true })));
        controls.appendChild(button('Lower hand', 'secondary', () => send({ type: 'hand', up: false })));
    }

    async function connectSpeaker() {
        if (!hostUserId || peers.has(hostUserId)) return;
        const stream = localStream || (await ensureLocal(false));
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        peers.set(hostUserId, pc);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        pc.onicecandidate = (event) => {
            if (event.candidate) send({ type: 'signal', toUserId: hostUserId, payload: { candidate: event.candidate } });
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'signal', toUserId: hostUserId, payload: { sdp: pc.localDescription } });
    }

    async function onSignal(msg) {
        const from = Number(msg.fromUserId);
        let pc = peers.get(from);
        const payload = msg.payload || {};
        if (!pc) {
            pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            peers.set(from, pc);
            pc.ontrack = (event) => {
                const stream = event.streams[0];
                remoteStreams.set(from, stream);
                let tile = document.getElementById('speaker-' + from);
                if (!tile) {
                    tile = document.createElement('div');
                    tile.id = 'speaker-' + from;
                    tile.className = 'speaker-tile';
                    const el = document.createElement('video');
                    el.autoplay = true;
                    el.playsInline = true;
                    tile.appendChild(el);
                    speakerRow.appendChild(tile);
                }
                tile.querySelector('video').srcObject = stream;
                if (role === 'host' && recorder) startRecorder();
            };
            pc.onicecandidate = (event) => {
                if (event.candidate) send({ type: 'signal', toUserId: from, payload: { candidate: event.candidate } });
            };
            if (localStream && role === 'host') localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        }
        if (payload.sdp) {
            await pc.setRemoteDescription(payload.sdp);
            if (payload.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                send({ type: 'signal', toUserId: from, payload: { sdp: pc.localDescription } });
            }
        } else if (payload.candidate) {
            try { await pc.addIceCandidate(payload.candidate); } catch (_) {}
        }
    }

    function onMessage(raw) {
        let msg = null;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        if (msg.type === 'snapshot') {
            role = msg.role || role;
            me = msg.you;
            roleEl.textContent = role === 'host' ? 'Host' : role === 'speaker' ? 'On stage' : msg.you && msg.you.waiting ? 'Waiting room' : 'Audience';
            if (role === 'host') hostControls();
            else audienceControls();
            renderPeople(msg.people);
            (msg.chat || []).forEach(renderChat);
            (msg.questions || []).forEach(renderQuestion);
            if (msg.hls) playHls();
            if (role === 'speaker') connectSpeaker().catch((err) => say(err.message));
            if (msg.you && msg.you.waiting) waitEl.textContent = 'The host will admit you from the lobby.';
        } else if (msg.type === 'people') {
            renderPeople(msg.people);
        } else if (msg.type === 'chat') {
            renderChat(msg.message);
        } else if (msg.type === 'question') {
            renderQuestion(msg.question);
        } else if (msg.type === 'program-mime' && msg.mime) {
            mime = msg.mime;
        } else if (msg.type === 'playback' && msg.hls) {
            playHls();
        } else if (msg.type === 'live' && msg.live) {
            waitEl.textContent = role === 'host' ? 'This meeting is being recorded for the office.' : 'The seminar is live.';
        } else if (msg.type === 'admitted') {
            waitEl.textContent = 'You are in the hall.';
            roleEl.textContent = 'Audience';
        } else if (msg.type === 'role') {
            role = msg.role;
            roleEl.textContent = role === 'speaker' ? 'On stage' : 'Audience';
            if (role === 'speaker') connectSpeaker().catch((err) => say(err.message));
        } else if (msg.type === 'signal') {
            onSignal(msg).catch((err) => say(err.message));
        } else if (msg.type === 'kicked') {
            say('The host removed you from this hall.');
            socket.close();
        } else if (msg.type === 'ended') {
            waitEl.style.display = 'flex';
            waitEl.textContent = 'The host ended the online seminar.';
            if (recorder) recorder.stop();
        } else if (msg.type === 'error') {
            say(msg.error || '');
        }
    }

    document.getElementById('chat-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = document.getElementById('chat-text');
        const text = input.value.trim();
        if (!text) return;
        send({ type: 'chat', text: text });
        input.value = '';
    });
    document.getElementById('question-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = document.getElementById('question-text');
        const text = input.value.trim();
        if (!text) return;
        send({ type: 'question', text: text });
        input.value = '';
    });

    obtainToken()
        .then((token) => {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            socket = new WebSocket(proto + '://' + location.host + '/api/hall/socket?token=' + encodeURIComponent(token));
            socket.binaryType = 'arraybuffer';
            socket.onmessage = (event) => {
                if (typeof event.data !== 'string') {
                    if (role === 'host') return;
                    mime = mime || 'video/webm; codecs="vp8,opus"';
                    ensureMse();
                    chunkQueue.push(event.data);
                    pumpChunks();
                    waitEl.style.display = 'none';
                    return;
                }
                onMessage(event.data);
            };
            socket.onclose = () => {
                if (!errorEl.textContent) waitEl.textContent = 'Disconnected from the hall.';
            };
        })
        .catch((err) => say(err.message));
})();

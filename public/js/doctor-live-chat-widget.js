/**
 * Doctor portal — floating live chat bubble (support agents during business hours).
 */
(function () {
    if (window.DoctorLiveChatWidget) return;

    let getUserId = null;
    let sessionId = null;
    let chatRef = '';
    let agentName = '';
    let msgSince = 0;
    let pollTimer = null;
    let hoursOpen = false;
    let enabled = true;
    let isEnabledFn = null;
    let mounted = false;

    let root = null;
    let panel = null;
    let messagesEl = null;
    let hoursEl = null;
    let metaEl = null;
    let inputRow = null;
    let startBtn = null;
    let inputEl = null;
    let launcher = null;

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function storageKey() {
        const uid = getUserId && getUserId();
        return uid ? 'vgmf_doctor_live_' + uid : 'vgmf_doctor_live';
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(pollMessages, 3000);
    }

    function updateMeta() {
        if (!metaEl) return;
        if (!sessionId) {
            metaEl.classList.add('hidden');
            return;
        }
        metaEl.classList.remove('hidden');
        metaEl.innerHTML =
            'Ref: <strong>' +
            esc(chatRef || 'LCHAT-' + String(sessionId)) +
            '</strong>' +
            (agentName ? ' · Agent: <strong>' + esc(agentName) + '</strong>' : ' · Waiting for agent…');
    }

    function renderMessage(m) {
        const st = String(m.sender_type || '').toLowerCase();
        const isSelf = st === 'visitor';
        const isSystem = st === 'system';
        const label = isSystem ? 'Support desk' : m.sender_name || (isSelf ? 'You' : 'Support agent');
        const bg = isSystem ? '#fef3c7' : isSelf ? '#0f766e' : '#ecfdf5';
        const color = isSelf ? '#fff' : '#334155';
        const align = isSelf ? 'margin-left:20px;text-align:right;' : '';
        const radius = isSelf ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        const time = m.created_at
            ? new Date(m.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
            : '';
        return (
            '<div style="margin-bottom:8px;padding:10px 12px;background:' +
            bg +
            ';color:' +
            color +
            ';border-radius:' +
            radius +
            ';line-height:1.45;white-space:pre-wrap;' +
            align +
            '">' +
            '<div style="font-size:0.72rem;opacity:0.85;margin-bottom:4px;font-weight:700;">' +
            esc(label) +
            (time ? ' · ' + esc(time) : '') +
            '</div>' +
            esc(m.message || '') +
            '</div>'
        );
    }

    function appendLocalUser(text) {
        if (!messagesEl) return;
        clearPlaceholder();
        messagesEl.innerHTML += renderMessage({ sender_type: 'visitor', sender_name: 'You', message: text });
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessages(rows) {
        if (!messagesEl || !rows || !rows.length) return;
        clearPlaceholder();
        rows.forEach((m) => {
            if (m.id > msgSince) msgSince = m.id;
            if (m.sender_type === 'agent' && m.sender_name) agentName = m.sender_name;
            if (m.sender_type !== 'visitor') {
                messagesEl.innerHTML += renderMessage(m);
            }
        });
        updateMeta();
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearPlaceholder() {
        if (!messagesEl) return;
        const ph = messagesEl.querySelector('[data-live-placeholder]');
        if (ph) messagesEl.innerHTML = '';
    }

    function addSystemNote(html) {
        if (!messagesEl) return;
        clearPlaceholder();
        messagesEl.innerHTML += html;
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function refreshSession() {
        if (!sessionId) return;
        try {
            const res = await fetch('/api/support-ticket/live/' + encodeURIComponent(sessionId), { cache: 'no-store' });
            const session = await res.json();
            if (!res.ok || !session) return;
            chatRef = session.chatRef || chatRef;
            if (session.agentName) agentName = session.agentName;
            if (session.status === 'closed') {
                stopPoll();
                sessionId = null;
                chatRef = '';
                agentName = '';
                msgSince = 0;
                sessionStorage.removeItem(storageKey());
                if (inputRow) inputRow.classList.add('hidden');
                if (startBtn) startBtn.classList.remove('hidden');
                updateMeta();
            } else {
                updateMeta();
            }
        } catch (_) {}
    }

    async function pollMessages() {
        if (!sessionId) return;
        try {
            const res = await fetch(
                '/api/support-ticket/live/' + encodeURIComponent(sessionId) + '/messages?since=' + msgSince,
                { cache: 'no-store' }
            );
            const rows = await res.json();
            if (!res.ok) return;
            appendMessages(rows);
            await refreshSession();
        } catch (_) {}
    }

    async function loadHours() {
        try {
            const h = await fetch('/api/public/support/hours', { cache: 'no-store' }).then((r) => r.json());
            hoursOpen = !!(h.openNow && h.liveChatEnabled);
            if (hoursEl) {
                hoursEl.textContent = hoursOpen
                    ? 'Support agents available now'
                    : 'Outside live chat hours — messages are queued for agents';
            }
        } catch (_) {
            if (hoursEl) hoursEl.textContent = 'Chat with our support team';
        }
    }

    async function restoreSession() {
        const saved = sessionStorage.getItem(storageKey());
        if (!saved) return;
        try {
            const parsed = JSON.parse(saved);
            if (!parsed || !parsed.sessionId) return;
            sessionId = parsed.sessionId;
            chatRef = parsed.chatRef || '';
            agentName = parsed.agentName || '';
            msgSince = 0;
            if (inputRow) inputRow.classList.remove('hidden');
            if (startBtn) startBtn.classList.add('hidden');
            updateMeta();
            await pollMessages();
            startPoll();
        } catch (_) {
            sessionStorage.removeItem(storageKey());
        }
    }

    async function startChat() {
        const uid = getUserId && getUserId();
        if (!uid) return alert('Session expired. Please sign in again.');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = 'Connecting…';
        }
        try {
            const res = await fetch('/api/support-ticket/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: uid, message: 'Hello, I need help from the doctor portal.' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error((data && data.error) || 'Could not start live chat');
            sessionId = data.sessionId;
            chatRef = data.chatRef || '';
            agentName = data.agentName || '';
            msgSince = 0;
            sessionStorage.setItem(
                storageKey(),
                JSON.stringify({ sessionId: sessionId, chatRef: chatRef, agentName: agentName })
            );
            if (messagesEl) messagesEl.innerHTML = '';
            updateMeta();
            if (inputRow) inputRow.classList.remove('hidden');
            if (startBtn) startBtn.classList.add('hidden');
            if (data.status === 'offline' || !data.canLive) {
                addSystemNote(
                    '<p data-live-placeholder style="color:#92400e;background:#fef3c7;padding:10px;border-radius:8px;font-size:0.85rem;margin:0;">Outside business hours. Your message is saved — an agent will follow up. Use Support tickets for formal requests.</p>'
                );
            } else if (data.status === 'waiting') {
                addSystemNote(
                    '<p style="color:#0369a1;background:#e0f2fe;padding:10px;border-radius:8px;font-size:0.85rem;margin:0;">In queue — reference <strong>' +
                        esc(chatRef) +
                        '</strong>. An agent will join shortly.</p>'
                );
            } else if (data.status === 'active') {
                addSystemNote(
                    '<p style="color:#065f46;background:#d1fae5;padding:10px;border-radius:8px;font-size:0.85rem;margin:0;">Connected' +
                        (agentName ? ' with <strong>' + esc(agentName) + '</strong>' : '') +
                        '. Reference <strong>' +
                        esc(chatRef) +
                        '</strong>.</p>'
                );
            }
            startPoll();
            pollMessages();
        } catch (err) {
            alert(err.message || 'Could not start live chat');
        } finally {
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="fas fa-headset"></i> Talk to support agent';
            }
        }
    }

    async function sendMessage() {
        const msg = (inputEl && inputEl.value.trim()) || '';
        if (!msg) return;
        const uid = getUserId && getUserId();
        if (!uid) return alert('Session expired.');
        if (!sessionId) {
            if (inputEl) inputEl.value = '';
            return startChat();
        }
        appendLocalUser(msg);
        if (inputEl) inputEl.value = '';
        try {
            const res = await fetch('/api/support-ticket/live/' + encodeURIComponent(sessionId) + '/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: uid, message: msg })
            });
            const data = await res.json();
            if (!res.ok) throw new Error((data && data.error) || 'Send failed');
            pollMessages();
        } catch (err) {
            alert(err.message || 'Could not send message');
        }
    }

    function mount() {
        if (mounted || document.getElementById('vgmf-doctor-live-root')) return;
        mounted = true;
        root = document.createElement('div');
        root.id = 'vgmf-doctor-live-root';
        root.innerHTML =
            '<button type="button" id="vgmf-doctor-live-launcher" aria-label="Open live chat" style="position:fixed;bottom:22px;right:22px;z-index:10050;width:56px;height:56px;border-radius:50%;border:none;background:#0f766e;color:#fff;box-shadow:0 8px 24px rgba(15,118,110,0.35);cursor:pointer;font-size:1.35rem;"><i class="fas fa-comments"></i></button>' +
            '<div id="vgmf-doctor-live-panel" class="hidden" style="position:fixed;bottom:90px;right:22px;z-index:10051;width:min(380px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 16px 40px rgba(15,23,42,0.18);border:1px solid #99f6e4;display:flex;flex-direction:column;overflow:hidden;">' +
            '<div style="padding:14px 16px;background:linear-gradient(135deg,#0f766e,#115e59);color:#fff;"><strong>Live chat</strong><div id="vgmf-doctor-live-hours" style="font-size:0.78rem;opacity:0.9;margin-top:4px;">Loading…</div><div id="vgmf-doctor-live-meta" class="hidden" style="font-size:0.72rem;opacity:0.92;margin-top:6px;"></div></div>' +
            '<div id="vgmf-doctor-live-messages" style="flex:1;overflow-y:auto;padding:12px;font-size:0.88rem;background:#f8fafc;min-height:180px;"><p data-live-placeholder style="color:#64748b;text-align:center;margin:40px 0;font-size:0.88rem;">Tap below to connect with a support agent.</p></div>' +
            '<div style="padding:10px 12px;border-top:1px solid #e2e8f0;background:#fff;">' +
            '<button type="button" id="vgmf-doctor-live-start" style="width:100%;margin-bottom:8px;padding:8px;border:none;border-radius:8px;background:#115e59;color:#fff;font-weight:700;cursor:pointer;"><i class="fas fa-headset"></i> Talk to support agent</button>' +
            '<div id="vgmf-doctor-live-input-row" class="hidden" style="display:flex;gap:8px;margin-bottom:6px;"><input type="text" id="vgmf-doctor-live-input" placeholder="Type your message…" style="flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.85rem;"><button type="button" id="vgmf-doctor-live-send" style="padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Send</button></div>' +
            '<p style="font-size:0.72rem;color:#64748b;margin:0;">Formal requests: <a href="#" id="vgmf-doctor-live-tickets-link" style="color:#0f766e;font-weight:600;">Support tickets</a></p></div></div>';
        document.body.appendChild(root);

        panel = document.getElementById('vgmf-doctor-live-panel');
        messagesEl = document.getElementById('vgmf-doctor-live-messages');
        hoursEl = document.getElementById('vgmf-doctor-live-hours');
        metaEl = document.getElementById('vgmf-doctor-live-meta');
        inputRow = document.getElementById('vgmf-doctor-live-input-row');
        startBtn = document.getElementById('vgmf-doctor-live-start');
        inputEl = document.getElementById('vgmf-doctor-live-input');
        launcher = document.getElementById('vgmf-doctor-live-launcher');

        launcher.addEventListener('click', function () {
            panel.classList.toggle('hidden');
        });
        startBtn.addEventListener('click', startChat);
        document.getElementById('vgmf-doctor-live-send').addEventListener('click', sendMessage);
        inputEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') sendMessage();
        });
        document.getElementById('vgmf-doctor-live-tickets-link').addEventListener('click', function (ev) {
            ev.preventDefault();
            panel.classList.add('hidden');
            if (typeof window.switchTab === 'function') window.switchTab('tab-support');
        });
    }

    async function init() {
        if (!mounted) mount();
        await loadHours();
        await restoreSession();
        setEnabled(enabled);
    }

    function boot(opts) {
        getUserId = opts && opts.getUserId;
        isEnabledFn = opts && opts.isEnabled;
        enabled = isEnabledFn ? isEnabledFn() : true;
        mount();
        init();
    }

    function setEnabled(on) {
        enabled = typeof on === 'function' ? !!on() : !!on;
        if (!root) return;
        root.style.display = enabled ? '' : 'none';
    }

    window.DoctorLiveChatWidget = { boot: boot, setEnabled: setEnabled, stopPoll: stopPoll };
})();

/**
 * Public website support widget — FAQs, application tracking, live chat (polling).
 */
(function () {
    if (document.getElementById('vgmf-support-widget-root')) return;

    let liveSessionId = null;
    let liveChatRef = '';
    let liveAgentName = '';
    let liveMsgSince = 0;
    let livePollTimer = null;
    let liveChatOpen = false;
    let visitorKey = localStorage.getItem('vgmf_support_visitor') || '';
    if (!visitorKey) {
        visitorKey = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('vgmf_support_visitor', visitorKey);
    }

    const root = document.createElement('div');
    root.id = 'vgmf-support-widget-root';
    root.innerHTML =
        '<button type="button" id="vgmf-support-launcher" aria-label="Open support chat" style="position:fixed;bottom:22px;right:22px;z-index:9998;width:56px;height:56px;border-radius:50%;border:none;background:#0f766e;color:#fff;box-shadow:0 8px 24px rgba(15,118,110,0.35);cursor:pointer;font-size:1.4rem;"><i class="fas fa-headset"></i></button>' +
        '<div id="vgmf-support-panel" class="hidden" style="position:fixed;bottom:90px;right:22px;z-index:9999;width:min(380px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 16px 40px rgba(15,23,42,0.18);border:1px solid #ccfbf1;display:flex;flex-direction:column;overflow:hidden;">' +
        '<div style="padding:14px 16px;background:linear-gradient(135deg,#0f766e,#115e59);color:#fff;"><strong>Help & support</strong><div id="vgmf-support-hours" style="font-size:0.78rem;opacity:0.9;margin-top:4px;">Loading hours…</div><div id="vgmf-support-live-meta" class="hidden" style="font-size:0.72rem;opacity:0.92;margin-top:6px;"></div></div>' +
        '<div id="vgmf-support-messages" style="flex:1;overflow-y:auto;padding:12px;font-size:0.88rem;background:#f8fafc;"></div>' +
        '<div style="padding:10px 12px;border-top:1px solid #e2e8f0;background:#fff;">' +
        '<button type="button" id="vgmf-support-live-btn" class="hidden" style="width:100%;margin-bottom:8px;padding:8px;border:none;border-radius:8px;background:#115e59;color:#fff;font-weight:700;cursor:pointer;">Talk to a support agent (live)</button>' +
        '<input type="text" id="vgmf-support-track" placeholder="Application / ticket no. (optional)" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;font-size:0.85rem;">' +
        '<div style="display:flex;gap:8px;"><input type="text" id="vgmf-support-input" placeholder="Ask a question…" style="flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.85rem;"><button type="button" id="vgmf-support-send" style="padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Send</button></div>' +
        '<p style="font-size:0.72rem;color:#64748b;margin:8px 0 0;">Account help: <a href="/doctor.html#tab-live-chat" style="color:#0f766e;">Live chat</a> or <a href="/doctor.html#tab-support" style="color:#0f766e;">Support tickets</a> in the doctor portal.</p></div></div>';

    document.body.appendChild(root);

    const panel = document.getElementById('vgmf-support-panel');
    const messages = document.getElementById('vgmf-support-messages');
    const hoursEl = document.getElementById('vgmf-support-hours');
    const liveMetaEl = document.getElementById('vgmf-support-live-meta');
    const liveBtn = document.getElementById('vgmf-support-live-btn');

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function updateLiveMeta() {
        if (!liveMetaEl) return;
        if (!liveSessionId) {
            liveMetaEl.classList.add('hidden');
            return;
        }
        liveMetaEl.classList.remove('hidden');
        liveMetaEl.innerHTML =
            'Ref: <strong>' +
            esc(liveChatRef || 'LCHAT-' + String(liveSessionId).padStart(8, '0')) +
            '</strong>' +
            (liveAgentName ? ' · Agent: <strong>' + esc(liveAgentName) + '</strong>' : '');
    }

    function appendMessage(opts) {
        const isUser = opts.role === 'user';
        const isSystem = opts.role === 'system';
        const label = opts.label || (isUser ? 'You' : isSystem ? 'Support desk' : 'Assistant');
        const bg = isUser ? '#e2e8f0' : isSystem ? '#fef3c7' : '#ecfdf5';
        const align = isUser ? 'margin-left:24px;text-align:right;' : '';
        const radius = isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        messages.innerHTML +=
            '<div style="margin-bottom:10px;padding:10px 12px;background:' +
            bg +
            ';border-radius:' +
            radius +
            ';line-height:1.45;white-space:pre-wrap;' +
            align +
            '">' +
            (isUser ? '' : '<div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;font-weight:700;">' + esc(label) + '</div>') +
            esc(opts.text) +
            '</div>';
        messages.scrollTop = messages.scrollHeight;
    }

    function addBot(text, label) {
        appendMessage({ role: 'bot', text: text, label: label || 'Assistant' });
    }

    function addUser(text) {
        appendMessage({ role: 'user', text: text });
    }

    function addLiveMessage(m) {
        const st = String(m.sender_type || '').toLowerCase();
        if (st === 'visitor') return;
        if (st === 'agent' && m.sender_name) liveAgentName = m.sender_name;
        appendMessage({
            role: st === 'system' ? 'system' : 'bot',
            text: m.message,
            label: m.sender_name || (st === 'system' ? 'Support desk' : 'Support agent')
        });
        updateLiveMeta();
    }

    function startLivePoll() {
        if (livePollTimer) clearInterval(livePollTimer);
        livePollTimer = setInterval(pollLiveMessages, 3000);
    }

    async function refreshLiveSession() {
        if (!liveSessionId) return;
        try {
            const session = await fetch('/api/public/support/live/' + encodeURIComponent(liveSessionId), {
                cache: 'no-store'
            }).then((r) => r.json());
            if (session && session.chatRef) liveChatRef = session.chatRef;
            if (session && session.agentName) liveAgentName = session.agentName;
            if (session && session.status === 'closed') {
                clearInterval(livePollTimer);
                livePollTimer = null;
                liveBtn.classList.remove('hidden');
                liveBtn.textContent = 'Start a new live chat';
            }
            updateLiveMeta();
        } catch (_) {}
    }

    async function pollLiveMessages() {
        if (!liveSessionId) return;
        try {
            const rows = await fetch(
                '/api/public/support/live/' + liveSessionId + '/messages?since=' + liveMsgSince,
                { cache: 'no-store' }
            ).then((r) => r.json());
            (rows || []).forEach((m) => {
                if (m.id > liveMsgSince) liveMsgSince = m.id;
                addLiveMessage(m);
            });
            await refreshLiveSession();
        } catch (_) {}
    }

    async function startLiveChat(initialMessage) {
        try {
            const res = await fetch('/api/public/support/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorKey, message: initialMessage || 'Hello, I need help.' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not start live chat');
            liveSessionId = data.sessionId;
            liveChatRef = data.chatRef || '';
            liveAgentName = data.agentName || '';
            liveMsgSince = 0;
            updateLiveMeta();
            if (data.status === 'offline' || !data.canLive) {
                addBot(
                    'Live chat is outside business hours. You can still ask questions here or email care@vaidyagogate.org. Your chat reference is ' +
                        (liveChatRef || '') +
                        '.'
                );
                return;
            }
            if (data.status === 'waiting') {
                addBot(
                    'You are in the queue. Chat reference ' +
                        liveChatRef +
                        '. An agent will join shortly — please keep this window open.',
                    'Support desk'
                );
            } else if (data.status === 'active') {
                addBot(
                    'Connected' +
                        (liveAgentName ? ' with ' + liveAgentName : ' with a support agent') +
                        '. Reference ' +
                        liveChatRef +
                        '.',
                    'Support desk'
                );
            }
            startLivePoll();
        } catch (e) {
            addBot('Could not start live chat. Try Live chat in the doctor portal or create a Support ticket.');
        }
    }

    document.getElementById('vgmf-support-launcher').addEventListener('click', function () {
        panel.classList.toggle('hidden');
    });

    liveBtn.addEventListener('click', function () {
        liveBtn.classList.add('hidden');
        startLiveChat();
    });

    fetch('/api/public/support/hours', { cache: 'no-store' })
        .then((r) => r.json())
        .then((h) => {
            liveChatOpen = !!(h.openNow && h.liveChatEnabled);
            hoursEl.textContent = liveChatOpen
                ? 'Live support hours — agents available now'
                : 'Outside live chat hours — FAQs and tracking still work';
            if (liveChatOpen) liveBtn.classList.remove('hidden');
        })
        .catch(() => {
            hoursEl.textContent = 'Ask about seminars, registration, payments, or case presentation';
        });

    fetch('/api/public/support/faqs', { cache: 'no-store' })
        .then((r) => r.json())
        .then((data) => {
            addBot(
                'Hello! I can answer common questions, track an application number (seminar, case, or support ticket), or connect you with an agent during support hours.'
            );
            if (data.faqs && data.faqs.length) {
                addBot('Popular questions:\n• ' + data.faqs.slice(0, 4).map((f) => f.q).join('\n• '));
            }
        })
        .catch(() => addBot('Hello! How can we help you today?'));

    async function sendMessage() {
        const input = document.getElementById('vgmf-support-input');
        const track = document.getElementById('vgmf-support-track').value.trim();
        const text = input.value.trim();
        if (!text) return;
        addUser(text);
        input.value = '';

        if (/live chat|talk to (a )?human|talk to agent|support agent/i.test(text) && liveChatOpen) {
            liveBtn.classList.add('hidden');
            return startLiveChat(text);
        }

        if (liveSessionId) {
            try {
                await fetch('/api/public/support/live/' + liveSessionId + '/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
                });
                pollLiveMessages();
            } catch (_) {
                addBot('Message not sent. Please try again.');
            }
            return;
        }

        try {
            const appMatch = text.match(/\b(SEM-[\w-]+|CASE-[\w-]+|TKT_[\w-]+|LCHAT-[\d]+|\d{6,})\b/i);
            const trackRef = track || (appMatch && appMatch[1]);
            if (trackRef && /track|status|application|where|check/i.test(text)) {
                const tr = await fetch('/api/public/support/track?q=' + encodeURIComponent(trackRef)).then((r) =>
                    r.json()
                );
                if (tr.error) addBot(tr.error);
                else if (tr.type === 'seminar')
                    addBot(
                        'Seminar application ' +
                            tr.applicationNo +
                            ': ' +
                            tr.status +
                            (tr.seminarTitle ? ' (' + tr.seminarTitle + ')' : '') +
                            '. Sign in to the doctor portal for full details.'
                    );
                else if (tr.type === 'case')
                    addBot('Case submission ' + tr.applicationNo + ': ' + tr.status + '.');
                else if (tr.type === 'support_ticket')
                    addBot('Support ticket ' + tr.ticketRef + ': ' + tr.status + '.');
                else addBot(JSON.stringify(tr));
                return;
            }
            const res = await fetch('/api/public/support/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, applicationNo: trackRef || undefined })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            addBot(data.reply);
            if (data.liveChatAvailable && liveChatOpen) {
                addBot('Tap "Talk to a support agent" below to chat live with our team.');
                liveBtn.classList.remove('hidden');
            }
        } catch (e) {
            addBot('Sorry, something went wrong. Email care@vaidyagogate.org or use Live chat / Support tickets in the doctor portal.');
        }
    }

    document.getElementById('vgmf-support-send').addEventListener('click', sendMessage);
    document.getElementById('vgmf-support-input').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') sendMessage();
    });
})();

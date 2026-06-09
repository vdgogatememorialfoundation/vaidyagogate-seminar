/**
 * Public website support widget — FAQs, application tracking, live chat (polling).
 */
(function () {
    if (document.getElementById('vgmf-support-widget-root')) return;

    let liveSessionId = null;
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
        '<div style="padding:14px 16px;background:linear-gradient(135deg,#0f766e,#115e59);color:#fff;"><strong>Help & support</strong><div id="vgmf-support-hours" style="font-size:0.78rem;opacity:0.9;margin-top:4px;">Loading hours…</div></div>' +
        '<div id="vgmf-support-messages" style="flex:1;overflow-y:auto;padding:12px;font-size:0.88rem;background:#f8fafc;"></div>' +
        '<div style="padding:10px 12px;border-top:1px solid #e2e8f0;background:#fff;">' +
        '<button type="button" id="vgmf-support-live-btn" class="hidden" style="width:100%;margin-bottom:8px;padding:8px;border:none;border-radius:8px;background:#115e59;color:#fff;font-weight:700;cursor:pointer;">Talk to a support agent (live)</button>' +
        '<input type="text" id="vgmf-support-track" placeholder="Application / ticket no. (optional)" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;font-size:0.85rem;">' +
        '<div style="display:flex;gap:8px;"><input type="text" id="vgmf-support-input" placeholder="Ask a question…" style="flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.85rem;"><button type="button" id="vgmf-support-send" style="padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">Send</button></div>' +
        '<p style="font-size:0.72rem;color:#64748b;margin:8px 0 0;">For account-specific help, sign in to the <a href="/doctor.html">doctor portal</a>.</p></div></div>';

    document.body.appendChild(root);

    const panel = document.getElementById('vgmf-support-panel');
    const messages = document.getElementById('vgmf-support-messages');
    const hoursEl = document.getElementById('vgmf-support-hours');
    const liveBtn = document.getElementById('vgmf-support-live-btn');

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function addBot(text) {
        messages.innerHTML +=
            '<div style="margin-bottom:10px;padding:10px 12px;background:#ecfdf5;border-radius:12px 12px 12px 4px;line-height:1.45;white-space:pre-wrap;">' +
            esc(text) +
            '</div>';
        messages.scrollTop = messages.scrollHeight;
    }

    function addUser(text) {
        messages.innerHTML +=
            '<div style="margin-bottom:10px;padding:10px 12px;background:#e2e8f0;border-radius:12px 12px 4px 12px;margin-left:24px;text-align:right;">' +
            esc(text) +
            '</div>';
        messages.scrollTop = messages.scrollHeight;
    }

    function startLivePoll() {
        if (livePollTimer) clearInterval(livePollTimer);
        livePollTimer = setInterval(pollLiveMessages, 3000);
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
                if (m.sender_type === 'agent') addBot(m.message);
            });
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
            liveMsgSince = 0;
            if (data.status === 'offline' || !data.canLive) {
                addBot('Live chat is outside business hours. You can still ask questions here or email care@vaidyagogate.org.');
                return;
            }
            if (data.status === 'waiting') {
                addBot('You are in the queue. An agent will join shortly…');
            } else if (data.status === 'active') {
                addBot('You are connected with a support agent.');
            }
            startLivePoll();
        } catch (e) {
            addBot('Could not start live chat. Try again or use the doctor portal support tab.');
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
            const appMatch = text.match(/\b(SEM-[\w-]+|CASE-[\w-]+|TKT_[\w-]+|\d{6,})\b/i);
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
            addBot('Sorry, something went wrong. Email care@vaidyagogate.org or use the doctor portal support tab.');
        }
    }

    document.getElementById('vgmf-support-send').addEventListener('click', sendMessage);
    document.getElementById('vgmf-support-input').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') sendMessage();
    });
})();

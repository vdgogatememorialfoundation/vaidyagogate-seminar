/**
 * Dedicated 1-to-1 live chat page for main-site visitors (no doctor account).
 * Resume via ?ref=LCHAT-384729105638&vk=visitor_key
 */
(function () {
    const VK_KEY = 'vgmf_support_visitor';
    let visitorKey = localStorage.getItem(VK_KEY) || '';
    if (!visitorKey) {
        visitorKey = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(VK_KEY, visitorKey);
    }

    let sessionId = null;
    let chatRef = '';
    let agentName = '';
    let msgSince = 0;
    let pollTimer = null;
    let contactFormShown = false;

    const params = new URLSearchParams(window.location.search);
    const urlRef = params.get('ref') || params.get('livechat') || '';
    const urlVk = params.get('vk') || '';
    if (urlVk) {
        visitorKey = urlVk;
        localStorage.setItem(VK_KEY, visitorKey);
    }

    const startPanel = document.getElementById('start-panel');
    const chatActive = document.getElementById('chat-active');
    const messagesEl = document.getElementById('chat-messages');
    const metaEl = document.getElementById('chat-meta');
    const guestLinkBox = document.getElementById('guest-link-box');
    const contactPanel = document.getElementById('contact-panel');
    const contactStatus = document.getElementById('contact-status');

    function sessionApiKey() {
        return encodeURIComponent(chatRef || String(sessionId || ''));
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function linkify(text) {
        return esc(text).replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener" style="color:#0f766e;word-break:break-all;">$1</a>'
        );
    }

    function showChatUi() {
        startPanel.classList.add('hidden');
        chatActive.classList.remove('hidden');
        chatActive.style.display = 'flex';
    }

    function updateMeta() {
        if (!metaEl) return;
        let html = '';
        if (chatRef) html += 'Ref: <strong>' + esc(chatRef) + '</strong>';
        if (agentName) html += (html ? ' · ' : '') + 'Agent: <strong>' + esc(agentName) + '</strong>';
        metaEl.innerHTML = html;
    }

    function showGuestLink(url) {
        if (!guestLinkBox || !url) return;
        guestLinkBox.classList.remove('hidden');
        guestLinkBox.innerHTML =
            '<strong>Your personal chat link</strong> — bookmark or open on another device:<br>' + linkify(url);
    }

    function appendMsg(opts) {
        const isUser = opts.role === 'user';
        const isSystem = opts.role === 'system';
        const label = opts.label || (isSystem ? 'Support desk' : 'Support agent');
        const cls = isUser ? 'msg msg-user' : isSystem ? 'msg msg-system' : 'msg msg-bot';
        const div = document.createElement('div');
        div.className = cls;
        if (!isUser) {
            div.innerHTML = '<div class="msg-label">' + esc(label) + '</div>' + linkify(opts.text);
        } else {
            div.textContent = opts.text;
        }
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showContactForm(session) {
        if (contactFormShown || !contactPanel) return;
        contactFormShown = true;
        contactPanel.style.display = 'block';
        const ref = session.chatRef || chatRef || '';
        const sub = document.getElementById('cf-subject');
        const msg = document.getElementById('cf-message');
        if (sub) sub.value = 'Live chat follow-up' + (ref ? ' ' + ref : '');
        if (msg && !msg.value) {
            msg.value =
                'I waited for a support agent during live chat ' +
                ref +
                ' but did not receive a reply within 5 minutes.\n\n';
        }
    }

    async function refreshSession() {
        if (!sessionId) return null;
        try {
            const session = await fetch('/api/public/support/live/' + sessionApiKey(), {
                cache: 'no-store'
            }).then((r) => r.json());
            if (session.chatRef) chatRef = session.chatRef;
            if (session.agentName) agentName = session.agentName;
            updateMeta();
            if (session.guestChatUrl) showGuestLink(session.guestChatUrl);
            if (session.needsContactForm) showContactForm(session);
            if (session.status === 'closed') {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            return session;
        } catch (_) {
            return null;
        }
    }

    function addLiveRow(m) {
        const st = String(m.sender_type || '').toLowerCase();
        if (st === 'visitor') return;
        if (st === 'agent' && m.sender_name) agentName = m.sender_name;
        appendMsg({
            role: st === 'system' ? 'system' : 'bot',
            text: m.message,
            label: m.sender_name || (st === 'system' ? 'Support desk' : 'Support agent')
        });
        updateMeta();
        if (
            (st === 'system' || st === 'agent') &&
            /contact form|personal support page|share your full name/i.test(m.message || '')
        ) {
            showContactForm({ chatRef });
        }
    }

    async function pollMessages() {
        if (!sessionId) return;
        try {
            const rows = await fetch(
                '/api/public/support/live/' + sessionApiKey() + '/messages?since=' + msgSince,
                { cache: 'no-store' }
            ).then((r) => r.json());
            (rows || []).forEach((m) => {
                if (m.id > msgSince) msgSince = m.id;
                addLiveRow(m);
            });
            await refreshSession();
        } catch (_) {}
    }

    function startPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollMessages, 3000);
    }

    async function startChat(initialMessage) {
        try {
            const res = await fetch('/api/public/support/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorKey, message: initialMessage || 'Hello, I need help from the website.' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not start chat');
            sessionId = data.sessionId;
            chatRef = data.chatRef || '';
            agentName = data.agentName || '';
            msgSince = 0;
            messagesEl.innerHTML = '';
            showChatUi();
            updateMeta();
            if (data.guestChatUrl) showGuestLink(data.guestChatUrl);
            if (data.status === 'waiting') {
                appendMsg({
                    role: 'system',
                    text:
                        'You are in the queue. Reference ' +
                        chatRef +
                        '. An agent will join shortly — keep this page open. Your personal link is shown above.'
                });
            } else if (data.status === 'active') {
                appendMsg({
                    role: 'system',
                    text:
                        'Connected' +
                        (agentName ? ' with ' + agentName : '') +
                        '. Reference ' +
                        chatRef +
                        '.'
                });
            } else if (data.status === 'offline') {
                appendMsg({
                    role: 'system',
                    text: 'Live chat is outside business hours. Leave a message below or use the contact form when it appears.'
                });
            }
            startPoll();
            pollMessages();
        } catch (e) {
            alert(e.message || 'Could not start chat. Try the contact form on the main site.');
        }
    }

    async function resumeChat() {
        try {
            const res = await fetch('/api/public/support/live/resume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorKey, chatRef: urlRef })
            });
            const session = await res.json();
            if (!res.ok) throw new Error(session.error || 'Could not open chat');
            sessionId = session.sessionId;
            chatRef = session.chatRef || '';
            agentName = session.agentName || '';
            msgSince = 0;
            messagesEl.innerHTML = '';
            showChatUi();
            updateMeta();
            if (session.guestChatUrl) showGuestLink(session.guestChatUrl);
            const rows = await fetch('/api/public/support/live/' + sessionApiKey() + '/messages?since=0', {
                cache: 'no-store'
            }).then((r) => r.json());
            (rows || []).forEach((m) => {
                if (m.id > msgSince) msgSince = m.id;
                if (String(m.sender_type).toLowerCase() === 'visitor') {
                    appendMsg({ role: 'user', text: m.message });
                } else {
                    addLiveRow(m);
                }
            });
            if (session.needsContactForm) showContactForm(session);
            startPoll();
        } catch (e) {
            startPanel.innerHTML =
                '<p style="color:#b91c1c;">' +
                esc(e.message || 'Invalid chat link') +
                '</p><button type="button" id="btn-start-chat">Start new chat</button>';
            document.getElementById('btn-start-chat').addEventListener('click', () => startChat());
        }
    }

    async function sendMessage() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text || !sessionId) return;
        appendMsg({ role: 'user', text });
        input.value = '';
        try {
            await fetch('/api/public/support/live/' + sessionApiKey() + '/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, visitorKey })
            });
            pollMessages();
        } catch (_) {
            appendMsg({ role: 'system', text: 'Message not sent. Please try again.' });
        }
    }

    async function submitContactForm() {
        const payload = {
            visitorKey,
            name: document.getElementById('cf-name').value.trim(),
            email: document.getElementById('cf-email').value.trim(),
            phone: document.getElementById('cf-phone').value.trim(),
            subject: document.getElementById('cf-subject').value.trim(),
            message: document.getElementById('cf-message').value.trim()
        };
        if (typeof validateEmailClient === 'function') {
            const ev = validateEmailClient(payload.email, 'Email');
            if (!ev.valid) return alert(ev.message);
            payload.email = ev.cleanedEmail;
        }
        if (typeof validatePhoneClient === 'function') {
            const pv = validatePhoneClient(payload.phone, 'Phone', { required: true });
            if (!pv.valid) return alert(pv.message);
            payload.phone = pv.cleanedPhone;
        }
        if (!payload.name || !payload.email || !payload.phone || !payload.message) {
            return alert('Please fill full name, email, phone, and issue description.');
        }
        contactStatus.textContent = 'Sending…';
        contactStatus.style.color = '#64748b';
        try {
            const res = await fetch('/api/public/support/live/' + sessionApiKey() + '/contact-form', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not send');
            contactStatus.style.color = '#059669';
            contactStatus.textContent = 'Sent! Reference ' + (data.inquiryRef || '') + '. You can keep chatting here.';
            contactPanel.querySelector('button').disabled = true;
            pollMessages();
        } catch (e) {
            contactStatus.style.color = '#b91c1c';
            contactStatus.textContent = e.message || 'Could not send. Try again.';
        }
    }

    document.getElementById('btn-start-chat')?.addEventListener('click', () => startChat());
    document.getElementById('chat-send')?.addEventListener('click', sendMessage);
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('cf-submit')?.addEventListener('click', submitContactForm);

    if (urlRef && urlVk) {
        resumeChat();
    }
})();

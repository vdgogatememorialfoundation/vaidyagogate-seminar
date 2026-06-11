/**
 * Public website support widget — FAQs, application tracking, live chat (polling).
 */
(function () {
    if (document.getElementById('vgmf-support-widget-root')) return;

    function t(key) {
        const fallbacks = {
            'support.title': 'Help & support',
            'support.hoursLoading': 'Loading hours…',
            'support.liveAgent': 'Talk to a support agent (live)',
            'support.fullScreenChat': 'Open full-screen 1-to-1 chat page',
            'support.trackPlaceholder': 'Application / ticket no. (optional)',
            'support.askPlaceholder': 'Ask a question…',
            'support.send': 'Send',
            'support.contactTitle': 'Send us your details',
            'support.contactHint': 'Share your name, email, phone, and issue so our team can follow up.',
            'support.fullName': 'Full name',
            'support.phone': 'Phone number',
            'support.describeIssue': 'Describe your issue',
            'support.sendTeam': 'Send to support team',
            'support.openChat': 'Open support chat',
            'support.you': 'You',
            'support.assistant': 'Assistant',
            'support.desk': 'Support desk'
        };
        return fallbacks[key] || key;
    }

    let liveSessionId = null;
    let liveChatRef = '';
    let liveAgentName = '';
    let liveGuestUrl = '';
    let liveMsgSince = 0;
    let livePollTimer = null;
    let liveChatOpen = false;
    let hoursLabel = '';
    let contactFormDismissed = false;
    let visitorKey = localStorage.getItem('vgmf_support_visitor') || '';
    if (!visitorKey) {
        visitorKey = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('vgmf_support_visitor', visitorKey);
    }

    const root = document.createElement('div');
    root.id = 'vgmf-support-widget-root';
    root.innerHTML =
        '<button type="button" id="vgmf-support-launcher" aria-label="' +
        t('support.openChat') +
        '" style="position:fixed;bottom:22px;right:22px;z-index:9998;width:56px;height:56px;border-radius:50%;border:none;background:#0f766e;color:#fff;box-shadow:0 8px 24px rgba(15,118,110,0.35);cursor:pointer;font-size:1.4rem;"><i class="fas fa-headset"></i></button>' +
        '<div id="vgmf-support-panel" class="hidden" style="position:fixed;bottom:90px;right:22px;z-index:9999;width:min(380px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 16px 40px rgba(15,23,42,0.18);border:1px solid #ccfbf1;display:flex;flex-direction:column;overflow:hidden;">' +
        '<div style="padding:14px 16px;background:linear-gradient(135deg,#0f766e,#115e59);color:#fff;"><strong id="vgmf-support-title">' +
        t('support.title') +
        '</strong><div id="vgmf-support-hours" style="font-size:0.78rem;opacity:0.9;margin-top:4px;">' +
        t('support.hoursLoading') +
        '</div><div id="vgmf-support-live-meta" class="hidden" style="font-size:0.72rem;opacity:0.92;margin-top:6px;"></div><div id="vgmf-support-guest-link" class="hidden" style="font-size:0.68rem;opacity:0.95;margin-top:6px;word-break:break-all;"></div></div>' +
        '<div id="vgmf-support-messages" style="flex:1;overflow-y:auto;padding:12px;font-size:0.88rem;background:#f8fafc;"></div>' +
        '<div id="vgmf-support-contact-form" class="hidden" style="padding:10px 12px;border-top:1px solid #fde68a;background:#fffbeb;font-size:0.82rem;">' +
        '<strong id="vgmf-cf-title" style="display:block;margin-bottom:6px;">' +
        t('support.contactTitle') +
        '</strong>' +
        '<p id="vgmf-cf-hint" style="margin:0 0 8px;color:#92400e;">' +
        t('support.contactHint') +
        '</p>' +
        '<input type="text" id="vgmf-cf-name" placeholder="' +
        t('support.fullName') +
        '" required style="width:100%;padding:7px 9px;margin-bottom:6px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;">' +
        '<input type="email" id="vgmf-cf-email" placeholder="' +
        t('auth.email') +
        '" required style="width:100%;padding:7px 9px;margin-bottom:6px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;">' +
        '<input type="tel" id="vgmf-cf-phone" placeholder="' +
        t('support.phone') +
        '" required style="width:100%;padding:7px 9px;margin-bottom:6px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;">' +
        '<input type="hidden" id="vgmf-cf-subject" value="">' +
        '<textarea id="vgmf-cf-message" rows="3" placeholder="' +
        t('support.describeIssue') +
        '" required style="width:100%;padding:7px 9px;margin-bottom:6px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;resize:vertical;"></textarea>' +
        '<button type="button" id="vgmf-cf-submit" style="width:100%;padding:8px;border:none;border-radius:6px;background:#115e59;color:#fff;font-weight:700;cursor:pointer;">' +
        t('support.sendTeam') +
        '</button>' +
        '<p id="vgmf-cf-status" style="margin:6px 0 0;font-size:0.75rem;"></p></div>' +
        '<div style="padding:10px 12px;border-top:1px solid #e2e8f0;background:#fff;">' +
        '<button type="button" id="vgmf-support-live-btn" class="hidden" style="width:100%;margin-bottom:8px;padding:8px;border:none;border-radius:8px;background:#115e59;color:#fff;font-weight:700;cursor:pointer;">' +
        t('support.liveAgent') +
        '</button>' +
        '<a href="/live-chat.html" id="vgmf-support-dedicated-link" style="display:block;text-align:center;font-size:0.75rem;color:#0f766e;margin-bottom:8px;">' +
        t('support.fullScreenChat') +
        '</a>' +
        '<input type="text" id="vgmf-support-track" placeholder="' +
        t('support.trackPlaceholder') +
        '" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;font-size:0.85rem;">' +
        '<div style="display:flex;gap:8px;"><input type="text" id="vgmf-support-input" placeholder="' +
        t('support.askPlaceholder') +
        '" style="flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:0.85rem;"><button type="button" id="vgmf-support-send" style="padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">' +
        t('support.send') +
        '</button></div>' +
        '<p style="font-size:0.72rem;color:#64748b;margin:8px 0 0;">Account help: sign in to the <a href="/doctor.html" style="color:#0f766e;">doctor portal</a> (live chat bubble or Support tickets).</p></div></div>';

    document.body.appendChild(root);

    const panel = document.getElementById('vgmf-support-panel');
    const messages = document.getElementById('vgmf-support-messages');
    const hoursEl = document.getElementById('vgmf-support-hours');
    const liveMetaEl = document.getElementById('vgmf-support-live-meta');
    const guestLinkEl = document.getElementById('vgmf-support-guest-link');
    const contactFormEl = document.getElementById('vgmf-support-contact-form');
    const liveBtn = document.getElementById('vgmf-support-live-btn');
    const dedicatedLink = document.getElementById('vgmf-support-dedicated-link');

    function liveSessionApiKey() {
        return encodeURIComponent(liveChatRef || String(liveSessionId || ''));
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function linkStyle(darkBg) {
        return darkBg
            ? 'color:#fef08a;text-decoration:underline;font-weight:700;word-break:break-all;'
            : 'color:#1d4ed8;text-decoration:underline;font-weight:600;word-break:break-all;';
    }

    function linkify(text, darkBg) {
        const style = linkStyle(!!darkBg);
        return esc(text).replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener" style="' + style + '">$1</a>'
        );
    }

    function updateLiveMeta() {
        if (!liveMetaEl) return;
        if (!liveSessionId) {
            liveMetaEl.classList.add('hidden');
            if (guestLinkEl) guestLinkEl.classList.add('hidden');
            return;
        }
        liveMetaEl.classList.remove('hidden');
        liveMetaEl.innerHTML =
            'Ref: <strong>' +
            esc(liveChatRef || '…') +
            '</strong>' +
            (liveAgentName ? ' · Agent: <strong>' + esc(liveAgentName) + '</strong>' : '');
        if (guestLinkEl && liveGuestUrl) {
            guestLinkEl.classList.remove('hidden');
            guestLinkEl.innerHTML =
                '<span style="display:block;margin-top:6px;padding:8px 10px;background:rgba(255,255,255,0.96);color:#0f172a;border-radius:8px;line-height:1.45;">' +
                '<strong style="color:#115e59;font-size:0.7rem;">Your personal chat link</strong> ' +
                '<span style="font-size:0.65rem;color:#64748b;">(bookmark or open on another device)</span><br>' +
                linkify(liveGuestUrl, false) +
                '</span>';
        }
        if (dedicatedLink && liveGuestUrl) {
            dedicatedLink.href = liveGuestUrl;
        }
    }

    function hideContactForm() {
        if (!contactFormEl) return;
        contactFormEl.classList.add('hidden');
    }

    function showContactForm() {
        if (contactFormDismissed || !contactFormEl || !liveSessionId) return;
        contactFormEl.classList.remove('hidden');
        const ref = liveChatRef || '';
        const sub = document.getElementById('vgmf-cf-subject');
        const msg = document.getElementById('vgmf-cf-message');
        if (sub) sub.value = 'Live chat follow-up' + (ref ? ' ' + ref : '');
        if (msg && !msg.value) {
            msg.value =
                'I waited for a support agent during live chat ' +
                ref +
                ' but did not receive a reply within 5 minutes.\n\n';
        }
    }

    function appendMessage(opts) {
        const isUser = opts.role === 'user';
        const isSystem = opts.role === 'system';
        const label =
            opts.label || (isUser ? t('support.you') : isSystem ? t('support.desk') : t('support.assistant'));
        const bg = isUser ? '#e2e8f0' : isSystem ? '#fef3c7' : '#ecfdf5';
        const align = isUser ? 'margin-left:24px;text-align:right;' : '';
        const radius = isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px';
        const bodyHtml = isUser ? esc(opts.text) : linkify(opts.text);
        messages.innerHTML +=
            '<div style="margin-bottom:10px;padding:10px 12px;background:' +
            bg +
            ';border-radius:' +
            radius +
            ';line-height:1.45;white-space:pre-wrap;' +
            align +
            '">' +
            (isUser ? '' : '<div style="font-size:0.72rem;color:#64748b;margin-bottom:4px;font-weight:700;">' + esc(label) + '</div>') +
            bodyHtml +
            '</div>';
        messages.scrollTop = messages.scrollHeight;
    }

    function clientDiagnostics() {
        return window.LiveChatClientInfo && typeof window.LiveChatClientInfo.collect === 'function'
            ? window.LiveChatClientInfo.collect()
            : null;
    }

    function updateHoursUi(h) {
        hoursLabel = (h && h.hoursLabel) || '';
        liveChatOpen = !!(h && h.agentsAvailableNow);
        if (!hoursEl) return;
        if (liveChatOpen) {
            hoursEl.textContent = 'Live agents available now · ' + hoursLabel;
            liveBtn.classList.remove('hidden');
            if (contactFormEl && !liveSessionId) contactFormEl.classList.add('hidden');
        } else {
            hoursEl.textContent =
                'Agents join during: ' + (hoursLabel || 'business hours') + '. Leave your details and we will reach out.';
            liveBtn.classList.add('hidden');
            showOfflineContactForm();
        }
    }

    function showOfflineContactForm() {
        if (!contactFormEl || contactFormDismissed) return;
        contactFormEl.classList.remove('hidden');
        const hint = document.getElementById('vgmf-cf-hint');
        if (hint) {
            hint.textContent =
                'Our support team is offline right now. Share your details and we will contact you during the next live chat window.';
        }
        const sub = document.getElementById('vgmf-cf-subject');
        if (sub && !sub.value) sub.value = 'Website support request (offline hours)';
    }

    function addBot(text, label) {
        appendMessage({ role: 'bot', text: text, label: label || t('support.assistant') });
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
        if (
            !contactFormDismissed &&
            (st === 'system' || st === 'agent') &&
            /contact form|personal support page|share your full name/i.test(m.message || '')
        ) {
            showContactForm();
        }
        updateLiveMeta();
    }

    function startLivePoll() {
        if (livePollTimer) clearInterval(livePollTimer);
        livePollTimer = setInterval(pollLiveMessages, 3000);
    }

    async function refreshLiveSession() {
        if (!liveSessionId) return;
        try {
            const session = await fetch('/api/public/support/live/' + liveSessionApiKey(), {
                cache: 'no-store'
            }).then((r) => r.json());
            if (session && session.chatRef) liveChatRef = session.chatRef;
            if (session && session.agentName) liveAgentName = session.agentName;
            if (session && session.guestChatUrl) liveGuestUrl = session.guestChatUrl;
            if (session && session.needsContactForm) {
                showContactForm();
            } else if (session && session.linkedTicketId) {
                contactFormDismissed = true;
                hideContactForm();
            }
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
                '/api/public/support/live/' + liveSessionApiKey() + '/messages?since=' + liveMsgSince,
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
            if (!liveChatOpen) {
                showOfflineContactForm();
                addBot(
                    'Live chat agents are available during: ' +
                        (hoursLabel || 'scheduled hours') +
                        '. Please use the form below and we will reach out to you.',
                    'Support desk'
                );
                return;
            }
            const res = await fetch('/api/public/support/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    visitorKey,
                    message: initialMessage || 'Hello, I need help.',
                    clientDiagnostics: clientDiagnostics()
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not start live chat');
            liveSessionId = data.sessionId;
            liveChatRef = data.chatRef || '';
            liveAgentName = data.agentName || '';
            liveGuestUrl = data.guestChatUrl || '';
            liveMsgSince = 0;
            contactFormDismissed = false;
            if (contactFormEl) contactFormEl.classList.add('hidden');
            updateLiveMeta();
            if (data.status === 'offline' || !data.canLive) {
                addBot(
                    'Live chat is outside business hours. You can still ask questions here or email care@vaidyagogate.org. Your chat reference is ' +
                        (liveChatRef || '') +
                        '.',
                    'Support desk'
                );
                startLivePoll();
                return;
            }
            if (data.status === 'waiting') {
                addBot(
                    'You are in the queue. Chat reference ' +
                        liveChatRef +
                        '. An agent will join shortly — please keep this window open.',
                    'Support desk'
                );
            }
            startLivePoll();
            pollLiveMessages();
        } catch (e) {
            addBot('Could not start live chat. Try the full-screen chat at /live-chat.html or email care@vaidyagogate.org.');
        }
    }

    async function submitContactForm() {
        const statusEl = document.getElementById('vgmf-cf-status');
        const payload = {
            visitorKey,
            name: document.getElementById('vgmf-cf-name').value.trim(),
            email: document.getElementById('vgmf-cf-email').value.trim(),
            phone: document.getElementById('vgmf-cf-phone').value.trim(),
            subject: document.getElementById('vgmf-cf-subject').value.trim(),
            message: document.getElementById('vgmf-cf-message').value.trim()
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
        if (statusEl) statusEl.textContent = 'Sending…';
        try {
            let res;
            let data;
            if (liveSessionId) {
                res = await fetch('/api/public/support/live/' + liveSessionApiKey() + '/contact-form', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                data = await res.json();
            } else {
                res = await fetch('/api/public/contact-inquiry', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                data = await res.json();
            }
            if (!res.ok) throw new Error(data.error || 'Could not send');
            const refLabel = data.ticketRef || data.inquiryRef || '';
            if (liveSessionId) {
                contactFormDismissed = true;
                hideContactForm();
                appendMessage({
                    role: 'system',
                    text:
                        'Thank you — your details were sent' +
                        (refLabel ? ' (' + refLabel + ')' : '') +
                        '. You can keep chatting here while our team follows up by email.',
                    label: 'Support desk'
                });
                pollLiveMessages();
            } else {
                contactFormDismissed = true;
                hideContactForm();
                appendMessage({
                    role: 'system',
                    text: 'Thank you! Our team will contact you during the next live chat window.',
                    label: 'Support desk'
                });
            }
        } catch (e) {
            if (statusEl) {
                statusEl.style.color = '#b91c1c';
                statusEl.textContent = e.message || 'Could not send.';
            }
        }
    }

    document.getElementById('vgmf-support-launcher').addEventListener('click', function () {
        panel.classList.toggle('hidden');
    });

    liveBtn.addEventListener('click', function () {
        liveBtn.classList.add('hidden');
        startLiveChat();
    });

    document.getElementById('vgmf-cf-submit')?.addEventListener('click', submitContactForm);

    fetch('/api/public/support/hours', { cache: 'no-store' })
        .then((r) => r.json())
        .then((h) => updateHoursUi(h))
        .catch(() => {
            if (hoursEl) hoursEl.textContent = 'Ask about seminars, registration, payments, or case presentation';
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

        if (/live chat|talk to (a )?human|talk to agent|support agent/i.test(text)) {
            liveBtn.classList.add('hidden');
            return startLiveChat(text);
        }

        if (liveSessionId) {
            try {
                await fetch('/api/public/support/live/' + liveSessionApiKey() + '/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text, visitorKey })
                });
                pollLiveMessages();
            } catch (_) {
                addBot('Message not sent. Please try again.');
            }
            return;
        }

        try {
            const appMatch = text.match(/\b(SEM-[\w-]+|CASE-[\w-]+|TKT_[\w-]+|LCHAT-\d{12}|\d{12})\b/i);
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
            if (data.suggestLiveChat && data.liveChatAvailable && liveChatOpen) {
                addBot('Tap "Talk to a support agent" below to chat live with our team.');
                liveBtn.classList.remove('hidden');
            } else if (data.liveChatAvailable) {
                liveBtn.classList.remove('hidden');
            }
        } catch (e) {
            addBot('Sorry, something went wrong. Email care@vaidyagogate.org or open /live-chat.html for 1-to-1 chat.');
        }
    }

    document.getElementById('vgmf-support-send').addEventListener('click', sendMessage);
    document.getElementById('vgmf-support-input').addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') sendMessage();
    });
})();

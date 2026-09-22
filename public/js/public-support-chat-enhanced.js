/**
 * Enhanced Public Support Chat Widget for VGMF
 * Features: Site icon, improved UI, transcript email, OTP verification, payment links, conversational design
 */
(function () {
    if (document.getElementById('vgmf-support-widget-root')) return;

    // Translation strings
    function t(key) {
        const fallbacks = {
            'support.title': 'VGMF Support',
            'support.subtitle': 'Vaidya Gogate Memorial Foundation',
            'support.hoursLoading': 'Checking availability...',
            'support.liveAgent': 'Talk to Support Agent',
            'support.fullScreenChat': 'Open full chat page',
            'support.trackPlaceholder': 'Application/Ticket No. (optional)',
            'support.askPlaceholder': 'Type your question...',
            'support.send': 'Send',
            'support.contactTitle': 'Share your details',
            'support.contactHint': 'We\'ll contact you via email/phone.',
            'support.fullName': 'Full name',
            'support.email': 'Email address',
            'support.phone': 'Phone number',
            'support.describeIssue': 'Describe your issue',
            'support.sendTeam': 'Send to Support Team',
            'support.openChat': 'Open Support Chat',
            'support.you': 'You',
            'support.assistant': 'VGMF Assistant',
            'support.desk': 'Support Desk',
            'support.welcome': 'Hello! 👋 Welcome to VGMF Support.\n\nI can help with seminar registration, application tracking, payments, e-tickets, certificates, and more.\n\nTry: "How to register?" or "Track my application"',
            'support.quickHelp': 'Quick help:',
            'support.transcriptEmail': 'Email Transcript',
            'support.paymentLink': 'Get Payment Link',
            'support.verifyEmail': 'Email Verification',
            'support.helpCommands': 'View All Commands'
        };
        return fallbacks[key] || key;
    }

    let liveSessionId = null;
    let liveChatRef = '';
    let liveAgentName = '';
    let liveGuestUrl = '';
    let liveMsgSince = 0;
    let livePollTimer = null;
    let liveWaitTimerInterval = null;
    let liveWaitStartedAt = null;
    const LIVE_WAIT_MS = 5 * 60 * 1000;
    let liveChatOpen = false;
    let websiteLiveChatEnabled = true;
    let hoursLabel = '';
    let contactFormDismissed = false;
    let visitorKey = localStorage.getItem('vgmf_support_visitor') || '';
    let conversationHistory = [];
    if (!visitorKey) {
        visitorKey = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('vgmf_support_visitor', visitorKey);
    }

    // Create enhanced chat UI
    const root = document.createElement('div');
    root.id = 'vgmf-support-widget-root';
    root.innerHTML =
        // Floating launcher button with site icon
        '<button type="button" id="vgmf-support-launcher" aria-label="' + t('support.openChat') + '" style="position:fixed;bottom:24px;right:24px;z-index:9998;width:60px;height:60px;border-radius:50%;border:none;background:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);color:#fff;box-shadow:0 8px 24px rgba(13,148,136,0.4);cursor:pointer;font-size:1.4rem;display:flex;align-items:center;justify-content:center;transition:all 0.2s ease;overflow:hidden;">' +
        '<svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin:0;">' +
        '<circle cx="50" cy="50" r="45" fill="white" fill-opacity="0.15"/>' +
        '<path d="M50 20C32.3 20 18 33.3 18 50C18 66.7 32.3 80 50 80C58 80 65.3 77.3 70.7 72.7L78 80C78.7 80.7 79.7 81 80.7 81C81 81 81.3 81 81.7 81C82 81 82 80.7 82.3 80.3C83 78.7 83 76.7 82.3 75.3L75.3 69C77.7 65.7 79 61.7 79 57.3C79 41.3 65.7 28 50 28V20Z" fill="white"/>' +
        '<circle cx="38" cy="47" r="5" fill="#0d9488"/>' +
        '<circle cx="50" cy="47" r="5" fill="#0d9488"/>' +
        '<circle cx="62" cy="47" r="5" fill="#0d9488"/>' +
        '</svg>' +
        '<span style="position:absolute;bottom:8px;right:8px;width:12px;height:12px;background:#10b981;border-radius:50%;border:2px solid white;"></span>' +
        '</button>' +
        
        // Chat panel
        '<div id="vgmf-support-panel" class="hidden" style="position:fixed;bottom:100px;right:24px;z-index:9999;width:min(400px,calc(100vw - 32px));max-height:min(600px,calc(100vh - 140px));background:#fff;border-radius:20px;box-shadow:0 20px 40px rgba(15,23,42,0.15);border:1px solid #e2e8f0;display:flex;flex-direction:column;overflow:hidden;">' +
        
        // Header with site branding
        '<div style="padding:16px 20px;background:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);color:#fff;">' +
        '<div style="display:flex;align-items:center;gap:12px;">' +
        '<svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="50" cy="50" r="45" fill="white" fill-opacity="0.2"/>' +
        '<path d="M50 20C32.3 20 18 33.3 18 50C18 66.7 32.3 80 50 80C58 80 65.3 77.3 70.7 72.7L78 80C78.7 80.7 79.7 81 80.7 81C81 81 81.3 81 81.7 81C82 81 82 80.7 82.3 80.3C83 78.7 83 76.7 82.3 75.3L75.3 69C77.7 65.7 79 61.7 79 57.3C79 41.3 65.7 28 50 28V20Z" fill="white"/>' +
        '<circle cx="38" cy="47" r="5" fill="white"/>' +
        '<circle cx="50" cy="47" r="5" fill="white"/>' +
        '<circle cx="62" cy="47" r="5" fill="white"/>' +
        '</svg>' +
        '<div style="flex:1;">' +
        '<div style="font-weight:700;font-size:1rem;">' + t('support.title') + '</div>' +
        '<div style="font-size:0.75rem;opacity:0.9;">' + t('support.subtitle') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
        '<a href="/live-chat" style="width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.2);color:#fff;display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:0.9rem;" title="Full page chat"><i class="fas fa-expand"></i></a>' +
        '</div>' +
        '</div>' +
        '<div style="font-size:0.78rem;opacity:0.9;margin-top:4px;padding-left:52px;" id="vgmf-support-hours">' + t('support.hoursLoading') + '</div>' +
        '<div id="vgmf-support-live-meta" class="hidden" style="font-size:0.72rem;opacity:0.92;margin-top:6px;padding-left:52px;"></div>' +
        '<div id="vgmf-support-guest-link" class="hidden" style="font-size:0.68rem;opacity:0.95;margin-top:6px;word-break:break-all;padding-left:52px;"></div>' +
        '</div>' +
        
        // Messages area
        '<div id="vgmf-support-messages" style="flex:1;overflow-y:auto;padding:16px;font-size:0.9rem;background:#f8fafc;min-height:200px;"></div>' +
        
        // Quick actions
        '<div id="vgmf-support-quick-actions" style="padding:10px 16px;background:#fff;border-top:1px solid #f1f5f9;display:flex;flex-wrap:wrap;gap:6px;">' +
        '<button type="button" class="vgqf-btn" data-action="transcript" style="flex:1;min-width:calc(50% - 3px);padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#475569;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all 0.15s;">📧 Transcript</button>' +
        '<button type="button" class="vgqf-btn" data-action="payment" style="flex:1;min-width:calc(50% - 3px);padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#475569;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all 0.15s;">💳 Payment</button>' +
        '<button type="button" class="vgqf-btn" data-action="verify" style="flex:1;min-width:calc(50% - 3px);padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#475569;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all 0.15s;">🔐 Verify Email</button>' +
        '<button type="button" class="vgqf-btn" data-action="help" style="flex:1;min-width:calc(50% - 3px);padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#475569;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all 0.15s;">❓ Help</button>' +
        '</div>' +
        
        // Contact form (for email verification/transcript)
        '<div id="vgmf-support-email-form" class="hidden" style="padding:12px 16px;border-top:1px solid #fde68a;background:#fffbeb;font-size:0.82rem;">' +
        '<p style="margin:0 0 8px;color:#92400e;font-weight:600;">📧 Enter your email:</p>' +
        '<input type="email" id="vgmf-cf-email" placeholder="your@email.com" style="width:100%;padding:10px 12px;margin-bottom:8px;border:1px solid #fcd34d;border-radius:8px;font-size:0.85rem;box-sizing:border-box;">' +
        '<div style="display:flex;gap:8px;">' +
        '<button type="button" id="vgmf-cf-email-submit" style="flex:1;padding:10px;border:none;border-radius:8px;background:#0d9488;color:#fff;font-weight:600;cursor:pointer;font-size:0.85rem;">Send</button>' +
        '<button type="button" id="vgmf-cf-email-cancel" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#64748b;font-weight:600;cursor:pointer;font-size:0.85rem;">Cancel</button>' +
        '</div>' +
        '<p id="vgmf-cf-email-status" style="margin:8px 0 0;font-size:0.75rem;"></p>' +
        '</div>' +
        
        // Live chat button
        '<div id="vgmf-support-live-btn-container" style="padding:10px 16px;border-top:1px solid #e2e8f0;background:#fff;">' +
        '<button type="button" id="vgmf-support-live-btn" class="hidden" style="width:100%;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);color:#fff;font-weight:700;cursor:pointer;font-size:0.9rem;box-shadow:0 4px 14px rgba(13,148,136,0.3);">' +
        '<i class="fas fa-headset"></i> ' + t('support.liveAgent') + '</button>' +
        '</div>' +
        
        // Input area
        '<div style="padding:12px 16px;border-top:1px solid #e2e8f0;background:#fff;">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
        '<input type="text" id="vgmf-support-track" placeholder="' + t('support.trackPlaceholder') + '" style="flex:1;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:0.85rem;">' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
        '<input type="text" id="vgmf-support-input" placeholder="' + t('support.askPlaceholder') + '" style="flex:1;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:0.9rem;transition:border-color 0.15s;">' +
        '<button type="button" id="vgmf-support-send" style="width:48px;height:48px;border:none;border-radius:12px;background:linear-gradient(135deg,#0d9488 0%,#0f766e 100%);color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(13,148,136,0.3);transition:all 0.15s;">' +
        '<i class="fas fa-paper-plane"></i></button>' +
        '</div>' +
        '<p style="font-size:0.7rem;color:#94a3b8;margin:8px 0 0;text-align:center;">Account help: <a href="/doctor" style="color:#0d9488;font-weight:600;">Sign in to Doctor Portal</a></p>' +
        '</div>' +
        
        // OTP verification modal
        '<div id="vgmf-otp-modal" class="hidden" style="position:absolute;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:10;">' +
        '<div style="background:#fff;border-radius:16px;padding:24px;max-width:320px;width:100%;">' +
        '<h3 style="margin:0 0 16px;color:#0f172a;font-size:1.1rem;">🔐 Email Verification</h3>' +
        '<p style="margin:0 0 16px;color:#64748b;font-size:0.85rem;">Enter the 6-digit code sent to your email.</p>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
        '<input type="text" id="vgmf-otp-input" maxlength="6" placeholder="• • • • • •" style="flex:1;padding:14px;text-align:center;font-size:1.5rem;letter-spacing:8px;border:2px solid #e2e8f0;border-radius:10px;">' +
        '</div>' +
        '<button type="button" id="vgmf-otp-verify" style="width:100%;padding:12px;border:none;border-radius:10px;background:#0d9488;color:#fff;font-weight:600;cursor:pointer;margin-bottom:8px;">Verify OTP</button>' +
        '<button type="button" id="vgmf-otp-cancel" style="width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#64748b;font-weight:600;cursor:pointer;">Cancel</button>' +
        '</div>' +
        '</div>' +
        '</div>';

    document.body.appendChild(root);

    const panel = document.getElementById('vgmf-support-panel');
    const messagesEl = document.getElementById('vgmf-support-messages');
    const hoursEl = document.getElementById('vgmf-support-hours');
    const liveBtn = document.getElementById('vgmf-support-live-btn');
    const emailForm = document.getElementById('vgmf-support-email-form');
    const emailInput = document.getElementById('vgmf-cf-email');
    const emailStatus = document.getElementById('vgmf-cf-email-status');
    const otpModal = document.getElementById('vgmf-otp-modal');

    let emailAction = null; // 'transcript' or 'verify'

    function liveSessionApiKey() {
        return encodeURIComponent(liveChatRef || String(liveSessionId || ''));
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function formatMessage(text) {
        // Convert **bold** to <strong>
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Convert newlines to <br>
        text = text.replace(/\n/g, '<br>');
        // Convert numbered lists
        text = text.replace(/(\d+)️⃣/g, '<span style="color:#0d9488;font-weight:700;">$1️⃣</span>');
        // Convert bullet points
        text = text.replace(/•/g, '<span style="color:#0d9488;">•</span>');
        return text;
    }

    function appendMessage(msg) {
        conversationHistory.push(msg);
        const role = msg.role || 'assistant';
        const isUser = role === 'user';
        const isSystem = role === 'system';
        const isBot = role === 'assistant' || role === 'bot';
        
        const bg = isUser ? 'linear-gradient(135deg,#0d9488 0%,#0f766e 100%)' : (isSystem ? '#fef3c7' : '#fff');
        const color = isUser ? '#fff' : (isSystem ? '#92400e' : '#334155');
        const align = isUser ? 'margin-left:40px;' : '';
        const borderRadius = isUser ? '16px 16px 4px 16px' : (isSystem ? '12px' : '16px 16px 16px 4px');
        const border = isUser ? 'none' : (isSystem ? '1px solid #fcd34d' : '1px solid #e2e8f0');
        const shadow = isUser ? '0 4px 12px rgba(13,148,136,0.2)' : '0 2px 8px rgba(0,0,0,0.05)';
        
        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const avatar = isUser ? 
            '<div style="width:32px;height:32px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:0.8rem;font-weight:700;flex-shrink:0;">' + 
            '<i class="fas fa-user"></i></div>' :
            '<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#0d9488,#0f766e);display:flex;align-items:center;justify-content:center;color:#fff;font-size:0.8rem;flex-shrink:0;">' +
            '<i class="fas fa-robot"></i></div>';
        
        const msgHtml = 
            '<div style="display:flex;gap:10px;margin-bottom:12px;align-items:flex-start;' + align + '">' +
            avatar +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:0.72rem;color:#94a3b8;margin-bottom:4px;font-weight:600;">' +
            (isUser ? t('support.you') : t('support.assistant')) +
            ' · ' + time +
            '</div>' +
            '<div style="padding:12px 14px;background:' + bg + ';color:' + color + ';border-radius:' + borderRadius + ';border:' + border + ';box-shadow:' + shadow + ';line-height:1.5;font-size:0.88rem;">' +
            formatMessage(esc(msg.text || msg.message || '')) +
            '</div>' +
            '</div>' +
            '</div>';
        
        messagesEl.insertAdjacentHTML('beforeend', msgHtml);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addBot(text) {
        appendMessage({ role: 'assistant', text: text });
    }

    function addUser(text) {
        appendMessage({ role: 'user', text: text });
    }

    function showEmailForm(action) {
        emailAction = action;
        emailForm.classList.remove('hidden');
        emailInput.value = '';
        emailStatus.textContent = '';
        emailInput.focus();
    }

    function hideEmailForm() {
        emailForm.classList.add('hidden');
        emailAction = null;
    }

    async function sendTranscriptEmail(email) {
        try {
            const res = await fetch('/api/public/support/send-transcript', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email: email, 
                    conversation: conversationHistory,
                    visitorKey: visitorKey 
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to send');
            emailStatus.style.color = '#059669';
            emailStatus.textContent = '✅ Transcript sent to ' + email + '!';
            setTimeout(hideEmailForm, 2000);
        } catch (e) {
            emailStatus.style.color = '#dc2626';
            emailStatus.textContent = e.message || 'Failed to send. Try again.';
        }
    }

    async function requestEmailVerification(email) {
        try {
            const res = await fetch('/api/public/request-email-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, purpose: 'email_verification' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to send OTP');
            emailStatus.style.color = '#059669';
            emailStatus.textContent = '✅ OTP sent to ' + email + '! Check your inbox.';
            setTimeout(() => {
                hideEmailForm();
                otpModal.classList.remove('hidden');
            }, 1500);
        } catch (e) {
            emailStatus.style.color = '#dc2626';
            emailStatus.textContent = e.message || 'Failed to send OTP.';
        }
    }

    // Quick action buttons
    document.querySelectorAll('.vgqf-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const action = this.dataset.action;
            if (action === 'transcript') {
                addUser('📧 Please send me my chat transcript via email');
                addBot('I\'ll send you the complete chat transcript!\n\nPlease enter your email address below.');
                showEmailForm('transcript');
            } else if (action === 'payment') {
                addUser('💳 I need a payment link');
                addBot('To get your seminar payment link:\n\n1️⃣ Sign in to doctor portal (/doctor)\n2️⃣ Go to "My Applications" or "Payments"\n3️⃣ Find your approved registration\n4️⃣ Click "Pay Now" to generate payment link\n\nWhich seminar are you registering for?');
            } else if (action === 'verify') {
                addUser('🔐 I need to verify my email');
                addBot('I can help with email verification!\n\nPlease enter your email address and I\'ll send you an OTP to verify.');
                showEmailForm('verify');
            } else if (action === 'help') {
                addUser('❓ What can you help me with?');
                addBot('Here\'s what I can help with:\n\n📋 Seminar registration & applications\n📊 Application status tracking\n💳 Payment links & receipts\n🎫 E-tickets & QR codes\n📜 Certificates & verification\n📝 Case presentation applications\n🔐 Email OTP verification\n📧 Chat transcript by email\n💬 Live chat with support\n\nJust type your question!');
            }
        });
    });

    // Email form handlers
    document.getElementById('vgmf-cf-email-submit').addEventListener('click', function() {
        const email = emailInput.value.trim();
        if (!email || !email.includes('@')) {
            emailStatus.style.color = '#dc2626';
            emailStatus.textContent = 'Please enter a valid email address';
            return;
        }
        if (emailAction === 'transcript') {
            sendTranscriptEmail(email);
        } else if (emailAction === 'verify') {
            requestEmailVerification(email);
        }
    });

    document.getElementById('vgmf-cf-email-cancel').addEventListener('click', hideEmailForm);

    // OTP modal handlers
    document.getElementById('vgmf-otp-verify').addEventListener('click', async function() {
        const otp = document.getElementById('vgmf-otp-input').value.trim();
        if (otp.length !== 6) {
            alert('Please enter the 6-digit OTP');
            return;
        }
        // Verify OTP via API
        try {
            const res = await fetch('/api/public/verify-email-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ otp: otp })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Invalid OTP');
            otpModal.classList.add('hidden');
            addBot('✅ Your email has been verified successfully!');
        } catch (e) {
            alert(e.message || 'Invalid OTP. Please try again.');
        }
    });

    document.getElementById('vgmf-otp-cancel').addEventListener('click', function() {
        otpModal.classList.add('hidden');
    });

    // Launcher toggle
    document.getElementById('vgmf-support-launcher').addEventListener('click', function() {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden') && messagesEl.children.length === 0) {
            addBot(t('support.welcome'));
        }
    });

    // Live chat button
    liveBtn.addEventListener('click', function() {
        liveBtn.classList.add('hidden');
        startLiveChat();
    });

    // Send message
    async function sendMessage() {
        const input = document.getElementById('vgmf-support-input');
        const track = document.getElementById('vgmf-support-track').value.trim();
        const text = input.value.trim();
        if (!text) return;
        addUser(text);
        input.value = '';

        // Live chat mode
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

        // AI chat mode
        try {
            const appMatch = text.match(/\b(SEM-[\w-]+|CASE-[\w-]+|TKT_[\w-]+|LCHAT-\d{12}|\d{12})\b/i);
            const trackRef = track || (appMatch && appMatch[1]);
            
            const res = await fetch('/api/public/support/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text, applicationNo: trackRef || undefined })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed');
            addBot(data.reply);
            
            if (data.suggestLiveChat && data.liveChatAvailable && liveChatOpen && websiteLiveChatEnabled) {
                addBot('Tap "Talk to Support Agent" to chat live with our team!');
                liveBtn.classList.remove('hidden');
            } else if (data.liveChatAvailable && websiteLiveChatEnabled) {
                liveBtn.classList.remove('hidden');
            }
        } catch (e) {
            addBot('Sorry, something went wrong. You can email us at care@vaidyagogate.org or use the contact form below.');
        }
    }

    document.getElementById('vgmf-support-send').addEventListener('click', sendMessage);
    document.getElementById('vgmf-support-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendMessage();
    });

    // Load hours and initialize
    fetch('/api/public/support/hours?portal=website', { cache: 'no-store' })
        .then(r => r.json())
        .then(h => {
            if (h.open !== false) {
                hoursEl.textContent = '🟢 We are online! ' + (h.label || 'Available now');
            } else {
                hoursEl.textContent = '🔴 ' + (h.label || 'Currently offline');
            }
        })
        .catch(() => {
            hoursEl.textContent = 'Ask about seminars, registration, payments, or case presentation!';
        });

    // Live chat functions
    async function startLiveChat(initialMessage) {
        try {
            const res = await fetch('/api/public/support/live/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorKey, initialMessage })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not start chat');
            liveSessionId = data.sessionId;
            liveChatRef = data.chatRef || '';
            updateLiveMeta();
            startPoll();
            pollMessages();
            refreshSession();
        } catch (e) {
            alert(e.message || 'Could not start live chat');
        }
    }

    function updateLiveMeta() {
        const metaEl = document.getElementById('vgmf-support-live-meta');
        if (!liveSessionId) {
            metaEl.classList.add('hidden');
            return;
        }
        metaEl.classList.remove('hidden');
        metaEl.innerHTML = 'Ref: <strong>' + esc(liveChatRef || '...') + '</strong>' +
            (liveAgentName ? ' · Agent: <strong>' + esc(liveAgentName) + '</strong>' : ' · Waiting for agent...');
    }

    function pollMessages() {
        if (!liveSessionId) return;
        fetch('/api/public/support/live/' + liveSessionApiKey() + '/messages', { cache: 'no-store' })
            .then(r => r.json())
            .then(rows => {
                rows.forEach(m => {
                    if (m.id > liveMsgSince) liveMsgSince = m.id;
                    if (m.sender_type === 'agent' && m.sender_name) {
                        liveAgentName = m.sender_name;
                        updateLiveMeta();
                    }
                    if (m.sender_type !== 'visitor') {
                        appendMessage({ role: 'assistant', text: m.message });
                    }
                });
            })
            .catch(() => {});
    }

    function startPoll() {
        livePollTimer = setInterval(pollMessages, 3000);
    }

    function refreshSession() {
        if (!liveSessionId) return;
        fetch('/api/public/support/live/' + liveSessionApiKey(), { cache: 'no-store' })
            .then(r => r.json())
            .then(session => {
                if (session.agentName) {
                    liveAgentName = session.agentName;
                    updateLiveMeta();
                }
                if (session.status === 'closed') {
                    liveSessionId = null;
                    liveChatRef = '';
                    liveAgentName = '';
                    stopPoll();
                }
            })
            .catch(() => {});
    }

    function stopPoll() {
        if (livePollTimer) {
            clearInterval(livePollTimer);
            livePollTimer = null;
        }
    }
})();

/**
 * Standalone public event registration — sign in / sign up, then doctor portal in event-only mode.
 */
(function () {
    let eventMeta = null;
    let signupPhoneOtpToken = null;
    let signupEmailOtpToken = null;

    function qs() {
        return new URLSearchParams(window.location.search);
    }

    function eventSlug() {
        return (qs().get('event') || '').trim();
    }

    function continueUrl() {
        if (!eventMeta) return '/doctor.html';
        return (
            '/doctor.html?seminarId=' +
            encodeURIComponent(eventMeta.seminarId) +
            '&eventPortal=1'
        );
    }

    function showErr(msg) {
        const el = document.getElementById('event-reg-error');
        const main = document.getElementById('event-reg-main');
        const loading = document.getElementById('event-reg-loading');
        if (loading) loading.classList.add('hidden');
        if (main) main.classList.add('hidden');
        if (el) {
            el.textContent = msg;
            el.classList.remove('hidden');
        }
    }

    function switchTab(tab) {
        const login = document.getElementById('ev-login-panel');
        const signup = document.getElementById('ev-signup-panel');
        const btnIn = document.getElementById('ev-tab-login');
        const btnUp = document.getElementById('ev-tab-signup');
        const showLogin = tab === 'login';
        if (login) login.classList.toggle('hidden', !showLogin);
        if (signup) signup.classList.toggle('hidden', showLogin);
        if (btnIn) btnIn.classList.toggle('active', showLogin);
        if (btnUp) btnUp.classList.toggle('active', !showLogin);
    }

    async function loadEvent() {
        const slug = eventSlug();
        if (!slug) return showErr('Missing event in URL (?event=your-slug)');
        try {
            const res = await fetch('/api/public/event/' + encodeURIComponent(slug));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Event not found');
            if (data.portalMode !== 'standalone') {
                window.location.replace(data.registerUrl || '/doctor.html?seminarId=' + data.seminarId);
                return;
            }
            eventMeta = data;
            document.getElementById('event-reg-loading').classList.add('hidden');
            document.getElementById('event-reg-main').classList.remove('hidden');
            const page = data.page || {};
            document.getElementById('ev-reg-title').textContent = page.heroTitle || data.title || 'Event registration';
            document.getElementById('ev-reg-sub').textContent =
                page.heroSubtitle || (data.registrationEnabled ? 'Create an account or sign in to apply.' : '');
            const pub = document.getElementById('ev-reg-public-link');
            if (pub) pub.href = '/event.html?event=' + encodeURIComponent(slug);
            const docLink = document.getElementById('ev-doctor-portal-link');
            if (docLink) docLink.href = '/doctor.html?seminarId=' + data.seminarId;
            if (!data.registrationEnabled) {
                document.getElementById('event-reg-auth').classList.add('hidden');
                document.getElementById('event-reg-closed').classList.remove('hidden');
            }
            refreshSignedInUi();
        } catch (e) {
            showErr(e.message || 'Could not load event');
        }
    }

    function refreshSignedInUi() {
        const user =
            typeof PortalAuth !== 'undefined' ? PortalAuth.getUser('event') || PortalAuth.getUser('doctor') : null;
        const auth = document.getElementById('event-reg-auth');
        const cont = document.getElementById('event-reg-continue');
        if (!user) {
            if (auth) auth.classList.remove('hidden');
            if (cont) cont.classList.add('hidden');
            return;
        }
        if (auth) auth.classList.add('hidden');
        if (cont) cont.classList.remove('hidden');
        const btn = document.getElementById('ev-continue-btn');
        if (btn) btn.href = continueUrl();
    }

    async function refreshSignupOtpPanel() {
        const panel = document.getElementById('ev-signup-otp-panel');
        if (!panel) return;
        try {
            const res = await fetch('/api/auth/signup-otp-required');
            const d = await res.json();
            panel.style.display = d.required ? 'block' : 'none';
        } catch (_) {
            panel.style.display = 'none';
        }
    }

    async function sendSignupOtp(channel) {
        const raw =
            channel === 'email'
                ? String(document.getElementById('ev-signup-email').value || '').trim()
                : String(document.getElementById('ev-signup-phone').value || '').trim();
        let dest = raw;
        if (typeof validateOtpDestinationClient === 'function') {
            const v = validateOtpDestinationClient(channel, raw, channel === 'email' ? 'Email' : 'Phone');
            if (!v.valid) return alert(v.message);
            dest = channel === 'email' ? v.cleanedEmail : v.cleanedPhone;
        }
        const res = await fetch('/api/otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, destination: dest, purpose: 'signup' })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not send code.');
        if (window.OtpUi) window.OtpUi.notifyOtpSent(channel, data);
        else alert('Code sent.');
    }

    async function verifySignupOtp(channel) {
        const raw =
            channel === 'email'
                ? String(document.getElementById('ev-signup-email').value || '').trim()
                : String(document.getElementById('ev-signup-phone').value || '').trim();
        const code = String(
            (channel === 'email'
                ? document.getElementById('ev-signup-email-otp')
                : document.getElementById('ev-signup-phone-otp')
            ).value || ''
        ).trim();
        let dest = raw;
        if (typeof validateOtpDestinationClient === 'function') {
            const v = validateOtpDestinationClient(channel, raw, channel === 'email' ? 'Email' : 'Phone');
            if (!v.valid) return alert(v.message);
            dest = channel === 'email' ? v.cleanedEmail : v.cleanedPhone;
        }
        const res = await fetch('/api/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, destination: dest, code, purpose: 'signup' })
        });
        const data = await res.json();
        if (!res.ok || !data.token) return alert(data.error || 'Invalid code.');
        if (channel === 'email') signupEmailOtpToken = data.token;
        else signupPhoneOtpToken = data.token;
    }

    async function handleSignup(e) {
        e.preventDefault();
        const errEl = document.getElementById('ev-signup-err');
        if (errEl) errEl.classList.add('hidden');
        const body = {
            firstName: document.getElementById('ev-signup-first').value.trim(),
            lastName: document.getElementById('ev-signup-last').value.trim(),
            email: document.getElementById('ev-signup-email').value.trim(),
            phone: document.getElementById('ev-signup-phone').value.trim(),
            password: document.getElementById('ev-signup-password').value,
            role: 'event_attendee'
        };
        const otpPanel = document.getElementById('ev-signup-otp-panel');
        if (otpPanel && otpPanel.style.display !== 'none') {
            if (!signupPhoneOtpToken || !signupEmailOtpToken) {
                return alert('Verify email and WhatsApp OTP before creating your account.');
            }
            body.phoneOtpToken = signupPhoneOtpToken;
            body.emailOtpToken = signupEmailOtpToken;
        }
        try {
            const res = await fetch('/api/auth/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                const msg = data.error || 'Signup failed';
                if (data.needsLogin) {
                    switchTab('login');
                    document.getElementById('ev-login-email').value = body.email;
                    return alert(msg);
                }
                if (errEl) {
                    errEl.textContent = msg;
                    errEl.classList.remove('hidden');
                } else alert(msg);
                return;
            }
            alert(data.message || 'Account created. Sign in to continue.');
            switchTab('login');
            document.getElementById('ev-login-email').value = body.email;
            document.getElementById('ev-login-password').value = body.password;
        } catch (err) {
            console.error(err);
            alert('Network error.');
        }
    }

    function boot() {
        document.getElementById('ev-tab-login')?.addEventListener('click', () => switchTab('login'));
        document.getElementById('ev-tab-signup')?.addEventListener('click', () => switchTab('signup'));
        document.getElementById('ev-signup-form')?.addEventListener('submit', handleSignup);
        document.getElementById('ev-signout-btn')?.addEventListener('click', () => {
            if (typeof PortalAuth !== 'undefined') {
                PortalAuth.clearUser('event');
                PortalAuth.clearUser('doctor');
            }
            refreshSignedInUi();
        });
        ['ev-signup-send-email', 'ev-signup-send-phone'].forEach((id, i) => {
            const ch = i === 0 ? 'email' : 'phone';
            document.getElementById(id)?.addEventListener('click', () => sendSignupOtp(ch).catch(console.error));
            const vid = id.replace('send', 'verify');
            document.getElementById(vid)?.addEventListener('click', () => verifySignupOtp(ch).catch(console.error));
        });

        if (typeof PortalAuth !== 'undefined') {
            PortalAuth.bindLoginForm({
                portal: 'event',
                formId: 'ev-login-form',
                otpPanelId: 'ev-login-otp-panel',
                emailInputId: 'ev-login-email',
                passwordInputId: 'ev-login-password',
                otpPrefix: 'ev',
                onSuccess: (user) => {
                    PortalAuth.setUser('event', user);
                    window.location.href = continueUrl();
                },
                onError: (msg) => {
                    const el = document.getElementById('ev-login-err');
                    if (el) {
                        el.textContent = msg;
                        el.classList.remove('hidden');
                    } else alert(msg);
                }
            });
        }

        refreshSignupOtpPanel();
        loadEvent();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();

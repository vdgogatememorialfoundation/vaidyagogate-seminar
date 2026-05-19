/**
 * Doctor portal — login & signup in-app (no redirect to public homepage).
 */
(function () {
    function isStandaloneDoctorApp() {
        try {
            if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
                if (window.Capacitor.isNativePlatform()) return true;
            }
        } catch (_) {}
        return (
            /Capacitor|Android.*wv/i.test(navigator.userAgent || '') ||
            new URLSearchParams(window.location.search).get('app') === '1'
        );
    }

    let signupPhoneOtpToken = null;
    let signupEmailOtpToken = null;

    function applyStandaloneUi() {
        if (!isStandaloneDoctorApp()) return;
        document.body.classList.add('doctor-standalone-app');
        document.querySelectorAll('.doctor-web-only').forEach((el) => {
            el.classList.add('hidden');
        });
    }

    function switchDoctorAuthTab(tab) {
        const login = document.getElementById('doctor-auth-login-panel');
        const signup = document.getElementById('doctor-auth-signup-panel');
        const btnIn = document.getElementById('doctor-auth-tab-login');
        const btnUp = document.getElementById('doctor-auth-tab-signup');
        const showLogin = tab === 'login';
        if (login) login.classList.toggle('hidden', !showLogin);
        if (signup) signup.classList.toggle('hidden', showLogin);
        if (btnIn) {
            btnIn.classList.toggle('btn-primary', showLogin);
            btnIn.style.opacity = showLogin ? '1' : '0.7';
        }
        if (btnUp) {
            btnUp.classList.toggle('btn-primary', !showLogin);
            btnUp.style.opacity = showLogin ? '0.7' : '1';
        }
        const title = document.getElementById('doctor-auth-title');
        if (title) title.textContent = showLogin ? 'Doctor portal sign-in' : 'Create doctor account';
    }

    function signupOtpDest(channel) {
        if (channel === 'email') {
            return String((document.getElementById('doctor-signup-email') || {}).value || '')
                .trim()
                .toLowerCase();
        }
        return String((document.getElementById('doctor-signup-phone') || {}).value || '').trim();
    }

    async function sendSignupOtp(channel) {
        const dest = signupOtpDest(channel);
        if (!dest) return alert(channel === 'email' ? 'Enter email first.' : 'Enter phone first.');
        const res = await fetch('/api/auth/signup-otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, destination: dest })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not send code.');
        if (window.OtpUi) window.OtpUi.notifyOtpSent(channel, data);
        else alert('OTP sent successfully to your ' + (channel === 'email' ? 'email' : 'WhatsApp') + '.');
    }

    async function verifySignupOtp(channel) {
        const dest = signupOtpDest(channel);
        const codeEl = document.getElementById(
            channel === 'email' ? 'doctor-signup-email-otp' : 'doctor-signup-phone-otp'
        );
        const okEl = document.getElementById(
            channel === 'email' ? 'doctor-signup-email-otp-ok' : 'doctor-signup-phone-otp-ok'
        );
        const code = String((codeEl || {}).value || '').trim();
        if (!dest || !code) return alert('Enter contact and code.');
        const res = await fetch('/api/auth/signup-otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, destination: dest, code })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Invalid code.');
        if (channel === 'email') signupEmailOtpToken = data.token;
        else signupPhoneOtpToken = data.token;
        if (okEl) okEl.textContent = 'Verified';
    }

    async function refreshSignupOtpPanel() {
        const panel = document.getElementById('doctor-signup-otp-panel');
        if (!panel) return;
        try {
            const res = await fetch('/api/auth/signup-otp-required');
            const d = await res.json();
            panel.style.display = d.required ? 'block' : 'none';
        } catch (_) {
            panel.style.display = 'none';
        }
    }

    async function accountCheck(email, password) {
        const res = await fetch('/api/auth/account-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: password || '' })
        });
        return { ok: res.ok, ...(await res.json()) };
    }

    async function handleDoctorSignup(e) {
        e.preventDefault();
        const firstName = String((document.getElementById('doctor-signup-firstname') || {}).value || '').trim();
        const lastName = String((document.getElementById('doctor-signup-lastname') || {}).value || '').trim();
        const email = String((document.getElementById('doctor-signup-email') || {}).value || '')
            .trim()
            .toLowerCase();
        const phone = String((document.getElementById('doctor-signup-phone') || {}).value || '').trim();
        const password = (document.getElementById('doctor-signup-password') || {}).value;
        const errEl = document.getElementById('doctor-signup-err');

        if (typeof validatePersonNameClient === 'function') {
            const fn = validatePersonNameClient(firstName, 'First name');
            if (!fn.valid) return alert(fn.message);
            const ln = validatePersonNameClient(lastName, 'Last name');
            if (!ln.valid) return alert(ln.message);
        }

        try {
            const check = await accountCheck(email, password);
            if (check.exists) {
                if (check.passwordMatch) {
                    if (
                        confirm(
                            (check.message || 'Account exists.') + '\n\nSwitch to Sign in?'
                        )
                    ) {
                        switchDoctorAuthTab('login');
                        const le = document.getElementById('doctor-login-email');
                        const lp = document.getElementById('doctor-login-password');
                        if (le) le.value = email;
                        if (lp) lp.value = password;
                    }
                    return;
                }
                alert(check.message || 'Email already registered. Please sign in.');
                switchDoctorAuthTab('login');
                const le = document.getElementById('doctor-login-email');
                if (le) le.value = email;
                return;
            }
        } catch (_) {
            return alert('Could not verify email.');
        }

        const body = { firstName, lastName, email, phone, password, role: 'doctor' };
        const otpPanel = document.getElementById('doctor-signup-otp-panel');
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
            if (data.success) {
                signupPhoneOtpToken = null;
                signupEmailOtpToken = null;
                alert(data.message || 'Account created. Please sign in.');
                switchDoctorAuthTab('login');
                const le = document.getElementById('doctor-login-email');
                const lp = document.getElementById('doctor-login-password');
                if (le) le.value = email;
                if (lp) lp.value = password;
                return;
            }
            if (data.needsLogin) {
                alert(data.error || 'Please sign in.');
                switchDoctorAuthTab('login');
                return;
            }
            if (errEl) {
                errEl.textContent = data.error || 'Signup failed';
                errEl.classList.remove('hidden');
            } else alert(data.error || 'Signup failed');
        } catch (err) {
            console.error(err);
            alert('Network error.');
        }
    }

    function wireSignupOtpButtons() {
        ['email', 'phone'].forEach((ch) => {
            const send = document.getElementById('doctor-signup-send-otp-' + ch);
            const resend = document.getElementById('doctor-signup-resend-otp-' + ch);
            const verify = document.getElementById('doctor-signup-verify-otp-' + ch);
            if (send) send.addEventListener('click', () => sendSignupOtp(ch).catch(console.error));
            if (resend) resend.addEventListener('click', () => sendSignupOtp(ch).catch(console.error));
            if (verify) verify.addEventListener('click', () => verifySignupOtp(ch).catch(console.error));
        });
    }

    function blockHomepageNavigation() {
        if (!isStandaloneDoctorApp()) return;
        document.addEventListener(
            'click',
            (e) => {
                const a = e.target.closest('a[href]');
                if (!a) return;
                const href = (a.getAttribute('href') || '').trim();
                if (
                    href === '/' ||
                    href === '/index.html' ||
                    href.startsWith('/?') ||
                    (href.startsWith('http') && !href.includes('/doctor.html'))
                ) {
                    e.preventDefault();
                    if (href.includes('register')) switchDoctorAuthTab('signup');
                }
            },
            true
        );
    }

    window.DoctorAuthUi = {
        isStandaloneDoctorApp,
        switchDoctorAuthTab,
        init: function () {
            applyStandaloneUi();
            blockHomepageNavigation();
            refreshSignupOtpPanel();
            wireSignupOtpButtons();
            const signupForm = document.getElementById('doctor-signup-form');
            if (signupForm) signupForm.addEventListener('submit', handleDoctorSignup);
            if (isStandaloneDoctorApp()) switchDoctorAuthTab('login');
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.DoctorAuthUi.init());
    } else {
        window.DoctorAuthUi.init();
    }
})();

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
        if (title) title.textContent = showLogin ? "Doctor's Portal Sign In" : 'Create doctor account';
    }

    function signupOtpDest(channel) {
        const raw =
            channel === 'email'
                ? String((document.getElementById('doctor-signup-email') || {}).value || '').trim()
                : String((document.getElementById('doctor-signup-phone') || {}).value || '').trim();
        if (typeof validateOtpDestinationClient === 'function') {
            const v = validateOtpDestinationClient(channel, raw, channel === 'email' ? 'Email' : 'Phone');
            if (!v.valid) return '';
            return channel === 'email' ? v.cleanedEmail : v.cleanedPhone;
        }
        if (channel === 'email') return raw.toLowerCase();
        const digits = raw.replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : digits;
    }

    async function sendSignupOtp(channel) {
        const raw =
            channel === 'email'
                ? String((document.getElementById('doctor-signup-email') || {}).value || '').trim()
                : String((document.getElementById('doctor-signup-phone') || {}).value || '').trim();
        if (typeof validateOtpDestinationClient === 'function') {
            const v = validateOtpDestinationClient(channel, raw, channel === 'email' ? 'Email' : 'Phone');
            if (!v.valid) return alert(v.message);
        }
        const dest = signupOtpDest(channel);
        if (!dest) return alert(channel === 'email' ? 'Enter email first.' : 'Enter phone first.');
        const res = await fetch('/api/otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, destination: dest, purpose: 'signup' })
        });
        const readJson = window.HttpJson ? window.HttpJson.readJsonResponse : null;
        const errMsg = window.HttpJson ? window.HttpJson.apiErrorMessage : null;
        const parsed = readJson ? await readJson(res) : { data: await res.json(), parseFailed: false };
        const data = parsed.data;
        if (parsed.parseFailed || !res.ok) {
            return alert(
                errMsg ? errMsg(res, data, parsed.parseFailed) : data.error || 'Could not send code.'
            );
        }
        if (window.OtpUi) window.OtpUi.notifyOtpSent(channel, data);
        else alert('OTP sent successfully to your ' + (channel === 'email' ? 'email' : 'WhatsApp') + '.');
    }

    async function verifySignupOtp(channel) {
        try {
            const dest = signupOtpDest(channel);
            const codeEl = document.getElementById(
                channel === 'email' ? 'doctor-signup-email-otp' : 'doctor-signup-phone-otp'
            );
            const okEl = document.getElementById(
                channel === 'email' ? 'doctor-signup-email-otp-ok' : 'doctor-signup-phone-otp-ok'
            );
            const code = String((codeEl || {}).value || '').trim();
            if (!dest || !code) return alert('Enter contact and code.');
            const res = await fetch('/api/otp/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel, destination: dest, code, purpose: 'signup' })
            });
            const readJson = window.HttpJson ? window.HttpJson.readJsonResponse : null;
            const errMsg = window.HttpJson ? window.HttpJson.apiErrorMessage : null;
            let parsed;
            if (readJson) {
                parsed = await readJson(res);
            } else {
                try {
                    parsed = { data: await res.json(), parseFailed: false };
                } catch (parseErr) {
                    parsed = { data: {}, parseFailed: true };
                }
            }
            const data = parsed.data;
            if (parsed.parseFailed || !res.ok) {
                return alert(
                    parsed.parseFailed && errMsg
                        ? errMsg(res, data, true)
                        : (data && data.error) || 'Invalid code.'
                );
            }
            if (!data || !data.token) {
                return alert('Verification did not return a token. Please try again.');
            }
            if (channel === 'email') signupEmailOtpToken = data.token;
            else signupPhoneOtpToken = data.token;
            if (okEl) okEl.textContent = 'Verified';
        } catch (err) {
            console.error(err);
            alert('Could not verify code. Check your connection and try again.');
        }
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

    async function accountCheck(email, password, phone) {
        const res = await fetch('/api/auth/account-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: password || '', phone: phone || '' })
        });
        if (window.HttpJson) {
            const { data, parseFailed } = await window.HttpJson.readJsonResponse(res);
            if (parseFailed) throw new Error('account-check-parse');
            return { ok: res.ok, ...data };
        }
        try {
            return { ok: res.ok, ...(await res.json()) };
        } catch (_) {
            throw new Error('account-check-parse');
        }
    }

    async function handleDoctorSignup(e) {
        e.preventDefault();
        const firstName = String((document.getElementById('doctor-signup-firstname') || {}).value || '').trim();
        const lastName = String((document.getElementById('doctor-signup-lastname') || {}).value || '').trim();
        const emailRaw = String((document.getElementById('doctor-signup-email') || {}).value || '').trim();
        const phoneRaw = String((document.getElementById('doctor-signup-phone') || {}).value || '').trim();
        let email = emailRaw.toLowerCase();
        let phone = phoneRaw;
        if (typeof validateEmailClient === 'function') {
            const ev = validateEmailClient(emailRaw, 'Email');
            if (!ev.valid) return alert(ev.message);
            email = ev.cleanedEmail;
        }
        if (typeof validatePhoneClient === 'function') {
            const pv = validatePhoneClient(phoneRaw, 'Phone');
            if (!pv.valid) return alert(pv.message);
            phone = pv.cleanedPhone;
        }
        const password = (document.getElementById('doctor-signup-password') || {}).value;
        const errEl = document.getElementById('doctor-signup-err');

        if (typeof validatePersonNameClient === 'function') {
            const fn = validatePersonNameClient(firstName, 'First name');
            if (!fn.valid) return alert(fn.message);
            const ln = validatePersonNameClient(lastName, 'Last name');
            if (!ln.valid) return alert(ln.message);
        }

        try {
            const check = await accountCheck(email, password, phone);
            if (check.phoneTaken) {
                alert(
                    check.message ||
                        'This mobile number is already registered. Sign in with that account or use a different number.'
                );
                switchDoctorAuthTab('login');
                return;
            }
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
            let data = {};
            let parseFailed = false;
            if (window.HttpJson) {
                const parsed = await window.HttpJson.readJsonResponse(res);
                data = parsed.data;
                parseFailed = parsed.parseFailed;
            } else {
                data = await res.json();
            }
            if (parseFailed) {
                const msg = window.HttpJson.apiErrorMessage(res, data, true);
                if (errEl) {
                    errEl.textContent = msg;
                    errEl.classList.remove('hidden');
                } else alert(msg);
                return;
            }
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
            const failMsg =
                data.error ||
                (window.HttpJson ? window.HttpJson.apiErrorMessage(res, data, false) : 'Signup failed');
            if (errEl) {
                errEl.textContent = failMsg;
                errEl.classList.remove('hidden');
            } else alert(failMsg);
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

    function doctorReturnToPage() {
        const q = new URLSearchParams(window.location.search);
        return q.get('app') === '1' ? 'doctor.html?app=1' : 'doctor.html';
    }

    function openDoctorForgotPasswordModal() {
        const overlay = document.getElementById('doctor-forgot-password-overlay');
        const fe = document.getElementById('doctor-forgot-email');
        const le = document.getElementById('doctor-login-email');
        const st = document.getElementById('doctor-forgot-status');
        if (fe && le && le.value) fe.value = le.value.trim();
        if (st) st.textContent = '';
        if (overlay) overlay.style.display = 'flex';
    }

    function closeDoctorForgotPasswordModal() {
        const overlay = document.getElementById('doctor-forgot-password-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    function openDoctorResetPasswordModal(token) {
        const overlay = document.getElementById('doctor-reset-password-overlay');
        const t = document.getElementById('doctor-reset-token');
        if (t) t.value = token || '';
        if (overlay) overlay.style.display = 'flex';
    }

    function closeDoctorResetPasswordModal() {
        const overlay = document.getElementById('doctor-reset-password-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    async function handleDoctorForgotPassword(e) {
        e.preventDefault();
        const emailRaw = String((document.getElementById('doctor-forgot-email') || {}).value || '').trim();
        let email = emailRaw.toLowerCase();
        if (typeof validateEmailClient === 'function') {
            const ev = validateEmailClient(emailRaw, 'Email');
            if (!ev.valid) return alert(ev.message);
            email = ev.cleanedEmail;
        }
        const st = document.getElementById('doctor-forgot-status');
        if (st) {
            st.style.color = '#64748b';
            st.textContent = 'Sending…';
        }
        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, returnTo: doctorReturnToPage() })
            });
            let data = {};
            if (window.HttpJson) {
                const parsed = await window.HttpJson.readJsonResponse(res);
                data = parsed.data;
            } else {
                data = await res.json();
            }
            if (st) {
                st.style.color = '#059669';
                st.textContent = data.message || 'Check your email and WhatsApp.';
            }
        } catch (_) {
            if (st) {
                st.style.color = '#b91c1c';
                st.textContent = 'Could not send.';
            }
        }
    }

    async function handleDoctorResetPassword(e) {
        e.preventDefault();
        const token = String((document.getElementById('doctor-reset-token') || {}).value || '').trim();
        const p1 = (document.getElementById('doctor-reset-password') || {}).value;
        const p2 = (document.getElementById('doctor-reset-password2') || {}).value;
        const st = document.getElementById('doctor-reset-status');
        if (p1 !== p2) {
            if (st) {
                st.style.color = '#b91c1c';
                st.textContent = 'Passwords do not match.';
            }
            return;
        }
        try {
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: p1 })
            });
            let data = {};
            if (window.HttpJson) {
                const parsed = await window.HttpJson.readJsonResponse(res);
                data = parsed.data;
            } else {
                data = await res.json();
            }
            if (!res.ok) throw new Error(data.error || 'Failed');
            if (st) {
                st.style.color = '#059669';
                st.textContent = data.message || 'Password updated. You can sign in now.';
            }
            setTimeout(() => {
                closeDoctorResetPasswordModal();
                switchDoctorAuthTab('login');
            }, 1200);
        } catch (err) {
            if (st) {
                st.style.color = '#b91c1c';
                st.textContent = err.message || 'Could not reset password.';
            }
        }
    }

    function wireForgotPasswordUi() {
        const forgotBtn = document.getElementById('doctor-forgot-password-btn');
        const forgotCancel = document.getElementById('doctor-forgot-cancel');
        const forgotForm = document.getElementById('doctor-forgot-password-form');
        const resetForm = document.getElementById('doctor-reset-password-form');
        if (forgotBtn) forgotBtn.addEventListener('click', openDoctorForgotPasswordModal);
        if (forgotCancel) forgotCancel.addEventListener('click', closeDoctorForgotPasswordModal);
        if (forgotForm) forgotForm.addEventListener('submit', handleDoctorForgotPassword);
        if (resetForm) resetForm.addEventListener('submit', handleDoctorResetPassword);
        const params = new URLSearchParams(window.location.search);
        const rt = params.get('resetToken');
        if (rt) openDoctorResetPasswordModal(rt);
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
            wireForgotPasswordUi();
            const signupForm = document.getElementById('doctor-signup-form');
            if (signupForm) signupForm.addEventListener('submit', handleDoctorSignup);
            if (isStandaloneDoctorApp()) switchDoctorAuthTab('login');
            const params = new URLSearchParams(window.location.search);
            if (params.get('register') === '1' || params.get('signup') === '1') {
                switchDoctorAuthTab('signup');
            } else if (params.get('login') === '1') {
                switchDoctorAuthTab('login');
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.DoctorAuthUi.init());
    } else {
        window.DoctorAuthUi.init();
    }
})();

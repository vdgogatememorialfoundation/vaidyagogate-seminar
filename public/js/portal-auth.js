/**
 * Per-portal login sessions (separate localStorage keys per app).
 * Accounts are created in Admin → Users & CRM.
 */
(function (global) {
    const KEYS = {
        doctor: 'seminar_doctor_user',
        judge: 'seminar_judge_user',
        scanner: 'seminar_scanner_user'
    };

    function normRole(user) {
        const ur = String((user && user.user_role) || '').trim().toLowerCase();
        const r = String((user && user.role) || '').trim().toLowerCase();
        return { ur, r };
    }

    function isDoctorUser(user) {
        if (!user) return false;
        if (isAdminPortalUser(user) || isJudgeUser(user) || isScannerUser(user)) return false;
        const { ur, r } = normRole(user);
        return ur === 'doctor' || r === 'doctor';
    }

    function isJudgeUser(user) {
        const { ur } = normRole(user);
        return ur === 'judge_user' || ur === 'reviewer';
    }

    function isScannerUser(user) {
        const { ur } = normRole(user);
        return ur === 'scanner_portal_user';
    }

    function isAdminPortalUser(user) {
        const { ur, r } = normRole(user);
        return r === 'admin' || ur === 'co_admin';
    }

    function allowedForPortal(user, portal) {
        if (!user) return false;
        if (portal === 'doctor') return isDoctorUser(user);
        if (portal === 'judge') return isJudgeUser(user);
        if (portal === 'scanner') return isScannerUser(user);
        return false;
    }

    function getUser(portal) {
        const key = KEYS[portal];
        if (!key) return null;
        try {
            let raw = localStorage.getItem(key);
            if (!raw) {
                const legacy = localStorage.getItem('seminar_user');
                if (legacy) {
                    const u = JSON.parse(legacy);
                    if (allowedForPortal(u, portal)) {
                        setUser(portal, u);
                        return u;
                    }
                }
                return null;
            }
            const u = JSON.parse(raw);
            return allowedForPortal(u, portal) ? u : null;
        } catch (_) {
            return null;
        }
    }

    function setUser(portal, user) {
        localStorage.setItem(KEYS[portal], JSON.stringify(user));
    }

    function clearUser(portal) {
        localStorage.removeItem(KEYS[portal]);
    }

    async function refreshLoginOtpPanel(panelEl) {
        if (!panelEl) return;
        try {
            const res = await fetch('/api/auth/login-otp-required');
            const d = await res.json();
            panelEl.style.display = d.required ? 'block' : 'none';
        } catch (_) {
            panelEl.style.display = 'none';
        }
    }

    function wrongPortalHint(user) {
        const { ur, r } = normRole(user);
        if (isAdminPortalUser(user)) return 'Use the admin portal: /admin.html';
        if (isJudgeUser(user)) return 'Use the judge portal: /judge.html';
        if (isScannerUser(user)) return 'Use the scanner portal: /scanner.html';
        if (isDoctorUser(user)) return 'Use the doctor portal: /doctor.html';
        if (r === 'admin') return 'Use the admin portal: /admin.html';
        return 'This account is not enabled for this portal. Ask an administrator to set the correct role.';
    }

    /**
     * Wire a portal login form.
     * @param {object} opts
     * @param {'doctor'|'judge'|'scanner'} opts.portal
     * @param {string} opts.formId
     * @param {string} opts.otpPanelId
     * @param {function(object): void} opts.onSuccess
     * @param {function(string): void} [opts.onError]
     */
    function bindLoginForm(opts) {
        const portal = opts.portal;
        const form = document.getElementById(opts.formId);
        const otpPanel = document.getElementById(opts.otpPanelId);
        if (!form) return;

        let phoneOtpToken = null;
        let emailOtpToken = null;

        refreshLoginOtpPanel(otpPanel);

        const prefix = opts.otpPrefix || portal;
        const sendBtnEmail = document.getElementById(prefix + '-send-otp-email');
        const sendBtnPhone = document.getElementById(prefix + '-send-otp-phone');
        const verifyBtnEmail = document.getElementById(prefix + '-verify-otp-email');
        const verifyBtnPhone = document.getElementById(prefix + '-verify-otp-phone');

        async function sendOtp(channel) {
            const email = String((document.getElementById(opts.emailInputId) || {}).value || '')
                .trim()
                .toLowerCase();
            const password = (document.getElementById(opts.passwordInputId) || {}).value;
            if (!email || !password) return alert('Enter email and password first.');
            const res = await fetch('/api/auth/login-otp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, channel })
            });
            const data = await res.json();
            if (!res.ok) return alert(data.error || 'Could not send code.');
            if (data.debugCode) console.info('Login OTP debug:', data.debugCode);
            if (data.warning) alert(data.warning);
        }

        async function verifyOtp(channel) {
            const email = String((document.getElementById(opts.emailInputId) || {}).value || '')
                .trim()
                .toLowerCase();
            const password = (document.getElementById(opts.passwordInputId) || {}).value;
            const codeEl = document.getElementById(
                channel === 'email' ? prefix + '-email-otp' : prefix + '-phone-otp'
            );
            const okEl = document.getElementById(
                channel === 'email' ? prefix + '-email-otp-ok' : prefix + '-phone-otp-ok'
            );
            const code = String((codeEl || {}).value || '').trim();
            if (!email || !password || !code) return alert('Enter email, password, and the code.');
            const res = await fetch('/api/auth/login-otp/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, channel, code })
            });
            const data = await res.json();
            if (!res.ok) return alert(data.error || 'Invalid code.');
            if (channel === 'email') emailOtpToken = data.token;
            else phoneOtpToken = data.token;
            if (okEl) okEl.textContent = 'Verified';
        }

        if (sendBtnEmail) sendBtnEmail.addEventListener('click', () => sendOtp('email').catch(console.error));
        if (sendBtnPhone) sendBtnPhone.addEventListener('click', () => sendOtp('phone').catch(console.error));
        if (verifyBtnEmail) verifyBtnEmail.addEventListener('click', () => verifyOtp('email').catch(console.error));
        if (verifyBtnPhone) verifyBtnPhone.addEventListener('click', () => verifyOtp('phone').catch(console.error));

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = String((document.getElementById(opts.emailInputId) || {}).value || '')
                .trim()
                .toLowerCase();
            const password = (document.getElementById(opts.passwordInputId) || {}).value;
            const body = { email, password };
            if (otpPanel && otpPanel.style.display === 'block') {
                body.phoneOtpToken = phoneOtpToken;
                body.emailOtpToken = emailOtpToken;
            }
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    const msg = data.error || 'Login failed.';
                    if (opts.onError) opts.onError(msg);
                    else alert(msg);
                    return;
                }
                if (!allowedForPortal(data.user, portal)) {
                    const hint = wrongPortalHint(data.user);
                    if (opts.onError) opts.onError(hint);
                    else alert(hint);
                    return;
                }
                setUser(portal, data.user);
                phoneOtpToken = null;
                emailOtpToken = null;
                opts.onSuccess(data.user);
            } catch (err) {
                console.error(err);
                const msg = 'Could not reach the server.';
                if (opts.onError) opts.onError(msg);
                else alert(msg);
            }
        });
    }

    global.PortalAuth = {
        KEYS,
        getUser,
        setUser,
        clearUser,
        allowedForPortal,
        isDoctorUser,
        isJudgeUser,
        isScannerUser,
        isAdminPortalUser,
        wrongPortalHint,
        refreshLoginOtpPanel,
        bindLoginForm
    };
})(typeof window !== 'undefined' ? window : global);

/**
 * Per-portal login sessions (separate localStorage keys per app).
 * Accounts are created in Admin → Users & CRM.
 */
(function (global) {
    const KEYS = {
        doctor: 'seminar_doctor_user',
        judge: 'seminar_judge_user',
        scanner: 'seminar_scanner_user',
        staff: 'seminar_staff_user'
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
        return ur === 'doctor' || r === 'doctor' || ur === 'event_attendee';
    }

    function isJudgeUser(user) {
        const { ur } = normRole(user);
        return ur === 'judge_user' || ur === 'reviewer';
    }

    function isScannerUser(user) {
        const { ur } = normRole(user);
        return ur === 'scanner_portal_user' || ur === 'scanner_dashboard_user' || ur === 'venue_gate_user';
    }

    function isBookStaffUser(user) {
        if (!user) return false;
        const { ur, r } = normRole(user);
        if (ur === 'book_sales_staff' || ur === 'staff_user' || ur === 'co_admin') return true;
        if (r === 'admin' && ur !== 'co_admin') return true;
        try {
            const raw = user && user.staff_modules;
            const mods = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
            return Object.keys(mods).some((k) => mods[k] === true);
        } catch (_) {
            return false;
        }
    }

    function isStaffPortalUser(user) {
        if (!user) return false;
        if (isJudgeUser(user) || isScannerUser(user) || isDoctorUser(user)) return false;
        return isBookStaffUser(user) || isAdminPortalUser(user);
    }

    function isAdminPortalUser(user) {
        const { ur, r } = normRole(user);
        return r === 'admin' || r === 'co_admin' || ur === 'admin' || ur === 'co_admin';
    }

    function allowedForPortal(user, portal) {
        if (!user) return false;
        if (portal === 'doctor') return isDoctorUser(user);
        if (portal === 'judge') return isJudgeUser(user);
        if (portal === 'scanner') return isScannerUser(user);
        if (portal === 'staff') {
            if (isScannerUser(user) || isJudgeUser(user)) return false;
            if (isDoctorUser(user)) return false;
            return isStaffPortalUser(user);
        }
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

    function formatLoginTime(iso) {
        if (!iso) return '';
        if (global.PortalDateTime && typeof global.PortalDateTime.format === 'function') {
            return global.PortalDateTime.format(iso);
        }
        try {
            return new Date(iso).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (_) {
            return String(iso);
        }
    }

    function loginTimeLabel(user) {
        if (!user) return '';
        const signedIn = formatLoginTime(user.login_at || user.last_login_at);
        if (!signedIn) return '';
        const prev = formatLoginTime(user.previous_login_at);
        if (prev) return 'Signed in ' + signedIn + ' · Previous login ' + prev;
        return 'Signed in ' + signedIn;
    }

    function renderLoginTime(target, user) {
        const el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) return;
        const text = loginTimeLabel(user);
        el.textContent = text;
        if (text) el.classList.remove('hidden');
        else el.classList.add('hidden');
    }

    function setUser(portal, user) {
        if (user && user.id != null) {
            const n = Number(user.id);
            if (Number.isInteger(n) && n > 0 && n <= 2147483647) user.id = n;
        }
        if (user && !user.login_at) user.login_at = user.last_login_at || new Date().toISOString();
        localStorage.setItem(KEYS[portal], JSON.stringify(user));
    }

    function clearUser(portal) {
        localStorage.removeItem(KEYS[portal]);
    }

    async function refreshLoginOtpPanel(panelEl, portal) {
        if (!panelEl) return;
        if (portal === 'judge' || portal === 'scanner' || portal === 'admin' || portal === 'staff') {
            panelEl.style.display = 'none';
            return;
        }
        try {
            const q = portal ? '?portal=' + encodeURIComponent(portal) : '';
            const res = await fetch('/api/auth/login-otp-required' + q);
            const d = await res.json();
            panelEl.style.display = d.required ? 'block' : 'none';
        } catch (_) {
            panelEl.style.display = 'none';
        }
    }

    function wrongPortalHint(user) {
        const { ur, r } = normRole(user);
        if (ur === 'co_admin') return 'Co-admins sign in at /staff/login (full CRM opens at /staff/crm).';
        if (r === 'admin' && ur !== 'co_admin') return 'Use the admin portal: /admin.html';
        if (isJudgeUser(user)) return 'Use the judge portal: /judge.html';
        if (isScannerUser(user)) return 'Use the scanner portal: /scanner.html';
        if (isBookStaffUser(user)) return 'Use the staff portal: /staff/login';
        if (isDoctorUser(user)) return 'Use the doctor portal: /doctor.html';
        return 'This account cannot access this portal. Please sign in with the correct account.';
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

        const otpPortal = portal === 'doctor' ? 'public' : portal;
        refreshLoginOtpPanel(otpPanel, otpPortal);

        const prefix = opts.otpPrefix || portal;
        const sendBtnEmail = document.getElementById(prefix + '-send-otp-email');
        const sendBtnPhone = document.getElementById(prefix + '-send-otp-phone');
        const resendBtnEmail = opts.resendEmailBtnId ? document.getElementById(opts.resendEmailBtnId) : null;
        const resendBtnPhone = opts.resendPhoneBtnId ? document.getElementById(opts.resendPhoneBtnId) : null;
        const verifyBtnEmail = document.getElementById(prefix + '-verify-otp-email');
        const verifyBtnPhone = document.getElementById(prefix + '-verify-otp-phone');

        function validatedLoginEmail() {
            const raw = String((document.getElementById(opts.emailInputId) || {}).value || '').trim();
            if (typeof validateEmailClient === 'function') {
                return validateEmailClient(raw, 'Email');
            }
            return raw
                ? { valid: true, cleanedEmail: raw.toLowerCase() }
                : { valid: false, message: 'Enter your email first.' };
        }

        async function readApiJson(res) {
            if (global.HttpJson) {
                const { data, parseFailed } = await global.HttpJson.readJsonResponse(res);
                return { data, parseFailed };
            }
            try {
                return { data: await res.json(), parseFailed: false };
            } catch (_) {
                return { data: {}, parseFailed: true };
            }
        }

        async function precheckEmail(email) {
            const res = await fetch('/api/auth/login-otp/precheck', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const { data } = await readApiJson(res);
            return data;
        }

        async function sendOtp(channel) {
            const ev = validatedLoginEmail();
            if (!ev.valid) return alert(ev.message);
            const email = ev.cleanedEmail;
            const pc = await precheckEmail(email);
            if (pc.needsSignup) {
                return alert(pc.message || 'No account with this email. Please create an account first.');
            }
            const res = await fetch('/api/auth/login-otp/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, channel })
            });
            const { data, parseFailed } = await readApiJson(res);
            if (parseFailed || !res.ok) {
                if (data.needsSignup) {
                    return alert(data.error || 'No account found. Please create an account first.');
                }
                const msg = parseFailed && global.HttpJson
                    ? global.HttpJson.apiErrorMessage(res, data, true)
                    : data.error || 'Could not send code.';
                return alert(msg);
            }
            if (data.debugCode) console.info('Login OTP debug:', data.debugCode);
            if (global.OtpUi) global.OtpUi.notifyOtpSent(channel, data);
            else alert('OTP sent successfully to your ' + (channel === 'email' ? 'email' : 'WhatsApp') + '.');
        }

        async function sendBothOtps() {
            const ev = validatedLoginEmail();
            if (!ev.valid) return alert(ev.message);
            const email = ev.cleanedEmail;
            const pc = await precheckEmail(email);
            if (pc.needsSignup) {
                return alert(pc.message || 'No account with this email. Please create an account first.');
            }
            const res = await fetch('/api/auth/login-otp/send-both', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const { data, parseFailed } = await readApiJson(res);
            if (parseFailed || !res.ok) {
                const msg = parseFailed && global.HttpJson
                    ? global.HttpJson.apiErrorMessage(res, data, true)
                    : data.error || 'Could not send codes.';
                return alert(msg);
            }
            if (global.OtpUi) global.OtpUi.notifyOtpSent(null, data, { both: true });
            else alert('OTP sent successfully to your email and WhatsApp.');
        }

        async function verifyOtp(channel) {
            const ev = validatedLoginEmail();
            if (!ev.valid) return alert(ev.message);
            const email = ev.cleanedEmail;
            const codeEl = document.getElementById(
                channel === 'email' ? prefix + '-email-otp' : prefix + '-phone-otp'
            );
            const okEl = document.getElementById(
                channel === 'email' ? prefix + '-email-otp-ok' : prefix + '-phone-otp-ok'
            );
            const code = String((codeEl || {}).value || '').trim();
            if (!email || !code) return alert('Enter email and the code.');
            const res = await fetch('/api/auth/login-otp/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, channel, code })
            });
            const { data, parseFailed } = await readApiJson(res);
            if (parseFailed || !res.ok) {
                const msg = parseFailed && global.HttpJson
                    ? global.HttpJson.apiErrorMessage(res, data, true)
                    : data.error || 'Invalid code.';
                return alert(msg);
            }
            if (!data.token) return alert('Verification failed. Please try again.');
            if (channel === 'email') emailOtpToken = data.token;
            else phoneOtpToken = data.token;
            if (okEl) okEl.textContent = 'Verified';
        }

        if (sendBtnEmail) sendBtnEmail.addEventListener('click', () => sendOtp('email').catch(console.error));
        if (sendBtnPhone) sendBtnPhone.addEventListener('click', () => sendOtp('phone').catch(console.error));
        const sendBothBtn = document.getElementById(prefix + '-send-otp-both');
        if (sendBothBtn) sendBothBtn.addEventListener('click', () => sendBothOtps().catch(console.error));
        if (resendBtnEmail) resendBtnEmail.addEventListener('click', () => sendOtp('email').catch(console.error));
        if (resendBtnPhone) resendBtnPhone.addEventListener('click', () => sendOtp('phone').catch(console.error));
        if (verifyBtnEmail) verifyBtnEmail.addEventListener('click', () => verifyOtp('email').catch(console.error));
        if (verifyBtnPhone) verifyBtnPhone.addEventListener('click', () => verifyOtp('phone').catch(console.error));

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const ev = validatedLoginEmail();
            if (!ev.valid) return alert(ev.message);
            const email = ev.cleanedEmail;
            const password = (document.getElementById(opts.passwordInputId) || {}).value;
            const body = { email, password, portal: portal === 'doctor' ? 'doctor' : portal };
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
                const { data, parseFailed } = await readApiJson(res);
                if (res.status === 403 && data.needsEmailVerification) {
                    const msg =
                        data.error ||
                        (data.useLoginOtp || (otpPanel && otpPanel.style.display !== 'none')
                            ? 'Verify your email with the Email OTP above (Send → enter code → Verify), then sign in again.'
                            : 'Please verify your email before signing in.');
                    if (opts.onError) opts.onError(msg);
                    else alert(msg);
                    return;
                }
                if (!res.ok || !data.success) {
                    if (data.needsSignup) {
                        const msg = data.error || 'No account found with this email.';
                        if (
                            portal === 'doctor' &&
                            /doctor\.html/i.test(String(global.location.pathname || '')) &&
                            global.DoctorAuthUi &&
                            typeof global.DoctorAuthUi.switchDoctorAuthTab === 'function'
                        ) {
                            global.DoctorAuthUi.switchDoctorAuthTab('signup');
                            if (opts.onError) opts.onError(msg + ' Use Create account to register.');
                            else alert(msg + ' Switch to Create account and register.');
                            return;
                        }
                        const go = confirm(msg + '\n\nCreate an account now?');
                        if (go) {
                            if (/\/doctor\.html/i.test(String(global.location.pathname || ''))) {
                                global.location.href = '/doctor.html?register=1';
                            } else {
                                global.location.href = '/?register=1';
                            }
                        }
                        return;
                    }
                    const msg =
                        parseFailed && global.HttpJson
                            ? global.HttpJson.apiErrorMessage(res, data, true)
                            : data.error || 'Login failed.';
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
        isBookStaffUser,
        isStaffPortalUser,
        wrongPortalHint,
        refreshLoginOtpPanel,
        bindLoginForm,
        formatLoginTime,
        loginTimeLabel,
        renderLoginTime
    };
})(typeof window !== 'undefined' ? window : global);

window.__adminUsersById = {};
let __adminLoginPhoneOtpToken = null;
let __adminLoginEmailOtpToken = null;
let __adminBehalfSaveTimer = null;
let __adminSensitivePhoneOtpToken = null;
let __adminSensitiveEmailOtpToken = null;
let __requireAdminSensitiveOtp = false;
let __requireBehalfApplicantOtp = true;

const ADMIN_REGISTRATION_STATUSES = [
    { value: 'submitted', label: 'Submitted' },
    { value: 'pending_approval', label: 'Under admin review' },
    { value: 'revision_required', label: 'Documents need re-upload' },
    { value: 'approved_pending_payment', label: 'Approved — payment due' },
    { value: 'completed', label: 'Payment completed' },
    { value: 'e_ticket_issued', label: 'E-ticket issued' },
    { value: 'certificate_issued', label: 'Certificate issued' },
    { value: 'checked_in', label: 'Checked in' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'cancelled', label: 'Cancelled' }
];

function adminRegistrationStatusOptionsHtml(current) {
    const cur = String(current || '').toLowerCase();
    return ADMIN_REGISTRATION_STATUSES.map((s) => {
        const sel = cur === s.value ? ' selected' : '';
        return '<option value="' + s.value + '"' + sel + '>' + s.label + '</option>';
    }).join('');
}

function getStoredAdminUser() {
    try {
        return JSON.parse(localStorage.getItem('admin_user') || '{}');
    } catch (_) {
        return {};
    }
}

function resetAdminSensitiveOtpTokens() {
    __adminSensitivePhoneOtpToken = null;
    __adminSensitiveEmailOtpToken = null;
}

function isStaffUserRoleClient(userRole) {
    return !isDoctorAccount({ user_role: userRole, role: userRole === 'co_admin' ? 'admin' : 'doctor' });
}

function isStaffUserRecord(u) {
    if (!u) return false;
    return isStaffUserRoleClient(u.user_role || u.role);
}

function sensitiveOtpFieldIds(ctx) {
    if (ctx === 'behalf') {
        return {
            phoneCode: 'beh-sens-phone-otp',
            emailCode: 'beh-sens-email-otp',
            phoneOk: 'beh-sens-phone-ok',
            emailOk: 'beh-sens-email-ok'
        };
    }
    if (ctx === 'proxy') {
        return {
            phoneCode: 'proxy-sens-phone-otp',
            emailCode: 'proxy-sens-email-otp',
            phoneOk: 'proxy-sens-phone-ok',
            emailOk: 'proxy-sens-email-ok'
        };
    }
    return {
        phoneCode: 'cau-sens-phone-otp',
        emailCode: 'cau-sens-email-otp',
        phoneOk: 'cau-sens-phone-ok',
        emailOk: 'cau-sens-email-ok'
    };
}

let __proxyApplicantPhoneOtpToken = '';
let __proxyApplicantEmailOtpToken = '';
let __behalfApplicantPhoneOtpToken = '';
let __behalfApplicantEmailOtpToken = '';
let __proxyLastRegId = null;
let __proxyLastUserId = null;
let __proxyPaymentAmount = 0;
let __proxySelectedMethodId = 'dqr';
let __proxyLastOrderDbId = null;
let __proxyPollTimer = null;

function resetProxyApplicantOtpTokens() {
    __proxyApplicantPhoneOtpToken = '';
    __proxyApplicantEmailOtpToken = '';
    ['proxy-app-phone-ok', 'proxy-app-email-ok'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

function onProxyUserSelected() {
    const uid = parseInt((document.getElementById('proxy-user-select') || {}).value, 10);
    const u = window.__adminUsersById && window.__adminUsersById[uid];
    if (!u) return;
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };
    set('proxy-fname', u.first_name);
    set('proxy-lname', u.last_name);
    set('proxy-email', u.email);
    set('proxy-phone', u.phone);
    resetProxyApplicantOtpTokens();
}

async function refreshAdminSensitiveOtpRequirement() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) {
        __requireAdminSensitiveOtp = false;
        __requireBehalfApplicantOtp = true;
        return;
    }
    try {
        const res = await fetch(`/api/admin/portal-auth-config?actingAdminId=${encodeURIComponent(adm.id)}`);
        const d = await res.json();
        __requireAdminSensitiveOtp = !!(d.success && d.config && d.config.requireAdminOtpForSensitive);
        __requireBehalfApplicantOtp = !(d.success && d.config && d.config.requireBehalfApplicantOtp === false);
    } catch (_) {
        __requireAdminSensitiveOtp = false;
        __requireBehalfApplicantOtp = true;
    }
    const wrapCreate = document.getElementById('newuser-admin-otp-wrap');
    const roleSel = document.getElementById('newuser-role');
    const creatingStaff =
        window.__adminCreateUserKind === 'staff' ||
        (roleSel && isStaffUserRoleClient(roleSel.value));
    const show = !!__requireAdminSensitiveOtp && !creatingStaff;
    if (wrapCreate) wrapCreate.style.display = show ? 'block' : 'none';
    if (!show) resetAdminSensitiveOtpTokens();
    const behalfOtpWrap = document.getElementById('behalf-applicant-otp-wrap');
    if (behalfOtpWrap) {
        behalfOtpWrap.style.display = __requireBehalfApplicantOtp ? 'block' : 'none';
        if (!__requireBehalfApplicantOtp) resetBehalfApplicantOtpTokens();
    }
    const saveSt = document.getElementById('behalf-save-status');
    if (saveSt && !__requireBehalfApplicantOtp) {
        saveSt.textContent = 'Applicant OTP is disabled — click Save application when ready.';
    }
}

function resetBehalfApplicantOtpTokens() {
    __behalfApplicantPhoneOtpToken = '';
    __behalfApplicantEmailOtpToken = '';
    ['behalf-app-phone-ok', 'behalf-app-email-ok'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

function behalfApplicantContact(channel) {
    const key = channel === 'phone' ? 'phone' : 'email';
    const el = document.getElementById('behalf-f-' + key);
    if (el && String(el.value || '').trim()) return String(el.value).trim();
    const docId = parseInt((document.getElementById('behalf-doctor-select') || {}).value, 10);
    const u = window.__adminUsersById && window.__adminUsersById[docId];
    if (!u) return '';
    return channel === 'phone' ? String(u.phone || '').trim() : String(u.email || '').trim();
}

async function behalfSendApplicantOtp(channel) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const sid = parseInt((document.getElementById('behalf-seminar-select') || {}).value, 10);
    if (!Number.isInteger(sid) || sid < 1) return alert('Select a seminar first.');
    const destination = behalfApplicantContact(channel);
    if (!destination) {
        return alert(channel === 'phone' ? 'Enter applicant phone on the form.' : 'Enter applicant email on the form.');
    }
    try {
        const res = await fetch('/api/admin/proxy-otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: adm.id, channel, destination, seminarId: sid })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not send OTP.');
        if (data.debugCode) console.info('Behalf applicant OTP:', data.debugCode);
        if (window.OtpUi) {
            window.OtpUi.notifyOtpSent(channel, data, {
                customMessage:
                    channel === 'phone'
                        ? 'OTP sent to the applicant’s WhatsApp.'
                        : 'OTP sent to the applicant’s email.'
            });
        } else {
            alert(channel === 'phone' ? 'OTP sent to applicant WhatsApp.' : 'OTP sent to applicant email.');
        }
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function behalfVerifyApplicantOtp(channel) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const sid = parseInt((document.getElementById('behalf-seminar-select') || {}).value, 10);
    if (!Number.isInteger(sid) || sid < 1) return alert('Select a seminar first.');
    const destination = behalfApplicantContact(channel);
    const codeEl = document.getElementById(channel === 'phone' ? 'behalf-app-phone-otp' : 'behalf-app-email-otp');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!destination || !code) return alert('Enter destination and OTP code.');
    try {
        const res = await fetch('/api/admin/proxy-otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: adm.id, channel, destination, code, seminarId: sid })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Verification failed.');
        if (channel === 'phone') __behalfApplicantPhoneOtpToken = data.token;
        else __behalfApplicantEmailOtpToken = data.token;
        const okEl = document.getElementById(channel === 'phone' ? 'behalf-app-phone-ok' : 'behalf-app-email-ok');
        if (okEl) okEl.textContent = '✓ Verified';
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function adminSendSensitiveOtp(channel, ctx) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const res = await fetch('/api/admin/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: adm.id, channel })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Could not send code.');
    if (data.debugCode) console.info('Admin sensitive OTP debug:', data.debugCode);
    if (data.warning) alert(data.warning);
}

async function adminVerifySensitiveOtp(channel, ctx) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const ids = sensitiveOtpFieldIds(ctx || 'create');
    const codeEl = document.getElementById(channel === 'email' ? ids.emailCode : ids.phoneCode);
    const okEl = document.getElementById(channel === 'email' ? ids.emailOk : ids.phoneOk);
    const code = String((codeEl || {}).value || '').trim();
    if (!code) return alert('Enter the code.');
    const res = await fetch('/api/admin/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: adm.id, channel, code })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Invalid code.');
    if (channel === 'email') __adminSensitiveEmailOtpToken = data.token;
    else __adminSensitivePhoneOtpToken = data.token;
    if (okEl) okEl.textContent = 'Verified';
}

function isSuperAdminUser() {
    const u = getStoredAdminUser();
    return String(u.role || '').toLowerCase() === 'admin' && String(u.user_role || '').toLowerCase() !== 'co_admin';
}

function adminCanDeleteUsers() {
    const u = getStoredAdminUser();
    if (!u || !u.id) return false;
    const ur = String(u.user_role || '').toLowerCase();
    const r = String(u.role || '').toLowerCase();
    return (r === 'admin' && ur !== 'co_admin') || ur === 'co_admin';
}

async function adminDeleteUserAccount(userId, displayName, portalId) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    if (!adminCanDeleteUsers()) {
        return alert('Only Super Admin or Co Admin can permanently delete accounts.');
    }
    const expected = String(portalId || '').trim();
    if (!expected) return alert('Portal ID missing for this user.');
    const typed = prompt(
        'PERMANENT DELETE\n\n' +
            'User: ' +
            (displayName || 'Account') +
            '\nPortal ID: ' +
            expected +
            '\n\nThis removes registrations, orders, tickets, certificates, case submissions, support tickets, and the login account.\n\nType the portal ID exactly to confirm:',
        ''
    );
    if (typed === null) return;
    if (String(typed).trim().toLowerCase() !== expected.toLowerCase()) {
        return alert('Portal ID did not match. Deletion cancelled.');
    }
    if (!confirm('Delete account ' + expected + ' permanently? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/admin/users/' + encodeURIComponent(userId) + '/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, confirmPortalId: String(typed).trim() })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Delete failed');
        alert(data.message || 'Account deleted.');
        closeAdminUserDetailModal();
        __adminUserDetailCache = null;
        loadUsers();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

function adminCanAccessTab(tabId) {
    let checkId = tabId === 'tab-seminar-details' ? 'tab-seminars' : tabId;
    if (checkId === 'tab-users') checkId = 'tab-staff-users';
    const globalPages = window.__adminEnabledPages || {};
    const globalKeys = Object.keys(globalPages);
    if (globalKeys.length) {
        const anyOn = globalKeys.some((k) => globalPages[k] === true);
        if (anyOn && globalPages[checkId] !== true) return false;
    }
    const u = getStoredAdminUser();
    if (String(u.user_role || '').toLowerCase() !== 'co_admin') return true;
    let raw = {};
    try {
        if (u.admin_modules && String(u.admin_modules).trim()) raw = JSON.parse(u.admin_modules);
    } catch (_) {
        raw = {};
    }
    if (!raw || typeof raw !== 'object') return true;
    const keys = Object.keys(raw);
    if (keys.length === 0) return true;
    return raw[checkId] === true;
}

function applyCoAdminSidebarVisibility() {
    document.querySelectorAll('.menu-item[data-admin-module]').forEach((el) => {
        const m = el.getAttribute('data-admin-module');
        if (!m) return;
        if (!adminCanAccessTab(m)) el.classList.add('hidden');
        else el.classList.remove('hidden');
    });
}

async function refreshAdminLoginOtpPanel() {
    const panel = document.getElementById('admin_login_otp_panel');
    if (!panel) return;
    panel.style.display = 'none';
}

window.onload = () => {
    refreshAdminLoginOtpPanel();
    if (localStorage.getItem('admin_auth')) {
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('dashboard-main').classList.remove('hidden');
        loadAllData();
        loadPortalAuthAdminForm()
            .then(() => applyCoAdminSidebarVisibility())
            .catch(() => applyCoAdminSidebarVisibility());
        refreshAdminSensitiveOtpRequirement();
    }
};

function wireAdminLoginOtpButtons() {
    const sendE = document.getElementById('admin-send-login-email-otp');
    const sendP = document.getElementById('admin-send-login-phone-otp');
    const resendE = document.getElementById('admin-resend-login-email-otp');
    const resendP = document.getElementById('admin-resend-login-phone-otp');
    const verE = document.getElementById('admin-verify-login-email-otp');
    const verP = document.getElementById('admin-verify-login-phone-otp');
    if (sendE)
        sendE.onclick = () =>
            adminSendLoginOtp('email').catch((e) => {
                console.error(e);
            });
    if (sendP)
        sendP.onclick = () =>
            adminSendLoginOtp('phone').catch((e) => {
                console.error(e);
            });
    if (resendE)
        resendE.onclick = () =>
            adminSendLoginOtp('email').catch((e) => {
                console.error(e);
            });
    if (resendP)
        resendP.onclick = () =>
            adminSendLoginOtp('phone').catch((e) => {
                console.error(e);
            });
    if (verE)
        verE.onclick = () =>
            adminVerifyLoginOtp('email').catch((e) => {
                console.error(e);
            });
    if (verP)
        verP.onclick = () =>
            adminVerifyLoginOtp('phone').catch((e) => {
                console.error(e);
            });
}
wireAdminLoginOtpButtons();

async function adminSendLoginOtp(channel) {
    const email = String((document.getElementById('admin-email') || {}).value || '')
        .trim()
        .toLowerCase();
    const password = (document.getElementById('admin-password') || {}).value;
    if (!email || !password) return alert('Enter email and password first.');
    const res = await fetch('/api/auth/login-otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, channel })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Could not send code.');
    if (data.debugCode) console.info('Admin login OTP debug:', data.debugCode);
    if (data.warning) alert(data.warning);
}

async function adminVerifyLoginOtp(channel) {
    const email = String((document.getElementById('admin-email') || {}).value || '')
        .trim()
        .toLowerCase();
    const password = (document.getElementById('admin-password') || {}).value;
    const codeEl = document.getElementById(channel === 'email' ? 'admin_login_email_otp' : 'admin_login_phone_otp');
    const okEl = document.getElementById(channel === 'email' ? 'admin_login_email_otp_ok' : 'admin_login_phone_otp_ok');
    const code = String((codeEl || {}).value || '').trim();
    if (!email || !password || !code) return alert('Enter email, password, and the code.');
    const res = await fetch('/api/auth/login-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, channel, code })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Invalid code.');
    if (channel === 'email') __adminLoginEmailOtpToken = data.token;
    else __adminLoginPhoneOtpToken = data.token;
    if (okEl) okEl.textContent = 'Verified';
}

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('admin-email').value.trim().toLowerCase();
    const password = document.getElementById('admin-password').value;
    const body = { email, password, portal: 'admin' };
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let data = {};
        if (ct.includes('application/json')) {
            try {
                data = await res.json();
            } catch (_) {
                data = {};
            }
        } else {
            const snippet = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
            if (res.status === 503 || /maintenance/i.test(snippet)) {
                alert(
                    'The site is in maintenance mode and returned a web page instead of login data. Open the admin page from the same address as your server (e.g. http://localhost:3000/admin.html) and try again.'
                );
            } else {
                alert(
                    'Login did not receive JSON from the server. Open admin from the app URL (not as a local file). Example: http://localhost:3000/admin.html'
                );
            }
            return;
        }
        if (!res.ok) {
            alert(data.error || 'Invalid credentials');
            return;
        }
        if (!data.user) {
            alert('Unexpected login response from server.');
            return;
        }
        const role = String(data.user.role || '').toLowerCase();
        const userRole = String(data.user.user_role || '').toLowerCase();
        if (role !== 'admin' && userRole !== 'co_admin') {
            alert('This account does not have admin portal access.');
            return;
        }
        localStorage.setItem('admin_auth', 'true');
        localStorage.setItem('admin_user', JSON.stringify(data.user));
        __adminLoginPhoneOtpToken = null;
        __adminLoginEmailOtpToken = null;
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('dashboard-main').classList.remove('hidden');
        loadAllData();
        applyCoAdminSidebarVisibility();
    } catch (err) {
        console.error(err);
        alert('Could not reach the server. Make sure it is running (e.g. node server.js).');
    }
});

document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('admin_auth');
    localStorage.removeItem('admin_user');
    location.reload();
});

function switchTab(tabId) {
    if (!adminCanAccessTab(tabId)) {
        alert(
            'You do not have access to this module. Ask the super administrator to enable it under Users & CRM → Modules (co-admin accounts only).'
        );
        return;
    }
    if (liveScansInterval) clearInterval(liveScansInterval);
    document.querySelectorAll('.tab-pane').forEach((t) => t.classList.add('hidden'));
    document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('active'));
    document.getElementById(tabId).classList.remove('hidden');
    if (typeof event !== 'undefined' && event && event.currentTarget) event.currentTarget.classList.add('active');
    if (tabId === 'tab-behalf-reg' || tabId === 'tab-site-cms') {
        refreshAdminSensitiveOtpRequirement();
    }
    if (tabId === 'tab-staff-users' || tabId === 'tab-doctors') {
        loadUsers();
    }
}

let adminAutoRefreshInterval = null;

function startAdminAutoRefresh() {
    if (adminAutoRefreshInterval) clearInterval(adminAutoRefreshInterval);
    adminAutoRefreshInterval = setInterval(() => {
        const applicationsTabVisible = !document.getElementById('tab-applications').classList.contains('hidden');
        const seminarDetailsTabVisible = !document.getElementById('tab-seminar-details').classList.contains('hidden');

        if (applicationsTabVisible) loadApplications();
        if (seminarDetailsTabVisible && currentManageSeminarId) refreshSeminarDashboard();
    }, 15000);
}

async function refreshSeminarDashboard() {
    if (!currentManageSeminarId) return;
    try {
        const res = await fetch('/api/admin/seminars/' + currentManageSeminarId + '/stats');
        const stats = await res.json();
        document.getElementById('stat-pending-apps').innerText = stats.pending_apps || 0;
        document.getElementById('stat-approved-apps').innerText = stats.approved_apps || 0;
        document.getElementById('stat-pending-payments').innerText = stats.pending_payments || 0;
        document.getElementById('stat-revenue').innerText = '₹' + (stats.total_revenue || 0);
        const seatsEl = document.getElementById('stat-seats');
        if (seatsEl) {
            if (stats.unlimited_seats) seatsEl.textContent = (stats.filled || 0) + ' / ∞';
            else if (stats.capacity > 0) {
                seatsEl.textContent = (stats.filled || 0) + ' / ' + stats.capacity;
                seatsEl.style.color = stats.seats_full ? '#b91c1c' : '#7c3aed';
            } else seatsEl.textContent = (stats.filled || 0) + ' (no cap)';
        }
    } catch (err) {
        console.error(err);
    }
    try {
        const res = await fetch('/api/admin/seminars/' + currentManageSeminarId + '/applications');
        currentSeminarApps = await res.json();
        const tbody = document.getElementById('detail-applications-list');
        tbody.innerHTML = '';
        if (currentSeminarApps.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No applications for this seminar.</td></tr>';
            return;
        }

        currentSeminarApps.forEach((a) => {
            let formData = {};
            try { formData = JSON.parse(a.form_data || '{}'); } catch(e) {}
            const candidateName = formData.fname ? `${formData.fname} ${formData.lname || ''}` : `${a.first_name || ''} ${a.last_name || ''}`;

            tbody.innerHTML += `
                <tr>
                    <td><strong>${a.application_no}</strong></td>
                    <td>${candidateName}</td>
                    <td>${a.status.toUpperCase()}</td>
                    <td><button class="btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="switchTab('tab-applications')">Go to Main Review</button></td>
                </tr>
            `;
        });
    } catch (err) {
        console.error(err);
    }
}

function isDoctorAccount(u) {
    if (!u) return false;
    if (u.account_list === 'staff') return false;
    if (u.account_list === 'doctors') return true;
    if (typeof UserRoles !== 'undefined' && UserRoles.isDoctorPortalAccount) {
        return UserRoles.isDoctorPortalAccount(u);
    }
    const ur = String(u.user_role || '')
        .trim()
        .toLowerCase();
    const r = String(u.role || '')
        .trim()
        .toLowerCase();
    const staffRoles = [
        'co_admin',
        'judge_user',
        'scanner_portal_user',
        'scanner_dashboard_user',
        'reviewer',
        'admin'
    ];
    if (staffRoles.includes(ur) || staffRoles.includes(r)) return false;
    if (r === 'admin' && ur !== 'doctor') return false;
    if (ur === 'doctor' || ur === 'event_attendee') return true;
    return r === 'doctor' && !ur;
}

function adminDemoAccountsEnabled() {
    return window.__allowDemoAccounts !== false;
}

function adminUserStatusBadge(u) {
    const demo =
        adminDemoAccountsEnabled() && Number(u.is_demo) === 1
            ? ' <span style="background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:6px;font-size:0.72rem;margin-left:4px;">DUMMY</span>'
            : '';
    if (Number(u.is_banned) === 1) {
        return `<span style="color:#7f1d1d;font-weight:bold;">BANNED</span>${demo}`;
    }
    return u.is_disabled
        ? `<span style="color:red;font-weight:bold;">DISABLED</span>${demo}`
        : `<span style="color:green;font-weight:bold;">ACTIVE</span>${demo}`;
}

function adminUserToggleBtn(u) {
    return u.is_disabled
        ? `<button class="btn-success" onclick="toggleDisable(${u.id}, false)">Enable</button>`
        : `<button class="btn-danger" onclick="toggleDisable(${u.id}, true)">Disable</button>`;
}

function openAdminCreateUserModal(kind) {
    const modal = document.getElementById('admin-create-user-modal');
    const roleSel = document.getElementById('newuser-role');
    if (!modal) return;
    window.__adminCreateUserKind = kind === 'doctor' ? 'doctor' : 'staff';
    const staffDupHint = document.getElementById('newuser-staff-dup-hint');
    if (staffDupHint) staffDupHint.style.display = kind === 'staff' ? 'block' : 'none';
    resetAdminSensitiveOtpTokens();
    ['cau-sens-phone-ok', 'cau-sens-email-ok', 'beh-sens-phone-ok', 'beh-sens-email-ok'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    refreshAdminSensitiveOtpRequirement();
    if (roleSel) {
        Array.from(roleSel.options).forEach((opt) => {
            const isDoc = opt.value === 'doctor';
            const isEmpty = !opt.value;
            if (kind === 'doctor') {
                opt.hidden = !isDoc && !isEmpty;
            } else {
                opt.hidden = isDoc || isEmpty;
            }
        });
        roleSel.value = kind === 'doctor' ? 'doctor' : 'judge_user';
        roleSel.required = true;
        if (!roleSel.__otpRoleBound) {
            roleSel.__otpRoleBound = true;
            roleSel.addEventListener('change', () => refreshAdminSensitiveOtpRequirement());
        }
    }
    const title = modal.querySelector('h2');
    if (title) title.textContent = kind === 'doctor' ? 'Register new doctor' : 'Register new staff user';
    modal.classList.remove('hidden');
}

function formatAdminAccountDateTime(iso) {
    if (!iso) return '—';
    if (window.PortalDateTime && window.PortalDateTime.format) {
        return window.PortalDateTime.format(iso);
    }
    try {
        return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    } catch (_) {
        return String(iso);
    }
}

function adminAccountActivationLabel(u) {
    if (u && u.activated_at) return formatAdminAccountDateTime(u.activated_at);
    if (u && Number(u.email_verified) === 0) return 'Pending verification';
    return '—';
}

async function loadUsers() {
    try {
        const res = await fetch('/api/admin/users');
        const users = await res.json();
        const staffBody = document.getElementById('staff-users-list');
        const doctorsBody = document.getElementById('doctors-list');
        const proxySelect = document.getElementById('proxy-user-select');
        if (staffBody) staffBody.innerHTML = '';
        if (doctorsBody) doctorsBody.innerHTML = '';
        if (proxySelect) proxySelect.innerHTML = '<option value="">Select a user...</option>';
        window.__adminUsersById = {};

        if (!res.ok || !Array.isArray(users)) {
            const err = (users && users.error) || 'Could not load users';
            if (staffBody) {
                staffBody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#b91c1c;">${escAdmin(err)}</td></tr>`;
            }
            if (doctorsBody) {
                doctorsBody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#b91c1c;">${escAdmin(err)}</td></tr>`;
            }
            return;
        }

        const staff = [];
        const doctors = [];
        users.forEach((u) => {
            window.__adminUsersById[u.id] = u;
            if (isDoctorAccount(u)) doctors.push(u);
            else staff.push(u);
        });
        window.__adminStaffUsers = staff;
        window.__adminDoctorUsers = doctors;
        window.__adminUsersCounts = { staff: staff.length, doctors: doctors.length };

        if (staffBody) {
            renderStaffUsersTable(staff);
        }

        if (doctorsBody) {
            renderDoctorsUsersTable();
        }
        if (window.__highlightAdminUserId) {
            window.__highlightAdminUserId = null;
        }
    } catch (err) {
        console.error(err);
        const staffBody = document.getElementById('staff-users-list');
        if (staffBody) {
            staffBody.innerHTML =
                '<tr><td colspan="9" style="text-align:center;">Could not load users. Hard refresh (Ctrl+F5) and try again.</td></tr>';
        }
    }
}

function adminStaffUserRoleValue(u) {
    if (typeof UserRoles !== 'undefined' && UserRoles.effectiveUserRole) {
        const eff = UserRoles.effectiveUserRole(u);
        if (eff) return eff;
    }
    const ur = String((u && u.user_role) || '').trim().toLowerCase();
    const r = String((u && u.role) || '').trim().toLowerCase();
    const staffVals = [
        'judge_user',
        'co_admin',
        'scanner_portal_user',
        'scanner_dashboard_user',
        'reviewer'
    ];
    if (staffVals.includes(ur)) return ur;
    if (staffVals.includes(r)) return r;
    return ur || r || 'judge_user';
}

function adminClearStaffUsersSearch() {
    const el = document.getElementById('staff-users-search');
    if (el) el.value = '';
    renderStaffUsersTable(window.__adminStaffUsers || []);
}

function renderStaffUsersTable(staffList) {
    const staffBody = document.getElementById('staff-users-list');
    if (!staffBody) return;
    const q = String((document.getElementById('staff-users-search') || {}).value || '')
        .trim()
        .toLowerCase();
    let rows = staffList || window.__adminStaffUsers || [];
    if (q) {
        rows = rows.filter((u) => {
            const blob = [
                u.user_id_string,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.user_role,
                u.role
            ]
                .join(' ')
                .toLowerCase();
            return blob.includes(q);
        });
    }
    const countEl = document.getElementById('staff-users-count');
    const total = (window.__adminStaffUsers || staffList || []).length;
    if (countEl) {
        countEl.textContent = q
            ? `${rows.length} of ${total} staff account${total === 1 ? '' : 's'}`
            : `${total} staff account${total === 1 ? '' : 's'}`;
    }
    if (!total) {
        staffBody.innerHTML =
            '<tr><td colspan="9" style="text-align:center;">No staff users yet. Use “+ Create staff user” and pick Judge / Co Admin / Scanner / Reviewer.</td></tr>';
        return;
    }
    if (!rows.length) {
        staffBody.innerHTML =
            '<tr><td colspan="9" style="text-align:center;">No staff users match this search. ' +
            (total
                ? `${total} staff account${total === 1 ? '' : 's'} exist — <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.82rem;" onclick="adminClearStaffUsersSearch()">Clear search</button> to show all. Also check the <strong>Doctors</strong> tab if the account was saved as Doctor.</td></tr>`
                : '</td></tr>');
        return;
    }
    staffBody.innerHTML = '';
    rows.forEach((u) => {
        const hi =
            window.__highlightAdminUserId && Number(u.id) === Number(window.__highlightAdminUserId)
                ? ' style="background:#ecfdf5;"'
                : '';
        const userRole = adminStaffUserRoleValue(u);
        const modulesBtn =
            isSuperAdminUser() && String(userRole).toLowerCase() === 'co_admin'
                ? `<button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#0d9488;" onclick="openAdminModulesModal(${u.id})">Modules</button>`
                : '';
        staffBody.innerHTML += `
                <tr${hi}>
                    <td><strong>${u.user_id_string}</strong></td>
                    <td>${escAdmin(u.first_name)} ${escAdmin(u.last_name)}</td>
                    <td>${escAdmin(u.email)}</td>
                    <td>${escAdmin(u.phone || '—')}</td>
                    <td style="white-space:nowrap;font-size:0.82rem;">${formatAdminAccountDateTime(u.created_at)}</td>
                    <td style="white-space:nowrap;font-size:0.82rem;">${adminAccountActivationLabel(u)}</td>
                    <td>
                        <select onchange="updateUserRole(${u.id}, this.value)" style="width:100%;padding:5px;border-radius:4px;border:1px solid #ccc;">
                            <option value="judge_user" ${userRole === 'judge_user' ? 'selected' : ''}>Judge</option>
                            <option value="co_admin" ${userRole === 'co_admin' ? 'selected' : ''}>Co Admin</option>
                            <option value="scanner_portal_user" ${userRole === 'scanner_portal_user' ? 'selected' : ''}>Scanner (volunteer)</option>
                            <option value="scanner_dashboard_user" ${userRole === 'scanner_dashboard_user' ? 'selected' : ''}>Live scanner dashboard</option>
                            <option value="reviewer" ${userRole === 'reviewer' ? 'selected' : ''}>Reviewer</option>
                            <option value="doctor" ${userRole === 'doctor' ? 'selected' : ''}>Doctor (doctor portal)</option>
                        </select>
                    </td>
                    <td>${adminUserStatusBadge(u)}</td>
                    <td>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-right:6px;" onclick="openAdminUserDetail(${u.id})">View</button>
                        ${adminUserToggleBtn(u)}${modulesBtn}
                        ${
                            adminCanDeleteUsers()
                                ? `<button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#b91c1c;" onclick="adminDeleteUserAccount(${u.id}, '${String((u.first_name || '') + ' ' + (u.last_name || '')).trim().replace(/'/g, "\\'")}', '${String(u.user_id_string || '').replace(/'/g, "\\'")}')">Delete</button>`
                                : ''
                        }
                    </td>
                </tr>`;
    });
}

function adminFilterStaffUsersList() {
    renderStaffUsersTable(window.__adminStaffUsers || []);
}

function adminApplyLookupMatch(u, accountList) {
    const msg = document.getElementById('admin-user-lookup-msg');
    const matchesBox = document.getElementById('admin-user-lookup-matches');
    if (matchesBox) matchesBox.innerHTML = '';
    if (msg) {
        msg.style.color = '#047857';
        msg.textContent = `${u.first_name} ${u.last_name} — ${u.user_id_string} — role ${u.effective_user_role || u.user_role || u.role} — under “${accountList === 'staff' ? 'Staff users' : 'Doctors'}”.`;
    }
    adminClearStaffUsersSearch();
    window.__highlightAdminUserId = u.id;
    switchTab(accountList === 'staff' ? 'tab-staff-users' : 'tab-doctors');
    loadUsers();
}

function adminRenderLookupMatches(matches) {
    const box = document.getElementById('admin-user-lookup-matches');
    if (!box || !matches || matches.length < 2) {
        if (box) box.innerHTML = '';
        return;
    }
    window.__adminLookupMatches = matches;
    box.innerHTML =
        '<p style="font-size:0.85rem;color:#64748b;margin:0 0 6px;">Multiple accounts — click to open:</p>' +
        matches
            .map((u, i) => {
                const label = `${escAdmin(u.first_name)} ${escAdmin(u.last_name)} · ${escAdmin(u.user_id_string)} · ${escAdmin(u.email || '')} · ${escAdmin(u.effective_user_role || u.user_role || u.role)} (${u.account_list === 'staff' ? 'Staff' : 'Doctors'})`;
                return `<button type="button" class="btn-secondary" style="display:block;width:100%;text-align:left;margin:4px 0;padding:8px 10px;" onclick="adminPickLookupMatch(${i})">${label}</button>`;
            })
            .join('');
}

function adminPickLookupMatch(index) {
    const matches = window.__adminLookupMatches || [];
    const u = matches[index];
    if (!u) return;
    adminApplyLookupMatch(u, u.account_list || 'staff');
}

async function adminLookupUserByEmail() {
    const input = document.getElementById('admin-user-lookup');
    const msg = document.getElementById('admin-user-lookup-msg');
    const matchesBox = document.getElementById('admin-user-lookup-matches');
    const raw = String((input && input.value) || '').trim();
    if (!raw) return alert('Enter email, portal ID, phone, or name (e.g. Nitin).');
    if (matchesBox) matchesBox.innerHTML = '';
    try {
        const res = await fetch('/api/admin/users/lookup?q=' + encodeURIComponent(raw));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');
        if (!data.found) {
            if (msg) {
                msg.style.color = '#b91c1c';
                msg.textContent =
                    data.hint ||
                    'No account in the database. Hard refresh (Ctrl+F5), then search by name, email, or phone. Portal ID 533520779781 is not saved — recreate the staff user or find Nitin under Doctors.';
            }
            return;
        }
        if (data.multiple && data.matches && data.matches.length > 1) {
            if (msg) {
                msg.style.color = '#0369a1';
                msg.textContent = data.hint || `${data.matches.length} accounts found.`;
            }
            adminRenderLookupMatches(data.matches);
            return;
        }
        adminApplyLookupMatch(data.user, data.accountList);
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message || 'Lookup failed';
        }
    }
}

async function toggleAdminUserDemo(userId, enable) {
    const isDemo = enable === true || enable === 1 || enable === '1' || enable === 'true';
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    try {
        const res = await fetch('/api/admin/users/toggle_demo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: parseInt(userId, 10), isDemo, actingAdminId: adm.id })
        });
        let data = {};
        const text = await res.text();
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            return alert('Server error: ' + (text.slice(0, 200) || res.status));
        }
        if (!res.ok) return alert(data.error || 'Failed to update demo flag');
        if (__adminUserDetailCache && __adminUserDetailCache.user) {
            __adminUserDetailCache.user.is_demo = isDemo ? 1 : 0;
        }
        renderAdminUserDetailTab();
        loadUsers();
    } catch (e) {
        console.error(e);
        alert('Network error: ' + (e.message || 'Could not reach server. Restart the server and try again.'));
    }
}

async function updateUserRole(userId, newRole) {
    try {
        const res = await fetch(`/api/admin/users/${userId}/role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_role: newRole })
        });
        const result = await res.json();
        if (result.success) {
            const tab =
                newRole === 'doctor' ? 'tab-doctors' : 'tab-staff-users';
            if (newRole === 'doctor') {
                alert(`Role updated to Doctor. Account is now under the Doctors tab (doctor portal login).`);
            } else {
                alert(`Role updated to ${newRole}. Account is under Staff users.`);
            }
            switchTab(tab);
            window.__highlightAdminUserId = userId;
            loadUsers();
            if (__adminUserDetailCache && __adminUserDetailCache.user && Number(__adminUserDetailCache.user.id) === Number(userId)) {
                __adminUserDetailCache.user.user_role = newRole;
                renderAdminUserDetailTab();
            }
        } else {
            alert('Error: ' + result.error);
        }
    } catch(err) {
        console.error(err);
        alert('Error updating role');
    }
}

async function adminMoveUserToStaffRole(userId) {
    const sel = document.getElementById('admin-edit-staff-role');
    const newRole = sel ? sel.value : 'judge_user';
    if (!newRole) return alert('Choose a staff role.');
    await updateUserRole(userId, newRole);
    switchTab('tab-staff-users');
    window.__highlightAdminUserId = userId;
    loadUsers();
}

async function adminMoveUserToDoctorPortal(userId) {
    if (!confirm('Move this account to the Doctor portal? They will sign in at the doctor login page (not staff portals).')) return;
    await updateUserRole(userId, 'doctor');
    switchTab('tab-doctors');
    window.__highlightAdminUserId = userId;
    loadUsers();
}

async function saveDoctorAccess(userId, doctorCategory, doctorModules) {
    try {
        const res = await fetch(`/api/admin/users/${userId}/doctor-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                doctor_category: doctorCategory,
                doctor_modules: doctorModules || {}
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) return { ok: false, error: data.error || 'Could not save doctor access.' };
        return { ok: true, data };
    } catch (_) {
        return { ok: false, error: 'Network error saving doctor access.' };
    }
}

async function saveDoctorAccessFromList(userId) {
    const sel = document.getElementById('doctor-cat-' + userId);
    if (!sel) return;
    const category = sel.value === 'volunteer' ? 'volunteer' : 'regular';
    const r = await saveDoctorAccess(userId, category, {});
    if (!r.ok) return alert(r.error);
    await loadUsers();
    alert('Doctor access updated.');
}

async function saveDoctorAccessFromDetail(userId) {
    const catEl = document.getElementById('admin-edit-doc-category');
    const category = catEl && catEl.value === 'volunteer' ? 'volunteer' : 'regular';
    const modules = {};
    document.querySelectorAll('#admin-edit-doc-modules input[data-doc-mod]').forEach((inp) => {
        const id = inp.getAttribute('data-doc-mod');
        if (id && inp.checked) modules[id] = true;
    });
    const r = await saveDoctorAccess(userId, category, modules);
    if (!r.ok) return alert(r.error);
    if (__adminUserDetailCache && __adminUserDetailCache.user && Number(__adminUserDetailCache.user.id) === Number(userId)) {
        __adminUserDetailCache.user.doctor_category = category;
        __adminUserDetailCache.user.doctor_modules = JSON.stringify(r.data.doctor_modules || modules || {});
    }
    await loadUsers();
    alert('Doctor access saved.');
}

const WEBSITE_MENU_PAGE_DEFS = [
    ['home', 'Home'],
    ['about', 'Foundation'],
    ['schedule', 'Agenda'],
    ['gallery', 'Gallery'],
    ['verify', 'Delegates (participant search)'],
    ['certificate', 'Certificate verification'],
    ['contact', 'Contact']
];

const ADMIN_MODULE_TAB_DEFS = [
    ['tab-staff-users', 'Staff users'],
    ['tab-doctors', 'Doctors'],
    ['tab-seminars', 'Seminar management'],
    ['tab-event-schedules', 'Event schedules'],
    ['tab-applications', 'Review applications'],
    ['tab-feedback', 'Seminar feedback'],
    ['tab-support-tickets', 'Support tickets'],
    ['tab-contact-inquiries', 'Website contact'],
    ['tab-email-compose', 'Send email'],
    ['tab-transfer', 'Transfer applications'],
    ['tab-behalf-reg', 'Doctor applications (admin workspace)'],
    ['tab-reg-form', 'Registration form fields'],
    ['tab-site-cms', 'Website & doctor updates'],
    ['tab-admin-payments', 'Payments'],
    ['tab-certificates', 'Certificate management'],
    ['tab-volunteers', 'Volunteers'],
    ['tab-volunteer-assignments', 'Volunteer assignments'],
    ['tab-case-mgmt', 'Case management'],
    ['tab-analytics', 'Analytics'],
    ['tab-reports', 'Reports & exports'],
    ['tab-etickets', 'E-tickets'],
    ['tab-scanner-logs', 'Scanner activity'],
    ['tab-live-scanner', 'Live check-in board'],
    ['tab-pos', 'On-spot POS'],
    ['tab-feedback-form', 'Feedback form editor'],
    ['tab-activity-logs', 'User & doctor activity'],
    ['tab-notifications', 'Notifications'],
    ['tab-system-platform', 'System health'],
    ['tab-system-users', 'User health'],
    ['tab-settings', 'Global settings']
];

const DOCTOR_MODULE_TAB_DEFS = [
    ['tab-dashboard', 'Dashboard'],
    ['tab-profile', 'My profile'],
    ['tab-seminars', 'Available seminars'],
    ['tab-applications', 'Track seminar applications'],
    ['tab-abstract', 'Case presentation'],
    ['tab-case-track', 'Track case applications'],
    ['tab-volunteer', 'Volunteer'],
    ['tab-feedback', 'Seminar feedback'],
    ['tab-support', 'Support tickets'],
    ['tab-orders', 'Orders'],
    ['tab-receipts', 'Receipts'],
    ['tab-payments', 'Payments'],
    ['tab-ticket', 'Participant tickets'],
    ['tab-certificate', 'Certificates'],
    ['tab-reset-pwd', 'Change password']
];

function parseAdminModulesObject(str) {
    if (str == null || !String(str).trim()) return {};
    try {
        const o = JSON.parse(str);
        return o && typeof o === 'object' ? o : {};
    } catch (_) {
        return {};
    }
}

function parseDoctorModulesObject(str) {
    if (str == null || !String(str).trim()) return {};
    try {
        const o = JSON.parse(str);
        return o && typeof o === 'object' ? o : {};
    } catch (_) {
        return {};
    }
}

function openAdminLiveScannerBoard() {
    const actor = getStoredAdminUser();
    if (!actor || !actor.id) {
        alert('Sign in to the admin portal first.');
        return;
    }
    try {
        sessionStorage.setItem('admin_user', JSON.stringify(actor));
    } catch (_) {}
    const w = window.open('/admin-live-scanner.html', '_blank', 'noopener,noreferrer');
    if (!w) {
        if (confirm('Pop-up blocked. Open the live board in this tab instead?')) {
            location.href = '/admin-live-scanner.html';
        }
    }
}

async function initAdminPosTab() {
    const sel = document.getElementById('pos-seminar');
    if (!sel) return;
    try {
        const res = await fetch('/api/seminars?bucket=current');
        const data = await res.json();
        const list = data.seminars || data || [];
        sel.innerHTML = '<option value="">Select seminar</option>';
        list.forEach((s) => {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.title;
            if (s.price) o.dataset.price = s.price;
            sel.appendChild(o);
        });
        sel.onchange = () => {
            const opt = sel.selectedOptions[0];
            const priceEl = document.getElementById('pos-amount');
            if (priceEl && opt && opt.dataset.price) priceEl.value = opt.dataset.price;
        };
    } catch (e) {
        console.warn(e);
    }
}

async function submitAdminPosRegistration() {
    const actor = getStoredAdminUser();
    if (!actor) return alert('Sign in as admin first.');
    const status = document.getElementById('pos-status');
    try {
        const res = await fetch('/api/admin/pos/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actingAdminId: actor.id,
                seminarId: document.getElementById('pos-seminar').value,
                firstName: document.getElementById('pos-fname').value,
                middleName: (document.getElementById('pos-mname') || {}).value || '',
                lastName: document.getElementById('pos-lname').value,
                phone: document.getElementById('pos-phone').value,
                email: document.getElementById('pos-email').value,
                amount: document.getElementById('pos-amount').value,
                paymentMethod: 'cash',
                sendTicketEmail: !!(document.getElementById('pos-send-ticket-email') || {}).checked
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        let note =
            'Done. Ticket ' + (data.ticketId || '—') + ' — doctor must complete profile in portal.';
        if (data.emailNote) note += ' ' + data.emailNote;
        status.textContent = note;
        status.style.color = '#059669';
    } catch (e) {
        status.textContent = e.message;
        status.style.color = '#b91c1c';
    }
}

function adminActorId() {
    const u = getStoredAdminUser();
    return u && u.id ? u.id : null;
}

async function loadAdminFeedbackFormConfig() {
    const aid = adminActorId();
    if (!aid) return;
    const ta = document.getElementById('feedback-form-json');
    try {
        const res = await fetch('/api/admin/feedback-form?actingAdminId=' + encodeURIComponent(aid));
        const cfg = await res.json();
        if (ta) ta.value = JSON.stringify(cfg, null, 2);
        renderFeedbackFormBuilder(cfg);
    } catch (e) {
        console.warn(e);
    }
}

function renderFeedbackFormBuilder(cfg) {
    const titleEl = document.getElementById('feedback-form-title');
    const introEl = document.getElementById('feedback-form-intro');
    if (titleEl) titleEl.value = (cfg && cfg.title) || '';
    if (introEl) introEl.value = (cfg && cfg.intro) || '';
    const wrap = document.getElementById('feedback-form-fields');
    if (!wrap) return;
    const fields = (cfg && cfg.fields) || [];
    wrap.innerHTML = '';
    fields.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'card';
        row.style.cssText = 'margin-bottom:10px;padding:12px;display:grid;grid-template-columns:1fr 120px 80px 60px auto;gap:8px;align-items:end;';
        row.dataset.index = String(i);
        const typeOpts = ['rating', 'textarea', 'text', 'checkbox', 'select']
            .map((t) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${t}</option>`)
            .join('');
        row.innerHTML =
            '<div><label style="font-size:0.75rem;">Label</label><input type="text" class="ffb-label" value="' +
            String(f.label || '').replace(/"/g, '&quot;') +
            '" style="width:100%;"></div>' +
            '<div><label style="font-size:0.75rem;">Field ID</label><input type="text" class="ffb-id" value="' +
            String(f.id || '').replace(/"/g, '&quot;') +
            '" style="width:100%;"></div>' +
            '<div><label style="font-size:0.75rem;">Type</label><select class="ffb-type" style="width:100%;">' +
            typeOpts +
            '</select></div>' +
            '<div><label style="font-size:0.75rem;">Required</label><input type="checkbox" class="ffb-req" ' +
            (f.required ? 'checked' : '') +
            '></div>' +
            '<button type="button" class="btn-primary" style="background:#b91c1c;padding:6px 10px;" onclick="removeFeedbackFormField(this)">Remove</button>';
        wrap.appendChild(row);
    });
}

function collectFeedbackFormFromBuilder() {
    const rows = document.querySelectorAll('#feedback-form-fields .card');
    const fields = [];
    rows.forEach((row) => {
        const id = (row.querySelector('.ffb-id') || {}).value || '';
        const label = (row.querySelector('.ffb-label') || {}).value || '';
        const type = (row.querySelector('.ffb-type') || {}).value || 'text';
        const required = !!(row.querySelector('.ffb-req') || {}).checked;
        if (!String(id).trim() && !String(label).trim()) return;
        const f = {
            id: String(id).trim() || 'field_' + (fields.length + 1),
            type,
            label: String(label).trim() || id,
            required
        };
        if (type === 'rating') {
            f.min = 1;
            f.max = 5;
        }
        if (type === 'textarea') f.rows = 2;
        if (type === 'checkbox') f.defaultChecked = true;
        fields.push(f);
    });
    let cfg = {};
    try {
        cfg = JSON.parse(document.getElementById('feedback-form-json').value || '{}');
    } catch (_) {
        cfg = { version: 1 };
    }
    cfg.version = cfg.version || 1;
    const titleEl = document.getElementById('feedback-form-title');
    const introEl = document.getElementById('feedback-form-intro');
    cfg.title = (titleEl && titleEl.value.trim()) || cfg.title || 'Seminar feedback';
    cfg.intro =
        (introEl && introEl.value.trim()) ||
        cfg.intro ||
        'Share your experience after attending a seminar.';
    cfg.fields = fields;
    return cfg;
}

function loadAdminFeedbackFormConfigFromJson() {
    const ta = document.getElementById('feedback-form-json');
    if (!ta) return;
    try {
        const cfg = JSON.parse(ta.value || '{}');
        renderFeedbackFormBuilder(cfg);
    } catch (e) {
        alert('Invalid JSON: ' + e.message);
    }
}

function syncFeedbackFormJsonFromBuilder() {
    const cfg = collectFeedbackFormFromBuilder();
    const ta = document.getElementById('feedback-form-json');
    if (ta) ta.value = JSON.stringify(cfg, null, 2);
}

function addFeedbackFormField() {
    const cfg = collectFeedbackFormFromBuilder();
    cfg.fields = cfg.fields || [];
    cfg.fields.push({ id: 'newField', type: 'text', label: 'New question', required: false });
    renderFeedbackFormBuilder(cfg);
    syncFeedbackFormJsonFromBuilder();
}

function removeFeedbackFormField(btn) {
    const row = btn && btn.closest('.card');
    if (row) row.remove();
    syncFeedbackFormJsonFromBuilder();
}

async function saveAdminFeedbackFormConfig() {
    const aid = adminActorId();
    if (!aid) return alert('Sign in as admin first.');
    const st = document.getElementById('feedback-form-save-status');
    try {
        syncFeedbackFormJsonFromBuilder();
        const cfg = JSON.parse(document.getElementById('feedback-form-json').value || '{}');
        const res = await fetch('/api/admin/feedback-form', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: aid, config: cfg })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        st.textContent = 'Feedback form saved.';
        st.style.color = '#059669';
    } catch (e) {
        st.textContent = e.message;
        st.style.color = '#b91c1c';
    }
}

function openAdminModulesModal(userId) {
    if (!isSuperAdminUser()) {
        alert('Only the super administrator can configure co-admin modules.');
        return;
    }
    const u = window.__adminUsersById[userId];
    if (!u) {
        alert('User not found. Refresh the user list.');
        return;
    }
    const mods = parseAdminModulesObject(u.admin_modules);
    const wrap = document.getElementById('admin-modules-checkboxes');
    const label = document.getElementById('admin-modules-user-label');
    const hid = document.getElementById('admin-modules-target-user-id');
    if (!wrap || !label || !hid) return;
    hid.value = String(userId);
    label.textContent = `${u.first_name || ''} ${u.last_name || ''} (${u.email || ''})`;
    wrap.innerHTML = ADMIN_MODULE_TAB_DEFS.map(
        ([id, title]) =>
            `<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.9rem;">
                <input type="checkbox" data-mod-tab="${id}" ${mods[id] === true ? 'checked' : ''}>
                <span>${title}</span>
            </label>`
    ).join('');
    const modal = document.getElementById('admin-modules-modal');
    modal.classList.remove('hidden');
}

async function saveAdminModulesForTarget() {
    if (!isSuperAdminUser()) return alert('Only the super administrator can save module access.');
    const targetId = parseInt(document.getElementById('admin-modules-target-user-id').value, 10);
    const actor = getStoredAdminUser();
    const admin_modules = {};
    document.querySelectorAll('#admin-modules-checkboxes input[data-mod-tab]').forEach((inp) => {
        const id = inp.getAttribute('data-mod-tab');
        if (id && inp.checked) admin_modules[id] = true;
    });
    try {
        const res = await fetch(`/api/admin/users/${targetId}/modules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_modules, actingAdminId: actor.id })
        });
        const data = await res.json();
        if (!res.ok || !data.success) return alert(data.error || 'Could not save modules.');
        document.getElementById('admin-modules-modal').classList.add('hidden');
        alert('Module access updated. The co-admin must log in again to pick up changes in this browser session, or refresh if they are logged in as that user elsewhere.');
        loadUsers();
    } catch (e) {
        console.error(e);
        alert('Network error saving modules.');
    }
}

let __behalfRegId = null;
let __behalfRegApplicationNo = '';
let __behalfFormFields = [];
let __behalfSelectedMethodId = 'dqr';
let __behalfOrderDbId = null;
let __behalfPollTimer = null;

const ADMIN_BEHALF_FIELD_DEFAULTS = [
    { key: 'fname', label: 'First name', type: 'text', enabled: true, required: true },
    { key: 'mname', label: 'Middle name', type: 'text', enabled: true, required: false },
    { key: 'lname', label: 'Last name', type: 'text', enabled: true, required: true },
    { key: 'email', label: 'Email', type: 'email', enabled: true, required: true },
    { key: 'phone', label: 'Phone', type: 'tel', enabled: true, required: true },
    { key: 'address', label: 'Address', type: 'textarea', enabled: true, required: true },
    { key: 'pin', label: 'Pincode', type: 'text', enabled: true, required: true },
    { key: 'city', label: 'City', type: 'text', enabled: true, required: true },
    { key: 'state', label: 'State', type: 'text', enabled: true, required: true },
    { key: 'country', label: 'Country', type: 'text', enabled: true, required: true },
    {
        key: 'qual',
        label: 'Qualification',
        type: 'select',
        enabled: true,
        required: true,
        options: [
            { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
            { value: 'Practitioner', label: 'Practitioner' },
            { value: 'PG', label: 'PG' }
        ]
    },
    { key: 'ncism', label: 'NCISM / Reg. no.', type: 'text', enabled: true, required: true, onlyWhenAdvancedQual: true },
    { key: 'cpin', label: 'College PIN', type: 'text', enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'college', label: 'College', type: 'text', enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'ccity', label: 'College city', type: 'text', enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'cstate', label: 'College state', type: 'text', enabled: true, required: false, onlyWhenPgCollege: true }
];

function adminQualIsPg(qual) {
    return String(qual || '').trim() === 'PG';
}

function adminBehalfNeedsAdvancedQual() {
    const el = document.getElementById('behalf-f-qual');
    const q = el ? String(el.value || '').trim() : '';
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

function adminNormalizeQualOptions(options) {
    const canon = {
        'Practicing Vaidya': { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
        Practitioner: { value: 'Practitioner', label: 'Practitioner' },
        PG: { value: 'PG', label: 'PG' }
    };
    if (!Array.isArray(options) || !options.length) {
        return Object.values(canon);
    }
    const out = [];
    options.forEach((o) => {
        if (!o) return;
        const v = String(o.value != null ? o.value : o.label || '').trim();
        if (!v || v.toLowerCase() === 'new') return;
        if (canon[v]) out.push(canon[v]);
        else if (v.length > 1) out.push({ value: v, label: String(o.label || v).trim() || v });
    });
    return out.length ? out : Object.values(canon);
}

function adminQualFromRegistrationFormData(raw) {
    if (!raw) return '';
    try {
        const fd = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return fd && fd.qual ? String(fd.qual).trim() : '';
    } catch (_) {
        return '';
    }
}

function renderAdminBehalfFormFields() {
    const host = document.getElementById('behalf-form-fields');
    if (!host) return;
    const fields = (__behalfFormFields || []).filter((f) => f.enabled !== false);
    if (!fields.length) {
        host.innerHTML = '<p class="muted" style="grid-column:1/-1;">No fields configured. Set them under Seminar registration form.</p>';
        return;
    }
    const adv = adminBehalfNeedsAdvancedQual();
    let html = '';
    fields.forEach((f) => {
        if (f.key === 'certificate') return;
        if (f.onlyWhenAdvancedQual && !adv) return;
        if (f.onlyWhenPgCollege && !adminQualIsPg((document.getElementById('behalf-f-qual') || {}).value)) return;
        const id = 'behalf-f-' + f.key;
        const req = f.required ? ' *' : '';
        const span = f.type === 'textarea' ? 'grid-column:1/-1;' : '';
        html += '<div class="form-group" style="' + span + '"><label for="' + id + '">' + escAdmin(f.label || f.key) + req + '</label>';
        if (f.type === 'textarea') {
            html += '<textarea id="' + id + '" rows="2" style="width:100%;padding:8px;"></textarea>';
        } else if (f.type === 'select' && Array.isArray(f.options)) {
            html += '<select id="' + id + '" style="width:100%;padding:8px;"><option value="">Select</option>';
            f.options.forEach((o) => {
                const v = o.value != null ? o.value : o.label;
                html += '<option value="' + escAdmin(String(v)) + '">' + escAdmin(o.label || v) + '</option>';
            });
            html += '</select>';
        } else {
            const ty = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
            html += '<input type="' + ty + '" id="' + id + '" style="width:100%;padding:8px;">';
        }
        html += '</div>';
    });
    host.innerHTML = html;
    const qualEl = document.getElementById('behalf-f-qual');
    if (qualEl) qualEl.addEventListener('change', () => renderAdminBehalfFormFields());
    ['pin', 'cpin'].forEach((pk) => {
        const pel = document.getElementById('behalf-f-' + pk);
        if (pel) pel.addEventListener('blur', () => adminPincodeAutofill('behalf-f-', pk));
    });
    host.querySelectorAll('input,textarea,select').forEach((el) => {
        el.addEventListener('input', () => {
            syncBehalfJsonFromForm();
            scheduleBehalfRegSave();
        });
        el.addEventListener('change', () => {
            syncBehalfJsonFromForm();
            scheduleBehalfRegSave();
        });
    });
}

function collectAdminBehalfFormData() {
    const o = { country: 'India' };
    const qual = (document.getElementById('behalf-f-qual') || {}).value;
    const isPg = adminQualIsPg(qual);
    (__behalfFormFields || ADMIN_BEHALF_FIELD_DEFAULTS).forEach((f) => {
        if (f.key === 'certificate' || f.enabled === false) return;
        if (f.onlyWhenPgCollege && !isPg) return;
        const el = document.getElementById('behalf-f-' + f.key);
        if (!el) return;
        o[f.key] = el.value;
    });
    return o;
}

function syncBehalfJsonFromForm() {
    const ta = document.getElementById('behalf-form-json');
    if (!ta) return;
    try {
        ta.value = JSON.stringify(collectAdminBehalfFormData(), null, 2);
    } catch (_) {}
}

function syncBehalfFormFromJson() {
    const ta = document.getElementById('behalf-form-json');
    if (!ta) return;
    try {
        const fd = JSON.parse(ta.value || '{}');
        (__behalfFormFields || ADMIN_BEHALF_FIELD_DEFAULTS).forEach((f) => {
            const el = document.getElementById('behalf-f-' + f.key);
            if (el && fd[f.key] != null) el.value = fd[f.key];
        });
    } catch (_) {}
}

async function loadAdminBehalfFormConfig(seminarId) {
    try {
        const res = await fetch('/api/registration-form-config?seminarId=' + encodeURIComponent(seminarId));
        const data = await res.json();
        __behalfFormFields = (data.fields && data.fields.length) ? data.fields : ADMIN_BEHALF_FIELD_DEFAULTS;
        __behalfFormFields = __behalfFormFields.map((f) => {
            if (f && f.key === 'qual' && Array.isArray(f.options)) {
                return { ...f, options: adminNormalizeQualOptions(f.options) };
            }
            return f;
        });
    } catch (_) {
        __behalfFormFields = ADMIN_BEHALF_FIELD_DEFAULTS;
    }
    renderAdminBehalfFormFields();
}

function refreshAdminBehalfWorkflow(data) {
    const card = document.getElementById('behalf-workflow-card');
    const st = document.getElementById('behalf-workflow-status');
    const payWrap = document.getElementById('behalf-payment-wrap');
    if (!card || !st) return;
    if (!data || !data.found) {
        card.classList.add('hidden');
        __behalfRegId = null;
        return;
    }
    card.classList.remove('hidden');
    const reg = data.registration;
    __behalfRegId = reg.id;
    __behalfRegApplicationNo = reg.applicationNo || '';
    let lines = [
        '<strong>Application:</strong> ' + escAdmin(reg.applicationNo || reg.id),
        '<strong>Status:</strong> ' + escAdmin(reg.status),
        '<strong>Source:</strong> ' + escAdmin(reg.registrationSource || 'admin')
    ];
    if (data.order) {
        lines.push('<strong>Payment:</strong> ' + escAdmin(data.order.status) + ' — ₹' + escAdmin(data.order.amount));
    }
    if (data.ticket) {
        lines.push(
            '<strong>E-ticket:</strong> ' +
                escAdmin(data.ticket.ticketIdString) +
                (data.ticket.isScanned ? ' (checked in)' : '')
        );
    }
    st.innerHTML = lines.join('<br>');
    if (payWrap) {
        const paid = data.order && String(data.order.status).toLowerCase() === 'success';
        if (paid) payWrap.classList.add('hidden');
        else {
            payWrap.classList.remove('hidden');
            const ps = document.getElementById('behalf-payment-status');
            if (ps) {
                ps.textContent =
                    'Collect payment for application ' + (reg.applicationNo || reg.id) + ' then e-ticket is issued automatically.';
            }
            loadBehalfPaymentMethodsUI().catch(console.error);
        }
    }
}

async function onAdminBehalfDoctorOrSeminarChange() {
    resetBehalfApplicantOtpTokens();
    const docId = parseInt((document.getElementById('behalf-doctor-select') || {}).value, 10);
    const sid = parseInt((document.getElementById('behalf-seminar-select') || {}).value, 10);
    const summary = document.getElementById('behalf-app-summary');
    if (!Number.isInteger(sid) || sid < 1) {
        if (summary) summary.textContent = 'Select a seminar to load the registration form.';
        return;
    }
    await loadAdminBehalfFormConfig(sid);
    if (Number.isInteger(docId) && docId > 0) {
        const u = window.__adminUsersById && window.__adminUsersById[docId];
        if (u) {
            const set = (k, v) => {
                const el = document.getElementById('behalf-f-' + k);
                if (el && !String(el.value || '').trim()) el.value = v || '';
            };
            set('fname', u.first_name);
            set('lname', u.last_name);
            set('email', u.email);
            set('phone', u.phone);
        }
    }
    syncBehalfJsonFromForm();
    if (!Number.isInteger(docId) || docId < 1) {
        if (summary) summary.textContent = 'Select a doctor account.';
        return;
    }
    try {
        const res = await fetch(
            '/api/admin/registrations/lookup?userId=' + encodeURIComponent(docId) + '&seminarId=' + encodeURIComponent(sid)
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');
        if (data.found && data.registration && data.registration.formData) {
            (__behalfFormFields || []).forEach((f) => {
                const el = document.getElementById('behalf-f-' + f.key);
                if (el && data.registration.formData[f.key] != null) {
                    el.value = data.registration.formData[f.key];
                }
            });
            syncBehalfJsonFromForm();
        }
        refreshAdminBehalfWorkflow(data);
        if (summary) {
            summary.textContent = data.found
                ? 'Loaded existing application ' + (data.registration.applicationNo || data.registration.id) + '.'
                : 'No application yet — fill the form and save to create one.';
        }
    } catch (e) {
        if (summary) summary.textContent = e.message || 'Could not load application.';
    }
}

async function adminBehalfApproveForPayment() {
    if (!__behalfRegId) return alert('Save an application first.');
    if (!confirm('Approve this application for payment?')) return;
    try {
        const res = await fetch('/api/admin/applications/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applicationId: __behalfRegId, status: 'approved_pending_payment' })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Approved.');
        onAdminBehalfDoctorOrSeminarChange();
        loadApplications();
    } catch (e) {
        alert('Network error');
    }
}

function adminBehalfOpenApplicationsTab() {
    switchTab('tab-applications');
    loadApplications();
    alert('Find the application in the list and click View to verify documents (certificate / NCISM).');
}

function adminBehalfOpenPaymentsTab() {
    const docId = parseInt((document.getElementById('behalf-doctor-select') || {}).value, 10);
    const sid = parseInt((document.getElementById('behalf-seminar-select') || {}).value, 10);
    const u = window.__adminUsersById && window.__adminUsersById[docId];
    switchTab('tab-admin-payments');
    loadAdminPaymentsModule();
    const coSem = document.getElementById('co-seminar');
    const coQ = document.getElementById('co-user-query');
    if (coSem && sid) coSem.value = String(sid);
    if (coQ && u) coQ.value = u.user_id_string || u.email || '';
    if (coQ && u) lookupAdminCreateOrder();
}

async function adminBehalfWaiveAndTicket() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__behalfRegId) return alert('Save an application first.');
    if (!confirm('Waive fee and issue e-ticket for this application?')) return;
    try {
        const res = await fetch('/api/admin/payments/waive-and-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId: __behalfRegId, note: 'Admin workspace waiver', actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Done');
        onAdminBehalfDoctorOrSeminarChange();
    } catch (e) {
        alert('Network error');
    }
}

function stopBehalfPaymentPoll() {
    if (__behalfPollTimer) {
        clearInterval(__behalfPollTimer);
        __behalfPollTimer = null;
    }
}

async function loadBehalfPaymentMethodsUI() {
    const box = document.getElementById('behalf-payment-methods');
    const adm = getStoredAdminUser();
    if (!box || !adm?.id) return;
    try {
        const res = await fetch('/api/admin/payments/methods?actingAdminId=' + encodeURIComponent(adm.id));
        const data = await res.json();
        if (!res.ok) {
            box.innerHTML = '<p style="color:#b91c1c;">' + escAdmin(data.error || 'Could not load methods') + '</p>';
            return;
        }
        const methods = (data.methods || []).filter((m) => m.available);
        if (!methods.length) {
            box.innerHTML = '<p style="color:#64748b;">No payment methods configured.</p>';
            return;
        }
        __behalfSelectedMethodId = methods[0].id;
        box.innerHTML = methods
            .map((m, i) => {
                const checked = i === 0 ? ' checked' : '';
                return (
                    '<label style="display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;">' +
                    '<input type="radio" name="behalf-pay-method" value="' +
                    escAdmin(m.id) +
                    '"' +
                    checked +
                    ' style="width:auto;margin-top:4px;" onchange="__behalfSelectedMethodId=this.value">' +
                    '<span><strong>' +
                    escAdmin(m.label) +
                    '</strong><br><span style="font-size:0.82rem;color:#64748b;">' +
                    escAdmin(m.description) +
                    '</span></span></label>'
                );
            })
            .join('');
    } catch (e) {
        box.innerHTML = '<p style="color:#b91c1c;">Network error</p>';
    }
}

async function behalfInitiatePayment() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__behalfRegId) return alert('Save an application first.');
    stopBehalfPaymentPoll();
    const pollSt = document.getElementById('behalf-poll-status');
    try {
        const res = await fetch('/api/admin/payments/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId: __behalfRegId,
                adminUserId: adm.id,
                methodId: __behalfSelectedMethodId || 'dqr'
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        if (data.paid) {
            alert(data.message || 'Paid.');
            onAdminBehalfDoctorOrSeminarChange();
            return;
        }
        __behalfOrderDbId = data.orderDbId;
        const qrBlock = document.getElementById('behalf-qr-block');
        const qrImg = document.getElementById('behalf-qr-img');
        const markBtn = document.getElementById('behalf-mark-upi-btn');
        if (data.qrImageUrl && qrImg) {
            qrImg.src = data.qrImageUrl;
            if (qrBlock) qrBlock.classList.remove('hidden');
        }
        if (data.manualConfirm && markBtn) markBtn.classList.remove('hidden');
        if (pollSt) pollSt.textContent = data.message || 'Waiting for payment…';
        __behalfPollTimer = setInterval(behalfPollPayment, 4000);
    } catch (e) {
        alert('Network error');
    }
}

async function behalfMarkUpiPaid() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__behalfOrderDbId) return alert('Start payment first.');
    if (!confirm('Confirm UPI received?')) return;
    try {
        const res = await fetch('/api/admin/payments/mark-upi-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderDbId: __behalfOrderDbId, adminUserId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Recorded.');
        onAdminBehalfDoctorOrSeminarChange();
    } catch (e) {
        alert('Network error');
    }
}

async function behalfPollPayment() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__behalfOrderDbId) return;
    const pollSt = document.getElementById('behalf-poll-status');
    try {
        const res = await fetch(
            '/api/admin/payments/poll/' + __behalfOrderDbId + '?actingAdminId=' + encodeURIComponent(adm.id)
        );
        const data = await res.json();
        if (data.paid) {
            stopBehalfPaymentPoll();
            if (pollSt) {
                pollSt.style.color = '#15803d';
                pollSt.textContent = data.message || 'Payment received — e-ticket issued.';
            }
            alert(data.message || 'Payment complete.');
            onAdminBehalfDoctorOrSeminarChange();
        } else if (pollSt && data.message) pollSt.textContent = data.message;
    } catch (e) {
        console.error(e);
    }
}

function scheduleBehalfRegSave() {
    const st = document.getElementById('behalf-save-status');
    if (st) {
        st.textContent = __requireBehalfApplicantOtp
            ? 'Verify applicant OTP above, then click Save application.'
            : 'Click Save application when the form is ready.';
    }
}

async function openAdminBehalfForVolunteer(userId, seminarId) {
    switchTab('tab-behalf-reg');
    initAdminBehalfRegTab();
    const ds = document.getElementById('behalf-doctor-select');
    const ss = document.getElementById('behalf-seminar-select');
    if (ds) ds.value = String(userId);
    if (ss) ss.value = String(seminarId);
    await loadAdminBehalfFormConfig(seminarId);
    await onAdminBehalfDoctorOrSeminarChange();
}
window.openAdminBehalfForVolunteer = openAdminBehalfForVolunteer;

async function editVolunteerDuties(assignId, currentDuties) {
    const duties = prompt('Volunteer duties (e.g. Registration desk, Scanner hall)', currentDuties || '');
    if (duties === null) return;
    try {
        const res = await fetch('/api/admin/volunteers/' + assignId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ duties })
        });
        const data = await res.json();
        if (data.success) refreshVolunteerAdminPanels();
        else alert(data.error || 'Could not save duties');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}
window.editVolunteerDuties = editVolunteerDuties;

async function flushBehalfRegistrationSave(manual) {
    const st = document.getElementById('behalf-save-status');
    const docId = parseInt((document.getElementById('behalf-doctor-select') || {}).value, 10);
    const sid = parseInt((document.getElementById('behalf-seminar-select') || {}).value, 10);
    const ta = document.getElementById('behalf-form-json');
    if (!Number.isInteger(docId) || docId < 1 || !Number.isInteger(sid) || sid < 1) {
        if (st) st.textContent = 'Select a doctor and seminar to enable auto-save.';
        return;
    }
    let formData;
    try {
        formData = collectAdminBehalfFormData();
        if (ta) ta.value = JSON.stringify(formData, null, 2);
    } catch (_) {
        try {
            formData = JSON.parse(String((ta || {}).value || '{}'));
        } catch (e2) {
            if (st) st.textContent = 'Invalid form or JSON — fix to save.';
            return;
        }
    }
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) {
        if (st) st.textContent = 'Not logged in.';
        return;
    }
    if (__requireBehalfApplicantOtp && (!__behalfApplicantPhoneOtpToken || !__behalfApplicantEmailOtpToken)) {
        if (st) st.textContent = 'Verify applicant phone and email OTP before saving.';
        if (manual) return alert('Verify applicant phone and email OTP before saving.');
        return;
    }
    if (st) st.textContent = 'Saving…';
    try {
        const res = await fetch('/api/admin/registrations/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUserId: docId,
                seminarId: sid,
                formData,
                adminUserId: adm.id,
                applicantPhoneOtpToken: __behalfApplicantPhoneOtpToken,
                applicantEmailOtpToken: __behalfApplicantEmailOtpToken
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            if (st) st.textContent = data.error || 'Save failed.';
            return;
        }
        resetBehalfApplicantOtpTokens();
        if (st)
            st.textContent = `Saved ${data.created ? '(new application)' : '(updated)'} at ${new Date().toLocaleTimeString()}`;
        __behalfRegId = data.registrationId || __behalfRegId;
        if (data.applicationNo) __behalfRegApplicationNo = data.applicationNo;
        onAdminBehalfDoctorOrSeminarChange();
    } catch (e) {
        console.error(e);
        if (st) st.textContent = 'Network error while saving.';
    }
}

function initAdminBehalfRegTab() {
    const ds = document.getElementById('behalf-doctor-select');
    const ss = document.getElementById('behalf-seminar-select');
    const ta = document.getElementById('behalf-form-json');
    if (!ds || !ss) return;
    refreshAdminSensitiveOtpRequirement();
    const prevDoc = ds.value;
    const prevSem = ss.value;
    ds.innerHTML = '<option value="">— Select doctor —</option>';
    Object.values(window.__adminUsersById || {}).forEach((u) => {
        const ur = String(u.user_role || '').toLowerCase();
        const r = String(u.role || '').toLowerCase();
        if (ur === 'co_admin' || ur === 'judge_user' || ur === 'scanner_portal_user' || ur === 'reviewer') return;
        if (r === 'admin' && ur !== 'doctor') return;
        ds.innerHTML += `<option value="${u.id}">${u.first_name} ${u.last_name} (${u.user_id_string})</option>`;
    });
    if (prevDoc) ds.value = prevDoc;
    ss.innerHTML = '<option value="">— Select seminar —</option>';
    (globalSeminars || []).forEach((s) => {
        ss.innerHTML += `<option value="${s.id}">${s.title}</option>`;
    });
    if (prevSem) ss.value = prevSem;
    if (!window.__behalfWired && ta) {
        window.__behalfWired = true;
        ta.addEventListener('input', () => {
            syncBehalfFormFromJson();
            scheduleBehalfRegSave();
        });
    }
    if (Number.isInteger(parseInt(prevSem, 10))) {
        loadAdminBehalfFormConfig(parseInt(prevSem, 10)).then(() => onAdminBehalfDoctorOrSeminarChange());
    }
}

function toggleNewUserPasswordFields() {
    const on = document.getElementById('newuser-custom-pass')?.checked;
    const wrap = document.getElementById('newuser-pass-wrap');
    if (wrap) wrap.style.display = on ? 'block' : 'none';
}

function toggleNewUserPassVisible() {
    const el = document.getElementById('newuser-pass');
    if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

function copyNewUserGeneratedPassword() {
    const t = document.getElementById('newuser-generated-text')?.textContent || '';
    if (!t) return;
    navigator.clipboard.writeText(t).then(() => alert('Password copied.')).catch(() => alert(t));
}

async function adminCreateUser() {
    const firstName = document.getElementById('newuser-first').value.trim();
    const lastName = document.getElementById('newuser-last').value.trim();
    const email = document.getElementById('newuser-email').value.trim();
    const phone = document.getElementById('newuser-phone').value.trim();
    const userRole = String((document.getElementById('newuser-role') || {}).value || '').trim();
    const createKind = window.__adminCreateUserKind === 'doctor' ? 'doctor' : 'staff';

    if (!firstName || !lastName || !email || !phone) {
        alert('Please fill all required fields');
        return;
    }
    if (!userRole) {
        alert('Select a role for this account.');
        return;
    }
    if (createKind === 'staff' && userRole === 'doctor') {
        alert('For staff accounts, choose Judge, Co Admin, Scanner, or Reviewer — not Doctor.');
        return;
    }
    if (createKind === 'doctor' && userRole !== 'doctor') {
        alert('Use “Create doctor” with role Doctor, or use “Create staff user” for other roles.');
        return;
    }
    
    if (userRole === 'doctor' && typeof validatePersonNameClient === 'function') {
        const fn = validatePersonNameClient(firstName, 'First name');
        if (!fn.valid) return alert(fn.message);
        const ln = validatePersonNameClient(lastName, 'Last name');
        if (!ln.valid) return alert(ln.message);
    }

    const useCustom = document.getElementById('newuser-custom-pass')?.checked;
    const customPass = document.getElementById('newuser-pass')?.value || '';
    if (useCustom && customPass.trim().length < 4) {
        alert('Custom password must be at least 4 characters');
        return;
    }

    await refreshAdminSensitiveOtpRequirement();
    const staffCreate = isStaffUserRoleClient(userRole);
    if (
        !staffCreate &&
        __requireAdminSensitiveOtp &&
        (!__adminSensitivePhoneOtpToken || !__adminSensitiveEmailOtpToken)
    ) {
        return alert('Verify both your admin email and WhatsApp OTP before creating a doctor account.');
    }

    const adm = getStoredAdminUser();
    const middleName = document.getElementById('newuser-middle')?.value?.trim() || '';
    const customPortalId = document.getElementById('newuser-portal-id')?.value?.trim() || '';
    const data = {
        firstName,
        middleName,
        lastName,
        email,
        phone,
        role: userRole,
        createKind,
        allowStaffTestDuplicate: createKind === 'staff',
        actingAdminId: adm && adm.id,
        adminPhoneOtpToken: __adminSensitivePhoneOtpToken,
        adminEmailOtpToken: __adminSensitiveEmailOtpToken
    };
    if (customPortalId) data.userIdString = customPortalId.replace(/\D/g, '');
    if (useCustom) data.password = customPass.trim();
    const demoChk = document.getElementById('newuser-is-demo');
    if (demoChk && demoChk.checked && adminDemoAccountsEnabled()) data.isDemo = true;

    try {
        const res = await fetch('/api/admin/users/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (!res.ok) {
            if (result.existingUserId) {
                if (result.accountList === 'doctors') switchTab('tab-doctors');
                else if (result.accountList === 'staff') switchTab('tab-staff-users');
                if (
                    confirm(
                        (result.error || 'Account already exists.') +
                            '\n\nOpen that account now?'
                    )
                ) {
                    adminOpenExistingUser(result.existingUserId, result.accountList);
                }
                return;
            }
            if (result.accountList === 'doctors') switchTab('tab-doctors');
            else if (result.accountList === 'staff') switchTab('tab-staff-users');
            return alert(result.error || 'Could not create user');
        }
        if (result.success) {
            resetAdminSensitiveOtpTokens();
            ['cau-sens-phone-ok', 'cau-sens-email-ok'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.textContent = '';
            });
            const finalPassword = result.generatedPassword || customPass;
            await sendCredentialsToNewUser(email, phone, firstName, result.user_id_string, finalPassword);

            const prev = document.getElementById('newuser-generated-preview');
            const prevText = document.getElementById('newuser-generated-text');
            if (prev && prevText) {
                prevText.textContent = finalPassword;
                prev.style.display = 'block';
            }

            const staffAccount =
                result.accountList === 'staff' || isStaffUserRoleClient(userRole);
            const listName = staffAccount ? 'Staff users' : 'Doctors';
            document.getElementById('admin-create-user-modal').classList.add('hidden');
            adminClearStaffUsersSearch();
            const lookupEl = document.getElementById('admin-user-lookup');
            if (lookupEl) lookupEl.value = result.user_id_string || '';

            document.getElementById('newuser-first').value = '';
            if (document.getElementById('newuser-middle')) document.getElementById('newuser-middle').value = '';
            document.getElementById('newuser-last').value = '';
            if (document.getElementById('newuser-portal-id')) document.getElementById('newuser-portal-id').value = '';
            document.getElementById('newuser-email').value = '';
            document.getElementById('newuser-phone').value = '';
            if (document.getElementById('newuser-pass')) document.getElementById('newuser-pass').value = '';
            await loadUsers();
            try {
                const verifyRes = await fetch(
                    '/api/admin/users/lookup?q=' + encodeURIComponent(result.user_id_string || '')
                );
                const verify = await verifyRes.json();
                if (!verify.found) {
                    alert(
                        'Warning: The server could not confirm this account in the database.\n\n' +
                            'Portal ID: ' +
                            (result.user_id_string || '—') +
                            '\n\nPlease create the user again. If this repeats, check Vercel Production → DATABASE_URL (Neon).'
                    );
                } else {
                    alert(
                        `User saved to database.\n\nPortal ID: ${verify.user.user_id_string}\nPassword: ${finalPassword}\nRole: ${userRole}\n\nListed under “${listName}”.`
                    );
                    adminApplyLookupMatch(verify.user, verify.accountList);
                }
            } catch (_) {
                alert(
                    `User created (unverified).\n\nPortal ID: ${result.user_id_string}\nPassword: ${finalPassword}`
                );
                switchTab(staffAccount ? 'tab-staff-users' : 'tab-doctors');
                window.__highlightAdminUserId = result.userId;
                loadUsers();
            }
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        console.error(err);
        alert('Error creating user');
    }
}

function adminOpenExistingUser(userId, accountList) {
    window.__highlightAdminUserId = userId;
    switchTab(accountList === 'staff' ? 'tab-staff-users' : 'tab-doctors');
    loadUsers().then(() => openAdminUserDetail(userId));
}

let __adminUserDetailCache = null;
let __adminUserDetailTab = 'profile';

function closeAdminUserDetailModal() {
    const m = document.getElementById('admin-user-detail-modal');
    if (m) {
        m.classList.add('hidden');
        m.style.display = '';
    }
}

async function openAdminUserDetail(userId) {
    const body = document.getElementById('admin-user-detail-body');
    if (body) body.innerHTML = '<p>Loading…</p>';
    const modal = document.getElementById('admin-user-detail-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
    try {
        const res = await fetch(`/api/admin/users/${userId}/detail`);
        const data = await res.json();
        if (!res.ok) {
            if (body) body.innerHTML = `<p style="color:#b91c1c;">${data.error || 'Failed to load'}</p>`;
            return;
        }
        __adminUserDetailCache = data;
        __adminUserDetailTab = 'profile';
        const u = data.user;
        document.getElementById('admin-user-detail-title').textContent =
            `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'User details';
        document.getElementById('admin-user-detail-sub').textContent =
            `ID: ${u.user_id_string} · ${u.email} · Role: ${u.user_role || u.role}`;
        renderAdminUserDetailActions();
        switchAdminUserDetailTab('profile');
    } catch (e) {
        console.error(e);
        if (body) body.innerHTML = '<p style="color:#b91c1c;">Network error</p>';
    }
}

function renderAdminUserDetailActions() {
    const bar = document.getElementById('admin-user-detail-actions');
    const d = __adminUserDetailCache;
    if (!bar || !d || !d.user) return;
    const u = d.user;
    const banned = Number(u.is_banned) === 1;
    const disabled = Number(u.is_disabled) === 1;
    let html = '';
    if (banned) {
        html +=
            '<button type="button" class="btn-primary" style="background:#059669;border:none;" onclick="toggleAdminUserBan(' +
            u.id +
            ', false)">Unban user</button>';
    } else {
        html +=
            '<button type="button" class="btn-primary" style="background:#7f1d1d;border:none;" onclick="toggleAdminUserBan(' +
            u.id +
            ', true)">Ban user</button>';
    }
    if (disabled && !banned) {
        html +=
            '<button type="button" class="btn-primary" style="background:#059669;border:none;" onclick="toggleDisable(' +
            u.id +
            ', false)">Enable account</button>';
    } else if (!disabled && !banned) {
        html +=
            '<button type="button" class="btn-primary" style="background:#b45309;border:none;" onclick="toggleDisable(' +
            u.id +
            ', true)">Disable account</button>';
    }
    if (banned && u.ban_reason) {
        html +=
            '<span style="font-size:0.85rem;color:#7f1d1d;margin-left:8px;">Ban reason: ' +
            escAdmin(u.ban_reason) +
            '</span>';
    }
    if (adminCanDeleteUsers()) {
        const dn = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '';
        html +=
            '<button type="button" class="btn-primary" style="background:#b91c1c;border:none;margin-left:8px;" onclick="adminDeleteUserAccount(' +
            u.id +
            ", '" +
            String(dn).replace(/'/g, "\\'") +
            "', '" +
            String(u.user_id_string || '').replace(/'/g, "\\'") +
            "')\">Delete account</button>";
    }
    bar.innerHTML = html;
}

async function toggleAdminUserBan(userId, ban) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    let reason = '';
    if (ban) {
        reason = prompt('Ban reason (required):', 'Policy violation') || '';
        if (reason.trim().length < 3) return alert('Ban reason is required.');
    } else if (!confirm('Remove ban from this user? They will still be disabled until you enable the account.')) {
        return;
    }
    try {
        const res = await fetch('/api/admin/users/toggle_ban', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, ban, reason, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        if (__adminUserDetailCache && __adminUserDetailCache.user && Number(__adminUserDetailCache.user.id) === Number(userId)) {
            __adminUserDetailCache.user.is_banned = ban ? 1 : 0;
            __adminUserDetailCache.user.ban_reason = ban ? reason : null;
            if (ban) __adminUserDetailCache.user.is_disabled = 1;
        }
        renderAdminUserDetailActions();
        renderAdminUserDetailTab();
        loadUsers();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

function switchAdminUserDetailTab(tab) {
    __adminUserDetailTab = tab;
    document.querySelectorAll('.admin-user-detail-tab').forEach((btn) => {
        const t = btn.getAttribute('data-ud-tab');
        const on = t === tab;
        btn.style.background = on ? '#0d9488' : '#64748b';
        btn.classList.toggle('active', on);
    });
    renderAdminUserDetailTab();
}

function publicFileHref(stored) {
    const p = String(stored || '').trim();
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    if (p.startsWith('/uploads/api/assets/')) return '/api/assets/' + p.slice('/uploads/api/assets/'.length);
    if (p.startsWith('/')) return p;
    return '/uploads/' + p;
}

function escAdmin(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function renderAdminUserDetailTab() {
    const d = __adminUserDetailCache;
    const body = document.getElementById('admin-user-detail-body');
    if (!d || !body) return;
    const u = d.user;
    const p = d.profile;

    if (__adminUserDetailTab === 'profile') {
        let formRows = '';
        (d.registrations || []).forEach((r) => {
            let fd = {};
            try {
                fd = JSON.parse(r.form_data || '{}');
            } catch (_) {}
            Object.keys(fd).forEach((k) => {
                if (['password', 'certificate_path'].indexOf(k) !== -1) return;
                formRows += `<tr><td><code>${escAdmin(k)}</code></td><td>${escAdmin(fd[k])}</td></tr>`;
            });
        });
        body.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
                <div>
                    <h4>Account (editable)</h4>
                    <p class="muted" style="font-size:0.85rem;">Portal login — admin OTP may be required to save doctor accounts only.</p>
                    <p><strong>User ID:</strong> ${escAdmin(u.user_id_string)}</p>
                    <p><strong>Account created:</strong> ${formatAdminAccountDateTime(u.created_at)}</p>
                    <p><strong>Account activated:</strong> ${adminAccountActivationLabel(u)}</p>
                    ${u.last_login_at ? `<p><strong>Last login:</strong> ${formatAdminAccountDateTime(u.last_login_at)}</p>` : ''}
                    <div class="form-group"><label>First name</label><input type="text" id="admin-edit-first" value="${escAdmin(u.first_name)}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Middle name</label><input type="text" id="admin-edit-middle" value="${escAdmin(u.middle_name || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Last name</label><input type="text" id="admin-edit-last" value="${escAdmin(u.last_name)}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Email</label><input type="email" id="admin-edit-email" value="${escAdmin(u.email)}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Phone</label><input type="tel" id="admin-edit-phone" value="${escAdmin(u.phone)}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>WhatsApp</label><input type="tel" id="admin-edit-whatsapp" value="${escAdmin(u.whatsapp || u.phone || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Qualification</label><input type="text" id="admin-edit-qual" value="${escAdmin(u.qualification || '')}" style="width:100%;padding:8px;"></div>
                    <p><strong>Password (stored):</strong> <code>${escAdmin(u.password)}</code></p>
                    <p><strong>Role:</strong> ${escAdmin(u.user_role || u.role)} · <span class="muted">Listed under: ${isDoctorAccount(u) ? 'Doctors' : 'Staff users'}</span></p>
                    ${
                        isDoctorAccount(u)
                            ? `<div style="margin:10px 0;padding:10px;border:1px solid #fed7aa;border-radius:8px;background:#fffbeb;">
                    <p style="margin:0 0 8px;font-size:0.88rem;"><strong>Should this be a staff account?</strong> Choose a staff role and save — the account will move to the Staff users tab.</p>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                        <select id="admin-edit-staff-role" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;">
                            <option value="judge_user">Judge</option>
                            <option value="co_admin">Co Admin</option>
                            <option value="scanner_portal_user">Scanner (volunteer)</option>
                            <option value="scanner_dashboard_user">Live scanner dashboard</option>
                            <option value="reviewer">Reviewer</option>
                        </select>
                        <button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.85rem;" onclick="adminMoveUserToStaffRole(${u.id})">Move to Staff users</button>
                    </div>
                    </div>`
                            : `<div style="margin:10px 0;padding:10px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff;">
                    <p style="margin:0 0 8px;font-size:0.88rem;"><strong>Doctor portal access</strong> — one login cannot be staff and doctor at the same time. Move to Doctors to let this person use the doctor portal (seminar registration, case upload, etc.).</p>
                    <button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.85rem;background:#0f766e;" onclick="adminMoveUserToDoctorPortal(${u.id})">Move to Doctor portal</button>
                    </div>`
                    }
                    ${
                        String(u.user_role || u.role || '').toLowerCase() === 'doctor'
                            ? `<div style="margin:10px 0;padding:10px;border:1px solid #dbeafe;border-radius:8px;background:#f8fbff;">
                    <p style="margin:0 0 8px;"><strong>Doctor access control</strong></p>
                    <div class="form-group"><label>Category</label>
                        <select id="admin-edit-doc-category" style="width:100%;padding:8px;">
                            <option value="regular" ${String(u.doctor_category || 'regular').toLowerCase() === 'volunteer' ? '' : 'selected'}>Regular doctor</option>
                            <option value="volunteer" ${String(u.doctor_category || '').toLowerCase() === 'volunteer' ? 'selected' : ''}>Volunteer doctor</option>
                        </select>
                    </div>
                    <p style="font-size:0.82rem;color:#475569;margin:6px 0 8px;">For volunteers, keep only Volunteer/essential modules enabled.</p>
                    <div id="admin-edit-doc-modules" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                        ${DOCTOR_MODULE_TAB_DEFS.map(
                            ([id, title]) =>
                                `<label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;"><input type="checkbox" data-doc-mod="${id}" ${
                                    parseDoctorModulesObject(u.doctor_modules)[id] ? 'checked' : ''
                                }> ${title}</label>`
                        ).join('')}
                    </div>
                    <button type="button" class="btn-primary" style="margin-top:10px;background:#0f766e;" onclick="saveDoctorAccessFromDetail(${u.id})">Save doctor access</button>
                    </div>`
                            : ''
                    }
                    <p><strong>Status:</strong> ${Number(u.is_banned) === 1 ? 'Banned' : u.is_disabled ? 'Disabled' : 'Active'}</p>
                    ${Number(u.is_banned) === 1 && u.ban_reason ? `<p><strong>Ban reason:</strong> ${escAdmin(u.ban_reason)}</p>` : ''}
                    ${u.banned_at ? `<p><strong>Banned at:</strong> ${escAdmin(u.banned_at)}</p>` : ''}
                    ${
                        adminDemoAccountsEnabled()
                            ? `<p><strong>Dummy / demo account:</strong> ${Number(u.is_demo) === 1 ? 'Yes — any OTP code is accepted at login and registration' : 'No'}</p>
                    <button type="button" class="btn-primary" style="margin-top:10px;background:#7c3aed;" onclick="toggleAdminUserDemo(${u.id}, ${Number(u.is_demo) === 1 ? 'false' : 'true'})">${Number(u.is_demo) === 1 ? 'Remove dummy account' : 'Mark as dummy account (any OTP)'}</button>`
                            : ''
                    }
                    <button type="button" class="btn-primary" style="margin-top:12px;" onclick="adminSaveUserAccountEdit(${u.id})">Save account</button>
                </div>
                <div>
                    <h4>Doctor profile (editable)</h4>
                    <div class="form-group"><label>Specialization</label><input type="text" id="admin-edit-spec" value="${escAdmin((p && p.specialization) || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Registration no.</label><input type="text" id="admin-edit-regno" value="${escAdmin((p && p.registration_no) || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Qualifications</label><textarea id="admin-edit-quals" rows="2" style="width:100%;padding:8px;">${escAdmin((p && p.qualifications) || '')}</textarea></div>
                    <div class="form-group"><label>Experience (years)</label><input type="number" id="admin-edit-exp" value="${escAdmin((p && p.experience_years) || 0)}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Hospital</label><input type="text" id="admin-edit-hospital" value="${escAdmin((p && p.hospital_name) || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Contact</label><input type="tel" id="admin-edit-contact" value="${escAdmin((p && p.contact_number) || '')}" style="width:100%;padding:8px;"></div>
                    <div class="form-group"><label>Bio</label><textarea id="admin-edit-bio" rows="3" style="width:100%;padding:8px;">${escAdmin((p && p.bio) || '')}</textarea></div>
                    <button type="button" class="btn-primary" style="margin-top:12px;" onclick="adminSaveDoctorProfileEdit(${u.id})">Save doctor profile</button>
                </div>
            </div>
            ${
                formRows
                    ? `<h4 style="margin-top:16px;">Latest registration form fields</h4><table class="data-table"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${formRows}</tbody></table>`
                    : ''
            }
            <h4 style="margin-top:16px;">Abstracts (${(d.abstracts || []).length})</h4>
            <p style="font-size:0.88rem;color:#64748b;">${(d.abstracts || []).map((a) => `${escAdmin(a.topic)} (${escAdmin(a.status)})`).join(' · ') || 'None'}</p>
            <h4>Support tickets</h4>
            <p style="font-size:0.88rem;">${(d.supportTickets || []).map((t) => `#${t.id} ${escAdmin(t.subject)}`).join('<br>') || 'None'}</p>
        `;
        return;
    }

    if (__adminUserDetailTab === 'registrations') {
        let rows = '';
        (d.registrations || []).forEach((r) => {
            const createdLabel =
                window.PortalDateTime && r.created_at
                    ? window.PortalDateTime.format(r.created_at)
                    : r.created_at || '—';
            rows += `<tr><td>${escAdmin(r.application_no)}</td><td>${escAdmin(r.seminar_title)}</td><td>${escAdmin(r.status)}</td><td>${escAdmin(createdLabel)}</td><td>${escAdmin(r.registration_source || '')}</td></tr>`;
        });
        body.innerHTML = `<table class="data-table"><thead><tr><th>App no.</th><th>Seminar</th><th>Status</th><th>Created</th><th>Source</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No applications</td></tr>'}</tbody></table>`;
        return;
    }

    if (__adminUserDetailTab === 'orders') {
        body.innerHTML = '<p>Loading payments…</p>';
        loadAdminUserPaymentsPanel(u.id, body);
        return;
    }

    if (__adminUserDetailTab === 'cancellations') {
        renderAdminUserCancellationTab(body, u.id);
        return;
    }

    if (__adminUserDetailTab === 'activity') {
        body.innerHTML = '<p>Loading activity…</p>';
        loadAdminUserActivityPanel(u.id, body);
        return;
    }

    if (__adminUserDetailTab === 'scans') {
        const scanned = (d.orders || []).filter((o) => o.is_scanned);
        let rows = '';
        scanned.forEach((o) => {
            rows += `<tr><td>${escAdmin(o.scan_time)}</td><td>${escAdmin(o.application_no)}</td><td>${escAdmin(o.ticket_id_string)}</td><td>${escAdmin(o.scanned_by_first || '')} ${escAdmin(o.scanned_by_last || '')} (${escAdmin(o.scanned_by_id || '')})</td></tr>`;
        });
        body.innerHTML = `<table class="data-table"><thead><tr><th>Time</th><th>Application</th><th>Ticket</th><th>Scanned by</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No check-ins yet</td></tr>'}</tbody></table>`;
        return;
    }

    if (__adminUserDetailTab === 'password') {
        body.innerHTML = `
            <p style="margin-bottom:12px;color:#64748b;">Set a custom password or generate a new one. The new value is shown once after save.</p>
            <label><input type="checkbox" id="admin-pw-generate" checked onchange="document.getElementById('admin-pw-custom-wrap').style.display=this.checked?'none':'block'"> Auto-generate password</label>
            <div id="admin-pw-custom-wrap" style="display:none;margin:12px 0;">
                <input type="text" id="admin-pw-custom" placeholder="Custom password" style="width:100%;max-width:320px;">
            </div>
            <button type="button" class="btn-primary" onclick="adminResetUserPassword(${u.id})">Save password</button>
            <p id="admin-pw-result" style="margin-top:12px;font-weight:600;"></p>
        `;
    }
}

async function adminResetUserPassword(userId) {
    const generate = document.getElementById('admin-pw-generate')?.checked;
    const custom = document.getElementById('admin-pw-custom')?.value || '';
    try {
        const res = await fetch(`/api/admin/users/${userId}/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(generate ? { generate: true } : { password: custom })
        });
        const data = await res.json();
        const el = document.getElementById('admin-pw-result');
        if (data.success) {
            if (el) {
                el.style.color = '#15803d';
                el.textContent = `New password: ${data.password}`;
            }
            if (__adminUserDetailCache && __adminUserDetailCache.user) {
                __adminUserDetailCache.user.password = data.password;
            }
        } else if (el) {
            el.style.color = '#b91c1c';
            el.textContent = data.error || 'Failed';
        }
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function fillAdminSeminarSelect(selectId, includeAllOption) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    try {
        const res = await fetch('/api/admin/seminars/all');
        if (!res.ok) throw new Error('Failed to load seminars');
        const seminars = await res.json();
        const rows = (Array.isArray(seminars) ? seminars : []).filter((s) => Number(s.is_active) !== 0);
        let html = includeAllOption
            ? '<option value="">All seminars</option>'
            : '<option value="">Select seminar</option>';
        rows.forEach((s) => {
            html += `<option value="${s.id}">${escAdmin(s.title)}</option>`;
        });
        sel.innerHTML = html;
        if (!includeAllOption && rows.length === 1) {
            sel.value = String(rows[0].id);
        }
    } catch (e) {
        console.error(e);
        sel.innerHTML = '<option value="">Could not load seminars</option>';
    }
}

async function initAdminCertificatesTab() {
    await fillAdminSeminarSelect('cert-mgmt-seminar', false);
    await loadAdminCertificateCandidates();
    await loadCertTemplateConfig();
    await loadCertVerifySettings();
}

async function loadCertVerifySettings() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const cb = document.getElementById('cert-verify-enabled');
    const status = document.getElementById('cert-verify-status');
    if (!cb || !status) return;
    if (!sid) {
        cb.checked = false;
        cb.disabled = true;
        status.textContent = 'Select a seminar.';
        return;
    }
    cb.disabled = true;
    status.textContent = 'Loading verification settings…';
    try {
        const res = await fetch(`/api/admin/seminars/${encodeURIComponent(sid)}/certificate-verify`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load');
        cb.checked = !!data.enabled;
        cb.disabled = false;
        const manualEl = document.getElementById('cert-verify-manual');
        const goLiveEl = document.getElementById('cert-verify-go-live');
        if (manualEl) manualEl.checked = !!data.manualOverride;
        if (goLiveEl && data.goLiveAt) {
            const d = new Date(data.goLiveAt);
            if (!Number.isNaN(d.getTime())) {
                goLiveEl.value = d.toISOString().slice(0, 16);
            }
        } else if (goLiveEl) {
            goLiveEl.value = '';
        }
        if (!data.seminarEnded && !data.manualOverride && !data.goLiveAt) {
            status.style.color = '#b45309';
            status.textContent =
                'Seminar has not ended yet (event date: ' +
                (data.eventDate || '—') +
                '). Check manual override or set a scheduled opening time, then save.';
        } else if (data.enabled && data.publicLive) {
            status.style.color = '#15803d';
            status.textContent =
                'Public verification is live for “' +
                (data.title || 'this seminar') +
                '”. Visitors can verify participant and volunteer certificates at /verify-certificate.html';
        } else if (data.enabled && data.countdown) {
            status.style.color = '#0369a1';
            status.textContent =
                'Verification is scheduled. Opens ' +
                new Date(data.countdown.at || data.goLiveAt).toLocaleString() +
                '.';
        } else if (data.enabled) {
            status.style.color = '#64748b';
            status.textContent = 'Verification is enabled but not yet open to the public.';
        } else {
            status.style.color = '#64748b';
            status.textContent = 'Enable verification when certificates are ready to publish.';
        }
    } catch (e) {
        status.style.color = '#b91c1c';
        status.textContent = e.message || 'Could not load settings';
        cb.disabled = true;
    }
}

async function saveCertVerifyEnabled() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const cb = document.getElementById('cert-verify-enabled');
    const status = document.getElementById('cert-verify-status');
    if (!sid || !cb) return;
    const enabled = !!cb.checked;
    const manualOverride = !!(document.getElementById('cert-verify-manual') || {}).checked;
    const goLiveRaw = (document.getElementById('cert-verify-go-live') || {}).value || '';
    const goLiveAt = goLiveRaw ? new Date(goLiveRaw).toISOString() : null;
    if (status) status.textContent = 'Saving…';
    try {
        const res = await fetch(`/api/admin/seminars/${encodeURIComponent(sid)}/certificate-verify`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, manualOverride, goLiveAt })
        });
        const data = await res.json();
        if (!res.ok) {
            cb.checked = !enabled;
            throw new Error(data.error || 'Save failed');
        }
        await loadCertVerifySettings();
    } catch (e) {
        if (status) {
            status.style.color = '#b91c1c';
            status.textContent = e.message || 'Save failed';
        }
        alert(e.message || 'Could not save verification setting');
    }
}

async function dispatchAllAdminCertificates() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const msg = document.getElementById('cert-dispatch-msg');
    if (!sid) return alert('Select a seminar');
    if (
        !confirm(
            'Send certificate notifications (email + WhatsApp) to every doctor with an enabled certificate for this seminar?'
        )
    ) {
        return;
    }
    if (msg) {
        msg.style.color = '#78716c';
        msg.textContent = 'Dispatching…';
    }
    try {
        const res = await fetch('/api/admin/certificates/dispatch-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seminarId: parseInt(sid, 10) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Dispatch failed');
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent =
                'Dispatched: ' +
                (data.dispatched || 0) +
                (data.skipped ? ', skipped: ' + data.skipped : '') +
                (data.errors && data.errors.length ? '. Some rows skipped (missing PRN/Application No.).' : '.');
        }
        loadAdminCertificateCandidates();
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message || 'Dispatch failed';
        }
        alert(e.message || 'Dispatch failed');
    }
}

function readCertConfigFromForm() {
    return {
        orgName: document.getElementById('cert-cfg-org')?.value || '',
        title: document.getElementById('cert-cfg-title')?.value || '',
        subtitle: document.getElementById('cert-cfg-subtitle')?.value || '',
        leadText: document.getElementById('cert-cfg-lead')?.value || '',
        bodyParticipant: document.getElementById('cert-cfg-body-p')?.value || '',
        bodyVolunteer: document.getElementById('cert-cfg-body-v')?.value || '',
        venueOverride: document.getElementById('cert-cfg-venue')?.value || '',
        dateOverride: document.getElementById('cert-cfg-date')?.value || '',
        sigLeftTitle: document.getElementById('cert-cfg-sig-l')?.value || '',
        sigRightName: document.getElementById('cert-cfg-sig-rn')?.value || '',
        sigRightTitle: document.getElementById('cert-cfg-sig-rt')?.value || '',
        sigLeftImagePath: window.__certSigLeftPath || '',
        sigRightImagePath: window.__certSigRightPath || '',
        goldColor: document.getElementById('cert-cfg-gold')?.value || '#c9a227',
        nameColor: document.getElementById('cert-cfg-name-color')?.value || '#c45c26',
        showFlame: !!document.getElementById('cert-cfg-flame')?.checked,
        showSwooshes: !!document.getElementById('cert-cfg-swoosh')?.checked,
        autoHonorific: !!document.getElementById('cert-cfg-honorific')?.checked
    };
}

function fillCertConfigForm(cfg) {
    const c = cfg || {};
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v != null ? v : '';
    };
    set('cert-cfg-org', c.orgName);
    set('cert-cfg-title', c.title);
    set('cert-cfg-subtitle', c.subtitle);
    set('cert-cfg-lead', c.leadText);
    set('cert-cfg-body-p', c.bodyParticipant);
    set('cert-cfg-body-v', c.bodyVolunteer);
    set('cert-cfg-venue', c.venueOverride);
    set('cert-cfg-date', c.dateOverride);
    set('cert-cfg-sig-l', c.sigLeftTitle);
    set('cert-cfg-sig-rn', c.sigRightName);
    set('cert-cfg-sig-rt', c.sigRightTitle);
    set('cert-cfg-gold', c.goldColor || '#c9a227');
    set('cert-cfg-name-color', c.nameColor || '#c45c26');
    const fl = document.getElementById('cert-cfg-flame');
    const sw = document.getElementById('cert-cfg-swoosh');
    const ho = document.getElementById('cert-cfg-honorific');
    if (fl) fl.checked = c.showFlame !== false;
    if (sw) sw.checked = c.showSwooshes !== false;
    if (ho) ho.checked = c.autoHonorific !== false;
    window.__certSigLeftPath = c.sigLeftImagePath || '';
    window.__certSigRightPath = c.sigRightImagePath || '';
    const lp = document.getElementById('cert-sig-left-preview');
    const rp = document.getElementById('cert-sig-right-preview');
    if (lp) lp.textContent = window.__certSigLeftPath ? 'Current: ' + window.__certSigLeftPath : 'No left signature image uploaded.';
    if (rp) rp.textContent = window.__certSigRightPath ? 'Current: ' + window.__certSigRightPath : 'No right signature image uploaded.';
}

async function uploadCertSignatureImage(side) {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    const inputId = side === 'left' ? 'cert-sig-left-file' : 'cert-sig-right-file';
    const fileInput = document.getElementById(inputId);
    const admin = getStoredAdminUser();
    if (!sid) return alert('Select a seminar');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return alert('Choose an image file first');
    const fd = new FormData();
    fd.append('signatureFile', fileInput.files[0]);
    fd.append('seminarId', sid);
    fd.append('certType', certType);
    fd.append('side', side);
    if (admin && admin.id) fd.append('adminUserId', String(admin.id));
    try {
        const res = await fetch('/api/admin/certificates/signature-image', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        if (side === 'left') window.__certSigLeftPath = data.path;
        else window.__certSigRightPath = data.path;
        await loadCertTemplateConfig();
        alert('Signature image uploaded.');
    } catch (e) {
        alert(e.message || 'Upload failed');
    }
}

async function loadCertTemplateConfig() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    const msg = document.getElementById('cert-cfg-msg');
    if (!sid) {
        if (msg) msg.textContent = 'Select a seminar to load certificate design.';
        return;
    }
    if (msg) msg.textContent = 'Loading…';
    try {
        const res = await fetch(
            `/api/admin/certificates/template-config?seminarId=${encodeURIComponent(sid)}&certType=${encodeURIComponent(certType)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Load failed');
        fillCertConfigForm(data.config);
        if (data.signatureLeftPath) window.__certSigLeftPath = data.signatureLeftPath;
        if (data.signatureRightPath) window.__certSigRightPath = data.signatureRightPath;
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent = data.templateId
                ? 'Loaded design for this seminar (' + (data.isBuiltin ? 'VGMF template' : 'custom file') + ').'
                : 'Defaults loaded — save to create template for this seminar.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message || 'Could not load';
        }
    }
}

async function saveCertTemplateConfig() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    const msg = document.getElementById('cert-cfg-msg');
    if (!sid) return alert('Select a seminar');
    const admin = getStoredAdminUser();
    if (msg) msg.textContent = 'Saving…';
    try {
        const res = await fetch('/api/admin/certificates/template-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: parseInt(sid, 10),
                certType,
                config: readCertConfigFromForm(),
                adminUserId: admin?.id
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        if (msg) {
            msg.style.color = '#15803d';
            msg.textContent = 'Certificate design saved.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message || 'Save failed';
        }
    }
}

async function previewCertTemplate() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    if (!sid) return alert('Select a seminar');
    try {
        const res = await fetch('/api/admin/certificates/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: parseInt(sid, 10),
                certType,
                config: readCertConfigFromForm()
            })
        });
        const html = await res.text();
        if (!res.ok) {
            let err = html;
            try {
                err = JSON.parse(html).error;
            } catch (_) {}
            throw new Error(err || 'Preview failed');
        }
        const w = window.open('', '_blank');
        if (w) {
            w.document.write(html);
            w.document.close();
        } else alert('Allow pop-ups to preview the certificate.');
    } catch (e) {
        alert(e.message || 'Preview failed');
    }
}

async function loadAdminCertificateCandidates() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const tbody = document.getElementById('cert-mgmt-list');
    if (!tbody) return;
    if (!sid) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Select a seminar</td></tr>';
        return;
    }
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Loading…</td></tr>';
    try {
        const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
        const res = await fetch(
            `/api/admin/certificates/candidates?seminarId=${encodeURIComponent(sid)}&certType=${encodeURIComponent(certType)}`
        );
        const rows = await res.json();
        __adminCertCandidatesCache = Array.isArray(rows) ? rows : [];
        renderAdminCertificateCandidatesTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="9">Error loading</td></tr>';
    }
}

function toggleAllCertCandidates(on) {
    document.querySelectorAll('.cert-cand-cb').forEach((cb) => {
        cb.checked = !!on;
    });
}

async function bulkEnableAdminCertificates(enabled) {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    if (!sid) return alert('Select a seminar');
    const userIds = [];
    document.querySelectorAll('.cert-cand-cb:checked').forEach((cb) => {
        userIds.push(parseInt(cb.dataset.userId, 10));
    });
    if (!userIds.length) return alert('Select at least one doctor');
    try {
        const res = await fetch('/api/admin/certificates/bulk-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: parseInt(sid, 10),
                userIds,
                enabled: !!enabled,
                certType
            })
        });
        const data = await res.json();
        if (data.success) {
            loadAdminCertificateCandidates();
            if (data.skipped && data.skipped.length) {
                const lines = data.skipped
                    .slice(0, 5)
                    .map((s) => 'User #' + s.userId + ': ' + (s.error || 'skipped'))
                    .join('\n');
                alert(
                    'Some doctors were not enabled (PRN No. and Application No. are required on every certificate):\n\n' +
                        lines
                );
            }
            if (enabled && data.templateMissing) {
                alert(
                    'Certificate enabled for selected doctors.\n\nApply the VGMF certificate design (or upload a custom template) in this tab — until then, doctors will see “approved” but cannot view the certificate yet.'
                );
            }
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function applyAdminBuiltinCertificate(certType) {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const msg = document.getElementById('cert-mgmt-msg');
    if (!sid) return alert('Select a seminar');
    const admin = getStoredAdminUser();
    if (msg) {
        msg.textContent = 'Applying VGMF design…';
        msg.style.color = '#78716c';
    }
    try {
        const res = await fetch('/api/admin/certificates/builtin-template', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: parseInt(sid, 10),
                certType: certType || 'participant',
                adminUserId: admin?.id
            })
        });
        const data = await res.json();
        if (data.success) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.textContent = data.message || 'VGMF certificate design applied.';
            }
            loadAdminCertificateCandidates();
            loadCertTemplateConfig();
        } else if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = data.error || 'Failed';
        }
    } catch (e) {
        console.error(e);
        if (msg) msg.textContent = 'Network error';
    }
}

async function uploadAdminCertificateTemplate() {
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    const fileInput = document.getElementById('cert-mgmt-file');
    const msg = document.getElementById('cert-mgmt-msg');
    if (!sid) return alert('Select a seminar');
    if (!fileInput?.files?.length) return alert('Choose a template file');
    const admin = getStoredAdminUser();
    const fd = new FormData();
    fd.append('seminarId', sid);
    fd.append('templateFile', fileInput.files[0]);
    if (admin?.id) fd.append('adminUserId', String(admin.id));
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    fd.append('certType', certType);
    if (msg) msg.textContent = 'Uploading…';
    try {
        const res = await fetch('/api/admin/certificates/template', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.textContent = `Template uploaded. Refreshed ${data.refreshedEligible || 0} scanned ticket(s).`;
            }
            fileInput.value = '';
            loadAdminCertificateCandidates();
        } else if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = data.error || 'Upload failed';
        }
    } catch (e) {
        console.error(e);
        if (msg) msg.textContent = 'Network error';
    }
}

async function toggleAdminCertificate(id, enabled) {
    try {
        await fetch(`/api/admin/certificates/${id}/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled })
        });
        loadAdminCertificateCandidates();
    } catch (e) {
        console.error(e);
    }
}

let __adminVolunteerAssignmentsCache = [];

function refreshVolunteerAdminPanels() {
    loadAdminVolunteers().catch(console.error);
    loadAdminVolunteerAssignments().catch(console.error);
}

async function initAdminVolunteerAssignmentsTab() {
    await fillAdminSeminarSelect('vol-assign-seminar', true);
    await loadAdminVolunteerAssignments();
}

async function loadAdminVolunteerAssignments() {
    const tbody = document.getElementById('vol-assign-list');
    if (!tbody) return;
    const sid = document.getElementById('vol-assign-seminar')?.value;
    const st = document.getElementById('vol-assign-status')?.value || '';
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    try {
        let url = '/api/admin/volunteer-assignments?';
        if (sid) url += 'seminarId=' + encodeURIComponent(sid) + '&';
        if (st) url += 'status=' + encodeURIComponent(st) + '&';
        const res = await fetch(url);
        const data = await res.json();
        __adminVolunteerAssignmentsCache = Array.isArray(data.assignments) ? data.assignments : [];
        renderAdminVolunteerAssignmentsTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Error loading assignments</td></tr>';
    }
}

function renderAdminVolunteerAssignmentsTable() {
    const tbody = document.getElementById('vol-assign-list');
    if (!tbody) return;
    const all = __adminVolunteerAssignmentsCache || [];
    const q = adminSearchQ('vol-assign-search');
    const rows = adminSearchFilter(all, q, (v) => {
        const name = [v.first_name, v.last_name].filter(Boolean).join(' ');
        return [
            v.seminar_title,
            name,
            v.user_id_string,
            v.email,
            v.status,
            v.registration_status,
            v.volunteer_ticket_id_string,
            v.application_no,
            v.notes
        ]
            .join(' ')
            .toLowerCase();
    });
    adminSearchSetCount('vol-assign-search-count', q, rows.length, all.length, 'assignments');
    if (!all.length) {
        tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;">No volunteer assignments yet. Use <strong>Add volunteer</strong> or open <strong>Fill application</strong> for an assigned doctor.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;">No assignments match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((v) => {
        const name = [v.first_name, v.last_name].filter(Boolean).join(' ');
        const qual = adminQualFromRegistrationFormData(v.registration_form_data);
        const regSt = String(v.registration_status || '').toLowerCase();
        const hasTicket = !!(v.volunteer_ticket_id_string && String(v.volunteer_ticket_id_string).trim());
        const assignId = v.assignment_id != null ? v.assignment_id : v.id;
        let actions = '';
        actions +=
            '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;margin-right:4px;" onclick="openAdminBehalfForVolunteer(' +
            Number(v.user_id) +
            ',' +
            Number(v.seminar_id) +
            ')">Fill application</button>';
        if (!hasTicket && regSt === 'submitted') {
            actions +=
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;margin-right:4px;" onclick="approveAdminVolunteer(' +
                assignId +
                ')">Issue ticket (₹0)</button>';
        } else if (!hasTicket) {
            actions += '<span style="font-size:0.8rem;color:#64748b;">Waiting for registration</span>';
        } else {
            actions += '<span style="font-size:0.8rem;color:#059669;">Ticket issued</span>';
        }
        actions +=
            '<button type="button" style="padding:4px 8px;font-size:0.8rem;margin-left:4px;" onclick="editVolunteerDuties(' +
            assignId +
            ',' +
            JSON.stringify(String(v.duties || '')) +
            ')">Duties</button>';
        const eventLine = v.event_date
            ? '<div class="muted" style="font-size:0.78rem;">' + escAdmin(String(v.event_date).slice(0, 10)) + '</div>'
            : '';
        const qualLine = qual
            ? '<div class="muted" style="font-size:0.78rem;">Qual: ' + escAdmin(qual) + '</div>'
            : '<div class="muted" style="font-size:0.78rem;">Qual: —</div>';
        tbody.innerHTML += `<tr>
                <td><strong>${escAdmin(v.seminar_title || '—')}</strong>${eventLine}</td>
                <td>${escAdmin(name)}<div class="muted">${escAdmin(v.user_id_string || '')} · ${escAdmin(v.email || '')}</div></td>
                <td>${escAdmin(v.status || '—')}</td>
                <td>${escAdmin(v.registration_status || '—')}${v.application_no ? '<div class="muted">' + escAdmin(v.application_no) + '</div>' : ''}${qualLine}</td>
                <td><code>${escAdmin(v.volunteer_ticket_id_string || '—')}</code></td>
                <td>${escAdmin(v.duties || v.notes || '—')}</td>
                <td>${actions}</td>
            </tr>`;
    });
}

async function initAdminVolunteersTab() {
    await fillAdminSeminarSelect('vol-mgmt-seminar', false);
    await loadAdminVolunteers();
}

async function loadAdminVolunteers() {
    const sid = document.getElementById('vol-mgmt-seminar')?.value;
    const tbody = document.getElementById('vol-mgmt-list');
    if (!tbody) return;
    if (!sid) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Select a seminar</td></tr>';
        return;
    }
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading…</td></tr>';
    try {
        const res = await fetch(`/api/admin/volunteers?seminarId=${encodeURIComponent(sid)}`);
        const rows = await res.json();
        __adminVolunteersCache = Array.isArray(rows) ? rows : [];
        renderAdminVolunteersTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="5">Error</td></tr>';
    }
}

async function addAdminVolunteer() {
    const sid = document.getElementById('vol-mgmt-seminar')?.value;
    const userIdString = String(document.getElementById('vol-mgmt-user-id')?.value || '').trim();
    const notes = document.getElementById('vol-mgmt-notes')?.value || '';
    const duties = document.getElementById('vol-mgmt-duties')?.value || '';
    if (!sid || !userIdString) return alert('Seminar and doctor portal User ID required');
    try {
        const admin = getStoredAdminUser();
        const res = await fetch('/api/admin/volunteers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seminarId: parseInt(sid, 10),
                userIdString,
                notes,
                duties,
                setVolunteerRole: true,
                actingAdminId: admin && admin.id
            })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('vol-mgmt-user-id').value = '';
            alert(
                data.message ||
                    'Volunteer assigned. They must complete registration in the doctor portal; free ticket (₹0) and messages are sent only after that.'
            );
            refreshVolunteerAdminPanels();
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function approveAdminVolunteer(volId) {
    const admin = getStoredAdminUser();
    if (!confirm('Issue free volunteer ticket (₹0)? Doctor must have completed seminar registration first.')) return;
    try {
        const res = await fetch(`/api/admin/volunteers/${volId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: admin?.id })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || 'Approved');
            refreshVolunteerAdminPanels();
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

let __adminReviewers = [];
let __caseProgFieldRows = [];

function setCaseProgMsg(text, ok) {
    const el = document.getElementById('case-prog-msg');
    if (!el) return;
    el.style.color = ok ? '#15803d' : '#b91c1c';
    el.textContent = text || '';
}

function renderCaseProgramCriteriaEditor(criteria) {
    const tbody = document.getElementById('case-prog-criteria-tbody');
    if (!tbody) return;
    const list =
        criteria && criteria.length
            ? criteria
            : [
                  { key: 'criteria_a', label: 'Criteria A', maxMarks: 5 },
                  { key: 'criteria_b', label: 'Criteria B', maxMarks: 5 },
                  { key: 'criteria_c', label: 'Criteria C', maxMarks: 5 },
                  { key: 'criteria_d', label: 'Criteria D', maxMarks: 5 },
                  { key: 'criteria_e', label: 'Criteria E', maxMarks: 5 }
              ];
    __caseProgCriteriaRows = list.map((c, i) => ({
        key: c.key || 'criteria_' + (i + 1),
        label: c.label || 'Criterion ' + (i + 1),
        maxMarks: c.maxMarks != null ? c.maxMarks : 5
    }));
    tbody.innerHTML = '';
    __caseProgCriteriaRows.forEach((c, idx) => {
        tbody.innerHTML +=
            '<tr><td><input type="text" id="case-crit-label-' +
            idx +
            '" value="' +
            String(c.label || '').replace(/"/g, '&quot;') +
            '" style="width:100%;padding:6px;"></td>' +
            '<td><input type="number" min="1" max="100" id="case-crit-max-' +
            idx +
            '" value="' +
            String(c.maxMarks != null ? c.maxMarks : 5) +
            '" style="width:80px;padding:6px;"></td>' +
            '<td><button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b91c1c;" onclick="removeAdminCaseCriterionRow(' +
            idx +
            ')">Remove</button></td></tr>';
    });
    updateCaseProgramCriteriaTotal();
}

function updateCaseProgramCriteriaTotal() {
    const el = document.getElementById('case-prog-criteria-total');
    if (!el) return;
    let sum = 0;
    (__caseProgCriteriaRows || []).forEach((_, idx) => {
        const m = parseInt((document.getElementById('case-crit-max-' + idx) || {}).value, 10);
        if (!Number.isNaN(m)) sum += m;
    });
    el.textContent = 'Total max marks: ' + sum;
}

function addAdminCaseCriterionRow() {
    __caseProgCriteriaRows = __caseProgCriteriaRows || [];
    if (__caseProgCriteriaRows.length >= 12) return alert('Maximum 12 criteria.');
    __caseProgCriteriaRows.push({
        key: 'criteria_' + (__caseProgCriteriaRows.length + 1),
        label: 'Criterion ' + (__caseProgCriteriaRows.length + 1),
        maxMarks: 5
    });
    renderCaseProgramCriteriaEditor(__caseProgCriteriaRows);
}

function removeAdminCaseCriterionRow(idx) {
    __caseProgCriteriaRows = __caseProgCriteriaRows || [];
    if (__caseProgCriteriaRows.length <= 1) return alert('At least one criterion is required.');
    __caseProgCriteriaRows.splice(idx, 1);
    renderCaseProgramCriteriaEditor(__caseProgCriteriaRows);
}

function collectCaseProgramJudgeCriteria() {
    const rows = __caseProgCriteriaRows || [];
    return rows.map((r, idx) => ({
        key: r.key || 'criteria_' + (idx + 1),
        label: ((document.getElementById('case-crit-label-' + idx) || {}).value || r.label || '').trim(),
        maxMarks: Math.max(1, Math.min(100, parseInt((document.getElementById('case-crit-max-' + idx) || {}).value, 10) || 5))
    }));
}

let __caseProgCriteriaRows = [];

function collectCaseProgramFormConfig() {
    const rows = __caseProgFieldRows || [];
    if (!rows.length) {
        return {
            version: 1,
            fields: [
                { key: 'fname', label: 'First name', type: 'text', enabled: true, required: true },
                { key: 'mname', label: 'Middle name', type: 'text', enabled: true, required: false },
                { key: 'lname', label: 'Last name', type: 'text', enabled: true, required: true },
                { key: 'email', label: 'Email', type: 'email', enabled: true, required: true },
                { key: 'phone', label: 'Phone', type: 'text', enabled: true, required: true },
                { key: 'whatsapp', label: 'WhatsApp no.', type: 'text', enabled: true, required: true },
                { key: 'category', label: 'Category', type: 'select', enabled: true, required: true },
                { key: 'topic', label: 'Case topic', type: 'text', enabled: true, required: true },
                { key: 'files', label: 'Upload', type: 'file', enabled: true, required: true }
            ]
        };
    }
    return {
        version: 1,
        fields: rows.map((r, idx) => {
            const enabled = !!(document.getElementById('case-field-en-' + idx) || {}).checked;
            return {
                key: r.key,
                label: (document.getElementById('case-field-label-' + idx) || {}).value || r.key,
                type: r.type || 'text',
                enabled,
                required: enabled && !!(document.getElementById('case-field-req-' + idx) || {}).checked
            };
        })
    };
}

function renderCaseProgramFieldsEditor(fields) {
    const tbody = document.getElementById('case-prog-fields-tbody');
    if (!tbody) return;
    const list = fields && fields.length ? fields : [];
    __caseProgFieldRows = list.map((f) => ({ key: f.key, type: f.type || 'text' }));
    tbody.innerHTML = '';
    list.forEach((f, idx) => {
        tbody.innerHTML += '<tr><td><code>' + String(f.key || '').replace(/</g, '&lt;') + '</code></td>' +
            '<td><input type="text" id="case-field-label-' + idx + '" value="' + String(f.label || '').replace(/"/g, '&quot;') + '" style="margin:0;width:100%;"></td>' +
            '<td><input type="checkbox" id="case-field-en-' + idx + '" ' + (f.enabled !== false ? 'checked' : '') + '></td>' +
            '<td><input type="checkbox" id="case-field-req-' + idx + '" ' + (f.required !== false && f.enabled !== false ? 'checked' : '') + '></td></tr>';
    });
}

async function loadCaseProgramDefaultFields() {
    try {
        const res = await fetch('/api/admin/case/default-form-config');
        const data = await res.json();
        renderCaseProgramFieldsEditor(data.fields || []);
    } catch (e) {
        console.error(e);
        renderCaseProgramFieldsEditor([]);
    }
}

function resetAdminCaseProgramForm() {
    const editId = document.getElementById('case-prog-edit-id');
    if (editId) editId.value = '';
    const heading = document.getElementById('case-prog-form-heading');
    if (heading) heading.textContent = 'New case program';
    ['case-prog-title', 'case-prog-desc', 'case-prog-instructions', 'case-prog-start', 'case-prog-end', 'case-prog-max-total'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const sem = document.getElementById('case-prog-seminar');
    if (sem) sem.value = '';
    const mp = document.getElementById('case-prog-max-per-user');
    if (mp) mp.value = '2';
    const mf = document.getElementById('case-prog-max-files');
    if (mf) mf.value = '5';
    const mm = document.getElementById('case-prog-max-mb');
    if (mm) mm.value = '100';
    const ag = document.getElementById('case-cat-agnikarma');
    const vi = document.getElementById('case-cat-viddhakarma');
    if (ag) ag.checked = true;
    if (vi) vi.checked = true;
    const act = document.getElementById('case-prog-active');
    if (act) act.checked = true;
    setCaseProgMsg('', true);
    loadCaseProgramDefaultFields();
    renderCaseProgramCriteriaEditor(null);
}

async function editAdminCaseProgram(id) {
    try {
        const res = await fetch('/api/admin/case/programs/' + id);
        const p = await res.json();
        if (!res.ok) return alert(p.error || 'Could not load program');
        document.getElementById('case-prog-edit-id').value = String(p.id);
        document.getElementById('case-prog-form-heading').textContent = 'Edit case program';
        document.getElementById('case-prog-title').value = p.title || '';
        document.getElementById('case-prog-desc').value = p.description || '';
        document.getElementById('case-prog-instructions').value = p.instructions || '';
        document.getElementById('case-prog-seminar').value = p.seminar_id ? String(p.seminar_id) : '';
        document.getElementById('case-prog-start').value =
            window.PortalDateTime && window.PortalDateTime.toDatetimeLocal
                ? window.PortalDateTime.toDatetimeLocal(p.registration_start)
                : (p.registration_start || '').slice(0, 16);
        document.getElementById('case-prog-end').value =
            window.PortalDateTime && window.PortalDateTime.toDatetimeLocal
                ? window.PortalDateTime.toDatetimeLocal(p.registration_end)
                : (p.registration_end || '').slice(0, 16);
        document.getElementById('case-prog-max-per-user').value = String(p.maxPresentationsPerUser != null ? p.maxPresentationsPerUser : p.max_presentations_per_user != null ? p.max_presentations_per_user : 2);
        document.getElementById('case-prog-max-total').value = p.maxTotalSubmissions != null ? String(p.maxTotalSubmissions) : p.max_total_submissions != null ? String(p.max_total_submissions) : '';
        const caseSeatsEl = document.getElementById('case-prog-show-seats');
        if (caseSeatsEl) caseSeatsEl.checked = p.showSeatsPublic !== false && p.show_seats_public !== 0;
        document.getElementById('case-prog-max-files').value = String(p.maxFilesPerSubmission != null ? p.maxFilesPerSubmission : p.max_files_per_submission != null ? p.max_files_per_submission : 5);
        document.getElementById('case-prog-max-mb').value = String(p.maxFileSizeMb != null ? p.maxFileSizeMb : p.max_file_size_mb != null ? p.max_file_size_mb : 100);
        const cats = p.enabledCategories || [];
        document.getElementById('case-cat-agnikarma').checked = cats.indexOf('agnikarma') !== -1;
        document.getElementById('case-cat-viddhakarma').checked = cats.indexOf('viddhakarma') !== -1;
        document.getElementById('case-prog-active').checked =
            p.is_active !== 0 && p.is_active !== false && String(p.is_active) !== 'false';
        renderCaseProgramFieldsEditor((p.formConfig && p.formConfig.fields) || []);
        renderCaseProgramCriteriaEditor(p.judgeCriteria || []);
        setCaseProgMsg('Editing program #' + p.id, true);
    } catch (e) {
        console.error(e);
        alert('Network error loading program');
    }
}

async function loadAdminCaseReviewers() {
    try {
        const res = await fetch('/api/admin/case/reviewers');
        __adminReviewers = res.ok ? await res.json() : [];
        if (!Array.isArray(__adminReviewers)) __adminReviewers = [];
    } catch (e) {
        console.error(e);
        __adminReviewers = [];
    }
}

async function initAdminCaseMgmtTab() {
    await fillAdminSeminarSelect('case-prog-seminar', true);
    if (!document.getElementById('case-prog-edit-id') || !document.getElementById('case-prog-edit-id').value) {
        resetAdminCaseProgramForm();
    }
    await loadAdminCasePrograms();
    await loadAdminCaseSubmissions();
    await loadAdminCaseReviewers();
    await populateCaseResultsProgramSelect();
    await loadAdminCaseResults();
}

function formatCaseCriteriaBreakdown(sc, criteriaDefs) {
    let crit = [];
    try {
        crit = sc.criteria_json ? JSON.parse(sc.criteria_json) : [];
    } catch (_) {
        crit = [];
    }
    if (!Array.isArray(crit) || !crit.length) return '—';
    const defs = criteriaDefs || [];
    let rows = '';
    crit.forEach((c) => {
        const def = defs.find((d) => d.key === c.key) || {};
        const label = def.label || c.key || 'Criterion';
        const max = c.max != null ? c.max : def.maxMarks || 5;
        const score = c.score != null ? c.score : '—';
        rows +=
            '<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">' +
            escAdmin(label) +
            '</td><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:700;">' +
            escAdmin(String(score)) +
            ' / ' +
            escAdmin(String(max)) +
            '</td></tr>';
    });
    return (
        '<table class="data-table" style="margin:0;font-size:0.82rem;min-width:200px;"><thead><tr style="background:#f1f5f9;"><th style="padding:6px 8px;text-align:left;">Criterion</th><th style="padding:6px 8px;text-align:center;">Score</th></tr></thead><tbody>' +
        rows +
        '</tbody></table>'
    );
}

async function populateCaseResultsProgramSelect() {
    const sel = document.getElementById('case-results-program');
    if (!sel) return;
    try {
        const res = await fetch('/api/admin/case/programs');
        const rows = await res.json();
        sel.innerHTML = '<option value="">All programs</option>';
        (rows || []).forEach((p) => {
            const opt = document.createElement('option');
            opt.value = String(p.id);
            opt.textContent = p.title || 'Program ' + p.id;
            sel.appendChild(opt);
        });
    } catch (e) {
        console.error(e);
    }
}

function downloadCaseMarksheet(format) {
    const programId = document.getElementById('case-results-program')?.value || '';
    const q = programId ? '?programId=' + encodeURIComponent(programId) + '&' : '?';
    const fmt = format || 'xlsx';
    if (fmt === 'pdf') {
        window.open('/api/admin/case/marksheet' + (programId ? '?programId=' + encodeURIComponent(programId) : '') + '&format=pdf', '_blank');
        return;
    }
    window.location.href = '/api/admin/case/marksheet' + (programId ? '?programId=' + encodeURIComponent(programId) + '&' : '?') + 'format=xlsx';
}

async function loadAdminCaseMarksheetPreview() {
    const panel = document.getElementById('case-marksheet-panel');
    if (!panel) return;
    panel.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    const programId = document.getElementById('case-results-program')?.value || '';
    const q = programId ? '?programId=' + encodeURIComponent(programId) : '';
    try {
        const res = await fetch('/api/admin/case/marksheet' + q);
        const data = await res.json();
        const rows = (data.rows || []).slice(0, 80);
        if (!rows.length) {
            panel.innerHTML = '<p style="color:#64748b;">No marksheet rows yet.</p>';
            return;
        }
        const keys = Object.keys(rows[0]);
        let html = '<table class="data-table" style="font-size:0.78rem;"><thead><tr>';
        keys.forEach((k) => {
            html += '<th>' + escAdmin(k) + '</th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach((r) => {
            html += '<tr>';
            keys.forEach((k) => {
                html += '<td>' + escAdmin(r[k] != null ? String(r[k]) : '') + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        if ((data.rows || []).length > 80) {
            html += '<p style="color:#64748b;font-size:0.82rem;margin-top:8px;">Showing first 80 rows — download Excel for full marksheet.</p>';
        }
        panel.innerHTML = html;
    } catch (e) {
        console.error(e);
        panel.innerHTML = '<p style="color:#b91c1c;">Could not load marksheet.</p>';
    }
}

async function loadAdminCaseResults() {
    const panel = document.getElementById('case-results-panel');
    if (!panel) return;
    panel.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    const programId = document.getElementById('case-results-program')?.value || '';
    const q = programId ? '?programId=' + encodeURIComponent(programId) : '';
    try {
        const res = await fetch('/api/admin/case/results' + q);
        const data = await res.json();
        const rows = data.results || [];
        const criteria = data.criteria || [];
        const totalMax = data.totalMax != null ? data.totalMax : 25;
        if (!rows.length) {
            panel.innerHTML = '<p style="color:#64748b;">No scored submissions yet.</p>';
            return;
        }
        let topScore = null;
        rows.forEach((r) => {
            const s = r.avg_score != null ? Number(r.avg_score) : null;
            if (s != null && (topScore == null || s > topScore)) topScore = s;
        });
        const passPct = 60;
        const passMin = (totalMax * passPct) / 100;
        let html =
            '<table class="data-table"><thead><tr><th>Rank</th><th>App</th><th>Doctor</th><th>Topic</th><th>Avg / ' +
            escAdmin(String(totalMax)) +
            '</th><th>Judges</th><th>Auto eligibility</th><th>Status</th></tr></thead><tbody>';
        rows.forEach((r, idx) => {
            const avg = r.avg_score != null ? Number(r.avg_score) : null;
            const isTop = avg != null && topScore != null && avg === topScore && (r.judges_scored || 0) > 0;
            const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
            let elig = 'Pending scores';
            if (r.plagiarism_zero) elig = 'Disqualified';
            else if ((r.judges_scored || 0) > 0 && avg != null) {
                elig = avg >= passMin ? 'Eligible' : 'Not eligible';
            }
            html +=
                '<tr style="' +
                (isTop ? 'background:#ecfdf5;font-weight:700;' : '') +
                '"><td>' +
                (idx + 1) +
                (isTop ? ' <span style="color:#059669;">★</span>' : '') +
                '</td><td><code>' +
                escAdmin(r.application_no || r.id) +
                '</code></td><td>' +
                escAdmin(name) +
                '</td><td>' +
                escAdmin(r.title || '—') +
                '</td><td>' +
                escAdmin(avg != null ? String(avg) : '—') +
                '</td><td>' +
                escAdmin(String(r.judges_scored || 0)) +
                '</td><td>' +
                escAdmin(elig) +
                '</td><td>' +
                escAdmin(r.status || '—') +
                '</td></tr>';
        });
        html += '</tbody></table>';
        panel.innerHTML = html;
        window.__caseCriteriaDefs = criteria;
        loadAdminCaseMarksheetPreview();
    } catch (e) {
        console.error(e);
        panel.innerHTML = '<p style="color:#b91c1c;">Could not load results.</p>';
    }
}

async function loadAdminCasePrograms() {
    const box = document.getElementById('case-prog-list');
    if (!box) return;
    try {
        const res = await fetch('/api/admin/case/programs');
        const text = await res.text();
        let rows = [];
        try {
            rows = text ? JSON.parse(text) : [];
        } catch (parseErr) {
            box.innerHTML = '<p style="color:#b91c1c;">Could not load programs (HTTP ' + res.status + '). Restart the server.</p>';
            return;
        }
        __adminCaseProgramsCache = Array.isArray(rows) ? rows : [];
        renderAdminCaseProgramsList();

    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Error loading programs.</p>';
    }
}

async function saveAdminCaseProgram() {
    const title = document.getElementById('case-prog-title') && document.getElementById('case-prog-title').value.trim();
    if (!title) return alert('Title is required');
    const enabledCategories = [];
    if (document.getElementById('case-cat-agnikarma') && document.getElementById('case-cat-agnikarma').checked) enabledCategories.push('agnikarma');
    if (document.getElementById('case-cat-viddhakarma') && document.getElementById('case-cat-viddhakarma').checked) enabledCategories.push('viddhakarma');
    if (!enabledCategories.length) return alert('Select at least one category');
    const editId = document.getElementById('case-prog-edit-id') && document.getElementById('case-prog-edit-id').value.trim();
    const payload = {
        title: title,
        description: (document.getElementById('case-prog-desc') || {}).value || '',
        instructions: (document.getElementById('case-prog-instructions') || {}).value || '',
        seminarId: (document.getElementById('case-prog-seminar') || {}).value || null,
        registrationStart: window.PortalDateTime
            ? window.PortalDateTime.fromDatetimeLocal((document.getElementById('case-prog-start') || {}).value)
            : (document.getElementById('case-prog-start') || {}).value || null,
        registrationEnd: window.PortalDateTime
            ? window.PortalDateTime.fromDatetimeLocal((document.getElementById('case-prog-end') || {}).value)
            : (document.getElementById('case-prog-end') || {}).value || null,
        maxPresentationsPerUser: (document.getElementById('case-prog-max-per-user') || {}).value || 2,
        maxTotalSubmissions: (document.getElementById('case-prog-max-total') || {}).value || null,
        showSeatsPublic: document.getElementById('case-prog-show-seats')?.checked === true,
        maxFilesPerSubmission: (document.getElementById('case-prog-max-files') || {}).value || 5,
        maxFileSizeMb: (document.getElementById('case-prog-max-mb') || {}).value || 100,
        enabledCategories: enabledCategories,
        isActive: document.getElementById('case-prog-active') ? document.getElementById('case-prog-active').checked !== false : true,
        formConfig: collectCaseProgramFormConfig(),
        judgeCriteria: collectCaseProgramJudgeCriteria()
    };
    const crit = payload.judgeCriteria;
    if (!crit.length) return alert('Add at least one judging criterion with max marks.');
    const url = editId ? '/api/admin/case/programs/' + editId : '/api/admin/case/programs';
    const method = editId ? 'PUT' : 'POST';
    setCaseProgMsg('Saving…', true);
    try {
        const res = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e2) {
            setCaseProgMsg('Server error (' + res.status + '). Restart the server.', false);
            return;
        }
        if (!res.ok) {
            setCaseProgMsg(data.error || 'Save failed (HTTP ' + res.status + ')', false);
            return;
        }
        if (data.success) {
            setCaseProgMsg(editId ? 'Program updated.' : 'Program created.', true);
            resetAdminCaseProgramForm();
            loadAdminCasePrograms();
        } else {
            setCaseProgMsg(data.error || 'Save failed', false);
        }
    } catch (e) {
        console.error(e);
        setCaseProgMsg('Network error — is the server running?', false);
    }
}

async function loadAdminCaseSubmissions() {
    const tbody = document.getElementById('case-mgmt-list');
    if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    try {
        const res = await fetch('/api/admin/case/submissions');
        const rows = await res.json();
        __adminCaseSubmissionsCache = Array.isArray(rows) ? rows : [];
        renderAdminCaseSubmissionsTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7">Error</td></tr>';
    }
}

async function openAdminCaseDetail(subId) {
    const box = document.getElementById('case-mgmt-detail');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = 'Loading…';
    await loadAdminCaseReviewers();
    try {
        const [res, scoresRes] = await Promise.all([
            fetch(`/api/admin/case/submissions/${subId}`),
            fetch(`/api/admin/case/submissions/${subId}/scores`)
        ]);
        const data = await res.json();
        const scoresPayload = scoresRes.ok ? await scoresRes.json() : [];
        const scores = Array.isArray(scoresPayload) ? scoresPayload : scoresPayload.scores || [];
        if (scoresPayload.criteria && scoresPayload.criteria.length) {
            window.__caseCriteriaDefs = scoresPayload.criteria;
        }
        const sub = data.submission;
        let caseFormJsonText = sub.form_data || '{}';
        try {
            const parsedFd =
                typeof caseFormJsonText === 'string' ? JSON.parse(caseFormJsonText) : caseFormJsonText;
            caseFormJsonText = JSON.stringify(parsedFd, null, 2);
        } catch (_) {
            caseFormJsonText = String(sub.form_data || '{}');
        }
        const files = data.files || [];
        const assigned = data.assignedJudges || [];
        let judgeOpts = (__adminReviewers || [])
            .map(
                (j) =>
                    '<label style="display:block;margin:4px 0;"><input type="checkbox" class="case-judge-cb" value="' +
                    j.id +
                    '"> ' +
                    escAdmin(j.first_name) +
                    ' ' +
                    escAdmin(j.last_name) +
                    ' <span class="muted">(ID ' +
                    escAdmin(j.user_id_string || j.id) +
                    ')</span></label>'
            )
            .join('');
        if (!judgeOpts) {
            judgeOpts = '<p class="muted">No judge accounts. In Staff users, set role to Judge (judge_user).</p>';
        }
        const assignedHtml = assigned.length
            ? '<div style="margin:8px 0;"><strong>Assigned judges</strong>' +
              assigned
                  .map(
                      (j) =>
                          '<div style="margin:8px 0;padding:8px;border:1px solid #e2e8f0;border-radius:8px;">' +
                          escAdmin(j.first_name) +
                          ' ' +
                          escAdmin(j.last_name) +
                          ' <span class="muted">(' +
                          escAdmin(j.user_id_string) +
                          ')</span>' +
                          '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">' +
                          '<select class="case-transfer-judge-select" data-from-judge="' +
                          j.id +
                          '" style="flex:1;min-width:180px;padding:6px 8px;"><option value="">Transfer to…</option>' +
                          (__adminReviewers || [])
                              .filter((x) => x.id !== j.id)
                              .map(
                                  (x) =>
                                      '<option value="' +
                                      x.id +
                                      '">' +
                                      escAdmin(x.first_name) +
                                      ' ' +
                                      escAdmin(x.last_name) +
                                      '</option>'
                              )
                              .join('') +
                          '</select>' +
                          '<button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;background:#b45309;" onclick="adminTransferCaseJudge(' +
                          sub.id +
                          ',' +
                          j.id +
                          ')">Transfer</button></div></div>'
                  )
                  .join('') +
              '</div>'
            : '';
        let html = `<h3>Application <code>${escAdmin(sub.application_no || sub.id)}</code></h3>
            <p class="muted">${escAdmin(sub.first_name)} ${escAdmin(sub.last_name)} · ${escAdmin(sub.category)} · ${escAdmin(sub.status)}</p>
            <p><strong>Topic:</strong> ${escAdmin(sub.title)}</p>
            <hr style="margin:14px 0;">
            <h4>Edit case submission (live)</h4>
            <div class="form-group"><label>Topic / title</label><input type="text" id="admin-case-edit-title" value="${escAdmin(sub.title || '')}" style="width:100%;padding:8px;"></div>
            <div class="form-group"><label>Category</label><input type="text" id="admin-case-edit-category" value="${escAdmin(sub.category || '')}" style="width:100%;padding:8px;"></div>
            <div class="form-group"><label>Form data (JSON)</label><textarea id="admin-case-form-json" rows="8" style="width:100%;font-family:monospace;font-size:0.85rem;">${escAdmin(caseFormJsonText)}</textarea></div>
            <button type="button" class="btn-primary" onclick="adminSaveCaseSubmissionEdit(${sub.id})">Save case changes</button>
            <div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn-primary" style="background:#b91c1c;" onclick="markCasePlagiarism(${sub.id})">Duplicate / zero marks</button>
                <button type="button" class="btn-primary" style="background:#15803d;" onclick="selectCaseWinner(${sub.id})">Mark winner</button>
            </div>
            <div style="margin:12px 0;"><label>Assign reviewers</label>${assignedHtml}<div id="case-judge-checkboxes">${judgeOpts}</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;">
            <button type="button" class="btn-primary" onclick="assignCaseJudgesFromCheckboxes(${sub.id})">Assign selected</button>
            <span class="muted">or portal ID:</span>
            <input type="text" id="case-judge-id-string" placeholder="393671924601" style="padding:6px 10px;max-width:200px;">
            <button type="button" class="btn-primary" style="background:#64748b;" onclick="assignCaseJudgeByPortalId(${sub.id})">Assign by ID</button></div>
            <h4>Files</h4><ul style="list-style:none;padding:0;">`;
        files.forEach((f) => {
            html += `<li style="border:1px solid #e2e8f0;padding:10px;margin-bottom:8px;border-radius:8px;">
                <a href="${escAdmin(f.file_path)}" target="_blank">${escAdmin(f.original_name)}</a>
                <span style="margin-left:8px;">Status: <strong>${escAdmin(f.status || 'pending')}</strong></span>
                ${f.rejection_reason ? `<div class="muted">Reason: ${escAdmin(f.rejection_reason)}</div>` : ''}
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                    <button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;background:#15803d;" onclick="reviewCaseFile(${f.id},'approved')">Approve</button>
                    <button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;background:#b91c1c;" onclick="reviewCaseFile(${f.id},'rejected')">Reject</button>
                </div></li>`;
        });
        html += '</ul>';
        const caseSt = String(sub.status || '').toLowerCase();
        const caseCanVerify = ['submitted', 'under_review', 'resubmitted'].includes(caseSt);
        if (caseCanVerify) {
            html += `<hr style="margin:16px 0;"><h4>Verify case application</h4>
                <label style="display:block;margin:6px 0;"><input type="checkbox" id="case-verify-info"> Applicant details & topic are correct</label>
                <label style="display:block;margin:6px 0;"><input type="checkbox" id="case-verify-files"> All files reviewed and acceptable</label>
                <div class="form-group"><label>Reason (for rejections)</label>
                <textarea id="case-verify-reason" rows="2" style="width:100%;"></textarea></div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
                <button type="button" class="btn-primary" style="background:#15803d;" onclick="adminVerifyCaseSubmission(${sub.id},'approve_for_judging')">Approve for judging</button>
                <button type="button" class="btn-primary" style="background:#b45309;" onclick="adminVerifyCaseSubmission(${sub.id},'reject_documents')">Request document revision</button>
                <button type="button" class="btn-primary" style="background:#b91c1c;" onclick="adminVerifyCaseSubmission(${sub.id},'reject_application')">Reject application</button>
                </div>`;
        }
        if (Array.isArray(scores) && scores.length) {
            const critDefs = window.__caseCriteriaDefs || [];
            const scoreMax =
                scoresPayload.totalMax != null
                    ? scoresPayload.totalMax
                    : critDefs.reduce((s, c) => s + (c.maxMarks || 0), 0) || 25;
            html +=
                '<h4 style="margin-top:16px;">Judge scores (criteria + total)</h4><table class="data-table"><thead><tr><th>Judge</th><th>Criteria breakdown</th><th>Total / ' +
                escAdmin(String(scoreMax)) +
                '</th><th>Locked</th></tr></thead><tbody>';
            scores.forEach((sc) => {
                const jname = [sc.first_name, sc.last_name].filter(Boolean).join(' ') || sc.user_id_string;
                html +=
                    `<tr><td>${escAdmin(jname)}</td><td style="font-size:0.85rem;">${formatCaseCriteriaBreakdown(sc, critDefs)}</td><td><strong>${escAdmin(sc.total_score != null ? String(sc.total_score) : '—')}</strong></td><td>${sc.is_locked ? 'Yes' : 'No'}</td></tr>`;
            });
            html += '</tbody></table>';
            loadAdminCaseResults().catch(() => {});
        }
        box.innerHTML = html;
        box.dataset.subId = String(subId);
    } catch (e) {
        console.error(e);
        box.innerHTML = 'Error loading detail';
    }
}


async function adminTransferCaseJudge(subId, fromJudgeId) {
    const sel = document.querySelector('.case-transfer-judge-select[data-from-judge="' + fromJudgeId + '"]');
    const toJudgeUserId = sel ? parseInt(sel.value, 10) : NaN;
    if (!Number.isInteger(toJudgeUserId) || toJudgeUserId < 1) return alert('Select a judge from the list');
    const adm = getStoredAdminUser();
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId + '/transfer-judge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fromJudgeId,
                toJudgeUserId,
                actingAdminId: adm && adm.id
            })
        });
        const data = await res.json();
        if (data.success) {
            alert('Case transferred successfully');
            openAdminCaseDetail(subId);
        } else alert(data.error || 'Transfer failed');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function adminTransferSupportTicket() {
    if (!currentViewingTicketId) return alert('Open a ticket first');
    const ref = document.getElementById('ticket-transfer-user-ref')?.value?.trim();
    if (!ref) return alert('Enter target portal user ID');
    const adm = getStoredAdminUser();
    const msgEl = document.getElementById('ticket-transfer-msg');
    try {
        const res = await fetch(
            '/api/admin/support-ticket/' + encodeURIComponent(currentViewingTicketId) + '/transfer',
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserRef: ref, actingAdminId: adm && adm.id })
            }
        );
        const data = await res.json();
        if (!res.ok) {
            if (msgEl) {
                msgEl.textContent = data.error || 'Transfer failed';
                msgEl.style.color = '#b91c1c';
                msgEl.classList.remove('hidden');
            }
            return;
        }
        if (msgEl) {
            msgEl.textContent = 'Transferred to ' + (data.userIdString || ref);
            msgEl.style.color = '#059669';
            msgEl.classList.remove('hidden');
        }
        viewSupportTicket(currentViewingTicketId);
        loadSupportTickets();
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function assignCaseJudgeByPortalId(subId) {
    const uidStr = document.getElementById('case-judge-id-string')?.value?.trim();
    if (!uidStr) return alert('Enter judge portal ID (12-digit number)');
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId + '/assign-judges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ judgeUserIdString: uidStr })
        });
        const data = await res.json();
        if (data.success) {
            alert('Judge assigned (ID ' + uidStr + ')');
            openAdminCaseDetail(subId);
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function assignCaseJudgesFromCheckboxes(subId) {
    const judgeIds = [];
    document.querySelectorAll('.case-judge-cb:checked').forEach((cb) => judgeIds.push(parseInt(cb.value, 10)));
    if (!judgeIds.length) return alert('Select at least one reviewer');
    try {
        const res = await fetch(`/api/admin/case/submissions/${subId}/assign-judges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ judgeIds })
        });
        const data = await res.json();
        if (data.success) alert('Reviewers assigned');
        else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function markCasePlagiarism(subId) {
    const reason = prompt('Reason for duplicate/plagiarism (zero marks):') || 'Duplicate submission';
    try {
        const res = await fetch(`/api/admin/case/submissions/${subId}/mark-plagiarism`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (data.success) {
            alert('Marked as duplicate — zero marks');
            openAdminCaseDetail(subId);
            loadAdminCaseSubmissions();
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function selectCaseWinner(subId) {
    if (!confirm('Mark this applicant as case winner?')) return;
    try {
        const res = await fetch(`/api/admin/case/submissions/${subId}/select-winner`, { method: 'POST' });
        const data = await res.json();
        alert(data.message || data.error || 'Done');
        loadAdminCaseSubmissions();
        openAdminCaseDetail(subId);
    } catch (e) {
        console.error(e);
    }
}

async function adminVerifyCaseSubmission(subId, decision) {
    const reason = (document.getElementById('case-verify-reason')?.value || '').trim();
    const infoOk = !!document.getElementById('case-verify-info')?.checked;
    const filesOk = !!document.getElementById('case-verify-files')?.checked;
    if (decision !== 'approve_for_judging' && !reason) {
        return alert('Please enter a reason for the doctor.');
    }
    if (decision === 'approve_for_judging' && !infoOk) {
        return alert('Confirm applicant details are correct.');
    }
    if (!confirm('Apply this verification decision?')) return;
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId + '/document-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, reason, infoOk, filesOk })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Done');
        openAdminCaseDetail(subId);
        loadAdminCaseSubmissions();
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function reviewCaseFile(fileId, status) {
    let reason = '';
    if (status === 'rejected') {
        reason = prompt('Rejection reason (required):') || '';
        if (!reason.trim()) return;
    }
    try {
        const res = await fetch(`/api/admin/case/files/${fileId}/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, reason })
        });
        const data = await res.json();
        if (data.success) {
            const subId = document.getElementById('case-mgmt-detail')?.dataset?.subId;
            if (subId) openAdminCaseDetail(parseInt(subId, 10));
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function assignCaseJudges(subId) {
    const raw = document.getElementById('case-judge-ids')?.value || '';
    const judgeIds = raw
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((x) => x > 0);
    if (!judgeIds.length) return alert('Enter judge user IDs');
    try {
        const res = await fetch(`/api/admin/case/submissions/${subId}/assign-judges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ judgeIds })
        });
        const data = await res.json();
        if (data.success) alert('Judges assigned');
        else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function initAdminAnalyticsTab() {
    await fillAdminSeminarSelect('analytics-seminar', false);
    const sid = document.getElementById('analytics-seminar')?.value;
    if (sid) loadAdminSeminarAnalytics();
}

function renderAnalyticsList(title, items) {
    if (!items || !items.length) return `<p class="muted" style="font-size:0.85rem;">No ${escAdmin(title)} data yet.</p>`;
    return (
        '<ul style="margin:0;padding-left:18px;font-size:0.88rem;">' +
        items
            .map((x) => `<li>${escAdmin(x.name)} — <strong>${x.count}</strong></li>`)
            .join('') +
        '</ul>'
    );
}

async function loadAdminSeminarAnalytics() {
    const sid = document.getElementById('analytics-seminar')?.value;
    const host = document.getElementById('analytics-dashboard');
    if (!host) return;
    if (!sid) {
        host.innerHTML = '<p style="color:#64748b;">Select a seminar.</p>';
        return;
    }
    host.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/admin/analytics/seminar/' + encodeURIComponent(sid));
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Failed');
        const rev = d.revenue || {};
        const ps = d.practitionerVsStudent || {};
        host.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px;">
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Registered</div><strong>${d.registered || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Confirmed</div><strong>${d.confirmed || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Paid</div><strong>${d.paid || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Checked in</div><strong>${d.scanned || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">No-shows (paid)</div><strong>${d.noShow || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Verification pending</div><strong>${d.verificationPending || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Payment pending</div><strong>${d.paymentPending || 0}</strong></div>
                <div class="card" style="padding:12px;"><div class="muted" style="font-size:0.75rem;">Revenue (₹)</div><strong>${rev.collected || 0}</strong></div>
            </div>
            <p style="font-size:0.85rem;color:#64748b;">Attendance rate (checked-in ÷ paid): <strong>${d.attendanceRate || 0}%</strong></p>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:14px;">
                <div><h4 style="margin:0 0 6px;">By state</h4>${renderAnalyticsList('state', d.byState)}</div>
                <div><h4 style="margin:0 0 6px;">By city</h4>${renderAnalyticsList('city', d.byCity)}</div>
                <div><h4 style="margin:0 0 6px;">By qualification</h4>${renderAnalyticsList('qualification', d.byQual)}</div>
                <div><h4 style="margin:0 0 6px;">Top colleges</h4>${renderAnalyticsList('college', d.byCollege)}</div>
                <div><h4 style="margin:0 0 6px;">Practitioner vs student</h4>
                    <ul style="margin:0;padding-left:18px;font-size:0.88rem;">
                        <li>Practitioner / PG — <strong>${ps.practitioner || 0}</strong></li>
                        <li>UG student — <strong>${ps.student || 0}</strong></li>
                        <li>Other — <strong>${ps.other || 0}</strong></li>
                    </ul>
                </div>
            </div>`;
    } catch (e) {
        host.innerHTML = '<p style="color:#b91c1c;">' + escAdmin(e.message) + '</p>';
    }
}

async function initAdminReportsTab() {
    await fillAdminSeminarSelect('report-seminar', false);
    await fillAdminSeminarSelect('reg-ov-seminar', false);
    await loadAdminRegistrationOverrides();
}

function downloadAdminReport(type, format) {
    const sid = document.getElementById('report-seminar')?.value;
    if (!sid) return alert('Select a seminar');
    const fmt = format || 'xlsx';
    window.location.href = `/api/admin/reports/${sid}/${type}?format=${encodeURIComponent(fmt)}`;
}

async function saveAdminRegistrationOverride() {
    const userIdString = String(document.getElementById('reg-ov-user-id')?.value || '').trim();
    const sid = parseInt(document.getElementById('reg-ov-seminar')?.value, 10);
    const note = document.getElementById('reg-ov-note')?.value || '';
    const admin = getStoredAdminUser();
    if (!userIdString || !sid) return alert('Portal User ID and seminar required');
    try {
        const res = await fetch('/api/admin/registration-overrides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIdString, seminarId: sid, enabled: true, note, adminUserId: admin?.id })
        });
        const data = await res.json();
        if (data.success) {
            loadAdminRegistrationOverrides();
            alert('Override saved — doctor can register while seminar is closed.');
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function loadAdminRegistrationOverrides() {
    const tbody = document.getElementById('reg-ov-list');
    if (!tbody) return;
    try {
        const res = await fetch('/api/admin/registration-overrides');
        const rows = await res.json();
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No overrides</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        rows.forEach((r) => {
            const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
            tbody.innerHTML += `<tr>
                <td>${escAdmin(name)} (${escAdmin(r.user_id_string)})</td>
                <td>${escAdmin(r.seminar_title)}</td>
                <td>${r.enabled ? 'Yes' : 'No'}</td>
                <td>${escAdmin(r.note || '—')}</td>
            </tr>`;
        });
    } catch (e) {
        console.error(e);
    }
}

async function initAdminBrandingPreview() {
    try {
        const res = await fetch('/api/branding/logo');
        const data = await res.json();
        const el = document.getElementById('setting-logo-preview');
        if (el && data.logoPath) {
            el.innerHTML = `<img src="${escAdmin(data.logoPath)}" alt="Logo" style="max-height:48px;">`;
        }
    } catch (e) {
        console.error(e);
    }
}

async function uploadAdminSiteLogo() {
    const fileInput = document.getElementById('setting-logo-file');
    if (!fileInput?.files?.length) return alert('Choose an image');
    const fd = new FormData();
    fd.append('logo', fileInput.files[0]);
    try {
        const res = await fetch('/api/admin/branding/logo', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
            initAdminBrandingPreview();
            if (typeof window.reloadSiteBranding === 'function') {
                await window.reloadSiteBranding();
            }
            alert('Logo saved. It will appear on all pages after a refresh (live site stores logo in the database).');
        } else alert(data.error || 'Upload failed');
    } catch (e) {
        console.error(e);
    }
}

function formatActivityLogTimeIst(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    } catch (_) {
        return iso;
    }
}

async function initAdminActivityLogsTab() {
    await loadAdminActivityLogs();
}

async function loadAdminActivityLogs() {
    const tbody = document.getElementById('activity-logs-list');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    const uid = (document.getElementById('activity-log-user-id') || {}).value.trim();
    const action = (document.getElementById('activity-log-action') || {}).value.trim();
    const role = (document.getElementById('activity-log-role') || {}).value.trim();
    const q = new URLSearchParams();
    if (uid) q.set('userId', uid);
    if (action) q.set('action', action);
    if (role) q.set('role', role);
    q.set('limit', '200');
    try {
        const res = await fetch('/api/admin/activity-logs?' + q.toString());
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No activity yet</td></tr>';
            return;
        }
        tbody.innerHTML = rows
            .map((r) => {
                const name =
                    [r.first_name, r.last_name].filter(Boolean).join(' ') ||
                    r.email ||
                    (r.user_id ? 'User #' + r.user_id : '—');
                const resource = [r.resource_type, r.resource_id].filter(Boolean).join(' ');
                let meta = '';
                try {
                    meta = r.meta ? JSON.stringify(JSON.parse(r.meta)) : '';
                } catch (_) {
                    meta = r.meta || '';
                }
                return `<tr>
                    <td style="white-space:nowrap;font-size:0.82rem;">${escapeHtml(formatActivityLogTimeIst(r.created_at))}</td>
                    <td><code>${escapeHtml(r.user_id_string || '')}</code><br><span style="font-size:0.82rem;">${escapeHtml(name)}</span></td>
                    <td>${escapeHtml(r.user_role || r.account_role || '')}</td>
                    <td><code>${escapeHtml(r.action || '')}</code></td>
                    <td style="font-size:0.82rem;">${escapeHtml(resource)}</td>
                    <td style="font-size:0.78rem;max-width:220px;word-break:break-word;">${escapeHtml(meta.slice(0, 160))}</td>
                    <td style="font-size:0.78rem;">${escapeHtml(r.ip || '')}</td>
                </tr>`;
            })
            .join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Failed to load</td></tr>';
    }
}

async function checkWhatsAppWebhookStatus() {
    try {
        const probe = (document.getElementById('int-wa-verify') || {}).value.trim();
        const q = probe ? '?probe=' + encodeURIComponent(probe) : '';
        const res = await fetch('/api/admin/integrations/whatsapp-webhook-status' + q);
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Check failed');
        const lines = [
            'Webhook URL (paste in Meta):',
            data.webhook_url || '',
            '',
            data.verify_token_configured
                ? 'Server verify token: saved (' + data.verify_token_length + ' characters)'
                : 'Server verify token: NOT SET',
            probe
                ? 'Token in this box: ' + probe.length + ' characters — ' + (data.probe_match ? 'MATCHES server' : 'does NOT match server')
                : 'Tip: type the token you want in Meta into “Webhook verify token”, Save integrations, then check again.',
            data.probe_hint || '',
            '',
            data.hint || ''
        ];
        if (probe && data.webhook_url) {
            const live = await fetch(
                data.webhook_url +
                    '?hub.mode=subscribe&hub.verify_token=' +
                    encodeURIComponent(probe) +
                    '&hub.challenge=meta_probe_ok'
            );
            const body = await live.text();
            lines.push('');
            lines.push(
                live.ok && body === 'meta_probe_ok'
                    ? 'Live Meta test: OK — click Verify and save in Meta now.'
                    : 'Live Meta test: FAILED (HTTP ' + live.status + ') — ' + body.slice(0, 120)
            );
        }
        alert(lines.filter(Boolean).join('\n'));
    } catch (e) {
        alert('Check failed: ' + (e.message || e));
    }
}

async function loadAdminScannerLogs() {
    const tbody = document.getElementById('scanner-logs-list');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    const sid = document.getElementById('scanner-log-seminar')?.value || '';
    const q = sid ? `?seminarId=${encodeURIComponent(sid)}` : '';
    try {
        const res = await fetch('/api/admin/scanner/logs' + q);
        const rows = await res.json();
        __adminScannerLogsCache = Array.isArray(rows) ? rows : [];
        renderAdminScannerLogsTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7">Error</td></tr>';
    }
}

let __adminEticketSelection = null;

function initAdminEticketsTab() {
    const st = document.getElementById('eticket-lookup-status');
    if (st) st.textContent = '';
    const wrap = document.getElementById('eticket-results-wrap');
    if (wrap) wrap.classList.add('hidden');
    __adminEticketSelection = null;
}

function renderAdminEticketDetail(row) {
    __adminEticketSelection = row;
    const wrap = document.getElementById('eticket-results-wrap');
    const panel = document.getElementById('eticket-detail-panel');
    const preview = document.getElementById('eticket-preview-link');
    const actSt = document.getElementById('eticket-action-status');
    if (!wrap || !panel) return;
    wrap.classList.remove('hidden');
    if (actSt) actSt.textContent = '';
    const pay = String(row.paymentStatus || '').toLowerCase() === 'success' ? 'Paid' : row.paymentStatus || '—';
    panel.innerHTML =
        '<p><strong>Doctor:</strong> ' +
        escAdmin(row.doctorName) +
        '<br><strong>Email:</strong> ' +
        escAdmin(row.email) +
        ' · <strong>Phone:</strong> ' +
        escAdmin(row.phone) +
        '</p>' +
        '<p><strong>Seminar:</strong> ' +
        escAdmin(row.seminarTitle) +
        '<br><strong>Application:</strong> <code>' +
        escAdmin(row.applicationNo) +
        '</code> · <strong>Status:</strong> ' +
        escAdmin(row.registrationStatus) +
        '</p>' +
        '<p><strong>Payment:</strong> ' +
        escAdmin(pay) +
        (row.orderIdString ? ' · Order <code>' + escAdmin(row.orderIdString) + '</code>' : '') +
        '</p>' +
        '<p><strong>E-ticket ID:</strong> ' +
        (row.ticketIdString ? '<code>' + escAdmin(row.ticketIdString) + '</code>' : '<span style="color:#b45309;">Not generated yet</span>') +
        '<br><strong>Scanned:</strong> ' +
        (row.isScanned ? 'Yes' + (row.scanTime ? ' (' + escAdmin(row.scanTime) + ')' : '') : 'No') +
        (row.scanCount > 0 ? ' · scans: ' + row.scanCount : '') +
        '</p>';
    if (preview) {
        if (row.ticketPreviewUrl) {
            preview.href = row.ticketPreviewUrl;
            preview.classList.remove('hidden');
        } else {
            preview.href = '#';
            preview.classList.add('hidden');
        }
    }
}

async function adminEticketLookup() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const q = String((document.getElementById('eticket-search-q') || {}).value || '').trim();
    const st = document.getElementById('eticket-lookup-status');
    if (!q) return alert('Enter a ticket ID, application ID, email, or phone.');
    if (st) {
        st.style.color = '#64748b';
        st.textContent = 'Searching…';
    }
    try {
        const res = await fetch(
            '/api/admin/e-tickets/lookup?q=' +
                encodeURIComponent(q) +
                '&actingAdminId=' +
                encodeURIComponent(adm.id)
        );
        const data = await res.json();
        if (!res.ok) {
            if (st) {
                st.style.color = '#b91c1c';
                st.textContent = data.error || 'Lookup failed.';
            }
            document.getElementById('eticket-results-wrap')?.classList.add('hidden');
            return;
        }
        const rows = data.results || [];
        if (!rows.length) {
            if (st) {
                st.style.color = '#b45309';
                st.textContent = 'No matching registration or ticket found.';
            }
            document.getElementById('eticket-results-wrap')?.classList.add('hidden');
            return;
        }
        if (st) {
            st.style.color = '#059669';
            st.textContent = rows.length === 1 ? '1 match found.' : rows.length + ' matches — showing the latest.';
        }
        renderAdminEticketDetail(rows[0]);
    } catch (e) {
        console.error(e);
        if (st) {
            st.style.color = '#b91c1c';
            st.textContent = 'Network error.';
        }
    }
}

async function adminEticketGenerate() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const row = __adminEticketSelection;
    if (!row || !row.registrationId) return alert('Look up a ticket first.');
    const actSt = document.getElementById('eticket-action-status');
    if (actSt) {
        actSt.style.color = '#64748b';
        actSt.textContent = 'Generating…';
    }
    try {
        const res = await fetch('/api/admin/e-tickets/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId: row.registrationId, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) {
            if (actSt) {
                actSt.style.color = '#b91c1c';
                actSt.textContent = data.error || 'Could not generate ticket.';
            }
            return;
        }
        if (actSt) {
            actSt.style.color = '#059669';
            actSt.textContent = data.message || 'Ticket ready.';
        }
        const q = row.ticketIdString || row.applicationNo || row.email || '';
        if (q) {
            document.getElementById('eticket-search-q').value = data.ticketId || q;
            await adminEticketLookup();
        }
    } catch (e) {
        console.error(e);
        if (actSt) {
            actSt.style.color = '#b91c1c';
            actSt.textContent = 'Network error.';
        }
    }
}

async function adminEticketSend(sendEmail, sendWhatsapp) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const row = __adminEticketSelection;
    if (!row || !row.registrationId) return alert('Look up a ticket first.');
    if (!row.ticketIdString) {
        return alert('No e-ticket on file. Click Generate / refresh ticket first.');
    }
    const actSt = document.getElementById('eticket-action-status');
    if (actSt) {
        actSt.style.color = '#64748b';
        actSt.textContent = 'Sending…';
    }
    try {
        const res = await fetch('/api/admin/e-tickets/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId: row.registrationId,
                ticketIdString: row.ticketIdString,
                sendEmail: !!sendEmail,
                sendWhatsapp: !!sendWhatsapp,
                actingAdminId: adm.id
            })
        });
        const data = await res.json();
        if (!res.ok) {
            if (actSt) {
                actSt.style.color = '#b91c1c';
                actSt.textContent = data.error || 'Send failed.';
            }
            return;
        }
        if (actSt) {
            actSt.style.color = '#059669';
            actSt.textContent = data.message || 'Sent.';
        }
    } catch (e) {
        console.error(e);
        if (actSt) {
            actSt.style.color = '#b91c1c';
            actSt.textContent = 'Network error.';
        }
    }
}

async function initAdminScannerLogsTab() {
    await fillAdminSeminarSelect('scanner-log-seminar', true);
    await loadAdminScannerLogs();
}

async function toggleDisable(userId, disable) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    if (!confirm(`Are you sure you want to ${disable ? 'disable' : 'enable'} this user?`)) return;
    try {
        const res = await fetch('/api/admin/users/toggle_disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, disable, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        if (__adminUserDetailCache && __adminUserDetailCache.user && Number(__adminUserDetailCache.user.id) === Number(userId)) {
            __adminUserDetailCache.user.is_disabled = disable ? 1 : 0;
            renderAdminUserDetailActions();
            renderAdminUserDetailTab();
        }
        loadUsers();
    } catch (err) {
        console.error(err);
        alert('Network error.');
    }
}

function renderAdminUserCancellationTab(bodyEl, userId) {
    const rows = (__adminUserDetailCache && __adminUserDetailCache.cancellationRequests) || [];
    let html =
        '<p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Cancellation requests submitted by this doctor (IST refund policy applied on approve).</p>';
    html += '<table class="data-table"><thead><tr><th>Requested</th><th>App</th><th>Seminar</th><th>Reason</th><th>Policy refund</th><th>Status</th><th></th></tr></thead><tbody>';
    if (!rows.length) {
        html += '<tr><td colspan="7">No cancellation requests</td></tr>';
    } else {
        rows.forEach((r) => {
            const when = r.requested_at
                ? new Date(r.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                : '—';
            let act = '—';
            if (r.status === 'pending') {
                act =
                    '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;" onclick="closeAdminUserDetailModal();switchTab(\'tab-admin-payments\');switchAdminPaymentsTab(\'cancellations\');loadAdminCancellationRequests();">Review in Payments</button>';
            }
            html +=
                '<tr><td>' +
                escAdmin(when) +
                '</td><td>' +
                escAdmin(r.application_no) +
                '</td><td>' +
                escAdmin(r.seminar_title) +
                '</td><td style="max-width:180px;font-size:0.85rem;">' +
                escAdmin(r.reason) +
                '</td><td>₹' +
                escAdmin(r.refund_amount || 0) +
                ' (' +
                escAdmin(r.refund_percent || 0) +
                '%)</td><td>' +
                escAdmin(r.status) +
                '</td><td>' +
                act +
                '</td></tr>';
        });
    }
    html += '</tbody></table>';
    bodyEl.innerHTML = html;
}

async function loadAdminUserActivityPanel(userId, bodyEl) {
    if (!bodyEl) return;
    try {
        const res = await fetch(
            '/api/admin/activity-logs?userId=' + encodeURIComponent(userId) + '&limit=150'
        );
        const rows = await res.json();
        const list = Array.isArray(rows) ? rows : [];
        let html =
            '<p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Login, applications, payments, and admin actions for this account.</p>';
        html +=
            '<table class="data-table"><thead><tr><th>Time (IST)</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead><tbody>';
        if (!list.length) {
            html += '<tr><td colspan="4">No activity logged yet</td></tr>';
        } else {
            list.forEach((a) => {
                const when = a.created_at
                    ? new Date(a.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                    : '—';
                let meta = '';
                try {
                    const m = a.meta ? JSON.parse(a.meta) : null;
                    if (m && typeof m === 'object') meta = JSON.stringify(m).slice(0, 120);
                } catch (_) {
                    meta = String(a.meta || '').slice(0, 120);
                }
                html +=
                    '<tr><td style="white-space:nowrap;font-size:0.85rem;">' +
                    escAdmin(when) +
                    '</td><td><code>' +
                    escAdmin(a.action) +
                    '</code></td><td>' +
                    escAdmin((a.resource_type || '') + (a.resource_id ? ' #' + a.resource_id : '')) +
                    '</td><td style="font-size:0.82rem;color:#64748b;">' +
                    escAdmin(meta) +
                    '</td></tr>';
            });
        }
        html += '</tbody></table>';
        bodyEl.innerHTML = html;
    } catch (e) {
        console.error(e);
        bodyEl.innerHTML = '<p style="color:#b91c1c;">Failed to load activity</p>';
    }
}

let globalAdminApps = [];

async function loadApplications() {
    try {
        const res = await fetch('/api/admin/applications');
        const apps = await res.json();
        globalAdminApps = Array.isArray(apps) ? apps : [];
        renderApplicationsTable();
    } catch(err) { console.error(err); }
}

function adminApplicationSearchBlob(a) {
    let formData = {};
    try {
        formData = JSON.parse(a.form_data || '{}');
    } catch (_) {}
    const candidateName = formData.fname
        ? `${formData.fname} ${formData.lname || ''}`
        : `${a.first_name || ''} ${a.last_name || ''}`;
    return [
        a.application_no,
        a.user_id_string,
        candidateName,
        a.first_name,
        a.last_name,
        a.status,
        formData.fname,
        formData.lname,
        formData.email,
        formData.phone
    ]
        .join(' ')
        .toLowerCase();
}

function renderApplicationsTable() {
    const tbody = document.getElementById('applications-list');
    if (!tbody) return;
    const q = String((document.getElementById('applications-search') || {}).value || '')
        .trim()
        .toLowerCase();
    const apps = globalAdminApps || [];
    const filtered = q ? apps.filter((a) => adminApplicationSearchBlob(a).includes(q)) : apps;
    const countEl = document.getElementById('applications-search-count');
    if (countEl) {
        countEl.textContent = q
            ? `${filtered.length} of ${apps.length} application${apps.length === 1 ? '' : 's'}`
            : `${apps.length} application${apps.length === 1 ? '' : 's'}`;
    }
    tbody.innerHTML = '';
    if (!apps.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" style="text-align:center;">No applications yet.</td></tr>';
        return;
    }
    if (!filtered.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" style="text-align:center;">No applications match your search.</td></tr>';
        return;
    }
    filtered.forEach((a) => {
        const index = apps.indexOf(a);
        let formData = {};
        try {
            formData = JSON.parse(a.form_data || '{}');
        } catch (_) {}
        const fileLink = formData.certificate_path
            ? `<br><a href="${escAdmin(publicFileHref(formData.certificate_path))}" target="_blank" style="color:blue;font-size:0.8rem;">📄 View Certificate</a>`
            : '';
        const candidateName = formData.fname
            ? `${formData.fname} ${formData.lname || ''}`
            : `${a.first_name || ''} ${a.last_name || ''}`;

        tbody.innerHTML += `
                <tr>
                    <td>
                        <strong>${a.application_no}</strong>
                        <div style="margin-top: 5px;"><img src="/api/qrcode/${a.application_no}" style="width: 40px; height: 40px;"></div>
                    </td>
                    <td>${a.user_id_string}</td>
                    <td>${candidateName}${fileLink}</td>
                    <td>
                        <select onchange="updateAppStatus(${a.id}, this.value)" style="width: auto; min-width: 200px;">
                            ${adminRegistrationStatusOptionsHtml(a.status)}
                        </select>
                    </td>
                    <td>
                        <button class="btn-primary" onclick="viewFullApplication(${index})">View</button>
                        <button type="button" class="btn-primary" style="margin-left:6px;background:#b91c1c;padding:4px 8px;font-size:0.8rem;" onclick="deleteAdminRegistration(${a.id}, '${String(a.application_no || '').replace(/'/g, "\\'")}')">Delete</button>
                    </td>
                </tr>
            `;
    });
}

function adminFilterApplicationsList() {
    renderApplicationsTable();
}

function adminSearchQ(inputId) {
    if (typeof AdminListSearch !== 'undefined') return AdminListSearch.query(inputId);
    return String((document.getElementById(inputId) || {}).value || '')
        .trim()
        .toLowerCase();
}

function adminSearchFilter(items, q, blobFn) {
    if (typeof AdminListSearch !== 'undefined') return AdminListSearch.filter(items, q, blobFn);
    const list = Array.isArray(items) ? items : [];
    if (!q) return list;
    return list.filter((item) => blobFn(item).includes(q));
}

function adminSearchSetCount(countId, q, shown, total, noun) {
    if (typeof AdminListSearch !== 'undefined') {
        AdminListSearch.setCount(countId, q, shown, total, noun);
        return;
    }
    const el = document.getElementById(countId);
    if (!el) return;
    const n = noun || 'items';
    const t = total === 1 ? n.replace(/s$/, '') : n;
    el.textContent = q && total !== shown ? `${shown} of ${total} ${t}` : `${total} ${t}`;
}

function renderDoctorsUsersTable() {
    const doctorsBody = document.getElementById('doctors-list');
    const proxySelect = document.getElementById('proxy-user-select');
    if (!doctorsBody) return;
    const all = window.__adminDoctorUsers || [];
    const q = adminSearchQ('doctors-search');
    const rows = adminSearchFilter(all, q, (u) =>
        [u.user_id_string, u.first_name, u.last_name, u.email, u.phone, u.doctor_category]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('doctors-search-count', q, rows.length, all.length, 'doctors');
    const docCountEl = document.getElementById('doctors-users-count');
    if (docCountEl && !q) {
        docCountEl.textContent = `${all.length} doctor account${all.length === 1 ? '' : 's'}`;
    }
    doctorsBody.innerHTML = '';
    if (!all.length) {
        doctorsBody.innerHTML =
            '<tr><td colspan="8" style="text-align:center;">No doctors registered</td></tr>';
        return;
    }
    if (!rows.length) {
        doctorsBody.innerHTML =
            '<tr><td colspan="8" style="text-align:center;">No doctors match your search.</td></tr>';
        return;
    }
    if (proxySelect) {
        proxySelect.innerHTML = '<option value="">Select a user...</option>';
    }
    rows.forEach((u) => {
        const hi =
            window.__highlightAdminUserId && Number(u.id) === Number(window.__highlightAdminUserId)
                ? ' style="background:#ecfdf5;"'
                : '';
        const cat = String(u.doctor_category || 'regular').toLowerCase() === 'volunteer' ? 'volunteer' : 'regular';
        doctorsBody.innerHTML += `
                <tr${hi}>
                    <td><strong>${u.user_id_string}</strong></td>
                    <td>${escAdmin(u.first_name)} ${escAdmin(u.last_name)}</td>
                    <td>${escAdmin(u.email)}</td>
                    <td>${escAdmin(u.phone || '—')}</td>
                    <td style="white-space:nowrap;font-size:0.82rem;">${formatAdminAccountDateTime(u.created_at)}</td>
                    <td style="white-space:nowrap;font-size:0.82rem;">${adminAccountActivationLabel(u)}</td>
                    <td>${adminUserStatusBadge(u)}</td>
                    <td>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-right:6px;" onclick="openAdminUserDetail(${u.id})">View</button>
                        ${adminUserToggleBtn(u)}
                        <select id="doctor-cat-${u.id}" style="margin-left:6px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;">
                            <option value="regular" ${cat === 'regular' ? 'selected' : ''}>Regular</option>
                            <option value="volunteer" ${cat === 'volunteer' ? 'selected' : ''}>Volunteer</option>
                        </select>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#0f766e;" onclick="saveDoctorAccessFromList(${u.id})">Save access</button>
                        ${
                            adminCanDeleteUsers()
                                ? `<button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#b91c1c;" onclick="adminDeleteUserAccount(${u.id}, '${String((u.first_name || '') + ' ' + (u.last_name || '')).trim().replace(/'/g, "\\'")}', '${String(u.user_id_string || '').replace(/'/g, "\\'")}')">Delete</button>`
                                : ''
                        }
                    </td>
                </tr>`;
        if (proxySelect) {
            proxySelect.innerHTML += `<option value="${u.id}">${u.first_name} ${u.last_name} (${u.user_id_string})</option>`;
        }
    });
}

function renderAdminCertificateCandidatesTable() {
    const tbody = document.getElementById('cert-mgmt-list');
    if (!tbody) return;
    const sid = document.getElementById('cert-mgmt-seminar')?.value;
    if (!sid) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Select a seminar</td></tr>';
        return;
    }
    const certType = document.getElementById('cert-mgmt-type')?.value || 'participant';
    const all = __adminCertCandidatesCache || [];
    const q = adminSearchQ('cert-candidates-search');
    const rows = adminSearchFilter(all, q, (r) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
        const appDisplay =
            certType === 'volunteer' ? r.ticket_id_string || r.application_no : r.application_no;
        return [r.user_id_string, name, appDisplay, r.reg_status, r.order_status, r.ticket_id_string]
            .join(' ')
            .toLowerCase();
    });
    adminSearchSetCount('cert-candidates-search-count', q, rows.length, all.length, 'candidates');
    if (!all.length) {
        const emptyMsg =
            certType === 'volunteer'
                ? 'No approved volunteers for this seminar yet.'
                : 'No registrations for this seminar yet.';
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">${emptyMsg}</td></tr>`;
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="9" style="text-align:center;">No candidates match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((r) => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
        const paid = r.order_status === 'success' ? 'Yes' : 'No';
        const scansReq = Number(r.cert_scans_required) === 2 ? 2 : 1;
        const scanCt = Number(r.scan_count) || 0;
        const checked =
            scanCt >= scansReq
                ? 'Yes (' + scanCt + '/' + scansReq + ')'
                : scanCt > 0
                  ? scanCt + '/' + scansReq
                  : 'No';
        const certLabel = certType === 'volunteer' ? 'Volunteer cert' : 'Participant cert';
        const cert = r.cert_enabled
            ? 'Enabled'
            : certType === 'volunteer'
              ? 'Ready'
              : r.scan_verified
                ? 'Eligible'
                : 'Locked';
        const appDisplay =
            certType === 'volunteer' ? r.ticket_id_string || r.application_no : r.application_no;
        const appCell = appDisplay
            ? escAdmin(appDisplay)
            : '<span style="color:#b91c1c;font-weight:600;">Missing</span>';
        const prnCell = r.user_id_string
            ? escAdmin(r.user_id_string)
            : '<span style="color:#b91c1c;">Missing PRN</span>';
        tbody.innerHTML += `<tr>
                <td><input type="checkbox" class="cert-cand-cb" data-user-id="${r.user_id}" value="${r.user_id}"></td>
                <td>${prnCell}</td>
                <td>${escAdmin(name)}</td>
                <td>${appCell}</td>
                <td>${escAdmin(r.reg_status || '—')}</td>
                <td>${paid}</td>
                <td>${checked}</td>
                <td><code>${escAdmin(r.ticket_id_string || '—')}</code></td>
                <td title="${escAdmin(certLabel)}">${cert}</td>
            </tr>`;
    });
}

function renderAdminVolunteersTable() {
    const tbody = document.getElementById('vol-mgmt-list');
    if (!tbody) return;
    const sid = document.getElementById('vol-mgmt-seminar')?.value;
    if (!sid) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Select a seminar</td></tr>';
        return;
    }
    const all = __adminVolunteersCache || [];
    const q = adminSearchQ('volunteers-search');
    const rows = adminSearchFilter(all, q, (v) => {
        const name = [v.first_name, v.last_name].filter(Boolean).join(' ');
        return [name, v.user_id_string, v.email, v.status, v.volunteer_ticket_id_string, v.notes]
            .join(' ')
            .toLowerCase();
    });
    adminSearchSetCount('volunteers-search-count', q, rows.length, all.length, 'volunteers');
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No volunteers assigned</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="5" style="text-align:center;">No volunteers match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((v) => {
        const name = [v.first_name, v.last_name].filter(Boolean).join(' ');
        let actions = '';
        const regSt = String(v.registration_status || '').toLowerCase();
        const hasTicket = !!(v.volunteer_ticket_id_string && String(v.volunteer_ticket_id_string).trim());
        if (!hasTicket && regSt === 'submitted') {
            actions =
                '<span style="font-size:0.8rem;color:#059669;">Registration done — ticket auto-issues</span>';
        } else if (!hasTicket && v.status === 'pending') {
            actions =
                '<span style="font-size:0.8rem;color:#b45309;">Awaiting registration</span> ' +
                `<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;margin-left:6px;" onclick="approveAdminVolunteer(${v.id})">Issue ticket (₹0)</button>`;
        } else if (!hasTicket) {
            actions = '<span style="font-size:0.8rem;color:#64748b;">Waiting for doctor to register</span>';
        }
        tbody.innerHTML += `<tr>
                <td>${escAdmin(name)}<div class="muted">${escAdmin(v.user_id_string)} · ${escAdmin(v.email)}</div></td>
                <td>${escAdmin(v.status)}${regSt ? ' · reg: ' + escAdmin(regSt) : ''}</td>
                <td><code>${escAdmin(v.volunteer_ticket_id_string || '—')}</code></td>
                <td>${escAdmin(v.notes || '—')}</td>
                <td>${actions || '—'}</td>
            </tr>`;
    });
}

function renderSupportTicketsTable() {
    const tbody = document.getElementById('support-tickets-list');
    if (!tbody) return;
    const all = __supportTicketsCache || [];
    const q = adminSearchQ('support-tickets-search');
    const rows = adminSearchFilter(all, q, (t) =>
        [
            t.ticket_id,
            t.tracking_id,
            t.first_name,
            t.last_name,
            t.email,
            t.subject,
            t.category,
            t.priority,
            t.status
        ]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('support-tickets-search-count', q, rows.length, all.length, 'tickets');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No support tickets.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="8" style="text-align: center;">No tickets match your search.</td></tr>';
        return;
    }
    rows.forEach((t) => {
        const created = new Date(t.created_at).toLocaleDateString();
        const tid = t.ticket_id || t.tracking_id || '—';
        const pri = (t.priority || 'medium').toUpperCase();
        const priorityColor = t.priority === 'urgent' ? '#ef4444' : t.priority === 'high' ? '#f59e0b' : '#3b82f6';
        const statusBg = t.status === 'closed' ? '#cbd5e1' : t.status === 'resolved' ? '#10b981' : '#fbbf24';
        tbody.innerHTML += `
                <tr>
                    <td><strong>${escAdmin(tid)}</strong></td>
                    <td>${t.first_name} ${t.last_name}</td>
                    <td>${t.subject}</td>
                    <td>${t.category}</td>
                    <td style="color: ${priorityColor}; font-weight: 600;">${pri}</td>
                    <td style="background: ${statusBg}; padding: 5px; border-radius: 4px;">${escAdmin(t.status || '')}</td>
                    <td>${created}</td>
                    <td><button class="btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="viewSupportTicket('${escAdmin(tid).replace(/'/g, "\\'")}')">View</button></td>
                </tr>
            `;
    });
}

function renderAdminCaseSubmissionsTable() {
    const tbody = document.getElementById('case-mgmt-list');
    if (!tbody) return;
    const all = __adminCaseSubmissionsCache || [];
    const q = adminSearchQ('case-submissions-search');
    const rows = adminSearchFilter(all, q, (s) => {
        const name = [s.first_name, s.last_name].filter(Boolean).join(' ');
        return [s.application_no, s.id, name, s.user_id_string, s.category, s.title, s.status]
            .join(' ')
            .toLowerCase();
    });
    adminSearchSetCount('case-submissions-search-count', q, rows.length, all.length, 'submissions');
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No submissions</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;">No submissions match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((s) => {
        const name = [s.first_name, s.last_name].filter(Boolean).join(' ');
        tbody.innerHTML += `<tr>
                <td><code>${escAdmin(s.application_no || s.id)}</code></td>
                <td>${escAdmin(name)}<div class="muted">${escAdmin(s.user_id_string)}</div></td>
                <td>${escAdmin(s.category || '—')}</td>
                <td>${escAdmin(s.title)}</td>
                <td>${escAdmin(s.status)}</td>
                <td>${s.file_count || 0}</td>
                <td>
                    <button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;" onclick="openAdminCaseDetail(${s.id})">Review</button>
                    <button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;background:#b91c1c;margin-left:4px;" onclick="deleteAdminCaseSubmission(${s.id})">Delete</button>
                </td>
            </tr>`;
    });
}

function renderAdminCaseProgramsList() {
    const box = document.getElementById('case-prog-list');
    if (!box) return;
    const all = __adminCaseProgramsCache || [];
    const q = adminSearchQ('case-prog-search');
    const rows = adminSearchFilter(all, q, (p) =>
        [p.title, p.description, p.registration_start, p.registration_end].join(' ').toLowerCase()
    );
    adminSearchSetCount('case-prog-search-count', q, rows.length, all.length, 'programs');
    if (!all.length) {
        box.innerHTML = '<p style="color:#64748b;">No programs yet. Fill the form above and click Save program.</p>';
        return;
    }
    box.innerHTML = '<h4 style="margin:0 0 10px;">Saved programs</h4>';
    const priSel = document.getElementById('case-priority-program');
    if (priSel) {
        priSel.innerHTML = '<option value="">— Select program —</option>';
        all.forEach(function (p) {
            priSel.innerHTML +=
                '<option value="' + p.id + '">' + String(p.title || '').replace(/</g, '&lt;') + '</option>';
        });
    }
    if (!rows.length) {
        box.innerHTML += '<p style="color:#64748b;">No programs match your search.</p>';
        return;
    }
    rows.forEach(function (p) {
        const used = p.submissionCount != null ? p.submissionCount : p.submission_count || 0;
        const capMax = p.maxTotalSubmissions != null ? p.maxTotalSubmissions : p.max_total_submissions;
        const cap = capMax != null ? ' · ' + used + '/' + capMax + ' slots' : ' · ' + used + ' submission(s)';
        box.innerHTML +=
            '<div style="padding:10px 0;border-bottom:1px solid #e2e8f0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;"><div><strong>' +
            String(p.title || '').replace(/</g, '&lt;') +
            '</strong><span style="color:#64748b;font-size:0.85rem;"> · ' +
            String(p.registration_start || '—').replace(/</g, '&lt;') +
            ' → ' +
            String(p.registration_end || '—').replace(/</g, '&lt;') +
            cap +
            '</span></div><span><button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#64748b;" onclick="editAdminCaseProgram(' +
            p.id +
            ')">Edit</button> <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#b91c1c;" onclick="deleteAdminCaseProgram(' +
            p.id +
            ', \'' +
            String(p.title || '').replace(/'/g, "\\'") +
            '\')">Delete</button></span></div>';
    });
}

function renderAdminEnrichedOrdersTable() {
    const tbody = document.getElementById('admin-orders-tbody');
    if (!tbody) return;
    const all = __adminEnrichedOrdersCache || [];
    const q = adminSearchQ('payments-orders-search');
    const rows = adminSearchFilter(all, q, (o) =>
        [
            o.order_id_string,
            o.id,
            o.first_name,
            o.last_name,
            o.user_id_string,
            o.user_id,
            o.seminar_title,
            o.application_no,
            o.payment_gateway,
            o.status,
            o.e_ticket_id
        ]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('payments-orders-search-count', q, rows.length, all.length, 'orders');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No orders.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No orders match your search.</td></tr>';
        return;
    }
    rows.forEach((o) => {
        const doc = escAdmin((o.first_name || '') + ' ' + (o.last_name || '') + ' (' + (o.user_id_string || o.user_id || '') + ')');
        const refunded = Number(o.refunded_amount) || 0;
        const amt = Number(o.amount) || 0;
        const canRefund = o.status === 'success' && refunded < amt - 0.01;
        const actions = [];
        if (o.status === 'success') {
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;margin-right:4px;" onclick="openAdminOrderReceipt(' +
                    o.id +
                    ')">Receipt</button>'
            );
        }
        if (canRefund) {
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b45309;border:none;" onclick="adminRefundOrderPrompt(' +
                    o.id +
                    ')">Refund</button>'
            );
        }
        const st = String(o.status || '').toLowerCase();
        if (st === 'pending' && o.registration_id) {
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;margin-right:4px;" onclick="adminRetryOrderPayment(' +
                    o.registration_id +
                    ',' +
                    o.id +
                    ')">Retry</button>'
            );
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b91c1c;border:none;margin-right:4px;" onclick="adminCancelPendingOrder(' +
                    o.id +
                    ')">Cancel</button>'
            );
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#64748b;border:none;margin-right:4px;" onclick="adminPollOrderPayment(' +
                    o.id +
                    ')">Check</button>'
            );
        }
        if (o.registration_id && o.registration_status !== 'cancelled' && st !== 'success') {
            actions.push(
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#7c3aed;border:none;" onclick="adminWaiveAndTicket(' +
                    o.registration_id +
                    ')">Waive &amp; ticket</button>'
            );
        }
        if (o.e_ticket_id) {
            actions.push(
                '<span style="font-size:0.78rem;color:#0f766e;margin-left:4px;">Ticket <code>' +
                    escAdmin(o.e_ticket_id) +
                    '</code></span>'
            );
        }
        tbody.innerHTML +=
            '<tr><td><strong>' +
            escAdmin(o.order_id_string || o.id) +
            '</strong></td><td>' +
            doc +
            '</td><td>' +
            escAdmin(o.seminar_title || '—') +
            '</td><td>' +
            escAdmin(o.application_no || '—') +
            '</td><td>' +
            escAdmin(o.payment_gateway || '—') +
            '</td><td>₹' +
            escAdmin(amt) +
            '</td><td>₹' +
            escAdmin(refunded) +
            (o.refund_status ? ' (' + escAdmin(o.refund_status) + ')' : '') +
            '</td><td>' +
            escAdmin(o.status) +
            '</td><td>' +
            (actions.join('') || '—') +
            '</td></tr>';
    });
}

function renderAdminSupplementalPaymentsTable() {
    const tbody = document.getElementById('admin-supplemental-tbody');
    if (!tbody) return;
    const all = __adminSupplementalCache || [];
    const q = adminSearchQ('supplemental-payments-search');
    const rows = adminSearchFilter(all, q, (r) =>
        [r.first_name, r.last_name, r.email, r.user_id_string, r.title, r.description, r.status, r.order_id_string]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('supplemental-payments-search-count', q, rows.length, all.length, 'charges');
    if (!all.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align:center;color:#64748b;">No additional charges yet</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align:center;color:#64748b;">No charges match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = rows
        .map((r) => {
            const paid = String(r.status || '').toLowerCase() === 'paid';
            const name =
                escAdmin((r.first_name || '') + ' ' + (r.last_name || '')).trim() || escAdmin(r.email || '');
            return (
                '<tr><td>' +
                r.id +
                '</td><td>' +
                name +
                '<br><span style="font-size:0.78rem;color:#64748b;">' +
                escAdmin(r.user_id_string || '') +
                '</span></td><td>' +
                escAdmin(r.title || '') +
                (r.description
                    ? '<br><span style="font-size:0.78rem;color:#64748b;">' + escAdmin(r.description) + '</span>'
                    : '') +
                '</td><td>₹' +
                escAdmin(String(r.amount != null ? r.amount : '—')) +
                '</td><td>' +
                escAdmin(paid ? 'Paid' : 'Pending') +
                '</td><td>' +
                (paid
                    ? escAdmin(r.order_id_string || '—')
                    : '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.78rem;background:#15803d;" onclick="markAdminSupplementalPaid(' +
                      r.id +
                      ')">Mark paid (cash)</button> <button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.78rem;background:#b91c1c;" onclick="deleteAdminSupplemental(' +
                      r.id +
                      ')">Remove</button>') +
                '</td></tr>'
            );
        })
        .join('');
}

function renderAdminCancellationRequestsTable() {
    const tbody = document.getElementById('admin-cancel-req-tbody');
    if (!tbody) return;
    const all = __adminCancelRequestsCache || [];
    const q = adminSearchQ('cancellation-requests-search');
    const rows = adminSearchFilter(all, q, (r) =>
        [
            r.first_name,
            r.last_name,
            r.user_id_string,
            r.seminar_title,
            r.application_no,
            r.reason,
            r.status,
            r.refund_amount,
            r.refund_percent
        ]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('cancellation-requests-search-count', q, rows.length, all.length, 'requests');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">No requests.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">No requests match your search.</td></tr>';
        return;
    }
    rows.forEach((r) => {
        const doc = escAdmin((r.first_name || '') + ' ' + (r.last_name || '') + ' (' + (r.user_id_string || '') + ')');
        const when = r.requested_at
            ? new Date(r.requested_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            : '—';
        const pol = '₹' + (r.refund_amount || 0) + ' (' + (r.refund_percent || 0) + '%)';
        let actions = '—';
        if (r.status === 'pending') {
            actions =
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;margin-right:4px;" onclick="adminResolveCancelRequest(' +
                r.id +
                ',\'approve\')">Approve</button>' +
                '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#64748b;border:none;" onclick="adminResolveCancelRequest(' +
                r.id +
                ',\'reject\')">Reject</button>';
        }
        tbody.innerHTML +=
            '<tr><td>' +
            escAdmin(when) +
            '</td><td>' +
            doc +
            '</td><td>' +
            escAdmin(r.seminar_title) +
            '</td><td>' +
            escAdmin(r.application_no) +
            '</td><td style="max-width:200px;font-size:0.85rem;">' +
            escAdmin(r.reason) +
            '</td><td>' +
            escAdmin(pol) +
            '</td><td>' +
            escAdmin(r.status) +
            '</td><td>' +
            actions +
            '</td></tr>';
    });
}

function renderSeminarsTable() {
    const tbody = document.getElementById('seminars-list');
    if (!tbody) return;
    const all = globalSeminars || [];
    const q = adminSearchQ('seminars-search');
    const year = typeof adminPortalYear !== 'undefined' ? adminPortalYear : new Date().getFullYear();
    const filteredAll = all.filter(
        (s) =>
            Number(s.portal_year) === year ||
            (!s.portal_year && s.event_date && new Date(s.event_date).getFullYear() === year)
    );
    const pastAll = all.filter((s) => Number(s.portal_year) < year);
    const blobFn = (s) =>
        [s.id, s.title, s.description, s.portal_year, s.price, s.is_active, s.checkin_enabled]
            .join(' ')
            .toLowerCase();
    const filtered = adminSearchFilter(filteredAll, q, blobFn);
    const past = adminSearchFilter(pastAll, q, blobFn);
    const shown = filtered.length + past.length;
    const total = filteredAll.length + pastAll.length;
    adminSearchSetCount('seminars-search-count', q, shown, total, 'seminars');
    tbody.innerHTML = '';
    if (!filtered.length && !past.length) {
        if (!total) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No seminars found.</td></tr>';
        } else {
            tbody.innerHTML =
                '<tr><td colspan="7" style="text-align: center;">No seminars match your search.</td></tr>';
        }
        return;
    }
    const renderRow = (s, pastRow) => {
        const idx = globalSeminars.indexOf(s);
        const checkinStatus = s.checkin_enabled
            ? `<span style="color:green;font-weight:bold;">Yes (${s.checkin_date || 'Any'})</span>`
            : `<span style="color:red;">No</span>`;
        const activeStatus = s.is_active ? '' : '<span style="color:red; font-size: 0.8rem;">(Inactive)</span>';
        const yearTag = s.portal_year
            ? `<span style="font-size:0.75rem;color:#64748b;">${s.portal_year}</span>`
            : '';
        return `
                <tr style="${pastRow ? 'opacity:0.85;background:#f8fafc;' : ''}">
                    <td>${s.id}</td>
                    <td><strong>${s.title}</strong> ${activeStatus} ${yearTag}</td>
                    <td>${s.event_date ? (window.PortalDateTime && window.PortalDateTime.formatEvent ? window.PortalDateTime.formatEvent(s.event_date) : window.PortalDateTime ? window.PortalDateTime.format(s.event_date) : new Date(s.event_date).toLocaleString()) : '—'}</td>
                    <td>₹${s.price || 0}</td>
                    <td>${checkinStatus}</td>
                    <td>${pastRow ? '<em>Past year</em>' : 'Current'}</td>
                    <td>
                        <button class="btn-success" style="padding: 5px 10px; font-size: 0.85rem;" onclick="manageSeminar(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Manage</button>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.85rem;background:#0d9488;margin-left:4px;" onclick="openEventScheduleModalForSeminar(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Schedule</button>
                        <button class="btn-primary" style="padding: 5px 10px; font-size: 0.85rem;" onclick="editSeminar(${idx})">Edit</button>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.85rem;background:#7c3aed;margin-left:4px;" onclick="purgeAdminSeminarTestData(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Purge test data</button>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.85rem;background:#b91c1c;margin-left:4px;" onclick="deleteAdminSeminar(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Delete</button>
                    </td>
                </tr>`;
    };
    if (filtered.length) {
        tbody.innerHTML +=
            '<tr><td colspan="7" style="background:#ecfdf5;font-weight:700;color:#047857;">Current portal year (' +
            year +
            ')</td></tr>';
        filtered.forEach((s) => {
            tbody.innerHTML += renderRow(s, false);
        });
    }
    if (past.length) {
        tbody.innerHTML +=
            '<tr><td colspan="7" style="background:#f1f5f9;font-weight:700;color:#475569;">Past seminars (archive)</td></tr>';
        past.forEach((s) => {
            tbody.innerHTML += renderRow(s, true);
        });
    }
}

function renderContactInquiriesTable() {
    const tbody = document.getElementById('contact-inquiries-list');
    if (!tbody) return;
    const all = __adminContactInquiriesCache || [];
    const q = adminSearchQ('contact-inquiries-search');
    const rows = adminSearchFilter(all, q, (r) =>
        [r.name, r.email, r.phone, r.subject, r.status, r.message].join(' ').toLowerCase()
    );
    adminSearchSetCount('contact-inquiries-search-count', q, rows.length, all.length, 'inquiries');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No contact requests yet.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;">No inquiries match your search.</td></tr>';
        return;
    }
    rows.forEach((r) => {
        const created = r.created_at ? new Date(r.created_at).toLocaleString() : '—';
        const subj = (r.subject || '').length > 40 ? r.subject.slice(0, 40) + '…' : r.subject || '—';
        tbody.innerHTML += `
                <tr>
                    <td>${created}</td>
                    <td>${escapeHtml(r.name || '')}</td>
                    <td><a href="mailto:${escapeHtml(r.email || '')}">${escapeHtml(r.email || '')}</a></td>
                    <td>${escapeHtml(r.phone || '—')}</td>
                    <td>${escapeHtml(subj)}</td>
                    <td>${escapeHtml(r.status || 'new')}</td>
                    <td><button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;" onclick="openContactInquiry(${r.id})">View</button></td>
                </tr>`;
    });
}

function renderFeedbackTable() {
    const tbody = document.getElementById('feedback-list');
    if (!tbody) return;
    const seminarId = document.getElementById('feedback-seminar-filter')?.value;
    if (!seminarId) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align: center;">Select a seminar to view feedback</td></tr>';
        return;
    }
    const all = __adminFeedbackCache || [];
    const q = adminSearchQ('feedback-search');
    const rows = adminSearchFilter(all, q, (f) =>
        [f.first_name, f.last_name, f.overall_experience, f.rating].join(' ').toLowerCase()
    );
    adminSearchSetCount('feedback-search-count', q, rows.length, all.length, 'responses');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align: center;">No feedback for this seminar yet.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align: center;">No feedback matches your search.</td></tr>';
        return;
    }
    rows.forEach((f) => {
        tbody.innerHTML += `
                <tr>
                    <td>${f.first_name} ${f.last_name}</td>
                    <td>${f.rating}/5</td>
                    <td>${f.content_quality}/5</td>
                    <td>${f.speaker_quality}/5</td>
                    <td>${f.organization_quality}/5</td>
                    <td><small>${f.overall_experience || '-'}</small></td>
                </tr>
            `;
    });
}

function renderEventSchedulesTable() {
    const tbody = document.getElementById('event-schedules-list');
    if (!tbody) return;
    const all = __eventSchedulesCache || [];
    const seminarFilter = (document.getElementById('event-schedules-seminar-filter') || {}).value || '';
    const seminarScoped = seminarFilter
        ? all.filter((s) => String(s.seminar_id) === String(seminarFilter))
        : all;
    const q = adminSearchQ('event-schedules-search');
    const rows = adminSearchFilter(seminarScoped, q, (s) =>
        [s.title, s.seminar_title, s.seminar_id, s.speaker_name, s.location, s.description]
            .join(' ')
            .toLowerCase()
    );
    adminSearchSetCount('event-schedules-search-count', q, rows.length, seminarScoped.length, 'schedules');
    tbody.innerHTML = '';
    if (!all.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align:center;">No event schedules yet. Click <strong>+ Create New Schedule</strong>.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" style="text-align:center;">No schedules match your search.</td></tr>';
        return;
    }
    rows.forEach((s) => {
        const tr = document.createElement('tr');
        const startTime = formatScheduleDisplay(s.start_time);
        const endTime = formatScheduleDisplay(s.end_time);
        tr.innerHTML = `
                <td><strong></strong></td>
                <td></td>
                    <td>${startTime}</td>
                    <td>${endTime}</td>
                <td></td>
                <td></td>`;
        tr.cells[0].querySelector('strong').textContent = s.title || '';
        tr.cells[1].textContent = s.seminar_title || (s.seminar_id ? `Seminar #${s.seminar_id}` : '—');
        tr.cells[4].textContent = s.speaker_name || '—';
        const actions = document.createElement('td');
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-primary';
        editBtn.style.cssText = 'padding:5px 10px;font-size:0.8rem;margin-right:6px;';
        editBtn.textContent = 'Edit';
        editBtn.type = 'button';
        editBtn.onclick = () => editEventScheduleById(s.id);
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-danger';
        delBtn.style.cssText = 'padding:5px 10px;font-size:0.8rem;';
        delBtn.textContent = 'Delete';
        delBtn.type = 'button';
        delBtn.onclick = () => deleteEventSchedule(s.id);
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        tr.replaceChild(actions, tr.cells[5]);
        tbody.appendChild(tr);
    });
}

function renderAdminScannerLogsTable() {
    const tbody = document.getElementById('scanner-logs-list');
    if (!tbody) return;
    const all = __adminScannerLogsCache || [];
    const q = adminSearchQ('scanner-logs-search');
    const rows = adminSearchFilter(all, q, (s) => {
        const doc = `${s.doctor_first_name || ''} ${s.doctor_last_name || ''}`.trim();
        const staff = s.scanner_first_name
            ? `${s.scanner_first_name} ${s.scanner_last_name || ''} (${s.scanner_user_id_string || ''})`
            : '';
        return [
            s.doctor_user_id_string,
            doc,
            s.application_no,
            s.ticket_id_string,
            staff,
            s.seminar_title
        ]
            .join(' ')
            .toLowerCase();
    });
    adminSearchSetCount('scanner-logs-search-count', q, rows.length, all.length, 'scans');
    if (!all.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No scans yet</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;">No scans match your search.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((s) => {
        const t = s.scan_time ? new Date(s.scan_time).toLocaleString() : '—';
        const doc = `${s.doctor_first_name || ''} ${s.doctor_last_name || ''}`.trim();
        const staff = s.scanner_first_name
            ? `${s.scanner_first_name} ${s.scanner_last_name || ''} (${s.scanner_user_id_string || ''})`
            : '—';
        tbody.innerHTML += `<tr>
                <td>${escAdmin(t)}</td>
                <td><strong>${escAdmin(s.doctor_user_id_string)}</strong></td>
                <td>${escAdmin(doc)}</td>
                <td>${escAdmin(s.application_no)}</td>
                <td>${escAdmin(s.ticket_id_string)}</td>
                <td>${escAdmin(staff)}</td>
                <td>${escAdmin(s.seminar_title)}</td>
            </tr>`;
    });
}

function seminarNeedsDocReview(qual) {
    const q = String(qual || '').trim();
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

async function adminLiveEditOtpPayload(targetUserId) {
    await refreshAdminSensitiveOtpRequirement();
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) {
        alert('Not logged in.');
        return null;
    }
    const targetUser =
        targetUserId != null && window.__adminUsersById
            ? window.__adminUsersById[targetUserId]
            : null;
    if (isStaffUserRecord(targetUser)) {
        return { adminUserId: adm.id };
    }
    if (__requireAdminSensitiveOtp && (!__adminSensitivePhoneOtpToken || !__adminSensitiveEmailOtpToken)) {
        alert(
            'Admin OTP is required. Open Doctor applications (admin) or Global Settings, verify your email and WhatsApp codes, then save again.'
        );
        return null;
    }
    return {
        adminUserId: adm.id,
        adminPhoneOtpToken: __adminSensitivePhoneOtpToken,
        adminEmailOtpToken: __adminSensitiveEmailOtpToken
    };
}

let __adminEditFormFields = [];
let __adminEditFormPrefix = 'appedit-f-';

async function adminPincodeAutofill(prefix, pinKey) {
    const pinEl = document.getElementById(prefix + pinKey);
    if (!pinEl) return;
    const pin = String(pinEl.value || '').replace(/\D/g, '');
    if (pin.length !== 6) return;
    try {
        const r = await fetch('/api/public/pincode-lookup?pin=' + encodeURIComponent(pin));
        const data = await r.json();
        if (!data || !data.ok) return;
        const cityKey = pinKey === 'cpin' ? 'ccity' : 'city';
        const stateKey = pinKey === 'cpin' ? 'cstate' : 'state';
        const cityEl = document.getElementById(prefix + cityKey);
        const stateEl = document.getElementById(prefix + stateKey);
        if (cityEl && (data.cities || []).length) cityEl.value = data.cities[0];
        if (stateEl && (data.states || []).length) stateEl.value = data.states[0];
        if (pinKey === 'pin') {
            const countryEl = document.getElementById(prefix + 'country');
            if (countryEl && data.country) countryEl.value = data.country;
        }
    } catch (_) {}
}

function formatAdminApplicationDetailsHtml(formData, certLink) {
    const fd = formData || {};
    const rows = [
        ['Name', [fd.fname, fd.mname, fd.lname].filter(Boolean).join(' ')],
        ['Email', fd.email],
        ['Phone', fd.phone],
        ['Date of birth', fd.dob],
        ['Address', fd.address],
        ['PIN / City / State', [fd.pin, fd.city, fd.state].filter(Boolean).join(', ')],
        ['Country', fd.country],
        ['Qualification', fd.qual]
    ];
    if (seminarNeedsDocReview(fd.qual)) {
        rows.push(['NCISM / Reg. no.', fd.ncism || '—']);
    }
    if (adminQualIsPg(fd.qual)) {
        rows.push(['College PIN', fd.cpin || '—']);
        rows.push(['College', [fd.college, fd.ccity, fd.cstate].filter(Boolean).join(', ')]);
    }
    let html = '';
    rows.forEach(([k, v]) => {
        if (v == null || String(v).trim() === '') return;
        html += '<p><strong>' + escAdmin(k) + ':</strong> ' + escAdmin(String(v)) + '</p>';
    });
    if (certLink) html += certLink;
    if (fd.additional_documents && Array.isArray(fd.additional_documents) && fd.additional_documents.length) {
        html += '<p><strong>Additional documents:</strong></p><ul>';
        fd.additional_documents.forEach((d) => {
            const href = d.path ? publicFileHref(d.path) : '';
            html +=
                '<li>' +
                escAdmin(d.label || 'Document') +
                (href ? ' — <a href="' + escAdmin(href) + '" target="_blank" rel="noopener">View</a>' : '') +
                '</li>';
        });
        html += '</ul>';
    }
    return html;
}

function renderAdminDynamicFormFields(hostId, fields, prefix, existingData) {
    const host = document.getElementById(hostId);
    if (!host) return;
    __adminEditFormPrefix = prefix;
    __adminEditFormFields = fields || [];
    const qual = String((existingData && existingData.qual) || '').trim();
    const adv = seminarNeedsDocReview(qual);
    const isPg = adminQualIsPg(qual);
    const list = (__adminEditFormFields || []).filter((f) => f.enabled !== false);
    if (!list.length) {
        host.innerHTML = '<p class="muted">No form fields configured for this seminar.</p>';
        return;
    }
    let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';
    list.forEach((f) => {
        if (f.key === 'certificate') return;
        if (f.onlyWhenAdvancedQual && !adv) return;
        if (f.onlyWhenPgCollege && !isPg) return;
        const id = prefix + f.key;
        const req = f.required ? ' *' : '';
        const span = f.type === 'textarea' ? 'grid-column:1/-1;' : '';
        html += '<div class="form-group" style="' + span + '"><label for="' + id + '">' + escAdmin(f.label || f.key) + req + '</label>';
        if (f.type === 'textarea') {
            html += '<textarea id="' + id + '" rows="2" style="width:100%;padding:8px;"></textarea>';
        } else if (f.type === 'select' && Array.isArray(f.options)) {
            html += '<select id="' + id + '" style="width:100%;padding:8px;"><option value="">Select</option>';
            f.options.forEach((o) => {
                const v = o.value != null ? o.value : o.label;
                html += '<option value="' + escAdmin(String(v)) + '">' + escAdmin(o.label || v) + '</option>';
            });
            html += '</select>';
        } else if (f.type === 'date') {
            html += '<input type="date" id="' + id + '" style="width:100%;padding:8px;">';
        } else if (f.type === 'checkbox' || f.type === 'boolean') {
            html +=
                '<label style="display:flex;align-items:center;gap:8px;margin-top:6px;"><input type="checkbox" id="' +
                id +
                '"> ' +
                escAdmin(f.label || f.key) +
                '</label>';
        } else {
            const ty = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
            const pinAttr = f.key === 'pin' || f.key === 'cpin' ? ' maxlength="6" inputmode="numeric"' : '';
            html += '<input type="' + ty + '" id="' + id + '" style="width:100%;padding:8px;"' + pinAttr + '>';
        }
        html += '</div>';
    });
    html += '</div>';
    host.innerHTML = html;
    list.forEach((f) => {
        const el = document.getElementById(prefix + f.key);
        if (!el || !existingData) return;
        if (el.type === 'checkbox') el.checked = !!existingData[f.key] && existingData[f.key] !== '0';
        else if (existingData[f.key] != null) el.value = existingData[f.key];
    });
    const qualEl = document.getElementById(prefix + 'qual');
    if (qualEl) {
        qualEl.addEventListener('change', () =>
            renderAdminDynamicFormFields(hostId, __adminEditFormFields, prefix, collectAdminDynamicFormData(prefix))
        );
    }
    ['pin', 'cpin'].forEach((pk) => {
        const pel = document.getElementById(prefix + pk);
        if (pel) pel.addEventListener('blur', () => adminPincodeAutofill(prefix, pk));
    });
}

function collectAdminDynamicFormData(prefix) {
    const o = { country: 'India' };
    const qualEl = document.getElementById(prefix + 'qual');
    const qual = qualEl ? qualEl.value : '';
    (__adminEditFormFields || ADMIN_BEHALF_FIELD_DEFAULTS).forEach((f) => {
        if (f.key === 'certificate' || f.enabled === false) return;
        if (f.onlyWhenAdvancedQual && !seminarNeedsDocReview(qual)) return;
        if (f.onlyWhenPgCollege && !adminQualIsPg(qual)) return;
        const el = document.getElementById(prefix + f.key);
        if (!el) return;
        if (el.type === 'checkbox') o[f.key] = el.checked ? '1' : '';
        else o[f.key] = el.value;
    });
    return o;
}

async function loadAdminSeminarFormFieldsForEdit(seminarId, hostId, prefix, existingData) {
    try {
        const res = await fetch('/api/registration-form-config?seminarId=' + encodeURIComponent(seminarId));
        const cfg = await res.json();
        const fields = (cfg && cfg.fields) || ADMIN_BEHALF_FIELD_DEFAULTS;
        renderAdminDynamicFormFields(hostId, fields, prefix, existingData || {});
    } catch (e) {
        console.error(e);
        renderAdminDynamicFormFields(hostId, ADMIN_BEHALF_FIELD_DEFAULTS, prefix, existingData || {});
    }
}

async function adminSaveApplicationFormEdit(applicationId) {
    const otp = await adminLiveEditOtpPayload();
    if (!otp) return;
    const st = document.getElementById('admin-app-edit-status');
    if (st) st.textContent = 'Saving…';
    let formData = collectAdminDynamicFormData(__adminEditFormPrefix);
    try {
        const res = await fetch('/api/admin/applications/' + applicationId + '/form-data', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ formData, ...otp })
        });
        const data = await res.json();
        if (!res.ok) {
            if (st) st.textContent = data.error || 'Save failed';
            return alert(data.error || 'Save failed');
        }
        if (st) st.textContent = 'Saved at ' + new Date().toLocaleTimeString();
        alert('Application form updated.');
        document.getElementById('admin-view-modal').classList.add('hidden');
        loadApplications();
    } catch (e) {
        console.error(e);
        if (st) st.textContent = 'Network error';
        alert('Network error');
    }
}

async function adminSaveUserAccountEdit(userId) {
    const otp = await adminLiveEditOtpPayload(userId);
    if (!otp) return;
    const body = {
        firstName: document.getElementById('admin-edit-first')?.value,
        middleName: document.getElementById('admin-edit-middle')?.value,
        lastName: document.getElementById('admin-edit-last')?.value,
        email: document.getElementById('admin-edit-email')?.value,
        phone: document.getElementById('admin-edit-phone')?.value,
        whatsapp: document.getElementById('admin-edit-whatsapp')?.value,
        qualification: document.getElementById('admin-edit-qual')?.value,
        ...otp
    };
    try {
        const res = await fetch('/api/admin/users/' + userId + '/account', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        alert('Account updated.');
        openAdminUserDetail(userId);
        loadUsers();
    } catch (e) {
        alert('Network error');
    }
}

async function adminSaveDoctorProfileEdit(userId) {
    const otp = await adminLiveEditOtpPayload();
    if (!otp) return;
    const body = {
        specialization: document.getElementById('admin-edit-spec')?.value,
        registration_no: document.getElementById('admin-edit-regno')?.value,
        qualifications: document.getElementById('admin-edit-quals')?.value,
        experience_years: document.getElementById('admin-edit-exp')?.value,
        hospital_name: document.getElementById('admin-edit-hospital')?.value,
        contact_number: document.getElementById('admin-edit-contact')?.value,
        bio: document.getElementById('admin-edit-bio')?.value,
        ...otp
    };
    try {
        const res = await fetch('/api/admin/users/' + userId + '/doctor-profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        alert('Doctor profile updated.');
        openAdminUserDetail(userId);
    } catch (e) {
        alert('Network error');
    }
}

async function adminSaveCaseSubmissionEdit(subId) {
    const otp = await adminLiveEditOtpPayload();
    if (!otp) return;
    let formData = {};
    const ta = document.getElementById('admin-case-form-json');
    if (ta) {
        try {
            formData = JSON.parse(ta.value || '{}');
        } catch (e) {
            return alert('Invalid JSON in case form data.');
        }
    }
    const body = {
        title: document.getElementById('admin-case-edit-title')?.value,
        category: document.getElementById('admin-case-edit-category')?.value,
        formData,
        ...otp
    };
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        alert('Case submission updated.');
        openAdminCaseDetail(subId);
    } catch (e) {
        alert('Network error');
    }
}

function formatNcismCertificateCheckHtml(check) {
    if (!check || check.status === 'skipped') return '';
    const st = String(check.status || '').toLowerCase();
    let color = '#64748b';
    let label = 'Certificate check';
    if (st === 'match') {
        color = '#15803d';
        label = 'Certificate OCR: number matches uploaded document';
    } else if (st === 'mismatch') {
        color = '#b91c1c';
        label = 'Certificate OCR: MISMATCH — manual verification required';
    } else if (st === 'no_text' || st === 'no_file') {
        color = '#b45309';
        label = 'Certificate OCR: could not read number from file — verify manually';
    }
    const extracted = (check.extracted || []).join(', ') || '—';
    return `<div style="margin:10px 0;padding:10px;border-radius:8px;border:1px solid ${color};background:${color}14;">
        <p style="margin:0 0 6px;font-weight:600;color:${color};">${escAdmin(label)}</p>
        <p style="margin:0;font-size:0.88rem;"><strong>Entered:</strong> ${escAdmin(check.entered || '—')}</p>
        <p style="margin:4px 0 0;font-size:0.88rem;"><strong>OCR found:</strong> ${escAdmin(extracted)}</p>
        ${check.bestMatch && st === 'mismatch' ? `<p style="margin:4px 0 0;font-size:0.88rem;"><strong>Closest:</strong> ${escAdmin(check.bestMatch)}</p>` : ''}
        <button type="button" class="btn-primary" style="margin-top:8px;font-size:0.8rem;" onclick="adminRecheckNcism(${check._appId || 0})">Re-run OCR check</button>
    </div>`;
}

async function adminRecheckNcism(appId) {
    if (!appId) return;
    try {
        const res = await fetch('/api/admin/applications/' + appId + '/recheck-ncism', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Check failed');
        alert(
            data.check && data.check.status === 'match'
                ? 'OCR: entered number matches certificate.'
                : 'OCR check complete — see application view for details.'
        );
        loadApplications();
    } catch (e) {
        alert('Network error');
    }
}

function viewFullApplication(index) {
    const a = globalAdminApps[index];
    let formData = {};
    try {
        formData = JSON.parse(a.form_data || '{}');
    } catch (e) {}
    const needsDocs = seminarNeedsDocReview(formData.qual);
    const certPath = formData.certificate_path ? String(formData.certificate_path) : '';
    const certLink = certPath
        ? '<p><a href="' +
          escAdmin(publicFileHref(certPath)) +
          '" target="_blank" rel="noopener">View certificate document</a></p>'
        : '<p class="muted">No certificate file on record.</p>';
    const st = String(a.status || '').toLowerCase();
    const canVerify = st === 'submitted' || st === 'pending_approval';
    const docChecks = needsDocs
        ? `<label style="display:block;margin:6px 0;"><input type="checkbox" id="admin-verify-info"> Applicant details are correct</label>
        <label style="display:block;margin:6px 0;"><input type="checkbox" id="admin-verify-ncism"> NCISM / registration number is correct</label>
        <label style="display:block;margin:6px 0;"><input type="checkbox" id="admin-verify-cert"> Certificate document is correct</label>`
        : `<label style="display:block;margin:6px 0;"><input type="checkbox" id="admin-verify-info"> Applicant details are correct</label>`;
    const verifyBlock = canVerify
        ? `<hr style="margin:14px 0;">
        <h4 style="margin:0 0 8px;">Verify application</h4>
        ${docChecks}
        <div class="form-group" style="margin-top:10px;"><label>Reason (required for rejections / document requests)</label>
        <textarea id="admin-verify-reason" rows="3" style="width:100%;" placeholder="e.g. NCISM number does not match certificate"></textarea>
        <div class="form-group" style="margin-top:8px;"><label>Additional documents needed (comma-separated)</label>
        <input type="text" id="admin-verify-requested-docs" style="width:100%;padding:8px;" placeholder="e.g. ID proof, address proof"></div>
        <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;">
        <button type="button" class="btn-primary" style="background:#15803d;" onclick="adminVerifySeminarApplication(${a.id},'approve')">Approve application</button>
        ${
            needsDocs
                ? '<button type="button" class="btn-primary" style="background:#b45309;" onclick="adminVerifySeminarApplication(' +
                  a.id +
                  ",'reject_documents')\">Reject documents only</button>"
                : ''
        }
        <button type="button" class="btn-primary" style="background:#7c3aed;" onclick="adminVerifySeminarApplication(${a.id},'request_documents')">Request additional documents</button>
        <button type="button" class="btn-primary" style="background:#b91c1c;" onclick="adminVerifySeminarApplication(${a.id},'reject_application')">Reject entire application</button>
        </div>
        <p class="muted" style="font-size:0.85rem;margin-top:8px;">Reject documents: doctor re-uploads certificate/NCISM. Request additional: doctor uploads extra verification files on the same application.</p>`
        : '<p class="muted" style="margin-top:12px;">Verification actions appear when status is Submitted or Under review.</p>';

    const content = document.getElementById('admin-view-content');
    content.innerHTML = `
        <p><strong>App No:</strong> ${escAdmin(a.application_no)}</p>
        <p><strong>Status:</strong> ${escAdmin(String(a.status || '').toUpperCase())}</p>
        <p><strong>Portal ID:</strong> ${escAdmin(a.user_id_string || '')}</p>
        <hr style="margin:10px 0;">
        ${formatAdminApplicationDetailsHtml(formData, certLink)}
        ${needsDocs ? formatNcismCertificateCheckHtml(Object.assign({}, formData.ncism_certificate_check || {}, { _appId: a.id })) : ''}
        ${verifyBlock}
        <hr style="margin:16px 0;">
        <h4 style="margin:0 0 8px;">Edit registration form (live)</h4>
        <p class="muted" style="font-size:0.85rem;margin-bottom:8px;">Changes save to this application immediately. Admin OTP may be required.</p>
        <div id="admin-app-edit-fields"></div>
        <button type="button" class="btn-primary" style="margin-top:10px;" onclick="adminSaveApplicationFormEdit(${a.id})">Save form changes</button>
        <p id="admin-app-edit-status" class="muted" style="font-size:0.85rem;margin-top:6px;"></p>
    `;

    const modal = document.getElementById('admin-view-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    if (a.seminar_id) {
        loadAdminSeminarFormFieldsForEdit(a.seminar_id, 'admin-app-edit-fields', 'appedit-f-', formData);
    }
}

async function adminVerifySeminarApplication(appId, decision) {
    const reason = (document.getElementById('admin-verify-reason')?.value || '').trim();
    const requestedDocsRaw = (document.getElementById('admin-verify-requested-docs')?.value || '').trim();
    const requestedDocs = requestedDocsRaw
        ? requestedDocsRaw.split(',').map((x) => x.trim()).filter(Boolean)
        : [];
    const infoOk = !!document.getElementById('admin-verify-info')?.checked;
    const ncismOk = !!document.getElementById('admin-verify-ncism')?.checked;
    const certificateOk = !!document.getElementById('admin-verify-cert')?.checked;
    if (decision !== 'approve' && !reason) {
        return alert('Please enter a reason so the doctor knows what to fix.');
    }
    if (decision === 'approve' && !infoOk) {
        return alert('Check that applicant details are correct before approving.');
    }
    const labels = {
        approve: 'Approve this application?',
        reject_documents: 'Request document re-upload on the same application number?',
        request_documents: 'Ask the doctor to upload additional verification documents?',
        reject_application: 'Reject this entire application?'
    };
    if (!confirm(labels[decision] || 'Continue?')) return;
    try {
        const res = await fetch('/api/admin/applications/' + appId + '/document-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, reason, infoOk, ncismOk, certificateOk, requestedDocs })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Verification failed');
        alert(data.message || 'Done');
        document.getElementById('admin-view-modal').classList.add('hidden');
        loadApplications();
    } catch (err) {
        console.error(err);
        alert('Network error');
    }
}

async function updateAppStatus(appId, status) {
    try {
        const res = await fetch('/api/admin/applications/status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ applicationId: appId, status })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return alert(data.error || 'Status update failed (HTTP ' + res.status + ').');
        }
        alert(data.message || 'Status updated successfully.');
        loadApplications();
    } catch(err) {
        console.error(err);
        alert('Status update failed. Check your connection and try again.');
    }
}

async function loadIntegrationSettings() {
    try {
        const res = await fetch('/api/admin/integrations');
        const s = await res.json();
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null && v !== '') el.value = v;
        };
        set('int-public-base-url', s.public_base_url);
        set('int-wix-url', s.wix_site_url);
        set('int-seminar-host', s.seminar_host);
        set('int-admin-host', s.admin_host);
        set('int-judge-host', s.judge_host);
        set('int-admin-contact', s.admin_contact_email);
        set('int-zoho-host', s.zoho_host);
        set('int-zoho-port', s.zoho_port);
        set('int-zoho-user', s.zoho_user);
        set('int-zoho-from', s.zoho_from);
        set('int-wa-phone-id', s.whatsapp_phone_number_id);
        set('int-wa-waba-id', s.whatsapp_business_account_id);
        set('int-wa-lang', s.whatsapp_template_lang || 'en');
        set('int-wa-otp-template', s.whatsapp_otp_template_name);
        set('int-otp-email-subject', s.otp_email_subject);
        const waHook = document.getElementById('int-wa-webhook-url');
        if (waHook) {
            let base = (s.public_base_url || '').trim().replace(/\/$/, '');
            if (!base && s.seminar_host) {
                base = 'https://' + String(s.seminar_host).replace(/^https?:\/\//, '').replace(/\/$/, '');
            }
            if (!base || /inar\.vaidyagogate/i.test(base)) {
                base = 'https://seminar.vaidyagogate.org';
            }
            waHook.textContent = base + '/api/webhooks/whatsapp';
        }
        const line = document.getElementById('int-status-line');
        if (line) {
            let emailLine = s.email_configured ? 'Email: configured.' : 'Email: not configured.';
            const st = s.email_status;
            if (!s.email_configured && st && Array.isArray(st.missing) && st.missing.length) {
                emailLine += ' Missing: ' + st.missing.join(', ') + '.';
            }
            let waLine = s.whatsapp_configured
                ? 'WhatsApp: configured (token + phone number ID).'
                : 'WhatsApp: not configured.';
            const wst = s.whatsapp_status;
            if (!s.whatsapp_configured && wst && Array.isArray(wst.missing) && wst.missing.length) {
                waLine += ' Missing: ' + wst.missing.join(', ') + '.';
            }
            if (!s.whatsapp_configured) {
                waLine +=
                    ' (OTP template in Notifications is not enough — save Access token and Phone number ID below.)';
            }
            if (s.otp_template_resolved) {
                waLine +=
                    ' OTP template in use: ' +
                    s.otp_template_resolved +
                    ' (' +
                    (s.otp_template_source || 'unknown') +
                    ').';
                if (s.otp_template_meta_languages && s.otp_template_meta_languages.length) {
                    waLine += ' Meta language code(s): ' + s.otp_template_meta_languages.join(', ') + '.';
                } else if (s.whatsapp_template_check_error) {
                    waLine += ' WARNING: ' + s.whatsapp_template_check_error;
                }
                if (s.whatsapp_waba_id) waLine += ' WABA: ' + s.whatsapp_waba_id + '.';
            }
            line.textContent = emailLine + ' ' + waLine;
        }
        await loadWhatsAppEventTemplatesTable();
    } catch (e) {
        console.error(e);
    }
}

async function saveIntegrationSettings() {
    const seminarHost = (document.getElementById('int-seminar-host') || {}).value.trim();
    let publicUrl = (document.getElementById('int-public-base-url') || {}).value.trim();
    if (!publicUrl && seminarHost) publicUrl = 'https://' + seminarHost.replace(/^https?:\/\//, '');
    const body = {
        public_base_url: publicUrl,
        wix_site_url: (document.getElementById('int-wix-url') || {}).value.trim(),
        seminar_host: seminarHost,
        admin_host: (document.getElementById('int-admin-host') || {}).value.trim(),
        judge_host: (document.getElementById('int-judge-host') || {}).value.trim(),
        admin_contact_email: (document.getElementById('int-admin-contact') || {}).value.trim(),
        zoho_host: (document.getElementById('int-zoho-host') || {}).value.trim(),
        zoho_port: (document.getElementById('int-zoho-port') || {}).value.trim(),
        zoho_user: (document.getElementById('int-zoho-user') || {}).value.trim(),
        zoho_pass: (document.getElementById('int-zoho-pass') || {}).value,
        zoho_from: (document.getElementById('int-zoho-from') || {}).value.trim(),
        whatsapp_token: (document.getElementById('int-wa-token') || {}).value,
        whatsapp_phone_number_id: (document.getElementById('int-wa-phone-id') || {}).value.trim(),
        whatsapp_business_account_id: (document.getElementById('int-wa-waba-id') || {}).value.trim(),
        whatsapp_verify_token: (document.getElementById('int-wa-verify') || {}).value,
        whatsapp_template_lang: (document.getElementById('int-wa-lang') || {}).value.trim() || 'en',
        whatsapp_otp_template_name: (document.getElementById('int-wa-otp-template') || {}).value.trim(),
        otp_email_subject: (document.getElementById('int-otp-email-subject') || {}).value.trim()
    };
    try {
        const res = await fetch('/api/admin/integrations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            setAdminSettingsSaveMsg(data.error || 'Save failed', true);
            return;
        }
        (document.getElementById('int-zoho-pass') || {}).value = '';
        (document.getElementById('int-wa-token') || {}).value = '';
        (document.getElementById('int-wa-verify') || {}).value = '';
        await loadIntegrationSettings();
        const st = data.email_status;
        const emailHint =
            data.email_configured
                ? 'Email is configured.'
                : st && Array.isArray(st.missing) && st.missing.length
                  ? 'Email still missing: ' + st.missing.join(', ') + '. Enter SMTP password and save again.'
                  : 'Email is not configured — enter Zoho host, user, and password, then save.';
        const wst = data.settings && data.settings.whatsapp_status;
        const waHint = data.whatsapp_configured
            ? 'WhatsApp is configured.'
            : wst && Array.isArray(wst.missing) && wst.missing.length
              ? 'WhatsApp still missing: ' + wst.missing.join(', ') + '. Paste token and phone number ID, then save.'
              : 'WhatsApp not configured — add token + phone number ID (OTP template alone is not enough).';
        setAdminSettingsSaveMsg('API keys and messaging saved. ' + emailHint + ' ' + waHint);
    } catch (e) {
        setAdminSettingsSaveMsg('Save failed', true);
    }
}

function integrationFormSmtpPayload() {
    const passEl = document.getElementById('int-zoho-pass');
    const pass = passEl ? passEl.value : '';
    const body = {
        zoho_host: (document.getElementById('int-zoho-host') || {}).value.trim(),
        zoho_port: (document.getElementById('int-zoho-port') || {}).value.trim(),
        zoho_user: (document.getElementById('int-zoho-user') || {}).value.trim(),
        zoho_from: (document.getElementById('int-zoho-from') || {}).value.trim()
    };
    if (pass && pass.trim() && pass !== '********') body.zoho_pass = pass.trim();
    return body;
}

async function testIntegrationEmail() {
    const to = (document.getElementById('int-test-email') || {}).value.trim();
    if (!to) return alert('Enter test email address');
    const smtp = integrationFormSmtpPayload();
    if (!smtp.zoho_host || !smtp.zoho_user) {
        return alert('Fill Zoho Host and User (full mailbox e.g. care@vaidyagogate.org), then try again.');
    }
    const passEl = document.getElementById('int-zoho-pass');
    if (passEl && passEl.value.trim() && passEl.value !== '********') {
        const saveFirst = confirm(
            'Save the new app password before testing? (Recommended — click OK to save, then test.)'
        );
        if (saveFirst) {
            await saveIntegrationSettings();
        }
    }
    const res = await fetch('/api/admin/integrations/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, ...smtp })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
        alert('Test email sent. Check inbox/spam. Logged under Notifications → Logs.');
        if (typeof loadNotificationLogs === 'function') loadNotificationLogs();
    } else {
        const msg = [data.error, data.hint].filter(Boolean).join('\n\n');
        alert((msg || 'Failed') + (data.logged ? '\n\nSee Notifications → Logs for details.' : ''));
        if (typeof loadNotificationLogs === 'function') loadNotificationLogs();
    }
}

async function checkWhatsAppTemplateOnMeta() {
    const name = (document.getElementById('int-wa-otp-template') || {}).value.trim() || 'vgmf_otp_auth';
    try {
        const res = await fetch(
            '/api/admin/integrations/whatsapp-template-check?name=' + encodeURIComponent(name)
        );
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Check failed');
        const lines = [
            data.error ? 'ERROR: ' + data.error : 'Template found on Meta.',
            data.hint || '',
            data.wabaId ? 'WABA ID: ' + data.wabaId : '',
            data.phoneWabaId ? 'Phone number WABA: ' + data.phoneWabaId : '',
            data.wabaMatch === false
                ? 'MISMATCH: phone is not on admin WABA — fix Phone number ID or WABA field.'
                : data.wabaMatch === true
                  ? 'Phone number is on admin WABA.'
                  : '',
            data.phoneNumberId ? 'Phone number ID: ' + data.phoneNumberId : '',
            data.languages && data.languages.length ? 'Language code(s): ' + data.languages.join(', ') : '',
            data.templates && data.templates.length
                ? 'Status: ' + data.templates.map((t) => t.language + '=' + t.status).join(', ')
                : '',
            data.otpLikeNames && data.otpLikeNames.length
                ? 'Other OTP templates on this WABA: ' + data.otpLikeNames.join('; ')
                : ''
        ].filter(Boolean);
        alert(lines.join('\n\n'));
        if (data.languages && data.languages.length) {
            const langEl = document.getElementById('int-wa-lang');
            if (langEl) langEl.value = data.languages[0];
        }
        await loadIntegrationSettings();
    } catch (e) {
        alert('Check failed');
    }
}

async function loadWhatsAppEventTemplatesTable() {
    const tbody = document.getElementById('wa-event-templates-tbody');
    if (!tbody) return;
    try {
        const res = await fetch('/api/admin/integrations/whatsapp-event-templates');
        const rows = await res.json();
        if (!Array.isArray(rows)) {
            tbody.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
            return;
        }
        tbody.innerHTML = rows
            .map(
                (r) => `<tr>
            <td><code>${escapeHtml(r.event_key)}</code></td>
            <td style="font-size:0.82rem;">${escapeHtml(r.channel || 'both')}</td>
            <td><input class="form-control" data-wa-event="${escapeHtml(r.event_key)}" data-field="name" value="${escapeHtml(r.whatsapp_template_name || '')}" placeholder="Meta template name" style="width:100%;font-size:0.85rem;"></td>
            <td><input class="form-control" data-wa-event="${escapeHtml(r.event_key)}" data-field="lang" value="${escapeHtml(r.whatsapp_template_lang || '')}" placeholder="en" style="width:72px;font-size:0.85rem;"></td>
        </tr>`
            )
            .join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
    }
}

async function saveWhatsAppEventTemplates() {
    const tbody = document.getElementById('wa-event-templates-tbody');
    if (!tbody) return;
    const templates = [];
    tbody.querySelectorAll('input[data-wa-event]').forEach((inp) => {
        const key = inp.getAttribute('data-wa-event');
        const field = inp.getAttribute('data-field');
        if (!key || !field) return;
        let row = templates.find((t) => t.event_key === key);
        if (!row) {
            row = { event_key: key, whatsapp_template_name: '', whatsapp_template_lang: '' };
            templates.push(row);
        }
        row[field === 'lang' ? 'whatsapp_template_lang' : 'whatsapp_template_name'] = inp.value.trim();
    });
    try {
        const res = await fetch('/api/admin/integrations/whatsapp-event-templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templates })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        alert('WhatsApp template names saved for ' + (data.updated || 0) + ' event(s).');
        await loadIntegrationSettings();
    } catch (e) {
        alert('Save failed');
    }
}

async function testIntegrationWhatsApp() {
    const phone = (document.getElementById('int-test-phone') || {}).value.trim();
    if (!phone) return alert('Enter test phone number');
    const res = await fetch('/api/admin/integrations/test-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
        const del = data.delivery || {};
        const lines = [
            data.hint || 'WhatsApp test completed.',
            del.status ? 'Delivery status: ' + del.status : 'Delivery status: accepted (API only)',
            del.error ? 'Delivery error: ' + del.error : '',
            data.to ? 'Sent to: +' + data.to : '',
            data.template ? 'Template: ' + data.template + (data.templateSource ? ' (' + data.templateSource + ')' : '') : '',
            data.lang ? 'Language: ' + data.lang : '',
            data.method ? 'Method: ' + data.method : '',
            data.messageId ? 'Message ID: ' + data.messageId : '',
            data.phoneDiagnostics && data.phoneDiagnostics.quality_rating
                ? 'Phone quality: ' + data.phoneDiagnostics.quality_rating
                : '',
            data.phoneDiagnostics && data.phoneDiagnostics.display_phone_number
                ? 'From: ' + data.phoneDiagnostics.display_phone_number
                : ''
        ].filter(Boolean);
        alert(lines.join('\n\n'));
        if (typeof loadNotificationLogs === 'function') loadNotificationLogs();
    } else {
        const lines = [
            data.error || 'WhatsApp test failed',
            data.hint,
            data.template ? 'Tried template: ' + data.template : data.templateRaw ? 'Raw config: ' + data.templateRaw : '',
            data.templateSource ? 'Source: ' + data.templateSource : '',
            data.metaLangs && data.metaLangs.length ? 'Meta languages: ' + data.metaLangs.join(', ') : '',
            data.triedLangs && data.triedLangs.length ? 'Languages tried: ' + data.triedLangs.join(', ') : '',
            data.lang ? 'Language: ' + data.lang : '',
            data.to ? 'Normalized to: +' + data.to : ''
        ].filter(Boolean);
        alert(lines.join('\n\n') + '\n\nSee Notifications → Logs.');
        if (typeof loadNotificationLogs === 'function') loadNotificationLogs();
    }
}

async function loadSettings() {
    try {
        await loadIntegrationSettings();
        const res = await fetch('/api/global_settings');
        const settings = await res.json();
        document.getElementById('setting-sitename').value = settings.site_name || '';
        document.getElementById('setting-domain').value = settings.domain || '';
        document.getElementById('setting-pg').value = settings.payment_gateway || 'mock';
        document.getElementById('setting-disabled').value = settings.is_site_disabled || '0';
        let portalFlags = {};
        try {
            portalFlags = settings.portal_flags ? JSON.parse(settings.portal_flags) : {};
        } catch (_) {
            portalFlags = {};
        }
        const ocrToggle = document.getElementById('setting-ncism-disable-ocr');
        if (ocrToggle) ocrToggle.checked = !!portalFlags.ncism_disable_ocr;
        await loadMaintenanceSettings();

        // Load payment gateways
        const pgRes = await fetch('/api/admin/payment_gateways');
        const pgs = await pgRes.json();
        pgs.forEach(pg => {
            const config = JSON.parse(pg.config || '{}');
            if (pg.name === 'razorpay') {
                const test = config.test || {};
                const live = config.live || {};
                if (!test.key_id && config.key_id) {
                    test.key_id = config.key_id;
                    test.key_secret = config.key_secret;
                    test.enabled = test.enabled !== false;
                }
                document.getElementById('pg-razorpay-test-key-id').value = test.key_id || '';
                document.getElementById('pg-razorpay-test-key-secret').value = test.key_secret || '';
                document.getElementById('pg-razorpay-test-enabled').checked = test.enabled !== false;
                document.getElementById('pg-razorpay-live-key-id').value = live.key_id || '';
                document.getElementById('pg-razorpay-live-key-secret').value = live.key_secret || '';
                document.getElementById('pg-razorpay-live-enabled').checked =
                    !!live.enabled || !!(live.key_id && live.key_secret);
                document.getElementById('pg-razorpay-active').checked = pg.is_active;
            } else if (pg.name === 'cashfree') {
                const live = config.live || {};
                document.getElementById('pg-cashfree-app-id').value = live.app_id || config.app_id || '';
                document.getElementById('pg-cashfree-secret-key').value = live.secret_key || config.secret_key || '';
                const cfLiveEl = document.getElementById('pg-cashfree-live-enabled');
                if (cfLiveEl) {
                    cfLiveEl.checked =
                        live.enabled !== false && !!(live.app_id || config.app_id) && !!(live.secret_key || config.secret_key);
                }
                document.getElementById('pg-cashfree-active').checked = pg.is_active;
            }
        });
    } catch(err) { console.error(err); }
}

function setAdminSettingsSaveMsg(text, isError) {
    const msg = document.getElementById('admin-settings-save-msg');
    if (!msg) return;
    msg.style.color = isError ? '#b91c1c' : '#15803d';
    msg.textContent = text || '';
}

async function saveSiteConfigSettings() {
    const ocrToggle = document.getElementById('setting-ncism-disable-ocr');
    const portalFlags = {
        ncism_disable_ocr: !!(ocrToggle && ocrToggle.checked)
    };
    const settings = [
        { key: 'site_name', value: document.getElementById('setting-sitename').value },
        { key: 'domain', value: document.getElementById('setting-domain').value },
        { key: 'payment_gateway', value: document.getElementById('setting-pg').value },
        { key: 'portal_flags', value: JSON.stringify(portalFlags) }
    ];
    try {
        await fetch('/api/admin/global_settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        setAdminSettingsSaveMsg('Site configuration saved.');
    } catch (err) {
        console.error(err);
        setAdminSettingsSaveMsg('Could not save site configuration.', true);
    }
}

let __maintenancePreviewSecret = '';

function isoToDatetimeLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        'T' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes())
    );
}

function datetimeLocalInputToIso(localVal) {
    if (!localVal) return '';
    const d = new Date(localVal);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
}

async function loadMaintenanceSettings() {
    const hint = document.getElementById('maint-admin-hint');
    try {
        const res = await fetch('/api/admin/maintenance-settings');
        const data = await res.json();
        if (!res.ok) return;
        const cfg = data.config || {};
        __maintenancePreviewSecret = cfg.preview_secret || '';
        const headlineEl = document.getElementById('maint-headline');
        const messageEl = document.getElementById('maint-message');
        const goLiveEl = document.getElementById('maint-go-live');
        if (headlineEl) headlineEl.value = cfg.headline || '';
        if (messageEl) messageEl.value = cfg.message || '';
        if (goLiveEl) goLiveEl.value = isoToDatetimeLocalInput(cfg.go_live_at || '');
        if (data.disabled != null) {
            const sel = document.getElementById('setting-disabled');
            if (sel) sel.value = data.disabled ? '1' : '0';
        }
        if (hint) {
            const lines = [];
            if (data.disabled) {
                lines.push('Maintenance is ON — public visitors see the maintenance page only.');
                if (cfg.go_live_at) {
                    lines.push(
                        'Scheduled go-live: ' +
                            (data.go_live_due ? 'due now (will auto-open on next visit)' : cfg.go_live_at)
                    );
                }
                if (__maintenancePreviewSecret) {
                    lines.push('Use “Preview live site” to browse the real homepage while maintenance stays on for everyone else.');
                }
            } else {
                lines.push('Site is live for all visitors.');
            }
            hint.textContent = lines.join(' ');
            hint.style.display = lines.length ? 'block' : 'none';
        }
        window.__seminarPreviewBase = data.seminar_preview_base || '';
    } catch (e) {
        console.error(e);
    }
}

async function saveKillSwitchSettings() {
    const disabled = (document.getElementById('setting-disabled') || {}).value === '1';
    const body = {
        disabled,
        headline: (document.getElementById('maint-headline') || {}).value.trim(),
        message: (document.getElementById('maint-message') || {}).value.trim(),
        go_live_at: datetimeLocalInputToIso((document.getElementById('maint-go-live') || {}).value)
    };
    try {
        const res = await fetch('/api/admin/maintenance-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            setAdminSettingsSaveMsg(data.error || 'Save failed', true);
            return;
        }
        __maintenancePreviewSecret = data.preview_secret || __maintenancePreviewSecret;
        await loadMaintenanceSettings();
        setAdminSettingsSaveMsg(
            disabled
                ? 'Maintenance mode saved. Public site is closed; use Preview buttons to check your work.'
                : 'Site is live again.'
        );
    } catch (err) {
        console.error(err);
        setAdminSettingsSaveMsg('Save failed', true);
    }
}

function previewMaintenancePage() {
    const frame = document.getElementById('maint-preview-frame');
    if (!frame) {
        window.open('/maintenance-preview', '_blank', 'noopener');
        return;
    }
    frame.style.display = 'block';
    frame.src = '/maintenance-preview?ts=' + Date.now();
}

function previewLiveSiteDuringMaintenance() {
    const secret = __maintenancePreviewSecret;
    if (!secret) {
        return alert('Save maintenance settings first to generate a preview link.');
    }
    let base = window.__seminarPreviewBase || '';
    if (!base) {
        const host = (document.getElementById('int-seminar-host') || {}).value.trim();
        if (host) base = 'https://' + host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    if (!base) base = window.location.origin;
    const url = base.replace(/\/$/, '') + '/?vgmf_preview=' + encodeURIComponent(secret);
    window.open(url, '_blank', 'noopener');
}
        
async function savePaymentGatewaysSettings() {
    const cfAppId = document.getElementById('pg-cashfree-app-id').value.trim();
    const cfSecret = document.getElementById('pg-cashfree-secret-key').value.trim();
    const cfLiveOn = document.getElementById('pg-cashfree-live-enabled')?.checked;
    const gateways = [
        {
            name: 'razorpay',
            is_active: document.getElementById('pg-razorpay-active').checked,
            config: {
                test: {
                    enabled: document.getElementById('pg-razorpay-test-enabled').checked,
                    key_id: document.getElementById('pg-razorpay-test-key-id').value.trim(),
                    key_secret: document.getElementById('pg-razorpay-test-key-secret').value.trim()
                },
                live: {
                    enabled: document.getElementById('pg-razorpay-live-enabled').checked,
                    key_id: document.getElementById('pg-razorpay-live-key-id').value.trim(),
                    key_secret: document.getElementById('pg-razorpay-live-key-secret').value.trim()
                }
            }
        },
        {
            name: 'cashfree',
            is_active: document.getElementById('pg-cashfree-active').checked,
            config: {
                app_id: cfAppId,
                secret_key: cfSecret,
                live: {
                    enabled: !!cfLiveOn,
                    app_id: cfAppId,
                    secret_key: cfSecret
                }
            }
        }
    ];
    const legacyOff = ['payu', 'easebuzz', 'paytm', 'phonepe'].map((name) => ({
        name,
        is_active: false,
        config: {}
    }));
    try {
        for (const gw of [...gateways, ...legacyOff]) {
            await fetch(`/api/admin/payment_gateways/${gw.name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: gw.is_active, config: gw.config })
            });
        }
        const razActive = gateways[0].is_active && gateways[0].config.live.enabled;
        const cfActive = gateways[1].is_active && gateways[1].config.live.enabled;
        let defaultPg = null;
        if (razActive) defaultPg = 'razorpay';
        else if (cfActive) defaultPg = 'cashfree';
        if (defaultPg) {
            await fetch('/api/admin/global_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: [{ key: 'payment_gateway', value: defaultPg }] })
            });
            const sel = document.getElementById('setting-pg');
            if (sel) sel.value = defaultPg;
        }
        setAdminSettingsSaveMsg(
            defaultPg
                ? `Payment gateways saved. Default live gateway set to ${defaultPg} (Site configuration).`
                : 'Payment gateways saved. Enable Razorpay or Cashfree Live mode for doctor payments.'
        );
    } catch (err) {
        console.error(err);
        setAdminSettingsSaveMsg('Could not save payment gateways.', true);
    }
}

async function saveGlobalSettings() {
    await saveSiteConfigSettings();
    await saveKillSwitchSettings();
    await savePaymentGatewaysSettings();
}

async function proxySendApplicantOtp(channel) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const sid = parseInt(currentManageSeminarId, 10);
    if (!Number.isInteger(sid) || sid < 1) return alert('Open a seminar dashboard first.');
    const phone = (document.getElementById('proxy-phone') || {}).value.trim();
    const email = (document.getElementById('proxy-email') || {}).value.trim();
    const destination = channel === 'phone' ? phone : email;
    if (!destination) return alert(channel === 'phone' ? 'Enter applicant phone on the form.' : 'Enter applicant email on the form.');
    try {
        const res = await fetch('/api/admin/proxy-otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: adm.id, channel, destination, seminarId: sid })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not send OTP.');
        if (data.debugCode) console.info('Proxy applicant OTP:', data.debugCode);
        if (window.OtpUi) {
            window.OtpUi.notifyOtpSent(channel, data, {
                customMessage:
                    channel === 'phone'
                        ? 'OTP sent successfully to the applicant’s WhatsApp.'
                        : 'OTP sent successfully to the applicant’s email.'
            });
        } else {
            alert(channel === 'phone' ? 'OTP sent successfully to applicant WhatsApp.' : 'OTP sent successfully to applicant email.');
        }
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function proxyVerifyApplicantOtp(channel) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const sid = parseInt(currentManageSeminarId, 10);
    const phone = (document.getElementById('proxy-phone') || {}).value.trim();
    const email = (document.getElementById('proxy-email') || {}).value.trim();
    const destination = channel === 'phone' ? phone : email;
    const codeEl = document.getElementById(channel === 'phone' ? 'proxy-app-phone-otp' : 'proxy-app-email-otp');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!destination || !code) return alert('Enter destination and OTP code.');
    try {
        const res = await fetch('/api/admin/proxy-otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: adm.id, channel, destination, code, seminarId: sid })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Verification failed.');
        if (channel === 'phone') __proxyApplicantPhoneOtpToken = data.token;
        else __proxyApplicantEmailOtpToken = data.token;
        const okEl = document.getElementById(channel === 'phone' ? 'proxy-app-phone-ok' : 'proxy-app-email-ok');
        if (okEl) okEl.textContent = '✓ Verified';
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function loadProxyCapacityBanner() {
    const banner = document.getElementById('proxy-capacity-banner');
    const sid = parseInt(currentManageSeminarId, 10);
    if (!banner || !Number.isInteger(sid) || sid < 1) return;
    try {
        const res = await fetch('/api/admin/seminars/' + sid + '/capacity');
        const cap = await res.json();
        if (!res.ok) {
            banner.style.display = 'none';
            return;
        }
        banner.style.display = 'block';
        if (cap.unlimited) {
            banner.style.background = '#f0fdf4';
            banner.style.border = '1px solid #86efac';
            banner.style.color = '#166534';
            banner.textContent = `Seats: ${cap.filled} registered (no capacity limit set).`;
        } else if (cap.full) {
            banner.style.background = '#fef2f2';
            banner.style.border = '1px solid #fecaca';
            banner.style.color = '#b91c1c';
            banner.textContent = `Seminar FULL — ${cap.filled}/${cap.capacity} seats. New proxy registrations are blocked.`;
        } else {
            banner.style.background = '#eff6ff';
            banner.style.border = '1px solid #bfdbfe';
            banner.style.color = '#1e40af';
            banner.textContent = `Seats: ${cap.filled}/${cap.capacity} filled — ${cap.remaining} remaining. Fee: ₹${cap.price || 0}.`;
        }
    } catch (_) {
        banner.style.display = 'none';
    }
}

function stopProxyPaymentPoll() {
    if (__proxyPollTimer) {
        clearInterval(__proxyPollTimer);
        __proxyPollTimer = null;
    }
}

async function loadProxyPaymentMethodsUI() {
    const box = document.getElementById('proxy-payment-methods');
    const adm = getStoredAdminUser();
    if (!box || !adm || !adm.id) return;
    try {
        const res = await fetch(
            '/api/admin/payments/methods?actingAdminId=' + encodeURIComponent(adm.id)
        );
        const data = await res.json();
        if (!res.ok) {
            box.innerHTML = '<p style="color:#b91c1c;">' + escAdmin(data.error || 'Could not load methods') + '</p>';
            return;
        }
        const methods = (data.methods || []).filter((m) => m.available);
        if (!methods.length) {
            box.innerHTML = '<p style="color:#64748b;">No payment methods configured.</p>';
            return;
        }
        __proxySelectedMethodId = methods[0].id;
        box.innerHTML = methods
            .map((m, i) => {
                const checked = i === 0 ? ' checked' : '';
                return (
                    '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;">' +
                    '<input type="radio" name="proxy-pay-method" value="' +
                    escAdmin(m.id) +
                    '"' +
                    checked +
                    ' style="width:auto;margin-top:4px;" onchange="proxySelectPaymentMethod(this.value)">' +
                    '<span><strong style="color:#1a237e;">' +
                    escAdmin(m.label) +
                    '</strong><br><span style="font-size:0.82rem;color:#64748b;">' +
                    escAdmin(m.description) +
                    '</span></span></label>'
                );
            })
            .join('');
    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Network error loading payment methods.</p>';
    }
}

function proxySelectPaymentMethod(id) {
    __proxySelectedMethodId = id;
}

function showProxyPaymentPanel(registrationId, userId, applicationNo) {
    stopProxyPaymentPoll();
    __proxyLastRegId = registrationId;
    __proxyLastUserId = userId;
    __proxyLastOrderDbId = null;
    const wrap = document.getElementById('proxy-payment-wrap');
    const st = document.getElementById('proxy-payment-status');
    const pollSt = document.getElementById('proxy-poll-status');
    const qrBlock = document.getElementById('proxy-qr-block');
    const markBtn = document.getElementById('proxy-mark-upi-btn');
    if (wrap) wrap.classList.remove('hidden');
    if (st) {
        st.textContent =
            'Application ' +
            (applicationNo || registrationId) +
            ' saved. Choose a payment method and create a payment request.';
    }
    if (pollSt) pollSt.textContent = '';
    if (qrBlock) qrBlock.classList.add('hidden');
    if (markBtn) markBtn.classList.add('hidden');
    loadProxyPaymentMethodsUI().catch(console.error);
}

async function proxyPollPaymentOnce() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id || !__proxyLastOrderDbId) return;
    const pollSt = document.getElementById('proxy-poll-status');
    try {
        const res = await fetch(
            '/api/admin/payments/poll/' +
                __proxyLastOrderDbId +
                '?actingAdminId=' +
                encodeURIComponent(adm.id)
        );
        const data = await res.json();
        if (data.paid) {
            stopProxyPaymentPoll();
            if (pollSt) {
                pollSt.style.color = '#15803d';
                pollSt.textContent = data.message || 'Payment received — doctor dashboard updated.';
            }
            alert(data.message || 'Payment complete.');
            return;
        }
        if (pollSt && data.message) pollSt.textContent = data.message;
    } catch (e) {
        console.error(e);
    }
}

function startProxyPaymentPoll() {
    stopProxyPaymentPoll();
    proxyPollPaymentOnce();
    __proxyPollTimer = setInterval(proxyPollPaymentOnce, 4000);
}

async function proxyInitiatePayment() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id || !__proxyLastRegId) return alert('Save an application first.');
    const methodId = __proxySelectedMethodId || 'dqr';
    stopProxyPaymentPoll();
    const pollSt = document.getElementById('proxy-poll-status');
    const qrBlock = document.getElementById('proxy-qr-block');
    const qrImg = document.getElementById('proxy-qr-img');
    const qrAmt = document.getElementById('proxy-qr-amount');
    const markBtn = document.getElementById('proxy-mark-upi-btn');
    if (pollSt) pollSt.textContent = 'Creating payment request…';
    try {
        const res = await fetch('/api/admin/payments/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId: __proxyLastRegId,
                adminUserId: adm.id,
                methodId
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not initiate payment.');
        if (data.paid) {
            if (pollSt) {
                pollSt.style.color = '#15803d';
                pollSt.textContent = data.message || 'Paid.';
            }
            return alert(data.message || 'Payment recorded.');
        }
        __proxyPaymentAmount = Number(data.amount) || 0;
        __proxyLastOrderDbId = data.orderDbId;
        if (qrAmt) {
            qrAmt.textContent =
                'Amount: ₹' + __proxyPaymentAmount + ' — Order ' + (data.orderIdString || '');
        }
        if (data.qrImageUrl) {
            if (qrImg) {
                qrImg.src =
                    data.qrImageUrl.indexOf('http') === 0
                        ? data.qrImageUrl
                        : data.qrImageUrl;
            }
            if (qrBlock) qrBlock.classList.remove('hidden');
        }
        if (data.manualConfirm && markBtn) markBtn.classList.remove('hidden');
        else if (markBtn) markBtn.classList.add('hidden');
        if (data.paymentType === 'razorpay_checkout' && data.razorpayOrder && data.keyId) {
            openProxyRazorpayCheckout(data);
        } else if (data.paymentType && String(data.paymentType).endsWith('_checkout') && data.gateway !== 'razorpay') {
            openAdminHostedCheckout(data, () => startProxyPaymentPoll());
        }
        if (data.pollRequired) startProxyPaymentPoll();
        else if (pollSt) pollSt.textContent = data.message || '';
        else alert(data.message || 'Payment request created.');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

function openAdminHostedCheckout(data, onPoll) {
    if (data.formPost && data.formPost.action) {
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = data.formPost.action;
        f.target = '_blank';
        Object.entries(data.formPost.fields || {}).forEach(([k, v]) => {
            const inp = document.createElement('input');
            inp.type = 'hidden';
            inp.name = k;
            inp.value = String(v);
            f.appendChild(inp);
        });
        document.body.appendChild(f);
        f.submit();
        setTimeout(() => f.remove(), 2000);
        if (typeof onPoll === 'function') onPoll();
        return true;
    }
    if (data.paymentUrl) {
        const w = window.open(data.paymentUrl, '_blank', 'noopener');
        if (!w && confirm('Open payment page in this tab?')) window.location.href = data.paymentUrl;
        if (typeof onPoll === 'function') onPoll();
        return true;
    }
    if (data.easebuzzAccessKey) {
        const payUrl = 'https://pay.easebuzz.in/pay/' + encodeURIComponent(data.easebuzzAccessKey);
        const w = window.open(payUrl, '_blank', 'noopener');
        if (!w && confirm('Open Easebuzz payment in this tab?')) window.location.href = payUrl;
        if (typeof onPoll === 'function') onPoll();
        return true;
    }
    return false;
}

function openAdminRazorpayCheckout(data, onPaid) {
    if (typeof Razorpay === 'undefined') {
        alert('Razorpay checkout script not loaded. Refresh the page and allow pop-ups for this site.');
        return false;
    }
    const options = {
        key: data.keyId,
        amount: data.razorpayOrder.amount,
        currency: data.razorpayOrder.currency || 'INR',
        name: 'VGMF Seminar',
        description: 'Registration ' + (data.applicationNo || ''),
        order_id: data.razorpayOrder.id,
        handler: function () {
            if (typeof onPaid === 'function') onPaid();
        },
        modal: {
            ondismiss: function () {
                const msg = document.getElementById('co-pay-msg');
                if (msg) msg.textContent = 'Payment window closed — try again or use Check status.';
            }
        }
    };
    const rzp = new Razorpay(options);
    rzp.on('payment.failed', function (resp) {
        alert(
            (resp.error && resp.error.description) ||
                'Payment failed or was cancelled. You can try again.'
        );
    });
    try {
        rzp.open();
        return true;
    } catch (e) {
        console.error(e);
        alert('Could not open Razorpay. Allow pop-ups for admin.vaidyagogate.org and try again.');
        return false;
    }
}

function openProxyRazorpayCheckout(data) {
    openAdminRazorpayCheckout(data, () => proxyPollPaymentOnce());
}

async function proxyMarkUpiPaid() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id || !__proxyLastOrderDbId) return alert('Create a UPI payment request first.');
    if (!confirm('Confirm that UPI payment was received in your bank account?')) return;
    try {
        const res = await fetch('/api/admin/payments/mark-upi-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderDbId: __proxyLastOrderDbId, adminUserId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not confirm.');
        stopProxyPaymentPoll();
        alert(data.message || 'Payment recorded.');
        const pollSt = document.getElementById('proxy-poll-status');
        if (pollSt) {
            pollSt.style.color = '#15803d';
            pollSt.textContent = data.message || 'Paid.';
        }
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function proxyWaivePayment() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id || !__proxyLastRegId) return alert('Save an application first.');
    const note = prompt('Note for waiver (optional):', 'Proxy registration — fee waived') || '';
    try {
        const res = await fetch('/api/admin/payments/waive-and-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId: __proxyLastRegId, note, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not waive.');
        alert(data.message || 'Fee waived.');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function submitProxyApp() {
    const userId = parseInt(document.getElementById('proxy-user-select').value, 10);
    const sid = parseInt(currentManageSeminarId, 10);
    if (!Number.isInteger(userId) || userId < 1) return alert('Select a user first.');
    if (!Number.isInteger(sid) || sid < 1) return alert('Open a seminar dashboard first so the correct seminar is selected.');

    if (!__proxyApplicantPhoneOtpToken || !__proxyApplicantEmailOtpToken) {
        return alert('Verify applicant phone and email OTP before saving.');
    }

    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    
    const formDataObj = {
        fname: document.getElementById('proxy-fname').value.trim(),
        lname: document.getElementById('proxy-lname').value.trim(),
        email: document.getElementById('proxy-email').value.trim(),
        phone: document.getElementById('proxy-phone').value.trim(),
        address: document.getElementById('proxy-addr').value.trim(),
        pin: document.getElementById('proxy-pin').value.trim(),
        city: document.getElementById('proxy-city').value.trim(),
        state: document.getElementById('proxy-state').value.trim(),
        qual: document.getElementById('proxy-qual').value.trim(),
        ncism: document.getElementById('proxy-ncism').value.trim(),
        college: document.getElementById('proxy-college').value.trim(),
        ccity: document.getElementById('proxy-ccity').value.trim(),
        is_proxy: true
    };

    try {
        const res = await fetch('/api/admin/registrations/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUserId: userId,
                seminarId: sid,
                formData: formDataObj,
                adminUserId: adm.id,
                applicantPhoneOtpToken: __proxyApplicantPhoneOtpToken,
                applicantEmailOtpToken: __proxyApplicantEmailOtpToken
            })
        });
        const result = await res.json();
        if (result.success) {
            resetAdminSensitiveOtpTokens();
            resetProxyApplicantOtpTokens();
            const appNo = result.applicationNo || '(existing)';
            alert(`Proxy application saved. Application ID: ${appNo}`);
            if (result.registrationId) {
                showProxyPaymentPanel(result.registrationId, userId, appNo);
            }
            if (currentManageSeminarId) {
                manageSeminar(
                    currentManageSeminarId,
                    document.getElementById('detail-seminar-title').innerText.replace('Dashboard: ', '')
                );
            }
        } else {
            alert(result.error || 'Save failed');
        }
    } catch (err) {
        console.error(err);
        alert('Network error');
    }
}

async function lookupTransferApplication() {
    const applicationRef = document.getElementById('transfer-app-id')?.value?.trim();
    const transferType = document.getElementById('transfer-type')?.value || 'auto';
    const preview = document.getElementById('transfer-lookup-preview');
    const adm = getStoredAdminUser();
    if (!applicationRef) return alert('Enter application number or ID');
    if (preview) preview.innerHTML = '<span class="muted">Looking up…</span>';
    try {
        const res = await fetch(
            '/api/admin/applications/transfer-lookup?actingAdminId=' +
                encodeURIComponent(adm && adm.id) +
                '&applicationRef=' +
                encodeURIComponent(applicationRef) +
                '&transferType=' +
                encodeURIComponent(transferType)
        );
        const data = await res.json();
        if (!res.ok) {
            if (preview) preview.innerHTML = '<span style="color:#b91c1c;">' + escAdmin(data.error || 'Not found') + '</span>';
            return;
        }
        let html = '';
        if (data.seminar) {
            html +=
                '<p><strong>Seminar:</strong> ' +
                escAdmin(data.seminar.applicationNo) +
                ' · ' +
                escAdmin(data.seminar.status) +
                ' · Owner: ' +
                escAdmin(data.seminar.ownerName) +
                ' (' +
                escAdmin(data.seminar.ownerPortalId) +
                ')</p>';
        }
        if (data.case) {
            html +=
                '<p><strong>Case:</strong> ' +
                escAdmin(data.case.applicationNo) +
                ' · ' +
                escAdmin(data.case.status) +
                ' · ' +
                escAdmin(data.case.topic || '') +
                ' · Owner: ' +
                escAdmin(data.case.ownerName) +
                ' (' +
                escAdmin(data.case.ownerPortalId) +
                ')</p>';
        }
        if (preview) preview.innerHTML = html || '<span class="muted">No match</span>';
    } catch (e) {
        console.error(e);
        if (preview) preview.innerHTML = '<span style="color:#b91c1c;">Network error</span>';
    }
}

async function transferApplication() {
    const applicationRef = document.getElementById('transfer-app-id')?.value?.trim();
    const targetUserRef = document.getElementById('transfer-user-id')?.value?.trim();
    const transferType = document.getElementById('transfer-type')?.value || 'auto';
    const adm = getStoredAdminUser();

    if (!applicationRef || !targetUserRef) return alert('Please fill application reference and target user.');

    if (!confirm('Transfer this application to the target user account?')) return;

    try {
        const res = await fetch('/api/admin/applications/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                applicationRef,
                targetUserRef,
                transferType,
                actingAdminId: adm && adm.id
            })
        });
        const result = await res.json();
        if (result.success) {
            let msg = 'Transfer completed.';
            if (result.seminar) msg += '\nSeminar: ' + (result.seminar.applicationNo || result.seminar.id);
            if (result.case) msg += '\nCase: ' + (result.case.applicationNo || result.case.id);
            if (result.targetUser) msg += '\nNew owner: ' + (result.targetUser.name || '') + ' (' + (result.targetUser.userIdString || '') + ')';
            alert(msg);
            lookupTransferApplication();
            loadApplications();
        } else {
            alert('Transfer failed: ' + (result.error || 'Unknown error'));
        }
    } catch (err) {
        console.error(err);
        alert('Network error');
    }
}

// Seminars Logic
let globalSeminars = [];
window.__adminProductionSite = false;
window.__allowDemoAccounts = true;

function summaryCancellationPolicyAdmin(raw) {
    if (!raw) return 'Doctors may cancel until the seminar day (no refund tiers configured).';
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!p || typeof p !== 'object') return 'Doctors may cancel until the seminar day.';
        if (p.enabled === false) return 'Self-cancellation is disabled for doctors.';
        const parts = [];
        parts.push('Doctors may cancel');
        if (p.allowedUntil) {
            parts.push(` until ${seminarCancelUntilFromStorage(p.allowedUntil) || p.allowedUntil} IST`);
        } else {
            parts.push(' until the seminar day');
        }
        parts.push('.');
        if (p.noRefundWithinDays != null) {
            parts.push(`No refund within ${p.noRefundWithinDays} days of the event.`);
        }
        if (Array.isArray(p.tiers)) {
            p.tiers.forEach((t) => {
                if (t.minDaysBeforeEvent != null && t.refundPercent != null) {
                    parts.push(
                        `${t.refundPercent}% refund if cancelling at least ${t.minDaysBeforeEvent} days before the event.`
                    );
                }
            });
        }
        return parts.length ? parts.join(' ') : 'No cancellation policy set for this seminar.';
    } catch (_) {
        return 'No cancellation policy set for this seminar.';
    }
}

function seminarCancelUntilToStorage(localVal) {
    if (!localVal || !String(localVal).trim()) return null;
    const s = String(localVal).trim();
    const norm = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s + ':00' : s;
    return norm + '+05:30';
}

function seminarCancelUntilFromStorage(stored) {
    if (!stored) return '';
    const raw = String(stored).trim();
    if (!raw) return '';
    const d = new Date(raw.includes('T') && !/[zZ+-]/.test(raw) ? raw + '+05:30' : raw);
    if (Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

function buildCancellationPolicyJsonFromUi() {
    const enabledEl = document.getElementById('seminar-cancel-enabled');
    const untilEl = document.getElementById('seminar-cancel-until');
    const daysEl = document.getElementById('seminar-cancel-norefund-days');
    const daysRaw = daysEl && daysEl.value !== '' ? parseInt(daysEl.value, 10) : null;
    const tiers = [];
    document.querySelectorAll('.seminar-cancel-tier-row').forEach((row) => {
        const minD = parseInt((row.querySelector('.tier-min-days') || {}).value, 10);
        const pct = parseInt((row.querySelector('.tier-refund-pct') || {}).value, 10);
        if (Number.isInteger(minD) && Number.isInteger(pct)) {
            tiers.push({ minDaysBeforeEvent: minD, refundPercent: pct });
        }
    });
    const out = {};
    out.enabled = enabledEl ? !!enabledEl.checked : true;
    const until = untilEl && untilEl.value ? seminarCancelUntilToStorage(untilEl.value) : null;
    if (until) out.allowedUntil = until;
    if (daysRaw != null && !Number.isNaN(daysRaw)) out.noRefundWithinDays = daysRaw;
    if (tiers.length) out.tiers = tiers;
    if (!out.enabled && !until && daysRaw == null && !tiers.length) {
        return JSON.stringify({ enabled: false });
    }
    if (out.enabled && !until && daysRaw == null && !tiers.length) {
        return JSON.stringify({ enabled: true });
    }
    return JSON.stringify(out);
}

function addSeminarCancelTierRow(minDays, refundPct) {
    const wrap = document.getElementById('seminar-cancel-tiers');
    if (!wrap) return;
    const row = document.createElement('div');
    row.className = 'seminar-cancel-tier-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-top:8px;align-items:end;';
    row.innerHTML =
        '<div><label style="font-size:0.75rem;">Min days before event</label><input type="number" class="tier-min-days" min="0" value="' +
        (minDays != null ? minDays : '') +
        '" oninput="updateSeminarPolicyPreviews()"></div>' +
        '<div><label style="font-size:0.75rem;">Refund %</label><input type="number" class="tier-refund-pct" min="0" max="100" value="' +
        (refundPct != null ? refundPct : '') +
        '" oninput="updateSeminarPolicyPreviews()"></div>' +
        '<button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#b91c1c;" onclick="this.closest(\'.seminar-cancel-tier-row\').remove();updateSeminarPolicyPreviews();">Remove</button>';
    wrap.appendChild(row);
}

function loadSeminarCancellationUi(rawJson) {
    const enabledEl = document.getElementById('seminar-cancel-enabled');
    const untilEl = document.getElementById('seminar-cancel-until');
    const daysEl = document.getElementById('seminar-cancel-norefund-days');
    const tiersWrap = document.getElementById('seminar-cancel-tiers');
    if (!daysEl || !tiersWrap) return;
    if (enabledEl) enabledEl.checked = false;
    if (untilEl) untilEl.value = '';
    daysEl.value = '';
    tiersWrap.innerHTML = '';
    if (!rawJson || !String(rawJson).trim()) {
        updateSeminarPolicyPreviews();
        return;
    }
    try {
        const p = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        if (enabledEl) {
            enabledEl.checked = p.enabled !== false;
        }
        if (untilEl && p.allowedUntil) {
            untilEl.value = seminarCancelUntilFromStorage(p.allowedUntil);
        }
        if (p.noRefundWithinDays != null) daysEl.value = p.noRefundWithinDays;
        if (Array.isArray(p.tiers)) {
            p.tiers.forEach((t) => addSeminarCancelTierRow(t.minDaysBeforeEvent, t.refundPercent));
        }
    } catch (_) {}
    updateSeminarPolicyPreviews();
}

function seminarExtraFieldTypeOptions(selected) {
    return adminRegFieldTypeOptions(selected);
}

function addSeminarExtraFieldRow(prefill) {
    const tbody = document.getElementById('seminar-extra-fields-tbody');
    if (!tbody) return;
    const rows = window.__seminarExtraFieldRows || [];
    const p = prefill || {};
    const idx = rows.length;
    const key = p.key || 'extra_' + Date.now();
    rows.push({ key });
    window.__seminarExtraFieldRows = rows;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="sem-ex-key" data-idx="${idx}" value="${String(key).replace(/"/g, '&quot;')}" style="width:100px;"></td>
        <td><input type="text" class="sem-ex-label" data-idx="${idx}" value="${String(p.label || key).replace(/"/g, '&quot;')}" style="width:100%;"></td>
        <td><select class="sem-ex-type" data-idx="${idx}">${seminarExtraFieldTypeOptions(p.type)}</select></td>
        <td><input type="number" class="sem-ex-step" data-idx="${idx}" min="1" max="9" value="${p.step != null ? p.step : 1}" style="width:48px;"></td>
        <td><input type="checkbox" class="sem-ex-en" data-idx="${idx}" ${p.enabled !== false ? 'checked' : ''}></td>
        <td><input type="checkbox" class="sem-ex-req" data-idx="${idx}" ${p.required !== false ? 'checked' : ''}></td>
        <td><button type="button" class="btn-primary" style="padding:3px 8px;font-size:0.75rem;background:#64748b;" onclick="removeSeminarExtraFieldRow(${idx})">Remove</button></td>`;
    tbody.appendChild(tr);
}

function removeSeminarExtraFieldRow(idx) {
    const rows = window.__seminarExtraFieldRows || [];
    rows.splice(idx, 1);
    window.__seminarExtraFieldRows = rows;
    const tbody = document.getElementById('seminar-extra-fields-tbody');
    if (!tbody) return;
    const saved = collectSeminarExtraFieldsFromDom();
    tbody.innerHTML = '';
    window.__seminarExtraFieldRows = [];
    saved.forEach((f) => addSeminarExtraFieldRow(f));
}

function collectSeminarExtraFieldsFromDom() {
    const tbody = document.getElementById('seminar-extra-fields-tbody');
    if (!tbody) return [];
    const rows = window.__seminarExtraFieldRows || [];
    return rows.map((r, idx) => {
        const keyEl = tbody.querySelector(`.sem-ex-key[data-idx="${idx}"]`);
        const key = keyEl ? String(keyEl.value || '').trim() : r.key;
        return {
            key: key || r.key,
            label: (tbody.querySelector(`.sem-ex-label[data-idx="${idx}"]`) || {}).value || key,
            type: (tbody.querySelector(`.sem-ex-type[data-idx="${idx}"]`) || {}).value || 'text',
            step: parseInt((tbody.querySelector(`.sem-ex-step[data-idx="${idx}"]`) || {}).value, 10) || 1,
            enabled: !!(tbody.querySelector(`.sem-ex-en[data-idx="${idx}"]`) || {}).checked,
            required: !!(tbody.querySelector(`.sem-ex-req[data-idx="${idx}"]`) || {}).checked
        };
    });
}

function cmsFillSeminarExtraRows(items) {
    const tbody = document.getElementById('seminar-extra-fields-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    window.__seminarExtraFieldRows = [];
    (items || []).forEach((f) => addSeminarExtraFieldRow(f));
}

async function loadSeminarFormOverrideUi(overrideJson) {
    const tbody = document.getElementById('seminar-reg-override-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
    let globalFields = [];
    let globalBirthMin = null;
    let globalBirthMax = null;
    try {
        const res = await fetch('/api/registration-form-config');
        const data = await res.json();
        globalFields = data.fields || [];
        globalBirthMin = data.birthYearMin;
        globalBirthMax = data.birthYearMax;
    } catch (_) {}
    window.__seminarGlobalFields = globalFields;
    window.__seminarGlobalFieldKeys = globalFields.map((f) => f.key);
    let overrideFields = [];
    let seminarBirthMin = null;
    let seminarBirthMax = null;
    if (overrideJson && String(overrideJson).trim()) {
        try {
            const parsed = JSON.parse(overrideJson);
            if (parsed && Array.isArray(parsed.fields)) overrideFields = parsed.fields;
            seminarBirthMin = parsed.birthYearMin;
            seminarBirthMax = parsed.birthYearMax;
        } catch (_) {}
    }
    const byKey = {};
    overrideFields.forEach((f) => {
        if (f && f.key) byKey[f.key] = f;
    });
    const extras = overrideFields.filter((f) => f && f.key && !window.__seminarGlobalFieldKeys.includes(f.key));
    cmsFillSeminarExtraRows(extras);
    tbody.innerHTML = '';
    window.__seminarOverrideFieldKeys = [];
    globalFields.forEach((f, idx) => {
        const ov = byKey[f.key] || {};
        const enabled = ov.enabled != null ? ov.enabled !== false : f.enabled !== false;
        const required = ov.required != null ? !!ov.required : !!f.required;
        const label = ov.label != null && String(ov.label).trim() ? ov.label : f.label || f.key;
        const opts =
            ov.options != null && Array.isArray(ov.options)
                ? ov.options
                : f.options;
        let optCell = '—';
        if (f.key === 'qual' && Array.isArray(opts)) {
            optCell =
                '<span class="muted" style="font-size:0.78rem;">' +
                opts.map((o) => o.label || o.value).join(', ') +
                '</span>';
        }
        window.__seminarOverrideFieldKeys.push(f.key);
        tbody.innerHTML += `<tr>
            <td><code>${String(f.key).replace(/</g, '&lt;')}</code></td>
            <td><input type="text" class="sem-ov-label" data-idx="${idx}" value="${String(label).replace(/"/g, '&quot;')}" oninput="updateSeminarPolicyPreviews()"></td>
            <td><input type="checkbox" class="sem-ov-en" data-idx="${idx}" ${enabled ? 'checked' : ''} onchange="updateSeminarPolicyPreviews()"></td>
            <td><input type="checkbox" class="sem-ov-req" data-idx="${idx}" ${required ? 'checked' : ''} onchange="updateSeminarPolicyPreviews()"></td>
            <td>${optCell}</td>
        </tr>`;
    });
    const qualGlobal = globalFields.find((f) => f.key === 'qual');
    const qualOv = byKey.qual || {};
    const qualOpts =
        qualOv.options != null && Array.isArray(qualOv.options)
            ? qualOv.options.map((o) => o.value)
            : qualGlobal && Array.isArray(qualGlobal.options)
              ? qualGlobal.options.map((o) => o.value)
              : ADMIN_QUAL_OPTION_DEFS.map((o) => o.value);
    const qualWrap = document.getElementById('seminar-qual-options-wrap');
    if (qualWrap) {
        qualWrap.style.display = globalFields.some((f) => f.key === 'qual') ? 'block' : 'none';
        renderQualOptionCheckboxes('seminar-qual-options', qualOpts);
    }
    const minEl = document.getElementById('seminar-birth-year-min');
    const maxEl = document.getElementById('seminar-birth-year-max');
    if (minEl) minEl.value = seminarBirthMin != null ? seminarBirthMin : '';
    if (maxEl) maxEl.value = seminarBirthMax != null ? seminarBirthMax : '';
    window.__seminarGlobalBirthMin = globalBirthMin;
    window.__seminarGlobalBirthMax = globalBirthMax;
    if (!extras.length) {
        cmsFillSeminarExtraRows([]);
    }
    updateSeminarPolicyPreviews();
}

function buildSeminarFormOverrideJsonFromUi() {
    const tbody = document.getElementById('seminar-reg-override-tbody');
    if (!tbody || !window.__seminarOverrideFieldKeys) return null;
    const fields = [];
    const globals = window.__seminarGlobalFields || [];
    window.__seminarOverrideFieldKeys.forEach((key, idx) => {
        const labelEl = tbody.querySelector(`.sem-ov-label[data-idx="${idx}"]`);
        const enEl = tbody.querySelector(`.sem-ov-en[data-idx="${idx}"]`);
        const reqEl = tbody.querySelector(`.sem-ov-req[data-idx="${idx}"]`);
        const g = globals.find((x) => x.key === key) || {};
        const row = {
            key,
            label: labelEl ? labelEl.value : key,
            enabled: !!(enEl && enEl.checked),
            required: !!(reqEl && reqEl.checked)
        };
        if (key === 'qual') {
            const qualOpts = collectQualOptionsFromContainer('seminar-qual-options');
            if (qualOpts.length) row.options = qualOpts;
        }
        fields.push(row);
    });
    const extras = collectSeminarExtraFieldsFromDom();
    const allFields = fields.concat(extras);
    const minEl = document.getElementById('seminar-birth-year-min');
    const maxEl = document.getElementById('seminar-birth-year-max');
    const birthYearMin =
        minEl && minEl.value !== '' && !Number.isNaN(parseInt(minEl.value, 10))
            ? parseInt(minEl.value, 10)
            : null;
    const birthYearMax =
        maxEl && maxEl.value !== '' && !Number.isNaN(parseInt(maxEl.value, 10))
            ? parseInt(maxEl.value, 10)
            : null;
    const anyDisabled = fields.some((f, i) => {
        const g = globals.find((x) => x.key === f.key);
        return g && f.enabled !== (g.enabled !== false);
    });
    const anyRequiredChange = fields.some((f) => {
        const g = globals.find((x) => x.key === f.key);
        return g && !!f.required !== !!g.required;
    });
    const anyLabelChange = fields.some((f) => {
        const g = globals.find((x) => x.key === f.key);
        return g && String(f.label || '') !== String(g.label || f.key);
    });
    const qualOpts = collectQualOptionsFromContainer('seminar-qual-options');
    const gQual = globals.find((x) => x.key === 'qual');
    const gQualVals = (gQual && gQual.options ? gQual.options : ADMIN_QUAL_OPTION_DEFS).map((o) => o.value).sort().join('|');
    const qualChanged = qualOpts.map((o) => o.value).sort().join('|') !== gQualVals;
    const birthChanged =
        birthYearMin !== window.__seminarGlobalBirthMin || birthYearMax !== window.__seminarGlobalBirthMax;
    if (
        !extras.length &&
        !anyDisabled &&
        !anyRequiredChange &&
        !anyLabelChange &&
        !qualChanged &&
        !birthChanged &&
        birthYearMin == null &&
        birthYearMax == null
    ) {
        return null;
    }
    const payload = { version: 1, fields: allFields };
    if (birthYearMin != null) payload.birthYearMin = birthYearMin;
    if (birthYearMax != null) payload.birthYearMax = birthYearMax;
    return JSON.stringify(payload);
}

function updateSeminarPolicyPreviews() {
    const cancelPrev = document.getElementById('seminar-cancel-preview');
    if (cancelPrev) {
        const built = buildCancellationPolicyJsonFromUi();
        cancelPrev.textContent = summaryCancellationPolicyAdmin(built);
    }
    const formPrev = document.getElementById('seminar-form-preview');
    if (formPrev) {
        const built = buildSeminarFormOverrideJsonFromUi();
        if (!built) {
            formPrev.textContent = 'Doctors will see the global registration form (no per-seminar override).';
            return;
        }
        try {
            const parsed = JSON.parse(built);
            const enabled = (parsed.fields || []).filter((f) => f.enabled !== false);
            let prev =
                'Doctors will see: ' +
                (enabled.length
                    ? enabled.map((f) => f.label || f.key).join(', ')
                    : 'no fields (check at least one is enabled)');
            const qo = collectQualOptionsFromContainer('seminar-qual-options');
            if (qo.length) prev += ' · Qualification: ' + qo.map((o) => o.label).join(', ');
            const bmin = document.getElementById('seminar-birth-year-min');
            const bmax = document.getElementById('seminar-birth-year-max');
            if (bmin && bmin.value) prev += ' · Birth year from ' + bmin.value;
            if (bmax && bmax.value) prev += ' to ' + bmax.value;
            formPrev.textContent = prev;
        } catch (_) {
            formPrev.textContent = 'Invalid form override.';
        }
    }
}

async function purgeAdminSeminarTestData(seminarId, title) {
    if (
        !confirm(
            'Purge ALL registration data for "' +
                title +
                '"?\n\nRemoves applications, orders, tickets, scans, and feedback for this seminar. Doctor accounts stay registered. The seminar record is kept unless you check "also delete seminar" below.'
        )
    ) {
        return;
    }
    const alsoDelete = confirm('Also delete the seminar record itself? (Cancel = keep seminar, only purge registrations)');
    try {
        const res = await fetch(
            '/api/admin/seminars/' + seminarId + '/purge-test-data?deleteSeminar=' + (alsoDelete ? '1' : '0'),
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Purge failed');
        alert(data.message || 'Test data purged.');
        loadSeminars();
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function deleteAdminSeminar(seminarId, title) {
    if (!confirm('Delete or deactivate seminar "' + title + '"?\n\nIf registrations exist it will be deactivated only. Hold Shift while confirming to permanently delete all related data.')) {
        return;
    }
    const permanent = window.event && window.event.shiftKey ? '1' : '0';
    try {
        const res = await fetch('/api/admin/seminars/' + seminarId + '?permanent=' + permanent, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Delete failed');
        alert(data.message || (data.deactivated ? 'Seminar deactivated.' : 'Seminar deleted.'));
        loadSeminars();
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

async function deleteAdminRegistration(appId, appNo) {
    if (!confirm('Permanently delete registration ' + (appNo || appId) + '? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/admin/registrations/' + appId, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Delete failed');
        loadApplications();
        if (currentManageSeminarId) {
            const t = document.getElementById('detail-seminar-title');
            manageSeminar(currentManageSeminarId, t ? t.innerText.replace(/^Dashboard:\s*/, '') : '');
        }
    } catch (e) {
        console.error(e);
    }
}

async function deleteAdminCaseProgram(programId, title) {
    if (!confirm('Delete case program "' + title + '"?\nShift+confirm = permanent delete including submissions.')) return;
    const permanent = window.event && window.event.shiftKey ? '1' : '0';
    try {
        const res = await fetch('/api/admin/case/programs/' + programId + '?permanent=' + permanent, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Delete failed');
        alert(data.message || 'Done.');
        loadAdminCasePrograms();
    } catch (e) {
        console.error(e);
    }
}

async function deleteAdminCaseSubmission(subId) {
    if (!confirm('Permanently delete case submission #' + subId + '?')) return;
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Delete failed');
        loadAdminCaseSubmissions();
        const box = document.getElementById('case-mgmt-detail');
        if (box) {
            box.classList.add('hidden');
            box.innerHTML = '';
        }
    } catch (e) {
        console.error(e);
    }
}
let adminPortalYear = new Date().getFullYear();

function openCreateSeminarModal() {
    document.getElementById('admin-seminar-modal').classList.remove('hidden');
    document.getElementById('seminar-form').reset();
    document.getElementById('seminar-id').value = '';
    const otpCh = document.getElementById('seminar-otp-app');
    if (otpCh) otpCh.checked = true;
    const otpS1 = document.getElementById('seminar-otp-step1');
    const otpSub = document.getElementById('seminar-otp-submit');
    if (otpS1) otpS1.checked = true;
    if (otpSub) otpSub.checked = true;
    syncSeminarOtpOptionsUi();
    const py = document.getElementById('seminar-portal-year');
    if (py) py.value = adminPortalYear || new Date().getFullYear();
    if (typeof loadSeminarCancellationUi === 'function') loadSeminarCancellationUi('');
    if (typeof loadSeminarFormOverrideUi === 'function') loadSeminarFormOverrideUi('');
}

async function loadAdminPortalYear() {
    try {
        const res = await fetch('/api/admin/portal/year', { cache: 'no-store' });
        const data = await res.json();
        adminPortalYear = data.portalYear || new Date().getFullYear();
        const sel = document.getElementById('admin-portal-year-select');
        const badge = document.getElementById('admin-portal-year-badge');
        if (badge) badge.textContent = '(Portal ' + adminPortalYear + ')';
        if (sel) {
            sel.innerHTML = '';
            for (let y = adminPortalYear + 1; y >= adminPortalYear - 5; y--) {
                sel.innerHTML +=
                    '<option value="' + y + '"' + (y === adminPortalYear ? ' selected' : '') + '>' + y + '</option>';
            }
        }
        const py = document.getElementById('seminar-portal-year');
        if (py && !py.value) py.value = adminPortalYear;
    } catch (e) {
        console.error(e);
    }
}

async function saveAdminPortalYear() {
    const sel = document.getElementById('admin-portal-year-select');
    if (!sel) return;
    const year = parseInt(sel.value, 10);
    try {
        const res = await fetch('/api/admin/portal/year', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ portalYear: year })
        });
        const data = await res.json();
        if (data.success) {
            adminPortalYear = year;
            await loadAdminPortalYear();
            loadSeminars();
            alert(
                'Portal year set to ' +
                    year +
                    '. All active seminars now use portal year ' +
                    year +
                    '. Doctors and the public site will list seminars for this year.'
            );
        } else alert(data.error || 'Could not save portal year');
    } catch (e) {
        console.error(e);
        alert('Could not save portal year');
    }
}

async function loadSeminars() {
    try {
        await loadAdminPortalYear();
        const res = await fetch('/api/admin/seminars/all');
        globalSeminars = await res.json();
        renderSeminarsTable();
    } catch (err) { console.error(err); }
}

function editSeminar(index) {
    if (!adminCanAccessTab('tab-seminars')) {
        alert('You do not have access to seminar management.');
        return;
    }
    const s = globalSeminars[index];
    document.getElementById('seminar-id').value = s.id;
    document.getElementById('seminar-title').value = s.title;
    document.getElementById('seminar-desc').value = s.description || '';
    
    const formatDt = (dtStr) =>
        window.PortalDateTime && window.PortalDateTime.toDatetimeLocal
            ? window.PortalDateTime.toDatetimeLocal(dtStr)
            : dtStr
              ? String(dtStr).slice(0, 16)
              : '';
    document.getElementById('seminar-reg-start').value = formatDt(s.registration_start);
    document.getElementById('seminar-reg-end').value = formatDt(s.registration_end);
    document.getElementById('seminar-event-date').value = formatDt(s.event_date);
    const py = document.getElementById('seminar-portal-year');
    if (py) py.value = s.portal_year || adminPortalYear || new Date().getFullYear();
    
    document.getElementById('seminar-capacity').value = s.capacity || 0;
    const showSeatsEl = document.getElementById('seminar-show-seats-public');
    if (showSeatsEl) showSeatsEl.checked = s.show_seats_public == null || Number(s.show_seats_public) !== 0;
    document.getElementById('seminar-price').value = s.price || 0;
    document.getElementById('seminar-active').value = s.is_active ? '1' : '0';
    
    document.getElementById('seminar-checkin-enabled').value = s.checkin_enabled ? '1' : '0';
    const csr = document.getElementById('seminar-cert-scans-required');
    if (csr) csr.value = Number(s.cert_scans_required) === 2 ? '2' : '1';
    const checkinRaw = s.checkin_date || '';
    const checkinYmd =
        typeof checkinRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(checkinRaw)
            ? checkinRaw.slice(0, 10)
            : checkinRaw
              ? new Date(checkinRaw).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
              : '';
    document.getElementById('seminar-checkin-date').value = checkinYmd;
    const ple = document.getElementById('seminar-public-list-enabled');
    if (ple) ple.value = s.public_list_enabled ? '1' : '0';
    document.getElementById('seminar-location-url').value = s.location_url || '';
    document.getElementById('seminar-terms').value = s.terms_conditions || '';
    const wh = document.getElementById('seminar-whatsapp');
    if (wh) wh.value = s.whatsapp_group_url || '';
    const otp = document.getElementById('seminar-otp-app');
    if (otp) otp.checked = !!Number(s.otp_on_application);
    const otpS1 = document.getElementById('seminar-otp-step1');
    const otpSub = document.getElementById('seminar-otp-submit');
    if (otpS1) otpS1.checked = s.otp_on_step1 == null ? !!otp?.checked : !!Number(s.otp_on_step1);
    if (otpSub) otpSub.checked = s.otp_on_submit == null ? !!otp?.checked : !!Number(s.otp_on_submit);
    syncSeminarOtpOptionsUi();
    loadSeminarCancellationUi(s.cancellation_policy_json || '');
    loadSeminarFormOverrideUi(s.registration_form_json || '');
    const hi = document.getElementById('seminar-hero-image');
    if (hi) hi.value = s.hero_image_path || '';
    const fl = document.getElementById('seminar-flyer');
    if (fl) fl.value = s.flyer_path || '';
    const gal = document.getElementById('seminar-gallery');
    if (gal) {
        try {
            const g = s.gallery_paths ? JSON.parse(s.gallery_paths) : [];
            gal.value = Array.isArray(g) ? JSON.stringify(g) : (s.gallery_paths || '');
        } catch (_) {
            gal.value = s.gallery_paths || '';
        }
    }

    document.getElementById('admin-seminar-modal').classList.remove('hidden');
}

async function saveSeminar(e) {
    e.preventDefault();
    const id = document.getElementById('seminar-id').value;
    let galleryVal = (document.getElementById('seminar-gallery') || {}).value || '[]';
    try {
        const parsed = JSON.parse(galleryVal || '[]');
        if (!Array.isArray(parsed)) throw new Error('not array');
        galleryVal = JSON.stringify(parsed);
    } catch (_) {
        alert('Gallery must be valid JSON (array of paths or year albums).');
        return;
    }
    const regFormOverride = buildSeminarFormOverrideJsonFromUi();
    const cancelPol = buildCancellationPolicyJsonFromUi();
    const data = {
        title: document.getElementById('seminar-title').value,
        description: document.getElementById('seminar-desc').value,
        registration_start: window.PortalDateTime
            ? window.PortalDateTime.fromDatetimeLocal(document.getElementById('seminar-reg-start').value)
            : document.getElementById('seminar-reg-start').value,
        registration_end: window.PortalDateTime
            ? window.PortalDateTime.fromDatetimeLocal(document.getElementById('seminar-reg-end').value)
            : document.getElementById('seminar-reg-end').value,
        event_date: window.PortalDateTime
            ? window.PortalDateTime.fromDatetimeLocal(document.getElementById('seminar-event-date').value)
            : document.getElementById('seminar-event-date').value,
        capacity: parseInt(document.getElementById('seminar-capacity').value) || 0,
        show_seats_public: document.getElementById('seminar-show-seats-public')?.checked === true,
        price: parseFloat(document.getElementById('seminar-price').value) || 0,
        is_active: document.getElementById('seminar-active').value === '1',
        checkin_enabled: document.getElementById('seminar-checkin-enabled').value === '1',
        checkin_date: (() => {
            const enabled = document.getElementById('seminar-checkin-enabled').value === '1';
            let d = document.getElementById('seminar-checkin-date').value || '';
            if (enabled && !d) {
                d = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            }
            return d || null;
        })(),
        public_list_enabled: document.getElementById('seminar-public-list-enabled')?.value === '1',
        cert_scans_required: parseInt(document.getElementById('seminar-cert-scans-required')?.value || '1', 10) === 2 ? 2 : 1,
        location_url: document.getElementById('seminar-location-url').value || null,
        terms_conditions: document.getElementById('seminar-terms').value || null,
        hero_image_path: (document.getElementById('seminar-hero-image') || {}).value || null,
        flyer_path: (document.getElementById('seminar-flyer') || {}).value || null,
        gallery_paths: galleryVal,
        whatsapp_group_url: (document.getElementById('seminar-whatsapp') || {}).value || null,
        otp_on_application: !!(document.getElementById('seminar-otp-app') || {}).checked,
        otp_on_step1:
            !!(document.getElementById('seminar-otp-app') || {}).checked &&
            !!(document.getElementById('seminar-otp-step1') || {}).checked,
        otp_on_submit:
            !!(document.getElementById('seminar-otp-app') || {}).checked &&
            !!(document.getElementById('seminar-otp-submit') || {}).checked,
        cancellation_policy_json: cancelPol,
        registration_form_json: regFormOverride,
        portal_year: parseInt((document.getElementById('seminar-portal-year') || {}).value, 10) || adminPortalYear
    };
    if (data.portal_year !== adminPortalYear) {
        const ok = confirm(
            'Portal year on this seminar (' +
                data.portal_year +
                ') differs from the admin portal year (' +
                adminPortalYear +
                '). Save anyway? Tip: set the header Portal year to ' +
                data.portal_year +
                ' to align doctor and public listings.'
        );
        if (!ok) return;
    }

    const url = id ? '/api/admin/seminars/' + id : '/api/admin/seminars';
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            alert('Seminar saved successfully!');
            document.getElementById('admin-seminar-modal').classList.add('hidden');
            loadSeminars();
        } else {
            alert('Error: ' + result.error);
        }
    } catch(err) { console.error(err); }
}

// ----------------- Seminar Dashboard Management -----------------
let currentManageSeminarId = null;
let currentSeminarApps = [];

async function manageSeminar(id, title) {
    if (!adminCanAccessTab('tab-seminars')) {
        alert('You do not have access to seminar management.');
        return;
    }
    currentManageSeminarId = id;
    document.getElementById('detail-seminar-title').innerText = 'Dashboard: ' + title;
    
    // Switch tabs
    document.querySelectorAll('.tab-pane').forEach(t => t.classList.add('hidden'));
    document.getElementById('tab-seminar-details').classList.remove('hidden');
    
    // Load Stats
    try {
        const res = await fetch('/api/admin/seminars/' + id + '/stats');
        const stats = await res.json();
        document.getElementById('stat-pending-apps').innerText = stats.pending_apps || 0;
        document.getElementById('stat-approved-apps').innerText = stats.approved_apps || 0;
        document.getElementById('stat-pending-payments').innerText = stats.pending_payments || 0;
        document.getElementById('stat-revenue').innerText = '₹' + (stats.total_revenue || 0);
        const semRow = (globalSeminars || []).find((s) => Number(s.id) === Number(id));
        const showSeats =
            !semRow || semRow.show_seats_public == null || Number(semRow.show_seats_public) !== 0;
        const seatsCard = document.getElementById('stat-seats-card');
        const seatsEl = document.getElementById('stat-seats');
        if (seatsCard) seatsCard.style.display = showSeats ? '' : 'none';
        if (seatsEl && showSeats) {
            if (stats.unlimited_seats) seatsEl.textContent = (stats.filled || 0) + ' / ∞';
            else if (stats.capacity > 0) {
                seatsEl.textContent = (stats.filled || 0) + ' / ' + stats.capacity;
                seatsEl.style.color = stats.seats_full ? '#b91c1c' : '#7c3aed';
            } else seatsEl.textContent = (stats.filled || 0) + ' (no cap)';
        }
    } catch (err) { console.error(err); }

    // Load Applications
    try {
        const res = await fetch('/api/admin/seminars/' + id + '/applications');
        currentSeminarApps = await res.json();
        const tbody = document.getElementById('detail-applications-list');
        tbody.innerHTML = '';
        if(currentSeminarApps.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No applications for this seminar.</td></tr>';
            return;
        }

        currentSeminarApps.forEach((a) => {
            let formData = {};
            try { formData = JSON.parse(a.form_data || '{}'); } catch(e){}
            const candidateName = formData.fname ? `${formData.fname} ${formData.lname || ''}` : `${a.first_name || ''} ${a.last_name || ''}`;

            tbody.innerHTML += `
                <tr>
                    <td><strong>${a.application_no}</strong></td>
                    <td>${candidateName}</td>
                    <td>${a.status.toUpperCase()}</td>
                    <td><button class="btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="switchTab('tab-applications')">Go to Main Review</button></td>
                </tr>
            `;
        });
    } catch (err) { console.error(err); }

    // Start Live Scans Polling
    loadLiveScans();
    if(liveScansInterval) clearInterval(liveScansInterval);
    liveScansInterval = setInterval(loadLiveScans, 5000);
}

let liveScansInterval = null;

async function loadLiveScans() {
    if(!currentManageSeminarId) return;
    try {
        const res = await fetch('/api/admin/seminars/' + currentManageSeminarId + '/scans');
        const scans = await res.json();
        const tbody = document.getElementById('live-scans-list');
        tbody.innerHTML = '';
        
        if(scans.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">No scans recorded yet.</td></tr>';
            return;
        }

        scans.forEach(s => {
            const timeStr = new Date(s.scan_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
            const participant = `${s.first_name || ''} ${s.last_name || ''}`;
            const volunteer = s.vol_first
                ? `${s.vol_first} ${s.vol_last || ''} (${s.scanner_user_id_string || ''})`
                : '<span style="color:#94a3b8">System/Admin</span>';
            
            tbody.innerHTML += `
                <tr>
                    <td>${timeStr}</td>
                    <td><strong>${s.user_id_string || ''}</strong> — ${participant}<br><span style="font-size:0.8rem;color:#64748b;">App: ${s.application_no || '—'}</span></td>
                    <td>${volunteer}</td>
                </tr>
            `;
        });
    } catch(err) { console.error(err); }
}

async function setCountdownActive() {
    if(!currentManageSeminarId) return;
    try {
        const res = await fetch('/api/admin/seminars/' + currentManageSeminarId + '/countdown', { method: 'POST' });
        const result = await res.json();
        if(result.success) alert("This seminar is now the main countdown event on the homepage!");
    } catch(err) { console.error(err); }
}

async function addSeminarNotice() {
    if(!currentManageSeminarId) return;
    const msg = document.getElementById('notice-msg').value;
    const pdfFile = document.getElementById('notice-pdf').files[0];
    
    if(!msg) return alert("Message is required.");

    const payload = new FormData();
    payload.append('seminar_id', currentManageSeminarId);
    payload.append('message', msg);
    if(pdfFile) payload.append('pdf', pdfFile);

    try {
        const res = await fetch('/api/admin/notices', {
            method: 'POST',
            body: payload
        });
        const result = await res.json();
        if(result.success) {
            alert("Notification posted to this seminar's portal successfully!");
            document.getElementById('notice-msg').value = '';
            document.getElementById('notice-pdf').value = '';
        }
    } catch(err) { console.error(err); }
}

function downloadParticipantsExcel() {
    if(currentSeminarApps.length === 0) return alert("No applications to download.");
    
    let csvContent = "data:text/csv;charset=utf-8,Application No,Name,Email,Phone,Status\\n";
    
    currentSeminarApps.forEach(a => {
        let formData = {};
        try { formData = JSON.parse(a.form_data || '{}'); } catch(e){}
        const name = formData.fname ? `${formData.fname} ${formData.lname || ''}` : `${a.first_name || ''} ${a.last_name || ''}`;
        const email = formData.email || '';
        const phone = formData.phone || '';
        csvContent += `\n${a.application_no},"${name}","${email}","${phone}","${a.status}"`;
    });

    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csvContent));
    link.setAttribute('download', 'participants.csv');
    link.click();
}

// ==================== EVENT SCHEDULES ====================
let __eventSchedulesCache = [];

function scheduleDatetimeLocalValue(raw) {
    if (!raw) return '';
    if (window.PortalDateTime && window.PortalDateTime.toDatetimeLocal) {
        return window.PortalDateTime.toDatetimeLocal(raw);
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).replace(' ', 'T').slice(0, 16);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleDatetimeFromLocal(localVal) {
    if (!localVal) return localVal;
    if (window.PortalDateTime && window.PortalDateTime.fromDatetimeLocal) {
        return window.PortalDateTime.fromDatetimeLocal(localVal);
    }
    return localVal;
}

function formatScheduleDisplay(iso) {
    if (!iso) return '—';
    if (window.PortalDateTime && window.PortalDateTime.format) {
        return window.PortalDateTime.format(iso);
    }
    try {
        return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    } catch (_) {
        return String(iso);
    }
}

async function populateScheduleSeminarSelect(selectedId) {
    const sel = document.getElementById('schedule-seminar');
    if (!sel) return;
    try {
        const res = await fetch('/api/admin/seminars');
        const seminars = await res.json();
        sel.innerHTML = '<option value="">Select seminar…</option>';
        (seminars || []).forEach((s) => {
            const opt = document.createElement('option');
            opt.value = String(s.id);
            opt.textContent = s.title || `Seminar #${s.id}`;
            sel.appendChild(opt);
        });
        if (selectedId != null && selectedId !== '') sel.value = String(selectedId);
    } catch (e) {
        console.error(e);
        sel.innerHTML = '<option value="">Could not load seminars</option>';
    }
}

async function populateEventSchedulesSeminarFilter() {
    const sel = document.getElementById('event-schedules-seminar-filter');
    if (!sel) return;
    const prev = sel.value;
    try {
        const res = await fetch('/api/admin/seminars');
        const seminars = await res.json();
        sel.innerHTML = '<option value="">All seminars</option>';
        (seminars || []).forEach((s) => {
            const opt = document.createElement('option');
            opt.value = String(s.id);
            opt.textContent = s.title || `Seminar #${s.id}`;
            sel.appendChild(opt);
        });
        if (prev) sel.value = prev;
    } catch (e) {
        console.error(e);
    }
}

async function loadEventSchedules() {
    const tbody = document.getElementById('event-schedules-list');
    if (!tbody) return;
    try {
        await populateEventSchedulesSeminarFilter();
        const res = await fetch('/api/event-schedules');
        const schedules = await res.json();
        if (!res.ok) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#b91c1c;">${(schedules && schedules.error) || 'Could not load schedules'}</td></tr>`;
            return;
        }
        __eventSchedulesCache = Array.isArray(schedules) ? schedules : [];
        renderEventSchedulesTable();
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#b91c1c;">Network error loading schedules</td></tr>';
    }
}

async function openEventScheduleModal(seminarIdOpt) {
    document.getElementById('schedule-id').value = '';
    document.getElementById('event-schedule-form').reset();
    await populateScheduleSeminarSelect(seminarIdOpt != null ? seminarIdOpt : '');
    document.getElementById('event-schedule-modal').classList.remove('hidden');
}

async function openEventScheduleModalForSeminar(seminarId, seminarTitle) {
    switchTab('tab-event-schedules');
    const filter = document.getElementById('event-schedules-seminar-filter');
    if (filter) filter.value = String(seminarId);
    renderEventSchedulesTable();
    await openEventScheduleModal(seminarId);
    if (seminarTitle) {
        const titleEl = document.getElementById('schedule-title');
        if (titleEl && !titleEl.value.trim()) titleEl.value = seminarTitle + ' — ';
    }
}

async function editEventScheduleById(id) {
    const s = __eventSchedulesCache.find((x) => Number(x.id) === Number(id));
    if (!s) {
        await loadEventSchedules();
        return editEventScheduleById(id);
    }
    document.getElementById('schedule-id').value = s.id;
    document.getElementById('schedule-title').value = s.title || '';
    document.getElementById('schedule-description').value = s.description || '';
    await populateScheduleSeminarSelect(s.seminar_id || '');
    document.getElementById('schedule-start-time').value = scheduleDatetimeLocalValue(s.start_time);
    document.getElementById('schedule-end-time').value = scheduleDatetimeLocalValue(s.end_time);
    document.getElementById('schedule-location').value = s.location || '';
    document.getElementById('schedule-speaker-name').value = s.speaker_name || '';
    document.getElementById('schedule-speaker-bio').value = s.speaker_bio || '';
    document.getElementById('event-schedule-modal').classList.remove('hidden');
}

async function saveEventSchedule(e) {
    e.preventDefault();
    const id = document.getElementById('schedule-id').value;
    const seminarRaw = document.getElementById('schedule-seminar').value;
    if (!seminarRaw) {
        alert('Please select the seminar / event this schedule belongs to.');
        return;
    }
    const data = {
        title: document.getElementById('schedule-title').value,
        description: document.getElementById('schedule-description').value,
        seminarId: seminarRaw,
        startTime: scheduleDatetimeFromLocal(document.getElementById('schedule-start-time').value),
        endTime: scheduleDatetimeFromLocal(document.getElementById('schedule-end-time').value),
        location: document.getElementById('schedule-location').value,
        speakerName: document.getElementById('schedule-speaker-name').value,
        speakerBio: document.getElementById('schedule-speaker-bio').value
    };

    try {
        const method = id ? 'PUT' : 'POST';
        const url = id ? `/api/admin/event-schedules/${id}` : '/api/admin/event-schedules';
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const payload = await res.json().catch(() => ({}));
        if (res.ok) {
            alert('Event schedule saved successfully!');
            document.getElementById('event-schedule-modal').classList.add('hidden');
            loadEventSchedules();
        } else {
            alert(payload.error || 'Error saving event schedule');
        }
    } catch (err) {
        console.error(err);
        alert('Error: ' + err.message);
    }
}

async function deleteEventSchedule(id) {
    if (!confirm('Are you sure you want to delete this event schedule?')) return;
    try {
        const res = await fetch(`/api/admin/event-schedules/${id}`, { method: 'DELETE' });
        const payload = await res.json().catch(() => ({}));
        if (res.ok) {
            alert('Event schedule deleted');
            loadEventSchedules();
        } else {
            alert(payload.error || 'Error deleting event schedule');
        }
    } catch (err) {
        console.error(err);
    }
}

// ==================== FEEDBACK ====================
let currentFeedbackSeminarId = null;

async function loadFeedbackSeminars() {
    try {
        const res = await fetch('/api/admin/seminars/all');
        const seminars = await res.json();
        const select = document.getElementById('feedback-seminar-filter');
        select.innerHTML = '<option value="">-- Select Seminar --</option>';
        
        seminars.forEach(s => {
            select.innerHTML += `<option value="${s.id}">${s.title}</option>`;
        });
    } catch(err) { console.error(err); }
}

async function loadFeedbackForSeminar() {
    const seminarId = document.getElementById('feedback-seminar-filter').value;
    if(!seminarId) {
        document.getElementById('feedback-list').innerHTML = '<tr><td colspan="6" style="text-align: center;">Select a seminar to view feedback</td></tr>';
        return;
    }

    currentFeedbackSeminarId = seminarId;
    
    try {
        // Load statistics
        const statsRes = await fetch(`/api/admin/feedback/stats/${seminarId}`);
        const stats = await statsRes.json();
        
        const totalPercent = stats.total_feedbacks > 0 ? Math.round((stats.would_attend_again_count / stats.total_feedbacks) * 100) : 0;
        
        document.getElementById('stat-total-feedback').innerText = stats.total_feedbacks || 0;
        document.getElementById('stat-avg-rating').innerText = (stats.avg_rating ? stats.avg_rating.toFixed(1) : 0) + '/5';
        document.getElementById('stat-content-quality').innerText = (stats.avg_content_quality ? stats.avg_content_quality.toFixed(1) : 0) + '/5';
        document.getElementById('stat-speaker-quality').innerText = (stats.avg_speaker_quality ? stats.avg_speaker_quality.toFixed(1) : 0) + '/5';
        document.getElementById('stat-would-attend').innerText = totalPercent + '%';
        
        // Load feedback details
        const feedbackRes = await fetch(`/api/admin/feedback/seminar/${seminarId}`);
        const feedbacks = await feedbackRes.json();
        __adminFeedbackCache = Array.isArray(feedbacks) ? feedbacks : [];
        renderFeedbackTable();
    } catch(err) { console.error(err); }
}

// ==================== CONTACT INQUIRIES (website) ====================
let currentContactInquiryId = null;

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadContactInquiries() {
    try {
        const filterEl = document.getElementById('contact-inquiry-filter');
        const status = filterEl ? filterEl.value : '';
        let url = '/api/admin/contact-inquiries';
        if (status) url += `?status=${encodeURIComponent(status)}`;
        const res = await fetch(url);
        const rows = await res.json();
        __adminContactInquiriesCache = Array.isArray(rows) ? rows : [];
        renderContactInquiriesTable();
    } catch (err) {
        console.error(err);
    }
}

async function openContactInquiry(id) {
    try {
        const res = await fetch('/api/admin/contact-inquiries');
        const rows = await res.json();
        const row = Array.isArray(rows) ? rows.find((x) => Number(x.id) === Number(id)) : null;
        if (!row) {
            alert('Inquiry not found. Refresh the list.');
            return;
        }
        currentContactInquiryId = id;
        const body = document.getElementById('contact-inquiry-detail-body');
        const panel = document.getElementById('contact-inquiry-detail');
        const statusSel = document.getElementById('contact-inquiry-status');
        const notesEl = document.getElementById('contact-inquiry-notes');
        if (!body || !panel) return;
        body.innerHTML = `
            <p><strong>Name:</strong> ${escapeHtml(row.name || '')}</p>
            <p><strong>Email:</strong> <a href="mailto:${escapeHtml(row.email || '')}">${escapeHtml(row.email || '')}</a></p>
            <p><strong>Phone:</strong> ${escapeHtml(row.phone || '—')}</p>
            <p><strong>Subject:</strong> ${escapeHtml(row.subject || '')}</p>
            <p><strong>Received:</strong> ${row.created_at ? new Date(row.created_at).toLocaleString() : '—'}</p>
            <p style="margin-top:10px;"><strong>Message:</strong></p>
            <div style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">${escapeHtml(row.message || '')}</div>
        `;
        if (statusSel) statusSel.value = row.status || 'new';
        if (notesEl) notesEl.value = row.admin_notes || '';
        const subEl = document.getElementById('contact-reply-subject');
        const bodyEl = document.getElementById('contact-reply-body');
        const replyMsg = document.getElementById('contact-reply-msg');
        if (subEl) subEl.value = 'Re: ' + (row.subject || 'Your enquiry');
        if (bodyEl) bodyEl.value = '';
        if (replyMsg) replyMsg.textContent = '';
        panel.classList.remove('hidden');
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        console.error(err);
        alert('Could not load inquiry.');
    }
}

async function saveContactInquiryUpdate() {
    if (!currentContactInquiryId) return alert('Select an inquiry first.');
    const status = document.getElementById('contact-inquiry-status')?.value || 'new';
    const admin_notes = document.getElementById('contact-inquiry-notes')?.value || '';
    try {
        const res = await fetch(`/api/admin/contact-inquiries/${currentContactInquiryId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, admin_notes })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Update failed');
        alert('Contact inquiry updated');
        loadContactInquiries();
    } catch (err) {
        console.error(err);
        alert('Update failed');
    }
}

async function sendContactInquiryEmail() {
    if (!currentContactInquiryId) return alert('Select an inquiry first.');
    const admin = getStoredAdminUser();
    if (!admin?.id) return alert('Admin session required');
    const subject = document.getElementById('contact-reply-subject')?.value || '';
    const body = document.getElementById('contact-reply-body')?.value || '';
    const msgEl = document.getElementById('contact-reply-msg');
    if (!subject.trim() || !body.trim()) return alert('Subject and message are required');
    if (msgEl) msgEl.textContent = 'Sending…';
    try {
        const res = await fetch(`/api/admin/contact-inquiries/${currentContactInquiryId}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: admin.id, subject, body })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.hint || 'Send failed');
        if (msgEl) {
            msgEl.style.color = '#15803d';
            msgEl.textContent = data.message || 'Email sent.';
        }
        loadContactInquiries();
        openContactInquiry(currentContactInquiryId);
    } catch (e) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = e.message || 'Send failed';
        }
    }
}

async function initAdminEmailComposeTab() {
    await fillAdminSeminarSelect('mail-bulk-seminar', false);
    onMailBulkAudienceChange();
}

function onMailBulkAudienceChange() {
    const aud = document.getElementById('mail-bulk-audience')?.value || '';
    const semWrap = document.getElementById('mail-bulk-seminar-wrap');
    const emWrap = document.getElementById('mail-bulk-emails-wrap');
    const showSem = aud === 'seminar_paid' || aud === 'seminar_all';
    if (semWrap) semWrap.style.display = showSem ? '' : 'none';
    if (emWrap) emWrap.classList.toggle('hidden', aud !== 'custom_emails');
}

async function previewMailBulkCount() {
    const admin = getStoredAdminUser();
    const aud = document.getElementById('mail-bulk-audience')?.value || '';
    const sid = document.getElementById('mail-bulk-seminar')?.value || '';
    const emails = document.getElementById('mail-bulk-emails')?.value || '';
    const el = document.getElementById('mail-bulk-count');
    if (!admin?.id) return alert('Admin session required');
    if (el) el.textContent = 'Counting…';
    try {
        let url =
            `/api/admin/email/recipient-count?actingAdminId=${admin.id}&audience=${encodeURIComponent(aud)}`;
        if (sid && (aud === 'seminar_paid' || aud === 'seminar_all')) {
            url += `&seminarId=${encodeURIComponent(sid)}`;
        }
        if (aud === 'custom_emails' && emails) {
            url += `&emails=${encodeURIComponent(emails)}`;
        }
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        if (el) el.textContent = `Recipients with valid email: ${data.count}`;
    } catch (e) {
        if (el) el.textContent = e.message || 'Could not count';
    }
}

async function sendAdminSingleEmail() {
    const admin = getStoredAdminUser();
    if (!admin?.id) return alert('Admin session required');
    const to = document.getElementById('mail-single-to')?.value || '';
    const subject = document.getElementById('mail-single-subject')?.value || '';
    const body = document.getElementById('mail-single-body')?.value || '';
    const msgEl = document.getElementById('mail-single-msg');
    if (msgEl) msgEl.textContent = 'Sending…';
    try {
        const res = await fetch('/api/admin/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: admin.id, to, subject, body })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.hint || 'Send failed');
        if (msgEl) {
            msgEl.style.color = '#15803d';
            msgEl.textContent = data.message || 'Sent.';
        }
    } catch (e) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = e.message || 'Send failed';
        }
    }
}

async function sendAdminBulkEmail() {
    const admin = getStoredAdminUser();
    if (!admin?.id) return alert('Admin session required');
    const audience = document.getElementById('mail-bulk-audience')?.value || '';
    const seminarId = document.getElementById('mail-bulk-seminar')?.value || '';
    const emailsRaw = document.getElementById('mail-bulk-emails')?.value || '';
    const subject = document.getElementById('mail-bulk-subject')?.value || '';
    const body = document.getElementById('mail-bulk-body')?.value || '';
    const msgEl = document.getElementById('mail-bulk-msg');
    if (!subject.trim() || !body.trim()) return alert('Subject and message are required');
    if (!confirm('Send bulk email to the selected audience?')) return;
    if (msgEl) msgEl.textContent = 'Queueing…';
    try {
        const res = await fetch('/api/admin/email/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actingAdminId: admin.id,
                audience,
                seminarId: seminarId ? parseInt(seminarId, 10) : null,
                emails: emailsRaw.split(/[,\s;]+/).filter(Boolean),
                subject,
                body
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        if (msgEl) {
            msgEl.style.color = '#15803d';
            msgEl.textContent = data.message || 'Queued.';
        }
    } catch (e) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = e.message || 'Failed';
        }
    }
}

// ==================== SUPPORT TICKETS ====================
let currentViewingTicketId = null;
let __adminStResolvedDoctor = null;

function clearAdminSupportTicketDoctorPreview() {
    __adminStResolvedDoctor = null;
    const hid = document.getElementById('admin-st-create-resolved-id');
    const prev = document.getElementById('admin-st-doctor-preview');
    if (hid) hid.value = '';
    if (prev) {
        prev.style.display = 'none';
        prev.innerHTML = '';
    }
}

async function adminLookupDoctorForSupportTicket() {
    const adm = getStoredAdminUser();
    const msgEl = document.getElementById('admin-st-create-msg');
    const q = ((document.getElementById('admin-st-create-user-id') || {}).value || '').trim();
    clearAdminSupportTicketDoctorPreview();
    if (!adm || !adm.id) {
        alert('Admin session expired. Please sign in again.');
        return;
    }
    if (!q) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Enter the doctor 12-digit portal user ID or email, then click Look up doctor.';
        }
        return;
    }
    if (msgEl) {
        msgEl.style.color = '#64748b';
        msgEl.textContent = 'Looking up doctor…';
    }
    try {
        const res = await fetch(
            '/api/admin/support-ticket/doctor-lookup?actingAdminId=' +
                encodeURIComponent(adm.id) +
                '&q=' +
                encodeURIComponent(q)
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.doctor) {
            if (msgEl) {
                msgEl.style.color = '#b91c1c';
                msgEl.textContent = data.error || 'Doctor not found.';
            }
            return;
        }
        __adminStResolvedDoctor = data.doctor;
        const hid = document.getElementById('admin-st-create-resolved-id');
        if (hid) hid.value = String(data.doctor.id);
        const prev = document.getElementById('admin-st-doctor-preview');
        if (prev) {
            const regs = (data.doctor.registrations || [])
                .map(
                    (r) =>
                        '<li><strong>' +
                        escAdmin(r.seminarTitle || 'Seminar') +
                        '</strong> — App ' +
                        escAdmin(r.applicationNo || '—') +
                        ' · ' +
                        escAdmin(r.status || '') +
                        '</li>'
                )
                .join('');
            prev.innerHTML =
                '<p style="margin:0 0 8px;font-weight:700;color:#1e40af;">Confirm this doctor before creating the ticket</p>' +
                '<p style="margin:4px 0;"><strong>Name:</strong> ' +
                escAdmin(data.doctor.name) +
                '</p>' +
                '<p style="margin:4px 0;"><strong>Portal user ID:</strong> <code>' +
                escAdmin(data.doctor.userIdString) +
                '</code></p>' +
                '<p style="margin:4px 0;"><strong>Email:</strong> ' +
                escAdmin(data.doctor.email) +
                ' · <strong>Phone:</strong> ' +
                escAdmin(data.doctor.phone) +
                '</p>' +
                '<p style="margin:4px 0;font-size:0.82rem;color:#64748b;">Internal account number (database): ' +
                escAdmin(String(data.doctor.id)) +
                '</p>' +
                (regs
                    ? '<p style="margin:10px 0 4px;font-weight:600;">Recent seminar applications</p><ul style="margin:0;padding-left:18px;">' +
                      regs +
                      '</ul>'
                    : '<p style="margin:8px 0 0;color:#64748b;">No seminar applications on file.</p>');
            prev.style.display = 'block';
        }
        if (msgEl) {
            msgEl.style.color = '#059669';
            msgEl.textContent = 'Doctor found. You can create the support ticket now.';
        }
    } catch (e) {
        console.error(e);
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Lookup failed.';
        }
    }
}

async function adminCreateSupportTicketForDoctor() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) {
        alert('Admin session expired. Please sign in again.');
        return;
    }
    const msgEl = document.getElementById('admin-st-create-msg');
    const targetUserRef = ((document.getElementById('admin-st-create-user-id') || {}).value || '').trim();
    const subject = ((document.getElementById('admin-st-create-subject') || {}).value || '').trim();
    const description = ((document.getElementById('admin-st-create-description') || {}).value || '').trim();
    const category = (document.getElementById('admin-st-create-category') || {}).value || 'general';
    if (msgEl) {
        msgEl.style.color = '#64748b';
        msgEl.textContent = '';
    }
    if (!__adminStResolvedDoctor || !__adminStResolvedDoctor.id) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Click Look up doctor first and confirm the details shown.';
        }
        return;
    }
    if (!subject || !description) {
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Subject and message are required.';
        }
        return;
    }
    try {
        const res = await fetch('/api/admin/support-ticket/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actingAdminId: adm.id,
                targetUserRef: targetUserRef || __adminStResolvedDoctor.userIdString,
                category,
                subject,
                description
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (msgEl) {
                msgEl.style.color = '#b91c1c';
                msgEl.textContent = data.error || 'Could not create ticket.';
            }
            return;
        }
        if (msgEl) {
            msgEl.style.color = '#059669';
            msgEl.textContent = 'Ticket created: ' + (data.ticketId || '');
        }
        const descEl = document.getElementById('admin-st-create-description');
        if (descEl) descEl.value = '';
        const subjEl = document.getElementById('admin-st-create-subject');
        if (subjEl) subjEl.value = '';
        const uidEl = document.getElementById('admin-st-create-user-id');
        if (uidEl) uidEl.value = '';
        clearAdminSupportTicketDoctorPreview();
        loadSupportTickets();
    } catch (e) {
        console.error(e);
        if (msgEl) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Network error.';
        }
    }
}

async function loadSupportTickets() {
    try {
        const status = document.getElementById('ticket-status-filter').value;
        const priority = document.getElementById('ticket-priority-filter').value;
        
        let url = '/api/admin/support-tickets';
        const params = [];
        if(status) params.push(`status=${status}`);
        if(priority) params.push(`priority=${priority}`);
        if(params.length > 0) url += '?' + params.join('&');
        
        const res = await fetch(url);
        const tickets = await res.json();
        __supportTicketsCache = Array.isArray(tickets) ? tickets : [];
        renderSupportTicketsTable();
    } catch(err) { console.error(err); }
}

async function viewSupportTicket(ticketId) {
    try {
        const res = await fetch(`/api/support-ticket/${encodeURIComponent(ticketId)}`);
        const ticket = await res.json();
        if (!res.ok) {
            return alert((ticket && ticket.error) || 'Could not load ticket');
        }

        currentViewingTicketId = ticketId;
        
        const infoHtml = `
            <div>
                <p><strong>Ticket ID:</strong> ${ticket.ticket_id}</p>
                <p><strong>Doctor:</strong> ${ticket.first_name} ${ticket.last_name} (${ticket.email})</p>
                <p><strong>Subject:</strong> ${ticket.subject}</p>
                <p><strong>Category:</strong> ${ticket.category}</p>
                <p><strong>Priority:</strong> ${String(ticket.priority || 'medium').toUpperCase()}</p>
                <p><strong>Status:</strong> ${ticket.status}</p>
                ${
                    ticket.expected_response_at
                        ? '<p><strong>Expected response by:</strong> ' +
                          new Date(ticket.expected_response_at).toLocaleString('en-IN', {
                              timeZone: 'Asia/Kolkata',
                              dateStyle: 'medium',
                              timeStyle: 'short'
                          }) +
                          ' IST</p>'
                        : ''
                }
                <p><strong>Description:</strong> ${ticket.description}</p>
            </div>
        `;
        
        document.getElementById('ticket-info').innerHTML = infoHtml;
        
        const messagesHtml = (Array.isArray(ticket.messages) ? ticket.messages : []).map(m => {
            const isAdmin = String(m.sender_type || '').toLowerCase() === 'admin';
            const who = isAdmin ? 'Admin' : escAdmin([m.first_name, m.last_name].filter(Boolean).join(' ') || 'Doctor');
            return `
            <div style="margin-bottom: 10px; padding: 10px; background: ${isAdmin ? '#e0e7ff' : '#f0fdf4'}; border-radius: 4px;">
                <strong>${isAdmin ? '🔵 Admin' : '👤 ' + who}:</strong> ${escAdmin(m.message || '')}
                <br><small style="color: #64748b;">${m.created_at ? new Date(m.created_at).toLocaleString() : ''}</small>
            </div>`;
        }).join('');
        
        document.getElementById('ticket-messages').innerHTML = messagesHtml || '<p style="text-align: center; color: #94a3b8;">No messages yet</p>';
        document.getElementById('ticket-reply-input').value = '';
        document.getElementById('ticket-detail-modal').classList.remove('hidden');
    } catch(err) { console.error(err); alert('Error loading ticket'); }
}

async function updateTicketStatus() {
    const newStatus = document.getElementById('ticket-status-update').value;
    if(!newStatus || !currentViewingTicketId) return;
    const adm = getStoredAdminUser();
    
    try {
        const res = await fetch(`/api/admin/support-ticket/${currentViewingTicketId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, adminId: adm && adm.id ? adm.id : null })
        });
        
        if(res.ok) {
            alert('Ticket status updated');
            document.getElementById('ticket-status-update').value = '';
            loadSupportTickets();
        }
    } catch(err) { console.error(err); }
}

async function updateTicketPriority() {
    const newPriority = document.getElementById('ticket-priority-update').value;
    if(!newPriority || !currentViewingTicketId) return;
    
    try {
        const res = await fetch(`/api/admin/support-ticket/${currentViewingTicketId}/priority`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: newPriority })
        });
        
        if(res.ok) {
            alert('Ticket priority updated');
            document.getElementById('ticket-priority-update').value = '';
            loadSupportTickets();
        }
    } catch(err) { console.error(err); }
}

async function submitTicketReply() {
    const message = document.getElementById('ticket-reply-input').value;
    if(!message || !currentViewingTicketId) return;
    const adm = getStoredAdminUser();
    
    try {
        const res = await fetch(`/api/support-ticket/${currentViewingTicketId}/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderId: adm && adm.id ? adm.id : 1, senderType: 'admin', message: message })
        });
        
        const data = await res.json();
        if (res.ok && data.success) {
            document.getElementById('ticket-reply-input').value = '';
            viewSupportTicket(currentViewingTicketId);
        } else {
            alert((data && data.error) || 'Could not send reply');
        }
    } catch(err) { console.error(err); alert('Network error sending reply'); }
}

// Call loading functions when tab changes
function loadAllData() {
    fetch('/api/public/portal-urls')
        .then((r) => r.json())
        .then((u) => {
            window.__adminProductionSite = !!(u && u.production);
            window.__allowDemoAccounts = u && u.allowDemoAccounts !== false;
            const demoWrap = document.getElementById('newuser-is-demo-wrap');
            if (demoWrap) demoWrap.style.display = window.__allowDemoAccounts ? '' : 'none';
        })
        .catch(() => {
            window.__allowDemoAccounts = true;
        });
    loadAdminPortalYear();
    loadUsers();
    loadApplications();
    loadSettings();
    loadSeminars();
    loadEventSchedules();
    loadFeedbackSeminars();
    loadSupportTickets();
    startAdminAutoRefresh();
    applyCoAdminSidebarVisibility();
}

function downloadParticipantsPdf() {
    if(currentSeminarApps.length === 0) return alert("No applications to download.");
    
    // Assuming jsPDF and autoTable are loaded. (If autoTable is not loaded, we will fallback to a basic text list, but let's try to load it dynamically if needed or just use text for simplicity)
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    // Header
    doc.setFillColor(26, 35, 126);
    doc.rect(0, 0, 210, 30, "F");
    doc.setFontSize(18);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text("Vaidya Gogate Memorial Foundation", 105, 15, { align: "center" });
    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");
    doc.text("Confirmed Participant List", 105, 23, { align: "center" });
    
    doc.setTextColor(0, 0, 0);
    let y = 40;
    doc.text(`Seminar ID: ${currentManageSeminarId}`, 15, y); y+=10;
    doc.text("Application No   |   Name   |   Status", 15, y); y+=10;
    doc.setLineWidth(0.5);
    doc.line(15, y-5, 195, y-5);
    
    doc.setFontSize(10);
    currentSeminarApps.forEach(a => {
        let formData = {};
        try { formData = JSON.parse(a.form_data || '{}'); } catch(e){}
        const name = formData.fname ? `${formData.fname} ${formData.lname || ''}` : `${a.first_name || ''} ${a.last_name || ''}`;
        
        doc.text(`${a.application_no}`, 15, y);
        doc.text(`${name.substring(0,25)}`, 60, y);
        doc.text(`${a.status.toUpperCase()}`, 130, y);
        y+=8;
        
        // Add new page if needed
        if(y > 280) {
            doc.addPage();
            y = 20;
        }
    });

    doc.save(`Participant_List_Seminar_${currentManageSeminarId}.pdf`);
}

let __adminOrdersCache = [];

const ADMIN_REG_FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'checkbox', 'file'];

const ADMIN_QUAL_OPTION_DEFS = [
    { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
    { value: 'Practitioner', label: 'Practitioner' },
    { value: 'PG', label: 'PG' }
];

function renderQualOptionCheckboxes(containerId, selectedValues) {
    const root = document.getElementById(containerId);
    if (!root) return;
    const sel = new Set((selectedValues || []).map((v) => String(v)));
    if (!sel.size) ADMIN_QUAL_OPTION_DEFS.forEach((o) => sel.add(o.value));
    root.innerHTML = ADMIN_QUAL_OPTION_DEFS.map((o) => {
        const id = containerId + '-q-' + o.value.replace(/\s+/g, '-');
        return (
            '<label style="display:inline-flex;align-items:center;gap:6px;"><input type="checkbox" class="qual-opt-cb" data-container="' +
            containerId +
            '" id="' +
            id +
            '" value="' +
            o.value.replace(/"/g, '&quot;') +
            '" ' +
            (sel.has(o.value) ? 'checked' : '') +
            ' onchange="updateSeminarPolicyPreviews()"> ' +
            o.label +
            '</label>'
        );
    }).join('');
}

function collectQualOptionsFromContainer(containerId) {
    const root = document.getElementById(containerId);
    if (!root) return [];
    const out = [];
    root.querySelectorAll('.qual-opt-cb:checked').forEach((cb) => {
        const v = String(cb.value || '').trim();
        if (!v) return;
        const def = ADMIN_QUAL_OPTION_DEFS.find((o) => o.value === v);
        out.push({ value: v, label: def ? def.label : v });
    });
    return out;
}

function adminRegFieldTypeOptions(selected) {
    const sel = String(selected || 'text').toLowerCase();
    return ADMIN_REG_FIELD_TYPES.map(
        (t) => `<option value="${t}"${t === sel ? ' selected' : ''}>${t}</option>`
    ).join('');
}

function adminAddRegistrationFieldRow(prefill) {
    const tbody = document.getElementById('admin-reg-fields-tbody');
    if (!tbody) return;
    const rows = window.__adminRegFieldRows || [];
    const p = prefill || {};
    const idx = rows.length;
    const key = p.key || 'custom_' + Date.now();
    const isNew = !p._existing;
    rows.push({
        key,
        onlyWhenAdvancedQual: !!p.onlyWhenAdvancedQual,
        _existing: true
    });
    window.__adminRegFieldRows = rows;
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td>${isNew ? `<input type="text" id="reg-field-key-${idx}" value="${String(key).replace(/"/g, '&quot;')}" style="margin:0;width:120px;" placeholder="field_key">` : `<code>${String(key).replace(/</g, '&lt;')}</code>`}</td>
        <td><input type="text" id="reg-field-label-${idx}" value="${String(p.label || key).replace(/"/g, '&quot;')}" style="margin:0;"></td>
        <td><select id="reg-field-type-${idx}" style="margin:0;">${adminRegFieldTypeOptions(p.type)}</select></td>
        <td><input type="number" id="reg-field-step-${idx}" min="1" max="9" value="${p.step != null ? p.step : 1}" style="margin:0;width:56px;"></td>
        <td><input type="checkbox" id="reg-field-en-${idx}" ${p.enabled !== false ? 'checked' : ''}></td>
        <td><input type="checkbox" id="reg-field-req-${idx}" ${p.required !== false && p.enabled !== false ? 'checked' : ''}></td>
        <td><button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#64748b;" onclick="adminRemoveRegistrationFieldRow(${idx})">Remove</button></td>`;
    tbody.appendChild(tr);
}

function adminRemoveRegistrationFieldRow(idx) {
    const rows = window.__adminRegFieldRows || [];
    if (idx < 0 || idx >= rows.length) return;
    rows.splice(idx, 1);
    window.__adminRegFieldRows = rows;
    loadAdminRegistrationFormConfig(true);
}

async function loadAdminRegistrationFormConfig(skipFetch) {
    const tbody = document.getElementById('admin-reg-fields-tbody');
    if (!tbody) return;
    if (!skipFetch) {
        tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
    }
    try {
        let fields;
        if (skipFetch && window.__adminRegFieldRowsCache) {
            fields = window.__adminRegFieldRowsCache;
        } else {
            const res = await fetch('/api/registration-form-config');
            const data = await res.json();
            fields = data.fields || [];
            window.__adminRegFieldRowsCache = fields;
            const qual = fields.find((f) => f.key === 'qual');
            renderQualOptionCheckboxes(
                'admin-global-qual-options',
                qual && qual.options ? qual.options.map((o) => o.value) : null
            );
            const bmin = document.getElementById('admin-birth-year-min');
            const bmax = document.getElementById('admin-birth-year-max');
            if (bmin) bmin.value = data.birthYearMin != null ? data.birthYearMin : '';
            if (bmax) bmax.value = data.birthYearMax != null ? data.birthYearMax : '';
        }
        tbody.innerHTML = '';
        window.__adminRegFieldRows = [];
        fields.forEach((f) => adminAddRegistrationFieldRow({ ...f, _existing: true }));
        if (!fields.length) adminAddRegistrationFieldRow({ key: 'custom_field', label: 'Custom field' });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7">Failed to load</td></tr>';
    }
}

async function saveAdminRegistrationFormConfig() {
    const msg = document.getElementById('admin-reg-form-msg');
    if (msg) msg.innerText = '';
    const rows = window.__adminRegFieldRows || [];
    const fields = rows.map((r, idx) => {
        const enabled = !!(document.getElementById(`reg-field-en-${idx}`) || {}).checked;
        const required = enabled && !!(document.getElementById(`reg-field-req-${idx}`) || {}).checked;
        const keyEl = document.getElementById(`reg-field-key-${idx}`);
        const key = keyEl ? String(keyEl.value || '').trim() : r.key;
        const typeEl = document.getElementById(`reg-field-type-${idx}`);
        const stepEl = document.getElementById(`reg-field-step-${idx}`);
        const row = {
            key: key || r.key,
            label: (document.getElementById(`reg-field-label-${idx}`) || {}).value || key || r.key,
            type: typeEl ? typeEl.value : 'text',
            step: stepEl ? parseInt(stepEl.value, 10) || 1 : 1,
            enabled,
            required,
            onlyWhenAdvancedQual:
                typeof r.onlyWhenAdvancedQual === 'boolean'
                    ? r.onlyWhenAdvancedQual
                    : ['ncism', 'certificate'].indexOf(r.key) !== -1,
            onlyWhenPgCollege:
                typeof r.onlyWhenPgCollege === 'boolean'
                    ? r.onlyWhenPgCollege
                    : ['college', 'ccity', 'cstate', 'cpin'].indexOf(row.key) !== -1
        };
        if (row.key === 'qual') {
            const qualOpts = collectQualOptionsFromContainer('admin-global-qual-options');
            if (qualOpts.length) row.options = qualOpts;
        }
        return row;
    });
    const birthYearMin = parseInt((document.getElementById('admin-birth-year-min') || {}).value, 10);
    const birthYearMax = parseInt((document.getElementById('admin-birth-year-max') || {}).value, 10);
    try {
        const res = await fetch('/api/admin/registration-form-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields,
                birthYearMin: Number.isInteger(birthYearMin) ? birthYearMin : null,
                birthYearMax: Number.isInteger(birthYearMax) ? birthYearMax : null
            })
        });
        const data = await res.json();
        if (data.success) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.innerText = 'Registration form saved.';
            }
            window.__adminRegFieldRowsCache = fields;
        } else if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = data.error || 'Save failed';
        }
    } catch (e) {
        console.error(e);
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = 'Network error';
        }
    }
}

let __siteCmsEditing = null;

async function uploadAdminAssetFromInput(fileInputEl, options) {
    if (!window.PortalUpload) {
        alert('Upload helper failed to load. Refresh the page.');
        return options && options.multiple ? [] : null;
    }
    return window.PortalUpload.uploadFromInput(fileInputEl, options);
}

async function cmsUploadBannerImage() {
    const inp = document.getElementById('cms-banner-file');
    const path = await uploadAdminAssetFromInput(inp);
    if (inp) inp.value = '';
    if (path) {
        const t = document.getElementById('cms-banner');
        if (t) t.value = path;
    }
}

async function cmsUploadHeroImage() {
    const inp = document.getElementById('cms-hero-file');
    const path = await uploadAdminAssetFromInput(inp);
    if (inp) inp.value = '';
    if (path) {
        const t = document.getElementById('cms-hero-image');
        if (t) t.value = path;
    }
}

function cmsParseJsonArray(raw, fieldLabel) {
    const s = (raw || '').trim();
    if (!s) return [];
    let v;
    try {
        v = JSON.parse(s);
    } catch (e) {
        throw new Error(`${fieldLabel}: invalid JSON (${e.message})`);
    }
    if (!Array.isArray(v)) throw new Error(`${fieldLabel}: JSON must be an array.`);
    return v;
}

function cmsCollectScrollingAnnouncementsFromDom() {
    const root = document.getElementById('cms-scrolling-announce-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-scroll-row'))
        .map((row) => {
            const o = {
                title: (row.querySelector('.cs-title') || {}).value || '',
                body: (row.querySelector('.cs-body') || {}).value || '',
                date: (row.querySelector('.cs-date') || {}).value || '',
                link: (row.querySelector('.cs-link') || {}).value || '',
                pdf: (row.querySelector('.cs-pdf') || {}).value || '',
                image: (row.querySelector('.cs-img') || {}).value || '',
                priority: (row.querySelector('.cs-priority') || {}).value || '',
                expiresAt: (row.querySelector('.cs-expiry') || {}).value || '',
                enabled: (row.querySelector('.cs-enabled') || {}).checked !== false
            };
            const hid = row.querySelector('.cs-auto-id');
            if (hid && hid.value && String(hid.value).trim() !== '') {
                const n = Number(hid.value);
                o.autoFromSeminarId = Number.isNaN(n) ? hid.value : n;
            }
            Object.keys(o).forEach((k) => {
                if (o[k] === '' || o[k] == null) delete o[k];
            });
            return o;
        })
        .filter((x) => x.title || x.body);
}

function cmsCollectPublicNoticesFromDom() {
    const root = document.getElementById('cms-public-notice-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-notice-row'))
        .map((row) => {
            const o = {
                title: (row.querySelector('.cn-title') || {}).value || '',
                body: (row.querySelector('.cn-body') || {}).value || '',
                date: (row.querySelector('.cn-date') || {}).value || '',
                pdf: (row.querySelector('.cn-pdf') || {}).value || ''
            };
            Object.keys(o).forEach((k) => {
                if (o[k] === '' || o[k] == null) delete o[k];
            });
            return o;
        })
        .filter((x) => x.title || x.body);
}

function cmsCollectDoctorUpdatesFromDom() {
    const root = document.getElementById('cms-doctor-update-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-doc-row'))
        .map((row) => ({
            title: (row.querySelector('.cd-title') || {}).value || '',
            body: (row.querySelector('.cd-body') || {}).value || '',
            at: (row.querySelector('.cd-at') || {}).value || ''
        }))
        .filter((x) => x.title || x.body);
}

function cmsFillScrollingRows(items) {
    const root = document.getElementById('cms-scrolling-announce-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddScrollingRow(it));
}

function cmsFillPublicNoticeRows(items) {
    const root = document.getElementById('cms-public-notice-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddPublicNoticeRow(it));
}

function cmsFillDoctorRows(items) {
    const root = document.getElementById('cms-doctor-update-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddDoctorUpdateRow(it));
}

function cmsGroupGalleryFlat(items) {
    const byYear = new Map();
    (items || []).forEach((g) => {
        const year = String((g && g.year) || '').trim() || 'Archive';
        if (!byYear.has(year)) byYear.set(year, { year, title: '', images: [] });
        const src = String((g && g.src) || '').trim();
        if (!src) return;
        byYear.get(year).images.push({ src, caption: String((g && g.caption) || '').trim() });
    });
    return [...byYear.values()].sort((a, b) => String(b.year).localeCompare(String(a.year)));
}

function cmsCollectGalleryYearsFromDom() {
    const root = document.getElementById('cms-gallery-years');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-gallery-year'))
        .map((yearRow) => {
            const year = ((yearRow.querySelector('.cgy-year') || {}).value || '').trim();
            const title = ((yearRow.querySelector('.cgy-title') || {}).value || '').trim();
            const images = Array.from(yearRow.querySelectorAll('.cgy-image-row'))
                .map((imgRow) => ({
                    src: ((imgRow.querySelector('.cgy-src') || {}).value || '').trim(),
                    caption: ((imgRow.querySelector('.cgy-cap') || {}).value || '').trim()
                }))
                .filter((img) => img.src);
            return { year, title, images };
        })
        .filter((yg) => yg.year && yg.images.length);
}

function cmsFillGalleryYears(yearGroups) {
    const root = document.getElementById('cms-gallery-years');
    if (!root) return;
    root.innerHTML = '';
    (yearGroups || []).forEach((yg) => cmsAddGalleryYear(yg));
}

function cmsAddGalleryYear(prefill) {
    const root = document.getElementById('cms-gallery-years');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-gallery-year';
    wrap.style.cssText =
        'margin-bottom:16px;padding:14px;border:1px solid #cbd5e1;border-radius:12px;background:#f8fafc;';
    wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
          <div><label style="font-size:0.8rem;font-weight:700;">Year</label><input class="cgy-year" type="text" style="width:100%" placeholder="2025"></div>
          <div><label style="font-size:0.8rem;font-weight:700;">Album title (optional)</label><input class="cgy-title" type="text" style="width:100%" placeholder="National Seminar 2025"></div>
        </div>
        <div class="cgy-images"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center;">
          <input type="file" class="cgy-batch-files" accept="image/*" multiple style="max-width:220px;">
          <button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.82rem;" onclick="cmsUploadGalleryYearBatch(this)">Upload multiple images</button>
          <button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.82rem;background:#0d9488;" onclick="cmsAddGalleryImageRow(this)">+ Add image row</button>
          <button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.82rem;background:#64748b;" onclick="this.closest('.cms-gallery-year').remove()">Remove year</button>
        </div>`;
    const yearInp = wrap.querySelector('.cgy-year');
    const titleInp = wrap.querySelector('.cgy-title');
    if (yearInp) yearInp.value = p.year || '';
    if (titleInp) titleInp.value = p.title || '';
    const imagesHost = wrap.querySelector('.cgy-images');
    (p.images || []).forEach((img) => cmsAppendGalleryImageRow(imagesHost, img));
    root.appendChild(wrap);
}

function cmsAppendGalleryImageRow(host, prefill) {
    if (!host) return;
    const img = prefill || {};
    const row = document.createElement('div');
    row.className = 'cgy-image-row';
    row.style.cssText =
        'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;padding:8px;border:1px dashed #e2e8f0;border-radius:8px;background:#fff;';
    row.innerHTML = `
        <div style="grid-column:1/-1;"><label style="font-size:0.78rem;">Caption</label><input class="cgy-cap" type="text" style="width:100%" placeholder="Opening ceremony"></div>
        <div style="grid-column:1/-1;"><label style="font-size:0.78rem;">Image path</label><input class="cgy-src" type="text" style="width:100%" placeholder="/uploads/photo.jpg"></div>
        <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;">
          <input type="file" class="cgy-file" accept="image/*" style="max-width:180px;">
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="cmsUploadGalleryImageRow(this)">Upload</button>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cgy-image-row').remove()">Remove</button>
        </div>`;
    const cap = row.querySelector('.cgy-cap');
    const src = row.querySelector('.cgy-src');
    if (cap) cap.value = img.caption || '';
    if (src) src.value = img.src || '';
    host.appendChild(row);
}

function cmsAddGalleryImageRow(btn) {
    const yearRow = btn.closest('.cms-gallery-year');
    if (!yearRow) return;
    cmsAppendGalleryImageRow(yearRow.querySelector('.cgy-images'), {});
}

async function cmsUploadGalleryImageRow(btn) {
    const row = btn.closest('.cgy-image-row');
    if (!row) return;
    const fileInp = row.querySelector('.cgy-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    if (fileInp) fileInp.value = '';
    const pathEl = row.querySelector('.cgy-src');
    if (path && pathEl) pathEl.value = path;
}

async function cmsUploadGalleryYearBatch(btn) {
    const yearRow = btn.closest('.cms-gallery-year');
    if (!yearRow) return;
    const fileInp = yearRow.querySelector('.cgy-batch-files');
    const paths = await uploadAdminAssetFromInput(fileInp, {
        multiple: true,
        progressBtn: btn,
        progressLabel: 'Upload multiple images'
    });
    if (fileInp) fileInp.value = '';
    if (!paths || !paths.length) return;
    const host = yearRow.querySelector('.cgy-images');
    paths.forEach((path) => cmsAppendGalleryImageRow(host, { src: path, caption: '' }));
}

const CMS_MENU_SECTIONS = [
    { value: 'home', label: 'Home' },
    { value: 'about', label: 'Foundation / About' },
    { value: 'schedule', label: 'Agenda / Schedule' },
    { value: 'gallery', label: 'Gallery' },
    { value: 'verify', label: 'Delegates / Verify' },
    { value: 'contact', label: 'Contact' },
    { value: '', label: 'External page (use URL)' }
];

function cmsCollectMenuFromDom() {
    const root = document.getElementById('cms-menu-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-menu-row'))
        .map((row, idx) => ({
            label: ((row.querySelector('.cm-label') || {}).value || '').trim(),
            section: ((row.querySelector('.cm-section') || {}).value || '').trim(),
            href: ((row.querySelector('.cm-href') || {}).value || '').trim(),
            visible: (row.querySelector('.cm-visible') || {}).checked !== false,
            order: parseInt((row.querySelector('.cm-order') || {}).value, 10) || idx + 1
        }))
        .filter((item) => item.label);
}

function cmsFillMenuRows(items) {
    const root = document.getElementById('cms-menu-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddMenuRow(it));
}

function cmsAddMenuRow(prefill) {
    const root = document.getElementById('cms-menu-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-menu-row';
    wrap.style.cssText =
        'margin-bottom:10px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;display:grid;grid-template-columns:1.2fr 1fr 1fr 80px 70px;gap:8px;align-items:end;';
    const sectionOpts = CMS_MENU_SECTIONS.map(
        (s) =>
            `<option value="${s.value.replace(/"/g, '&quot;')}">${s.label}</option>`
    ).join('');
    wrap.innerHTML = `
        <div><label style="font-size:0.78rem;">Label</label><input class="cm-label" type="text" style="width:100%" placeholder="Gallery"></div>
        <div><label style="font-size:0.78rem;">Section</label><select class="cm-section" style="width:100%">${sectionOpts}</select></div>
        <div><label style="font-size:0.78rem;">URL (external)</label><input class="cm-href" type="text" style="width:100%" placeholder="/verify-certificate.html"></div>
        <div><label style="font-size:0.78rem;">Order</label><input class="cm-order" type="number" min="1" style="width:100%" value="1"></div>
        <div><label style="font-size:0.78rem;display:flex;align-items:center;gap:6px;padding-bottom:8px;"><input class="cm-visible" type="checkbox" checked> Show</label>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.78rem;background:#64748b;width:100%;" onclick="this.closest('.cms-menu-row').remove()">Remove</button></div>`;
    const label = wrap.querySelector('.cm-label');
    const section = wrap.querySelector('.cm-section');
    const href = wrap.querySelector('.cm-href');
    const order = wrap.querySelector('.cm-order');
    const visible = wrap.querySelector('.cm-visible');
    if (label) label.value = p.label || '';
    if (section) section.value = p.section || '';
    if (href) href.value = p.href || '';
    if (order) order.value = String(p.order != null ? p.order : root.querySelectorAll('.cms-menu-row').length);
    if (visible) visible.checked = p.visible !== false;
    root.appendChild(wrap);
}

function cmsAddScrollingRow(prefill) {
    const root = document.getElementById('cms-scrolling-announce-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-scroll-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    const autoId = p.autoFromSeminarId != null ? String(p.autoFromSeminarId) : '';
    wrap.innerHTML = `
        <input type="hidden" class="cs-auto-id" value="">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div><label style="font-size:0.8rem;">Title</label><input class="cs-title" type="text" style="width:100%" placeholder="Headline"></div>
          <div><label style="font-size:0.8rem;">Date</label><input class="cs-date" type="text" style="width:100%" placeholder="2026-05-01"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;">
          <div><label style="font-size:0.8rem;">Priority</label><input class="cs-priority" type="number" style="width:100%" placeholder="10"></div>
          <div><label style="font-size:0.8rem;">Expires</label><input class="cs-expiry" type="date" style="width:100%"></div>
          <div style="display:flex;align-items:flex-end;padding-bottom:6px;"><label style="font-size:0.8rem;"><input class="cs-enabled" type="checkbox" checked> Enabled</label></div>
        </div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Body</label><textarea class="cs-body" rows="2" style="width:100%" placeholder="Details"></textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
          <div><label style="font-size:0.8rem;">Link</label><input class="cs-link" type="text" style="width:100%" placeholder="https://..."></div>
          <div><label style="font-size:0.8rem;">Image path</label><input class="cs-img" type="text" style="width:100%" placeholder="/uploads/b.jpg"></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;align-items:flex-end;">
          <div style="flex:1;min-width:160px;"><label style="font-size:0.8rem;">PDF path</label><input class="cs-pdf" type="text" style="width:100%" placeholder="/uploads/n.pdf"></div>
          <input type="file" class="cs-pdf-file" accept=".pdf,application/pdf" style="max-width:150px;">
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="cmsUploadRowPdf(this,'.cs-pdf')">Upload PDF</button>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-scroll-row').remove()">Remove</button>
        </div>
    `;
    wrap.querySelector('.cs-auto-id').value = autoId;
    if (autoId) {
        const hint = document.createElement('p');
        hint.style.cssText = 'margin:8px 0 0;font-size:0.75rem;color:#64748b;';
        hint.textContent = 'Auto-synced from seminar #' + autoId;
        wrap.appendChild(hint);
    }
    const t = wrap.querySelector('.cs-title');
    const b = wrap.querySelector('.cs-body');
    const d = wrap.querySelector('.cs-date');
    const l = wrap.querySelector('.cs-link');
    const pdf = wrap.querySelector('.cs-pdf');
    const im = wrap.querySelector('.cs-img');
    if (t) t.value = p.title || '';
    if (b) b.value = p.body || '';
    if (d) d.value = p.date || '';
    if (l) l.value = p.link || '';
    if (pdf) pdf.value = p.pdf || '';
    if (im) im.value = p.image || '';
    const pr = wrap.querySelector('.cs-priority');
    const ex = wrap.querySelector('.cs-expiry');
    const en = wrap.querySelector('.cs-enabled');
    if (pr) pr.value = p.priority != null ? String(p.priority) : '';
    if (ex) ex.value = (p.expiresAt || p.expiry || '').toString().slice(0, 10);
    if (en) en.checked = p.enabled !== false && p.enabled !== 0 && String(p.enabled).toLowerCase() !== 'false';
    root.appendChild(wrap);
}

function cmsAddPublicNoticeRow(prefill) {
    const root = document.getElementById('cms-public-notice-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-notice-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div><label style="font-size:0.8rem;">Title</label><input class="cn-title" type="text" style="width:100%"></div>
          <div><label style="font-size:0.8rem;">Date</label><input class="cn-date" type="text" style="width:100%" placeholder="2026-05-01"></div>
        </div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Description</label><textarea class="cn-body" rows="2" style="width:100%"></textarea></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;align-items:flex-end;">
          <div style="flex:1;min-width:180px;"><label style="font-size:0.8rem;">PDF path (optional)</label><input class="cn-pdf" type="text" style="width:100%" placeholder="/uploads/notice.pdf"></div>
          <input type="file" class="cn-pdf-file" accept=".pdf,application/pdf" style="max-width:150px;">
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="cmsUploadRowPdf(this,'.cn-pdf')">Upload PDF</button>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-notice-row').remove()">Remove</button>
        </div>
    `;
    const t = wrap.querySelector('.cn-title');
    const b = wrap.querySelector('.cn-body');
    const d = wrap.querySelector('.cn-date');
    const pdf = wrap.querySelector('.cn-pdf');
    if (t) t.value = p.title || '';
    if (b) b.value = p.body || '';
    if (d) d.value = p.date || '';
    if (pdf) pdf.value = p.pdf || '';
    root.appendChild(wrap);
}

function cmsAddDoctorUpdateRow(prefill) {
    const root = document.getElementById('cms-doctor-update-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-doc-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div><label style="font-size:0.8rem;">Title</label><input class="cd-title" type="text" style="width:100%"></div>
          <div><label style="font-size:0.8rem;">At (label)</label><input class="cd-at" type="text" style="width:100%" placeholder="May 2026"></div>
        </div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Body</label><textarea class="cd-body" rows="2" style="width:100%"></textarea></div>
        <div style="margin-top:8px;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-doc-row').remove()">Remove</button></div>
    `;
    const t = wrap.querySelector('.cd-title');
    const b = wrap.querySelector('.cd-body');
    const a = wrap.querySelector('.cd-at');
    if (t) t.value = p.title || '';
    if (b) b.value = p.body || '';
        if (a) a.value = p.at || '';
    root.appendChild(wrap);
}

function cmsAddAboutRow(prefill) {
    const root = document.getElementById('cms-about-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-about-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    wrap.innerHTML = `
        <div><label style="font-size:0.8rem;">Heading</label><input class="ca-heading" type="text" style="width:100%" placeholder="About our foundation"></div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Body</label><textarea class="ca-body" rows="3" style="width:100%"></textarea></div>
        <div style="margin-top:8px;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-about-row').remove()">Remove</button></div>`;
    wrap.className = 'cms-about-row';
    wrap.querySelector('.ca-heading').value = p.heading || '';
    wrap.querySelector('.ca-body').value = p.body || '';
    root.appendChild(wrap);
}

function cmsCollectAboutFromDom() {
    const root = document.getElementById('cms-about-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-about-row'))
        .map((row) => ({
            heading: (row.querySelector('.ca-heading') || {}).value || '',
            body: (row.querySelector('.ca-body') || {}).value || ''
        }))
        .filter((x) => x.heading || x.body);
}

function cmsFillAboutRows(items) {
    const root = document.getElementById('cms-about-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddAboutRow(it));
}

function cmsAddSocialRow(prefill) {
    const root = document.getElementById('cms-social-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-social-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;';
    wrap.innerHTML = `
        <div><label style="font-size:0.8rem;">Platform</label><select class="cs-platform" style="width:100%"><option value="youtube">youtube</option><option value="facebook">facebook</option><option value="instagram">instagram</option><option value="twitter">twitter</option><option value="linkedin">linkedin</option><option value="whatsapp">whatsapp</option><option value="link">link</option></select></div>
        <div><label style="font-size:0.8rem;">Label</label><input class="cs-label" type="text" style="width:100%"></div>
        <div><label style="font-size:0.8rem;">URL</label><input class="cs-url" type="url" style="width:100%"></div>
        <div style="grid-column:1/-1;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-social-row').remove()">Remove</button></div>`;
    const plat = wrap.querySelector('.cs-platform');
    if (plat) plat.value = p.platform || 'link';
    wrap.querySelector('.cs-label').value = p.label || '';
    wrap.querySelector('.cs-url').value = p.url || '';
    root.appendChild(wrap);
}

function cmsCollectSocialFromDom() {
    const root = document.getElementById('cms-social-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-social-row'))
        .map((row) => ({
            platform: (row.querySelector('.cs-platform') || {}).value || 'link',
            label: (row.querySelector('.cs-label') || {}).value || '',
            url: (row.querySelector('.cs-url') || {}).value || ''
        }))
        .filter((x) => x.url);
}

function cmsFillSocialRows(items) {
    const root = document.getElementById('cms-social-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddSocialRow(it));
}

function cmsAddReviewRow(prefill) {
    const root = document.getElementById('cms-review-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-review-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    wrap.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr 80px;gap:8px;">
          <div><label style="font-size:0.8rem;">Name</label><input class="cr-name" type="text" style="width:100%"></div>
          <div><label style="font-size:0.8rem;">Role</label><input class="cr-role" type="text" style="width:100%"></div>
          <div><label style="font-size:0.8rem;">Rating</label><input class="cr-rating" type="number" min="1" max="5" value="5" style="width:100%"></div>
        </div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Quote</label><textarea class="cr-text" rows="2" style="width:100%"></textarea></div>
        <div style="margin-top:8px;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-review-row').remove()">Remove</button></div>`;
    wrap.querySelector('.cr-name').value = p.name || '';
    wrap.querySelector('.cr-role').value = p.role || '';
    wrap.querySelector('.cr-text').value = p.text || '';
    const rt = wrap.querySelector('.cr-rating');
    if (rt) rt.value = p.rating != null ? p.rating : 5;
    root.appendChild(wrap);
}

function cmsCollectReviewsFromDom() {
    const root = document.getElementById('cms-review-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-review-row'))
        .map((row) => ({
            name: (row.querySelector('.cr-name') || {}).value || '',
            role: (row.querySelector('.cr-role') || {}).value || '',
            text: (row.querySelector('.cr-text') || {}).value || '',
            rating: parseInt((row.querySelector('.cr-rating') || {}).value, 10) || 5
        }))
        .filter((x) => x.name || x.text);
}

function cmsFillReviewRows(items) {
    const root = document.getElementById('cms-review-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddReviewRow(it));
}

async function cmsUploadRowPdf(btn, pathSelector) {
    const row = btn.closest('.cms-scroll-row') || btn.closest('.cms-notice-row');
    if (!row) return;
    const fileInp = row.querySelector('.cs-pdf-file') || row.querySelector('.cn-pdf-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    if (fileInp) fileInp.value = '';
    const pathEl = row.querySelector(pathSelector);
    if (path && pathEl) pathEl.value = path;
}

function cmsCollectSpeakersFromDom() {
    const root = document.getElementById('cms-speaker-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-speaker-row'))
        .map((row) => ({
            name: (row.querySelector('.csp-name') || {}).value || '',
            role: (row.querySelector('.csp-role') || {}).value || '',
            seminar: (row.querySelector('.csp-seminar') || {}).value || '',
            org: (row.querySelector('.csp-org') || {}).value || '',
            image: (row.querySelector('.csp-image') || {}).value || ''
        }))
        .filter((x) => x.name || x.image);
}

function cmsFillSpeakerRows(items) {
    const root = document.getElementById('cms-speaker-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddSpeakerRow(it));
}

function cmsAddSpeakerRow(prefill) {
    const root = document.getElementById('cms-speaker-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-speaker-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    wrap.innerHTML = `
        <div style="grid-column:1/-1;"><label style="font-size:0.8rem;">Full name</label><input class="csp-name" type="text" style="width:100%"></div>
        <div><label style="font-size:0.8rem;">Designation / topic</label><input class="csp-role" type="text" style="width:100%" placeholder="Keynote speaker"></div>
        <div><label style="font-size:0.8rem;">Seminar (title)</label><input class="csp-seminar" type="text" style="width:100%" placeholder="National Seminar 2026"></div>
        <div><label style="font-size:0.8rem;">Institution (optional)</label><input class="csp-org" type="text" style="width:100%"></div>
        <div style="grid-column:1/-1;"><label style="font-size:0.8rem;">Photo path</label><input class="csp-image" type="text" style="width:100%" placeholder="/uploads/speaker.jpg or /api/assets/..."></div>
        <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="file" class="csp-file" accept="image/*" style="max-width:180px;">
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="cmsUploadSpeakerImage(this)">Upload photo</button>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-speaker-row').remove()">Remove</button>
        </div>`;
    const n = wrap.querySelector('.csp-name');
    const r = wrap.querySelector('.csp-role');
    const sem = wrap.querySelector('.csp-seminar');
    const o = wrap.querySelector('.csp-org');
    const img = wrap.querySelector('.csp-image');
    if (n) n.value = p.name || '';
    if (r) r.value = p.role || '';
    if (sem) sem.value = p.seminar || p.seminarTitle || '';
    if (o) o.value = p.org || '';
    if (img) img.value = p.image || p.imagePath || '';
    root.appendChild(wrap);
}

async function cmsUploadSpeakerImage(btn) {
    const row = btn.closest('.cms-speaker-row');
    if (!row) return;
    const fileInp = row.querySelector('.csp-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    if (fileInp) fileInp.value = '';
    const pathEl = row.querySelector('.csp-image');
    if (path && pathEl) pathEl.value = path;
}

function cmsCollectFeatureCardsFromDom() {
    const root = document.getElementById('cms-feature-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-feature-row'))
        .map((row) => ({
            icon: (row.querySelector('.cf-icon') || {}).value || 'fa-star',
            title: (row.querySelector('.cf-title') || {}).value || '',
            text: (row.querySelector('.cf-text') || {}).value || ''
        }))
        .filter((x) => x.title || x.text);
}

function cmsFillFeatureRows(items) {
    const root = document.getElementById('cms-feature-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddFeatureRow(it));
}

function cmsAddFeatureRow(prefill) {
    const root = document.getElementById('cms-feature-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-feature-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;display:grid;grid-template-columns:1fr 2fr;gap:8px;';
    wrap.innerHTML = `
        <div><label style="font-size:0.8rem;">Icon (Font Awesome class)</label><input class="cf-icon" type="text" style="width:100%" placeholder="fa-microphone-alt"></div>
        <div><label style="font-size:0.8rem;">Title</label><input class="cf-title" type="text" style="width:100%"></div>
        <div style="grid-column:1/-1;"><label style="font-size:0.8rem;">Description</label><input class="cf-text" type="text" style="width:100%"></div>
        <div style="grid-column:1/-1;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-feature-row').remove()">Remove</button></div>`;
    const ic = wrap.querySelector('.cf-icon');
    const t = wrap.querySelector('.cf-title');
    const tx = wrap.querySelector('.cf-text');
    if (ic) ic.value = p.icon || '';
    if (t) t.value = p.title || '';
    if (tx) tx.value = p.text || '';
    root.appendChild(wrap);
}

function cmsCollectFaqFromDom() {
    const root = document.getElementById('cms-faq-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-faq-row'))
        .map((row) => ({
            q: (row.querySelector('.cfq-q') || {}).value || '',
            a: (row.querySelector('.cfq-a') || {}).value || ''
        }))
        .filter((x) => x.q || x.a);
}

function cmsFillFaqRows(items) {
    const root = document.getElementById('cms-faq-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddFaqRow(it));
}

function cmsAddFaqRow(prefill) {
    const root = document.getElementById('cms-faq-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-faq-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;';
    wrap.innerHTML = `
        <div><label style="font-size:0.8rem;">Question</label><input class="cfq-q" type="text" style="width:100%"></div>
        <div style="margin-top:6px;"><label style="font-size:0.8rem;">Answer</label><textarea class="cfq-a" rows="2" style="width:100%"></textarea></div>
        <div style="margin-top:8px;"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-faq-row').remove()">Remove</button></div>`;
    const q = wrap.querySelector('.cfq-q');
    const a = wrap.querySelector('.cfq-a');
    if (q) q.value = p.q || '';
    if (a) a.value = p.a || '';
    root.appendChild(wrap);
}

function cmsFillFooterLinkRows(foot) {
    const exploreWrap = document.getElementById('cms-footer-explore-rows');
    const doctorWrap = document.getElementById('cms-footer-doctor-rows');
    if (!exploreWrap || !doctorWrap) return;
    const explore = (foot && foot.exploreLinks) || [];
    const doctor = (foot && foot.doctorLinks) || [];
    exploreWrap.innerHTML = '';
    doctorWrap.innerHTML = '';
    explore.forEach((l) => cmsAddFooterExploreRow(l));
    doctor.forEach((l) => cmsAddFooterDoctorRow(l));
    if (!explore.length) cmsAddFooterExploreRow();
    if (!doctor.length) cmsAddFooterDoctorRow();
}

function cmsAddFooterExploreRow(prefill) {
    const wrap = document.getElementById('cms-footer-explore-rows');
    if (!wrap) return;
    const row = document.createElement('div');
    row.className = 'cms-footer-link-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 140px;gap:8px;margin-bottom:8px;';
    row.innerHTML =
        '<input type="text" class="cms-fexpl-label" placeholder="Label" style="width:100%;">' +
        '<input type="text" class="cms-fexpl-section" placeholder="Section key" style="width:100%;">';
    if (prefill) {
        row.querySelector('.cms-fexpl-label').value = prefill.label || '';
        row.querySelector('.cms-fexpl-section').value = prefill.section || '';
    }
    wrap.appendChild(row);
}

function cmsAddFooterDoctorRow(prefill) {
    const wrap = document.getElementById('cms-footer-doctor-rows');
    if (!wrap) return;
    const row = document.createElement('div');
    row.className = 'cms-footer-link-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 120px;gap:8px;margin-bottom:8px;';
    row.innerHTML =
        '<input type="text" class="cms-fdoc-label" placeholder="Label" style="width:100%;">' +
        '<select class="cms-fdoc-action" style="width:100%;"><option value="login">login</option><option value="signup">signup</option></select>';
    if (prefill) {
        row.querySelector('.cms-fdoc-label').value = prefill.label || '';
        row.querySelector('.cms-fdoc-action').value = prefill.action || 'login';
    }
    wrap.appendChild(row);
}

function cmsCollectFooterExploreLinks() {
    const rows = document.querySelectorAll('#cms-footer-explore-rows .cms-footer-link-row');
    return Array.from(rows)
        .map((row) => ({
            label: (row.querySelector('.cms-fexpl-label') || {}).value || '',
            section: (row.querySelector('.cms-fexpl-section') || {}).value || ''
        }))
        .filter((l) => l.label.trim());
}

function cmsCollectFooterDoctorLinks() {
    const rows = document.querySelectorAll('#cms-footer-doctor-rows .cms-footer-link-row');
    return Array.from(rows)
        .map((row) => ({
            label: (row.querySelector('.cms-fdoc-label') || {}).value || '',
            action: (row.querySelector('.cms-fdoc-action') || {}).value || 'login'
        }))
        .filter((l) => l.label.trim());
}

function cmsApplyHeroFieldsToForm(cms) {
    const hero = cms.hero || {};
    const top = cms.topBar || {};
    const contact = cms.contact || {};
    const sched = cms.schedulePage || {};
    const foot = cms.footer || {};
    const stats = Array.isArray(cms.heroStats) ? cms.heroStats : [];
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v != null ? String(v) : '';
    };
    set('cms-hero-eyebrow', hero.eyebrow);
    set('cms-hero-title', hero.title);
    set('cms-hero-subtitle', hero.subtitle);
    set('cms-hero-venue', hero.venue);
    set('cms-hero-image', hero.image);
    set('cms-hero-cta1', hero.ctaPrimary);
    set('cms-hero-cta2', hero.ctaSecondary);
    set('cms-top-email', top.email);
    set('cms-top-phone', top.phone);
    set('cms-top-date', top.dateLine);
    set('cms-stat1-val', stats[0] && stats[0].value);
    set('cms-stat1-lbl', stats[0] && stats[0].label);
    set('cms-stat2-val', stats[1] && stats[1].value);
    set('cms-stat2-lbl', stats[1] && stats[1].label);
    set('cms-stat3-val', stats[2] && stats[2].value);
    set('cms-stat3-lbl', stats[2] && stats[2].label);
    set('cms-schedule-title', sched.title);
    set('cms-schedule-subtitle', sched.subtitle);
    set('cms-contact-address', contact.address);
    set('cms-contact-phone', contact.phone);
    set('cms-contact-email', contact.email);
    set('cms-contact-hours', contact.hours);
    set('cms-footer-tagline', foot.tagline);
    set('cms-footer-copy', foot.copyright);
    set('cms-footer-explore-title', foot.exploreTitle);
    set('cms-footer-doctor-title', foot.doctorTitle);
    set('cms-footer-contact-title', foot.contactTitle);
    set('cms-footer-credit', foot.creditHtml);
    cmsFillFooterLinkRows(foot);
}

function cmsCollectHeroFieldsFromForm() {
    const gv = (id) => (document.getElementById(id) || {}).value || '';
    return {
        topBar: {
            email: gv('cms-top-email'),
            phone: gv('cms-top-phone'),
            dateLine: gv('cms-top-date')
        },
        hero: {
            eyebrow: gv('cms-hero-eyebrow'),
            title: gv('cms-hero-title'),
            subtitle: gv('cms-hero-subtitle'),
            venue: gv('cms-hero-venue'),
            image: gv('cms-hero-image'),
            ctaPrimary: gv('cms-hero-cta1'),
            ctaSecondary: gv('cms-hero-cta2')
        },
        heroStats: [
            { value: gv('cms-stat1-val'), label: gv('cms-stat1-lbl') },
            { value: gv('cms-stat2-val'), label: gv('cms-stat2-lbl') },
            { value: gv('cms-stat3-val'), label: gv('cms-stat3-lbl') }
        ].filter((s) => s.value || s.label),
        schedulePage: {
            title: gv('cms-schedule-title'),
            subtitle: gv('cms-schedule-subtitle')
        },
        contact: {
            address: gv('cms-contact-address'),
            phone: gv('cms-contact-phone'),
            email: gv('cms-contact-email'),
            hours: gv('cms-contact-hours')
        },
        footer: {
            tagline: gv('cms-footer-tagline'),
            copyright: gv('cms-footer-copy'),
            exploreTitle: gv('cms-footer-explore-title'),
            doctorTitle: gv('cms-footer-doctor-title'),
            contactTitle: gv('cms-footer-contact-title'),
            creditHtml: gv('cms-footer-credit'),
            exploreLinks: cmsCollectFooterExploreLinks(),
            doctorLinks: cmsCollectFooterDoctorLinks()
        },
        featureCards: cmsCollectFeatureCardsFromDom(),
        faq: cmsCollectFaqFromDom()
    };
}

async function loadSupportTicketSlaAdminForm() {
    const adm = getStoredAdminUser();
    const def = document.getElementById('sts-default-hours');
    if (!def || !adm || !adm.id) return;
    try {
        const res = await fetch(
            '/api/admin/support-ticket-config?actingAdminId=' + encodeURIComponent(adm.id)
        );
        const d = await res.json();
        if (!d.success || !d.config) return;
        def.value = String(d.config.defaultResponseHours || 24);
        const by = d.config.byCategory || {};
        const set = (id, key) => {
            const el = document.getElementById(id);
            if (el && by[key] != null) el.value = String(by[key]);
        };
        set('sts-cat-general', 'general');
        set('sts-cat-registration', 'registration');
        set('sts-cat-payment', 'payment');
        set('sts-cat-technical', 'technical');
    } catch (_) {}
}

async function saveSupportTicketSlaConfig() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('sts-save-msg');
    if (!adm || !adm.id) return;
    const num = (id) => {
        const v = parseInt((document.getElementById(id) || {}).value, 10);
        return Number.isFinite(v) && v > 0 ? v : null;
    };
    const config = {
        defaultResponseHours: num('sts-default-hours') || 24,
        byCategory: {}
    };
    ['general', 'registration', 'payment', 'technical'].forEach((cat) => {
        const h = num('sts-cat-' + cat);
        if (h) config.byCategory[cat] = h;
    });
    try {
        const res = await fetch('/api/admin/support-ticket-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, config })
        });
        const d = await res.json();
        if (msg) {
            msg.style.color = d.success ? '#15803d' : '#b91c1c';
            msg.textContent = d.success ? 'Support SLA saved.' : d.error || 'Save failed';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error';
        }
    }
}

async function adminPriorityInviteDoctor() {
    const programId = parseInt((document.getElementById('case-priority-program') || {}).value, 10);
    const userRef = String((document.getElementById('case-priority-user') || {}).value || '').trim();
    const category = (document.getElementById('case-priority-category') || {}).value || 'agnikarma';
    const msgEl = document.getElementById('case-priority-msg');
    const adm = getStoredAdminUser();
    if (!programId) return alert('Select a case program');
    if (!userRef) return alert('Enter doctor portal ID or email');
    if (!adm || !adm.id) return alert('Admin session required');
    if (msgEl) msgEl.textContent = 'Creating…';
    try {
        const res = await fetch('/api/admin/case/programs/' + programId + '/priority-invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userRef, category, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) {
            if (msgEl) {
                msgEl.style.color = '#b91c1c';
                msgEl.textContent = data.error || 'Failed';
            }
            return alert(data.error || 'Failed');
        }
        if (msgEl) {
            msgEl.style.color = '#15803d';
            msgEl.textContent = data.message + ' App ' + (data.applicationNo || data.submissionId);
        }
        loadAdminCaseSubmissions();
    } catch (e) {
        console.error(e);
        if (msgEl) msgEl.textContent = 'Network error';
    }
}

async function loadDesignatedNotifyAdminForm() {
    const adm = getStoredAdminUser();
    const em = document.getElementById('dn-emails');
    const ph = document.getElementById('dn-phones');
    if (!em || !ph || !adm || !adm.id) return;
    try {
        const res = await fetch(
            `/api/admin/designated-notify-config?actingAdminId=${encodeURIComponent(adm.id)}`
        );
        const d = await res.json();
        if (!d.success || !d.config) return;
        em.value = (d.config.emails || []).join('\n');
        ph.value = (d.config.phones || []).join('\n');
    } catch (_) {}
}

function cmsApplySeoFieldsToForm(seo) {
    const s = seo || {};
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val != null ? String(val) : '';
    };
    set('seo-title', s.title);
    set('seo-description', s.description);
    set('seo-keywords', s.keywords);
    set('seo-canonical', s.canonicalUrl);
    set('seo-og-image', s.ogImage);
    set('seo-google-verify', s.googleSiteVerification);
    set('seo-bing-verify', s.bingSiteVerification);
    set('seo-favicon', s.faviconUrl || '/favicon.svg');
    const ri = document.getElementById('seo-robots-index');
    if (ri) ri.checked = s.robotsIndex !== false;
}

function cmsCollectSeoFieldsFromForm() {
    const gv = (id) => ((document.getElementById(id) || {}).value || '').trim();
    const ri = document.getElementById('seo-robots-index');
    return {
        title: gv('seo-title'),
        description: gv('seo-description'),
        keywords: gv('seo-keywords'),
        canonicalUrl: gv('seo-canonical'),
        ogImage: gv('seo-og-image'),
        googleSiteVerification: gv('seo-google-verify'),
        bingSiteVerification: gv('seo-bing-verify'),
        faviconUrl: gv('seo-favicon') || '/favicon.svg',
        robotsIndex: ri ? !!ri.checked : true
    };
}

async function loadNotificationDeliveryAdminForm() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return;
    try {
        const res = await fetch(
            `/api/admin/notification-delivery-config?actingAdminId=${encodeURIComponent(adm.id)}`
        );
        const d = await res.json();
        if (!d.success || !d.config) return;
        const c = d.config;
        const setChk = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setChk('ed-pos-skip-email', c.posSkipParticipantEmail);
        setChk('ed-pos-skip-staff', c.posSkipStaffAlerts);
        setChk('ed-queue-all', c.queueAllEmails);
        const mh = document.getElementById('ed-max-hour');
        if (mh) mh.value = c.emailMaxPerHour != null ? c.emailMaxPerHour : 80;
        const mg = document.getElementById('ed-min-gap');
        if (mg) mg.value = c.emailMinGapMs != null ? c.emailMinGapMs : 2500;
        const dm = document.getElementById('ed-defer-min');
        if (dm) dm.value = c.deferMinutesOnRateLimit != null ? c.deferMinutesOnRateLimit : 45;
    } catch (_) {}
}

async function saveNotificationDeliveryConfig() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('ed-save-msg');
    if (!adm || !adm.id) return;
    const gv = (id) => !!(document.getElementById(id) || {}).checked;
    const config = {
        posSkipParticipantEmail: gv('ed-pos-skip-email'),
        posSkipStaffAlerts: gv('ed-pos-skip-staff'),
        queueAllEmails: gv('ed-queue-all'),
        emailMaxPerHour: parseInt((document.getElementById('ed-max-hour') || {}).value, 10) || 80,
        emailMinGapMs: parseInt((document.getElementById('ed-min-gap') || {}).value, 10) || 2500,
        deferMinutesOnRateLimit: parseInt((document.getElementById('ed-defer-min') || {}).value, 10) || 45
    };
    try {
        const res = await fetch('/api/admin/notification-delivery-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, config })
        });
        const data = await res.json();
        if (msg) {
            msg.style.color = data.success ? '#15803d' : '#b91c1c';
            msg.textContent = data.success ? 'Email delivery policy saved.' : data.error || 'Save failed.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error.';
        }
    }
}

function themeColorInput(id, theme, key) {
    const el = document.getElementById(id);
    if (!el || !theme) return;
    const v = theme[key];
    if (v && /^#[0-9a-f]{3,8}$/i.test(v)) el.value = v;
}

async function loadPortalThemesAdminForm() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return;
    try {
        const res = await fetch(`/api/admin/portal-themes?actingAdminId=${encodeURIComponent(adm.id)}`);
        const d = await res.json();
        if (!d.success || !d.themes) return;
        themeColorInput('pt-public-primary', d.themes.public, 'primary');
        themeColorInput('pt-public-accent', d.themes.public, 'accent');
        themeColorInput('pt-doctor-primary', d.themes.doctor, 'primary');
        themeColorInput('pt-doctor-accent', d.themes.doctor, 'accent');
        themeColorInput('pt-judge-primary', d.themes.judge, 'primary');
        themeColorInput('pt-judge-accent', d.themes.judge, 'accent');
    } catch (_) {}
}

async function savePortalThemesAdmin() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('pt-save-msg');
    if (!adm || !adm.id) return;
    const pick = (id) => (document.getElementById(id) || {}).value || '';
    const themes = {
        public: { primary: pick('pt-public-primary'), accent: pick('pt-public-accent') },
        doctor: { primary: pick('pt-doctor-primary'), accent: pick('pt-doctor-accent'), sidebar: pick('pt-doctor-primary') },
        judge: { primary: pick('pt-judge-primary'), accent: pick('pt-judge-accent'), primaryMid: pick('pt-judge-primary') }
    };
    try {
        const res = await fetch('/api/admin/portal-themes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, themes })
        });
        const data = await res.json();
        if (msg) {
            msg.style.color = data.success ? '#15803d' : '#b91c1c';
            msg.textContent = data.success ? 'Portal themes saved.' : data.error || 'Save failed.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error.';
        }
    }
}

async function loadPendingReminderAdminForm() {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return;
    try {
        const res = await fetch(
            `/api/admin/pending-registration-reminder-config?actingAdminId=${encodeURIComponent(adm.id)}`
        );
        const d = await res.json();
        if (!d.success || !d.config) return;
        const c = d.config;
        const en = document.getElementById('pr-enabled');
        if (en) en.checked = !!c.enabled;
        const id = document.getElementById('pr-interval-days');
        if (id) id.value = c.intervalDays || 3;
        const mx = document.getElementById('pr-max-reminders');
        if (mx) mx.value = c.maxReminders || 5;
        const rd = document.getElementById('pr-require-docs');
        if (rd) rd.checked = c.requireMissingDocuments !== false;
        const st = document.getElementById('pr-statuses');
        if (st && Array.isArray(c.statuses)) st.value = c.statuses.join(',');
        const ch = c.channels || {};
        const ce = document.getElementById('pr-ch-email');
        if (ce) ce.checked = ch.email !== false;
        const cw = document.getElementById('pr-ch-wa');
        if (cw) cw.checked = ch.whatsapp !== false;
    } catch (_) {}
}

async function savePendingReminderAdminConfig() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('pr-save-msg');
    if (!adm || !adm.id) return;
    const statuses = String((document.getElementById('pr-statuses') || {}).value || '')
        .split(/[,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const config = {
        enabled: !!(document.getElementById('pr-enabled') || {}).checked,
        intervalDays: parseInt((document.getElementById('pr-interval-days') || {}).value, 10) || 3,
        maxReminders: parseInt((document.getElementById('pr-max-reminders') || {}).value, 10) || 5,
        requireMissingDocuments: !!(document.getElementById('pr-require-docs') || {}).checked,
        statuses,
        channels: {
            email: !!(document.getElementById('pr-ch-email') || {}).checked,
            whatsapp: !!(document.getElementById('pr-ch-wa') || {}).checked
        }
    };
    try {
        const res = await fetch('/api/admin/pending-registration-reminder-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, config })
        });
        const data = await res.json();
        if (msg) {
            msg.style.color = data.success ? '#15803d' : '#b91c1c';
            msg.textContent = data.success ? 'Reminder settings saved.' : data.error || 'Save failed.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error.';
        }
    }
}

async function loadJudgeCommunicationsAdmin() {
    const adm = getStoredAdminUser();
    const tbody = document.getElementById('judge-comm-tbody');
    if (!tbody || !adm || !adm.id) return;
    tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;">Loading…</td></tr>';
    try {
        const res = await fetch(
            `/api/admin/judge-communications?actingAdminId=${encodeURIComponent(adm.id)}&limit=80`
        );
        const d = await res.json();
        const rows = d.communications || [];
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#64748b;">No judge emails logged yet.</td></tr>';
            return;
        }
        tbody.innerHTML = rows
            .map((r) => {
                const judge = [r.judge_first, r.judge_last].filter(Boolean).join(' ') || r.judge_uid || '—';
                return (
                    '<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0;">' +
                    (r.created_at || '').slice(0, 19) +
                    '</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;">' +
                    judge +
                    '</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;">' +
                    (r.to_address || '') +
                    '</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;">' +
                    (r.subject || '') +
                    '</td><td style="padding:8px;border-bottom:1px solid #e2e8f0;">' +
                    (r.status || '') +
                    '</td></tr>'
                );
            })
            .join('');
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#b91c1c;">Could not load log.</td></tr>';
    }
}

async function saveDesignatedNotifyConfig() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('dn-save-msg');
    if (!adm || !adm.id) return;
    const emails = String((document.getElementById('dn-emails') || {}).value || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const phones = String((document.getElementById('dn-phones') || {}).value || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    try {
        const res = await fetch('/api/admin/designated-notify-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, config: { emails, phones } })
        });
        const data = await res.json();
        if (msg) {
            msg.style.color = data.success ? '#15803d' : '#b91c1c';
            msg.textContent = data.success ? 'Designated contacts saved.' : data.error || 'Save failed.';
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error.';
        }
    }
}

async function populateVenueBroadcastSeminars() {
    const sel = document.getElementById('venue-broadcast-seminar');
    if (!sel || sel.options.length > 1) return;
    try {
        const res = await fetch('/api/seminars');
        const rows = await res.json();
        (rows || []).forEach((s) => {
            const o = document.createElement('option');
            o.value = String(s.id);
            o.textContent = s.title || `Seminar ${s.id}`;
            sel.appendChild(o);
        });
    } catch (_) {}
}

async function sendVenueBroadcast() {
    const adm = getStoredAdminUser();
    const st = document.getElementById('venue-broadcast-status');
    if (!adm || !adm.id) return alert('Not logged in.');
    const message = String((document.getElementById('venue-broadcast-msg') || {}).value || '').trim();
    if (!message) return alert('Enter the new venue or message text.');
    if (!confirm('Send venue update to all paid registrants? This cannot be undone.')) return;
    const seminarId = String((document.getElementById('venue-broadcast-seminar') || {}).value || '').trim();
    if (st) {
        st.style.color = '#64748b';
        st.textContent = 'Sending…';
    }
    try {
        const res = await fetch('/api/admin/broadcast-venue-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actingAdminId: adm.id,
                message,
                venue: message,
                seminarId: seminarId || undefined,
                sendEmail: !!(document.getElementById('venue-broadcast-email') || {}).checked,
                sendWhatsApp: !!(document.getElementById('venue-broadcast-wa') || {}).checked
            })
        });
        const data = await res.json();
        if (st) {
            st.style.color = data.success ? '#15803d' : '#b91c1c';
            st.textContent = data.success
                ? `Queued for ${data.recipients || 0} recipient(s).`
                : data.error || 'Broadcast failed.';
        }
    } catch (e) {
        if (st) {
            st.style.color = '#b91c1c';
            st.textContent = 'Network error.';
        }
    }
}

function openProxyApplicationModal() {
    stopProxyPaymentPoll();
    resetProxyApplicantOtpTokens();
    __proxyLastRegId = null;
    __proxyLastUserId = null;
    __proxyLastOrderDbId = null;
    const payWrap = document.getElementById('proxy-payment-wrap');
    const qrBlock = document.getElementById('proxy-qr-block');
    if (payWrap) payWrap.classList.add('hidden');
    if (qrBlock) qrBlock.classList.add('hidden');
    loadProxyCapacityBanner().catch(console.error);
    document.getElementById('admin-proxy-modal').classList.remove('hidden');
}

async function loadAdminSiteCms() {
    const tickerEl = document.getElementById('cms-ticker');
    if (!tickerEl) return;
    loadPortalAuthAdminForm().catch(console.error);
    loadDesignatedNotifyAdminForm().catch(console.error);
    loadNotificationDeliveryAdminForm().catch(console.error);
    loadSupportTicketSlaAdminForm().catch(console.error);
    loadPortalThemesAdminForm().catch(console.error);
    loadPendingReminderAdminForm().catch(console.error);
    loadJudgeCommunicationsAdmin().catch(console.error);
    populateVenueBroadcastSeminars().catch(console.error);
    try {
        const res = await fetch('/api/public/site-cms');
        const cms = await res.json();
        __siteCmsEditing = cms;
        tickerEl.value = cms.tickerText || '';
        const b = document.getElementById('cms-banner');
        if (b) b.value = cms.bannerImage || '';
        const sl = document.getElementById('cms-slides');
        if (sl) sl.value = JSON.stringify(cms.slides || [], null, 2);
        cmsFillReviewRows(cms.reviews || []);
        cmsFillScrollingRows(cms.scrollingAnnouncements || []);
        cmsFillPublicNoticeRows(cms.publicNotices || []);
        cmsFillDoctorRows(cms.doctorUpdates || []);
        cmsFillAboutRows(cms.aboutSections || []);
        cmsFillSocialRows(cms.socialLinks || []);
        const galleryYears =
            Array.isArray(cms.seminarGalleryYears) && cms.seminarGalleryYears.length
                ? cms.seminarGalleryYears
                : cmsGroupGalleryFlat(cms.pastSeminarGallery || []);
        cmsFillGalleryYears(galleryYears);
        cmsFillMenuRows(cms.siteMenu || []);
        cmsApplyHeroFieldsToForm(cms);
        cmsApplySeoFieldsToForm(cms.seo || {});
        cmsFillSpeakerRows(cms.speakers || []);
        cmsFillFeatureRows(cms.featureCards || []);
        cmsFillFaqRows(cms.faq || []);
        await loadAdminMarketing();
        await loadPortalAuthAdminForm();
    } catch (e) {
        console.error(e);
    }
}

async function loadPortalAuthAdminForm() {
    const adm = getStoredAdminUser();
    const eff = document.getElementById('pa-effective-hint');
    if (!adm || !adm.id) {
        if (eff) eff.textContent = '';
        return;
    }
    try {
        const res = await fetch(`/api/admin/portal-auth-config?actingAdminId=${encodeURIComponent(adm.id)}`);
        const d = await res.json();
        if (!d.success || !d.config) return;
        const setChk = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setChk('pa-show-signup', d.config.showSignup);
        setChk('pa-show-login', d.config.showLogin);
        setChk('pa-req-signup-otp', d.config.requireSignupOtp);
        setChk('pa-req-login-otp', d.config.requireLoginOtp);
        setChk('pa-req-email-verify', d.config.requireEmailVerification);
        setChk('pa-req-admin-sensitive-otp', d.config.requireAdminOtpForSensitive);
        setChk('pa-req-behalf-applicant-otp', d.config.requireBehalfApplicantOtp !== false);
        __requireBehalfApplicantOtp = d.config.requireBehalfApplicantOtp !== false;
        window.__adminEnabledPages = d.config.adminEnabledPages || {};
        window.__websiteMenuPages = d.config.websiteMenuPages || {};
        renderAdminGlobalPagesCheckboxes();
        renderWebsiteMenuPagesCheckboxes();
        if (eff) {
            eff.textContent = `Effective signup OTP: ${d.signupOtpEffective ? 'on' : 'off'} · Effective login OTP: ${d.loginOtpEffective ? 'on' : 'off'} (environment variables can still override).`;
        }
    } catch (_) {
        if (eff) eff.textContent = '';
    }
}

function renderAdminGlobalPagesCheckboxes() {
    const wrap = document.getElementById('admin-global-pages-checkboxes');
    const card = document.getElementById('admin-pages-policy-card');
    if (!wrap) return;
    const superUser = isSuperAdminUser();
    if (card) card.style.display = superUser ? '' : 'none';
    if (!superUser) return;
    const pages = window.__adminEnabledPages || {};
    const keys = Object.keys(pages);
    const restrict = keys.length && keys.some((k) => pages[k] === true);
    wrap.innerHTML = ADMIN_MODULE_TAB_DEFS.map(([id, title]) => {
        const checked = !restrict || pages[id] === true;
        return (
            '<label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer;">' +
            '<input type="checkbox" data-global-admin-tab="' +
            id +
            '" ' +
            (checked ? 'checked' : '') +
            '>' +
            '<span>' +
            title +
            '</span></label>'
        );
    }).join('');
}

function renderWebsiteMenuPagesCheckboxes() {
    const wrap = document.getElementById('website-menu-pages-checkboxes');
    const card = document.getElementById('website-menu-policy-card');
    if (!wrap) return;
    const superUser = isSuperAdminUser();
    if (card) card.style.display = superUser ? '' : 'none';
    if (!superUser) return;
    const pages = window.__websiteMenuPages || {};
    const keys = Object.keys(pages);
    const restrict = keys.length && keys.some((k) => pages[k] === true);
    wrap.innerHTML = WEBSITE_MENU_PAGE_DEFS.map(([id, title]) => {
        const checked = !restrict || pages[id] === true;
        return (
            '<label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer;">' +
            '<input type="checkbox" data-website-menu-key="' +
            id +
            '" ' +
            (checked ? 'checked' : '') +
            '>' +
            '<span>' +
            title +
            '</span></label>'
        );
    }).join('');
}

async function savePortalAuthAdminConfig() {
    const adm = getStoredAdminUser();
    const msg = document.getElementById('pa-save-msg');
    if (!adm || !adm.id) return;
    const gv = (id) => !!(document.getElementById(id) || {}).checked;
    const config = {
        showSignup: gv('pa-show-signup'),
        showLogin: gv('pa-show-login'),
        requireSignupOtp: gv('pa-req-signup-otp'),
        requireLoginOtp: gv('pa-req-login-otp'),
        requireEmailVerification: gv('pa-req-email-verify'),
        requireAdminOtpForSensitive: gv('pa-req-admin-sensitive-otp'),
        requireBehalfApplicantOtp: gv('pa-req-behalf-applicant-otp')
    };
    if (isSuperAdminUser()) {
        const adminEnabledPages = {};
        document.querySelectorAll('#admin-global-pages-checkboxes input[data-global-admin-tab]').forEach((inp) => {
            const id = inp.getAttribute('data-global-admin-tab');
            if (id && inp.checked) adminEnabledPages[id] = true;
        });
        config.adminEnabledPages = adminEnabledPages;
        const websiteMenuPages = {};
        document.querySelectorAll('#website-menu-pages-checkboxes input[data-website-menu-key]').forEach((inp) => {
            const id = inp.getAttribute('data-website-menu-key');
            if (id && inp.checked) websiteMenuPages[id] = true;
        });
        config.websiteMenuPages = websiteMenuPages;
    }
    try {
        const res = await fetch('/api/admin/portal-auth-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actingAdminId: adm.id, config })
        });
        const data = await res.json();
        if (msg) {
            msg.style.color = data.success ? '#15803d' : '#b91c1c';
            msg.textContent = data.success ? 'Portal auth policy saved.' : data.error || 'Save failed.';
        }
        if (data.success) {
            await loadPortalAuthAdminForm();
            await refreshAdminSensitiveOtpRequirement();
            applyCoAdminSidebarVisibility();
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = 'Network error.';
        }
    }
}

async function saveAdminSiteCms() {
    const msg = document.getElementById('cms-save-msg');
    if (msg) msg.innerText = '';
    let slides;
    try {
        slides = cmsParseJsonArray((document.getElementById('cms-slides') || {}).value, 'Homepage slides');
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = e.message || String(e);
        }
        return;
    }
    const reviews = cmsCollectReviewsFromDom();
    const aboutSections = cmsCollectAboutFromDom();
    const socialLinks = cmsCollectSocialFromDom();
    const seminarGalleryYears = cmsCollectGalleryYearsFromDom();
    const pastSeminarGallery = seminarGalleryYears.reduce((acc, yg) => {
        (yg.images || []).forEach((img) => {
            acc.push({ src: img.src, caption: img.caption || yg.title || '', year: yg.year });
        });
        return acc;
    }, []);
    const siteMenu = cmsCollectMenuFromDom();
    try {
        const cms = {
            tickerText: (document.getElementById('cms-ticker') || {}).value || '',
            bannerImage: (document.getElementById('cms-banner') || {}).value || '',
            scrollingAnnouncements: cmsCollectScrollingAnnouncementsFromDom(),
            doctorUpdates: cmsCollectDoctorUpdatesFromDom(),
            slides,
            reviews,
            publicNotices: cmsCollectPublicNoticesFromDom(),
            aboutSections,
            socialLinks,
            pastSeminarGallery,
            seminarGalleryYears,
            siteMenu,
            speakers: cmsCollectSpeakersFromDom(),
            seo: cmsCollectSeoFieldsFromForm(),
            ...cmsCollectHeroFieldsFromForm()
        };
        const res = await fetch('/api/admin/site-cms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cms })
        });
        const data = await res.json();
        if (data.success) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.innerText = 'Website and portal content saved.';
            }
        } else if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = data.error || 'Save failed';
        }
    } catch (e) {
        console.error(e);
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = 'Network error — check your connection and try again.';
        }
    }
}

async function uploadSeminarGalleryBatch() {
    const fileInp = document.getElementById('seminar-gallery-files');
    const yearInp = document.getElementById('seminar-gallery-upload-year');
    const ta = document.getElementById('seminar-gallery');
    if (!fileInp || !ta) return;
    const year = ((yearInp && yearInp.value) || '').trim() || String(new Date().getFullYear());
    const paths = await uploadAdminAssetFromInput(fileInp, { multiple: true });
    fileInp.value = '';
    if (!paths || !paths.length) return;
    let albums = [];
    try {
        const parsed = JSON.parse(ta.value || '[]');
        if (Array.isArray(parsed)) {
            if (parsed.length && typeof parsed[0] === 'string') {
                albums = [{ year: 'Archive', title: '', images: parsed.map((src) => ({ src, caption: '' })) }];
            } else {
                albums = parsed;
            }
        }
    } catch (_) {
        albums = [];
    }
    let bucket = albums.find((a) => String(a.year) === year);
    if (!bucket) {
        bucket = { year, title: '', images: [] };
        albums.push(bucket);
    }
    if (!Array.isArray(bucket.images)) bucket.images = [];
    paths.forEach((src) => bucket.images.push({ src, caption: '' }));
    albums.sort((a, b) => String(b.year).localeCompare(String(a.year)));
    ta.value = JSON.stringify(albums, null, 2);
    if (yearInp && !yearInp.value) yearInp.value = year;
}

async function uploadSeminarHeroOrFlyer(kind) {
    const id = kind === 'flyer' ? 'seminar-flyer-file' : 'seminar-hero-file';
    const el = document.getElementById(id);
    if (!el) return;
    const path = await uploadAdminAssetFromInput(el);
    el.value = '';
    if (!path) return;
    if (kind === 'flyer') {
        const t = document.getElementById('seminar-flyer');
        if (t) t.value = path;
    } else {
        const t = document.getElementById('seminar-hero-image');
        if (t) t.value = path;
    }
}


let __adminPaymentsTab = 'orders';
let __adminEnrichedOrdersCache = [];
let __adminCancelRequestsCache = [];
let __adminCertCandidatesCache = [];
let __adminVolunteersCache = [];
let __supportTicketsCache = [];
let __adminCaseSubmissionsCache = [];
let __adminCaseProgramsCache = [];
let __adminSupplementalCache = [];
let __adminContactInquiriesCache = [];
let __adminFeedbackCache = [];
let __adminScannerLogsCache = [];

function switchAdminPaymentsTab(tab) {
    __adminPaymentsTab = tab;
    const tabColors = { orders: '#0d9488', supplemental: '#7c3aed', cancellations: '#64748b' };
    document.querySelectorAll('.admin-payments-subtab').forEach((btn) => {
        const on = btn.getAttribute('data-pay-tab') === tab;
        btn.style.background = on ? tabColors[tab] || '#0d9488' : '#64748b';
        btn.classList.toggle('active', on);
    });
    const ordersPanel = document.getElementById('admin-payments-panel-orders');
    const cancelPanel = document.getElementById('admin-payments-panel-cancellations');
    const supPanel = document.getElementById('admin-payments-panel-supplemental');
    if (ordersPanel) ordersPanel.classList.toggle('hidden', tab !== 'orders');
    if (cancelPanel) cancelPanel.classList.toggle('hidden', tab !== 'cancellations');
    if (supPanel) supPanel.classList.toggle('hidden', tab !== 'supplemental');
    if (tab === 'orders') loadAdminEnrichedOrders();
    else if (tab === 'supplemental') loadAdminSupplementalPayments();
    else loadAdminCancellationRequests();
}

function syncSeminarOtpOptionsUi() {
    const master = document.getElementById('seminar-otp-app')?.checked;
    const wrap = document.getElementById('seminar-otp-subopts');
    const s1 = document.getElementById('seminar-otp-step1');
    const sub = document.getElementById('seminar-otp-submit');
    if (wrap) wrap.style.opacity = master ? '1' : '0.45';
    if (s1) s1.disabled = !master;
    if (sub) sub.disabled = !master;
}

let __coLookup = null;
let __coRegId = null;
let __coOrderDbId = null;
let __coMethodId = 'dqr';
let __coPaymentMethods = [];

function updateCoFinalAmount() {
    const fee = parseFloat(document.getElementById('co-amount')?.value || '0') || 0;
    const disc = parseFloat(document.getElementById('co-discount')?.value || '0') || 0;
    const fin = document.getElementById('co-final');
    if (fin) fin.value = String(Math.max(0, Math.round((fee - disc) * 100) / 100));
}

function updateCoMethodDesc() {
    const sel = document.getElementById('co-method');
    const hint = document.getElementById('co-method-desc');
    if (!sel || !hint) return;
    const m = (__coPaymentMethods || []).find((x) => x.id === sel.value);
    hint.textContent = (m && m.description) || '';
}

async function loadCreateOrderPaymentMethods() {
    const sel = document.getElementById('co-method');
    const adm = getStoredAdminUser();
    if (!sel || !adm?.id) return;
    try {
        const res = await fetch('/api/admin/payments/methods?actingAdminId=' + encodeURIComponent(adm.id));
        const data = await res.json();
        if (!res.ok) return;
        const methods = (data.methods || []).filter((m) => m.available);
        __coPaymentMethods = methods;
        sel.innerHTML = methods.map((m) => '<option value="' + escAdmin(m.id) + '">' + escAdmin(m.label) + '</option>').join('');
        if (methods.length) __coMethodId = methods[0].id;
        sel.onchange = () => {
            __coMethodId = sel.value;
            updateCoMethodDesc();
        };
        updateCoMethodDesc();
    } catch (e) {
        console.error(e);
    }
}

async function lookupAdminCreateOrder() {
    const adm = getStoredAdminUser();
    const sid = document.getElementById('co-seminar')?.value;
    const q = document.getElementById('co-user-query')?.value?.trim();
    const box = document.getElementById('co-lookup-result');
    const panel = document.getElementById('co-pay-panel');
    if (!adm?.id || !sid || !q) return alert('Select seminar and enter doctor User ID, email, or phone.');
    if (box) box.innerHTML = 'Looking up…';
    if (panel) panel.classList.add('hidden');
    try {
        const res = await fetch(
            '/api/admin/payments/lookup?actingAdminId=' +
                encodeURIComponent(adm.id) +
                '&seminarId=' +
                encodeURIComponent(sid) +
                '&q=' +
                encodeURIComponent(q)
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');
        __coLookup = data;
        __coRegId = data.registration ? data.registration.id : null;
        if (!data.found) {
            if (box) box.innerHTML = '<p style="color:#b91c1c;">' + escAdmin(data.message || 'Not found') + '</p>';
            return;
        }
        const u = data.user;
        let html =
            '<p><strong>' +
            escAdmin(u.name) +
            '</strong> · ' +
            escAdmin(u.userIdString) +
            '<br>Email: ' +
            escAdmin(u.email) +
            ' · Phone: ' +
            escAdmin(u.phone || '—') +
            '</p>';
        html += '<p>Seminar: <strong>' + escAdmin(data.seminar.title) + '</strong> · Fee ₹' + data.seminar.price + '</p>';
        if (data.registration) {
            html +=
                '<p>Application <code>' +
                escAdmin(data.registration.applicationNo) +
                '</code> — status <strong>' +
                escAdmin(data.registration.status) +
                '</strong></p>';
        } else {
            html += '<p style="color:#b45309;">No application for this seminar — click <em>Ensure application</em> first.</p>';
        }
        if (data.order) {
            html +=
                '<p>Order <code>' +
                escAdmin(data.order.orderIdString) +
                '</code> — ' +
                escAdmin(data.order.status) +
                (data.order.gateway ? ' via ' + escAdmin(data.order.gateway) : '') +
                ' · ₹' +
                escAdmin(data.order.amount) +
                '</p>';
        }
        if (data.paid) html += '<p style="color:#15803d;font-weight:700;">Already paid in system.</p>';
        else if (data.canCollectPayment) html += '<p style="color:#0f766e;">Ready to collect payment below.</p>';
        if (box) box.innerHTML = html;
        if (data.canCollectPayment && data.registration) {
            const feeEl = document.getElementById('co-amount');
            const discEl = document.getElementById('co-discount');
            if (feeEl) feeEl.value = String(data.seminar && data.seminar.price != null ? data.seminar.price : data.suggestedAmount || 0);
            if (discEl) discEl.value = '0';
            updateCoFinalAmount();
            if (panel) panel.classList.remove('hidden');
            await loadCreateOrderPaymentMethods();
        }
    } catch (e) {
        if (box) box.innerHTML = '<p style="color:#b91c1c;">' + escAdmin(e.message) + '</p>';
    }
}

async function ensureAdminCreateOrderRegistration() {
    const adm = getStoredAdminUser();
    if (!__coLookup?.found || !__coLookup.user?.id) return alert('Look up a doctor first.');
    const sid = document.getElementById('co-seminar')?.value;
    try {
        const res = await fetch('/api/admin/payments/ensure-registration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: __coLookup.user.id,
                seminarId: parseInt(sid, 10),
                adminUserId: adm.id
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        alert(data.created ? 'Application created and approved for payment.' : 'Application ready for payment.');
        document.getElementById('co-user-query').value = __coLookup.user.userIdString || '';
        lookupAdminCreateOrder();
    } catch (e) {
        alert(e.message || 'Failed');
    }
}

async function initiateAdminCreateOrderPayment() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__coRegId) return alert('Look up doctor and ensure application first.');
    const methodId = document.getElementById('co-method')?.value || __coMethodId || 'dqr';
    const amount = parseFloat(document.getElementById('co-amount')?.value || '0');
    const discount = parseFloat(document.getElementById('co-discount')?.value || '0');
    const msg = document.getElementById('co-pay-msg');
    const qrBlock = document.getElementById('co-qr-block');
    const qrImg = document.getElementById('co-qr-img');
    const qrAmt = document.getElementById('co-qr-amount');
    const markBtn = document.getElementById('co-mark-upi-btn');
    if (msg) {
        msg.style.color = '#0f766e';
        msg.textContent = 'Starting payment…';
    }
    if (qrBlock) qrBlock.classList.add('hidden');
    if (markBtn) markBtn.classList.add('hidden');
    try {
        const res = await fetch('/api/admin/payments/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId: __coRegId,
                adminUserId: adm.id,
                methodId,
                amount,
                discountAmount: discount
            })
        });
        let data = {};
        if (window.HttpJson) {
            const parsed = await window.HttpJson.readJsonResponse(res);
            data = parsed.data;
            if (parsed.parseFailed) {
                throw new Error(window.HttpJson.apiErrorMessage(res, data, true));
            }
        } else {
            data = await res.json();
        }
        if (!res.ok) throw new Error(data.error || 'Failed');
        if (data.paid) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.textContent = data.message || 'Paid.';
            }
            alert(data.message || 'Payment recorded.');
            loadAdminEnrichedOrders();
            lookupAdminCreateOrder();
            return;
        }
        __coOrderDbId = data.orderDbId;
        if (data.paymentType === 'razorpay_checkout' && data.razorpayOrder && data.keyId) {
            if (msg) msg.textContent = 'Opening Razorpay checkout… allow pop-ups if prompted.';
            const opened = openAdminRazorpayCheckout(data, () => pollAdminCreateOrderPayment());
            if (!opened && msg) {
                msg.style.color = '#b45309';
                msg.textContent =
                    'Checkout could not open. Allow pop-ups, then click Start payment again or use Check status after the doctor pays.';
            }
            return;
        }
        if (data.paymentType && String(data.paymentType).endsWith('_checkout') && data.gateway !== 'razorpay') {
            if (msg) msg.textContent = 'Opening payment page… allow pop-ups if prompted.';
            const opened = openAdminHostedCheckout(data, () => pollAdminCreateOrderPayment());
            if (!opened && msg) {
                msg.style.color = '#b45309';
                msg.textContent = 'Could not open payment page. Allow pop-ups and try again.';
            }
            return;
        }
        if (data.qrImageUrl && qrImg) {
            qrImg.src =
                String(data.qrImageUrl).indexOf('http') === 0 || String(data.qrImageUrl).indexOf('/') === 0
                    ? data.qrImageUrl
                    : data.qrImageUrl;
            if (qrBlock) qrBlock.classList.remove('hidden');
        }
        if (qrAmt) qrAmt.textContent = 'Amount: ₹' + (data.amount || amount);
        if (data.manualConfirm && markBtn) markBtn.classList.remove('hidden');
        if (msg) {
            msg.style.color = '#0f766e';
            msg.textContent = data.message || 'Payment started.';
        }
        if (data.pollRequired && data.paymentType === 'dqr') {
            pollAdminCreateOrderPayment();
        }
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.textContent = e.message || 'Payment failed';
        }
    }
}

async function markAdminCreateOrderUpiPaid() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__coOrderDbId) return alert('Start UPI payment first.');
    if (!confirm('Confirm UPI payment received?')) return;
    try {
        const res = await fetch('/api/admin/payments/mark-upi-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderDbId: __coOrderDbId, adminUserId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        alert(data.message || 'Recorded.');
        loadAdminEnrichedOrders();
        lookupAdminCreateOrder();
    } catch (e) {
        alert(e.message || 'Failed');
    }
}

async function pollAdminCreateOrderPayment() {
    const adm = getStoredAdminUser();
    if (!adm?.id || !__coOrderDbId) return alert('Start payment first.');
    try {
        const res = await fetch(
            '/api/admin/payments/poll/' + __coOrderDbId + '?actingAdminId=' + encodeURIComponent(adm.id)
        );
        const data = await res.json();
        const msg = document.getElementById('co-pay-msg');
        if (data.paid) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.textContent = data.message || 'Payment received.';
            }
            loadAdminEnrichedOrders();
            lookupAdminCreateOrder();
        } else if (msg) msg.textContent = data.message || 'Not paid yet.';
    } catch (e) {
        console.error(e);
    }
}

async function loadAdminPaymentsModule() {
    await fillAdminSeminarSelect('co-seminar', false);
    await fillAdminSeminarSelect('sup-pay-seminar', true);
    switchAdminPaymentsTab(__adminPaymentsTab || 'orders');
}

async function loadAdminSupplementalPayments() {
    const tbody = document.getElementById('admin-supplemental-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    try {
        const res = await fetch('/api/admin/supplemental-payments');
        const rows = await res.json();
        __adminSupplementalCache = Array.isArray(rows) ? rows : [];
        renderAdminSupplementalPaymentsTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="6">Error loading</td></tr>';
    }
}

async function createAdminSupplementalPayment() {
    const adm = getStoredAdminUser();
    const st = document.getElementById('sup-pay-create-status');
    if (!adm || !adm.id) return alert('Sign in as admin first.');
    try {
        const res = await fetch('/api/admin/supplemental-payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                actingAdminId: adm.id,
                userIdString: String(document.getElementById('sup-pay-user-id')?.value || '').trim(),
                seminarId: document.getElementById('sup-pay-seminar')?.value || null,
                title: document.getElementById('sup-pay-title')?.value,
                description: document.getElementById('sup-pay-desc')?.value,
                amount: document.getElementById('sup-pay-amount')?.value
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        if (st) {
            st.style.color = '#15803d';
            st.textContent = 'Charge created (id ' + data.id + '). Doctor will see it under Payments.';
        }
        loadAdminSupplementalPayments();
    } catch (e) {
        if (st) {
            st.style.color = '#b91c1c';
            st.textContent = e.message;
        }
    }
}

async function markAdminSupplementalPaid(id) {
    if (!confirm('Mark this additional payment as received (cash)?')) return;
    try {
        const res = await fetch('/api/admin/supplemental-payments/' + id + '/mark-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'cash' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        loadAdminSupplementalPayments();
    } catch (e) {
        alert(e.message);
    }
}

async function deleteAdminSupplemental(id) {
    if (!confirm('Remove this pending charge?')) return;
    try {
        const res = await fetch('/api/admin/supplemental-payments/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        loadAdminSupplementalPayments();
    } catch (e) {
        alert(e.message);
    }
}

async function loadAdminEnrichedOrders() {
    const tbody = document.getElementById('admin-orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
    try {
        const res = await fetch('/api/admin/payments/enriched-orders');
        const rows = await res.json();
        __adminEnrichedOrdersCache = Array.isArray(rows) ? rows : [];
        __adminOrdersCache = __adminEnrichedOrdersCache;
        renderAdminEnrichedOrdersTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="9">Failed to load</td></tr>';
    }
}

async function adminRefundOrderPrompt(orderDbId) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const o = __adminEnrichedOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
    if (!o) return alert('Order not found. Refresh the list.');
    const maxRefundable = Math.max(0, (Number(o.amount) || 0) - (Number(o.refunded_amount) || 0));
    const hint = 'Max refundable now: ₹' + maxRefundable;
    const raw = prompt(hint + '\n\nEnter refund amount in ₹ (or leave blank for full remaining):', String(maxRefundable));
    if (raw === null) return;
    const amount = raw.trim() === '' ? maxRefundable : Number(raw);
    if (Number.isNaN(amount) || amount <= 0) return alert('Invalid amount.');
    if (amount > maxRefundable + 0.01) return alert('Amount exceeds remaining paid balance.');
    const reason = prompt('Reason for refund (optional):', 'Admin refund') || '';
    if (!confirm('Refund ₹' + amount + ' for order ' + (o.order_id_string || o.id) + '?')) return;
    try {
        const res = await fetch('/api/admin/payments/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: o.id, amount, reason, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Refund failed');
        alert(data.message || 'Refund initiated.');
        loadAdminEnrichedOrders();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function adminCancelPendingOrder(orderDbId) {
    const adm = getStoredAdminUser();
    if (!adm?.id) return alert('Not logged in.');
    if (!confirm('Cancel this pending order? The doctor can start a new payment attempt.')) return;
    try {
        const res = await fetch('/api/admin/payments/cancel-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderDbId, adminUserId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Order cancelled.');
        loadAdminEnrichedOrders();
    } catch (e) {
        alert(e.message || 'Failed');
    }
}

async function adminPollOrderPayment(orderDbId) {
    const adm = getStoredAdminUser();
    if (!adm?.id) return;
    __coOrderDbId = orderDbId;
    await pollAdminCreateOrderPayment();
    loadAdminEnrichedOrders();
}

async function adminRetryOrderPayment(registrationId, orderDbId) {
    const adm = getStoredAdminUser();
    if (!adm?.id) return alert('Not logged in.');
    await loadCreateOrderPaymentMethods();
    const methods = __coPaymentMethods || [];
    if (!methods.length) return alert('No payment methods configured.');
    let pick = methods[0].id;
    if (methods.length > 1) {
        const labels = methods.map((m, i) => i + 1 + '. ' + m.label).join('\n');
        const n = prompt('Choose payment method (enter number):\n' + labels, '1');
        if (n === null) return;
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < methods.length) pick = methods[idx].id;
    }
    const o = __adminEnrichedOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
    const amount = o ? Number(o.amount) : null;
    try {
        const res = await fetch('/api/admin/payments/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId,
                adminUserId: adm.id,
                methodId: pick,
                amount
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Retry failed');
        __coOrderDbId = data.orderDbId;
        if (data.paymentType === 'razorpay_checkout' && data.razorpayOrder && data.keyId) {
            openAdminRazorpayCheckout(data, () => pollAdminCreateOrderPayment());
        } else if (data.paymentType && String(data.paymentType).endsWith('_checkout') && data.gateway !== 'razorpay') {
            openAdminHostedCheckout(data, () => pollAdminCreateOrderPayment());
        } else if (data.qrImageUrl) {
            const qrBlock = document.getElementById('co-qr-block');
            const qrImg = document.getElementById('co-qr-img');
            if (qrImg) qrImg.src = data.qrImageUrl;
            if (qrBlock) qrBlock.classList.remove('hidden');
            alert(data.message || 'QR ready — scan to pay.');
        } else if (data.paid) {
            alert(data.message || 'Paid.');
        } else {
            alert(data.message || 'Payment started.');
        }
        loadAdminEnrichedOrders();
    } catch (e) {
        alert(e.message || 'Failed');
    }
}

async function adminWaiveAndTicket(registrationId) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const note = prompt('Note for waiver (optional):', 'Fee waived by admin') || '';
    if (!confirm('Waive seminar fee and issue e-ticket for registration #' + registrationId + '?')) return;
    try {
        const res = await fetch('/api/admin/payments/waive-and-ticket', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId, note, actingAdminId: adm.id })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not waive');
        alert(data.message || 'Done.');
        loadAdminEnrichedOrders();
        if (__adminUserDetailCache) renderAdminUserDetailTab();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function loadAdminCancellationRequests() {
    const tbody = document.getElementById('admin-cancel-req-tbody');
    if (!tbody) return;
    const status = document.getElementById('admin-cancel-req-filter')?.value || '';
    tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
    try {
        const q = status ? '?status=' + encodeURIComponent(status) : '';
        const res = await fetch('/api/admin/cancellation-requests' + q);
        const rows = await res.json();
        __adminCancelRequestsCache = Array.isArray(rows) ? rows : [];
        renderAdminCancellationRequestsTable();
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="8">Failed to load</td></tr>';
    }
}

async function adminResolveCancelRequest(requestId, action) {
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) return alert('Not logged in.');
    const row = __adminCancelRequestsCache.find((x) => Number(x.id) === Number(requestId));
    if (!row) return alert('Refresh the list.');
    const adminNotes = prompt('Admin notes (optional):', '') || '';
    let processRefund = false;
    let refundAmount = null;
    if (action === 'approve') {
        const defAmt = row.refund_amount != null ? row.refund_amount : '';
        const amtRaw = prompt(
            'Refund amount in ₹ (IST policy preview: ' + defAmt + '). Leave blank to use policy amount:',
            String(defAmt)
        );
        if (amtRaw === null) return;
        if (amtRaw.trim() !== '') {
            refundAmount = Number(amtRaw);
            if (Number.isNaN(refundAmount)) return alert('Invalid amount.');
        }
        processRefund = confirm('Process payment gateway refund when approving? (No = cancel registration only)');
        if (!confirm('Approve cancellation for ' + (row.application_no || 'application') + '?')) return;
    } else if (!confirm('Reject this cancellation request?')) {
        return;
    }
    try {
        const res = await fetch('/api/admin/cancellation-requests/' + requestId + '/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                adminNotes,
                processRefund,
                refundAmount,
                actingAdminId: adm.id
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Failed');
        alert(data.message || 'Done.');
        loadAdminCancellationRequests();
        loadAdminEnrichedOrders();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function loadAdminUserPaymentsPanel(userId, bodyEl) {
    if (!bodyEl) return;
    try {
        const res = await fetch('/api/admin/payments/enriched-orders?userId=' + encodeURIComponent(userId));
        const rows = await res.json();
        const list = Array.isArray(rows) ? rows : [];
        let html = '<p style="color:#64748b;font-size:0.88rem;margin-bottom:12px;">Payments, refunds, and e-tickets for this account.</p>';
        html += '<table class="data-table"><thead><tr><th>Order</th><th>Seminar</th><th>Gateway</th><th>Amount</th><th>Refunded</th><th>Status</th><th>E-ticket</th><th>Actions</th></tr></thead><tbody>';
        if (!list.length) {
            html += '<tr><td colspan="8">No orders</td></tr>';
        } else {
            list.forEach((o) => {
                const refunded = Number(o.refunded_amount) || 0;
                const amt = Number(o.amount) || 0;
                const canRefund = o.status === 'success' && refunded < amt - 0.01;
                let acts = '';
                if (canRefund) {
                    acts +=
                        '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#b45309;border:none;" onclick="adminRefundOrderPrompt(' +
                        o.id +
                        ')">Refund</button> ';
                }
                if (o.registration_id && o.status !== 'success') {
                    acts +=
                        '<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.75rem;background:#7c3aed;border:none;" onclick="adminWaiveAndTicket(' +
                        o.registration_id +
                        ')">Waive</button>';
                }
                html +=
                    '<tr><td>' +
                    escAdmin(o.order_id_string) +
                    '</td><td>' +
                    escAdmin(o.seminar_title) +
                    '</td><td>' +
                    escAdmin(o.payment_gateway) +
                    '</td><td>₹' +
                    escAdmin(amt) +
                    '</td><td>₹' +
                    escAdmin(refunded) +
                    '</td><td>' +
                    escAdmin(o.status) +
                    '</td><td>' +
                    escAdmin(o.e_ticket_id || '—') +
                    '</td><td>' +
                    (acts || '—') +
                    '</td></tr>';
            });
        }
        html += '</tbody></table>';
        const regs = (__adminUserDetailCache && __adminUserDetailCache.registrations) || [];
        if (regs.length) {
            html += '<h4 style="margin-top:16px;">Applications without payment</h4><ul style="font-size:0.88rem;">';
            regs.forEach((r) => {
                const paid = list.some(
                    (o) => Number(o.registration_id) === Number(r.id) && o.status === 'success'
                );
                if (!paid && r.status !== 'cancelled') {
                    html +=
                        '<li>' +
                        escAdmin(r.application_no) +
                        ' — ' +
                        escAdmin(r.seminar_title) +
                        ' <button type="button" class="btn-primary" style="padding:3px 8px;font-size:0.75rem;margin-left:8px;" onclick="adminWaiveAndTicket(' +
                        r.id +
                        ')">Waive &amp; ticket</button></li>';
                }
            });
            html += '</ul>';
        }
        bodyEl.innerHTML = html;
        __adminEnrichedOrdersCache = list;
    } catch (e) {
        console.error(e);
        bodyEl.innerHTML = '<p style="color:#b91c1c;">Failed to load payments</p>';
    }
}

async function loadAdminOrders() {
    return loadAdminEnrichedOrders();
    const tbody = document.getElementById('admin-orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9">Loading…</td></tr>';
    try {
        const res = await fetch('/api/admin/orders');
        const rows = await res.json();
        __adminOrdersCache = Array.isArray(rows) ? rows : [];
        tbody.innerHTML = '';
        if (!__adminOrdersCache.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">No orders.</td></tr>';
            return;
        }
        __adminOrdersCache.forEach((o) => {
            const doc = `${o.first_name || ''} ${o.last_name || ''} (${o.user_id_string || o.user_id || ''})`;
            const dt = o.payment_date ? new Date(o.payment_date).toLocaleString() : '—';
            const rec =
                o.status === 'success'
                    ? `<button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;" onclick="openAdminOrderReceipt(${o.id})">View receipt</button>`
                    : '—';
            tbody.innerHTML += `<tr>
                <td><strong>${String(o.order_id_string || o.id).replace(/</g, '&lt;')}</strong></td>
                <td>${String(doc).replace(/</g, '&lt;')}</td>
                <td>${String(o.seminar_title || '—').replace(/</g, '&lt;')}</td>
                <td>${String(o.application_no || '—').replace(/</g, '&lt;')}</td>
                <td>₹${o.amount != null ? o.amount : '—'}</td>
                <td>${String(o.status || '').replace(/</g, '&lt;')}</td>
                <td>${String(dt).replace(/</g, '&lt;')}</td>
                <td>${rec}</td>
            </tr>`;
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="8">Failed to load</td></tr>';
    }
}

function adminReceiptPrintCss() {
    return [
        '@page { size: A4; margin: 12mm; }',
        '*{box-sizing:border-box}',
        'body{font-family:system-ui,Segoe UI,sans-serif;color:#0f172a;font-size:11pt;margin:0;padding:10mm 12mm 22mm;line-height:1.45}',
        '.rh,.rf{font-size:8.5pt;color:#334155;border:1px solid #cbd5e1;background:#f8fafc;padding:8px 12px}',
        '.rh strong,.rf strong{color:#0f172a}',
        '@media print{',
        '  .no-print{display:none!important}',
        '  .rh{position:fixed;top:0;left:0;right:0}',
        '  .rf{position:fixed;bottom:0;left:0;right:0}',
        '  body{padding-top:48px;padding-bottom:48px}',
        '}',
        'h1{font-size:1.2rem;color:#1a237e;margin:0 0 6px}',
        '.sub{color:#64748b;font-size:0.9rem;margin:0 0 16px}',
        'table{width:100%;border-collapse:collapse;margin-top:8px}',
        'td{padding:8px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top}',
        'td:first-child{width:36%;color:#64748b;font-size:0.95rem}',
        '.btn-print{margin:16px 0;padding:8px 16px;font-size:0.95rem;cursor:pointer}'
    ].join('');
}

async function openAdminOrderReceipt(orderDbId) {
    const o = __adminOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
    if (!o) {
        alert('Order not found. Click Refresh on Orders & receipts first.');
        return;
    }
    const w = window.open('', '_blank');
    if (!w) {
        alert('Allow pop-ups to view receipt.');
        return;
    }
    const esc = (s) =>
        String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    const docName = [o.first_name, o.middle_name, o.last_name].filter(Boolean).join(' ').trim() || `${o.first_name || ''} ${o.last_name || ''}`.trim();
    const orderStr = esc(String(o.order_id_string || o.id));
    const etix = esc(String(o.e_ticket_id || '—'));
    const uidStr = esc(String(o.user_id_string || o.user_id || ''));
    const txn = esc(String(o.provider_transaction_id || '—'));
    const prov = esc(String(o.payment_gateway || '—'));
    const provOrd = esc(String(o.provider_order_id || '—'));
    const genAt = esc(new Date().toLocaleString());
    const headerInner = `<strong>Order</strong> ${orderStr} &nbsp;|&nbsp; <strong>E‑ticket</strong> ${etix} &nbsp;|&nbsp; <strong>User ID</strong> ${uidStr}`;
    const footerInner = `<strong>Generated</strong> ${genAt} &nbsp;|&nbsp; <strong>Order</strong> ${orderStr} &nbsp;|&nbsp; <strong>Txn</strong> ${txn} &nbsp;|&nbsp; <strong>E‑ticket</strong> ${etix}`;
    const lines = [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt</title>',
        '<style>' + adminReceiptPrintCss() + '</style></head><body>',
        '<div class="rh">' + headerInner + '</div>',
        '<h1>Payment receipt (admin copy)</h1>',
        '<p class="sub">Vaidya Gogate Memorial Foundation — seminar portal</p>',
        '<button type="button" class="btn-print no-print" onclick="window.print()">Print / Save as PDF</button>',
        '<table>',
        `<tr><td>Doctor name</td><td>${esc(docName)}</td></tr>`,
        `<tr><td>Email</td><td>${esc(o.email || '—')}</td></tr>`,
        `<tr><td>Phone</td><td>${esc(o.phone || '—')}</td></tr>`,
        `<tr><td>Public user ID</td><td><code>${uidStr}</code></td></tr>`,
        `<tr><td>Order ID</td><td><code>${orderStr}</code></td></tr>`,
        `<tr><td>E‑ticket ID (12‑digit)</td><td><code>${etix}</code></td></tr>`,
        `<tr><td>Seminar</td><td>${esc(o.seminar_title || '—')}</td></tr>`,
        `<tr><td>Application no.</td><td>${esc(o.application_no || '—')}</td></tr>`,
        `<tr><td>Registration status</td><td>${esc(o.registration_status || '—')}</td></tr>`,
        `<tr><td>Payment status</td><td>${esc(o.status || '—')}</td></tr>`,
        `<tr><td>Amount</td><td>₹${esc(String(o.amount != null ? o.amount : '—'))}</td></tr>`,
        `<tr><td>Paid on</td><td>${esc(o.payment_date ? new Date(o.payment_date).toLocaleString() : '—')}</td></tr>`,
        `<tr><td>Payment provider</td><td>${prov}</td></tr>`,
        `<tr><td>Provider order / session ID</td><td><code>${provOrd}</code></td></tr>`,
        `<tr><td>Provider transaction ID</td><td><code>${txn}</code></td></tr>`,
        '</table>',
        '<p class="sub no-print" style="margin-top:20px">Use <strong>Print → Save as PDF</strong> for a PDF copy.</p>',
        '<div class="rf">' + footerInner + '</div>',
        '</body></html>'
    ];
    w.document.write(lines.join(''));
    w.document.close();
}

let __marketingBanners = [];

function marketingSetMsg(text, ok) {
    const el = document.getElementById('mkt-banner-msg');
    if (!el) return;
    el.style.color = ok ? '#15803d' : '#b91c1c';
    el.textContent = text || '';
}

function marketingReadRow(row) {
    if (!row) return null;
    return {
        id: row.dataset.id ? parseInt(row.dataset.id, 10) : null,
        title: (row.querySelector('.mb-title') || {}).value || '',
        subtitle: (row.querySelector('.mb-sub') || {}).value || '',
        description: (row.querySelector('.mb-desc') || {}).value || '',
        imagePath: (row.querySelector('.mb-img') || {}).value || '',
        ctaText: (row.querySelector('.mb-cta-t') || {}).value || '',
        ctaUrl: (row.querySelector('.mb-cta-u') || {}).value || '',
        sortOrder: parseInt((row.querySelector('.mb-sort') || {}).value, 10) || 0,
        enabled: (row.querySelector('.mb-enabled') || {}).value === '1' ? 1 : 0
    };
}

function marketingRenderBannerRows(rows) {
    const root = document.getElementById('mkt-banner-rows');
    if (!root) return;
    __marketingBanners = rows || [];
    root.innerHTML = '';
    __marketingBanners.forEach((b, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'mkt-banner-row';
        wrap.dataset.id = b.id || '';
        wrap.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px;background:#f8fafc;';
        wrap.innerHTML = `
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;">
                <strong>Banner #${idx + 1}</strong>
                <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.75rem;background:#64748b;" onclick="marketingMoveBanner(this,-1)">↑</button>
                <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.75rem;background:#64748b;" onclick="marketingMoveBanner(this,1)">↓</button>
                <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.75rem;background:#b91c1c;margin-left:auto;" onclick="marketingDeleteBanner(this)">Delete</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div><label style="font-size:0.75rem;">Title</label><input class="mb-title" style="width:100%" value="${(b.title || '').replace(/"/g, '&quot;')}"></div>
                <div><label style="font-size:0.75rem;">Subtitle</label><input class="mb-sub" style="width:100%" value="${(b.subtitle || '').replace(/"/g, '&quot;')}"></div>
                <div style="grid-column:1/-1;"><label style="font-size:0.75rem;">Description</label><textarea class="mb-desc" rows="2" style="width:100%">${b.description || ''}</textarea></div>
                <div style="grid-column:1/-1;"><label style="font-size:0.75rem;">Image path</label><input class="mb-img" style="width:100%" value="${(b.imagePath || '').replace(/"/g, '&quot;')}"></div>
                <div><label style="font-size:0.75rem;">CTA text</label><input class="mb-cta-t" style="width:100%" value="${(b.ctaText || '').replace(/"/g, '&quot;')}"></div>
                <div><label style="font-size:0.75rem;">CTA URL</label><input class="mb-cta-u" style="width:100%" value="${(b.ctaUrl || '').replace(/"/g, '&quot;')}"></div>
                <div><label style="font-size:0.75rem;">Sort</label><input class="mb-sort" type="number" style="width:100%" value="${b.sortOrder != null ? b.sortOrder : idx}"></div>
                <div><label style="font-size:0.75rem;">Enabled</label><select class="mb-enabled" style="width:100%"><option value="1" ${b.enabled !== 0 ? 'selected' : ''}>Yes</option><option value="0" ${b.enabled === 0 ? 'selected' : ''}>No</option></select></div>
            </div>
            <div style="margin-top:8px;"><input type="file" class="mb-file"><button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;margin-left:8px;background:#0d9488;" onclick="marketingUploadBannerImage(this)">Upload image</button>
            <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;margin-left:6px;" onclick="marketingSaveBannerRow(this)">Save banner</button></div>`;
        root.appendChild(wrap);
    });
}

async function loadAdminMarketing() {
    const root = document.getElementById('mkt-banner-rows');
    if (!root) return;
    try {
        const [bRes, pRes] = await Promise.all([
            fetch('/api/admin/homepage-banners'),
            fetch('/api/admin/site-popup')
        ]);
        const banners = await bRes.json();
        const meta = await pRes.json();
        marketingRenderBannerRows(Array.isArray(banners) ? banners : []);
        const popup = (meta && meta.popup) || {};
        const carousel = (meta && meta.carousel) || {};
        const ms = document.getElementById('mkt-carousel-ms');
        if (ms) ms.value = carousel.autoSlideMs || 5500;
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val != null ? val : '';
        };
        set('mkt-popup-enabled', popup.enabled ? '1' : '0');
        set('mkt-popup-mode', popup.showMode || 'once_session');
        set('mkt-popup-delay', popup.delaySeconds || 0);
        set('mkt-popup-image', popup.imagePath || '');
        set('mkt-popup-heading', popup.heading || '');
        set('mkt-popup-body', popup.body || '');
        set('mkt-popup-cta-text', popup.ctaText || '');
        set('mkt-popup-cta-url', popup.ctaUrl || '');
    } catch (e) {
        console.error(e);
        marketingSetMsg('Could not load marketing settings.', false);
    }
}

function marketingAddBannerRow() {
    marketingRenderBannerRows(
        __marketingBanners.concat([
            {
                title: '',
                subtitle: '',
                description: '',
                imagePath: '',
                ctaText: '',
                ctaUrl: '',
                sortOrder: __marketingBanners.length,
                enabled: 1
            }
        ])
    );
}

async function marketingUploadBannerImage(btn) {
    const row = btn.closest('.mkt-banner-row');
    const fileInp = row && row.querySelector('.mb-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    if (path && row) (row.querySelector('.mb-img') || {}).value = path;
}

async function marketingUploadPopupImage() {
    const path = await uploadAdminAssetFromInput(document.getElementById('mkt-popup-file'));
    if (path) {
        const el = document.getElementById('mkt-popup-image');
        if (el) el.value = path;
    }
}

async function marketingSaveBannerRow(btn) {
    const row = btn.closest('.mkt-banner-row');
    const payload = marketingReadRow(row);
    if (!payload || !payload.imagePath) return marketingSetMsg('Image path is required for each banner.', false);
    try {
        const isNew = !payload.id;
        const res = await fetch(
            isNew ? '/api/admin/homepage-banners' : '/api/admin/homepage-banners/' + payload.id,
            {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }
        );
        const data = await res.json();
        if (!res.ok) return marketingSetMsg(data.error || 'Save failed', false);
        marketingSetMsg('Banner saved.', true);
        await loadAdminMarketing();
    } catch (e) {
        marketingSetMsg(e.message || 'Save failed', false);
    }
}

async function marketingDeleteBanner(btn) {
    const row = btn.closest('.mkt-banner-row');
    const id = row && row.dataset.id;
    if (!id) {
        row.remove();
        return;
    }
    if (!confirm('Delete this banner?')) return;
    try {
        const res = await fetch('/api/admin/homepage-banners/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return marketingSetMsg(data.error || 'Delete failed', false);
        await loadAdminMarketing();
        marketingSetMsg('Banner deleted.', true);
    } catch (e) {
        marketingSetMsg(e.message || 'Delete failed', false);
    }
}

async function marketingMoveBanner(btn, dir) {
    const root = document.getElementById('mkt-banner-rows');
    if (!root) return;
    const rows = Array.from(root.querySelectorAll('.mkt-banner-row'));
    const row = btn.closest('.mkt-banner-row');
    const i = rows.indexOf(row);
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    if (dir < 0) root.insertBefore(row, rows[j]);
    else root.insertBefore(rows[j], row);
    const order = Array.from(root.querySelectorAll('.mkt-banner-row')).map((r, idx) => ({
        id: parseInt(r.dataset.id, 10),
        sortOrder: idx
    })).filter((x) => x.id);
    if (!order.length) return;
    try {
        await fetch('/api/admin/homepage-banners/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        await loadAdminMarketing();
    } catch (e) {
        console.error(e);
    }
}

async function saveAdminSitePopup() {
    const popup = {
        enabled: (document.getElementById('mkt-popup-enabled') || {}).value === '1',
        showMode: (document.getElementById('mkt-popup-mode') || {}).value || 'once_session',
        delaySeconds: parseInt((document.getElementById('mkt-popup-delay') || {}).value, 10) || 0,
        imagePath: (document.getElementById('mkt-popup-image') || {}).value || '',
        heading: (document.getElementById('mkt-popup-heading') || {}).value || '',
        body: (document.getElementById('mkt-popup-body') || {}).value || '',
        ctaText: (document.getElementById('mkt-popup-cta-text') || {}).value || '',
        ctaUrl: (document.getElementById('mkt-popup-cta-url') || {}).value || ''
    };
    const carousel = {
        autoSlideMs: parseInt((document.getElementById('mkt-carousel-ms') || {}).value, 10) || 5500
    };
    try {
        const res = await fetch('/api/admin/site-popup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ popup, carousel })
        });
        const data = await res.json();
        marketingSetMsg(res.ok && data.success ? 'Popup & carousel settings saved.' : data.error || 'Save failed', !!(res.ok && data.success));
    } catch (e) {
        marketingSetMsg(e.message || 'Save failed', false);
    }
}

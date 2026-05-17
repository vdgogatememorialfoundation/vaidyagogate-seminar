window.__adminUsersById = {};
let __adminLoginPhoneOtpToken = null;
let __adminLoginEmailOtpToken = null;
let __adminBehalfSaveTimer = null;

function getStoredAdminUser() {
    try {
        return JSON.parse(localStorage.getItem('admin_user') || '{}');
    } catch (_) {
        return {};
    }
}

function isSuperAdminUser() {
    const u = getStoredAdminUser();
    return String(u.role || '').toLowerCase() === 'admin' && String(u.user_role || '').toLowerCase() !== 'co_admin';
}

function coAdminCanAccessTab(tabId) {
    let checkId = tabId === 'tab-seminar-details' ? 'tab-seminars' : tabId;
    if (checkId === 'tab-users') checkId = 'tab-staff-users';
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
        if (!coAdminCanAccessTab(m)) el.classList.add('hidden');
        else el.classList.remove('hidden');
    });
}

async function refreshAdminLoginOtpPanel() {
    const panel = document.getElementById('admin_login_otp_panel');
    if (!panel) return;
    try {
        const res = await fetch('/api/auth/login-otp-required');
        const d = await res.json();
        panel.style.display = d.required ? 'block' : 'none';
    } catch (_) {
        panel.style.display = 'none';
    }
}

window.onload = () => {
    refreshAdminLoginOtpPanel();
    if (localStorage.getItem('admin_auth')) {
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('dashboard-main').classList.remove('hidden');
        loadAllData();
        applyCoAdminSidebarVisibility();
    }
};

function wireAdminLoginOtpButtons() {
    const sendE = document.getElementById('admin-send-login-email-otp');
    const sendP = document.getElementById('admin-send-login-phone-otp');
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
    const body = { email, password };
    const lo = document.getElementById('admin_login_otp_panel');
    if (lo && lo.style.display === 'block') {
        body.phoneOtpToken = __adminLoginPhoneOtpToken;
        body.emailOtpToken = __adminLoginEmailOtpToken;
    }
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
    if (!coAdminCanAccessTab(tabId)) {
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
    const ur = String(u.user_role || u.role || 'doctor').toLowerCase();
    return ur === 'doctor';
}

function adminUserStatusBadge(u) {
    return u.is_disabled
        ? `<span style="color:red;font-weight:bold;">DISABLED</span>`
        : `<span style="color:green;font-weight:bold;">ACTIVE</span>`;
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
    if (roleSel) {
        Array.from(roleSel.options).forEach((opt) => {
            if (!opt.value) return;
            const isDoc = opt.value === 'doctor';
            opt.hidden = kind === 'doctor' ? !isDoc : isDoc;
        });
        roleSel.value = kind === 'doctor' ? 'doctor' : 'judge_user';
    }
    const title = modal.querySelector('h2');
    if (title) title.textContent = kind === 'doctor' ? 'Register new doctor' : 'Register new staff user';
    modal.classList.remove('hidden');
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

        const staff = [];
        const doctors = [];
        users.forEach((u) => {
            window.__adminUsersById[u.id] = u;
            if (isDoctorAccount(u)) doctors.push(u);
            else staff.push(u);
        });

        if (staffBody) {
            if (!staff.length) {
                staffBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No staff users</td></tr>';
            }
            staff.forEach((u) => {
                const userRole = u.user_role || u.role || '';
                const modulesBtn =
                    isSuperAdminUser() && String(userRole).toLowerCase() === 'co_admin'
                        ? `<button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-left:6px;background:#0d9488;" onclick="openAdminModulesModal(${u.id})">Modules</button>`
                        : '';
                staffBody.innerHTML += `
                <tr>
                    <td><strong>${u.user_id_string}</strong></td>
                    <td>${escAdmin(u.first_name)} ${escAdmin(u.last_name)}</td>
                    <td>${escAdmin(u.email)}</td>
                    <td>
                        <select onchange="updateUserRole(${u.id}, this.value)" style="width:100%;padding:5px;border-radius:4px;border:1px solid #ccc;">
                            <option value="judge_user" ${userRole === 'judge_user' ? 'selected' : ''}>Judge</option>
                            <option value="co_admin" ${userRole === 'co_admin' ? 'selected' : ''}>Co Admin</option>
                            <option value="scanner_portal_user" ${userRole === 'scanner_portal_user' ? 'selected' : ''}>Scanner</option>
                            <option value="reviewer" ${userRole === 'reviewer' ? 'selected' : ''}>Reviewer</option>
                        </select>
                    </td>
                    <td>${adminUserStatusBadge(u)}</td>
                    <td>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-right:6px;" onclick="openAdminUserDetail(${u.id})">View</button>
                        ${adminUserToggleBtn(u)}${modulesBtn}
                    </td>
                </tr>`;
            });
        }

        if (doctorsBody) {
            if (!doctors.length) {
                doctorsBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No doctors registered</td></tr>';
            }
            doctors.forEach((u) => {
                doctorsBody.innerHTML += `
                <tr>
                    <td><strong>${u.user_id_string}</strong></td>
                    <td>${escAdmin(u.first_name)} ${escAdmin(u.last_name)}</td>
                    <td>${escAdmin(u.email)}</td>
                    <td>${escAdmin(u.phone || '—')}</td>
                    <td>${adminUserStatusBadge(u)}</td>
                    <td>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.8rem;margin-right:6px;" onclick="openAdminUserDetail(${u.id})">View</button>
                        ${adminUserToggleBtn(u)}
                    </td>
                </tr>`;
                if (proxySelect) {
            proxySelect.innerHTML += `<option value="${u.id}">${u.first_name} ${u.last_name} (${u.user_id_string})</option>`;
                }
            });
        }
    } catch (err) {
        console.error(err);
    }
}

async function toggleAdminUserDemo(userId, enable) {
    const isDemo = enable === true || enable === 1 || enable === '1' || enable === 'true';
    try {
        const res = await fetch('/api/admin/users/toggle_demo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: parseInt(userId, 10), isDemo })
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
            alert(`Role updated to ${newRole}`);
            loadUsers();
        } else {
            alert('Error: ' + result.error);
        }
    } catch(err) {
        console.error(err);
        alert('Error updating role');
    }
}

const ADMIN_MODULE_TAB_DEFS = [
    ['tab-staff-users', 'Staff users'],
    ['tab-doctors', 'Doctors'],
    ['tab-seminars', 'Seminar management'],
    ['tab-event-schedules', 'Event schedules'],
    ['tab-applications', 'Review applications'],
    ['tab-feedback', 'Seminar feedback'],
    ['tab-support-tickets', 'Support tickets'],
    ['tab-transfer', 'Transfer applications'],
    ['tab-behalf-reg', 'Doctor applications (admin workspace)'],
    ['tab-reg-form', 'Registration form fields'],
    ['tab-site-cms', 'Website & doctor updates'],
    ['tab-admin-payments', 'Orders & receipts'],
    ['tab-certificates', 'Certificate management'],
    ['tab-volunteers', 'Volunteers'],
    ['tab-case-mgmt', 'Case management'],
    ['tab-reports', 'Reports & exports'],
    ['tab-scanner-logs', 'Scanner activity'],
    ['tab-notifications', 'Notifications'],
    ['tab-settings', 'Global settings']
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

function scheduleBehalfRegSave() {
    const st = document.getElementById('behalf-save-status');
    if (st) st.textContent = 'Waiting to save…';
    if (__adminBehalfSaveTimer) clearTimeout(__adminBehalfSaveTimer);
    __adminBehalfSaveTimer = setTimeout(flushBehalfRegistrationSave, 750);
}

async function flushBehalfRegistrationSave() {
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
        formData = JSON.parse(String((ta || {}).value || '{}'));
    } catch (_) {
        if (st) st.textContent = 'Invalid JSON — fix syntax to save.';
        return;
    }
    const adm = getStoredAdminUser();
    if (!adm || !adm.id) {
        if (st) st.textContent = 'Not logged in.';
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
                adminUserId: adm.id
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            if (st) st.textContent = data.error || 'Save failed.';
            return;
        }
        if (st)
            st.textContent = `Saved ${data.created ? '(new application)' : '(updated)'} at ${new Date().toLocaleTimeString()}`;
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
        ta.addEventListener('input', scheduleBehalfRegSave);
        ds.addEventListener('change', scheduleBehalfRegSave);
        ss.addEventListener('change', scheduleBehalfRegSave);
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
    const userRole = document.getElementById('newuser-role')?.value || 'doctor';
    
    if (!firstName || !lastName || !email || !phone || !userRole) {
        alert('Please fill all required fields');
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
    
    const data = {
        firstName,
        lastName,
        email,
        phone,
        role: userRole
    };
    if (useCustom) data.password = customPass.trim();

    try {
        const res = await fetch('/api/admin/users/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
            const finalPassword = result.generatedPassword || customPass;
            await sendCredentialsToNewUser(email, phone, firstName, result.user_id_string, finalPassword);

            const prev = document.getElementById('newuser-generated-preview');
            const prevText = document.getElementById('newuser-generated-text');
            if (prev && prevText) {
                prevText.textContent = finalPassword;
                prev.style.display = 'block';
            }

            alert(
                `User created.\n\nUser ID: ${result.user_id_string}\nPassword: ${finalPassword}\n\nEmail and WhatsApp notifications were queued (if Zoho / WhatsApp are configured).\n\n(Copy from the green box in this dialog if needed.)`
            );

            document.getElementById('newuser-first').value = '';
            document.getElementById('newuser-last').value = '';
            document.getElementById('newuser-email').value = '';
            document.getElementById('newuser-phone').value = '';
            if (document.getElementById('newuser-pass')) document.getElementById('newuser-pass').value = '';
            loadUsers();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        console.error(err);
        alert('Error creating user');
    }
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
        switchAdminUserDetailTab('profile');
    } catch (e) {
        console.error(e);
        if (body) body.innerHTML = '<p style="color:#b91c1c;">Network error</p>';
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
                    <h4>Account</h4>
                    <p><strong>User ID:</strong> ${escAdmin(u.user_id_string)}</p>
                    <p><strong>Name:</strong> ${escAdmin(u.first_name)} ${escAdmin(u.middle_name || '')} ${escAdmin(u.last_name)}</p>
                    <p><strong>Email:</strong> ${escAdmin(u.email)}</p>
                    <p><strong>Phone:</strong> ${escAdmin(u.phone)}</p>
                    <p><strong>Password (stored):</strong> <code>${escAdmin(u.password)}</code></p>
                    <p><strong>Role:</strong> ${escAdmin(u.user_role || u.role)}</p>
                    <p><strong>Status:</strong> ${u.is_disabled ? 'Disabled' : 'Active'}</p>
                    ${window.__adminProductionSite ? '' : `<p><strong>Demo account:</strong> ${Number(u.is_demo) === 1 ? 'Yes — any 4-digit OTP works' : 'No'}</p>
                    <button type="button" class="btn-primary" style="margin-top:10px;background:#7c3aed;" onclick="toggleAdminUserDemo(${u.id}, ${Number(u.is_demo) === 1 ? 'false' : 'true'})">${Number(u.is_demo) === 1 ? 'Remove demo mode' : 'Mark as demo user'}</button>`}
                    <p><strong>Joined:</strong> ${escAdmin(u.created_at)}</p>
                </div>
                <div>
                    <h4>Doctor profile</h4>
                    ${
                        p
                            ? `<p><strong>Address:</strong> ${escAdmin(p.address || p.residential_address || '')}</p>
                    <p><strong>City / State / PIN:</strong> ${escAdmin(p.city || '')} ${escAdmin(p.state || '')} ${escAdmin(p.pincode || p.pin || '')}</p>
                    <p><strong>Qualification:</strong> ${escAdmin(p.qualification || '')}</p>
                    <p><strong>NCISM:</strong> ${escAdmin(p.ncism_id || p.registration_id || '')}</p>`
                            : '<p style="color:#94a3b8;">No extended profile saved yet.</p>'
                    }
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
        let rows = '';
        (d.orders || []).forEach((o) => {
            rows += `<tr>
                <td>${escAdmin(o.order_id_string)}</td>
                <td>${escAdmin(o.seminar_title)}</td>
                <td>₹${escAdmin(o.amount)} · ${escAdmin(o.status)}</td>
                <td>${escAdmin(o.ticket_id_string || '—')}</td>
                <td>${o.is_scanned ? 'Yes ' + escAdmin(o.scan_time || '') : 'No'}</td>
            </tr>`;
        });
        body.innerHTML = `<table class="data-table"><thead><tr><th>Order</th><th>Seminar</th><th>Payment</th><th>E-ticket</th><th>Scanned</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No orders</td></tr>'}</tbody></table>`;
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
        const res = await fetch(`/api/admin/certificates/candidates?seminarId=${encodeURIComponent(sid)}`);
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) {
            tbody.innerHTML =
                '<tr><td colspan="9" style="text-align:center;">No registrations for this seminar yet.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        rows.forEach((r) => {
            const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '—';
            const paid = r.order_status === 'success' ? 'Yes' : 'No';
            const checked = r.is_scanned ? 'Yes' : 'No';
            const cert = r.cert_enabled ? 'Enabled' : 'Locked';
            tbody.innerHTML += `<tr>
                <td><input type="checkbox" class="cert-cand-cb" data-user-id="${r.user_id}" value="${r.user_id}"></td>
                <td>${escAdmin(r.user_id_string)}</td>
                <td>${escAdmin(name)}</td>
                <td>${escAdmin(r.application_no || '—')}</td>
                <td>${escAdmin(r.reg_status || '—')}</td>
                <td>${paid}</td>
                <td>${checked}</td>
                <td><code>${escAdmin(r.ticket_id_string || '—')}</code></td>
                <td>${cert}</td>
            </tr>`;
        });
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
            body: JSON.stringify({ seminarId: parseInt(sid, 10), userIds, enabled: !!enabled })
        });
        const data = await res.json();
        if (data.success) {
            loadAdminCertificateCandidates();
            if (enabled && data.templateMissing) {
                alert(
                    'Certificate enabled for selected doctors.\n\nUpload a participant certificate template in this tab (image/PDF) — until then, doctors will see “approved” but cannot download the certificate yet.'
                );
            }
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
        alert('Network error');
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
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No volunteers assigned</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        rows.forEach((v) => {
            const name = [v.first_name, v.last_name].filter(Boolean).join(' ');
            let actions = '';
            if (v.status === 'pending') {
                actions = `<button type="button" class="btn-primary" style="padding:4px 8px;font-size:0.8rem;" onclick="approveAdminVolunteer(${v.id})">Approve &amp; issue ticket</button>`;
            }
            tbody.innerHTML += `<tr>
                <td>${escAdmin(name)}<div class="muted">${escAdmin(v.user_id_string)} · ${escAdmin(v.email)}</div></td>
                <td>${escAdmin(v.status)}</td>
                <td><code>${escAdmin(v.volunteer_ticket_id_string || '—')}</code></td>
                <td>${escAdmin(v.notes || '—')}</td>
                <td>${actions || '—'}</td>
            </tr>`;
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="5">Error</td></tr>';
    }
}

async function addAdminVolunteer() {
    const sid = document.getElementById('vol-mgmt-seminar')?.value;
    const userIdString = String(document.getElementById('vol-mgmt-user-id')?.value || '').trim();
    const notes = document.getElementById('vol-mgmt-notes')?.value || '';
    if (!sid || !userIdString) return alert('Seminar and doctor portal User ID required');
    try {
        const res = await fetch('/api/admin/volunteers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seminarId: parseInt(sid, 10), userIdString, notes })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('vol-mgmt-user-id').value = '';
            loadAdminVolunteers();
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
    }
}

async function approveAdminVolunteer(volId) {
    const admin = getStoredAdminUser();
    if (!confirm('Approve volunteer and create free registration + ticket?')) return;
    try {
        const res = await fetch(`/api/admin/volunteers/${volId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminUserId: admin?.id })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || 'Approved');
            loadAdminVolunteers();
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
    if (mm) mm.value = '50';
    const ag = document.getElementById('case-cat-agnikarma');
    const vi = document.getElementById('case-cat-viddhakarma');
    if (ag) ag.checked = true;
    if (vi) vi.checked = true;
    const act = document.getElementById('case-prog-active');
    if (act) act.checked = true;
    setCaseProgMsg('', true);
    loadCaseProgramDefaultFields();
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
        document.getElementById('case-prog-start').value = (p.registration_start || '').slice(0, 16);
        document.getElementById('case-prog-end').value = (p.registration_end || '').slice(0, 16);
        document.getElementById('case-prog-max-per-user').value = String(p.maxPresentationsPerUser != null ? p.maxPresentationsPerUser : p.max_presentations_per_user != null ? p.max_presentations_per_user : 2);
        document.getElementById('case-prog-max-total').value = p.maxTotalSubmissions != null ? String(p.maxTotalSubmissions) : p.max_total_submissions != null ? String(p.max_total_submissions) : '';
        document.getElementById('case-prog-max-files').value = String(p.maxFilesPerSubmission != null ? p.maxFilesPerSubmission : p.max_files_per_submission != null ? p.max_files_per_submission : 5);
        document.getElementById('case-prog-max-mb').value = String(p.maxFileSizeMb != null ? p.maxFileSizeMb : p.max_file_size_mb != null ? p.max_file_size_mb : 50);
        const cats = p.enabledCategories || [];
        document.getElementById('case-cat-agnikarma').checked = cats.indexOf('agnikarma') !== -1;
        document.getElementById('case-cat-viddhakarma').checked = cats.indexOf('viddhakarma') !== -1;
        document.getElementById('case-prog-active').checked = p.is_active !== 0;
        renderCaseProgramFieldsEditor((p.formConfig && p.formConfig.fields) || []);
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
        if (!rows.length) {
            panel.innerHTML = '<p style="color:#64748b;">No scored submissions yet.</p>';
            return;
        }
        let topScore = null;
        rows.forEach((r) => {
            const s = r.avg_score != null ? Number(r.avg_score) : null;
            if (s != null && (topScore == null || s > topScore)) topScore = s;
        });
        let html =
            '<table class="data-table"><thead><tr><th>Rank</th><th>App</th><th>Doctor</th><th>Topic</th><th>Avg / 25</th><th>Judges</th><th>Status</th></tr></thead><tbody>';
        rows.forEach((r, idx) => {
            const avg = r.avg_score != null ? Number(r.avg_score) : null;
            const isTop = avg != null && topScore != null && avg === topScore && (r.judges_scored || 0) > 0;
            const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
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
                escAdmin(r.status || '—') +
                '</td></tr>';
        });
        html += '</tbody></table>';
        panel.innerHTML = html;
        window.__caseCriteriaDefs = criteria;
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
        if (!Array.isArray(rows) || !rows.length) {
            box.innerHTML = '<p style="color:#64748b;">No programs yet. Fill the form above and click Save program.</p>';
            return;
        }
        box.innerHTML = '<h4 style="margin:0 0 10px;">Saved programs</h4>';
        rows.forEach(function (p) {
            const used = p.submissionCount != null ? p.submissionCount : p.submission_count || 0;
            const capMax = p.maxTotalSubmissions != null ? p.maxTotalSubmissions : p.max_total_submissions;
            const cap = capMax != null ? ' · ' + used + '/' + capMax + ' slots' : ' · ' + used + ' submission(s)';
            box.innerHTML += '<div style="padding:10px 0;border-bottom:1px solid #e2e8f0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;"><div><strong>' +
                String(p.title || '').replace(/</g, '&lt;') + '</strong><span style="color:#64748b;font-size:0.85rem;"> · ' +
                String(p.registration_start || '—').replace(/</g, '&lt;') + ' → ' + String(p.registration_end || '—').replace(/</g, '&lt;') + cap +
                '</span></div><span><button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#64748b;" onclick="editAdminCaseProgram(' + p.id + ')">Edit</button> <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#b91c1c;" onclick="deleteAdminCaseProgram(' + p.id + ', \'' + String(p.title || '').replace(/'/g, "\\'") + '\')">Delete</button></span></div>';
        });

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
        registrationStart: (document.getElementById('case-prog-start') || {}).value || null,
        registrationEnd: (document.getElementById('case-prog-end') || {}).value || null,
        maxPresentationsPerUser: (document.getElementById('case-prog-max-per-user') || {}).value || 2,
        maxTotalSubmissions: (document.getElementById('case-prog-max-total') || {}).value || null,
        maxFilesPerSubmission: (document.getElementById('case-prog-max-files') || {}).value || 5,
        maxFileSizeMb: (document.getElementById('case-prog-max-mb') || {}).value || 50,
        enabledCategories: enabledCategories,
        isActive: document.getElementById('case-prog-active') ? document.getElementById('case-prog-active').checked !== false : true,
        formConfig: collectCaseProgramFormConfig()
    };
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
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No submissions</td></tr>';
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
        const scores = scoresRes.ok ? await scoresRes.json() : [];
        const sub = data.submission;
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
            ? '<p style="margin:8px 0;"><strong>Assigned:</strong> ' +
              assigned
                  .map((j) => escAdmin(j.first_name) + ' ' + escAdmin(j.last_name) + ' (' + escAdmin(j.user_id_string) + ')')
                  .join(', ') +
              '</p>'
            : '';
        let html = `<h3>Application <code>${escAdmin(sub.application_no || sub.id)}</code></h3>
            <p class="muted">${escAdmin(sub.first_name)} ${escAdmin(sub.last_name)} · ${escAdmin(sub.category)} · ${escAdmin(sub.status)}</p>
            <p><strong>Topic:</strong> ${escAdmin(sub.title)}</p>
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
        if (Array.isArray(scores) && scores.length) {
            const critDefs = window.__caseCriteriaDefs || [];
            html +=
                '<h4 style="margin-top:16px;">Judge scores (criteria + total)</h4><table class="data-table"><thead><tr><th>Judge</th><th>Criteria breakdown</th><th>Total / 25</th><th>Locked</th></tr></thead><tbody>';
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

async function loadAdminScannerLogs() {
    const tbody = document.getElementById('scanner-logs-list');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading…</td></tr>';
    const sid = document.getElementById('scanner-log-seminar')?.value || '';
    const q = sid ? `?seminarId=${encodeURIComponent(sid)}` : '';
    try {
        const res = await fetch('/api/admin/scanner/logs' + q);
        const rows = await res.json();
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No scans yet</td></tr>';
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
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7">Error</td></tr>';
    }
}

async function initAdminScannerLogsTab() {
    await fillAdminSeminarSelect('scanner-log-seminar', true);
    await loadAdminScannerLogs();
}

async function toggleDisable(userId, disable) {
    if(!confirm(`Are you sure you want to ${disable ? 'disable' : 'enable'} this user?`)) return;
    try {
        await fetch('/api/admin/users/toggle_disable', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ userId, disable })
        });
        loadUsers();
    } catch(err) { console.error(err); }
}

let globalAdminApps = [];

async function loadApplications() {
    try {
        const res = await fetch('/api/admin/applications');
        const apps = await res.json();
        globalAdminApps = apps;
        const tbody = document.getElementById('applications-list');
        tbody.innerHTML = '';

        apps.forEach((a, index) => {
            let formData = {};
            try { formData = JSON.parse(a.form_data || '{}'); } catch(e){}
            
            const fileLink = formData.certificate_path ? `<br><a href="/uploads/${formData.certificate_path}" target="_blank" style="color:blue;font-size:0.8rem;">📄 View Certificate</a>` : '';
            const candidateName = formData.fname ? `${formData.fname} ${formData.lname || ''}` : `${a.first_name || ''} ${a.last_name || ''}`;

            tbody.innerHTML += `
                <tr>
                    <td>
                        <strong>${a.application_no}</strong>
                        <div style="margin-top: 5px;"><img src="/api/qrcode/${a.application_no}" style="width: 40px; height: 40px;"></div>
                    </td>
                    <td>${a.user_id_string}</td>
                    <td>${candidateName}${fileLink}</td>
                    <td>
                        <select onchange="updateAppStatus(${a.id}, this.value)" style="width: auto;">
                            <option value="submitted" ${a.status==='submitted'?'selected':''}>Submitted</option>
                            <option value="approved_pending_payment" ${a.status==='approved_pending_payment'?'selected':''}>Approved (Pending Pay)</option>
                            <option value="completed" ${a.status==='completed'?'selected':''}>Payment Completed</option>
                            <option value="rejected" ${a.status==='rejected'?'selected':''}>Rejected</option>
                            <option value="checked_in" ${a.status==='checked_in'?'selected':''}>Checked In</option>
                        </select>
                    </td>
                    <td>
                        <button class="btn-primary" onclick="viewFullApplication(${index})">View</button>
                        <button type="button" class="btn-primary" style="margin-left:6px;background:#b91c1c;padding:4px 8px;font-size:0.8rem;" onclick="deleteAdminRegistration(${a.id}, '${String(a.application_no || '').replace(/'/g, "\\'")}')">Delete</button>
                    </td>
                </tr>
            `;
        });
    } catch(err) { console.error(err); }
}

function viewFullApplication(index) {
    const a = globalAdminApps[index];
    let formData = {};
    try { formData = JSON.parse(a.form_data || '{}'); } catch(e){}
    
    const content = document.getElementById('admin-view-content');
    content.innerHTML = `
        <p><strong>App No:</strong> ${a.application_no}</p>
        <p><strong>Status:</strong> ${a.status.toUpperCase()}</p>
        <hr style="margin:10px 0;">
        <p><strong>Name:</strong> ${formData.fname||''} ${formData.lname||''}</p>
        <p><strong>Email:</strong> ${formData.email||''}</p>
        <p><strong>Phone:</strong> ${formData.phone||''}</p>
        <p><strong>Address:</strong> ${formData.address||''}, ${formData.city||''}, ${formData.state||''} - ${formData.pin||''}</p>
        <hr style="margin:10px 0;">
        <p><strong>Qualification:</strong> ${formData.qual||''}</p>
        <p><strong>Registration ID:</strong> ${formData.ncism||''}</p>
        <p><strong>College:</strong> ${formData.college||''}, ${formData.ccity||''}</p>
    `;
    
    document.getElementById('admin-view-modal').classList.remove('hidden');
    document.getElementById('admin-view-modal').style.display = 'flex';
}

async function updateAppStatus(appId, status) {
    try {
        await fetch('/api/admin/applications/status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ applicationId: appId, status })
        });
        alert('Status updated successfully! If approved, an Order has been auto-generated for payment.');
    } catch(err) { console.error(err); }
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
        set('int-wa-lang', s.whatsapp_template_lang || 'en');
        const line = document.getElementById('int-status-line');
        if (line) {
            line.textContent =
                (s.email_configured ? 'Email: configured. ' : 'Email: not configured. ') +
                (s.whatsapp_configured ? 'WhatsApp: configured.' : 'WhatsApp: not configured.');
        }
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
        whatsapp_verify_token: (document.getElementById('int-wa-verify') || {}).value,
        whatsapp_template_lang: (document.getElementById('int-wa-lang') || {}).value.trim() || 'en'
    };
    try {
        const res = await fetch('/api/admin/integrations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Save failed');
        (document.getElementById('int-zoho-pass') || {}).value = '';
        (document.getElementById('int-wa-token') || {}).value = '';
        (document.getElementById('int-wa-verify') || {}).value = '';
        await loadIntegrationSettings();
        alert('API keys saved and applied.');
    } catch (e) {
        alert('Save failed');
    }
}

async function testIntegrationEmail() {
    const to = (document.getElementById('int-test-email') || {}).value.trim();
    if (!to) return alert('Enter test email address');
    const res = await fetch('/api/admin/integrations/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to })
    });
    const data = await res.json();
    alert(res.ok ? 'Test email sent.' : data.error || 'Failed');
}

async function testIntegrationWhatsApp() {
    const phone = (document.getElementById('int-test-phone') || {}).value.trim();
    if (!phone) return alert('Enter test phone number');
    const res = await fetch('/api/admin/integrations/test-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
    });
    const data = await res.json();
    alert(res.ok ? 'Test WhatsApp sent.' : data.error || 'Failed');
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
                document.getElementById('pg-razorpay-live-enabled').checked = !!live.enabled;
                document.getElementById('pg-razorpay-active').checked = pg.is_active;
            } else if (pg.name === 'payu') {
                document.getElementById('pg-payu-merchant-key').value = config.merchant_key || '';
                document.getElementById('pg-payu-merchant-salt').value = config.merchant_salt || '';
                document.getElementById('pg-payu-merchant-id').value = config.merchant_id || '';
                document.getElementById('pg-payu-active').checked = pg.is_active;
            } else if (pg.name === 'easebuzz') {
                document.getElementById('pg-easebuzz-merchant-key').value = config.merchant_key || '';
                document.getElementById('pg-easebuzz-merchant-salt').value = config.merchant_salt || '';
                document.getElementById('pg-easebuzz-active').checked = pg.is_active;
            } else if (pg.name === 'paytm') {
                document.getElementById('pg-paytm-merchant-id').value = config.merchant_id || '';
                document.getElementById('pg-paytm-merchant-key').value = config.merchant_key || '';
                document.getElementById('pg-paytm-website').value = config.website || '';
                document.getElementById('pg-paytm-active').checked = pg.is_active;
            } else if (pg.name === 'phonepe') {
                document.getElementById('pg-phonepe-merchant-id').value = config.merchant_id || '';
                document.getElementById('pg-phonepe-salt-key').value = config.salt_key || '';
                document.getElementById('pg-phonepe-active').checked = pg.is_active;
            } else if (pg.name === 'cashfree') {
                document.getElementById('pg-cashfree-app-id').value = config.app_id || '';
                document.getElementById('pg-cashfree-secret-key').value = config.secret_key || '';
                document.getElementById('pg-cashfree-active').checked = pg.is_active;
            }
        });
    } catch(err) { console.error(err); }
}

async function saveSiteConfigSettings() {
    const settings = [
        { key: 'site_name', value: document.getElementById('setting-sitename').value },
        { key: 'domain', value: document.getElementById('setting-domain').value },
        { key: 'payment_gateway', value: document.getElementById('setting-pg').value }
    ];
    try {
        await fetch('/api/admin/global_settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        alert('Site configuration saved.');
    } catch (err) {
        console.error(err);
    }
}

async function saveKillSwitchSettings() {
    const settings = [{ key: 'is_site_disabled', value: document.getElementById('setting-disabled').value }];
    try {
        await fetch('/api/admin/global_settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        alert('Maintenance / kill switch saved.');
    } catch (err) {
        console.error(err);
    }
}
        
async function savePaymentGatewaysSettings() {
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
            { name: 'payu', is_active: document.getElementById('pg-payu-active').checked, config: { merchant_key: document.getElementById('pg-payu-merchant-key').value, merchant_salt: document.getElementById('pg-payu-merchant-salt').value, merchant_id: document.getElementById('pg-payu-merchant-id').value } },
            { name: 'easebuzz', is_active: document.getElementById('pg-easebuzz-active').checked, config: { merchant_key: document.getElementById('pg-easebuzz-merchant-key').value, merchant_salt: document.getElementById('pg-easebuzz-merchant-salt').value } },
            { name: 'paytm', is_active: document.getElementById('pg-paytm-active').checked, config: { merchant_id: document.getElementById('pg-paytm-merchant-id').value, merchant_key: document.getElementById('pg-paytm-merchant-key').value, website: document.getElementById('pg-paytm-website').value } },
            { name: 'phonepe', is_active: document.getElementById('pg-phonepe-active').checked, config: { merchant_id: document.getElementById('pg-phonepe-merchant-id').value, salt_key: document.getElementById('pg-phonepe-salt-key').value } },
            { name: 'cashfree', is_active: document.getElementById('pg-cashfree-active').checked, config: { app_id: document.getElementById('pg-cashfree-app-id').value, secret_key: document.getElementById('pg-cashfree-secret-key').value } }
        ];
    try {
        for (const gw of gateways) {
            await fetch(`/api/admin/payment_gateways/${gw.name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: gw.is_active, config: gw.config })
            });
        }
        alert('Payment gateways saved.');
    } catch (err) {
        console.error(err);
    }
}

async function saveGlobalSettings() {
    await saveSiteConfigSettings();
    await saveKillSwitchSettings();
    await savePaymentGatewaysSettings();
}

async function submitProxyApp() {
    const userId = document.getElementById('proxy-user-select').value;
    if(!userId) return alert('Select a user first.');
    
    const formDataObj = {
        fname: document.getElementById('proxy-fname').value,
        lname: document.getElementById('proxy-lname').value,
        email: document.getElementById('proxy-email').value,
        phone: document.getElementById('proxy-phone').value,
        address: document.getElementById('proxy-addr').value,
        pin: document.getElementById('proxy-pin').value,
        city: document.getElementById('proxy-city').value,
        state: document.getElementById('proxy-state').value,
        qual: document.getElementById('proxy-qual').value,
        ncism: document.getElementById('proxy-ncism').value,
        college: document.getElementById('proxy-college').value,
        ccity: document.getElementById('proxy-ccity').value,
        is_proxy: true
    };

    // Because the backend expects formData as a string if using FormData API, or an object if JSON
    const payload = new FormData();
    payload.append('userId', userId);
    payload.append('seminarId', currentManageSeminarId || 1);
    payload.append('formData', JSON.stringify(formDataObj));

    try {
        const res = await fetch('/api/applications/submit', {
            method: 'POST',
            body: payload
        });
        const result = await res.json();
        if(result.success) {
            alert(`Proxy Application created! ID: ${result.applicationNo}`);
            document.querySelectorAll('#admin-proxy-modal input').forEach(el => el.value = '');
            document.getElementById('admin-proxy-modal').classList.add('hidden');
            if (currentManageSeminarId) manageSeminar(currentManageSeminarId, document.getElementById('detail-seminar-title').innerText.replace("Dashboard: ", ""));
        } else {
            alert(result.error);
        }
    } catch(err) { console.error(err); }
}

async function transferApplication() {
    const appId = document.getElementById('transfer-app-id').value;
    const newUserIdStr = document.getElementById('transfer-user-id').value;

    if(!appId || !newUserIdStr) return alert("Please fill both fields.");

    try {
        const res = await fetch('/api/admin/applications/transfer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ applicationId: appId, newUserIdStr })
        });
        const result = await res.json();
        if(result.success) {
            alert("Application Transferred Successfully!");
            loadApplications();
        } else {
            alert("Transfer failed: " + result.error);
        }
    } catch(err) { console.error(err); }
}

// Seminars Logic
let globalSeminars = [];
window.__adminProductionSite = false;

function summaryCancellationPolicyAdmin(raw) {
    if (!raw) return 'No cancellation policy set for this seminar.';
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!p || typeof p !== 'object') return 'No cancellation policy set for this seminar.';
        const parts = [];
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

function buildCancellationPolicyJsonFromUi() {
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
    if (daysRaw == null && !tiers.length) return null;
    const out = {};
    if (daysRaw != null && !Number.isNaN(daysRaw)) out.noRefundWithinDays = daysRaw;
    if (tiers.length) out.tiers = tiers;
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
    const daysEl = document.getElementById('seminar-cancel-norefund-days');
    const tiersWrap = document.getElementById('seminar-cancel-tiers');
    if (!daysEl || !tiersWrap) return;
    daysEl.value = '';
    tiersWrap.innerHTML = '';
    if (!rawJson || !String(rawJson).trim()) {
        updateSeminarPolicyPreviews();
        return;
    }
    try {
        const p = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        if (p.noRefundWithinDays != null) daysEl.value = p.noRefundWithinDays;
        if (Array.isArray(p.tiers)) {
            p.tiers.forEach((t) => addSeminarCancelTierRow(t.minDaysBeforeEvent, t.refundPercent));
        }
    } catch (_) {}
    updateSeminarPolicyPreviews();
}

async function loadSeminarFormOverrideUi(overrideJson) {
    const tbody = document.getElementById('seminar-reg-override-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    let globalFields = [];
    try {
        const res = await fetch('/api/registration-form-config');
        const data = await res.json();
        globalFields = data.fields || [];
    } catch (_) {}
    let overrideFields = null;
    if (overrideJson && String(overrideJson).trim()) {
        try {
            const parsed = JSON.parse(overrideJson);
            if (parsed && Array.isArray(parsed.fields)) overrideFields = parsed.fields;
        } catch (_) {}
    }
    const byKey = {};
    (overrideFields || []).forEach((f) => {
        if (f && f.key) byKey[f.key] = f;
    });
    tbody.innerHTML = '';
    window.__seminarOverrideFieldKeys = [];
    globalFields.forEach((f, idx) => {
        const ov = byKey[f.key] || {};
        const enabled = ov.enabled != null ? ov.enabled !== false : f.enabled !== false;
        const required = ov.required != null ? !!ov.required : !!f.required;
        const label = ov.label != null && String(ov.label).trim() ? ov.label : f.label || f.key;
        window.__seminarOverrideFieldKeys.push(f.key);
        tbody.innerHTML += `<tr>
            <td><code>${String(f.key).replace(/</g, '&lt;')}</code></td>
            <td><input type="text" class="sem-ov-label" data-idx="${idx}" value="${String(label).replace(/"/g, '&quot;')}" oninput="updateSeminarPolicyPreviews()"></td>
            <td><input type="checkbox" class="sem-ov-en" data-idx="${idx}" ${enabled ? 'checked' : ''} onchange="updateSeminarPolicyPreviews()"></td>
            <td><input type="checkbox" class="sem-ov-req" data-idx="${idx}" ${required ? 'checked' : ''} onchange="updateSeminarPolicyPreviews()"></td>
        </tr>`;
    });
    updateSeminarPolicyPreviews();
}

function buildSeminarFormOverrideJsonFromUi() {
    const tbody = document.getElementById('seminar-reg-override-tbody');
    if (!tbody || !window.__seminarOverrideFieldKeys) return null;
    const fields = [];
    window.__seminarOverrideFieldKeys.forEach((key, idx) => {
        const labelEl = tbody.querySelector(`.sem-ov-label[data-idx="${idx}"]`);
        const enEl = tbody.querySelector(`.sem-ov-en[data-idx="${idx}"]`);
        const reqEl = tbody.querySelector(`.sem-ov-req[data-idx="${idx}"]`);
        fields.push({
            key,
            label: labelEl ? labelEl.value : key,
            enabled: !!(enEl && enEl.checked),
            required: !!(reqEl && reqEl.checked)
        });
    });
    const anyDisabled = fields.some((f) => !f.enabled);
    const anyLabelChange = fields.some((f) => f.label && f.label !== f.key);
    if (!anyDisabled && !anyLabelChange) return null;
    return JSON.stringify({ fields });
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
            formPrev.textContent =
                'Doctors will see: ' +
                (enabled.length
                    ? enabled.map((f) => f.label || f.key).join(', ')
                    : 'no fields (check at least one is enabled)');
        } catch (_) {
            formPrev.textContent = 'Invalid form override.';
        }
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
            alert('Portal year set to ' + year + '. Doctors will see ' + year + ' as current; earlier years appear under Past Seminars.');
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
        const tbody = document.getElementById('seminars-list');
        tbody.innerHTML = '';
        const filtered = (globalSeminars || []).filter(
            (s) => Number(s.portal_year) === adminPortalYear || (!s.portal_year && s.event_date && new Date(s.event_date).getFullYear() === adminPortalYear)
        );
        const past = (globalSeminars || []).filter((s) => Number(s.portal_year) < adminPortalYear);
        
        if (!filtered.length && !past.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No seminars found.</td></tr>';
            return;
        }

        const renderRow = (s, i, pastRow) => {
            const idx = globalSeminars.indexOf(s);
            const checkinStatus = s.checkin_enabled ? `<span style="color:green;font-weight:bold;">Yes (${s.checkin_date || 'Any'})</span>` : `<span style="color:red;">No</span>`;
            const activeStatus = s.is_active ? '' : '<span style="color:red; font-size: 0.8rem;">(Inactive)</span>';
            const yearTag = s.portal_year ? `<span style="font-size:0.75rem;color:#64748b;">${s.portal_year}</span>` : '';
            return `
                <tr style="${pastRow ? 'opacity:0.85;background:#f8fafc;' : ''}">
                    <td>${s.id}</td>
                    <td><strong>${s.title}</strong> ${activeStatus} ${yearTag}</td>
                    <td>${s.event_date ? new Date(s.event_date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                    <td>₹${s.price || 0}</td>
                    <td>${checkinStatus}</td>
                    <td>${pastRow ? '<em>Past year</em>' : 'Current'}</td>
                    <td>
                        <button class="btn-success" style="padding: 5px 10px; font-size: 0.85rem;" onclick="manageSeminar(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Manage</button>
                        <button class="btn-primary" style="padding: 5px 10px; font-size: 0.85rem;" onclick="editSeminar(${idx})">Edit</button>
                        <button type="button" class="btn-primary" style="padding:5px 10px;font-size:0.85rem;background:#b91c1c;margin-left:4px;" onclick="deleteAdminSeminar(${s.id}, '${String(s.title).replace(/'/g, "\\'")}')">Delete</button>
                    </td>
                </tr>`;
        };

        if (filtered.length) {
            tbody.innerHTML += '<tr><td colspan="7" style="background:#ecfdf5;font-weight:700;color:#047857;">Current portal year (' + adminPortalYear + ')</td></tr>';
            filtered.forEach((s) => {
                tbody.innerHTML += renderRow(s, 0, false);
            });
        }
        if (past.length) {
            tbody.innerHTML += '<tr><td colspan="7" style="background:#f1f5f9;font-weight:700;color:#475569;">Past seminars (archive)</td></tr>';
            past.forEach((s) => {
                tbody.innerHTML += renderRow(s, 0, true);
            });
        }
    } catch (err) { console.error(err); }
}

function editSeminar(index) {
    if (!coAdminCanAccessTab('tab-seminars')) {
        alert('You do not have access to seminar management.');
        return;
    }
    const s = globalSeminars[index];
    document.getElementById('seminar-id').value = s.id;
    document.getElementById('seminar-title').value = s.title;
    document.getElementById('seminar-desc').value = s.description || '';
    
    // Format dates for datetime-local
    const formatDt = (dtStr) => dtStr ? new Date(dtStr).toISOString().slice(0, 16) : '';
    document.getElementById('seminar-reg-start').value = formatDt(s.registration_start);
    document.getElementById('seminar-reg-end').value = formatDt(s.registration_end);
    document.getElementById('seminar-event-date').value = formatDt(s.event_date);
    const py = document.getElementById('seminar-portal-year');
    if (py) py.value = s.portal_year || adminPortalYear || new Date().getFullYear();
    
    document.getElementById('seminar-capacity').value = s.capacity || 0;
    document.getElementById('seminar-price').value = s.price || 0;
    document.getElementById('seminar-active').value = s.is_active ? '1' : '0';
    
    document.getElementById('seminar-checkin-enabled').value = s.checkin_enabled ? '1' : '0';
    document.getElementById('seminar-checkin-date').value = s.checkin_date || '';
    const ple = document.getElementById('seminar-public-list-enabled');
    if (ple) ple.value = s.public_list_enabled ? '1' : '0';
    document.getElementById('seminar-location-url').value = s.location_url || '';
    document.getElementById('seminar-terms').value = s.terms_conditions || '';
    const wh = document.getElementById('seminar-whatsapp');
    if (wh) wh.value = s.whatsapp_group_url || '';
    const otp = document.getElementById('seminar-otp-app');
    if (otp) otp.checked = !!Number(s.otp_on_application);
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
        galleryVal = JSON.stringify(JSON.parse(galleryVal || '[]'));
    } catch (_) {
        alert('Gallery paths must be valid JSON array');
        return;
    }
    const regFormOverride = buildSeminarFormOverrideJsonFromUi();
    const cancelPol = buildCancellationPolicyJsonFromUi();
    const data = {
        title: document.getElementById('seminar-title').value,
        description: document.getElementById('seminar-desc').value,
        registration_start: document.getElementById('seminar-reg-start').value,
        registration_end: document.getElementById('seminar-reg-end').value,
        event_date: document.getElementById('seminar-event-date').value,
        capacity: parseInt(document.getElementById('seminar-capacity').value) || 0,
        price: parseFloat(document.getElementById('seminar-price').value) || 0,
        is_active: document.getElementById('seminar-active').value === '1',
        checkin_enabled: document.getElementById('seminar-checkin-enabled').value === '1',
        checkin_date: document.getElementById('seminar-checkin-date').value || null,
        public_list_enabled: document.getElementById('seminar-public-list-enabled')?.value === '1',
        location_url: document.getElementById('seminar-location-url').value || null,
        terms_conditions: document.getElementById('seminar-terms').value || null,
        hero_image_path: (document.getElementById('seminar-hero-image') || {}).value || null,
        flyer_path: (document.getElementById('seminar-flyer') || {}).value || null,
        gallery_paths: galleryVal,
        whatsapp_group_url: (document.getElementById('seminar-whatsapp') || {}).value || null,
        otp_on_application: !!(document.getElementById('seminar-otp-app') || {}).checked,
        cancellation_policy_json: cancelPol,
        registration_form_json: regFormOverride,
        portal_year: parseInt((document.getElementById('seminar-portal-year') || {}).value, 10) || adminPortalYear
    };

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
    if (!coAdminCanAccessTab('tab-seminars')) {
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

function toDatetimeLocalValue(raw) {
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw).replace(' ', 'T').slice(0, 16);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function populateScheduleSeminarSelect(selectedId) {
    const sel = document.getElementById('schedule-seminar');
    if (!sel) return;
    try {
        const res = await fetch('/api/admin/seminars');
        const seminars = await res.json();
        sel.innerHTML = '<option value="">— No seminar link —</option>';
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

async function loadEventSchedules() {
    const tbody = document.getElementById('event-schedules-list');
    if (!tbody) return;
    try {
        const res = await fetch('/api/event-schedules');
        const schedules = await res.json();
        if (!res.ok) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#b91c1c;">${(schedules && schedules.error) || 'Could not load schedules'}</td></tr>`;
            return;
        }
        __eventSchedulesCache = Array.isArray(schedules) ? schedules : [];
        tbody.innerHTML = '';
        if (!__eventSchedulesCache.length) {
            tbody.innerHTML =
                '<tr><td colspan="6" style="text-align:center;">No event schedules yet. Click <strong>+ Create New Schedule</strong>.</td></tr>';
            return;
        }
        __eventSchedulesCache.forEach((s) => {
            const tr = document.createElement('tr');
            const startTime = s.start_time ? new Date(s.start_time).toLocaleString() : '—';
            const endTime = s.end_time ? new Date(s.end_time).toLocaleString() : '—';
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
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#b91c1c;">Network error loading schedules</td></tr>';
    }
}

async function openEventScheduleModal() {
    document.getElementById('schedule-id').value = '';
    document.getElementById('event-schedule-form').reset();
    await populateScheduleSeminarSelect('');
    document.getElementById('event-schedule-modal').classList.remove('hidden');
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
    document.getElementById('schedule-start-time').value = toDatetimeLocalValue(s.start_time);
    document.getElementById('schedule-end-time').value = toDatetimeLocalValue(s.end_time);
    document.getElementById('schedule-location').value = s.location || '';
    document.getElementById('schedule-speaker-name').value = s.speaker_name || '';
    document.getElementById('schedule-speaker-bio').value = s.speaker_bio || '';
    document.getElementById('event-schedule-modal').classList.remove('hidden');
}

async function saveEventSchedule(e) {
    e.preventDefault();
    const id = document.getElementById('schedule-id').value;
    const seminarRaw = document.getElementById('schedule-seminar').value;
    const data = {
        title: document.getElementById('schedule-title').value,
        description: document.getElementById('schedule-description').value,
        seminarId: seminarRaw || null,
        startTime: document.getElementById('schedule-start-time').value,
        endTime: document.getElementById('schedule-end-time').value,
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
        
        const tbody = document.getElementById('feedback-list');
        tbody.innerHTML = '';
        
        if(feedbacks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No feedback for this seminar yet.</td></tr>';
            return;
        }

        feedbacks.forEach(f => {
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
    } catch(err) { console.error(err); }
}

// ==================== SUPPORT TICKETS ====================
let currentViewingTicketId = null;

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
        
        const tbody = document.getElementById('support-tickets-list');
        tbody.innerHTML = '';
        
        if(tickets.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No support tickets.</td></tr>';
            return;
        }

        tickets.forEach(t => {
            const created = new Date(t.created_at).toLocaleDateString();
            const priorityColor = t.priority === 'urgent' ? '#ef4444' : (t.priority === 'high' ? '#f59e0b' : '#3b82f6');
            const statusBg = t.status === 'closed' ? '#cbd5e1' : (t.status === 'resolved' ? '#10b981' : '#fbbf24');
            
            tbody.innerHTML += `
                <tr>
                    <td><strong>${t.ticket_id}</strong></td>
                    <td>${t.first_name} ${t.last_name}</td>
                    <td>${t.subject}</td>
                    <td>${t.category}</td>
                    <td style="color: ${priorityColor}; font-weight: 600;">${t.priority.toUpperCase()}</td>
                    <td style="background: ${statusBg}; padding: 5px; border-radius: 4px;">${t.status}</td>
                    <td>${created}</td>
                    <td><button class="btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="viewSupportTicket('${t.ticket_id}')">View</button></td>
                </tr>
            `;
        });
    } catch(err) { console.error(err); }
}

async function viewSupportTicket(ticketId) {
    try {
        const res = await fetch(`/api/support-ticket/${ticketId}`);
        const ticket = await res.json();
        
        currentViewingTicketId = ticketId;
        
        const infoHtml = `
            <div>
                <p><strong>Ticket ID:</strong> ${ticket.ticket_id}</p>
                <p><strong>Doctor:</strong> ${ticket.first_name} ${ticket.last_name} (${ticket.email})</p>
                <p><strong>Subject:</strong> ${ticket.subject}</p>
                <p><strong>Category:</strong> ${ticket.category}</p>
                <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
                <p><strong>Status:</strong> ${ticket.status}</p>
                <p><strong>Description:</strong> ${ticket.description}</p>
            </div>
        `;
        
        document.getElementById('ticket-info').innerHTML = infoHtml;
        
        const messagesHtml = ticket.messages.map(m => `
            <div style="margin-bottom: 10px; padding: 10px; background: ${m.sender_type === 'admin' ? '#e0e7ff' : '#f0fdf4'}; border-radius: 4px;">
                <strong>${m.sender_type === 'admin' ? '🔵 Admin' : '👤 ' + m.first_name}:</strong> ${m.message}
                <br><small style="color: #64748b;">${new Date(m.created_at).toLocaleString()}</small>
            </div>
        `).join('');
        
        document.getElementById('ticket-messages').innerHTML = messagesHtml || '<p style="text-align: center; color: #94a3b8;">No messages yet</p>';
        document.getElementById('ticket-reply-input').value = '';
        document.getElementById('ticket-detail-modal').classList.remove('hidden');
    } catch(err) { console.error(err); alert('Error loading ticket'); }
}

async function updateTicketStatus() {
    const newStatus = document.getElementById('ticket-status-update').value;
    if(!newStatus || !currentViewingTicketId) return;
    
    try {
        const res = await fetch(`/api/admin/support-ticket/${currentViewingTicketId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, adminId: 1 })
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
    
    try {
        const res = await fetch(`/api/support-ticket/${currentViewingTicketId}/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderId: 1, senderType: 'admin', message: message })
        });
        
        if(res.ok) {
            document.getElementById('ticket-reply-input').value = '';
            viewSupportTicket(currentViewingTicketId);
        }
    } catch(err) { console.error(err); }
}

// Call loading functions when tab changes
function loadAllData() {
    fetch('/api/public/portal-urls')
        .then((r) => r.json())
        .then((u) => {
            window.__adminProductionSite = !!(u && u.production);
        })
        .catch(() => {});
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

async function loadAdminRegistrationFormConfig() {
    const tbody = document.getElementById('admin-reg-fields-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    try {
        const res = await fetch('/api/registration-form-config');
        const data = await res.json();
        const fields = data.fields || [];
        tbody.innerHTML = '';
        fields.forEach((f, idx) => {
            tbody.innerHTML += `<tr>
                <td><code>${String(f.key || '').replace(/</g, '&lt;')}</code></td>
                <td><input type="text" id="reg-field-label-${idx}" value="${String(f.label || '').replace(/"/g, '&quot;')}" style="margin:0;"></td>
                <td><input type="checkbox" id="reg-field-en-${idx}" ${f.enabled !== false ? 'checked' : ''}></td>
                <td><input type="checkbox" id="reg-field-req-${idx}" ${f.required ? 'checked' : ''}></td>
            </tr>`;
        });
        window.__adminRegFieldRows = fields.map((f) => ({
            key: f.key,
            onlyWhenAdvancedQual: f.onlyWhenAdvancedQual
        }));
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
    }
}

async function saveAdminRegistrationFormConfig() {
    const msg = document.getElementById('admin-reg-form-msg');
    if (msg) msg.innerText = '';
    const rows = window.__adminRegFieldRows || [];
    const fields = rows.map((r, idx) => {
        const enabled = !!(document.getElementById(`reg-field-en-${idx}`) || {}).checked;
        return {
        key: r.key,
        label: (document.getElementById(`reg-field-label-${idx}`) || {}).value || r.key,
        enabled,
        required: enabled,
        onlyWhenAdvancedQual:
            typeof r.onlyWhenAdvancedQual === 'boolean'
                ? r.onlyWhenAdvancedQual
                : ['ncism', 'certificate'].indexOf(r.key) !== -1
    };
    });
    try {
        const res = await fetch('/api/admin/registration-form-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });
        const data = await res.json();
        if (data.success) {
            if (msg) {
                msg.style.color = '#15803d';
                msg.innerText = 'Saved.';
            }
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

async function uploadAdminAssetFromInput(fileInputEl) {
    const f = fileInputEl.files && fileInputEl.files[0];
    if (!f) return null;
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch('/api/admin/upload-asset', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (data.success && data.path) return data.path;
    alert(data.error || 'Upload failed');
    return null;
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
                image: (row.querySelector('.cs-img') || {}).value || ''
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

function cmsCollectGalleryFromDom() {
    const root = document.getElementById('cms-gallery-rows');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.cms-gallery-row'))
        .map((row) => ({
            src: (row.querySelector('.cg-src') || {}).value || '',
            caption: (row.querySelector('.cg-cap') || {}).value || '',
            year: (row.querySelector('.cg-year') || {}).value || ''
        }))
        .filter((x) => x.src || x.caption);
}

function cmsFillGalleryRows(items) {
    const root = document.getElementById('cms-gallery-rows');
    if (!root) return;
    root.innerHTML = '';
    (items || []).forEach((it) => cmsAddGalleryRow(it));
}

function cmsAddGalleryRow(prefill) {
    const root = document.getElementById('cms-gallery-rows');
    if (!root) return;
    const p = prefill || {};
    const wrap = document.createElement('div');
    wrap.className = 'cms-gallery-row';
    wrap.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    wrap.innerHTML = `
        <div style="grid-column:1/-1;"><label style="font-size:0.8rem;">Caption</label><input class="cg-cap" type="text" style="width:100%" placeholder="National Seminar 2024"></div>
        <div><label style="font-size:0.8rem;">Year</label><input class="cg-year" type="text" style="width:100%" placeholder="2024"></div>
        <div><label style="font-size:0.8rem;">Image path</label><input class="cg-src" type="text" style="width:100%" placeholder="/uploads/photo.jpg"></div>
        <div style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;">
          <input type="file" class="cg-file" accept="image/*" style="max-width:180px;">
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;" onclick="cmsUploadGalleryImage(this)">Upload image</button>
          <button type="button" class="btn-primary" style="padding:6px 10px;font-size:0.8rem;background:#64748b;" onclick="this.closest('.cms-gallery-row').remove()">Remove</button>
        </div>`;
    const cap = wrap.querySelector('.cg-cap');
    const yr = wrap.querySelector('.cg-year');
    const src = wrap.querySelector('.cg-src');
    if (cap) cap.value = p.caption || '';
    if (yr) yr.value = p.year || '';
    if (src) src.value = p.src || '';
    root.appendChild(wrap);
}

async function cmsUploadGalleryImage(btn) {
    const row = btn.closest('.cms-gallery-row');
    if (!row) return;
    const fileInp = row.querySelector('.cg-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    fileInp.value = '';
    const pathEl = row.querySelector('.cg-src');
    if (path && pathEl) pathEl.value = path;
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

async function cmsUploadRowPdf(btn, pathSelector) {
    const row = btn.closest('.cms-scroll-row') || btn.closest('.cms-notice-row');
    if (!row) return;
    const fileInp = row.querySelector('.cs-pdf-file') || row.querySelector('.cn-pdf-file');
    const path = await uploadAdminAssetFromInput(fileInp);
    if (fileInp) fileInp.value = '';
    const pathEl = row.querySelector(pathSelector);
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
            copyright: gv('cms-footer-copy')
        },
        featureCards: cmsCollectFeatureCardsFromDom(),
        faq: cmsCollectFaqFromDom()
    };
}

async function loadAdminSiteCms() {
    const tickerEl = document.getElementById('cms-ticker');
    if (!tickerEl) return;
    try {
        const res = await fetch('/api/public/site-cms');
        const cms = await res.json();
        __siteCmsEditing = cms;
        tickerEl.value = cms.tickerText || '';
        const b = document.getElementById('cms-banner');
        if (b) b.value = cms.bannerImage || '';
        const sl = document.getElementById('cms-slides');
        if (sl) sl.value = JSON.stringify(cms.slides || [], null, 2);
        const rv = document.getElementById('cms-reviews');
        if (rv) rv.value = JSON.stringify(cms.reviews || [], null, 2);
        cmsFillScrollingRows(cms.scrollingAnnouncements || []);
        cmsFillPublicNoticeRows(cms.publicNotices || []);
        cmsFillDoctorRows(cms.doctorUpdates || []);
        const ab = document.getElementById('cms-about-json');
        if (ab) ab.value = JSON.stringify(cms.aboutSections || [], null, 2);
        const soc = document.getElementById('cms-social-json');
        if (soc) soc.value = JSON.stringify(cms.socialLinks || [], null, 2);
        cmsFillGalleryRows(cms.pastSeminarGallery || []);
        cmsApplyHeroFieldsToForm(cms);
        cmsFillFeatureRows(cms.featureCards || []);
        cmsFillFaqRows(cms.faq || []);
        await loadAdminMarketing();
    } catch (e) {
        console.error(e);
    }
}

async function saveAdminSiteCms() {
    const msg = document.getElementById('cms-save-msg');
    if (msg) msg.innerText = '';
    let slides;
    let reviews;
    try {
        slides = cmsParseJsonArray((document.getElementById('cms-slides') || {}).value, 'Homepage slides');
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = e.message || String(e);
        }
        return;
    }
    try {
        reviews = cmsParseJsonArray((document.getElementById('cms-reviews') || {}).value, 'Homepage reviews');
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = e.message || String(e);
        }
        return;
    }
    let aboutSections;
    let socialLinks;
    let pastSeminarGallery;
    try {
        aboutSections = cmsParseJsonArray((document.getElementById('cms-about-json') || {}).value, 'About sections');
        socialLinks = cmsParseJsonArray((document.getElementById('cms-social-json') || {}).value, 'Social links');
        pastSeminarGallery = cmsCollectGalleryFromDom();
    } catch (e) {
        if (msg) {
            msg.style.color = '#b91c1c';
            msg.innerText = e.message || String(e);
        }
        return;
    }
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
                msg.innerText = 'Saved.';
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

async function cmsApplyUploadedPath(targetInputId) {
    const pick = document.getElementById('cms-file-picker');
    if (!pick) return;
    const path = await uploadAdminAssetFromInput(pick);
    pick.value = '';
    if (path) {
        const t = document.getElementById(targetInputId);
        if (t) t.value = path;
    }
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

async function loadAdminOrders() {
    const tbody = document.getElementById('admin-orders-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
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

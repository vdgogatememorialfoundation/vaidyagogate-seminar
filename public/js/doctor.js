let currentUser = null;
let currentRegistrationId = null;

function doctorNumericUserId() {
    if (!currentUser) return null;
    const raw = currentUser.id != null ? currentUser.id : currentUser.user_id;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

const DOCTOR_TRACK_POLL_MS = 5000;
let seminarTrackPollTimer = null;
let caseTrackPollTimer = null;
let _lastSeminarTrackFingerprint = '';
let _lastCaseTrackFingerprint = '';

function doctorTabVisible(tabId) {
    const el = document.getElementById(tabId);
    return el && !el.classList.contains('hidden');
}

function stopSeminarTrackingPoll() {
    if (seminarTrackPollTimer) {
        clearInterval(seminarTrackPollTimer);
        seminarTrackPollTimer = null;
    }
    const live = document.getElementById('seminar-track-live');
    if (live) live.classList.add('hidden');
}

function stopCaseTrackingPoll() {
    if (caseTrackPollTimer) {
        clearInterval(caseTrackPollTimer);
        caseTrackPollTimer = null;
    }
    const live = document.getElementById('case-track-live');
    if (live) live.classList.add('hidden');
}

function startSeminarTrackingPoll() {
    stopSeminarTrackingPoll();
    const live = document.getElementById('seminar-track-live');
    if (live) live.classList.remove('hidden');
    seminarTrackPollTimer = setInterval(() => {
        if (doctorTabVisible('tab-applications')) loadApplications(true);
    }, DOCTOR_TRACK_POLL_MS);
}

function startCaseTrackingPoll() {
    stopCaseTrackingPoll();
    const live = document.getElementById('case-track-live');
    if (live) live.classList.remove('hidden');
    caseTrackPollTimer = setInterval(() => {
        if (doctorTabVisible('tab-case-track')) loadCaseApplicationsTracker(true);
    }, DOCTOR_TRACK_POLL_MS);
}

function syncDoctorTrackingPolls() {
    if (document.hidden) {
        stopSeminarTrackingPoll();
        stopCaseTrackingPoll();
        return;
    }
    if (doctorTabVisible('tab-applications')) startSeminarTrackingPoll();
    else stopSeminarTrackingPoll();
    if (doctorTabVisible('tab-case-track')) startCaseTrackingPoll();
    else stopCaseTrackingPoll();
}

document.addEventListener('visibilitychange', () => syncDoctorTrackingPolls());

let doctorPortalYear = new Date().getFullYear();

function formatTrackDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderTrackerStepsHtml(timeline) {
    if (!timeline) return '';
    if (timeline.disqualified) {
        return (
            '<p style="color:#b91c1c;">Disqualified' +
            (timeline.disqualifiedAt ? ' · ' + escapeHtml(formatTrackDateTime(timeline.disqualifiedAt)) : '') +
            '</p>'
        );
    }
    if (timeline.rejected) {
        return '<p style="color:#b91c1c;">This application was rejected or cancelled.</p>';
    }
    const steps = timeline.steps || [];
    let html = '<div class="tracker-vertical">';
    steps.forEach((step) => {
        const cls = step.state === 'completed' ? 'completed' : step.state === 'active' ? 'active' : '';
        const when = step.at
            ? '<p class="track-when" style="font-size:0.78rem;color:#0f766e;margin:4px 0 0;font-weight:600;">' +
              escapeHtml(formatTrackDateTime(step.at)) +
              '</p>'
            : '';
        html +=
            '<div class="track-step ' +
            cls +
            '"><div class="track-icon"><i class="fas ' +
            (step.icon || 'fa-circle') +
            '"></i></div><div class="track-content"><div class="track-title">' +
            escapeHtml(step.title || '') +
            '</div><div class="track-desc">' +
            escapeHtml(step.desc || '') +
            '</div>' +
            when +
            '</div></div>';
    });
    html += '</div>';
    return html;
}

function renderSeminarApplicationTrackerCard(a) {
    const tl = a.timeline || {};
    const payAmt = Number(a.seminar_price) > 0 ? Number(a.seminar_price) : 1500;
    const st = String(a.status || '').toLowerCase();
    const isApproved =
        st === 'approved_pending_payment' || st === 'completed' || st === 'checked_in';
    const isPaid = st === 'completed' || st === 'checked_in';
    const payBtn =
        isApproved && !isPaid
            ? '<button class="btn-success" style="margin-top:10px;" onclick="processPayment(' +
              a.id +
              ', ' +
              payAmt +
              ', ' +
              JSON.stringify(String(a.application_no || '')) +
              ')">Make Payment (₹' +
              payAmt +
              ')</button>'
            : '';
    const waBlock = renderWhatsappLinkBlock(a);
    const yearBadge = a.portal_year
        ? '<span style="font-size:0.75rem;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:6px;margin-left:8px;">' +
          escapeHtml(String(a.portal_year)) +
          '</span>'
        : '';
    return (
        '<div class="card" style="margin-bottom:15px;border-top:4px solid #1a237e;">' +
        '<h4 style="color:#1a237e;margin-bottom:16px;"><i class="fas fa-calendar-check"></i> Seminar · ' +
        escapeHtml(a.application_no) +
        (a.seminar_title ? ' · ' + escapeHtml(a.seminar_title) : '') +
        yearBadge +
        '</h4>' +
        renderTrackerStepsHtml(tl) +
        payBtn +
        waBlock +
        '</div>'
    );
}

function renderCaseApplicationTrackerCard(c) {
    const tl = c.timeline || {};
    const appId = escapeHtml(c.application_no || String(c.id));
    const prog = c.program_title ? ' · ' + escapeHtml(c.program_title) : '';
    const meta = escapeHtml(c.category || '') + ' · ' + escapeHtml(c.title || '');
    const yearBadge = c.portal_year
        ? '<span style="font-size:0.75rem;background:#ccfbf1;color:#0f766e;padding:2px 8px;border-radius:6px;margin-left:8px;">' +
          escapeHtml(String(c.portal_year)) +
          '</span>'
        : '';
    return (
        '<div class="card" style="margin-bottom:15px;border-top:4px solid #0f766e;">' +
        '<h4 style="color:#0f766e;margin-bottom:16px;"><i class="fas fa-briefcase-medical"></i> Case · ' +
        appId +
        prog +
        yearBadge +
        '</h4><p style="font-size:0.88rem;color:#64748b;margin:-8px 0 12px;">' +
        meta +
        '</p>' +
        renderTrackerStepsHtml(tl) +
        '</div>'
    );
}

async function loadDoctorPortalYear() {
    try {
        const res = await fetch('/api/portal/year', { cache: 'no-store' });
        const data = await res.json();
        if (data && data.portalYear) doctorPortalYear = data.portalYear;
        const lbl = document.getElementById('doctor-portal-year-label');
        if (lbl) lbl.textContent = String(doctorPortalYear);
    } catch (e) {
        console.error(e);
    }
}

let siteLogoPath = '';
const COMPUTER_GENERATED_NOTICE =
    'This is a computer-generated document. It does not require a physical signature.';

async function loadSiteBranding() {
    try {
        if (typeof window.reloadSiteBranding === 'function') {
            await window.reloadSiteBranding();
        } else {
            const res = await fetch('/api/branding/logo', { cache: 'no-store' });
            const data = await res.json();
            siteLogoPath = (data && data.logoPath) || '';
        }
        siteLogoPath = window.__siteLogoPath || siteLogoPath || '';
    } catch (e) {
        console.error(e);
    }
}

function brandingHeaderHtml() {
    const logo = siteLogoPath
        ? '<img src="' + escapeHtml(siteLogoPath) + '" alt="Logo" style="max-height:44px;max-width:140px;object-fit:contain;">'
        : '';
    return (
        '<div class="doc-logo-row" style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">' +
        logo +
        '<strong style="color:#0f766e;">Vaidya Gogate Memorial Foundation</strong></div>'
    );
}

function brandingFooterHtml() {
    return (
        '<div style="margin-top:14px;padding-top:8px;border-top:1px solid #cbd5e1;font-size:8.5pt;color:#64748b;text-align:center;">' +
        escapeHtml(COMPUTER_GENERATED_NOTICE) +
        '</div>'
    );
}
window.__fieldOtpTokens = window.__fieldOtpTokens || {};
window.__otpOnApplication = false;
window.__regPhoneOtpToken = null;
window.__regEmailOtpToken = null;

function bootDoctorDashboard(user) {
    currentUser = user;
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('dashboard-main').classList.remove('hidden');
    document.getElementById('header-name').innerText = `Hi, Dr. ${currentUser.first_name || ''} ${currentUser.last_name || ''}`;
    document.getElementById('header-id').innerText =
        `ID: ${currentUser.user_id_string || '---'}` + (Number(currentUser.is_demo) === 1 ? ' · Demo' : '');
    loadProfile();
    loadDoctorPortalYear().then(() => {
        loadSeminarsGrid();
        loadApplications();
    });
    loadDoctorDashboardStats();
    loadRegistrationFormConfigAndApply();
    loadDoctorPortalUpdatesFromCms();
    loadSiteBranding();
    initDoctorVolunteerNav();
}

window.onload = () => {
    const existing = typeof PortalAuth !== 'undefined' ? PortalAuth.getUser('doctor') : null;
    if (existing) {
        bootDoctorDashboard(existing);
        return;
    }
    const form = document.getElementById('doctor-login-form');
    if (form && typeof PortalAuth !== 'undefined') {
        PortalAuth.bindLoginForm({
            portal: 'doctor',
            formId: 'doctor-login-form',
            otpPanelId: 'doctor-login-otp-panel',
            emailInputId: 'doctor-login-email',
            passwordInputId: 'doctor-login-password',
            otpPrefix: 'doctor',
            onSuccess: bootDoctorDashboard,
            onError: (msg) => {
                const el = document.getElementById('doctor-login-err');
                if (el) {
                    el.textContent = msg;
                    el.classList.remove('hidden');
                } else alert(msg);
            }
        });
    }
};

const REGISTRATION_FIELD_IDS = {
    fname: 'reg-fname',
    mname: 'reg-mname',
    lname: 'reg-lname',
    email: 'reg-email',
    phone: 'reg-phone',
    address: 'reg-addr',
    pin: 'reg-pin',
    city: 'reg-city',
    state: 'reg-state',
    country: 'reg-country',
    qual: 'reg-qual',
    ncism: 'reg-ncism',
    certificate: 'reg-cert-file',
    college: 'reg-college',
    ccity: 'reg-ccity',
    cstate: 'reg-cstate'
};

function getMaxRegStep() {
    const fields = window.__registrationFormFields || [];
    let m = 1;
    fields.forEach((f) => {
        const s = f.step != null ? parseInt(f.step, 10) : 1;
        if (!Number.isNaN(s) && s > m) m = s;
    });
    return m;
}

const REGISTRATION_PREVIEW_STEP = 5;

function needsAdvancedQualDoctor() {
    const q = (document.getElementById('reg-qual') || {}).value || '';
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

function collectRegistrationFormData() {
    const o = {};
    Object.keys(REGISTRATION_FIELD_IDS).forEach((k) => {
        const id = REGISTRATION_FIELD_IDS[k];
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'file') o[k] = el.files && el.files[0] ? el.files[0].name : '';
        else if (el.type === 'checkbox') o[k] = el.checked ? '1' : '';
        else o[k] = el.value;
    });
    return o;
}

function registrationPhoneVerified() {
    return !!(window.__regPhoneOtpToken || (window.__fieldOtpTokens || {}).phone);
}

function registrationEmailVerified() {
    return !!(window.__regEmailOtpToken || (window.__fieldOtpTokens || {}).email);
}

function storeRegistrationOtpToken(fieldKey, token) {
    if (!token) return;
    window.__fieldOtpTokens = window.__fieldOtpTokens || {};
    if (fieldKey === 'email') {
        window.__fieldOtpTokens.email = token;
        window.__regEmailOtpToken = token;
    } else if (fieldKey === 'phone') {
        window.__fieldOtpTokens.phone = token;
        window.__regPhoneOtpToken = token;
    } else {
        window.__fieldOtpTokens[fieldKey] = token;
    }
}

function registrationOtpDestination(fieldKey) {
    const raw =
        fieldKey === 'email'
            ? String((document.getElementById('reg-email') || {}).value || '').trim()
            : String((document.getElementById('reg-phone') || {}).value || '').trim();
    if (fieldKey === 'email') return raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
}

async function sendRegistrationOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const dest = registrationOtpDestination(fieldKey);
    if (!dest) return alert(channel === 'email' ? 'Enter your email first.' : 'Enter your phone first.');
    const purpose = window.__otpOnApplication ? 'registration' : 'registration_field';
    const body = { channel, destination: dest, purpose, seminarId: sid };
    if (!window.__otpOnApplication) body.fieldKey = fieldKey;
    const statusEl = document.getElementById(fieldKey === 'email' ? 'reg-otp-status-email' : 'reg-otp-status-phone');
    if (statusEl) statusEl.textContent = 'Sending…';
    try {
        const res = await fetch('/api/otp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            if (statusEl) statusEl.textContent = '';
            return alert(data.error || 'Could not send code.');
        }
        if (statusEl) {
            statusEl.textContent = data.debugCode
                ? 'Code sent (dev: ' + data.debugCode + ')'
                : data.warning
                  ? 'Sent (check configuration).'
                  : 'Code sent.';
        }
        if (data.debugCode) console.info('OTP debug:', data.debugCode);
    } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = '';
        alert('Network error sending code.');
    }
}

async function verifyRegistrationOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const dest = registrationOtpDestination(fieldKey);
    const codeEl = document.getElementById(fieldKey === 'email' ? 'reg-otp-code-email' : 'reg-otp-code-phone');
    const code = String((codeEl || {}).value || '').trim();
    if (!dest || !code) return alert('Enter the code you received.');
    const purpose = window.__otpOnApplication ? 'registration' : 'registration_field';
    const body = { channel, destination: dest, purpose, code, seminarId: sid };
    if (!window.__otpOnApplication) body.fieldKey = fieldKey;
    const uid = doctorNumericUserId();
    if (uid) body.userId = uid;
    const statusEl = document.getElementById(fieldKey === 'email' ? 'reg-otp-status-email' : 'reg-otp-status-phone');
    try {
        const res = await fetch('/api/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            if (statusEl) statusEl.textContent = '';
            return alert(
                (data.error || 'Invalid code.') +
                    '\n\nSend a new code if you changed your email or phone, or if the code is older than 10 minutes.'
            );
        }
        if (fieldKey === 'email' || fieldKey === 'phone') {
            storeRegistrationOtpToken(fieldKey, data.token);
        } else {
            window.__fieldOtpTokens = window.__fieldOtpTokens || {};
            window.__fieldOtpTokens[fieldKey] = data.token;
        }
        if (statusEl) {
            statusEl.textContent = data.demoBypass ? 'Verified ✓ (demo)' : 'Verified ✓';
        }
    } catch (e) {
        console.error(e);
        alert('Network error verifying code.');
    }
}

function validateRegistrationAgainstConfigForSteps(upToStepInclusive) {
    const fields = window.__registrationFormFields;
    if (!fields || !fields.length) return null;
    const fd = collectRegistrationFormData();
    const hasCert =
        (document.getElementById('reg-cert-file') || {}).files &&
        document.getElementById('reg-cert-file').files.length > 0;
    const adv = needsAdvancedQualDoctor();

    for (let sn = 1; sn <= upToStepInclusive; sn++) {
        for (const f of fields) {
            if (!f.enabled) continue;
            if (f.key === 'agree_terms') continue;
            const fStep = f.step != null ? parseInt(f.step, 10) : 1;
            if (Number.isNaN(fStep) || fStep !== sn) continue;
            if (f.onlyWhenAdvancedQual && !adv) continue;
            const fk = String(f.key || '');
            if (fk === 'phone_otp' || fk === 'email_otp' || (f.type || '').toLowerCase() === 'otp') {
                if (f.enabled && f.required) {
                    const channelKey = fk === 'phone_otp' ? 'phone' : fk === 'email_otp' ? 'email' : fk;
                    const ok =
                        channelKey === 'phone'
                            ? registrationPhoneVerified()
                            : channelKey === 'email'
                              ? registrationEmailVerified()
                              : !!(window.__fieldOtpTokens || {})[channelKey];
                    if (!ok) return `Please verify OTP for: ${f.label || f.key}`;
                }
                continue;
            }
            if (f.key === 'certificate') {
                if (!hasCert) return `Please upload: ${f.label || 'Certificate'}`;
                continue;
            }
            const v = fd[f.key];
            if (v === undefined || v === null || String(v).trim() === '') {
                return `Please complete: ${f.label || f.key}`;
            }
            if (f.key === 'phone' || f.key === 'whatsapp') {
                const digits = String(v).replace(/\D/g, '');
                if (digits.length < 10) {
                    return `Enter a valid ${f.label || f.key} (at least 10 digits)`;
                }
            }
            const t = (f.type || 'text').toLowerCase();
            if (t === 'select' && Array.isArray(f.options)) {
                const ok = f.options.some((o) => String(o.value != null ? o.value : o.label) === String(v));
                if (!ok) return `Invalid choice for: ${f.label || f.key}`;
            }
        }
        for (const f of fields) {
            if (!f.verifyOtp || !f.enabled) continue;
            const fStep = f.step != null ? parseInt(f.step, 10) : 1;
            if (Number.isNaN(fStep) || fStep !== sn) continue;
            if (f.type !== 'email' && f.type !== 'tel') continue;
            if (f.key === 'email' || f.key === 'phone') {
                const ok = f.key === 'phone' ? registrationPhoneVerified() : registrationEmailVerified();
                if (!ok) return `Please verify OTP for: ${f.label || f.key}`;
                continue;
            }
            const tok = (window.__fieldOtpTokens || {})[f.key];
            if (!tok) return `Please verify OTP for: ${f.label || f.key}`;
        }
        if (sn === 1 && window.__otpOnApplication) {
            if (!registrationPhoneVerified() || !registrationEmailVerified()) {
                return 'Please verify both email and phone codes for this seminar before continuing.';
            }
        }
        if (sn === 1 && typeof validateRegistrationNamesClient === 'function') {
            const nameErr = validateRegistrationNamesClient(fd);
            if (nameErr) return nameErr;
        }
    }
    return null;
}

async function loadRegistrationFormConfigAndApply(seminarIdOpt) {
    const sid = seminarIdOpt != null ? seminarIdOpt : activeSeminarIdForReg;
    try {
        const url =
            sid != null && sid !== ''
                ? `/api/registration-form-config?seminarId=${encodeURIComponent(sid)}`
                : '/api/registration-form-config';
        const res = await fetch(url);
        const data = await res.json();
        window.__registrationFormFields = data.fields || [];
        window.__otpOnApplication = !!data.otpOnApplication;
        const otpPanel = document.getElementById('reg-seminar-otp-panel');
        if (otpPanel) {
            if (window.__otpOnApplication) otpPanel.classList.remove('hidden');
            else otpPanel.classList.add('hidden');
        }
    } catch (e) {
        console.error(e);
        window.__registrationFormFields = [];
        window.__otpOnApplication = false;
        const otpPanel = document.getElementById('reg-seminar-otp-panel');
        if (otpPanel) otpPanel.classList.add('hidden');
    }
    const fields = window.__registrationFormFields;
    const qualField = (fields || []).find((f) => f.key === 'qual');
    const qualEl = document.getElementById('reg-qual');
    if (qualField && qualField.type === 'select' && Array.isArray(qualField.options) && qualEl) {
        const cur = qualEl.value;
        qualEl.innerHTML = '<option value="">Select</option>';
        qualField.options.forEach((o) => {
            const v = o.value != null ? o.value : o.label;
            const lab = o.label != null ? o.label : v;
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = lab;
            qualEl.appendChild(opt);
        });
        if (cur) qualEl.value = cur;
    }
    fields.forEach((f) => {
        const id = REGISTRATION_FIELD_IDS[f.key];
        if (!id) return;
        const el = document.getElementById(id);
        if (!el) return;
        const fg = el.closest('.form-group');
        if (fg) {
            if (f.enabled === false) fg.classList.add('hidden');
            else fg.classList.remove('hidden');
            const lab = fg.querySelector('label');
            if (lab && f.label) lab.textContent = f.label + (f.required ? ' *' : '');
        }
        if (f.key !== 'certificate') {
            el.required = !!(f.enabled && f.required && (!f.onlyWhenAdvancedQual || needsAdvancedQualDoctor()));
        }
    });
    refreshRegistrationRequiredAttributes();
}

function refreshRegistrationRequiredAttributes() {
    const fields = window.__registrationFormFields || [];
    const adv = needsAdvancedQualDoctor();
    fields.forEach((f) => {
        if (!f.enabled) return;
        if (f.key === 'certificate') {
            const fileEl = document.getElementById('reg-cert-file');
            if (fileEl) fileEl.required = !!(f.required && adv);
            return;
        }
        if (f.key === 'ncism') {
            const el = document.getElementById(REGISTRATION_FIELD_IDS.ncism);
            if (el) el.required = !!(f.required && adv);
            return;
        }
        const el = document.getElementById(REGISTRATION_FIELD_IDS[f.key]);
        if (!el || el.type === 'file') return;
        if (f.onlyWhenAdvancedQual && !adv) {
            el.required = false;
            return;
        }
        el.required = !!f.required;
    });
}

async function loadDoctorPortalUpdatesFromCms() {
    const box = document.getElementById('doctor-updates-list');
    if (!box) return;
    const esc = (s) =>
        String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    try {
        const res = await fetch('/api/public/site-cms');
        const cms = await res.json();
        const items = Array.isArray(cms.doctorUpdates) ? cms.doctorUpdates : [];
        if (!items.length) {
            box.innerHTML = '<li style="color:#64748b;">No updates from the office yet.</li>';
            return;
        }
        box.innerHTML = items
            .map((u) => {
                const t = esc(u.title || 'Update');
                const b = esc(u.body || '');
                const d = u.at ? `<span style="color:#94a3b8;font-size:0.8rem;">${esc(u.at)}</span> ` : '';
                return `<li style="margin-bottom:10px;"><strong>${d}${t}</strong><div style="margin-top:4px;color:#475569;">${b}</div></li>`;
            })
            .join('');
    } catch (e) {
        console.error(e);
        box.innerHTML = '<li style="color:#b91c1c;">Could not load updates.</li>';
    }
}

let activeSeminars = [];
let seminarGridCountdownTimer = null;

function registrationWindowState(seminar) {
    const now = Date.now();
    const rs = seminar.registration_start ? new Date(seminar.registration_start).getTime() : null;
    const re = seminar.registration_end ? new Date(seminar.registration_end).getTime() : null;
    const rsValid = rs != null && !Number.isNaN(rs);
    const reValid = re != null && !Number.isNaN(re);
    if (rsValid && now < rs) {
        return { state: 'upcoming', opensAt: rs };
    }
    if (reValid && now > re) {
        return { state: 'closed' };
    }
    return { state: 'open' };
}

function formatCountdownTo(targetMs) {
    const diff = Math.max(0, targetMs - Date.now());
    if (diff <= 0) return 'Opening now…';
    const sec = Math.floor(diff / 1000) % 60;
    const min = Math.floor(diff / 60000) % 60;
    const hr = Math.floor(diff / 3600000) % 24;
    const day = Math.floor(diff / 86400000);
    const parts = [];
    if (day) parts.push(`${day}d`);
    if (day || hr) parts.push(`${hr}h`);
    parts.push(`${min}m`);
    parts.push(`${sec}s`);
    return parts.join(' ');
}

function clearSeminarGridCountdownTimer() {
    if (seminarGridCountdownTimer) {
        clearInterval(seminarGridCountdownTimer);
        seminarGridCountdownTimer = null;
    }
}

function startSeminarGridCountdownTimer() {
    clearSeminarGridCountdownTimer();
    const tick = () => {
        let needReload = false;
        let anyUpcoming = false;
        activeSeminars.forEach((s) => {
            const w = registrationWindowState(s);
            if (w.state === 'upcoming') {
                anyUpcoming = true;
                const el = document.getElementById(`seminar-reg-countdown-${s.id}`);
                if (el && w.opensAt != null) {
                    el.textContent = formatCountdownTo(w.opensAt);
                }
                const rs = s.registration_start ? new Date(s.registration_start).getTime() : null;
                if (rs != null && !Number.isNaN(rs) && Date.now() >= rs) {
                    needReload = true;
                }
            }
        });
        if (needReload) {
            loadSeminarsGrid();
            return;
        }
        if (!anyUpcoming) {
            clearSeminarGridCountdownTimer();
        }
    };
    tick();
    seminarGridCountdownTimer = setInterval(tick, 1000);
}

function renderSeminarGridCard(s, readOnlyPast) {
    const win = registrationWindowState(s);
    const regStartLabel = s.registration_start
        ? formatTrackDateTime(s.registration_start)
        : '';
    const regEndLabel = s.registration_end ? formatTrackDateTime(s.registration_end) : '';
    const eventLabel = s.event_date ? formatTrackDateTime(s.event_date) : '—';
    let actionBlock = '';
    if (readOnlyPast) {
        actionBlock =
            '<p style="font-size:0.85rem;color:#64748b;margin-bottom:12px;"><i class="fas fa-archive"></i> Past seminar — registration closed. Track your application under <strong>Track seminar applications</strong>.</p>' +
            '<button type="button" class="btn-primary" style="width:100%;opacity:0.7;" onclick="switchTab(\'tab-applications\')">View my registration</button>';
    } else if (win.state === 'upcoming') {
        actionBlock =
            '<div style="background:#eef2ff;border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid #c7d2fe;">' +
            '<p style="font-size:0.8rem;color:#4338ca;font-weight:600;"><i class="fas fa-hourglass-half"></i> Opens</p>' +
            '<p style="font-size:0.9rem;color:#312e81;">' +
            escapeHtml(regStartLabel) +
            '</p>' +
            '<p id="seminar-reg-countdown-' +
            s.id +
            '" style="font-size:1.1rem;font-weight:700;color:#1a237e;">' +
            (win.opensAt != null ? formatCountdownTo(win.opensAt) : '—') +
            '</p></div>' +
            '<button type="button" disabled class="btn-primary" style="width:100%;opacity:0.55;">Registration not open yet</button>';
    } else if (win.state === 'closed') {
        actionBlock =
            '<p style="font-size:0.85rem;color:#b45309;"><i class="fas fa-lock"></i> Registration closed.</p>' +
            '<button type="button" disabled class="btn-primary" style="width:100%;opacity:0.55;margin-top:8px;">Registration closed</button>';
    } else {
        actionBlock =
            (regEndLabel
                ? '<p style="font-size:0.8rem;color:#64748b;margin-bottom:10px;">Closes ' + escapeHtml(regEndLabel) + '</p>'
                : '') +
            '<button type="button" class="btn-primary" onclick="startRegistration(' +
            s.id +
            ')" style="width:100%;">Register now</button>';
    }
    return (
        '<div style="background:white;border-radius:12px;padding:25px;box-shadow:0 4px 15px rgba(0,0,0,0.03);border-top:4px solid ' +
        (readOnlyPast ? '#94a3b8' : '#1a237e') +
        ';display:flex;flex-direction:column;justify-content:space-between;">' +
        '<div><h3 style="color:#1a237e;margin-bottom:10px;">' +
        escapeHtml(s.title) +
        '</h3>' +
        '<p style="color:#64748b;font-size:0.9rem;margin-bottom:12px;">' +
        escapeHtml(s.description || '') +
        '</p>' +
        '<p style="font-size:0.85rem;"><strong>Event:</strong> ' +
        escapeHtml(eventLabel) +
        '</p>' +
        (s.portal_year
            ? '<p style="font-size:0.8rem;color:#64748b;">Year ' + escapeHtml(String(s.portal_year)) + '</p>'
            : '') +
        '<p style="font-size:0.85rem;margin-top:8px;"><strong>Fee:</strong> ₹' +
        (s.price || 0) +
        '</p></div>' +
        '<div>' +
        actionBlock +
        '</div></div>'
    );
}

async function loadSeminarsGrid() {
    clearSeminarGridCountdownTimer();
    const container = document.getElementById('seminars-grid-container');
    if (!container) return;
    try {
        const res = await fetch('/api/seminars?bucket=current', { cache: 'no-store' });
        const payload = await res.json();
        if (payload.portalYear) doctorPortalYear = payload.portalYear;
        activeSeminars = payload.seminars || [];
        container.innerHTML = '';

        if (!activeSeminars.length) {
            container.innerHTML =
                '<p style="grid-column:1/-1;text-align:center;width:100%;color:#64748b;">No active seminars available for registration at this time.</p>';
            return;
        }

        let hasUpcoming = false;
        activeSeminars.forEach((s) => {
            const win = registrationWindowState(s);
            if (win.state === 'upcoming') hasUpcoming = true;
            container.insertAdjacentHTML('beforeend', renderSeminarGridCard(s, false));
        });
        if (hasUpcoming) {
            startSeminarGridCountdownTimer();
        }
    } catch (err) {
        console.error(err);
        container.innerHTML =
            '<p style="grid-column:1/-1;text-align:center;color:#b91c1c;">Could not load seminars. Please refresh the page.</p>';
    }
}

let activeSeminarIdForReg = null;
window.__seminarTermsText = '';

function proceedFromSeminarTnc() {
    if (!document.getElementById('reg-tnc-accept')?.checked) {
        alert('Please accept the Terms and Conditions to continue.');
        return;
    }
    nextStep(1);
}

async function startRegistration(seminarId) {
    const s = activeSeminars.find((x) => Number(x.id) === Number(seminarId));
    const seminarTitle = s && s.title ? s.title : 'Seminar';
    if (s && registrationWindowState(s).state !== 'open') {
        if (registrationWindowState(s).state === 'upcoming') {
            alert('Registration has not opened yet for this seminar. Please wait until the countdown reaches zero.');
        } else {
            alert('Registration for this seminar has closed.');
        }
        return;
    }
    activeSeminarIdForReg = seminarId;
    window.__seminarTermsText =
        (s && s.terms_conditions && String(s.terms_conditions).trim()) ||
        'Standard seminar terms apply. Contact the organizer for full details.';
    window.__fieldOtpTokens = {};
    window.__regPhoneOtpToken = null;
    window.__regEmailOtpToken = null;
    document.getElementById('registration-seminar-name').innerText = `Registering for: ${seminarTitle}`;
    document.getElementById('seminars-grid-container').classList.add('hidden');
    document.getElementById('seminars-title').classList.add('hidden');
    document.getElementById('multi-step-form').classList.remove('hidden');
    const tncEl = document.getElementById('reg-tnc-text');
    if (tncEl) tncEl.textContent = window.__seminarTermsText;
    const tncAcc = document.getElementById('reg-tnc-accept');
    if (tncAcc) tncAcc.checked = false;
    await loadRegistrationFormConfigAndApply(seminarId);
    const emailEl = document.getElementById('reg-email');
    const phoneEl = document.getElementById('reg-phone');
    if (emailEl && currentUser && currentUser.email) emailEl.value = currentUser.email;
    if (phoneEl && currentUser && currentUser.phone) phoneEl.value = currentUser.phone;

    nextStep(0);
}

function cancelRegistration() {
    activeSeminarIdForReg = null;
    window.__fieldOtpTokens = {};
    window.__regPhoneOtpToken = null;
    window.__regEmailOtpToken = null;
    ['reg-otp-status-email', 'reg-otp-status-phone'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    ['reg-otp-code-email', 'reg-otp-code-phone'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('seminars-grid-container').classList.remove('hidden');
    document.getElementById('seminars-title').classList.remove('hidden');
    document.getElementById('multi-step-form').classList.add('hidden');
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach(t => t.classList.add('hidden'));
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    document.getElementById(tabId).classList.remove('hidden');
    if (typeof event !== 'undefined' && event && event.currentTarget) {
        event.currentTarget.classList.add('active');
    } else {
        document.querySelectorAll('.menu-item').forEach(m => {
            const oc = m.getAttribute('onclick') || '';
            if (oc.indexOf(tabId) !== -1) m.classList.add('active');
        });
    }
    if (tabId === 'tab-dashboard') {
        loadDoctorDashboardStats();
    }
    if (tabId === 'tab-feedback') {
        loadDashboardFeedbackSeminars();
    }
    if (tabId === 'tab-support') {
        loadTickets();
    }
    if (tabId === 'tab-orders') {
        loadDoctorOrders();
    }
    if (tabId === 'tab-receipts') {
        loadDoctorReceipts();
    }
    if (tabId === 'tab-ticket') {
        loadDoctorEventTickets();
    }
    if (tabId === 'tab-certificate') {
        loadDoctorCertificates();
    }
    if (tabId === 'tab-volunteer') {
        loadDoctorVolunteerPanel();
    }
    if (tabId === 'tab-abstract') {
        loadCaseProgramsGrid();
    }
    if (tabId === 'tab-case-track') {
        loadCaseApplicationsTracker();
    }
    if (tabId === 'tab-applications') {
        loadApplications();
    }
    syncDoctorTrackingPolls();
}

let activeCaseProgramId = null;
let activeCasePrograms = [];
let activeCaseProgram = null;

const CASE_FIELD_IDS = {
    fname: 'case-fname',
    mname: 'case-mname',
    lname: 'case-lname',
    email: 'case-email',
    phone: 'case-phone',
    whatsapp: 'case-whatsapp',
    category: 'case-category',
    topic: 'case-topic',
    files: 'case-files'
};

function applyCaseFormConfigFromProgram(program) {
    const fields = (program && program.formConfig && program.formConfig.fields) || [];
    const byKey = {};
    fields.forEach((f) => {
        byKey[f.key] = f;
    });
    Object.keys(CASE_FIELD_IDS).forEach((key) => {
        const elId = CASE_FIELD_IDS[key];
        const el = document.getElementById(elId);
        const fg = el && el.closest('.form-group');
        const cfg = byKey[key];
        if (!fg) return;
        if (cfg && cfg.enabled === false) {
            fg.classList.add('hidden');
            if (el) el.required = false;
            return;
        }
        fg.classList.remove('hidden');
        const lab = fg.querySelector('label');
        if (lab && cfg && cfg.label) lab.textContent = cfg.label + (cfg.required !== false ? ' *' : '');
        if (el && key !== 'files') el.required = !!(cfg && cfg.required !== false);
    });
    const catSel = document.getElementById('case-category');
    if (catSel && program && program.enabledCategories) {
        const cur = catSel.value;
        catSel.innerHTML = '<option value="">Select</option>';
        program.enabledCategories.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c === 'agnikarma' ? 'Agnikarma' : c === 'viddhakarma' ? 'Viddhakarma' : c;
            catSel.appendChild(opt);
        });
        if (cur) catSel.value = cur;
    }
    const fileFg = document.getElementById('case-files') && document.getElementById('case-files').closest('.form-group');
    if (fileFg && program) {
        const maxF = program.maxFilesPerSubmission || 5;
        const maxMb = program.maxFileSizeMb || 50;
        const lab = fileFg.querySelector('label');
        if (lab) lab.textContent = 'Upload (max ' + maxF + ' files, ' + maxMb + ' MB each) *';
    }
    const note = document.getElementById('case-program-limits-note');
    if (note && program) {
        let parts = [];
        if (program.instructions) parts.push(program.instructions);
        if (program.maxPresentationsPerUser)
            parts.push('Up to ' + program.maxPresentationsPerUser + ' presentation(s) per doctor in this program.');
        if (program.slotsRemaining != null)
            parts.push(program.slotsRemaining + ' slot(s) remaining.');
        note.textContent = parts.join(' ');
        note.style.display = parts.length ? 'block' : 'none';
    }
}

async function loadCaseProgramsGrid() {
    const grid = document.getElementById('case-programs-grid');
    const form = document.getElementById('case-application-form');
    if (!grid || !currentUser) return;
    grid.classList.remove('hidden');
    if (form) form.classList.add('hidden');
    grid.innerHTML = '<p style="color:#64748b;">Loading programs…</p>';
    try {
        const res = await fetch('/api/case/programs');
        const programs = await res.json();
        activeCasePrograms = Array.isArray(programs) ? programs : [];
        if (!activeCasePrograms.length) {
            grid.innerHTML = '<p style="color:#64748b;">No case presentation programs are open at this time.</p>';
            return;
        }
        grid.innerHTML = '';
        activeCasePrograms.forEach((p) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.padding = '16px';
            const win = p.windowState || 'open';
            let btn = '';
            if (win === 'open') {
                btn = `<button type="button" class="btn-primary" style="margin-top:10px;" onclick="startCaseApplication(${p.id})">Apply now</button>`;
            } else if (win === 'upcoming') {
                btn = '<p style="color:#b45309;margin-top:10px;font-size:0.88rem;">Applications not open yet</p>';
            } else {
                btn = '<p style="color:#94a3b8;margin-top:10px;font-size:0.88rem;">Applications closed</p>';
            }
            const slots =
                p.slotsRemaining != null
                    ? `<p style="font-size:0.82rem;margin-top:6px;color:#0f766e;">${p.slotsRemaining} slot(s) left</p>`
                    : '';
            card.innerHTML = `<h4 style="margin:0 0 6px;">${escapeHtml(p.title)}</h4>
                <p style="font-size:0.85rem;color:#64748b;margin:0;">${escapeHtml(p.description || '')}</p>
                ${p.seminar_title ? `<p style="font-size:0.82rem;margin-top:6px;">Linked seminar: ${escapeHtml(p.seminar_title)}</p>` : ''}
                ${slots}
                ${btn}`;
            grid.appendChild(card);
        });
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<p style="color:#b91c1c;">Could not load programs.</p>';
    }
}

async function startCaseApplication(programId) {
    activeCaseProgramId = programId;
    const prog = activeCasePrograms.find((p) => Number(p.id) === Number(programId));
    activeCaseProgram = prog || null;
    const grid = document.getElementById('case-programs-grid');
    const form = document.getElementById('case-application-form');
    if (grid) grid.classList.add('hidden');
    if (form) form.classList.remove('hidden');
    const titleEl = document.getElementById('case-form-program-title');
    if (titleEl && prog) titleEl.textContent = prog.title;
    try {
        const detailRes = await fetch('/api/case/programs/' + programId);
        if (detailRes.ok) {
            activeCaseProgram = await detailRes.json();
            applyCaseFormConfigFromProgram(activeCaseProgram);
        } else if (prog) {
            applyCaseFormConfigFromProgram(prog);
        }
        const q =
            activeCaseProgram && activeCaseProgram.seminar_id
                ? `?seminarId=${activeCaseProgram.seminar_id}`
                : prog && prog.seminar_id
                  ? `?seminarId=${prog.seminar_id}`
                  : '';
        const uid = doctorNumericUserId();
        const res = await fetch('/api/case/prefill/' + uid + q);
        const pre = await res.json();
        document.getElementById('case-fname').value = pre.fname || '';
        document.getElementById('case-mname').value = pre.mname || '';
        document.getElementById('case-lname').value = pre.lname || '';
        document.getElementById('case-email').value = pre.email || '';
        document.getElementById('case-phone').value = pre.phone || '';
        document.getElementById('case-whatsapp').value = pre.whatsapp || pre.phone || '';
        if (pre.fromRegistration) {
            const note = document.getElementById('case-prefill-note');
            if (!note) {
                const p = document.createElement('p');
                p.id = 'case-prefill-note';
                p.style.cssText = 'color:#15803d;font-size:0.88rem;margin-bottom:10px;';
                p.textContent = 'Details loaded from your seminar registration.';
                form.insertBefore(p, form.querySelector('.form-group'));
            }
        }
    } catch (e) {
        console.error(e);
    }
}

function cancelCaseApplication() {
    activeCaseProgramId = null;
    activeCaseProgram = null;
    loadCaseProgramsGrid();
}

async function initDoctorVolunteerNav() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/doctor/volunteer-assignments/' + currentUser.id);
        const rows = await res.json();
        const nav = document.getElementById('nav-volunteer');
        if (nav && Array.isArray(rows) && rows.length) {
            nav.classList.remove('hidden');
        }
    } catch (e) {
        console.error(e);
    }
}

async function loadDoctorVolunteerPanel() {
    const panel = document.getElementById('volunteer-panel');
    if (!panel || !currentUser) return;
    panel.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/doctor/volunteer-assignments/' + currentUser.id);
        const rows = await res.json();
        if (!rows.length) {
            panel.innerHTML = '<p>No volunteer assignments.</p>';
            return;
        }
        panel.innerHTML = '';
        rows.forEach((v) => {
            const card = document.createElement('div');
            card.style.cssText = 'border:1px solid #e2e8f0;padding:14px;border-radius:8px;margin-bottom:12px;';
            const ticket = v.volunteer_ticket_id_string
                ? '<p>Volunteer ticket: <code>' + escapeHtml(v.volunteer_ticket_id_string) + '</code></p>'
                : '<p style="color:#64748b;">Ticket will be issued after admin verification (no payment required).</p>';
            card.innerHTML =
                '<h4 style="margin:0 0 8px;">' +
                escapeHtml(v.title || 'Seminar') +
                '</h4><p>Status: <strong>' +
                escapeHtml(v.status) +
                '</strong></p>' +
                ticket +
                '<p style="font-size:0.88rem;color:#64748b;margin-top:8px;">You receive both a volunteer certificate and a participant certificate once verified.</p>';
            panel.appendChild(card);
        });
    } catch (e) {
        console.error(e);
        panel.innerHTML = '<p style="color:#b91c1c;">Could not load.</p>';
    }
}

async function submitCasePresentation() {
    const uid = doctorNumericUserId();
    if (!uid) return alert('Please sign in again to the doctor portal, then submit your application.');
    if (!activeCaseProgramId) return alert('Select a program first');
    const form = {
        fname: document.getElementById('case-fname')?.value || '',
        mname: document.getElementById('case-mname')?.value || '',
        lname: document.getElementById('case-lname')?.value || '',
        email: document.getElementById('case-email')?.value || '',
        phone: document.getElementById('case-phone')?.value || '',
        whatsapp: document.getElementById('case-whatsapp')?.value || '',
        category: document.getElementById('case-category')?.value || '',
        topic: document.getElementById('case-topic')?.value || ''
    };
    if (typeof validateRegistrationNamesClient === 'function') {
        const ne = validateRegistrationNamesClient(form);
        if (ne) return alert(ne);
    }
    const fileInput = document.getElementById('case-files');
    const maxFiles = (activeCaseProgram && activeCaseProgram.maxFilesPerSubmission) || 5;
    const maxMb = (activeCaseProgram && activeCaseProgram.maxFileSizeMb) || 50;
    const filesField = (activeCaseProgram && activeCaseProgram.formConfig && activeCaseProgram.formConfig.fields || []).find(
        (f) => f.key === 'files'
    );
    const filesRequired = !filesField || filesField.enabled === false ? false : filesField.required !== false;
    if (filesRequired && !fileInput?.files?.length) return alert('Select at least one file');
    if (fileInput?.files?.length > maxFiles) return alert('Maximum ' + maxFiles + ' files');
    if (fileInput?.files) {
        for (let i = 0; i < fileInput.files.length; i++) {
            if (fileInput.files[i].size > maxMb * 1024 * 1024) {
                return alert('Each file must be under ' + maxMb + ' MB');
            }
        }
    }
    const fd = new FormData();
    fd.append('userId', String(uid));
    fd.append('caseProgramId', String(activeCaseProgramId));
    fd.append('formData', JSON.stringify(form));
    if (fileInput && fileInput.files) {
        for (let i = 0; i < fileInput.files.length; i++) fd.append('files', fileInput.files[i]);
    }
    try {
        const res = await fetch('/api/case/submit', { method: 'POST', body: fd });
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            return alert('Server error (' + res.status + '). Restart the server after updates.');
        }
        if (data.success) {
            alert(
                'Application submitted. Your application ID is ' +
                    (data.applicationNo || data.submissionId) +
                    '. Track status under Track case applications.'
            );
            cancelCaseApplication();
            loadCaseApplicationsTracker();
            switchTab('tab-case-track');
        } else alert(data.error || 'Submit failed');
    } catch (e) {
        console.error(e);
        alert('Network error: ' + (e.message || 'Could not reach server'));
    }
}

function caseApplicationStatusLabel(st) {
    const s = String(st || 'submitted').toLowerCase();
    if (s === 'judging') return 'Judges scoring';
    if (s === 'under_review') return 'Admin reviewing files';
    if (s === 'approved_for_judging') return 'Ready for judges';
    if (s === 'selected') return 'Selected / winner';
    if (s === 'disqualified') return 'Disqualified';
    if (s === 'cancelled') return 'Cancelled';
    return s.replace(/_/g, ' ');
}

function caseTrackFingerprint(rows) {
    return (rows || [])
        .map((r) => {
            const tl = r.timeline || {};
            const stepSig = (tl.steps || []).map((s) => s.key + ':' + s.state + ':' + (s.at || '')).join(',');
            return [r.id, r.status, r.judge_count, r.locked_score_count, stepSig].join(':');
        })
        .join('|');
}

async function loadCaseApplicationsTracker(silentPoll) {
    const box = document.getElementById('case-tracker-container');
    if (!box || !currentUser) return;
    if (!silentPoll) box.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const uid = doctorNumericUserId();
        if (!uid) {
            box.innerHTML = '<p style="color:#b91c1c;">Please sign in again to track applications.</p>';
            return;
        }
        const res = await fetch('/api/doctor/case/applications/' + uid, { cache: 'no-store' });
        const payload = await res.json();
        const rows = Array.isArray(payload) ? payload : payload.applications || [];
        if (!Array.isArray(rows)) {
            box.innerHTML = '<p style="color:#b91c1c;">Could not load case applications.</p>';
            return;
        }
        if (payload.portalYear) doctorPortalYear = payload.portalYear;
        const fp = caseTrackFingerprint(rows);
        if (silentPoll && fp === _lastCaseTrackFingerprint) return;
        _lastCaseTrackFingerprint = fp;

        userCaseApplications = rows;

        if (!rows.length) {
            userCaseApplications = [];
            box.innerHTML =
                '<p style="color:#64748b;">No case presentation applications yet. Submit from <strong>Case presentation</strong>.</p>';
            return;
        }

        let html = '';
        rows.forEach((s) => {
            html += renderCaseApplicationTrackerCard(s);
        });
        html +=
            '<div class="card" style="margin-top:8px;"><table class="data-table"><thead><tr>' +
            '<th>Application ID</th><th>Program</th><th>Category</th><th>Topic</th><th>Status</th><th>Files</th><th></th></tr></thead><tbody>';
        rows.forEach((s, index) => {
            html +=
                '<tr><td><code>' +
                escapeHtml(s.application_no || String(s.id)) +
                '</code></td><td>' +
                escapeHtml(s.program_title || '—') +
                '</td><td>' +
                escapeHtml(s.category || '—') +
                '</td><td>' +
                escapeHtml(s.title || '—') +
                '</td><td><strong>' +
                escapeHtml(caseApplicationStatusLabel(s.status)) +
                '</strong></td><td>' +
                (s.file_count || 0) +
                '</td><td><button class="btn-primary" style="padding:5px 10px;" onclick="viewCaseApplication(' +
                index +
                ')">View Details</button></td></tr>';
        });
        html += '</tbody></table></div>';
        box.innerHTML = html;
    } catch (e) {
        console.error(e);
        if (!silentPoll) box.innerHTML = '<p style="color:#b91c1c;">Could not load applications.</p>';
    }
}

function viewCaseApplication(index) {
    const c = userCaseApplications[index];
    if (!c) return;
    const contentDiv = document.getElementById('view-case-content');
    if (!contentDiv) return;
    const judges = Number(c.judge_count) || 0;
    const locked = Number(c.locked_score_count) || 0;
    contentDiv.innerHTML =
        '<p><strong>Application ID:</strong> ' +
        escapeHtml(c.application_no || String(c.id)) +
        '</p>' +
        '<p><strong>Program:</strong> ' +
        escapeHtml(c.program_title || '—') +
        '</p>' +
        '<p><strong>Category:</strong> ' +
        escapeHtml(c.category || '—') +
        '</p>' +
        '<p><strong>Topic:</strong> ' +
        escapeHtml(c.title || '—') +
        '</p>' +
        '<p><strong>Status:</strong> <strong>' +
        escapeHtml(caseApplicationStatusLabel(c.status)) +
        '</strong></p>' +
        '<p><strong>Files uploaded:</strong> ' +
        (c.file_count || 0) +
        '</p>' +
        '<p><strong>Judges assigned:</strong> ' +
        judges +
        ' · <strong>Scores submitted:</strong> ' +
        locked +
        '</p>' +
        '<hr style="margin:16px 0;border:0;border-top:1px solid #cbd5e1;">' +
        '<h4 style="color:#0f766e;margin-bottom:12px;"><i class="fas fa-route"></i> Case presentation tracking</h4>' +
        renderTrackerStepsHtml(c.timeline || {});
    const modal = document.getElementById('view-case-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
}

function doctorCertificateLockedBlock(message) {
    const msg =
        message ||
        'Locked until you are checked in, an administrator enables your certificate, and a certificate template is uploaded for this seminar.';
    return (
        '<div style="text-align:center;padding:24px;">' +
        '<i class="fas fa-lock" style="font-size:2rem;color:#94a3b8;margin-bottom:10px;display:block;"></i>' +
        '<p style="margin:0;font-weight:600;color:#475569;">Locked</p>' +
        '<p style="margin:8px 0 0;font-size:0.9rem;color:#64748b;">' + escapeHtml(msg) + '</p>' +
        '</div>'
    );
}

function doctorCertificatePendingTemplateBlock() {
    return (
        '<div style="text-align:center;padding:24px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">' +
        '<i class="fas fa-check-circle" style="font-size:2rem;color:#15803d;margin-bottom:10px;display:block;"></i>' +
        '<p style="margin:0;font-weight:600;color:#166534;">Certificate approved</p>' +
        '<p style="margin:8px 0 0;font-size:0.9rem;color:#475569;">Your certificate is enabled. The organizer still needs to upload the certificate design — check back after they add the template.</p>' +
        '</div>'
    );
}

async function loadDoctorCertificates() {
    const wrap = document.getElementById('doctor-certificates-wrap');
    if (!wrap || !currentUser) return;
    wrap.innerHTML = '<p style="color:#64748b;text-align:center;">Loading…</p>';
    try {
        const [res, vres] = await Promise.all([
            fetch(`/api/doctor/certificates/${currentUser.id}`),
            fetch(`/api/doctor/volunteer-certificates/${currentUser.id}`)
        ]);
        const rows = await res.json();
        const vrows = await vres.json();
        const all = [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(vrows) ? vrows.map((v) => ({ ...v, _volunteer: true })) : [])];
        if (!all.length) {
            wrap.innerHTML = doctorCertificateLockedBlock();
            return;
        }
        wrap.innerHTML = '';
        all.forEach((c) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.marginBottom = '16px';
            const title = escapeHtml((c.seminar_title || 'Seminar') + (c._volunteer ? ' (Volunteer)' : ''));
            const name = escapeHtml(c.display_name || '');
            if (!c.enabled) {
                card.innerHTML = `<h4 style="margin:0 0 12px;">${title}</h4>${doctorCertificateLockedBlock(
                    'An administrator must enable your certificate after check-in.'
                )}`;
                wrap.appendChild(card);
                return;
            }
            if (!c.template_path) {
                card.innerHTML = `<h4 style="margin:0 0 12px;">${title}</h4>${doctorCertificatePendingTemplateBlock()}`;
                wrap.appendChild(card);
                return;
            }
            const isImage = !c.mime_type || String(c.mime_type).startsWith('image/');
            if (isImage) {
                card.innerHTML = `<h4 style="margin:0 0 8px;">${title}</h4>
                    <p style="font-size:0.88rem;color:#64748b;margin-bottom:8px;">${name}</p>
                    <div style="position:relative;max-width:720px;margin:0 auto;">
                        <img src="${c.template_path}" alt="Certificate" style="width:100%;border-radius:8px;border:1px solid #e2e8f0;">
                        <div style="position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);font-size:clamp(1rem,3vw,1.75rem);font-weight:700;color:#1e3a5f;text-align:center;width:80%;text-shadow:0 0 8px rgba(255,255,255,0.9);">${name}</div>
                    </div>
                    <button type="button" class="btn-primary" style="margin-top:12px;" onclick="window.print()">Print / Save as PDF</button>`;
            } else {
                card.innerHTML = `<h4 style="margin:0 0 8px;">${title}</h4>
                    <p style="margin-bottom:12px;">${name}</p>
                    <a href="${c.template_path}" target="_blank" class="btn-primary" style="display:inline-block;padding:8px 14px;text-decoration:none;">Download certificate</a>`;
            }
            wrap.appendChild(card);
        });
    } catch (e) {
        console.error(e);
        wrap.innerHTML = '<p style="color:#b91c1c;">Could not load certificates.</p>';
    }
}

document.getElementById('btn-logout').addEventListener('click', () => {
    if (typeof PortalAuth !== 'undefined') PortalAuth.clearUser('doctor');
    localStorage.removeItem('seminar_doctor_user');
    localStorage.removeItem('seminar_user');
    window.location.reload();
});

// --- MULTI-STEP FORM LOGIC ---
// --- MULTI-STEP FORM LOGIC ---
async function nextStep(step) {
    if (step >= 1 && step <= REGISTRATION_PREVIEW_STEP && step !== 0) {
        if (!document.getElementById('reg-tnc-accept')?.checked) {
            alert('Please accept the Terms and Conditions on the Terms step first.');
            return nextStep(0);
        }
    }
    if (step >= 2 && step <= REGISTRATION_PREVIEW_STEP) {
        const err = validateRegistrationAgainstConfigForSteps(step - 1);
        if (err) {
            alert(err);
            return;
        }
    }

    // Hide all steps
    document.querySelectorAll('.form-step').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));

    // Show current step
    document.getElementById(`step-${step}`).classList.remove('hidden');

    // Update progress indicator
    for (let i = 0; i <= step; i++) {
        const ind = document.getElementById(`ind-step-${i}`);
        if (ind) ind.classList.add('active');
    }

    // If moving to preview, populate data and generate PDF iframe
    if (step === REGISTRATION_PREVIEW_STEP) {
        const prevTnc = document.getElementById('prev-tnc-block');
        const prevTncText = document.getElementById('prev-tnc-text');
        if (prevTnc && prevTncText) {
            prevTncText.textContent = window.__seminarTermsText || '—';
            prevTnc.style.display = 'block';
        }
        document.getElementById('prev-name').innerText = `${document.getElementById('reg-fname').value} ${document.getElementById('reg-mname').value} ${document.getElementById('reg-lname').value}`;
        document.getElementById('prev-contact').innerText = `${document.getElementById('reg-email').value} / ${document.getElementById('reg-phone').value}`;
        document.getElementById('prev-addr').innerText = document.getElementById('reg-addr').value;
        document.getElementById('prev-loc').innerText = `${document.getElementById('reg-city').value}, ${document.getElementById('reg-state').value}, ${document.getElementById('reg-pin').value}`;
        
        const qual = document.getElementById('reg-qual').value;
        document.getElementById('prev-qual').innerText = qual;
        if(qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner') {
            document.getElementById('prev-ncism-box').classList.remove('hidden');
            document.getElementById('prev-ncism').innerText = document.getElementById('reg-ncism').value;
            if(document.getElementById('reg-cert-file').files.length > 0) {
                document.getElementById('prev-cert-box').classList.remove('hidden');
            } else {
                document.getElementById('prev-cert-box').classList.add('hidden');
            }
        } else {
            document.getElementById('prev-ncism-box').classList.add('hidden');
            document.getElementById('prev-cert-box').classList.add('hidden');
        }

        document.getElementById('prev-college').innerText = document.getElementById('reg-college').value;
        document.getElementById('prev-cloc').innerText = `${document.getElementById('reg-ccity').value}, ${document.getElementById('reg-cstate').value}`;
        
        // Load QR Code dynamically for preview
        const trackingId = `PREVIEW-${currentUser.id}-${Date.now().toString().slice(-4)}`;
        document.getElementById('prev-qrcode').src = `/api/qrcode/${trackingId}`;
        document.getElementById('prev-qrcode').style.display = 'inline-block';
        
        // Wait for image to load to embed in PDF
        document.getElementById('prev-qrcode').onload = () => {
            generatePdfBlob(document.getElementById('prev-qrcode'));
        };
    }
}

let currentPdfBlobUrl = null;

function generatePdfBlob(qrImgElement) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const accent = [15, 118, 110];
    const ink = [15, 23, 42];
    const muted = [71, 85, 105];

    doc.setDrawColor(...accent);
    doc.setLineWidth(0.6);
    doc.roundedRect(10, 8, 190, 282, 3, 3);

    doc.setFillColor(...accent);
    doc.rect(10, 8, 190, 28, 'F');
    doc.setFontSize(15);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('Vaidya Gogate Memorial Foundation', 105, 20, { align: 'center' });
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'normal');
    doc.text('Seminar registration — application preview', 105, 29, { align: 'center' });

    if (qrImgElement && qrImgElement.src) {
        const canvas = document.createElement('canvas');
        canvas.width = qrImgElement.width;
        canvas.height = qrImgElement.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(qrImgElement, 0, 0, qrImgElement.width, qrImgElement.height);
        const imgData = canvas.toDataURL('image/png');
        doc.addImage(imgData, 'PNG', 162, 42, 32, 32);
    }

    let y = 44;
    const drawSection = (title) => {
        y += 6;
        doc.setFillColor(240, 253, 250);
        doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
        doc.setFontSize(11.5);
        doc.setTextColor(...accent);
        doc.setFont('helvetica', 'bold');
        doc.text(title, 18, y + 6.5);
        y += 14;
    };

    const drawTableRow = (label, value) => {
        const lh = 6.2;
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...muted);
        const lines = doc.splitTextToSize(String(value || '—'), 118);
        const rowH = Math.max(10, lines.length * lh - 1);
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + rowH, 196, y + rowH);
        doc.text(label, 18, y + 7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        doc.text(lines, 72, y + 7);
        y += rowH;
    };

    drawSection('Candidate');
    drawTableRow(
        'Full name',
        `${document.getElementById('reg-fname').value} ${document.getElementById('reg-mname').value} ${document.getElementById('reg-lname').value}`
    );
    drawTableRow('Email', document.getElementById('reg-email').value);
    drawTableRow('Phone', document.getElementById('reg-phone').value);
    drawTableRow('Address', document.getElementById('reg-addr').value);
    drawTableRow(
        'City / State / PIN',
        `${document.getElementById('reg-city').value}, ${document.getElementById('reg-state').value} — ${document.getElementById('reg-pin').value}`
    );

    drawSection('Professional & college');
    drawTableRow('Qualification', document.getElementById('reg-qual').value);
    const qual = document.getElementById('reg-qual').value;
    if (qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner') {
        drawTableRow('Registration ID', document.getElementById('reg-ncism').value);
    }
    drawTableRow('College', document.getElementById('reg-college').value);
    drawTableRow('College city / state', `${document.getElementById('reg-ccity').value}, ${document.getElementById('reg-cstate').value}`);

    const terms = window.__seminarTermsText || '';
    if (terms) {
        y += 6;
        drawSection('Seminar terms & conditions');
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        const tLines = doc.splitTextToSize(terms, 175);
        doc.text(tLines, 18, y);
        y += tLines.length * 4.2 + 4;
    }

    y += 8;
    doc.setFontSize(11);
    doc.setTextColor(180, 83, 9);
    doc.setFont('helvetica', 'bold');
    doc.text('DRAFT PREVIEW — not submitted', 105, y, { align: 'center' });

    const pdfBlob = doc.output('blob');
    if (currentPdfBlobUrl) URL.revokeObjectURL(currentPdfBlobUrl);
    currentPdfBlobUrl = URL.createObjectURL(pdfBlob);

    document.getElementById('pdf-viewer').src = currentPdfBlobUrl;
}

function downloadPdf() {
    if(currentPdfBlobUrl) {
        const a = document.createElement('a');
        a.href = currentPdfBlobUrl;
        a.download = "Application_Form.pdf";
        a.click();
    }
}

function autofillAddress() {
    const pin = document.getElementById('reg-pin').value;
    if(pin.length === 6) {
        // Mock Pincode API
        document.getElementById('reg-city').value = 'Pune';
        document.getElementById('reg-state').value = 'Maharashtra';
        document.getElementById('reg-country').value = 'India';
    }
}

function toggleRegBlock() {
    const qual = document.getElementById('reg-qual').value;
    if(qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner') {
        document.getElementById('reg-block').classList.remove('hidden');
    } else {
        document.getElementById('reg-block').classList.add('hidden');
    }
    refreshRegistrationRequiredAttributes();
}

function verifyNcism() {
    const ncism = document.getElementById('reg-ncism').value;
    if(ncism.length > 3) {
        document.getElementById('ncism-status').classList.remove('hidden');
        alert("System Auto-Verified Registration ID successfully!");
    } else {
        alert("Invalid Registration ID");
    }
}

async function submitApplication() {
    if(!document.getElementById('tnc').checked) {
        alert("Please accept the Terms and Conditions.");
        return;
    }

    const vErr = validateRegistrationAgainstConfigForSteps(4);
    if (vErr) {
        alert(vErr);
        return;
    }
    
    const formDataObj = {
        fname: document.getElementById('reg-fname').value,
        mname: document.getElementById('reg-mname').value,
        lname: document.getElementById('reg-lname').value,
        email: document.getElementById('reg-email').value,
        phone: document.getElementById('reg-phone').value,
        address: document.getElementById('reg-addr').value,
        pin: document.getElementById('reg-pin').value,
        city: document.getElementById('reg-city').value,
        state: document.getElementById('reg-state').value,
        country: document.getElementById('reg-country').value,
        qual: document.getElementById('reg-qual').value,
        ncism: document.getElementById('reg-ncism').value,
        college: document.getElementById('reg-college').value,
        ccity: document.getElementById('reg-ccity').value,
        cstate: document.getElementById('reg-cstate').value,
        agree_terms: document.getElementById('tnc').checked ? '1' : ''
    };

    const payload = new FormData();
    payload.append('userId', currentUser.id);
    payload.append('seminarId', activeSeminarIdForReg || 1);
    payload.append('formData', JSON.stringify(formDataObj));
    if (window.__otpOnApplication) {
        payload.append('phoneOtpToken', window.__regPhoneOtpToken || '');
        payload.append('emailOtpToken', window.__regEmailOtpToken || '');
    }
    payload.append('fieldOtpTokens', JSON.stringify(window.__fieldOtpTokens || {}));
    
    const certFile = document.getElementById('reg-cert-file').files[0];
    if (certFile) {
        payload.append('certificate', certFile);
    }

    try {
        const res = await fetch('/api/applications/submit', {
            method: 'POST',
            body: payload
        });
        const result = await res.json();
        if(result.success) {
            alert(`Application submitted successfully. Your application number is ${result.applicationNo}. You can track status under View Applications.`);
            cancelRegistration();
            loadApplications();
        } else {
            alert(result.error || "Submission failed.");
        }
    } catch (err) { console.error(err); }
}

let userApplications = [];
let userCaseApplications = [];

function summaryCancellationPolicy(raw) {
    if (!raw) return '';
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!p || typeof p !== 'object') return '';
        const parts = [];
        if (p.noRefundWithinDays != null) {
            parts.push(`No refund within ${p.noRefundWithinDays} days of the event.`);
        }
        if (Array.isArray(p.tiers)) {
            p.tiers.forEach((t) => {
                if (t.minDaysBeforeEvent != null && t.refundPercent != null) {
                    parts.push(`${t.refundPercent}% refund if cancelling at least ${t.minDaysBeforeEvent} days before the event.`);
                }
            });
        }
        return parts.join(' ');
    } catch (_) {
        return '';
    }
}

function seminarShowsWhatsappLink(app) {
    const st = String((app && app.status) || '').toLowerCase();
    return (
        (st === 'approved_pending_payment' || st === 'completed' || st === 'checked_in') &&
        app &&
        app.whatsapp_group_url &&
        String(app.whatsapp_group_url).trim()
    );
}

function renderWhatsappLinkBlock(app) {
    if (!seminarShowsWhatsappLink(app)) return '';
    const href = normalizeWhatsappHref(app.whatsapp_group_url);
    if (!href) return '';
    return (
        '<div style="margin-top:12px;padding:12px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;">' +
        '<p style="font-size:0.88rem;color:#047857;margin:0 0 8px;font-weight:600;"><i class="fab fa-whatsapp"></i> Seminar WhatsApp group</p>' +
        '<a href="' +
        escapeHtml(href) +
        '" target="_blank" rel="noopener" class="btn-success" style="display:inline-block;text-decoration:none;">Join WhatsApp group</a>' +
        '</div>'
    );
}

function doctorCanCancelApplication(app) {
    const st = String((app && app.status) || '').toLowerCase();
    if (['rejected', 'cancelled'].includes(st)) return false;
    if (app && app.seminar_event_date) {
        const ev = new Date(app.seminar_event_date);
        if (!Number.isNaN(ev.getTime())) {
            const eventDay = new Date(ev.getFullYear(), ev.getMonth(), ev.getDate());
            const today = new Date();
            const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            if (todayDay >= eventDay) return false;
        }
    }
    return true;
}

async function doctorCancelApplication(applicationId) {
    if (!currentUser || !currentUser.id) return;
    const app = (userApplications || []).find((a) => a.id === applicationId);
    if (app && !doctorCanCancelApplication(app)) {
        alert('You can only cancel before the seminar day, and not after rejection or cancellation.');
        return;
    }
    const policyText = app ? summaryCancellationPolicy(app.cancellation_policy_json) : '';
    let confirmMsg =
        'Cancel this application?\n\n• Only allowed before the seminar day.\n• Your e-ticket QR code will be invalidated and cannot be used for check-in.';
    if (policyText) {
        confirmMsg += '\n\nCancellation policy:\n' + policyText;
        confirmMsg += '\n\nAutomated payment refunds are not processed online yet; contact support if you paid.';
    } else if (app && (app.status === 'completed' || app.status === 'checked_in')) {
        confirmMsg += '\n\nIf you already paid, refund rules depend on the seminar policy. Automated refunds are not wired yet.';
    } else {
        confirmMsg += '\n\nIf you already paid, no refund may apply per seminar policy.';
    }
    if (!confirm(confirmMsg)) {
        return;
    }
    try {
        const res = await fetch(`/api/applications/${applicationId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.detail || 'Application cancelled. Your ticket is no longer valid for entry.');
            loadApplications();
            loadDoctorEventTickets();
        } else {
            alert(data.error || 'Could not cancel.');
        }
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

function normalizeWhatsappHref(raw) {
    const u = String(raw || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^wa\.me\//i.test(u) || /whatsapp\.com/i.test(u)) return 'https://' + u.replace(/^\/+/, '');
    return 'https://' + u.replace(/^\/+/, '');
}

function seminarTrackFingerprint(apps) {
    return (apps || [])
        .map((a) => {
            const tl = a.timeline || {};
            const stepSig = (tl.steps || []).map((s) => s.key + ':' + s.state + ':' + (s.at || '')).join(',');
            return [a.id, a.status, a.updated_at || '', stepSig].join(':');
        })
        .join('|');
}

async function loadApplications(silentPoll) {
    const uid = doctorNumericUserId();
    if (!uid) {
        const list = document.getElementById('applications-list');
        const trackerContainer = document.getElementById('applications-tracker-container');
        if (list) list.innerHTML = '<tr><td colspan="3">Please sign in again.</td></tr>';
        if (trackerContainer) trackerContainer.innerHTML = '<p style="color:#64748b;">Sign in to track applications.</p>';
        return;
    }
    try {
        const res = await fetch(`/api/applications/${uid}`, { cache: 'no-store' });
        const payload = await res.json();
        userApplications = Array.isArray(payload) ? payload : payload.applications || [];
        if (payload.portalYear) doctorPortalYear = payload.portalYear;
        const fp = seminarTrackFingerprint(userApplications);
        if (silentPoll && fp === _lastSeminarTrackFingerprint) return;
        _lastSeminarTrackFingerprint = fp;

        const list = document.getElementById('applications-list');
        const trackerContainer = document.getElementById('applications-tracker-container');
        list.innerHTML = '';
        trackerContainer.innerHTML = '';

        if (!userApplications.length) {
            list.innerHTML = '<tr><td colspan="3" style="text-align:center;">No seminar applications yet.</td></tr>';
            trackerContainer.innerHTML =
                '<p style="color:#64748b;">No seminar registrations yet. Apply from <strong>Available Seminars</strong>.</p>';
        }

        userApplications.forEach((a, index) => {
            // Render Table Row
            const canEdit = a.status === 'submitted' || a.status === 'pending_approval';
            const editBtn = canEdit ? `<button class="btn-warning" style="padding: 5px 10px; margin-right: 5px;" onclick="editApplication(${index})">Edit</button>` : '';
            const st = String(a.status || '').toLowerCase();
            const canDoctorCancel = doctorCanCancelApplication(a);
            const cancelBtn = canDoctorCancel
                ? `<button type="button" class="btn-primary" style="padding: 5px 10px; margin-right: 5px; background: #b91c1c; border: none;" onclick="doctorCancelApplication(${a.id})">Cancel</button>`
                : '';

            list.innerHTML += `
                <tr>
                    <td><strong>${a.application_no}</strong></td>
                    <td><span style="background: ${a.status === 'rejected' ? '#fee2e2' : '#fef3c7'}; padding: 5px; border-radius: 5px;">${a.status.toUpperCase()}</span></td>
                    <td>${editBtn}${cancelBtn}<button class="btn-primary" style="padding: 5px 10px;" onclick="viewApplication(${index})">View Details</button></td>
                </tr>
            `;

            trackerContainer.innerHTML += renderSeminarApplicationTrackerCard(a);
        });
    } catch (err) {
        console.error(err);
    }
}

let currentlyViewedApp = null;

function viewApplication(index) {
    const app = userApplications[index];
    currentlyViewedApp = app;
    let formData = {};
    try {
        formData = JSON.parse(app.form_data || '{}');
    } catch(e){}

    const contentDiv = document.getElementById('view-app-content');
    contentDiv.innerHTML = `
        <p><strong>Application No:</strong> ${app.application_no}</p>
        <p><strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">${app.status.toUpperCase()}</span></p>
        <hr style="margin: 10px 0; border: 0; border-top: 1px solid #cbd5e1;">
        <h4 style="color: #475569; margin-bottom: 5px;">Step 1: Personal Details</h4>
        <p><strong>Name:</strong> ${formData.fname || ''} ${formData.mname || ''} ${formData.lname || ''}</p>
        <p><strong>Email:</strong> ${formData.email || ''}</p>
        <p><strong>Phone:</strong> ${formData.phone || ''}</p>
        <hr style="margin: 10px 0; border: 0; border-top: 1px solid #cbd5e1;">
        <h4 style="color: #475569; margin-bottom: 5px;">Step 2: Address Details</h4>
        <p><strong>Address:</strong> ${formData.address || ''}</p>
        <p><strong>Location:</strong> ${formData.city || ''}, ${formData.state || ''} - ${formData.pin || ''}</p>
        <hr style="margin: 10px 0; border: 0; border-top: 1px solid #cbd5e1;">
        <h4 style="color: #475569; margin-bottom: 5px;">Step 3 & 4: Education & College</h4>
        <p><strong>Qualification:</strong> ${formData.qual || ''}</p>
        ${formData.qual === 'PG' ? `<p><strong>NCISM ID:</strong> ${formData.ncism}</p>` : ''}
        <p><strong>College:</strong> ${formData.college || ''}</p>
        <p><strong>Location:</strong> ${formData.ccity || ''}, ${formData.cstate || ''}</p>
        <hr style="margin: 16px 0; border: 0; border-top: 1px solid #cbd5e1;">
        <h4 style="color: #1a237e; margin-bottom: 12px;"><i class="fas fa-route"></i> Seminar registration tracking</h4>
        <div id="view-app-tracking"></div>
    `;
    const trackEl = document.getElementById('view-app-tracking');
    if (trackEl) {
        let extra = renderTrackerStepsHtml(app.timeline || {});
        extra += renderWhatsappLinkBlock(app);
        const pol = summaryCancellationPolicy(app.cancellation_policy_json);
        if (pol) {
            extra +=
                '<p style="margin-top:12px;font-size:0.85rem;color:#64748b;"><strong>Cancellation policy:</strong> ' +
                escapeHtml(pol) +
                '</p>';
        }
        if (app.terms_conditions) {
            extra +=
                '<div style="margin-top:12px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;"><strong>Terms &amp; conditions:</strong><pre style="white-space:pre-wrap;font-family:inherit;font-size:0.85rem;margin-top:8px;">' +
                escapeHtml(app.terms_conditions) +
                '</pre></div>';
        }
        trackEl.innerHTML = extra;
    }

    document.getElementById('view-app-modal').classList.remove('hidden');
    document.getElementById('view-app-modal').style.display = 'flex';
}

// Ensure closing the modal removes flex
document.getElementById('view-app-modal').querySelector('button').onclick = function() {
    document.getElementById('view-app-modal').classList.add('hidden');
    document.getElementById('view-app-modal').style.display = '';
};

function downloadViewedAppPdf() {
    if (!currentlyViewedApp) return;
    const app = currentlyViewedApp;
    let formData = {};
    try {
        formData = JSON.parse(app.form_data || '{}');
    } catch (e) {}

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const accent = [15, 118, 110];
    const ink = [15, 23, 42];
    const muted = [71, 85, 105];

    doc.setFillColor(...accent);
    doc.rect(0, 0, 210, 36, 'F');
    doc.setFontSize(16);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('Vaidya Gogate Memorial Foundation', 105, 16, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('Submitted seminar application', 105, 26, { align: 'center' });

    let y = 46;
    doc.setFontSize(11);
    doc.setTextColor(...accent);
    doc.setFont('helvetica', 'bold');
    doc.text('Application summary', 14, y);
    y += 8;
    doc.setFontSize(10);
    doc.setTextColor(...ink);
    doc.setFont('helvetica', 'normal');
    doc.text('Application number: ' + String(app.application_no || '—'), 14, y);
    y += 7;
    doc.text('Current status: ' + String(app.status || '').toUpperCase(), 14, y);
    y += 12;

    const row = (label, val) => {
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + 8, 196, y + 8);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(...muted);
        doc.text(label, 18, y + 6);
        const lines = doc.splitTextToSize(String(val == null ? '—' : val), 118);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        doc.text(lines, 72, y + 6);
        y += Math.max(12, lines.length * 5.5 + 4);
    };

    doc.setFillColor(240, 253, 250);
    doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...accent);
    doc.text('Personal & contact', 18, y + 6.5);
    y += 14;
    row('Candidate name', `${formData.fname || ''} ${formData.mname || ''} ${formData.lname || ''}`.trim());
    row('Email', formData.email || '');
    row('Phone', formData.phone || '');

    doc.setFillColor(240, 253, 250);
    doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...accent);
    doc.text('Address', 18, y + 6.5);
    y += 14;
    row('Street / full address', formData.address || '');
    row('City, state, PIN', `${formData.city || ''}, ${formData.state || ''} — ${formData.pin || ''}`);

    doc.setFillColor(240, 253, 250);
    doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...accent);
    doc.text('Education & college', 18, y + 6.5);
    y += 14;
    row('Qualification', formData.qual || '');
    if (formData.qual === 'PG' || formData.qual === 'Practicing Vaidya' || formData.qual === 'Practitioner') {
        row('Registration / NCISM ID', formData.ncism || '');
    }
    row('College', formData.college || '');
    row('College location', `${formData.ccity || ''}, ${formData.cstate || ''}`);

    const terms = app.terms_conditions || '';
    if (terms) {
        if (y > 250) {
            doc.addPage();
            y = 20;
        }
        doc.setFillColor(240, 253, 250);
        doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...accent);
        doc.text('Seminar terms & conditions', 18, y + 6.5);
        y += 14;
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        const tLines = doc.splitTextToSize(terms, 175);
        doc.text(tLines, 14, y);
    }

    doc.save(`Application_${app.application_no}.pdf`);
}

async function processPayment(appId, amount, appNo) {
    let regId = parseInt(appId, 10);
    if (Number.isNaN(regId) || regId < 1) {
        const found = (userApplications || []).find((x) => String(x.application_no) === String(appNo));
        if (found && found.id != null) {
            regId = parseInt(found.id, 10);
        }
    }
    if (Number.isNaN(regId) || regId < 1) {
        alert('Could not determine your application record. Please refresh the page, open “My Applications”, and click Pay again.');
        return;
    }
    try {
        const res = await fetch('/api/payments/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId: regId, amount, userId: currentUser.id })
        });
        let result = {};
        try {
            result = await res.json();
        } catch (_) {
            alert('Payment service returned an invalid response. Check that the site is not in maintenance mode and try again.');
            return;
        }
        if (!res.ok || !result.success) {
            alert(result.error || result.message || 'Payment could not be started. Check the server console or try again.');
            return;
        }
        
        if (result.success) {
            if (result.gateway === 'razorpay') {
                // Initialize Razorpay checkout
                const options = {
                    key: result.order.key_id,
                    amount: result.order.amount,
                    currency: result.order.currency,
                    name: 'Vaidya Gogate Memorial Foundation National Seminar',
                    description: 'Seminar Registration',
                    order_id: result.order.id,
                    handler: function (response) {
                        // Verify payment
                        fetch('/api/payments/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ applicationId: regId, paymentData: response, gateway: 'razorpay', userId: currentUser.id })
                        }).then(res => res.json()).then(verifyResult => {
                            if (verifyResult.success) {
                                alert(`Payment Successful! Join WhatsApp Group: https://chat.whatsapp.com/mocklink`);
                                loadApplications();
                                loadDoctorDashboardStats();
                                loadDoctorOrders();
                                loadDoctorReceipts();
                                loadDoctorEventTickets();
                            } else {
                                alert('Payment verification failed');
                            }
                        });
                    },
                    prefill: {
                        name: currentUser.first_name + ' ' + currentUser.last_name,
                        email: 'user@example.com',
                        contact: currentUser.phone
                    },
                    theme: {
                        color: '#0f766e'
                    }
                };
                const rzp = new Razorpay(options);
                rzp.open();
            } else {
                // Mock gateway or other: payment already completed on server for mock
                alert(`Payment processed via ${result.gateway || 'Mock Gateway'}! You can open Orders, Receipts, and Participant tickets from the menu.`);
                loadApplications();
                loadDoctorDashboardStats();
                loadDoctorOrders();
                loadDoctorReceipts();
                loadDoctorEventTickets();
            }
        }
    } catch(err) { console.error(err); }
}

async function loadDoctorDashboardStats() {
    if (!currentUser) return;
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v != null && v !== '' ? String(v) : '0';
    };
    try {
        const res = await fetch('/api/doctor/dashboard-stats/' + currentUser.id);
        if (!res.ok) throw new Error('stats');
        const d = await res.json();
        set('stat-registered', d.registered_seminars);
        set('stat-paid', d.paid_or_confirmed);
        set('stat-checked', d.checked_in_seminars);
        set('stat-feedback', d.feedback_submitted);
        set('stat-abstracts', d.abstracts_submitted);
        set('stat-ptix', d.participant_tickets);
        set('stat-suptix', d.support_tickets);
    } catch (e) {
        console.error(e);
    }
}

let doctorOrdersCache = [];

async function loadDoctorOrders() {
    const tbody = document.getElementById('orders-list');
    if (!tbody || !currentUser) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;">Loading…</td></tr>';
    try {
        const res = await fetch('/api/doctor/orders/' + currentUser.id);
        const rows = await res.json();
        doctorOrdersCache = Array.isArray(rows) ? rows : [];
        tbody.innerHTML = '';
        if (doctorOrdersCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;">No orders yet.</td></tr>';
            return;
        }
        doctorOrdersCache.forEach((o) => {
            const dt = o.payment_date ? new Date(o.payment_date).toLocaleString() : '—';
            const receiptBtn =
                o.status === 'success'
                    ? `<button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.78rem;border-radius:8px;" onclick="openDoctorOrderReceipt(${o.id})">Receipt</button>`
                    : '—';
            const st = escapeHtml(o.status || '—');
            const rs = escapeHtml(o.registration_status || '—');
            const stPill = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:0.75rem;font-weight:700;background:${o.status === 'success' ? '#d1fae5' : '#fef3c7'};color:${o.status === 'success' ? '#065f46' : '#92400e'};">${st}</span>`;
            const rsPill = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;background:#f1f5f9;color:#475569;">${rs}</span>`;
            tbody.innerHTML += `<tr>
                <td><strong>${o.order_id_string || o.id}</strong></td>
                <td>${escapeHtml(o.seminar_title || '—')}</td>
                <td>${o.application_no || '—'}</td>
                <td><strong>₹${o.amount != null ? o.amount : '—'}</strong></td>
                <td>${stPill}</td>
                <td>${rsPill}</td>
                <td style="font-size:0.85rem;color:#64748b;">${dt}</td>
                <td>${receiptBtn}</td>
            </tr>`;
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#b91c1c;">Could not load orders.</td></tr>';
    }
}

async function loadDoctorReceipts() {
    const tbody = document.getElementById('doctor-receipts-list');
    if (!tbody || !currentUser) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;">Loading…</td></tr>';
    try {
        const res = await fetch('/api/doctor/orders/' + currentUser.id);
        const rows = await res.json();
        const paid = (Array.isArray(rows) ? rows : []).filter((o) => o.status === 'success');
        tbody.innerHTML = '';
        if (paid.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;">No successful payments yet.</td></tr>';
            return;
        }
        paid.forEach((o) => {
            const dt = o.payment_date ? new Date(o.payment_date).toLocaleString() : '—';
            tbody.innerHTML += `<tr>
                <td><strong>${o.order_id_string || o.id}</strong></td>
                <td>${escapeHtml(o.seminar_title || '—')}</td>
                <td><strong style="color:#0f766e;">₹${o.amount != null ? o.amount : '—'}</strong></td>
                <td style="font-size:0.85rem;color:#64748b;">${dt}</td>
                <td><button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.78rem;border-radius:8px;" onclick="openDoctorOrderReceipt(${o.id})">Open receipt</button></td>
            </tr>`;
        });
    } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#b91c1c;">Could not load receipts.</td></tr>';
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function receiptPrintCss() {
    return [
        '@page { size: A4; margin: 12mm; }',
        '*{box-sizing:border-box}',
        'body{font-family:system-ui,Segoe UI,sans-serif;color:#0f172a;font-size:11pt;margin:0;padding:10mm 12mm 26mm;line-height:1.5;background:#f8fafc}',
        '.rh,.rf{font-size:8.5pt;color:#334155;border:1px solid #cbd5e1;background:linear-gradient(180deg,#f8fafc,#f1f5f9);padding:8px 12px}',
        '.rh strong,.rf strong{color:#0f172a}',
        '@media print{',
        '  .no-print{display:none!important}',
        '  .rh{position:fixed;top:0;left:0;right:0}',
        '  .rf{position:fixed;bottom:0;left:0;right:0}',
        '  body{padding-top:52px;padding-bottom:52px}',
        '}',
        '.receipt-hero{background:linear-gradient(120deg,#0f766e,#14b8a6);color:#ecfdf5;border-radius:14px;padding:18px 20px;margin:0 0 18px;box-shadow:0 12px 30px rgba(15,118,110,0.25)}',
        '.receipt-hero .amt{font-size:1.75rem;font-weight:800;letter-spacing:-0.02em}',
        '.receipt-hero .meta{margin-top:6px;opacity:0.95;font-size:0.95rem}',
        'h1{font-size:1.35rem;color:#0f766e;margin:0 0 8px;font-weight:800}',
        '.sub{color:#64748b;font-size:0.92rem;margin:0 0 16px}',
        'table{width:100%;border-collapse:collapse;margin-top:10px;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0}',
        'thead th{text-align:left;background:linear-gradient(180deg,#f0fdfa,#ccfbf1);color:#115e59;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;padding:10px 12px;border-bottom:2px solid #99f6e4}',
        'tbody td{padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top}',
        'tbody td:first-child{width:34%;color:#64748b;font-weight:600;font-size:0.9rem;background:#fafafa}',
        'tbody tr:nth-child(even) td{background:#fbfffd}',
        '.btn-print{margin:16px 0;padding:10px 18px;font-size:0.95rem;cursor:pointer;border-radius:10px;border:none;background:linear-gradient(135deg,#0d9488,#0f766e);color:#ecfdf5;font-weight:700}'
    ].join('');
}

async function openDoctorOrderReceipt(orderDbId) {
    if (!currentUser) return;
    let o = doctorOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
    if (!o) {
        try {
            const res = await fetch('/api/doctor/orders/' + currentUser.id);
            const rows = await res.json();
            doctorOrdersCache = Array.isArray(rows) ? rows : [];
            o = doctorOrdersCache.find((x) => Number(x.id) === Number(orderDbId));
        } catch (e) {
            console.error(e);
        }
    }
    if (!o) {
        alert('Order not found.');
        return;
    }
    const w = window.open('', '_blank');
    if (!w) {
        alert('Please allow pop-ups to view the receipt.');
        return;
    }
    const uidStr = escapeHtml(String(o.user_id_string || currentUser.user_id_string || currentUser.id));
    const orderStr = escapeHtml(String(o.order_id_string || o.id));
    const etix = escapeHtml(String(o.e_ticket_id || '—'));
    const txn = escapeHtml(String(o.provider_transaction_id || '—'));
    const prov = escapeHtml(String(o.payment_gateway || '—'));
    const provOrd = escapeHtml(String(o.provider_order_id || '—'));
    const name = escapeHtml(
        [o.first_name || currentUser.first_name, o.middle_name || currentUser.middle_name, o.last_name || currentUser.last_name]
            .filter(Boolean)
            .join(' ')
            .trim() || `${currentUser.first_name || ''} ${currentUser.last_name || ''}`.trim()
    );
    const email = escapeHtml(String(o.user_email || currentUser.email || '—'));
    const phone = escapeHtml(String(o.user_phone || currentUser.phone || '—'));
    const genAt = escapeHtml(new Date().toLocaleString());
    const headerInner = `<strong>Order</strong> ${orderStr} &nbsp;|&nbsp; <strong>E‑ticket</strong> ${etix} &nbsp;|&nbsp; <strong>User ID</strong> ${uidStr}`;
    const footerInner = `<strong>Generated</strong> ${genAt} &nbsp;|&nbsp; <strong>Order</strong> ${orderStr} &nbsp;|&nbsp; <strong>Txn</strong> ${txn} &nbsp;|&nbsp; <strong>E‑ticket</strong> ${etix}`;
    const lines = [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment receipt</title>',
        '<style>' + receiptPrintCss() + '</style></head><body>',
        brandingHeaderHtml(),
        '<div class="rh">' + headerInner + '</div>',
        '<h1>Payment receipt</h1>',
        '<p class="sub">Vaidya Gogate Memorial Foundation — National Seminar portal</p>',
        '<div class="receipt-hero"><div class="amt">₹' +
            escapeHtml(o.amount != null ? String(o.amount) : '—') +
            '</div><div class="meta">' +
            escapeHtml(o.seminar_title || 'Seminar payment') +
            ' · Order <code style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:6px;">' +
            orderStr +
            '</code></div></div>',
        '<button type="button" class="btn-print no-print" onclick="window.print()">Print / Save as PDF</button>',
        '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>',
        `<tr><td>Payer name</td><td>${name}</td></tr>`,
        `<tr><td>Email</td><td>${email}</td></tr>`,
        `<tr><td>Phone</td><td>${phone}</td></tr>`,
        `<tr><td>Public user ID</td><td><code>${uidStr}</code></td></tr>`,
        `<tr><td>Order ID</td><td><code>${orderStr}</code></td></tr>`,
        `<tr><td>E‑ticket ID (12‑digit)</td><td><code>${etix}</code></td></tr>`,
        `<tr><td>Seminar</td><td>${escapeHtml(o.seminar_title || '—')}</td></tr>`,
        `<tr><td>Application no.</td><td>${escapeHtml(String(o.application_no || '—'))}</td></tr>`,
        `<tr><td>Registration status</td><td>${escapeHtml(o.registration_status || '—')}</td></tr>`,
        `<tr><td>Payment status</td><td>${escapeHtml(o.status || '—')}</td></tr>`,
        `<tr><td>Amount</td><td>₹${o.amount != null ? escapeHtml(String(o.amount)) : '—'}</td></tr>`,
        `<tr><td>Paid on</td><td>${o.payment_date ? escapeHtml(new Date(o.payment_date).toLocaleString()) : '—'}</td></tr>`,
        `<tr><td>Payment provider</td><td>${prov}</td></tr>`,
        `<tr><td>Provider order / session ID</td><td><code>${provOrd}</code></td></tr>`,
        `<tr><td>Provider transaction ID</td><td><code>${txn}</code></td></tr>`,
        '</tbody></table>',
        '<p class="sub no-print" style="margin-top:20px">Use <strong>Print → Save as PDF</strong> in your browser for a PDF copy.</p>',
        '<div class="rf">' + footerInner + '</div>',
        '</body></html>'
    ];
    w.document.write(lines.join(''));
    w.document.close();
}

async function loadDoctorEventTickets() {
    const box = document.getElementById('tickets-container');
    if (!box || !currentUser) return;
    box.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/doctor/event-tickets/' + currentUser.id);
        const rows = await res.json();
        if (!rows || rows.length === 0) {
            box.innerHTML = '<p style="color:#64748b;">No participant tickets yet. After a successful payment, your QR entry ticket appears here.</p>';
            return;
        }
        let html = '<div style="display:flex;flex-direction:column;gap:20px;">';
        rows.forEach((t) => {
            const regSt = String(t.registration_status || '').toLowerCase();
            const invalid = regSt === 'cancelled' || regSt === 'rejected' || t.is_valid === 0;
            const qr = !invalid && t.qr_code_data ? `/api/qrcode/${encodeURIComponent(t.qr_code_data)}` : '';
            const scanned = t.is_scanned ? `Scanned · ${t.scan_time ? new Date(t.scan_time).toLocaleString() : ''}` : 'Not scanned yet';
            const statusLine = invalid
                ? `<p style="margin:8px 0 0;font-size:0.9rem;color:#b91c1c;font-weight:600;">Invalid — registration ${regSt === 'cancelled' ? 'cancelled' : regSt === 'rejected' ? 'rejected' : 'no longer active'}. Do not use this QR for entry.</p>`
                : `<p style="margin:8px 0 0;font-size:0.85rem;color:#64748b;">${escapeHtml(scanned)}</p>`;
            html += `<div style="border:1px solid ${invalid ? '#fecaca' : '#e2e8f0'};border-radius:12px;padding:16px;display:grid;grid-template-columns:140px 1fr;gap:16px;align-items:start;${invalid ? 'opacity:0.85;background:#fef2f2;' : ''}">
                <div>${qr ? `<img src="${qr}" alt="QR" style="width:128px;height:128px;border:1px solid #cbd5e1;border-radius:8px;">` : '<span style="color:#94a3b8;font-size:0.85rem;">QR unavailable</span>'}</div>
                <div>
                    <h4 style="margin:0 0 8px;color:#1a237e;">${escapeHtml(t.seminar_title || 'Seminar')}</h4>
                    <p style="margin:0 0 6px;font-size:0.9rem;"><strong>E‑ticket ID:</strong> <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escapeHtml(t.ticket_id_string || '—')}</code></p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Order:</strong> ${escapeHtml(String(t.order_id_string || '—'))} · <strong>Application:</strong> ${escapeHtml(String(t.application_no || '—'))}</p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Registration:</strong> ${escapeHtml(t.registration_status || '—')} · <strong>Payment:</strong> ${escapeHtml(t.order_status || '—')}</p>
                    ${statusLine}
                </div>
            </div>`;
        });
        html += '</div>';
        box.innerHTML = html;
    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Could not load tickets.</p>';
    }
}

async function submitDoctorPasswordChange() {
    if (!currentUser) return;
    const cur = (document.getElementById('pwd-current') || {}).value || '';
    const n1 = (document.getElementById('pwd-new') || {}).value || '';
    const n2 = (document.getElementById('pwd-new2') || {}).value || '';
    const msg = document.getElementById('pwd-change-msg');
    if (msg) msg.innerText = '';
    if (!cur || !n1) {
        if (msg) msg.style.color = '#b91c1c';
        if (msg) msg.innerText = 'Enter current and new password.';
        return;
    }
    if (n1.length < 4) {
        if (msg) msg.style.color = '#b91c1c';
        if (msg) msg.innerText = 'New password must be at least 4 characters.';
        return;
    }
    if (n1 !== n2) {
        if (msg) msg.style.color = '#b91c1c';
        if (msg) msg.innerText = 'New password and confirmation do not match.';
        return;
    }
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, currentPassword: cur, newPassword: n1 })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
            if (msg) msg.style.color = '#15803d';
            if (msg) msg.innerText = data.message || 'Password updated.';
            document.getElementById('pwd-current').value = '';
            document.getElementById('pwd-new').value = '';
            document.getElementById('pwd-new2').value = '';
        } else {
            if (msg) msg.style.color = '#b91c1c';
            if (msg) msg.innerText = data.error || 'Could not update password.';
        }
    } catch (e) {
        console.error(e);
        if (msg) msg.style.color = '#b91c1c';
        if (msg) msg.innerText = 'Network error.';
    }
}

async function loadDashboardFeedbackSeminars() {
    const sel = document.getElementById('dfb-seminar');
    if (!sel) return;
    try {
        const res = await fetch('/api/seminars');
        const seminars = await res.json();
        sel.innerHTML = '<option value="">— Select seminar —</option>';
        seminars.forEach((s) => {
            sel.innerHTML += `<option value="${s.id}">${s.title}</option>`;
        });
    } catch (e) {
        console.error(e);
    }
}

async function submitDashboardFeedback(e) {
    e.preventDefault();
    if (!currentUser) return;
    const seminarId = document.getElementById('dfb-seminar').value;
    if (!seminarId) {
        alert('Please select a seminar.');
        return;
    }
    try {
        const res = await fetch('/api/feedback/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                seminarId,
                registrationId: null,
                rating: parseInt(document.getElementById('dfb-rating').value, 10),
                contentQuality: parseInt(document.getElementById('dfb-content').value, 10),
                speakerQuality: parseInt(document.getElementById('dfb-speaker').value, 10),
                organizationQuality: parseInt(document.getElementById('dfb-org').value, 10),
                overallExperience: document.getElementById('dfb-exp').value,
                suggestions: document.getElementById('dfb-sug').value,
                wouldAttendAgain: document.getElementById('dfb-again').checked
            })
        });
        const data = await res.json();
        if (data.success) {
            alert('Thank you. Your feedback was submitted and is visible to administrators.');
            document.getElementById('dash-feedback-form').reset();
            document.getElementById('dfb-again').checked = true;
            loadDoctorDashboardStats();
        } else {
            alert(data.error || 'Could not submit feedback.');
        }
    } catch (err) {
        console.error(err);
        alert('Error submitting feedback.');
    }
}

async function loadTickets() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/support-ticket/user/' + currentUser.id);
        const tickets = await res.json();
        const list = document.getElementById('tickets-list');
        list.innerHTML = '';
        if (!tickets || tickets.length === 0) {
            list.innerHTML = '<tr><td colspan="4" style="text-align: center;">No tickets found.</td></tr>';
            return;
        }
        tickets.forEach((t) => {
            if (t.ticket_id) {
                list.innerHTML += `
                <tr>
                    <td><strong>${t.ticket_id}</strong></td>
                    <td>${t.subject || '—'}</td>
                    <td><span style="background: #fef3c7; padding: 5px; border-radius: 5px;">${t.status || 'open'}</span></td>
                    <td><button type="button" class="btn-primary" style="padding: 5px 10px;" onclick="openTicketThread('${t.ticket_id}', false)">Open</button></td>
                </tr>`;
            } else if (t.tracking_id) {
                list.innerHTML += `
                <tr>
                    <td><strong>${t.tracking_id}</strong> <span style="font-size:0.75rem;color:#64748b;">(legacy)</span></td>
                    <td>${t.subject || '—'}</td>
                    <td><span style="background: #fef3c7; padding: 5px; border-radius: 5px;">${t.status || 'Open'}</span></td>
                    <td><button type="button" class="btn-primary" style="padding: 5px 10px;" onclick="openTicketThread('${t.tracking_id}', true)">Open</button></td>
                </tr>`;
            }
        });
    } catch (err) {
        console.error(err);
    }
}

let currentTicketId = null;
let currentLegacyTrackingId = null;

async function openTicketThread(id, isLegacy) {
    currentTicketId = isLegacy ? null : id;
    currentLegacyTrackingId = isLegacy ? id : null;
    document.getElementById('support-main-view').classList.add('hidden');
    document.getElementById('support-chat-view').classList.remove('hidden');
    document.getElementById('chat-title').innerText = isLegacy ? `Legacy ticket (${id})` : `Ticket ${id}`;
    await loadChatMessages();
}

function closeChat() {
    currentTicketId = null;
    currentLegacyTrackingId = null;
    document.getElementById('support-chat-view').classList.add('hidden');
    document.getElementById('support-main-view').classList.remove('hidden');
}

async function loadChatMessages() {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML = '';
    try {
        if (currentTicketId) {
            const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId));
            const ticket = await res.json();
            const messages = ticket.messages || [];
            messages.forEach((m) => {
                const isDoc = m.sender_type !== 'admin';
                box.innerHTML += `
                <div style="align-self: ${isDoc ? 'flex-end' : 'flex-start'}; background: ${isDoc ? '#1a237e' : 'white'}; color: ${isDoc ? 'white' : '#334155'}; border: 1px solid ${isDoc ? '#1a237e' : '#cbd5e1'}; padding: 10px 15px; border-radius: 8px; max-width: 80%;">
                    <p style="font-size: 0.8rem; margin-bottom: 5px; color: ${isDoc ? '#c7d2fe' : '#64748b'};"><strong>${isDoc ? 'You' : 'Admin'}</strong> — ${new Date(m.created_at).toLocaleString()}</p>
                    <p>${(m.message || '').replace(/</g, '&lt;')}</p>
                </div>`;
            });
        } else if (currentLegacyTrackingId) {
            const res = await fetch('/api/support/ticket/' + encodeURIComponent(currentLegacyTrackingId) + '/messages');
            const messages = await res.json();
            messages.forEach((m) => {
                const isDoc = m.sender === 'doctor';
                box.innerHTML += `
                <div style="align-self: ${isDoc ? 'flex-end' : 'flex-start'}; background: ${isDoc ? '#1a237e' : 'white'}; color: ${isDoc ? 'white' : '#334155'}; border: 1px solid ${isDoc ? '#1a237e' : '#cbd5e1'}; padding: 10px 15px; border-radius: 8px; max-width: 80%;">
                    <p style="font-size: 0.8rem; margin-bottom: 5px; color: ${isDoc ? '#c7d2fe' : '#64748b'};"><strong>${isDoc ? 'You' : 'Admin'}</strong> — ${new Date(m.created_at).toLocaleString()}</p>
                    <p>${(m.message || '').replace(/</g, '&lt;')}</p>
                </div>`;
            });
        }
    } catch (err) {
        console.error(err);
    }
    box.scrollTop = box.scrollHeight;
}

async function sendReply() {
    const msgInput = document.getElementById('chat-reply-msg');
    const msg = (msgInput && msgInput.value.trim()) || '';
    if (!msg) return;
    try {
        if (currentTicketId) {
            const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId) + '/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senderId: currentUser.id, senderType: 'user', message: msg })
            });
            if ((await res.json()).success) {
                msgInput.value = '';
                await loadChatMessages();
            }
        } else if (currentLegacyTrackingId) {
            const res = await fetch('/api/support/ticket/' + encodeURIComponent(currentLegacyTrackingId) + '/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg, sender: 'doctor' })
            });
            if ((await res.json()).success) {
                msgInput.value = '';
                await loadChatMessages();
            }
        }
    } catch (err) {
        console.error(err);
    }
}

async function submitSupportTicket() {
    const category = document.getElementById('ticket-cat').value;
    const subject = document.getElementById('ticket-subj').value.trim();
    const description = document.getElementById('ticket-desc').value.trim();
    if (!subject || !description) {
        alert('Subject and description are required.');
        return;
    }
    try {
        const res = await fetch('/api/support-ticket/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, category, subject, description })
        });
        const result = await res.json();
        if (result.success) {
            document.getElementById('ticket-result').innerText = 'Ticket created: ' + result.ticketId;
            document.getElementById('ticket-subj').value = '';
            document.getElementById('ticket-desc').value = '';
            setTimeout(() => {
                document.getElementById('new-ticket-form').classList.add('hidden');
                document.getElementById('ticket-result').innerText = '';
            }, 2500);
            loadTickets();
            loadDoctorDashboardStats();
        }
    } catch (err) {
        console.error(err);
    }
}

// Doctor Profile Management
async function loadProfile() {
    try {
        const res = await fetch(`/api/doctor/profile/${currentUser.id}`);
        const profile = await res.json();
        
        if(profile && profile.id) {
            document.getElementById('profile-specialization').value = profile.specialization || '';
            document.getElementById('profile-registration-no').value = profile.registration_no || '';
            document.getElementById('profile-qualifications').value = profile.qualifications || '';
            document.getElementById('profile-experience').value = profile.experience_years || '';
            document.getElementById('profile-hospital').value = profile.hospital_name || '';
            document.getElementById('profile-contact').value = profile.contact_number || '';
            document.getElementById('profile-bio').value = profile.bio || '';
        }
    } catch(err) {
        console.error('Error loading profile:', err);
    }
}

async function saveProfile(event) {
    event.preventDefault();
    
    const formData = new FormData();
    formData.append('userId', currentUser.id);
    formData.append('specialization', document.getElementById('profile-specialization').value);
    formData.append('registration_no', document.getElementById('profile-registration-no').value);
    formData.append('qualifications', document.getElementById('profile-qualifications').value);
    formData.append('experience_years', document.getElementById('profile-experience').value);
    formData.append('hospital_name', document.getElementById('profile-hospital').value);
    formData.append('contact_number', document.getElementById('profile-contact').value);
    formData.append('bio', document.getElementById('profile-bio').value);
    
    const profilePhoto = document.getElementById('profile-photo').files[0];
    if(profilePhoto) {
        formData.append('profilePhoto', profilePhoto);
    }
    
    try {
        const res = await fetch('/api/doctor/profile', {
            method: 'POST',
            body: formData
        });
        const result = await res.json();
        if(result.success) {
            alert('✅ Profile saved successfully! You can now apply for seminars.');
            return true;
        } else {
            alert('Error: ' + result.error);
        }
    } catch(err) {
        console.error('Error saving profile:', err);
        alert('Error saving profile. Please try again.');
    }
    return false;
}

// Application Edit Functionality
async function editApplication(index) {
    const app = userApplications[index];
    let formData = {};
    try {
        formData = JSON.parse(app.form_data || '{}');
    } catch(e) {}
    
    // Show edit form with pre-filled data
    alert('Edit Application Feature: ' + app.application_no + '\nForm data will be pre-filled in a modal for editing.');
    
    // For now, reload the form with the application data
    document.getElementById('fname').value = formData.fname || '';
    document.getElementById('lname').value = formData.lname || '';
    document.getElementById('email').value = formData.email || '';
    document.getElementById('phone').value = formData.phone || '';
    document.getElementById('address').value = formData.address || '';
    document.getElementById('city').value = formData.city || '';
    document.getElementById('state').value = formData.state || '';
    document.getElementById('pin').value = formData.pin || '';
    document.getElementById('qual').value = formData.qual || '';
    document.getElementById('ncism').value = formData.ncism || '';
    document.getElementById('college').value = formData.college || '';
    document.getElementById('ccity').value = formData.ccity || '';
    
    // Store the application ID for update
    window.editingApplicationId = userApplications[index].id || null;
    
    switchTab('tab-seminars');
}

async function updateApplication() {
    if(!window.editingApplicationId) {
        alert('Application ID not found');
        return;
    }
    
    const formData = {
        fname: document.getElementById('fname').value,
        lname: document.getElementById('lname').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        address: document.getElementById('address').value,
        city: document.getElementById('city').value,
        state: document.getElementById('state').value,
        pin: document.getElementById('pin').value,
        qual: document.getElementById('qual').value,
        ncism: document.getElementById('ncism').value,
        college: document.getElementById('college').value,
        ccity: document.getElementById('ccity').value
    };
    
    try {
        const res = await fetch(`/api/applications/${window.editingApplicationId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                formData,
                phoneOtpToken: window.__regPhoneOtpToken || '',
                emailOtpToken: window.__regEmailOtpToken || '',
                fieldOtpTokens: window.__fieldOtpTokens || {}
            })
        });
        const result = await res.json();
        if(result.success) {
            alert('✅ Application updated successfully!');
            window.editingApplicationId = null;
            loadApplications();
        } else {
            alert('Error: ' + result.error);
        }
    } catch(err) {
        console.error('Error updating application:', err);
        alert('Error updating application');
    }
}


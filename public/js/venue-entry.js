(function () {
    const authOverlay = document.getElementById('auth-overlay');
    const ui = document.getElementById('venue-ui');
    const loginErr = document.getElementById('venue-login-err');
    let user = PortalAuth.getUser('doctor');
    let enrollStream = null;

    function esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }

    function stopEnrollCam() {
        if (enrollStream) {
            enrollStream.getTracks().forEach((t) => t.stop());
            enrollStream = null;
        }
        const vid = document.getElementById('enroll-video');
        if (vid) vid.srcObject = null;
    }

    async function startEnrollCam() {
        stopEnrollCam();
        const vid = document.getElementById('enroll-video');
        if (!vid || !navigator.mediaDevices) return;
        try {
            enrollStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user' },
                audio: false
            });
            vid.srcObject = enrollStream;
            await vid.play();
        } catch (e) {
            console.warn('[venue-entry] camera:', e.message);
        }
    }

    async function uploadSelfie(blob) {
        const status = document.getElementById('enroll-status');
        if (status) status.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('selfie', blob, 'selfie.jpg');
        fd.append('userId', String(user.id));
        fd.append('userIdString', user.user_id_string || '');
        const res = await fetch('/api/venue-entry/enroll', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
            if (status) status.textContent = data.error || 'Enrollment failed';
            return;
        }
        if (status) status.textContent = 'Selfie saved.';
        stopEnrollCam();
        await refreshStatus();
    }

    async function refreshStatus() {
        const q = new URLSearchParams({ userId: String(user.id), userIdString: user.user_id_string || '' });
        const res = await fetch('/api/venue-entry/status?' + q.toString());
        const data = await res.json();
        const enrolled = !!(data.enrolled || (data.profile && data.profile.enrolled));
        document.getElementById('venue-enroll-card')?.classList.toggle('hidden', enrolled);
        document.getElementById('venue-enrolled-card')?.classList.toggle('hidden', !enrolled);
        if (enrolled && data.profile && data.profile.selfieUrl) {
            const img = document.getElementById('venue-selfie');
            if (img) img.src = data.profile.selfieUrl;
        } else if (!enrolled) {
            await startEnrollCam();
        }
        await loadRegistrations();
    }

    async function loadRegistrations() {
        const list = document.getElementById('venue-reg-list');
        if (!list) return;
        list.innerHTML = '<p class="auth-sub">Loading…</p>';
        const q = new URLSearchParams({ userId: String(user.id), userIdString: user.user_id_string || '' });
        const res = await fetch('/api/venue-entry/registrations?' + q.toString());
        const rows = await res.json();
        if (!res.ok || !Array.isArray(rows)) {
            list.innerHTML = '<p class="login-err">' + esc(rows.error || 'Could not load registrations') + '</p>';
            return;
        }
        if (!rows.length) {
            list.innerHTML = '<p class="auth-sub">No paid seminar registrations yet.</p>';
            return;
        }
        list.innerHTML = rows
            .map(
                (r) =>
                    '<div class="reg-item">' +
                    '<strong>' +
                    esc(r.seminar_title) +
                    '</strong><br><span style="font-size:0.82rem;color:var(--scan-muted);">App ' +
                    esc(r.application_no) +
                    (r.ticket_id_string ? ' · Ticket ' + esc(r.ticket_id_string) : '') +
                    '</span><br>' +
                    '<button type="button" class="tool-btn primary" style="margin-top:8px;width:100%;" data-reg="' +
                    r.registration_id +
                    '">Show venue pass QR</button></div>'
            )
            .join('');
        list.querySelectorAll('[data-reg]').forEach((btn) => {
            btn.addEventListener('click', () => showPass(parseInt(btn.getAttribute('data-reg'), 10)));
        });
    }

    async function showPass(registrationId) {
        const panel = document.getElementById('venue-pass-panel');
        const q = new URLSearchParams({
            userId: String(user.id),
            userIdString: user.user_id_string || '',
            registrationId: String(registrationId)
        });
        const res = await fetch('/api/venue-entry/pass?' + q.toString());
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Could not load pass');
            if (data.needsEnrollment) refreshStatus();
            return;
        }
        panel?.classList.remove('hidden');
        const qr = document.getElementById('venue-pass-qr');
        const meta = document.getElementById('venue-pass-meta');
        const title = document.getElementById('venue-pass-title');
        if (qr) qr.src = data.qrUrl || '';
        if (title) title.textContent = 'Venue pass';
        if (meta) {
            meta.textContent =
                'Show this QR at the venue gate · Ticket ' +
                (data.pass && data.pass.ticketId ? data.pass.ticketId : registrationId);
        }
        panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function showLogin() {
        authOverlay.classList.remove('hidden');
        ui.classList.add('hidden');
        stopEnrollCam();
    }

    function showApp(u) {
        user = u;
        authOverlay.classList.add('hidden');
        ui.classList.remove('hidden');
        document.getElementById('venue-who').textContent =
            (u.first_name || '') + ' ' + (u.last_name || '') + ' · ' + (u.user_id_string || u.id);
        refreshStatus().catch(console.error);
    }

    document.getElementById('btn-enroll-capture')?.addEventListener('click', () => {
        const vid = document.getElementById('enroll-video');
        if (!vid || !vid.videoWidth) return alert('Camera not ready — use Upload photo.');
        const canvas = document.createElement('canvas');
        canvas.width = vid.videoWidth;
        canvas.height = vid.videoHeight;
        canvas.getContext('2d').drawImage(vid, 0, 0);
        canvas.toBlob((blob) => blob && uploadSelfie(blob), 'image/jpeg', 0.9);
    });
    document.getElementById('btn-enroll-file')?.addEventListener('click', () => document.getElementById('enroll-file')?.click());
    document.getElementById('enroll-file')?.addEventListener('change', (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (f) uploadSelfie(f);
    });
    document.getElementById('btn-re-enroll')?.addEventListener('click', () => {
        document.getElementById('venue-enrolled-card')?.classList.add('hidden');
        document.getElementById('venue-enroll-card')?.classList.remove('hidden');
        startEnrollCam();
    });
    document.getElementById('venue-logout')?.addEventListener('click', () => {
        PortalAuth.clearUser('doctor');
        showLogin();
    });

    PortalAuth.bindLoginForm({
        portal: 'doctor',
        formId: 'venue-login-form',
        otpPanelId: 'venue-login-otp-panel',
        emailInputId: 'venue-email',
        passwordInputId: 'venue-password',
        otpPrefix: 'venue',
        onSuccess: showApp,
        onError: (msg) => {
            loginErr.textContent = msg;
            loginErr.classList.remove('hidden');
        }
    });

    if (user) showApp(user);
    else showLogin();
})();

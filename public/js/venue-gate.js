(function () {
    const authOverlay = document.getElementById('auth-overlay');
    const ui = document.getElementById('gate-ui');
    const loginErr = document.getElementById('gate-login-err');
    const resultBox = document.getElementById('gate-result');
    let user = PortalAuth.getUser('venue_gate');
    let html5QrCode = null;
    let selectedSeminarId = null;
    let pendingPass = null;
    let idCaptureStream = null;
    let scanBusy = false;

    function esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }

    function renderResult(ok, html, kind) {
        resultBox.className = kind === 'ok' ? 'scan-result ok' : kind === 'warn' ? 'scan-result warn' : 'scan-result bad';
        resultBox.innerHTML = html;
        resultBox.classList.remove('hidden');
    }

    async function loadSeminars() {
        const sel = document.getElementById('gate-seminar-select');
        if (!sel) return;
        const res = await fetch('/api/venue-gate/checkin-seminars');
        const rows = await res.json();
        sel.innerHTML = (rows || [])
            .map((s) => '<option value="' + s.id + '">' + esc(s.title) + '</option>')
            .join('');
        if (rows && rows[0]) {
            selectedSeminarId = rows[0].id;
            sel.value = String(selectedSeminarId);
        }
        sel.onchange = () => {
            selectedSeminarId = parseInt(sel.value, 10);
        };
    }

    function stopIdCam() {
        if (idCaptureStream) {
            idCaptureStream.getTracks().forEach((t) => t.stop());
            idCaptureStream = null;
        }
        const vid = document.getElementById('gate-id-video');
        if (vid) vid.srcObject = null;
    }

    async function startIdCam() {
        stopIdCam();
        const vid = document.getElementById('gate-id-video');
        if (!vid || !navigator.mediaDevices) return;
        try {
            idCaptureStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            vid.srcObject = idCaptureStream;
            await vid.play();
        } catch (_) {}
    }

    function showPassReview(data, qrRaw) {
        pendingPass = { qrRaw, token: data.passToken, seminarId: data.seminarId || selectedSeminarId };
        const dr = data.doctor || {};
        const enrolled = data.enrolledSelfieUrl
            ? '<img src="' + esc(data.enrolledSelfieUrl) + '" alt="Enrolled selfie"><span>Enrolled selfie</span>'
            : '<div style="background:#fee2e2;padding:20px;border-radius:12px;text-align:center;font-size:0.82rem;">No enrollment</div><span>Missing selfie</span>';
        renderResult(
            true,
            '<h3 style="margin-bottom:8px;">' +
                esc(dr.name || 'Guest') +
                '</h3>' +
                '<p style="font-size:0.85rem;">' +
                esc(dr.applicationNo || '') +
                ' · Ticket ' +
                esc(dr.ticketId || data.ticketId || '') +
                '</p>' +
                '<div class="face-compare">' +
                '<div>' +
                (dr.profilePhotoUrl
                    ? '<img src="' + esc(dr.profilePhotoUrl) + '" alt="Profile"><span>Profile photo</span>'
                    : '<div style="background:#f1f5f9;padding:20px;border-radius:12px;text-align:center;font-size:0.82rem;">No profile photo</div><span>Profile</span>') +
                '</div><div>' +
                enrolled +
                '</div></div>' +
                '<div class="id-capture-panel">' +
                '<p class="id-capture-title"><i class="fas fa-id-card"></i> Capture identity proof</p>' +
                '<video id="gate-id-video" class="id-capture-video" playsinline muted autoplay></video>' +
                '<input type="file" id="gate-id-file" accept="image/*" capture="environment" class="hidden">' +
                '<div class="id-capture-actions">' +
                '<button type="button" class="tool-btn primary" id="gate-btn-checkin">Confirm entry + ID photo</button>' +
                '<button type="button" class="tool-btn" id="gate-btn-file">Upload ID</button>' +
                '<button type="button" class="tool-btn" id="gate-btn-cancel">Cancel</button>' +
                '</div>' +
                '<p id="gate-id-status" class="id-capture-status"></p></div>',
            'ok'
        );
        document.getElementById('gate-btn-cancel')?.addEventListener('click', () => {
            pendingPass = null;
            stopIdCam();
            resultBox.classList.add('hidden');
            scanBusy = false;
        });
        document.getElementById('gate-btn-file')?.addEventListener('click', () => document.getElementById('gate-id-file')?.click());
        document.getElementById('gate-id-file')?.addEventListener('change', (ev) => {
            const f = ev.target.files && ev.target.files[0];
            if (f) confirmCheckin(f);
        });
        document.getElementById('gate-btn-checkin')?.addEventListener('click', () => {
            const vid = document.getElementById('gate-id-video');
            if (!vid || !vid.videoWidth) return confirmCheckin(null);
            const canvas = document.createElement('canvas');
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            canvas.getContext('2d').drawImage(vid, 0, 0);
            canvas.toBlob((blob) => confirmCheckin(blob), 'image/jpeg', 0.88);
        });
        startIdCam();
        scanBusy = false;
    }

    async function lookupPass(qrRaw) {
        if (scanBusy) return;
        if (!selectedSeminarId) return alert('Select seminar first.');
        scanBusy = true;
        renderResult(false, '<i class="fas fa-spinner fa-spin"></i> Verifying pass…', 'warn');
        try {
            const res = await fetch('/api/venue-gate/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    qrData: qrRaw,
                    gateUserId: Number(user.id),
                    seminarId: selectedSeminarId
                })
            });
            const data = await res.json();
            if (!res.ok) {
                renderResult(false, esc(data.error || 'Pass denied'), 'bad');
                scanBusy = false;
                return;
            }
            if (data.isScanned && data.scanCount >= 1) {
                renderResult(false, esc('Already checked in for this pass.'), 'bad');
                scanBusy = false;
                return;
            }
            showPassReview(data, qrRaw);
        } catch (e) {
            renderResult(false, 'Network error', 'bad');
            scanBusy = false;
        }
    }

    async function confirmCheckin(idBlob) {
        if (!pendingPass) return;
        const status = document.getElementById('gate-id-status');
        if (status) status.textContent = 'Checking in…';
        const fd = new FormData();
        fd.append('qrData', pendingPass.qrRaw);
        fd.append('gateUserId', String(user.id));
        fd.append('seminarId', String(selectedSeminarId));
        if (idBlob) fd.append('idPhoto', idBlob, 'id-proof.jpg');
        try {
            const res = await fetch('/api/venue-gate/checkin', { method: 'POST', body: fd });
            const data = await res.json();
            stopIdCam();
            pendingPass = null;
            if (res.ok && data.success) {
                renderResult(true, '<strong><i class="fas fa-check-circle"></i> ' + esc(data.message || 'Entry confirmed') + '</strong>', 'ok');
            } else {
                renderResult(false, esc(data.error || 'Check-in denied'), 'bad');
            }
        } catch (e) {
            if (status) status.textContent = 'Network error';
        }
        scanBusy = false;
        setTimeout(() => resultBox.classList.add('hidden'), 2800);
    }

    async function startCam() {
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (_) {}
        }
        html5QrCode = new Html5Qrcode('gate-reader');
        await html5QrCode.start({ facingMode: 'environment' }, { fps: 12, qrbox: 240 }, (text) => lookupPass(text));
    }

    function showLogin() {
        authOverlay.classList.remove('hidden');
        ui.classList.add('hidden');
        if (html5QrCode) html5QrCode.stop().catch(() => {});
        stopIdCam();
    }

    function showApp(u) {
        user = u;
        authOverlay.classList.add('hidden');
        ui.classList.remove('hidden');
        document.getElementById('gate-who').textContent =
            (u.first_name || '') + ' ' + (u.last_name || '') + ' · ID ' + (u.user_id_string || u.id);
        loadSeminars()
            .then(() => startCam())
            .catch(console.error);
    }

    document.getElementById('gate-manual-btn')?.addEventListener('click', () => {
        const v = document.getElementById('gate-manual')?.value?.trim();
        if (v) lookupPass(v);
    });
    document.getElementById('gate-logout')?.addEventListener('click', () => {
        PortalAuth.clearUser('venue_gate');
        showLogin();
    });

    PortalAuth.bindLoginForm({
        portal: 'venue_gate',
        formId: 'gate-login-form',
        otpPanelId: null,
        emailInputId: 'gate-email',
        passwordInputId: 'gate-password',
        onSuccess: showApp,
        onError: (msg) => {
            loginErr.textContent = msg;
            loginErr.classList.remove('hidden');
        }
    });

    if (user) showApp(user);
    else showLogin();
})();

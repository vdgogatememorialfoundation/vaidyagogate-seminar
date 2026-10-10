(function () {
    const stats = { ok: 0, bad: 0 };
    const history = [];
    let html5QrCode = null;
    let facingMode = 'environment';
    let torchOn = false;
    let busy = false;
    let paused = false;
    let pending = null;
    let lastRejectText = '';
    let lastRejectAt = 0;

    function $(id) {
        return document.getElementById(id);
    }

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function extractToken(raw) {
        const text = String(raw || '').trim();
        if (!text) return '';
        const match = text.match(/[?&]t=([^&#\s]+)/i);
        if (match && /verify-certificate|certificate-scanner/i.test(text)) {
            try {
                return decodeURIComponent(match[1]);
            } catch (_) {
                return match[1];
            }
        }
        if (/^[a-f0-9]{32,64}$/i.test(text)) return text;
        return '';
    }

    function updateStats() {
        const ok = $('stat-ok');
        const bad = $('stat-err');
        if (ok) ok.textContent = String(stats.ok);
        if (bad) bad.textContent = String(stats.bad);
    }

    function pushHistory(label, ok) {
        history.unshift({ label: label, ok: !!ok });
        if (history.length > 8) history.pop();
        const list = $('scan-history');
        if (!list) return;
        list.innerHTML = history
            .map(function (row) {
                return (
                    '<li>' +
                    (row.ok ? '✓ ' : '✕ ') +
                    esc(row.label) +
                    '</li>'
                );
            })
            .join('');
    }

    function showResult(kind, html) {
        const box = $('result-box');
        if (!box) return;
        box.className = 'result-panel ' + (kind || 'bad');
        box.innerHTML = html;
    }

    function setOtpCard(visible, hint) {
        const card = $('otp-card');
        const hintEl = $('otp-hint');
        if (hintEl) hintEl.textContent = hint || '';
        if (card) card.classList.toggle('hidden', !visible);
        if (!visible) {
            const code = $('otp-code');
            if (code) code.value = '';
        }
    }

    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        let data = {};
        try {
            data = await res.json();
        } catch (_) {
            data = {};
        }
        if (!res.ok) {
            const err = new Error(data.error || 'Request failed');
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    async function pauseCam() {
        if (!html5QrCode || paused) return;
        try {
            if (typeof html5QrCode.pause === 'function') {
                html5QrCode.pause(true);
                paused = true;
            }
        } catch (_) {}
    }

    async function resumeCam() {
        if (!html5QrCode || !paused) return;
        try {
            if (typeof html5QrCode.resume === 'function') {
                await html5QrCode.resume();
            }
        } catch (_) {}
        paused = false;
    }

    async function sendEmailCode() {
        if (!pending || !pending.token) return;
        const hint = $('otp-hint');
        if (hint) hint.textContent = 'Sending the email code…';
        const data = await postJson('/api/public/certificate-verify/otp/send-both', {
            token: pending.token
        });
        pending.maskedEmail = data.maskedEmail || pending.maskedEmail || '';
        if (hint) {
            hint.textContent =
                'Email code sent to ' +
                (pending.maskedEmail || 'the certificate holder') +
                '. Enter that code to confirm this certificate.';
        }
    }

    async function lookupToken(token) {
        const data = await postJson('/api/public/certificate-verify/lookup', { token: token });
        if (!data.ok) throw new Error(data.error || 'Certificate not found');
        pending = {
            token: token,
            displayName: data.displayName || '',
            certKind: data.certKind || '',
            seminarTitle: data.seminar && data.seminar.title ? data.seminar.title : '',
            applicationNo: data.applicationNo || '',
            prn: data.prn || '',
            maskedEmail: data.maskedEmail || ''
        };
        const kind =
            data.certKind === 'volunteer' ? 'Volunteer certificate' : 'Participation certificate';
        showResult(
            'warn',
            '<strong><i class="fas fa-envelope"></i> ' +
                esc(kind) +
                ' found</strong><div style="margin-top:6px;">' +
                esc(data.displayName || 'Certificate holder') +
                '. An email code is being sent to ' +
                esc(data.maskedEmail || 'the holder') +
                '.</div>'
        );
        setOtpCard(
            true,
            'Sending the email code to ' + (data.maskedEmail || 'the certificate holder') + '…'
        );
        try {
            await sendEmailCode();
        } catch (e) {
            const hint = $('otp-hint');
            if (hint) hint.textContent = e.message || 'The email code could not be sent. Tap resend.';
        }
    }

    async function handleScan(raw) {
        const token = extractToken(raw);
        if (!token) {
            const now = Date.now();
            const key = String(raw || '');
            if (key && key === lastRejectText && now - lastRejectAt < 2500) return;
            lastRejectText = key;
            lastRejectAt = now;
            pending = null;
            setOtpCard(false);
            stats.bad += 1;
            updateStats();
            showResult(
                'bad',
                '<strong><i class="fas fa-times-circle"></i> Not a certificate QR</strong><div style="margin-top:6px;">Scan the QR printed on the certificate.</div>'
            );
            pushHistory('Not a certificate QR', false);
            return;
        }
        if (busy) return;
        if (pending && pending.token === token) return;
        busy = true;
        await pauseCam();
        showResult('warn', '<i class="fas fa-spinner fa-spin"></i> Checking certificate…');
        try {
            await lookupToken(token);
        } catch (e) {
            pending = null;
            setOtpCard(false);
            stats.bad += 1;
            updateStats();
            showResult(
                'bad',
                '<strong><i class="fas fa-times-circle"></i> Not authentic</strong><div style="margin-top:6px;">' +
                    esc(e.message || 'This certificate could not be verified.') +
                    '</div>'
            );
            pushHistory(e.message || 'Not authentic', false);
            await resumeCam();
        } finally {
            busy = false;
        }
    }

    async function confirmCode() {
        if (!pending || !pending.token) {
            showResult('bad', 'Scan a certificate QR first.');
            return;
        }
        const code = String(($('otp-code') && $('otp-code').value) || '').trim();
        if (!code) {
            const hint = $('otp-hint');
            if (hint) hint.textContent = 'Enter the email code.';
            return;
        }
        const btn = $('btn-confirm');
        if (btn) btn.disabled = true;
        showResult('warn', '<i class="fas fa-spinner fa-spin"></i> Confirming the email code…');
        try {
            const data = await postJson('/api/public/certificate-verify/confirm', {
                token: pending.token,
                emailCode: code
            });
            stats.ok += 1;
            updateStats();
            const kind = data.certKind === 'volunteer' ? 'Volunteer' : 'Participation';
            showResult(
                'ok',
                '<strong><i class="fas fa-check-circle"></i> Authentic certificate</strong>' +
                    '<dl class="result-meta">' +
                    '<dt>Type</dt><dd>' +
                    esc(kind) +
                    '</dd>' +
                    '<dt>Name</dt><dd>' +
                    esc(data.displayName || pending.displayName) +
                    '</dd>' +
                    '<dt>Seminar</dt><dd>' +
                    esc(data.seminarTitle || pending.seminarTitle) +
                    '</dd>' +
                    '<dt>Application number</dt><dd>' +
                    esc(data.applicationNo || pending.applicationNo) +
                    '</dd>' +
                    '<dt>Portal registration number</dt><dd>' +
                    esc(data.prn || pending.prn) +
                    '</dd>' +
                    '</dl>' +
                    '<div style="margin-top:8px;">' +
                    esc(data.message || 'Issued by the Vaidya Gogate Memorial Foundation.') +
                    '</div>'
            );
            setOtpCard(false);
            pushHistory('Authentic · ' + (data.displayName || pending.displayName || ''), true);
            pending = null;
        } catch (e) {
            showResult(
                'bad',
                '<strong><i class="fas fa-times-circle"></i> Code not accepted</strong><div style="margin-top:6px;">' +
                    esc(e.message || 'Enter the email code again.') +
                    '</div>'
            );
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function pickCameraDeviceId(cameras, mode) {
        const list = Array.isArray(cameras) ? cameras : [];
        if (!list.length) return null;
        const label = function (c) {
            return String((c && c.label) || '').toLowerCase();
        };
        if (mode === 'environment') {
            const back = list.find(function (c) {
                return /back|rear|environment|wide/i.test(label(c));
            });
            return (back || list[list.length - 1]).id;
        }
        const front = list.find(function (c) {
            return /front|user|selfie/i.test(label(c));
        });
        return (front || list[0]).id;
    }

    async function startCam() {
        const readerEl = $('reader');
        const hintEl = document.querySelector('.camera-hint');
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (_) {}
        }
        paused = false;
        torchOn = false;
        updateTorchButton();
        if (readerEl) readerEl.innerHTML = '';
        if (typeof Html5Qrcode !== 'function') {
            if (hintEl) hintEl.textContent = 'Scanner library did not load. Paste the certificate link below.';
            return;
        }
        html5QrCode = new Html5Qrcode('reader');
        const config = { fps: 10, qrbox: { width: 260, height: 260 }, aspectRatio: 1 };
        const onScan = function (text) {
            handleScan(text);
        };
        if (!window.isSecureContext) {
            if (hintEl) hintEl.textContent = 'Camera needs HTTPS. Paste the certificate link below.';
            return;
        }
        try {
            if (typeof Html5Qrcode.getCameras === 'function') {
                const cameras = await Html5Qrcode.getCameras();
                const deviceId = pickCameraDeviceId(cameras, facingMode);
                if (deviceId) {
                    await html5QrCode.start(deviceId, config, onScan);
                    if (hintEl) hintEl.textContent = 'Align the certificate QR inside the frame';
                    return;
                }
            }
        } catch (_) {}
        const tries = [
            { facingMode: { exact: facingMode } },
            { facingMode: { ideal: facingMode } },
            { facingMode: facingMode }
        ];
        for (let i = 0; i < tries.length; i++) {
            try {
                await html5QrCode.start(tries[i], config, onScan);
                if (hintEl) hintEl.textContent = 'Align the certificate QR inside the frame';
                return;
            } catch (_) {}
        }
        if (hintEl) hintEl.textContent = 'Camera is unavailable. Paste the certificate link below.';
    }

    function updateTorchButton() {
        const btn = $('btn-torch');
        if (!btn) return;
        btn.classList.toggle('torch-on', torchOn);
        btn.title = torchOn ? 'Torch off' : 'Torch on';
        btn.setAttribute('aria-pressed', torchOn ? 'true' : 'false');
        const icon = btn.querySelector('i');
        if (icon) icon.className = torchOn ? 'fas fa-lightbulb' : 'far fa-lightbulb';
    }

    async function toggleTorch() {
        const video = document.querySelector('#reader video');
        const track = video && video.srcObject && video.srcObject.getVideoTracks
            ? video.srcObject.getVideoTracks()[0]
            : null;
        if (!track || typeof track.applyConstraints !== 'function') return;
        torchOn = !torchOn;
        try {
            await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        } catch (_) {
            torchOn = false;
        }
        updateTorchButton();
    }

    function bind() {
        $('btn-manual') &&
            $('btn-manual').addEventListener('click', function () {
                const value = $('manual-qr') && $('manual-qr').value;
                handleScan(value);
            });
        $('manual-qr') &&
            $('manual-qr').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') handleScan(e.target.value);
            });
        $('btn-confirm') && $('btn-confirm').addEventListener('click', confirmCode);
        $('otp-code') &&
            $('otp-code').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') confirmCode();
            });
        $('btn-resend') &&
            $('btn-resend').addEventListener('click', function () {
                if (!pending) return;
                sendEmailCode().catch(function (e) {
                    const hint = $('otp-hint');
                    if (hint) hint.textContent = e.message || 'Could not resend the email code.';
                });
            });
        $('btn-reset') &&
            $('btn-reset').addEventListener('click', function () {
                pending = null;
                setOtpCard(false);
                const box = $('result-box');
                if (box) box.className = 'hidden';
                const manual = $('manual-qr');
                if (manual) manual.value = '';
                startCam().catch(function () {});
            });
        $('btn-switch-cam') &&
            $('btn-switch-cam').addEventListener('click', function () {
                facingMode = facingMode === 'environment' ? 'user' : 'environment';
                startCam().catch(function () {});
            });
        $('btn-torch') &&
            $('btn-torch').addEventListener('click', function () {
                toggleTorch();
            });
        $('btn-fullscreen') &&
            $('btn-fullscreen').addEventListener('click', function () {
                if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
                else document.exitFullscreen && document.exitFullscreen();
            });
    }

    function start() {
        bind();
        const params = new URLSearchParams(window.location.search);
        const preset = params.get('t') || '';
        startCam()
            .catch(function () {})
            .finally(function () {
                if (preset) handleScan(window.location.href);
            });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();

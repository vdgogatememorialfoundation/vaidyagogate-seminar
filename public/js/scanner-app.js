(function () {
    const isNativeScannerShell =
        !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
        /VGMF Scanner|Capacitor/i.test(navigator.userAgent || '');

    function isScannerPageUrl(url) {
        try {
            const u = new URL(url, window.location.href);
            if (u.origin !== window.location.origin) return false;
            return /\/scanner\.html$/i.test(u.pathname) || u.pathname === '/scanner';
        } catch (_) {
            return false;
        }
    }

    function lockScannerNavigation() {
        document.documentElement.classList.add('scanner-native-shell');
        document.querySelectorAll('a[href]').forEach((a) => {
            const href = String(a.getAttribute('href') || '').trim();
            if (!href || href === '#') return;
            if (!isScannerPageUrl(href)) {
                a.removeAttribute('href');
                a.setAttribute('aria-hidden', 'true');
                a.style.display = 'none';
            }
        });
        const block = (url) => {
            if (!url || isScannerPageUrl(url)) return false;
            console.warn('[scanner] Blocked navigation to', url);
            return true;
        };
        const loc = window.location;
        ['assign', 'replace'].forEach((fn) => {
            const orig = loc[fn].bind(loc);
            loc[fn] = function (url) {
                if (block(url)) return;
                return orig(url);
            };
        });
        window.open = function (url) {
            if (block(url)) return null;
            return null;
        };
        document.addEventListener(
            'click',
            (e) => {
                const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
                if (!a) return;
                const href = a.getAttribute('href');
                if (href && block(href)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            },
            true
        );
        window.addEventListener('beforeunload', (e) => {
            if (!window.__scannerAllowLeave) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    if (isNativeScannerShell) lockScannerNavigation();
    if (/scanner\.html$/i.test(window.location.pathname || '')) {
        document.body.classList.add('scanner-standalone-page');
    }

    const authOverlay = document.getElementById('auth-overlay');
    const ui = document.getElementById('scan-ui');
    const loginErr = document.getElementById('login-err');
    const resultBox = document.getElementById('result-box');
    const historyEl = document.getElementById('scan-history');
    let user = PortalAuth.getUser('scanner');
    let html5QrCode = null;
    let selectedSeminarId = null;
    let facingMode = 'environment';
    let stats = { ok: 0, err: 0, dup: 0 };
    let torchOn = false;
    let scanBusy = false;
    let lastScanKey = '';
    let lastScanAt = 0;
    const SCAN_DEBOUNCE_MS = 2200;
    const AUTO_NEXT_MS = 2600;

    function haptic(kind) {
        try {
            if (navigator.vibrate) {
                if (kind === 'success') navigator.vibrate([40, 30, 40]);
                else if (kind === 'duplicate') navigator.vibrate([80, 40, 80]);
                else navigator.vibrate(120);
            }
        } catch (_) {}
    }

    function playTone(kind) {
        haptic(kind);
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            if (kind === 'success') {
                o.frequency.value = 1046;
                g.gain.value = 0.35;
                o.start();
                o.stop(ctx.currentTime + 0.22);
                setTimeout(() => {
                    const o2 = ctx.createOscillator();
                    const g2 = ctx.createGain();
                    o2.connect(g2);
                    g2.connect(ctx.destination);
                    o2.frequency.value = 1318;
                    g2.gain.value = 0.28;
                    o2.start();
                    o2.stop(ctx.currentTime + 0.18);
                }, 120);
            } else if (kind === 'duplicate') {
                o.type = 'triangle';
                o.frequency.value = 440;
                g.gain.value = 0.14;
                o.start();
                o.stop(ctx.currentTime + 0.2);
                setTimeout(() => {
                    const o2 = ctx.createOscillator();
                    const g2 = ctx.createGain();
                    o2.connect(g2);
                    g2.connect(ctx.destination);
                    o2.frequency.value = 440;
                    g2.gain.value = 0.14;
                    o2.start();
                    o2.stop(ctx.currentTime + 0.2);
                }, 220);
            } else {
                o.type = 'square';
                o.frequency.value = 200;
                g.gain.value = 0.16;
                o.start();
                o.stop(ctx.currentTime + 0.35);
            }
        } catch (_) {}
    }

    function updateStats() {
        const ok = document.getElementById('stat-ok');
        const err = document.getElementById('stat-err');
        const dup = document.getElementById('stat-dup');
        if (ok) ok.textContent = String(stats.ok);
        if (err) err.textContent = String(stats.err);
        if (dup) dup.textContent = String(stats.dup);
    }

    function pushHistory(text, ok) {
        if (!historyEl) return;
        const li = document.createElement('li');
        li.textContent = (ok ? '✓ ' : '✗ ') + text;
        historyEl.prepend(li);
        while (historyEl.children.length > 12) historyEl.removeChild(historyEl.lastChild);
    }

    function renderResult(success, html, panelClass) {
        resultBox.classList.remove('hidden');
        resultBox.className = 'result-panel ' + (panelClass || (success ? 'ok' : 'bad'));
        resultBox.innerHTML = html;
    }

    function profilePhotoHtml(d) {
        const url = d && (d.profilePhotoUrl || d.profile_photo_url);
        if (!url) return '';
        return (
            '<div class="scan-profile-photo-wrap"><img class="scan-profile-photo" src="' +
            String(url).replace(/"/g, '&quot;') +
            '" alt="Profile photo"></div>'
        );
    }

    function metaHtml(d, extra) {
        const rows = [
            ['Name', d.name],
            ['Doctor ID', d.userIdString],
            ['Ticket ID', d.ticketId || d.ticket_id_string],
            ['Account', d.accountStatus || (d.account_status || '')],
            ['Registration', d.registrationType || d.registration_status || '—'],
            ['Payment', d.paymentStatus || (d.payment_status === 'success' ? 'PAID' : 'UNPAID')],
            ['Application', d.applicationNo],
            ['Seminar', d.seminarTitle],
            [
                'Checked in',
                d.checkedInAt
                    ? window.PortalDateTime
                        ? window.PortalDateTime.format(d.checkedInAt)
                        : new Date(d.checkedInAt).toLocaleString()
                    : '—'
            ]
        ];
        let h = '<dl class="result-meta">';
        rows.forEach(([k, v]) => {
            if (v) h += '<dt>' + k + '</dt><dd>' + String(v).replace(/</g, '&lt;') + '</dd>';
        });
        if (extra) h += '<dd>' + extra + '</dd>';
        return h + '</dl>';
    }

    async function loadCheckinSeminars() {
        const sel = document.getElementById('scanner-seminar-select');
        const hint = document.getElementById('scanner-seminar-hint');
        if (!sel) return;
        sel.innerHTML = '<option value="">Loading…</option>';
        try {
            const res = await fetch('/api/scanner/checkin-seminars', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const list = await res.json();
            if (!Array.isArray(list) || !list.length) {
                sel.innerHTML = '<option value="">No check-in seminars</option>';
                if (hint) hint.textContent = 'Check-in is not enabled for any seminar yet.';
                return;
            }
            sel.innerHTML = '<option value="">— Select seminar —</option>';
            list.forEach((s) => {
                const opt = document.createElement('option');
                opt.value = String(s.id);
                opt.textContent = s.title + (s.checkinDate ? ' · ' + String(s.checkinDate).slice(0, 10) : '');
                sel.appendChild(opt);
            });
            if (list.length === 1) sel.value = String(list[0].id);
            sel.onchange = () => {
                selectedSeminarId = sel.value ? parseInt(sel.value, 10) : null;
                const s = list.find((x) => Number(x.id) === Number(selectedSeminarId));
                if (hint && s) {
                    if (s.checkinOpenToday === false) {
                        const today = s.todayYmd || 'today';
                        const cfg = s.checkinDate ? String(s.checkinDate).slice(0, 10) : 'not set';
                        hint.textContent =
                            'Check-in date is ' +
                            cfg +
                            ' (India today: ' +
                            today +
                            '). Check-in is not allowed on this date for this seminar.';
                    } else {
                        hint.textContent = 'Ready to scan.';
                    }
                }
            };
            sel.dispatchEvent(new Event('change'));
        } catch (e) {
            sel.innerHTML = '<option value="">Error</option>';
            if (hint) hint.textContent = e.message || 'Could not load seminars.';
        }
    }

    function scheduleAutoResume() {
        setTimeout(() => {
            resultBox.classList.add('hidden');
            if (!html5QrCode || !document.getElementById('reader')?.querySelector('video')) {
                startCam().catch(console.error);
            }
            scanBusy = false;
        }, AUTO_NEXT_MS);
    }

    async function processScan(decodedText) {
        const raw = String(decodedText || '').trim();
        if (!raw) return;
        const scanKey = raw + '|' + (document.getElementById('scanner-seminar-select')?.value || '');
        const now = Date.now();
        if (scanBusy) return;
        if (scanKey === lastScanKey && now - lastScanAt < SCAN_DEBOUNCE_MS) return;

        const sel = document.getElementById('scanner-seminar-select');
        const sid = sel && sel.value ? parseInt(sel.value, 10) : selectedSeminarId;
        if (!sid) {
            alert('Select the seminar first.');
            return;
        }

        scanBusy = true;
        lastScanKey = scanKey;
        lastScanAt = now;

        renderResult(false, '<i class="fas fa-spinner fa-spin"></i> Verifying…', 'warn');

        try {
            const res = await fetch('/api/scanner/mark', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    qrData: decodedText,
                    scannerUserId: Number(user.id),
                    seminarId: sid
                })
            });
            let result = {};
            try {
                result = await res.json();
            } catch (_) {
                result = {};
            }
            if (!result.error && !res.ok) {
                if (res.status === 404) {
                    result.error =
                        'Not found. Scan e-ticket QR, enter 12-digit E-ticket ID, or 12-digit Application ID.';
                } else if (res.status === 403) {
                    result.error = result.error || 'Entry denied — check payment, registration status, seminar, or check-in date.';
                } else if (res.status === 503) {
                    result.error =
                        result.error ||
                        'Server database is not ready. Wait a minute and retry, or contact admin if this persists.';
                } else {
                    result.error = result.error || 'Could not verify ticket (HTTP ' + res.status + ').';
                }
            }
            const d = result.doctor || {};

            if (result.success) {
                playTone('success');
                stats.ok++;
                const scanNote =
                    result.scanCount != null && result.scansRequired != null
                        ? '<p style="margin-top:8px;font-size:0.85rem;">Scans: <strong>' +
                          result.scanCount +
                          '/' +
                          result.scansRequired +
                          '</strong></p>'
                        : '';
                renderResult(
                    true,
                    '<div class="scan-result-top">' +
                        profilePhotoHtml(d) +
                        '<div class="scan-result-body"><strong><i class="fas fa-check-circle"></i> ' +
                        (result.message || 'Checked in').replace(/</g, '&lt;') +
                        '</strong>' +
                        metaHtml(d) +
                        '</div></div>' +
                        scanNote +
                        '<p style="margin-top:10px;font-size:0.85rem;opacity:0.85;">Next scan in a moment…</p>',
                    'ok'
                );
                pushHistory((d.name || 'Guest') + ' · ' + (d.ticketId || d.applicationNo || ''), true);
                scheduleAutoResume();
            } else {
                const err =
                    result.error ||
                    (res.ok ? 'Entry denied' : 'Could not verify ticket — check network and try again');
                const isDup = /already scanned/i.test(err);
                playTone(isDup ? 'duplicate' : result.sound === 'wrong_date' ? 'wrong_date' : 'error');
                if (isDup) stats.dup++;
                else stats.err++;
                const banNote =
                    d.banReason && /banned/i.test(err)
                        ? '<p style="margin-top:8px;font-size:0.85rem;">Reason: ' +
                          String(d.banReason).replace(/</g, '&lt;') +
                          '</p>'
                        : '';
                renderResult(
                    false,
                    '<div class="scan-result-top">' +
                        profilePhotoHtml(d) +
                        '<div class="scan-result-body"><strong><i class="fas fa-times-circle"></i> ' +
                        err.replace(/</g, '&lt;') +
                        '</strong>' +
                        banNote +
                        (d && (d.name || d.userIdString || d.applicationNo) ? metaHtml(d) : '') +
                        '</div></div>',
                    isDup ? 'warn' : 'bad'
                );
                pushHistory(err.slice(0, 60), false);
                scheduleAutoResume();
            }
            updateStats();
        } catch (e) {
            stats.err++;
            updateStats();
            renderResult(false, 'Network error', 'bad');
            scheduleAutoResume();
        }
    }

    async function startCam() {
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (_) {}
        }
        html5QrCode = new Html5Qrcode('reader');
        const config = { fps: 15, qrbox: { width: 260, height: 260 }, aspectRatio: 1, disableFlip: false };
        await html5QrCode.start({ facingMode }, config, (text) => processScan(text));
    }

    function showLogin() {
        authOverlay.classList.remove('hidden');
        ui.classList.add('hidden');
        if (html5QrCode) html5QrCode.stop().catch(() => {});
    }

    function showScan(u) {
        user = u;
        authOverlay.classList.add('hidden');
        ui.classList.remove('hidden');
        document.getElementById('scanner-who').textContent =
            (u.first_name || '') + ' ' + (u.last_name || '') + ' · ID ' + (u.user_id_string || u.id);
        if (typeof PortalAuth !== 'undefined' && PortalAuth.renderLoginTime) {
            PortalAuth.renderLoginTime('scanner-login-time', u);
        }
        loadCheckinSeminars().then(() => startCam()).catch(console.error);
    }

    PortalAuth.bindLoginForm({
        portal: 'scanner',
        formId: 'scanner-login-form',
        otpPanelId: 'scanner-login-otp-panel',
        emailInputId: 'scanner-email',
        passwordInputId: 'scanner-password',
        otpPrefix: 'scanner',
        resendEmailBtnId: 'scanner-resend-otp-email',
        resendPhoneBtnId: 'scanner-resend-otp-phone',
        onSuccess: showScan,
        onError: (msg) => {
            loginErr.textContent = msg;
            loginErr.classList.remove('hidden');
        }
    });

    document.getElementById('btn-reset')?.addEventListener('click', () => {
        resultBox.classList.add('hidden');
        const reader = document.getElementById('reader');
        if (reader && !reader.querySelector('video')) reader.innerHTML = '';
        startCam().catch(console.error);
    });

    document.getElementById('btn-manual')?.addEventListener('click', () => {
        const v = document.getElementById('manual-qr')?.value?.trim();
        if (v) processScan(v);
    });

    document.getElementById('btn-switch-cam')?.addEventListener('click', () => {
        facingMode = facingMode === 'environment' ? 'user' : 'environment';
        startCam().catch(console.error);
    });

    document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
    });

    document.getElementById('btn-torch')?.addEventListener('click', async () => {
        try {
            const track = html5QrCode?._localMediaStream?.getVideoTracks?.()[0];
            if (track && track.getCapabilities?.().torch) {
                torchOn = !torchOn;
                await track.applyConstraints({ advanced: [{ torch: torchOn }] });
            } else alert('Torch not supported on this device.');
        } catch (_) {
            alert('Torch not available.');
        }
    });

    document.getElementById('btn-logout')?.addEventListener('click', () => {
        PortalAuth.clearUser('scanner');
        showLogin();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
        if (e.key === ' ' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            document.getElementById('btn-reset')?.click();
        }
    });

    if (user) showScan(user);
    else showLogin();
})();

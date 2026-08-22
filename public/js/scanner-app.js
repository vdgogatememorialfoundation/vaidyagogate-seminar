(function () {
    const SEMINAR_SCANNER_HOST = 'seminar.vaidyagogate.org';
    const BLOCKED_HOST_RE = /autism|autistic|aba\./i;

    const isNativeScannerShell =
        !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
        /VGMF Seminar Scanner|VGMF Scanner|Capacitor/i.test(navigator.userAgent || '') ||
        new URLSearchParams(window.location.search).get('app') === 'seminar';

    function isSeminarPortalHost(hostname) {
        const h = String(hostname || '').toLowerCase();
        if (!h || BLOCKED_HOST_RE.test(h)) return false;
        if (h === SEMINAR_SCANNER_HOST) return true;
        if (h.endsWith('.vaidyagogate.org') && h.startsWith('seminar')) return true;
        return h === 'localhost' || h === '127.0.0.1';
    }

    function isScannerPageUrl(url) {
        try {
            const u = new URL(url, window.location.href);
            if (!isSeminarPortalHost(u.hostname)) return false;
            if (u.origin !== window.location.origin) return false;
            return /\/scanner(?:\.html)?$/i.test(u.pathname) || u.pathname === '/scanner';
        } catch (_) {
            return false;
        }
    }

    function installSeminarPortalGuard() {
        if (!isNativeScannerShell) return;
        if (!isSeminarPortalHost(window.location.hostname)) {
            document.body.innerHTML =
                '<div style="padding:24px;font-family:sans-serif;max-width:420px;margin:40px auto;text-align:center;">' +
                '<h2 style="color:#b91c1c;">Wrong portal</h2>' +
                '<p>This APK is for <strong>VGMF seminar check-in</strong> only (seminar.vaidyagogate.org). It cannot open other VGMF portals.</p>' +
                '</div>';
            throw new Error('seminar_scanner_wrong_host');
        }
        const origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            let url = typeof input === 'string' ? input : input && input.url;
            if (url && !url.startsWith('/')) {
                try {
                    const u = new URL(url, window.location.href);
                    if (BLOCKED_HOST_RE.test(u.hostname) || !isSeminarPortalHost(u.hostname)) {
                        return Promise.reject(new Error('Seminar scanner: blocked request to ' + u.hostname));
                    }
                } catch (_) {}
            }
            return origFetch(input, init);
        };
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

    installSeminarPortalGuard();
    if (isNativeScannerShell) lockScannerNavigation();
    if (/^\/scanner(?:\.html)?$/i.test(window.location.pathname || '')) {
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
    let scannerMediaTrack = null;
    let scanBusy = false;
    let lastScanKey = '';
    let lastScanAt = 0;
    const SCAN_DEBOUNCE_MS = 2200;
    const AUTO_NEXT_MS = 4000;
    /** ID/Aadhaar capture after scan — disabled; ticket scan + book pickup only. */
    const ID_CAPTURE_ENABLED = false;

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

    let checkinSeminarsCache = [];

    function populateScannerEventSelect(seminar) {
        const wrap = document.getElementById('scanner-event-wrap');
        const evSel = document.getElementById('scanner-event-select');
        const dayWrap = document.getElementById('scanner-day-wrap');
        const daySel = document.getElementById('scanner-day-select');
        if (wrap && evSel) {
            const events = (seminar && seminar.subEvents) || [];
            if (!events.length) {
                wrap.classList.add('hidden');
                evSel.innerHTML = '';
            } else {
                wrap.classList.remove('hidden');
                evSel.innerHTML = '<option value="">— Select session —</option>';
                events.forEach((ev) => {
                    const opt = document.createElement('option');
                    opt.value = String(ev.id);
                    opt.textContent =
                        ev.title + (ev.checkinDate ? ' · check-in ' + String(ev.checkinDate).slice(0, 10) : '');
                    evSel.appendChild(opt);
                });
                if (events.length === 1) evSel.value = String(events[0].id);
            }
        }
        if (dayWrap && daySel) {
            const days = (seminar && seminar.days) || [];
            if (!days.length) {
                dayWrap.classList.add('hidden');
                daySel.innerHTML = '';
            } else {
                dayWrap.classList.remove('hidden');
                daySel.innerHTML = '<option value="">— Select day —</option>';
                days.forEach((d) => {
                    const opt = document.createElement('option');
                    opt.value = String(d.id);
                    opt.textContent =
                        d.title +
                        (d.checkinDate || d.dayDate
                            ? ' · check-in ' + String(d.checkinDate || d.dayDate).slice(0, 10)
                            : '');
                    daySel.appendChild(opt);
                });
                if (days.length === 1) daySel.value = String(days[0].id);
            }
        }
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
            checkinSeminarsCache = Array.isArray(list) ? list : [];
            if (!checkinSeminarsCache.length) {
                sel.innerHTML = '<option value="">No check-in seminars</option>';
                populateScannerEventSelect(null);
                if (hint) hint.textContent = 'Check-in is not enabled for any seminar yet.';
                return;
            }
            sel.innerHTML = '<option value="">— Select seminar —</option>';
            checkinSeminarsCache.forEach((s) => {
                const opt = document.createElement('option');
                opt.value = String(s.id);
                opt.textContent = s.title + (s.checkinDate ? ' · ' + String(s.checkinDate).slice(0, 10) : '');
                sel.appendChild(opt);
            });
            if (checkinSeminarsCache.length === 1) sel.value = String(checkinSeminarsCache[0].id);
            sel.onchange = () => {
                selectedSeminarId = sel.value ? parseInt(sel.value, 10) : null;
                const s = checkinSeminarsCache.find((x) => Number(x.id) === Number(selectedSeminarId));
                populateScannerEventSelect(s);
                if (hint && s) {
                    if (s.checkinOpenToday === false) {
                        const cfg = s.checkinDate ? String(s.checkinDate).slice(0, 10) : 'not set';
                        hint.textContent = 'Check-in date is ' + cfg + '. Check-in is not allowed today for this seminar.';
                    } else if (s.hasDays) {
                        hint.textContent = 'Select the event day, then scan the matching e-ticket (each day has its own QR).';
                    } else if (s.hasSubEvents) {
                        hint.textContent = 'Select the session, then scan the matching e-ticket.';
                    } else {
                        hint.textContent = 'Ready to scan.';
                    }
                }
            };
            sel.dispatchEvent(new Event('change'));
        } catch (e) {
            sel.innerHTML = '<option value="">Error</option>';
            populateScannerEventSelect(null);
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

    let pendingIdCapture = null;
    let idCaptureStream = null;

    function stopIdCaptureCam() {
        if (idCaptureStream) {
            idCaptureStream.getTracks().forEach((t) => t.stop());
            idCaptureStream = null;
        }
        const vid = document.getElementById('id-capture-video');
        if (vid) vid.srcObject = null;
    }

    function finishIdCaptureStep() {
        stopIdCaptureCam();
        pendingIdCapture = null;
        scheduleAutoResume();
    }

    async function startIdCaptureCam() {
        stopIdCaptureCam();
        const vid = document.getElementById('id-capture-video');
        if (!vid || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
        try {
            idCaptureStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            vid.srcObject = idCaptureStream;
            await vid.play();
            return true;
        } catch (e) {
            console.warn('[scanner] ID camera:', e.message);
            return false;
        }
    }

    function showTicketScanSuccess(result) {
        const d = result.doctor || {};
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
                scanNote,
            'ok'
        );
        scanBusy = false;
        scheduleAutoResume();
    }

    async function beginIdCaptureFlow(result) {
        const d = result.doctor || {};
        pendingIdCapture = {
            scanEventId: result.scanEventId,
            ticketDbId: result.ticketDbId,
            registrationId: result.registrationId,
            doctorUserId: result.doctorUserId || d.userId,
            seminarId: parseInt(document.getElementById('scanner-seminar-select')?.value, 10),
            ticketIdString: d.ticketId
        };
        scanBusy = true;
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
                '<div class="id-capture-panel">' +
                '<p class="id-capture-title"><i class="fas fa-id-card"></i> Capture identity proof</p>' +
                '<p class="id-capture-hint">Take a clear photo of the visitor\'s ID (Aadhaar, driving licence, etc.) so staff can verify who attended.</p>' +
                '<video id="id-capture-video" class="id-capture-video" playsinline muted autoplay></video>' +
                '<input type="file" id="id-capture-file" accept="image/*" capture="environment" class="hidden">' +
                '<div class="id-capture-actions">' +
                '<button type="button" class="tool-btn primary" id="btn-id-capture">Take photo</button>' +
                '<button type="button" class="tool-btn" id="btn-id-file">Upload photo</button>' +
                '<button type="button" class="tool-btn" id="btn-id-skip">Skip</button>' +
                '</div>' +
                '<p id="id-capture-status" class="id-capture-status"></p>' +
                '</div>',
            'ok'
        );
        document.getElementById('btn-id-capture')?.addEventListener('click', () => window.scannerCaptureIdProof());
        document.getElementById('btn-id-file')?.addEventListener('click', () => document.getElementById('id-capture-file')?.click());
        document.getElementById('btn-id-skip')?.addEventListener('click', () => finishIdCaptureStep());
        document.getElementById('id-capture-file')?.addEventListener('change', (ev) => {
            const file = ev.target.files && ev.target.files[0];
            if (file) window.scannerUploadIdProofFile(file);
        });
        await startIdCaptureCam();
    }

    async function uploadIdProofBlob(blob) {
        if (!pendingIdCapture || !user) return finishIdCaptureStep();
        const statusEl = document.getElementById('id-capture-status');
        if (statusEl) statusEl.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('idPhoto', blob, 'id-proof.jpg');
        fd.append('scannerUserId', String(user.id));
        fd.append('seminarId', String(pendingIdCapture.seminarId || ''));
        if (pendingIdCapture.scanEventId) fd.append('scanEventId', String(pendingIdCapture.scanEventId));
        if (pendingIdCapture.ticketDbId) fd.append('ticketDbId', String(pendingIdCapture.ticketDbId));
        if (pendingIdCapture.registrationId) fd.append('registrationId', String(pendingIdCapture.registrationId));
        if (pendingIdCapture.doctorUserId) fd.append('doctorUserId', String(pendingIdCapture.doctorUserId));
        if (pendingIdCapture.ticketIdString) fd.append('ticketIdString', pendingIdCapture.ticketIdString);
        try {
            const res = await fetch('/api/scanner/id-capture', { method: 'POST', body: fd });
            const data = await res.json();
            if (res.ok && data.success) {
                if (statusEl) statusEl.textContent = 'ID photo saved.';
            } else if (statusEl) {
                statusEl.textContent = data.error || 'Upload failed — skipped.';
            }
        } catch (e) {
            if (statusEl) statusEl.textContent = 'Network error — skipped.';
        }
        setTimeout(finishIdCaptureStep, 800);
    }

    window.scannerCaptureIdProof = async function () {
        const vid = document.getElementById('id-capture-video');
        if (!vid || !vid.videoWidth) {
            alert('Camera not ready. Use Upload photo or Skip.');
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = vid.videoWidth;
        canvas.height = vid.videoHeight;
        canvas.getContext('2d').drawImage(vid, 0, 0);
        canvas.toBlob((blob) => {
            if (blob) uploadIdProofBlob(blob);
            else finishIdCaptureStep();
        }, 'image/jpeg', 0.88);
    };

    window.scannerUploadIdProofFile = function (file) {
        uploadIdProofBlob(file);
    };

    function scannerMode() {
        const m = document.getElementById('scanner-mode-select');
        return m && m.value === 'books' ? 'books' : 'ticket';
    }

    function syncScannerModeUi() {
        const mode = scannerMode();
        const semCard = document.getElementById('scanner-seminar-card');
        const title = document.getElementById('scanner-page-title');
        const hint = document.querySelector('.camera-hint');
        if (semCard) semCard.classList.toggle('hidden', mode === 'books');
        if (title) title.textContent = mode === 'books' ? 'Book pickup' : 'Scan tickets';
        if (hint) hint.textContent = mode === 'books' ? 'Scan book order pickup QR' : 'Align QR inside the frame';
        const manual = document.getElementById('manual-qr');
        if (manual) {
            manual.placeholder =
                mode === 'books' ? 'Book order code (BK…)' : 'E-ticket ID or Application ID';
        }
    }

    function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

    let pendingBookFulfillQr = null;

    function bookScanDoctorBlock(result) {
        const o = result.order || {};
        const dr = result.doctor || {};
        const drName = dr.first_name
            ? [dr.first_name, dr.last_name].filter(Boolean).join(' ')
            : dr.name || o.buyerName || '';
        const drPhone = dr.phone || o.buyerPhone || '';
        const checkedInBadge = result.checkedIn
            ? '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:6px;font-size:0.82rem;font-weight:700;">✓ Checked in</span>'
            : '<span style="background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:6px;font-size:0.82rem;font-weight:700;">⚠ Not checked in</span>';
        if (!drName) return checkedInBadge;
        return (
            '<p style="margin:4px 0;"><strong>' +
            esc(drName) +
            '</strong>' +
            (drPhone ? ' <small>' + esc(drPhone) + '</small>' : '') +
            ' &nbsp;' +
            checkedInBadge +
            '</p>'
        );
    }

    function bookScanItemsHtml(o) {
        return (o.items || [])
            .map(
                (it) =>
                    '<li>' +
                    esc(it.bookTitle || it.bookId) +
                    ' · ' +
                    esc(it.languageLabel || it.language) +
                    ' × ' +
                    it.qty +
                    '</li>'
            )
            .join('');
    }

    function bookPickupQrHtml(result) {
        const url = result.pickupQrImageUrl;
        if (!url) {
            if (result.paymentPending) {
                return '<p style="margin:10px 0;color:#854d0e;font-weight:600;">Payment not confirmed yet — ask doctor to complete payment first.</p>';
            }
            return '';
        }
        return (
            '<div style="text-align:center;margin:12px 0;padding:10px;background:#f8fafc;border-radius:10px;">' +
            '<p style="margin:0 0 8px;font-size:0.85rem;color:#64748b;">Pickup QR (order confirmed)</p>' +
            '<img src="' +
            esc(url) +
            '" alt="Pickup QR" width="200" height="200" style="border-radius:8px;">' +
            '<p style="margin:6px 0 0;font-size:0.8rem;">Code: <strong>' +
            esc((result.order && result.order.orderCode) || '') +
            '</strong></p></div>'
        );
    }

    window.scannerConfirmBookHandover = async function () {
        if (!pendingBookFulfillQr || !user) return;
        const qr = pendingBookFulfillQr;
        pendingBookFulfillQr = null;
        await processBookFulfill(qr, true);
    };

    async function processBookFulfill(decodedText, skipPreview) {
        renderResult(false, '<i class="fas fa-spinner fa-spin"></i> Verifying book order…', 'warn');
        try {
            if (!skipPreview) {
                const previewRes = await fetch('/api/scanner/volunteer-book-fulfill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        qrData: decodedText,
                        scannerUserId: Number(user.id),
                        previewOnly: true
                    })
                });
                const preview = await previewRes.json();
                const o = preview.order || {};
                const doctorBlock = bookScanDoctorBlock(preview);
                const lines = bookScanItemsHtml(o);
                const qrBlock = bookPickupQrHtml(preview);

                if (preview.outcome === 'duplicate') {
                    playTone('duplicate');
                    stats.dup++;
                    renderResult(
                        false,
                        '<h3>Already collected</h3>' +
                            doctorBlock +
                            '<p>' +
                            esc(preview.message || '') +
                            '</p><ul style="padding-left:18px;">' +
                            lines +
                            '</ul>',
                        'dup'
                    );
                    pushHistory('Duplicate book pickup', false);
                    updateStats();
                    scheduleAutoResume();
                    return;
                }
                if (preview.outcome !== 'ready') {
                    playTone('error');
                    stats.err++;
                    renderResult(
                        false,
                        '<h3>Not ready for pickup</h3>' +
                            doctorBlock +
                            '<p>' +
                            esc(preview.message || preview.error || 'Cannot hand over books yet') +
                            '</p>' +
                            qrBlock,
                        'bad'
                    );
                    pushHistory(preview.message || 'Book not ready', false);
                    updateStats();
                    scheduleAutoResume();
                    return;
                }
                pendingBookFulfillQr = decodedText;
                playTone('success');
                renderResult(
                    true,
                    '<h3>Book order — confirm handover</h3>' +
                        doctorBlock +
                        '<p><strong>Order:</strong> ' +
                        esc(o.orderCode) +
                        '</p><ul style="margin:4px 0;padding-left:18px;">' +
                        lines +
                        '</ul>' +
                        qrBlock +
                        '<button type="button" class="tool-btn primary" style="width:100%;margin-top:12px;padding:14px;font-size:1rem;" onclick="scannerConfirmBookHandover()">Mark as collected</button>',
                    'ok'
                );
                pushHistory((o.orderCode || 'Book') + ' ready', true);
                updateStats();
                scanBusy = false;
                return;
            }

            const res = await fetch('/api/scanner/volunteer-book-fulfill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qrData: decodedText, scannerUserId: Number(user.id) })
            });
            const result = await res.json();
            const o = result.order || {};
            const doctorBlock = bookScanDoctorBlock(result);
            const lines = bookScanItemsHtml(o);
            const qrBlock = bookPickupQrHtml(result);

            if (result.success) {
                playTone('success');
                stats.ok++;
                renderResult(
                    true,
                    '<h3 style="color:#15803d;">✓ Books handed over</h3>' +
                        doctorBlock +
                        '<p><strong>Order:</strong> ' +
                        esc(o.orderCode) +
                        '</p><ul style="margin:4px 0 0;padding-left:18px;">' +
                        lines +
                        '</ul>' +
                        qrBlock,
                    'ok'
                );
                pushHistory((o.orderCode || 'Book') + ' fulfilled', true);
            } else if (result.outcome === 'duplicate') {
                playTone('duplicate');
                stats.dup++;
                renderResult(
                    false,
                    '<h3>Already collected</h3>' +
                        doctorBlock +
                        '<p>' +
                        esc(result.message || '') +
                        '</p><ul style="padding-left:18px;">' +
                        lines +
                        '</ul>',
                    'dup'
                );
                pushHistory('Duplicate book pickup', false);
            } else {
                playTone('error');
                stats.err++;
                renderResult(
                    false,
                    '<h3>Denied</h3>' +
                        doctorBlock +
                        '<p>' +
                        esc(result.message || result.error || 'Invalid') +
                        '</p>',
                    'bad'
                );
                pushHistory(result.message || 'Book denied', false);
            }
            updateStats();
            scheduleAutoResume();
        } catch (e) {
            playTone('error');
            stats.err++;
            renderResult(false, '<p>' + (e.message || 'Network error') + '</p>', 'bad');
            scanBusy = false;
        }
    }

    async function processScan(decodedText) {
        const raw = String(decodedText || '').trim();
        if (!raw) return;
        const mode = scannerMode();
        const scanKey = raw + '|' + mode + '|' + (document.getElementById('scanner-seminar-select')?.value || '');
        const now = Date.now();
        if (scanBusy) return;
        if (scanKey === lastScanKey && now - lastScanAt < SCAN_DEBOUNCE_MS) return;

        if (mode === 'books') {
            scanBusy = true;
            lastScanKey = scanKey;
            lastScanAt = now;
            await processBookFulfill(decodedText);
            return;
        }

        const sel = document.getElementById('scanner-seminar-select');
        const sid = sel && sel.value ? parseInt(sel.value, 10) : selectedSeminarId;
        if (!sid) {
            alert('Select the seminar first.');
            return;
        }
        const evSel = document.getElementById('scanner-event-select');
        const eventId = evSel && evSel.value ? parseInt(evSel.value, 10) : null;
        const daySel = document.getElementById('scanner-day-select');
        const dayId = daySel && daySel.value ? parseInt(daySel.value, 10) : null;
        const sem = checkinSeminarsCache.find((x) => Number(x.id) === Number(sid));
        if (sem && sem.hasSubEvents && (!eventId || eventId < 1)) {
            alert('Select the session/event before scanning.');
            scanBusy = false;
            return;
        }
        if (sem && sem.hasDays && (!dayId || dayId < 1)) {
            alert('Select the event day before scanning — each day has its own QR.');
            scanBusy = false;
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
                    seminarId: sid,
                    eventId: eventId || undefined,
                    dayId: dayId || undefined
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
                pushHistory((d.name || 'Guest') + ' · ' + (d.ticketId || d.applicationNo || ''), true);
                if (ID_CAPTURE_ENABLED) {
                    beginIdCaptureFlow(result);
                } else {
                    showTicketScanSuccess(result);
                }
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

    function getScannerVideoTrack() {
        if (scannerMediaTrack && scannerMediaTrack.readyState === 'live') {
            return scannerMediaTrack;
        }
        const reader = document.getElementById('reader');
        if (reader) {
            const video = reader.querySelector('video');
            if (video && video.srcObject instanceof MediaStream) {
                const t = video.srcObject.getVideoTracks()[0];
                if (t && t.readyState === 'live') return t;
            }
        }
        if (html5QrCode) {
            const streams = [
                html5QrCode._localMediaStream,
                html5QrCode._mediaStream,
                html5QrCode._stream,
                html5QrCode._qrRegionCamera && html5QrCode._qrRegionCamera._localMediaStream
            ];
            for (let i = 0; i < streams.length; i++) {
                const s = streams[i];
                if (s && typeof s.getVideoTracks === 'function') {
                    const t = s.getVideoTracks()[0];
                    if (t && t.readyState === 'live') return t;
                }
            }
        }
        return null;
    }

    function refreshScannerMediaTrack() {
        scannerMediaTrack = getScannerVideoTrack();
        return scannerMediaTrack;
    }

    function waitForScannerVideo(maxMs) {
        const limit = maxMs || 4000;
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                if (refreshScannerMediaTrack()) return resolve(true);
                if (Date.now() - t0 >= limit) return resolve(false);
                requestAnimationFrame(tick);
            };
            tick();
        });
    }

    async function applyTorchToTrack(track, on) {
        if (!track || track.readyState === 'ended') return false;
        const value = !!on;
        const attempts = [
            { advanced: [{ torch: value }] },
            { torch: value },
            { advanced: [{ fillLightMode: value ? 'flash' : 'off' }] },
            { fillLightMode: value ? 'flash' : 'off' }
        ];
        for (let i = 0; i < attempts.length; i++) {
            try {
                await track.applyConstraints(attempts[i]);
                return true;
            } catch (_) {}
        }
        return false;
    }

    async function restartCameraWithTorch(wantTorch) {
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (_) {}
        }
        scannerMediaTrack = null;
        html5QrCode = new Html5Qrcode('reader');
        const config = { fps: 15, qrbox: { width: 260, height: 260 }, aspectRatio: 1, disableFlip: false };
        const cameraConfigs = wantTorch
            ? [
                  { facingMode: { exact: facingMode }, advanced: [{ torch: true }] },
                  { facingMode: facingMode, advanced: [{ torch: true }] },
                  { facingMode: { ideal: facingMode }, advanced: [{ torch: true }] },
                  { facingMode: facingMode, torch: true }
              ]
            : [{ facingMode: facingMode }];
        for (let i = 0; i < cameraConfigs.length; i++) {
            try {
                await html5QrCode.start(cameraConfigs[i], config, (text) => processScan(text));
                await waitForScannerVideo(3000);
                if (wantTorch) {
                    const track = refreshScannerMediaTrack();
                    if (track) await applyTorchToTrack(track, true);
                }
                return true;
            } catch (_) {}
        }
        try {
            await html5QrCode.start({ facingMode }, config, (text) => processScan(text));
            await waitForScannerVideo(3000);
            return !wantTorch;
        } catch (e) {
            throw e;
        }
    }

    function showCameraError(message) {
        const hintEl = document.querySelector('.camera-hint');
        const msg =
            message ||
            'Could not open camera. Allow camera permission in browser or app settings, then tap Reset.';
        if (hintEl) hintEl.textContent = msg;
        console.error('[scanner] camera:', msg);
    }

    function pickCameraDeviceId(cameras, mode) {
        const list = Array.isArray(cameras) ? cameras : [];
        if (!list.length) return null;
        const label = (c) => String((c && c.label) || '').toLowerCase();
        if (mode === 'environment') {
            const back =
                list.find((c) => /back|rear|environment|wide/i.test(label(c))) ||
                list[list.length - 1];
            return back && back.id;
        }
        const front = list.find((c) => /front|user|selfie/i.test(label(c))) || list[0];
        return front && front.id;
    }

    async function startCam() {
        const readerEl = document.getElementById('reader');
        const hintEl = document.querySelector('.camera-hint');
        if (html5QrCode) {
            try {
                await html5QrCode.stop();
            } catch (_) {}
        }
        torchOn = false;
        scannerMediaTrack = null;
        updateTorchButton();
        if (readerEl) readerEl.innerHTML = '';
        html5QrCode = new Html5Qrcode('reader');
        const config = { fps: 12, qrbox: { width: 260, height: 260 }, aspectRatio: 1, disableFlip: false };
        const onScan = (text) => processScan(text);

        if (!window.isSecureContext) {
            showCameraError('Camera needs HTTPS. Open the scanner via https://seminar.vaidyagogate.org');
            throw new Error('insecure_context');
        }

        let lastErr = null;
        try {
            if (typeof Html5Qrcode.getCameras === 'function') {
                const cameras = await Html5Qrcode.getCameras();
                const deviceId = pickCameraDeviceId(cameras, facingMode);
                if (deviceId) {
                    await html5QrCode.start(deviceId, config, onScan);
                    await waitForScannerVideo(4000);
                    if (hintEl) {
                        hintEl.textContent =
                            scannerMode() === 'books'
                                ? 'Scan book order pickup QR'
                                : 'Align QR inside the frame';
                    }
                    return;
                }
            }
        } catch (e) {
            lastErr = e;
        }

        const cameraTry = [
            { facingMode: { exact: facingMode } },
            { facingMode: { ideal: facingMode } },
            { facingMode: facingMode }
        ];
        for (let i = 0; i < cameraTry.length; i++) {
            try {
                await html5QrCode.start(cameraTry[i], config, onScan);
                await waitForScannerVideo(4000);
                if (hintEl) {
                    hintEl.textContent =
                        scannerMode() === 'books'
                            ? 'Scan book order pickup QR'
                            : 'Align QR inside the frame';
                }
                return;
            } catch (e) {
                lastErr = e;
            }
        }

        const errMsg =
            (lastErr && (lastErr.message || lastErr.name)) ||
            'Camera permission denied or no camera available.';
        showCameraError(errMsg);
        throw lastErr || new Error(errMsg);
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
        syncScannerModeUi();
        loadCheckinSeminars()
            .then(() => startCam())
            .catch((e) => {
                console.error(e);
                showCameraError(
                    (e && e.message) ||
                        'Camera failed to start. Allow camera access and tap Reset below.'
                );
            });
    }

    document.getElementById('scanner-mode-select')?.addEventListener('change', syncScannerModeUi);

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

    function updateTorchButton() {
        const btn = document.getElementById('btn-torch');
        if (!btn) return;
        btn.classList.toggle('torch-on', torchOn);
        btn.title = torchOn ? 'Torch off' : 'Torch on';
        btn.setAttribute('aria-pressed', torchOn ? 'true' : 'false');
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = torchOn ? 'fas fa-lightbulb' : 'far fa-lightbulb';
        }
    }

    async function setTorch(on) {
        const want = !!on;
        let track = refreshScannerMediaTrack();
        if (!track) {
            alert('Start the camera first.');
            return false;
        }
        let ok = await applyTorchToTrack(track, want);
        if (!ok && want) {
            try {
                ok = await restartCameraWithTorch(true);
            } catch (_) {
                ok = false;
            }
        }
        if (!ok && !want) {
            ok = await applyTorchToTrack(track, false);
            if (!ok) {
                try {
                    ok = await restartCameraWithTorch(false);
                } catch (_) {
                    ok = false;
                }
            }
        }
        if (ok) {
            torchOn = want;
            updateTorchButton();
            refreshScannerMediaTrack();
            return true;
        }
        alert(
            want
                ? 'Torch could not be enabled. Use the rear camera, allow camera permission, and try again.'
                : 'Torch could not be turned off. Restart the scanner page if the light stays on.'
        );
        return false;
    }

    document.getElementById('btn-torch')?.addEventListener('click', async () => {
        await setTorch(!torchOn);
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

(function () {
    const state = {
        seminarId: null,
        applicationNo: '',
        prn: '',
        token: '',
        certId: null,
        maskedEmail: '',
        maskedPhone: '',
        displayName: '',
        schedule: [],
        countdownTimer: null
    };

    function qs(name) {
        return new URLSearchParams(window.location.search).get(name) || '';
    }

    function showMsg(el, text, kind) {
        if (!el) return;
        el.style.display = text ? 'block' : 'none';
        el.textContent = text || '';
        el.className = 'cv-msg' + (kind ? ' ' + kind : '');
    }

    function showStep(id) {
        document.querySelectorAll('.cv-step').forEach((s) => s.classList.remove('active'));
        const step = document.getElementById(id);
        if (step) step.classList.add('active');
    }

    function lookupPayload() {
        const kindEl = document.getElementById('cv-cert-kind');
        const certKind = kindEl && kindEl.value ? kindEl.value : undefined;
        return {
            seminarId: state.seminarId,
            applicationNo: state.applicationNo || undefined,
            prn: state.prn || undefined,
            token: state.token || undefined,
            certKind
        };
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function tickCountdown(opensAt, labelEl, seminarEl, onDone) {
        const dist = new Date(opensAt).getTime() - Date.now();
        if (dist <= 0) {
            if (onDone) onDone();
            return;
        }
        if (labelEl) labelEl.textContent = 'Certificate verification opens in';
        const d = Math.floor(dist / (1000 * 60 * 60 * 24));
        const h = Math.floor((dist % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const m = Math.floor((dist % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((dist % (1000 * 60)) / 1000);
        const root = document.getElementById('cv-step-countdown');
        if (root) {
            const dd = root.querySelector('.cv-cd-d');
            const hh = root.querySelector('.cv-cd-h');
            const mm = root.querySelector('.cv-cd-m');
            const ss = root.querySelector('.cv-cd-s');
            if (dd) dd.textContent = pad2(d);
            if (hh) hh.textContent = pad2(h);
            if (mm) mm.textContent = pad2(m);
            if (ss) ss.textContent = pad2(s);
        }
        if (seminarEl && state.schedule.length) {
            const item = state.schedule.find((x) => x.countdown && x.countdown.opensAt === opensAt);
            if (item) seminarEl.textContent = item.title || '';
        }
    }

    function refreshCountdownUi() {
        const pending = (state.schedule || []).filter((x) => x.countdown && !x.live);
        const live = (state.schedule || []).filter((x) => x.live);
        if (!pending.length && live.length) {
            showStep('cv-step-lookup');
            loadSeminars();
            return;
        }
        if (pending.length) {
            const first = pending[0];
            const opensAt = first.countdown.opensAt;
            const labelEl = document.getElementById('cv-countdown-label');
            const seminarEl = document.getElementById('cv-countdown-seminar');
            if (first.countdown.label && labelEl) labelEl.textContent = first.countdown.label;
            if (seminarEl) seminarEl.textContent = first.title || '';
            showStep('cv-step-countdown');
            if (state.countdownTimer) clearInterval(state.countdownTimer);
            tickCountdown(opensAt, labelEl, seminarEl, () => {
                loadSchedule().then(() => refreshCountdownUi());
            });
            state.countdownTimer = setInterval(() => {
                tickCountdown(opensAt, labelEl, seminarEl, () => {
                    clearInterval(state.countdownTimer);
                    loadSchedule().then(() => refreshCountdownUi());
                });
            }, 1000);
            return;
        }
        showStep('cv-step-lookup');
        loadSeminars();
    }

    async function loadSchedule() {
        try {
            const res = await fetch('/api/public/certificate-verify/schedule');
            const list = await res.json();
            if (!res.ok) throw new Error(list.error || 'Could not load schedule');
            state.schedule = Array.isArray(list) ? list : [];
        } catch (e) {
            console.error(e);
            state.schedule = [];
        }
    }

    async function loadSeminars() {
        const sel = document.getElementById('cv-seminar');
        if (!sel) return;
        try {
            const res = await fetch('/api/public/certificate-verify/seminars');
            const list = await res.json();
            if (!res.ok) throw new Error(list.error || 'Could not load seminars');
            sel.innerHTML = '<option value="">Select seminar</option>';
            (list || []).forEach((s) => {
                const opt = document.createElement('option');
                opt.value = String(s.id);
                opt.textContent = s.title + (s.eventDate ? ' (' + s.eventDate + ')' : '');
                sel.appendChild(opt);
            });
            if (!list || !list.length) {
                sel.innerHTML = '<option value="">No seminars open for verification yet</option>';
            }
        } catch (e) {
            sel.innerHTML = '<option value="">Could not load seminars</option>';
            console.error(e);
        }
    }

    async function doLookup() {
        const msg = document.getElementById('cv-lookup-msg');
        const btn = document.getElementById('cv-lookup-btn');
        state.seminarId = parseInt(document.getElementById('cv-seminar')?.value || '', 10);
        state.applicationNo = String(document.getElementById('cv-application')?.value || '').trim();
        state.prn = String(document.getElementById('cv-prn')?.value || '').trim();
        if (!state.token && (!Number.isInteger(state.seminarId) || state.seminarId < 1)) {
            showMsg(msg, 'Select a seminar.', 'err');
            return;
        }
        if (!state.token && !state.applicationNo && !state.prn) {
            showMsg(msg, 'Enter application number, portal registration number, or scan the certificate QR code.', 'err');
            return;
        }
        if (btn) btn.disabled = true;
        showMsg(msg, 'Looking up certificate…', 'info');
        try {
            const res = await fetch('/api/public/certificate-verify/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(lookupPayload())
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'Certificate not found');
            state.certId = data.certId;
            state.certKind = data.certKind || '';
            state.displayName = data.displayName || '';
            state.maskedEmail = data.maskedEmail || '';
            state.maskedPhone = data.maskedPhone || '';
            if (data.applicationNo) state.applicationNo = data.applicationNo;
            if (data.prn) state.prn = data.prn;
            if (data.seminar && data.seminar.id) {
                state.seminarId = data.seminar.id;
                const sel = document.getElementById('cv-seminar');
                if (sel) sel.value = String(data.seminar.id);
            }
            if (data.applicationNo) {
                const appEl = document.getElementById('cv-application');
                if (appEl) appEl.value = data.applicationNo;
            }
            if (data.prn) {
                const prnEl = document.getElementById('cv-prn');
                if (prnEl) prnEl.value = data.prn;
            }
            const hint = document.getElementById('cv-otp-hint');
            if (hint) {
                const kindLabel =
                    data.certKind === 'volunteer'
                        ? 'Volunteer certificate'
                        : data.certKind === 'participant'
                          ? 'Participation certificate'
                          : 'Certificate';
                hint.textContent =
                    kindLabel +
                    ' found for ' +
                    (data.displayName || 'participant') +
                    '. One-time passwords will be sent to ' +
                    state.maskedEmail +
                    ' and WhatsApp ' +
                    state.maskedPhone +
                    '.';
            }
            showMsg(msg, '', '');
            showStep('cv-step-otp');
            document.getElementById('cv-confirm-btn').style.display = 'none';
            document.getElementById('cv-send-otp-btn').style.display = 'block';
        } catch (e) {
            showMsg(msg, e.message || 'Lookup failed', 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function sendOtps() {
        const msg = document.getElementById('cv-otp-msg');
        const sendBtn = document.getElementById('cv-send-otp-btn');
        const confirmBtn = document.getElementById('cv-confirm-btn');
        if (sendBtn) sendBtn.disabled = true;
        showMsg(msg, 'Sending one-time password codes…', 'info');
        try {
            const res = await fetch('/api/public/certificate-verify/otp/send-both', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(lookupPayload())
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not send one-time passwords');
            showMsg(
                msg,
                'One-time passwords sent to ' +
                    (data.maskedEmail || state.maskedEmail) +
                    ' and ' +
                    (data.maskedPhone || state.maskedPhone) +
                    '. Enter both codes below.',
                'ok'
            );
            if (sendBtn) sendBtn.style.display = 'none';
            if (confirmBtn) confirmBtn.style.display = 'block';
        } catch (e) {
            showMsg(msg, e.message || 'Send failed', 'err');
            if (sendBtn) sendBtn.style.display = 'block';
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    async function confirmVerify() {
        const msg = document.getElementById('cv-otp-msg');
        const emailCode = String(document.getElementById('cv-email-otp')?.value || '').trim();
        const phoneCode = String(document.getElementById('cv-phone-otp')?.value || '').trim();
        if (!emailCode || !phoneCode) {
            showMsg(msg, 'Enter both email and WhatsApp one-time password codes.', 'err');
            return;
        }
        const btn = document.getElementById('cv-confirm-btn');
        if (btn) btn.disabled = true;
        showMsg(msg, 'Verifying…', 'info');
        try {
            const res = await fetch('/api/public/certificate-verify/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...lookupPayload(),
                    emailCode,
                    phoneCode
                })
            });
            const data = await res.json();
            if (!res.ok || !data.valid) throw new Error(data.error || 'Verification failed');
            document.getElementById('cv-result-message').textContent = data.message || '';
            const meta = document.getElementById('cv-result-meta');
            if (meta) {
                const kindLabel =
                    data.certKind === 'volunteer' || state.certKind === 'volunteer'
                        ? 'Volunteer'
                        : 'Participation';
                meta.innerHTML =
                    '<dt>Certificate type</dt><dd>' +
                    escapeHtml(kindLabel) +
                    '</dd>' +
                    '<dt>Name on certificate</dt><dd>' +
                    escapeHtml(data.displayName || state.displayName) +
                    '</dd>' +
                    '<dt>Seminar</dt><dd>' +
                    escapeHtml(data.seminarTitle || '') +
                    '</dd>' +
                    '<dt>Application number</dt><dd>' +
                    escapeHtml(data.applicationNo || state.applicationNo) +
                    '</dd>' +
                    '<dt>Portal registration number</dt><dd>' +
                    escapeHtml(data.prn || state.prn) +
                    '</dd>';
            }
            showStep('cv-step-result');
        } catch (e) {
            showMsg(msg, e.message || 'Verification failed', 'err');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function resetAll() {
        state.certId = null;
        state.displayName = '';
        state.maskedEmail = '';
        state.maskedPhone = '';
        document.getElementById('cv-email-otp').value = '';
        document.getElementById('cv-phone-otp').value = '';
        document.getElementById('cv-send-otp-btn').style.display = 'block';
        document.getElementById('cv-confirm-btn').style.display = 'none';
        refreshCountdownUi();
    }

    document.addEventListener('DOMContentLoaded', () => {
        state.token = qs('t');
        loadSchedule().then(() => {
            if (state.token) {
                showStep('cv-step-lookup');
                doLookup();
            } else {
                refreshCountdownUi();
            }
        });
        document.getElementById('cv-lookup-btn')?.addEventListener('click', doLookup);
        document.getElementById('cv-send-otp-btn')?.addEventListener('click', sendOtps);
        document.getElementById('cv-confirm-btn')?.addEventListener('click', confirmVerify);
        document.getElementById('cv-back-lookup-btn')?.addEventListener('click', resetAll);
        document.getElementById('cv-another-btn')?.addEventListener('click', resetAll);
    });
})();

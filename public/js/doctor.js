let currentUser = null;
let currentRegistrationId = null;
let __doctorAllowedTabs = null;
window.__portalFlags = window.__portalFlags || {};

/** Fallback when R2 is off (Vercel body limit). */
const UPLOAD_HOST_CAP_MB = 4;
let __caseUploadConfig = null;

async function ensureCaseUploadConfig(programId) {
    if (!window.CaseR2Upload) return null;
    const pid = programId || activeCaseProgramId;
    if (__caseUploadConfig && __caseUploadConfig._programId === pid) return __caseUploadConfig;
    try {
        __caseUploadConfig = await CaseR2Upload.loadConfig(pid);
        __caseUploadConfig._programId = pid;
        if (__caseUploadConfig.r2SetupError) {
            console.warn('[case-upload]', __caseUploadConfig.r2SetupError);
            __caseUploadConfig.r2Enabled = false;
        }
    } catch (e) {
        console.warn('[case-upload]', e);
        __caseUploadConfig = { r2Enabled: false };
    }
    return __caseUploadConfig;
}

function effectiveCaseMaxMb(program, config) {
    if (config && config.r2Enabled) {
        return config.effectiveMaxMb || config.defaultMaxMb || 100;
    }
    const requested = (program && program.maxFileSizeMb) || 50;
    return Math.min(requested, UPLOAD_HOST_CAP_MB);
}

function setInlineUploadSuccess(el, textEl, message, show) {
    if (!el) return;
    if (!show) {
        el.classList.add('hidden');
        if (textEl) textEl.textContent = '';
        return;
    }
    el.classList.remove('hidden');
    if (textEl) textEl.textContent = message;
}

function getRegCertFileLabel() {
    const inp = document.getElementById('reg-cert-file');
    const f = inp && inp.files && inp.files[0];
    return f ? f.name : '';
}

function updateRegCertUploadUi(opts) {
    const options = opts || {};
    const name = getRegCertFileLabel();
    const successEl = document.getElementById('reg-cert-success');
    const successText = document.getElementById('reg-cert-success-text');
    if (options.uploaded) {
        setInlineUploadSuccess(
            successEl,
            successText,
            'Certificate uploaded successfully' + (name ? ': ' + name : '') + '.',
            true
        );
    } else if (name) {
        setInlineUploadSuccess(
            successEl,
            successText,
            'Certificate selected: ' + name + '. Click Verify ID to upload, or it uploads when you submit.',
            true
        );
    } else {
        setInlineUploadSuccess(successEl, successText, '', false);
    }
}

function updateCaseFilesSuccessUi(message) {
    const el = document.getElementById('case-files-success');
    const text = document.getElementById('case-files-success-text');
    setInlineUploadSuccess(el, text, message || '', !!message);
}

function regCertStatusLabel() {
    const name = getRegCertFileLabel();
    if (!name) return '';
    if (window.__regCertServerUploaded) {
        return 'Uploaded successfully: ' + name;
    }
    return 'Attached: ' + name + ' (uploads when you verify ID or submit)';
}

function updateRegistrationPreviewCertificate() {
    const qual = document.getElementById('reg-qual') && document.getElementById('reg-qual').value;
    const needsCert = qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner';
    const certName = getRegCertFileLabel();
    const certBox = document.getElementById('prev-cert-box');
    const certVal = document.getElementById('prev-cert-val');
    const pdfBadge = document.getElementById('reg-pdf-cert-badge');
    if (needsCert && certName) {
        if (certBox) certBox.classList.remove('hidden');
        if (certVal) {
            certVal.textContent = regCertStatusLabel();
            certVal.style.color = '#059669';
        }
        if (pdfBadge) {
            pdfBadge.classList.remove('hidden');
            pdfBadge.innerHTML =
                '<i class="fas fa-file-circle-check"></i> ' +
                (window.__regCertServerUploaded
                    ? 'NCISM certificate uploaded (shown in PDF preview below)'
                    : 'NCISM certificate attached (shown in PDF preview below)');
        }
    } else {
        if (certBox) certBox.classList.add('hidden');
        if (pdfBadge) pdfBadge.classList.add('hidden');
    }
    refreshRegistrationPreviewPdfIfVisible();
}

function refreshRegistrationPreviewPdfIfVisible() {
    const step5 = document.getElementById('step-5');
    if (!step5 || step5.classList.contains('hidden')) return;
    const qrImg = document.getElementById('prev-qrcode');
    if (qrImg && qrImg.src) {
        generatePdfBlob(qrImg.complete ? qrImg : null);
    } else {
        generatePdfBlob(null);
    }
}

window.__caseStagedUploadIds = null;
window.__caseStagedFileMeta = [];

function getCaseFormSnapshot() {
    return {
        fname: (document.getElementById('case-fname') || {}).value || '',
        mname: (document.getElementById('case-mname') || {}).value || '',
        lname: (document.getElementById('case-lname') || {}).value || '',
        email: (document.getElementById('case-email') || {}).value || '',
        phone: (document.getElementById('case-phone') || {}).value || '',
        whatsapp: (document.getElementById('case-whatsapp') || {}).value || '',
        category: (document.getElementById('case-category') || {}).value || '',
        topic: (document.getElementById('case-topic') || {}).value || ''
    };
}

function getCaseSelectedFileMeta() {
    const inp = document.getElementById('case-files');
    const list = [];
    if (inp && inp.files) {
        for (let i = 0; i < inp.files.length; i++) {
            const f = inp.files[i];
            list.push({
                name: f.name,
                size: f.size,
                uploaded: !!(window.__caseStagedUploadIds && window.__caseStagedUploadIds.length)
            });
        }
    }
    if (window.__caseStagedFileMeta && window.__caseStagedFileMeta.length) {
        return window.__caseStagedFileMeta.map((m) => ({
            name: m.name,
            size: m.size,
            uploaded: true
        }));
    }
    return list;
}

function renderCasePreviewSummary() {
    const box = document.getElementById('case-prev-summary');
    if (!box) return;
    const f = getCaseFormSnapshot();
    const files = getCaseSelectedFileMeta();
    const PU = window.PortalUpload;
    const fmt = PU && PU.formatBytes ? PU.formatBytes.bind(PU) : (n) => String(n);
    let filesHtml = '';
    if (files.length) {
        filesHtml =
            '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0;"><strong style="color:#0f766e;">Documents</strong><ul style="margin:8px 0 0;padding-left:18px;font-size:0.88rem;">';
        files.forEach((file) => {
            const ok = file.uploaded;
            filesHtml +=
                '<li style="margin-bottom:6px;color:' +
                (ok ? '#059669' : '#475569') +
                ';">' +
                (ok ? '<i class="fas fa-check-circle"></i> ' : '') +
                escapeHtmlDoctor(file.name) +
                ' (' +
                fmt(file.size) +
                ')' +
                (ok ? ' - <strong>uploaded successfully</strong>' : ' - ready to upload') +
                '</li>';
        });
        filesHtml += '</ul></div>';
    }
    box.innerHTML =
        '<div class="preview-row"><span class="lbl">Programme</span><span class="val">' +
        escapeHtmlDoctor((activeCaseProgram && activeCaseProgram.title) || '-') +
        '</span></div>' +
        '<div class="preview-row"><span class="lbl">Name</span><span class="val">' +
        escapeHtmlDoctor([f.fname, f.mname, f.lname].filter(Boolean).join(' ')) +
        '</span></div>' +
        '<div class="preview-row"><span class="lbl">Email / Phone</span><span class="val">' +
        escapeHtmlDoctor(f.email + ' / ' + f.phone) +
        '</span></div>' +
        '<div class="preview-row"><span class="lbl">WhatsApp</span><span class="val">' +
        escapeHtmlDoctor(f.whatsapp) +
        '</span></div>' +
        '<div class="preview-row"><span class="lbl">Category</span><span class="val">' +
        escapeHtmlDoctor(f.category) +
        '</span></div>' +
        '<div class="preview-row"><span class="lbl">Case topic</span><span class="val">' +
        escapeHtmlDoctor(f.topic) +
        '</span></div>' +
        filesHtml;
    const badge = document.getElementById('case-pdf-docs-badge');
    const badgeText = document.getElementById('case-pdf-docs-badge-text');
    if (badge && badgeText && files.length) {
        const uploadedCount = files.filter((x) => x.uploaded).length;
        if (uploadedCount === files.length) {
            badge.classList.remove('hidden');
            badgeText.textContent =
                uploadedCount + ' document(s) uploaded successfully (included in application PDF below)';
        } else if (uploadedCount > 0) {
            badge.classList.remove('hidden');
            badgeText.textContent = uploadedCount + ' of ' + files.length + ' document(s) uploaded';
        } else {
            badge.classList.add('hidden');
        }
    }
}

function escapeHtmlDoctor(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function generateCasePreviewPdf() {
    if (!window.jspdf) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const accent = [15, 118, 110];
    const ink = [15, 23, 42];
    const muted = [71, 85, 105];
    const f = getCaseFormSnapshot();
    const files = getCaseSelectedFileMeta();
    const PU = window.PortalUpload;
    const fmt = PU && PU.formatBytes ? PU.formatBytes.bind(PU) : (n) => String(n);

    let y = pdfCongressHeader(doc, 'Case presentation - draft preview');
    const drawSection = (title) => {
        y = pdfCongressSectionTitle(doc, y + 4, title, accent, ink);
    };
    const drawTableRow = (label, value) => {
        const lh = 6.2;
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...muted);
        const lines = doc.splitTextToSize(String(value || '-'), 118);
        doc.text(label, 18, y + 7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        doc.text(lines, 72, y + 7);
        y += Math.max(10, lines.length * lh);
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y, 196, y);
    };

    drawSection('Programme');
    drawTableRow('Case program', (activeCaseProgram && activeCaseProgram.title) || '-');
    drawSection('Applicant');
    drawTableRow('Full name', [f.fname, f.mname, f.lname].filter(Boolean).join(' '));
    drawTableRow('Email', f.email);
    drawTableRow('Phone', f.phone);
    drawTableRow('WhatsApp', f.whatsapp);
    drawSection('Presentation');
    drawTableRow('Category', f.category);
    drawTableRow('Case topic', f.topic);
    drawSection('Documents submitted');
    if (!files.length) {
        drawTableRow('Files', 'None attached');
    } else {
        files.forEach((file, idx) => {
            drawTableRow(
                'File ' + (idx + 1),
                (file.uploaded ? 'Uploaded successfully: ' : 'Attached: ') +
                    file.name +
                    ' (' +
                    fmt(file.size) +
                    ')'
            );
        });
    }

    y += 8;
    doc.setFontSize(11);
    doc.setTextColor(180, 83, 9);
    doc.setFont('helvetica', 'bold');
    doc.text('DRAFT PREVIEW — confirm and submit', 105, y, { align: 'center' });

    const pdfBlob = doc.output('blob');
    if (currentCasePdfBlobUrl) URL.revokeObjectURL(currentCasePdfBlobUrl);
    currentCasePdfBlobUrl = URL.createObjectURL(pdfBlob);
    const iframe = document.getElementById('case-pdf-viewer');
    if (iframe) iframe.src = currentCasePdfBlobUrl;
}

async function validateCaseFormBeforePreviewOrSubmit() {
    const uid = doctorUserIdOrAlert();
    if (!uid) return null;
    if (!activeCaseProgramId) return alert('Select a case program first.'), null;
    const form = getCaseFormSnapshot();
    if (typeof validateRegistrationNamesClient === 'function') {
        const ne = validateRegistrationNamesClient(form);
        if (ne) return alert(ne), null;
    }
    if (typeof validateEmailClient === 'function' && String(form.email || '').trim()) {
        const ev = validateEmailClient(form.email, 'Email');
        if (!ev.valid) return alert(ev.message), null;
        form.email = ev.cleanedEmail;
    }
    if (typeof validatePhoneClient === 'function' && String(form.phone || '').trim()) {
        const pv = validatePhoneClient(form.phone, 'Phone');
        if (!pv.valid) return alert(pv.message), null;
        form.phone = pv.cleanedPhone;
    }
    if (typeof validatePhoneClient === 'function' && String(form.whatsapp || '').trim()) {
        const wv = validatePhoneClient(form.whatsapp, 'WhatsApp');
        if (!wv.valid) return alert(wv.message), null;
        form.whatsapp = wv.cleanedPhone;
    }
    const fileInput = document.getElementById('case-files');
    const maxFiles = (activeCaseProgram && activeCaseProgram.maxFilesPerSubmission) || 5;
    const filesField = (activeCaseProgram && activeCaseProgram.formConfig && activeCaseProgram.formConfig.fields || []).find(
        (f) => f.key === 'files'
    );
    const filesRequired = !filesField || filesField.enabled === false ? false : filesField.required !== false;
    if (
        filesRequired &&
        !fileInput?.files?.length &&
        !(window.__caseStagedUploadIds && window.__caseStagedUploadIds.length)
    ) {
        return alert('Select at least one file'), null;
    }
    if (fileInput?.files?.length > maxFiles) return alert('Maximum ' + maxFiles + ' files'), null;
    return { uid, form, fileInput };
}

async function goToCasePreview() {
    const validated = await validateCaseFormBeforePreviewOrSubmit();
    if (!validated) return;
    const { uid, fileInput } = validated;
    const uploadCfg = await ensureCaseUploadConfig(activeCaseProgramId);
    const maxMb = effectiveCaseMaxMb(activeCaseProgram, uploadCfg);
    const progressEl = document.getElementById('case-upload-progress');
    const setProgress = (msg) => {
        if (progressEl) {
            progressEl.style.display = msg ? 'block' : 'none';
            progressEl.textContent = msg || '';
        }
    };

    window.__caseStagedUploadIds = null;
    window.__caseStagedFileMeta = [];

    if (fileInput?.files?.length) {
        for (let i = 0; i < fileInput.files.length; i++) {
            const raw = fileInput.files[i];
            if (raw.size > maxMb * 1024 * 1024) {
                return alert('Each file must be under ' + maxMb + ' MB ("' + raw.name + '").');
            }
        }
        const useR2 = uploadCfg && window.CaseR2Upload && CaseR2Upload.isEnabled(uploadCfg);
        if (useR2) {
            try {
                setProgress('Uploading documents... 0%');
                window.__caseStagedUploadIds = await CaseR2Upload.uploadFiles(fileInput.files, {
                    userId: uid,
                    caseProgramId: activeCaseProgramId,
                    onFileProgress: (idx, total, name, pct) => {
                        setProgress('Uploading ' + (idx + 1) + '/' + total + ': ' + name + ' - ' + pct + '%');
                    }
                });
                window.__caseStagedFileMeta = Array.from(fileInput.files).map((f) => ({
                    name: f.name,
                    size: f.size
                }));
                updateCaseFilesSuccessUi(
                    'All ' + window.__caseStagedUploadIds.length + ' document(s) uploaded successfully.'
                );
            } catch (e) {
                setProgress('');
                updateCaseFilesSuccessUi('');
                return alert(e.message || 'Upload failed');
            }
            setProgress('');
        } else {
            window.__caseStagedFileMeta = Array.from(fileInput.files).map((f) => ({
                name: f.name,
                size: f.size,
                uploaded: false
            }));
        }
    }

    document.getElementById('case-step-form').classList.add('hidden');
    document.getElementById('case-step-preview').classList.remove('hidden');
    renderCasePreviewSummary();
    generateCasePreviewPdf();
}

function backFromCasePreview() {
    document.getElementById('case-step-preview').classList.add('hidden');
    document.getElementById('case-step-form').classList.remove('hidden');
}

function cancelCaseApplication() {
    window.__caseStagedUploadIds = null;
    window.__caseStagedFileMeta = [];
    const stepForm = document.getElementById('case-step-form');
    const stepPrev = document.getElementById('case-step-preview');
    if (stepForm) stepForm.classList.remove('hidden');
    if (stepPrev) stepPrev.classList.add('hidden');
    activeCaseProgramId = null;
    activeCaseProgram = null;
    loadCaseProgramsGrid();
}

async function prepareUploadFileOrAlert(file) {
    const PU = window.PortalUpload;
    if (!PU) {
        alert('Upload helper failed to load. Refresh the page and try again.');
        return null;
    }
    const prep = await PU.prepareFileForUpload(file);
    if (!prep.ok) {
        alert(prep.error);
        return null;
    }
    if (prep.note) console.info('[upload]', prep.note);
    return prep.file;
}

function doctorNumericUserId() {
    if (!currentUser) return null;
    const raw = currentUser.id != null ? currentUser.id : currentUser.user_id;
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return n;
    return null;
}

function requireDoctorUserId() {
    const uid = doctorNumericUserId();
    if (!uid) {
        alert('Session expired or invalid. Please sign out and sign in again with your email and password.');
        return null;
    }
    return uid;
}

function doctorUserIdOrAlert() {
    return requireDoctorUserId();
}

function parseDoctorModulesMap(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        const o = JSON.parse(String(raw));
        return o && typeof o === 'object' ? o : null;
    } catch (_) {
        return null;
    }
}

function applyDoctorModuleAccessFromUser(user) {
    const category = String((user && user.doctor_category) || 'regular').toLowerCase();
    let mods = parseDoctorModulesMap(user && user.doctor_modules);
    if (!mods && category === 'volunteer') {
        mods = {
            'tab-dashboard': true,
            'tab-profile': true,
            'tab-volunteer': true,
            'tab-ticket': true,
            'tab-certificate': true,
            'tab-reset-pwd': true
        };
    }
    __doctorAllowedTabs = mods && Object.keys(mods).length ? new Set(Object.keys(mods).filter((k) => !!mods[k])) : null;
    document.querySelectorAll('.menu-item[data-tab]').forEach((el) => {
        const tab = el.getAttribute('data-tab');
        if (!tab) return;
        const enabled = !__doctorAllowedTabs || __doctorAllowedTabs.has(tab);
        el.classList.toggle('hidden', !enabled);
    });
    if (__doctorAllowedTabs && !__doctorAllowedTabs.has('tab-volunteer')) {
        const nav = document.getElementById('nav-volunteer');
        if (nav) nav.classList.add('hidden');
    }
}

async function loadPortalFlags() {
    try {
        const res = await fetch('/api/public/portal-flags', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok && data) window.__portalFlags = data;
    } catch (_) {}
}

const DOCTOR_TRACK_POLL_MS = 4000;
let seminarTrackPollTimer = null;
let caseTrackPollTimer = null;
let _lastSeminarTrackFingerprint = '';
let _lastCaseTrackFingerprint = '';

function doctorTabVisible(tabId) {
    const el = document.getElementById(tabId);
    return el && !el.classList.contains('hidden');
}

function isApplicationDetailModalOpen() {
    const m = document.getElementById('view-app-modal');
    if (!m || m.classList.contains('hidden')) return false;
    const disp = m.style.display;
    return disp === 'flex' || disp === 'block';
}

function shouldPollSeminarTracking() {
    return doctorTabVisible('tab-applications') || isApplicationDetailModalOpen();
}

function shouldPollCertTracking() {
    return doctorTabVisible('tab-certificate');
}

let certTrackPollTimer = null;

function stopCertTrackingPoll() {
    if (certTrackPollTimer) {
        clearInterval(certTrackPollTimer);
        certTrackPollTimer = null;
    }
}

function startCertTrackingPoll() {
    stopCertTrackingPoll();
    certTrackPollTimer = setInterval(() => {
        if (shouldPollCertTracking()) loadDoctorCertificateTracking(true);
    }, DOCTOR_TRACK_POLL_MS);
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
        if (shouldPollSeminarTracking()) loadApplications(true);
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
    if (shouldPollSeminarTracking()) startSeminarTrackingPoll();
    else stopSeminarTrackingPoll();
    if (doctorTabVisible('tab-case-track')) startCaseTrackingPoll();
    else stopCaseTrackingPoll();
}

document.addEventListener('visibilitychange', () => syncDoctorTrackingPolls());

let doctorPortalYear = new Date().getFullYear();

function formatTrackDateTime(iso) {
    if (window.PortalDateTime && window.PortalDateTime.formatLong) {
        return window.PortalDateTime.formatLong(iso);
    }
    return iso ? String(iso) : '';
}

function formatScanDateTime(iso) {
    if (window.PortalDateTime && window.PortalDateTime.formatScan) {
        return window.PortalDateTime.formatScan(iso);
    }
    return formatTrackDateTime(iso);
}

function formatEventDate(iso) {
    if (window.PortalDateTime && window.PortalDateTime.formatEvent) {
        return window.PortalDateTime.formatEvent(iso);
    }
    return formatPortalDt(iso);
}

function formatPortalDt(iso) {
    if (window.PortalDateTime && window.PortalDateTime.format) {
        return window.PortalDateTime.format(iso);
    }
    return iso ? String(iso) : '';
}

window.__doctorPaymentOptions = [];

async function loadDoctorPaymentOptions() {
    try {
        const res = await fetch('/api/payments/options', { cache: 'no-store' });
        if (!res.ok) {
            console.warn('[payments] options HTTP', res.status);
            window.__doctorPaymentOptions = [];
            return;
        }
        const data = await res.json();
        window.__doctorPaymentOptions = data.options || [];
    } catch (e) {
        console.warn('[payments] options', e);
        window.__doctorPaymentOptions = [];
    }
}

function paymentGatewaySelectHtml(regId) {
    const opts = window.__doctorPaymentOptions || [];
    if (!opts.length) {
        return (
            '<p style="margin-top:10px;font-size:0.85rem;color:#64748b;">Payment: <strong>Test mode</strong> is active for this seminar.</p>'
        );
    }
    if (opts.length === 1) {
        return (
            '<input type="hidden" id="pay-opt-' +
            regId +
            '" value="' +
            escapeHtml(opts[0].id) +
            '"><p style="margin-top:8px;font-size:0.82rem;color:#64748b;">' +
            escapeHtml(opts[0].description || opts[0].label) +
            '</p>'
        );
    }
    let h =
        '<label style="display:block;margin-top:10px;font-size:0.85rem;font-weight:600;color:#0f766e;">Choose payment method</label><select id="pay-opt-' +
        regId +
        '" onchange="updateDoctorPayMethodHint(' +
        regId +
        ')" style="width:100%;max-width:340px;padding:8px;margin:6px 0 4px;border-radius:8px;border:1px solid #cbd5e1;">';
    opts.forEach((o) => {
        h += '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(o.label) + '</option>';
    });
    h += '</select><p id="pay-opt-hint-' + regId + '" style="font-size:0.82rem;color:#64748b;margin:0 0 8px;"></p>';
    setTimeout(() => updateDoctorPayMethodHint(regId), 0);
    return h;
}

function updateDoctorPayMethodHint(regId) {
    const sel = document.getElementById('pay-opt-' + regId);
    const hint = document.getElementById('pay-opt-hint-' + regId);
    if (!sel || !hint) return;
    const o = (window.__doctorPaymentOptions || []).find((x) => x.id === sel.value);
    hint.textContent = (o && o.description) || '';
}
window.updateDoctorPayMethodHint = updateDoctorPayMethodHint;

function getPaymentOptionForReg(regId) {
    const el = document.getElementById('pay-opt-' + regId);
    if (el && el.value) return el.value;
    const opts = window.__doctorPaymentOptions || [];
    return opts[0] ? opts[0].id : '';
}
window.getPaymentOptionForReg = getPaymentOptionForReg;

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
        const cls =
            step.state === 'completed'
                ? 'completed'
                : step.state === 'active'
                  ? 'active'
                  : 'upcoming';
        const when =
            step.at && (step.state === 'completed' || step.state === 'active')
                ? '<p class="track-when" style="font-size:0.78rem;color:#0f766e;margin:4px 0 0;font-weight:600;">' +
                  escapeHtml(formatTrackDateTime(step.at)) +
                  '</p>'
                : step.state === 'pending'
                  ? '<p class="track-when" style="font-size:0.78rem;color:#94a3b8;margin:4px 0 0;">Upcoming</p>'
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

function doctorNormalizeQualOptions(options) {
    const canon = {
        'Practicing Vaidya': { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
        Practitioner: { value: 'Practitioner', label: 'Practitioner' },
        PG: { value: 'PG', label: 'PG' }
    };
    if (!Array.isArray(options) || !options.length) return Object.values(canon);
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

function registrationQualFromApp(a) {
    if (!a) return '';
    try {
        const fd = typeof a.form_data === 'string' ? JSON.parse(a.form_data) : a.form_data;
        return fd && fd.qual ? String(fd.qual).trim() : '';
    } catch (_) {
        return '';
    }
}

function renderSeminarApplicationTrackerCard(a) {
    const tl = a.timeline || {};
    const payAmt = Number(a.seminar_price) > 0 ? Number(a.seminar_price) : 1500;
    const st = String(a.status || '').toLowerCase();
    const isPaid = st === 'completed' || st === 'checked_in';
    let revisionBlock = '';
    if (st === 'revision_required' || st === 'documents_requested') {
        let reason = '';
        let requested = '';
        try {
            const dr =
                typeof a.doc_review === 'object' && a.doc_review
                    ? a.doc_review
                    : a.doc_review_json
                      ? JSON.parse(a.doc_review_json)
                      : null;
            reason = (dr && dr.rejection_reason) || '';
            if (dr && dr.requested_docs && dr.requested_docs.length) {
                requested = dr.requested_docs.join(', ');
            }
        } catch (_) {}
        revisionBlock =
            '<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:12px;margin-bottom:12px;">' +
            '<p style="margin:0 0 8px;font-weight:600;color:#9a3412;"><i class="fas fa-exclamation-triangle"></i> ' +
            (st === 'documents_requested' ? 'Additional documents requested' : 'Re-upload documents (same application no.)') +
            '</p>' +
            (reason
                ? '<p style="margin:0 0 10px;font-size:0.9rem;color:#7c2d12;">Admin note: ' + escapeHtml(reason) + '</p>'
                : '') +
            (requested
                ? '<p style="margin:0 0 10px;font-size:0.9rem;color:#7c2d12;">Requested: ' + escapeHtml(requested) + '</p>'
                : '') +
            '<button type="button" class="btn-warning" onclick="openSeminarDocumentResubmitById(' +
            Number(a.id) +
            ')">' +
            (st === 'documents_requested' ? 'Upload additional documents' : 'Re-upload certificate &amp; NCISM') +
            '</button></div>';
    }
    const payBtn =
        st === 'approved_pending_payment' && !isPaid
            ? paymentGatewaySelectHtml(a.id) +
              '<button class="btn-success" style="margin-top:10px;" onclick="processPayment(' +
              a.id +
              ', ' +
              payAmt +
              ', ' +
              JSON.stringify(String(a.application_no || '')) +
              ', getPaymentOptionForReg(' +
              a.id +
              '))">Make Payment (₹' +
              payAmt +
              ')</button>'
            : '';
    const waBlock = renderWhatsappLinkBlock(a);
    const yearBadge = a.portal_year
        ? '<span style="font-size:0.75rem;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:6px;margin-left:8px;">' +
          escapeHtml(String(a.portal_year)) +
          '</span>'
        : '';
    const qual = registrationQualFromApp(a);
    const qualBadge = qual
        ? '<p style="font-size:0.88rem;color:#475569;margin:-8px 0 12px;"><strong>Qualification:</strong> ' +
          escapeHtml(qual) +
          '</p>'
        : '';
    return (
        '<div class="card" style="margin-bottom:15px;border-top:4px solid #1a237e;">' +
        '<h4 style="color:#1a237e;margin-bottom:16px;"><i class="fas fa-calendar-check"></i> Seminar · ' +
        escapeHtml(a.application_no) +
        (a.seminar_title ? ' · ' + escapeHtml(a.seminar_title) : '') +
        yearBadge +
        '</h4>' +
        qualBadge +
        revisionBlock +
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
window.__otpOnStep1 = false;
window.__otpOnSubmit = false;
window.__regPhoneOtpToken = null;
window.__regEmailOtpToken = null;
window.__regSubmitPhoneOtpToken = null;
window.__regSubmitEmailOtpToken = null;

function closeDoctorMobileNav() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('doctor-nav-backdrop');
    sidebar?.classList.remove('mobile-open');
    if (backdrop) {
        backdrop.classList.remove('is-open');
        backdrop.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('doctor-nav-open');
}
window.closeDoctorMobileNav = closeDoctorMobileNav;

function initDoctorMobileNav() {
    const toggle = document.getElementById('doctor-menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.getElementById('doctor-nav-backdrop');
    if (!toggle || !sidebar) return;

    if (toggle.dataset.navInited === '1') return;
    toggle.dataset.navInited = '1';

    closeDoctorMobileNav();

    document.querySelectorAll('.menu-item').forEach((el) => {
        if (el.dataset.navBound === '1') return;
        const tabId = el.getAttribute('data-tab');
        const oc = el.getAttribute('onclick') || '';
        const fromOnclick = oc.match(/switchTab\('([^']+)'\)/);
        const targetTab = tabId || (fromOnclick ? fromOnclick[1] : null);
        if (!targetTab) return;
        el.dataset.navBound = '1';
        el.removeAttribute('onclick');
        el.removeAttribute('href');
        el.setAttribute('type', 'button');
        el.setAttribute('data-tab', targetTab);
        const go = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            switchTab(targetTab, el);
        };
        el.addEventListener('click', go, { passive: false });
    });

    const open = () => {
        sidebar.classList.add('mobile-open');
        if (backdrop) {
            backdrop.classList.add('is-open');
            backdrop.setAttribute('aria-hidden', 'false');
        }
        document.body.classList.add('doctor-nav-open');
    };
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (sidebar.classList.contains('mobile-open')) closeDoctorMobileNav();
        else open();
    });
    backdrop?.addEventListener('click', closeDoctorMobileNav);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar.classList.contains('mobile-open')) closeDoctorMobileNav();
    });
}

function bootDoctorDashboard(user) {
    currentUser = user;
    applyDoctorModuleAccessFromUser(currentUser);
    fetch('/api/public/portal-urls')
        .then((r) => r.json())
        .then((u) => {
            window.__doctorProductionSite = !!(u && u.production);
            window.__allowDemoAccounts = u && u.allowDemoAccounts !== false;
        })
        .catch(() => {});
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('dashboard-main').classList.remove('hidden');
    initDoctorMobileNav();
        document.getElementById('header-name').innerText = `Hi, Dr. ${currentUser.first_name || ''} ${currentUser.last_name || ''}`;
    document.getElementById('header-id').innerText =
        `ID: ${currentUser.user_id_string || '---'}` +
        (window.__allowDemoAccounts !== false && Number(currentUser.is_demo) === 1 ? ' · Dummy' : '');
    if (typeof PortalAuth !== 'undefined' && PortalAuth.renderLoginTime) {
        PortalAuth.renderLoginTime('header-login-time', currentUser);
    }
        loadProfile();
    loadDoctorPaymentOptions().then(() => {
        loadDoctorPortalYear().then(() => {
            if (!__doctorAllowedTabs || __doctorAllowedTabs.has('tab-seminars')) loadSeminarsGrid();
            if (!__doctorAllowedTabs || __doctorAllowedTabs.has('tab-applications')) loadApplications();
        });
    });
    loadDoctorDashboardStats();
    loadPortalFlags();
    loadRegistrationFormConfigAndApply();
    loadDoctorPortalUpdatesFromCms();
    loadSiteBranding();
    initDoctorVolunteerNav();
    handleEasebuzzPaymentReturnQuery();
}

function handleEasebuzzPaymentReturnQuery() {
    try {
        const p = new URLSearchParams(window.location.search);
        const payment = p.get('payment');
        if (!payment) return;
        const msg = p.get('msg');
        if (payment === 'success') {
            alert(
                msg ||
                    'Payment successful. Your e-ticket is under Participant tickets. Join the seminar WhatsApp group from My Applications when shown.'
            );
            const lastReg = sessionStorage.getItem('doctor_last_pay_reg');
            if (typeof loadApplications === 'function') {
                loadApplications().then(() => {
                    if (lastReg) showPostPaymentWhatsappBanner(lastReg);
                });
            }
            if (typeof loadDoctorDashboardStats === 'function') loadDoctorDashboardStats();
            if (typeof loadDoctorEventTickets === 'function') loadDoctorEventTickets();
        } else if (payment === 'failed') {
            alert(msg || 'Payment was not completed. You can try again from My Applications.');
        } else if (payment === 'error') {
            alert(msg || 'Payment could not be verified. Contact the seminar office if money was debited.');
        }
        const clean = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, '', clean);
    } catch (_) {}
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
            resendEmailBtnId: 'doctor-resend-otp-email',
            resendPhoneBtnId: 'doctor-resend-otp-phone',
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
    dob: 'reg-dob',
    qual: 'reg-qual',
    ncism: 'reg-ncism',
    certificate: 'reg-cert-file',
    cpin: 'reg-cpin',
    college: 'reg-college',
    ccity: 'reg-ccity',
    cstate: 'reg-cstate'
};

function registrationQualIsPg() {
    const q = String((document.getElementById('reg-qual') || {}).value || '').trim();
    return q === 'PG';
}

const REGISTRATION_COLLEGE_KEYS = new Set(['cpin', 'college', 'ccity', 'cstate']);

function registrationFieldStep(f) {
    if (REGISTRATION_COLLEGE_KEYS.has(f.key)) return 4;
    const s = f.step != null ? parseInt(f.step, 10) : 1;
    return Number.isNaN(s) ? 1 : s;
}

/** Matches server DEFAULT_REGISTRATION_FORM_CONFIG when API fields are empty. */
const DEFAULT_REGISTRATION_FALLBACK_FIELDS = [
    { key: 'fname', label: 'First name', type: 'text', step: 1, enabled: true, required: true },
    { key: 'mname', label: 'Middle name', type: 'text', step: 1, enabled: true, required: false },
    { key: 'lname', label: 'Last name', type: 'text', step: 1, enabled: true, required: true },
    { key: 'email', label: 'Email', type: 'email', step: 1, enabled: true, required: true, verifyOtp: true },
    { key: 'phone', label: 'Phone', type: 'tel', step: 1, enabled: true, required: true, verifyOtp: true },
    { key: 'dob', label: 'Date of birth', type: 'date', step: 1, enabled: true, required: true },
    { key: 'address', label: 'Address', type: 'textarea', step: 2, enabled: true, required: true },
    { key: 'pin', label: 'Pincode', type: 'text', step: 2, enabled: true, required: true },
    { key: 'city', label: 'City', type: 'select', step: 2, enabled: true, required: true },
    { key: 'state', label: 'State', type: 'select', step: 2, enabled: true, required: true },
    { key: 'country', label: 'Country', type: 'select', step: 2, enabled: true, required: true },
    {
        key: 'qual',
        label: 'Qualification',
        type: 'select',
        step: 3,
        enabled: true,
        required: true,
        options: [
            { value: 'Practicing Vaidya', label: 'Practicing Vaidya' },
            { value: 'Practitioner', label: 'Practitioner' },
            { value: 'PG', label: 'PG' }
        ]
    },
    { key: 'ncism', label: 'Medical registration / NCISM', type: 'text', step: 3, enabled: true, required: true, onlyWhenAdvancedQual: true },
    { key: 'certificate', label: 'Certificate upload', type: 'file', step: 3, enabled: true, required: true, onlyWhenAdvancedQual: true },
    { key: 'cpin', label: 'College PIN code', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'college', label: 'College name', type: 'text', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'ccity', label: 'College city', type: 'select', step: 4, enabled: true, required: true, onlyWhenPgCollege: true },
    { key: 'cstate', label: 'College state', type: 'select', step: 4, enabled: true, required: true, onlyWhenPgCollege: true }
];

function getRegistrationFieldsForValidation() {
    const fields = window.__registrationFormFields;
    if (fields && fields.length) return fields;
    return DEFAULT_REGISTRATION_FALLBACK_FIELDS;
}

function formatRegValidationError(msg) {
    if (!msg) return msg;
    if (/^All details are mandatory/i.test(msg)) return msg;
    return 'All details are mandatory. ' + msg;
}

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

function updateRegistrationDobHint() {
    const hint = document.getElementById('reg-dob-hint');
    const el = document.getElementById('reg-dob');
    if (!hint || !el) return;
    const min = window.__registrationBirthYearMin;
    const max = window.__registrationBirthYearMax;
    if (min == null && max == null) {
        hint.classList.add('hidden');
        el.removeAttribute('min');
        el.removeAttribute('max');
        return;
    }
    hint.classList.remove('hidden');
    let msg = 'Eligible birth years: ';
    if (min != null && max != null) msg += min + '–' + max;
    else if (min != null) msg += 'from ' + min;
    else msg += 'up to ' + max;
    hint.textContent = msg;
    if (min != null) el.min = min + '-01-01';
    if (max != null) el.max = max + '-12-31';
}

function validateRegistrationDobClient() {
    const el = document.getElementById('reg-dob');
    if (!el || el.closest('.form-group')?.classList.contains('hidden')) return null;
    const fields = getRegistrationFieldsForValidation();
    const dobField = fields.find((f) => f.key === 'dob');
    if (!dobField || dobField.enabled === false) return null;
    const v = String(el.value || '').trim();
    if (dobField.required && !v) return 'Date of birth is required.';
    if (!v) return null;
    const y = parseInt(v.slice(0, 4), 10);
    const min = window.__registrationBirthYearMin;
    const max = window.__registrationBirthYearMax;
    if (min != null && y < min) return 'Date of birth is too early for this seminar (minimum year ' + min + ').';
    if (max != null && y > max) return 'Date of birth is too late for this seminar (maximum year ' + max + ').';
    return null;
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
    if (fieldKey === 'email') {
        if (typeof validateEmailClient !== 'function') return raw.toLowerCase();
        const ev = validateEmailClient(raw, 'Email');
        return ev.valid ? ev.cleanedEmail : '';
    }
    if (typeof validatePhoneClient !== 'function') {
        const digits = raw.replace(/\D/g, '');
        return digits.length >= 10 ? digits.slice(-10) : digits;
    }
    const pv = validatePhoneClient(raw, 'Phone');
    return pv.valid ? pv.cleanedPhone : '';
}

async function sendRegistrationOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const raw =
        fieldKey === 'email'
            ? String((document.getElementById('reg-email') || {}).value || '').trim()
            : String((document.getElementById('reg-phone') || {}).value || '').trim();
    const destCheck =
        typeof validateOtpDestinationClient === 'function'
            ? validateOtpDestinationClient(channel, raw, fieldKey === 'email' ? 'Email' : 'Phone')
            : { valid: !!raw };
    if (!destCheck.valid) return alert(destCheck.message);
    const dest = registrationOtpDestination(fieldKey);
    if (!dest) return alert(channel === 'email' ? 'Enter your email first.' : 'Enter your phone first.');
    const purpose = window.__otpOnStep1 ? 'registration' : 'registration_field';
    const body = { channel, destination: dest, purpose, seminarId: sid };
    if (!window.__otpOnStep1) body.fieldKey = fieldKey;
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
                : 'Sent ✓';
        }
        if (data.debugCode) console.info('OTP debug:', data.debugCode);
        if (window.OtpUi) window.OtpUi.notifyOtpSent(channel, data);
        else alert('OTP sent successfully to your ' + (channel === 'email' ? 'email' : 'WhatsApp') + '.');
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
    const purpose = window.__otpOnStep1 ? 'registration' : 'registration_field';
    const body = { channel, destination: dest, purpose, code, seminarId: sid };
    if (!window.__otpOnStep1) body.fieldKey = fieldKey;
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
            statusEl.textContent =
                data.demoBypass && window.__allowDemoAccounts !== false ? 'Verified ✓ (dummy)' : 'Verified ✓';
        }
    } catch (e) {
        console.error(e);
        alert('Network error verifying code.');
    }
}

function resetRegistrationSubmitOtpState() {
    window.__regSubmitPhoneOtpToken = null;
    window.__regSubmitEmailOtpToken = null;
    ['reg-submit-otp-code-email', 'reg-submit-otp-code-phone'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['reg-submit-otp-status-email', 'reg-submit-otp-status-phone', 'reg-submit-otp-email-ok', 'reg-submit-otp-phone-ok'].forEach(
        (id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '';
        }
    );
}

async function sendRegistrationSubmitOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const raw =
        fieldKey === 'email'
            ? String((document.getElementById('reg-email') || {}).value || '').trim()
            : String((document.getElementById('reg-phone') || {}).value || '').trim();
    if (typeof validateOtpDestinationClient === 'function') {
        const destCheck = validateOtpDestinationClient(channel, raw, fieldKey === 'email' ? 'Email' : 'Phone');
        if (!destCheck.valid) return alert(destCheck.message);
    }
    const dest = registrationOtpDestination(fieldKey);
    if (!dest) return alert(channel === 'email' ? 'Enter your email first.' : 'Enter your phone first.');
    const body = { channel, destination: dest, purpose: 'registration_submit', seminarId: sid };
    const statusEl = document.getElementById(
        fieldKey === 'email' ? 'reg-submit-otp-status-email' : 'reg-submit-otp-status-phone'
    );
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
                : 'Sent ✓';
        }
        if (data.debugCode) console.info('Submit OTP debug:', data.debugCode);
        if (window.OtpUi) {
            window.OtpUi.notifyOtpSent(channel, data, {
                customMessage:
                    'OTP sent successfully. Check your ' +
                    (channel === 'email' ? 'email' : 'WhatsApp') +
                    ' before submitting your application.'
            });
        } else {
            alert('OTP sent successfully. Check your ' + (channel === 'email' ? 'email' : 'WhatsApp') + '.');
        }
    } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = '';
        alert('Network error sending code.');
    }
}

async function verifyRegistrationSubmitOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const dest = registrationOtpDestination(fieldKey);
    const codeEl = document.getElementById(
        fieldKey === 'email' ? 'reg-submit-otp-code-email' : 'reg-submit-otp-code-phone'
    );
    const code = String((codeEl || {}).value || '').trim();
    if (!dest || !code) return alert('Enter the code you received.');
    const body = { channel, destination: dest, purpose: 'registration_submit', code, seminarId: sid };
    const uid = doctorNumericUserId();
    if (uid) body.userId = uid;
    const statusEl = document.getElementById(
        fieldKey === 'email' ? 'reg-submit-otp-status-email' : 'reg-submit-otp-status-phone'
    );
    const okEl = document.getElementById(fieldKey === 'email' ? 'reg-submit-otp-email-ok' : 'reg-submit-otp-phone-ok');
    try {
        const res = await fetch('/api/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
            if (statusEl) statusEl.textContent = '';
            return alert((data.error || 'Invalid code.') + '\n\nUse Resend if the code expired.');
        }
        if (fieldKey === 'email') window.__regSubmitEmailOtpToken = data.token;
        else window.__regSubmitPhoneOtpToken = data.token;
        if (statusEl) statusEl.textContent = '';
        if (okEl) okEl.textContent = 'Verified ✓';
    } catch (e) {
        console.error(e);
        alert('Network error verifying code.');
    }
}

function validateRegistrationAgainstConfigForSteps(upToStepInclusive) {
    const fields = getRegistrationFieldsForValidation();
    const fd = collectRegistrationFormData();
    const hasCert =
        (document.getElementById('reg-cert-file') || {}).files &&
        document.getElementById('reg-cert-file').files.length > 0;
    const adv = needsAdvancedQualDoctor();

    for (let sn = 1; sn <= upToStepInclusive; sn++) {
        for (const f of fields) {
            if (!f.enabled) continue;
            if (f.key === 'agree_terms') continue;
            const fStep = registrationFieldStep(f);
            if (fStep !== sn) continue;
            if (f.onlyWhenAdvancedQual && !adv) continue;
            if ((f.onlyWhenPgCollege || REGISTRATION_COLLEGE_KEYS.has(f.key)) && !registrationQualIsPg()) continue;
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
                if (f.required !== false && !hasCert) return `Please upload: ${f.label || 'Certificate'}`;
                continue;
            }
            if (f.key === 'dob') {
                const de = validateRegistrationDobClient();
                if (de) return de;
                continue;
            }
            if (f.required === false) continue;
            const v = fd[f.key];
            if (v === undefined || v === null || String(v).trim() === '') {
                return `Please complete: ${f.label || f.key}`;
            }
            if (f.key === 'email' || (f.type || '').toLowerCase() === 'email') {
                if (typeof validateEmailClient === 'function') {
                    const ev = validateEmailClient(v, f.label || 'Email');
                    if (!ev.valid) return ev.message;
                }
            }
            if (f.key === 'phone' || f.key === 'whatsapp' || (f.type || '').toLowerCase() === 'tel') {
                if (typeof validatePhoneClient === 'function') {
                    const pv = validatePhoneClient(
                        v,
                        f.label || (f.key === 'whatsapp' ? 'WhatsApp' : 'Phone'),
                        { required: f.required !== false }
                    );
                    if (!pv.valid) return pv.message;
                }
            }
            const t = (f.type || 'text').toLowerCase();
            if (t === 'select' && Array.isArray(f.options)) {
                const ok = f.options.some((o) => String(o.value != null ? o.value : o.label) === String(v));
                if (!ok) return `Invalid choice for: ${f.label || f.key}`;
            }
        }
        for (const f of fields) {
            if (!f.verifyOtp || !f.enabled || f.required === false) continue;
            const fStep = f.step != null ? parseInt(f.step, 10) : 1;
            if (Number.isNaN(fStep) || fStep !== sn) continue;
            if (f.type !== 'email' && f.type !== 'tel') continue;
            if (f.key === 'email' || f.key === 'phone') {
                if (f.key === 'email' && window.__otpOnApplication && !window.__otpRequiresEmail && !window.__emailConfigured) {
                    continue;
                }
                if (f.key === 'phone' && window.__otpOnApplication && !window.__otpRequiresPhone && !window.__whatsappConfigured) {
                    continue;
                }
                if (f.key === 'email' && !window.__emailConfigured && !window.__otpOnApplication) continue;
                if (f.key === 'phone' && !window.__whatsappConfigured && !window.__otpOnApplication) continue;
                const ok = f.key === 'phone' ? registrationPhoneVerified() : registrationEmailVerified();
                if (!ok) return `Please verify OTP for: ${f.label || f.key}`;
                continue;
            }
            const tok = (window.__fieldOtpTokens || {})[f.key];
            if (!tok) return `Please verify OTP for: ${f.label || f.key}`;
        }
        if (sn === 1 && window.__otpOnStep1) {
            const needE = window.__otpRequiresEmail !== false;
            const needP = !!window.__otpRequiresPhone;
            if (needE && !registrationEmailVerified()) {
                return 'Please verify your email with the code sent to your inbox before continuing.';
            }
            if (needP && !registrationPhoneVerified()) {
                return 'Please verify your phone with the WhatsApp code before continuing.';
            }
        }
        if (sn === 1 && typeof validateRegistrationNamesClient === 'function') {
            const nameErr = validateRegistrationNamesClient(fd);
            if (nameErr) return nameErr;
        }
    }
    return null;
}

function alertRegistrationValidation(err) {
    if (err) alert(formatRegValidationError(err));
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
        window.__registrationBirthYearMin = data.birthYearMin != null ? data.birthYearMin : null;
        window.__registrationBirthYearMax = data.birthYearMax != null ? data.birthYearMax : null;
        updateRegistrationDobHint();
        window.__otpOnApplication = !!data.otpOnApplication;
        window.__otpOnStep1 = !!data.otpOnStep1;
        window.__otpOnSubmit = !!data.otpOnSubmit;
        window.__submitOtpRequired = !!data.submitOtpRequired;
        window.__otpRequiresEmail = !!data.otpRequiresEmail;
        window.__otpRequiresPhone = !!data.otpRequiresPhone;
        window.__emailConfigured = !!data.emailConfigured;
        window.__whatsappConfigured = !!data.whatsappConfigured;
        syncRegistrationOtpUi();
    } catch (e) {
        console.error(e);
        window.__registrationFormFields = [];
        window.__otpOnApplication = false;
        window.__otpOnStep1 = false;
        window.__otpOnSubmit = false;
        window.__submitOtpRequired = false;
        window.__otpRequiresEmail = false;
        window.__otpRequiresPhone = false;
        const otpPanel = document.getElementById('reg-seminar-otp-panel');
        if (otpPanel) otpPanel.classList.add('hidden');
    }
    const fields = window.__registrationFormFields;
    const qualField = (fields || []).find((f) => f.key === 'qual');
    const qualEl = document.getElementById('reg-qual');
    if (qualField && qualField.type === 'select' && Array.isArray(qualField.options) && qualEl) {
        const cur = qualEl.value;
        qualEl.innerHTML = '<option value="">Select</option>';
        doctorNormalizeQualOptions(qualField.options).forEach((o) => {
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
            const pgOk = !(f.onlyWhenPgCollege || REGISTRATION_COLLEGE_KEYS.has(f.key)) || registrationQualIsPg();
            el.required = !!(
                f.enabled &&
                f.required &&
                pgOk &&
                (!f.onlyWhenAdvancedQual || needsAdvancedQualDoctor())
            );
        }
    });
    refreshRegistrationRequiredAttributes();
    toggleCollegeStep();
    await initRegistrationAddressUi();
}

function syncRegistrationOtpUi() {
    const otpPanel = document.getElementById('reg-seminar-otp-panel');
    const hint = document.getElementById('reg-otp-panel-hint');
    if (otpPanel) {
        if (window.__otpOnApplication) otpPanel.classList.remove('hidden');
        else otpPanel.classList.add('hidden');
    }
    if (hint) {
        let parts = [];
        if (window.__otpOnStep1) parts.push('personal details (step 1)');
        if (window.__otpOnSubmit) parts.push('preview before submit');
        hint.textContent = parts.length
            ? 'Verify email and/or WhatsApp on: ' + parts.join(' and ') + '.'
            : 'OTP is disabled for this seminar.';
    }
    const submitPanel = document.getElementById('reg-submit-otp-panel');
    if (submitPanel) {
        if (window.__otpOnSubmit) submitPanel.classList.remove('hidden');
        else submitPanel.classList.add('hidden');
    }
    const subER = document.getElementById('reg-submit-otp-email-row');
    const subPR = document.getElementById('reg-submit-otp-phone-row');
    if (subER) subER.style.display = window.__otpOnSubmit && window.__emailConfigured ? '' : 'none';
    if (subPR) subPR.style.display = window.__otpOnSubmit && window.__whatsappConfigured ? '' : 'none';
    const emailOtpRow = document.getElementById('reg-otp-email-row');
    const phoneOtpRow = document.getElementById('reg-otp-phone-row');
    if (emailOtpRow) {
        emailOtpRow.style.display = window.__otpOnStep1 ? '' : 'none';
        if (window.__otpOnStep1 && !window.__emailConfigured) {
            const st = document.getElementById('reg-otp-status-email');
            if (st) st.textContent = 'Email OTP unavailable — configure SMTP in admin integrations.';
        }
    }
    if (phoneOtpRow) {
        phoneOtpRow.style.display = window.__otpOnStep1 && window.__whatsappConfigured ? '' : 'none';
        if (window.__otpOnStep1 && !window.__whatsappConfigured) {
            const st = document.getElementById('reg-otp-status-phone');
            if (st) st.textContent = 'WhatsApp OTP unavailable — configure WhatsApp in admin integrations.';
        }
    }
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
        if ((f.onlyWhenPgCollege || REGISTRATION_COLLEGE_KEYS.has(f.key)) && !registrationQualIsPg()) {
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
    const parseMs =
        window.PortalDateTime && window.PortalDateTime.parseMs
            ? (v) => window.PortalDateTime.parseMs(v)
            : (v) => (v ? new Date(v).getTime() : null);
    const rs = parseMs(seminar.registration_start);
    const re = parseMs(seminar.registration_end);
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

function hasRegistrationOverrideForSeminar(seminarId) {
    const set = window.__registrationOverrideSeminarIds;
    return !!(set && set.has(Number(seminarId)));
}

/** Honors per-user admin override when public registration has closed. */
function effectiveRegistrationWindowState(seminar) {
    const w = registrationWindowState(seminar);
    if (w.state === 'closed' && seminar && hasRegistrationOverrideForSeminar(seminar.id)) {
        return { state: 'open', viaOverride: true };
    }
    return w;
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
                const rs =
                    window.PortalDateTime && window.PortalDateTime.parseMs
                        ? window.PortalDateTime.parseMs(s.registration_start)
                        : s.registration_start
                          ? new Date(s.registration_start).getTime()
                          : null;
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

function renderSeminarGridCard(s, readOnlyPast, alreadyRegistered) {
    const win = effectiveRegistrationWindowState(s);
    const regStartLabel = s.registration_start
        ? formatTrackDateTime(s.registration_start)
        : '';
    const regEndLabel = s.registration_end ? formatTrackDateTime(s.registration_end) : '';
    const eventLabel = s.event_date ? formatEventDate(s.event_date) : '—';
    let actionBlock = '';
    if (alreadyRegistered) {
        actionBlock =
            '<p style="font-size:0.85rem;color:#15803d;margin-bottom:12px;"><i class="fas fa-check-circle"></i> You already have an application for this seminar.</p>' +
            '<button type="button" class="btn-primary" style="width:100%;opacity:0.7;" onclick="switchTab(\'tab-applications\')">View my application</button>';
    } else if (readOnlyPast) {
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
        const overrideNote = win.viaOverride
            ? '<p style="font-size:0.85rem;color:#0f766e;margin-bottom:10px;"><i class="fas fa-user-check"></i> You have admin approval to register for this seminar after the public window closed.</p>'
            : '';
        actionBlock =
            overrideNote +
            (regEndLabel && !win.viaOverride
                ? '<p style="font-size:0.8rem;color:#64748b;margin-bottom:10px;">Closes ' + escapeHtml(regEndLabel) + '</p>'
                : win.viaOverride
                  ? '<p style="font-size:0.8rem;color:#64748b;margin-bottom:10px;">Public registration closed — your account is exempt.</p>'
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
        if (payload.portalYear != null) {
            doctorPortalYear = payload.portalYear;
            const lbl = document.getElementById('doctor-portal-year-label');
            if (lbl) lbl.textContent = String(doctorPortalYear);
        }
        activeSeminars = payload.seminars || [];
        const registeredSeminarIds = new Set();
        const uid = doctorNumericUserId();
        if (uid) {
            try {
                const appRes = await fetch('/api/applications/' + encodeURIComponent(uid), { cache: 'no-store' });
                const appPayload = await appRes.json();
                const apps = Array.isArray(appPayload) ? appPayload : appPayload.applications || [];
                apps.forEach((a) => {
                    if (a && a.seminar_id != null) registeredSeminarIds.add(Number(a.seminar_id));
                });
            } catch (appErr) {
                console.warn('Could not load applications for seminar grid', appErr);
            }
        }
        window.__userRegisteredSeminarIds = registeredSeminarIds;
        window.__registrationOverrideSeminarIds = new Set();
        if (uid) {
            try {
                const ovRes = await fetch('/api/doctor/registration-overrides/' + encodeURIComponent(uid), {
                    cache: 'no-store'
                });
                if (ovRes.ok) {
                    const ovData = await ovRes.json();
                    (ovData.seminarIds || []).forEach((id) => {
                        const n = Number(id);
                        if (n > 0) window.__registrationOverrideSeminarIds.add(n);
                    });
                }
            } catch (ovErr) {
                console.warn('Could not load registration overrides', ovErr);
            }
        }
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
            const alreadyRegistered = registeredSeminarIds.has(Number(s.id));
            container.insertAdjacentHTML('beforeend', renderSeminarGridCard(s, false, alreadyRegistered));
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

function generateClientApplicationNo() {
    let id = '';
    for (let i = 0; i < 12; i++) id += Math.floor(Math.random() * 10).toString();
    return id;
}

function ensureDraftApplicationNo() {
    if (!window.__draftApplicationNo) {
        window.__draftApplicationNo = generateClientApplicationNo();
    }
    return window.__draftApplicationNo;
}
window.__seminarTermsText = '';

function proceedFromSeminarTnc() {
    if (!document.getElementById('reg-tnc-accept')?.checked) {
        alert('Please accept the Terms and Conditions to continue.');
        return;
    }
    nextStep(1);
}

async function startRegistration(seminarId, opts) {
    opts = opts || {};
    const volunteerBypass = !!opts.volunteerBypass;
    const s = activeSeminars.find((x) => Number(x.id) === Number(seminarId));
    const seminarTitle = s && s.title ? s.title : 'Seminar';
    const regSet = window.__userRegisteredSeminarIds;
    if (regSet && regSet.has(Number(seminarId))) {
        alert('You have already registered for this seminar. Track your application under Track seminar applications.');
        switchTab('tab-applications');
        return;
    }
    if (!volunteerBypass && s && effectiveRegistrationWindowState(s).state !== 'open') {
        if (registrationWindowState(s).state === 'upcoming') {
            alert('Registration has not opened yet for this seminar. Please wait until the countdown reaches zero.');
        } else {
            alert('Registration for this seminar has closed.');
        }
        return;
    }
    activeSeminarIdForReg = seminarId;
    const termsRaw = s && s.terms_conditions && String(s.terms_conditions).trim();
    window.__seminarTermsText = termsRaw || '';
    window.__seminarCancellationSummary = s ? summaryCancellationPolicy(s.cancellation_policy_json) : '';
    window.__fieldOtpTokens = {};
    window.__regPhoneOtpToken = null;
    window.__regEmailOtpToken = null;
    window.__regSubmitPhoneOtpToken = null;
    window.__regSubmitEmailOtpToken = null;
    resetRegistrationSubmitOtpState();
    window.__draftApplicationNo = null;
    document.getElementById('registration-seminar-name').innerText = `Registering for: ${seminarTitle}`;
    document.getElementById('seminars-grid-container').classList.add('hidden');
    document.getElementById('seminars-title').classList.add('hidden');
    document.getElementById('multi-step-form').classList.remove('hidden');
    const tncEl = document.getElementById('reg-tnc-text');
    const cancelEl = document.getElementById('reg-cancel-policy-text');
    const cancelWrap = document.getElementById('reg-cancel-policy-wrap');
    const step0 = document.getElementById('step-0');
    const ind0 = document.getElementById('ind-step-0');
    const hasTerms = !!termsRaw;
    if (tncEl) {
        tncEl.textContent = hasTerms
            ? window.__seminarTermsText
            : 'No separate terms document for this seminar. Please review the cancellation policy below (if any) and continue.';
    }
    if (cancelWrap && cancelEl) {
        if (window.__seminarCancellationSummary) {
            cancelWrap.classList.remove('hidden');
            cancelEl.textContent = window.__seminarCancellationSummary;
        } else {
            cancelWrap.classList.add('hidden');
            cancelEl.textContent = '';
        }
    }
    const tncAcc = document.getElementById('reg-tnc-accept');
    if (tncAcc) tncAcc.checked = false;
    if (step0) step0.classList.toggle('hidden', !hasTerms && !window.__seminarCancellationSummary);
    if (ind0) ind0.style.display = hasTerms || window.__seminarCancellationSummary ? '' : 'none';
    await loadRegistrationFormConfigAndApply(seminarId);
    const emailEl = document.getElementById('reg-email');
    const phoneEl = document.getElementById('reg-phone');
    if (emailEl && currentUser && currentUser.email) emailEl.value = currentUser.email;
    if (phoneEl && currentUser && currentUser.phone) phoneEl.value = currentUser.phone;

    nextStep(hasTerms || window.__seminarCancellationSummary ? 0 : 1);
}

/** Assigned volunteers may need to register after the public window closes; server still enforces rules on submit. */
async function startRegistrationVolunteerFlow(seminarId) {
    const sid = Number(seminarId);
    if (!Number.isFinite(sid) || sid <= 0) return;
    if (!activeSeminars.some((x) => Number(x.id) === sid)) {
        alert(
            'This seminar is not in your current list. Open Seminars from the menu to refresh, or contact the organiser if it still does not appear.'
        );
        return;
    }
    switchTab('tab-seminars');
    await startRegistration(sid, { volunteerBypass: true });
}

function cancelRegistration() {
    activeSeminarIdForReg = null;
    window.__draftApplicationNo = null;
    window.__fieldOtpTokens = {};
    window.__regPhoneOtpToken = null;
    window.__regEmailOtpToken = null;
    window.__regSubmitPhoneOtpToken = null;
    window.__regSubmitEmailOtpToken = null;
    resetRegistrationSubmitOtpState();
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

function switchTab(tabId, menuEl) {
    if (!tabId) return;
    if (__doctorAllowedTabs && !__doctorAllowedTabs.has(tabId)) {
        alert('This section is disabled for your account. Please contact admin if you need access.');
        return;
    }
    const pane = document.getElementById(tabId);
    if (!pane) {
        console.warn('[doctor] Unknown tab:', tabId);
        return;
    }
    if (typeof closeDoctorMobileNav === 'function') closeDoctorMobileNav();
    document.querySelectorAll('.tab-pane').forEach((t) => t.classList.add('hidden'));
    document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('active'));
    pane.classList.remove('hidden');
    if (menuEl) {
        menuEl.classList.add('active');
    } else if (typeof event !== 'undefined' && event && event.currentTarget) {
    event.currentTarget.classList.add('active');
    } else {
        document.querySelectorAll('.menu-item').forEach((m) => {
            const t = m.getAttribute('data-tab');
            const oc = m.getAttribute('onclick') || '';
            if (t === tabId || oc.indexOf(tabId) !== -1) m.classList.add('active');
        });
    }
    const content = document.querySelector('.content-area');
    if (content) content.scrollTop = 0;
    if (tabId === 'tab-dashboard') {
        loadDoctorDashboardStats();
    }
    if (tabId !== 'tab-certificate') {
        stopCertTrackingPoll();
    }
    if (tabId === 'tab-feedback') {
        loadDashboardFeedbackForm();
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
    if (tabId === 'tab-payments') {
        loadDoctorSupplementalPayments();
    }
    if (tabId === 'tab-ticket') {
        loadDoctorEventTickets();
    }
    if (tabId === 'tab-certificate') {
        loadDoctorCertificateTracking();
        loadDoctorCertificates();
        startCertTrackingPoll();
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
    if (tabId === 'tab-seminars') {
        loadSeminarsGrid();
    }
    syncDoctorTrackingPolls();
}
window.switchTab = switchTab;
window.startRegistrationVolunteerFlow = startRegistrationVolunteerFlow;

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
        ensureCaseUploadConfig(program.id).then((cfg) => {
            const maxMb = effectiveCaseMaxMb(program, cfg);
            const lab = fileFg.querySelector('label');
            if (lab) {
                lab.textContent =
                    'Upload (max ' +
                    maxF +
                    ' files, ' +
                    maxMb +
                    ' MB each)' +
                    (cfg && cfg.r2Enabled ? ' — secure cloud storage' : '') +
                    ' *';
            }
            const hint = document.getElementById('case-files-hint');
            if (hint && cfg && cfg.r2Enabled) {
                hint.textContent =
                    'Large PDF/PPT/video supported (up to ' +
                    maxMb +
                    ' MB each). Upload shows progress; use Wi‑Fi for big files.';
            }
        });
    }
    const note = document.getElementById('case-program-limits-note');
    if (note && program) {
        let parts = [];
        if (program.instructions) parts.push(program.instructions);
        if (program.maxPresentationsPerUser)
            parts.push('Up to ' + program.maxPresentationsPerUser + ' presentation(s) per doctor in this program.');
        if (program.showSeatsPublic !== false && program.slotsRemaining != null)
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
        const res = await fetch('/api/case/programs', { cache: 'no-store' });
        let programs = [];
        try {
            programs = await res.json();
        } catch (parseErr) {
            console.error(parseErr);
        }
        if (!res.ok) {
            const errMsg = (programs && programs.error) || 'Could not load case programs (HTTP ' + res.status + ').';
            grid.innerHTML = '<p style="color:#b91c1c;">' + escapeHtml(errMsg) + '</p>';
            return;
        }
        activeCasePrograms = Array.isArray(programs) ? programs : [];
        if (!activeCasePrograms.length) {
            grid.innerHTML =
                '<p style="color:#64748b;">No case presentation programs are available at this time.</p>';
            return;
        }
        grid.innerHTML = '';
        activeCasePrograms.forEach((p) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.padding = '16px';
            const win = p.windowState || 'open';
            const regLine =
                p.registration_start || p.registration_end
                    ? `<p style="font-size:0.8rem;color:#64748b;margin-top:6px;">Applications: ${escapeHtml(
                          p.registration_start ? formatTrackDateTime(p.registration_start) : '-'
                      )} to ${escapeHtml(p.registration_end ? formatTrackDateTime(p.registration_end) : '-')}</p>`
                    : '';
            let btn = '';
            if (win === 'open') {
                btn = `<button type="button" class="btn-primary" style="margin-top:10px;" onclick="startCaseApplication(${p.id})">Apply now</button>`;
            } else if (win === 'upcoming') {
                btn =
                    '<p style="color:#b45309;margin-top:10px;font-size:0.88rem;">Applications not open yet</p>' +
                    '<button type="button" class="btn-primary" style="margin-top:8px;opacity:0.55;" disabled>Not open</button>';
            } else {
                btn = '<p style="color:#94a3b8;margin-top:10px;font-size:0.88rem;">Applications closed for this program</p>';
            }
            const slots =
                p.showSeatsPublic !== false && p.slotsRemaining != null
                    ? `<p style="font-size:0.82rem;margin-top:6px;color:#0f766e;">${p.slotsRemaining} slot(s) left</p>`
                    : '';
            card.innerHTML = `<h4 style="margin:0 0 6px;">${escapeHtml(p.title)}</h4>
                <p style="font-size:0.85rem;color:#64748b;margin:0;">${escapeHtml(p.description || '')}</p>
                ${p.seminar_title ? `<p style="font-size:0.82rem;margin-top:6px;">Linked seminar: ${escapeHtml(p.seminar_title)}</p>` : ''}
                ${regLine}
                <p style="font-size:0.78rem;margin-top:6px;color:${win === 'open' ? '#059669' : '#64748b'};">Status: ${escapeHtml(win === 'open' ? 'Open for applications' : win === 'upcoming' ? 'Opening soon' : 'Closed')}</p>
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
    window.__caseStagedUploadIds = null;
    window.__caseStagedFileMeta = [];
    const stepForm = document.getElementById('case-step-form');
    const stepPrev = document.getElementById('case-step-preview');
    if (stepForm) stepForm.classList.remove('hidden');
    if (stepPrev) stepPrev.classList.add('hidden');
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
            const st = String(v.status || '').toLowerCase();
            const sid = Number(v.seminar_id);
            const pending = st === 'pending';
            const cta =
                pending && Number.isFinite(sid) && sid > 0
                    ? '<p style="margin-top:10px;"><button type="button" class="btn-primary" onclick="void window.startRegistrationVolunteerFlow(' +
                      sid +
                      ')">Complete seminar registration (required)</button></p><p style="font-size:0.82rem;color:#64748b;margin-top:6px;">You are assigned as a volunteer for this seminar. Complete registration here first. Your free e-ticket (₹0) and email/WhatsApp messages are sent automatically after you submit — no payment step.</p>'
                    : '';
            const ticket = v.volunteer_ticket_id_string
                ? '<p>Volunteer ticket: <code>' + escapeHtml(v.volunteer_ticket_id_string) + '</code> (₹0)</p>'
                : '<p style="color:#64748b;">Free e-ticket is issued automatically after you submit seminar registration.</p>';
            const certNote =
                '<p style="font-size:0.88rem;color:#64748b;margin-top:8px;">After your ticket is issued: Participation and Volunteer certificates appear in the Certificates tab. Venue QR scan updates both.</p>';
            const dutiesLine = v.duties
                ? '<p style="font-size:0.88rem;margin-top:6px;"><strong>Duties:</strong> ' + escapeHtml(v.duties) + '</p>'
                : '';
            card.innerHTML =
                '<h4 style="margin:0 0 8px;">' +
                escapeHtml(v.title || 'Seminar') +
                '</h4><p>Status: <strong>' +
                escapeHtml(v.status) +
                '</strong></p>' +
                dutiesLine +
                ticket +
                cta +
                certNote;
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
    if (typeof validateEmailClient === 'function' && String(form.email || '').trim()) {
        const ev = validateEmailClient(form.email, 'Email');
        if (!ev.valid) return alert(ev.message);
        form.email = ev.cleanedEmail;
    }
    if (typeof validatePhoneClient === 'function' && String(form.phone || '').trim()) {
        const pv = validatePhoneClient(form.phone, 'Phone');
        if (!pv.valid) return alert(pv.message);
        form.phone = pv.cleanedPhone;
    }
    if (typeof validatePhoneClient === 'function' && String(form.whatsapp || '').trim()) {
        const wv = validatePhoneClient(form.whatsapp, 'WhatsApp');
        if (!wv.valid) return alert(wv.message);
        form.whatsapp = wv.cleanedPhone;
    }
    const fileInput = document.getElementById('case-files');
    const maxFiles = (activeCaseProgram && activeCaseProgram.maxFilesPerSubmission) || 5;
    const uploadCfg = await ensureCaseUploadConfig(activeCaseProgramId);
    const maxMb = effectiveCaseMaxMb(activeCaseProgram, uploadCfg);
    const useR2 = uploadCfg && CaseR2Upload.isEnabled(uploadCfg) && fileInput?.files?.length;
    const filesField = (activeCaseProgram && activeCaseProgram.formConfig && activeCaseProgram.formConfig.fields || []).find(
        (f) => f.key === 'files'
    );
    const filesRequired = !filesField || filesField.enabled === false ? false : filesField.required !== false;
    if (filesRequired && !fileInput?.files?.length && !(window.__caseStagedUploadIds && window.__caseStagedUploadIds.length)) {
        return alert('Select at least one file');
    }
    if (fileInput?.files?.length > maxFiles) return alert('Maximum ' + maxFiles + ' files');

    const progressEl = document.getElementById('case-upload-progress');
    const setProgress = (msg) => {
        if (progressEl) {
            progressEl.style.display = msg ? 'block' : 'none';
            progressEl.textContent = msg || '';
        }
    };

    let uploadedFileIds =
        window.__caseStagedUploadIds && window.__caseStagedUploadIds.length
            ? window.__caseStagedUploadIds.slice()
            : [];
    if (!uploadedFileIds.length && fileInput?.files?.length) {
        for (let i = 0; i < fileInput.files.length; i++) {
            const raw = fileInput.files[i];
            if (raw.size > maxMb * 1024 * 1024) {
                return alert(
                    'Each file must be under ' +
                        maxMb +
                        ' MB ("' +
                        raw.name +
                        '" is ' +
                        (CaseR2Upload ? CaseR2Upload.formatBytes(raw.size) : Math.ceil(raw.size / 1048576) + ' MB') +
                        ').'
                );
            }
        }
        if (useR2) {
            try {
                setProgress('Uploading files to secure storage… 0%');
                uploadedFileIds = await CaseR2Upload.uploadFiles(fileInput.files, {
                    userId: uid,
                    caseProgramId: activeCaseProgramId,
                    onFileProgress: (idx, total, name, pct) => {
                        setProgress(
                            'Uploading ' +
                                (idx + 1) +
                                '/' +
                                total +
                                ': ' +
                                name +
                                ' - ' +
                                pct +
                                '%'
                        );
                    }
                });
                updateCaseFilesSuccessUi(
                    'All ' +
                        uploadedFileIds.length +
                        ' file(s) uploaded successfully to secure storage. Submitting application…'
                );
            } catch (upErr) {
                setProgress('');
                updateCaseFilesSuccessUi('');
                return alert(upErr.message || 'File upload failed');
            }
            setProgress('');
        } else {
            const preparedFiles = [];
            for (let i = 0; i < fileInput.files.length; i++) {
                const ready = await prepareUploadFileOrAlert(fileInput.files[i]);
                if (!ready) return;
                preparedFiles.push(ready);
            }
            const fdLegacy = new FormData();
            fdLegacy.append('userId', String(uid));
            fdLegacy.append('caseProgramId', String(activeCaseProgramId));
            fdLegacy.append('formData', JSON.stringify(form));
            preparedFiles.forEach((f) => fdLegacy.append('files', f));
            try {
                const res = await fetch('/api/case/submit', { method: 'POST', body: fdLegacy });
                const text = await res.text();
                let data = {};
                try {
                    data = text ? JSON.parse(text) : {};
                } catch (_) {
                    return alert('Server error (' + res.status + ').');
                }
                if (data.success) {
                    updateCaseFilesSuccessUi(
                        'Application submitted successfully. ID: ' + (data.applicationNo || data.submissionId)
                    );
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
            return;
        }
    }

    const fd = new FormData();
    fd.append('userId', String(uid));
    fd.append('caseProgramId', String(activeCaseProgramId));
    fd.append('formData', JSON.stringify(form));
    if (uploadedFileIds.length) {
        fd.append('uploadedFileIds', JSON.stringify(uploadedFileIds));
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
            updateCaseFilesSuccessUi('Case presentation submitted successfully.');
            alert(
                'Application submitted. Your application ID is ' +
                    (data.applicationNo || data.submissionId) +
                    '. Track status under Track case applications.'
            );
            cancelCaseApplication();
            loadCaseApplicationsTracker();
            switchTab('tab-case-track');
        } else {
            updateCaseFilesSuccessUi('');
            alert(data.error || 'Submit failed');
        }
    } catch (e) {
        console.error(e);
        updateCaseFilesSuccessUi('');
        alert('Network error: ' + (e.message || 'Could not reach server'));
    }
}

function caseApplicationStatusLabel(st) {
    const s = String(st || 'submitted').toLowerCase();
    if (s === 'revision_required') return 'Re-upload documents required';
    if (s === 'documents_requested') return 'Additional documents requested';
    if (s === 'priority_invited') return 'Complete application (priority)';
    if (s === 'judging') return 'Judges scoring';
    if (s === 'judged') return 'Judged — awaiting final result';
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
        let payload = {};
        try {
            payload = await res.json();
        } catch (_) {
            payload = {};
        }
        if (!res.ok) {
            const errMsg = payload.error || 'Could not load case applications (HTTP ' + res.status + ').';
            box.innerHTML = '<p style="color:#b91c1c;">' + escapeHtml(errMsg) + '</p>';
            return;
        }
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
            '<th>Application ID</th><th>Programme</th><th>Category</th><th>Topic</th><th>Status</th><th>Files</th><th></th></tr></thead><tbody>';
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
    currentCaseViewIndex = index;
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
        '<p><strong>Programme:</strong> ' +
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
        '<h4 style="color:#4338ca;margin-bottom:8px;"><i class="fas fa-comments"></i> Messages from judges</h4>' +
        '<div id="case-judge-messages-thread" class="muted" style="font-size:0.88rem;margin-bottom:8px;">Loading messages…</div>' +
        '<textarea id="case-judge-reply-input" rows="3" style="width:100%;padding:8px;border:1px solid #c7d2fe;border-radius:8px;font-size:0.9rem;" placeholder="Reply to the judge…"></textarea>' +
        '<button type="button" class="btn-primary" style="margin-top:8px;padding:8px 14px;" onclick="sendCaseJudgeReply(' +
        c.id +
        ')"><i class="fas fa-paper-plane"></i> Send reply</button>' +
        '<p id="case-judge-reply-err" class="hidden" style="color:#b91c1c;font-size:0.85rem;margin-top:6px;"></p>' +
        '<hr style="margin:16px 0;border:0;border-top:1px solid #cbd5e1;">' +
        '<h4 style="color:#0f766e;margin-bottom:12px;"><i class="fas fa-route"></i> Case presentation tracking</h4>' +
        renderTrackerStepsHtml(c.timeline || {}) +
        '<button type="button" class="btn-primary" style="margin-top:16px;background:#0f766e;" onclick="downloadCaseApplicationPdf()"><i class="fas fa-file-pdf"></i> Download application PDF</button>' +
        (String(c.status || '').toLowerCase() === 'revision_required'
            ? '<div id="case-resubmit-panel" style="margin-top:16px;"><p style="color:#9a3412;font-weight:600;">Re-upload rejected files (same application ID)</p><p class="muted">Loading file list…</p></div>'
            : '');
    const modal = document.getElementById('view-case-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
    if (String(c.status || '').toLowerCase() === 'revision_required') {
        loadCaseResubmitPanel(c.id);
    }
    loadCaseJudgeMessages(c.id);
}

function formatCaseMessageTime(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return String(iso);
    }
}

function renderCaseJudgeMessages(messages) {
    const box = document.getElementById('case-judge-messages-thread');
    if (!box) return;
    const list = messages || [];
    if (!list.length) {
        box.innerHTML = '<p class="muted">No messages from judges yet.</p>';
        return;
    }
    box.innerHTML = list
        .map((m) => {
            const isJudge = m.direction === 'judge';
            const who = isJudge
                ? escapeHtml(m.judgeName || 'Judge')
                : 'You';
            const bg = isJudge ? '#ede9fe' : '#ecfdf5';
            const border = isJudge ? '#c7d2fe' : '#a7f3d0';
            return (
                '<div style="margin-bottom:10px;padding:10px 12px;background:' +
                bg +
                ';border:1px solid ' +
                border +
                ';border-radius:8px;">' +
                '<div style="font-size:0.72rem;color:#64748b;font-weight:600;margin-bottom:4px;">' +
                who +
                ' · ' +
                escapeHtml(formatCaseMessageTime(m.createdAt)) +
                '</div>' +
                '<div style="white-space:pre-wrap;word-break:break-word;">' +
                escapeHtml(m.body || '') +
                '</div></div>'
            );
        })
        .join('');
}

async function loadCaseJudgeMessages(submissionId) {
    const box = document.getElementById('case-judge-messages-thread');
    const uid = doctorNumericUserId();
    if (!box || !uid) return;
    box.innerHTML = '<p class="muted">Loading messages…</p>';
    try {
        const res = await fetch(
            '/api/doctor/case/submissions/' +
                submissionId +
                '/messages?userId=' +
                encodeURIComponent(uid)
        );
        const data = await res.json();
        if (!res.ok) {
            box.innerHTML =
                '<p style="color:#b91c1c;">' + escapeHtml(data.error || 'Could not load messages') + '</p>';
            return;
        }
        renderCaseJudgeMessages(data.messages || []);
    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Network error loading messages.</p>';
    }
}

async function sendCaseJudgeReply(submissionId) {
    const uid = doctorNumericUserId();
    if (!uid) return alert('Please sign in again.');
    const inp = document.getElementById('case-judge-reply-input');
    const errEl = document.getElementById('case-judge-reply-err');
    const message = inp && inp.value ? inp.value.trim() : '';
    if (!message) {
        if (errEl) {
            errEl.textContent = 'Please enter a reply.';
            errEl.classList.remove('hidden');
        }
        return;
    }
    if (errEl) errEl.classList.add('hidden');
    try {
        const res = await fetch('/api/doctor/case/submissions/' + submissionId + '/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, message })
        });
        const data = await res.json();
        if (!res.ok) {
            if (errEl) {
                errEl.textContent = data.error || 'Could not send reply';
                errEl.classList.remove('hidden');
            }
            return;
        }
        if (inp) inp.value = '';
        await loadCaseJudgeMessages(submissionId);
    } catch (e) {
        console.error(e);
        if (errEl) {
            errEl.textContent = 'Network error';
            errEl.classList.remove('hidden');
        }
    }
}

async function loadCaseResubmitPanel(submissionId) {
    const panel = document.getElementById('case-resubmit-panel');
    if (!panel || !currentUser) return;
    const uid = doctorNumericUserId();
    if (!uid) return;
    try {
        const res = await fetch(
            '/api/doctor/case/submissions/' + uid + '/files?submissionId=' + encodeURIComponent(submissionId)
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            panel.innerHTML = '<p style="color:#b91c1c;">' + escapeHtml(data.error || 'Could not load files') + '</p>';
            return;
        }
        const files = (data.files || []).filter((f) => String(f.status).toLowerCase() === 'rejected');
        if (!files.length) {
            panel.innerHTML =
                '<p class="muted">No rejected files listed. If admin asked for changes, wait for file review or contact support.</p>';
            return;
        }
        let html = '';
        files.forEach((f) => {
            html +=
                '<div style="margin:8px 0;padding:8px;border:1px solid #e2e8f0;border-radius:6px;">' +
                '<strong>' +
                escapeHtml(f.original_name || 'File') +
                '</strong>' +
                (f.rejection_reason
                    ? '<div class="muted" style="font-size:0.85rem;">' + escapeHtml(f.rejection_reason) + '</div>'
                    : '') +
                '<input type="file" class="case-resubmit-file" data-file-id="' +
                f.id +
                '" style="margin-top:6px;width:100%;"></div>';
        });
        html +=
            '<button type="button" class="btn-warning" style="margin-top:8px;" onclick="submitCaseFileResubmits(' +
            submissionId +
            ')">Submit corrected files</button>';
        panel.innerHTML = html;
    } catch (e) {
        console.error(e);
        panel.innerHTML = '<p style="color:#b91c1c;">Network error loading files.</p>';
    }
}

async function submitCaseFileResubmits(submissionId) {
    const uid = doctorNumericUserId();
    if (!uid) return alert('Please sign in again.');
    const inputs = document.querySelectorAll('.case-resubmit-file');
    const fd = new FormData();
    fd.append('userId', String(uid));
    fd.append('submissionId', String(submissionId));
    const ids = [];
    let hasFile = false;
    for (const inp of inputs) {
        const fid = inp.getAttribute('data-file-id');
        if (inp.files && inp.files[0] && fid) {
            const ready = await prepareUploadFileOrAlert(inp.files[0]);
            if (!ready) return;
            fd.append('files', ready);
            ids.push(fid);
            hasFile = true;
        }
    }
    if (!hasFile) return alert('Select at least one replacement file.');
    fd.append('replaceFileIds', ids.join(','));
    try {
        const res = await fetch('/api/case/resubmit', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Resubmit failed');
        alert('Files resubmitted. Admin will review again on the same application ID.');
        loadCaseApplicationsTracker();
        const modal = document.getElementById('view-case-modal');
        if (modal) modal.classList.add('hidden');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

function downloadCaseApplicationPdf() {
    const c = userCaseApplications[currentCaseViewIndex];
    if (!c || !window.jspdf) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const accent = [15, 118, 110];
    const ink = [15, 23, 42];
    const muted = [71, 85, 105];
    let y = pdfCongressHeader(doc, 'Case presentation application');
    const row = (label, val) => {
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...muted);
        const lines = doc.splitTextToSize(String(val == null ? '—' : val), 118);
        doc.text(label, 18, y + 6);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        doc.text(lines, 72, y + 6);
        y += Math.max(10, lines.length * 5.2 + 4);
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y, 196, y);
    };
    y = pdfCongressSectionTitle(doc, y + 4, 'Application', accent, ink);
    row('Application ID', c.application_no || c.id);
    row('Programme', c.program_title);
    row('Category', c.category);
    row('Topic / title', c.title);
    row('Status', caseApplicationStatusLabel(c.status));
    row('Files uploaded', c.file_count || 0);
    y += 8;
    doc.setFontSize(10);
    doc.setTextColor(180, 83, 9);
    doc.setFont('helvetica', 'bold');
    doc.text('VGMF Case Presentation · ' + new Date().toLocaleDateString(), 105, y, { align: 'center' });
    const blob = doc.output('blob');
    if (currentCasePdfBlobUrl) URL.revokeObjectURL(currentCasePdfBlobUrl);
    currentCasePdfBlobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = currentCasePdfBlobUrl;
    a.download = 'Case_Application_' + (c.application_no || c.id) + '.pdf';
    a.click();
}

let currentCaseViewIndex = 0;

function isBuiltinCertificateTemplate(path) {
    const p = String(path || '');
    return p === '__builtin_vgmf_participant__' || p === '__builtin_vgmf_volunteer__';
}

function certificateViewUrl(c, isVolunteer) {
    const uid = currentUser && currentUser.id != null ? Number(currentUser.id) : 0;
    if (!uid || !c.id) return '#';
    const q = isVolunteer ? `vc=${c.id}&uid=${uid}` : `uc=${c.id}&uid=${uid}`;
    return `/certificate/view?${q}`;
}

function doctorCertificateLockedBlock(message) {
    const msg =
        message ||
        'Your certificate will be available after check-in and when it has been issued for this seminar.';
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
        '<div style="text-align:center;padding:24px;background:#fffbeb;border-radius:8px;border:1px solid #e8d48a;">' +
        '<i class="fas fa-award" style="font-size:2rem;color:#c9a227;margin-bottom:10px;display:block;"></i>' +
        '<p style="margin:0;font-weight:600;color:#92400e;">Certificate approved</p>' +
        '<p style="margin:8px 0 0;font-size:0.9rem;color:#78716c;">Your certificate is enabled. The organizer still needs to apply the VGMF certificate design in admin.</p>' +
        '</div>'
    );
}

async function loadDoctorCertificates() {
    const wrap = document.getElementById('doctor-certificates-wrap');
    if (!wrap || !currentUser) return;
    wrap.innerHTML = '<p style="color:#64748b;text-align:center;">Loading…</p>';
    try {
        const uid = doctorNumericUserId();
        if (!uid) {
            wrap.innerHTML = '<p style="color:#b91c1c;">Please sign out and sign in again.</p>';
            return;
        }
        const [res, vres] = await Promise.all([
            fetch('/api/doctor/certificates/' + uid),
            fetch('/api/doctor/volunteer-certificates/' + uid)
        ]);
        const rows = await res.json().catch(() => []);
        const vrows = await vres.json().catch(() => []);
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
                    'Your certificate is not available yet. It will appear here after check-in when issued.'
                )}`;
                wrap.appendChild(card);
                return;
            }
            if (!c.template_path) {
                card.innerHTML = `<h4 style="margin:0 0 12px;">${title}</h4>${doctorCertificatePendingTemplateBlock()}`;
                wrap.appendChild(card);
                return;
            }
            const viewUrl = certificateViewUrl(c, !!c._volunteer);
            if (isBuiltinCertificateTemplate(c.template_path)) {
                card.innerHTML =
                    `<h4 style="margin:0 0 8px;color:#92400e;">${title}</h4>` +
                    `<p style="font-size:0.88rem;color:#78716c;margin-bottom:10px;">${name}</p>` +
                    `<div style="border:2px solid #e8d48a;border-radius:10px;overflow:hidden;"><iframe src="${viewUrl}" style="width:100%;min-height:420px;border:0;"></iframe></div>` +
                    `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">` +
                    `<a href="${viewUrl}" target="_blank" class="btn-primary" style="text-decoration:none;background:linear-gradient(135deg,#c9a227,#a67c00);padding:8px 14px;">Open</a>` +
                    `<button type="button" class="btn-primary" style="background:#15803d;padding:8px 14px;" onclick="downloadDoctorCertificate('${viewUrl}')"><i class="fas fa-download"></i> Download PDF</button>` +
                    `<button type="button" class="btn-primary" style="background:#475569;padding:8px 14px;" onclick="var w=window.open('${viewUrl}');if(w)w.print();">Print</button></div>`;
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
    const needsTncStep =
        !!window.__seminarTermsText ||
        !!(document.getElementById('reg-cancel-policy-wrap') && !document.getElementById('reg-cancel-policy-wrap').classList.contains('hidden'));
    if (step >= 1 && step <= REGISTRATION_PREVIEW_STEP && needsTncStep) {
        if (!document.getElementById('reg-tnc-accept')?.checked) {
            alert('Please accept the Terms and Conditions on the Terms step first.');
            return nextStep(0);
        }
    }
    if (step >= 2 && step <= REGISTRATION_PREVIEW_STEP) {
        const err = validateRegistrationAgainstConfigForSteps(step - 1);
        if (err) {
            alertRegistrationValidation(err);
            return;
        }
    }

    // Hide all steps
    document.querySelectorAll('.form-step').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
    
    // Show current step
    document.getElementById(`step-${step}`).classList.remove('hidden');
    if (step === 4) toggleCollegeStep();
    
    // Update progress indicator
    for (let i = 0; i <= step; i++) {
        const ind = document.getElementById(`ind-step-${i}`);
        if (ind) ind.classList.add('active');
    }

    // If moving to preview, populate data and generate PDF iframe
    if (step === 1) syncRegistrationOtpUi();
    if (step === REGISTRATION_PREVIEW_STEP) {
        syncRegistrationOtpUi();
        resetRegistrationSubmitOtpState();
        const prevTnc = document.getElementById('prev-tnc-block');
        const prevTncText = document.getElementById('prev-tnc-text');
        if (prevTnc && prevTncText) {
            prevTncText.textContent = window.__seminarTermsText || '—';
            prevTnc.style.display = 'block';
        }
        const draftAppNo = ensureDraftApplicationNo();
        const prevAppNo = document.getElementById('prev-app-no');
        if (prevAppNo) prevAppNo.innerText = draftAppNo;
        document.getElementById('prev-name').innerText = `${document.getElementById('reg-fname').value} ${document.getElementById('reg-mname').value} ${document.getElementById('reg-lname').value}`;
        document.getElementById('prev-contact').innerText = `${document.getElementById('reg-email').value} / ${document.getElementById('reg-phone').value}`;
        document.getElementById('prev-addr').innerText = document.getElementById('reg-addr').value;
        document.getElementById('prev-loc').innerText = `${document.getElementById('reg-city').value}, ${document.getElementById('reg-state').value}, ${document.getElementById('reg-pin').value}`;
        
        const qual = document.getElementById('reg-qual').value;
        const qualEl = document.getElementById('reg-qual');
        const qualLabel =
            qualEl && qualEl.selectedIndex > 0
                ? qualEl.options[qualEl.selectedIndex].text
                : qual;
        document.getElementById('prev-qual').innerText = qualLabel;
        if(qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner') {
            document.getElementById('prev-ncism-box').classList.remove('hidden');
            document.getElementById('prev-ncism').innerText = document.getElementById('reg-ncism').value;
            updateRegistrationPreviewCertificate();
        } else {
            document.getElementById('prev-ncism-box').classList.add('hidden');
            document.getElementById('prev-cert-box').classList.add('hidden');
            const pdfBadge = document.getElementById('reg-pdf-cert-badge');
            if (pdfBadge) pdfBadge.classList.add('hidden');
        }

        const prevCollegeBox = document.getElementById('prev-college-box');
        if (registrationQualIsPg()) {
            if (prevCollegeBox) prevCollegeBox.classList.remove('hidden');
            document.getElementById('prev-college').innerText = document.getElementById('reg-college').value;
            document.getElementById('prev-cloc').innerText = `${document.getElementById('reg-ccity').value}, ${document.getElementById('reg-cstate').value}`;
        } else if (prevCollegeBox) {
            prevCollegeBox.classList.add('hidden');
        }
        
        const qrImg = document.getElementById('prev-qrcode');
        qrImg.onload = () => generatePdfBlob(qrImg);
        qrImg.onerror = () => generatePdfBlob(null);
        qrImg.src = `/api/qrcode/${encodeURIComponent(draftAppNo)}`;
    }
}

let currentPdfBlobUrl = null;
let currentCasePdfBlobUrl = null;

function pdfCongressHeader(doc, subtitle) {
    doc.setFillColor(13, 92, 77);
    doc.rect(0, 0, 210, 42, 'F');
    doc.setFillColor(184, 134, 11);
    doc.rect(0, 40, 210, 2.5, 'F');
    doc.setFontSize(15);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('Vaidya Gogate Memorial Foundation', 105, 17, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(subtitle || 'National Seminar Portal', 105, 28, { align: 'center' });
    doc.setFontSize(8);
    doc.setTextColor(236, 253, 245);
    doc.text('National Seminar · Ayurveda Congress', 105, 35, { align: 'center' });
    return 50;
}

function pdfCongressSectionTitle(doc, y, title, accent, ink) {
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(14, y, 182, 9, 1.5, 1.5, 'F');
    doc.setFontSize(11);
    doc.setTextColor(...accent);
    doc.setFont('helvetica', 'bold');
    doc.text(title, 18, y + 6.5);
    return y + 14;
}

/** Embed QR on PDF (draw after section backgrounds so it is not covered). */
function pdfAddQrCode(doc, qrImgElement, x, y, sizeMm) {
    if (!qrImgElement || !qrImgElement.src) return;
    const w = qrImgElement.naturalWidth || qrImgElement.width;
    const h = qrImgElement.naturalHeight || qrImgElement.height;
    if (!w || !h) return;
        const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
        const ctx = canvas.getContext('2d');
    ctx.drawImage(qrImgElement, 0, 0, w, h);
        const imgData = canvas.toDataURL('image/png');
    const sz = sizeMm || 34;
    doc.addImage(imgData, 'PNG', x, y, sz, sz);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.rect(x, y, sz, sz, 'S');
}

function generatePdfBlob(qrImgElement) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const accent = [15, 118, 110];
    const ink = [15, 23, 42];
    const muted = [71, 85, 105];

    let y = pdfCongressHeader(doc, 'Seminar registration — draft preview');

    const drawSection = (title) => {
        y = pdfCongressSectionTitle(doc, y + 4, title, accent, ink);
    };

    const drawTableRow = (label, value) => {
        const lh = 6.2;
        doc.setFontSize(9.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...muted);
        const lines = doc.splitTextToSize(String(value || '-'), 118);
        const rowH = Math.max(10, lines.length * lh - 1);
        doc.setDrawColor(226, 232, 240);
        doc.line(14, y + rowH, 196, y + rowH);
        doc.text(label, 18, y + 7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...ink);
        doc.text(lines, 72, y + 7);
        y += rowH;
    };

    const appNo = window.__draftApplicationNo || '';
    if (appNo) {
        drawSection('Application');
        drawTableRow('Application number', appNo);
    }

    drawSection('Candidate');
    drawTableRow(
        'Full name',
        `${document.getElementById('reg-fname').value} ${document.getElementById('reg-mname').value} ${document.getElementById('reg-lname').value}`
    );
    drawTableRow('Email', document.getElementById('reg-email').value);
    drawTableRow('Phone', document.getElementById('reg-phone').value);
    const dobEl = document.getElementById('reg-dob');
    if (dobEl && dobEl.value) drawTableRow('Date of birth', dobEl.value);
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
    drawSection('Documents uploaded');
    const certDoc = regCertStatusLabel();
    if (qual === 'PG' || qual === 'Practicing Vaidya' || qual === 'Practitioner') {
        drawTableRow('NCISM certificate', certDoc || 'Not attached');
    } else {
        drawTableRow('NCISM certificate', 'Not required for this qualification');
    }

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

    pdfAddQrCode(doc, qrImgElement, 166, 44, 34);

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
        const no = window.__draftApplicationNo || 'Draft';
        a.download = `Application_${no}.pdf`;
        a.click();
    }
}

let __regPinLookupTimer = null;

function fillRegSelectOptions(sel, options, placeholder) {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = placeholder || 'Select';
    sel.appendChild(opt0);
    for (const v of options || []) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
    }
    if (prev && (options || []).includes(prev)) sel.value = prev;
    else if ((options || []).length === 1) sel.value = options[0];
}

function setRegPinHint(msg, isError) {
    const el = document.getElementById('reg-pin-hint');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.style.color = isError ? '#b91c1c' : '#64748b';
}

function clearPinDerivedAddress() {
    fillRegSelectOptions(document.getElementById('reg-city'), [], 'Select city');
    fillRegSelectOptions(document.getElementById('reg-state'), [], 'Select state');
    setRegPinHint('');
}

function onRegPinInput() {
    const pinEl = document.getElementById('reg-pin');
    if (!pinEl) return;
    const pin = String(pinEl.value || '').replace(/\D/g, '').slice(0, 6);
    if (pinEl.value !== pin) pinEl.value = pin;
    clearTimeout(__regPinLookupTimer);
    if (pin.length === 6) {
        __regPinLookupTimer = setTimeout(() => autofillAddress(), 400);
    } else if (pin.length < 6) {
        clearPinDerivedAddress();
    }
}

async function populateRegistrationCountrySelect() {
    const sel = document.getElementById('reg-country');
    if (!sel || sel.dataset.populated === '1') return;
    try {
        const r = await fetch('/api/public/countries');
        const data = await r.json();
        const list = (data && data.countries) || [];
        fillRegSelectOptions(sel, list, 'Select country');
        if (list.includes('India')) sel.value = 'India';
        sel.dataset.populated = '1';
    } catch (e) {
        console.warn('[countries]', e);
    }
}

async function initRegistrationAddressUi() {
    await populateRegistrationCountrySelect();
    const pinEl = document.getElementById('reg-pin');
    if (pinEl && pinEl.dataset.bound !== '1') {
        pinEl.dataset.bound = '1';
        pinEl.addEventListener('input', onRegPinInput);
    }
    const cpinEl = document.getElementById('reg-cpin');
    if (cpinEl && cpinEl.dataset.bound !== '1') {
        cpinEl.dataset.bound = '1';
        cpinEl.addEventListener('input', onRegCpinInput);
    }
}

async function autofillAddress() {
    const pinEl = document.getElementById('reg-pin');
    if (!pinEl) return;
    const pin = String(pinEl.value || '').replace(/\D/g, '');
    if (pin.length !== 6) {
        if (pin.length) setRegPinHint('Enter a valid 6-digit PIN code', true);
        return;
    }
    setRegPinHint('Looking up PIN…');
    try {
        const r = await fetch(`/api/public/pincode-lookup?pin=${encodeURIComponent(pin)}`);
        const data = await r.json();
        if (!data || !data.ok) {
            setRegPinHint((data && data.error) || 'PIN not found', true);
            clearPinDerivedAddress();
            return;
        }
        fillRegSelectOptions(document.getElementById('reg-city'), data.cities || [], 'Select city');
        fillRegSelectOptions(document.getElementById('reg-state'), data.states || [], 'Select state');
        const countrySel = document.getElementById('reg-country');
        const country = data.country || 'India';
        if (countrySel && country && [...countrySel.options].some((o) => o.value === country)) {
            countrySel.value = country;
        }
        const cities = data.cities || [];
        setRegPinHint(
            cities.length > 1 ? 'Multiple areas for this PIN — choose city' : 'City and state filled from PIN'
        );
    } catch (e) {
        setRegPinHint('Could not look up PIN. Check your connection and try again.', true);
        clearPinDerivedAddress();
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

function toggleCollegeStep() {
    const isPg = registrationQualIsPg();
    const ind4 = document.getElementById('ind-step-4');
    if (ind4) ind4.style.display = isPg ? '' : 'none';
    const hint = document.getElementById('step-4-pg-hint');
    if (hint) hint.style.display = isPg ? '' : 'none';
    const fields = window.__registrationFormFields || [];
    REGISTRATION_COLLEGE_KEYS.forEach((key) => {
        const id = REGISTRATION_FIELD_IDS[key];
        const el = document.getElementById(id);
        if (!el) return;
        const fg = el.closest('.form-group');
        const cfg = fields.find((f) => f.key === key);
        const enabled = !cfg || cfg.enabled !== false;
        if (fg) {
            if (isPg && enabled) fg.classList.remove('hidden');
            else fg.classList.add('hidden');
        }
        if (el.tagName === 'SELECT' || el.tagName === 'INPUT') {
            el.required = !!(isPg && enabled && cfg && cfg.required !== false);
        }
    });
    refreshRegistrationRequiredAttributes();
}

function nextRegistrationStepAfterCollege() {
    return nextStep(5);
}

function nextRegistrationStepFromQual() {
    if (registrationQualIsPg()) return nextStep(4);
    return nextStep(5);
}

let __regCpinLookupTimer = null;

function setRegCpinHint(msg, isError) {
    const el = document.getElementById('reg-cpin-hint');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.style.color = isError ? '#b91c1c' : '#64748b';
}

function clearCollegePinDerived() {
    fillRegSelectOptions(document.getElementById('reg-ccity'), [], 'Select city');
    fillRegSelectOptions(document.getElementById('reg-cstate'), [], 'Select state');
    setRegCpinHint('');
}

async function autofillCollegeAddress() {
    if (!registrationQualIsPg()) return;
    const pinEl = document.getElementById('reg-cpin');
    if (!pinEl) return;
    const pin = String(pinEl.value || '').replace(/\D/g, '');
    if (pin.length !== 6) {
        if (pin.length) setRegCpinHint('Enter a valid 6-digit PIN code', true);
        clearCollegePinDerived();
        return;
    }
    setRegCpinHint('Looking up PIN…');
    try {
        const r = await fetch(`/api/public/pincode-lookup?pin=${encodeURIComponent(pin)}`);
        const data = await r.json();
        if (!data || !data.ok) {
            setRegCpinHint((data && data.error) || 'PIN not found', true);
            clearCollegePinDerived();
            return;
        }
        fillRegSelectOptions(document.getElementById('reg-ccity'), data.cities || [], 'Select city');
        fillRegSelectOptions(document.getElementById('reg-cstate'), data.states || [], 'Select state');
        const cities = data.cities || [];
        setRegCpinHint(
            cities.length > 1 ? 'Multiple areas for this PIN — choose city' : 'City and state filled from PIN'
        );
    } catch (e) {
        setRegCpinHint('Could not look up PIN. Try again.', true);
        clearCollegePinDerived();
    }
}

function onRegCpinInput() {
    const pinEl = document.getElementById('reg-cpin');
    if (!pinEl) return;
    const pin = String(pinEl.value || '').replace(/\D/g, '').slice(0, 6);
    if (pinEl.value !== pin) pinEl.value = pin;
    clearTimeout(__regCpinLookupTimer);
    if (pin.length === 6) {
        __regCpinLookupTimer = setTimeout(() => autofillCollegeAddress(), 400);
    } else if (pin.length < 6) {
        clearCollegePinDerived();
    }
}

window.autofillCollegeAddress = autofillCollegeAddress;

async function verifyNcism() {
    const ncism = String(document.getElementById('reg-ncism')?.value || '').trim();
    const fileInput = document.getElementById('reg-cert-file');
    const statusEl = document.getElementById('ncism-status');
    if (ncism.length < 4) {
        if (statusEl) statusEl.classList.add('hidden');
        return alert('Enter your NCISM / registration number (at least 4 characters).');
    }
    const ocrDisabled = !!(window.__portalFlags && window.__portalFlags.ncism_disable_ocr);
    if (!ocrDisabled && (!fileInput || !fileInput.files || !fileInput.files[0])) {
        return alert('Upload your registration certificate (PDF or image), then click Verify ID.');
    }
    if (ocrDisabled) {
        if (statusEl) {
            statusEl.classList.remove('hidden');
            statusEl.style.color = '#0f766e';
            statusEl.textContent = 'Auto OCR verification is disabled by admin. Submission will go for manual review.';
        }
        return alert('Auto OCR verification is currently disabled. Please continue and submit for manual verification.');
    }
    const certReady = await prepareUploadFileOrAlert(fileInput.files[0]);
    if (!certReady) return;
    const fd = new FormData();
    fd.append('ncism', ncism);
    fd.append('certificate', certReady);
    try {
        const res = await fetch('/api/applications/check-ncism-certificate', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Verification failed');
        const check = data.check || {};
        if (statusEl) {
            statusEl.classList.remove('hidden');
            if (check.status === 'match') {
                statusEl.style.color = '#059669';
                statusEl.textContent = 'Certificate matches entered registration number.';
            } else if (check.status === 'mismatch') {
                statusEl.style.color = '#b91c1c';
                statusEl.textContent =
                    'Mismatch: certificate shows ' +
                    (check.bestMatch || (check.extracted || []).join(', ') || '?') +
                    ' — admin will verify manually.';
    } else {
                statusEl.style.color = '#b45309';
                statusEl.textContent =
                    'Could not read number from file automatically — your application will be reviewed manually.';
            }
        }
        window.__regCertServerUploaded = true;
        updateRegCertUploadUi({ uploaded: true });
        updateRegistrationPreviewCertificate();
        if (check.status === 'match') {
            setInlineUploadSuccess(
                document.getElementById('reg-cert-success'),
                document.getElementById('reg-cert-success-text'),
                'Certificate uploaded successfully and matches your registration number.',
                true
            );
        } else if (check.status === 'mismatch') {
            setInlineUploadSuccess(
                document.getElementById('reg-cert-success'),
                document.getElementById('reg-cert-success-text'),
                'Certificate uploaded successfully. Number mismatch — admin will verify manually.',
                true
            );
        } else {
            setInlineUploadSuccess(
                document.getElementById('reg-cert-success'),
                document.getElementById('reg-cert-success-text'),
                'Certificate uploaded successfully. Automatic read was inconclusive — admin will review.',
                true
            );
        }
    } catch (e) {
        console.error(e);
        alert('Network error while checking certificate.');
    }
}

async function submitApplication() {
    if(!document.getElementById('tnc').checked) {
        alert("Please accept the Terms and Conditions.");
        return;
    }

    if (window.__otpOnSubmit) {
        if (window.__emailConfigured && !window.__regSubmitEmailOtpToken) {
            alert('Verify your email using the final confirmation codes on this preview step before submitting.');
            return;
        }
        if (window.__whatsappConfigured && !window.__regSubmitPhoneOtpToken) {
            alert('Verify WhatsApp using the final confirmation codes on this preview step before submitting.');
            return;
        }
    }
    if (window.__otpOnStep1) {
        if (window.__emailConfigured && !registrationEmailVerified()) {
            alert('Verify your email on the personal details step (step 1) before submitting.');
            return;
        }
        if (window.__whatsappConfigured && !registrationPhoneVerified()) {
            alert('Verify your phone on the personal details step (step 1) before submitting.');
            return;
        }
    }

    const vErr = validateRegistrationAgainstConfigForSteps(4);
    if (vErr) {
        alertRegistrationValidation(vErr);
        return;
    }
    
    const formDataObj = {
        fname: document.getElementById('reg-fname').value,
        mname: document.getElementById('reg-mname').value,
        lname: document.getElementById('reg-lname').value,
        email: document.getElementById('reg-email').value,
        phone: document.getElementById('reg-phone').value,
        dob: document.getElementById('reg-dob') ? document.getElementById('reg-dob').value : '',
        address: document.getElementById('reg-addr').value,
        pin: document.getElementById('reg-pin').value,
        city: document.getElementById('reg-city').value,
        state: document.getElementById('reg-state').value,
        country: document.getElementById('reg-country').value,
        qual: document.getElementById('reg-qual').value,
        ncism: document.getElementById('reg-ncism').value,
        cpin: document.getElementById('reg-cpin') ? document.getElementById('reg-cpin').value : '',
        college: document.getElementById('reg-college').value,
        ccity: document.getElementById('reg-ccity').value,
        cstate: document.getElementById('reg-cstate').value,
        agree_terms: document.getElementById('tnc').checked ? '1' : ''
    };

    const uid = doctorUserIdOrAlert();
    if (!uid) return;
    const sid = parseInt(activeSeminarIdForReg, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return alert('Seminar session expired. Close the form and open the seminar again from the dashboard.');
    }

    const payload = new FormData();
    payload.append('userId', String(uid));
    payload.append('seminarId', String(sid));
    payload.append('formData', JSON.stringify(formDataObj));
    if (window.__otpOnStep1) {
        payload.append('phoneOtpToken', window.__regPhoneOtpToken || '');
        payload.append('emailOtpToken', window.__regEmailOtpToken || '');
    }
    if (window.__otpOnSubmit) {
        payload.append('submitPhoneOtpToken', window.__regSubmitPhoneOtpToken || '');
        payload.append('submitEmailOtpToken', window.__regSubmitEmailOtpToken || '');
    }
    payload.append('fieldOtpTokens', JSON.stringify(window.__fieldOtpTokens || {}));
    
    const certFile = document.getElementById('reg-cert-file').files[0];
    if (certFile) {
        const certReady = await prepareUploadFileOrAlert(certFile);
        if (!certReady) return;
        payload.append('certificate', certReady);
    }

    try {
        const res = await fetch('/api/applications/submit', {
            method: 'POST',
            body: payload
        });
        let result = {};
        try {
            result = await res.json();
        } catch (parseErr) {
            console.error(parseErr);
            return alert(
                res.ok
                    ? 'Application may have been submitted, but the server response was invalid. Check View Applications.'
                    : `Submission failed (HTTP ${res.status}). Please try again.`
            );
        }
        if (result.success) {
            if (certFile) {
                window.__regCertServerUploaded = true;
                updateRegCertUploadUi({ uploaded: true });
            }
            alert(`Application submitted successfully. Your application number is ${result.applicationNo}. You can track status under View Applications.`);
            cancelRegistration();
            loadApplications();
        } else {
            const msg = result.error || `Submission failed (HTTP ${res.status}).`;
            alert(/^Missing required field:/i.test(msg) ? formatRegValidationError(msg) : msg);
        }
    } catch (err) {
        console.error(err);
        alert('Network error while submitting. Check your connection and try again.');
    }
}

let userApplications = [];
let userCaseApplications = [];

function parseCancellationPolicyClient(raw) {
    if (raw == null || raw === '') return { enabled: true };
    try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return p && typeof p === 'object' ? p : { enabled: true };
    } catch (_) {
        return { enabled: true };
    }
}

function formatCancelUntilIst(iso) {
    if (!iso) return '';
    const raw = String(iso).trim();
    const d = new Date(/[zZ+-]/.test(raw) ? raw : raw.includes('T') ? raw + '+05:30' : raw);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
}

function summaryCancellationPolicy(raw) {
    if (!raw) return '';
    try {
        const p = parseCancellationPolicyClient(raw);
        if (p.enabled === false) {
            return 'Self-cancellation is not available for this seminar. Contact the organizer if you need help.';
        }
        const parts = [];
        if (p.allowedUntil) {
            const when = formatCancelUntilIst(p.allowedUntil);
            parts.push(
                when
                    ? `You may cancel until ${when} (IST).`
                    : 'You may cancel until the scheduled deadline.'
            );
        } else {
            parts.push('You may cancel until the seminar day.');
        }
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
        return parts.join(' ');
    } catch (_) {
        return '';
    }
}

function evaluateDoctorCancellationClient(policy, eventDate) {
    const p = parseCancellationPolicyClient(policy);
    if (p.enabled === false) {
        return { allowed: false, reason: 'Self-cancellation is not enabled for this seminar.' };
    }
    if (p.allowedUntil) {
        const raw = String(p.allowedUntil).trim();
        const untilMs = new Date(/[zZ+-]/.test(raw) ? raw : raw.includes('T') ? raw + '+05:30' : raw).getTime();
        if (!Number.isNaN(untilMs) && Date.now() > untilMs) {
            const when = formatCancelUntilIst(p.allowedUntil);
            return {
                allowed: false,
                reason: when ? `Cancellation closed on ${when} (IST).` : 'The cancellation window has closed.'
            };
        }
    }
    if (eventDate) {
        const evRaw = String(eventDate).trim();
        const evMs = new Date(/[zZ+-]/.test(evRaw) ? evRaw : evRaw.includes('T') ? evRaw + '+05:30' : evRaw).getTime();
        if (!Number.isNaN(evMs)) {
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Kolkata',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            });
            if (fmt.format(new Date()) >= fmt.format(new Date(evMs))) {
                return {
                    allowed: false,
                    reason: 'Cancellation is only allowed before the seminar day.'
                };
            }
        }
    }
    return { allowed: true };
}

function registrationIsPaidForWhatsapp(app) {
    const st = String((app && app.status) || '').toLowerCase();
    return ['completed', 'checked_in', 'e_ticket_issued', 'certificate_issued'].includes(st);
}

function seminarShowsWhatsappLink(app) {
    return (
        registrationIsPaidForWhatsapp(app) &&
        app &&
        app.whatsapp_group_url &&
        String(app.whatsapp_group_url).trim()
    );
}

/** QR scan value: prefer 12-digit e-ticket ID (short URL); legacy rows may store JSON in qr_code_data. */
function ticketQrScanPayload(t) {
    if (!t) return '';
    const tid = t.ticket_id_string && String(t.ticket_id_string).trim();
    if (tid) return tid;
    const raw = t.qr_code_data && String(t.qr_code_data).trim();
    if (!raw) return '';
    if (raw.startsWith('{')) {
        try {
            const j = JSON.parse(raw);
            if (j.ticketId) return String(j.ticketId).trim();
        } catch (_) {}
        return '';
    }
    return raw.length > 200 ? '' : raw;
}

function ticketQrImageUrl(t) {
    const payload = ticketQrScanPayload(t);
    return payload ? '/api/qrcode/' + encodeURIComponent(payload) : '';
}

function showPostPaymentWhatsappBanner(regId) {
    const app = (userApplications || []).find((a) => Number(a.id) === Number(regId));
    if (!app || !seminarShowsWhatsappLink(app)) return;
    const block = renderWhatsappLinkBlock(app);
    if (!block) return;
    let el = document.getElementById('post-pay-wa-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'post-pay-wa-banner';
        const host =
            document.getElementById('applications-list') ||
            document.getElementById('seminar-applications-list') ||
            document.querySelector('#tab-applications .card');
        if (!host) return;
        host.insertBefore(el, host.firstChild);
    }
    el.innerHTML =
        '<div style="margin-bottom:16px;padding:14px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:12px;">' +
        '<p style="margin:0 0 10px;font-weight:600;color:#047857;"><i class="fas fa-check-circle"></i> Payment confirmed</p>' +
        block +
        '</div>';
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
    const gate = evaluateDoctorCancellationClient(
        app && app.cancellation_policy_json,
        app && app.seminar_event_date
    );
    return gate.allowed;
}

let __cancelRequestAppId = null;
let __doctorCancelRequestsByReg = {};

async function loadDoctorCancellationRequests() {
    if (!currentUser || !currentUser.id) return;
    try {
        const res = await fetch('/api/doctor/cancellation-requests?userId=' + encodeURIComponent(currentUser.id));
        const rows = await res.json();
        __doctorCancelRequestsByReg = {};
        (Array.isArray(rows) ? rows : []).forEach((r) => {
            __doctorCancelRequestsByReg[r.registration_id] = r;
        });
    } catch (e) {
        console.warn('[cancel-req]', e);
    }
}

function doctorCancelRequestStatus(registrationId) {
    const r = __doctorCancelRequestsByReg[registrationId];
    if (!r) return '';
    const st = String(r.status || '').toLowerCase();
    if (st === 'pending') return 'Cancellation pending review';
    if (st === 'approved') return 'Cancellation approved';
    if (st === 'rejected') return 'Cancellation request rejected';
    return '';
}

function openCancelRequestModal(applicationId) {
    if (!currentUser || !currentUser.id) return;
    const app = (userApplications || []).find((a) => Number(a.id) === Number(applicationId));
    if (!app) return;
    if (!doctorCanCancelApplication(app)) {
        const gate = evaluateDoctorCancellationClient(app.cancellation_policy_json, app.seminar_event_date);
        alert(gate.reason || 'Cancellation request is not available.');
        return;
    }
    const pending = __doctorCancelRequestsByReg[applicationId];
    if (pending && pending.status === 'pending') {
        alert('You already have a pending cancellation request for this application.');
        return;
    }
    __cancelRequestAppId = applicationId;
    const label = document.getElementById('cancel-request-app-label');
    const pol = document.getElementById('cancel-request-policy');
    const reason = document.getElementById('cancel-request-reason');
    if (label) label.textContent = 'Application ' + (app.application_no || '') + ' — ' + (app.seminar_title || app.title || '');
    if (pol) pol.textContent = summaryCancellationPolicy(app.cancellation_policy_json) || 'Refund eligibility is calculated in IST when admin reviews your request.';
    if (reason) reason.value = '';
    const m = document.getElementById('cancel-request-modal');
    if (m) {
        m.classList.remove('hidden');
        m.style.display = 'flex';
    }
}

function closeCancelRequestModal() {
    __cancelRequestAppId = null;
    const m = document.getElementById('cancel-request-modal');
    if (m) {
        m.classList.add('hidden');
        m.style.display = '';
    }
}

async function submitCancellationRequest() {
    if (!currentUser || !currentUser.id || !__cancelRequestAppId) return;
    const reason = String(document.getElementById('cancel-request-reason')?.value || '').trim();
    if (reason.length < 10) {
        alert('Please enter at least 10 characters describing your reason.');
        return;
    }
    try {
        const res = await fetch('/api/doctor/cancellation-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                registrationId: __cancelRequestAppId,
                reason
            })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not submit request.');
        const prev = data.refundPreview;
        let msg = data.message || 'Request submitted.';
        if (prev && prev.amount != null) {
            msg += '\n\nPolicy preview (IST): ' + (prev.percent || 0) + '% — ₹' + prev.amount + '. ' + (prev.reason || '');
        }
        alert(msg);
        closeCancelRequestModal();
        await loadDoctorCancellationRequests();
        loadApplications();
    } catch (e) {
        console.error(e);
        alert('Network error.');
    }
}

async function doctorCancelApplication(applicationId) {
    openCancelRequestModal(applicationId);
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
    const list = document.getElementById('applications-list');
    const trackerContainer = document.getElementById('applications-tracker-container');
    try {
        const res = await fetch(`/api/applications/${uid}`, { cache: 'no-store' });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = payload.error || 'Could not load applications.';
            if (list) list.innerHTML = '<tr><td colspan="3" style="color:#b91c1c;">' + escapeHtml(msg) + '</td></tr>';
            if (trackerContainer) {
                trackerContainer.innerHTML =
                    '<p style="color:#b91c1c;">' + escapeHtml(msg) + ' Try signing out and back in.</p>';
            }
            return;
        }
        userApplications = Array.isArray(payload) ? payload : payload.applications || [];
        await loadDoctorCancellationRequests();
        if (payload.portalYear) doctorPortalYear = payload.portalYear;
        const fp = seminarTrackFingerprint(userApplications);
        if (silentPoll && fp === _lastSeminarTrackFingerprint) return;
        _lastSeminarTrackFingerprint = fp;

        if (list) list.innerHTML = '';
        if (trackerContainer) trackerContainer.innerHTML = '';

        if (!userApplications.length) {
            if (list) list.innerHTML = '<tr><td colspan="3" style="text-align:center;">No seminar applications yet.</td></tr>';
            if (trackerContainer) trackerContainer.innerHTML =
                '<p style="color:#64748b;">No seminar registrations yet. Apply from <strong>Available Seminars</strong>.</p>';
        }

        refreshOpenApplicationTrackerFromList(userApplications);

        userApplications.forEach((a, index) => {
            // Render Table Row
            const st = String(a.status || '').toLowerCase();
            const canEdit = a.status === 'submitted' || a.status === 'pending_approval';
            const needsResubmit = st === 'revision_required' || st === 'documents_requested';
            const editBtn = canEdit
                ? `<button class="btn-warning" style="padding: 5px 10px; margin-right: 5px;" onclick="editApplication(${index})">Edit</button>`
                : '';
            const resubmitBtn = needsResubmit
                ? `<button class="btn-warning" style="padding: 5px 10px; margin-right: 5px;" onclick="openSeminarDocumentResubmitByIndex(${index})">${st === 'documents_requested' ? 'Upload docs' : 'Re-upload docs'}</button>`
                : '';
            const cancelStatus = doctorCancelRequestStatus(a.id);
            const canRequestCancel = doctorCanCancelApplication(a) && cancelStatus !== 'Cancellation pending review';
            let cancelBtn = '';
            if (cancelStatus) {
                cancelBtn = '<span style="font-size:0.78rem;color:#92400e;margin-right:6px;">' + escapeHtml(cancelStatus) + '</span>';
            } else if (canRequestCancel) {
                cancelBtn = '<button type="button" class="btn-primary" style="padding: 5px 10px; margin-right: 5px; background: #b91c1c; border: none;" onclick="openCancelRequestModal(' + a.id + ')">Request cancellation</button>';
            }
            
            if (list) {
            list.innerHTML += `
                <tr>
                    <td><strong>${a.application_no}</strong></td>
                    <td><span style="background: ${a.status === 'rejected' ? '#fee2e2' : '#fef3c7'}; padding: 5px; border-radius: 5px;">${a.status.toUpperCase()}</span></td>
                    <td>${editBtn}${resubmitBtn}${cancelBtn}<button class="btn-primary" style="padding: 5px 10px;" onclick="viewApplication(${index})">View Details</button></td>
                </tr>
            `;
            }

            if (trackerContainer) trackerContainer.innerHTML += renderSeminarApplicationTrackerCard(a);
        });
        if (
            (userApplications || []).some(
                (a) => String(a.status || '').toLowerCase() === 'approved_pending_payment'
            )
        ) {
            ensureDoctorPaymentPoll();
        } else if (_doctorPayPollTimer) {
            clearInterval(_doctorPayPollTimer);
            _doctorPayPollTimer = null;
        }
    } catch (err) {
        console.error(err);
    }
}

let _doctorPayPollTimer = null;

function ensureDoctorPaymentPoll() {
    if (_doctorPayPollTimer) return;
    doctorPollPaymentStatus();
    _doctorPayPollTimer = setInterval(() => doctorPollPaymentStatus(), 5000);
}

async function doctorPollPaymentStatus() {
    const uid = doctorNumericUserId();
    if (!uid) return;
    const pending = (userApplications || []).filter(
        (a) => String(a.status || '').toLowerCase() === 'approved_pending_payment'
    );
    if (!pending.length) {
        if (_doctorPayPollTimer) {
            clearInterval(_doctorPayPollTimer);
            _doctorPayPollTimer = null;
        }
        return;
    }
    for (const a of pending) {
        try {
            const res = await fetch(
                '/api/payments/status?registrationId=' +
                    encodeURIComponent(a.id) +
                    '&userId=' +
                    encodeURIComponent(uid),
                { cache: 'no-store' }
            );
            const st = await res.json();
            if (st.paid) {
                await loadApplications(true);
                showPostPaymentWhatsappBanner(a.id);
                loadDoctorDashboardStats();
                loadDoctorOrders();
                loadDoctorReceipts();
                loadDoctorEventTickets();
                return;
            }
        } catch (_) {}
    }
}

let currentlyViewedApp = null;

function refreshOpenApplicationTrackerFromList(apps) {
    if (!currentlyViewedApp || !isApplicationDetailModalOpen()) return;
    const fresh = (apps || []).find((a) => Number(a.id) === Number(currentlyViewedApp.id));
    if (!fresh) return;
    currentlyViewedApp = fresh;
    const statusEl = document.getElementById('view-app-status');
    if (statusEl) {
        statusEl.innerHTML =
            '<strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">' +
            String(fresh.status || '').toUpperCase() +
            '</span>';
    }
    const trackEl = document.getElementById('view-app-tracking');
    if (trackEl) {
        let extra = renderTrackerStepsHtml(fresh.timeline || {});
        extra += renderWhatsappLinkBlock(fresh);
        const pol = summaryCancellationPolicy(fresh.cancellation_policy_json);
        if (pol) {
            extra +=
                '<p style="margin-top:12px;font-size:0.85rem;color:#64748b;"><strong>Cancellation policy:</strong> ' +
                escapeHtml(pol) +
                '</p>';
        }
        if (fresh.terms_conditions) {
            extra +=
                '<p style="margin-top:8px;font-size:0.85rem;color:#64748b;"><strong>Terms:</strong> ' +
                escapeHtml(String(fresh.terms_conditions).slice(0, 400)) +
                (String(fresh.terms_conditions).length > 400 ? '…' : '') +
                '</p>';
        }
        trackEl.innerHTML = extra;
    }
}

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
        <p id="view-app-status"><strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">${app.status.toUpperCase()}</span></p>
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

    let y = pdfCongressHeader(doc, 'Submitted seminar application');
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

function loadEasebuzzCheckoutScript() {
    return new Promise((resolve, reject) => {
        if (typeof EasebuzzCheckout !== 'undefined') return resolve();
        const existing = document.querySelector('script[data-easebuzz-checkout]');
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('Easebuzz checkout failed to load')));
            return;
        }
        const s = document.createElement('script');
        s.src = 'https://ebz-static.easebuzz.in/easecheckout/easebuzz-checkout.js';
        s.async = true;
        s.setAttribute('data-easebuzz-checkout', '1');
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Could not load Easebuzz checkout'));
        document.head.appendChild(s);
    });
}

function submitHostedFormPost(formPost) {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = formPost.action;
    Object.entries(formPost.fields || {}).forEach(([k, v]) => {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = k;
        inp.value = String(v);
        f.appendChild(inp);
    });
    document.body.appendChild(f);
    f.submit();
}

function openPaymentUrlInPage(url, message) {
    if (!url) return false;
    try {
        sessionStorage.setItem(
            'vgmf_payment_return',
            JSON.stringify({ ts: Date.now(), returnTo: window.location.pathname + (window.location.hash || '') })
        );
    } catch (_) {}
    if (message) {
        try {
            sessionStorage.setItem('vgmf_payment_msg', message);
        } catch (_) {}
    }
    window.location.href = url;
    return true;
}

async function openHostedPaymentCheckout(result) {
    const msg =
        result.message ||
        'Redirecting to secure payment. After paying, return to My Applications for your e-ticket.';

    if (result.formPost && result.formPost.action) {
        submitHostedFormPost(result.formPost);
        alert(msg);
        ensureDoctorPaymentPoll();
        return true;
    }

    if (result.paymentUrl) {
        return openPaymentUrlInPage(result.paymentUrl, msg);
    }

    if (result.easebuzzAccessKey && result.easebuzzKey) {
        const payUrl = 'https://pay.easebuzz.in/pay/' + encodeURIComponent(result.easebuzzAccessKey);
        return openPaymentUrlInPage(payUrl, msg);
    }

    return false;
}

function loadRazorpayCheckoutScript() {
    return new Promise((resolve, reject) => {
        if (typeof Razorpay !== 'undefined') return resolve();
        const existing = document.querySelector('script[data-razorpay-checkout]');
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('Razorpay checkout failed to load')));
            return;
        }
        const s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.async = true;
        s.setAttribute('data-razorpay-checkout', '1');
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Could not load Razorpay checkout. Check your internet connection.'));
        document.head.appendChild(s);
    });
}

function openDoctorRazorpayCheckout(result, regId, methodId) {
    const checkoutKey = result.keyId || (result.order && result.order.key_id);
    if (!checkoutKey || !result.order) {
        alert('Online payment could not be started. Try another method or contact the seminar office.');
        return;
    }
                const options = {
        key: checkoutKey,
                    amount: result.order.amount,
        currency: result.order.currency || 'INR',
                    name: 'Vaidya Gogate Memorial Foundation National Seminar',
                    description: 'Seminar Registration',
                    order_id: result.order.id,
                    handler: function (response) {
                        fetch('/api/payments/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    applicationId: regId,
                    paymentData: response,
                    gateway: 'razorpay',
                    mode: result.mode,
                    paymentOption: methodId,
                    userId: doctorNumericUserId()
                })
            })
                .then((r) => r.json())
                .then((verifyResult) => {
                            if (verifyResult.success) {
                        alert(
                            verifyResult.message ||
                                'Payment successful. Your e-ticket is under Participant tickets. Join the seminar WhatsApp group from My Applications when the link appears.'
                        );
                                loadApplications().then(() => {
                                    showPostPaymentWhatsappBanner(regId);
                                });
                        loadDoctorDashboardStats();
                        loadDoctorOrders();
                        loadDoctorReceipts();
                        loadDoctorEventTickets();
                            } else {
                        alert(verifyResult.error || 'Payment verification failed');
                            }
                        });
                    },
                    prefill: {
            name: (currentUser.first_name || '') + ' ' + (currentUser.last_name || ''),
            email: currentUser.email || '',
            contact: currentUser.phone || ''
        },
        theme: { color: '#0f766e' }
                };
                const rzp = new Razorpay(options);
    rzp.on('payment.failed', function (resp) {
        alert(
            (resp.error && resp.error.description) ||
                'Payment failed or was cancelled. You can try again from My Applications.'
        );
    });
    try {
                rzp.open();
    } catch (openErr) {
        console.error(openErr);
        alert('Could not open payment. Allow pop-ups and try again.');
    }
}

function showDoctorPaymentQr(regId, result) {
    let box = document.getElementById('pay-qr-box-' + regId);
    if (!box) {
        box = document.createElement('div');
        box.id = 'pay-qr-box-' + regId;
        box.style.cssText = 'margin-top:12px;padding:12px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;text-align:center;';
        const anchor = document.getElementById('pay-opt-' + regId);
        const parent = anchor ? anchor.closest('.card') || anchor.parentElement : null;
        if (parent) parent.appendChild(box);
    }
    box.innerHTML =
        '<p style="font-weight:600;color:#0f766e;margin:0 0 8px;">Scan UPI QR to pay ₹' +
        escapeHtml(String(result.amount || '')) +
        '</p><img src="' +
        escapeHtml(result.qrImageUrl) +
        '" alt="Payment QR" style="max-width:220px;"><p style="font-size:0.82rem;color:#64748b;margin:8px 0 0;">' +
        escapeHtml(result.message || 'Payment confirms automatically after scan.') +
        '</p><button type="button" class="btn-primary" style="margin-top:8px;background:#64748b;" onclick="doctorCancelPendingPayment(' +
        regId +
        ')">Cancel &amp; try another method</button>';
}

async function doctorCancelPendingPayment(regId) {
    const uid = doctorNumericUserId();
    if (!uid) return;
    if (!confirm('Cancel this payment attempt and choose a different method?')) return;
    try {
        const res = await fetch('/api/payments/cancel-pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationId: regId, userId: uid })
        });
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not cancel');
        const box = document.getElementById('pay-qr-box-' + regId);
        if (box) box.remove();
        alert(data.message || 'Cancelled.');
    } catch (e) {
        alert('Network error');
    }
}
window.doctorCancelPendingPayment = doctorCancelPendingPayment;

async function processPayment(appId, amount, appNo, paymentOption, cancelPending) {
    const uid = doctorNumericUserId();
    if (!uid) {
        alert('Please sign out and sign in again, then try payment.');
        return;
    }
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
        sessionStorage.setItem('doctor_last_pay_reg', String(regId));
    } catch (_) {}
    const methodId = paymentOption || getPaymentOptionForReg(regId);
    if (!methodId && (window.__doctorPaymentOptions || []).length > 1) {
        return alert('Please choose a payment method from the dropdown first.');
    }
    try {
        const res = await fetch('/api/payments/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                registrationId: regId,
                userId: uid,
                methodId,
                paymentOption: methodId,
                cancelPending: !!cancelPending
            })
        });
        let result = {};
        if (window.HttpJson) {
            const parsed = await window.HttpJson.readJsonResponse(res);
            result = parsed.data;
            if (parsed.parseFailed) {
                alert(window.HttpJson.apiErrorMessage(res, result, true));
                return;
            }
            } else {
            try {
                result = await res.json();
            } catch (_) {
                alert('Payment service returned an invalid response. Check that the site is not in maintenance mode and try again.');
                return;
            }
        }
        if (!res.ok || !result.success) {
            if (result.error && String(result.error).includes('already in progress')) {
                if (confirm(result.error + '\n\nCancel the pending attempt and start again?')) {
                    return processPayment(appId, amount, appNo, methodId, true);
                }
            }
            alert(result.error || result.message || 'Payment could not be started.');
            return;
        }
        if (result.paid) {
            alert(result.message || 'Payment recorded.');
            loadApplications().then(() => showPostPaymentWhatsappBanner(regId));
            loadDoctorDashboardStats();
            loadDoctorOrders();
            loadDoctorReceipts();
            loadDoctorEventTickets();
            return;
        }
        if (result.paymentType === 'dqr' && result.qrImageUrl) {
            showDoctorPaymentQr(regId, result);
            ensureDoctorPaymentPoll();
            return;
        }
        if (result.paymentType === 'razorpay_checkout' || result.gateway === 'razorpay') {
            await loadRazorpayCheckoutScript();
            if (typeof Razorpay === 'undefined') {
                alert('Payment checkout could not load. Disable ad blockers and refresh the page.');
                return;
            }
            openDoctorRazorpayCheckout(result, regId, methodId);
            ensureDoctorPaymentPoll();
            return;
        }
        if (
            (result.paymentUrl || result.formPost || result.easebuzzAccessKey) &&
            result.gateway !== 'razorpay'
        ) {
            const opened = await openHostedPaymentCheckout(result);
            if (!opened) {
                alert(
                    result.error ||
                        result.message ||
                        'Could not open payment gateway. Try another method or contact the seminar office.'
                );
            }
            return;
        }
        if (result.paymentType === 'manual_gateway' || result.manualConfirm) {
            alert(
                result.message ||
                    'Payment request recorded. Complete payment using your chosen method; your e-ticket will appear once our team confirms receipt.'
            );
            loadApplications();
            ensureDoctorPaymentPoll();
            return;
        }
        alert(result.message || 'Payment request created.');
        ensureDoctorPaymentPoll();
    } catch (err) {
        console.error(err);
        alert(err.message || 'Payment could not be started. Refresh the page and try again.');
    }
}

window.processPayment = processPayment;

function downloadDoctorCertificate(viewUrl, seminarTitle) {
    const url = String(viewUrl || '');
    if (!url || url === '#') return;
    const w = window.open(url, '_blank');
    if (w) {
        w.addEventListener('load', function onLd() {
            w.removeEventListener('load', onLd);
            try {
                w.print();
            } catch (_) {}
        });
    } else {
        alert('Allow pop-ups to download or print your certificate.');
    }
}

async function loadDoctorCertificateTracking(quiet) {
    const wrap = document.getElementById('doctor-cert-tracking-wrap');
    const live = document.getElementById('cert-track-live');
    if (!wrap || !currentUser) return;
    if (!doctorTabVisible('tab-certificate')) return;
    if (!quiet) wrap.innerHTML = '<p style="color:#94a3b8;text-align:center;">Loading…</p>';
    if (live) {
        live.textContent = 'Updating…';
        live.style.color = '#64748b';
    }
    try {
        const uid = doctorNumericUserId();
        if (!uid) {
            wrap.innerHTML =
                '<p style="color:#b91c1c;text-align:center;">Session invalid. Please sign out and sign in again.</p>';
            return;
        }
        const res = await fetch('/api/doctor/certificate-tracking/' + uid, { cache: 'no-store' });
        let rows = [];
        let parseFailed = false;
        if (window.HttpJson) {
            const parsed = await window.HttpJson.readJsonResponse(res);
            rows = parsed.data;
            parseFailed = parsed.parseFailed;
        } else {
            rows = await res.json();
        }
        if (parseFailed || !res.ok) {
            const msg =
                window.HttpJson && parseFailed
                    ? window.HttpJson.apiErrorMessage(res, rows, true)
                    : (rows && rows.error) || 'Could not load certificate status.';
            throw new Error(msg);
        }
        if (!Array.isArray(rows)) throw new Error('Unexpected response from server.');
        if (!Array.isArray(rows) || !rows.length) {
            wrap.innerHTML =
                '<p style="color:#64748b;text-align:center;">No seminar registrations yet. Register and complete payment to track certificate status here.</p>';
        } else {
            let html =
                '<table class="data-table" style="font-size:0.88rem;"><thead><tr><th>Seminar</th><th>Application No.</th><th>Scans</th><th>Status</th></tr></thead><tbody>';
            rows.forEach((r) => {
                const scanLbl = (r.scanCount || 0) + ' / ' + (r.scansRequired || 1);
                let statusColor = '#64748b';
                if (r.certStatus === 'issued') statusColor = '#15803d';
                else if (r.certStatus === 'awaiting_checkin') statusColor = '#b45309';
                else if (r.certStatus === 'awaiting_approval') statusColor = '#7c3aed';
                html +=
                    '<tr><td>' +
                    escapeHtml(r.seminarTitle || '—') +
                    '</td><td><code>' +
                    escapeHtml(r.applicationNo || '—') +
                    '</code></td><td>' +
                    escapeHtml(scanLbl) +
                    '</td><td style="font-weight:600;color:' +
                    statusColor +
                    ';">' +
                    escapeHtml(r.certStatusLabel || '—') +
                    (r.canDownload && r.certId
                        ? ' <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.78rem;margin-left:6px;" onclick="openDoctorCertificateDownload(' +
                          Number(r.certId) +
                          ',' +
                          Number(r.seminarId) +
                          ');return false;">Download</button>'
                        : '') +
                    '</td></tr>';
            });
            html += '</tbody></table>';
            wrap.innerHTML = html;
        }
        if (live) {
            live.textContent = 'Updated ' + new Date().toLocaleTimeString();
            live.style.color = '#15803d';
        }
    } catch (e) {
        console.error(e);
        if (!quiet) {
            wrap.innerHTML =
                '<p style="color:#b91c1c;text-align:center;">' +
                escapeHtml(e.message || 'Could not load certificate status.') +
                '</p>';
        }
        if (live) live.textContent = 'Update failed';
    }
}

function openDoctorCertificateDownload(certId, seminarId) {
    if (!currentUser) return;
    const uid = doctorNumericUserId();
    if (!uid) return alert('Please sign in again.');
    const viewUrl =
        '/certificate/view?uc=' +
        encodeURIComponent(String(certId)) +
        '&uid=' +
        encodeURIComponent(String(uid));
    downloadDoctorCertificate(viewUrl);
}

async function loadDoctorDashboardStats() {
    if (!currentUser) return;
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v != null && v !== '' ? String(v) : '0';
    };
    try {
        const uid = doctorNumericUserId();
        if (!uid) return;
        const res = await fetch('/api/doctor/dashboard-stats/' + uid);
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            console.warn('dashboard-stats', errBody.error || res.status);
            return;
        }
        const d = await res.json();
        set('stat-registered', d.registered_seminars);
        set('stat-paid', d.paid_or_confirmed);
        set('stat-checked', d.checked_in_seminars);
        set('stat-feedback', d.feedback_submitted);
        set('stat-abstracts', d.case_presentations != null ? d.case_presentations : d.abstracts_submitted);
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
            const dt = o.payment_date ? formatPortalDt(o.payment_date) : '—';
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
            const dt = o.payment_date ? formatPortalDt(o.payment_date) : '—';
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
    const uid = doctorNumericUserId();
    if (!uid) {
        box.innerHTML = '<p style="color:#b91c1c;">Please sign out and sign in again.</p>';
        return;
    }
    try {
        const res = await fetch('/api/doctor/event-tickets/' + uid);
        const rows = await res.json();
        if (!rows || rows.length === 0) {
            box.innerHTML = '<p style="color:#64748b;">No participant tickets yet. After payment is confirmed (or admin issues your e-ticket), your QR entry ticket appears here.</p>';
            return;
        }
        let html = '<div style="display:flex;flex-direction:column;gap:20px;">';
        rows.forEach((t) => {
            const regSt = String(t.registration_status || '').toLowerCase();
            const invalid = regSt === 'cancelled' || regSt === 'rejected' || t.is_valid === 0;
            const qrPayload = ticketQrScanPayload(t);
            const showQr = !invalid && !t.is_scanned && qrPayload;
            const qr = showQr ? ticketQrImageUrl(t) : '';
            const scanned = t.is_scanned
                ? `Checked in · ${t.scan_time ? formatScanDateTime(t.scan_time) : 'venue'}`
                : 'Not scanned yet — show this QR at entry';
            const statusLine = invalid
                ? `<p style="margin:8px 0 0;font-size:0.9rem;color:#b91c1c;font-weight:600;">Invalid — registration ${regSt === 'cancelled' ? 'cancelled' : regSt === 'rejected' ? 'rejected' : 'no longer active'}. Do not use this QR for entry.</p>`
                : `<p style="margin:8px 0 0;font-size:0.85rem;color:#64748b;">${escapeHtml(scanned)}</p>`;
            html += `<div style="border:1px solid ${invalid ? '#fecaca' : '#e2e8f0'};border-radius:12px;padding:16px;display:grid;grid-template-columns:128px 1fr;gap:16px;align-items:start;${invalid ? 'opacity:0.85;background:#fef2f2;' : ''}">
                <div>${qr ? `<img src="${qr}" alt="QR code" style="width:128px;height:128px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;">` : (t.is_scanned ? '<span style="color:#059669;font-size:0.85rem;font-weight:700;"><i class="fas fa-check-circle"></i> QR used at entry</span>' : '<span style="color:#94a3b8;font-size:0.85rem;">QR unavailable</span>')}</div>
                <div>
                    <h4 style="margin:0 0 8px;color:#1a237e;">${escapeHtml(t.seminar_title || 'Seminar')}</h4>
                    <p style="margin:0 0 6px;font-size:0.9rem;"><strong>E‑ticket ID:</strong> <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escapeHtml(t.ticket_id_string || '—')}</code></p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Order:</strong> ${escapeHtml(String(t.order_id_string || '—'))} · <strong>Application:</strong> ${escapeHtml(String(t.application_no || '—'))}</p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Registration:</strong> ${escapeHtml(t.registration_status || '—')} · <strong>Payment:</strong> ${escapeHtml(t.order_status || '—')}</p>
                    ${statusLine}
                    ${
                        !invalid && t.ticket_id_string
                            ? `<p style="margin:12px 0 0;"><a href="/api/doctor/ticket-document/${encodeURIComponent(t.ticket_id_string)}?userId=${encodeURIComponent(String(uid))}" target="_blank" rel="noopener" class="btn-primary" style="display:inline-block;padding:8px 14px;text-decoration:none;font-size:0.88rem;">Download / print e-ticket (PDF)</a></p>`
                            : ''
                    }
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
    if (!sel || !currentUser) return;
    let msgEl = document.getElementById('dfb-eligible-msg');
    if (!msgEl) {
        msgEl = document.createElement('p');
        msgEl.id = 'dfb-eligible-msg';
        msgEl.style.cssText = 'font-size:0.9rem;color:#64748b;margin:0 0 12px;';
        sel.parentElement.insertBefore(msgEl, sel);
    }
    msgEl.textContent = '';
    try {
        const uid = doctorNumericUserId();
        if (!uid) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = 'Sign in again to load feedback seminars.';
            sel.innerHTML = '<option value="">— Select seminar —</option>';
            return;
        }
        const res = await fetch('/api/feedback/eligible-seminars/' + encodeURIComponent(uid), { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
            msgEl.style.color = '#b91c1c';
            msgEl.textContent = data.error || 'Could not load eligible seminars.';
            sel.innerHTML = '<option value="">— Select seminar —</option>';
            return;
        }
        const seminars = Array.isArray(data) ? data : data.seminars || [];
        sel.innerHTML = '<option value="">— Select seminar —</option>';
        seminars.forEach((s) => {
            const label = s.title || 'Seminar';
            sel.innerHTML += `<option value="${s.id}" data-registration-id="${s.registration_id || ''}">${escapeHtml(label)}</option>`;
        });
        if (!seminars.length) {
            msgEl.textContent =
                'No seminars are open for feedback yet. Feedback is available after a seminar you registered for has ended, and only once per seminar.';
        }
    } catch (e) {
        console.error(e);
        msgEl.style.color = '#b91c1c';
        msgEl.textContent = 'Could not load seminars for feedback.';
    }
}

async function loadDashboardFeedbackForm() {
    const host = document.getElementById('dash-feedback-fields');
    if (!host) return;
    try {
        const res = await fetch('/api/public/feedback-form');
        const cfg = await res.json();
        const titleEl = document.querySelector('#tab-feedback .section-title');
        const introEl = document.querySelector('#tab-feedback .tab-intro-feedback');
        if (titleEl && cfg.title) titleEl.textContent = cfg.title;
        if (introEl && cfg.intro) introEl.textContent = cfg.intro;
        host.innerHTML = '';
        (cfg.fields || []).forEach((f) => {
            const wrap = document.createElement('div');
            wrap.className = 'form-group';
            if (f.type === 'rating') {
                let opts = '<option value="">—</option>';
                const max = f.max || 5;
                const min = f.min || 1;
                for (let i = max; i >= min; i--) opts += `<option value="${i}">${i}</option>`;
                wrap.innerHTML = `<label>${escapeHtml(f.label)}</label><select id="dfb-${f.id}" ${f.required ? 'required' : ''}>${opts}</select>`;
            } else if (f.type === 'textarea') {
                wrap.innerHTML = `<label>${escapeHtml(f.label)}</label><textarea id="dfb-${f.id}" rows="${f.rows || 2}" ${f.required ? 'required' : ''}></textarea>`;
            } else if (f.type === 'checkbox') {
                wrap.innerHTML = `<label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="dfb-${f.id}" ${f.defaultChecked ? 'checked' : ''}> ${escapeHtml(f.label)}</label>`;
            } else {
                wrap.innerHTML = `<label>${escapeHtml(f.label)}</label><input type="text" id="dfb-${f.id}" ${f.required ? 'required' : ''}>`;
            }
            host.appendChild(wrap);
        });
    } catch (e) {
        console.warn('feedback form', e);
    }
}

async function submitDashboardFeedback(e) {
    e.preventDefault();
    if (!currentUser) return;
    const seminarSel = document.getElementById('dfb-seminar');
    const seminarId = seminarSel && seminarSel.value;
    if (!seminarId) {
        alert('Please select a seminar.');
        return;
    }
    const regOpt = seminarSel.options[seminarSel.selectedIndex];
    const registrationId =
        regOpt && regOpt.getAttribute('data-registration-id')
            ? parseInt(regOpt.getAttribute('data-registration-id'), 10)
            : null;
    const answers = {};
    document.querySelectorAll('[id^="dfb-"]').forEach((el) => {
        if (el.id === 'dfb-seminar') return;
        const key = el.id.replace(/^dfb-/, '');
        if (el.type === 'checkbox') answers[key] = el.checked;
        else answers[key] = el.value;
    });
    try {
        const res = await fetch('/api/feedback/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                seminarId,
                registrationId: Number.isInteger(registrationId) ? registrationId : null,
                answers
            })
        });
        const data = await res.json();
        if (data.success) {
            alert('Thank you. Your feedback was submitted successfully.');
            document.getElementById('dash-feedback-form').reset();
            document.getElementById('dfb-again').checked = true;
            loadDashboardFeedbackSeminars();
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
    const uid = doctorNumericUserId();
    if (!uid) return;
    const list = document.getElementById('tickets-list');
    if (!list) return;
    try {
        const res = await fetch('/api/support-ticket/user/' + uid);
        const tickets = await res.json();
        if (!res.ok) {
            list.innerHTML =
                '<tr><td colspan="4" style="text-align:center;color:#b91c1c;">' +
                escapeHtml((tickets && tickets.error) || 'Could not load tickets') +
                '</td></tr>';
            return;
        }
        list.innerHTML = '';
        if (!tickets || tickets.length === 0) {
            list.innerHTML = '<tr><td colspan="4" style="text-align: center;">No tickets found.</td></tr>';
            return;
        }
        tickets.forEach((t) => {
            const tid = t.ticket_id || t.tracking_id;
            if (!tid) return;
            const safeId = escapeHtml(String(tid)).replace(/'/g, '&#39;');
            list.innerHTML += `
                <tr>
                    <td><strong>${escapeHtml(String(tid))}</strong></td>
                    <td>${escapeHtml(t.subject || '—')}</td>
                    <td><span style="background: #fef3c7; padding: 5px; border-radius: 5px;">${escapeHtml(t.status || 'open')}</span></td>
                    <td><button type="button" class="btn-primary" style="padding: 5px 10px;" onclick="openTicketThread('${safeId}')">Open</button></td>
                </tr>`;
        });
    } catch (err) {
        console.error(err);
        if (list) {
            list.innerHTML =
                '<tr><td colspan="4" style="text-align:center;color:#b91c1c;">Network error loading tickets.</td></tr>';
        }
    }
}

let currentTicketId = null;
let currentLegacyTrackingId = null;
let supportChatPollTimer = null;

function startSupportChatPoll() {
    stopSupportChatPoll();
    supportChatPollTimer = setInterval(() => {
        if (currentTicketId) loadChatMessages(true);
    }, 5000);
}

function stopSupportChatPoll() {
    if (supportChatPollTimer) {
        clearInterval(supportChatPollTimer);
        supportChatPollTimer = null;
    }
}

async function openTicketThread(id) {
    currentTicketId = id;
    currentLegacyTrackingId = null;
    document.getElementById('support-main-view').classList.add('hidden');
    document.getElementById('support-chat-view').classList.remove('hidden');
    document.getElementById('chat-title').innerText = 'Ticket ' + id;
    await loadChatMessages();
    startSupportChatPoll();
}

function closeChat() {
    currentTicketId = null;
    currentLegacyTrackingId = null;
    stopSupportChatPoll();
    document.getElementById('support-chat-view').classList.add('hidden');
    document.getElementById('support-main-view').classList.remove('hidden');
}

async function loadChatMessages(silent) {
        const box = document.getElementById('chat-messages');
    if (!box) return;
    if (!silent) box.innerHTML = '<p style="color:#64748b;text-align:center;">Loading messages…</p>';
    if (!currentTicketId) {
        box.innerHTML = '<p style="color:#b91c1c;text-align:center;">No ticket selected.</p>';
        return;
    }
    try {
        const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId));
        const ticket = await res.json();
        if (!res.ok) {
            box.innerHTML =
                '<p style="color:#b91c1c;text-align:center;">' +
                escapeHtml((ticket && ticket.error) || 'Could not load messages') +
                '</p>';
            return;
        }
        const titleEl = document.getElementById('chat-title');
        if (titleEl) {
            let t = 'Ticket ' + (ticket.ticket_id || currentTicketId);
            if (ticket.expected_response_at) {
                t +=
                    ' · Expected response ' +
                    new Date(ticket.expected_response_at).toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        dateStyle: 'medium',
                        timeStyle: 'short'
                    }) +
                    ' IST';
            }
            titleEl.innerText = t;
        }
        const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
        if (!messages.length) {
            box.innerHTML = '<p style="color:#64748b;text-align:center;">No messages yet. Send a reply below.</p>';
            return;
        }
        box.innerHTML = '';
        messages.forEach((m) => {
            const st = String(m.sender_type || '').toLowerCase();
            const isDoc = st !== 'admin';
            const viaEmail =
                m.source === 'email'
                    ? ' <span style="font-size:0.72rem;background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;">Email</span>'
                    : '';
            box.innerHTML += `
                <div style="align-self: ${isDoc ? 'flex-end' : 'flex-start'}; background: ${isDoc ? '#0f766e' : 'white'}; color: ${isDoc ? 'white' : '#334155'}; border: 1px solid ${isDoc ? '#0f766e' : '#cbd5e1'}; padding: 10px 15px; border-radius: 8px; max-width: 80%;">
                    <p style="font-size: 0.8rem; margin-bottom: 5px; color: ${isDoc ? '#ccfbf1' : '#64748b'};"><strong>${isDoc ? 'You' : 'Admin'}</strong>${viaEmail} — ${new Date(m.created_at).toLocaleString()}</p>
                    <p>${(m.message || '').replace(/</g, '&lt;')}</p>
                </div>`;
        });
    } catch (err) {
        console.error(err);
        box.innerHTML = '<p style="color:#b91c1c;text-align:center;">Network error loading messages.</p>';
    }
        box.scrollTop = box.scrollHeight;
}

async function sendReply() {
    const msgInput = document.getElementById('chat-reply-msg');
    const msg = (msgInput && msgInput.value.trim()) || '';
    if (!msg) return;
    try {
        if (!currentTicketId) return alert('Open a ticket first.');
        const uid = doctorNumericUserId();
        const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId) + '/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senderId: uid, senderType: 'user', message: msg })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            return alert((data && data.error) || 'Could not send reply');
        }
            msgInput.value = '';
            await loadChatMessages();
    } catch (err) {
        console.error(err);
        }
}

async function submitSupportTicket() {
    const category = document.getElementById('ticket-cat').value;
    const subject = document.getElementById('ticket-subj').value.trim();
    const description = document.getElementById('ticket-desc').value.trim();
    const uid = doctorNumericUserId();
    if (!uid) {
        alert('Session expired. Please sign out and sign in again.');
        return;
    }
    if (!subject || !description) {
        alert('Subject and description are required.');
        return;
    }
    try {
        const res = await fetch('/api/support-ticket/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, category, subject, description })
        });
        const result = await res.json();
        if (!res.ok || !result.success) {
            alert(result.error || 'Could not create support ticket. Please try again.');
            return;
        }
        if (result.success) {
            let msg = 'Ticket created: ' + result.ticketId;
            if (result.expectedResponseDisplay) {
                msg += ' — Expected response by ' + result.expectedResponseDisplay + ' (IST)';
            }
            document.getElementById('ticket-result').innerText = msg;
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
function isDoctorProfileComplete(profile) {
    const p = profile || {};
    return !!(
        String(p.specialization || '').trim() &&
        String(p.registration_no || '').trim() &&
        String(p.hospital_name || '').trim()
    );
}

function updateProfileCompleteBanner(profile) {
    const bar = document.getElementById('profile-complete-banner');
    if (!bar) return;
    bar.style.display = isDoctorProfileComplete(profile) ? 'none' : '';
}

function updateDoctorProfilePhotoUi(profile) {
    const url = profile && (profile.profile_photo_url || profile.profilePhotoUrl);
    const headerImg = document.getElementById('header-profile-photo');
    const sideWrap = document.getElementById('sidebar-profile-photo-wrap');
    const sideImg = document.getElementById('sidebar-profile-photo');
    const prevWrap = document.getElementById('profile-photo-preview-wrap');
    const prevImg = document.getElementById('profile-photo-preview');
    if (url) {
        if (headerImg) {
            headerImg.src = url;
            headerImg.classList.remove('hidden');
        }
        if (sideImg && sideWrap) {
            sideImg.src = url;
            sideWrap.classList.remove('hidden');
        }
        if (prevImg && prevWrap) {
            prevImg.src = url;
            prevWrap.classList.remove('hidden');
        }
    } else {
        if (headerImg) headerImg.classList.add('hidden');
        if (sideWrap) sideWrap.classList.add('hidden');
        if (prevWrap) prevWrap.classList.add('hidden');
    }
}

function formatDoctorAccountDateTime(iso) {
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

function renderDoctorAccountMeta(meta) {
    const createdEl = document.getElementById('profile-account-created');
    const activatedEl = document.getElementById('profile-account-activated');
    const noteEl = document.getElementById('profile-account-activated-note');
    if (!createdEl && !activatedEl) return;
    const m = meta || {};
    if (createdEl) createdEl.textContent = formatDoctorAccountDateTime(m.createdAt);
    if (activatedEl) {
        activatedEl.textContent = m.activatedAt
            ? formatDoctorAccountDateTime(m.activatedAt)
            : m.pendingActivation
              ? 'Pending email verification'
              : '—';
    }
    if (noteEl) {
        noteEl.textContent = m.lastLoginAt
            ? 'Last login: ' + formatDoctorAccountDateTime(m.lastLoginAt)
            : m.pendingActivation
              ? 'Verify your email to activate your account.'
              : '';
    }
}

async function loadProfile() {
    try {
        const uid = doctorNumericUserId();
        if (!uid) return;
        const accountPhoneEl = document.getElementById('profile-account-phone');
        if (accountPhoneEl && currentUser && currentUser.phone) {
            accountPhoneEl.value = currentUser.phone;
        }
        try {
            const accRes = await fetch(`/api/doctor/account/${uid}`);
            if (accRes.ok) {
                const acc = await accRes.json();
                renderDoctorAccountMeta(acc);
            } else if (currentUser) {
                renderDoctorAccountMeta({
                    createdAt: currentUser.created_at,
                    activatedAt: currentUser.activated_at,
                    lastLoginAt: currentUser.last_login_at || currentUser.login_at,
                    pendingActivation: Number(currentUser.email_verified) === 0
                });
            }
        } catch (_) {
            /* account meta optional */
        }
        const res = await fetch(`/api/doctor/profile/${uid}`);
        const profile = await res.json();
        window.__doctorProfile = profile && profile.id ? profile : null;
        
        if (profile && profile.id) {
            document.getElementById('profile-specialization').value = profile.specialization || '';
            document.getElementById('profile-registration-no').value = profile.registration_no || '';
            document.getElementById('profile-qualifications').value = profile.qualifications || '';
            document.getElementById('profile-experience').value = profile.experience_years || '';
            document.getElementById('profile-hospital').value = profile.hospital_name || '';
            document.getElementById('profile-contact').value = profile.contact_number || '';
            document.getElementById('profile-bio').value = profile.bio || '';
        }
        updateDoctorProfilePhotoUi(window.__doctorProfile);
        updateProfileCompleteBanner(window.__doctorProfile);
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}

async function loadDoctorSupplementalPayments() {
    const box = document.getElementById('doctor-supplemental-payments-list');
    if (!box) return;
    const uid = doctorNumericUserId();
    if (!uid) {
        box.innerHTML = '<p style="color:#b91c1c;">Please sign in again.</p>';
        return;
    }
    box.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/doctor/supplemental-payments?userId=' + encodeURIComponent(uid));
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) {
            box.innerHTML = '<p style="color:#64748b;">No additional payments pending.</p>';
            return;
        }
        let html = '<table class="data-table"><thead><tr><th>Title</th><th>Seminar</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>';
        rows.forEach((r) => {
            const st = String(r.status || '').toLowerCase();
            const paid = st === 'paid';
            html +=
                '<tr><td><strong>' +
                escapeHtml(r.title || '—') +
                '</strong>' +
                (r.description ? '<br><span style="font-size:0.85rem;color:#64748b;">' + escapeHtml(r.description) + '</span>' : '') +
                '</td><td>' +
                escapeHtml(r.seminar_title || '—') +
                '</td><td>₹' +
                escapeHtml(String(r.amount != null ? r.amount : '—')) +
                '</td><td>' +
                escapeHtml(paid ? 'Paid' : 'Pending') +
                '</td><td>' +
                (paid
                    ? escapeHtml(r.order_id_string || '—')
                    : '<button type="button" class="btn-success" style="padding:6px 12px;font-size:0.85rem;" onclick="payDoctorSupplemental(' +
                      Number(r.id) +
                      ',' +
                      Number(r.amount) +
                      ')">Pay (test/mock)</button>') +
                '</td></tr>';
        });
        html += '</tbody></table>';
        box.innerHTML = html;
    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Could not load payments.</p>';
    }
}

async function payDoctorSupplemental(id, amount) {
    const uid = doctorNumericUserId();
    if (!uid) return alert('Please sign in again.');
    if (!confirm('Pay additional charge ₹' + amount + ' using test/mock gateway?')) return;
    try {
        const res = await fetch('/api/payments/process-supplemental', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supplementalId: id, userId: uid, methodId: 'mock' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Payment failed');
        alert(data.message || 'Payment recorded.');
        loadDoctorSupplementalPayments();
    } catch (e) {
        alert('Network error');
    }
}
window.payDoctorSupplemental = payDoctorSupplemental;

async function saveProfile(event) {
    event.preventDefault();
    
    const formData = new FormData();
    const uid = doctorNumericUserId();
    if (!uid) return alert('Session invalid. Please sign in again with your email.');
    formData.append('userId', uid);
    formData.append('specialization', document.getElementById('profile-specialization').value);
    formData.append('registration_no', document.getElementById('profile-registration-no').value);
    formData.append('qualifications', document.getElementById('profile-qualifications').value);
    formData.append('experience_years', document.getElementById('profile-experience').value);
    formData.append('hospital_name', document.getElementById('profile-hospital').value);
    formData.append('contact_number', document.getElementById('profile-contact').value);
    formData.append('bio', document.getElementById('profile-bio').value);
    
    let profilePhoto = document.getElementById('profile-photo').files[0];
    if (profilePhoto) {
        try {
            if (window.PortalUpload && typeof window.PortalUpload.compressImageFile === 'function') {
                profilePhoto = await window.PortalUpload.compressImageFile(profilePhoto, {
                    maxDim: 1600,
                    quality: 0.85
                });
            }
        } catch (e) {
            console.warn('Profile photo compress skipped', e);
        }
        formData.append('profilePhoto', profilePhoto);
    }
    
    try {
        const res = await fetch('/api/doctor/profile', {
            method: 'POST',
            body: formData
        });
        let result = {};
        try {
            result = await res.json();
        } catch (_) {
            result = {};
        }
        if (res.ok && result.success) {
            window.__doctorProfile = {
                ...(window.__doctorProfile || {}),
                specialization: document.getElementById('profile-specialization').value,
                registration_no: document.getElementById('profile-registration-no').value,
                hospital_name: document.getElementById('profile-hospital').value
            };
            updateProfileCompleteBanner(window.__doctorProfile);
            alert('✅ Profile saved successfully! You can now apply for seminars.');
            await loadProfile();
            return true;
        }
        const msg =
            result.error ||
            (res.status === 413
                ? 'Photo is too large. Try a smaller image or skip the photo for now.'
                : 'Could not save profile (HTTP ' + res.status + ').');
        alert('Error saving profile: ' + msg);
    } catch (err) {
        console.error('Error saving profile:', err);
        alert('Error saving profile: ' + (err.message || 'Network error. Check connection and try again.'));
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

function seminarResubmitNeedsCertificate(qual) {
    const q = String(qual || '').trim();
    return q === 'PG' || q === 'Practicing Vaidya' || q === 'Practitioner';
}

function closeSeminarDocumentResubmitModal() {
    const modal = document.getElementById('seminar-doc-resubmit-modal');
    if (modal) modal.classList.add('hidden');
    window.__seminarResubmitAppId = null;
}
window.closeSeminarDocumentResubmitModal = closeSeminarDocumentResubmitModal;

function openSeminarDocumentResubmitModal(app) {
    if (!app || !app.id) {
        alert('Application not found. Open My Applications, refresh the page, and try again.');
        return;
    }
    window.__seminarResubmitAppId = app.id;
    let formData = {};
    try {
        formData = JSON.parse(app.form_data || '{}');
    } catch (_) {}
    const label = document.getElementById('seminar-doc-resubmit-label');
    const reasonEl = document.getElementById('seminar-doc-resubmit-reason');
    const ncismEl = document.getElementById('seminar-doc-resubmit-ncism');
    const certEl = document.getElementById('seminar-doc-resubmit-cert');
    const certHint = document.getElementById('seminar-doc-resubmit-cert-hint');
    const modal = document.getElementById('seminar-doc-resubmit-modal');
    const addGroup = document.getElementById('seminar-doc-resubmit-additional-group');
    const certGroup = document.getElementById('seminar-doc-resubmit-cert-group');
    const st = String(app.status || '').toLowerCase();
    const isAdditional = st === 'documents_requested';
    if (!modal || !ncismEl) return;
    if (certGroup) certGroup.style.display = isAdditional ? 'none' : '';
    if (addGroup) addGroup.classList.toggle('hidden', !isAdditional);
    if (ncismEl.parentElement) ncismEl.parentElement.style.display = isAdditional ? 'none' : '';
    if (label) {
        label.textContent =
            'Application ' +
            (app.application_no || app.id) +
            (isAdditional ? ' — upload additional verification documents.' : ' — same application number, corrected files only.');
    }
    let reason = '';
    try {
        const dr =
            typeof app.doc_review === 'object' && app.doc_review
                ? app.doc_review
                : app.doc_review_json
                  ? JSON.parse(app.doc_review_json)
                  : null;
        reason = (dr && dr.rejection_reason) || '';
        if (dr && dr.requested_docs && dr.requested_docs.length && reasonEl) {
            reason += (reason ? '\n' : '') + 'Requested: ' + dr.requested_docs.join(', ');
        }
    } catch (_) {}
    if (reasonEl) {
        if (reason) {
            reasonEl.textContent = 'Admin note: ' + reason;
            reasonEl.classList.remove('hidden');
        } else {
            reasonEl.textContent = '';
            reasonEl.classList.add('hidden');
        }
    }
    ncismEl.value = formData.ncism || '';
    if (certEl) certEl.value = '';
    const needsCert = !isAdditional && seminarResubmitNeedsCertificate(formData.qual);
    if (certEl) certEl.required = needsCert;
    if (certHint) {
        certHint.textContent = needsCert
            ? 'Upload your registration certificate (required for your qualification).'
            : 'Upload a certificate only if admin asked you to replace the file.';
    }
    modal.classList.remove('hidden');
}
window.openSeminarDocumentResubmitModal = openSeminarDocumentResubmitModal;

function openSeminarDocumentResubmitById(regId) {
    const a = (userApplications || []).find((x) => Number(x.id) === Number(regId));
    if (!a) {
        alert('Application not found. Refresh My Applications and try again.');
        return;
    }
    openSeminarDocumentResubmitModal(a);
}
window.openSeminarDocumentResubmitById = openSeminarDocumentResubmitById;

function openSeminarDocumentResubmitByIndex(index) {
    const a = userApplications[index];
    if (!a) return;
    openSeminarDocumentResubmitModal(a);
}

function openSeminarDocumentResubmit(applicationNo) {
    const a = (userApplications || []).find((x) => String(x.application_no) === String(applicationNo));
    if (!a) {
        alert('Application not found. Refresh My Applications and try again.');
        return;
    }
    openSeminarDocumentResubmitModal(a);
}
window.openSeminarDocumentResubmit = openSeminarDocumentResubmit;

async function submitSeminarDocumentResubmit() {
    const appId = window.__seminarResubmitAppId;
    const uid = doctorNumericUserId();
    if (!uid) {
        alert('Please sign out and sign in again, then try re-upload.');
        return;
    }
    if (!appId) {
        alert('Application not found. Close this dialog and open Re-upload again from My Applications.');
        return;
    }
    const ncismEl = document.getElementById('seminar-doc-resubmit-ncism');
    const certEl = document.getElementById('seminar-doc-resubmit-cert');
    const addEl = document.getElementById('seminar-doc-resubmit-additional');
    const addLabelEl = document.getElementById('seminar-doc-resubmit-add-label');
    const app = (userApplications || []).find((x) => Number(x.id) === Number(appId));
    const st = app ? String(app.status || '').toLowerCase() : '';
    const isAdditional = st === 'documents_requested';
    let formData = {};
    if (app) {
        try {
            formData = JSON.parse(app.form_data || '{}');
        } catch (_) {}
    }
    const ncism = String((ncismEl && ncismEl.value) || '').trim();
    if (!isAdditional && !ncism) {
        alert('Enter your NCISM / registration number.');
        return;
    }
    const needsCert = !isAdditional && seminarResubmitNeedsCertificate(formData.qual);
    if (needsCert && (!certEl || !certEl.files || !certEl.files[0])) {
        alert('Please upload your certificate document.');
        return;
    }
    if (isAdditional && (!addEl || !addEl.files || !addEl.files[0])) {
        alert('Please upload the additional document admin requested.');
        return;
    }
    const fd = new FormData();
    fd.append('userId', String(uid));
    if (ncism) fd.append('ncism', ncism);
    if (certEl && certEl.files && certEl.files[0]) {
        const certReady = await prepareUploadFileOrAlert(certEl.files[0]);
        if (!certReady) return;
        fd.append('certificate', certReady);
    }
    if (addEl && addEl.files && addEl.files[0]) {
        const addReady = await prepareUploadFileOrAlert(addEl.files[0]);
        if (!addReady) return;
        fd.append('additionalDoc', addReady);
        if (addLabelEl && addLabelEl.value.trim()) fd.append('additionalDocLabel', addLabelEl.value.trim());
    }
    try {
        const res = await fetch('/api/applications/' + appId + '/resubmit-documents', {
            method: 'POST',
            body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return alert(data.error || 'Resubmit failed');
        closeSeminarDocumentResubmitModal();
        alert(data.message || 'Documents resubmitted.');
        loadApplications();
    } catch (e) {
        console.error(e);
        alert('Network error. Please try again.');
    }
}
window.submitSeminarDocumentResubmit = submitSeminarDocumentResubmit;

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

function initDoctorUploadHints() {
    const PU = window.PortalUpload;
    const regCertInp = document.getElementById('reg-cert-file');
    if (regCertInp) {
        regCertInp.addEventListener('change', () => {
        window.__regCertServerUploaded = false;
        updateRegCertUploadUi({ uploaded: false });
    });
    }
    if (!PU) return;
    PU.bindFileHint(regCertInp, document.getElementById('reg-cert-hint'));
    PU.bindFileHint(
        document.getElementById('seminar-doc-resubmit-cert'),
        document.getElementById('seminar-doc-resubmit-cert-hint')
    );
    const caseInp = document.getElementById('case-files');
    const caseHint = document.getElementById('case-files-hint');
    if (caseInp && caseHint) {
        caseInp.addEventListener('change', () => {
            updateCaseFilesSuccessUi('');
            const files = Array.from(caseInp.files || []);
            if (!files.length) {
                caseHint.textContent =
                    'Each file max ' +
                    UPLOAD_HOST_CAP_MB +
                    ' MB on cloud hosting. Compress PDF/PPT; photos from iPhone are resized automatically.';
                caseHint.style.color = '#64748b';
                return;
            }
            const names = files.map((f) => f.name).join(', ');
            updateCaseFilesSuccessUi(
                files.length + ' file(s) selected (' + names + '). Click Submit to upload and apply.'
            );
            ensureCaseUploadConfig(activeCaseProgramId).then((cfg) => {
                const maxMb = effectiveCaseMaxMb(activeCaseProgram, cfg);
                const lines = files.map((f) => f.name + ' (' + PU.formatBytes(f.size) + ')');
                const over = files.some((f) => f.size > maxMb * 1024 * 1024);
                caseHint.textContent =
                    files.length +
                    ' file(s): ' +
                    lines.join(', ') +
                    (over
                        ? ' — some files exceed ' + maxMb + ' MB; compress or split before submitting.'
                        : ' — OK (max ' + maxMb + ' MB each).');
                caseHint.style.color = over ? '#b91c1c' : '#15803d';
            });
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initRegistrationAddressUi();
        initDoctorUploadHints();
    });
} else {
    initRegistrationAddressUi();
    initDoctorUploadHints();
}

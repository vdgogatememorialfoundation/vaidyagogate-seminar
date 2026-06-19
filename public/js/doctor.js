let currentUser = null;
let currentRegistrationId = null;
let __doctorAllowedTabs = null;
window.__portalFlags = window.__portalFlags || {};

/** Registration / CMS uploads without R2. */
const UPLOAD_HOST_CAP_MB = 4;
/** Case presentation (CV, video) when R2 is not used. */
const CASE_UPLOAD_HOST_CAP_MB = 50;
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
    const requested = (program && program.maxFileSizeMb) || CASE_UPLOAD_HOST_CAP_MB;
    return Math.min(requested, CASE_UPLOAD_HOST_CAP_MB);
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

function normalizeCaseFieldType(type) {
    const t = String(type || 'text').toLowerCase();
    if (t === 'dropdown') return 'select';
    if (t === 'fileupload') return 'file';
    if (t === 'multioption') return 'multiselect';
    return t;
}

function caseFileAcceptAttr(f) {
    const a = String((f && f.accept) || '').toLowerCase();
    if (a === 'cv') return '.pdf,.doc,.docx,image/*';
    if (a === 'video') return 'video/*,.mp4,.mov,.avi,.webm,.mkv';
    if (f && f.key === 'upload_cv') return '.pdf,.doc,.docx,image/*';
    if (f && f.key === 'upload_video') return 'video/*,.mp4,.mov,.avi,.webm,.mkv';
    return '.pdf,.ppt,.pptx,.zip,.docx,video/*,image/*';
}

function caseRequiredFileFieldCount(program) {
    return getCaseEnabledFormFields(program).filter(function (f) {
        const t = normalizeCaseFieldType(f.type);
        return (t === 'file' || f.key === 'files') && f.required !== false;
    }).length;
}

function getCaseFormSnapshot() {
    const snap = {};
    getCaseEnabledFormFields(activeCaseProgram).forEach((f) => {
        if (f.key === 'files') return;
        const t = normalizeCaseFieldType(f.type);
        if (t === 'multiselect') {
            const group = document.getElementById(caseFieldElId(f.key));
            if (group) {
                const checked = [];
                group.querySelectorAll('input.case-ms-opt:checked').forEach((cb) => checked.push(cb.value));
                snap[f.key] = checked.join(', ');
            }
            return;
        }
        const el = document.getElementById(caseFieldElId(f.key));
        if (!el) return;
        if (el.type === 'checkbox' || t === 'checkbox' || t === 'boolean' || t === 'terms') {
            snap[f.key] = el.checked ? '1' : '';
        } else if (el.type === 'file') {
            snap[f.key] = el.files && el.files[0] ? el.files[0].name : '';
        } else {
            snap[f.key] = String(el.value || '').trim();
        }
    });
    return snap;
}

function getCaseAllUploadFiles() {
    const out = [];
    const main = document.getElementById('case-files');
    if (main && main.files) {
        for (let i = 0; i < main.files.length; i++) out.push(main.files[i]);
    }
    document.querySelectorAll('.case-extra-file-input').forEach((inp) => {
        if (inp.files && inp.files[0]) out.push(inp.files[0]);
    });
    return out;
}

function getCaseSelectedFileMeta() {
    const list = [];
    getCaseAllUploadFiles().forEach((f) => {
        list.push({
            name: f.name,
            size: f.size,
            uploaded: !!(window.__caseStagedUploadIds && window.__caseStagedUploadIds.length)
        });
    });
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
    let html =
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
        '</span></div>';
    const previewSkipKeys = new Set(['fname', 'mname', 'lname', 'email', 'phone', 'whatsapp', 'category', 'files']);
    getCaseEnabledFormFields(activeCaseProgram).forEach((field) => {
        if (field.key === 'files' || previewSkipKeys.has(field.key)) return;
        const val = f[field.key];
        if (val == null || String(val).trim() === '') return;
        const t = normalizeCaseFieldType(field.type);
        const display =
            t === 'checkbox' || t === 'boolean' || t === 'terms'
                ? val === '1'
                    ? 'Yes'
                    : 'No'
                : String(val);
        html +=
            '<div class="preview-row"><span class="lbl">' +
            escapeHtmlDoctor(field.label || field.key) +
            '</span><span class="val">' +
            escapeHtmlDoctor(display) +
            '</span></div>';
    });
    box.innerHTML = html + filesHtml;
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

    let y = pdfVgmfCaseHeader(doc, 'Case presentation — draft preview', getCasePreviewApplicationNo());
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
    const pdfSkipKeys = new Set(['fname', 'mname', 'lname', 'email', 'phone', 'whatsapp', 'category', 'files']);
    getCaseEnabledFormFields(activeCaseProgram).forEach((field) => {
        if (field.key === 'files' || pdfSkipKeys.has(field.key)) return;
        const val = f[field.key];
        if (val == null || String(val).trim() === '') return;
        const t = normalizeCaseFieldType(field.type);
        const display =
            t === 'checkbox' || t === 'boolean' || t === 'terms'
                ? val === '1'
                    ? 'Yes'
                    : 'No'
                : val;
        drawTableRow(field.label || field.key, display);
    });
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
    if (
        (caseFormFieldActive(activeCaseProgram, 'fname') || caseFormFieldActive(activeCaseProgram, 'lname')) &&
        typeof validateRegistrationNamesClient === 'function'
    ) {
        const ne = validateRegistrationNamesClient(form);
        if (ne) return alert(ne), null;
    }
    if (caseFormFieldActive(activeCaseProgram, 'email') && typeof validateEmailClient === 'function' && String(form.email || '').trim()) {
        const ev = validateEmailClient(form.email, 'Email');
        if (!ev.valid) return alert(ev.message), null;
        form.email = ev.cleanedEmail;
    }
    if (caseFormFieldActive(activeCaseProgram, 'phone') && typeof validatePhoneClient === 'function' && String(form.phone || '').trim()) {
        const pv = validatePhoneClient(form.phone, 'Phone');
        if (!pv.valid) return alert(pv.message), null;
        form.phone = pv.cleanedPhone;
    }
    if (caseFormFieldActive(activeCaseProgram, 'whatsapp') && typeof validatePhoneClient === 'function' && String(form.whatsapp || '').trim()) {
        const wv = validatePhoneClient(form.whatsapp, 'WhatsApp');
        if (!wv.valid) return alert(wv.message), null;
        form.whatsapp = wv.cleanedPhone;
    }
    for (const field of getCaseEnabledFormFields(activeCaseProgram)) {
        if (field.key === 'files') continue;
        const t = normalizeCaseFieldType(field.type);
        const val = form[field.key];
        if (t === 'multiselect') {
            if (field.required !== false && (val == null || String(val).trim() === '')) {
                return alert('Please select at least one option: ' + (field.label || field.key)), null;
            }
            continue;
        }
        if (t === 'rating') {
            if (field.required !== false && (val == null || String(val).trim() === '')) {
                return alert('Please rate: ' + (field.label || field.key)), null;
            }
            continue;
        }
        if (t === 'checkbox' || t === 'boolean' || t === 'terms') {
            if (field.required !== false && val !== '1') {
                return alert('Please confirm: ' + (field.label || field.key)), null;
            }
            continue;
        }
        if (t === 'file') {
            const el = document.getElementById(caseFieldElId(field.key));
            if (field.required !== false && !(el && el.files && el.files.length)) {
                return alert('Please upload: ' + (field.label || field.key)), null;
            }
            continue;
        }
        if (field.required === false) continue;
        if (val == null || String(val).trim() === '') {
            return alert('Please complete: ' + (field.label || field.key)), null;
        }
        if (t === 'email' && typeof validateEmailClient === 'function') {
            const ev = validateEmailClient(val, field.label || field.key);
            if (!ev.valid) return alert(ev.message), null;
            form[field.key] = ev.cleanedEmail;
        }
        if (t === 'tel' && typeof validatePhoneClient === 'function') {
            const pv = validatePhoneClient(val, field.label || field.key);
            if (!pv.valid) return alert(pv.message), null;
            form[field.key] = pv.cleanedPhone;
        }
    }
    const allFiles = getCaseAllUploadFiles();
    const maxFiles = (activeCaseProgram && activeCaseProgram.maxFilesPerSubmission) || 5;
    const requiredFileCount = caseRequiredFileFieldCount(activeCaseProgram);
    const stagedCount = window.__caseStagedUploadIds && window.__caseStagedUploadIds.length ? window.__caseStagedUploadIds.length : 0;
    if (requiredFileCount > 0 && allFiles.length + stagedCount < requiredFileCount) {
        return (
            alert(
                'Upload all required files (' +
                    requiredFileCount +
                    ' required — e.g. CV and presentation video).'
            ),
            null
        );
    }
    if (allFiles.length > maxFiles) return alert('Maximum ' + maxFiles + ' files'), null;
    return { uid, form, allFiles };
}

async function goToCasePreview() {
    const validated = await validateCaseFormBeforePreviewOrSubmit();
    if (!validated) return;
    const { uid, allFiles } = validated;
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

    if (allFiles && allFiles.length) {
        for (let i = 0; i < allFiles.length; i++) {
            const raw = allFiles[i];
            if (raw.size > maxMb * 1024 * 1024) {
                return alert('Each file must be under ' + maxMb + ' MB ("' + raw.name + '").');
            }
        }
        const useR2 = uploadCfg && window.CaseR2Upload && CaseR2Upload.isEnabled(uploadCfg);
        if (useR2) {
            try {
                setProgress('Uploading documents... 0%');
                const dt = new DataTransfer();
                allFiles.forEach((f) => dt.items.add(f));
                window.__caseStagedUploadIds = await CaseR2Upload.uploadFiles(dt.files, {
                    userId: uid,
                    caseProgramId: activeCaseProgramId,
                    onFileProgress: (idx, total, name, pct) => {
                        setProgress('Uploading ' + (idx + 1) + '/' + total + ': ' + name + ' - ' + pct + '%');
                    }
                });
                window.__caseStagedFileMeta = allFiles.map((f) => ({
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
            window.__caseStagedFileMeta = allFiles.map((f) => ({
                name: f.name,
                size: f.size,
                uploaded: false
            }));
        }
    }

    showCaseApplicationStep('preview');
    await preloadSiteLogoForPdf();
    renderCasePreviewSummary();
    generateCasePreviewPdf();
}

function backFromCasePreview() {
    showCaseApplicationStep('form');
}

function cancelCaseApplication() {
    window.__caseStagedUploadIds = null;
    window.__caseStagedFileMeta = [];
    activeCaseDraftId = null;
    showCaseApplicationStep('instructions');
    const cb = document.getElementById('case-field-agree_terms');
    if (cb) cb.checked = false;
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

const DOCTOR_INTERNAL_ID_MAX = 2147483647;

function doctorNumericUserId() {
    if (!currentUser) return null;
    if (window.__doctorResolvedInternalId) return window.__doctorResolvedInternalId;
    const portalStr = String(currentUser.user_id_string || '').trim();
    const raw = currentUser.id != null ? currentUser.id : currentUser.user_id;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || n > DOCTOR_INTERNAL_ID_MAX) return null;
    if (portalStr && String(n) === portalStr && portalStr.length >= 10) return null;
    return n;
}

function doctorUserIdQuerySuffix() {
    const portal = currentUser && currentUser.user_id_string ? String(currentUser.user_id_string).trim() : '';
    return portal ? '?userIdString=' + encodeURIComponent(portal) : '';
}

let _ensureDoctorInternalIdPromise = null;

async function ensureDoctorInternalUserId() {
    const existing = doctorNumericUserId();
    if (existing) return existing;
    if (!currentUser) return null;
    if (_ensureDoctorInternalIdPromise) return _ensureDoctorInternalIdPromise;
    const portal = String((currentUser.user_id_string || currentUser.id || '').trim());
    if (!portal) return null;
    _ensureDoctorInternalIdPromise = (async () => {
        try {
            const url =
                '/api/doctor/registration-overrides/' +
                encodeURIComponent(portal) +
                '?userIdString=' +
                encodeURIComponent(portal);
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            applyRegistrationOverridesPayload(data);
            if (data.resolvedUserId) {
                currentUser.id = data.resolvedUserId;
                if (typeof PortalAuth !== 'undefined') PortalAuth.setUser('doctor', currentUser);
            }
            return doctorNumericUserId();
        } catch (_) {
            return null;
        } finally {
            _ensureDoctorInternalIdPromise = null;
        }
    })();
    return _ensureDoctorInternalIdPromise;
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

function modulesMapToAllowedSetClient(modulesMap) {
    const m = modulesMap && typeof modulesMap === 'object' ? modulesMap : {};
    const keys = Object.keys(m);
    if (!keys.length) return null;
    if (!keys.some((k) => m[k] === true)) return null;
    return new Set(keys.filter((k) => m[k] === true));
}

function isLegacyVolunteerDefaultModulesClient(userModulesRaw) {
    const userMap = parseDoctorModulesMap(userModulesRaw);
    if (!userMap) return false;
    const defaults = volunteerDoctorModuleDefaults();
    const defaultKeys = Object.keys(defaults);
    const enabledKeys = defaultKeys.filter((k) => userMap[k] === true);
    if (enabledKeys.length !== defaultKeys.length) return false;
    return !Object.keys(userMap).some((k) => userMap[k] === true && !defaults[k]);
}

function expandDoctorRefundTabAccess(allowed) {
    if (!allowed || allowed.has('tab-refunds')) return allowed;
    if (
        allowed.has('tab-payments') ||
        allowed.has('tab-applications') ||
        allowed.has('tab-orders')
    ) {
        const out = new Set(allowed);
        out.add('tab-refunds');
        return out;
    }
    return allowed;
}

function resolveDoctorAllowedTabsClient(category, globalRegular, globalVolunteer, userModulesRaw) {
    const cat = String(category || 'regular').toLowerCase() === 'volunteer' ? 'volunteer' : 'regular';
    const globalMap = cat === 'volunteer' ? globalVolunteer || {} : globalRegular || {};
    let allowed = modulesMapToAllowedSetClient(globalMap);
    if (isLegacyVolunteerDefaultModulesClient(userModulesRaw)) return expandDoctorRefundTabAccess(allowed);
    const userMap = parseDoctorModulesMap(userModulesRaw);
    if (!userMap || !Object.keys(userMap).length) return expandDoctorRefundTabAccess(allowed);
    const hasExplicitOff = Object.keys(userMap).some((k) => userMap[k] === false);
    if (!hasExplicitOff) return expandDoctorRefundTabAccess(modulesMapToAllowedSetClient(userMap));
    const out = new Set();
    const tabIds = [
        'tab-dashboard',
        'tab-profile',
        'tab-seminars',
        'tab-applications',
        'tab-abstract',
        'tab-case-track',
        'tab-volunteer',
        'tab-feedback',
        'tab-support',
        'tab-orders',
        'tab-refunds',
        'tab-receipts',
        'tab-payments',
        'tab-books',
        'tab-ticket',
        'tab-certificate',
        'tab-reset-pwd'
    ];
    tabIds.forEach((tabId) => {
        if (userMap[tabId] === true) {
            out.add(tabId);
            return;
        }
        if (userMap[tabId] === false) return;
        if (allowed === null || allowed.has(tabId)) out.add(tabId);
    });
    return expandDoctorRefundTabAccess(out.size ? out : new Set());
}

function doctorPortalFetchBust() {
    return '_=' + Date.now();
}

function allowedTabsArrayToSet(allowedTabs) {
    if (allowedTabs == null) return null;
    if (!Array.isArray(allowedTabs)) return null;
    return new Set(allowedTabs);
}

function doctorTabModuleEnabled(tabId) {
    return !__doctorAllowedTabs || __doctorAllowedTabs.has(tabId);
}

function doctorLiveChatWidgetEnabled() {
    if (!currentUser) return false;
    const userMap = parseDoctorModulesMap(currentUser && currentUser.doctor_modules);
    if (userMap && userMap['tab-live-chat'] === false) return false;
    if (!__doctorAllowedTabs) return true;
    return __doctorAllowedTabs.has('tab-live-chat') || __doctorAllowedTabs.has('tab-support');
}

function applyDoctorAllowedTabsToDom(allowed) {
    let set = allowed;
    if (set && !(set instanceof Set)) set = new Set(set);
    set = expandDoctorRefundTabAccess(set);
    __doctorAllowedTabs = set;
    document.querySelectorAll('.menu-item[data-tab]').forEach((el) => {
        const tab = el.getAttribute('data-tab');
        if (!tab) return;
        let enabled = doctorTabModuleEnabled(tab);
        if (tab === 'tab-volunteer' && enabled) {
            enabled = !!window.__doctorHasVolunteerAssignments;
        }
        el.classList.toggle('hidden', !enabled);
        el.style.display = enabled ? '' : 'none';
        if (enabled) el.removeAttribute('hidden');
        else el.setAttribute('hidden', 'hidden');
        el.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    });
    if (window.DoctorLiveChatWidget && typeof DoctorLiveChatWidget.setEnabled === 'function') {
        DoctorLiveChatWidget.setEnabled(doctorLiveChatWidgetEnabled());
    }
    document.querySelectorAll('[data-doctor-tab]').forEach((el) => {
        const tab = el.getAttribute('data-doctor-tab');
        if (!tab) return;
        const enabled = doctorTabModuleEnabled(tab);
        el.classList.toggle('hidden', !enabled);
        el.style.display = enabled ? '' : 'none';
        if (enabled) el.removeAttribute('hidden');
        else el.setAttribute('hidden', 'hidden');
        el.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    });
    document.querySelectorAll('.tab-pane[id^="tab-"]').forEach((pane) => {
        const tabId = pane.id;
        if (!doctorTabModuleEnabled(tabId)) {
            pane.classList.add('hidden');
        }
    });
    const visiblePane = document.querySelector('.tab-pane[id^="tab-"]:not(.hidden)');
    const visibleTabId = visiblePane && visiblePane.id;
    const activeMenu = document.querySelector('.menu-item.active[data-tab]');
    const activeTabId = activeMenu && activeMenu.getAttribute('data-tab');
    if (activeTabId && !doctorTabModuleEnabled(activeTabId)) {
        switchTab('tab-dashboard');
    } else if (!visibleTabId || !doctorTabModuleEnabled(visibleTabId)) {
        if (!document.querySelector('.tab-pane:not(.hidden)')) {
            switchTab('tab-dashboard');
        }
    } else if (visibleTabId) {
        syncDoctorUpdatesPanel(visibleTabId);
    }
}

async function loadDoctorPortalModulesGlobal() {
    try {
        const res = await fetch('/api/public/doctor-portal-modules?' + doctorPortalFetchBust(), {
            cache: 'no-store'
        });
        const data = await res.json();
        if (res.ok) {
            window.__doctorPortalModulesGlobal = data;
            return data;
        }
    } catch (_) {}
    return window.__doctorPortalModulesGlobal || { regular: {}, volunteer: {} };
}

async function refreshDoctorPortalAccess() {
    if (!currentUser) return false;
    const portalId = String(currentUser.user_id_string || '').trim();
    let accessUrl = null;
    if (portalId) {
        accessUrl =
            '/api/doctor/portal-access/by-portal-id/' + encodeURIComponent(portalId) + '?' + doctorPortalFetchBust();
    } else {
        let uid = doctorNumericUserId();
        if (!uid) uid = await ensureDoctorInternalUserId();
        if (!uid) return false;
        accessUrl = '/api/doctor/portal-access/' + encodeURIComponent(String(uid)) + '?' + doctorPortalFetchBust();
    }
    try {
        const res = await fetch(accessUrl, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
            delete window.__doctorPortalAllowedTabs;
            delete window.__doctorPortalUseGlobalModules;
            return false;
        }
        window.__doctorPortalAllowedTabs = Array.isArray(data.allowedTabs) ? data.allowedTabs : null;
        window.__doctorPortalUseGlobalModules = data.useGlobalModules !== false;
        window.__doctorPortalModulesGlobal = {
            regular: data.globalRegular || {},
            volunteer: data.globalVolunteer || {}
        };
        if (data.userId != null) {
            currentUser.id = data.userId;
            window.__doctorResolvedInternalId = data.userId;
        }
        currentUser.doctor_category = data.doctor_category || 'regular';
        currentUser.doctor_modules = data.doctor_modules ?? null;
        if (typeof PortalAuth !== 'undefined') PortalAuth.setUser('doctor', currentUser);
        return true;
    } catch (_) {
        delete window.__doctorPortalAllowedTabs;
        delete window.__doctorPortalUseGlobalModules;
        return false;
    }
}

function scheduleDoctorModuleReapply() {
    if (!currentUser) return;
    setTimeout(() => {
        if (currentUser) applyDoctorModuleAccessFromUser(currentUser).catch(() => {});
    }, 400);
}

let _doctorPortalAccessRefreshTimer = null;

function initDoctorPortalAccessRefreshOnVisible() {
    if (window.__doctorPortalAccessVisibilityBound) return;
    window.__doctorPortalAccessVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !currentUser) return;
        clearTimeout(_doctorPortalAccessRefreshTimer);
        _doctorPortalAccessRefreshTimer = setTimeout(() => {
            sendDoctorClientTelemetry();
            refreshDoctorPortalAccess()
                .catch(() => {})
                .then(() => applyDoctorModuleAccessFromUser(currentUser))
                .then(() => initDoctorVolunteerNav())
                .then(() => applyDoctorModuleAccessFromUser(currentUser));
        }, 2000);
    });
}

function volunteerDoctorModuleDefaults() {
    return {
        'tab-dashboard': true,
        'tab-profile': true,
        'tab-seminars': true,
        'tab-applications': true,
        'tab-abstract': true,
        'tab-case-track': true,
        'tab-volunteer': true,
        'tab-ticket': true,
        'tab-certificate': true,
        'tab-reset-pwd': true
    };
}

async function applyDoctorModuleAccessFromUser(user) {
    if (Array.isArray(window.__doctorPortalAllowedTabs)) {
        applyDoctorAllowedTabsToDom(new Set(window.__doctorPortalAllowedTabs));
        return;
    }
    const refreshed = await refreshDoctorPortalAccess().catch(() => false);
    if (refreshed && Array.isArray(window.__doctorPortalAllowedTabs)) {
        applyDoctorAllowedTabsToDom(new Set(window.__doctorPortalAllowedTabs));
        return;
    }
    const globalCfg = await loadDoctorPortalModulesGlobal();
    const allowed = resolveDoctorAllowedTabsClient(
        user && user.doctor_category,
        globalCfg.regular,
        globalCfg.volunteer,
        null
    );
    applyDoctorAllowedTabsToDom(allowed);
}

async function loadPortalFlags() {
    try {
        const res = await fetch('/api/public/portal-flags', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok && data) window.__portalFlags = data;
    } catch (_) {}
}

const DOCTOR_TRACK_POLL_MS = 7000;
const SUPPORT_CHAT_POLL_MS = 8000;
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
    return (
        doctorTabVisible('tab-applications') ||
        isApplicationDetailModalOpen() ||
        (userApplications || []).some((a) => {
            const tl = a.timeline || {};
            return tl.cancellationLivePending || tl.hasCancellationTracking;
        })
    );
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
        stopRefundTrackingPoll();
        return;
    }
    if (shouldPollSeminarTracking()) startSeminarTrackingPoll();
    else stopSeminarTrackingPoll();
    if (doctorTabVisible('tab-case-track')) startCaseTrackingPoll();
    else stopCaseTrackingPoll();
    if (shouldPollRefundTracking()) startRefundTrackingPoll();
    else stopRefundTrackingPoll();
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
        '<label style="display:block;margin-top:10px;font-size:0.85rem;font-weight:600;color:#0f766e;">' +
        escapeHtml(i18nT('pay.chooseMethod')) +
        '</label><select id="pay-opt-' +
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
    const rz = opts.find((o) => o.gateway === 'razorpay' || String(o.type || '').includes('razorpay'));
    if (rz) return rz.id;
    return opts[0] ? opts[0].id : '';
}

function defaultPaymentMethodForPayButton() {
    const opts = window.__doctorPaymentOptions || [];
    if (!opts.length) return '';
    const rz = opts.find((o) => o.gateway === 'razorpay' || String(o.type || '').includes('razorpay'));
    if (rz) return rz.id;
    return opts.length === 1 ? opts[0].id : '';
}

function bindDoctorPayButtonDelegation() {
    if (window.__doctorPayClickBound) return;
    window.__doctorPayClickBound = true;
    const root = document.getElementById('dashboard-main') || document.body;
    root.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.doctor-pay-btn') : null;
        if (!btn || btn.disabled) return;
        e.preventDefault();
        const regId = parseInt(btn.getAttribute('data-reg-id') || '', 10);
        const amount = parseFloat(btn.getAttribute('data-amount') || '0');
        const appNo = btn.getAttribute('data-app-no') || '';
        const method = btn.getAttribute('data-method') || '';
        if (Number.isNaN(regId) || regId < 1) return;
        processPayment(regId, amount, appNo, method || undefined);
    });
}
window.bindDoctorPayButtonDelegation = bindDoctorPayButtonDelegation;
window.getPaymentOptionForReg = getPaymentOptionForReg;

function renderTrackerStepsHtml(timeline) {
    if (!timeline) return '';
    if (timeline.disqualified) {
        return (
            '<div class="sat-live-track sat-live-track--error">' +
            '<div class="vtrk-header cancelled"><div class="vtrk-headline">Application disqualified</div>' +
            '<div class="vtrk-subheadline">' +
            escapeHtml(timeline.disqualifiedAt ? formatTrackDateTime(timeline.disqualifiedAt) : 'Contact the seminar office.') +
            '</div></div></div>'
        );
    }
    if (timeline.rejected && !timeline.hasCancellationTracking) {
        return (
            '<div class="sat-live-track sat-live-track--error">' +
            '<div class="vtrk-header cancelled"><div class="vtrk-headline">Application rejected</div>' +
            '<div class="vtrk-subheadline">This application was rejected.</div></div></div>'
        );
    }
    const steps = timeline.steps || [];
    if (!steps.length && timeline.cancelled && !timeline.hasCancellationTracking) {
        return (
            '<div class="sat-live-track sat-live-track--error">' +
            '<div class="vtrk-header cancelled"><div class="vtrk-headline">Application cancelled</div>' +
            '<div class="vtrk-subheadline">This registration was cancelled. Check <strong>Refund tracking</strong> for refund updates.</div></div></div>'
        );
    }
    if (!steps.length) return '';

    let completed = 0;
    let activeStep = null;
    steps.forEach(function (step) {
        if (step.state === 'completed') completed++;
        if (step.state === 'active') activeStep = step;
    });
    const progressPct = Math.min(
        100,
        Math.round(((completed + (activeStep ? 0.45 : 0)) / steps.length) * 100)
    );
    const headline = timeline.cancelled
        ? timeline.cancellationLivePending
            ? 'Cancellation & refund in progress'
            : 'Application cancelled'
        : activeStep
          ? activeStep.title
          : completed >= steps.length
            ? 'Journey complete'
            : 'Tracking your application';
    const subheadline = timeline.cancelled
        ? timeline.cancellationLivePending
            ? 'Live Razorpay refund updates appear below as your refund is processed.'
            : 'Your cancellation and refund journey is shown below.'
        : activeStep
          ? activeStep.desc || 'We will update this timeline automatically.'
          : completed >= steps.length
            ? 'All steps completed for this application.'
            : 'Live updates every few seconds while this page is open.';

    let html =
        '<div class="sat-live-track sat-live-track--enter">' +
        '<div class="vtrk-header ' +
        (timeline.cancelled ? 'cancelled' : 'live') +
        '">' +
        (timeline.cancelled || timeline.cancellationLivePending
            ? '<span class="vtrk-live"><span class="vtrk-dot"></span>' +
              (timeline.cancellationLivePending ? 'Live refund tracking' : 'Cancelled') +
              '</span>'
            : '<span class="vtrk-live"><span class="vtrk-dot"></span>Live tracking</span>') +
        '<div class="vtrk-headline">' +
        escapeHtml(headline) +
        '</div>' +
        '<div class="vtrk-subheadline">' +
        escapeHtml(subheadline) +
        '</div>' +
        '<div class="vtrk-progress-wrap"><div class="vtrk-progress-bar sat-progress-animate" style="width:' +
        progressPct +
        '%"></div></div>' +
        '<div class="sat-progress-label">' +
        progressPct +
        '% complete · ' +
        completed +
        ' of ' +
        steps.length +
        ' milestones</div>' +
        '</div>';
    if (timeline.cancellationLivePending) {
        html +=
            '<div style="margin:0 0 10px;padding:8px 12px;background:linear-gradient(135deg,#fff7ed,#f8fafc);border:1px solid #fed7aa;border-radius:8px;font-size:0.82rem;color:#b45309;">' +
            '<strong><i class="fas fa-undo-alt"></i> Cancellation &amp; Razorpay refund</strong> — live updates below</div>';
    }
    const ct = timeline.cancellationTracking;
    if (ct && ct.razorpayLive && (ct.razorpayLive.providerRefundId || ct.razorpayLive.providerStatus)) {
        const rz = ct.razorpayLive;
        html +=
            '<div style="margin:0 0 10px;padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:0.82rem;color:#0c4a6e;">' +
            '<strong>Razorpay:</strong> ' +
            escapeHtml(ct.refundStatusLabel || '') +
            (rz.providerRefundId ? ' · ' + escapeHtml(rz.providerRefundId) : '') +
            (rz.providerStatus ? ' · ' + escapeHtml(String(rz.providerStatus).toUpperCase()) : '') +
            '</div>';
    }
    html += '<div class="vtrk-steps">';

    steps.forEach(function (step, idx) {
        const isLast = idx === steps.length - 1;
        const cls =
            step.state === 'completed'
                ? 'vtrk-step done sat-step-pop'
                : step.state === 'cancelled'
                  ? 'vtrk-step done sat-step-pop'
                  : step.state === 'active'
                    ? 'vtrk-step active sat-step-pop sat-step-active-glow'
                    : 'vtrk-step upcoming';
        const whenHtml =
            step.at && step.state !== 'upcoming'
                ? '<span class="vtrk-step-when"><i class="fas fa-clock"></i> ' +
                  escapeHtml(formatTrackDateTime(step.at)) +
                  '</span>'
                : step.state === 'upcoming'
                  ? '<span class="vtrk-step-when sat-step-upcoming"><i class="fas fa-hourglass-half"></i> Upcoming</span>'
                  : '';
        const iconHtml =
            step.state === 'completed'
                ? '<i class="fas fa-check"></i>'
                : step.state === 'cancelled'
                  ? '<i class="fas fa-times" style="color:#b91c1c;"></i>'
                  : step.state === 'active'
                    ? '<i class="fas ' + escapeHtml(step.icon || 'fa-circle-notch') + ' sat-icon-spin"></i>'
                    : '<i class="fas ' + escapeHtml(step.icon || 'fa-circle') + '"></i>';

        html +=
            '<div class="' +
            cls +
            '" style="animation-delay:' +
            idx * 0.07 +
            's">' +
            '<div class="vtrk-step-left"><div class="vtrk-step-circle">' +
            iconHtml +
            '</div>' +
            (isLast ? '' : '<div class="vtrk-step-line"></div>') +
            '</div><div class="vtrk-step-body"><div class="vtrk-step-title">' +
            escapeHtml(step.title || '') +
            '</div><div class="vtrk-step-sub">' +
            escapeHtml(step.desc || '') +
            '</div>' +
            whenHtml +
            '</div></div>';
    });

    html += '</div></div>';
    if (timeline.hasCancellationTracking || timeline.cancelled) {
        html +=
            '<p style="margin:12px 0 0;text-align:center;">' +
            '<button type="button" class="btn-primary" style="background:#0f766e;border:none;font-size:0.88rem;padding:10px 18px;" ' +
            'onclick="openDoctorRefundModule()">Open Refund tracking</button></p>';
    }
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

function renderRefundTrackingStepsHtml(steps) {
    if (!steps || !steps.length) return '';
    return renderTrackerStepsHtml({ steps: steps });
}

function renderRefundEligibilityHtml(eligibility) {
    if (!eligibility) return '';
    const tone = eligibility.applicable ? '#047857' : '#92400e';
    const bg = eligibility.applicable ? '#ecfdf5' : '#fffbeb';
    const border = eligibility.applicable ? '#a7f3d0' : '#fde68a';
    let html =
        '<div style="background:' +
        bg +
        ';border:1px solid ' +
        border +
        ';border-radius:8px;padding:12px;margin:10px 0;line-height:1.5;">' +
        '<p style="margin:0 0 6px;font-weight:700;color:' +
        tone +
        ';">Refund eligibility (IST · ' +
        escapeHtml(eligibility.evaluatedAtIst || 'now') +
        ')</p>';
    if (eligibility.daysUntilLabel) {
        html += '<p style="margin:0 0 6px;font-size:0.85rem;color:#475569;">' + escapeHtml(eligibility.daysUntilLabel) + '</p>';
    }
    if (!eligibility.cancellationAllowed) {
        html +=
            '<p style="margin:0;font-size:0.88rem;color:#b91c1c;">' +
            escapeHtml(eligibility.cancellationReason || 'Cancellation is not available.') +
            '</p></div>';
        return html;
    }
    html +=
        '<p style="margin:0 0 8px;font-size:0.9rem;">If approved now: <strong>' +
        (eligibility.eligiblePercent || 0) +
        '%</strong> — <strong>₹' +
        (eligibility.eligibleAmount || 0) +
        '</strong>' +
        (eligibility.orderAmount > 0 ? ' of ₹' + eligibility.orderAmount : '') +
        '</p>';
    if (eligibility.insideNoRefundWindow && eligibility.noRefundWithinDays != null) {
        html +=
            '<p style="margin:0 0 8px;font-size:0.85rem;color:#b45309;">Inside no-refund window (' +
            eligibility.noRefundWithinDays +
            ' days before event).</p>';
    }
    if (eligibility.tiers && eligibility.tiers.length) {
        html += '<ul style="margin:0;padding-left:18px;font-size:0.84rem;color:#475569;">';
        eligibility.tiers.forEach(function (t) {
            html +=
                '<li style="margin:4px 0;' +
                (t.active ? 'font-weight:700;color:#047857;' : '') +
                '">' +
                escapeHtml(t.label) +
                (t.active ? ' ✓ applies now' : '') +
                '</li>';
        });
        html += '</ul>';
    }
    html += '</div>';
    return html;
}

function renderDoctorBankUtrBlock(bankUtr) {
    const utr = String(bankUtr || '').trim();
    if (!utr) return '';
    return (
        '<div style="margin-top:8px;padding:10px 12px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;font-size:0.84rem;color:#065f46;line-height:1.5;">' +
        '<strong><i class="fas fa-university"></i> Bank UTR / RRN</strong><br>' +
        '<code style="font-size:0.95rem;font-weight:700;letter-spacing:0.04em;">' +
        escapeHtml(utr) +
        '</code><br>' +
        '<span style="font-size:0.78rem;color:#047857;">Share this reference with your bank or UPI app if the refund credit is not visible yet.</span>' +
        '</div>'
    );
}

function renderCancellationRefundBlock(a) {
    const tr = a && a.cancellationTracking;
    if (!tr) return '';
    const st = String(tr.status || '').toLowerCase();
    const rs = String(tr.refundStatus || 'none').toLowerCase();
    const livePending =
        st === 'pending' || rs === 'pending' || rs === 'processing' || rs === 'manual_pending';
    const tone =
        tr.refundStatusTone === 'success'
            ? '#047857'
            : tr.refundStatusTone === 'error'
              ? '#b91c1c'
              : tr.refundStatusTone === 'pending'
                ? '#b45309'
                : '#475569';
    const rz = tr.razorpayLive || null;
    const latestRz = (tr.refunds || []).find((r) => r.gateway === 'razorpay') || null;
    const bankUtr =
        tr.bankUtr ||
        (rz && rz.bankUtr) ||
        (latestRz && (latestRz.bankUtr || (latestRz.razorpay && latestRz.razorpay.bankUtr))) ||
        null;
    let badge =
        '<div style="background:linear-gradient(135deg,#fff7ed,#f8fafc);border:1px solid #fed7aa;border-radius:10px;padding:10px 14px;margin-bottom:10px;">' +
        (livePending
            ? '<span style="display:inline-flex;align-items:center;gap:6px;font-size:0.72rem;font-weight:700;color:#b45309;text-transform:uppercase;margin-bottom:6px;"><span class="vtrk-dot" style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block;animation:satPulse 1.4s ease-in-out infinite;"></span>Live cancellation &amp; Razorpay refund tracking</span><br>'
            : '') +
        '<span style="font-weight:700;color:#334155;"><i class="fas fa-undo-alt"></i> Cancellation request · ' +
        escapeHtml(String(tr.status || '').toUpperCase()) +
        '</span>';
    if (tr.refundAmount > 0) {
        badge +=
            ' · Policy refund <strong>₹' +
            escapeHtml(String(tr.refundAmount)) +
            '</strong> (' +
            escapeHtml(String(tr.refundPercent || 0)) +
            '%)';
    }
    badge +=
        '<br><span style="font-size:0.85rem;color:' +
        tone +
        ';"><strong>Refund:</strong> ' +
        escapeHtml(tr.refundStatusLabel || '') +
        (tr.providerRefundId ? ' · Ref: ' + escapeHtml(tr.providerRefundId) : '') +
        '</span>';
    if (rz && (rz.providerRefundId || rz.providerStatus)) {
        badge +=
            '<div style="margin-top:8px;padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:0.82rem;color:#0c4a6e;line-height:1.5;">' +
            '<strong><i class="fas fa-bolt"></i> Razorpay</strong><br>' +
            (rz.providerRefundId
                ? 'Refund ID: <code style="font-size:0.78rem;">' + escapeHtml(rz.providerRefundId) + '</code><br>'
                : '') +
            (rz.providerStatus
                ? 'Gateway status: <strong>' + escapeHtml(String(rz.providerStatus).toUpperCase()) + '</strong><br>'
                : '') +
            (rz.summary && rz.summary.paymentId
                ? 'Payment ID: <code style="font-size:0.78rem;">' + escapeHtml(rz.summary.paymentId) + '</code><br>'
                : '') +
            (rz.summary && rz.summary.speedProcessed
                ? 'Speed: ' + escapeHtml(rz.summary.speedProcessed) + '<br>'
                : '') +
            (rz.failureReason
                ? '<span style="color:#b91c1c;">Reason: ' + escapeHtml(rz.failureReason) + '</span>'
                : livePending
                  ? 'Updates automatically when Razorpay processes the refund.'
                  : '') +
            renderDoctorBankUtrBlock(bankUtr || (rz.summary && rz.summary.bankUtr)) +
            '</div>';
    } else if (latestRz && latestRz.providerRefundId) {
        badge +=
            '<div style="margin-top:8px;font-size:0.82rem;color:#64748b;">Razorpay ref: ' +
            escapeHtml(latestRz.providerRefundId) +
            (latestRz.providerStatus ? ' · ' + escapeHtml(String(latestRz.providerStatus).toUpperCase()) : '') +
            '</div>' +
            renderDoctorBankUtrBlock(bankUtr);
    } else if (bankUtr) {
        badge += renderDoctorBankUtrBlock(bankUtr);
    }
    badge += '</div>';
    if (!tr.trackingSteps || !tr.trackingSteps.length) return badge;
    return badge + renderRefundTrackingStepsHtml(tr.trackingSteps);
}

function cancellationRowToTracking(row) {
    if (!row) return null;
    return {
        status: row.status,
        refundStatus: row.refundStatus || row.refund_status || 'none',
        refundStatusLabel: row.refundStatusLabel,
        refundStatusTone: row.refundStatusTone,
        refundAmount: row.refundAmount != null ? row.refundAmount : row.refund_amount,
        refundPercent: row.refundPercent != null ? row.refundPercent : row.refund_percent,
        providerRefundId: row.providerRefundId || row.provider_refund_id || null,
        bankUtr: row.bankUtr || row.bank_utr || null,
        trackingSteps: row.trackingSteps || [],
        refunds: row.refunds || [],
        razorpayLive: row.razorpayLive || null
    };
}

function renderDoctorRefundModuleCard(row) {
    const tr = cancellationRowToTracking(row);
    if (!tr) return '';
    const appNo = escapeHtml(row.applicationNo || row.application_no || '—');
    const seminar = escapeHtml(row.seminarTitle || row.seminar_title || '');
    const eventDate = row.eventDate || row.event_date;
    const requestedAt = row.requestedAt || row.requested_at;
    const reviewedAt = row.reviewedAt || row.reviewed_at;
    const orderAmt = row.orderAmount != null ? row.orderAmount : row.order_amount;
    const regSt = String(row.registrationStatus || row.registration_status || '').toLowerCase();
    const meta =
        '<div style="padding:16px 16px 0;">' +
        '<h4 style="color:#1a237e;margin-bottom:8px;"><i class="fas fa-undo-alt"></i> ' +
        appNo +
        (seminar ? ' · ' + seminar : '') +
        '</h4>' +
        '<p style="font-size:0.88rem;color:#475569;margin:0 0 12px;">' +
        (eventDate ? '<strong>Event:</strong> ' + escapeHtml(formatEventDate(eventDate)) + ' · ' : '') +
        '<strong>Application status:</strong> ' +
        escapeHtml(regSt ? regSt.replace(/_/g, ' ').toUpperCase() : '—') +
        (orderAmt != null ? ' · <strong>Paid:</strong> ₹' + escapeHtml(String(orderAmt)) : '') +
        '</p>' +
        (requestedAt
            ? '<p style="font-size:0.82rem;color:#64748b;margin:0 0 12px;">Requested ' +
              escapeHtml(formatTrackDateTime(requestedAt)) +
              (reviewedAt ? ' · Reviewed ' + escapeHtml(formatTrackDateTime(reviewedAt)) : '') +
              '</p>'
            : '') +
        '</div>';
  return (
        '<div class="card sat-app-card" style="margin-bottom:15px;border-top:4px solid #b45309;overflow:hidden;padding:0;">' +
        meta +
        '<div style="padding:0 16px 16px;">' +
        renderCancellationRefundBlock({ cancellationTracking: tr }) +
        '</div></div>'
    );
}

let __doctorRefundRequests = [];
let _lastRefundTrackFingerprint = '';
let refundTrackPollTimer = null;

function refundTrackFingerprint(rows) {
    return (rows || [])
        .map((r) => {
            const tr = cancellationRowToTracking(r);
            const stepSig = (tr && tr.trackingSteps ? tr.trackingSteps : [])
                .map((s) => s.key + ':' + s.state + ':' + (s.at || ''))
                .join(',');
            return [
                r.id,
                r.status,
                tr && tr.refundStatus,
                tr && tr.refundAmount,
                tr && tr.providerRefundId,
                tr && tr.bankUtr,
                stepSig,
                r.reviewedAt || r.reviewed_at || ''
            ].join(':');
        })
        .join('|');
}

function doctorRefundLivePending(rows) {
    return (rows || []).some((r) => {
        const st = String(r.status || '').toLowerCase();
        const rs = String((r.refundStatus || r.refund_status || 'none')).toLowerCase();
        return st === 'pending' || rs === 'pending' || rs === 'processing' || rs === 'manual_pending';
    });
}

async function loadDoctorRefundsModule(silentPoll) {
    const uid = doctorNumericUserId();
    const container = document.getElementById('refunds-tracker-container');
    if (!uid) {
        if (container) container.innerHTML = '<p style="color:#64748b;">Please sign in to track refunds.</p>';
        return;
    }
    if (!silentPoll && container) container.innerHTML = '<p style="color:#64748b;">Loading refund activity…</p>';
    try {
        const res = await fetch('/api/doctor/cancellation-requests?userId=' + encodeURIComponent(uid), {
            cache: 'no-store'
        });
        const rows = await res.json().catch(() => []);
        if (!res.ok) {
            const msg = (rows && rows.error) || 'Could not load refund tracking.';
            if (container) container.innerHTML = '<p style="color:#b91c1c;">' + escapeHtml(msg) + '</p>';
            return;
        }
        __doctorRefundRequests = Array.isArray(rows) ? rows : [];
        const fp = refundTrackFingerprint(__doctorRefundRequests);
        if (silentPoll && fp === _lastRefundTrackFingerprint) return;
        _lastRefundTrackFingerprint = fp;
        if (!container) return;
        if (!__doctorRefundRequests.length) {
            container.innerHTML =
                '<p style="color:#64748b;margin:0;">No cancellation or refund activity yet. When you submit a cancellation request and it is approved, your refund journey will appear here with live Razorpay updates.</p>' +
                '<p style="margin:12px 0 0;font-size:0.88rem;color:#64748b;">You can request cancellation from <strong>Track seminar applications</strong> for eligible registrations.</p>';
            return;
        }
        container.innerHTML = __doctorRefundRequests.map((r) => renderDoctorRefundModuleCard(r)).join('');
    } catch (e) {
        console.warn('[refunds]', e);
        if (container && !silentPoll) {
            container.innerHTML = '<p style="color:#b91c1c;">Network error loading refund tracking.</p>';
        }
    }
}

function shouldPollRefundTracking() {
    return doctorTabVisible('tab-refunds');
}

function stopRefundTrackingPoll() {
    if (refundTrackPollTimer) {
        clearInterval(refundTrackPollTimer);
        refundTrackPollTimer = null;
    }
    const live = document.getElementById('refund-track-live');
    if (live) live.classList.add('hidden');
}

function startRefundTrackingPoll() {
    stopRefundTrackingPoll();
    const live = document.getElementById('refund-track-live');
    if (live) live.classList.remove('hidden');
    refundTrackPollTimer = setInterval(() => {
        if (shouldPollRefundTracking()) loadDoctorRefundsModule(true);
    }, DOCTOR_TRACK_POLL_MS);
}

function renderSeminarApplicationTrackerCard(a) {
    const tl = a.timeline || {};
    const payAmt =
        a.payment_amount != null && Number.isFinite(Number(a.payment_amount)) && Number(a.payment_amount) >= 0
            ? Number(a.payment_amount)
            : Number(a.seminar_price) > 0
              ? Number(a.seminar_price)
              : 1500;
    const st = String(a.status || '').toLowerCase();
    if (st === 'draft') {
        return (
            '<div class="card" style="margin-bottom:15px;border-top:4px solid #0ea5e9;">' +
            '<h4 style="color:#0369a1;margin-bottom:10px;"><i class="fas fa-file-alt"></i> Draft — ' +
            escapeHtml(a.application_no) +
            '</h4>' +
            '<p style="color:#64748b;font-size:0.9rem;">Saved but not submitted. Complete and submit while registration is open.</p>' +
            '<button type="button" class="btn-primary" onclick="resumeDraftApplication(' +
            Number(a.id) +
            ')">Continue draft</button></div>'
        );
    }
    const isPaid = st === 'completed' || st === 'checked_in';
    let waitlistBlock = '';
    if (st === 'waitlisted') {
        waitlistBlock =
            '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:12px;">' +
            '<p style="margin:0;font-weight:600;color:#92400e;"><i class="fas fa-clock"></i> On waiting list</p>' +
            '<p style="margin:8px 0 0;font-size:0.9rem;color:#78350f;">No payment required yet. If a seat is offered, you will receive a payment link by email and can pay from this dashboard.</p></div>';
    }
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
    const defaultPayMethod = defaultPaymentMethodForPayButton();
    const payBtn =
        st === 'approved_pending_payment' && !isPaid
            ? paymentGatewaySelectHtml(a.id) +
              '<button type="button" class="btn-success doctor-pay-btn" style="margin-top:10px;" ' +
              'data-reg-id="' +
              escapeHtml(String(a.id)) +
              '" data-amount="' +
              escapeHtml(String(payAmt)) +
              '" data-app-no="' +
              escapeHtml(String(a.application_no || '')) +
              '" data-method="' +
              escapeHtml(defaultPayMethod) +
              '">Make Payment (₹' +
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
        '<div class="card sat-app-card" style="margin-bottom:15px;border-top:4px solid #1a237e;overflow:hidden;padding:0;">' +
        '<div style="padding:16px 16px 0;">' +
        '<h4 style="color:#1a237e;margin-bottom:16px;"><i class="fas fa-calendar-check"></i> Seminar · ' +
        escapeHtml(a.application_no) +
        (a.seminar_title ? ' · ' + escapeHtml(a.seminar_title) : '') +
        yearBadge +
        '</h4>' +
        qualBadge +
        waitlistBlock +
        revisionBlock +
        '</div>' +
        renderTrackerStepsHtml(tl) +
        '<div style="padding:0 16px 16px;">' +
        payBtn +
        waBlock +
        '</div></div>'
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

function sendDoctorClientTelemetry() {
    const uid = window.__doctorResolvedInternalId || doctorNumericUserId();
    if (!uid) return;
    const diagnostics =
        window.LiveChatClientInfo && typeof window.LiveChatClientInfo.collect === 'function'
            ? window.LiveChatClientInfo.collect()
            : {};
    fetch('/api/doctor/client-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid, clientDiagnostics: diagnostics })
    }).catch(() => {});
}

function scheduleDoctorClientTelemetry() {
    sendDoctorClientTelemetry();
    if (window.__doctorTelemetryTimer) clearInterval(window.__doctorTelemetryTimer);
    window.__doctorTelemetryTimer = setInterval(sendDoctorClientTelemetry, 5 * 60 * 1000);
}

async function bootDoctorDashboard(user) {
    currentUser = user;
    bindDoctorPayButtonDelegation();
    window.__doctorResolvedInternalId = doctorNumericUserId();
    initDoctorPortalAccessRefreshOnVisible();
    const resolved = await ensureDoctorInternalUserId();
    if (resolved) window.__doctorResolvedInternalId = resolved;
    await refreshDoctorPortalAccess().catch(() => {});
    await applyDoctorModuleAccessFromUser(currentUser);
    try {
        const u = await fetch('/api/public/portal-urls').then((r) => r.json());
        window.__doctorProductionSite = !!(u && u.production);
        window.__allowDemoAccounts = u && u.allowDemoAccounts !== false;
    } catch (_) {}
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
    loadSiteBranding().then(() => preloadSiteLogoForPdf());
    initDoctorVolunteerNav()
        .then(() => applyDoctorModuleAccessFromUser(currentUser))
        .catch(() => {});
    scheduleDoctorModuleReapply();
    handleEasebuzzPaymentReturnQuery();
    const hashTab = String(window.location.hash || '').replace(/^#/, '').toLowerCase();
    if (hashTab === 'refunds' && (!__doctorAllowedTabs || __doctorAllowedTabs.has('tab-refunds'))) {
        switchTab('tab-refunds');
    } else {
        switchTab('tab-dashboard');
    }
    if (window.DoctorLiveChatWidget && typeof DoctorLiveChatWidget.boot === 'function') {
        DoctorLiveChatWidget.boot({
            getUserId: doctorNumericUserId,
            isEnabled: doctorLiveChatWidgetEnabled
        });
    }
    scheduleDoctorClientTelemetry();
    syncLiveActivity({ kind: 'doctor_portal', stepLabel: 'Dashboard open' });
    if (window.SiteVisitorBeacon && typeof window.SiteVisitorBeacon.boot === 'function') {
        window.SiteVisitorBeacon.boot();
    }
    setTimeout(() => {
        handleDirectApplicationPaymentLink();
    }, 350);
}

function handleEasebuzzPaymentReturnQuery() {
    try {
        const p = new URLSearchParams(window.location.search);
        const payment = p.get('payment');
        const returnTab = p.get('tab');
        const isBookReturn = returnTab === 'tab-books';
        if (!payment && !returnTab) return;
        const msg = p.get('msg');
        if (isBookReturn && typeof switchTab === 'function') {
            switchTab('tab-books');
        }
        if (payment === 'success') {
            alert(
                msg ||
                    (isBookReturn
                        ? 'Payment successful. Your book order is confirmed — see Book orders for your pickup QR.'
                        : 'Payment successful. Your e-ticket is under Participant tickets. Join the seminar WhatsApp group from My Applications when shown.')
            );
            if (isBookReturn) {
                if (typeof loadBookOrders === 'function') loadBookOrders();
            } else {
                const lastReg = sessionStorage.getItem('doctor_last_pay_reg');
                if (typeof loadApplications === 'function') {
                    loadApplications().then(() => {
                        if (lastReg) showPostPaymentWhatsappBanner(lastReg);
                    });
                }
                if (typeof loadDoctorDashboardStats === 'function') loadDoctorDashboardStats();
                if (typeof loadDoctorEventTickets === 'function') loadDoctorEventTickets();
            }
        } else if (payment === 'failed') {
            alert(
                msg ||
                    (isBookReturn
                        ? 'Book payment was not completed. You can try again from Book orders.'
                        : 'Payment was not completed. You can try again from My Applications.')
            );
            if (isBookReturn && typeof loadBookOrders === 'function') loadBookOrders();
        } else if (payment === 'error') {
            alert(msg || 'Payment could not be verified. Contact the seminar office if money was debited.');
        }
        const clean = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, '', clean);
    } catch (_) {}
}

async function handleDirectApplicationPaymentLink() {
    try {
        let p = new URLSearchParams(window.location.search);
        const stored = sessionStorage.getItem('doctor_pay_link');
        if ((!p.get('pay_registration') && !p.get('pay_app')) && stored) {
            p = new URLSearchParams(String(stored).replace(/^\?/, ''));
        }
        const regId = parseInt(p.get('pay_registration') || '', 10);
        const appNo = String(p.get('pay_app') || '').trim();
        const methodId = String(p.get('pay_method') || '').trim();
        const payUser = String(p.get('pay_user') || '').trim();
        if (!regId && !appNo) return;

        sessionStorage.removeItem('doctor_pay_link');
        switchTab('tab-payments');

        const uid = doctorNumericUserId();
        if (!uid) return;

        const rq = new URLSearchParams({
            registrationId: String(regId || ''),
            userId: String(uid)
        });
        if (payUser) rq.set('payUser', payUser);
        const resolveRes = await fetch('/api/doctor/payment-link-resolve?' + rq.toString(), {
            cache: 'no-store'
        });
        const resolve = await resolveRes.json().catch(() => ({}));

        if (!resolveRes.ok) {
            alert(
                resolve.message ||
                    resolve.error ||
                    'This payment link is not available. Sign in with the doctor account used on the application.'
            );
            return;
        }
        if (resolve.alreadyPaid) {
            alert(
                resolve.message ||
                    'This application is already paid. Your e-ticket is under Participant tickets.'
            );
            return;
        }
        if (!resolve.payable) {
            alert(resolve.message || 'This payment link is not available yet.');
            return;
        }

        const targetId = regId || Number(resolve.registrationId) || 0;
        try {
            const res = await fetch('/api/applications/' + encodeURIComponent(uid), { cache: 'no-store' });
            const payload = await res.json().catch(() => ({}));
            if (res.ok) userApplications = Array.isArray(payload) ? payload : payload.applications || [];
        } catch (_) {}

        await loadDoctorSeminarPaymentsPanel();

        const pending = (userApplications || []).filter(
            (a) => String(a.status || '').toLowerCase() === 'approved_pending_payment'
        );
        const target =
            pending.find((a) => Number(a.id) === targetId) ||
            pending.find((a) => String(a.application_no || '').toLowerCase() === appNo.toLowerCase()) ||
            (resolve.payable
                ? {
                      id: targetId,
                      application_no: resolve.applicationNo || appNo,
                      payment_amount: resolve.amount,
                      seminar_price: resolve.amount,
                      seminar_title: resolve.seminarTitle
                  }
                : null);
        if (!target) {
            alert(
                'Payment is due but could not load checkout. Open Make payments and pay for application ' +
                    (resolve.applicationNo || appNo || targetId) +
                    '.'
            );
            return;
        }
        const btn = document.querySelector('.doctor-pay-btn[data-reg-id="' + String(target.id) + '"]');
        const card = btn ? btn.closest('.card') : null;
        if (card) {
            card.style.boxShadow = '0 0 0 3px #86efac';
            setTimeout(() => {
                card.style.boxShadow = '';
            }, 1800);
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (btn && confirm('Open checkout now for application ' + (target.application_no || target.id) + '?')) {
            const payAmt =
                target.payment_amount != null && Number.isFinite(Number(target.payment_amount))
                    ? Number(target.payment_amount)
                    : resolve.amount != null
                      ? Number(resolve.amount)
                      : Number(target.seminar_price) || 0;
            processPayment(target.id, payAmt, target.application_no || '', methodId || null, false);
        }
        const clean = window.location.pathname + (window.location.hash || '');
        window.history.replaceState({}, '', clean);
    } catch (_) {}
}

window.onload = () => {
    try {
        const p = new URLSearchParams(window.location.search);
        if (p.get('pay_registration') || p.get('pay_app')) {
            sessionStorage.setItem('doctor_pay_link', window.location.search);
        }
    } catch (_) {}
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

function registrationAgreeTermsChecked() {
    const tnc = document.getElementById('tnc');
    const regTnc = document.getElementById('reg-tnc-accept');
    return !!(tnc && tnc.checked) || !!(regTnc && regTnc.checked);
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
const REGISTRATION_STEP_LABELS = [
    'Terms & conditions',
    'Personal details',
    'Address',
    'Qualification',
    'College details',
    'Review & submit'
];

function syncLiveActivity(partial) {
    if (window.SiteVisitorBeacon && typeof window.SiteVisitorBeacon.setActivity === 'function') {
        window.SiteVisitorBeacon.setActivity(partial || {});
    } else if (window.SiteVisitorBeacon && typeof window.SiteVisitorBeacon.sendHeartbeat === 'function') {
        window.SiteVisitorBeacon.sendHeartbeat();
    }
}

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
    o.agree_terms = registrationAgreeTermsChecked() ? '1' : '';
    const eventIds = getSelectedSeminarEventIds();
    if (eventIds.length) o.selected_event_ids = eventIds;
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
            if (f.key === 'agree_terms') {
                if (f.required !== false && registrationAgreeTermsChecked() === false) {
                    if (sn === upToStepInclusive) {
                        return `Please confirm: ${f.label || 'I confirm the information is accurate'}`;
                    }
                }
                continue;
            }
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
    const activePane = document.querySelector('#doctor-tab-viewport > .tab-pane:not(.hidden)');
    if (activePane) syncDoctorUpdatesPanel(activePane.id);
}

let activeSeminars = [];
let seminarGridCountdownTimer = null;
let caseGridCountdownTimer = null;
let doctorSliderTimer = null;
let doctorSliderIndex = 0;

function doctorSeminarImageUrl(path) {
    if (!path) return '';
    const p = String(path).trim();
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/')) return p;
    return '/uploads/' + p;
}

function seminarSlideImage(s) {
    if (!s) return '';
    const hero = doctorSeminarImageUrl(s.hero_image_path);
    if (hero) return hero;
    const flyer = doctorSeminarImageUrl(s.flyer_path);
    if (flyer) return flyer;
    try {
        const g = s.gallery_paths ? JSON.parse(s.gallery_paths) : [];
        if (Array.isArray(g) && g.length) return doctorSeminarImageUrl(g[0]);
    } catch (_) {}
    return '';
}

function buildDoctorSliderSlides(seminars, marketingBanners, cmsSlides) {
    const slides = [];
    const seen = new Set();
    const push = (slide) => {
        if (!slide || !slide.src || seen.has(slide.src)) return;
        seen.add(slide.src);
        slides.push(slide);
    };
    (seminars || []).forEach((s) => {
        const src = seminarSlideImage(s);
        if (!src) return;
        push({
            src,
            title: s.title || 'National Seminar',
            subtitle: s.event_date ? formatEventDate(s.event_date) : '',
            seminarId: s.id
        });
    });
    if (!slides.length) {
        (marketingBanners || []).forEach((b) => {
            if (!b || !b.imagePath) return;
            push({
                src: doctorSeminarImageUrl(b.imagePath),
                title: b.title || '',
                subtitle: b.subtitle || ''
            });
        });
    }
    if (!slides.length) {
        (cmsSlides || []).forEach((sl) => {
            if (!sl) return;
            const src = doctorSeminarImageUrl(sl.src || sl.imagePath || sl.image);
            if (!src) return;
            push({
                src,
                title: sl.caption || sl.title || '',
                subtitle: ''
            });
        });
    }
    return slides;
}

function clearDoctorSliderTimer() {
    if (doctorSliderTimer) {
        clearInterval(doctorSliderTimer);
        doctorSliderTimer = null;
    }
}

function renderDoctorSeminarSlider(slides, autoSlideMs) {
    const wrap = document.getElementById('doctor-seminar-slider');
    if (!wrap) return;
    clearDoctorSliderTimer();
    const list = (slides || []).filter((s) => s && s.src);
    if (!list.length) {
        wrap.classList.add('hidden');
        wrap.setAttribute('aria-hidden', 'true');
        wrap.innerHTML = '';
        return;
    }
    wrap.classList.remove('hidden');
    wrap.setAttribute('aria-hidden', 'false');
    doctorSliderIndex = 0;
    const ms = Math.max(3000, parseInt(autoSlideMs, 10) || 5500);
    const esc = (s) =>
        String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    const slideHtml = list
        .map((b, i) => {
            const src = esc(b.src);
            const title = b.title ? '<h3 class="dp-title">' + esc(b.title) + '</h3>' : '';
            const sub = b.subtitle ? '<p class="dp-sub">' + esc(b.subtitle) + '</p>' : '';
            const cta = b.seminarId
                ? '<button type="button" class="dp-cta" data-goto-seminar="1"><i class="fas fa-calendar-check"></i> View seminars</button>'
                : '';
            return (
                '<div class="dp-slide' +
                (i === 0 ? ' is-active' : '') +
                '" data-idx="' +
                i +
                '">' +
                '<div class="dp-bg" style="background-image:url(\'' +
                src +
                '\')"></div>' +
                '<div class="dp-overlay"></div>' +
                '<div class="dp-content">' +
                title +
                sub +
                cta +
                '</div></div>'
            );
        })
        .join('');
    const dots =
        list.length > 1
            ? '<div class="dp-dots">' +
              list
                  .map(function (_, i) {
                      return (
                          '<button type="button" class="dp-dot' +
                          (i === 0 ? ' is-active' : '') +
                          '" data-go="' +
                          i +
                          '" aria-label="Slide ' +
                          (i + 1) +
                          '"></button>'
                      );
                  })
                  .join('') +
              '</div>'
            : '';
    const nav =
        list.length > 1
            ? '<button type="button" class="dp-nav dp-prev" aria-label="Previous slide"><i class="fas fa-chevron-left"></i></button>' +
              '<button type="button" class="dp-nav dp-next" aria-label="Next slide"><i class="fas fa-chevron-right"></i></button>'
            : '';
    wrap.innerHTML =
        '<div class="dp-carousel" role="group" aria-roledescription="carousel">' +
        '<div class="dp-track">' +
        slideHtml +
        '</div>' +
        nav +
        dots +
        '</div>';
    const slideEls = wrap.querySelectorAll('.dp-slide');
    const dotEls = wrap.querySelectorAll('.dp-dot');
    function goTo(idx) {
        doctorSliderIndex = (idx + list.length) % list.length;
        slideEls.forEach(function (el, i) {
            el.classList.toggle('is-active', i === doctorSliderIndex);
        });
        dotEls.forEach(function (el, i) {
            el.classList.toggle('is-active', i === doctorSliderIndex);
        });
    }
    function next() {
        goTo(doctorSliderIndex + 1);
    }
    function prev() {
        goTo(doctorSliderIndex - 1);
    }
    function restartTimer() {
        clearDoctorSliderTimer();
        if (list.length > 1) doctorSliderTimer = setInterval(next, ms);
    }
    const nextBtn = wrap.querySelector('.dp-next');
    const prevBtn = wrap.querySelector('.dp-prev');
    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            next();
            restartTimer();
        });
    }
    if (prevBtn) {
        prevBtn.addEventListener('click', function () {
            prev();
            restartTimer();
        });
    }
    dotEls.forEach(function (d) {
        d.addEventListener('click', function () {
            goTo(parseInt(d.getAttribute('data-go'), 10));
            restartTimer();
        });
    });
    wrap.querySelectorAll('[data-goto-seminar]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (typeof switchTab === 'function') switchTab('tab-seminars');
        });
    });
    restartTimer();
}

async function loadDoctorSeminarSlider() {
    /* Marketing banner carousel is main-site only — not shown in doctor portal. */
}

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
    const map = window.__registrationOverrideBySeminar;
    return !!(map && map[Number(seminarId)]);
}

function getOverrideRegisterUntilMs(seminarId) {
    const map = window.__registrationOverrideBySeminar;
    const entry = map && map[Number(seminarId)];
    if (!entry || !entry.registerUntil) return null;
    if (window.PortalDateTime && window.PortalDateTime.registrationOverrideDeadlineMs) {
        const ms = window.PortalDateTime.registrationOverrideDeadlineMs(entry.registerUntil);
        return ms != null && !Number.isNaN(ms) ? ms : null;
    }
    const ms = entry.registerUntil ? new Date(entry.registerUntil).getTime() : null;
    return ms != null && !Number.isNaN(ms) ? ms : null;
}

function isOverrideRegistrationActive(seminarId) {
    const map = window.__registrationOverrideBySeminar;
    const entry = map && map[Number(seminarId)];
    if (!entry) return false;
    if (window.PortalDateTime && window.PortalDateTime.isRegistrationOverrideOpenNow) {
        return window.PortalDateTime.isRegistrationOverrideOpenNow(entry.registerUntil);
    }
    const untilMs = getOverrideRegisterUntilMs(seminarId);
    if (untilMs == null) return entry.isActive !== false;
    return Date.now() <= untilMs + 2000;
}

/** Honors per-user admin override when public registration has closed. */
function effectiveRegistrationWindowState(seminar) {
    const w = registrationWindowState(seminar);
    const map = window.__registrationOverrideBySeminar;
    const ovEntry = seminar && map ? map[Number(seminar.id)] : null;
    if (w.state === 'closed' && seminar && ovEntry) {
        const untilMs = getOverrideRegisterUntilMs(seminar.id);
        if (!isOverrideRegistrationActive(seminar.id)) {
            return { state: 'closed', overrideExpired: true, registerUntil: untilMs };
        }
        return { state: 'open', viaOverride: true, registerUntil: untilMs };
    }
    if (w.state === 'closed' && seminar && hasRegistrationOverrideForSeminar(seminar.id)) {
        const untilMs = getOverrideRegisterUntilMs(seminar.id);
        if (!isOverrideRegistrationActive(seminar.id)) {
            return { state: 'closed', overrideExpired: true, registerUntil: untilMs };
        }
        return { state: 'open', viaOverride: true, registerUntil: untilMs };
    }
    if (w.state === 'closed' && seminar && Number(seminar.waiting_list_enabled) === 1) {
        return { state: 'waitlist' };
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

function clearCaseGridCountdownTimer() {
    if (caseGridCountdownTimer) {
        clearInterval(caseGridCountdownTimer);
        caseGridCountdownTimer = null;
    }
}

function startCaseGridCountdownTimer() {
    clearCaseGridCountdownTimer();
    const tick = () => {
        let needReload = false;
        let anyUpcoming = false;
        activeCasePrograms.forEach((p) => {
            const w = registrationWindowState(p);
            if (w.state === 'upcoming') {
                anyUpcoming = true;
                const el = document.getElementById('case-reg-countdown-' + p.id);
                if (el && w.opensAt != null) {
                    el.textContent = formatCountdownTo(w.opensAt);
                }
                if (w.opensAt != null && Date.now() >= w.opensAt) {
                    needReload = true;
                }
            }
        });
        if (needReload) {
            loadCaseProgramsGrid();
            return;
        }
        if (!anyUpcoming) {
            clearCaseGridCountdownTimer();
        }
    };
    tick();
    caseGridCountdownTimer = setInterval(tick, 1000);
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
            const ew = effectiveRegistrationWindowState(s);
            if (ew.viaOverride && ew.registerUntil != null) {
                const elOv = document.getElementById(`seminar-override-countdown-${s.id}`);
                if (elOv) {
                    elOv.textContent = formatCountdownTo(ew.registerUntil);
                    if (Date.now() > ew.registerUntil) needReload = true;
                }
            }
            const parseMs =
                window.PortalDateTime && window.PortalDateTime.parseMs
                    ? (v) => window.PortalDateTime.parseMs(v)
                    : (v) => (v ? new Date(v).getTime() : null);
            const re = parseMs(s.registration_end);
            if (re != null && !Number.isNaN(re) && Date.now() >= re && w.state === 'closed') {
                const prevClosed = s.__regClosedSeen;
                if (!prevClosed) {
                    s.__regClosedSeen = true;
                    needReload = true;
                }
            }
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
        if (activeSeminars.some((s) => hasRegistrationOverrideForSeminar(s.id))) {
            refreshRegistrationOverrides().then(() => {
                activeSeminars.forEach((s) => {
                    const ew = effectiveRegistrationWindowState(s);
                    if (ew.viaOverride && ew.registerUntil != null) {
                        const elOv = document.getElementById(`seminar-override-countdown-${s.id}`);
                        if (elOv) elOv.textContent = formatCountdownTo(ew.registerUntil);
                    }
                });
            });
        }
        const anyOpenOrWaitlist = activeSeminars.some((s) => {
            const ew = effectiveRegistrationWindowState(s);
            return (
                ew.state === 'open' ||
                ew.state === 'waitlist' ||
                registrationWindowState(s).state === 'upcoming' ||
                (ew.viaOverride && ew.registerUntil != null)
            );
        });
        if (!anyUpcoming && !anyOpenOrWaitlist) {
            clearSeminarGridCountdownTimer();
        }
    };
    tick();
    seminarGridCountdownTimer = setInterval(tick, 1000);
}

function renderSeminarGridCard(s, readOnlyPast, alreadyRegistered, draftApp) {
    const win = effectiveRegistrationWindowState(s);
    const regStartLabel = s.registration_start
        ? formatTrackDateTime(s.registration_start)
        : '';
    const regEndLabel = s.registration_end ? formatTrackDateTime(s.registration_end) : '';
    const eventLabel = s.event_date ? formatEventDate(s.event_date) : '—';
    let actionBlock = '';
    if (draftApp && !alreadyRegistered) {
        const closedNote =
            win.state !== 'open'
                ? '<p style="font-size:0.85rem;color:#b45309;margin-bottom:10px;"><i class="fas fa-info-circle"></i> Registration has closed. You can update your draft but cannot submit until admin reopens or extends your window.</p>'
                : '';
        actionBlock =
            closedNote +
            '<p style="font-size:0.85rem;color:#0f766e;margin-bottom:10px;"><i class="fas fa-file-alt"></i> Draft saved — not submitted yet.</p>' +
            '<button type="button" class="btn-primary" style="width:100%;margin-bottom:8px;" onclick="resumeDraftApplication(' +
            Number(draftApp.id) +
            ')">Continue draft</button>' +
            '<button type="button" class="btn-primary" style="width:100%;background:#64748b;" onclick="switchTab(\'tab-applications\')">View drafts</button>';
    } else if (alreadyRegistered) {
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
        const expiredMsg = win.overrideExpired
            ? '<p style="font-size:0.85rem;color:#b91c1c;"><i class="fas fa-clock"></i> Your extended registration window has ended. You can no longer register for this seminar.</p>'
            : '<p style="font-size:0.85rem;color:#b45309;"><i class="fas fa-lock"></i> Registration closed.</p>';
        actionBlock =
            expiredMsg +
            '<button type="button" disabled class="btn-primary" style="width:100%;opacity:0.55;margin-top:8px;">Registration closed</button>';
    } else if (win.state === 'waitlist') {
        actionBlock =
            '<div style="background:#fffbeb;border-radius:10px;padding:14px;margin-bottom:12px;border:1px solid #fde68a;">' +
            '<p style="font-size:0.8rem;color:#92400e;font-weight:600;"><i class="fas fa-list-ol"></i> Waiting list open</p>' +
            '<p style="font-size:0.85rem;color:#78350f;margin:6px 0 0;">Registration has closed. Join the waitlist — no payment now. If selected, you will receive a payment link by email.</p></div>' +
            '<button type="button" class="btn-primary" onclick="startRegistration(' +
            s.id +
            ', { waitlist: true })" style="width:100%;background:#b45309;border:none;">Join waiting list</button>';
    } else {
        const overrideUntilLabel =
            win.registerUntil != null
                ? formatTrackDateTime(
                      window.__registrationOverrideBySeminar &&
                          window.__registrationOverrideBySeminar[Number(s.id)]
                          ? window.__registrationOverrideBySeminar[Number(s.id)].registerUntil
                          : null
                  )
                : '';
        const overrideNote = win.viaOverride
            ? '<p style="font-size:0.85rem;color:#0f766e;margin-bottom:10px;"><i class="fas fa-user-check"></i> You have admin approval to register after the public deadline.' +
              (s.__lateOverrideOnly
                  ? ' This seminar is shown here only for your extended registration window.'
                  : '') +
              (overrideUntilLabel
                  ? ' You must complete registration by <strong>' +
                    escapeHtml(overrideUntilLabel) +
                    '</strong> or you cannot attend.</p>'
                  : ' Complete registration before your personal deadline or you cannot attend.</p>')
            : '';
        const overrideCountdown =
            win.viaOverride && win.registerUntil != null
                ? '<p id="seminar-override-countdown-' +
                  s.id +
                  '" style="font-size:1rem;font-weight:700;color:#b45309;margin-bottom:10px;">' +
                  formatCountdownTo(win.registerUntil) +
                  '</p>'
                : '';
        actionBlock =
            overrideNote +
            overrideCountdown +
            (regEndLabel && !win.viaOverride
                ? '<p style="font-size:0.8rem;color:#64748b;margin-bottom:10px;">Closes ' + escapeHtml(regEndLabel) + '</p>'
                : win.viaOverride
                  ? '<p style="font-size:0.8rem;color:#64748b;margin-bottom:10px;">Public registration is closed for everyone else.</p>'
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
        seminarVenueMapHtml(s, { compact: true }) +
        (s.portal_year
            ? '<p style="font-size:0.8rem;color:#64748b;">Year ' + escapeHtml(String(s.portal_year)) + '</p>'
            : '') +
        seminarFeeLabelHtml(s) +
        '</div>' +
        '<div>' +
        actionBlock +
        '</div></div>'
    );
}

function applyRegistrationOverridesPayload(ovData) {
    if (!ovData) return;
    if (ovData.resolvedUserId != null) {
        const resolved = parseInt(ovData.resolvedUserId, 10);
        if (Number.isInteger(resolved) && resolved > 0 && resolved <= DOCTOR_INTERNAL_ID_MAX) {
            window.__doctorResolvedInternalId = resolved;
        }
    }
    window.__registrationOverrideSeminarIds = new Set();
    window.__registrationOverrideBySeminar = {};
    (ovData.overrides || []).forEach((o) => {
        const n = Number(o.seminarId);
        if (n > 0) {
            window.__registrationOverrideBySeminar[n] = {
                registerUntil: o.registerUntil || null,
                isActive: o.isActive !== false
            };
            if (isOverrideRegistrationActive(n)) window.__registrationOverrideSeminarIds.add(n);
        }
    });
    (ovData.volunteerSeminarIds || []).forEach((id) => {
        const n = Number(id);
        if (n > 0) window.__registrationOverrideSeminarIds.add(n);
    });
    (ovData.seminarIds || []).forEach((id) => {
        const n = Number(id);
        if (n > 0) window.__registrationOverrideSeminarIds.add(n);
    });
    (ovData.seminars || []).forEach((s) => {
        if (!s || s.id == null) return;
        const n = Number(s.id);
        if (!Number.isFinite(n) || n <= 0) return;
        if (!activeSeminars.some((x) => Number(x.id) === n)) {
            activeSeminars.push({ ...s, __lateOverrideOnly: true });
        }
    });
}

async function refreshRegistrationOverrides() {
    if (!currentUser) return;
    try {
        let uid = doctorNumericUserId();
        if (!uid) uid = await ensureDoctorInternalUserId();
        const portalId = currentUser.user_id_string ? String(currentUser.user_id_string).trim() : '';
        const pathId = uid || portalId || (currentUser.id != null ? String(currentUser.id) : '');
        if (!pathId) return;
        const ovUrl =
            '/api/doctor/registration-overrides/' +
            encodeURIComponent(pathId) +
            (portalId ? '?userIdString=' + encodeURIComponent(portalId) : '');
        const ovRes = await fetch(ovUrl, { cache: 'no-store' });
        if (ovRes.ok) {
            const ovData = await ovRes.json();
            applyRegistrationOverridesPayload(ovData);
        }
    } catch (ovErr) {
        console.warn('Could not load registration overrides', ovErr);
    }
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
        const draftBySeminarId = {};
        const uid = doctorNumericUserId();
        if (uid) {
            try {
                const appRes = await fetch('/api/applications/' + encodeURIComponent(uid), { cache: 'no-store' });
                const appPayload = await appRes.json();
                const apps = Array.isArray(appPayload) ? appPayload : appPayload.applications || [];
                apps.forEach((a) => {
                    if (!a || a.seminar_id == null) return;
                    const sid = Number(a.seminar_id);
                    const st = String(a.status || '').toLowerCase();
                    if (st === 'draft') {
                        draftBySeminarId[sid] = a;
                    } else if (st === 'cancelled' && a.reapplyAllowed) {
                        return;
                    } else {
                        registeredSeminarIds.add(sid);
                    }
                });
            } catch (appErr) {
                console.warn('Could not load applications for seminar grid', appErr);
            }
        }
        window.__userRegisteredSeminarIds = registeredSeminarIds;
        window.__seminarDraftById = draftBySeminarId;
        window.__registrationOverrideSeminarIds = new Set();
        window.__registrationOverrideBySeminar = {};
        await refreshRegistrationOverrides();
        container.innerHTML = '';
        
        if (!activeSeminars.length) {
            container.innerHTML =
                '<p style="grid-column:1/-1;text-align:center;width:100%;color:#64748b;">No active seminars available for registration at this time.</p>';
            return;
        }

        let hasUpcoming = false;
        let hasOpenReg = false;
        activeSeminars.forEach((s) => {
            const win = registrationWindowState(s);
            if (win.state === 'upcoming') hasUpcoming = true;
            if (effectiveRegistrationWindowState(s).state === 'open') hasOpenReg = true;
            const sid = Number(s.id);
            const alreadyRegistered = registeredSeminarIds.has(sid);
            const draftApp = draftBySeminarId[sid] || null;
            container.insertAdjacentHTML('beforeend', renderSeminarGridCard(s, false, alreadyRegistered, draftApp));
        });
        if (hasUpcoming || hasOpenReg) {
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
    if (!validateSeminarEventSelectionOrAlert()) return;
    nextStep(1);
}

function validateSeminarEventSelectionOrAlert() {
    const sid = parseInt(activeSeminarIdForReg, 10);
    const s = activeSeminars.find(function (x) {
        return Number(x.id) === sid;
    });
    const events = (s && (s.sub_events || s.subEvents)) || [];
    if (!events.length) return true;
    const ids = getSelectedSeminarEventIds();
    if (!ids.length) {
        alert('Select at least one session to attend (you can choose one or both).');
        return false;
    }
    return true;
}

async function startRegistration(seminarId, opts) {
    opts = opts || {};
    await refreshRegistrationOverrides();
    const editMode = !!opts.editMode;
    const draftResume = !!opts.draftResume;
    const volunteerBypass = !!opts.volunteerBypass || editMode || draftResume;
    const waitlistMode = !!opts.waitlist;
    const sid = Number(seminarId);
    const s = activeSeminars.find((x) => Number(x.id) === sid);
    const seminarTitle = s && s.title ? s.title : 'Seminar';
    const regSet = window.__userRegisteredSeminarIds;
    if (regSet && regSet.has(sid) && !editMode && !draftResume) {
        alert('You have already registered for this seminar. Track your application under Track seminar applications.');
        switchTab('tab-applications');
        return;
    }
    const overrideActive = isOverrideRegistrationActive(sid);
    const win = s
        ? effectiveRegistrationWindowState(s)
        : overrideActive
          ? { state: 'open', viaOverride: true }
          : { state: 'closed' };
    if (!volunteerBypass && !waitlistMode && !overrideActive && s && win.state !== 'open') {
        if (registrationWindowState(s).state === 'upcoming') {
            alert('Registration has not opened yet for this seminar. Please wait until the countdown reaches zero.');
        } else if (win.overrideExpired) {
            alert(
                'Your extended registration window has ended. You can no longer register for this seminar and will not be able to attend unless admin extends your deadline.'
            );
        } else if (win.state === 'waitlist') {
            alert('Registration has closed. Use Join waiting list if it is enabled for this seminar.');
        } else {
            alert('Registration for this seminar has closed.');
        }
        return;
    }
    if (waitlistMode && s && win.state !== 'waitlist') {
        alert('Waiting list is not open for this seminar.');
        return;
    }
    activeSeminarIdForReg = seminarId;
    window.__registrationJoinWaitlist = waitlistMode;
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
    document.getElementById('registration-seminar-name').innerText = waitlistMode
        ? `Waiting list — ${seminarTitle}`
        : draftResume
          ? `Draft — ${seminarTitle}`
          : `Registering for: ${seminarTitle}`;
    const draftStatusEl = document.getElementById('reg-draft-status');
    if (draftStatusEl) {
        draftStatusEl.textContent = draftResume
            ? 'This is a saved draft only. Use Submit application while registration is open to register.'
            : '';
    }
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
    renderRegSeminarVenuePanel(s);
    renderSeminarEventPicker(s);
    const emailEl = document.getElementById('reg-email');
    const phoneEl = document.getElementById('reg-phone');
    if (emailEl && currentUser && currentUser.email) emailEl.value = currentUser.email;
    if (phoneEl && currentUser && currentUser.phone) phoneEl.value = currentUser.phone;

    if (opts.prefillFormData) {
        await applyRegistrationFormData(opts.prefillFormData);
        if (editMode) {
            const tnc = document.getElementById('tnc');
            if (tnc) tnc.checked = true;
            nextStep(1);
            return;
        }
    } else if (!opts.editMode && !opts.draftResume) {
        const uid = doctorNumericUserId();
        if (uid) {
            try {
                const res = await fetch(
                    '/api/doctor/registration-prefill/' +
                        encodeURIComponent(uid) +
                        '?excludeSeminarId=' +
                        encodeURIComponent(sid)
                );
                const data = await res.json();
                if (data && data.formData) {
                    await applyRegistrationFormData(data.formData, { onlyBlank: true });
                }
            } catch (e) {
                console.warn('[registration-prefill]', e);
            }
        }
    }

    nextStep(hasTerms || window.__seminarCancellationSummary ? 0 : 1);
    syncLiveActivity({
        kind: 'seminar_apply',
        seminarId: sid,
        seminarTitle: seminarTitle,
        stepNumber: hasTerms || window.__seminarCancellationSummary ? 0 : 1,
        stepLabel: REGISTRATION_STEP_LABELS[hasTerms || window.__seminarCancellationSummary ? 0 : 1],
        formProgress: Math.round(((hasTerms || window.__seminarCancellationSummary ? 0 : 1) / REGISTRATION_PREVIEW_STEP) * 100)
    });
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
    window.editingApplicationId = null;
    window.__registrationJoinWaitlist = false;
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
    syncLiveActivity({ kind: 'browse_seminars', seminarId: null, seminarTitle: null, stepNumber: null, stepLabel: null, formProgress: 0 });
}

function syncDoctorUpdatesPanel(tabId) {
    const box = document.querySelector('.announcements-box');
    const holder = document.getElementById('doctor-updates-holder');
    const show =
        tabId === 'tab-dashboard' || tabId === 'tab-profile' || tabId === 'tab-seminars';
    if (!box) return;
    if (!show || !holder) {
        box.classList.add('hidden');
        if (holder && box.parentElement !== holder) holder.appendChild(box);
        return;
    }
    const pane = document.getElementById(tabId);
    const anchor = pane && pane.querySelector('[data-doctor-updates-anchor]');
    if (anchor) {
        anchor.insertAdjacentElement('afterend', box);
    } else if (pane) {
        pane.prepend(box);
    }
    box.classList.remove('hidden');
}

function mountDoctorTabPane(tabId) {
    const viewport = document.getElementById('doctor-tab-viewport');
    const store = document.getElementById('doctor-tab-store');
    const pane = document.getElementById(tabId);
    if (!pane) return null;
    if (viewport && store) {
        viewport.querySelectorAll('.tab-pane').forEach((t) => {
            t.classList.add('hidden');
            t.setAttribute('aria-hidden', 'true');
            store.appendChild(t);
        });
        store.querySelectorAll('.tab-pane').forEach((t) => {
            t.classList.add('hidden');
            t.setAttribute('aria-hidden', 'true');
        });
        pane.classList.remove('hidden');
        pane.setAttribute('aria-hidden', 'false');
        viewport.appendChild(pane);
    }
    return pane;
}

function switchTab(tabId, menuEl) {
    if (!tabId) return;
    if (__doctorAllowedTabs && !__doctorAllowedTabs.has(tabId)) {
        alert('This section is disabled for your account. Please contact admin if you need access.');
        return;
    }
    const pane = mountDoctorTabPane(tabId);
    if (!pane) {
        console.warn('[doctor] Unknown tab:', tabId);
        return;
    }
    if (typeof closeDoctorMobileNav === 'function') closeDoctorMobileNav();
    document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('active'));
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
    syncDoctorUpdatesPanel(tabId);
    if (tabId === 'tab-dashboard') {
        loadDoctorDashboardStats();
    }
    if (tabId !== 'tab-certificate') {
        stopCertTrackingPoll();
        stopDoctorCertCountdownTimer();
    }
    if (tabId !== 'tab-abstract') {
        clearCaseGridCountdownTimer();
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
    if (tabId === 'tab-refunds') {
        loadDoctorRefundsModule();
        syncDoctorTrackingPolls();
    }
    if (tabId === 'tab-receipts') {
        loadDoctorReceipts();
    }
    if (tabId === 'tab-payments') {
        loadDoctorSupplementalPayments();
        loadDoctorSeminarPaymentsPanel();
    }
    if (tabId === 'tab-books' && typeof initDoctorBooksTab === 'function') {
        initDoctorBooksTab();
    }
    if (tabId === 'tab-ticket') {
        loadDoctorEventTickets();
    }
    if (tabId === 'tab-certificate') {
        loadDoctorCertificateModule();
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
        syncLiveActivity({ kind: 'track_applications' });
    }
    if (tabId === 'tab-seminars') {
        loadSeminarsGrid();
        if (document.getElementById('multi-step-form') && document.getElementById('multi-step-form').classList.contains('hidden')) {
            syncLiveActivity({ kind: 'browse_seminars' });
        }
    }
    syncDoctorTrackingPolls();
}
window.switchTab = switchTab;

function openDoctorRefundModule() {
    if (__doctorAllowedTabs) {
        const expanded = expandDoctorRefundTabAccess(new Set(__doctorAllowedTabs));
        expanded.add('tab-refunds');
        __doctorAllowedTabs = expanded;
        const menuBtn = document.querySelector('.menu-item[data-tab="tab-refunds"]');
        if (menuBtn) {
            menuBtn.classList.remove('hidden');
            menuBtn.style.display = '';
            menuBtn.removeAttribute('hidden');
            menuBtn.setAttribute('aria-hidden', 'false');
        }
    }
    switchTab('tab-refunds');
    const pane = document.getElementById('tab-refunds');
    if (pane) pane.classList.remove('hidden');
    try {
        const base = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', base + '#refunds');
    } catch (_) {}
}
window.openDoctorRefundModule = openDoctorRefundModule;

window.startRegistrationVolunteerFlow = startRegistrationVolunteerFlow;

let activeCaseProgramId = null;
let activeCasePrograms = [];
let activeCaseProgram = null;

const CASE_BUILTIN_FIELD_KEYS = new Set([
    'fname',
    'mname',
    'lname',
    'dob',
    'email',
    'phone',
    'whatsapp',
    'category',
    'qual',
    'upload_cv',
    'upload_video',
    'topic',
    'files',
    'agree_terms'
]);

function caseFieldElId(key) {
    return 'case-field-' + key;
}

function getCaseEnabledFormFields(program) {
    return ((program && program.formConfig && program.formConfig.fields) || []).filter(
        (f) => f && f.key && f.enabled !== false
    );
}

function getCaseTermsField(program) {
    return getCaseEnabledFormFields(program).find(function (f) {
        return f.key === 'agree_terms' || normalizeCaseFieldType(f.type) === 'terms';
    });
}

function caseApplicationHasInstructions(program) {
    return !!String((program && program.instructions) || '').trim();
}

function caseApplicationHasTnc(program) {
    return !!getCaseTermsField(program);
}

function populateCaseInstructionsStep(program) {
    const body = document.getElementById('case-instructions-body');
    if (!body) return;
    body.textContent = String((program && program.instructions) || '').trim();
}

function populateCaseTncStep(program) {
    const tf = getCaseTermsField(program);
    const body = document.getElementById('case-tnc-body');
    const label = document.getElementById('case-tnc-accept-label');
    const cb = document.getElementById('case-field-agree_terms');
    if (body) {
        const text = tf && tf.termsText ? String(tf.termsText).trim() : '';
        body.textContent = text || 'Terms and conditions for this case presentation program.';
    }
    if (label) label.textContent = (tf && tf.label) || 'I accept the terms and conditions';
    if (cb) {
        cb.checked = false;
        cb.required = !!(tf && tf.required !== false);
    }
}

function updateCaseWizardStepLabel(step) {
    const el = document.getElementById('case-wizard-step-label');
    if (!el || !activeCaseProgram) return;
    const hasInstr = caseApplicationHasInstructions(activeCaseProgram);
    const hasTnc = caseApplicationHasTnc(activeCaseProgram);
    const total = (hasInstr ? 1 : 0) + (hasTnc ? 1 : 0) + 1;
    let n = 1;
    if (step === 'instructions') {
        el.textContent = total > 1 ? 'Step ' + n + ' of ' + total + ' — Instructions' : 'Instructions';
        return;
    }
    if (hasInstr) n += 1;
    if (step === 'tnc') {
        el.textContent = 'Step ' + n + ' of ' + total + ' — Terms & conditions';
        return;
    }
    if (hasTnc) n += 1;
    if (step === 'form') {
        el.textContent = total > 1 ? 'Step ' + n + ' of ' + total + ' — Application form' : 'Application form';
        return;
    }
    if (step === 'preview') {
        el.textContent = 'Preview & submit';
        return;
    }
    el.textContent = '';
}

function showCaseApplicationStep(step) {
    const instr = document.getElementById('case-step-instructions');
    const tnc = document.getElementById('case-step-tnc');
    const formWrap = document.getElementById('case-form-step-wrap');
    const preview = document.getElementById('case-step-preview');
    if (instr) instr.classList.toggle('hidden', step !== 'instructions');
    if (tnc) tnc.classList.toggle('hidden', step !== 'tnc');
    if (formWrap) formWrap.classList.toggle('hidden', step !== 'form');
    if (preview) preview.classList.toggle('hidden', step !== 'preview');
    const stepForm = document.getElementById('case-step-form');
    if (stepForm) stepForm.classList.toggle('hidden', step === 'preview');
    updateCaseWizardStepLabel(step);
}

function enterCaseApplicationWizard() {
    populateCaseInstructionsStep(activeCaseProgram);
    populateCaseTncStep(activeCaseProgram);
    if (caseApplicationHasInstructions(activeCaseProgram)) {
        showCaseApplicationStep('instructions');
    } else if (caseApplicationHasTnc(activeCaseProgram)) {
        showCaseApplicationStep('tnc');
    } else {
        showCaseApplicationStep('form');
    }
}

function continueCaseFromInstructions() {
    if (caseApplicationHasTnc(activeCaseProgram)) {
        showCaseApplicationStep('tnc');
    } else {
        showCaseApplicationStep('form');
    }
}
window.continueCaseFromInstructions = continueCaseFromInstructions;

function continueCaseFromTnc() {
    const tf = getCaseTermsField(activeCaseProgram);
    const cb = document.getElementById('case-field-agree_terms');
    if (tf && tf.required !== false && !(cb && cb.checked)) {
        return alert('Please accept the terms and conditions to continue.');
    }
    showCaseApplicationStep('form');
}
window.continueCaseFromTnc = continueCaseFromTnc;

function backFromCaseTncStep() {
    if (caseApplicationHasInstructions(activeCaseProgram)) {
        showCaseApplicationStep('instructions');
    } else {
        cancelCaseApplication();
    }
}
window.backFromCaseTncStep = backFromCaseTncStep;

function backFromCaseFormStep() {
    if (caseApplicationHasTnc(activeCaseProgram)) {
        showCaseApplicationStep('tnc');
    } else if (caseApplicationHasInstructions(activeCaseProgram)) {
        showCaseApplicationStep('instructions');
    } else {
        cancelCaseApplication();
    }
}
window.backFromCaseFormStep = backFromCaseFormStep;

function getCaseCustomFormFields(program) {
    return getCaseEnabledFormFields(program).filter((f) => !CASE_BUILTIN_FIELD_KEYS.has(f.key));
}

function caseFormFieldActive(program, key) {
    const fields = (program && program.formConfig && program.formConfig.fields) || [];
    const f = fields.find((x) => x.key === key);
    return !!(f && f.enabled !== false);
}

function caseFieldDisplayLabel(f) {
    return (f.label || f.key) + (f.required !== false ? ' *' : '');
}

function renderCaseNameRow(host, fields, program) {
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:0;';
    fields.forEach((f) => {
        const fg = document.createElement('div');
        fg.className = 'form-group';
        fg.dataset.caseKey = f.key;
        const lab = document.createElement('label');
        lab.textContent = caseFieldDisplayLabel(f);
        lab.setAttribute('for', caseFieldElId(f.key));
        const input = document.createElement('input');
        input.type = 'text';
        input.id = caseFieldElId(f.key);
        input.className = 'case-form-input';
        if (f.required !== false) input.required = true;
        fg.appendChild(lab);
        fg.appendChild(input);
        grid.appendChild(fg);
    });
    host.appendChild(grid);
}

function renderCaseFormField(host, f, program) {
    const type = normalizeCaseFieldType(f.type);
    const fg = document.createElement('div');
    fg.className = 'form-group';
    fg.dataset.caseKey = f.key;

    if (f.key === 'files' || (type === 'file' && f.key === 'files')) {
        const lab = document.createElement('label');
        lab.setAttribute('for', 'case-files');
        lab.textContent = caseFieldDisplayLabel(f);
        fg.appendChild(lab);
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'case-files';
        input.multiple = true;
        input.accept = '.pdf,.ppt,.pptx,.zip,.docx,video/*,image/*';
        if (f.required !== false) input.required = true;
        fg.appendChild(input);
        const hint = document.createElement('p');
        hint.id = 'case-files-hint';
        hint.style.cssText = 'font-size:0.8rem;color:#64748b;margin:6px 0 0;';
        hint.textContent = 'PDF, PPT, PPTX, ZIP, DOCX, images, or video.';
        fg.appendChild(hint);
        const progress = document.createElement('p');
        progress.id = 'case-upload-progress';
        progress.style.cssText = 'display:none;font-size:0.85rem;color:#0f766e;font-weight:600;margin-top:8px;';
        fg.appendChild(progress);
        const ok = document.createElement('p');
        ok.id = 'case-files-success';
        ok.className = 'hidden';
        ok.style.cssText = 'font-size:0.85rem;color:#059669;font-weight:600;margin-top:8px;';
        ok.innerHTML = '<i class="fas fa-check-circle"></i> <span id="case-files-success-text"></span>';
        fg.appendChild(ok);
        host.appendChild(fg);
        if (program && program.id) {
            const maxF = program.maxFilesPerSubmission || 5;
            ensureCaseUploadConfig(program.id).then((cfg) => {
                const maxMb = effectiveCaseMaxMb(program, cfg);
                lab.textContent =
                    (f.label || 'Upload files') +
                    ' (max ' +
                    maxF +
                    ' files, ' +
                    maxMb +
                    ' MB each)' +
                    (cfg && cfg.r2Enabled ? ' — secure cloud storage' : '') +
                    (f.required !== false ? ' *' : '');
                if (cfg && cfg.r2Enabled) {
                    hint.textContent =
                        'Large PDF/PPT/video supported (up to ' +
                        maxMb +
                        ' MB each). Upload shows progress; use Wi‑Fi for big files.';
                }
            });
        }
        return;
    }

    if (type === 'terms') {
        if (f.termsText) {
            const termsBox = document.createElement('div');
            termsBox.style.cssText =
                'font-size:0.88rem;color:#475569;line-height:1.5;margin-bottom:10px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;white-space:pre-wrap;';
            termsBox.textContent = f.termsText;
            fg.appendChild(termsBox);
        }
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;align-items:flex-start;gap:8px;font-weight:600;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = caseFieldElId(f.key);
        cb.className = 'case-form-input';
        if (f.required !== false) cb.required = true;
        wrap.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = f.label || 'I accept the terms';
        wrap.appendChild(span);
        fg.appendChild(wrap);
        host.appendChild(fg);
        return;
    }

    if (type === 'checkbox' || type === 'boolean') {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:600;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = caseFieldElId(f.key);
        cb.className = 'case-form-input';
        if (f.required !== false) cb.required = true;
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(f.label || f.key));
        fg.appendChild(wrap);
        host.appendChild(fg);
        return;
    }

    if (type === 'multiselect') {
        const lab = document.createElement('label');
        lab.textContent = caseFieldDisplayLabel(f);
        fg.appendChild(lab);
        const group = document.createElement('div');
        group.id = caseFieldElId(f.key);
        group.className = 'case-multiselect-group';
        group.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:6px;';
        const opts = Array.isArray(f.options) ? f.options : [];
        if (!opts.length) {
            const hint = document.createElement('p');
            hint.style.cssText = 'font-size:0.82rem;color:#94a3b8;margin:0;';
            hint.textContent = 'No options configured.';
            group.appendChild(hint);
        }
        opts.forEach((o) => {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-weight:500;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'case-ms-opt';
            cb.value = o.value != null ? String(o.value) : String(o.label || '');
            wrap.appendChild(cb);
            wrap.appendChild(document.createTextNode(o.label != null ? o.label : cb.value));
            group.appendChild(wrap);
        });
        fg.appendChild(group);
        host.appendChild(fg);
        return;
    }

    if (type === 'rating') {
        const lab = document.createElement('label');
        lab.setAttribute('for', caseFieldElId(f.key));
        lab.textContent = caseFieldDisplayLabel(f);
        fg.appendChild(lab);
        const input = document.createElement('select');
        input.id = caseFieldElId(f.key);
        input.className = 'case-form-input';
        const max = Math.max(1, Math.min(10, parseInt(f.max, 10) || 5));
        input.innerHTML = '<option value="">Select rating</option>';
        for (let i = 1; i <= max; i++) {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = i + ' / ' + max;
            input.appendChild(opt);
        }
        if (f.required !== false) input.required = true;
        fg.appendChild(input);
        host.appendChild(fg);
        return;
    }

    if (type === 'file') {
        const lab = document.createElement('label');
        lab.setAttribute('for', caseFieldElId(f.key));
        lab.textContent = caseFieldDisplayLabel(f);
        fg.appendChild(lab);
        const input = document.createElement('input');
        input.type = 'file';
        input.id = caseFieldElId(f.key);
        input.className = 'case-form-input case-extra-file-input';
        input.accept = caseFileAcceptAttr(f);
        if (f.required !== false) input.required = true;
        fg.appendChild(input);
        const hint = document.createElement('p');
        hint.style.cssText = 'font-size:0.8rem;color:#64748b;margin:6px 0 0;';
        hint.textContent =
            f.key === 'upload_cv'
                ? 'PDF, DOC, DOCX, or image (max ' + CASE_UPLOAD_HOST_CAP_MB + ' MB).'
                : f.key === 'upload_video'
                  ? 'Video file — MP4, MOV, etc. (max ' + CASE_UPLOAD_HOST_CAP_MB + ' MB).'
                  : 'PDF, documents, images, or video as allowed.';
        fg.appendChild(hint);
        host.appendChild(fg);
        return;
    }

    const lab = document.createElement('label');
    lab.setAttribute('for', caseFieldElId(f.key));
    lab.textContent = caseFieldDisplayLabel(f);
    fg.appendChild(lab);

    let input;
    if (type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.style.width = '100%';
    } else if (type === 'select' || f.key === 'category' || f.key === 'qual') {
        input = document.createElement('select');
        input.innerHTML = '<option value="">Select</option>';
        const opts =
            f.key === 'category' && program && program.enabledCategories
                ? program.enabledCategories.map((c) => ({
                      value: c,
                      label:
                          c === 'agnikarma'
                              ? 'Agnikarma'
                              : c === 'viddhakarma'
                                ? 'Viddhakarma'
                                : c === 'both'
                                  ? 'Both (Agnikarma & Viddhakarma)'
                                  : c
                  }))
                : Array.isArray(f.options)
                  ? f.options
                  : [];
        opts.forEach((o) => {
            const opt = document.createElement('option');
            opt.value = o.value != null ? o.value : o.label;
            opt.textContent = o.label != null ? o.label : opt.value;
            input.appendChild(opt);
        });
    } else {
        input = document.createElement('input');
        input.type =
            type === 'email'
                ? 'email'
                : type === 'tel'
                  ? 'tel'
                  : type === 'number'
                    ? 'number'
                    : type === 'date'
                      ? 'date'
                      : 'text';
        if (type === 'tel') {
            input.inputMode = 'tel';
            input.maxLength = 15;
        }
    }
    input.id = caseFieldElId(f.key);
    input.className = 'case-form-input';
    if (f.required !== false && type !== 'select' && f.key !== 'category') input.required = true;
    fg.appendChild(input);
    host.appendChild(fg);
}

function renderCaseFormFields(program) {
    const host = document.getElementById('case-form-fields');
    if (!host) return;
    host.innerHTML = '';
    const fields = getCaseEnabledFormFields(program).filter(function (f) {
        return f.key !== 'agree_terms' && normalizeCaseFieldType(f.type) !== 'terms';
    });
    let i = 0;
    while (i < fields.length) {
        const f = fields[i];
        if (
            f.key === 'fname' &&
            i + 2 < fields.length &&
            fields[i + 1].key === 'mname' &&
            fields[i + 2].key === 'lname'
        ) {
            renderCaseNameRow(host, [f, fields[i + 1], fields[i + 2]], program);
            i += 3;
            continue;
        }
        renderCaseFormField(host, f, program);
        i += 1;
    }
}

function applyCaseFormFieldValues(values) {
    const src = values || {};
    Object.keys(src).forEach((key) => {
        const group = document.getElementById(caseFieldElId(key));
        if (group && group.classList && group.classList.contains('case-multiselect-group')) {
            const vals = String(src[key] || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            group.querySelectorAll('input.case-ms-opt').forEach((cb) => {
                cb.checked = vals.indexOf(cb.value) !== -1;
            });
            return;
        }
        const el = document.getElementById(caseFieldElId(key));
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!src[key] && src[key] !== '0';
        else if (el.type !== 'file') el.value = src[key] == null ? '' : String(src[key]);
    });
}

function applyCaseFormConfigFromProgram(program) {
    renderCaseFormFields(program);
    const note = document.getElementById('case-program-limits-note');
    if (note && program) {
        const parts = [];
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
    clearCaseGridCountdownTimer();
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
        let hasUpcoming = false;
        activeCasePrograms.forEach((p) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.padding = '16px';
            const w = registrationWindowState(p);
            const win = w.state;
            if (win === 'upcoming') hasUpcoming = true;
            const regStartLabel = p.registration_start ? formatTrackDateTime(p.registration_start) : '';
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
                    '<div style="background:#eef2ff;border-radius:10px;padding:14px;margin-top:10px;border:1px solid #c7d2fe;">' +
                    '<p style="font-size:0.8rem;color:#4338ca;font-weight:600;margin:0;"><i class="fas fa-hourglass-half"></i> Applications open in</p>' +
                    (regStartLabel
                        ? '<p style="font-size:0.88rem;color:#312e81;margin:6px 0 0;">' + escapeHtml(regStartLabel) + '</p>'
                        : '') +
                    '<p id="case-reg-countdown-' +
                    p.id +
                    '" style="font-size:1.15rem;font-weight:700;color:#1a237e;margin:8px 0 0;">' +
                    (w.opensAt != null ? formatCountdownTo(w.opensAt) : '—') +
                    '</p></div>' +
                    '<button type="button" class="btn-primary" style="margin-top:8px;opacity:0.55;" disabled>Apply now</button>';
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
                <p style="font-size:0.78rem;margin-top:6px;color:${win === 'open' ? '#059669' : win === 'upcoming' ? '#4338ca' : '#64748b'};">Status: ${escapeHtml(win === 'open' ? 'Open for applications' : win === 'upcoming' ? 'Opening soon — see countdown' : 'Closed')}</p>
                ${slots}
                ${btn}`;
            grid.appendChild(card);
        });
        if (hasUpcoming) startCaseGridCountdownTimer();
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<p style="color:#b91c1c;">Could not load programs.</p>';
    }
}

async function startCaseApplication(programId) {
    const progEarly = activeCasePrograms.find((p) => Number(p.id) === Number(programId));
    if (progEarly && registrationWindowState(progEarly).state === 'upcoming') {
        alert('Applications are not open yet. Please wait until the countdown reaches zero.');
        return;
    }
    activeCaseProgramId = programId;
    window.__caseStagedUploadIds = null;
    window.__caseStagedFileMeta = [];
    const prog = activeCasePrograms.find((p) => Number(p.id) === Number(programId));
    activeCaseProgram = prog || null;
    const grid = document.getElementById('case-programs-grid');
    const form = document.getElementById('case-application-form');
    if (grid) grid.classList.add('hidden');
    if (form) form.classList.remove('hidden');
    const titleEl = document.getElementById('case-form-program-title');
    if (titleEl && prog) titleEl.textContent = prog.title;
    const prefillNote = document.getElementById('case-prefill-note');
    if (prefillNote) {
        prefillNote.classList.add('hidden');
        prefillNote.textContent = '';
    }
    try {
        const detailRes = await fetch('/api/case/programs/' + programId);
        if (detailRes.ok) {
            activeCaseProgram = await detailRes.json();
            applyCaseFormConfigFromProgram(activeCaseProgram);
        } else if (prog) {
            applyCaseFormConfigFromProgram(prog);
        }
        enterCaseApplicationWizard();
        const q =
            activeCaseProgram && activeCaseProgram.seminar_id
                ? `?seminarId=${activeCaseProgram.seminar_id}`
                : prog && prog.seminar_id
                  ? `?seminarId=${prog.seminar_id}`
                  : '';
        const uid = doctorNumericUserId();
        const res = await fetch('/api/case/prefill/' + uid + q);
        const pre = await res.json();
        applyCaseFormFieldValues(pre);
        if (pre.fromRegistration && prefillNote) {
            prefillNote.textContent = 'Details loaded from your seminar registration.';
            prefillNote.classList.remove('hidden');
        }
    } catch (e) {
        console.error(e);
        enterCaseApplicationWizard();
    }
}

async function initDoctorVolunteerNav() {
    if (!currentUser) return;
    window.__doctorHasVolunteerAssignments = false;
    if (!doctorTabModuleEnabled('tab-volunteer')) {
        applyDoctorAllowedTabsToDom(__doctorAllowedTabs);
        return;
    }
    try {
        const res = await fetch('/api/doctor/volunteer-assignments/' + currentUser.id);
        const rows = await res.json().catch(function () {
            return [];
        });
        window.__doctorHasVolunteerAssignments = !!(res.ok && Array.isArray(rows) && rows.length);
    } catch (e) {
        console.error(e);
        window.__doctorHasVolunteerAssignments = false;
    }
    applyDoctorAllowedTabsToDom(__doctorAllowedTabs);
}

async function loadDoctorVolunteerPanel() {
    const panel = document.getElementById('volunteer-panel');
    if (!panel || !currentUser) return;
    panel.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/doctor/volunteer-assignments/' + currentUser.id);
        const rows = await res.json().catch(function () {
            return {};
        });
        if (!res.ok) {
            panel.innerHTML =
                '<p style="color:#b91c1c;">' +
                escapeHtml((rows && rows.error) || 'Could not load volunteer assignments.') +
                '</p>';
            return;
        }
        if (!Array.isArray(rows) || !rows.length) {
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

let activeCaseDraftId = null;

function collectCaseFormPayload() {
    const form = {};
    (activeCaseProgram && activeCaseProgram.formFields ? activeCaseProgram.formFields : []).forEach((f) => {
        if (!f || !f.key) return;
        const el = document.getElementById(caseFieldElId(f.key));
        if (!el) return;
        if (el.type === 'checkbox') form[f.key] = el.checked ? '1' : '';
        else if (el.type !== 'file') form[f.key] = el.value;
    });
    if (!form.fname) form.fname = document.getElementById('case-fname')?.value || '';
    if (!form.lname) form.lname = document.getElementById('case-lname')?.value || '';
    if (!form.email) form.email = document.getElementById('case-email')?.value || '';
    if (!form.phone) form.phone = document.getElementById('case-phone')?.value || '';
    if (!form.whatsapp) form.whatsapp = document.getElementById('case-whatsapp')?.value || '';
    if (!form.category) form.category = document.getElementById('case-category')?.value || '';
    if (!form.topic) form.topic = document.getElementById('case-topic')?.value || '';
    return form;
}

async function saveCaseDraft() {
    const uid = doctorUserIdOrAlert();
    if (!uid || !activeCaseProgramId) return alert('Open a case program form first.');
    const statusEl = document.getElementById('case-draft-status');
    if (statusEl) statusEl.textContent = 'Saving draft…';
    const form = collectCaseFormPayload();
    try {
        const res = await fetch('/api/case/draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: uid,
                caseProgramId: activeCaseProgramId,
                formData: form
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save draft');
        activeCaseDraftId = data.submissionId;
        if (statusEl) {
            statusEl.style.color = '#059669';
            statusEl.textContent =
                'Draft saved (' +
                (data.applicationNo || '') +
                '). Submit while applications are open.';
        }
        loadCaseApplications();
    } catch (e) {
        if (statusEl) {
            statusEl.style.color = '#b91c1c';
            statusEl.textContent = e.message || 'Could not save draft.';
        }
    }
}

window.saveCaseDraft = saveCaseDraft;

async function submitCasePresentation() {
    const validated = await validateCaseFormBeforePreviewOrSubmit();
    if (!validated) return;
    const uid = validated.uid;
    const form = validated.form;
    const allFiles = validated.allFiles || [];
    if (!form.category && activeCaseProgram && activeCaseProgram.enabledCategories && activeCaseProgram.enabledCategories.length) {
        form.category = activeCaseProgram.enabledCategories[0];
    }
    if (!form.topic) form.topic = 'Case presentation';
    const maxFiles = (activeCaseProgram && activeCaseProgram.maxFilesPerSubmission) || 5;
    const uploadCfg = await ensureCaseUploadConfig(activeCaseProgramId);
    const maxMb = effectiveCaseMaxMb(activeCaseProgram, uploadCfg);
    const useR2 = uploadCfg && CaseR2Upload.isEnabled(uploadCfg) && allFiles.length;

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
    if (!uploadedFileIds.length && allFiles.length) {
        for (let i = 0; i < allFiles.length; i++) {
            const raw = allFiles[i];
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
                const dt = new DataTransfer();
                allFiles.forEach((f) => dt.items.add(f));
                uploadedFileIds = await CaseR2Upload.uploadFiles(dt.files, {
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
            for (let i = 0; i < allFiles.length; i++) {
                const ready = await prepareUploadFileOrAlert(allFiles[i]);
                if (!ready) return;
                preparedFiles.push(ready);
            }
            const fdLegacy = new FormData();
            fdLegacy.append('userId', String(uid));
            fdLegacy.append('caseProgramId', String(activeCaseProgramId));
            fdLegacy.append('formData', JSON.stringify(form));
            if (activeCaseDraftId) fdLegacy.append('draftSubmissionId', String(activeCaseDraftId));
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
    if (activeCaseDraftId) fd.append('draftSubmissionId', String(activeCaseDraftId));
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
    if (s === 'draft') return 'Draft (not submitted)';
    if (s === 'revision_required') return 'Re-upload documents required';
    if (s === 'documents_requested') return 'Additional documents requested';
    if (s === 'priority_invited') return 'Complete application (priority)';
    if (s === 'judging') return 'Judging in progress';
    if (s === 'judged') return 'Final review in progress';
    if (s === 'under_review') return 'Under review';
    if (s === 'approved_for_judging') return 'Approved for judging';
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
            return [r.id, r.status, stepSig].join(':');
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
    let fd = {};
    try {
        fd = c.form_data ? (typeof c.form_data === 'string' ? JSON.parse(c.form_data) : c.form_data) : {};
    } catch (_) {
        fd = {};
    }
    let y = pdfVgmfCaseHeader(doc, 'Case presentation application', c.application_no || c.id);
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
    row('Application no.', c.application_no || c.id);
    row('Programme', c.program_title);
    row('Full name', [fd.fname, fd.mname, fd.lname].filter(Boolean).join(' ') || [c.first_name, c.last_name].filter(Boolean).join(' '));
    row('Email', fd.email || c.email);
    row('Phone', fd.phone || c.phone);
    row('WhatsApp', fd.whatsapp);
    row('Category', c.category);
    row('Status', caseApplicationStatusLabel(c.status));
    const skipKeys = new Set(['fname', 'mname', 'lname', 'email', 'phone', 'whatsapp', 'category', 'topic', 'agree_terms']);
    Object.keys(fd).forEach((key) => {
        if (skipKeys.has(key)) return;
        const val = fd[key];
        if (val == null || String(val).trim() === '') return;
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
        const display = key === 'agree_terms' || val === '1' ? (val === '1' ? 'Yes' : 'No') : val;
        row(label, display);
    });
    row('Files uploaded', c.file_count || 0);
    y += 8;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text(COMPUTER_GENERATED_NOTICE, 105, y, { align: 'center', maxWidth: 170 });
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

function i18nT(key, vars) {
    const fallbacks = {
        'common.open': 'Open',
        'common.print': 'Print',
        'pay.chooseMethod': 'Choose payment method',
        'pay.redirecting':
            'Redirecting to secure payment. After paying, return to My Applications for your e-ticket.'
    };
    let s = fallbacks[key] || key;
    if (vars && typeof vars === 'object') {
        Object.keys(vars).forEach((name) => {
            s = String(s).split('{{' + name + '}}').join(String(vars[name]));
        });
    }
    return s;
}

function certificateViewUrl(c, isVolunteer) {
    const uid = currentUser && currentUser.id != null ? Number(currentUser.id) : 0;
    if (!uid || !c.id) return '#';
    const q = isVolunteer ? `vc=${c.id}&uid=${uid}` : `uc=${c.id}&uid=${uid}`;
    return `/certificate/view?${q}`;
}

function certificateDownloadUrl(c, isVolunteer) {
    const uid = currentUser && currentUser.id != null ? Number(currentUser.id) : 0;
    if (!uid || !c.id) return '#';
    const q = isVolunteer ? `vc=${c.id}&uid=${uid}` : `uc=${c.id}&uid=${uid}`;
    return `/certificate/download?${q}`;
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

function formatCertCountdownParts(targetMs) {
    const diff = Math.max(0, targetMs - Date.now());
    if (diff <= 0) return null;
    const sec = Math.floor(diff / 1000) % 60;
    const min = Math.floor(diff / 60000) % 60;
    const hr = Math.floor(diff / 3600000) % 24;
    const day = Math.floor(diff / 86400000);
    return { day, hr, min, sec, diff };
}

function renderDoctorCertCountdownHtml(countdown, elementId) {
    if (!countdown || !countdown.opensAt) return '';
    const targetMs = new Date(countdown.opensAt).getTime();
    const parts = formatCertCountdownParts(targetMs);
    const label = escapeHtml(countdown.label || 'Certificate available in');
    if (!parts) {
        return (
            '<div style="text-align:center;padding:20px;background:#ecfdf5;border-radius:10px;border:1px solid #a7f3d0;margin-top:12px;">' +
            '<p style="margin:0;font-weight:600;color:#047857;">Unlocking now… refresh in a moment.</p></div>'
        );
    }
    const idAttr = elementId ? ' id="' + escapeHtml(elementId) + '"' : '';
    return (
        '<div style="text-align:center;padding:20px;background:#fffbeb;border-radius:10px;border:1px solid #fde68a;margin-top:12px;">' +
        '<p style="margin:0 0 12px;font-size:0.82rem;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.04em;">' +
        label +
        '</p>' +
        '<div' +
        idAttr +
        ' style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;font-variant-numeric:tabular-nums;">' +
        (parts.day
            ? '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
              parts.day +
              '</strong><span style="font-size:0.72rem;color:#92400e;">days</span></div>'
            : '') +
        '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
        parts.hr +
        '</strong><span style="font-size:0.72rem;color:#92400e;">hrs</span></div>' +
        '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
        parts.min +
        '</strong><span style="font-size:0.72rem;color:#92400e;">min</span></div>' +
        '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
        parts.sec +
        '</strong><span style="font-size:0.72rem;color:#92400e;">sec</span></div>' +
        '</div></div>'
    );
}

function renderDoctorCertWaitingBlock(track) {
    const t = track || {};
    const reason = t.certHiddenReason || 'Your certificate is not available yet.';
    let html =
        '<div style="padding:8px 0;">' +
        '<p style="margin:0 0 10px;font-size:0.9rem;color:#64748b;line-height:1.5;">' +
        escapeHtml(reason) +
        '</p>';
    if (t.scansRequired === 2 && t.paid && !t.checkinComplete) {
        html +=
            '<p style="margin:0 0 10px;font-size:0.85rem;font-weight:600;color:#b45309;"><i class="fas fa-qrcode"></i> Scans: ' +
            escapeHtml(String(t.scanCount || 0)) +
            ' / 2 (entry + exit)</p>';
    }
    if (t.certCountdown) {
        html += renderDoctorCertCountdownHtml(t.certCountdown, 'doctor-cert-cd-' + (t.seminarId || t.certId || 'x'));
    } else if (t.certPhase === 'awaiting_scans' || t.certPhase === 'awaiting_approval') {
        html +=
            '<p style="margin:0;font-size:0.82rem;color:#94a3b8;"><i class="fas fa-hourglass-half"></i> Status updates automatically on this page.</p>';
    }
    html += '</div>';
    return html;
}

let doctorCertCountdownTimer = null;

function tickDoctorCertCountdowns() {
    let needReload = false;
    document.querySelectorAll('[id^="doctor-cert-cd-"]').forEach((el) => {
        const sid = el.id.replace('doctor-cert-cd-', '');
        const track = (window.__doctorCertTrackingRows || []).find(
            (r) => String(r.seminarId) === sid || String(r.certId) === sid
        );
        if (!track || !track.certCountdown) return;
        const targetMs = new Date(track.certCountdown.opensAt).getTime();
        const parts = formatCertCountdownParts(targetMs);
        if (!parts) {
            needReload = true;
            return;
        }
        el.innerHTML =
            (parts.day
                ? '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
                  parts.day +
                  '</strong><span style="font-size:0.72rem;color:#92400e;">days</span></div>'
                : '') +
            '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
            parts.hr +
            '</strong><span style="font-size:0.72rem;color:#92400e;">hrs</span></div>' +
            '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
            parts.min +
            '</strong><span style="font-size:0.72rem;color:#92400e;">min</span></div>' +
            '<div style="min-width:52px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #fcd34d;"><strong style="display:block;font-size:1.2rem;color:#78350f;">' +
            parts.sec +
            '</strong><span style="font-size:0.72rem;color:#92400e;">sec</span></div>';
    });
    if (needReload) {
        loadDoctorCertificates();
        loadDoctorCertificateTracking(true);
    }
}

function startDoctorCertCountdownTimer() {
    if (doctorCertCountdownTimer) clearInterval(doctorCertCountdownTimer);
    tickDoctorCertCountdowns();
    doctorCertCountdownTimer = setInterval(tickDoctorCertCountdowns, 1000);
}

function stopDoctorCertCountdownTimer() {
    if (doctorCertCountdownTimer) {
        clearInterval(doctorCertCountdownTimer);
        doctorCertCountdownTimer = null;
    }
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

async function loadDoctorCertificateModule() {
    await loadDoctorCertificateTracking();
    await loadDoctorCertificates();
}

let __doctorCertYearFilter = null;

function renderDoctorCertYearNav(yearsPayload) {
    const nav = document.getElementById('doctor-cert-years-nav');
    if (!nav) return;
    const years = (yearsPayload && yearsPayload.years) || [];
    if (!years.length) {
        nav.innerHTML = '';
        return;
    }
    const active = __doctorCertYearFilter;
    let html =
        '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;"><span style="font-size:0.82rem;color:#64748b;font-weight:600;">' +
        'Year' +
        ':</span>';
    const allActive = active == null;
    html +=
        '<button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.82rem;' +
        (allActive ? '' : 'background:#e2e8f0;color:#334155;') +
        '" onclick="doctorSetCertYearFilter(null)">' +
        'All years' +
        '</button>';
    years.forEach((y) => {
        const n = Number(y.year) || 0;
        if (!n) return;
        const issued = (y.seminars || []).filter((s) => s.certEnabled && s.scanVerified).length;
        const attended = (y.seminars || []).length;
        const on = active === n;
        html +=
            '<button type="button" class="btn-primary" style="padding:6px 12px;font-size:0.82rem;' +
            (on ? '' : 'background:#e2e8f0;color:#334155;') +
            '" onclick="doctorSetCertYearFilter(' +
            n +
            ')">' +
            escapeHtml(String(n)) +
            ' <span style="opacity:0.85;">(' +
            issued +
            '/' +
            attended +
            ')</span></button>';
    });
    html += '</div>';
    nav.innerHTML = html;
}

function doctorSetCertYearFilter(year) {
    __doctorCertYearFilter = year == null ? null : Number(year);
    loadDoctorCertificates();
}
window.doctorSetCertYearFilter = doctorSetCertYearFilter;

async function loadDoctorCertificates() {
    const wrap = document.getElementById('doctor-certificates-wrap');
    if (!wrap || !currentUser) return;
    wrap.innerHTML = '<p style="color:#64748b;text-align:center;">Loading…</p>';
    try {
        const uid = await ensureDoctorInternalUserId();
        if (!uid) {
            wrap.innerHTML = '<p style="color:#b91c1c;">Please sign out and sign in again.</p>';
            return;
        }
        const idQ = doctorUserIdQuerySuffix();
        const yearQ =
            __doctorCertYearFilter != null && Number.isFinite(__doctorCertYearFilter)
                ? '&year=' + encodeURIComponent(String(__doctorCertYearFilter))
                : '';
        const [yearsRes, res, vres] = await Promise.all([
            fetch('/api/doctor/certificate-years/' + uid + idQ),
            fetch('/api/doctor/certificates/' + uid + idQ + yearQ),
            fetch('/api/doctor/volunteer-certificates/' + uid + idQ + yearQ)
        ]);
        const yearsPayload = await yearsRes.json().catch(() => ({ years: [] }));
        renderDoctorCertYearNav(yearsPayload);
        const rows = await res.json().catch(() => []);
        const vrows = await vres.json().catch(() => []);
        const trackingRows = Array.isArray(window.__doctorCertTrackingRows) ? window.__doctorCertTrackingRows : [];
        window.__doctorCertTrackingRows = trackingRows;
        const trackBySeminar = new Map();
        const trackByCertId = new Map();
        trackingRows.forEach((tr) => {
            if (tr.seminarId != null) trackBySeminar.set(Number(tr.seminarId), tr);
            if (tr.certId != null) trackByCertId.set(Number(tr.certId), tr);
        });
        const all = [...(Array.isArray(rows) ? rows : []), ...(Array.isArray(vrows) ? vrows.map((v) => ({ ...v, _volunteer: true })) : [])];
        const paidTracking = trackingRows.filter((tr) => tr.paid);
        if (!all.length && !paidTracking.length) {
            wrap.innerHTML = doctorCertificateLockedBlock();
            stopDoctorCertCountdownTimer();
            return;
        }
        wrap.innerHTML = '';
        const renderedSeminars = new Set();
        const renderWaitingCard = (title, track) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.style.marginBottom = '16px';
            card.innerHTML =
                '<h4 style="margin:0 0 12px;color:#92400e;">' +
                escapeHtml(title) +
                '</h4>' +
                renderDoctorCertWaitingBlock(track);
            wrap.appendChild(card);
        };
        all.forEach((c) => {
            const track =
                trackByCertId.get(Number(c.id)) ||
                trackBySeminar.get(Number(c.seminar_id)) ||
                null;
            const title = (c.seminar_title || 'Seminar') + (c._volunteer ? ' (Volunteer)' : '');
            renderedSeminars.add(Number(c.seminar_id));
            const card = document.createElement('div');
            card.className = 'card';
            card.style.marginBottom = '16px';
            const canView = track ? !!track.canViewCertificate : false;
            if (!canView) {
                renderWaitingCard(
                    title,
                    track || { certHiddenReason: 'Your certificate is not available yet. Complete venue scans and wait for foundation approval.' }
                );
                return;
            }
            const titleEsc = escapeHtml(title);
            const name = escapeHtml(c.display_name || '');
            const viewUrl = certificateViewUrl(c, !!c._volunteer);
            const dlUrl = certificateDownloadUrl(c, !!c._volunteer);
            const dlTitle = String(c.seminar_title || 'Seminar').replace(/'/g, "\\'");
            if (isBuiltinCertificateTemplate(c.template_path)) {
                card.innerHTML =
                    `<h4 style="margin:0 0 8px;color:#92400e;">${titleEsc}</h4>` +
                    `<p style="font-size:0.88rem;color:#78716c;margin-bottom:10px;">${name}</p>` +
                    `<div style="border:2px solid #e8d48a;border-radius:10px;overflow:hidden;"><iframe src="${viewUrl}" style="width:100%;min-height:420px;border:0;"></iframe></div>` +
                    `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">` +
                    `<a href="${viewUrl}" target="_blank" class="btn-primary" style="text-decoration:none;background:linear-gradient(135deg,#c9a227,#a67c00);padding:8px 14px;">${escapeHtml(i18nT('common.open'))}</a>` +
                    `<button type="button" class="btn-primary" style="background:#15803d;padding:8px 14px;" onclick="downloadDoctorCertificate('${dlUrl}', '${dlTitle}')"><i class="fas fa-download"></i> Download certificate</button>` +
                    `<button type="button" class="btn-primary" style="background:#475569;padding:8px 14px;" onclick="var w=window.open('${viewUrl}');if(w)w.print();">${escapeHtml(i18nT('common.print'))}</button></div>`;
                wrap.appendChild(card);
                return;
            }
            const isImage = !c.mime_type || String(c.mime_type).startsWith('image/');
            if (isImage) {
                card.innerHTML = `<h4 style="margin:0 0 8px;">${titleEsc}</h4>
                    <p style="font-size:0.88rem;color:#64748b;margin-bottom:8px;">${name}</p>
                    <div style="position:relative;max-width:720px;margin:0 auto;">
                        <img src="${c.template_path}" alt="Certificate" style="width:100%;border-radius:8px;border:1px solid #e2e8f0;">
                        <div style="position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);font-size:clamp(1rem,3vw,1.75rem);font-weight:700;color:#1e3a5f;text-align:center;width:80%;text-shadow:0 0 8px rgba(255,255,255,0.9);">${name}</div>
                    </div>
                    <button type="button" class="btn-primary" style="margin-top:12px;" onclick="window.print()">${escapeHtml(i18nT('common.print'))} / PDF</button>`;
            } else {
                card.innerHTML = `<h4 style="margin:0 0 8px;">${titleEsc}</h4>
                    <p style="margin-bottom:12px;">${name}</p>
                    <a href="${c.template_path}" download class="btn-primary" style="display:inline-block;padding:8px 14px;text-decoration:none;">Download certificate</a>`;
            }
            wrap.appendChild(card);
        });
        paidTracking.forEach((tr) => {
            if (renderedSeminars.has(Number(tr.seminarId))) return;
            renderWaitingCard(tr.seminarTitle || 'Seminar', tr);
        });
        const hasCountdown = window.__doctorCertTrackingRows.some((tr) => tr.certCountdown && !tr.canViewCertificate);
        if (hasCountdown) startDoctorCertCountdownTimer();
        else stopDoctorCertCountdownTimer();
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
        if (step >= 2 && !validateSeminarEventSelectionOrAlert()) return;
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

    const semName = String((document.getElementById('registration-seminar-name') || {}).innerText || '')
        .replace(/^Registering for:\s*/i, '')
        .replace(/^Waiting list —\s*/i, '')
        .replace(/^Draft —\s*/i, '')
        .trim();
    syncLiveActivity({
        kind: 'seminar_apply',
        seminarId: activeSeminarIdForReg,
        seminarTitle: semName || undefined,
        stepNumber: step,
        stepLabel: REGISTRATION_STEP_LABELS[step] || 'Step ' + step,
        formProgress: Math.round((step / REGISTRATION_PREVIEW_STEP) * 100)
    });
}

let currentPdfBlobUrl = null;
let currentCasePdfBlobUrl = null;

function pdfVgmfCaseHeader(doc, subtitle, applicationNo) {
    doc.setFillColor(13, 92, 77);
    doc.rect(0, 0, 210, 50, 'F');
    doc.setFillColor(184, 134, 11);
    doc.rect(0, 48, 210, 2, 'F');
    const hasLogo = !!window.__siteLogoPdfDataUrl;
    if (hasLogo) {
        try {
            doc.addImage(window.__siteLogoPdfDataUrl, 'PNG', 14, 9, 26, 26);
        } catch (_) {}
    }
    doc.setFontSize(14);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('Vaidya Gogate Memorial Foundation', hasLogo ? 46 : 105, 18, { align: hasLogo ? 'left' : 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(subtitle || 'Case presentation application', hasLogo ? 46 : 105, 28, { align: hasLogo ? 'left' : 'center' });
    if (applicationNo) {
        doc.setFontSize(9);
        doc.setTextColor(236, 253, 245);
        doc.text('Application no. ' + String(applicationNo), 196, 44, { align: 'right' });
    }
    return 56;
}

function preloadSiteLogoForPdf() {
    if (window.__siteLogoPdfDataUrl) return Promise.resolve();
    const path = window.__siteLogoPath || siteLogoPath;
    if (!path) return Promise.resolve();
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            try {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth || img.width;
                c.height = img.naturalHeight || img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                window.__siteLogoPdfDataUrl = c.toDataURL('image/png');
            } catch (_) {}
            resolve();
        };
        img.onerror = () => resolve();
        img.src = path;
    });
}

function getCasePreviewApplicationNo() {
    if (window.__draftCaseApplicationNo) return window.__draftCaseApplicationNo;
    window.__draftCaseApplicationNo = generateClientApplicationNo();
    return window.__draftCaseApplicationNo;
}

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
    doc.text(subtitle || 'Seminar registration', 105, 28, { align: 'center' });
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

function seminarVenueDisplayName(s) {
    if (!s) return 'TBD';
    if (s.venue_tbd || s.venueTbd) return 'TBD';
    const label = String(s.venue_label || s.venueLabel || '').trim();
    const text = String(s.location_text || s.locationText || '').trim();
    return label || text || 'TBD';
}

function seminarVenueMapHtml(s, opts) {
    opts = opts || {};
    const compact = !!opts.compact;
    const locText = seminarVenueDisplayName(s);
    const tbd = locText === 'TBD';
    const embed = (s && (s.maps_embed_url || s.mapsEmbedUrl)) || '';

    if (tbd && !embed) {
        return (
            '<div class="seminar-venue-block seminar-venue-tbd" style="margin-top:10px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
            '<p style="margin:0;font-size:0.88rem;"><i class="fas fa-map-marker-alt" style="color:#64748b;"></i> <strong>Venue:</strong> TBD</p>' +
            '<p style="font-size:0.8rem;color:#64748b;margin:6px 0 0;">The venue will be announced before the event.</p></div>'
        );
    }

    let html =
        '<div class="seminar-venue-block" style="margin-top:10px;padding:10px 12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;">' +
        '<p style="margin:0;font-size:0.88rem;"><i class="fas fa-map-marker-alt" style="color:#0369a1;"></i> <strong>Venue:</strong> ' +
        escapeHtml(locText) +
        '</p>';
    if (embed && !compact) {
        html +=
            '<div class="seminar-map-embed" style="margin-top:10px;border-radius:8px;overflow:hidden;border:1px solid #cbd5e1;">' +
            '<iframe title="Event location map" src="' +
            escapeHtml(embed) +
            '" width="100%" height="180" style="border:0;display:block;" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>';
    }
    const mapsSearch = encodeURIComponent(s.location_text || s.locationText || locText);
    if (!tbd && mapsSearch) {
        html +=
            '<p style="font-size:0.78rem;margin:8px 0 0;"><a href="https://www.google.com/maps/search/?api=1&query=' +
            mapsSearch +
            '" target="_blank" rel="noopener noreferrer">Open in Google Maps</a></p>';
    }
    html += '</div>';
    return html;
}

function renderRegSeminarVenuePanel(seminar) {
    const panel = document.getElementById('reg-seminar-venue-panel');
    if (!panel) return;
    const events = (seminar && (seminar.sub_events || seminar.subEvents)) || [];
    if (events.length) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }
    panel.innerHTML = seminarVenueMapHtml(seminar, { compact: false });
    panel.classList.remove('hidden');
}

function seminarFeeLabelHtml(s) {
    const evs = (s && (s.sub_events || s.subEvents)) || [];
    if (!evs.length) {
        return '<p style="font-size:0.85rem;margin-top:8px;"><strong>Fee:</strong> ₹' + (s.price || 0) + '</p>';
    }
    let html =
        '<div style="margin-top:8px;padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:0.84rem;">' +
        '<strong style="color:#047857;">Sessions (choose at registration)</strong>';
    if (Number(s.price) > 0) {
        html += '<p style="margin:6px 0 0;color:#334155;">Base seminar fee: <strong>₹' + (Number(s.price) || 0) + '</strong> (added to selected sessions)</p>';
    }
    html += '<ul style="margin:8px 0 0;padding-left:18px;line-height:1.5;">';
    evs.forEach(function (ev) {
        const when = ev.eventDate || ev.event_date ? formatEventDate(ev.eventDate || ev.event_date) : '';
        const loc = ev.venueTbd || ev.venue_tbd ? 'TBD' : ev.locationText || ev.location_text || '';
        html +=
            '<li><strong>' +
            escapeHtml(ev.title) +
            '</strong>' +
            (when ? ' · ' + escapeHtml(when) : '') +
            ' · <i class="fas fa-map-marker-alt"></i> ' +
            escapeHtml(loc || 'TBD') +
            ' — ₹' +
            (Number(ev.price) || 0) +
            '</li>';
    });
    html += '</ul></div>';
    return html;
}

function renderSeminarEventPicker(seminar) {
    const panel = document.getElementById('reg-seminar-events-panel');
    if (!panel) return;
    const events = (seminar && (seminar.sub_events || seminar.subEvents)) || [];
    if (!events.length) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }
    let html =
        '<p style="font-weight:700;color:#047857;margin:0 0 10px;"><i class="fas fa-calendar-day"></i> Choose session(s) to attend</p>' +
        '<p style="font-size:0.84rem;color:#64748b;margin:0 0 12px;">Select one or both. Payment is the base seminar fee plus the sum of selected sessions. Each session has its own e-ticket, scanner check-in, and certificate.</p>';
    events.forEach(function (ev) {
        const dt = ev.eventDate || ev.event_date;
        const loc = ev.venueTbd || ev.venue_tbd ? 'TBD' : ev.locationText || ev.location_text || '';
        const embed = ev.mapsEmbedUrl || ev.maps_embed_url || '';
        const desc = ev.description || '';
        html +=
            '<label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;padding:10px;background:#fff;border:1px solid #bbf7d0;border-radius:8px;cursor:pointer;">' +
            '<input type="checkbox" class="reg-event-cb" value="' +
            Number(ev.id) +
            '" style="margin-top:4px;">' +
            '<span><strong>' +
            escapeHtml(ev.title) +
            '</strong>' +
            (dt ? '<br><span style="font-size:0.82rem;color:#64748b;">' + escapeHtml(formatEventDate(dt)) + '</span>' : '') +
            '<br><span style="font-size:0.82rem;color:#64748b;"><i class="fas fa-map-marker-alt"></i> ' +
            escapeHtml(loc || 'TBD') +
            '</span>' +
            (embed
                ? '<div class="seminar-map-embed" style="margin-top:8px;border-radius:8px;overflow:hidden;border:1px solid #cbd5e1;max-width:320px;"><iframe title="Session location" src="' +
                  escapeHtml(embed) +
                  '" width="100%" height="140" style="border:0;display:block;" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe></div>'
                : loc === 'TBD'
                  ? '<br><span style="font-size:0.78rem;color:#94a3b8;">Venue to be announced</span>'
                  : '') +
            (desc ? '<br><span style="font-size:0.82rem;color:#475569;">' + escapeHtml(desc) + '</span>' : '') +
            '<br><span style="font-size:0.9rem;color:#047857;font-weight:700;">₹' +
            (Number(ev.price) || 0) +
            '</span></span></label>';
    });
    html += '<p id="reg-events-total" style="margin:8px 0 0;font-weight:700;color:#334155;"></p>';
    panel.innerHTML = html;
    panel.classList.remove('hidden');
    panel.querySelectorAll('.reg-event-cb').forEach(function (cb) {
        cb.addEventListener('change', updateRegEventTotal);
    });
    updateRegEventTotal();
}

function getSelectedSeminarEventIds() {
    return Array.from(document.querySelectorAll('.reg-event-cb:checked'))
        .map(function (el) {
            return parseInt(el.value, 10);
        })
        .filter(function (n) {
            return Number.isInteger(n) && n > 0;
        });
}

function updateRegEventTotal() {
    const el = document.getElementById('reg-events-total');
    if (!el) return;
    const sid = parseInt(activeSeminarIdForReg, 10);
    const s = activeSeminars.find(function (x) {
        return Number(x.id) === sid;
    });
    const events = (s && (s.sub_events || s.subEvents)) || [];
    const ids = getSelectedSeminarEventIds();
    const base = Number(s && s.price) || 0;
    let sessionsTotal = 0;
    events.forEach(function (ev) {
        if (ids.indexOf(Number(ev.id)) >= 0) sessionsTotal += Number(ev.price) || 0;
    });
    const total = base + sessionsTotal;
    if (!ids.length) {
        el.textContent = 'Select at least one session';
        return;
    }
    if (base > 0 && sessionsTotal > 0) {
        el.textContent = 'Selected total: ₹' + total + ' (base ₹' + base + ' + sessions ₹' + sessionsTotal + ')';
    } else if (base > 0) {
        el.textContent = 'Selected total: ₹' + total + ' (base fee ₹' + base + ')';
    } else {
        el.textContent = 'Selected total: ₹' + total;
    }
}

async function saveApplicationDraft() {
    const uid = doctorUserIdOrAlert();
    if (!uid) return;
    const sid = parseInt(activeSeminarIdForReg, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return alert('Open a seminar registration form first.');
    }
    const statusEl = document.getElementById('reg-draft-status');
    if (statusEl) statusEl.textContent = 'Saving draft…';
    const formDataObj = collectRegistrationFormData();
    const payload = new FormData();
    payload.append('userId', String(uid));
    if (currentUser && currentUser.user_id_string) {
        payload.append('userIdString', String(currentUser.user_id_string));
    }
    payload.append('seminarId', String(sid));
    payload.append('formData', JSON.stringify(formDataObj));
    const certFile = document.getElementById('reg-cert-file')?.files?.[0];
    if (certFile) {
        const certReady = await prepareUploadFileOrAlert(certFile);
        if (!certReady) return;
        payload.append('certificate', certReady);
    }
    try {
        const res = await fetch('/api/applications/draft', { method: 'POST', body: payload });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save draft');
        window.editingApplicationId = data.applicationId;
        window.__draftApplicationNo = data.applicationNo || window.__draftApplicationNo;
        if (statusEl) {
            statusEl.style.color = '#059669';
            statusEl.textContent =
                'Draft saved (' +
                (data.applicationNo || '') +
                '). This does not register you — submit while registration is open.';
        }
        loadSeminarsGrid();
        loadApplications();
    } catch (e) {
        if (statusEl) {
            statusEl.style.color = '#b91c1c';
            statusEl.textContent = e.message || 'Could not save draft.';
        }
    }
}

async function resumeDraftApplication(appId) {
    const draft =
        (userApplications || []).find((a) => Number(a.id) === Number(appId)) ||
        (window.__seminarDraftById &&
            Object.values(window.__seminarDraftById).find((a) => Number(a.id) === Number(appId)));
    if (!draft) {
        await loadApplications();
        return resumeDraftApplication(appId);
    }
    let formData = {};
    try {
        formData = JSON.parse(draft.form_data || '{}');
    } catch (_) {}
    if (!activeSeminars.some((x) => Number(x.id) === Number(draft.seminar_id))) {
        await loadSeminarsGrid();
    }
    window.editingApplicationId = draft.id;
    window.__draftApplicationNo = draft.application_no || null;
    switchTab('tab-seminars');
    await startRegistration(draft.seminar_id, {
        draftResume: true,
        editMode: true,
        volunteerBypass: true,
        prefillFormData: formData
    });
}

window.saveApplicationDraft = saveApplicationDraft;
window.resumeDraftApplication = resumeDraftApplication;

async function submitApplication() {
    await refreshRegistrationOverrides();
    const isEdit = !!window.editingApplicationId;
    const isDraftSubmit =
        isEdit &&
        userApplications.some(
            (a) => Number(a.id) === Number(window.editingApplicationId) && String(a.status || '').toLowerCase() === 'draft'
        );
    const sidCheck = parseInt(activeSeminarIdForReg, 10);
    if (!isEdit && Number.isInteger(sidCheck) && sidCheck > 0 && !isOverrideRegistrationActive(sidCheck)) {
        const sCheck = activeSeminars.find((x) => Number(x.id) === sidCheck);
        const winCheck = sCheck ? effectiveRegistrationWindowState(sCheck) : { state: 'closed' };
        if (winCheck.state !== 'open') {
            if (winCheck.overrideExpired) {
                return alert(
                    'Your extended registration window has ended. Ask admin to extend your register-by deadline, then try again.'
                );
            }
            return alert('Registration for this seminar has closed.');
        }
    }
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
    if (!validateSeminarEventSelectionOrAlert()) return;
    
    const formDataObj = collectRegistrationFormData();

    const uid = doctorUserIdOrAlert();
    if (!uid) return;
    const sid = parseInt(activeSeminarIdForReg, 10);
    if (!Number.isInteger(sid) || sid < 1) {
        return alert('Seminar session expired. Close the form and open the seminar again from the dashboard.');
    }

    const payload = new FormData();
    payload.append('userId', String(uid));
    if (currentUser && currentUser.user_id_string) {
        payload.append('userIdString', String(currentUser.user_id_string));
    }
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
    if (window.__registrationJoinWaitlist) {
        payload.append('joinWaitlist', '1');
    }
    
    const certFile = document.getElementById('reg-cert-file').files[0];
    if (certFile) {
        const certReady = await prepareUploadFileOrAlert(certFile);
        if (!certReady) return;
        payload.append('certificate', certReady);
    }

    try {
        if (isEdit && !isDraftSubmit) {
            const editPayload = new FormData();
            editPayload.append('formData', JSON.stringify(formDataObj));
            if (window.__otpOnStep1) {
                editPayload.append('phoneOtpToken', window.__regPhoneOtpToken || '');
                editPayload.append('emailOtpToken', window.__regEmailOtpToken || '');
            }
            editPayload.append('fieldOtpTokens', JSON.stringify(window.__fieldOtpTokens || {}));
            if (certFile) editPayload.append('certificate', certReady);
            const editRes = await fetch('/api/applications/' + encodeURIComponent(window.editingApplicationId), {
                method: 'PUT',
                body: editPayload
            });
            let editResult = {};
            try {
                editResult = await editRes.json();
            } catch (parseErr) {
                console.error(parseErr);
                return alert(
                    editRes.ok
                        ? 'Application may have been updated, but the server response was invalid. Check Track seminar applications.'
                        : 'Update failed (HTTP ' + editRes.status + '). Please try again.'
                );
            }
            if (editResult.success) {
                alert('Application updated successfully.');
                window.editingApplicationId = null;
                cancelRegistration();
                loadApplications();
            } else {
                const msg = editResult.error || 'Update failed (HTTP ' + editRes.status + ').';
                alert(/^Missing required field:/i.test(msg) ? formatRegValidationError(msg) : msg);
            }
            return;
        }

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
            alert(
                result.waitlisted
                    ? `You are on the waiting list. Application number ${result.applicationNo}. No payment is needed now — we will email you if a seat opens. Track status under View Applications.`
                    : `Application submitted successfully. Your application number is ${result.applicationNo}. You can track status under View Applications.`
            );
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
            const regId = r.registrationId != null ? r.registrationId : r.registration_id;
            if (regId) __doctorCancelRequestsByReg[regId] = r;
        });
    } catch (e) {
        console.warn('[cancel-req]', e);
    }
}

function doctorCancelRequestStatus(registrationId) {
    const r = __doctorCancelRequestsByReg[registrationId];
    if (!r) return '';
    const st = String(r.status || '').toLowerCase();
    if (st === 'pending') {
        const amt = r.refundAmount != null ? r.refundAmount : r.refund_amount;
        return amt > 0
            ? 'Cancellation pending · refund preview ₹' + amt + ' (IST)'
            : 'Cancellation pending review';
    }
    if (st === 'approved') {
        const label = r.refundStatusLabel || r.refund_status || '';
        return label && label !== 'No refund applicable'
            ? 'Cancelled · ' + label
            : 'Cancellation approved';
    }
    if (st === 'rejected') return 'Cancellation request rejected';
    return '';
}

async function openCancelRequestModal(applicationId) {
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
    const preview = document.getElementById('cancel-request-refund-preview');
    const reason = document.getElementById('cancel-request-reason');
    if (label) label.textContent = 'Application ' + (app.application_no || '') + ' — ' + (app.seminar_title || app.title || '');
    if (pol) pol.textContent = summaryCancellationPolicy(app.cancellation_policy_json) || 'Refund eligibility is calculated in IST when admin reviews your request.';
    if (preview) preview.innerHTML = '<p class="muted" style="margin:0;font-size:0.85rem;">Calculating refund eligibility…</p>';
    if (reason) reason.value = '';
    const m = document.getElementById('cancel-request-modal');
    if (m) {
        m.classList.remove('hidden');
        m.style.display = 'flex';
    }
    try {
        const res = await fetch(
            '/api/doctor/cancellation-preview?userId=' +
                encodeURIComponent(currentUser.id) +
                '&registrationId=' +
                encodeURIComponent(applicationId)
        );
        const data = await res.json().catch(function () {
            return {};
        });
        if (preview) {
            if (res.ok && data.eligibility) {
                preview.innerHTML = renderRefundEligibilityHtml(data.eligibility);
            } else {
                preview.innerHTML =
                    '<p style="color:#b91c1c;margin:0;font-size:0.85rem;">' +
                    escapeHtml(data.error || 'Could not load refund preview.') +
                    '</p>';
            }
        }
    } catch (e) {
        if (preview) preview.innerHTML = '<p style="color:#b91c1c;margin:0;font-size:0.85rem;">Network error loading refund preview.</p>';
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
            msg += '\n\nTrack refund status under Refund tracking after admin approval.';
        }
        alert(msg);
        closeCancelRequestModal();
        await loadDoctorCancellationRequests();
        loadApplications();
        if (doctorTabVisible('tab-refunds')) loadDoctorRefundsModule();
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
            const ct = a.cancellationTracking;
            const cancelSig = ct
                ? [
                      ct.status,
                      ct.refundStatus,
                      ct.refundAmount,
                      ct.providerRefundId || '',
                      (ct.trackingSteps || []).map((s) => s.key + ':' + s.state).join(',')
                  ].join(':')
                : '';
            return [a.id, a.status, a.updated_at || '', stepSig, cancelSig].join(':');
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
            const isDraft = st === 'draft';
            const canEdit =
                Number(a.allow_application_edit) === 1 &&
                (st === 'submitted' || st === 'pending_approval');
            const needsResubmit = st === 'revision_required' || st === 'documents_requested';
            const draftBtn = isDraft
                ? `<button class="btn-warning" style="padding: 5px 10px; margin-right: 5px;" onclick="resumeDraftApplication(${a.id})">Continue draft</button>`
                : '';
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
                    <td><span style="background: ${a.status === 'rejected' ? '#fee2e2' : isDraft ? '#e0f2fe' : st === 'waitlisted' ? '#fffbeb' : '#fef3c7'}; padding: 5px; border-radius: 5px;">${isDraft ? 'DRAFT' : st === 'waitlisted' ? 'WAITLISTED' : st === 'submitted' ? 'SUBMITTED' : a.status.toUpperCase()}</span></td>
                    <td>${draftBtn}${editBtn}${resubmitBtn}${cancelBtn}<button class="btn-primary" style="padding: 5px 10px;" onclick="viewApplication(${index})">View Details</button></td>
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
        syncDoctorTrackingPolls();
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
    const msg = result.message || i18nT('pay.redirecting');

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

function doctorRazorpayPaymentOption(methodId, resultMode) {
    if (methodId) return methodId;
    if (resultMode) return 'razorpay:' + resultMode;
    const opt = (window.__doctorPaymentOptions || []).find((o) => o.gateway === 'razorpay');
    return opt ? opt.id : 'razorpay:test';
}

function openDoctorRazorpayCheckout(result, regId, methodId) {
    const rzOrder = result.razorpayOrder || result.order;
    const checkoutKey = result.keyId || result.key_id || (result.order && result.order.key_id);
    const orderId = (rzOrder && rzOrder.id) || result.order_id;
    const amountPaise = (rzOrder && rzOrder.amount) || result.amount;
    if (!checkoutKey || !orderId || !amountPaise) {
        console.error('[razorpay] missing checkout fields', result);
        alert(
            'Online payment could not be started (missing order details). Please refresh and try again, or contact the seminar office.'
        );
        return;
    }
    if (typeof Razorpay === 'undefined') {
        alert('Razorpay checkout script did not load. Disable ad blockers and refresh the page.');
        return;
    }
    const payOpt = doctorRazorpayPaymentOption(methodId, result.mode);
    const user = typeof currentUser !== 'undefined' && currentUser ? currentUser : {};
    const options = {
        key: checkoutKey,
        amount: amountPaise,
        currency: (rzOrder && rzOrder.currency) || result.currency || 'INR',
        name: 'Vaidya Gogate Memorial Foundation National Seminar',
        description: 'Seminar Registration',
        order_id: orderId,
        handler: function (response) {
            fetch('/api/verify-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    registrationId: regId,
                    userId: doctorNumericUserId(),
                    paymentOption: payOpt,
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature
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
                })
                .catch(() =>
                    alert(
                        'Payment verification request failed. Contact the seminar office with your payment receipt.'
                    )
                );
        },
        modal: {
            ondismiss: function () {
                console.info('[razorpay] checkout dismissed');
            }
        },
        prefill: {
            name: ((user.first_name || '') + ' ' + (user.last_name || '')).trim(),
            email: user.email || '',
            contact: user.phone || ''
        },
        theme: { color: '#0f766e' }
    };
    const rzp = new Razorpay(options);
    rzp.on('payment.failed', function (resp) {
        const uid = doctorNumericUserId();
        fetch('/api/payments/log-attempt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: uid,
                registrationId: regId,
                orderDbId: result.orderDbId,
                applicationNo: appNo,
                gateway: 'razorpay',
                mode: result.mode,
                amount: result.amount,
                status: 'failed',
                error: resp.error,
                razorpay_order_id: resp.error && resp.error.metadata && resp.error.metadata.order_id,
                razorpay_payment_id: resp.error && resp.error.metadata && resp.error.metadata.payment_id
            })
        }).catch(function () {});
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
    let uid = window.__doctorResolvedInternalId || doctorNumericUserId();
    if (!uid) uid = await ensureDoctorInternalUserId();
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
    syncLiveActivity({ kind: 'payment', stepLabel: 'Opening checkout', formProgress: 100 });
    const methodId = paymentOption || getPaymentOptionForReg(regId);
    if (!methodId && (window.__doctorPaymentOptions || []).length > 1) {
        return alert('Please choose a payment method from the dropdown first.');
    }
    if (!methodId) {
        return alert('No payment method is available. Ask the seminar office to enable Razorpay test mode in Admin → Payment gateways.');
    }
    try {
        await loadRazorpayCheckoutScript();
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
            fetch('/api/payments/log-attempt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: uid,
                    registrationId: regId,
                    applicationNo: appNo,
                    gateway: methodId || 'razorpay',
                    amount: amount,
                    status: 'failed',
                    errorDescription: result.error || result.message || 'Payment could not be started.',
                    metadata: { phase: 'init_client' }
                })
            }).catch(function () {});
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
            loadDoctorSeminarPaymentsPanel();
            return;
        }
        if (result.paymentType === 'dqr' && result.qrImageUrl) {
            showDoctorPaymentQr(regId, result);
            ensureDoctorPaymentPoll();
            return;
        }
        if (result.paymentType === 'razorpay_checkout' || result.gateway === 'razorpay') {
            const rzOrder = result.razorpayOrder || result.order;
            if (!result.keyId || !rzOrder || !rzOrder.id) {
                console.error('[payment] incomplete Razorpay checkout payload', result);
                alert(
                    result.error ||
                        'Razorpay checkout could not start. Hard-refresh this page (Ctrl+Shift+R), allow pop-ups, and try again. If it persists, re-save test keys under Admin → Payment gateways.'
                );
                return;
            }
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

async function downloadDoctorCertificate(downloadUrl, seminarTitle) {
    const url = String(downloadUrl || '');
    if (!url || url === '#') return;
    const safeTitle = String(seminarTitle || 'certificate').replace(/[^\w.-]+/g, '_');
    const filename = 'VGMF_Certificate_' + safeTitle + '.html';

    if (isDesktopEticketDownload()) {
        triggerEticketFileDownload(url, filename);
        return;
    }

    void downloadDoctorCertificateAsync(url, filename);
}

async function downloadDoctorCertificateAsync(url, filename) {
    try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('download failed');
        const blob = await res.blob();
        const file = new File([blob], filename, { type: 'text/html;charset=utf-8' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'VGMF Certificate' });
            return;
        }
        triggerEticketFileDownload(URL.createObjectURL(blob), filename);
        if (typeof alert === 'function') alert('Certificate saved to your device.');
    } catch (shareErr) {
        console.warn('certificate download', shareErr);
        const printUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'print=1';
        const w = window.open(printUrl, '_blank');
        if (!w) alert('Could not download. Try Open, then Print → Save as PDF.');
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
        const uid = await ensureDoctorInternalUserId();
        if (!uid) {
            wrap.innerHTML =
                '<p style="color:#b91c1c;text-align:center;">Session invalid. Please sign out and sign in again.</p>';
            return;
        }
        const res = await fetch('/api/doctor/certificate-tracking/' + uid + doctorUserIdQuerySuffix(), {
            cache: 'no-store'
        });
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
            window.__doctorCertTrackingRows = rows;
            let html =
                '<table class="data-table" style="font-size:0.88rem;"><thead><tr><th>Seminar</th><th>Application No.</th><th>Scans</th><th>Status</th></tr></thead><tbody>';
            rows.forEach((r) => {
                const scanLbl = (r.scanCount || 0) + ' / ' + (r.scansRequired || 1);
                let statusColor = '#64748b';
                if (r.certStatus === 'issued') statusColor = '#15803d';
                else if (r.certStatus === 'not_attended') statusColor = '#991b1b';
                else if (r.certStatus === 'awaiting_checkin') statusColor = '#b45309';
                else if (r.certStatus === 'awaiting_approval') statusColor = '#7c3aed';
                else if (r.certStatus === 'scheduled_release') statusColor = '#0369a1';
                const countdownHint =
                    r.certCountdown && !r.canViewCertificate
                        ? ' <span style="font-size:0.75rem;color:#92400e;">(scheduled release)</span>'
                        : '';
                html +=
                    '<tr><td>' +
                    escapeHtml(r.seminarTitle || '—') +
                    '</td><td><code>' +
                    escapeHtml(r.applicationNo || '—') +
                    '</code></td><td>' +
                    escapeHtml(scanLbl) +
                    (r.scansRequired === 2 ? ' <span style="font-size:0.72rem;color:#64748b;">entry+exit</span>' : '') +
                    '</td><td style="font-weight:600;color:' +
                    statusColor +
                    ';">' +
                    escapeHtml(r.certStatusLabel || '—') +
                    countdownHint +
                    (r.canViewCertificate && r.certId
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
            if (rows.some((r) => r.certCountdown && !r.canViewCertificate)) startDoctorCertCountdownTimer();
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
    const dlUrl =
        '/certificate/download?uc=' +
        encodeURIComponent(String(certId)) +
        '&uid=' +
        encodeURIComponent(String(uid));
    downloadDoctorCertificate(dlUrl, 'Seminar');
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

function doctorDisplayName() {
    if (!currentUser) return 'Participant';
    return [currentUser.first_name, currentUser.last_name].filter(Boolean).join(' ').trim() || 'Participant';
}

function eticketViewUrl(t) {
    const token = t.download_token || '';
    if (token) {
        return (
            '/api/doctor/ticket-document/' +
            encodeURIComponent(t.ticket_id_string) +
            '?token=' +
            encodeURIComponent(token)
        );
    }
    const uid = doctorNumericUserId();
    return (
        '/api/doctor/ticket-document/' +
        encodeURIComponent(t.ticket_id_string) +
        '?userId=' +
        encodeURIComponent(String(uid || ''))
    );
}

function resolveEticketRow(t) {
    if (t && t.ticket_id_string) return t;
    if (typeof t === 'string' && window.__eticketRows && window.__eticketRows[t]) {
        return window.__eticketRows[t];
    }
    return null;
}

function triggerEticketFileDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
        if (String(url).startsWith('blob:')) {
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        }
        link.remove();
    }, 4000);
}

function isDesktopEticketDownload() {
    if (typeof window.matchMedia !== 'function') return window.innerWidth >= 768;
    return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 640;
}

function downloadEticketPdf(t) {
    const row = resolveEticketRow(t);
    if (!row || !row.ticket_id_string) {
        return alert('Ticket not found.');
    }
    const ticketId = String(row.ticket_id_string || '').trim();
    const filename = 'e-ticket-' + ticketId.replace(/[^\w-]+/g, '-') + '.pdf';
    const htmlFilename = filename.replace(/\.pdf$/i, '.html');
    const base = eticketViewUrl(row);
    const serverUrl = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'download=1';

    if (isDesktopEticketDownload()) {
        triggerEticketFileDownload(serverUrl, htmlFilename);
        return;
    }

    void downloadEticketPdfAsync(row, filename, htmlFilename, serverUrl);
}

async function downloadEticketPdfAsync(t, filename, htmlFilename, serverUrl) {
    const openPrintFallback = () => {
        const url = eticketViewUrl(t);
        const w = window.open(url, '_blank', 'noopener');
        if (!w) {
            alert('Allow pop-ups, or open Print view and use your browser Save as PDF.');
            window.location.href = url;
        }
    };

    if (!window.jspdf || !window.jspdf.jsPDF) {
        try {
            const res = await fetch(serverUrl, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error('Could not download ticket');
            const blob = await res.blob();
            triggerEticketFileDownload(URL.createObjectURL(blob), htmlFilename);
            if (typeof alert === 'function') {
                alert('Ticket saved to your device. Open the file and use Print → Save as PDF for a PDF copy.');
            }
        } catch (_) {
            openPrintFallback();
        }
        return;
    }

    try {
        await preloadSiteLogoForPdf();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const accent = [15, 118, 110];
        const ink = [15, 23, 42];
        const muted = [71, 85, 105];
        const holder = doctorDisplayName();
        let y = pdfCongressHeader(doc, 'E-Ticket — venue entry pass');
        y = pdfCongressSectionTitle(doc, y + 2, 'Participant', accent, ink);
        const drawRow = (label, value) => {
            doc.setFontSize(9.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...muted);
            doc.text(label, 18, y + 7);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...ink);
            const lines = doc.splitTextToSize(String(value || '—'), 118);
            doc.text(lines, 72, y + 7);
            y += Math.max(10, lines.length * 6);
        };
        drawRow('Name', holder);
        drawRow('Seminar', t.seminar_title || 'Seminar');
        drawRow('E-ticket ID', t.ticket_id_string || '—');
        drawRow('Application', t.application_no || '—');
        drawRow('Order', t.order_id_string || '—');
        y = pdfCongressSectionTitle(doc, y + 4, 'Entry QR', accent, ink);
        const qrUrl = ticketQrImageUrl(t);
        if (qrUrl) {
            try {
                const qrRes = await fetch(qrUrl, { credentials: 'same-origin', cache: 'no-store' });
                if (qrRes.ok) {
                    const qrBlob = await qrRes.blob();
                    const qrDataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(qrBlob);
                    });
                    doc.addImage(qrDataUrl, 'PNG', 18, y + 2, 42, 42);
                    doc.setDrawColor(203, 213, 225);
                    doc.setLineWidth(0.3);
                    doc.rect(18, y + 2, 42, 42, 'S');
                }
            } catch (qrErr) {
                console.warn('[eticket-pdf] QR fetch failed', qrErr);
            }
        }
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text('Issued to: ' + holder, 14, 282);
        doc.text('Non-transferable · Do not share this QR or PDF', 14, 288);
        const blob = doc.output('blob');
        triggerEticketFileDownload(URL.createObjectURL(blob), filename);
    } catch (e) {
        console.error('[eticket-pdf]', e);
        try {
            const res = await fetch(serverUrl, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error('Could not download ticket');
            const blob = await res.blob();
            triggerEticketFileDownload(URL.createObjectURL(blob), htmlFilename);
            if (typeof alert === 'function') {
                alert('Ticket saved to your device. Open the file and use Print → Save as PDF for a PDF copy.');
            }
        } catch (_) {
            openPrintFallback();
        }
    }
}
window.downloadEticketPdf = downloadEticketPdf;

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
        window.__eticketRows = {};
        rows.forEach((t) => {
            if (t.ticket_id_string) window.__eticketRows[t.ticket_id_string] = t;
            const regSt = String(t.registration_status || '').toLowerCase();
            const expired = !!t.ticket_expired || !!t.no_valid_ticket;
            const adminOverride =
                regSt === 'checked_in' || regSt === 'certificate_issued' || Number(t.scan_count || 0) > 0 || t.is_scanned;
            const invalid =
                regSt === 'cancelled' || regSt === 'rejected' || t.is_valid === 0 || (expired && !adminOverride);
            const qrPayload = ticketQrScanPayload(t);
            const showQr = !invalid && !t.is_scanned && qrPayload;
            const qr = showQr ? ticketQrImageUrl(t) : '';
            const scanned = t.is_scanned
                ? `Checked in · ${t.scan_time ? formatScanDateTime(t.scan_time) : 'venue'}`
                : 'Not scanned yet — show this QR at entry';
            const expiryNote = t.ticket_expires_on
                ? ' (valid through event day; expires ' + t.ticket_expires_on + ' 00:00 IST)'
                : '';
            const statusLine = invalid
                ? `<p style="margin:8px 0 0;font-size:0.9rem;color:#b91c1c;font-weight:600;">${
                      expired && !adminOverride
                          ? 'No valid ticket — expired after event day' +
                            expiryNote +
                            '. Only participants scanned at the venue receive certificates. Contact admin if you attended.'
                          : 'Invalid — registration ' +
                            (regSt === 'cancelled' ? 'cancelled' : regSt === 'rejected' ? 'rejected' : 'no longer active') +
                            '. Do not use this QR for entry.'
                  }</p>`
                : `<p style="margin:8px 0 0;font-size:0.85rem;color:#64748b;">${escapeHtml(scanned)}${escapeHtml(expiryNote)}</p>`;
            const holder = escapeHtml(doctorDisplayName());
            html += `<div style="border:1px solid ${invalid ? '#fecaca' : '#e2e8f0'};border-radius:12px;padding:16px;display:grid;grid-template-columns:128px 1fr;gap:16px;align-items:start;${invalid ? 'opacity:0.85;background:#fef2f2;' : ''}">
                <div style="position:relative;width:128px;-webkit-touch-callout:none;user-select:none;">
                    ${qr ? `<img src="${qr}" alt="QR code" draggable="false" style="width:128px;height:128px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;-webkit-user-drag:none;pointer-events:none;">` : (t.is_scanned ? '<span style="color:#059669;font-size:0.85rem;font-weight:700;"><i class="fas fa-check-circle"></i> QR used at entry</span>' : '<span style="color:#94a3b8;font-size:0.85rem;">QR unavailable</span>')}
                    ${qr ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font-size:0.52rem;font-weight:800;color:rgba(15,118,110,0.18);text-align:center;line-height:1.15;padding:6px;transform:rotate(-18deg);">${holder}</div>` : ''}
                </div>
                <div>
                    <h4 style="margin:0 0 8px;color:#1a237e;">${escapeHtml(t.seminar_title || 'Seminar')}</h4>
                    <p style="margin:0 0 6px;font-size:0.9rem;"><strong>E‑ticket ID:</strong> <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escapeHtml(t.ticket_id_string || '—')}</code></p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Order:</strong> ${escapeHtml(String(t.order_id_string || '—'))} · <strong>Application:</strong> ${escapeHtml(String(t.application_no || '—'))}</p>
                    <p style="margin:4px 0;font-size:0.9rem;"><strong>Registration:</strong> ${escapeHtml(t.registration_status || '—')} · <strong>Payment:</strong> ${escapeHtml(t.order_status || '—')}</p>
                    <p style="margin:6px 0 0;font-size:0.78rem;color:#64748b;">Issued to <strong>${holder}</strong> · non-transferable</p>
                    ${statusLine}
                    ${
                        !invalid && t.ticket_id_string
                            ? `<div style="margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px;">
                                <button type="button" class="btn-primary" style="padding:8px 14px;font-size:0.88rem;" onclick="downloadEticketPdf(${JSON.stringify(String(t.ticket_id_string))})"><i class="fas fa-download"></i> Save PDF to device</button>
                                <a href="${escapeHtml(eticketViewUrl(t))}" target="_blank" rel="noopener" class="btn-primary" style="display:inline-block;padding:8px 14px;text-decoration:none;font-size:0.88rem;background:#475569;"><i class="fas fa-print"></i> Print view</a>
                               </div>`
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
                'No seminars are open for feedback yet. Feedback unlocks after venue check-in (e-ticket scan) for a seminar you attended, and only once per seminar.';
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
let ticketFeedbackRating = 0;

function startSupportChatPoll() {
    stopSupportChatPoll();
    supportChatPollTimer = setInterval(() => {
        if (currentTicketId) loadChatMessages(true);
    }, SUPPORT_CHAT_POLL_MS);
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
    if (!currentTicketId) {
        box.innerHTML = '<p style="color:#b91c1c;text-align:center;">No ticket selected.</p>';
        return;
    }
    if (!silent) {
        box.innerHTML =
            '<p class="support-chat-loading" style="color:#64748b;text-align:center;margin:auto;">Loading messages…</p>';
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? window.setTimeout(function () {
              controller.abort();
          }, 12000)
        : null;
    try {
        const fetchOpts = controller ? { signal: controller.signal } : {};
        const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId), fetchOpts);
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
        const feedbackPanel = document.getElementById('ticket-feedback-panel');
        const replyRow = document.getElementById('chat-reply-msg');
        const replyBtn = replyRow && replyRow.parentElement;
        const st = String(ticket.status || '').toLowerCase();
        const closed = st === 'closed' || st === 'resolved';
        if (feedbackPanel) {
            if (closed && ticket.needsFeedback) {
                feedbackPanel.classList.remove('hidden');
                if (replyRow) replyRow.disabled = true;
            } else if (closed && ticket.feedback) {
                feedbackPanel.classList.remove('hidden');
                feedbackPanel.innerHTML =
                    '<p style="margin:0;color:#059669;font-weight:600;">Thank you for your feedback (' +
                    ticket.feedback.rating +
                    '/5).</p>';
                if (replyRow) replyRow.disabled = true;
            } else {
                feedbackPanel.classList.add('hidden');
                if (replyRow) replyRow.disabled = closed;
            }
        }
        if (replyBtn && closed && !ticket.needsFeedback) {
            replyBtn.style.display = closed ? 'none' : '';
        } else if (replyBtn) {
            replyBtn.style.display = '';
        }

        const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
        if (!messages.length) {
            box.innerHTML = '<p style="color:#64748b;text-align:center;">No messages yet. Send a reply below.</p>';
            return;
        }
        box.innerHTML = '';
        messages.forEach((m) => {
            const st = String(m.sender_type || '').toLowerCase();
            const isDoc = st === 'user' || st === 'doctor' || (!st && true);
            const isStaffMsg = st === 'admin' || st === 'staff' || st === 'support' || st === 'system';
            const staffName =
                st === 'system' ? 'Support desk' : m.sender_display_name || 'Support team';
            const viaEmail =
                m.source === 'email'
                    ? ' <span style="font-size:0.72rem;background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;">Email</span>'
                    : '';
            const showAsDoc = isDoc && !isStaffMsg;
            box.innerHTML += `
                <div style="align-self: ${showAsDoc ? 'flex-end' : 'flex-start'}; background: ${showAsDoc ? '#0f766e' : 'white'}; color: ${showAsDoc ? 'white' : '#334155'}; border: 1px solid ${showAsDoc ? '#0f766e' : '#cbd5e1'}; padding: 10px 15px; border-radius: 8px; max-width: 80%;">
                    <p style="font-size: 0.8rem; margin-bottom: 5px; color: ${showAsDoc ? '#ccfbf1' : '#64748b'};"><strong>${showAsDoc ? 'You' : staffName}</strong>${viaEmail} — ${new Date(m.created_at).toLocaleString()}</p>
                    <p>${(m.message || '').replace(/</g, '&lt;')}</p>
                </div>`;
        });
    } catch (err) {
        console.error(err);
        if (silent) return;
        const timedOut = err && err.name === 'AbortError';
        box.innerHTML =
            '<p style="color:#b91c1c;text-align:center;">' +
            (timedOut ? 'Loading is taking longer than usual. Please try again.' : 'Network error loading messages.') +
            '</p>';
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        box.scrollTop = box.scrollHeight;
    }
}

function setTicketFeedbackRating(n) {
    ticketFeedbackRating = n;
    document.querySelectorAll('#ticket-feedback-stars button').forEach((btn) => {
        const r = parseInt(btn.getAttribute('data-rating'), 10);
        btn.style.background = r <= n ? '#0f766e' : '#64748b';
    });
}

async function submitTicketFeedback() {
    const statusEl = document.getElementById('ticket-feedback-status');
    if (!currentTicketId) return alert('Open a ticket first.');
    if (!ticketFeedbackRating || ticketFeedbackRating < 1) {
        return alert('Please choose a rating from 1 to 5 stars.');
    }
    const uid = doctorNumericUserId();
    if (!uid) return alert('Session expired.');
    const comment = (document.getElementById('ticket-feedback-comment') || {}).value || '';
    if (statusEl) statusEl.textContent = 'Sending…';
    try {
        const res = await fetch('/api/support-ticket/' + encodeURIComponent(currentTicketId) + '/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, rating: ticketFeedbackRating, comment: comment.trim() })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error) || 'Could not submit feedback');
        if (statusEl) {
            statusEl.style.color = '#059669';
            statusEl.textContent = 'Thank you! Your feedback helps us improve support.';
        }
        await loadChatMessages(true);
    } catch (err) {
        if (statusEl) {
            statusEl.style.color = '#b91c1c';
            statusEl.textContent = err.message || 'Could not submit feedback.';
        }
    }
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
            document.getElementById('ticket-subj').value = '';
            document.getElementById('ticket-desc').value = '';
            document.getElementById('new-ticket-form').classList.add('hidden');
            document.getElementById('ticket-result').innerText = '';
            loadTickets();
            loadDoctorDashboardStats();
            if (result.ticketId) {
                openTicketThread(result.ticketId);
            }
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
    if (isDoctorProfileComplete(profile)) {
        bar.classList.add('hidden');
        bar.style.display = 'none';
    } else {
        bar.classList.remove('hidden');
        bar.style.display = '';
    }
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

async function loadDoctorSeminarPaymentsPanel() {
    const box = document.getElementById('make-payments-container');
    if (!box) return;
    const uid = doctorNumericUserId();
    if (!uid) {
        box.innerHTML = '<p style="color:#b91c1c;">Please sign in again.</p>';
        return;
    }
    await loadDoctorPaymentOptions();
    if (!userApplications || !userApplications.length) {
        try {
            const res = await fetch('/api/applications/' + encodeURIComponent(uid), { cache: 'no-store' });
            const payload = await res.json().catch(() => ({}));
            if (res.ok) userApplications = Array.isArray(payload) ? payload : payload.applications || [];
        } catch (_) {}
    }
    const pending = (userApplications || []).filter(
        (a) => String(a.status || '').toLowerCase() === 'approved_pending_payment'
    );
    if (!pending.length) {
        box.innerHTML =
            '<h3 style="color:#0f766e;margin:0 0 10px;font-size:1rem;">Seminar registration fees</h3>' +
            '<p style="color:#64748b;margin:0;">No payments due right now. Approved registrations awaiting payment will appear here with Razorpay and other enabled gateways.</p>';
        return;
    }
    let html =
        '<h3 style="color:#0f766e;margin:0 0 12px;font-size:1rem;">Seminar registration fees</h3>' +
        '<p style="font-size:0.88rem;color:#64748b;margin:0 0 14px;">Pay with <strong>Razorpay</strong> or another enabled gateway. Your e-ticket is issued automatically when payment confirms.</p>';
    pending.forEach((a) => {
        const payAmt =
            a.payment_amount != null && Number.isFinite(Number(a.payment_amount)) && Number(a.payment_amount) >= 0
                ? Number(a.payment_amount)
                : Number(a.seminar_price) > 0
                  ? Number(a.seminar_price)
                  : 1500;
        const defaultPayMethod = defaultPaymentMethodForPayButton();
        html +=
            '<div class="card" style="margin-bottom:12px;padding:14px;border:1px solid #99f6e4;background:#f8fffc;">' +
            '<p style="margin:0 0 8px;font-weight:700;color:#0f766e;">' +
            escapeHtml(a.application_no || '') +
            (a.seminar_title ? ' · ' + escapeHtml(a.seminar_title) : '') +
            '</p>' +
            '<p style="margin:0 0 10px;font-size:0.88rem;color:#475569;">Amount due: <strong>₹' +
            escapeHtml(String(payAmt)) +
            '</strong></p>' +
            paymentGatewaySelectHtml(a.id) +
            '<button type="button" class="btn-success doctor-pay-btn" style="margin-top:10px;" ' +
            'data-reg-id="' +
            escapeHtml(String(a.id)) +
            '" data-amount="' +
            escapeHtml(String(payAmt)) +
            '" data-app-no="' +
            escapeHtml(String(a.application_no || '')) +
            '" data-method="' +
            escapeHtml(defaultPayMethod) +
            '">Pay now (₹' +
            payAmt +
            ')</button></div>';
    });
    box.innerHTML = html;
}
window.loadDoctorSeminarPaymentsPanel = loadDoctorSeminarPaymentsPanel;

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

// Application edit — opens the live registration form with saved data
async function applyRegistrationFormData(formData, opts) {
    if (!formData || typeof formData !== 'object') return;
    const onlyBlank = !!(opts && opts.onlyBlank);
    await initRegistrationAddressUi();
    Object.keys(REGISTRATION_FIELD_IDS).forEach(function (key) {
        if (key === 'certificate') return;
        const el = document.getElementById(REGISTRATION_FIELD_IDS[key]);
        if (!el || formData[key] == null || formData[key] === '') return;
        if (onlyBlank && String(el.value || '').trim()) return;
        el.value = String(formData[key]);
    });
    const qualEl = document.getElementById('reg-qual');
    if (qualEl && formData.qual) {
        qualEl.value = formData.qual;
        if (typeof toggleRegBlock === 'function') toggleRegBlock();
        if (typeof toggleCollegeStep === 'function') toggleCollegeStep();
    }
    const pin = String(formData.pin || '').replace(/\D/g, '');
    if (pin.length === 6) {
        const pinEl = document.getElementById('reg-pin');
        if (pinEl) pinEl.value = pin;
        await autofillAddress();
        if (formData.city) {
            const cityEl = document.getElementById('reg-city');
            if (cityEl) {
                fillRegSelectOptions(cityEl, [formData.city], formData.city);
                cityEl.value = formData.city;
            }
        }
        if (formData.state) {
            const stateEl = document.getElementById('reg-state');
            if (stateEl) {
                fillRegSelectOptions(stateEl, [formData.state], formData.state);
                stateEl.value = formData.state;
            }
        }
    }
    const cpin = String(formData.cpin || '').replace(/\D/g, '');
    if (cpin.length === 6 && registrationQualIsPg()) {
        const cpinEl = document.getElementById('reg-cpin');
        if (cpinEl) cpinEl.value = cpin;
        await autofillCollegeAddress();
        if (formData.ccity) {
            const ccityEl = document.getElementById('reg-ccity');
            if (ccityEl) {
                fillRegSelectOptions(ccityEl, [formData.ccity], formData.ccity);
                ccityEl.value = formData.ccity;
            }
        }
        if (formData.cstate) {
            const cstateEl = document.getElementById('reg-cstate');
            if (cstateEl) {
                fillRegSelectOptions(cstateEl, [formData.cstate], formData.cstate);
                cstateEl.value = formData.cstate;
            }
        }
    }
    if (formData.certificate_path) {
        window.__regCertServerUploaded = true;
        updateRegCertUploadUi({ uploaded: true });
    }
    const eventIds = formData.selected_event_ids || formData.selectedEventIds;
    if (Array.isArray(eventIds) && eventIds.length) {
        const idSet = new Set(eventIds.map((x) => Number(x)));
        document.querySelectorAll('.reg-event-cb').forEach(function (cb) {
            cb.checked = idSet.has(parseInt(cb.value, 10));
        });
        updateRegEventTotal();
    }
}

async function editApplication(index) {
    const app = userApplications[index];
    if (!app || !app.id) return alert('Application not found.');
    if (!Number(app.allow_application_edit)) {
        return alert(
            'Editing is disabled for this seminar after submit. Contact the seminar office if you need changes.'
        );
    }
    const appSt = String(app.status || '').toLowerCase();
    if (appSt !== 'submitted' && appSt !== 'pending_approval') {
        return alert('This application can no longer be edited.');
    }
    let formData = {};
    try {
        formData = JSON.parse(app.form_data || '{}');
    } catch (_) {}
    if (!activeSeminars.some((x) => Number(x.id) === Number(app.seminar_id))) {
        await loadSeminarsGrid();
    }
    window.editingApplicationId = app.id;
    window.__draftApplicationNo = app.application_no || null;
    switchTab('tab-seminars');
    await startRegistration(app.seminar_id, {
        editMode: true,
        volunteerBypass: true,
        prefillFormData: formData
    });
    const nameEl = document.getElementById('registration-seminar-name');
    if (nameEl) {
        nameEl.innerText =
            'Edit application — ' +
            (app.seminar_title || 'Seminar') +
            ' (' +
            (app.application_no || '') +
            ')';
    }
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
                    CASE_UPLOAD_HOST_CAP_MB +
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


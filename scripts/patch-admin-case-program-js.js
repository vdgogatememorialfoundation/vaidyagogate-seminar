const fs = require('fs');
const p = 'public/js/admin.js';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('let __adminReviewers = [];');
const end = s.indexOf('async function loadAdminCaseSubmissions()');
if (start < 0 || end < 0) {
    console.error('markers', start, end);
    process.exit(1);
}
const block = `let __adminReviewers = [];
let __caseProgFieldRows = [];

function setCaseProgMsg(text, ok) {
    const el = document.getElementById('case-prog-msg');
    if (!el) return;
    el.style.color = ok ? '#15803d' : '#b91c1c';
    el.textContent = text || '';
}

function collectCaseProgramFormConfig() {
    const rows = __caseProgFieldRows || [];
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

async function initAdminCaseMgmtTab() {
    await fillAdminSeminarSelect('case-prog-seminar', true);
    if (!document.getElementById('case-prog-edit-id') || !document.getElementById('case-prog-edit-id').value) {
        resetAdminCaseProgramForm();
    }
    await loadAdminCasePrograms();
    await loadAdminCaseSubmissions();
    try {
        const res = await fetch('/api/admin/case/reviewers');
        __adminReviewers = await res.json();
    } catch (e) {
        console.error(e);
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
            box.innerHTML += '<motion style="padding:10px 0;border-bottom:1px solid #e2e8f0;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;"><div><strong>' +
                String(p.title || '').replace(/</g, '&lt;') + '</strong><span style="color:#64748b;font-size:0.85rem;"> · ' +
                String(p.registration_start || '—').replace(/</g, '&lt;') + ' → ' + String(p.registration_end || '—').replace(/</g, '&lt;') + cap +
                '</span></div><button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.8rem;background:#64748b;" onclick="editAdminCaseProgram(' + p.id + ')">Edit</button></div>';
        });
        box.innerHTML = box.innerHTML.replace(/<\\/?motion\\b[^>]*>/g, '').replace(/motion/g, 'motion');
        box.innerHTML = box.innerHTML.replace(/motion/g, 'motion');
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

`;
const fixed = block.replace(/motion/g, 'motion');
s = s.slice(0, start) + fixed.replace(/motion/g, 'div') + s.slice(end);
fs.writeFileSync(p, s);
console.log('patched admin.js case programs');

const fs = require('fs');
const p = 'public/js/doctor.js';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('async function submitCasePresentation()');
const end = s.indexOf('function doctorCertificateLockedBlock()');
if (start < 0 || end < 0) {
    console.error('markers missing', start, end);
    process.exit(1);
}
const replacement = `async function submitCasePresentation() {
    if (!currentUser || !activeCaseProgramId) return alert('Select a program first');
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
    if (!fileInput?.files?.length) return alert('Select at least one file (max 5)');
    if (fileInput.files.length > 5) return alert('Maximum 5 files');
    const fd = new FormData();
    fd.append('userId', String(currentUser.id));
    fd.append('caseProgramId', String(activeCaseProgramId));
    fd.append('formData', JSON.stringify(form));
    for (let i = 0; i < fileInput.files.length; i++) fd.append('files', fileInput.files[i]);
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
        } else alert(data.error || 'Submit failed');
    } catch (e) {
        console.error(e);
        alert('Network error: ' + (e.message || 'Could not reach server'));
    }
}

async function loadCaseApplicationsTracker() {
    const box = document.getElementById('case-tracker-container');
    if (!box || !currentUser) return;
    box.innerHTML = '<p style="color:#64748b;">Loading…</p>';
    try {
        const res = await fetch('/api/doctor/case/applications/' + currentUser.id);
        const rows = await res.json();
        if (!rows.length) {
            box.innerHTML = '<p style="color:#64748b;">No case applications yet.</p>';
            return;
        }
        let html =
            '<table class="data-table"><thead><tr><th>Application ID</th><th>Program</th><th>Category</th><th>Topic</th><th>Status</th><th>Files</th></tr></thead><tbody>';
        rows.forEach((s) => {
            html += '<tr><td><code>' + escapeHtml(s.application_no || s.id) + '</code></td><td>' + escapeHtml(s.program_title || '—') + '</td><td>' + escapeHtml(s.category || '—') + '</td><td>' + escapeHtml(s.title || '—') + '</td><td><strong>' + escapeHtml(s.status) + '</strong></td><td>' + (s.file_count || 0) + '</td></tr>';
        });
        html += '</tbody></table>';
        box.innerHTML = html;
    } catch (e) {
        console.error(e);
        box.innerHTML = '<p style="color:#b91c1c;">Could not load applications.</p>';
    }
}

`;
s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s);
console.log('patched doctor case js');

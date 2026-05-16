const fs = require('fs');
const p = 'public/js/admin.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('<td>${s.id}</td>')) {
    s = s.replace('<td>${s.id}</td>', '<td><code>${escAdmin(s.application_no || s.id)}</code></td>');
}
if (!s.includes('s.category')) {
    s = s.replace(
        "${escAdmin(s.user_id_string)}</motion></td>\n                <td>${escAdmin(s.title)}",
        "${escAdmin(s.user_id_string)}</div></td>\n                <td>${escAdmin(s.category || '—')}</td>\n                <td>${escAdmin(s.title)}"
    );
}
s = s.replace(/<\/?motion\b[^>]*>/g, (m) => m.replace(/motion/g, 'motion'));
s = s.split('motion').join('div');
if (s.includes('Assign judge user IDs')) {
    s = s.replace(
        /let html = `[\s\S]*?<h4>Files<\/h4><ul style="list-style:none;padding:0;">`;/,
        `        let judgeOpts = (__adminReviewers || [])
            .map((j) => '<label style="display:block;margin:4px 0;"><input type="checkbox" class="case-judge-cb" value="' + j.id + '"> ' + escAdmin(j.first_name) + ' ' + escAdmin(j.last_name) + '</label>')
            .join('');
        let html = \`<h3>Application <code>\${escAdmin(sub.application_no || sub.id)}</code></h3>
            <p class="muted">\${escAdmin(sub.first_name)} \${escAdmin(sub.last_name)} · \${escAdmin(sub.category)} · \${escAdmin(sub.status)}</p>
            <p><strong>Topic:</strong> \${escAdmin(sub.title)}</p>
            <motion style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn-primary" style="background:#b91c1c;" onclick="markCasePlagiarism(\${sub.id})">Duplicate / zero marks</button>
                <button type="button" class="btn-primary" style="background:#15803d;" onclick="selectCaseWinner(\${sub.id})">Mark winner</button>
            </div>
            <div style="margin:12px 0;"><label>Assign reviewers</label><div id="case-judge-checkboxes">\${judgeOpts || 'No judges'}</div>
            <button type="button" class="btn-primary" style="margin-top:8px;" onclick="assignCaseJudgesFromCheckboxes(\${sub.id})">Assign selected</button></div>
            <h4>Files</h4><ul style="list-style:none;padding:0;">\`;`.replace(/motion/g, 'div')
    );
}
if (!s.includes('assignCaseJudgesFromCheckboxes')) {
    s = s.replace(
        'async function assignCaseJudges(subId) {',
        `async function assignCaseJudgesFromCheckboxes(subId) {
    const judgeIds = [];
    document.querySelectorAll('.case-judge-cb:checked').forEach((cb) => judgeIds.push(parseInt(cb.value, 10)));
    if (!judgeIds.length) return alert('Select at least one reviewer');
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId + '/assign-judges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ judgeIds })
        });
        const data = await res.json();
        if (data.success) alert('Judges assigned');
        else alert(data.error || 'Failed');
    } catch (e) { console.error(e); }
}

async function markCasePlagiarism(subId) {
    const reason = prompt('Reason for duplicate/plagiarism (zero marks):') || 'Duplicate submission';
    fetch('/api/admin/case/submissions/' + subId + '/mark-plagiarism', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
    })
        .then((r) => r.json())
        .then((d) => {
            if (d.success) {
                alert('Marked as duplicate — zero marks');
                openAdminCaseDetail(subId);
            } else alert(d.error);
        });
}

async function selectCaseWinner(subId) {
    if (!confirm('Mark this applicant as case winner?')) return;
    fetch('/api/admin/case/submissions/' + subId + '/select-winner', { method: 'POST' })
        .then((r) => r.json())
        .then((d) => {
            alert(d.message || d.error || 'Done');
            loadAdminCaseSubmissions();
        });
}

async function assignCaseJudges(subId) {`
    );
}
fs.writeFileSync(p, s);
console.log('done');

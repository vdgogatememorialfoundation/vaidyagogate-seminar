const fs = require('fs');
const p = 'public/js/admin.js';
let s = fs.readFileSync(p, 'utf8');
const old =
    '<label>Assign reviewers</label><motion id="case-judge-checkboxes">${judgeOpts || \'No judges\'}</div>\n            <button type="button" class="btn-primary" style="margin-top:8px;" onclick="assignCaseJudgesFromCheckboxes(${sub.id})">Assign selected</button></div>';
const neu =
    '<label>Assign reviewers</label>${assignedHtml}<div id="case-judge-checkboxes">${judgeOpts}</motion>\n            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;">\n            <button type="button" class="btn-primary" onclick="assignCaseJudgesFromCheckboxes(${sub.id})">Assign selected</button>\n            <span class="muted">or portal ID:</span>\n            <input type="text" id="case-judge-id-string" placeholder="393671924601" style="padding:6px 10px;max-width:200px;">\n            <button type="button" class="btn-primary" style="background:#64748b;" onclick="assignCaseJudgeByPortalId(${sub.id})">Assign by ID</button></div>';
if (!s.includes('assignCaseJudgeByPortalId')) {
    if (!s.includes(old.replace(/motion/g, 'motion'))) {
        const old2 = old.replace(/<\/?motion\b[^>]*>/g, (m) => m.replace(/motion/g, 'div'));
        if (s.includes(old2)) s = s.replace(old2, neu.replace(/motion/g, 'div'));
        else {
            console.error('block not found');
            process.exit(1);
        }
    } else {
        s = s.replace(old, neu.replace(/motion/g, 'motion'));
    }
    const fn = `
async function assignCaseJudgeByPortalId(subId) {
    const uidStr = document.getElementById('case-judge-id-string')?.value?.trim();
    if (!uidStr) return alert('Enter judge portal ID (12-digit number)');
    try {
        const res = await fetch('/api/admin/case/submissions/' + subId + '/assign-judges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ judgeUserIdString: uidStr })
        });
        const data = await res.json();
        if (data.success) {
            alert('Judge assigned (ID ' + uidStr + ')');
            openAdminCaseDetail(subId);
        } else alert(data.error || 'Failed');
    } catch (e) {
        console.error(e);
        alert('Network error');
    }
}

`;
    s = s.replace('async function assignCaseJudgesFromCheckboxes(subId) {', fn + 'async function assignCaseJudgesFromCheckboxes(subId) {');
}
fs.writeFileSync(p, s.replace(/motion/g, 'div'));
console.log('patched');

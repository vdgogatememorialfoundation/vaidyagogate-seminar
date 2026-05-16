const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(file, 'utf8');
const start = s.indexOf('async function appendCasePresentationTrackers');
const end = s.indexOf('async function loadApplications');
if (start < 0 || end < 0) {
    console.error('markers not found');
    process.exit(1);
}
const finalFn = `async function appendCasePresentationTrackers(trackerContainer) {
    if (!trackerContainer || !doctorNumericUserId()) return;
    try {
        const res = await fetch('/api/doctor/case/applications/' + doctorNumericUserId());
        const caseRows = await res.json();
        if (!Array.isArray(caseRows) || !caseRows.length) return;
        caseRows.forEach((c) => {
            const st = String(c.status || 'submitted').toLowerCase();
            const isJudging = st === 'judging';
            const isSelected = st === 'selected';
            const isDisqualified = st === 'disqualified' || c.plagiarism_zero;
            const appId = escapeHtml(c.application_no || String(c.id));
            const prog = c.program_title ? ' · ' + escapeHtml(c.program_title) : '';
            const meta = escapeHtml(c.category || '') + ' · ' + escapeHtml(c.title || '');
            if (isDisqualified) {
                trackerContainer.innerHTML +=
                    '<motion class="card" style="margin-bottom:15px;border-top:4px solid #ef4444;">' +
                    '<h4 style="color:#ef4444;"><i class="fas fa-briefcase-medical"></i> Case · ' +
                    appId +
                    '</h4><p style="color:#64748b;">Disqualified / duplicate (zero marks).</p></div>';
                return;
            }
            const reviewDesc = isJudging
                ? 'Judges are scoring your presentation.'
                : 'Waiting for judge assignment.';
            const resultDesc = isSelected ? 'Selected as winner.' : 'Result pending.';
            trackerContainer.innerHTML +=
                '<div class="card" style="margin-bottom:15px;border-top:4px solid #0f766e;">' +
                '<h4 style="color:#0f766e;margin-bottom:16px;"><i class="fas fa-briefcase-medical"></i> Case: ' +
                appId + prog + '</h4>' +
                '<p style="font-size:0.88rem;color:#64748b;margin:-8px 0 12px;">' + meta + '</p>' +
                '<div class="tracker-vertical">' +
                '<div class="track-step completed"><div class="track-icon"><i class="fas fa-file-upload"></i></div>' +
                '<div class="track-content"><motion class="track-title">Submitted</div><div class="track-desc">Files received.</div></motion></div>' +
                '<div class="track-step ' + (isJudging || isSelected ? 'completed' : '') + '">' +
                '<div class="track-icon"><i class="fas fa-gavel"></i></div>' +
                '<div class="track-content"><div class="track-title">Judge review</div><div class="track-desc">' + reviewDesc + '</div></div></div>' +
                '<div class="track-step ' + (isSelected ? 'completed' : '') + '">' +
                '<div class="track-icon"><i class="fas fa-trophy"></i></div>' +
                '<div class="track-content"><div class="track-title">Result</div><div class="track-desc">' + resultDesc + '</div></div></div>' +
                '</div></div>';
        });
    } catch (e) {
        console.error(e);
    }
}

`;
s = s.slice(0, start) + finalFn.replace(/motion/g, 'div') + '\n' + s.slice(end);
fs.writeFileSync(file, s);
console.log('patched');

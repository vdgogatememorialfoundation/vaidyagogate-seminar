const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'admin.html');
let html = fs.readFileSync(file, 'utf8');
if (html.includes('id="seminar-cancel-enabled"')) {
    console.log('Already patched');
    process.exit(0);
}
const insert = `                        <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;margin-bottom:10px;">
                            <input type="checkbox" id="seminar-cancel-enabled" checked onchange="updateSeminarPolicyPreviews()">
                            Allow doctors to cancel their application (self-service)
                        </label>
                        <div style="margin-bottom:12px;">
                            <label style="font-size:0.8rem;">Cancellation window closes at (IST, optional)</label>
                            <input type="datetime-local" id="seminar-cancel-until" style="max-width:280px;display:block;margin-top:4px;" oninput="updateSeminarPolicyPreviews()">
                            <p style="font-size:0.78rem;color:#94a3b8;margin:4px 0 0;">Leave blank to allow cancellation until the seminar day. After this date/time, the Cancel button is hidden.</p>
                        </motion>
`;
const clean = insert.replace(/<\/motion>/g, '</div>').replace(/<motion /g, '<div ');
const needle =
    '<p style="font-size:0.82rem;color:#64748b;margin:6px 0 10px;">Shown to doctors when they track or cancel an application.</p>';
const replacement =
    '<p style="font-size:0.82rem;color:#64748b;margin:6px 0 10px;">Control whether doctors can cancel from their portal and until when. Refund tiers apply when they do cancel.</p>\n' +
    clean;
if (!html.includes(needle)) {
    console.error('needle not found');
    process.exit(1);
}
html = html.replace(needle, replacement);
fs.writeFileSync(file, html);
console.log('patched');

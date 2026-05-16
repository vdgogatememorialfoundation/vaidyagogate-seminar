const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'doctor.html');
let s = fs.readFileSync(p, 'utf8');
const marker = '<motion id="tab-receipts"';
const idx = s.indexOf('<div id="tab-receipts"');
if (idx < 0) {
    console.error('tab-receipts not found');
    process.exit(1);
}
const modal =
    '                    <div id="view-case-modal" class="hidden" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:2000;display:flex;justify-content:center;align-items:center;">\n' +
    '                        <div style="background:white;border-radius:12px;width:600px;max-width:90%;max-height:90vh;overflow-y:auto;padding:30px;position:relative;">\n' +
    "                            <button type=\"button\" onclick=\"document.getElementById('view-case-modal').classList.add('hidden');document.getElementById('view-case-modal').style.display='';\" style=\"position:absolute;top:15px;right:15px;background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:#64748b;\">&times;</button>\n" +
    '                            <h2 style="color:#0f766e;margin-bottom:20px;">Case application details</h2>\n' +
    '                            <div id="view-case-content" style="background:#f8fafc;padding:20px;border-radius:8px;border:1px solid #e2e8f0;line-height:1.6;"></div>\n' +
    '                        </div>\n' +
    '                    </div>\n';
if (s.includes('view-case-modal')) {
    console.log('already patched');
    process.exit(0);
}
s = s.slice(0, idx) + modal + s.slice(idx);
fs.writeFileSync(p, s);
console.log('patched case modal');

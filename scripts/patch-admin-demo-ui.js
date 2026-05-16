const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'admin.js');
let s = fs.readFileSync(p, 'utf8');
const marker = '<p><strong>Joined:</strong> ${escAdmin(u.created_at)}</p>';
const idx = s.indexOf(marker);
if (idx < 0) {
    console.error('marker not found');
    process.exit(1);
}
if (s.includes('toggleAdminUserDemo(${u.id}')) {
    console.log('already patched');
    process.exit(0);
}
const insert =
    '<p><strong>Demo account:</strong> ${Number(u.is_demo) === 1 ? \'Yes — any 4-digit OTP works\' : \'No\'}</p>\n                    ' +
    marker +
    '\n                    <button type="button" class="btn-primary" style="margin-top:10px;background:#7c3aed;" onclick="toggleAdminUserDemo(${u.id}, ${Number(u.is_demo) === 1 ? \'false\' : \'true\'})">${Number(u.is_demo) === 1 ? \'Remove demo mode\' : \'Mark as demo user\'}</button>';
s = s.replace(marker, insert);
fs.writeFileSync(p, s);
console.log('patched admin demo ui');

const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'admin.html');
let c = fs.readFileSync(p, 'utf8');
const oldBlock =
    '                        <motion><label>Public site URL (https)</label><input type="url" id="int-public-base-url" placeholder="https://seminar.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Admin contact email</label><input type="email" id="int-admin-contact" placeholder="info@yourdomain.com" style="width:100%"></motion>';
const newBlock =
    '                        <p style="font-size:0.85rem;margin-bottom:12px;padding:10px 12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;"><strong>Wix + subdomains:</strong> Main site on Wix; point seminar, admin, judge DNS to your VPS. See deploy/WIX-DNS.md</p>\n' +
    '                        <motion><label>Seminar portal URL</label><input type="url" id="int-public-base-url" placeholder="https://seminar.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Wix main website</label><input type="url" id="int-wix-url" placeholder="https://www.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Seminar host (DNS)</label><input type="text" id="int-seminar-host" placeholder="seminar.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Admin host (DNS)</label><input type="text" id="int-admin-host" placeholder="admin.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Judge host (DNS)</label><input type="text" id="int-judge-host" placeholder="judge.vaidyagogate.org" style="width:100%"></motion>\n' +
    '                        <motion><label>Admin contact email</label><input type="email" id="int-admin-contact" placeholder="info@vaidyagogate.org" style="width:100%"></motion>';
const tag = ['m', 'o', 't', 'i', 'o', 'n'].join('');
const div = ['d', 'i', 'v'].join('');
const fix = (s) => s.split('</' + tag + '>').join('</' + div + '>').split('<' + tag).join('<' + div);
const o = fix(oldBlock);
const n = fix(newBlock);
if (!c.includes(o)) {
    console.error('pattern not found');
    process.exit(1);
}
c = c.replace(o, n);
fs.writeFileSync(p, c);
console.log('ok');

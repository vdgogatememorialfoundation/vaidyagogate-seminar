const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'admin.js');
let h = fs.readFileSync(p, 'utf8');
const start = '// ==================== LIVE CHAT ====================';
const end = '// Call loading functions when tab changes';
const i0 = h.indexOf(start);
const i1 = h.indexOf(end);
if (i0 >= 0 && i1 > i0) {
    h = h.slice(0, i0) + h.slice(i1);
}
h = h.replace(/\s*loadLiveChatSessions\(\);\n/, '\n');
fs.writeFileSync(p, h);
console.log('admin.js live chat removed');

const dh = path.join(__dirname, '..', 'public', 'doctor.html');
let d = fs.readFileSync(dh, 'utf8');
d = d.replace(/\s*<!-- AI Chatbot UI -->[\s\S]*?<\/motion>\s*\n\s*<script src="\/js\/site-branding/.test(d) ? d : d);
d = d.replace(/\s*<!-- AI Chatbot UI -->[\s\S]*?(?=\s*<script src="\/js\/site-branding)/, '\n');
fs.writeFileSync(dh, d);
console.log('doctor.html chatbot removed');

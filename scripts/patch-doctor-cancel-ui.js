const fs = require('fs');
const p = 'public/doctor.html';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('reg-cancel-policy-wrap')) {
    console.log('already patched');
    process.exit(0);
}
const block = [
    '                            <div id="reg-cancel-policy-wrap" class="hidden" style="margin-bottom:16px;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">',
    '                                <p style="font-size:0.85rem;font-weight:600;color:#92400e;margin:0 0 8px;">Cancellation &amp; refund policy</p>',
    '                                <p id="reg-cancel-policy-text" style="font-size:0.88rem;color:#78350f;margin:0;line-height:1.5;"></p>',
    '                            </div>',
    ''
].join('\n');
const anchor =
    '                            <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;font-size:0.9rem;">';
if (!s.includes(anchor)) {
    console.error('anchor missing');
    process.exit(1);
}
s = s.replace(anchor, block + anchor);
fs.writeFileSync(p, s);
console.log('patched doctor.html');

const fs = require('fs');
const p = 'public/doctor.html';
let s = fs.readFileSync(p, 'utf8');
const bad = s.indexOf('d. titles.</p>');
const good = s.indexOf('<motion id="tab-receipts"');
const good2 = s.indexOf('<div id="tab-receipts"');
const rec = good >= 0 ? good : good2;
if (bad > 0 && rec > bad) {
    s = s.slice(0, bad) + '\n                ' + s.slice(rec);
    fs.writeFileSync(p, s);
    console.log('removed duplicate');
} else {
    console.log('no dup found', bad, rec);
}

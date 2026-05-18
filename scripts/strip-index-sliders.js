const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('<motion class="announcement-ticker');
const startDiv = s.indexOf('<div class="announcement-ticker');
const i0 = startDiv;
const end = s.indexOf('<section id="marketing-hero"');
if (i0 >= 0 && end > i0) {
    s = s.slice(0, i0) + '    <span id="tickerText" class="hidden" aria-hidden="true"></span>\n\n' + s.slice(end);
    fs.writeFileSync(p, s);
    console.log('Removed sliding notification blocks');
} else {
    console.log('Markers not found', i0, end);
}

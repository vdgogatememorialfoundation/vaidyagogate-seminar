const fs = require('fs');
const path = 'public/doctor.html';
let h = fs.readFileSync(path, 'utf8');
const needle = 'Live chat with admin';
const idx = h.indexOf(needle);
if (idx >= 0) {
    const cardStart = h.lastIndexOf('<div class="card"', idx);
    const endMark = h.indexOf('<!-- Ticket / legacy thread view -->', idx);
    if (cardStart >= 0 && endMark > cardStart) {
        h = h.slice(0, cardStart) + '                    <!-- Ticket thread view -->\n' + h.slice(endMark);
    }
}
const lcStart = h.indexOf('<motion id="doctor-lc-panel"');
const lcStart2 = h.indexOf('<div id="doctor-lc-panel"');
const ls = lcStart2 >= 0 ? lcStart2 : lcStart;
if (ls >= 0) {
    const end = h.indexOf('<div id="tab-volunteer"', ls);
    if (end > ls) h = h.slice(0, ls) + h.slice(end);
}
fs.writeFileSync(path, h);
console.log('patched doctor.html');

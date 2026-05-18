const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'doctor.html');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('<div id="doctor-scrolling-announce-wrap"');
if (start !== -1) {
    const cutAt = s.indexOf('<div class="announcements-box"', start);
    if (cutAt !== -1) s = s.slice(0, start) + s.slice(cutAt);
}
s = s.replace(/\s*<script src="\/js\/portal-scrolling-announcements\.js"><\/script>\r?\n/, '\n');
fs.writeFileSync(p, s, 'utf8');
console.log('done');

const fs = require('fs');
const p = require('path').join(__dirname, '..', 'public', 'index.html');
let s = fs.readFileSync(p, 'utf8');

const startAlt = '    <div class="top-bar legacy-header">';
const end = '    <motion id="countdown-region">';
const endAlt = '    <div id="countdown-region">';
let j = s.indexOf(endAlt);
if (j < 0) j = s.indexOf(end.replace('motion', 'motion'));
const i = s.indexOf(startAlt);
if (i < 0 || j < 0 || j <= i) {
    console.error('markers not found', i, j);
    process.exit(1);
}
s = s.slice(0, i) + s.slice(j);

if (!s.includes('id="contact-form-status"')) {
    s = s.replace(
        '<button type="submit" class="btn-primary" style="width:100%;border:none;cursor:pointer;">Send message</button>',
        '<button type="submit" class="btn-primary" style="width:100%;border:none;cursor:pointer;">Send message</button>\n                        <p id="contact-form-status" style="margin-top:12px;font-size:0.9rem;"></p>'
    );
}

fs.writeFileSync(p, s);
console.log('Removed legacy index chrome');

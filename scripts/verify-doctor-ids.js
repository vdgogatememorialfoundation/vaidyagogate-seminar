const fs = require('fs');
const html = fs.readFileSync('public/doctor.html', 'utf8');
const js = fs.readFileSync('public/js/doctor.js', 'utf8');
const ids = new Set();
const re1 = /getElementById\((['"])([^'"]+)\1\)/g;
let m;
while ((m = re1.exec(js))) ids.add(m[2]);
const re2 = /getElementById\(`([^`]+)`\)/g;
while ((m = re2.exec(js))) {
    if (!m[1].includes('${')) ids.add(m[1]);
}
const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
console.log('Total IDs in JS:', ids.size);
console.log('Missing in HTML:', missing.length);
if (missing.length) console.log(missing.join('\n'));
process.exit(missing.length ? 1 : 0);

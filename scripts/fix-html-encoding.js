const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) {
    console.error('Usage: node fix-html-encoding.js <file>...');
    process.exit(1);
}
const map = [
    ['\u00e2\u20ac\u201d', '\u2014'],
    ['\u00e2\u20ac\u00a6', '\u2026'],
    ['\u00e2\u20ac\u2018', '\u2011'],
    ['\u00e2\u20ac\u201c', '\u2013'],
    ['\u00e2\u20ac\u2122', '\u2019'],
    ['\u00e2\u20ac\u0153', '\u201c'],
    ['\u00e2\u20ac\u009d', '\u201d']
];
for (const p of files) {
    let s = fs.readFileSync(p, 'utf8');
    for (const [from, to] of map) s = s.split(from).join(to);
    fs.writeFileSync(p, s, 'utf8');
    const bad = (s.match(/\u00e2\u20ac/g) || []).length;
    console.log(p + ': remaining mojibake fragments ' + bad);
}

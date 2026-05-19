const fs = require('fs');
const p = 'public/admin.html';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes('Admin: seminar application on behalf'));
const end = lines.findIndex((l, i) => i > start && l.includes('Registration form (seminar application) field'));
if (start < 0 || end < 0) {
    console.error('markers not found', start, end);
    process.exit(1);
}
const block = fs.readFileSync(__dirname + '/frag-admin-behalf-tab.html', 'utf8');
const out = [...lines.slice(0, start), block, ...lines.slice(end)].join('\n');
fs.writeFileSync(p, out);
console.log('replaced lines', start + 1, 'to', end);

const fs = require('fs');
const path = require('path');
const p =
    'C:/Users/Shriram Gogate/.cursor/projects/d-SeminarSystem/agent-transcripts/a89a585b-38f6-4493-a3bc-b17e7c8b0326/a89a585b-38f6-4493-a3bc-b17e7c8b0326.jsonl';
const out = path.join(__dirname, 'extracted-doctor-snippets.txt');
const lines = fs.readFileSync(p, 'utf8').split(/\n/).filter(Boolean);
const snippets = [];
for (const line of lines) {
    if (!line.includes('doctor.html')) continue;
    if (line.includes('StrReplace') || line.includes('Write')) {
        snippets.push(line.slice(0, 12000));
    }
}
fs.writeFileSync(out, snippets.join('\n\n---\n\n'));
console.log('wrote', snippets.length, 'snippets to', out);

const fs = require('fs');
const lines = fs.readFileSync(
    'C:/Users/Shriram Gogate/.cursor/projects/d-SeminarSystem/agent-transcripts/a89a585b-38f6-4493-a3bc-b17e7c8b0326/a89a585b-38f6-4493-a3bc-b17e7c8b0326.jsonl',
    'utf8'
).split(/\n/);
for (const line of lines) {
    if (!line.includes('Inter')) continue;
    let o;
    try {
        o = JSON.parse(line);
    } catch {
        continue;
    }
    for (const p of o.message?.content || []) {
        const s = p.input?.new_string;
        if (s && s.includes("font-family: 'Inter'") && s.includes('.sidebar')) {
            fs.writeFileSync('scripts/doctor-style-snippet.css', s);
            console.log('ok', s.length);
        }
    }
}

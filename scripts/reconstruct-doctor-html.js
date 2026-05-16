const fs = require('fs');
const path = require('path');

const transcript =
    'C:/Users/Shriram Gogate/.cursor/projects/d-SeminarSystem/agent-transcripts/a89a585b-38f6-4493-a3bc-b17e7c8b0326/a89a585b-38f6-4493-a3bc-b17e7c8b0326.jsonl';
const outPath = path.join(__dirname, '..', 'public', 'doctor.html');

let html = null;
const lines = fs.readFileSync(transcript, 'utf8').split(/\n/).filter(Boolean);

function normPath(p) {
    return String(p || '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

for (const line of lines) {
    let obj;
    try {
        obj = JSON.parse(line);
    } catch {
        continue;
    }
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
        if (part.type !== 'tool_use') continue;
        const input = part.input || {};
        const p = normPath(input.path);
        if (!p.endsWith('doctor.html') && p !== 'public/doctor.html') continue;
        if (part.name === 'Write' && input.contents) {
            html = input.contents;
        } else if (part.name === 'StrReplace' && html != null) {
            const old = input.old_string;
            const neu = input.new_string;
            if (old == null || neu == null) continue;
            if (!html.includes(old)) {
                // try motion->motion typos
                const alt = old.replace(/<motion/g, '<motion').replace(/<\/motion>/g, '</motion>');
                if (html.includes(alt)) html = html.split(alt).join(neu);
            } else {
                html = html.split(old).join(neu);
            }
        }
    }
}

if (html == null) {
    console.error('No Write baseline found for doctor.html');
    process.exit(1);
}

// Fix common corruption: motion tags should be div
html = html.replace(/<\/?motion\b/g, (m) => m.replace(/motion/g, 'motion'));

fs.writeFileSync(outPath, html);
console.log('Wrote', outPath, 'lines', html.split(/\n/).length, 'bytes', Buffer.byteLength(html));

const fs = require('fs');
const lines = fs.readFileSync(
    'C:/Users/Shriram Gogate/.cursor/projects/d-SeminarSystem/agent-transcripts/a89a585b-38f6-4493-a3bc-b17e7c8b0326/a89a585b-38f6-4493-a3bc-b17e7c8b0326.jsonl',
    'utf8'
).split(/\n/);

function findAndSave(needle, out) {
    for (const line of lines) {
        if (!line.includes(needle)) continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        for (const p of o.message?.content || []) {
            const s = p.input?.new_string;
            if (s && s.includes(needle) && s.length > 200) {
                fs.writeFileSync(out, s);
                console.log('saved', out, s.length);
                return;
            }
        }
    }
    console.log('miss', needle);
}

findAndSave('reg-addr', 'scripts/frag-reg.txt');
findAndSave('multi-step-form', 'scripts/frag-multistep.txt');
findAndSave('seminars-grid-container', 'scripts/frag-seminars.txt');
findAndSave('profile-specialization', 'scripts/frag-profile.txt');
findAndSave('doctor-certificates-wrap', 'scripts/frag-cert.txt');
findAndSave('applications-tracker-container', 'scripts/frag-apps.txt');
findAndSave('volunteer-panel', 'scripts/frag-volunteer.txt');

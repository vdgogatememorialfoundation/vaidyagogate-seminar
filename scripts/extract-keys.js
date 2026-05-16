const fs = require('fs');
const lines = fs.readFileSync(
    'C:/Users/Shriram Gogate/.cursor/projects/d-SeminarSystem/agent-transcripts/a89a585b-38f6-4493-a3bc-b17e7c8b0326/a89a585b-38f6-4493-a3bc-b17e7c8b0326.jsonl',
    'utf8'
).split(/\n/);
const keys = ['reg-addr', 'multi-step-form', 'seminars-grid', 'profile-specialization', 'tab-profile', 'tab-volunteer', 'doctor-certificates-wrap', 'applications-tracker', 'seminar-track-live'];
for (const k of keys) {
    for (const line of lines) {
        if (!line.includes(k)) continue;
        fs.writeFileSync(`scripts/key-${k.replace(/[^a-z0-9]+/gi, '-')}.txt`, line.slice(0, 30000));
        console.log(k, line.length);
        break;
    }
}

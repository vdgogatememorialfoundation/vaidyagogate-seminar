const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('async function appendCasePresentationTrackers');
const end = s.indexOf('async function loadApplications()');
if (start >= 0 && end > start) {
    const insert =
        'function seminarTrackFingerprint(apps) {\n' +
        '    return (apps || [])\n' +
        "        .map((a) => [a.id, a.status, a.updated_at || '', a.seminar_title || ''].join(':'))\n" +
        "        .join('|');\n" +
        '}\n\n' +
        'async function loadApplications(silentPoll) {\n';
    s = s.slice(0, start) + insert + s.slice(end + 'async function loadApplications()'.length);
    fs.writeFileSync(p, s);
    console.log('removed appendCasePresentationTrackers, added seminarTrackFingerprint');
} else {
    console.log('already patched or markers missing', start, end);
}

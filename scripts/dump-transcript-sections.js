const fs = require('fs');
const lines = fs.readFileSync('scripts/extracted-doctor-snippets.txt', 'utf8').split(/\n---\n\n/);
const keys = [
    'Doctor portal sign-in',
    'reg-tnc-text',
    'tab-feedback',
    'Support tickets',
    'stat-grid',
    'step-1',
    'ind-step-0',
    'case-programs-grid',
    'doctor-certificates-wrap',
    'view-app-modal',
    'tab-receipts',
    'tab-payments',
    'make-payments',
    'profile-specialization',
    'doctor-updates-list',
    'seminar-track-live',
    'chat-reply-msg',
    'sendRegistrationOtpForField',
    'National Seminar'
];
for (const k of keys) {
    const hit = lines.find((l) => l.includes(k));
    if (!hit) {
        console.log('MISSING', k);
        continue;
    }
    const name = k.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    fs.writeFileSync(`scripts/section-${name}.txt`, hit.slice(0, 25000));
    console.log('OK', k, hit.length);
}

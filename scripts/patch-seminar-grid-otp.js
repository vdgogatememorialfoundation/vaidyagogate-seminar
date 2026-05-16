const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'js', 'doctor.js');
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('function registrationOtpDestination')) {
    const insertBefore = 'async function loadSeminarsGrid()';
    const helper = `function registrationOtpDestination(fieldKey) {
    const raw =
        fieldKey === 'email'
            ? String((document.getElementById('reg-email') || {}).value || '').trim()
            : String((document.getElementById('reg-phone') || {}).value || '').trim();
    if (fieldKey === 'email') return raw.toLowerCase();
    const digits = raw.replace(/\\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
}

`;
    s = s.replace(insertBefore, helper + insertBefore);
}

const start = s.indexOf('async function loadSeminarsGrid()');
const end = s.indexOf('let activeSeminarIdForReg');
if (start < 0 || end < start) {
    console.error('loadSeminarsGrid block not found');
    process.exit(1);
}
const neu = `async function loadSeminarsGrid() {
    clearSeminarGridCountdownTimer();
    const container = document.getElementById('seminars-grid-container');
    if (!container) return;
    try {
        const res = await fetch('/api/seminars?bucket=current', { cache: 'no-store' });
        const payload = await res.json();
        if (payload.portalYear) doctorPortalYear = payload.portalYear;
        activeSeminars = payload.seminars || [];
        container.innerHTML = '';

        if (!activeSeminars.length) {
            container.innerHTML =
                '<p style="grid-column:1/-1;text-align:center;width:100%;color:#64748b;">No active seminars available for registration at this time.</p>';
            return;
        }

        let hasUpcoming = false;
        activeSeminars.forEach((s) => {
            const win = registrationWindowState(s);
            if (win.state === 'upcoming') hasUpcoming = true;
            container.insertAdjacentHTML('beforeend', renderSeminarGridCard(s, false));
        });
        if (hasUpcoming) {
            startSeminarGridCountdownTimer();
        }
    } catch (err) {
        console.error(err);
        container.innerHTML =
            '<p style="grid-column:1/-1;text-align:center;color:#b91c1c;">Could not load seminars. Please refresh the page.</p>';
    }
}

`;
s = s.slice(0, start) + neu + s.slice(end);

s = s.replace(
    /async function verifyRegistrationOtpForField\(fieldKey\) \{\s*const sid = activeSeminarIdForReg;\s*if \(sid == null\) return alert\('Seminar not selected\.'\);\s*const channel = fieldKey === 'email' \? 'email' : 'phone';\s*const dest =\s*fieldKey === 'email'\s*\? String\(\(document\.getElementById\('reg-email'\) \|\| \{\}\)\.value \|\| ''\)\.trim\(\)\s*: String\(\(document\.getElementById\('reg-phone'\) \|\| \{\}\)\.value \|\| ''\)\.trim\(\);/,
    `async function verifyRegistrationOtpForField(fieldKey) {
    const sid = activeSeminarIdForReg;
    if (sid == null) return alert('Seminar not selected.');
    const channel = fieldKey === 'email' ? 'email' : 'phone';
    const dest = registrationOtpDestination(fieldKey);`
);

s = s.replace(
    "if (statusEl) statusEl.textContent = data.warning ? 'Sent (check configuration).' : 'Code sent.';\n        if (data.debugCode) console.info('OTP debug:', data.debugCode);",
    "if (statusEl) {\n            statusEl.textContent = data.debugCode\n                ? 'Code sent (dev: ' + data.debugCode + ')'\n                : data.warning\n                  ? 'Sent (check configuration).'\n                  : 'Code sent.';\n        }\n        if (data.debugCode) console.info('OTP debug:', data.debugCode);"
);

const startReg = s.indexOf('    void loadRegistrationFormConfigAndApply(seminarId);');
if (startReg > 0 && !s.includes('reg-email\').value = currentUser.email')) {
    s = s.replace(
        '    void loadRegistrationFormConfigAndApply(seminarId);\n    \n    // Reset to step 1\n    nextStep(1);',
        `    void loadRegistrationFormConfigAndApply(seminarId);
    const emailEl = document.getElementById('reg-email');
    const phoneEl = document.getElementById('reg-phone');
    if (emailEl && currentUser && currentUser.email) emailEl.value = currentUser.email;
    if (phoneEl && currentUser && currentUser.phone) phoneEl.value = currentUser.phone;

    // Reset to step 1
    nextStep(1);`
    );
}

fs.writeFileSync(p, s);
console.log('patched seminar grid and OTP');

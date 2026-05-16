const fs = require('fs');
const p = 'D:/SeminarSystem/public/index.html';
let c = fs.readFileSync(p, 'utf8');
const closeDiv = '</' + 'div>';

c = c.replace(
    '\n            <div id="social-follow" class="social-follow" style="text-align:center;margin-top:28px;">' + closeDiv + '\n',
    '\n'
);

const verifyBlock =
    '        <div id="verifySection" class="hidden">\n' +
    '            <motion class="section-head">\n'.replace(/motion/g, 'div') +
    '                <h2>Participant verification</h2>\n' +
    '                <p>Official list of admitted delegates with confirmed payment</p>\n' +
    '            </motion>\n'.replace(/<\/?motion/g, (m) => m.replace('motion', 'motion')) +
    '            <div id="verify-inactive" class="verify-inactive hidden">\n' +
    '                <i class="fas fa-lock"></i>\n' +
    '                <h3>Verification not open yet</h3>\n' +
    '                <p>Lists appear here only after admin enables <strong>Publish participant list on website</strong> for a seminar (Admin → Seminar Management), once verification and payments are complete.</p>\n' +
    '            </motion>\n'.replace(/motion/g, 'div') +
    '            <div id="verify-active" class="page-panel verify-panel hidden">\n' +
    '                <label for="verify-seminar">Seminar</label>\n' +
    '                <select id="verify-seminar"></select>\n' +
    '                <label for="verify-query">Search</label>\n' +
    '                <input type="text" id="verify-query" placeholder="Application no., name, or portal ID">\n' +
    '                <button type="button" class="btn-primary verify-search-btn" onclick="runParticipantVerify()"><i class="fas fa-search"></i> Search</button>\n' +
    '                <div id="verify-results"></div>\n' +
    '            </motion>\n'.replace(/motion/g, 'motion') +
    '        </motion>\n'.replace(/motion/g, 'div');

// Simpler verify block - all div
const vb = [
    '        <div id="verifySection" class="hidden">',
    '            <div class="section-head">',
    '                <h2>Participant verification</h2>',
    '                <p>Official list of admitted delegates with confirmed payment</p>',
    '            </div>',
    '            <div id="verify-inactive" class="verify-inactive hidden">',
    '                <i class="fas fa-lock"></i>',
    '                <h3>Verification not open yet</h3>',
    '                <p>Lists appear here only after admin enables <strong>Publish participant list on website</strong> for a seminar (Admin → Seminar Management), once verification and payments are complete.</p>',
    '            </div>',
    '            <div id="verify-active" class="page-panel verify-panel hidden">',
    '                <label for="verify-seminar">Seminar</label>',
    '                <select id="verify-seminar"></select>',
    '                <label for="verify-query">Search</label>',
    '                <input type="text" id="verify-query" placeholder="Application no., name, or portal ID">',
    '                <button type="button" class="btn-primary verify-search-btn" onclick="runParticipantVerify()"><i class="fas fa-search"></i> Search</button>',
    '                <div id="verify-results"></motion>',
    '            </motion>',
    '        </motion>'
].join('\n').split('motion').join('div');

const start = c.indexOf('        <div id="verifySection"');
const endIdx = c.indexOf('        <div id="scheduleSection"');
if (start >= 0 && endIdx > start) {
    c = c.slice(0, start) + vb + '\n\n' + c.slice(endIdx);
}

const dupStart = c.indexOf('        async function loadEventSchedules() {');
const dupEnd = c.indexOf('        function openAuthModal(tab) {');
if (dupStart >= 0 && dupEnd > dupStart) {
    c = c.slice(0, dupStart) + c.slice(dupEnd);
}

c = c.replace(
    /window\.addEventListener\('load', \(\) => \{[\s\S]*?loadEventSchedules\(\);[\s\S]*?refreshSignupOtpPanel\(\);[\s\S]*?\}\);/,
    `window.addEventListener('load', () => {
            const user = localStorage.getItem('seminar_doctor_user');
            if (user) {
                currentUserId = JSON.parse(user).id;
            }
            refreshSignupOtpPanel();
        });`
);

c = c.replace(/\n        async function loadVerifySeminars\(\) \{[\s\S]*?\n        \}\n\n        async function runParticipantVerify\(\) \{[\s\S]*?\n        \}\n/g, '\n');

const verifyJs = `
        function verifyStatusLabel(st) {
            const s = String(st || '').toLowerCase();
            if (s === 'checked_in') return 'Checked in';
            if (s === 'completed') return 'Admitted (paid)';
            if (s === 'approved_pending_payment') return 'Verified — payment received';
            return st || '—';
        }

        function setVerifyUiActive(active) {
            document.getElementById('verify-inactive')?.classList.toggle('hidden', active);
            document.getElementById('verify-active')?.classList.toggle('hidden', !active);
            const nav = document.getElementById('nav-verify');
            if (nav) nav.classList.toggle('nav-disabled', !active);
        }

        async function loadVerifySeminars() {
            const sel = document.getElementById('verify-seminar');
            if (!sel) return;
            try {
                const res = await fetch('/api/public/participant-directories');
                const list = await res.json();
                const rows = Array.isArray(list) ? list : [];
                if (!rows.length) {
                    setVerifyUiActive(false);
                    return;
                }
                setVerifyUiActive(true);
                sel.innerHTML = '<option value="">— Select seminar —</option>';
                rows.forEach((s) => {
                    sel.innerHTML += '<option value="' + s.id + '">' + escHtml(s.title || '') + '</option>';
                });
            } catch (e) {
                console.error(e);
                setVerifyUiActive(false);
            }
        }

        async function runParticipantVerify() {
            const sid = document.getElementById('verify-seminar')?.value;
            const q = document.getElementById('verify-query')?.value || '';
            const box = document.getElementById('verify-results');
            if (!box) return;
            if (!sid) {
                box.innerHTML = '<p class="verify-msg-error">Select a seminar.</p>';
                return;
            }
            box.innerHTML = '<p class="verify-msg-muted">Searching…</p>';
            try {
                const res = await fetch('/api/public/participants/' + sid + '?q=' + encodeURIComponent(q));
                const data = await res.json();
                if (!res.ok) {
                    box.innerHTML = '<p class="verify-msg-error">' + escHtml(data.error || 'List not available') + '</p>';
                    return;
                }
                const rows = data.participants || [];
                if (!rows.length) {
                    box.innerHTML = '<p class="verify-msg-muted">No matching admitted delegates found.</p>';
                    return;
                }
                box.innerHTML =
                    '<p class="verify-count">' +
                    rows.length +
                    ' result(s) — ' +
                    escHtml(data.seminarTitle || '') +
                    '</p><table class="verify-table"><thead><tr><th>Application</th><th>Name</th><th>City</th><th>Status</th><th>Payment</th></tr></thead><tbody>' +
                    rows
                        .map(
                            (r) =>
                                '<tr><td>' +
                                escHtml(r.applicationNo) +
                                '</td><td>' +
                                escHtml(r.name) +
                                '</td><td>' +
                                escHtml(r.city) +
                                '</td><td>' +
                                escHtml(verifyStatusLabel(r.status)) +
                                '</td><td>' +
                                (r.paid ? 'Paid' : '—') +
                                '</td></tr>'
                        )
                        .join('') +
                    '</tbody></table>';
            } catch (e) {
                box.innerHTML = '<p class="verify-msg-error">Network error.</p>';
            }
        }
`;

c = c.replace('\n        function showSection(section) {', verifyJs + '\n        function showSection(section) {');

c = c.replace(
    /function socialIcon\([^)]*\) \{[\s\S]*?return 'fas fa-link';\s*\}\s*\n\s*function renderAboutGallerySocial/,
    'function renderAboutGallerySocial'
);

c = c.replace(
    /const soc = document\.getElementById\('social-follow'\);[\s\S]*?\}\s*\n\s*const grid = document\.getElementById\('gallery-grid'\);/,
    "const grid = document.getElementById('gallery-grid');"
);

if (!c.includes('id="nav-verify"')) {
    c = c.replace(
        "<a onclick=\"showSection('verify')\">Verify</a>",
        '<a id="nav-verify" onclick="showSection(\'verify\')">Verify</a>'
    );
}

fs.writeFileSync(p, c);
console.log('patched');
